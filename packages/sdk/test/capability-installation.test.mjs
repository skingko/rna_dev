import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityInstaller, runCapabilityProcess } from '../src/capability-installation.mjs';
import { skillFixture, npmRegistryFixture } from './fixtures/capability-fixtures.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'rna-install-sdk-')); t.after(() => rm(dir, { recursive: true, force: true })); return { dir, root: join(dir, 'installed'), installer: new CapabilityInstaller({ rootDir: join(dir, 'installed') }) }; }

test('Local SKILL.md installs its complete inert bundle atomically and pins a content hash', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir);
  const inspect = await f.installer.inspect({ kind: 'skill', source: { type: 'local', path } }); assert.equal(inspect.executesCode, false); assert.match(inspect.contentHash, /^[a-f0-9]{64}$/);
  const staged = await f.installer.prepare({ kind: 'skill', id: 'fixture-skill', source: { type: 'local', path } });
  await assert.rejects(stat(staged.installationDir), { code: 'ENOENT' }); await staged.commit();
  assert.equal(await readFile(join(staged.installationDir, 'skill/references/guide.md'), 'utf8'), 'supporting fixture resource');
  assert.match(await readFile(join(staged.installationDir, 'skill/scripts/helper.mjs'), 'utf8'), /must not run me/);
  await writeFile(join(path, 'SKILL.md'), 'changed source'); assert.match(await readFile(staged.manifests[0].manifest.path, 'utf8'), /Fixture instructions/);
  assert.equal((await stat(staged.installationDir)).mode & 0o777, 0o700);
});

test('Skill symlinks and failed validation leave no published generation or pending directory', async t => {
  const f = await fixture(t), path = await skillFixture(f.dir); await symlink('/etc/passwd', join(path, 'references/leak'));
  await assert.rejects(f.installer.prepare({ kind: 'skill', source: { type: 'local', path } }), { code: 'unsafe_bundle' }); assert.deepEqual(await readdir(f.root), []);
  await rm(join(path, 'references/leak')); await writeFile(join(path, 'SKILL.md'), '');
  await assert.rejects(f.installer.prepare({ kind: 'skill', source: { type: 'local', path } }), /empty/); assert.deepEqual(await readdir(f.root), []);
});

test('Git skill installation copies a selected bundle and records the actual immutable commit', async t => {
  const f = await fixture(t), repo = join(f.dir, 'repo'); await mkdir(repo); await skillFixture(repo, 'git-skill');
  for (const args of [['init'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'local fixture']]) await runCapabilityProcess('git', args, { cwd: repo });
  const prepared = await f.installer.prepare({ kind: 'skill', id: 'git-skill', source: { type: 'git', repository: repo, subdirectory: 'git-skill' } }); await prepared.commit();
  assert.match(prepared.sources[0].commit, /^[a-f0-9]{40}$/); assert.equal(await readFile(join(prepared.installationDir, 'skill/references/guide.md'), 'utf8'), 'supporting fixture resource');
  assert.deepEqual((await readdir(prepared.installationDir)).sort(), ['installation.json', 'skill']);
  await assert.rejects(f.installer.prepare({ kind: 'skill', source: { type: 'git', repository: repo, subdirectory: '../..' } }), { code: 'unsafe_bundle' });
});

test('npm installation resolves an exact version, retains lock/integrity and never executes postinstall', { timeout: 30000 }, async t => {
  const f = await fixture(t), registry = await npmRegistryFixture(f.dir); t.after(() => registry.close());
  const input = { kind: 'mcp', id: 'npm-fixture', source: { type: 'npm', package: registry.name, registry: registry.base } };
  const inspect = await f.installer.inspect(input); assert.equal(inspect.version, '1.2.3'); assert.equal(inspect.lifecycleScripts, 'disabled'); assert.deepEqual(inspect.scripts, ['postinstall']);
  const prepared = await f.installer.prepare(input); await prepared.commit(); const manifest = prepared.manifests[0].manifest;
  assert.equal(prepared.sources[0].version, '1.2.3'); assert.equal(prepared.sources[0].integrity, registry.integrity); assert.equal(manifest.command, process.execPath);
  const lock = JSON.parse(await readFile(join(manifest.cwd, 'package-lock.json'), 'utf8')); assert.equal(lock.packages[''].dependencies[registry.name], '1.2.3');
  await assert.rejects(stat(join(manifest.cwd, 'node_modules', registry.name, 'postinstall-ran')), { code: 'ENOENT' }); assert.match(prepared.diagnostics[0].message, /native\/postinstall/);
});

test('Common MCP JSON imports preserve explicit env references and never launch processes during inspect', async t => {
  const f = await fixture(t), config = { mcpServers: { local: { command: 'node', args: ['fixture-server.mjs'], env: { TOKEN: '${MCP_FIXTURE_TOKEN}' } }, remote: { type: 'streamable-http', url: 'https://mcp.example.invalid/server', headers: { Authorization: '${MCP_AUTHORIZATION}' } } } };
  const inspected = await f.installer.inspect({ kind: 'mcp', source: { type: 'mcp-config', config } }); assert.equal(inspected.servers.length, 2); assert.equal(inspected.executesCode, false);
  const prepared = await f.installer.prepare({ kind: 'mcp', source: { type: 'mcp-config', config } });
  assert.equal(prepared.manifests[0].manifest.command, process.execPath); assert.deepEqual(prepared.manifests[0].manifest.envMapping, { TOKEN: 'MCP_FIXTURE_TOKEN' }); assert.deepEqual(prepared.manifests[1].manifest.headerEnv, { Authorization: 'MCP_AUTHORIZATION' }); await prepared.rollback();
  config.mcpServers.local.env.TOKEN = 'a-plaintext-secret'; await assert.rejects(f.installer.inspect({ kind: 'mcp', source: { type: 'mcp-config', config } }), { code: 'secret_reference_required' });
});

test('Cancellation terminates a staged child process and removes incomplete installation files', async t => {
  const f = await fixture(t), slow = join(f.dir, 'slow-git'); await writeFile(slow, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n'); await chmod(slow, 0o700);
  const installer = new CapabilityInstaller({ rootDir: f.root, gitCommand: slow }), controller = new AbortController();
  const pending = installer.prepare({ kind: 'skill', source: { type: 'git', repository: '/local/fixture' } }, { signal: controller.signal }); setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(await readdir(f.root), []);
});
