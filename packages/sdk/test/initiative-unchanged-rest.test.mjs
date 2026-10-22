import test from 'node:test';
import assert from 'node:assert/strict';
import { InitiativeCoordinator, InitiativeError, MAX_REST_MS } from '../src/initiative.mjs';

// A floor wake (the host's backstop timer) that brings nothing new keeps the rest the last `wait` asked for: the request
// is the same bar the clock, so asking again would be paid for to say the same wait.
const model = { protocol: 'openai', providerId: 'test', modelId: 'fixture', maxOutputTokens: 2048 };
const event = { id: 'e1', type: 'conversation_result', summary: 'The foreground finished chapter one.', at: 1000 };
const HOUR = 3600000;
const wait = (rest = 6 * HOUR) => ({ action: 'wait', reason: 'Nothing new until the next scheduled run.', evidenceIds: [], content: '', nextReviewAfterMs: rest });
function fixture({ rest = 6 * HOUR, restIgnore, answers } = {}) {
  const calls = [], clock = { at: 10 * HOUR };
  const provider = async function* (options) {
    calls.push(JSON.parse(options.messages[0].content[0].text));
    const answer = answers ? answers[Math.min(calls.length - 1, answers.length - 1)] : wait(rest);
    yield { type: 'text_delta', delta: JSON.stringify(answer) }; yield { type: 'usage', usage: { input: 100, output: 20, totalTokens: 120 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const project = (extra = {}) => ({ id: 'p', clock: { now: new Date(clock.at).toISOString() }, communication: { sentLast24h: [] }, ...extra });
  const coordinator = new InitiativeCoordinator({ project: project(), model, provider, now: () => clock.at, restIgnore, policy: { reviewMinMs: 1000, reviewMaxMs: 900000 } });
  return { calls, clock, coordinator, project };
}
const setProject = (coordinator, project) => { coordinator.project = structuredClone(project); };

test('a floor wake with nothing new keeps the rest the wait asked for: no request, nothing charged or persisted', async () => {
  const { calls, clock, coordinator, project } = fixture();
  try {
    await coordinator.observe(event);
    assert.equal((await coordinator.tick({ wakeFloor: true })).status, 'decided');
    assert.equal(calls.length, 1);
    const used = coordinator.snapshot().usedTokens, decisionAt = coordinator.snapshot().lastDecision.at;
    // Two hours later, the host's floor timer fires: the clock is the only thing that moved.
    clock.at += 2 * HOUR; setProject(coordinator, project());
    const rested = await coordinator.tick({ wakeFloor: true });
    assert.equal(rested.status, 'idle'); assert.equal(rested.reason, 'unchanged_since_wait');
    assert.equal(rested.restUntil, decisionAt + 6 * HOUR); assert.ok(rested.savedTokens > 0, 'the request not sent is estimated');
    assert.equal(calls.length, 1, 'no request went out'); assert.equal(coordinator.snapshot().usedTokens, used, 'nothing charged');
    assert.equal(coordinator.snapshot().lastDecision.at, decisionAt, 'the wait it rests on is untouched');
  } finally { await coordinator.close(); }
});

test('the rest ends when the wait asked for it to end, and a decision is asked again', async () => {
  const { calls, clock, coordinator, project } = fixture({ rest: 3 * HOUR });
  try {
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true });
    clock.at += 3 * HOUR - 1; setProject(coordinator, project());
    assert.equal((await coordinator.tick({ wakeFloor: true })).reason, 'unchanged_since_wait');
    clock.at += 2; setProject(coordinator, project());
    assert.equal((await coordinator.tick({ wakeFloor: true })).status, 'decided');
    assert.equal(calls.length, 2);
  } finally { await coordinator.close(); }
});

test('the longest rest is a day, whatever the host or a model stretched it to', async () => {
  const { clock, coordinator, project } = fixture({ rest: 86400000 });
  try {
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true });
    const at = coordinator.snapshot().lastDecision.at;
    coordinator.state.lastDecision.nextReviewAfterMs = 400 * HOUR;
    clock.at += HOUR; setProject(coordinator, project());
    assert.equal((await coordinator.tick({ wakeFloor: true })).restUntil, at + MAX_REST_MS);
  } finally { await coordinator.close(); }
});

test('anything the model can see changing asks again: new evidence, a changed project, a changed presence', async () => {
  const { calls, clock, coordinator, project } = fixture();
  try {
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true });
    clock.at += HOUR; setProject(coordinator, project({ recentConversation: [{ id: 'm1', role: 'user', text: 'Are you there?' }] }));
    assert.equal((await coordinator.tick({ wakeFloor: true })).status, 'decided', 'a message in the conversation');
    clock.at += HOUR; setProject(coordinator, project({ recentConversation: [{ id: 'm1', role: 'user', text: 'Are you there?' }] }));
    assert.equal((await coordinator.tick({ wakeFloor: true })).reason, 'unchanged_since_wait', 'the new wait rests again');
    await coordinator.observe({ id: 'e2', type: 'conversation_result', summary: 'The foreground finished chapter two.', at: 2000 });
    assert.equal((await coordinator.tick({ wakeFloor: true })).status, 'decided', 'new evidence');
    clock.at += HOUR; setProject(coordinator, project({ recentConversation: [{ id: 'm1', role: 'user', text: 'Are you there?' }] }));
    assert.equal((await coordinator.tick({ wakeFloor: true, presence: { typing: true } })).status, 'decided', 'the user is typing');
    assert.equal(calls.length, 4);
  } finally { await coordinator.close(); }
});

test('only a floor wake rests: the model-paced lane and a forced wake ask as before', async () => {
  const { calls, clock, coordinator, project } = fixture();
  try {
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true });
    // Past the host's review ceiling (reviewMaxMs 15 min) but inside the wait's own rest: the lane the host configured is its own clock.
    clock.at += HOUR; setProject(coordinator, project());
    assert.equal((await coordinator.tick({ wakeFloor: false })).status, 'decided', 'not a floor wake');
    clock.at += HOUR; setProject(coordinator, project());
    assert.equal((await coordinator.tick({ wakeFloor: true, unchangedRest: false })).status, 'decided', 'a bypass the host forces');
    assert.equal(calls.length, 3);
    await assert.rejects(coordinator.tick({ unchangedRest: 'no' }), error => error instanceof InitiativeError && error.code === 'invalid_policy');
  } finally { await coordinator.close(); }
});

test('only a wait rests: a decision that took an action leaves nothing to rest on', async () => {
  const work = { action: 'work', reason: 'The chapter needs a check.', evidenceIds: ['e1'], content: 'Check chapter one for continuity errors.', nextReviewAfterMs: 6 * HOUR };
  const { calls, clock, coordinator, project } = fixture({ answers: [work, wait()] });
  coordinator.handlers.work = async () => ({ summary: 'Checked.', usage: { totalTokens: 0 } });
  try {
    await coordinator.observe(event); assert.equal((await coordinator.tick({ wakeFloor: true })).decision.action, 'work');
    await coordinator.idle();
    clock.at += HOUR; setProject(coordinator, project());
    assert.notEqual((await coordinator.tick({ wakeFloor: true })).reason, 'unchanged_since_wait');
    assert.ok(calls.length >= 1);
  } finally { await coordinator.close(); }
});

test('views that only the clock moves (restIgnore) do not wake the model; the rest of the request still does', async () => {
  const slid = (when, rows) => ({ communication: { sentLast24h: rows, lastDeliveredAt: when } });
  const sent = [{ at: 'earlier today', message: 'Report delivered.' }];
  const { calls, clock, coordinator, project } = fixture({ restIgnore: ['communication.sentLast24h'] });
  try {
    setProject(coordinator, project(slid('t0', sent)));
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true });
    // A day later the delivery has left the rolling 24-hour window: only that view changed.
    clock.at += HOUR; setProject(coordinator, project(slid('t0', [])));
    assert.equal((await coordinator.tick({ wakeFloor: true })).reason, 'unchanged_since_wait');
    // A field of the same block that is not a window moving is real news.
    clock.at += HOUR; setProject(coordinator, project(slid('t1', [])));
    assert.equal((await coordinator.tick({ wakeFloor: true })).status, 'decided');
    assert.equal(calls.length, 2);
  } finally { await coordinator.close(); }
  // Without the host naming it, the same window sliding is a change.
  const plain = fixture();
  try {
    setProject(plain.coordinator, plain.project(slid('t0', sent)));
    await plain.coordinator.observe(event); await plain.coordinator.tick({ wakeFloor: true });
    plain.clock.at += HOUR; setProject(plain.coordinator, plain.project(slid('t0', [])));
    assert.equal((await plain.coordinator.tick({ wakeFloor: true })).status, 'decided');
  } finally { await plain.coordinator.close(); }
});

test('the rest survives a restart: the situation is in the persisted state, not in memory', async () => {
  const { clock, coordinator, project } = fixture();
  let saved;
  try {
    await coordinator.observe(event); await coordinator.tick({ wakeFloor: true }); saved = coordinator.snapshot();
  } finally { await coordinator.close(); }
  assert.match(saved.lastDecision.situation, /^[0-9a-f]{32}$/);
  const again = new InitiativeCoordinator({ project: project(), model, provider: async function* () { throw new Error('must not be asked'); }, state: saved, now: () => clock.at + HOUR });
  try { setProject(again, project({ clock: { now: new Date(clock.at + HOUR).toISOString() } })); assert.equal((await again.tick({ wakeFloor: true })).reason, 'unchanged_since_wait'); }
  finally { await again.close(); }
});

test('restIgnore takes only a short list of dotted project paths', () => {
  const make = restIgnore => new InitiativeCoordinator({ model, provider: async function* () {}, restIgnore });
  assert.ok(make(['communication.sentLast24h', 'rhythmStatus.evolution.quota']));
  for (const bad of ['communication', [1], ['a b'], ['a..b'], ['x'.repeat(121)], Array.from({ length: 17 }, (_, i) => `k${i}`)]) assert.throws(() => make(bad), error => error instanceof InitiativeError && error.code === 'invalid_policy');
});
