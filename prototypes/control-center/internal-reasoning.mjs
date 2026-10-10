import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { countBucket } from '../../packages/sdk/src/decision-state.mjs';
import { defaultReasoningUsable, internalReasoningPlan } from '../../packages/sdk/src/reasoning-effort.mjs';
import { evidenceText } from './evidence-text.mjs';

// Internal reasoning effort (spec p1 effort; user decision 2026-10-04 §4.2): internal model calls (proactive decisions,
// background work, the narrator's rewrite, subtasks, setup, compaction) no longer inherit the chat's `max`. Where the
// provider's own default adapts or sits below the top level, they send `default` at once; elsewhere (GLM-5.3 documents
// default = max) JEV picks a depth per call from the task, mapped onto the model's efforts and never above the chat
// level. On those providers the route ships in shadow (`configuration.internalReasoning.routing`): the chosen effort is
// recorded on every call while today's effort is sent, until a paid replay shows failure rates do not worsen. The
// switch routes per purpose (`purposes`), and only the purposes a replay gate covers (decisions, rewrites) can be routed.

export const INTERNAL_REASONING_MODES = Object.freeze(['auto', 'chat']);
export const INTERNAL_REASONING_ROUTING = Object.freeze(['shadow', 'route']);
export const INTERNAL_PURPOSES = Object.freeze(['decision', 'work', 'narrator', 'setup', 'compaction']);
/** What `routing: 'route'` may send: the purposes the Stage B replay gates (benchmark/internal-effort-replay.mjs). */
export const ROUTABLE_PURPOSES = Object.freeze(['decision', 'narrator']);
/** Recorded only whatever the setting says (an RNA_JEV_MODES trial excepted): background work and subtasks until their
 * own replay (they run tools, so it needs an isolated worktree; review EFF-4/RPL-4), setup and compaction until their
 * own labelled probes (spec §3.2 rollout, phase 2). */
export const SHADOW_ONLY_PURPOSES = Object.freeze(['work', 'setup', 'compaction']);

/** The saved setting with its defaults (absent = auto + shadow routing, every routable purpose named, capture off; no
 * migration write). */
export function internalReasoningSetting(configuration) {
  const saved = configuration?.internalReasoning;
  const value = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const purposes = Array.isArray(value.purposes) ? ROUTABLE_PURPOSES.filter(purpose => value.purposes.includes(purpose)) : [];
  return { mode: INTERNAL_REASONING_MODES.includes(value.mode) ? value.mode : 'auto', routing: INTERNAL_REASONING_ROUTING.includes(value.routing) ? value.routing : 'shadow', capture: value.capture === true, purposes: purposes.length ? purposes : [...ROUTABLE_PURPOSES] };
}
/** Whether the setting sends the JEV-chosen effort for this purpose (still subject to the point's mode). */
export const settingRoutes = (setting, purpose) => setting?.routing === 'route' && Array.isArray(setting.purposes) && setting.purposes.includes(purpose);
/** Validated patch for ConfigurationService.update; throws a 400 with the field in error. */
export function internalReasoningInput(input, current = {}) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'routing', 'capture', 'purposes'].includes(key))) fail('internalReasoning 只能包含 mode、routing、capture 与 purposes');
  const next = { ...internalReasoningSetting({ internalReasoning: current }) };
  if (input.mode !== undefined) { if (!INTERNAL_REASONING_MODES.includes(input.mode)) fail('internalReasoning.mode 必须为 auto 或 chat'); next.mode = input.mode; }
  if (input.routing !== undefined) { if (!INTERNAL_REASONING_ROUTING.includes(input.routing)) fail('internalReasoning.routing 必须为 shadow 或 route'); next.routing = input.routing; }
  if (input.capture !== undefined) { if (typeof input.capture !== 'boolean') fail('internalReasoning.capture 必须为布尔值'); next.capture = input.capture; }
  if (input.purposes !== undefined) {
    if (!Array.isArray(input.purposes) || !input.purposes.length || input.purposes.some(purpose => !ROUTABLE_PURPOSES.includes(purpose)) || new Set(input.purposes).size !== input.purposes.length) fail(`internalReasoning.purposes 必须是 ${ROUTABLE_PURPOSES.join('、')} 中不重复的一项或多项`);
    next.purposes = ROUTABLE_PURPOSES.filter(purpose => input.purposes.includes(purpose));
  }
  return next;
}

// The plan itself (provider default where usable, chat ceiling, the project's explicit level, a route where the default is
// the top or unknown) is the SDK's: one rule for every internal call here and for the SDK's own summary default.
export { internalReasoningPlan };
/** Whether omitting the effort ('default') is already the right internal choice (SDK reasoning-effort.mjs). */
export const defaultUsable = defaultReasoningUsable;
/** A judged depth on the plan's efforts: light → lightest, standard → the middle (the declared default when it is a
 * lower level), deep → the ceiling; unknown keeps today's effort. */
export function effortForDepth(depth, plan) {
  if (!plan || plan.mode !== 'route') return plan?.effort;
  const allowed = plan.allowed;
  if (depth === 'light') return allowed[0];
  if (depth === 'standard') return plan.preferred ?? (allowed.length <= 2 ? allowed.at(-1) : allowed[Math.floor((allowed.length - 1) / 2)]);
  if (depth === 'deep') return allowed.at(-1);
  return plan.fallback;
}

// ----------------------------------------------------------------- facts
// Code computes every fact; JEV reads words and buckets beside the text the judgment needs (AGENTS.md).
const WAKE_SOURCES = { user_message: 'user message', conversation_result: 'conversation result', action_completed: 'background result', scheduled_occurrence: 'scheduled run due', workspace_change: 'project files changed', schedule_state: 'schedule changed', project_state: 'project description changed' };
const OPEN = new Set(['queued', 'running', 'paused', 'needs_review']);
/** Actions waiting on a decision or on the user: a stopped or interrupted run to confirm, a paused or queued one. */
const WAITING = new Set(['queued', 'paused', 'needs_review']);
/**
 * effort.decision: the wake the coordinator is about to decide on (its hook input), the project's open work, and the
 * reason the host sent this wake to the main model past the judge (`bypass`: pending_review, due_schedule,
 * unanswered_question, … from DecisionService.bypassSignal), if it did.
 */
export function decisionEffortInput(input = {}, { openWork = {}, bypass = null } = {}) {
  const events = Array.isArray(input.events) ? input.events : [], last = input.lastDecision, lastAt = Number.isFinite(last?.at) ? last.at : -Infinity;
  const fresh = events.filter(event => Number.isFinite(event?.at) ? event.at > lastAt : !(last?.evidenceIds ?? []).includes(event?.id));
  const contracts = input.project?.actionContracts ?? {};
  const failureToReview = input.failureReview === true;
  const facts = {
    wakeSources: fresh.length ? [...new Set(fresh.map(event => WAKE_SOURCES[event.type] ?? 'other observation'))] : ['none'],
    newEvidence: countBucket(fresh.length),
    pendingRequests: countBucket(openWork.commitments ?? 0), overdueRequests: countBucket(openWork.overdue ?? 0), waitingOnUser: countBucket(openWork.awaitingUser ?? 0),
    failureToReview, planOrOptionsToWrite: contracts.judgment?.enabled === true, rhythmToAssess: contracts.rhythm?.enabled === true && contracts.rhythm.requiresAssessment === true,
    previousProposalNotAdmitted: Boolean(input.previousDecision), openActions: countBucket((input.recentActions ?? []).filter(action => OPEN.has(action?.status)).length),
  };
  const shown = (fresh.length ? fresh : events).slice(-6).map(event => `${event.type ?? 'evidence'}: ${evidenceText(event)}`);
  // Computed in code, never asked (mu: rules before the judge; Stage A probe, docs/research/jev-internal-effort-probe-*):
  // - deep: a plan or rhythm the decision must write, a failure it must review, or a user request still pending or
  //   overdue that it must decide how to continue;
  // - light: nothing arrived since the last decision, nothing is pending and no earlier proposal was refused, so the
  //   decision only re-reads what it already decided on (a timer wake) — and nothing else is open: no action waiting
  //   on a review, a resume or its turn (a run the user stopped is needs_review with no new event), no open agenda (what
  //   floor wakes are for), nothing waiting on the user, no held finding, and the host did not send the wake past the
  //   judge for a reason of its own (review EFF-2).
  // A quiet wake with something open is JEV's to judge, never lighter than standard (`floor`): Stage A measured JEV
  // only on wakes with new evidence, and the risk Stage B watches — a lighter effort losing the model's own initiative —
  // sits exactly here. Everything else (new evidence, nothing pending) is JEV's to judge.
  const pending = (openWork.commitments ?? 0) > 0 || (openWork.overdue ?? 0) > 0;
  const open = (openWork.agenda ?? 0) > 0 || (openWork.awaitingUser ?? 0) > 0 || (openWork.heldFindings ?? 0) > 0 || (input.recentActions ?? []).some(action => WAITING.has(action?.status)) || Boolean(bypass);
  const quiet = !fresh.length && !input.previousDecision;
  const rule = failureToReview || facts.planOrOptionsToWrite || facts.rhythmToAssess || pending ? 'deep' : quiet && !open ? 'light' : null;
  return { facts, evidence: shown, rule, ...(rule === null && quiet && open ? { floor: 'standard' } : {}) };
}
/** effort.work: one background run (or one delegated subtask). */
export function workEffortInput({ task, origin = 'background', scheduled = false, writable = false, isolated = false, resumes = false, earlierAttemptFailed = false, handoffAvailable = false } = {}) {
  return { task: String(task ?? ''), facts: { origin: origin === 'delegated' ? 'delegated' : 'background', scheduled: scheduled === true, writable: writable === true, isolated: isolated === true, resumes: resumes === true, earlierAttemptFailed: earlierAttemptFailed === true, handoffAvailable: handoffAvailable === true }, rule: null };
}
/**
 * How much a flagged problem asks of the rewrite (spec criteria, by code): ids and repeats go by deleting or rewording
 * sentences (light); a buried result by reordering (standard); a status ping or an account instead of the deliverable
 * needs a judgment about what matters to the user (deep). The Stage A probe showed JEV reading these from the text far
 * less reliably than the codes say them (docs/research/jev-internal-effort-probe-20261004.md), so code decides; an
 * unknown code is left to JEV.
 */
const FLAG_DEPTH = Object.freeze({ internal_id: 'light', near_duplicate: 'light', result_not_first: 'standard', status_ping: 'deep', describes_instead_of_delivering: 'deep' });
const DEPTH_ORDER = ['light', 'standard', 'deep'];
/** effort.narrator: the agent's rewrite of its own flagged message. */
export function narratorEffortInput({ text, violations = [], scheduled = false, deliverable = null } = {}) {
  const codes = (violations ?? []).map(row => String(row?.code ?? row)), depths = codes.map(code => FLAG_DEPTH[code]);
  const rule = codes.length && depths.every(Boolean) ? depths.reduce((deepest, depth) => DEPTH_ORDER.indexOf(depth) > DEPTH_ORDER.indexOf(deepest) ? depth : deepest, 'light') : null;
  return { message: String(text ?? ''), facts: { flagged: codes.map(code => code.replace(/_/g, ' ')).slice(0, 8), scheduled: scheduled === true, ...(deliverable ? { deliverable: String(deliverable).slice(0, 80) } : {}) }, rule };
}
/** effort.setup: project initialization (the project's description, whether earlier work is migrated, what the folder holds). */
export function setupEffortInput({ task, migration = false, existingFiles = 0, existingDocuments = 0 } = {}) {
  return { task: String(task ?? ''), facts: { migration: migration === true, existingFiles: countBucket(existingFiles), existingDocuments: countBucket(existingDocuments) }, rule: null };
}
const historyBucket = tokens => !Number.isFinite(tokens) || tokens < 16000 ? 'small' : tokens < 64000 ? 'medium' : tokens < 200000 ? 'large' : 'very large';
/** A host's model config with the effort the SDK says the conversation sends now (the sideReasoning hook's `model`):
 * a summary is planned on that, never on a turn snapshot taken before a per-turn route moved the effort (review EFF-3). */
export const liveModel = (model, live) => live && typeof live === 'object' && typeof live.reasoning === 'string' ? { ...model, reasoning: live.reasoning, ...(live.reasoningSelection !== undefined ? { reasoningSelection: live.reasoningSelection } : {}), ...(live.reasoningCapability !== undefined ? { reasoningCapability: live.reasoningCapability } : {}) } : model;
/** effort.compaction: one summary of a conversation's history. */
export function compactionEffortInput({ historyTokens, toolResults = 0, manual = false, request = '' } = {}) {
  return { request: String(request ?? ''), facts: { historyAmount: historyBucket(historyTokens), toolResults: countBucket(toolResults), manual: manual === true }, rule: null };
}

// --------------------------------------------------------------- capture
// Opt-in (configuration.internalReasoning.capture, or RNA_EFFORT_PROBE_CAPTURE=1; =0 forces it off): what each routed
// call was about, its plan and the JEV verdict, plus for decisions the exact request data, so the Stage A labelled sets
// and the Stage B replay (benchmark/internal-effort-replay.mjs) use real calls. Kept in
// `<state>.rna/effort-probe/<projectId>/effort-<purpose>.jsonl` (mode 600, folders 700), inside the conversation-journal
// root every release's checkpoint inventories — a new top-level `<state>.<name>` would be refused by a rolled-back
// release's checkpoint (the 0.43.0 trap) — and denied to project tools with it; the replay's reports sit in its
// `replay/` folder. The newest rows per file for 14 days (pruned on append and by the daily sweep, capture on or off;
// older rows are never read); never in the decision ledger. A deleted conversation's rows and a deleted project's
// folder go with them (project-files.mjs), and no row is written for a conversation already deleted.
// Decisions keep about what one replay needs (30 cases): each row holds a whole decision request (100–200 KB), and the
// folder is copied into every maintenance checkpoint (review RPL-11).
const CAPTURE_LIMITS = Object.freeze({ decision: 40, work: 300, narrator: 200, setup: 60, compaction: 120 });
export const CAPTURE_RETENTION_MS = 14 * 86400000;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
export const captureRoot = stateFile => join(`${stateFile}.rna`, 'effort-probe');
const fileOf = (stateFile, projectId, purpose) => join(captureRoot(stateFile), projectId, `effort-${purpose}.jsonl`);
const readRows = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };
const realDir = path => { try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; } };
function rewrite(file, rows) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 }); renameSync(temp, file);
}
export function captureEnabled(configuration, env = process.env) {
  if (env.RNA_EFFORT_PROBE_CAPTURE === '1') return true;
  if (env.RNA_EFFORT_PROBE_CAPTURE === '0') return false;
  return internalReasoningSetting(configuration).capture;
}
/** Every conversation a captured row saw still exists and is not being deleted: a row written or replayed after its
 * conversation was deleted would keep or send that conversation's text (review RPL-1/RPL-10). */
export function sessionsLive(state, ids = []) {
  const deleting = new Set((state?.sessionDeletions ?? []).map(row => row?.sessionId));
  return (Array.isArray(ids) ? ids : []).every(id => !deleting.has(id) && (state?.sessions ?? []).some(session => session.id === id));
}
export class EffortCapture {
  /** `live(sessionIds)`: whether those conversations still exist; a row that saw a deleted one is not written. */
  constructor({ stateFile, now = Date.now, live = null } = {}) { this.stateFile = stateFile; this.now = now; this.live = typeof live === 'function' ? live : null; this.appends = new Map(); this.cache = new Map(); }
  /** Append one row; returns its id, or null (never throws into a model call). */
  record(projectId, purpose, row) {
    if (!this.stateFile || !SAFE.test(String(projectId)) || !INTERNAL_PURPOSES.includes(purpose)) return null;
    try { if (this.live && Array.isArray(row?.sessionIds) && row.sessionIds.length && !this.live(row.sessionIds)) return null; } catch { return null; }
    try {
      const root = captureRoot(this.stateFile), dir = join(root, projectId), file = fileOf(this.stateFile, projectId, purpose), id = row.id ?? randomUUID();
      mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
      appendFileSync(file, `${JSON.stringify({ ...row, kind: row.kind ?? 'call', id, at: row.at ?? new Date(this.now()).toISOString(), projectId, purpose })}\n`, { mode: 0o600 });
      const count = (this.appends.get(file) ?? 0) + 1; this.appends.set(file, count);
      if (count % 25 === 1) this.prune(file, purpose);
      return id;
    } catch { return null; }
  }
  /** The outcome of a captured call (appended beside it, matched by id). */
  outcome(projectId, purpose, id, outcome) { if (typeof id === 'string') this.record(projectId, purpose, { kind: 'outcome', id, outcome }); }
  prune(file, purpose) { return pruneFile(file, purpose, this.now()); }
  /** A file's rows, parsed once per version of the file (inode, size, mtime): status reads poll these (review RPL-11). */
  rows(file) {
    let info;
    try { info = statSync(file); } catch { this.cache.delete(file); return []; }
    const key = `${info.ino}:${info.size}:${info.mtimeMs}`, hit = this.cache.get(file);
    if (hit?.key === key) return hit.rows;
    const rows = readRows(file); this.cache.set(file, { key, rows }); return rows;
  }
  /** Calls of one purpose (newest last) inside the 14-day retention, each with its outcome when one was recorded. */
  calls(purpose, { projectId } = {}) {
    const root = captureRoot(this.stateFile); if (!realDir(root)) return [];
    const projects = projectId ? [projectId] : readdirSync(root).filter(name => SAFE.test(name) && realDir(join(root, name)));
    const out = [], cutoff = this.now() - CAPTURE_RETENTION_MS;
    for (const project of projects) {
      const rows = this.rows(fileOf(this.stateFile, project, purpose)), outcomes = new Map(rows.filter(row => row.kind === 'outcome').map(row => [row.id, row.outcome]));
      for (const row of rows) if (row.kind === 'call' && Date.parse(row.at) >= cutoff) out.push({ ...row, ...(outcomes.has(row.id) ? { outcome: outcomes.get(row.id) } : {}) });
    }
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  /** Whether a captured call is still on disk inside retention (not purged with its conversation or project). */
  has(projectId, purpose, id) {
    if (!SAFE.test(String(projectId)) || !INTERNAL_PURPOSES.includes(purpose)) return false;
    const cutoff = this.now() - CAPTURE_RETENTION_MS;
    return this.rows(fileOf(this.stateFile, projectId, purpose)).some(row => row.kind === 'call' && row.id === id && Date.parse(row.at) >= cutoff);
  }
}
/** Drop rows past retention, calls beyond the purpose's limit and outcomes without their call; rewrite only on a change. */
function pruneFile(file, purpose, now) {
  const all = readRows(file), cutoff = now - CAPTURE_RETENTION_MS, rows = all.filter(row => Date.parse(row.at) >= cutoff);
  const calls = rows.filter(row => row.kind === 'call').slice(-(CAPTURE_LIMITS[purpose] ?? 200)), keep = new Set(calls.map(row => row.id));
  const next = rows.filter(row => keep.has(row.id));
  if (next.length !== all.length) rewrite(file, next);
  return all.length - next.length;
}
/**
 * The retention sweep (at start and daily, beside the project-files sweep; review RPL-2): every capture file, whether
 * capture is on or off and whether its project still wakes, loses its rows past 14 days or over its limit — and, given
 * the state, every row that saw a conversation no longer in it (a row that landed after its deletion's purge, RPL-10).
 * Returns the number of rows removed; never throws.
 */
export function pruneEffortCaptures(stateFile, { now = Date.now(), state = null } = {}) {
  let removed = 0;
  try {
    const root = captureRoot(stateFile); if (!realDir(root)) return 0;
    for (const project of readdirSync(root).filter(name => SAFE.test(name) && realDir(join(root, name)))) for (const name of readdirSync(join(root, project)).filter(name => /^effort-[a-z]+\.jsonl$/.test(name))) {
      const file = join(root, project, name), purpose = name.slice('effort-'.length, -'.jsonl'.length);
      try {
        removed += pruneFile(file, purpose, now);
        if (!state) continue;
        const rows = readRows(file), drop = new Set(rows.filter(row => Array.isArray(row.sessionIds) && row.sessionIds.length && !sessionsLive(state, row.sessionIds)).map(row => row.id));
        if (drop.size) { const next = rows.filter(row => !drop.has(row.id)); rewrite(file, next); removed += rows.length - next.length; }
      } catch { /* the next sweep retries this file */ }
    }
  } catch { /* the next sweep retries */ }
  return removed;
}
/** A deleted conversation: drop every captured row that carried its content (rows list the sessions they saw). */
export function purgeEffortCaptures(stateFile, sessionId) {
  const root = captureRoot(stateFile); if (!SAFE.test(String(sessionId)) || !realDir(root)) return 0;
  let removed = 0;
  for (const project of readdirSync(root).filter(name => SAFE.test(name) && realDir(join(root, name)))) for (const name of readdirSync(join(root, project)).filter(name => /^effort-[a-z]+\.jsonl$/.test(name))) {
    const file = join(root, project, name), rows = readRows(file), drop = new Set(rows.filter(row => Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId)).map(row => row.id));
    if (!drop.size) continue;
    rewrite(file, rows.filter(row => !drop.has(row.id))); removed += drop.size;
  }
  return removed;
}
// A deleted project's captures go with its other private folders (project-files.mjs ROOTS).

// ------------------------------------------------------------------ route
/**
 * One internal call's effort: `{ reasoning, record }`. `record.source` says where it came from (setting, project,
 * provider-default, chat-ceiling, chat-off, no-levels, jev, rule, fallback). While the route only records (routing
 * 'shadow'), JEV judges beside the call and never delays it: the call keeps today's effort, and the judged depth and
 * effort go to the decision ledger (and the capture row). Never throws: any failure keeps today's effort.
 */
export async function reasoningFor({ decisions, configuration, project, model, purpose, call = {}, projectSelection = null, capture = null, sessionIds = [], request = null, signal } = {}) {
  const setting = internalReasoningSetting(configuration);
  let plan;
  try { plan = internalReasoningPlan(model, { setting: setting.mode, projectSelection }); } catch { return { reasoning: model?.reasoning ?? 'default', record: { source: 'fallback', reason: 'plan_failed' } }; }
  if (plan.mode === 'fixed') return { reasoning: plan.effort, record: { source: plan.source } };
  if (typeof decisions?.internalEffort !== 'function') return { reasoning: plan.fallback, record: { source: 'fallback', reason: 'no_judge' } };
  const mayApply = mayRoute(decisions, setting, purpose);
  const captured = Boolean(capture && project?.id && captureEnabled(configuration)), captureId = captured ? randomUUID() : null;
  const save = (verdict, sent) => captured ? capture.record(project.id, purpose, { id: captureId, sessionIds: [...new Set(sessionIds.filter(id => typeof id === 'string'))], providerId: model?.providerId ?? null, modelId: model?.modelId ?? null, outputCap: Number.isSafeInteger(model?.maxOutputTokens) ? model.maxOutputTokens : null, plan, routing: setting.routing,
    verdict: verdict ? { depth: verdict.depth ?? null, effort: verdict.effort ?? null, source: verdict.source ?? null, applied: verdict.applied === true, ledgerId: verdict.ledgerId ?? null } : null, sent,
    call: { facts: call.facts ?? {}, ...(call.task ? { task: call.task } : {}), ...(call.message ? { message: call.message } : {}), ...(call.request ? { request: call.request } : {}), ...(call.evidence ? { evidence: call.evidence } : {}), ...(call.rule ? { rule: call.rule } : {}), ...(call.floor ? { floor: call.floor } : {}) }, ...(request ? { request } : {}) }) : null;
  const judge = () => decisions.internalEffort(project, { purpose, plan, ...call, apply: mayApply, capture: captured, signal });
  if (!mayApply) {
    // Shadow: today's effort is sent now; the verdict is recorded when it arrives (bounded like every parallel observer).
    // It is also written onto the returned record: `shadow` turns from true into `{ effort, depth }`. JEV answers in
    // about 200 ms and a call takes far longer, so whatever copies the record when the call ends (the decision's
    // outcome, its wake row) carries the effort JEV would have chosen; a verdict that arrives later, or none, leaves true.
    const record = { source: 'fallback', shadow: true, ...(captureId ? { captureId } : {}) };
    const work = () => Promise.resolve().then(judge).catch(() => null).then(verdict => {
      if (typeof verdict?.effort === 'string') record.shadow = { effort: verdict.effort, ...(typeof verdict.depth === 'string' ? { depth: verdict.depth } : {}) };
      save(verdict, plan.fallback);
    });
    if (typeof decisions.shadow === 'function') decisions.shadow(`effort.${purpose}:${captureId ?? randomUUID()}`, work); else void work();
    return { reasoning: plan.fallback, record };
  }
  let verdict = null;
  try { verdict = await judge(); } catch { verdict = null; }
  const applied = verdict?.applied === true && typeof verdict.effort === 'string', reasoning = applied ? verdict.effort : plan.fallback;
  const record = { source: applied ? verdict.source ?? 'jev' : 'fallback', ...(verdict?.depth ? { depth: verdict.depth } : {}), ...(verdict?.ledgerId ? { ledgerId: verdict.ledgerId } : {}), ...(!verdict ? { reason: 'no_verdict' } : {}) };
  if (save(verdict, reasoning)) record.captureId = captureId;
  return { reasoning, record };
}
/** Whether this purpose's JEV effort may be sent now: the setting routes this purpose and the point is active, or an
 * RNA_JEV_MODES trial names the point (DecisionService.effortMayApply). */
function mayRoute(decisions, setting, purpose) {
  const route = settingRoutes(setting, purpose);
  return typeof decisions?.effortMayApply === 'function' ? decisions.effortMayApply(purpose, { route }) : route && !SHADOW_ONLY_PURPOSES.includes(purpose);
}
/**
 * The effort of a run resuming after a pause or a checkpoint (review EFF-5): the one its job saved while today's plan
 * would still send it — the same fixed effort, today's own effort, or a routed verdict while this purpose is still
 * routed and the effort is one of the model's levels. Otherwise today's plan (its fixed effort, else its fallback),
 * accepting one cache break: a rollback (routing shadow, mode chat, a project level) reaches in-flight work too.
 * Null when the job saved no effort.
 */
export function resumedReasoning({ decisions, configuration, model, purpose, saved, projectSelection = null } = {}) {
  const effective = saved?.effective;
  if (typeof effective !== 'string') return null;
  const keep = { reasoning: effective, record: { source: saved.source ?? 'resumed', resumed: true } }, setting = internalReasoningSetting(configuration);
  let plan;
  try { plan = internalReasoningPlan(model, { setting: setting.mode, projectSelection }); } catch { return keep; }
  if (plan.mode === 'fixed') return effective === plan.effort ? keep : { reasoning: plan.effort, record: { source: plan.source, resumed: true, replaced: effective } };
  if (effective === plan.fallback) return keep;
  const routed = ['jev', 'rule'].includes(saved.source) && plan.allowed.includes(effective) && mayRoute(decisions, setting, purpose);
  return routed ? keep : { reasoning: plan.fallback, record: { source: 'fallback', resumed: true, replaced: effective } };
}
