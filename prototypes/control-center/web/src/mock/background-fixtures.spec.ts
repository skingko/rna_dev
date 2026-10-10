import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InitiativeAction } from '@/api/project-api'
import type { ProjectPlan, Session, SessionSummary, WorkStepEvent } from '@/api/types'
import { backgroundRuns, type RunProjectInput } from '@/lib/background-runs'
import { mockAgentsSummary, mockPlan, mockWork, researchAgents, startMockWorkSteps } from './background-fixtures'
import { ProjectStore } from './project-routes'
import { initialSessions } from './fixtures'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
afterEach(() => { vi.useRealTimers() })

describe('mock background progress', () => {
  it('projects live runs and the last day’s finished work from the action rows', () => {
    const work = mockWork('p-ink', [
      { id: 'act-work-1', action: 'work', status: 'running', content: '核对', startedAt: ago(5 * 60_000) },
      { id: 'q', action: 'work', status: 'queued', content: '排队' },
      { id: 'share', action: 'share', status: 'completed', content: '分享', finishedAt: ago(60_000) },
      { id: 'old', action: 'work', status: 'failed', content: '旧', finishedAt: ago(2 * 86_400_000), failure: { code: 'tool_timeout' } },
      { id: 'act-work-3', action: 'work', status: 'completed', content: '复核', finishedAt: ago(2 * 3_600_000) },
    ])
    expect(work.running.map(run => [run.id, run.status])).toEqual([['act-work-1', 'running'], ['q', 'queued']])
    expect(work.running[0]).toMatchObject({ steps: { completed: 23, failed: 1, limit: 64 }, tokens: { total: 18_200 }, changeId: 'bg-1', latest: { name: 'project_edit' } })
    // This morning's scheduled run comes first; the run from two days ago and the sent share are left out.
    expect(work.recent.map(run => [run.id, run.kind])).toEqual([['act-sched-1', 'scheduled'], ['act-work-3', 'work']])
    expect(work.recent[1].summary).toContain('52fps')
    expect(mockWork('p-agent', []).recent).toEqual([])
  })

  it('ties plan items to the run that staged or resolved them, once', () => {
    const plan: ProjectPlan = { doing: [{ id: 'pl1', text: 'a', status: 'doing' }], next: [{ id: 'pl3', text: 'b', status: 'next' }], done: [{ id: 'pl0', text: 'c', status: 'done' }] }
    const tagged = mockPlan(plan)!
    expect(tagged.doing[0].actionId).toBe('act-work-1')
    expect(tagged.next[0].actionId).toBe('act-work-2')
    expect(tagged.done.map(row => [row.id, row.actionId])).toEqual([['pl-a', 'act-work-1'], ['pl-b', 'act-work-1'], ['pl0', 'act-work-3']])
    expect(mockPlan(tagged)!.done).toHaveLength(3)
    expect(mockPlan(null)).toBeNull()
  })

  it('summarizes a session’s subagents from its items', () => {
    const items = researchAgents()
    expect(items.every(item => item.kind === 'subagent' && item.subagent?.turnId === 't-res-1')).toBe(true)
    expect(mockAgentsSummary({ items })).toEqual({ running: 2, total: 5, tokens: 37_300, latestTurnId: 't-res-1' })
    expect(mockAgentsSummary({ items: [] })).toBeUndefined()
  })

  it('emits live steps for the running work only while it runs', () => {
    vi.useFakeTimers()
    const events: WorkStepEvent[] = []
    let running = true
    const stop = startMockWorkSteps(event => events.push(event), () => running, { everyMs: 1000 })
    vi.advanceTimersByTime(2000)
    running = false
    vi.advanceTimersByTime(3000)
    stop()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'work.step', projectId: 'p-ink', actionId: 'act-work-1', status: 'running', name: 'project_read' })
    expect(new Set(events.map(event => event.toolCallId)).size).toBe(2)
  })

  it('?mock shows running, queued and finished runs and a subagent group', () => {
    const store = new ProjectStore({ session: () => undefined, broadcastProject: () => {}, setEmergency: () => {} })
    const projects = ['p-ink', 'p-agent'].map(id => store.summary(id)) as unknown as RunProjectInput[]
    expect(projects[0].work?.running.map(run => run.id)).toEqual(['act-work-1', 'act-work-2'])
    const actions = Object.fromEntries(['p-ink', 'p-agent'].map(id => [id, ((store.details.get(id)!.initiativeRuntime as { sdkState: { actions: InitiativeAction[] } }).sdkState.actions)]))
    const sessions: SessionSummary[] = initialSessions().map((session: Session) => {
      const items = session.id === 's-research' ? [...session.items, ...researchAgents()] : session.items
      return { id: session.id, title: session.title, status: session.status, projectId: session.projectId, lastItemAt: items.at(-1)?.createdAt, agents: mockAgentsSummary({ items }) ?? null }
    })
    const view = backgroundRuns({ projects, actions, sessions, filter: 'all' })
    expect(view.running.map(run => run.id)).toEqual(expect.arrayContaining(['act-work-1', 'act-work-2', 's-research']))
    expect(view.running.find(run => run.id === 'act-work-1')!.phase.plan).toEqual({ done: 2, total: 4 })
    expect(view.upcoming.map(run => run.id)).toEqual(expect.arrayContaining(['act-agent-1', 'sch-daily', 'sch-deps']))
    expect(view.finished.map(run => run.id)).toEqual(expect.arrayContaining(['act-sched-1', 'act-work-3']))
  })
})
