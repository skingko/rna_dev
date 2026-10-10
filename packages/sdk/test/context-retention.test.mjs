import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareContext } from '../src/context.mjs';
import { createSession } from '../src/session.mjs';

const text = message => message.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const message = (id, role, value, extra = {}) => ({ id, role, content: [{ type: 'text', text: value }], ...extra });
const catalog = (id, key, value) => message(id, 'user', 'Updated reference catalog.', { source: 'context', contextKey: key, contextRevision: value, context: [{ source: 'capability-catalog', text: value }] });

test('compaction retains only the newest named host contexts without restoring user text or broken tool groups', () => {
  const messages = [message('user-old', 'user', 'archived original request', { source: 'user' }), catalog('old-catalog', 'skills', 'obsolete'), catalog('old-project', 'project', 'old goal'), catalog('latest-catalog', 'skills', 'exact skill id'),
    message('call', 'assistant', '', { content: [{ type: 'toolCall', id: 'lookup', name: 'read', arguments: {} }] }), message('result', 'toolResult', 'archived result', { toolCallId: 'lookup', assistantId: 'call' }),
    message('new-user', 'user', 'current request', { source: 'user' }), catalog('new-project', 'project', 'new goal'), message('assistant', 'assistant', 'current answer')];
  const original = structuredClone(messages);
  const context = prepareContext({ sessionId: 'fixture', messages, compaction: { id: 'compact', throughMessageId: 'result', summary: 'old task summary, catalog intentionally omitted' } });
  // Freeze each key's latest value at the boundary. A later replacement must
  // stay appended instead of removing a previously cached prefix message.
  assert.deepEqual(context.messages.map(item => item.id), ['summary:compact', 'old-project', 'latest-catalog', 'new-user', 'new-project', 'assistant']);
  assert.match(text(context.messages[2]), /exact skill id/); assert.ok(!context.messages.some(item => text(item).includes('obsolete')));
  assert.deepEqual(messages, original, 'projection never mutates durable history');
  assert.ok(context.estimatedInputTokens > prepareContext({ sessionId: 'fixture', messages: context.messages.filter(item => !item.contextKey) }).estimatedInputTokens);
});

test('an explicit empty replacement catalog survives compaction and cannot resurrect its prior value', () => {
  const messages = [catalog('old', 'skills', 'secret-old-skill'), catalog('clear', 'skills', ''), message('answer', 'assistant', 'done'), message('user', 'user', 'next', { source: 'user' })];
  const context = prepareContext({ messages, compaction: { id: 'compact', throughMessageId: 'answer', summary: 'prior work' } });
  assert.deepEqual(context.messages.map(item => item.id), ['summary:compact', 'clear', 'user']); assert.ok(!JSON.stringify(context.messages).includes('secret-old-skill'));
});

test('manual compaction and reopened sessions preserve exact unchanged catalogs without redundant durable messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-context-retention-')), handles = [], requests = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  const options = { sessionId: 'fixture', projectId: 'project', cwd: dir, stateDir: join(dir, 'state'), model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 },
    beforeRequest: () => ({ contextUpdates: [{ key: 'skills', source: 'capability-catalog', text: 'exact_skill_23938' }, { key: 'project', source: 'project-planning-state', text: 'canonical user goal' }] }),
    provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'done' }; yield { type: 'done' }; } };
  let session = await createSession(options); handles.push(session);
  await session.prompt('one'); await session.prompt('two'); await session.prompt('three');
  const prefixHash = session.snapshot().cache.prefixHash, count = session.snapshot().messages.filter(item => item.contextKey).length;
  assert.equal((await session.compact({ summary: 'Prior conversation. Catalog values intentionally omitted.', keepLastTurns: 1 })).compacted, true);
  await session.prompt('four');
  assert.equal(requests.at(-1).messages.filter(item => item.contextKey === 'skills').length, 1);
  assert.match(text(requests.at(-1).messages.find(item => item.contextKey === 'skills')), /exact_skill_23938/);
  const saved = session.snapshot(); assert.equal(saved.messages.filter(item => item.contextKey).length, count); await session.dispose();
  session = await createSession({ ...options, sessionFile: saved.sessionFile }); handles.push(session);
  await session.prompt('five'); assert.equal(requests.at(-1).cache.prefixHash, prefixHash);
  assert.equal(requests.at(-1).messages.filter(item => item.contextKey === 'project').length, 1);
  assert.match(text(requests.at(-1).messages.find(item => item.contextKey === 'project')), /canonical user goal/);
  assert.equal(session.snapshot().messages.filter(item => item.contextKey).length, count);
});
