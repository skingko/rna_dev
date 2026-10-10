// B9: a conversation opens on a tail window and pages backward (deepseek-harness history.ts:38, 392-425; zcode protocol
// v4 snapshot.ts:451-458, transport.ts:511-533), and the session record and its turns go out as allowlists
// (session-schema.mjs): the memory pipeline's bookkeeping stays on the host, on GET and on the session stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { createApiV2, MAX_EVENT_BYTES } from '../api-v2.mjs';
import { SESSION_FIELDS, TURN_FIELDS, TAIL_WINDOW, PAGE_LIMIT, turnBoundaries, tailStart, pageStart } from '../session-schema.mjs';

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  throw new Error('condition did not settle');
}
function sse(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, response => {
      const events = []; let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk; let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index), lines = raw.split('\n'); buffer = buffer.slice(index + 2);
          if (lines.every(line => line.startsWith(':'))) continue;
          const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          events.push({ event: lines.find(line => line.startsWith('event: '))?.slice(7), bytes: Buffer.byteLength(data), data: JSON.parse(data) });
        }
      });
      resolve({ events, close: () => request.destroy(), of: type => events.filter(event => event.event === type) });
    });
    request.on('error', reject);
  });
}
const getJson = async (port, path) => { const response = await fetch(`http://127.0.0.1:${port}${path}`); const text = await response.text(); return { status: response.status, body: JSON.parse(text), bytes: Buffer.byteLength(text) }; };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-session-window-')), store = new Store(join(directory, 'state.json')), streams = new Set();
  const api = createApiV2({ store, streams, heartbeatMs: 1000 });
  const server = http.createServer((req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (!api.handle(req, res, { pathname: url.pathname, url, send })) send(404, { error: 'missing' }); }
    catch (error) { send(error.status ?? 500, { error: error.message, code: error.code }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = store.createProject({ name: 'Window', workspace: directory, initiative: { enabled: false } });
  return { store, port: server.address().port, project, session };
}

const at = index => new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString();
/**
 * `shape` lists turns by their message count; each turn is user, then (assistant, tool) pairs, then an answer, and
 * carries the memory bookkeeping the wire leaves out. A proactive message without a turn lands inside turn `proactiveIn`.
 */
function conversation(shape, { proactiveIn = null } = {}) {
  const items = [], turns = [];
  let n = 0;
  shape.forEach((messages, turnIndex) => {
    const turnId = `turn-${turnIndex}`;
    items.push({ id: `u-${turnIndex}`, turnId, kind: 'user', text: `question ${turnIndex}`, createdAt: at(n++), submissionId: `submission-${turnIndex}` });
    for (let index = 1; index < messages - 1; index++) {
      items.push({ id: `a-${turnIndex}-${index}`, turnId, kind: 'assistant', text: `step ${index}`, createdAt: at(n++) });
      items.push({ id: `t-${turnIndex}-${index}`, turnId, kind: 'tool', text: '', createdAt: at(n++), tool: { name: 'project_read', status: 'succeeded', output: 'x' } });
      if (proactiveIn === turnIndex && index === 1) items.push({ id: `p-${turnIndex}`, turnId: null, kind: 'assistant', source: 'initiative', text: 'proactive', createdAt: at(n++) });
    }
    if (messages > 1) items.push({ id: `f-${turnIndex}`, turnId, kind: 'assistant', text: `answer ${turnIndex}`, createdAt: at(n++) });
    turns.push({ id: turnId, status: 'completed', createdAt: at(n), userItemId: `u-${turnIndex}`, modelConfig: { execution: 'rna', providerId: 'p', modelId: 'm' }, usage: { totalTokens: 10 },
      memoryContext: { status: 'recalled', results: [{ abstract: 'x'.repeat(4000) }] }, memoryWrite: { status: 'completed', uri: 'viking://x' }, mindContext: { lessons: ['y'.repeat(500)] }, route: { point: 'turn.route', skills: ['outline'], clarify: true }, judgments: [{ point: 'p' }] });
  });
  return { items, turns };
}
const fill = (f, data, extra = {}) => f.store.mutate(state => { Object.assign(state.sessions.find(row => row.id === f.session.id), data, extra); });
const messageCount = items => items.filter(item => item.kind === 'user' || item.kind === 'assistant').length;

test('turn boundaries never split a turn, a proactive message inside one included', () => {
  const { items } = conversation([3, 4, 2], { proactiveIn: 1 }), { bounds, referenced } = turnBoundaries(items);
  const starts = items.map((item, index) => bounds[index] ? item.id : null).filter(Boolean);
  assert.deepEqual(starts, ['u-0', 'u-1', 'u-2']);
  assert.equal(bounds[items.length], 1);
  assert.deepEqual([...referenced], ['turn-0', 'turn-1', 'turn-2']);
  // Paging: a cut inside a turn moves to the next turn's start; a turn longer than the page is cut where the page ends.
  const end = items.length, inside = items.findIndex(item => item.id === 'a-1-1');
  assert.equal(pageStart(items, end, end - inside), items.findIndex(item => item.id === 'u-2'));
  const long = conversation([400]).items;
  assert.equal(pageStart(long, long.length, PAGE_LIMIT), long.length - PAGE_LIMIT);
});

test('opening with window=tail sends whole recent turns with ≥50 messages and ≥2 turns, and says what is left out', async t => {
  const f = await fixture(t);
  // 30 turns of 9 messages, then three small ones: walking back, 50 messages are reached inside turn 25.
  const data = conversation([...Array(30).fill(9), 3, 3, 3]);
  fill(f, data, { memoryEvidenceOutbox: [{ id: 'outbox-1', status: 'completed', body: 'z'.repeat(5000) }], memoryEvidenceState: { cursor: 3 }, submissions: [{ id: 's' }], commandHistory: [{ id: 'c' }], invitationHistory: [{ id: 'i' }] });
  const full = await getJson(f.port, `/api/v2/sessions/${f.session.id}`), tail = await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail`);
  assert.equal(full.status, 200); assert.equal(tail.status, 200);
  assert.equal(full.body.items.length, data.items.length, 'without window every item comes');
  assert.deepEqual(full.body.window, { totalCount: data.items.length, firstItemId: 'u-0', hasMore: false });
  const items = tail.body.items, first = items[0];
  assert.equal(first.id, 'u-25', 'the window starts at the start of the turn where 50 messages were reached');
  assert.equal(items.at(-1).id, data.items.at(-1).id);
  assert.ok(messageCount(items) >= TAIL_WINDOW.minMessages);
  assert.ok(messageCount(items.slice(items.findIndex(item => item.id === 'u-26'))) < TAIL_WINDOW.minMessages, 'no bigger than it has to be');
  assert.deepEqual(tail.body.turns.map(turn => turn.id), Array.from({ length: 8 }, (_, index) => `turn-${25 + index}`));
  assert.deepEqual(tail.body.window, { totalCount: data.items.length, firstItemId: 'u-0', hasMore: true });
  assert.equal(tail.body.revision, f.store.state.revision);
  assert.ok(tail.bytes * 4 < full.bytes, `tail ${tail.bytes} B vs full ${full.bytes} B`);
  // Items travel as stored; the record and the turns are allowlists.
  assert.equal(items.find(item => item.id === 'u-30').submissionId, 'submission-30');
  for (const body of [full.body, tail.body]) {
    assert.deepEqual(Object.keys(body).filter(key => !['items', 'turns', 'revision', 'window'].includes(key)).filter(key => !SESSION_FIELDS.includes(key)), []);
    for (const key of ['memoryEvidenceOutbox', 'memoryEvidenceState', 'submissions', 'commandHistory', 'invitationHistory']) assert.equal(body[key], undefined, key);
    for (const turn of body.turns) {
      assert.deepEqual(Object.keys(turn).filter(key => !TURN_FIELDS.includes(key)), [], turn.id);
      for (const key of ['memoryContext', 'memoryWrite', 'mindContext', 'judgments']) assert.equal(turn[key], undefined, key);
      // The router's advice is the turn footer's hints (web TurnRow routeHints): it stays on the wire.
      assert.deepEqual(turn.route, { point: 'turn.route', skills: ['outline'], clarify: true });
      assert.equal(turn.userItemId, `u-${turn.id.slice(5)}`); assert.equal(turn.modelConfig.execution, 'rna'); assert.equal(turn.usage.totalTokens, 10);
    }
  }
  assert.equal(full.body.inbox.length, 0, 'the queued messages are on the record (the CLI run reads them)');
  assert.equal((await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=all`)).status, 400);
});

test('a short conversation opens whole; the active turn and a turn with no item come with the tail', async t => {
  const f = await fixture(t);
  const small = conversation([5, 5]);
  fill(f, small);
  const opened = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail`)).body;
  assert.equal(opened.items.length, small.items.length); assert.equal(opened.window.hasMore, false);
  const data = conversation([...Array(12).fill(9), 9]);
  data.turns.splice(1, 0, { id: 'turn-failed-early', status: 'failed', createdAt: at(5), errorCode: 'provider_unavailable', memoryContext: { status: 'skipped' } });
  data.turns.push({ id: 'turn-active', status: 'running', createdAt: at(999), userItemId: null });
  fill(f, data, { activeTurnId: 'turn-active', status: 'running' });
  const tail = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail`)).body;
  const ids = tail.turns.map(turn => turn.id);
  assert.ok(ids.includes('turn-active') && ids.includes('turn-failed-early'), ids.join());
  assert.ok(!ids.includes('turn-0'), 'turns of items outside the window stay out');
  assert.equal(tail.turns.find(turn => turn.id === 'turn-failed-early').memoryContext, undefined);
});

test('paging back with items?before=&limit returns turn-aligned pages that rebuild the whole history', async t => {
  const f = await fixture(t);
  const data = conversation(Array.from({ length: 60 }, (_, index) => 3 + (index % 7) * 4), { proactiveIn: 40 });
  fill(f, data);
  const tail = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail`)).body;
  let all = tail.items, before = tail.items[0].id, hasMore = tail.window.hasMore, pages = 0;
  const turns = new Map(tail.turns.map(turn => [turn.id, turn]));
  while (hasMore) {
    const page = await getJson(f.port, `/api/v2/sessions/${f.session.id}/items?before=${before}&limit=60`);
    assert.equal(page.status, 200);
    assert.ok(page.body.items.length <= 60 && page.body.items.length > 0);
    assert.equal(page.body.totalCount, data.items.length); assert.equal(page.body.sessionId, f.session.id);
    // Each page starts where a turn starts (no turn here is longer than a page).
    assert.ok(page.body.items[0].kind === 'user', page.body.items[0].id);
    for (const turn of page.body.turns) { assert.equal(turn.memoryContext, undefined); turns.set(turn.id, turn); }
    assert.deepEqual(page.body.turns.map(turn => turn.id), [...new Set(page.body.items.map(item => item.turnId).filter(Boolean))]);
    all = [...page.body.items, ...all]; before = page.body.items[0].id; hasMore = page.body.hasMore; pages++;
  }
  assert.ok(pages > 3);
  assert.deepEqual(all.map(item => item.id), data.items.map(item => item.id));
  assert.equal(turns.size, data.turns.length);
  // Without `before`, the newest page; bad limits and unknown anchors are refused.
  const newest = (await getJson(f.port, `/api/v2/sessions/${f.session.id}/items?limit=10`)).body;
  assert.equal(newest.items.at(-1).id, data.items.at(-1).id); assert.ok(newest.items.length <= 10);
  for (const limit of ['0', '201', '2.5', 'x']) assert.equal((await getJson(f.port, `/api/v2/sessions/${f.session.id}/items?limit=${limit}`)).status, 400, limit);
  const gone = await getJson(f.port, `/api/v2/sessions/${f.session.id}/items?before=missing-item`);
  assert.equal(gone.status, 404); assert.equal(gone.body.code, 'item_not_found');
  assert.equal((await getJson(f.port, '/api/v2/sessions/missing/items')).status, 404);
});

test('the tail carries older cards still waiting for the user, reaches back to what a client re-reading holds, and runs are located', async t => {
  const f = await fixture(t);
  const data = conversation([...Array(30).fill(9), 3, 3, 3]), position = id => data.items.findIndex(item => item.id === id);
  // Background work asked a question and posted its line in turn 3; a permission request in turn 5 was answered;
  // a scheduled run delivered in turn 6; a card that can no longer be answered waits in turn 7.
  const extra = [
    [3, { id: 'ask-old', turnId: null, kind: 'question', text: '', createdAt: data.items[position('u-3')].createdAt, interaction: { id: 'i-old', kind: 'question', status: 'pending', questions: [{ question: 'Which ending?' }] } }],
    [3, { id: 'work-line', turnId: null, kind: 'assistant', source: 'initiative', text: 'Checked chapter 3.', createdAt: data.items[position('u-3')].createdAt, initiative: { backgroundWork: { actionId: 'run-7' } } }],
    [5, { id: 'perm-done', turnId: null, kind: 'question', text: '', createdAt: data.items[position('u-5')].createdAt, interaction: { id: 'i-done', kind: 'permission', status: 'answered' } }],
    [6, { id: 'delivery', turnId: null, kind: 'assistant', source: 'initiative', text: 'Morning digest.', createdAt: data.items[position('u-6')].createdAt, scheduleOccurrenceKey: 'daily:2026-10-01' }],
    [7, { id: 'stale-card', turnId: null, kind: 'question', text: '', createdAt: data.items[position('u-7')].createdAt, interaction: { id: 'i-stale', kind: 'question', status: 'interrupted', canRespond: false } }],
  ];
  for (const [turn, item] of extra.reverse()) data.items.splice(position(`u-${turn}`), 0, item);
  fill(f, data);
  const tail = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail`)).body;
  assert.ok(tail.window.hasMore && !tail.items.some(item => item.id === 'ask-old'), 'the card is older than the window (precondition)');
  assert.deepEqual(tail.pinned.map(item => item.id), ['ask-old'], 'only the card that still waits and can be answered');
  assert.equal(tail.pinned[0].interaction.questions[0].question, 'Which ending?');
  const index = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail&from=missing`)).body;
  assert.deepEqual(index.items.map(item => item.id), tail.items.map(item => item.id), 'an item no longer there is ignored');
  // A client that had paged back to turn 20 re-reads after a resync: it gets the window from there, the card stays pinned.
  const again = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail&from=u-20`)).body;
  assert.equal(again.items[0].id, 'u-20'); assert.equal(again.items.at(-1).id, data.items.at(-1).id); assert.equal(again.window.hasMore, true);
  assert.ok(again.turns.some(turn => turn.id === 'turn-20')); assert.deepEqual(again.pinned.map(item => item.id), ['ask-old']);
  assert.equal((await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail&from=${tail.items.at(-1).id}`)).body.items[0].id, tail.items[0].id, 'a later item does not shrink the window');
  const whole = (await getJson(f.port, `/api/v2/sessions/${f.session.id}?window=tail&from=${data.items[0].id}`)).body;
  assert.equal(whole.items.length, data.items.length); assert.equal(whole.window.hasMore, false); assert.equal(whole.pinned, undefined);
  // Runs are located wherever their line is.
  const run = (await getJson(f.port, `/api/v2/sessions/${f.session.id}/locate?actionId=run-7`)).body;
  assert.equal(run.itemId, 'work-line'); assert.equal(run.position.index, position('work-line')); assert.equal(run.position.count, data.items.length);
  assert.equal((await getJson(f.port, `/api/v2/sessions/${f.session.id}/locate?occurrenceKey=daily:2026-10-01`)).body.itemId, 'delivery');
  const none = await getJson(f.port, `/api/v2/sessions/${f.session.id}/locate?actionId=run-0`);
  assert.equal(none.status, 404); assert.equal(none.body.code, 'item_not_found');
  assert.equal((await getJson(f.port, `/api/v2/sessions/${f.session.id}/locate`)).body.code, 'locate_invalid');
});

test('the session stream carries only the allowlisted record and turns: host bookkeeping changes send nothing', async t => {
  const f = await fixture(t);
  const data = conversation([5, 5]);
  fill(f, data);
  const client = await sse(f.port, `/api/v2/stream?session=${f.session.id}`); t.after(client.close);
  await until(() => client.of('hello').length);
  const sessionEvents = () => client.events.filter(event => ['items.upsert', 'items.remove', 'turns.upsert', 'session.patch', 'resync'].includes(event.event));
  // The evidence outbox grows past one event (it used to arrive as a resync and a full reload), memory bookkeeping on a
  // turn changes: nothing for a client.
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    session.memoryEvidenceOutbox = Array.from({ length: 30 }, (_, index) => ({ id: `outbox-${index}`, status: 'completed', body: 'z'.repeat(3000) }));
    session.memoryEvidenceState = { cursor: 9 };
    session.turns[0].memoryWrite = { status: 'completed', uri: 'viking://y' };
    session.turns[1].memoryContext = { status: 'recalled', results: [{ abstract: 'w'.repeat(70000) }] };
  });
  await delay(200);
  assert.deepEqual(sessionEvents().map(event => event.event), []);
  // A turn field a client reads still goes out, as its view.
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.turns[1].status = 'failed'; session.turns[1].errorCode = 'provider_timeout'; session.title = 'Renamed'; });
  await until(() => client.of('turns.upsert').length && client.of('session.patch').length);
  const turn = client.of('turns.upsert')[0].data.turns[0];
  assert.equal(turn.status, 'failed'); assert.equal(turn.memoryContext, undefined); assert.equal(turn.memoryWrite, undefined);
  assert.ok(client.of('session.patch').every(event => Object.keys(event.data.fields).every(key => SESSION_FIELDS.includes(key))));
  assert.equal(client.of('resync').length, 0);
  for (const event of client.events) assert.ok(event.bytes <= MAX_EVENT_BYTES);
});

test('tail cut rules: a cap at 500 messages, and ≥2 turns even when one turn has 50 messages', () => {
  const huge = conversation([4, 700]).items;
  const start = tailStart(huge);
  assert.equal(messageCount(huge.slice(start)), TAIL_WINDOW.maxMessages, 'one enormous turn is cut at the cap');
  const two = conversation([3, 3, 60]).items;
  assert.equal(two[tailStart(two)].id, 'u-1', 'the 60-message turn alone is not enough: the turn before it comes too');
});

test('the legacy whole-state readers say they are deprecated, and `rna status` reads the health instead of the state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-legacy-readers-')), app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { session } = app.store.createProject({ name: 'Legacy readers' }), base = `http://127.0.0.1:${app.server.address().port}`, paths = [];
  app.server.on('request', request => paths.push(request.url));
  // RFC 9745: the value is a Structured Field Date (`@` and unix seconds), here 2026-10-05T00:00:00Z; `true` is not one.
  const deprecatedAt = '@1791158400';
  for (const [path, successor] of [['/api/state', '/api/v2/bootstrap'], ['/api/projects', '/api/v2/bootstrap'], ['/api/sessions', '/api/v2/bootstrap'], [`/api/sessions/${session.id}`, `/api/v2/sessions/${session.id}`]]) {
    const response = await fetch(`${base}${path}`); await response.arrayBuffer();
    assert.equal(response.headers.get('deprecation'), deprecatedAt, path); assert.equal(response.headers.get('link'), `<${successor}>; rel="successor-version"`, path);
  }
  assert.equal(new Date(Number(deprecatedAt.slice(1)) * 1000).toISOString(), '2026-10-05T00:00:00.000Z');
  const controller = new AbortController(), stream = await fetch(`${base}/api/stream?session=${session.id}`, { signal: controller.signal });
  assert.equal(stream.headers.get('deprecation'), deprecatedAt); assert.match(stream.headers.get('link'), /<\/api\/v2\/stream>/); controller.abort();
  for (const path of ['/api/v2/bootstrap', `/api/v2/sessions/${session.id}?window=tail`, '/api/health']) { const response = await fetch(`${base}${path}`); await response.arrayBuffer(); assert.equal(response.headers.get('deprecation'), null, path); }
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.emergency, false); assert.equal(health.revision, app.store.state.revision);
  const mark = paths.length, cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const status = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'status'], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) } })).stdout);
  assert.deepEqual(paths.slice(mark), ['/api/health'], 'the whole state is not read');
  assert.equal(status.emergency, false); assert.equal(status.revision, app.store.state.revision); assert.equal(status.mode, 'hybrid'); assert.equal(typeof status.ok, 'boolean');
  // What `status` printed from the whole state before: the budget settings and today's usage.
  assert.deepEqual(status.settings, app.store.state.settings); assert.deepEqual(status.usage, app.store.state.usage);
  assert.equal(typeof status.settings.dailyBudget, 'number'); assert.equal(typeof status.usage.tokens, 'number');
  // The other everyday readers: the conversation list, a conversation's history and cards, pausing one.
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { env });
  const before = paths.length;
  assert.match((await run('sessions')).stdout, new RegExp(session.id));
  const history = JSON.parse((await run('history', session.id)).stdout);
  assert.equal(history.id, session.id); assert.ok(Array.isArray(history.items)); assert.equal(history.memoryEvidenceOutbox, undefined);
  assert.deepEqual(JSON.parse((await run('questions', session.id)).stdout), { sessionId: session.id, interactions: [] });
  await run('pause', session.id).catch(() => {});
  assert.deepEqual(paths.slice(before).filter(path => !path.startsWith('/api/v2/') && !path.startsWith(`/api/sessions/${session.id}/control`)), [], 'no legacy whole-state read');
});
