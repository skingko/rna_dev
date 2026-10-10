import test from 'node:test';
import assert from 'node:assert/strict';
import { HARM_MIN_SHARED, HARM_MARGIN, outcomeRows, addReaction, pairOccurrences, harmAssessment, generationOutcomes, scoreboard, lessonDisposition, dispositionSummary, geneScope, infraOfFailure } from '../gene-outcomes.mjs';
import { bumpExposure, exposureOf, unproven, EXPOSURE_EVIDENCE, dayKey } from '../project-genes.mjs';

// P2 batch D, D3: the evolution's background outcome lane (plan §2.2 D3). Pure functions: one row per action, occurrences of
// the same schedule paired (ModularRSI confirm.py), harm detection with min_shared and a wide margin, typed dispositions,
// per-generation outcomes and the prediction scoreboard (rrsi loop.py:159-176).
const HOUR = 3600000, DAY = 24 * HOUR, NOW = Date.parse('2026-10-05T12:00:00Z');
const row = (scheduleId, daysAgo, outcome, extra = {}) => ({ id: `${scheduleId}:${daysAgo}`, kind: 'scheduled', actionId: `a-${scheduleId}-${daysAgo}`, scheduleId, at: NOW - daysAgo * DAY, outcome, ...extra });

test('the thresholds are the ones ModularRSI confirm.py ships: three matched samples and a margin just over one step of one third', () => {
  assert.equal(HARM_MIN_SHARED, 3); assert.equal(HARM_MARGIN, 0.34);
});

test('harmAssessment: paired on the same schedule, harmful only with enough matched pairs and a margin over one flipped result', () => {
  const since = NOW - 10 * DAY;
  // Three clean occurrences before, then two of three corrected after: a delta of .67 over three matched pairs.
  const worse = [row('s1', 16, 'accepted'), row('s1', 14, 'approved'), row('s1', 12, 'accepted'), row('s1', 8, 'corrected'), row('s1', 6, 'accepted'), row('s1', 4, 'corrected')];
  const verdict = harmAssessment(worse, since);
  assert.deepEqual([verdict.shared, verdict.schedules, verdict.before.settled, verdict.after.settled], [3, 1, 3, 3]);
  assert.equal(Math.round(verdict.delta * 100) / 100, 0.67); assert.equal(verdict.harmful, true);
  // One flipped result at the minimum sample is not enough (a third is below the margin of .34).
  const one = [...worse.slice(0, 4), row('s1', 6, 'accepted'), row('s1', 4, 'accepted')];
  assert.equal(harmAssessment(one, since).harmful, false); assert.equal(Math.round(harmAssessment(one, since).delta * 1000) / 1000, 0.333);
  // Too few matched pairs: two on each side.
  assert.equal(harmAssessment([row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 8, 'corrected'), row('s1', 4, 'corrected')], since).harmful, false);
  assert.equal(harmAssessment([row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 8, 'corrected'), row('s1', 4, 'corrected')], since, { minShared: 2 }).harmful, true, 'the minimum is the only thing in the way');
});

test('harmAssessment: an occurrence nobody answered, a failed run and the weather count on neither side; an undo is a strong negative; a schedule with one side only is not compared', () => {
  const since = NOW - 10 * DAY;
  const rows = [row('s1', 16, 'accepted'), row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 9, 'unanswered'), row('s1', 8, 'failed'), row('s1', 7, 'infra'), row('s1', 6, 'undone'), row('s1', 5, 'undone'), row('s1', 4, 'corrected'),
    // Only after: nothing to compare it with.
    row('s2', 3, 'corrected'), row('s2', 2, 'corrected'), row('s2', 1, 'corrected')];
  const verdict = harmAssessment(rows, since);
  assert.deepEqual([verdict.schedules, verdict.shared, verdict.after.settled], [1, 3, 3], 'only the schedule with both sides, only settled rows');
  assert.equal(verdict.harmful, true);
  assert.equal(harmAssessment(rows.filter(item => item.scheduleId === 's2'), since).shared, 0);
});

test('harmAssessment: every schedule weighs the same, so a busy schedule cannot hide a worse quiet one', () => {
  const since = NOW - 10 * DAY;
  // s1 has many clean results on both sides; s2 has three clean before and three corrected after.
  const rows = [...[20, 19, 18, 17, 16, 15, 14].map(days => row('s1', days, 'accepted')), ...[9, 8, 7, 6, 5, 4, 3].map(days => row('s1', days, 'accepted')),
    row('s2', 16, 'accepted'), row('s2', 14, 'accepted'), row('s2', 12, 'accepted'), row('s2', 8, 'corrected'), row('s2', 6, 'corrected'), row('s2', 4, 'corrected')];
  const verdict = harmAssessment(rows, since);
  assert.equal(verdict.schedules, 2); assert.equal(verdict.delta, 0.5, '(0 + 1) / 2 over the two schedules');
  assert.equal(verdict.harmful, true);
});

test('harmAssessment: equal windows next to the generation — an early rough period does not dilute the baseline, and a recovery shows', () => {
  const since = NOW - 10 * DAY;
  // Ten corrected occurrences long ago, then three clean ones right before the rule, then three corrected after it. Against the
  // whole history the baseline is 10/13 and the delta .23 (under the margin); against the three just before it, it is 0.
  const rough = [...Array.from({ length: 10 }, (_, index) => row('s1', 60 - index, 'corrected')), row('s1', 16, 'accepted'), row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 8, 'corrected'), row('s1', 6, 'corrected'), row('s1', 4, 'corrected')];
  const verdict = harmAssessment(rough, since);
  assert.deepEqual([verdict.shared, verdict.before.rate, verdict.after.rate, verdict.harmful], [3, 0, 1, true]);
  // Four corrected after the rule, then eight clean ones: the latest window shows the recovery, not the early trouble.
  const recovered = [...[20, 19, 18, 17, 16, 15, 14, 13].map(days => row('s1', days, 'accepted')), ...[9, 8, 7, 6].map(days => row('s1', days, 'corrected')), ...[5, 4.5, 4, 3.5, 3, 2.5, 2, 1].map(days => row('s1', days, 'accepted'))];
  const after = harmAssessment(recovered, since);
  assert.deepEqual([after.shared, after.after.rate, after.harmful], [8, 0, false]);
  assert.equal(after.latestAt, NOW - DAY, 'the newest occurrence in the after window');
  assert.equal(harmAssessment([], since).latestAt, null);
});

test('harmAssessment: one flipped result never decides it — a schedule is compared only with at least min_shared matched pairs of its own', () => {
  const since = NOW - 10 * DAY;
  // The reviewer's case: s1 has one clean report before the rule and one corrected after it, s2 two clean before and two clean after. Summed
  // as occurrence pairs that read "3 shared, delta .5", decided by a single flipped result; each schedule is too thin to be compared alone.
  const thin = [row('s1', 16, 'accepted'), row('s1', 6, 'corrected'), row('s2', 16, 'accepted'), row('s2', 14, 'accepted'), row('s2', 8, 'accepted'), row('s2', 6, 'accepted')];
  const verdict = harmAssessment(thin, since);
  assert.deepEqual([verdict.shared, verdict.schedules, verdict.delta, verdict.harmful], [0, 0, null, false], 'two schedules with one and two matched pairs say nothing');
  // With every compared schedule three pairs deep, one flipped result moves the delta by a third at most, whatever the number of schedules.
  for (const clean of [1, 2, 5]) {
    const rows = Array.from({ length: clean }, (_, index) => `c${index}`).flatMap(id => [16, 14, 12, 8, 6, 4].map(days => row(id, days, 'accepted')));
    rows.push(...[16, 14, 12].map(days => row('flip', days, 'accepted')), row('flip', 8, 'corrected'), row('flip', 6, 'accepted'), row('flip', 4, 'accepted'));
    const flipped = harmAssessment(rows, since);
    assert.ok(flipped.delta <= 1 / 3 + 1e-9 && flipped.harmful === false, `${clean + 1} schedules: ${flipped.delta}`);
  }
});

test('harmAssessment: a rule is judged on the work right after its generation as well as now — an older rule is not blamed for a regression that began long after it', () => {
  const clean = [90, 80, 70].map(days => row('s1', days, 'accepted')), longClean = [55, 50, 45, 40, 35, 30, 25, 20, 15, 12].map(days => row('s1', days, 'accepted')), bad = [6, 4, 2].map(days => row('s1', days, 'corrected'));
  const rows = [...clean, ...longClean, ...bad];
  // The old rule is 60 days old and was followed by ten clean reports; the new one is 8 days old and the last three reports were corrected.
  const old = harmAssessment(rows, NOW - 60 * DAY), fresh = harmAssessment(rows, NOW - 8 * DAY);
  assert.deepEqual([old.before.rate, old.onset.rate, old.after.rate, old.harmful], [0, 0, 1, false], 'the work right after it was fine; only the newest window is bad');
  assert.deepEqual([fresh.before.rate, fresh.onset.rate, fresh.after.rate, fresh.harmful], [0, 1, 1, true]);
  // The mirror: bad right after the rule and fine since is a recovery, not harm.
  const recovered = harmAssessment([...[20, 18, 16].map(days => row('s1', days, 'accepted')), ...[8, 6, 4].map(days => row('s1', days, 'corrected')), ...[3, 2, 1].map(days => row('s1', days, 'accepted'))], NOW - 10 * DAY);
  assert.deepEqual([recovered.onset.rate, recovered.after.rate, recovered.harmful], [1, 0, false]);
});

test('harmAssessment: `latestBadAt` is the newest corrected, taken-back or voted-down occurrence in the windows — a clean one of another schedule does not move it', () => {
  const since = NOW - 10 * DAY;
  const base = [row('s1', 16, 'accepted'), row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 8, 'corrected'), row('s1', 6, 'undone'), row('s1', 4, 'corrected'),
    row('s2', 16, 'accepted'), row('s2', 14, 'accepted'), row('s2', 12, 'accepted'), row('s2', 8, 'accepted'), row('s2', 6, 'accepted'), row('s2', 4, 'accepted')];
  const first = harmAssessment(base, since);
  assert.deepEqual([first.harmful, first.latestBadAt, first.latestAt], [true, NOW - 4 * DAY, NOW - 4 * DAY]);
  const later = harmAssessment([...base, row('s2', 1, 'accepted')], since);
  assert.equal(later.latestAt, NOW - DAY, 'a later occurrence of the other schedule is the newest'); assert.equal(later.latestBadAt, NOW - 4 * DAY, 'but it is no new evidence of harm');
  assert.equal(harmAssessment([...base, row('s1', 1, 'disliked')], since).latestBadAt, NOW - DAY, 'a vote down is');
  assert.equal(harmAssessment([row('s1', 16, 'accepted'), row('s1', 14, 'accepted'), row('s1', 12, 'accepted'), row('s1', 8, 'accepted'), row('s1', 6, 'accepted'), row('s1', 4, 'accepted')], since).latestBadAt, null);
});

test('pairOccurrences: a corrected occurrence is set against the accepted one of the same schedule closest to it, never across schedules', () => {
  const rows = [row('s1', 9, 'accepted'), row('s1', 5, 'corrected'), row('s1', 4, 'approved'), row('s2', 8, 'corrected'), row('s2', 20, 'accepted'), row('s3', 3, 'corrected'), row('s1', 2, 'unanswered')];
  const pairs = pairOccurrences(rows);
  assert.deepEqual(pairs.map(pair => [pair.scheduleId, pair.bad.id, pair.good.id]).sort(), [['s1', 's1:5', 's1:4'], ['s2', 's2:8', 's2:20']], 's3 has no accepted occurrence, an unanswered one is no partner');
});

test('addReaction keeps the strongest reaction of a delivery: a correction outweighs an approval, an approval a reply that did not correct', () => {
  const map = new Map();
  addReaction(map, 'i1', { outcome: 'accepted', at: 1 }); addReaction(map, 'i1', { outcome: 'corrected', at: 2 }); addReaction(map, 'i1', { outcome: 'approved', at: 3 });
  assert.equal(map.get('i1').outcome, 'corrected');
  addReaction(map, 'i2', { outcome: 'accepted', at: 1 }); addReaction(map, 'i2', { outcome: 'approved', at: 2 });
  assert.equal(map.get('i2').outcome, 'approved');
  addReaction(map, 'i3', { outcome: 'ignored' }); assert.equal(map.has('i3'), false, 'only the three reactions count');
});

test('infraOfFailure: a failed run the model service or the network caused is the weather; a tool or script failure is not', () => {
  assert.equal(infraOfFailure({ code: 'connection' }), 'network');
  assert.equal(infraOfFailure({ code: 'idle_timeout' }), 'network');
  assert.equal(infraOfFailure({ code: 'x', httpStatus: 429 }), 'capacity');
  assert.equal(infraOfFailure({ code: 'x', httpStatus: 503 }), 'service');
  assert.equal(infraOfFailure({ code: 'x', httpStatus: 401 }), 'access');
  assert.equal(infraOfFailure({ code: 'tool_failed' }), null);
  assert.equal(infraOfFailure({ code: 'invalid_request_error', httpStatus: 400 }), null, 'a malformed request is ours, not the weather');
  assert.equal(infraOfFailure(null), null);
});

// ------------------------------------------------------------------------------------- the rows
function world() {
  const occurrence = (key, scheduleId, daysAgo, extra = {}) => ({ key, scheduleId, scheduledAt: new Date(NOW - daysAgo * DAY).toISOString(), claimedAt: new Date(NOW - daysAgo * DAY).toISOString(), actionId: `work-${key}`, deliveryActionId: `deliver-${key}`, status: 'delivered', deliveredAt: new Date(NOW - daysAgo * DAY + HOUR).toISOString(), deliveryItemId: `item-${key}`, ...extra });
  const item = key => ({ id: `item-${key}`, turnId: null, kind: 'assistant', text: `report ${key}`, createdAt: new Date(NOW - 5 * DAY).toISOString(), source: 'initiative', initiativeActionId: `deliver-${key}`, scheduleId: 's1', scheduleOccurrenceKey: key, initiative: { kind: 'scheduled' } });
  const project = { id: 'p1', schedules: [{ id: 's1', title: '每日报告', task: '写日报' }], jobs: [], inbox: [], backgroundChanges: [], directFixes: [], mind: { threads: [] }, initiativeRuntime: { sdkState: { actions: [] } },
    scheduleRuntime: { occurrences: [occurrence('o1', 's1', 6), occurrence('o2', 's1', 5), occurrence('o3', 's1', 4), occurrence('o4', 's1', 3), occurrence('o5', 's1', 2, { status: 'failed', deliveryItemId: undefined, deliveredAt: undefined, errorCode: 'schedule_action_failed' }), occurrence('o6', 's1', 1, { status: 'running', deliveryItemId: undefined, deliveredAt: undefined }), occurrence('o7', 's1', 7, { status: 'skipped', deliveryItemId: undefined })] } };
  project.initiativeRuntime.sdkState.actions.push({ id: 'work-o5', action: 'work', status: 'failed', hostSchedule: { key: 'o5' }, failure: { code: 'connection', message: 'ECONNRESET' } });
  const session = { id: 'sess1', projectId: 'p1', items: ['o1', 'o2', 'o3', 'o4'].map(item), turns: [] };
  return { project, sessions: [session] };
}

test('one outcome row per scheduled occurrence: delivered ones read what the user said about the delivery, the weather is infra, a run still going is pending, a skipped one has no row', () => {
  const { project, sessions } = world();
  const reactions = new Map(); addReaction(reactions, 'item-o1', { outcome: 'accepted', at: NOW }); addReaction(reactions, 'item-o2', { outcome: 'corrected', at: NOW }); addReaction(reactions, 'item-o3', { outcome: 'approved', at: NOW });
  const rows = outcomeRows(project, sessions, { now: NOW, reactions });
  const by = Object.fromEntries(rows.map(entry => [entry.occurrenceKey, entry.outcome]));
  assert.deepEqual(by, { o1: 'accepted', o2: 'corrected', o3: 'approved', o4: 'unanswered', o5: 'infra', o6: 'pending' }, 'one per occurrence key; o7 (skipped) ran nothing');
  const first = rows.find(entry => entry.occurrenceKey === 'o1');
  assert.deepEqual([first.kind, first.scheduleId, first.actionId, first.itemId, first.sessionId], ['scheduled', 's1', 'work-o1', 'item-o1', 'sess1']);
  assert.equal(rows.find(entry => entry.occurrenceKey === 'o5').reason, 'network');
  assert.equal(rows.filter(entry => entry.occurrenceKey === 'o1').length, 1);
});

test('the user\'s thumbs on a delivery are a reaction too: up is an approval, down a rejection; a message about it outranks a vote; both count in the harm reading', () => {
  const { project, sessions } = world();
  sessions[0].items.find(entry => entry.id === 'item-o1').feedback = { vote: 'up', at: new Date(NOW).toISOString() };
  sessions[0].items.find(entry => entry.id === 'item-o2').feedback = { vote: 'down', at: new Date(NOW).toISOString() };
  sessions[0].items.find(entry => entry.id === 'item-o3').feedback = { vote: 'up', at: new Date(NOW).toISOString() };
  const reactions = new Map(); addReaction(reactions, 'item-o3', { outcome: 'corrected', at: NOW });
  const by = Object.fromEntries(outcomeRows(project, sessions, { now: NOW, reactions }).map(entry => [entry.occurrenceKey, entry.outcome]));
  assert.deepEqual([by.o1, by.o2, by.o3, by.o4], ['approved', 'disliked', 'corrected', 'unanswered'], 'o3: the message said more than the vote');
  const since = NOW - 10 * DAY;
  assert.equal(harmAssessment([row('s1', 16, 'approved'), row('s1', 14, 'approved'), row('s1', 12, 'approved'), row('s1', 8, 'disliked'), row('s1', 6, 'disliked'), row('s1', 4, 'approved')], since).harmful, true, 'two thumbs-down of three after three thumbs-up before');
});

test('a failure that is not the weather stays failed; an undone change set is a strong negative whatever else was said; a delivery in a deleted conversation has no row', () => {
  const { project, sessions } = world();
  project.initiativeRuntime.sdkState.actions[0].failure = { code: 'tool_failed', message: 'the script exited 1' };
  project.backgroundChanges.push({ id: 'c1', actionId: 'work-o3', status: 'reverted', revertedAt: new Date(NOW).toISOString() });
  sessions[0].items.find(entry => entry.id === 'item-o4').sourceDeleted = true;
  const reactions = new Map(); addReaction(reactions, 'item-o3', { outcome: 'approved', at: NOW });
  const rows = outcomeRows(project, sessions, { now: NOW, reactions }), by = Object.fromEntries(rows.map(entry => [entry.occurrenceKey, entry.outcome]));
  assert.equal(by.o5, 'failed'); assert.equal(by.o3, 'undone', 'the user took the changes back: theirs is the outcome even though they approved the report');
  assert.equal('o4' in by, false);
  assert.equal(rows.find(entry => entry.occurrenceKey === 'o3').change, 'undone');
});

test('a decided action is read through the C2 view: delivered and answered, delivered and not, undone, failed', () => {
  const project = { id: 'p1', schedules: [], jobs: [], inbox: [], backgroundChanges: [{ id: 'c1', actionId: 'act-undo', status: 'reverted', revertedAt: new Date(NOW).toISOString() }], directFixes: [], mind: { threads: [] }, scheduleRuntime: { occurrences: [] },
    initiativeRuntime: { sdkState: { actions: [{ id: 'act-share', action: 'share', status: 'completed', createdAt: new Date(NOW - 2 * DAY).toISOString() }, { id: 'act-quiet', action: 'share', status: 'completed', createdAt: new Date(NOW - 2 * DAY).toISOString() }, { id: 'act-undo', action: 'work', status: 'completed', createdAt: new Date(NOW - 2 * DAY).toISOString(), startedAt: new Date(NOW - 2 * DAY).toISOString(), finishedAt: new Date(NOW - 2 * DAY + HOUR).toISOString() }, { id: 'act-fail', action: 'work', status: 'failed', createdAt: new Date(NOW - DAY).toISOString(), startedAt: new Date(NOW - DAY).toISOString(), finishedAt: new Date(NOW - DAY + HOUR).toISOString(), failure: { code: 'tool_failed' } }] } } };
  const share = id => ({ id: `msg-${id}`, turnId: null, kind: 'assistant', text: 'finding', createdAt: new Date(NOW - 2 * DAY + HOUR).toISOString(), source: 'initiative', initiativeActionId: id, initiative: { kind: 'insight', reach: 'inline' } });
  const sessions = [{ id: 'sess1', projectId: 'p1', items: [share('act-share'), share('act-quiet')], turns: [] }];
  const reactions = new Map(); addReaction(reactions, 'msg-act-share', { outcome: 'approved', at: NOW });
  const by = Object.fromEntries(outcomeRows(project, sessions, { now: NOW, reactions }).map(entry => [entry.actionId, entry.outcome]));
  assert.deepEqual(by, { 'act-share': 'approved', 'act-quiet': 'unanswered', 'act-undo': 'undone', 'act-fail': 'failed' });
});

// -------------------------------------------------------------------------- generations and scoreboard
test('generationOutcomes: the correction rate of the work between one generation and the next, against the epoch before it', () => {
  const generations = [{ n: 1, at: new Date(NOW - 20 * DAY).toISOString(), summary: 'one', trigger: 'feedback' }, { n: 2, at: new Date(NOW - 10 * DAY).toISOString(), summary: 'two', trigger: 'correction' }, { n: 3, at: new Date(NOW - 3 * DAY).toISOString(), summary: 'three', trigger: 'contrast' }];
  const at = days => NOW - days * DAY;
  const events = [{ at: at(18), outcome: 'corrected' }, { at: at(15), outcome: 'corrected' }, { at: at(12), outcome: 'accepted' }, { at: at(8), outcome: 'accepted' }, { at: at(7), outcome: 'corrected' }, { at: at(6), outcome: 'approved' }, { at: at(5), outcome: 'accepted' }, { at: at(2), outcome: 'accepted' }, { at: at(1), outcome: 'failed' }];
  const rows = generationOutcomes(generations, events, { now: NOW });
  assert.deepEqual(rows.map(entry => entry.n), [3, 2, 1], 'newest first');
  const [third, second, first] = rows;
  assert.deepEqual([first.bad, first.known], [2, 3]); assert.equal(first.before, null);
  assert.deepEqual([second.bad, second.known, second.before.bad, second.before.known], [1, 4, 2, 3]);
  assert.equal(third.rate, 0, 'nothing corrected since the third'); assert.equal(third.failed, 1); assert.equal(third.known, 1);
});

test('scoreboard: a patch with its expectation is set against what happened to its schedule before and after its generation; the outcome is a recorded count, not a reading of its words', () => {
  const generations = [{ n: 4, at: new Date(NOW - 8 * DAY).toISOString() }, { n: 5, at: new Date(NOW - 3 * DAY).toISOString() }];
  const project = { genes: { generations, genes: [
    { id: 'skill-patch:a', layer: 'skill', title: '先核对数字', status: 'trial', generation: 4, body: { expectation: '数字不再出错' }, origin: { kind: 'correction', scheduleIds: ['s1'] }, stats: { applied: 2 } },
    { id: 'skill-patch:b', layer: 'skill', title: '先列提纲', status: 'trial', generation: 5, body: { expectation: '结构清楚' }, origin: { kind: 'correction', scheduleIds: ['s1'] } },
    { id: 'guard:g', layer: 'guard', title: '检查', status: 'active', generation: 5, body: {}, origin: { kind: 'lesson' }, stats: { real: 1 } },
    { id: 'skill-patch:old', layer: 'skill', title: '旧', status: 'rejected', generation: 4, body: {} }, { id: 'system:x', layer: 'system', status: 'active' }] } };
  const rows = [row('s1', 12, 'corrected'), row('s1', 10, 'accepted'), row('s1', 6, 'accepted'), row('s1', 5, 'accepted'), row('s1', 2, 'corrected')];
  const board = scoreboard(project, rows), by = Object.fromEntries(board.map(entry => [entry.geneId, entry]));
  assert.deepEqual(Object.keys(by).sort(), ['guard:g', 'skill-patch:a', 'skill-patch:b'], 'a rejected rule or a system record is no prediction');
  assert.deepEqual([by['skill-patch:a'].before, by['skill-patch:a'].after, by['skill-patch:a'].verdict], [{ bad: 1, known: 2 }, { bad: 1, known: 3 }, 'again']);
  assert.equal(by['skill-patch:b'].verdict, 'again', 'the schedule was corrected again after it');
  assert.equal(by['guard:g'].verdict, 'held'); assert.deepEqual(by['guard:g'].scope, { kind: 'foreground' });
  assert.equal(by['skill-patch:a'].expectation, '数字不再出错');
  assert.deepEqual(board.map(entry => entry.generation), [5, 5, 4], 'newest generation first');
  const quiet = scoreboard(project, [...rows.filter(entry => entry.outcome !== 'corrected' || entry.at < NOW - 11 * DAY), row('s1', 1, 'accepted')]);
  assert.equal(Object.fromEntries(quiet.map(entry => [entry.geneId, entry.verdict]))['skill-patch:b'], 'held', 'settled work after it and no correction');
  assert.equal(geneScope(project.genes.genes[0]).join(), 's1');
  assert.deepEqual(scoreboard(project, []).find(entry => entry.geneId === 'skill-patch:b').verdict, 'pending');
});

// ------------------------------------------------------------------------------------ dispositions
test('lessonDisposition: only verdicts are terminal; the weather is retryable; a lesson that became a rule is a rule (ModularRSI dispositions.py)', () => {
  const rule = status => ({ id: 'skill-patch:r', layer: 'skill', status, origin: { kind: 'lesson', lessonId: 'l1' } });
  const project = (route, genes = [], extra = {}) => ({ genes: { genes }, mind: { lessons: [{ id: 'l1', status: 'active', kind: 'preference', text: 'x', geneRoute: route, ...extra }] } });
  const of = (route, genes, extra) => lessonDisposition(project(route, genes, extra), project(route, genes, extra).mind.lessons[0]);
  assert.deepEqual(of({ version: 3, method: true, geneId: 'skill-patch:r' }, [rule('trial')]), { kind: 'gene', code: 'practice', geneId: 'skill-patch:r', status: 'trial' });
  assert.equal(of({ version: 3, guard: true }, [{ id: 'guard:g', layer: 'guard', status: 'active', origin: { lessonId: 'l1' } }]).code, 'guard');
  assert.deepEqual([of({ version: 3, coveredBy: 'instructions' }).kind, of({ version: 3, coveredBy: 'instructions' }).code], ['terminal', 'covered']);
  assert.equal(of({ version: 3, consolidated: 'duplicate', geneId: 'x' }).code, 'covered');
  assert.equal(of({ version: 3, conflictsWith: 'g', disposition: 'conflicts_rule' }).code, 'conflicts_rule');
  assert.deepEqual([of({ version: 3, guard: false, method: false }).kind, of({ version: 3, guard: false, method: false }).code], ['terminal', 'profile_only']);
  assert.deepEqual(of({ version: 3, method: true, retry: { code: 'interrupted', attempts: 1 } }), { kind: 'retryable', code: 'interrupted', attempts: 1 });
  assert.equal(of({ version: 3, guard: true, guardCapAt: 'x' }).code, 'guard_cap');
  assert.deepEqual([of({ version: 3, periodic: true, scheduleOfferedAt: 'x' }).kind, of({ version: 3, periodic: true, scheduleOfferedAt: 'x' }).code], ['terminal', 'schedule']);
  assert.deepEqual(of(undefined), { kind: 'pending', code: 'not_routed' });
  assert.equal(of(undefined, [], { needsConfirmation: true }).code, 'awaiting_confirmation');
  assert.deepEqual([of({ version: 3, method: true }, [{ ...rule('rejected'), rejection: { code: 'review_failed' } }]).kind, of({ version: 3, method: true }, [{ ...rule('rejected'), rejection: { code: 'review_failed' } }]).code], ['terminal', 'rejected']);
  assert.equal(of({ version: 3, method: true }, [{ ...rule('rejected'), rejection: { code: 'commit_failed', retryable: true } }]).kind, 'retryable', 'a failed save is the weather');
  assert.equal(of({ version: 3, method: true }, [rule('retired')]).code, 'retired');
  assert.equal(of({ version: 3, method: true }).code, 'to_write');
});

test('dispositionSummary counts the routable lessons by kind and code (a lesson that left by why it left), newest open ones first', () => {
  const lesson = (id, route, extra = {}) => ({ id, status: 'active', kind: 'constraint', text: id, geneRoute: route, updatedAt: `2026-10-0${id.slice(1)}T00:00:00Z`, ...extra });
  const project = { genes: { genes: [{ id: 'guard:g', layer: 'guard', status: 'active', origin: { lessonId: 'l1' } }] }, mind: { lessons: [lesson('l1', { version: 3, guard: true, geneId: 'guard:g' }), lesson('l2', { version: 3, guard: false, method: false }), lesson('l3', { version: 3, method: true, retry: { code: 'author_error', attempts: 0 } }), lesson('l4', { version: 3, guard: false, method: false }), lesson('l5', undefined, { kind: 'success_habit' }), lesson('l6', undefined, { status: 'superseded' })] } };
  const summary = dispositionSummary(project);
  assert.deepEqual(summary.counts, { gene: { guard: 1 }, terminal: { profile_only: 2, superseded: 1 }, retryable: { author_error: 1 }, pending: {} }, 'a success habit is not routable; the superseded lesson left');
  const left = dispositionSummary({ genes: { genes: [] }, mind: { lessons: [lesson('l1', undefined, { status: 'superseded', supersededReason: 'contradicts' }), lesson('l2', undefined, { status: 'superseded', supersededReason: 'user_chose' }), lesson('l3', undefined, { status: 'superseded', supersededReason: 'refines' }), lesson('l4', undefined, { status: 'retired', retiredReason: 'user' }), lesson('l5', undefined, { status: 'retired', retiredReason: 'expired' })] } });
  assert.deepEqual(left.counts.terminal, { contradicted: 2, superseded: 1, revoked: 1, expired: 1 }); assert.deepEqual(left.recent, [], 'a lesson that left is not an open one');
  assert.deepEqual(summary.recent.map(entry => entry.lessonId), ['l4', 'l3', 'l2']);
  assert.ok(summary.recent.every(entry => !('text' in entry)), 'ids and codes only: never the words of a lesson');
});

// -------------------------------------------------------------------------------------- exposure
test('exposure: a check\'s runs are counted per local day and dropped after a fortnight; a skill rule is exposed by what put it in front of the model, never by its level', () => {
  const gene = { layer: 'guard', runs: 9, hits: 3, stats: { real: 1, falseMatches: 0 } };
  for (const days of [20, 13, 6, 2, 0, 0]) bumpExposure(gene, 'ran', NOW - days * DAY);
  assert.equal(gene.exposure.days[dayKey(NOW - 20 * DAY)], undefined, 'older than a fortnight: gone');
  const use = exposureOf(gene, { now: NOW });
  assert.deepEqual([use.ran, use.ranRecent, use.hits, use.real], [9, 4, 3, 1], 'the last 7 local days: 6, 2 and today twice');
  // D1 writes `stats.injected` when the turn block carried the rule and `stats.recalled` when a reply was judged to have met it (followed or went against).
  assert.equal(exposureOf({ layer: 'skill', stats: null }).shown, null, 'nothing was shown yet: unknown, not zero');
  const rule = { layer: 'skill', stats: { injected: 7, recalled: 5, applied: 2, notFollowed: 3 } }, used = exposureOf(rule);
  assert.deepEqual([used.shown, used.recalled, used.applied, used.notFollowed], [7, 5, 2, 3], 'shown is how often it was put in front of the model; recalled is how often it turned out relevant');
  assert.equal(exposureOf({ layer: 'skill', stats: { recalled: 5 } }).shown, 5, 'a rule judged relevant to a reply was in front of the model, whatever put it there');
  assert.equal(exposureOf({ layer: 'skill', stats: { injected: 4 } }).shown, 4); assert.equal(exposureOf({ layer: 'skill', stats: { injected: 0 } }).shown, 0, 'recorded, and never shown');
});

test('a check that ran before the days were kept is not a dead check: its last-7-days count is unknown until a run was counted by day', () => {
  const before = { layer: 'guard', runs: 98, hits: 3, stats: { real: 1 }, lastRunAt: '2026-09-20T00:00:00Z' };
  assert.equal(exposureOf(before, { now: NOW }).ranRecent, null, '98 runs, none counted by day: unknown, not 0');
  bumpExposure(before, 'ran', NOW - 40 * DAY);
  assert.equal(exposureOf(before, { now: NOW }).ranRecent, 0, 'once days are kept, a quiet week is a quiet week');
  assert.equal(exposureOf({ layer: 'skill', stats: null }, { now: NOW }).ranRecent, null, 'a skill rule has no runs');
});

test('unproven: shown many times and never followed, or never put in front of the model over as many turns since it was written; followed once, confirmed or kept is not; no records is no evidence', () => {
  assert.equal(EXPOSURE_EVIDENCE, 8);
  assert.equal(unproven({ stats: { injected: 8, applied: 0 } }), true);
  assert.equal(unproven({ stats: { injected: 7, applied: 0 } }), false, 'not enough exposure yet');
  assert.equal(unproven({ stats: { injected: 30, applied: 1 } }), false, 'followed once: it has earned its place');
  assert.equal(unproven({ stats: { injected: 30, applied: 0 }, confirmedAt: 'x' }), false, 'the user said it is right');
  assert.equal(unproven({ stats: { injected: 30, applied: 0 }, keep: true }), false);
  assert.equal(unproven({ stats: { recalled: 8, applied: 0 } }), true, 'judged relevant eight times, never followed: it was in front of the model');
  assert.equal(unproven({ stats: null }, 8), true, 'never put in front of the model in 8 turns since it was written');
  assert.equal(unproven({ stats: null }, 7), false);
  assert.equal(unproven({ stats: null }, 0), false, 'a rule nothing has judged exposure for: nothing to say');
  assert.equal(unproven({ stats: { injected: 3, applied: 0 } }, 50), false, 'it was shown: the zero-exposure evidence does not apply');
  assert.equal(unproven({ stats: null }, 50, { putIn: 2 }), false, 'a lesson in context carried it in two of those turns, though its own block never did');
});
