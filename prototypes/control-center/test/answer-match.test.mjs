import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, setup } from './helpers/gene-fixture.mjs';

// Plan §2.5 item 12 (answer.match): a message the user types while a question
// card is open answers the card when JEV is confident about every question.
const QUESTIONS = [{ id: 'title', question: '章节标题用什么格式？', options: [{ id: 'cn', label: '第X章 标题' }, { id: 'en', label: 'Chapter X' }] }];

test('answer.match: a typed answer closes the open card with the chosen option; no echo item, no second question', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const interactions = f.app.interactions ?? f.app.store.interactions;
  const record = interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'a1', questions: QUESTIONS });
  let asked;
  interactions.decisions = { answerMatch: async (_project, input) => { asked = input; return { picks: [0] }; } };
  const answered = await interactions.matchMessage(f.session.id, { text: '用第X章 标题那种', itemId: 'u1' });
  assert.deepEqual(answered, [record.id]); assert.equal(asked.questions[0].question, '章节标题用什么格式？');
  const session = f.app.store.state.sessions.find(row => row.id === f.session.id);
  const card = session.items.find(item => item.interaction?.id === record.id).interaction;
  assert.equal(card.status, 'answered'); assert.equal(card.answeredVia, 'message'); assert.deepEqual(card.answers, [{ id: 'title', selected: ['cn'] }]);
  assert.equal(session.items.filter(item => item.source === 'interaction-answer').length, 0, 'the user\'s own message stands for the answer');
  assert.deepEqual(await interactions.matchMessage(f.session.id, { text: '再说一遍' }), [], 'nothing open any more');
});

test('answer.match: own words become the text answer; an unsure or partial match leaves the card open; permission requests are never answered this way', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const interactions = f.app.interactions ?? f.app.store.interactions;
  const record = interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'a2', questions: [...QUESTIONS, { id: 'length', question: '每章多长？' }] });
  interactions.decisions = { answerMatch: async () => ({ picks: [1, null] }) };
  assert.deepEqual(await interactions.matchMessage(f.session.id, { text: '英文标题' }), [], 'one question unanswered: keep the card');
  interactions.decisions = { answerMatch: async () => ({ picks: [1, 'own'] }) };
  assert.deepEqual(await interactions.matchMessage(f.session.id, { text: '英文标题，每章五千字左右' }), [record.id]);
  const card = f.app.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.interaction?.id === record.id).interaction;
  assert.deepEqual(card.answers, [{ id: 'title', selected: ['en'] }, { id: 'length', selected: [], custom: '英文标题，每章五千字左右' }]);
  const permission = interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'a3', questions: [{ id: 'ok', question: '允许写入？', options: [{ id: 'y', label: '允许' }] }], metadata: { kind: 'permission', permission: { level: 'write' } } });
  let called = false; interactions.decisions = { answerMatch: async () => { called = true; return { picks: [0] }; } };
  assert.deepEqual(await interactions.matchMessage(f.session.id, { text: '允许' }), []); assert.equal(called, false);
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.interaction?.id === permission.id).interaction.status, 'pending');
});
