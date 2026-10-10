import { describe, expect, it } from 'vitest'
import type { AgendaItem, Commitment, Lesson, MindThread, ProjectMind } from '@/api/mind-api'
import { pacingDisplay, welcomeBackDisplay, agendaGroups, commitmentState, dueLabel, groupByThread, healthLine, lessonGroups, lessonState, mindCounts, mindHints, owedSummary, sortCommitments, threadForItem, threadPosition } from './mind'

const now = Date.parse('2026-09-28T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const H = 3_600_000
const lesson = (id: string, patch: Partial<Lesson> = {}): Lesson => ({ id, kind: 'preference', text: id, status: 'active', createdAt: iso(-H), ...patch })
const commitment = (id: string, patch: Partial<Commitment> = {}): Commitment => ({ id, request: id, trigger: 'user_request', status: 'pending', createdAt: iso(-5 * H), ...patch })
const agenda = (id: string, patch: Partial<AgendaItem> = {}): AgendaItem => ({ id, kind: 'todo', text: id, status: 'open', createdAt: iso(-H), ...patch })
const thread = (id: string, messageItemIds: string[], status = 'open'): MindThread => ({ id, title: id, status, messageItemIds, createdAt: iso(-H) })

describe('lessons', () => {
  it('derives state from status and expiry', () => {
    expect(lessonState(lesson('a'), now)).toBe('active')
    expect(lessonState(lesson('a', { until: iso(-1) }), now)).toBe('expired')
    expect(lessonState(lesson('a', { until: iso(H) }), now)).toBe('active')
    expect(lessonState(lesson('a', { status: 'superseded' }), now)).toBe('superseded')
    expect(lessonState(lesson('a', { status: 'retired', until: iso(-1) }), now)).toBe('retired')
  })
  it('groups by kind in a fixed order, hides inactive unless asked, most-applied first', () => {
    const list = [
      lesson('p1', { uses: { applied: 1 } }), lesson('p2', { uses: { applied: 9 } }),
      lesson('c1', { kind: 'constraint' }), lesson('x', { kind: 'pitfall', status: 'retired' }), lesson('w', { kind: 'weird' }),
    ]
    const groups = lessonGroups(list, { now })
    expect(groups.map(g => g.kind)).toEqual(['preference', 'constraint', 'weird'])
    expect(groups[0].lessons.map(l => l.id)).toEqual(['p2', 'p1'])
    expect(lessonGroups(list, { now, inactive: true }).map(g => g.kind)).toEqual(['preference', 'constraint', 'pitfall', 'weird'])
  })
})

describe('commitments', () => {
  it('marks pending past overdueAt as overdue and sorts overdue first', () => {
    const list = [commitment('later', { overdueAt: iso(2 * H) }), commitment('done', { status: 'resolved' }), commitment('late', { overdueAt: iso(-3 * H) }), commitment('later2', { overdueAt: iso(-1 * H) })]
    expect(commitmentState(list[2], now)).toBe('overdue')
    expect(commitmentState(list[0], now)).toBe('pending')
    expect(sortCommitments(list, now).map(c => c.id)).toEqual(['late', 'later2', 'later', 'done'])
  })
  it('labels due times in both directions', () => {
    expect(dueLabel(iso(-3 * H), now)).toEqual({ text: '已逾期 3 小时', overdue: true })
    expect(dueLabel(iso(20 * 60_000), now)).toEqual({ text: '20 分钟后到期', overdue: false })
    expect(dueLabel(null, now)).toBeNull()
  })
})

describe('agenda, counts and health', () => {
  it('groups open agenda items with awaiting_user first', () => {
    const groups = agendaGroups([agenda('t'), agenda('w', { kind: 'awaiting_user' }), agenda('d', { status: 'done' })])
    expect(groups.map(g => [g.kind, g.items.map(i => i.id)])).toEqual([['awaiting_user', ['w']], ['todo', ['t']]])
  })
  it('counts active lessons, open agenda and pending/overdue commitments', () => {
    const mind = { lessons: [lesson('a'), lesson('b', { status: 'retired' })], agenda: [agenda('x'), agenda('y', { status: 'dropped' })], commitments: [commitment('c', { overdueAt: iso(-1) }), commitment('d', { overdueAt: iso(H) }), commitment('e', { status: 'dismissed' })] }
    expect(mindCounts(mind, now)).toEqual({ lessons: 1, openAgenda: 1, pendingCommitments: 2, overdueCommitments: 1 })
  })
  it('reads the learning health line', () => {
    expect(healthLine({ learning: 'running' })).toEqual({ paused: false, reason: null })
    expect(healthLine({ learning: 'paused', reason: 'privacy_revoked' }).reason).toBe('有会话被删除，相关证据已撤回')
    expect(healthLine({ learning: 'paused', reason: 'something_new' })).toEqual({ paused: true, reason: 'something_new' })
  })
})

describe('threads', () => {
  const threads = [thread('t1', ['m1', 'm2', 'm3']), thread('t2', ['z'])]
  it('finds the thread by host hint, then by membership', () => {
    expect(threadForItem(threads, 'm2')?.id).toBe('t1')
    expect(threadForItem(threads, 'unknown', 't2')?.id).toBe('t2')
    expect(threadForItem(threads, 'unknown', 'missing')).toBeNull()
    expect(threadForItem(undefined, 'm1')).toBeNull()
  })
  it('knows whether a message continues its thread', () => {
    expect(threadPosition(threads[0], 'm1')).toMatchObject({ continues: false, earlier: [], latest: false })
    expect(threadPosition(threads[0], 'm3')).toMatchObject({ index: 2, continues: true, earlier: ['m1', 'm2'], latest: true })
    expect(threadPosition(threads[0], 'new')).toMatchObject({ index: 3, total: 4, continues: true, latest: true })
  })
  it('groups newest-first inbox entries by thread, keeping unthreaded entries single', () => {
    const entries = [
      { id: 'e1', itemId: 'm3' }, { id: 'e2', threadId: null }, { id: 'e3', threadId: 't2' }, { id: 'e4', itemId: 'm1' }, { id: 'e5', threadId: 'orphan' }, { id: 'e6', threadId: 'orphan' },
    ]
    const groups = groupByThread(entries, threads)
    expect(groups.map(g => [g.key, g.entries.map(e => e.id)])).toEqual([
      ['thread:t1', ['e1', 'e4']], ['entry:e2', ['e2']], ['thread:t2', ['e3']], ['thread:orphan', ['e5', 'e6']],
    ])
    expect(groups[3].thread).toBeNull()
  })
})

describe('sidebar hints', () => {
  it('lists only overdue commitments (longest first); agenda items never become task hints', () => {
    const mind = (patch: Partial<ProjectMind>): ProjectMind => ({ projectId: 'p', lessons: [], agenda: [], commitments: [], threads: [], notes: { facts: [], preferences: [] }, ...patch })
    const hints = mindHints({
      a: mind({ commitments: [commitment('c1', { overdueAt: iso(-H) }), commitment('c2', { overdueAt: iso(H) })], agenda: [agenda('w1', { kind: 'awaiting_user', blocking: true }), agenda('w2', { kind: 'awaiting_user', blocking: false }), agenda('w3', { kind: 'awaiting_user' }), agenda('t1')] }),
      b: mind({ commitments: [commitment('c3', { overdueAt: iso(-5 * H) })] }),
      gone: mind({ commitments: [commitment('c4', { overdueAt: iso(-H) })] }),
      c: null,
    }, { a: 'A', b: 'B', c: 'C' }, now)
    expect(hints.map(h => [h.kind, h.id, h.projectName])).toEqual([['overdue', 'c3', 'B'], ['overdue', 'c1', 'A']])
    expect(owedSummary(hints)).toEqual({ count: 2, projectId: 'b' })
  })
})

describe('K2 narrator outputs', () => {
  const threads: MindThread[] = [
    { ...thread('th-perf', []), title: '低端机帧率' },
    { ...thread('th-hud', []), title: 'HUD 被芦苇遮挡' },
    { ...thread('th-long', []), title: '一个标题很长很长的话题会被截断到二十四个字符以内的样子' },
    { ...thread('th-sum', []), title: '别的', lastSummary: '音效资源里两个未引用的 ogg 文件' },
  ]
  it('renders welcome-back topics from the structured list, in host order, tied by thread id', () => {
    const file = { path: 'docs/r.md', name: 'r.md', description: '复核报告' }
    const view = welcomeBackDisplay({ kind: 'welcome_back', threadIds: ['th-hud', 'th-perf', 'gone'], overflowCount: 2, topics: [
      { threadId: 'th-hud', title: 'HUD 被芦苇遮挡', text: '只在 390px', deliverables: [file] },
      { threadId: 'th-perf', title: '低端机帧率', text: '回到 52fps' },
      { threadId: 'gone', title: '已删除的话题', text: '仍然显示标题' },
    ] }, 'ignored text 「低端机帧率」', threads)
    expect(view.filed).toBe(2)
    expect(view.fallback).toBeNull()
    expect(view.topics.map(t => [t.threadId, t.thread?.id ?? null, t.title, t.text, t.deliverables.length])).toEqual([
      ['th-hud', 'th-hud', 'HUD 被芦苇遮挡', '只在 390px', 1], ['th-perf', 'th-perf', '低端机帧率', '回到 52fps', 0], ['gone', null, '已删除的话题', '仍然显示标题', 0],
    ])
  })
  it('falls back to plain text for older welcome-back items without topics (no matching)', () => {
    const text = '你不在时的进展：\n1. 「低端机帧率」回到 52fps\n另有 2 条较次要的进展已放进收件箱。'
    expect(welcomeBackDisplay({ kind: 'welcome_back', threadIds: ['th-perf'] }, text, threads)).toEqual({ topics: [], filed: 0, fallback: text })
    expect(welcomeBackDisplay(undefined, 'x', threads).fallback).toBe('x')
  })
  it('explains a pacing decision from outcome + documented reason codes only', () => {
    expect(pacingDisplay({ outcome: 'inbox', reasons: ['below_threshold_band'], value: 0.381, threshold: 0.42 })).toEqual({
      outcome: '放进收件箱', reasons: ['价值略低于当前门槛，不值得打断你'], score: '价值 0.38 · 门槛 0.42',
    })
    expect(pacingDisplay({ outcome: 'drop', reasons: ['exact_duplicate', 'unknown_code', 'exact_duplicate'] })).toEqual({ outcome: '不发送', reasons: ['与已发出的消息完全相同'], score: null })
    expect(pacingDisplay({ outcome: 'inbox', reasons: ['welcome_back_overflow'] })?.reasons).toEqual(['回来后的汇总只列最重要的话题，其余放进收件箱'])
    // B3 F4: a question held while the user was away goes out from its record when they are back.
    expect(pacingDisplay({ outcome: 'send', reasons: ['held_released'] })?.reasons).toEqual(['你不在时暂存的问题，在你回来后发出'])
    // Legacy `decision` alias and reach-reason fallbacks are gone.
    expect(pacingDisplay({ decision: 'hold', reasons: ['status_ping'] } as never)).toBeNull()
    expect(pacingDisplay(undefined)).toBeNull()
  })
})
