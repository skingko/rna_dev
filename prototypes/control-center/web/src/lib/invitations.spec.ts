import { describe, expect, it } from 'vitest'
import type { Invitation } from '@/api/types'
import { ACTIVE_WINDOW_MS, isEngaged, pickInvitation } from './invitations'

const row = (id: string, kind: string, createdAt: string): Invitation => ({ id, kind, subject: `${kind}:${id}`, createdAt })
const open = { idle: true, blocked: false, typing: false, engaged: true }

describe('composer invitations', () => {
  const list = [row('l1', 'lesson', '2026-09-30T10:00:00Z'), row('f1', 'feedback', '2026-09-30T10:05:00Z'), row('x', 'unknown', '2026-09-30T09:00:00Z')]
  it('shows feedback on the latest reply first, then lessons, and ignores unknown kinds', () => {
    expect(pickInvitation(list, open)?.id).toBe('f1')
    expect(pickInvitation(list.filter(r => r.kind !== 'feedback'), open)?.id).toBe('l1')
    expect(pickInvitation([row('x', 'unknown', '2026-09-30T09:00:00Z')], open)).toBeNull()
  })
  it('never interrupts: not while running, typing, away, or when something more important is shown', () => {
    for (const gate of [{ idle: false }, { typing: true }, { engaged: false }, { blocked: true }]) expect(pickInvitation(list, { ...open, ...gate })).toBeNull()
    expect(pickInvitation([], open)).toBeNull(); expect(pickInvitation(undefined, open)).toBeNull()
  })
  it('the user is there only while the window is visible and they were active recently', () => {
    const now = Date.parse('2026-09-30T10:00:00Z')
    expect(isEngaged({ visible: true, lastActivityAt: now - 60_000, now })).toBe(true)
    expect(isEngaged({ visible: true, lastActivityAt: now - ACTIVE_WINDOW_MS - 1, now })).toBe(false)
    expect(isEngaged({ visible: false, lastActivityAt: now, now })).toBe(false)
  })
})

import { plainLine } from '@/lib/plain'
describe('status page lines', () => {
  it('turns model prose into one plain sentence', () => {
    expect(plainLine('准备问题：「守夜」扩展红线的冲击面盘完了，只读核查。**先说结论**：正文前 10 章零命中')).toBe('准备问题：「守夜」扩展红线的冲击面盘完了，只读核查。')
    expect(plainLine('# Title\n\n`code` and **bold** text without an end')).toBe('Title code and bold text without an end')
    expect(plainLine('长'.repeat(120)).length).toBe(90)
  })
})

describe('composer invitations: pausing a schedule nobody reads', () => {
  it('is a decision the strip shows like the other asks: after feedback, task and lesson, with the schedule suggestion', () => {
    const list = [row('p', 'schedule_pause', '2026-10-22T10:00:00Z'), row('l', 'lesson', '2026-10-22T10:00:05Z')]
    expect(pickInvitation(list, open)?.id).toBe('l')
    expect(pickInvitation(list.slice(0, 1), open)?.id).toBe('p')
    expect(pickInvitation(list.slice(0, 1), { ...open, engaged: false })).toBeNull()
  })
})

describe('composer invitations: a requested kind', () => {
  it('goes before the usual order when the user just asked to settle it', () => {
    const list = [row('f', 'feedback', '2026-10-01T10:00:05Z'), row('c', 'commitment', '2026-10-01T10:00:00Z')]
    expect(pickInvitation(list, open)?.id).toBe('f')
    expect(pickInvitation(list, open, 'commitment')?.id).toBe('c')
  })
})
