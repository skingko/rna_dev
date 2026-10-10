// D4 scenario harness: the clients a scenario watches the host through.
//  - `openSse`: a raw SSE reader that keeps every frame in arrival order (comments included), with its byte size.
//  - `openBrowser`: the web client's loading rules (web/src/store/sync.ts), so a gate can count the GETs a real tab
//    would make: bootstrap first, then the index stream; `hello` with a newer revision or any index `resync` reloads
//    the bootstrap through one 50 ms coalescing timer (sync.ts reloadIndex, :146-152, :168-170); a session stream's
//    `resync` naming projects/sessions reloads the index, one naming only items refetches them, any other reloads the
//    session snapshot, which is the tail window, reaching back to the first item the tab holds (sync.ts snapshot/flush;
//    B9). If sync.ts changes these rules, change them here.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * An HTTP proxy in front of the host that counts the response bytes, for a client the test cannot instrument (the
 * CLI in its own process): point the client at `port`. The host only answers its own Host header, so the proxy
 * rewrites it. `down()` is every body byte the host sent through it; `requests` lists the paths asked.
 */
export async function countingProxy(targetPort) {
  let down = 0;
  const requests = [], open = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, at: performance.now() });
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.on('data', chunk => { down += chunk.length; res.write(chunk); });
      response.on('end', () => res.end());
    });
    open.add(upstream); upstream.on('close', () => open.delete(upstream));
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, down: () => down, requests,
    close: () => new Promise(done => { for (const request of open) request.destroy(); server.closeAllConnections(); server.close(done); }) };
}

/** Opens an SSE stream on the host; resolves once the response headers arrived. Each frame names its `stream` (the path). */
export function openSse(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', ...headers } }, response => {
      const frames = [], listeners = new Set();
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        for (let index; (index = buffer.indexOf('\n\n')) >= 0;) {
          const raw = buffer.slice(0, index), lines = raw.split('\n'); buffer = buffer.slice(index + 2);
          if (lines.every(line => line.startsWith(':'))) { frames.push({ comment: raw, stream: path, at: performance.now() }); continue; }
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { unparsed: data.slice(0, 200) }; }
          const frame = { id: lines.find(line => line.startsWith('id: '))?.slice(4) ?? null, event: lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message', bytes: Buffer.byteLength(data), data: parsed, stream: path, at: performance.now() };
          frames.push(frame);
          for (const listener of listeners) listener(frame);
        }
      });
      const closed = new Promise(done => response.on('close', done));
      resolve({ status: response.statusCode, frames, closed, onFrame: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        of: (...events) => frames.filter(frame => events.includes(frame.event)), since: mark => frames.slice(mark), close: () => request.destroy() });
    });
    request.on('error', reject);
  });
}

/** GET with byte count and wall time. */
export async function getJson(port, path) {
  const started = performance.now(), response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), ms: performance.now() - started, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/**
 * A browser tab following sync.ts. `gets` lists every GET it made ({ kind: bootstrap|session|item, bytes, at });
 * `bootstrapGets()` counts index reloads. Close it when done.
 */
export async function openBrowser(port, { sessionId = null } = {}) {
  const tab = { gets: [], revision: -1, closed: false, streams: [] };
  let reloadTimer = null;
  const get = async (kind, path) => { const result = await getJson(port, path); tab.gets.push({ kind, path, bytes: result.bytes, status: result.status, at: performance.now() }); return result; };
  const loadBootstrap = async () => { const { body } = await get('bootstrap', '/api/v2/bootstrap'); if (body?.revision !== undefined) tab.revision = Math.max(tab.revision, body.revision); return body; };
  const reloadIndex = () => { if (tab.closed) return; reloadTimer ??= setTimeout(() => { reloadTimer = null; if (!tab.closed) void loadBootstrap().catch(() => {}); }, 50); };
  await loadBootstrap();
  const index = await openSse(port, '/api/v2/stream'); tab.streams.push(index); tab.index = index;
  index.onFrame(frame => {
    if (frame.event === 'hello') { if (frame.data?.revision > tab.revision) reloadIndex(); return; }
    if (frame.event === 'index') { if (typeof frame.data?.revision === 'number') tab.revision = Math.max(tab.revision, frame.data.revision); return; }
    if (frame.event === 'resync') reloadIndex();
  });
  if (sessionId) {
    const session = await openSse(port, `/api/v2/stream?session=${encodeURIComponent(sessionId)}`); tab.streams.push(session); tab.session = session;
    // A re-read keeps what the tab holds: the window from its first item (sync.ts snapshot `from`).
    let firstHeld = (await get('session', `/api/v2/sessions/${sessionId}?window=tail`)).body?.items?.[0]?.id ?? null;
    session.onFrame(frame => {
      if (frame.event !== 'resync') return;
      const d = frame.data ?? {};
      if (d.projectIds?.length || d.sessionIds?.length) reloadIndex();
      if (d.itemIds?.length && !d.turnIds?.length && !d.fields?.length) for (const id of d.itemIds) void get('item', `/api/v2/sessions/${sessionId}/items/${id}`).catch(() => {});
      else if (!d.projectIds?.length && !d.sessionIds?.length) void get('session', `/api/v2/sessions/${sessionId}?window=tail${firstHeld ? `&from=${encodeURIComponent(firstHeld)}` : ''}`).then(result => { firstHeld = result.body?.items?.[0]?.id ?? firstHeld; }, () => {});
    });
  }
  tab.bootstrapGets = (since = 0) => tab.gets.filter(row => row.kind === 'bootstrap' && row.at >= since).length;
  tab.close = () => { tab.closed = true; clearTimeout(reloadTimer); for (const stream of tab.streams) stream.close(); };
  return tab;
}
