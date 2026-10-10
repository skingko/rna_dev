import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { foldedContextText, foldTargets } from '../src/context.mjs';

// Spec p1 compaction TC-2: superseded copies of keyed host context fold to one line, but only at a cache break that
// is already cold (idle past the provider's cache survival, a prefix or model change, a compaction). Latest wins, as
// compaction restore already does; no delta encoding. Turn-scoped notes fold after their turn and are never
// restored; window-scoped ones are not restored and are sent again after a compaction.
const model = { providerId: 'fold-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 500, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const HOUR = 3600000;
const superseded = key => foldedContextText(key, 'superseded'), ended = key => foldedContextText(key, 'turn');

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-fold-')), requests = [], handles = [];
  let now = Date.parse('2026-10-04T08:00:00Z'), updates = [];
  const provider = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; };
  const args = { sessionId: 'context-fold', projectId: 'fold-project', cwd: dir, stateDir: join(dir, 'state'), model, provider, clock: () => now, cacheSurvivalMs: HOUR, beforeRequest: () => updates.length ? { contextUpdates: updates } : undefined, ...options };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests, advance: ms => { now += ms; }, send: value => { updates = value; } };
}
const wire = request => JSON.stringify(request.messages);
const notes = (text, extra = {}) => ({ key: 'project-notes', source: 'host-notes', text, ...extra });

test('superseded copies fold at an idle break, not on a warm one; the latest copy and the journal stay whole', async t => {
  const f = await fixture(t);
  f.send([notes('notes v1 '.repeat(200))]); await f.session.prompt('One.');
  f.send([notes('notes v2 '.repeat(200))]); await f.session.prompt('Two.');
  assert.ok(wire(f.requests.at(-1)).includes('notes v1'), 'warm: the old copy stays (the cached prefix is worth more)');
  assert.ok(!wire(f.requests.at(-1)).includes(superseded('project-notes')));
  const before = f.session.snapshot().contextUsage.estimatedInputTokens;
  f.advance(2 * HOUR); f.send([notes('notes v3 '.repeat(200))]); await f.session.prompt('Three.');
  const sent = wire(f.requests.at(-1));
  assert.ok(!sent.includes('notes v1') && !sent.includes('notes v2'), 'cold: both earlier copies fold');
  assert.equal(sent.split(superseded('project-notes').replace(/"/g, '\\"')).length - 1, 2);
  assert.ok(sent.includes('notes v3'), 'the latest copy is whole');
  assert.ok(f.session.snapshot().contextUsage.estimatedInputTokens < before, 'the estimate drops right away');
  const log = await readFile(f.session.snapshot().sessionFile, 'utf8');
  assert.match(log, /"type":"context_fold"/); assert.match(log, /"reason":"idle"/); assert.match(log, /notes v1/, 'the journal keeps every copy');
  // Replay reproduces the projection.
  const { sessionFile } = f.session.snapshot(), last = f.session.snapshot().contextUsage; await f.session.dispose();
  const reopened = await f.create({ sessionFile });
  assert.deepEqual(reopened.snapshot().contextUsage, last);
  await reopened.prompt('Four.');
  assert.ok(!wire(f.requests.at(-1)).includes('notes v1'));
});

test('a prefix change and a compaction are cold breaks too; an append-only provider path never folds', async t => {
  let tools = [];
  const f = await fixture(t, { beforeRequest: () => ({ contextUpdates: [notes(`notes ${tools.length} `.repeat(100))], ...(tools.length ? { tools } : {}) }) });
  await f.session.prompt('One.'); await f.session.prompt('Two.');
  tools = [{ name: 'note', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }];
  await f.session.prompt('Three.');
  assert.ok(!wire(f.requests.at(-1)).includes('notes 0 '), 'the tools changed: the copy from before folds');
  const g = await fixture(t);
  g.send([notes('alpha '.repeat(100))]); await g.session.prompt('One.');
  g.send([notes('beta '.repeat(100))]); await g.session.prompt('Two.');
  await g.session.compact({ summary: 'Earlier turns summarized.', keepLastTurns: 1 });
  await g.session.prompt('Three.');
  assert.ok(!wire(g.requests.at(-1)).includes('alpha'), 'after a compaction the restored copy of a superseded key folds');
  const appendOnly = await fixture(t, { model: { ...model, appendOnly: true } });
  appendOnly.send([notes('first '.repeat(100))]); await appendOnly.session.prompt('One.');
  appendOnly.send([notes('second '.repeat(100))]); await appendOnly.session.prompt('Two.');
  appendOnly.advance(2 * HOUR); await appendOnly.session.prompt('Three.');
  assert.ok(wire(appendOnly.requests.at(-1)).includes('first '), 'history stays append-only');
});

test('A, B, A: the latest value is sent again and stays whole; only the copies before it fold', async t => {
  const f = await fixture(t);
  for (const value of ['AAAA', 'BBBB', 'AAAA']) { f.send([notes(value.repeat(50))]); await f.session.prompt(`Use ${value}.`); }
  f.advance(2 * HOUR); f.send([notes('AAAA'.repeat(50))]); await f.session.prompt('Again.');
  const messages = f.requests.at(-1).messages.filter(message => message.contextKey === 'project-notes');
  assert.equal(messages.length, 3, 'A was appended again after B (the model must see the current value last)');
  assert.deepEqual(messages.map(message => message.content.at(-1).text.includes('AAAA')), [false, false, true]);
});

test('turn-scoped notes fold after their turn and are never restored; window-scoped ones come back after a compaction', async t => {
  const f = await fixture(t);
  f.send([{ key: 'turn-route-hints', source: 'host-turn-routing', text: 'hint one', scope: 'turn' }, { key: 'collaboration:a', source: 'delivered-project-messages', text: 'entry A', scope: 'window' }]);
  await f.session.prompt('One.');
  f.send([{ key: 'turn-route-hints', source: 'host-turn-routing', text: 'hint one', scope: 'turn' }, { key: 'collaboration:a', source: 'delivered-project-messages', text: 'entry A', scope: 'window' }]);
  await f.session.prompt('Two.');
  let messages = f.requests.at(-1).messages.filter(message => message.contextKey === 'turn-route-hints');
  assert.equal(messages.length, 2, 'the same turn note is sent again in a new turn (deduplicated only within its turn)');
  assert.equal(f.requests.at(-1).messages.filter(message => message.contextKey === 'collaboration:a').length, 1, 'a window entry is deduplicated');
  f.advance(2 * HOUR); f.send([]); await f.session.prompt('Three.');
  messages = f.requests.at(-1).messages.filter(message => message.contextKey === 'turn-route-hints');
  assert.deepEqual(messages.map(message => message.content.at(-1).text), [superseded('turn-route-hints'), ended('turn-route-hints')], 'both turns ended: the earlier copy is superseded, the last one set aside without claiming a later copy');
  await f.session.compact({ summary: 'Summarized.', keepLastTurns: 1 });
  f.send([{ key: 'collaboration:a', source: 'delivered-project-messages', text: 'entry A', scope: 'window' }]);
  await f.session.prompt('Four.');
  const after = f.requests.at(-1).messages;
  assert.equal(after.filter(message => message.contextKey === 'turn-route-hints').length, 0, 'turn notes are not restored after a compaction');
  assert.equal(after.filter(message => message.contextKey === 'collaboration:a').length, 1, 'the window entry was offered again and appended');
  assert.ok(JSON.stringify(after.find(message => message.contextKey === 'collaboration:a')).includes('entry A'));
});

test('foldTargets: visible superseded copies and earlier turns\' notes; never the latest copy', () => {
  const ctx = (id, key, text, extra = {}) => ({ id, role: 'user', source: 'context', content: [{ type: 'text', text: 'lead' }], context: [{ source: 'host', text }], contextKey: key, ...extra });
  const user = id => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: id }] });
  const messages = [user('u1'), ctx('a1', 'a', 'x'), ctx('t1', 't', 'y', { contextScope: 'turn' }), user('u2'), ctx('a2', 'a', 'z'), ctx('t2', 't', 'w', { contextScope: 'turn' })];
  assert.deepEqual(foldTargets(messages), [{ messageId: 'a1', contextKey: 'a', kind: 'superseded' }, { messageId: 't1', contextKey: 't', kind: 'superseded' }]);
  assert.deepEqual(foldTargets(messages, { folded: new Map([['a1', {}]]) }).map(row => row.messageId), ['t1']);
  assert.deepEqual(foldTargets([...messages.slice(0, 3), user('u2')]).map(row => [row.messageId, row.kind]), [['t1', 'turn']]);
});

// FOLD-1: a sliding list (the pre-0.66 collaboration window, the undo notices) is not one value revised: each copy
// carries entries of its own. When its latest copy declares `accumulates`, earlier copies stay in summary records and
// are never folded as superseded; a fold committed before the declaration keeps its line (the projection never
// changes because of a later copy).
test('copies of an accumulating key stay in summary records and are not folded as superseded', async t => {
  const { supersededContextIds, accumulatingKeys } = await import('../src/context.mjs');
  const list = (text, extra = {}) => ({ key: 'project-collaboration', source: 'delivered-project-messages', text, ...extra });
  const f = await fixture(t);
  f.send([list('ANSWER one: keep the magic system rules'), notes('notes v1')]); await f.session.prompt('One.');
  f.send([list('ANSWER two'), notes('notes v2')]); await f.session.prompt('Two.');
  f.advance(2 * HOUR); f.send([list('{"moved":["project-collaboration:<id>"]}', { accumulates: true }), notes('notes v3')]); await f.session.prompt('Three.');
  const sent = wire(f.requests.at(-1));
  assert.ok(sent.includes('ANSWER one') && sent.includes('ANSWER two'), 'the earlier list copies stay whole at the cold break');
  assert.ok(!sent.includes('notes v1') && !sent.includes('notes v2'), 'an ordinary key still folds');
  const messages = f.session.snapshot().messages;
  assert.deepEqual([...accumulatingKeys(messages)], ['project-collaboration']);
  const ids = supersededContextIds(messages), copies = messages.filter(message => message.contextKey === 'project-collaboration');
  assert.equal(copies.some(message => ids.has(message.id)), false, 'no list copy is left out of a summary record');
  assert.equal(messages.filter(message => message.contextKey === 'project-notes' && ids.has(message.id)).length, 2);
  // The summary record of a compaction carries both answers. ANSWER two is the newest archived copy and is restored
  // verbatim after the boundary, but a copy of an accumulating key stays in the record anyway: the tombstone that
  // follows it does not repeat it, and the next compaction restores the tombstone instead.
  const plan = f.session.prepareCompaction({ keepUserTurns: 1 });
  assert.match(plan.request.messages[0].content[0].text, /ANSWER one/); assert.match(plan.request.messages[0].content[0].text, /ANSWER two/);
  assert.doesNotMatch(plan.request.messages[0].content[0].text, /notes v1/);
  // The same text with the declaration is a new revision (appended once), so an old conversation gets it.
  const g = await fixture(t, { sessionId: 'fold-declare' });
  g.send([list('settled')]); await g.session.prompt('One.');
  g.send([list('settled', { accumulates: true })]); await g.session.prompt('Two.');
  g.send([list('settled', { accumulates: true })]); await g.session.prompt('Three.');
  assert.deepEqual(g.session.snapshot().messages.filter(message => message.contextKey === 'project-collaboration').map(message => message.contextAccumulates ?? false), [false, true]);
});

test('a fold committed before a key was declared accumulating keeps its line', async () => {
  const { prepareContext } = await import('../src/context.mjs');
  const ctx = (id, key, text, extra = {}) => ({ id, role: 'user', source: 'context', content: [{ type: 'text', text: 'lead' }], context: [{ source: 'host', text }], contextKey: key, ...extra });
  const user = id => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: id }] });
  const messages = [user('u1'), ctx('l1', 'list', 'one'), user('u2'), ctx('l2', 'list', 'two'), user('u3'), ctx('l3', 'list', 'three', { contextAccumulates: true })];
  assert.deepEqual(foldTargets(messages), [], 'no new superseded target for an accumulating key');
  assert.deepEqual(foldTargets(messages.slice(0, 4)).map(row => row.messageId), ['l1'], 'before the declaration it was an ordinary key');
  const folded = new Map([['l1', { contextKey: 'list', kind: 'superseded', seq: 1 }]]);
  const project = rows => JSON.stringify(prepareContext({ messages: rows, folded, forgetSeq: 1 }).messages.find(message => message.id === 'l1'));
  assert.equal(project(messages), project(messages.slice(0, 4)), 'the committed fold renders the same after the declaration');
  assert.match(project(messages), /Superseded/);
});
