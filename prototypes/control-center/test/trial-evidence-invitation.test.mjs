import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, setup } from './helpers/gene-fixture.mjs';
import { INVITATION_KINDS, expireFeedbackInvitations } from '../session-invitations.mjs';
import { ToolPolicy } from '../tool-policy.mjs';
import { TRIAL_USES } from '../project-genes.mjs';
import { genomeSkillId, genomeIdentity } from '../project-genome-store.mjs';
import { formatSkillContent } from '../../../packages/sdk/src/genome-skill-content.mjs';

// A trial working rule becomes active only on the user's own feedback. A rule read by background runs while the user is away
// gets none, and sat on trial for ever (live: 3 + 10 rules, 15-22 days). Step 1: a background run that loads the skill a rule
// is written into counts as putting it in front of its model (`stats.injected`, never a promotion). Step 2: when the user is
// back (visible presence), a rule placed again and again with nothing to judge it by, after an absence longer than twice their
// longest, is asked about once; only their answer retires it, and a refusal raises the bar.
const HOUR = 3600000, DAY = 24 * HOUR, iso = ms => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-22T14:30:00Z');
// The user wrote until 10-03 (never away more than 2.56 days): shaped like the live research project's.
const USER = ['2026-09-25T18:34', '2026-09-26T05:40', '2026-09-26T09:19', '2026-09-27T09:16', '2026-09-28T11:17', '2026-10-01T00:49', '2026-10-01T02:50', '2026-10-02T02:22', '2026-10-02T21:39', '2026-10-03T01:29'].map(text => Date.parse(`${text}:00Z`));
const act = (f, card, body) => fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${card.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cards = f => f.app.store.state.sessions.flatMap(row => row.invitations ?? []).filter(row => row.kind === 'gene' && row.usage === 'no_evidence');
const project = f => f.app.store.state.projects.find(row => row.id === f.project.id);
const gene = (f, key) => project(f).genes.genes.find(row => row.id === `skill-patch:${key}`);
const placed = (injected, more = {}) => ({ clean: 0, missed: 0, real: 0, falseMatches: 0, injected, injectedRuns: injected, ...more });

/** A project whose user last wrote on 10-03, with trial working rules (key → unjudged placements) written on 10-03. */
async function world(t, rules = { alpha: 17, beta: 12 }) {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  f.app.store.mutate(state => {
    const target = state.projects.find(row => row.id === f.project.id), session = state.sessions.find(row => row.id === f.session.id);
    session.items.push(...USER.map((at, index) => ({ id: `user-${index}`, kind: 'user', text: '…', createdAt: iso(at) })));
    target.genes = { generations: [], genes: Object.entries(rules).map(([key, runs]) => ({ id: `skill-patch:${key}`, layer: 'skill', key, title: `规则${key}`, summary: `规则${key}`, level: 0, status: 'trial', origin: { kind: 'correction', quote: key },
      body: { skillId: 'project-workflow', when: 'writing a chapter', note: `\n\n## 规则${key}\n- do ${key}.` }, stats: runs ? placed(runs) : null, createdAt: '2026-10-03T01:29:57.813Z', history: [] })) };
  });
  const clock = { now: NOW };
  f.app.store.invitations.now = () => clock.now; f.app.genes.now = () => clock.now;
  return { ...f, clock, inv: f.app.store.invitations };
}

test('step 1: a background run that reads the skill a rule is written into counts it as put in front of its model, once per run, and never promotes it', async t => {
  const f = await world(t, { alpha: 0, beta: 0 });
  // The rule's note is in the skill the run loads (the real page of a SKILL.md, as skill_load returns it).
  const note = '\n\n## 规则alpha\n- do alpha.';
  const skillId = genomeSkillId(genomeIdentity(f.project.id), 'project-workflow');
  const page = (content, extra = {}) => ({ content: [{ type: 'text', text: JSON.stringify({ ...formatSkillContent({ id: skillId, path: 'SKILL.md', raw: content, ...extra }), baseDir: '/skills' }) }] });
  const holds = page(`# 项目工作流\n\n1. 读设定集。${note}`), cut = page('# 项目工作流\n\n1. 读设定集。');
  const policy = new ToolPolicy({ genes: f.app.genes }), load = { name: 'skill_load' };
  const run = (keys = { actionId: 'run-1' }) => policy.forRun({ projectId: f.project.id, getProject: () => project(f), root: f.workspace, purpose: 'background-work', ...keys });
  const stats = key => gene(f, key).stats;

  await run().after({ tool: load, args: { id: skillId }, result: holds, isError: false });
  assert.deepEqual([stats('alpha').injected, stats('alpha').injectedRuns], [1, 1]);
  assert.equal(stats('beta'), null, 'a rule whose section the page does not hold was not read (its note is not in this version)');
  // The same run reads it again (a second page, a reload after compaction): still one placement.
  await run().after({ tool: load, args: { id: skillId, offset: 0 }, result: holds, isError: false });
  assert.equal(stats('alpha').injected, 1);
  // Another run counts. A page cut before the section, a failed load, material other than SKILL.md and another skill's page do not.
  await run({ actionId: 'run-2' }).after({ tool: load, args: { id: skillId }, result: holds, isError: false });
  assert.equal(stats('alpha').injected, 2);
  await run({ actionId: 'run-3' }).after({ tool: load, args: { id: skillId }, result: cut, isError: false });
  await run({ actionId: 'run-3' }).after({ tool: load, args: { id: skillId }, result: holds, isError: true });
  await run({ actionId: 'run-3' }).after({ tool: load, args: { id: skillId, path: 'notes.md' }, result: page(`notes ${note}`, { path: 'notes.md' }), isError: false });
  await run({ actionId: 'run-3' }).after({ tool: load, args: { id: 'gen-0000000000000000-other-skill' }, result: { content: [{ type: 'text', text: JSON.stringify({ id: 'gen-0000000000000000-other-skill', path: 'SKILL.md', content: note }) }] }, isError: false });
  await run({ actionId: 'run-3' }).after({ tool: { name: 'project_read' }, args: { path: 'a.md' }, result: holds, isError: false });
  assert.equal(stats('alpha').injected, 2);
  // A foreground turn has its own accounting (the turn block): its skill loads are not counted here.
  await run({ turnId: 'turn-1' }).after({ tool: load, args: { id: skillId }, result: holds, isError: false });
  await run({ parentTurnId: 'turn-1' }).after({ tool: load, args: { id: skillId }, result: holds, isError: false });
  assert.equal(stats('alpha').injected, 2);
  // Counting is not proof: the rule is still on trial, never "followed", at level 0.
  const row = gene(f, 'alpha');
  assert.deepEqual([row.status, row.level, stats('alpha').applied ?? 0, stats('alpha').recalled ?? 0, stats('alpha').clean], ['trial', 0, 0, 0, 0]);
  // A rule that left (retired) or an unrelated record is left alone.
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).genes.genes.find(item => item.id === 'skill-patch:alpha').status = 'retired'; });
  await run({ actionId: 'run-9' }).after({ tool: load, args: { id: skillId }, result: holds, isError: false });
  assert.equal(stats('alpha').injected, 2);
});

test('step 1: an older id of the same skill still names it (the id once carried the version), a different skill sharing a word with its name does not', async t => {
  const f = await world(t, { alpha: 0 });
  const note = '\n\n## 规则alpha\n- do alpha.';
  const read = (id, actionId) => f.app.genes.noteSkillLoad(f.project.id, { skillId: id, actionId, path: 'SKILL.md', content: `# x${note}` });
  assert.deepEqual(read('gen-73b539a18afb69b3-project-workflow', 'a'), ['skill-patch:alpha']);
  assert.deepEqual(read('project-workflow', 'b'), ['skill-patch:alpha']);
  assert.deepEqual(read('gen-73b539a18afb69b3-old-project-workflow', 'c'), [], 'only the skill itself, not one whose name ends the same way');
  assert.deepEqual(read('gen-73b539a18afb69b3-project-workflow', 'a'), [], 'the same run');
  assert.equal(gene(f, 'alpha').stats.injected, 2);
  assert.deepEqual(gene(f, 'alpha').placedIn, ['a', 'b']);
});

test('step 2: back after a long absence, a rule placed three or more times with nothing to judge it by is asked about once, one at a time, above the composer', async t => {
  const f = await world(t);
  assert.ok(INVITATION_KINDS.includes('gene'));
  const result = await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card, ...others] = cards(f);
  assert.equal(others.length, 0, 'one at a time');
  assert.deepEqual([card.geneId, card.action, card.title, card.runs, card.projectId], ['skill-patch:alpha', 'retire', '规则alpha', 17, f.project.id], 'the rule with the most placements first');
  assert.equal(card.subject, 'retire:skill-patch:alpha:evidence1');
  assert.match(card.reason, /^放进过 17 次，没有一次能判断有没有照做；你已经 20 天没来了。$/, 'the host\'s reason reads in the interface language');
  assert.equal(result.trial.id, card.id);
  assert.deepEqual(gene(f, 'alpha').evidenceAsk, { n: 1, at: iso(NOW), unjudged: 17, outcome: 'asked' });
  // Presence arrives every few seconds: the open card is not repeated, and the other rule waits for the answer.
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); await f.inv.onPresence(f.project.id);
  assert.equal(cards(f).length, 1);
  assert.equal(gene(f, 'alpha').status, 'trial', 'nothing is retired by asking');
  assert.equal(gene(f, 'alpha').keep, undefined); assert.equal(gene(f, 'alpha').retireOffered, undefined, 'the sticky "asked" marks of the other cards are not set: this one is asked again as evidence grows');
  assert.equal(project(f).genes.funnel.A.trial_no_evidence_offered, 1);
  // The card was left open and lapsed (not shown, then removed): that rule needs TRIAL_USES more placements before it is asked again, so the other one is next. In English: the same facts.
  f.app.store.interfaceLanguage('en');
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).invitations = []; });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].geneId, 'skill-patch:beta');
  assert.match(cards(f)[0].reason, /^Put in front of the model 12 times, never once in a way that could be judged; you have been away for 20 days\.$/);
});

test('step 2: nothing is asked while the user is around, before they have been away longer than twice their longest absence, or while placements are few', async t => {
  const f = await world(t);
  // Four days after their last message is more than their longest absence (2.56 days) but not twice as long (5.1).
  f.clock.now = Date.parse('2026-10-07T01:29:00Z');
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  f.clock.now = Date.parse('2026-10-08T12:00:00Z');
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 1, 'five and a half days: the proof is not coming soon');
  // They write: the card lapses (a decision they went past) and, being around, nothing more is asked.
  assert.equal((await act(f, cards(f)[0], { action: 'shown' })).status, 200);
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.items.push({ id: 'back', kind: 'user', text: '继续', createdAt: iso(f.clock.now + HOUR) }); expireFeedbackInvitations(session, { now: f.clock.now + HOUR }); });
  f.clock.now += 2 * HOUR;
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  // Few placements, however long the absence: a rule nobody runs is dormant, not stranded.
  const quiet = await world(t, { gamma: 2, delta: 0 });
  await quiet.inv.onPresence(quiet.project.id, { sessionId: quiet.session.id }); assert.equal(cards(quiet).length, 0);
  // Not enough of a history to say what a long absence is for them.
  const fresh = await world(t); fresh.app.store.mutate(state => { const session = state.sessions.find(row => row.id === fresh.session.id); session.items = session.items.slice(-1); });
  await fresh.inv.onPresence(fresh.project.id, { sessionId: fresh.session.id }); assert.equal(cards(fresh).length, 0);
});

test('step 2: "keep" is a refusal, not "never ask again": the next ask needs twice the placements they refused, and the wait counts from the answer', async t => {
  const f = await world(t, { alpha: 17, beta: 17 });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card] = cards(f);
  assert.equal((await act(f, card, { action: 'answer', choice: 'rewrite' })).status, 400, 'retire or keep');
  assert.equal((await act(f, card, { action: 'answer', choice: 'keep' })).status, 200);
  assert.equal(cards(f).length, 0);
  assert.equal(gene(f, 'alpha').keep, undefined, 'not the sticky keep of the other cards');
  assert.deepEqual([gene(f, 'alpha').evidenceAsk.outcome, project(f).genes.evidenceAsks.refused, project(f).genes.evidenceAsks.answeredAt], ['kept', 17, iso(NOW)]);
  assert.equal(gene(f, 'alpha').status, 'trial');
  // They were just here: nothing more now, and the other rule (also 17, below twice the refusal) is not asked either.
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  f.clock.now += 6 * DAY;
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0, 'away again, but 17 placements are what they said they put up with');
  // More runs: 33 is still below 34; 34 is twice what they refused.
  f.app.store.mutate(state => { for (const row of state.projects.find(item => item.id === f.project.id).genes.genes) { row.stats.injected = 33; row.stats.injectedRuns = 33; } });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  f.app.store.mutate(state => { for (const row of state.projects.find(item => item.id === f.project.id).genes.genes) { row.stats.injected = 34; row.stats.injectedRuns = 34; } });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].runs, 34);
  assert.equal(cards(f)[0].subject, 'retire:skill-patch:alpha:evidence2', 'a new subject: the first one was asked once and is in the history');
  // Closing the card (×) is a refusal too, the size they saw; it raises the project's bar again.
  assert.equal((await act(f, cards(f)[0], { action: 'dismiss' })).status, 200);
  assert.deepEqual([project(f).genes.evidenceAsks.refused, gene(f, 'alpha').evidenceAsk.outcome], [34, 'dismissed']);
});

test('step 2: a card the user went past by writing is not a refusal; the same rule is asked again after TRIAL_USES more placements and a new absence', async t => {
  const f = await world(t, { alpha: 10 });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  const [card] = cards(f);
  assert.equal((await act(f, card, { action: 'shown' })).status, 200);
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.items.push({ id: 'w', kind: 'user', text: '继续', createdAt: iso(NOW + HOUR) }); expireFeedbackInvitations(session, { now: NOW + HOUR }); });
  assert.equal(cards(f).length, 0); assert.equal(project(f).genes.evidenceAsks, undefined, 'a lapse leaves no refusal'); assert.equal(gene(f, 'alpha').evidenceAsk.outcome, 'asked');
  // They wrote, so they are around, and they came back from 19.6 days away: that is now their longest absence, so the next one
  // must be more than twice as long (39 days) before the proof is called not coming.
  f.clock.now = NOW + 20 * DAY;
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).genes.genes[0]; row.stats.injected = 10 + TRIAL_USES; row.stats.injectedRuns = 10 + TRIAL_USES; });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0, 'they were away 20 days, which is less than twice the 19.6 days they have already come back from');
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).genes.genes[0]; row.stats.injected = 10; row.stats.injectedRuns = 10; });
  f.clock.now = NOW + 45 * DAY;
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0, 'away long enough, but no new placements since they were asked at 10');
  f.app.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id).genes.genes[0]; row.stats.injected = 10 + TRIAL_USES; row.stats.injectedRuns = 10 + TRIAL_USES; });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1); assert.equal(cards(f)[0].runs, 13); assert.equal(cards(f)[0].subject, 'retire:skill-patch:alpha:evidence2');
});

test('step 2: "retire" retires the rule and labels no judgment (nothing was found wrong with it); the wait counts from the answer', async t => {
  const f = await world(t, { alpha: 17 });
  const retired = [], labelled = []; f.app.genes.labelGene = (...args) => labelled.push(args);
  f.app.genes.genes.retireGene = async (projectId, geneId, options) => { retired.push([geneId, options.as]); f.app.genes.genes.record(projectId, geneId, row => { row.status = 'retired'; }); return { versionId: null, generation: null, restored: [] }; };
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal((await act(f, cards(f)[0], { action: 'answer', choice: 'retire' })).status, 200);
  assert.deepEqual(retired, [['skill-patch:alpha', 'dropped']]);
  assert.deepEqual(labelled, [], 'a yes to "no way to proof" is not a verdict on the judgments that admitted it');
  assert.equal(gene(f, 'alpha').status, 'retired'); assert.equal(cards(f).length, 0);
  assert.equal(project(f).genes.evidenceAsks.refused, undefined, 'retiring is no refusal');
  assert.equal(project(f).genes.evidenceAsks.answeredAt, iso(NOW));
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).invitationHistory.at(-1).outcome, 'answered');
});

test('step 2: a card whose rule left the trial is closed, not answered into a rule that is gone; closing never retires anything', async t => {
  const f = await world(t, { alpha: 17 });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 1);
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).genes.genes[0].status = 'active'; });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id });
  assert.equal(cards(f).length, 0);
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).invitationHistory.at(-1).outcome, 'expired');
  assert.equal(gene(f, 'alpha').status, 'active');
});

test('step 2: only a visible presence asks; the route that reports it is the one that brings the question', async t => {
  const f = await world(t, { alpha: 17 });
  const report = visible => fetch(f.url(`/api/projects/${f.project.id}/presence`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: f.session.id, visible, typing: false }) });
  assert.equal((await report(false)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(cards(f).length, 0, 'a hidden window is nobody\'s attention');
  assert.equal((await report(true)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(cards(f).length, 1);
  assert.equal(cards(f)[0].geneId, 'skill-patch:alpha');
});

test('step 2: a project whose evolution is switched off, or an archived one, is not asked', async t => {
  const f = await world(t, { alpha: 17 });
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).evolution = { enabled: false }; });
  await f.inv.onPresence(f.project.id, { sessionId: f.session.id }); assert.equal(cards(f).length, 0);
  assert.equal(f.app.genes.offerStalledTrial('no-such-project', { sessionId: f.session.id }), null);
});
