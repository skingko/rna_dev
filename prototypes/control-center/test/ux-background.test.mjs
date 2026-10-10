import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { backgroundActionView, backgroundControlTools, deliverySummary, revokedLabel } from '../project-background-controls.mjs';
import { actionLabel, taskLine } from '../task-text.mjs';

// UX audit 2026-10-03, background: how background work is named, what stays on the task page after the project's
// scope changes, what a share/ask came to, a paused run that is stopped, and where a refused foreground turn points.
const PLACEHOLDER = 'Previous project scope; retained only as an action receipt.';

test('a task is named by its decision\'s title; without one, the instruction\'s first sentence loses tool names, ids and handles (F14/F34/F51/F89)', () => {
  // Live 2026-10-02/03: 后台“…project_history 读失败动作 007c353e…”没做完; 这次后台在做：目标＝…（turn e666f3a6）.
  assert.equal(actionLabel({}, { action: 'work', title: '  重写第 11 章\n', content: '目标＝推进用户「重写 1-30 章」主线。' }), '重写第 11 章');
  assert.equal(actionLabel({}, { action: 'work', title: 'E3 核对人名', content: 'x' }), '核对人名');
  assert.equal(taskLine('恢复中断现场（有界恢复小步）： 1) 取证：project_history 读失败动作 007c353e 的全部…', 80), '恢复中断现场（有界恢复小步）： 1) 取证：读失败动作的全部…');
  assert.equal(taskLine('接手前台被中断的重写（turn e666f3a6）。然后用 mcp__playwright__browser_wait_for 等待。'), '接手前台被中断的重写。');
  assert.equal(taskLine('E16 批次独立读回验证＋为日程 rev10 同步取数。'), '批次独立读回验证＋为日程 rev10 同步取数。');
  assert.equal(taskLine('整理 project_notes.md 和 out/3fa9b2c1.png。'), '整理 project_notes.md 和 out/3fa9b2c1.png。', 'file names are not ids');
  assert.equal(taskLine('扩写第4章到 3000 字，2026-10-02 前完成。'), '扩写第4章到 3000 字，2026-10-02 前完成。');
  // A revoked action's content is a placeholder for the model, never a name.
  assert.equal(actionLabel({}, { action: 'work', contextRevoked: true, content: PLACEHOLDER }), '');
  // A scheduled run is still named by its schedule.
  assert.equal(actionLabel({ schedules: [{ id: 's1', title: '每日调研' }] }, { action: 'work', title: '别的', hostSchedule: { scheduleId: 's1' } }), '定时任务「每日调研」');
});

test('a fallback name loses only what looks like a record id: named or UUID-shaped, never a plain word, and leaves no broken phrase (F34)', () => {
  // Plain words that happen to be hex stay (reviewer's probes, 2026-10-03).
  assert.equal(taskLine('Fix the decade1 bug'), 'Fix the decade1 bug');
  assert.equal(taskLine('Rewrite chapter cafe1234 now.'), 'Rewrite chapter cafe1234 now.');
  assert.equal(taskLine('Use #ffaa0011 for the title.'), 'Use #ffaa0011 for the title.');
  // A named id goes with its name, and a preposition left pointing at nothing goes too.
  assert.equal(taskLine('Run the deploy for session abcdef12.'), 'Run the deploy.');
  assert.equal(taskLine('Look at session abcdef12 and fix it.'), 'Look and fix it.');
  assert.equal(taskLine('Retry job:abc12345, then report.'), 'Retry, then report.');
  assert.equal(taskLine('What is this for?'), 'What is this for?', 'a preposition is dropped only where an id was');
  assert.equal(taskLine('用户在会话 abcdef12 里问的事。'), '用户在会话里问的事。');
  assert.equal(taskLine('Read 3fa9b2c1-1234-4abc-9def-0123456789ab first.'), 'Read first.');
  // A removed tool name or handle leaves no empty quotes or brackets, nor a space before the stop.
  assert.equal(taskLine('Check "skill_load" output (E2).'), 'Check output.');
  assert.equal(taskLine('调用「project_history」查看（E4）。'), '调用查看。');
  // A list of handles goes as one unit, with a preposition whose only object it was (round-2 review).
  assert.equal(taskLine('Continue chapter 11 (E4, E5).'), 'Continue chapter 11.');
  assert.equal(taskLine('继续写第 11 章（E4、E5）。'), '继续写第 11 章。');
  assert.equal(taskLine('根据 E3、E5 继续写第 11 章。'), '继续写第 11 章。');
  assert.equal(taskLine('根据 E3 的结论继续写。'), '根据的结论继续写。', 'the preposition stays where more of its object follows');
  assert.equal(taskLine('Draft the outline from E2 and E3.'), 'Draft the outline.');
  assert.equal(taskLine('Compare E2/E3 results.'), 'Compare results.');
  // A capitalized Run/Turn starting a sentence is a verb, not a record name.
  assert.equal(taskLine('Run cafe1234 again.'), 'Run cafe1234 again.');
  assert.equal(taskLine('Turn deadbeef1 off.'), 'Turn deadbeef1 off.');
});

test('a share or ask on the task page says what it came to in the user\'s words, never the receipt written for the model (F12)', () => {
  const share = (fields, language) => deliverySummary({ action: 'share', status: 'completed', ...fields }, language);
  assert.equal(share({ deliveryOutcome: 'shared', resultSummary: 'The new finding was shared in the current project conversation.' }), '已发到对话里。');
  assert.equal(share({ deliveryOutcome: 'held' }), '先记在相关话题里，下次聊到这个话题或你回来时一起告诉你。');
  assert.equal(share({ deliveryOutcome: 'filed' }, 'en'), 'Filed in the inbox without interrupting you.');
  // Delivered before the outcome code existed: read from the delivery itself.
  assert.equal(share({ deliveredReach: 'digest', resultSummary: 'The finding was filed in the project inbox for the next daily digest; it was not shown in the conversation.' }), '已放进收件箱，会在每日摘要里一起告诉你。');
  assert.equal(share({ deliveredReach: 'inbox', resultSummary: 'Held in its conversation thread (away): the user will get it … Do not resend it.' }), '先记在相关话题里，下次聊到这个话题或你回来时一起告诉你。');
  assert.equal(share({ deliveredReach: 'inline', resultSummary: 'Handled directly: the fixes were applied to 2 file(s) …' }), '已直接修正，等你在对话里确认保留或回退。');
  // An older quiet share: its delivered message says whether it was posted in the conversation; a revoked one that lost
  // its receipt text and has no message left may have been held or filed, so nothing is claimed.
  const filedText = 'The finding was filed in the project inbox; it was not shown in the conversation.';
  assert.equal(deliverySummary({ action: 'share', status: 'completed', deliveredReach: 'inbox', resultSummary: filedText }, 'zh', { itemId: 'item-1', tier: 'inbox' }), '已发到对话里，没有提醒你。');
  assert.equal(deliverySummary({ action: 'share', status: 'completed', deliveredReach: 'inbox', resultSummary: filedText }, 'zh', { itemId: null, tier: 'inbox' }), '已放进收件箱，没有打断你。');
  assert.equal(deliverySummary({ action: 'share', status: 'completed', deliveredReach: 'inbox', contextRevoked: true }), undefined);
  assert.equal(deliverySummary({ action: 'share', status: 'completed', deliveredReach: 'inbox', contextRevoked: true }, 'zh', { itemId: null, tier: 'inbox' }), '已放进收件箱，没有打断你。');
  assert.equal(deliverySummary({ action: 'share', status: 'completed', deliveredReach: 'inbox', deliveryOutcome: 'held', contextRevoked: true }), '先记在相关话题里，下次聊到这个话题或你回来时一起告诉你。', 'newer records keep their outcome');
  assert.equal(deliverySummary({ action: 'ask', status: 'completed', resultSummary: 'Structured question 4c0f…-uuid was delivered to the project conversation. Status: pending.' }), '已在对话里提问。');
  assert.equal(deliverySummary({ action: 'ask', status: 'completed', resultSummary: 'The requested project permission is already granted. No repeated approval question was created.' }, 'en'), 'The permission was already granted, so you were not asked again.');
  for (const row of [{ action: 'work', status: 'completed' }, { action: 'share', status: 'cancelled' }, { action: 'share', status: 'completed', resolvedAt: 1 }]) assert.equal(deliverySummary(row), undefined, JSON.stringify(row));
});

function host(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-ux-background-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, '.state', 'state.json'));
  const { project, session } = store.createProject({ name: 'Novel', workspace: dir, initiative: { enabled: false } });
  return { dir, store, projectId: project.id, sessionId: session.id, p: () => store.state.projects.find(row => row.id === project.id), items: () => store.state.sessions.find(row => row.id === session.id).items };
}
const viewOf = f => backgroundActionView({ store: f.store, project: id => f.store.state.projects.find(row => row.id === id), contexts: new Map(), valid: () => false }, f.projectId);

test('actions revoked by a scope change stay on the task page as read-only receipts; the placeholder never shows (F40/F53/F82, F84)', async t => {
  const f = host(t), at = Date.parse('2026-10-03T01:00:00Z');
  f.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.projectId);
    project.schedules = [{ id: 's1', title: '每日 AI 新闻与应用调研' }];
    project.initiativeRuntime = { sdkState: { schemaVersion: 1, revision: 1, events: [], seenEventIds: [], actions: [
      { id: 'live', action: 'work', status: 'completed', title: '核对设定集', content: '核对设定集里 E3 的人名。', evidenceIds: ['e'], createdAt: at, finishedAt: at },
      { id: 'w1', action: 'work', status: 'completed', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [], createdAt: at, startedAt: at, finishedAt: at + 60000 },
      { id: 'sched', action: 'work', status: 'completed', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [], hostSchedule: { key: 'k', scheduleId: 's1' }, startedAt: at },
      { id: 'sh1', action: 'share', status: 'completed', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [], deliveredReach: 'inline', deliveryOutcome: 'shared', finishedAt: at },
      { id: 'never', action: 'work', status: 'cancelled', cancellationReason: 'project_scope_changed', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [] },
      { id: 'block', action: 'work', status: 'needs_review', blocksExecution: true, errorCode: 'uncertain_tool', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [], startedAt: at },
      { id: 'gone', action: 'work', status: 'completed', contextRevoked: true, sourceDeleted: true, content: PLACEHOLDER, evidenceIds: [] },
      { id: 'scrubbed', action: 'work', status: 'completed', contextRevoked: true, content: PLACEHOLDER, evidenceIds: [] },
      { id: 'gone-block', action: 'work', status: 'needs_review', blocksExecution: true, sourceDeleted: true, content: '原文已移除', reasonForReview: '原文已移除；外部执行结果仍未确认，须核对后明确解除。', evidenceIds: [] }
    ] } };
    project.jobs = [
      { id: 'w1', title: '扩写第 4 章', instruction: '目标＝推进用户主线。用 project_write 写第 4 章。', handoff: '交接：第 4 章扩写到 3000 字（E2），下一步核对人名。', createdAt: '2026-10-03T01:00:00.000Z', completedAt: '2026-10-03T01:01:00.000Z', status: 'completed', lane: 'background' },
      { id: 'sched', instruction: 'Scheduled occurrence k\nDue: …\n\n执行每日调研。\n\nProduce the requested deliverable …', status: 'completed', lane: 'background' },
      { id: 'block', instruction: '把旧贴图引用批量替换成新路径。', status: 'needs_review', errorCode: 'uncertain_tool', lane: 'background' },
      { id: 'scrubbed', instruction: '原文已移除', status: 'completed', sourceDeleted: true, contextRevoked: true, lane: 'background' }
    ];
    project.inbox = [{ id: 'i1', actionId: 'sh1', kind: 'share', text: '第 4 章写完了，人名还没核对。\n细节……', createdAt: '2026-10-03T01:02:00.000Z' }];
    project.taskMarks = { w1: { at: '2026-10-03T01:03:00.000Z', acknowledgedAt: '2026-10-03T01:03:00.000Z' } };
  });
  const rows = Object.fromEntries(viewOf(f).actions.map(row => [row.id, row]));
  assert.deepEqual(Object.keys(rows), ['live', 'w1', 'sched', 'sh1', 'block', 'gone-block'], 'deleted sources and revoked actions nobody could name are left out, except a result that still blocks');
  // From a deleted conversation, but still holding the foreground back: listed so it can be settled (C2-d).
  assert.equal(rows['gone-block'].revoked, true); assert.equal(rows['gone-block'].status, 'needs_review'); assert.equal(rows['gone-block'].label, '');
  assert.equal(rows.live.label, '核对设定集'); assert.equal(rows.live.revoked, undefined);
  assert.deepEqual(rows.w1, { id: 'w1', action: 'work', status: 'completed', revoked: true, label: '扩写第 4 章', content: '', handoff: '交接：第 4 章扩写到 3000 字，下一步核对人名。',
    receipt: { label: '扩写第 4 章', status: 'completed', startedAt: '2026-10-03T01:00:00.000Z', finishedAt: '2026-10-03T01:01:00.000Z', handoff: '交接：第 4 章扩写到 3000 字，下一步核对人名。' },
    controlRevision: 0, availableControls: [], attention: { at: '2026-10-03T01:03:00.000Z', acknowledgedAt: '2026-10-03T01:03:00.000Z' } });
  assert.equal(rows.sched.label, '定时任务「每日 AI 新闻与应用调研」');
  assert.equal(rows.sh1.label, '第 4 章写完了，人名还没核对。'); assert.equal(rows.sh1.userSummary, '已发到对话里。');
  // The review that blocks the foreground can be found and settled from the task page.
  assert.equal(rows.block.status, 'needs_review'); assert.equal(rows.block.blocksExecution, true); assert.equal(rows.block.label, '把旧贴图引用批量替换成新路径。');
  for (const row of Object.values(rows)) assert.ok(!JSON.stringify(row).includes(PLACEHOLDER) && row.content !== '原文已移除', row.id);
  // The same name for other places that list a revoked action (a review card in the conversation).
  assert.equal(revokedLabel(f.p(), { id: 'block', action: 'work' }, { limit: 80, quoted: true }), '把旧贴图引用批量替换成新路径。');
  assert.equal(revokedLabel(f.p(), { id: 'scrubbed', action: 'work' }), '', 'a deleted source names nothing');
  // English interface: framing follows it.
  f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.equal(viewOf(f).actions.find(row => row.id === 'sched').label, 'the scheduled task "每日 AI 新闻与应用调研"');
  // A model reading the background list sees only the current scope.
  const tools = backgroundControlTools({ project: id => f.store.state.projects.find(row => row.id === id), contexts: new Map(), valid: () => false, store: { state: { sessions: [{ id: 'chat', projectId: f.projectId, turns: [{ id: 'turn', status: 'running' }] }] } } }, { projectId: f.projectId, sessionId: 'chat', turnId: 'turn' });
  const listed = JSON.parse((await tools.find(tool => tool.name === 'project_background_list').execute('call', {})).content[0].text);
  assert.deepEqual(listed.actions.map(row => row.id), ['live']); assert.equal(listed.omitted, 0);
});

async function controllerFixture(t, setup) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-ux-background-scope-')));
  const store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Scope fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-not-a-key', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 2048, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Scope', workspace: dir, initiative: { enabled: false } });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: [], mcpServerIds: [] } }); setup?.(state, state.projects.find(row => row.id === project.id), state.sessions.find(row => row.id === session.id)); });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 1000000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request in this fixture'); } });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, controller, projectId: project.id, sessionId: session.id, p: () => store.state.projects.find(row => row.id === project.id), items: () => store.state.sessions.find(row => row.id === session.id).items };
}

test('a scope change keeps the user\'s record and ends the paused run\'s line, while the model context keeps no prior text (F40, F44)', async t => {
  const f = await controllerFixture(t, (state, project, session) => {
    // A privacy boundary changed (the scope saved by this version differs): only that still revokes (PDL-1).
    project.initiativeRuntime = { sourceHash: 'previous-scope', scopeSchemaVersion: 2, sdkState: { schemaVersion: 1, revision: 3, decisionRevision: 3, nextReviewAt: 0, usedTokens: 0, reservedTokens: 0, events: [], seenEventIds: [], actions: [
      { id: 'p1', action: 'work', status: 'paused', title: '扩写第 7 章 PRIOR_TITLE', content: '扩写第 7 章 PRIOR_CONTENT', evidenceIds: ['e'], intentKey: 'k1', revision: 1, startedAt: 1000, controlRevision: 1, controls: [{ id: 'c1', kind: 'pause', status: 'applied', revision: 1, expectedRevision: 0, createdAt: 1000, settledAt: 1001, summary: 'paused' }], checkpoint: { sessionId: 'p1' } },
      { id: 'd1', action: 'work', status: 'completed', title: '核对人名 PRIOR_TITLE', content: '核对人名 PRIOR_CONTENT', resultSummary: 'PRIOR_RESULT', handoff: '交接：PRIOR_HANDOFF', evidenceIds: ['e'], intentKey: 'k2', revision: 1, startedAt: 900, finishedAt: 950 }
    ] } };
    project.jobs = [{ id: 'p1', title: '扩写第 7 章', instruction: '扩写第 7 章 PRIOR_CONTENT', status: 'paused', lane: 'background', createdAt: '2026-10-03T00:00:00.000Z' }, { id: 'd1', title: '核对人名', instruction: '核对人名 PRIOR_CONTENT', handoff: '交接：两处人名已统一。', status: 'completed', lane: 'background' }];
    session.items.push({ id: 'line', kind: 'assistant', source: 'initiative', text: '后台在做：扩写第 7 章\n\n已暂停，继续后接着做；做完后在这里补上改了哪些文件。', createdAt: '2026-10-03T00:00:00.000Z', initiativeActionId: 'p1-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'p1', status: 'paused', startedAt: '2026-10-03T00:00:00.000Z' } } });
  });
  const model = f.controller.model(f.p());
  await f.controller.create(f.p(), model, f.controller.scope(f.p(), model));
  const saved = f.p().initiativeRuntime.sdkState;
  assert.ok(!/PRIOR_/.test(JSON.stringify(saved)), 'no title, instruction, result or handoff of the previous scope stays in the model\'s state');
  assert.deepEqual(saved.actions.map(row => [row.id, row.status, row.contextRevoked]), [['p1', 'cancelled', true], ['d1', 'completed', true]]);
  const rows = viewOf(f).actions;
  assert.deepEqual(rows.map(row => [row.id, row.revoked, row.status, row.label]), [['p1', true, 'cancelled', '扩写第 7 章'], ['d1', true, 'completed', '核对人名']]);
  assert.equal(rows[1].receipt.handoff, '交接：两处人名已统一。');
  const line = f.items().find(row => row.id === 'line');
  assert.equal(line.initiative.backgroundWork.status, 'cancelled');
  assert.equal(line.text, '这次后台在做：扩写第 7 章 PRIOR_TITLE\n\n它因为项目的情况变了，不再接着做；暂停前做的都保留着，可以在任务页查看它做过的步骤。');
});

test('a foreground turn refused by an unchecked background result points to 任务页 · 待核对 and names the action (F9, F84, C-g)', async t => {
  const f = await controllerFixture(t, (state, project) => {
    project.initiativeRuntime = { sdkState: { schemaVersion: 1, revision: 1, events: [], seenEventIds: [], actions: [
      { id: 'old-review', action: 'work', status: 'needs_review', blocksExecution: true, contextRevoked: true, privacyRevoked: true, content: PLACEHOLDER, evidenceIds: [] }
    ] } };
    project.jobs = [{ id: 'old-review', instruction: '批量替换旧贴图引用。', status: 'needs_review', errorCode: 'uncertain_tool', lane: 'background' }];
  });
  await assert.rejects(f.controller.prepareForeground(f.projectId), error => {
    assert.equal(error.code, 'background_recovery_required'); assert.deepEqual(error.details, { actionId: 'old-review' });
    assert.match(error.message, /任务页 · 待核对/); assert.doesNotMatch(error.message, /项目行动记录/);
    return true;
  });
  // The action it names is on the task page even though a scope change revoked it.
  const row = f.controller.actionView(f.projectId).actions.find(item => item.id === 'old-review');
  assert.equal(row.revoked, true); assert.equal(row.status, 'needs_review'); assert.equal(row.label, '批量替换旧贴图引用。');
  f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  await assert.rejects(f.controller.prepareForeground(f.projectId), error => /Tasks · To verify/.test(error.message) && error.details.actionId === 'old-review');
});

// A paused run stopped from the task page settles at once in the SDK and never runs again: its line said 已暂停 forever.
test('stopping a paused run completes its line, listing the files it changed before the pause (none: it says it stopped); a resumed run keeps them (F44)', async t => {
  const f = host(t);
  const self = Object.create(ProjectInitiativeController.prototype);
  Object.assign(self, { store: f.store, now: () => Date.now(), project: id => f.store.state.projects.find(row => row.id === id), presenceFor: () => ({ session: f.store.state.sessions.find(row => row.id === f.sessionId) }), mutate: fn => f.store.mutate(fn),
    redactValues: () => [], backgroundProject: project => ({ ...project, permissions: { workspace: 'write', background: 'inherit' } }) });
  const context = { projectId: f.projectId, coordinator: { state: { actions: [] } } };
  const line = id => f.items().find(item => item.initiativeActionId === `${id}-changes`);
  const pauseAfter = file => async (_context, _action, { recorder }) => { recorder.capture(file); writeFileSync(join(f.dir, file), '后台写的\n'); return { control: { kind: 'pause' } }; };
  // Paused, then stopped: the line ends with the file it changed.
  writeFileSync(join(f.dir, 'ch7.md'), '旧\n');
  self.work = pauseAfter('ch7.md');
  await self.recordedWork(context, { id: 'stop-me', action: 'work', title: '扩写第 7 章', content: '扩写第 7 章。' }, {});
  assert.equal(line('stop-me').initiative.backgroundWork.status, 'paused');
  context.coordinator.state.actions = [{ id: 'stop-me', action: 'work', status: 'cancelled', title: '扩写第 7 章', content: '扩写第 7 章。', cancellationReason: 'action_control' }];
  self.event(context, { type: 'initiative_action_control', actionId: 'stop-me', kind: 'cancel', status: 'applied' });
  assert.equal(line('stop-me').initiative.backgroundWork.status, 'cancelled');
  assert.match(line('stop-me').text, /^这次后台在做：扩写第 7 章\n\n按你的要求停下了。停之前已经改了 1 个文件/);
  assert.ok(line('stop-me').initiative.backgroundChange, 'its change set is listed and revertible');
  // A stop event for a run whose line already ended (it was running and reported itself) changes nothing.
  const before = line('stop-me').text;
  self.event(context, { type: 'initiative_action_control', actionId: 'stop-me', kind: 'cancel', status: 'applied' });
  assert.equal(line('stop-me').text, before);
  // Paused, then resumed: the line lists the files from both legs.
  writeFileSync(join(f.dir, 'ch8.md'), '旧\n'); writeFileSync(join(f.dir, 'ch9.md'), '旧\n');
  self.work = pauseAfter('ch8.md');
  await self.recordedWork(context, { id: 'resume-me', action: 'work', title: '扩写第 8、9 章', content: '扩写。' }, {});
  self.work = async (_context, _action, { recorder }) => { recorder.capture('ch9.md'); writeFileSync(join(f.dir, 'ch9.md'), '后台写的\n'); return { summary: '写好了。', reported: '第 8、9 章都扩写好了。' }; };
  await self.recordedWork(context, { id: 'resume-me', action: 'work', title: '扩写第 8、9 章', content: '扩写。', checkpoint: { sessionId: 'resume-me' } }, {});
  assert.equal(line('resume-me').text, '第 8、9 章都扩写好了。\n\n改了 2 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。');
  // Paused before it changed any file, then stopped: the line stays and says so (it did not vanish like an unstarted run's).
  self.work = async () => ({ control: { kind: 'pause' } });
  await self.recordedWork(context, { id: 'idle-stop', action: 'work', title: '润色第 10 章', content: '润色第 10 章。' }, {});
  assert.equal(line('idle-stop').initiative.backgroundWork.status, 'paused');
  context.coordinator.state.actions = [{ id: 'idle-stop', action: 'work', status: 'cancelled', title: '润色第 10 章', content: '润色第 10 章。', cancellationReason: 'action_control' }];
  self.event(context, { type: 'initiative_action_control', actionId: 'idle-stop', kind: 'cancel', status: 'applied' });
  assert.equal(line('idle-stop')?.text, '这次后台在做：润色第 10 章\n\n它按你的要求停下了；暂停前做的都保留着，可以在任务页查看它做过的步骤。');
  assert.equal(line('idle-stop').initiative.backgroundWork.status, 'cancelled'); assert.equal(line('idle-stop').initiative.backgroundChange, undefined);
  // Without the snapshots (a restart in between), the line still says it stopped.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.sessionId).items.push({ id: 'old-line', kind: 'assistant', source: 'initiative', text: '后台在做：x\n\n已暂停', createdAt: new Date().toISOString(), initiativeActionId: 'after-restart-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'after-restart', status: 'paused' } } }); });
  context.coordinator.state.actions = [{ id: 'after-restart', action: 'work', status: 'cancelled', title: '整理大纲', content: '整理大纲。' }];
  self.event(context, { type: 'initiative_action_control', actionId: 'after-restart', kind: 'cancel', status: 'applied' });
  assert.equal(line('after-restart').text, '这次后台在做：整理大纲\n\n它按你的要求停下了；暂停前做的都保留着，可以在任务页查看它做过的步骤。');
  assert.equal(line('after-restart').initiative.backgroundWork.status, 'cancelled');
});

test('after a restart, a line still 已暂停 whose run was stopped meanwhile says it stopped; one still paused is left alone (F44)', t => {
  const f = host(t);
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.sessionId), project = state.projects.find(row => row.id === f.projectId);
    for (const id of ['stopped', 'still']) session.items.push({ id: `line-${id}`, kind: 'assistant', source: 'initiative', text: '后台在做：x\n\n已暂停', createdAt: new Date().toISOString(), initiativeActionId: `${id}-changes`, initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: id, status: 'paused' } } });
    project.initiativeRuntime = { sdkState: { actions: [{ id: 'stopped', action: 'work', status: 'cancelled', cancellationReason: 'project_scope_changed', contextRevoked: true, content: PLACEHOLDER }, { id: 'still', action: 'work', status: 'paused', title: '扩写第 2 章', content: '扩写第 2 章。' }] } };
  });
  const self = Object.create(ProjectInitiativeController.prototype);
  Object.assign(self, { store: f.store, now: () => Date.now(), mutate: fn => f.store.mutate(fn), redactValues: () => [] });
  self.settleWorkLines();
  const stopped = f.items().find(row => row.id === 'line-stopped'), still = f.items().find(row => row.id === 'line-still');
  assert.equal(stopped.initiative.backgroundWork.status, 'cancelled');
  assert.equal(stopped.text, '这次暂停的后台工作因为项目的情况变了，不再接着做；暂停前做的都保留着，可以在任务页查看它做过的步骤。', 'a revoked action is never named by its placeholder');
  assert.equal(still.initiative.backgroundWork.status, 'paused'); assert.equal(still.text, '后台在做：x\n\n已暂停');
});
