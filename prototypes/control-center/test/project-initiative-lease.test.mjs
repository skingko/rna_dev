import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { DecisionService } from '../decision-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { finishActiveTurn } from './helpers/foreground-turn.mjs';

// PDL-2 foreground lease (docs/planning/p1-specs-20261004/prefix.md §3): a running foreground turn's own messages are
// observed but decide nothing; its conversation_result is the wake; other evidence during a turn goes through the JEV
// gate, which may hold it until the work in progress ends; queued deliveries and recovery still drain. A fake clock, a
// counting main-model provider and a scripted JEV (the real kernel and DecisionService over a fake fetch); no network.
const MINUTE = 60000;
async function until(check, label, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await delay(5); } }
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The judgment plan the first decision authors (the host requires one); its questions abstain at 0.5, so the host gate decides.
const PLAN = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does verified project evidence call for background action now?', criteria: { true: 'A concrete verified gap needs work.', false: 'Nothing verified needs work now.' } } } };

async function fixture(t, { background = 'read', workGate = null } = {}) {
  let clock = Date.parse('2026-10-04T08:00:00Z');
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-lease-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated lease fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Lease fixture novel', description: 'Write and revise chapters', workspace: directory, rhythm: { control: 'manual' }, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, permissions: { workspace: 'write', background, revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'chapter.md'), 'Chapter one.');
  // JEV: every noul from `f.answers` (0.5 when unset), likely_action from `f.answers.likely`.
  const f = { store, project, session, directory, judgments: [], decisions: [], answers: { needs_main_model: .05, evidence_relevant: .1, already_reported: .9, user_engaged: .5, likely: 'wait' }, decide: () => ({ action: 'wait' }), onJudge: null, now: () => clock, advance: ms => { clock += ms; } };
  const answerFor = questions => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'choice' ? { type: 'choice', choice: f.answers.likely, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === f.answers.likely ? .96 : .01])) } : { type: 'noul', noul: f.answers[id] ?? .5 }]));
  const service = new DecisionService(store, { now: f.now, kernelFactory: options => createDecisionKernel({ ...options, timeoutMs: 2000, fetch: async (_url, init) => { const body = JSON.parse(init.body); f.judgments.push(body); f.onJudge?.(body); return new Response(JSON.stringify({ answers: answerFor(body.questions), usage: { input_tokens: 40, output_tokens: 0 } })); } }) });
  service.update({ apiKey: 'isolated-lease-fixture-key', mode: 'active', modes: { 'initiative.review': 'active', 'initiative.gate': 'active' } });
  const controller = new ProjectInitiativeController(store, { decisionService: service, now: f.now, initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true,
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); f.decisions.push(input);
      const chosen = f.decide(input), evidenceIds = chosen.action === 'wait' ? [] : [input.allowedEvidenceIds.at(-1)];
      yield { type: 'text_delta', delta: JSON.stringify({ reason: 'Fixture decision', content: '', nextReviewAfterMs: 3600000, evidenceIds, ...chosen, ...(input.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: PLAN } : {}) }) }; yield { type: 'usage', usage: { input: 20, output: 5, totalTokens: 25 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { if (workGate) await workGate.promise; yield { type: 'text_delta', delta: 'Checked chapter.md.\n交接：核对了 chapter.md，下一步无。' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } }) });
  t.after(async () => { await service.close(); await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  Object.assign(f, { service, controller,
    current: () => store.state.projects.find(row => row.id === project.id),
    context: () => controller.contexts.get(project.id),
    wakes: () => store.state.projects.find(row => row.id === project.id).mind?.pacing?.wake?.history ?? [],
    rows: () => store.decisionLedger?.rows() ?? [],
    async settle(rounds = 3) { for (let n = 0; n < rounds; n++) { await controller.pump(); await f.context()?.reviewPromise; await delay(2); } },
    startTurn(text = 'Rewrite the ending of chapter one.') { store.message(session.id, { text }); return store.state.sessions.find(row => row.id === session.id).activeTurnId; },
    observe(id, data) { store.mutate(state => { state.projects.find(row => row.id === project.id).observations.push({ id, kind: data ? 'workspace_change' : 'external_report', text: data ? 'Project folder changed.' : 'CI reported a broken link in chapter two.', status: 'pending', createdAt: new Date(clock).toISOString(), simulated: false, ...(data ? { data: { source: { bindingId: sha([project.id, resolve(directory)]), revision: 1 }, ...data } } : {}) }); }); },
  });
  // The first review of a new context (its project state): the judge finds nothing to do.
  await until(() => f.context()?.initialized && f.judgments.length >= 1 && !f.context().reviewPromise, 'first gated review');
  await f.settle();
  return f;
}

test('1: a user message starts a turn: nothing is decided or recorded as a wake while it runs; its conversation_result is the one gated review', async t => {
  const f = await fixture(t), judged = f.judgments.length, wakes = f.wakes().length;
  f.startTurn();
  for (let n = 0; n < 10; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.ok(f.context().coordinator.state.events.some(event => event.type === 'user_message' && event.summary.includes('Rewrite the ending')), 'the message is observed');
  assert.equal(f.decisions.length, 0); assert.equal(f.judgments.length, judged, 'no judge call either'); assert.equal(f.wakes().length, wakes, 'no wake rows, zero-token ones included');
  assert.equal(f.rows().filter(row => row.reason === 'foreground_lease').length, 1);
  f.answers.needs_main_model = .95;
  finishActiveTurn(f.store, f.session.id, { reply: 'Rewrote the ending.' });
  await until(() => f.decisions.length === 1, 'the turn end wakes once'); await f.settle();
  assert.equal(f.judgments.length, judged + 1, 'exactly one gated review');
  assert.match(JSON.stringify(f.judgments.at(-1).state.review.newEvidence), /conversation_result/);
  assert.equal(f.judgments.at(-1).questions.in_progress_covers, undefined, 'no work in progress any more: v2 questions');
  assert.equal(f.decisions.length, 1);
});

test('2: a two-hour turn holds every due review: no decision, no wake row, one foreground_lease ledger row', async t => {
  const f = await fixture(t), judged = f.judgments.length, wakes = f.wakes().length;
  f.startTurn();
  for (let minute = 0; minute <= 120; minute += 10) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.equal(f.decisions.length, 0); assert.equal(f.judgments.length, judged); assert.equal(f.wakes().length, wakes);
  const holds = f.rows().filter(row => row.reason === 'foreground_lease');
  assert.equal(holds.length, 1); assert.deepEqual([holds[0].source, holds[0].disposition, holds[0].networkAttempted, holds[0].savings?.mainModelCalls], ['rule', 'deferred', false, 1]);
});

for (const covers of [true, false]) test(`3: an unrelated directory change during the turn reaches the gate with the work in progress; ${covers ? 'covered: held until the turn ends, never forced' : 'not covered and needed: one decision mid-turn'}`, async t => {
  const f = await fixture(t), judged = f.judgments.length;
  f.startTurn('Rewrite the ending of chapter one.'); await f.settle();
  Object.assign(f.answers, covers ? { in_progress_covers: .97 } : { in_progress_covers: .05, needs_main_model: .95 });
  f.observe('user-edit', { changes: [{ path: 'notes/plan.md', change: 'modified' }], totalChanges: 1 });
  await until(() => f.judgments.length === judged + 1, 'gated'); await f.settle();
  const request = f.judgments.at(-1);
  assert.ok(request.questions.in_progress_covers, 'v3 question while the turn runs');
  assert.match(request.state.review.foregroundTurn.request, /Rewrite the ending/); assert.match(JSON.stringify(request.state.review.newEvidence), /notes\/plan\.md/);
  if (!covers) { await until(() => f.decisions.length === 1, 'decided mid-turn'); assert.equal(f.decisions.length, 1); return; }
  for (let n = 0; n < 6; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.equal(f.judgments.length, judged + 1, 'held: the two-pass bound does not force it'); assert.equal(f.decisions.length, 0);
  const held = f.rows().find(row => row.disposition === 'deferred' && row.predictions?.in_progress_covers !== undefined);
  assert.deepEqual([held.predictions.in_progress_covers, held.savings.mainModelCalls], [.97, 1], 'the covered judgment is a ledger row with its probability');
  f.answers.needs_main_model = .95;
  finishActiveTurn(f.store, f.session.id, { reply: 'Done.' });
  await until(() => f.decisions.length === 1, 'reviewed when the turn ended');
});

test('4: a directory change of only the files the running turn wrote is the turn\'s own: no gate call', async t => {
  const f = await fixture(t), judged = f.judgments.length;
  const turnId = f.startTurn(); await f.settle();
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'write-1', turnId, kind: 'tool', tool: { name: 'project_write', args: { path: './chapter.md' }, status: 'succeeded' }, createdAt: new Date().toISOString(), simulated: false }); });
  f.observe('own-write', { changes: [{ path: 'chapter.md', change: 'modified' }], totalChanges: 1 });
  for (let n = 0; n < 4; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.ok(f.context().coordinator.state.events.some(event => event.id === 'observation:own-write'), 'observed');
  assert.equal(f.judgments.length, judged); assert.equal(f.decisions.length, 0);
});

test('5: a share queued during the lease drains with decisions disabled', async t => {
  const f = await fixture(t);
  f.startTurn(); await f.settle();
  f.store.presences.set(f.project.id, { sessionId: f.session.id, visible: true, typing: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  Object.assign(f.answers, { in_progress_covers: .05, needs_main_model: .95 });
  f.decide = () => ({ action: 'share', title: 'Broken link', content: 'Chapter two has a broken link to the map.' });
  f.observe('ci-report');
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'share' && row.status === 'queued'), 'share queued while typing');
  const decided = f.decisions.length;
  f.store.presences.delete(f.project.id); await f.settle();
  await until(() => f.store.state.sessions.find(row => row.id === f.session.id).items.some(item => item.source === 'initiative'), 'delivered during the lease');
  assert.equal(f.decisions.length, decided, 'drained without a decision');
  assert.equal(f.store.state.sessions.find(row => row.id === f.session.id).turns.at(-1).status, 'running');
});

test('6: a background run that completes during the lease is judged by the gate, not bypassed as a just-completed delivery', async t => {
  let release; const gate = { promise: new Promise(done => { release = done; }) };
  const f = await fixture(t, { workGate: gate });
  Object.assign(f.answers, { needs_main_model: .95, likely: 'work' }); f.decide = () => ({ action: 'work', title: 'Check chapter', content: 'Check chapter.md for broken links.' });
  f.observe('ci-report');
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'work' && row.status === 'running'), 'work running');
  f.decide = () => ({ action: 'wait' });
  f.startTurn('Revise chapter one.'); await f.settle();
  const judged = f.judgments.length, decided = f.decisions.length;
  Object.assign(f.answers, { in_progress_covers: .97, needs_main_model: .95 });
  release(); await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'work' && row.status === 'completed'), 'work completed');
  await until(() => f.judgments.length === judged + 1, 'the completion is gated'); await f.settle();
  assert.match(JSON.stringify(f.judgments.at(-1).state.review.newEvidence), /action_completed/);
  assert.ok(f.judgments.at(-1).questions.in_progress_covers);
  assert.equal(f.rows().filter(row => row.reason === 'bypass_delivery_just_completed').length, 0, 'no bypass during the turn');
  assert.equal(f.decisions.length, decided, 'covered by the turn: held');
});

for (const how of ['stop', 'pause']) test(`7: a turn ${how === 'stop' ? 'stopped' : 'paused'} (no conversation_result) ends the hold and one review follows`, async t => {
  const f = await fixture(t), judged = f.judgments.length;
  f.startTurn(); await f.settle(); f.advance(10 * MINUTE); await f.settle();
  assert.equal(f.judgments.length, judged);
  f.answers.needs_main_model = .95;
  f.store.controlSession(f.session.id, how === 'stop' ? 'stop' : 'pause');
  await until(() => f.judgments.length === judged + 1, 'one review after the key change'); await f.settle();
  assert.equal(f.decisions.length, 1);
  for (let n = 0; n < 3; n++) { f.advance(MINUTE); await f.settle(1); }
  assert.equal(f.judgments.length, judged + 1, 'once');
});

test('8: running background work with no turn: new evidence is gated with the work in progress; covered holds until the work completes', async t => {
  let release; const gate = { promise: new Promise(done => { release = done; }) };
  const f = await fixture(t, { workGate: gate });
  Object.assign(f.answers, { needs_main_model: .95, likely: 'work' }); f.decide = () => ({ action: 'work', title: 'Check chapter', content: 'Check chapter.md for broken links.' });
  f.observe('ci-report');
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'work' && row.status === 'running'), 'work running');
  f.decide = () => ({ action: 'wait' }); const decided = f.decisions.length, judged = f.judgments.length;
  Object.assign(f.answers, { in_progress_covers: .97 });
  f.observe('second-report');
  await until(() => f.judgments.length === judged + 1, 'gated'); await f.settle();
  assert.match(JSON.stringify(f.judgments.at(-1).state.review.backgroundWork), /broken links/); assert.equal(f.judgments.at(-1).state.review.foregroundTurn, undefined);
  for (let n = 0; n < 5; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.equal(f.judgments.length, judged + 1, 'held while the work runs'); assert.equal(f.decisions.length, decided);
  Object.assign(f.answers, { in_progress_covers: .5, needs_main_model: .95 });
  release();
  await until(() => f.decisions.length === decided + 1, 'reviewed once the work completed');
});

test('9: a gate deferral with a queued share drains it and records one deferred wake', async t => {
  const f = await fixture(t);
  f.store.presences.set(f.project.id, { sessionId: f.session.id, visible: true, typing: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  Object.assign(f.answers, { needs_main_model: .95 }); f.decide = () => ({ action: 'share', title: 'Broken link', content: 'Chapter two has a broken link to the map.' });
  f.observe('ci-report');
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'share' && row.status === 'queued'), 'share queued while typing');
  await f.settle();
  const decided = f.decisions.length, deferred = f.wakes().filter(row => row.outcome === 'deferred').length;
  // The next due review: the judge finds nothing new (and the user stops typing meanwhile); the share still goes out.
  Object.assign(f.answers, { needs_main_model: .05, evidence_relevant: .1, already_reported: .9 }); f.onJudge = () => f.store.presences.delete(f.project.id);
  f.advance(2 * 3600000); await f.settle();
  // Drained: the share left the queue (the narrator then paces where it lands; nobody is in the conversation).
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'share' && row.status === 'completed'), 'drained');
  assert.equal(f.decisions.length, decided);
  assert.equal(f.wakes().filter(row => row.outcome === 'deferred').length, deferred + 1, 'one deferred wake');
});

test('10: a pending failure review during the lease is not held', async t => {
  const f = await fixture(t);
  f.startTurn(); await f.settle();
  const context = f.context(); context.coordinator.state.pendingFailureReview = { actionId: 'failed-work', evidenceKey: 'k' };
  f.advance(MINUTE); await f.settle();
  await until(() => f.decisions.length === 1, 'the failure is reviewed during the turn');
});

// What a stretch of real time costs while nothing changes: pumps, judge requests, ledger rows (indexed too), store revisions.
function meter(f) {
  let pumps = 0; const pump = f.controller.pump.bind(f.controller); f.controller.pump = async () => { pumps++; return pump(); };
  const ledger = () => ({ recent: f.store.decisionLedger?.rows() ?? [] }), indexed = () => ledger().recent.length;
  const start = { judged: f.judgments.length, decided: f.decisions.length, revision: f.store.state.revision, ids: new Set((ledger().recent ?? []).map(row => row.id)), indexed: indexed() };
  return () => ({ pumps, judged: f.judgments.length - start.judged, decided: f.decisions.length - start.decided, revisions: f.store.state.revision - start.revision, indexed: indexed() - start.indexed, rows: (ledger().recent ?? []).filter(row => !start.ids.has(row.id)) });
}
async function runningWork(f) {
  Object.assign(f.answers, { needs_main_model: .95, likely: 'work' }); f.decide = () => ({ action: 'work', title: 'Check chapter', content: 'Check chapter.md for broken links.' });
  f.observe('ci-report');
  await until(() => f.current().initiativeRuntime.sdkState.actions.some(row => row.action === 'work' && row.status === 'running'), 'work running');
  f.decide = () => ({ action: 'wait' }); await f.settle();
}
const overdue = (f, at) => f.store.mutate(state => { const p = state.projects.find(row => row.id === f.project.id); p.mind ??= {}; p.mind.commitments = [{ id: 'c1', text: 'Send the revised outline', status: 'pending', createdAt: new Date(f.now()).toISOString(), overdueAt: new Date(at).toISOString() }]; });

// L1 (review 2026-10-05): the gate was asked on every pump while the coordinator would idle (its only execution slot busy),
// and each judgment row's write scheduled the next pump: 42 pumps and 41 cached judgment rows in 1.5 s. The judge is now
// asked only when a decision would follow.
test('11: running work, a review due and a judge that would wake: an idle hot pump asks nothing and writes O(1) rows', async t => {
  let release; const gate = { promise: new Promise(done => { release = done; }) };
  const f = await fixture(t, { workGate: gate });
  t.after(() => release());
  await runningWork(f);
  Object.assign(f.answers, { needs_main_model: .95, in_progress_covers: .05 });
  const read = meter(f);
  f.advance(2 * 3600000); f.controller.schedule();
  await delay(800);
  const idle = read();
  assert.equal(idle.judged, 0, 'no judge request while the coordinator waits for the run'); assert.equal(idle.decided, 0);
  assert.ok(idle.rows.length <= 1 && idle.indexed <= 1, `O(1) ledger rows, got ${idle.rows.length}`);
  assert.ok(idle.pumps <= 3, `no pump loop, got ${idle.pumps} pumps`); assert.ok(idle.revisions <= 8, `no write loop, got ${idle.revisions} revisions`);
  // The run's result still wakes the review at once.
  release(); await until(() => f.decisions.length === 1, 'the completion is reviewed');
});

// L2: a bypass signal that lasts (an uncertain result waiting for the user, an overdue request during a run) wrote a rule row
// on every pump while the coordinator idled: 137 bypass_pending_review rows in 1.5 s.
for (const shape of ['needs_review', 'overdue']) test(`12: a lasting bypass signal (${shape === 'needs_review' ? 'a result waiting to be checked' : 'an overdue request during a run'}) with an idle coordinator writes one row per situation`, async t => {
  let release = () => {}; const gate = { promise: new Promise(done => { release = done; }) };
  const f = await fixture(t, shape === 'overdue' ? { workGate: gate } : {});
  t.after(() => release());
  if (shape === 'overdue') { await runningWork(f); overdue(f, f.now() - MINUTE); await f.settle(); }
  else {
    const coordinator = f.context().coordinator;
    coordinator.state.actions.push({ id: 'uncertain-1', action: 'work', status: 'needs_review', blocksExecution: true, content: 'Ran a deploy script', evidenceIds: [], createdAt: f.now() });
    await coordinator._persist();
    f.advance(3600000); f.controller.schedule(); await delay(200); await f.settle();
    assert.equal(f.rows().filter(row => row.reason === 'bypass_pending_review').length, 1, 'its one review went to the main model by rule');
  }
  const read = meter(f);
  f.advance(3 * 3600000); f.controller.schedule();
  await delay(800);
  const idle = read(), bypasses = idle.rows.filter(row => String(row.reason).startsWith('bypass_'));
  assert.ok(bypasses.length <= 1, `${shape}: at most one bypass row, got ${bypasses.length}`); assert.ok(idle.indexed <= 1);
  assert.ok(idle.pumps <= 3, `${shape}: no pump loop, got ${idle.pumps}`); assert.equal(idle.judged, 0);
});

// L1 coalescing: a wake the coordinator could not act on (here: a decision budget too small for the request) is not judged
// again for the same situation until its retry time; before, every pump wrote another cached judgment row (pre-existing).
test('13: a judged wake the coordinator cannot act on is judged once per retry time, not once per pump', async t => {
  const f = await fixture(t);
  Object.assign(f.answers, { needs_main_model: .95 });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiative.tokenBudget = 50; }); await f.settle();
  const read = meter(f);
  f.advance(2 * 3600000); f.controller.schedule();
  await delay(800);
  const blocked = read();
  assert.equal(f.current().initiativeRuntime.status, 'budget_exhausted');
  assert.ok(blocked.rows.length <= 1, `one judgment row, got ${blocked.rows.length}`); assert.ok(blocked.pumps <= 4, `no pump loop, got ${blocked.pumps}`); assert.equal(blocked.decided, 0);
  // Past the retry time the same situation may be judged once more.
  f.advance(10 * MINUTE); f.controller.schedule(); await delay(300);
  assert.ok(read().rows.length <= 2);
});

// L3: the lease's bound is evidence, not a clock. A turn waiting on the user (its question or permission card is open) is
// not working and holds nothing; a failure review is never held. An overdue request is held (B3, 14b).
test('14: a turn waiting on the user releases the lease, and its answer typed in the conversation is still its own', async t => {
  const f = await fixture(t), judged = f.judgments.length;
  const turnId = f.startTurn('Draft chapter three.'); await f.settle();
  for (let n = 0; n < 3; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.equal(f.decisions.length, 0, 'held while the turn works');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'ask-1', turnId, kind: 'question', text: '', source: 'interaction', createdAt: new Date().toISOString(), simulated: false, interaction: { kind: 'question', id: 'q-1', source: 'tool', status: 'pending', canRespond: true, turnId, toolCallId: 'call-1', questions: [{ question: 'Which ending?' }] } }); });
  assert.equal(f.controller.progressLease(f.project.id).foreground, null, 'waiting on the user is not in progress');
  assert.deepEqual(f.controller.progressLease(f.project.id).owners.turnIds, [turnId], 'but the turn still owns its messages');
  await until(() => f.decisions.length === 1, 'one review once the turn waits on the user'); await f.settle();
  assert.equal(f.rows().filter(row => row.reason === 'bypass_unanswered_question').length, 1, 'by rule: a question is open');
  assert.equal(f.judgments.length, judged, 'no judge needed for it');
  for (let n = 0; n < 3; n++) { f.advance(MINUTE); await f.settle(1); }
  assert.equal(f.decisions.length, 1, 'once: then the review clock applies');
  // A message the waiting turn takes in (stamped with its id, as the runtime does with a steer) is the turn's own, not
  // independent evidence.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'answer-1', turnId, kind: 'user', text: 'The second ending.', createdAt: new Date().toISOString(), simulated: false }); });
  assert.ok(f.controller.leaseOwnedIds(f.current(), f.controller.progressLease(f.project.id).owners).has('message:answer-1'));
});

// B3 (§1.2 #4): an overdue request used to exempt the project from the lease, so every user turn became a paid mid-turn
// decision. Headlong: a pending request changes what a wake does and which tier answers, never adds wakes
// (monolith/step:204-237, 425-441); declining it takes a stated reason, and holds until something new happens.
test('14b: an overdue request during a working turn is held; the turn\'s result takes it to the main model once; a wait with its reason holds the rule until new evidence', async t => {
  const f = await fixture(t);
  overdue(f, f.now() + 30 * MINUTE);
  f.startTurn('Please draft chapter three.'); await f.settle();
  const judged = f.judgments.length;
  for (let n = 0; n < 2; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  f.advance(15 * MINUTE); f.controller.schedule(); await f.settle();
  for (let n = 0; n < 12; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.equal(f.decisions.length, 0, 'held for the whole turn, overdue or not');
  assert.equal(f.judgments.length, judged, 'no judge call either');
  assert.equal(f.rows().filter(row => row.reason === 'bypass_commitment_overdue').length, 0);
  finishActiveTurn(f.store, f.session.id, { reply: 'Drafted chapter three.' });
  await until(() => f.decisions.length === 1, 'the turn\'s result goes to the main model by rule'); await f.settle();
  assert.equal(f.rows().filter(row => row.reason === 'bypass_commitment_overdue').length, 1);
  assert.deepEqual(f.current().mind.pacing.overdueDeclined.ids, ['c1'], 'the wait declined it, with its reason');
  assert.equal(f.current().mind.pacing.overdueDeclined.reason, 'Fixture decision');
  // Nothing new: the next due reviews go to the judge, which finds nothing to do; no bypass on the same situation.
  const before = f.judgments.length;
  for (let n = 0; n < 8; n++) { f.advance(10 * MINUTE); await f.settle(1); }
  assert.ok(f.judgments.length > before, 'the coordinator\'s clock reached the judge');
  assert.equal(f.rows().filter(row => row.reason === 'bypass_commitment_overdue').length, 1, 'no second bypass without new evidence');
  // New evidence: the request is owed again.
  f.observe('ci-report');
  await until(() => f.rows().filter(row => row.reason === 'bypass_commitment_overdue').length === 2, 'new evidence brings the overdue request back by rule');
});

// L5: independent evidence the pump that saw it could not review (here: a failure backoff) keeps its fresh marking until a
// judgment reads it; before, the later review sent the events with "nothing new since the last decision".
test('15: independent evidence that could not be reviewed at once reaches the next judgment as new', async t => {
  const f = await fixture(t);
  f.startTurn('Rewrite the ending of chapter one.'); await f.settle();
  const judged = f.judgments.length, context = f.context();
  context.coordinator.state.failureRetryAt = f.now() + 5 * MINUTE;
  Object.assign(f.answers, { in_progress_covers: .97 });
  f.observe('ci-report'); await f.settle();
  assert.equal(f.judgments.length, judged, 'not reviewed during the backoff');
  f.advance(6 * MINUTE); await f.settle();
  await until(() => f.judgments.length === judged + 1, 'judged after the backoff');
  const review = f.judgments.at(-1).state.review;
  assert.equal(review.newSinceLastDecision, 'one', 'the report is still new to the judge');
  assert.match(JSON.stringify(review.newEvidence), /broken link in chapter two/);
  assert.ok(f.judgments.at(-1).questions.in_progress_covers, 'judged with the turn in progress');
});
