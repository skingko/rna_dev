import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionOf, deliveriesOf, runsOf, pauseVerdict, MIN_RUN, AWAY_MIN_MS } from '../schedule-attention.mjs';

// Does anyone read what a schedule delivers? Read from structure only: which result reached which inbox entry, whether it was
// opened or answered, how long the oldest unread one has waited, whether the user wrote since. The shapes below are the live
// ones (a daily 09:00 report whose results the user stopped opening after 2026-10-17).
const HOUR = 3600000, DAY = 24 * HOUR, iso = ms => new Date(ms).toISOString();
const START = Date.parse('2026-10-01T01:12:00Z');
const daily = { id: 's1', title: '每日调研', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } };
const hourly = { id: 's2', title: '整点检查', enabled: true, rule: { kind: 'interval', everyMs: HOUR, anchorAt: iso(START - 12 * 60000) } };

/** `days`: one entry per delivery, oldest first: hours until it was opened, 'reply' (answered), or null (never opened). */
function history(days, { schedule = daily, every = DAY, start = START } = {}) {
  const inbox = [], occurrences = [];
  days.forEach((how, index) => {
    const at = start + index * every, actionId = `schedule-delivery-${index}`;
    occurrences.push({ key: `k${index}`, scheduleId: schedule.id, scheduledAt: iso(at - 12 * 60000), status: 'delivered', deliveredAt: iso(at), deliveryActionId: actionId, deliveryItemId: `item-${index}` });
    inbox.push({ id: `e${index}`, actionId, kind: 'share', tier: 'inline', scheduled: true, createdAt: iso(at), status: 'unread', itemId: `item-${index}`, feedback: null,
      ...(typeof how === 'number' ? { status: 'read', readAt: iso(at + how * HOUR) } : {}), ...(how === 'reply' ? { status: 'read', readAt: iso(at + HOUR), feedback: { outcome: 'replied', at: iso(at + 2 * HOUR) } } : {}) });
  });
  return { schedules: [schedule], inbox, scheduleRuntime: { occurrences } };
}
const at = (project, n, extra = 0) => START + (project.inbox.length - 1 + n) * DAY + extra;
const user = (when, text = '你好') => ({ id: `u${when}`, kind: 'user', text, createdAt: iso(when) });

test('what the user did about a result: answered, opened in time, opened late, unread, too new to say', () => {
  const base = { entry: { createdAt: iso(START), status: 'unread', feedback: null }, deliveredAt: iso(START), period: DAY };
  const state = (entry, now = START + 5 * DAY, item = null) => attentionOf({ ...base, entry: { ...base.entry, ...entry }, item, now });
  assert.equal(state({}), 'unread');
  assert.equal(state({}, START + 5 * HOUR), 'pending', 'under one period old: too early to say');
  assert.equal(state({ status: 'read', readAt: iso(START + 3 * HOUR) }), 'prompt');
  assert.equal(state({ status: 'read', readAt: iso(START + 2 * DAY) }), 'late', 'opened only after the user had been away a whole period');
  for (const entry of [{ status: 'dismissed' }, { actedAt: iso(START) }, { feedback: { outcome: 'replied' } }, { feedback: { outcome: 'acted' } }]) assert.equal(state(entry), 'responded');
  assert.equal(state({}, START + 5 * DAY, { feedback: { vote: 'down' } }), 'responded', 'a vote on the message is an answer');
  assert.equal(state({ feedback: { outcome: 'ignored' } }), 'unread', 'no reply within the window says nothing about a report that is read');
  assert.equal(state({ status: 'read', readAt: iso(START + HOUR), feedback: { outcome: 'ignored' } }), 'prompt');
});

test('the unread run ends at the last result the user opened; results too new to say are passed over; late reads are the absences they came back from', () => {
  const project = history([1, 'late', 'late', 30, 1, null, null, null, null]);
  project.inbox[1].readAt = iso(Date.parse(project.inbox[1].createdAt) + 2 * DAY); project.inbox[2].readAt = iso(Date.parse(project.inbox[2].createdAt) + 2 * DAY); project.inbox[3].readAt = iso(Date.parse(project.inbox[3].createdAt) + 30 * HOUR);
  const now = at(project, 0, 2 * HOUR), found = runsOf(deliveriesOf(project, daily, [], { now }));
  assert.equal(found.count, 3, 'the newest four are unread, the last of them is under a period old');
  assert.equal(found.since, project.inbox[5].createdAt); assert.equal(found.last, project.inbox[7].createdAt);
  assert.equal(found.resolved, 3, 'three late reads in a row before it');
  assert.equal(runsOf(deliveriesOf(history(['reply', null, null]), daily, [], { now: at(history(['reply', null, null]), 1) })).count, 2, 'an answered result ends the run');
});

test('live replay: a daily report read within its day, then not opened after 10-17, asks on the third unread day and not before', () => {
  // 24 deliveries from 2026-09-29 (as measured): read within hours, the weekend of 10-11 read on 10-13, a day late on 10-14 and 10-16,
  // and nothing opened after 10-17.
  const hours = index => index < 12 ? 3 : index === 14 ? 1 : index === 16 || index === 18 ? 12 : null;
  const project = history(Array.from({ length: 24 }, (_, index) => hours(index)), { start: Date.parse('2026-09-29T01:12:00Z') });
  const open = (index, afterHours) => { project.inbox[index].status = 'read'; project.inbox[index].readAt = iso(Date.parse(project.inbox[index].createdAt) + afterHours * HOUR); };
  open(12, 48); open(13, 24); open(15, 36); open(17, 36);
  const verdict = day => pauseVerdict(project, daily, [], { now: Date.parse(`2026-10-${day}`) });
  // Away 10-11 to 10-13 and read everything on return: the longest run they came back from is two results.
  assert.equal(runsOf(deliveriesOf(project, daily, [], { now: Date.parse('2026-10-22T11:30:00Z') })).resolved, 2);
  // After 10-17 nothing is opened. 10-18 is unread on 10-19, 10-19 on 10-20 (a result is unread once a whole period old).
  assert.deepEqual([verdict('19T03:00:00Z').ask, verdict('19T03:00:00Z').why, verdict('19T03:00:00Z').count], [false, 'run_too_short', 1]);
  assert.equal(verdict('20T03:00:00Z').count, 2);
  const third = verdict('21T03:00:00Z');
  assert.equal(third.ask, true); assert.equal(third.count, 3); assert.equal(third.since, project.inbox[19].createdAt);
  const live = verdict('22T11:30:00Z');
  assert.deepEqual([live.ask, live.count, live.required], [true, 4, 3], 'the state when this was measured: four unread days, the newest too young to count');
});

test('the oldest unread result must have waited two days, and the user must not have written since it arrived', () => {
  const project = history([1, 1, null, null, null, null]);
  const first = Date.parse(project.inbox[2].createdAt);
  assert.equal(pauseVerdict(project, daily, [], { now: first + 4 * DAY + HOUR }).ask, true);
  const sessions = (...items) => [{ id: 'a', items }];
  assert.equal(pauseVerdict(project, daily, sessions(user(first + DAY)), { now: first + 4 * DAY + HOUR }).why, 'user_wrote_since', 'they are around, just not reading these');
  assert.equal(pauseVerdict(project, daily, sessions(user(first - HOUR)), { now: first + 4 * DAY + HOUR }).ask, true, 'a message from before the run began says nothing about being away');
  // A schedule that fires every hour is not "away" after a few runs: the wait counts, not only the number of results.
  const frequent = history([1, ...Array(11).fill(null)], { schedule: hourly, every: HOUR });
  const verdict = pauseVerdict(frequent, hourly, [], { now: Date.parse(frequent.inbox[11].createdAt) + 2 * HOUR });
  assert.deepEqual([verdict.ask, verdict.why, verdict.count], [false, 'not_away_long_enough', 11]);
  const two = history([1, ...Array(60).fill(null)], { schedule: hourly, every: HOUR });
  assert.equal(pauseVerdict(two, hourly, [], { now: Date.parse(two.inbox[60].createdAt) + 2 * HOUR }).ask, true, 'two days of unread hourly results');
});

test('what the user did before raises the bar: coming back from a long absence, refusing, and a card that only lapsed', () => {
  const unread = n => Array(n).fill(null);
  // They once came back from a four-result absence by reading all four: three or four unread results prove nothing.
  const returned = history(['late', 'late', 'late', 'late', 2, ...unread(5)]);
  for (let index = 0; index < 4; index++) returned.inbox[index].readAt = iso(Date.parse(returned.inbox[index].createdAt) + (4 - index + 1) * DAY);
  const now = at(returned, 0, 3 * HOUR);
  assert.deepEqual([pauseVerdict(returned, daily, [], { now }).ask, pauseVerdict(returned, daily, [], { now }).required], [false, 5]);
  assert.equal(pauseVerdict(returned, daily, [], { now: now + DAY }).ask, true, 'the fifth unread day');
  // Refusing at a run of 4: the next ask needs a run of 8, whether or not the user read in between.
  const run = history([...unread(5)]);
  const since = run.inbox[0].createdAt;
  const refused = { ...run, schedulePauseAsks: { s1: { since, run: 4, outcome: 'declined', refusedRun: 4 } } };
  assert.deepEqual([pauseVerdict(refused, daily, [], { now: at(run, 0, 3 * HOUR) }).ask, pauseVerdict(refused, daily, [], { now: at(run, 0, 3 * HOUR) }).required], [false, 8]);
  const longer = history([...unread(9)]);
  assert.equal(pauseVerdict({ ...longer, schedulePauseAsks: refused.schedulePauseAsks }, daily, [], { now: at(longer, 0, 3 * HOUR) }).ask, true, 'twice the refused run');
  // A card nobody answered (the user wrote instead) lets the same run be asked again after MIN_RUN more unread results.
  const lapsed = { ...run, schedulePauseAsks: { s1: { since, run: 3, outcome: 'asked' } } };
  assert.equal(pauseVerdict(lapsed, daily, [], { now: at(run, 0, 3 * HOUR) }).required, 3 + MIN_RUN);
  assert.equal(pauseVerdict({ ...lapsed, schedulePauseAsks: { s1: { ...lapsed.schedulePauseAsks.s1, since: 'a different run' } } }, daily, [], { now: at(run, 0, 3 * HOUR) }).required, MIN_RUN, 'a new run starts over from the evidence about the user');
});

test('only a recurring schedule that is on is asked about; a result with no inbox entry left is not counted', () => {
  const project = history([...Array(6).fill(null)]);
  const now = at(project, 0, 3 * HOUR);
  assert.equal(pauseVerdict(project, { ...daily, enabled: false }, [], { now }).why, 'not_recurring');
  assert.equal(pauseVerdict(project, { ...daily, rule: { kind: 'once', at: iso(START) } }, [], { now }).why, 'not_recurring');
  assert.equal(pauseVerdict({ ...project, inbox: [] }, daily, [], { now }).why, 'run_too_short');
  assert.equal(pauseVerdict({ ...project, inbox: project.inbox.map(row => ({ ...row, contextRevoked: true })) }, daily, [], { now }).ask, false, 'revoked entries are not results the user could have read');
  assert.ok(AWAY_MIN_MS >= 2 * DAY);
});
