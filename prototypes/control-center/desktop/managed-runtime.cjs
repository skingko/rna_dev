const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
// These refusals reach the desktop's startup-failure dialog, in the interface language it passes ('zh' for the CLI).
const TEXT = {
  zh: { stateDir: '应用服务状态目录不匹配。', unregistered: '应用服务指向未登记的运行目录，未执行其中的程序。', noRecord: '应用运行版本没有可核对的登记记录。', mismatch: '登记版本与应用运行内容不匹配。', health: '服务运行身份与已验证的应用版本不匹配。' },
  en: { stateDir: 'The app service state folder does not match.', unregistered: 'The app service points to an unregistered runtime folder; nothing in it was run.', noRecord: 'The app runtime version has no record to verify it against.', mismatch: 'The registered version does not match the app runtime contents.', health: 'The running service does not match the verified app version.' }
};
const say = (language, key) => TEXT[language === 'en' ? 'en' : 'zh'][key];

function preparedRuntimeIdentity(release) {
  const digest = createHash('sha256'), manifest = release.manifest;
  digest.update(`rna-runtime-source-v1\0v${manifest.nodeVersion.replace(/^v/, '')}\0${manifest.platform}\0${manifest.arch}\0`);
  for (const [label, directory] of [['host', release.paths.host], ['sdk', resolve(release.paths.host, '../../packages/sdk/src')]]) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith('.mjs')).sort((a, b) => a.name.localeCompare(b.name))) digest.update(`${label}/${entry.name}\0`).update(readFileSync(join(directory, entry.name))).update('\0');
  }
  return digest.digest('hex');
}

function sharedNodeMatches(release) {
  const row = release.manifest.files?.find(file => file.path === 'bin/node' && file.type === 'file');
  try { return Boolean(row) && createHash('sha256').update(readFileSync(release.paths.sharedNode)).digest('hex') === row.sha256; } catch { return false; }
}
/** Read and hash through the bundled verifier; never import or execute a candidate to verify it. */
async function resolveManagedRuntime({ paths, stateFile, config, verifyRuntime, language = 'zh' }) {
  if (!config || config.stateFile !== stateFile) throw Error(say(language, 'stateDir'));
  const slots = `${stateFile}.service/releases/`, sharedNodes = `${stateFile}.service/node/`;
  if ((!config.command || config.command === paths.node) && (!config.cwd || config.cwd === paths.host) && ![config.command, config.cwd].some(value => String(value ?? '').startsWith(slots))) return { paths, release: null };
  // Releases run either their own bin/node or the shared copy under <service>/node (stable path for macOS privacy grants).
  const directory = dirname(dirname(config.cwd ?? '')), candidateId = directory.split(/[\\/]/).at(-1), expected = resolve(`${stateFile}.service/releases`, candidateId ?? '');
  if (!id(candidateId) || directory !== expected || !(config.command === join(expected, 'bin/node') || String(config.command ?? '').startsWith(sharedNodes)) || config.cwd !== join(expected, 'prototypes/control-center')) throw Error(say(language, 'unregistered'));
  const registry = read(`${stateFile}.service/maintenance-registry.json`), candidate = registry?.schemaVersion === 1 && registry.candidates?.find(row => row.id === candidateId);
  if (!candidate || candidate.baselineOnly || !/^[a-f0-9]{64}$/.test(candidate.digest ?? '')) throw Error(say(language, 'noRecord'));
  const verify = verifyRuntime ?? (await import(pathToFileURL(join(paths.host, 'runtime-release.mjs')).href)).verifyPreparedRuntime, state = read(stateFile);
  const release = await verify({ directory: expected, expectedDigest: candidate.digest, policy: { allowedDigests: [candidate.digest], platform: process.platform, arch: process.arch, hostProtocolVersion: 1, stateVersion: state?.version, allowedWriteVersions: [2] } });
  if (!(release.paths.node === config.command || release.paths.sharedNode === config.command && sharedNodeMatches(release)) || release.paths.host !== config.cwd || release.digest !== candidate.digest || release.manifest.hostVersion !== candidate.hostVersion || release.manifest.sdkVersion !== candidate.sdkVersion) throw Error(say(language, 'mismatch'));
  return { paths: release.paths, release, runtimeIdentity: preparedRuntimeIdentity(release) };
}
function assertManagedHealth(health, selected, language = 'zh') {
  if (!selected.release) return;
  if (health.runtimeIdentity !== selected.runtimeIdentity || health.version !== selected.release.manifest.hostVersion || health.sdkVersion !== selected.release.manifest.sdkVersion) throw Error(say(language, 'health'));
}
module.exports = { resolveManagedRuntime, preparedRuntimeIdentity, assertManagedHealth };
