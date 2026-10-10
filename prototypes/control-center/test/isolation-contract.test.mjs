import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contract from '../git-isolation/contract.mjs';
import * as engine from '../git-isolation/index.mjs';
import * as env from '../git-isolation/env.mjs';
import * as snapshot from '../git-isolation/snapshot.mjs';
import * as merge from '../git-isolation/merge.mjs';
import * as writer from '../git-isolation/writer.mjs';
import * as records from '../git-isolation/records.mjs';
import * as rollback from '../git-isolation/rollback.mjs';
import { RootResolver, noExecRunning } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { SessionWorktreeService } from '../session-worktree-service.mjs';
import { TurnCheckpoint } from '../turn-checkpoint.mjs';
import { GitInitService } from '../git-init-service.mjs';

// The 0.63 isolation contract (git-isolation/CONTRACT.md): the names other teams code against stay put while the
// owners fill in the bodies. Owners may add exports and must keep these.

const methods = (Class, names) => { for (const name of names) assert.equal(typeof Class.prototype[name], 'function', `${Class.name}#${name}`); };

test('the release gate is one exported constant, opened by the lead after the desktop walk-through', () => {
  assert.equal(contract.ISOLATION_READY, true);
  assert.equal(engine.ISOLATION_READY, contract.ISOLATION_READY, 'index re-exports the same constant');
  assert.ok(contract.ISOLATION_REASONS.includes('not_ready'));
});

test('engine, roots, worktrees, sessions, checkpoints and git init keep their contract names', () => {
  methods(engine.IsolationEngine, ['isolation', 'snapshot', 'pin', 'merge', 'apply', 'diff3', 'take', 'fileSha256', 'resolved', 'rollback', 'rollbackTurn', 'applies', 'applyDetail', 'applyPatches', 'recover', 'resolveInterrupted', 'sweep', 'lock']);
  methods(RootResolver, ['rootOf', 'peek', 'invalidate']);
  methods(WorktreeService, ['checkSpace', 'create', 'remove', 'setState', 'record', 'ownerOf', 'list', 'applyWorktree', 'discardWorktree', 'repair', 'rebuild', 'reconcile', 'sweep']);
  methods(SessionWorktreeService, ['ensure', 'syncStart', 'applyAtFinish', 'applyOnHandBack', 'applyIdle', 'answerConflict', 'answerCreate', 'archive', 'unapplied']);
  methods(TurnCheckpoint, ['start', 'end', 'attributable']);
  methods(GitInitService, ['init', 'preview', 'confirm']);
  for (const [module, names] of [[env, ['globalExcludesFile', 'engineArgs', 'gitVersion', 'versionAtLeast', 'customDrivers', 'eligibility', 'worktreeEnv', 'verifyGitFile']], [snapshot, ['privateIndexPath', 'snapshot', 'commitTree', 'pin']], [merge, ['merge', 'parseMergeTree', 'preview', 'show']], [writer, ['checkWritePath', 'write']], [records, ['beginApply', 'settleApply', 'applyRows', 'applyView', 'recoverApplies', 'retention']], [rollback, ['planRollback', 'RollbackTokens']]]) {
    for (const name of names) assert.equal(typeof module[name], 'function', name);
  }
});

test('constructors only keep their options, so services can be built and wired before their bodies exist', () => {
  const store = { state: { projects: [], sessions: [] } }, execRunning = () => 2;
  assert.equal(new engine.IsolationEngine(store, { execRunning }).execRunning('p'), 2);
  assert.equal(new RootResolver(store, { execRunning }).execRunning('p'), 2);
  assert.equal(new RootResolver(store).execRunning('p'), 0);
  assert.equal(noExecRunning('anything'), 0);
  for (const Service of [WorktreeService, SessionWorktreeService, TurnCheckpoint, GitInitService]) assert.equal(new Service(store).store, store);
});

test('an unfilled stub says so with a 501 not_implemented', () => {
  const error = contract.notImplemented('X.y');
  assert.equal(error.status, 501);
  assert.equal(error.code, 'not_implemented');
  assert.match(error.message, /X\.y/);
  assert.equal(contract.ISOLATION_ERRORS.not_implemented, 501);
});

test('folder names, hidden refs and merge labels have one spelling', () => {
  assert.equal(contract.shortId('agent-1a2b3c4d5e6f'), '1a2b3c4d');
  assert.equal(contract.shortId('9f8e-7d6c-5b4a'), '9f8e7d6c');
  assert.equal(contract.worktreeName('session', 'abcdef0123'), 's-abcdef01');
  assert.equal(contract.worktreeName('worker', 'agent-0011223344', 2), 'w-00112233-2');
  assert.equal(contract.worktreeName('background', 'act_42'), 'b-act42');
  assert.throws(() => contract.worktreeName('orphan', 'x'), TypeError);
  assert.equal(contract.WORKTREE_DIR, '.rna/worktrees.nosync');
  assert.equal(contract.REFS.worktree('wt1', 'seed'), 'refs/rna/wt/wt1/seed');
  assert.equal(contract.REFS.apply('a1'), 'refs/rna/apply/a1');
  assert.equal(contract.REFS.turn('t1'), 'refs/rna/turn/t1');
  assert.equal(contract.REFS.orphan('w-1'), 'refs/rna/wt/orphan-w-1/tip');
  assert.equal(contract.REFS.merge('abc12345', 'current'), 'refs/rna/m/abc12345/current');
  for (const name of ['worktree', 'apply', 'turn', 'merge']) assert.ok(contract.REFS[name]('x', 'y').startsWith(contract.REFS.root));
  assert.deepEqual(contract.MERGE_LABELS.worker('agent-0011223344'), { current: 'current', incoming: 'incoming-worker-00112233' });
  assert.deepEqual(contract.MERGE_LABELS.reverseMarkers(), { current: 'this-conversation', incoming: 'project-folder' });
});

test('only this merge\'s marker lines count as left over', () => {
  const mid = 'abc12345';
  assert.equal(contract.hasMergeMarkers('a\n<<<<<<< refs/rna/m/abc12345/current\nx\n', mid), true);
  assert.equal(contract.hasMergeMarkers('a\r\n>>>>>>> refs/rna/m/abc12345/incoming-worker-1\r\n', mid), true);
  assert.equal(contract.hasMergeMarkers('<<<<<<< refs/rna/m/ffff0000/current\n', mid), false, 'another merge');
  assert.equal(contract.hasMergeMarkers('<<<<<<< HEAD\n=======\n>>>>>>> theirs\n', mid), false, 'the user\'s own markers');
  assert.equal(contract.hasMergeMarkers('  <<<<<<< refs/rna/m/abc12345/current', mid), false, 'only at the start of a line');
  assert.throws(() => contract.hasMergeMarkers('', '../x'), TypeError);
});

test('conflict kinds, statuses and cards are closed lists the web mirrors', () => {
  for (const kind of contract.USER_ONLY_CONFLICTS) assert.ok(contract.CONFLICT_KINDS.includes(kind));
  for (const kind of contract.TEXT_CONFLICT_KINDS) assert.ok(contract.CONFLICT_KINDS.includes(kind));
  for (const [key, kind] of Object.entries(merge.MERGE_TREE_KINDS)) { assert.match(key, /^CONFLICT \(/); assert.ok(contract.CONFLICT_KINDS.includes(kind)); }
  assert.deepEqual(contract.WRITE_MODES, ['all', 'partial', 'markers']);
  assert.ok(Object.isFrozen(contract.HOST_CARDS.sessionConflict.options));
  assert.equal(contract.HOST_CARDS.sessionConflict.actionId('t1'), 'worktree-apply:t1');
  assert.equal(contract.HOST_CARDS.backgroundConflict.actionId('act'), 'act-merge');
  assert.equal(contract.HOST_CARDS.interrupted.actionId('a1'), 'apply-interrupted:a1');
  for (const [code, status] of Object.entries(contract.ISOLATION_ERRORS)) { assert.match(code, /^[a-z][a-z0-9_]{0,63}$/); assert.ok(Number.isInteger(status) && status >= 400 && status < 600, code); }
  assert.ok(contract.DEPENDENCY_FILES.includes('package-lock.json'));
});

test('the web types name the same kinds, reasons and statuses as the host', () => {
  const types = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/src/api/types.ts'), 'utf8');
  const union = name => { const match = new RegExp(`export type ${name} = ([^\\n]+)`).exec(types); assert.ok(match, name); return [...match[1].matchAll(/'([a-z_]+)'/g)].map(item => item[1]); };
  assert.deepEqual(union('ConflictKind'), [...contract.CONFLICT_KINDS]);
  assert.deepEqual(union('IsolationReason'), [...contract.ISOLATION_REASONS]);
  assert.deepEqual(union('TurnApplyStatus'), [...contract.TURN_APPLY_STATUSES]);
  assert.deepEqual(union('SubagentMergeStatus'), [...contract.MERGE_STATUSES]);
});

test('model-facing texts are English, fixed, and the feedback is the JSON the design gives', () => {
  const english = text => assert.doesNotMatch(text, /[㐀-鿿]/u);
  english(contract.MODEL_TEXT.workerContext);
  english(contract.MODEL_TEXT.backgroundIsolatedForeground);
  english(contract.MODEL_TEXT.startSyncConflicts(['a.md']));
  const feedback = JSON.parse(contract.MODEL_TEXT.worktreeApplyFeedback({ mid: 'abc12345', files: ['章节/一.md'], nonText: [{ path: 'cover.png', kind: 'binary' }] }));
  assert.deepEqual(Object.keys(feedback), ['observation', 'files', 'nonText', 'nextStep']);
  assert.match(feedback.observation, /refs\/rna\/m\/abc12345\//);
  assert.deepEqual(feedback.files, ['章节/一.md']);
  english(feedback.observation); english(feedback.nextStep);
  const reminder = JSON.parse(contract.MODEL_TEXT.workerMergeReminder([{ agentId: 'agent-1', status: 'conflict', conflicts: [{ path: 'a.js', kind: 'content' }] }, { agentId: 'agent-2', status: 'pending' }, { agentId: 'agent-3', status: 'pending', reason: 'unfinished', conflicts: [] }]));
  assert.deepEqual(reminder.workers, [{ agentId: 'agent-1', status: 'conflict', conflicts: ['a.js'] }, { agentId: 'agent-2', status: 'pending' }, { agentId: 'agent-3', status: 'pending', reason: 'unfinished' }]);
  english(reminder.observation); english(reminder.nextStep); assert.match(reminder.nextStep, /reason unfinished did not finish its task/);
  for (const status of contract.MERGE_STATUSES) english(contract.MODEL_TEXT.mergeNotice({ status, agentId: 'agent-1', applied: ['a.js'], conflicts: [{ path: 'b.js', kind: 'content' }] }));
  assert.match(contract.MODEL_TEXT.mergeNotice({ status: 'conflict', agentId: 'agent-1', applied: ['a.js'], conflicts: [{ path: 'b.js', kind: 'content' }] }), /agent_merge\(\{"agentId":"agent-1"\}\)/);
  assert.match(contract.MODEL_TEXT.mergeNotice({ status: 'pending', agentId: 'agent-1', pendingReason: 'read_only' }), /no longer writable/);
  assert.equal(contract.MODEL_TEXT.mergeNotice({ status: 'unknown', agentId: 'agent-1' }), '');
});
