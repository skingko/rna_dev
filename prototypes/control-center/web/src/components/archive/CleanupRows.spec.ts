import { describe, expect, it } from 'vitest'
import { translate, type MessageKey, type Vars } from '@/i18n'
import type { SessionDeletion } from '@/api/support-api'
import { cleanupChoiceLabel, cleanupDecision, cleanupDetail } from './CleanupRows'

// Review X-1: a blocked cleanup explains, in the interface language, what it waits for; D2-3: it names the decision
// the user can take there, and the button takes it.
const row = (decision: string | null, notice: string | null = null, choice: string | null = null): SessionDeletion => ({ sessionId: 's1', projectId: 'p1', status: 'blocked', localStatus: 'pending', remoteStatus: 'pending', createdAt: null, updatedAt: null, completedAt: null, code: 'X', retryAt: null, attempts: 3, decision, choice, notice })
const zh = (key: MessageKey, vars?: Vars) => translate('zh-CN', key, vars), en = (key: MessageKey, vars?: Vars) => translate('en', key, vars)

describe('cleanupDecision', () => {
  it('names each decision in both languages and falls back to the host notice', () => {
    expect(cleanupDecision(row('execution'), zh)).toMatch(/后台工作/)
    expect(cleanupDecision(row('execution'), en)).toMatch(/Confirm its result in the project’s background work/)
    for (const decision of ['too_large', 'unsafe', 'damaged', 'memory_changed', 'memory_mismatch', 'memory_differs']) {
      expect(cleanupDecision(row(decision), en)).not.toMatch(/[一-鿿]/)
      expect(cleanupDecision(row(decision), zh)).toMatch(/[一-鿿]/)
    }
    expect(cleanupDecision(row('something_new', 'Host says why.'), en)).toBe('Host says why.')
    expect(cleanupDecision(row(null), en)).toBe('This cleanup cannot finish on its own and needs your decision.')
  })

  it('names the button of the choice the host offers, in its text and on the button, in both languages', () => {
    const cases: [string, string, RegExp][] = [['execution', 'release_runs', /“Delete without checking”/], ['too_large', 'remove_entry', /“Delete this record”/], ['too_large', 'read_all', /“Read them all”/],
      ['unsafe', 'remove_entry', /removes only that one link/], ['damaged', 'remove_entry', /“Delete this record”/], ['damaged', 'rebuild', /“Rebuild the record”/],
      ['memory_changed', 'keep_remote', /“Keep the remote records”/], ['memory_mismatch', 'keep_remote', /“Keep the remote records”/], ['memory_differs', 'keep_remote', /“Keep the remote records”/]]
    for (const [decision, choice, text] of cases) {
      const blocked = row(decision, null, choice)
      expect(cleanupDecision(blocked, en)).toMatch(text)
      expect(cleanupDecision(blocked, zh)).toMatch(/[一-鿿]/)
      expect(cleanupDecision(blocked, en)).not.toMatch(/[一-鿿]/)
      const label = cleanupChoiceLabel(blocked, en)
      expect(label).toBeTruthy(); expect(label).not.toMatch(/[一-鿿]/); expect(cleanupChoiceLabel(blocked, zh)).toMatch(/[一-鿿]/)
      // The text quotes the button it names.
      expect(cleanupDecision(blocked, en).includes(`“${label}”`) || decision === 'unsafe').toBe(true)
    }
    expect(cleanupChoiceLabel(row('unsafe'), en)).toBeNull()
    expect(cleanupChoiceLabel({ ...row('damaged', null, 'remove_entry'), status: 'pending' }, en)).toBeNull()
    expect(cleanupChoiceLabel(row('damaged', null, 'something_new'), en)).toBeNull()
  })

  it('says remote records were kept when the user decided so', () => {
    expect(cleanupDetail({ ...row(null), status: 'completed', localStatus: 'completed', remoteStatus: 'kept_by_user' }, en)).toBe('Local session files removed · Remote records kept as you decided')
  })
})
