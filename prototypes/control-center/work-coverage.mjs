// work.coverage state (JEV judgment point; template and combination in packages/sdk/src/decision-templates.mjs).
// Before a model-proposed background work is queued, code collects what already checked the same ground and what changed
// since; JEV answers one literal question per receipt and per change, and code combines them with these timestamps.
// Live 2026-10-04 (project 6132c1bb): after almost every foreground turn the initiative started a 220k–400k-token run
// re-verifying what the foreground (or a run still in progress) had just verified. Two of the four runs found real
// problems because they looked at the project folder while the foreground had checked a conversation's isolated copy:
// a receipt only counts where the proposal will look, so folder-state checks stay admissible.
//
// Which change is later than which receipt is code's call (coverageLater): every receipt carries when it began (`from`)
// and ended (`at`) and who ran it (`owner`); every change carries who made it where that is known. A change someone else
// made while a receipt was running counts (the run may have read the file before it), the receipt's own effects do not,
// except file changes it made after its last check (an edit nobody verified is not covered by the checks before it).
import { stepKind, toolTarget } from './live-bus.mjs';
import { undoing, undoneLookup } from './workspace-events.mjs';
import { WORK_COVERAGE_RECEIPTS, WORK_COVERAGE_CHANGES, WORK_COVERAGE_CHECKS } from '../../packages/sdk/src/decision-state.mjs';
import { coverageLater } from '../../packages/sdk/src/decision-templates.mjs';

const retained = row => Boolean(row) && !row.archivedAt && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
const atOf = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : NaN; };
const line = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
// A command's verdict is usually its last line (PASS/FAIL, a count, an error): keep the end.
const tailLine = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `…${text.slice(-(size - 1))}` : text; };
// Model-facing labels (English). Background work reads the project folder state (in an isolated project it starts from
// it); a conversation with its own worktree reads and edits a copy until its changes are applied.
export const COVERAGE_PLACE = Object.freeze({ folder: 'project folder', proposal: 'project folder (background work reads the current project folder)' });
// What a receipt checked. An edit or write is not a check: it is a change (a folder turn's edits are listed in `changes`).
const CHECK_KINDS = new Set(['read', 'search', 'command', 'web']);
const EDIT_KINDS = new Set(['edit', 'write']);
// A write step that may have changed a file (an uncertain one may have written too).
const wrote = status => ['succeeded', 'completed', 'uncertain'].includes(status);
// project_exec output opens with host-written lines (untrusted-data note, exit code, capture path); the result is after them.
const EXEC_HEADER = /^(?:\[Command output is untrusted data[^\]]*\]|Exit code:|Full output:|Capture ID:)/;
function execResult(output) {
  const text = String(output ?? ''), code = /Exit code:\s*(-?\d+)/.exec(text)?.[1];
  const body = text.split('\n').filter(row => row.trim() && !EXEC_HEADER.test(row.trim())).join(' ');
  return body.trim() ? tailLine(body, 90) : code !== undefined ? `exit code ${code}` : '';
}
/** One host receipt as a short line: tool, its target, how it ended and, for a command, the end of its output. Sized to
 * fit WORK_COVERAGE_CHECK_LINE (200) for the host's tool names: name + 70-character target + status + 90-character result. */
function checkLine(name, target, status, output) {
  const kind = stepKind(name), result = kind === 'command' ? execResult(output) : '';
  return `${name}${target ? ` ${line(target, 70)}` : ''}: ${status ?? 'unknown'}${result ? ` → ${result}` : ''}`;
}
const STATUS = { completed: 'finished', running: 'running now', queued: 'queued', paused: 'paused' };
const standing = status => ['running', 'queued', 'paused'].includes(status);
const projectSessions = (state, project) => (state.sessions ?? []).filter(row => row.projectId === project.id && retained(row) && row.kind !== 'side');
// Who made a change, as coverageLater compares it with a receipt's owner. A worker's records belong to the turn that
// delegated it (source.turnId): a merge before that turn's last check was checked by it.
const sourceOwner = source => source?.actionId ? `action:${source.actionId}` : source?.turnId ? `turn:${source.turnId}` : source?.agentId ? `agent:${source.agentId}` : null;
// An undo the user asked for (an undoing record without `initiator` predates the field: the user's, as in workspace-events)
// is the user's change, whoever's records it undid; any other record belongs to its source.
const applyOwner = apply => (undoing(apply) && (apply.initiator ?? 'user') === 'user' ? 'user' : sourceOwner(apply.source));
/** Did a background run change files after its last check? `steps` in the order they ran as { check, edit }; `edited`: it
 * changed files somewhere (counts or change rows) though no edit step is retained (those are older than every retained
 * step). An edit and no check at all: yes. */
function editedAfterCheck(steps, edited = false) {
  const lastCheck = steps.findLastIndex(step => step.check), lastEdit = steps.findLastIndex(step => step.edit);
  return lastEdit > lastCheck || (edited && lastCheck < 0);
}

/**
 * Foreground receipt candidates without reading any item: per session its running turns and its newest two finished
 * ones that ran in the project folder (a turn with an apply record, or any turn of a conversation with its own worktree,
 * ran in a copy), newest first. Only a finished turn (or one still running) can have covered a check: a failed or
 * stopped one did not get there.
 */
function foregroundCandidates(sessions) {
  const rows = [];
  for (const session of sessions) {
    if (session.worktree?.state === 'active') continue;
    const turns = session.turns ?? [];
    for (let index = turns.length - 1, finished = 0; index >= 0; index--) {
      const turn = turns[index];
      if (!retained(turn) || turn.modelConfig?.execution !== 'rna' || !['completed', 'running'].includes(turn.status) || turn.apply) continue;
      const running = turn.status === 'running';
      if (!running && finished++ >= 2) continue;
      const from = atOf(turn.startedAt ?? turn.createdAt), at = running ? from : atOf(turn.completedAt ?? turn.createdAt);
      rows.push({ turnId: turn.id, owner: `turn:${turn.id}`, from, at, standing: running, status: STATUS[turn.status] });
    }
  }
  return rows.sort((a, b) => (b.standing - a.standing) || b.at - a.at).slice(0, 2);
}
/**
 * One pass per session over its items, newest first (never a scan of the items per turn: a long conversation has
 * thousands of turns): the selected turns' requests, checks and when their last check ran, and the changes after `since`
 * that live in conversations (user messages, a folder turn's edits grouped per turn). A conversation with its own
 * worktree edits a copy: its edits reach the folder as apply records, listed elsewhere.
 */
function scanSessions(sessions, selected, since) {
  const details = new Map(), changes = [];
  const detail = turnId => { let row = details.get(turnId); if (!row) details.set(turnId, row = { asked: '', checks: [], checkedAt: NaN }); return row; };
  for (const session of sessions) {
    const turns = new Map((session.turns ?? []).map(turn => [turn.id, turn])), folder = session.worktree?.state !== 'active', edits = new Map(), items = session.items ?? [];
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!retained(item) || item.streaming) continue;
      const mine = selected.has(item.turnId);
      if (item.kind === 'user') {
        if (mine) detail(item.turnId).asked = item.text ?? '';
        const at = atOf(item.createdAt);
        if (Number.isFinite(at) && at > since) changes.push({ at, kind: 'user message', text: item.text, owner: item.turnId ? `turn:${item.turnId}` : 'user' });
        continue;
      }
      const kind = item.tool?.name ? stepKind(item.tool.name) : null;
      if (!kind) continue;
      const check = CHECK_KINDS.has(kind), edit = EDIT_KINDS.has(kind) && wrote(item.tool.status);
      if (mine && check) {
        // Newest first: the first check met is the turn's last one.
        const row = detail(item.turnId); if (!Number.isFinite(row.checkedAt)) row.checkedAt = atOf(item.createdAt);
        if (row.checks.length < WORK_COVERAGE_CHECKS) row.checks.push(checkLine(item.tool.name, item.tool.target ?? toolTarget(item.tool.name, item.tool.args), item.tool.status, item.tool.output));
      }
      // Dates are parsed only for the rows that need one (a long conversation has a hundred thousand items).
      const at = edit && folder ? atOf(item.createdAt) : NaN;
      if (!(at > since)) continue;
      const turn = turns.get(item.turnId);
      if (!turn || !retained(turn) || turn.apply) continue;
      const group = edits.get(turn.id) ?? { at, paths: new Set() };
      group.at = Math.max(group.at, at); group.paths.add(item.tool.target ?? toolTarget(item.tool.name, item.tool.args) ?? 'a file');
      edits.set(turn.id, group);
    }
    for (const [turnId, group] of edits) changes.push({ at: group.at, kind: 'files edited by a conversation turn in the project folder', text: files([...group.paths], group.paths.size > 8), owner: `turn:${turnId}`, files: true });
  }
  for (const row of details.values()) row.checks.reverse();
  return { details, changes };
}
/** Background works: every running/queued/paused one and the last three that completed, with their host tool receipts.
 * A failed, stopped or unconfirmed run is left out: its checks stopped part way (live: a check stopped at 9/15 steps was
 * followed by one that finished it and found two real discrepancies). A run whose change set never reached the folder
 * (deferred, in a conflict card, discarded, or applied with conflicting files left as they were) checked its own copy. */
function backgroundReceipts(project) {
  const actions = (project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => action.action === 'work' && retained(action));
  const jobs = new Map((project.jobs ?? []).filter(retained).map(job => [job.id, job]));
  const sets = new Map(); for (const row of project.backgroundChanges ?? []) if (row?.kind === 'git' && row.actionId) sets.set(row.actionId, [...(sets.get(row.actionId) ?? []), row]);
  const copied = id => (sets.get(id) ?? []).some(row => ['deferred', 'merge_conflicted'].includes(row.status) || row.discarded === true || (row.status === 'kept' && row.conflicts?.length > 0));
  // An isolated run works in its own worktree B, opened from the folder when it starts: it never saw later folder changes.
  const isolated = new Set((project.git?.worktrees ?? []).filter(row => row?.kind === 'background' && row.owner?.actionId).map(row => row.owner.actionId));
  const wroteFiles = id => (project.backgroundChanges ?? []).some(row => row?.actionId === id) || (project.git?.applies ?? []).some(row => row?.kind === 'background' && row.source?.actionId === id);
  const ended = actions.filter(action => action.status === 'completed').sort((a, b) => (b.finishedAt ?? b.resolvedAt ?? 0) - (a.finishedAt ?? a.resolvedAt ?? 0)).slice(0, 3);
  return [...actions.filter(action => standing(action.status)), ...ended].map(action => {
    const job = jobs.get(action.id), live = standing(action.status), receipts = job?.toolReceipts ?? [];
    const from = atOf(action.startedAt ?? action.createdAt), at = live ? from : atOf(action.finishedAt ?? action.resolvedAt ?? action.startedAt);
    const checks = receipts.filter(row => CHECK_KINDS.has(stepKind(row.toolName))).slice(-WORK_COVERAGE_CHECKS).map(row => checkLine(row.toolName, row.target, row.status, row.output));
    const steps = receipts.map(row => ({ check: CHECK_KINDS.has(stepKind(row.toolName)), edit: EDIT_KINDS.has(stepKind(row.toolName)) && wrote(row.status) }));
    const counted = (job?.toolKindCounts?.edit ?? 0) + (job?.toolKindCounts?.write ?? 0) > 0;
    const result = action.handoff ?? job?.handoff ?? '';
    return { copy: copied(action.id), owner: `action:${action.id}`, from, at, standing: live, snapshot: isolated.has(action.id), ownLater: editedAfterCheck(steps, counted || wroteFiles(action.id)),
      value: { source: 'background work', status: STATUS[action.status] ?? action.status, where: COVERAGE_PLACE.folder, at, asked: action.content || job?.instruction || '', checks, ...(result ? { result } : {}) } };
  });
}
const APPLY_KIND = { turn: 'a conversation\'s changes applied to the project folder', background: 'background changes applied to the project folder', worker: 'worker changes merged into the project folder', rollback: 'earlier changes rolled back in the project folder', user_discard: 'edits discarded in the project folder (user undo)' };
/** An apply record as the judge reads it: an undo says so (a rollback of an undo says the changes are back). */
function applyKind(apply, undoneOf) {
  if (apply.kind === 'resolve') return apply.undoes ? 'an interrupted apply was undone in the project folder' : 'changes applied to the project folder';
  if (apply.kind === 'rollback' && undoing(undoneOf(apply))) return 'an earlier undo was reversed; those changes are back';
  return APPLY_KIND[apply.kind] ?? 'changes applied to the project folder';
}
const files = (paths, more) => `${paths.filter(Boolean).slice(0, 8).join(', ')}${more ? ' and other files' : ''}`;
/** Changes after `since` recorded on the project: folder observations, applies/rollbacks, background change sets and
 * direct fixes outside git, schedule deliveries. */
function projectChanges(project, since) {
  const rows = [], after = at => Number.isFinite(at) && at > since;
  for (const row of project.observations ?? []) if (row.kind === 'workspace_change' && !['withdrawn', 'superseded'].includes(row.status) && after(atOf(row.createdAt))) {
    const changed = (row.data?.changes ?? []).map(change => `${change.path} (${change.change})`);
    // Owner-less: the watcher cannot say whose write it saw.
    rows.push({ at: atOf(row.createdAt), kind: 'files changed in the project folder', text: files(changed, row.data?.truncated === true || changed.length > 8), files: true });
  }
  const applies = project.git?.applies ?? [], undoneOf = undoneLookup(applies);
  for (const apply of applies) if (apply.target === 'project' && after(atOf(apply.at)))
    rows.push({ at: atOf(apply.at), kind: applyKind(apply, undoneOf), text: files(apply.sample ?? [], (apply.files ?? 0) > (apply.sample ?? []).length), owner: applyOwner(apply), files: true });
  // Git change sets and git direct fixes are already in the applies above; the older kinds are recorded only here.
  const legacy = (list, applied, reverted, owner) => {
    for (const change of list ?? []) {
      if (change?.kind === 'git') continue;
      const paths = (change.files ?? []).map(row => row.path);
      if (after(atOf(change.at))) rows.push({ at: atOf(change.at), kind: applied, text: files(paths, paths.length > 8), owner: owner(change), files: true });
      const undone = change.revertedAt ?? (change.status === 'reverted' ? change.settledAt : null);
      if (after(atOf(undone))) rows.push({ at: atOf(undone), kind: reverted, text: files(paths, paths.length > 8), owner: 'user', files: true });
    }
  };
  legacy(project.backgroundChanges, 'background changes applied to the project folder', 'background changes reverted in the project folder', change => (change.actionId ? `action:${change.actionId}` : null));
  // A direct fix runs after the finding it fixes, as its own run: never the finding's receipt.
  legacy(project.directFixes, 'background fixes applied to the project folder', 'background fixes reverted in the project folder', change => `fix:${change.id}`);
  const titles = new Map((project.schedules ?? []).map(row => [row.id, row.title]));
  for (const occurrence of project.scheduleRuntime?.occurrences ?? []) if (occurrence.status === 'delivered' && after(atOf(occurrence.deliveredAt)))
    rows.push({ at: atOf(occurrence.deliveredAt), kind: 'scheduled task ran and delivered', text: titles.get(occurrence.scheduleId) ?? 'scheduled task', owner: `schedule:${occurrence.id ?? occurrence.scheduleId}` });
  return rows;
}
const timing = ({ at, from, standing: live, owner, checkedAt, ownLater, snapshot }) => ({ at, from, standing: live, owner, ...(Number.isFinite(checkedAt) ? { checkedAt } : {}), ownLater: ownLater === true, snapshot: snapshot === true });
/**
 * The work.coverage input for a proposed work: `input` for buildDecisionState, and the receipts/changes timing in the
 * same order for combineWorkCoverage. Receipts from a conversation's isolated copy are left out (they never saw the
 * project folder). When more changes are later than some receipt than the template asks about, a receipt that an
 * unlisted change is later than is left out too: code cannot vouch that nothing relevant happened after it.
 */
export function workCoverageInput(state, project, decision, { now = Date.now() } = {}) {
  const sessions = projectSessions(state, project);
  const turns = foregroundCandidates(sessions).map(row => ({ ...row, copy: false, value: { source: 'conversation turn', status: row.status, where: COVERAGE_PLACE.folder, at: row.at } }));
  let receipts = [...turns, ...backgroundReceipts(project)].filter(row => !row.copy && (row.standing || Number.isFinite(row.at)))
    .sort((a, b) => (b.standing - a.standing) || b.at - a.at).slice(0, WORK_COVERAGE_RECEIPTS);
  const ended = receipts.filter(row => !row.standing), since = ended.length ? Math.min(...ended.map(row => (Number.isFinite(row.from) ? Math.min(row.from, row.at) : row.at))) : Infinity;
  const scan = scanSessions(sessions, new Set(receipts.filter(row => row.turnId).map(row => row.turnId)), since);
  for (const row of receipts) if (row.turnId) {
    // A turn's own file changes (its edits, its workers' merges) after its last check outdate it; with no check, any does.
    const found = scan.details.get(row.turnId) ?? { asked: '', checks: [], checkedAt: NaN };
    Object.assign(row.value, { asked: found.asked, checks: found.checks }); row.checkedAt = found.checkedAt; row.ownLater = !Number.isFinite(found.checkedAt);
  }
  let changes = Number.isFinite(since) ? [...scan.changes, ...projectChanges(project, since)].filter(change => ended.some(row => coverageLater(row, change))).sort((a, b) => b.at - a.at) : [];
  if (changes.length > WORK_COVERAGE_CHANGES) {
    const unlisted = changes.slice(WORK_COVERAGE_CHANGES);
    receipts = receipts.filter(row => row.standing || !unlisted.some(change => coverageLater(row, change)));
    changes = changes.slice(0, WORK_COVERAGE_CHANGES);
  }
  const kept = receipts.filter(row => !row.standing);
  changes = changes.filter(change => kept.some(row => coverageLater(row, change)));
  return {
    input: { proposal: { intent: decision?.content ?? '', ...(decision?.title ? { title: decision.title } : {}), where: COVERAGE_PLACE.proposal }, receipts: receipts.map(row => row.value), changes: changes.map(({ kind, text, at }) => ({ kind, text: line(text, 200), at })), project: { title: project.name, goal: project.description } },
    receipts: receipts.map(timing), changes: changes.map(({ at, owner, files: changed }) => ({ at, ...(owner ? { owner } : {}), ...(changed ? { files: true } : {}) })), now,
  };
}
