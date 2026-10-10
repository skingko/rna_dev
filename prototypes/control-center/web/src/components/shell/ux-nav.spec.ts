import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import App from '@/App'
import { SEARCH_INPUT_ID } from './Sidebar'
import { TopBar, ViewTabs } from './TopBar'
import { InboxBell } from './InboxBell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const transport: Transport = {
  kind: 'mock',
  async request<T>(): Promise<T> { throw new ApiError('offline', 503) },
  openStream: () => { throw new Error('no streams') },
}

beforeAll(() => {
  if (!window.matchMedia) window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList
})

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport)
  useApp.setState({ status: 'ready', projects: { p: { id: 'p', name: 'P' } }, sessionIndex: {}, sessions: {}, selectedSessionId: null, selectedProjectId: 'p' })
  useUi.setState({ view: 'chat', sidebarOpen: false })
  useTasks.setState({ actions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (element: Parameters<typeof createElement>[0]) => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(element))) })
}

describe('top bar progress signs (UX audit F45)', () => {
  it('shows 项目在后台工作 while the initiative runtime is working', async () => {
    await render(TopBar)
    expect(host.textContent).not.toContain('项目在后台工作')
    await act(async () => { useApp.setState({ projects: { p: { id: 'p', name: 'P', initiativeRuntime: { status: 'working' } } } }) })
    expect(host.textContent).toContain('项目在后台工作')
  })

  it('marks 进化 while a learn action runs', async () => {
    await render(ViewTabs)
    expect(host.querySelector('[aria-label="进化进行中"]')).toBeNull()
    await act(async () => { useTasks.setState({ actions: { p: [{ id: 'l1', action: 'learn', status: 'running' }] } }) })
    expect(host.querySelector('[aria-label="进化进行中"]')).not.toBeNull()
    await act(async () => { useTasks.setState({ actions: { p: [{ id: 'l1', action: 'learn', status: 'completed' }, { id: 'w1', action: 'work', status: 'running' }] } }) })
    expect(host.querySelector('[aria-label="进化进行中"]')).toBeNull()
  })
})

describe('the bell leaves archived conversations to the inbox (UX audit F55, round 2)', () => {
  it('lists unread entries of live conversations and says how many archived ones it left out', async () => {
    const at = '2026-10-03T10:00:00.000Z'
    const entry = (id: string, sessionId: string, text: string) => ({ id, kind: 'share', tier: 'inline', text, createdAt: at, status: 'unread', feedback: null, sessionId, itemId: `i-${id}` })
    setTransport({
      kind: 'mock',
      async request<T>(path: string): Promise<T> {
        if (path.startsWith('/api/v2/projects/p/inbox?')) return { projectId: 'p', unread: 2, total: 2, entries: [entry('e1', 's-live', '第 3 章写好了'), entry('e2', 's-arch', '旧对话里的消息')] } as T
        throw new ApiError('offline', 503)
      },
      openStream: () => { throw new Error('no streams') },
    })
    useApp.setState({
      projects: { p: { id: 'p', name: 'P', counts: { inbox: 2, inboxUnread: 2 } } },
      sessionIndex: { 's-live': { id: 's-live', title: 'live', status: 'idle', projectId: 'p' }, 's-arch': { id: 's-arch', title: 'old', status: 'idle', projectId: 'p', archivedAt: at } },
    })
    await render(InboxBell)
    await act(async () => { host.querySelector('button')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const popover = document.body.textContent ?? ''
    expect(popover).toContain('第 3 章写好了')
    expect(popover).not.toContain('旧对话里的消息')
    expect(popover).toContain('另有 1 条来自已归档的对话，在收件箱里查看。')
  })
})

describe('⌘K inside the terminal (UX audit C5)', () => {
  it('leaves the key to the terminal and still focuses search elsewhere', async () => {
    // Loading (then the offline error page): the shell and its shortcuts without the conversation.
    useApp.setState({ status: 'loading', selectedProjectId: null, projects: {} })
    await act(async () => { root.render(createElement(App)) })
    const terminal = document.createElement('div')
    terminal.setAttribute('data-terminal-host', '')
    const input = document.createElement('textarea')
    terminal.append(input); document.body.append(terminal)
    try {
      const inside = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
      input.focus(); input.dispatchEvent(inside)
      expect(inside.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(input)
      const outside = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(outside)
      expect(outside.defaultPrevented).toBe(true)
      expect(document.activeElement?.id).toBe(SEARCH_INPUT_ID)
    } finally { terminal.remove() }
  })
})
