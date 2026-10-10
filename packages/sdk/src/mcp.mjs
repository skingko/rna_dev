import { SDK_VERSION } from './version.mjs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export class McpError extends Error { constructor(message, code = 'mcp_error') { super(message); this.name = 'McpError'; this.code = code; } }
const MAX_BYTES = 4 * 1024 * 1024;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
function abortError() { return new DOMException('MCP request cancelled', 'AbortError'); }
function safeEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new McpError('Invalid MCP endpoint', 'invalid_config'); }
  if (url.username || url.password || url.hash) throw new McpError('MCP endpoint must not contain credentials or a fragment', 'invalid_config');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new McpError('Remote MCP endpoints require HTTPS', 'invalid_config');
  return url.href;
}
export class McpClient {
  constructor(config) {
    if (config?.enabled !== true || config?.trusted !== true) throw new McpError('MCP server must be explicitly enabled and trusted', 'not_authorized');
    if (!['stdio', 'http'].includes(config.transport)) throw new McpError('Unknown MCP transport', 'invalid_config');
    this.config = { ...config }; this.lifetime = new AbortController(); this.notifications = new Set(); this.pending = new Map(); this.nextId = 1; this.closed = false; this.ready = false;
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(50, Math.min(config.timeoutMs, 300000)) : 30000;
    this.protocolVersion = '2025-03-26'; this.sessionId = undefined;
    if (config.transport === 'http') this.endpoint = safeEndpoint(config.url);
  }
  async connect({ signal } = {}) {
    if (this.closed) throw new McpError('MCP client is closed');
    if (this.ready) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect(signal).catch(async error => { await this.close(); throw error; });
    return this.connecting;
  }
  async _connect(signal) {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    if (this.config.transport === 'stdio') {
      if (typeof this.config.command !== 'string' || !this.config.command.trim() || !Array.isArray(this.config.args || []) || !(this.config.args || []).every(arg => typeof arg === 'string')) throw new McpError('MCP stdio requires a command and string args', 'invalid_config');
      // No shell interpolation. Only the configured process and explicit environment are used.
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...this.config.env };
      this.process = spawn(process.execPath, [fileURLToPath(new URL('./mcp-stdio-supervisor.mjs', import.meta.url)), String(process.pid), this.config.command, ...(this.config.args || [])], { cwd: this.config.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const fail = error => { this._fail(error); void this.close(); };
      let buffer = ''; const decoder = new StringDecoder('utf8');
      this.process.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_BYTES) return fail(new McpError('MCP response exceeded size limit', 'response_too_large'));
        let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line) continue; try { this._receive(JSON.parse(line)); } catch { fail(new McpError('MCP server sent invalid JSON', 'invalid_response')); } }
      });
      this.process.stderr.resume(); // Do not expose potentially sensitive server logs to model/UI.
      this.process.stdin.on('error', () => fail(new McpError('MCP process input closed', 'transport_closed')));
      this.process.on('error', () => fail(new McpError('MCP process could not start', 'transport_closed')));
      this.process.on('close', () => fail(new McpError('MCP process exited', 'transport_closed')));
    }
    const result = await this.request('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'rna-agent-sdk', version: SDK_VERSION } }, { signal });
    if (!result || !SUPPORTED_PROTOCOLS.includes(result.protocolVersion) || typeof result.capabilities !== 'object') throw new McpError('MCP server returned unsupported initialization', 'invalid_response');
    if (this.config.transport === 'http' && result.protocolVersion === '2024-11-05') throw new McpError('Legacy HTTP+SSE transport is not supported', 'unsupported_protocol');
    this.protocolVersion = result.protocolVersion; this.serverInfo = result.serverInfo; this.capabilities = result.capabilities;
    await this.notify('notifications/initialized', {}); signal.throwIfAborted(); this.ready = true; return this;
  }
  _receive(message) {
    if (Array.isArray(message)) { for (const item of message) this._receive(item); return; }
    if (!message || message.jsonrpc !== '2.0') throw new McpError('Invalid MCP envelope', 'invalid_response');
    if (message.method) {
      if (message.id !== undefined) { const response = message.method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method not supported' } }; void this._send(response).catch(() => {}); }
      return; // Sampling/elicitation are never implicitly granted to a remote server.
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    if (message.error) pending.reject(new McpError(`MCP request failed (${Number.isInteger(message.error.code) ? message.error.code : 'remote'})`, 'remote_error'));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new McpError('MCP response has no result', 'invalid_response'));
  }
  _fail(error) { for (const pending of [...this.pending.values()]) pending.reject(error); this.ready = false; }
  _headers() {
    const headers = new Headers(this.config.headers || {});
    for (const [key, envName] of Object.entries(this.config.headerEnv || {})) if (process.env[envName]) headers.set(key, process.env[envName]);
    headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json, text/event-stream');
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
    headers.set('MCP-Protocol-Version', this.protocolVersion); return headers;
  }
  async _send(message, signal) {
    if (this.closed) throw new McpError('MCP client is closed', 'transport_closed');
    if (this.config.transport === 'stdio') {
      if (!this.process?.stdin.writable) throw new McpError('MCP process input is unavailable', 'transport_closed');
      await new Promise((resolve, reject) => this.process.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(new McpError('MCP write failed', 'transport_closed')) : resolve())); return;
    }
    let response;
    try { response = await fetch(this.endpoint, { method: 'POST', headers: this._headers(), body: JSON.stringify(message), signal, redirect: 'error' }); }
    catch (error) { if (signal?.aborted) throw abortError(); throw new McpError('MCP HTTP connection failed', 'transport_error'); }
    if (!response.ok) { if (response.status === 404) this.ready = false; await response.body?.cancel(); throw new McpError(`MCP HTTP request failed (${response.status})`, response.status === 404 ? 'session_expired' : 'http_error'); }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId && message.method === 'initialize') { if (!/^[\x21-\x7e]{1,1024}$/.test(sessionId)) throw new McpError('Invalid MCP session id', 'invalid_response'); this.sessionId = sessionId; }
    if (response.status === 202 || response.status === 204) { if (message.id !== undefined && message.method) throw new McpError('MCP request received no response', 'invalid_response'); return; }
    if (!response.body) throw new McpError('Empty MCP response', 'invalid_response');
    let bytes = 0, buffer = ''; const decoder = new TextDecoder(); const isSse = response.headers.get('content-type')?.includes('text/event-stream');
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > MAX_BYTES) throw new McpError('MCP response exceeded size limit', 'response_too_large');
        buffer += decoder.decode(value, { stream: true });
        if (isSse) {
          buffer = buffer.replace(/\r\n/g, '\n'); let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (data) this._receive(JSON.parse(data)); }
          // Cancel this response stream after its matching result; notifications may otherwise keep it open.
          if (message.id !== undefined && !this.pending.has(message.id)) { await reader.cancel(); return; }
        }
      }
      buffer += decoder.decode();
      if (!isSse && buffer.trim()) this._receive(JSON.parse(buffer));
      if (message.id !== undefined && message.method && this.pending.has(message.id)) throw new McpError('MCP stream ended before result', 'invalid_response');
    } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof SyntaxError) throw new McpError('MCP server sent invalid JSON', 'invalid_response'); throw error; }
    finally { reader.releaseLock(); }
  }
  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new McpError('MCP client is closed', 'transport_closed'));
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    if (signal.aborted) return Promise.reject(abortError());
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) return Promise.reject(new McpError('Invalid MCP request timeout', 'invalid_config'));
    const id = this.nextId++, controller = new AbortController();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { if (!this.pending.has(id)) return; this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { controller.abort(); reject(error); } else resolve(value); };
      const cancel = error => { void this.notify('notifications/cancelled', { requestId: id, reason: 'Client cancelled request' }).catch(() => {}); finish(error); };
      const abort = () => cancel(abortError());
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error), controller });
      signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => cancel(new McpError('MCP request timed out', 'timeout')), timeoutMs);
      void this._send({ jsonrpc: '2.0', id, method, params }, controller.signal).catch(error => finish(error));
    });
  }
  async notify(method, params = {}) { const controller = new AbortController(); this.notifications.add(controller); const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000)); try { await this._send({ jsonrpc: '2.0', method, params }, AbortSignal.any([controller.signal, this.lifetime.signal])); } finally { clearTimeout(timer); this.notifications.delete(controller); } }
  async listTools({ signal } = {}) {
    if (!this.ready) throw new McpError('MCP client is not initialized', 'not_ready');
    const tools = [], names = new Set(), cursors = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(result?.tools)) throw new McpError('Invalid MCP tool directory', 'invalid_response');
      for (const tool of result.tools) { if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || !tool.inputSchema) throw new McpError('Invalid or duplicate MCP tool', 'invalid_response'); names.add(tool.name); tools.push(tool); }
      if (tools.length > 10000) throw new McpError('MCP tool directory limit exceeded', 'response_too_large');
      if (!result.nextCursor) return tools;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new McpError('MCP tool cursor repeated', 'invalid_response'); cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new McpError('MCP tool pagination limit exceeded', 'response_too_large');
  }
  async callTool(name, args, { signal } = {}) {
    if (!this.ready) throw new McpError('MCP client is not initialized', 'not_ready');
    const result = await this.request('tools/call', { name, arguments: args }, { signal });
    if (!result || typeof result !== 'object' || !Array.isArray(result.content) || result.isError !== undefined && typeof result.isError !== 'boolean') throw new McpError('Invalid MCP tool result', 'invalid_response');
    return result;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.ready = false;
    this.lifetime.abort(new McpError('MCP client closed', 'transport_closed'));
    for (const controller of this.notifications) controller.abort(); this.notifications.clear();
    this._fail(new McpError('MCP client closed', 'transport_closed'));
    this.closePromise = (async () => {
      const proc = this.process;
      const kill = signal => {
        if (!proc?.pid) return;
        try { if (process.platform !== 'win32') process.kill(-proc.pid, signal); else proc.kill(signal); } catch { try { proc.kill(signal); } catch {} }
      };
      const closeHttp = async () => {
        if (this.config.transport === 'http' && this.sessionId) { try { const response = await fetch(this.endpoint, { method: 'DELETE', headers: this._headers(), redirect: 'error', signal: AbortSignal.timeout(2000) }); await response.body?.cancel(); } catch {} }
      };
      const closeProcess = async () => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.stdin.end(); await new Promise(resolve => {
            let killTimer; const finish = () => { clearTimeout(termTimer); clearTimeout(killTimer); proc.removeListener('exit', finish); resolve(); };
            const termTimer = setTimeout(() => { kill('SIGKILL'); killTimer = setTimeout(finish, 1000); }, 2500);
            proc.once('exit', finish); kill('SIGTERM');
          });
          proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy();
        }
      };
      await Promise.allSettled([closeHttp(), closeProcess()]);
    })();
    return this.closePromise;
  }
}
