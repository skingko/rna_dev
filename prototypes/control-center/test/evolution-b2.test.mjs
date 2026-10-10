import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, GUARD_SCRIPT, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { sourceScope, revokeGeneSources } from '../source-revocation.mjs';
import { geneTree, matchingFiles, globCanEnter, GENOME_TOOL_LIMIT, GUARD_FILE_BYTES, GUARD_RUN_FILE_BYTES } from '../project-genes.mjs';
import { GENOME_READ_LIMIT_BYTES } from '../../../packages/sdk/src/project-genome.mjs';
import { GeneEvolutionService, GUARD_AUTHOR_SYSTEM, PATCH_AUTHOR_SYSTEM, GUARD_ROUTE_VERSION } from '../gene-evolution-service.mjs';

// P2 batch B2 (docs/research/reference-alignment-20261005.md §2.2): evolution prerequisites and retirement semantics.
// EVO-7 re-judging, EVO-5 zero-match trial, EVO-10 typed author outcomes and interrupted checks, EVO-9 persisted reviews
// and announcements, EVO-13 evidence levels, EVO-6 undo/drop/contradicted, lane C infrastructure failures, the tool-slot
// cap, the measured tried list and the project instruction file as "already covered". Judges and models are stubs.
const PATCH_ANSWER = { skillId: 'project-workflow', title: '先核对伏笔', summary: '写新章前先核对前文伏笔。', section: '- 写新章前，先列出本章要呼应的前文细节。\n- 每个呼应点都要能在前文找到出处。', when: '写新章节', expectation: '不再引用没铺垫过的情节' };
const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
const systemOf = input => textOf(input.messages.find(row => row.role === 'system')?.content);
/** A patch author that writes a rewrite as one rule holding every replaced section (and one more line). */
const rewriting = input => { const data = JSON.parse(textOf(input.messages.find(row => row.role === 'user').content)); return data.rewrite ? { ...PATCH_ANSWER, title: `${data.rewrite.rules[0].title}·合`, summary: '合并后的做法。', section: `${data.rewrite.rules.map(row => row.section).join('\n')}\n- 合并后每章再自查一遍。` } : PATCH_ANSWER; };

async function fixture(t, { guard = () => GUARD_ANSWER, patch = () => PATCH_ANSWER } = {}) {
  const authors = { guard: 0, patch: 0 };
  const f = await setup(t, (input, res) => {
    const system = systemOf(input);
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) { authors.guard++; const answer = guard(input); if (answer === 500) { res.writeHead(500); return res.end('{}'); } return stream(res, JSON.stringify(answer)); }
    if (system.includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))) { authors.patch++; const answer = patch(input); if (answer === 500) { res.writeHead(500); return res.end('{}'); } return stream(res, JSON.stringify(answer)); }
    stream(res, 'ok');
  });
  f.app.genes.enabled = true;
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, checkable: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  const lesson = (text, kind = 'constraint') => { let id; f.app.store.mutate(state => { id = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind }).id; }); return f.current().mind.lessons.find(row => row.id === id); };
  const gene = id => f.current().genes.genes.find(row => row.id === id);
  const genome = () => f.current().versions.find(row => row.id === f.current().activeVersionId).bundle.genome;
  const conversation = () => f.app.store.state.sessions.find(row => row.id === f.session.id);
  const turn = (text, { status = 'completed', items = [] } = {}) => {
    const turnId = randomUUID(), userItemId = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status, userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false }, ...items.map(item => ({ id: randomUUID(), turnId, createdAt: at, simulated: false, ...item })), { id: randomUUID(), turnId, kind: 'assistant', text: `回复：${text}`, final: true, createdAt: at, simulated: false }); });
    return turnId;
  };
  const said = () => conversation().items.filter(item => item.source === 'initiative').map(item => item.text);
  // The same store read by a new service, as the app's next start does.
  const restart = (options = {}) => { const next = new GeneEvolutionService(f.app.store, { decisions: f.app.genes.decisions, mind: f.app.genes.mind, enabled: true, ...options }); next.invitations = f.app.genes.invitations; t.after(() => next.close()); return next; };
  return { ...f, authors, lesson, gene, genome, conversation, turn, said, restart };
}

test('EVO-7: a check routed under an older gene.route is asked once more; "not checkable" offers its retirement, and retired, its rule is written as a practice', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const echo = f.lesson('写新章节前先核对前文细节，确保每个呼应点都有前文伏笔。', 'pitfall');
  const grown = await f.app.genes.routeLesson(f.current(), echo);
  assert.equal(grown.geneId, 'guard:guard_nightwatch'); assert.equal(f.gene(grown.geneId).body.routeVersion, GUARD_ROUTE_VERSION, 'a new check carries the template it was judged under');
  assert.equal(f.app.genes.rerouteDue(f.current()), null, 'judged under the current template: not asked again');
  // As it was before v5: no routeVersion.
  f.app.genes.genes.record(f.project.id, grown.geneId, row => { delete row.body.routeVersion; });
  const asked = [];
  f.app.genes.decisions.geneRoute = async (_project, input) => { asked.push(input.text); return { guard: false, checkable: false, everyWrite: false, method: true, periodic: false, ledgerId: 'route-v5' }; };
  const job = f.app.genes.housekeeping();
  assert.equal(typeof job, 'function', 'the re-ask is idle work, ahead of the rest');
  const out = await job();
  assert.deepEqual(out, { checkable: false, offered: true }); assert.deepEqual(asked, [echo.text], 'its own rule, once');
  const checked = f.gene(grown.geneId);
  assert.equal(checked.body.routeVersion, GUARD_ROUTE_VERSION); assert.equal(checked.body.reroute.checkable, false); assert.equal(checked.status, 'active', 'only the user retires it');
  assert.equal(f.app.genes.rerouteDue(f.current()), null, 'asked once');
  const invitation = f.conversation().invitations.find(row => row.kind === 'gene');
  assert.deepEqual([invitation.geneId, invitation.usage, invitation.ledgerId], [grown.geneId, 'not_checkable', 'route-v5']);
  assert.equal(geneTree(f.current()).strands.find(row => row.layer === 'guard').genes[0].notCheckable, true);
  // The user agrees: the check leaves, and the rule comes back to lane A as a practice (written into the skill).
  f.app.genes.attempted.clear();
  await f.app.genes.answerRetirement(f.project.id, grown.geneId, 'retire');
  assert.equal(f.gene(grown.geneId).status, 'retired'); assert.ok(!f.genome().tools.some(row => row.id === 'guard_nightwatch'));
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === echo.id), 'its lesson is due again, as a practice');
  const practice = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === echo.id));
  assert.equal(practice.routed, 'practice'); assert.equal(practice.outcome, 'trial');
  assert.match(f.genome().skills[0].instructions, /## 先核对伏笔/);
  assert.equal(f.current().mind.lessons.find(row => row.id === echo.id).geneRoute.geneId, practice.geneId);
});

test('EVO-7: a check the user confirmed is re-judged but not offered for retirement; an unsure verdict changes nothing', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  f.app.genes.genes.record(f.project.id, grown.geneId, row => { delete row.body.routeVersion; row.confirmedAt = new Date().toISOString(); row.confirmations = 1; });
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, checkable: false, method: true });
  assert.deepEqual(await f.app.genes.rerouteGuard(f.project.id, grown.geneId), { checkable: false, offered: false });
  assert.equal((f.conversation().invitations ?? []).filter(row => row.kind === 'gene').length, 0);
  f.app.genes.genes.record(f.project.id, grown.geneId, row => { delete row.body.routeVersion; delete row.confirmedAt; delete row.confirmations; });
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, checkable: null, method: true });
  assert.deepEqual(await f.app.genes.rerouteGuard(f.project.id, grown.geneId), { checkable: null });
  assert.equal((f.conversation().invitations ?? []).filter(row => row.kind === 'gene').length, 0, 'doubt asks nobody');
});

test('EVO-5: a new check is tried on the most recently written files; matchingFiles ranks by recency over a bounded walk', async t => {
  const f = await fixture(t);
  const dir = join(f.workspace, '正文', '卷一');
  // Forty-five compliant chapters, written long ago; the newest one (alphabetically last) breaks the rule.
  for (let index = 1; index <= 45; index++) { const path = join(dir, `第${String(index).padStart(3, '0')}章.md`); writeFileSync(path, index === 45 ? '第四十五章\n守夜人又出现了。\n' : `第${index}章\n夜巡者站在城墙上。\n`); const at = new Date(Date.now() - (index === 45 ? 0 : (50 - index) * 86400000)); utimesSync(path, at, at); }
  const gene = { body: { trigger: { onWrite: ['正文/**/*.md'] } } };
  assert.ok(!(await matchingFiles(f.workspace, gene)).includes('正文/卷一/第045章.md'), 'alphabetically, the newest chapter is past the bound');
  assert.equal((await matchingFiles(f.workspace, gene, { recent: true }))[0], '正文/卷一/第045章.md', 'by recency it comes first');
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  assert.equal(grown.outcome, 'trial'); assert.deepEqual(grown.hits.map(row => row.path), ['正文/卷一/第045章.md'], 'the newest chapter was checked');
});

test('EVO-5: a large build or cache folder that sorts first does not hide the files a check matches, nor put a working check on trial', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  // 4100 cache files under .next (they sort before 正文) and 4100 non-matching ones under build/.
  for (const [folder, extension] of [[join('.next', 'cache'), 'md'], ['build', 'js']]) { mkdirSync(join(f.workspace, folder), { recursive: true }); for (let index = 0; index < 4100; index++) writeFileSync(join(f.workspace, folder, `c${index}.${extension}`), 'x'); }
  const chapters = { body: { trigger: { onWrite: ['正文/**/*.md'] } } }, everyMarkdown = { body: { trigger: { onWrite: ['**/*.md'] } } };
  assert.ok((await matchingFiles(f.workspace, chapters, { recent: true })).includes('正文/卷一/第001章.md'), 'folders the trigger cannot match are not walked');
  const markdown = await matchingFiles(f.workspace, { body: { trigger: { onWrite: ['正文/**/*.md', 'build/**/*.md'] } } }, { recent: true });
  assert.ok(markdown.includes('正文/卷一/第001章.md'), 'non-matching files do not use up the bound');
  assert.equal((await matchingFiles(f.workspace, everyMarkdown, { limit: 1 })).length, 1);
  // The glob's literal leading folders decide where the walk goes.
  assert.deepEqual([globCanEnter('正文/**/*.md', '正文'), globCanEnter('正文/**/*.md', '正文/卷一'), globCanEnter('正文/**/*.md', '.next'), globCanEnter('正文/*.md', '正文/卷一'), globCanEnter('*.md', 'build'), globCanEnter('**/*.md', '.next/cache'), globCanEnter('正文/第?卷/*.md', '正文/第1卷'), globCanEnter('正文/第?卷/*.md', '正文/附录')], [true, true, false, false, false, true, true, false]);
  // A new check is tried on the chapter and goes active; an older active check that never ran finds it and stays active.
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  assert.equal(grown.outcome, 'active'); assert.equal(f.gene(grown.geneId).body.matched, 1);
  f.app.genes.genes.record(f.project.id, grown.geneId, row => { delete row.body.matched; row.runs = 0; });
  assert.deepEqual(await f.app.genes.checkMatches(f.project.id, grown.geneId), { matched: 1 });
  assert.equal(f.gene(grown.geneId).status, 'active');
});

test('W3: a check is tried on the files it can read: a chapter over the old 64,000 byte read bound is one, a file over the read limit is not', async t => {
  const f = await fixture(t);
  const dir = join(f.workspace, '正文', '卷一'), gene = { body: { trigger: { onWrite: ['正文/**/*.md'] } } };
  // The project's one chapter is 100,000 bytes and breaks the rule; a 1 MiB + 1 byte file also matches the trigger.
  writeFileSync(join(dir, '第001章.md'), `第一章\n守夜人站在城墙上。\n${'夜巡者在走。\n'.repeat(5500)}`);
  writeFileSync(join(dir, '第002章.md'), 'x'.repeat(GENOME_READ_LIMIT_BYTES + 1));
  assert.ok(readFileSync(join(dir, '第001章.md')).length > GUARD_FILE_BYTES && readFileSync(join(dir, '第001章.md')).length <= GENOME_READ_LIMIT_BYTES);
  assert.equal(GUARD_RUN_FILE_BYTES, GENOME_READ_LIMIT_BYTES, 'a check is run on what it can read');
  assert.deepEqual(await matchingFiles(f.workspace, gene, { recent: true }), [], 'the list of names keeps its own bound');
  assert.deepEqual(await matchingFiles(f.workspace, gene, { recent: true, maxBytes: GUARD_RUN_FILE_BYTES }), ['正文/卷一/第001章.md'], 'the file a check can read is a file it is tried on; the one it could not read is not');
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  assert.equal(grown.outcome, 'trial', JSON.stringify(grown));
  assert.deepEqual(grown.hits.map(row => row.path), ['正文/卷一/第001章.md'], 'it was run on the chapter and found the rule broken');
  assert.equal(f.gene(grown.geneId).body.matched, 1);
  assert.equal(f.gene(grown.geneId).existingHits?.total, 1, 'the hit counts as an existing one, which the user is asked about');
  // The same chapter is a file the check matches, and "does any file match" says so (it was "nothing matches yet" at 64,000).
  f.app.genes.genes.record(f.project.id, grown.geneId, row => { delete row.body.matched; row.runs = 0; row.status = 'active'; });
  assert.deepEqual(await f.app.genes.checkMatches(f.project.id, grown.geneId), { matched: 1 });
  assert.equal(f.gene(grown.geneId).status, 'active');
});

test('EVO-10: an author that could not answer is retried later with backoff; one that chose to skip is final', async t => {
  let mode = 500;
  const f = await fixture(t, { guard: () => mode === 500 ? 500 : GUARD_ANSWER, patch: () => mode === 'skip' ? { skip: true } : PATCH_ANSWER });
  keepsRule(f.workspace);
  const rule = f.lesson('正文里不得出现“守夜”字样。');
  const failed = await f.app.genes.routeLesson(f.current(), rule);
  assert.deepEqual([failed.outcome, failed.retryable], ['author_error', true]);
  const route = () => f.current().mind.lessons.find(row => row.id === rule.id).geneRoute;
  assert.deepEqual([route().retry.code, route().retry.attempts], ['author_error', 0]);
  assert.equal(f.current().genes.funnel.A.guard_author_error, 1, 'counted apart from a skip');
  assert.equal(f.app.genes.pending().some(row => row.lesson.id === rule.id), false, 'not right away');
  const start = Date.now();
  f.app.genes.now = () => start + 31 * 60000;
  assert.ok(f.app.genes.pending().some(row => row.lesson.id === rule.id), 'due after the pause (it used to be dropped for good)');
  mode = 'ok';
  const grown = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === rule.id));
  assert.equal(grown.outcome, 'active'); assert.equal(route().retry, undefined, 'a written rule clears the retry'); assert.equal(route().geneId, grown.geneId);
  // A judged skip (the author found nothing to write): final, no retry.
  f.app.genes.now = Date.now; mode = 'skip';
  const other = f.lesson('写新章前先核对前文伏笔。', 'pitfall');
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, checkable: false, everyWrite: false, method: true });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const skipped = await f.app.genes.routeLesson(f.current(), other);
  assert.equal(skipped.outcome, 'author_skipped'); assert.equal(f.current().mind.lessons.find(row => row.id === other.id).geneRoute.retry, undefined);
});

test('EVO-10 at startup: a check left "testing" by a stopped process becomes rejected{interrupted, retryable} and its rule is retried; an old in-place revision gives the check back', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  const orphan = f.lesson('正文里不得出现“镇妖”字样。');
  const old = new Date(Date.now() - 60000).toISOString();
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    project.genes.genes.push({ id: 'guard:guard_orphan', layer: 'guard', key: 'guard_orphan', title: '「镇妖」字样检查', status: 'testing', origin: { kind: 'lesson', lessonId: orphan.id }, body: { toolId: 'guard_orphan' }, createdAt: old, updatedAt: old, history: [] });
    // The extended check as the previous code left it mid-revision: its own row overwritten with 'testing'.
    const live = project.genes.genes.find(row => row.id === grown.geneId);
    Object.assign(live, { title: '「守夜」与「镇妖」字样检查', status: 'testing', updatedAt: old, body: { toolId: 'guard_nightwatch', trigger: { onWrite: ['正文/**/*.md'] }, before: { tool: { id: 'guard_nightwatch' }, note: null, skillId: 'project-workflow', record: { title: '「守夜」字样检查', summary: live.summary, status: 'active', level: 0, stats: null, body: { ...live.body } } } } });
    // A check in force that never ran on anything, and one the user confirmed.
    project.genes.genes.push({ id: 'guard:guard_idle', layer: 'guard', key: 'guard_idle', title: '空检查', status: 'active', runs: 0, body: { toolId: 'guard_idle' }, createdAt: old, updatedAt: old, history: [] },
      { id: 'guard:guard_kept', layer: 'guard', key: 'guard_kept', title: '确认过的检查', status: 'active', runs: 0, confirmedAt: old, confirmations: 1, body: { toolId: 'guard_kept' }, createdAt: old, updatedAt: old, history: [] },
      { id: 'skill-patch:loud', layer: 'skill', key: 'loud', title: '静默升级的做法', status: 'active', level: 5, stats: { clean: 15, missed: 0, real: 0, falseMatches: 0 }, body: { skillId: 'project-workflow' }, createdAt: old, updatedAt: old, history: [] });
  });
  const next = f.restart();
  next.recoverAtStart();
  const orphaned = f.gene('guard:guard_orphan');
  assert.equal(orphaned.status, 'rejected'); assert.deepEqual([orphaned.rejection.code, orphaned.rejection.retryable], ['interrupted', true]);
  assert.match(orphaned.history.at(-1).note, /验证被中断/);
  assert.equal(f.current().mind.lessons.find(row => row.id === orphan.id).geneRoute.retry.code, 'interrupted', 'its rule is tried again later');
  const restored = f.gene(grown.geneId);
  assert.deepEqual([restored.title, restored.status], ['「守夜」字样检查', 'active'], 'the check in the bundle is in force again');
  assert.equal(f.gene('skill-patch:loud').level, 0, 'levels read evidence, not silence (EVO-13)');
  // EVO-5 for checks made active before it: idle work looks for matching files once (the one made now recorded its own).
  assert.equal(restored.body.matched, 1);
  const job = next.housekeeping(); assert.equal(typeof job, 'function');
  f.app.genes.genes.record(f.project.id, 'guard:guard_idle', row => { row.body.routeVersion = GUARD_ROUTE_VERSION; });
  f.app.genes.genes.record(f.project.id, 'guard:guard_kept', row => { row.body.routeVersion = GUARD_ROUTE_VERSION; });
  assert.deepEqual(await next.checkMatches(f.project.id, 'guard:guard_idle'), { matched: 0 });
  assert.equal(f.gene('guard:guard_idle').status, 'trial', 'nothing matches it: on trial, shown as not run yet');
  assert.match(f.gene('guard:guard_idle').history.at(-1).note, /还没运行过，退回试用/);
  assert.equal(f.gene('guard:guard_kept').status, 'active', 'the user confirmed it');
  assert.equal(geneTree(f.current()).strands.find(row => row.layer === 'guard').genes.find(row => row.id === 'guard:guard_idle').runs, 0);
});

test('EVO-6: a check being extended keeps running; a rejected revision is recorded beside it, never over it', async t => {
  // The revision's script finds nothing, so its violating sample fails the program check.
  const f = await fixture(t, { guard: input => JSON.parse(textOf(input.messages.find(row => row.role === 'user').content)).extend ? { ...GUARD_ANSWER, title: '「守夜」与「镇妖」字样检查', tool: { ...GUARD_ANSWER.tool, script: "await api.readFile(input.path); return { hits: [], summary: 'none' };" } } : GUARD_ANSWER });
  keepsRule(f.workspace);
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const extended = await f.app.genes.routeLesson(f.current(), f.lesson('正文里也不得出现“镇妖”字样。'));
  assert.deepEqual([extended.outcome, extended.code], ['rejected', 'smoke_failed'], 'the revision failed its program check');
  const live = f.gene(grown.geneId);
  assert.equal(live.status, 'active', 'the check in force was not touched'); assert.equal(live.title, '「守夜」字样检查');
  assert.deepEqual([live.extension.status, live.extension.code], ['rejected', 'smoke_failed']);
  assert.equal(geneTree(f.current()).strands.find(row => row.layer === 'guard').genes.length, 1);
});

test('EVO-6: 不再用 on a revised rule drops it without restoring what it replaced, and says so; undoing a merge restores', async t => {
  const f = await fixture(t, { patch: rewriting });
  const current = () => f.current(), patch = async (proposal, origin = { kind: 'correction', quote: '要先核对伏笔' }) => f.app.genes.applyPatch(current(), await f.app.genes.genes.activeGenome(current()), proposal, { origin, originText: origin.quote, trigger: 'correction', announce: null, signal: new AbortController().signal });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const first = await patch(PATCH_ANSWER);
  const oldNote = f.gene(first.geneId).body.note;
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  // The user's correction adds to the rule: it is rewritten in place (the rewrite holds the old rule's text too).
  const second = await patch({ ...PATCH_ANSWER, title: '伏笔先落盘', summary: '写新章前把伏笔清单写进文件。', section: '- 写新章前，把要呼应的伏笔写进伏笔清单文件。' });
  assert.equal(second.revised, first.geneId);
  await f.app.genes.retireByUser(f.project.id, second.geneId);
  const instructions = f.genome().skills[0].instructions;
  assert.ok(!instructions.includes(oldNote), 'the rule it replaced does not come back (it may hold what the user no longer wants)');
  assert.equal(f.gene(first.geneId).status, 'retired');
  const announced = f.app.genes.announcements.map(row => row.text).concat(f.said()).join('\n');
  assert.match(announced, /「先核对伏笔·合」不再用了/); assert.match(announced, /它之前替换的「先核对伏笔」没有恢复/);
  // A merge of two rules (consolidation) is undone: what it replaced comes back.
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const third = await patch({ ...PATCH_ANSWER, title: '章末留钩子', summary: '每章结尾留一个钩子。', section: '- 每章结尾留一个悬念或钩子。' });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const merged = await patch({ ...PATCH_ANSWER, title: '章末钩子与伏笔', summary: '合并。', section: '- 每章结尾留钩子，钩子要在后文回收。' }, { kind: 'consolidation', quote: '合并' });
  assert.equal(merged.revised, third.geneId);
  await f.app.genes.retireByUser(f.project.id, merged.geneId);
  assert.ok(f.genome().skills[0].instructions.includes(f.gene(third.geneId).body.note), 'undoing a consolidation gives the earlier rule back');
  assert.equal(f.gene(third.geneId).status, 'trial');
});

test('EVO-6: 不再用 on an extended check removes it whole — the earlier version does not run again — and the conversation is told', async t => {
  const f = await fixture(t, { guard: input => JSON.parse(textOf(input.messages.find(row => row.role === 'user').content)).extend ? { ...GUARD_ANSWER, title: '「守夜」与「镇妖」字样检查', summary: '检查正文里有没有“守夜”或“镇妖”字样。' } : GUARD_ANSWER });
  keepsRule(f.workspace);
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  await f.app.genes.routeLesson(f.current(), f.lesson('正文里也不得出现“镇妖”字样。'));
  assert.ok(f.gene(grown.geneId).body.before.tool, 'extended in place');
  const revoked = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${encodeURIComponent(grown.geneId)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal(f.gene(grown.geneId).status, 'retired', 'not reverted to the earlier check');
  assert.ok(!f.genome().tools.some(row => row.id === 'guard_nightwatch'), 'its tool left the bundle');
  assert.ok(!/自动检查/.test(f.genome().skills[0].instructions), 'and its note left the skill');
  const announced = f.app.genes.announcements.map(row => row.text).concat(f.said()).join('\n');
  assert.match(announced, /「「守夜」与「镇妖」字样检查」不再用了|「守夜」与「镇妖」字样检查不再用了/); assert.match(announced, /这项检查之前的版本也不再运行/);
});

test('EVO-6 contradicted: the user reverses a merged rule; it is retired and nothing it replaced comes back (a user contradiction never restores)', async t => {
  const f = await fixture(t, { patch: rewriting });
  const current = () => f.current(), patch = async proposal => f.app.genes.applyPatch(current(), await f.app.genes.genes.activeGenome(current()), proposal, { origin: { kind: 'correction', quote: 'x' }, originText: 'x', trigger: 'correction', announce: null, signal: new AbortController().signal });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const a = await patch({ ...PATCH_ANSWER, title: '整章重写', summary: '差距大就整章重写。', section: '- 与参考差距大时整章推翻重写。' });
  const b = await patch({ ...PATCH_ANSWER, title: '逐章对照', summary: '每章对照参考作品。', section: '- 每写一章都对照参考作品的对应章节。' });
  const merged = await f.app.genes.rewriteRule(current(), await f.app.genes.genes.activeGenome(current()), { replaces: [f.gene(a.geneId), f.gene(b.geneId)], correction: 'merge', origin: { kind: 'correction', quote: 'merge' }, originText: 'merge', trigger: 'correction', signal: new AbortController().signal });
  assert.equal(merged.outcome, 'trial');
  // The merged rule was loaded in the last turn; the user's next message reverses "整章重写".
  const previous = f.turn('写第 3 章', { items: [{ kind: 'tool', tool: { name: 'skill_load', args: { id: 'project-workflow' }, status: 'completed' } }] });
  const reversing = f.turn('不要再整章重写了，在原稿上改就行');
  // A judge that would also call the second earlier rule compatible with the reversal (a "no" on contradicts_1): an
  // unmeasured judgment, so it must not bring anything back (plan §1.3 F, C4 row: a user contradiction is restore:false).
  const asked = [];
  f.app.genes.decisions.mindJudge = async (_project, input) => { asked.push(input); return { same: [], contradicts: [0], applies: [], notApplies: [], resolved: [], ...(input.lessons.length > 1 ? { notContradicts: [1] } : {}) }; };
  f.app.genes.decisions.turnReview = async () => ({ review: false });
  const outcome = await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: reversing, record: { correction: true }, text: '不要再整章重写了，在原稿上改就行' });
  void previous;
  assert.deepEqual(outcome.retired, [merged.geneId]);
  assert.equal(asked.length, 1, 'one judgment on the rules used; the earlier rules are not judged to be brought back');
  assert.equal(f.gene(merged.geneId).status, 'retired');
  const instructions = f.genome().skills[0].instructions;
  assert.ok(!instructions.includes(f.gene(merged.geneId).body.note), 'the merged rule left the skill');
  assert.ok(!instructions.includes(f.gene(a.geneId).body.note), 'the contradicted requirement does not come back');
  assert.ok(!instructions.includes(f.gene(b.geneId).body.note), 'nor does the other rule it replaced');
  assert.deepEqual([f.gene(a.geneId).status, f.gene(b.geneId).status], ['retired', 'retired']);
  const announced = f.app.genes.announcements.map(row => row.text).concat(f.said()).join('\n');
  assert.match(announced, /按你刚才说的，停用了/); assert.match(announced, /它之前替换的「整章重写」「逐章对照」没有恢复/); assert.doesNotMatch(announced, /恢复了/);
});

test('EVO-9: every correction is reviewed, also inside lane B\'s cooldown; the queue and its cooldown survive a restart; waiting corrections are written newest first, one per cooldown, none dropped', async t => {
  let n = 0;
  const f = await fixture(t, { patch: () => ({ ...PATCH_ANSWER, title: `伏笔规则${++n}` }) });
  const reviewed = [];
  Object.assign(f.app.genes.decisions, { turnReview: async (_project, input) => { reviewed.push(input.correction); return input.correction.includes('JEV 不在') ? null : { review: true, method: true, covered: false, ledgerId: `tr-${reviewed.length}` }; }, mindJudge: async () => ({ same: [], contradicts: [], applies: [], resolved: [] }), geneConsolidate: async () => ({ action: 'add', index: null }) });
  const correct = async text => { f.turn('写一章'); const next = f.turn(text); await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text }); };
  await correct('伏笔又没铺垫就用了');
  const first = await f.app.genes.jobs.shift()();
  assert.equal(first.outcome, 'trial', JSON.stringify(first)); assert.equal(f.authors.patch, 1);
  // Two more corrections inside the cooldown: both are judged (they used to be dropped before any review).
  await correct('人物又没铺垫就出场了'); await correct('又是没有铺垫的道具');
  for (const job of f.app.genes.jobs.splice(0)) await job();
  assert.deepEqual(reviewed, ['伏笔又没铺垫就用了', '人物又没铺垫就出场了', '又是没有铺垫的道具']);
  assert.equal(f.authors.patch, 1, 'the author call waits for the cooldown');
  assert.deepEqual(f.current().genes.reviews.map(row => row.status), ['awaiting_author', 'awaiting_author']);
  assert.equal(f.current().genes.funnel.B.cooldown, undefined, 'nothing is dropped for pacing');
  // One JEV could not judge: kept, asked again later.
  await correct('JEV 不在的时候的纠正'); await f.app.genes.jobs.shift()();
  assert.equal(f.current().genes.reviews.find(row => row.status === 'pending').attempts, 1);
  // The app restarts: the queue is in the project and the cooldown is read back.
  const next = f.restart(), start = Date.now();
  next.recoverAtStart();
  assert.equal(next.reviewJob(), null, 'still inside the cooldown; the unjudged one waits for its backoff');
  next.now = () => start + 31 * 60000;
  const judge = next.reviewJob(); assert.equal(typeof judge, 'function'); await judge();
  assert.equal(reviewed.length, 5, 'the unjudged correction is asked again after the restart (still no judge: kept, with a longer pause)');
  const author = next.reviewJob(); assert.equal(typeof author, 'function', 'the cooldown is over');
  const written = await author();
  assert.equal(written.outcome, 'trial'); assert.equal(f.authors.patch, 2);
  const input = JSON.parse(textOf(f.calls.filter(call => systemOf(call).includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))).at(-1).messages.find(row => row.role === 'user').content));
  assert.equal(input.correction, '又是没有铺垫的道具', 'newest first');
  // The older correction that passed review keeps its place: it is written in the next cooldown window, not dropped.
  assert.deepEqual(f.current().genes.reviews.map(row => [row.status, row.status === 'awaiting_author' ? next.reviewTexts(row).correction : null]), [['awaiting_author', '人物又没铺垫就出场了'], ['pending', null]]);
  assert.equal(next.reviewJob(), null, 'inside the new cooldown');
  next.now = () => start + 42 * 60000;
  const older = next.reviewJob(); assert.equal(typeof older, 'function');
  assert.equal((await older()).outcome, 'trial'); assert.equal(f.authors.patch, 3);
  const latest = JSON.parse(textOf(f.calls.filter(call => systemOf(call).includes(PATCH_AUTHOR_SYSTEM.slice(0, 60))).at(-1).messages.find(row => row.role === 'user').content));
  assert.equal(latest.correction, '人物又没铺垫就出场了', 'every correction that passed review is written');
  assert.deepEqual(f.current().genes.reviews.map(row => row.status), ['pending'], 'only the unjudged one is still kept');
  assert.equal(f.current().genes.funnel.B.coalesced, undefined, 'nothing folded away');
});

test('EVO-9: a review whose conversation was deleted goes with it', async t => {
  const f = await fixture(t);
  f.app.genes.decisions.turnReview = async () => ({ review: true, method: true, covered: false });
  f.turn('写一章'); const next = f.turn('伏笔没铺垫');
  await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text: '伏笔没铺垫' });
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.items = s.items.filter(item => item.text !== '伏笔没铺垫'); });
  const out = await f.app.genes.jobs.shift()();
  assert.deepEqual(out, { reviewed: false, gone: true }); assert.equal(f.current().genes.reviews.length, 0);
});

test('EVO-9: a correction waiting for lane B goes when its conversation is deleted or its message rewound, also while evolution is off', async t => {
  const f = await fixture(t);
  f.app.genes.decisions.turnReview = async () => ({ review: true, method: true, covered: false });
  const correct = async text => { f.turn('写一章'); const next = f.turn(text); await f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: next, record: { correction: true }, text }); return f.conversation().turns.find(row => row.id === next).userItemId; };
  const first = await correct('伏笔没铺垫'); await correct('人物没出场就提到了');
  f.app.genes.jobs.length = 0;
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).evolution = { enabled: false }; });
  assert.equal(f.current().genes.reviews.length, 2);
  // The first correction's message is rewound: its review goes; the other stays.
  f.app.store.mutate(state => revokeGeneSources(state.projects.find(row => row.id === f.project.id), sourceScope({ sessionId: f.session.id, itemIds: [first] }), { mode: 'rewound' }));
  assert.deepEqual(f.current().genes.reviews.map(row => row.itemId === first), [false]);
  // The conversation is deleted: nothing of it waits on.
  f.app.store.mutate(state => revokeGeneSources(state.projects.find(row => row.id === f.project.id), sourceScope({ sessionId: f.session.id }), { mode: 'deleted' }));
  assert.equal(f.current().genes.reviews.length, 0);
});

test('EVO-9: an announcement waiting for a busy conversation survives a restart and is marked on its generation once delivered', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: 'busy', status: 'running', createdAt: new Date().toISOString() }); });
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  assert.equal(f.said().length, 0, 'the conversation is busy');
  const waiting = f.current().genes.announcements;
  assert.equal(waiting.length, 1); assert.equal(waiting[0].generation, grown.generation);
  // Restart; the turn has finished meanwhile.
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.find(row => row.id === 'busy').status = 'completed'; });
  const next = f.restart();
  next.start();
  assert.equal(f.said().length, 1); assert.match(f.said()[0], /我加了一条自动检查/);
  assert.ok(f.current().genes.generations.find(row => row.n === grown.generation).announcedAt);
  assert.equal(f.current().genes.announcements.length, 0);
});

test('lane C: turns the model service or the network failed are recorded in the system strand without a model call, and are not trouble', async t => {
  const f = await fixture(t);
  for (const category of ['connection', 'timeout', 'server_unavailable']) f.app.store.mutate(state => {
    const s = state.sessions.find(row => row.id === f.session.id), turnId = randomUUID(), at = new Date().toISOString();
    s.turns.push({ id: turnId, status: 'failed', errorCode: 'http_error', errorDiagnostic: { category, retryable: true }, createdAt: at, completedAt: at });
  });
  f.turn('继续');
  const project = f.current();
  assert.deepEqual(f.app.genes.contrastOutcomes(project).map(row => row.outcome), [], 'not trouble, not a good turn');
  assert.equal(f.app.genes.contrastDue(project), false, 'three failed turns used to start a paid contrast analysis');
  assert.equal(f.app.genes.infraDue(project), true);
  const before = f.calls.length;
  await f.app.genes.recordInfra(f.project.id);
  assert.equal(f.calls.length, before, 'no model call');
  const network = f.gene('system:infra-network'), service = f.gene('system:infra-service');
  assert.deepEqual([network.layer, network.status, network.body.count, service.body.count], ['system', 'active', 2, 1]);
  assert.equal(f.app.genes.infraDue(f.current()), false, 'counted once');
});

const SLOT_TOOLS = Array.from({ length: GENOME_TOOL_LIMIT }, (_, index) => ({ id: `guard_slot${index}`, name: `slot ${index}`, description: 'Checks one file. Takes {path}.', permission: 'read', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } }, script: GUARD_SCRIPT, smokeCases: [{ input: { path: 'a.md' }, expected: { hits: [], summary: '未发现' }, workspace: { files: [{ path: 'a.md', content: 'ok' }] } }] }));
/** Every tool slot taken by a check; `genes(index)` adds fields to each check's record. */
const fillSlots = (f, genes = () => ({})) => f.app.genes.genes.commitGeneration(f.project.id, { summary: '满了', genes: SLOT_TOOLS.map((tool, index) => ({ id: `guard:${tool.id}`, layer: 'guard', key: tool.id, title: `检查${index}`, summary: 's', status: 'active', runs: 3, body: { toolId: tool.id, trigger: { onWrite: ['正文/**/*.md'] }, routeVersion: GUARD_ROUTE_VERSION }, ...genes(index) })), change: draft => { draft.tools = SLOT_TOOLS; return draft; } });

test('the tool slots are full: no check is authored; the rule becomes a practice and a check that never ran because nothing matches it is offered for retirement', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.workspace, '设定'), { recursive: true }); writeFileSync(join(f.workspace, '设定', '人物.md'), '人物表\n');
  // Two checks never ran: one matches a file (it is only waiting for a write), the other matches none.
  await fillSlots(f, index => index === 0 ? { runs: 0, body: { toolId: 'guard_slot0', trigger: { onWrite: ['设定/*.md'] }, routeVersion: GUARD_ROUTE_VERSION } } : index === 1 ? { runs: 0 } : {});
  f.app.genes.decisions.geneRoute = async () => ({ guard: true, checkable: true, everyWrite: true, method: false });
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const rule = f.lesson('正文里不得出现“守夜”字样。');
  const outcome = await f.app.genes.routeLesson(f.current(), rule);
  assert.equal(outcome.outcome, 'guard_cap'); assert.equal(f.authors.guard, 0, 'no author call for a check that cannot be added');
  assert.equal(outcome.practice.outcome, 'trial', 'written as a practice instead');
  const invitations = f.conversation().invitations.filter(row => row.kind === 'gene');
  assert.deepEqual(invitations.map(row => [row.geneId, row.usage]), [['guard:guard_slot1', 'never_ran']], 'only the check no file matches: the question says so');
  assert.equal(f.gene('guard:guard_slot0').body.matched, 1); assert.equal(f.gene('guard:guard_slot0').retireOffered, undefined);
  assert.equal(f.gene('guard:guard_slot1').body.matched, 0);
  assert.equal(f.current().genes.funnel.A.guard_cap, 1);
});

test('the tool slots are full and the check to extend cannot be extended: no fresh check is authored, the rule becomes a practice', async t => {
  let extendAnswer = { skip: true };
  const asked = { extend: 0, fresh: 0, patch: 0 };
  const f = await fixture(t, { guard: input => { const data = JSON.parse(textOf(input.messages.find(row => row.role === 'user').content)); if (data.extend) { asked.extend++; return extendAnswer; } asked.fresh++; return { ...GUARD_ANSWER, tool: { ...GUARD_ANSWER.tool, id: 'guard_zhenyao' } }; },
    patch: () => ({ ...PATCH_ANSWER, title: `禁用词${++asked.patch}`, summary: '正文避开这些词。', section: '- 写正文时避开用户点名不让用的词。\n- 收尾前通读一遍。' }) });
  keepsRule(f.workspace);
  await fillSlots(f);
  // Placement: the new rule is about the same thing as 检查1, a check in force (extend it). gene.route: not a method rule,
  // so before the fix the rule ended as neither an extension nor a practice.
  f.app.genes.decisions.geneRoute = async () => ({ guard: true, checkable: true, everyWrite: true, method: false });
  f.app.genes.decisions.geneConsolidate = async (_project, input) => ({ action: 'revise', index: input.existing.findIndex(row => row.title === '检查1') });
  for (const [answer, text] of [[{ skip: true }, '正文里也不得出现“镇妖”字样。'], [500, '正文里也不得出现“斩妖”字样。']]) {
    extendAnswer = answer;
    const rule = f.lesson(text), before = asked.extend;
    const outcome = await f.app.genes.routeLesson(f.current(), rule);
    assert.equal(outcome.outcome, 'guard_cap', JSON.stringify(outcome)); assert.ok(asked.extend > before); assert.equal(asked.fresh, 0, 'no fresh check, which the tool limit would reject after an author call and a smoke run');
    assert.equal(outcome.practice.outcome, 'trial', 'the rule is written as a practice');
    assert.equal(f.current().mind.lessons.find(row => row.id === rule.id).geneRoute.geneId, outcome.practice.geneId);
  }
  assert.equal(f.genome().tools.length, GENOME_TOOL_LIMIT); assert.ok(!f.current().genes.genes.some(row => row.id === 'guard:guard_zhenyao'));
  assert.equal(f.current().genes.funnel.A.guard_extend_failed_cap, 2);
});

test('the tried list tells measured failures from gate rejections, and keeps only the newest few of the latter', async t => {
  const f = await fixture(t);
  const at = index => new Date(Date.now() - (20 - index) * 60000).toISOString();
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes ??= { genes: [], generations: [] }; project.genes.genes.push(
    ...Array.from({ length: 6 }, (_, index) => ({ id: `skill-patch:r${index}`, layer: 'skill', title: `被拒${index}`, status: 'rejected', rejection: { code: 'review_failed', note: '复审未通过：scoped' }, updatedAt: at(index) })),
    { id: 'skill-patch:used1', layer: 'skill', title: '用过1', status: 'retired', generation: 3, updatedAt: at(1) },
    { id: 'skill-patch:used2', layer: 'skill', title: '用过2', status: 'retired', generation: 4, updatedAt: at(9) },
    { id: 'skill-patch:folded', layer: 'skill', title: '并入的', status: 'retired', generation: 5, supersededBy: 'skill-patch:x', updatedAt: at(10) },
    { id: 'skill-patch:weather', layer: 'skill', title: '中断的', status: 'rejected', rejection: { code: 'interrupted', retryable: true }, updatedAt: at(11) }); });
  const tried = f.app.genes.tried(f.current());
  assert.deepEqual(tried.map(row => [row.title, row.measured]), [['用过1', true], ['被拒2', false], ['被拒3', false], ['被拒4', false], ['被拒5', false], ['用过2', true]]);
});

test('EVO-15: a rule the project instruction file already states is covered — nothing is written, and the file is never edited', async t => {
  const f = await fixture(t);
  const agents = '# 项目说明\n\n## 正文写法\n写新章节前先核对前文细节，确保每个呼应点都有前文伏笔。\n\n## 发布\n每周五发布一次。\n';
  writeFileSync(join(f.workspace, 'AGENTS.md'), agents);
  let asked;
  f.app.genes.decisions.geneRoute = async () => ({ guard: false, checkable: false, everyWrite: false, method: true });
  f.app.genes.decisions.geneConsolidate = async (_project, input) => { asked = input; const index = input.existing.findIndex(row => row.title.startsWith('AGENTS.md:') && /正文写法/.test(row.title)); return index >= 0 ? { action: 'skip', index } : { action: 'add', index: null }; };
  const rule = f.lesson('写新章前先核对前文伏笔。', 'pitfall');
  const outcome = await f.app.genes.routeLesson(f.current(), rule);
  assert.deepEqual([outcome.routed, outcome.outcome, outcome.covered], ['practice', 'covered', 'instructions']);
  assert.match(asked.existing.find(row => row.title.startsWith('AGENTS.md:')).body, /每个呼应点都有前文伏笔/, 'the section goes with its text');
  assert.equal(f.authors.patch, 0, 'no author call');
  assert.equal(f.current().mind.lessons.find(row => row.id === rule.id).geneRoute.coveredBy, 'instructions');
  assert.equal(readFileSync(join(f.workspace, 'AGENTS.md'), 'utf8'), agents);
});

test('EVO-15 placement: the instruction file is asked in its own call, only when no rule in force is about the new content, and only its sections that share words with it', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, 'AGENTS.md'), '# 项目说明\n\n## 正文写法\n对话统一用中文直角引号「」。\n\n## 工作流程\n写新章节前先读设定集里的人物表。\n\n## 发布\nweekly release on friday\n');
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'add', index: null });
  const live = await f.app.genes.applyPatch(f.current(), await f.app.genes.genes.activeGenome(f.current()), PATCH_ANSWER, { origin: { kind: 'correction', quote: 'x' }, originText: 'x', trigger: 'correction', announce: null, signal: new AbortController().signal });
  const calls = [];
  let answers = [];
  f.app.genes.decisions.geneConsolidate = async (_project, input) => { calls.push(input.existing.map(row => row.title)); return answers.shift() ?? { action: 'add', index: null }; };
  // A rule in force is about it: placed there, and the instruction file is not asked (no padding in that call).
  answers = [{ action: 'revise', index: 0, ledgerId: 'live' }];
  const revised = await f.app.genes.place(f.current(), '写新章前先核对伏笔，并在伏笔清单里登记。');
  assert.deepEqual([revised.action, revised.target.id, revised.ledgerId], ['revise', live.geneId, 'live']);
  assert.deepEqual(calls, [['先核对伏笔']], 'one call over the rules in force only');
  // Nothing in force is about it: the sections sharing words with it are asked on their own; stated there → covered.
  calls.length = 0; answers = [{ action: 'add', index: null, ledgerId: 'first' }, { action: 'skip', index: 0, ledgerId: 'stated' }];
  const covered = await f.app.genes.place(f.current(), '对话一律用中文直角引号「」。');
  assert.deepEqual([covered.action, covered.target.layer, covered.ledgerId], ['skip', 'instructions', 'stated']);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], ['先核对伏笔']);
  assert.ok(calls[1].length && calls[1].every(title => title.startsWith('AGENTS.md:')), 'the second call holds the instruction sections alone');
  assert.ok(!calls[1].some(title => /发布/.test(title)), 'a section sharing no word with the new content is left out');
  // A section it adds to is not rewritten: the rule is written (add), with the first call's ledger.
  calls.length = 0; answers = [{ action: 'add', index: null, ledgerId: 'first' }, { action: 'revise', index: 0, ledgerId: 'second' }];
  assert.deepEqual(await f.app.genes.place(f.current(), '对话用「」，内心独白单独成段。'), { action: 'add', ledgerId: 'first' });
  // No judge for the rules in force: nothing is settled early (as before).
  calls.length = 0; f.app.genes.decisions.geneConsolidate = async () => null;
  assert.equal(await f.app.genes.place(f.current(), '对话一律用中文直角引号「」。'), null);
});

test('EVO-9/EVO-6: replay goes by announcedAt — a retirement line waiting on a busy conversation survives hours of the app being closed; a line that is no longer news does not', async t => {
  const f = await fixture(t);
  keepsRule(f.workspace);
  const grown = await f.app.genes.routeLesson(f.current(), f.lesson('正文里不得出现“守夜”字样。'));
  assert.ok(f.current().genes.generations.find(row => row.n === grown.generation).announcedAt, 'told at once: the conversation was quiet');
  // A turn is running when the user drops the check from the tree, and when a line with no generation is queued.
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.push({ id: 'busy', status: 'running', createdAt: new Date().toISOString() }); });
  const retired = await f.app.genes.retireByUser(f.project.id, grown.geneId);
  f.app.genes.queueAnnouncement(f.project.id, '一条不属于任何一代的提示。', null, { topic: 'plain' });
  assert.deepEqual(f.current().genes.announcements.map(row => [row.generation ?? null, row.lasting === true]), [[retired.generation, true], [null, false]]);
  // The app is closed for four hours; the turn ended meanwhile.
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === 'busy').status = 'completed'; });
  const start = Date.now(), next = f.restart({ now: () => start + 4 * 3600000 });
  next.start();
  const told = f.said();
  assert.ok(told.some(text => /不再用了/.test(text)), 'the retirement is told after the restart (it used to be dropped as too old)');
  assert.ok(!told.some(text => /不属于任何一代/.test(text)), 'a line that is no longer news is let go');
  assert.ok(f.current().genes.generations.find(row => row.n === retired.generation).announcedAt);
  assert.equal(f.current().genes.announcements.length, 0);
});
