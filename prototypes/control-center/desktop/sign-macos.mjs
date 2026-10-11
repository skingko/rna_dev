#!/usr/bin/env node
// Sign a packaged Rna Agent.app with a Developer ID identity (hardened runtime, secure timestamp), rebuild the runtime
// manifest the signing changes, and write a signed disk image; with a notarytool keychain profile, notarize and staple.
// It runs on the machine that holds the certificate; the release workflow's unsigned build is its input.
//
//   node sign-macos.mjs <Rna Agent.app | .dmg> --identity <certificate hash or name> [--out <folder>]
//                       [--notary-profile <notarytool keychain profile>] [--keychain <keychain file>]
//                       [--notarize-image] [--notary-timeout <minutes, default 150>] [--image-timeout <minutes, default 60>]
//
// The app is notarized and stapled; the disk image is signed. Notarizing the image as well (--notarize-image) is only
// needed to have the .dmg file itself pass Gatekeeper's check: the app inside is accepted either way. The image is
// therefore best effort: if Apple has not answered within --image-timeout, the image stays signed (its app is notarized and
// stapled) and the run goes on, where the app's own notarization has to finish or the run fails.
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
const notaryMinutes = Number(argValue('--notary-timeout') ?? 150);
const notary = (...args) => spawnSync('/usr/bin/xcrun', ['notarytool', ...args, '--keychain-profile', profile, ...keychainArgs], { encoding: 'utf8' });
const sleepSeconds = seconds => run('/bin/sleep', [String(seconds)]);
/** Submit, then ask for the verdict every 30 s. Apple's queue can take an hour or more, and a dropped connection in the
 * middle of a long wait must not lose a submission that is still being processed, so the wait is ours, not notarytool's.
 * A submission is sometimes left "In Progress" for hours while a fresh one of the same file is answered in minutes, so
 * one that has had no verdict for 40 minutes gets a second copy beside it (three at most); the first verdict counts. */
function notarize(file, limitMinutes = notaryMinutes) {
  const submit = () => {
    const submitted = notary('submit', file, '--output-format', 'json');
    let id = null; try { id = JSON.parse(submitted.stdout).id; } catch { /* no submission id */ }
    if (submitted.status !== 0 || !id) throw new Error(`could not submit ${basename(file)}: ${(submitted.stderr || submitted.stdout || '').trim().slice(0, 400)}`);
    console.log(`submitted ${basename(file)}: ${id}`); return id;
  };
  const ids = [submit()], deadline = Date.now() + limitMinutes * 60000; let nextCopy = Date.now() + 40 * 60000, failures = 0;
  for (;;) {
    if (Date.now() > deadline) throw Object.assign(new Error(`notarization of ${basename(file)} is still in progress after ${limitMinutes} minutes; check it with: xcrun notarytool info ${ids.at(-1)} --keychain-profile ${profile}`), { timedOut: true });
    if (ids.length < 3 && Date.now() > nextCopy) { ids.push(submit()); nextCopy = Date.now() + 40 * 60000; }
    sleepSeconds(30);
    for (const id of ids) {
      const info = notary('info', id, '--output-format', 'json'); let status = null;
      try { status = JSON.parse(info.stdout).status; failures = 0; } catch { if (++failures > 40 * ids.length) throw new Error(`lost contact with the notary service for ${basename(file)}: ${(info.stderr || '').trim().slice(0, 300)}`); }
      if (status === 'Accepted') { console.log(`${basename(file)}: Accepted (${id})`); return; }
      if (status && status !== 'In Progress') { const log = notary('log', id); console.log(log.stdout || log.stderr); throw new Error(`notarization of ${basename(file)} was not accepted (${status})`); }
    }
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
  let imageNotarized = false;
  if (profile && process.argv.includes('--notarize-image')) {
    try { notarize(dmg, Number(argValue('--image-timeout') ?? 60)); run('/usr/bin/xcrun', ['stapler', 'staple', dmg]); imageNotarized = true; }
    catch (error) { if (!error.timedOut) throw error; console.warn(`::warning::${error.message}\nThe disk image is signed but not notarized; the app inside is notarized and stapled.`); }
  }
  // Gatekeeper's own verdict on what a user would download.
  const assessment = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg], { encoding: 'utf8' });
  console.log(`${assessment.stdout}${assessment.stderr}`.trim());
  const signed = join(outDirectory, 'Rna Agent.app'); rmSync(signed, { recursive: true, force: true }); cpSync(app, signed, { recursive: true, verbatimSymlinks: true });
  const sha = execFileSync('/usr/bin/shasum', ['-a', '256', dmg], { encoding: 'utf8' }).split(' ')[0];
  console.log(JSON.stringify({ dmg, app: signed, sha256: sha, version: buildManifest.version, arch: buildManifest.arch, notarized: Boolean(profile), imageNotarized }, null, 2));
} finally {
  if (mounted) spawnSync('/usr/bin/hdiutil', ['detach', mounted, '-force', '-quiet']);
  rmSync(work, { recursive: true, force: true });
}
