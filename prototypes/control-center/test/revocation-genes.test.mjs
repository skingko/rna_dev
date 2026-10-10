import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry, addLesson, mindSource, mindEvidence, patchMindEntry, deleteMindEntry, grownGenes, lessonLink, lessonRank } from '../project-mind.mjs';
import { sourceScope, withdrawSources } from '../source-revocation.mjs';
import { RevocationDispatcher } from '../revocation-dispatcher.mjs';
import { GeneEvolutionService, GUARD_AUTHOR_SYSTEM, PATCH_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';

// C4 (reference alignment §1.3 D/F rows): what the user takes back reaches everything that grew from it — the guard or
// patch a lesson grew, also when the lesson row is gone, when one rule holds two lessons' words, and when the lesson was
// replaced by a contradicting one — and the user's latest word retires the older rule at placement (never the other way
// round: what the assistant concluded does not override a rule in force). Judges and models are stubs.
const PATCH_ANSWER = { skillId: 'project-workflow', title: '先核对伏笔', summary: '写新章前先核对前文伏笔。', section: '- 写新章前，先列出本章要呼应的前文细节。\n- 每个呼应点都要能在前文找到出处。', when: '写新章节', expectation: '不再引用没铺垫过的情节' };
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
const systemOf = input => textOf(input.messages.find(row => row.role === 'system')?.content);
const rewriting = input => { const data = JSON.parse(textOf(input.messages.find(row => row.role === 'user').content)); return data.rewrite ? { ...PATCH_ANSWER, title: `${data.rewrite.rules[0].title}·合`, summary: '合并后的做法。', section: `${data.rewrite.rules.map(row => row.section).join('\n')}\n- 合并后每章再自查一遍。` } : PATCH_ANSWER; };

async function fixture(t, { patch = () => PATCH_ANSWER } = {}) {
  const f = await setup(t, (input, res) => {
    const system = systemOf(input);
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(patch(input)));
    stream(res, 'ok');
  });
  f.app.genes.enabled = true;
  f.app.genes.decisions = { geneRoute: async (_project, input) => (input.text.includes('守夜') ? { guard: true, checkable: true, everyWrite: true, method: false } : { guard: false, checkable: false, everyWrite: false, method: true, periodic: false }), geneReview: async () => ({ pass: true, problems: [] }), geneConsolidate: async () => ({ action: 'add', index: null }), labelDecision: () => true };
  f.app.store.revocations.decisions = { enabled: () => false };
  const lesson = (text, kind = 'constraint') => { let id; f.app.store.mutate(state => { id = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind }).id; }); return f.current().mind.lessons.find(row => row.id === id); };
  const gene = id => f.current().genes.genes.find(row => row.id === id);
  const genome = () => f.current().versions.find(row => row.id === f.current().activeVersionId).bundle.genome;
  const said = () => f.app.genes.announcements.map(row => row.text).concat(f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').map(item => item.text)).join('\n');
  const patchOf = async (proposal, origin, originText = 'x') => f.app.genes.applyPatch(f.current(), await f.app.genes.genes.activeGenome(f.current()), proposal, { origin, originText, trigger: 'correction', announce: null, signal: new AbortController().signal });
  const change = fn => f.app.store.mutate(state => fn(state.projects.find(row => row.id === f.project.id), state));
  const revoke = async id => { change(project => patchMindEntry(project, 'lessons', id, { status: 'retired' })); await f.app.store.revocations.idle(); };
  const entries = type => (f.current().mind.revocations ?? []).filter(row => !type || row.type === type);
  return { ...f, lesson, gene, genome, said, patchOf, change, revoke, entries };
}

test('lesson_revoked reaches the guard and the patch it grew, in their own generations, and not the rule of another lesson; the conversation is told, the route is forgotten', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const guardLesson = f.lesson('正文里不得出现“守夜”字样。'), practiceLesson = f.lesson('写新章前先核对前文伏笔。', 'preference'), otherLesson = f.lesson('每章末尾要留一个钩子。', 'preference');
  const guard = await f.app.genes.routeLesson(f.current(), guardLesson), practice = await f.app.genes.routeLesson(f.current(), practiceLesson);
  assert.equal(guard.geneId, 'guard:guard_nightwatch'); assert.ok(practice.geneId?.startsWith('skill-patch:'), JSON.stringify(practice));
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, method: true, periodic: false });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const keptGene = await f.patchOf({ ...PATCH_ANSWER, title: '章末钩子', summary: '每章末尾留钩子。', section: '- 每章结尾留一个悬念。\n- 钩子要在后文回收。' }, { kind: 'lesson', lessonId: otherLesson.id, quote: otherLesson.text });
  f.app.genes.markLesson(f.project.id, otherLesson.id, { geneId: keptGene.geneId });
  const before = f.current().genes.generations.length;
  assert.deepEqual(grownGenes(f.current(), f.current().mind.lessons.find(row => row.id === guardLesson.id)).map(row => row.id), [guard.geneId]);

  await f.revoke(guardLesson.id);
  assert.equal(f.gene(guard.geneId).status, 'retired', 'the check no longer runs');
  assert.ok(!f.genome().tools.some(row => row.id === 'guard_nightwatch') && !/自动检查/.test(f.genome().skills[0].instructions), 'its tool and its note left the bundle');
  assert.equal(f.gene(practice.geneId).status, 'trial'); assert.equal(f.gene(keptGene.geneId).status, 'trial', 'what grew from other lessons is untouched');
  assert.equal(f.current().genes.generations.length, before + 1, 'one generation for the one check');
  assert.equal(f.current().mind.lessons.find(row => row.id === guardLesson.id).geneRoute, undefined, 'the route is forgotten: turned back on, the lesson is routed again');
  assert.match(f.said(), /你撤销了它的来源经验，由它而来的「「守夜」字样检查」也停用了|你撤销了它的来源经验，由它而来的「守夜」字样检查也停用了/);
  const entry = f.entries('lesson_revoked').find(row => row.lessonId === guardLesson.id);
  assert.ok(entry.settledAt); assert.deepEqual(entry.result.genes.retired, [guard.geneId]); assert.equal(entry.result.violations, 0);
  assert.deepEqual(grownGenes(f.current(), lessonLink(guardLesson)), [], 'the invariant: nothing live grew from it');

  // Deleting the lesson takes its rule with it although the row is gone: the entry kept what links them.
  f.change(project => deleteMindEntry(project, 'lessons', practiceLesson.id));
  await f.app.store.revocations.idle();
  assert.equal(f.current().mind.lessons.find(row => row.id === practiceLesson.id), undefined);
  assert.equal(f.gene(practice.geneId).status, 'retired'); assert.ok(!f.genome().skills[0].instructions.includes(PATCH_ANSWER.section.split('\n')[0]), 'the patch left the skill');
  assert.equal(f.gene(keptGene.geneId).status, 'trial');
  assert.ok(f.entries('lesson_revoked').every(row => row.settledAt && row.text === undefined && row.link === undefined), 'settled entries hold neither the revoked words nor the links');
  assert.match(f.said(), /你撤销了它的来源经验/);
});

test('a rule that holds two lessons\' words: revoking one undoes the merge (the other\'s rule is back), and a lesson whose rule went with it is routed again', async t => {
  const f = await fixture(t, { patch: rewriting });
  const l1 = f.lesson('与参考差距大时整章推翻重写。', 'preference'), l2 = f.lesson('每写一章都对照参考作品的对应章节。', 'preference');
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'lesson', lessonId: l1.id, quote: l1.text });
  f.app.genes.markLesson(f.project.id, l1.id, { geneId: a.geneId });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  // The second lesson's new content is written into the first rule: one rule, holding both (its origin is the second lesson).
  const merged = await f.patchOf({ ...PATCH_ANSWER, title: '逐章对照', summary: '每章对照参考作品。', section: '- 每写一章都对照参考作品的对应章节。' }, { kind: 'lesson', lessonId: l2.id, quote: l2.text });
  f.app.genes.markLesson(f.project.id, l2.id, { geneId: merged.geneId });
  assert.equal(merged.revised, a.geneId); assert.equal(f.gene(a.geneId).status, 'retired'); assert.equal(f.gene(merged.geneId).status, 'trial');
  const mergedNote = f.gene(merged.geneId).body.note;
  assert.ok(f.genome().skills[0].instructions.includes(mergedNote));

  // The first lesson is revoked: its rule is found through the rule that replaced it, the merge is undone, and what came back that
  // grew from the same lesson is retired in the next round; the second lesson, whose words were only in the merged rule, is routed again.
  await f.revoke(l1.id);
  assert.deepEqual([f.gene(merged.geneId).status, f.gene(a.geneId).status], ['retired', 'retired'], 'neither the merged rule nor the first lesson\'s rule runs');
  const instructions = f.genome().skills[0].instructions;
  assert.ok(!instructions.includes(mergedNote) && !instructions.includes('整章推翻重写'), 'its words left the skill');
  assert.equal(f.current().mind.lessons.find(row => row.id === l2.id).geneRoute, undefined, 'the lesson whose rule was retired with it is due for routing again');
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === l2.id), 'and lane A picks it up');
  const entry = f.entries('lesson_revoked')[0];
  assert.deepEqual([...entry.result.genes.retired].sort(), [merged.geneId, a.geneId].sort()); assert.ok(entry.result.genes.restored.includes(a.geneId), 'the merge was undone first');
});

test('revoking the lesson whose words a rewrite added: the merge is undone and the earlier lesson\'s rule keeps running', async t => {
  const f = await fixture(t, { patch: rewriting });
  const l1 = f.lesson('与参考差距大时整章推翻重写。', 'preference'), l2 = f.lesson('每写一章都对照参考作品的对应章节。', 'preference');
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'lesson', lessonId: l1.id, quote: l1.text });
  f.app.genes.markLesson(f.project.id, l1.id, { geneId: a.geneId });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const merged = await f.patchOf({ ...PATCH_ANSWER, title: '逐章对照', summary: '每章对照参考作品。', section: '- 每写一章都对照参考作品的对应章节。' }, { kind: 'lesson', lessonId: l2.id, quote: l2.text });
  f.app.genes.markLesson(f.project.id, l2.id, { geneId: merged.geneId });
  await f.revoke(l2.id);
  assert.equal(f.gene(merged.geneId).status, 'retired'); assert.equal(f.gene(a.geneId).status, 'trial', 'the first lesson\'s rule came back');
  assert.ok(f.genome().skills[0].instructions.includes('整章推翻重写'), 'and is in the skill again');
  assert.ok(!f.genome().skills[0].instructions.includes('对照参考作品的对应章节'), 'the revoked lesson\'s words are not');
  assert.match(f.said(), /之前被它替换的「整章重写」已恢复/);
  assert.equal(f.current().mind.lessons.find(row => row.id === l1.id).geneRoute.geneId, a.geneId, 'the first lesson still has its rule');
});

test('revoking a lesson that was only judged a duplicate of a rule leaves that rule running for the lesson it grew from; revoking the lesson it grew from retires it and sends the duplicate back to routing', async t => {
  const f = await fixture(t, { patch: rewriting });
  const l0 = f.lesson('与参考差距大时整章推翻重写。', 'preference'), l2 = f.lesson('差距很大的话就整章重写，不要小改。', 'preference');
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'lesson', lessonId: l0.id, quote: l0.text });
  f.app.genes.markLesson(f.project.id, l0.id, { geneId: a.geneId });
  // The second lesson was judged a duplicate of the rule (the skip paths of lane A record the rule that already stood, with and without the marker).
  f.app.genes.markLesson(f.project.id, l2.id, { geneId: a.geneId, consolidated: 'duplicate' });
  assert.equal(f.gene(a.geneId).status, 'trial');
  const l0Row = () => f.current().mind.lessons.find(row => row.id === l0.id), l2Row = () => f.current().mind.lessons.find(row => row.id === l2.id);
  assert.equal(grownGenes(f.current(), l2Row()).length, 1, 'the rule carries the duplicate (no confirmation card is asked for it)');
  assert.deepEqual(grownGenes(f.current(), l2Row(), { derived: true }), [], 'but it did not grow from it');
  await f.revoke(l2.id);
  assert.equal(f.gene(a.geneId).status, 'trial', 'the duplicate went; the rule of the lesson that is still live stays');
  assert.equal(l0Row().status, 'active'); assert.ok(f.genome().skills[0].instructions.includes('整章推翻重写'), 'and is in the skill');
  assert.equal(f.entries('lesson_revoked').find(row => row.lessonId === l2.id).result.genes.retired.length, 0);
  // The audit does not take a retired duplicate for a revocation that never reached the rule either.
  f.change(project => { Object.assign(project.mind.lessons.find(row => row.id === l2.id), { status: 'retired', retiredReason: 'user_revoked' }); delete project.mind.lessons.find(row => row.id === l2.id).revocation; });
  assert.equal(f.app.store.revocations.sweep(), 0);
  // The lesson the rule grew from is revoked: the rule goes, and the duplicate, whose rule left, is routed again if it is live.
  const l3 = f.lesson('差距太大就整章重写。', 'preference');
  f.app.genes.markLesson(f.project.id, l3.id, { geneId: a.geneId, consolidated: 'duplicate' });
  await f.revoke(l0.id);
  assert.equal(f.gene(a.geneId).status, 'retired');
  assert.equal(f.current().mind.lessons.find(row => row.id === l3.id).geneRoute, undefined, 'the duplicate that relied on it is routed again');
});

test('a lesson retired because its source message was rewound, or the project scope changed, retires its rule — and the conversation is not told the user revoked it', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const SECRET = 'PRIVATE-EXCERPT-用户的原话';
  const sourced = (text, source, evidence, kind = 'constraint') => { const made = f.lesson(text, kind); f.change(project => { Object.assign(project.mind.lessons.find(row => row.id === made.id), { source, evidence }); }); return f.current().mind.lessons.find(row => row.id === made.id); };
  const guardLesson = sourced('正文里不得出现“守夜”字样。', mindSource('correction', { sessionId: f.session.id, itemId: 'm-1' }), [mindEvidence({ sessionId: f.session.id, itemId: 'm-1', excerpt: SECRET })]);
  const practiceLesson = sourced('写新章前先核对前文伏笔。', mindSource('background', { actionId: 'act-1' }), [mindEvidence({ actionId: 'act-1', excerpt: SECRET })], 'preference');
  const guard = await f.app.genes.routeLesson(f.current(), guardLesson), practice = await f.app.genes.routeLesson(f.current(), practiceLesson);
  assert.ok(guard.geneId && practice.geneId);
  f.change((project, state) => { withdrawSources(state, project, sourceScope({ sessionId: f.session.id, itemIds: ['m-1'], turnIds: [] }), { mode: 'rewound' }); });
  await f.app.store.revocations.idle();
  assert.equal(f.gene(guard.geneId).status, 'retired');
  assert.match(f.said(), /它的来源消息被编辑或删除了，由它而来的/); assert.doesNotMatch(f.said(), /你撤销了它的来源经验/, 'the user revoked nothing: they edited a message');
  assert.equal(f.entries('lesson_revoked').find(row => row.lessonId === guardLesson.id).cause, 'source_removed');
  f.change((project, state) => { withdrawSources(state, project, sourceScope({ actionIds: ['act-1'] }), { mode: 'privacy' }); });
  await f.app.store.revocations.idle();
  assert.equal(f.gene(practice.geneId).status, 'retired');
  assert.match(f.said(), /项目范围变了，它来源的后台工作已撤销/); assert.doesNotMatch(f.said(), /你撤销了它的来源经验/);
  assert.equal(f.entries('lesson_revoked').find(row => row.lessonId === practiceLesson.id).cause, 'privacy_revoked');
  assert.ok(f.entries('lesson_revoked').every(row => row.settledAt));
  assert.ok(!JSON.stringify(f.current().mind.revocations).includes('PRIVATE-EXCERPT'), 'and no entry holds the passage');
});

test('a stale lesson is not among the rules the evolution authors are told to respect', async t => {
  const f = await fixture(t);
  const keep = f.lesson('每章末尾要留一个钩子。', 'preference'), gone = f.lesson('最后用 prose_reword 换说法。', 'preference');
  f.change(project => { project.mind.lessons.find(row => row.id === gone.id).stale = { reason: 'tool_withdrawn', tools: ['prose_reword'], at: new Date().toISOString() }; });
  const existing = f.app.genes.authoringExisting(f.current(), null);
  assert.ok(existing.some(text => text.includes('每章末尾要留一个钩子')), 'the live lesson is'); assert.ok(!existing.some(text => text.includes('prose_reword')), 'the stale one is not');
  assert.ok(keep.id);
  // A user restoring it ({ stale: null }, as the mind API does) puts it back.
  f.change(project => patchMindEntry(project, 'lessons', gone.id, { stale: null }));
  assert.ok(f.app.genes.authoringExisting(f.current(), null).some(text => text.includes('prose_reword')));
});

test('a lesson the user\'s newer word contradicts (mind.judge) is taken back with its rule: retired as "contradicted", nothing it replaced comes back', async t => {
  const f = await fixture(t, { patch: rewriting });
  const old = f.lesson('与参考差距大时整章推翻重写。', 'preference');
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'lesson', lessonId: old.id, quote: old.text });
  f.app.genes.markLesson(f.project.id, old.id, { geneId: a.geneId });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const merged = await f.patchOf({ ...PATCH_ANSWER, title: '对照与重写', summary: '合并。', section: '- 每写一章都对照参考作品。' }, { kind: 'lesson', lessonId: old.id, quote: old.text });
  f.app.genes.markLesson(f.project.id, old.id, { geneId: merged.geneId });
  assert.equal(f.gene(a.geneId).status, 'retired');
  // The user's next word reverses it; the lesson writer's judge calls the newest lesson a contradiction of the older one.
  let newest;
  f.change(project => { newest = addLesson(project.mind, { kind: 'preference', text: '不要整章重写，在原稿上改就行。', source: mindSource('correction', {}) }, { now: Date.now() + 1000 }).id; });
  f.app.mind.decisions = { enabled: () => true, mindJudge: async (_project, input) => ({ same: [], contradicts: input.lessons.flatMap((row, index) => row.text.includes('整章推翻重写') ? [index] : []), refines: [], applies: [], notApplies: [], resolved: [] }) };
  // The rule-level question (gene.consolidate `contradicts`, probed): the new word REVERSES the merged rule.
  const asked = [];
  f.app.genes.decisions.geneConsolidate = async (_project, input) => { asked.push(input); return { action: 'add', index: null, contradicts: input.contradicts ? input.existing.map((_, index) => index) : [] }; };
  await f.app.mind.consolidateLesson(f.project.id, newest);
  await f.app.store.revocations.idle();
  assert.equal(f.current().mind.lessons.find(row => row.id === old.id).status, 'superseded'); assert.equal(f.current().mind.lessons.find(row => row.id === old.id).supersededReason, 'contradicts');
  assert.equal(asked.length, 1); assert.equal(asked[0].contradicts, true); assert.equal(asked[0].body, '不要整章重写，在原稿上改就行。', 'the rule is asked about the newer word, as placement asks it');
  assert.deepEqual([f.gene(merged.geneId).status, f.gene(a.geneId).status], ['retired', 'retired'], 'the rule it grew is gone and nothing it replaced came back');
  assert.ok(!f.genome().skills[0].instructions.includes('整章推翻重写'));
  assert.match(f.said(), /按你刚才说的，停用了/); assert.doesNotMatch(f.said(), /恢复了|已恢复/);
  assert.equal(f.entries('lesson_revoked')[0].cause, 'contradicted'); assert.equal(f.entries('lesson_revoked')[0].replacedBy, newest);
});

test('a lesson-level "contradicts" alone retires no rule: a newer word that is only an exception to it keeps the rule (the rule-level question decides); no answer retires nothing', async t => {
  const f = await fixture(t, { patch: rewriting });
  const old = f.lesson('Tabs, never spaces.', 'preference');
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '缩进用制表符', summary: '缩进一律用制表符。', section: '- 缩进一律用制表符，不要用空格。' }, { kind: 'lesson', lessonId: old.id, quote: old.text });
  f.app.genes.markLesson(f.project.id, old.id, { geneId: a.geneId });
  // The lesson writer's judge calls "In Python files use four spaces" a contradiction of the older lesson (live: 0.96, above the high line);
  // the older lesson is superseded as before, but the rule is asked again on its own.
  f.app.mind.decisions = { enabled: () => true, mindJudge: async (_project, input) => ({ same: [], contradicts: input.lessons.map((_, index) => index), refines: [], applies: [], notApplies: [], resolved: [] }) };
  let verdict = { action: 'add', index: null, contradicts: [] };
  f.app.genes.decisions.geneConsolidate = async () => verdict;
  let newest;
  f.change(project => { newest = addLesson(project.mind, { kind: 'preference', text: 'In Python files use four spaces, not tabs.', source: mindSource('correction', {}) }, { now: Date.now() + 1000 }).id; });
  await f.app.mind.consolidateLesson(f.project.id, newest);
  await f.app.store.revocations.idle();
  const lesson = () => f.current().mind.lessons.find(row => row.id === old.id);
  assert.equal(lesson().status, 'superseded'); assert.equal(lesson().supersededReason, 'contradicts');
  assert.equal(f.gene(a.geneId).status, 'trial', 'an exception leaves the rule running for every other file');
  assert.ok(f.genome().skills[0].instructions.includes('缩进一律用制表符'));
  const entry = f.entries('lesson_revoked')[0];
  assert.ok(entry.settledAt); assert.deepEqual(entry.result.genes.retired, []); assert.doesNotMatch(f.said(), /停用了/);
  // The same entry, with the rule-level judge saying it IS reversed, retires the rule (restore:false), announced as the user's later word.
  verdict = { action: 'add', index: null, contradicts: [0] };
  f.app.store.revocations.dispatch({ type: 'lesson_revoked', projectId: f.project.id, lessonId: old.id, cause: 'contradicted', replacedBy: newest, text: old.text });
  await f.app.store.revocations.idle();
  assert.equal(f.gene(a.geneId).status, 'retired'); assert.match(f.said(), /按你刚才说的，停用了/);
  // No answer from the rule-level judge: nothing is retired on the lesson-level yes.
  const b = await f.patchOf({ ...PATCH_ANSWER, title: '提交信息简短', summary: '提交信息要短。', section: '- 提交信息控制在 50 字符以内。' }, { kind: 'lesson', lessonId: old.id, quote: old.text });
  f.app.genes.decisions.geneConsolidate = async () => null;
  f.app.store.revocations.dispatch({ type: 'lesson_revoked', projectId: f.project.id, lessonId: old.id, cause: 'contradicted', replacedBy: newest, text: old.text });
  await f.app.store.revocations.idle();
  assert.equal(f.gene(b.geneId).status, 'trial', 'no answer: nothing retired');
  // A contradiction the user decided on a card (they chose the newer rule over this one) is their decision: no second opinion.
  f.app.store.revocations.dispatch({ type: 'lesson_revoked', projectId: f.project.id, lessonId: old.id, cause: 'chosen', replacedBy: newest, text: old.text });
  await f.app.store.revocations.idle();
  assert.equal(f.gene(b.geneId).status, 'retired');
});

test('audit and durability: a lesson retired before entries existed whose rule still runs is found once; an entry written but not drained is finished by the next dispatcher', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const one = f.lesson('正文里不得出现“守夜”字样。'), two = f.lesson('写新章前先核对前文伏笔。', 'preference');
  const guard = await f.app.genes.routeLesson(f.current(), one), practice = await f.app.genes.routeLesson(f.current(), two);
  // As an older version left it: retired by the user, no revocation marker, the check still running.
  f.change(project => { const lesson = project.mind.lessons.find(row => row.id === one.id); Object.assign(lesson, { status: 'retired', retiredReason: 'user_revoked' }); });
  assert.equal(f.gene(guard.geneId).status, 'active');
  assert.equal(f.app.store.revocations.sweep(), 1, 'the audit finds it'); assert.equal(f.app.store.revocations.sweep(), 0, 'once'); await f.app.store.revocations.idle();
  assert.equal(f.gene(guard.geneId).status, 'retired'); assert.equal(f.entries('lesson_revoked')[0].cause, 'user_revoked');
  // A revocation recorded and not drained (the process stopped): the next dispatcher finishes it.
  await f.app.store.revocations.close();
  f.change(project => patchMindEntry(project, 'lessons', two.id, { status: 'retired' }));
  assert.equal(f.gene(practice.geneId).status, 'trial', 'nothing ran: the dispatcher was closed');
  const next = new RevocationDispatcher(f.app.store, { decisions: { enabled: () => false }, auditIntervalMs: 0 });
  next.register(f.app.mind.revocationHandler()).register(f.app.genes.revocationHandler());
  t.after(() => next.close());
  await next.drain();
  assert.equal(f.gene(practice.geneId).status, 'retired', 'finished after the restart');
  assert.ok(f.entries('lesson_revoked').every(row => row.settledAt));
});

test('tool_withdrawn: a retired check is not one (the host runs it); the rules written into a withdrawn skill are retired with it', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const guard = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  await f.app.genes.retireByUser(f.project.id, guard.geneId);
  await f.app.store.revocations.idle();
  // A check is the host's, not a tool the assistant calls: retiring it (also as the consequence of revoking its lesson) is no `tool_withdrawn`,
  // so no stale judgment runs over the notes, plans and lessons nearest the rule's own title and summary.
  assert.equal(f.entries('tool_withdrawn').length, 0, 'retiring a check withdraws no tool');
  // A skill leaves: its patches have no text left to stand on. (The genome has one skill; the rows stand for a second one's patches.)
  f.change(project => { project.genes.genes.push({ id: 'skill-patch:extra1', layer: 'skill', key: 'extra1', title: '额外做法', summary: '写在被停用技能里的做法', level: 0, status: 'trial', generation: 1, origin: { kind: 'correction', quote: 'x' }, body: { skillId: 'extra-skill', note: '\n\n## 额外做法\n- 做某事。' }, createdAt: new Date().toISOString(), history: [] }); });
  f.app.store.revocations.dispatch({ type: 'tool_withdrawn', projectId: f.project.id, tools: [{ kind: 'skill', id: 'extra-skill', name: 'extra-skill' }] });
  await f.app.store.revocations.idle();
  assert.equal(f.gene('skill-patch:extra1').status, 'retired'); assert.match(f.said(), /它所在的技能已停用，「额外做法」也跟着停用了/);
  assert.deepEqual(f.app.genes.revocationViolations(f.current(), { type: 'tool_withdrawn', tools: [{ kind: 'skill', id: 'extra-skill' }], at: new Date().toISOString() }), []);
});

// ------------------------------------------------------- the user's latest word retires the older rule
const settle = (f, name, input, options = {}) => f.app.genes.place(f.current(), input, { signal: new AbortController().signal, ...options });
async function twoRules(f) {
  keepsRule(f.workspace);
  const userRule = f.lesson('正文里不得出现“守夜”字样。');
  const guard = await f.app.genes.routeLesson(f.current(), userRule);
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const modelRule = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'contrast', quote: '整章重写' });
  return { userRule, guard: guard.geneId, modelRule: modelRule.geneId, rules: () => f.app.genes.liveRules(f.current(), '') };
}
// A judge that finds the rules in `ids` reversed (and, as JEV does, names the first of them as the rule the content is about).
const reversing = (f, ids) => async () => { const at = f.app.genes.liveRules(f.current(), '').flatMap((row, index) => ids.includes(row.id) ? [index] : []); return { action: 'revise', index: at[0] ?? 0, contradicts: at, ledgerId: 'consolidate-1' }; };

test('placement: the user\'s newer word reverses a rule the assistant wrote — it is retired (announced, restore:false) and the new content is written on its own', async t => {
  const f = await fixture(t);
  const { modelRule } = await twoRules(f);
  f.app.genes.decisions.geneConsolidate = reversing(f, [modelRule]);
  const placed = await settle(f, 'place', '不要再整章重写了，在原稿上改就行。', { usersWord: true, at: Date.now() });
  assert.equal(placed.action, 'add', 'the rule it would have been rewritten into is gone'); assert.deepEqual(placed.retired, [modelRule]);
  assert.equal(f.gene(modelRule).status, 'retired'); assert.ok(!f.genome().skills[0].instructions.includes('整章推翻重写'));
  assert.match(f.said(), /按你刚才说的，停用了「整章重写」/);
  assert.equal(f.gene('guard:guard_nightwatch').status, 'active', 'only what it reversed');
});

test('placement: a newer word of the user retires an older rule of the user\'s; an older word never retires a newer rule — it is outranked and nothing is written', async t => {
  const f = await fixture(t);
  const { userRule, guard } = await twoRules(f);
  const ruleAt = lessonRank(f.current().mind.lessons.find(row => row.id === userRule.id));
  f.app.genes.decisions.geneConsolidate = reversing(f, [guard]);
  // The candidate is OLDER than the rule's word: the rule outranks it.
  const older = await settle(f, 'place', '「守夜」两个字可以用了。', { usersWord: true, at: ruleAt - 60000 });
  assert.deepEqual([older.action, older.target.id], ['conflict', guard]); assert.equal(f.gene(guard).status, 'active', 'nothing was retired');
  // The candidate is NEWER: the user changed their mind.
  const newer = await settle(f, 'place', '「守夜」两个字可以用了。', { usersWord: true, at: ruleAt + 60000 });
  assert.deepEqual([newer.action, newer.retired], ['add', [guard]]); assert.equal(f.gene(guard).status, 'retired'); assert.ok(!f.genome().tools.some(row => row.id === 'guard_nightwatch'), 'the check left the bundle');
  assert.match(f.said(), /按你刚才说的，停用了/);
});

test('placement: what the assistant concluded never overrides a rule in force — a lesson of the assistant\'s own, or any rule it wrote, reversing a kept rule writes nothing', async t => {
  const f = await fixture(t);
  const { guard, modelRule } = await twoRules(f);
  f.app.genes.decisions.geneConsolidate = reversing(f, [guard]);
  const outranked = await settle(f, 'place', '「守夜」两个字可以用了。', { usersWord: false });
  assert.deepEqual([outranked.action, outranked.target.id], ['conflict', guard]); assert.equal(f.gene(guard).status, 'active');
  // Even a model-written rule is not retired by a model: mu keeps what is kept unless the user said otherwise.
  f.app.genes.decisions.geneConsolidate = reversing(f, [modelRule]);
  assert.equal((await settle(f, 'place', '改成不要整章重写。', { usersWord: false })).action, 'conflict'); assert.equal(f.gene(modelRule).status, 'trial');
  // The routing of an assistant-sourced lesson says so on the lesson and writes no rule.
  let agentLesson;
  f.change(project => { agentLesson = addLesson(project.mind, { kind: 'constraint', text: '「守夜」两个字可以用了。', source: mindSource('agent', {}) }, { now: Date.now() }).id; });
  f.app.genes.decisions.geneConsolidate = reversing(f, [guard]);
  const out = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === agentLesson));
  assert.deepEqual([out.routed, out.outcome, out.with], ['guard', 'conflict', guard]);
  assert.deepEqual(f.current().mind.lessons.find(row => row.id === agentLesson).geneRoute.conflictsWith, guard);
  assert.equal(f.gene(guard).status, 'active');
});

test('a rule the model wrote on its own (lane C) that would reverse a rule in force is not written; one that only repeats or adds is', async t => {
  const f = await fixture(t);
  const { guard, modelRule } = await twoRules(f);
  const genes = () => f.current().genes.genes.map(row => row.id).sort();
  const before = genes();
  f.app.genes.decisions.geneConsolidate = async (_project, input) => ({ action: 'add', index: null, contradicts: input.contradicts ? input.existing.flatMap((row, index) => row.title === '整章重写' ? [index] : []) : [] });
  const refused = await f.patchOf({ ...PATCH_ANSWER, title: '不要整章重写', summary: '在原稿上改。', section: '- 差距大也在原稿上改，不要整章重写。' }, { kind: 'contrast', quote: '对照分析' });
  assert.equal(refused.outcome, 'conflict'); assert.deepEqual(refused.with, [modelRule]); assert.deepEqual(genes(), before, 'nothing written, nothing retired'); assert.equal(f.gene(modelRule).status, 'trial'); assert.equal(f.gene(guard).status, 'active');
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null, contradicts: [] });
  const written = await f.patchOf({ ...PATCH_ANSWER, title: '章末钩子', summary: '每章末尾留钩子。', section: '- 每章结尾留一个悬念。\n- 钩子要在后文回收。' }, { kind: 'contrast', quote: '对照分析' });
  assert.equal(written.outcome, 'trial');
});

test('a user-sourced contradiction never restores: the merged rule it reverses is retired and the rules it replaced stay gone', async t => {
  const f = await fixture(t, { patch: rewriting });
  keepsRule(f.workspace);
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const a = await f.patchOf({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' }, { kind: 'correction', quote: 'x' });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const merged = await f.patchOf({ ...PATCH_ANSWER, title: '逐章对照', summary: '每章对照参考作品。', section: '- 每写一章都对照参考作品的对应章节。' }, { kind: 'correction', quote: 'y' });
  assert.equal(f.gene(a.geneId).status, 'retired');
  f.app.genes.decisions.geneConsolidate = reversing(f, [merged.geneId]);
  const placed = await settle(f, 'place', '不要再整章重写了，也别逐章对照。', { usersWord: true, at: Date.now() });
  assert.deepEqual(placed.retired, [merged.geneId]);
  assert.deepEqual([f.gene(merged.geneId).status, f.gene(a.geneId).status], ['retired', 'retired'], 'what the merged rule had replaced stays gone');
  assert.ok(!f.genome().skills[0].instructions.includes('整章推翻重写'));
  assert.match(f.said(), /它之前替换的「整章重写」没有恢复/);
});

test('the decision service reads the reversal in two stages: a special case is not a reversal, and no answer to the second stage retires nothing', async () => {
  const { DecisionService } = await import('../decision-service.mjs');
  const calls = [];
  const answers = stage => ({ overlap: { type: 'choice', choice: 'none', probabilities: { none: .9, rule_0: .05 } }, adds: { type: 'boolean', probability: .7 }, ...stage });
  const yes = probability => ({ type: 'boolean', probability });
  let second = () => answers({ narrower_0: yes(.1) });
  const service = Object.create(DecisionService.prototype);
  Object.assign(service, { enabled: () => true, now: () => 1, record: () => {}, secrets: () => [], decide: async input => { calls.push(Object.keys(input.assessmentPlan.questions)); const asked = Object.keys(input.assessmentPlan.questions), out = asked.some(id => id.startsWith('narrower_')) ? second() : answers({ contradicts_0: yes(.95), contradicts_1: yes(.2) }); return out === null ? null : { point: 'gene.consolidate', mode: 'active', source: 'judge', backend: 'typesafe', answers: Object.fromEntries(Object.entries(out).filter(([id]) => asked.includes(id))), ledgerId: `l${calls.length}`, usage: {} }; } });
  const project = { id: 'p', name: 'x' }, input = { layer: 'request', title: '', summary: '', body: '不要整章重写', existing: [{ title: '整章重写', summary: 's' }, { title: '其他', summary: 't' }], contradicts: true };
  const reversed = await service.geneConsolidate(project, input);
  assert.deepEqual(reversed.contradicts, [0], 'a total reversal of rule 0'); assert.deepEqual(calls[1], ['overlap', 'adds', 'narrower_0'], 'the second stage asks only about the rule found reversed');
  second = () => answers({ narrower_0: yes(.8) });
  assert.deepEqual((await service.geneConsolidate(project, input)).contradicts, [], 'a special case of the rule: it stays');
  second = () => null;
  assert.deepEqual((await service.geneConsolidate(project, input)).contradicts, [], 'no second-stage answer: nothing is retired on the first alone');
  const plain = await service.geneConsolidate(project, { ...input, contradicts: false });
  assert.equal(plain.contradicts, undefined, 'a caller that did not ask reads what it read before');
});

test('GeneEvolutionService is the one that registers: its handler names the events it settles and the assertion', async t => {
  const f = await fixture(t);
  const handler = f.app.genes.revocationHandler();
  assert.deepEqual([handler.name, handler.events], ['genes', ['lesson_revoked', 'tool_withdrawn']]);
  assert.equal(typeof handler.settle, 'function'); assert.equal(typeof handler.assert, 'function');
  assert.ok(f.app.store.revocations.handlers.some(row => row.name === 'genes') && f.app.store.revocations.handlers.some(row => row.name === 'mind'), 'the server registered both');
  assert.ok(GeneEvolutionService);
});
