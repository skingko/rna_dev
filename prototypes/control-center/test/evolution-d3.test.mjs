import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stream, setup, GUARD_ANSWER, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry, patchMindEntry } from '../project-mind.mjs';
import { CONTRAST_SYSTEM, PATCH_AUTHOR_SYSTEM, GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';
import { guardsOf, geneTree } from '../project-genes.mjs';

// P2 batch D, D3 (plan §2.2 D3): the evolution's background outcome lane and its observability — occurrences of the same
// schedule are paired for lane C; harm detection invites a retirement and never retires; the bloat rule reads exposure; the
// weather that failed a background run goes to the system strand; typed dispositions; the per-gene exposure, the generation
// outcomes and the scoreboard; the lanes' state for the page and the doctor. Models and judges are stubs.
const DAY = 86400000, HOUR = 3600000;
const REPORT = '每日报告：今天核对了 7 个来源。', TASK = '核对资料来源并写每日报告。';
const PATCH = { skillId: 'project-workflow', title: '先核对伏笔', summary: '写新章前先核对前文伏笔。', section: '- 写新章前，先列出本章要呼应的前文细节。\n- 每个呼应点都要能在前文找到出处。', when: '写新章节', expectation: '不再引用没铺垫过的情节' };
const CONTRAST_ANSWER = { clusters: [{ theme: '数字不对', cause: 'method', turns: ['T0'] }], patches: [], system: [], retire: [], merge: [] };
const contrastRequests = calls => calls.filter(input => (input.messages.find(row => row.role === 'system')?.content ?? '').includes(CONTRAST_SYSTEM.slice(0, 60)));

async function lane(t, { contrast = CONTRAST_ANSWER } = {}) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(CONTRAST_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(contrast));
    stream(res, 'ok');
  });
  f.app.genes.enabled = true;
  f.app.genes.decisions = { geneRoute: async () => ({ guard: false, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes ??= { genes: [], generations: [] }; });
  const base = Date.now();
  let count = 0;
  // A scheduled report delivered into the conversation `daysAgo` days ago, and what the user then said about it.
  const occurrence = ({ daysAgo, outcome = 'unanswered', scheduleId = 's1', status = 'delivered' }) => {
    const key = `${scheduleId}:o${++count}`, at = new Date(base - daysAgo * DAY), itemId = randomUUID(), reply = new Date(base - daysAgo * DAY + HOUR);
    f.app.store.mutate(state => {
      const project = state.projects.find(row => row.id === f.project.id);
      project.schedules ??= []; if (!project.schedules.some(row => row.id === scheduleId)) project.schedules.push({ id: scheduleId, title: '每日报告', task: TASK });
      project.scheduleRuntime ??= { occurrences: [] };
      project.scheduleRuntime.occurrences.push({ key, scheduleId, scheduledAt: at.toISOString(), claimedAt: at.toISOString(), actionId: `work-${count}`, deliveryActionId: `deliver-${count}`, status, deliveredAt: at.toISOString(), deliveryItemId: itemId });
      const session = state.sessions.find(row => row.id === f.session.id);
      session.items.push({ id: itemId, turnId: null, kind: 'assistant', text: `${REPORT} #${count}`, createdAt: at.toISOString(), simulated: false, source: 'initiative', projectId: f.project.id, initiativeActionId: `deliver-${count}`, scheduleId, scheduleOccurrenceKey: key, initiative: { kind: 'scheduled', reach: 'inline' } });
      if (['corrected', 'accepted', 'approved'].includes(outcome)) {
        const turnId = randomUUID(), userItemId = randomUUID();
        session.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: reply.toISOString(), completedAt: reply.toISOString(), modelConfig: { execution: 'rna' }, simulated: false });
        session.items.push({ id: userItemId, turnId, kind: 'user', text: outcome === 'corrected' ? `报告里的数字不对 #${count}` : `好的 #${count}`, createdAt: reply.toISOString(), simulated: false, capture: { correction: outcome === 'corrected', ...(outcome === 'approved' ? { approval: true } : {}) }, replyTo: { source: 'jev', itemId, kind: 'delivery' } });
        session.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: '收到', final: true, createdAt: reply.toISOString(), simulated: false });
      }
    });
    return { key, itemId };
  };
  // A rule written into a skill at generation `n`, committed `daysAgo` days ago (a registry record: nothing here reads its text).
  const rule = ({ id = 'skill-patch:r1', generation = 2, daysAgo = 10, layer = 'skill', ...rest } = {}) => f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id), registry = project.genes;
    registry.generations = [...(registry.generations ?? []).filter(row => row.n !== generation), { n: generation, at: new Date(base - daysAgo * DAY).toISOString(), summary: id, trigger: 'correction', geneIds: [id], promptChars: 1000 }].sort((a, b) => a.n - b.n);
    registry.genes.push({ id, layer, key: id.slice(id.indexOf(':') + 1), title: `规则 ${id}`, summary: 's', level: 0, status: 'trial', generation, createdAt: new Date(base - daysAgo * DAY).toISOString(), history: [], body: { skillId: 'project-workflow', expectation: '数字不再出错' }, ...rest });
  });
  const invitations = () => f.app.store.state.sessions.find(row => row.id === f.session.id).invitations ?? [];
  const gene = id => f.current().genes.genes.find(row => row.id === id);
  // A foreground turn (request, reply) a correction can be about.
  const turn = text => {
    const turnId = randomUUID(), userItemId = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false }); s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: `回复：${text}`, final: true, createdAt: at, simulated: false }); });
    return turnId;
  };
  return { ...f, occurrence, rule, invitations, gene, turn, base };
}

// ------------------------------------------------------------------------------ lane C pairs
test('lane C pairs occurrences of the same schedule: the accepted one is brought in however old, labelled with its partner; a reply that did not correct is a good occurrence now', async t => {
  const f = await lane(t);
  // The last analysis was six days ago: the accepted report (eight days ago) is older than what it has not seen yet.
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.contrast = { at: new Date(f.base - 6 * DAY).toISOString(), turns: 0, trouble: 0, clusters: [], analyzed: true }; });
  f.occurrence({ daysAgo: 8, outcome: 'accepted' }); f.occurrence({ daysAgo: 5, outcome: 'corrected' }); f.occurrence({ daysAgo: 3, outcome: 'unanswered' });
  f.occurrence({ daysAgo: 4, outcome: 'accepted', scheduleId: 's2' });
  const rows = f.app.genes.contrastOutcomes(f.current(), 0).filter(row => row.run);
  assert.deepEqual(rows.map(row => [row.run.scheduleId, row.outcome]), [['s1', 'accepted'], ['s1', 'corrected'], ['s2', 'accepted']], 'a reply to a report that did not correct it is a good one; an unanswered one is nothing; before D3 only a correction or an approval counted');
  await f.app.genes.contrast(f.project.id);
  const [request] = contrastRequests(f.calls), input = JSON.parse(request.messages.find(row => row.role === 'user').content);
  assert.deepEqual(input.turns.map(row => [row.outcome, row.pair ?? null]), [['accepted', 'S1'], ['corrected', 'S1'], ['accepted', null]], 'the corrected report and the accepted one of the same schedule, the older brought in; s2 has no corrected occurrence, so no pair');
  assert.match(input.turns[0].reply, /#1/); assert.match(input.turns[1].correction, /数字不对/);
  assert.match(request.messages.find(row => row.role === 'system').content, /share a "pair" label/);
  assert.equal(f.current().genes.contrasts.at(-1).pairs, 1, 'the analysis records how many pairs it was given');
});

test('lane C keeps its last analyses, not only the latest, with what each found', async t => {
  const f = await lane(t, { contrast: { ...CONTRAST_ANSWER, system: [{ title: '服务不稳', summary: 's', detail: 'd', turns: ['T0'] }] } });
  for (const round of [1, 2, 3]) {
    // Each round: a corrected report newer than the previous analysis.
    f.occurrence({ daysAgo: 29 - 5 * round, outcome: 'corrected' });
    f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes.contrast = { at: new Date(f.base - (30 - 5 * round) * DAY).toISOString(), turns: 0, trouble: 0, clusters: [], analyzed: true }; });
    f.app.genes.contrasted.clear();
    assert.ok(await f.app.genes.contrast(f.project.id));
  }
  const kept = f.current().genes.contrasts;
  assert.equal(kept.length, 3); assert.deepEqual(kept.map(row => row.analyzed), [true, true, true]);
  assert.deepEqual([kept[0].trouble, kept[0].patches, kept[0].system], [1, 0, 1]);
});

// ------------------------------------------------------------------------------------- infra runs
test('a background run the model service or the network failed goes to the system strand without a model call; one a tool failed is trouble for lane C, never the weather', async t => {
  const f = await lane(t);
  const job = (id, failure) => ({ id, projectId: f.project.id, kind: 'research', status: 'failed', lane: 'background', createdAt: new Date(f.base - HOUR).toISOString(), completedAt: new Date(f.base - HOUR).toISOString(), errorCode: failure.code, failure, simulated: false, instruction: '核对资料', scheduleId: 's1' });
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.schedules = [{ id: 's1', title: '每日报告', task: TASK }]; project.jobs = [job('j-weather', { code: 'connection', message: 'ECONNRESET' }), job('j-503', { code: 'x', httpStatus: 503, message: 'busy' }), job('j-tool', { code: 'tool_failed', message: 'the script exited 1' })]; });
  const before = f.calls.length;
  assert.equal(f.app.genes.infraDue(f.current()), true);
  assert.deepEqual(f.app.genes.recordInfra(f.project.id).recorded.sort(), ['network', 'service']);
  assert.equal(f.calls.length, before, 'no model call');
  const strand = f.current().genes.genes.filter(row => row.layer === 'system').map(row => row.key).sort();
  assert.deepEqual(strand, ['infra-network', 'infra-service']);
  assert.equal(f.app.genes.infraDue(f.current()), false, 'counted once');
  const failed = f.app.genes.failedRuns(f.current(), 0);
  assert.deepEqual(failed.map(row => [row.run.actionId, row.outcome, row.run.scheduleId]), [['j-tool', 'failed', 's1']], 'only the tool failure is trouble');
  assert.equal(failed[0].request, TASK); assert.match(failed[0].error, /the script exited 1/);
  // It is trouble like a failed turn: it counts toward the trigger of an analysis, and the weather does not.
  assert.deepEqual(f.app.genes.contrastRows(f.current(), 0).map(row => [row.outcome, row.run?.actionId]), [['failed', 'j-tool']]);
  assert.equal(f.app.genes.evolutionStatus(f.project.id).status.C.trouble, 1);
});

test('the first pass over a project does not report an outage that ended long ago: only recent failed background runs are counted until the strand has a record', async t => {
  const f = await lane(t);
  const job = (id, daysAgo, failure) => ({ id, projectId: f.project.id, kind: 'research', status: 'failed', lane: 'background', createdAt: new Date(f.base - daysAgo * DAY).toISOString(), completedAt: new Date(f.base - daysAgo * DAY).toISOString(), errorCode: failure.code, failure, simulated: false, instruction: '核对资料' });
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).jobs = [job('j-old', 30, { code: 'x', httpStatus: 503, message: 'busy' }), job('j-old-2', 9, { code: 'connection', message: 'ECONNRESET' })]; });
  assert.equal(f.app.genes.infraDue(f.current()), false, 'a month-old and a nine-day-old outage are history');
  assert.equal(f.app.genes.recordInfra(f.project.id), null);
  assert.deepEqual(f.current().genes.genes.filter(row => row.layer === 'system'), []);
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).jobs.push(job('j-new', 2, { code: 'x', httpStatus: 503, message: 'busy' })); });
  assert.equal(f.app.genes.infraFailures(f.current()).length, 1, 'the one from two days ago');
  assert.deepEqual(f.app.genes.recordInfra(f.project.id).recorded, ['service']);
  const [record] = f.current().genes.genes.filter(row => row.layer === 'system');
  assert.match(record.summary, /1 次对话或后台运行因此失败|1 turn\(s\) or background run\(s\) failed/, 'it says what failed: a turn or a background run');
  assert.doesNotMatch(record.summary, /轮对话因此失败/);
});

// -------------------------------------------------------------------------------------- harm
const OLD = [20, 18, 16], AFTER = [8, 6, 4];
test('harm detection: a rule the scheduled work got worse under is watched, then offered for retirement at a second reading with more settled work — and never retired', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:harm', generation: 2, daysAgo: 10 });
  for (const days of OLD) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  f.occurrence({ daysAgo: 8, outcome: 'corrected' }); f.occurrence({ daysAgo: 6, outcome: 'accepted' }); f.occurrence({ daysAgo: 4, outcome: 'corrected' });
  assert.equal(f.app.genes.harmDue(f.current()), true);
  const first = await f.app.genes.assessHarm(f.project.id);
  assert.deepEqual([first.offered, first.watching], [false, 1], 'one noisy reading is not persistence');
  assert.equal(f.invitations().filter(row => row.kind === 'gene').length, 0);
  assert.deepEqual([f.gene('skill-patch:harm').harmWatch.shared, Math.round(f.gene('skill-patch:harm').harmWatch.delta * 100)], [3, 67]);
  // The same evidence again says nothing new: still watching, still no invitation.
  f.app.genes.harmChecked.clear();
  assert.equal((await f.app.genes.assessHarm(f.project.id)).offered, false);
  // One more corrected occurrence after the rule: the reading holds with more settled work behind it.
  f.occurrence({ daysAgo: 2, outcome: 'corrected' });
  f.app.genes.harmChecked.clear();
  const third = await f.app.genes.assessHarm(f.project.id);
  assert.equal(third.offered, true); assert.equal(third.geneId, 'skill-patch:harm');
  const [invitation] = f.invitations().filter(row => row.kind === 'gene');
  assert.deepEqual([invitation.geneId, invitation.action, invitation.usage, invitation.total], ['skill-patch:harm', 'retire', 'harm', 3]);
  assert.match(invitation.reason, /corrected before it and \d+% after|被纠正的占/, 'the numbers are in the invitation, in the interface language');
  const rule = f.gene('skill-patch:harm');
  assert.equal(rule.status, 'trial', 'an invitation, never a retirement'); assert.ok(rule.retireOffered && rule.harmWatch.invitedAt);
  assert.equal(f.current().genes.funnel.C.harm_offered, 1);
  // Offered once: the next pass leaves it alone.
  f.app.genes.harmChecked.clear();
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id) ?? { offered: false }, { watching: 0, offered: false });
});

test('harm detection leaves a rule alone when the work did not get worse, when too few pairs were settled, when the user confirmed it, or when it is not in force', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:fine', generation: 2, daysAgo: 10 });
  for (const days of OLD) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  for (const days of AFTER) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 0, offered: false }, 'no worse after');
  // Two pairs only: below min_shared however bad the second side is.
  const g = await lane(t);
  g.rule({ id: 'skill-patch:few', generation: 2, daysAgo: 10 });
  for (const days of [20, 18, 16, 14]) g.occurrence({ daysAgo: days, outcome: 'accepted' });
  g.occurrence({ daysAgo: 6, outcome: 'corrected' }); g.occurrence({ daysAgo: 4, outcome: 'corrected' });
  assert.equal(g.app.genes.harmDue(g.current()), true);
  assert.equal((await g.app.genes.assessHarm(g.project.id)).watching, 0, 'two matched pairs are not enough');
  assert.equal(g.gene('skill-patch:few').harmWatch, undefined);
  // The user's word stands: a confirmed rule, one they chose to keep, a retired one and one already offered are not candidates.
  const h = await lane(t);
  h.rule({ id: 'skill-patch:confirmed', generation: 2, daysAgo: 10, confirmedAt: new Date().toISOString() });
  h.rule({ id: 'skill-patch:kept', generation: 3, daysAgo: 10, keep: true });
  h.rule({ id: 'skill-patch:retired', generation: 4, daysAgo: 10, status: 'retired' });
  h.rule({ id: 'skill-patch:offered', generation: 5, daysAgo: 10, retireOffered: new Date().toISOString() });
  for (const days of OLD) h.occurrence({ daysAgo: days, outcome: 'accepted' });
  for (const days of AFTER) h.occurrence({ daysAgo: days, outcome: 'corrected' });
  assert.deepEqual(h.app.genes.harmCandidates(h.current()), [], 'the user\'s word and a settled question are not asked again');
  assert.equal(h.app.genes.harmDue(h.current()), false);
});

test('harm detection clears a watch when the next reading is not harmful', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:harm', generation: 2, daysAgo: 10 });
  for (const days of OLD) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  f.occurrence({ daysAgo: 8, outcome: 'corrected' }); f.occurrence({ daysAgo: 6, outcome: 'corrected' }); f.occurrence({ daysAgo: 4, outcome: 'accepted' });
  await f.app.genes.assessHarm(f.project.id);
  assert.ok(f.gene('skill-patch:harm').harmWatch);
  for (const days of [3, 2, 1]) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  f.app.genes.harmChecked.clear();
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 0, offered: false });
  assert.equal(f.gene('skill-patch:harm').harmWatch, undefined, 'the evidence did not persist');
});

test('harm detection is idle work, once a day: housekeeping reaches it when nothing else is due', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:harm', generation: 2, daysAgo: 10 });
  for (const days of OLD) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  for (const days of AFTER) f.occurrence({ daysAgo: days, outcome: 'corrected' });
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.contrast = { at: new Date().toISOString(), turns: 0, trouble: 0, clusters: [], analyzed: true }; });
  f.app.genes.retireChecked.set(f.project.id, Date.now());
  const job = f.app.genes.housekeeping();
  assert.ok(job); await job();
  assert.equal(f.gene('skill-patch:harm').harmWatch.shared, 3);
  assert.equal(f.app.genes.harmDue(f.current()), false, 'asked once a day');
});

test('harm detection: persistence needs more evidence of harm — a clean report of another schedule is not a second reading', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:harm', generation: 2, daysAgo: 10 });
  // s1 got worse after the rule (three clean before, three corrected after); s2 is fine on both sides: equal weights, a delta of .5.
  for (const days of OLD) { f.occurrence({ daysAgo: days, outcome: 'accepted' }); f.occurrence({ daysAgo: days, outcome: 'accepted', scheduleId: 's2' }); }
  for (const days of AFTER) { f.occurrence({ daysAgo: days, outcome: 'corrected' }); f.occurrence({ daysAgo: days, outcome: 'accepted', scheduleId: 's2' }); }
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 1, offered: false });
  assert.equal(f.gene('skill-patch:harm').harmWatch.latestBadAt, f.base - 4 * DAY);
  // The next day s2 delivers one more clean report. The windows moved, the reading is harmful again, and nothing new points at the rule.
  f.occurrence({ daysAgo: 1, outcome: 'accepted', scheduleId: 's2' });
  f.app.genes.harmChecked.clear();
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 1, offered: false }, 'before: any newer settled occurrence of any schedule counted as persistence');
  assert.equal(f.invitations().filter(row => row.kind === 'gene').length, 0);
  // s1 is corrected again: that is evidence, and the reading still holds.
  f.occurrence({ daysAgo: 0.5, outcome: 'corrected' });
  f.app.genes.harmChecked.clear();
  const third = await f.app.genes.assessHarm(f.project.id);
  assert.deepEqual([third.offered, third.geneId], [true, 'skill-patch:harm']);
  assert.equal(f.gene('skill-patch:harm').status, 'trial', 'an invitation, never a retirement');
});

test('harm detection: one flipped result on a schedule too thin to compare is not a reading, however many clean ones sit beside it', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:thin', generation: 2, daysAgo: 10 });
  // s1: one clean before, one corrected after. s2: two clean before, two clean after. Summed as pairs that was "3 shared, delta .5".
  f.occurrence({ daysAgo: 20, outcome: 'accepted', scheduleId: 's1' }); f.occurrence({ daysAgo: 6, outcome: 'corrected', scheduleId: 's1' });
  f.occurrence({ daysAgo: 20, outcome: 'accepted', scheduleId: 's2' }); f.occurrence({ daysAgo: 18, outcome: 'accepted', scheduleId: 's2' });
  f.occurrence({ daysAgo: 8, outcome: 'accepted', scheduleId: 's2' }); f.occurrence({ daysAgo: 4, outcome: 'accepted', scheduleId: 's2' });
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 0, offered: false });
  assert.equal(f.gene('skill-patch:thin').harmWatch, undefined, 'no watch');
  f.occurrence({ daysAgo: 1, outcome: 'accepted', scheduleId: 's2' }); f.app.genes.harmChecked.clear();
  assert.deepEqual(await f.app.genes.assessHarm(f.project.id), { watching: 0, offered: false });
  assert.equal(f.invitations().filter(row => row.kind === 'gene').length, 0);
  assert.equal(f.app.genes.observability(f.project.id).harm.length, 0, 'and the page shows no reading for work that thin');
});

test('harm detection: an older rule is not blamed for a regression that began long after it', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:old', generation: 2, daysAgo: 60 });
  for (const days of [90, 80, 70]) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  for (const days of [55, 50, 45, 40, 35, 30, 25, 20, 15, 12]) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  f.rule({ id: 'skill-patch:new', generation: 3, daysAgo: 8 });
  for (const days of [6, 4, 2]) f.occurrence({ daysAgo: days, outcome: 'corrected' });
  const first = await f.app.genes.assessHarm(f.project.id);
  assert.equal(first.watching, 1);
  assert.equal(f.gene('skill-patch:new').harmWatch?.shared, 3); assert.equal(f.gene('skill-patch:old').harmWatch, undefined, 'ten clean reports followed it: the work after it was fine');
  // Two more passes with new corrected reports: the invitations go to the newest rule only.
  f.occurrence({ daysAgo: 1, outcome: 'corrected' }); f.app.genes.harmChecked.clear();
  assert.deepEqual([(await f.app.genes.assessHarm(f.project.id)).geneId], ['skill-patch:new']);
  f.occurrence({ daysAgo: 0.5, outcome: 'corrected' }); f.app.genes.harmChecked.clear();
  assert.equal((await f.app.genes.assessHarm(f.project.id)).offered, false, 'the new rule was offered once; the old one was never a candidate for blame');
  assert.deepEqual(f.invitations().filter(row => row.kind === 'gene').map(row => row.geneId), ['skill-patch:new']);
  assert.equal(f.gene('skill-patch:old').harmWatch, undefined);
  const harm = Object.fromEntries(f.app.genes.observability(f.project.id).harm.map(row => [row.geneId, row.state]));
  assert.deepEqual(harm, { 'skill-patch:old': 'ok', 'skill-patch:new': 'invited' });
});

test('answering a harm invitation with a retirement labels nothing: the reading is confounded, so it is no verdict on the judgments that let the rule in', async t => {
  const f = await lane(t);
  const labels = [];
  f.app.genes.decisions.labelDecision = (id, label) => { labels.push([id, label]); return true; };
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const apply = async proposal => f.app.genes.applyPatch(f.current(), await f.app.genes.genes.activeGenome(f.current()), proposal, { origin: { kind: 'correction', quote: proposal.title }, originText: proposal.title, trigger: 'correction', announce: null, signal: undefined });
  const harmed = await apply(PATCH), plain = await apply({ ...PATCH, title: '章末留钩子', summary: '每章结尾留一个钩子。', section: '- 每章结尾留一个悬念或钩子。\n- 钩子要在后文回收。' });
  f.app.genes.genes.record(f.project.id, harmed.geneId, row => { row.ledger = { review: 'ledger-harmed' }; row.harmWatch = { at: new Date().toISOString(), invitedAt: new Date().toISOString(), shared: 3, delta: 0.67, latestBadAt: 1 }; });
  f.app.genes.genes.record(f.project.id, plain.geneId, row => { row.ledger = { review: 'ledger-plain' }; });
  await f.app.genes.answerRetirement(f.project.id, harmed.geneId, 'retire');
  assert.equal(f.gene(harmed.geneId).status, 'retired'); assert.equal(f.gene(harmed.geneId).retiredAs, 'dropped');
  assert.deepEqual(labels, [], 'the user took it back on a reading, not on a verdict about the judgments');
  await f.app.genes.answerRetirement(f.project.id, plain.geneId, 'retire');
  assert.deepEqual(labels, [['ledger-plain', 'gene_retired']], 'any other retirement still labels the judgments that admitted the rule');
});

// -------------------------------------------------------------------------------------- bloat
const grown = (f, stats) => f.app.store.mutate(state => {
  const project = state.projects.find(row => row.id === f.project.id), registry = project.genes;
  registry.generations = [{ n: 1, at: new Date().toISOString(), promptChars: 1000 }, { n: 2, at: new Date().toISOString(), promptChars: 1650 }];
  stats.forEach((row, index) => registry.genes.push({ id: `skill-patch:p${index}`, layer: 'skill', key: `p${index}`, title: `规则 ${index}`, summary: 's', status: 'trial', level: 0, createdAt: new Date(Date.now() - 5 * DAY).toISOString(), ...(row ? { stats: row } : {}), body: { skillId: 'project-workflow' } }));
});
// D1 (rule exposure and use) writes these, and nothing else: `stats.injected` when a turn block carried the rule, `stats.recalled` when a
// reply was judged to have met it (followed or went against), `stats.applied` when followed; on the turn `mindContext.exposure` when its
// exposure was judged, `genesInjected` (only when there were any) and `genesVia` (the lesson that carried a rule -> the rule).
const judgedTurn = (extra = {}, at = Date.now()) => ({ id: randomUUID(), status: 'completed', userItemId: randomUUID(), createdAt: new Date(at).toISOString(), completedAt: new Date(at).toISOString(), simulated: false, mindContext: { lessonIds: [], relevantIds: [], commitmentIds: [], exposure: { lessons: 3, methods: 4 }, ...extra } });
test('the bloat rule reads exposure, not level: rules nothing ever judged exposure for are no evidence; rules shown many times and never followed are', async t => {
  const f = await lane(t);
  grown(f, [null, null, null, null]);
  assert.equal(f.app.genes.bloatDue(f.current()), false, 'before D3 four rules at level 0 meant bloat, whether or not any had ever been shown to the model');
  assert.deepEqual(f.app.genes.bloatEvidence(f.current()).unproven, []);
  const g = await lane(t);
  grown(g, [{ injected: 9, applied: 0 }, { injected: 12, applied: 0 }, { injected: 8, applied: 0 }, { injected: 8, applied: 0 }]);
  assert.equal(g.app.genes.bloatDue(g.current()), true);
  assert.deepEqual(g.app.genes.bloatEvidence(g.current()).rules.map(row => [row.shown, row.applied]), [[9, 0], [12, 0], [8, 0], [8, 0]]);
  const h = await lane(t);
  grown(h, [{ injected: 9, applied: 0 }, { injected: 12, applied: 0 }, { injected: 8, applied: 0 }, { injected: 40, applied: 1 }]);
  assert.equal(h.app.genes.bloatDue(h.current()), false, 'one followed even once has earned its place: three rules are not four');
  const i = await lane(t);
  grown(i, [{ injected: 7, applied: 0 }, { injected: 7, applied: 0 }, { injected: 7, applied: 0 }, { injected: 7, applied: 0 }]);
  assert.equal(i.app.genes.bloatDue(i.current()), false, 'not enough exposure yet');
  // D1's `recalled` is relevance, not exposure: a rule judged relevant eight times was in front of the model at least that often, and a count of
  // relevance alone never makes a rule look unexposed (the self-confirming reading the page and the analysis were told "shown N times").
  const j = await lane(t);
  grown(j, [{ recalled: 8, notFollowed: 8, applied: 0 }, { recalled: 8, notFollowed: 8, applied: 0 }, { recalled: 8, notFollowed: 8, applied: 0 }, { injected: 2, recalled: 1, applied: 0 }]);
  assert.deepEqual(j.app.genes.bloatEvidence(j.current()).rules.map(row => [row.shown, row.unproven]), [[8, true], [8, true], [8, true], [2, false]]);
});

test('the bloat rule also counts rules that eight judged turns never put in front of the model, and the focused analysis is told which rules earned nothing', async t => {
  const f = await lane(t);
  grown(f, [null, null, null, null]);
  // Turns whose exposure was never judged (no `mindContext.exposure`) observe nothing, whatever else they carry.
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); for (let index = 0; index < 12; index++) session.turns.push({ ...judgedTurn({}, Date.now() - index * HOUR), mindContext: { lessonIds: [], genesInjected: ['skill-patch:p0'] } }); });
  assert.equal(f.app.genes.bloatDue(f.current()), false, 'unjudged turns are no observation');
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.turns = session.turns.filter(row => !row.mindContext?.genesInjected); for (let index = 0; index < 8; index++) session.turns.push(judgedTurn({}, Date.now() - index * HOUR)); });
  assert.equal(f.app.genes.bloatDue(f.current()), true);
  assert.deepEqual(f.app.genes.bloatEvidence(f.current()).unproven.map(row => [row.shown, row.observed]), [[null, 8], [null, 8], [null, 8], [null, 8]]);
  await f.app.genes.contrast(f.project.id, { focus: 'bloat' });
  const input = JSON.parse(contrastRequests(f.calls)[0].messages.find(row => row.role === 'user').content);
  assert.deepEqual(input.bloat.map(row => [row.id, row.shown, row.applied, row.turnsSinceWritten]), [0, 1, 2, 3].map(index => [`skill-patch:p${index}`, 0, 0, 8]));
  assert.doesNotMatch(input.focus, /level/, 'the self-confirming level is no evidence');
  const genes = input.genes.filter(row => row.id.startsWith('skill-patch:'));
  assert.equal(genes.length, 4); assert.ok(genes.every(row => 'shown' in row && 'applied' in row && !('recalled' in row) && !('clean' in row)), 'the analysis sees exposure counts, never the clean streak');
  assert.match(CONTRAST_SYSTEM, /shown and applied count how often a skill rule was put in front of the agent/, 'the prompt names the field the input carries');
});

test('a rule a lesson carried into the turn was put in front of the model: it is not unexposed, whatever its own block did', async t => {
  const f = await lane(t);
  grown(f, [null, null, null, null]);
  // Eight judged turns since the rules were written; a lesson in context carried rule p0 in every one (D1's `genesVia`: the rule -> its lesson), the block carried p1 in none.
  f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); for (let index = 0; index < 8; index++) session.turns.push(judgedTurn({ genesVia: { 'skill-patch:p0': 'lesson-1' } }, Date.now() - index * HOUR)); });
  const evidence = f.app.genes.bloatEvidence(f.current());
  assert.deepEqual(evidence.rules.map(row => [row.id, row.observed, row.unproven]), [['skill-patch:p0', 8, false], ['skill-patch:p1', 8, true], ['skill-patch:p2', 8, true], ['skill-patch:p3', 8, true]]);
  assert.equal(f.app.genes.bloatDue(f.current()), false, 'three rules are not four');
  assert.deepEqual([...f.app.genes.injectedRecent(f.current())].sort(), [['skill-patch:p0', 8]], 'and the page counts it as put in front of the agent');
});

// --------------------------------------------------------------------------------- dispositions
test('a correction that is no longer waiting leaves a typed disposition: a verdict is terminal, the weather is retryable, a rule is a rule; ids and codes only', async t => {
  const f = await lane(t);
  const turnId = f.turn('写第 3 章');
  const row = (extra = {}) => ({ id: randomUUID(), at: new Date().toISOString(), status: 'pending', attempts: 0, sessionId: f.session.id, turnId, correction: '数字不对', ...extra });
  const queue = rows => f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).genes.reviews = rows; });
  const kinds = () => (f.current().genes.dispositions ?? []).map(entry => [entry.kind, entry.code]);
  // Not a method problem: the judge says so.
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  let one = row(); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
  assert.deepEqual(kinds(), [['terminal', 'judged_no']]);
  // Its conversation is gone.
  one = row({ sessionId: 'gone' }); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
  assert.deepEqual(kinds().at(-1), ['terminal', 'source_gone']);
  // The judge cannot be reached, three times: the weather, not a verdict on the correction.
  f.app.genes.decisions.turnReview = async () => null;
  one = row(); queue([one]);
  for (let attempt = 0; attempt < 3; attempt++) { f.app.genes.queued.clear(); await f.app.genes.runReview(f.project.id, one.id); queue([{ ...f.current().genes.reviews[0], triedAt: undefined }]); }
  assert.deepEqual(kinds().at(-1), ['retryable', 'no_judge']); assert.equal(f.current().genes.dispositions.at(-1).exhausted, true);
  // The author step says it does not fit: terminal.
  f.app.genes.decisions.turnReview = async () => ({ review: true });
  f.app.genes.authorReview = async () => ({ reviewed: true, outcome: 'author_skipped' });
  one = row(); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
  assert.deepEqual(kinds().at(-1), ['terminal', 'author_skipped']);
  // The author could not be reached: retryable, kept in the queue (no disposition yet).
  f.app.genes.reviews.clear(); const before = kinds().length;
  f.app.genes.authorReview = async () => ({ reviewed: true, outcome: 'author_error', retryable: true, code: 'author_error' });
  one = row({ status: 'awaiting_author', verdict: { review: true } }); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
  assert.equal(kinds().length, before, 'still waiting for its retry');
  // The author step could not place or finish the rule and the row is gone: nothing will retry it, so it is not "retry later".
  for (const outcome of ['author_failed', 'replace_unavailable']) {
    f.app.genes.reviews.clear(); f.app.genes.authorReview = async () => ({ reviewed: true, outcome });
    one = row({ status: 'awaiting_author', verdict: { review: true } }); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
    assert.deepEqual(kinds().at(-1), ['terminal', outcome]); assert.deepEqual(f.current().genes.reviews, [], 'the review row is deleted: no retry is waiting');
  }
  // A rule was written.
  f.app.genes.reviews.clear(); f.app.genes.authorReview = async () => ({ reviewed: true, outcome: 'trial', geneId: 'skill-patch:x' });
  one = row({ status: 'awaiting_author', verdict: { review: true } }); queue([one]); await f.app.genes.runReview(f.project.id, one.id);
  assert.deepEqual(kinds().at(-1), ['gene', 'practice']);
  assert.ok(f.current().genes.dispositions.every(entry => !('sessionId' in entry) && !('itemId' in entry) && !('text' in entry)), 'a deleted conversation leaves nothing behind');
  // Bounded.
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).genes.dispositions = Array.from({ length: 60 }, () => ({ at: 'x', kind: 'terminal', code: 'judged_no' })); });
  f.app.genes.noteDisposition(f.project.id, 'terminal', 'covered');
  assert.equal(f.current().genes.dispositions.length, 40);
});

test('a correction of a scheduled report writes its schedule on the rule it produced: the scoreboard follows that task before and after', async t => {
  const f = await lane(t);
  f.app.genes.mind.modelJson = async (_id, request) => request.system === PATCH_AUTHOR_SYSTEM ? { skillId: 'project-workflow', title: '先核对数字', summary: '报告里的数字写之前先和来源核对。', section: '- 报告里每个数字都要能在来源里找到。\n- 写完报告后再核对一遍数字。', when: '写报告', expectation: '数字不再出错' } : null;
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null, contradicts: [] });
  const { itemId } = f.occurrence({ daysAgo: 1, outcome: 'corrected' });
  const rowId = randomUUID();
  f.app.store.mutate(state => { state.projects.find(item => item.id === f.project.id).genes.reviews = [{ id: rowId, at: new Date().toISOString(), status: 'awaiting_author', verdict: { review: true }, attempts: 0, sessionId: f.session.id, turnId: null, run: { actionId: 'deliver-1', scheduleId: 's1', occurrenceKey: 's1:o1' }, correction: '报告里的数字不对', targetItemId: itemId }]; });
  const out = await f.app.genes.runReview(f.project.id, rowId);
  assert.equal(out.outcome, 'trial', JSON.stringify(out));
  const patch = f.current().genes.genes.find(row => row.id === out.geneId);
  assert.deepEqual(patch.origin.scheduleIds, ['s1']);
  assert.equal(patch.body.expectation, '数字不再出错');
});

// --------------------------------------------------------------------------------- observability
test('observability: per-rule exposure, dispositions, generation outcomes, the scoreboard, harm readings, lane state and the last analyses — counts and codes, never text', async t => {
  const f = await lane(t);
  f.rule({ id: 'skill-patch:a', generation: 2, daysAgo: 12, stats: { injected: 4, recalled: 3, applied: 2 }, origin: { kind: 'correction', scheduleIds: ['s1'] } });
  f.rule({ id: 'skill-patch:b', generation: 3, daysAgo: 10 });
  for (const days of OLD) f.occurrence({ daysAgo: days, outcome: 'accepted' });
  f.occurrence({ daysAgo: 8, outcome: 'corrected' }); f.occurrence({ daysAgo: 6, outcome: 'accepted' }); f.occurrence({ daysAgo: 4, outcome: 'corrected' }); f.occurrence({ daysAgo: 2, outcome: 'unanswered' });
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id), session = state.sessions.find(row => row.id === f.session.id);
    session.turns.push(judgedTurn({ genesInjected: ['skill-patch:a'] }, f.base - HOUR));
    project.genes.genes.push({ id: 'guard:g1', layer: 'guard', key: 'g1', title: '检查一', status: 'active', level: 0, generation: 3, runs: 5, hits: 2, lastRunAt: new Date().toISOString(), exposure: { days: { [new Date().toLocaleDateString('sv')]: { ran: 3 } } }, stats: { real: 1, falseMatches: 0 }, body: { toolId: 'guard_g1', trigger: { onWrite: ['**/*.md'] } }, history: [] });
    project.genes.genes.push({ id: 'guard:never', layer: 'guard', key: 'never', title: '没运行过', status: 'trial', level: 0, runs: 0, hits: 0, body: { toolId: 'guard_never', trigger: { onWrite: ['**/*.md'] } }, history: [] });
    project.genes.contrasts = [{ at: new Date(f.base - 3 * DAY).toISOString(), turns: 12, trouble: 4, pairs: 1, clusters: 2, analyzed: true, patches: 1, committed: 1 }];
    project.genes.dispositions = [{ at: new Date().toISOString(), kind: 'terminal', code: 'judged_no' }, { at: new Date().toISOString(), kind: 'retryable', code: 'no_judge', exhausted: true }];
  });
  const view = f.app.genes.observability(f.project.id), text = JSON.stringify(view);
  assert.equal(view.enabled, true);
  const byId = Object.fromEntries(view.genes.map(row => [row.id, row]));
  assert.deepEqual([byId['skill-patch:a'].shown, byId['skill-patch:a'].recalled, byId['skill-patch:a'].applied, byId['skill-patch:a'].injectedRecent, byId['skill-patch:b'].shown], [4, 3, 2, 1, null], 'exposure per rule: shown, judged relevant and followed, the turns of the last 7 days that put it in front of the model');
  assert.deepEqual([byId['guard:g1'].ran, byId['guard:g1'].ranRecent, byId['guard:g1'].real, byId['guard:never'].ran], [5, 3, 1, 0]);
  assert.ok(!('level' in byId['guard:g1']), 'the self-confirming level is not an exposure');
  assert.deepEqual(view.dispositions.corrections.counts, { terminal: { judged_no: 1 }, retryable: { no_judge: 1 } });
  assert.deepEqual(view.contrasts.map(row => [row.trouble, row.pairs, row.committed]), [[4, 1, 1]]);
  assert.deepEqual(Object.keys(view.outcomes.byOutcome).sort(), ['accepted', 'corrected', 'unanswered']);
  assert.equal(view.outcomes.schedules[0].scheduleId, 's1'); assert.equal(view.outcomes.schedules[0].occurrences, 7);
  assert.equal(view.harm.find(row => row.geneId === 'skill-patch:b').harmful, true, 'a reading is shown before any invitation');
  assert.equal(view.scoreboard.find(row => row.geneId === 'skill-patch:a').scope.kind, 'schedule');
  assert.ok(view.generations.length >= 2 && 'rate' in view.generations[0]);
  assert.equal(view.status.A.state, 'idle'); assert.equal(view.status.C.state, 'waiting');
  assert.ok(view.notes.some(note => /never run|还没运行过/.test(note)), view.notes.join(' | '));
  assert.doesNotMatch(text, /报告里的数字不对|每日报告：今天核对/, 'no message text');
  assert.equal(f.app.genes.observability('missing'), null);
});

test('the outcomes of each generation read what the harm reading reads: a thumbs-down on a delivery and a change the user took back count as corrected work, not only a message about it', async t => {
  const f = await lane(t);
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.generations = [{ n: 1, at: new Date(f.base - 20 * DAY).toISOString(), summary: 'one', trigger: 'feedback', geneIds: [] }, { n: 2, at: new Date(f.base - 10 * DAY).toISOString(), summary: 'two', trigger: 'correction', geneIds: [] }]; });
  const clean = [f.occurrence({ daysAgo: 16, outcome: 'accepted' }), f.occurrence({ daysAgo: 14, outcome: 'accepted' })];
  const voted = [f.occurrence({ daysAgo: 8, outcome: 'unanswered' }), f.occurrence({ daysAgo: 6, outcome: 'unanswered' }), f.occurrence({ daysAgo: 4, outcome: 'unanswered' })];
  const undone = f.occurrence({ daysAgo: 2, outcome: 'unanswered' });
  f.app.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id), project = state.projects.find(row => row.id === f.project.id);
    for (const { itemId } of voted.slice(0, 2)) session.items.find(row => row.id === itemId).feedback = { vote: 'down', at: new Date(f.base).toISOString() };
    session.items.find(row => row.id === voted[2].itemId).feedback = { vote: 'up', at: new Date(f.base).toISOString() };
    project.backgroundChanges = [{ id: 'c1', actionId: project.scheduleRuntime.occurrences.find(row => row.key === undone.key).actionId, status: 'reverted', revertedAt: new Date(f.base).toISOString() }];
  });
  const view = f.app.genes.observability(f.project.id), [second, first] = view.generations;
  assert.deepEqual([first.n, first.bad, first.known, first.rate], [1, 0, 2, 0]);
  assert.deepEqual([second.n, second.disliked, second.approved, second.undone, second.bad, second.known], [2, 2, 1, 1, 3, 4], 'two thumbs-down and an undo against one thumbs-up');
  assert.deepEqual([second.before.bad, second.before.known], [0, 2]);
  assert.equal(view.outcomes.byOutcome.disliked, 2); assert.equal(view.outcomes.byOutcome.undone, 1);
  assert.equal(clean.length, 2);
});

test('the lanes report where they are and why nothing happens: lessons due, corrections queued with the author cooldown, how much trouble has piled up against what triggers an analysis', async t => {
  const f = await lane(t);
  let status = f.app.genes.evolutionStatus(f.project.id);
  assert.deepEqual([status.status.A.state, status.status.B.state, status.status.C.state, status.status.C.trouble, status.status.C.needed], ['idle', 'idle', 'waiting', 0, 3]);
  assert.equal(status.status.generation, null);
  // A lesson waiting for a rule, a correction queued, two corrected reports since the last analysis.
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' });
    project.genes.reviews = [{ id: 'r1', at: new Date().toISOString(), status: 'awaiting_author', attempts: 0, sessionId: f.session.id, correction: 'x' }];
    project.genes.generations = [{ n: 1, at: new Date(f.base - DAY).toISOString(), summary: 'g', trigger: 'correction', geneIds: [] }];
  });
  f.occurrence({ daysAgo: 2, outcome: 'corrected' }); f.occurrence({ daysAgo: 1, outcome: 'corrected' });
  f.app.genes.reviews.set(f.project.id, Date.now());
  status = f.app.genes.evolutionStatus(f.project.id);
  assert.deepEqual([status.status.A.state, status.status.A.due], ['due', 1]);
  assert.deepEqual([status.status.B.state, status.status.B.queued, typeof status.status.B.cooldownUntil], ['cooldown', 1, 'string']);
  assert.deepEqual([status.status.C.state, status.status.C.trouble], ['waiting', 2], 'two of the three that start an analysis');
  assert.equal(status.status.generation.n, 1); assert.equal(status.status.B.last, new Date(f.base - DAY).toISOString());
  f.occurrence({ daysAgo: 0.5, outcome: 'corrected' });
  assert.equal(f.app.genes.evolutionStatus(f.project.id).status.C.state, 'due');
  f.app.genes.contrasted.set(f.project.id, Date.now());
  assert.equal(f.app.genes.evolutionStatus(f.project.id).status.C.state, 'spaced');
  assert.equal(typeof f.app.genes.evolutionStatus(f.project.id).status.C.nextAt, 'string');
});

test('GET …/genes/observability serves the measurements; ?view=status the lanes alone; an unknown view is refused; the route is not a gene', async t => {
  const f = await lane(t);
  const get = path => fetch(f.url(path));
  const full = await get(`/api/v2/projects/${f.project.id}/genes/observability`);
  assert.equal(full.status, 200);
  const body = await full.json();
  assert.deepEqual(['at', 'enabled', 'status', 'genes', 'harm', 'dispositions', 'generations', 'scoreboard', 'outcomes', 'bloat', 'contrasts', 'revision'].filter(key => !(key in body)), []);
  const status = await (await get(`/api/v2/projects/${f.project.id}/genes/observability?view=status`)).json();
  assert.deepEqual(Object.keys(status).sort(), ['at', 'enabled', 'revision', 'status']);
  assert.equal((await get(`/api/v2/projects/${f.project.id}/genes/observability?view=everything`)).status, 400);
  assert.equal((await get('/api/v2/projects/nope/genes/observability')).status, 404);
  assert.equal((await get(`/api/v2/projects/${f.project.id}/genes`)).status, 200, 'the tree is as it was');
});

// ------------------------------------------------------------------------------------- fates
test('every rule that leaves leaves with a typed fate: dropped, undone, contradicted, replaced; a rule that comes back has none; the counts and the tree say so', async t => {
  const f = await lane(t);
  const apply = async (proposal, origin = { kind: 'correction', quote: '要先核对伏笔' }) => f.app.genes.applyPatch(f.current(), await f.app.genes.genes.activeGenome(f.current()), proposal, { origin, originText: origin.quote, trigger: 'correction', announce: null, signal: undefined });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const first = await apply(PATCH);
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  f.app.genes.mind.modelJson = async () => ({ ...PATCH, title: '先核对伏笔·合', summary: '合并后的做法。', section: `${PATCH.section}\n- 合并后每章再自查一遍。` });
  const second = await apply({ ...PATCH, title: '伏笔先落盘', summary: '写新章前把伏笔清单写进文件。', section: '- 写新章前，把要呼应的伏笔写进伏笔清单文件。' });
  assert.equal(second.revised, first.geneId);
  assert.equal(f.gene(first.geneId).retiredAs, 'replaced', 'a later rule was written over it');
  // The user's 不再用 on the rule that replaced it: a drop.
  await f.app.genes.retireByUser(f.project.id, second.geneId);
  assert.equal(f.gene(second.geneId).retiredAs, 'dropped');
  // A merge is undone: the rule it replaced comes back with no fate; the merge itself is `undone`.
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const third = await apply({ ...PATCH, title: '章末留钩子', summary: '每章结尾留一个钩子。', section: '- 每章结尾留一个悬念或钩子。' });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const merged = await apply({ ...PATCH, title: '章末钩子与伏笔', summary: '合并。', section: '- 每章结尾留钩子，钩子要在后文回收。' }, { kind: 'consolidation', quote: '合并' });
  assert.equal(merged.revised, third.geneId); assert.equal(f.gene(third.geneId).retiredAs, 'replaced');
  await f.app.genes.retireByUser(f.project.id, merged.geneId);
  assert.equal(f.gene(merged.geneId).retiredAs, 'undone');
  assert.equal(f.gene(third.geneId).status, 'trial'); assert.equal(f.gene(third.geneId).retiredAs, undefined, 'it is back in force: no fate');
  // The user said the opposite later: contradicted.
  await f.app.genes.genes.retireGene(f.project.id, third.geneId, { reason: 'x', restore: false, as: 'contradicted' });
  assert.equal(f.gene(third.geneId).retiredAs, 'contradicted');
  // A fate outside the closed set is ignored, not stored.
  const fourth = await apply({ ...PATCH, title: '开篇先立规矩', summary: '开篇先交代规矩。', section: '- 开篇两节内交代本章的规矩与限制。\n- 规矩要在后文兑现。' }, { kind: 'correction', quote: '开篇先立规矩' });
  await f.app.genes.genes.retireGene(f.project.id, fourth.geneId, { reason: 'x', as: 'free text' });
  assert.equal(f.gene(fourth.geneId).retiredAs, undefined);
  const view = f.app.genes.observability(f.project.id);
  assert.deepEqual(view.dispositions.genes.retired, { replaced: 1, dropped: 1, undone: 1, contradicted: 1, unrecorded: 1 }, 'the one that was retired without a fate is counted as such');
  const tree = geneTree(f.current(), { genome: await f.app.genes.genes.activeGenome(f.current()) });
  const fates = Object.fromEntries(tree.strands.flatMap(row => row.genes).filter(row => row.fate).map(row => [row.id, row.fate]));
  assert.equal(fates[second.geneId], 'dropped'); assert.equal(fates[merged.geneId], 'undone');
});

test('the typed fate follows what happened to the lesson or the skill: revoking the lesson, and withdrawing the skill, each retire with their own', async t => {
  const f = await lane(t);
  f.app.store.revocations.decisions = { enabled: () => false };
  const lessonRow = text => { let id; f.app.store.mutate(state => { id = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind: 'preference' }).id; }); return f.current().mind.lessons.find(row => row.id === id); };
  const apply = async (proposal, origin) => f.app.genes.applyPatch(f.current(), await f.app.genes.genes.activeGenome(f.current()), proposal, { origin, originText: 'x', trigger: 'correction', announce: null, signal: new AbortController().signal });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const revoked = lessonRow('写新章前先核对前文伏笔。'), kept = lessonRow('每章末尾要留一个钩子。');
  const first = await apply(PATCH, { kind: 'lesson', lessonId: revoked.id, quote: revoked.text });
  f.app.genes.markLesson(f.project.id, revoked.id, { geneId: first.geneId });
  const second = await apply({ ...PATCH, title: '章末钩子', summary: '每章末尾留钩子。', section: '- 每章结尾留一个悬念。\n- 钩子要在后文回收。' }, { kind: 'lesson', lessonId: kept.id, quote: kept.text });
  f.app.genes.markLesson(f.project.id, kept.id, { geneId: second.geneId });
  f.app.store.mutate(state => patchMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', revoked.id, { status: 'retired' }));
  await f.app.store.revocations.idle();
  assert.equal(f.gene(first.geneId).status, 'retired'); assert.equal(f.gene(first.geneId).retiredAs, 'lesson_revoked');
  assert.equal(f.gene(second.geneId).status, 'trial', 'what grew from another lesson is untouched');
  // The skill the other rule was written into is withdrawn: its text left with it.
  await f.app.genes.retireInSkills(f.project.id, { tools: [{ kind: 'skill', id: 'project-workflow' }] });
  assert.equal(f.gene(second.geneId).retiredAs, 'skill_withdrawn');
  assert.deepEqual(f.app.genes.observability(f.project.id).dispositions.genes.retired, { lesson_revoked: 1, skill_withdrawn: 1 });
});

// ------------------------------------------------------------------------------------- exposure
test('a check that ran before its runs were counted by day reads as unknown in the last 7 days, on the page, the tree and the notes — not as a dead check', async t => {
  const f = await lane(t);
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.genes.push({ id: 'guard:old', layer: 'guard', key: 'old', title: '老检查', status: 'active', level: 0, generation: 1, runs: 98, hits: 2, lastRunAt: new Date(f.base - 3 * DAY).toISOString(), stats: { real: 1, falseMatches: 0 }, body: { toolId: 'guard_old', trigger: { onWrite: ['**/*.md'] } }, history: [] }); });
  const view = f.app.genes.observability(f.project.id).genes.find(row => row.id === 'guard:old');
  assert.deepEqual([view.ran, view.ranRecent], [98, null]);
  const viewed = geneTree(f.current(), { genome: await f.app.genes.genes.activeGenome(f.current()) }).strands.find(row => row.layer === 'guard').genes.find(row => row.id === 'guard:old');
  assert.deepEqual([viewed.exposure.ran, viewed.exposure.ranRecent], [98, null]);
  assert.ok(!f.app.genes.observability(f.project.id).notes.some(note => /never run|还没运行过/.test(note)), 'it ran 98 times');
});

test('a check\'s runs are counted by local day on the rule (the page reads the last 7 days); a failed run is a run', async t => {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    stream(res, system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60)) ? JSON.stringify(GUARD_ANSWER) : 'ok');
  });
  f.app.genes.enabled = true;
  let lessonId;
  f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  keepsRule(f.workspace);
  assert.equal((await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId))).outcome, 'active');
  const entry = guardsOf(f.current())[0];
  await f.app.genes.genes.runGuard(f.current(), entry, '正文/卷一/第001章.md'); await f.app.genes.genes.runGuard(f.current(), entry, '正文/卷一/第001章.md');
  await f.app.genes.genes.runGuard(f.current(), entry, '正文/卷一/不存在.md');
  const gene = f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.equal(gene.runs, 3); assert.equal(Object.values(gene.exposure.days).reduce((sum, row) => sum + row.ran, 0), 3, 'the failed run counts');
  const view = f.app.genes.observability(f.project.id).genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.deepEqual([view.ran, view.ranRecent], [3, 3]);
  // The record carried to the page (the tree) has the same exposure.
  const viewed = geneTree(f.current(), { genome: await f.app.genes.genes.activeGenome(f.current()) }).strands.find(row => row.layer === 'guard').genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.deepEqual([viewed.exposure.ran, viewed.exposure.ranRecent], [3, 3]);
});

