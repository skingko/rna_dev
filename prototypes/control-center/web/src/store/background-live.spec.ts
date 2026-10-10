import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setTransport } from '@/api/client'
import type { EventSourceLike, Transport } from '@/api/transport'
import type { WorkStepEvent } from '@/api/types'
import { MAX_LIVE_ACTIONS, MAX_LIVE_STEPS, recordWorkStep, useBackgroundLive, useRunClock } from './background-live'
import { useApp } from './app-store'
import { startApp } from './sync'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BASE = Date.parse('2026-10-03T10:00:00.000Z')
const step = (n: number, patch: Partial<WorkStepEvent> = {}): WorkStepEvent => ({
  type: 'work.step', projectId: 'p', actionId: 'a1', toolCallId: `c${n}`, name: 'project_read', kind: 'read', target: `f${n}.md`, status: 'running', at: new Date(BASE + n * 1000).toISOString(), ...patch,
})

beforeEach(() => useBackgroundLive.setState({ steps: {} }))

describe('live work steps (P-2)', () => {
  it('keeps the last steps of each action, oldest first, once each', () => {
    for (let n = 1; n <= MAX_LIVE_STEPS + 3; n++) recordWorkStep(step(n))
    recordWorkStep(step(MAX_LIVE_STEPS + 3))
    const rows = useBackgroundLive.getState().steps.a1
    expect(rows).toHaveLength(MAX_LIVE_STEPS)
    expect(rows[0].toolCallId).toBe('c4')
    expect(rows.at(-1)).toMatchObject({ toolCallId: `c${MAX_LIVE_STEPS + 3}`, name: 'project_read', kind: 'read', target: `f${MAX_LIVE_STEPS + 3}.md`, projectId: 'p' })
  })

  it('orders by start time when events arrive out of order', () => {
    recordWorkStep(step(5)); recordWorkStep(step(2))
    expect(useBackgroundLive.getState().steps.a1.map(s => s.toolCallId)).toEqual(['c2', 'c5'])
  })

  it('ignores malformed events', () => {
    recordWorkStep(null)
    recordWorkStep(step(1, { actionId: '' }))
    recordWorkStep(step(1, { toolCallId: '' }))
    recordWorkStep(step(1, { name: '' }))
    recordWorkStep(step(1, { at: 'not a time' }))
    expect(useBackgroundLive.getState().steps).toEqual({})
    recordWorkStep(step(1, { target: null, kind: '' }))
    expect(useBackgroundLive.getState().steps.a1[0]).toMatchObject({ target: null, kind: 'other' })
  })

  it('tracks a bounded number of actions, dropping the least recently active', () => {
    for (let i = 0; i <= MAX_LIVE_ACTIONS; i++) recordWorkStep(step(i, { actionId: `a${i}`, toolCallId: `c${i}` }))
    const ids = Object.keys(useBackgroundLive.getState().steps)
    expect(ids).toHaveLength(MAX_LIVE_ACTIONS)
    expect(ids).not.toContain('a0')
  })
})

class FakeSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  addEventListener(type: string, fn: (ev: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) })) }
}

describe('work.step on the index stream', () => {
  it('routes into the live store', async () => {
    const sources: FakeSource[] = []
    const transport: Transport = {
      kind: 'mock',
      async request<T>(path: string): Promise<T> {
        if (path === '/api/v2/bootstrap') return { protocol: 2, revision: 1, projects: [], sessions: [] } as T
        throw new Error(`unexpected ${path}`)
      },
      openStream() { const s = new FakeSource(); sources.push(s); return s },
    }
    setTransport(transport)
    useApp.setState({ status: 'loading', selectedSessionId: null })
    try { localStorage.removeItem('rna.session') } catch { /* ignore */ }
    await startApp()
    const index = sources[0]
    expect(index.listeners.has('work.step')).toBe(true)
    index.emit('work.step', step(1))
    expect(useBackgroundLive.getState().steps.a1?.map(s => s.toolCallId)).toEqual(['c1'])
  })
})

describe('the panel clock', () => {
  let root: Root, host: HTMLDivElement
  beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

  function Clock({ active }: { active: boolean }) { return createElement('span', null, String(useRunClock(active))) }

  it('ticks only while active and the window is shown', () => {
    vi.setSystemTime(BASE)
    act(() => root.render(createElement(Clock, { active: true })))
    const first = Number(host.textContent)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(Number(host.textContent)).toBeGreaterThanOrEqual(first + 3000)

    // Hidden window: no re-render on ticks.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    const hiddenAt = host.textContent
    act(() => { vi.advanceTimersByTime(3000) })
    expect(host.textContent).toBe(hiddenAt)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })

    act(() => root.render(createElement(Clock, { active: false })))
    const idle = host.textContent
    act(() => { vi.advanceTimersByTime(3000) })
    expect(host.textContent).toBe(idle)
  })
})
