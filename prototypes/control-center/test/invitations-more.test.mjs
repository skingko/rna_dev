import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, setup } from './helpers/gene-fixture.mjs';
import { createMindEntry, ensureMind, addCommitment, commitmentOverdue } from '../project-mind.mjs';
import { GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';
import { guardsOf } from '../project-genes.mjs';
import { guardScript, fixHitsAccepted } from '../tool-policy.mjs';

// Plan §2.1 invitation types beyond feedback and lessons: fixing a new check's
// existing hits, an overdue request, a suggested schedule; every answer labels its judgment.
const act = (f, invitation, body) => fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${invitation.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const invitations = f => f.app.store.state.sessions.find(row => row.id === f.session.id).invitations ?? [];

test('a trial check with existing hits asks whether to fix them; "fix" posts the request in the user\'s name', async t => {
  const f = await setup(t, (input, res) => { const system = input.messages.find(row => row.role === 'system')?.content ?? ''; if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER)); stream(res, '好的。'); });
  writeFileSync(join(f.workspace, '正文', '卷一', '第001章.md'), '第一章\n守夜人的旗帜挂在城头。\n');
  let lessonId; f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  const offer = invitations(f).find(row => row.kind === 'gene' && row.action === 'fix_hits');
  assert.equal(offer.total, 1); assert.equal(offer.files, 1); assert.equal(offer.title, '「守夜」字样检查');
  const told = f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').at(-1);
  assert.doesNotMatch(told.text, /要我处理这些吗/, 'the question moved to the invitation');
  assert.equal((await act(f, offer, { action: 'answer', choice: 'fix' })).status, 200);
  const posted = f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.kind === 'user').at(-1);
  assert.match(posted.text, /按检查「「守夜」字样检查」|按检查「守夜」字样检查|把现有文件里发现的 1 处问题改掉/);
  // From now on the check's pre-existing hits are the agent's to fix too (B1: the pre-write baseline stops counting them
  // as old), for the script the user saw them from.
  const accepted = f.current().genes.genes.find(row => row.id === offer.geneId).fixHitsAccepted;
  assert.equal(accepted.script, guardScript(guardsOf(f.current()).find(row => row.gene.id === offer.geneId).tool)); assert.ok(accepted.at);
});

test('an acceptance of fixing a check\'s existing hits holds for the script it was given for: a revision clears it, and "later" withdraws it', async t => {
  const userInput = input => { try { return JSON.parse(input.messages.find(row => row.role === 'user')?.content ?? '{}'); } catch { return {}; } };
  const f = await setup(t, (input, res) => { const system = input.messages.find(row => row.role === 'system')?.content ?? ''; if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(userInput(input).extend ? { ...GUARD_ANSWER, title: '「守夜」与「夜巡」字样检查', summary: '检查正文里有没有“守夜”或“夜巡”字样。' } : GUARD_ANSWER)); stream(res, '好的。'); });
  writeFileSync(join(f.workspace, '正文', '卷一', '第001章.md'), '第一章\n守夜人的旗帜挂在城头。\n');
  const lesson = text => { let id; f.app.store.mutate(state => { id = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text, kind: 'constraint' }).id; }); return f.current().mind.lessons.find(row => row.id === id); };
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }), geneConsolidate: async () => ({ action: 'add', index: null }) };
  await f.app.genes.routeLesson(f.current(), lesson('正文里不得出现“守夜”字样。'));
  const first = invitations(f).find(row => row.kind === 'gene' && row.action === 'fix_hits'), guard = () => f.current().genes.genes.find(row => row.id === first.geneId);
  const entry = () => guardsOf(f.current()).find(row => row.gene.id === first.geneId);
  const ask = async choice => {
    f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.invitations = []; session.invitationHistory = []; });
    f.app.store.invitations.offerGene(f.session.id, { projectId: f.project.id, geneId: first.geneId, action: 'fix_hits', title: first.title, total: 1, files: 1 });
    assert.equal((await act(f, invitations(f).find(row => row.kind === 'gene' && row.action === 'fix_hits'), { action: 'answer', choice })).status, 200);
  };
  assert.equal((await act(f, first, { action: 'answer', choice: 'fix' })).status, 200);
  assert.equal(fixHitsAccepted(entry()), true);
  // The check is revised in place to catch more: its record no longer carries the acceptance.
  f.app.genes.decisions.geneConsolidate = async () => ({ action: 'revise', index: 0 });
  const revised = await f.app.genes.routeLesson(f.current(), lesson('正文里也不得出现“夜巡”字样。'));
  assert.equal(revised.geneId, first.geneId, 'the same check, revised'); assert.equal(guard().fixHitsAccepted, null); assert.equal(fixHitsAccepted(entry()), false);
  // Accepted again; then the script changes under the same record: the acceptance does not cover what it finds.
  await ask('fix'); assert.equal(fixHitsAccepted(entry()), true);
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.versions.find(row => row.id === project.activeVersionId).bundle.genome.tools.find(row => row.id === entry().tool.id).script += '\n// revised'; });
  assert.equal(fixHitsAccepted(entry()), false);
  // Asked again and answered "later": the acceptance is withdrawn.
  await ask('fix'); assert.equal(fixHitsAccepted(entry()), true);
  await ask('later'); assert.equal(guard().fixHitsAccepted, undefined); assert.equal(fixHitsAccepted(entry()), false);
});

test('a check saved before the fix question existed asks it once, and only while problems remain in today\'s files', async t => {
  const f = await setup(t, (input, res) => { const system = input.messages.find(row => row.role === 'system')?.content ?? ''; if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER)); stream(res, '好的。'); });
  const chapter = join(f.workspace, '正文', '卷一', '第001章.md'); writeFileSync(chapter, '第一章\n守夜人的旗帜挂在城头。\n');
  let lessonId; f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  const guardId = f.current().genes.genes.find(row => row.layer === 'guard').id;
  const asSavedBefore = () => f.app.store.mutate(state => { const session = state.sessions.find(row => row.id === f.session.id); session.invitations = []; session.invitationHistory = []; const row = state.projects.find(row => row.id === f.project.id).genes.genes.find(row => row.id === guardId); delete row.fixHitsAskedAt; row.body = { ...row.body, standardLinkedAt: new Date().toISOString() }; });
  asSavedBefore();
  const job = f.app.genes.housekeeping(); assert.equal(typeof job, 'function'); await job();
  const offer = invitations(f).find(row => row.kind === 'gene' && row.action === 'fix_hits');
  assert.equal(offer?.geneId, guardId); assert.equal(offer.total, 1); assert.equal(offer.files, 1);
  assert.ok(f.current().genes.genes.find(row => row.id === guardId).fixHitsAskedAt, 'asked once, never again');
  asSavedBefore(); writeFileSync(chapter, '第一章\n城头的旗帜在风里。\n');
  assert.deepEqual(await f.app.genes.offerExistingHits(f.project.id, guardId), { offered: false, total: 0 });
  assert.equal(invitations(f).length, 0, 'fixed meanwhile: nothing to ask');
});

test('an overdue request is raised once when the user is here: continue posts it again, drop dismisses it', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  let first, second;
  f.app.store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === f.project.id)); first = addCommitment(mind, { request: '整理第三卷大纲', overdueAt: Date.now() - 60000 }).id; });
  await f.app.store.invitations.onPresence(f.project.id);
  const offer = invitations(f).find(row => row.kind === 'commitment');
  assert.equal(offer.commitmentId, first); assert.equal(offer.text, '整理第三卷大纲');
  await f.app.store.invitations.onPresence(f.project.id);
  assert.equal(invitations(f).filter(row => row.kind === 'commitment').length, 1, 'raised once');
  assert.equal((await act(f, offer, { action: 'answer', choice: 'drop' })).status, 200);
  assert.equal(f.current().mind.commitments.find(row => row.id === first).status, 'dismissed');
  f.app.store.mutate(state => { second = addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '补人物表', overdueAt: Date.now() - 60000 }).id; });
  f.app.store.invitations.offerOverdue(f.project.id);
  const next = invitations(f).find(row => row.kind === 'commitment');
  assert.equal(next.commitmentId, second);
  assert.equal((await act(f, next, { action: 'answer', choice: 'continue' })).status, 200);
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.kind === 'user').at(-1).text, '接着完成：补人物表');
  // Carrying on starts a new window (D4): no due moment until the evidence (or, with no judge acting, the fallback clock) sets one, so the sidebar stops counting it.
  const continued = f.current().mind.commitments.find(row => row.id === second);
  assert.equal(continued.overdueAt, undefined); assert.equal(commitmentOverdue(continued), false); assert.equal(continued.invitedAt, undefined); assert.ok(continued.continuedAt);
});

test('"Rna 欠你 N 件事" asks every overdue promise above the composer of the project conversation, even one asked before', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  let id;
  f.app.store.mutate(state => { id = addCommitment(ensureMind(state.projects.find(row => row.id === f.project.id)), { request: '把前十章写完', overdueAt: Date.now() - 60000 }).id; });
  await f.app.store.invitations.onPresence(f.project.id);
  const first = invitations(f).find(row => row.kind === 'commitment');
  // The card was closed without an answer (dismissed); the promise is still overdue.
  assert.equal((await act(f, first, { action: 'dismiss' })).status, 200);
  assert.equal(invitations(f).filter(row => row.kind === 'commitment').length, 0);
  const response = await fetch(f.url(`/api/v2/projects/${f.project.id}/mind/commitments/ask`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual([body.sessionId, body.overdue, body.offered], [f.session.id, 1, 1]);
  assert.equal(invitations(f).find(row => row.kind === 'commitment')?.commitmentId, id, 'asked again where the user can answer');
  const again = await (await fetch(f.url(`/api/v2/projects/${f.project.id}/mind/commitments/ask`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(again.offered, 0, 'a card already open is not repeated');
});

test('schedule.suggest: the same request on several days becomes a schedule offer at its usual hour; accepting creates it; a dismissal labels the judgment', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const day = 86400000, base = Date.parse('2026-09-20T01:05:00Z');
  f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); for (const [index, text] of ['今天的 AI 新闻整理一下', '帮我看下第四章', '今天的 AI 新闻整理一下', '今天的 AI 新闻整理一下'].entries()) s.items.push({ id: randomUUID(), kind: 'user', text, createdAt: new Date(Date.now() - (4 - index) * day).toISOString().replace(/T.*/, 'T01:05:00.000Z'), simulated: false }); });
  let asked; const labels = [];
  f.app.store.invitations.decisions = { scheduleSuggest: async (_project, input) => { asked = input; return { suggest: true, index: 0, ledgerId: 'L1' }; }, inviteStale: async () => null, labelDecision: (id, value) => labels.push([id, value]) };
  f.app.store.invitations.schedules.agentView = () => ({ defaults: { time: '09:00', timeZone: 'Asia/Shanghai' } });
  await f.app.store.invitations.onPresence(f.project.id);
  assert.equal(asked.requests.length, 4); assert.equal(asked.requests[0].time, 'morning');
  const offer = invitations(f).find(row => row.kind === 'schedule');
  assert.equal(offer.text, '今天的 AI 新闻整理一下'); assert.equal(offer.time, '09:00', '01:05 UTC is 09:05 in Shanghai'); assert.equal(offer.timeZone, 'Asia/Shanghai');
  assert.equal(await f.app.store.invitations.suggestSchedule(f.project.id), null, 'at most once a day');
  assert.equal((await act(f, offer, { action: 'answer', choice: 'accept' })).status, 200);
  const schedule = f.current().schedules.at(-1);
  assert.deepEqual([schedule.task, schedule.rule.kind, schedule.rule.time, schedule.rule.timeZone], ['今天的 AI 新闻整理一下', 'daily', '09:00', 'Asia/Shanghai']);
  assert.deepEqual(labels.at(-1), ['L1', 'schedule_accepted']);
  const other = f.app.store.invitations.offerSchedule(f.session.id, { projectId: f.project.id, title: 'x', task: '每周复盘', time: '10:00', timeZone: 'Asia/Shanghai', ledgerId: 'L2' });
  assert.equal((await act(f, other, { action: 'dismiss' })).status, 200);
  assert.deepEqual(labels.at(-1), ['L2', 'invite_dismissed']);
  void base;
});

test('background work that needs the user is asked above the composer, with one-click answers that clear it', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const now = new Date().toISOString(), actions = [
    { id: 'act-failed', action: 'work', status: 'failed', content: '接手前台被中断的指令：继续优化前 10 章。按 E3 报告逐章扩写，保持既有伏笔，第 8 章优先。', finishedAt: now, errorCode: 'empty_result', handoff: '未完成（empty_result）：第 8 章已扩到 2400 字' },
    { id: 'act-review', action: 'work', status: 'needs_review', blocksExecution: true, content: '提前执行开写前扫尾 6 项', finishedAt: new Date(Date.now() - 60000).toISOString() },
    { id: 'act-old', action: 'work', status: 'failed', content: '很久以前没做完的事', finishedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
    { id: 'act-later', action: 'work', status: 'completed', content: '后来把那件事做完了', finishedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
  ];
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime = { sdkState: { actions } }; });
  const resolved = []; f.app.store.invitations.initiative = { resolveAction: async (projectId, actionId, input) => { resolved.push([actionId, input.status]); } };
  const inv = f.app.store.invitations, judged = [];
  // JEV invite.stale: the old failure was settled by later work, so it is closed quietly instead of asked.
  inv.decisions = { ...inv.decisions, inviteStale: async (_project, input) => { judged.push(input.text); return { stale: /很久以前/.test(input.text), ledgerId: null }; } };
  const first = await inv.offerTaskAttention(f.project.id);
  assert.deepEqual([first.kind, first.actionId, first.mode], ['task', 'act-failed', 'failed'], 'newest first');
  assert.equal(first.text, '接手前台被中断的指令：继续优化前 10 章。', 'the card names the task by its first sentence');
  assert.equal((await inv.offerTaskAttention(f.project.id)).actionId, 'act-review');
  assert.equal(await inv.offerTaskAttention(f.project.id), null);
  assert.equal(f.current().taskMarks['act-old'].choice, 'superseded'); assert.ok(f.current().taskMarks['act-old'].acknowledgedAt);
  assert.equal(judged.length, 2, 'only failures are judged; an unconfirmed outcome is always the user\'s call');
  assert.equal((await act(f, first, { action: 'answer', choice: 'continue' })).status, 200);
  const posted = f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.kind === 'user').at(-1);
  assert.equal(posted.text, '接着完成：接手前台被中断的指令：继续优化前 10 章。', 'one line in the user\'s name');
  assert.deepEqual(posted.continues, { actionId: 'act-failed' });
  // The turn it starts receives the whole task and how far it got, once, as context.
  const deadline = Date.now() + 10000; while (Date.now() < deadline && !f.calls.some(call => JSON.stringify(call).includes('保持既有伏笔'))) await new Promise(resolve => setTimeout(resolve, 20));
  const sent = JSON.stringify(f.calls.find(call => JSON.stringify(call).includes('保持既有伏笔')) ?? null);
  assert.match(sent, /保持既有伏笔，第 8 章优先/); assert.match(sent, /第 8 章已扩到 2400 字/);
  const review = invitations(f).find(row => row.actionId === 'act-review');
  assert.equal((await act(f, review, { action: 'answer', choice: 'continue' })).status, 400, 'an unconfirmed outcome is kept or dropped, not continued');
  // The task page answers the same way and closes the strip.
  const response = await fetch(f.url(`/api/v2/projects/${f.project.id}/tasks/act-review`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'keep' }) });
  assert.equal(response.status, 200); assert.deepEqual(resolved, [['act-review', 'completed']]);
  assert.equal(invitations(f).length, 0);
  const marks = f.current().taskMarks;
  assert.ok(marks['act-failed'].acknowledgedAt && marks['act-review'].acknowledgedAt);
});

test('a "carry on?" card asked before later work completed is judged again and closes when that work answered it', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const at = offset => new Date(Date.now() + offset).toISOString();
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime = { sdkState: { actions: [
    { id: 'act-13', action: 'work', status: 'failed', content: '实现第 13 条赛道。', finishedAt: at(-3600000), errorCode: 'idle_timeout' },
    { id: 'act-14', action: 'work', status: 'failed', content: '实现第 14 条赛道。', finishedAt: at(-3500000), errorCode: 'empty_result' },
  ] } }; });
  const inv = f.app.store.invitations, judged = [];
  inv.decisions = { ...inv.decisions, inviteStale: async (_project, input) => { judged.push(input); return { stale: /第 13 条/.test(input.text) && input.conversation.some(row => /第 13 条赛道已上线/.test(row.text)), ledgerId: null }; } };
  await inv.offerTaskAttention(f.project.id); await inv.offerTaskAttention(f.project.id);
  assert.equal(invitations(f).filter(row => row.kind === 'task').length, 2); judged.length = 0;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await inv.refoldTasks(f.project.id), [], 'nothing completed since: no judge call');
  assert.equal(judged.length, 0);
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiativeRuntime.sdkState.actions.push({ id: 'act-later', action: 'work', status: 'completed', content: '补做第 13 条赛道', resultSummary: '第 13 条赛道已上线', finishedAt: at(0) }); });
  await new Promise(resolve => setTimeout(resolve, 5));
  const folded = await inv.refoldTasks(f.project.id);
  assert.equal(folded.length, 1); assert.equal(judged.length, 2, 'both cards judged once');
  assert.deepEqual(invitations(f).filter(row => row.kind === 'task').map(row => row.actionId), ['act-14']);
  assert.equal(f.current().taskMarks['act-13'].choice, 'superseded');
  assert.deepEqual(await inv.refoldTasks(f.project.id), [], 'not judged again until more work completes'); assert.equal(judged.length, 2);
});

test('a scheduled run that needs the user is named by its schedule on the card and in the "carry on" line', async t => {
  // Live, 2026-10-03: a scheduled run's content is the host's instruction to the worker (occurrence key, due time, rule JSON).
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  const content = 'Scheduled occurrence schedule:s-daily:26981bdb10765e1bbc529558\nDue: 2026-10-03T01:00:00.000Z\nTime rule: {"kind":"daily","time":"09:00"}\n\n写今天的日报。';
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    project.schedules = [{ id: 's-daily', title: '每日 AI 日报', task: '写今天的日报。', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true }];
    project.initiativeRuntime = { sdkState: { actions: [{ id: 'schedule-work-x', action: 'work', status: 'failed', content, hostSchedule: { key: 'schedule:s-daily:26981bdb10765e1bbc529558', scheduleId: 's-daily' }, finishedAt: new Date().toISOString(), errorCode: 'background_failed' }] } };
  });
  const inv = f.app.store.invitations;
  inv.decisions = { ...inv.decisions, inviteStale: async () => ({ stale: false, ledgerId: null }) };
  const card = await inv.offerTaskAttention(f.project.id);
  assert.equal(card.text, '每日 AI 日报（定时任务）', 'the card quotes it itself: 后台“…”没做完');
  assert.equal((await act(f, card, { action: 'answer', choice: 'continue' })).status, 200);
  const posted = f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.kind === 'user').at(-1);
  assert.equal(posted.text, '接着完成：定时任务「每日 AI 日报」');
});
