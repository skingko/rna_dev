import { spawnGuardedCommand } from './command-process-guardian.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadSkill, CapabilityRegistry } from './capabilities.mjs';

export class CapabilityInstallError extends Error {
  constructor(message, code = 'invalid_install', details) { super(message); this.name = 'CapabilityInstallError'; this.code = code; if (details) this.details = details; }
}
const fail = (message, code, details) => { throw new CapabilityInstallError(message, code, details); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, name, max = 2000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(`${name} 必须为有效单行文本`); return value.trim(); };
const identifier = value => { const id = text(value, '能力 ID', 100); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) fail('能力 ID 格式无效'); return id; };
const inside = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const generatedId = value => { const simple = value.replace(/^@/, '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 75); return identifier(`${simple || 'capability'}-${hash(value).slice(0, 10)}`); };
const safeArgs = value => { const args = value ?? []; if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) fail('进程参数必须为最多 100 个字符串'); return [...args]; };
export function capabilityProcessEnv(extra = {}) {
  const env = {};
  for (const name of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, GIT_TERMINAL_PROMPT: '0', ...extra };
}
export async function resolveCapabilityCommand(command) {
  const name = text(command, '命令');
  const candidates = isAbsolute(name) ? [name] : name.includes('/') || name.includes('\\') ? [] : (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map(root => resolve(root, name));
  if (name === 'node') candidates.unshift(process.execPath);
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {} }
  fail(`找不到可执行命令：${name}`, 'command_unavailable');
}
/** Shell-free, bounded child process. Cancellation stops the process group. */
export async function runCapabilityProcess(command, args, { cwd, signal, timeoutMs = 120000, maxBytes = 1024 * 1024, env = {}, input } = {}) {
  signal?.throwIfAborted();
  const executable = await resolveCapabilityCommand(command);
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    let stdout = '', stderr = '', bytes = 0, cause, timer;
    const child = spawnGuardedCommand(executable, safeArgs(args), { cwd, env: capabilityProcessEnv(env) });
    const stop = error => { if (cause) return; cause = error; child.stop(); };
    const abort = () => stop(new DOMException('Capability operation cancelled', 'AbortError'));
    const capture = (key, chunk) => { bytes += chunk.length; if (bytes > maxBytes) return stop(new CapabilityInstallError('安装诊断超过大小限制', 'output_limit')); if (key === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8'); };
    child.stdout.on('data', chunk => capture('out', chunk)); child.stderr.on('data', chunk => capture('err', chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => { cause ??= new CapabilityInstallError('安装进程无法启动', 'process_failed'); });
    child.once('close', guardianCode => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child.commandResult.error) cause ??= new CapabilityInstallError('安装进程无法启动', 'process_failed');
      if (child.commandResult.cleanupUncertain) {
        cause ??= new CapabilityInstallError('安装进程清理状态无法确认；未向旧 PID 发送信号，请勿自动重试', 'process_cleanup_uncertain');
        cause.details = { ...cause.details, cleanupUncertain: true, startUncertain: child.commandResult.startUncertain };
      }
      if (child.commandResult.outputIncomplete) cause ??= new CapabilityInstallError('安装进程输出未完整结束', 'process_failed');
      if (cause) return reject(cause);
      const code = child.commandResult.exitCode ?? guardianCode;
      if (code !== 0) return reject(new CapabilityInstallError(`安装进程退出（${code}）`, 'process_failed', { exitCode: code, diagnostic: stderr.slice(-6000) || stdout.slice(-6000) }));
      resolvePromise({ stdout, stderr, exitCode: code });
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    timer = setTimeout(() => stop(new CapabilityInstallError('安装进程超时', 'install_timeout')), timeoutMs);
    child.stdin.end(input);
  });
}
function safeRegistry(value) {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('包源需要 HTTPS 或本机 HTTP，不能内嵌凭据');
  return url.href;
}
function npmSpec(value) {
  const spec = text(value, 'npm 包', 300);
  const match = spec.match(/^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s]+))?$/);
  if (!match || match[2]?.startsWith('-') || /[\\\0]/.test(spec)) fail('npm source 必须为包名及可选版本；Git 使用 git source');
  return { name: match[1], spec };
}
function permissionMap(value = {}) {
  if (!plain(value)) fail('allowTools 必须为工具名称到权限的映射');
  const result = {};
  for (const [key, rule] of Object.entries(value)) { if (!key || key.length > 500 || !plain(rule) || !['read', 'write', 'exec'].includes(rule.permission)) fail('每个授权工具需要 read、write 或 exec 权限'); Object.defineProperty(result, key, { value: { permission: rule.permission, idempotent: rule.idempotent === true }, enumerable: true, writable: true, configurable: true }); }
  return result;
}
function envReference(value) { const match = typeof value === 'string' && value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]{0,159})\}$/); if (!match) fail('凭据只接受 ${ENV_NAME} 引用；不要在安装配置中传入明文密钥', 'secret_reference_required'); return match[1]; }
function envMapping(value = {}) {
  if (!plain(value)) fail('env 必须为对象'); const mapping = {};
  for (const [key, reference] of Object.entries(value)) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(key)) fail('环境变量名称无效'); mapping[key] = envReference(reference); }
  return mapping;
}
function httpManifest(raw) {
  const endpoint = new URL(text(raw.url, 'MCP 地址'));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) fail('MCP 地址需 HTTPS 或本机 HTTP，不能内嵌凭据');
  const headerEnv = { ...(raw.headerEnv ?? {}) };
  for (const [key, value] of Object.entries(raw.headers ?? {})) headerEnv[key] = envReference(value);
  for (const [key, value] of Object.entries(headerEnv)) if (!/^[A-Za-z0-9-]{1,100}$/.test(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value)) fail('MCP headerEnv 无效');
  return { transport: 'http', url: endpoint.href, headerEnv };
}
function cleanSource(input) {
  if (!plain(input) || !['skill', 'mcp', 'tool'].includes(input.kind) || !plain(input.source)) fail('安装需要 kind 与 source');
  if (input.activate !== undefined && typeof input.activate !== 'boolean') fail('activate 必须为布尔值');
  if (input.toolPermission !== undefined && !['read', 'write', 'exec'].includes(input.toolPermission)) fail('toolPermission 必须为 read、write 或 exec');
  if (!['local', 'git', 'npm', 'mcp-config', 'command'].includes(input.source.type)) fail('不支持的安装来源');
  return structuredClone(input);
}
async function safeCopyTree(source, target, budget = { files: 0, bytes: 0 }) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) fail('技能目录不能包含符号链接', 'unsafe_bundle');
  if (++budget.files > 10000) fail('技能目录条目过多', 'bundle_limit');
  if (info.isDirectory()) { await mkdir(target, { recursive: true, mode: 0o700 }); for (const name of await readdir(source)) if (!['.git', 'node_modules', '.DS_Store'].includes(name)) await safeCopyTree(join(source, name), join(target, name), budget); }
  else if (info.isFile()) { budget.bytes += info.size; if (budget.bytes > 32 * 1024 * 1024) fail('技能目录超过 32 MiB', 'bundle_limit'); await copyFile(source, target, constants.COPYFILE_EXCL); await chmod(target, info.mode & 0o111 ? 0o700 : 0o600); }
  else fail('技能目录只能包含普通文件与目录', 'unsafe_bundle');
}
async function skillManifest(path, input, finalPath) {
  const provisional = { id: input.id ? identifier(input.id) : generatedId(basename(dirname(path))), path, name: input.name, description: input.description, enabled: true, trusted: true };
  const loaded = await loadSkill(provisional);
  return { ...provisional, name: input.name || loaded.name, description: input.description || loaded.description || loaded.name, path: finalPath, contentHash: loaded.contentHash };
}
/** Installs into private immutable generations; never writes project workspaces. */
export class CapabilityInstaller {
  constructor({ rootDir, npmCommand = 'npm', gitCommand = 'git', timeoutMs = 120000 } = {}) {
    if (!rootDir || !isAbsolute(rootDir)) fail('安装目录需要绝对路径');
    this.rootDir = resolve(rootDir); this.npmCommand = npmCommand; this.gitCommand = gitCommand; this.timeoutMs = timeoutMs;
  }
  async npmMetadata(source, { signal } = {}) {
    const parsed = npmSpec(source.package), registry = safeRegistry(source.registry);
    const { stdout } = await runCapabilityProcess(this.npmCommand, ['view', parsed.spec, '--json', ...(registry ? ['--registry', registry] : [])], { signal, timeoutMs: this.timeoutMs, env: { npm_config_ignore_scripts: 'true' } });
    let value; try { value = JSON.parse(stdout); } catch { fail('npm 元信息不是有效 JSON', 'invalid_package'); }
    if (Array.isArray(value)) value = value.at(-1);
    if (!plain(value) || value.name !== parsed.name || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) fail('npm 未返回确定的包名与版本', 'invalid_package');
    return { name: value.name, version: value.version, description: String(value.description ?? ''), bin: value.bin, scripts: Object.keys(value.scripts ?? {}).filter(key => ['preinstall', 'install', 'postinstall', 'prepare'].includes(key)), integrity: value.dist?.integrity ?? null, registry };
  }
  async inspect(raw, { signal } = {}) {
    const input = cleanSource(raw), source = input.source; signal?.throwIfAborted();
    if (source.type === 'npm') return { kind: input.kind, source: source.type, ...(await this.npmMetadata(source, { signal })), executesCode: false, lifecycleScripts: 'disabled' };
    if (source.type === 'mcp-config') { const rows = await this.importMcp(source.config, input); return { kind: 'mcp', source: source.type, servers: rows.map(row => ({ id: row.id, transport: row.source.type === 'npm' ? 'stdio' : row.transport, package: row.source.package, command: row.command, url: row.url })), executesCode: false }; }
    if (source.type === 'local' && input.kind === 'skill') { const root = await realpath(text(source.path, '技能路径')); const file = (await stat(root)).isDirectory() ? join(root, 'SKILL.md') : root; const manifest = await skillManifest(file, input, file); return { kind: 'skill', source: 'local', name: manifest.name, description: manifest.description, contentHash: manifest.contentHash, executesCode: false }; }
    if (source.type === 'git') { const repository = this.gitSource(source); return { kind: input.kind, source: 'git', repository, ref: source.ref ?? 'HEAD', subdirectory: source.subdirectory ?? '.', executesCode: false }; }
    if (input.kind === 'tool' && source.type === 'command') return { kind: 'tool', source: 'command', command: await resolveCapabilityCommand(source.command), executesCode: false };
    fail('该能力类型不支持此安装来源');
  }
  gitSource(source) {
    const repository = text(source.repository, 'Git 仓库');
    if (!isAbsolute(repository)) { let url; try { url = new URL(repository); } catch { fail('Git 仓库需 HTTPS 地址或绝对本地仓库路径'); } if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Git 仓库需无内嵌凭据的 HTTPS 地址'); }
    if (source.ref && (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(source.ref) || source.ref.includes('..'))) fail('Git ref 格式无效');
    return repository;
  }
  async importMcp(config, input) {
    if (typeof config === 'string') { try { config = JSON.parse(config); } catch { fail('MCP 配置必须为有效 JSON'); } }
    if (!plain(config?.mcpServers) || !Object.keys(config.mcpServers).length || Object.keys(config.mcpServers).length > 30) fail('MCP 配置需要 1–30 个 mcpServers 条目');
    const result = [];
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      if (!plain(raw)) fail('MCP 配置条目必须为对象');
      const id = identifier(raw.id ?? name), common = { id, name: raw.name || name, description: raw.description || raw.name || name, allowTools: permissionMap(raw.allowTools ?? input.allowTools), allowToolsSpecified: Object.hasOwn(raw, 'allowTools') || Object.hasOwn(input, 'allowTools'), enabled: raw.disabled !== true && raw.enabled !== false, trusted: true };
      if (raw.type === 'sse' || raw.transport === 'sse') fail('旧式 SSE MCP 暂不支持；请使用 Streamable HTTP', 'unsupported_transport');
      if (raw.url) { result.push({ ...common, ...httpManifest(raw), source: { type: 'mcp-config' } }); continue; }
      const command = text(raw.command, 'MCP 命令'), args = safeArgs(raw.args), envMappingValue = envMapping(raw.env), envNames = raw.envNames ?? [];
      if (!Array.isArray(envNames) || envNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(name))) fail('envNames 无效');
      for (const name of envNames) envMappingValue[name] = name;
      const cwd = raw.cwd ? resolve(text(raw.cwd, 'MCP cwd')) : this.rootDir;
      if (basename(command).replace(/\.cmd$/, '') === 'npx') {
        while (['-y', '--yes'].includes(args[0])) args.shift(); const packageName = args.shift(); npmSpec(packageName);
        result.push({ ...common, envMapping: envMappingValue, source: { type: 'npm', package: packageName, args, registry: raw.registry } });
      } else result.push({ ...common, transport: 'stdio', command: await resolveCapabilityCommand(command), args, cwd, envMapping: envMappingValue, source: { type: 'mcp-config' } });
    }
    return result;
  }
  async prepare(raw, { signal, installationId = randomUUID() } = {}) {
    const input = cleanSource(raw); identifier(installationId); signal?.throwIfAborted();
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 }); const canonicalRoot = await realpath(this.rootDir);
    const stagingDir = join(canonicalRoot, `.pending-${installationId}-${randomUUID()}`), installationDir = join(canonicalRoot, installationId);
    await mkdir(stagingDir, { mode: 0o700 }); let committed = false;
    const manifests = [], stagedManifests = [], diagnostics = [], sources = [];
    const finalPath = path => join(installationDir, relative(stagingDir, path));
    const add = (kind, staged, manifest) => { stagedManifests.push({ kind, manifest: staged }); manifests.push({ kind, manifest }); };
    try {
      const source = input.source;
      if (input.kind === 'skill' && ['local', 'git'].includes(source.type)) {
        let sourceRoot;
        if (source.type === 'local') { const original = await realpath(text(source.path, '技能路径')); sourceRoot = (await stat(original)).isDirectory() ? original : dirname(original); }
        else {
          const repository = this.gitSource(source), checkout = join(stagingDir, 'checkout');
          await runCapabilityProcess(this.gitCommand, ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--no-checkout', '--', repository, checkout], { signal, timeoutMs: this.timeoutMs });
          if (source.ref) await runCapabilityProcess(this.gitCommand, ['-C', checkout, 'fetch', '--depth', '1', 'origin', source.ref], { signal, timeoutMs: this.timeoutMs });
          await runCapabilityProcess(this.gitCommand, ['-C', checkout, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', source.ref ? 'FETCH_HEAD' : 'HEAD'], { signal, timeoutMs: this.timeoutMs });
          const { stdout } = await runCapabilityProcess(this.gitCommand, ['-C', checkout, 'rev-parse', 'HEAD'], { signal, timeoutMs: this.timeoutMs });
          if (/^[0-9a-f]{40}$/i.test(source.ref ?? '') && stdout.trim().toLowerCase() !== source.ref.toLowerCase()) fail('下载提交与固定来源版本不一致', 'source_changed');
          sourceRoot = await realpath(resolve(checkout, source.subdirectory ?? '.')); if (!inside(checkout, sourceRoot)) fail('技能子目录越出仓库', 'unsafe_bundle');
          const licenseFiles = [];
          for (const name of (await readdir(checkout)).filter(name => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-][A-Za-z0-9.-]+)?$/i.test(name)).slice(0, 12)) {
            const path = join(checkout, name), info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) fail('仓库许可文件不是有界普通文件，不能完整保留署名', 'unsafe_bundle');
            const body = await readFile(path); const location = join(stagingDir, 'source-provenance', name);
            await mkdir(dirname(location), { recursive: true, mode: 0o700 }); await writeFile(location, body, { flag: 'wx', mode: 0o600 });
            licenseFiles.push({ path: `source-provenance/${name}`, contentHash: hash(body), bytes: body.length });
          }
          sources.push({ type: 'git', repository, commit: stdout.trim(), subdirectory: source.subdirectory ?? '.', licenseFiles, licenseReview: 'preserved_not_legal_approval' });
        }
        const copied = join(stagingDir, 'skill'); await safeCopyTree(sourceRoot, copied); const file = join(copied, 'SKILL.md');
        const manifest = await skillManifest(file, { ...input, id: input.id ?? generatedId(basename(sourceRoot)) }, finalPath(file));
        add('skills', { ...manifest, path: file }, manifest); if (!sources.length) sources.push({ type: 'local', path: sourceRoot, contentHash: manifest.contentHash });
        if (source.type === 'git') await rm(join(stagingDir, 'checkout'), { recursive: true, force: true });
      } else if (source.type === 'npm' || input.kind === 'mcp' && source.type === 'mcp-config') {
        const rows = source.type === 'mcp-config' ? await this.importMcp(source.config, input) : [{ id: input.id ?? generatedId(npmSpec(source.package).name), name: input.name, description: input.description, allowTools: permissionMap(input.allowTools), allowToolsSpecified: Object.hasOwn(input, 'allowTools'), source, envMapping: envMapping(source.env) }];
        for (const row of rows) {
          signal?.throwIfAborted();
          if (row.source.type !== 'npm') { const { source: ignored, ...manifest } = row; add('mcpServers', manifest, manifest); sources.push({ type: 'mcp-config', id: row.id, transport: row.transport }); continue; }
          const meta = await this.npmMetadata(row.source, { signal }), packageRoot = join(stagingDir, `npm-${row.id}`);
          await mkdir(packageRoot, { mode: 0o700 }); await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rna-capability-installation', private: true, version: '1.0.0' }), { mode: 0o600 });
          await runCapabilityProcess(this.npmCommand, ['install', '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', '--package-lock=true', ...(meta.registry ? ['--registry', meta.registry] : []), `${meta.name}@${meta.version}`], { cwd: packageRoot, signal, timeoutMs: this.timeoutMs, env: { npm_config_ignore_scripts: 'true' } });
          const packageDir = join(packageRoot, 'node_modules', ...meta.name.split('/')), installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
          if (installed.name !== meta.name || installed.version !== meta.version) fail('下载后的包版本与已解析版本不同', 'package_changed');
          const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8')), locked = lock.packages?.[`node_modules/${meta.name}`];
          if (locked?.version !== meta.version || meta.integrity && locked.integrity !== meta.integrity) fail('已安装包的锁文件版本或完整性与检查结果不一致', 'package_changed');
          sources.push({ type: 'npm', name: meta.name, version: meta.version, integrity: meta.integrity, registry: meta.registry ?? null });
          diagnostics.push({ code: 'scripts_disabled', package: `${meta.name}@${meta.version}`, scripts: meta.scripts, message: '依赖安装脚本未运行。需要 native/postinstall 构建的包可能无法激活；不会自动运行这些脚本。' });
          if (input.kind === 'skill') {
            const sub = await realpath(resolve(packageDir, source.subdirectory ?? '.')); if (!inside(packageDir, sub)) fail('技能子目录越出 npm 包', 'unsafe_bundle');
            const copied = join(stagingDir, 'skill'); await safeCopyTree(sub, copied); const file = join(copied, 'SKILL.md'), manifest = await skillManifest(file, { ...input, id: row.id }, finalPath(file)); add('skills', { ...manifest, path: file }, manifest);
          } else {
            const bins = typeof installed.bin === 'string' ? { [meta.name.split('/').at(-1)]: installed.bin } : installed.bin;
            if (!plain(bins) || !Object.keys(bins).length) fail('该 npm 包没有可启动的 bin', 'missing_bin');
            const binName = row.source.bin ?? source.bin ?? (Object.keys(bins).length === 1 ? Object.keys(bins)[0] : null);
            if (!binName || !Object.hasOwn(bins, binName)) fail('包有多个入口，请明确指定 source.bin', 'ambiguous_bin');
            const binPath = await realpath(resolve(packageDir, bins[binName])); if (!inside(packageDir, binPath) || !(await stat(binPath)).isFile()) fail('npm bin 越出包目录', 'unsafe_bundle');
            const firstLine = (await readFile(binPath, 'utf8')).split('\n', 1)[0]; const nodeBin = /^#!.*\bnode(?:\s|$)/.test(firstLine) || /\.[cm]?js$/.test(binPath);
            if (!nodeBin) await chmod(binPath, 0o700);
            const manifest = { id: identifier(row.id), name: row.name || input.name || meta.name, description: row.description || input.description || meta.description || meta.name, enabled: row.enabled !== false, trusted: true, transport: 'stdio', command: nodeBin ? process.execPath : finalPath(binPath), args: [...(nodeBin ? [finalPath(binPath)] : []), ...safeArgs(row.source.args)], cwd: finalPath(packageRoot), envMapping: row.envMapping ?? {}, allowTools: permissionMap(row.allowTools), allowToolsSpecified: row.allowToolsSpecified === true };
            const staged = { ...manifest, command: nodeBin ? process.execPath : binPath, args: [...(nodeBin ? [binPath] : []), ...safeArgs(row.source.args)], cwd: packageRoot };
            if (input.kind === 'tool') { const fields = this.commandFields(input); delete manifest.transport; delete staged.transport; delete manifest.allowTools; delete staged.allowTools; add('tools', { ...staged, ...fields }, { ...manifest, ...fields }); }
            else add('mcpServers', staged, manifest);
          }
        }
      } else if (input.kind === 'tool' && source.type === 'command') {
        const command = await resolveCapabilityCommand(source.command), fields = this.commandFields(input), manifest = { id: identifier(input.id ?? generatedId(command)), name: input.name || input.id || generatedId(command), description: input.description || input.name || '命令工具', enabled: true, trusted: true, command, args: safeArgs(source.args), cwd: source.cwd ? resolve(source.cwd) : canonicalRoot, envMapping: envMapping(source.env), ...fields }; add('tools', manifest, manifest); sources.push({ type: 'command', command });
      } else fail('该能力类型不支持此安装来源');
      signal?.throwIfAborted();
      await writeFile(join(stagingDir, 'installation.json'), JSON.stringify({ installationId, manifests, sources, diagnostics }, null, 2), { mode: 0o600 });
      return { installationId, stagingDir, installationDir, manifests, stagedManifests, sources, diagnostics,
        async commit() { signal?.throwIfAborted(); if (committed) return; await rename(stagingDir, installationDir); committed = true; },
        async rollback() { await rm(committed ? installationDir : stagingDir, { recursive: true, force: true }); committed = false; }
      };
    } catch (error) {
      // An external command may still be writing here. Removing its cwd is
      // neither a rollback nor evidence that its effects stopped; retain the
      // unpublished generation so the caller can inspect and resolve it.
      if (error.details?.cleanupUncertain === true || error.details?.startUncertain === true || error.code === 'process_cleanup_uncertain') error.details = { ...error.details, cleanupUncertain: true, stagingDir, stagingRetained: true };
      else await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }
  commandFields(input) {
    const permission = input.permission ?? 'exec'; if (!['read', 'write', 'exec'].includes(permission)) fail('命令工具需要明确权限');
    const name = identifier(input.id ?? generatedId(input.name ?? 'command-tool')).replace(/\./g, '_').slice(0, 64);
    const parameters = input.parameters ?? { type: 'object', additionalProperties: true };
    new CapabilityRegistry({ tools: [{ id: name, name, parameters, execute() {}, permission, enabled: true, trusted: true }] });
    return { toolName: name.slice(0, 64), parameters, permission, idempotent: input.idempotent === true, protocol: 'json-stdin', timeoutMs: 30000 };
  }
}
