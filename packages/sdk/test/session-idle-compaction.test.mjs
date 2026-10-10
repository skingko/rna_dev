import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { generateSummary, MAX_SUMMARY_BYTES } from '../src/compaction-request.mjs';

// Spec p1 compaction §C and user decision 3: when a conversation has been idle past the provider's cache survival
// and holds over half of the context window, the host summarizes it in the background with no journal lock held,
// keeping the last two turns verbatim. The summary is committed only at a cold break, only on the base it was made
// from, and never makes a turn wait.
const model = { providerId: 'idle-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 200000, maxOutputTokens: 2000, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const HOUR = 3600000;
const isSummary = request => request.systemPrompt.startsWith('Summarize the provided');

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-idle-compaction-')), requests = [], handles = [];
  let now = Date.parse('2026-10-04T08:00:00Z');
  const provider = async function* (request) {
    requests.push(request);
    if (isSummary(request)) yield { type: 'text_delta', delta: 'Summary of the earlier chapters.' };
    else yield { type: 'text_delta', delta: `Chapter text ${'正文'.repeat(3000)}` };
    yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
  };
  const args = { sessionId: 'idle-compaction', projectId: 'idle-project', cwd: dir, stateDir: join(dir, 'state'), model, provider, clock: () => now, cacheSurvivalMs: 2 * HOUR, ...options };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests, provider, advance: ms => { now += ms; }, clock: () => now };
}
const turns = async (session, count, from = 1) => { for (let index = from; index < from + count; index++) await session.prompt(`Write chapter ${index}.`); };
/** What the host does with no lock held: plan, generate the summary, build the hand-over record. */
async function prepare(f, session, { summary } = {}) {
  const plan = session.prepareCompaction({ keepUserTurns: 2 });
  assert.ok(plan, 'there is something to compact');
  const result = summary !== undefined ? { summary, usage: { ...usage, totalTokens: 7 }, usageReported: true, requestId: 'idle-request-1', startedAt: f.clock(), completedAt: f.clock() }
    : await generateSummary({ provider: f.provider, model, request: plan.request, maxOutputTokens: plan.maxOutputTokens, ledger: { trigger: 'idle' } });
  const prepared = { id: `idle-${result.requestId}`, sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary: result.summary, archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: result.requestId, usage: result.usage, usageReported: result.usageReported, model: plan.model, startedAt: result.startedAt, completedAt: result.completedAt, beforeTokens: plan.beforeTokens };
  return { plan, prepared, file: `${session.snapshot().sessionFile}.idle-summary.json` };
}
const records = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const userTexts = request => request.messages.filter(message => message.role === 'user' && message.source === 'user').map(message => message.content[0].text);

test('a plan keeps the last two turns verbatim and writes nothing', async t => {
  const f = await fixture(t);
  await turns(f.session, 4);
  const file = f.session.snapshot().sessionFile, before = await readFile(file);
  const plan = f.session.prepareCompaction();
  assert.deepEqual(await readFile(file), before, 'journal bytes unchanged');
  const messages = f.session.snapshot().messages, through = messages.findIndex(message => message.id === plan.throughMessageId);
  assert.deepEqual(messages.slice(through + 1).filter(message => message.role === 'user').map(message => message.content[0].text), ['Write chapter 3.', 'Write chapter 4.']);
  assert.equal(plan.keepUserTurns, 2); assert.equal(plan.partial, false); assert.equal(plan.previousCompactionId, null);
  assert.ok(plan.floorTokens < plan.beforeTokens);
  assert.ok(plan.request.systemPrompt.startsWith('Summarize the provided')); assert.match(plan.request.messages[0].content[0].text, /Write chapter 1\./); assert.doesNotMatch(plan.request.messages[0].content[0].text, /Write chapter 3\./);
  assert.equal(f.session.prepareCompaction({ keepUserTurns: 4 }), null, 'nothing older than the kept turns');
});

test('generateSummary rejects tool calls, truncation and oversized summaries, and reports usage either way', async () => {
  const request = { systemPrompt: 'Summarize the provided record.', messages: [{ role: 'user', content: [{ type: 'text', text: 'record' }] }] };
  const run = events => generateSummary({ model, request, provider: async function* () { yield* events; } });
  await assert.rejects(run([{ type: 'tool_call', id: 'x', name: 'read', arguments: {} }]), { code: 'invalid_summary' });
  await assert.rejects(run([{ type: 'text_delta', delta: 'partial' }, { type: 'usage', usage }, { type: 'done', stopReason: 'length' }]), error => error.code === 'invalid_summary' && error.receipt.usage.totalTokens === 12 && error.receipt.usageReported);
  await assert.rejects(run([{ type: 'text_delta', delta: 'x'.repeat(MAX_SUMMARY_BYTES + 1) }]), { code: 'invalid_summary' });
  await assert.rejects(run([{ type: 'done', stopReason: 'stop' }]), { code: 'invalid_summary' });
  const ok = await run([{ type: 'text_delta', delta: 'Facts.' }, { type: 'usage', usage }, { type: 'done', stopReason: 'stop' }]);
  assert.equal(ok.summary, 'Facts.'); assert.equal(ok.usage.totalTokens, 12);
});

test('the sidecar is journaled at open and unlinked after, consumed once, committed at a cold break and never at a warm one', async t => {
  const f = await fixture(t);
  await turns(f.session, 4);
  const { prepared, file } = await prepare(f, f.session);
  assert.equal(f.requests.filter(isSummary).length, 1, 'generated outside the session');
  const { sessionFile } = f.session.snapshot(); await f.session.dispose();
  await writeFile(file, JSON.stringify(prepared), { mode: 0o600 });
  const first = await f.create({ sessionFile });
  assert.equal(existsSync(file), false, 'consumed at open');
  assert.equal(first.snapshot().preparedCompaction.id, prepared.id);
  assert.equal(first.snapshot().compaction, null, 'the projection is unchanged until a cold break');
  await first.dispose();
  // A crash between the append and the unlink leaves the same sidecar: the next open consumes it again harmlessly.
  await writeFile(file, JSON.stringify(prepared), { mode: 0o600 });
  const second = await f.create({ sessionFile });
  assert.equal((await records(second)).filter(row => row.type === 'compaction_prepared').length, 1, 'replay dedupes by id');
  const assistants = second.snapshot().messages.filter(message => message.role === 'assistant').length;
  assert.equal(second.snapshot().usage.totalTokens, assistants * 12 + 12, 'the idle summary request is counted once');
  // Warm: the next turn keeps the full history.
  f.advance(10 * 60000); await second.prompt('Write chapter 5.');
  assert.equal(second.snapshot().compaction, null);
  assert.deepEqual(userTexts(f.requests.at(-1)), ['Write chapter 1.', 'Write chapter 2.', 'Write chapter 3.', 'Write chapter 4.', 'Write chapter 5.']);
  // Cold: the first request after the idle gap carries the summary, the kept turns and the new one; no summary request.
  f.advance(3 * HOUR); await second.prompt('Write chapter 6.');
  assert.equal(second.snapshot().compaction.preparedId, prepared.id); assert.equal(second.snapshot().compaction.trigger, 'idle');
  assert.equal(f.requests.filter(isSummary).length, 1, 'no summary was generated on the turn path');
  const sent = f.requests.at(-1);
  assert.match(sent.messages[0].content[0].text, /Prior conversation summary[\s\S]*Summary of the earlier chapters\./);
  assert.deepEqual(userTexts(sent), ['Write chapter 3.', 'Write chapter 4.', 'Write chapter 5.', 'Write chapter 6.']);
  assert.ok((await records(second)).some(row => row.type === 'event' && row.data.type === 'context_economy' && row.data.preparedCommitted === true && row.data.reason === 'idle'));
});

test('a prepared summary is discarded on a stale base (rewind), a newer compaction (superseded) or when it would not shrink', async t => {
  // Stale: the user rewound into the archived range.
  const f = await fixture(t);
  await turns(f.session, 4);
  const stale = await prepare(f, f.session, { summary: 'A summary.' });
  assert.equal(f.session.offerCompaction(stale.prepared), true);
  await f.session.rewind(f.session.snapshot().messages.find(message => message.role === 'user' && message.content[0].text === 'Write chapter 2.').id);
  await turns(f.session, 1, 9);
  assert.deepEqual(f.session.commitPreparedCompaction(), { committed: false, code: 'stale_base' });
  assert.equal(f.session.snapshot().preparedCompaction, undefined);
  // Superseded: another compaction committed first.
  const g = await fixture(t);
  await turns(g.session, 4);
  const later = await prepare(g, g.session, { summary: 'B summary.' });
  g.session.offerCompaction(later.prepared);
  await g.session.compact({ summary: 'Manual summary.', keepLastTurns: 1 });
  assert.deepEqual(g.session.commitPreparedCompaction(), { committed: false, code: 'superseded' });
  // Not smaller: a summary longer than what it replaces.
  const h = await fixture(t);
  await turns(h.session, 4);
  const huge = await prepare(h, h.session, { summary: '冗长'.repeat(12000) });
  h.session.offerCompaction(huge.prepared);
  assert.deepEqual(h.session.commitPreparedCompaction(), { committed: false, code: 'not_smaller' });
  const discarded = (await records(h.session)).filter(row => row.type === 'compaction_prepared_discarded').map(row => row.data.code);
  assert.deepEqual(discarded, ['not_smaller']);
});

test('offered mid-run, the projection is unchanged; the deferred trigger then uses it with no summary request', async t => {
  let onRequest = null;
  const f = await fixture(t);
  const session = await f.create({ sessionId: 'idle-mid-run', provider: async function* (request) { onRequest?.(request); yield* f.provider(request); } });
  await turns(session, 3);
  const { prepared } = await prepare(f, session, { summary: 'Short summary.' });
  // Size the window so the fourth answer crosses the 80% (deferred) trigger but not the 90% one before it.
  const e3 = session.snapshot().contextUsage.estimatedInputTokens, perTurn = Math.ceil(e3 / 3), reserve = 1000;
  session.setModel({ ...model, maxOutputTokens: reserve, contextWindow: Math.ceil((e3 + perTurn / 2 + reserve) / 0.8) });
  f.requests.length = 0;
  let seen = null;
  onRequest = request => {
    if (isSummary(request) || seen) return;
    const before = session.snapshot().cache.estimatedInputTokens;
    seen = { offered: session.offerCompaction(prepared), unchanged: session.snapshot().cache.estimatedInputTokens === before && session.snapshot().compaction === null };
  };
  await session.prompt('Write chapter 4.');
  assert.deepEqual(seen, { offered: true, unchanged: true });
  assert.equal(f.requests.filter(isSummary).length, 0, 'the deferred trigger used the prepared summary: no summary request');
  assert.equal(session.snapshot().compaction?.preparedId, prepared.id);
  assert.ok(session.snapshot().contextUsage.estimatedInputTokens + reserve < session.snapshot().contextUsage.inputTrigger + reserve);
});

// Spec §10 integration: a novel-shaped conversation (keyed context revised every turn) after the idle gap — the first
// request carries the summary, the restored latest context, the kept turns and the new message; no superseded copy
// remains whole; no summary is generated on the turn path; the summary record leaves the superseded copies out.
test('after an idle compaction the cold request carries summary, latest context and kept turns, with no superseded copy whole', async t => {
  let revision = 0;
  const f = await fixture(t, { beforeRequest: () => ({ contextUpdates: [{ key: 'project-working-state', source: 'host-working-state', text: `state revision ${revision} ${'状态'.repeat(400)}` }] }) });
  for (let index = 1; index <= 5; index++) { revision = index; await f.session.prompt(`Write chapter ${index}.`); }
  const plan = f.session.prepareCompaction();
  const record = plan.request.messages[0].content[0].text;
  assert.equal((record.match(/state revision \d/g) ?? []).length, 0, 'every archived copy is superseded by a later one: none is in the summary record');
  const { prepared } = await prepare(f, f.session, { summary: 'Chapters one to three were written.' });
  f.session.offerCompaction(prepared);
  f.advance(3 * HOUR); revision = 6;
  const before = f.requests.length;
  await f.session.prompt('Write chapter 6.');
  const sent = f.requests[before], wire = JSON.stringify(sent.messages);
  assert.equal(f.requests.slice(before).filter(isSummary).length, 0);
  assert.match(sent.messages[0].content[0].text, /Chapters one to three were written\./);
  assert.deepEqual(userTexts(sent), ['Write chapter 4.', 'Write chapter 5.', 'Write chapter 6.']);
  assert.deepEqual((wire.match(/state revision (\d)/g) ?? []).map(text => text.at(-1)), ['6'], 'only the latest working state is whole');
  assert.match(wire, /Superseded: a later update of/);
});

// MC-1: the request hook runs before the economy point. A window-scoped entry the host saw as visible (so it offered
// nothing) can then fall behind the boundary of a summary committed inside the same request, where nothing restores
// it. The hook runs once more (`recheck: 'compaction'`) on the new projection, and the host offers it again.
test('a window-scoped entry hidden by a compaction committed inside the request is offered again before it is sent', async t => {
  const calls = [];
  // The host's rule (host-context-updates.mjs visibleContext/freshUpdates): offer the delivered entry while the model cannot see it.
  const hook = ({ snapshot, recheck }) => {
    calls.push(recheck ?? 'first');
    const boundary = snapshot.compaction ? snapshot.messages.findIndex(message => message.id === snapshot.compaction.throughMessageId) : -1;
    const at = snapshot.messages.findLastIndex(message => message.contextKey === 'project-collaboration:F1');
    return at > boundary ? undefined : { contextUpdates: [{ key: 'project-collaboration:F1', source: 'delivered-project-messages', scope: 'window', text: 'FINDING ONE: the user chose option B.' }] };
  };
  const f = await fixture(t, { beforeRequest: hook });
  await turns(f.session, 4);
  assert.equal(f.requests.filter(request => JSON.stringify(request.messages).includes('FINDING ONE')).length, 4, 'delivered in turn 1 and visible since');
  const { prepared } = await prepare(f, f.session, { summary: 'Chapters one and two were written.' });
  f.session.offerCompaction(prepared);
  f.advance(3 * HOUR); calls.length = 0;
  const before = f.requests.length;
  await f.session.prompt('Write chapter 5.');
  const sent = f.requests[before];
  assert.equal(f.session.snapshot().compaction?.preparedId, prepared.id, 'committed at this request\'s cold break');
  assert.match(JSON.stringify(sent.messages), /FINDING ONE/, 'the first request after the commit carries the entry');
  assert.deepEqual(calls, ['first', 'compaction'], 'the hook ran once more for the request that committed the summary');
  // A request with no compaction inside it runs the hook once.
  calls.length = 0;
  await f.session.prompt('Write chapter 6.');
  assert.deepEqual(calls, ['first']);
});
