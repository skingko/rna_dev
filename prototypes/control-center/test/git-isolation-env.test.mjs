import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git, put, read, skip } from './git-isolation-fixture.mjs';
import { ENGINE_CONFIG, driverOverrides, engineArgs, versionAtLeast, verifyGitFile } from '../git-isolation/env.mjs';
import { MERGE_LABELS, REFS } from '../git-isolation/index.mjs';

// The engine's environment and the isolation conditions (worktree design 0.63 §2, §3.1, §3.7, §13 "环境" and
// "静态"): no global or system config, no user program, explicit GIT_DIR for worktrees, waits before writing P.

const here = dirname(fileURLToPath(import.meta.url));

test('engine arguments, version gate and driver overrides are fixed tables', () => {
  assert.deepEqual(engineArgs().filter((_, index) => index % 2), ENGINE_CONFIG);
  assert.ok(engineArgs({ excludesFile: '/x/ignore' }).includes('core.excludesFile=/x/ignore'));
  assert.ok(ENGINE_CONFIG.includes('merge.conflictStyle=zdiff3') && ENGINE_CONFIG.includes('gc.auto=0'));
  assert.equal(versionAtLeast({ major: 2, minor: 39, patch: 5 }), true);
  assert.equal(versionAtLeast({ major: 2, minor: 38, patch: 0 }), true);
  assert.equal(versionAtLeast({ major: 2, minor: 37, patch: 9 }), false);
  assert.equal(versionAtLeast(null), false);
  assert.deepEqual(driverOverrides(['filter.lfs.clean', 'filter.lfs.smudge', 'merge.ours.driver']), ['filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false', 'merge.ours.driver=false']);
});

test('isolation conditions: ready, sandbox, repository, drivers — and a repository without commits qualifies', { skip }, async t => {
  const f = fixture(t, { commit: false, files: { 'a.txt': 'a\n' } });
  const enabled = await f.engine.isolation(f.project.id);
  assert.equal(enabled.enabled, true, JSON.stringify(enabled)); assert.match(enabled.git, /^\d+\.\d+\.\d+$/);
  f.engine.settings.ready = false; f.engine.eligible.clear();
  assert.equal((await f.engine.isolation(f.project.id)).reason, 'not_ready');
  f.engine.settings.ready = true; f.engine.settings.sandbox = () => false; f.engine.eligible.clear();
  assert.equal((await f.engine.isolation(f.project.id)).reason, 'sandbox_unavailable');
  f.engine.settings.sandbox = () => true; f.engine.eligible.clear();
  // A repository-local filter driver turns isolation off, and the cached answer notices the config change.
  assert.equal((await f.engine.isolation(f.project.id)).enabled, true);
  await new Promise(done => setTimeout(done, 20));
  git(f.repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  assert.equal((await f.engine.isolation(f.project.id)).reason, 'custom_git_drivers');
  git(f.repo, 'config', '--unset', 'filter.lfs.clean'); git(f.repo, 'config', 'merge.mine.driver', 'true');
  assert.equal((await f.engine.isolation(f.project.id)).reason, 'custom_git_drivers');
  // No repository at all.
  const plain = join(f.dir, 'plain'); mkdirSync(plain);
  const { project } = f.store.createProject({ name: 'Plain', workspace: plain, initiative: { enabled: false } });
  assert.equal((await f.engine.isolation(project.id)).reason, 'no_repository');
  rmSync(plain, { recursive: true });
  assert.equal((await f.engine.isolation(project.id)).reason, 'workspace_missing');
});

test('no user program runs: a global filter and a repository filter and merge driver are all left alone', { skip }, async t => {
  const f = fixture(t, { files: { '.gitattributes': '*.txt filter=fake merge=fake\n', 'a.txt': 'a\nb\nc\nd\ne\n' } });
  const marker = join(f.dir, 'ran'), global = join(f.dir, 'global.gitconfig'), program = join(f.dir, 'program.sh');
  writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  writeFileSync(global, `[filter "fake"]\n\tclean = ${program}\n\tsmudge = ${program}\n\trequired = true\n[merge "fake"]\n\tdriver = ${program}\n`);
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  // From here on the user's global config names the programs (the engine must not read it).
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; });
  put(w.root, 'a.txt', 'a\nb\nc\nd\nE\n'); put(f.workspace, 'a.txt', 'A\nb\nc\nd\ne\n');
  const final = await f.engine.snapshot(f.project.id, w);
  const request = { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: {}, mode: 'all', labels: MERGE_LABELS.worker('agent-0011223344'), incomingRoot: w };
  const outcome = await f.engine.apply(f.project.id, request);
  assert.equal(outcome.status, 'applied'); assert.equal(read(f.workspace, 'a.txt'), 'A\nb\nc\nd\nE\n');
  assert.equal(existsSync(marker), false, 'the global filter and merge driver never ran');
  // The same drivers configured in the repository itself: turned off in every engine command.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  for (const [key, value] of [['filter.fake.clean', program], ['filter.fake.smudge', program], ['filter.fake.required', 'true'], ['merge.fake.driver', program]]) git(f.repo, 'config', key, value);
  put(w.root, 'a.txt', 'a\nb\nc\nd\nE\nF\n');
  const again = await f.engine.snapshot(f.project.id, w);
  const second = await f.engine.apply(f.project.id, { ...request, base: final.commit, incoming: again.commit });
  assert.equal(second.status, "applied", JSON.stringify(second.conflicts));
  assert.equal(existsSync(marker), false, 'the repository\'s own filter and merge driver never ran');
  assert.equal(read(f.workspace, 'a.txt'), 'A\nb\nc\nd\nE\nF\n');
});

test('a worktree\'s .git file that was changed is found and put back before git runs there', { skip }, async t => {
  const f = fixture(t);
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  const file = join(w.workTree, '.git'), original = readFileSync(file, 'utf8');
  assert.deepEqual(await verifyGitFile(w.workTree, w.gitDir), { ok: true, repaired: false });
  writeFileSync(file, `gitdir: ${join(f.dir, 'elsewhere')}\n`);
  const warnings = [], warn = console.warn; console.warn = message => warnings.push(message);
  try { put(w.root, 'a.txt', 'changed\n'); await f.engine.snapshot(f.project.id, w); }
  finally { console.warn = warn; }
  assert.equal(readFileSync(file, 'utf8').trim(), original.trim(), 'put back from the record');
  assert.ok(warnings.some(message => /worktree_tampered/.test(message)));
  assert.equal(f.store.state.events.at(-1).type, 'worktree_tampered'); assert.equal(f.store.state.events.at(-1).worktreeId, 'agent-0011223344');
  rmSync(file); mkdirSync(file);
  assert.deepEqual(await verifyGitFile(w.workTree, w.gitDir), { ok: false, repaired: false }, 'a .git folder in its place is refused, never removed');
  await assert.rejects(f.engine.snapshot(f.project.id, w), error => error.code === 'worktree_missing');
});

test('writes into the project folder queue behind a git operation there and wait for Rna\'s own commands', { skip }, async t => {
  let running = 1;
  const f = fixture(t, { files: { 'a.txt': 'a\n' }, engine: { execRunning: () => running, execWaitMs: 150 } });
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('worker', 'agent-0011223344', seed.commit);
  put(w.root, 'a.txt', 'worker\n');
  const final = await f.engine.snapshot(f.project.id, w);
  const request = { target: f.root, base: seed.commit, incoming: final.commit, kind: 'worker', source: {}, mode: 'all', labels: MERGE_LABELS.worker('agent-0011223344') };
  // A command keeps running: the write waits for it, up to the limit, and then goes ahead (CAS still protects it).
  const started = Date.now();
  assert.equal((await f.engine.apply(f.project.id, request)).status, 'applied');
  assert.ok(Date.now() - started >= 140, 'waited for the running command');
  running = 0;
  // A rebase in progress: the apply waits, says why once, and goes ahead when it ends.
  put(w.root, 'a.txt', 'worker again\n');
  const second = await f.engine.snapshot(f.project.id, w);
  mkdirSync(join(f.commonDir, 'rebase-merge'));
  const waiting = [];
  let done = false;
  const pending = f.engine.apply(f.project.id, { ...request, base: final.commit, incoming: second.commit, onWaiting: operation => waiting.push(operation) }).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(done, false, 'queued while the rebase is in progress'); assert.deepEqual(waiting, ['rebase']);
  assert.equal(read(f.workspace, 'a.txt'), 'worker\n');
  rmSync(join(f.commonDir, 'rebase-merge'), { recursive: true });
  assert.equal((await pending).status, 'applied');
  assert.equal(read(f.workspace, 'a.txt'), 'worker again\n');
  // A user-started rollback is refused outright instead.
  mkdirSync(join(f.commonDir, 'rebase-merge'));
  await assert.rejects(f.engine.rollback(f.project.id, f.applies()[0].id, {}), error => error.code === 'git_operation_in_progress');
});

test('static: the engine and git init never run a git subcommand that talks to another repository', () => {
  const files = [...readdirSync(join(here, '..', 'git-isolation')).filter(name => name.endsWith('.mjs')).map(name => join(here, '..', 'git-isolation', name)), join(here, '..', 'git-init-service.mjs')];
  const network = /(['"`])(?:push|fetch|pull|clone|remote|ls-remote|send-pack|fetch-pack|archive)\1|\bgit\s+(?:push|fetch|pull|clone|remote)\b/;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, network, file);
  }
  assert.ok(files.length >= 9);
});

test('the repository lock is one FIFO with the panel\'s writes, and re-entrant within one chain of calls', { skip }, async t => {
  const f = fixture(t);
  const order = [];
  const seed = await f.engine.snapshot(f.project.id, f.root);
  // Nested: a pin under a lock already held does not wait for itself.
  await f.engine.lock(f.project.id, async () => { await f.engine.pin(f.project.id, [{ ref: REFS.worktree('w9', 'seed'), commit: seed.commit }]); order.push('nested'); });
  assert.equal(git(f.repo, 'rev-parse', 'refs/rna/wt/w9/seed').trim(), seed.commit);
  // The panel's own queue (WorkspaceGitService.serial) and the engine's are the same one.
  const located = await f.service.locateProject(f.project.id);
  let release;
  const panel = f.service.serial(located, () => new Promise(done => { release = done; order.push('panel'); }));
  const engine = f.engine.lock(f.project.id, async () => { order.push('engine'); });
  await new Promise(done => setTimeout(done, 50));
  assert.deepEqual(order, ['nested', 'panel'], 'the engine waits for the panel\'s write');
  release(); await panel; await engine;
  assert.deepEqual(order, ['nested', 'panel', 'engine']);
});

test('WorkspaceGitService.run takes the engine options: env, stdin, raw bytes and the engine settings', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  git(f.repo, 'config', 'user.name', 'Repository User');
  const input = await f.service.run(f.repo, ['hash-object', '--stdin'], { input: 'hello\n' });
  assert.equal(input.stdout.trim(), git(f.repo, 'hash-object', '--stdin', { input: 'hello\n' }).trim());
  const raw = await f.service.run(f.repo, ['cat-file', 'blob', 'HEAD:a.txt'], { raw: true });
  assert.ok(Buffer.isBuffer(raw.stdout)); assert.equal(raw.stdout.toString(), 'a\n');
  const env = await f.service.run(f.dir, ['rev-parse', '--git-dir'], { env: { GIT_DIR: f.commonDir } });
  assert.equal(env.stdout.trim(), f.commonDir, 'GIT_DIR from the caller, after the parent\'s are stripped');
  const engine = await f.service.run(f.repo, ['config', '--get', 'user.name'], { engine: true });
  assert.equal(engine.stdout.trim(), 'Rna Agent', 'the engine identity wins over the repository\'s');
  const style = await f.service.run(f.repo, ['config', '--get', 'merge.conflictStyle'], { engine: { config: ['filter.x.clean='] } });
  assert.equal(style.stdout.trim(), 'zdiff3');
  const plain = await f.service.run(f.repo, ['config', '--get', 'user.name']);
  assert.equal(plain.stdout.trim(), 'Repository User', 'without engine nothing changes');
});

test('the panel learns who a worktree belongs to from the injected registry lookup', { skip }, async t => {
  const f = fixture(t);
  const seed = await f.engine.snapshot(f.project.id, f.root);
  const w = f.worktree('session', 'sess0001', seed.commit, { owner: { sessionId: 's1' } });
  f.service.owners = path => (path === w.workTree ? { rna: true, owner: { sessionId: 's1' } } : { rna: false, owner: null });
  const listed = await f.service.worktrees(f.project.id);
  const mine = listed.worktrees.find(row => row.linked);
  assert.deepEqual([mine.rna, mine.owner], [true, { sessionId: 's1' }]);
  assert.deepEqual([listed.worktrees[0].rna, listed.worktrees[0].owner], [false, null]);
  f.service.owners = () => { throw new Error('registry unavailable'); };
  assert.equal((await f.service.worktrees(f.project.id)).worktrees.find(row => row.linked).rna, false, 'a failing lookup reads as not Rna\'s');
});

test('the user\'s global ignore rules still apply: the excludes file is read once and passed to every engine command', { skip }, async t => {
  const f = fixture(t, { files: { 'a.txt': 'a\n' } });
  const global = join(f.dir, 'global.gitconfig'), excludes = join(f.dir, 'global-ignore');
  writeFileSync(excludes, '*.secret\n'); writeFileSync(global, `[core]\n\texcludesFile = ${excludes}\n[user]\n\tname = Someone Else\n`);
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; });
  put(f.workspace, 'token.secret', 'never in a snapshot\n'); put(f.workspace, 'notes.md', 'yes\n');
  assert.equal(await f.engine.primeExcludes(), excludes);
  assert.equal(f.service.excludesFile, excludes, 'WorkspaceGitService keeps it for every engine: true command');
  const tree = git(f.repo, 'ls-tree', '-r', '--name-only', (await f.engine.snapshot(f.project.id, f.root)).tree);
  assert.match(tree, /notes\.md/); assert.doesNotMatch(tree, /token\.secret/);
  const name = await f.service.run(f.repo, ['config', '--get', 'user.name'], { engine: true });
  assert.equal(name.stdout.trim(), 'Rna Agent', 'the rest of the global config stays out');
});
