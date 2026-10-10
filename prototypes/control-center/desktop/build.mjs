import { createRuntimeManifest } from '../runtime-release.mjs';
import { packager } from '@electron/packager';
import { cpSync, copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
const here = import.meta.dirname, host = resolve(here, '..'), repository = resolve(host, '../..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const targetArch = arg('--arch') ?? process.arch, out = resolve(arg('--out') ?? join(here, 'dist'));
// One package per run, for the platform this runs on: macOS (.dmg), Linux (.tar.gz) or Windows (.zip). The bundled Node
// is the one given with --node, else the workspace runtime when present, else the Node running this build.
const platform = process.platform, exe = platform === 'win32' ? '.exe' : '', platformName = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[platform];
if (!platformName || !['arm64','x64'].includes(targetArch)) throw new Error('此构建入口生成 macOS、Linux 或 Windows 的 arm64/x64 安装包；必须提供相同架构的 Node。');
const workspaceNode = join(host, '.runtime/node/node_modules/node/bin/node');
const node = resolve(arg('--node') ?? (existsSync(workspaceNode) ? workspaceNode : process.execPath));
const npm = arg('--npm') ? resolve(arg('--npm')) : process.env.npm_execpath ? resolve(dirname(process.env.npm_execpath), '..') : null;
if (!npm || !existsSync(join(npm, 'bin/npm-cli.js'))) throw new Error('请通过 npm run package，或 --npm <npm 包目录> 提供 npm 分发。');
const nodeInfo = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch})'], { encoding: 'utf8' }));
const [major,minor] = nodeInfo.version.split('.').map(Number); if (major < 22 || major === 22 && minor < 19 || nodeInfo.arch !== targetArch) throw new Error('Node 必须 >=22.19.0，且与目标架构一致。');
const meta = JSON.parse(readFileSync(join(here, 'package.json'))), electronVersion = meta.devDependencies.electron;
const target = join(out, `Rna Agent-${platform}-${targetArch}`), artifact = join(out, `Rna-Agent-${meta.version}-${platformName}-${targetArch}.${{ darwin: 'dmg', linux: 'tar.gz', win32: 'zip' }[platform]}`), dmg = artifact;
if (existsSync(target) || existsSync(artifact)) throw new Error('输出已存在。请使用 --out 新目录，避免覆盖正在使用的安装包。');
const temporary = mkdtempSync(join(tmpdir(), 'rna-package-')), stage = join(temporary, 'app'); mkdirSync(stage);
const hashes = {}, files = [], hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function copyFile(source, destination) { if (lstatSync(source).isSymbolicLink()) throw new Error(`运行时白名单不接受符号链接：${source}`); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); files.push(relative(stage, destination)); hashes[relative(stage, destination)] = hash(source); }
function copyTree(source, destination, extensions) { for (const item of readdirSync(source, { withFileTypes: true })) { if (item.name.startsWith('.') || item.isSymbolicLink()) throw new Error(`白名单目录含隐藏文件或符号链接：${join(source,item.name)}`); if (item.isDirectory()) copyTree(join(source,item.name), join(destination,item.name), extensions); else if (!extensions || extensions.some(extension => item.name.endsWith(extension))) copyFile(join(source,item.name),join(destination,item.name)); } }
try {
  // macOS draws its icon set here; the other platforms use the same artwork rendered once into assets/.
  let icon = join(here, platform === 'win32' ? 'assets/icon.ico' : 'assets/icon.png');
  if (platform === 'darwin') { const iconset=join(temporary,'Rna.iconset'); icon=join(temporary,'Rna.icns'); execFileSync('/usr/bin/swift',[join(here,'make-icon.swift'),iconset]);execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',icon]); }
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: meta.name, productName: meta.productName, version: meta.version, main: 'desktop/main.cjs', description: meta.description, private: true }));
  for (const name of ['main.cjs','preload.cjs','runtime.cjs','discovery.cjs','ownership.cjs','directory-picker.cjs','preview-launcher.cjs','application-picker.cjs','managed-runtime.cjs','notifications.cjs','browser-webview.cjs','reveal-path.cjs']) copyFile(join(here,name),join(stage,'desktop',name));
  copyFile(join(here,'assets/icon.png'),join(stage,'desktop','icon.png'));
  const runtime = join(stage,'runtime'), runtimeHost = join(runtime,'prototypes/control-center');
  for (const name of ['discovery.cjs', 'managed-runtime.cjs']) copyFile(join(here, name), join(runtime, 'desktop', name));
  for (const file of readdirSync(host, { withFileTypes: true })) if (file.isFile() && (file.name.endsWith('.mjs') || file.name === 'package.json')) copyFile(join(host,file.name),join(runtimeHost,file.name));
  // Pure display modules shared by the CLI (the browser UI is web/dist only).
  copyTree(join(host,'presentation'),join(runtimeHost,'presentation'),['.mjs']);
  // The workbench UI ships as static files; without them the daemon only serves a "not built" page. A build older than
  // any of its sources is rebuilt first (0.63.2–0.67.0 shipped a stale UI because nothing checked this), and the
  // package refuses to go on if the build is still older than its sources.
  const web = join(host, 'web'), built = join(web, 'dist/index.html');
  const newestSource = () => { let newest = 0; const walk = path => { for (const item of readdirSync(path, { withFileTypes: true })) { if (item.name === 'node_modules' || item.name === 'dist' || item.name.startsWith('.')) continue; const full = join(path, item.name); if (item.isDirectory()) walk(full); else newest = Math.max(newest, lstatSync(full).mtimeMs); } }; walk(join(web, 'src')); for (const name of ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json']) if (existsSync(join(web, name))) newest = Math.max(newest, lstatSync(join(web, name)).mtimeMs); return newest; };
  const stale = () => !existsSync(built) || lstatSync(built).mtimeMs < newestSource();
  if (stale()) {
    if (!existsSync(join(web, 'node_modules/vite/bin/vite.js'))) throw new Error('界面构建产物缺失或早于源码，且没有 web/node_modules：请先在 prototypes/control-center/web 运行 npm ci。');
    execFileSync(node, [join(web, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: web, stdio: 'inherit' });
    if (stale()) throw new Error('界面构建后仍早于源码，已停止打包。');
  }
  copyTree(join(host,'web/dist'),join(runtimeHost,'web/dist'));
  // Terminal PTY (node-pty, MIT, optional): runtime JS, LICENSE and only the target arch's prebuilt
  // binaries. Loaded lazily by terminal-service.mjs; spawn-helper must stay executable.
  // macOS and Windows have prebuilt binaries; on Linux npm compiles them into build/Release. Without either (a Linux
  // host with no compiler) the package ships without node-pty and the terminal uses script(1).
  const pty = join(host,'node_modules/node-pty'), ptyStage = join(runtimeHost,'node_modules/node-pty');
  const ptyBinaries = [`prebuilds/${platform}-${targetArch}`, 'build/Release'].find(directory => existsSync(join(pty,directory,'pty.node')) || existsSync(join(pty,directory,'conpty.node'))) ?? null;
  if (!existsSync(join(pty,'package.json')) || !ptyBinaries && platform !== 'linux') throw new Error(`缺少 node-pty 运行文件（prebuilds/${platform}-${targetArch}）：请先在 prototypes/control-center 运行 npm ci。`);
  const ptyVersion = ptyBinaries ? JSON.parse(readFileSync(join(pty,'package.json'))).version : null;
  if (ptyBinaries) {
    for (const name of ['package.json','LICENSE']) copyFile(join(pty,name),join(ptyStage,name));
    for (const file of readdirSync(join(pty,'lib'),{recursive:true})) if (file.endsWith('.js') && !file.endsWith('.test.js')) copyFile(join(pty,'lib',file),join(ptyStage,'lib',file));
    if (ptyBinaries === 'build/Release') { for (const name of ['pty.node','spawn-helper']) if (existsSync(join(pty,ptyBinaries,name))) copyFile(join(pty,ptyBinaries,name),join(ptyStage,ptyBinaries,name)); }
    else copyTree(join(pty,ptyBinaries),join(ptyStage,ptyBinaries));
    if (existsSync(join(ptyStage,ptyBinaries,'spawn-helper'))) chmodSync(join(ptyStage,ptyBinaries,'spawn-helper'),0o755);
    // Prove the staged copy (not the source tree) works with the shipped Node: a real PTY where there is a POSIX shell,
    // the module and its native binding loading on Windows (a console session is not a given on a build machine).
    if (platform === 'win32') execFileSync(node,['-e',`const p=require(${JSON.stringify(ptyStage)});if(typeof p.spawn!=='function')process.exit(1)`],{stdio:'inherit',timeout:15000});
    else execFileSync(node,['-e',`const p=require(${JSON.stringify(ptyStage)});const t=p.spawn('/bin/sh',['-c','printf rna-pty-ok'],{cols:80,rows:24});let o='';t.onData(d=>o+=d);t.onExit(e=>{if(!o.includes('rna-pty-ok')||e.exitCode!==0){console.error(o);process.exit(1)}})`],{stdio:'inherit',timeout:15000});
  } else console.warn('node-pty was not built on this machine; the package ships without it and the terminal uses script(1).');
  copyTree(join(repository,'packages/sdk/src'),join(runtime,'packages/sdk/src'),['.mjs','.ts']);
  copyTree(join(repository,'packages/sdk/skills'),join(runtime,'packages/sdk/skills'),['.md','.mjs','.json']);
  copyFile(join(repository,'packages/sdk/package.json'),join(runtime,'packages/sdk/package.json'));
  // Host modules in subdirectories (e.g. benchmark/) ship only when a shipped module imports them;
  // then every literal relative import in the package must resolve, so a missed file fails the build, not the daemon.
  const importsOf = file => [...readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]);
  const pending = files.filter(path => path.endsWith('.mjs')).map(path => join(stage, path));
  for (let stagedFile; (stagedFile = pending.shift());) for (const specifier of importsOf(stagedFile)) {
    const staged = resolve(dirname(stagedFile), specifier);
    if (existsSync(staged) || !staged.startsWith(`${runtimeHost}${sep}`)) continue;
    const source = join(host, relative(runtimeHost, staged));
    if (!existsSync(source)) continue;
    copyFile(source, staged); pending.push(staged);
  }
  const unresolved = files.filter(path => path.endsWith('.mjs')).flatMap(path => importsOf(join(stage, path)).filter(specifier => !existsSync(resolve(dirname(join(stage, path)), specifier))).map(specifier => `${path} → ${specifier}`));
  if (unresolved.length) throw new Error(`运行包内有无法解析的模块引用：\n${unresolved.join('\n')}`);
  copyFile(node,join(runtime,`bin/node${exe}`)); chmodSync(join(runtime,`bin/node${exe}`),0o755);
  // A Node distribution keeps its LICENSE above bin/ (beside node.exe on Windows); the npm "node" package keeps it in its platform package.
  const nodeLicense = arg('--node-license') ? resolve(arg('--node-license')) : [resolve(dirname(node),'../LICENSE'),resolve(dirname(node),'LICENSE'),resolve(dirname(node),`../node_modules/node-bin-${platform}-${targetArch}/LICENSE`)].find(existsSync);
  if (!nodeLicense || !existsSync(nodeLicense)) throw new Error('Node 分发缺少 LICENSE；请提供完整 Node 分发的 bin/node 或 --node-license。');
  copyFile(nodeLicense,join(runtime,'NODE-LICENSE'));
  // npm is copied only from its installed distribution, never project node_modules.
  cpSync(npm,join(runtime,'lib/npm'),{recursive:true,dereference:false,verbatimSymlinks:true,filter:source=>!['.DS_Store','.npmrc'].includes(source.split('/').at(-1))});
  copyFile(join(here,'cli-launcher.mjs'),join(runtime,'bin/cli-launcher.mjs'));
  for (const [name,entry] of [['npm','../lib/npm/bin/npm-cli.js'],['npx','../lib/npm/bin/npx-cli.js'],['rna','cli-launcher.mjs']]) {
    if (platform === 'win32') writeFileSync(join(runtime,'bin',`${name}.cmd`),`@echo off\r\n"%~dp0node.exe" "%~dp0${entry.replaceAll('/','\\')}" %*\r\n`);
    else writeFileSync(join(runtime,'bin',name),`#!/bin/sh\nset -eu\nRNA_BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$RNA_BIN/node" "$RNA_BIN/${entry}" "$@"\n`,{mode:0o755});
  }
  writeFileSync(join(stage,'THIRD_PARTY_NOTICES.txt'),`Rna Agent ${platformName} ${targetArch} distribution\nElectron ${electronVersion}: MIT; see Electron LICENSE and LICENSES.chromium.html in Resources.\nNode.js ${nodeInfo.version}: MIT and bundled third-party licenses; https://github.com/nodejs/node/blob/v${nodeInfo.version}/LICENSE\nnpm ${JSON.parse(readFileSync(join(npm,'package.json'))).version}: Artistic-2.0; runtime/lib/npm/LICENSE\n${ptyVersion ? `node-pty ${ptyVersion}: MIT; runtime/prototypes/control-center/node_modules/node-pty/LICENSE\n` : ''}Marked and DOMPurify notices are embedded in public/memory-browser-display.js.\nNo Pi SDK, reference repositories, credentials, user projects or local state are included.\n${platform === 'darwin' ? 'This build uses ad-hoc signing, without Developer ID signing or Apple notarization.' : 'This build is not code-signed.'}\n`);
  const manifest = { schemaVersion:1, version:meta.version, electron:electronVersion, node:nodeInfo, npm:JSON.parse(readFileSync(join(npm,'package.json'))).version, nodePty:ptyVersion, platform,arch:targetArch,builtAt:new Date().toISOString(), signing:platform === 'darwin' ? 'ad-hoc (not Developer ID)' : 'unsigned',notarized:false,iconSha256:hash(icon),files,sourceHashes:hashes };
  writeFileSync(join(stage,'build-manifest.json'),JSON.stringify(manifest,null,2));
  mkdirSync(out,{recursive:true});
  const [packaged] = await packager({dir:stage,out,name:'Rna Agent',platform,arch:targetArch,electronVersion,appVersion:meta.version,buildVersion:meta.version,asar:false,prune:false,overwrite:false,
    ...(platform === 'darwin' ? { appBundleId:'local.rna-agent.desktop', icon } : platform === 'win32' ? { icon, win32metadata: { CompanyName: 'Rna Agent', FileDescription: 'Rna Agent', ProductName: 'Rna Agent' } } : {})});
  const appPath = platform === 'darwin' ? join(packaged,'Rna Agent.app') : packaged;
  const finalApp = platform === 'darwin' ? join(appPath, 'Contents/Resources/app') : join(appPath, 'resources/app'), finalRuntime = join(finalApp, 'runtime');
  // Electron's default packaging filters remove nested node_modules/.bin.
  // Restore the full bundled npm distribution before signing or inventory.
  rmSync(join(finalRuntime, 'lib/npm'), { recursive: true, force: true });
  cpSync(npm, join(finalRuntime, 'lib/npm'), { recursive: true, dereference: false, verbatimSymlinks: true, filter: source => !['.DS_Store', '.npmrc'].includes(source.split(/[\\/]/).at(-1)) });
  // Local ad-hoc signing needs no keychain identity. Do not swallow signing
  // failures or represent this as Developer ID signing / notarization.
  if (platform === 'darwin') execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',appPath],{stdio:'inherit'});
  // Inventory the actual final inner bytes. The last signature only seals
  // the outer app, so it cannot silently change a hashed inner Node binary.
  // (Windows runs the service inside the app's own session and has no release slots to verify.)
  if (platform !== 'win32') {
    const runtimeRelease = createRuntimeManifest({ runtimeRoot: finalRuntime, nodeVersion: nodeInfo.version, platform, arch: targetArch });
    manifest.runtimeReleaseDigest = runtimeRelease.digest;
  }
  writeFileSync(join(finalApp, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  const firstRun = '首次独立运行需配置模型；记忆可在设置中选用内置的本地记忆，或连接 OpenViking 服务。\nOn first run, configure a model; for memory choose the built-in local memory in Settings or connect an OpenViking service.\n';
  if (platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',appPath],{stdio:'inherit'});
    const disk = join(temporary,'disk');mkdirSync(disk);cpSync(appPath,join(disk,'Rna Agent.app'),{recursive:true,verbatimSymlinks:true});symlinkSync('/Applications',join(disk,'Applications'));
    writeFileSync(join(disk,'使用说明.txt'),`将 Rna Agent 拖到 Applications，双击启动。已有 Rna 本机服务时核对服务身份后自动连接；没有时启动应用自有后台，不导入其他目录凭据。\n菜单“复制 CLI 启动命令”可打开相同服务的终端会话。关闭窗口保留后台工作，退出只停止应用自有后台，外部服务保持运行。\n本构建仅经 ad-hoc 签名，未通过 Apple Developer ID 签名与公证。\n${firstRun}`);
    execFileSync('/usr/bin/hdiutil',['create','-volname','Rna Agent','-srcfolder',disk,'-ov','-format','UDZO',artifact],{stdio:'inherit'});
  } else {
    writeFileSync(join(appPath, 'README.txt'), `Rna Agent ${meta.version} (${platformName} ${targetArch})\n\n${platform === 'win32' ? 'Run "Rna Agent.exe". The background service runs while the app is open. The build is not code-signed, so Windows SmartScreen asks before the first run.' : 'Run ./"Rna Agent". If the window does not open on a distribution that restricts unprivileged user namespaces, start it with --no-sandbox or give chrome-sandbox root ownership and mode 4755.'}\nCommand line: resources/app/runtime/bin/rna${platform === 'win32' ? '.cmd' : ''}\n${firstRun}`);
    // bsdtar ships with Windows and writes .zip by extension (-a); Git's GNU tar on PATH does not.
    if (platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe'), ['-a', '-c', '-f', artifact, '-C', out, `Rna Agent-${platform}-${targetArch}`], { stdio: 'inherit' });
    else execFileSync('tar', ['-czf', artifact, '-C', out, `Rna Agent-${platform}-${targetArch}`], { stdio: 'inherit' });
  }
  const bytesOf = path => { let total = 0; for (const item of readdirSync(path, { withFileTypes: true })) { const full = join(path, item.name); if (item.isSymbolicLink()) continue; total += item.isDirectory() ? bytesOf(full) : lstatSync(full).size; } return total; };
  const report={...manifest,appPath,artifact,...(platform === 'darwin' ? { dmg: artifact, dmgSha256: hash(artifact) } : {}),artifactSha256:hash(artifact),appBytes:bytesOf(appPath)};writeFileSync(join(out,'build-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({appPath,artifact,...(platform === 'darwin' ? { dmg: artifact } : {}),sha256:report.artifactSha256,signing:report.signing,notarized:false},null,2));
} finally { rmSync(temporary,{recursive:true,force:true}); }
