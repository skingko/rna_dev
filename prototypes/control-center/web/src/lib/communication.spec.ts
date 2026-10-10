import { describe, expect, it } from 'vitest'
import type { InboxEntry } from '@/api/communication-api'
import { digestDisplay, entryDisplay, feedbackSummary, formatRate, notificationRoute } from './communication'

const entry = (patch: Partial<InboxEntry> = {}): InboxEntry => ({ id: 'e', kind: 'share', tier: 'inline', text: 't', createdAt: '2026-09-28T09:00:00.000Z', status: 'unread', feedback: null, ...patch })

describe('inbox entry display', () => {
  it('labels tier, status and pending reaction', () => {
    expect(entryDisplay(entry())).toMatchObject({ kindLabel: '主动分享', tierLabel: '对话内', status: 'unread', statusLabel: '未读', outcomeLabel: '等待反应', lowered: null, canAct: true })
    expect(entryDisplay(entry({ kind: 'ask', status: 'dismissed', feedback: { outcome: 'dismissed', at: 'x' } }))).toMatchObject({ kindLabel: '主动提问', outcomeLabel: '已忽略', canAct: false })
  })
  it('explains a lowered reach and never reports raising', () => {
    expect(entryDisplay(entry({ requestedTier: 'notify', reachReasons: ['desktop_notifications_off'] })).lowered).toBe('请求桌面通知 · 实际对话内 · 项目未开启桌面通知')
    expect(entryDisplay(entry({ tier: 'inline', requestedTier: 'digest' })).lowered).toBeNull()
  })
  it('tracks digest holding and merging', () => {
    expect(entryDisplay(entry({ tier: 'digest', heldForDigest: true })).digest).toBe('等待并入下一次每日摘要')
    expect(entryDisplay(entry({ tier: 'digest', digestedAt: '2026-09-28T09:00:00.000Z' })).digest).toMatch(/^已并入 .* 的每日摘要$/)
    expect(entryDisplay(entry({ contextRevoked: true })).withdrawn).toBe(true)
  })
})

describe('digest display', () => {
  it('parses the host digest text', () => {
    expect(digestDisplay('今日摘要（2 条）：\n1. 甲。\n2. 乙。', ['a', 'b'])).toEqual({ count: 2, lines: ['甲。', '乙。'] })
    expect(digestDisplay('今日摘要：只有一条。', ['a'])).toEqual({ count: 1, lines: ['只有一条。'] })
  })
  it('parses the English host digest text', () => {
    expect(digestDisplay("Today's digest (2 items):\n1. First.\n2. Second.", ['a', 'b'])).toEqual({ count: 2, lines: ['First.', 'Second.'] })
    expect(digestDisplay("Today's digest: Only one.", ['a'])).toEqual({ count: 1, lines: ['Only one.'] })
    expect(digestDisplay("Today's digest (1 item):\n1. Only one.", ['a'])).toEqual({ count: 1, lines: ['Only one.'] })
    expect(digestDisplay('Today’s digest: Curly quote.', [])).toEqual({ count: 1, lines: ['Curly quote.'] })
  })
  it('prefers the structured lines over the stored text', () => {
    expect(digestDisplay('今日摘要（2 条）：\n1. 旧一。\n2. 旧二。', ['a', 'b'], ['甲。', '乙。'])).toEqual({ count: 2, lines: ['甲。', '乙。'] })
    expect(digestDisplay("Today's digest: stale", ['a'], ['One.'])).toEqual({ count: 1, lines: ['One.'] })
    // A line that itself starts like a header or a number is not parsed again.
    expect(digestDisplay('x', [], ['1. 保留编号', '今日摘要：保留'])).toEqual({ count: 2, lines: ['1. 保留编号', '今日摘要：保留'] })
  })
  it('counts the larger of the entries and the lines', () => {
    expect(digestDisplay('', ['a', 'b', 'c'], ['甲。'])).toEqual({ count: 3, lines: ['甲。'] })
    expect(digestDisplay('', ['a'], ['甲。', '乙。'])).toEqual({ count: 2, lines: ['甲。', '乙。'] })
    expect(digestDisplay('今日摘要：甲。', [])).toEqual({ count: 1, lines: ['甲。'] })
  })
  it('falls back to the stored text when the structured lines are unusable', () => {
    const text = '今日摘要（2 条）：\n1. 甲。\n2. 乙。'
    const legacy = { count: 2, lines: ['甲。', '乙。'] }
    expect(digestDisplay(text, ['a', 'b'], [])).toEqual(legacy)
    expect(digestDisplay(text, ['a', 'b'], ['', '  '])).toEqual(legacy)
    expect(digestDisplay(text, ['a', 'b'], [1, 'x'])).toEqual(legacy)
    expect(digestDisplay(text, ['a', 'b'], 'x' as unknown as string[])).toEqual(legacy)
    expect(digestDisplay(text, ['a', 'b'], null)).toEqual(legacy)
    expect(digestDisplay(text, ['a', 'b'], undefined)).toEqual(legacy)
  })
})

describe('feedback + routing', () => {
  it('formats rates and tier counts', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0.667)).toBe('67%')
    const s = feedbackSummary({ window: '7d', counts: { delivered: 4, pending: 1, replied: 1, acted: 1, dismissed: 1, ignored: 0 }, byTier: { inline: 3, notify: 1 }, settled: 3, usefulShareRate: 0.667, replyRate: 0.333, actRate: 0.333, dismissRate: 0.333, ignoreRate: 0 })
    expect(s).toMatchObject({ useful: '67%', dismiss: '33%', ignore: '0%', sample: '3 条已判定' })
    expect(s.tiers.map(t => t.count)).toEqual([3, 0, 1, 0])
  })
  it('routes a notification click to the session, else the project inbox', () => {
    const known = { projects: { p: {} }, sessions: { s: { projectId: 'p' }, old: { projectId: 'p', archivedAt: 'x' } } }
    expect(notificationRoute({ projectId: 'p', sessionId: 's', entryId: 'e' }, known)).toEqual({ kind: 'session', sessionId: 's', projectId: 'p', entryId: 'e' })
    expect(notificationRoute({ projectId: 'p', sessionId: 'old', entryId: 'e' }, known)).toEqual({ kind: 'inbox', sessionId: null, projectId: 'p', entryId: 'e' })
    expect(notificationRoute({ sessionId: 's' }, known)?.projectId).toBe('p')
    expect(notificationRoute({ projectId: 'gone' }, known)).toBeNull()
  })
})
