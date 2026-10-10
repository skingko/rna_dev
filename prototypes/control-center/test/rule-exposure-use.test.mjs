import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addLesson, selectLessons, exposureCandidates, chooseExposed, methodGenes, methodText, mindContextUpdates } from '../project-mind.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { writtenExcerpts, digestParts } from '../turn-digest.mjs';

// D1 (plan §2.2 D1): exposure and use of the lessons and the working rules (evolution's skill patches) as one system. The
// judge and the clock are local stubs; the store, the mind and the gene service are the real ones.

function setup(t, { lessons = [], genes = [], clock = Date.parse('2026-10-05T08:00:00Z') } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-d1-')), store = new Store(join(directory, 'state.json')), now = { value: clock };
  const { project, session } = store.createProject({ name: 'Novel', description: 'a long novel', workspace: directory });
  const ids = {};
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    Object.assign(p, { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false;
    const mind = ensureMind(p, now.value);
    for (const row of lessons) ids[row.key] = addLesson(mind, { kind: row.kind ?? 'preference', text: row.text, scope: 'project', source: row.source ?? { kind: 'correction' } }, { now: now.value }).id;
    p.genes = { genes: genes.map(gene => ({ id: `skill-patch:${gene.key}`, layer: 'skill', key: gene.key, title: gene.title, summary: gene.summary ?? gene.title, level: 0, status: gene.status ?? 'trial', origin: gene.origin ? { ...gene.origin, ...(gene.origin.lessonKey ? { lessonId: ids[gene.origin.lessonKey] } : {}) } : { kind: 'correction', quote: gene.title }, body: { skillId: 'project-workflow', when: gene.when ?? 'writing a chapter', note: `\n\n## ${gene.title}\n${gene.text ?? '- do the thing first.'}` }, stats: gene.stats ?? null, createdAt: new Date(now.value).toISOString(), history: [] })), generations: [] };
  });
  const current = () => store.state.projects.find(row => row.id === project.id), sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  const calls = [], invitations = [], decisions = { lessonApplied: async (_project, input) => { calls.push(input); return decisions.next?.(input) ?? null; }, next: null };
  const mind = new ProjectMindService(store, { decisions, sweepIntervalMs: 0, notesIntervalMs: 0, now: () => now.value });
  const genesService = new GeneEvolutionService(store, { decisions: {}, mind, enabled: false, now: () => now.value });
  genesService.invitations = { offerGene: (sessionId, row) => { invitations.push({ sessionId, ...row }); return { id: `inv-${invitations.length}` }; } };
  mind.genes = genesService;
  t.after(async () => { await mind.close(); rmSync(directory, { recursive: true, force: true }); });
  // One finished turn written through mutate(): the user's message, its steps, the reply.
  const turn = (text, { reply = 'Done.', steps = [], mindContext = null, status = 'completed' } = {}) => {
    const turnId = randomUUID(), userItemId = randomUUID(), at = new Date(now.value).toISOString();
    store.mutate(state => {
      const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: turnId, status, userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false, ...(mindContext ? { mindContext } : {}) });
      s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false });
      for (const tool of steps) s.items.push({ id: randomUUID(), turnId, kind: 'tool', tool: { status: 'succeeded', ...tool }, createdAt: at, simulated: false });
      if (reply) s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: reply, final: true, createdAt: at, simulated: false });
    });
    return turnId;
  };
  return { store, mind, genes: genesService, decisions, calls, invitations, project, session, ids, current, sessionOf, turn, now };
}
const geneOf = (app, key) => app.current().genes.genes.find(row => row.id === `skill-patch:${key}`);
const lessonOf = (app, key) => app.current().mind.lessons.find(row => row.id === app.ids[key]);
const verdict = (lessons, methods = []) => ({ lessons: lessons.map(use => ({ use })), methods: methods.map(use => ({ use })), ledgerId: 'la-1' });

test('exposure: a working rule a lesson in context already carries is not asked about; the rest are, the best-matching first when there are many', t => {
  const app = setup(t, {
    lessons: [{ key: 'standing', text: 'Always cite the source file by path.' }, { key: 'pitfall', kind: 'pitfall', text: 'Check the glossary before naming a character.' }, { key: 'gone', text: 'Never write in second person.' }],
    genes: [{ key: 'carried', title: 'Cite files', origin: { kind: 'lesson', lessonKey: 'standing' } }, { key: 'alone', title: 'Beat list first', text: '- write a beat list in notes before the chapter.' }, { key: 'orphan', title: 'Second person', origin: { kind: 'lesson', lessonKey: 'gone' } }],
  });
  app.store.mutate(state => { ensureMind(state.projects.find(row => row.id === app.project.id)).lessons.find(row => row.id === app.ids.gone).status = 'retired'; });
  const project = app.current(), prompt = 'name the new character in the glossary', selected = selectLessons(project, prompt, { now: app.now.value });
  const candidates = exposureCandidates(project, selected, prompt);
  assert.deepEqual(candidates.lessons.map(row => row.id), selected.candidates.map(row => row.id).slice(0, 12));
  assert.deepEqual(candidates.carried, { 'skill-patch:carried': app.ids.standing }, 'inject one, not both: the lesson carries the rule grown from it');
  assert.deepEqual(candidates.methods.map(row => row.id).sort(), ['skill-patch:alone', 'skill-patch:orphan'], 'a rule whose lesson is not in context stands on its own');
  assert.equal(methodText(candidates.methods.find(row => row.id === 'skill-patch:alone')), '- write a beat list in notes before the chapter.', 'the rule\'s own words, without its heading');
  // Beyond the limit, the working rules that share the most words with the message are asked about.
  const many = setup(t, { genes: Array.from({ length: 12 }, (_, index) => ({ key: `r${index}`, title: `Rule ${index}`, text: index === 9 ? '- check the glossary of invented place names.' : `- do step ${index} of the ritual.` })) });
  const few = exposureCandidates(many.current(), { always: [], candidates: [] }, 'look up the glossary entry for the place', { methodLimit: 3 });
  assert.equal(few.methods.length, 3); assert.equal(few.methods[0].id, 'skill-patch:r9');
});

test('exposure: a lesson that shares no word with the message is still asked about while there is room, the keyword hits first and then the newest; the no-judge fallback still gets only the hits', async t => {
  const app = setup(t, { lessons: [
    { key: 'hit', kind: 'pitfall', text: 'Check the glossary before naming a character.' }, { key: 'older', kind: 'pitfall', text: 'End each chapter on an open question.' },
    { key: 'newer', kind: 'pitfall', text: 'Keep dialogue tags short.' }, { key: 'newest', kind: 'pitfall', text: 'Read previous scene again before continuing.' }] });
  // Equal creation times would leave the order to the ids: make the order the lessons were written in explicit.
  app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); ['older', 'newer', 'newest'].forEach((key, index) => { mind.lessons.find(row => row.id === app.ids[key]).createdAt = new Date(app.now.value + (index + 1) * 1000).toISOString(); }); });
  app.now.value += 10000;
  const prompt = 'name the new character in the glossary', project = app.current(), selected = selectLessons(project, prompt, { now: app.now.value });
  assert.deepEqual(selected.candidates.map(row => row.id), [app.ids.hit], 'the fallback without a judge: only what shares a word with the message');
  assert.deepEqual(selected.others.map(row => row.id), [app.ids.newest, app.ids.newer, app.ids.older], 'the rest, newest first');
  assert.deepEqual(exposureCandidates(project, selected, prompt).lessons.map(row => row.id), [app.ids.hit, app.ids.newest, app.ids.newer, app.ids.older], 'all of them are asked about when there is room');
  assert.deepEqual(exposureCandidates(project, selected, prompt, { lessonLimit: 2 }).lessons.map(row => row.id), [app.ids.hit, app.ids.newest], 'with less room, the hits first, then the newest');
  // The judge says the lesson with no shared word is what the message calls for: it rides the turn block, and a refresh keeps it.
  const turnId = app.turn(prompt, { reply: '' }), exposure = app.mind.exposureFor({ sessionId: app.session.id, prompt });
  const index = exposure.candidates.lessons.findIndex(row => row.id === app.ids.newer), route = Promise.resolve({ ledgerId: 'r-1', exposure: { answered: true, lessons: [{ index, p: .9 }], methods: [] } });
  const turnBlock = JSON.parse((await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt, exposure: { ...exposure, route } }))[2].text);
  assert.deepEqual(turnBlock.relevantLessons.map(row => row.text), ['Keep dialogue tags short.']);
  assert.deepEqual(app.sessionOf().turns.find(row => row.id === turnId).mindContext.relevantIds, [app.ids.newer]);
  const again = JSON.parse((await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt, refresh: true }))[2].text);
  assert.deepEqual(again.relevantLessons.map(row => row.text), ['Keep dialogue tags short.'], 'the same lesson after a refresh (a revocation worked the blocks out again)');
});

test('exposure: the confident yes answers, at most five, the most confident first, lessons and working rules together', () => {
  const rows = prefix => Array.from({ length: 6 }, (_, index) => ({ id: `${prefix}${index}` }));
  const candidates = { lessons: rows('L'), methods: rows('M'), carried: {} };
  const chosen = chooseExposed(candidates, { lessons: [{ index: 0, p: .8 }, { index: 3, p: .99 }, { index: 5, p: .7 }], methods: [{ index: 1, p: .95 }, { index: 2, p: .9 }, { index: 4, p: .72 }] });
  assert.deepEqual(chosen.lessons.map(row => row.id), ['L0', 'L3'], 'candidates keep their order');
  assert.deepEqual(chosen.methods.map(row => row.id), ['M1', 'M2', 'M4']);
  assert.equal(chosen.lessons.length + chosen.methods.length, 5, 'five of the six answers: the least confident one is left out');
  assert.deepEqual(chooseExposed(candidates, { lessons: [], methods: [] }), { lessons: [], methods: [] });
});

test('injection: what the message calls for rides the turn block at the tail; the standing rules block stays as it was; the turn records what went in', async t => {
  const app = setup(t, {
    lessons: [{ key: 'standing', text: 'Always cite the source file by path.' }, { key: 'pitfall', kind: 'pitfall', text: 'Check the glossary before naming a character.' }],
    genes: [{ key: 'carried', title: 'Cite files', origin: { kind: 'lesson', lessonKey: 'standing' } }, { key: 'alone', title: 'Beat list first', text: '- write a beat list in notes before the chapter.' }],
  });
  const prompt = 'Write chapter twelve and check the glossary for the names', turnId = app.turn(prompt, { reply: '' });
  const exposure = app.mind.exposureFor({ sessionId: app.session.id, prompt });
  assert.ok(exposure, 'there are rules to ask about'); assert.deepEqual(exposure.candidates.methods.map(row => row.id), ['skill-patch:alone']);
  const route = Promise.resolve({ ledgerId: 'route-1', exposure: { answered: true, lessons: [{ index: 0, p: .9 }], methods: [{ index: 0, p: .85 }] } });
  const updates = await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt, exposure: { ...exposure, route } });
  const [rules, , turnBlock] = updates.map(row => JSON.parse(row.text));
  assert.deepEqual(rules.rules.map(row => row.text), ['Always cite the source file by path.']); assert.match(rules.instruction, /relevantMethods/);
  assert.deepEqual(turnBlock.relevantLessons.map(row => row.text), ['Check the glossary before naming a character.']);
  assert.deepEqual(turnBlock.relevantMethods, [{ id: 'skill-patch:alone', title: 'Beat list first', when: 'writing a chapter', text: '- write a beat list in notes before the chapter.' }]);
  const context = app.sessionOf().turns.find(row => row.id === turnId).mindContext;
  assert.deepEqual(context.genesInjected, ['skill-patch:alone']); assert.deepEqual(context.genesVia, { 'skill-patch:carried': app.ids.standing }, 'the rule the standing lesson carries rides on that lesson');
  assert.deepEqual(context.relevantIds, [app.ids.pitfall]); assert.deepEqual(context.lessonIds, [app.ids.standing, app.ids.pitfall]); assert.equal(context.exposure.ledgerId, 'route-1');
  assert.equal(geneOf(app, 'alone').stats.injected, 1); assert.equal(geneOf(app, 'carried').stats?.injected, undefined, 'a carried rule was not put in itself');
  assert.ok(lessonOf(app, 'pitfall').uses.recalled === 0 && lessonOf(app, 'standing').uses.recalled === 0, 'nothing is counted when a rule is put in');
  // The same turn's blocks worked out again after a revocation keep what its exposure chose, and count no second injection.
  app.store.mutate(state => { ensureMind(state.projects.find(row => row.id === app.project.id)).lessons.find(row => row.id === app.ids.pitfall).status = 'retired'; });
  const again = await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt, refresh: true });
  const refreshed = JSON.parse(again[2].text);
  assert.deepEqual(refreshed.relevantLessons, [], 'a revoked lesson is gone'); assert.deepEqual(refreshed.relevantMethods.map(row => row.id), ['skill-patch:alone'], 'the chosen working rule stays');
  assert.equal(geneOf(app, 'alone').stats.injected, 1);
});

test('injection: no verdict from the route (late, off, shadow) makes no second judgment and puts no working rule in; the lessons stay as without a judge', async t => {
  const app = setup(t, { lessons: [{ key: 'pitfall', kind: 'pitfall', text: 'Check the glossary before naming a character.' }], genes: [{ key: 'alone', title: 'Beat list first' }] });
  for (const route of [Promise.resolve(null), Promise.reject(new Error('timed out')), Promise.resolve({ ledgerId: 'r', exposure: { answered: false, lessons: [], methods: [] } }), Promise.resolve({ ledgerId: 'r' })]) {
    const prompt = 'name the character in the glossary', turnId = app.turn(prompt, { reply: '' }), exposure = app.mind.exposureFor({ sessionId: app.session.id, prompt });
    const turnBlock = JSON.parse((await app.mind.foregroundContext({ sessionId: app.session.id, turnId, prompt, exposure: { ...exposure, route } }))[2].text);
    assert.deepEqual(turnBlock.relevantLessons.map(row => row.text), ['Check the glossary before naming a character.']); assert.equal(turnBlock.relevantMethods, undefined);
    assert.equal(app.sessionOf().turns.find(row => row.id === turnId).mindContext.genesInjected, undefined);
  }
  assert.equal(geneOf(app, 'alone').stats, null, 'never put in, never counted');
});

test('use: the end of a turn judges every rule that was in its context from the turn digest and the start of what it wrote; only confident answers count', async t => {
  const app = setup(t, {
    lessons: [{ key: 'standing', text: 'Always cite the source file by path.' }, { key: 'pitfall', kind: 'pitfall', text: 'Check the glossary before naming a character.' }, { key: 'ignored', text: 'Never end a chapter on a cliffhanger.' }],
    genes: [{ key: 'carried', title: 'Cite files', origin: { kind: 'lesson', lessonKey: 'standing' } }, { key: 'alone', title: 'Beat list first', text: '- write a beat list in notes before the chapter.' }],
  });
  const body = 'Chapter twelve. The glossary lists Gu Zhao as the hero. '.repeat(30);
  const steps = [{ name: 'project_read', args: { path: 'glossary.md' }, kind: 'read', target: 'glossary.md' }, { name: 'project_write', args: { path: 'notes/beats-12.md', content: '- arrival\n- the gate' }, kind: 'write', target: 'notes/beats-12.md' }, { name: 'project_write', args: { path: 'chapters/12.md', content: body }, kind: 'write', target: 'chapters/12.md' }];
  const turnId = app.turn('Write chapter twelve', { reply: 'Chapter twelve is in chapters/12.md.', steps, mindContext: { lessonIds: [app.ids.standing, app.ids.pitfall, app.ids.ignored], relevantIds: [app.ids.pitfall], genesInjected: ['skill-patch:alone'], genesVia: { 'skill-patch:carried': app.ids.standing }, exposure: { lessons: 1, methods: 1 }, at: new Date(app.now.value).toISOString() } });
  // Order asked: the lesson the message called for, then the standing rules; the working rule rides apart.
  app.decisions.next = input => verdict(input.lessons.map(row => row.text.startsWith('Check') ? 'followed' : row.text.startsWith('Never') ? 'went_against' : 'not_relevant'), ['followed']);
  const outcome = await app.mind.afterReply({ sessionId: app.session.id, turnId });
  assert.equal(app.calls.length, 1, 'one call covers every rule in the turn\'s context');
  const [asked] = app.calls;
  assert.deepEqual(asked.lessons.map(row => row.text), ['Check the glossary before naming a character.', 'Always cite the source file by path.', 'Never end a chapter on a cliffhanger.']);
  assert.deepEqual(asked.methods.map(row => [row.title, row.when, row.text]), [['Beat list first', 'writing a chapter', '- write a beat list in notes before the chapter.']]);
  // The shared digest: the request, the steps (head and tail), what was written, the end of the reply; plus the start of what it wrote.
  assert.equal(asked.digest.request, 'Write chapter twelve'); assert.deepEqual(asked.digest.firstSteps, ['read glossary.md -> ok', 'write notes/beats-12.md -> ok', 'write chapters/12.md -> ok']);
  assert.equal(asked.digest.wrote, 'notes/beats-12.md, chapters/12.md'); assert.equal(asked.digest.reply, 'Chapter twelve is in chapters/12.md.');
  assert.deepEqual(asked.digest.excerpts.map(row => row.path), ['notes/beats-12.md', 'chapters/12.md']); assert.match(asked.digest.excerpts[1].text, /^Chapter twelve\. The glossary lists Gu Zhao/); assert.ok(asked.digest.excerpts[1].text.length <= 700 + 8);
  assert.deepEqual(outcome, { followed: [app.ids.pitfall], noted: app.ids.pitfall });
  const uses = key => lessonOf(app, key).uses;
  assert.deepEqual([uses('pitfall').recalled, uses('pitfall').applied], [1, 1]); assert.ok(lessonOf(app, 'pitfall').usedAt);
  assert.deepEqual([uses('ignored').recalled, uses('ignored').applied, uses('ignored').wentAgainst], [1, 0, 1], 'relevant and confidently ignored');
  assert.deepEqual([uses('standing').recalled, uses('standing').applied], [0, 0], 'a rule the turn had nothing to do with counts nothing');
  assert.deepEqual({ recalled: geneOf(app, 'alone').stats.recalled, applied: geneOf(app, 'alone').stats.applied }, { recalled: 1, applied: 1 });
  assert.equal(geneOf(app, 'carried').stats, null, 'its lesson was not relevant: the rule it carries counts nothing either');
  const context = app.sessionOf().turns.find(row => row.id === turnId).mindContext;
  assert.deepEqual(context.use, { [app.ids.pitfall]: 'followed', [app.ids.ignored]: 'went_against', [app.ids.standing]: 'not_relevant', 'skill-patch:alone': 'followed', 'skill-patch:carried': 'not_relevant' }); assert.equal(context.appliedLedgerId, 'la-1'); assert.ok(context.judgedAt);
  assert.equal(await app.mind.afterReply({ sessionId: app.session.id, turnId }), null, 'a turn is judged once'); assert.equal(app.calls.length, 1);
});

test('use: a working rule carried by a lesson takes its lesson\'s reading; an unsure answer, a failed turn and a turn that put nothing in front of the model count nothing', async t => {
  const app = setup(t, { lessons: [{ key: 'standing', text: 'Always cite the source file by path.' }], genes: [{ key: 'carried', title: 'Cite files', origin: { kind: 'lesson', lessonKey: 'standing' } }] });
  const context = { lessonIds: [app.ids.standing], relevantIds: [], genesVia: { 'skill-patch:carried': app.ids.standing }, at: new Date(app.now.value).toISOString() };
  app.decisions.next = () => verdict(['followed']);
  await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn('Summarise the plot', { mindContext: context }) });
  assert.deepEqual({ recalled: geneOf(app, 'carried').stats.recalled, applied: geneOf(app, 'carried').stats.applied, via: geneOf(app, 'carried').stats.viaLesson }, { recalled: 1, applied: 1, via: 1 });
  app.decisions.next = () => verdict(['unsure']);
  await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn('Summarise the plot again', { mindContext: context }) });
  assert.equal(geneOf(app, 'carried').stats.recalled, 1, 'an unsure answer changes nothing'); assert.equal(lessonOf(app, 'standing').uses.recalled, 1);
  const before = app.calls.length; app.decisions.next = () => verdict(['followed']);
  assert.equal(await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn('Fail', { status: 'failed', mindContext: context }) }), null, 'a turn that did not complete is not judged');
  assert.equal(await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn('Nothing in context', { mindContext: { lessonIds: [], commitmentIds: [] } }) }), null, 'a turn that put nothing in front of the model counts nothing');
  assert.equal(await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn('No record at all') }), null);
  assert.equal(app.calls.length, before, 'none of them asked the judge');
  assert.equal(lessonOf(app, 'standing').uses.applied, 1);
});

test('use: three confident follows make a trial rule active only when the message after the turn does not correct it; a correction on its point holds it back', async t => {
  const app = setup(t, { genes: [{ key: 'fine', title: 'Beat list first' }, { key: 'corrected', title: 'Name check', stats: { clean: 0, missed: 1, real: 0, falseMatches: 0 } }] });
  const put = ['skill-patch:fine', 'skill-patch:corrected'];
  app.genes.ready = () => true;
  app.decisions.next = () => verdict([], ['followed', 'followed']);
  for (let index = 0; index < 3; index++) await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn(`Chapter ${index}`, { mindContext: { lessonIds: [], genesInjected: put, at: new Date(app.now.value).toISOString() } }) });
  // The turn ended, three follows are counted, and nobody has said anything about the third turn yet: still on trial.
  assert.equal(geneOf(app, 'fine').stats.applied, 3); assert.equal(geneOf(app, 'fine').status, 'trial', 'promotion waits for the message after the turn (a correction of that very turn could still come)');
  const next = app.turn('Good, thanks');
  await app.genes.afterCapture({ projectId: app.project.id, sessionId: app.session.id, turnId: next, record: { correction: false }, text: 'Good, thanks' });
  assert.equal(geneOf(app, 'fine').status, 'active'); assert.match(geneOf(app, 'fine').history.at(-1).note, /3/);
  assert.equal(geneOf(app, 'corrected').status, 'trial', 'corrected on the same point before: not promoted'); assert.equal(geneOf(app, 'corrected').stats.applied, 3);
});

test('use: a correction on the point of a rule followed three times keeps it on trial and counts a miss; a correction on another point promotes nothing either', async t => {
  const app = setup(t, { genes: [{ key: 'late', title: 'Beat list first' }, { key: 'other', title: 'Name check' }] });
  app.genes.ready = () => true;
  app.decisions.next = () => verdict([], ['followed', 'followed']);
  const put = ['skill-patch:late', 'skill-patch:other'];
  for (let index = 0; index < 3; index++) await app.mind.afterReply({ sessionId: app.session.id, turnId: app.turn(`Chapter ${index}`, { mindContext: { lessonIds: [], genesInjected: put, at: new Date(app.now.value).toISOString() } }) });
  // The user corrects the third turn: on the point of the first rule, not on the point of the second.
  app.genes.decisions = { mindJudge: async (_project, input) => ({ same: input.lessons.map((row, index) => /Beat list/.test(row.text) ? index : -1).filter(index => index >= 0), contradicts: [], applies: [], notApplies: [], resolved: [] }), turnReview: async () => ({ review: false }) };
  const next = app.turn('No, the beats are still missing');
  await app.genes.afterCapture({ projectId: app.project.id, sessionId: app.session.id, turnId: next, record: { correction: true }, text: 'No, the beats are still missing' });
  assert.equal(geneOf(app, 'late').stats.missed, 1); assert.equal(geneOf(app, 'late').status, 'trial', 'followed three times and corrected on its point: not active');
  assert.equal(geneOf(app, 'other').status, 'trial', 'a corrected turn promotes nothing, whichever point it was about'); assert.equal(geneOf(app, 'other').stats.clean, 1, 'shown');
});

test('use: a working rule relevant eight times and never followed is put to the user to keep or retire, once; one that was followed is not', async t => {
  const app = setup(t, { genes: [{ key: 'ignored', title: 'Beat list first' }, { key: 'mixed', title: 'Name check' }] });
  const put = ['skill-patch:ignored', 'skill-patch:mixed'], turn = index => app.turn(`Chapter ${index}`, { mindContext: { lessonIds: [], genesInjected: put, at: new Date(app.now.value).toISOString() } });
  app.decisions.next = () => verdict([], ['went_against', 'followed']);
  for (let index = 0; index < 7; index++) await app.mind.afterReply({ sessionId: app.session.id, turnId: turn(index) });
  assert.equal(app.invitations.length, 0, 'seven is not enough');
  await app.mind.afterReply({ sessionId: app.session.id, turnId: turn(7) });
  assert.deepEqual(app.invitations.map(row => [row.geneId, row.action, row.usage, row.runs]), [['skill-patch:ignored', 'retire', 'never_followed', 8]]);
  assert.equal(geneOf(app, 'ignored').status, 'trial', 'asked, never retired'); assert.ok(geneOf(app, 'ignored').retireOffered);
  await app.mind.afterReply({ sessionId: app.session.id, turnId: turn(8) });
  assert.equal(app.invitations.length, 1, 'asked once');
});

test('correction: the working rules put in the corrected turn or read through the skill it loaded are the ones in play; a turn that carried none counts none; a load shows no use', async t => {
  const app = setup(t, { genes: [{ key: 'alone', title: 'Beat list first' }, { key: 'idle', title: 'Name check' }] });
  app.genes.ready = () => true;
  const turnId = app.turn('Write chapter 3', { mindContext: { lessonIds: [], genesInjected: ['skill-patch:alone'], at: new Date(app.now.value).toISOString() } }), next = app.turn('Good');
  const turnOf = id => app.sessionOf().turns.find(row => row.id === id), used = id => app.genes.usedGenes(app.current(), app.sessionOf(), turnOf(id)).map(row => row.id);
  assert.deepEqual(used(turnId), ['skill-patch:alone']);
  await app.genes.afterCapture({ projectId: app.project.id, sessionId: app.session.id, turnId: next, record: { correction: false }, text: 'Good' });
  assert.equal(geneOf(app, 'alone').stats.clean, 1, 'shown'); assert.equal(geneOf(app, 'idle').stats, null);
  // The model read the rules through the skill they were written into: a correction of that turn is about them (D1 review: dropping them let
  // the user reverse a rule the model had read without it being retired), but a load is not a use and shows none.
  const loaded = app.turn('Write chapter 4', { steps: [{ name: 'skill_load', args: { id: 'project-workflow' }, kind: 'skill' }] });
  assert.deepEqual(used(loaded).sort(), ['skill-patch:alone', 'skill-patch:idle']);
  assert.deepEqual(app.genes.usedGenes(app.current(), app.sessionOf(), turnOf(loaded), { loaded: false }), [], 'put in nothing: nothing to show');
  const after = app.turn('Fine');
  const result = await app.genes.afterCapture({ projectId: app.project.id, sessionId: app.session.id, turnId: after, record: { correction: false }, text: 'Fine' });
  assert.equal(result.used, 2); assert.equal(geneOf(app, 'alone').stats.clean, 1, 'a load shows no clean use'); assert.equal(geneOf(app, 'idle').stats, null);
  // A correction of that turn on the point of one of them counts against it; the other, a clean use only when the turn carried it.
  app.turn('Write chapter 5', { steps: [{ name: 'skill_load', args: { id: 'project-workflow' }, kind: 'skill' }] });
  const reversing = app.turn('No, the beat list again');
  app.genes.decisions = { mindJudge: async (_project, input) => ({ same: input.lessons.map((row, index) => /Beat list/.test(row.text) ? index : -1).filter(index => index >= 0), contradicts: [], applies: [], notApplies: [], resolved: [] }), turnReview: async () => ({ review: false }) };
  const corrected = await app.genes.afterCapture({ projectId: app.project.id, sessionId: app.session.id, turnId: reversing, record: { correction: true }, text: 'No, the beat list again' });
  assert.deepEqual(corrected.missed, ['skill-patch:alone']); assert.equal(geneOf(app, 'alone').stats.missed, 1); assert.equal(geneOf(app, 'idle').stats, null, 'the rule only loaded and not corrected shows no use');
});

test('review: a working rule that never reached a model does not count as already covering a correction; one the corrected turn loaded, or an older use, does', async t => {
  const stats = extra => ({ clean: 0, missed: 0, real: 0, falseMatches: 0, ...extra });
  const app = setup(t, { genes: [{ key: 'dead', title: 'Dead rule' }, { key: 'live', title: 'Live rule', stats: stats({ injected: 2 }) }, { key: 'via', title: 'Via rule', stats: stats({ recalled: 1 }) },
    { key: 'old', title: 'Old rule', stats: stats({ applied: 2 }) }, { key: 'older', title: 'Older rule', stats: stats({ clean: 3 }) }, { key: 'read', title: 'Read rule' }] });
  let existing;
  app.genes.decisions = { turnReview: async (_project, input) => { existing = input.existing; return { review: false }; } };
  await app.genes.judgeReview(app.current(), { request: 'r', reply: 'p', correction: 'again' });
  assert.deepEqual(existing.map(row => row.split('：')[0]).sort(), ['Live rule', 'Old rule', 'Older rule', 'Via rule'], 'a use recorded before D1 (applied, clean) shows the rule reached a model');
  // The corrected turn loaded the skill the last rule was written into (or had it put in): it reached a model in that very turn.
  const turnId = app.turn('Write chapter 3', { steps: [{ name: 'skill_load', args: { id: 'project-workflow' }, kind: 'skill' }] });
  const row = { sessionId: app.session.id, turnId };
  assert.deepEqual(app.genes.reachedIn(app.current(), row).sort(), ['skill-patch:dead', 'skill-patch:live', 'skill-patch:via', 'skill-patch:old', 'skill-patch:older', 'skill-patch:read'].sort(), 'every rule written into the loaded skill');
  await app.genes.judgeReview(app.current(), { request: 'r', reply: 'p', correction: 'again' }, { reached: app.genes.reachedIn(app.current(), row) });
  assert.ok(existing.some(text => text.startsWith('Read rule')) && existing.some(text => text.startsWith('Dead rule')), 'the turn that was corrected had them in front of it');
  assert.deepEqual(app.genes.reachedIn(app.current(), { sessionId: app.session.id, turnId: 'gone' }), [], 'no turn, none');
});

test('the digest helpers: what a turn wrote as text a judge can read, last files first-class, never kept', () => {
  const step = (name, args, status = 'succeeded') => ({ id: randomUUID(), turnId: 't', kind: 'tool', tool: { name, args, status } });
  const session = { items: [step('project_write', { path: 'a.md', content: 'first' }), step('project_edit', { path: 'b.md', edits: [{ oldText: 'x', newText: 'one' }] }), step('project_edit', { path: 'b.md', edits: [{ oldText: 'y', newText: 'two' }] }), step('project_write', { path: 'c.md', content: 'x'.repeat(2000) }), step('project_write', { path: 'd.md', content: 'failed' }, 'failed'), step('project_read', { path: 'e.md' }), step('project_write', { path: 'a.md', content: 'second' })] };
  const turn = { id: 't' }, excerpts = writtenExcerpts(session, turn, { files: 3, chars: 100 });
  assert.deepEqual(excerpts.map(row => row.path), ['b.md', 'c.md', 'a.md'], 'the last three files written, a later save of a file moves it last');
  assert.equal(excerpts[0].text, 'one\ntwo', 'edits to one file are joined'); assert.equal(excerpts[2].text, 'second', 'a save replaces what the file held');
  assert.ok(excerpts[1].text.length <= 100 + 8 && excerpts[1].text.includes('\n…\n'), 'a long file: its start and its end');
  assert.deepEqual(writtenExcerpts({ items: [] }, turn), []);
  // project_edit still takes the older single oldText/newText form (workspace-tools.mjs folds it in as one more edit).
  assert.deepEqual(writtenExcerpts({ items: [step('project_edit', { path: 'f.md', oldText: 'a', newText: 'older form' }), step('project_edit', { path: 'f.md', edits: [{ oldText: 'b', newText: 'newer form' }] })] }, turn), [{ path: 'f.md', text: 'older form\nnewer form' }]);
  const parts = digestParts({ request: 'r', steps: ['a', 'b'], skipped: 0, written: ['a.md'], writtenTotal: 3, status: 'stopped', reply: 'ok' }, { excerpts });
  assert.deepEqual([parts.wrote, parts.ended, parts.excerpts.length], ['a.md (+2 more)', 'stopped', 3]);
});

test('the turn block lists working rules only when there are some, and an empty one replaces an earlier copy', () => {
  const update = rows => mindContextUpdates({ rules: [], relevant: [], methods: rows }).find(row => row.key === 'project-mind-turn');
  const withRules = update([{ id: 'skill-patch:x', title: 'Beat list first', body: { when: 'writing', note: '## Beat list first\n- do it.' } }].map(gene => ({ id: gene.id, title: gene.title, body: gene.body })));
  assert.equal(withRules.empty, false); assert.equal(JSON.parse(withRules.text).relevantMethods[0].text, '- do it.');
  const none = update([]); assert.equal(none.empty, true); assert.equal(JSON.parse(none.text).relevantMethods, undefined);
  assert.equal(methodGenes({ genes: { genes: [{ id: 'skill-patch:x', layer: 'skill', status: 'retired', body: { note: 'n' } }, { id: 'skill-patch:y', layer: 'skill', status: 'trial', body: { note: '' } }, { id: 'guard:g', layer: 'guard', status: 'active', body: { note: 'n' } }] } }).length, 0);
});
