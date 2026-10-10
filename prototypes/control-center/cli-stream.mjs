import { setTimeout as sleep } from 'node:timers/promises';
import { SESSION_FIELDS } from './session-schema.mjs';
import { cliError } from './cli-language.mjs';

// The CLI follows a conversation the way the web does (docs/specs/stream-protocol-v2.md §1–2; web/src/store/sync.ts):
// open GET /api/v2/stream?session=<id>, and on its first `hello` read the tail window (GET /api/v2/sessions/:id
// ?window=tail); events that arrive meanwhile are held and replayed, dropping persisted ones the snapshot already
// covers; after that only changed items, turns and fields arrive, plus streaming `delta`s. A dropped connection
// resumes with Last-Event-ID (the host replays its ring buffer or says `resync`). Read-only: reconnecting never
// resubmits a message or replays a tool. Older history is not paged in; `rna history` reads the whole conversation.

/** No v2 event is larger than 64 KB (§2); a frame this long without an end means the stream is not v2. */
export const MAX_FRAME_CHARS = 1024 * 1024;
const PERSISTED = new Set(['items.upsert', 'items.remove', 'turns.upsert', 'session.patch']);

/**
 * The CLI's copy of one conversation: the tail window plus everything the stream changed since. Cards older than the
 * window that still wait for the user (the snapshot's `pinned`) come first, so `chat` and `watch` show them too.
 */
export class SessionView {
  constructor() { this.ready = false; this.meta = {}; this.items = new Map(); this.order = []; this.pinned = new Set(); this.turns = new Map(); this.revision = -1; this.window = null; }
  /** Replaces the copy with a snapshot (GET /api/v2/sessions/:id?window=tail); every item counts as changed. */
  adopt(snapshot, changed) {
    const { items = [], turns = [], revision, window, pinned = [], ...meta } = snapshot;
    const inWindow = new Set(items.map(item => item.id)), older = pinned.filter(item => item?.id && !inWindow.has(item.id));
    this.meta = meta; this.items = new Map([...older, ...items].map(item => [item.id, item])); this.order = [...older, ...items].map(item => item.id);
    this.pinned = new Set(older.map(item => item.id));
    this.turns = new Map(turns.map(turn => [turn.id, turn])); this.revision = revision ?? -1; this.window = window ?? null; this.ready = true;
    for (const id of this.order) changed.add(id);
  }
  /** Older history the copy does not hold: an item the stream names from before the window is not added at the end. */
  outside(item) {
    if (!this.window?.hasMore || this.items.has(item.id)) return false;
    const first = this.items.get(this.order.find(id => !this.pinned.has(id)));
    return Boolean(first?.createdAt && item.createdAt && item.createdAt < first.createdAt);
  }
  upsert(items, changed) {
    for (const item of items) {
      if (!item?.id || this.outside(item)) continue;
      if (!this.items.has(item.id)) this.order.push(item.id);
      this.items.set(item.id, item); changed.add(item.id);
    }
  }
  /** Applies one event. Returns what has to be read again: { items: [ids] } or { snapshot: true }, else null. */
  apply(event, data, changed) {
    if (event === 'items.upsert') { this.upsert(data.items ?? [], changed); this.revision = Math.max(this.revision, data.revision ?? -1); return null; }
    if (event === 'items.remove') {
      for (const id of data.ids ?? []) { if (this.items.delete(id)) changed.add(id); this.pinned.delete(id); }
      this.order = this.order.filter(id => this.items.has(id));
      this.revision = Math.max(this.revision, data.revision ?? -1);
      // A rewind that cut into history this copy never held removed all it held (in one event, or in the last of the
      // 1,000-id chunks a long rewind arrives in): read the tail again.
      return this.window?.hasMore && !this.order.some(id => !this.pinned.has(id)) ? { snapshot: true } : null;
    }
    if (event === 'turns.upsert') { for (const turn of data.turns ?? []) this.turns.set(turn.id, turn); this.revision = Math.max(this.revision, data.revision ?? -1); return null; }
    if (event === 'session.patch') { for (const [key, value] of Object.entries(data.fields ?? {})) this.meta[key] = value; this.revision = Math.max(this.revision, data.revision ?? -1); return null; }
    if (event === 'delta') return this.delta(data, changed);
    if (event === 'resync') {
      if (data?.itemIds?.length && !data.turnIds?.length && !data.fields?.length) return { items: data.itemIds };
      return data?.projectIds?.length || data?.sessionIds?.length ? null : { snapshot: true };
    }
    return null;
  }
  /** A streaming append, checked by offset (§2): duplicates are skipped, a gap re-reads the item. */
  delta(data, changed) {
    const block = data.block;
    if (!['text', 'thinking', 'tool_output'].includes(block)) return null; // pending tool arguments are display-only
    let item = this.items.get(data.itemId);
    if (!item) {
      if (data.offset !== 0) return { items: [data.itemId] };
      item = { id: data.itemId, turnId: data.turnId ?? null, kind: block === 'tool_output' ? 'tool' : 'assistant', text: '', streaming: true, createdAt: new Date().toISOString(), ...(block === 'tool_output' ? { tool: { name: 'tool', status: 'running' } } : {}) };
      this.order.push(item.id);
    }
    const current = block === 'text' ? item.text ?? '' : block === 'thinking' ? item.thinking?.text ?? '' : item.tool?.output ?? '';
    if (data.offset > current.length) return { items: [data.itemId] };
    const tail = data.append.slice(current.length - data.offset);
    if (!tail && this.items.has(item.id)) return null;
    const text = current + tail;
    item = block === 'text' ? { ...item, text, streaming: true } : block === 'thinking' ? { ...item, streaming: true, thinking: { ...item.thinking, text } } : { ...item, tool: { ...item.tool, output: text } };
    this.items.set(item.id, item); changed.add(item.id);
    return null;
  }
  /** The conversation as a session object: the record, the held items in order, the turns. */
  session() { return { ...this.meta, items: this.order.map(id => this.items.get(id)), turns: [...this.turns.values()], revision: this.revision, window: this.window }; }
}

/** The record fields of a session a write route answered with, for `chat` to show its state before the stream says so. */
export const sessionRecord = session => Object.fromEntries(SESSION_FIELDS.filter(key => session && Object.hasOwn(session, key)).map(key => [key, session[key]]));

function frames(buffer) {
  const out = []; let boundary;
  while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
    const match = buffer.slice(boundary).match(/^\r?\n\r?\n/), raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + match[0].length);
    const lines = raw.split(/\r?\n/);
    if (lines.every(line => !line || line.startsWith(':'))) continue;
    const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim(), event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    out.push({ id: id || null, event, data });
  }
  return { frames: out, rest: buffer };
}

/**
 * Follows one conversation over the v2 stream. `onUpdate(session, changedItemIds, { maintenance })` runs after each
 * batch of changes (the first time with the tail window, every item changed) and when the maintenance gate changes
 * (`hello` carries it, `index` events its changes; null from a daemon that sends neither); returning false stops
 * following, throwing stops it with that error. Resolves when stopped or aborted; rejects on a fatal error (unknown
 * conversation, a non-v2 stream).
 */
export async function followSession({ base, sessionId, onUpdate, signal, request = fetch, wait = sleep, baseDelayMs = 300, maxDelayMs = 10000, onConnection = () => {} }) {
  const view = new SessionView(), path = encodeURIComponent(sessionId), changed = new Set();
  let lastId = null, failures = 0, reconnecting = false, stopped = false, failure = null, reader = null, dropped = null;
  // The maintenance gate (the old whole-state stream put it on every `state` line): from `hello`, then `index` events.
  let maintenance = null, maintenanceJson = 'null', maintenanceChanged = false;
  const noteMaintenance = data => {
    if (!data || !Object.hasOwn(data, 'maintenance')) return;
    const json = JSON.stringify(data.maintenance ?? null);
    if (json !== maintenanceJson) { maintenanceJson = json; maintenance = data.maintenance ?? null; maintenanceChanged = true; }
  };
  const stop = error => { if (error && !failure) failure = error; stopped = true; reader?.cancel().catch(() => {}); };
  // A failed read that is not fatal drops the connection; the loop below reconnects with backoff.
  const drop = error => { dropped ??= error; reader?.cancel().catch(() => {}); };
  // `force`: a snapshot was adopted (a conversation without items still has to be shown).
  const notify = (force = false) => {
    if (stopped || !view.ready || !changed.size && !force && !maintenanceChanged) return;
    const ids = [...changed]; changed.clear(); maintenanceChanged = false;
    try { if (onUpdate(view.session(), ids, { maintenance }) === false) stop(); } catch (error) { stop(error); }
  };
  const get = async route => {
    const response = await request(`${base}${route}`, { signal, headers: { Accept: 'application/json' } });
    let body = null; try { body = await response.json(); } catch { /* reported below */ }
    if (!response.ok || !body) throw Object.assign(body?.error != null ? new Error(body.error) : cliError(`会话读取失败（HTTP ${response.status}）`, `Failed to read the session (HTTP ${response.status})`), { fatal: response.status === 404 });
    return body;
  };
  const failed = error => { if (signal?.aborted || stopped) return; if (error.fatal) stop(error); else drop(error); };
  // Reads the stream asked for stay owed until they succeed: a failed one drops the connection, and the resumed stream
  // does not ask again (its resync was already delivered), so the next `hello` runs them again.
  const owedItems = new Set();
  let owedSnapshot = false;
  const refetch = ids => {
    for (const id of new Set(ids)) {
      owedItems.add(id);
      void get(`/api/v2/sessions/${path}/items/${encodeURIComponent(id)}`).then(body => { owedItems.delete(id); view.upsert([body.item], changed); notify(); },
        // An item that is gone (404) was removed; the stream says so on its own.
        error => { if (error.fatal) owedItems.delete(id); else failed(error); });
    }
  };
  // Snapshot + held events (sync.ts snapshot()): events arriving while it loads wait, then replay unless covered. If
  // it fails, they wait for the retry (the resumed stream does not send them again).
  let held = null, unreplayed = [];
  const snapshot = () => {
    owedSnapshot = true;
    if (held) return;
    held = unreplayed; unreplayed = [];
    void get(`/api/v2/sessions/${path}?window=tail`).then(body => {
      const replay = held.filter(frame => !(PERSISTED.has(frame.event) && typeof frame.data?.revision === 'number' && frame.data.revision <= (body.revision ?? -1)));
      held = null; owedSnapshot = false; owedItems.clear(); view.adopt(body, changed);
      for (const frame of replay) handle(frame);
      notify(true);
    }, error => { unreplayed = held; held = null; failed(error); });
  };
  function handle(frame) {
    if (held) { held.push(frame); return; }
    if (!view.ready) { unreplayed.push(frame); return; }
    const directive = view.apply(frame.event, frame.data, changed);
    if (directive?.snapshot) snapshot();
    else if (directive?.items) refetch(directive.items);
  }
  while (!stopped && !signal?.aborted) {
    try {
      const response = await request(`${base}/api/v2/stream?session=${path}`, { signal, headers: { Accept: 'text/event-stream', ...(lastId !== null ? { 'Last-Event-ID': lastId } : {}) } });
      if (!response.ok) { let detail; try { detail = await response.json(); } catch {} const error = detail?.error != null ? new Error(detail.error) : cliError(`事件流请求失败（HTTP ${response.status}）`, `The event stream request failed (HTTP ${response.status})`); error.fatal = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status); throw error; }
      reader = response.body.getReader(); dropped = null;
      const decoder = new TextDecoder(); let buffer = '';
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) { if (stopped) break; throw dropped ?? cliError('事件流连接已中断', 'The event stream connection was interrupted'); }
        const parsed = frames(buffer + decoder.decode(chunk.value, { stream: true })); buffer = parsed.rest;
        for (const raw of parsed.frames) {
          if (raw.id !== null) lastId = raw.id;
          let data = null;
          if (raw.data) { try { data = JSON.parse(raw.data); } catch { throw cliError('事件流数据不完整，正在重新连接', 'The event stream data is incomplete; reconnecting'); } }
          if (raw.event === 'hello') {
            failures = 0;
            // The channel's position when this client joined: a drop before any event with an id resumes from here.
            if (lastId === null && Number.isSafeInteger(data?.seq)) lastId = String(data.seq);
            noteMaintenance(data);
            if (reconnecting) { reconnecting = false; onConnection({ state: 'connected' }); }
            // First connection: take the snapshot. A resumed one continues from Last-Event-ID, after running the reads
            // a dropped connection left owed.
            if (!view.ready || owedSnapshot) snapshot();
            else if (owedItems.size) refetch([...owedItems]);
            continue;
          }
          // Index rows are other conversations' and projects'; only the maintenance gate is read from them.
          if (raw.event === 'index') { noteMaintenance(data); continue; }
          handle({ event: raw.event, data });
        }
        notify();
        if (buffer.length > MAX_FRAME_CHARS) throw Object.assign(cliError('事件流帧过大，已停止客户端接收', 'An event stream frame is too large; the client stopped receiving'), { fatal: true });
      }
    } catch (error) {
      if (signal?.aborted || stopped) break;
      if (error.fatal) { stop(error); break; }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(failures++, 12));
      reconnecting = true; onConnection({ state: 'reconnecting', delayMs, error: error.message });
      try { await wait(delayMs, undefined, { signal }); } catch (abort) { if (signal?.aborted) break; throw abort; }
    } finally { const current = reader; reader = null; await current?.cancel().catch(() => {}); }
  }
  if (failure) throw failure;
}
