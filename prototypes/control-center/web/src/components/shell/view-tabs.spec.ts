import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { resetSidePanel, useSidePanel } from '@/store/side-panel-store'
import { openSurface, PREF_KEY, resetSurfaceRouter } from '@/store/surface-router'
import { ViewTabs } from './TopBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const transport: Transport = { kind: 'mock', async request<T>(): Promise<T> { throw new ApiError('offline', 503) }, openStream: () => { throw new Error('no streams') } }

beforeAll(() => {
  if (!window.matchMedia) window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList
})

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport)
  resetSidePanel(); resetSurfaceRouter()
  useApp.setState({ status: 'ready', projects: { p: { id: 'p', name: 'P' } }, sessionIndex: { s: { id: 's', title: '会话', status: 'idle', projectId: 'p' } }, sessions: {}, selectedSessionId: 's', selectedProjectId: 'p' })
  useUi.setState({ view: 'chat', sidebarOpen: false, toasts: [] })
  useTasks.setState({ actions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = () => act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(ViewTabs))) })
const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(el => el.textContent === label)!
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const rightClick = (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
const surfaceTabs = () => Object.values(useSidePanel.getState().layout.tabs).filter(row => row.type === 'files' || row.type === 'evolution')

describe('the view tabs open 文件 and 进化 through the surface router (design 4.5)', () => {
  it('a click opens the page, unless a panel already shows it', async () => {
    await render()
    await act(async () => { tab('文件').click() })
    expect(useUi.getState().view).toBe('files')
    await act(async () => { tab('对话').click() })
    expect(useUi.getState().view).toBe('chat')

    openSurface('evolution', 'p')
    await act(async () => { tab('进化').click() })
    expect(useUi.getState().view).toBe('chat')
    expect(useUi.getState().toasts.map(toast => toast.text)).toEqual(['进化已经在侧边面板中显示。'])
  })

  it('right-click: 在侧边面板中打开, and a click opening the panel from then on', async () => {
    await render()
    await rightClick(tab('文件'))
    expect(items().map(item => item.textContent)).toEqual(['在侧边面板中打开', '总是在侧边面板中打开'])
    await act(async () => { items()[0].click() })
    expect(surfaceTabs()).toMatchObject([{ type: 'files', projectId: null }])
    expect(useUi.getState().view).toBe('chat')

    await rightClick(tab('进化'))
    await act(async () => { items().find(item => item.textContent === '总是在侧边面板中打开')!.click() })
    expect(JSON.parse(localStorage.getItem(PREF_KEY)!)).toEqual({ evolution: 'panel' })
    await act(async () => { tab('进化').click() })
    expect(useUi.getState().view).toBe('chat')
    expect(surfaceTabs().map(row => row.type)).toEqual(['files', 'evolution'])
  })

  it('对话 has no menu', async () => {
    await render()
    await rightClick(tab('对话'))
    expect(items()).toEqual([])
  })

  it('a touch long-press names the pressed tab: 对话 never shows the menu left from 文件', async () => {
    await render()
    await rightClick(tab('文件'))
    expect(items()).toHaveLength(2)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(items()).toEqual([])
    const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    Object.defineProperty(press, 'pointerType', { value: 'touch' })
    await act(async () => { tab('对话').dispatchEvent(press) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }) // Radix opens on a 700 ms press
    expect(items()).toEqual([])
  })
})
