import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceSelectTemplate, combineEvidenceSelect, capabilityDisclosureTemplate, combineCapabilityDisclosure, lintDecisionTemplate } from '../../../packages/sdk/src/decision-templates.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { LearningCoordinator } from '../../../packages/sdk/src/learning.mjs';
import { CapabilityRegistry, mcpToolName } from '../../../packages/sdk/src/index.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

// Plan 2026-09-30 §9 D1: evidence.select (learning reviews see only episodes
// with something to learn from) and capability.disclosure (tool services a
// conversation clearly will not need stay behind the mcp loader). Judges are stubs.
const yes = { type: 'boolean', probability: .95 }, no = { type: 'boolean', probability: .03 }, unsure = { type: 'boolean', probability: .5 };

test('evidence.select and capability.disclosure templates pass the lint and combine by stake', () => {
  const evidence = evidenceSelectTemplate({ episodes: 3 }), disclosure = capabilityDisclosureTemplate({ services: 2 });
  assert.deepEqual(Object.keys(evidence.questions), ['signal_0', 'signal_1', 'signal_2']);
  assert.deepEqual(lintDecisionTemplate(evidence, { point: 'evidence.select' }), []);
  assert.deepEqual(lintDecisionTemplate(disclosure, { point: 'capability.disclosure' }), []);
  assert.deepEqual(combineEvidenceSelect({ signal_0: yes, signal_1: no, signal_2: unsure }, { episodes: 3 }), { signal: [0], quiet: [1] });
  // Only a confident "not needed" sets a service aside; doubt keeps it declared.
  assert.deepEqual(combineCapabilityDisclosure({ needed_0: no, needed_1: unsure }, { services: 2 }), { needed: [1], defer: [0] });
  const state = buildDecisionState('capability.disclosure', { request: '整理这周的笔记', services: [{ name: 'browser', description: 'Web automation', tools: ['open', 'click'] }], project: { title: 'Notes' } });
  assert.deepEqual(state.disclosure.services, [{ id: 'S0', name: 'browser', description: 'Web automation', tools: ['open', 'click'] }]);
});

test('routine learning episodes are settled unreviewed; the ones with a signal stay for the review', async () => {
  const coordinator = new LearningCoordinator({ review: async () => ({}), execute: async () => ({}) });
  const at = index => new Date(Date.UTC(2026, 8, 30, 1, index)).toISOString();
  const episodes = ['user corrected the tone', 'ran the build, it passed', 'renamed a file as asked'].map((summary, index) => ({ id: `e${index}`, fingerprint: `f${index}`, kind: index ? 'turn' : 'feedback', summary, at: at(index) }));
  await coordinator.ingest(episodes);
  const seen = [];
  const host = { decisions: { evidenceSelect: async (_project, input) => { seen.push(input.episodes.map(row => row.summary)); return { signal: [0], quiet: [1, 2] }; } }, project: () => ({ id: 'p', name: 'P' }), valid: () => true };
  const context = { coordinator, judgeAbort: new AbortController() };
  const dismissed = await ProjectLearningController.prototype.selectEvidence.call(host, context, 'p', coordinator.snapshot().episodes);
  assert.equal(dismissed, 2);
  assert.deepEqual(seen, [['user corrected the tone', 'ran the build, it passed', 'renamed a file as asked']]);
  const snapshot = coordinator.snapshot();
  assert.deepEqual(snapshot.episodes.map(row => row.id), ['e0']);
  assert.deepEqual(snapshot.seen.map(row => row.outcome), ['no_signal', 'no_signal']);
  // A settled episode never comes back.
  assert.deepEqual((await coordinator.ingest([episodes[1]])).duplicate, ['e1']);
  // Without a judge nothing is settled.
  assert.equal(await ProjectLearningController.prototype.selectEvidence.call({ ...host, decisions: {} }, context, 'p', snapshot.episodes), 0);
  await coordinator.close();
});

async function mcpFixture(t) {
  let calls = 0;
  const mcp = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const message = JSON.parse(raw);
    const send = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') { res.setHeader('mcp-session-id', 'one'); send({ protocolVersion: '2025-03-26', capabilities: { tools: {} } }); }
    else if (!message.id) res.writeHead(202).end();
    else if (message.method === 'tools/list') send({ tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: {} } }] });
    else if (message.method === 'tools/call') { calls++; send({ content: [{ type: 'text', text: 'echoed' }] }); }
  });
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const service = {
    configuration: () => ({ mcpServers: [] }),
    async registry() { const registry = new CapabilityRegistry({ mcpServers: [{ id: 'fixture', name: 'Echo service', description: 'Echoes values', transport: 'http', url: `http://127.0.0.1:${mcp.address().port}/mcp`, enabled: true, trusted: true, allowTools: { echo: { permission: 'read', idempotent: true } } }] }); await registry.connectMcp('fixture'); return { registry, failures: [] }; },
  };
  t.after(async () => { mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); });
  return { service, calls: () => calls };
}
async function modelFixture(t, responder) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-disclosure-')), cwd = join(dir, 'workspace'); await mkdir(cwd); await writeFile(join(cwd, 'README.md'), 'fixture');
  const requests = [];
  const server = createServer(async (req, res) => { const chunks = []; for await (const data of req) chunks.push(data); requests.push(JSON.parse(Buffer.concat(chunks).toString())); responder(requests.at(-1), res, requests.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const handles = [];
  t.after(async () => { for (const handle of handles) await handle.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const options = { sessionId: 'host-session', projectId: 'project', cwd, stateDir: join(dir, 'rna'), model: { providerId: 'fixture-provider', modelId: 'fixture-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 64000, maxOutputTokens: 127, reasoning: 'off' }, apiKey: 'fixture-key' };
  return { requests, create: async extra => { const handle = await createRnaRuntime({ ...options, ...extra }); handles.push(handle); return handle; } };
}
const sse = (res, delta, finish) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`); res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`); res.end('data: [DONE]\n\n'); };
const project = { id: 'project', assignments: { skillIds: [], toolIds: ['mcp:fixture:echo'], mcpServerIds: ['fixture'] } };

test('capability.disclosure: a set-aside service stays reachable through mcp_call and comes back once used', async t => {
  const echo = mcpToolName('fixture', 'echo'), { service, calls } = await mcpFixture(t);
  const f = await modelFixture(t, (body, res, n) => {
    const names = body.tools.map(row => row.function.name);
    if (n === 1) { assert.ok(!names.includes(echo), 'the set-aside tool is not declared'); assert.ok(names.includes('mcp_call')); return sse(res, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'mcp_call', arguments: JSON.stringify({ tool: echo, arguments: {} }) } }] }, 'tool_calls'); }
    sse(res, { content: 'done' }, 'stop');
  });
  const offered = [], used = [];
  const handle = await f.create({ project, capabilityService: service, mcpDisclosure: { deferred: null, decide: async services => { offered.push(...services); return ['fixture']; }, onUsed: id => used.push(id) } });
  await handle.prompt('Echo something through the service.');
  assert.deepEqual(offered.map(row => ({ id: row.id, name: row.name, tools: row.tools })), [{ id: 'fixture', name: 'Echo service', tools: ['echo'] }]);
  assert.equal(calls(), 1); assert.deepEqual(used, ['fixture']);
  assert.match(handle.snapshot().messages.filter(row => row.role === 'toolResult').map(row => JSON.stringify(row.content)).join(''), /echoed/);
});

test('capability.disclosure: a recorded answer is reused without judging, and no answer keeps every service declared', async t => {
  const echo = mcpToolName('fixture', 'echo'), { service } = await mcpFixture(t), declared = [];
  const f = await modelFixture(t, (body, res) => { declared.push(body.tools.map(row => row.function.name).includes(echo)); sse(res, { content: 'ok' }, 'stop'); });
  let judged = 0;
  const first = await f.create({ project, capabilityService: service, mcpDisclosure: { deferred: [], decide: async () => { judged++; return ['fixture']; } } });
  await first.prompt('Hi'); await first.dispose();
  await (await f.create({ project, capabilityService: service, mcpDisclosure: { deferred: null, decide: async () => null } })).prompt('Hi');
  assert.equal(judged, 0); assert.deepEqual(declared, [true, true]);
});
