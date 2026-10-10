import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server.mjs';
import { WorkspaceGitService } from '../workspace-git-service.mjs';
import { GitInitService, GITIGNORE_HEADER, ecosystemLines, exactPattern, secretLines, venvLines } from '../git-init-service.mjs';
import { LIMITS } from '../git-isolation/contract.mjs';

// Temporary folders only. Neither the user's git configuration (global, system, or ~/.config/git/ignore) nor their
// projects ever shape these results: every test names its own global config file.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rna-git-init-test-')));
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.XDG_CONFIG_HOME = join(scratch, 'xdg');
const IDENTITY = '[user]\n\tname = Test User\n\temail = test@example.com\n';
/** Points git's global config at a fresh file holding `text` for the rest of the test. */
const globalConfig = (text = IDENTITY) => { const path = join(scratch, `global-${randomUUID()}`); writeFileSync(path, text); process.env.GIT_CONFIG_GLOBAL = path; return path; };
const gitEnv = () => { const env = { ...process.env, LC_ALL: 'C' }; for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/.test(key)) delete env[key]; return env; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, path, content = `${path}\n`) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
const large = (root, path, bytes = LIMITS.initLargeFileBytes) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), ''); truncateSync(join(root, path), bytes); };
const nestedRepository = (root, path) => { mkdirSync(join(root, path), { recursive: true }); git(join(root, path), 'init', '-q'); write(join(root, path), 'n.txt'); git(join(root, path), 'add', '-A'); git(join(root, path), 'commit', '-q', '-m', 'nested'); };
const tracked = cwd => git(cwd, 'ls-files', '-z').split('\0').filter(Boolean).sort();

/** Every entry under `root` with its mode, size, mtime and (small files) content hash: a byte-level picture of the tree. */
function tree(root) {
  const rows = [['.', lstatSync(root).mtimeMs]];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), info = lstatSync(path);
      rows.push([relative(root, path), info.mode, info.size, info.mtimeMs, info.isFile() && info.size < 1024 * 1024 ? createHash('sha256').update(readFileSync(path)).digest('hex') : null]);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return rows;
}

async function setup(t, { workspace: makeWorkspace, folder = 'workspace' } = {}) {
  const directory = realpathSync(mkdtempSync(join(scratch, 'case-'))), workspace = join(directory, folder);
  mkdirSync(workspace, { recursive: true });
  makeWorkspace?.(workspace, directory);
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, runtime: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const project = (path = workspace, name = 'Init') => app.store.createProject({ name, workspace: path, initiative: { enabled: false } }).project;
  const port = app.server.address().port;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const init = (projectId, body = {}) => call('POST', `/api/v2/projects/${projectId}/git/init`, body);
  return { app, directory, workspace, project, call, init };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body; };
const lineTexts = preview => preview.gitignore.lines.map(line => line.text);
const lineOf = (preview, text) => preview.gitignore.lines.find(line => line.text === text);

test('exact lines escape what .gitignore reads specially; marker files and virtual environments map to fixed lines', () => {
  assert.equal(exactPattern('big.bin'), '/big.bin');
  assert.equal(exactPattern('a dir/#x [1]*?!.bin'), '/a dir/\\#x \\[1]\\*\\?\\!.bin');
  assert.equal(exactPattern(' lead and trail  '), '/\\ lead and trail\\ \\ ');
  assert.equal(exactPattern('back\\slash'), '/back\\\\slash');
  assert.equal(exactPattern('vendor/lib', { folder: true }), '/vendor/lib/');
  assert.equal(exactPattern('line\nbreak'), '/line?break');
  assert.deepEqual(ecosystemLines(['notes.md', 'chapter/build/1.md']), [], 'no marker file, no build output lines');
  const node = ecosystemLines(['web/package.json', 'package.json', 'src/a.js']);
  assert.deepEqual(node.map(row => row.text), ['dist/', 'build/', 'out/', 'coverage/', '.cache/', '.next/', '.nuxt/', '.svelte-kit/', '.vite/', '.turbo/', '.parcel-cache/', '*.log']);
  assert.ok(node.every(row => row.rule === 'ecosystem' && row.marker === 'package.json'), 'the shallowest marker is named');
  const mixed = ecosystemLines(['requirements.txt', 'package.json', 'Cargo.toml', 'app/build.gradle.kts', 'g/project.godot']);
  assert.equal(mixed.filter(row => row.text === 'build/').length, 1, 'a line shared by two ecosystems is proposed once');
  assert.equal(mixed.find(row => row.text === 'build/').marker, 'package.json');
  for (const text of ['__pycache__/', '*.pyc', 'target/', '.gradle/', '.godot/', '.import/']) assert.ok(mixed.some(row => row.text === text), text);
  assert.deepEqual(ecosystemLines(['ProjectSettings/ProjectVersion.txt']).map(row => row.text), ['/[Ll]ibrary/', '/[Tt]emp/', '/[Oo]bj/', '/[Bb]uild*/', '/[Ll]ogs/', '/[Uu]ser[Ss]ettings/']);
  assert.equal(ecosystemLines(['games/my game/ProjectSettings/ProjectVersion.txt'])[0].text, '/games/my game/[Ll]ibrary/', 'Unity lines are anchored at its project folder');
  assert.deepEqual(venvLines(['.venv/pyvenv.cfg', 'tools/venv/pyvenv.cfg', 'other/pyvenv.cfg', 'env/pyvenv.cfg']), [{ text: '/.venv/', rule: 'venv', path: '.venv/' }, { text: '/tools/venv/', rule: 'venv', path: 'tools/venv/' }]);
});

test('the preview writes nothing into the folder and lists exactly what the first commit would hold', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => {
    write(root, 'a.txt'); write(root, '.env'); write(root, '.env.example'); write(root, '.env.local'); write(root, '.DS_Store'); write(root, 'docs/.DS_Store');
    write(root, 'node_modules/x/index.js', 'module.exports = 1;\n'); write(root, 'build/chapter.md'); write(root, 'out/notes.md'); write(root, 'docs/中文 文件.md');
    large(root, 'big.bin'); write(root, 'small.bin', 'tiny\n'); nestedRepository(root, 'vendor/lib');
    write(root, '.venv/pyvenv.cfg', 'home = /usr/bin\n'); write(root, '.venv/lib/site.py');
  } });
  const project = f.project(), before = tree(f.workspace);
  const preview = ok(await f.init(project.id));
  assert.deepEqual(tree(f.workspace), before, 'not one byte, name or timestamp changed');
  assert.equal(existsSync(join(f.workspace, '.git')), false);
  assert.match(preview.confirm, /^[a-f0-9]{32}$/);
  assert.ok(Math.abs(Date.parse(preview.expiresAt) - Date.now() - LIMITS.gitInitTokenMs) < 60000);
  assert.deepEqual([preview.folder, preview.branch, preview.identity, preview.identityRequired, preview.icloud, preview.needsAcknowledge, preview.outer], [f.workspace, 'main', { name: 'Test User', email: 'test@example.com' }, false, false, false, undefined]);
  assert.equal(preview.gitignore.exists, false);
  assert.deepEqual(preview.gitignore.lines.map(line => [line.text, line.rule]), [['.DS_Store', 'always'], ['.env*', 'always'], ['node_modules/', 'always'], ['/.venv/', 'venv'], ['/big.bin', 'large'], ['/vendor/lib/', 'nested']]);
  assert.ok(!lineTexts(preview).some(text => /build|out/.test(text)), 'no marker file: build/ and out/ stay (they may be content)');
  assert.deepEqual([lineOf(preview, '.env*').count, lineOf(preview, '.DS_Store').count, lineOf(preview, 'node_modules/').count, lineOf(preview, '/.venv/').count, lineOf(preview, '/vendor/lib/').count], [3, 2, 1, 2, 1], '.env.example is ignored too');
  assert.deepEqual([lineOf(preview, '/big.bin').count, lineOf(preview, '/big.bin').bytes], [1, LIMITS.initLargeFileBytes]);
  assert.deepEqual(preview.largeFiles, [{ path: 'big.bin', bytes: LIMITS.initLargeFileBytes }]);
  assert.deepEqual(preview.nested, ['vendor/lib/']);
  // a.txt, build/chapter.md, out/notes.md, docs/中文 文件.md, small.bin and the new .gitignore.
  assert.equal(preview.files.count, 6);
  assert.deepEqual(preview.files.largest.map(row => row.path).sort(), ['a.txt', 'build/chapter.md', 'docs/中文 文件.md', 'out/notes.md', 'small.bin']);
  assert.ok(preview.files.bytes > 0 && preview.files.bytes < 1024);
});

test('the confirmation commits exactly the preview with the user\'s identity: template hooks off, unsigned, .rna excluded, recorded', async t => {
  const template = join(scratch, `template-${randomUUID()}`), hookRan = join(scratch, `hook-ran-${randomUUID()}`), excludes = join(scratch, `excludes-${randomUUID()}`);
  mkdirSync(join(template, 'hooks'), { recursive: true });
  writeFileSync(join(template, 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > '${hookRan}'\nexit 1\n`); chmodSync(join(template, 'hooks', 'pre-commit'), 0o755);
  writeFileSync(join(template, 'hooks', 'post-commit'), `#!/bin/sh\necho ran > '${hookRan}'\n`); chmodSync(join(template, 'hooks', 'post-commit'), 0o755);
  writeFileSync(join(template, 'config'), '[commit]\n\tgpgsign = true\n');
  writeFileSync(excludes, '*.secret\n');
  globalConfig(`${IDENTITY}[init]\n\tdefaultBranch = trunk\n\ttemplateDir = ${template}\n[core]\n\texcludesFile = ${excludes}\n`);
  const f = await setup(t, { workspace: root => {
    write(root, 'a.txt'); write(root, 'key.secret'); write(root, 'src/b.js'); large(root, 'media/huge.mov'); write(root, '.env'); write(root, '.rna/worktrees.nosync/w-1/x.txt');
    // Exact lines escape what the pattern syntax reads specially; git must agree, or the confirmation would fail.
    large(root, 'media/#odd [1]*?!.mov'); large(root, 'media/ lead.bin'); large(root, 'media/trail.bin  '); large(root, 'media/back\\slash.bin');
  } });
  const project = f.project(), preview = ok(await f.init(project.id));
  assert.equal(preview.branch, 'trunk');
  assert.equal(preview.files.count, 3, 'a.txt, src/b.js and .gitignore: global ignore rules and Rna\'s own folder count');
  const result = ok(await f.init(project.id, { confirm: preview.confirm }));
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  const largeFiles = [' lead.bin', '#odd [1]*?!.mov', 'back\\slash.bin', 'huge.mov', 'trail.bin  '].map(name => ({ path: `media/${name}`, bytes: LIMITS.initLargeFileBytes }));
  assert.deepEqual([result.branch, result.files, result.largeFiles, result.status, result.changed], ['trunk', 3, largeFiles, 'clean', undefined]);
  assert.deepEqual(tracked(f.workspace), ['.gitignore', 'a.txt', 'src/b.js']);
  assert.equal(readFileSync(join(f.workspace, '.gitignore'), 'utf8'), `${GITIGNORE_HEADER}\n.DS_Store\n.env*\nnode_modules/\n/media/ lead.bin\n/media/\\#odd \\[1]\\*\\?\\!.mov\n/media/back\\\\slash.bin\n/media/huge.mov\n/media/trail.bin\\ \\ \n`);
  assert.match(readFileSync(join(f.workspace, '.git', 'info', 'exclude'), 'utf8'), /^\/\.rna\/$/m);
  assert.equal(git(f.workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'trunk');
  assert.equal(git(f.workspace, 'log', '--format=%an|%ae|%cn|%s').trim(), 'Test User|test@example.com|Test User|初始提交（由 Rna Agent 创建）');
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD').trim(), result.commit);
  assert.doesNotMatch(git(f.workspace, 'cat-file', 'commit', 'HEAD'), /gpgsig/, 'not signed although the template asks for it');
  assert.equal(existsSync(hookRan), false, 'the template\'s hooks never ran');
  assert.equal(git(f.workspace, 'remote').trim(), '');
  assert.equal(git(f.workspace, 'status', '--porcelain').trim(), '');
  assert.throws(() => git(f.workspace, 'config', '--local', '--get-regexp', '^user\\.'), 'the global identity is not copied into the repository');
  const recorded = f.app.store.state.projects.find(row => row.id === project.id).git;
  assert.deepEqual({ ...recorded.init, at: undefined }, { at: undefined, by: 'rna', commit: result.commit, branch: 'trunk', largeFiles: largeFiles.map(file => file.path) });
  assert.ok(Date.parse(recorded.init.at));
  assert.deepEqual([recorded.sessionWorktreeDefault, recorded.worktrees, recorded.applies], [false, [], []]);
  // The panel reads the new repository at once; a second init is refused.
  assert.equal(ok(await f.call('GET', `/api/v2/projects/${project.id}/git`)).repo, 'main');
  const again = await f.init(project.id);
  assert.deepEqual([again.status, again.body.code], [409, 'git_init_already']);
});

test('an existing .gitignore gets one appended block, and a root re-include under .env* ends up ignored, as git will have it', async t => {
  globalConfig();
  const original = '# mine\n*.tmp\n!.env.example';
  const f = await setup(t, { workspace: root => { writeFileSync(join(root, '.gitignore'), original); write(root, '.env.example'); write(root, 'x.tmp'); write(root, 'keep.txt'); write(root, 'sub/.gitignore', '!.env.local\n'); write(root, 'sub/.env.local'); write(root, '# note'); } });
  const project = f.project(), preview = ok(await f.init(project.id));
  assert.equal(preview.gitignore.exists, true);
  // .gitignore, keep.txt, "# note", sub/.gitignore and sub/.env.local (a deeper .gitignore outranks the appended block).
  assert.equal(preview.files.count, 5);
  // A comment line stays a comment (and trailing spaces are dropped) however the lines are listed.
  const lines = ['# note', '.env*  ', 'node_modules/'];
  const edited = ok(await f.init(project.id, { lines }));
  assert.deepEqual(edited.gitignore.lines.map(line => line.rule), ['user', 'user', 'always']);
  assert.equal(edited.files.count, 5);
  const result = ok(await f.init(project.id, { confirm: edited.confirm, lines }));
  assert.equal(result.status, 'clean');
  assert.deepEqual(tracked(f.workspace), ['# note', '.gitignore', 'keep.txt', 'sub/.env.local', 'sub/.gitignore']);
  assert.equal(readFileSync(join(f.workspace, '.gitignore'), 'utf8'), `${original}\n\n${GITIGNORE_HEADER}\n# note\n.env*  \nnode_modules/\n`, 'the old content is kept byte for byte');
});

test('marker files add build output lines (Unity anchored at its folder); edited lines are listed again and the confirmation must carry them', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => {
    write(root, 'package.json', '{}\n'); write(root, 'dist/a.js'); write(root, 'build/b.js'); write(root, 'src/c.js'); write(root, 'debug.log');
    write(root, 'game/ProjectSettings/ProjectVersion.txt'); write(root, 'game/Library/x.asset'); write(root, 'Library/notes.md');
  } });
  const project = f.project(), preview = ok(await f.init(project.id));
  for (const text of ['dist/', 'build/', 'out/', '*.log']) assert.deepEqual([lineOf(preview, text).rule, lineOf(preview, text).marker], ['ecosystem', 'package.json'], text);
  assert.deepEqual([lineOf(preview, '/game/[Ll]ibrary/').marker, lineOf(preview, '/game/[Ll]ibrary/').count], ['game/ProjectSettings/ProjectVersion.txt', 1]);
  assert.deepEqual([lineOf(preview, 'dist/').count, lineOf(preview, 'build/').count, lineOf(preview, '*.log').count, lineOf(preview, 'out/').count], [1, 1, 1, 0]);
  // package.json, src/c.js, the Unity version file, Library/notes.md (not Unity's) and .gitignore.
  assert.equal(preview.files.count, 5);
  const lines = ['node_modules/', 'dist/', 'custom/'];
  const edited = ok(await f.init(project.id, { lines }));
  assert.deepEqual(edited.gitignore.lines.map(line => [line.text, line.rule]), [['node_modules/', 'always'], ['dist/', 'ecosystem'], ['custom/', 'user']]);
  assert.equal(edited.files.count, 8, 'build/b.js, debug.log and game/Library/x.asset come back');
  const without = await f.init(project.id, { confirm: edited.confirm });
  assert.deepEqual([without.status, without.body.code], [409, 'git_init_changed'], 'the confirmation lists with the lines it is given');
  assert.equal(existsSync(join(f.workspace, '.git')), false);
  const again = ok(await f.init(project.id, { lines }));
  const result = ok(await f.init(project.id, { confirm: again.confirm, lines }));
  assert.equal(result.files, 8);
  assert.equal(readFileSync(join(f.workspace, '.gitignore'), 'utf8'), `${GITIGNORE_HEADER}\nnode_modules/\ndist/\ncustom/\n`);
  assert.ok(tracked(f.workspace).includes('game/Library/x.asset'));
});

test('a folder inside another repository is refused, unless that repository ignores it or is the home dotfiles repository', async t => {
  globalConfig();
  const f = await setup(t, { folder: 'outer/proj', workspace: (root, directory) => { git(join(directory, 'outer'), 'init', '-q'); write(join(directory, 'outer'), 'top.txt'); write(root, 'a.txt'); } });
  const outer = join(f.directory, 'outer'), project = f.project();
  const refused = await f.init(project.id);
  assert.deepEqual([refused.status, refused.body.code, refused.body.repository], [409, 'git_init_inside_repo', outer]);
  assert.match(refused.body.error, /另一个 Git 仓库/);
  writeFileSync(join(outer, '.gitignore'), 'proj/\n');
  const preview = ok(await f.init(project.id));
  assert.deepEqual(preview.outer, { top: outer, kind: 'ignored' });
  ok(await f.init(project.id, { confirm: preview.confirm }));
  assert.deepEqual(tracked(f.workspace), ['.gitignore', 'a.txt']);
  assert.equal(git(outer, 'status', '--porcelain').trim(), '?? .gitignore\n?? top.txt'.trim(), 'the outer repository is untouched');

  // Ignored by pattern, but the outer repository already tracks files there: still inside it.
  const second = join(outer, 'tracked'); write(second, 'b.txt'); git(outer, 'add', 'tracked/b.txt'); writeFileSync(join(outer, '.gitignore'), 'proj/\ntracked/\n');
  const inside = await f.init(f.project(second, 'Tracked').id);
  assert.deepEqual([inside.status, inside.body.code], [409, 'git_init_inside_repo']);

  // A repository at the top of the home folder (dotfiles) does not count.
  const home = join(f.directory, 'home'), dotted = join(home, 'Projects', 'p');
  git(f.directory, 'init', '-q', home); write(dotted, 'p.txt');
  const service = new GitInitService(f.app.store, { home: () => home });
  const dotfiles = await service.init(f.project(dotted, 'Dotted').id, {});
  assert.deepEqual(dotfiles.outer, { top: home, kind: 'dotfiles' });
});

test('archived projects can be initialised; read-only projects, missing folders, home and Rna\'s own folders cannot', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => write(root, 'a.txt') });
  const archived = f.project();
  f.app.store.updateProject(archived.id, { archived: true });
  ok(await f.init(archived.id, { confirm: ok(await f.init(archived.id)).confirm }));
  assert.deepEqual(tracked(f.workspace), ['.gitignore', 'a.txt']);

  const readOnly = f.project(join(f.directory, 'ro'), 'ReadOnly'); mkdirSync(join(f.directory, 'ro'), { recursive: true });
  f.app.permissions.update(readOnly.id, { workspace: 'read', background: 'read' });
  const refused = await f.init(readOnly.id);
  assert.deepEqual([refused.status, refused.body.code], [403, 'git_read_only']);
  assert.equal((await f.init('nope')).status, 404);

  const gone = join(f.directory, 'gone'); mkdirSync(gone);
  const missing = f.project(gone, 'Gone'); rmSync(gone, { recursive: true });
  const gone409 = await f.init(missing.id);
  assert.deepEqual([gone409.status, gone409.body.code], [409, 'workspace_missing']);

  const state = join(f.directory, '.state', 'projects', 'p', 'workspace'); mkdirSync(state, { recursive: true });
  const inState = await f.init(f.project(state, 'State').id);
  assert.deepEqual([inState.status, inState.body.code], [403, 'git_init_folder_denied']);
  const holdsState = await f.init(f.project(f.directory, 'Holds').id);
  assert.deepEqual([holdsState.status, holdsState.body.code], [403, 'git_init_folder_denied'], 'a folder holding Rna\'s state (credentials) is refused');

  const plain = join(f.directory, 'plain', 'p'); mkdirSync(plain, { recursive: true }); write(plain, 'x.txt');
  const plainProject = f.project(plain, 'Plain');
  for (const home of [plain, join(plain, 'below')]) {
    const service = new GitInitService(f.app.store, { home: () => home });
    await assert.rejects(service.init(plainProject.id, {}), error => error.status === 403 && error.code === 'git_init_folder_denied');
  }
  const app = new GitInitService(f.app.store, { appRoot: dirname(plain) });
  await assert.rejects(app.init(plainProject.id, {}), error => error.code === 'git_init_folder_denied');
});

test('without a global identity the confirmation must bring one, which is saved in the new repository only', async t => {
  globalConfig('');
  const f = await setup(t, { workspace: root => write(root, 'a.txt') });
  f.app.store.interfaceLanguage('en');
  const project = f.project(), preview = ok(await f.init(project.id));
  assert.deepEqual([preview.identity, preview.identityRequired], [null, true]);
  const required = await f.init(project.id, { confirm: preview.confirm });
  assert.deepEqual([required.status, required.body.code], [400, 'git_init_identity_required']);
  assert.match(required.body.error, /Git identity/);
  for (const identity of [{ name: '<x>', email: 'x@example.com' }, { name: 'X', email: 'not an email' }, { name: 'X' }, { name: '...', email: 'a@b' }, { name: 'X', email: 'x@y', extra: 1 }]) {
    const invalid = await f.init(project.id, { confirm: preview.confirm, identity });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'git_init_identity_invalid'], JSON.stringify(identity));
  }
  assert.equal(existsSync(join(f.workspace, '.git')), false);
  const result = ok(await f.init(project.id, { confirm: preview.confirm, identity: { name: ' 张三 ', email: 'zhang@example.com' } }));
  assert.equal(git(f.workspace, 'config', '--local', 'user.name').trim(), '张三');
  assert.equal(git(f.workspace, 'config', '--local', 'user.email').trim(), 'zhang@example.com');
  assert.equal(git(f.workspace, 'log', '--format=%an|%ae|%s').trim(), '张三|zhang@example.com|Initial commit (created by Rna Agent)');
  assert.equal(result.status, 'clean');
});

test('tokens: a folder that changed is refused, used or expired tokens are refused, and large commits need acknowledging', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => { write(root, 'a.txt'); write(root, 'b.txt'); write(root, 'c.txt'); } });
  const project = f.project();
  const first = ok(await f.init(project.id));
  write(f.workspace, 'new.txt');
  const changed = await f.init(project.id, { confirm: first.confirm });
  assert.deepEqual([changed.status, changed.body.code], [409, 'git_init_changed']);
  const used = await f.init(project.id, { confirm: first.confirm });
  assert.deepEqual([used.status, used.body.code], [409, 'git_init_unconfirmed']);
  const touched = ok(await f.init(project.id));
  writeFileSync(join(f.workspace, 'a.txt'), 'edited\n');
  assert.equal((await f.init(project.id, { confirm: touched.confirm })).body.code, 'git_init_changed', 'an edited file changes the fingerprint too');
  assert.equal((await f.init(project.id, { confirm: 'f'.repeat(32) })).body.code, 'git_init_unconfirmed');
  assert.equal(existsSync(join(f.workspace, '.git')), false);

  let clock = Date.now();
  const timed = new GitInitService(f.app.store, { now: () => clock });
  const expiring = await timed.init(project.id, {});
  clock += LIMITS.gitInitTokenMs + 1;
  await assert.rejects(timed.init(project.id, { confirm: expiring.confirm }), error => error.status === 409 && error.code === 'git_init_unconfirmed');

  const small = new GitInitService(f.app.store, { limits: { ...LIMITS, initConfirmFiles: 3, initMaxFiles: 6 } });
  const big = await small.init(project.id, {});
  assert.deepEqual([big.files.count, big.needsAcknowledge], [5, true]);
  await assert.rejects(small.init(project.id, { confirm: big.confirm }), error => error.status === 409 && error.code === 'git_init_large_unacknowledged');
  await assert.rejects(small.init(project.id, { confirm: big.confirm, acknowledgeLarge: 'yes' }), error => error.code === 'git_request_invalid');
  write(f.workspace, 'd.txt'); write(f.workspace, 'e.txt');
  await assert.rejects(small.init(project.id, {}), error => error.status === 409 && error.code === 'git_init_too_many_files');
  rmSync(join(f.workspace, 'd.txt')); rmSync(join(f.workspace, 'e.txt'));
  const result = await small.init(project.id, { confirm: big.confirm, acknowledgeLarge: true });
  assert.equal(result.files, 5);
});

test('when git stages something the preview did not list, everything is undone: .git goes to the trash and .gitignore is restored', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => { writeFileSync(join(root, '.gitignore'), 'keep-out/\n'); write(root, 'a.txt'); } });
  const project = f.project(), runner = new WorkspaceGitService(f.app.store), run = runner.run.bind(runner);
  runner.run = (cwd, args, options) => { if (args[0] === 'add') write(f.workspace, 'surprise.txt'); return run(cwd, args, options); };
  const service = new GitInitService(f.app.store, { git: runner });
  const preview = await service.init(project.id, {});
  const error = await service.init(project.id, { confirm: preview.confirm }).then(() => null, failure => failure);
  assert.deepEqual([error?.status, error?.code, error?.details.stage], [500, 'git_init_failed', 'compare']);
  assert.deepEqual(error.details.differences, { unexpected: ['surprise.txt'], missing: [] });
  assert.equal(error.details.undone.git, 'trash');
  assert.equal(error.details.undone.gitignore, 'restored');
  assert.match(error.message, /\.rna\/trash\.nosync\/init-.*\.git/);
  assert.equal(existsSync(join(f.workspace, '.git')), false, 'no repository is left behind');
  assert.equal(readFileSync(join(f.workspace, '.gitignore'), 'utf8'), 'keep-out/\n');
  const trashed = join(f.workspace, error.details.undone.trash);
  assert.ok(existsSync(join(trashed, 'HEAD')), 'the .git folder was moved, not deleted');
  assert.match(error.details.undone.trash, /^\.rna\/trash\.nosync\/init-[^/]+\.git$/);
});

test('a failing git add is undone too: a .gitignore this run created is removed, and the route reports what was undone', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => { write(root, 'a.txt'); write(root, 'locked.txt'); chmodSync(join(root, 'locked.txt'), 0o000); } });
  const project = f.project(), preview = ok(await f.init(project.id));
  const failed = await f.init(project.id, { confirm: preview.confirm });
  chmodSync(join(f.workspace, 'locked.txt'), 0o644);
  assert.deepEqual([failed.status, failed.body.code, failed.body.stage], [500, 'git_init_failed', 'add']);
  assert.deepEqual(failed.body.undone, { git: 'trash', trash: failed.body.undone.trash, gitignore: 'removed' });
  assert.match(failed.body.git, /locked\.txt/);
  assert.equal(existsSync(join(f.workspace, '.git')), false);
  assert.equal(existsSync(join(f.workspace, '.gitignore')), false);
  // Rna's trash stays out of the next attempt's listing.
  const retry = ok(await f.init(project.id));
  assert.equal(retry.files.count, 3);
  ok(await f.init(project.id, { confirm: retry.confirm }));
  assert.deepEqual(tracked(f.workspace), ['.gitignore', 'a.txt', 'locked.txt']);
});

test('a .gitignore that appears during the confirmation is never overwritten; a linked .gitignore is refused up front', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => write(root, 'a.txt') });
  const project = f.project(), runner = new WorkspaceGitService(f.app.store), run = runner.run.bind(runner);
  runner.run = async (cwd, args, options) => { const result = await run(cwd, args, options); if (args[0] === 'init' && !args.includes('--bare')) writeFileSync(join(f.workspace, '.gitignore'), 'mine\n'); return result; };
  const service = new GitInitService(f.app.store, { git: runner });
  const preview = await service.init(project.id, {});
  const error = await service.init(project.id, { confirm: preview.confirm }).then(() => null, failure => failure);
  assert.deepEqual([error?.code, error?.details.stage, error?.details.undone.git, error?.details.undone.gitignore], ['git_init_failed', 'gitignore', 'trash', 'unchanged']);
  assert.equal(readFileSync(join(f.workspace, '.gitignore'), 'utf8'), 'mine\n', 'the user\'s file is left as they wrote it');
  assert.equal(existsSync(join(f.workspace, '.git')), false);

  const linked = join(f.directory, 'linked'); write(linked, 'a.txt'); write(linked, 'rules.txt', 'x\n'); symlinkSync('rules.txt', join(linked, '.gitignore'));
  const refused = await f.init(f.project(linked, 'Linked').id);
  assert.deepEqual([refused.status, refused.body.code], [403, 'git_init_folder_denied']);
});

test('request shape: unknown keys, malformed lines and a nested repository left in are refused', async t => {
  globalConfig();
  const f = await setup(t, { workspace: root => { write(root, 'a.txt'); nestedRepository(root, 'lib'); } });
  const project = f.project();
  const unknown = await f.init(project.id, { paths: ['a.txt'] });
  assert.deepEqual([unknown.status, unknown.body.code], [400, 'git_request_invalid']);
  for (const lines of ['x', [''], ['a\nb'], [7], ['   '], Array.from({ length: 2001 }, (_, index) => `l${index}`)]) {
    const refused = await f.init(project.id, { lines });
    assert.deepEqual([refused.status, refused.body.code], [400, 'git_init_lines_invalid'], JSON.stringify(lines).slice(0, 40));
  }
  const preview = ok(await f.init(project.id));
  assert.deepEqual(preview.nested, ['lib/']);
  const kept = await f.init(project.id, { lines: lineTexts(preview).filter(text => text !== '/lib/') });
  assert.deepEqual([kept.status, kept.body.code], [400, 'git_init_lines_invalid']);
  assert.match(kept.body.error, /lib/);
  // No lines at all is a valid choice: no .gitignore is written.
  const plain = join(f.directory, 'plain'); write(plain, 'a.txt');
  const bare = ok(await f.init(f.project(plain, 'Plain').id, { lines: [] }));
  assert.deepEqual([bare.gitignore.lines, bare.files.count], [[], 1]);
  const done = ok(await f.init(f.app.store.state.projects.find(row => row.name === 'Plain').id, { confirm: bare.confirm, lines: [] }));
  assert.equal(done.files, 1);
  assert.deepEqual(tracked(plain), ['a.txt']);
  assert.equal(existsSync(join(plain, '.gitignore')), false);
});

test('iCloud Drive is reported from the folder\'s place, not guessed', async t => {
  globalConfig();
  const f = await setup(t);
  const home = join(f.directory, 'home'), documents = join(home, 'Documents', 'novel'), drive = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'p'), elsewhere = join(home, 'Work', 'p');
  for (const folder of [documents, drive, elsewhere]) write(folder, 'a.txt');
  const service = new GitInitService(f.app.store, { home: () => home });
  const icloud = async folder => (await service.init(f.project(folder, `Cloud ${relative(home, folder).length}`).id, {})).icloud;
  assert.equal(await icloud(drive), true);
  assert.equal(await icloud(elsewhere), false);
  assert.equal(await icloud(documents), false, 'Documents is not synced while Desktop & Documents is off');
  mkdirSync(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents'), { recursive: true });
  assert.equal(await icloud(documents), true);
});

test('the init service never names a git subcommand that talks to another repository', () => {
  const source = readFileSync(new URL('../git-init-service.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:push|fetch|remote)\b/i);
});

test('files that hold secrets (B8, the SECRET_FILES table) are proposed as ignored, so Rna\'s first commit and every refs/rna commit after it never reach them', async t => {
  assert.deepEqual(secretLines(['a.txt', 'deploy/id_rsa', 'certs/server.pem', 'certs/ca.pem', 'config/prod.env', 'slides/deck.key/Index.zip', '.env.example', 'deploy/id_rsa.pub']).map(row => [row.text, row.rule, row.path]),
    [['*.env', 'secret', 'config/prod.env'], ['*.pem', 'secret', 'certs/server.pem'], ['*.key', 'secret', 'slides/deck.key/Index.zip'], ['id_rsa', 'secret', 'deploy/id_rsa']], 'table order, the first file each rule matched; the `!` exceptions and public keys are no secret files');
  assert.deepEqual(secretLines(['a.txt', '.env.example', 'vendor/lib/']), []);
  globalConfig();
  const secrets = { 'deploy/id_rsa': 'SYNTHETIC SSH KEY\n', 'certs/server.pem': 'SYNTHETIC PEM\n', 'config/prod.env': 'TOKEN=synthetic-init\n', 'slides/deck.key/Index.zip': 'SYNTHETIC KEYNOTE\n' };
  const f = await setup(t, { workspace: root => { write(root, 'a.txt'); write(root, '.env.example', 'TOKEN=\n'); for (const [path, content] of Object.entries(secrets)) write(root, path, content); } });
  const project = f.project(), preview = ok(await f.init(project.id));
  assert.deepEqual(preview.gitignore.lines.filter(line => line.rule === 'secret').map(line => [line.text, line.count]), [['*.env', 1], ['*.pem', 1], ['*.key', 1], ['id_rsa', 1]]);
  assert.equal(preview.files.count, 2, 'a.txt and the new .gitignore (.env.example stays under .env*)');
  const result = ok(await f.init(project.id, { confirm: preview.confirm }));
  assert.equal(result.status, 'clean');
  assert.deepEqual(tracked(f.workspace), ['.gitignore', 'a.txt']);
  // The acceptance check: no version of a secret file is an object of the new repository.
  const objects = new Set(git(f.workspace, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n').filter(Boolean));
  for (const content of Object.values(secrets)) assert.equal(objects.has(execFileSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).trim()), false, content.trim());
  assert.equal(objects.has(execFileSync('git', ['hash-object', '--stdin'], { input: 'a.txt\n', encoding: 'utf8' }).trim()), true, 'control: a.txt is in it');
});
