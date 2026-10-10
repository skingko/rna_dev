// D4 scenario (P2 batch C3; plan F3 and EVO-2, §2.3 #2; headlong bin/chat:176-230 reply_to). Which message does a user
// message answer? One real host (the user's message through the runtime and its turn.route capture, the project mind, the
// delivery ledger's pump, evolution's outcome reader, the scheduled-run delivery); only the model, JEV and the clock are
// fake. Before C3 the answer was "the next message answers the last thing", so:
//  - one unrelated message the morning after a night of shares settled a share as replied (B3's transitional rule: the
//    latest; before B3, all of them), which kept engagement pinned;
//  - a correction to a scheduled report was counted against the foreground turn that happened to come before it.
// Now the message says what it is about (JEV's focused question `reply.target`, else the capture's target by who named it).
// The night's shares are seeded the way the delivery path writes them (the conversation item and the inbox entry); the
// scheduled report is delivered by the real schedule run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { recordDelivery } from '../../proactive-delivery.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE;
const AGE = '第一章里林舟的年龄前后不一致：开头写 17 岁，第 9 节写 19 岁。', LINK = '第二章第 14 行的链接失效了：它指向的 notes/harbor.md 已经被删除。', TIME = '第三章有两处时间线矛盾：第 3 节写的是周二，第 5 节写的是周一。';
const iso = ms => new Date(ms).toISOString();

/** Shares delivered in the conversation `ago` ms before now, oldest first (the delivery path's own shape: an item and its ledger entry). */
function seedShares(world, rows) {
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId), session = state.sessions.find(row => row.id === world.sessionId);
    for (const row of rows) {
      const at = Date.now() - row.ago, id = randomUUID(), actionId = `seed-${randomUUID()}`;
      session.items.push({ id, turnId: null, kind: 'assistant', text: row.text, createdAt: iso(at), simulated: false, source: 'initiative', projectId: project.id, decisionMode: 'rna-model', initiativeActionId: actionId, initiative: { kind: 'insight', reach: 'inline' } });
      recordDelivery(project, { actionId, kind: 'share', tier: 'inline', text: row.text, sessionId: session.id, itemId: id, now: at });
    }
  });
}
/** A question card the host asked, as the ask path writes it: an item with the interaction, and a ledger entry that has an interaction id and no item id. */
function seedCard(world, { ago, question, labels }) {
  world.store.mutate(state => {
    const project = state.projects.find(row => row.id === world.projectId), session = state.sessions.find(row => row.id === world.sessionId);
    const at = Date.now() - ago, actionId = `seed-${randomUUID()}`;
    const interaction = { kind: 'question', id: `card-${randomUUID()}`, source: 'initiative', status: 'pending', canRespond: true, turnId: null, toolCallId: null, actionId, createdAt: iso(at),
      questions: [{ id: 'platform', header: 'Platform', question, options: labels.map((label, index) => ({ id: `option-${index}`, label })), allowCustom: true }] };
    session.items.push({ id: randomUUID(), kind: 'question', text: '', turnId: null, createdAt: iso(at), simulated: false, source: 'interaction', interaction });
    recordDelivery(project, { actionId, kind: 'ask', tier: 'inline', text: question, sessionId: session.id, interactionId: interaction.id, now: at });
  });
}
const NIGHT = [{ text: AGE, ago: 6 * HOUR }, { text: LINK, ago: 5 * HOUR }, { text: TIME, ago: 4 * HOUR }];
const entries = world => world.project().inbox ?? [];
/** Each share's outcome, oldest first (the night's order: age, link, time line). */
const outcomeOf = world => entries(world).map(row => row.feedback?.outcome ?? 'pending');
const userItem = (world, text) => world.session().items.find(row => row.kind === 'user' && row.text === text);
/** The pump settles on its own clock (30 s between checks): move past it and let it ask and settle. */
const settle = (s, label) => s.advanceClock(31000, { label, settleMs: 400 });
/** JEV's answer to the capture's target question and to reply.target: the option whose text matches (a stand-in for reading it). */
const names = pattern => ({
  capture: question => Object.entries(question.criteria ?? {}).find(([key, text]) => /^out_/.test(key) && pattern.test(text))?.[0] ?? 'unknown',
  reply: (_question, body) => { const index = (body.state?.reply?.deliveries ?? []).findIndex(row => pattern.test(row.text)); return index < 0 ? 'unknown' : `dlv_${index}`; },
});
const asked = world => world.jev.asked('replies_to');

test('an unrelated message the morning after a night of shares settles none of them; they are ignored when their windows close', async t => {
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
  const s = scenario(world);
  seedShares(world, NIGHT);
  await settle(s, 'the pump reads the night\'s shares once');
  assert.deepEqual(outcomeOf(world), ['pending', 'pending', 'pending']);
  // JEV answers as it does for a new request (the fake's default: "none of them" on both questions).
  const text = '开始写第四章，先写开头两节。';
  await s.send(text, { reply: '好的，开始写第四章。' });
  await until(() => userItem(world, text)?.capture, 'the message to be captured'); await world.store.mind.idle();
  const settled = await settle(s, 'the pump reads the message');
  await settled.expect({
    judgments: calls => {
      const call = asked(world).at(-1);
      assert.ok(call, 'reply.target was asked');
      assert.deepEqual(call.state.reply.deliveries.map(row => row.text), [TIME, LINK, AGE], 'the night\'s shares, newest first');
      assert.equal(call.state.reply.message, text);
    },
    state: state => {
      // Before C3 (B3's transitional rule) the latest share was replied by this message.
      assert.deepEqual(state.projects.find(row => row.id === world.projectId).inbox.map(row => row.feedback?.outcome ?? 'pending'), ['pending', 'pending', 'pending'], 'no share was replied');
      const message = state.sessions.find(row => row.id === world.sessionId).items.find(row => row.kind === 'user' && row.text === text);
      assert.deepEqual([message.capture.target, message.capture.targetSource], [null, 'jev'], 'JEV is sure the message reacts to nothing earlier');
      assert.deepEqual([message.replyTo.kind, message.replyTo.itemId], ['none', null], 'and that it answers none of the shares');
    },
  });
  // The windows close (12 hours): ignored, never replied.
  const later = await s.advanceClock(13 * HOUR, { label: 'the shares\' windows close', until: () => entries(world).every(row => row.feedback) });
  await later.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId);
    assert.deepEqual(project.inbox.map(row => row.feedback.outcome), ['ignored', 'ignored', 'ignored']);
    assert.equal(project.inbox.some(row => row.feedback.replyItemId), false);
  } });
});

test('a reply to one specific share settles that share, whichever it is; a message JEV cannot place falls back to the latest', async t => {
  await t.test('reply.target names the oldest share', async t => {
    const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
    const s = scenario(world), pick = names(/17 岁/);
    world.jev.answer('replies_to', pick.reply).answer('target_of_feedback', pick.capture);
    seedShares(world, NIGHT);
    const text = '林舟应该是 19 岁，开头那里改成 19。';
    await s.send(text, { reply: '好的，改成 19 岁。' });
    await until(() => userItem(world, text)?.capture, 'the message to be captured'); await world.store.mind.idle();
    await settle(s, 'the pump reads the message');
    const message = userItem(world, text), settledEntry = entries(world).find(row => row.feedback);
    assert.deepEqual(outcomeOf(world), ['replied', 'pending', 'pending'], 'the share it was about, not the latest');
    assert.deepEqual([settledEntry.feedback.replyItemId, settledEntry.feedback.replyVia], [message.id, 'reply.target']);
  });
  await t.test('the focused question abstains on a thumbs-up and the capture names the latest share', async t => {
    const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
    const s = scenario(world), pick = names(/周二/);
    world.jev.answer('replies_to', 'unknown').answer('target_of_feedback', pick.capture).answer('is_approval', .95);
    seedShares(world, NIGHT);
    await s.send('👍', { reply: '谢谢。' });
    await until(() => userItem(world, '👍')?.capture, 'the message to be captured'); await world.store.mind.idle();
    await settle(s, 'the pump reads the message');
    assert.deepEqual(outcomeOf(world), ['pending', 'pending', 'replied']);
    assert.equal(entries(world).find(row => row.feedback).feedback.replyVia, 'capture');
  });
  await t.test('nobody can tell: the latest unanswered share, as B3 settled it', async t => {
    const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
    const s = scenario(world);
    world.jev.answer('replies_to', 'unknown').answer('target_of_feedback', 'unknown');
    seedShares(world, NIGHT);
    await s.send('好的', { reply: '收到。' });
    await until(() => userItem(world, '好的')?.capture, 'the message to be captured'); await world.store.mind.idle();
    await settle(s, 'the pump reads the message');
    assert.deepEqual(outcomeOf(world), ['pending', 'pending', 'replied']);
    assert.equal(entries(world).find(row => row.feedback).feedback.replyVia, 'order');
  });
});

test('a correction to a scheduled report is credited to that report\'s run, not to the foreground turn before it', async t => {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  const first = await s.send('写第三章的开头', { reply: '第三章开头写好了：顾昭推开长明宗的山门。' });
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const scheduleId = created.body.id;
  world.faux.script('background-work', { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] }, 'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
  const delivered = await s.advanceClock(70 * MINUTE, { label: 'the scheduled report comes due and is delivered', until: () => world.session().items.some(item => item.scheduleOccurrenceKey) });
  const report = world.session().items.find(item => item.scheduleOccurrenceKey);
  await delivered.expect({ state: state => assert.match(state.sessions.find(row => row.id === world.sessionId).items.find(item => item.id === report.id).text, /seven verified sources/) });
  const firstTurn = world.session().turns.find(row => row.id === first.outcome.turnId);

  // The user corrects the report. JEV reads what the message is about: capture and focused question both name the report.
  const pick = names(/seven verified sources/);
  world.jev.answer('is_correction', .96).answer('is_approval', .03).answer('target_of_feedback', pick.capture).answer('replies_to', pick.reply);
  const text = '这个报告里的数字不对，应该是 9 个来源，不是 7 个。';
  await s.send(text, { reply: '好的，我会按 9 个来源改。' });
  await until(() => userItem(world, text)?.capture, 'the correction to be captured'); await world.store.mind.idle();
  const settled = await settle(s, 'the pump reads the correction');
  await settled.expect({ state: state => {
    const project = state.projects.find(row => row.id === world.projectId), session = state.sessions.find(row => row.id === world.sessionId), message = session.items.find(row => row.kind === 'user' && row.text === text);
    assert.deepEqual([message.capture.correction, message.capture.target.itemId, message.capture.targetSource], [true, report.id, 'jev']);
    // The ledger: the report's own entry is the one that was replied to (it is the scheduled delivery of that run).
    const entry = project.inbox.find(row => row.itemId === report.id);
    assert.deepEqual([entry.scheduled, entry.feedback.outcome, entry.feedback.replyItemId, entry.feedback.replyVia], [true, 'replied', message.id, 'reply.target']);
  } });
  // Evolution: lane C's outcomes. The run was corrected; the foreground turn before it was not reacted to at all
  // (before C3 it was the "corrected" turn, with the report's complaint as its correction).
  const project = world.project(), outcomes = world.store.genes.contrastOutcomes(project);
  assert.deepEqual(outcomes.filter(row => row.outcome === 'corrected').map(row => [row.run?.scheduleId ?? null, row.source.turnId ?? null]), [[scheduleId, null]], 'only the run');
  assert.equal(outcomes.some(row => row.source.turnId === firstTurn.id), false, 'the foreground turn has no outcome from this message');
  const run = outcomes.find(row => row.run);
  assert.deepEqual([run.request, run.correction], ['Read evidence.txt and report the measured result.', text]);
  assert.match(run.reply, /seven verified sources/);
});

test('a typed reply to a pending question card is a reply to the card; an unrelated message settles neither the card nor the shares (review F1)', async t => {
  const QUESTION = 'Which platform should the build target?';
  const setup = async t => {
    const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
    seedShares(world, NIGHT); seedCard(world, { ago: HOUR, question: QUESTION, labels: ['iOS', 'Android'] });
    return { world, s: scenario(world) };
  };
  const send = async ({ world, s }, text) => {
    await s.send(text, { reply: '收到。' });
    await until(() => userItem(world, text)?.capture, 'the message to be captured'); await world.store.mind.idle();
    await settle(s, 'the pump reads the message');
  };
  await t.test('the judge sees the card as one of the messages and places "iOS" on it', async t => {
    const f = await setup(t), pick = names(/Which platform/);
    f.world.jev.answer('replies_to', pick.reply);
    await send(f, 'iOS');
    assert.ok(asked(f.world).at(-1).state.reply.deliveries.some(row => row.kind === 'question card' && row.text === `${QUESTION} (options: iOS / Android)`), 'the card is a candidate, with its question and options');
    assert.deepEqual(outcomeOf(f.world), ['pending', 'pending', 'pending', 'replied']);
    assert.deepEqual([entries(f.world).at(-1).feedback.replyItemId, entries(f.world).at(-1).feedback.replyVia], [userItem(f.world, 'iOS').id, 'reply.target']);
  });
  await t.test('the judge cannot tell and the capture (which reads assistant outputs, never a card) says nothing earlier: the card is read by order, as before C3', async t => {
    const f = await setup(t);
    f.world.jev.answer('replies_to', 'unknown');
    await send(f, 'iOS');
    // The review's failure: on the first C3 build nothing settled here, and the card went on to be ignored.
    assert.deepEqual(outcomeOf(f.world), ['pending', 'pending', 'pending', 'replied']);
    assert.equal(entries(f.world).at(-1).feedback.replyVia, 'order');
  });
  await t.test('an unrelated message the judge saw the card for settles nothing', async t => {
    const f = await setup(t), text = '开始写第四章，先写开头两节。';
    await send(f, text);
    assert.deepEqual(outcomeOf(f.world), ['pending', 'pending', 'pending', 'pending']);
    assert.deepEqual([userItem(f.world, text).replyTo.kind, userItem(f.world, text).replyTo.itemId], ['none', null]);
  });
});

test('a short JEV outage does not hand an unrelated message to the order rule: the question waits out its back-off and is asked again (review F3)', async t => {
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z' });
  const s = scenario(world), live = process.env.TYPESAFE_ENDPOINT;
  seedShares(world, NIGHT);
  // The network is down (a laptop waking up): JEV is unreachable while the message is read.
  process.env.TYPESAFE_ENDPOINT = 'http://127.0.0.1:1/v1/systemone';
  const text = '开始写第四章，先写开头两节。';
  await s.send(text, { reply: '好的，开始写第四章。' });
  await until(() => userItem(world, text), 'the message'); await world.store.mind.idle();
  // Four pump ticks (about two minutes). Before the back-off three failed asks in a row spent every attempt and the fourth tick settled
  // the latest share by order for good.
  for (const tick of [1, 2, 3, 4]) await settle(s, `pump tick ${tick} with JEV unreachable`);
  assert.deepEqual(outcomeOf(world), ['pending', 'pending', 'pending'], 'nothing is settled by order while the judge may still answer');
  assert.equal(userItem(world, text).replyTo.attempts >= 1, true, 'the unanswered asks are counted, spaced out');
  assert.equal(userItem(world, text).replyTo.attempts < 3, true, 'but not one per tick');
  assert.equal(asked(world).length, 0, 'nothing reached the judge');
  // The network is back: the question is asked again when its back-off is over, and JEV places the message on none of the shares.
  process.env.TYPESAFE_ENDPOINT = live;
  await s.advanceClock(6 * MINUTE, { label: 'the back-off is over', settleMs: 600, until: () => userItem(world, text)?.replyTo?.kind });
  assert.equal(asked(world).length, 1);
  assert.deepEqual([userItem(world, text).replyTo.kind, userItem(world, text).replyTo.itemId], ['none', null]);
  assert.deepEqual(outcomeOf(world), ['pending', 'pending', 'pending'], 'an unrelated message settled none of them, outage or not');
});
