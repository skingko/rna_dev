import { createHash } from 'node:crypto';
import { McpClient } from '../../packages/sdk/src/mcp.mjs';

// MCP connections that live with a conversation instead of a turn (after zcode
// and Claude Code, where MCP servers stay up for the whole session). A turn's
// registry leases the conversation's connection: the stdio process or HTTP
// session is started once, reused by the next turns, and closed after it has
// been idle for a while or when its configuration changes. Keyed by project,
// conversation and the server's connection settings, so conversations never
// share server state. Only conversations the user talks in are pooled (a background
// action or a delegated child runs once). Browser servers keep their own pool.
export const MCP_IDLE_MS = 10 * 60000, MCP_MAX_CLIENTS = 24;
/** An idle connection must not keep the host process alive; a leased one must. */
function hold(client, held) {
  const proc = client?.process; if (!proc) return;
  for (const handle of [proc, proc.stdin, proc.stdout, proc.stderr]) { try { held ? handle?.ref?.() : handle?.unref?.(); } catch { /* already gone */ } }
}
const CONNECTION_FIELDS = ['id', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'timeoutMs'];
export const mcpFingerprint = server => createHash('sha256').update(JSON.stringify(CONNECTION_FIELDS.map(field => server?.[field] ?? null))).digest('hex').slice(0, 24);

export class McpSessionPool {
  constructor({ idleTimeoutMs = MCP_IDLE_MS, maxClients = MCP_MAX_CLIENTS, clientFactory = config => new McpClient(config), now = Date.now } = {}) {
    Object.assign(this, { idleTimeoutMs, maxClients, clientFactory, now });
    this.entries = new Map(); this.closed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(60000, Math.max(25, idleTimeoutMs))); this.timer.unref?.();
  }
  key(server, { projectId, sessionId }) { return `${projectId}\u0000${sessionId}\u0000${mcpFingerprint(server)}`; }
  /** A lease on the conversation's connection; the registry treats it as its own client (close = give it back). */
  acquire(server, { projectId, sessionId }) {
    if (this.closed) throw Object.assign(new Error('MCP connections are closed'), { code: 'registry_closed' });
    const key = this.key(server, { projectId, sessionId });
    let entry = this.entries.get(key);
    if (entry && (entry.client.closed || entry.failed)) { this.retire(entry); entry = null; }
    if (!entry) {
      if (this.entries.size >= this.maxClients) { const oldest = [...this.entries.values()].filter(row => !row.leases).sort((a, b) => a.lastUsed - b.lastUsed)[0]; if (oldest) this.retire(oldest); }
      entry = { key, projectId, sessionId, serverId: server.id, client: this.clientFactory(server), connecting: null, leases: 0, lastUsed: this.now(), failed: false };
      this.entries.set(key, entry);
    }
    entry.leases++; entry.lastUsed = this.now(); hold(entry.client, true);
    const pool = this; let released = false;
    const live = () => { if (released || entry.client.closed) throw Object.assign(new Error('MCP lease ended'), { code: 'transport_closed' }); };
    return {
      get ready() { return !released && !entry.failed && entry.client.ready && !entry.client.closed; },
      get closed() { return released || entry.client.closed; },
      async connect({ signal } = {}) {
        live();
        if (entry.client.ready) return this;
        // One start per conversation; a caller's cancellation stops its wait, not a start others share.
        entry.connecting ??= entry.client.connect().then(() => { entry.connecting = null; if (!entry.leases) hold(entry.client, false); }, error => { entry.connecting = null; entry.failed = true; throw error; });
        await (signal ? Promise.race([entry.connecting, new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })]) : entry.connecting);
        live(); return this;
      },
      async listTools(options) { live(); return entry.client.listTools(options); },
      async callTool(name, args, options) { live(); entry.lastUsed = pool.now(); try { return await entry.client.callTool(name, args, options); } catch (error) { if (!entry.client.ready) entry.failed = true; throw error; } },
      async close() {
        if (released) return; released = true; entry.leases--; entry.lastUsed = pool.now();
        if (entry.failed || !entry.client.ready || pool.closed) await pool.retire(entry);
        else if (!entry.leases) hold(entry.client, false);
      },
    };
  }
  /** Start the conversation's connection ahead of its next turn (the user is typing). */
  async warm(server, scope) {
    const lease = this.acquire(server, scope);
    try { await lease.connect(); return true; } catch { return false; } finally { await lease.close(); }
  }
  async retire(entry) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    await entry.client.close?.();
  }
  /** Close connections idle past the limit, or whose server settings are no longer configured. */
  sweep(current = null) {
    for (const entry of [...this.entries.values()]) {
      if (entry.leases) continue;
      const stale = current && !current.has(entry.key.split('\u0000')[2]);
      if (stale || this.now() - entry.lastUsed >= this.idleTimeoutMs) void this.retire(entry).catch(() => {});
    }
  }
  /** Close one conversation's connections (it was deleted or archived). */
  async drainSession(sessionId) { await Promise.allSettled([...this.entries.values()].filter(row => row.sessionId === sessionId).map(row => this.retire(row))); }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.entries.values()].map(row => this.retire(row))); }
}
