// UX audit 2026-10-03, round 2 (C-e): a finished result marked 需要你 is settled from the task's own menu too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import type { TaskEntry } from '@/lib/tasks'
import { useTasks } from '@/store/tasks-store'
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/overlays'
import { TaskMenuItems } from './task-parts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calls: string[] = []
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    return (path.endsWith('/initiative/actions') ? { projectId: 'p', actions: [] } : { revision: 1 }) as T
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); calls.length = 0
  useTasks.setState({ actions: {}, busy: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const task = (patch: Partial<TaskEntry>): TaskEntry => ({
  key: 'p:action:a1', projectId: 'p', projectName: 'P', kind: 'action', actionKind: 'work', id: 'a1', title: '核对第 9 章', label: '自主执行',
  state: 'done', stateLabel: '已完成', when: '', at: null, controls: [], flags: [], ...patch,
})
const menu = async (entry: TaskEntry) => {
  await act(async () => {
    root.render(createElement(Tooltip.Provider, null, createElement(Menu, { open: true }, createElement(MenuTrigger, null, '…'), createElement(MenuContent, null, createElement(TaskMenuItems, { task: entry })))))
  })
  return [...document.querySelectorAll('[role="menuitem"]')]
}

describe('知道了 in the task menu', () => {
  it('a done result marked 需要你 offers 知道了, which acknowledges it and re-reads the actions', async () => {
    const items = await menu(task({ flags: ['attention'] }))
    const seen = items.find(item => item.textContent === '知道了')
    expect(seen).toBeDefined()
    await act(async () => { (seen as HTMLElement).click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(calls).toContain('POST /api/v2/projects/p/tasks/a1 {"choice":"acknowledge"}')
    expect(calls.at(-1)).toBe('GET /api/projects/p/initiative/actions')
  })

  it('a done result without the mark has no 知道了', async () => {
    const items = await menu(task({ flags: ['fresh'] }))
    expect(items.map(item => item.textContent)).not.toContain('知道了')
  })
})
