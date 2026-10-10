// D4 scenario (plan C4, reference alignment §1.3 D and F rows: "撤销一条经验不会传到基因、笔记、计划"). A lesson the project
// learned grew a working rule in the skill, and a note and a plan item restate it. The user revokes the lesson in the
// evolution tree: the rule it grew leaves the skill (its own generation, the conversation is told), the note and the plan
// item that restate it are judged stale in ONE JEV call and leave what the models read, while a note about something
// else stays — and the next request says so: the notes block is replaced, and the skill the model loads no longer holds
// the rule. Crosses the gene route, the mind, the revocation dispatcher, the genome bundle, the stream's conversation line
// and the foreground's request. Model and JEV are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { MIND_CONTEXT_KEYS } from '../../project-mind.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const RULE = '\n\n## 先搜索原著风格\n- 动笔前先搜索查证原著的整体风格。';
const LESSON = '写作前先搜索查证原著风格再动笔。';
const RESTATING = '动笔前要先搜索查证一遍原著风格', UNRELATED = '用户习惯晚上九点以后看稿', PLAN = '先搜索原著风格，再写第 12 章';

test('revoking a lesson takes back the rule it grew, the notes and plan items that restate it, and the next request carries none of them', async t => {
  const world = await createWorld(t, { files: { '正文/第001章.md': '第一章\n' } });
  const s = scenario(world), lessonId = 'scenario-lesson-1', at = new Date().toISOString();
  const genome = structuredClone(GENOME); genome.skills[0].instructions += RULE;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  const skillId = prepared.skillManifests[0].id;
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    project.activeVersionId = prepared.record.versionId; project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    project.genes = { generations: [{ n: 1, at, versionId: prepared.record.versionId, summary: '补充做法', geneIds: ['skill-patch:search-style'] }], genes: [{ id: 'skill-patch:search-style', layer: 'skill', key: 'search-style', title: '先搜索原著风格', summary: '动笔前先搜索查证原著风格。', level: 0, generation: 1, status: 'trial',
      origin: { kind: 'lesson', lessonId, quote: LESSON }, body: { skillId: 'project-workflow', note: RULE }, createdAt: at, history: [] }] };
    project.mind ??= {};
    Object.assign(project.mind, { lessons: [{ id: lessonId, kind: 'constraint', scope: 'project', status: 'active', text: LESSON, createdAt: at, updatedAt: at, source: { kind: 'user', sessionId: world.sessionId }, evidence: [], uses: { recalled: 0, applied: 0, contradicted: 0 }, geneRoute: { geneId: 'skill-patch:search-style', version: 3 } }],
      agenda: [{ id: 'plan-1', kind: 'todo', stage: 'next', status: 'open', text: PLAN, createdAt: at, updatedAt: at, source: { kind: 'agent', sessionId: world.sessionId }, evidence: [] }],
      notes: { facts: [{ id: 'note-2', text: UNRELATED, createdAt: at, sources: [] }], preferences: [{ id: 'note-1', text: RESTATING, createdAt: at, sources: [] }], updatedAt: at } });
  });
  // The judge answers by what each row says: the one that restates the lesson is stale.
  world.jev.answerAll((id, _question, body) => id.startsWith('stale_') ? (body.state?.mind?.rows?.[Number(id.slice('stale_'.length))]?.text.includes('搜索') ? 0.95 : 0.05) : undefined);

  const first = await s.send('写第 3 章。', { reply: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, '第三章写好了。'] });
  await first.expect({ requests: rows => {
    const [request] = rows.filter(row => row.tag === 'foreground');
    assert.ok(request.wire.includes(MIND_CONTEXT_KEYS.notes) && request.wire.includes(RESTATING), 'the note rides the notes block');
    assert.ok(rows.filter(row => row.tag === 'foreground').some(row => row.wire.includes('动笔前先搜索查证原著的整体风格')), 'the skill the model loaded holds the rule');
  } });

  const revoked = await s.evolve(`lesson:${lessonId}`, { action: 'revoke' });
  await until(() => world.app.store.revocations.pendingEntries().length === 0 && world.project().mind.revocations?.every(row => row.settledAt), 'the revocation to settle');
  await world.app.store.revocations.idle(); await world.quiet();
  await revoked.expect({
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), mind = project.mind, rule = project.genes.genes.find(row => row.id === 'skill-patch:search-style');
      assert.equal(mind.lessons.find(row => row.id === lessonId).status, 'retired');
      assert.equal(rule.status, 'retired', 'the rule the lesson grew is retired');
      assert.ok(!project.versions.find(row => row.id === project.activeVersionId).bundle.genome.skills[0].instructions.includes('先搜索查证原著'), 'its text left the skill');
      assert.ok(mind.notes.preferences.find(row => row.id === 'note-1').stale, 'the note that restates the lesson is stale'); assert.ok(mind.agenda.find(row => row.id === 'plan-1').stale, 'so is the plan item');
      assert.equal(mind.notes.facts.find(row => row.id === 'note-2').stale, undefined, 'a note about something else stays');
      const entry = mind.revocations.find(row => row.type === 'lesson_revoked');
      assert.ok(entry.settledAt); assert.equal(entry.result.violations, 0); assert.deepEqual(entry.result.genes.retired, ['skill-patch:search-style']); assert.equal(entry.text, undefined);
    },
  });
  const calls = world.jev.asked('stale_0');
  assert.equal(calls.length, 1, 'one batch call for the whole revocation'); assert.equal(calls[0].state.mind.revoked, LESSON);
  assert.deepEqual(calls[0].state.mind.rows.map(row => row.kind).sort(), ['note', 'plan'].sort(), 'the nearest notes and plan items; the unrelated note is not sent');
  await until(() => world.session().items.some(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:search-style'), 'the conversation to be told', 30000);
  assert.match(world.session().items.findLast(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:search-style').text, /你撤销了它的来源经验/);

  const next = await s.send('写第 4 章。', { reply: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, '第四章写好了。'] });
  await next.expect({ requests: rows => {
    const foreground = rows.filter(row => row.tag === 'foreground'), first = foreground[0], last = foreground.at(-1);
    // The notes block is replaced: its newest copy holds the unrelated note and not the stale one.
    const copies = [...first.wire.matchAll(/project-mind-notes[^]*?(?=project-mind-|$)/g)];
    assert.ok(copies.length >= 1);
    const newest = first.request.messages.filter(message => message.contextKey === MIND_CONTEXT_KEYS.notes).at(-1);
    const text = JSON.stringify(newest);
    assert.ok(text.includes(UNRELATED) && !text.includes(RESTATING), 'the newest notes block lacks the stale note');
    const loaded = JSON.stringify(last.request.messages.at(-1));
    assert.ok(loaded.includes('项目工作流') && !loaded.includes('先搜索查证原著'), 'the skill the model reads no longer holds the retired rule');
  } });
});
