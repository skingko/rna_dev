// D4 scenario (P2 D1 review): a trial working rule that the turn's judge saw followed three times is not made active when the
// third turn ends — the user may correct that very turn next ("no same-point correction" is read from the message after it).
// A real host; only the model and JEV are fake. Crosses the runtime (the turn.route exposure, the hand-back), the project mind
// (lesson.applied at the end of the turn, rule counts), the capture of the next message and the gene service's correction
// judgment (afterCapture).
//   1. Three turns put the rule in front of the model and the judge sees it followed in each: three confident follows, still on trial.
//   2. The user's next message corrects the third turn on the rule's point: a miss is counted and the rule stays on trial.
//   3. Three more followed turns and a message that corrects nothing: now it is active (the control for step 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ensureMind } from '../../project-mind.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const note = '\n\n## Beat list first\n- write a beat list in notes before the chapter.';
const RULE = 'skill-patch:beat';

test('a trial rule followed three times stays on trial when the next message corrects it, and becomes active when the next message corrects nothing', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n' } });
  const s = scenario(world);
  // A project whose evolution has a rule has a genome (the rule is written into its skill) and a mind (the turn block is the mind's).
  const genome = structuredClone(GENOME); genome.skills[0].instructions += note;
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome }); await prepared.commit();
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId), at = new Date().toISOString();
    ensureMind(project);
    project.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    project.activeVersionId = prepared.record.versionId;
    project.assignments = { ...project.assignments, skillIds: prepared.skillManifests.map(row => row.id) };
    project.genes = { generations: [{ n: 1, at, versionId: prepared.record.versionId, summary: '做法', geneIds: [RULE] }], genes: [{ id: RULE, layer: 'skill', key: 'beat', title: 'Beat list first', summary: 'Beat list first', level: 0, status: 'trial', origin: { kind: 'correction', quote: 'beats first' }, body: { skillId: 'project-workflow', when: 'writing a chapter', note }, stats: null, createdAt: new Date().toISOString(), history: [] }] };
  });
  // JEV: a message about writing a chapter calls for the rule; at the end of the turn it was followed; "No, ..." corrects the
  // turn before it on the rule's point; the others correct nothing.
  world.jev.answerAll((id, _question, body) => {
    const message = body.state?.turn?.message ?? body.state?.capture?.message ?? body.state?.message ?? '';
    if (/^method_\d+$/.test(id)) return /Write chapter/.test(message) ? .93 : .03;
    if (/^usem_\d+$/.test(id)) return 'followed';
    if (id === 'is_correction') return /^No,/.test(message) ? .95 : .03;
    if (id === 'same_0') return body.state?.mind?.lessons?.[0]?.kind === 'skill' ? .95 : undefined;
    if (id === 'contradicts_0' || id === 'refines_0') return body.state?.mind?.lessons?.[0]?.kind === 'skill' ? .03 : undefined;
    if (id === 'instruction_complete') return .97;
    if (id === 'waiting_on_user' || id === 'deferred_without_cause') return .03;
    return undefined;
  });
  const rule = () => world.project().genes.genes.find(row => row.id === RULE);
  const write = async number => {
    const step = await s.send(`Write chapter ${number}.`, { reply: `Chapter ${number} is written.` });
    await until(() => world.session().turns.find(row => row.id === step.outcome.turnId)?.mindContext?.judgedAt, `turn ${number} to be judged`);
    await world.store.mind.idle();
    return step;
  };

  for (const number of [1, 2, 3]) await write(number);
  assert.deepEqual({ injected: rule().stats.injected, applied: rule().stats.applied }, { injected: 3, applied: 3 }, 'three confident follows');
  assert.equal(rule().status, 'trial', 'the user has not yet said whether the third turn was right');

  await s.send('No, the beat list is still missing.', { reply: 'Sorry, I will write the beat list first.' });
  await world.quiet();
  assert.equal(rule().stats.missed, 1, 'corrected on its point');
  assert.equal(rule().status, 'trial', 'followed three times and corrected on its point: not active');

  // The control: with no miss on record, three more followed turns and a message that corrects nothing make it active.
  world.store.mutate(state => { const row = state.projects.find(item => item.id === world.projectId).genes.genes.find(item => item.id === RULE); row.stats.missed = 0; });
  for (const number of [4, 5, 6]) await write(number);
  await s.send('Thanks, that works.', { reply: 'Glad it works.' });
  await world.quiet();
  assert.equal(rule().status, 'active', 'three confident follows and the next message corrected nothing');
  assert.match(rule().history.at(-1).note, /3|三/);
});
