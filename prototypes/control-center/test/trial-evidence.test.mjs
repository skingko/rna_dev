import test from 'node:test';
import assert from 'node:assert/strict';
import { TRIAL_USES, exposureOf, unproven } from '../project-genes.mjs';
import { unjudgedOf, userRhythm, evidenceBar, trialVerdict, trialEvidence, AWAY_FACTOR } from '../trial-evidence.mjs';

// A trial working rule becomes active only on the user's own feedback. A rule whose work is done in the background, with the
// user away, gets none: this is the pure side of the way out (trial-evidence.mjs): counts and times, no model.
const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-22T14:30:00Z');
const ms = text => Date.parse(`${text}:00Z`);
const gene = (key, { stats = null, status = 'trial', createdAt = '2026-10-03T01:29:57.813Z', ...extra } = {}) => ({ id: `skill-patch:${key}`, layer: 'skill', key, title: key, summary: key, level: 0, status, body: { skillId: 'daily-research-workflow', when: 'writing the report', note: `\n\n## ${key}\n- do the thing.` }, stats, createdAt, history: [], ...extra });
const session = times => ({ id: 's1', projectId: 'p', items: times.map((at, index) => ({ id: `u${index}`, kind: 'user', text: '…', createdAt: typeof at === 'number' ? new Date(at).toISOString() : at })) });
const project = (genes, extra = {}) => ({ id: 'p', genes: { genes, generations: [], ...extra } });
const placed = (injected, more = {}) => ({ clean: 0, missed: 0, real: 0, falseMatches: 0, injected, ...more });

test('unjudged placements: what was put in front of a model minus what a confident judgment could use, never below zero', () => {
  assert.equal(unjudgedOf(gene('a')), 0, 'no record, nothing placed');
  assert.equal(unjudgedOf(gene('b', { stats: placed(17, { injectedRuns: 17 }) })), 17, 'seventeen background runs, none judged');
  assert.equal(unjudgedOf(gene('c', { stats: placed(5, { recalled: 2, applied: 2 }) })), 3, 'five turns carried it, two were judged');
  assert.equal(unjudgedOf(gene('d', { stats: placed(0, { recalled: 1, applied: 1, viaLesson: 1 }) })), 0, 'carried by a lesson: judged without being placed itself');
});

test('placements in background runs are shown apart: `shown` stays the count a judgment could use, the bloat rule does not call a rule nobody judged "never followed"', () => {
  const runsOnly = gene('r', { stats: placed(17, { injectedRuns: 17 }) }), mixed = gene('m', { stats: placed(10, { injectedRuns: 4, recalled: 1 }) });
  assert.deepEqual([exposureOf(runsOnly).shown, exposureOf(runsOnly).inRuns], [0, 17]);
  assert.deepEqual([exposureOf(mixed).shown, exposureOf(mixed).inRuns], [6, 4]);
  assert.equal(exposureOf(gene('old', { stats: placed(9) })).shown, 9, 'a record from before runs were counted reads as it did');
  assert.equal(exposureOf(gene('none')).shown, null, 'no record is still "nothing can be said"');
  assert.equal(unproven(runsOnly, 20), false, 'seventeen runs nobody could judge are no evidence that it was never followed, and it did reach a model');
  assert.equal(unproven(gene('r2', { stats: placed(8, { injectedRuns: 0 }) }), 0), true, 'eight judged-able placements, never followed: unchanged');
  assert.equal(unproven(gene('dead'), 8, { putIn: 0 }), true, 'never placed in eight observed turns: unchanged');
  assert.equal(unproven(runsOnly, 8, { putIn: 0 }), false);
});

test('the user\'s rhythm: when they last wrote or answered, and the longest gap between two messages; none before there are two', () => {
  const sessions = [session(['2026-10-01T00:00:00Z', '2026-10-01T02:00:00Z']), { id: 's2', items: [{ id: 'x', kind: 'user', text: '…', createdAt: '2026-10-04T02:00:00Z' }] }];
  const rhythm = userRhythm(sessions);
  assert.equal(rhythm.last, Date.parse('2026-10-04T02:00:00Z')); assert.equal(rhythm.longest, 3 * DAY); assert.equal(rhythm.messages, 3);
  assert.equal(userRhythm(sessions, { touched: Date.parse('2026-10-09T00:00:00Z') }).last, Date.parse('2026-10-09T00:00:00Z'), 'an answer to a card is being there too');
  assert.equal(userRhythm(sessions, { touched: 1 }).longest, 3 * DAY, 'an answer is not a message: the gaps are the user\'s own');
  assert.equal(userRhythm([session(['2026-10-01T00:00:00Z'])]).longest, null);
  assert.equal(userRhythm([]).last, 0);
  // Assistant and tool rows are not the user.
  assert.equal(userRhythm([{ id: 's', items: [{ id: 'a', kind: 'assistant', text: 'hi', createdAt: '2026-10-01T00:00:00Z' }, { id: 'b', kind: 'user', text: '…', createdAt: '2026-10-02T00:00:00Z' }] }]).messages, 1);
});

test('the bar: TRIAL_USES unjudged placements; a refusal doubles it for the project; a card that only lapsed needs TRIAL_USES more; no cap', () => {
  const g = gene('a');
  assert.equal(evidenceBar(project([g]), g), TRIAL_USES);
  assert.equal(evidenceBar(project([g], { evidenceAsks: { refused: 17 } }), g), 34, 'they put up with 17 unjudged placements: twice that');
  assert.equal(evidenceBar(project([g], { evidenceAsks: { refused: 1 } }), g), TRIAL_USES, 'a small refusal does not lower the floor');
  const lapsed = gene('b', { evidenceAsk: { outcome: 'asked', unjudged: 17, n: 1 } });
  assert.equal(evidenceBar(project([lapsed]), lapsed), 17 + TRIAL_USES);
  const kept = gene('c', { evidenceAsk: { outcome: 'kept', unjudged: 17, n: 1 } });
  assert.equal(evidenceBar(project([kept], { evidenceAsks: { refused: 17 } }), kept), 34, 'a kept card is a refusal, not a lapse');
  let refused = 0; for (let round = 0; round < 12; round++) refused = evidenceBar(project([g], { evidenceAsks: { refused } }), g);
  assert.equal(refused, TRIAL_USES * 2 ** 11, 'refusing again and again keeps raising it: there is no ceiling and no fixed interval');
});

test('the verdict says why a rule is not asked about: not on trial, settled, corrected, followed enough, too few placements, no rhythm, not away long enough', () => {
  const rhythm = { last: NOW - 20 * DAY, longest: 2 * DAY, messages: 9 }, rhythmOf = () => rhythm, p = project([]);
  const ask = (g, r = rhythmOf) => trialVerdict(p, g, r, { now: NOW });
  const base = { stats: placed(5, { injectedRuns: 5 }) };
  assert.deepEqual(Object.fromEntries(['ask', 'unjudged', 'required', 'longest'].map(key => [key, ask(gene('ok', base))[key]])), { ask: true, unjudged: 5, required: TRIAL_USES, longest: 2 * DAY });
  assert.equal(ask(gene('active', { ...base, status: 'active' })).why, 'not_on_trial');
  for (const extra of [{ keep: true }, { confirmedAt: '2026-10-04T00:00:00Z' }, { confirmations: 1 }, { retireOffered: '2026-10-04T00:00:00Z' }]) assert.equal(ask(gene('s', { ...base, ...extra })).why, 'settled', JSON.stringify(extra));
  assert.equal(ask(gene('corrected', { stats: placed(5, { missed: 1 }) })).why, 'corrected');
  assert.equal(ask(gene('followed', { stats: placed(9, { applied: TRIAL_USES, recalled: TRIAL_USES }) })).why, 'followed_enough', 'it only waits for a message that does not correct it');
  assert.equal(ask(gene('few', { stats: placed(TRIAL_USES - 1) })).why, 'too_few_placements');
  assert.equal(ask(gene('quiet'), () => ({ last: 0, longest: null, messages: 1 })).why, 'too_few_placements', 'no placements: the rule is dormant, not stranded');
  assert.equal(ask(gene('norhythm', base), () => ({ last: NOW - DAY, longest: null, messages: 1 })).why, 'no_rhythm', 'with no gap yet there is nothing to compare the absence with');
  assert.equal(ask(gene('here', base), () => ({ last: NOW - 3 * DAY, longest: 2 * DAY, messages: 9 })).why, 'not_away_long_enough', '3 days is not more than twice their longest absence');
  assert.equal(ask(gene('there', base), () => ({ last: NOW - 4 * DAY - HOUR, longest: 2 * DAY, messages: 9 })).ask, true);
  assert.equal(AWAY_FACTOR, 2);
  // A rule written after the user left has been in force for less than the whole absence: the wait counts from when it was written.
  const young = gene('young', { ...base, createdAt: new Date(NOW - 3 * DAY).toISOString() });
  assert.equal(ask(young).why, 'not_away_long_enough'); assert.equal(ask(young).waited, 3 * DAY);
});

test('one rule at a time: the one with the most unjudged placements, the oldest among equals; rules off trial or settled are left alone', () => {
  const sessions = [session(['2026-09-25T10:00:00Z', '2026-09-26T10:00:00Z', '2026-09-28T10:00:00Z'])];
  const genes = [gene('few', { stats: placed(4, { injectedRuns: 4 }) }), gene('many', { stats: placed(9, { injectedRuns: 9 }), createdAt: '2026-10-05T00:00:00Z' }), gene('tied', { stats: placed(9, { injectedRuns: 9 }), createdAt: '2026-10-04T00:00:00Z' }), gene('on', { status: 'active', stats: placed(30, { injectedRuns: 30 }) }), gene('kept', { keep: true, stats: placed(30, { injectedRuns: 30 }) })];
  const { rows, ask } = trialEvidence(project(genes), sessions, { now: NOW });
  assert.equal(ask.gene.id, 'skill-patch:tied');
  assert.deepEqual(rows.map(row => [row.gene.key, row.ask ? 'ask' : row.why]), [['few', 'ask'], ['many', 'ask'], ['tied', 'ask'], ['kept', 'settled']], 'every trial rule has a verdict; the active one is not a candidate');
  assert.deepEqual(trialEvidence(project([gene('x', { status: 'active' })]), sessions, { now: NOW }), { rows: [], ask: null });
});

// ---- live replay (2026-10-22): the shapes of the two live projects, as counts and times only (no conversation text).
// The research project: its user wrote 23 times from 09-25 to 10-03 (never away more than 2.55 days), then stopped; three trial
// rules were written on 10-03 and 10-05, and its daily 09:00 runs read all three: 18, 17 and 17 runs (the placements the
// counter would hold had it existed, counted from the run journals).
const RESEARCH_USER = ['2026-09-25T18:34', '2026-09-26T05:40', '2026-09-26T09:19', '2026-09-27T09:16', '2026-09-28T11:17', '2026-10-01T00:49', '2026-10-01T02:50', '2026-10-01T02:56', '2026-10-02T02:22', '2026-10-02T16:44', '2026-10-02T21:39', '2026-10-02T22:33', '2026-10-03T01:29'].map(text => `${text}:00Z`);
const RESEARCH = [['安全报告筛选', '2026-10-03T01:29:57.813Z', 18], ['盈利分析可执行性', '2026-10-05T23:50:59.796Z', 17], ['标记同步索引', '2026-10-05T23:51:14.739Z', 17]];
// The novel project: its user wrote 72 times on 09-29..10-03, then once on 10-09 (after a 5.8-day gap, the longest) and is away since; ten
// trial rules were written 09-30..10-06 (before the turn block carried them, 0.69.0 on 10-05) and background runs read them once or never.
const NOVEL_USER = ['2026-09-29T10:37', '2026-09-29T19:34', '2026-09-30T02:23', '2026-09-30T04:47', '2026-09-30T20:00', '2026-10-01T00:15', '2026-10-01T19:33', '2026-10-02T02:51', '2026-10-02T18:17', '2026-10-03T19:31', '2026-10-09T14:08'].map(text => `${text}:00Z`);
const NOVEL = ['先查原著风格', '情绪起伏与口语化', '去修辞赘句', '数字改写看语境', '角色标签鲜明化', '吸引点周期再现', '节拍结构逐段仿', '简介先调研爆款', '呼应须有伏笔', '逐章对齐续写'];

test('live replay, research project: with the counter the run journals imply, the three trial rules are all stranded (17-18 unjudged, a wait of 17-19 days against a bar of 5.1) and the first asked is the one most placed; with today\'s stored counts (none) nothing is', () => {
  const sessions = [session(RESEARCH_USER)];
  const withCounter = project(RESEARCH.map(([key, createdAt, runs]) => gene(key, { createdAt, stats: placed(runs, { injectedRuns: runs }) })));
  const { rows, ask } = trialEvidence(withCounter, sessions, { now: NOW });
  assert.equal(ask.gene.key, '安全报告筛选');
  assert.deepEqual(rows.map(row => [row.gene.key, row.ask, row.unjudged]), [['安全报告筛选', true, 18], ['盈利分析可执行性', true, 17], ['标记同步索引', true, 17]]);
  assert.ok(Math.abs(ask.longest / DAY - 2.56) < 0.01); assert.ok(ask.waited > 19 * DAY && ask.waited < 20 * DAY, 'the oldest rule has waited since the user\'s last message');
  assert.ok(rows.every(row => row.waited > 16 * DAY && row.waited > AWAY_FACTOR * row.longest));
  const stored = project(RESEARCH.map(([key, createdAt]) => gene(key, { createdAt })));
  assert.deepEqual(trialEvidence(stored, sessions, { now: NOW }).rows.map(row => row.why), ['too_few_placements', 'too_few_placements', 'too_few_placements'], 'nothing counted these loads, which is the bug');
});

test('live replay, novel project: its ten trial rules are dormant (the user is away, but nothing runs them), not stranded; read three times each they would be', () => {
  const sessions = [session(NOVEL_USER)];
  const stored = project(NOVEL.map((key, index) => gene(key, { createdAt: new Date(ms('2026-09-30T18:27') + index * 6 * HOUR).toISOString(), stats: index === 3 ? { clean: 0, missed: 0, real: 0, falseMatches: 0, injected: 0, recalled: 1, viaLesson: 1, applied: 1 } : null })));
  const dormant = trialEvidence(stored, sessions, { now: NOW });
  assert.equal(dormant.ask, null); assert.deepEqual(new Set(dormant.rows.map(row => row.why)), new Set(['too_few_placements']));
  const read = project(stored.genes.genes.map(row => ({ ...row, stats: placed(TRIAL_USES, { injectedRuns: TRIAL_USES }) })));
  const asked = trialEvidence(read, sessions, { now: NOW });
  assert.equal(asked.rows.filter(row => row.ask).length, 10, 'once the placements are there the absence (13 days against a bar of 11.6) says the same');
  assert.ok(Math.abs(asked.ask.longest / DAY - 5.78) < 0.01);
  // The same placements 11 days after the last message: they are away, but not yet longer than twice their longest absence.
  assert.equal(trialEvidence(read, sessions, { now: ms('2026-10-20T14:08') }).ask, null);
});
