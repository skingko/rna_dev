import { createServer } from 'node:net';

/**
 * The agent's browser, live in the side panel (zcode shows its agent driving
 * the in-app browser). Here Playwright MCP keeps its own isolated headless
 * Chrome; the host opens a loopback DevTools port on it (a launch argument)
 * and mirrors the page the agent is using with CDP screencast frames.
 *
 * One view per conversation, surviving browser restarts: `attach(port)` when a
 * browser session starts, `detach()` when it ends (the last frame stays).
 * Frames are captured only while someone watches or a browser tool runs.
 */
export async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.unref(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const LINGER_MS = 2500, CONNECT_ATTEMPTS = 24, CONNECT_DELAY_MS = 250;
const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export class BrowserLiveView {
  constructor({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now, fps = 6 } = {}) {
    this.fetchImpl = fetchImpl; this.WebSocketImpl = WebSocketImpl; this.now = now; this.frameMs = Math.round(1000 / fps);
    this.listeners = new Set(); this.port = null; this.ws = null; this.connecting = null; this.closed = false;
    this.pages = new Map(); this.activeTarget = null; this.cdpSession = null; this.casting = false;
    this.pending = new Map(); this.nextId = 1; this.action = null; this.last = null; this.queued = null; this.flushTimer = null; this.lingerTimer = null;
  }
  get wanted() { return this.listeners.size > 0 || Boolean(this.action); }
  state() {
    const page = this.pages.get(this.activeTarget);
    return { live: Boolean(this.ws), attached: this.port !== null, url: page?.url ?? this.last?.url ?? '', title: page?.title ?? this.last?.title ?? '', action: this.action };
  }
  emit(event) { for (const listener of this.listeners) try { listener(event); } catch { /* a closed stream */ } }
  emitState() { this.emit({ type: 'state', ...this.state() }); }
  subscribe(listener) {
    this.listeners.add(listener);
    listener({ type: 'state', ...this.state() });
    if (this.last) listener({ type: 'frame', ...this.last });
    this.wake();
    return () => { this.listeners.delete(listener); this.settle(); };
  }
  attach(port) { if (this.closed) return; if (this.port !== port) this.disconnect(); this.port = port; this.emitState(); this.wake(); }
  detach() { this.disconnect(); this.port = null; this.emitState(); }
  /** A browser tool starts: show what it does, and make sure frames flow. */
  begin(action) { this.action = action; clearTimeout(this.lingerTimer); this.emitState(); this.wake(); }
  end() { this.action = null; this.emitState(); this.settle(); }
  close() { this.closed = true; this.disconnect(); this.listeners.clear(); clearTimeout(this.flushTimer); clearTimeout(this.lingerTimer); }

  wake() {
    if (!this.wanted || this.closed || this.port === null) return;
    if (this.ws) { void this.cast(); return; }
    void this.connect();
  }
  /** Keep capturing a moment after the last tool, so the page it left settles into the last frame. */
  settle() {
    if (this.wanted) return;
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => { if (!this.wanted) void this.stopCast(); }, LINGER_MS); this.lingerTimer.unref?.();
  }
  connect() {
    if (this.connecting) return this.connecting;
    const port = this.port;
    this.connecting = (async () => {
      // Playwright starts Chrome on the first browser tool, so the port may not answer yet.
      for (let attempt = 0; attempt < CONNECT_ATTEMPTS && this.wanted && !this.closed && this.port === port && !this.ws; attempt++) {
        try {
          const response = await this.fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
          const { webSocketDebuggerUrl } = await response.json();
          if (typeof webSocketDebuggerUrl !== 'string' || !webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error('unexpected endpoint');
          await this.open(webSocketDebuggerUrl);
          return;
        } catch { await wait(CONNECT_DELAY_MS); }
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  open(url) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      ws.onopen = async () => {
        this.ws = ws; this.emitState();
        try { await this.send('Target.setDiscoverTargets', { discover: true }); resolve(); } catch (error) { reject(error); }
      };
      ws.onerror = () => { if (this.ws !== ws) reject(new Error('connect failed')); };
      ws.onclose = () => { if (this.ws === ws) this.disconnect(); };
      ws.onmessage = event => this.receive(String(event.data));
    });
  }
  disconnect() {
    const ws = this.ws; this.ws = null; this.casting = false; this.cdpSession = null; this.activeTarget = null; this.pages.clear();
    for (const { reject } of this.pending.values()) reject(new Error('disconnected'));
    this.pending.clear();
    if (ws) { try { ws.close(); } catch { /* already closed */ } this.emitState(); }
  }
  send(method, params = {}, sessionId) {
    if (!this.ws) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  receive(text) {
    let message; try { message = JSON.parse(text); } catch { return; }
    if (message.id) { const entry = this.pending.get(message.id); if (!entry) return; this.pending.delete(message.id); if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result); return; }
    const { method, params = {}, sessionId } = message;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') this.page(params.targetInfo, method === 'Target.targetCreated');
    else if (method === 'Target.targetDestroyed') this.gone(params.targetId);
    else if (method === 'Page.screencastFrame' && sessionId === this.cdpSession) {
      void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const page = this.pages.get(this.activeTarget);
      this.frame({ data: params.data, width: params.metadata?.deviceWidth ?? null, height: params.metadata?.deviceHeight ?? null, url: page?.url ?? '', title: page?.title ?? '', at: this.now() });
    }
  }
  /** The page the agent is on: the one it last opened or navigated. */
  page(info, created) {
    if (info?.type !== 'page') return;
    const before = this.pages.get(info.targetId);
    this.pages.set(info.targetId, { url: info.url ?? '', title: info.title ?? '' });
    const moved = created || !before || before.url !== info.url;
    if (moved && info.targetId !== this.activeTarget) { this.release(); this.activeTarget = info.targetId; void this.cast(); }
    else if (info.targetId === this.activeTarget) this.emitState();
  }
  gone(targetId) {
    this.pages.delete(targetId);
    if (targetId !== this.activeTarget) return;
    this.release(); this.activeTarget = [...this.pages.keys()].at(-1) ?? null;
    this.emitState(); void this.cast();
  }
  /** Let go of the page being mirrored (the agent moved to another one). */
  release() {
    const sessionId = this.cdpSession; this.cdpSession = null; this.casting = false;
    if (sessionId && this.ws) void this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  async cast() {
    if (!this.ws || !this.wanted || this.casting || !this.activeTarget) return;
    const target = this.activeTarget; this.casting = true;
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId: target, flatten: true });
      if (this.activeTarget !== target) return;
      this.cdpSession = sessionId;
      await this.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }, sessionId);
      this.emitState();
    } catch { if (this.activeTarget === target) this.casting = false; }
  }
  async stopCast() {
    const sessionId = this.cdpSession; if (!sessionId || !this.ws) return;
    this.casting = false; this.cdpSession = null;
    await this.send('Page.stopScreencast', {}, sessionId).catch(() => {});
    await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  /** At most `fps` frames a second reach the panel; the newest always wins. */
  frame(frame) {
    this.last = frame; this.queued = frame;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; const next = this.queued; this.queued = null; if (next) this.emit({ type: 'frame', ...next }); }, this.frameMs);
    this.flushTimer.unref?.();
  }
}
