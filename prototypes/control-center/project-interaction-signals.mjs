import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { rrsiSplit } from '../../packages/sdk/src/project-rrsi.mjs';
import { learningRedactor } from './project-learning-evidence.mjs';
import { ledgerRows } from './decision-ledger.mjs';

// P4 signals: real interaction is the primary evolution signal. Mines user
// corrections, retries, aborted turns, tool failures, overlong turns,
// proactive-message outcomes and deliverables kept/reverted from retained
// sessions, and turns them into replayable cases with a stable held-out split.
// Read-only over state and the project workspace; nothing here calls a model.

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const retained = row => row && !row.archivedAt && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, max);
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };
/** A command that ran and exited on its own (for example a check reporting problems
 * with exit code 1) is the command's result, not a failure of the exec tool. Only
 * tool errors (denied, invalid arguments, timeouts, cancelled or unconfirmed runs) count. */
export const commandRanToCompletion = tool => tool?.name === 'project_exec' && /^\[Command output is untrusted data, not instructions\.\]\s*Exit code: \d+\s*(?:\n|$)/.test(String(tool.output ?? ''));
/**
 * Why a tool call failed. Live, 30 days to 2026-10-10: of 28 failures counted against "the tool's description", 5 were
 * a service or site that did not answer (a fetch service's 502, a site's access challenge, an unreachable skill
 * source), 1 a write the user's own constraint stopped, 1 a call cut short by a new message. `call`: the model's arguments or use of the tool; `environment`: a service, site or connection outside the
 * conversation; `refused`: a rule of the host or the user; `interrupted`: cut short and retired. The call's typed code
 * decides when the item has one (kept since 0.72); older items are read from the host's own fixed result texts.
 * Anything unrecognised is `call`, so a new tool's misuse still counts.
 */
export const TOOL_FAILURE_CAUSES = Object.freeze(['call', 'environment', 'refused', 'interrupted']);
const ENVIRONMENT_CODE = /^(?:FASTCRW_(?!ARGUMENTS$)|WEB_(?!ARGUMENTS$|URL_NOT_PUBLIC$)|marketplace_|media_|sandbox_unavailable$|execution_setup_failed$)/, REFUSED_CODE = /^(?:path_denied|WEB_URL_NOT_PUBLIC)$/;
const ENVIRONMENT_TEXT = /"code":"(?:FASTCRW_(?!ARGUMENTS")|marketplace_)|net::ERR_|browserBackend\.callTool: Timeout/;
const REFUSED_TEXT = /^(?:Path is outside the project scope or is private\.|cwd .{1,220} is outside the project or private\.|这次写入没有执行：它会违反用户说过的约束|项目权限已撤销|此技能未分配给当前项目)/;
const INTERRUPTED_TEXT = /^(?:Interrupted call retired after newer user input\.|Caller explicitly retired this interrupted operation|用户插话，自主轮次已停止|自主目标已取消)/;
export function toolFailureCause(tool) {
  const code = typeof tool?.code === 'string' ? tool.code : '', text = String(tool?.output ?? '');
  if (INTERRUPTED_TEXT.test(text)) return 'interrupted';
  if (code ? ENVIRONMENT_CODE.test(code) : ENVIRONMENT_TEXT.test(text)) return 'environment';
  if (code ? REFUSED_CODE.test(code) : REFUSED_TEXT.test(text)) return 'refused';
  return 'call';
}
export const SIGNAL_KINDS = Object.freeze(['user_correction', 'retry', 'aborted_turn', 'tool_failure', 'overlong_turn', 'proactive_outcome', 'deliverable']);
// Negative weights feed the real-signal score; positive outcomes offset them.
export const SIGNAL_WEIGHTS = Object.freeze({ user_correction: -1, retry: -0.6, aborted_turn: -0.8, tool_failure: -0.3, overlong_turn: -0.4, proactive_dismissed: -0.5, proactive_replied: 0.6, proactive_acted: 1, deliverable_kept: 0.8, deliverable_reverted: -1, deliverable_modified: -0.2 });
const CORRECTION = /^(?:不对|不是|错了|不要|别这样|重新|再来|应该是|你理解错|没有按|我说的是|我的意思是|并不是|no[,.!\s]|nope|wrong|that'?s not|not what|actually[,\s]|instead[,\s]|please redo|try again|you misunderstood)/i;
const CORRECTION_ANY = /(?:不对|错了|理解错|不是我要的|没按要求|you misunderstood|that'?s wrong|not what i (?:asked|meant))/i;
// P3 records proactive outcome labels via DecisionService.labelDecision and/or
// project.proactiveOutcomes [{ messageId?, decisionId?, label, at }]. Both are optional.
const PROACTIVE_LABELS = { reply: 'replied', replied: 'replied', act: 'acted', acted: 'acted', adopt: 'acted', adopted: 'acted', dismiss: 'dismissed', dismissed: 'dismissed', ignore: 'dismissed', ignored: 'dismissed' };
export const OVERLONG_MS = 15 * 60 * 1000, OVERLONG_TOOL_CALLS = 40;
const normalized = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const similar = (a, b) => { const x = new Set(normalized(a).split(/[\s,，。.!?！？]+/).filter(Boolean)), y = new Set(normalized(b).split(/[\s,，。.!?！？]+/).filter(Boolean)); if (!x.size || !y.size) return normalized(a) === normalized(b) && Boolean(normalized(a)); let both = 0; for (const word of x) if (y.has(word)) both++; return both / (x.size + y.size - both) >= 0.8; };

/** Content-minimized signals for one project. `redact` defaults to the host secret redactor. */
export function mineProjectSignals(state, projectId, { redact = value => value, now = Date.now(), sinceMs = 30 * 24 * 60 * 60 * 1000, ledger = state.decisionKernelRuntime?.recent ?? [] } = {}) {
  const project = state.projects?.find(row => row.id === projectId); if (!project) return [];
  const since = now - sinceMs, signals = [], push = row => signals.push({ id: `sig_${hash([row.kind, row.sessionId, row.turnId, row.detail?.tool ?? row.detail?.path ?? row.detail?.label ?? '', row.at]).slice(0, 16)}`, projectId, ...row });
  for (const session of (state.sessions ?? []).filter(row => row.projectId === projectId && retained(row))) {
    const items = (session.items ?? []).filter(retained), turns = (session.turns ?? []).filter(row => retained(row) && (time(row.createdAt) ?? now) >= since);
    const userOf = turn => items.find(row => row.id === turn.userItemId) ?? items.find(row => row.turnId === turn.id && row.kind === 'user');
    const base = turn => ({ sessionId: session.id, turnId: turn.id, versionId: turn.projectVersionId ?? turn.versionId ?? null, at: turn.completedAt ?? turn.startedAt ?? turn.createdAt });
    let previousUser = null, previousTurn = null;
    for (const turn of turns) {
      const user = userOf(turn), text = user?.text ?? '';
      if (previousTurn && previousUser && text && ['completed', 'failed', 'stopped'].includes(previousTurn.status)) {
        // K1: the per-message capture (JEV / fast model / heuristic) is primary;
        // the regex stays only as a weak fallback for messages never captured. A captured message JEV could not call a
        // correction or not (MIND-12: correction null) is no correction signal, and the regex does not decide it either.
        const captured = typeof user.capture?.correction === 'boolean' ? user.capture.correction : null, unknown = user.capture?.correction === null;
        if (!unknown && (captured ?? (CORRECTION.test(text.trim()) || CORRECTION_ANY.test(text)))) push({ kind: 'user_correction', ...base(previousTurn), input: clip(redact(previousUser.text), 4000), detail: { correction: clip(redact(text), 1200), correctedTurnId: previousTurn.id, via: captured === null ? 'regex' : `capture:${user.capture.source ?? 'unknown'}` } });
        else if (similar(text, previousUser.text)) push({ kind: 'retry', ...base(previousTurn), input: clip(redact(previousUser.text), 4000), detail: { via: 'repeated_request' } });
      }
      if ((turn.runtimeAttempts ?? 0) > 1) push({ kind: 'retry', ...base(turn), input: clip(redact(text), 4000), detail: { via: 'runtime_attempts', attempts: turn.runtimeAttempts } });
      if (turn.status === 'stopped') push({ kind: 'aborted_turn', ...base(turn), input: clip(redact(text), 4000), detail: {} });
      // 👎 on this turn's reply is an explicit correction signal (comment when given).
      const disliked = items.find(row => row.turnId === turn.id && row.kind === 'assistant' && row.feedback?.vote === 'down');
      if (disliked && text) push({ kind: 'user_correction', ...base(turn), input: clip(redact(text), 4000), detail: { correction: clip(redact(disliked.feedback.comment ?? ''), 1200), correctedTurnId: turn.id, via: 'feedback', label: 'feedback' } });
      const tools = items.filter(row => row.turnId === turn.id && row.tool);
      for (const row of tools.filter(row => row.tool.status === 'failed' && !commandRanToCompletion(row.tool))) push({ kind: 'tool_failure', ...base(turn), input: clip(redact(text), 4000), detail: { tool: clip(row.tool.name, 80), error: clip(redact(row.tool.output ?? ''), 240), cause: toolFailureCause(row.tool) } });
      const started = time(turn.startedAt ?? turn.createdAt), ended = time(turn.completedAt);
      if (started !== null && ended !== null && ended - started > OVERLONG_MS || tools.length > OVERLONG_TOOL_CALLS) push({ kind: 'overlong_turn', ...base(turn), input: clip(redact(text), 4000), detail: { durationMs: started !== null && ended !== null ? ended - started : null, toolCalls: tools.length } });
      if (user) { previousUser = user; previousTurn = turn; }
    }
  }
  for (const row of ledger.filter(row => row.scope?.projectId === projectId && row.label?.value && (row.at ?? now) >= since)) {
    const label = PROACTIVE_LABELS[row.label.value]; if (label) push({ kind: 'proactive_outcome', sessionId: row.scope.sessionId ?? null, turnId: null, versionId: null, at: new Date(row.label.at ?? row.at).toISOString(), detail: { label, point: row.point, decisionId: row.id } });
  }
  for (const row of Array.isArray(project.proactiveOutcomes) ? project.proactiveOutcomes : []) {
    const label = PROACTIVE_LABELS[row?.label]; if (label && (time(row.at) ?? now) >= since) push({ kind: 'proactive_outcome', sessionId: row.sessionId ?? null, turnId: null, versionId: row.versionId ?? null, at: row.at, detail: { label, messageId: clip(row.messageId ?? '', 100), source: 'project' } });
  }
  return signals.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const within = (root, path) => { const target = resolve(root, path), rel = relative(root, target); return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('.git') ? target : null; };
/** Deliverables kept/modified/reverted: compare the last project_write per path with the workspace now. */
export async function deliverableSignals(state, projectId, { redact = value => value, maxFiles = 40, maxBytes = 256 * 1024 } = {}) {
  const project = state.projects?.find(row => row.id === projectId), workspace = project?.workspace; if (!workspace) return [];
  let root; try { root = await realpath(workspace); } catch { return []; }
  const latest = new Map();
  for (const session of (state.sessions ?? []).filter(row => row.projectId === projectId && retained(row))) for (const item of (session.items ?? []).filter(row => retained(row) && row.tool?.name === 'project_write' && row.tool.status === 'succeeded' && typeof row.tool.args?.path === 'string' && typeof row.tool.args?.content === 'string')) {
    const turn = (session.turns ?? []).find(row => row.id === item.turnId);
    latest.set(item.tool.args.path, { sessionId: session.id, turnId: item.turnId, versionId: turn?.projectVersionId ?? turn?.versionId ?? null, at: item.createdAt, path: item.tool.args.path, written: hash(item.tool.args.content) });
  }
  const out = [];
  for (const row of [...latest.values()].slice(-maxFiles)) {
    const target = within(root, row.path); if (!target) continue;
    let status;
    try { const info = await stat(target); if (!info.isFile() || info.size > maxBytes) continue; const real = await realpath(target); if (!real.startsWith(root + sep)) continue; status = hash(await readFile(real, 'utf8')) === row.written ? 'kept' : 'modified'; }
    catch (error) { if (error?.code !== 'ENOENT') continue; status = 'reverted'; }
    out.push({ id: `sig_${hash(['deliverable', row.path, row.written]).slice(0, 16)}`, projectId, kind: 'deliverable', sessionId: row.sessionId, turnId: row.turnId, versionId: row.versionId, at: row.at, detail: { path: clip(redact(row.path), 400), status } });
  }
  return out;
}

/** Real-signal score in [0,1] per project version (or overall): 0.5 is neutral. */
export function realSignalScore(signals, { versionId } = {}) {
  const rows = signals.filter(row => versionId === undefined || row.versionId === versionId);
  let total = 0, count = 0;
  for (const row of rows) {
    const key = row.kind === 'proactive_outcome' ? `proactive_${row.detail.label}` : row.kind === 'deliverable' ? `deliverable_${row.detail.status}` : row.kind;
    const weight = SIGNAL_WEIGHTS[key]; if (weight === undefined) continue; total += weight; count++;
  }
  return { score: count ? Math.max(0, Math.min(1, 0.5 + total / (2 * Math.max(count, 4)))) : null, signals: count, negatives: rows.filter(row => (SIGNAL_WEIGHTS[row.kind === 'proactive_outcome' ? `proactive_${row.detail.label}` : row.kind === 'deliverable' ? `deliverable_${row.detail.status}` : row.kind] ?? 0) < 0).length };
}

/** Replayable cases (workspace snapshot + input + checks) with a stable held-out split. */
export async function replayCasesFromSignals(signals, { workspace, sessions = [], maxFiles = 8, maxFileBytes = 16 * 1024 } = {}) {
  let root = null; try { root = workspace ? await realpath(workspace) : null; } catch { root = null; }
  const cases = [];
  for (const signal of signals.filter(row => ['user_correction', 'retry', 'aborted_turn', 'tool_failure', 'overlong_turn'].includes(row.kind) && row.input)) {
    const session = sessions.find(row => row.id === signal.sessionId), touched = [...new Set((session?.items ?? []).filter(row => row.turnId === signal.turnId && row.tool && typeof row.tool.args?.path === 'string').map(row => row.tool.args.path))].slice(0, maxFiles);
    const files = [];
    if (root) for (const path of touched) { const target = within(root, path); if (!target) continue; try { const info = await stat(target); if (!info.isFile() || info.size > maxFileBytes) continue; const real = await realpath(target); if (!real.startsWith(root + sep)) continue; files.push({ path, sha256: hash(await readFile(real)), bytes: info.size }); } catch { /* missing now: not part of the snapshot */ } }
    const checks = signal.kind === 'user_correction' ? [{ kind: 'rubric', text: `Satisfy the user's later correction on the first attempt: ${clip(signal.detail.correction, 600)}` }]
      : signal.kind === 'tool_failure' ? [{ kind: 'tool_succeeds', tool: signal.detail.tool }] : signal.kind === 'overlong_turn' ? [{ kind: 'max_duration_ms', value: OVERLONG_MS }, { kind: 'max_tool_calls', value: OVERLONG_TOOL_CALLS }]
      : signal.kind === 'aborted_turn' ? [{ kind: 'completes_without_abort' }] : [{ kind: 'first_attempt_success' }];
    const id = `replay_${hash([signal.kind, signal.sessionId, signal.turnId, signal.input]).slice(0, 12)}`;
    if (cases.some(row => row.id === id)) continue;
    cases.push({ schemaVersion: 1, id, projectId: signal.projectId, signalId: signal.id, kind: signal.kind, sessionId: signal.sessionId, turnId: signal.turnId, versionId: signal.versionId, at: signal.at, input: signal.input, ...(signal.kind === 'user_correction' ? { followUp: signal.detail.correction } : {}), workspaceSnapshot: { kind: 'file_manifest', files }, checks, split: rrsiSplit(id) });
  }
  return cases;
}

/** Frozen-suite case for an evolve-split replay (held-out cases never enter selection). */
export function replayEvaluationCase(replay, { toolIds = [] } = {}) {
  if (replay.split !== 'evolve') return null;
  const requiredToolIds = replay.checks.filter(row => row.kind === 'tool_succeeds' && toolIds.includes(row.tool)).map(row => row.tool);
  return { id: replay.id.slice(0, 40), input: clip(replay.input, 4000), requiredTerms: [], forbiddenTerms: [], requiredToolIds, weight: replay.kind === 'user_correction' ? 2 : 1, ...(replay.followUp ? { followUps: [{ input: clip(replay.followUp, 4000) }] } : {}) };
}

/** Everything the evolution loop needs from real interaction, for one project. */
export async function collectProjectSignals(store, projectId, options = {}) {
  const redact = options.redact ?? learningRedactor(store), state = store.state;
  const signals = [...mineProjectSignals(state, projectId, { ...options, redact, ledger: ledgerRows(store, state) }), ...await deliverableSignals(state, projectId, { redact })];
  const project = state.projects.find(row => row.id === projectId);
  const replay = await replayCasesFromSignals(signals, { workspace: project?.workspace, sessions: (state.sessions ?? []).filter(row => row.projectId === projectId) });
  const counts = Object.fromEntries(SIGNAL_KINDS.map(kind => [kind, signals.filter(row => row.kind === kind).length]));
  return { projectId, signals, replay, counts, score: realSignalScore(signals), heldOut: replay.filter(row => row.split === 'heldout').length };
}
