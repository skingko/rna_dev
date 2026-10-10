/**
 * The open conversation's contract (B9): the host's session and turn allowlists (prototypes/control-center/
 * session-schema.mjs) cover every field the web's Session and Turn types read, and every host field has a reader.
 */
import { describe, expect, it } from 'vitest'
import * as schema from '../../../session-schema.mjs'
import type { SessionField, TurnField } from '../../../session-schema.mjs'
import type { SessionMeta, Turn } from './types'

// Exhaustive by type: a field added to SessionMeta or Turn without an entry here fails `tsc`, and one the host does not
// send fails the runtime check below.
const SESSION_READERS: Record<keyof SessionMeta, string> = {
  id: 'everywhere', title: 'header, side panel', projectId: 'composer, deep links, worktree lists', status: 'composer, notices',
  mode: 'composer', model: 'composer', modelSelection: 'composer model pill', modelConfig: 'composer meters, retry', context: 'context meter',
  activeTurnId: 'composer, phases', workspace: 'files and terminal fallback', inbox: 'queued messages strip', plan: 'plan mode',
  archivedAt: 'archive, launch', createdAt: 'ordering', updatedAt: 'ordering', pauseReason: 'SessionNotice', simulated: 'demo sessions',
  runtime: 'SessionNotice (recovery.uncertainTools)', appRecovery: 'recovery notice', kind: 'side chats', parentSessionId: 'side chats',
  sideChat: 'side panel', invitations: 'nudge strip', worktree: 'isolation-store',
}
const TURN_READERS: Record<keyof Turn, string> = {
  id: 'everywhere', status: 'turn rows, notices', autoRetry: 'retry countdown', errorCode: 'SessionNotice', mode: 'turn rows',
  createdAt: 'latest turn, trajectory', startedAt: 'turn time', firstTokenAt: 'turn time', completedAt: 'turn time', userItemId: 'turn rows',
  source: 'turn rows', modelConfig: 'composer reasoning, retry', timing: 'trajectory', activeMs: 'turn time', attemptStartedAt: 'turn time',
  pausedAt: 'turn time', retryHistory: 'turn time', blockingActionId: 'SessionNotice', blockingDraining: 'SessionNotice', apply: 'TurnApply',
  checkpoint: 'TurnApply', route: 'turn footer hints (TurnRow routeHints)',
}
// Host fields no web type names, and who reads them.
const OTHER_READERS: Partial<Record<SessionField | TurnField, string>> = {
  usage: 'CLI /status and the spec (§3: turn.usage, session.usage with cost)', sideContext: 'spec §8.2: the side chat seed on the full session',
  model: 'spec §3: turn.model is the display name of the model the turn ran on',
}

// Type level: every web field is on the host list.
const sessionCovered: [Exclude<keyof SessionMeta, SessionField>] extends [never] ? true : false = true
const turnCovered: [Exclude<keyof Turn, TurnField>] extends [never] ? true : false = true

describe('open conversation fields', () => {
  it('the web reads only fields the host sends', () => {
    expect(sessionCovered && turnCovered).toBe(true)
    for (const field of Object.keys(SESSION_READERS)) expect(schema.SESSION_FIELDS).toContain(field)
    for (const field of Object.keys(TURN_READERS)) expect(schema.TURN_FIELDS).toContain(field)
  })
  it.each([...schema.SESSION_FIELDS])('host session field %s has a reader', field => { expect(SESSION_READERS[field as keyof SessionMeta] ?? OTHER_READERS[field]).toBeTruthy() })
  it.each([...schema.TURN_FIELDS])('host turn field %s has a reader', field => { expect(TURN_READERS[field as keyof Turn] ?? OTHER_READERS[field]).toBeTruthy() })
  it('the memory pipeline bookkeeping is not on the wire', () => {
    for (const field of ['memoryEvidenceOutbox', 'memoryEvidenceState', 'items', 'turns']) expect(schema.SESSION_FIELDS).not.toContain(field)
    for (const field of ['memoryContext', 'memoryWrite', 'mindContext', 'judgments']) expect(schema.TURN_FIELDS).not.toContain(field)
    expect(schema.sessionMeta({ id: 's', memoryEvidenceOutbox: [1], items: [] })).toEqual({ id: 's' })
    expect(schema.turnView({ id: 't', status: 'completed', memoryContext: { results: [] } })).toEqual({ id: 't', status: 'completed' })
  })
  it('the tail window and page limits are the references\' (harness 50 messages and 2 turns, ≤500; zcode pages ≤200)', () => {
    expect(schema.TAIL_WINDOW).toEqual({ minMessages: 50, minTurns: 2, maxMessages: 500 })
    expect(schema.PAGE_LIMIT).toBe(200)
  })
})
