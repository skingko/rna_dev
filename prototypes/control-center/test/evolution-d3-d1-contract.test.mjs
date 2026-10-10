import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind } from '../project-mind.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';

// P2 batch D, D3 reads what D1 (rule exposure and use) writes — and nothing else. The other D3 tests build their turns and counts by
// hand, so they could not notice D3 reading a name D1 never writes; this one drives D1's REAL writers (the turn block's injection,
// the end-of-turn use judgment) and reads the bloat rule, the exposure view and the page's per-rule line off what they left.
// D3 and D1 are separate branches: until D1 is in the tree the writers do not exist and this test says so and skips.
const D1 = typeof ProjectMindService.prototype.exposureFor === 'function' && typeof GeneEvolutionService.prototype.recordInjected === 'function' && typeof GeneEvolutionService.prototype.recordRuleUse === 'function';
const DAY = 86400000;

test('D1 writes what D3 reads: stats.injected is exposure, stats.recalled is relevance, mindContext.exposure marks a judged turn — the bloat rule, the exposure view and the page line follow', { skip: !D1 && 'D1 (rule exposure and use) is not in this tree' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-d3-d1-')), store = new Store(join(directory, 'state.json')), now = { value: Date.parse('2026-10-05T08:00:00Z') };
  const { project, session } = store.createProject({ name: 'Novel', description: 'a long novel', workspace: directory });
  const keys = ['ignored', 'followed', 'quiet1', 'quiet2'];
  store.mutate(state => {
    const row = state.projects.find(item => item.id === project.id);
    Object.assign(row, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(item => item.id === session.id).simulated = false; ensureMind(row, now.value);
    // Four working rules written five days ago; the prompt has grown to 1.65 times its first size.
    row.genes = { genes: keys.map(key => ({ id: `skill-patch:${key}`, layer: 'skill', key, title: `Rule ${key}`, summary: `Rule ${key}`, level: 0, status: 'trial', origin: { kind: 'correction', quote: key }, body: { skillId: 'project-workflow', when: 'writing a chapter', note: `\n\n## Rule ${key}\n- ${key} comes first.` }, stats: null, createdAt: new Date(now.value - 5 * DAY).toISOString(), history: [] })),
      generations: [{ n: 1, at: new Date(now.value - 6 * DAY).toISOString(), promptChars: 1000 }, { n: 2, at: new Date(now.value - 5 * DAY).toISOString(), promptChars: 1650 }] };
  });
  const decisions = { lessonApplied: async (_project, input) => ({ lessons: input.lessons.map(() => ({ use: 'not_relevant' })), methods: input.methods.map(row => ({ use: row.title === 'Rule ignored' ? 'went_against' : row.title === 'Rule followed' ? 'followed' : 'not_relevant' })), ledgerId: 'la-1' }) };
  const mind = new ProjectMindService(store, { decisions, sweepIntervalMs: 0, notesIntervalMs: 0, now: () => now.value });
  const genes = new GeneEvolutionService(store, { decisions: {}, mind, enabled: false, now: () => now.value });
  genes.invitations = { offerGene: () => ({ id: 'inv' }) }; mind.genes = genes;
  t.after(async () => { await mind.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), rule = key => current().genes.genes.find(row => row.id === `skill-patch:${key}`);
  const turn = (prompt, at) => {
    const turnId = randomUUID(), userItemId = randomUUID(), iso = new Date(at).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id); s.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: iso, completedAt: iso, modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text: prompt, createdAt: iso, simulated: false }); s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: 'Done.', final: true, createdAt: iso, simulated: false }); });
    return turnId;
  };
  // Nine turns, each judged for exposure by D1's route: the first two working rules put in front of the model every time (indexes of the candidates in order); then the use judgment.
  for (let index = 0; index < 9; index++) {
    now.value += 60000;
    const prompt = `write chapter ${index} and keep every rule`, turnId = turn(prompt, now.value), exposure = mind.exposureFor({ sessionId: session.id, prompt });
    assert.ok(exposure, 'there are working rules to ask about');
    const wanted = exposure.candidates.methods.map(row => ['skill-patch:ignored', 'skill-patch:followed'].includes(row.id) ? { index: exposure.candidates.methods.indexOf(row), p: .9 } : null).filter(Boolean);
    await mind.foregroundContext({ sessionId: session.id, turnId, prompt, exposure: { ...exposure, route: Promise.resolve({ ledgerId: 'r', exposure: { answered: true, lessons: [], methods: wanted } }) } });
    await mind.afterReply({ sessionId: session.id, turnId });
  }
  // D1's own counts: put in front of the model nine times each; judged relevant nine times each ('went against' and 'followed'); only one was followed.
  assert.deepEqual([rule('ignored').stats.injected, rule('ignored').stats.recalled, rule('ignored').stats.applied ?? 0, rule('ignored').stats.notFollowed], [9, 9, 0, 9]);
  assert.deepEqual([rule('followed').stats.injected, rule('followed').stats.recalled, rule('followed').stats.applied], [9, 9, 9]);
  assert.equal(rule('quiet1').stats ?? null, null, 'never put in front of the model: nothing counted');
  const judgedTurns = store.state.sessions.find(row => row.id === session.id).turns.filter(row => row.mindContext?.exposure);
  assert.equal(judgedTurns.length, 9); assert.ok(judgedTurns.every(row => row.mindContext.genesInjected.length === 2));

  // D3 reads those: exposure is `stats.injected`, relevance is its own number, and the two quiet rules were put in by none of nine judged turns.
  const evidence = genes.bloatEvidence(current());
  const byId = Object.fromEntries(evidence.rules.map(row => [row.id, row]));
  assert.deepEqual([byId['skill-patch:ignored'].shown, byId['skill-patch:ignored'].applied, byId['skill-patch:ignored'].unproven], [9, 0, true], 'shown nine times, never followed: earned nothing');
  assert.deepEqual([byId['skill-patch:followed'].shown, byId['skill-patch:followed'].unproven], [9, false], 'followed: earned its place');
  assert.deepEqual([byId['skill-patch:quiet1'].shown, byId['skill-patch:quiet1'].observed, byId['skill-patch:quiet1'].unproven], [null, 9, true], 'put in front of the model by none of the nine judged turns since it was written');
  assert.deepEqual(evidence.unproven.map(row => row.id).sort(), ['skill-patch:ignored', 'skill-patch:quiet1', 'skill-patch:quiet2']);
  assert.equal(genes.bloatDue(current()), false, 'three rules are not four');
  const view = genes.injectedRecent(current(), now.value);
  assert.deepEqual([view.get('skill-patch:ignored'), view.get('skill-patch:followed'), view.get('skill-patch:quiet1')], [9, 9, undefined], 'the page counts the turns that put each rule in front of the agent');
  // A fourth rule that earned nothing makes it four, and the growth is 1.65 times: the focused analysis is due.
  store.mutate(state => { const row = state.projects.find(item => item.id === project.id); row.genes.genes.find(item => item.id === 'skill-patch:followed').stats = { injected: 9, recalled: 9, applied: 0, notFollowed: 9 }; });
  assert.equal(genes.bloatDue(current()), true, 'four rules shown or observed many times and never followed, on a prompt grown by half');
});
