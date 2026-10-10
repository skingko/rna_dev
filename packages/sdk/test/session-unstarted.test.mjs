import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { openJournal } from '../src/journal.mjs';
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 32000, maxOutputTokens: 1000 };
async function fixture(t, started = false) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-unstarted-')), stateDir = join(dir, 'state'), sessionId = 'owner';
  const journal = openJournal({ stateDir, sessionId });
  const calls = [{ type: 'toolCall', id: 'old-exec', name: 'project_exec', arguments: { command: 'must-not-run' } }, ...(started ? [{ type: 'toolCall', id: 'never-started', name: 'project_exec', arguments: { command: 'also-not-run' } }] : [])];
  journal.append('message', { message: { id: 'original-user', role: 'user', content: [{ type: 'text', text: 'Old task' }] } });
  journal.append('message', { message: { id: 'original-assistant', role: 'assistant', content: calls, stopReason: 'toolUse' } });
  if (started) journal.append('tool_intent', { callKey: 'original-assistant/old-exec', toolCallId: 'old-exec', toolName: 'project_exec', effect: 'write', idempotent: false });
  const sessionFile = journal.file; journal.close(); let executions = 0, requests = 0;
  const options = { sessionId, cwd: dir, stateDir, sessionFile, model, tools: [{ name: 'project_exec', effect: 'write', parameters: { type: 'object' }, execute: () => { executions++; assert.fail('Historical commands must not execute'); } }], provider: async function* (input) {
    requests++; const old = input.messages.findIndex(message => message.id === 'original-assistant'), result = input.messages.findIndex(message => message.role === 'toolResult' && message.toolCallId === 'old-exec'), next = input.messages.findIndex(message => message.role === 'user' && message.id !== 'original-user');
    assert.ok(old >= 0 && result > old && next > result); yield { type: 'text_delta', delta: 'New user task accepted' }; yield { type: 'done' };
  } };
  const handles = [], create = async () => { const handle = await createSession(options); handles.push(handle); return handle; };
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, stats: () => ({ requests, executions }) };
}
test('never-dispatched historical tool calls get durable cancelled results before a new user task, without executing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.session.prompt('New task'), { code: 'recovery_required' });
  assert.deepEqual(f.session.cancelUnstartedTools('The user started a new task.'), { cancelled: 1, pending: 0, uncertain: 0 });
  const result = f.session.snapshot().messages.at(-1); assert.equal(result.role, 'toolResult'); assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).neverStarted, true);
  assert.deepEqual(f.session.cancelUnstartedTools(), { cancelled: 0, pending: 0, uncertain: 0 }); await f.session.dispose();
  const reopened = await f.create(); assert.equal(reopened.snapshot().recovery.pendingTools, 0); await reopened.prompt('New task'); assert.deepEqual(f.stats(), { requests: 1, executions: 0 });
});
test('a durable started intent remains uncertain while only later unstarted calls are cancelled', async t => {
  const f = await fixture(t, true);
  assert.deepEqual(f.session.cancelUnstartedTools(), { cancelled: 1, pending: 1, uncertain: 1 });
  assert.equal(f.session.snapshot().recovery.uncertainTools[0].toolCallId, 'old-exec');
  await assert.rejects(f.session.prompt('New task'), { code: 'recovery_required' }); await assert.rejects(f.session.resume(), { code: 'uncertain_tool' });
  assert.deepEqual(f.stats(), { requests: 0, executions: 0 }); await f.session.dispose();
  const reopened = await f.create(); assert.deepEqual(reopened.cancelUnstartedTools(), { cancelled: 0, pending: 1, uncertain: 1 });
});
