import { describe, expect, it } from 'vitest'
import { isUnseen, markSeen, useSeen } from './seen-store'

describe('sidebar new-message dot', () => {
  it('lights only for a proactive message newer than the last look', () => {
    const at = Date.parse('2026-09-30T08:00:00Z')
    expect(isUnseen('2026-09-30T08:05:00Z', at)).toBe(true)
    expect(isUnseen('2026-09-30T07:55:00Z', at)).toBe(false)
    expect(isUnseen(null, at)).toBe(false)
    expect(isUnseen(undefined, at)).toBe(false)
  })
  it('opening a conversation marks it seen; others keep the first-run baseline', () => {
    const { baseline } = useSeen.getState()
    markSeen('s1')
    expect(useSeen.getState().at.s1).toBeGreaterThanOrEqual(baseline)
    expect(useSeen.getState().at.s2).toBeUndefined()
  })
})
