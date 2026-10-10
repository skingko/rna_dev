// B9 review: a conversation is held from its tail window, so a scheduled delivery older than it is read from the host
// (by the item the occurrence names, else the line it posted), never reported as deleted.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import type { Item } from '@/api/types'
import type { TaskEntry } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { createSlice } from '@/store/session-model'
import { ScheduleInspector } from './task-inspectors'
import { invalidateProject } from './useProjectDetail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const schedule = { id: 'sch', title: '每日总结', task: '总结今天', enabled: true, destinationSessionId: 's1', rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } }
const delivery: Item = { id: 'd1', kind: 'assistant', text: '上周的每日总结正文', createdAt: '2026-09-28T09:00:05Z', source: 'initiative', initiative: { kind: 'scheduled' }, scheduleId: 'sch', scheduleOccurrenceKey: 'occ-1', projectId: 'p' } as unknown as Item
const occurrence = (patch = {}) => ({ key: 'occ-1', scheduleId: 'sch', scheduledAt: '2026-09-28T09:00:00Z', status: 'delivered', deliveredAt: '2026-09-28T09:00:05Z', deliveryItemId: 'd1', ...patch })
const task: TaskEntry = { key: 'schedule:p:sch', projectId: 'p', projectName: 'P', kind: 'schedule', id: 'sch', title: '每日总结', label: '定时任务', state: 'scheduled', stateLabel: '', when: '', at: null, controls: [] } as unknown as TaskEntry

let requests: string[] = [], occ = occurrence()
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string): Promise<T> {
    requests.push(path)
    const url = new URL(path, 'http://x')
    if (url.pathname === '/api/v2/projects/p') return { id: 'p', name: 'P', schedules: [schedule], scheduleRuntime: { occurrences: [occ] } } as T
    if (url.pathname === '/api/projects/p/schedules') return { schedules: [schedule], occurrences: [occ] } as T
    if (url.pathname === '/api/v2/sessions/s1/items/d1') return { revision: 9, sessionId: 's1', item: delivery } as T
    if (url.pathname === '/api/v2/sessions/s1/locate' && url.searchParams.get('occurrenceKey') === 'occ-1') return { revision: 9, sessionId: 's1', itemId: 'd1' } as T
    throw new ApiError('条目不存在', 404)
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); invalidateProject('p'); requests = []; occ = occurrence()
  // The destination conversation is open, held from its tail window: last week's delivery is older than it.
  const tail = createSlice({ id: 's1', title: '项目讨论', status: 'idle', projectId: 'p', revision: 9, items: [{ id: 'u9', kind: 'user', text: 'now', createdAt: '2026-10-05T00:00:00Z' } as Item], turns: [], window: { totalCount: 900, firstItemId: 'u0', hasMore: true } } as never)
  useApp.setState({ status: 'ready', mode: 'v2', projects: {}, sessionIndex: { s1: { id: 's1', title: '项目讨论', status: 'idle', projectId: 'p' } }, sessions: { s1: tail } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async () => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(ScheduleInspector, { task, occurrenceKey: 'occ-1', onOpenDelivery: () => {}, onRemoved: () => {} }))) })
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const page = () => document.body.textContent ?? ''

describe('the delivered-result reader (B9 review)', () => {
  it('reads a delivery older than the window by the item the occurrence names', async () => {
    await render()
    expect(page()).toContain('上周的每日总结正文')
    expect(page()).not.toContain('这次交付的原始内容已删除或无法关联')
    expect(requests).toContain('/api/v2/sessions/s1/items/d1')
    expect(requests.some(path => path.includes('window=tail'))).toBe(false)
  })

  it('without an item id, finds the line the occurrence posted', async () => {
    occ = occurrence({ deliveryItemId: null })
    await render()
    expect(page()).toContain('上周的每日总结正文')
    expect(requests).toContain('/api/v2/sessions/s1/locate?occurrenceKey=occ-1')
  })

  it('still says so when the host has no such delivery', async () => {
    occ = occurrence({ deliveryItemId: 'gone' })
    await render()
    expect(page()).toContain('这次交付的原始内容已删除或无法关联')
  })
})
