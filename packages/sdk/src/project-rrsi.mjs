import { createHash } from 'node:crypto';

// RRSI (Regularized Recursive Self-Improvement) for project agents. Method
// reference: google-research/rrsi be50316 (schedule.py, history.py,
// components.py, critic.py, calibrate.py, selection.py). Independently
// implemented as pure functions over Rna genomes and host-owned history; no
// model call, file write or adoption happens here. Hosts persist history and
// decide; the user still trials and adopts every project candidate.

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
const short = value => hash(value).slice(0, 16);
const finite = (value, fallback = null) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 6) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, max);

/** K: the editable components of a project agent (its "genome"). */
export const RRSI_COMPONENTS = Object.freeze(['system_section', 'skill', 'tool_description', 'mcp_assignment', 'rhythm', 'communication_style', 'evaluation_standard']);
/** K_str: components that add machinery rather than change text/constants. */
export const RRSI_STRUCTURAL_COMPONENTS = Object.freeze(['skill', 'tool_description', 'mcp_assignment']);
export const RRSI_COMPONENT_LABELS = Object.freeze({ system_section: '系统提示段落', skill: '技能', tool_description: '工具描述', mcp_assignment: 'MCP 分配', rhythm: '节奏', communication_style: '沟通风格', evaluation_standard: '评测标准' });
/** Hyperparameters (symbols follow the paper). Scores S are in [0,1]; ΔC is relative. */
export const RRSI_DEFAULTS = Object.freeze({ T: 12, bMin: 1, bMax: 4, window: 3, deltaZ: 2, delta: null, minDelta: 0.01, beta0: 0.10, beta1: 40, wS: 100, wC: 15, wN: 0.5, nPrune: 4, wReal: 0.8, wJev: 0.2, minRealCases: 3, heldOutFraction: 0.25, smokeCases: 3, maxCriticRepairs: 1 });
export const RRSI_VERDICTS = Object.freeze(['accepted', 'rejected', 'lost', 'critic_rejected', 'smoke_failed', 'prescreen_skipped', 'author_failed', 'infra_failed', 'eval_failed', 'trial_adopted', 'trial_rolled_back']);
const MEASURED = new Set(['accepted', 'rejected', 'lost', 'smoke_failed', 'trial_adopted', 'trial_rolled_back']);

export function rrsiConfig(overrides = {}) {
  const config = { ...RRSI_DEFAULTS };
  for (const [key, value] of Object.entries(overrides ?? {})) if (Object.hasOwn(RRSI_DEFAULTS, key) && (value === null || Number.isFinite(value))) config[key] = value;
  if (config.wReal < 0 || config.wJev < 0 || config.wReal + config.wJev <= 0) Object.assign(config, { wReal: RRSI_DEFAULTS.wReal, wJev: RRSI_DEFAULTS.wJev });
  return Object.freeze(config);
}

/** b_t = ceil(b_min + (b_max − b_min)·½(1 + cos(πt/T))): early rounds may bundle, late rounds stay attributable. */
export function rrsiEditBudget(t, T = RRSI_DEFAULTS.T, bMin = RRSI_DEFAULTS.bMin, bMax = RRSI_DEFAULTS.bMax) {
  if (!(T > 0)) return Math.max(1, Math.trunc(bMax));
  const step = clamp(Math.trunc(t) || 0, 0, T), value = bMin + (bMax - bMin) * 0.5 * (1 + Math.cos(Math.PI * step / T));
  return Math.max(1, Math.ceil(Math.round(value * 1e9) / 1e9));
}

const slug = text => String(text ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'section';
/** Split a system prompt into addressable sections by Markdown headings. */
export function systemPromptSections(systemPrompt) {
  const text = String(systemPrompt ?? ''), lines = text.split('\n'), sections = []; let current = { title: 'core', lines: [] };
  for (const line of lines) { const heading = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/); if (heading) { if (current.lines.join('\n').trim() || current.title !== 'core') sections.push(current); current = { title: heading[1], lines: [line] }; } else current.lines.push(line); }
  if (current.lines.join('\n').trim() || !sections.length) sections.push(current);
  const seen = new Map();
  return sections.map(section => { const base = slug(section.title), count = (seen.get(base) ?? 0) + 1; seen.set(base, count); const content = section.lines.join('\n'); return { id: count > 1 ? `${base}-${count}` : base, title: clip(section.title, 120), content, hash: short(content.trim()) }; });
}
const communicationOf = project => { const initiative = project?.initiative ?? {}; return { notificationMuted: initiative.notificationMuted ?? null, deferWhileTyping: initiative.deferWhileTyping ?? null, minRelevance: initiative.minRelevance ?? null, quietUntil: initiative.quietUntil ?? null, style: project?.communication ?? null }; };
/** Component registry: every addressable unit of the project agent with a content hash. */
export function projectComponentRegistry({ genome, project } = {}) {
  const rows = [], add = (component, id, label, value) => rows.push({ key: `${component}:${id}`, component, id: String(id), label: clip(label, 160), hash: short(value), bytes: Buffer.byteLength(JSON.stringify(value ?? null)) });
  if (genome) {
    for (const section of systemPromptSections(genome.systemPrompt)) add('system_section', section.id, section.title, section.content.trim());
    for (const skill of genome.skills ?? []) add('skill', skill.id, skill.name, skill.source?.packageHash ? { source: skill.source.packageHash, name: skill.name, description: skill.description } : { name: skill.name, description: skill.description, instructions: skill.instructions, resources: (skill.resources ?? []).map(row => [row.path, short(row.content)]) });
    for (const tool of genome.tools ?? []) add('tool_description', tool.id, tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters, permission: tool.permission, script: short(tool.script ?? '') });
    if (genome.evaluationSuite) add('evaluation_standard', 'suite', '评测标准', { criteria: genome.evaluationSuite.criteria, thresholds: genome.evaluationSuite.thresholds, cases: (genome.evaluationSuite.cases ?? []).map(row => row.id) });
  }
  if (project) {
    for (const id of project.assignments?.mcpServerIds ?? []) add('mcp_assignment', id, id, id);
    add('rhythm', 'project', '节奏', { rhythm: project.rhythm ?? null, schedules: (project.schedules ?? []).filter(row => !row.archivedAt && !row.deletedAt).map(row => ({ id: row.id, cadence: row.cadence ?? row.cron ?? row.intervalMs ?? null, enabled: row.enabled ?? null })) });
    add('communication_style', 'project', '沟通风格', communicationOf(project));
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
/** Actual component-level diff; model-declared change counts are never trusted. */
export function diffProjectComponents(before = [], after = []) {
  const old = new Map(before.map(row => [row.key, row])), next = new Map(after.map(row => [row.key, row])), edits = [];
  for (const row of after) { const prior = old.get(row.key); if (!prior) edits.push({ key: row.key, component: row.component, id: row.id, label: row.label, change: 'added', beforeHash: null, afterHash: row.hash }); else if (prior.hash !== row.hash) edits.push({ key: row.key, component: row.component, id: row.id, label: row.label, change: 'modified', beforeHash: prior.hash, afterHash: row.hash }); }
  for (const row of before) if (!next.has(row.key)) edits.push({ key: row.key, component: row.component, id: row.id, label: row.label, change: 'removed', beforeHash: row.hash, afterHash: null });
  return edits;
}
/** Normalized hypothesis fingerprint: identical claims on the same component collide. */
export const rrsiHypothesisKey = (component, hypothesis) => short([component, String(hypothesis ?? '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()]);
/** Tag every actual edit with {component, hypothesis, diff}. A declared tag is kept
 * only when the diff carries evidence for it (RRSI components.normalize). */
export function tagCandidateEdits({ edits = [], hypothesis = '', changes = [], declared = [] } = {}) {
  const notes = (Array.isArray(changes) ? changes : []).map(text => clip(text, 400));
  return edits.map((edit, index) => {
    const claim = declared.find(row => row?.key === edit.key || row?.component === edit.component && row?.id === edit.id), note = notes.find(text => text.includes(edit.id) || text.includes(edit.label));
    const text = clip(claim?.hypothesis ?? hypothesis, 800);
    return { editId: `E${index + 1}`, key: edit.key, component: edit.component, id: edit.id, label: edit.label, change: edit.change, hypothesis: text, hypothesisKey: rrsiHypothesisKey(edit.component, text), diff: { beforeHash: edit.beforeHash, afterHash: edit.afterHash, ...(note ? { note } : {}) } };
  });
}

/** Summaries over the per-edit history (RRSI history.py). Records without a
 * measurement (critic/infra/author failures) never enter T_t, g_t or B_t. */
export function summarizeRrsiHistory(records = [], { t = 0, nPrune = RRSI_DEFAULTS.nPrune } = {}) {
  const edits = records.filter(row => row && row.editId && RRSI_COMPONENTS.includes(row.component));
  const measured = edits.filter(row => MEASURED.has(row.verdict) && finite(row.deltaS) !== null);
  const tried = [...new Set(measured.map(row => row.component))].sort();
  const attempted = Object.fromEntries(RRSI_COMPONENTS.map(component => [component, edits.filter(row => row.component === component).length]));
  const accepted = {}; for (const row of edits.filter(row => ['accepted', 'trial_adopted'].includes(row.verdict))) (accepted[row.component] ??= []).push({ t: row.t, key: row.key, hypothesis: row.hypothesis, deltaS: row.deltaS });
  for (const row of edits.filter(row => row.verdict === 'trial_rolled_back')) accepted[row.component] = (accepted[row.component] ?? []).filter(item => item.key !== row.key);
  const yieldBy = {}; for (const row of measured) if (t - (row.t ?? 0) <= nPrune) yieldBy[row.key] = Math.max(yieldBy[row.key] ?? -Infinity, row.deltaS);
  const keysTried = [...new Set(measured.map(row => row.key))];
  // B_t: tried keys whose recent best gain is ≤ 0 (or nothing recent). Only keys
  // still carried by the incumbent are prune candidates; removal is a proposal.
  const pruneSet = keysTried.filter(key => !(yieldBy[key] > 0)).map(key => ({ key, component: measured.find(row => row.key === key).component, recentBestGain: Number.isFinite(yieldBy[key]) ? round(yieldBy[key], 5) : null }));
  const falsified = new Map();
  // Chronological: a later measured success clears a hypothesis, a later rollback falsifies it again.
  for (const row of edits) if (['rejected', 'trial_rolled_back'].includes(row.verdict) || row.verdict === 'smoke_failed' && finite(row.deltaS) !== null && row.deltaS <= 0) falsified.set(row.hypothesisKey, { hypothesisKey: row.hypothesisKey, component: row.component, key: row.key, hypothesis: clip(row.hypothesis, 320), verdict: row.verdict, deltaS: finite(row.deltaS), t: row.t, context: row.context ?? null });
    else if (['accepted', 'trial_adopted'].includes(row.verdict)) falsified.delete(row.hypothesisKey);
  return { tried, untried: RRSI_COMPONENTS.filter(component => !tried.includes(component)), attempted, accepted, pruneSet, falsified: [...falsified.values()], measuredCount: measured.length, recordCount: edits.length };
}
/** σ_t = 1[S_t − S_{t−w} ≤ δ]; 0 while fewer than w rounds exist. */
export function rrsiStallFlag(trajectory = [], window = RRSI_DEFAULTS.window, delta = RRSI_DEFAULTS.minDelta) {
  const values = trajectory.filter(value => finite(value) !== null); if (values.length <= window) return 0;
  return values.at(-1) - values.at(-1 - window) <= (finite(delta) ?? 0) ? 1 : 0;
}
/** E_t: exploration directive handed to the proposer. */
export function rrsiExploration({ stall = 0, tried = [], components = RRSI_COMPONENTS } = {}) {
  const untried = components.filter(component => !tried.includes(component));
  const text = stall && untried.length ? `Stalled: the incumbent has not improved beyond the noise band over the last rounds. This round's candidate must include at least one edit to a component that has never been measured: ${untried.join(', ')}.`
    : untried.length ? `Components never measured: ${untried.join(', ')}. Not required this round, but they still lack evidence.` : 'Every component has been measured at least once.';
  return { stall: stall ? 1 : 0, untried, required: Boolean(stall && untried.length), text };
}
/** Everything the proposer sees: budget, history, falsified hypotheses, exploration, prune set. */
export function rrsiAuthorDirectives({ records = [], trajectory = [], t, config = RRSI_DEFAULTS, delta } = {}) {
  const round_ = Number.isSafeInteger(t) ? t : new Set(records.filter(row => row.editId).map(row => row.t)).size;
  const budget = rrsiEditBudget(round_, config.T, config.bMin, config.bMax), summary = summarizeRrsiHistory(records, { t: round_, nPrune: config.nPrune });
  const band = finite(delta) ?? config.delta ?? config.minDelta, exploration = rrsiExploration({ stall: rrsiStallFlag(trajectory, config.window, band), tried: summary.tried });
  const recent = records.filter(row => row.editId).slice(-24).map(row => ({ t: row.t, component: row.component, key: row.key, hypothesis: clip(row.hypothesis, 240), verdict: row.verdict, ...(finite(row.deltaS) !== null ? { deltaS: round(row.deltaS, 4) } : {}), ...(finite(row.deltaC) !== null ? { deltaC: round(row.deltaC, 3) } : {}) }));
  const text = [`Edit budget: this round's candidate holds at most ${budget} independent component edits (round ${round_ + 1}; the budget tightens each round). Every edit must belong to one component and state its hypothesis.`, exploration.text,
    summary.falsified.length ? `Falsified hypotheses (do not propose the same hypothesis on the same component again unless there is new evidence): ${summary.falsified.slice(-12).map(row => `[${row.component}] ${row.hypothesis}`).join('; ')}` : '',
    summary.pruneSet.length ? `Components that have long brought no improvement and can be removed or simplified: ${summary.pruneSet.slice(0, 8).map(row => row.key).join(', ')}. Removing one is a valid edit.` : ''].filter(Boolean).join('\n');
  return { round: round_, budget, exploration, falsified: summary.falsified.slice(-24), pruneSet: summary.pruneSet.slice(0, 16), tried: summary.tried, untried: summary.untried, recent, text };
}

// ---------------------------------------------------------------- critic --
const CREDENTIAL = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,})/i;
const UNBOUNDED = /(?:repeat|retry|keep (?:improving|trying)|loop)\s+(?:until|forever|indefinitely)|反复直到|一直重试|无限(?:重试|循环)/i;
const GRADER = /(?:evaluation suite|frozen case|judge|rubric|grader|评测用例|评分器|评委|冻结用例)/i;
/** Deterministic critic layer (RRSI critic.precheck + Rna leakage rules):
 * credentials, evaluation-case leakage, grader gaming, inert edits, unbounded
 * loops, budget overflow, falsified re-proposals and unverified exploration. */
export function rrsiCriticPrecheck({ edits = [], addedText = '', evaluationSuite, budget = Infinity, falsified = [], exploration } = {}) {
  const reasons = [], text = String(addedText ?? '');
  if (!edits.length) reasons.push({ code: 'no_edit', message: 'The candidate changes no component.' });
  if (edits.length > budget) reasons.push({ code: 'budget_exceeded', message: `The candidate holds ${edits.length} component edits, over this round's budget of ${budget}. Merge them into the ${budget} best-evidenced edits.` });
  if (CREDENTIAL.test(text)) reasons.push({ code: 'credential', message: 'The added text appears to contain a credential.' });
  for (const testCase of evaluationSuite?.cases ?? []) {
    const probes = [testCase.id.length >= 6 ? testCase.id : null, ...String(testCase.input ?? '').split(/[。！？.!?\n]/).map(row => row.trim()).filter(row => row.length >= 24).slice(0, 4)].filter(Boolean);
    if (probes.some(probe => text.includes(probe))) { reasons.push({ code: 'case_leakage', message: `The added text copies the id or wording of the frozen evaluation case (${testCase.id}), which games that case.` }); break; }
  }
  if (GRADER.test(text) && /(?:score|评分|得分|pass|通过)/i.test(text)) reasons.push({ code: 'grader_gaming', message: 'The added text aims at the evaluation or scoring mechanism instead of improving the actual work.' });
  if (UNBOUNDED.test(text)) reasons.push({ code: 'unbounded_work', message: 'The added text contains a loop or retry with no exit condition.' });
  for (const edit of edits) if (edit.change === 'modified' && edit.diff?.beforeHash === edit.diff?.afterHash) reasons.push({ code: 'inert_edit', message: `${edit.key} claims a change but its content is unchanged.` });
  const falsifiedKeys = new Set(falsified.map(row => row.hypothesisKey));
  const repeated = edits.filter(edit => falsifiedKeys.has(edit.hypothesisKey));
  if (repeated.length) reasons.push({ code: 'falsified_hypothesis', message: `Repeats a falsified hypothesis: ${repeated.map(row => row.key).join(', ')}.` });
  if (exploration?.required && !edits.some(edit => exploration.untried.includes(edit.component))) reasons.push({ code: 'exploration_required', message: `While stalled, the candidate must edit at least one component that has never been measured: ${exploration.untried.join(', ')}.` });
  return { verdict: reasons.length ? 'reject' : 'accept', reasons, repairable: reasons.length > 0 && reasons.every(row => !['credential'].includes(row.code)) };
}
/** Critic with bounded repair: precheck, optional LLM review, at most `maxRepairs` repairs. */
export async function runRrsiCritic({ candidate, precheck, review, repair, maxRepairs = RRSI_DEFAULTS.maxCriticRepairs } = {}) {
  let current = candidate; const rounds = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const hard = precheck(current), soft = hard.verdict === 'accept' && review ? await review(current) : null;
    const verdict = hard.verdict === 'reject' ? hard : soft && soft.verdict === 'reject' ? { verdict: 'reject', reasons: (soft.reasons ?? []).map(message => ({ code: 'review', message: clip(message, 400) })), repairable: true } : { verdict: 'accept', reasons: [], repairable: false };
    rounds.push({ attempt, verdict: verdict.verdict, reasons: verdict.reasons });
    if (verdict.verdict === 'accept') return { verdict: 'accept', candidate: current, rounds, repairs: attempt };
    if (attempt >= maxRepairs || !verdict.repairable || typeof repair !== 'function') return { verdict: 'reject', candidate: current, rounds, repairs: attempt, reasons: verdict.reasons };
    current = await repair(current, verdict.reasons);
    if (!current) return { verdict: 'reject', candidate, rounds, repairs: attempt + 1, reasons: verdict.reasons };
  }
}

// ------------------------------------------------------------- selection --
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const stdev = values => values.length < 2 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1));
/** δ from repeated evaluations of the unchanged baseline (RRSI calibrate.py):
 * δ = z·sd(null ΔS), sd(null ΔS) = √2·sd(S). With one evaluation, bootstrap over
 * per-case scores estimates se(S). Never below `minDelta`. */
export function calibrateRrsiNoiseBand({ baselineScores = [], caseScores = [], z = RRSI_DEFAULTS.deltaZ, minDelta = RRSI_DEFAULTS.minDelta, reps = 1000, seed = 7 } = {}) {
  const scores = baselineScores.filter(value => finite(value) !== null), cases = caseScores.filter(value => finite(value) !== null);
  let sd = 0, method = 'insufficient';
  if (scores.length >= 2 && stdev(scores) > 0) { sd = Math.SQRT2 * stdev(scores); method = 'repeated_baseline_evaluations'; }
  else if (cases.length >= 2) {
    let state = seed >>> 0; const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const samples = []; for (let rep = 0; rep < reps; rep++) { let sum = 0; for (let i = 0; i < cases.length; i++) sum += cases[Math.floor(random() * cases.length)]; samples.push(sum / cases.length); }
    sd = Math.SQRT2 * stdev(samples); method = 'bootstrap_over_cases';
  }
  const delta = Math.max(minDelta, z * sd);
  return { delta: round(delta), measured: method !== 'insufficient', method, z, sdNull: round(sd), baselineEvaluations: scores.length, cases: cases.length };
}
export const rrsiRelativeCostChange = (candidate, incumbent) => !(candidate > 0) || !(incumbent > 0) ? 0 : (candidate - incumbent) / incumbent;
/** ν(l′): structural components the candidate touches that never had an accepted edit. */
export const rrsiNovelty = (components = [], incumbentCounts = {}) => new Set(components.filter(component => RRSI_STRUCTURAL_COMPONENTS.includes(component) && !(incumbentCounts[component] > 0))).size;
/** Candidate score = w_real·real + w_jev·jev. With insufficient real signal the
 * blend is not produced: JEV is a prior and cannot carry a candidate alone. */
export function rrsiBlendedScore({ real, jev, realCases = 0, config = RRSI_DEFAULTS } = {}) {
  const realScore = finite(real), jevScore = finite(jev), sufficient = realScore !== null && realCases >= config.minRealCases;
  if (!sufficient) return { score: null, sufficientReal: false, real: realScore, jev: jevScore, weights: { real: config.wReal, jev: config.wJev } };
  const weights = jevScore === null ? { real: 1, jev: 0 } : { real: config.wReal / (config.wReal + config.wJev), jev: config.wJev / (config.wReal + config.wJev) };
  return { score: round(weights.real * realScore + weights.jev * (jevScore ?? 0)), sufficientReal: true, real: realScore, jev: jevScore, weights };
}
/** JEV prior may only decide whether to spend evaluation. */
export function rrsiPrescreen({ better, expectedGain, source } = {}) {
  if (source !== 'judge' || better === undefined || better === null) return { evaluate: true, reason: 'no_confident_prior' };
  return better === false ? { evaluate: false, reason: 'jev_prior_negative' } : { evaluate: true, reason: 'jev_prior_positive', ...(finite(expectedGain) !== null ? { expectedGain } : {}) };
}
/** Algorithm 2 (RRSI selection.py): noise-adjusted floor, cost rule within/outside the band, guards. */
export function rrsiSelect({ candidate = {}, incumbent = {}, sStar, delta, config = RRSI_DEFAULTS, incumbentCounts = {}, guards = [] } = {}) {
  const S = finite(candidate.S), base = finite(incumbent.S);
  if (S === null || base === null) return { admissible: false, reason: candidate.gateFailure ?? 'not_measured', S, deltaS: null, deltaC: null, novelty: 0 };
  const band = Math.max(finite(delta) ?? config.minDelta, 0), best = Math.max(finite(sStar) ?? base, base), deltaS = S - base, deltaC = rrsiRelativeCostChange(candidate.C, incumbent.C), novelty = rrsiNovelty(candidate.components ?? [], incumbentCounts);
  const decision = { admissible: false, S: round(S), baseline: round(base), sStar: round(best), delta: round(band), deltaS: round(deltaS), deltaC: round(deltaC), novelty };
  if (S < best - band) return { ...decision, reason: `below_noise_floor: S' ${S.toFixed(4)} < S* ${best.toFixed(4)} − δ ${band.toFixed(4)}` };
  let ok, why;
  if (deltaS > band) { const allowance = config.beta0 + config.beta1 * deltaS; ok = deltaC <= allowance; why = `gain ${deltaS.toFixed(4)} > δ; cost ${deltaC.toFixed(3)} ${ok ? '≤' : '>'} allowance ${allowance.toFixed(3)}`; }
  else { const shaped = config.wS * deltaS - config.wC * deltaC + config.wN * novelty; ok = shaped > 0; why = `gain ${deltaS.toFixed(4)} within δ; shaped ${shaped.toFixed(4)} ${ok ? '>' : '≤'} 0 (ν=${novelty})`; }
  if (!ok) return { ...decision, reason: `cost_rule_failed: ${why}` };
  if (guards.length) return { ...decision, reason: `guard_violated: ${guards.join('; ')}` };
  return { ...decision, admissible: true, reason: `admissible: ${why}` };
}

// ---------------------------------------------------------- tiered eval --
/** critic → smoke (≤3 cases) → full evaluation; each tier runs only after the
 * previous one passes. Stage callbacks own all model calls and accounting. */
export async function runRrsiTieredEvaluation({ critic, prescreen, smoke, full, onStage = () => {} } = {}) {
  const tiers = [];
  const stage = async (name, run) => {
    if (typeof run !== 'function') { tiers.push({ tier: name, status: 'skipped', reason: 'not_configured' }); onStage(tiers.at(-1)); return { passed: true, skipped: true }; }
    onStage({ tier: name, status: 'running' });
    const result = await run(); const row = { tier: name, status: result?.skipped ? 'skipped' : result?.passed ? 'passed' : 'failed', ...(result?.reason ? { reason: clip(result.reason, 300) } : {}) };
    tiers.push(row); onStage(row); return result ?? { passed: false };
  };
  for (const [name, run] of [['critic', critic], ['prescreen', prescreen], ['smoke', smoke], ['full', full]]) {
    const result = await stage(name, run);
    if (!result.passed) return { passed: false, stoppedAt: name, tiers, result };
    if (name === 'full') return { passed: true, stoppedAt: null, tiers, result };
  }
}
/** Pick ≤ n smoke cases: real-interaction replay cases first, then highest weight. */
export function rrsiSmokeCaseIds(suite, { preferred = [], n = RRSI_DEFAULTS.smokeCases } = {}) {
  const cases = suite?.cases ?? [], first = cases.filter(row => preferred.includes(row.id)), rest = cases.filter(row => !preferred.includes(row.id)).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || a.id.localeCompare(b.id));
  return [...first, ...rest].slice(0, n).map(row => row.id);
}
/** Deterministic held-out split: a stable hash, not a random draw per run. */
export const rrsiSplit = (id, fraction = RRSI_DEFAULTS.heldOutFraction) => parseInt(hash(['rrsi-split-v1', id]).slice(0, 8), 16) / 0x100000000 < fraction ? 'heldout' : 'evolve';

// -------------------------------------------------------------- changelog --
/** A human changelog line for an accepted/adopted edit ("Rna 学到了…"). */
export function rrsiChangelogEntry(record) {
  const label = RRSI_COMPONENT_LABELS[record.component] ?? record.component, gain = finite(record.deltaS);
  const verb = { accepted: '学到了', trial_adopted: '学到了', trial_rolled_back: '放弃了', rejected: '验证后没有采用', lost: '验证后没有采用' }[record.verdict] ?? '尝试了';
  return { at: record.at, versionId: record.versionId, key: record.key, component: record.component, verdict: record.verdict, title: `Rna ${verb}：${clip(record.hypothesis, 160) || label}`, detail: `${label}「${clip(record.label ?? record.id, 80)}」${record.change === 'added' ? '新增' : record.change === 'removed' ? '移除' : '调整'}${gain !== null ? `，得分变化 ${gain >= 0 ? '+' : ''}${gain.toFixed(3)}` : ''}` };
}
