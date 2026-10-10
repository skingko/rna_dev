import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, chmodSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, syncDirectory } from './durable-files.mjs';

export const RUNTIME_MANIFEST_NAME = 'rna-runtime-manifest.json';
export const PREPARED_RUNTIME_NAME = 'rna-prepared-release.json';
export const RUNTIME_RELEASE_PROTOCOL = 1;
const RESERVED = new Set([RUNTIME_MANIFEST_NAME, PREPARED_RUNTIME_NAME]);
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 50000, maxBytes: 1024 ** 3, maxFileBytes: 512 * 1024 ** 2, maxDepth: 40, maxManifestBytes: 32 * 1024 ** 2 });
const HEX = /^[a-f0-9]{64}$/, VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const sorted = values => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const inside = (root, target) => target === root || target.startsWith(`${root}${sep}`);
const regular = info => info.isFile() && !info.isSymbolicLink();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function limitsFor(input = {}) {
  if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_LIMITS, key))) fail('RUNTIME_LIMITS_INVALID');
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key] * 8) fail('RUNTIME_LIMITS_INVALID');
  return limits;
}
function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048 && !isAbsolute(path) && !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function checkedPath(root, path) {
  if (!validPath(path)) fail('RUNTIME_PATH_INVALID');
  const target = resolve(root, path);
  if (!inside(root, target) || !inside(root, realpathSync(dirname(target)))) fail('RUNTIME_PATH_ESCAPE');
  return target;
}
function readBoundedJSON(path, maxBytes) {
  const info = lstatSync(path);
  if (!regular(info) || info.size > maxBytes) fail('RUNTIME_METADATA_INVALID');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!regular(before) || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size || before.size > maxBytes) fail('RUNTIME_SOURCE_CHANGED');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) fail('RUNTIME_SOURCE_CHANGED'); offset += count; }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('RUNTIME_SOURCE_CHANGED');
    try { return JSON.parse(bytes.toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('RUNTIME_METADATA_INVALID'); throw error; }
  } finally { closeSync(fd); }
}
function encodeManifest(manifest, limits) {
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > limits.maxManifestBytes) fail('RUNTIME_METADATA_LIMIT');
  return encoded;
}
function canonicalRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('RUNTIME_ROOT_INVALID');
  const root = resolve(path), info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('RUNTIME_ROOT_UNSAFE');
  return realpathSync(root);
}
function identifySource(source) {
  const root = canonicalRoot(resolve(source));
  for (const path of [join(root, 'Contents/Resources/app/runtime'), join(root, 'runtime'), root]) {
    if (existsSync(join(path, 'prototypes/control-center/package.json')) && existsSync(join(path, 'packages/sdk/package.json')) && existsSync(join(path, 'bin/node'))) return canonicalRoot(path);
  }
  fail('RUNTIME_LAYOUT_INVALID');
}
function fileDigest(path, expected, limits, copyTo) {
  if (expected.size > limits.maxFileBytes) fail('RUNTIME_FILE_LIMIT');
  const input = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const before = fstatSync(input);
    if (!regular(before) || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) fail('RUNTIME_SOURCE_CHANGED');
    if (copyTo) output = openSync(copyTo, 'wx', expected.mode & 0o111 ? 0o700 : 0o600);
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    let bytes = 0, count;
    while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
      bytes += count; if (bytes > limits.maxFileBytes || bytes > before.size) fail('RUNTIME_SOURCE_CHANGED');
      digest.update(buffer.subarray(0, count));
      if (output !== undefined) { let offset = 0; while (offset < count) offset += writeSync(output, buffer, offset, count - offset); }
    }
    const after = fstatSync(input), current = lstatSync(path);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) fail('RUNTIME_SOURCE_CHANGED');
    if (output !== undefined) fsyncSync(output);
    return digest.digest('hex');
  } finally { if (output !== undefined) closeSync(output); closeSync(input); }
}
function assertLink(root, path, target) {
  if (typeof target !== 'string' || !target || target.length > 2048 || isAbsolute(target) || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target)) fail('RUNTIME_LINK_UNSAFE');
  const lexical = resolve(dirname(join(root, path)), target);
  if (!inside(root, lexical)) fail('RUNTIME_LINK_ESCAPE');
  let actual;
  try { actual = realpathSync(join(root, path)); } catch { fail('RUNTIME_LINK_UNRESOLVED'); }
  if (!inside(root, actual)) fail('RUNTIME_LINK_ESCAPE');
}
function scanRuntime(root, limits) {
  const files = []; let bytes = 0;
  const visit = (directory, prefix = '', depth = 0) => {
    if (depth > limits.maxDepth) fail('RUNTIME_DEPTH_LIMIT');
    for (const name of sorted(readdirSync(directory))) {
      if (!prefix && RESERVED.has(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = checkedPath(root, path), info = lstatSync(absolute);
      if (files.length >= limits.maxEntries) fail('RUNTIME_ENTRY_LIMIT');
      if (info.isSymbolicLink()) { const target = readlinkSync(absolute); assertLink(root, path, target); files.push({ path, type: 'symlink', target }); }
      else if (info.isDirectory()) { files.push({ path, type: 'directory' }); visit(absolute, path, depth + 1); }
      else if (info.isFile()) {
        bytes += info.size; if (bytes > limits.maxBytes) fail('RUNTIME_BYTES_LIMIT');
        files.push({ path, type: 'file', size: info.size, executable: Boolean(info.mode & 0o111), sha256: fileDigest(absolute, info, limits) });
      } else fail('RUNTIME_SPECIAL_FILE');
    }
  };
  visit(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function nodeBinaryIdentity(root) {
  const path = checkedPath(root, 'bin/node'), info = lstatSync(path);
  if (!regular(info) || !(info.mode & 0o111)) fail('RUNTIME_NODE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const header = Buffer.alloc(64); let bytes;
  try { bytes = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (bytes >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4), arch = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : null;
    if (arch) return { platform: 'darwin', arch };
  }
  if (bytes >= 20 && header.subarray(0, 4).toString('hex') === '7f454c46' && header[4] === 2 && [1, 2].includes(header[5])) {
    const cpu = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18), arch = cpu === 183 ? 'arm64' : cpu === 62 ? 'x64' : null;
    if (arch) return { platform: 'linux', arch };
  }
  fail('RUNTIME_NODE_FORMAT_UNSUPPORTED');
}
function packageIdentity(root, path, name, limits) {
  const value = readBoundedJSON(checkedPath(root, path), limits.maxManifestBytes);
  if (value.name !== name || !VERSION.test(value.version ?? '')) fail('RUNTIME_PACKAGE_INVALID');
  return value.version;
}
function compatibility(value, origin) {
  if (origin === 'legacy_baseline') { if (value !== null) fail('RUNTIME_COMPATIBILITY_INVALID'); return null; }
  if (!record(value) || Object.keys(value).sort().join() !== 'readVersions,writeVersion' || !Array.isArray(value.readVersions) || !value.readVersions.length || value.readVersions.length > 16 || value.readVersions.some(version => !Number.isSafeInteger(version) || version < 1) || new Set(value.readVersions).size !== value.readVersions.length || !Number.isSafeInteger(value.writeVersion) || value.writeVersion < 1 || !value.readVersions.includes(value.writeVersion)) fail('RUNTIME_COMPATIBILITY_INVALID');
  return { readVersions: [...value.readVersions].sort((a, b) => a - b), writeVersion: value.writeVersion };
}
function parseManifest(value, limits) {
  if (!record(value) || value.schemaVersion !== 1 || value.kind !== 'rna-runtime' || !['packaged', 'legacy_baseline'].includes(value.origin) || !VERSION.test(value.hostVersion ?? '') || !VERSION.test(value.sdkVersion ?? '') || !VERSION.test(value.nodeVersion ?? '') || !['darwin', 'linux'].includes(value.platform) || !['arm64', 'x64'].includes(value.arch) || (value.origin === 'packaged' ? !Number.isSafeInteger(value.hostProtocolVersion) || value.hostProtocolVersion < 1 : value.hostProtocolVersion !== null) || !Array.isArray(value.files) || !value.files.length || value.files.length > limits.maxEntries) fail('RUNTIME_MANIFEST_INVALID');
  const keys = ['schemaVersion', 'kind', 'origin', 'hostVersion', 'sdkVersion', 'nodeVersion', 'platform', 'arch', 'hostProtocolVersion', 'stateCompatibility', 'files'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail('RUNTIME_MANIFEST_INVALID');
  let total = 0, previous = '';
  const files = value.files.map(row => {
    if (!record(row) || !validPath(row.path) || RESERVED.has(row.path) || row.path <= previous) fail('RUNTIME_MANIFEST_PATH_INVALID');
    previous = row.path;
    if (row.type === 'directory' && Object.keys(row).length === 2) return { path: row.path, type: row.type };
    if (row.type === 'symlink' && Object.keys(row).length === 3 && typeof row.target === 'string') return { path: row.path, type: row.type, target: row.target };
    if (row.type !== 'file' || Object.keys(row).length !== 5 || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > limits.maxFileBytes || typeof row.executable !== 'boolean' || !HEX.test(row.sha256 ?? '')) fail('RUNTIME_MANIFEST_FILE_INVALID');
    total += row.size; if (total > limits.maxBytes) fail('RUNTIME_BYTES_LIMIT');
    return { path: row.path, type: row.type, size: row.size, executable: row.executable, sha256: row.sha256 };
  });
  return { schemaVersion: 1, kind: 'rna-runtime', origin: value.origin, hostVersion: value.hostVersion, sdkVersion: value.sdkVersion, nodeVersion: value.nodeVersion, platform: value.platform, arch: value.arch, hostProtocolVersion: value.hostProtocolVersion, stateCompatibility: compatibility(value.stateCompatibility, value.origin), files };
}
function verifyManifestRoot(root, manifest, limits) {
  const actual = scanRuntime(root, limits);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail('RUNTIME_CONTENT_MISMATCH');
  if (packageIdentity(root, 'prototypes/control-center/package.json', 'rna-agent', limits) !== manifest.hostVersion || packageIdentity(root, 'packages/sdk/package.json', '@rna-agent/sdk', limits) !== manifest.sdkVersion) fail('RUNTIME_VERSION_MISMATCH');
  const binary = nodeBinaryIdentity(root);
  if (binary.platform !== manifest.platform || binary.arch !== manifest.arch) fail('RUNTIME_NODE_IDENTITY_MISMATCH');
  for (const path of ['prototypes/control-center/server.mjs', 'prototypes/control-center/service-cli.mjs', 'packages/sdk/src/index.mjs', 'bin/rna']) if (!actual.some(row => row.path === path && row.type === 'file')) fail('RUNTIME_ENTRYPOINT_MISSING');
  return actual;
}
/* macOS privacy grants (TCC, e.g. Documents access) for a bare executable are
 * keyed by its absolute path, so every release slot's own bin/node needed a new
 * grant. Slots under <service>/releases/<id> therefore run one shared copy per
 * distinct Node binary: <service>/node/<version>-<platform>-<arch>-<sha16>/node.
 * The copy is content-checked against the slot manifest every time it is used. */
function sharedNodeLocation(root, manifest) {
  if (basename(dirname(root)) !== 'releases') return null;
  const row = manifest.files.find(file => file.path === 'bin/node' && file.type === 'file');
  if (!row) return null;
  return join(dirname(dirname(root)), 'node', `${manifest.nodeVersion.replace(/^v/, '')}-${manifest.platform}-${manifest.arch}-${row.sha256.slice(0, 16)}`, 'node');
}
function sharedNodeRow(release) {
  const row = release?.manifest?.files?.find(file => file.path === 'bin/node' && file.type === 'file');
  if (!row || !release.paths?.sharedNode) fail('RUNTIME_SHARED_NODE_UNAVAILABLE');
  return row;
}
/** Verify the shared Node copy of a prepared release; returns its path. */
export function verifySharedNode(release, { limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits), row = sharedNodeRow(release), path = release.paths.sharedNode;
  let info; try { info = lstatSync(path); } catch { fail('RUNTIME_SHARED_NODE_MISSING'); }
  if (!regular(info) || !(info.mode & 0o111) || info.size !== row.size || fileDigest(path, info, limits) !== row.sha256) fail('RUNTIME_SHARED_NODE_MISMATCH');
  return path;
}
/** Create (once) and verify the shared Node copy of a prepared release. */
export function ensureSharedNode(release, { limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits), row = sharedNodeRow(release), path = release.paths.sharedNode;
  if (!existsSync(path)) {
    const directory = dirname(path), parent = dirname(directory);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = join(parent, `.${basename(directory)}.pending-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      const from = release.paths.node, info = lstatSync(from);
      if (!regular(info) || fileDigest(from, info, limits, join(staging, 'node')) !== row.sha256) fail('RUNTIME_SOURCE_CHANGED');
      chmodSync(join(staging, 'node'), 0o500); syncDirectory(staging);
      try { renameSync(staging, directory); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      syncDirectory(parent);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  return verifySharedNode(release, { limits });
}
/** True when command is the slot's own Node or its verified shared copy. */
export function releaseRunsNode(release, command, canonical = value => value) {
  const same = (a, b) => { try { return canonical(a) === canonical(b); } catch { return false; } };
  if (same(command, release.paths.node)) return true;
  if (!release.paths.sharedNode || !same(command, release.paths.sharedNode)) return false;
  try { verifySharedNode(release); return true; } catch { return false; }
}
function description(root, manifest) {
  return { directory: root, digest: hash(JSON.stringify(manifest)), manifest, trust: 'local_content_verified', publisherVerified: false,
    nodeVersionEvidence: 'manifest_declaration_not_executed', baselineOnly: manifest.origin === 'legacy_baseline',
    paths: { host: join(root, 'prototypes/control-center'), node: join(root, 'bin/node'), bin: join(root, 'bin'), cli: join(root, 'bin/rna'), sharedNode: sharedNodeLocation(root, manifest) },
    compatibility: { assessed: false, hostProtocolVersion: manifest.hostProtocolVersion, state: manifest.stateCompatibility } };
}

/** Build-time operation: inspect every runtime file without executing its Node.
 * Call after all runtime files/launchers have been copied and before packaging. */
export function createRuntimeManifest({ runtimeRoot, nodeVersion, platform = process.platform, arch = process.arch, hostProtocolVersion = RUNTIME_RELEASE_PROTOCOL, stateCompatibility = { readVersions: [2], writeVersion: 2 }, limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits), root = canonicalRoot(resolve(runtimeRoot));
  if (existsSync(join(root, PREPARED_RUNTIME_NAME))) fail('RUNTIME_ALREADY_PREPARED');
  const manifest = parseManifest({ schemaVersion: 1, kind: 'rna-runtime', origin: 'packaged', hostVersion: packageIdentity(root, 'prototypes/control-center/package.json', 'rna-agent', limits), sdkVersion: packageIdentity(root, 'packages/sdk/package.json', '@rna-agent/sdk', limits), nodeVersion, platform, arch, hostProtocolVersion, stateCompatibility, files: scanRuntime(root, limits) }, limits);
  verifyManifestRoot(root, manifest, limits);
  atomicWrite(join(root, RUNTIME_MANIFEST_NAME), encodeManifest(manifest, limits));
  return description(root, manifest);
}

function legacyManifest(root, limits) {
  const build = readBoundedJSON(join(dirname(root), 'build-manifest.json'), limits.maxManifestBytes);
  if (build.schemaVersion !== 1 || !record(build.sourceHashes) || !VERSION.test(build.node?.version ?? '') || !VERSION.test(build.version ?? '')) fail('RUNTIME_LEGACY_METADATA_INVALID');
  const files = scanRuntime(root, limits), rows = new Map(files.map(row => [row.path, row])); let checked = 0;
  for (const [path, digest] of Object.entries(build.sourceHashes)) {
    if (!path.startsWith('runtime/')) continue;
    const relativePath = path.slice(8), actual = rows.get(relativePath);
    if (!validPath(relativePath) || !HEX.test(digest) || actual?.type !== 'file' || actual.sha256 !== digest) fail('RUNTIME_LEGACY_CONTENT_MISMATCH');
    checked++;
  }
  if (!checked || !Object.hasOwn(build.sourceHashes, 'runtime/bin/node')) fail('RUNTIME_LEGACY_METADATA_INVALID');
  const manifest = parseManifest({ schemaVersion: 1, kind: 'rna-runtime', origin: 'legacy_baseline', hostVersion: packageIdentity(root, 'prototypes/control-center/package.json', 'rna-agent', limits), sdkVersion: packageIdentity(root, 'packages/sdk/package.json', '@rna-agent/sdk', limits), nodeVersion: build.node.version, platform: build.platform, arch: build.arch, hostProtocolVersion: null, stateCompatibility: null, files }, limits);
  if (manifest.hostVersion !== build.version) fail('RUNTIME_VERSION_MISMATCH');
  verifyManifestRoot(root, manifest, limits); return manifest;
}

/** Copy an explicitly supplied local artifact into an unused, private runtime
 * slot. A failed preparation never produces the final readiness record. */
export function prepareLocalRuntime({ source, destination, limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits), root = identifySource(source), target = resolve(destination);
  if (inside(root, target) || inside(target, root)) fail('RUNTIME_DESTINATION_OVERLAP');
  if (existsSync(target)) fail('RUNTIME_DESTINATION_EXISTS');
  const manifestPath = join(root, RUNTIME_MANIFEST_NAME), manifest = existsSync(manifestPath) ? parseManifest(readBoundedJSON(manifestPath, limits.maxManifestBytes), limits) : legacyManifest(root, limits);
  verifyManifestRoot(root, manifest, limits);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(target));
  if (inside(root, parent)) fail('RUNTIME_DESTINATION_OVERLAP');
  const destinationRoot = join(parent, basename(target));
  mkdirSync(destinationRoot, { mode: 0o700 });
  try {
    for (const row of manifest.files.filter(row => row.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) mkdirSync(join(destinationRoot, row.path), { mode: 0o700 });
    for (const row of manifest.files.filter(row => row.type === 'file')) {
      const from = checkedPath(root, row.path), info = lstatSync(from);
      if (!regular(info) || Boolean(info.mode & 0o111) !== row.executable || info.size !== row.size || fileDigest(from, info, limits, join(destinationRoot, row.path)) !== row.sha256) fail('RUNTIME_SOURCE_CHANGED');
    }
    for (const row of manifest.files.filter(row => row.type === 'symlink')) {
      if (readlinkSync(checkedPath(root, row.path)) !== row.target) fail('RUNTIME_SOURCE_CHANGED');
      symlinkSync(row.target, join(destinationRoot, row.path));
    }
    // Check both ends again: no source drift or missed/extra destination bytes.
    verifyManifestRoot(root, manifest, limits); verifyManifestRoot(destinationRoot, manifest, limits);
    atomicWrite(join(destinationRoot, RUNTIME_MANIFEST_NAME), encodeManifest(manifest, limits));
    const result = description(destinationRoot, manifest);
    atomicWrite(join(destinationRoot, PREPARED_RUNTIME_NAME), `${JSON.stringify({ schemaVersion: 1, digest: result.digest, trust: 'local_content_verified', publisherVerified: false, preparedAt: new Date().toISOString(), preparationId: randomUUID() }, null, 2)}\n`);
    for (const row of manifest.files) if (row.type === 'file') chmodSync(join(destinationRoot, row.path), row.executable ? 0o500 : 0o400);
    chmodSync(join(destinationRoot, RUNTIME_MANIFEST_NAME), 0o400); chmodSync(join(destinationRoot, PREPARED_RUNTIME_NAME), 0o400);
    for (const row of manifest.files.filter(row => row.type === 'directory').sort((a, b) => b.path.split('/').length - a.path.split('/').length)) { syncDirectory(join(destinationRoot, row.path)); chmodSync(join(destinationRoot, row.path), 0o500); }
    syncDirectory(destinationRoot); chmodSync(destinationRoot, 0o500); syncDirectory(parent);
    return result;
  } catch (error) {
    // Only this call's newly created slot is removed. No existing slot or
    // supplied package is ever cleaned up by an unsuccessful preparation.
    try { chmodSync(destinationRoot, 0o700); for (const row of manifest.files.filter(row => row.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) if (existsSync(join(destinationRoot, row.path))) chmodSync(join(destinationRoot, row.path), 0o700); rmSync(destinationRoot, { recursive: true, force: true }); } catch { /* Keep an incomplete, unselected slot for inspection. */ }
    throw error;
  }
}

/** Rehash the whole prepared slot; never trust its readiness record alone. */
export function verifyPreparedRuntime({ directory, expectedDigest, policy, limits: inputLimits } = {}) {
  const limits = limitsFor(inputLimits), root = canonicalRoot(resolve(directory));
  const manifest = parseManifest(readBoundedJSON(join(root, RUNTIME_MANIFEST_NAME), limits.maxManifestBytes), limits);
  const prepared = readBoundedJSON(join(root, PREPARED_RUNTIME_NAME), 65536), result = description(root, manifest);
  if (prepared.schemaVersion !== 1 || prepared.digest !== result.digest || prepared.trust !== 'local_content_verified' || prepared.publisherVerified !== false || expectedDigest !== undefined && expectedDigest !== result.digest) fail('RUNTIME_PREPARATION_MISMATCH');
  verifyManifestRoot(root, manifest, limits);
  if (policy !== undefined) result.compatibility = assertRuntimeCompatible({ release: result, policy });
  return result;
}

/** Compatibility is approved by the running host's policy, never granted by
 * self-declared fields inside a supplied package. Approved digests are required. */
export function assertRuntimeCompatible({ release, policy } = {}) {
  if (!record(policy) || !Array.isArray(policy.allowedDigests) || !policy.allowedDigests.length || !policy.allowedDigests.every(value => HEX.test(value))) fail('RUNTIME_POLICY_REQUIRED');
  if (!release || !HEX.test(release.digest ?? '') || !policy.allowedDigests.includes(release.digest)) fail('RUNTIME_RELEASE_NOT_APPROVED');
  const manifest = release.manifest;
  if (manifest.platform !== policy.platform || manifest.arch !== policy.arch) fail('RUNTIME_PLATFORM_INCOMPATIBLE');
  if (manifest.origin === 'legacy_baseline') {
    if (policy.allowLegacyBaseline !== true || !record(policy.legacyCompatibility) || policy.legacyCompatibility.digest !== release.digest) fail('RUNTIME_LEGACY_BASELINE_ONLY');
  }
  const declared = manifest.origin === 'legacy_baseline' ? policy.legacyCompatibility : manifest;
  if (!Number.isSafeInteger(policy.hostProtocolVersion) || declared.hostProtocolVersion !== policy.hostProtocolVersion) fail('RUNTIME_PROTOCOL_INCOMPATIBLE');
  const state = compatibility(declared.stateCompatibility, 'packaged');
  if (!Number.isSafeInteger(policy.stateVersion) || !state.readVersions.includes(policy.stateVersion) || !Array.isArray(policy.allowedWriteVersions) || !policy.allowedWriteVersions.includes(state.writeVersion)) fail('RUNTIME_STATE_INCOMPATIBLE');
  return { assessed: true, compatible: true, hostProtocolVersion: declared.hostProtocolVersion, state, approvedDigest: release.digest };
}

export function describePreparedRuntime(release) {
  const { manifest, ...description } = release;
  return { ...description, hostVersion: manifest.hostVersion, sdkVersion: manifest.sdkVersion, nodeVersion: manifest.nodeVersion, platform: manifest.platform, arch: manifest.arch,
    fileCount: manifest.files.filter(row => row.type === 'file').length, bytes: manifest.files.reduce((sum, row) => sum + (row.size ?? 0), 0) };
}
