import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapProjectLite, projectBriefSchema, LITE_OUTPUT_TOKENS } from '../src/bootstrap-lite.mjs';
import { validateProjectGenome } from '../src/project-genome.mjs';

const brief = (extra = {}) => ({
  overview: '一款 three.js 卡丁车小游戏，完成后可在浏览器直接游玩。', focus: '先做出可操控的赛车和一条赛道。', facts: ['使用 three.js'], openQuestions: [],
  milestones: [{ title: '可玩原型', description: '一条赛道、一辆车。', acceptanceCriteria: ['能加速和转向'] }],
  charter: '你负责这个卡丁车游戏项目：用 three.js 实现，改动后在浏览器验证。', workflow: '1. 读现有代码 2. 小步修改 3. 浏览器实测',
  criteria: [{ id: 'playable', description: '游戏可以在浏览器运行并操控。' }],
  sampleTasks: [{ id: 't1', input: '加一条夜间赛道', requiredTerms: ['赛道'] }, { id: 't2', input: '让漂移更顺手', requiredTerms: [] }, { id: 't3', input: '修复转向反了', requiredTerms: ['转向'] }],
  skillQueries: ['threejs game', 'kart racing physics'], catalogSkillIds: ['browser-verification', 'unknown-skill'], mcpServerIds: ['playwright-browser'], reasons: [{ id: 'playwright-browser', reason: '游戏需要浏览器实测。' }], unmetCapabilities: [], ...extra });
const catalog = {
  skills: [{ id: 'browser-verification', name: 'Browser verification', description: 'Verify pages', enabled: true, trusted: true, contentHash: 'x' }],
  tools: [{ id: 'project_read', name: 'project_read', description: 'read', enabled: true, trusted: true, permission: 'read' }, { id: 'project_exec', name: 'project_exec', description: 'exec', enabled: true, trusted: true, permission: 'exec' },
    { id: 'mcp:playwright-browser:browser_click', name: 'click', description: 'click', enabled: true, trusted: true, permission: 'exec', mcpServerId: 'playwright-browser' }],
  mcpServers: [{ id: 'playwright-browser', name: 'Browser', description: 'Playwright', enabled: true, trusted: true, connected: true, toolIds: ['mcp:playwright-browser:browser_click'] }],
};
const model = { providerId: 'p', modelId: 'glm', id: 'glm', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 32768, reasoning: 'max', reasoningCapability: { canDisable: false, efforts: [{ id: 'low' }, { id: 'max' }] } };
const provider = outputs => { const requests = []; const fn = async function* (request) { requests.push(request); yield { type: 'text_delta', delta: outputs.shift() }; yield { type: 'usage', usage: { input: 900, output: 700 } }; yield { type: 'done', stopReason: 'stop' }; }; fn.requests = requests; return fn; };

test('one small request: bounded output, lowest reasoning, genome assembled by code, common tools shared', async () => {
  const p = provider([JSON.stringify(brief())]), events = [];
  const result = await bootstrapProjectLite({ title: '3d 小游戏', description: 'three.js 卡丁车', catalog, model, provider: p, onEvent: event => events.push(event.type) });
  assert.equal(result.status, 'ready'); assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].model.maxOutputTokens, LITE_OUTPUT_TOKENS); assert.equal(p.requests[0].model.reasoning, 'low');
  validateProjectGenome(result.genome); assert.equal(result.genome.tools.length, 0); assert.equal(result.genome.evaluationSuite.cases.length, 3);
  assert.deepEqual(result.assignments.skillIds, ['browser-verification'], 'unknown catalog ids are dropped');
  assert.deepEqual(result.assignments.mcpServerIds, ['playwright-browser']);
  assert.deepEqual(result.assignments.toolIds.sort(), ['mcp:playwright-browser:browser_click', 'project_exec', 'project_read']);
  assert.deepEqual(events, ['bootstrap_start', 'bootstrap_request_start', 'bootstrap_usage', 'bootstrap_request_end']);
  assert.equal(result.usage.output, 700); assert.deepEqual(result.skillQueries, ['threejs game', 'kart racing physics']);
});
test('an invalid brief gets one bounded repair with the validation error; a length cut-off is reported, not retried forever', async () => {
  const p = provider(['not json', JSON.stringify(brief({ mcpServerIds: [] , reasons: [] }))]);
  const result = await bootstrapProjectLite({ title: 'x', catalog, model, provider: p });
  assert.equal(result.attempts, 2); assert.match(p.requests[1].messages[1].content[0].text, /rejected/); assert.deepEqual(result.assignments.mcpServerIds, []);
  const cut = async function* () { yield { type: 'text_delta', delta: '{"overview":' }; yield { type: 'done', stopReason: 'length' }; };
  await assert.rejects(bootstrapProjectLite({ title: 'x', catalog, model, provider: cut, maxAttempts: 1 }), { code: 'output_limit' });
});
test('the brief schema bounds every free-text field', () => {
  const walk = (schema, path = '') => { if (schema.type === 'string' && !schema.pattern && !schema.enum) assert.ok(schema.maxLength <= 4000, path); for (const [key, value] of Object.entries(schema.properties ?? {})) walk(value, `${path}.${key}`); if (schema.items) walk(schema.items, `${path}[]`); };
  walk(projectBriefSchema);
});

test('a brief that overshoots list or text limits is trimmed, not rejected; unmet capabilities keep the artifact shape', async () => {
  const long = brief({ milestones: Array.from({ length: 7 }, (_, n) => ({ title: `M${n}`, description: 'd'.repeat(900), acceptanceCriteria: ['ok'] })), unmetCapabilities: ['需要 3D 建模资源'], extra: 'dropped', overview: 'o'.repeat(5000) });
  const p = provider([JSON.stringify(long)]);
  const result = await bootstrapProjectLite({ title: 'x', catalog, model, provider: p });
  assert.equal(result.attempts, 1); assert.equal(result.milestones.length, 4); assert.equal(result.milestones[0].description.length, 400); assert.equal(result.overview.length, 1200);
  assert.deepEqual(result.unmetCapabilities, [{ capability: '需要 3D 建模资源', reason: 'Noted in the initial project brief; not provided by the current catalog.' }]);
});

test('a brief wrapped in prose is still read from its outermost object', async () => {
  const p = provider([`好的，这是项目简报：\n${JSON.stringify(brief())}\n以上。`]);
  assert.equal((await bootstrapProjectLite({ title: 'x', catalog, model, provider: p })).attempts, 1);
});
