// @ts-nocheck -- fixtures deliberately use malformed, partial and historical record shapes.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { adaptiveRhythmDisplay, rhythmReason } from './rhythm'
import { backgroundModelRestriction } from './background-model'
import { evolutionStatusRows } from './autonomy-frequency'
import { projectActivity, continuationLabel, actionControlStatus } from './activity'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Ported 1:1 from the host's legacy public/*.js display tests when the legacy UI was removed.

// ---- adaptive rhythm (test/adaptive-autonomy-display.test.mjs)
{
const project = () => ({ id: 'p', initiative: { enabled: true }, evolution: { enabled: true }, rhythm: { control: 'auto' }, rhythmStatus: {
  control: 'auto', lifecycle: 'recurring', assessmentRequired: false, effective: { initiativeEnabled: true, evolutionEnabled: true },
  schedule: { activeCount: 1, dueCount: 0, nextAt: 1790438400000 }, initiative: { eligible: false, reason: 'awaiting_scheduled_work', nextAt: 1790438400000, state: 'sleeping' },
  evolution: { eligible: false, reason: 'weekly_review_quota', state: 'sleeping', nextAt: 1790524800000, quota: { dayUsed: 1, weekUsed: 2, maxPerDay: 1, maxPerWeek: 2, window: 'rolling' } },
  assessment: { reason: '每天完成一篇调研，交付间隙等待新信息。', initiative: { mode: 'event_only' }, evolution: { mode: 'weekly' } }, history: []
} });
test('a recurring project waiting for delivery is not shown as disabled or actively working', () => {
  const shown = adaptiveRhythmDisplay(project()); assert.match(shown.title, /自动适配 · 周期交付/); assert.match(shown.initiative, /间隙保持安静.*日程照常执行/); assert.match(shown.schedule, /下次任务/); assert.match(shown.quota, /滚动 24 小时 1\/1.*滚动 7 天 2\/2/); assert.match(shown.evolution, /按周复盘.*最早/); assert.doesNotMatch(shown.evolution, /新版本|保证/);
});
test('hard user off and model soft waiting remain distinct', () => {
  const p = project(); p.rhythmStatus.effective.evolutionEnabled = false;
  assert.equal(adaptiveRhythmDisplay(p).evolution, '当前暂停自动复盘'); p.evolution.enabled = false; p.initiative.enabled = false;
  const shown = adaptiveRhythmDisplay(p); assert.equal(shown.evolution, '自主进化已关闭'); assert.equal(shown.title, '主动协作已关闭'); assert.equal(shown.initiative, '主动协作已关闭');
});
test('unknown schedules or host status never become a claimed scheduled task or zero count', () => {
  const p = project(); p.rhythmStatus.schedule = { activeCount: 0, dueCount: 0, nextAt: null };
  assert.equal(adaptiveRhythmDisplay(p).schedule, '暂无定时任务'); p.rhythmStatus.initiative.reason = 'recurring_schedule_missing'; assert.match(adaptiveRhythmDisplay(p).initiative, /尚未安排/);
  delete p.rhythmStatus; assert.equal(adaptiveRhythmDisplay(p).available, false); assert.match(adaptiveRhythmDisplay(p).title, /等待项目判断/);
});
test('adjustments are bounded model history and diagnostic reasons retain unknown codes', () => {
  const p = project(); p.rhythmStatus.history = Array.from({ length: 7 }, (_, i) => ({ at: 1790438400000 + i, lifecycle: 'complete', reason: `r${i}`, initiativeMode: 'event_only', evolutionMode: 'off', source: 'model' }));
  const shown = adaptiveRhythmDisplay(p); assert.equal(shown.history.length, 5); assert.equal(shown.history[0].reason, 'r6'); assert.equal(shown.history[0].stage, '阶段已完成'); assert.match(rhythmReason('new_future_code'), /new_future_code/); assert.match(rhythmReason('no_unreviewed_evidence'), /尚未复盘/);
});
test('manual mode does not present prior model weekly policy or rolling quotas as currently enforced', () => {
  const p = project(); p.rhythmStatus.control = 'manual';
  const shown = adaptiveRhythmDisplay(p); assert.equal(shown.quota, ''); assert.equal(shown.title, '手动固定节奏'); assert.match(shown.initiative, /手动频率/); assert.match(shown.evolution, /手动频率/); assert.doesNotMatch(shown.evolution, /按周/); assert.doesNotMatch(shown.reason, /每天完成/);
});
test('host admission blockers replace false observing and scheduled-delivery promises without changing saved cadence', () => {
  const p = project(), original = structuredClone(p.rhythmStatus);
  p.initiativeRuntime = { availability: { state: 'blocked', reason: 'session_cleanup_pending', title: '后台暂缓 · 会话清理待完成', message: '会话关联数据仍在清理，后台协作暂缓。', details: { pendingCount: 1, attempts: 4, codes: ['SESSION_EVIDENCE_JOURNAL_UNKNOWN'] } } };
  const shown = adaptiveRhythmDisplay(p); assert.match(shown.title, /清理待完成/); assert.match(shown.initiative, /暂缓/); assert.match(shown.evolution, /暂缓/); assert.match(shown.schedule, /日程暂缓/);
  assert.doesNotMatch(shown.initiative, /日程照常执行|可根据项目状态行动/); assert.equal(shown.blocker.pendingCount, 1); assert.deepEqual(p.rhythmStatus, original);
  p.initiative.enabled = false; assert.equal(adaptiveRhythmDisplay(p).title, '主动协作已关闭');
  p.initiative.enabled = true; p.evolution.enabled = false; assert.equal(adaptiveRhythmDisplay(p).evolution, '自主进化已关闭');
  delete p.initiativeRuntime.availability; assert.match(adaptiveRhythmDisplay(p).initiative, /日程照常执行/);
});
}

// ---- background model (test/background-model-display.test.mjs)
{
const configuration = { defaultModel: { providerId: 'plan', modelId: 'k3' }, providers: [
  { id: 'plan', name: 'Kimi 套餐', usagePolicy: 'interactive_only', models: [{ id: 'k3', name: 'K3' }] },
  { id: 'api', name: 'Kimi 开放平台', models: [{ id: 'k3' }] },
] };
const project = { id: 'p', simulated: false, initiative: { enabled: true } };
test('background restriction follows the public provider policy and identifies the actual default route', () => {
  const display = backgroundModelRestriction(project, configuration);
  assert.equal(display.code, 'interactive_only'); assert.equal(display.source, '应用默认模型');
  assert.equal(display.route, 'Kimi 套餐 / K3'); assert.match(display.message, /前台交互.*主动协作和自进化/);
});
test('an explicit project background route overrides the global default in both directions', () => {
  assert.equal(backgroundModelRestriction({ ...project, initiative: { modelSelection: { providerId: 'api', modelId: 'k3' } } }, configuration), null);
  const display = backgroundModelRestriction({ ...project, initiative: { modelSelection: { providerId: 'plan', modelId: 'k3' } } }, { ...configuration, defaultModel: { providerId: 'api', modelId: 'k3' } });
  assert.equal(display.source, '项目后台模型');
});
test('interactive session selections and provider names cannot invent a background restriction', () => {
  assert.equal(backgroundModelRestriction({ ...project, modelSelection: { providerId: 'plan', modelId: 'k3' } }, { ...configuration, defaultModel: { providerId: 'api', modelId: 'k3' } }), null);
  assert.equal(backgroundModelRestriction(project, { defaultModel: { providerId: 'unknown' }, providers: configuration.providers }), null);
  assert.equal(backgroundModelRestriction(project, null), null);
  assert.equal(backgroundModelRestriction({ ...project, simulated: true }, configuration), null);
});
}

// ---- evolution status (test/evolution-status-ui.test.mjs)
{
const rows = project => Object.fromEntries(evolutionStatusRows(project, { formatTime: date => date.toISOString() }).map(row => [row.key, row.value]));

test('version status separates eligibility, learning start, model intent and actual rejected candidate', () => {
  const project = {
    initiative: { enabled: true }, evolution: { enabled: true, minIntervalMs: 3600000, lastAutonomousStartedAt: '2026-09-24T17:26:47.094Z' },
    versions: [
      { id: 'candidate', parentVersionId: 'base', createdAt: '2026-09-24T15:00:40Z', state: 'rejected', assessment: { label: '候选脚本未通过' } },
      { id: 'base', createdAt: '2026-09-25T00:00:00Z', state: 'active' },
      { id: 'demo', parentVersionId: 'base', createdAt: '2026-09-26T00:00:00Z', state: 'ready', simulated: true },
    ],
    initiativeRuntime: { nextReviewAt: '2026-09-25T05:22:51.584Z', sdkState: { lastDecision: { action: 'wait', reason: '等待用户对当前页面的反馈。', at: Date.parse('2026-09-25T05:07:51.584Z') }, actions: [{ action: 'learn', status: 'cancelled', createdAt: 12, startedAt: 15, cancellationReason: 'host_context_changed' }] } },
  };
  const before = JSON.stringify(project), result = rows(project);
  assert.match(result.interval, /1 小时.*不保证按周期生成或推送/);
  assert.match(result.started, /17:26:47\.094Z.*不表示.*完成/);
  assert.match(result.candidate, /15:00:40\.000Z.*候选脚本未通过/);
  assert.match(result.decision, /等待.*05:07:51\.584Z.*等待用户/);
  assert.match(result.review, /05:22:51\.584Z.*不是学习启动承诺/);
  assert.match(result['learning-action'], /已取消.*旧记录未保留足够具体/);
  assert.doesNotMatch(result['learning-action'], /没有.*证据|项目上下文已变化/);
  assert.equal(JSON.stringify(project), before);
});

test('new evidence rejection is only displayed from an explicit host cancellation receipt', () => {
  const result = rows({ initiativeRuntime: { sdkState: { actions: [{ action: 'learn', status: 'completed', createdAt: 1 }, { action: 'learn', status: 'cancelled', createdAt: 2, cancellationReason: 'learning_requires_new_evidence' }, { action: 'work', status: 'running', createdAt: 3 }] } } });
  assert.match(result['learning-action'], /宿主未开始生成.*已用于候选评估/);
  assert.equal(result.decision, '尚无模型判断记录。');
  assert.equal(result.started, '尚无自动学习启动记录。');
});

test('paused and never-started projects do not claim execution or a future learning appointment', () => {
  const result = rows({ initiative: { enabled: false }, evolution: { enabled: false, minIntervalMs: 0 }, initiativeRuntime: { nextReviewAt: '2026-09-25T05:22:51Z' } });
  assert.match(result.enabled, /已关闭.*主动能力已暂停/);
  assert.equal(result.candidate, '尚无候选记录。');
  assert.match(result.review, /已暂停.*原计划/);
  assert.match(result.interval, /不设最短间隔.*不保证/);
  assert.equal(rows({ initiativeRuntime: { sdkState: { nextReviewAt: 0 } } }).review, '尚未记录下次复查时间。');
});

test('model reason is bounded and malformed dates stay unknown instead of showing Invalid Date', () => {
  const result = rows({ evolution: { lastAutonomousStartedAt: 'invalid' }, initiativeRuntime: { nextReviewAt: 'invalid', sdkState: { lastDecision: { action: 'learn', reason: '字'.repeat(4000), at: 'invalid' } } } });
  assert.ok(result.decision.length < 650);
  assert.match(result.decision, /自动学习.*…$/);
  assert.doesNotMatch(JSON.stringify(result), /Invalid Date/);
  assert.equal(result.started, '尚无自动学习启动记录。');
});
}

// ---- learning review rows (test/learning-outcome-routing.test.mjs)
test('revoked review UI separates historical result from source availability and does not invent lost legacy status', () => {
  const summary = review => evolutionStatusRows({ learningRuntime: { sdkState: { episodes: [], reviews: [review] } } }).find(row => row.key === 'learning-review').value;
  assert.match(summary({ status: 'completed', statusBeforeRevocation: 'completed', sourceRevoked: true }), /实验已结束.*来源已撤销.*历史结果/);
  assert.match(summary({ status: 'failed', statusBeforeRevocation: 'failed', sourceRevoked: true, error: { code: 'invalid_learning_reflection' } }), /复盘失败.*invalid_learning_reflection.*来源已撤销/);
  assert.match(summary({ status: 'interrupted', statusBeforeRevocation: 'executing', sourceRevoked: true }), /复盘或实验已中断.*来源已撤销/);
  assert.match(summary({ status: 'interrupted', sourceRevoked: true, decision: { reason: 'PRIVATE' } }), /旧记录未保留原执行状态/);
  assert.ok(!summary({ status: 'completed', statusBeforeRevocation: 'completed', sourceRevoked: true, decision: { reason: 'PRIVATE' } }).includes('PRIVATE'));
});

// ---- learning outcomes (test/project-learning-controller.test.mjs)
test('evolution UI shows durable learning outcomes instead of treating work/wait decisions as learning', () => {
  const rows = evolutionStatusRows({ learningRuntime: { sdkState: { episodes: [{ status: 'pending' }, { status: 'deferred' }], reviews: [{ status: 'no_change', decision: { reason: 'The evidence does not justify a reusable change' } }] } } });
  assert.match(rows.find(row => row.key === 'learning-backlog').value, /待复盘 1 条.*等待条件 1 条/);
  assert.match(rows.find(row => row.key === 'learning-review').value, /暂不需要.*does not justify/);
  assert.ok(!rows.some(row => row.key === 'learning-action'));
});

// ---- project activity (test/initiative-activity-ui.test.mjs)
{
const fixture = () => ({ id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [] } } });
test('Activity projects actual retained actions and distinguishes tool receipts from final summaries', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'a', action: 'work', status: 'needs_review', content: 'A task', resultSummary: 'Model says done', errorCode: 'interrupted', finishedAt: 200 });
  p.jobs.push({ id: 'a', status: 'cancelled', toolReceiptCounts: { total: 3, completed: 2, failed: 1, uncertain: 0 }, toolReceipts: [{ toolName: 'forged', status: 'completed' }, { recordedByHost: true, toolName: 'project_exec', status: 'failed', output: 'real diagnostic', at: 100 }] });
  const [row] = projectActivity(p); assert.equal(row.statusLabel, '结果待核对'); assert.equal(row.jobStatusLabel, '已取消'); assert.equal(row.summary, 'Model says done'); assert.deepEqual(row.counts, { total: 3, completed: 2, failed: 1, uncertain: 0 }); assert.equal(row.receipts.length, 1); assert.equal(row.receipts[0].output, 'real diagnostic');
});
test('A communication decision is not delivery, and a message from another project cannot supply a receipt', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'share', action: 'share', status: 'completed', content: 'news' });
  const session = { id: 's', projectId: 'other', items: [{ kind: 'assistant', source: 'initiative', initiativeActionId: 'share', createdAt: '2026-09-25T00:00:00Z' }] };
  assert.equal(projectActivity(p, [session])[0].delivered, false); assert.match(projectActivity(p, [session])[0].statusLabel, /未找到消息回执/);
  session.projectId = 'p'; assert.equal(projectActivity(p, [session])[0].delivered, true); assert.equal(projectActivity(p, [session])[0].statusLabel, '已送达会话');
  session.items[0].sourceDeleted = true; assert.equal(projectActivity(p, [session])[0].delivered, false);
});
test('Actual initiative question cards establish delivery and retain pending, answered and cancelled state', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'ask', action: 'ask', status: 'completed', content: 'question' });
  const item = { kind: 'question', source: 'interaction', createdAt: '2026-09-25T00:00:00Z', interaction: { id: 'question-id', actionId: 'ask', source: 'initiative', status: 'pending' } }, session = { id: 's', projectId: 'p', items: [item] };
  for (const [status, expected] of [['pending', '待回答'], ['answered', '已回答'], ['cancelled', '问题已取消'], ['interrupted', '回答已中断']]) {
    item.interaction.status = status; const [row] = projectActivity(p, [session]); assert.equal(row.delivered, true); assert.equal(row.questionStatus, status); assert.equal(row.deliverySessionId, 's'); assert.ok(row.statusLabel.includes(expected));
  }
});
test('Question receipt identity cannot cross projects, action kind, tool source or removed evidence', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'ask', action: 'ask', status: 'completed' });
  const item = { kind: 'question', source: 'interaction', interaction: { actionId: 'ask', source: 'initiative', status: 'pending' } }, session = { id: 's', projectId: 'p', items: [item] };
  for (const mutate of [s => { s.projectId = 'other'; }, s => { s.items[0].sourceDeleted = true; }, s => { s.items[0].contextRevoked = true; }, s => { s.items[0].interaction.contextRevoked = true; }, s => { s.items[0].interaction.source = 'tool'; }, s => { s.items[0].kind = 'assistant'; }, s => { s.items[0].interaction.actionId = 'other'; }]) {
    const copy = structuredClone(session); mutate(copy); assert.equal(projectActivity(p, [copy])[0].delivered, false);
  }
  p.initiativeRuntime.sdkState.actions[0].action = 'share'; assert.equal(projectActivity(p, [session])[0].delivered, false);
});
test('A second question deferred by an unanswered card is not falsely delivered', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'later', action: 'ask', status: 'queued', deferredReason: 'pending_question' });
  const [row] = projectActivity(p); assert.equal(row.statusLabel, '等待发送'); assert.match(row.detail, /已有待回答的问题/); assert.equal(row.delivered, false);
});
// UX audit round 2: the wait before it was cancelled (a reply in progress) is not why it was not sent, so only the cancellation is said.
test('Deferred then superseded shares give the actual unsent reason, not the earlier wait, without claiming delivery', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions.push({ id: 'a', action: 'share', status: 'cancelled', deferredReason: 'active_turn', cancellationReason: 'new_project_evidence' });
  const [row] = projectActivity(p); assert.equal(row.statusLabel, '未发送 · 已取消'); assert.doesNotMatch(row.detail, /当前回复进行中/); assert.match(row.detail, /原消息已取消/); assert.equal(row.delivered, false);
});
test('Running actions are visible before settled records; revoked, removed and simulated rows are excluded', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions = [{ id: 'done', action: 'work', status: 'completed', finishedAt: 200 }, { id: 'run', action: 'work', status: 'running', startedAt: 100 }, { id: 'removed', action: 'work', sourceDeleted: true }, { id: 'old', action: 'work', contextRevoked: true }, { id: 'demo', action: 'learn', simulated: true }];
  assert.deepEqual(projectActivity(p).map(row => row.id), ['run', 'done']); assert.equal(projectActivity(p)[0].counts, null); p.simulated = true; assert.deepEqual(projectActivity(p), []);
});
test('Durable pending controls remain requests, paused work stays visible ahead of historical completion', () => {
  const p = fixture(); p.initiativeRuntime.sdkState.actions = [
    { id: 'done', action: 'work', status: 'completed', finishedAt: 500 },
    { id: 'paused', action: 'work', status: 'paused', startedAt: 100, controlRevision: 2 },
    { id: 'pausing', action: 'work', status: 'running', startedAt: 90, controls: [{ kind: 'pause', status: 'pending' }] },
  ];
  const rows = projectActivity(p); assert.deepEqual(rows.map(row => row.id), ['pausing', 'paused', 'done']);
  assert.equal(rows[0].statusLabel, '正在暂停'); assert.equal(rows[0].active, true); assert.equal(rows[1].statusLabel, '已暂停'); assert.equal(rows[1].active, false); assert.equal(rows[1].paused, true);
  assert.equal(actionControlStatus({ status: 'running', controls: [{ kind: 'cancel', status: 'pending' }] }), '正在停止');
  assert.equal(actionControlStatus({ status: 'needs_review', controls: [{ kind: 'pause', status: 'rejected' }] }), '结果待核对');
  for (const [status, expected] of [['needs_review', '结果待核对'], ['failed', '未完成'], ['completed', '已结束'], ['paused', '已暂停']]) assert.equal(actionControlStatus({ status, controls: [{ kind:'pause', status:'pending' }] }), expected);
});
test('Continuation is a persisted same-turn scheduling receipt and never inferred from a failed step limit', () => {
  assert.equal(continuationLabel({ status: 'failed', errorCode: 'step_limit' }), '');
  // Plan 2026-09-30 §2.5: the user only needs to know the work is carrying on, not how it is sliced.
  assert.equal(continuationLabel({ continuation: { status: 'scheduled', segments: 2 } }), '正在继续');
  assert.equal(continuationLabel({ continuation: { status: 'completed', segments: 2 } }), '');
  assert.equal(continuationLabel({ continuation: { status: 'invented', segments: 2 } }), '');
});
for (const [status, expected] of [['paused', '已暂停'], ['stopped', '已停止'], ['failed', '未完成']]) test(`Terminal or controlled ${status} turn overrides stale scheduled/running continuation`, () => {
  for (const continuationStatus of ['scheduled', 'running']) {
    const label = continuationLabel({ status, continuation: { status: continuationStatus, segments: 3 } });
    assert.equal(label, expected); assert.doesNotMatch(label, /接续|分片/);
  }
});
}
