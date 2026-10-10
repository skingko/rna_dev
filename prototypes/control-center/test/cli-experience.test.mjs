import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { completeCommand, createLineQueue, incrementalItem } from '../cli-interactive.mjs';
import { followSession, SessionView } from '../cli-stream.mjs';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
test('CLI serializes a pasted burst without losing lines and drains on EOF', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-cli-experience-')); const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false }); await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { session } = app.store.createProject({ name: 'CLI 连续输入', demo: true, workspace: directory });
  const child = exec(process.execPath, [cli, 'chat', session.id], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, timeout: 15000 });
  child.child.stdin.end('/status\n/model\n/mode plan\n/mode build\n第1条需求\n/steer 第2条调整\n/followup 第3条排队\n/inbox\n/status\n/quit\n');
  const result = await child, latest = app.store.state.sessions.find(item => item.id === session.id);
  assert.ok(latest.items.some(item => item.kind === 'user' && item.text === '第1条需求')); assert.deepEqual(latest.inbox.map(item => item.text), ['第2条调整', '第3条排队']); assert.equal(latest.mode, 'build'); assert.ok(!result.stdout.includes('上一条命令仍在提交')); assert.equal(result.stderr, '');
});
test('CLI workspace entry reuses actual directory and help stays available offline', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-cli-workspace-')); const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false }); await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const existing = app.store.openWorkspace({ workspace: directory, name: 'Existing', demo: true });
  const child = exec(process.execPath, [cli, 'chat', '--workspace', directory], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, timeout: 15000 }); child.child.stdin.end('/quit\n'); assert.match((await child).stdout, new RegExp(existing.session.id)); assert.equal(app.store.state.projects.filter(project => project.workspace === existing.project.workspace).length, 1);
  assert.match((await exec(process.execPath, [cli, '--help'], { env: { ...process.env, RNA_AGENT_PORT: '1' } })).stdout, /chat --workspace/); assert.match((await exec(process.execPath, [cli, 'help', 'all'])).stdout, /provider-auth/); assert.match((await exec(process.execPath, [cli, '--version'])).stdout, /Rna Agent/);
});
// The CLI follows the v2 session stream (B9): hello, the tail window, then events; reconnects resume by Last-Event-ID.
const sse = frames => frames.map(([event, data, id]) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const hello = ['hello', { protocol: 3, revision: 1, seq: 1, sessionId: 's' }];
/** A stream response that stays open until the client cancels it. */
const open = text => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); } }));
const isStream = url => url.startsWith('http://fixture/api/v2/stream?session=s');
test('CLI read-only subscription reconnects with backoff, takes the tail window once, caps delay and aborts sleep', async () => {
  let streams = 0, snapshots = 0; const waits = [], seen = [], states = [], urls = [];
  await followSession({ base: 'http://fixture', sessionId: 's', baseDelayMs: 5, maxDelayMs: 10, wait: async ms => { waits.push(ms); }, onConnection: value => states.push(value.state),
    request: async url => { urls.push(url); if (isStream(url)) { streams++; if (streams <= 3) throw new Error('offline'); return open(sse([hello])); } snapshots++; return Response.json({ id: 's', items: [{ id: 'durable', kind: 'assistant', text: 'durable' }], turns: [], revision: 1, window: { totalCount: 1, firstItemId: 'durable', hasMore: false } }); },
    onUpdate: (session, ids) => { seen.push([session.items.map(item => item.id), ids]); return false; } });
  assert.equal(streams, 4); assert.equal(snapshots, 1); assert.deepEqual(waits, [5, 10, 10]); assert.deepEqual(seen, [[['durable'], ['durable']]]); assert.equal(states.at(-1), 'connected');
  assert.ok(urls.includes('http://fixture/api/v2/sessions/s?window=tail'), urls.join());
  const abort = new AbortController(); let retries = 0; const running = followSession({ base: 'http://fixture', sessionId: 's', signal: abort.signal, request: async () => { retries++; throw new Error('offline'); }, onUpdate() {} }); await delay(5); abort.abort(); await running; assert.equal(retries, 1);
});
test('CLI stream does not retry authorization/session errors or callback execution failures', async () => {
  for (const status of [401,403,404]) { let calls = 0; await assert.rejects(followSession({ base: 'http://fixture', sessionId: 's', request: async () => { calls++; return Response.json({ error: 'terminal' }, { status }); }, onUpdate() {} }), /terminal/); assert.equal(calls, 1); }
  let calls = 0; await assert.rejects(followSession({ base: 'http://fixture', sessionId: 's', request: async url => { if (isStream(url)) { calls++; return open(sse([hello])); } return Response.json({ id: 's', items: [], turns: [], revision: 1 }); }, onUpdate() { throw new Error('consumer failed'); } }), /consumer failed/); assert.equal(calls, 1);
  // The conversation was deleted after the stream opened: the tail answers 404, which ends the CLI rather than looping.
  await assert.rejects(followSession({ base: 'http://fixture', sessionId: 's', request: async url => isStream(url) ? open(sse([hello])) : Response.json({ error: '会话不存在' }, { status: 404 }), onUpdate() {} }), /会话不存在/);
});
test('CLI applies streaming deltas once across a reconnect: Last-Event-ID resumes, duplicates are skipped, the tail is read once', async () => {
  let streams = 0, snapshots = 0; const resumeIds = [], rendered = [], shown = new Map();
  const delta = (offset, append, id) => ['delta', { sessionId: 's', turnId: 't', itemId: 'a', block: 'text', offset, append }, id];
  await followSession({ base: 'http://fixture', sessionId: 's', wait: async () => {},
    request: async (url, init) => {
      if (!isStream(url)) { snapshots++; return Response.json({ id: 's', items: [{ id: 'a', turnId: 't', kind: 'assistant', text: '第一段' }], turns: [{ id: 't', status: 'running' }], revision: 2 }); }
      streams++; resumeIds.push(init.headers['Last-Event-ID'] ?? null);
      // The first connection drops after one event; the second repeats it (already applied) and goes on.
      return streams === 1 ? new Response(sse([hello, delta(3, '第二段', '7')])) : open(sse([hello, delta(3, '第二段', '7'), delta(6, '第三段', '8')]));
    },
    onUpdate: (session, ids) => { for (const item of session.items) { if (!ids.includes(item.id)) continue; const next = incrementalItem(shown.get(item.id), item); if (next) rendered.push(next.text); shown.set(item.id, item); } return session.items[0].text.length < 9; } });
  assert.equal(snapshots, 1); assert.deepEqual(resumeIds, [null, '7']);
  assert.equal(rendered.join(''), '第一段第二段第三段');
  assert.equal(incrementalItem({ kind:'assistant',text:'same' },{ kind:'assistant',text:'same' }),null); assert.equal(incrementalItem({ kind:'assistant',text:'old' },{ kind:'assistant',text:'changed' }).text,'changed'); assert.deepEqual(completeCommand('/sta'),[['/status'],'/sta']);
});
test('the CLI copy keeps its window: older items stay out, a rewind past it re-reads the tail, gaps and oversized items are re-read', () => {
  const view = new SessionView(), changed = new Set(), at = minute => `2026-10-05T00:${String(minute).padStart(2, '0')}:00.000Z`;
  view.adopt({ id: 's', title: 't', items: [{ id: 'x', kind: 'user', createdAt: at(10) }, { id: 'y', kind: 'assistant', text: 'ab', createdAt: at(11) }], turns: [], revision: 5, window: { totalCount: 40, firstItemId: 'first', hasMore: true } }, changed);
  assert.deepEqual([...changed], ['x', 'y']); changed.clear();
  // An item from before the window (its feedback changed, say) is not appended at the end; a new one is.
  view.apply('items.upsert', { revision: 6, items: [{ id: 'old', kind: 'assistant', createdAt: at(1) }, { id: 'new', kind: 'assistant', createdAt: at(12) }] }, changed);
  assert.deepEqual(view.order, ['x', 'y', 'new']); assert.deepEqual([...changed], ['new']);
  assert.deepEqual(view.apply('delta', { itemId: 'y', block: 'text', offset: 5, append: 'z' }, changed), { items: ['y'] });
  assert.deepEqual(view.apply('resync', { reason: 'event_too_large', itemIds: ['y'] }, changed), { items: ['y'] });
  assert.deepEqual(view.apply('resync', { reason: 'session_restored' }, changed), { snapshot: true });
  assert.equal(view.apply('resync', { reason: 'event_too_large', projectIds: ['p'] }, changed), null);
  view.apply('session.patch', { revision: 7, fields: { title: 'Renamed', inbox: [] } }, changed); assert.equal(view.session().title, 'Renamed');
  assert.equal(view.apply('items.remove', { ids: ['new', 'unknown-older'] }, changed), null, 'a removal that leaves the window is applied');
  assert.deepEqual(view.apply('items.remove', { ids: ['x', 'y', 'older-1'] }, changed), { snapshot: true }, 'a rewind past the window re-reads the tail');
});
test('the CLI copy re-reads after a long rewind whose last chunk names only held items, and shows older waiting cards first', () => {
  const view = new SessionView(), changed = new Set(), at = minute => `2026-10-05T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const card = { id: 'ask', kind: 'question', createdAt: at(2), interaction: { id: 'i1', status: 'pending' } };
  view.adopt({ id: 's', items: [{ id: 'x', kind: 'user', createdAt: at(10) }, { id: 'y', kind: 'assistant', createdAt: at(11) }, { id: 'z', kind: 'assistant', createdAt: at(12) }], pinned: [card], turns: [], revision: 5, window: { totalCount: 1300, firstItemId: 'first', hasMore: true } }, changed);
  assert.deepEqual(view.order, ['ask', 'x', 'y', 'z'], 'the waiting card comes first'); assert.ok(changed.has('ask'));
  // Answered elsewhere: it changes in place. An older item the window does not hold still stays out (the card is not the floor).
  view.apply('items.upsert', { revision: 6, items: [{ ...card, interaction: { id: 'i1', status: 'answered' } }, { id: 'older', kind: 'assistant', createdAt: at(5) }] }, changed);
  assert.equal(view.items.get('ask').interaction.status, 'answered'); assert.deepEqual(view.order, ['ask', 'x', 'y', 'z']);
  // A rewind of 1,200 items arrives as 1,000 ids (mostly unknown, two held), then 200 ids that name only held items.
  const older = Array.from({ length: 998 }, (_, index) => `old-${index}`);
  assert.equal(view.apply('items.remove', { revision: 7, ids: [...older, 'x', 'y'] }, changed), null, 'one held item is left');
  assert.deepEqual(view.apply('items.remove', { revision: 7, ids: ['z'] }, changed), { snapshot: true }, 'nothing of the window is left: read the tail again');
});
test('CLI runs the tail read and item reads a dropped connection left owed when it resumes', async () => {
  let streams = 0, snapshots = 0, itemReads = 0; const seen = [];
  const tail = text => Response.json({ id: 's', items: [{ id: 'a', kind: 'assistant', text }], turns: [], revision: 3, window: { totalCount: 1, firstItemId: 'a', hasMore: false } });
  await followSession({ base: 'http://fixture', sessionId: 's', wait: async () => {},
    request: async url => {
      if (isStream(url)) {
        streams++;
        // 1: the tail, then a resync whose re-read fails (the connection drops). 2: resumed after the resync, which is
        // not sent again; it ends. 3: an oversized item whose read fails (the connection drops). 4: resumed.
        if (streams === 1) return open(sse([hello, ['resync', { reason: 'backlog' }, '5']]));
        if (streams === 2) return new Response(sse([hello]));
        if (streams === 3) return open(sse([hello, ['resync', { reason: 'event_too_large', itemIds: ['a'] }, '9']]));
        return open(sse([hello]));
      }
      if (url.includes('/items/')) { itemReads++; return itemReads === 1 ? Response.json({ error: 'busy' }, { status: 503 }) : Response.json({ item: { id: 'a', kind: 'assistant', text: 'item read again' } }); }
      snapshots++;
      return snapshots === 2 ? Response.json({ error: 'busy' }, { status: 503 }) : tail(snapshots === 1 ? 'first' : 'after the resync');
    },
    onUpdate: session => { seen.push(session.items[0]?.text); return session.items[0]?.text !== 'item read again'; } });
  assert.deepEqual(seen.filter((text, index) => text !== seen[index - 1]), ['first', 'after the resync', 'item read again']);
  assert.equal(snapshots, 3, 'the failed re-read ran again when the stream resumed'); assert.equal(itemReads, 2, 'so did the failed item read');
});
test('CLI state carries the maintenance gate: from hello, then the index events that change it, null from a daemon without it', async () => {
  const gate = held => ({ protocolVersion: 1, held, operationId: held ? 'op-1' : null, phase: held ? 'applying' : null, errorCode: null });
  const tail = Response.json({ id: 's', items: [{ id: 'a', kind: 'assistant', text: 'x' }], turns: [], revision: 3, window: { totalCount: 1, firstItemId: 'a', hasMore: false } });
  const seen = []; let push;
  await followSession({ base: 'http://fixture', sessionId: 's', wait: async () => {},
    request: async url => {
      if (!isStream(url)) return tail.clone();
      return new Response(new ReadableStream({ start(controller) { push = frames => controller.enqueue(new TextEncoder().encode(sse(frames))); push([['hello', { ...hello[1], maintenance: gate(false) }]]); } }));
    },
    onUpdate: (session, ids, extra) => {
      seen.push([ids, extra.maintenance]);
      // After the tail: an index event that changes only another project's row says nothing about the gate; the one
      // after it does.
      if (seen.length === 1) setTimeout(() => push([['index', { revision: 4, projects: [{ id: 'p' }] }, '6'], ['index', { revision: 5, maintenance: gate(true) }, '7']]), 0);
      return seen.length < 2;
    } });
  // The tail with the gate as the stream began, then a line for the gate's change alone (no item changed).
  assert.deepEqual(seen, [[['a'], gate(false)], [[], gate(true)]]);
  // A 0.68 daemon's hello has no gate: null rather than missing.
  let last;
  await followSession({ base: 'http://fixture', sessionId: 's', wait: async () => {}, request: async url => isStream(url) ? open(sse([hello])) : tail.clone(), onUpdate: (session, ids, extra) => { last = extra; return false; } });
  assert.deepEqual(last, { maintenance: null });
});
test('CLI queue quit cancels pending later inputs without rejecting accepted work', async () => {
  const seen = []; const queue = createLineQueue(async line => { seen.push(line); if (line === 'quit') queue.cancel(); }); queue.push('first'); queue.push('quit'); queue.push('later'); await queue.drain(); assert.deepEqual(seen, ['first','quit']);
});
test('actual CLI chat recovers a dropped HTTP SSE connection and catches missed proactive text exactly once', async t => {
  const directory = mkdtempSync(join(tmpdir(),'rna-cli-reconnect-')), app = createServer({stateFile:join(directory,'state.json'),ticks:false,runtime:false,initiative:false}); await app.initializer.close();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const {session}=app.store.createProject({name:'Reconnect',demo:true,workspace:directory});let stream,connections=0;app.server.on('request',(req,res)=>{if(req.url.startsWith('/api/v2/stream')){stream=res;connections++;}});
  const child=exec(process.execPath,[cli,'chat',session.id],{env:{...process.env,RNA_AGENT_PORT:String(app.server.address().port)},timeout:15000});let output='';child.child.stdout.on('data',chunk=>output+=chunk);
  const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await delay(10);}throw Error('reconnect fixture timeout');};
  await until(()=>stream&&output.includes('你 ›'));stream.destroy();
  app.store.mutate(state=>{state.sessions.find(s=>s.id===session.id).items.push({id:'reconnect-proactive-fixture',kind:'assistant',source:'initiative',text:'断线期间的主动发现，仅出现一次'});});
  await until(()=>connections>=2&&output.includes('断线期间的主动发现，仅出现一次'));child.child.stdin.end('/status\n/quit\n');const result=await child;assert.equal(result.stdout.split('断线期间的主动发现，仅出现一次').length-1,1);assert.match(result.stderr,/重新连接/);assert.equal(app.store.state.sessions.find(s=>s.id===session.id).turns.length,0);
});
