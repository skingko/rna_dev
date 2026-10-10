/* Mock fixtures for the v2 Project Mind (lessons, agenda, commitments,
   threads, notes, pacing, health) and the §5 metrics. */
import type { MetricKey, MetricValue, ProjectMind } from '@/api/mind-api'
import { ago } from './fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString()

export const inkMind = (): ProjectMind => ({
  projectId: 'p-ink', revision: 1, updatedAt: ago(4 * MIN),
  lessons: [
    { id: 'l-1', kind: 'preference', text: '主动消息第一句就给结论，不要附交付物详单。', scope: 'user', status: 'active', createdAt: ago(5 * DAY), updatedAt: ago(2 * DAY), source: { kind: 'correction', sessionId: 's-ui', itemId: 'u-ui-1' }, uses: { recalled: 14, applied: 11, contradicted: 0 } },
    { id: 'l-2', kind: 'preference', text: '能自己决定的小改动直接做，完成后告诉我结果，不需要先问。', scope: 'user', status: 'active', createdAt: ago(3 * DAY), source: { kind: 'correction', sessionId: 's-ui', itemId: 'u-ui-1' }, uses: { recalled: 6, applied: 5, contradicted: 1 } },
    { id: 'l-3', kind: 'constraint', text: 'HUD 分数必须始终在芦苇之上（z-index ≥ 30），任何场景都不能被遮挡。', scope: 'project', taskTypes: ['design'], status: 'active', createdAt: ago(26 * HOUR), source: { kind: 'correction', sessionId: 's-ui', itemId: 'pro-0' }, uses: { recalled: 3, applied: 2, contradicted: 0 } },
    { id: 'l-4', kind: 'pitfall', text: '交付截图前先在 390px 宽度与 Redmi 9 档位各看一次，避免芦苇遮挡与掉帧。', scope: 'project', status: 'active', until: ahead(20 * DAY), createdAt: ago(2 * DAY), source: { kind: 'failure_review', sessionId: 's-ui', itemId: 'a-ui-3' }, uses: { recalled: 4, applied: 3, contradicted: 0 } },
    { id: 'l-5', kind: 'pitfall', text: '`vite build` 压缩 4K 纸纹理会内存不足，先降到 2K 再构建。', scope: 'project', taskTypes: ['coding'], status: 'active', createdAt: ago(30 * HOUR), source: { kind: 'failure_review' }, uses: { recalled: 2, applied: 2, contradicted: 0 } },
    { id: 'l-6', kind: 'success_habit', text: '工具行用单行结构并合并同类调用；这种做法第一次交付就被接受。', scope: 'project', status: 'active', createdAt: ago(20 * HOUR), source: { kind: 'accepted_delivery', sessionId: 's-ui', itemId: 'a-ui-3' }, uses: { recalled: 1, applied: 1, contradicted: 0 } },
    { id: 'l-7', kind: 'preference', text: '每次交付都附完整的文件改动清单。', scope: 'user', status: 'superseded', supersededBy: 'l-1', createdAt: ago(9 * DAY), updatedAt: ago(5 * DAY), source: { kind: 'conversation' }, uses: { recalled: 9, applied: 9, contradicted: 3 } },
    { id: 'l-8', kind: 'pitfall', text: '周末不要跑夜间构建（旧 CI 配额限制）。', scope: 'project', status: 'active', until: ago(2 * DAY), createdAt: ago(12 * DAY), source: { kind: 'conversation' }, uses: { recalled: 2, applied: 2, contradicted: 0 } },
  ],
  agenda: [
    { id: 'a-1', kind: 'awaiting_user', text: '低端机上是否默认关闭芦苇动态阴影（可换约 8fps）', status: 'open', threadId: 'th-perf', blocking: true, interaction: { sessionId: 's-ui', interactionId: 'q-a1', itemId: 'q-a1' }, question: { status: 'pending', canRespond: true, questions: [{ id: 'answer', question: '低端机上是否默认关闭芦苇动态阴影（可换约 8fps）', allowCustom: true, options: [{ id: 'o1', label: '默认关闭', description: '低端机多约 8fps' }, { id: 'o2', label: '保留阴影' }, { id: 'o3', label: '按机型自动判断' }] }] }, createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY) },
    { id: 'a-6', kind: 'awaiting_user', text: '是否需要接入成绩排行榜？', status: 'open', blocking: false, source: { kind: 'migration' }, createdAt: ago(5 * DAY), updatedAt: ago(5 * DAY) },
    { id: 'a-2', kind: 'todo', text: 'Redmi 9 关闭穗头透明排序后复测帧率', status: 'open', until: ahead(20 * HOUR), threadId: 'th-perf', createdAt: ago(40 * MIN) },
    { id: 'a-3', kind: 'open_loop', text: '音效资源里两个未引用的 ogg 文件待清理', status: 'open', threadId: 'th-assets', createdAt: ago(8 * MIN) },
    { id: 'a-4', kind: 'intention', text: '把「HUD 层级检查」写成交付前的固定检查项', status: 'open', createdAt: ago(26 * HOUR) },
    { id: 'a-5', kind: 'idea', text: '用墨迹扩散做关卡过渡，替代现在的淡入淡出', status: 'open', createdAt: ago(2 * DAY) },
    { id: 'a-6', kind: 'todo', text: '补齐工具行规范文档', status: 'done', createdAt: ago(2 * DAY), updatedAt: ago(20 * HOUR) },
  ],
  commitments: [
    { id: 'c-1', request: '把 HUD 分数移到芦苇之上，并补一张 390px 截图', trigger: 'user_request', status: 'pending', overdueAt: ago(3 * HOUR), createdAt: ago(7 * HOUR), source: { kind: 'jev', sessionId: 's-ui', itemId: 'pro-2' } },
    { id: 'c-2', request: '给出 Redmi 9 关闭透明排序后的复测帧率', trigger: 'agent_promise', status: 'pending', overdueAt: ahead(3 * HOUR), createdAt: ago(40 * MIN), source: { kind: 'jev' } },
    { id: 'c-3', request: '重跑失败的夜间构建并确认产物体积', trigger: 'failed_turn', status: 'resolved', resolvedBy: { kind: 'share', itemId: 'pro-1' }, overdueAt: ago(20 * HOUR), createdAt: ago(26 * HOUR), updatedAt: ago(22 * HOUR) },
    { id: 'c-4', request: '调研水墨笔触 shader 的开源实现', trigger: 'user_request', status: 'dismissed', reason: '你改为使用贴图方案', createdAt: ago(4 * DAY), updatedAt: ago(3 * DAY) },
  ],
  findings: [
    { id: 'f-1', topicKey: 'hud-occlusion', summary: 'HUD 分数在 390px 下被芦苇遮挡', firstSharedAt: ago(26 * HOUR), lastSharedAt: ago(6 * MIN), threadId: 'th-hud', shareCount: 2, createdAt: ago(26 * HOUR) },
    { id: 'f-2', topicKey: 'perf-redmi9', summary: 'Redmi 9 在芦苇密集区降到 41fps，关闭穗头透明排序后回到 52fps', firstSharedAt: ago(14 * HOUR), lastSharedAt: ago(2 * MIN), threadId: 'th-perf', shareCount: 2, createdAt: ago(14 * HOUR) },
    { id: 'f-3', topicKey: 'unused-ogg', summary: '音效资源里有两个未被引用的 ogg 文件', firstSharedAt: ago(8 * MIN), lastSharedAt: ago(2 * MIN), threadId: 'th-assets', shareCount: 1, createdAt: ago(8 * MIN) },
    { id: 'f-4', topicKey: 'tool-row-spec', summary: '工具行合并规则与 docs/tool-row-spec.md 一致', firstSharedAt: ago(11 * HOUR), lastSharedAt: ago(11 * HOUR), threadId: 'th-docs', shareCount: 1, createdAt: ago(11 * HOUR) },
  ],
  threads: [
    { id: 'th-hud', title: 'HUD 被芦苇遮挡', status: 'open', messageItemIds: ['pro-0', 'pro-2', 'wb-1'], lastSummary: 'HUD 分数只在 390px 下被芦苇遮挡', lastMessageAt: ago(6 * MIN), createdAt: ago(26 * HOUR), reactions: { replied: 1, up: 1 } },
    { id: 'th-daily', title: '每日检查点', status: 'open', messageItemIds: ['pro-1'], lastMessageAt: ago(18 * MIN), createdAt: ago(5 * DAY), reactions: { acted: 1 } },
    { id: 'th-perf', title: '低端机帧率', status: 'open', messageItemIds: ['wb-1'], lastSummary: 'Redmi 9 关闭穗头透明排序后回到 52fps', lastMessageAt: ago(40 * MIN), createdAt: ago(3 * DAY), reactions: { replied: 1, dismissed: 1 } },
    { id: 'th-assets', title: '资源体积与清理', status: 'muted', messageItemIds: ['wb-1'], lastMessageAt: ago(8 * MIN), createdAt: ago(2 * DAY), reactions: { ignored: 1 } },
    { id: 'th-docs', title: '工具行规范', status: 'resolved', messageItemIds: ['tc-1'], lastMessageAt: ago(11 * HOUR), createdAt: ago(11 * HOUR), reactions: {} },
    { id: 'th-shadow', title: '动态阴影默认值', status: 'resolved', messageItemIds: ['tc-2'], lastMessageAt: ago(3 * MIN), createdAt: ago(2 * DAY), reactions: {} },
  ],
  notes: {
    facts: [
      { id: 'n-f1', text: '主要测试设备：iPhone 12 与 Redmi 9', createdAt: ago(6 * DAY), source: { kind: 'conversation' } },
      { id: 'n-f2', text: '通常在 10:00–23:00（北京时间）处理这个项目', createdAt: ago(4 * DAY), source: { kind: 'conversation' } },
    ],
    preferences: [
      { id: 'n-p1', text: '消息用简短中文，先说结论', createdAt: ago(5 * DAY), source: { kind: 'correction', sessionId: 's-ui', itemId: 'u-ui-1' } },
      { id: 'n-p2', text: '视觉问题附前后截图对比', createdAt: ago(2 * DAY), source: { kind: 'explicit_preference' } },
    ],
    updatedAt: ago(2 * DAY),
  },
  pacing: { threshold: 0.42, unrepliedChain: 1, engagement: 0.68, lastPresenceAt: ago(6 * MIN), activeHours: [10, 11, 14, 15, 16, 20, 21, 22], updatedAt: ago(6 * MIN) },
  health: { learning: 'running' },
})

export const agentMind = (): ProjectMind => ({
  projectId: 'p-agent', revision: 1, updatedAt: ago(26 * HOUR),
  lessons: [
    { id: 'la-1', kind: 'constraint', text: '联调只用临时 daemon（4399），不要改动 4317 上的生产实例。', scope: 'project', status: 'active', createdAt: ago(3 * DAY), source: { kind: 'correction' }, uses: { recalled: 5, applied: 5, contradicted: 0 } },
  ],
  agenda: [
    { id: 'aa-1', kind: 'awaiting_user', text: '确认 resync 事件里 `fields` 的命名是否沿用 v1', status: 'open', createdAt: ago(26 * HOUR) },
  ],
  commitments: [],
  threads: [],
  notes: { facts: [], preferences: [] },
  health: { learning: 'paused', reason: 'privacy_revoked' },
})

/** The earlier message of the “HUD 被芦苇遮挡” thread (inserted into s-ui). */
export const threadOpener = {
  id: 'pro-0', turnId: null, kind: 'assistant', source: 'initiative', initiative: { kind: 'share', reach: 'inline', threadId: 'th-hud' },
  text: '**HUD 分数在低端机上偶尔被遮挡**：Redmi 9 截图里芦苇穗头盖住了分数印章的右上角。先记下，等有 390px 的截图再确认范围。',
  createdAt: ago(26 * HOUR),
} as const

/** K2 v2: files the agent declared with `project_present` for the HUD share. */
export const pro2Deliverables = [
  { path: 'docs/hud-layering-report.md', name: 'hud-layering-report.md', description: '390px 截图复核：分数印章与前景芦苇的层级冲突与修复建议' },
  { path: 'src/styles/app.css', name: 'app.css', description: 'HUD 层级提到 30 的改动位置' },
]

export const narratorItems = () => [
  {
    id: 'tc-1', turnId: null, kind: 'assistant', source: 'initiative', initiative: { kind: 'thread_close', reach: 'inline', threadId: 'th-docs' },
    text: '「工具行规范」已完成：规范文档与实现一致。', createdAt: ago(4 * MIN),
  },
  {
    // Structured thread close (F10): the row is written from `title` and `resolution`, in the interface language.
    id: 'tc-2', turnId: null, kind: 'assistant', source: 'initiative',
    initiative: { kind: 'thread_close', reach: 'inline', threadId: 'th-shadow', title: '动态阴影默认值', resolution: '低端机默认关闭，其他设备保持开启。', status: 'done' },
    text: '「动态阴影默认值」已完成：低端机默认关闭，其他设备保持开启。', createdAt: ago(3 * MIN),
  },
  {
    id: 'wb-1', turnId: null, kind: 'assistant', source: 'initiative',
    initiative: {
      kind: 'welcome_back', reach: 'inline', threadIds: ['th-perf', 'th-hud', 'th-assets'], overflowCount: 2, narrated: { version: 2, count: 5 },
      topics: [
        { threadId: 'th-perf', title: '低端机帧率', text: 'Redmi 9 关闭穗头透明排序后回到 52fps，iPhone 12 仍稳定 60fps。' },
        { threadId: 'th-hud', title: 'HUD 被芦苇遮挡', text: '确认只在 390px 宽度出现，430px 以上正常；复核报告已整理好。', deliverables: [pro2Deliverables[0]] },
        { threadId: 'th-assets', title: '资源体积与清理', text: '两个未引用的 ogg 文件可以在下次清理时删除。' },
      ],
    },
    text: '你不在时的进展（3 个话题）：\n\n1. 「低端机帧率」\nRedmi 9 关闭穗头透明排序后回到 52fps，iPhone 12 仍稳定 60fps。\n\n2. 「HUD 被芦苇遮挡」\n确认只在 390px 宽度出现，430px 以上正常；复核报告已整理好。\n\n3. 「资源体积与清理」\n两个未引用的 ogg 文件可以在下次清理时删除。\n\n另有 2 条放进了收件箱。',
    createdAt: ago(2 * MIN),
  },
]

/** Inbox pacing records and welcome-back overflow receipts. */
export const inboxPacing: Record<string, Record<string, unknown>> = {
  'ibx-3': { outcome: 'inbox', reasons: ['below_threshold_band'], value: 0.38, threshold: 0.42, kind: 'share', threadId: 'th-perf' },
  'ibx-6': { outcome: 'inbox', reasons: ['night', 'below_threshold'], value: 0.31, threshold: 0.42, kind: 'share', threadId: 'th-assets' },
  'ibx-2': { outcome: 'send', reasons: ['above_threshold', 'time_sensitive'], value: 0.71, threshold: 0.45, kind: 'share', threadId: 'th-hud' },
}
export const overflowEntries = () => [
  { id: 'ibx-wb1', actionId: 'held:h1', kind: 'share', tier: 'inbox', requestedTier: 'inbox', reachReasons: ['welcome_back_overflow'], pacing: { outcome: 'inbox', reasons: ['welcome_back_overflow'], value: 0.33, kind: 'share', threadId: 'th-deps' }, text: '依赖更新后 `three` 升到 0.172，构建无新警告。', sessionId: 's-ui', createdAt: ago(2 * MIN), status: 'read', readAt: ago(MIN), threadId: 'th-deps', feedback: null },
  { id: 'ibx-wb2', actionId: 'held:h2', kind: 'share', tier: 'inbox', requestedTier: 'inbox', reachReasons: ['welcome_back_overflow'], pacing: { outcome: 'inbox', reasons: ['welcome_back_overflow'], value: 0.29, kind: 'share', threadId: 'th-assets' }, text: '关卡 3 的远山贴图已压缩到 512KB。', sessionId: 's-ui', createdAt: ago(2 * MIN), status: 'read', readAt: ago(MIN), threadId: 'th-assets', feedback: null },
]

/** Inbox entry → thread (entries without an item id are grouped by the host's `threadId`). */
export const inboxThreads: Record<string, string> = { 'ibx-5': 'th-perf', 'ibx-d1': 'th-perf', 'ibx-3': 'th-perf', 'ibx-4': 'th-assets', 'ibx-6': 'th-assets', 'ibx-d2': 'th-docs', 'ibx-2': 'th-hud', 'ibx-1': 'th-daily' }

/* ---------------------------------------------------------------- metrics */

/** Deterministic wiggle so screenshots are stable. */
const wave = (i: number, seed: number) => Math.sin(i * 1.7 + seed) * 0.5 + Math.sin(i * 0.6 + seed * 2) * 0.5

function series(n: number, start: number, end: number, spread: number, seed: number, { min = 0, max = Infinity, gaps = [] as number[] } = {}) {
  return Array.from({ length: n }, (_, i) => {
    if (gaps.includes(i)) return null
    const base = start + (end - start) * (n === 1 ? 1 : i / (n - 1))
    return Math.min(max, Math.max(min, Math.round((base + wave(i, seed) * spread) * 1000) / 1000))
  })
}
const mean = (values: (number | null)[]) => { const known = values.filter((v): v is number => v !== null); return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length * 1000) / 1000 : null }

export function metrics(projectId: string, window: string) {
  const n = window === '30d' ? 30 : 7
  const rich = projectId === 'p-ink'
  const m = (s: (number | null)[], previous: number | null, sample: number, value = mean(s)): MetricValue => ({ value, previous, series: s, sample })
  const empty: MetricValue = { value: null, previous: null, series: [], sample: 0 }
  const long = n === 30
  const out: Partial<Record<MetricKey, MetricValue>> = rich ? {
    usefulShareRate: m(series(n, 0.28, 0.46, 0.08, 1, { max: 1 }), long ? 0.22 : 0.31, long ? 64 : 17),
    ignoreRate: m(series(n, 0.46, 0.3, 0.07, 2, { max: 1 }), long ? 0.52 : 0.41, long ? 64 : 17),
    dismissRate: m(series(n, 0.12, 0.09, 0.04, 3, { max: 1 }), long ? 0.1 : 0.08, long ? 64 : 17),
    longestUnrepliedChain: { value: long ? 7 : 3, previous: long ? 12 : 4, series: series(n, long ? 6 : 4, 2, 1.2, 4).map(v => (v === null ? null : Math.round(v))), sample: long ? 64 : 17 },
    commitmentResolutionP50Ms: m(series(n, 5.5 * HOUR, 1.6 * HOUR, 0.6 * HOUR, 5, { gaps: long ? [3, 9] : [2] }), long ? 7.1 * HOUR : 2.4 * HOUR, long ? 21 : 6, 1.9 * HOUR),
    commitmentResolutionP90Ms: m(series(n, 14 * HOUR, 6 * HOUR, 2 * HOUR, 6, { gaps: long ? [3, 9] : [2] }), long ? 26 * HOUR : 9 * HOUR, long ? 21 : 6, 7.5 * HOUR),
    overdueCommitments: { value: 1, previous: long ? 4 : 2, series: [], sample: null },
    correctionsPerTurn: m(series(n, 0.62, 0.34, 0.08, 7), long ? 0.71 : 0.44, long ? 212 : 48),
    repeatCorrectionRate: m(series(n, 0.31, 0.14, 0.05, 8, { max: 1 }), long ? 0.36 : 0.19, long ? 58 : 14),
    firstAttemptAcceptance: m(series(n, 0.48, 0.66, 0.07, 9, { max: 1 }), long ? 0.44 : 0.58, long ? 97 : 23),
    lessonHitRate: m(series(n, 0.7, 0.82, 0.05, 10, { max: 1 }), long ? 0.63 : 0.77, long ? 140 : 36),
  } : {
    usefulShareRate: empty, ignoreRate: empty, correctionsPerTurn: m(series(n, 0.2, 0.18, 0.05, 11), null, 6),
  }
  // K4 shape: each series point is `{ date, value, sample }` (UTC day ending the bucket).
  const now = Date.now()
  const keyed = Object.fromEntries(Object.entries(out).map(([key, entry]) => {
    const series = (entry.series ?? []) as (number | null)[]
    const perDay = entry.sample ? Math.max(1, Math.round(entry.sample / Math.max(1, series.length))) : 0
    return [key, { ...entry, series: series.map((value, i) => ({ date: new Date(now - (series.length - 1 - i) * DAY - 1).toISOString().slice(0, 10), value, sample: value === null ? 0 : perDay })) }]
  }))
  return {
    schema: 'rna-bench-metrics/1', projectId, window, generatedAt: new Date(now).toISOString(), metrics: keyed,
    proactive: {}, learning: {}, harness: {}, owners: { proactive: 'k4-baseline', learning: 'k4', harness: 'k4' }, providers: { proactive: 'k4-baseline' },
  }
}
