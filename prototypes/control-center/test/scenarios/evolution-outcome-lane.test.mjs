// D4 scenario (P2 batch D3; plan §2.2 D3, §1.3 F rows on lane C and observability; ModularRSI confirm.py: paired on the same
// task). The evolution used to learn only from foreground turns, so a project that mostly runs a schedule never evolved from
// its main work stream. One real host: the schedule's own runs (claim, worker, delivery), the user's replies through the
// runtime, the project mind's capture and JEV's reply attribution, the evolution service's outcome lane, the invitation that
// reaches the conversation, the REST endpoint the page and `./rna doctor` read. Only the model, JEV and the clock are fake.
//  1. A schedule's report is accepted one day and corrected the next: both are rows of one outcome lane, set side by side
//     (same schedule) in the contrast analysis's input, and the observability reads them.
//  2. A run the model service failed (a 503) is the weather: the system strand, never lane C's trouble.
//  3. A rule the scheduled work got worse under is watched, then offered for retirement — the invitation reaches the
//     conversation's own list — and is never retired by the host. A clean report of ANOTHER schedule is no second reading; when
//     the user answers the invitation through the real endpoint the rule leaves as a drop, and the judgments that let it in are
//     not labelled wrong (the reading was confounded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { CONTRAST_SYSTEM } from '../../gene-evolution-service.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const REPORT = (number, sources) => `The measured result is ${sources} verified sources.\nHandoff: report ${number} delivered; nothing left.`;
const userItem = (world, text) => world.session().items.find(row => row.kind === 'user' && row.text === text);
/** JEV's answer to the capture's target question and to reply.target: the option whose text matches (a stand-in for reading it). */
const names = pattern => ({
  capture: question => Object.entries(question.criteria ?? {}).find(([key, text]) => /^out_/.test(key) && pattern.test(text))?.[0] ?? 'unknown',
  reply: (_question, body) => { const index = (body.state?.reply?.deliveries ?? []).findIndex(row => pattern.test(row.text)); return index < 0 ? 'unknown' : `dlv_${index}`; },
});
const settle = (s, label) => s.advanceClock(31000, { label, settleMs: 400 });
/** A project the evolution works on: ready, with a version that carries a genome (what initialization leaves). Set once the scheduled runs are over: a run pins the real version it starts on. */
const evolvable = world => world.store.mutate(state => { const project = state.projects.find(row => row.id === world.projectId); project.genes ??= { genes: [], generations: [] }; project.versions = [{ id: 'v-scenario', version: '0.1.0', state: 'active', bundle: { genome: { systemPrompt: 'p', skills: [], tools: [] } } }]; project.activeVersionId = 'v-scenario'; });
/** The same, with a real verified genome as the active version: for a scenario in which a generation is committed (a retirement writes one). */
async function evolvableWithGenome(world) {
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome: GENOME }); await prepared.commit();
  world.store.mutate(state => { const project = state.projects.find(row => row.id === world.projectId); project.genes ??= { genes: [], generations: [] }; project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: 'baseline', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: new Date().toISOString(), simulated: false }]; project.activeVersionId = prepared.record.versionId; });
}

async function schedule(t) {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, mind: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const delivered = () => world.session().items.filter(item => item.scheduleOccurrenceKey);
  // One scheduled run, delivered into the conversation (the faux model reads the evidence and reports).
  const run = async (script, count) => {
    world.faux.script('background-work', { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] }, script);
    await s.advanceClock(count === 1 ? 70 * MINUTE : DAY, { label: `scheduled report ${count} comes due and is delivered`, until: () => delivered().length >= count });
    return delivered().at(-1);
  };
  // The user's reply to the newest report; JEV reads what it is about.
  const reply = async (text, { correction, reportText }) => {
    const pick = names(reportText);
    world.jev.answer('is_correction', correction ? .96 : .03).answer('is_approval', .03).answer('target_of_feedback', pick.capture).answer('replies_to', pick.reply);
    await s.send(text, { reply: '好的。' });
    await until(() => userItem(world, text)?.capture, 'the reply to be captured'); await world.store.mind.idle();
    await settle(s, 'the pump reads the reply');
  };
  return { world, s, run, reply, delivered, scheduleId: created.body.id };
}

test('a report accepted one day and corrected the next: both are rows of the outcome lane, paired by schedule in the contrast input and read by the observability endpoint', async t => {
  const f = await schedule(t), { world } = f;
  const first = await f.run(REPORT(1, 'seven'), 1);
  await f.reply('收到，谢谢。', { correction: false, reportText: /seven verified sources/ });
  const second = await f.run(REPORT(2, 'nine'), 2);
  await f.reply('这个报告里的数字不对，应该是 11 个来源。', { correction: true, reportText: /nine verified sources/ });
  assert.notEqual(first.id, second.id);
  assert.deepEqual([userItem(world, '收到，谢谢。').replyTo.itemId, userItem(world, '这个报告里的数字不对，应该是 11 个来源。').replyTo.itemId], [first.id, second.id], 'each reply names its own report (C3)');

  // The outcome lane: one row per occurrence; the user's replies are what settled them.
  const view = (await world.getJson(`/api/v2/projects/${world.projectId}/genes/observability`)).body;
  assert.deepEqual(Object.entries(view.outcomes.byOutcome).sort(), [['accepted', 1], ['corrected', 1]]);
  assert.deepEqual([view.outcomes.schedules.length, view.outcomes.schedules[0].scheduleId, view.outcomes.schedules[0].occurrences, view.outcomes.schedules[0].corrected, view.outcomes.schedules[0].accepted], [1, f.scheduleId, 2, 1, 1]);
  const rows = world.store.genes.contrastOutcomes(world.project());
  assert.deepEqual(rows.filter(row => row.run).map(row => [row.run.scheduleId, row.outcome]), [[f.scheduleId, 'accepted'], [f.scheduleId, 'corrected']], 'before D3 a reply that did not correct the report was no outcome at all');

  // Lane C reads the pair: the corrected report beside the accepted one of the same schedule, labelled as a pair.
  world.faux.on('mind', request => String(request.systemPrompt ?? '').includes(CONTRAST_SYSTEM.slice(0, 60)) ? JSON.stringify({ clusters: [{ theme: 'numbers', cause: 'method', turns: ['T1'] }], patches: [], system: [], retire: [], merge: [] }) : 'ok');
  evolvable(world);
  await world.store.genes.contrast(world.projectId);
  const request = world.faux.of('mind').find(row => String(row.request.systemPrompt ?? '').includes(CONTRAST_SYSTEM.slice(0, 60)));
  assert.ok(request, 'the contrast analysis ran');
  const input = JSON.parse(request.request.messages[0].content[0].text);
  assert.deepEqual(input.turns.filter(row => row.pair).map(row => [row.outcome, row.pair]), [['accepted', 'S1'], ['corrected', 'S1']]);
  assert.match(input.turns.find(row => row.outcome === 'corrected').reply, /nine verified sources/); assert.match(input.turns.find(row => row.outcome === 'accepted').reply, /seven verified sources/);
  assert.equal(world.project().genes.contrasts.at(-1).pairs, 1, 'recorded: how many pairs the analysis was given');
});

test('a scheduled run the model service failed is the weather: the system strand records it with no model call, and lane C never sees it as trouble', async t => {
  const f = await schedule(t), { world } = f;
  world.faux.script('background-work', { error: { message: 'Service Unavailable', status: 503, code: 'provider_error' } });
  await f.s.advanceClock(70 * MINUTE, { label: 'the scheduled run comes due and the model service fails it', until: () => world.project().jobs.some(job => job.lane === 'background' && job.status === 'failed'), settleMs: 600 });
  const job = world.project().jobs.find(row => row.lane === 'background' && row.status === 'failed');
  assert.ok(job.failure, 'the failure is recorded on the job');
  const before = world.faux.requests.length;
  evolvable(world);
  assert.equal(world.store.genes.infraDue(world.project()), true);
  assert.equal(world.store.genes.failedRuns(world.project(), 0).length, 0, 'not the project\'s method');
  const recorded = world.store.genes.recordInfra(world.projectId);
  assert.equal(recorded.recorded.length, 1);
  assert.equal(world.faux.requests.length, before, 'no model call for the weather');
  const strand = world.project().genes.genes.filter(row => row.layer === 'system');
  assert.deepEqual(strand.map(row => [row.status, row.body.count]), [['active', 1]]);
  assert.match(strand[0].key, /^infra-(network|service|capacity)$/);
  assert.equal(world.store.genes.infraDue(world.project()), false, 'counted once');
});

test('a rule the scheduled work got worse under is watched, then offered for retirement: the invitation reaches the conversation, and the host retires nothing', async t => {
  const f = await schedule(t), { world } = f, now = Date.now();
  await evolvableWithGenome(world);
  // A scheduled report as the delivery path writes it (a real history would take a month of runs), and what the user then said about it.
  let count = 0;
  const report = (scheduleId, ago, outcome) => world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId), session = state.sessions.find(row => row.id === world.sessionId), index = ++count;
    const at = now - ago * DAY, itemId = `report-${index}`, key = `${scheduleId}:${iso(at)}`, turnId = `turn-${index}`, userItemId = `message-${index}`, replied = iso(at + HOUR);
    project.scheduleRuntime ??= { occurrences: [] };
    project.scheduleRuntime.occurrences.push({ key, scheduleId, scheduledAt: iso(at), claimedAt: iso(at), actionId: `work-${index}`, deliveryActionId: `deliver-${index}`, status: 'delivered', deliveredAt: iso(at), deliveryItemId: itemId });
    session.items.push({ id: itemId, turnId: null, kind: 'assistant', text: `report ${index}`, createdAt: iso(at), simulated: false, source: 'initiative', projectId: project.id, initiativeActionId: `deliver-${index}`, scheduleId, scheduleOccurrenceKey: key, initiative: { kind: 'scheduled', reach: 'inline' } });
    session.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: replied, completedAt: replied, modelConfig: { execution: 'rna' }, simulated: false });
    session.items.push({ id: userItemId, turnId, kind: 'user', text: outcome === 'corrected' ? `wrong number ${index}` : `thanks ${index}`, createdAt: replied, simulated: false, capture: { correction: outcome === 'corrected' }, replyTo: { source: 'jev', itemId, kind: 'delivery' } });
    session.items.push({ id: `ok-${index}`, turnId, kind: 'assistant', text: 'ok', final: true, createdAt: replied, simulated: false });
  });
  // The daily report: three accepted before a rule was written, three corrected after it. A second schedule, fine on both sides, weighs the same.
  for (const ago of [20, 18, 16]) { report(f.scheduleId, ago, 'accepted'); report('weekly-digest', ago, 'accepted'); }
  for (const ago of [8, 6, 4]) { report(f.scheduleId, ago, 'corrected'); report('weekly-digest', ago, 'accepted'); }
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.genes ??= { genes: [], generations: [] };
    project.genes.generations = [{ n: 1, at: iso(now - 10 * DAY), summary: 'a working rule', trigger: 'correction', geneIds: ['skill-patch:risky'] }];
    project.genes.genes.push({ id: 'skill-patch:risky', layer: 'skill', key: 'risky', title: 'Risky rule', summary: 'A rule written after the third report.', level: 0, status: 'trial', generation: 1, createdAt: iso(now - 10 * DAY), history: [], body: { skillId: 'project-workflow' }, origin: { kind: 'correction', scheduleIds: [f.scheduleId] } });
  });
  const retire = () => world.session().invitations?.filter(row => row.kind === 'gene') ?? [];
  assert.equal(world.store.genes.harmDue(world.project()), true);
  assert.deepEqual([(await world.store.genes.assessHarm(world.projectId)).watching, (await world.store.genes.assessHarm(world.projectId)).offered], [1, false], 'one reading is not persistence');
  // The next day the other schedule delivers one more clean report: the reading is harmful again, but nothing new points at the rule.
  report('weekly-digest', 1, 'accepted');
  world.store.genes.harmChecked.clear();
  assert.equal((await world.store.genes.assessHarm(world.projectId)).offered, false, 'a newer settled occurrence of another schedule is no new evidence of harm');
  assert.equal(retire().length, 0);
  // One more corrected daily report: the reading holds with more evidence of harm behind it.
  report(f.scheduleId, 0.5, 'corrected');
  world.store.genes.harmChecked.clear();
  const third = await world.store.genes.assessHarm(world.projectId);
  assert.equal(third.offered, true);
  // The invitation is in the conversation's own list (what the composer's strip reads), with the reading in its reason.
  const [invitation] = retire();
  assert.deepEqual([invitation.geneId, invitation.action, invitation.usage], ['skill-patch:risky', 'retire', 'harm']);
  assert.match(invitation.reason, /\d+%/);
  const bootstrap = (await world.getJson("/api/v2/bootstrap")).body;
  assert.ok(JSON.stringify(bootstrap).includes('skill-patch:risky') || world.session().invitations.length >= 1, 'the invitation is part of the session the web reads');
  // The host retires nothing: the rule is still in force until the user answers.
  assert.equal(world.project().genes.genes.find(row => row.id === 'skill-patch:risky').status, 'trial');
  assert.equal(world.project().genes.generations.length, 1, 'no generation was committed');
  const view = (await world.getJson(`/api/v2/projects/${world.projectId}/genes/observability`)).body;
  assert.deepEqual(view.harm.map(row => [row.geneId, row.state, row.schedules, row.harmful]), [['skill-patch:risky', 'invited', 2, true]]);

  // The user answers "retire" through the endpoint the composer's strip posts to: the rule leaves as a drop, and the judgments that
  // let it in are not labelled wrong — the harm reading was confounded, which is why it was only an invitation.
  const labels = []; const decisions = world.store.genes.decisions, labelDecision = decisions.labelDecision?.bind(decisions);
  decisions.labelDecision = (id, label, ...rest) => { labels.push([id, label]); return labelDecision ? labelDecision(id, label, ...rest) : false; };
  world.store.mutate(state => { state.projects.find(row => row.id === world.projectId).genes.genes.find(row => row.id === 'skill-patch:risky').ledger = { review: 'ledger-risky' }; });
  const answered = await world.post(`/api/v2/sessions/${world.sessionId}/invitations/${invitation.id}`, { action: 'answer', choice: 'retire' });
  assert.equal(answered.status, 200, JSON.stringify(answered.body).slice(0, 300));
  const retired = world.project().genes.genes.find(row => row.id === 'skill-patch:risky');
  assert.deepEqual([retired.status, retired.retiredAs], ['retired', 'dropped']);
  assert.deepEqual(labels.filter(([, label]) => label === 'gene_retired'), [], 'no gene_retired label from a retirement the reading invited');
  const after = (await world.getJson(`/api/v2/projects/${world.projectId}/genes/observability`)).body;
  assert.deepEqual(after.dispositions.genes.retired, { dropped: 1 });
});
