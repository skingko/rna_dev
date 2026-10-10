import { describe, expect, it } from 'vitest'
import type { InitiativeAction } from '@/api/project-api'
import { aggregateTasks, taskCounts, whenLabel, type TaskProjectInput, actionTask } from './tasks'

const NOW = new Date('2026-09-28T10:00:00').getTime()
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const MIN = 60_000

const ink: TaskProjectInput = {
  id: 'p-ink', name: '水墨飞鸟', initiative: { enabled: true },
  schedules: [
    { id: 'daily', title: '每日检查点', task: 't', enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }, nextRunAt: iso(23 * 60 * MIN) },
    { id: 'weekly', title: '每周盘点', task: 't', enabled: false, rule: { kind: 'weekly', days: [1], time: '10:30', timeZone: 'UTC' }, nextRunAt: null },
  ],
  scheduleRuntime: { occurrences: [] },
}
const agent: TaskProjectInput = {
  id: 'p-agent', name: 'Rna Agent', initiative: { enabled: true },
  schedules: [{ id: 'soon', title: '依赖巡检', task: 't', enabled: true, rule: { kind: 'interval', everyMs: 30 * MIN }, nextRunAt: iso(20 * MIN) }],
}
const actions: Record<string, InitiativeAction[]> = {
  'p-ink': [
    { id: 'run', action: 'work', status: 'running', content: '核对移动端截断\n第二行', availableControls: ['pause', 'stop', 'steer'], controlRevision: 3, ...{ startedAt: iso(-5 * MIN) } },
    { id: 'rev', action: 'work', status: 'needs_review', content: '批量替换', availableControls: [] },
    { id: 'done', action: 'share', status: 'completed', content: '已发送' },
  ],
  'p-agent': [{ id: 'held', action: 'work', status: 'paused', content: '整理性能数据', availableControls: ['resume', 'stop'] }],
}

describe('global tasks', () => {
  it('labels near and far times compactly', () => {
    expect(whenLabel(NOW + 20 * MIN, NOW)).toBe('20 分钟后')
    expect(whenLabel(NOW - 5 * MIN, NOW)).toBe('5 分钟前')
    expect(whenLabel(new Date('2026-09-29T09:00:00').getTime(), NOW)).toBe('明天 09:00')
    expect(whenLabel(new Date('2026-10-03T09:05:00').getTime(), NOW)).toBe('10月3日 09:05')
    expect(whenLabel(null, NOW)).toBe('')
  })

  it('merges actions and schedules across projects in attention order', () => {
    const tasks = aggregateTasks([ink, agent], actions, {}, NOW)
    expect(tasks.map(t => t.id)).toEqual(['run', 'rev', 'held', 'soon', 'daily', 'weekly'])
    const run = tasks[0]
    expect(run).toMatchObject({ projectName: '水墨飞鸟', kind: 'action', title: '核对移动端截断', state: 'running', controls: ['pause', 'stop', 'steer'], when: '5 分钟前' })
    expect(tasks.find(t => t.id === 'held')).toMatchObject({ state: 'paused', controls: ['resume', 'stop'] })
    expect(tasks.find(t => t.id === 'weekly')).toMatchObject({ state: 'disabled', stateLabel: '已暂停', enabled: false })
    expect(tasks.find(t => t.id === 'soon')).toMatchObject({ state: 'scheduled', when: '20 分钟后', enabled: true })
    expect(taskCounts(tasks)).toEqual({ active: 1, attention: 1, total: 6 })
  })

  it('skips archived and simulated projects and pauses schedules under emergency', () => {
    expect(aggregateTasks([{ ...ink, archivedAt: iso(0) }, { ...agent, simulated: true }], actions, {}, NOW)).toEqual([])
    const stopped = aggregateTasks([agent], {}, { emergency: true }, NOW)
    expect(stopped[0]).toMatchObject({ state: 'disabled', stateLabel: '全局急停', enabled: true })
  })
})

describe('sidebar task groups', () => {
  it('keeps live background work and schedules apart and leaves ended work to the tasks page', async () => {
    const { sidebarTaskGroups } = await import('./tasks')
    const groups = sidebarTaskGroups(aggregateTasks([ink, agent], actions, {}, NOW))
    expect(groups.active.map(t => t.id)).toEqual(['run', 'held'])
    expect(groups.schedules.map(t => t.id)).toEqual(['soon', 'daily', 'weekly'])
  })
})

describe('background work answered from the conversation', () => {
  it('a failed task answered 接着做 / 不用了 no longer counts as 需要你', () => {
    const project = { id: 'p', name: 'Novel' } as Parameters<typeof actionTask>[0]
    const failed = { id: 'a1', action: 'work', status: 'failed', content: '接手被中断的指令', finishedAt: new Date().toISOString() }
    const open = actionTask(project, failed, Date.now(), { ended: true })!
    const handled = actionTask(project, { ...failed, attention: { acknowledgedAt: new Date().toISOString() } }, Date.now(), { ended: true })!
    expect(open.flags).toContain('failed')
    expect(handled.flags).toEqual(['handled'])
    expect(taskCounts([open, handled]).attention).toBe(1)
  })
})

// Live, 2026-10-03: a scheduled run's task title was its content, the host's instruction to the worker.
describe('scheduled runs', () => {
  const machine = 'Scheduled occurrence schedule:daily:26981bdb10765e1bbc529558\nDue: 2026-10-03T01:00:00.000Z\nTime rule: {"kind":"daily","time":"09:00"}\n\nt'
  const run = { id: 'schedule-work-x', action: 'work', status: 'running', content: machine, hostSchedule: { key: 'schedule:daily:26981bdb10765e1bbc529558', scheduleId: 'daily' }, startedAt: iso(-MIN) } as InitiativeAction & { startedAt: string }
  it('are titled by their schedule, not by the instruction to the worker', () => {
    expect(actionTask(ink, run, NOW)?.title).toBe('定时任务「每日检查点」')
    // A schedule deleted since: the task the run was given; nothing to go on: a scheduled task.
    expect(actionTask({ ...ink, schedules: [] }, { ...run, content: machine.replace('\n\nt', '\n\n写今天的日报。\n\nProduce the requested deliverable…') }, NOW)?.title).toBe('定时任务「写今天的日报。」')
    expect(actionTask({ ...ink, schedules: [] }, { ...run, content: 'Scheduled occurrence k' }, NOW)?.title).toBe('定时任务')
    expect(actionTask(ink, { ...run, hostSchedule: undefined, content: '核对移动端截断\n第二行' }, NOW)?.title).toBe('核对移动端截断')
  })
})
