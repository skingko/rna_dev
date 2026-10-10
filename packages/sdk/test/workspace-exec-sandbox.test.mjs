import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync, lstatSync, copyFileSync, chmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { createWorkspaceTools, workspacePrivateSegment } from '../src/workspace-tools.mjs';
import { sandboxAvailable, sandboxProfile, EXEC_DESCRIPTION, workspaceExecEnvironment, SANDBOX_EXEC, SANDBOX_PROBE_RETRY_MS } from '../src/workspace-exec.mjs';

// Plan 2026-09-30 §4.4: background commands run in the macOS sandbox; writes
// outside the project (and temp folders / package caches) are denied.
test('sandbox profile allows the project, temp folders and caches only', () => {
  const profile = sandboxProfile('/work/p "q"', { home: '/Users/x' });
  assert.match(profile, /\(deny file-write\*\)/); assert.match(profile, /\(subpath "\/work\/p \\"q\\""\)/); assert.match(profile, /\(subpath "\/Users\/x\/\.npm"\)/);
  assert.doesNotMatch(profile, /subpath "\/Users\/x"\)/, 'never the whole home');
  // Worktree design 0.63 §9: build caches too, and the root's own .git is never writable (last rule wins).
  for (const cache of ['Library/Developer/Xcode/DerivedData', '.gradle', '.m2', 'go/pkg/mod']) assert.ok(profile.includes(`(subpath "/Users/x/${cache}")`), cache);
  assert.match(profile.split('\n').at(-1), /^\(deny file-write\* \(literal "\/work\/p \\"q\\"\/\.git"\)\)$/);
});

test('a deny list is denied after the allowances, the root stays writable inside it, and .git comes last', () => {
  const lines = sandboxProfile('/p/.rna/worktrees.nosync/w-1', { home: '/Users/x', extra: ['/extra'], deny: ['/p'] }).split('\n');
  const at = text => lines.findIndex(line => line.includes(text));
  assert.ok(lines[at('(allow file-write* (subpath "/p/.rna')].includes('(subpath "/extra")'));
  assert.equal(lines[at('(deny file-write* (subpath "/p")')], '(deny file-write* (subpath "/p"))');
  assert.ok(at('(deny file-write* (subpath "/p")') < at('(allow file-write* (subpath "/p/.rna/worktrees.nosync/w-1"))'));
  assert.equal(lines.at(-1), '(deny file-write* (literal "/p/.rna/worktrees.nosync/w-1/.git"))');
  assert.equal(sandboxProfile('/r', { deny: [] }).includes('(allow file-write* (subpath "/r"))'), false, 'no re-allowance without a deny list');
});

test('project_exec has one fixed description, sandboxed or not (one cached prefix for every purpose)', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-exec-text-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const description = async options => (await createWorkspaceTools(root, { includeMutations: true, ...options })).find(tool => tool.name === 'project_exec').description;
  assert.equal(await description({}), EXEC_DESCRIPTION);
  assert.equal(await description({ sandbox: true, sandboxDeny: [root] }), EXEC_DESCRIPTION);
  await assert.rejects(createWorkspaceTools(root, { includeMutations: true, sandbox: true, sandboxDeny: ['relative'] }), /sandboxDeny must list absolute paths/);
});

test('.rna is a private segment: project tools never reach worktrees or the trash', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-private-rna-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(workspacePrivateSegment('.rna'), true); assert.equal(workspacePrivateSegment('.RNA'), true);
  assert.equal(workspacePrivateSegment('.rna-notes'), false); assert.equal(workspacePrivateSegment('w-1a2b3c4d'), false);
  mkdirSync(join(root, '.rna/worktrees.nosync/w-1'), { recursive: true }); writeFileSync(join(root, '.rna/worktrees.nosync/w-1/a.txt'), 'copy');
  const tools = await createWorkspaceTools(root, { includeMutations: true }), get = name => tools.find(tool => tool.name === name);
  await assert.rejects(get('project_read').execute('r', { path: '.rna/worktrees.nosync/w-1/a.txt' }), { code: 'path_denied' });
  assert.equal((await get('project_write').execute('w', { path: '.rna/x.txt', content: 'x' })).details.code, 'path_denied');
  assert.doesNotMatch((await get('project_list').execute('l', {})).content[0].text, /\.rna/);
  // A tool rooted in the worktree itself sees its files under their own relative paths.
  const inside = await createWorkspaceTools(join(root, '.rna/worktrees.nosync/w-1'));
  assert.match((await inside.find(tool => tool.name === 'project_read').execute('r', { path: 'a.txt' })).content[0].text, /copy/);
});

test('a sandboxed command writes inside the project and is denied outside it', { skip: !sandboxAvailable() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-'))), outside = join(homedir(), `.rna-sandbox-probe-${process.pid}`);
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { force: true }); });
  const tools = await createWorkspaceTools(root, { includeMutations: true, sandbox: true });
  const exec = tools.find(tool => tool.name === 'project_exec');
  const inside = await exec.execute('c1', { command: 'echo ok > inside.txt && cat inside.txt' });
  assert.equal(inside.details.exitCode, 0); assert.equal(inside.details.sandboxed, true); assert.ok(existsSync(join(root, 'inside.txt')));
  assert.doesNotMatch(inside.content[0].text, /ran sandboxed/, 'the note rides only on failures');
  const denied = await exec.execute('c2', { command: `touch ${JSON.stringify(outside)}` });
  assert.notEqual(denied.details.exitCode, 0); assert.equal(existsSync(outside), false);
  assert.match(denied.content[0].text, /This command ran sandboxed/);
  const plain = (await createWorkspaceTools(root, { includeMutations: true })).find(tool => tool.name === 'project_exec');
  assert.equal((await plain.execute('c3', { command: 'true' })).details.sandboxed, false, 'foreground commands are not sandboxed');
});

// Worktree design 0.63 §9 / risk §14-3: a worktree inside the project folder. The folder around it is denied (even
// when it lies under a temporary folder), the worktree's .git link cannot be changed, and a hard link to a project
// file cannot be made from inside, so nothing writes through to the project folder.
test('in a worktree root: the project folder, .git and hard links are out of reach', { skip: !sandboxAvailable() }, async t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-project-'))), root = join(project, '.rna/worktrees.nosync/w-1');
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true }); writeFileSync(join(project, 'f.txt'), 'orig\n'); writeFileSync(join(root, '.git'), 'gitdir: /somewhere\n');
  const exec = (await createWorkspaceTools(root, { includeMutations: true, sandbox: true, sandboxDeny: [project] })).find(tool => tool.name === 'project_exec');
  const run = async command => (await exec.execute('c', { command })).details.exitCode;
  assert.notEqual(await run(`echo x > ${JSON.stringify(join(project, 'f.txt'))}`), 0, 'echo x > <P>/f fails');
  assert.notEqual(await run(`echo x > ${JSON.stringify(join(project, 'new.txt'))}`), 0);
  assert.notEqual(await run('echo x > .git'), 0, 'echo x > .git fails');
  assert.notEqual(await run('rm -f .git'), 0); assert.notEqual(await run('mv .git moved'), 0);
  assert.notEqual(await run(`ln ${JSON.stringify(join(project, 'f.txt'))} hard`), 0, 'no hard link to a project file');
  await run('echo pwned >> hard');
  await run(`ln -s ${JSON.stringify(join(project, 'f.txt'))} soft; echo pwned >> soft`);
  assert.equal(readFileSync(join(project, 'f.txt'), 'utf8'), 'orig\n', 'the project file is untouched');
  assert.equal(readFileSync(join(root, '.git'), 'utf8'), 'gitdir: /somewhere\n');
  assert.equal(existsSync(join(project, 'new.txt')), false);
  assert.equal(await run('mkdir -p sub && echo ok > sub/inside.txt'), 0, 'the worktree itself stays writable');
  assert.equal(lstatSync(join(root, 'sub/inside.txt')).isFile(), true);
});

// Alignment 2026-10-05 A6 (pi sandbox example index.ts:72-76; harness sandbox-local index.ts:86-87, 210, 240): a
// sandboxed command can neither read nor write the host's private paths or ~/.ssh, ~/.aws and ~/.gnupg (a package
// folder inside them may be re-allowed for reading); the denial note rides only on "Operation not permitted"; a
// runner failure is reported as such; a run that requires the sandbox refuses when it is unavailable.
test('the profile makes private paths and credential folders unreadable, re-allows packages for reading, and keeps .git last', () => {
  const lines = sandboxProfile('/r', { home: '/Users/x', denyRead: ['/s/state.json', '/s/state.json.secrets'], readable: ['/s/state.json.capabilities'] }).split('\n');
  const deny = lines.findIndex(line => line.startsWith('(deny file-read* file-write*')), allow = lines.findIndex(line => line.startsWith('(allow file-read*'));
  assert.equal(lines[deny], '(deny file-read* file-write* (subpath "/s/state.json") (subpath "/s/state.json.secrets") (subpath "/Users/x/.ssh") (subpath "/Users/x/.aws") (subpath "/Users/x/.gnupg"))');
  assert.equal(lines[allow], '(allow file-read* (subpath "/s/state.json.capabilities"))'); assert.ok(deny < allow);
  assert.ok(lines.findIndex(line => line.startsWith('(allow file-write* (subpath "/r")')) < deny, 'after every write allowance');
  assert.equal(lines.at(-1), '(deny file-write* (literal "/r/.git"))');
});

test('a sandboxed command cannot read private paths or credential folders; the note rides only on a real denial', { skip: !sandboxAvailable() }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-private-'))), root = join(dir, 'project'), home = join(dir, 'home'), state = join(dir, 'state', 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of [root, join(home, '.ssh'), join(home, '.aws'), `${state}.d`, `${state}.capabilities/skill`]) mkdirSync(folder, { recursive: true });
  writeFileSync(state, '{"sessions":[]}'); writeFileSync(`${state}.secrets`, 'synthetic-secret'); writeFileSync(`${state}.d/s.json`, 'session');
  writeFileSync(join(home, '.ssh', 'id_test'), 'synthetic-private-key'); writeFileSync(join(home, '.aws', 'credentials'), 'synthetic'); writeFileSync(`${state}.capabilities/skill/tool.sh`, 'echo skill-ok\n');
  const previous = process.env.HOME; process.env.HOME = home;
  let tools; try { tools = await createWorkspaceTools(root, { includeMutations: true, sandbox: true, deniedPaths: [state, `${state}.secrets`, `${state}.d`, `${state}.capabilities`], sandboxReadable: [`${state}.capabilities`] }); }
  finally { process.env.HOME = previous; }
  const exec = tools.find(tool => tool.name === 'project_exec'), run = async command => { const result = await exec.execute('c', { command }); return { ...result.details, text: result.content[0].text }; };
  for (const path of [state, `${state}.secrets`, `${state}.d/s.json`, join(home, '.ssh', 'id_test'), join(home, '.aws', 'credentials')]) {
    const read = await run(`cat ${JSON.stringify(path)}`);
    assert.notEqual(read.exitCode, 0, path); assert.doesNotMatch(read.text, /synthetic|session/, path); assert.equal(read.sandboxDenied, true, path); assert.match(read.text, /an operation was denied/);
  }
  assert.notEqual((await run(`echo x > ${JSON.stringify(`${state}.secrets`)}`)).exitCode, 0, 'not writable either');
  assert.equal(readFileSync(`${state}.secrets`, 'utf8'), 'synthetic-secret');
  const skill = await run(`sh ${JSON.stringify(`${state}.capabilities/skill/tool.sh`)}`);
  assert.equal(skill.exitCode, 0); assert.match(skill.text, /skill-ok/);
  assert.notEqual((await run(`echo x > ${JSON.stringify(`${state}.capabilities/skill/tool.sh`)}`)).exitCode, 0, 'a readable package stays read-only');
  // A failure that is not a denial gets no sandbox note.
  const plain = await run('echo broken >&2; exit 3');
  assert.equal(plain.exitCode, 3); assert.equal(plain.sandboxDenied, undefined); assert.doesNotMatch(plain.text, /ran sandboxed|sandbox could not/);
  // Unsandboxed, the same files are readable: the sandbox is what denies them.
  const open = (await createWorkspaceTools(root, { includeMutations: true })).find(tool => tool.name === 'project_exec');
  assert.match((await open.execute('c', { command: `cat ${JSON.stringify(`${state}.secrets`)}` })).content[0].text, /synthetic-secret/);
});

test('a run that requires the sandbox refuses to run unconfined when sandbox-exec is unavailable', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-missing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exec = (await createWorkspaceTools(root, { includeMutations: true, sandbox: true, sandboxExec: join(root, 'no-sandbox-exec') })).find(tool => tool.name === 'project_exec');
  const result = await exec.execute('c', { command: 'echo ran > ran.txt' });
  assert.equal(result.isError, true); assert.equal(result.details.code, 'sandbox_unavailable'); assert.equal(result.details.started, false); assert.equal(result.details.sandboxed, false);
  assert.match(result.content[0].text, /must use the macOS sandbox/); assert.equal(existsSync(join(root, 'ran.txt')), false);
  assert.equal(sandboxAvailable(join(root, 'no-sandbox-exec')), false, 'probed by running it, not by its path alone');
});

test('a sandbox runner failure is reported as one, not as the command\'s own denial', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-runner-'))), runner = join(root, 'fake-sandbox-exec');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Passes the startup probe (it runs `true`), then fails the way sandbox-exec itself does.
  writeFileSync(runner, '#!/bin/sh\nfor a in "$@"; do [ "$a" = /usr/bin/true ] && exit 0; done\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 71\n', { mode: 0o755 });
  const exec = (await createWorkspaceTools(root, { includeMutations: true, sandbox: true, sandboxExec: runner })).find(tool => tool.name === 'project_exec');
  const result = await exec.execute('c', { command: 'true' });
  assert.equal(result.isError, true); assert.equal(result.details.sandboxFault, true); assert.match(result.content[0].text, /macOS sandbox could not run this command/); assert.doesNotMatch(result.content[0].text, /an operation was denied/);
});

test('credential variables the host withholds never reach a command', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-exec-env-'))), name = 'RNA_A6_SYNTHETIC_PROVIDER_KEY', previous = process.env[name];
  process.env[name] = 'synthetic-value-not-a-key';
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const output = async options => (await (await createWorkspaceTools(root, { includeMutations: true, ...options })).find(tool => tool.name === 'project_exec').execute('c', { command: `echo "\${${name}:-absent}"` })).content[0].text;
  assert.match(await output({}), /synthetic-value-not-a-key/);
  assert.match(await output({ withheldEnv: [name] }), /\nabsent\n?$/);
  const environment = workspaceExecEnvironment({ PATH: '/usr/bin', KEEP: '1', [name]: 'x' }, process.execPath, { withheld: [name] });
  assert.equal(environment.KEEP, '1'); assert.equal(Object.hasOwn(environment, name), false);
  // Review 2026-10-05 (tool-safety): the result names what was withheld (names only, and only ones the command would have
  // inherited), and a failing command's header says so, so a "missing API key" error is not a mystery.
  const run = async command => (await (await createWorkspaceTools(root, { includeMutations: true, withheldEnv: [name, 'RNA_A6_SYNTHETIC_UNSET_NAME'] })).find(tool => tool.name === 'project_exec').execute('c', { command }));
  const failed = await run(`test -n "\${${name}}"`);
  assert.equal(failed.isError, true); assert.deepEqual(failed.details.withheldEnv, [name]);
  assert.match(failed.content[0].text, new RegExp(`Rna did not pass its credential variables ${name} to this command`)); assert.doesNotMatch(failed.content[0].text, /synthetic-value-not-a-key|RNA_A6_SYNTHETIC_UNSET_NAME/);
  const passed = await run('true');
  assert.equal(passed.isError, false); assert.deepEqual(passed.details.withheldEnv, [name]); assert.doesNotMatch(passed.content[0].text, /did not pass/);
});

// Review 2026-10-05 (tool-safety), follow-ups to A6.
const execFileAsync = promisify(execFile);
const outputOf = result => result.content[0].text.split('\n\n').slice(1).join('\n\n');

test('the profile denies path prefixes and ports, and lets a readable path\'s folders be stat()ed', () => {
  const lines = sandboxProfile('/r', { home: '/Users/x', denyRead: ['/s/state.json'], denyPrefixes: ['/s (1)/state.json.'], readable: ['/s/state.json.service/node'], denyPorts: [4317, 4317] }).split('\n');
  const at = prefix => lines.findIndex(line => line.startsWith(prefix));
  assert.match(lines[at('(deny file-read* file-write*')], / \(regex #"\^\/s \\\(1\\\)\/state\\\.json\\\."\)\)$/);
  assert.equal(lines[at('(allow file-read-metadata')], '(allow file-read-metadata (literal "/s/state.json.service") (literal "/s"))');
  assert.equal(lines[at('(deny network-outbound')], '(deny network-outbound (remote ip "*:4317"))');
  assert.ok(at('(deny file-read* file-write*') < at('(allow file-read* ') && at('(allow file-read* ') < at('(allow file-read-metadata'));
  assert.equal(lines.at(-1), '(deny file-write* (literal "/r/.git"))');
  assert.equal(sandboxProfile('/r', {}).includes('network-outbound'), false, 'no port rule without ports');
});

test('a sandboxed command runs on the daemon\'s own Node even when that Node lives inside a denied folder', { skip: !sandboxAvailable(), timeout: 60000 }, async t => {
  // A maintenance-applied daemon runs <state>.service/node/<id>/node (runtime-release.mjs sharedNodeLocation), and
  // workspaceExecEnvironment puts that folder first on PATH.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-runtime-'))), state = join(dir, 'state', 'state.json'), runtime = join(`${state}.service`, 'node', 'v'), root = join(dir, 'project');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(runtime, { recursive: true }); mkdirSync(root);
  const node = join(runtime, 'node'); copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE); chmodSync(node, 0o755);
  writeFileSync(`${state}.service/config.json`, 'synthetic-service-receipt');
  const script = join(dir, 'run.mjs'), tools = new URL('../src/workspace-tools.mjs', import.meta.url).href;
  writeFileSync(script, [
    `import { createWorkspaceTools } from ${JSON.stringify(tools)};`,
    `const exec = (await createWorkspaceTools(${JSON.stringify(root)}, { includeMutations: true, sandbox: true, deniedPaths: [${JSON.stringify(state)}, ${JSON.stringify(`${state}.service`)}] })).find(tool => tool.name === 'project_exec');`,
    "const run = async command => { const result = await exec.execute('c', { command }); return { exitCode: result.details.exitCode, sandboxed: result.details.sandboxed, output: result.content[0].text.split('\\n\\n').slice(1).join('\\n\\n').trim() }; };",
    `console.log(JSON.stringify({ which: await run('command -v node'), node: await run('node -p "process.execPath + \\' \\' + process.version"'), receipt: await run(${JSON.stringify(`cat ${JSON.stringify(`${state}.service/config.json`)}`)}) }));`].join('\n'));
  const { stdout } = await execFileAsync(node, [script], { cwd: root, env: { ...process.env, PATH: '/usr/bin:/bin' } });
  const result = JSON.parse(stdout);
  assert.equal(result.which.sandboxed, true);
  assert.equal(result.which.output, node, 'the shell finds the daemon\'s Node first, not one further down PATH');
  assert.equal(result.node.exitCode, 0, result.node.output); assert.equal(result.node.output, `${node} ${process.version}`, 'and Node resolves its own path');
  assert.notEqual(result.receipt.exitCode, 0); assert.doesNotMatch(result.receipt.output, /synthetic-service-receipt/, 'the rest of the denied folder stays unreadable');
});

test('Rna\'s state siblings created after the tools are private too: a prefix, not a listing', { skip: !sandboxAvailable() }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-prefix-'))), state = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(state, '{}'); writeFileSync(join(dir, 'notes.md'), 'notes\n');
  // The folder holds the state file itself, as in this repository or a test.
  const tools = await createWorkspaceTools(dir, { includeMutations: true, sandbox: true, deniedPaths: [state], deniedPrefixes: [`${state}.`] });
  const exec = tools.find(tool => tool.name === 'project_exec'), read = tools.find(tool => tool.name === 'project_read');
  // configuration.mjs writes `${file}.secrets.tmp-${pid}`, durable-files atomicWrite `${path}.tmp-${pid}-${uuid}`.
  writeFileSync(`${state}.secrets.tmp-1`, 'synthetic-temporary-secret'); writeFileSync(`${state}.tmp-1-abc`, 'synthetic-manifest');
  for (const path of [`${state}.secrets.tmp-1`, `${state}.tmp-1-abc`]) {
    const result = await exec.execute('c', { command: `cat ${JSON.stringify(path)}` });
    assert.notEqual(result.details.exitCode, 0, path); assert.doesNotMatch(outputOf(result), /synthetic/, path); assert.equal(result.details.sandboxDenied, true, path);
  }
  await assert.rejects(read.execute('r', { path: 'state.json.tmp-1-abc' }), { code: 'path_denied' });
  assert.match((await read.execute('r', { path: 'notes.md' })).content[0].text, /notes/, 'other files of the folder stay reachable');
  assert.equal((await exec.execute('c', { command: 'cat notes.md' })).details.exitCode, 0);
});

test('a sandboxed command cannot connect to the host\'s own port, however loopback is spelled; other ports stay open', { skip: !sandboxAvailable(), timeout: 60000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-port-')));
  const hits = { host: 0, other: 0 };
  const listen = name => new Promise(done => { const server = http.createServer((request, response) => { hits[name]++; response.end(`reached-${name}`); }); server.listen(0, '127.0.0.1', () => done(server)); });
  const host = await listen('host'), other = await listen('other');
  t.after(() => { host.close(); other.close(); rmSync(root, { recursive: true, force: true }); });
  const port = host.address().port;
  const exec = (await createWorkspaceTools(root, { includeMutations: true, sandbox: true, sandboxDenyPorts: [port] })).find(tool => tool.name === 'project_exec');
  for (const url of [`http://127.0.0.1:${port}/api/v2/bootstrap`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`]) {
    const result = await exec.execute('c', { command: `curl -sS -g -m 5 -X PATCH '${url}'` });
    assert.notEqual(result.details.exitCode, 0, url); assert.doesNotMatch(outputOf(result), /reached/, url);
  }
  assert.equal(hits.host, 0, 'the host\'s server never saw a request');
  const open = await exec.execute('c', { command: `curl -sS -m 5 http://127.0.0.1:${other.address().port}/` });
  assert.equal(open.details.exitCode, 0); assert.match(outputOf(open), /reached-other/);
});

test('sandbox-exec output from inside a command is the command\'s own, not a runner fault', { skip: !sandboxAvailable() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-nested-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exec = (await createWorkspaceTools(root, { includeMutations: true, sandbox: true })).find(tool => tool.name === 'project_exec');
  // A project's own tests may probe sandbox-exec; nested inside the sandbox it refuses ("sandbox_apply", exit 71).
  const nested = `${SANDBOX_EXEC} -p '(version 1)(allow default)' /usr/bin/true`;
  const passed = await exec.execute('c', { command: `${nested}; echo "inner=$?"; echo tests passed; exit 0` });
  assert.equal(passed.isError, false); assert.equal(passed.details.sandboxFault, undefined); assert.match(outputOf(passed), /sandbox-exec: sandbox_apply/); assert.match(outputOf(passed), /inner=71/);
  assert.doesNotMatch(passed.content[0].text, /sandbox could not run this command/);
  const quiet = await exec.execute('c', { command: `${nested}; exit 0` });
  assert.equal(quiet.isError, false, 'exit 0 is never a runner fault'); assert.equal(quiet.details.sandboxFault, undefined);
  const failed = await exec.execute('c', { command: `echo start; ${nested}; exit 1` });
  assert.equal(failed.isError, true); assert.equal(failed.details.exitCode, 1); assert.equal(failed.details.sandboxFault, undefined, 'the command ran: its own exit code');
});

test('a failed sandbox probe is retried after a while; a working one is remembered', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-sandbox-reprobe-'))), runner = join(root, 'flaky-sandbox-exec'), ready = join(root, 'ready');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Fails until `ready` exists, as a probe does when it times out under load or cannot fork.
  writeFileSync(runner, `#!/bin/sh\n[ -f ${JSON.stringify(ready)} ] && exit 0\nexit 1\n`, { mode: 0o755 });
  const now = 1_000_000;
  assert.equal(sandboxAvailable(runner, { now }), false);
  writeFileSync(ready, '');
  assert.equal(sandboxAvailable(runner, { now: now + 1000 }), false, 'within the retry interval the failure stands');
  assert.equal(sandboxAvailable(runner, { now: now + SANDBOX_PROBE_RETRY_MS }), true, 'probed again after it');
  rmSync(ready);
  assert.equal(sandboxAvailable(runner, { now: now + 10 * SANDBOX_PROBE_RETRY_MS }), true, 'a working sandbox is not probed again');
});
