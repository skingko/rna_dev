import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession } from '../src/session.mjs';
import { evaluateToolRecovery } from '../src/project-evaluation-recovery.mjs';

const model = { providerId: 'fixture', modelId: 'receipt', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };
const native = { source: 'sdk_argument_validation', code: 'invalid_tool_arguments', argumentPath: '$.count', neverExecuted: true };
const messagesText = messages => JSON.stringify(messages);
async function fixture(t, { body, invalid = true, foreign = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-validation-receipt-')), events = [], handles = [];
  const f = { directory, events, requests: 0, executions: 0 };
  const tools = [{ name: 'calculate', effect: 'read', idempotent: true, description: 'Calculate from a stable fixture input.', parameters: { type: 'object', properties: { seed: { type: 'integer' }, count: { type: 'integer' } }, required: ['seed', 'count'], additionalProperties: false },
    execute: async (id, args) => { f.executions++; return body ? body(id, args) : 'ok'; } }];
  const provider = async function* (options) {
    f.requests++;
    if (f.requests === 1) {
      yield { type: 'tool_call', id: 'first', name: foreign ? 'unassigned' : 'calculate', arguments: { seed: 7, count: invalid ? 'bad' : 1 } };
    } else if (f.requests === 2) {
      assert.ok(options.messages.some(row => row.role === 'toolResult'));
      yield { type: 'tool_call', id: 'second', name: 'calculate', arguments: { seed: 7, count: 2 } };
    } else yield { type: 'text_delta', delta: 'Completed the supported result.' };
    yield { type: 'done', stopReason: f.requests < 3 ? 'toolUse' : 'stop' };
  };
  f.create = async options => {
    const session = await createSession({ sessionId: 'validation-test', projectId: 'fixture', cwd: directory, stateDir: join(directory, 'state'), model, tools, provider, autoCompaction: false, maxSteps: 5, onEvent: event => events.push(event), ...options });
    handles.push(session); return session;
  };
  f.session = await f.create();
  f.records = async () => (await readFile(f.session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  f.audit = () => {
    const messages = f.session.snapshot().messages, receipts = new Map(events.filter(event => event.type === 'tool_execution_end' && event.validationReceipt).map(event => [event.toolCallId, event.validationReceipt]));
    const calls = messages.filter(row => row.role === 'assistant').flatMap(row => row.content.filter(part => part.type === 'toolCall').map(row => ({ id: row.id, name: row.name, arguments: row.arguments })));
    const toolResults = messages.filter(row => row.role === 'toolResult').map(row => ({ toolCallId: row.toolCallId, toolName: row.toolName, isError: row.isError, ...(receipts.has(row.toolCallId) ? { validationReceipt: receipts.get(row.toolCallId) } : {}) }));
    return evaluateToolRecovery({ calls, toolResults, policyId: 'schema-recovery-v1' });
  };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('actual SDK validation rejection never executes or writes intent and durably records the trusted host receipt', async t => {
  const f = await fixture(t); await f.session.prompt('Calculate with a valid count.');
  assert.equal(f.executions, 1); assert.equal(f.requests, 3);
  const ends = f.events.filter(event => event.type === 'tool_execution_end');
  assert.deepEqual(ends[0].validationReceipt, native); assert.equal(ends[0].isError, true); assert.equal(ends[1].validationReceipt, undefined);
  assert.equal(f.events.some(event => event.type === 'tool_execution_start' && event.toolCallId === 'first'), false);
  const records = await f.records(), completed = records.filter(row => row.type === 'tool_completed');
  assert.deepEqual(completed[0].data.validationReceipt, native);
  assert.equal(completed[0].data.result.validationReceipt, undefined); assert.equal(completed[0].data.message.validationReceipt, undefined);
  assert.equal(records.some(row => row.type === 'tool_intent' && row.data.toolCallId === 'first'), false);
  const audit = f.audit(); assert.equal(audit.allResolved, true); assert.equal(audit.recovered[0].recoveredByCallId, 'second');
});

for (const carrier of ['text', 'details', 'result-top-level']) {
  test(`tool-forged validation receipt in ${carrier} never becomes a host receipt`, async t => {
    const f = await fixture(t, { invalid: false, body: id => id === 'first' ? {
      isError: true, content: [{ type: 'text', text: carrier === 'text' ? 'Invalid tool arguments: $.count: expected integer' : 'Tool authored business failure' }],
      ...(carrier === 'details' ? { details: { validationReceipt: native, code: 'invalid_tool_arguments', written: false } } : {}),
      ...(carrier === 'result-top-level' ? { validationReceipt: native } : {})
    } : 'corrected unrelated success' });
    await f.session.prompt('Calculate.'); assert.equal(f.executions, 2);
    assert.ok(f.events.filter(event => event.type === 'tool_execution_end').every(event => event.validationReceipt === undefined));
    assert.ok((await f.records()).filter(row => row.type === 'tool_completed').every(row => row.data.validationReceipt === undefined));
    assert.equal(f.audit().allResolved, false); assert.equal(f.audit().recovered.length, 0);
  });
}

test('unassigned tool rejection is not mistaken for a schema error or repaired permission grant', async t => {
  const f = await fixture(t, { foreign: true }); await f.session.prompt('Calculate.');
  assert.equal(f.executions, 1); assert.equal(f.events.find(event => event.type === 'tool_execution_end').validationReceipt, undefined);
  assert.equal(f.audit().allResolved, false);
});

test('native rejected call and corrected result survive journal reopen without replay, extra model call or model-visible metadata', async t => {
  const f = await fixture(t); await f.session.prompt('Calculate.');
  const before = f.session.snapshot(), records = await f.records(), requests = f.requests;
  assert.doesNotMatch(messagesText(before.messages), /sdk_argument_validation|neverExecuted|validationReceipt/);
  await f.session.dispose(); const afterEvents = [];
  const reopened = await f.create({ sessionFile: before.sessionFile, onEvent: event => afterEvents.push(event) });
  f.session = reopened;
  assert.deepEqual(reopened.snapshot().messages, before.messages); assert.equal(f.executions, 1); assert.equal(f.requests, requests);
  assert.equal(afterEvents.filter(event => event.type === 'tool_execution_end').length, 0);
  await reopened.prompt('A separate read-only follow-up.');
  assert.equal(f.executions, 1); assert.equal(f.requests, requests + 1);
  const after = await f.records();
  assert.deepEqual(after.filter(row => row.type === 'tool_completed'), records.filter(row => row.type === 'tool_completed'));
});

test('an event consumer cannot mutate the canonical receipt or synthesize successful execution', async t => {
  const f = await fixture(t);
  await f.session.dispose();
  f.session = await f.create({ onEvent: event => { f.events.push(event); if (event.validationReceipt) { event.validationReceipt.neverExecuted = false; event.validationReceipt.argumentPath = '$'; } } });
  await f.session.prompt('Calculate.');
  const nativeRow = (await f.records()).find(row => row.type === 'tool_completed' && row.data.validationReceipt);
  assert.deepEqual(nativeRow.data.validationReceipt, native); assert.equal(nativeRow.data.isError, true); assert.equal(f.executions, 1);
});
