import { deliveryMetrics } from './proactive-delivery.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { windowRange } from './metric-windows.mjs';
import { wakeCells, wakeSummary } from './proactive-metrics.mjs';
import { LABEL_SOURCES, rowLabelSource } from './decision-ledger.mjs';

// Plan 2026-09-30 §5 (D6): how the product is experienced, for `./rna doctor`
// and GET /api/v2/experience. Counts only — no message text — over a window:
// proactive messages (replied / acted / dismissed / ignored), invitations
// (answered / dismissed / expired), background wakes (and why they failed),
// JEV label coverage per point, what the evolution tree is carrying, and how
// often heavy turns hand work to subagents (per model).
const DAY = 86400000;
const at = value => { const time = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(time) ? time : 0; };
const share = (part, whole) => (whole ? Math.round(part / whole * 1000) / 1000 : null);
const bump = (object, key, by = 1) => { object[key] = (object[key] ?? 0) + by; return object; };
/** How much the prompt (system prompt + own skills) grew across generations that recorded it; null until two did. */
const promptGrowth = generations => { const rows = generations.filter(row => Number.isFinite(row.promptChars)); if (rows.length < 2) return null; const first = rows[0].promptChars, latest = rows.at(-1).promptChars; return { first, latest, generations: rows.length, ratio: first ? Math.round(latest / first * 100) / 100 : null }; };

/** Design 2026-10-04 §9.3: per model of the turn, how many real turns were heavy (at least HEAVY tool calls) or busy (at
 * least BUSY, heavy ones included) and how many of those delegated; and how the children ended — completed, summarized
 * at the step cap, failed, cancelled, interrupted or still running — with their tokens. Live baseline before 0.62.0:
 * 1 of 25 heavy turns delegated. Counts only; GLM and GPT are compared side by side, not pooled. */
export const DELEGATION_THRESHOLDS = Object.freeze({ heavy: 20, busy: 10 });
const OUTCOMES = ['completed', 'summarized', 'failed', 'cancelled', 'interrupted', 'running'];
function delegationMetrics(sessions, since) {
  const byModel = {};
  const entry = (id, name) => byModel[id] ??= { name: name ?? id, turns: 0, heavy: { turns: 0, delegated: 0 }, busy: { turns: 0, delegated: 0 },
    subagents: { spawned: 0, ...Object.fromEntries(OUTCOMES.map(key => [key, 0])), tokens: { total: 0, ...Object.fromEntries(OUTCOMES.map(key => [key, 0])) } } };
  for (const session of sessions) {
    const calls = new Map();
    for (const item of session.items ?? []) if (item.kind === 'tool' && item.turnId) calls.set(item.turnId, (calls.get(item.turnId) ?? 0) + 1);
    for (const turn of session.turns ?? []) {
      // Real model turns only: a simulated turn has no real tool calls and cannot delegate.
      if (turn.modelConfig?.execution !== 'rna' || at(turn.createdAt) < since) continue;
      const modelId = turn.modelConfig.modelId ?? 'unknown', row = entry(modelId, turn.modelConfig.name), count = calls.get(turn.id) ?? 0, delegated = (turn.delegations?.length ?? 0) > 0;
      row.turns++;
      if (count >= DELEGATION_THRESHOLDS.busy) { row.busy.turns++; if (delegated) row.busy.delegated++; }
      if (count >= DELEGATION_THRESHOLDS.heavy) { row.heavy.turns++; if (delegated) row.heavy.delegated++; }
      for (const child of turn.delegations ?? []) {
        const outcome = child.status === 'completed' ? child.stepLimit ? 'summarized' : 'completed' : OUTCOMES.includes(child.status) ? child.status : 'failed';
        const target = entry(child.model?.modelId ?? modelId, child.model?.name ?? turn.modelConfig.name).subagents, tokens = Number(child.usage?.totalTokens) || 0;
        target.spawned++; target[outcome]++; target.tokens.total += tokens; target.tokens[outcome] += tokens;
      }
    }
  }
  for (const row of Object.values(byModel)) for (const group of [row.heavy, row.busy]) group.share = share(group.delegated, group.turns);
  return { thresholds: { ...DELEGATION_THRESHOLDS }, byModel };
}

/** Worktree design 0.63 §15: how isolated work came back, per model of the turn it belongs to — merges (workers into
 * the parent, session turns into the project folder, background change sets), how many of them conflicted, how
 * often the host's continuations settled a session conflict, rollbacks, and applies settled by startup recovery.
 * A worker's conflict is counted from its merge status, its conflict list or a `resolve` record of it (the status
 * moves on once resolved). Counts only. Background change sets carry no model: `background`. */
function isolationMetrics(projects, sessions, since) {
  const byModel = {}, turns = new Map();
  const entry = (id, name) => byModel[id] ??= { name: name ?? id, merges: 0, conflicted: 0, conflictRate: null, continuations: { conflicted: 0, resolved: 0, rate: null }, rollbacks: 0, recoveries: { total: 0, completed: 0, interrupted: 0 } };
  for (const session of sessions) for (const turn of session.turns ?? []) turns.set(`${session.id}\0${turn.id}`, turn);
  const modelOf = source => { const config = turns.get(`${source?.sessionId}\0${source?.turnId}`)?.modelConfig; return entry(config?.modelId ?? (source?.actionId ? 'background' : 'unknown'), config?.name); };
  const rows = projects.flatMap(project => project.git?.applies ?? []);
  const resolvedAgents = new Set(rows.filter(row => row.kind === 'resolve' && row.source?.agentId).map(row => row.source.agentId));
  for (const session of sessions) for (const turn of session.turns ?? []) {
    if (at(turn.createdAt) < since) continue;
    const row = entry(turn.modelConfig?.modelId ?? 'unknown', turn.modelConfig?.name);
    for (const child of turn.delegations ?? []) {
      // `shared_root` and `nothing`: no isolated copy came back, so no merge happened.
      if (!child.merge || ['shared_root', 'nothing'].includes(child.merge.status) || (child.merge.status === 'pending' && !child.merge.applyIds?.length)) continue;
      row.merges++;
      if (child.merge.status === 'conflict' || child.merge.conflicts?.length || resolvedAgents.has(child.id)) row.conflicted++;
    }
    if (turn.apply && !['none', undefined].includes(turn.apply.status)) {
      row.merges++;
      if (turn.apply.conflict) { row.conflicted++; row.continuations.conflicted++; if (turn.apply.status === 'applied') row.continuations.resolved++; }
    }
  }
  for (const project of projects) for (const change of project.backgroundChanges ?? []) {
    if (change.kind !== 'git' || at(change.at) < since) continue;
    const row = entry(change.model?.modelId ?? 'background', change.model?.name);
    row.merges++;
    if (change.status === 'merge_conflicted' || change.conflicts?.length) row.conflicted++;
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    if (at(row.at) < since) continue;
    if (row.kind === 'rollback') {
      const undone = byId.get(row.undoes);
      modelOf(row.undoesTurn ? { sessionId: row.source?.sessionId, turnId: row.undoesTurn } : undone?.source ?? row.source).rollbacks++;
    }
    if (row.recovered) { const target = modelOf(row.source).recoveries; target.total++; if (row.recovered === 'completed') target.completed++; if (row.recovered === 'interrupted') target.interrupted++; }
  }
  for (const [id, row] of Object.entries(byModel)) {
    if (!row.merges && !row.rollbacks && !row.recoveries.total) { delete byModel[id]; continue; }
    row.conflictRate = share(row.conflicted, row.merges); row.continuations.rate = share(row.continuations.resolved, row.continuations.conflicted);
  }
  const totals = Object.values(byModel).reduce((sum, row) => ({ merges: sum.merges + row.merges, conflicted: sum.conflicted + row.conflicted, rollbacks: sum.rollbacks + row.rollbacks, recoveries: sum.recoveries + row.recoveries.total }), { merges: 0, conflicted: 0, rollbacks: 0, recoveries: 0 });
  return { byModel, totals: { ...totals, conflictRate: share(totals.conflicted, totals.merges) } };
}

const ARCHIVED_VIEWS = ['exclude', 'include', 'only'];
/**
 * The JEV block from the decision ledger (decision-ledger.mjs) for [since, until), plus its daily rollup for days the
 * ledger no longer holds; without a ledger, from a state an older release wrote (`decisionKernelRuntime` recent, index
 * and labels). `keepProject(projectId)` applies the archived view; rows of deleted projects are not counted.
 */
function jevPoints(state, range, { ledger, decisionRollup, keepProject }) {
  const points = {}, inRange = value => Number.isFinite(value) && value >= range.since && value < range.until;
  const point = name => points[name] ??= { decisions: 0, judged: 0, labeled: 0, labels: Object.fromEntries(LABEL_SOURCES.map(source => [source, 0])) };
  if (ledger) {
    for (const row of ledger.view(state)) {
      if (!inRange(at(row.at)) || !keepProject(row.scope?.projectId)) continue;
      const value = point(row.point); value.decisions++; if (row.source === 'judge' || row.source === 'rule') value.judged++;
      const source = rowLabelSource(row); if (source) { value.labels[source]++; if (source !== 'self') value.labeled++; }
    }
    // Days older than the ledger's 31 days: its rollup, counted when the rows left it.
    const mark = decisionRollup?.mark('decisions') ?? null;
    if (decisionRollup && mark !== null && range.since < mark && range.days) for (const cell of decisionRollup.cells({ firstDay: range.days[0], lastDay: range.days.at(-1), keep: key => keepProject(key.projectId) })) {
      // The cell's `labeled` already leaves self labels out (decision-ledger.mjs rollupCell).
      const value = point(cell.k.point); value.decisions += cell.v.decisions ?? 0; value.judged += cell.v.judged ?? 0; value.labeled += cell.v.labeled ?? 0;
      for (const source of LABEL_SOURCES) value.labels[source] += cell.v.labels?.[source] ?? 0;
    }
    return points;
  }
  // A state written before the ledger moved out: the 30-day index with its labels when present, the hot window otherwise.
  const runtime = state.decisionKernelRuntime ?? {}, labels = runtime.labels ?? {}, recentLabels = new Map((runtime.recent ?? []).filter(row => row.label && typeof row.id === 'string').map(row => [row.id, row.label]));
  // The index starts with the release that introduced it: rows still only in the hot window (from before) count too, once.
  const indexed = Object.values(runtime.index ?? {}).flat(), known = new Set(indexed.map(row => row.id).filter(id => typeof id === 'string'));
  for (const row of [...indexed, ...(runtime.recent ?? []).filter(row => typeof row.id !== 'string' || !known.has(row.id))]) {
    if (row.at !== undefined && !inRange(at(row.at))) continue;
    if (!keepProject(row.projectId ?? row.scope?.projectId)) continue;
    const value = point(row.point); value.decisions++; if (row.source === 'judge' || row.source === 'rule') value.judged++;
    const label = row.label ?? (typeof row.id === 'string' ? labels[row.id] ?? recentLabels.get(row.id) : null);
    if (label) { const source = rowLabelSource({ label }); value.labels[source]++; if (source !== 'self') value.labeled++; }
  }
  return points;
}

/**
 * GET /api/v2/experience?days=&archived=. `days` (1–90) whole local days ending today, [since, until). `archived`:
 * archived projects are left out (`exclude`, the default), shown beside the others (`include`) or alone (`only`); their
 * rows carry `archived: true`. `ledger`, `decisionRollup` and `wakes` are the host's durable metrics (host-metrics.mjs);
 * without them the report reads what state still holds.
 */
export function experienceReport(state, { now = Date.now(), days = 7, archived = 'exclude', ledger = null, decisionRollup = null, wakes: wakeRollup = null, outcomes: outcomeLog = null, timeZone } = {}) {
  if (!ARCHIVED_VIEWS.includes(archived)) throw Object.assign(new Error('archived must be exclude, include or only'), { status: 400, code: 'archived_invalid' });
  const count = Math.max(1, Math.min(90, Math.floor(Number(days)) || 7)), range = windowRange({ days: count }, { now, ...(timeZone ? { timeZone } : {}) }), since = range.since, windowMs = now - since, language = interfaceLanguageOf(state);
  const say = variants => inLanguage(language, variants);
  const visible = row => archived === 'include' || (archived === 'only') === Boolean(row.archivedAt);
  const chosen = state.projects.filter(row => row.simulated !== true && visible(row)), chosenIds = new Set(chosen.map(row => row.id));
  // A judgment counts when its project is shown (never a deleted one); one without a project unless only archived ones are asked for.
  const keepProject = projectId => projectId ? chosenIds.has(projectId) : archived !== 'only';
  const sessionVisible = (session, project) => archived === 'exclude' ? !session.archivedAt : project.archivedAt ? true : archived === 'include' || Boolean(session.archivedAt);
  const projects = chosen.map(project => {
    const proactive = deliveryMetrics(project, { now, windowMs });
    const sessions = state.sessions.filter(row => row.projectId === project.id && sessionVisible(row, project));
    const invitations = { offered: 0, open: 0, answered: 0, dismissed: 0, expired: 0, byKind: {} };
    for (const session of sessions) {
      for (const row of session.invitations ?? []) if (at(row.createdAt) >= since) { invitations.offered++; invitations.open++; bump(invitations.byKind[row.kind] ??= {}, 'open'); }
      for (const row of session.invitationHistory ?? []) if (at(row.createdAt) >= since) { invitations.offered++; bump(invitations, row.outcome); bump(invitations.byKind[row.kind] ??= {}, row.outcome); }
    }
    // Wakes over the whole window: the daily wake rollup (every wake, folded as it happens), not the 50-row history that
    // covered about two days of a busy project (plan §1.2 #5).
    const wakeList = wakeCells(project, range, { wakes: wakeRollup });
    // A failure without a reason is from before reasons were kept: counted as `unrecorded`, never named as a cause.
    // `deferred`: the wake judgment (a rule or JEV) settled the wake without the main model; `deferredReasons` says which.
    // `interrupted`: a decision new evidence or a stop superseded after it was paid for (never a quiet wake, never a failure).
    const summary = wakeSummary(wakeList);
    const wakes = { total: summary.total, work: summary.byOutcome.work, thought: summary.byOutcome.thought, deferred: summary.byOutcome.deferred, quiet: summary.quiet, failed: summary.byOutcome.failed, interrupted: summary.byOutcome.interrupted, byTier: summary.byTier, failureReasons: {}, deferredReasons: {}, byReasoning: {} };
    // C2: what became of the actions decided in the window (work-outcome.mjs). `pending`, `visible`, `none`, `undone`,
    // `failed` and `byKind` count TRANSITIONS, by the outcome they moved to: an action that a later message credited
    // (none, then visible) or that the user undid (visible, then undone) is two of them. `settled` and `visibleRate` count
    // ACTIONS: those that left pending (or were first seen settled) in the window, without the cancellations the user or
    // a restart caused (`neutral`: they say nothing about the decision), and the share of them that stand as visible, a
    // later credit counted and an undo taken away.
    const outcomes = { pending: 0, visible: 0, none: 0, undone: 0, failed: 0, neutral: 0, byKind: {} };
    let settled = 0, leftVisible = 0;
    for (const { key, values } of outcomeLog ? outcomeLog.cells(project.id, range) : []) {
      if (outcomes[key.to] === undefined) continue;
      const n = values.n ?? 0, first = key.from === undefined || key.from === 'new' || key.from === 'pending';
      outcomes[key.to] += n; bump(outcomes.byKind[key.kind] ??= {}, key.to, n);
      if (key.neutral === true) outcomes.neutral += n;
      else if (first && key.to !== 'pending') settled += n;
      if (key.from === 'visible') leftVisible += n;
    }
    outcomes.settled = settled;
    outcomes.visibleRate = share(Math.min(settled, Math.max(0, outcomes.visible - leftVisible)), settled);
    for (const { key, values } of wakeList) {
      const n = values.wakes ?? 0, tokens = values.tokens ?? 0;
      if (key.outcome === 'deferred') bump(wakes.deferredReasons, key.reason ?? 'judged_idle', n); else if (key.outcome === 'failed') bump(wakes.failureReasons, key.reason ?? 'unrecorded', n);
      // Per reasoning effort the decision ran at: how many reviews ended, how many failed, their tokens (the per-effort
      // failure rate to watch, over reviews that ended like the overall one); an interrupted decision is counted apart with
      // its tokens. `shadow`: while the route only records, the effort JEV would have chosen for these wakes, by effort.
      if (key.effective) {
        const group = wakes.byReasoning[key.effective] ??= { wakes: 0, failed: 0, tokens: 0, interrupted: 0, interruptedTokens: 0 };
        if (key.outcome === 'interrupted') { group.interrupted += n; group.interruptedTokens += tokens; } else { group.wakes += n; if (key.outcome === 'failed') group.failed += n; group.tokens += tokens; }
        if (key.shadow) bump(group.shadow ??= {}, key.shadow, n);
      }
    }
    // Cache-prefix measurement of the decision requests: how much repeated the previous request, and where they first differed.
    const prompt = summary.values.prompt;
    if (prompt?.measured) wakes.prompt = { measured: prompt.measured, sharedPrefix: Math.round(prompt.shared / prompt.measured * 1000) / 1000, chars: Math.round(prompt.chars / prompt.measured), divergedIn: { ...prompt.divergedIn } };
    const genes = project.genes?.genes ?? [];
    // `funnel`: per lane (A feedback, B correction, C contrast), how many items reached each stage; where growth stops is read here, not guessed.
    const evolution = { generation: project.genes?.generations?.at(-1)?.n ?? 0, trial: genes.filter(row => row.status === 'trial').length, systemOpen: genes.filter(row => row.layer === 'system' && row.status === 'active').map(row => ({ id: row.id, title: row.title, seen: row.body?.count ?? 1, lastAt: row.body?.lastAt ?? null })), contrast: project.genes?.contrast ? { at: project.genes.contrast.at, turns: project.genes.contrast.turns, trouble: project.genes.contrast.trouble, clusters: (project.genes.contrast.clusters ?? []).length } : null,
      funnel: project.genes?.funnel ?? null, promptGrowth: promptGrowth(project.genes?.generations ?? []) };
    return { projectId: project.id, name: project.name, ...(project.archivedAt ? { archived: true } : {}),
      proactive:{ delivered: proactive.counts.delivered, pending: proactive.counts.pending, replied: proactive.counts.replied, acted: proactive.counts.acted, dismissed: proactive.counts.dismissed, ignored: proactive.counts.ignored, usefulShareRate: proactive.usefulShareRate, ignoreRate: proactive.ignoreRate },
      invitations: { ...invitations, answerRate: share(invitations.answered, invitations.answered + invitations.dismissed + invitations.expired) },
      // Interrupted decisions are not reviews that ended: the failure rate stays failed / (reviews that ended), as before they were recorded.
      wakes: { ...wakes, failureRate: share(wakes.failed, wakes.total - wakes.interrupted) }, outcomes, evolution };
  });
  // JEV: per point, how many decisions, how many were judged (a judge verdict or a host rule, not a fallback), how many
  // got a real outcome label and where those labels came from (outcome, the model's own next step, or a missing correction).
  // A self label (PDL-7: the main model's own next choice labelling a wake judgment) is counted by source, never as labeled.
  const points = jevPoints(state, range, { ledger, decisionRollup, keepProject });
  for (const row of Object.values(points)) row.labelCoverage = share(row.labeled, row.judged);
  const totals = Object.values(points).reduce((sum, row) => ({ decisions: sum.decisions + row.decisions, judged: sum.judged + row.judged, labeled: sum.labeled + row.labeled, labels: Object.fromEntries(LABEL_SOURCES.map(source => [source, sum.labels[source] + row.labels[source]])) }), { decisions: 0, judged: 0, labeled: 0, labels: Object.fromEntries(LABEL_SOURCES.map(source => [source, 0])) });
  // A few plain notes where something needs a look; nothing when all is well.
  const notes = [];
  for (const row of projects) {
    if (row.proactive.ignoreRate !== null && row.proactive.ignoreRate >= .5 && row.proactive.delivered >= 4) notes.push(say({ zh: `「${row.name}」近 ${count} 天的主动消息有一半以上没人理（${Math.round(row.proactive.ignoreRate * 100)}%）。`, en: `“${row.name}”: over half of the proactive messages in the last ${count} days went unanswered (${Math.round(row.proactive.ignoreRate * 100)}%).` }));
    const recorded = Object.entries(row.wakes.failureReasons).filter(([reason]) => reason !== 'unrecorded').sort((a, b) => b[1] - a[1]), recordedCount = recorded.reduce((sum, [, count]) => sum + count, 0);
    if (recordedCount >= 3) notes.push(say({ zh: `「${row.name}」后台唤醒失败 ${recordedCount} 次，主要原因：${recorded[0][0]}。`, en: `“${row.name}”: ${recordedCount} background wakes failed, mostly ${recorded[0][0]}.` }));
    for (const issue of row.evolution.systemOpen) notes.push(say({ zh: `「${row.name}」系统问题仍在发生：${issue.title}（${issue.seen} 次）。`, en: `“${row.name}”: a system problem is still happening: ${issue.title} (${issue.seen} times).` }));
    if (row.invitations.answerRate !== null && row.invitations.answerRate < .2 && row.invitations.offered >= 5) notes.push(say({ zh: `「${row.name}」输入框上方的邀请大多没被回应（回应率 ${Math.round(row.invitations.answerRate * 100)}%）。`, en: `“${row.name}”: most invitations above the composer went unanswered (${Math.round(row.invitations.answerRate * 100)}% answered).` }));
  }
  const unlabeled = Object.entries(points).filter(([, row]) => row.judged >= 20 && !row.labeled).map(([point]) => point);
  if (unlabeled.length) notes.push(say({ zh: `这些判断点已判 20 次以上还没有真实结果标签：${unlabeled.join('、')}。`, en: `These judgment points have 20+ judgments but no real outcome labels yet: ${unlabeled.join(', ')}.` }));
  const activeSessions = state.sessions.filter(row => chosenIds.has(row.projectId) && sessionVisible(row, chosen.find(project => project.id === row.projectId)));
  const delegation = delegationMetrics(activeSessions, since);
  const isolation = isolationMetrics(chosen, activeSessions, since);
  return { generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), until: new Date(range.until).toISOString(), days: count, ...(archived !== 'exclude' ? { archived } : {}), projects, jev: { points, totals: { ...totals, labelCoverage: share(totals.labeled, totals.judged) } }, delegation, isolation, notes };
}
