// Synthetic, hand-written benchmark state (no production content). Used by the
// tests and as an example of what the extractor reads. Times are UTC; the
// project's schedule sets Asia/Shanghai (UTC+8) as the user's time zone.
// Expected metrics for this state are asserted in test/bench-metrics.test.mjs.
export const SYNTHETIC_NOW = '2026-10-10T12:00:00.000Z';
export const PROJECT_ID = 'proj-synthetic', SESSION_ID = 'sess-synthetic';
const turn = (id, userItemId, status, from, to, tokens, extra = {}) => ({ id, status, userItemId, createdAt: from, startedAt: from, completedAt: to, usage: { totalTokens: tokens, cacheRead: Math.round(tokens / 2), input: tokens }, modelConfig: { execution: 'rna' }, simulated: false, ...extra });
const user = (id, at, text, turnId) => ({ id, turnId, kind: 'user', text, createdAt: at, simulated: false, delivery: 'send' });
const reply = (id, turnId, at, text) => ({ id, turnId, kind: 'assistant', text, createdAt: at, simulated: false, final: true });
const tool = (id, turnId, at, status) => ({ id, turnId, kind: 'tool', text: 'project_exec', createdAt: at, simulated: false, tool: { name: 'project_exec', status } });
const proactive = (id, at, text, extra = {}) => ({ id, turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId: PROJECT_ID, initiativeActionId: `act-${id}`, initiative: { kind: 'insight', reach: 'inline' }, ...extra });
const decision = (id, at, action, extra = {}) => ({ id, at, action, reason: `synthetic ${action}`, content: action === 'share' ? 'synthetic share' : '', evidenceIds: ['message:u1'], status: 'completed', decisionMode: 'rna-model', simulated: false, ...extra });

export function syntheticState() {
  const items = [
    proactive('p0', '2026-10-09T10:00:00.000Z', '每日报告\n| 文件 | 内容 |\n|---|---|\n| a.md | 摘要 |\n| b.json | 来源 |\n| c.js | 脚本 |', { initiative: { kind: 'scheduled', reach: 'inline' }, scheduleId: 'schedule-1' }),
    proactive('p4', '2026-10-09T16:00:00.000Z', '夜间核查：锚点零漂移，无新变化。'),
    user('u1', '2026-10-10T06:00:00.000Z', '继续开发关卡', 't1'),
    tool('k1', 't1', '2026-10-10T06:05:00.000Z', 'succeeded'), tool('k2', 't1', '2026-10-10T06:06:00.000Z', 'succeeded'),
    reply('a1', 't1', '2026-10-10T06:10:00.000Z', '已新增第三关。'),
    proactive('p1', '2026-10-10T07:00:00.000Z', '发现：第二关落点被遮挡，已修复。'),
    user('u2', '2026-10-10T07:30:00.000Z', '场景仍然太单调', 't2'),
    tool('k3', 't2', '2026-10-10T07:31:00.000Z', 'failed'),
    proactive('p2', '2026-10-10T08:00:00.000Z', '补充：远景山体加了三层，并修复了闪烁。'),
    proactive('p3', '2026-10-10T08:10:00.000Z', '补充：远景山体已加三层，闪烁也修复了。'),
    user('u3', '2026-10-10T08:20:00.000Z', '不错，这样可以了', 't3'),
    reply('a3', 't3', '2026-10-10T08:21:00.000Z', '好的。'),
    user('u4', '2026-10-10T09:00:00.000Z', '以后你自己决定，不需要问我', 't4'),
    user('u5', '2026-10-10T09:30:00.000Z', '场景仍然太单调', 't5'),
    tool('k4', 't5', '2026-10-10T09:35:00.000Z', 'succeeded'), tool('k5', 't5', '2026-10-10T09:36:00.000Z', 'succeeded'), tool('k6', 't5', '2026-10-10T09:37:00.000Z', 'failed'), tool('k7', 't5', '2026-10-10T09:38:00.000Z', 'succeeded'),
    reply('a5', 't5', '2026-10-10T09:50:00.000Z', '远景改成了水墨晕染。'),
    proactive('p5', '2026-10-10T11:00:00.000Z', '进展：已把远景改为水墨晕染。'),
    user('u6', '2026-10-10T11:30:00.000Z', '现在进展怎么样了？', null),
  ];
  const turns = [
    turn('t1', 'u1', 'completed', '2026-10-10T06:00:00.000Z', '2026-10-10T06:10:00.000Z', 1000),
    turn('t2', 'u2', 'failed', '2026-10-10T07:30:00.000Z', '2026-10-10T07:35:00.000Z', 500),
    turn('t3', 'u3', 'completed', '2026-10-10T08:20:00.000Z', '2026-10-10T08:21:00.000Z', 200),
    turn('t4', 'u4', 'stopped', '2026-10-10T09:00:00.000Z', '2026-10-10T09:01:00.000Z', 100),
    turn('t5', 'u5', 'completed', '2026-10-10T09:30:00.000Z', '2026-10-10T09:50:00.000Z', 3000, { runtimeAttempts: 2 }),
  ];
  const project = {
    id: PROJECT_ID, name: 'Synthetic ink game', decisionMode: 'rna-model', simulated: false, sessionIds: [SESSION_ID], primarySessionId: SESSION_ID, openQuestions: ['目标平台？'],
    schedules: [{ id: 'schedule-1', title: '每日报告', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: SESSION_ID, enabled: true }],
    decisions: [decision('d2', '2026-10-10T07:00:00.000Z', 'share'), decision('d3', '2026-10-10T08:00:00.000Z', 'share'), decision('d4', '2026-10-10T10:00:00.000Z', 'work')],
    jobs: [{ id: 'job-1', kind: 'research', lane: 'background', status: 'completed', createdAt: '2026-10-10T10:30:00.000Z', completedAt: '2026-10-10T11:10:00.000Z', simulated: false }, { id: 'schedule-work-1', kind: 'research', status: 'completed', createdAt: '2026-10-09T09:59:00.000Z', completedAt: '2026-10-09T10:00:00.000Z', simulated: false }],
    versions: [{ id: 'v0', state: 'baseline' }, { id: 'v1', state: 'rejected', source: { kind: 'autonomous-project-evolution' }, evaluation: { gatePassed: false } }, { id: 'v2', state: 'failed', source: { kind: 'autonomous-project-evolution' }, evaluation: null }],
    initiative: { enabled: true }, evolution: { enabled: true },
  };
  const state = { version: 1, projects: [project], sessions: [{ id: SESSION_ID, projectId: PROJECT_ID, title: '项目讨论', items, turns, simulated: false }] };
  const side = {
    archivedDecisions: [decision('d1', '2026-10-10T05:00:00.000Z', 'wait'), decision('d2', '2026-10-10T07:00:00.000Z', 'share')],
    wakeFailures: [{ id: 'f1', at: 1791604800000, phase: 'decision', code: 'invalid_decision' }, { id: 'f2', at: 1791608400000, phase: 'work', code: 'interrupted' }],
    usageRows: [
      { at: '2026-10-10T05:00:00.000Z', purpose: 'initiative', projectId: PROJECT_ID, input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, cacheReported: true },
      { at: '2026-10-10T07:00:00.000Z', purpose: 'initiative', projectId: PROJECT_ID, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReported: false },
      { at: '2026-10-10T08:00:00.000Z', purpose: 'initiative', projectId: PROJECT_ID, input: 3000, output: 500, cacheRead: 0, cacheWrite: 0, cacheReported: true },
      { at: '2026-10-10T09:00:00.000Z', purpose: 'foreground', projectId: PROJECT_ID, input: 9000, output: 900, cacheRead: 0, cacheWrite: 0, cacheReported: true },
    ],
  };
  return { state, side };
}
