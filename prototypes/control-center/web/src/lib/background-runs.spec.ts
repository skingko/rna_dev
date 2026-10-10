import { describe, expect, it } from 'vitest'
import type { InitiativeAction } from '@/api/project-api'
import type { SessionSummary, SubagentInfo, WorkRun } from '@/api/types'
import type { LiveStep } from '@/store/background-live'
import {
  actionFromRun, backgroundRuns, deliveryStages, findRun, FINISHED_WINDOW_MS, groupAgents, MAX_FINISHED, mergeWorkActions, planProgress, resolveFilter,
  rolePhase, runElapsed, runSteps, stepVerb, UPCOMING_PER_PROJECT, type BackgroundRunsInput, type RunProjectInput,
} from './background-runs'
import { aggregateTasks, sidebarTaskGroups, taskCounts } from './tasks'

const NOW = new Date('2026-10-03T10:00:00').getTime()
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const MIN = 60_000, HOUR = 60 * MIN

const steps = (patch: Partial<WorkRun['steps']> = {}): WorkRun['steps'] => ({ total: 0, completed: 0, failed: 0, uncertain: 0, limit: 64, kinds: { read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 0 }, ...patch })
const run = (patch: Partial<WorkRun> & Pick<WorkRun, 'id'>): WorkRun => ({
  kind: 'work', title: '整理测试报告', status: 'running', createdAt: iso(-4 * MIN), startedAt: iso(-3 * MIN), steps: steps(), latest: null,
  tokens: { total: 0, estimated: false }, model: null, changeId: null, ...patch,
})

const ink = (patch: Partial<RunProjectInput> = {}): RunProjectInput => ({
  id: 'p-ink', name: '水墨飞鸟', initiative: { enabled: true }, primarySessionId: 's-ink',
  schedules: [
    { id: 'daily', title: '晨报', task: 't', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, nextRunAt: iso(23 * HOUR), destinationSessionId: 's-news' },
    { id: 'hourly', title: '依赖巡检', task: 't', enabled: true, rule: { kind: 'interval', everyMs: HOUR }, nextRunAt: iso(20 * MIN), destinationSessionId: 's-ink' },
    { id: 'noon', title: '午间汇总', task: 't', enabled: true, rule: { kind: 'daily', time: '12:00', timeZone: 'UTC' }, nextRunAt: iso(2 * HOUR), destinationSessionId: 's-ink' },
    { id: 'night', title: '夜间整理', task: 't', enabled: true, rule: { kind: 'daily', time: '22:00', timeZone: 'UTC' }, nextRunAt: iso(12 * HOUR), destinationSessionId: 's-ink' },
    { id: 'off', title: '已暂停', task: 't', enabled: false, rule: { kind: 'daily', time: '08:00', timeZone: 'UTC' }, nextRunAt: null },
  ],
  scheduleRuntime: { occurrences: [] },
  ...patch,
})
const agentProject: RunProjectInput = { id: 'p-agent', name: 'Rna Agent', initiative: { enabled: true }, primarySessionId: 's-agent' }
const sessions: SessionSummary[] = [
  { id: 's-ink', title: '主会话', status: 'idle', projectId: 'p-ink' },
  { id: 's-news', title: '晨报', status: 'idle', projectId: 'p-ink' },
  { id: 's-agent', title: '联调', status: 'idle', projectId: 'p-agent' },
]
const input = (patch: Partial<BackgroundRunsInput> = {}): BackgroundRunsInput => ({ projects: [ink(), agentProject], actions: {}, sessions, filter: 'all', now: NOW, ...patch })

describe('background runs: sources', () => {
  it('builds rows from the actions alone when the host sends no work (older hosts)', () => {
    const actions: Record<string, InitiativeAction[]> = {
      'p-ink': [{ id: 'a1', action: 'work', status: 'running', label: '核对移动端截断', startedAt: NOW - 5 * MIN, availableControls: ['pause', 'stop', 'steer'], controlRevision: 2 }],
      'p-agent': [{ id: 'a2', action: 'work', status: 'queued', label: '复核字段命名', createdAt: iso(-MIN) }],
    }
    const view = backgroundRuns(input({ actions }))
    expect(view.running.map(r => [r.id, r.title, r.kindLabel, r.state])).toEqual([['a1', '核对移动端截断', '后台工作', 'running']])
    expect(view.running[0].controls).toEqual(['pause', 'stop', 'steer'])
    // Epoch-ms action times (P-5 accepts both) still give an elapsed time.
    expect(runElapsed(view.running[0], NOW)).toBe(5 * MIN)
    expect(view.running[0].phase.steps).toBeNull()
    expect(view.upcoming[0]).toMatchObject({ id: 'a2', state: 'queued', section: 'upcoming', agents: null })
  })

  it('adds runs only the host progress knows yet, and keeps the snapshot row for runs in both', () => {
    const project = ink({ work: { running: [run({ id: 'a1', status: 'running', title: '新标题' }), run({ id: 'w-only', title: '仅进度里有' })], recent: [] } })
    const merged = mergeWorkActions([project], { 'p-ink': [{ id: 'a1', action: 'work', status: 'paused', label: '快照标题', availableControls: ['resume'] }] })
    expect(merged['p-ink'].map(a => [a.id, a.status])).toEqual([['a1', 'paused'], ['w-only', 'running']])
    expect(merged['p-ink'][1].availableControls).toEqual([])
    const view = backgroundRuns(input({ projects: [project], actions: { 'p-ink': [{ id: 'a1', action: 'work', status: 'paused', label: '快照标题', availableControls: ['resume'] }] } }))
    expect(view.running.map(r => [r.id, r.state, r.title])).toEqual([['w-only', 'running', '仅进度里有'], ['a1', 'paused', '快照标题']])
    expect(view.running.find(r => r.id === 'a1')!.controls).toEqual(['resume'])
    expect(view.running.find(r => r.id === 'w-only')!.controls).toEqual([])
  })

  it('counts 进行中 exactly as the sidebar does (lib/tasks), for the same inputs', () => {
    const actions: Record<string, InitiativeAction[]> = {
      'p-ink': [
        { id: 'r', action: 'work', status: 'running' }, { id: 'p', action: 'work', status: 'paused' }, { id: 'q', action: 'share', status: 'queued' },
        { id: 'v', action: 'work', status: 'needs_review' }, { id: 'd', action: 'work', status: 'completed', finishedAt: NOW - HOUR },
      ],
      'p-agent': [{ id: 'q2', action: 'work', status: 'queued' }],
    }
    const view = backgroundRuns(input({ actions }))
    const sidebar = sidebarTaskGroups(aggregateTasks([ink(), agentProject], actions, { sessions }, NOW)).active
    expect(view.counts.active).toBe(sidebar.length)
    expect(view.counts.active).toBe(4)
    // The action rows of 运行中 and 排队 are exactly the sidebar's 进行中 rows.
    const listed = [...view.running, ...view.upcoming].filter(r => r.task?.kind === 'action').map(r => r.key).sort()
    expect(listed).toEqual(sidebar.map(e => e.key).sort())
  })

  it('applies the project filter, and lib/tasks skips archived and simulated projects', () => {
    const actions = { 'p-ink': [{ id: 'a1', action: 'work', status: 'running' }], 'p-agent': [{ id: 'a2', action: 'work', status: 'running' }], 'p-old': [{ id: 'a3', action: 'work', status: 'running' }] }
    const old: RunProjectInput = { id: 'p-old', name: '旧', archivedAt: iso(-HOUR) }
    expect(backgroundRuns(input({ projects: [ink(), agentProject, old], actions })).running.map(r => r.id).sort()).toEqual(['a1', 'a2'])
    expect(backgroundRuns(input({ projects: [ink(), agentProject, old], actions, filter: 'p-agent' })).running.map(r => r.id)).toEqual(['a2'])
    expect(resolveFilter(undefined, 'p-ink')).toBe('p-ink')
    expect(resolveFilter('all', 'p-ink')).toBe('all')
    expect(resolveFilter('p-agent', 'p-ink')).toBe('p-agent')
    expect(resolveFilter(undefined, null)).toBe('all')
  })
})

describe('background runs: card details', () => {
  it('fills the card from the host progress: tokens, model, steps with failures, change set, conversation', () => {
    const project = ink({
      work: { running: [run({ id: 'a1', resumedAt: iso(-MIN), steps: steps({ total: 24, completed: 23, failed: 1 }), tokens: { total: 18_200, estimated: true }, model: { providerId: 'x', modelId: 'm', name: 'GLM-5.3' }, changeId: 'bg-1' })], recent: [] },
      backgroundChanges: [{ id: 'bg-1', actionId: 'a1', at: iso(-MIN), status: 'kept', count: 4, paths: [] }],
    })
    const [card] = backgroundRuns(input({ projects: [project] })).running
    expect(card).toMatchObject({ agents: 1, tokens: { total: 18_200, estimated: true }, model: 'GLM-5.3', changeId: 'bg-1', changeCount: 4, sessionId: 's-ink' })
    expect(card.phase.steps).toEqual({ completed: 23, total: 24, failed: 1, uncertain: 0 }) // no limit: it counts model requests, not steps
    // Elapsed counts the current stretch: since it was resumed.
    expect(runElapsed(card, NOW)).toBe(MIN)
  })

  it('finds a change set by its action when the progress does not name it', () => {
    const project = ink({ backgroundChanges: [{ id: 'bg-9', actionId: 'a1', at: iso(-MIN), status: 'kept', count: 2, paths: [] }] })
    const [card] = backgroundRuns(input({ projects: [project], actions: { 'p-ink': [{ id: 'a1', action: 'work', status: 'running' }] } })).running
    expect([card.changeId, card.changeCount]).toEqual(['bg-9', 2])
  })

  it('shows 计划项 x/y from plan items the run staged or resolved, and nothing without any (no forced planning)', () => {
    const plan = {
      doing: [{ id: 'i1', text: '核对', status: 'doing', actionId: 'a1' }],
      next: [{ id: 'i2', text: '截图', status: 'next', actionId: 'a1' }, { id: 'i3', text: '别的', status: 'next', actionId: 'other' }],
      done: [{ id: 'i0', text: '修复', status: 'done', actionId: 'a1' }, { id: 'i4', text: '旧', status: 'done' }],
    }
    expect(planProgress(plan, 'a1')).toEqual({ done: 1, total: 3 })
    expect(planProgress(plan, 'none')).toBeNull()
    expect(planProgress(null, 'a1')).toBeNull()
    const [card] = backgroundRuns(input({ projects: [ink({ plan })], actions: { 'p-ink': [{ id: 'a1', action: 'work', status: 'running' }] } })).running
    expect(card.phase.plan).toEqual({ done: 1, total: 3 })
  })

  it('prefers the run’s own plan count from the host (null: it has none), else counts the project plan', () => {
    const plan = { doing: [{ id: 'i1', text: '核对', status: 'doing', actionId: 'a1' }], next: [], done: [{ id: 'i0', text: '修复', status: 'done', actionId: 'a1' }] }
    const card = (patch: Partial<WorkRun>) => backgroundRuns(input({ projects: [ink({ plan, work: { running: [run({ id: 'a1', ...patch })], recent: [] } })] })).running[0]
    expect(card({ plan: { done: 4, total: 7 } }).phase.plan).toEqual({ done: 4, total: 7 }) // the summary's plan keeps only the last few done rows
    expect(card({ plan: null }).phase.plan).toBeNull()
    expect(card({ plan: { done: 0, total: 0 } }).phase.plan).toBeNull()
    expect(card({}).phase.plan).toEqual({ done: 1, total: 2 }) // an older host sends no count
  })

  it('names a scheduled run by its schedule and drives 执行 → 交付 from its occurrence', () => {
    const project = ink({
      work: { running: [run({ id: 's1', kind: 'scheduled', scheduleId: 'daily', occurrenceKey: 'occ-1', title: '定时运行' })], recent: [] },
      scheduleRuntime: { occurrences: [{ key: 'occ-1', scheduleId: 'daily', scheduledAt: iso(-5 * MIN), status: 'running' }] },
    })
    const [card] = backgroundRuns(input({ projects: [project] })).running
    expect([card.title, card.kindLabel, card.kind, card.sessionId]).toEqual(['晨报', '定时任务', 'scheduled', 's-news'])
    expect(card.phase.delivery).toEqual({ run: 'active', deliver: 'pending' })
    expect(deliveryStages({ status: 'delivery_pending' }, 'done')).toEqual({ run: 'done', deliver: 'active' })
    expect(deliveryStages({ status: 'queued', deliveredAt: iso(0) }, 'done')).toEqual({ run: 'done', deliver: 'done' })
    expect(deliveryStages({ status: 'failed' }, 'failed')).toEqual({ run: 'failed', deliver: 'pending' })
    expect(deliveryStages(null, 'queued')).toEqual({ run: 'pending', deliver: 'pending' })
    expect(deliveryStages(null, 'done')).toEqual({ run: 'done', deliver: 'pending' })
  })

  it('a finished scheduled run the project row has no occurrence for reads 交付 from its action (an hourly schedule\'s older runs)', () => {
    // The row keeps the latest, open and `work`-listed occurrences (8 recent runs); the panel lists a day of finished runs.
    const listed = { key: 'hourly:new', scheduleId: 'hourly', scheduledAt: iso(-HOUR), status: 'delivered', deliveredAt: iso(-HOUR + MIN), actionId: 'new' }
    const project = ink({ scheduleRuntime: { occurrences: [listed] } })
    const scheduled = (id: string, at: number, occurrence?: InitiativeAction['occurrence']): InitiativeAction => ({ id, action: 'work', status: 'completed', label: '依赖巡检', createdAt: iso(at), startedAt: iso(at), finishedAt: iso(at + MIN), hostSchedule: { scheduleId: 'hourly', key: `hourly:${id}` }, ...(occurrence !== undefined ? { occurrence } : {}) })
    const actions = { 'p-ink': [
      scheduled('new', -HOUR, { key: 'hourly:new', status: 'delivery_pending' }),
      scheduled('old', -10 * HOUR, { key: 'hourly:old', status: 'delivered', deliveredAt: iso(-10 * HOUR + 2 * MIN) }),
      scheduled('lost', -11 * HOUR, { key: 'hourly:lost', status: 'failed' }),
      scheduled('older-host', -12 * HOUR),
    ] }
    const delivery = (id: string) => backgroundRuns(input({ projects: [project], actions })).finished.find(row => row.id === id)?.phase.delivery
    expect(delivery('old')).toEqual({ run: 'done', deliver: 'done' })
    expect(delivery('lost')).toEqual({ run: 'failed', deliver: 'pending' })
    // The row's occurrence is the live one and wins over the action read's snapshot.
    expect(delivery('new')).toEqual({ run: 'done', deliver: 'done' })
    expect(delivery('older-host')).toEqual({ run: 'done', deliver: 'pending' })
  })

  it('a host-progress run carries what lib/tasks needs to name and classify it', () => {
    expect(actionFromRun(run({ id: 'x', kind: 'scheduled', scheduleId: 'daily', occurrenceKey: 'k', status: 'completed', completedAt: iso(0), summary: '晨报已送达', errorCode: 'e' }))).toMatchObject({
      id: 'x', action: 'work', status: 'completed', label: '整理测试报告', hostSchedule: { scheduleId: 'daily', key: 'k' }, finishedAt: iso(0), resultSummary: '晨报已送达', errorCode: 'e', availableControls: [],
    })
    expect(actionFromRun(run({ id: 'l', kind: 'learn' })).action).toBe('learn')
  })

  it('a run the actions read does not list yet keeps the user’s marks: an answered result is not 需要你 again', () => {
    const review = (patch: Partial<WorkRun> = {}) => run({ id: 'r1', status: 'needs_review', completedAt: iso(-MIN), ...patch })
    const marked = (project: RunProjectInput) => aggregateTasks([project], mergeWorkActions([project], {}), {}, NOW).find(entry => entry.id === 'r1')!.flags
    expect(marked(ink({ work: { running: [review()], recent: [] } }))).toContain('attention')
    const answered = { acknowledgedAt: iso(-MIN) }
    expect(marked(ink({ work: { running: [review({ attention: answered })], recent: [] } }))).not.toContain('attention')
    expect(marked(ink({ work: { running: [review()], recent: [] }, taskMarks: { r1: answered } }))).not.toContain('attention')
    const answeredProject = ink({ work: { running: [review({ attention: answered })], recent: [] } })
    expect(taskCounts(aggregateTasks([answeredProject], mergeWorkActions([answeredProject], {}), {}, NOW)).attention).toBe(0) // the sidebar's 需要你 count
    // A finished result marked as needing the user stays marked until they answer.
    const done = run({ id: 'r1', status: 'completed', completedAt: iso(-MIN), attention: { needsUser: true } })
    const finished = ink({ work: { running: [], recent: [done] } })
    expect(aggregateTasks([finished], mergeWorkActions([finished], {}), { ended: true }, NOW).find(entry => entry.id === 'r1')!.flags).toContain('attention')
  })
})

describe('background runs: steps', () => {
  const live = (id: string, offset: number, name = 'project_edit', target: string | null = 'src/a.ts'): LiveStep => ({ toolCallId: id, name, kind: name === 'project_edit' ? 'edit' : 'read', target, at: iso(offset), projectId: 'p-ink' })

  it('reads the newest live step as running and earlier ones as ended (no claimed outcome)', () => {
    const rows = runSteps(null, [live('c1', -20_000, 'project_read', 'a.md'), live('c2', -1000)], true)
    expect(rows.map(r => [r.id, r.status, r.verb])).toEqual([['c2', 'running', '正在编辑'], ['c1', 'ended', '']])
    expect(rows[0].kind).toBe('edit')
  })

  it('merges the host-recorded latest step with its live start and keeps its outcome', () => {
    const recorded = { name: 'project_edit', kind: 'edit', target: 'src/a.ts', status: 'failed' as const, at: iso(-1500) }
    const rows = runSteps(recorded, [live('c2', -1000)], true)
    expect(rows).toHaveLength(1)
    expect([rows[0].status, rows[0].verb]).toEqual(['failed', '编辑失败'])
  })

  it('after a reconnect the recorded latest step stands alone', () => {
    const rows = runSteps({ name: 'project_exec', kind: 'command', target: 'npm test', status: 'running', at: iso(-2000) }, undefined, true)
    expect(rows.map(r => [r.status, r.verb, r.target])).toEqual([['running', '正在运行', 'npm test']])
    // Not running any more: its start is history.
    expect(runSteps({ name: 'project_exec', kind: 'command', target: 'npm test', status: 'running', at: iso(-2000) }, undefined, false)[0].status).toBe('ended')
  })

  it('words a started step without a target as under way, and tolerates unknown kinds', () => {
    expect(stepVerb({ name: 'project_read', kind: 'read', target: null }, 'running')).toBe('正在读取')
    expect(stepVerb({ name: 'project_read', kind: 'read', target: 'a.md' }, 'succeeded')).toBe('已读取')
    expect(stepVerb({ name: 'mystery', kind: 'not-a-kind', target: 'x' }, 'running')).toBe('正在调用工具')
  })

  it('puts the latest step on running cards', () => {
    const view = backgroundRuns(input({ actions: { 'p-ink': [{ id: 'a1', action: 'work', status: 'running' }] }, live: { a1: [live('c1', -3000)] } }))
    expect(view.running[0].latest).toMatchObject({ verb: '正在编辑', target: 'src/a.ts', status: 'running' })
  })
})

describe('background runs: upcoming and finished', () => {
  it('lists each project’s next scheduled runs (at most three, soonest first) after queued work', () => {
    const view = backgroundRuns(input({ actions: { 'p-ink': [{ id: 'q', action: 'work', status: 'queued', label: '复核字段', createdAt: iso(-MIN) }] } }))
    expect(view.upcoming.map(r => r.title)).toEqual(['复核字段', '依赖巡检', '午间汇总', '夜间整理'])
    expect(view.upcoming.filter(r => r.task?.kind === 'schedule')).toHaveLength(UPCOMING_PER_PROJECT)
    expect(view.upcoming[1]).toMatchObject({ kindLabel: '定时任务', when: '20 分钟后', summary: expect.stringContaining('每'), scheduleId: 'hourly' })
  })

  it('an upcoming run keeps only 已错过 among its schedule’s marks (新结果 is about the last run)', () => {
    const project = ink({
      schedules: [
        { id: 'late', title: '漏跑', task: 't', enabled: true, rule: { kind: 'daily', time: '08:00', timeZone: 'UTC' }, nextRunAt: iso(-HOUR), destinationSessionId: 's-ink' },
        { id: 'fresh', title: '刚送达', task: 't', enabled: true, rule: { kind: 'daily', time: '20:00', timeZone: 'UTC' }, nextRunAt: iso(10 * HOUR), destinationSessionId: 's-ink' },
      ],
      scheduleRuntime: { occurrences: [{ key: 'k', scheduleId: 'fresh', scheduledAt: iso(-MIN), status: 'delivered', deliveredAt: iso(-MIN) }] },
    })
    const rows = backgroundRuns(input({ projects: [project] })).upcoming
    expect(rows.map(r => [r.id, r.flags])).toEqual([['late', ['overdue']], ['fresh', []]])
  })

  it('keeps finished work from the last 24 hours, newest first, without sent shares or questions; an unanswered failure waits under 需要你', () => {
    const actions: Record<string, InitiativeAction[]> = {
      'p-ink': [
        { id: 'old', action: 'work', status: 'completed', finishedAt: NOW - FINISHED_WINDOW_MS - MIN },
        { id: 'new', action: 'work', status: 'completed', finishedAt: NOW - 10 * MIN, resultSummary: '周报已整理好' },
        { id: 'bad', action: 'work', status: 'failed', finishedAt: NOW - HOUR, failure: { code: 'tool_timeout' } },
        { id: 'msg', action: 'share', status: 'completed', finishedAt: NOW - 5 * MIN },
      ],
    }
    const view = backgroundRuns(input({ actions }))
    expect(view.finished.map(r => r.id)).toEqual(['new'])
    expect(view.finished[0]).toMatchObject({ summary: '周报已整理好', stateLabel: '已完成' })
    // A failure the user has not answered yet (接着做 / 不用了) is 需要你, as in the sidebar.
    expect(view.attention.map(r => r.id)).toEqual(['bad'])
    expect(view.attention[0].summary).toBe('模型服务这次没有及时响应，工作没做完。')
  })

  it('a run cancelled before it started ends without an elapsed time or an executor', () => {
    const cancelled = run({ id: 'c1', status: 'cancelled', startedAt: undefined, createdAt: iso(-30 * MIN), completedAt: iso(-5 * MIN), errorCode: 'cancelled_by_user' })
    const [row] = backgroundRuns(input({ projects: [ink({ work: { running: [], recent: [cancelled] } })] })).finished
    expect(row).toMatchObject({ id: 'c1', state: 'cancelled', startedAt: null, endedAt: NOW - 5 * MIN, agents: null })
    expect(runElapsed(row, NOW)).toBeNull()
    expect(row.phase.steps).toBeNull()
    // The same from the actions read (no start time there either).
    const [fromAction] = backgroundRuns(input({ actions: { 'p-ink': [{ id: 'c2', action: 'work', status: 'cancelled', createdAt: NOW - 30 * MIN, finishedAt: NOW - 5 * MIN }] } })).finished
    expect(fromAction).toMatchObject({ startedAt: null, agents: null })
    expect(runElapsed(fromAction, NOW)).toBeNull()
  })

  it('lists queued work next-to-run first (the host sends it oldest first)', () => {
    const queued = [run({ id: 'q-old', status: 'queued', startedAt: undefined, createdAt: iso(-20 * MIN), title: '先排的' }), run({ id: 'q-new', status: 'queued', startedAt: undefined, createdAt: iso(-MIN), title: '后排的' })]
    for (const order of [queued, [...queued].reverse()]) {
      const view = backgroundRuns(input({ projects: [ink({ schedules: [], work: { running: order, recent: [] } })] }))
      expect(view.upcoming.map(r => r.id)).toEqual(['q-old', 'q-new'])
    }
  })

  it('prefers the host summary of a recent run and caps the list', () => {
    const recent = Array.from({ length: 40 }, (_, i) => run({ id: `r${i}`, status: 'completed', completedAt: iso(-(i + 1) * MIN), summary: `结果 ${i}` }))
    const view = backgroundRuns(input({ projects: [ink({ work: { running: [], recent } })] }))
    expect(view.finished).toHaveLength(MAX_FINISHED)
    expect(view.finished[0]).toMatchObject({ id: 'r0', summary: '结果 0' })
    expect(runElapsed(view.finished[0], NOW)).toBe(3 * MIN - MIN)
  })

  it('清除 hides what ended before it, never what still needs the user', () => {
    const actions: Record<string, InitiativeAction[]> = {
      'p-ink': [
        { id: 'done', action: 'work', status: 'completed', finishedAt: NOW - 10 * MIN },
        { id: 'rev', action: 'work', status: 'needs_review', startedAt: NOW - 20 * MIN },
      ],
    }
    const cleared = { 'p-ink:action:done': NOW - MIN, 'p-ink:action:rev': NOW - MIN }
    const view = backgroundRuns(input({ actions, cleared }))
    // A result to check is not among the day's results: it waits at the top as 需要你, and 清除 never hides it.
    expect(view.finished.map(r => r.id)).toEqual([])
    expect(view.attention.map(r => [r.id, r.section])).toEqual([['rev', 'attention']])
    expect(view.counts).toMatchObject({ cleared: 1, attention: 1 })
  })

  it('a result waiting on the user stays under 需要你 whatever its age, and focusing it finds it there', () => {
    const actions: Record<string, InitiativeAction[]> = { 'p-ink': [{ id: 'old-rev', action: 'work', status: 'needs_review', startedAt: NOW - 3 * 24 * HOUR }] }
    const view = backgroundRuns(input({ actions }))
    expect(view.attention.map(r => r.id)).toEqual(['old-rev'])
    expect(findRun(view, 'old-rev')?.section).toBe('attention')
  })
})

describe('background runs: subagent groups', () => {
  const agent = (patch: Partial<SubagentInfo>): SubagentInfo => ({ agentId: 'x', status: 'completed', turnId: 't2', ...patch })
  const group = (agents: SessionSummary['agents'], patch: Partial<SessionSummary> = {}): SessionSummary => ({ id: 's-research', title: '调研竞品', status: 'idle', projectId: 'p-ink', lastItemAt: iso(-MIN), agents, ...patch })

  it('lists a running group with its agents, tokens and role phase once loaded', () => {
    const details = [
      agent({ agentId: 'a', role: 'scout', startedAt: iso(-100_000), endedAt: iso(-60_000) }),
      agent({ agentId: 'b', role: 'scout', startedAt: iso(-90_000), endedAt: iso(-50_000) }),
      agent({ agentId: 'c', role: 'worker', status: 'running', task: '实现对比表', startedAt: iso(-40_000), model: { providerId: 'p', modelId: 'm', name: 'Kimi K3' } }),
      agent({ agentId: 'd', role: 'worker', startedAt: iso(-45_000), endedAt: iso(-10_000) }),
      agent({ agentId: 'e', role: 'reviewer', status: 'running', startedAt: iso(-5000) }),
      agent({ agentId: 'old', role: 'scout', turnId: 't1' }),
    ]
    const view = backgroundRuns(input({ sessions: [...sessions, group({ running: 2, total: 5, tokens: 41_000, latestTurnId: 't2' })], agents: { 's-research': details } }))
    const [card] = view.running
    expect(card).toMatchObject({ kind: 'agents', kindLabel: '子任务组', title: '调研竞品', agents: 5, tokens: { total: 41_000, estimated: false }, model: 'Kimi K3', sessionId: 's-research', turnId: 't2', summary: '实现对比表' })
    expect(card.phase.roles).toEqual([
      { role: 'scout', label: '侦察', done: 2, total: 2, running: 0 },
      { role: 'worker', label: '实施', done: 1, total: 2, running: 1 },
      { role: 'reviewer', label: '审查', done: 0, total: 1, running: 1 },
    ])
    expect(runElapsed(card, NOW)).toBe(100_000)
    // The group is not background work in the sidebar's sense: 进行中 stays the actions' count.
    expect(view.counts.active).toBe(0)
  })

  it('shows a group before its agents load, ends it into 已完成, and drops stale ones', () => {
    const live = backgroundRuns(input({ sessions: [group({ running: 1, total: 3, tokens: 0, latestTurnId: null })] }))
    expect(live.running[0]).toMatchObject({ summary: '1 个子代理进行中，共 3 个', tokens: null, phase: { roles: null } })
    const ended = backgroundRuns(input({ sessions: [group({ running: 0, total: 3, tokens: 9000, latestTurnId: 't2' })] }))
    expect(ended.finished.map(r => [r.kind, r.state, r.summary])).toEqual([['agents', 'done', '3 个子代理都已结束']])
    const stale = backgroundRuns(input({ sessions: [group({ running: 0, total: 3, tokens: 9000, latestTurnId: 't2' }, { lastItemAt: iso(-2 * FINISHED_WINDOW_MS) })] }))
    expect(stale.finished).toEqual([])
    expect(backgroundRuns(input({ sessions: [group({ running: 0, total: 1, tokens: 0, latestTurnId: 't2' })] })).finished[0].summary).toBe('子代理已结束')
  })

  it('follows the project filter; a conversation outside projects shows only under 全部', () => {
    const loose = group({ running: 1, total: 1, tokens: 0, latestTurnId: null }, { id: 's-loose', projectId: null })
    expect(backgroundRuns(input({ sessions: [loose] })).running).toHaveLength(1)
    expect(backgroundRuns(input({ sessions: [loose], filter: 'p-ink' })).running).toHaveLength(0)
    expect(backgroundRuns(input({ sessions: [group({ running: 1, total: 1, tokens: 0, latestTurnId: null })], filter: 'p-agent' })).running).toHaveLength(0)
  })

  it('orders a group’s agents by role then start', () => {
    const rows = groupAgents([agent({ agentId: 'r', role: 'reviewer' }), agent({ agentId: 'w', role: 'worker', startedAt: iso(-1) }), agent({ agentId: 's', role: 'scout' }), agent({ agentId: 'w0', role: 'worker', startedAt: iso(-9) })], 't2')
    expect(rows.map(r => r.agentId)).toEqual(['s', 'w0', 'w', 'r'])
    expect(rolePhase([])).toBeNull()
  })

  it('finds the row a sidebar entry or an action id points at', () => {
    const view = backgroundRuns(input({ actions: { 'p-ink': [{ id: 'a1', action: 'work', status: 'running' }] } }))
    expect(findRun(view, 'a1')?.key).toBe('p-ink:action:a1')
    expect(findRun(view, 'p-ink:action:a1')?.id).toBe('a1')
    expect(findRun(view, 'missing')).toBeNull()
    expect(findRun(view, null)).toBeNull()
  })
})
