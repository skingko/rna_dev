import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { BuiltinAgentService, mergeLine, rebaseTask } from '../builtin-agent-service.mjs';
import { createAgentRoutes } from '../agent-routes.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { RootResolver } from '../workspace-roots.mjs';
import { WorktreeService } from '../worktree-service.mjs';
import { IsolationEngine, MODEL_TEXT, REFS, hasMergeMarkers } from '../git-isolation/index.mjs';
import { DELEGATE_ISOLATION_TEXT } from '../../../packages/sdk/src/agent-merge.mjs';
import { createWorkspaceTools } from '../../../packages/sdk/src/workspace-tools.mjs';
import { deriveWorkspaceEvents } from '../workspace-events.mjs';

// Worker worktrees and agent_merge (worktree design 0.63 §4.1, §6.1, §6.3, §6.5; protocol §8.6). Real temporary git
// repositories, the real merge engine, root resolver and worktree service (release gate forced open per test); the
// child model is a stand-in session that writes files in the root it was given, so what lands where is checked on
// disk. No network, no model calls, no global git configuration.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitVersionOk = (() => { try { const [, major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38); } catch { return false; } })();
const skip = gitVersionOk ? false : 'git 2.38 or later is needed';
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Rna Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const body = result => JSON.parse(result.content[0].text);
async function until(check, ms = 20000) { const deadline = Date.now() + ms; while (!(await check())) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
const gate = () => { let release; const held = new Promise(done => { release = done; }); return { held, release }; };

/**
 * A child session stand-in for runDelegatedAgent: `work(options, task)` runs in place of the model (it writes files
 * in `options.cwd`, the root the host gave the child) and returns the answer; abort() rejects a pending prompt.
 */
function fakeChild(options, work) {
  const messages = [];
  let stop;
  const stopped = new Promise((_, reject) => { stop = reject; });
  stopped.catch(() => {});
  return {
    snapshot: () => ({ tools: options.readOnly ? [] : ['project_write', 'project_edit'], messages, recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
    async prompt(task) {
      messages.push({ role: 'user', source: 'user', content: task });
      const text = await Promise.race([work(options, task), stopped]);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: text ?? 'Done; the files are written.' }], stopReason: 'stop' });
    },
    async resume() {}, async steer() {}, async dispose() {},
    async abort() { stop(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
  };
}

/**
 * A repository at `<dir>/repo` (P) with `files` committed, a project on it with a running parent turn, and the 0.63
 * services wired as the lead wires them. `work(options, task)` is every child's behaviour; `ready` opens the gate.
 */
function setup(t, { files = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'bee\n' }, repository = true, ready = true, statfs, work = async () => 'Done.', sessionWorktrees = null, prefix = '', factory: real = null, server = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-worker-wt-'))), top = join(dir, 'repo'), P = prefix ? join(top, prefix) : top;
  mkdirSync(P, { recursive: true });
  for (const [path, text] of Object.entries(files)) put(P, path, text);
  if (prefix) put(top, 'outside-the-project.md', 'repository top\n');
  if (repository) { git(top, 'init', '-q'); git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'first'); }
  const store = new Store(join(dir, 'state', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: server ? `http://127.0.0.1:${server.address().port}/v1` : 'http://127.0.0.1:9/v1', apiKey: 'worker-fixture-secret', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Worker worktree fixture', workspace: P, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  const gitService = new WorkspaceGitService(store);
  const engine = new IsolationEngine(store, { git: gitService, ready, sandbox: () => true, pollMs: 5 });
  gitService.engine = engine;
  const roots = new RootResolver(store, { git: gitService });
  const worktrees = new WorktreeService(store, { git: gitService, engine, roots, ...(statfs ? { statfs } : {}) });
  gitService.owners = path => worktrees.ownerOf(path);
  const children = [];
  const factory = async options => { children.push(options); return real ? real(options) : fakeChild(options, work); };
  const make = () => new BuiltinAgentService(store, { engine, roots, worktrees, factory, sessionWorktrees });
  const service = make(), tools = service.createTools({ sessionId: session.id, turnId });
  const tool = name => tools.find(row => row.name === name);
  const delegate = async (task, { id = `call-${Math.random()}`, ...options } = {}) => body(await tool('agent_delegate').execute(id, { task, ...options }, new AbortController().signal));
  const merge = async args => tool('agent_merge').execute(`merge-${Math.random()}`, args, new AbortController().signal);
  const record = id => service.record(session.id, id);
  const settled = async id => { await until(() => record(id)?.status !== 'running' && !service.running.has(id)); return record(id); };
  const item = id => current().items.find(row => row.kind === 'subagent' && row.subagent?.agentId === id);
  const worktree = id => store.state.projects.find(row => row.id === project.id).git?.worktrees?.find(row => row.id === id);
  const applies = () => store.state.projects.find(row => row.id === project.id).git?.applies ?? [];
  t.after(async () => { await service.close(); engine.close(); try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return { dir, top, P, store, session, project, turnId, current, gitService, engine, roots, worktrees, service, make, tools, tool, delegate, merge, record, settled, item, worktree, applies, children };
}

test('a worker runs in its own copy of the parent\'s files and is merged when it ends: files listed, W removed, a checkpointed record', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }, task) => { if (/edit/.test(task)) { put(cwd, 'a.txt', 'one\nTWO by worker\nthree\n'); put(cwd, 'src/new.js', 'export const x = 1;\n'); } return 'Edited a.txt and added src/new.js.'; } });
  put(f.P, 'notes.md', 'the user’s draft, not committed\n');
  const handle = await f.delegate('Please edit the files.', { files: ['a.txt'] });
  assert.equal(handle.status, 'running'); assert.equal(handle.merge, undefined, 'an isolated worker\'s receipt is not shared_root');
  const row = await f.settled(handle.agentId);
  // Where it ran: W, made from P with the user's uncommitted file in it; the sandbox is forced and AGENTS.md is read from P.
  const options = f.children[0];
  assert.match(options.cwd, /\/\.rna\/worktrees\.nosync\/w-/); assert.equal(options.isolated, true); assert.equal(options.instructionsRoot, f.P);
  assert.ok(options.systemPrompt.endsWith(MODEL_TEXT.workerContext), 'the worker hears it works in its own copy');
  assert.equal(row.status, 'completed'); assert.equal(row.merge.status, 'merged'); assert.equal(row.merge.files, 2); assert.equal(row.merge.applyIds.length, 1);
  assert.equal(read(f.P, 'a.txt'), 'one\nTWO by worker\nthree\n'); assert.equal(read(f.P, 'src/new.js'), 'export const x = 1;\n');
  assert.equal(read(f.P, 'notes.md'), 'the user’s draft, not committed\n');
  assert.deepEqual(row.outsideFiles, ['src/new.js'], 'what a worker changed outside its files comes from seed → tip, commands included');
  // The record, the tip ref and the cleaned-up worktree.
  const apply = f.applies().find(item => item.id === row.merge.applyIds[0]);
  assert.equal(apply.kind, 'worker'); assert.equal(apply.state, 'verified'); assert.deepEqual(apply.source, { sessionId: f.session.id, turnId: f.turnId, agentId: handle.agentId, worktreeId: row.worktree.id });
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(row.worktree.id, 'tip')).trim());
  assert.equal(f.worktree(row.worktree.id).state, 'removed'); assert.equal(row.worktree.removed, true);
  assert.equal(git(f.P, 'diff', '--cached', '--name-only'), '', 'the user\'s index is untouched');
  // The card and the notice: merged with its files; the model hears which files and how to undo.
  assert.deepEqual(f.item(handle.agentId).subagent.merge, { status: 'merged', applyIds: row.merge.applyIds, files: 2 });
  assert.equal(f.item(handle.agentId).subagent.worktreeId, undefined, 'no worktree left to look at');
  const notice = f.current().inbox.find(message => message.agentId === handle.agentId);
  assert.ok(notice, 'the result reaches the running parent turn');
  assert.match(notice.text, /Its changes were merged into your files: a\.txt, src\/new\.js\./, 'the host notice carries the merge line');
  assert.match(mergeLine(row), /Its changes were merged into your files: a\.txt, src\/new\.js\. If they are not wanted, agent_merge\(\{"agentId":"agent-[0-9a-f]+","action":"drop"\}\) rolls them back\./);
  const status = body(await f.tool('agent_status').execute('s', { agentId: handle.agentId }, new AbortController().signal));
  assert.equal(status.merge.status, 'merged'); assert.match(status.mergeNote, /merged into your files/); assert.equal(status.worktreeId, undefined);
  // merge again is idempotent: from the pinned tip (W is gone), nothing left to write, no new record.
  const again = body(await f.merge({ agentId: handle.agentId }));
  assert.equal(again.status, 'merged'); assert.deepEqual(again.applied, []); assert.deepEqual(again.conflicts, []);
  assert.equal(f.applies().filter(item => item.kind === 'worker').length, 1);
});

test('two workers change the same lines: the second is merged partly, its conflict comes with a diff3 preview and currentSha256; resolved checks the file', { skip }, async t => {
  const second = gate();
  const f = setup(t, { work: async ({ cwd }, task) => {
    if (/first/.test(task)) { put(cwd, 'a.txt', 'one\ntwo from first\nthree\n'); return 'First done.'; }
    put(cwd, 'a.txt', 'one\ntwo from second\nthree\n'); put(cwd, 'c.txt', 'clean from second\n'); await second.held; return 'Second done.';
  } });
  const one = await f.delegate('The first edit.'), two = await f.delegate('The second edit.');
  assert.equal((await f.settled(one.agentId)).merge.status, 'merged');
  second.release();
  const row = await f.settled(two.agentId);
  assert.equal(row.merge.status, 'conflict'); assert.deepEqual(row.merge.conflicts, [{ path: 'a.txt', kind: 'content' }]); assert.equal(row.merge.files, 1);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo from first\nthree\n', 'no conflict marker in the project folder; its side untouched');
  assert.equal(read(f.P, 'c.txt'), 'clean from second\n', 'the clean part is in');
  assert.equal(f.worktree(row.worktree.id).state, 'conflicted'); assert.ok(existsSync(join(f.P, f.worktree(row.worktree.id).dir)), 'W is kept for the conflict');
  assert.match(mergeLine(row), /Merged 1 file\(s\) into your files; 1 file\(s\) conflict with changes made after it started \(a\.txt\)\. Call agent_merge\(\{"agentId":"agent-[0-9a-f]+"\}\) to resolve them\./);
  // The turn-end reminder (T4) reads this list.
  assert.deepEqual(f.service.pendingMerges(f.session.id), [{ agentId: two.agentId, role: 'worker', task: 'The second edit.', turnId: f.turnId, status: 'conflict', conflicts: [{ path: 'a.txt', kind: 'content' }] }]);
  assert.match(MODEL_TEXT.workerMergeReminder(f.service.pendingMerges(f.session.id)), /"conflicts":\["a\.txt"\]/);
  // agent_merge merge: idempotent, previews labelled with this merge's refs, currentSha256 = the file's sha256.
  const merged = body(await f.merge({ agentId: two.agentId }));
  assert.equal(merged.status, 'conflict'); assert.deepEqual(merged.applied, []);
  const [conflict] = merged.conflicts;
  assert.equal(conflict.path, 'a.txt'); assert.equal(conflict.kind, 'content'); assert.equal(conflict.currentSha256, sha('one\ntwo from first\nthree\n'));
  const mid = f.record(two.agentId).mergeWork.mid;
  assert.ok(hasMergeMarkers(conflict.preview, mid)); assert.match(conflict.preview, new RegExp(`<<<<<<< refs/rna/m/${mid}/current`)); assert.match(conflict.preview, /\|\|\|\|\|\|\| /); assert.match(conflict.preview, new RegExp(`>>>>>>> refs/rna/m/${mid}/incoming-worker-`));
  const shown = body(await f.merge({ agentId: two.agentId, action: 'show', path: 'a.txt' }));
  assert.equal(shown.page, 1); assert.equal(shown.pages, 1); assert.equal(shown.text, conflict.preview);
  // resolved refuses while the file is unchanged, and while a marker line of this merge is left.
  const unchanged = await f.merge({ agentId: two.agentId, action: 'resolved' });
  assert.equal(unchanged.isError, true); assert.equal(unchanged.details.code, 'merge_unresolved'); assert.deepEqual(body(unchanged).remaining, [{ path: 'a.txt', reason: 'unchanged' }]);
  put(f.P, 'a.txt', conflict.preview);
  assert.deepEqual(body(await f.merge({ agentId: two.agentId, action: 'resolved' })).remaining, [{ path: 'a.txt', reason: 'markers' }]);
  // The parent settles it with project_edit, currentSha256 as expectedHash (the merge's CAS); a stale hash writes nothing.
  put(f.P, 'a.txt', 'one\ntwo from first\nthree\n');
  const edit = (await createWorkspaceTools(f.P, { includeMutations: true })).find(row => row.name === 'project_edit');
  const stale = await edit.execute('stale', { path: 'a.txt', oldText: 'two from first', newText: 'x', expectedHash: sha('something else') }, new AbortController().signal);
  assert.equal(stale.isError, true); assert.equal(stale.details.code, 'conflict'); assert.equal(read(f.P, 'a.txt'), 'one\ntwo from first\nthree\n');
  // A user's own `<<<<<<<` line is not this merge's marker.
  assert.equal((await edit.execute('edit', { path: 'a.txt', oldText: 'two from first\n', newText: 'two from first and second\n<<<<<<< not a merge of ours\n', expectedHash: conflict.currentSha256 }, new AbortController().signal)).isError, undefined);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo from first and second\n<<<<<<< not a merge of ours\nthree\n');
  assert.deepEqual(body(await f.merge({ agentId: two.agentId, action: 'resolved' })), { status: 'merged' });
  const after = f.record(two.agentId);
  assert.equal(after.merge.status, 'merged'); assert.equal(after.merge.conflicts, undefined); assert.equal(f.worktree(after.worktree.id).state, 'removed');
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
  const refused = await f.merge({ agentId: two.agentId, action: 'show', path: 'a.txt' });
  assert.equal(refused.details.code, 'merge_path_not_conflicted', 'only listed open conflicts can be shown');
});

test('take keeps one side of listed conflicts only; paths outside the conflict list are refused', { skip }, async t => {
  const second = gate();
  const f = setup(t, { work: async ({ cwd }, task) => {
    if (/first/.test(task)) { put(cwd, 'a.txt', 'one\nfirst\nthree\n'); put(cwd, 'b.txt', 'bee first\n'); return 'First.'; }
    put(cwd, 'a.txt', 'one\nsecond\nthree\n'); put(cwd, 'b.txt', 'bee second\n'); await second.held; return 'Second.';
  } });
  const one = await f.delegate('first'), two = await f.delegate('second');
  await f.settled(one.agentId); second.release();
  const row = await f.settled(two.agentId);
  assert.deepEqual(row.merge.conflicts.map(item => item.path).sort(), ['a.txt', 'b.txt']);
  const outside = await f.merge({ agentId: two.agentId, action: 'take', take: [{ path: 'README.md', side: 'incoming' }] });
  assert.equal(outside.details.code, 'merge_path_not_conflicted'); assert.equal(read(f.P, 'a.txt'), 'one\nfirst\nthree\n');
  const taken = body(await f.merge({ agentId: two.agentId, action: 'take', take: [{ path: 'a.txt', side: 'incoming' }] }));
  assert.equal(taken.status, 'conflict'); assert.deepEqual(taken.taken, [{ path: 'a.txt', side: 'incoming' }]); assert.deepEqual(taken.applied, ['a.txt']);
  assert.deepEqual(taken.conflicts.map(item => item.path), ['b.txt']);
  assert.equal(read(f.P, 'a.txt'), 'one\nsecond\nthree\n');
  const resolve = f.applies().find(item => item.kind === 'resolve');
  assert.equal(resolve.source.agentId, two.agentId); assert.equal(resolve.state, 'verified');
  const kept = body(await f.merge({ agentId: two.agentId, action: 'take', take: [{ path: 'b.txt', side: 'current' }] }));
  assert.equal(kept.status, 'merged'); assert.deepEqual(kept.applied, []); assert.equal(read(f.P, 'b.txt'), 'bee first\n');
  assert.equal(f.record(two.agentId).merge.status, 'merged'); assert.equal(f.worktree(f.record(two.agentId).worktree.id).state, 'removed');
});

test('drop rolls a merged worker back three-way (later edits kept) and removes an unmerged worker\'s copy', { skip }, async t => {
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'a.txt', 'one\ntwo by worker\nthree\n'); put(cwd, 'new.txt', 'created\n'); return 'Done.'; } });
  const one = await f.delegate('edit');
  // agent_wait returns once the merge is done (design §4.1 step 3): its answer already says merged.
  const waited = body(await f.tool('agent_wait').execute('w', { agentIds: [one.agentId], timeoutSeconds: 30 }, new AbortController().signal));
  assert.equal(waited.timedOut, false); assert.equal(waited.agents[0].status, 'completed'); assert.equal(waited.agents[0].merge.status, 'merged');
  assert.equal(read(f.P, 'new.txt'), 'created\n');
  const row = f.record(one.agentId);
  assert.equal(row.merge.status, 'merged');
  put(f.P, 'b.txt', 'bee edited by the user later\n');
  const dropped = body(await f.merge({ agentId: one.agentId, action: 'drop' }));
  assert.equal(dropped.status, 'dropped'); assert.deepEqual(dropped.restored.sort(), ['a.txt', 'new.txt']); assert.deepEqual(dropped.skipped, []);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo\nthree\n'); assert.equal(existsSync(join(f.P, 'new.txt')), false);
  assert.equal(read(f.P, 'b.txt'), 'bee edited by the user later\n', 'a later edit elsewhere is kept');
  const rollback = f.applies().find(item => item.kind === 'rollback');
  assert.equal(rollback.undoes, row.merge.applyIds[0]);
  // The model's own drop: recorded as the agent's, so it is not reported back to it as the user's undo.
  assert.equal(rollback.initiator, 'agent'); assert.equal(rollback.source.agentId, one.agentId);
  assert.deepEqual(deriveWorkspaceEvents(f.store.state, f.store.state.projects.find(item => item.id === f.project.id)), []);
  assert.equal(f.applies().find(item => item.id === row.merge.applyIds[0]).state, 'rolled_back');
  assert.equal(f.record(one.agentId).merge.status, 'dropped');
  assert.match(mergeLine(f.record(one.agentId)), /Its changes were dropped\./);
});

test('wait: true returns after the merge; a cancelled worker and one whose project became read-only stay pending', { skip }, async t => {
  const hold = gate(), readOnly = gate();
  const f = setup(t, { work: async ({ cwd }, task) => {
    if (/joined/.test(task)) { put(cwd, 'joined.txt', 'joined\n'); return 'Joined.'; }
    if (/cancel/.test(task)) { put(cwd, 'cancelled.txt', 'never merged\n'); await hold.held; return 'late'; }
    put(cwd, 'readonly.txt', 'written before the grant went\n'); await readOnly.held; return 'Done.';
  } });
  const joined = body(await f.tool('agent_delegate').execute('joined', { task: 'joined work', wait: true }, new AbortController().signal));
  assert.equal(joined.status, 'completed'); assert.equal(joined.merge.status, 'merged'); assert.match(joined.mergeNote, /joined\.txt/);
  assert.equal(read(f.P, 'joined.txt'), 'joined\n', 'the joined result came back after the merge');
  // Cancelled by the parent: nothing merged, W kept, the card offers 合并 / 丢弃.
  const cancelled = await f.delegate('cancel me');
  await until(() => existsSync(join(f.P, '.rna')) && f.children.length >= 2);
  await delay(50);
  const view = body(await f.tool('agent_cancel').execute('c', { agentId: cancelled.agentId }, new AbortController().signal));
  assert.equal(view.status, 'cancelled'); assert.equal(view.merge.status, 'pending'); assert.equal(view.merge.reason, 'cancelled');
  assert.equal(existsSync(join(f.P, 'cancelled.txt')), false);
  const cancelledRow = f.record(cancelled.agentId);
  assert.equal(f.worktree(cancelledRow.worktree.id).state, 'kept'); assert.equal(f.item(cancelled.agentId).subagent.worktreeId, cancelledRow.worktree.id);
  assert.match(mergeLine(cancelledRow), /It was cancelled, so its changes were not merged/);
  // The grant was revoked while it ran: not merged either.
  const revoked = await f.delegate('read only later');
  await until(() => f.children.length >= 3); await delay(50);
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'read', background: 'read' }));
  readOnly.release();
  const row = await f.settled(revoked.agentId);
  assert.equal(row.merge.status, 'pending'); assert.equal(row.merge.reason, 'read_only'); assert.equal(existsSync(join(f.P, 'readonly.txt')), false);
  assert.deepEqual(f.service.pendingMerges(f.session.id).map(item => [item.agentId, item.status, item.reason]), [[cancelled.agentId, 'pending', 'cancelled'], [revoked.agentId, 'pending', 'read_only']]);
  // agent_merge needs the write grant; with it back, the cancelled worker comes in and the read-only one is dropped.
  assert.equal((await f.merge({ agentId: cancelled.agentId })).details.code, 'delegation_permission');
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'execute', background: 'read' }));
  const brought = body(await f.merge({ agentId: cancelled.agentId }));
  assert.equal(brought.status, 'merged'); assert.deepEqual(brought.applied, ['cancelled.txt']); assert.equal(read(f.P, 'cancelled.txt'), 'never merged\n');
  const dropped = body(await f.merge({ agentId: revoked.agentId, action: 'drop' }));
  assert.deepEqual(dropped, { status: 'dropped', restored: [], skipped: [] });
  assert.equal(f.worktree(f.record(revoked.agentId).worktree.id).state, 'removed'); assert.equal(existsSync(join(f.P, 'readonly.txt')), false);
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(f.record(revoked.agentId).worktree.id, 'tip')).trim(), 'the tip ref stays for the retention period');
  hold.release();
});

test('after a restart an interrupted worker\'s copy is pinned and left pending (unfinished) before its notice; a vanished copy is reported lost', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }, task) => { put(cwd, /lost/.test(task) ? 'lost.txt' : 'survivor.txt', 'from before the restart\n'); await held.held; return 'never'; } });
  const kept = await f.delegate('survives the restart'), lost = await f.delegate('lost copy');
  await until(() => f.children.length === 2); await delay(50);
  // The old process is gone: its children never answer; a new service starts on the same state.
  f.service.running.clear();
  const lostRow = f.record(lost.agentId);
  rmSync(join(f.P, f.worktree(lostRow.worktree.id).dir), { recursive: true, force: true });
  const restarted = f.make();
  t.after(() => restarted.close());
  assert.equal(restarted.recover(), 2);
  await restarted.recovery;
  const survivor = restarted.record(f.session.id, kept.agentId);
  // Interrupted, so unfinished: pinned, never written into the project folder by the host (the user's decision of 2026-10-05).
  assert.equal(survivor.status, 'interrupted'); assert.deepEqual(survivor.merge, { status: 'pending', applyIds: [], reason: 'unfinished' });
  assert.equal(existsSync(join(f.P, 'survivor.txt')), false); assert.equal(f.applies().length, 0, 'no apply record');
  assert.equal(f.worktree(survivor.worktree.id).state, 'kept');
  assert.ok(git(f.P, 'rev-parse', REFS.worktree(survivor.worktree.id, 'tip')).trim());
  // The fixture's parent turn still runs (the store was not reloaded), so the notice is queued for it.
  const notice = f.current().inbox.find(entry => entry.agentId === kept.agentId);
  assert.ok(notice, 'its notice went out after the pin');
  assert.match(notice.text, /Its changes are pending: unfinished \(the subtask did not finish/);
  assert.match(notice.notice, /改动没有自动合并，可在卡片上合并或丢弃$/);
  const gone = restarted.record(f.session.id, lost.agentId);
  assert.equal(gone.merge.status, 'dropped'); assert.equal(gone.merge.reason, 'missing'); assert.match(gone.summary, /工作副本已经不在了/);
  assert.equal(f.worktree(gone.worktree.id).state, 'missing'); assert.equal(existsSync(join(f.P, 'lost.txt')), false);
  assert.match(mergeLine(gone), /its changes are lost/);
});

test('a worker of a conversation running in its own worktree merges into S; once that conversation is idle S goes on to the project folder', { skip }, async t => {
  const held = gate(), idle = [];
  const f = setup(t, { sessionWorktrees: { applyIdle: async sessionId => { idle.push(sessionId); return { status: 'applied' }; } }, work: async ({ cwd }, task) => { put(cwd, 'from-worker.txt', `${task}\n`); if (/later/.test(task)) await held.held; return 'Done.'; } });
  const S = await f.worktrees.create(f.project.id, { kind: 'session', id: 'swt-1', owner: { sessionId: f.session.id }, parent: await f.roots.rootOf({ projectId: f.project.id }), label: 'Rna conversation' });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).worktree = { id: S.id, state: 'active' }; });
  const sRoot = join(f.P, S.dir);
  put(sRoot, 'conversation.txt', 'the conversation’s own edit\n');
  const busy = body(await f.tool('agent_delegate').execute('busy', { task: 'while busy', wait: true }, new AbortController().signal));
  assert.equal(busy.merge.status, 'merged'); assert.equal(read(sRoot, 'from-worker.txt'), 'while busy\n'); assert.equal(existsSync(join(f.P, 'from-worker.txt')), false);
  assert.match(f.children[0].cwd, /\/w-/); assert.deepEqual(idle, [], 'the conversation was busy: its own turn end applies S');
  const seed = git(f.P, 'show', `${f.worktrees.record(f.project.id, f.record(busy.agentId).worktree.id).seed}:conversation.txt`);
  assert.equal(seed, 'the conversation’s own edit\n', 'the worker started from S with its uncommitted edit');
  // Read-only roles run in the parent's root, S here (sandboxed as an isolated root), never in P.
  const scout = body(await f.tool('agent_consult').execute('scout', { role: 'scout', task: 'Look around.', wait: true }, new AbortController().signal));
  assert.equal(scout.status, 'completed'); assert.equal(f.children[1].cwd, realpathSync(sRoot)); assert.equal(f.children[1].isolated, true); assert.equal(f.children[1].instructionsRoot, f.P);
  // Its result opens a follow-up turn (continueAfter), so the host merges it although the conversation is idle by then.
  const later = await f.delegate('finishes later', { continueAfter: true });
  await until(() => f.children.length === 3);
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id), turn = session.turns.find(row => row.id === f.turnId); turn.status = 'completed'; session.activeTurnId = null; session.status = 'idle'; });
  held.release();
  assert.equal((await f.settled(later.agentId)).merge.status, 'merged');
  assert.equal(read(sRoot, 'from-worker.txt'), 'finishes later\n'); assert.deepEqual(idle, [f.session.id]);
  assert.equal(f.applies().find(row => row.source.agentId === later.agentId).target, `session:${f.session.id}`, 'a merge into S is recorded for crash recovery');
});

test('C5: dropping a worker merged into a conversation worktree that is gone (the conversation works in the project folder now) writes nothing into the project folder, even during the user\'s git merge', { skip }, async t => {
  const f = setup(t, { sessionWorktrees: { applyIdle: async () => null }, work: async ({ cwd }) => { put(cwd, 'from-worker.txt', 'by the worker\n'); return 'Done.'; } });
  const S = await f.worktrees.create(f.project.id, { kind: 'session', id: 'swt-gone', owner: { sessionId: f.session.id }, parent: await f.roots.rootOf({ projectId: f.project.id }), label: 'Rna conversation' });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).worktree = { id: S.id, state: 'active' }; });
  const merged = body(await f.tool('agent_delegate').execute('into-s', { task: 'Write the file.', wait: true }, new AbortController().signal));
  assert.equal(merged.merge.status, 'merged');
  const sRow = f.applies().find(row => row.source.agentId === merged.agentId);
  assert.equal(sRow.target, `session:${f.session.id}`);
  // The conversation's copy reached the project folder and went; the conversation works in the project folder now
  // (answerCreate 'project_folder'), and the user has a git merge open there.
  put(f.P, 'from-worker.txt', 'by the worker\n');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).worktree = null; });
  writeFileSync(join(f.top, '.git', 'MERGE_HEAD'), git(f.P, 'rev-parse', 'HEAD'));
  const before = f.applies().length;
  // The card's preview plans nothing for that record and says why.
  const preview = await f.service.userMerge(f.session.id, merged.agentId, { action: 'drop' });
  assert.deepEqual(preview.files, []); assert.deepEqual(preview.skipped, [{ path: 'from-worker.txt', reason: 'worktree_gone' }]);
  // The model's drop answers at once: nothing written into the project folder, no rollback record, the record in effect.
  const dropped = await Promise.race([f.merge({ agentId: merged.agentId, action: 'drop' }).then(body), delay(5000).then(() => 'waited')]);
  assert.notEqual(dropped, 'waited', 'never waits on the user\'s merge');
  assert.deepEqual(dropped.skipped, [{ path: 'from-worker.txt', reason: 'worktree_gone' }]); assert.deepEqual(dropped.restored, []);
  assert.equal(read(f.P, 'from-worker.txt'), 'by the worker\n');
  assert.equal(f.applies().length, before, 'no rollback record');
  assert.equal(f.applies().find(row => row.id === sRow.id).state, sRow.state); assert.equal(f.applies().find(row => row.id === sRow.id).rolledBackBy, undefined);
});

test('read-only roles share the parent\'s root; without isolation a worker shares it too and its receipt says shared_root', { skip }, async t => {
  const f = setup(t, { ready: false, work: async ({ cwd }) => { put(cwd, 'direct.txt', 'written in place\n'); return 'Done.'; } });
  const scout = body(await f.tool('agent_consult').execute('scout', { role: 'scout', task: 'Inspect.', wait: true }, new AbortController().signal));
  assert.equal(scout.status, 'completed'); assert.equal(f.children[0].cwd, f.P); assert.equal(f.children[0].isolated, false);
  assert.equal(scout.merge, undefined, 'read-only roles have no merge');
  const handle = await f.delegate('write in place');
  assert.deepEqual(handle.merge, { status: 'shared_root', reason: 'not_ready' });
  const row = await f.settled(handle.agentId);
  assert.equal(f.children[1].cwd, f.P); assert.equal(read(f.P, 'direct.txt'), 'written in place\n');
  assert.equal(row.merge.status, 'shared_root'); assert.equal(row.worktree, undefined);
  assert.match(mergeLine(row), /It worked directly in your files \(no isolated copy: not_ready\)\./);
  assert.equal((await f.merge({ agentId: handle.agentId })).details.code, 'merge_shared_root');
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
  assert.ok(f.tool('agent_delegate').description.includes(DELEGATE_ISOLATION_TEXT));
});

test('a folder without git keeps 0.62 behaviour: shared_root with the reason', { skip }, async t => {
  const f = setup(t, { repository: false, work: async ({ cwd }) => { put(cwd, 'plain.txt', 'plain\n'); return 'Done.'; } });
  const handle = await f.delegate('plain folder');
  assert.equal(handle.merge.status, 'shared_root'); assert.equal(handle.merge.reason, 'no_repository');
  await f.settled(handle.agentId);
  assert.equal(read(f.P, 'plain.txt'), 'plain\n'); assert.equal(existsSync(join(f.P, '.rna')), false);
});

test('not enough disk space refuses the delegation before it starts; a worktree that cannot be made fails the worker without a fallback', { skip }, async t => {
  const f = setup(t, { statfs: () => ({ bavail: 1, bsize: 1024 }) });
  const refused = await f.tool('agent_delegate').execute('space', { task: 'too big' }, new AbortController().signal);
  assert.equal(refused.isError, true); assert.equal(refused.details.delegatedAgent.code, 'delegation_worktree_space'); assert.match(refused.content[0].text, /not enough free disk space/);
  assert.equal(f.current().turns[0].delegations, undefined, 'nothing was started');
  const g = setup(t, { work: async ({ cwd }) => { put(cwd, 'x.txt', 'x'); return 'Done.'; } });
  g.worktrees.create = async () => { throw Object.assign(new Error('boom'), { code: 'worktree_create_failed' }); };
  const handle = await g.delegate('cannot copy');
  const row = await g.settled(handle.agentId);
  assert.equal(row.status, 'failed'); assert.equal(row.code, 'delegation_worktree_failed'); assert.equal(g.children.length, 0, 'it never ran, not even in the parent\'s folder');
  assert.match(row.summary, /独立的工作副本/); assert.equal(existsSync(join(g.P, 'x.txt')), false);
  assert.deepEqual(g.service.pendingMerges(g.session.id), []);
});

test('agent_merge refuses what is not a finished worker of this conversation, and forwards a change set to the background controller', { skip }, async t => {
  const held = gate(), forwarded = [];
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'w.txt', 'w'); await held.held; return 'Done.'; } });
  assert.equal((await f.merge({})).details.code, 'merge_unknown');
  assert.equal((await f.merge({ agentId: 'agent-nope' })).details.code, 'merge_unknown');
  assert.equal((await f.merge({ changeId: 'change-1' })).details.code, 'merge_unknown', 'unwired: no change set');
  f.service.backgroundMerge = async (args, signal) => { forwarded.push([args, signal instanceof AbortSignal]); return { content: [{ type: 'text', text: '{"status":"merged","applied":[],"conflicts":[],"notMerged":[],"notes":[]}' }] }; };
  assert.equal(body(await f.merge({ changeId: 'change-1', action: 'merge' })).status, 'merged');
  assert.deepEqual(forwarded[0][0], { projectId: f.project.id, sessionId: f.session.id, changeId: 'change-1', action: 'merge', path: undefined, page: undefined, take: undefined, callId: forwarded[0][0].callId });
  assert.ok(forwarded[0][1]);
  const running = await f.delegate('still running', { files: ['w.txt'] });
  assert.equal((await f.merge({ agentId: running.agentId })).details.code, 'merge_not_finished');
  assert.deepEqual(f.service.pendingMerges(f.session.id), [], 'a running worker is never listed');
  // Overlapping files of two isolated workers: a note that the merge may report a conflict, never a lock.
  const overlapping = await f.delegate('also running', { files: ['./w.txt'] });
  assert.deepEqual(overlapping.filesOverlap, [{ agentId: running.agentId, paths: ['w.txt'] }]); assert.match(overlapping.filesNote, /may come back as a conflict for you to resolve with agent_merge/);
  // Since A5 the host merges a worker by itself only in some cases, so the receipt promises no merge of both.
  assert.match(overlapping.filesNote, /reach your files only when it is merged \(by the host, or by your agent_merge\)/); assert.doesNotMatch(overlapping.filesNote, /both changes are merged/);
  held.release(); await f.settled(running.agentId); await f.settled(overlapping.agentId);
  // Both wrote the same content: whichever merged second found nothing left to write.
  const both = [f.record(running.agentId), f.record(overlapping.agentId)].sort((a, b) => a.merge.files - b.merge.files);
  assert.deepEqual(both.map(row => [row.merge.status, row.merge.files]), [['merged', 0], ['merged', 1]]);
  assert.equal(mergeLine(both[0]), 'Its changes are already in your files.');
});

test('conflicts left to the user (a link pointing outside the project) are listed as userOnly and cannot be taken', { skip }, async t => {
  const { symlinkSync } = await import('node:fs');
  const f = setup(t, { work: async ({ cwd }) => { symlinkSync('../../../../../../../../etc', join(cwd, 'escape')); put(cwd, 'fine.txt', 'fine\n'); return 'Done.'; } });
  const handle = await f.delegate('link out');
  const row = await f.settled(handle.agentId);
  assert.equal(row.merge.status, 'conflict'); assert.deepEqual(row.merge.conflicts, [{ path: 'escape', kind: 'unsafe_symlink' }]);
  assert.equal(read(f.P, 'fine.txt'), 'fine\n'); assert.equal(existsSync(join(f.P, 'escape')), false, 'never written automatically');
  const answer = body(await f.merge({ agentId: handle.agentId }));
  assert.equal(answer.conflicts[0].userOnly, true); assert.ok(answer.notes.some(note => /left to the user/.test(note)));
  const taken = await f.merge({ agentId: handle.agentId, action: 'take', take: [{ path: 'escape', side: 'incoming' }] });
  assert.equal(taken.details.code, 'merge_take_denied'); assert.equal(existsSync(join(f.P, 'escape')), false);
});

test('the card\'s buttons: merge brings a pending worker in, drop is two-step, handoff opens a host-written turn', { skip }, async t => {
  const hold = gate();
  const f = setup(t, { work: async ({ cwd }, task) => { put(cwd, `${task.split(' ')[0]}.txt`, `${task}\n`); if (/cancel/.test(task)) await hold.held; return 'Done.'; } });
  const handle = await f.delegate('cancelme now');
  await until(() => f.children.length === 1); await delay(50);
  await f.tool('agent_cancel').execute('c', { agentId: handle.agentId }, new AbortController().signal);
  const sent = [];
  const routes = createAgentRoutes({ store: f.store, agents: f.service, body: async req => req.body });
  const post = async (path, input) => { const handled = await routes({ method: 'POST', body: input }, { pathname: path, send: (status, payload) => sent.push([status, payload]) }); assert.ok(handled); return sent.at(-1); };
  const url = `/api/v2/sessions/${f.session.id}/agents/${handle.agentId}/merge`;
  assert.equal((await post(url, { action: 'apply' }))[1].code, 'merge_request_invalid');
  assert.equal((await post(`/api/v2/sessions/${f.session.id}/agents/agent-none/merge`, { action: 'merge' }))[0], 404);
  // handoff: the conversation is running, so the notice reaches its turn.
  const [okHandoff, handed] = await post(url, { action: 'handoff' });
  assert.equal(okHandoff, 200); assert.equal(handed.turnId, f.turnId); assert.equal(handed.subagent.merge.status, 'pending');
  const steered = f.current().inbox.find(message => message.agentId === handle.agentId && /worker merge/.test(message.text));
  assert.ok(steered); assert.match(steered.text, /Use agent_merge with this agentId/); assert.match(steered.notice, /让 Rna 处理子代理的改动/);
  // merge from the card.
  const [okMerge, merged] = await post(url, { action: 'merge' });
  assert.equal(okMerge, 200); assert.deepEqual(merged.applied, ['cancelme.txt']); assert.deepEqual(merged.conflicts, []); assert.equal(merged.subagent.merge.status, 'merged');
  assert.equal(read(f.P, 'cancelme.txt'), 'cancelme now\n');
  // handoff of something settled is refused.
  assert.equal((await post(url, { action: 'handoff' }))[1].code, 'merge_settled');
  // drop: the first step lists what the rollback restores; a stale token is refused; the second step rolls back.
  const [, preview] = await post(url, { action: 'drop' });
  assert.deepEqual(preview.files, [{ path: 'cancelme.txt', action: 'delete' }]); assert.deepEqual(preview.skipped, []); assert.ok(preview.confirm && preview.expiresAt);
  assert.equal((await post(url, { action: 'drop', confirm: 'stale' }))[1].code, 'rollback_unconfirmed');
  const [, again] = await post(url, { action: 'drop' });
  put(f.P, 'cancelme.txt', 'edited after the preview\n');
  const changed = await post(url, { action: 'drop', confirm: again.confirm });
  assert.equal(changed[0], 409); assert.equal(changed[1].code, 'rollback_changed');
  put(f.P, 'cancelme.txt', 'cancelme now\n');
  const [, fresh] = await post(url, { action: 'drop' });
  const [okDrop, done] = await post(url, { action: 'drop', confirm: fresh.confirm });
  assert.equal(okDrop, 200); assert.equal(done.subagent.merge.status, 'dropped'); assert.equal(existsSync(join(f.P, 'cancelme.txt')), false);
  // The card's drop is the user's: the next request of the conversation hears of it.
  assert.equal(f.applies().find(item => item.kind === 'rollback').initiator, 'user');
  assert.deepEqual(deriveWorkspaceEvents(f.store.state, f.store.state.projects.find(item => item.id === f.project.id)).map(row => [row.kind, row.owner.agentId]), [['worker_dropped', handle.agentId]]);
  // A read-only project: the card's writes are refused with the git code.
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'read', background: 'read' }));
  const readOnly = await post(url, { action: 'merge' });
  assert.equal(readOnly[0], 403); assert.equal(readOnly[1].code, 'git_read_only');
  hold.release();
});

test('a subfolder project: the worker\'s root is the worktree plus the prefix, and paths stay relative to the project folder', { skip }, async t => {
  const f = setup(t, { prefix: 'site', work: async ({ cwd }) => { put(cwd, 'page.html', '<p>new</p>\n'); put(cwd, 'a.txt', 'one\ntwo in site\nthree\n'); put(cwd, 'package.json', '{"name":"site"}\n'); return 'Done.'; } });
  const handle = await f.delegate('edit the site', { files: ['a.txt'] });
  const row = await f.settled(handle.agentId);
  assert.match(f.children[0].cwd, /\/\.rna\/worktrees\.nosync\/w-[^/]+\/site$/);
  assert.equal(row.merge.status, 'merged'); assert.deepEqual(row.outsideFiles, ['package.json', 'page.html']);
  // A dependency manifest among its changes: the parent hears it may need a reinstall.
  assert.equal(row.mergeWork.dependencies, true);
  const status = body(await f.tool('agent_status').execute('s', { agentId: handle.agentId }, new AbortController().signal));
  assert.match(status.mergeNote, /dependency manifests or lock files; your files may need a reinstall/);
  assert.equal(read(f.P, 'page.html'), '<p>new</p>\n'); assert.equal(read(f.P, 'a.txt'), 'one\ntwo in site\nthree\n');
  assert.equal(read(f.top, 'outside-the-project.md'), 'repository top\n');
});

test('A4: a worker whose result opens a follow-up turn of its idle parent (continueAfter) is merged all or nothing: a conflict leaves the project folder untouched', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'a.txt', 'one\ntwo by worker\nthree\n'); put(cwd, 'c.txt', 'clean from worker\n'); await held.held; return 'Done.'; } });
  const handle = await f.delegate('Edit a.txt and add c.txt.', { continueAfter: true });
  await until(() => f.children.length === 1); await delay(50);
  // The user changes the same line meanwhile, and the parent turn ends: nobody is there to finish half a merge.
  put(f.P, 'a.txt', 'one\ntwo by the user\nthree\n');
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  assert.equal(f.current().activeTurnId, null);
  held.release();
  const row = await f.settled(handle.agentId);
  assert.equal(row.merge.status, 'conflict'); assert.equal(row.merge.files, 0); assert.deepEqual(row.merge.conflicts, [{ path: 'a.txt', kind: 'content' }]);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo by the user\nthree\n');
  assert.equal(existsSync(join(f.P, 'c.txt')), false, 'not even the clean file: P never holds half a worker');
  assert.equal(f.applies().filter(item => item.kind === 'worker').length, 0, 'nothing written, no record');
  assert.equal(f.worktree(row.worktree.id).state, 'conflicted', 'W kept for the merge');
  assert.match(mergeLine(row), /^None of its changes are in your files yet: 1 file\(s\) conflict with changes made after it started \(a\.txt\)\. Call agent_merge\(\{"agentId":"agent-[0-9a-f]+"\}\) to merge them and resolve the conflicts, or use action drop to discard them\.$/);
  assert.deepEqual(f.service.pendingMerges(f.session.id).map(item => [item.agentId, item.status]), [[handle.agentId, 'conflict']]);
  // Someone looking (the card's 合并): the clean part comes in, the conflict stays listed.
  const merged = await f.service.userMerge(f.session.id, handle.agentId, { action: 'merge' });
  assert.deepEqual(merged.applied, ['c.txt']); assert.equal(read(f.P, 'c.txt'), 'clean from worker\n'); assert.equal(read(f.P, 'a.txt'), 'one\ntwo by the user\nthree\n');
  assert.equal(f.record(handle.agentId).merge.status, 'conflict');
});

test('A4: a continueAfter worker that ends while its parent is idle and conflicts with nothing is merged whole', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'a.txt', 'one\ntwo by worker\nthree\n'); put(cwd, 'c.txt', 'clean from worker\n'); await held.held; return 'Done.'; } });
  const handle = await f.delegate('Edit a.txt and add c.txt.', { continueAfter: true });
  await until(() => f.children.length === 1); await delay(50);
  f.store.finishRuntimeTurn(f.session.id, f.turnId); held.release();
  const row = await f.settled(handle.agentId);
  assert.equal(row.merge.status, 'merged'); assert.equal(row.merge.files, 2);
  assert.equal(read(f.P, 'a.txt'), 'one\ntwo by worker\nthree\n'); assert.equal(read(f.P, 'c.txt'), 'clean from worker\n');
});

test('A4: absolute paths into the parent\'s folder in a worker\'s task point at its own copy; the record keeps the task as written', { skip }, async t => {
  const tasks = [];
  const f = setup(t, { work: async ({ cwd }, task) => { tasks.push([cwd, task]); put(cwd, 'a.txt', 'one\ntwo\nthree\nfour\n'); return 'Done.'; } });
  const written = `Edit ${f.P}/a.txt (see "${f.P}/b.txt" and ${f.P}). Leave ${f.P}-backup/x.txt and ${f.P}.old alone.`;
  const handle = await f.delegate(written);
  await f.settled(handle.agentId);
  const [[cwd, task]] = tasks;
  assert.match(cwd, /\/\.rna\/worktrees\.nosync\/w-/);
  assert.equal(task, `Edit ${cwd}/a.txt (see "${cwd}/b.txt" and ${cwd}). Leave ${f.P}-backup/x.txt and ${f.P}.old alone.`);
  assert.ok(f.record(handle.agentId).task.startsWith(`Edit ${f.P}/a.txt (see`), 'the user-facing record shows what the parent wrote');
  // A worker sharing the parent's folder (no isolation) gets its task unchanged.
  const shared = setup(t, { repository: false, work: async ({ cwd: root }, text) => { tasks.push([root, text]); return 'Done.'; } });
  const same = `Edit ${shared.P}/a.txt.`;
  await shared.settled((await shared.delegate(same)).agentId);
  assert.equal(tasks.at(-1)[1], same);
});

// Review subagents-rebase-no-left-boundary: only a path that starts with the parent's folder is pointed at the worker's
// copy, not one that merely contains it (a backup volume, a remote host), and the worker's root goes in as written.
test('rebaseTask: the parent folder is rewritten only where a path starts with it, and the root is put in literally', () => {
  const P = '/Users/me/proj', W = '/Users/me/proj/.rna/worktrees.nosync/w-agent-1';
  const cases = [
    ['Edit /Users/me/proj/src/a.js and run tests.', `Edit ${W}/src/a.js and run tests.`],
    ['Work in /Users/me/proj.', `Work in ${W}.`],
    ['Open "/Users/me/proj/a.js", (/Users/me/proj/b.js) and --root=/Users/me/proj', `Open "${W}/a.js", (${W}/b.js) and --root=${W}`],
    ['修复/Users/me/proj/src/a.js里的问题。', `修复${W}/src/a.js里的问题。`],
    ['Copy /Users/me/proj-old/src/a.js and /Users/me/proj.bak/a.js.', 'Copy /Users/me/proj-old/src/a.js and /Users/me/proj.bak/a.js.'],
    ['Deploy: rsync -a /Users/me/proj/dist/ deploy@host:/Users/me/proj/dist/', `Deploy: rsync -a ${W}/dist/ deploy@host:/Users/me/proj/dist/`],
    ['The backup lives at /Volumes/Backup/Users/me/proj/src/a.js; leave it.', 'The backup lives at /Volumes/Backup/Users/me/proj/src/a.js; leave it.'],
    ['See file:///Users/me/proj/a.js or ~/Users/me/proj/a.js.', 'See file:///Users/me/proj/a.js or ~/Users/me/proj/a.js.']
  ];
  for (const [task, expected] of cases) assert.equal(rebaseTask(task, [P], W), expected, task);
  // A folder whose name holds a replacement pattern ($&, $`, $', $$): the root goes in as written, nothing expanded.
  for (const odd of ['/Users/a/x$&y', '/Users/a/x$`y', "/Users/a/x$'y", '/Users/a/x$$y']) {
    const root = `${odd}/.rna/worktrees.nosync/w1`;
    assert.equal(rebaseTask(`Edit ${odd}/src/a.js now.`, [odd], root), `Edit ${root}/src/a.js now.`, odd);
  }
});

test('the service stopping while a worker runs leaves its end for the next start, which pins it and leaves it pending (unfinished)', { skip }, async t => {
  const held = gate();
  const f = setup(t, { work: async ({ cwd }) => { put(cwd, 'late.txt', 'written before the stop\n'); await held.held; return 'never'; } });
  const handle = await f.delegate('stopped by the shutdown');
  await until(() => f.children.length === 1); await delay(50);
  await f.service.close();
  const row = f.record(handle.agentId);
  assert.equal(row.status, 'interrupted'); assert.equal(row.merge.status, 'pending'); assert.equal(row.merge.reason, 'interrupted'); assert.equal(row.mergeAtStart, true);
  assert.equal(existsSync(join(f.P, 'late.txt')), false, 'nothing is written while the service stops');
  const next = f.make();
  t.after(() => next.close());
  assert.equal(next.recover(), 0); await next.recovery;
  const after = next.record(f.session.id, handle.agentId);
  assert.deepEqual(after.merge, { status: 'pending', applyIds: [], reason: 'unfinished' }); assert.equal(after.mergeAtStart, undefined);
  assert.equal(existsSync(join(f.P, 'late.txt')), false, 'an interrupted worker is never written by the host'); assert.equal(f.applies().length, 0);
  assert.ok(after.mergeWork.tip, 'its files are pinned'); assert.equal(f.worktree(after.worktree.id).state, 'kept');
  held.release();
});

test('a finished worker whose merge the shutdown cut short is settled at the next start as at its end: the parent is paused for recovery, so it waits (parent_idle)', { skip }, async t => {
  const f = setup(t);
  // A finished worker as settle() records it when the service closed while its merge waited for the project folder.
  const at = new Date().toISOString();
  const created = await f.worktrees.create(f.project.id, { kind: 'worker', owner: { sessionId: f.session.id, turnId: f.turnId, agentId: 'agent-cut' }, parent: await f.roots.rootOf({ projectId: f.project.id }), label: 'Rna worker agent-cut' });
  put(join(f.P, created.dir), 'cut.txt', 'finished before the stop\n');
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id), turn = session.turns.find(row => row.id === f.turnId);
    turn.delegations = [{ id: 'agent-cut', role: 'worker', fingerprint: 'fp', status: 'completed', task: 'Write cut.txt.', background: true, createdAt: at, startedAt: at, endedAt: at, completedAt: at, summary: 'Done.', output: 'Done.', usage: { totalTokens: 0 }, delivery: { status: 'pending', at }, isolated: true, worktree: { id: created.id }, merge: { status: 'pending', applyIds: [], reason: 'interrupted' }, mergeWork: { seed: created.seed }, mergeAtStart: true }];
    // The restart paused the parent's turn (Store: pauseSession 'recovery').
    session.status = 'paused'; session.pauseReason = 'recovery';
  });
  const next = f.make();
  t.after(() => next.close());
  next.recover(); await next.recovery;
  const after = next.record(f.session.id, 'agent-cut');
  assert.deepEqual(after.merge, { status: 'pending', applyIds: [], reason: 'parent_idle' }); assert.equal(after.mergeAtStart, undefined);
  assert.equal(existsSync(join(f.P, 'cut.txt')), false); assert.equal(f.worktree(created.id).state, 'kept');
});

test('with the real runtime a worker\'s tools are rooted in its worktree: its write lands there, then the host merges it', { skip }, async t => {
  const http = await import('node:http');
  const { createRnaRuntime } = await import('../rna-runtime.mjs');
  const stream = (res, { tool, name = 'project_write', args, text = 'Saved real.txt and read it back.' } = {}) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { tool_calls: [{ index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  };
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); seen.push(input);
    const results = input.messages.filter(message => message.role === 'tool').length;
    if (!results) return stream(res, { tool: true, args: { path: 'real.txt', content: 'written by the worker\n', expectedHash: null } });
    if (/host-delivery-observation/.test(JSON.stringify(input.messages.at(-1)))) return stream(res, { tool: true, name: 'project_read', args: { path: 'real.txt' } });
    stream(res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const f = setup(t, { server, factory: options => createRnaRuntime(options) });
  const handle = body(await f.tool('agent_delegate').execute('real', { task: 'Save real.txt.', wait: true }, new AbortController().signal));
  assert.equal(handle.status, 'completed'); assert.equal(handle.merge.status, 'merged');
  assert.equal(read(f.P, 'real.txt'), 'written by the worker\n');
  const options = f.children[0];
  assert.match(options.cwd, /\/\.rna\/worktrees\.nosync\/w-/); assert.equal(options.isolated, true);
  const purpose = JSON.stringify(seen[0].messages);
  assert.ok(purpose.includes('You are working in your own copy of the project'), 'the worker context note reaches the child as host instructions');
  assert.ok(!seen[0].messages.find(message => message.role === 'system').content.includes('own copy of the project'), 'not in the system prompt');
  assert.ok(!seen[0].tools.some(tool => ['agent_merge', 'agent_delegate'].includes(tool.function.name)), 'a child never gets agent_merge');
});
