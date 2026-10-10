// The initiative tests run no RuntimeController, so a turn started by store.message() would stay running forever. Under
// the foreground lease (PDL-2) a running turn's own message wakes no decision until the turn ends, as a real turn does:
// these helpers post a message and end its turn, the way the conversation would.

/** Posts `text` in the conversation and ends the turn it starts (`status`: completed or failed). Returns the turn id. */
export function sayAndFinish(store, sessionId, text, { status = 'completed', reply = null } = {}) {
  store.message(sessionId, { text });
  return finishActiveTurn(store, sessionId, { status, reply });
}
/** Ends the conversation's running turn, optionally with an assistant reply. Returns its id, or null when none runs. */
export function finishActiveTurn(store, sessionId, { status = 'completed', reply = null } = {}) {
  const turnId = store.state.sessions.find(row => row.id === sessionId)?.activeTurnId;
  if (!turnId) return null;
  if (reply) store.mutate(state => { const session = state.sessions.find(row => row.id === sessionId); session.items.push({ id: `reply-${turnId}`, turnId, kind: 'assistant', text: reply, createdAt: new Date().toISOString(), simulated: false }); });
  store.finishRuntimeTurn(sessionId, turnId, { status });
  return turnId;
}
