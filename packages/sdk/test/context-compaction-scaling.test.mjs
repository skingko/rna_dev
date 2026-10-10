import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticCompactionCandidate, summarySourceText } from '../src/context.mjs';
import { canonicalJSON, digest, openJournal } from '../src/journal.mjs';
import { imageTranscript } from '../src/images.mjs';
import { createSession } from '../src/session.mjs';

// Straightforward independent oracle: enumerate complete prefixes and measure
// the actual nested JSON wire string, rather than the optimized fragments.
function expected(messages, { previousCompaction, maxSourceTokens = Infinity, keepLastGroups = 2 } = {}) {
  const start = previousCompaction ? messages.findIndex(row => row.id === previousCompaction.throughMessageId) + 1 : 0;
  const pending = new Set(), cuts = [];
  for (let index = start; index < messages.length; index++) {
    const row = messages[index];
    if (row.role === 'assistant') for (const part of row.content ?? []) if (part.type === 'toolCall') pending.add(`${row.id}/${part.id}`);
    if (row.role === 'toolResult' || row.role === 'tool') {
      const suffix = `/${row.toolCallId ?? row.tool_call_id}`;
      pending.delete(row.assistantId ? `${row.assistantId}${suffix}` : [...pending].find(key => key.endsWith(suffix)));
    }
    if (!pending.size && ['assistant', 'toolResult', 'tool'].includes(row.role)) cuts.push(index + 1);
  }
  let chosen = null;
  for (const cut of cuts.slice(0, -keepLastGroups)) {
    const archived = messages.slice(start, cut);
    // The summary request's actual text (pi-style transcript), measured as the JSON string it is sent in.
    const sourceTokens = Math.ceil(Buffer.byteLength(JSON.stringify(summarySourceText({ previousSummary: previousCompaction?.summary ?? null, messages: archived }))) / 3);
    if (sourceTokens > maxSourceTokens) break;
    chosen = { archived: structuredClone(archived), remaining: structuredClone(messages.slice(cut)), throughMessageId: messages[cut - 1].id, sourceDigest: digest({ previousSummary: previousCompaction?.summary ?? null, messages: archived }), sourceTokens };
  }
  return chosen;
}

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSxkAAAAASUVORK5CYII=' };
function history() {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const text = `${i}: 证据🙂 \\ " \n \r \t \u0000 \ud800 ${'abc'.repeat(i)}`;
    rows.push({ id: `u${i}`, role: 'user', content: [{ type: 'text', text }, ...(i % 7 === 0 ? [image] : [])], ...(i % 3 === 0 ? { context: [{ source: 'fixture', text }], optional: undefined } : {}) });
    rows.push({ id: `a${i}`, role: 'assistant', content: [{ type: 'thinking', thinking: text }, { type: 'toolCall', id: 'one', name: 'read', arguments: { text } }, { type: 'toolCall', id: 'two', name: 'read', arguments: {} }] });
    rows.push({ id: `t${i}-2`, role: 'toolResult', assistantId: `a${i}`, toolCallId: 'two', content: [{ type: 'text', text }] });
    rows.push({ id: `t${i}-1`, role: 'tool', tool_call_id: 'one', content: [{ type: 'text', text }] });
  }
  return rows;
}

test('incremental compaction selection matches nested wire bytes, every boundary and original evidence hashes', () => {
  const messages = history(), before = canonicalJSON(messages);
  for (const previousCompaction of [undefined, { id: 'old', throughMessageId: 't9-1', summary: '已确认 "边界"\\\n🙂\ud800' }]) {
    for (const keepLastGroups of [1, 2, 6, 80]) {
      const full = expected(messages, { previousCompaction, keepLastGroups });
      const budgets = [0, 1, 400, 1000, 3000, Infinity, ...(full ? [full.sourceTokens - 1, full.sourceTokens, full.sourceTokens + 1] : [])];
      for (const maxSourceTokens of budgets) {
        const options = { previousCompaction, keepLastGroups, maxSourceTokens };
        assert.deepEqual(automaticCompactionCandidate(messages, options), expected(messages, options));
      }
    }
  }
  assert.equal(canonicalJSON(messages), before, 'candidate selection never mutates canonical history');
});

test('selected candidate remains detached and unfinished tool batches cannot enter its archive', () => {
  const messages = history();
  messages.push({ id: 'pending', role: 'assistant', content: [{ type: 'toolCall', id: 'unconfirmed', name: 'write', arguments: {} }] }, { id: 'late', role: 'user', content: [{ type: 'text', text: 'steering' }] });
  const before = canonicalJSON(messages), result = automaticCompactionCandidate(messages, { keepLastGroups: 1 });
  assert.equal(result.archived.some(row => row.id === 'pending'), false);
  assert.equal(result.remaining.some(row => row.id === 'pending'), true);
  result.archived[0].content[0].text = 'mutation'; result.remaining.at(-1).content[0].text = 'mutation';
  assert.equal(canonicalJSON(messages), before);
  assert.throws(() => automaticCompactionCandidate(messages, { previousCompaction: { throughMessageId: 'missing' } }), /boundary/);
});

test('single-pass snapshot redaction detaches messages, queue, compaction and uncertain arguments from durable state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-snapshot-detached-'));
  let session;
  t.after(async () => { await session?.dispose(); await rm(directory, { recursive: true, force: true }); });
  const journal = openJournal({ stateDir: directory, sessionId: 'snapshot' });
  journal.append('message', { message: { id: 'u', role: 'user', content: [{ type: 'text', text: 'original secret-12345678' }, image], context: [{ source: 'fixture', text: 'original reference' }] } });
  journal.append('message', { message: { id: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'write', arguments: { nested: { value: 'original' } } }] } });
  journal.append('tool_intent', { callKey: 'a/pending', assistantId: 'a', call: { id: 'pending', name: 'write', arguments: { nested: { value: 'original' } } }, effect: 'write', idempotent: false });
  journal.append('inbox_added', { item: { id: 'queued', target: 'followUp', text: 'original queued', metadata: { value: 1 } } });
  journal.append('context_compaction', { id: 'compact', throughMessageId: 'u', summary: 'original summary' });
  journal.close();
  const options = { cwd: directory, stateDir: directory, sessionId: 'snapshot', redactValues: ['secret-12345678'], model: { providerId: 'fixture', modelId: 'fixture' }, provider: async function* () { throw Error('unexpected model request'); } };
  session = await createSession(options);
  const before = session.snapshot(), expectedSnapshot = structuredClone(before), journalBytes = await readFile(journal.file);
  assert.match(before.messages[0].content[0].text, /\[REDACTED\]/);
  before.messages[0].content[0].text = 'changed'; before.messages[0].content[1].data = 'invalid'; before.messages[0].context[0].text = 'changed';
  before.messages[1].content[0].arguments.nested.value = 'changed'; before.queue.followUp[0].metadata.value = 2;
  before.compaction.summary = 'changed'; before.recovery.uncertainTools[0].arguments.nested.value = 'changed';
  assert.deepEqual(session.snapshot(), expectedSnapshot);
  assert.deepEqual(await readFile(journal.file), journalBytes, 'reading or mutating snapshots never appends a journal record');
});
