import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../store.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';
import { ProjectEvolutionRrsi, systemEvolutionAggregate, proposeSystemEvolution } from '../project-evolution-rrsi.mjs';
import { ProjectGenomeGit, genomeFiles, componentPath } from '../project-genome-git.mjs';
import { classifyEvolutionFailure, classifyEvolutionFailures } from '../project-evolution-failures.mjs';
import { evolutionApiRoute } from '../evolution-api.mjs';
import { projectGenomeFixture, genomeEvaluationProvider, diagnosisFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';

const model = { providerId: 'local-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-evolution-rrsi-')); const store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'RRSI evolution', workspace: dir, initiative: { enabled: false } });
  const genomes = new ProjectGenomeStore(store), prepared = await genomes.prepare(project, { genome: options.genome ?? projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  store.mutate(state => { const current = state.projects.find(item => item.id === project.id); current.simulated = false; current.decisionMode = 'rna-model'; current.initialization = { status: 'ready' }; current.versions.find(version => version.id === current.activeVersionId).bundle = prepared.record; });
  const calls = [], service = new ProjectEvolutionService(store, { genomeStore: genomes, provider: genomeEvaluationProvider({ calls, ...options }), ...(options.decisionService ? { decisionService: options.decisionService } : {}) });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, service, genomes, calls, projectId: project.id, current: () => store.state.projects.find(item => item.id === project.id) };
}

test('every evolution outcome becomes tagged per-edit history; a hypothesis falsified on this incumbent is blocked by the critic', async t => {
  const app = await setup(t, { badCandidate: true }), evidence = [{ id: 'external-feedback', summary: 'A user observed missing evidence.' }];
  const first = await app.service.evolve(app.projectId, { model, evidence });
  assert.equal(first.status, 'rejected');
  const records = await app.service.rrsi.records(app.projectId);
  // An early-stopped rejection (deterministic/script checks) has no score delta but still falsifies the hypothesis.
  assert.ok(records.length >= 1); assert.ok(records.every(row => row.verdict === 'rejected' && row.editId && row.component && row.hypothesisKey && 'deltaS' in row));
  assert.deepEqual(records[0].context.baseline, app.current().versions.find(row => row.id === app.current().activeVersionId).bundle.hash);
  assert.equal(first.version.rrsi.tiers[0].tier, 'critic'); assert.equal(first.version.rrsi.tiers.at(-1).tier, 'full');
  assert.ok(first.version.genomeGit.commit && first.version.genomeGit.branch.startsWith('cand/'));
  // New evidence, same incumbent and model: the same falsified hypothesis cannot be re-proposed (one repair, then unmeasured rejection).
  const calls = app.calls.length, second = await app.service.evolve(app.projectId, { model, evidence: [...evidence, { id: 'another', summary: 'More of the same.' }] });
  assert.equal(second.status, 'rejected'); assert.equal(second.version.error.code, 'critic_rejected'); assert.equal(second.version.assessment.category, 'rrsi_screened');
  assert.ok(second.version.rrsi.critic.reasons.some(row => row.code === 'falsified_hypothesis')); assert.equal(app.calls.length, calls + 2, 'no evaluation was bought');
  const after = await app.service.rrsi.records(app.projectId); assert.ok(after.some(row => row.verdict === 'critic_rejected' && row.deltaS === null));
  // An explicit retry is never blocked by history.
  const retried = await app.service.evolve(app.projectId, { model, evidence, retryFailed: true }); assert.notEqual(retried.version.error?.code, 'critic_rejected');
  const directives = await app.service.rrsi.directives(app.projectId, {}); assert.ok(directives.falsified.length >= 1); assert.ok(directives.untried.length >= 1);
});

test('the author receives RRSI directives once history exists, and the edit budget tightens the search scope', async t => {
  const app = await setup(t); let seen;
  const first = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'one', summary: 'first observation' }] }); assert.equal(first.status, 'ready');
  const original = app.service.provider;
  app.service.provider = async function* (request) { if (request.systemPrompt.includes('Create one improved executable project agent')) seen = JSON.parse(request.messages[0].content[0].text).project.evolutionDirectives; yield* original(request); };
  await app.service.evolve(app.projectId, { model, evidence: [{ id: 'two', summary: 'second observation' }] });
  assert.ok(seen); assert.ok(seen.editBudget >= 1 && seen.editBudget <= 4); assert.match(seen.guidance, /Edit budget/); assert.ok(Array.isArray(seen.untriedComponents));
  const changelog = await app.service.rrsi.changelog(app.projectId); assert.ok(changelog.length >= 1); assert.match(changelog[0].title, /^Rna /);
});

test('a confident negative JEV prior skips paid evaluation but cannot adopt; the smoke tier stops regressions on larger suites', async t => {
  const decisionService = { prescoreCandidate: async () => ({ source: 'judge', better: false, probability: 0.05 }) };
  const app = await setup(t, { decisionService });
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'jev', summary: 'observation' }] });
  assert.equal(result.status, 'rejected'); assert.equal(result.version.error.code, 'prescreen_skipped'); assert.equal(result.version.evaluation ?? null, null);
  assert.ok(app.calls.every(request => !JSON.stringify(request.messages).includes('frozen evaluation')), 'no evaluation request');
  assert.deepEqual(result.version.rrsi.tiers.map(row => `${row.tier}:${row.status}`), ['critic:passed', 'prescreen:failed']);
  const positive = await setup(t, { decisionService: { prescoreCandidate: async () => ({ source: 'judge', better: true, probability: 0.9 }) } });
  const accepted = await positive.service.evolve(positive.projectId, { model, evidence: [{ id: 'jev2', summary: 'observation' }] });
  assert.equal(accepted.status, 'ready'); assert.equal(accepted.version.rrsi.prescore.better, true); assert.equal(accepted.version.state, 'ready', 'a positive prior never adopts; trial/adopt stay explicit');
  // Larger suites run a 3-case smoke tier first; a failing smoke stops before the full paired evaluation.
  const genome = projectGenomeFixture(); genome.evaluationSuite.cases = [...genome.evaluationSuite.cases, ...genome.evaluationSuite.cases.slice(0, 5 - genome.evaluationSuite.cases.length).map((row, index) => ({ ...structuredClone(row), id: `extra_case_${index}` }))];
  const large = await setup(t, { genome, badCandidate: true }), smoked = await large.service.evolve(large.projectId, { model, evidence: [{ id: 'smoke', summary: 'observation' }] });
  assert.equal(smoked.status, 'rejected'); assert.equal(smoked.version.evaluation.evaluationComplete, false); assert.ok(smoked.version.evaluation.skippedCases >= 2, 'later cases were not bought');
  const smokeTier = smoked.version.rrsi.tiers.find(row => row.tier === 'smoke'); assert.equal(smokeTier.status, 'failed'); assert.equal(smokeTier.cases.length, 3);
  assert.ok(!smoked.version.rrsi.tiers.some(row => row.tier === 'full'));
  const smokeRecords = await large.service.rrsi.records(large.projectId); assert.ok(smokeRecords.every(row => row.verdict === 'smoke_failed'));
});

test('genome git: candidates in worktrees, adopt fast-forwards, rollback reverts, per-component log', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-genome-git-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = { file: join(dir, 'state.json') }, git = new ProjectGenomeGit(store), baseline = projectGenomeFixture(), candidate = structuredClone(baseline);
  candidate.systemPrompt = `${baseline.systemPrompt}\n## Output\nLead with the conclusion.`;
  const project = { assignments: { mcpServerIds: [] }, rhythm: { control: 'auto' } };
  const cand = await git.candidate('p1', { baseline, genome: candidate, project, versionId: 'v2', parentVersionId: 'v1', message: 'candidate v2', edits: [{ component: 'system_section', key: 'system_section:output', change: 'added', hypothesis: 'conclusion first' }] });
  assert.equal(cand.branch, 'cand/v2'); assert.match(cand.diff, /Lead with the conclusion/);
  const repo = git.dir('p1'); assert.ok(repo.endsWith(join('p1', 'rrsi', 'genome')));
  const head = () => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  const adopted = await git.adopt('p1', 'v2', { genome: candidate, project }); assert.equal(adopted.mode, 'fast_forward'); assert.equal(adopted.commit, cand.commit); assert.equal(head(), cand.commit);
  const rolled = await git.rollback('p1', 'v2', { genome: baseline, project, versionId: 'v1' }); assert.equal(rolled.mode, 'revert'); assert.notEqual(rolled.commit, cand.commit);
  assert.throws(() => execFileSync('git', ['-C', repo, 'show', 'HEAD:system/output.md'], { stdio: ['ignore', 'pipe', 'ignore'] }), 'the reverted section is gone from main');
  assert.match(execFileSync('git', ['-C', repo, 'show', `${cand.commit}:system/output.md`]).toString(), /Lead with the conclusion/);
});

test('genome git history per component and file layout cover every registry component', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-genome-git-log-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = new ProjectGenomeGit({ file: join(dir, 'state.json') }), genome = projectGenomeFixture(), project = { assignments: { mcpServerIds: ['browser'] }, rhythm: { control: 'auto' }, initiative: { minRelevance: 0.5 } };
  const files = genomeFiles({ genome, project, versionId: 'v1' });
  for (const path of ['agent/mcp.json', 'agent/rhythm.json', 'agent/communication.json', 'evaluation/standard.json', 'GENOME.json']) assert.ok(files.has(path), path);
  assert.ok([...files.keys()].some(path => path.startsWith('skills/') && path.endsWith('SKILL.md'))); assert.ok([...files.keys()].some(path => path.startsWith('system/')));
  await git.snapshot('p2', { genome, project, versionId: 'v1' });
  const next = structuredClone(genome); next.skills[0].instructions += '\nNew rule.'; await git.snapshot('p2', { genome: next, project, versionId: 'v2' });
  const log = await git.log('p2', { key: `skill:${genome.skills[0].id}` }); assert.equal(log.length, 2); assert.equal(componentPath('mcp_assignment:x'), 'agent/mcp.json');
  assert.deepEqual(await git.log('p2', { key: 'tool_description:missing' }), []);
});

test('failure classification separates infra, author and eval causes', () => {
  const v = (state, code, phase, kind, message = '') => ({ id: `${code}-${kind}`, state, simulated: false, error: { code, message, diagnostic: { phase, kind } } });
  assert.equal(classifyEvolutionFailure(v('failed', 'connection', 'proposal', 'connection')).class, 'infra');
  assert.equal(classifyEvolutionFailure(v('interrupted', 'closed', 'candidate', 'closed')).cause, 'interrupted_closed');
  assert.equal(classifyEvolutionFailure(v('failed', 'invalid_output', 'proposal', 'invalid_json')).cause, 'author_output_format');
  assert.equal(classifyEvolutionFailure(v('failed', 'invalid_output', 'proposal', 'invalid_output', 'Diagnosis references evidence that was not supplied')).cause, 'author_unsupported_evidence');
  assert.equal(classifyEvolutionFailure(v('failed', 'invalid_judge', 'judge', 'invalid_judge')).cause, 'judge_output_schema');
  assert.equal(classifyEvolutionFailure(v('failed', 'step_limit', 'candidate', 'step_limit')).cause, 'eval_execution_step_limit');
  const all = classifyEvolutionFailures([{ id: 'p', versions: [v('failed', 'connection', 'proposal', 'connection'), v('failed', 'invalid_output', 'proposal', 'empty_response'), { id: 'ok', state: 'ready', simulated: false }] }]);
  assert.deepEqual(all.byClass, { infra: 1, author: 1 }); assert.equal(all.versionStates.ready, 1);
});

test('evolution API exposes changelog, components, history, signals, failures, task types and a manual system proposal', async t => {
  const app = await setup(t);
  await app.service.evolve(app.projectId, { model, evidence: [{ id: 'api', summary: 'observation' }] });
  const route = (method, pathname, body = {}, query = '') => evolutionApiRoute({ method, pathname, searchParams: new URLSearchParams(query), store: app.store, evolution: app.service, readBody: async () => body });
  const changelog = await route('GET', `/api/v2/projects/${app.projectId}/evolution/changelog`); assert.equal(changelog.status, 200); assert.ok(changelog.body.entries.length >= 1);
  const components = await route('GET', `/api/v2/projects/${app.projectId}/evolution/components`); assert.ok(components.body.components.some(row => row.component === 'skill')); assert.ok(components.body.components.some(row => row.component === 'communication_style'));
  const key = components.body.components.find(row => row.component === 'skill').key, one = await route('GET', `/api/v2/projects/${app.projectId}/evolution/components`, {}, `key=${encodeURIComponent(key)}`); assert.equal(one.body.components.length, 1); assert.ok(Array.isArray(one.body.git));
  const history = await route('GET', `/api/v2/projects/${app.projectId}/evolution/history`); assert.ok(history.body.records.length >= 1); assert.ok(history.body.budget >= 1); assert.equal(history.body.config.wReal, 0.8);
  const signals = await route('GET', `/api/v2/projects/${app.projectId}/evolution/signals`); assert.equal(signals.status, 200); assert.ok('counts' in signals.body);
  assert.equal((await route('GET', `/api/v2/projects/${app.projectId}/evolution/failures`)).body.total, 0);
  const types = await route('PATCH', `/api/v2/projects/${app.projectId}/task-types`, { taskTypes: ['coding', 'research'] }); assert.deepEqual(types.body.taskTypes, ['coding', 'research']); assert.deepEqual(app.current().taskTypes, ['coding', 'research']);
  await assert.rejects(route('PATCH', `/api/v2/projects/${app.projectId}/task-types`, { taskTypes: ['bogus'] }), { code: 'task_types_invalid' });
  const system = await route('GET', '/api/v2/evolution/system'); assert.equal(system.body.autoAdopt, false);
  const proposal = await route('POST', '/api/v2/evolution/system/proposals', { note: 'manual check' }); assert.equal(proposal.status, 201); assert.equal(proposal.body.status, 'proposed'); assert.equal(proposal.body.autoAdopt, false);
  assert.equal(await route('GET', '/api/v2/unrelated'), null);
});

test('trial adoption and rollback become real verdicts and changelog entries', async t => {
  const app = await setup(t);
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'trial', summary: 'observation' }] }); assert.equal(result.status, 'ready');
  app.store.version(app.projectId, result.version.id, 'trial'); app.store.version(app.projectId, result.version.id, 'adopt');
  const adopted = await app.service.rrsi.onVersionControl(app.projectId, result.version.id, 'adopt'); assert.ok(adopted.recorded.recorded >= 1); assert.equal(adopted.git.mode, 'fast_forward');
  app.store.version(app.projectId, result.version.id, 'rollback');
  const rolled = await app.service.rrsi.onVersionControl(app.projectId, result.version.id, 'rollback'); assert.equal(rolled.recorded.verdict, 'trial_rolled_back'); assert.equal(rolled.git.mode, 'revert');
  const log = await app.service.rrsi.changelog(app.projectId); assert.ok(log.some(row => row.verdict === 'trial_adopted' && /学到了/.test(row.title))); assert.ok(log.some(row => row.verdict === 'trial_rolled_back'));
  const directives = await app.service.rrsi.directives(app.projectId, {}); assert.ok(directives.falsified.some(row => row.verdict === 'trial_rolled_back'));
});

test('history of a version whose source session was deleted is redacted when read', async t => {
  const app = await setup(t);
  const result = await app.service.evolve(app.projectId, { model, evidence: [{ id: 'gone', summary: 'observation' }] });
  app.store.mutate(state => { state.projects.find(row => row.id === app.projectId).versions.find(row => row.id === result.version.id).sourceDeleted = true; });
  const rows = (await app.service.rrsi.records(app.projectId)).filter(row => row.versionId === result.version.id);
  assert.ok(rows.length >= 1); assert.ok(rows.every(row => row.hypothesis === '[来源已删除]' && row.sourceDeleted));
  assert.ok((await app.service.rrsi.changelog(app.projectId)).every(row => !row.title.includes('Explicit evidence interpretation')));
});

test('the system summary counts a tool\'s failures by cause, and only the model\'s own calls point at its description', async t => {
  // Live 2026-10-10: web_fetch was listed as "its description failed the model" on 5 failures; 4 were the fetch service
  // or the site, 1 an interrupted call.
  const app = await setup(t), failure = (tool, cause, minute) => ({ kind: 'tool_failure', at: new Date(Date.parse('2026-10-01T00:00:00Z') + minute * 60000).toISOString(), detail: { tool, error: 'x', ...(cause ? { cause } : {}) } });
  const signals = async (_store, projectId) => ({ projectId, counts: {}, score: { score: 0.5, signals: 0, negatives: 0 }, heldOut: 0, replay: [], signals: [
    failure('web_fetch', 'environment', 1), failure('web_fetch', 'environment', 2), failure('web_fetch', 'environment', 3), failure('web_fetch', 'interrupted', 4),
    failure('project_edit', 'call', 5), failure('project_edit', 'call', 9), failure('project_edit', 'refused', 12), failure('project_edit', undefined, 7), failure('project_write', 'call', 6)] });
  const system = await systemEvolutionAggregate(app.store, { signals });
  assert.deepEqual(system.toolFailures, { web_fetch: 4, project_edit: 4, project_write: 1 }, 'the plain counts stay as they were');
  assert.deepEqual(system.toolFailureCauses.web_fetch, { call: 0, environment: 3, refused: 0, interrupted: 1, lastAt: '2026-10-01T00:04:00.000Z' });
  assert.deepEqual(system.toolFailureCauses.project_edit, { call: 3, environment: 0, refused: 1, interrupted: 0, lastAt: '2026-10-01T00:12:00.000Z' }, 'a signal mined before causes existed counts as the model\'s call');
  const described = system.targets.filter(row => row.component === 'core_tool_description');
  assert.deepEqual(described.map(row => row.key), ['core_tool_description:project_edit']); assert.equal(described[0].evidence.failures, 3); assert.equal(described[0].evidence.lastAt, '2026-10-01T00:09:00.000Z', 'the last time the model\'s own call failed');
});
