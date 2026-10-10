// Native notifications for proactive deliveries (P3). The service emits a
// `notify` stream event only for projects whose user turned on desktop
// notifications, so this bridge stays inert otherwise. It subscribes from the
// main process, so a closed window still receives them.
const RETRY_MS = 5000;

/** Incremental SSE parser: returns complete events and the unparsed rest. */
function parseEvents(buffer) {
  const events = [], blocks = buffer.split(/\r?\n\r?\n/), rest = blocks.pop();
  for (const block of blocks) {
    const event = { event: 'message', data: '' }, data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const index = line.indexOf(':'), field = index < 0 ? line : line.slice(0, index), value = index < 0 ? '' : line.slice(index + 1).replace(/^ /, '');
      if (field === 'event') event.event = value; else if (field === 'data') data.push(value); else if (field === 'id') event.id = value;
    }
    event.data = data.join('\n');
    if (data.length || event.id) events.push(event);
  }
  return { events, rest };
}

/** `onEvent` sees every stream event (the desktop follows the interface language with it) and keeps the stream open
 * where native notifications are unsupported; without it an unsupported platform opens nothing. */
function installNotifications({ Notification, origin, fetch: request = globalThis.fetch, onOpen = () => {}, onEvent, retryMs = RETRY_MS, wait = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()) }) {
  const supported = Boolean(Notification) && !(typeof Notification.isSupported === 'function' && !Notification.isSupported());
  if (!supported && !onEvent) return () => {};
  let stopped = false, controller, lastId;
  const show = event => {
    if (event.id) lastId = event.id;
    try { onEvent?.(event); } catch { /* a watcher never stops notifications */ }
    if (!supported || event.event !== 'notify') return;
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data.projectId !== 'string') return;
    const notification = new Notification({ title: String(data.title || 'Rna Agent').slice(0, 120), body: String(data.body ?? '').slice(0, 300) });
    notification.on?.('click', () => onOpen({ projectId: data.projectId, entryId: data.entryId ?? null, sessionId: data.sessionId ?? null }));
    notification.show();
  };
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await request(`${origin}/api/v2/stream`, { headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('stream unavailable');
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const parsed = parseEvents(buffer); buffer = parsed.rest;
          for (const event of parsed.events) show(event);
        }
      } catch { /* reconnect below */ }
      if (!stopped) await wait(retryMs);
    }
  };
  const running = run();
  const stop = () => { stopped = true; controller?.abort(); return running; };
  return stop;
}

module.exports = { installNotifications, parseEvents };
