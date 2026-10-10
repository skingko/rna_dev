import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';
import { turnEffects, previousFeedback } from '../runtime-controller.mjs';
import { offerInvitation, closeInvitation, expireFeedbackInvitations, invitationMetrics } from '../session-invitations.mjs';
import { createMindEntry } from '../project-mind.mjs';

// Plan 2026-09-30 §2.1 / §2.5: the user never has to say "continue" for work
// they already asked for, and questions about how we work together appear as
// light invitations above the composer. No network and no paid model calls:
// the model is a local HTTP fixture and JEV is a stub on the decision service.
async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(15); }
  throw new Error('condition did not settle');
}
function stream(res, content, { tool } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) chunk({ tool_calls: [{ index: 0, id: `tool-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  else chunk({ content });
  chunk({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  res.end('data: [DONE]\n\n');
}
async function setup(t, respond, { settled } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-settled-')), calls = [], judged = [];
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    calls.push(raw ? JSON.parse(raw) : {});
    await respond(calls.at(-1), response, calls.length);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 500, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = app.store.createProject({ name: 'Novel', workspace: directory, initiative: { enabled: false } });
  if (settled) app.executor.decisions.settled = async (_project, input) => { judged.push(input); return settled(input, judged.length, { app, project, session }); };
  const current = () => app.store.state.sessions.find(item => item.id === session.id);
  const url = path => `http://127.0.0.1:${app.server.address().port}${path}`;
  return { app, calls, judged, current, session, project, directory, url };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('unfinished work continues in the same turn without the user saying continue; a feedback invitation follows a settled reply', async t => {
  const f = await setup(t, (input, res, count) => {
    if (count === 1) return stream(res, '', { tool: { name: 'project_write', args: { path: 'ch6.md', content: '第六章' } } });
    if (count === 2) return stream(res, '第 6 章写完了。说“继续”我再写 7–10 章。');
    if (count === 3) {
      // The host continuation reaches the model as a recorded observation, not a user message.
      assert.match(JSON.stringify(input.messages), /Carry on with the remaining requested work/);
      return stream(res, '', { tool: { name: 'project_write', args: { path: 'ch7.md', content: '第七章' } } });
    }
    return stream(res, '第 6–10 章都写完了。');
  }, { settled: (input, n) => n === 1 ? { continue: true, dropSchedule: false, feedback: false, complete: false, waiting: false, deferred: true, finished: false, ledgerId: 'j1' } : { continue: false, dropSchedule: false, feedback: true, complete: true, waiting: false, deferred: false, finished: true, ledgerId: 'j2' } });
  f.app.store.message(f.session.id, { text: '继续完成 6-10 章' });
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  const turn = f.current().turns[0];
  assert.equal(turn.status, 'completed', JSON.stringify(f.current().items.filter(item => item.kind === 'notice')));
  assert.equal(f.calls.length, 4); assert.equal(f.judged.length, 2);
  assert.equal(turn.settle.continued, 1);
  // MIND-19: the latest turn.settled conclusion stays on the turn (the mind reads it, not the rolling decision ledger).
  assert.deepEqual({ ...turn.settledVerdict, at: undefined }, { finished: true, complete: true, waiting: false, waitingForUser: null, deferred: false, promise: null, ledgerId: 'j2', at: undefined });
  assert.match(f.judged[0].request, /继续完成 6-10 章/); assert.match(f.judged[0].reply, /说“继续”/);
  assert.ok(f.judged[0].effects.some(line => line.startsWith('project_write ch6.md')), JSON.stringify(f.judged[0].effects));
  // No user-visible message was invented for the continuation.
  assert.equal(f.current().items.filter(item => item.kind === 'user').length, 1);
  const last = f.current().items.findLast(item => item.kind === 'assistant');
  const [invitation] = f.current().invitations;
  assert.equal(invitation.kind, 'feedback'); assert.equal(invitation.itemId, last.id); assert.equal(invitation.ledgerId, 'j2');
  // A vote from the strip (or the footer) answers it, everywhere.
  const voted = await post(f.url(`/api/v2/sessions/${f.session.id}/items/${last.id}/feedback`), { vote: 'down', comment: '太啰嗦' });
  assert.equal(voted.status, 200);
  assert.deepEqual(f.current().invitations, []);
  assert.equal(f.current().invitationHistory.at(-1).outcome, 'answered');
  // The rating shapes the next turn once, as tail context.
  const note = previousFeedback({ ...f.current(), turns: [...f.current().turns, { id: 'next' }] }, 'next');
  assert.match(note.text, /not_helpful/); assert.match(note.text, /太啰嗦/);
});

test('a continuation that changed nothing is not repeated, and a schedule made in the turn only to postpone the work is removed', async t => {
  let app, project, session, scheduleId, earlier;
  const f = await setup(t, (input, res, count) => {
    // Stands in for the model saving a "continue tomorrow at 9" schedule during its first reply.
    if (count === 1) scheduleId = app.executor.projectSchedules.create(project.id, { title: '明早续写', task: '续写 8-10 章', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { source: 'conversation', sessionId: session.id, requestId: 'in-turn' }).id;
    stream(res, '先写到这里，明早 9 点自动续跑。');
  }, { settled: () => ({ continue: true, dropSchedule: true, feedback: false, ledgerId: 'j' }) });
  ({ app, project, session } = f);
  earlier = app.executor.projectSchedules.create(project.id, { title: '每周复盘', task: '复盘', rule: { kind: 'weekly', time: '10:00', timeZone: 'Asia/Shanghai', days: [1] } }, { source: 'conversation', sessionId: session.id, requestId: 'before' }).id;
  await delay(5);
  app.store.message(session.id, { text: '把 8-10 章写完' });
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  const turn = f.current().turns[0];
  assert.equal(turn.status, 'completed');
  // Continued once; the next reply changed nothing, so it stopped instead of circling.
  assert.equal(turn.settle.continued, 1); assert.equal(f.calls.length, 2); assert.equal(f.judged.length, 2);
  assert.equal(f.judged[0].scheduled, true);
  assert.deepEqual(turn.settle.removedSchedules, ['明早续写']);
  const schedules = app.store.state.projects.find(row => row.id === project.id).schedules;
  assert.equal(schedules.some(row => row.id === scheduleId), false);
  assert.ok(schedules.some(row => row.id === earlier), 'a schedule from before this turn is never touched');
});

test('turnEffects summarizes what a turn did from tool records, reads as counts', () => {
  const messages = [
    { role: 'assistant', id: 'a', content: [{ type: 'toolCall', id: 'r', name: 'project_read', arguments: { path: 'a.md' } }, { type: 'toolCall', id: 'w', name: 'project_write', arguments: { path: 'b.md' } }, { type: 'toolCall', id: 'x', name: 'project_exec', arguments: { command: 'npm test' } }] },
    { role: 'toolResult', assistantId: 'a', toolCallId: 'r', toolName: 'project_read' },
    { role: 'toolResult', assistantId: 'a', toolCallId: 'w', toolName: 'project_write' },
    { role: 'toolResult', assistantId: 'a', toolCallId: 'x', toolName: 'project_exec', isError: true },
  ];
  assert.deepEqual(turnEffects(messages), ['read files 1 times, searched 0 times', 'project_write b.md', 'project_exec npm test (failed)']);
});

test('invitations: one subject is offered once, feedback only concerns the latest reply, a new message lapses it', () => {
  const session = { id: 's' }, now = Date.parse('2026-09-30T10:00:00Z');
  const first = offerInvitation(session, { kind: 'feedback', subject: 'feedback:i1', itemId: 'i1' }, { now });
  assert.ok(first);
  assert.equal(offerInvitation(session, { kind: 'feedback', subject: 'feedback:i1', itemId: 'i1' }, { now }), null);
  offerInvitation(session, { kind: 'lesson', subject: 'lesson:l1', lessonId: 'l1' }, { now });
  offerInvitation(session, { kind: 'feedback', subject: 'feedback:i2', itemId: 'i2' }, { now });
  assert.deepEqual(session.invitations.map(row => row.subject), ['lesson:l1', 'feedback:i2']);
  assert.equal(session.invitationHistory[0].outcome, 'expired');
  closeInvitation(session, session.invitations[0].id, 'dismissed', { now });
  assert.equal(offerInvitation(session, { kind: 'lesson', subject: 'lesson:l1', lessonId: 'l1' }, { now }), null, 'a dismissed subject is never asked again');
  expireFeedbackInvitations(session, { now });
  assert.deepEqual(session.invitations, []);
  assert.deepEqual(invitationMetrics([session]), { feedback: { offered: 2, answered: 0, dismissed: 0, expired: 2, open: 0 }, lesson: { offered: 1, answered: 0, dismissed: 1, expired: 0, open: 0 } });
});

test('a lesson to confirm becomes an invitation; answering rewrites it, closing keeps it unconfirmed and never re-asks', async t => {
  const f = await setup(t, (input, res) => stream(res, 'ok'));
  const lessons = [];
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    for (const text of ['章节标题用“第X章-标题”格式', '对话里少用感叹号']) { const row = createMindEntry(project, 'lessons', { text, kind: 'preference' }); lessons.push(row.id); }
    for (const row of project.mind.lessons) row.needsConfirmation = true;
  });
  // A conversation exists, so the invitation lands where the user already is.
  f.app.store.message(f.session.id, { text: 'hi' });
  await until(() => f.current().turns[0]?.status === 'completed');
  for (const id of lessons) await f.app.mind.askMind(f.project.id, 'lessons', id);
  const open = f.current().invitations.filter(row => row.kind === 'lesson');
  assert.equal(open.length, 2);
  assert.equal(f.current().items.filter(item => item.kind === 'question').length, 0, 'no question card for a lesson');
  const rewrite = await post(f.url(`/api/v2/sessions/${f.session.id}/invitations/${open[0].id}`), { action: 'answer', choice: 'rewrite', text: '章节标题统一用“第X章 标题”' });
  assert.equal(rewrite.status, 200);
  const dismiss = await post(f.url(`/api/v2/sessions/${f.session.id}/invitations/${open[1].id}`), { action: 'dismiss' });
  assert.equal(dismiss.status, 200);
  const mind = f.app.store.state.projects.find(row => row.id === f.project.id).mind;
  const rewritten = mind.lessons.find(row => row.id === lessons[0]), closed = mind.lessons.find(row => row.id === lessons[1]);
  assert.equal(rewritten.text, '章节标题统一用“第X章 标题”'); assert.ok(rewritten.confirmedAt); assert.equal(rewritten.needsConfirmation, undefined);
  assert.equal(closed.status, 'active'); assert.equal(closed.confirmedAt, undefined); assert.equal(closed.needsConfirmation, undefined); assert.ok(closed.interaction.settledAt);
  assert.deepEqual(f.current().invitations, []);
  // The card settler leaves invitation-backed lessons alone, and they are not asked again.
  f.app.mind.settleAnswered();
  await f.app.mind.askMind(f.project.id, 'lessons', lessons[1]);
  assert.deepEqual(f.current().invitations, []);
  const invalid = await post(f.url(`/api/v2/sessions/${f.session.id}/invitations/unknown-id`), { action: 'bogus' });
  assert.equal(invalid.status, 400);
});

test('a correction sent while the reply is still streaming stops it and the turn continues with the correction', async t => {
  let closed = false;
  const f = await setup(t, async (input, res, count) => {
    if (count === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('close', () => { closed = true; });
      const chunk = content => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      chunk('第一章：他走进了雨里');
      for (let index = 0; index < 400 && !closed; index++) { await delay(10); if (!closed) chunk('，'); }
      if (!closed) res.end('data: [DONE]\n\n');
      return;
    }
    assert.match(JSON.stringify(input.messages.at(-1)), /改成第一人称/);
    stream(res, '好，改成第一人称：我走进了雨里。');
  }, { settled: () => ({ continue: false, dropSchedule: false, feedback: false }) });
  f.app.executor.decisions.interjection = async (_project, input) => { assert.match(input.progress, /他走进了雨里/); return { interrupt: true }; };
  f.app.store.message(f.session.id, { text: '写第一章' });
  await until(() => f.current().items.some(item => item.kind === 'assistant' && /他走进了雨里/.test(item.text ?? '')) || f.app.executor.running.get(f.session.id)?.phase === 'writing');
  await until(() => f.app.executor.running.get(f.session.id)?.phase === 'writing');
  f.app.store.message(f.session.id, { text: '不对，改成第一人称', delivery: 'steer' });
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  const turn = f.current().turns[0];
  assert.equal(turn.status, 'completed'); assert.equal(turn.interjections, 1);
  assert.equal(f.calls.length, 2); assert.ok(closed, 'the first stream was cut off');
  assert.match(f.current().items.findLast(item => item.kind === 'assistant').text, /我走进了雨里/);
});

test('a plain reply cut off by the output limit carries on where it stopped, without a judgment call', async t => {
  const f = await setup(t, (input, res, count) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (count === 1) { chunk({ role: 'assistant', content: '第一段写到一半' }); chunk({}, 'length'); }
    else { assert.match(JSON.stringify(input.messages), /cut off by the output length limit/); chunk({ role: 'assistant', content: '，接着写完。' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  }, { settled: () => ({ continue: false, dropSchedule: false, feedback: false }) });
  f.app.store.message(f.session.id, { text: '写一段' });
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  assert.equal(f.current().turns[0].status, 'completed'); assert.equal(f.calls.length, 2);
  assert.equal(f.judged.length, 1, 'only the finished reply is judged');
  assert.equal(f.current().items.filter(item => item.kind === 'user').length, 1);
});

test('a question with a careful default is not shown; the model states its default and carries on', async t => {
  const f = await setup(t, (input, res, count) => {
    if (count === 1) return stream(res, '', { tool: { name: 'ask_user', args: { questions: [{ id: 'fmt', question: '章节标题用什么格式？', options: [{ id: 'a', label: '第X章 标题' }, { id: 'b', label: 'Chapter X' }] }] } } });
    const result = input.messages.find(message => message.role === 'tool');
    assert.match(String(result.content), /not_asked/);
    stream(res, '按“第X章 标题”的格式写好了（可以随时改）。');
  }, { settled: () => ({ continue: false, dropSchedule: false, feedback: false }) });
  const asked = [];
  f.app.interactions.necessity = async input => { asked.push(input.questions[0].question); return { verdict: true, ledgerId: 'nec-1' }; };
  f.app.store.message(f.session.id, { text: '写第一章' });
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  assert.equal(f.current().turns[0].status, 'completed');
  assert.deepEqual(asked, ['章节标题用什么格式？']);
  assert.equal(f.current().items.filter(item => item.kind === 'question').length, 0, 'no question card');
  // The skipped question stays on the turn so the user's next message can label the judgment.
  assert.deepEqual(f.current().turns[0].judgments, [{ point: 'ask.necessity', ledgerId: 'nec-1', skipped: 'default' }]);
});

test('feedback notes: one about this reply only writes no lesson; a standing wish becomes a lesson whose confirmation labels the judgment', async t => {
  const f = await setup(t, (input, res) => stream(res, '第一章写好了。本章完。总结：主角走进雨里。'));
  f.app.store.message(f.session.id, { text: '写第一章' });
  await until(() => f.current().turns[0]?.status === 'completed');
  const reply = f.current().items.findLast(item => item.kind === 'assistant');
  const labels = [];
  let verdict = { durable: 'one_off', kind: null, ledgerId: 'j-once' };
  f.app.mind.decisions = { feedbackSignal: async () => verdict, labelDecision: (id, label) => labels.push([id, label]) };
  const post = (body) => fetch(f.url(`/api/v2/sessions/${f.session.id}/items/${reply.id}/feedback`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const lessons = () => f.app.store.state.projects.find(row => row.id === f.project.id).mind?.lessons ?? [];
  assert.equal((await post({ vote: 'down', comment: '这里有个错别字' })).status, 200);
  await f.app.mind.idle?.(); await delay(50);
  assert.equal(lessons().length, 0, 'a remark about this reply only is not a lesson');
  verdict = { durable: 'durable', kind: 'constraint', ledgerId: 'j-standing' };
  assert.equal((await post({ vote: 'down', comment: '以后别在章节末尾写总结' })).status, 200);
  await until(() => lessons().length === 1);
  const lesson = lessons()[0];
  assert.equal(lesson.kind, 'constraint'); assert.equal(lesson.signalLedgerId, 'j-standing');
  f.app.mind.answerLessonInvitation(f.project.id, lesson.id, { choice: 'confirm', sessionId: f.session.id });
  assert.deepEqual(labels, [['j-standing', 'lesson_confirmed']]);
});

test('plan layer: the model keeps the plan with project_plan; open items it touched this turn reach turn.settled, the plan rides on the project summary and the next turn\'s context', async t => {
  const f = await setup(t, (input, res, count) => {
    if (count === 1) return stream(res, '', { tool: { name: 'project_plan', args: { items: [{ text: '写第 8 章', status: 'done' }, { text: '写第 9 章', status: 'doing' }, { text: '写第 10 章', status: 'next' }] } } });
    if (count === 2) return stream(res, '第 8 章写完了，接着写 9、10 章。');
    if (count === 3) { assert.match(JSON.stringify(input.messages), /写第 9 章/, 'the plan is in the next turn\'s context'); return stream(res, '好的。'); }
    stream(res, 'ok');
  }, { settled: () => ({ continue: false, complete: true }) });
  await post(f.url(`/api/sessions/${f.session.id}/messages`), { text: '写完第 8–10 章' });
  await until(() => f.current().turns[0]?.status === 'completed');
  const effects = f.judged[0].effects.join('\n');
  assert.match(effects, /plan item still in progress: 写第 9 章/); assert.match(effects, /plan item not started: 写第 10 章/);
  const summary = await fetch(f.url(`/api/v2/projects/${f.project.id}`)).then(row => row.json());
  const plan = summary.plan ?? summary.project?.plan;
  assert.deepEqual(plan.doing.map(row => row.text), ['写第 9 章']); assert.deepEqual(plan.done.map(row => row.text), ['写第 8 章']);
  await post(f.url(`/api/sessions/${f.session.id}/messages`), { text: '继续' });
  await until(() => f.current().turns[1]?.status === 'completed');
});

test('an instruction left unfinished (and not continued) stays in the plan as next; not when the model already updated the plan', async t => {
  const f = await setup(t, (_input, res) => stream(res, '先写到这里。'), { settled: () => ({ continue: false, unfinished: true }) });
  await post(f.url(`/api/sessions/${f.session.id}/messages`), { text: '把第 8 到 10 章写完\n风格照旧' });
  await until(() => f.current().turns[0]?.status === 'completed');
  const plan = f.app.store.state.projects.find(row => row.id === f.project.id).mind.agenda.filter(row => row.kind === 'todo');
  assert.deepEqual(plan.map(row => [row.text, row.stage, row.status]), [['接着完成：把第 8 到 10 章写完', 'next', 'open']]);
});
