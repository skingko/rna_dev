import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { geneTree, geneLevel, geneDetail } from '../project-genes.mjs';
import { GUARD_AUTHOR_SYSTEM, PATCH_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';
import { TaskAttentionService, attentionMark } from '../task-attention.mjs';
import { backgroundActionView } from '../project-background-controls.mjs';

// Evolution v3 phase 2 and the §8.1 JEV scenarios: guard triage, leveling from
// real use, lane B skill patches, standard links, retirement proposals, stale
// invitations and task attention. Judges and models are local stubs.
const PATCH_ANSWER = { skillId: 'project-workflow', title: '先核对人名', summary: '写章节前先核对人名和称谓是否与设定集一致。', section: '- 写每一章前，先列出本章出场人物，逐个对照设定集核对名字与称谓。\n- 发现不一致先改设定引用，再动笔。', when: '写章节', expectation: '人名不再前后不一' };

async function withGuard(t) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(PATCH_ANSWER));
    stream(res, 'ok');
  });
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  keepsRule(f.workspace);
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  assert.equal(outcome.outcome, 'active', 'ran on a chapter and found nothing: active at once');
  const guard = () => f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  // A foreground turn in the discussion session (previous turn for the next message).
  const turn = (text, { status = 'completed' } = {}) => {
    const turnId = randomUUID(), userItemId = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status, userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false }); s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: `回复：${text}`, final: true, createdAt: at, simulated: false }); });
    return turnId;
  };
  return { ...f, guard, turn, lessonId };
}

test('guard.triage: confident false matches are withheld from the agent; a guard whose false matches outnumber its catches goes back to trial', async t => {
  const f = await withGuard(t);
  writeFileSync(join(f.workspace, '正文', '卷一', '第002章.md'), '第二章\n他们不叫守夜人。\n守夜的灯亮了。\n');
  let asked;
  f.app.genes.decisions.guardTriage = async (_project, input) => { asked = input; return { real: [1], falseMatches: [0], unsure: [] }; };
  const turnId = randomUUID(), hook = f.app.genes.guardHook(f.project.id, { turnId });
  const [entry] = hook.match('正文/卷一/第002章.md');
  const outcome = await hook.run(entry, '正文/卷一/第002章.md');
  assert.equal(asked.hits.length, 2); assert.match(asked.rule, /守夜/);
  assert.deepEqual(outcome.hits.map(row => row.line), [3], 'the negated mention is withheld'); assert.equal(outcome.withheld, 1);
  assert.deepEqual(f.guard().turns, [turnId], 'the run is recorded against its turn');
  assert.deepEqual({ real: f.guard().stats.real, falseMatches: f.guard().stats.falseMatches }, { real: 1, falseMatches: 1 });
  f.app.genes.decisions.guardTriage = async () => ({ real: [], falseMatches: [0, 1], unsure: [] });
  await hook.run(entry, '正文/卷一/第002章.md');
  assert.equal(f.guard().noisy, true); assert.equal(f.guard().status, 'trial');
  assert.equal(geneTree(f.current()).strands.find(row => row.layer === 'guard').genes[0].noisy, true, 'the tree shows it');
  // No judge: every hit is kept.
  delete f.app.genes.decisions.guardTriage;
  assert.equal((await hook.run(entry, '正文/卷一/第002章.md')).hits.length, 2);
});

test('leveling (EVO-13): turns without a correction are shown, never counted; real catches make a trial guard active without labelling it; a same-point correction takes a level away; the user\'s 对 labels', async t => {
  const f = await withGuard(t);
  f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.status = 'trial'; row.ledger = { review: 'gr-guard' }; });
  const labels = [];
  let judged = null;
  f.app.genes.decisions.mindJudge = async (_project, input) => { judged = input; return { same: [0], contradicts: [], applies: [], resolved: [] }; };
  f.app.genes.decisions.labelDecision = (id, label) => { labels.push([id, label]); return true; };
  for (let index = 0; index < 4; index++) {
    const previous = f.turn(`写第 ${index + 1} 章`);
    f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.turns = [...(row.turns ?? []), previous]; });
    const next = f.turn('好的，继续');
    await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: false }, text: '好的，继续' });
  }
  // Live, 2026-10-05: a check at level 5 from 15 such turns with no real catch. Silence is base rate, not evidence.
  assert.equal(f.guard().stats.clean, 4); assert.equal(f.guard().status, 'trial', 'clean turns alone never promote'); assert.equal(f.guard().level, 0);
  assert.deepEqual(labels, [], 'and never label the judgments that admitted it');
  assert.equal(judged, null, 'no correction, no judgment');
  // Hits guard.triage confirmed as real: three of them make it active. That is guard.triage's own judgment, not an outcome
  // or a user action, so it labels nothing (plan §2.3 #3).
  f.app.genes.recordTriage(f.project.id, 'guard:guard_nightwatch', { real: [0, 1], falseMatches: [] });
  assert.equal(f.guard().status, 'trial');
  f.app.genes.recordTriage(f.project.id, 'guard:guard_nightwatch', { real: [0], falseMatches: [] });
  assert.equal(f.guard().status, 'active'); assert.equal(f.guard().level, 1); assert.deepEqual(labels, [], 'a promotion on a judgment is not a label');
  assert.match(f.guard().history.at(-1).note, /确认抓到 3 处真问题，已生效/);
  const again = f.turn('写第 5 章');
  f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.turns = [...row.turns, again]; });
  const correcting = f.turn('又出现守夜了，说过不能用');
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: correcting, record: { correction: true }, text: '又出现守夜了，说过不能用' });
  assert.deepEqual(outcome.missed, ['guard:guard_nightwatch']); assert.match(judged.candidate, /守夜/); assert.match(judged.lessons[0].text, /守夜/);
  assert.equal(f.guard().stats.missed, 1); assert.equal(f.guard().level, 0);
  assert.equal(geneLevel({ confirmations: 1, stats: { clean: 6, real: 3, missed: 1 } }), 1, 'clean turns add nothing');
  assert.equal(geneLevel({ stats: { clean: 15, real: 0, missed: 0 } }), 0);
  assert.equal(geneLevel({ stats: { applied: 6 } }), 2, 'confidently followed uses count');
  // The user's 对 is a label too: an outcome the user gave.
  labels.length = 0;
  const confirmed = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${encodeURIComponent('guard:guard_nightwatch')}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(confirmed.status, 200); assert.deepEqual(labels, [['gr-guard', 'gene_active']]); assert.equal(f.guard().level, 1);
});

test('leveling: a correction that contradicts a guard retires it in a new generation and says so once the conversation is quiet', async t => {
  const f = await withGuard(t);
  f.app.genes.decisions.mindJudge = async () => ({ same: [], contradicts: [0], applies: [], resolved: [] });
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const previous = f.turn('写第 1 章');
  f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.turns = [previous]; });
  const next = f.turn('守夜这个词现在可以用了');
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text: '守夜这个词现在可以用了' });
  assert.deepEqual(outcome.retired, ['guard:guard_nightwatch']);
  assert.equal(f.guard().status, 'retired'); assert.equal(f.current().genes.generations.at(-1).n, 2);
  const told = f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').at(-1);
  assert.match(told.text, /按你刚才说的，停用了「「守夜」字样检查」|按你刚才说的，停用了「守夜」字样检查/);
});

test('lane B: a correction JEV calls a recurring method problem becomes a skill patch on trial; revoking removes it again', async t => {
  const f = await withGuard(t);
  f.app.genes.enabled = true; // lane B spends a model call: only with background evolution on
  const reviewed = [];
  f.app.genes.decisions.turnReview = async (_project, input) => { reviewed.push(input); return { review: true, method: true, covered: false }; };
  f.app.genes.decisions.mindJudge = async () => ({ same: [], contradicts: [], applies: [], resolved: [] });
  const previous = f.turn('写第 3 章');
  const next = f.turn('人名又前后不一致了，你写之前要核对设定集');
  await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text: '人名又前后不一致了，你写之前要核对设定集', targetText: '第三章……' });
  assert.equal(f.app.genes.jobs.length, 1, 'lane B is queued behind other evolution work');
  assert.equal(f.current().genes.reviews.length, 1, 'and kept in the project, so a restart does not lose it');
  const outcome = await f.app.genes.jobs.shift()();
  assert.equal(outcome.outcome, 'trial', JSON.stringify(outcome));
  assert.equal(reviewed[0].request, '写第 3 章'); assert.equal(reviewed[0].reply, '第三章……'); assert.ok(reviewed[0].existing.some(row => /守夜/.test(row)), 'existing guards and rules are shown');
  const project = f.current(), patch = project.genes.genes.find(row => row.id === outcome.geneId);
  assert.equal(patch.status, 'trial'); assert.equal(patch.layer, 'skill'); assert.equal(patch.body.skillId, 'project-workflow');
  const genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  assert.match(genome.skills[0].instructions, /## 先核对人名\n- 写每一章前/);
  const tree = geneTree(project, { genome });
  assert.ok(tree.strands.find(row => row.layer === 'skill').genes.some(row => row.id === outcome.geneId && row.status === 'trial'));
  const detail = geneDetail(project, outcome.geneId, { genome });
  assert.match(detail.content.patch, /逐个对照设定集/); assert.equal(detail.content.when, '写章节');
  assert.match(f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').at(-1).text, /我把这次的纠正写进了做法/);
  const revoked = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${encodeURIComponent(outcome.geneId)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  const after = f.current(), skill = after.versions.find(row => row.id === after.activeVersionId).bundle.genome.skills[0];
  assert.doesNotMatch(skill.instructions, /先核对人名/);
  // Not a method problem: no model call, no patch.
  f.app.genes.reviews.clear();
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const before = f.calls.length;
  assert.deepEqual(await f.app.genes.reviewTurn(f.project.id, { request: 'r', reply: 'p', correction: '这里写错一个字' }), { reviewed: false });
  assert.equal(f.calls.length, before);
});

test('standard.link: a guard is linked to the standard it helps verify; both show it', async t => {
  const f = await withGuard(t);
  let asked;
  f.app.genes.decisions.standardLink = async (_project, input) => { asked = input; return { index: 0 }; };
  assert.equal(typeof f.app.genes.housekeeping(), 'function', 'an unlinked guard is idle work');
  await f.app.genes.linkStandard(f.project.id, 'guard:guard_nightwatch');
  assert.deepEqual(asked.standards, ['与设定集一致']);
  assert.equal(f.guard().body.standardId, 'consistency');
  const tree = geneTree(f.current());
  assert.deepEqual(tree.strands.find(row => row.layer === 'standard').genes[0].checks.map(row => row.id), ['guard:guard_nightwatch']);
  assert.equal(tree.strands.find(row => row.layer === 'guard').genes[0].standardId, 'consistency');
});

test('skill.retire: a skill unused for a month on a busy project becomes an invitation; the answer retires it (never the primary skill)', async t => {
  const f = await withGuard(t);
  // Add a second skill through a generation, age the project and give it a month of work that never loads that skill.
  await f.app.genes.genes.commitGeneration(f.project.id, { summary: '加入技能', genes: [], change: draft => { draft.skills.push({ id: 'poetry', name: '诗词', description: '写古体诗', instructions: '# 诗词\n\n押韵。', resources: [] }); return draft; } });
  const month = Date.now() - 40 * 86400000;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.createdAt = new Date(month).toISOString(); });
  for (let index = 0; index < 10; index++) f.turn(`写第 ${index + 1} 章`);
  let asked;
  f.app.genes.decisions.skillRetire = async (_project, input) => { asked = input; return { retire: true, ledgerId: 'r1' }; };
  const result = await f.app.genes.proposeRetirement(f.project.id);
  assert.deepEqual(result, { proposed: true, geneId: 'skill:poetry' });
  assert.equal(asked.name, '诗词'); assert.equal(asked.usage, 'not_loaded_this_month'); assert.equal(asked.recent.length, 8);
  const session = f.app.store.state.sessions.find(row => row.id === f.session.id), invitation = session.invitations.find(row => row.kind === 'gene');
  assert.equal(invitation.geneId, 'skill:poetry'); assert.equal(invitation.usage, 'unused');
  assert.equal(await f.app.genes.proposeRetirement(f.project.id), null, 'nothing else to propose; the offered one is not asked again');
  const answered = await fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${invitation.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'answer', choice: 'retire' }) });
  assert.equal(answered.status, 200, await answered.clone().text());
  const project = f.current(), genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  assert.deepEqual(genome.skills.map(row => row.id), ['project-workflow']);
  assert.equal(project.genes.genes.find(row => row.id === 'skill:poetry').status, 'retired');
  await assert.rejects(f.app.genes.genes.retireSkill(f.project.id, 'project-workflow'), /主技能/);
});

test('W3 guard.retire: a check that could not read what it checks has not "never caught anything": only the runs that looked count, and the invitation says so', async t => {
  const f = await withGuard(t);
  const month = Date.now() - 40 * 86400000;
  const mark = fields => f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.createdAt = new Date(month).toISOString(); Object.assign(project.genes.genes.find(row => row.id === 'guard:guard_nightwatch'), fields); });
  for (let index = 0; index < 10; index++) f.turn(`写第 ${index + 1} 章`);
  let asked = 0, input;
  f.app.genes.decisions.skillRetire = async (_project, row) => { asked++; input = row; return { retire: true, ledgerId: 'r1' }; };
  // 40 runs, every one unable to read what it checks (a conflated read, an index over the bound): it looked at nothing.
  mark({ runs: 40, hits: 0, unchecked: 40, retireCheckedAt: undefined });
  assert.equal(await f.app.genes.proposeRetirement(f.project.id), null); assert.equal(asked, 0, 'no judge is asked, no invitation made');
  // 40 runs, 25 of them could not look: 15 looked, still under the 30 a check needs to be called quiet.
  mark({ unchecked: 25 });
  assert.equal(await f.app.genes.proposeRetirement(f.project.id), null); assert.equal(asked, 0);
  // 40 runs, 10 could not look: 30 looked and found nothing. The check is asked about, and the card says 30, not 40.
  mark({ unchecked: 10 });
  assert.deepEqual(await f.app.genes.proposeRetirement(f.project.id), { proposed: true, geneId: 'guard:guard_nightwatch' });
  assert.equal(asked, 1); assert.equal(input.kind, 'check'); assert.equal(input.usage, 'never_caught_anything');
  const invitation = f.app.store.state.sessions.find(row => row.id === f.session.id).invitations.find(row => row.kind === 'gene');
  assert.equal(invitation.usage, 'never_caught'); assert.equal(invitation.runs, 30, 'the runs that looked, not the runs');
});

test('invite.stale: once the user is back, a decision invitation open for over a day is judged again; a stale one is folded, a live one stays', async t => {
  const f = await withGuard(t);
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.invitations = [{ id: 'i1', kind: 'lesson', subject: 'lesson:a', text: '章节末尾不写总结', createdAt: old }, { id: 'i2', kind: 'lesson', subject: 'lesson:b', text: '每章不超过五千字', createdAt: old }, { id: 'i3', kind: 'feedback', subject: 'feedback:x', itemId: 'x', createdAt: old }]; s.items.push({ id: 'later', kind: 'user', text: '总结的事按你说的办了', createdAt: new Date().toISOString() }); });
  const seen = [];
  f.app.store.invitations.decisions = { inviteStale: async (_project, input) => { seen.push(input); return { stale: /总结/.test(input.text), relevant: null }; }, labelDecision() {} };
  const folded = await f.app.store.invitations.rejudgeStale(f.project.id);
  assert.deepEqual(folded, ['i1']); assert.equal(seen.length, 2, 'feedback invitations are not decisions');
  assert.equal(seen[0].conversation.at(-1).text, '总结的事按你说的办了'); assert.equal(seen[0].conversation.at(-1).role, 'user');
  const session = f.app.store.state.sessions.find(row => row.id === f.session.id);
  assert.deepEqual(session.invitations.map(row => row.id), ['i2', 'i3']); assert.ok(session.invitations[0].rejudgedAt);
  assert.deepEqual(await f.app.store.invitations.rejudgeStale(f.project.id), [], 'at most once a day per invitation');
  // Presence triggers it through the route.
  const saved = await fetch(f.url(`/api/projects/${f.project.id}/presence`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: f.session.id, visible: true, typing: false }) });
  assert.equal(saved.status, 200, await saved.clone().text());
});

test('task attention: a finished background result is marked 需要你 by message.value, once, and served with the action', async t => {
  const f = await withGuard(t);
  const finished = new Date().toISOString();
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.initiativeRuntime = { sdkState: { actions: [{ id: 'a1', action: 'work', status: 'completed', content: '核对设定集', handoff: '交接：设定集有两处矛盾，需要你决定保留哪个版本。', createdAt: finished, finishedAt: finished }, { id: 'a2', action: 'work', status: 'running', content: 'x', createdAt: finished }] } }; });
  const service = new TaskAttentionService(f.app.store, { enabled: false, decisions: { messageValue: async (_project, input) => ({ probabilities: { needs_user_decision: /决定/.test(input.text) ? .9 : .1 }, alreadyReported: false, ledgerId: 'v1' }) } });
  assert.deepEqual(service.pending().map(row => row.action.id), ['a1']);
  const mark = await service.mark(f.current(), f.current().initiativeRuntime.sdkState.actions[0]);
  assert.equal(mark.needsUser, true); assert.equal(f.current().taskMarks.a1.needsUser, true);
  assert.equal(service.pending().length, 0, 'judged once');
  const view = backgroundActionView({ project: id => f.app.store.state.projects.find(row => row.id === id), contexts: new Map(), valid: () => false }, f.project.id);
  assert.equal(view.actions.find(row => row.id === 'a1').attention.needsUser, true); assert.equal(view.actions.find(row => row.id === 'a2').attention, null);
  assert.deepEqual(attentionMark({ probabilities: { needs_user_decision: .5 }, alreadyReported: true }, 0), { at: new Date(0).toISOString(), needsUser: false, alreadyReported: true });
});

// Lane A, method (plan §3): a lesson that changes how the work is done becomes a skill patch;
// a patch the review rejects gets one revision with the review's objections.
async function lessonFixture(t, { reviews = [{ pass: true, problems: [] }] } = {}) {
  const authored = [];
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) {
      const text = input.messages.filter(row => row.role === 'user').map(row => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join('')).join('');
      authored.push(JSON.parse(text));
      return stream(res, JSON.stringify({ ...PATCH_ANSWER, title: `先核对人名${authored.length}` }));
    }
    stream(res, 'ok');
  });
  f.app.genes.enabled = true;
  const verdicts = [...reviews];
  f.app.genes.decisions = { geneRoute: async () => ({ guard: false, everyWrite: false, method: true }), geneReview: async () => verdicts.shift() ?? { pass: true, problems: [] } };
  const lesson = text => { let id; f.app.store.mutate(state => { id = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind: 'preference' }).id; }); return f.current().mind.lessons.find(row => row.id === id); };
  return { ...f, authored, lesson };
}

test('lane A: a lesson that changes the method becomes a skill patch on trial (it used to stop at the profile)', async t => {
  const f = await lessonFixture(t);
  const lesson = f.lesson('写章节前先核对出场人物的名字和称谓，和设定集保持一致。');
  const outcome = await f.app.genes.routeLesson(f.current(), lesson);
  assert.deepEqual([outcome.routed, outcome.outcome], ['practice', 'trial'], JSON.stringify(outcome));
  const project = f.current(), patch = project.genes.genes.find(row => row.id === outcome.geneId);
  assert.equal(patch.status, 'trial'); assert.equal(patch.origin.kind, 'lesson'); assert.equal(patch.origin.lessonId, lesson.id);
  assert.equal(project.mind.lessons.find(row => row.id === lesson.id).geneRoute.geneId, outcome.geneId);
  assert.equal(f.authored[0].correction, lesson.text);
  const said = [...f.app.genes.announcements.map(row => row.text), ...f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').map(item => item.text)];
  assert.ok(said.some(text => /按你说过的/.test(text)), said.join(' | '));
});

test('lessons judged "method" before this existed are picked up once, without judging them again', async t => {
  const f = await lessonFixture(t);
  const lesson = f.lesson('交付前先自查一遍格式。');
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.lessons.find(row => row.id === lesson.id).geneRoute = { at: new Date().toISOString(), version: 3, guard: false, method: true }; });
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === lesson.id));
  f.app.genes.decisions.geneRoute = async () => { throw new Error('must not judge again'); };
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lesson.id));
  assert.equal(outcome.routed, 'practice'); assert.equal(outcome.outcome, 'trial');
  assert.equal(f.app.genes.pending().some(row => row.lesson.id === lesson.id), false, 'once');
});

test('a patch the review rejects is rewritten once with the objections; the second draft faces the same review', async t => {
  const f = await lessonFixture(t, { reviews: [{ pass: false, problems: ['conflicts'] }, { pass: true, problems: [] }] });
  const outcome = await f.app.genes.routeLesson(f.current(), f.lesson('调完难度后说明改了哪些参数。'));
  assert.equal(outcome.outcome, 'trial'); assert.equal(outcome.revised, true);
  assert.equal(f.authored.length, 2);
  assert.match(f.authored[1].review.problems[0], /contradicts a rule the user already gave/); assert.equal(f.authored[1].review.draft.title, '先核对人名1');
  const genes = f.current().genes.genes.filter(row => row.layer === 'skill' && row.id.startsWith('skill-patch:'));
  assert.deepEqual(genes.map(row => row.status).sort(), ['rejected', 'trial']);
  // Rejected twice: no third draft.
  const g = await lessonFixture(t, { reviews: [{ pass: false, problems: ['scoped'] }, { pass: false, problems: ['scoped'] }] });
  const twice = await g.app.genes.routeLesson(g.current(), g.lesson('每次改完都跑一遍测试。'));
  assert.equal(twice.outcome, 'rejected'); assert.equal(g.authored.length, 2);
});

test('lane B: "already covered" is judged against working mechanisms, not the lesson captured from the same correction', async t => {
  const f = await lessonFixture(t);
  f.lesson('人名要和设定集一致。');
  const seen = [];
  f.app.genes.decisions.turnReview = async (_project, input) => { seen.push(input.existing); return { review: false }; };
  await f.app.genes.reviewTurn(f.project.id, { request: '写第 3 章', reply: '第三章……', correction: '人名又前后不一致了' });
  assert.ok(!seen[0].some(row => /人名要和设定集一致/.test(row)), JSON.stringify(seen[0]));
});

test('a rule never goes into an imported (marketplace) skill: its bytes are frozen, so the project skill takes it', async t => {
  const f = await lessonFixture(t);
  // An imported skill beside the project's own; the author is only offered the project's own.
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id), genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
    genome.skills.push({ id: 'market_abc', name: 'Imported writing', description: 'from a marketplace', instructions: '# Imported', resources: [], source: { kind: 'marketplace-package' } });
  });
  const genome = await f.app.genes.genes.activeGenome(f.current());
  const proposal = { skillId: 'market_abc', title: '先查原著风格', summary: '动笔前先查证原著风格。', section: '- 动笔前先查证原著整体风格，再按该风格写。\n- 完成前对照一遍。', when: '写章节', expectation: '风格不再跑偏' };
  const outcome = await f.app.genes.tryPatch(f.current(), genome, proposal, { origin: { kind: 'lesson' }, originText: '先查原著风格', trigger: 'feedback' });
  assert.equal(outcome.outcome, 'trial', JSON.stringify(outcome));
  assert.equal(f.current().genes.genes.find(row => row.id === outcome.geneId).body.skillId, 'project-workflow');
  await f.app.genes.routeLesson(f.current(), f.lesson('写之前查一下原著的风格。'));
  assert.ok(f.authored.at(-1).skills.every(row => row.id !== 'market_abc'), 'imported skills are not offered');
});

test('a practice stopped only by a failed save is tried once more; a judged rejection is not', async t => {
  const f = await lessonFixture(t);
  const lesson = f.lesson('写之前先查原著风格。');
  const mark = (route, gene) => f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.mind.lessons.find(row => row.id === lesson.id).geneRoute = route; project.genes ??= { genes: [] }; project.genes.genes = [...(project.genes.genes ?? []).filter(row => row.id !== gene.id), gene]; });
  const route = { version: 3, guard: false, method: true, practiceAt: new Date().toISOString() };
  mark(route, { id: 'skill-patch:failed-save', layer: 'skill', status: 'rejected', origin: { kind: 'lesson', lessonId: lesson.id }, rejection: { code: 'commit_failed', note: 'bytes' } });
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === lesson.id), 'retried once');
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lesson.id));
  assert.equal(outcome.outcome, 'trial');
  mark({ ...route, geneId: undefined, practiceRetriedAt: new Date().toISOString() }, { id: 'skill-patch:failed-save', layer: 'skill', status: 'rejected', origin: { kind: 'lesson', lessonId: lesson.id }, rejection: { code: 'commit_failed' } });
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes.genes = project.genes.genes.filter(row => row.origin?.lessonId !== lesson.id || row.id === 'skill-patch:failed-save'); });
  assert.equal(f.app.genes.pending().some(row => row.lesson.id === lesson.id), false, 'only once');
  f.app.genes.attempted.delete(lesson.id); // the 30-minute pause after an attempt is not what is tested here
  mark({ version: 3, guard: false, method: true, practiceAt: new Date().toISOString() }, { id: 'skill-patch:failed-save', layer: 'skill', status: 'rejected', origin: { kind: 'lesson', lessonId: lesson.id }, rejection: { code: 'review_failed', policy: 2 } });
  assert.equal(f.app.genes.pending().some(row => row.lesson.id === lesson.id), false, 'a review rejection under the current policy stands');
  mark({ version: 3, guard: false, method: true, practiceAt: new Date().toISOString() }, { id: 'skill-patch:failed-save', layer: 'skill', status: 'rejected', origin: { kind: 'lesson', lessonId: lesson.id }, rejection: { code: 'review_failed' } });
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === lesson.id), 'one rejected by the old review that blocked on doubt gets one more pass');
});

test('a working rule counts a use only when the turn that carried it followed it (D1); its fate labels the judgments that admitted it; dropped rules reach the author as tried', async t => {
  const f = await withGuard(t);
  f.app.genes.enabled = true;
  const labels = [];
  Object.assign(f.app.genes.decisions, { turnReview: async () => ({ review: true, method: true, covered: false, ledgerId: 'tr-1' }), geneReview: async () => ({ pass: true, problems: [], ledgerId: 'gr-1' }), mindJudge: async () => ({ same: [], contradicts: [], applies: [], resolved: [] }), labelDecision: (id, label) => { labels.push([id, label]); return true; } });
  // A rule tried before and dropped is shown to the author (RRSI: a falsified hypothesis is not redrawn unchanged).
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes ??= { genes: [], generations: [] }; project.genes.genes.push({ id: 'skill-patch:old', layer: 'skill', key: 'old', title: '先列人物', summary: '写前先列出场人物。', status: 'rejected', rejection: { code: 'review_failed', note: '复审未通过：scoped' }, updatedAt: new Date().toISOString() }); });
  f.turn('写第 3 章'); const next = f.turn('人名又前后不一致了，你写之前要核对设定集');
  await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text: '人名又前后不一致了，你写之前要核对设定集', targetText: '第三章……' });
  const outcome = await f.app.genes.jobs.shift()();
  assert.equal(outcome.outcome, 'trial', JSON.stringify(outcome));
  const contentOf = row => typeof row?.content === 'string' ? row.content : (row?.content ?? []).map(part => part.text ?? '').join('');
  const author = f.calls.find(call => contentOf(call.messages.find(row => row.role === 'system')).includes(PATCH_AUTHOR_SYSTEM.slice(0, 60)));
  const input = JSON.parse(contentOf(author.messages.find(row => row.role === 'user')));
  assert.deepEqual(input.tried.map(row => [row.title, row.outcome, row.why]), [['先列人物', 'rejected', '复审未通过：scoped']]);
  const gene = () => f.current().genes.genes.find(row => row.id === outcome.geneId);
  assert.deepEqual(gene().ledger, { turnReview: 'tr-1', review: 'gr-1' });
  // D1 (EVO-4): the nine novel rules never got a use while it waited for a turn to load the skill they were written into. Now the turn
  // block carries a rule the message calls for (`mindContext.genesInjected`), and at the end of the turn lesson.applied reads the
  // turn's digest: the rule was followed in three of four turns, and confidently ignored in one.
  const verdicts = ['followed', 'went_against', 'followed', 'followed'], asked = [];
  f.app.mind.decisions = { lessonApplied: async (_project, value) => { asked.push(value); return { lessons: value.lessons.map(() => ({ use: 'unsure' })), methods: value.methods.map(() => ({ use: verdicts.shift() ?? 'unsure' })), ledgerId: 'la' }; } };
  const carried = index => { const turnId = f.turn(`写第 ${index + 4} 章`); f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id), at = new Date().toISOString(); s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: `第 ${index + 4} 章正文……`, final: true, createdAt: at, simulated: false }); s.turns.find(row => row.id === turnId).mindContext = { lessonIds: [], relevantIds: [], genesInjected: [outcome.geneId], at }; }); return turnId; };
  const injected = [];
  for (let index = 0; index < 4; index++) { const turnId = carried(index); injected.push(turnId); await f.app.mind.afterReply({ sessionId: f.session.id, turnId }); if (index === 3) { assert.equal(gene().stats.applied, 3); assert.equal(gene().status, 'trial', 'three follows, but the message after the turn has not come yet'); } const after = f.turn('好'); await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: after, record: { correction: false }, text: '好' }); }
  assert.equal(asked.length, 4); assert.match(asked[0].methods[0].text, /出场人物/); assert.match(asked[0].digest.reply, /第 4 章正文/); assert.equal(asked[0].methods[0].title, '先核对人名');
  assert.deepEqual({ recalled: gene().stats.recalled, applied: gene().stats.applied, notFollowed: gene().stats.notFollowed }, { recalled: 4, applied: 3, notFollowed: 1 });
  assert.equal(gene().stats.clean, 4, 'turns without a correction are shown, never counted'); assert.equal(gene().status, 'active', 'three followed uses, not four turns');
  assert.ok(!labels.some(([, label]) => label === 'gene_active'), `promoted on lesson.applied, a judgment: no label (plan §2.3 #3) ${JSON.stringify(labels)}`);
  assert.equal(await f.app.mind.afterReply({ sessionId: f.session.id, turnId: injected[0] }), null, 'a turn is judged once');
  // Retired by the user: the same judgments learn the opposite.
  await f.app.genes.retireByUser(f.project.id, outcome.geneId);
  assert.equal(gene().status, 'retired'); assert.equal(labels.filter(([, label]) => label === 'gene_retired').length, 2);
  assert.deepEqual(f.app.genes.tried(f.current()).map(row => row.title), ['先列人物', '先核对人名'], 'the retired rule joins the tried list');
});

test('a rule that is really a recurring duty becomes a schedule offer, not a working rule; rules routed before the question existed are asked it once', async t => {
  const f = await withGuard(t);
  const invitations = () => f.app.store.state.sessions.find(row => row.id === f.session.id).invitations ?? [];
  const routes = [];
  f.app.genes.decisions = { geneRoute: async (_project, input) => { routes.push(input.text); return { guard: false, everyWrite: false, method: true, periodic: true, ledgerId: 'route-daily' }; }, geneReview: async () => ({ pass: true, problems: [] }) };
  let dailyId, oldId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); dailyId = createMindEntry(project, 'lessons', { text: '每日更新小说内容，目标每日约 1 万字。', kind: 'preference' }).id; oldId = createMindEntry(project, 'lessons', { text: '每周一发一版进度小结。', kind: 'preference' }).id;
    // Routed under the current version before "periodic" existed: only that question is still due.
    project.mind.lessons.find(row => row.id === oldId).geneRoute = { at: new Date().toISOString(), version: 3, guard: false, method: false }; });
  const lesson = id => f.current().mind.lessons.find(row => row.id === id);
  const outcome = await f.app.genes.routeLesson(f.current(), lesson(dailyId));
  assert.deepEqual({ routed: outcome.routed, outcome: outcome.outcome }, { routed: 'schedule', outcome: 'offered' });
  const offer = invitations().find(row => row.kind === 'schedule');
  assert.equal(offer.text, '每日更新小说内容，目标每日约 1 万字。'); assert.equal(offer.time, '09:00'); assert.equal(offer.ledgerId, 'route-daily');
  assert.equal(lesson(dailyId).geneRoute.periodic, true); assert.ok(lesson(dailyId).geneRoute.scheduleOfferedAt); assert.equal(lesson(dailyId).geneRoute.geneId, undefined, 'no skill patch was written');
  assert.equal(f.current().genes.funnel.A.schedule_offered, 1);
  assert.ok(f.app.genes.periodicDue(lesson(oldId)), 'an earlier rule is due for the periodic question only');
  assert.ok(!f.app.genes.pending().some(row => row.lesson.id === oldId), 'not lane A work: nothing is re-authored');
  // Idle work in order: the fixture's guard is already linked to a standard here, so the next idle job is the periodic question.
  f.app.genes.genes.record(f.project.id, 'guard:guard_nightwatch', row => { row.body = { ...(row.body ?? {}), standardLinkedAt: new Date().toISOString() }; });
  const job = f.app.genes.housekeeping(); assert.equal(typeof job, 'function', 'idle work asks the question');
  const second = await job();
  assert.equal(second.routed, 'schedule'); assert.equal(routes.length, 2);
  assert.equal(invitations().filter(row => row.kind === 'schedule').length, 2);
  assert.equal(f.app.genes.periodicDue(lesson(oldId)), false, 'asked once');
  // Not periodic: the earlier verdict stands and nothing else is authored.
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, everyWrite: false, method: false, periodic: false });
  let plainId; f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); plainId = createMindEntry(project, 'lessons', { text: '回复先给结论。', kind: 'preference' }).id; project.mind.lessons.find(row => row.id === plainId).geneRoute = { at: new Date().toISOString(), version: 3, guard: false, method: false }; });
  assert.deepEqual(await f.app.genes.routeLesson(f.current(), lesson(plainId)), { routed: 'profile', periodic: false });
  assert.equal(lesson(plainId).geneRoute.periodic, false); assert.equal(invitations().filter(row => row.kind === 'schedule').length, 2);
});
