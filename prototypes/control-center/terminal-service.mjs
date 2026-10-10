import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { registeredWorkspacePath } from './workspace-directories.mjs';
import { permissionLevel, permissionSettings } from './project-permissions.mjs';
import { workspaceExecEnvironment } from '../../packages/sdk/src/workspace-exec.mjs';
import { interfaceLanguageOf, inLanguage } from './interface-language.mjs';

// Side-panel terminals (docs/specs/stream-protocol-v2.md "Terminals"): interactive
// shells in the project workspace. node-pty is optional and loaded lazily; without it
// macOS/Linux use a `script(1)` pseudo-terminal (no resize). This is a user-driven shell
// with the daemon user's rights, gated to projects whose saved permission is execute.
// A terminal opened for a conversation (`sessionId`, worktree design 0.63 §9) starts in that conversation's root: its
// own worktree when it runs in one (RootResolver), else the project folder; it closes when that root changes.
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const within = (root, path) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
// Rna/runtime internals and anything secret-shaped never reach the user shell.
const SCRUB = /^(?:RNA_|PI_FORGE_|ELECTRON_|TYPESAFE_|OPENVIKING_|npm_|NODE_CHANNEL_|NODE_UNIQUE_ID$|NODE_OPTIONS$)|(?:API_?KEY|_TOKEN|SECRET|PASSWORD|PASSWD)$/iu;
export function terminalEnvironment(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === 'string' && !SCRUB.test(key)));
  return { ...workspaceExecEnvironment(clean), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'RnaAgent', LANG: clean.LANG || 'en_US.UTF-8' };
}
export function terminalShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return env.ComSpec || 'cmd.exe';
  return [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find(path => typeof path === 'string' && isAbsolute(path) && executable(path)) ?? '/bin/sh';
}
// node-pty 1.1.0 prebuilds ship spawn-helper without the executable bit; repair once.
export function loadPty({ require = createRequire(import.meta.url) } = {}) {
  try {
    const pty = require('node-pty'), root = dirname(require.resolve('node-pty/package.json'));
    if (process.platform !== 'win32') {
      const helper = [join(root, 'build/Release/spawn-helper'), join(root, `prebuilds/${process.platform}-${process.arch}/spawn-helper`)].find(existsSync);
      if (!helper) return null;
      if (!(statSync(helper).mode & 0o111)) try { chmodSync(helper, 0o755); } catch {}
      if (!executable(helper)) return null;
    }
    return typeof pty.spawn === 'function' ? pty : null;
  } catch { return null; }
}
const scriptBinary = platform => platform === 'win32' ? null : ['/usr/bin/script', '/bin/script'].find(executable) ?? null;
const EXIT_MARK = /\x1b\]697;rna-exit=(\d{1,3})\x07/u;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// Spawn through script(1). BSD script needs a non-socket, non-FIFO stdin, so macOS gets
// an anonymous pipe from `cat`; the inner shell reports its status with a private OSC mark.
function spawnScript({ script, shell, cwd, env, platform }) {
  const inner = `${quote(shell)} -l; printf '\\033]697;rna-exit=%s\\007' "$?"`;
  const [command, args] = platform === 'darwin' ? ['/bin/sh', ['-c', `cat | ${quote(script)} -q /dev/null /bin/sh -c ${quote(inner)}`]] : [script, ['-qfec', inner, '/dev/null']];
  return spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export class TerminalService {
  constructor(store, { maxPerProject = 6, maxTotal = 24, idleMs = 30 * 60000, exitedRetentionMs = 5 * 60000, bufferBytes = 1024 * 1024, maxClients = 4, maxStreams = 32, heartbeatMs = 15000, inputBytesPerSecond = 256 * 1024, createsPerMinute = 20, pty = undefined, platform = process.platform, env = process.env, headers = {}, roots = null } = {}) {
    Object.assign(this, { store, maxPerProject, maxTotal, idleMs, exitedRetentionMs, bufferBytes, maxClients, maxStreams, heartbeatMs, inputBytesPerSecond, createsPerMinute, platform, env, headers, roots });
    this.pty = pty === undefined ? loadPty() : pty; this.script = scriptBinary(platform);
    this.terminals = new Map(); this.creates = new Map(); this.streams = 0; this.closed = false;
    this.unsubscribe = store.subscribe(() => { for (const terminal of this.terminals.values()) if (!terminal.exit && !this.allowed(terminal)) this.kill(terminal, 'permission'); }, { display: false });
    this.sweeper = setInterval(() => this.sweep(), Math.min(60000, Math.max(1000, Math.floor(idleMs / 4)))); this.sweeper.unref?.();
  }
  say(variants) { return inLanguage(interfaceLanguageOf(this.store.state), variants); }
  get capability() { return this.pty ? 'pty' : this.script ? 'fallback' : false; }
  project(id) {
    const project = this.store.state.projects.find(row => row.id === id);
    if (!project) throw fail('项目不存在。', 'PROJECT_NOT_FOUND', 404);
    if (project.archivedAt) throw fail('项目已归档。', 'PROJECT_ARCHIVED', 409);
    return project;
  }
  // Same bar as running commands: saved workspace permission 完全访问 (execute).
  executeAllowed(project) { return Boolean(project && !project.archivedAt && permissionSettings(project).workspace === 'execute' && permissionLevel(project) === 'execute'); }
  // The project's identity and, for a conversation's terminal, its root: state must still name the same worktree (or
  // the project folder) for that conversation.
  allowed(terminal) {
    const project = this.store.state.projects.find(row => row.id === terminal.projectId);
    if (this.closed || !this.executeAllowed(project) || project.workspace !== terminal.workspace) return false;
    if (!terminal.sessionId) return true;
    if (this.roots) return this.roots.current({ projectId: terminal.projectId, sessionId: terminal.sessionId }, { kind: terminal.rootKind, worktreeId: terminal.worktreeId });
    const session = this.store.state.sessions.find(row => row.id === terminal.sessionId);
    return session?.projectId === project.id && !session.worktree;
  }
  root(project) {
    let root; try { root = realpathSync(registeredWorkspacePath(project.workspace)); } catch { throw fail('工作目录不可用。', 'WORKSPACE_UNAVAILABLE', 409); }
    if (!statSync(root).isDirectory()) throw fail('工作目录不可用。', 'WORKSPACE_UNAVAILABLE', 409);
    return root;
  }
  cwd(root, input) {
    if (input === undefined || input === null || input === '' || input === '.') return root;
    if (typeof input !== 'string' || input.length > 1024 || input.includes('\0')) throw fail('终端目录无效。', 'TERMINAL_CWD_INVALID');
    let target; try { target = realpathSync(resolve(root, input)); } catch { throw fail('终端目录不存在。', 'TERMINAL_CWD_INVALID'); }
    if (!within(root, target)) throw fail('终端目录必须位于项目工作目录内。', 'TERMINAL_CWD_DENIED', 403);
    if (!statSync(target).isDirectory()) throw fail('终端目录必须是文件夹。', 'TERMINAL_CWD_INVALID');
    return target;
  }
  size(input, fallback) {
    const cols = input?.cols ?? fallback?.cols ?? 80, rows = input?.rows ?? fallback?.rows ?? 24;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw fail('终端尺寸无效：cols 2–500，rows 1–300。', 'TERMINAL_SIZE_INVALID');
    return { cols, rows };
  }
  view(terminal) { return { id: terminal.id, projectId: terminal.projectId, title: terminal.title, cwd: terminal.cwd, shell: terminal.shell, capability: terminal.capability, cols: terminal.cols, rows: terminal.rows, status: terminal.exit ? 'exited' : 'running', exit: terminal.exit, seq: terminal.seq, createdAt: terminal.createdAt, clients: terminal.clients.size, ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}), ...(terminal.worktreeId ? { worktreeId: terminal.worktreeId } : {}) }; }
  list(projectId) { if (!this.store.state.projects.some(row => row.id === projectId)) throw fail('项目不存在。', 'PROJECT_NOT_FOUND', 404); return { projectId, capability: this.capability, terminals: [...this.terminals.values()].filter(row => row.projectId === projectId).map(row => this.view(row)) }; }
  get(id) { return this.terminals.get(id) ?? (() => { throw fail('终端不存在或已关闭。', 'TERMINAL_NOT_FOUND', 404); })(); }
  /**
   * Open a terminal. With `sessionId` it starts in that conversation's root (its worktree, or the project folder) and
   * the answer is a promise (the root is resolved first); without it, in the project folder, synchronously as before.
   */
  create(projectId, input = {}) {
    if (input && typeof input === 'object' && input.sessionId !== undefined && input.sessionId !== null) return this.createInSession(projectId, input);
    if (input && typeof input === 'object' && 'sessionId' in input) { const { sessionId: _none, ...rest } = input; return this.open(projectId, rest, null); }
    return this.open(projectId, input, null);
  }
  async createInSession(projectId, input) {
    this.check(projectId, input);
    if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200) throw fail('终端参数无效。', 'TERMINAL_ARGUMENTS_INVALID');
    let info;
    if (this.roots) info = await this.roots.rootOf({ projectId, sessionId: input.sessionId });
    else {
      const session = this.store.state.sessions.find(row => row.id === input.sessionId);
      if (!session || session.projectId !== projectId) throw fail(this.say({ zh: '这个对话不属于该项目。', en: 'This conversation isn’t part of the project.' }), 'SESSION_NOT_FOUND', 404);
      if (session.worktree) throw fail(this.say({ zh: '这个对话的工作树现在不可用。', en: 'This conversation’s worktree isn’t available right now.' }), 'worktree_unavailable', 409);
      info = null;
    }
    return this.open(projectId, input, { sessionId: input.sessionId, info });
  }
  check(projectId, input) {
    if (this.closed) throw fail('终端服务已关闭。', 'TERMINAL_CLOSED', 503);
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['cols', 'rows', 'cwd', 'sessionId'].includes(key))) throw fail('终端参数无效。', 'TERMINAL_ARGUMENTS_INVALID');
    const project = this.project(projectId);
    if (!this.executeAllowed(project)) throw fail('终端需要此项目的权限为“完全访问”（读写文件并执行命令）。', 'TERMINAL_PERMISSION_DENIED', 403);
    if (!this.capability) throw fail('此平台没有可用的终端实现。', 'TERMINAL_UNAVAILABLE', 501);
    return project;
  }
  /** A root RootResolver answered: still a real directory. */
  folder(path) {
    let root; try { root = realpathSync(path); } catch { throw fail('工作目录不可用。', 'WORKSPACE_UNAVAILABLE', 409); }
    if (root !== path || !statSync(root).isDirectory()) throw fail('工作目录不可用。', 'WORKSPACE_UNAVAILABLE', 409);
    return root;
  }
  open(projectId, input = {}, owner = null) {
    const project = this.check(projectId, input), info = owner?.info ?? null;
    const { cols, rows } = this.size(input), root = info ? this.folder(info.root) : this.root(project), cwd = this.cwd(root, input.cwd);
    const running = [...this.terminals.values()].filter(row => !row.exit);
    if (running.filter(row => row.projectId === projectId).length >= this.maxPerProject) throw fail(`每个项目最多同时打开 ${this.maxPerProject} 个终端。`, 'TERMINAL_LIMIT', 429);
    if (running.length >= this.maxTotal) throw fail('打开的终端过多，请先关闭一些。', 'TERMINAL_LIMIT', 429);
    const now = Date.now(), recent = (this.creates.get(projectId) ?? []).filter(at => now - at < 60000);
    if (recent.length >= this.createsPerMinute) throw fail('终端创建过于频繁，请稍后重试。', 'TERMINAL_RATE_LIMITED', 429);
    this.creates.set(projectId, [...recent, now]);
    const shell = terminalShell(this.env, this.platform), env = terminalEnvironment(this.env), index = [...this.terminals.values()].filter(row => row.projectId === projectId).length + 1;
    const terminal = { id: randomUUID(), projectId, workspace: project.workspace, ...(owner ? { sessionId: owner.sessionId, rootKind: info?.kind ?? 'project', ...(info?.worktreeId ? { worktreeId: info.worktreeId } : {}) } : {}), root, cwd, shell, cols, rows, title: `${basename(shell)} ${index}`, createdAt: new Date(now).toISOString(), lastActivity: now, seq: Date.now() * 1000, chunks: [], chunkBytes: 0, clients: new Set(), exit: null, input: { at: now, bytes: 0 } };
    this.start(terminal, env);
    this.terminals.set(terminal.id, terminal);
    return this.view(terminal);
  }
  start(terminal, env) {
    if (this.pty) try {
      const proc = this.pty.spawn(terminal.shell, this.platform === 'win32' ? [] : ['-l'], { name: 'xterm-256color', cols: terminal.cols, rows: terminal.rows, cwd: terminal.cwd, env });
      terminal.capability = 'pty'; terminal.proc = proc;
      proc.onData(text => this.output(terminal, Buffer.from(text, 'utf8')));
      proc.onExit(({ exitCode, signal }) => this.exited(terminal, { code: exitCode ?? null, signal: signal ? String(signal) : null }));
      terminal.write = bytes => proc.write(bytes.toString('utf8'));
      terminal.resize = (cols, rows) => { proc.resize(cols, rows); return true; };
      terminal.signal = signal => { try { proc.kill(signal); } catch {} try { process.kill(-proc.pid, signal); } catch {} };
      return;
    } catch (error) { if (!this.script) throw fail(`终端启动失败：${error.message}`, 'TERMINAL_START_FAILED', 500); this.pty = null; }
    if (!this.script) throw fail('此平台没有可用的终端实现。', 'TERMINAL_UNAVAILABLE', 501);
    const child = spawnScript({ script: this.script, shell: terminal.shell, cwd: terminal.cwd, env: { ...env, COLUMNS: String(terminal.cols), LINES: String(terminal.rows) }, platform: this.platform });
    terminal.capability = 'fallback'; terminal.proc = child; let carry = '', marked = null;
    const data = bytes => {
      this.output(terminal, bytes);
      const text = carry + bytes.toString('latin1'), mark = text.match(EXIT_MARK); carry = text.slice(-32);
      if (mark && marked === null) { marked = Number(mark[1]); terminal.signal('SIGTERM'); }
    };
    child.stdout.on('data', data); child.stderr.on('data', data); child.stdin.on('error', () => {}); child.on('error', () => {});
    child.stdout.once('end', () => { try { child.stdin.end(); } catch {} });
    child.once('exit', (code, signal) => this.exited(terminal, marked !== null ? { code: marked, signal: null } : { code, signal }));
    terminal.write = bytes => { if (child.stdin.writable) child.stdin.write(bytes); };
    terminal.resize = () => false;
    terminal.signal = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
  }
  output(terminal, bytes) {
    if (!bytes.length) return;
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
      const chunk = bytes.subarray(offset, offset + 48 * 1024), seq = ++terminal.seq;
      terminal.chunks.push({ seq, bytes: chunk }); terminal.chunkBytes += chunk.length;
      while (terminal.chunkBytes > this.bufferBytes && terminal.chunks.length > 1) terminal.chunkBytes -= terminal.chunks.shift().bytes.length;
      const frame = `id: ${seq}\nevent: data\ndata: ${JSON.stringify({ seq, b64: chunk.toString('base64') })}\n\n`;
      for (const client of terminal.clients) client.write(frame);
    }
  }
  exited(terminal, exit) {
    if (terminal.exit) return;
    clearTimeout(terminal.forceKill);
    terminal.exit = { code: Number.isInteger(exit.code) ? exit.code : null, signal: exit.signal ?? null, reason: terminal.reason ?? null, at: new Date().toISOString() };
    terminal.exitedAt = Date.now();
    const frame = `event: exit\ndata: ${JSON.stringify({ id: terminal.id, ...terminal.exit })}\n\n`;
    for (const client of terminal.clients) { client.write(frame); client.close(); }
    terminal.done?.();
  }
  kill(terminal, reason = 'closed') {
    if (terminal.exit) return Promise.resolve();
    terminal.reason ??= reason;
    const done = terminal.closing ??= new Promise(resolve => { terminal.done = resolve; });
    terminal.signal?.('SIGHUP');
    clearTimeout(terminal.forceKill); terminal.forceKill = setTimeout(() => { terminal.signal?.('SIGKILL'); setTimeout(() => this.exited(terminal, { code: null, signal: 'SIGKILL' }), 500).unref?.(); }, 1500); terminal.forceKill.unref?.();
    return done;
  }
  async remove(id) { const terminal = this.get(id); await this.kill(terminal, 'closed'); this.terminals.delete(id); return { id, closed: true, exit: terminal.exit }; }
  input(id, value) {
    const terminal = this.get(id);
    if (terminal.exit) throw fail('终端已退出。', 'TERMINAL_EXITED', 409);
    if (!this.allowed(terminal)) { this.kill(terminal, 'permission'); throw fail('项目权限已改变，终端已关闭。', 'TERMINAL_PERMISSION_DENIED', 403); }
    if (!value || typeof value.b64 !== 'string' || Object.keys(value).length !== 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.b64)) throw fail('输入必须为 {b64}。', 'TERMINAL_INPUT_INVALID');
    const bytes = Buffer.from(value.b64, 'base64');
    if (bytes.length > 64 * 1024) throw fail('单次输入过大。', 'TERMINAL_INPUT_TOO_LARGE', 413);
    const now = Date.now(); if (now - terminal.input.at >= 1000) terminal.input = { at: now, bytes: 0 };
    if (terminal.input.bytes + bytes.length > this.inputBytesPerSecond) throw fail('输入过快，请稍后重试。', 'TERMINAL_RATE_LIMITED', 429);
    terminal.input.bytes += bytes.length; terminal.lastActivity = now;
    if (bytes.length) terminal.write(bytes);
    return { id, accepted: bytes.length };
  }
  resize(id, input) {
    const terminal = this.get(id);
    if (!input || Object.keys(input).some(key => !['cols', 'rows'].includes(key))) throw fail('尺寸参数无效。', 'TERMINAL_SIZE_INVALID');
    const { cols, rows } = this.size(input);
    if (terminal.exit) return { id, resized: false, cols: terminal.cols, rows: terminal.rows };
    let resized = false; try { resized = terminal.resize(cols, rows); } catch {}
    if (resized) Object.assign(terminal, { cols, rows });
    return { id, resized, cols: terminal.cols, rows: terminal.rows };
  }
  // SSE: hello, data {seq,b64} (id = seq), exit {code,signal}; Last-Event-ID replays the ring buffer.
  stream(id, req, res, url) {
    const terminal = this.get(id);
    if (!terminal.exit && !this.allowed(terminal)) { this.kill(terminal, 'permission'); throw fail('项目权限已改变，终端已关闭。', 'TERMINAL_PERMISSION_DENIED', 403); }
    if (terminal.clients.size >= this.maxClients || this.streams >= this.maxStreams) throw fail('终端订阅过多。', 'TERMINAL_STREAMS_LIMIT', 429);
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
    const lastId = raw === undefined || raw === null || raw === '' ? null : /^\d{1,17}$/u.test(String(raw)) ? Number(raw) : NaN;
    res.writeHead(200, { ...this.headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { write: text => { if (res.destroyed || res.writableEnded) return; if (res.writableLength > this.bufferBytes) { res.end(); return; } res.write(text); }, close: () => { if (!res.writableEnded) res.end(); } };
    const oldest = terminal.chunks[0]?.seq ?? terminal.seq + 1;
    const replay = lastId === null ? 'full' : Number.isSafeInteger(lastId) && lastId >= oldest - 1 && lastId <= terminal.seq ? 'partial' : 'reset';
    client.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ ...this.view(terminal), oldestSeq: terminal.chunks[0]?.seq ?? null, replay })}\n\n`);
    for (const chunk of terminal.chunks) if (replay !== 'partial' || chunk.seq > lastId) client.write(`id: ${chunk.seq}\nevent: data\ndata: ${JSON.stringify({ seq: chunk.seq, b64: chunk.bytes.toString('base64') })}\n\n`);
    if (terminal.exit) { client.write(`event: exit\ndata: ${JSON.stringify({ id: terminal.id, ...terminal.exit })}\n\n`); client.close(); return; }
    terminal.clients.add(client); this.streams++; terminal.lastActivity = Date.now();
    const heartbeat = setInterval(() => client.write(': hb\n\n'), this.heartbeatMs); heartbeat.unref?.();
    res.on('close', () => { clearInterval(heartbeat); if (terminal.clients.delete(client)) this.streams--; terminal.lastActivity = Date.now(); });
  }
  sweep(now = Date.now()) {
    for (const terminal of this.terminals.values()) {
      if (terminal.exit) { if (!terminal.clients.size && now - terminal.exitedAt > this.exitedRetentionMs) this.terminals.delete(terminal.id); continue; }
      if (!this.allowed(terminal)) this.kill(terminal, 'permission');
      else if (!terminal.clients.size && now - terminal.lastActivity > this.idleMs) this.kill(terminal, 'idle');
    }
  }
  async close() {
    this.closed = true; this.unsubscribe?.(); clearInterval(this.sweeper);
    await Promise.all([...this.terminals.values()].map(terminal => this.kill(terminal, 'daemon_stopped')));
    for (const terminal of this.terminals.values()) for (const client of terminal.clients) client.close();
  }
}

export function createTerminalRoutes({ terminals, body }) {
  return async function route(req, res, { pathname, url, send }) {
    if (!pathname.startsWith('/api/v2/')) return false;
    const project = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/terminals$/u);
    if (project && req.method === 'GET') { send(200, terminals.list(project[1])); return true; }
    if (project && req.method === 'POST') { send(201, await terminals.create(project[1], await body(req))); return true; }
    const one = pathname.match(/^\/api\/v2\/terminals\/([a-f0-9-]{36})(?:\/(stream|input|resize))?$/u);
    if (!one) return false;
    const [, id, action] = one;
    if (action === 'stream' && req.method === 'GET') { terminals.stream(id, req, res, url); return true; }
    if (action === 'input' && req.method === 'POST') { send(200, terminals.input(id, await body(req, 128 * 1024))); return true; }
    if (action === 'resize' && req.method === 'POST') { send(200, terminals.resize(id, await body(req))); return true; }
    if (!action && req.method === 'GET') { send(200, terminals.view(terminals.get(id))); return true; }
    if (!action && req.method === 'DELETE') { send(200, await terminals.remove(id)); return true; }
    return false;
  };
}
