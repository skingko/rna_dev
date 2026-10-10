import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareContext } from '../src/context.mjs';
import { buildRequest } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 1000 };
const message = (id, role, text, extra = {}) => ({ id, role, content: [{ type: 'text', text }], ...extra });
const catalog = (id, key, value) => message(id, 'user', 'Updated reference catalog.', { source: 'context', contextKey: key, context: [{ source: 'fixture', text: value }] });
const compact = { id: 'compact', throughMessageId: 'old-answer', summary: 'Frozen summary.' };
const wire = context => buildRequest({ model, ...context }).body;
const project = (messages, compaction = compact) => prepareContext({ sessionId: 'fixture', projectId: 'project', systemPrompt: 'Stable host instructions; use only currently declared tools.', messages, compaction, model });

test('appending a replacement after compaction preserves every prior wire-message byte with unchanged tools and system', () => {
  const messages = [catalog('old-context', 'project', 'first state'), message('old-answer', 'assistant', 'archived'), message('retained-user', 'user', 'current task'), message('retained-answer', 'assistant', 'current answer')];
  const before = project(messages), after = project([...messages, catalog('new-context', 'project', 'second state')]);
  const left = wire(before), right = wire(after);
  assert.equal(before.cache.prefixHash, after.cache.prefixHash); assert.equal(before.cache.sessionKey, after.cache.sessionKey);
  assert.deepEqual(after.messages.map(row => row.id), [...before.messages.map(row => row.id), 'new-context']);
  const prefixBytes = value => Buffer.from(value.messages.map(row => JSON.stringify(row)).join('\n'));
  const prior = prefixBytes(left), next = prefixBytes(right);
  assert.deepEqual(next.subarray(0, prior.length), prior);
  assert.deepEqual(left.tools, right.tools); assert.equal(left.messages[0].content, right.messages[0].content);
});

test('multiple named contexts retain boundary order while later values and new keys remain appended', () => {
  const messages = [message('old-user', 'user', 'do not restore'), catalog('skills-1', 'skills', 'obsolete'), catalog('project-1', 'project', 'project state'), catalog('skills-2', 'skills', 'current at boundary'),
    { id: 'old-call', role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] }, message('old-answer', 'toolResult', 'archived result', { assistantId: 'old-call', toolCallId: 'call' }),
    message('new-user', 'user', 'retained user task'), catalog('skills-3', 'skills', 'new skills'), catalog('browser-1', 'browser', 'new key'), catalog('project-2', 'project', 'new state')];
  const result = project(messages);
  assert.deepEqual(result.messages.map(row => row.id), ['summary:compact', 'project-1', 'skills-2', 'new-user', 'skills-3', 'browser-1', 'project-2']);
  assert.equal(result.messages.filter(row => row.id === 'new-user').length, 1);
  assert.ok(!result.messages.some(row => ['old-user', 'skills-1', 'old-call', 'old-answer'].includes(row.id)));
  assert.deepEqual(project(messages).messages, result.messages, 'projection is repeatable and does not reorder older attachments');
});

test('a new compaction advances the frozen context set including empty replacements without resurrecting archived values', () => {
  const messages = [catalog('skills-old', 'skills', 'retired skill source'), catalog('project-old', 'project', 'old plan'), message('old-answer', 'assistant', 'old answer'),
    catalog('skills-clear', 'skills', ''), catalog('project-new', 'project', 'current plan'), message('new-boundary', 'assistant', 'settled'), message('current-user', 'user', 'current task')];
  assert.deepEqual(project(messages).messages.map(row => row.id), ['summary:compact', 'skills-old', 'project-old', 'skills-clear', 'project-new', 'new-boundary', 'current-user']);
  const after = project(messages, { id: 'compact-next', throughMessageId: 'new-boundary', summary: 'Next frozen summary.' });
  assert.deepEqual(after.messages.map(row => row.id), ['summary:compact-next', 'skills-clear', 'project-new', 'current-user']);
  assert.equal(JSON.stringify(after.messages).includes('retired skill source'), false);
  assert.equal(JSON.stringify(after.messages).includes('old plan'), false);
});

test('durable reopen deduplicates appended replacements and keeps the compacted wire prefix until the next compaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-cache-context-')), handles = [], requests = []; let state = 'initial';
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(directory, { recursive: true, force: true }); });
  const options = { sessionId: 'fixture', projectId: 'project', stateDir: join(directory, 'state'), cwd: directory, model, autoCompaction: false,
    beforeRequest: () => ({ contextUpdates: [{ key: 'skills', source: 'capability-catalog', text: state }] }),
    provider: async function* (request) { requests.push(structuredClone({ systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, cache: request.cache })); yield { type: 'text_delta', delta: 'complete' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } };
  let session = await createSession(options); handles.push(session);
  await session.prompt('one'); await session.prompt('two'); await session.prompt('three');
  assert.equal((await session.compact({ summary: 'Prior settled tasks.', keepLastTurns: 1 })).compacted, true);
  await session.prompt('four'); const compactedRequest = wire(requests.at(-1));
  state = 'replacement'; await session.prompt('five'); const replacedRequest = wire(requests.at(-1));
  assert.deepEqual(replacedRequest.messages.slice(0, compactedRequest.messages.length), compactedRequest.messages);
  const saved = session.snapshot(), named = saved.messages.filter(row => row.contextKey === 'skills'); assert.equal(named.length, 2);
  await session.dispose(); session = await createSession({ ...options, sessionFile: saved.sessionFile }); handles.push(session);
  await session.prompt('six'); const resumed = wire(requests.at(-1));
  assert.deepEqual(resumed.messages.slice(0, replacedRequest.messages.length), replacedRequest.messages);
  assert.equal(session.snapshot().messages.filter(row => row.contextKey === 'skills').length, 2);
  assert.equal((await session.compact({ summary: 'New summary at a newer boundary.', keepLastTurns: 1 })).compacted, true);
  await session.prompt('seven'); const current = requests.at(-1).messages;
  assert.deepEqual(current.filter(row => row.contextKey === 'skills').map(row => row.id), [named[1].id]);
  assert.equal(requests.length, 7, 'local supplied compaction makes no hidden provider request');
});

test('an appended empty catalog cannot reauthorize a revoked tool retained only as historical context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-cache-revocation-')), requests = []; let revoked = false, attempted = false, executed = 0;
  const retired = { name: 'retired_tool', description: 'fixture write', effect: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { executed++; return 'must not execute after revocation'; } };
  const session = await createSession({ sessionId: 'fixture', projectId: 'project', cwd: directory, stateDir: join(directory, 'state'), model, tools: [retired], autoCompaction: false,
    beforeRequest: () => ({ tools: revoked ? [] : [retired], contextUpdates: [{ key: 'skills', source: 'capability-catalog', text: JSON.stringify({ skills: revoked ? [] : ['retired_tool'], instruction: 'This replaces the previous catalog. Only currently declared tools grant callable capability.' }) }] }),
    provider: async function* (request) {
      requests.push(request);
      if (revoked && !attempted) { attempted = true; assert.deepEqual(request.tools, []); yield { type: 'tool_call', id: 'retired-call', name: 'retired_tool', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { yield { type: 'text_delta', delta: 'complete' }; yield { type: 'done', stopReason: 'stop' }; }
    } });
  t.after(async () => { await session.dispose(); await rm(directory, { recursive: true, force: true }); });
  await session.prompt('one'); await session.prompt('two'); await session.prompt('three'); await session.compact({ summary: 'Prior settled work.', keepLastTurns: 1 });
  revoked = true; await session.prompt('check the current catalog');
  assert.equal(executed, 0); assert.equal(attempted, true);
  const latestContext = requests.at(-1).messages.findLast(row => row.contextKey === 'skills'), reference = latestContext.content.at(-1).text;
  const attachments = JSON.parse(reference.slice(reference.indexOf('\n') + 1)); assert.deepEqual(JSON.parse(attachments[0].text).skills, []);
  const receipt = session.snapshot().messages.find(row => row.role === 'toolResult' && row.toolCallId === 'retired-call');
  assert.equal(receipt.isError, true); assert.equal(receipt.content[0].text, 'Tool is not assigned to this session.');
  assert.ok(requests.slice(-2).every(row => row.tools.length === 0));
});
