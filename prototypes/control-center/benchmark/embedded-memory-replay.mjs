#!/usr/bin/env node
// Embedded memory search, replayed over real conversations (read-only; nothing is written outside this process).
// Every finished turn of the given state is stored as the event a commit writes, in the order the turns happened;
// before a turn is stored, its user message is searched for, as auto-recall does at the start of a turn. A turn of
// the same conversation is the related memory; every other conversation is the rest of the store.
// Usage: RNA_STATE=<main checkout>/prototypes/control-center/.state/state.json node benchmark/embedded-memory-replay.mjs
import { readStateFile } from '../state-shards.mjs';
import { EmbeddedMemory, EMBEDDED_MEMORY_ENDPOINT } from '../embedded-memory.mjs';

const file = process.env.RNA_STATE; if (!file) { console.error('RNA_STATE is required: the state.json to replay (read with readStateFile, never opened as a store).'); process.exit(2); }
const { state } = readStateFile(file), turns = [];
for (const session of state.sessions ?? []) {
  let current = null, index = 0;
  for (const item of session.items ?? []) {
    if (item.kind === 'user' && String(item.text ?? '').trim()) { current = { conversation: session.id, index: index++, at: Date.parse(item.createdAt) || 0, user: String(item.text), assistant: '' }; turns.push(current); }
    else if (item.kind === 'assistant' && current && item.text) current.assistant += `${item.text}\n`;
  }
}
turns.sort((a, b) => a.at - b.at);
const memory = new EmbeddedMemory(':memory:'), root = 'viking://resources/replay', headers = { 'X-OpenViking-Actor-Peer': 'replay' };
const post = (path, body) => memory.request(`${EMBEDDED_MEMORY_ENDPOINT}${path}`, { method: 'POST', headers, body });
const find = async (query, scope, limit) => (await post('/api/v1/search/find', { query: query.slice(0, 1000), target_uri: scope, limit })).result.resources;
const conversationOf = uri => uri.slice(`${root}/c/`.length).split('/')[0];
let asked = 0, first = 0, topFive = 0, found = 0, stored = 0; const started = performance.now(), queries = [];
for (const turn of turns) {
  if (turn.index > 0 && turn.user.trim().length >= 4) {
    const hits = await find(turn.user, root, 5); asked++; queries.push(turn);
    if (hits.length) found++; if (hits[0] && conversationOf(hits[0].uri) === turn.conversation) first++; if (hits.some(hit => conversationOf(hit.uri) === turn.conversation)) topFive++;
  }
  const event = memory.eventOf([{ role: 'user', content: turn.user.slice(0, 6000) }, { role: 'assistant', content: turn.assistant.slice(0, 12000) }], turn.at);
  await post('/api/v1/content/write', { uri: `${root}/c/${turn.conversation}/${event.path.replaceAll('/', '-')}-${stored++}.md`, content: event.text, mode: 'create' });
}
const replayMs = performance.now() - started, conversations = [...new Set(turns.map(turn => turn.conversation))];
// The same questions asked of conversations they do not belong to: how often a keyword search still answers.
let elsewhere = 0; const searchStarted = performance.now();
for (const turn of queries) { let any = false; for (const other of conversations) if (other !== turn.conversation && (await find(turn.user, `${root}/c/${other}`, 1)).length) { any = true; break; } if (any) elsewhere++; }
const share = count => (asked ? (count / asked).toFixed(3) : 'n/a');
console.log(JSON.stringify({ turns: turns.length, conversations: conversations.length, queries: asked, sameConversationFirst: share(first), sameConversationInTopFive: share(topFive), anyResult: share(found),
  answeredFromAnotherConversation: share(elsewhere), msPerTurnStoredAndSearched: Number((replayMs / Math.max(1, turns.length)).toFixed(2)), msPerScopedSearch: Number(((performance.now() - searchStarted) / Math.max(1, asked * Math.max(1, conversations.length - 1))).toFixed(2)) }, null, 2));
memory.close();
