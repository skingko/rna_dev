import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, copyFileSync, chmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { privateStatePaths, credentialEnvironmentNames, rnaCredentialEnvironmentNames, capabilityEnvironmentNames, stateConfinement } from '../state-privacy.mjs';
import { createServer } from '../server.mjs';
import { boundedOutput, DISPLAY_OUTPUT_CHARS } from '../runtime-controller.mjs';
import { settledWriteArguments } from '../settled-writes.mjs';
import { sandboxAvailable } from '../../../packages/sdk/src/workspace-exec.mjs';

// Alignment 2026-10-05 A6: one deny root for Rna's state instead of hand-copied lists; sandboxed commands cannot read
// it (pi sandbox example denies ~/.ssh, ~/.aws, ~/.gnupg too); credential variables never reach a command.
const SYNTHETIC = 'RNA_A6_SYNTHETIC_MEMORY_KEY';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-state-privacy-'))), file = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(file), workspace = join(dir, 'project'); mkdirSync(workspace);
  const { project } = store.createProject({ name: 'Privacy', workspace, initiative: { enabled: false } });
  return { dir, file, store, workspace, project: () => store.state.projects.find(row => row.id === project.id) };
}

test('the state file and every sidecar are private, present or not yet created; the folder around them is not', t => {
  const f = fixture(t);
  writeFileSync(`${f.file}.v1-backup`, '{}'); writeFileSync(`${f.file}.future-sidecar`, 'x'); mkdirSync(join(f.dir, 'projects', 'p1', 'workspace'), { recursive: true });
  const paths = privateStatePaths(f.file);
  for (const suffix of ['', '.secrets', '.subscriptions', '.rna', '.d', '.usage-cache.jsonl', '.archive', '.v1-backup', '.future-sidecar']) assert.ok(paths.includes(`${f.file}${suffix}`), suffix || 'state.json');
  assert.ok(!paths.includes(f.dir) && !paths.some(path => path.startsWith(join(f.dir, 'projects'))), 'managed project workspaces under the state folder stay reachable');
  assert.ok(!paths.includes(f.workspace));
  // Credential variables named by the settings (plus JEV's), never their values.
  const names = credentialEnvironmentNames({ configuration: { providers: [{ apiKeyEnv: 'ZHIPU_API_KEY' }, { apiKeyEnv: '' }], memory: { apiKeyEnv: 'OV_KEY' }, webTools: { apiKeyEnv: 'bad name' } }, capabilities: { mcpServers: [{ envNames: ['GITHUB_TOKEN'], envMapping: { TOKEN: 'MAPPED_TOKEN' } }] } });
  assert.deepEqual(names, ['GITHUB_TOKEN', 'MAPPED_TOKEN', 'OV_KEY', 'SKILLSMP_API_KEY', 'TYPESAFE_API_KEY', 'ZHIPU_API_KEY']);
  const confinement = stateConfinement(f.store);
  assert.deepEqual(confinement.sandboxReadable, [`${f.file}.capabilities`, `${f.file}.genomes`, `${f.file}.skill-foundation`, `${f.file}.service/node`, `${f.file}.service/releases`]);
  assert.deepEqual(confinement.deniedPrefixes, [`${f.file}.`], 'siblings created later are covered too');
});

test('a background command cannot read Rna\'s state or see a credential variable; skill packages stay readable', { skip: !sandboxAvailable() }, async t => {
  const f = fixture(t), previous = process.env[SYNTHETIC];
  process.env[SYNTHETIC] = 'synthetic-value-not-a-key';
  t.after(() => { if (previous === undefined) delete process.env[SYNTHETIC]; else process.env[SYNTHETIC] = previous; });
  f.store.mutate(state => { state.configuration.memory.apiKeyEnv = SYNTHETIC; });
  writeFileSync(`${f.file}.secrets`, '{"synthetic":"secret"}'); mkdirSync(`${f.file}.capabilities/skill`, { recursive: true }); writeFileSync(`${f.file}.capabilities/skill/run.sh`, 'echo skill-ran\n');
  const capabilities = new CapabilityService(f.store);
  const exec = async scope => { const { registry } = await capabilities.registry(f.project(), [], { includeMutations: true, permissionScope: scope, execLogDir: join(f.dir, 'exec', scope) }); t.after(() => registry.close()); return registry.tools.get('project_exec'); };
  const background = await exec('background'), foreground = await exec('foreground');
  const run = async (tool, command) => { const result = await tool.execute('c', { command }); return { ...result.details, text: result.content[0].text }; };
  const secret = await run(background, `cat ${JSON.stringify(`${f.file}.secrets`)}`);
  assert.equal(secret.sandboxed, true); assert.notEqual(secret.exitCode, 0); assert.doesNotMatch(secret.text, /synthetic/); assert.match(secret.text, /Operation not permitted/); assert.equal(secret.sandboxDenied, true);
  assert.notEqual((await run(background, `cat ${JSON.stringify(f.file)}`)).exitCode, 0, 'the state file itself');
  assert.notEqual((await run(background, `ls ${JSON.stringify(`${f.file}.rna`)}`)).exitCode, 0, 'the journals');
  assert.notEqual((await run(background, `echo x > ${JSON.stringify(`${f.file}.secrets`)}`)).exitCode, 0, 'nor written');
  assert.match((await run(background, `sh ${JSON.stringify(`${f.file}.capabilities/skill/run.sh`)}`)).text, /skill-ran/, 'a skill package can be read and run');
  for (const tool of [background, foreground]) assert.match((await run(tool, `echo "\${${SYNTHETIC}:-absent}"`)).text, /\nabsent\n?$/, 'credential variables never reach a command');
  // The foreground in the project folder is not sandboxed (完全访问), as before.
  assert.equal((await run(foreground, 'true')).sandboxed, false);
});

test('a tool output\'s display copy keeps its head and its tail, where the exit status and errors are', () => {
  assert.equal(boundedOutput('short'), 'short');
  const long = `${'h'.repeat(50000)}${'m'.repeat(50000)}Error: failed at the end`;
  const shown = boundedOutput(long);
  assert.equal(shown.length, DISPLAY_OUTPUT_CHARS, 'the same 64,000-character bound'); assert.ok(shown.startsWith('h'.repeat(100))); assert.ok(shown.endsWith('Error: failed at the end')); assert.match(shown, /h\n…\nm/);
  // A cut never splits a surrogate pair.
  const emoji = `${'a'.repeat(31997)}😀${'b'.repeat(70000)}`;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(boundedOutput(emoji)));
});

test('an earlier edits[] call settles to one note like a single edit', () => {
  const long = '雨'.repeat(300);
  assert.deepEqual(settledWriteArguments('project_edit', { path: 'a.md', edits: [{ oldText: long, newText: `${long}。` }, { oldText: 'x', newText: 'y' }] }),
    { path: 'a.md', newText: '[Edit to a.md in an earlier turn: 2 replacements, 301 characters replaced with 302, set aside to keep the context small. Read the file for its current text.]' });
  assert.deepEqual(settledWriteArguments('project_edit', { path: 'a.md', oldText: long, newText: long }),
    { path: 'a.md', newText: '[Edit to a.md in an earlier turn: 300 characters replaced with 300, set aside to keep the context small. Read the file for its current text.]' }, 'the single-edit note is unchanged');
  assert.equal(settledWriteArguments('project_edit', { path: 'a.md', edits: [{ oldText: 'a', newText: 'b' }] }), null);
});

// Review 2026-10-05 (tool-safety), follow-ups to A6.
const execFileAsync = promisify(execFile);
const outputOf = result => result.content[0].text.split('\n\n').slice(1).join('\n\n');
const CAPABILITY = 'RNA_SYNTHETIC_CAPABILITY_TOKEN';

test('capability and MCP credential variables are withheld from background and worker commands, not from the foreground the user watches', async t => {
  const f = fixture(t), previous = { [SYNTHETIC]: process.env[SYNTHETIC], [CAPABILITY]: process.env[CAPABILITY] };
  process.env[SYNTHETIC] = 'synthetic-rna-value'; process.env[CAPABILITY] = 'synthetic-capability-value';
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  f.store.mutate(state => { state.configuration.memory.apiKeyEnv = SYNTHETIC; state.capabilities = { ...(state.capabilities ?? {}), mcpServers: [{ id: 'synthetic-mcp', name: 'Synthetic', transport: 'stdio', command: '/usr/bin/true', enabled: false, trusted: false, envNames: [CAPABILITY] }] }; });
  assert.deepEqual(rnaCredentialEnvironmentNames(f.store.state), [SYNTHETIC, 'SKILLSMP_API_KEY', 'TYPESAFE_API_KEY']);
  assert.deepEqual(capabilityEnvironmentNames(f.store.state), [CAPABILITY]);
  assert.deepEqual(stateConfinement(f.store).withheldEnv, rnaCredentialEnvironmentNames(f.store.state));
  assert.deepEqual(stateConfinement(f.store, { unattended: true }).withheldEnv, credentialEnvironmentNames(f.store.state));
  const capabilities = new CapabilityService(f.store);
  const seen = async options => {
    const { registry } = await capabilities.registry(f.project(), [], { includeMutations: true, execLogDir: join(f.dir, 'exec', String(Math.random()).slice(2)), ...options }); t.after(() => registry.close());
    const result = await registry.tools.get('project_exec').execute('c', { command: `echo "rna=\${${SYNTHETIC}:-absent} capability=\${${CAPABILITY}:-absent}"` });
    // Names only, of the variables the command would have inherited (this machine may also hold e.g. TYPESAFE_API_KEY).
    return { text: outputOf(result).trim(), withheld: (result.details.withheldEnv ?? []).filter(name => [SYNTHETIC, CAPABILITY].includes(name)) };
  };
  assert.deepEqual(await seen({ permissionScope: 'foreground' }), { text: 'rna=absent capability=synthetic-capability-value', withheld: [SYNTHETIC] }, 'the user\'s own scripts keep GITHUB_TOKEN-like variables');
  assert.deepEqual(await seen({ permissionScope: 'foreground', ownerSessionId: 'parent-session' }), { text: 'rna=absent capability=absent', withheld: [SYNTHETIC, CAPABILITY] }, 'a worker');
  if (sandboxAvailable()) assert.deepEqual(await seen({ permissionScope: 'background' }), { text: 'rna=absent capability=absent', withheld: [SYNTHETIC, CAPABILITY] }, 'background work');
});

test('a background command cannot read state siblings created after its tools, nor reach the daemon\'s own API', { skip: !sandboxAvailable(), timeout: 60000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-state-privacy-api-'))), stateFile = join(dir, 'state.json'), workspace = join(dir, 'project'); mkdirSync(workspace);
  let probes = 0;
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false, sandboxProbe: () => { probes++; return sandboxAvailable(); } });
  await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(probes, 1, 'the sandbox is probed once when the server starts');
  const port = app.server.address().port, { project } = app.store.createProject({ name: 'Api', workspace, initiative: { enabled: false } });
  const exec = async scope => { const { registry } = await app.capabilityService.registry(app.store.state.projects.find(row => row.id === project.id), [], { includeMutations: true, permissionScope: scope, execLogDir: join(dir, 'exec', scope) }); t.after(() => registry.close()); return registry.tools.get('project_exec'); };
  const background = await exec('background'), foreground = await exec('foreground');
  // The routes only check Host and Origin, which curl from a local command satisfies (server.mjs).
  const bootstrap = `curl -sS -m 5 http://127.0.0.1:${port}/api/v2/bootstrap`, patch = `curl -sS -m 5 -X PATCH -H 'content-type: application/json' -d '{}' http://127.0.0.1:${port}/api/configuration`;
  for (const command of [bootstrap, patch]) {
    const result = await background.execute('c', { command });
    assert.equal(result.details.sandboxed, true); assert.notEqual(result.details.exitCode, 0, command); assert.doesNotMatch(outputOf(result), /"projects"|"error"/, command);
  }
  assert.equal((await foreground.execute('c', { command: bootstrap })).details.exitCode, 0, 'the unsandboxed foreground is unchanged');
  // configuration.mjs saves secrets through `${file}.secrets.tmp-${pid}`; durable-files atomicWrite through `${path}.tmp-…`.
  writeFileSync(`${stateFile}.secrets.tmp-1`, '{"synthetic":"temporary-secret"}'); writeFileSync(`${stateFile}.tmp-1-abc`, 'synthetic-manifest');
  for (const path of [`${stateFile}.secrets.tmp-1`, `${stateFile}.tmp-1-abc`]) {
    const result = await background.execute('c', { command: `cat ${JSON.stringify(path)}` });
    assert.notEqual(result.details.exitCode, 0, path); assert.doesNotMatch(outputOf(result), /synthetic/, path);
  }
});

test('a maintenance-applied daemon\'s Node and npm, which live in <state>.service, still run in a background command', { skip: !sandboxAvailable(), timeout: 60000 }, async t => {
  // runtime-release.mjs: a release slot is <state>.service/releases/<id> with bin/node, bin/npm (running
  // ../lib/npm/bin/npm-cli.js) and the host code; the daemon runs bin/node or the shared copy in <state>.service/node.
  const f = fixture(t), release = join(`${f.file}.service`, 'releases', 'r1'), bin = join(release, 'bin'), node = join(bin, 'node');
  mkdirSync(join(release, 'lib', 'npm', 'bin'), { recursive: true }); mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE); chmodSync(node, 0o755);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nset -eu\nRNA_BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$RNA_BIN/node" "$RNA_BIN/../lib/npm/bin/npm-cli.js" "$@"\n', { mode: 0o755 });
  writeFileSync(join(release, 'lib', 'npm', 'bin', 'npm-cli.js'), 'console.log(`npm-ok ${process.argv.slice(2).join(" ")}`);\n');
  writeFileSync(join(`${f.file}.service`, 'config.json'), 'synthetic-service-config'); writeFileSync(`${f.file}.secrets`, '{"synthetic":"secret"}');
  const script = join(f.dir, 'daemon.mjs'), url = name => new URL(`../${name}`, import.meta.url).href;
  writeFileSync(script, [
    `import { Store } from ${JSON.stringify(url('store.mjs'))};`, `import { CapabilityService } from ${JSON.stringify(url('capability-service.mjs'))};`,
    `const store = new Store(${JSON.stringify(f.file)}), project = store.state.projects.find(row => row.name === 'Privacy');`,
    `const { registry } = await new CapabilityService(store).registry(project, [], { includeMutations: true, permissionScope: 'background', execLogDir: ${JSON.stringify(join(f.dir, 'exec', 'release'))} });`,
    "const exec = registry.tools.get('project_exec'), run = async command => { const result = await exec.execute('c', { command }); return { exitCode: result.details.exitCode, sandboxed: result.details.sandboxed, output: result.content[0].text.split('\\n\\n').slice(1).join('\\n\\n').trim() }; };",
    `const result = { node: await run('node -p process.execPath'), npm: await run('npm run build'), config: await run(${JSON.stringify(`cat ${JSON.stringify(join(`${f.file}.service`, 'config.json'))}`)}), secrets: await run(${JSON.stringify(`cat ${JSON.stringify(`${f.file}.secrets`)}`)}) };`,
    'await registry.close(); console.log(JSON.stringify(result));'].join('\n'));
  const { stdout } = await execFileAsync(node, [script], { cwd: f.workspace, env: { ...process.env, PATH: '/usr/bin:/bin' } });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.node.sandboxed, true);
  assert.equal(result.node.exitCode, 0, result.node.output); assert.equal(result.node.output, node, 'the release\'s own Node');
  assert.equal(result.npm.exitCode, 0, result.npm.output); assert.equal(result.npm.output, 'npm-ok run build', 'and its npm, which reads the release\'s lib');
  for (const name of ['config', 'secrets']) { assert.notEqual(result[name].exitCode, 0, name); assert.doesNotMatch(result[name].output, /synthetic/, name); }
});
