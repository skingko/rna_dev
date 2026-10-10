import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import type { ProjectSummary } from '@/api/types'
import { besideMain, getGroup, groupIds, MAIN, tabGroupId } from '@/lib/dock'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { findTab, openTab, resetSidePanel, setContext, undoLayout, useSidePanel, type SideTab } from '@/store/side-panel-store'
import { resetSurfaceRouter } from '@/store/surface-router'
import { resetGitStatus } from '@/lib/workspace-changes'
import { tabTitle } from '@/components/side-panel/tab-meta'
import { CARD_GAP } from './cells'
import { HOVER_CLOSE_DELAY, HOVER_OPEN_DELAY } from './hover-menu'
import { LayoutMenu } from './strip-menus'
import { groupActions, surfaceActions, type LayoutAction } from './menus'
import './panels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

// jsdom measures nothing: the workspace reports this container size.
const container = { width: 1400, height: 900 }
class FixedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() { this.callback([{ contentRect: { ...container } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
  unobserve() {}
  disconnect() {}
}

const transport: Transport = {
  kind: 'live',
  async request<T>(path: string): Promise<T> {
    if (path.includes('/git')) return { repo: 'none', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } as T
    if (path.includes('/preview')) return { status: 'stopped' } as T
    if (path.includes('/genes')) return { projectId: 'p1', strands: [], generations: [], generation: { n: 0 } } as T
    return { path: '', entries: [] } as T
  },
  openStream() { throw new Error('unused') },
}
const project = (id: string, name: string) => ({ id, name, workspacePath: `/w/${id}` }) as ProjectSummary

let WorkspaceHost: typeof import('./WorkspaceHost').WorkspaceHost
beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', FixedResizeObserver)
  ;({ WorkspaceHost } = await import('./WorkspaceHost'))
})

let root: Root, host: HTMLDivElement, previous: Transport
// An hour past the previous test's menus: each test starts with the full open delay.
let clock = Date.now()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  clock += 3_600_000
  vi.setSystemTime(clock)
  previous = getTransport(); setTransport(transport)
  resetSidePanel(); resetSurfaceRouter(); resetGitStatus()
  useApp.setState({
    status: 'ready', projects: { p1: project('p1', '水墨飞鸟'), p2: project('p2', 'Rna Agent') }, projectOrder: ['p1', 'p2'], sessions: {},
    sessionIndex: { s1: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' } } as never, selectedSessionId: 's1', selectedProjectId: 'p1',
    capabilities: { sideChat: true, terminal: 'pty' } as never,
  })
  setContext({ sessionId: 's1', projectId: 'p1' })
  useUi.setState({ view: 'chat', toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); setTransport(previous)
  vi.useRealTimers()
})

const settle = async (ms = 0) => { await act(async () => { vi.advanceTimersByTime(ms) }); await act(async () => { await Promise.resolve() }) }
const render = async (node: ReactNode = createElement(WorkspaceHost, { mobile: false, children: createElement('div', { 'data-conversation': '', tabIndex: 0 }, 'chat') })) => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) })
  await settle()
}
const run = async (fn: () => void) => { await act(async () => { fn() }); await settle() }
const layout = () => useSidePanel.getState().layout

const wrapper = (name: 'layout' | 'new-tab', groupId?: string) =>
  host.querySelector<HTMLElement>(`${groupId ? `[data-group-strip="${groupId}"] ` : ''}span[data-hover-menu="${name}"]`)!
const buttonOf = (name: 'layout' | 'new-tab', groupId?: string) => wrapper(name, groupId).querySelector<HTMLButtonElement>('button:not([data-hover-affordance])')!
const menu = (name: 'layout' | 'new-tab') => document.querySelector<HTMLElement>(`[role="menu"][data-hover-menu="${name}"]`)
const items = (name: 'layout' | 'new-tab') => [...(menu(name)?.querySelectorAll<HTMLElement>('[data-hover-item]') ?? [])]
const item = (name: 'layout' | 'new-tab', label: string) => items(name).find(el => el.getAttribute('aria-label') === label || el.textContent?.includes(label))!

// React derives enter / leave from over / out with the element the pointer came from or goes to.
const pointer = (type: 'pointerover' | 'pointerout', target: Element, other: Element, pointerType = 'mouse') =>
  run(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: other })) })
const enter = (target: Element, pointerType = 'mouse') => pointer('pointerover', target, document.body, pointerType)
const leave = (target: Element) => pointer('pointerout', target, document.body)
const key = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

/** One group beside the conversation holding a page (or `input`); its id. */
async function oneGroup(input: Parameters<typeof openTab>[0] = { type: 'browser', url: 'http://localhost:1/' }) {
  const tab = openTab(input)
  await render()
  return tabGroupId(layout(), tab)
}

describe('the maximize button’s hover menu (after Claude’s layout popover)', () => {
  it('opens after a pause on the button, stays while the pointer is on the button or the menu, and closes after it leaves', async () => {
    await oneGroup()
    await enter(buttonOf('layout'))
    await settle(HOVER_OPEN_DELAY - 50)
    expect(menu('layout')).toBeNull()
    await settle(60)
    expect(menu('layout')).not.toBeNull()
    expect(document.activeElement).toBe(document.body) // hovering never takes the keyboard

    // Across to the menu: it stays.
    await leave(buttonOf('layout'))
    await enter(menu('layout')!)
    await settle(HOVER_CLOSE_DELAY * 3)
    expect(menu('layout')?.dataset.state).toBe('open')
    // Back on the button, then off both: it closes shortly after.
    await leave(menu('layout')!)
    await enter(buttonOf('layout'))
    await settle(HOVER_CLOSE_DELAY * 3)
    expect(menu('layout')?.dataset.state).toBe('open')
    await leave(buttonOf('layout'))
    await settle(HOVER_CLOSE_DELAY - 50)
    expect(menu('layout')?.dataset.state).toBe('open')
    await settle(100)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
  })

  it('lists 移动 (the group’s side marked) and 填充并排列, and no 在新窗口打开 without a desktop pop-out', async () => {
    await oneGroup()
    await enter(buttonOf('layout'))
    await settle(HOVER_OPEN_DELAY)
    const groups = [...menu('layout')!.querySelectorAll('[role="group"]')].map(group => group.textContent)
    expect(groups).toEqual(['移动', '填充并排列'])
    expect(items('layout').map(el => [el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('aria-checked')])).toEqual([
      ['menuitemradio', '移到对话左侧', 'false'],
      ['menuitemradio', '移到对话右侧', 'true'],
      ['menuitemradio', '移到对话上方', 'false'],
      ['menuitemradio', '移到对话下方', 'false'],
      ['menuitemcheckbox', '最大化此组', 'false'],
      ['menuitem', '填充并排列', null],
    ])
    expect(menu('layout')!.textContent).not.toContain('在新窗口打开')
  })

  it('clicking the button itself still maximizes and restores, and puts the menu away', async () => {
    const group = await oneGroup()
    await enter(buttonOf('layout'))
    await settle(HOVER_OPEN_DELAY)
    expect(menu('layout')).not.toBeNull()
    await run(() => buttonOf('layout').click())
    expect(layout().maximizedGroup).toBe(group)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
    await run(() => buttonOf('layout').click())
    expect(layout().maximizedGroup).toBeNull()
    // A press on the button before the pause is over is a click, not a hover: no menu follows it.
    await enter(buttonOf('layout'))
    await run(() => { buttonOf('layout').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })) })
    await settle(HOVER_OPEN_DELAY * 2)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
  })

  it('moves the group to a side of the conversation, maximizes it, or arranges every group; each is undone like any layout change', async () => {
    const group = await oneGroup()
    const open = async () => { await enter(buttonOf('layout', group)); await settle(HOVER_OPEN_DELAY) }

    await open()
    await run(() => item('layout', '移到对话左侧').click())
    expect(besideMain(layout(), group, 'left')).toBe(true)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
    // The menu marks the new side.
    await leave(buttonOf('layout', group)); await settle(1000)
    await open()
    expect(item('layout', '移到对话左侧').getAttribute('aria-checked')).toBe('true')
    await run(() => { undoLayout() })
    expect(besideMain(layout(), group, 'right')).toBe(true)

    await leave(buttonOf('layout', group)); await settle(1000)
    await open()
    await run(() => item('layout', '最大化此组').click())
    expect(layout().maximizedGroup).toBe(group)
    await leave(buttonOf('layout', group)); await settle(1000)
    await open()
    expect(item('layout', '还原此组').getAttribute('aria-checked')).toBe('true')
    // Moving a maximized group brings it back beside the conversation, on that side.
    await run(() => item('layout', '移到对话下方').click())
    expect(layout().maximizedGroup).toBeNull()
    expect(besideMain(layout(), group, 'bottom')).toBe(true)

    const page2 = openTab({ type: 'browser', url: 'http://localhost:2/' }, { target: { edge: 'top', of: MAIN } })
    await settle()
    const before = useSidePanel.getState().history.cursor
    await leave(buttonOf('layout', group)); await settle(1000)
    await open()
    await run(() => item('layout', '填充并排列').click())
    expect(useSidePanel.getState().history.cursor).toBe(before + 1)
    expect(groupIds(layout())).toHaveLength(2)
    expect(tabGroupId(layout(), page2)).not.toBe(MAIN)
    await run(() => { undoLayout() })
    expect(useSidePanel.getState().history.cursor).toBe(before)
  })

  it('opens from the keyboard with focus inside, moves with the arrows, and Esc closes it without hiding the panels', async () => {
    await oneGroup({ type: 'tasks' }) // not a page, which would keep Esc anyway
    const button = buttonOf('layout')
    button.focus()
    await run(() => { expect(key(button, { key: 'ArrowDown' }).defaultPrevented).toBe(true) })
    expect(menu('layout')).not.toBeNull()
    expect(document.activeElement).toBe(item('layout', '移到对话左侧'))
    await run(() => { key(document.activeElement!, { key: 'ArrowRight' }) })
    expect(document.activeElement).toBe(item('layout', '移到对话右侧'))
    await run(() => { key(document.activeElement!, { key: 'End' }) })
    expect(document.activeElement).toBe(item('layout', '填充并排列'))
    await run(() => { key(document.activeElement!, { key: 'ArrowDown' }) })
    expect(document.activeElement).toBe(item('layout', '移到对话左侧')) // wraps around

    await run(() => { expect(key(document.activeElement!, { key: 'Escape' }).defaultPrevented).toBe(true) })
    await settle(500)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
    expect(document.activeElement).toBe(button)
    expect(layout().collapsed).toBe(false)
    // Esc on the button itself (no menu) is the workspace's again: the panels hide.
    await run(() => { key(button, { key: 'Escape' }) })
    expect(layout().collapsed).toBe(true)
  })

  it('however it closes with focus inside — the pointer passing out of a menu opened from the keyboard, an item clicked — the button gets the keyboard back', async () => {
    await oneGroup({ type: 'tasks' })
    const button = buttonOf('layout')
    button.focus()
    await run(() => { key(button, { key: 'ArrowDown' }) })
    expect(document.activeElement).toBe(item('layout', '移到对话左侧'))
    // The mouse wanders over the menu and away while the keyboard is in it: the menu closes, focus is not dropped.
    await enter(menu('layout')!)
    await leave(menu('layout')!)
    await settle(HOVER_CLOSE_DELAY + 50)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
    expect(document.activeElement).toBe(button)

    // Opened by hover and an item clicked (which focuses it, as Chromium does): focus goes back to the button too.
    button.blur()
    await settle(1000)
    await enter(button)
    await settle(HOVER_OPEN_DELAY)
    const fill = item('layout', '填充并排列')
    fill.focus()
    await run(() => fill.click())
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')
    expect(document.activeElement).toBe(buttonOf('layout'))
  })

  it('the marked side is where the group already is: picking it changes nothing (a maximized group is only restored)', async () => {
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const first = tabGroupId(layout(), page)
    // A second group below the first: both are right of the conversation, the second not directly beside it.
    const other = openTab({ type: 'browser', url: 'http://localhost:2/' }, { target: { edge: 'bottom', of: first } })
    const second = tabGroupId(layout(), other)
    await render()
    expect(besideMain(layout(), second, 'right')).toBe(false)
    const open = async () => { await leave(buttonOf('layout', second)); await settle(1000); await enter(buttonOf('layout', second)); await settle(HOVER_OPEN_DELAY) }
    await open()
    expect(item('layout', '移到对话右侧').getAttribute('aria-checked')).toBe('true')
    const shape = JSON.stringify(layout().nodes)
    const cursor = useSidePanel.getState().history.cursor
    await run(() => item('layout', '移到对话右侧').click())
    expect(JSON.stringify(layout().nodes)).toBe(shape)
    expect(useSidePanel.getState().history.cursor).toBe(cursor)
    expect(menu('layout')?.dataset.state ?? 'closed').toBe('closed')

    await run(() => buttonOf('layout', second).click())
    expect(layout().maximizedGroup).toBe(second)
    await open()
    await run(() => item('layout', '移到对话右侧').click())
    expect(layout().maximizedGroup).toBeNull()
    expect(JSON.stringify(layout().nodes)).toBe(shape)
  })

  it('the menu affordance (a split button’s second half, shown when tabbed to) opens it too; touch does not', async () => {
    await oneGroup()
    const affordance = wrapper('layout').querySelector<HTMLButtonElement>('[data-hover-affordance]')!
    expect(affordance.getAttribute('aria-haspopup')).toBe('menu')
    expect(affordance.getAttribute('aria-label')).toBe('布局选项')
    expect(affordance.getAttribute('aria-expanded')).toBe('false')
    await enter(buttonOf('layout'), 'touch')
    await settle(HOVER_OPEN_DELAY * 2)
    expect(menu('layout')).toBeNull()
    affordance.focus()
    await run(() => affordance.click())
    expect(affordance.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(item('layout', '移到对话左侧'))
    expect(affordance.getAttribute('aria-controls')).toBe(menu('layout')!.id)
    // Tab leaves the menu for the button, closing it.
    await run(() => { key(document.activeElement!, { key: 'Tab' }) })
    await settle(500)
    expect(document.activeElement).toBe(buttonOf('layout'))
    expect(affordance.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers 在新窗口打开 only where the desktop shell can pop a group out', async () => {
    let popped = 0, done = 0
    await render(createElement(LayoutMenu, { groupId: 'g', edge: 'right', maximized: false, onDone: () => { done += 1 } }))
    expect(host.textContent).not.toContain('在新窗口打开')
    await render(createElement(LayoutMenu, { groupId: 'g', edge: 'right', maximized: false, onDone: () => { done += 1 }, onOpenInWindow: () => { popped += 1 } }))
    const row = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === '在新窗口打开')!
    await run(() => row.click())
    expect([popped, done]).toEqual([1, 1])
  })
})

describe('the “+” button’s hover menu', () => {
  it('lists the chooser’s kinds of tab with its rules, and opens the chosen one into this group; “+” itself still opens the chooser', async () => {
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const first = tabGroupId(layout(), page)
    const other = openTab({ type: 'browser', url: 'http://localhost:2/' }, { target: { edge: 'bottom', of: first } })
    const second = tabGroupId(layout(), other)
    await render()
    expect(layout().activeGroup).toBe(second)

    await enter(buttonOf('new-tab', first))
    await settle(HOVER_OPEN_DELAY)
    expect(items('new-tab').map(el => el.dataset.newTab)).toEqual(['side-chat', 'review', 'terminal', 'browser', 'tasks', 'files', 'worktree', 'evolution'])
    expect(items('new-tab').map(el => el.textContent)).toEqual(['辅助对话', '审查', '终端', '浏览器', '后台任务', '文件', '工作区改动', '进化'])
    expect(items('new-tab').every(el => el.querySelector('svg'))).toBe(true) // the launcher's icons
    await run(() => item('new-tab', '文件').click())
    const [files] = Object.values(layout().tabs).filter(tab => tab.type === 'files')
    expect(files).toMatchObject({ projectId: null })
    expect(tabGroupId(layout(), files.id)).toBe(first) // into the group whose “+” it was, not the focused one
    expect(menu('new-tab')?.dataset.state ?? 'closed').toBe('closed')

    // “+” itself: the chooser tab, as before.
    await run(() => buttonOf('new-tab', first).click())
    const launcher = Object.values(layout().tabs).find(tab => tab.type === 'launcher')!
    expect(tabGroupId(layout(), launcher.id)).toBe(first)
    expect(getGroup(layout(), first).tabIds).toContain(launcher.id)
  })

  it('moving straight from one hover menu to the next opens it at once and puts the first away', async () => {
    await oneGroup()
    await enter(buttonOf('new-tab'))
    await settle(HOVER_OPEN_DELAY)
    expect(menu('new-tab')?.dataset.state).toBe('open')
    await leave(buttonOf('new-tab'))
    await enter(buttonOf('layout'))
    expect(menu('layout')?.dataset.state).toBe('open')
    expect(menu('new-tab')?.dataset.state ?? 'closed').toBe('closed')
    // Once both are away for a while, the pause is back.
    await leave(buttonOf('layout'))
    await settle(2000)
    await enter(buttonOf('new-tab'))
    expect(menu('new-tab')?.dataset.state ?? 'closed').toBe('closed')
    await settle(HOVER_OPEN_DELAY)
    expect(menu('new-tab')?.dataset.state).toBe('open')
  })

  it('kinds that need a conversation or a project are offered but cannot open, saying why', async () => {
    useApp.setState({ selectedSessionId: null, selectedProjectId: null })
    setContext({ sessionId: null, projectId: null })
    await oneGroup()
    buttonOf('new-tab').focus()
    await run(() => { key(buttonOf('new-tab'), { key: 'ArrowDown' }) })
    const disabled = items('new-tab').filter(el => el.getAttribute('aria-disabled') === 'true').map(el => el.dataset.newTab)
    expect(disabled).toEqual(['side-chat', 'review', 'terminal', 'files', 'worktree', 'evolution'])
    expect(item('new-tab', '文件').textContent).toContain('先选择项目')
    expect(item('new-tab', '辅助对话').textContent).toContain('先开始一段会话')
    // The keyboard skips them.
    expect(document.activeElement?.getAttribute('data-new-tab')).toBe('browser')
    const count = Object.keys(layout().tabs).length
    await run(() => item('new-tab', '文件').click())
    expect(Object.keys(layout().tabs)).toHaveLength(count)
  })
})

describe('在主视图中打开 from the strip', () => {
  it('the group menu and the tab menu offer it for a 文件 or 进化 tab, handing it to the page', async () => {
    const files = openTab({ type: 'files', projectId: null })
    const group = tabGroupId(layout(), files)
    const shown = findTab(files)!
    const entries = groupActions({ groupId: group, maximized: false, canUndo: false, canRedo: false, shown })
    expect((entries[0] as LayoutAction).key).toBe('show-in-main')
    expect(entries[1]).toBe('separator')
    expect((groupActions({ groupId: group, maximized: false, canUndo: false, canRedo: false, shown: { id: 'x', type: 'tasks', binding: 'workspace' } as SideTab })[0] as LayoutAction).key).toBe('split-right')
    expect(surfaceActions({ id: 'e', type: 'evolution', binding: 'workspace' } as SideTab).map(action => action.label)).toEqual(['在主视图中打开'])
    expect(surfaceActions({ id: 'w', type: 'worktree', binding: 'workspace' } as SideTab)).toEqual([])

    await render()
    const chip = host.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${files}"]`)!
    await run(() => { chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === '在主视图中打开')!
    expect(entry).toBeDefined()
    await run(() => entry.click())
    expect(findTab(files)).toBeUndefined()
    expect(useUi.getState().view).toBe('files')
  })
})

describe('titles of panels bound to another project', () => {
  it('文件 / 进化 / 工作区改动 bound to a project other than the current one say which', async () => {
    const files = openTab({ type: 'files', projectId: 'p2' })
    const following = openTab({ type: 'files', projectId: null })
    const evolution = openTab({ type: 'evolution', projectId: 'p2' })
    const changes = openTab({ type: 'worktree', projectId: 'p2' })
    const own = openTab({ type: 'evolution', projectId: 'p1' })
    const title = (id: string) => tabTitle(findTab(id)!)
    expect([title(files), title(following), title(evolution), title(changes), title(own)]).toEqual(['文件 · Rna Agent', '文件', '进化 · Rna Agent', '工作区改动 · Rna Agent', '进化'])
    // The strip follows the selection and the project's name.
    await render()
    const chip = () => host.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${files}"]`)
    expect(chip()?.textContent).toBe('文件 · Rna Agent')
    await run(() => useApp.setState({ projects: { ...useApp.getState().projects, p2: project('p2', 'Rna 2') } }))
    expect(chip()?.textContent).toBe('文件 · Rna 2')
  })
})

describe('groups drawn as cards (design 1.4)', () => {
  it('each group is a card apart from the conversation and the window’s edges; the conversation reaches them; dividers fill the gaps', async () => {
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const first = tabGroupId(layout(), page)
    openTab({ type: 'browser', url: 'http://localhost:2/' }, { target: { edge: 'bottom', of: first } })
    await render()
    const px = (value: string) => Number.parseFloat(value)
    const box = (el: HTMLElement) => ({ x: px(el.style.left), y: px(el.style.top), width: px(el.style.width), height: px(el.style.height) })
    const cards = [...host.querySelectorAll<HTMLElement>('section[data-group-id]')]
    expect(cards).toHaveLength(2)
    expect(cards.every(card => card.classList.contains('workspace-card'))).toBe(true)
    const [top, bottom] = cards.map(box).sort((a, b) => a.y - b.y)
    expect(top.y).toBe(CARD_GAP)
    expect(bottom.y - (top.y + top.height)).toBe(CARD_GAP)
    expect(bottom.y + bottom.height).toBe(container.height - CARD_GAP)
    expect(top.x + top.width).toBe(container.width - CARD_GAP)
    const main = box(host.querySelector<HTMLElement>('[data-cell="main"]')!)
    expect(main).toMatchObject({ x: 0, y: 0, height: container.height })
    expect(top.x - (main.x + main.width)).toBe(CARD_GAP)
    // Each body sits inside its card, below the strip.
    const body = box(host.querySelector<HTMLElement>(`[data-tab-cell="${page}"]`)!)
    expect(body.x).toBe(top.x)
    expect(body.width).toBe(top.width)
    expect(body.y + body.height).toBe(top.y + top.height)
    // The dividers fill the gaps.
    const dividers = [...host.querySelectorAll<HTMLElement>('[data-divider]')].map(box)
    expect(dividers).toHaveLength(2)
    expect(dividers.some(d => d.x === main.x + main.width && d.width === CARD_GAP)).toBe(true)
    expect(dividers.some(d => d.y === top.y + top.height && d.height === CARD_GAP)).toBe(true)
    expect(host.querySelector('[data-covered]')).toBeNull()

    // Maximized: one card over the gutter's ground, its margin all round.
    await run(() => buttonOf('layout', first).click())
    expect(host.querySelector('[data-covered]')).not.toBeNull()
    const maxed = box(host.querySelector<HTMLElement>(`section[data-group-id="${first}"]`)!)
    expect(maxed).toEqual({ x: CARD_GAP, y: CARD_GAP, width: container.width - 2 * CARD_GAP, height: container.height - 2 * CARD_GAP })
  })
})
