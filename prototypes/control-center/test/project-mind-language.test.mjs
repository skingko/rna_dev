import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectMindService, ensureMind, addLesson, addAgenda, addCommitment, updatePlan, emptyMind, patchMindEntry, createMindEntry, deleteMindEntry, publicMind, mindBackgroundView } from '../project-mind.mjs';
import { agendaForUser, agendaModelText, agendaUserText } from '../agenda-text.mjs';

// MIND-17: the text the user reads (question cards, answer options, reasons, API errors, the agenda line of an evolution
// request) follows settings.interfaceLanguage; the text the model reads (the project_plan tool) is fixed English. With zh,
// the default, every user-visible string is what it was before. Option ids never change with the language: answers match by id.
// No model, no JEV, no network: the mind service runs with no provider and no judge.
const CLOCK = Date.parse('2026-10-09T01:00:00Z');
const CJK = /[一-鿿]/;
function setup(t, language = 'zh') {
  const dir = mkdtempSync(join(tmpdir(), 'rna-mind-lang-')), store = new Store(join(dir, 'state.json')), clock = { value: CLOCK };
  const { project, session } = store.createProject({ name: 'Ink jump game', workspace: dir });
  store.mutate(state => {
    if (language) state.settings.interfaceLanguage = language;
    Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false;
  });
  const mind = new ProjectMindService(store, { decisions: null, provider: null, now: () => clock.value, sweepIntervalMs: 0, notesIntervalMs: 3600000 });
  mind.interactions = new UserInteractionService(store);
  t.after(async () => { mind.interactions.close?.(); await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  const turn = (text, { status = 'completed' } = {}) => {
    const ids = { turnId: randomUUID(), userItemId: randomUUID() }, at = new Date(clock.value).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: ids.turnId, status, userItemId: ids.userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false });
      s.items.push({ id: ids.userItemId, turnId: ids.turnId, kind: 'user', text, createdAt: at, simulated: false }); });
    return ids;
  };
  // Rows the judge would have flagged: a lesson to confirm, a plan item and a question the user must answer.
  const seed = () => {
    const made = {};
    store.mutate(state => {
      const mind = ensureMind(state.projects.find(row => row.id === project.id));
      made.lesson = addLesson(mind, { text: 'Check the ending first', kind: 'pitfall' }, { now: clock.value }); made.lesson.needsConfirmation = true;
      made.plan = addAgenda(mind, { text: 'Write chapter 9', kind: 'todo' }, { now: clock.value }); made.plan.blocking = true;
      made.question = addAgenda(mind, { text: 'Which platform?', kind: 'awaiting_user' }, { now: clock.value }); made.question.blocking = true;
    });
    return { lesson: made.lesson.id, plan: made.plan.id, question: made.question.id };
  };
  const cards = () => sessionOf().items.filter(item => item.interaction).map(item => item.interaction);
  const row = (collection, id) => current().mind[collection].find(entry => entry.id === id);
  return { dir, store, mind, project, session, current, sessionOf, turn, seed, cards, row, clock };
}
const flat = card => [card.questions.map(question => [question.header, question.question, ...(question.options ?? []).flatMap(option => [option.label, option.description ?? ''])])].flat(3).join('\n');

test('MIND-17 cards: a lesson card and a plan card read in the interface language, and the option ids are the same in both', async t => {
  const zh = setup(t, 'zh'), en = setup(t, 'en'), unset = setup(t, null);
  const asked = {};
  for (const [name, app] of [['zh', zh], ['en', en], ['unset', unset]]) {
    const ids = app.seed();
    await app.mind.askMind(app.project.id, 'lessons', ids.lesson); await app.mind.askMind(app.project.id, 'agenda', ids.plan);
    const [lesson, plan] = app.cards(); asked[name] = { lesson: lesson.questions[0], plan: plan.questions[0] };
  }
  // zh (and an unset language) are what the cards said before this change, byte for byte.
  for (const name of ['zh', 'unset']) {
    assert.equal(asked[name].lesson.header, '确认学到的经验');
    assert.equal(asked[name].lesson.question, '我记下了一条易错点：「Check the ending first」。以后按这个来吗？也可以直接写下更准确的说法。');
    assert.deepEqual(asked[name].lesson.options, [{ id: 'confirm', label: '确认，以后照这样做' }, { id: 'revoke', label: '不再适用', description: '停用这条经验' }]);
    assert.equal(asked[name].plan.header, '议程需要你定');
    assert.equal(asked[name].plan.question, '议程里的「Write chapter 9」接下来怎么处理？也可以直接说说你的想法。');
    assert.deepEqual(asked[name].plan.options, [{ id: 'keep', label: '继续推进', description: '保留在议程里，按现在的方向做' }, { id: 'done', label: '已经完成', description: '从议程中移走' }, { id: 'drop', label: '不再需要', description: '放弃这件事' }]);
  }
  // en: English all the way through (the fixture rows carry no CJK, so any CJK here is a host string left behind).
  assert.equal(asked.en.lesson.header, 'Confirm the lesson learned');
  assert.equal(asked.en.lesson.question, 'I noted a pitfall: "Check the ending first". Should I work this way from now on? You can also write a more accurate version.');
  assert.deepEqual(asked.en.lesson.options, [{ id: 'confirm', label: 'Confirm, work this way from now on' }, { id: 'revoke', label: 'No longer applies', description: 'Turn this lesson off' }]);
  assert.equal(asked.en.plan.header, 'The agenda needs your call');
  assert.equal(asked.en.plan.question, 'What should happen next with "Write chapter 9" on the agenda? You can also just tell me what you think.');
  assert.deepEqual(asked.en.plan.options.map(option => option.label), ['Keep going', 'Already done', 'No longer needed']);
  for (const card of [asked.en.lesson, asked.en.plan]) assert.ok(!CJK.test(flat({ questions: [card] })), 'no CJK on an English card');
  // The ids are what an answer is matched by: identical across languages.
  assert.deepEqual(asked.en.lesson.options.map(option => option.id), asked.zh.lesson.options.map(option => option.id));
  assert.deepEqual(asked.en.plan.options.map(option => option.id), asked.zh.plan.options.map(option => option.id));
  assert.equal(asked.en.lesson.allowCustom, true);
});

test('MIND-17 cards: a waiting question and the batch card of open questions are headed and offered a skip in the interface language', async t => {
  const day = 86400000;
  const result = {};
  for (const language of ['zh', 'en']) {
    const app = setup(t, language), ids = app.seed();
    // Without a model no options are drafted: the bare question card.
    await app.mind.askMind(app.project.id, 'agenda', ids.question);
    const [single] = app.cards();
    // A second open question, older than a day and not blocking, goes to the batch card.
    app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === app.project.id)); const stale = addAgenda(mind, { text: 'Which channel?', kind: 'awaiting_user' }, { now: CLOCK - 2 * day }); stale.createdAt = new Date(CLOCK - 2 * day).toISOString(); stale.blocking = false; });
    const batchId = await app.mind.askOpenQuestions(app.project.id);
    const batch = app.cards().find(card => card.id === batchId);
    result[language] = { single: single.questions[0], batch: batch.questions[0] };
  }
  assert.equal(result.zh.single.header, '等你回应'); assert.equal(result.en.single.header, 'Waiting for you');
  assert.equal(result.zh.batch.header, '等你回应'); assert.equal(result.en.batch.header, 'Waiting for you');
  assert.deepEqual(result.zh.batch.options, [{ id: 'skip', label: '先跳过', description: '暂时不用答，我按现状继续；这一条以后不再问' }]);
  assert.deepEqual(result.en.batch.options, [{ id: 'skip', label: 'Skip for now', description: 'No need to answer yet; I will carry on as things stand, and this one will not be asked again' }]);
  assert.equal(result.en.batch.options[0].id, result.zh.batch.options[0].id);
  assert.ok(!CJK.test(flat({ questions: [result.en.single, result.en.batch] })));
});

test('MIND-17 reasons: choosing "no longer needed" or cancelling a question records the reason in the interface language, and the answer matches by option id', async t => {
  for (const [language, dropped, cancelled] of [['zh', '你选择不再需要', '你取消了这个问题'], ['en', 'You chose that it is no longer needed', 'You cancelled this question']]) {
    const app = setup(t, language), ids = app.seed();
    await app.mind.askMind(app.project.id, 'agenda', ids.plan); await app.mind.askMind(app.project.id, 'agenda', ids.question);
    const [planCard, questionCard] = app.cards();
    app.mind.interactions.answer(app.session.id, planCard.id, { requestId: 'r1', answers: [{ id: 'answer', selected: ['drop'], custom: '' }] });
    app.mind.interactions.cancel(app.session.id, questionCard.id, { requestId: 'r2' });
    app.mind.settleAnswered(); await app.mind.idle();
    assert.deepEqual([app.row('agenda', ids.plan).status, app.row('agenda', ids.plan).reason], ['dropped', dropped]);
    assert.deepEqual([app.row('agenda', ids.question).status, app.row('agenda', ids.question).reason], ['dropped', cancelled]);
    if (language === 'en') assert.ok(!CJK.test(app.row('agenda', ids.plan).reason + app.row('agenda', ids.question).reason));
  }
  // "Already done" settles the same way whatever the label says.
  for (const language of ['zh', 'en']) {
    const app = setup(t, language), ids = app.seed();
    await app.mind.askMind(app.project.id, 'agenda', ids.plan);
    app.mind.interactions.answer(app.session.id, app.cards()[0].id, { requestId: 'r1', answers: [{ id: 'answer', selected: ['done'], custom: '' }] });
    app.mind.settleAnswered();
    assert.equal(app.row('agenda', ids.plan).status, 'done');
  }
});

test('MIND-17 reasons: the answer to a waiting question joins the chosen option and the typed text with the language\'s own separator', async t => {
  for (const [language, joined] of [['zh', 'Desktop；and tablets'], ['en', 'Desktop; and tablets']]) {
    const app = setup(t, language), ids = app.seed();
    app.mind.modelJson = async () => ({ options: [{ label: 'Desktop' }, { label: 'Mobile' }] });
    await app.mind.askMind(app.project.id, 'agenda', ids.question);
    const card = app.cards()[0];
    assert.deepEqual(card.questions[0].options.map(option => option.id), ['o1', 'o2'], 'drafted options keep their ids');
    app.mind.interactions.answer(app.session.id, card.id, { requestId: 'r1', answers: [{ id: 'answer', selected: ['o1'], custom: 'and tablets' }] });
    app.mind.settleAnswered(); await app.mind.idle();
    assert.equal(app.row('agenda', ids.question).answer, joined);
  }
});

test('MIND-17 reasons: a failed or stopped turn names itself in the interface language; an evolution request\'s agenda line is stored in English (the model reads it) and shown to the user in the interface language', async t => {
  for (const [language, failed, stopped] of [['zh', '本轮执行失败（provider_error）', '本轮被中止'], ['en', 'This turn failed (provider_error)', 'This turn was stopped']]) {
    const app = setup(t, language);
    const a = app.turn('write chapter 14 and send it to me', { status: 'failed' }), b = app.turn('write chapter 15 and send it to me', { status: 'stopped' });
    app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).turns.find(row => row.id === a.turnId).errorCode = 'provider_error'; });
    await app.mind.afterTurn({ sessionId: app.session.id, turnId: a.turnId }); await app.mind.afterTurn({ sessionId: app.session.id, turnId: b.turnId });
    const reasons = Object.fromEntries(app.current().mind.commitments.filter(row => row.trigger === 'failed_turn').map(row => [row.request, row.reason]));
    assert.equal(reasons['write chapter 14 and send it to me'], failed); assert.equal(reasons['write chapter 15 and send it to me'], stopped);
  }
  for (const [language, shown] of [['zh', '进化请求：optimize your prompt so you stop repeating yourself'], ['en', 'Evolution request: optimize your prompt so you stop repeating yourself']]) {
    const app = setup(t, language), run = app.turn('optimize your prompt so you stop repeating yourself');
    await app.mind.capture({ sessionId: app.session.id, turnId: run.turnId, route: null, input: { outputs: [], threads: [], questions: [], requests: [] } });
    const line = app.current().mind.agenda.find(row => row.source?.from === 'evolution_request');
    assert.equal(line?.text, 'Evolution request: optimize your prompt so you stop repeating yourself', 'stored English whatever the interface language: the model reads this line');
    assert.equal(publicMind(app.current(), { language }).agenda.find(row => row.id === line.id).text, shown, 'the user\'s view follows the interface language (zh is the line as it always was)');
    assert.equal(publicMind(app.current()).agenda.find(row => row.id === line.id).text, '进化请求：optimize your prompt so you stop repeating yourself', 'zh is the default');
  }
});

test('MIND-17 the evolution-request agenda line: a legacy Chinese-prefixed row reads as English to the model and renders in either language; an edited row is left as the user wrote it', async t => {
  const app = setup(t, 'en');
  let legacy, edited, plain;
  app.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === app.project.id));
    legacy = addAgenda(mind, { kind: 'intention', text: '进化请求：tighten the replies', source: { from: 'evolution_request' } }, { now: CLOCK });
    edited = addAgenda(mind, { kind: 'intention', text: 'Make replies shorter', source: { from: 'evolution_request' } }, { now: CLOCK });
    plain = addAgenda(mind, { kind: 'todo', text: '进化请求：typed by the user as an ordinary item' }, { now: CLOCK });
  });
  const view = publicMind(app.current(), { language: 'en' }).agenda, viewZh = publicMind(app.current(), { language: 'zh' }).agenda, text = (rows, id) => rows.find(row => row.id === id).text;
  assert.equal(text(view, legacy.id), 'Evolution request: tighten the replies'); assert.equal(text(viewZh, legacy.id), '进化请求：tighten the replies');
  assert.equal(text(view, edited.id), 'Make replies shorter'); assert.equal(text(viewZh, edited.id), 'Make replies shorter');
  assert.equal(text(view, plain.id), '进化请求：typed by the user as an ordinary item', 'only rows that came from an evolution request are rewritten');
  const model = mindBackgroundView(app.current(), { now: CLOCK }).agenda;
  assert.equal(text(model, legacy.id), 'Evolution request: tighten the replies', 'the model sees the English prefix on a legacy row');
  assert.equal(text(model, edited.id), 'Make replies shorter'); assert.equal(text(model, plain.id), '进化请求：typed by the user as an ordinary item');
  assert.equal(agendaModelText(app.current().mind.agenda.find(row => row.id === legacy.id)), 'Evolution request: tighten the replies');
  assert.equal(agendaUserText(app.current().mind.agenda.find(row => row.id === edited.id), 'zh'), 'Make replies shorter');
  assert.deepEqual(agendaForUser(undefined, 'zh'), undefined);
});

test('MIND-17 the project_plan tool is written for the model: a fixed English description with no CJK, errors in English, whatever the interface language is', async t => {
  for (const language of ['zh', 'en']) {
    const app = setup(t, language), [tool] = app.mind.planTools({ projectId: app.project.id });
    assert.equal(tool.name, 'project_plan');
    assert.ok(!CJK.test(tool.description), 'the description has no CJK');
    assert.match(tool.description, /working plan/); assert.match(tool.description, /doing, next, done, dropped/); assert.match(tool.description, /not a message to the user/);
    assert.ok(!CJK.test(JSON.stringify(tool.parameters)));
    await assert.rejects(() => tool.execute('call', { items: [{ text: 'x', status: 'later' }] }), error => !CJK.test(error.message) && /status/.test(error.message));
    await assert.rejects(() => app.mind.planTools({ projectId: 'missing' })[0].execute('call', { items: [{ text: 'x', status: 'next' }] }), /^Error: Project not found$/);
  }
  const mind = emptyMind(0), message = fn => { try { fn(); } catch (error) { return error.message; } return null; };
  assert.equal(message(() => updatePlan(mind, [{ status: 'next' }])), 'A new plan item needs text');
  assert.equal(message(() => updatePlan(mind, [{ id: 'missing', status: 'done' }])), 'The plan has no item missing');
  assert.equal(message(() => updatePlan(mind, [{ text: 'x', status: 'later' }])), 'Each item needs a status: doing, next, done or dropped');
  assert.equal(message(() => updatePlan(mind, new Array(13).fill({ text: 'x', status: 'next' }))), 'items must be an array of at most 12 entries');
  for (let index = 0; index < 20; index += 1) { const error = message(() => updatePlan(mind, [{ text: `step ${index}`, status: 'next' }])); if (error) { assert.match(error, /^The plan already has \d+ unfinished items; finish or drop some first$/); break; } }
});

test('MIND-17 API errors: the HTTP-reachable mind methods report in the interface language (zh by default), with the same status codes', async t => {
  const error = fn => { try { fn(); } catch (caught) { return caught; } return null; };
  const project = { mind: emptyMind(0) }, mind = project.mind;
  const row = addLesson(mind, { text: 'Check the ending first' }, { now: CLOCK });
  const table = [
    ['unknown category on patch', language => patchMindEntry(project, 'bogus', 'x', {}, { language }), 404, '未知的心智分类', 'Unknown mind category'],
    ['missing entry on patch', language => patchMindEntry(project, 'lessons', 'nope', { text: 'x' }, { language }), 404, '条目不存在', 'Entry not found'],
    ['bad key on patch', language => patchMindEntry(project, 'lessons', row.id, { bogus: 1 }, { language }), 400, '只能修改：text、kind、scope、taskTypes、status、until、stale', 'Only these can be edited: text, kind, scope, taskTypes, status, until, stale'],
    ['invalid value on patch', language => patchMindEntry(project, 'lessons', row.id, { kind: 'bogus' }, { language }), 400, 'kind 无效', 'kind is invalid'],
    ['empty text on patch', language => patchMindEntry(project, 'lessons', row.id, { text: '  ' }, { language }), 400, 'text 无效', 'text is invalid'],
    ['stale on patch', language => patchMindEntry(project, 'notes', 'x', { stale: true }, { language }), 400, 'stale 只能为 null', 'stale can only be null'],
    ['text only on notes patch', language => patchMindEntry(project, 'notes', 'x', { bogus: 1 }, { language }), 400, '只能修改 text', 'Only text can be edited'],
    ['not creatable', language => createMindEntry(project, 'threads', { text: 'x' }, { language }), 405, '该分类不支持直接创建', 'This category does not support direct creation'],
    ['bad create keys', language => createMindEntry(project, 'lessons', { bogus: 1 }, { language }), 400, '只能包含：text、kind、scope、taskTypes、until（text 必填）', 'Only these are allowed: text, kind, scope, taskTypes, until (text is required)'],
    ['bad create value', language => createMindEntry(project, 'lessons', { text: 'x', kind: 'bogus' }, { language }), 400, 'kind 无效', 'kind is invalid'],
    ['empty lesson', language => createMindEntry(project, 'lessons', { text: '  ' }, { language }), 400, '经验内容不能为空', 'The lesson text cannot be empty'],
    ['empty agenda', language => createMindEntry(project, 'agenda', { text: '  ' }, { language }), 400, '议程内容不能为空', 'The agenda text cannot be empty'],
    ['empty commitment', language => createMindEntry(project, 'commitments', { text: '  ' }, { language }), 400, '承诺内容不能为空', 'The commitment text cannot be empty'],
    ['empty note', language => createMindEntry(project, 'notes', { text: '  ' }, { language }), 400, '内容不能为空', 'The content cannot be empty'],
    ['duplicate note', language => { createMindEntry(project, 'notes', { text: 'Likes tea' }, { language }); createMindEntry(project, 'notes', { text: 'Likes tea' }, { language }); }, 409, '这条笔记已存在', 'This note already exists'],
    ['unknown category on delete', language => deleteMindEntry(project, 'bogus', 'x', { language }), 404, '未知的心智分类', 'Unknown mind category'],
    ['missing entry on delete', language => deleteMindEntry(project, 'lessons', 'nope', { language }), 404, '条目不存在', 'Entry not found'],
  ];
  for (const [name, call, status, zh, en] of table) {
    const byDefault = error(() => call(undefined)), inEnglish = error(() => call('en')), inChinese = error(() => call('zh'));
    assert.deepEqual([byDefault?.message, byDefault?.status], [zh, status], `${name}: default is zh`);
    assert.deepEqual([inChinese?.message, inChinese?.status], [zh, status], `${name}: zh`);
    assert.deepEqual([inEnglish?.message, inEnglish?.status], [en, status], `${name}: en`);
    assert.ok(!CJK.test(inEnglish.message), `${name}: no CJK in English`);
  }
  // The pure writers take the language too.
  const plain = { lessons: [], agenda: [], commitments: [] };
  assert.throws(() => addLesson(plain, { text: '' }, { language: 'en' }), /^Error: The lesson text cannot be empty$/); assert.throws(() => addLesson(plain, { text: '' }), /经验内容不能为空/);
  assert.throws(() => addAgenda(plain, { text: '' }, { language: 'en' }), /^Error: The agenda text cannot be empty$/); assert.throws(() => addCommitment(plain, { request: '' }, { language: 'en' }), /^Error: The commitment text cannot be empty$/);
});

test('MIND-17 API errors: answerAgenda, feedback and reconcile read the language the app is set to', async t => {
  const outcome = fn => { try { return fn(); } catch (caught) { return caught; } };
  for (const [language, expected] of [['zh', { badBody: '请求只能包含 text（1–4000 字）', project: '项目不存在', entry: '条目不存在', closed: '这一项已经结束', vote: '请求只能包含 vote（up、down 或 null）与可选 comment', session: '会话不存在', rating: '只能评价已完成的助手消息', reconcile: '项目不存在' }], ['en', { badBody: 'The request may only contain text (1–4000 characters)', project: 'Project not found', entry: 'Entry not found', closed: 'This item is already closed', vote: 'The request may only contain vote (up, down or null) and an optional comment', session: 'Session not found', rating: 'Only a finished assistant message can be rated', reconcile: 'Project not found' }]]) {
    const app = setup(t, language), ids = app.seed();
    assert.equal(outcome(() => app.mind.answerAgenda(app.project.id, ids.question, { text: '' })).message, expected.badBody);
    assert.equal(outcome(() => app.mind.answerAgenda('missing', ids.question, { text: 'a' })).message, expected.project);
    assert.equal(outcome(() => app.mind.answerAgenda(app.project.id, 'missing', { text: 'a' })).message, expected.entry);
    app.store.mutate(state => { ensureMind(state.projects.find(row => row.id === app.project.id)).agenda.find(row => row.id === ids.plan).status = 'done'; });
    assert.equal(outcome(() => app.mind.answerAgenda(app.project.id, ids.plan, { text: 'a' })).message, expected.closed);
    const assistant = randomUUID();
    app.store.mutate(state => { state.sessions.find(row => row.id === app.session.id).items.push({ id: assistant, kind: 'assistant', text: 'streaming', streaming: true, simulated: false, createdAt: new Date(CLOCK).toISOString() }); });
    assert.equal(outcome(() => app.mind.feedback(app.session.id, assistant, { vote: 'maybe' })).message, expected.vote);
    assert.equal(outcome(() => app.mind.feedback('missing', assistant, { vote: 'up' })).message, expected.session);
    assert.equal(outcome(() => app.mind.feedback(app.session.id, 'missing', { vote: 'up' })).message, expected.entry);
    assert.equal(outcome(() => app.mind.feedback(app.session.id, assistant, { vote: 'up' })).message, expected.rating);
    await assert.rejects(() => app.mind.reconcile('missing'), error => error.message === expected.reconcile && error.status === 404);
  }
});

test('MIND-17 API errors: the mind entry routes pass the interface language, so POST, PATCH and DELETE answer in it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-mind-lang-api-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project } = app.store.createProject({ name: 'Mind API language', workspace: directory });
  const origin = `http://127.0.0.1:${app.server.address().port}`, base = `/api/v2/projects/${project.id}/mind`;
  const call = async (method, path, body) => { const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  const errors = async () => [
    await call('POST', `${base}/lessons`, { text: '  ' }), await call('PATCH', `${base}/lessons/missing`, { text: 'x' }), await call('DELETE', `${base}/agenda/missing`),
  ].map(reply => [reply.status, reply.body.error]);
  assert.deepEqual(await errors(), [[400, '经验内容不能为空'], [404, '条目不存在'], [404, '条目不存在']], 'unset is zh, as before');
  app.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.deepEqual(await errors(), [[400, 'The lesson text cannot be empty'], [404, 'Entry not found'], [404, 'Entry not found']]);
});
