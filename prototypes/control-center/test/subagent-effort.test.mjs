import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';

// spec p1 effort §3.4 (subagents): a delegated child's effort is chosen once (effort.work, origin delegated), within the
// turn route's budget, never above the turn's level, and set on its first request; the record keeps it. The routing
// setting never sends it (review EFF-4); `effortMayApply: () => true` stands for an RNA_JEV_MODES=effort.work=active trial.
function stream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Inspected; nothing else verified.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
async function setup(t, decisions) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-child-effort-')), calls = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; calls.push(JSON.parse(raw)); stream(res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(join(directory, 'private', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'GLM-like fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'child-fixture-secret', models: [{ id: 'glm-like', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['low', 'high', 'max'], compat: { thinkingFormat: 'zai' } }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'glm-like', reasoning: 'max' }, memory: { autoRecall: false, autoStore: false }, internalReasoning: { routing: 'route' } });
  const { session, project } = store.createProject({ name: 'Child effort fixture', workspace: directory, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  const service = new BuiltinAgentService(store, { decisions }), tools = service.createTools({ sessionId: session.id, turnId });
  const consult = () => tools.find(tool => tool.name === 'agent_consult').execute(`call-${Date.now()}`, { role: 'scout', task: 'Inspect the project evidence.', wait: true }, new AbortController().signal);
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { calls, current, consult };
}

test('under a trial, a delegated child runs at the routed effort and keeps it on its record', async t => {
  const asked = [];
  const f = await setup(t, { effortMayApply: () => true, internalEffort: async (_project, { purpose, plan, facts, task, apply }) => { asked.push({ purpose, facts, task, apply }); return { effort: plan.allowed[0], depth: 'light', source: 'jev', ledgerId: 'l1', applied: true }; } });
  const result = await f.consult();
  assert.equal(JSON.parse(result.content[0].text).status, 'completed');
  assert.equal(f.calls[0].reasoning_effort, 'low', 'the child request carries the routed effort');
  assert.deepEqual(asked.map(row => [row.purpose, row.facts.origin, row.apply]), [['work', 'delegated', true]]); assert.equal(asked[0].task, 'Inspect the project evidence.');
  const record = f.current().turns[0].delegations[0];
  assert.deepEqual(record.reasoning, { effective: 'low', source: 'jev', depth: 'light', ledgerId: 'l1' });
});

test('a judge that is slow or failing keeps the turn\'s own effort', async t => {
  const f = await setup(t, { effortMayApply: () => true, internalEffort: async () => { throw new Error('judge down'); } });
  await f.consult();
  assert.equal(f.calls[0].reasoning_effort, 'max');
  assert.equal(f.current().turns[0].delegations[0].reasoning.effective, 'max');
});

test('with routing on but no trial, a delegated child keeps the turn\'s effort and only records the verdict (review EFF-4)', async t => {
  const asked = [];
  const f = await setup(t, { effortMayApply: (purpose, { route = false } = {}) => route && purpose !== 'work', shadow: (_key, work) => { void work(); }, internalEffort: async (_project, { purpose, plan, apply }) => { asked.push({ purpose, apply }); return { effort: plan.allowed[0], depth: 'light', source: 'jev', ledgerId: 'l1', applied: false }; } });
  await f.consult();
  assert.equal(f.calls[0].reasoning_effort, 'max');
  assert.deepEqual(asked, [{ purpose: 'work', apply: false }]);
  assert.equal(f.current().turns[0].delegations[0].reasoning.source, 'fallback');
});
