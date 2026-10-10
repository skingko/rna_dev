/**
 * The index rows' contract (A5): the host's allowlists (prototypes/control-center/index-schema.mjs) and the web's row
 * types name the same fields, field by field, and every projected record renders in the UI exactly as the full one did.
 */
import { describe, expect, it } from 'vitest'
import * as schema from '../../../index-schema.mjs'
import { WEB_PROTOCOL, type ProjectSummary, type SessionSummary } from './types'
import type { Occurrence, Schedule } from './project-api'
import { adaptiveRhythmDisplay, dueScheduleCount, rhythmChangesAt } from '@/lib/display/rhythm'
import { scheduleTasks } from '@/lib/tasks'
import { summaryStatusMessage } from '@/components/memory/memory-display'
import { protocolReload } from '@/store/sync'

// Exhaustive by type: a key missing here, or one the row type lacks, fails `tsc`; the runtime lists are the host's.
const SESSION_READERS: Record<keyof SessionSummary, string> = {
  id: 'everywhere', title: 'sidebar, archive, task panel', projectId: 'sidebar grouping, deep links', kind: 'side chats stay out of the index',
  parentSessionId: 'side chats', status: 'sidebar state, task panel', pauseReason: 'composer notice', mode: 'composer', model: 'composer',
  modelSelection: 'composer', modelConfig: 'composer meters', context: 'context meter', usage: 'meters', activeTurnId: 'composer',
  plan: 'plan mode', createdAt: 'ordering', updatedAt: 'sidebar time when there are no items', archivedAt: 'archive, launch',
  simulated: 'demo sessions', sideChat: 'side panel', invitations: 'nudge strip', worktree: 'worktree lists (isolation-store)',
  appRecovery: 'recovery notice', runtime: 'session notice', itemCount: 'new conversation state', lastItemAt: 'sidebar order and time',
  preview: 'contract §1 (no UI reads it today)', inboxCount: 'queued messages', waiting: 'sidebar dot', lastInitiativeAt: 'sidebar dot (seen-store)',
  agents: 'task panel subagent groups', memoryEvidence: 'contract §1: the evidence outbox as counts',
}
const PROJECT_READERS: Record<keyof ProjectSummary, string> = {
  id: 'everywhere', name: 'sidebar, pickers, archive', description: 'project overview', workspacePath: 'files, terminal, top bar',
  createdAt: 'ordering', updatedAt: 'detail refetch signature (useProjectDetail, tasks-store)', archivedAt: 'sidebar, archive, launch',
  primarySessionId: 'task panel destinations', permissions: 'composer pill, terminal, worktree panel', decisionMode: 'model projects',
  simulated: 'demo projects', focus: 'composer goal, autonomy settings', taskTypes: 'task types', initiative: 'autonomy settings, schedules',
  evolution: 'autonomy settings, top bar', rhythm: 'rhythm control', memory: 'memory namespace', activeVersionId: 'evolution views',
  trialVersionId: 'evolution views', activeVersion: 'evolution views', counts: 'inbox bell, sidebar, mind hints', genesForming: 'top bar dot',
  initialization: 'ProjectInitStatus, project overview', skillFoundation: 'ProjectInitStatus (base skills)', memorySummary: 'memory page',
  rhythmStatus: 'rhythm card', initiativeRuntime: 'top bar, tasks signature, rhythm admission', schedules: 'task list',
  scheduleRuntime: 'task list, background runs', plan: 'task page, run cards', work: 'background runs', backgroundChanges: 'change sets',
  git: 'worktree switch, git settings',
}

describe('index row fields', () => {
  it('the web protocol is the host index protocol', () => { expect(WEB_PROTOCOL).toBe(schema.INDEX_PROTOCOL) })
  it.each(Object.keys(SESSION_READERS))('session field %s is on the host allowlist', field => { expect(schema.SESSION_SUMMARY_FIELDS).toContain(field) })
  it.each([...schema.SESSION_SUMMARY_FIELDS])('host session field %s has a web reader', field => { expect(SESSION_READERS[field as keyof SessionSummary]).toBeTruthy() })
  it.each(Object.keys(PROJECT_READERS))('project field %s is on the host allowlist', field => { expect(schema.PROJECT_SUMMARY_FIELDS).toContain(field) })
  it.each([...schema.PROJECT_SUMMARY_FIELDS])('host project field %s has a web reader', field => { expect(PROJECT_READERS[field as keyof ProjectSummary]).toBeTruthy() })
  it('an archived row is a subset that still lists and restores the project', () => {
    for (const field of schema.ARCHIVED_PROJECT_SUMMARY_FIELDS) expect(schema.PROJECT_SUMMARY_FIELDS).toContain(field)
    for (const field of ['id', 'name', 'archivedAt']) expect(schema.ARCHIVED_PROJECT_SUMMARY_FIELDS).toContain(field)
  })
})

/* -------------------------------------------- projected records render as the full ones */

const NOW = Date.parse('2026-10-05T08:00:00Z'), HOUR = 3_600_000, DAY = 24 * HOUR
const iso = (at: number) => new Date(at).toISOString()
const long = (n: number) => '依据最新对话与交付记录调整节奏，'.repeat(n)

/** As projectRhythmStatus returns it on a live project (12 assessments, evidence ids, long reasons). */
const fullRhythm = () => ({
  control: 'auto', lifecycle: 'active', assessmentRequired: false, effective: { initiativeEnabled: true, evolutionEnabled: true },
  schedule: { activeCount: 1, dueCount: 0, nextAt: NOW + 3 * HOUR },
  initiative: { eligible: false, reason: 'review_interval', nextAt: NOW + HOUR, state: 'sleeping' },
  evolution: { eligible: true, reason: 'learning_due', nextAt: null, state: 'ready', quota: { dayUsed: 1, weekUsed: 3, maxPerDay: 2, maxPerWeek: 7, window: 'rolling' } },
  assessment: { lifecycle: 'active', reason: long(40), evidenceIds: Array.from({ length: 12 }, (_, i) => `ev-${i}`), scheduleIds: ['daily'], initiative: { mode: 'adaptive', reviewAfterMs: HOUR }, evolution: { mode: 'evidence', maxPerDay: 2, maxPerWeek: 7, minIntervalMs: HOUR } },
  assessmentSourceIds: ['src-1', 'src-2'], assessedAt: NOW - HOUR, lastInitiativeAt: NOW - HOUR, lastLearningAt: NOW - 2 * DAY,
  history: Array.from({ length: 12 }, (_, i) => ({ at: NOW - (12 - i) * HOUR, lifecycle: i % 3 ? 'active' : 'recurring', reason: long(i === 11 ? 70 : 20), initiativeMode: 'adaptive', evolutionMode: i % 2 ? 'evidence' : 'daily', evidenceIds: [`ev-${i}`, `ev-${i + 1}`], sourceIds: [`src-${i}`], source: 'model' })),
})

const schedule = (id: string, patch: Partial<Schedule> = {}): Schedule => ({
  id, title: `每日简报 ${id}`, task: long(150), enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: 's-main',
  nextRunAt: iso(NOW + 3 * HOUR), source: 'initiative', initiativeProvenance: { reason: long(30) }, userEditedAt: null, ...patch,
})
/** 40 settled occurrences over two schedules, plus an open one; each with the host bookkeeping the rows leave out. */
const occurrences = (): Occurrence[] => {
  const rows: Occurrence[] = []
  for (let i = 0; i < 40; i++) {
    const scheduleId = i % 2 ? 'b' : 'a', at = NOW - (40 - i) * 6 * HOUR, failed = i % 7 === 3
    rows.push({ key: `${scheduleId}:${at}`, scheduleId, scheduledAt: iso(at), status: failed ? 'failed' : 'delivered', ...(failed ? { errorCode: 'provider_timeout' } : { deliveredAt: iso(at + 600_000), deliveryItemId: `item-${i}` }), actionId: `act-${i}`, deliveryActionId: `deliver-${i}`, ...{ claimedAt: iso(at), coalescedFrom: null, scheduleRevision: 2, nextRunAt: iso(at + DAY) } } as Occurrence)
  }
  rows.push({ key: `a:${NOW - HOUR}`, scheduleId: 'a', scheduledAt: iso(NOW - HOUR), status: 'running', actionId: 'act-open' })
  return rows
}

describe('projected records render as the full ones', () => {
  it('rhythm card', () => {
    const base = { rhythm: { control: 'auto' }, initiative: { enabled: true }, evolution: { enabled: true } }
    const full = fullRhythm(), row = schema.rhythmStatusRow(full)!
    expect(adaptiveRhythmDisplay({ ...base, rhythmStatus: row })).toEqual(adaptiveRhythmDisplay({ ...base, rhythmStatus: full }))
    const blocked = { ...base, initiativeRuntime: { status: 'blocked', availability: { state: 'blocked', reason: 'session_cleanup_pending', title: 't', message: 'm', details: { codes: ['SESSION_CLEANUP_PENDING'], retryAt: iso(NOW) } } } }
    expect(adaptiveRhythmDisplay({ ...blocked, rhythmStatus: row })).toEqual(adaptiveRhythmDisplay({ ...blocked, rhythmStatus: full }))
    expect(JSON.stringify(row).length).toBeLessThan(JSON.stringify(full).length / 2)
    expect((row.history as unknown[]).length).toBe(schema.RHYTHM_HISTORY_ROWS)
  })

  it('a schedule coming due: the row carries its next run, and the card counts due schedules when it renders', () => {
    // The host's status counted the next runs its clock had passed (`dueCount`); in a row that changed an idle project's
    // row at the due instant. The row keeps the anchor (`schedules[].nextRunAt`) and the card compares it with its clock.
    const at = NOW + 3 * HOUR, base = { rhythm: { control: 'auto' }, initiative: { enabled: true }, evolution: { enabled: true } }
    const schedules = [schema.pick(schedule('a', { nextRunAt: iso(at) }), schema.SCHEDULE_FIELDS), schema.pick(schedule('b', { enabled: false, nextRunAt: iso(at - HOUR) }), schema.SCHEDULE_FIELDS)]
    const full = (dueCount: number) => ({ ...fullRhythm(), schedule: { activeCount: 1, dueCount, nextAt: at } })
    const row = schema.rhythmStatusRow(full(0))!
    expect(row.schedule).toEqual({ activeCount: 1, nextAt: at })
    expect(schema.rhythmStatusRow(full(1))).toEqual(row)
    const project = { ...base, schedules, rhythmStatus: row }
    expect([dueScheduleCount(project, at - 60_000), dueScheduleCount(project, at), dueScheduleCount(project, at + 60_000)]).toEqual([0, 1, 1])
    expect(adaptiveRhythmDisplay(project, at - 60_000)).toEqual(adaptiveRhythmDisplay({ ...base, schedules, rhythmStatus: full(0) }, at - 60_000))
    expect(adaptiveRhythmDisplay(project, at + 60_000)).toEqual(adaptiveRhythmDisplay({ ...base, schedules, rhythmStatus: full(1) }, at + 60_000))
    expect(adaptiveRhythmDisplay(project, at + 60_000).schedule).not.toEqual(adaptiveRhythmDisplay(project, at - 60_000).schedule)
    // The card re-renders when the next run passes, and not again until the next anchor.
    expect(rhythmChangesAt(project, at - 60_000)).toBe(at)
    expect(rhythmChangesAt(project, at)).toBeNull()
  })

  it('task list rows of schedules and their latest runs', () => {
    const fullProject = { id: 'p', name: '项目', initiative: { enabled: true }, schedules: [schedule('a'), schedule('b', { enabled: false })], scheduleRuntime: { occurrences: occurrences() } }
    const rowProject = { ...fullProject, schedules: fullProject.schedules.map(row => schema.pick(row, schema.SCHEDULE_FIELDS) as Schedule), scheduleRuntime: schema.scheduleRuntimeRow(fullProject.scheduleRuntime) as unknown as { occurrences: Occurrence[] } }
    const sessions = [{ id: 's-main', projectId: 'p', title: '主对话' }]
    expect(scheduleTasks(rowProject, { sessions }, NOW)).toEqual(scheduleTasks(fullProject, { sessions }, NOW))
    expect(rowProject.scheduleRuntime.occurrences.length).toBeLessThanOrEqual(5)
  })

  it('a listed run keeps its occurrence (the run card delivery stage)', () => {
    const runtime = { occurrences: occurrences() }, listed = runtime.occurrences[10]
    const row = schema.scheduleRuntimeRow(runtime, { runKeys: [listed.key], runActions: [] }) as unknown as { occurrences: Occurrence[] }
    expect(row.occurrences.find(item => item.key === listed.key)).toEqual(schema.pick(listed, schema.OCCURRENCE_FIELDS))
    expect(row.occurrences.some(item => item.status === 'running')).toBe(true)
  })

  it('memory page status line', () => {
    const full = { schemaVersion: 1, status: 'failed', code: 'MEMORY_SUMMARY_FAILED', message: '摘要没有生成，原文已保存。', updatedAt: iso(NOW), expectedFiles: Array.from({ length: 400 }, (_, i) => `viking://x/${i}.md`), taskId: 't', verification: { files: 400 } }
    const row = schema.pick(full, schema.MEMORY_SUMMARY_FIELDS)
    expect(summaryStatusMessage(row as { status?: string; message?: string })).toEqual(summaryStatusMessage(full))
    expect(Object.keys(row!).sort()).toEqual(['code', 'message', 'status', 'updatedAt'])
  })

  it('initialization and base-skill progress', () => {
    const init = { status: 'initializing', phase: 'generating', attempt: 2, maxAttempts: 4, startedAt: iso(NOW - 60_000), requestedAt: iso(NOW - 90_000), completedAt: undefined, message: '正在生成', diagnostic: 'd', preservedState: { big: long(200) }, referenceDiscovery: { rows: long(100) }, modelSelection: { providerId: 'x', modelId: 'y' } }
    const row = schema.pick(init, schema.INITIALIZATION_FIELDS) as Record<string, unknown>
    for (const key of ['status', 'phase', 'attempt', 'maxAttempts', 'startedAt', 'requestedAt', 'message', 'diagnostic']) expect(row[key]).toEqual(init[key as keyof typeof init])
    expect(row.preservedState).toBeUndefined()
    const foundation = { status: 'preparing', attemptedAt: iso(NOW), referenceDiscovery: { rows: long(300) }, coverage: [{ id: 'a' }] }
    expect(schema.pick(foundation, schema.SKILL_FOUNDATION_FIELDS)).toEqual({ status: 'preparing', attemptedAt: iso(NOW) })
  })
})

describe('protocol reload', () => {
  it('reloads once for another protocol, never for its own', () => {
    sessionStorage.clear()
    let reloads = 0
    const reload = () => { reloads++ }
    expect(protocolReload(WEB_PROTOCOL, reload)).toBe(false)
    expect(protocolReload(undefined, reload)).toBe(false)
    expect(protocolReload(WEB_PROTOCOL + 1, reload)).toBe(true)
    expect(protocolReload(WEB_PROTOCOL + 1, reload)).toBe(false)
    expect(reloads).toBe(1)
    expect(protocolReload(WEB_PROTOCOL + 2, reload)).toBe(true)
    expect(reloads).toBe(2)
  })
})
