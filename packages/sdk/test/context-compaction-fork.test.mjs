import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

// Spec p1 compaction TC-6 (measured option, off by default): with `compat.compactionFork`, an automatic summary
// reuses the conversation's cached prefix — same system, tools and projected messages — plus one host instruction
// naming where the summarized part ends. A tool call, an empty answer or an over-window request falls back once to
// the flattened record. Never for idle compaction, whose cache is cold anyway.
const base = { providerId: 'fork-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 30000, maxOutputTokens: 800, reasoning: 'off' };
const flattened = request => request.systemPrompt.startsWith('Summarize the provided');
const forked = request => request.purpose === 'compaction' && !flattened(request);

async function fixture(t, { model = base, chapter = 2400, fork = () => [{ type: 'text_delta', delta: 'Forked summary of the earlier chapters.' }] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-compaction-fork-')), requests = [];
  const provider = async function* (request) {
    requests.push(request);
    if (flattened(request)) yield { type: 'text_delta', delta: 'Flattened summary.' };
    else if (forked(request)) yield* fork(request);
    else yield { type: 'text_delta', delta: `Chapter ${'正文'.repeat(chapter)}` };
    yield { type: 'usage', usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'lookup', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }];
  const session = await createSession({ sessionId: 'compaction-fork', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, systemPrompt: 'You are the fork fixture.' });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { session, requests };
}
const run = async session => { for (let index = 1; index <= 6 && !session.snapshot().compaction; index++) await session.prompt(`Write chapter ${index}.`); };

test('off by default: automatic compaction sends the flattened record', async t => {
  const f = await fixture(t);
  await run(f.session);
  assert.ok(f.session.snapshot().compaction);
  assert.equal(f.requests.filter(forked).length, 0); assert.ok(f.requests.filter(flattened).length >= 1);
});

test('with compat.compactionFork the summary shares the conversation prefix and extends its messages', async t => {
  const f = await fixture(t, { model: { ...base, compat: { compactionFork: true } } });
  await run(f.session);
  const fork = f.requests.find(forked), previous = f.requests[f.requests.indexOf(fork) - 1];
  assert.ok(fork, 'the fork was used'); assert.equal(f.requests.filter(flattened).length, 0);
  assert.equal(fork.cache.prefixHash, previous.cache.prefixHash); assert.equal(fork.systemPrompt, previous.systemPrompt); assert.deepEqual(fork.tools, previous.tools);
  assert.ok(JSON.stringify(fork.messages).startsWith(JSON.stringify(previous.messages).slice(0, -1)), 'the conversation projection is a prefix of the fork request');
  assert.match(JSON.stringify(fork.messages.at(-1)), /up to and including the message that begins/);
  assert.equal(f.session.snapshot().compaction.summary, 'Forked summary of the earlier chapters.');
  assert.equal(f.session.snapshot().messages.some(message => String(message.id).startsWith('compaction-fork')), false, 'the instruction is request-only');
});

test('a tool call from the fork falls back once to the flattened record and is journaled', async t => {
  const f = await fixture(t, { model: { ...base, compat: { compactionFork: true } }, fork: () => [{ type: 'tool_call', id: 'x', name: 'lookup', arguments: {} }] });
  await run(f.session);
  assert.equal(f.requests.filter(forked).length, 1); assert.equal(f.requests.filter(flattened).length, 1);
  assert.equal(f.session.snapshot().compaction.summary, 'Flattened summary.');
  const rows = (await readFile(f.session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.type === 'compaction_fork_rejected').map(row => row.data.reason), ['tool_call']);
});

test('a fork that would not fit the window is not sent', async t => {
  const f = await fixture(t, { chapter: 5000, model: { ...base, maxOutputTokens: 12000, compat: { compactionFork: true } } });
  await run(f.session);
  assert.equal(f.requests.filter(forked).length, 0); assert.ok(f.requests.filter(flattened).length >= 1);
  const rows = (await readFile(f.session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.type === 'compaction_fork_rejected' && row.data.reason === 'window'));
});
