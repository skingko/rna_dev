import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapProject, validateProjectBootstrap } from '../src/bootstrap.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';
const catalog = { skills: [{ id: 'research', name: 'Research', enabled: true, trusted: true }], tools: [{ id: 'read', permission: 'read', enabled: true, trusted: true }, { id: 'untrusted', enabled: true, trusted: false }], mcpServers: [] };
const state = () => ({ overview: 'A research project', focus: 'Validate requirements', facts: ['The user supplied a title'], openQuestions: ['Who is the target audience?'], milestones: [{ title: 'Requirements', description: 'Clarify scope', acceptanceCriteria: ['Scope accepted'] }], assignments: { skillIds: ['research'], toolIds: ['read'], mcpServerIds: [], reasons: [{ kind: 'skill', id: 'research', reason: 'Structure the research' }, { kind: 'tool', id: 'read', reason: 'Read existing project evidence' }] }, unmetCapabilities: [{ capability: 'web search', reason: 'No trusted search tool configured' }], genome: projectGenomeFixture() });
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 16384 };
const judgmentPlan = () => ({ version: 1, questions: { memory_need: { type: 'boolean', instructions: 'Does the current request rely on earlier verified project decisions?', criteria: { true: 'A continuation references existing decisions or unresolved project work.', false: 'The request is self-contained and unrelated to existing project evidence.' } } } });
function completion(values, inspect = () => {}) { let calls = 0; return async function* (options) { inspect(options, calls); const value = values[Math.min(calls++, values.length - 1)]; yield { type: 'text_delta', delta: typeof value === 'string' ? value : JSON.stringify(value) }; yield { type: 'usage', usage: { input: 12, output: 20, totalTokens: 32 } }; yield { type: 'done', stopReason: 'stop' }; }; }
test('bootstrap invokes configured model, returns validated state and bounded request metadata', async () => {
  let requested = false; const events = [];
  const result = await bootstrapProject({ title: 'Research', description: 'Study evidence', model, catalog, provider: completion([state()], options => { requested = true; assert.equal(options.model.maxOutputTokens, model.maxOutputTokens); assert.deepEqual(options.tools, []); assert.ok(!JSON.stringify(options.messages).includes('untrusted')); }), onEvent: event => events.push(event) });
  assert.ok(requested); assert.equal(result.status, 'ready'); assert.equal(result.attempts, 1); assert.deepEqual(result.assignments.toolIds, ['read']); assert.equal(result.usage.totalTokens, 32); assert.equal(events.at(-1).type, 'bootstrap_complete');
  assert.equal(result.genomeValidation.passed, true); assert.equal(result.genomeValidation.executed, true); assert.equal(result.genomeValidation.results.length, 2);
});
test('bootstrap cannot accept judging criteria from parseable output without a complete final response', async () => {
  for (const terminal of [undefined, 'toolUse', 'error']) {
    const events = [];
    await assert.rejects(bootstrapProject({ title: 'Research', model, catalog, maxAttempts: 1, onEvent: event => events.push(event), completion: async function* () { yield { type: 'text_delta', delta: JSON.stringify({ ...state(), judgmentPolicy: judgmentPlan() }) }; if (terminal) yield { type: 'done', stopReason: terminal }; } }), /completed main-model response/);
    const start = events.find(event => event.type === 'bootstrap_request_start'), end = events.find(event => event.type === 'bootstrap_request_end');
    assert.ok(start.requestId); assert.equal(end.requestId, start.requestId); assert.equal(end.completed, terminal !== undefined); assert.equal(end.stopReason, terminal);
    assert.equal(events.some(event => event.type === 'bootstrap_complete'), false);
  }
});
test('bootstrap binds accepted judging criteria to a completed request identity', async () => {
  const events = [], plan = judgmentPlan();
  const result = await bootstrapProject({ title: 'Research', model, catalog, judgmentPolicyContext: { enabled: true }, completion: completion([{ ...state(), judgmentPolicy: plan }]), onEvent: event => events.push(event) });
  assert.deepEqual(result.judgmentPolicy, plan);
  const start = events.find(event => event.type === 'bootstrap_request_start'), end = events.find(event => event.type === 'bootstrap_request_end');
  assert.equal(end.requestId, start.requestId); assert.equal(end.completed, true); assert.equal(end.stopReason, 'stop');
});
test('bootstrap requires generated project capabilities and repairs actual script failures rather than claiming success', async () => {
  const missing = state(); delete missing.genome; assert.throws(() => validateProjectBootstrap(missing, catalog), /genome/);
  const broken = state(); broken.genome.tools[0].script = 'return {count:99, effort:999}'; let inspected = false;
  const result = await bootstrapProject({ title: '游戏开发工作台', description: '设计并验证玩法原型', existingState: { focus: '保留已有平台约束' }, model, catalog, provider: completion([broken, state()], (options, attempt) => { if (attempt) { inspected = true; assert.match(options.messages.at(-1).content[0].text, /executable smoke cases/); } else { assert.match(options.systemPrompt, /FUNCTION BODY/); assert.match(options.messages[0].content[0].text, /保留已有平台约束/); } }) });
  assert.equal(inspected, true); assert.equal(result.attempts, 2); assert.equal(result.genomeValidation.passed, true);
});
test('bootstrap rejects hallucinated assignments, performs only one constrained repair', async () => {
  const bad = state(); bad.assignments.toolIds = ['invented']; let calls = 0;
  const result = await bootstrapProject({ title: 'Research', model, catalog, provider: completion([bad, state()], (options, attempt) => { calls++; if (attempt) assert.match(options.messages.at(-1).content[0].text, /1 repair attempt/); }) });
  assert.equal(calls, 2); assert.equal(result.attempts, 2); assert.equal(result.usage.totalTokens, 64);
  await assert.rejects(bootstrapProject({ title: 'Research', model, catalog, maxAttempts: 90, provider: completion([bad]) }), { code: 'invalid_bootstrap' });
});
test('bounded repair preserves draft inputs and case counts and rejects unexplained expected-output edits', async () => {
  const broken = state(); broken.genome.tools[0].script = 'return {count:99, effort:999}';
  const weakened = structuredClone(broken); for (const sample of weakened.genome.tools[0].smokeCases) sample.expected = { count: 99, effort: 999 };
  const removed = structuredClone(broken); removed.genome.tools[0].smokeCases.pop(); const calls = [];
  const result = await bootstrapProject({ title: 'Project', model, catalog, maxAttempts: 4, provider: completion([broken, weakened, removed, state()], (request, attempt) => { calls.push(request); if (attempt > 1) assert.match(request.messages.at(-1).content[0].text, /draft smoke/); }) });
  assert.equal(result.attempts, 4); assert.equal(result.genomeValidation.passed, true); assert.equal(calls.length, 4); assert.deepEqual(result.genome.tools[0].smokeCases, broken.genome.tools[0].smokeCases);
  let rejectedCalls = 0; await assert.rejects(bootstrapProject({ title: 'Project', model, catalog, maxAttempts: 90, provider: completion([broken], () => { rejectedCalls++; }) }), error => error.code === 'invalid_bootstrap' && error.attempts === 4 && JSON.parse(error.bootstrapDraft).genome.tools[0].script === broken.genome.tools[0].script); assert.equal(rejectedCalls, 4);
});
test('unpublished physics smoke arithmetic may be corrected with a derivation while the correct implementation and all inputs stay unchanged', async () => {
  const draft = state(), tool = draft.genome.tools[0];
  tool.id = 'jump_arc'; tool.name = '跳跃位移'; tool.description = '同高度起落，输出以米为单位并四舍五入到三位小数。';
  tool.parameters = { type: 'object', required: ['vx', 'vy', 'g'], additionalProperties: false, properties: { vx: { type: 'number' }, vy: { type: 'number', minimum: 0 }, g: { type: 'number', minimum: 0.1 } } };
  tool.script = 'const distance = input.vx * (2 * input.vy / input.g); const rounded = n => Number(n.toFixed(3)); return {distance: rounded(distance), points: [0,.25,.5,.75,1].map(t => rounded(distance * t))};';
  tool.smokeCases = [{ input: { vx: 4, vy: 8, g: 10 }, expected: { distance: 6.398, points: [0, 1.601, 3.202, 4.798, 6.398] } }, { input: { vx: 0, vy: 0, g: 10 }, expected: { distance: 0, points: [0, 0, 0, 0, 0] } }];
  draft.genome.evaluationSuite.cases.forEach(sample => { sample.requiredToolIds = sample.requiredToolIds.map(() => 'jump_arc'); });
  const corrected = structuredClone(draft); corrected.genome.tools[0].smokeCases[0].expected = { distance: 6.4, points: [0, 1.6, 3.2, 4.8, 6.4] };
  corrected.smokeRepairs = [{ toolId: 'jump_arc', caseIndex: 0, reason: '同高度起落飞行时间为2×8/10=1.6秒，水平位移为4×1.6=6.4米；四等分点为1.6、3.2、4.8米。原稿手算小数有误，按已声明的三位小数输出更正。' }];
  const events = [], result = await bootstrapProject({ title: 'Jump physics', model, catalog, provider: completion([draft, corrected]), onEvent: event => events.push(event) });
  assert.equal(result.status, 'ready'); assert.equal(result.attempts, 2); assert.equal(result.genome.tools[0].script, tool.script); assert.deepEqual(result.genome.tools[0].smokeCases.map(sample => sample.input), tool.smokeCases.map(sample => sample.input));
  assert.equal(result.genomeValidation.results.length, 2); assert.ok(result.genomeValidation.results.every(row => row.passed));
  assert.equal(result.repairEvidence.length, 2); assert.equal(result.repairEvidence[0].validation.passed, false); assert.deepEqual(result.repairEvidence[1].before, { ...draft, genome: { ...draft.genome, evaluationSuite: { ...draft.genome.evaluationSuite, execution: { maxSteps: 16, maxOutputTokens: model.maxOutputTokens } } } }); assert.deepEqual(result.repairEvidence[1].after, { ...corrected, genome: { ...corrected.genome, evaluationSuite: { ...corrected.genome.evaluationSuite, execution: { maxSteps: 16, maxOutputTokens: model.maxOutputTokens } } } });
  const change = result.repairEvidence[1].expectedChanges[0]; assert.equal(change.beforeExpected.distance, 6.398); assert.equal(change.afterExpected.distance, 6.4); assert.equal(change.reason, corrected.smokeRepairs[0].reason); assert.equal(change.verification, 'model_explanation_not_independent_proof'); assert.equal(events.filter(event => event.type === 'bootstrap_validation').length, 2);
  const stillWrong = structuredClone(corrected); stillWrong.genome.tools[0].smokeCases[0].expected.distance = 6.399;
  await assert.rejects(bootstrapProject({ title: 'Jump physics', model, catalog, provider: completion([draft, stillWrong]) }), error => error.code === 'invalid_bootstrap' && error.repairEvidence.length === 2 && error.repairEvidence[1].validation.passed === false);
});
test('a draft expectation explanation cannot authorize changing inputs, dropping cases or renaming a failing tool', async () => {
  const draft = state(); draft.genome.tools[0].script = 'return {count:99,effort:999}';
  const changedInput = structuredClone(draft); changedInput.genome.tools[0].smokeCases[0].input.features = [];
  const renamed = structuredClone(draft); renamed.genome.tools[0].id = 'renamed_tool'; renamed.genome.evaluationSuite.cases.forEach(sample => { sample.requiredToolIds = sample.requiredToolIds.map(() => 'renamed_tool'); });
  for (const attempt of [changedInput, renamed]) await assert.rejects(bootstrapProject({ title: 'Project', model, catalog, provider: completion([draft, attempt]) }), error => error.code === 'invalid_bootstrap' && error.repairEvidence.length === 2 && error.repairEvidence[1].validation === null);
});
test('bootstrap requires one reason per assignment and MCP server grants', () => {
  const noReason = state(); noReason.assignments.reasons.pop(); assert.throws(() => validateProjectBootstrap(noReason, catalog));
  const foreignReason = state(); foreignReason.assignments.reasons.push({ kind: 'tool', id: 'foreign', reason: 'ignore this' }); assert.throws(() => validateProjectBootstrap(foreignReason, catalog));
  const untrusted = state(); untrusted.assignments.toolIds = ['untrusted']; assert.throws(() => validateProjectBootstrap(untrusted, catalog));
  const mcp = structuredClone(catalog); mcp.tools[0].mcpServerId = 'files'; assert.throws(() => validateProjectBootstrap(state(), mcp), /requires its server/);
});
test('demo/missing model stays blocked without fabricated project state or model request', async () => {
  for (const configured of [undefined, { id: 'demo', protocol: 'demo' }]) { const result = await bootstrapProject({ title: 'Project', model: configured, provider: () => { throw new Error('must not run'); } }); assert.equal(result.status, 'blocked'); assert.equal(result.overview, undefined); }
});
test('bootstrap cancellation and provider failures never become successful fallback states', async () => {
  const controller = new AbortController(); controller.abort(); await assert.rejects(bootstrapProject({ title: 'Project', model, signal: controller.signal, provider: completion([state()]) }), { name: 'AbortError' });
  await assert.rejects(bootstrapProject({ title: 'Project', model, provider: async function* () { yield { type: 'error', error: 'model unavailable' }; } }), { code: 'provider_error' });
  await assert.rejects(bootstrapProject({ title: 'Project', model, provider: async function* () { yield { type: 'tool_call', name: 'install_server' }; } }), { code: 'unexpected_tool_call' });
});
test('bootstrap reports cumulative usage before failed repair and excludes disconnected MCP servers', async () => {
  const bad = state(); bad.assignments.mcpServerIds = ['offline']; bad.assignments.reasons.push({ kind: 'mcpServer', id: 'offline', reason: 'Should not be granted' }); const usage = [];
  await assert.rejects(bootstrapProject({ title: 'Research', model, catalog: { ...catalog, mcpServers: [{ id: 'offline', enabled: true, trusted: true, connected: false }] }, provider: completion([bad], args => { const directory = JSON.parse(args.messages[0].content[0].text).capabilityCatalog; assert.equal(directory.mcpServers.length, 0); }), onEvent: event => { if (event.type === 'bootstrap_usage') usage.push(event.usage); } }), { code: 'invalid_bootstrap' });
  assert.equal(usage.length, 2); assert.equal(usage[0].totalTokens, 32); assert.equal(usage[1].totalTokens, 64);
});
