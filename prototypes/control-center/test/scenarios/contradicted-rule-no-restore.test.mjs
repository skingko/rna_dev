// D4 scenario (plan B2, EVO-6 "contradicted"; reference alignment §1.3 F, C4 row: a contradiction from the user is
// restore:false). The project's skill holds one rule evolution merged from two earlier ones. A turn loads the skill; the
// user's next message reverses part of the merged rule. JEV calls it a correction (capture) and a contradiction of the
// rule used (mind.judge): the rule is retired in a new generation and NOTHING it replaced comes back — not even the
// earlier rule a judge would call compatible with the user's words (that "no" on contradicts has never been probed).
// The conversation is told, and the next turn that loads the skill reads none of the three rules. Crosses the message
// route, capture (turn.route), the mind's capture hook, evolution's correction judgment, the genome bundle commit and the
// foreground's skill_load. Model and JEV are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const REWRITE = '\n\n## 整章重写\n- 与参考差距大时整章推翻重写。', COMPARE = '\n\n## 逐章对照\n- 每写一章都对照参考作品的对应章节。';
const MERGED = '\n\n## 重写与对照\n- 与参考差距大时整章推翻重写。\n- 每写一章都对照参考作品的对应章节。';
const REVERSAL = '不要再整章重写了，在原稿上改就行。';

test('a rule the user contradicts is retired and nothing it replaced comes back; the next skill load reads none of it', async t => {
  const world = await createWorld(t, { files: { '正文/第001章.md': '第一章\n夜巡者站在城墙上。\n' } });
  const s = scenario(world);
  const genome = structuredClone(GENOME); genome.skills[0].instructions += MERGED;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  const skillId = prepared.skillManifests[0].id, at = new Date().toISOString();
  const rule = (id, title, note, extra = {}) => ({ id, layer: 'skill', key: id.slice('skill-patch:'.length), title, summary: title, level: 0, generation: 1, origin: { kind: 'correction', quote: title }, body: { skillId: 'project-workflow', note }, createdAt: at, history: [], ...extra });
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    project.activeVersionId = prepared.record.versionId;
    project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    project.genes = { generations: [{ n: 1, at, versionId: prepared.record.versionId, summary: '合并做法', geneIds: ['skill-patch:merged'] }], genes: [
      rule('skill-patch:rewrite', '整章重写', REWRITE, { status: 'retired', supersededBy: 'skill-patch:merged' }),
      rule('skill-patch:compare', '逐章对照', COMPARE, { status: 'retired', supersededBy: 'skill-patch:merged' }),
      rule('skill-patch:merged', '重写与对照', MERGED, { status: 'trial', body: { skillId: 'project-workflow', note: MERGED, revises: ['skill-patch:rewrite', 'skill-patch:compare'], before: [{ id: 'skill-patch:rewrite', skillId: 'project-workflow', note: REWRITE, status: 'trial' }, { id: 'skill-patch:compare', skillId: 'project-workflow', note: COMPARE, status: 'trial' }] } }),
    ] };
  });
  // JEV: the user's message is a correction (capture); it contradicts the rule used; and — asked about the earlier rules
  // — it would call 逐章对照 compatible with the user's words.
  world.jev.answer('is_correction', 0.95).answer('contradicts_0', 0.95).answer('contradicts_1', 0.05);

  const first = await s.send('写第 3 章。', { reply: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, '第三章写好了。'] });
  await first.expect({ requests: rows => assert.ok(rows.filter(row => row.tag === 'foreground').some(row => row.wire.includes('与参考差距大时整章推翻重写')), 'the merged rule was loaded') });

  const reversed = await s.send(REVERSAL, { reply: '好的，之后在原稿上改。' });
  await until(() => world.project().genes.genes.find(row => row.id === 'skill-patch:merged').status === 'retired', 'the contradicted rule to be retired');
  await world.quiet();
  await reversed.expect({
    judgments: calls => {
      const judged = calls.filter(call => Object.hasOwn(call.questions ?? {}, 'contradicts_0'));
      assert.ok(judged.some(call => JSON.stringify(call.state).includes('重写与对照')), 'the rule used was judged against the message');
      assert.ok(!judged.some(call => JSON.stringify(call.state).includes('与参考差距大时整章推翻重写') && Object.hasOwn(call.questions, 'contradicts_1')), 'the earlier rules are not judged to be brought back');
    },
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), byId = id => project.genes.genes.find(row => row.id === id);
      assert.deepEqual(['skill-patch:merged', 'skill-patch:rewrite', 'skill-patch:compare'].map(id => byId(id).status), ['retired', 'retired', 'retired'], 'nothing it replaced came back');
      const skill = project.versions.find(row => row.id === project.activeVersionId).bundle.genome.skills[0].instructions;
      assert.ok(!skill.includes('整章推翻重写') && !skill.includes('对照参考作品'), 'the skill holds none of the three rules');
      assert.ok(project.genes.generations.at(-1).summary.includes('重写与对照'), 'retired in a new generation');
    },
  });
  await until(() => world.session().items.some(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:merged'), 'the conversation to be told', 30000);
  const told = world.session().items.filter(item => item.source === 'initiative' && item.initiative?.gene === 'skill-patch:merged');
  assert.equal(told.length, 1); assert.match(told[0].text, /按你刚才说的，停用了/); assert.match(told[0].text, /没有恢复/); assert.doesNotMatch(told[0].text, /恢复了/);

  const next = await s.send('写第 4 章。', { reply: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, '第四章写好了。'] });
  await next.expect({ requests: rows => {
    // The request after the new skill_load: its last message is what that load returned (the history before it still
    // holds the first turn's load).
    const loaded = rows.filter(row => row.tag === 'foreground').at(-1), result = JSON.stringify(loaded?.request?.messages?.at(-1) ?? null);
    assert.ok(result.includes('项目工作流'), `the skill was loaded again: ${result.slice(0, 200)}`);
    assert.ok(!result.includes('整章推翻重写') && !result.includes('对照参考作品的对应章节'), 'neither the retired rule nor what it replaced is in the skill it read');
  } });
});
