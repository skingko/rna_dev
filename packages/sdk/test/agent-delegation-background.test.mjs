import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { runDelegatedAgent, createDelegationTools, DELEGATION_TOOL_NAMES } from '../src/agent-delegation.mjs';
import { AGENT_MERGE_TEXT, AGENT_MERGE_PARAMETERS } from '../src/agent-merge.mjs';

test('spawn tools stay synchronous without control handlers; with them the async options, the four control tools and agent_merge are declared', async () => {
  const run = async () => ({ content: [] });
  const legacy = createDelegationTools(run);
  assert.deepEqual(legacy.map(tool => tool.name), ['agent_consult', 'agent_delegate']);
  assert.equal(legacy[0].parameters.properties.wait, undefined);
  assert.throws(() => createDelegationTools(run, { status() {} }), TypeError);
  const calls = [], control = Object.fromEntries(['status', 'message', 'wait', 'cancel', 'merge'].map(key => [key, async (args, signal) => { calls.push([key, args, signal instanceof AbortSignal]); return { content: [] }; }]));
  // Every handler is required: a host without agent_merge cannot declare the background set.
  assert.throws(() => createDelegationTools(run, { ...control, merge: undefined }), TypeError);
  const tools = createDelegationTools(run, control);
  assert.deepEqual(tools.map(tool => tool.name), DELEGATION_TOOL_NAMES);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), ['role', 'task', 'includeConversation', 'wait', 'continueAfter']);
  assert.deepEqual(Object.keys(tools[1].parameters.properties), ['task', 'files', 'includeConversation', 'wait', 'continueAfter']);
  assert.ok(tools.slice(2, 6).every(tool => tool.permission === 'read'), 'control never needs more than the parent read grant');
  // agent_merge writes the parent's files through the host: it needs the parent's write grant.
  const merge = tools.at(-1);
  assert.deepEqual([merge.name, merge.permission, merge.effect, merge.description], ['agent_merge', 'write', 'write', AGENT_MERGE_TEXT]);
  assert.deepEqual(merge.parameters, AGENT_MERGE_PARAMETERS);
  const signal = new AbortController().signal;
  for (const [name, args] of [['agent_status', {}], ['agent_message', { agentId: 'a', message: 'm' }], ['agent_wait', { timeoutSeconds: 5 }], ['agent_cancel', { agentId: 'a' }], ['agent_merge', { agentId: 'a', action: 'show', path: 'x.js' }]]) await tools.find(tool => tool.name === name).execute('call-1', args, signal);
  assert.deepEqual(calls.map(([key]) => key), ['status', 'message', 'wait', 'cancel', 'merge']);
  assert.equal(calls[1][1].callId, 'call-1'); assert.ok(calls.every(([, , hasSignal]) => hasSignal));
  assert.deepEqual(calls[4][1], { agentId: 'a', action: 'show', path: 'x.js', callId: 'call-1' }, 'agent_merge forwards its arguments and the call id');
  assert.ok(!legacy.some(tool => tool.name === 'agent_merge'), 'a synchronous host declares no agent_merge');
  assert.equal(DELEGATION_TOOL_NAMES.at(-1), 'agent_merge', 'children never get agent_merge either');
});

test('a steer accepted while the child runs is processed before its result; after the run it is refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-child-steer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release, control; const held = new Promise(resolve => { release = resolve; }), requests = [];
  const result = runDelegatedAgent({ role: 'scout', task: 'Inspect.', sessionId: 'child', signal: new AbortController().signal, onControl: value => { control = value; },
    createChild: async options => createSession({ ...options, projectId: 'project', stateDir: join(dir, 'state'), cwd: dir,
      model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 },
      provider: async function* ({ messages }) { requests.push(JSON.stringify(messages)); if (requests.length === 1) await held; yield { type: 'text_delta', delta: requests.length === 1 ? 'First look.' : 'Checked the config directory too.' }; yield { type: 'done' }; } }) });
  while (!control || !requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await control.steer('Also check the config directory.'); release();
  const output = await result;
  assert.equal(output.output, 'Checked the config directory too.'); assert.equal(requests.length, 2); assert.match(requests[1], /config directory/);
  await assert.rejects(control.steer('Late.'), { code: 'delegation_not_running' });
});
