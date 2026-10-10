import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { foldedContextText, revokeTargets, compactionSources, SUMMARY_WITHDRAWN_TEXT, compactionTainted } from '../src/context.mjs';

// C4 (reference alignment §2.1 P2.1): when the user takes the source of some context back — a deleted conversation, a
// withdrawn delivery, a changed privacy scope — the copies of that context fold to one line AT ONCE (`context_fold`,
// reason `revoked`), not at the next cold break and not after the thinking floor of an append-only target; the journal
// keeps them. Copies carry the opaque source ids the host attached (`sourceIds`), and a compaction record carries the
// ids of the copies it archived (`sourceIds`), so a later revocation can tell which summaries may restate a revoked source.
const model = { providerId: 'revoke-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 500, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const HOUR = 3600000;
const revoked = key => foldedContextText(key, 'revoked');

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-revoke-')), requests = [], handles = [], events = [];
  let now = Date.parse('2026-10-05T08:00:00Z'), updates = [], revoke;
  const provider = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; };
  const args = { sessionId: 'context-revoke', projectId: 'revoke-project', cwd: dir, stateDir: join(dir, 'state'), model, provider, clock: () => now, cacheSurvivalMs: HOUR, onEvent: event => events.push(event),
    beforeRequest: () => (updates.length || revoke ? { ...(updates.length ? { contextUpdates: updates } : {}), ...(revoke ? { revokeContext: revoke } : {}) } : undefined), ...options };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests, events, advance: ms => { now += ms; }, now: () => now, send: value => { updates = value; }, revoke: value => { revoke = value; } };
}
const wire = request => JSON.stringify(request.messages);
const notes = (text, extra = {}) => ({ key: 'project-notes', source: 'host-notes', text, ...extra });

test('a revocation folds the copies of its key at once, on a warm break, and the fresh copy of the key stays whole', async t => {
  const f = await fixture(t);
  f.send([notes('private alpha '.repeat(100))]); await f.session.prompt('One.');
  f.send([notes('private beta '.repeat(100))]); await f.session.prompt('Two.');
  assert.ok(wire(f.requests.at(-1)).includes('private alpha'), 'warm: nothing folds without a revocation');
  f.advance(1000); f.revoke([{ id: 'r1', contextKeys: ['project-notes'], before: f.now() }]); f.advance(1000);
  f.send([notes('clean gamma '.repeat(100))]); await f.session.prompt('Three.');
  const sent = wire(f.requests.at(-1));
  assert.ok(!sent.includes('private alpha') && !sent.includes('private beta'), 'both copies are gone from the request');
  assert.equal(sent.split(revoked('project-notes').replace(/"/g, '\\"')).length - 1, 2, 'each is one line');
  assert.ok(sent.includes('clean gamma'), 'the fresh copy made after the revocation is whole');
  const log = await readFile(f.session.snapshot().sessionFile, 'utf8');
  assert.match(log, /"type":"context_fold"/); assert.match(log, /"reason":"revoked"/); assert.match(log, /"kind":"revoked"/); assert.match(log, /private alpha/, 'the journal keeps every copy');
  const ack = f.events.find(event => event.type === 'context_revoke');
  assert.deepEqual([ack.ids, ack.folded, ack.transient], [['r1'], 2, true], 'the host is told which requests were handled, and how many copies folded');
  // Replay reproduces the projection, and the same revocation sent again changes nothing.
  const { sessionFile } = f.session.snapshot(), usageBefore = f.session.snapshot().contextUsage; await f.session.dispose();
  const reopened = await f.create({ sessionFile });
  assert.deepEqual(reopened.snapshot().contextUsage, usageBefore);
  await reopened.prompt('Four.');
  assert.ok(!wire(f.requests.at(-1)).includes('private alpha'));
  const folds = (await readFile(sessionFile, 'utf8')).split('\n').filter(line => line.includes('"type":"context_fold"') && line.includes('"targets"')).length;
  assert.equal(folds, 1, 'the revocation was applied once, not on every request');
});

test('a copy made after `before` is new material: the revoked key does not take it down', async t => {
  const f = await fixture(t);
  f.send([notes('before the revocation '.repeat(60))]); await f.session.prompt('One.');
  const cut = f.now(); f.advance(5000);
  f.send([notes('after the revocation '.repeat(60))]); await f.session.prompt('Two.');
  f.revoke([{ contextKeys: ['project-notes'], before: cut }]); f.send([]); await f.session.prompt('Three.');
  const sent = wire(f.requests.at(-1));
  assert.ok(!sent.includes('before the revocation'), 'the older copy folds');
  assert.ok(sent.includes('after the revocation'), 'the newer copy of the key stays');
});

test('copies carrying a revoked source id fold wherever their key, scope and order; the others stay', async t => {
  const f = await fixture(t);
  f.send([{ key: 'project-collaboration:a', source: 'delivered-project-messages', scope: 'window', text: 'delivered text A '.repeat(80), sourceIds: ['message:a', 'action:x'] },
    { key: 'project-collaboration:b', source: 'delivered-project-messages', scope: 'window', text: 'delivered text B '.repeat(80), sourceIds: ['message:b'] },
    { key: 'turn-note', source: 'host-notes', scope: 'turn', text: 'a turn note '.repeat(80), sourceIds: ['action:x'] }]);
  await f.session.prompt('One.');
  f.revoke([{ sourceIds: ['action:x'] }]); f.send([]); await f.session.prompt('Two.');
  const sent = wire(f.requests.at(-1));
  assert.ok(!sent.includes('delivered text A') && !sent.includes('a turn note'), 'both copies from the revoked action fold, a window and a turn copy alike');
  assert.ok(sent.includes('delivered text B'), 'a copy from another source stays');
  assert.ok(sent.includes(revoked('project-collaboration:a').replace(/"/g, '\\"')));
});

// (An append-only Claude target — a revocation does not wait for the thinking floor and rides its own rebase — is in context-revoke-anthropic.test.mjs.)

test('a revocation that matches nothing journals nothing; an invalid one is refused', async t => {
  const f = await fixture(t);
  f.send([notes('plain '.repeat(40))]); await f.session.prompt('One.');
  f.revoke([{ id: 'none', contextKeys: ['not-a-key'], sourceIds: ['message:none'] }]); f.send([]); await f.session.prompt('Two.');
  const log = await readFile(f.session.snapshot().sessionFile, 'utf8');
  assert.doesNotMatch(log, /"type":"context_fold"/);
  assert.deepEqual(f.events.find(event => event.type === 'context_revoke')?.folded, 0);
  f.revoke([{ id: 'bad' }]);
  await assert.rejects(f.session.prompt('Three.'), error => error.code === 'invalid_context');
});

test('revokeTargets and the compaction record: sources of the copies a summary archives are recorded, and chain', async t => {
  const messages = [{ id: 'm1', role: 'user', source: 'context', contextKey: 'k', context: [{ source: 's', text: 't' }], contextSources: ['message:a'], timestamp: 5 }, { id: 'm2', role: 'user', source: 'user', content: 'hi' },
    { id: 'm3', role: 'user', source: 'context', contextKey: 'k', context: [{ source: 's', text: 't2' }], contextSources: ['message:b'], timestamp: 9 }];
  assert.deepEqual(revokeTargets(messages, { sourceIds: ['message:a'] }).map(row => row.messageId), ['m1']);
  assert.deepEqual(revokeTargets(messages, { contextKeys: ['k'], before: 6 }).map(row => row.messageId), ['m1'], 'a copy made after `before` is not targeted');
  assert.deepEqual(revokeTargets(messages, { contextKeys: ['k'], folded: new Map([['m1', { kind: 'revoked' }]]) }).map(row => row.messageId), ['m3'], 'copies already folded as revoked are skipped');
  assert.deepEqual(revokeTargets(messages, {}), []);
  assert.deepEqual(compactionSources(messages, { throughMessageId: 'm2' }), { sourceIds: ['message:a'] });
  assert.deepEqual(compactionSources(messages, { previous: { throughMessageId: 'm2', sourceIds: ['message:a'] }, throughMessageId: 'm3' }), { sourceIds: ['message:a', 'message:b'] }, 'a later record merges the earlier one');
  assert.deepEqual(compactionSources([{ id: 'x', role: 'user', content: 'hi' }], { throughMessageId: 'x' }), {}, 'nothing archived with a source, nothing recorded');

  const f = await fixture(t);
  f.send([notes('with sources '.repeat(40), { sourceIds: ['session:s1', 'message:m9'] })]); await f.session.prompt('One.');
  await f.session.prompt('Two.'); await f.session.prompt('Three.');
  await f.session.compact({ summary: 'Earlier turns summarized.', keepLastTurns: 1 });
  const record = f.session.snapshot().compaction ?? f.session.snapshot().compactions?.at(-1);
  assert.deepEqual(record?.sourceIds, ['message:m9', 'session:s1'], 'the compaction record carries the source ids it archived');
});

const prepared = (plan, summary) => ({ id: `idle-${plan.throughMessageId}`, sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary, archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'idle-request-1', usage, usageReported: true, model: plan.model, startedAt: 1, completedAt: 2, beforeTokens: plan.beforeTokens });
const discards = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'compaction_prepared_discarded').map(row => row.data.code);

test('a summary prepared while idle is discarded when it archives a revoked copy, and kept when the revoked copy is newer than it', async t => {
  const make = async late => {
    const f = await fixture(t);
    f.send([notes('private material '.repeat(60), { sourceIds: ['message:m9'] })]); await f.session.prompt('Write chapter 1.');
    f.send([]); for (const index of [2, 3, 4]) await f.session.prompt(`Write chapter ${index}.`);
    const plan = f.session.prepareCompaction({ keepUserTurns: 2 });
    assert.ok(plan, 'there is something to compact');
    const offer = prepared(plan, 'A short summary of the early chapters.');
    assert.equal(f.session.offerCompaction(offer), true);
    if (late) { f.send([{ key: 'late-notes', source: 'host-notes', text: 'late private material '.repeat(40), sourceIds: ['message:late'] }]); await f.session.prompt('Write chapter 5.'); f.send([]); }
    return { f, offer };
  };
  // The copy sits in the span the summary would archive: committing it later would bring the revoked material back.
  const inside = (await make()).f;
  inside.revoke([{ id: 'r1', sourceIds: ['message:m9'] }]); await inside.session.prompt('Write chapter 5.');
  assert.deepEqual(await discards(inside.session), ['revoked'], 'the prepared summary is thrown away, journaled');
  assert.equal(inside.session.snapshot().preparedCompaction, undefined);
  assert.equal(inside.events.find(event => event.type === 'context_revoke').folded, 1);
  // The revoked copy is newer than the span the summary archives: the summary is still valid for its base and stays offered.
  const { f: outside, offer } = await make(true);
  outside.revoke([{ id: 'r2', sourceIds: ['message:late'] }]); await outside.session.prompt('Write chapter 6.');
  assert.deepEqual(await discards(outside.session), [], 'a summary that archived nothing revoked is not touched');
  assert.equal(outside.session.snapshot().preparedCompaction?.id, offer.id);
});

test('the revocation acknowledgement lists the committed summaries that archived a revoked source', async t => {
  const f = await fixture(t);
  f.send([notes('with sources '.repeat(40), { sourceIds: ['session:s1', 'message:m9'] })]); await f.session.prompt('One.');
  await f.session.prompt('Two.'); await f.session.prompt('Three.');
  await f.session.compact({ summary: 'Earlier turns summarized.', keepLastTurns: 1 });
  const record = f.session.snapshot().compaction;
  f.revoke([{ id: 'r1', sourceIds: ['session:s1'] }, { id: 'r2', sourceIds: ['message:never-seen'] }]); await f.session.prompt('Four.');
  const ack = f.events.find(event => event.type === 'context_revoke');
  assert.deepEqual(ack.ids, ['r1', 'r2']);
  assert.deepEqual(ack.summaries, [record.id], 'the summary that may restate the revoked source is reported, once');
  assert.deepEqual(ack.withdrawn, [record.id], 'and, being the one in force, withdrawn');
});

test('a committed summary that archived a revoked source is withdrawn: the model reads a notice in its place, the journal keeps both records, replay agrees, and an unrelated revocation leaves it alone', async t => {
  const f = await fixture(t);
  f.send([notes('delivered finding '.repeat(30), { key: 'project-collaboration:f1', scope: 'window', sourceIds: ['action:act-1', 'message:m1'] })]); await f.session.prompt('One.');
  f.send([]); await f.session.prompt('Two.'); await f.session.prompt('Three.');
  await f.session.compact({ summary: 'Earlier: the finding said the Qingdao archive is closed on Mondays.', keepLastTurns: 1 });
  const record = f.session.snapshot().compaction;
  await f.session.prompt('Four.');
  assert.ok(wire(f.requests.at(-1)).includes('Qingdao archive'), 'the summary stands while nothing is revoked');
  // A revocation of something else: the summary is untouched.
  f.revoke([{ id: 'other', sourceIds: ['action:somebody-else'] }]); await f.session.prompt('Five.');
  assert.ok(wire(f.requests.at(-1)).includes('Qingdao archive')); assert.equal(f.session.snapshot().compaction.id, record.id);
  assert.deepEqual(f.events.filter(event => event.type === 'context_revoke').at(-1).withdrawn, []);
  // The action's scope is revoked: the summary that archived its delivered finding is withdrawn at this request.
  f.revoke([{ id: 'privacy', sourceIds: ['action:act-1'] }]); await f.session.prompt('Six.');
  const sent = wire(f.requests.at(-1));
  assert.ok(!sent.includes('Qingdao archive'), 'the model no longer reads what the summary said'); assert.ok(sent.includes(SUMMARY_WITHDRAWN_TEXT.slice(0, 60)), 'it reads the notice');
  const now = f.session.snapshot().compaction;
  assert.notEqual(now.id, record.id); assert.deepEqual([now.trigger, now.withdrew, now.throughMessageId, now.sourceIds], ['revoked', record.id, record.throughMessageId, []], 'a record on the same boundary that lists no source');
  const ack = f.events.filter(event => event.type === 'context_revoke').at(-1);
  assert.deepEqual([ack.summaries, ack.withdrawn], [[record.id], [record.id]]);
  const { sessionFile } = f.session.snapshot(), log = await readFile(sessionFile, 'utf8');
  assert.ok(log.includes('Qingdao archive closed on Mondays') || log.includes('Qingdao archive'), 'the journal keeps the summary it withdrew');
  assert.equal(log.split('\n').filter(line => line.includes('"type":"context_compaction"')).length, 2, 'two compaction records: the summary and its withdrawal');
  // Replay: the same projection, and the same revocation sent again does nothing more.
  await f.session.dispose();
  const reopened = await f.create({ sessionFile });
  assert.equal(reopened.snapshot().compaction.id, now.id);
  f.revoke([{ id: 'privacy-again', sourceIds: ['action:act-1'] }]); await reopened.prompt('Seven.');
  assert.equal(reopened.snapshot().compaction.id, now.id, 'once');
  assert.ok(!wire(f.requests.at(-1)).includes('Qingdao archive'));
  // A later compaction starts from the notice, not from the withdrawn text: what it summarizes is only what is still in the conversation.
  await reopened.compact({ summary: 'Later checkpoint.', keepLastTurns: 1 });
  assert.deepEqual(reopened.snapshot().compaction.sourceIds, [], 'the copy before the withdrawn boundary is not scanned again (it is folded and in no summary the model reads)');
  assert.ok(!compactionTainted(reopened.snapshot().compaction, new Set(['action:act-1'])), 'so a second revocation of the same source finds nothing more to withdraw');
});

test('which compaction records may restate a revoked source: the ones that list it, and the ones whose list was cut', () => {
  const revoked = new Set(['action:a']);
  assert.equal(compactionTainted({ sourceIds: ['action:a', 'message:m'] }, revoked), true);
  assert.equal(compactionTainted({ sourceIds: ['action:b'] }, revoked), false);
  assert.equal(compactionTainted({ sourceIds: ['action:b'], sourceIdsTruncated: true }, revoked), true, 'a list that was cut cannot rule it out');
  assert.equal(compactionTainted({}, revoked), false, 'no record of sources: nothing to say'); assert.equal(compactionTainted({ sourceIds: ['action:a'] }, new Set()), false); assert.equal(compactionTainted(null, revoked), false);
});
