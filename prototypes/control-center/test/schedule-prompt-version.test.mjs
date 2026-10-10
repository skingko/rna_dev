import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { SCHEDULE_PROMPT_VERSIONS, DEFAULT_SCHEDULE_PROMPT_VERSION, SCHEDULE_TEXT_V1, SCHEDULE_TEXT_V2, schedulePromptVersionOf, schedulePromptVersionInput, scheduleForegroundParagraph, scheduleToolDescription, scheduleToolParameters, scheduleContractText, schedulePolicyReason } from '../schedule-prompt.mjs';

// W2 (design2 §7): one setting, schedulePromptVersion, switches the foreground paragraph, the project_schedule tool texts, the
// planner's guidance and the three one-sentence amendments together. v1 (default) is today's text; the release is
// behaviour-identical until the paired replay passes. No model is called: deterministic providers.
const sha = text => createHash('sha256').update(text).digest('hex');
// SHA-256 of the pre-W2 texts, from the repository at 0.68.0 (rna-runtime.mjs capabilityInstructions, project-schedule-service.mjs,
// project-initiative-controller.mjs actionContracts.schedule).
const V1 = { foreground: '2605cb83053f0c4e8be978881670c90efa669f4f725919221b644b318cc75989', toolDescription: 'f713a8195e39f39981392301aefb7a07153f51c9f6bc09b1cb9c5d2a9ef877a4', policyReason: 'b2cdb66586b5e48acb2cbe8eb287f0855120adf1746473279224a79115bf702d', authorization: '74be0fa18a17c882c0577da4fc71a8f67116de2fc21b6fbc2383b7972928c927', scope: 'b01b6bfcfe0da3a361b0271ef99e5646fd3e0f422ae0970626b3ea761fcee923' };
const V1_PARAMETERS = 'd928f8d2490ebee3ef55ac068af2c10034a08fd534f758ec1b7111fa43ff8f63';
// The pre-W2 span as the system prompt carries it. The paragraphs around the schedule paragraph were translated to English
// when model-visible text became fixed English (the web-preview, delegation, reply-writing, skills and permission paragraphs, plus the
// new interface-language note), so this hash was recomputed from that span; the v1 schedule paragraph inside it is the 0.68.0
// text byte for byte, still pinned by V1.foreground above.
const V1_CAPABILITY_INSTRUCTIONS = '329400a202b38d6abdd63e7863829d096968ee48ae22c71a946de762bbde1e7b';
const cjk = /[㐀-鿿　-〿＀-￯]/;

test('v1 keeps every text byte for byte, v2 is a different English text, and anything but v2 reads as v1', () => {
  for (const [key, text] of Object.entries(SCHEDULE_TEXT_V1)) assert.equal(sha(text), V1[key], key);
  assert.equal(sha(JSON.stringify(scheduleToolParameters('v1'))), V1_PARAMETERS);
  assert.equal(scheduleForegroundParagraph('v1'), SCHEDULE_TEXT_V1.foreground); assert.equal(scheduleToolDescription('v1'), SCHEDULE_TEXT_V1.toolDescription);
  assert.deepEqual(scheduleContractText('v1'), { authorization: SCHEDULE_TEXT_V1.authorization, scope: SCHEDULE_TEXT_V1.scope }); assert.equal(schedulePolicyReason('v1'), SCHEDULE_TEXT_V1.policyReason);
  for (const key of Object.keys(SCHEDULE_TEXT_V1)) assert.notEqual(SCHEDULE_TEXT_V2[key], SCHEDULE_TEXT_V1[key], key);
  assert.equal(scheduleForegroundParagraph('v2'), SCHEDULE_TEXT_V2.foreground);
  // Model-visible text is fixed English under v2 (the v1 foreground paragraph and tool description were Chinese).
  for (const text of [SCHEDULE_TEXT_V2.foreground, SCHEDULE_TEXT_V2.toolDescription, JSON.stringify(scheduleToolParameters('v2'))]) assert.doesNotMatch(text, cjk);
  assert.deepEqual(SCHEDULE_PROMPT_VERSIONS, ['v1', 'v2']); assert.equal(DEFAULT_SCHEDULE_PROMPT_VERSION, 'v1');
  for (const configuration of [undefined, null, {}, { schedulePromptVersion: 'v1' }, { schedulePromptVersion: 'V2' }, { schedulePromptVersion: 2 }, { schedulePromptVersion: null }]) assert.equal(schedulePromptVersionOf(configuration), 'v1');
  assert.equal(schedulePromptVersionOf({ schedulePromptVersion: 'v2' }), 'v2');
  assert.equal(schedulePromptVersionInput('v2'), 'v2');
  for (const bad of ['v3', '', null, 2, undefined]) assert.throws(() => schedulePromptVersionInput(bad), { status: 400 });
});

test('the setting is read and written through the settings API, reports only the version, and a bad value changes nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-version-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = store.configurationService;
  assert.equal(service.public().schedulePromptVersion, 'v1');
  assert.equal(service.update({ schedulePromptVersion: 'v2' }).schedulePromptVersion, 'v2');
  assert.equal(store.state.configuration.schedulePromptVersion, 'v2');
  assert.equal(new Store(join(dir, 'state.json')).configurationService.public().schedulePromptVersion, 'v2');
  assert.throws(() => service.update({ schedulePromptVersion: 'v3' }), { status: 400 });
  assert.equal(service.public().schedulePromptVersion, 'v2');
  // An update that does not name it leaves it alone; one that sets it back restores v1.
  assert.equal(service.update({ memory: { autoRecall: false } }).schedulePromptVersion, 'v2');
  assert.equal(service.update({ schedulePromptVersion: 'v1' }).schedulePromptVersion, 'v1');
  assert.doesNotMatch(JSON.stringify(service.public()), /apiKey"\s*:\s*"[^"]/);
});

test('the project_schedule tool and the planner view follow the setting at each turn; v1 is the declaration it always had', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-version-tool-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: 'Research', workspace: dir });
  const service = new ProjectScheduleService(store);
  const declared = () => service.createTools({ projectId: project.id, sessionId: session.id }).find(tool => tool.name === 'project_schedule');
  const v1 = declared();
  assert.equal(sha(v1.description), V1.toolDescription); assert.equal(sha(JSON.stringify(v1.parameters)), V1_PARAMETERS);
  assert.equal(sha(service.agentView(project.id).policy.reason), V1.policyReason);
  store.configurationService.update({ schedulePromptVersion: 'v2' });
  const v2 = declared();
  assert.equal(v2.description, SCHEDULE_TEXT_V2.toolDescription); assert.deepEqual(v2.parameters, scheduleToolParameters('v2'));
  assert.equal(v2.parameters.properties.basis.maxLength, 1000); assert.ok(!v2.parameters.required.includes('basis')); assert.equal(v2.parameters.properties.expectedRevision.minimum, 1);
  assert.equal(service.agentView(project.id).policy.reason, SCHEDULE_TEXT_V2.policyReason);
  // The tool declared a turn earlier keeps what it had; the next turn reads the setting again.
  assert.equal(v1.description, SCHEDULE_TEXT_V1.toolDescription);
  store.configurationService.update({ schedulePromptVersion: 'v1' });
  assert.equal(declared().description, SCHEDULE_TEXT_V1.toolDescription);
});

test('the foreground system prompt carries the v1 paragraph unchanged by default and the v2 paragraph when set; the rest is identical', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-version-runtime-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Research', workspace: dir });
  const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000, execution: 'rna' };
  const prompts = [];
  const system = async () => {
    const handle = await createRnaRuntime({ project: store.state.projects.find(row => row.id === project.id), getProject: () => store.state.projects.find(row => row.id === project.id), projectId: project.id, capabilityService: new CapabilityService(store), cwd: dir, stateDir: join(dir, `rt-${prompts.length}`), sessionId: `s-${prompts.length}`, model,
      provider: async function* (request) { prompts.push(request.systemPrompt); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage: { input: 1, output: 1, totalTokens: 2 } }; yield { type: 'done', stopReason: 'stop' }; } });
    try { await handle.prompt('hello'); } finally { await handle.dispose?.(); }
    return prompts.at(-1);
  };
  const between = text => { const start = text.indexOf('\n\nWhen making or changing a web page'), end = text.indexOf('only the permission state saved by the host is in force.') + 'only the permission state saved by the host is in force.'.length; assert.ok(start >= 0 && end > start); return text.slice(start, end); };
  const first = await system();
  assert.equal(sha(between(first)), V1_CAPABILITY_INSTRUCTIONS);
  store.configurationService.update({ schedulePromptVersion: 'v2' });
  const second = await system();
  assert.ok(second.includes(SCHEDULE_TEXT_V2.foreground)); assert.ok(!second.includes('项目要求每日、每周或其他重复交付时'));
  assert.equal(second.replace(SCHEDULE_TEXT_V2.foreground, SCHEDULE_TEXT_V1.foreground), first, 'only the schedule paragraph differs');
});

async function until(check, diagnostic = () => ({})) { const end = Date.now() + 5000; while (Date.now() < end) { if (check()) return; await delay(5); } throw Error(`Planner fixture did not settle: ${JSON.stringify(diagnostic())}`); }
test('the planner request carries the guidance, contract and policy texts of the setting at that wake', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-schedule-version-planner-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Explicit deterministic decision fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Ongoing evidence project', description: 'Understand this evolving field and maintain useful project progress.', workspace: dir });
  let now = Date.parse('2026-09-26T00:00:00.000Z'); const seen = [];
  store.mutate(state => {
    const row = state.projects.find(p => p.id === project.id); row.initialization = { status: 'ready' }; row.simulated = false; row.decisionMode = 'rna-model'; row.initiative.tokenBudget = null; row.initiative.reviewMinMs = 1000; row.initiative.reviewMaxMs = 1000;
    row.permissions = { workspace: 'read', background: 'read' }; row.schedules = []; row.assignments = { skillIds: [], toolIds: [], mcpServerIds: [] };
    const source = state.sessions.find(s => s.id === session.id); source.items = []; source.turns = [];
  });
  const controller = new ProjectInitiativeController(store, { scheduleService: new ProjectScheduleService(store, { now: () => now }), initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => now,
    decisionProvider: async function* (request) {
      seen.push({ system: request.systemPrompt, input: JSON.parse(request.messages[0].content[0].text) });
      yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'No additional commitment is justified.', evidenceIds: [], content: '', nextReviewAfterMs: 1000 }) }; yield { type: 'usage', usage: { totalTokens: 31 } }; yield { type: 'done', stopReason: 'stop' };
    }, runtimeFactory: () => { throw Error('No worker expected'); } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  await until(() => seen.length >= 1, () => ({ seen: seen.length }));
  const [v1] = seen;
  assert.equal(sha(v1.input.hostActionContracts.schedule.authorization), V1.authorization); assert.equal(sha(v1.input.hostActionContracts.schedule.scope), V1.scope);
  assert.equal(sha(v1.input.project.scheduleContext.policy.reason), V1.policyReason);
  assert.doesNotMatch(v1.system, /standing instruction that every future run receives/);
  assert.ok(!JSON.stringify(JSON.parse(v1.system.split('matching this schema: ').at(-1)).properties.schedule).includes('"basis"'));
  store.configurationService.update({ schedulePromptVersion: 'v2' });
  now += 1001; controller.schedule();
  await until(() => seen.length >= 2, () => ({ seen: seen.length }));
  const v2 = seen.at(-1);
  assert.equal(v2.input.hostActionContracts.schedule.authorization, SCHEDULE_TEXT_V2.authorization); assert.equal(v2.input.hostActionContracts.schedule.scope, SCHEDULE_TEXT_V2.scope);
  assert.equal(v2.input.project.scheduleContext.policy.reason, SCHEDULE_TEXT_V2.policyReason);
  assert.match(v2.system, /standing instruction that every future run receives/);
  assert.ok(JSON.stringify(JSON.parse(v2.system.split('matching this schema: ').at(-1)).properties.schedule).includes('"basis"'));
});
