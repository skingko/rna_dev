import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { UsageLedger, cacheUsageResponse } from '../usage-cache-service.mjs';
import { buildRequest } from '../../../packages/sdk/src/providers.mjs';
import { sharedPrefixFor } from '../prompt-prefix-registry.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { GeneStore } from '../project-genes.mjs';
import { digest } from '../../../packages/sdk/src/journal.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';

async function until(check, label) { const end = Date.now() + 12000; while (Date.now() < end) { if (check()) return; await delay(5); } throw new Error(`prefix fixture timeout: ${label}`); }
const model = { providerId: 'wire', modelId: 'wire', protocol: 'openai', baseUrl: 'https://wire.invalid/v1', contextWindow: 128000, maxOutputTokens: 2048 };
// Provider-visible wire body, exactly as streamCompletion would send it.
const wire = request => buildRequest({ model, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, cache: request.cache }).body;
const sharedMessages = (left, right) => { let n = 0; while (n < Math.min(left.length, right.length) && JSON.stringify(left[n]) === JSON.stringify(right[n])) n++; return n; };

// Real Store, controllers, SDK journal and workspace tools; only provider
// output is scripted. Foreground: write grant. Background: read-only grant.
// `scheduled`: the project also has a daily schedule that comes due when `clock.now` moves past it (the controller reads the
// clock; the decision lane only ever waits), and the background provider files a run's requests under 'scheduled' when
// they carry the occurrence's task, so a scheduled run and a decision-started run stay apart.
async function fixture(t, { backgroundWrites = false, scheduled = false } = {}) {
  const clock = { now: Date.parse('2026-09-26T00:00:00Z') };
  const directory = mkdtempSync(join(tmpdir(), 'rna-prefix-sharing-'));
  const store = new Store(join(directory, 'state.json'));
  store.usageLedger = new UsageLedger({ file: join(directory, 'state.json.usage-cache.jsonl') });
  const provider = store.configurationService.provider(null, { name: 'Prefix fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'prefix-fixture', contextWindow: 128000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'prefix-fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Shared prefix project', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.decisionMode = 'rna-model'; target.initialization = { status: 'ready' }; target.simulated = false;
    target.permissions = { workspace: 'write', background: 'read', revision: 1 };
    // project_exec too (worktree design 0.63 §9): its description is fixed, so the sandboxed background and the
    // unsandboxed foreground still declare byte-identical tools.
    target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit', 'project_exec'], mcpServerIds: [] };
    state.settings.realTokenBudget = null;
    if (scheduled) target.schedules = [createProjectSchedule({ id: 'daily', title: 'Daily report', task: 'Read README.md and deliver the actual finding.', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: clock.now })];
  });
  writeFileSync(join(directory, 'README.md'), 'Shared prefix fixture workspace.');
  const captured = { foreground: [], background: [], scheduled: [] }, receipts = [];
  const scripted = (bucket, writes) => async function* (request) {
    captured[bucket].push(structuredClone({ systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages, cache: request.cache, purpose: request.purpose }));
    yield { type: 'usage', usage: { input: 1200, output: 5, cacheRead: bucket === 'background' ? 2400 : 0, cacheWrite: 0, totalTokens: 3605, cacheUsageReported: true } };
    if (writes && !request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: `${bucket}-write`, name: 'project_write', arguments: { path: `${bucket}.txt`, content: 'written', createOnly: true } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield { type: 'text_delta', delta: `${bucket} done` }; yield { type: 'done', stopReason: 'stop' };
  };
  let decisions = 0, foreground;
  const background = async function* (request) { yield* scripted(scheduled && JSON.stringify(request.messages).includes('Scheduled occurrence') ? 'scheduled' : 'background', backgroundWrites)(request); };
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, ...(scheduled ? { now: () => clock.now } : {}),
    foregroundToolSurface: projectId => foreground.managementSurface(projectId),
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text), first = !scheduled && decisions++ === 0;
      yield { type: 'text_delta', delta: JSON.stringify(first ? { action: 'work', reason: 'Inspect actual evidence', evidenceIds: [input.allowedEvidenceIds[0]], content: 'Inspect the workspace and record the result.', nextReviewAfterMs: 86400000 } : { action: 'wait', reason: 'Nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 }) };
      yield { type: 'usage', usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: background, onEvent: event => { if (event.type === 'tool_execution_end') receipts.push(event); options.onEvent?.(event); } }) });
  const agents = new BuiltinAgentService(store);
  foreground = new RuntimeController(store, { backgroundController: () => controller, prepareForeground: (projectId, options) => controller.prepareForeground(projectId, options), builtinAgentService: agents,
    factory: options => createRnaRuntime({ ...options, provider: scripted('foreground', false) }) });
  t.after(async () => { await foreground.close(); await controller.close(); await agents.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, project, session, directory, controller, foreground, captured, receipts, clock, job: () => store.state.projects.find(row => row.id === project.id).jobs[0], occurrence: () => store.state.projects.find(row => row.id === project.id).scheduleRuntime?.occurrences?.[0] };
}

// Token-burn T2: a scheduled run is the one background purpose that does not declare the purpose-only stubs; the
// foreground and a decision-started background run keep the full surface (the test below), a subagent is built with no
// surface option (rna-runtime-tool-tiers.test.mjs), and the scheduled run's system prompt and shared context stay the
// foreground's byte for byte (the two tests after it).
test('foreground and a decision-started background run send a byte-identical tools + system + shared-context prefix for the same project', async t => {
  const f = await fixture(t);
  await until(() => f.job()?.status === 'completed', 'background work completes');
  f.store.message(f.session.id, { text: 'Summarize the project status.' });
  await until(() => f.store.state.sessions.find(row => row.id === f.session.id).turns.at(-1)?.status === 'completed', 'foreground turn completes');
  const fg = wire(f.captured.foreground[0]), bg = wire(f.captured.background[0]);
  assert.equal(JSON.stringify(fg.tools), JSON.stringify(bg.tools), 'identical tools array (set, order and schema)');
  assert.equal(fg.messages[0].role, 'system'); assert.equal(fg.messages[0].content, bg.messages[0].content, 'identical system prompt');
  const shared = sharedMessages(fg.messages, bg.messages);
  assert.ok(shared >= 3, `system plus the seeded skill-catalog and project-orientation blocks are shared (got ${shared})`);
  assert.match(fg.messages[1].content, /capability-catalog/); assert.match(fg.messages[2].content, /workspace-orientation/);
  // TC-2: the worker's project brief follows the shared blocks (initialContextTail); it is never part of the shared prefix.
  assert.match(bg.messages[shared].content, /project-brief/); assert.doesNotMatch(JSON.stringify(fg.messages), /"source":"project-brief"/);
  // Purpose instructions and authorization are tail context, not system text.
  for (const body of [fg, bg]) {
    assert.doesNotMatch(body.messages[0].content, /project background collaborator|project collaboration assistant|Host authorization level|[Pp]roject version [0-9a-f-]{8}/);
    const tail = JSON.stringify(body.messages.slice(shared));
    assert.match(tail, /host-purpose-instructions/); assert.match(tail, /host-authorization/);
  }
  assert.match(JSON.stringify(bg.messages.slice(shared)), /readOnly\W+true/);
  // Mutating core tools stay declared for the read-only background.
  for (const name of ['project_write', 'project_edit', 'project_read', 'project_history', 'project_background_list', 'project_exec']) assert.ok(bg.tools.some(tool => tool.function.name === name), name);
  const exec = body => JSON.stringify(body.tools.find(tool => tool.function.name === 'project_exec'));
  assert.equal(exec(fg), exec(bg), 'project_exec reads the same in the sandboxed background and the foreground');
  // Delegation (design 2026-10-04 §9.3): the shared system prompt says when to delegate, and both purposes declare the
  // same agent tools; background work keeps them as stubs that refuse (intentionally unavailable there).
  for (const body of [fg, bg]) {
    assert.match(body.messages[0].content, /agent_consult \/ agent_delegate so they run in parallel[^]*finish the work within this turn/);
    for (const name of ['agent_consult', 'agent_delegate']) assert.ok(body.tools.some(tool => tool.function.name === name), name);
  }
  assert.equal(f.captured.foreground[0].cache.sessionKey, f.captured.background[0].cache.sessionKey, 'one cache routing scope per project');
  // The published prefix that tool-free JSON purposes (initiative, learning) reuse.
  const published = sharedPrefixFor(f.project.id, f.captured.foreground[0] && { providerId: f.store.state.configuration.defaultModel.providerId, modelId: 'prefix-fixture' });
  assert.equal(published.systemPrompt, f.captured.foreground[0].systemPrompt); assert.deepEqual(published.tools.map(tool => tool.name).sort(), f.captured.foreground[0].tools.map(tool => tool.name).sort());
  assert.ok(!published.initialContext.some(row => row.source === 'project-brief'), 'the published prefix stays the shared one');
  // Purpose-tagged usage: every provider request left a receipt.
  const report = cacheUsageResponse(f.store.usageLedger, new URLSearchParams({ window: '1h', projectId: f.project.id }));
  assert.deepEqual(Object.keys(report.byPurpose).sort(), ['background-work', 'foreground', 'initiative']);
  assert.equal(report.byPurpose['background-work'].cacheRead, 2400 * f.captured.background.length);
  assert.equal(report.overall.requests, f.captured.foreground.length + f.captured.background.length + report.byPurpose.initiative.requests);
});

const toolNames = body => body.tools.map(tool => tool.function.name);
const authorizationNote = body => { const text = body.messages.map(message => String(message.content)).find(content => content.includes('[{"source":"host-authorization"')); return JSON.parse(JSON.parse(text.slice(text.indexOf('[{"source":"host-authorization"')))[0].text); };
async function scheduledRun(f) {
  f.store.message(f.session.id, { text: 'Summarize the project status.' });
  await until(() => f.store.state.sessions.find(row => row.id === f.session.id).turns.at(-1)?.status === 'completed', 'foreground turn completes');
  f.clock.now += 3600000; f.controller.schedule(); // 09:00 in Shanghai: the occurrence is due
  await until(() => f.occurrence()?.status === 'delivered', 'the scheduled occurrence is delivered');
  return { fg: wire(f.captured.foreground[0]), sched: wire(f.captured.scheduled[0]), job: f.job() };
}

test('a scheduled run declares only the executable tools; its system prompt and shared context are the foreground\'s, and it does not replace the published prefix', async t => {
  const f = await fixture(t, { scheduled: true });
  const { fg, sched, job } = await scheduledRun(f);
  const leanNote = authorizationNote(sched), declared = toolNames(sched);
  assert.ok(leanNote.notDeclaredHere.length >= 10 && leanNote.notDeclaredHere.includes('agent_consult'), `the purpose-only stubs are named as not declared (${JSON.stringify(leanNote.notDeclaredHere)})`);
  assert.equal(leanNote.notDeclaredRule, 'Tools in notDeclaredHere are not available in this run; do not call them.');
  assert.deepEqual(toolNames(fg).filter(name => !leanNote.notDeclaredHere.includes(name)), declared, 'the scheduled array is the foreground array without the stubs, in the same order');
  assert.deepEqual([...leanNote.executableTools, ...leanNote.declaredButUnavailable].sort(), [...declared].sort(), 'every declared tool is listed as executable or as declared-but-refused; none of the stubs is');
  for (const name of ['project_read', 'project_write', 'project_exec', 'project_history']) assert.ok(declared.includes(name), `${name} is still declared`);
  assert.ok(declared.length < toolNames(fg).length && !declared.includes('agent_consult') && !declared.includes('project_schedule'));
  assert.equal(sched.messages[0].content, fg.messages[0].content, 'identical system prompt: the delegation paragraph is still there');
  assert.equal(sharedMessages(fg.messages, sched.messages), 3, 'system + skill catalog + orientation are shared; the brief follows');
  assert.match(sched.messages[3].content, /project-brief/);
  assert.equal(f.captured.scheduled[0].cache.sessionKey, f.captured.foreground[0].cache.sessionKey, 'one cache routing scope per project');
  // The project's published prefix stays the foreground's: learning and the compaction-fork probe read it.
  const published = sharedPrefixFor(f.project.id, { providerId: f.store.state.configuration.defaultModel.providerId, modelId: 'prefix-fixture' });
  assert.deepEqual(published.tools.map(tool => tool.name).sort(), f.captured.foreground[0].tools.map(tool => tool.name).sort(), 'the published array is the full one');
  assert.ok(published.tools.some(tool => tool.name === 'agent_consult'));
  assert.equal(job.surface, 'executable', 'the job records the surface the run began with');
});

test('RNA_SCHEDULED_SURFACE=full rolls a new scheduled run back to the foreground\'s array', async t => {
  const previous = process.env.RNA_SCHEDULED_SURFACE; process.env.RNA_SCHEDULED_SURFACE = 'full';
  t.after(() => { if (previous === undefined) delete process.env.RNA_SCHEDULED_SURFACE; else process.env.RNA_SCHEDULED_SURFACE = previous; });
  const f = await fixture(t, { scheduled: true });
  const { fg, sched, job } = await scheduledRun(f);
  assert.equal(JSON.stringify(sched.tools), JSON.stringify(fg.tools), 'identical tools array');
  assert.equal(sched.messages[0].content, fg.messages[0].content);
  assert.equal(authorizationNote(sched).notDeclaredHere, undefined);
  assert.equal(job.surface, 'full');
});

test('a read-only background grant rejects a declared write at execution with a machine-readable receipt', async t => {
  const f = await fixture(t, { backgroundWrites: true });
  await until(() => f.job() && ['completed', 'failed'].includes(f.job().status), 'background work settles');
  const receipt = f.receipts.find(event => event.toolName === 'project_write');
  assert.ok(receipt, 'the model call reached execution-time enforcement');
  assert.equal(receipt.isError, true); assert.equal(receipt.result.details.code, 'authorization_read_only'); assert.equal(receipt.result.details.executed, false);
  assert.match(receipt.result.content[0].text, /Read-only authorization: writes are rejected/);
  assert.equal(existsSync(join(f.directory, 'background.txt')), false, 'nothing was written');
});

// EVO-3: a skills-only generation renames nothing, so the published cross-purpose prefix (system + tools) and the
// foreground tools array stay byte-identical across it; before, every generation renamed every generated tool.
test('a skills-only generation keeps the shared prefix: same tool names and the same digest of system and tools', async t => {
  const f = await fixture(t);
  await until(() => f.job()?.status === 'completed', 'background work completes');
  const genomes = new ProjectGenomeStore(f.store), prepared = await genomes.prepare(f.project, { genome: projectGenomeFixture(), versionId: 'baseline' }); await prepared.commit();
  f.store.mutate(state => {
    const target = state.projects.find(row => row.id === f.project.id);
    target.versions = [{ id: 'baseline', version: '0.1.0', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: new Date().toISOString(), simulated: false }];
    target.activeVersionId = 'baseline';
    target.assignments = { ...target.assignments, skillIds: prepared.skillManifests.map(row => row.id), toolIds: [...target.assignments.toolIds, ...prepared.toolDescriptors.map(row => row.id)] };
    state.capabilities ??= { skills: [], tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills = [...(state.capabilities.skills ?? []), ...prepared.skillManifests];
  });
  const turn = async text => { const count = f.captured.foreground.length; f.store.message(f.session.id, { text }); await until(() => f.store.state.sessions.find(row => row.id === f.session.id).turns.at(-1)?.status === 'completed' && f.captured.foreground.length > count, text); return f.captured.foreground.at(-1); };
  const fixtureModel = { providerId: f.store.state.configuration.defaultModel.providerId, modelId: 'prefix-fixture' };
  const before = await turn('Use the project skill.'), published = sharedPrefixFor(f.project.id, fixtureModel);
  assert.ok(before.tools.some(tool => /^gen_[a-f0-9]{8}_estimate_scope$/.test(tool.name)), 'the generated tool is declared');
  await new GeneStore(f.store).commitGeneration(f.project.id, { summary: 'Skill note', change: genome => { genome.skills[0].instructions += '\nOne more rule.'; return genome; } });
  assert.notEqual(f.store.state.projects.find(row => row.id === f.project.id).activeVersionId, 'baseline');
  const after = await turn('Use the project skill again.'), republished = sharedPrefixFor(f.project.id, fixtureModel);
  assert.deepEqual(republished.tools.map(tool => tool.name), published.tools.map(tool => tool.name));
  assert.equal(digest({ systemPrompt: republished.systemPrompt, tools: republished.tools }), digest({ systemPrompt: published.systemPrompt, tools: published.tools }));
  assert.equal(JSON.stringify(wire(after).tools), JSON.stringify(wire(before).tools), 'the foreground tools array is byte-identical');
});
