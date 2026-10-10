import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { runDelegatedAgent } from '../src/agent-delegation.mjs';

test('a real child with a failed final check cannot be reused as a completed result', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-child-finish-'));
  t.after(() => rm(dir, { recursive: true, force: true })); let requests = 0, checks = 0;
  const args = { role: 'reviewer', task: 'Review artifact.', sessionId: 'child', signal: new AbortController().signal,
    createChild: async options => createSession({ ...options, projectId: 'project', stateDir: join(dir, 'state'), cwd: dir,
      model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 },
      provider: async function* () { requests++; yield { type: 'text_delta', delta: 'Unchecked candidate answer.' }; yield { type: 'done' }; },
      beforeFinish: () => { checks++; throw Object.assign(new Error('checker unavailable'), { code: 'checker_failed' }); } }) };
  await assert.rejects(runDelegatedAgent(args), { code: 'checker_failed' });
  await assert.rejects(runDelegatedAgent(args), { code: 'delegation_unresolved' });
  assert.equal(requests, 1); assert.equal(checks, 1);
});

test('delegation result validation rejects a host adapter that returns with pending finish review', async () => {
  let prompted = false, disposed = false;
  const snapshot = () => ({ tools: [], messages: prompted ? [{ role: 'assistant', content: [{ type: 'text', text: 'draft' }], stopReason: 'stop' }] : [], recovery: { uncertainTools: [], pendingTools: 0, pendingFinish: prompted }, usage: { totalTokens: 0 } });
  await assert.rejects(runDelegatedAgent({ role: 'reviewer', task: 'Review artifact.', sessionId: 'child', signal: new AbortController().signal,
    createChild: async () => ({ snapshot, prompt: async () => { prompted = true; }, abort: async () => {}, dispose: async () => { disposed = true; } }) }), { code: 'delegation_incomplete' });
  assert.equal(disposed, true);
});
