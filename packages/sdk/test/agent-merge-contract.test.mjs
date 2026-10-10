import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '../src/capabilities.mjs';
import { AGENT_MERGE_TOOL_NAME, AGENT_MERGE_ACTIONS, AGENT_MERGE_PARAMETERS, AGENT_MERGE_TEXT, DELEGATE_ISOLATION_TEXT, agentMergeTool } from '../src/agent-merge.mjs';

// agent_merge contract (worktree design 0.63 §4.1): fixed English, no project-specific words, and the host — not the
// model — names paths: `take` items are checked against the host's conflict list, never resolved here.

const valid = args => validateToolArguments(AGENT_MERGE_PARAMETERS, args);
const invalid = args => assert.throws(() => valid(args), error => error.code === 'invalid_arguments', JSON.stringify(args));

test('the schema takes one worker or change set and the five actions', () => {
  assert.equal(AGENT_MERGE_TOOL_NAME, 'agent_merge');
  assert.deepEqual(AGENT_MERGE_ACTIONS, ['merge', 'show', 'take', 'resolved', 'drop']);
  valid({ agentId: 'agent-1' });
  valid({ changeId: 'change-1', action: 'merge' });
  valid({ agentId: 'agent-1', action: 'show', path: 'src/a.js', page: 2 });
  valid({ agentId: 'agent-1', action: 'take', take: [{ path: 'img.png', side: 'incoming' }, { path: 'b.js', side: 'current' }] });
  valid({ agentId: 'agent-1', action: 'resolved' });
  valid({ agentId: 'agent-1', action: 'drop' });
  valid({});  // neither id: refused by the host (merge_unknown), not the schema
  invalid({ agentId: 'agent-1', changeId: 'change-1' });
  invalid({ agentId: 'agent-1', action: 'apply' });
  invalid({ agentId: 'agent-1', action: 'take', take: [{ path: 'a.js', side: 'theirs' }] });
  invalid({ agentId: 'agent-1', action: 'take', take: [] });
  invalid({ agentId: 'agent-1', action: 'take', take: [{ path: 'a.js', side: 'current', commit: 'abc' }] });
  invalid({ agentId: 'agent-1', commit: 'abc' });
  invalid({ agentId: 'agent-1', page: 0 });
});

test('the texts are fixed English and say how to settle a conflict', () => {
  for (const text of [AGENT_MERGE_TEXT, DELEGATE_ISOLATION_TEXT]) assert.match(text, /^[\x20-\x7e]+$/);
  assert.match(AGENT_MERGE_TEXT, /currentSha256 as expectedHash/);
  assert.match(AGENT_MERGE_TEXT, /\|\|\|\|\|\|\| is the common base/);
  assert.match(DELEGATE_ISOLATION_TEXT, /resolve with agent_merge/);
  assert.match(DELEGATE_ISOLATION_TEXT, /shared_root/);
  // The host merges by itself only a worker that finished while the turn runs or with continueAfter (2026-10-05).
  assert.match(DELEGATE_ISOLATION_TEXT, /When it finishes while this turn runs \(or with continueAfter\), the host merges/);
  assert.match(DELEGATE_ISOLATION_TEXT, /a worker that did not finish, or that finished after this turn without continueAfter, wait for your agent_merge/);
  assert.match(AGENT_MERGE_TEXT, /When a worker finishes while your turn runs, the host merges/);
  assert.match(AGENT_MERGE_TEXT, /a worker the host did not merge \(it did not finish, it finished while no turn of yours was running, it was cancelled, or the project was read-only\)/);
});

test('the tool record forwards the call id and hands out its own copy of the schema', async () => {
  const calls = [], signal = new AbortController().signal;
  const tool = agentMergeTool(async (args, received) => { calls.push([args, received]); return { content: [{ type: 'text', text: '{}' }] }; });
  assert.deepEqual([tool.name, tool.permission, tool.effect, tool.idempotent], ['agent_merge', 'write', 'write', false]);
  assert.equal(tool.description, AGENT_MERGE_TEXT);
  await tool.execute('call-1', { agentId: 'agent-1' }, signal);
  assert.deepEqual(calls, [[{ agentId: 'agent-1', callId: 'call-1' }, signal]]);
  tool.parameters.properties.extra = { type: 'string' };
  assert.equal(AGENT_MERGE_PARAMETERS.properties.extra, undefined);
  assert.notEqual(agentMergeTool(() => null).parameters, tool.parameters);
  assert.throws(() => agentMergeTool(), TypeError);
});
