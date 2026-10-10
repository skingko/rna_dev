// Stuck tasks (2026-10-03): a failed run's answers, plan lines the user settles, and 清理… — all computed in code.
import { describe, expect, it } from 'vitest'
import type { InitiativeAction } from '@/api/project-api'
import type { ProjectPlan } from '@/api/types'
import { actionTask, aggregateTasks, cleanupRows, failedOpen, needsUser, planOpen, planTasks, settlePlan, taskAnswers, taskCounts, type Settling, type TaskProjectInput } from './tasks'
import { backgroundRuns } from './background-runs'

const NOW = new Date('2026-10-03T10:00:00').getTime()
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const HOUR = 3_600_000
const project: TaskProjectInput = { id: 'p', name: '长篇' }

const failed = (patch: Partial<InitiativeAction> = {}): InitiativeAction => ({ id: 'f1', action: 'work', status: 'failed', label: '重写第 3 章', finishedAt: iso(-2 * HOUR), failure: { code: 'tool_timeout' }, availableControls: [], ...patch })
// A run a scope change revoked: the host lists its receipt; `label` is the name it kept for the user (may be empty).
const revoked = (label: string): InitiativeAction => ({ id: 'r1', action: 'work', status: 'failed', revoked: true, label, content: '', receipt: { label, status: 'failed', finishedAt: iso(-3 * 24 * HOUR) }, availableControls: [] })
const entry = (action: InitiativeAction) => actionTask(project, action, NOW, { ended: true })!

describe('a revoked run the host kept no name for (lost)', () => {
  it('is lost only when neither the label nor the receipt names it', () => {
    expect(entry(revoked('')).lost).toBe(true)
    expect(entry(revoked('按这个标准重写 1-30 章')).lost).toBeUndefined()
    expect(entry({ ...revoked(''), receipt: { label: '旧名', status: 'failed' } }).lost).toBeUndefined()
    expect(entry(failed()).lost).toBeUndefined()
  })
})

describe('taskAnswers: what the host takes for a task that waits on the user', () => {
  it('offers 接着做 and 不用了 on a failed run, only 不用了 when nothing is left to carry on', () => {
    expect(taskAnswers(entry(failed()))).toEqual(['continue', 'drop'])
    expect(taskAnswers(entry(revoked('有名字')))).toEqual(['continue', 'drop'])
    expect(taskAnswers(entry(revoked('')))).toEqual(['drop'])
  })

  it('offers nothing once answered, and the right answers for a result to check or to see', () => {
    expect(taskAnswers(entry(failed({ attention: { acknowledgedAt: iso(-HOUR) } })))).toEqual([])
    expect(taskAnswers(entry({ ...failed(), status: 'needs_review' }))).toEqual(['keep', 'drop'])
    expect(taskAnswers(entry({ ...failed(), status: 'completed', attention: { needsUser: true } }))).toEqual(['acknowledge'])
    expect(taskAnswers(entry({ ...failed(), status: 'completed' }))).toEqual([])
  })

  it('failedOpen / planOpen pick what 清理… and the quick actions act on', () => {
    expect(failedOpen(entry(failed()))).toBe(true)
    expect(failedOpen(entry(revoked('')))).toBe(true)
    expect(failedOpen(entry(failed({ attention: { acknowledgedAt: iso(0) } })))).toBe(false)
    expect(failedOpen(entry({ ...failed(), status: 'needs_review' }))).toBe(false)
    const plan = planTasks({ ...project, plan: { doing: [{ id: 'd', text: '复查', status: 'doing' }], next: [], done: [{ id: 'x', text: '旧', status: 'done' }] } }, NOW)
    expect(plan.map(planOpen)).toEqual([true, false])
  })
})

describe('settling: the user’s answer shows at once, everywhere', () => {
  const actions = { p: [failed(), { ...failed(), id: 'rv', status: 'needs_review' }] }
  const key = (id: string) => `p:action:${id}`

  it('reads an answered failed run as handled, so it leaves 需要你', () => {
    const before = aggregateTasks([project], actions, { ended: true }, NOW)
    expect(taskCounts(before).attention).toBe(2)
    const settling: Settling = { [key('f1')]: { kind: 'answer', choice: 'drop', at: iso(0) } }
    const after = aggregateTasks([project], actions, { ended: true, settling }, NOW)
    expect(after.find(task => task.id === 'f1')).toMatchObject({ state: 'failed', flags: ['handled'] })
    expect(taskCounts(after).attention).toBe(1)
  })

  it('reads a result to check as kept or dropped', () => {
    const kept = aggregateTasks([project], actions, { ended: true, settling: { [key('rv')]: { kind: 'answer', choice: 'keep', at: iso(0) } } }, NOW)
    expect(kept.find(task => task.id === 'rv')).toMatchObject({ state: 'done' })
    const dropped = aggregateTasks([project], actions, { ended: true, settling: { [key('rv')]: { kind: 'answer', choice: 'drop', at: iso(0) } } }, NOW)
    expect(dropped.find(task => task.id === 'rv')).toMatchObject({ state: 'cancelled' })
    expect(dropped.filter(needsUser).map(task => task.id)).toEqual(['f1'])
  })

  it('drops the answered run from the 后台任务 panel’s 需要你 too', () => {
    const settling: Settling = { [key('f1')]: { kind: 'answer', choice: 'drop', at: iso(0) } }
    const view = (s?: Settling) => backgroundRuns({ projects: [project], actions, sessions: [], filter: 'all', now: NOW, settling: s })
    expect(view().attention.map(run => run.id).sort()).toEqual(['f1', 'rv'])
    expect(view(settling).attention.map(run => run.id)).toEqual(['rv'])
    expect(view(settling).counts.attention).toBe(1)
  })
})

describe('settlePlan: a plan line leaves the open list at once', () => {
  const plan: ProjectPlan = {
    doing: [{ id: 'a', text: 'prose_review → prose_patch ≤6处 → 复查', status: 'doing', updatedAt: iso(-72 * HOUR) }],
    next: [{ id: 'b', text: '如实计字 → 原子替换正文文件', status: 'next', updatedAt: iso(-48 * HOUR) }],
    done: [],
  }
  const lines = planTasks({ ...project, plan }, NOW)
  const since = (id: string) => lines.find(line => line.id === id)!.at

  it('reads a line marked done as 已完成 and removes a dropped one', () => {
    const settling: Settling = {
      'p:plan:a': { kind: 'plan', status: 'done', since: since('a'), at: NOW },
      'p:plan:b': { kind: 'plan', status: 'dropped', since: since('b'), at: NOW },
    }
    const out = settlePlan(lines, settling, NOW)
    expect(out.map(line => [line.id, line.state, line.stateLabel])).toEqual([['a', 'done', '已完成']])
    expect(out[0]).toMatchObject({ at: NOW, when: '刚刚' })
  })

  it('lets the summary win once the line changed there, and leaves other entries alone', () => {
    const settling: Settling = { 'p:plan:b': { kind: 'plan', status: 'dropped', since: since('b')! - 1000, at: NOW } }
    expect(settlePlan(lines, settling, NOW)).toEqual(lines)
    expect(settlePlan(lines, {}, NOW)).toBe(lines)
  })
})

describe('cleanupRows: what 清理… lists', () => {
  it('lists failed runs still waiting on the user and the plan’s open lines, nothing else', () => {
    const plan: ProjectPlan = { doing: [{ id: 'a', text: '正在做', status: 'doing' }], next: [{ id: 'b', text: '接下来', status: 'next', interruptedAt: iso(-HOUR) } as ProjectPlan['next'][number]], done: [{ id: 'c', text: '做完', status: 'done' }] }
    const tasks = [
      ...aggregateTasks([project], { p: [failed(), revoked(''), failed({ id: 'seen', attention: { acknowledgedAt: iso(0) } }), { ...failed(), id: 'rv', status: 'needs_review' }, { ...failed(), id: 'run', status: 'running' }] }, { ended: true }, NOW),
      ...planTasks({ ...project, plan }, NOW),
    ]
    const rows = cleanupRows(tasks)
    expect(rows.actions.map(row => row.id)).toEqual(['f1', 'r1'])
    expect(rows.plan.map(row => [row.id, row.stateLabel])).toEqual([['a', '正在做'], ['b', '上次停在这里']])
  })

  it('keeps each project’s plan together, in the plan’s order (全部项目 lists several)', () => {
    const plan = (prefix: string): ProjectPlan => ({ doing: [{ id: `${prefix}1`, text: '正在做', status: 'doing' }], next: [{ id: `${prefix}2`, text: '接下来', status: 'next' }], done: [] })
    const tasks = [...planTasks({ id: 'z', name: '后排', plan: plan('z') }, NOW), ...planTasks({ id: 'a', name: '前排', plan: plan('a') }, NOW)]
    expect(cleanupRows(tasks).plan.map(row => row.id)).toEqual(['z1', 'z2', 'a1', 'a2'])
  })
})
