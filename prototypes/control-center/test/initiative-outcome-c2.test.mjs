// Plan 2026-10-05 C2, through the real controller and SDK coordinator, a real DecisionService over a scripted JEV (a fake
// clock, a scripted main model, no network):
//  - option C (Headlong monolith/step:357-373, 582-586): admitting a decision does not reset the wake ladder; the row is
//    pending and names the action. A VISIBLE outcome resets it; nothing visible is a thought;
//  - PDL-7 (mu decision.ts:25-31): the outcome of the action a wake admitted labels the judgments behind that wake
//    (source outcome), not the model's own next decision;
//  - the tier a wake would run on is recorded from facts (shadow: nothing reads it);
//  - the wake rows go to a sidecar (state keeps the newest few), and a restart replays the outcomes without a duplicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { DecisionService } from '../decision-service.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';
import { WorkOutcomeLog, outcomeLogFile } from '../work-outcome.mjs';
import { wakeLogFile, readWakeLog, WAKE_STATE_TAIL } from '../wake-log.mjs';
import { WAKE_LADDER } from '../proactive-pacing.mjs';
import { finishActiveTurn } from './helpers/foreground-turn.mjs';

const MINUTE = 60000;
async function until(check, label, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await delay(5); } }
const PLAN = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does verified project evidence call for background action now?', criteria: { true: 'A concrete verified gap needs work.', false: 'Nothing verified needs work now.' } } } };

async function fixture(t) {
  // The fake clock starts at the real time: a turn the test finishes is stamped by the real clock, and must not be newer than the decisions after it.
  let clock = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-c2-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated C2 fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'C2 fixture novel', description: 'Write and revise chapters', workspace: directory, rhythm: { control: 'manual' }, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, permissions: { workspace: 'write', background: 'read', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'chapter.md'), 'Chapter one.');
  // JEV: every noul from `f.answers` (0.5 when unset); `f.hold` delays the narrator's step (a message is composed and delivered only once released).
  const f = { store, project, session, directory, judgments: [], decisions: [], hold: null, answers: { needs_main_model: .95, evidence_relevant: .9, already_reported: .02, user_engaged: .5, likely: 'share' }, decide: () => ({ action: 'wait' }), now: () => clock, advance: ms => { clock += ms; } };
  const answerFor = questions => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'choice' ? { type: 'choice', choice: f.answers.likely, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === f.answers.likely ? .96 : .01])) } : { type: 'noul', noul: f.answers[id] ?? .5 }]));
  const service = new DecisionService(store, { now: f.now, kernelFactory: options => createDecisionKernel({ ...options, timeoutMs: 4000, fetch: async (_url, init) => { const body = JSON.parse(init.body); f.judgments.push(body); return new Response(JSON.stringify({ answers: answerFor(body.questions), usage: { input_tokens: 40, output_tokens: 0 } })); } }) });
  service.update({ apiKey: 'isolated-c2-fixture-key', mode: 'active', modes: { 'initiative.review': 'active', 'initiative.gate': 'active', 'message.value': 'active' } });
  const controller = new ProjectInitiativeController(store, { decisionService: service, now: f.now, initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, outcomeCheckIntervalMs: 0, feedbackCheckIntervalMs: 0,
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); f.decisions.push(input);
      const chosen = f.decide(input), evidenceIds = chosen.action === 'wait' ? [] : [input.allowedEvidenceIds.at(-1)];
      yield { type: 'text_delta', delta: JSON.stringify({ reason: 'Fixture decision', content: '', nextReviewAfterMs: 3600000, evidenceIds, ...chosen, ...(input.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: PLAN } : {}) }) }; yield { type: 'usage', usage: { input: 20, output: 5, totalTokens: 25 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { yield { type: 'text_delta', delta: 'Checked chapter.md.\n交接：核对了 chapter.md，下一步无。' }; yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'stop' }; } }) });
  const narrate = controller.narrateAction.bind(controller);
  controller.narrateAction = async (...args) => { await f.hold?.promise; return narrate(...args); };
  t.after(async () => { f.hold?.resolve(); await service.close(); await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  Object.assign(f, { service, controller,
    current: () => store.state.projects.find(row => row.id === project.id),
    context: () => controller.contexts.get(project.id),
    wake: () => store.state.projects.find(row => row.id === project.id).mind?.pacing?.wake ?? {},
    ledger: id => store.decisionLedger.get(id),
    items: () => store.state.sessions.find(row => row.id === session.id).items,
    async settle(rounds = 3) { for (let n = 0; n < rounds; n++) { await controller.pump(); await f.context()?.reviewPromise; await delay(2); } },
    observe(id) { store.mutate(state => { state.projects.find(row => row.id === project.id).observations.push({ id, kind: 'external_report', text: 'CI reported a broken link in chapter two.', status: 'pending', createdAt: new Date(clock).toISOString(), simulated: false }); }); },
    setLadder(wake) { store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.mind ??= {}; p.mind.pacing ??= {}; p.mind.pacing.wake = { ...p.mind.pacing.wake, ...wake }; }); },
  });
  await until(() => f.context()?.initialized && f.judgments.length >= 1 && !f.context().reviewPromise, 'first gated review');
  await f.settle();
  return f;
}
const lastWork = f => f.wake().history.findLast(row => row.outcome === 'work');
const ladder = wake => [wake.level, wake.ticksAtLevel, wake.quietWakes];

test('a decision the host admits is pending: the ladder stays where it was until the message reaches the user; then it resets, once, and the replay emits nothing', async t => {
  const f = await fixture(t);
  f.setLadder({ level: 3, ticksAtLevel: 1, quietWakes: 4 });
  let release; f.hold = { promise: new Promise(done => { release = done; }), resolve: () => release() };
  f.decide = () => ({ action: 'share', title: 'Broken link', content: 'Chapter two has a broken link to the map.' });
  f.observe('ci-report');
  await until(() => lastWork(f), 'the work decision was recorded');
  const row = lastWork(f), action = f.current().initiativeRuntime.sdkState.actions.find(entry => entry.action === 'share');
  // The row: admitted and pending, naming the action, the judgment rows it came from and the tier computed from facts.
  assert.deepEqual([row.pending, row.actionId], [true, action.id]);
  assert.ok(row.gate.ledgerId && f.ledger(row.gate.ledgerId), 'the wake judgment\'s ledger row');
  assert.deepEqual([row.tier, row.tierFacts], ['think', undefined], 'nothing owed, no turn, no reply: the think tier');
  // Admission moved nothing: level, ticks, the quiet count and the last visible time are as they were.
  assert.deepEqual(ladder(f.wake()), [3, 1, 4]); assert.equal(f.wake().lastVisibleAt, undefined);
  assert.equal(f.store.outcomeLog.last(action.id).to, 'pending', 'its first transition');
  // The model's own next choice is a self label, which calibration does not read.
  assert.deepEqual([f.ledger(row.gate.ledgerId).label?.value, f.ledger(row.gate.ledgerId).label?.source], ['wake_needed_share', 'self']);
  // The narrator's step finishes: the message reaches the conversation, and the outcome resets the ladder.
  release();
  await until(() => f.items().some(item => item.source === 'initiative' && item.initiativeActionId === action.id), 'delivered');
  await until(() => f.wake().lastVisibleAt, 'the visible outcome moved the ladder'); await f.settle();
  assert.deepEqual(ladder(f.wake()), [0, 0, 0]); assert.equal(Date.parse(f.wake().nextAt) - f.now(), WAKE_LADDER[0]);
  assert.equal(f.wake().lastVisibleActionId, action.id);
  assert.deepEqual(f.store.outcomeLog.rows().filter(entry => entry.actionId === action.id).map(entry => [entry.from, entry.to]), [[null, 'pending'], ['pending', 'visible']]);
  // The wake row is in the sidecar, which carries the same link a late outcome needs.
  assert.equal(f.store.wakeLog.byAction(f.project.id, action.id).gate.ledgerId, row.gate.ledgerId);
  assert.ok(f.wake().history.length <= WAKE_STATE_TAIL && readWakeLog(wakeLogFile(f.store.file))[f.project.id].some(entry => entry.actionId === action.id));
  // No reaction yet: the wake is still labelled by the model's own choice (self). The user replies: the outcome labels it.
  assert.equal(f.ledger(row.gate.ledgerId).label.source, 'self');
  const entry = f.current().inbox.find(item => item.actionId === action.id);
  f.advance(MINUTE);
  // C3: a reply is attributed by what it answers, not by order. The focused judgment (reply.target) names the delivered message
  // this one answers; without a verdict a message that has candidates waits for the judge (the fixture has none that answers).
  const delivered = f.items().find(item => item.source === 'initiative' && item.initiativeActionId === action.id);
  f.store.mutate(state => { state.sessions.find(item => item.id === f.session.id).items.push({ id: 'reply', turnId: null, kind: 'user', text: 'Thanks, fixing it now.', createdAt: new Date(f.now()).toISOString(), simulated: false, replyTo: { source: 'jev', itemId: delivered.id, kind: 'delivery' } }); });
  await until(() => f.current().inbox.find(item => item.id === entry.id).feedback?.outcome === 'replied', 'the reply settled'); await f.settle();
  assert.equal(f.ledger(row.gate.ledgerId).label.source, 'outcome', 'the outcome, not the model\'s own next choice, labels the judgment');
  assert.equal(f.service.backfill({ force: true }) >= 0, true);
  // A restart replays the records: nothing is emitted twice.
  const before = readFileSync(outcomeLogFile(f.store.file), 'utf8'), again = new WorkOutcomeLog({ file: outcomeLogFile(f.store.file), now: f.now });
  const sessions = f.store.state.sessions.filter(item => item.projectId === f.project.id);
  assert.deepEqual(again.reconcile(f.current(), sessions, { now: f.now(), state: f.store.state }).transitions, [], 'the replay emits no duplicate');
  assert.equal(readFileSync(outcomeLogFile(f.store.file), 'utf8'), before);
});

test('a run that changed nothing and told nobody is none: the ladder is not reset by it, and the wake judgment is labelled not needed by that outcome', async t => {
  const f = await fixture(t);
  // The decision is a read-only check: the fixture's worker only reads, so nothing reaches the project folder or the user.
  let decided = 0;
  f.decide = () => ++decided === 1 ? { action: 'work', title: 'Check the chapter', content: 'Check chapter.md for broken links.' } : { action: 'wait' };
  f.setLadder({ level: 2, ticksAtLevel: 0, quietWakes: 2 });
  f.observe('ci-report');
  await until(() => lastWork(f), 'the work decision was recorded');
  const row = lastWork(f), action = f.current().initiativeRuntime.sdkState.actions.find(entry => entry.action === 'work');
  assert.equal(row.actionId, action.id);
  await until(() => f.store.outcomeLog.last(action.id)?.to === 'none', 'the run ended with nothing visible'); await f.settle();
  assert.equal(f.current().initiativeRuntime.sdkState.actions.find(entry => entry.id === action.id).status, 'completed', 'it ran fine: nothing was wrong, nothing came of it');
  assert.equal(f.wake().lastVisibleAt, undefined, 'never visible');
  assert.ok(f.wake().level >= 2 && f.wake().quietWakes >= 3, `a thought: the ladder rests and the quiet count rises (${JSON.stringify(ladder(f.wake()))})`);
  assert.deepEqual([f.ledger(row.gate.ledgerId).label.value, f.ledger(row.gate.ledgerId).label.source], ['wake_unneeded', 'outcome'], 'the outcome, not the model\'s next choice (it had labelled the wake needed_work)');
  assert.deepEqual(f.store.outcomeLog.rows().filter(entry => entry.actionId === action.id).map(entry => [entry.from, entry.to, entry.reason]), [[null, 'pending', 'running'], ['pending', 'none', 'nothing_visible']]);
});

test('the tier a wake would run on is recorded from facts: a turn\'s result, an open request, the think tier for the rest; no behaviour reads it', async t => {
  const f = await fixture(t);
  f.decide = () => ({ action: 'wait' });
  // A foreground turn ends: its conversation_result is the evidence of this wake (the reactive wake).
  f.store.message(f.session.id, { text: 'Rewrite the ending of chapter one.' });
  await f.settle();
  f.advance(MINUTE); // the turn is stamped by the real clock: the fake one is moved past it, so the decision that reads it is later than it
  finishActiveTurn(f.store, f.session.id, { reply: 'Rewrote the ending.' });
  await until(() => f.wake().history.some(row => row.tierFacts?.includes('conversation_outcome')), 'the turn\'s result was reviewed'); await f.settle();
  const reactive = f.wake().history.findLast(row => row.tierFacts?.includes('conversation_outcome'));
  assert.equal(reactive.tier, 'request');
  // An open request of the user's: request tier, whatever the evidence is.
  f.store.mutate(state => { const p = state.projects.find(row => row.id === f.project.id); p.mind ??= {}; p.mind.commitments = [{ id: 'c1', request: 'Send me the revised outline.', trigger: 'user_request', status: 'pending', createdAt: new Date(f.now()).toISOString(), overdueAt: new Date(f.now() + 5 * 60 * MINUTE).toISOString(), source: { kind: 'capture' } }]; });
  const wakes = f.wake().history.length;
  f.advance(2 * MINUTE); f.observe('ci-report-2');
  await until(() => f.wake().history.length > wakes, 'the next wake'); await f.settle();
  const owed = f.wake().history.at(-1);
  assert.deepEqual([owed.tier, owed.tierFacts], ['request', ['open_commitment']]);
  // Nothing owed, nothing from a conversation: the think tier, with no facts.
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.commitments = []; });
  const again = f.wake().history.length;
  f.advance(2 * MINUTE); f.observe('ci-report-3');
  await until(() => f.wake().history.length > again, 'a wake with nothing owed'); await f.settle();
  const think = f.wake().history.at(-1);
  assert.deepEqual([think.tier, think.tierFacts], ['think', undefined]);
  // Recorded only: the tier appears nowhere a decision reads (the request the decision is given, the gate's state).
  assert.ok(!JSON.stringify(f.decisions.at(-1)).includes('tierFacts'), 'the decision request never carries it');
  assert.ok(!f.judgments.some(call => JSON.stringify(call).includes('tierFacts')), 'nor does a JEV call');
});

test('the wake rows go to the sidecar; state keeps the newest few, which are the newest rows of the file', async t => {
  const f = await fixture(t);
  f.decide = () => ({ action: 'wait' });
  for (let n = 0; n < WAKE_STATE_TAIL + 4; n++) {
    const before = f.wake().history?.length ?? 0, count = readWakeLog(wakeLogFile(f.store.file))[f.project.id]?.length ?? 0;
    f.advance(2 * MINUTE); f.observe(`report-${n}`);
    await until(() => (readWakeLog(wakeLogFile(f.store.file))[f.project.id]?.length ?? 0) > count || (f.wake().history?.length ?? 0) > before, `wake ${n}`); await f.settle();
  }
  const rows = readWakeLog(wakeLogFile(f.store.file))[f.project.id];
  assert.ok(rows.length >= WAKE_STATE_TAIL + 1, `${rows.length} rows in the file`);
  assert.equal(f.wake().history.length, WAKE_STATE_TAIL, 'state keeps only the tail');
  assert.deepEqual(f.wake().history.map(row => row.at), rows.slice(-WAKE_STATE_TAIL).map(row => row.at), 'the tail is the newest rows of the file');
});

test('state trims a wake row only once it is on disk: a full disk keeps every row in state, and the next wake that can be saved heals the file (review)', async t => {
  const f = await fixture(t);
  f.decide = () => ({ action: 'wait' });
  const good = f.store.wakeLog.file;
  // Where the metrics directory should be there is a file: every append fails, as on a full disk.
  writeFileSync(join(f.directory, 'blocked'), 'not a directory'); f.store.wakeLog.file = join(f.directory, 'blocked', 'metrics', 'wakes.jsonl');
  const wakeAfter = async label => { const before = f.store.wakeLog.rows(f.project.id).length; f.advance(2 * MINUTE); f.observe(label); await until(() => f.store.wakeLog.rows(f.project.id).length > before, label); await f.settle(); };
  for (let n = 0; n < WAKE_STATE_TAIL + 3; n++) await wakeAfter(`blocked-${n}`);
  assert.ok(f.wake().history.length > WAKE_STATE_TAIL, `state kept its rows while the log could not save them (${f.wake().history.length})`);
  const kept = f.wake().history.map(row => row.at);
  // The disk is back: the next wake is saved, the file is whole (every row held, including the ones that failed), and only then does state trim.
  f.store.wakeLog.file = good;
  await wakeAfter('healed');
  const rows = readWakeLog(good)[f.project.id].map(row => row.at);
  for (const at of kept) assert.ok(rows.includes(at), `the row at ${at} is in the file`);
  assert.equal(f.wake().history.length, WAKE_STATE_TAIL, 'trimmed once safe');
});

test('a run the user stopped is not an empty wake: the ladder, the quiet count and the wake judgment\'s label stay as they were (review: a stop used to tick the ladder)', async t => {
  const f = await fixture(t);
  f.setLadder({ level: 3, ticksAtLevel: 1, quietWakes: 4 });
  let release; f.hold = { promise: new Promise(done => { release = done; }), resolve: () => release() };
  f.decide = () => ({ action: 'share', title: 'Broken link', content: 'Chapter two has a broken link to the map.' });
  f.observe('ci-report');
  await until(() => lastWork(f), 'the work decision was recorded');
  const row = lastWork(f), action = f.current().initiativeRuntime.sdkState.actions.find(entry => entry.action === 'share');
  assert.equal(f.store.outcomeLog.last(action.id).to, 'pending');
  const label = () => [f.ledger(row.gate.ledgerId).label?.value, f.ledger(row.gate.ledgerId).label?.source];
  assert.deepEqual(label(), ['wake_needed_share', 'self']);
  // The user stops it (the SDK's cancel control): the persisted action says so, and the upkeep reads it at once.
  f.store.mutate(state => { const entry = state.projects.find(item => item.id === f.project.id).initiativeRuntime.sdkState.actions.find(item => item.id === action.id); Object.assign(entry, { status: 'cancelled', cancellationReason: 'action_control' }); });
  f.controller.outcomeUpkeep(f.context(), { force: true });
  const moved = f.store.outcomeLog.rows().filter(entry => entry.actionId === action.id);
  assert.deepEqual(moved.map(entry => [entry.from, entry.to, entry.neutral]), [[null, 'pending', undefined], ['pending', 'none', true]], 'the outcome is recorded, marked neutral');
  assert.deepEqual(ladder(f.wake()), [3, 1, 4], 'no thought, no descent');
  assert.deepEqual(label(), ['wake_needed_share', 'self'], 'and no outcome label: the stop says nothing about whether the wake was needed');
});
