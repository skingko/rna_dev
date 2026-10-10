import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { projectRhythmStatus } from '../project-rhythm.mjs';
import { WAKE_LADDER } from '../proactive-pacing.mjs';

// B3, through the real controller and SDK coordinator (a fake clock and scripted decision/worker providers, no network):
//  - PDL-4: a due floor wake does not fire while a background run occupies the execution slot (Headlong
//    bin/thinkers:875-895), and records nothing; one that fires and reaches no decision (a budget too small for the
//    request) re-arms its timer without moving the ladder (monolith_backoff.md:173, 261-265).
//  - F4: a question the narrator holds while the user is away is narrated once, latched, and published from that record
//    when the user is here again (harness agent.ts:213-232), never re-narrated every ten minutes.
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
async function until(check, label, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await delay(5); } }
const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const PLAN = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does verified project evidence call for background action now?', criteria: { true: 'A concrete verified gap needs work.', false: 'Nothing verified needs work now.' } } } };
const assessment = input => ({ lifecycle: 'active', reason: 'Based on the actual provided project evidence and registered responsibilities.', evidenceIds: [input.events.at(-1).id], scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: DAY }, evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: DAY } });

async function fixture(t, { control = 'auto', respond, workGate = null, interactions = false, start = Date.now() - DAY, before = null, decisionService } = {}) {
  let clock = start;
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-b3-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'B3 fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Pacing fixture', description: 'Write and revise chapters', workspace: directory, rhythm: { control }, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'chapter.md'), 'Chapter one.');
  const calls = [], f = { store, project, session, directory, calls, now: () => clock, advance: ms => { clock += ms; } };
  before?.(f);
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => clock, evolutionService: { running: new Map() }, ...(interactions ? { interactionService: new UserInteractionService(store) } : {}), ...(decisionService ? { decisionService } : {}),
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); calls.push(input);
      const output = { reason: 'Fixture decision', content: '', evidenceIds: [], nextReviewAfterMs: DAY, ...respond(input, calls.length), ...(input.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: PLAN } : {}) };
      yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      if (workGate) await workGate.promise; request.signal.throwIfAborted();
      if (!request.messages.some(row => row.role === 'toolResult')) { yield { type: 'tool_call', id: 'read', name: 'project_read', arguments: { path: 'chapter.md' } }; yield { type: 'done', stopReason: 'toolUse' }; }
      else { yield { type: 'text_delta', delta: 'Checked chapter.md.\nHandoff: checked chapter.md; nothing left.' }; yield { type: 'done', stopReason: 'stop' }; }
      yield { type: 'usage', usage: { input: 10, output: 5, totalTokens: 15 } };
    } }) });
  t.after(async () => { workGate?.resolve(); await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  Object.assign(f, { controller,
    current: () => store.state.projects.find(row => row.id === project.id),
    context: () => controller.contexts.get(project.id),
    wake: () => store.state.projects.find(row => row.id === project.id).mind?.pacing?.wake ?? {},
    items: () => store.state.sessions.find(row => row.id === session.id).items,
    actions: () => controller.contexts.get(project.id)?.coordinator.state.actions ?? [],
    async settle(rounds = 3) { for (let n = 0; n < rounds; n++) { await controller.pump(); await f.context()?.reviewPromise; await delay(2); } },
    openAgenda() { store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.mind ??= {}; p.mind.agenda = [{ id: 'a1', kind: 'todo', text: 'Tune the ending of chapter three', status: 'open', createdAt: new Date(clock).toISOString() }]; }); },
    /** Counts coordinator ticks a floor wake asked for (wakeFloor: true). */
    countFloorTicks() { const coordinator = f.context().coordinator, tick = coordinator.tick.bind(coordinator), counter = { floor: 0 }; coordinator.tick = options => { if (options?.wakeFloor) counter.floor++; return tick(options); }; return counter; },
  });
  await until(() => f.context()?.initialized && calls.length >= 1 && !f.context().reviewPromise, 'first review');
  await f.settle();
  return f;
}

test('PDL-4: while a background run occupies the execution slot, a due floor wake neither ticks nor moves the ladder; it stays armed', async t => {
  const gate = hold();
  const f = await fixture(t, { workGate: gate, respond: (input, n) => n === 1 ? { action: 'wait', rhythm: assessment(input) } : n === 2 ? { action: 'work', title: 'Check the ending', content: 'Check chapter.md for the ending notes.', evidenceIds: [input.events.at(-1).id] } : { action: 'wait' } });
  assert.equal(projectRhythmStatus(f.store.state, f.current(), { now: f.now() }).initiative.reason, 'awaiting_evidence', 'event_only, its evidence consumed');
  f.openAgenda();
  // The floor's first wake decides work; the run then holds the only execution slot.
  f.advance(WAKE_LADDER[0] + MINUTE); await f.settle();
  await until(() => f.actions().some(row => row.action === 'work' && row.status === 'running'), 'work running');
  await f.settle();
  assert.equal(f.calls.length, 2);
  const wake = structuredClone(f.wake()), floor = f.countFloorTicks();
  // C2 (option C): the first wake (a wait) left one tick and one quiet wake; admitting the work decision resets neither: only a
  // visible outcome of the run does. The wake row is pending and names the action.
  assert.deepEqual([wake.level, wake.ticksAtLevel, wake.quietWakes, wake.lastOutcome], [0, 1, 1, 'work']);
  assert.deepEqual([wake.history.at(-1).pending, wake.history.at(-1).actionId], [true, f.actions().find(row => row.action === 'work').id]);
  // A 25-minute run and more: the floor falls due again and again (every 10 minutes at level 0).
  for (let n = 0; n < 5; n++) { f.advance(10 * MINUTE); await f.settle(2); }
  assert.equal(floor.floor, 0, 'no floor tick while the coordinator could not decide');
  assert.deepEqual(f.wake(), wake, 'nothing recorded: level, ticks, quiet count, timer and history as they were');
  assert.equal(f.calls.length, 2, 'and no decision');
  // The run's result is new evidence and wakes the review on the rhythm lane.
  gate.resolve();
  await until(() => f.calls.length === 3, 'the completion is reviewed'); await f.settle();
  assert.equal(f.wake().lastOutcome, 'thought');
});

test('PDL-4: a floor wake that fires but cannot decide (budget too small for the request) re-arms its timer once, without moving the ladder', async t => {
  const f = await fixture(t, { respond: (input, n) => n === 1 ? { action: 'wait', rhythm: assessment(input) } : { action: 'wait' } });
  f.openAgenda();
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiative.tokenBudget = 30; });
  await f.settle();
  const before = structuredClone(f.wake()), floor = f.countFloorTicks();
  f.advance(WAKE_LADDER[0] + MINUTE); await f.settle();
  assert.equal(f.current().initiativeRuntime.status, 'budget_exhausted');
  assert.equal(floor.floor, 1, 'the floor fired once');
  const after = f.wake();
  assert.deepEqual([after.level, after.ticksAtLevel, after.quietWakes, after.lastOutcome, after.history.length], [before.level, before.ticksAtLevel, before.quietWakes, before.lastOutcome, before.history.length], 'no wake recorded');
  assert.equal(Date.parse(after.nextAt), f.now() + WAKE_LADDER[before.level], 're-armed at its level\'s delay');
  // Within that delay the floor is not tried again on every pump.
  for (let n = 0; n < 4; n++) { f.advance(2 * MINUTE); await f.settle(2); }
  assert.equal(floor.floor, 1);
  assert.equal(f.calls.length, 1, 'never a paid decision');
});

test('F4: a question held while the user is away is narrated once and goes out from that record when the user is back', async t => {
  const narrations = { count: 0 };
  const f = await fixture(t, { control: 'manual', interactions: true,
    // The user last wrote two hours ago and is not in the conversation: away.
    before: f => f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u-old', turnId: null, kind: 'user', text: 'Draft chapter three tonight.', createdAt: new Date(f.now() - 2 * HOUR).toISOString(), simulated: false }); }),
    respond: (input, n) => n === 1
      ? { action: 'ask', content: 'Chapter three can end two ways.', evidenceIds: [input.events.at(-1).id], questions: [{ id: 'ending', question: 'Which ending should chapter three take?', options: [{ id: 'quiet', label: 'Quiet' }, { id: 'open', label: 'Open' }] }] }
      : { action: 'wait' } });
  const ask = () => f.actions().find(row => row.action === 'ask');
  await until(() => ask() && f.current().mind?.pacing?.decisions?.length, 'the ask was decided and narrated');
  // Count narrations from here (the first one happened in the first review's drain).
  const narrate = f.controller.narrateAction.bind(f.controller);
  f.controller.narrateAction = (...args) => { narrations.count++; return narrate(...args); };
  const card = () => f.items().find(item => item.kind === 'question' && item.interaction?.source === 'initiative');
  const thread = () => (f.current().mind?.threads ?? []).flatMap(row => row.heldAsks ?? []);
  assert.equal(card(), undefined, 'held, not asked');
  assert.equal(thread().length, 1, 'one narration record, held in its thread');
  assert.deepEqual(f.current().mind.threads.flatMap(row => row.held ?? []), [], 'never in thread.held, which a host before F4 states in its welcome-back text');
  assert.equal(ask().status, 'queued'); assert.equal(ask().deferredReason, 'narrator_away');
  // Latched behind a ten-minute backstop (the retry it had before F4): a host rolled back to before F4, which never
  // reads heldAsks, asks again no later than it would have (review finding 2: a day-long backstop held it for a day).
  assert.equal(ask().nextAttemptAt - f.now(), 10 * MINUTE, 'a ten-minute backstop');
  assert.deepEqual(f.current().mind.pacing.decisions.filter(row => row.kind === 'ask').map(row => row.outcome), ['hold']);
  // Three hours away: the backstop fires eighteen times and narrates nothing (narrator_held, no tokens), no card.
  for (let n = 0; n < 18; n++) { f.advance(10 * MINUTE + 1000); await f.settle(2); }
  assert.equal(narrations.count, 0, 'never re-narrated while the user is away'); assert.equal(card(), undefined); assert.equal(thread().length, 1);
  assert.equal(ask().deferredReason, 'narrator_held', 'the backstop came due and waited again on its record');
  assert.deepEqual(f.current().mind.pacing.decisions.filter(row => row.kind === 'ask').map(row => row.outcome), ['hold'], 'nothing recorded by a backstop');
  // The user opens the conversation: the held question goes out from its record, without another narration.
  f.store.presence(f.project.id, { sessionId: f.session.id, visible: true, typing: false });
  f.controller.schedule(); await f.settle(4);
  await until(() => card(), 'the card is published');
  assert.equal(narrations.count, 0); assert.equal(thread().length, 0, 'it left the thread as it went out');
  assert.deepEqual(card().interaction.questions.map(row => row.question), ['Which ending should chapter three take?']);
  const sent = f.current().mind.pacing.decisions.filter(row => row.kind === 'ask');
  assert.deepEqual(sent.map(row => [row.outcome, row.reasons]), [['hold', ['away']], ['send', ['held_released']]]);
  const entry = f.current().inbox.find(row => row.kind === 'ask');
  assert.deepEqual([entry.actionId, entry.pacing.reasons], [ask().id, ['held_released']]);
});

// The F4 review fixes: a held question is an absence hold only (the band is not a blocker presence clears), its record
// keeps the narration's message.value row, and a latched question whose record left its thread is narrated afresh.
const ASK = input => ({ action: 'ask', content: 'Chapter three can end two ways.', evidenceIds: [input.events.at(-1).id], questions: [{ id: 'ending', question: 'Which ending should chapter three take?', options: [{ id: 'quiet', label: 'Quiet' }, { id: 'open', label: 'Open' }] }] });
const judge = (probabilities, extra = {}) => ({ enabled: point => point === 'message.value', review: async () => ({ review: true }), messageValue: async () => ({ probabilities: { time_sensitive: .1, needs_user_decision: 1, already_reported: 0, ...probabilities }, alreadyReported: false, ...extra }) });
const countNarrations = f => { const counter = { count: 0 }, narrate = f.controller.narrateAction.bind(f.controller); f.controller.narrateAction = (...args) => { counter.count++; return narrate(...args); }; return counter; };

test('F4: with the user here, a question in the below-threshold band of a continuing thread goes out at once, as a new-thread question does: never held, latched or released past the threshold', async t => {
  const f = await fixture(t, { control: 'manual', interactions: true,
    // value .58 (new .6, continues .3, relevant .3, a decision needed), the judge picks the continuing thread.
    decisionService: judge({ new_information: .6, continues_open_thread_or_commitment: .3, relevant_now: .3 }, { threadIndex: 0, ledgerId: 'mv-band' }),
    before: f => {
      const at = ms => new Date(f.now() - ms).toISOString();
      f.store.mutate(state => {
        const session = state.sessions.find(row => row.id === f.session.id), project = state.projects.find(row => row.id === f.project.id);
        // The user wrote two hours ago; three shares since went unanswered, the last 20 minutes ago: threshold .45 + .14 (chain) + .1 (reading time) = .69.
        session.items.push({ id: 'u-old', turnId: null, kind: 'user', text: 'Draft chapter three tonight.', createdAt: at(2 * HOUR), simulated: false },
          ...[50, 40, 20].map((minutes, index) => ({ id: `s${index}`, turnId: null, kind: 'assistant', text: `Finding ${index} about chapter three.`, createdAt: at(minutes * MINUTE), simulated: false, source: 'initiative', initiativeActionId: `act-s${index}`, initiative: { kind: 'insight', reach: 'inline' } })));
        project.mind ??= {}; project.mind.threads = [{ id: 't-cont', title: 'Chapter three', kind: 'topic', status: 'open', messageItemIds: ['s2'], messageSessions: {}, lastMessageAt: at(20 * MINUTE), lastSummary: null, held: [], reactions: {}, createdAt: at(HOUR), updatedAt: at(20 * MINUTE) }];
      });
      f.store.presence(f.project.id, { sessionId: f.session.id, visible: true, typing: false });
    },
    respond: (input, n) => n === 1 ? ASK(input) : { action: 'wait' } });
  const card = () => f.items().find(item => item.kind === 'question' && item.interaction?.source === 'initiative');
  await until(() => card(), 'the card is published');
  const asks = f.current().mind.pacing.decisions.filter(row => row.kind === 'ask');
  assert.deepEqual(asks.map(row => [row.outcome, row.reasons, row.threadId]), [['inbox', ['below_threshold_band'], 't-cont']], 'one narration, in the band, on the continuing thread: published as a new-thread question is');
  assert.ok(asks[0].value < asks[0].threshold && asks[0].value >= asks[0].threshold - .2, `in the band (${asks[0].value} vs ${asks[0].threshold})`);
  assert.deepEqual(f.current().mind.threads.flatMap(row => row.heldAsks ?? []), [], 'never held');
  assert.equal(f.current().inbox.find(row => row.kind === 'ask').pacing.outcome, 'inbox');
});

test('F4: a question held while the user is away keeps its narration\'s message.value row, and the card it goes out as labels that judgment', async t => {
  const f = await fixture(t, { control: 'manual', interactions: true, decisionService: judge({ new_information: .9, continues_open_thread_or_commitment: .5, relevant_now: .9 }, { ledgerId: 'mv-held' }),
    before: f => f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u-old', turnId: null, kind: 'user', text: 'Draft chapter three tonight.', createdAt: new Date(f.now() - 2 * HOUR).toISOString(), simulated: false }); }),
    respond: (input, n) => n === 1 ? ASK(input) : { action: 'wait' } });
  const ask = () => f.actions().find(row => row.action === 'ask'), card = () => f.items().find(item => item.kind === 'question' && item.interaction?.source === 'initiative');
  await until(() => ask() && f.current().mind?.pacing?.decisions?.length, 'the ask was decided and narrated');
  const narrations = countNarrations(f);
  assert.deepEqual(f.current().mind.pacing.decisions.filter(row => row.kind === 'ask').map(row => [row.outcome, row.reasons, row.valueSource]), [['hold', ['away'], 'jev']]);
  assert.deepEqual(f.current().mind.threads.flatMap(row => row.heldAsks ?? []).map(row => [row.actionId, row.ledgerId]), [[ask().id, 'mv-held']]);
  assert.deepEqual(f.current().mind.threads.flatMap(row => row.held ?? []), []);
  f.advance(HOUR); await f.settle(2);
  f.store.presence(f.project.id, { sessionId: f.session.id, visible: true, typing: false });
  f.controller.schedule(); await f.settle(4);
  await until(() => card(), 'the card is published');
  assert.equal(narrations.count, 0, 'from its record');
  const entry = f.current().inbox.find(row => row.kind === 'ask');
  assert.deepEqual(entry.pacing.reasons, ['held_released']);
  assert.ok(entry.ledgerIds.includes('mv-held'), `the delivery's ledger rows name the narration's judgment (${JSON.stringify(entry.ledgerIds)})`);
});

test('F4: a latched question whose thread is muted, resolved or gone is narrated afresh, at once when its narration is a backstop old, never more often than its ten-minute backstop', async t => {
  const f = await fixture(t, { control: 'manual', interactions: true,
    before: f => f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u-old', turnId: null, kind: 'user', text: 'Draft chapter three tonight.', createdAt: new Date(f.now() - 2 * HOUR).toISOString(), simulated: false }); }),
    respond: (input, n) => n === 1 ? ASK(input) : { action: 'wait' } });
  const ask = () => f.actions().find(row => row.action === 'ask');
  await until(() => ask() && f.current().mind?.pacing?.decisions?.length, 'the ask was decided and narrated');
  const narrations = countNarrations(f), rows = () => f.current().mind.threads.flatMap(thread => (thread.heldAsks ?? []).map(row => ({ ...row, threadId: thread.id, status: thread.status })));
  const [first] = rows();
  assert.deepEqual([first.actionId, first.status, ask().deferredReason], [ask().id, 'open', 'narrator_away']);
  // Later (its backstop came due and waited on its record), the user mutes the question's thread while still away.
  f.advance(10 * MINUTE + 1000); await f.settle(2);
  assert.deepEqual([narrations.count, ask().deferredReason], [0, 'narrator_held']);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.threads.find(row => row.id === first.threadId).status = 'muted'; });
  f.advance(MINUTE); await f.settle(3);
  await until(() => narrations.count === 1, 'narrated afresh at once');
  assert.equal(rows().some(row => row.threadId === first.threadId), false, 'the muted thread no longer holds it');
  const [second] = rows();
  assert.deepEqual([second.actionId, second.status, second.reasons], [ask().id, 'open', ['away']], 'held again (still away), in an open thread');
  // A minute later its new thread resolves (applyResolution: status resolved, held messages dropped). Narrated a minute
  // ago, the question is not narrated again at once: its backstop narrates it (review finding 1: a record that kept
  // leaving its thread was narrated again on every pump).
  f.store.mutate(state => { Object.assign(state.projects.find(row => row.id === f.project.id).mind.threads.find(row => row.id === second.threadId), { status: 'resolved', held: [] }); });
  f.advance(MINUTE); for (let n = 0; n < 5; n++) await f.settle(2);
  assert.equal(narrations.count, 1, 'not again within its backstop');
  assert.deepEqual(rows(), [], 'its record left the resolved thread');
  assert.equal(ask().status, 'queued');
  f.advance(10 * MINUTE); await f.settle(3);
  await until(() => narrations.count === 2, 'narrated by its backstop');
  assert.deepEqual(rows().map(row => [row.actionId, row.status]), [[ask().id, 'open']], 'one record, in an open thread');
  assert.equal(ask().nextAttemptAt - f.now(), 10 * MINUTE, 'latched again, behind its record');
  // A backstop later every thread is gone (its record with it): un-latched at once.
  f.advance(10 * MINUTE + 1000); await f.settle(2);
  assert.equal(narrations.count, 2);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.threads = []; });
  f.advance(MINUTE); await f.settle(3);
  await until(() => narrations.count === 3, 'narrated afresh with no thread left');
  assert.deepEqual(rows().map(row => [row.actionId, row.status]), [[ask().id, 'open']]);
});

// Review finding 1 (B3 review): the narrator held a question for a resolved thread (message.value may continue a thread
// resolved within 7 days; an evidence match ignores status). Its record was dropped as not in an open thread, the
// question un-latched and narrated again, held on the same thread: thirty narrations in ten pumps without the clock moving.
const resolvedThread = (f, extra = {}) => {
  const at = ms => new Date(f.now() - ms).toISOString();
  f.store.mutate(state => {
    state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u-old', turnId: null, kind: 'user', text: 'Draft chapter three tonight.', createdAt: at(2 * HOUR), simulated: false });
    const project = state.projects.find(row => row.id === f.project.id);
    project.mind ??= {}; project.mind.threads = [{ id: 't-res', title: 'Chapter three', kind: 'topic', status: 'resolved', resolvedAt: at(HOUR), resolvedBy: 'user_reply', messageItemIds: [], messageSessions: {}, lastMessageAt: at(HOUR), lastSummary: null, held: [], reactions: {}, createdAt: at(3 * HOUR), updatedAt: at(HOUR), ...extra.thread }];
    if (extra.commitments) project.mind.commitments = extra.commitments;
  });
};
const continuesResolved = () => judge({ new_information: .9, continues_open_thread_or_commitment: .5, relevant_now: .9 }, { threadIndex: 0, ledgerId: 'mv-res' });

test('F4 (F5(b)): a question held for a resolved thread reopens it and keeps its record there: narrated once, sent from that record when the user is back', async t => {
  const f = await fixture(t, { control: 'manual', interactions: true, decisionService: continuesResolved(), before: f => resolvedThread(f), respond: (input, n) => n === 1 ? ASK(input) : { action: 'wait' } });
  const ask = () => f.actions().find(row => row.action === 'ask'), card = () => f.items().find(item => item.kind === 'question' && item.interaction?.source === 'initiative');
  await until(() => ask() && f.current().mind?.pacing?.decisions?.length, 'the ask was decided and narrated');
  const narrations = countNarrations(f), thread = () => f.current().mind.threads.find(row => row.id === 't-res');
  assert.deepEqual(f.current().mind.pacing.decisions.filter(row => row.kind === 'ask').map(row => [row.outcome, row.reasons, row.threadId]), [['hold', ['away'], 't-res']]);
  assert.deepEqual([thread().status, thread().resolvedAt, (thread().heldAsks ?? []).map(row => row.actionId)], ['open', undefined, [ask().id]], 'the hold reopened the thread, its record in it');
  for (let n = 0; n < 10; n++) { await f.settle(1); await delay(10); }
  assert.equal(narrations.count, 0, 'not narrated again on any pump');
  // An hour away: its backstops narrate nothing.
  for (let n = 0; n < 6; n++) { f.advance(10 * MINUTE + 1000); await f.settle(2); }
  assert.equal(narrations.count, 0); assert.equal(card(), undefined);
  assert.deepEqual(f.current().mind.pacing.decisions.filter(row => row.kind === 'ask').length, 1, 'one pacing record');
  f.store.presence(f.project.id, { sessionId: f.session.id, visible: true, typing: false });
  f.controller.schedule(); await f.settle(4);
  await until(() => card(), 'the card is published');
  assert.equal(narrations.count, 0, 'from its record');
  assert.deepEqual(f.current().inbox.find(row => row.kind === 'ask').pacing.reasons, ['held_released']);
  assert.deepEqual([thread().status, thread().heldAsks], ['open', []]);
});

test('F4: a question whose record keeps leaving its thread (a reopened thread its done commitment resolves again) is narrated at most once per ten-minute backstop', async t => {
  const f = await fixture(t, { control: 'manual', interactions: true, decisionService: continuesResolved(),
    before: f => resolvedThread(f, { thread: { kind: 'commitment', ref: { commitmentId: 'c1' } }, commitments: [{ id: 'c1', status: 'resolved', request: 'Draft chapter three tonight.', createdAt: new Date(f.now() - 2 * HOUR).toISOString(), updatedAt: new Date(f.now() - HOUR).toISOString() }] }),
    respond: (input, n) => n === 1 ? ASK(input) : { action: 'wait' } });
  const ask = () => f.actions().find(row => row.action === 'ask'), holds = () => f.current().mind.pacing.decisions.filter(row => row.kind === 'ask' && row.outcome === 'hold').length;
  await until(() => ask() && f.current().mind?.pacing?.decisions?.length, 'the ask was decided and narrated');
  const narrations = countNarrations(f);
  // Upkeep resolves the reopened thread again (its commitment is done), and the record leaves with it.
  for (let n = 0; n < 10; n++) { await f.settle(1); await delay(10); }
  assert.equal(f.current().mind.threads.find(row => row.id === 't-res').status, 'resolved');
  assert.deepEqual(f.current().mind.threads.flatMap(row => row.heldAsks ?? []), []);
  assert.deepEqual([narrations.count, holds(), ask().status], [0, 1, 'queued'], 'narrated a moment ago: not again on any pump');
  // Its backstop narrates it once; the same happens again, and nothing in between.
  f.advance(10 * MINUTE + 1000); await f.settle(3);
  await until(() => narrations.count === 1, 'narrated by its backstop');
  for (let n = 0; n < 10; n++) { await f.settle(1); await delay(10); }
  assert.deepEqual([narrations.count, holds()], [1, 2], 'once per backstop');
});
