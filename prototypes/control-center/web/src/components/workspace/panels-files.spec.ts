import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { tabGroupId } from '@/lib/dock'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetPreviews } from '@/store/preview-store'
import { findTab, openLauncher, openTab, resetSidePanel, useSidePanel, type SideTab } from '@/store/side-panel-store'
import { resetSurfaceRouter, useSurfaceRouter } from '@/store/surface-router'
import { Launcher } from '@/components/side-panel/Launcher'
import { getPanel, type PanelContext } from './registry'
import './panels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const tree = (n: number) => ({
  projectId: 'p1', promptFile: { name: 'AGENTS.md', exists: true, default: 'AGENTS.md' }, generation: { n, at: null, summary: null }, generations: [], forming: false,
  strands: [{ layer: 'skill', label: '技能', genes: [{ id: 'skill:a', layer: 'skill', key: 'a', title: `技能 第${n}代`, summary: '写周报', level: 1, status: 'active', history: [], runs: 0, hits: 0 }] }],
})
let calls: string[] = [], generation = 1
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, 'http://x')
    calls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.pathname.endsWith('/genes')) return tree(generation) as T
    if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
    if (url.pathname.endsWith('/preview')) return { status: 'stopped' } as T
    if (url.pathname.endsWith('/files')) {
      const dir = url.searchParams.get('path') ?? ''
      return (dir === 'docs' ? { path: 'docs', entries: [{ name: 'plan.md', path: 'docs/plan.md', type: 'file', size: 4 }] } : { path: '', entries: [{ name: 'docs', path: 'docs', type: 'directory' }] }) as T
    }
    return { path: url.searchParams.get('path'), content: '# 计划', bytes: 4, truncated: false } as T
  },
  openStream() { throw new Error('unused') },
}

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  calls = []; generation = 1
  resetSidePanel(); resetPreviews(); resetSurfaceRouter()
  useApp.setState({
    status: 'ready', projects: { p1: { id: 'p1', name: '水墨飞鸟', workspacePath: '/w/ink' }, p2: { id: 'p2', name: 'Rna Agent', workspacePath: '/w/rna' } }, projectOrder: ['p1', 'p2'],
    sessionIndex: { 's-p1': { id: 's-p1', title: '主会话', status: 'idle', projectId: 'p1' } }, sessions: {}, selectedSessionId: 's-p1', selectedProjectId: 'p1', revision: 0,
  } as never)
  useUi.setState({ view: 'chat', toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous); resetPreviews() })

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async (node: ReactNode) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await flush() }
const ctxOf = (tab: SideTab, patch: Partial<PanelContext> = {}): PanelContext => ({ sessionId: 's-p1', projectId: 'p1', visible: true, groupId: tabGroupId(useSidePanel.getState().layout, tab.id), ...patch })
const body = (tab: SideTab, patch: Partial<PanelContext> = {}) => getPanel(tab.type)!.render(tab, ctxOf(tab, patch))

describe('文件 and 进化 panels (design 4, D5)', () => {
  it('are registered as project panels', () => {
    expect(getPanel('files')).toMatchObject({ binding: 'project' })
    expect(getPanel('evolution')).toMatchObject({ binding: 'project' })
    expect(getPanel('files')!.title({ id: 'f', type: 'files', binding: 'workspace' })).toBe('文件')
    expect(getPanel('evolution')!.title({ id: 'e', type: 'evolution', binding: 'workspace' })).toBe('进化')
  })

  it('a panel following the current project shows it, and quietly says so when there is none', async () => {
    const id = openTab({ type: 'files', projectId: null })
    const tab = findTab(id)!
    await show(body(tab))
    expect(host.querySelector('[data-files-surface="panel"]')).not.toBeNull()
    expect(host.textContent).toContain('/w/ink')
    await show(body(tab, { sessionId: null, projectId: null }))
    expect(host.querySelector('[data-files-surface]')).toBeNull()
    expect(host.querySelector('[data-panel-empty]')!.textContent).toBe('文件属于项目。选择一个项目或其中的会话后，这里会显示它的文件。')
  })

  it('a panel bound to a project keeps showing it wherever the user is', async () => {
    const id = openTab({ type: 'files', projectId: 'p2' })
    await show(body(findTab(id)!))
    expect(host.textContent).toContain('/w/rna')
    expect(calls.some(call => call.startsWith('GET /api/projects/p2/files'))).toBe(true)
    // A project the app no longer lists: nothing to show but a way out.
    useApp.setState(s => ({ projects: { p1: s.projects.p1 } }))
    await flush()
    expect(host.querySelector('[data-panel-empty]')!.textContent).toContain('这个项目已不可用。')
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === '关闭标签')!.click() })
    expect(findTab(id)).toBeUndefined()
  })

  it('shows a file the tab asks for once, then forgets the request', async () => {
    const id = openTab({ type: 'files', projectId: null, path: 'docs/plan.md' })
    await show(body(findTab(id)!))
    expect(host.querySelector('[data-file-path="docs/plan.md"]')!.getAttribute('aria-selected')).toBe('true')
    expect(findTab(id)).toMatchObject({ path: null })
  })

  it('在主视图中打开 hands the panel to the page with its file', async () => {
    const id = openTab({ type: 'files', projectId: null, path: 'docs/plan.md' })
    await show(body(findTab(id)!))
    await act(async () => { host.querySelector('[data-surface-menu]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) })
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === '在主视图中打开')!.click() })
    expect(findTab(id)).toBeUndefined()
    expect(useUi.getState().view).toBe('files')
    expect(useSurfaceRouter.getState().pagePath).toEqual({ projectId: 'p1', path: 'docs/plan.md' })
  })

  it('the 进化 panel shows the project’s tree and catches up with changes once it is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const id = openTab({ type: 'evolution', projectId: null })
      const tab = findTab(id)!
      await act(async () => { root.render(createElement(Tooltip.Provider, null, body(tab))) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      expect(host.querySelector('[data-evolution-surface="panel"]')).not.toBeNull()
      expect(host.textContent).toContain('技能 第1代')
      const reads = () => calls.filter(call => call === 'GET /api/v2/projects/p1/genes').length
      expect(reads()).toBe(1)
      // Hidden: a new generation is not read yet.
      await act(async () => { root.render(createElement(Tooltip.Provider, null, body(tab, { visible: false }))) })
      generation = 2
      await act(async () => { useApp.setState({ revision: 5 } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(reads()).toBe(1)
      // Shown: read once.
      await act(async () => { root.render(createElement(Tooltip.Provider, null, body(tab))) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      expect(reads()).toBe(2)
      expect(host.textContent).toContain('技能 第2代')
      expect(host.querySelector('[data-surface-menu]')).not.toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('the chooser’s 文件 and 进化 cards', () => {
  it('open the panel following the current project in place of the chooser', async () => {
    const chooser = openLauncher()
    await show(createElement(Launcher, { tabId: chooser, sessionId: 's-p1', projectId: 'p1' }))
    const files = host.querySelector<HTMLButtonElement>('[data-launcher="files"]')!
    expect(files.textContent).toContain('文件')
    expect(host.querySelector('[data-launcher="evolution"]')!.textContent).toContain('进化')
    await act(async () => { files.click() })
    expect(findTab(chooser)).toBeUndefined()
    expect(Object.values(useSidePanel.getState().layout.tabs).filter(tab => tab.type === 'files')).toMatchObject([{ projectId: null }])
  })

  it('are unavailable without a project', async () => {
    await show(createElement(Launcher, { tabId: null, sessionId: null, projectId: null }))
    expect(host.querySelector<HTMLButtonElement>('[data-launcher="files"]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-launcher="evolution"]')!.disabled).toBe(true)
    expect(host.querySelector('[data-launcher="files"]')!.textContent).toContain('先选择项目')
  })
})
