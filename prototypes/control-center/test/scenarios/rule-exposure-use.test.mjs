// D4 scenario (P2 D1): the lessons the user taught and the working rules evolution wrote into skills reach the model by what the
// message calls for, and are judged by what the turn did. A real host; only the model and JEV are fake. Crosses the runtime
// (the turn.route request, the request hook, the hand-back), the project mind, the gene service, the decision service and JEV.
//   1. One user message: turn.route carries the rules (their bodies) beside its other questions; the confident yes ones ride the
//      turn block at the tail of the request — the working rule that is its own thing, the lesson the message names — and the
//      one a standing lesson carries stays out; the turn records what went in.
//   2. At the end of the turn one lesson.applied call reads the turn digest (the steps, the file it wrote and the start of what
//      it wrote) for everything in the turn's context; the counts are the judge's confident answers only.
//   3. An unrelated message puts no working rule in, and a rule that did not come up counts nothing.
//   4. A message that shares no word with a lesson is still asked about it (the judge, not a shared word, says what a message calls
//      for): the lesson rides the turn block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ensureMind, addLesson } from '../../project-mind.mjs';

const CHAPTER = 'Chapter twelve opens in the rain. Gu Zhao reads the glossary and names the new guard Lin Zhao. ';
const note = (title, text) => `\n\n## ${title}\n${text}`;

test('rules reach the model by what the message calls for and are judged by what the turn did', async t => {
  const world = await createWorld(t, { files: { 'README.md': '# Novel\n', 'glossary.md': 'Gu Zhao: the hero.\n' } });
  const s = scenario(world), ids = {};
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId), mind = ensureMind(project);
    ids.standing = addLesson(mind, { kind: 'preference', text: 'Always cite the source file by path.', scope: 'project', source: { kind: 'correction' } }).id;
    ids.pitfall = addLesson(mind, { kind: 'pitfall', text: 'Check the glossary before naming a character.', scope: 'project', source: { kind: 'correction' } }).id;
    const patch = (key, title, when, text, origin) => ({ id: `skill-patch:${key}`, layer: 'skill', key, title, summary: title, level: 0, status: 'trial', origin, body: { skillId: 'project-workflow', when, note: note(title, text) }, stats: null, createdAt: new Date().toISOString(), history: [] });
    project.genes = { generations: [], genes: [
      patch('beat', 'Beat list first', 'writing a chapter', '- write a beat list in notes before the chapter.', { kind: 'correction', quote: 'beats first' }),
      patch('release', 'Release notes', 'preparing a release', '- update CHANGELOG.md before tagging.', { kind: 'correction', quote: 'release notes' }),
      patch('cite', 'Cite files', 'writing a chapter', '- name the file every fact comes from.', { kind: 'lesson', lessonId: ids.standing, quote: 'cite' }),
    ] };
  });
  // JEV: the message calls for the glossary lesson and the beat-list rule, not the release rule; at the end of the turn it saw the
  // glossary lesson followed and the beat-list rule followed, and the standing rule had nothing to do with the turn.
  world.jev.answerAll((id, _question, body) => {
    const rulebook = body.state?.rulebook, lessons = body.state?.lessons, message = body.state?.turn?.message ?? '';
    // What a careful reader would say: the message about writing a chapter calls for the glossary lesson and the beat-list rule.
    if (/^rule_\d+$/.test(id)) return /glossary/.test(rulebook.lessons[Number(id.slice(5))].text) && /Write chapter|Draft scene/.test(message) ? .95 : .03;
    if (/^method_\d+$/.test(id)) return rulebook.methods[Number(id.slice(7))].title === 'Beat list first' && /Write chapter/.test(message) ? .93 : .03;
    if (/^use_\d+$/.test(id)) return /glossary/.test(lessons.rules[Number(id.slice(4))].text) && /Write chapter/.test(body.state?.reply?.request ?? '') ? 'followed' : 'not_relevant_here';
    if (/^usem_\d+$/.test(id)) return 'followed';
    // The turn is complete and waits for nothing: it ends after the model's own closing message.
    if (id === 'instruction_complete') return .97;
    if (id === 'waiting_on_user' || id === 'deferred_without_cause') return .03;
    return undefined;
  });

  const message = 'Write chapter twelve into chapters/12.md and check the glossary for the names.';
  const first = await s.send(message, { reply: [
    { toolCalls: [{ name: 'project_read', args: { path: 'glossary.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'chapters/12.md', content: CHAPTER.repeat(4) } }] },
    // Read back after the write: the delivery review asks for one more step when a turn writes and never looks again.
    { toolCalls: [{ name: 'project_read', args: { path: 'chapters/12.md' } }] },
    'Chapter twelve is written to chapters/12.md.'] });
  const turnId = first.outcome.turnId;
  await until(() => world.session().turns.find(row => row.id === turnId)?.mindContext?.judgedAt, 'the turn to be judged');
  await world.store.mind.idle();
  await first.expect({
    judgments: calls => {
      const route = calls.find(call => Object.hasOwn(call.questions ?? {}, 'rule_0'));
      assert.ok(route, 'the rules were asked about in a request');
      assert.ok(Object.hasOwn(route.questions, 'clarify_needed') || Object.hasOwn(route.questions, 'is_correction'), 'in the turn.route request, beside its other questions');
      assert.deepEqual(Object.keys(route.questions).filter(id => /^(rule|method)_/.test(id)).sort(), ['method_0', 'method_1', 'rule_0'], 'the rule the standing lesson carries is not asked about, and nor is the standing lesson');
      assert.deepEqual(route.state.rulebook.lessons.map(row => row.text), ['Check the glossary before naming a character.']);
      assert.deepEqual(route.state.rulebook.methods.map(row => [row.title, row.when, row.text]), [['Beat list first', 'writing a chapter', '- write a beat list in notes before the chapter.'], ['Release notes', 'preparing a release', '- update CHANGELOG.md before tagging.']], 'each rule with its body');
    },
    requests: rows => {
      const request = rows.find(row => /relevantMethods/.test(row.wire));
      assert.ok(request, 'the foreground request carried the turn block');
      const wire = request.wire, at = text => wire.indexOf(text);
      assert.ok(at('Beat list first') > at(message), 'at the tail, after the user message: never the cached prefix');
      assert.ok(at('write a beat list in notes') > at(message) && at('Check the glossary before naming a character.') > at(message));
      assert.ok(at('Release notes') < 0 && at('update CHANGELOG.md') < 0, 'a rule the message does not call for stays out');
      assert.ok(at('name the file every fact comes from') < 0, 'inject one, not both: the working rule the standing lesson carries stays out of the turn block');
      assert.ok(at('Always cite the source file by path.') >= 0, 'the standing lesson is in the context as before');
    },
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), turn = state.sessions[0].turns.find(row => row.id === turnId), context = turn.mindContext;
      assert.deepEqual(context.genesInjected, ['skill-patch:beat']); assert.deepEqual(context.genesVia, { 'skill-patch:cite': ids.standing }); assert.deepEqual(context.relevantIds, [ids.pitfall]);
      assert.deepEqual(context.use, { [ids.pitfall]: 'followed', [ids.standing]: 'not_relevant', 'skill-patch:beat': 'followed', 'skill-patch:cite': 'not_relevant' });
      const lesson = id => project.mind.lessons.find(row => row.id === id), gene = key => project.genes.genes.find(row => row.id === `skill-patch:${key}`);
      assert.deepEqual([lesson(ids.pitfall).uses.recalled, lesson(ids.pitfall).uses.applied], [1, 1]); assert.deepEqual([lesson(ids.standing).uses.recalled, lesson(ids.standing).uses.applied], [0, 0], 'a rule the turn had nothing to do with counts nothing');
      assert.deepEqual({ injected: gene('beat').stats.injected, recalled: gene('beat').stats.recalled, applied: gene('beat').stats.applied }, { injected: 1, recalled: 1, applied: 1 }, 'the rule starts to get stats');
      assert.equal(gene('cite').stats, null); assert.equal(gene('release').stats, null, 'never put in, never counted');
    },
  });

  // The end of the turn is judged after the hand-back (the digest takes what the turn wrote): one call covers everything in its context.
  const judged = world.jev.asked('use_0', 'usem_0');
  assert.equal(judged.length, 1, 'one call covers everything in the turn\'s context');
  const state = judged[0].state;
  assert.deepEqual(Object.keys(judged[0].questions).sort(), ['use_0', 'use_1', 'usem_0']);
  assert.equal(state.reply.request, message); assert.deepEqual(state.reply.firstSteps, ['read glossary.md -> ok', 'write chapters/12.md -> ok', 'read chapters/12.md -> ok']);
  assert.match(state.reply.wrote, /chapters\/12\.md/); assert.match(state.reply.written[0].text, /^Chapter twelve opens in the rain\./); assert.equal(state.reply.text, 'Chapter twelve is written to chapters/12.md.');
  assert.deepEqual(state.lessons.rules.map(row => row.text), ['Check the glossary before naming a character.', 'Always cite the source file by path.'], 'the lesson the message called for first, then the standing rule');
  assert.deepEqual(state.lessons.methods.map(row => row.title), ['Beat list first']);

  // An unrelated message: no working rule is put in, and what was in the turn's context but did not come up counts nothing.
  const second = await s.send('What is the hero called?', { reply: 'The hero is called Gu Zhao.' });
  const secondId = second.outcome.turnId;
  await until(() => world.session().turns.find(row => row.id === secondId)?.mindContext?.judgedAt, 'the second turn to be judged');
  await world.store.mind.idle();
  await second.expect({
    // The rules were asked about again (a lesson sharing the word "the" with the message is a candidate) and none was called for.
    judgments: calls => { const route = calls.find(call => Object.hasOwn(call.questions ?? {}, 'method_0')); assert.ok(route); assert.deepEqual(Object.keys(route.questions).filter(id => /^(rule|method)_/.test(id)), ['rule_0', 'method_0', 'method_1']); },
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), turn = state.sessions[0].turns.find(row => row.id === secondId);
      assert.equal(turn.mindContext.genesInjected, undefined); assert.deepEqual(turn.mindContext.use, { [ids.standing]: 'not_relevant', 'skill-patch:cite': 'not_relevant' });
      const beat = project.genes.genes.find(row => row.id === 'skill-patch:beat');
      assert.deepEqual({ injected: beat.stats.injected, recalled: beat.stats.recalled, applied: beat.stats.applied }, { injected: 1, recalled: 1, applied: 1 }, 'nothing counted again');
      assert.deepEqual(project.mind.lessons.find(row => row.id === ids.standing).uses, { recalled: 0, applied: 0, contradicted: 0 });
    },
  });
  const later = world.jev.asked('use_0', 'usem_0').slice(1);
  assert.equal(later.length, 1); assert.deepEqual(Object.keys(later[0].questions), ['use_0'], 'only the standing rule was in the second turn\'s context');

  // A message that shares no word with the glossary lesson ("Draft scene two now."): the lesson is still asked about, and the judge
  // says it applies, so it rides the turn block (D1 review: a keyword prefilter used to leave it out of the question altogether).
  const draft = 'Draft scene two now.';
  const third = await s.send(draft, { reply: 'Scene two is drafted.' });
  const thirdId = third.outcome.turnId;
  await until(() => world.session().turns.find(row => row.id === thirdId)?.mindContext?.judgedAt, 'the third turn to be judged');
  await world.store.mind.idle();
  await third.expect({
    judgments: calls => { const route = calls.find(call => call.state?.turn?.message === draft && Object.hasOwn(call.questions ?? {}, 'rule_0')); assert.ok(route, 'the lesson was asked about although it shares no word with the message'); assert.deepEqual(route.state.rulebook.lessons.map(row => row.text), ['Check the glossary before naming a character.']); },
    requests: rows => { const request = rows.find(row => row.wire.includes(draft) && /relevantLessons/.test(row.wire)); assert.ok(request, 'the request carried the lesson'); assert.ok(request.wire.lastIndexOf('Check the glossary before naming a character.') > request.wire.lastIndexOf(draft), 'at the tail, after this message (the first turn\'s copy is in the history)'); },
    state: state => { const turn = state.sessions[0].turns.find(row => row.id === thirdId); assert.deepEqual(turn.mindContext.relevantIds, [ids.pitfall]); assert.deepEqual(turn.mindContext.use, { [ids.standing]: 'not_relevant', 'skill-patch:cite': 'not_relevant', [ids.pitfall]: 'not_relevant' }); },
  });
});
