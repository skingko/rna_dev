import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addCommitment, addLesson, updatePlan, planView, stalledPlanItems, turnJudgedFinished, mergeNotes, mindSource, selectLessons, mindBackgroundView, mindContextUpdates, patchMindEntry, publicMind } from '../project-mind.mjs';
import { projectConstraints } from '../turn-watch.mjs';
import { InvitationService } from '../session-invitations.mjs';
import { combineTurnSettled } from '../../../packages/sdk/src/decision-templates.mjs';

// P2 batch B5 (align 2026-10-05 §2.2 B5, §1.3 D; mu kyrn-judge features/memory.ts:173-259, 321-352, 530-546,
// decisions/memory.ts:240-249): the mind's use counters stop counting noise, a JEV abstention changes no state, a
// failed turn's request waits for the mind judge, the user's word is never outvoted by the assistant's, and derived
// rows carry their sources. Judges are plain functions; no model, no JEV, no network.
const CLOCK = Date.parse('2026-10-05T01:00:00Z');
function setup(t, { decisions = null, writtenPaths = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-mind-b5-')), store = new Store(join(dir, 'state.json')), clock = { value: CLOCK };
  const { project, session } = store.createProject({ name: '玄幻小说', workspace: dir });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false; });
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => clock.value, sweepIntervalMs: 0, notesIntervalMs: 3600000, writtenPaths });
  t.after(async () => { await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), sessionOf = () => store.state.sessions.find(row => row.id === session.id);
  const turn = (text, { reply, status = 'completed', tools = [], item = {} } = {}) => {
    const ids = { turnId: randomUUID(), userItemId: randomUUID() }, at = new Date(clock.value).toISOString();
    store.mutate(state => { const s = state.sessions.find(row => row.id === session.id);
      s.turns.push({ id: ids.turnId, status, userItemId: ids.userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false });
      s.items.push({ id: ids.userItemId, turnId: ids.turnId, kind: 'user', text, createdAt: at, simulated: false, ...item });
      for (const [name, args, outcome = 'succeeded'] of tools) s.items.push({ id: randomUUID(), turnId: ids.turnId, kind: 'tool', text: name, createdAt: at, tool: { id: randomUUID(), name, args, status: outcome } });
      if (reply) s.items.push({ id: randomUUID(), turnId: ids.turnId, kind: 'assistant', text: reply, final: true, simulated: false, createdAt: at }); });
    return ids;
  };
  const lessonsOf = () => current().mind.lessons;
  return { dir, store, mind, project, session, current, sessionOf, turn, clock, lessonsOf };
}
const seedLessons = (f, rows) => f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); for (const row of rows) addLesson(mind, row, { now: CLOCK }); });
const usesOf = f => f.lessonsOf().map(row => ({ ...row.uses }));
const judgeNothing = { resolved: [], same: [], contradicts: [], refines: [], applies: [], notApplies: [] };

test('MIND-7: a failed or stopped turn counts nothing, and neither does the message after it (no fallback to every injected lesson)', async t => {
  const f = setup(t, { decisions: { lessonApplied: async () => { throw new Error('a turn that did not complete is never judged'); } } });
  seedLessons(f, [{ kind: 'constraint', text: '数字一律用汉字', source: { kind: 'user' } }, { kind: 'pitfall', text: '写前先核对人物卡', source: { kind: 'correction' } }]);
  const ids = f.lessonsOf().map(row => row.id);
  for (const status of ['failed', 'stopped']) {
    const run = f.turn(`写第${status === 'failed' ? '一' : '二'}章`, { status, reply: status === 'stopped' ? '写到一半' : undefined });
    f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === run.turnId).mindContext = { lessonIds: ids }; });
    assert.equal(await f.mind.afterReply({ sessionId: f.session.id, turnId: run.turnId }), null);
    const next = f.turn('继续');
    await f.mind.capture({ sessionId: f.session.id, turnId: next.turnId, route: { capture: { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false } } });
  }
  assert.deepEqual(usesOf(f), [{ recalled: 0, applied: 0, contradicted: 0 }, { recalled: 0, applied: 0, contradicted: 0 }]);
  assert.ok(f.lessonsOf().every(row => row.status === 'active' && !row.usedAt));
});

test('MIND-7: three corrections never retire a user\'s rule; background recall counts nothing', async t => {
  const f = setup(t);
  seedLessons(f, [{ kind: 'constraint', text: '核对现实事实后再写', source: { kind: 'user' } }]);
  const [lesson] = f.lessonsOf();
  for (const text of ['不对，搜索结果没用上', '不对，文风太硬', '不对，重写得不够深']) {
    const previous = f.turn('改第三章', { reply: '改好了。' });
    f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === previous.turnId).mindContext = { lessonIds: [lesson.id], followed: [lesson.id] }; });
    const correction = f.turn(text);
    await f.mind.capture({ sessionId: f.session.id, turnId: correction.turnId, route: { capture: { isCorrection: true, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false } } });
  }
  assert.equal(f.lessonsOf()[0].status, 'active', 'never retired silently');
  assert.deepEqual(f.lessonsOf()[0].uses, { recalled: 0, applied: 0, contradicted: 0 });
  const attachment = JSON.parse(f.mind.backgroundContext(f.project.id, { query: '核对' }));
  assert.equal(attachment.lessons[0].id, lesson.id, 'the rule still rides background work');
  assert.deepEqual(f.lessonsOf()[0].uses, { recalled: 0, applied: 0, contradicted: 0 }, 'background recall is not counted');
});

test('MIND-12: when JEV answered, a signal it abstained on stays without a verdict (no regex request, correction or answered question); sources are kept per field', async t => {
  const f = setup(t);
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); mind.agenda.push({ id: 'q1', kind: 'awaiting_user', text: '书名用《神烬》还是《长明》？', status: 'open', createdAt: new Date(CLOCK).toISOString(), updatedAt: new Date(CLOCK).toISOString(), source: { kind: 'agent' }, evidence: [] }); });
  f.turn('写第一章', { reply: '第一章写好了。' });
  // The wording would read as a pending request ("明天…告诉我"), a correction ("还是太") and an answer (shares 书名/神烬).
  const text = '书名还是太土了，明天把第二章写完告诉我结果，神烬再想想';
  const judged = f.turn(text);
  const record = await f.mind.capture({ sessionId: f.session.id, turnId: judged.turnId, route: { capture: { isPreference: false, isApproval: false, selfImprovement: false } } });
  // An abstained signal is stored as no verdict (null), never as a confident false.
  assert.equal(record.pendingRequest, null); assert.equal(record.correction, null); assert.equal(record.answered, undefined);
  assert.equal(record.preference, false, 'what JEV answered stays its answer');
  assert.equal(f.current().mind.commitments.length, 0, 'no commitment from a regex while JEV is on');
  assert.equal(f.current().mind.agenda.find(row => row.id === 'q1').status, 'open', 'no question closed by token overlap');
  assert.deepEqual(record.sources, { preference: 'jev', approval: 'jev', selfImprovement: 'jev' });
  // Without JEV's answer (off, shadow, unavailable) the fallbacks stand in, and say so.
  const fallback = f.turn(text);
  const weak = await f.mind.capture({ sessionId: f.session.id, turnId: fallback.turnId });
  assert.equal(weak.pendingRequest, true); assert.equal(weak.sources.pendingRequest, 'heuristic');
  assert.equal(weak.targetSource, 'heuristic', 'the regex fallback\'s "latest output" target says where it came from');
  // A target JEV named carries targetSource jev (C3 reads it).
  const named = f.turn('这个开头太拖了');
  const jev = await f.mind.capture({ sessionId: f.session.id, turnId: named.turnId, route: { capture: { isCorrection: true, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false, target: { kind: 'output', index: 0 } } } });
  assert.equal(jev.target.kind, 'output'); assert.equal(jev.targetSource, 'jev'); assert.equal(jev.sources.target, 'jev');
});

test('MIND-12: a correction JEV abstained on is unknown: no judgment labels on the previous turn, and evolution hears null, not "not a correction"', async t => {
  const labels = [];
  const f = setup(t, { decisions: { labelDecision: (id, value) => { labels.push([id, value]); return true; } } });
  const seen = []; f.mind.onCapture = event => seen.push(event.record);
  const judgedTurn = () => {
    const previous = f.turn('写第三章', { reply: '第三章写好了。' });
    f.store.mutate(state => { const turn = state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === previous.turnId);
      turn.judgments = [{ point: 'turn.drift', ledgerId: `drift-${previous.turnId}`, drifting: false }, { point: 'ask.necessity', ledgerId: `ask-${previous.turnId}` }];
      turn.mindContext = { lessonIds: ['l1'], followed: ['l1'], appliedLedgerId: `applied-${previous.turnId}` }; });
    return previous;
  };
  // The reviewer's case: the regex would call this a correction; JEV answered the capture but abstained on is_correction.
  judgedTurn();
  const message = f.turn('不对，重写这一章');
  const record = await f.mind.capture({ sessionId: f.session.id, turnId: message.turnId, route: { capture: { isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false } } });
  await f.mind.captureHook;
  assert.equal(record.correction, null); assert.equal(f.sessionOf().items.find(row => row.id === message.userItemId).capture.correction, null);
  assert.equal(record.sources.correction, undefined, 'no source: there is no verdict');
  assert.deepEqual(labels, [], 'drift_clear, necessity_right and applied_right are not claimed on a guess');
  assert.equal(seen.at(-1).correction, null, 'evolution is told it is unknown (it counts no clean use on it)');
  // With JEV's verdict the labels follow as before.
  const previous = judgedTurn();
  const plain = f.turn('好的，继续');
  await f.mind.capture({ sessionId: f.session.id, turnId: plain.turnId, route: { capture: { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false } } });
  await f.mind.captureHook;
  assert.deepEqual(labels.sort(), [[`applied-${previous.turnId}`, 'applied_right'], [`ask-${previous.turnId}`, 'necessity_right'], [`drift-${previous.turnId}`, 'drift_clear']]);
  assert.equal(seen.at(-1).correction, false);
});

test('failed_turn: an unrelated later turn does not settle it; it joins the mind judge\'s resolved batch with the later turn\'s evidence', async t => {
  const asked = [];
  let resolve = () => [];
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async (_project, input) => { asked.push(input); return { ...judgeNothing, resolved: resolve(input), ledgerId: `J${asked.length}` }; } } });
  const failed = f.turn('把第 11 章写完并保存', { status: 'failed' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: failed.turnId });
  const row = () => f.current().mind.commitments.find(entry => entry.trigger === 'failed_turn');
  assert.equal(row().status, 'pending');
  f.clock.value += 60000;
  const unrelated = f.turn('主角的名字是什么？', { reply: '主角叫顾昭。' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: unrelated.turnId });
  assert.equal(row().status, 'pending', 'an unrelated completed turn no longer clears it');
  assert.deepEqual(asked.at(-1).commitments.map(entry => entry.id), [row().id], 'the judge was asked about it');
  assert.match(asked.at(-1).evidence.join('\n'), /主角叫顾昭/);
  f.clock.value += 60000;
  resolve = input => input.commitments.flatMap((entry, index) => entry.trigger === 'failed_turn' ? [index] : []);
  const retry = f.turn('继续写第 11 章', { reply: '第 11 章已写完并保存。' });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: retry.turnId });
  assert.equal(row().status, 'resolved'); assert.equal(row().resolvedBy.kind, 'jev'); assert.equal(row().resolvedBy.turnId, retry.turnId);
  // Without a judge that acts, the code rule stands in (a later completed turn of the conversation settles it).
  const plain = setup(t);
  const down = plain.turn('导出 PDF', { status: 'failed' });
  await plain.mind.afterTurn({ sessionId: plain.session.id, turnId: down.turnId });
  const later = plain.turn('好了吗', { reply: '导出好了。' });
  await plain.mind.afterTurn({ sessionId: plain.session.id, turnId: later.turnId });
  assert.equal(plain.current().mind.commitments.find(entry => entry.trigger === 'failed_turn').status, 'resolved');
});

test('MIND-5: one commitment per source item: a failed turn annotates its captured request; "接着做" links to the commitment it continues', async t => {
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async () => ({ ...judgeNothing, ledgerId: 'J' }) } });
  const ids = f.turn('明天把第 12 章写完发我', { status: 'failed' });
  await f.mind.capture({ sessionId: f.session.id, turnId: ids.turnId, route: { capture: { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: true, selfImprovement: false } } });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: ids.turnId });
  const rows = () => f.current().mind.commitments;
  assert.equal(rows().length, 1, 'no failed_turn twin');
  assert.equal(rows()[0].trigger, 'user_request'); assert.equal(rows()[0].failure.turnId, ids.turnId); assert.equal(rows()[0].failure.status, 'failed');
  // The model still reads that a turn on it failed (what the failed_turn twin used to say), on the request's own row.
  const turnBlock = commitments => JSON.parse(mindContextUpdates({ commitments, now: f.clock.value }).find(row => row.key === 'project-mind-turn').text).commitments;
  assert.deepEqual(turnBlock(rows()).map(row => [row.trigger, row.failedTurn]), [['user_request', true]]);
  assert.equal(turnBlock([{ ...rows()[0], failure: undefined }])[0].failedTurn, undefined, 'only when a turn on it failed');
  // The owed card's "接着做" posts the request with the commitment it continues (session-invitations).
  const inv = new InvitationService(f.store, { mind: f.mind, now: () => f.clock.value }), posted = [];
  inv.post = (sessionId, text, extra = {}) => posted.push({ sessionId, text, ...extra });
  f.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); (session.invitations ??= []).push({ id: 'inv-1', kind: 'commitment', subject: `commitment:${rows()[0].id}`, projectId: f.project.id, commitmentId: rows()[0].id, trigger: 'user_request', text: rows()[0].request, status: 'open', createdAt: new Date(CLOCK).toISOString() }); });
  await inv.act(f.session.id, 'inv-1', { action: 'answer', choice: 'continue' });
  assert.deepEqual(posted.at(-1).continues, { commitmentId: rows()[0].id });
  // The posted message is captured as that commitment, not as a new one; its failed run annotates the same row.
  const carried = f.turn(posted.at(-1).text, { status: 'failed', item: { continues: posted.at(-1).continues } });
  await f.mind.capture({ sessionId: f.session.id, turnId: carried.turnId, route: { capture: { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: true, selfImprovement: false } } });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: carried.turnId });
  assert.equal(rows().length, 1); assert.equal(rows()[0].failure.turnId, carried.turnId);
  assert.ok(rows()[0].evidence.some(row => row.itemId === carried.userItemId)); assert.equal(rows()[0].continuedBy.turnId, carried.turnId);
  assert.deepEqual(f.sessionOf().items.find(row => row.id === carried.userItemId).capture.continues, { commitmentId: rows()[0].id, via: 'message' });
  // A continuation turn that turn.settled judged finished settles the commitment it continues.
  const done = f.turn(posted.at(-1).text, { reply: '第 12 章写完了。', item: { continues: posted.at(-1).continues } });
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === done.turnId).settledVerdict = { finished: true, complete: true, waiting: false, deferred: false, ledgerId: 'S1' }; });
  await f.mind.afterTurn({ sessionId: f.session.id, turnId: done.turnId });
  assert.equal(rows()[0].status, 'resolved'); assert.equal(rows()[0].resolvedBy.ledgerId, 'S1');
});

test('an agent-sourced lesson never supersedes the user\'s: both are kept, the newer one is held out of every context and asks the user', async t => {
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async (_project, { lessons }) => ({ ...judgeNothing, contradicts: lessons.map((_, index) => index) }) } });
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    addLesson(mind, { kind: 'constraint', text: '章节字数控制在 3000 字以内', source: mindSource('correction', { sessionId: f.session.id }) }, { now: CLOCK });
    addLesson(mind, { kind: 'constraint', text: '章节字数不要少于 4000 字', source: mindSource('agent') }, { now: CLOCK + 1000 }); });
  const [user, agent] = f.lessonsOf();
  const outcome = await f.mind.consolidateLesson(f.project.id, agent.id);
  assert.deepEqual(outcome, { superseded: [], outranked: [user.id] });
  const [kept, newer] = f.lessonsOf();
  assert.equal(kept.status, 'active'); assert.equal(newer.status, 'held', 'kept, but not live');
  assert.equal(newer.needsConfirmation, true); assert.equal(newer.confirmReason, 'conflicts_user_lesson'); assert.deepEqual(newer.conflictsWith, [user.id]);
  // Two rules that cannot both hold never reach a turn together (mu features/memory.ts:167-205): the foreground and
  // background selections, the in-turn constraint watch and the mind counts carry only the user's rule.
  const live = selectLessons(f.current(), '章节字数', { now: CLOCK + 2000 });
  assert.deepEqual([...live.always, ...live.candidates].map(row => row.id), [user.id]);
  assert.deepEqual(mindBackgroundView(f.current(), { now: CLOCK + 2000, query: '章节字数' }).lessons.map(row => row.id), [user.id]);
  assert.deepEqual(projectConstraints(f.current()), ['章节字数控制在 3000 字以内']);
  // The user sees it (open view) with why it is asked and what it conflicts with.
  const shown = publicMind(f.current(), { now: CLOCK + 2000, status: 'open' }).lessons.find(row => row.id === agent.id);
  assert.equal(shown.status, 'held'); assert.equal(shown.confirmReason, 'conflicts_user_lesson'); assert.deepEqual(shown.conflictsWith, [user.id]);
  // The user's word still replaces what the assistant concluded.
  f.store.mutate(state => { addLesson(ensureMind(state.projects.find(row => row.id === f.project.id)), { kind: 'preference', text: '章节字数 3500 字左右', source: mindSource('user', { sessionId: f.session.id }) }, { now: CLOCK + 2000 }); });
  const third = f.lessonsOf().at(-1);
  const replaced = await f.mind.consolidateLesson(f.project.id, third.id);
  assert.deepEqual(replaced.superseded.sort(), [user.id, agent.id].sort());
});

test('a held lesson asks which rule to keep: its card names the user\'s rule; switching retires the user\'s rule, keeping it retires the new one, closing it keeps it held', async t => {
  const contradictAll = { enabled: () => true, mindJudge: async (_project, { lessons }) => ({ ...judgeNothing, contradicts: lessons.map((_, index) => index) }) };
  const held = async (t) => {
    const f = setup(t, { decisions: contradictAll });
    const offers = []; f.mind.invitations = { offerLesson: (sessionId, fields) => { offers.push({ sessionId, ...fields }); return { id: `inv-${offers.length}` }; }, close: () => true };
    f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
      addLesson(mind, { kind: 'constraint', text: '章节字数控制在 3000 字以内', source: mindSource('correction', { sessionId: f.session.id }) }, { now: CLOCK });
      addLesson(mind, { kind: 'constraint', text: '章节字数不要少于 4000 字', source: mindSource('background', { actionId: 'run-1' }) }, { now: CLOCK + 1000 }); });
    const [user, agent] = f.lessonsOf();
    await f.mind.consolidateLesson(f.project.id, agent.id);
    f.mind.sweep(); await f.mind.idle();
    return { f, offers, user, agent, row: id => f.lessonsOf().find(entry => entry.id === id) };
  };
  // The card: asked once by the sweep, naming the user's rule; the sweep does not close it while it waits.
  const a = await held(t);
  assert.deepEqual(a.offers.map(row => [row.lessonId, row.reason, row.conflictText]), [[a.agent.id, 'conflicts_user_lesson', '章节字数控制在 3000 字以内']]);
  assert.equal(a.row(a.agent.id).interaction.via, 'invitation');
  a.f.mind.sweep(); await a.f.mind.idle();
  assert.equal(a.offers.length, 1); assert.equal(a.row(a.agent.id).interaction.settledAt, undefined, 'still open');
  // "换成新的" (confirm): the new rule goes live and the user's rule steps aside for it.
  assert.equal(a.f.mind.answerLessonInvitation(a.f.project.id, a.agent.id, { choice: 'confirm', sessionId: a.f.session.id }), true);
  assert.equal(a.row(a.agent.id).status, 'active'); assert.ok(a.row(a.agent.id).confirmedAt);
  assert.equal(a.row(a.user.id).status, 'superseded'); assert.equal(a.row(a.user.id).supersededBy, a.agent.id); assert.equal(a.row(a.user.id).supersededReason, 'user_chose');
  assert.deepEqual(projectConstraints(a.f.current()), ['章节字数不要少于 4000 字'], 'only one of the two is live');
  // "保留原来的" (revoke): the new rule is retired, the user's stays.
  const b = await held(t);
  b.f.mind.answerLessonInvitation(b.f.project.id, b.agent.id, { choice: 'revoke', sessionId: b.f.session.id });
  assert.equal(b.row(b.agent.id).status, 'retired'); assert.equal(b.row(b.user.id).status, 'active');
  // Rewritten: the user's own wording replaces both.
  const c = await held(t);
  c.f.mind.answerLessonInvitation(c.f.project.id, c.agent.id, { choice: 'rewrite', text: '章节字数 3500 字左右', sessionId: c.f.session.id });
  assert.equal(c.row(c.agent.id).status, 'active'); assert.equal(c.row(c.agent.id).text, '章节字数 3500 字左右'); assert.equal(c.row(c.agent.id).source.kind, 'user');
  assert.equal(c.row(c.user.id).status, 'superseded');
  // Closed without an answer: it stays held (never live), and is not asked again.
  const d = await held(t);
  d.f.mind.answerLessonInvitation(d.f.project.id, d.agent.id, { choice: 'dismiss', sessionId: d.f.session.id });
  assert.equal(d.row(d.agent.id).status, 'held'); assert.equal(d.row(d.user.id).status, 'active');
  d.f.mind.sweep(); await d.f.mind.idle();
  assert.equal(d.offers.length, 1);
  // Switched on from the mind page (PATCH status active): the same choice.
  const e = await held(t);
  e.f.store.mutate(state => { patchMindEntry(state.projects.find(row => row.id === e.f.project.id), 'lessons', e.agent.id, { status: 'active' }, { now: CLOCK + 5000 }); });
  assert.equal(e.row(e.agent.id).status, 'active'); assert.equal(e.row(e.agent.id).needsConfirmation, undefined); assert.equal(e.row(e.user.id).status, 'superseded');
  // A confirmed lesson is the user's word: a later assistant conclusion does not replace it either.
  e.f.store.mutate(state => { addLesson(ensureMind(state.projects.find(row => row.id === e.f.project.id)), { kind: 'constraint', text: '章节字数至少 5000 字', source: mindSource('model') }, { now: CLOCK + 6000 }); });
  const later = e.f.lessonsOf().at(-1);
  assert.deepEqual(await e.f.mind.consolidateLesson(e.f.project.id, later.id), { superseded: [], outranked: [e.agent.id] });
  assert.equal(e.row(e.agent.id).status, 'active'); assert.equal(e.row(later.id).status, 'held');
});

test('the question card path (no invitation service): confirming a held lesson on the card releases it the same way', async t => {
  const f = setup(t, { decisions: { enabled: () => true, mindJudge: async (_project, { lessons }) => ({ ...judgeNothing, contradicts: lessons.map((_, index) => index) }) } });
  const published = [];
  f.mind.interactions = { publishInitiative: ({ sessionId, questions }) => { const id = `card-${published.length + 1}`; published.push({ id, questions }); f.store.mutate(state => { state.sessions.find(row => row.id === sessionId).items.push({ id: `item-${id}`, kind: 'interaction', createdAt: new Date(f.clock.value).toISOString(), interaction: { id, status: 'pending', questions } }); }); return { id }; } };
  f.turn('写第一章', { reply: '写好了。' });
  f.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id));
    addLesson(mind, { kind: 'constraint', text: '章节字数控制在 3000 字以内', source: mindSource('correction', { sessionId: f.session.id }) }, { now: CLOCK });
    addLesson(mind, { kind: 'constraint', text: '章节字数不要少于 4000 字', source: mindSource('agent') }, { now: CLOCK + 1000 }); });
  const [user, agent] = f.lessonsOf();
  await f.mind.consolidateLesson(f.project.id, agent.id);
  assert.ok(await f.mind.askMind(f.project.id, 'lessons', agent.id));
  f.store.mutate(state => { const card = state.sessions.find(row => row.id === f.session.id).items.find(row => row.interaction?.id === published[0].id); Object.assign(card.interaction, { status: 'answered', answers: [{ id: 'answer', selected: ['confirm'] }] }); });
  f.mind.settleAnswered();
  const row = id => f.lessonsOf().find(entry => entry.id === id);
  assert.equal(row(agent.id).status, 'active'); assert.equal(row(user.id).status, 'superseded'); assert.equal(row(user.id).supersededBy, agent.id);
});

test('provenance: notes link their message batch, plan rows name who staged them and why their run stopped', async t => {
  const f = setup(t, { decisions: { notesWorth: async () => true } });
  f.mind.provider = async function* () { yield { type: 'text_delta', delta: JSON.stringify({ facts: ['用户是高中语文老师'], preferences: ['晚上才看稿'] }) }; yield { type: 'done', stopReason: 'stop' }; };
  f.mind.fastModel = () => ({ providerId: 'p', modelId: 'm', execution: 'rna', contextWindow: 32000, maxOutputTokens: 1000 });
  f.store.mutate(state => { state.configuration.providers.push({ id: 'p', name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [] }); });
  f.store.configurationService.secret = () => 'fixture-key';
  const one = f.turn('我是高中语文老师'), two = f.turn('我晚上才有空看稿');
  f.clock.value += 60000;
  assert.equal(await f.mind.updateNotes(f.project.id), true);
  const refs = [{ sessionId: f.session.id, itemId: one.userItemId }, { sessionId: f.session.id, itemId: two.userItemId }];
  assert.deepEqual(f.current().mind.notes.facts[0].sources, refs); assert.deepEqual(f.current().mind.notes.preferences[0].sources, refs);
  // A note stated again gains the new batch's links (bounded), and stays one note.
  f.store.mutate(state => { mergeNotes(ensureMind(state.projects.find(row => row.id === f.project.id)), { facts: ['用户是高中语文老师'] }, { now: f.clock.value, sources: [{ sessionId: f.session.id, itemId: 'later-item' }] }); });
  assert.equal(f.current().mind.notes.facts.length, 1); assert.equal(f.current().mind.notes.facts[0].sources.length, 3);
  // Plan rows: who staged them (the run or the turn), and why a run that stopped did.
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id), mind = ensureMind(project);
    project.initiativeRuntime = { sdkState: { actions: [{ id: 'run-1', action: 'work', status: 'running' }] } };
    updatePlan(mind, [{ text: '重写第 3 章', status: 'doing' }], { now: CLOCK, source: mindSource('background', { actionId: 'run-1' }) });
    updatePlan(mind, [{ text: '核对人名', status: 'next' }], { now: CLOCK, source: mindSource('agent', { sessionId: f.session.id, turnId: one.turnId }) }); });
  const rows = () => f.current().mind.agenda.filter(row => row.kind === 'todo');
  assert.deepEqual(rows().map(row => row.stagedBy), [{ kind: 'background', actionId: 'run-1', at: new Date(CLOCK).toISOString() }, { kind: 'agent', sessionId: f.session.id, turnId: one.turnId, at: new Date(CLOCK).toISOString() }]);
  f.store.mutate(state => { Object.assign(state.projects.find(row => row.id === f.project.id).initiativeRuntime.sdkState.actions[0], { status: 'cancelled', cancellationReason: 'action_control' }); });
  assert.deepEqual(stalledPlanItems(f.current()).map(row => [row.actionId, row.status, row.reason]), [['run-1', 'cancelled', 'action_control']]);
  f.mind.settlePlan();
  assert.equal(rows()[0].interrupted.reason, 'action_control', 'the user stopped it'); assert.equal(planView(f.current().mind).next[0].text, '重写第 3 章');
});

test('MIND-19: the turn.settled conclusion read from the turn outlives the decision ledger\'s window', () => {
  const t = { id: 'turn-a' }, state = { sessions: [{ id: 's', turns: [t] }], decisionKernelRuntime: { recent: [] } };
  assert.equal(turnJudgedFinished(state, 'turn-a'), null, 'nothing on record');
  t.settledVerdict = { finished: true, complete: true, waiting: false, deferred: false, ledgerId: 'L-1' };
  assert.deepEqual(turnJudgedFinished(state, 'turn-a'), { ledgerId: 'L-1' }, 'read from the turn, with no ledger row');
  t.settledVerdict = { finished: false, complete: false, waiting: true, deferred: null };
  assert.equal(turnJudgedFinished(state, 'turn-a'), null);
  // The conclusion the host keeps comes from the same combination (any doubt is no verdict).
  const yes = probability => ({ type: 'boolean', probability });
  const sure = combineTurnSettled({ instruction_complete: yes(.97), deferred_without_cause: yes(.05), waiting_on_user: yes(.04) });
  assert.deepEqual([sure.finished, sure.complete, sure.deferred, sure.waiting], [true, true, false, false]);
  const unsure = combineTurnSettled({ instruction_complete: yes(.6), waiting_on_user: yes(.5) });
  assert.deepEqual([unsure.finished, unsure.complete, unsure.deferred, unsure.waiting], [false, null, null, null]);
});

test('the turn digest is kept when the mind reads a turn (also on catch-up after a restart) and takes the checkpoint\'s paths once they exist', async t => {
  const calls = [];
  const f = setup(t, { writtenPaths: async input => { calls.push(input); return ['chapters/11.md', 'notes/plan.md']; } });
  const run = f.turn('写第 11 章', { reply: '第 11 章写好了，3200 字。', tools: [['project_read', { path: 'outline.md' }], ['project_exec', { command: 'cat > chapters/11.md <<EOF' }], ['project_write', { path: 'notes/plan.md', content: 'x' }]] });
  // Caught up after a restart: the runtime never reported this turn.
  await f.mind.catchUp(f.project.id, { since: 0 });
  const digest = () => f.sessionOf().turns.find(row => row.id === run.turnId).digest;
  assert.equal(digest().request, '写第 11 章');
  assert.deepEqual(digest().steps, ['read outline.md -> ok', 'command cat > chapters/11.md <<EOF -> ok', 'write notes/plan.md -> ok']);
  assert.deepEqual(digest().written, ['notes/plan.md'], 'without a checkpoint: the turn\'s own write steps');
  assert.equal(digest().reply, '第 11 章写好了，3200 字。'); assert.equal(calls.length, 0);
  // The runtime's hand-back recorded the end checkpoint: what the command wrote joins the digest.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === run.turnId).checkpoint = { state: 'taken', ref: 'refs/rna/turn/x', endedAt: new Date(CLOCK).toISOString() }; });
  await f.mind.refreshDigest({ sessionId: f.session.id, turnId: run.turnId });
  assert.deepEqual(digest().written, ['notes/plan.md', 'chapters/11.md']); assert.equal(digest().paths, 'checkpoint');
  assert.deepEqual(calls, [{ projectId: f.project.id, sessionId: f.session.id, turnId: run.turnId }]);
  await f.mind.refreshDigest({ sessionId: f.session.id, turnId: run.turnId });
  assert.equal(calls.length, 1, 'a current digest is not built again');
});
