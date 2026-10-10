import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { FileText, Globe } from 'lucide-react'
import { computeRects, getGroup, groupIds, tabGroupId } from '@/lib/dock'
import {
  activateTab, applyPreset, minimizeGroup, moveTabToward, openTab, resetSidePanel, setContext, togglePanel, useSidePanel, type SideTab,
} from '@/store/side-panel-store'
import { registerTreeToggle } from '@/components/panels/worktree/tree-toggle'
import { registerPanel, unregisterPanel, type PanelContext } from './registry'
import { CARD_GAP } from './cells'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

// jsdom measures nothing: the workspace reports this container size.
const container = { width: 1200, height: 800 }
class FixedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() { this.callback([{ contentRect: { ...container } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
  unobserve() {}
  disconnect() {}
}

let WorkspaceHost: typeof import('./WorkspaceHost').WorkspaceHost
const mounts: Record<string, number> = {}
/** A probe body: counts its mounts, so a remount (what reparenting would cause) shows. */
function Probe({ tab, ctx }: { tab: SideTab; ctx: PanelContext }) {
  return createElement('div', { 'data-probe': tab.id, 'data-visible': String(ctx.visible), tabIndex: 0, ref: (el: HTMLElement | null) => { if (el && !el.dataset.counted) { el.dataset.counted = '1'; mounts[tab.id] = (mounts[tab.id] ?? 0) + 1 } } })
}

beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', FixedResizeObserver)
  ;({ WorkspaceHost } = await import('./WorkspaceHost'))
  // Hermetic bodies for the types used here (replacing the built-in registrations).
  registerPanel({ type: 'browser', title: () => 'page', icon: Globe, binding: 'workspace', keepAlive: true, render: (tab, ctx) => createElement(Probe, { tab, ctx }) })
  registerPanel({ type: 'file', title: () => 'file', icon: FileText, binding: 'project', render: (tab, ctx) => createElement(Probe, { tab, ctx }) })
})

let root: Root, host: HTMLDivElement
beforeEach(() => {
  resetSidePanel()
  container.width = 1200
  for (const key of Object.keys(mounts)) delete mounts[key]
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (mobile = false, children: ReactNode = createElement('div', { 'data-conversation': '', tabIndex: 0 }, 'chat')) => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(WorkspaceHost, { mobile, children }))) })
}
const run = async (fn: () => void) => { await act(async () => { fn() }) }
const probe = (id: string) => host.querySelector<HTMLElement>(`[data-probe="${id}"]`)
const cell = (id: string) => host.querySelector<HTMLElement>(`[data-tab-cell="${id}"]`)
const workspace = () => host.querySelector<HTMLElement>('[data-workspace]')!
const layout = () => useSidePanel.getState().layout
const sections = () => [...host.querySelectorAll<HTMLElement>('section[data-group-id]')].map(el => el.getAttribute('data-group-id'))
const chipIds = () => [...host.querySelectorAll('[role="tab"]')].map(chip => chip.getAttribute('data-tab-id'))
const chip = (id: string) => host.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`)!
/** Right-click a chip and read its menu: each entry's label and whether it is enabled. */
const menuOf = async (id: string) => {
  await run(() => { chip(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}
const entry = (items: HTMLElement[], label: string) => items.find(item => item.textContent?.trim() === label)!
const escape = (target: Element) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('stable cells (design 1.4)', () => {
  it('moving, splitting, collapsing, presets and switching conversations never remount a kept-alive body', async () => {
    setContext({ sessionId: 'a', projectId: 'p' })
    await render()
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    await render()
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    await render()
    const element = probe(page)!
    expect(element).not.toBeNull()
    expect(cell(page)!.hidden).toBe(true) // kept mounted behind the file
    expect(cell(file)!.hidden).toBe(false)
    // Flat siblings of the conversation, all children of the workspace.
    expect(cell(page)!.parentElement).toBe(workspace())
    expect(host.querySelector('[data-cell="main"]')!.parentElement).toBe(workspace())

    await run(() => moveTabToward(page, 'right'))
    expect(groupIds(layout())).toHaveLength(2)
    expect(probe(page)).toBe(element)
    expect(cell(page)!.hidden).toBe(false)
    const right = cell(page)!.style.left
    await run(() => togglePanel())
    expect(cell(page)!.hidden).toBe(true)
    expect(probe(page)).toBe(element)
    await run(() => togglePanel())
    await run(() => applyPreset('bottom'))
    expect(probe(page)).toBe(element)
    expect(cell(page)!.style.left).not.toBe(right)
    await run(() => setContext({ sessionId: 'b', projectId: 'q' }))
    expect(probe(page)).toBe(element) // a page shows everywhere
    expect(probe(file)).toBeNull() // a project file does not, and ordinary bodies unmount when hidden
    await run(() => setContext({ sessionId: 'a', projectId: 'p' }))
    expect(probe(page)).toBe(element)
    expect(mounts[page]).toBe(1)
    expect(host.querySelector(`[data-tab-id="${file}"]`)).not.toBeNull() // back in its strip (the page stays the shown tab)
  })

  it('draws an empty group as the chooser, and a tab of an unregistered type as a plain placeholder', async () => {
    await run(() => togglePanel())
    await render()
    expect(host.querySelector('[data-launcher="browser"]')).not.toBeNull()
    expect(host.querySelector('[data-launcher="tasks"]')).toBeNull()
    const tasks = openTab({ type: 'tasks' })
    await render()
    expect(cell(tasks)!.querySelector('[data-unknown-panel="tasks"]')).not.toBeNull()
    // A later registration lights up both the tab and the chooser card (contract P-6).
    await run(() => registerPanel({ type: 'tasks', title: () => '后台任务', icon: Globe, binding: 'workspace', render: () => createElement('div', { 'data-tasks-body': '' }) }))
    expect(cell(tasks)!.querySelector('[data-tasks-body]')).not.toBeNull()
    openTab({ type: 'launcher' })
    await render()
    expect(host.querySelector('[data-launcher="tasks"]')).not.toBeNull()
    await run(() => unregisterPanel('tasks'))
  })
})

describe('space (design 1.5)', () => {
  it('squeezes the least recently used group onto an edge strip; its icon brings it back in place, a minimized one is restored', async () => {
    container.width = 1040
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const g1 = tabGroupId(layout(), a)
    const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: { edge: 'right', of: g1 } })
    const g2 = tabGroupId(layout(), b)
    const c = openTab({ type: 'file', projectId: 'p', path: 'c.md' }, { target: { edge: 'right', of: g2 } })
    const g3 = tabGroupId(layout(), c)
    await render()
    const drawn = () => [...host.querySelectorAll('section[data-group-id]')].map(el => el.getAttribute('data-group-id'))
    const strip = () => [...host.querySelectorAll('[data-edge-group]')].map(el => el.getAttribute('data-edge-group'))
    expect(strip()).toEqual([g1]) // 420 + 3 × 260 and the gaps > 1040: the oldest group yields
    expect(drawn().sort()).toEqual([g2, g3].sort())
    await run(() => { host.querySelector<HTMLElement>(`[data-edge-group="${g1}"]`)!.click() })
    expect(strip()).toEqual([g2])
    expect(drawn().sort()).toEqual([g1, g3].sort())
    await run(() => { minimizeGroup(g3) })
    expect(strip()).toEqual([g3]) // with g3 put away, g2 fits again
    await run(() => { host.querySelector<HTMLElement>(`[data-edge-group="${g3}"]`)!.click() })
    expect(getGroup(layout(), g3).minimized).toBeUndefined()
  })
})

describe('groups with nothing to show (design 1.5)', () => {
  it('a group whose tabs belong elsewhere takes no space and shows no chooser; it is back where they belong', async () => {
    setContext({ sessionId: 'a', projectId: 'p' })
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    const g1 = tabGroupId(layout(), page)
    const change = openTab({ type: 'change-review', projectId: 'p', changeId: 'bg-1' }, { target: { edge: 'right', of: g1 } })
    const g2 = tabGroupId(layout(), change)
    await render()
    expect(sections().sort()).toEqual([g1, g2].sort())
    const shared = host.querySelector<HTMLElement>(`section[data-group-id="${g1}"]`)!.style.width
    await run(() => setContext({ sessionId: 'b', projectId: 'q' }))
    expect(sections()).toEqual([g1])
    expect(host.querySelector('[data-launcher]')).toBeNull() // no empty chooser taking space
    expect(host.querySelector<HTMLElement>(`section[data-group-id="${g1}"]`)!.style.width).not.toBe(shared) // it has the room
    expect(groupIds(layout())).toContain(g2) // still in the layout
    await run(() => setContext({ sessionId: 'a', projectId: 'p' }))
    expect(sections().sort()).toEqual([g1, g2].sort())
  })
})

describe('narrow window (design 1.5)', () => {
  it('draws the focused group over the conversation when the two do not fit side by side', async () => {
    container.width = 620
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: { edge: 'right', of: tabGroupId(layout(), a) } })
    await render()
    const sections = host.querySelectorAll<HTMLElement>('section[data-group-id]')
    expect(sections).toHaveLength(1)
    expect(sections[0].style.width).toBe(`${620 - 2 * CARD_GAP}px`) // one card, its margin all round
    expect(sections[0].getAttribute('data-group-id')).toBe(layout().activeGroup)
    expect(host.querySelector('[data-cell="main"]')!.hasAttribute('inert')).toBe(true)
    expect(host.querySelector('[aria-label="收起侧边面板"]')).not.toBeNull() // the overlay always offers to step aside
  })

  it('its strip lists every group’s tabs; picking another group’s tab brings that group up, its body kept', async () => {
    container.width = 620
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    await render()
    const element = probe(page)!
    const file = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: { edge: 'right', of: tabGroupId(layout(), page) } })
    await render()
    expect(sections()).toEqual([tabGroupId(layout(), file)])
    expect(chipIds()).toEqual([page, file]) // groups in visual order
    expect(host.querySelectorAll('[data-group-rule]')).toHaveLength(1)
    expect(chip(page).getAttribute('aria-selected')).toBe('false')
    expect(chip(page).draggable).toBe(false)
    expect(cell(page)!.hidden).toBe(true)
    await run(() => chip(page).click())
    expect(sections()).toEqual([tabGroupId(layout(), page)])
    expect(cell(page)!.hidden).toBe(false)
    expect(probe(page)).toBe(element)
    expect(mounts[page]).toBe(1)
    expect(chip(page).getAttribute('aria-selected')).toBe('true')
  })

  it('its tab menu closes among the tabs the strip lists, across groups', async () => {
    container.width = 620
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' }, { target: { edge: 'right', of: tabGroupId(layout(), a) } })
    const c = openTab({ type: 'file', projectId: 'p', path: 'c.md' }, { target: tabGroupId(layout(), b) })
    await render()
    expect(chipIds()).toEqual([a, b, c])
    const menu = await menuOf(a)
    expect(entry(menu, '关闭左侧标签').hasAttribute('data-disabled')).toBe(true)
    expect(entry(menu, '关闭右侧标签').hasAttribute('data-disabled')).toBe(false)
    await run(() => entry(menu, '关闭右侧标签').click())
    expect(Object.keys(layout().tabs)).toEqual([a]) // b and c, in the other group
    expect(sections()).toEqual([tabGroupId(layout(), a)])
  })
})

describe('keys', () => {
  it('Esc hides the panels only from inside a group, never after someone took it, never from a page', async () => {
    setContext({ sessionId: 'a', projectId: 'p' })
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    await render()
    // From the conversation: nothing.
    await run(() => { escape(host.querySelector('[data-conversation]')!) })
    expect(layout().collapsed).toBe(false)
    // Taken by an inner handler first: nothing.
    const take = (e: Event) => e.preventDefault()
    probe(file)!.addEventListener('keydown', take)
    await run(() => { escape(probe(file)!) })
    probe(file)!.removeEventListener('keydown', take)
    expect(layout().collapsed).toBe(false)
    // From inside the group: hidden.
    await run(() => { expect(escape(probe(file)!).defaultPrevented).toBe(true) })
    expect(layout().collapsed).toBe(true)
    // A page keeps the key.
    await run(() => togglePanel())
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' })
    await render()
    await run(() => { escape(probe(page)!) })
    expect(layout().collapsed).toBe(false)
  })

  it('Ctrl+Alt+B toggles; Ctrl+Alt+\\ splits the focused group; Ctrl+Alt+Shift+arrow moves its tab', async () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    openTab({ type: 'file', projectId: 'p', path: 'b.md' })
    await render()
    const key = (init: KeyboardEventInit) => run(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
    await key({ code: 'KeyB', key: 'b', ctrlKey: true, altKey: true })
    expect(layout().collapsed).toBe(true)
    await key({ code: 'KeyB', key: 'b', ctrlKey: true, altKey: true })
    expect(layout().collapsed).toBe(false)
    await key({ code: 'Backslash', key: '\\', ctrlKey: true, altKey: true })
    expect(groupIds(layout())).toHaveLength(2) // the shown tab (b) moved into a new group on the right
    const first = tabGroupId(layout(), a)
    await key({ key: 'ArrowLeft', ctrlKey: true, altKey: true, shiftKey: true }) // b goes back left, into a's group
    expect(groupIds(layout())).toEqual([first])
  })
})

describe('divider drag', () => {
  it('shows a tab opened mid-drag at once, and follows the pointer in layout pixels under the interface zoom', async () => {
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    await render()
    const group = tabGroupId(layout(), file)
    const width = () => computeRects(layout(), container, { gap: CARD_GAP }).rects[group].width
    const before = width()
    // Zoom 125 %: the workspace's box and the pointer are in screen pixels, its layout in CSS pixels.
    const ws = workspace()
    Object.defineProperty(ws, 'offsetWidth', { configurable: true, value: container.width })
    ws.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: container.width * 1.25, height: container.height * 1.25, right: container.width * 1.25, bottom: container.height * 1.25, toJSON() {} }) as DOMRect
    const pointer = (type: string, clientX: number, target: EventTarget = window) => run(() => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY: 100 })) })
    await pointer('pointerdown', 1000, host.querySelector('[data-divider]')!)
    await pointer('pointermove', 875)
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))) })
    expect(host.querySelector('[data-divider]')).toBeNull() // the preview draws the seam only
    const page = openTab({ type: 'browser', url: 'http://localhost:9/' })
    await render()
    expect(cell(page)?.hidden).toBe(false) // drawn from the live layout, not the one the drag started from
    await pointer('pointerup', 875)
    expect(width() - before).toBe(100) // 125 screen pixels left are 100 layout pixels
    expect(host.querySelector('[data-divider]')).not.toBeNull()
    // The width remembered for groups opened later is the slot (card plus its gaps), read back as the same share.
    const root = layout().nodes[layout().root] as { kind: 'split'; sizes: number[]; children: string[] }
    expect(Number(localStorage.getItem('rna.dockWidth'))).toBe(Math.round(root.sizes[root.children.indexOf(group)] * container.width))
  })
})

describe('phone sheet (design 1.5)', () => {
  it('merges every group’s tabs into one strip and shows the chosen one fixed below it', async () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' }, { target: { edge: 'bottom', of: 'main' } })
    expect(tabGroupId(layout(), a)).not.toBe(tabGroupId(layout(), page))
    await render(true)
    const chips = [...host.querySelectorAll('[role="tab"]')].map(chip => chip.getAttribute('data-tab-id'))
    expect(chips).toEqual([page, a]) // groups in visual order: the one under the conversation comes first
    expect(cell(page)!.hidden).toBe(false)
    expect(cell(page)!.style.position).toBe('fixed')
    expect(host.querySelectorAll('[data-divider]')).toHaveLength(0)
    expect(useSidePanel.getState().sheet).toBe(true)
  })

  it('the merged strip’s menu is enabled by, and acts on, the chips it shows', async () => {
    const a = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    const page = openTab({ type: 'browser', url: 'http://localhost:1/' }, { target: { edge: 'bottom', of: 'main' } })
    const b = openTab({ type: 'file', projectId: 'p', path: 'b.md' })
    await render(true)
    expect(chipIds()).toEqual([page, a, b])
    // a is second in this strip (first in its own group): 关闭左侧 closes the page shown before it.
    let menu = await menuOf(a)
    expect(entry(menu, '关闭左侧标签').hasAttribute('data-disabled')).toBe(false)
    expect(menu.some(item => item.textContent?.includes('向右拆分'))).toBe(false) // no layout moves on a phone
    await run(() => entry(menu, '关闭左侧标签').click())
    expect(Object.keys(layout().tabs).sort()).toEqual([a, b].sort())
    menu = await menuOf(b)
    await run(() => entry(menu, '关闭其他标签').click())
    expect(Object.keys(layout().tabs)).toEqual([b])
  })
})

describe('⇧⌘Y (worktree design §3.7)', () => {
  it('shows or hides 工作区改动’s file tree only while that panel is the current group’s shown tab', async () => {
    const toggled: string[] = []
    // A hermetic 工作区改动 body that registers its tree toggle as the real panel does.
    function TreeProbe({ tab }: { tab: SideTab }) {
      return createElement('div', { 'data-probe': tab.id, tabIndex: 0, ref: (el: HTMLElement | null) => (el ? registerTreeToggle(tab.id, () => { toggled.push(tab.id); return true }) : undefined) })
    }
    registerPanel({ type: 'worktree', title: () => 'changes', icon: FileText, binding: 'project', render: tab => createElement(TreeProbe, { tab }) })
    try {
      const changes = openTab({ type: 'worktree', projectId: null })
      await render()
      const press = () => {
        const event = new KeyboardEvent('keydown', { code: 'KeyY', key: 'Y', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
        window.dispatchEvent(event)
        return event
      }
      let event!: KeyboardEvent
      await run(() => { event = press() })
      expect(toggled).toEqual([changes])
      expect(event.defaultPrevented).toBe(true)
      // Another tab shown in that group: the key is left alone.
      openTab({ type: 'file', projectId: 'p', path: 'a.md' })
      await render()
      await run(() => { event = press() })
      expect(toggled).toEqual([changes])
      expect(event.defaultPrevented).toBe(false)
      // The panels hidden: nothing either.
      await run(() => activateTab(changes))
      await run(() => togglePanel())
      await run(() => { event = press() })
      expect(toggled).toEqual([changes])
      await run(() => togglePanel())
      await run(() => { press() })
      expect(toggled).toEqual([changes, changes])
      // Its group minimized to its strip: the panel is not drawn (nor mounted), so the key is left alone.
      await run(() => minimizeGroup(tabGroupId(layout(), changes)))
      await run(() => { event = press() })
      expect(toggled).toEqual([changes, changes])
      expect(event.defaultPrevented).toBe(false)
    } finally { unregisterPanel('worktree') }
  })
})
