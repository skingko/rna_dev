#!/usr/bin/env node
// Sign a packaged Rna Agent.app with a Developer ID identity (hardened runtime, secure timestamp), rebuild the runtime
// manifest the signing changes, and write a signed disk image; with a notarytool keychain profile, notarize and staple.
// It runs on the machine that holds the certificate; the release workflow's unsigned build is its input.
//
//   node sign-macos.mjs <Rna Agent.app | .dmg> --identity <certificate hash or name> [--out <folder>]
//                       [--notary-profile <notarytool keychain profile>] [--keychain <keychain file>]
//
// Nothing secret is read or printed: codesign and notarytool use the login keychain themselves.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRuntimeManifest } from '../runtime-release.mjs';

const here = import.meta.dirname;
const argValue = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const input = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : null;
const identity = argValue('--identity') ?? process.env.RNA_SIGN_IDENTITY, profile = argValue('--notary-profile') ?? process.env.RNA_NOTARY_PROFILE ?? null;
const outDirectory = resolve(argValue('--out') ?? join(dirname(input ?? '.'), 'signed'));
const keychain = argValue('--keychain'), keychainArgs = keychain ? ['--keychain', resolve(keychain)] : [];
const entitlements = join(here, 'entitlements.mac.plist');
if (process.platform !== 'darwin') throw new Error('signing runs on macOS');
if (!input || !identity) throw new Error('usage: sign-macos.mjs <Rna Agent.app|.dmg> --identity <hash or name> [--out folder] [--notary-profile name]');

const run = (program, args, options = {}) => execFileSync(program, args, { stdio: 'inherit', ...options });
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
function isMachO(file) {
  const fd = openSync(file, 'r'); try { const buffer = Buffer.alloc(4); return readSync(fd, buffer, 0, 4, 0) === 4 && MAGIC.has(buffer.readUInt32BE(0)); } finally { closeSync(fd); }
}
/** Every Mach-O file and every nested bundle under the app, deepest first (a bundle is signed after what it contains). */
function inventory(app) {
  const machO = [], bundles = [];
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { if (/\.(?:framework|app|xpc|appex|bundle)$/.test(item.name) && path !== app) bundles.push(path); walk(path); }
      else if (item.isFile() && lstatSync(path).size >= 4 && isMachO(path)) machO.push(path);
    }
  };
  walk(app);
  const depth = path => path.split('/').length;
  return { machO: machO.sort((a, b) => depth(b) - depth(a)), bundles: bundles.sort((a, b) => depth(b) - depth(a)) };
}
const sign = (path, extra = []) => run('/usr/bin/codesign', ['--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, ...keychainArgs, ...extra, path]);

function makeDisk(app, destination) {
  const staging = mkdtempSync(join(tmpdir(), 'rna-sign-disk-')), disk = join(staging, 'disk'); mkdirSync(disk);
  try {
    cpSync(app, join(disk, 'Rna Agent.app'), { recursive: true, verbatimSymlinks: true }); symlinkSync('/Applications', join(disk, 'Applications'));
    writeFileSync(join(disk, 'README.txt'), '将 Rna Agent 拖到 Applications，双击启动。\nDrag Rna Agent to Applications and open it.\n\n首次独立运行需配置模型；记忆可在设置中选用内置的本地记忆，或连接 OpenViking 服务。\nOn first run, configure a model; for memory choose the built-in local memory in Settings or connect an OpenViking service.\n');
    rmSync(destination, { force: true });
    for (let attempt = 1; ; attempt++) {
      try { run('/usr/bin/hdiutil', ['create', '-volname', 'Rna Agent', '-srcfolder', disk, '-ov', '-format', 'UDZO', destination]); break; }
      catch (error) { if (attempt >= 5) throw error; run('/bin/sleep', [String(attempt * 5)]); rmSync(destination, { force: true }); }
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function notarize(file) {
  // notarytool prints the submission id and the verdict; a rejection exits non-zero and its log says why.
  const result = spawnSync('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, ...keychainArgs, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`; process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  let verdict = null; try { verdict = JSON.parse(result.stdout); } catch { /* not JSON: an error before submission */ }
  if (result.status !== 0 || verdict?.status !== 'Accepted') {
    if (verdict?.id) spawnSync('/usr/bin/xcrun', ['notarytool', 'log', verdict.id, '--keychain-profile', profile, ...keychainArgs], { stdio: 'inherit' });
    throw new Error(`notarization of ${basename(file)} was not accepted (${verdict?.status ?? 'no verdict'})`);
  }
}

const work = mkdtempSync(join(tmpdir(), 'rna-sign-')); let mounted = null;
try {
  let source = input;
  if (input.endsWith('.dmg')) {
    mounted = join(work, 'mount'); mkdirSync(mounted);
    run('/usr/bin/hdiutil', ['attach', input, '-nobrowse', '-readonly', '-mountpoint', mounted, '-quiet']);
    source = join(mounted, 'Rna Agent.app');
  }
  if (!existsSync(join(source, 'Contents/MacOS'))) throw new Error(`not an application bundle: ${source}`);
  const app = join(work, 'Rna Agent.app'); cpSync(source, app, { recursive: true, verbatimSymlinks: true });
  if (mounted) { run('/usr/bin/hdiutil', ['detach', mounted, '-quiet']); mounted = null; }
  // The unsigned (ad-hoc) signature goes; every Mach-O file is signed on its own, then each bundle, then the app.
  const { machO, bundles } = inventory(app);
  console.log(`signing ${machO.length} binaries and ${bundles.length} bundles`);
  for (const file of machO) sign(file);
  for (const bundle of bundles) sign(bundle);
  sign(app);
  // The runtime's file inventory records the bytes of the bundled Node; signing changed them, so it is taken again,
  // and the app's own signature is sealed over the new manifest (nested signatures are left as they are).
  const finalApp = join(app, 'Contents/Resources/app'), finalRuntime = join(finalApp, 'runtime');
  const buildManifest = JSON.parse(readFileSync(join(finalApp, 'build-manifest.json'), 'utf8'));
  const release = createRuntimeManifest({ runtimeRoot: finalRuntime, nodeVersion: buildManifest.node.version, platform: 'darwin', arch: buildManifest.arch });
  Object.assign(buildManifest, { runtimeReleaseDigest: release.digest, signing: `Developer ID (${identity.length === 40 ? 'certificate ' : ''}${identity.slice(0, 40)})`, notarized: Boolean(profile), signedAt: new Date().toISOString() });
  writeFileSync(join(finalApp, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2));
  sign(app);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  mkdirSync(outDirectory, { recursive: true });
  const name = `Rna-Agent-${buildManifest.version}-macOS-${buildManifest.arch}`, dmg = join(outDirectory, `${name}.dmg`);
  if (profile) {
    const archive = join(work, 'app.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
    notarize(archive); run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  }
  makeDisk(app, dmg);
  run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, ...keychainArgs, dmg]);
  if (profile) { notarize(dmg); run('/usr/bin/xcrun', ['stapler', 'staple', dmg]); }
  // Gatekeeper's own verdict on what a user would download.
  const assessment = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg], { encoding: 'utf8' });
  console.log(`${assessment.stdout}${assessment.stderr}`.trim());
  const signed = join(outDirectory, 'Rna Agent.app'); rmSync(signed, { recursive: true, force: true }); cpSync(app, signed, { recursive: true, verbatimSymlinks: true });
  const sha = execFileSync('/usr/bin/shasum', ['-a', '256', dmg], { encoding: 'utf8' }).split(' ')[0];
  console.log(JSON.stringify({ dmg, app: signed, sha256: sha, version: buildManifest.version, arch: buildManifest.arch, notarized: Boolean(profile) }, null, 2));
} finally {
  if (mounted) spawnSync('/usr/bin/hdiutil', ['detach', mounted, '-force', '-quiet']);
  rmSync(work, { recursive: true, force: true });
}
