// ?mock for the stuck tasks (2026-10-03): revoked failed runs listed as receipts, the task answer route, and plan lines
// marked done / dropped / back through the mind's agenda PATCH, as the host does.
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { ProjectPlan } from '@/api/types'
import { ProjectStore } from './project-routes'
import { MindStore } from './mind-routes'

function stores() {
  const projects = new ProjectStore({ session: () => undefined, broadcastProject: () => {}, setEmergency: () => {} })
  // The mock server's inbox store seeds this before the mind store reads it.
  for (const detail of projects.details.values()) detail.inbox ??= []
  const mind = new MindStore({ detail: id => projects.details.get(id), touch: id => projects.touch(id), emitAll: () => {}, item: () => null })
  const call = (method: string, path: string, body: Record<string, unknown> = {}) => {
    const url = new URL(path, 'http://mock')
    const out = mind.handle(method, url, body)
    return out !== undefined ? out : projects.handle(method, url, body)
  }
  return { projects, call }
}
const refused = (run: () => unknown) => { try { run(); return null } catch (error) { return error as ApiError } }

describe('mock: revoked failed runs and their answers', () => {
  it('lists a revoked run as its receipt — kept name, no content — also when nothing was kept', () => {
    const { call } = stores()
    const { actions } = call('GET', '/api/projects/p-agent/initiative/actions') as { actions: InitiativeAction[] }
    const named = actions.find(row => row.id === 'act-agent-lost-1')!, nameless = actions.find(row => row.id === 'act-agent-lost-2')!
    expect(named).toMatchObject({ revoked: true, status: 'failed', label: '可以，按这个标准重写 1-30 章所有章节，替换原正文', content: '', availableControls: [] })
    expect(nameless).toMatchObject({ revoked: true, label: '', content: '' })
  })

  it('marks an answer, and refuses 接着做 on a run nothing was kept of after marking it', () => {
    const { call } = stores()
    expect(call('POST', '/api/v2/projects/p-agent/tasks/act-agent-lost-1', { choice: 'drop' })).toMatchObject({ choice: 'drop' })
    const error = refused(() => call('POST', '/api/v2/projects/p-agent/tasks/act-agent-lost-2', { choice: 'continue' }))
    expect(error).toMatchObject({ status: 409, code: 'task_context_revoked' })
    expect(refused(() => call('POST', '/api/v2/projects/p-agent/tasks/act-agent-1', { choice: 'acknowledge' }))).toMatchObject({ status: 400 })
    expect(refused(() => call('POST', '/api/v2/projects/p-agent/tasks/nope', { choice: 'drop' }))).toMatchObject({ status: 404, code: 'task_not_found' })
    const { actions } = call('GET', '/api/projects/p-agent/initiative/actions') as { actions: InitiativeAction[] }
    expect(actions.filter(row => row.attention?.acknowledgedAt).map(row => row.id)).toEqual(['act-agent-lost-1', 'act-agent-lost-2'])
  })
})

describe('mock: plan lines through the agenda PATCH', () => {
  const plan = (projects: ProjectStore, id = 'p-agent') => projects.summary(id).plan as ProjectPlan
  const ids = (rows: ProjectPlan['next']) => rows.map(row => row.id)

  it('Rna Agent carries the stale plan from the report', () => {
    const { projects } = stores()
    expect(ids(plan(projects).doing)).toEqual(['pl-agent-1'])
    expect(ids(plan(projects).next)).toEqual(['pl-agent-2', 'pl-agent-3'])
  })

  it('moves a line to done, drops one, and puts one back where it was', () => {
    const { projects, call } = stores()
    expect(call('PATCH', '/api/v2/projects/p-agent/mind/agenda/pl-agent-1', { status: 'done' })).toMatchObject({ entry: { id: 'pl-agent-1', status: 'done' } })
    call('PATCH', '/api/v2/projects/p-agent/mind/agenda/pl-agent-3', { status: 'dropped' })
    expect(ids(plan(projects).doing)).toEqual([])
    expect(ids(plan(projects).next)).toEqual(['pl-agent-2'])
    expect(ids(plan(projects).done)).toEqual(['pl-agent-1'])
    call('PATCH', '/api/v2/projects/p-agent/mind/agenda/pl-agent-3', { status: 'open' })
    call('PATCH', '/api/v2/projects/p-agent/mind/agenda/pl-agent-1', { status: 'open' })
    expect(ids(plan(projects).doing)).toEqual(['pl-agent-1'])
    expect(ids(plan(projects).next)).toEqual(['pl-agent-2', 'pl-agent-3'])
    expect(plan(projects).done).toEqual([])
  })

  it('leaves the mind’s own agenda items and unknown ids as before', () => {
    const { call } = stores()
    expect(refused(() => call('PATCH', '/api/v2/projects/p-agent/mind/agenda/missing', { status: 'done' }))).toMatchObject({ status: 404 })
    expect(call('PATCH', '/api/v2/projects/p-ink/mind/agenda/a-2', { status: 'done' })).toMatchObject({ entry: { id: 'a-2', status: 'done' } })
  })
})
