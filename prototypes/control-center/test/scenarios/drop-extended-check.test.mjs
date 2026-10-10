// D4 scenario (plan B2, EVO-6): a check the evolution extended in place is dropped from the tree (不再用). It leaves
// whole: the next request no longer declares its tool (the earlier version does not come back either), the bundle and
// the project's skill text lose it, and the conversation is told — including that the earlier version stopped. Crosses
// the gene routes, the genome bundle commit, the runtime's declared tools and the evolution announcement. Model only is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME, GUARD_SCRIPT } from '../helpers/gene-fixture.mjs';

const TOOL = { id: 'guard_nightwatch', name: '守夜与镇妖字样检查', description: 'Checks one chapter file for the banned terms 守夜 and 镇妖. Takes {path}.', permission: 'read',
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 400 } } }, script: GUARD_SCRIPT.replace('/守夜/', '/守夜|镇妖/'),
  smokeCases: [{ input: { path: 'sample.md' }, expected: { hits: [], summary: '未发现' }, workspace: { files: [{ path: 'sample.md', content: '第一章\n夜巡者。\n' }] } }] };
const EARLIER = { ...TOOL, name: '守夜字样检查', description: 'Checks one chapter file for the banned term 守夜. Takes {path}.', script: GUARD_SCRIPT };
const NOTE = '\n\n## 自动检查：「守夜」与「镇妖」字样检查\n正文里不得出现“守夜”或“镇妖”字样。', EARLIER_NOTE = '\n\n## 自动检查：「守夜」字样检查\n正文里不得出现“守夜”字样。';

test('dropping an extended check removes it whole: the next request no longer declares it and the conversation is told', async t => {
  const world = await createWorld(t, { files: { '正文/第001章.md': '第一章\n夜巡者站在城墙上。\n' } });
  const s = scenario(world);
  // The project as evolution left it: a check extended in place (its earlier version kept on the gene to undo).
  const genome = { ...structuredClone(GENOME), tools: [TOOL] }; genome.skills[0].instructions += NOTE;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: new Date().toISOString(), simulated: false }];
    project.activeVersionId = prepared.record.versionId;
    project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    project.genes = { generations: [{ n: 1, at: new Date().toISOString(), versionId: prepared.record.versionId, summary: '修改检查', geneIds: ['guard:guard_nightwatch'] }], genes: [{ id: 'guard:guard_nightwatch', layer: 'guard', key: TOOL.id, title: '「守夜」与「镇妖」字样检查', summary: '检查正文里有没有“守夜”或“镇妖”字样。', status: 'active', level: 0, generation: 1, origin: { kind: 'lesson', lessonId: 'later-rule', quote: '正文里也不得出现“镇妖”字样。' },
      body: { toolId: TOOL.id, trigger: { onWrite: ['正文/**/*.md'] }, skillId: 'project-workflow', note: NOTE, routeVersion: 5, matched: 1, before: { tool: EARLIER, note: EARLIER_NOTE, skillId: 'project-workflow', record: { title: '「守夜」字样检查', summary: '检查正文里有没有“守夜”字样。', status: 'active', level: 0, stats: null, body: { toolId: TOOL.id, trigger: { onWrite: ['正文/**/*.md'] }, skillId: 'project-workflow', note: EARLIER_NOTE } } } }, createdAt: new Date().toISOString(), history: [] }] };
  });

  const first = await s.send('写第二章的开头。', { reply: '好的，开头写好了。' });
  await first.expect({ requests: rows => assert.ok(rows.filter(row => row.tag === 'foreground').some(row => row.wire.includes(TOOL.id)), 'the check is declared while it is in force') });

  const dropped = await s.evolve('guard:guard_nightwatch', { action: 'revoke' });
  await dropped.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId), gene = project.genes.genes.find(row => row.id === 'guard:guard_nightwatch');
    assert.equal(gene.status, 'retired', 'dropped, not reverted to the earlier check');
    const bundle = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
    assert.deepEqual(bundle.tools.map(row => row.id), [], 'neither version of the check is left in the bundle');
    assert.ok(!bundle.skills[0].instructions.includes('自动检查'), 'and its note left the project skill');
    const told = state.sessions.find(row => row.id === world.sessionId).items.filter(item => item.source === 'initiative' && item.initiative?.gene === 'guard:guard_nightwatch');
    assert.equal(told.length, 1, 'the conversation is told once'); assert.match(told[0].text, /不再用了/); assert.match(told[0].text, /这项检查之前的版本也不再运行/);
    assert.ok(project.genes.generations.at(-1).announcedAt, 'its generation is marked announced');
  } });

  const next = await s.send('继续写。', { reply: '好。' });
  await next.expect({ requests: rows => { const [request] = rows.filter(row => row.tag === 'foreground'); assert.ok(request, 'a foreground request'); assert.ok(!request.wire.includes(TOOL.id), 'the dropped check is not declared again'); } });
});
