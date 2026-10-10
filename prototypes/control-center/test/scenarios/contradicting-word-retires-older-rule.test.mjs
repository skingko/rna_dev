// D4 scenario (plan C4, reference alignment §1.3 F row "用户推翻一条规则后，技能补丁无法退休"; mu features/memory.ts:200-211: the
// user's latest word retires the older rule). The skill holds a working rule the model wrote on its own after an analysis
// of failed turns. The user then states the opposite as a lesson. Placement (gene.consolidate) asks JEV, rule by rule,
// whether the new word REVERSES it (stage one), and of the rules found reversed whether it is only a special case
// (stage two); a total reversal retires the older rule without asking — nothing it replaced comes back — and the conversation
// is told. A new word that merely makes an exception to the rule leaves it in force. Crosses the mind route, the gene
// route and placement, the decision service's two stages, the genome bundle and the conversation line. JEV is the fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const REWRITE = '\n\n## 整章重写\n- 与参考差距大时整章推翻重写。';

async function seeded(t) {
  const world = await createWorld(t, { files: { '正文/第001章.md': '第一章\n' } });
  const at = new Date().toISOString(), genome = structuredClone(GENOME); genome.skills[0].instructions += REWRITE;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    project.activeVersionId = prepared.record.versionId; project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    // A rule the model wrote from a contrast analysis (not the user's word).
    project.genes = { generations: [{ n: 1, at, versionId: prepared.record.versionId, summary: '补充做法', geneIds: ['skill-patch:rewrite'] }], genes: [{ id: 'skill-patch:rewrite', layer: 'skill', key: 'rewrite', title: '整章重写', summary: '差距大就整章重写。', level: 0, generation: 1, status: 'trial', origin: { kind: 'contrast', quote: '对照分析' }, body: { skillId: 'project-workflow', note: REWRITE }, createdAt: at, history: [] }] };
  });
  return world;
}
// The words as the lesson route routes them: a way of working that no program can check.
const route = jev => jev.answer('checkable_by_program', 0.1).answer('changes_method', 0.9).answer('every_write', 0.1).answer('periodic', 0.05).answer('overlap', 'rule_0').answer('adds', 0.9);
const lessonFrom = async (world, text) => { const created = await world.post(`/api/v2/projects/${world.projectId}/mind/lessons`, { text, kind: 'constraint' }); assert.equal(created.status, 201, JSON.stringify(created.body)); return created.body.entry; };

test('the user\'s latest word reverses a rule the model wrote: it is retired in a new generation, announced, and the new word is not merged into it', async t => {
  const world = await seeded(t), s = scenario(world);
  route(world.jev).answer('contradicts_0', 0.95).answer('narrower_0', 0.1);
  const lesson = await lessonFrom(world, '不要再整章重写了，在原稿上改就行。');
  const step = await s.step('route the lesson', async () => world.app.genes.routeLesson(world.project(), world.project().mind.lessons.find(row => row.id === lesson.id)));
  await world.quiet();
  await step.expect({
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), rule = project.genes.genes.find(row => row.id === 'skill-patch:rewrite');
      assert.equal(rule.status, 'retired', 'the older rule is retired by the newer word');
      assert.ok(!project.versions.find(row => row.id === project.activeVersionId).bundle.genome.skills[0].instructions.includes('整章推翻重写'), 'its text left the skill');
      assert.ok(project.genes.generations.at(-1).summary.includes('整章重写'), 'in a generation of its own');
    },
    judgments: calls => {
      const first = calls.find(call => Object.hasOwn(call.questions, 'contradicts_0')), second = calls.find(call => Object.hasOwn(call.questions, 'narrower_0'));
      assert.ok(first && second, 'both stages ran');
      assert.ok(!Object.hasOwn(first.questions, 'narrower_0'), 'stage one asks the reversal alone'); assert.ok(!Object.hasOwn(second.questions, 'contradicts_0'), 'stage two asks of the rule found reversed alone');
      assert.ok(JSON.stringify(first.state).includes('整章重写') && JSON.stringify(first.state).includes('不要再整章重写了'), 'placed among the rules in force, with the user\'s words');
    },
  });
  await until(() => world.session().items.some(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:rewrite'), 'the conversation to be told', 30000);
  assert.match(world.session().items.findLast(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:rewrite').text, /按你刚才说的，停用了/);
});

test('a new word that only makes an exception to the rule leaves it in force (the second stage calls it a special case)', async t => {
  const world = await seeded(t), s = scenario(world);
  // Stage one calls it a reversal; stage two says the new word applies to part of what the rule covers.
  route(world.jev).answer('contradicts_0', 0.93).answer('narrower_0', 0.8);
  const lesson = await lessonFrom(world, '整章重写这条，只对前十章用，后面的章节在原稿上改。');
  const step = await s.step('route the lesson', async () => world.app.genes.routeLesson(world.project(), world.project().mind.lessons.find(row => row.id === lesson.id)));
  await world.quiet();
  await step.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId), rule = project.genes.genes.find(row => row.id === 'skill-patch:rewrite');
    assert.notEqual(rule.status, 'retired', 'a special case does not retire the rule');
    assert.ok(project.versions.find(row => row.id === project.activeVersionId).bundle.genome.skills[0].instructions.includes('整章推翻重写'), 'its text is still in the skill');
  }, judgments: calls => assert.ok(calls.some(call => Object.hasOwn(call.questions, 'narrower_0')), 'stage two ran') });
});

test('the word of a conversation the assistant concluded on its own never retires a rule in force', async t => {
  const world = await seeded(t), s = scenario(world);
  route(world.jev).answer('contradicts_0', 0.97).answer('narrower_0', 0.05);
  let id;
  world.store.mutate(state => { const mind = state.projects.find(row => row.id === world.projectId).mind ??= {}; mind.lessons ??= []; id = 'agent-lesson'; mind.lessons.push({ id, kind: 'constraint', scope: 'project', status: 'active', text: '不要再整章重写了。', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: { kind: 'agent', sessionId: world.sessionId }, evidence: [], uses: { recalled: 0, applied: 0, contradicted: 0 } }); });
  // A rule the model wrote earlier is not the user's word either; but a lesson of the assistant's own is outranked by any kept rule.
  world.store.mutate(state => { const rule = state.projects.find(row => row.id === world.projectId).genes.genes[0]; rule.origin = { kind: 'correction', quote: '用户说过整章重写' }; });
  const step = await s.step('route the lesson', async () => world.app.genes.routeLesson(world.project(), world.project().mind.lessons.find(row => row.id === id)));
  await world.quiet();
  await step.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId);
    assert.notEqual(project.genes.genes.find(row => row.id === 'skill-patch:rewrite').status, 'retired', 'the assistant\'s lesson does not override the user\'s rule');
    assert.deepEqual([project.mind.lessons.find(row => row.id === id).geneRoute.disposition, project.mind.lessons.find(row => row.id === id).geneRoute.conflictsWith], ['conflicts_rule', 'skill-patch:rewrite'], 'the lesson says which rule it met');
  } });
});
