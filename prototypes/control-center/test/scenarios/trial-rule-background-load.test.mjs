// Evolution scenario (trial rules with no way to proof, step 1). A trial working rule is written into a skill; the project's
// work is done by background runs, which load the skill (the rule reaches their model through the skill's own text, the only way
// it can: the turn block that carries a rule is a foreground one). Nothing counted those loads, so the rule sat on trial for ever
// with `stats` null (live: 13 rules, 15-22 days). Now each run that loads the skill is one placement (`stats.injected`, and
// `injectedRuns` apart), once per run, and a placement is not a proof: the rule is still on trial with nothing followed.
// Crosses the background controller's run factory, createRnaRuntime's skill_load, the host ToolPolicy's after hook and the gene
// store. Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const NOTE = '\n\n## 先查原著风格\n- 动笔前先读参考作品对应章节的文风。';

test('a background run that loads the skill a trial rule is written into counts as putting it in front of its model; it is not a proof', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/a.md': 'Intro\n' } });
  const s = scenario(world);
  const genome = structuredClone(GENOME); genome.skills[0].instructions += NOTE;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  const skillId = prepared.skillManifests[0].id, at = new Date().toISOString();
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    project.activeVersionId = prepared.record.versionId;
    project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    project.genes = { generations: [{ n: 1, at, versionId: prepared.record.versionId, summary: '先查原著风格', geneIds: ['skill-patch:style'] }], genes: [
      { id: 'skill-patch:style', layer: 'skill', key: 'style', title: '先查原著风格', summary: '动笔前先读参考作品的文风', level: 0, generation: 1, status: 'trial', origin: { kind: 'correction', quote: '先查原著风格' }, body: { skillId: 'project-workflow', when: '写章节时', note: NOTE }, createdAt: at, history: [] },
    ] };
  });
  const rule = () => world.project().genes.genes.find(row => row.id === 'skill-patch:style');

  const first = await s.backgroundRun({ task: 'Write the chapter.', work: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, 'Wrote it.\nHandoff: nothing left to do.'] });
  await first.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.ok(work.some(row => row.wire.includes('动笔前先读参考作品对应章节的文风')), 'the rule reached the run\'s model through the skill\'s text');
    },
    state: () => {
      assert.deepEqual([rule().stats?.injected, rule().stats?.injectedRuns, rule().placedIn], [1, 1, [first.outcome.action.id]], 'one run, one placement');
      assert.deepEqual([rule().status, rule().level, rule().stats.applied ?? 0, rule().stats.recalled ?? 0, rule().stats.clean], ['trial', 0, 0, 0, 0], 'counted, never promoted: no user has judged it');
    },
  });

  // A second run is a second placement; the same run loading it twice would still be one (the unit test).
  const second = await s.backgroundRun({ task: 'Write the next chapter.', work: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, 'Wrote it.\nHandoff: nothing left to do.'] });
  await second.expect({ state: () => assert.deepEqual([rule().stats.injected, rule().stats.injectedRuns, rule().placedIn.length], [2, 2, 2]) });

  // A foreground turn that loads the skill has its own accounting (the turn block): this path does not count it.
  const foreground = await s.send('写第 3 章。', { reply: [{ toolCalls: [{ name: 'skill_load', args: { id: skillId } }] }, '第三章写好了。'] });
  await foreground.expect({ state: () => assert.equal(rule().stats.injectedRuns, 2) });
});
