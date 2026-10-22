import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stream, setup } from './helpers/gene-fixture.mjs';
import { INVITATION_KINDS, DECISION_KINDS, expireFeedbackInvitations } from '../session-invitations.mjs';

// A schedule is the user's own instruction, so the system never stops one. When its last results went unread while the user
// was away, it asks once above the composer (schedule_pause); only the answer changes `enabled`, a refusal raises the bar.
const HOUR = 3600000, DAY = 24 * HOUR, iso = ms => new Date(ms).toISOString();
const START = Date.parse('2026-10-14T01:12:00Z');
const act = (f, card, body) => fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${card.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cards = f => f.app.store.state.sessions.flatMap(row => row.invitations ?? []).filter(row => row.kind === 'schedule_pause');
const project = f => f.app.store.state.projects.find(row => row.id === f.project.id);

/** A daily 09:00 schedule with `count` delivered results (oldest first) from START, none opened; `now` is `after` past the last one. */
function seed(f, count, { after = 3 * HOUR, from = 0, existing = null } = {}) {
  const inv = f.app.store.invitations;
  const schedule = existing ?? inv.schedules.create(f.project.id, { title: '每日调研', task: '调研今天的 AI 新闻并汇报', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true, destinationSessionId: f.session.id }, { requestId: randomUUID(), source: 'user' });
  f.app.store.mutate(state => {
    const target = state.projects.find(row => row.id === f.project.id), session = state.sessions.find(row => row.id === f.session.id);
    target.scheduleRuntime ??= { schemaVersion: 1, occurrences: [] };
    for (let index = from; index < from + count; index++) {
      const at = START + index * DAY, itemId = `item-${index}`, actionId = `schedule-delivery-${index}`;
      target.scheduleRuntime.occurrences.push({ key: `k${index}`, scheduleId: schedule.id, scheduledAt: iso(at - 12 * 60000), status: 'delivered', deliveredAt: iso(at), deliveryActionId: actionId, deliveryItemId: itemId });
      target.inbox ??= []; target.inbox.push({ id: `e${index}`, actionId, kind: 'share', tier: 'inline', scheduled: true, createdAt: iso(at), status: 'unread', sessionId: f.session.id, itemId, text: '日报', feedback: null });
      session.items.push({ id: itemId, kind: 'assistant', source: 'initiative', text: '日报', createdAt: iso(at), initiativeActionId: actionId, scheduleId: schedule.id, scheduleOccurrenceKey: `k${index}`, initiative: { kind: 'scheduled', reach: 'inline' } });
    }
  });
  inv.now = inv.schedules.now = () => START + (from + count - 1) * DAY + after;
  return schedule;
}
const live = (f, id) => project(f).schedules.find(row => row.id === id);

test('results nobody opened while the user was away: asked once, above the composer of the conversation they have in front', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6);
  const inv = f.app.store.invitations;
  assert.ok(INVITATION_KINDS.includes('schedule_pause') && DECISION_KINDS.includes('schedule_pause'));
  const result = await inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card, ...others] = cards(f);
  assert.equal(others.length, 0);
  assert.deepEqual([card.scheduleId, card.title, card.count, card.projectId], [schedule.id, '每日调研', 5, f.project.id]);
  assert.equal(card.since, iso(START), 'the first of the unread results; the sixth is not a day old yet');
  assert.equal(result.pause.id, card.id);
  assert.deepEqual([project(f).schedulePauseAsks[schedule.id].outcome, project(f).schedulePauseAsks[schedule.id].run], ['asked', 5]);
  // Presence arrives every few seconds: the open card is not repeated, and the schedule is untouched.
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); await inv.onPresence(f.project.id);
  assert.equal(cards(f).length, 1);
  assert.equal(live(f, schedule.id).enabled, true, 'the system never pauses a schedule by itself');
});

test('"pause" turns the schedule off and changes nothing else; "keep" leaves it running', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6), before = structuredClone(live(f, schedule.id));
  const inv = f.app.store.invitations, labels = [];
  inv.decisions = { labelDecision: (id, value) => labels.push([id, value]) };
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card] = cards(f);
  assert.equal((await act(f, card, { action: 'answer', choice: 'rewrite' })).status, 400, 'only pause or keep');
  assert.equal((await act(f, card, { action: 'answer', choice: 'pause' })).status, 200);
  const paused = live(f, schedule.id);
  assert.equal(paused.enabled, false); assert.equal(paused.userPaused, true, 'the initiative may not turn it back on');
  assert.deepEqual([paused.task, paused.title, paused.rule, paused.destinationSessionId], [before.task, before.title, before.rule, before.destinationSessionId], 'the schedule text is the user\'s: only `enabled` changed');
  assert.equal(cards(f).length, 0);
  assert.equal(project(f).schedulePauseAsks[schedule.id].outcome, 'accepted');
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).invitationHistory.at(-1).outcome, 'answered');
  // Off: nothing more to ask about it, however long the unread run grows.
  seed(f, 1, { from: 6, existing: schedule }); await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  // Switched on again by the user: the results that went unread before are not held against it. Unread again, it is asked
  // afresh at the ordinary bar (pausing was no evidence against it).
  inv.now = inv.schedules.now = () => START + 7 * DAY - 2 * HOUR;
  inv.schedules.update(f.project.id, schedule.id, { enabled: true });
  seed(f, 6, { from: 7, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 1);
  const [again] = cards(f);
  assert.equal(again.count, 5); assert.equal(again.since, iso(START + 7 * DAY));
  assert.equal((await act(f, again, { action: 'answer', choice: 'keep' })).status, 200);
  assert.equal(live(f, schedule.id).enabled, true);
  assert.deepEqual([project(f).schedulePauseAsks[schedule.id].outcome, project(f).schedulePauseAsks[schedule.id].refusedRun], ['declined', 5]);
});

test('a refusal is evidence: the same schedule is asked again only after a run twice as long; closing the card counts as a refusal', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6), inv = f.app.store.invitations;
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal((await act(f, cards(f)[0], { action: 'dismiss' })).status, 200);
  assert.equal(project(f).schedulePauseAsks[schedule.id].refusedRun, 5);
  // Longer, but not twice as long (nine unread results): silent.
  seed(f, 4, { from: 6, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  // Ten unread results: the run they closed the card on has doubled.
  seed(f, 1, { from: 10, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].count, 10);
  assert.equal(live(f, schedule.id).enabled, true);
});

test('a card the user went past by writing lapses without a refusal; having written since the run began, they are around and nothing more is asked', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6), inv = f.app.store.invitations;
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card] = cards(f);
  assert.equal((await act(f, card, { action: 'shown' })).status, 200);
  f.app.store.mutate(state => expireFeedbackInvitations(state.sessions.find(row => row.id === f.session.id), { now: inv.now() }));
  assert.equal(cards(f).length, 0, 'asked once; a message instead lets a decision lapse');
  assert.equal(project(f).schedulePauseAsks[schedule.id].refusedRun, undefined, 'a lapse is not a refusal');
  // They wrote in the project after the run began: they are around, so nothing is asked now.
  f.app.store.mutate(state => state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u1', kind: 'user', text: '继续', createdAt: iso(START + 3 * DAY) }));
  seed(f, 3, { from: 6, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0, 'the user wrote since the first unread result arrived');
});

test('a read result ends the run; an answered result after the card closes it; deleting or switching off the schedule closes it', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6), inv = f.app.store.invitations;
  // Opened in time: the user is reading these, whatever they reply.
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).inbox.find(item => item.id === 'e4'); row.status = 'read'; row.readAt = iso(START + 4 * DAY + HOUR); row.feedback = { outcome: 'ignored', at: iso(START + 5 * DAY) }; });
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0, 'only the newest result is unread');
  seed(f, 2, { from: 6, existing: schedule });
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).inbox.find(item => item.id === 'e4'); row.status = 'unread'; delete row.readAt; row.feedback = null; });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1);
  // A result that arrives after the card is answered: the user is there after all.
  seed(f, 1, { from: 8, existing: schedule });
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).inbox.find(item => item.id === 'e8'); row.feedback = { outcome: 'replied', at: iso(START + 8 * DAY + 2 * HOUR) }; });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0);
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).invitationHistory.at(-1).outcome, 'expired');
  // A new run after the answered result is asked about afresh.
  seed(f, 5, { from: 9, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].count, 4);
  // The user turns the schedule off on its page: the question is moot.
  inv.schedules.update(f.project.id, schedule.id, { enabled: false });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0, 'switched off elsewhere');
  // Switching it on again is attention to the schedule: the unread results before it are not held against it.
  inv.schedules.update(f.project.id, schedule.id, { enabled: true });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0);
  // A card for a schedule that is deleted is closed rather than answered into a schedule that is gone.
  seed(f, 5, { from: 14, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1);
  inv.schedules.remove(f.project.id, schedule.id);
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0);
});

test('the presence report that brings the user back sees the results as they were, before its own reading marks', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6);
  const response = await fetch(f.url(`/api/projects/${f.project.id}/presence`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: f.session.id, visible: true, typing: false }) });
  assert.equal(response.status, 200);
  // The conversation in front is read right after, so every result is marked read; the card was decided before that.
  assert.ok(project(f).inbox.every(row => row.status === 'read'), 'reading marks are set');
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].scheduleId, schedule.id); assert.equal(cards(f)[0].count, 5);
  void schedule;
});

test('JEV invite.stale folds a pause card left open for a day once the conversation has settled it', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  seed(f, 6);
  const inv = f.app.store.invitations, judged = []; let settled = false;
  inv.decisions = { inviteStale: async (_project, input) => { judged.push(input); return { stale: settled, ledgerId: 'L1' }; }, labelDecision: () => {} };
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1);
  settled = true;
  const created = inv.now();
  inv.now = () => created + 25 * HOUR;
  const folded = await inv.rejudgeStale(f.project.id);
  assert.equal(folded.length, 1); assert.equal(cards(f).length, 0);
  assert.equal(judged.at(-1).kind, 'schedule_pause'); assert.match(judged.at(-1).text, /Pause the scheduled task “每日调研”, whose last 5 results nobody opened/);
});

test('before asking, JEV reads what the user said: "keep it running, I\'ll read them when I\'m back" is not asked about; anything else is', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const schedule = seed(f, 6), inv = f.app.store.invitations, judged = [], labels = [];
  // The said-so comes from before the run began (they have been away since).
  f.app.store.mutate(state => state.sessions.find(row => row.id === f.session.id).items.unshift({ id: 'said', kind: 'user', text: '日报继续跑，我回来一起看', createdAt: iso(START - 3 * DAY) }, { id: 'noise', kind: 'user', text: '第四章写到哪了', createdAt: iso(START - 4 * DAY) }));
  inv.decisions = { inviteStale: async (_project, input) => { judged.push(input); return { stale: input.conversation.some(row => /继续跑/.test(row.text)), ledgerId: 'L1' }; }, labelDecision: (id, value) => labels.push([id, value]) };
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0, 'they already said to keep it');
  assert.equal(judged.length, 1); assert.equal(judged[0].kind, 'schedule_pause'); assert.match(judged[0].text, /^Pause the scheduled task “每日调研”/);
  assert.deepEqual(judged[0].conversation, [{ role: 'user', text: '第四章写到哪了' }, { role: 'user', text: '日报继续跑，我回来一起看' }], 'their own words only, not the reports');
  assert.deepEqual(labels.at(-1), ['L1', 'folded']);
  assert.equal(project(f).schedulePauseAsks, undefined, 'a veto is not an ask');
  // The same state is not judged again on the next heartbeat; a longer run is judged afresh.
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(judged.length, 1);
  seed(f, 1, { from: 6, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(judged.length, 2); assert.equal(cards(f).length, 0);
  // Said nothing about it: asked, with the judgment kept on the card so the answer labels it.
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.items = session.items.filter(item => item.id !== 'said'); });
  seed(f, 1, { from: 7, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].ledgerId, 'L1');
  assert.equal((await act(f, cards(f)[0], { action: 'answer', choice: 'pause' })).status, 200);
  assert.deepEqual(labels.at(-1), ['L1', 'schedule_pause_accepted']);
  // No judge or no verdict (the judge off, a failed call): asked as code decided.
  inv.decisions = { inviteStale: async () => null, labelDecision: () => {} };
  inv.schedules.update(f.project.id, schedule.id, { enabled: true });
  seed(f, 5, { from: 8, existing: schedule });
  await inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1, 'a judge that says nothing never keeps a card from the user');
});
