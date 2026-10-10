// Worktree design 0.63 §9 / §13 (T2): where each consumer of a root actually works, in the project folder P and in
// worktree roots (S, W, B). Real temporary repositories; git without global or system configuration; no network,
// no model calls. The rows of the §9 table owned by other teams (runtime-controller, builtin agents, background
// work, the web) are covered by their own tests; here every root surface T2 wires is checked against a real worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, addWorktree, git, gitVersionOk, write } from './helpers/worktree-fixture.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { TerminalService } from '../terminal-service.mjs';
import { WorkspaceInspectionService } from '../workspace-inspection-service.mjs';
import { GeneStore } from '../project-genes.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { MediaToolsService } from '../media-tools-service.mjs';
import { VisionService } from '../vision-service.mjs';
import { sandboxAvailable } from '../../../packages/sdk/src/workspace-exec.mjs';
import { solidPng } from '../../../packages/sdk/src/vision-probe.mjs';
import { GUARD_SCRIPT } from './helpers/gene-fixture.mjs';

const skip = !gitVersionOk;
const delegate = (f, sessionId, agentId, worktreeId) => f.store.mutate(state => {
  const session = state.sessions.find(row => row.id === sessionId);
  session.turns.push({ id: `turn-${agentId}`, status: 'completed', delegations: [{ id: agentId, role: 'worker', status: 'running', ...(worktreeId ? { worktree: { id: worktreeId } } : {}) }] });
});
const setSessionWorktree = (f, sessionId, worktree) => f.store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); if (worktree) session.worktree = worktree; else delete session.worktree; });

test('RootResolver: P, a direct-mode session, a pending, an active and a kept session worktree, a worker, a background run', { skip }, async t => {
  const f = fixture(t);
  assert.deepEqual(await f.roots.rootOf({ projectId: f.project.id }), { root: f.P, kind: 'project', isolated: false, project: f.P });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, f.P, 'no session.worktree: direct mode');
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'pending' });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'worktree_pending', status: 409 });
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-session1', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  const S = await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id });
  assert.deepEqual(S, { root: s.root, kind: 'session', isolated: true, project: f.P, prefix: '', worktreeId: 'wt-s', gitDir: s.gitDir, workTree: s.top });
  assert.ok(S.root.startsWith(join(f.P, '.rna/worktrees.nosync/')), 'S lives inside P');
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'kept' });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, s.root, 'a kept worktree still answers S');
  // A worker with its own worktree → W; one without → its session's root (S here).
  const w = addWorktree(f, { kind: 'worker', id: 'wt-w', name: 'w-agent001', owner: { sessionId: f.session.id, agentId: 'agent-1' } });
  delegate(f, f.session.id, 'agent-1', 'wt-w'); delegate(f, f.session.id, 'agent-2', null);
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id, agentId: 'agent-1' })).root, w.root);
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, agentId: 'agent-1' })).kind, 'worker');
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id, agentId: 'agent-2' })).root, s.root, 'shared root: the parent S');
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, agentId: 'agent-x' }), { code: 'delegation_unknown', status: 404 });
  // A background run with a b- worktree → B; other runs → P.
  const b = addWorktree(f, { kind: 'background', id: 'wt-b', name: 'b-action01', owner: { actionId: 'action-1' } });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, actionId: 'action-1' })).root, b.root);
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, actionId: 'action-2' })).root, f.P);
  // A session of another project is refused.
  const other = f.store.createProject({ name: 'Other', workspace: f.directory, initiative: { enabled: false } });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: other.session.id }), { code: 'session_not_found', status: 404 });
  await assert.rejects(f.roots.rootOf({ projectId: 'nope' }), { code: 'project_not_found', status: 404 });
});

test('a missing worktree folder is worktree_missing, never answered with P, also after a cached answer', { skip }, async t => {
  const f = fixture(t);
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-gone0001', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, s.root);
  rmSync(s.top, { recursive: true, force: true });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'worktree_missing', status: 409 });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'missing' });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'worktree_missing' });
  // A removed record, or none at all, is missing too.
  setSessionWorktree(f, f.session.id, { id: 'wt-none', state: 'active' });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'worktree_missing' });
  // P itself gone: workspace_missing.
  setSessionWorktree(f, f.session.id, null);
  rmSync(f.P, { recursive: true, force: true });
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id }), { code: 'workspace_missing', status: 409 });
});

test('a session pointing at an unregistered or swapped folder is refused (root_denied)', { skip }, async t => {
  const f = fixture(t);
  setSessionWorktree(f, f.session.id, { id: 'wt-x', state: 'active' });
  const record = dir => f.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id); row.git.worktrees = [{ id: 'wt-x', kind: 'session', name: 's-plain001', dir, prefix: '', owner: { sessionId: f.session.id }, seed: 'x', state: 'active', createdAt: new Date().toISOString() }]; f.roots.invalidate(); });
  // A plain folder under worktrees.nosync, not a git worktree.
  mkdirSync(join(f.P, '.rna/worktrees.nosync/s-plain001'), { recursive: true });
  record('.rna/worktrees.nosync/s-plain001');
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied', status: 403 });
  // A record whose dir leaves the worktree folder.
  record('../outside');
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied' });
  record('.rna/worktrees.nosync/../../src');
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied' });
  // A real worktree reached through a `.rna` that was swapped for a link elsewhere.
  rmSync(join(f.P, '.rna'), { recursive: true, force: true });
  const s = addWorktree(f, { kind: 'session', id: 'wt-y', name: 's-linked01', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-y', state: 'active' });
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, s.root);
  // Move the real .rna away and put a link in its place: the worktree is still reachable, but not where it belongs.
  const real = join(f.directory, 'real-rna');
  renameSync(join(f.P, '.rna'), real); symlinkSync(real, join(f.P, '.rna'));
  f.roots.invalidate();
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied' });
  rmSync(join(f.P, '.rna')); renameSync(real, join(f.P, '.rna'));
  // A tampered `.git` link in the worktree (pointing at another repository) is refused, never followed.
  f.roots.invalidate();
  const other = join(f.directory, 'other-repo'); mkdirSync(other);
  git(other, ['init', '-q']);
  const original = readFileSync(join(s.top, '.git'), 'utf8');
  writeFileSync(join(s.top, '.git'), `gitdir: ${join(other, '.git')}\n`);
  await assert.rejects(f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id }), { code: 'root_denied' });
  writeFileSync(join(s.top, '.git'), original);
  assert.equal((await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id })).root, s.root);
});

test('a project in a repository subfolder: the root is the worktree plus the prefix', { skip }, async t => {
  const f = fixture(t, { prefix: 'apps/site' });
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-prefix01', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  const S = await f.roots.rootOf({ projectId: f.project.id, sessionId: f.session.id });
  assert.equal(S.root, join(s.top, 'apps/site')); assert.equal(S.workTree, s.top); assert.equal(S.prefix, 'apps/site/');
  assert.ok(existsSync(join(S.root, 'src/app.js')));
});

test('peek, current and invalidate answer from state without the disk', { skip }, async t => {
  const f = fixture(t), query = { projectId: f.project.id, sessionId: f.session.id };
  assert.equal(f.roots.peek(query), null, 'nothing resolved yet');
  const P = await f.roots.rootOf(query);
  assert.deepEqual(f.roots.peek(query), P); assert.equal(f.roots.current(query, P), true);
  addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-peek0001', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  assert.equal(f.roots.peek(query), null, 'state names another root now');
  assert.equal(f.roots.current(query, P), false);
  const S = await f.roots.rootOf(query);
  assert.equal(f.roots.current(query, S), true); assert.deepEqual(f.roots.peek(query), S);
  f.roots.invalidate({ sessionId: f.session.id });
  assert.equal(f.roots.peek(query), null);
  await f.roots.rootOf(query); f.roots.invalidate({ worktreeId: 'wt-s' }); assert.equal(f.roots.peek(query), null);
  await f.roots.rootOf(query); f.roots.invalidate({ projectId: f.project.id }); assert.equal(f.roots.peek(query), null);
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'missing' });
  assert.equal(f.roots.current(query, S), false);
});

// §9 "工具 registry" and "沙箱": tools rooted at the worktree, commands always sandboxed there with P denied.
test('tool registry: an isolated root gets tools rooted there and sandboxed commands; P and its .git stay out of reach', { skip: skip || !sandboxAvailable() }, async t => {
  const f = fixture(t), capabilities = new CapabilityService(f.store);
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-tools001', owner: { sessionId: f.session.id } });
  const project = f.store.state.projects.find(row => row.id === f.project.id);
  const tools = async options => { const { registry } = await capabilities.registry(project, [], { includeMutations: true, ...options }); t.after(() => registry.close()); return name => registry.tools.get(name); };
  const isolated = await tools({ root: s.root, isolated: true });
  write(s.root, 'only-in-s.txt', 'S\n');
  assert.match((await isolated('project_read').execute('r', { path: 'only-in-s.txt' })).content[0].text, /S/);
  const run = async command => (await isolated('project_exec').execute('c', { command })).details;
  assert.equal((await run('echo ok > made.txt')).exitCode, 0); assert.ok(existsSync(join(s.root, 'made.txt')));
  assert.equal((await run('true')).sandboxed, true);
  assert.notEqual((await run(`echo x > ${JSON.stringify(join(f.P, 'README.md'))}`)).exitCode, 0, 'echo x > <P>/f fails');
  assert.notEqual((await run('echo x > .git')).exitCode, 0, 'echo x > .git fails');
  assert.notEqual((await run(`ln ${JSON.stringify(join(f.P, 'README.md'))} hard`)).exitCode, 0, 'no hard link to a project file');
  assert.notEqual((await run(`echo x > ${JSON.stringify(join(f.top, '.git', 'HEAD'))}`)).exitCode, 0, 'the repository is out of reach');
  assert.equal(readFileSync(join(f.P, 'README.md'), 'utf8'), 'hello\n');
  // A worker's and a background run's worktree are confined the same way.
  for (const [kind, name] of [['worker', 'w-tools001'], ['background', 'b-tools001']]) {
    const w = addWorktree(f, { kind, id: `wt-${kind}`, name, owner: {} });
    const exec = (await tools({ root: w.root, isolated: true, permissionScope: kind === 'background' ? 'background' : 'foreground' }))('project_exec');
    const result = async command => (await exec.execute('c', { command })).details;
    assert.equal((await result('echo ok > own.txt')).exitCode, 0, kind); assert.ok(existsSync(join(w.root, 'own.txt')));
    assert.notEqual((await result(`echo x > ${JSON.stringify(join(s.root, 'made.txt'))}`)).exitCode, 0, `${kind}: another worktree is out of reach`);
    assert.notEqual((await result(`echo x > ${JSON.stringify(join(f.P, 'README.md'))}`)).exitCode, 0, `${kind}: P is out of reach`);
  }
  assert.equal(readFileSync(join(s.root, 'made.txt'), 'utf8'), 'ok\n');
  // Foreground in P: not sandboxed (0.62 behaviour); no root → P.
  const direct = await tools({});
  assert.equal((await direct('project_exec').execute('c', { command: 'true' })).details.sandboxed, false);
  assert.match((await direct('project_read').execute('r', { path: 'README.md' })).content[0].text, /hello/);
  // P's tools never reach Rna's worktrees (.rna is private).
  await assert.rejects(direct('project_read').execute('r', { path: '.rna/worktrees.nosync/s-tools001/README.md' }), { code: 'path_denied' });
  // A root that is not one of the project's worktrees is refused for an isolated registry.
  await assert.rejects(capabilities.registry(project, [], { includeMutations: true, root: f.directory, isolated: true }), { code: 'root_denied' });
});

test('rna-runtime: the registry gets the turn root, AGENTS.md comes from the project folder', { skip }, async t => {
  const f = fixture(t), calls = [], requests = [];
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-runtime1', owner: { sessionId: f.session.id } });
  writeFileSync(join(f.P, 'AGENTS.md'), 'FROM-P: the project folder copy.'); writeFileSync(join(s.root, 'AGENTS.md'), 'FROM-S: the worktree copy.');
  const real = new CapabilityService(f.store);
  const capabilityService = { configuration: () => real.configuration(), registry: async (project, tools, options) => { calls.push(options); return real.registry(project, tools, options); } };
  const provider = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'done' }; yield { type: 'usage', usage: { totalTokens: 2, input: 1, output: 1 } }; yield { type: 'done', stopReason: 'stop' }; };
  const handle = await createRnaRuntime({ project: f.store.state.projects.find(row => row.id === f.project.id), capabilityService, cwd: s.root, isolated: true, instructionsRoot: f.P, sessionId: f.session.id, projectId: f.project.id, stateDir: join(f.directory, 'rt'), provider,
    model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 64000, maxOutputTokens: 256, reasoning: 'off' }, apiKey: 'synthetic-test-key', compaction: false });
  t.after(() => handle.dispose());
  await handle.prompt('hello');
  assert.equal(calls[0].root, s.root); assert.equal(calls[0].isolated, true);
  assert.match(requests[0].systemPrompt, /FROM-P/); assert.doesNotMatch(requests[0].systemPrompt, /FROM-S/);
});

// §9 "基因守卫": guards read the written file in the turn's root.
test('gene guards run on the turn root', { skip }, async t => {
  const f = fixture(t);
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-guards01', owner: { sessionId: f.session.id } });
  write(f.P, '正文/1.md', '第一章\n夜巡者。\n'); write(s.root, '正文/1.md', '第一章\n守夜人。\n');
  const genes = new GeneStore(f.store), project = f.store.state.projects.find(row => row.id === f.project.id);
  const entry = { gene: { id: 'g1' }, tool: { id: 'guard', name: 'guard', description: 'guard', permission: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, script: GUARD_SCRIPT } };
  assert.equal((await genes.runGuard(project, entry, '正文/1.md', { root: s.root })).hits.length, 1, 'read in S');
  assert.equal((await genes.runGuard(project, entry, '正文/1.md')).hits.length, 0, 'no root: P');
  const seen = [], service = new GeneEvolutionService(f.store, { genes: { runGuard: async (_project, _entry, _path, options) => { seen.push(options); return { hits: [], summary: '' }; } } });
  await service.guardHook(f.project.id, { turnId: 't1', root: s.root }).run(entry, '正文/1.md');
  assert.equal(seen[0].root, s.root); assert.equal(seen[0].turnId, 't1');
});

// §9 "媒体生成、看图": saved and read in the root the turn's tools use.
test('media tools save into the root, image_analyze reads from it', { skip }, async t => {
  const f = fixture(t);
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-media001', owner: { sessionId: f.session.id } });
  const provider = f.store.configurationService.provider(null, { name: 'Media', protocol: 'openai', baseUrl: 'https://media.example.test/v1', apiKey: 'sk-synthetic-media', models: [] });
  const providerId = provider.id ?? provider.provider?.id ?? f.store.state.configuration.providers.at(-1).id;
  f.store.configurationService.update({ media: { image: { providerId, modelId: 'img' } } });
  const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const media = new MediaToolsService(f.store, { fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) });
  const project = f.store.state.projects.find(row => row.id === f.project.id);
  const [image] = media.createTools(project, { root: s.root }).filter(tool => tool.name === 'image_generate');
  const made = await image.execute('c1', { prompt: 'logo', path: 'assets/logo.png' });
  assert.equal(made.isError, undefined);
  assert.ok(existsSync(join(s.root, 'assets/logo.png'))); assert.equal(existsSync(join(f.P, 'assets/logo.png')), false);
  const vision = new VisionService(f.store, { autoProbe: false }); t.after(() => vision.close());
  writeFileSync(join(s.root, 'shot.png'), solidPng(4));
  const read = await vision.readImage({ project, sessionId: f.session.id, args: { path: 'shot.png' }, root: s.root });
  assert.equal(read.type, 'image');
  await assert.rejects(vision.readImage({ project, sessionId: f.session.id, args: { path: 'shot.png' } }), /无法读取/, 'without the root it reads P, where the file is not');
});

// §9 "终端": a conversation's terminal starts in its root and closes when that root changes.
test('terminals: a session terminal opens in its worktree, and closes when the session stops naming it', { skip }, async t => {
  const f = fixture(t), spawned = [];
  const pty = { spawn: (shell, args, options) => { const proc = { pid: 999999, options, onData() {}, onExit(fn) { proc.exit = fn; }, write() {}, resize() {}, kill() { proc.exit?.({ exitCode: 0 }); } }; spawned.push(proc); return proc; } };
  const terminals = new TerminalService(f.store, { pty, roots: f.roots, env: { ...process.env, SHELL: '/bin/sh' } }); t.after(() => terminals.close());
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-term0001', owner: { sessionId: f.session.id } });
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  const plain = terminals.create(f.project.id, {});
  assert.equal(plain.cwd, f.P, 'without a session: the project folder, synchronously as before');
  const inS = await terminals.create(f.project.id, { sessionId: f.session.id, cwd: 'src' });
  assert.equal(inS.cwd, join(s.root, 'src')); assert.equal(inS.sessionId, f.session.id); assert.equal(inS.worktreeId, 'wt-s');
  assert.equal(spawned.at(-1).options.cwd, join(s.root, 'src'));
  await assert.rejects(terminals.create(f.project.id, { sessionId: f.session.id, cwd: '../../../..' }), { code: 'TERMINAL_CWD_DENIED' });
  const terminal = terminals.terminals.get(inS.id);
  assert.equal(terminals.allowed(terminal), true);
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'missing' });
  assert.equal(terminals.allowed(terminal), false, 'the root changed: the terminal is closed');
  assert.equal(terminals.allowed(terminals.terminals.get(plain.id)), true, 'the project folder terminal is unaffected');
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'pending' });
  await assert.rejects(terminals.create(f.project.id, { sessionId: f.session.id }), { code: 'worktree_pending' });
});

// §9 "文件、原始文件、预览": reads go through the conversation's root; a scope ends when the session's root changes.
test('file reads with sessionId go through the session root; the scope checks the worktree record has not changed', { skip }, async t => {
  const f = fixture(t), inspection = new WorkspaceInspectionService(f.store, { roots: f.roots }); t.after(() => inspection.close());
  const s = addWorktree(f, { kind: 'session', id: 'wt-s', name: 's-files001', owner: { sessionId: f.session.id } });
  write(s.root, 'src/app.js', 'export const a = 2; // S\n');
  assert.match((await inspection.read(f.project.id, { path: 'src/app.js' })).content, /a = 1/, 'no session: P');
  assert.match((await inspection.read(f.project.id, { path: 'src/app.js', sessionId: f.session.id })).content, /a = 1/, 'direct-mode session: P');
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'active' });
  assert.match((await inspection.read(f.project.id, { path: 'src/app.js', sessionId: f.session.id })).content, /a = 2; \/\/ S/);
  assert.deepEqual((await inspection.list(f.project.id, { path: 'src', sessionId: f.session.id })).entries.map(row => row.name), ['app.js']);
  assert.equal((await inspection.raw(f.project.id, { path: 'src/app.js', sessionId: f.session.id })).bytes.toString(), 'export const a = 2; // S\n');
  const scope = await inspection.scope(f.project.id, { sessionId: f.session.id });
  assert.equal(scope.root, s.root); assert.equal(scope.project, f.P); assert.equal(inspection.current(scope), true);
  setSessionWorktree(f, f.session.id, { id: 'wt-s', state: 'missing' });
  assert.equal(inspection.current(scope), false, 'the session no longer names that worktree');
  await assert.rejects(inspection.read(f.project.id, { path: 'src/app.js', sessionId: f.session.id }), { code: 'worktree_missing' });
  // P's own listing never shows Rna's worktrees.
  assert.equal((await inspection.list(f.project.id, {})).entries.some(row => row.name === '.rna'), false);
});

// §9 acceptance: the project folder is named by `projectWorkspace(project.workspace)` only where P is meant.
test('static: projectWorkspace(project.workspace) appears only in the allowed places', () => {
  const here = fileURLToPath(new URL('..', import.meta.url));
  // Files where P is what is meant (or that another team converts in 0.63: builtin-agent-service for T3,
  // project-initiative-controller for T5; the lead tightens this list at integration).
  const allowed = new Set(['capability-service.mjs', 'project-initializer.mjs', 'project-learning-evidence.mjs', 'session-attachments.mjs', 'session-suggestions.mjs', 'builtin-agent-service.mjs', 'project-initiative-controller.mjs']);
  const offenders = readdirSync(here).filter(name => name.endsWith('.mjs') && !allowed.has(name) && /projectWorkspace\((?:project|session|current|row)\.workspace\)/.test(readFileSync(join(here, name), 'utf8')));
  assert.deepEqual(offenders, []);
  // capability-service: only the fallback for an empty root.
  const capability = readFileSync(join(here, 'capability-service.mjs'), 'utf8').split('\n').filter(line => line.includes('projectWorkspace(project.workspace)'));
  assert.ok(capability.every(line => /root \|\| projectWorkspace\(project\.workspace\)|realpathSync\(projectWorkspace\(project\.workspace\)\)/.test(line)), capability.join('\n'));
});
