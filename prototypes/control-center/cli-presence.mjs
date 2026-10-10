/** Cooperative TTY presence. The server receipt is an atomic compare-and-swap
 * token; an idle CLI never claims another visible client's project session.
 */
export function createCliPresence({ projectId, sessionId, input = process.stdin, output = process.stdout, base, api, now = Date.now, typingTtlMs = 2600, heartbeatMs = 1000, requestTimeoutMs = 800, timers = {}, onIdle = () => {}, onError = () => {} } = {}) {
  const enabled = Boolean(input?.isTTY && output?.isTTY && projectId && sessionId);
  const interval = timers.setInterval ?? setInterval, clearEvery = timers.clearInterval ?? clearInterval, timeout = timers.setTimeout ?? setTimeout, clearAfter = timers.clearTimeout ?? clearTimeout;
  const requestApi = api ?? (async (path, method, data, { signal }) => {
    const response = await fetch(`${base}${path}`, { method, signal, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error ?? 'Presence request failed'), { status: response.status }); return result;
  });
  let closed = false, lastTypedAt = null, submitting = false, ownedReceipt = null, lastTypingSent = null, lastTypingState = false, deferWhileTyping = true, clock, active, requested = false, closing;
  const typing = () => enabled && !closed && lastTypedAt !== null && (submitting || now() - lastTypedAt < typingTtlMs);
  const deferOutput = () => typing() && deferWhileTyping;
  const notifyIdle = () => { const current = deferOutput(); if (lastTypingState && !current) { try { onIdle(); } catch {} } lastTypingState = current; };
  async function request(path, method = 'GET', data) {
    const controller = new AbortController(); let expired;
    const cancelled = new Promise((_resolve, reject) => { expired = timeout(() => { controller.abort(); reject(new Error('Presence request timed out')); }, requestTimeoutMs); expired?.unref?.(); });
    try { return await Promise.race([requestApi(path, method, data, { signal: controller.signal }), cancelled]); }
    finally { clearAfter(expired); }
  }
  const endpoint = `/projects/${encodeURIComponent(projectId)}/presence`;
  async function update() {
    notifyIdle();
    if (closed || lastTypedAt === null || (!typing() && lastTypingSent === false)) return;
    // The project's own route (presence, initiative, archivedAt), never every project's whole record.
    let project;
    try { project = await request(`/v2/projects/${encodeURIComponent(projectId)}`); } catch (error) { if (error.status === 404) return; throw error; }
    if (closed || !project || project.archivedAt) return;
    deferWhileTyping = project.initiative?.deferWhileTyping !== false; notifyIdle();
    const raw = project.presence, current = raw && Date.parse(raw.expiresAt) > now() ? raw : null;
    // A receipt from another writer, even in the same conversation, is not ours.
    if (current?.visible && current.receiptId !== ownedReceipt) { ownedReceipt = null; return; }
    const state = typing();
    const saved = await request(endpoint, 'POST', { sessionId, typing: state, visible: true, expectedReceiptId: current?.receiptId ?? null });
    ownedReceipt = saved.receiptId; lastTypingSent = state;
  }
  function schedule() {
    if (!enabled || closed) return;
    requested = true;
    if (!active) active = (async () => {
      while (requested && !closed) {
        requested = false;
        try { await update(); } catch (error) { if (error.status !== 409) { try { onError(error); } catch {} } }
      }
    })().finally(() => { active = null; if (requested && !closed) schedule(); });
  }
  function typed() {
    if (!enabled || closed) return;
    lastTypedAt = now(); lastTypingState = deferOutput();
    if (!clock) { clock = interval(schedule, heartbeatMs); clock?.unref?.(); }
    schedule();
  }
  const keypress = (_text, key) => { if (['return', 'enter'].includes(key?.name) || key?.ctrl && ['c', 'd'].includes(key.name)) return; typed(); };
  if (enabled) input.on('keypress', keypress);
  return {
    enabled, typing, deferOutput,
    submitting(value) { submitting = value; if (!value) lastTypedAt = lastTypedAt === null ? null : -Infinity; schedule(); notifyIdle(); },
    async flush() { while (active) await active; },
    close() {
      if (closing) return closing;
      closed = true; requested = false; if (clock) clearEvery(clock); if (enabled) input.removeListener('keypress', keypress);
      closing = (async () => {
        await active;
        // A lost/expired receipt must never clear a newer Web or CLI presence.
        if (ownedReceipt) try { await request(endpoint, 'POST', { sessionId, typing: false, visible: false, expectedReceiptId: ownedReceipt }); } catch (error) { if (error.status !== 409) { try { onError(error); } catch {} } }
        ownedReceipt = null;
      })();
      return closing;
    }
  };
}
