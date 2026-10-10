// D4 scenario for B9 (align §1.3 H "打开会话会整份加载"; the memory pipeline meets the session stream): a browser tab that
// follows web/src/store/sync.ts opens a live-shaped conversation (2,000 entries, 60 evidence outbox rows, memory
// context on every turn) on its tail window; the memory pipeline then rewrites its bookkeeping and a reply streams in.
// Before B9 the tab downloaded the whole conversation, and every outbox change (≈200 KB, over one event) reached it
// as `resync fields: [memoryEvidenceOutbox]`, which reloads the whole conversation again.
// The second scenario: a card background work asked long ago, with a long conversation after it, stays reachable from
// the tail window (the composer's strip, `rna watch`), and answering it reaches the open tab as an item change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { fillLiveShaped, outboxRows } from '../harness/fixtures.mjs';
import { SESSION_FIELDS, TURN_FIELDS } from '../../session-schema.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.mjs');
const KB = 1024;
/** The tail window's budget (the long-session gate's): what opening a conversation may download. */
const TAIL_BYTES = 300 * KB;

test('an open conversation stays a tail window while the memory pipeline writes and a reply streams (B9)', async t => {
  const world = await createWorld(t, { jev: false });
  fillLiveShaped(world, { items: 2000, itemBytes: 300, memoryContextBytes: 1600, outbox: 60 });
  const s = scenario(world), sessionGets = tab => tab.gets.filter(row => row.kind === 'session');

  const opened = await s.step('a tab opens the conversation', async () => {
    const tab = await world.browser({ sessionId: world.sessionId });
    await until(() => sessionGets(tab).length, 'the tab to read the conversation');
    return { tab };
  });
  const { tab } = opened.outcome, [first] = sessionGets(tab);
  const outboxBytes = Buffer.byteLength(JSON.stringify(world.session().memoryEvidenceOutbox));
  assert.ok(outboxBytes > 64 * KB, `the outbox is larger than one event (${Math.round(outboxBytes / KB)} KB, precondition)`);
  assert.equal(first.path, `/api/v2/sessions/${world.sessionId}?window=tail`);
  assert.ok(first.bytes <= TAIL_BYTES, `opening downloaded ${Math.round(first.bytes / KB)} KB`);

  const bookkeeping = await s.step('the memory pipeline rewrites its bookkeeping', async () => {
    world.store.mutate(state => {
      const session = state.sessions.find(row => row.id === world.sessionId);
      session.memoryEvidenceOutbox = outboxRows({ count: 61, projectId: world.projectId, sessionId: world.sessionId, at: '2026-10-05T01:00:00.000Z' });
      session.memoryEvidenceState = { cursor: session.items.length };
      for (const turn of session.turns.slice(-3)) turn.memoryWrite = { status: 'completed', uri: 'viking://resources/fixture/write' };
    });
    await new Promise(done => setTimeout(done, 250));
  });
  await bookkeeping.expect({ frames: frames => {
    const session = frames.filter(frame => frame.stream.includes('?session=') && ['resync', 'session.patch', 'turns.upsert', 'items.upsert'].includes(frame.event));
    assert.deepEqual(session.map(frame => `${frame.event} ${JSON.stringify(frame.data).slice(0, 120)}`), [], 'no session event for host bookkeeping');
  } });
  assert.equal(sessionGets(tab).length, 1, 'the tab did not read the conversation again');

  const streamed = await s.stream('Continue the chapter.', { tab, reply: 'The next paragraph arrives in pieces. '.repeat(20), chunks: 12, chunkMs: 40 });
  await streamed.expect({ frames: frames => {
    assert.ok(frames.some(frame => frame.event === 'delta'), 'the reply streamed (precondition)');
    for (const frame of frames.filter(row => row.event === 'turns.upsert')) for (const turn of frame.data.turns) assert.deepEqual(Object.keys(turn).filter(key => !TURN_FIELDS.includes(key)), [], turn.id);
    for (const frame of frames.filter(row => row.event === 'session.patch')) assert.deepEqual(Object.keys(frame.data.fields).filter(key => !SESSION_FIELDS.includes(key)), []);
    assert.equal(frames.filter(row => row.event === 'resync' && row.stream.includes('?session=')).length, 0);
  } });
  assert.equal(streamed.outcome.gets.filter(row => row.kind === 'session').length, 0, 'a streamed turn reads the conversation no more');
  // The host keeps its memory bookkeeping on the turns and the session; only the wire leaves it out.
  assert.ok(world.session().turns[0].memoryContext && world.session().memoryEvidenceOutbox.length === 61, 'the host keeps its bookkeeping (precondition)');
  tab.close();
});

test('a card asked long ago stays reachable from the tail window, and answering it reaches the open tab in place (B9)', async t => {
  const world = await createWorld(t, { jev: false });
  fillLiveShaped(world, { items: 2000, itemBytes: 300, memoryContextBytes: 400, outbox: 0 });
  const s = scenario(world), sessionGets = tab => tab.gets.filter(row => row.kind === 'session'), QUESTION = 'Which ending should chapter 40 take?';
  await s.step('background work asked a question near the start of the conversation', async () => {
    world.app.interactions.publishInitiative({ projectId: world.projectId, sessionId: world.sessionId, actionId: 'run-early',
      questions: [{ id: 'ending', header: 'Ending', question: QUESTION, options: [{ id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }], allowCustom: true }] });
    // The card the service appended, moved to where a card asked before the rest of the conversation sits.
    world.store.mutate(state => {
      const session = state.sessions.find(row => row.id === world.sessionId), card = session.items.pop();
      session.items.splice(40, 0, { ...card, createdAt: session.items[40].createdAt });
    });
  });
  const cardId = world.session().items[40].interaction?.id;
  assert.ok(cardId, 'the card was published (precondition)');

  const opened = await world.getJson(`/api/v2/sessions/${world.sessionId}?window=tail`);
  assert.ok(opened.body.window.hasMore && !opened.body.items.some(item => item.interaction?.id === cardId), 'the card is older than the window (precondition)');
  assert.deepEqual(opened.body.pinned?.map(item => item.interaction.id), [cardId], 'the tail carries the waiting card');
  assert.ok(opened.bytes <= TAIL_BYTES, `opening downloaded ${Math.round(opened.bytes / KB)} KB`);

  // `rna watch` shows it with the window (cli-stream SessionView puts waiting cards first).
  const child = spawn(process.execPath, [CLI, 'watch', world.sessionId], { env: { ...process.env, RNA_AGENT_PORT: String(world.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', exited = null;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; }); child.on('exit', code => { exited = code; });
  t.after(() => child.kill('SIGKILL'));
  const watchShows = (text, label) => until(() => { if (exited !== null) throw new Error(`rna watch exited (${exited})`); return stdout.includes(text); }, label, 30000);
  await watchShows(QUESTION, 'rna watch to show the old card');
  await watchShows(world.session().items.at(-1).text.slice(0, 60), 'rna watch to show the window');

  const tab = await world.browser({ sessionId: world.sessionId });
  await until(() => sessionGets(tab).length, 'the tab to read the conversation');
  const answered = await s.answer([{ id: 'ending', selected: ['closed'] }], { label: 'the user answers the old card' });
  await answered.expect({ frames: frames => {
    const session = frames.filter(frame => frame.stream.includes('?session='));
    assert.ok(session.some(frame => frame.event === 'items.upsert' && frame.data.items.some(item => item.interaction?.id === cardId && item.interaction.status === 'answered')), 'the answered card reaches the tab as an item change');
    assert.equal(session.filter(frame => frame.event === 'resync').length, 0);
  } });
  assert.equal(sessionGets(tab).length, 1, 'the tab did not read the conversation again');
  await watchShows('已回答：closed', 'rna watch to show the card answered');
  assert.equal((await world.getJson(`/api/v2/sessions/${world.sessionId}?window=tail`)).body.pinned, undefined, 'nothing waits any more');
  tab.close();
});
