import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { buildRequest } from '../src/providers.mjs';
import { prepareContext } from '../src/context.mjs';
import { MAX_IMAGE_BYTES, validateMessageImages } from '../src/images.mjs';
import { applyImageOffload, originalImageTargets, planHistoryImages, planImageOffload, projectImageOffloads, retainedOffloads } from '../src/image-offload.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eZkAAAAASUVORK5CYII=' };
const model = { providerId: 'fixture', modelId: 'vision', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', input: ['text', 'image'], contextWindow: 1000000, maxOutputTokens: 256 };
const text = (id, role = 'assistant', extra = {}) => ({ id, role, content: [{ type: 'text', text: id }], ...extra });
const pixels = (id, role = 'toolResult', count = 1) => ({ id, role, content: Array.from({ length: count }, () => ({ ...image })) });
const pictures = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
const largeImage = bytes => { const buffer = Buffer.alloc(bytes); Buffer.from(image.data, 'base64').copy(buffer); return { ...image, data: buffer.toString('base64') }; };

for (const protocol of ['openai', 'anthropic']) test(`${protocol}: cumulative screenshots offload durably before dispatch, reopen preserves pixels and never replays completed tools`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-offload-')); const handles = [], events = [], requests = []; let executions = 0, interrupt = true;
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  const options = { sessionId: 'same', stateDir: dir, cwd: dir, model: { ...model, protocol }, autoCompaction: false,
    tools: [{ name: 'capture', effect: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute() { executions++; return { content: [image] }; } }],
    onEvent(event) { if (event.type === 'image_offload') events.push(event); },
    beforeCompletion({ snapshot }) { if (interrupt && snapshot.contextUsage.offloadedImages > 0) throw Object.assign(new Error('Fixture stop after durable offload and before request admission'), { code: 'fixture_pause' }); },
    provider: async function* (request) {
      const body = buildRequest(request).body; requests.push({ request: structuredClone(request.messages), body });
      assert.ok(pictures(request.messages).length <= 16); assert.equal(request.messages[0].content[1].data, image.data, 'latest user reference is protected even when older screenshots are removed');
      if (executions < 16) yield { type: 'tool_call', id: `capture-${executions}`, name: 'capture', arguments: {} };
      else yield { type: 'text_delta', delta: 'Inspected newest screenshot.' };
      yield { type: 'done' };
    } };
  let s = await createSession(options); handles.push(s);
  await assert.rejects(s.prompt('Compare screenshots against my reference.', { images: [image] }), { code: 'fixture_pause' });
  assert.equal(executions, 16); assert.equal(events.length, 1);
  const snapshot = s.snapshot(), beforeFile = await readFile(snapshot.sessionFile, 'utf8'), records = beforeFile.trim().split('\n').map(JSON.parse);
  const original = snapshot.messages, receipt = records.find(row => row.type === 'image_offload').data;
  assert.equal(pictures(original).length, 17, 'raw history retains every image');
  assert.equal(receipt.before.count, 17); assert.equal(receipt.after.count, 16);
  assert.equal(receipt.targets[0].messageId, original.find(message => message.role === 'toolResult').id);
  assert.equal(snapshot.recovery.pendingTools, 0); assert.equal(snapshot.recovery.uncertainTools.length, 0);
  const offloads = applyImageOffload(original, new Map(), receipt.targets);
  const expected = projectImageOffloads(original, offloads);
  assert.equal(expected.at(-1).content[0].data, image.data, 'newest unobserved screenshot remains in the next request');
  await s.dispose(); interrupt = false;
  s = await createSession({ ...options, sessionFile: snapshot.sessionFile }); handles.push(s);
  await s.resume();
  assert.equal(executions, 16, 'completed side effects are not replayed on recovery');
  assert.deepEqual(requests.at(-1).request, expected, 'reopening applies precisely the same durable projection');
  assert.equal(events.length, 1, 'reopening does not emit a second offload');
  assert.equal(pictures(s.snapshot().messages).length, 17);
  const afterFile = await readFile(snapshot.sessionFile, 'utf8'); assert.ok(afterFile.startsWith(beforeFile), 'original hash-chained journal bytes remain untouched');
  assert.equal(afterFile.trim().split('\n').map(JSON.parse).filter(row => row.type === 'tool_completed').length, 16);
  const finalBody = requests.at(-1).body;
  if (protocol === 'openai') assert.equal(finalBody.messages.filter(message => message.role === 'tool').length, 16, 'all original tool receipts remain paired');
  else assert.equal(finalBody.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result').length, 16);
  assert.match(JSON.stringify(finalBody), /Earlier image offloaded/);
  await s.dispose(); let summaries = 0, finalRequest;
  s = await createSession({ ...options, autoCompaction: true, model: { ...model, protocol, contextWindow: 64000 }, sessionFile: snapshot.sessionFile,
    provider: async function* (request) {
      if (request.systemPrompt.startsWith('Summarize')) {
        summaries++; await s.steer('Check the newest screenshot after compaction.');
        assert.equal(pictures(request.messages).length, 0); assert.ok(!JSON.stringify(request.messages).includes(image.data));
        yield { type: 'text_delta', delta: 'Earlier screenshots were inspected; the capture operations completed. Preserve the current screenshot checks.' };
      } else { finalRequest = request; buildRequest(request); yield { type: 'text_delta', delta: 'Newest screenshot checked.' }; }
      yield { type: 'done' };
    } }); handles.push(s);
  await s.prompt('Continue with a smaller context window.');
  assert.ok(summaries > 0); assert.match(JSON.stringify(finalRequest.messages), /Check the newest screenshot after compaction/);
  assert.ok(pictures(finalRequest.messages).length <= 16); assert.equal(events.length, 1, 'compaction and final steering admission never re-offload the same occurrence');
  assert.equal(executions, 16);
});

test('successive removals use original occurrence indexes even for repeated identical pixels; new user images stay protected', () => {
  const messages = [pixels('old-batch', 'toolResult', 16), text('observed'), pixels('latest-user', 'user'), text('last-observation'), pixels('new-tool')];
  const first = planImageOffload(messages, model); assert.deepEqual(first.targets, [{ messageId: 'old-batch', imageIndexes: [0, 1] }]);
  const once = applyImageOffload(messages, new Map(), first.targets);
  const more = [...messages, text('observed-new-tool'), pixels('reread')];
  const second = planImageOffload(projectImageOffloads(more, once), model);
  const targets = originalImageTargets(more, once, second.targets); assert.deepEqual(targets, [{ messageId: 'old-batch', imageIndexes: [2] }]);
  const twice = applyImageOffload(more, once, targets), projected = projectImageOffloads(more, twice);
  assert.equal(pictures(projected).length, 16); assert.equal(projected.find(message => message.id === 'latest-user').content[0].data, image.data);
  assert.equal(projected.at(-1).content[0].data, image.data, 're-reading a prior identical image creates a new retained occurrence');
  assert.throws(() => applyImageOffload(more, twice, targets), /repeated/);
  assert.throws(() => applyImageOffload(more, twice, [{ messageId: 'missing', imageIndexes: [0] }]), /message/);
  assert.throws(() => applyImageOffload(more, twice, [{ messageId: 'old-batch', imageIndexes: [15, 14] }]), /occurrence/);
});

test('fresh oversized batches and invalid/unsupported single images cannot be disguised by historical offload', async t => {
  assert.throws(() => planImageOffload([pixels('user', 'user', 17)], model), { code: 'image_limit' });
  assert.throws(() => planImageOffload([text('request-tools'), pixels('new-a', 'toolResult', 9), pixels('new-b', 'toolResult', 8)], model), { code: 'image_limit' });
  assert.throws(() => planImageOffload([{ ...pixels('too-large'), content: [largeImage(MAX_IMAGE_BYTES + 1)] }, text('observed')], model), { code: 'image_limit' });
  assert.throws(() => planImageOffload([{ ...pixels('too-large'), content: [largeImage(5 * 1024 * 1024 + 1)] }, text('observed')], { ...model, protocol: 'anthropic' }), { code: 'image_limit' });
  assert.throws(() => planImageOffload([pixels('old'), text('observed')], { ...model, input: ['text'] }), { code: 'image_not_supported' });
  const dir = await mkdtemp(join(tmpdir(), 'rna-fresh-images-')); let admitted = 0;
  const s = await createSession({ cwd: dir, stateDir: dir, model, beforeCompletion() { admitted++; }, provider: async function* () { throw new Error('Must not dispatch'); } });
  t.after(async () => { await s.dispose(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(s.prompt('Fresh batch', { images: Array(17).fill(image) }), { code: 'image_limit' });
  assert.equal(admitted, 0); assert.equal(s.snapshot().messages.length, 0);
  assert.equal((await readFile(s.snapshot().sessionFile, 'utf8')).includes('request_started'), false);
});

test('aggregate byte limits offload the minimum old occurrences without increasing transport limits', () => {
  const large = largeImage(2 * 1024 * 1024);
  const messages = Array.from({ length: 9 }, (_, i) => [{ id: `picture-${i}`, role: 'toolResult', content: [large] }, text(`observed-${i}`)]).flat();
  const plan = planImageOffload(messages, model); assert.equal(plan.before.bytes, 18 * 1024 * 1024); assert.equal(plan.after.bytes, 16 * 1024 * 1024); assert.equal(plan.targets.length, 1);
  const projected = projectImageOffloads(messages, applyImageOffload(messages, new Map(), plan.targets));
  assert.equal(validateMessageImages(projected, model).bytes, 16 * 1024 * 1024);
});

test('image projection invalidates old usage anchors while retaining stable cache prefixes and newer matching receipts', () => {
  const messages = [pixels('old'), text('usage', 'assistant', { model: model.modelId, provider: model.providerId, usageReported: true, usage: { input: 600000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 600020 } })];
  const base = { sessionId: 'stable', systemPrompt: 'Stable prompt', messages, model };
  const prefix = prepareContext(base).cache.prefixHash; messages[1].contextPrefixHash = prefix;
  const before = prepareContext(base); assert.ok(before.estimatedInputTokens >= 600020);
  const projected = { ...base, imageOffloadId: 'generation-1', imageOffloads: applyImageOffload(messages, new Map(), [{ messageId: 'old', imageIndexes: [0] }]) };
  const after = prepareContext(projected); assert.ok(after.estimatedInputTokens < 2000); assert.equal(after.cache.prefixHash, prefix); assert.equal(after.cache.sessionKey, before.cache.sessionKey);
  assert.deepEqual(prepareContext(projected), after, 'repeating projection cannot invalidate the cache again');
  messages.push(text('new-usage', 'assistant', { contextPrefixHash: prefix, contextImageOffloadId: 'generation-1', model: model.modelId, provider: model.providerId, usageReported: true, usage: { input: 3000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 3020 } }));
  assert.equal(prepareContext(projected).estimatedInputTokens, 3021, 'matching receipt plus the existing one-token empty-tail estimate');
  const compacted = prepareContext({ ...projected, compaction: { id: 'c', throughMessageId: 'usage', summary: 'Prior screenshot was observed.' } });
  assert.ok(!compacted.messages.some(message => message.id === 'old')); assert.equal(pictures(messages).length, 1);
});

test('observed history images become byte-stable text: all of them for text-only models, beyond the recent user turns for vision models', () => {
  const textOnly = { ...model, input: ['text'] }, user = (id, extra = []) => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: id }, ...extra] });
  const messages = [user('u1', [{ ...image }]), text('a1'), user('u2'), text('a2')];
  messages[1].content = [{ type: 'text', text: '  The   screenshot shows\na blue header. ' }];
  assert.equal(planHistoryImages(messages, model).size, 0, 'within the two most recent user turns a vision model keeps pixels');
  const history = planHistoryImages(messages, textOnly);
  assert.deepEqual([...history.get('u1')], [[1 - 1, { reason: 'history', excerpt: 'The screenshot shows a blue header.' }]]);
  const projected = projectImageOffloads(messages, new Map(), history), again = projectImageOffloads(structuredClone(messages), new Map(), planHistoryImages(structuredClone(messages), textOnly));
  assert.equal(pictures(projected).length, 0); assert.deepEqual(projected, again); assert.equal(pictures(messages).length, 1, 'the source history is not modified');
  assert.match(projected[0].content[1].text, /^\[Earlier image omitted from this request: image\/png; 68 bytes; sha256:[0-9a-f]{16}\. .*"The screenshot shows a blue header\."/);
  messages.push(user('u3'), text('a3'));
  assert.deepEqual([...planHistoryImages(messages, model).keys()], ['u1'], 'a vision model stops resending it after two newer user turns');
  assert.equal(projectImageOffloads(messages, new Map(), planHistoryImages(messages, model))[0].content[1].text, projected[0].content[1].text, 'the same text for every model');
  // Unobserved: tool pixels become an explicit non-inspection notice; user pixels stay for the capability error.
  const pending = [...messages, text('a4', 'assistant'), pixels('tool-new'), user('u4', [{ ...image }])];
  const marks = planHistoryImages(pending, textOnly);
  assert.equal(marks.get('tool-new').get(0).reason, 'unsupported'); assert.equal(marks.has('u4'), false);
  assert.throws(() => validateMessageImages(projectImageOffloads(pending, new Map(), marks), textOnly), { code: 'image_not_supported' });
  // Durable budget targets skip request-only placeholders.
  const retained = retainedOffloads(new Map([['u1', new Set()]]), marks);
  assert.deepEqual([...retained.get('u1')], [0]); assert.deepEqual([...retained.get('tool-new')], [0]);
});

test('context estimates trust provider usage over the byte heuristic, including after a prefix change, but not implausibly small receipts', () => {
  const chinese = '水墨跳跃平台笔锋蓄力'.repeat(3000);
  const assistant = usage => ({ id: 'a', role: 'assistant', content: [{ type: 'text', text: chinese }], model: model.modelId, provider: model.providerId, usageReported: true, contextCompactionId: null, contextImageOffloadId: null, usage });
  const base = { sessionId: 's', systemPrompt: 'v1', model, messages: [text('u', 'user'), assistant({ input: 20000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20010 })] };
  base.messages[1].contextPrefixHash = prepareContext(base).cache.prefixHash; const heuristic = prepareContext(base).heuristicTokens;
  const exact = prepareContext(base); assert.ok(heuristic > 25000); assert.ok(exact.estimatedInputTokens < 20100); assert.match(exact.estimateMethod, /^provider usage plus/);
  const released = prepareContext({ ...base, systemPrompt: 'v2 with a longer system prompt' });
  assert.ok(released.estimatedInputTokens < 20100); assert.match(released.estimateMethod, /earlier prefix or model/);
  assert.equal(prepareContext({ ...base, model: { ...model, providerId: 'other' } }).estimatedInputTokens, prepareContext({ ...base, model: { ...model, providerId: 'other' } }).heuristicTokens, 'another provider has no anchor');
  base.messages[1].usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
  assert.equal(prepareContext(base).estimatedInputTokens, prepareContext(base).heuristicTokens, 'an implausibly small receipt keeps the conservative estimate');
  assert.equal(prepareContext({ ...base, systemPrompt: 'v2' }).estimatedInputTokens, prepareContext({ ...base, systemPrompt: 'v2' }).heuristicTokens);
});

test('planHistoryImages throughMessageId plans only up to that message; null or an unknown id flips nothing', () => {
  const messages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'look' }, { ...image }] }, text('a1'), text('u2', 'user'), text('a2'), text('u3', 'user'), text('a3'), text('u4', 'user')];
  assert.deepEqual([...planHistoryImages(messages, model).keys()], ['u1'], 'an observed image older than two user turns flips');
  assert.deepEqual([...planHistoryImages(messages, model, new Map(), { throughMessageId: 'a3' }).keys()], ['u1']);
  assert.deepEqual([...planHistoryImages(messages, model, new Map(), { throughMessageId: 'a2' }).keys()], [], 'within the window up to the floor it stays');
  assert.equal(planHistoryImages(messages, model, new Map(), { throughMessageId: null }).size, 0);
  assert.equal(planHistoryImages(messages, model, new Map(), { throughMessageId: 'missing' }).size, 0);
});
