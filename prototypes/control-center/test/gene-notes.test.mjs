import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { geneTree, TRIAL_CLEAN_USES, TRIAL_USES } from '../project-genes.mjs';
import { GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';
import { PROJECT_WORKFLOW_DESCRIPTION } from '../../../packages/sdk/src/bootstrap-lite.mjs';

// UX audit 2026-10-03 (texts, C7): the history notes gene-evolution-service writes read in the current interface
// language through HOST_NOTES (project-genes.mjs); the bootstrap workflow skill is named in the host's words.

/** Every say({ zh, en }) pair in gene-evolution-service.mjs whose text is fixed (a constant count is filled in). */
function fixedSayPairs() {
  const source = readFileSync(new URL('../gene-evolution-service.mjs', import.meta.url), 'utf8');
  const literal = String.raw`('(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;
  const pattern = new RegExp(String.raw`say\(\{ zh: ${literal}, en: ${literal} \}\)`, 'g');
  const text = raw => raw.slice(1, -1).replace(/\\(.)/g, '$1').replaceAll('${TRIAL_CLEAN_USES}', String(TRIAL_CLEAN_USES)).replaceAll('${TRIAL_USES}', String(TRIAL_USES));
  const pairs = [], dynamic = [];
  for (const [, zh, en] of source.matchAll(pattern)) {
    const pair = { zh: text(zh), en: text(en) };
    // A note that carries a title or a count keeps the language it was written in.
    if (pair.zh.includes('${') || pair.en.includes('${')) dynamic.push(pair); else pairs.push(pair);
  }
  return { pairs: [...new Map(pairs.map(pair => [pair.zh, pair])).values()], dynamic };
}

test('every fixed history note gene-evolution-service writes reads in the current interface language', () => {
  const { pairs, dynamic } = fixedSayPairs();
  assert.ok(pairs.length >= 12, `the scan found the fixed notes (${pairs.length})`); assert.ok(dynamic.length > 0, 'and skipped the ones with a title or count');
  assert.ok(pairs.some(pair => pair.zh === `照它做了 ${TRIAL_USES} 次，没被纠正，已生效`), 'a constant count is part of the fixed text');
  const genes = pairs.map((pair, index) => ({ id: `guard:n${index}`, layer: 'guard', key: `n${index}`, title: 't', summary: 's', level: 0, status: 'trial',
    history: [{ at: '2026-10-03T00:00:00Z', status: 'trial', note: pair.zh }, { at: '2026-10-03T00:00:01Z', status: 'trial', note: pair.en }] }));
  const project = { id: 'p', genes: { genes, generations: [] } };
  for (const language of ['zh', 'en']) {
    const views = geneTree(project, { language }).strands.flatMap(row => row.genes);
    pairs.forEach((pair, index) => assert.deepEqual(views.find(row => row.id === `guard:n${index}`).history.map(row => row.note), [pair[language], pair[language]], `${pair.zh} / ${pair.en} is listed in HOST_NOTES (project-genes.mjs)`));
  }
});

const SUMMARY_SYSTEM = 'tells a non-technical user what this skill helps';
async function bootstrapFixture(t) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    if (system.includes(SUMMARY_SYSTEM)) return stream(res, JSON.stringify({ summary: system.includes('sentence in English') ? 'Helps write chapters.' : '帮你写章节' }));
    stream(res, 'ok');
  });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  // The skill as the bootstrap names it for the model: "<project> workflow" with the default English description.
  await f.app.genes.genes.commitGeneration(f.project.id, { summary: '初始做法', genes: [], change: draft => { Object.assign(draft.skills[0], { name: '玄幻小说 workflow', description: PROJECT_WORKFLOW_DESCRIPTION }); return draft; } });
  const genome = () => f.current().versions.find(row => row.id === f.current().activeVersionId).bundle.genome;
  return { ...f, genome, summaryCalls: () => f.calls.filter(input => (input.messages.find(row => row.role === 'system')?.content ?? '').includes(SUMMARY_SYSTEM)).length };
}

test('a guard that passes its checks records "now active" in the interface language, and reads in the other one later', async t => {
  const f = await bootstrapFixture(t);
  f.app.store.interfaceLanguage('en');
  let lessonId;
  f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  keepsRule(f.workspace);
  assert.equal((await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId))).outcome, 'active');
  const notes = language => geneTree(f.current(), { language }).strands.flatMap(row => row.genes).find(row => row.id === 'guard:guard_nightwatch').history.map(row => row.note);
  assert.deepEqual(notes('en').slice(-2), ['Checking', 'Passed its checks; now active']);
  assert.deepEqual(notes('zh').slice(-2), ['开始验证', '通过验证，已生效']);
});

test('the bootstrap workflow skill gets no model summary, and a merge into it names it as the tree does', async t => {
  const f = await bootstrapFixture(t);
  const genome = { ...f.genome(), skills: [...f.genome().skills, { id: 'novel-writing', name: 'novel-writing', description: 'Assists with writing novels and long-form fiction.', instructions: '# Novel writing', resources: [] }] };
  assert.equal(await f.app.genes.plainSummaries(f.project.id, genome), 1, 'only the marketplace skill');
  assert.equal(f.summaryCalls(), 1, 'no model call for the workflow skill');
  assert.equal(f.current().genes.genes.find(row => row.id === 'skill:project-workflow')?.plainSummaries, undefined);
  // Merge another skill into the workflow skill: the gene, the generation line and the announcement say 项目做法.
  await f.app.genes.genes.commitGeneration(f.project.id, { summary: '加入技能', genes: [], change: draft => { draft.skills.push({ id: 'chapter-writing', name: '章节写作', description: '写章节', instructions: `# 章节写作\n\n${'每章先写提纲，再写正文。'.repeat(40)}`, resources: [] }); return draft; } });
  const merged = `# 项目工作流\n\n1. 读设定集。\n2. 每章先写提纲，再写正文。\n${'- 保持人名、称谓与设定集一致。\n'.repeat(10)}`;
  const result = await f.app.genes.mergeSkills(f.project.id, { keep: 'project-workflow', absorb: 'chapter-writing', instructions: merged }, { primary: 'project-workflow' });
  assert.equal(result.outcome, 'trial', JSON.stringify(result));
  const gene = f.current().genes.genes.find(row => row.id === result.geneId), generation = f.current().genes.generations.at(-1);
  assert.equal(gene.title, '合并项目做法'); assert.equal(gene.summary, '把「章节写作」并进「项目做法」');
  assert.equal(generation.summary, '合并技能「章节写作」到「项目做法」');
  const said = [...f.app.genes.announcements.map(row => row.text), ...f.app.store.state.sessions.flatMap(row => row.items).filter(item => item.initiative?.gene === result.geneId).map(item => item.text)];
  assert.ok(said.some(text => text.includes('我把「章节写作」并进了「项目做法」')), JSON.stringify(said));
  assert.ok(![gene.title, gene.summary, generation.summary, ...said].some(text => text.includes('workflow')));
});
