import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntimeManifest, prepareLocalRuntime, verifyPreparedRuntime, assertRuntimeCompatible, describePreparedRuntime, ensureSharedNode, verifySharedNode, releaseRunsNode, RUNTIME_MANIFEST_NAME, PREPARED_RUNTIME_NAME } from '../runtime-release.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error?.code === expected;
function writable(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  chmodSync(path, info.isDirectory() ? 0o700 : info.mode | 0o600);
  if (info.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}
function fixture(t, { legacy = false, platform = 'darwin', arch = 'arm64' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-release-test-'));
  t.after(() => { writable(directory); rmSync(directory, { recursive: true, force: true }); });
  const app = join(directory, 'Rna Agent.app'), appRoot = join(app, 'Contents/Resources/app'), runtime = join(appRoot, 'runtime');
  const put = (path, content, mode = 0o600) => { const full = join(runtime, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content, { mode }); return full; };
  put('prototypes/control-center/package.json', JSON.stringify({ name: 'rna-agent', version: '0.15.0' }));
  put('packages/sdk/package.json', JSON.stringify({ name: '@rna-agent/sdk', version: '0.9.0' }));
  put('prototypes/control-center/server.mjs', 'export const server = true;');
  put('prototypes/control-center/service-cli.mjs', 'export const cli = true;');
  put('prototypes/control-center/web/dist/assets/app.js', 'export const view = true;');
  put('packages/sdk/src/index.mjs', 'export const sdk = true;');
  put('lib/npm/bin/npm-cli.js', 'export const npm = true;');
  const binary = Buffer.alloc(128);
  if (platform === 'darwin') { binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
  else { binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); binary.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18); }
  put('bin/node', binary, 0o700); put('bin/rna', '#!/bin/sh\nexit 0\n', 0o700);
  const destination = join(directory, 'slots', 'prepared');
  const manifest = () => createRuntimeManifest({ runtimeRoot: runtime, nodeVersion: '22.19.0', platform, arch });
  if (legacy) writeFileSync(join(appRoot, 'build-manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.15.0', platform, arch, node: { version: '22.19.0' }, sourceHashes: { 'runtime/bin/node': sha(binary), 'runtime/prototypes/control-center/server.mjs': sha('export const server = true;') } }));
  const policy = release => ({ allowedDigests: [release.digest], platform, arch, hostProtocolVersion: 1, stateVersion: 2, allowedWriteVersions: [2] });
  return { directory, app, appRoot, runtime, destination, put, manifest, policy };
}
function editManifest(root, fn) { const path = join(root, RUNTIME_MANIFEST_NAME); const value = JSON.parse(readFileSync(path)); fn(value); chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(value)); }

test('a full packaged runtime is copied to a separate read-only slot and rehashed', t => {
  const f = fixture(t); const manifest = f.manifest();
  assert.ok(manifest.manifest.files.some(row => row.path === 'lib/npm/bin/npm-cli.js'));
  assert.ok(manifest.manifest.files.some(row => row.path === 'bin/rna'));
  const prepared = prepareLocalRuntime({ source: f.app, destination: f.destination });
  assert.equal(prepared.digest, manifest.digest);
  assert.equal(prepared.trust, 'local_content_verified'); assert.equal(prepared.publisherVerified, false);
  assert.equal(prepared.baselineOnly, false); assert.equal(prepared.compatibility.assessed, false);
  assert.equal(lstatSync(f.destination).mode & 0o222, 0);
  assert.equal(lstatSync(join(f.destination, 'bin/node')).mode & 0o777, 0o500);
  const verified = verifyPreparedRuntime({ directory: f.destination, expectedDigest: prepared.digest, policy: f.policy(prepared) });
  assert.equal(verified.compatibility.compatible, true);
  assert.equal(verified.nodeVersionEvidence, 'manifest_declaration_not_executed');
  const summary = describePreparedRuntime(verified); assert.equal(summary.manifest, undefined); assert.equal(summary.hostVersion, '0.15.0'); assert.ok(summary.fileCount >= 9);
});

for (const shape of ['appRoot', 'runtime']) test(`prepare accepts ${shape} as a local source`, t => {
  const f = fixture(t); f.manifest();
  assert.equal(prepareLocalRuntime({ source: f[shape], destination: f.destination }).manifest.hostVersion, '0.15.0');
});

test('copied runtime survives removal of the original .app', t => {
  const f = fixture(t); f.manifest(); const release = prepareLocalRuntime({ source: f.app, destination: f.destination });
  rmSync(f.app, { recursive: true });
  assert.equal(verifyPreparedRuntime({ directory: f.destination, expectedDigest: release.digest }).digest, release.digest);
});

test('the exact contents, not a version string, identify a release', t => {
  const f = fixture(t); const before = f.manifest(); f.put('prototypes/control-center/web/dist/assets/app.js', 'changed UI');
  const after = f.manifest(); assert.notEqual(after.digest, before.digest); assert.equal(after.manifest.hostVersion, before.manifest.hostVersion);
});

for (const path of ['bin/rna', 'lib/npm/bin/npm-cli.js', 'prototypes/control-center/web/dist/assets/app.js', 'packages/sdk/src/index.mjs']) test(`tampering with ${path} fails before any slot is created`, t => {
  const f = fixture(t); f.manifest(); f.put(path, 'tampered');
  assert.throws(() => prepareLocalRuntime({ source: f.app, destination: f.destination }), code('RUNTIME_CONTENT_MISMATCH'));
  assert.equal(existsSync(f.destination), false);
});

test('undeclared files are rejected', t => {
  const f = fixture(t); f.manifest(); f.put('lib/npm/unexpected.js', 'unexpected');
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: f.destination }), code('RUNTIME_CONTENT_MISMATCH'));
});

test('bounded internal symlinks are copied, while external links are rejected', t => {
  const f = fixture(t); symlinkSync('../lib/npm/bin/npm-cli.js', join(f.runtime, 'bin/npm'));
  f.manifest(); const release = prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.ok(lstatSync(join(f.destination, 'bin/npm')).isSymbolicLink());
  assert.equal(verifyPreparedRuntime({ directory: f.destination }).digest, release.digest);
  symlinkSync('/etc/passwd', join(f.runtime, 'bin/external'));
  assert.throws(() => f.manifest(), code('RUNTIME_LINK_UNSAFE'));
});

test('relative link escape, broken links, and link loops are rejected', t => {
  const f = fixture(t); symlinkSync('../../../../outside', join(f.runtime, 'bin/escape'));
  assert.throws(() => f.manifest(), code('RUNTIME_LINK_ESCAPE')); rmSync(join(f.runtime, 'bin/escape'));
  symlinkSync('missing', join(f.runtime, 'bin/broken'));
  assert.throws(() => f.manifest(), code('RUNTIME_LINK_UNRESOLVED')); rmSync(join(f.runtime, 'bin/broken'));
  symlinkSync('two', join(f.runtime, 'bin/one')); symlinkSync('one', join(f.runtime, 'bin/two'));
  assert.throws(() => f.manifest(), code('RUNTIME_LINK_UNRESOLVED'));
});

test('source root symlinks and overlapping destination are rejected', t => {
  const f = fixture(t); f.manifest(); const link = join(f.directory, 'linked'); symlinkSync(f.runtime, link);
  assert.throws(() => prepareLocalRuntime({ source: link, destination: f.destination }), code('RUNTIME_ROOT_UNSAFE'));
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: join(f.runtime, 'slot') }), code('RUNTIME_DESTINATION_OVERLAP'));
});

test('an existing destination and its content are never replaced', t => {
  const f = fixture(t); f.manifest(); mkdirSync(f.destination, { recursive: true }); writeFileSync(join(f.destination, 'keep'), 'original');
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: f.destination }), code('RUNTIME_DESTINATION_EXISTS'));
  assert.equal(readFileSync(join(f.destination, 'keep'), 'utf8'), 'original');
});

test('readiness metadata alone cannot hide modified content', t => {
  const f = fixture(t); f.manifest(); const release = prepareLocalRuntime({ source: f.app, destination: f.destination });
  const path = join(f.destination, 'lib/npm/bin/npm-cli.js'); chmodSync(path, 0o600); writeFileSync(path, 'corrupt');
  assert.throws(() => verifyPreparedRuntime({ directory: f.destination, expectedDigest: release.digest }), code('RUNTIME_CONTENT_MISMATCH'));
});

test('verify checks the externally expected digest and preparation identity', t => {
  const f = fixture(t); f.manifest(); prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.throws(() => verifyPreparedRuntime({ directory: f.destination, expectedDigest: '0'.repeat(64) }), code('RUNTIME_PREPARATION_MISMATCH'));
  const path = join(f.destination, PREPARED_RUNTIME_NAME); chmodSync(path, 0o600); writeFileSync(path, JSON.stringify({ schemaVersion: 1, digest: '0'.repeat(64) }));
  assert.throws(() => verifyPreparedRuntime({ directory: f.destination }), code('RUNTIME_PREPARATION_MISMATCH'));
});

for (const mutation of [m => m.files[0].path = '../outside', m => m.files[0].path = '/outside', m => m.files[0].path = 'a\\b', m => m.files.reverse(), m => m.files.splice(1, 0, m.files[0])]) test('manifest cannot control traversal, duplicate entries, or canonical ordering', t => {
  const f = fixture(t); f.manifest(); editManifest(f.runtime, mutation);
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: f.destination }), code('RUNTIME_MANIFEST_PATH_INVALID'));
  assert.equal(existsSync(f.destination), false);
});

test('a package cannot assert its own compatibility or publisher trust', t => {
  const f = fixture(t); f.manifest(); const release = prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.throws(() => assertRuntimeCompatible({ release }), code('RUNTIME_POLICY_REQUIRED'));
  assert.throws(() => assertRuntimeCompatible({ release, policy: { ...f.policy(release), allowedDigests: ['0'.repeat(64)] } }), code('RUNTIME_RELEASE_NOT_APPROVED'));
  editManifest(f.runtime, value => { value.publisherVerified = true; });
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: join(f.directory, 'other') }), code('RUNTIME_MANIFEST_INVALID'));
});

for (const [field, value, expected] of [['platform', 'linux', 'RUNTIME_PLATFORM_INCOMPATIBLE'], ['arch', 'x64', 'RUNTIME_PLATFORM_INCOMPATIBLE'], ['hostProtocolVersion', 2, 'RUNTIME_PROTOCOL_INCOMPATIBLE'], ['stateVersion', 3, 'RUNTIME_STATE_INCOMPATIBLE'], ['allowedWriteVersions', [3], 'RUNTIME_STATE_INCOMPATIBLE']]) test(`host policy rejects incompatible ${field}`, t => {
  const f = fixture(t); f.manifest(); const release = prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.throws(() => assertRuntimeCompatible({ release, policy: { ...f.policy(release), [field]: value } }), code(expected));
});

test('declared package versions must match the runtime metadata', t => {
  const f = fixture(t); f.manifest(); editManifest(f.runtime, value => { value.hostVersion = '99.0.0'; });
  assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: f.destination }), code('RUNTIME_VERSION_MISMATCH'));
});

test('binary architecture is inspected without running supplied code', t => {
  const f = fixture(t); assert.throws(() => createRuntimeManifest({ runtimeRoot: f.runtime, nodeVersion: '22.19.0', platform: 'darwin', arch: 'x64' }), code('RUNTIME_NODE_IDENTITY_MISMATCH'));
  f.put('bin/node', '#!/bin/sh\nexit 0\n', 0o700);
  assert.throws(() => f.manifest(), code('RUNTIME_NODE_FORMAT_UNSUPPORTED'));
});

test('Linux ELF runtime can be prepared without executing or cross-launching Node', t => {
  const f = fixture(t, { platform: 'linux', arch: 'x64' }); f.manifest();
  const release = prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.equal(verifyPreparedRuntime({ directory: f.destination }).manifest.platform, 'linux');
  assert.equal(assertRuntimeCompatible({ release, policy: f.policy(release) }).compatible, true);
});

test('files, bytes, depth, metadata, and invalid limit settings are bounded', t => {
  const f = fixture(t); f.manifest();
  for (const [limits, expected] of [[{ maxEntries: 2 }, 'RUNTIME_MANIFEST_INVALID'], [{ maxBytes: 1 }, 'RUNTIME_BYTES_LIMIT'], [{ maxFileBytes: 1 }, 'RUNTIME_MANIFEST_FILE_INVALID'], [{ maxDepth: 1 }, 'RUNTIME_DEPTH_LIMIT'], [{ maxManifestBytes: 1 }, 'RUNTIME_METADATA_INVALID'], [{ maxBytes: -1 }, 'RUNTIME_LIMITS_INVALID'], [{ unknown: 1 }, 'RUNTIME_LIMITS_INVALID']]) {
    assert.throws(() => prepareLocalRuntime({ source: f.runtime, destination: f.destination, limits }), code(expected));
    assert.equal(existsSync(f.destination), false);
  }
});

test('legacy packaged runtime is a baseline only until an explicit digest-bound compatibility decision', t => {
  const f = fixture(t, { legacy: true }); const release = prepareLocalRuntime({ source: f.app, destination: f.destination });
  assert.equal(release.baselineOnly, true); assert.equal(release.manifest.hostProtocolVersion, null);
  assert.throws(() => assertRuntimeCompatible({ release, policy: f.policy(release) }), code('RUNTIME_LEGACY_BASELINE_ONLY'));
  assert.throws(() => assertRuntimeCompatible({ release, policy: { ...f.policy(release), allowLegacyBaseline: true, legacyCompatibility: { digest: '0'.repeat(64) } } }), code('RUNTIME_LEGACY_BASELINE_ONLY'));
  const policy = { ...f.policy(release), allowLegacyBaseline: true, legacyCompatibility: { digest: release.digest, hostProtocolVersion: 1, stateCompatibility: { readVersions: [2], writeVersion: 2 } } };
  assert.equal(verifyPreparedRuntime({ directory: f.destination, policy }).compatibility.compatible, true);
});

test('legacy import verifies the old declared source hashes before accepting a baseline', t => {
  const f = fixture(t, { legacy: true }); f.put('prototypes/control-center/server.mjs', 'changed');
  assert.throws(() => prepareLocalRuntime({ source: f.app, destination: f.destination }), code('RUNTIME_LEGACY_CONTENT_MISMATCH'));
});

test('legacy baseline does not infer unprovided compatibility from host version', t => {
  const f = fixture(t, { legacy: true }); const release = prepareLocalRuntime({ source: f.runtime, destination: f.destination });
  assert.throws(() => assertRuntimeCompatible({ release, policy: { ...f.policy(release), allowLegacyBaseline: true, legacyCompatibility: { digest: release.digest, hostProtocolVersion: 1, stateCompatibility: { readVersions: [1], writeVersion: 1 } } } }), code('RUNTIME_STATE_INCOMPATIBLE'));
});

test('release slots share one content-checked Node per binary so macOS privacy grants survive upgrades', t => {
  const f = fixture(t); f.manifest();
  const service = join(f.directory, 'state.json.service'), first = join(service, 'releases', '11111111-1111-4111-8111-111111111111'), second = join(service, 'releases', '22222222-2222-4222-8222-222222222222');
  assert.equal(prepareLocalRuntime({ source: f.app, destination: f.destination }).paths.sharedNode, null, 'slots outside releases/ keep their own node');
  const a = prepareLocalRuntime({ source: f.app, destination: first }), b = prepareLocalRuntime({ source: f.app, destination: second });
  assert.equal(a.paths.sharedNode, b.paths.sharedNode);
  assert.ok(a.paths.sharedNode.startsWith(join(realpathSync(service), 'node', '22.19.0-darwin-arm64-')));
  assert.throws(() => verifySharedNode(a), code('RUNTIME_SHARED_NODE_MISSING'));
  assert.equal(releaseRunsNode(a, a.paths.sharedNode), false);
  const path = ensureSharedNode(a);
  assert.equal(ensureSharedNode(b), path, 'second release reuses the same path');
  assert.equal(lstatSync(path).mode & 0o777, 0o500);
  assert.deepEqual(readFileSync(path), readFileSync(join(first, 'bin/node')));
  assert.equal(readdirSync(join(realpathSync(service), 'node')).length, 1, 'no staging leftovers');
  assert.equal(releaseRunsNode(b, path), true); assert.equal(releaseRunsNode(b, b.paths.node), true); assert.equal(releaseRunsNode(b, a.paths.node), false);
  chmodSync(path, 0o700); writeFileSync(path, 'tampered'); chmodSync(path, 0o500);
  assert.throws(() => verifySharedNode(a), code('RUNTIME_SHARED_NODE_MISMATCH'));
  assert.equal(releaseRunsNode(a, path), false);
});
