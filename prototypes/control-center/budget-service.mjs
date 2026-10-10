// Spending budgets are distinct from model context capacity and demo counters.
// null means no hard cap; estimates are admission accounting, not provider bills.
const dayOf = now => new Date(now).toISOString().slice(0, 10);
const tokens = value => Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;
export function freshRealUsage(now = Date.now()) { return { day: dayOf(now), tokens: 0, reportedTokens: 0, estimatedTokens: 0, reservations: {}, reservedTokens: 0, costStatus: 'unpriced' }; }
export function ensureRealUsage(state, now = Date.now()) {
  state.realUsage ??= freshRealUsage(now);
  if (state.realUsage.day !== dayOf(now)) state.realUsage = { ...freshRealUsage(now), reservations: { ...state.realUsage.reservations } };
  state.realUsage.reservations ??= {};
  state.realUsage.reservedTokens = Object.values(state.realUsage.reservations).reduce((sum, value) => sum + tokens(value), 0);
  return state.realUsage;
}
export function realBudgetRemaining(state, { excludeReservation, now = Date.now() } = {}) {
  const cap = state.settings.realTokenBudget;
  if (cap === null || cap === undefined) return Infinity;
  const usage = state.realUsage, spent = usage?.day === dayOf(now) ? tokens(usage.tokens) : 0;
  const reserved = Object.entries(usage?.reservations ?? {}).reduce((sum, [key, value]) => sum + (key === excludeReservation ? 0 : tokens(value)), 0);
  return Math.max(0, cap - spent - reserved);
}
export function reserveRealTokens(state, key, amount, { now = Date.now() } = {}) {
  if (typeof key !== 'string' || !key || !Number.isFinite(amount) || amount < 0) throw new TypeError('Invalid real-token reservation');
  const count = Math.ceil(amount);
  if (count > tokens(state.realUsage?.reservations?.[key]) && count > realBudgetRemaining(state, { excludeReservation: key, now })) throw Object.assign(new Error('真实模型 token 限额余量不足。'), { code: 'budget' });
  const usage = ensureRealUsage(state, now); usage.reservations[key] = count; ensureRealUsage(state, now); return count;
}
export function releaseRealTokens(state, key, { now = Date.now() } = {}) {
  const usage = ensureRealUsage(state, now), count = tokens(usage.reservations[key]); delete usage.reservations[key]; ensureRealUsage(state, now); return count;
}
export function chargeRealTokens(state, amount, { estimated = false, now = Date.now() } = {}) {
  const usage = ensureRealUsage(state, now), count = tokens(amount);
  usage.tokens += count; usage[estimated ? 'estimatedTokens' : 'reportedTokens'] = tokens(usage[estimated ? 'estimatedTokens' : 'reportedTokens']) + count;
  return count;
}
export function migrateRealBudgets(state, now = Date.now()) {
  state.settings.realTokenBudget ??= null;
  if (!state.realUsage) {
    const realUsage = freshRealUsage(now), records = [];
    for (const session of state.sessions ?? []) for (const turn of session.turns ?? []) if (['rna', 'pi'].includes(turn.modelConfig?.execution) && String(turn.completedAt ?? turn.startedAt ?? turn.createdAt).slice(0, 10) === realUsage.day && turn.usage) records.push(tokens(turn.usage.totalTokens));
    for (const project of state.projects ?? []) if (String(project.initialization?.completedAt).slice(0, 10) === realUsage.day && project.initialization?.usage) records.push(tokens(project.initialization.usage.totalTokens));
    realUsage.tokens = realUsage.reportedTokens = records.reduce((sum, value) => sum + value, 0);
    realUsage.coverage = 'partial-legacy';
    state.budgetMigration = { version: 1, at: new Date(now).toISOString(), legacyUsage: structuredClone(state.usage), legacyTokenBudget: state.settings.tokenBudget, note: 'Legacy mixed counters are archived, not treated as measured real usage. Only dated real turn/initialization receipts were reconstructed; missing historical receipts remain unknown. Legacy global tokenBudget was a demo setting and does not establish a real cap.' };
    state.realUsage = realUsage; state.usage = { day: realUsage.day, usd: 0, tokens: 0 };
  }
  // Only unfinished foreground/bootstrap requests are recovered here; the
  // initiative and learning controllers own their durable reservations/recovery.
  for (const [key, value] of Object.entries(state.realUsage.reservations ?? {})) if (!key.startsWith('initiative:') && !key.startsWith('learning:')) { chargeRealTokens(state, value, { estimated: true, now }); releaseRealTokens(state, key, { now }); }
  for (const project of state.projects ?? []) {
    const initiative = project.initiative;
    if (!initiative || initiative.budgetVersion === 1) continue;
    if (project.simulated === false || project.decisionMode === 'rna-model') {
      if (initiative.tokenBudget === undefined || initiative.tokenBudget === 50000) initiative.tokenBudget = null;
      initiative.budgetVersion = 1;
    }
  }
  ensureRealUsage(state, now);
}
