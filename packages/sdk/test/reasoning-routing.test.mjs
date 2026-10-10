import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, streamCompletion } from '../src/providers.mjs';
import { buildCodexRequest } from '../src/subscription-provider.mjs';
import { createSession } from '../src/session.mjs';
import { createDecisionKernel, chatRouteTemplate, validateHostTemplatePlan, hostTemplateHash, routeSkillKey, CHAT_ROUTE_BUDGET_MS, decisionAssessmentPlanHash } from '../src/decision-kernel.mjs';
import { createLlmDecisionJudge, llmJudgeReasoning } from '../src/decision-llm-judge.mjs';

const base = { providerId: 'fixture', modelId: 'model', maxOutputTokens: 4096, contextWindow: 32000 };
const input = { systemPrompt: 'stable', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const body = (model, reasoning) => buildRequest({ ...input, model: { ...base, ...model, reasoning } }).body;
async function capture(t, respond) {
  const bodies = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw)); respond(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, bodies };
}
const openaiText = text => (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 9 } })}\n\ndata: [DONE]\n\n`); };
const anthropicText = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const event of [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); res.end(); };

test('provider default omits only the effort field while keeping required thinking switches', () => {
  const deepseek = { protocol: 'openai', baseUrl: 'https://api.deepseek.com' };
  assert.deepEqual([body(deepseek, 'default').thinking, body(deepseek, 'default').reasoning_effort], [{ type: 'enabled' }, undefined]);
  assert.deepEqual([body(deepseek, 'max').thinking, body(deepseek, 'max').reasoning_effort], [{ type: 'enabled' }, 'max']);
  assert.deepEqual([body(deepseek, 'off').thinking, body(deepseek, 'off').reasoning_effort], [{ type: 'disabled' }, undefined]);
  const zai = { protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3' };
  assert.deepEqual([body(zai, 'default').thinking, body(zai, 'default').reasoning_effort], [{ type: 'enabled' }, undefined]);
  assert.equal(body(zai, 'medium').reasoning_effort, 'high');
  const qwen = { protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', compat: { thinkingFormat: 'qwen', preserveThinking: true } };
  assert.deepEqual([body(qwen, 'default').enable_thinking, body(qwen, 'default').preserve_thinking, body(qwen, 'default').reasoning_effort], [true, true, undefined]);
  assert.equal(body(qwen, 'off').enable_thinking, false);
  const toggle = { protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', compat: { thinkingFormat: 'toggle' } };
  assert.deepEqual(body(toggle, 'default').thinking, { type: 'enabled' });
  const openai = { protocol: 'openai', baseUrl: 'https://api.openai.com/v1' };
  assert.equal(Object.hasOwn(body(openai, 'default'), 'reasoning_effort'), false); assert.equal(body(openai, 'medium').reasoning_effort, 'medium');
  assert.equal(Object.hasOwn(body(openai, 'off'), 'reasoning_effort'), false, 'legacy off without a mapping keeps omitting the field');
  assert.equal(body({ ...openai, compat: { reasoningEffortMap: { off: 'none' } } }, 'off').reasoning_effort, 'none');
  // The official endpoint adds the preserved-thinking binding control (drop_block by default; anthropic-wire tests).
  const adaptive = { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } }, bound = { block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  assert.deepEqual([body(adaptive, 'default').thinking, body(adaptive, 'default').output_config], [{ type: 'adaptive', display: 'summarized', ...bound }, undefined]);
  assert.deepEqual([body(adaptive, 'high').thinking, body(adaptive, 'high').output_config], [{ type: 'adaptive', display: 'summarized', ...bound }, { effort: 'high' }]);
  assert.deepEqual(body({ ...adaptive, compat: { adaptiveThinking: true } }, 'default').thinking, { type: 'adaptive', ...bound });
  const budget = { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  assert.equal(body(budget, 'default').thinking, undefined, 'budget models: provider default means no thinking');
  assert.deepEqual(body(budget, 'medium').thinking, { type: 'enabled', budget_tokens: 4095, block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  for (const value of ['auto', 'extreme']) assert.throws(() => body(openai, value), error => error.code === 'configuration');
  assert.throws(() => body({ ...adaptive, compat: { adaptiveThinking: true, thinkingDisplay: 'verbose' } }, 'high'), error => error.code === 'configuration');
  const codex = { ...base, protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', modelId: 'gpt-5.5' };
  assert.deepEqual(buildCodexRequest({ ...input, model: { ...codex, reasoning: 'default' } }).body.reasoning, { summary: 'auto' });
  assert.deepEqual(buildCodexRequest({ ...input, model: { ...codex, reasoning: 'low' } }).body.reasoning, { effort: 'low', summary: 'auto' });
});

test('request bodies captured over local HTTP carry the mapped reasoning fields', async t => {
  const openai = await capture(t, openaiText('ok'));
  for (const reasoning of ['default', 'high', 'off']) await Array.fromAsync(streamCompletion({ ...input, model: { ...base, protocol: 'openai', baseUrl: openai.url, compat: { thinkingFormat: 'zai' }, reasoning } }));
  assert.deepEqual(openai.bodies.map(row => [row.thinking, row.reasoning_effort]), [[{ type: 'enabled' }, undefined], [{ type: 'enabled' }, 'high'], [{ type: 'enabled' }, 'off']]);
  const anthropic = await capture(t, anthropicText);
  for (const reasoning of ['default', 'xhigh']) await Array.fromAsync(streamCompletion({ ...input, model: { ...base, protocol: 'anthropic', baseUrl: anthropic.url, compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' }, reasoning } }));
  assert.deepEqual(anthropic.bodies.map(row => [row.thinking, row.output_config]), [[{ type: 'adaptive', display: 'summarized' }, undefined], [{ type: 'adaptive', display: 'summarized' }, { effort: 'xhigh' }]]);
});

test('a request hook fixes per-turn reasoning before the first request and rejects invalid values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-reasoning-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [], provider = async function* (request) { seen.push(request.model.reasoning); yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' }; };
  const model = { ...base, protocol: 'openai', baseUrl: 'http://127.0.0.1:9', reasoning: 'default' };
  const session = await createSession({ projectId: 'p', cwd: dir, stateDir: join(dir, 'a'), model, provider, beforeRequest: async () => ({ reasoning: 'high' }) }); t.after(() => session.dispose());
  await session.prompt('think'); assert.deepEqual(seen, ['high']);
  const invalid = await createSession({ projectId: 'p', cwd: dir, stateDir: join(dir, 'b'), model, provider, beforeRequest: async () => ({ reasoning: 'auto' }) }); t.after(() => invalid.dispose());
  await assert.rejects(invalid.prompt('think'), error => error.code === 'invalid_options'); assert.deepEqual(seen, ['high']);
});

const efforts = [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }];
const routeResponse = (answers, usage = { input_tokens: 40, output_tokens: 6 }) => new Response(JSON.stringify({ answers, usage }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('chat.route host templates are versioned, hashed, bounded and never accept main-model plans', async () => {
  const plan = chatRouteTemplate({ efforts, memory: true, skills: [1, 2, 3, 4, 5].map(n => ({ id: `Skill ${n}`, name: `S${n}`, description: 'd' })) });
  assert.equal(plan.source, 'host-template'); assert.deepEqual(Object.keys(plan.questions), ['reasoning_effort', 'memory_need', 'skill_skill_1', 'skill_skill_2', 'skill_skill_3', 'skill_skill_4']);
  assert.deepEqual(Object.keys(plan.questions.reasoning_effort.criteria), ['low', 'medium', 'high', 'unknown']);
  assert.equal(hostTemplateHash(plan), hostTemplateHash(structuredClone(plan))); assert.equal(routeSkillKey('code-review'), 'skill_code_review');
  assert.notEqual(hostTemplateHash(plan), hostTemplateHash(chatRouteTemplate({ efforts, memory: false })));
  assert.throws(() => validateHostTemplatePlan({ ...plan, questions: { ...plan.questions, task_state: plan.questions.reasoning_effort } }), /invalid_assessment_plan/);
  assert.throws(() => validateHostTemplatePlan({ ...plan, questions: { ...plan.questions, skill_extra: plan.questions.memory_need } }), /invalid_assessment_plan/);
  assert.throws(() => validateHostTemplatePlan({ ...plan, source: 'main-model' }), /invalid_assessment_plan/);
  assert.equal(Object.hasOwn(chatRouteTemplate({ efforts: [efforts[0]] }).questions, 'reasoning_effort'), false, 'a single effort is not a routing choice');
  let calls = 0; const kernel = createDecisionKernel({ apiKey: 'synthetic-test-credential', mode: 'active', fetch: async () => { calls++; return routeResponse({}); } });
  const mainPlan = { version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Need memory?', criteria: { true: 'yes', false: 'no' } } } };
  assert.equal((await kernel.decide({ point: 'chat.route', scope: { projectId: 'p' }, assessmentPlan: mainPlan })).reason, 'assessment_point_unconfigured');
  assert.equal((await kernel.decide({ point: 'chat.preflight', scope: { projectId: 'p' }, assessmentPlan: plan })).reason, 'assessment_point_unconfigured');
  assert.equal(calls, 0); assert.ok(decisionAssessmentPlanHash(mainPlan));
});

test('chat.route via TypeSafe wire: bounded state, policy budget, content-free ledger with backend', async () => {
  const requests = [], ledger = [];
  const kernel = createDecisionKernel({ apiKey: 'synthetic-test-credential', mode: 'active', knownSecrets: () => ['sk-live-abcdefghijklmnopqrstu'], ledger: row => ledger.push(row),
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return routeResponse({ reasoning_effort: { choice: 'high', probabilities: { low: .02, medium: .03, high: .94, unknown: .01 }, confidence: .95 }, memory_need: { noul: .02, confidence: .95 } }); } });
  const result = await kernel.decide({ point: 'chat.route', scope: { projectId: 'p', revision: 't1' }, state: { userMessage: 'Refactor the scheduler; key sk-live-abcdefghijklmnopqrstu', transcript: 'must not leave' }, assessmentPlan: chatRouteTemplate({ efforts, memory: true }) });
  assert.equal(result.source, 'judge'); assert.equal(result.backend, 'typesafe'); assert.equal(result.policy.timeoutMs, CHAT_ROUTE_BUDGET_MS); assert.equal(result.policy.ttlMs, 0);
  assert.equal(result.answers.reasoning_effort.choice, 'high'); assert.equal(requests[0].questions.memory_need.type, 'noul');
  assert.ok(!JSON.stringify(requests[0]).includes('sk-live-abcdefghijklmnopqrstu')); assert.equal(requests[0].state.transcript, undefined);
  assert.equal(ledger[0].point, 'chat.route'); assert.equal(ledger[0].backend, 'typesafe'); assert.ok(!JSON.stringify(ledger[0]).includes('Refactor'));
});

test('chat.route timeout and circuit breaker fall back without blocking', async () => {
  let calls = 0; const kernel = createDecisionKernel({ apiKey: 'synthetic-test-credential', mode: 'active', failureThreshold: 1, fetch: async () => { calls++; return new Promise(() => {}); } });
  const started = Date.now(), plan = chatRouteTemplate({ efforts, memory: true });
  const first = await kernel.decide({ point: 'chat.route', scope: { projectId: 'p', revision: 1 }, state: { userMessage: 'a' }, assessmentPlan: plan });
  assert.equal(first.reason, 'timeout'); assert.ok(Date.now() - started < CHAT_ROUTE_BUDGET_MS + 600); assert.deepEqual(first.outcome, { reasoning: 'default', needsMemory: true });
  const second = await kernel.decide({ point: 'chat.route', scope: { projectId: 'p', revision: 2 }, state: { userMessage: 'b' }, assessmentPlan: plan });
  assert.equal(second.reason, 'circuit_open'); assert.equal(calls, 1);
});

test('LLM judge backend fills the same decide() answer format with thinking off, a small cap and a jev-llm purpose', async t => {
  const server = await capture(t, openaiText('```json\n{"answers":{"reasoning_effort":{"choice":"low","probabilities":{"low":0.9,"medium":0.05,"high":0.04,"unknown":0.02},"confidence":0.93},"memory_need":{"p_true":0.03,"confidence":0.9}}}\n```'));
  const model = { ...base, protocol: 'openai', baseUrl: server.url, maxOutputTokens: 8192, reasoningCapability: { control: 'effort', efforts, canDisable: true, providerDefault: null, visibility: 'hidden' } };
  const purposes = [];
  const provider = input => { purposes.push(input.purpose); return streamCompletion(input); };
  const ledger = [], kernel = createDecisionKernel({ mode: 'active', backend: 'llm', requireCredential: false, judge: createLlmDecisionJudge({ model, apiKey: 'judge-key', provider }), ledger: row => ledger.push(row) });
  const result = await kernel.decide({ point: 'chat.route', scope: { projectId: 'p', revision: 't' }, state: { userMessage: 'hi' }, assessmentPlan: chatRouteTemplate({ efforts, memory: true }) });
  assert.equal(result.source, 'judge'); assert.equal(result.backend, 'llm'); assert.equal(result.answers.reasoning_effort.choice, 'low'); assert.equal(result.answers.memory_need.probability, .03);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 9 }); assert.deepEqual(purposes, ['jev-llm']); assert.equal(ledger[0].backend, 'llm');
  const sent = server.bodies[0]; assert.equal(sent.max_completion_tokens, 512); assert.equal(sent.reasoning_effort, undefined); assert.equal(sent.tools, undefined);
  assert.equal(llmJudgeReasoning({ canDisable: false, efforts: [{ id: 'low' }], control: 'effort' }), 'low'); assert.equal(llmJudgeReasoning({ canDisable: true, efforts, control: 'effort' }), 'off');
  const bad = await capture(t, openaiText('not json'));
  const failing = createDecisionKernel({ mode: 'active', backend: 'llm', requireCredential: false, judge: createLlmDecisionJudge({ model: { ...model, baseUrl: bad.url } }) });
  assert.equal((await failing.decide({ point: 'chat.route', scope: { projectId: 'p', revision: 'x' }, state: { userMessage: 'hi' }, assessmentPlan: chatRouteTemplate({ efforts, memory: true }) })).reason, 'invalid_response');
  assert.throws(() => createDecisionKernel({ backend: 'llm' }), /invalid_backend/);
});
