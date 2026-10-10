import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { PATCH_AUTHOR_SYSTEM, GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';

// Evolution that iterates instead of only growing: before a rule or check is added, JEV gene.consolidate compares it
// with the ones of its kind — add, rewrite the one it overlaps (restorable), or drop a repeat — and rules already in
// force are compared once with the older ones (a repeat retires, an overlap merges). Models and judges are stubs.
const RULE = { skillId: 'project-workflow', title: '先查原著风格', summary: '动笔前先查参考作品的整体风格。', section: '- 写章节前先查参考作品的整体风格。\n- 按查到的风格动笔。', when: '写章节', expectation: '文风贴近参考作品' };
const MERGED = { skillId: 'project-workflow', title: '先查原著风格', summary: '动笔前先读满 30 章参考作品，按其风格与节奏动笔。', section: '- 写章节前先完整读完至少 30 章参考作品。\n- 按查到的风格与推进节奏动笔，写完对照一遍。', when: '写章节', expectation: '文风和节奏贴近参考作品' };
const userInput = input => { const content = input.messages.find(row => row.role === 'user')?.content ?? '{}'; try { return JSON.parse(typeof content === 'string' ? content : content.map(part => part.text ?? '').join('')); } catch { return {}; } };
const authorRequests = calls => calls.filter(input => (input.messages.find(row => row.role === 'system')?.content ?? '').includes(PATCH_AUTHOR_SYSTEM.slice(0, 60)));

async function project(t) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(userInput(input).rewrite ? MERGED : RULE));
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(userInput(input).extend ? { ...GUARD_ANSWER, title: '「守夜」与「镇妖」字样检查', summary: '检查正文里有没有“守夜”或“镇妖”字样。' } : GUARD_ANSWER));
    stream(res, 'ok');
  });
  const judged = [], out = { verdict: () => ({ action: 'add', index: null, ledgerId: 'L-add' }) };
  f.app.genes.decisions = { geneReview: async () => ({ pass: true, problems: [] }), geneConsolidate: async (_project, input) => { judged.push(input); return out.verdict(input); } };
  const instructions = async () => (await f.app.genes.genes.activeGenome(f.current())).skills.find(row => row.id === 'project-workflow').instructions;
  const patch = async (proposal, trigger = 'correction') => { const current = f.current(), genome = await f.app.genes.genes.activeGenome(current); return f.app.genes.applyPatch(current, genome, proposal, { origin: { kind: 'correction', quote: '要先读满 30 章参考作品' }, originText: '要先读满 30 章参考作品再动笔', trigger, announce: null, signal: new AbortController().signal }); };
  return Object.assign(out, f, { judged, instructions, patch, gene: id => f.current().genes.genes.find(row => row.id === id) });
}

test('a new rule about the same thing as an existing one rewrites that rule in place; retiring the rewrite brings the old one back', async t => {
  const f = await project(t);
  const first = await f.patch(RULE);
  assert.equal(first.outcome, 'trial'); assert.equal(f.judged.length, 0, 'nothing of its kind yet: no judgment');
  const oldNote = f.gene(first.geneId).body.note;
  assert.ok((await f.instructions()).includes(oldNote)); assert.ok(f.gene(first.geneId).body.consolidatedAt === undefined, 'not compared: there was nothing to compare with');
  f.verdict = () => ({ action: 'revise', index: 0, ledgerId: 'L-rev' });
  const second = await f.patch({ ...RULE, title: '参考读满30章', summary: '参考作品至少读完 30 章再动笔。', section: '- 参考作品至少读完 30 章再动笔。' });
  assert.equal(second.outcome, 'trial'); assert.equal(second.revised, first.geneId);
  assert.deepEqual(f.judged[0].existing.map(row => row.title), ['先查原著风格'], 'the rules of its kind were sent to the judge');
  const rewrite = userInput(authorRequests(f.calls).at(-1)).rewrite;
  assert.deepEqual(rewrite.rules.map(row => row.title), ['先查原著风格'], 'the author rewrote the existing rule');
  assert.match(rewrite.rules[0].section, /\n- /, 'the rule reaches the author with its line breaks');
  const text = await f.instructions(), revised = f.gene(second.geneId);
  assert.ok(!text.includes(oldNote), 'the old text is gone'); assert.ok(text.includes(revised.body.note)); assert.equal(text.split('## 先查原著风格').length - 1, 1, 'one rule, not two');
  assert.equal(f.gene(first.geneId).status, 'retired'); assert.equal(f.gene(first.geneId).supersededBy, second.geneId);
  assert.deepEqual(revised.body.revises, [first.geneId]); assert.equal(revised.ledger.consolidate, 'L-rev'); assert.ok(revised.body.consolidatedAt);
  assert.match(f.current().genes.generations.at(-1).summary, /修订做法「先查原著风格」/);
  // An undo (restore: true) gives the replaced rule back; a drop — the default, and what 不再用 on a rule from the
  // user's words does (EVO-6) — would not (see the next test).
  await f.app.genes.genes.retireGene(f.project.id, second.geneId, { reason: '用户停用', restore: true });
  const restored = await f.instructions();
  assert.ok(restored.includes(oldNote) && !restored.includes(revised.body.note), 'the replaced rule is back');
  assert.equal(f.gene(first.geneId).status, 'trial'); assert.equal(f.gene(second.geneId).status, 'retired');
});

test('a rule that only repeats an existing one is not added; a confident "nothing overlaps" adds it', async t => {
  const f = await project(t);
  const first = await f.patch(RULE);
  const before = f.current().genes.generations.length;
  f.verdict = () => ({ action: 'skip', index: 0, ledgerId: 'L-skip' });
  const repeat = await f.patch({ ...RULE, title: '查原著文风', summary: '先查参考作品文风。' });
  assert.deepEqual([repeat.outcome, repeat.of], ['duplicate', first.geneId]);
  assert.equal(f.current().genes.generations.length, before, 'no new generation');
  f.verdict = () => ({ action: 'add', index: null, ledgerId: 'L-add' });
  const distinct = await f.patch({ ...RULE, title: '章末留钩子', summary: '每章结尾留一个悬念。', section: '- 每章结尾留一个悬念或钩子。' });
  assert.equal(distinct.outcome, 'trial'); assert.ok(f.gene(distinct.geneId).body.consolidatedAt, 'compared at the door');
});

test('rules already in force meet the older ones once: a repeat retires, an overlap merges into one rule', async t => {
  const f = await project(t);
  const older = await f.patch(RULE);
  const newer = await f.patch({ ...RULE, title: '逐句对照原著', summary: '质量不足时逐句对照参考作品。', section: '- 质量不足时逐句对照参考作品的完整章节。' });
  const third = await f.patch({ ...RULE, title: '去修辞赘句', summary: '删掉无信息量的修辞。', section: '- 删掉无信息量的修辞赘句。' });
  // Written before consolidation existed: none of them was compared.
  for (const id of [older.geneId, newer.geneId, third.geneId]) f.app.store.mutate(state => { const row = state.projects.find(p => p.id === f.project.id).genes.genes.find(g => g.id === id); delete row.body.consolidatedAt; });
  assert.equal(f.app.genes.consolidationDue(f.current())?.id, third.geneId, 'newest first');
  f.verdict = input => ({ action: 'skip', index: input.existing.findIndex(row => row.title === '先查原著风格'), ledgerId: 'L1' });
  const skipped = await f.app.genes.consolidateExisting(f.project.id, third.geneId);
  assert.equal(skipped.action, 'skip'); assert.equal(f.gene(third.geneId).status, 'retired');
  assert.ok(!(await f.instructions()).includes(f.gene(third.geneId).body.note), 'its text left the skill');
  f.verdict = input => ({ action: 'revise', index: input.existing.findIndex(row => row.title === '先查原著风格'), ledgerId: 'L2' });
  const merged = await f.app.genes.consolidateExisting(f.project.id, newer.geneId);
  assert.equal(merged.outcome, 'trial');
  const text = await f.instructions(), result = f.gene(merged.geneId);
  assert.deepEqual(result.body.revises, [older.geneId, newer.geneId]);
  assert.ok(!text.includes(f.gene(older.geneId).body.note) && !text.includes(f.gene(newer.geneId).body.note) && text.includes(result.body.note));
  assert.match(f.current().genes.generations.at(-1).summary, /合并做法「先查原著风格」「逐句对照原著」/);
  assert.equal(f.app.genes.consolidationDue(f.current()), null, 'everything compared once');
});

test('a check that repeats one in force is not added; one that catches more replaces it in place and can be undone', async t => {
  const f = await project(t);
  let lessonId;
  const lesson = text => { f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind: 'constraint' }).id; }); return f.current().mind.lessons.find(row => row.id === lessonId); };
  f.app.genes.decisions.geneRoute = async () => ({ guard: true, everyWrite: true, method: false });
  keepsRule(f.workspace);
  const first = await f.app.genes.routeLesson(f.current(), lesson('正文里不得出现“守夜”字样。'));
  assert.equal(first.outcome, 'active');
  f.verdict = () => ({ action: 'skip', index: 0 });
  const repeat = await f.app.genes.routeLesson(f.current(), lesson('不要在正文里写“守夜人”。'));
  assert.deepEqual([repeat.outcome, repeat.of], ['duplicate', first.geneId]);
  assert.equal(f.current().mind.lessons.find(row => row.id === lessonId).geneRoute.geneId, first.geneId, 'the lesson points at the check that covers it');
  f.verdict = () => ({ action: 'revise', index: 0 });
  const extended = await f.app.genes.routeLesson(f.current(), lesson('正文里也不得出现“镇妖”字样。'));
  assert.equal(extended.geneId, first.geneId, 'same check, revised in place');
  const genome = await f.app.genes.genes.activeGenome(f.current());
  assert.equal(genome.tools.filter(row => row.id === 'guard_nightwatch').length, 1);
  assert.equal(f.gene(first.geneId).title, '「守夜」与「镇妖」字样检查'); assert.ok(f.gene(first.geneId).body.before.tool);
  assert.match(f.current().genes.generations.at(-1).summary, /修改检查「守夜」字样检查/);
  await f.app.genes.genes.retireGene(f.project.id, first.geneId, { reason: '用户停用', restore: true });
  assert.equal(f.gene(first.geneId).title, '「守夜」字样检查', 'undone, the check is back to what it was'); assert.notEqual(f.gene(first.geneId).status, 'retired');
  assert.equal((await f.app.genes.genes.activeGenome(f.current())).tools.filter(row => row.id === 'guard_nightwatch').length, 1);
});

test('rules checked under an earlier consolidation judgment are compared once more', async t => {
  const { CONSOLIDATE_VERSION } = await import('../gene-evolution-service.mjs');
  const f = await project(t);
  const older = await f.patch(RULE), newer = await f.patch({ ...RULE, title: '逐句对照原著', summary: '质量不足时逐句对照参考作品。', section: '- 质量不足时逐句对照参考作品的完整章节。' });
  f.app.store.mutate(state => { const row = state.projects.find(p => p.id === f.project.id).genes.genes.find(g => g.id === newer.geneId); row.body.consolidatedAt = new Date().toISOString(); delete row.body.consolidateVersion; });
  assert.equal(f.app.genes.consolidationDue(f.current())?.id, newer.geneId, 'a v1 check is due again');
  await f.app.genes.consolidateExisting(f.project.id, newer.geneId);
  assert.equal(f.gene(newer.geneId).body.consolidateVersion, CONSOLIDATE_VERSION);
  assert.equal(f.app.genes.consolidationDue(f.current()), null);
  void older;
});

test('a rewrite that softens a requirement of the rule it replaces goes back to the author once, with the reason', async t => {
  const f = await project(t);
  const first = await f.patch(RULE);
  const reviews = [];
  f.app.genes.decisions.geneReview = async (_project, input) => { reviews.push(input); return input.replaced?.length && reviews.length === 1 ? { pass: false, problems: ['keeps_replaced'] } : { pass: true, problems: [] }; };
  f.verdict = () => ({ action: 'revise', index: 0 });
  const out = await f.patch({ ...RULE, title: '参考读满30章', summary: '参考作品至少读完 30 章再动笔。', section: '- 参考作品至少读完 30 章再动笔。' });
  assert.equal(out.outcome, 'trial'); assert.equal(out.revised, first.geneId);
  assert.deepEqual(reviews[0].replaced.map(row => row.title), ['先查原著风格'], 'the review sees what the rewrite replaces');
  const asked = authorRequests(f.calls).map(userInput).filter(input => input.rewrite);
  assert.equal(asked.length, 2, 'one revision');
  assert.match(asked[1].review.problems.join(' '), /softens, drops or makes optional a requirement/);
});

test('announcements about the same rules update one message: a merge, its undo and the redo do not pile up', async t => {
  const f = await project(t);
  const older = await f.patch(RULE), newer = await f.patch({ ...RULE, title: '逐句对照原著', summary: '质量不足时逐句对照参考作品。', section: '- 质量不足时逐句对照参考作品的完整章节。' });
  const unmark = id => f.app.store.mutate(state => { const row = state.projects.find(p => p.id === f.project.id).genes.genes.find(g => g.id === id); delete row.body.consolidatedAt; delete row.body.consolidateVersion; });
  unmark(older.geneId); unmark(newer.geneId);
  const messages = () => f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative' && item.initiative?.topic?.startsWith('rules:'));
  f.verdict = input => ({ action: 'revise', index: input.existing.findIndex(row => row.title === '先查原著风格') });
  const merged = await f.app.genes.consolidateExisting(f.project.id, newer.geneId);
  f.app.genes.deliverAnnouncements();
  assert.equal(messages().length, 1); assert.match(messages()[0].text, /合成了一条/);
  await f.app.genes.retireByUser(f.project.id, merged.geneId);
  f.app.genes.deliverAnnouncements();
  assert.equal(messages().length, 1, 'the undo updates the same message'); assert.match(messages()[0].text, /^已撤销「先查原著风格」，恢复了原来的做法/);
  unmark(newer.geneId);
  await f.app.genes.consolidateExisting(f.project.id, newer.geneId);
  f.app.genes.deliverAnnouncements();
  assert.equal(messages().length, 1, 'the redo too'); assert.match(messages()[0].text, /合成了一条/); assert.ok(messages()[0].revisedAt);
});

// User, 2026-10-02: "把所有进化系统中的标题和新发送内容交给 jev 做一次判断…在调用模型之前做". The correction and every rule in
// force (skills and checks, by title and summary) are judged once, before any author call.
test('a correction is placed among every rule in force before any model writes: covered → no author call; overlapping → one rewrite; new → one author call and one judgment', async t => {
  const f = await project(t);
  f.app.genes.decisions.turnReview = async () => ({ review: true, ledgerId: 'L-review' });
  const first = await f.patch(RULE);
  f.app.store.mutate(state => { const p = state.projects.find(row => row.id === f.project.id); p.genes.genes.push({ id: 'guard:g1', layer: 'guard', status: 'active', title: '「守夜」字样检查', summary: '检查正文里有没有“守夜”字样。', body: { toolId: 'guard_x' } }); });
  const review = correction => f.app.genes.reviewTurn(f.project.id, { request: '写第三章', reply: '写好了。', correction });
  // Covered: nothing is written.
  f.judged.length = 0; let authors = authorRequests(f.calls).length;
  f.verdict = () => ({ action: 'skip', index: 0, ledgerId: 'L-skip' });
  const covered = await review('写之前先查一下原著的风格');
  assert.deepEqual([covered.outcome, covered.of], ['duplicate', first.geneId]);
  assert.equal(authorRequests(f.calls).length, authors, 'no author call for a rule already in force');
  assert.deepEqual(f.judged[0].existing.map(row => row.title).sort(), ['「守夜」字样检查', '先查原著风格'].sort(), 'every rule in force, skills and checks, by title');
  assert.equal(f.judged[0].body, '写之前先查一下原著的风格');
  assert.match(f.judged[0].existing.find(row => row.title === '先查原著风格').body, /写章节前先查参考作品的整体风格/, 'each rule goes with its text');
  // Overlapping: the rule in force is rewritten in one author call.
  f.judged.length = 0; authors = authorRequests(f.calls).length;
  f.verdict = input => ({ action: 'revise', index: input.existing.findIndex(row => row.title === '先查原著风格'), ledgerId: 'L-rev' });
  const revised = await review('要先读满 30 章参考作品再动笔');
  assert.equal(revised.outcome, 'trial'); assert.equal(revised.revised, first.geneId);
  assert.equal(authorRequests(f.calls).length, authors + 1, 'one author call: the rewrite');
  assert.ok(userInput(authorRequests(f.calls).at(-1)).rewrite, 'the call rewrote the rule in force');
  assert.equal(f.judged.length, 1, 'one judgment');
  // New: one author call, one judgment (not repeated on the written text).
  f.judged.length = 0; authors = authorRequests(f.calls).length;
  f.verdict = () => ({ action: 'add', index: null, ledgerId: 'L-add' });
  const added = await review('每章结尾留一个钩子');
  assert.equal(added.outcome, 'trial'); assert.equal(authorRequests(f.calls).length, authors + 1); assert.equal(f.judged.length, 1);
  assert.equal(f.gene(added.geneId).ledger.consolidate, 'L-add');
});
