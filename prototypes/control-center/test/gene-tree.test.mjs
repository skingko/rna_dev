import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { until, stream, GUARD_ANSWER, GENOME, setup } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { matchGlob, promptSections, lessonLevel, geneTree, guardsOf, GENE_LAYERS } from '../project-genes.mjs';
import { GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';

// Evolution v3 lane A (docs/planning/evolution-v3-gene-tree-20260930.md): a
// learned rule becomes a guard that runs after matching files are written.
// The model and the judge are local stubs; the sandboxed script runs for real.
test('matchGlob: ** spans folders, * stays in a segment', () => {
  assert.equal(matchGlob('正文/**/*.md', '正文/卷一/第001章.md'), true);
  assert.equal(matchGlob('正文/**/*.md', '正文/第001章.md'), true);
  assert.equal(matchGlob('正文/*.md', '正文/卷一/第001章.md'), false);
  assert.equal(matchGlob('**/*.md', 'a/b/c.md'), true); assert.equal(matchGlob('**/*.md', 'c.txt'), false);
  assert.equal(matchGlob('src/*.js', 'src/a.js'), true); assert.equal(matchGlob('src/?.js', 'src/ab.js'), false);
});

test('prompt sections, lesson levels and the tree from a project and its genome', () => {
  assert.equal(promptSections(GENOME.systemPrompt).length, 2);
  assert.equal(lessonLevel({ uses: { applied: 7, contradicted: 1 }, confirmedAt: 'x' }), 2);
  const project = { id: 'p', activeVersionId: 'v', versions: [{ id: 'v', bundle: { genome: GENOME } }], mind: { lessons: [{ id: 'l1', kind: 'constraint', status: 'active', text: '正文里不得出现守夜', uses: { applied: 0 } }] },
    genes: { genes: [{ id: 'guard:guard_nightwatch', layer: 'guard', key: 'guard_nightwatch', title: '守夜检查', summary: '…', level: 0, status: 'proposed', body: { toolId: 'guard_nightwatch', trigger: { onWrite: ['正文/**/*.md'] } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] }], generations: [] } };
  const tree = geneTree(project);
  assert.deepEqual(tree.strands.map(row => row.layer), [...GENE_LAYERS]);
  const by = Object.fromEntries(tree.strands.map(row => [row.layer, row.genes]));
  assert.equal(by.profile[0].id, 'lesson:l1'); assert.equal(by.prompt.length, 2); assert.equal(by.skill[0].key, 'project-workflow'); assert.equal(by.standard[0].key, 'consistency');
  assert.equal(by.guard[0].status, 'proposed'); assert.equal(tree.forming, true); assert.equal(tree.generation.n, 0);
  assert.deepEqual(guardsOf(project), [], 'a proposed guard is not in force');
});

test('lane A: a constraint becomes a guard through smoke, review and a run over existing files; the tree and the conversation show it', async t => {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    stream(res, 'ok');
  });
  writeFileSync(join(f.workspace, '正文', '卷一', '第001章.md'), '第一章 雾巷\n守夜人的旗帜挂在城头。\n他走进了雨里。\n');
  writeFileSync(join(f.workspace, '设定集.md'), '守夜人：原著组织，不可沿用。\n');
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '续写时不得直接复用原著的组织名「守夜人」，正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  const judged = [];
  f.app.genes.decisions = { geneRoute: async (_project, input) => { judged.push(['route', input.text]); return { guard: true, everyWrite: true, method: false, ledgerId: 'j1' }; }, geneReview: async (_project, input) => { judged.push(['review', input.title, input.existing.length]); return { pass: true, problems: [] }; } };
  assert.equal(f.app.genes.pending().length, 1);
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  assert.equal(outcome.routed, 'guard'); assert.equal(outcome.outcome, 'trial', JSON.stringify(outcome));
  assert.equal(outcome.generation, 1); assert.deepEqual(outcome.hits.map(row => row.path), ['正文/卷一/第001章.md'], 'only files matching the trigger are checked');
  assert.deepEqual(judged.map(row => row[0]), ['route', 'review']);
  const project = f.current();
  assert.equal(project.activeVersionId, outcome.versionId);
  const genome = project.versions.find(row => row.id === outcome.versionId).bundle.genome;
  assert.equal(genome.tools[0].id, 'guard_nightwatch'); assert.equal(genome.tools[0].smokeCases.length, 2);
  assert.match(genome.skills[0].instructions, /## Automatic check: 「守夜」字样检查\n组织名不能沿用原著的「守夜人」，正文里不得出现“守夜”字样。\nIt runs by itself after a file matching [^\n]+ is written; fix the hits it reports for that write before finishing\. Hits a file already had before this run's writes are counted only; leave them unless the user asks\. The tool whose name ends in guard_\w+ checks any file on request; it lists every hit in the file, old ones included\./);
  assert.equal(project.mind.lessons.find(row => row.id === lessonId).geneRoute.geneId, 'guard:guard_nightwatch');
  const tree = geneTree(project, { genome });
  const guard = tree.strands.find(row => row.layer === 'guard').genes[0];
  assert.equal(guard.status, 'trial'); assert.equal(guard.origin.lessonId, lessonId); assert.equal(tree.generation.n, 1); assert.equal(tree.generation.summary, '新增检查「守夜」字样检查', 'quotes the model added are not doubled');
  assert.deepEqual(guard.trigger, ['正文/**/*.md']); assert.equal(guard.existingHits.total, 1); assert.equal(guard.existingHits.files, 1);
  assert.equal(f.app.genes.pending().length, 0, 'the lesson is routed once');
  const told = f.app.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.source === 'initiative');
  assert.match(told.text, /我加了一条自动检查/); assert.match(told.text, /现有文件里发现 1 处/); assert.match(told.text, /第001章\.md 第 2 行/);
  // The API serves the same tree and can retire the guard (a new generation without it).
  const served = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes`)).then(row => row.json());
  assert.equal(served.strands.find(row => row.layer === 'guard').genes[0].id, 'guard:guard_nightwatch');
  const revoked = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/guard:guard_nightwatch`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) }).then(row => row.json());
  assert.equal(revoked.generation, 2);
  const after = f.current(), latest = after.versions.find(row => row.id === after.activeVersionId).bundle.genome;
  assert.deepEqual(latest.tools, []); assert.doesNotMatch(latest.skills[0].instructions, /Automatic check/);
  assert.equal(after.genes.genes[0].status, 'retired'); assert.deepEqual(guardsOf(after), []);
});

test('a guard in force runs after the model writes a matching file, and its hits ride on the tool result', async t => {
  const f = await setup(t, (input, res, count) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    const results = input.messages.filter(row => row.role === 'tool');
    if (!results.length) return stream(res, '', { tool: { name: 'project_write', args: { path: '正文/卷一/第002章.md', content: '第二章\n守夜人再次出现。\n', createOnly: true } } });
    assert.match(String(results.at(-1).content), /\[Automatic checks\] 「守夜」字样检查: 1 hit to fix\n- line 2: 守夜人再次出现。 \(含“守夜”字样\)/);
    stream(res, '已按检查结果修正。');
  });
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  // EVO-5: a check that matched no file has tested nothing — it runs on every matching write, but stays on trial and
  // the tree says it has not run yet (ModularRSI's activation gate).
  assert.equal(outcome.outcome, 'trial', 'no existing file matches: on trial, not active');
  const fresh = geneTree(f.current()).strands.find(row => row.layer === 'guard').genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.deepEqual([fresh.status, fresh.runs], ['trial', 0]); assert.match(fresh.history.at(-1).note, /还没有匹配的文件，试用中/);
  assert.equal(guardsOf(f.current()).length, 1, 'a check on trial still runs on writes');
  f.app.store.message(f.session.id, { text: '写第二章' });
  await until(() => ['completed', 'failed'].includes(f.app.store.state.sessions.find(row => row.id === f.session.id).turns[0]?.status));
  const session = f.app.store.state.sessions.find(row => row.id === f.session.id);
  assert.equal(session.turns[0].status, 'completed', JSON.stringify(session.items.filter(item => item.kind === 'notice')));
  const write = session.items.find(item => item.tool?.name === 'project_write');
  assert.equal(write.tool.status, 'succeeded'); assert.match(write.tool.output, /\[Automatic checks\]/);
  const guard = f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.equal(guard.runs, 1); assert.equal(guard.hits, 1);
});

test('a claude.md at the project root (any case) reaches the system prompt and is the prompt strand of the tree', async t => {
  const seen = [];
  const f = await setup(t, (input, res) => { seen.push(input.messages.find(row => row.role === 'system')?.content ?? ''); stream(res, 'ok'); });
  writeFileSync(join(f.workspace, 'claude.md'), '\ufeff# 写作守则\n\n每章不少于三千字。\n\n章末不写总结。\n');
  f.app.store.message(f.session.id, { text: '你好' });
  await until(() => f.app.store.state.sessions.find(row => row.id === f.session.id).turns[0]?.status === 'completed');
  assert.match(seen[0], /<project_instructions path="claude.md">\n# 写作守则/); assert.doesNotMatch(seen[0], /\ufeff/);
  const tree = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes`)).then(row => row.json());
  assert.deepEqual(tree.promptFile, { name: 'claude.md', exists: true, default: 'AGENTS.md' });
  const prompt = tree.strands.find(row => row.layer === 'prompt').genes;
  assert.deepEqual(prompt.map(row => row.summary), ['# 写作守则', '每章不少于三千字。', '章末不写总结。']); assert.equal(prompt[0].file, 'claude.md');
});

test('encoded gene ids reach the routes; a skill opens in full; skill descriptions get a one-line summary in the interface language', async t => {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes('Simplified Chinese')) return stream(res, JSON.stringify({ summary: '帮你按章节写长篇小说' }));
    if (system.includes('sentence in English')) return stream(res, JSON.stringify({ summary: 'Helps write long novels chapter by chapter.' }));
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    stream(res, 'ok');
  });
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  const id = encodeURIComponent('guard:guard_nightwatch');
  const detail = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${id}`)).then(row => row.json());
  assert.equal(detail.gene.id, 'guard:guard_nightwatch'); assert.match(detail.content.script, /api\.readFile/); assert.deepEqual(detail.content.trigger, ['正文/**/*.md']);
  const skill = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${encodeURIComponent('skill:project-workflow')}`)).then(row => row.json());
  assert.match(skill.content.instructions, /^# 项目工作流[\s\S]*## Automatic check/);
  const revoked = await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/${id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke' }) });
  assert.equal(revoked.status, 200, await revoked.clone().text()); assert.equal((await revoked.json()).generation, 2);
  assert.equal((await fetch(f.url(`/api/v2/projects/${f.project.id}/genes/%E0%A4%A`))).status, 400);
  // A marketplace-style English description gets a Chinese one-liner (fast model, else the main model on a tiny budget), kept on the registry.
  const genome = { ...f.current().versions.find(row => row.id === f.current().activeVersionId).bundle.genome };
  genome.skills = [...genome.skills,
    { id: 'novel-writing', name: 'novel-writing', description: 'Assists with writing novels and long-form fiction. Use when the user says 写小说 or 续写.', instructions: '# Novel writing', resources: [] },
    { id: 'xianxia', name: 'xianxia', description: '番茄小说长篇东方仙侠网文写作skill。当用户要求写东方仙侠、凡人修仙、宗门成长、长生流、仙神游历、洪荒神话、西游改写、修仙家族时使用。', instructions: '# 仙侠', resources: [] },
    { id: 'short-zh', name: 'short-zh', description: '按章节续写并自检设定一致。', instructions: '# 续写', resources: [] }];
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.name = '玄幻小说'; });
  // English (even with Chinese trigger words) and long trigger lists get one; a short Chinese line is already plain.
  assert.equal(await f.app.genes.plainSummaries(f.project.id, genome), 2);
  assert.equal(f.current().genes.genes.find(row => row.id === 'skill:short-zh'), undefined);
  const record = f.current().genes.genes.find(row => row.id === 'skill:novel-writing');
  assert.equal(record.plainSummaries.zh, '帮你按章节写长篇小说');
  assert.equal(await f.app.genes.plainSummaries(f.project.id, genome), 0, 'summarized once');
  // The interface language decides the summary language: switching to English writes English one-liners next to the Chinese ones.
  const saved = await fetch(f.url('/api/settings'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: 'en' }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const revision = f.app.store.state.revision;
  await fetch(f.url('/api/settings'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: 'en' }) });
  assert.equal(f.app.store.state.revision, revision, 'an unchanged language does not write state');
  assert.equal(await f.app.genes.plainSummaries(f.project.id, genome), 4, 'English UI: every Chinese description (the project workflow skill included) and the English one with Chinese trigger words');
  assert.deepEqual(f.current().genes.genes.find(row => row.id === 'skill:novel-writing').plainSummaries, { zh: '帮你按章节写长篇小说', en: 'Helps write long novels chapter by chapter.' });
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.genes.push({ id: 'skill:short-zh', layer: 'skill', key: 'short-zh', plainSummaries: { en: 'Continues chapters and checks the setting.' } }); });
  const { geneTree } = await import('../project-genes.mjs');
  const english = geneTree(f.current(), { genome, language: 'en' }).strands.find(row => row.layer === 'skill').genes.find(row => row.id === 'skill:short-zh');
  assert.equal(english.summary, 'Continues chapters and checks the setting.'); assert.equal(english.original, '按章节续写并自检设定一致。');
  assert.equal(geneTree(f.current(), { genome, language: 'zh' }).strands.find(row => row.layer === 'skill').genes.find(row => row.id === 'skill:short-zh').summary, '按章节续写并自检设定一致。');
  assert.equal((await fetch(f.url('/api/settings'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: 'fr' }) })).status, 400);
});

test('generation lines written before title unwrapping read with one pair of brackets', async () => {
  const { generationLine, geneTree } = await import('../project-genes.mjs');
  assert.equal(generationLine('新增检查「「守夜人」字样检查」'), '新增检查「守夜人」字样检查');
  assert.equal(generationLine('新增检查「生硬表达检查」'), '新增检查「生硬表达检查」');
  const tree = geneTree({ id: 'p', genes: { genes: [], generations: [{ n: 1, at: '2026-09-30T00:00:00Z', summary: '新增检查「「守夜人」字样检查」', geneIds: [] }] } });
  assert.equal(tree.generation.summary, '新增检查「守夜人」字样检查'); assert.equal(tree.generations[0].summary, '新增检查「守夜人」字样检查');
});

// EVO-3: names are the project's, so a generation renames nothing it keeps. A skills-only generation leaves the
// project's assignments exactly as they were (learning drift's assignments component does not move; the rhythm evidence
// key and drift's version component still do, since every generation sets a new activeVersionId) and keeps one registry
// manifest per id; a changed tool keeps its name; a new tool appends one id and one reason.
test('commitGeneration keeps assignments byte-stable for kept capabilities and one manifest per id', async t => {
  const f = await setup(t, (_input, res) => stream(res, 'ok')), store = f.app.store, genes = f.app.genes.genes;
  const baseline = f.current().versions[0];
  store.mutate(state => { state.capabilities ??= { skills: [], tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills = [...(state.capabilities.skills ?? []), ...structuredClone(baseline.generatedSkills)]; });
  const manifests = () => store.state.capabilities.skills.filter(row => row.managed === 'project-genome' && row.projectId === f.project.id);
  const before = structuredClone(f.current().assignments);
  const skillOnly = await genes.commitGeneration(f.project.id, { summary: 'Skill note', change: genome => { genome.skills[0].instructions += '\n3. 核对伏笔。'; return genome; } });
  assert.deepEqual(f.current().assignments, before, 'a skills-only generation leaves the assignments deep-equal');
  assert.equal(manifests().length, 1); assert.equal(manifests()[0].versionId, skillOnly.versionId); assert.equal(manifests()[0].id, before.skillIds[0], 'the same id, now the new version\'s manifest');
  assert.equal(new Set(store.state.capabilities.skills.map(row => row.id)).size, store.state.capabilities.skills.length);
  const tool = { id: 'count_words', name: '字数统计', description: 'Counts characters of one chapter.', permission: 'read', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, script: 'return { count: input.text.length };', smokeCases: [{ input: { text: 'abc' }, expected: { count: 3 } }] };
  const added = await genes.commitGeneration(f.project.id, { summary: 'New tool', change: genome => { genome.tools = [...genome.tools, tool]; return genome; } });
  const afterAdd = f.current().assignments, name = added.toolNames.count_words;
  assert.deepEqual(afterAdd.toolIds, [...before.toolIds, name], 'one id appended, the rest in place');
  assert.deepEqual(afterAdd.skillIds, before.skillIds);
  assert.deepEqual(afterAdd.reasons.filter(row => !(before.reasons ?? []).some(old => old.id === row.id && old.kind === row.kind)), [{ kind: 'tool', id: name, reason: '第 2 代项目能力。' }], 'one reason added');
  const revised = await genes.commitGeneration(f.project.id, { summary: 'Revised tool', change: genome => { genome.tools[0].description = 'Counts the characters of one chapter file.'; return genome; } });
  assert.equal(revised.toolNames.count_words, name, 'a changed tool keeps its name');
  const versions = f.current().versions, declaration = id => versions.find(row => row.id === id).generatedTools.find(row => row.id === name).description;
  assert.notEqual(declaration(revised.versionId), declaration(added.versionId), 'its declaration changes');
  assert.deepEqual(f.current().assignments, afterAdd, 'and the assignments stay as they were');
});
