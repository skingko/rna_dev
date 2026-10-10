import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { features, reuseRows, reuseSummary, deadlineRows, requestRows, promptRows, loadProjects, benchmarkChecks, renders, FALSE_DEADLINE_REASON } from '../benchmark/handoff-vs-output.mjs';
import { WORKER_COPY_NOTE } from '../work-run-text.mjs';

// The W1 equivalence benchmark (benchmark/handoff-vs-output.mjs): its measurements on records of the shape the saved state
// has. The real-data run is in the work report; these hold the arithmetic and the checks it makes.
const job = (id, extra = {}) => ({ id, status: 'completed', createdAt: '2026-10-05T05:41:00.000Z', completedAt: '2026-10-05T05:55:00.000Z', instruction: 'Review the register and report.', output: '', handoff: '', ...extra });

test('features: URLs, English words of 7+ characters (lower-cased), and every 4-character run of Chinese', () => {
  const found = features('Read https://example.test/a?b=1 and the Register_File now. 第七条登记写好了，ok');
  assert.ok(found.has('https://example.test/a?b=1') && found.has('register_file'));
  assert.ok(!found.has('now') && !found.has('ok'), 'short words are not features');
  for (const gram of ['第七条登', '七条登记', '条登记写', '登记写好', '记写好了']) assert.ok(found.has(gram), gram);
  assert.ok(!found.has('好了，ok'), 'a run stops at punctuation');
});

test('channel rows: a decision that reuses what only the final reply said read past the handoff line; one that reuses only the handoff did not', () => {
  const reply = 'The new entry reads: the harbour_ferry never docked at pier_nine, according to https://harbour.test/log. 渡轮没有靠岸，码头记录空白。\nHandoff line.';
  const project = { id: 'p1aaaaaa', decisions: [
    { at: '2026-10-05T06:00:00Z', action: 'share', reason: 'The entry says the harbour_ferry never docked at pier_nine (https://harbour.test/log).', content: '渡轮没有靠岸，码头记录空白。', evidenceIds: ['action:aaaa1111:completed'] },
    { at: '2026-10-05T06:10:00Z', action: 'wait', reason: 'Only the handoff: checked the register.', content: '', sourceIds: ['action:bbbb2222:completed'] },
    { at: '2026-10-05T06:20:00Z', action: 'wait', reason: 'A completion nothing cites a job for.', content: '', evidenceIds: ['action:ghost:completed'] },
  ], jobs: [
    job('aaaa1111', { output: reply, handoff: 'checked the register and wrote the entry' }),
    job('bbbb2222', { output: 'Checked the register_values carefully and found nothing unusual in them.', handoff: 'Only the handoff: checked the register.' }),
    job('schedule-work-cc01', { output: 'The report.', handoff: 'reported', status: 'completed' }),
    job('cccc3333', { status: 'failed', output: 'x' }),
  ] };
  const rows = reuseRows([project], { prefix: 'p1' });
  assert.deepEqual(rows.map(row => [row.job, row.kind, row.next]), [['aaaa1111', 'decision', 'share'], ['bbbb2222', 'decision', 'wait']], 'only completed jobs a later decision cites');
  assert.ok(rows[0].reused >= 3, `reused ${rows[0].reused}`); assert.equal(rows[1].reused, 0);
  assert.ok(rows[0].examples.length <= 6);
  const summary = reuseSummary(rows);
  assert.deepEqual([summary.jobsCited, summary.readPastHandoff3, summary.decisionStartedWithHandoff.jobs, summary.decisionStartedWithHandoff.readPastHandoff3, summary.scheduledWithHandoff.jobs], [2, 1, 2, 1, 0]);
  assert.deepEqual(reuseRows([project], { prefix: 'zz' }), [], 'the project filter');
});

test('deadline rows: an action_timeout job recorded the context-change sentence; the same stop now names its limit, and status and error code are not touched', () => {
  const stopped = job('dddd4444', { status: 'cancelled', errorCode: 'action_timeout', createdAt: '2026-10-02T07:18:47.760Z', completedAt: '2026-10-02T07:48:47.641Z', handoff: '已中断：核对时间线；项目上下文变化或收到停止指令，已完成的读取保留在执行记录中。', output: '收到新的项目上下文或暂停指令，后台检查已中断。' });
  const unsure = job('eeee5555', { status: 'cancelled', errorCode: 'uncertain_tool', createdAt: '2026-10-02T08:37:26.113Z', completedAt: '2026-10-02T09:07:26.041Z' }), quick = job('ffff6666', { status: 'cancelled', errorCode: 'uncertain_tool', createdAt: '2026-10-02T16:30:49.317Z', completedAt: '2026-10-02T16:45:21.732Z' });
  const { rows, probable } = deadlineRows([{ id: 'p2bbbbbb', jobs: [stopped, unsure, quick, job('gggg7777')] }]);
  assert.equal(rows.length, 1); assert.deepEqual([rows[0].job, rows[0].status, rows[0].errorCode, rows[0].ranMinutes], ['dddd4444', 'cancelled', 'action_timeout', 30]);
  assert.equal(rows[0].before.sayContextChange, true); assert.equal(rows[0].after.sayContextChange, false); assert.equal(rows[0].after.nameLimit, true);
  assert.equal(rows[0].after.keys, 'handoff,output', 'the recomputation yields texts only');
  assert.match(rows[0].after.zh.handoff, /^已到 30 分钟时限被停止：Review the register and report\.；/); assert.match(rows[0].after.en.handoff, /^Stopped at the 30-minute limit: /);
  assert.doesNotMatch(`${rows[0].after.zh.handoff}${rows[0].after.zh.output}${rows[0].after.en.handoff}${rows[0].after.en.output}`, FALSE_DEADLINE_REASON);
  assert.deepEqual(probable.map(row => [row.job, row.ranMinutes]), [['eeee5555', 30]], 'an unfinished tool at exactly 30 minutes is a probable deadline stop; a 14-minute one is not');
});

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-w1-benchmark-')), store = new Store(join(dir, 'state.json'));
  const model = store.configurationService.provider(null, { name: 'Benchmark fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: model.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoStore: false, autoRecall: false } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Benchmark fixture', workspace: dir, description: 'Keep the register current.' });
  store.mutate(state => { const row = state.projects.find(p => p.id === project.id); Object.assign(row, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', permissions: { workspace: 'write', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read', 'project_write'], mcpServerIds: [] } }); row.initiative.tokenBudget = null; });
  writeFileSync(join(dir, 'a.md'), 'x');
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, decisionProvider: async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'Nothing to do', evidenceIds: [], content: '', nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 400 && !store.state.projects.find(p => p.id === project.id).initiativeRuntime?.sdkState; i++) await delay(10);
  return { store, dir, project: () => store.state.projects.find(p => p.id === project.id) };
}

test('request rows: decision snapshots never carry the copy note; a plain brief has none; a brief in a worktree gains exactly that key', async t => {
  const f = await fixture(t), rows = await requestRows([f.project()], f.store.state);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.decisionHasNote, false); assert.equal(row.decisionIsolatedHasNote, false, 'nor the decision rendered with the isolation answer true'); assert.equal(row.plainBriefHasNote, false);
  assert.equal(row.isolatedAddsOnlyTheNote, true, 'the isolated brief minus its work.workspace is the plain brief, byte for byte');
  assert.equal(row.volatileIdentical, true);
  assert.equal(row.addedBytes, Buffer.byteLength(`,"workspace":${JSON.stringify(WORKER_COPY_NOTE)}`), 'the one key and its value');
  assert.equal(row.decisionIdentical, null); assert.equal(row.decisionIsolatedIdentical, null); assert.equal(row.isolatedMatchesBaseline, null, 'no baseline given: nothing compared with one');
  // With the code itself as the "baseline" the comparison runs and everything is identical but the note.
  const same = await requestRows([f.project()], f.store.state, { baseline: fileURLToPath(new URL('../../..', import.meta.url)) });
  assert.deepEqual([same[0].decisionIdentical, same[0].decisionIsolatedIdentical, same[0].plainBriefIdentical, same[0].isolatedMatchesBaseline], [true, true, true, false], 'the brief is the same; the isolated one differs from itself only by the note');
});

test('renders: the decision snapshot is rendered with the project\'s isolation answer false and true, and the brief for a run in the folder and for one in its own copy', () => {
  // A controller that shows what it was asked under: the isolation answer at snapshot() time, and the answer and `copy` of workerBrief().
  const controller = { snapshot() { return { isolationAnswer: this.isolatedProject('p') }; }, workerBrief(_project, { copy }) { return { stable: { answer: this.isolatedProject('p'), copy }, volatile: { answer: this.isolatedProject('p') } }; } };
  const out = renders(controller, { id: 'p' });
  assert.equal(out.decision, '{"isolationAnswer":false}'); assert.equal(out.decisionIsolated, '{"isolationAnswer":true}', 'production has the answer true wherever worktrees are on: the decision is checked under it too');
  assert.deepEqual([out.plain.parsed, out.isolated.parsed], [{ answer: false, copy: false }, { answer: true, copy: true }], 'a plain run is not in a copy, an isolated one is');
  assert.equal('isolatedProject' in controller, false, 'the override is taken off again');
});

test('checks: a check that compared nothing is null, not a pass; ok needs every check to have run and held', () => {
  const good = { rows: [{ kind: 'decision', reused: 4 }], deadline: { rows: [{ before: { sayContextChange: true }, after: { nameLimit: true, sayContextChange: false, oneLine: true, keys: 'handoff,output' } }] },
    requests: [{ decisionHasNote: false, decisionIsolatedHasNote: false, decisionIdentical: true, decisionIsolatedIdentical: true, plainBriefHasNote: false, plainBriefIdentical: true, isolatedAddsOnlyTheNote: true, volatileIdentical: true, isolatedMatchesBaseline: true }],
    prompt: { sentenceReplaced: true, handoffContractKept: true, noteNamesHandoffLine: true, baselineHadSentence: true } };
  const all = benchmarkChecks(good);
  assert.deepEqual([all.ok, all.failed, all.notCompared], [true, [], []], 'everything compared and held');
  // The AI project alone: no action_timeout job, so the deadline wording was not checked on anything. Before: every() over [] was true.
  const noDeadline = benchmarkChecks({ ...good, deadline: { rows: [] } });
  assert.equal(noDeadline.deadlineRowsFixed, null); assert.equal(noDeadline.ok, false); assert.deepEqual(noDeadline.notCompared, ['deadlineRowsFixed']);
  // No baseline: the byte comparisons have nothing to compare; the note checks (current code alone) still run.
  const noBaseline = benchmarkChecks({ ...good, requests: [{ ...good.requests[0], decisionIdentical: null, decisionIsolatedIdentical: null, plainBriefIdentical: null, isolatedMatchesBaseline: null }] });
  assert.deepEqual(noBaseline.notCompared, ['decisionsUnchanged', 'plainBriefsUnchanged', 'isolatedBriefMatchesBaseline']);
  assert.deepEqual([noBaseline.decisionsCarryNoNote, noBaseline.plainBriefsCarryNoNote, noBaseline.isolatedBriefOnlyGains], [true, true, true]);
  assert.equal(noBaseline.ok, false, 'unproven is not ok');
  // Nothing to render at all (no project with initiative state): nothing on requests passes by default.
  const none = benchmarkChecks({ rows: [], deadline: { rows: [] }, requests: [], prompt: good.prompt });
  assert.deepEqual(none.notCompared, ['channelExists', 'deadlineRowsFixed', 'decisionsCarryNoNote', 'decisionsUnchanged', 'plainBriefsCarryNoNote', 'plainBriefsUnchanged', 'isolatedBriefOnlyGains', 'isolatedBriefMatchesBaseline']);
  // A failure is false and listed; the decision changed only in the isolated rendering is caught.
  const changed = benchmarkChecks({ ...good, requests: [{ ...good.requests[0], decisionIsolatedIdentical: false }] });
  assert.deepEqual([changed.decisionsUnchanged, changed.ok, changed.failed], [false, false, ['decisionsUnchanged']]);
  const leaked = benchmarkChecks({ ...good, requests: [{ ...good.requests[0], decisionIsolatedHasNote: true }] });
  assert.deepEqual(leaked.failed, ['decisionsCarryNoNote']);
  assert.deepEqual(benchmarkChecks({ ...good, prompt: { ...good.prompt, baselineHadSentence: false } }).failed, ['promptSentenceReplaced'], 'a baseline that is not the pre-W1 code is a failure');
});

test('the command exits 3, not 0, when some check had nothing to compare; 0 only when every check ran and held', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-w1-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'projects.json'), script = fileURLToPath(new URL('../benchmark/handoff-vs-output.mjs', import.meta.url));
  writeFileSync(file, JSON.stringify([{ id: 'p9aaaaaa', jobs: [], decisions: [] }]));
  const run = spawnSync(process.execPath, [script, file, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(run.stdout);
  assert.equal(report.checks.deadlineRowsFixed, null); assert.equal(report.checks.ok, false); assert.deepEqual(report.checks.failed, []);
  assert.equal(run.status, 3, 'unproven, not failed');
});

test('prompt rows read the controller source; loadProjects takes a projects array, a state object or a state file', async t => {
  assert.deepEqual(Object.fromEntries(Object.entries(promptRows()).filter(([key]) => key !== 'noteChars')), { sentenceReplaced: true, baselineHadSentence: null, handoffContractKept: true, noteNamesHandoffLine: true });
  const dir = mkdtempSync(join(tmpdir(), 'rna-w1-load-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const array = join(dir, 'projects.json'), object = join(dir, 'state-plain.json');
  writeFileSync(array, JSON.stringify([{ id: 'p1' }])); writeFileSync(object, JSON.stringify({ projects: [{ id: 'p2' }], sessions: [] }));
  assert.deepEqual((await loadProjects(array)).projects.map(row => row.id), ['p1']);
  assert.deepEqual((await loadProjects(object)).projects.map(row => row.id), ['p2']);
  const f = await fixture(t);
  assert.ok((await loadProjects(join(f.dir, 'state.json'))).projects.length >= 1, 'a (sharded) state file');
});
