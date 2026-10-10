import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetPreviews } from '@/store/preview-store'
import { resetSidePanel } from '@/store/side-panel-store'
import { FilesSurface } from './FilesView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const READY = { status: 'ready', kind: 'static', url: 'http://127.0.0.1:5999/t/index.html', entryPath: 'index.html', generation: 'g' }
let revision = 1, content = '# A', hold: Promise<void> | null = null, previewStatus: Record<string, unknown> = { status: 'stopped' }
let calls: string[] = [], reads: string[] = []
const listings: Record<string, unknown> = {
  '': { path: '', entries: [{ name: 'src', path: 'src', type: 'directory' }, { name: 'a.md', path: 'a.md', type: 'file', size: 3 }, { name: 'index.html', path: 'index.html', type: 'file', size: 9 }] },
  src: { path: 'src', entries: [{ name: 'notes.md', path: 'src/notes.md', type: 'file', size: 3 }] },
}
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, 'http://x')
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
    if (url.pathname.endsWith('/preview')) return (previewStatus.status === 'ready' ? { ...previewStatus, revision } : previewStatus) as T
    if (url.pathname.endsWith('/files')) return listings[url.searchParams.get('path') ?? ''] as T
    // The change markers read git's status: a plain folder here.
    if (url.pathname.endsWith('/git')) return { repo: 'none', files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } as T
    reads.push(url.searchParams.get('path') ?? '')
    if (hold) await hold
    return { path: url.searchParams.get('path'), content, bytes: 3, truncated: false } as T
  },
  openStream() { throw new Error('unused') },
}

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  resetPreviews(); resetSidePanel()
  revision = 1; content = '# A'; hold = null; previewStatus = { status: 'stopped' }; calls = []; reads = []
  useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous); resetPreviews(); vi.useRealTimers(); useUi.setState({ toasts: [] }) })

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const render = async (...children: ReactNode[]) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, ...children)) }); await flush() }
const surface = (props: Partial<Parameters<typeof FilesSurface>[0]> = {}) => createElement(FilesSurface, { key: props.layout ?? 'page', projectId: 'p', visible: true, layout: 'page', ...props })
/** One poll interval at a time (a read still in flight skips the next tick). */
const ticks = async (n: number) => { for (let i = 0; i < n; i++) { await act(async () => { vi.advanceTimersByTime(1500) }); await flush() } }
const previewReads = () => calls.filter(call => call === 'GET /api/projects/p/preview').length

describe('the 文件 surface (design 4.1–4.4)', () => {
  it('updates the tree in place, keeps the open file and the chosen pane, and reads the open file again in place on a change', async () => {
    previewStatus = READY
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await render(surface())
    const row = host.querySelector('[data-file-path="a.md"]') as HTMLButtonElement
    await act(async () => { row.click() }); await flush()
    const heading = () => host.querySelector('.md-doc h1')?.textContent
    expect(reads).toEqual(['a.md']); expect(heading()).toBe('A')
    const preview = host.querySelector('[data-preview-kind]')
    const list = [...host.querySelectorAll('[role="tab"], button')].find(button => button.textContent === '文件列表') as HTMLButtonElement
    await act(async () => { list.click() }); await flush()
    // Narrow containers: one pane at a time, by container query (no viewport breakpoint).
    const contentPane = () => host.querySelector('[data-files-pane="file"]')!.className.split(' ')
    expect(contentPane()).toContain('hidden')
    expect(contentPane()).toContain('@[640px]/files:flex')

    let release = () => {}
    hold = new Promise<void>(resolve => { release = resolve })
    revision = 2; content = '# B'
    await act(async () => { vi.advanceTimersByTime(1500) }); await flush()
    expect(reads).toEqual(['a.md', 'a.md'])
    expect(heading()).toBe('A')
    await act(async () => { release() }); hold = null; await flush()
    expect(heading()).toBe('B')
    expect(host.querySelector('[data-file-path="a.md"]')).toBe(row)
    expect(host.querySelector('[data-preview-kind]')).toBe(preview)
    expect(contentPane()).toContain('hidden')
  })

  it('a page and a panel of the same project read the preview once per interval', async () => {
    previewStatus = READY
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await render(surface(), surface({ layout: 'panel', sessionId: 's1' }))
    expect(host.querySelectorAll('[data-files-surface]')).toHaveLength(2)
    expect(previewReads()).toBe(1)
    await ticks(3)
    expect(previewReads()).toBe(4)
    // Both show the running preview (one 更换预览 each).
    expect([...host.querySelectorAll('button')].filter(button => button.textContent === '更换预览')).toHaveLength(2)
    // The panel goes out of view: the page alone keeps it checked; the page goes too: nothing runs.
    await render(surface(), surface({ layout: 'panel', visible: false }))
    await ticks(2)
    expect(previewReads()).toBe(6)
    await render(surface({ visible: false }), surface({ layout: 'panel', visible: false }))
    await ticks(4)
    expect(previewReads()).toBe(6)
  })

  it('lays out by its own width only: no viewport breakpoints inside', async () => {
    previewStatus = READY
    await render(surface({ layout: 'panel', onShowInMain: () => {} }))
    const viewport = /(^|\s)!?(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl):/
    const offenders = [...host.querySelectorAll<HTMLElement>('[class]')].map(el => el.getAttribute('class')!).filter(name => viewport.test(name))
    expect(offenders).toEqual([])
    expect(host.querySelector('[data-files-surface="panel"]')!.className).toContain('@container/files')
    // With a preview running the header holds six actions: below 320 px its title steps aside (still read out) so they fit at 260 px.
    const title = [...host.querySelectorAll('strong')].find(el => el.textContent === '项目文件')!
    expect(title.className.split(' ')).toContain('@max-[320px]/files:sr-only')
  })

  it('opens a file asked for from outside, its folders included, once', async () => {
    const applied = vi.fn()
    await render(surface({ layout: 'panel', path: 'src/notes.md', onPathApplied: applied }))
    expect(applied).toHaveBeenCalledTimes(1)
    expect(calls).toContain('GET /api/projects/p/files')
    expect(host.querySelector('[data-file-path="src"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-file-path="src/notes.md"]')!.getAttribute('aria-selected')).toBe('true')
    expect(reads).toEqual(['src/notes.md'])
  })

  it('one pane at a time: the keyboard goes along to a picked file, and Esc there goes back to its row', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() { this.callback([{ contentRect: { width: 300 } }]) }
      disconnect() {}
    })
    // The poll tests above fake the timers jsdom's animation frames run on: frames come from a plain timeout here.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
    await render(surface({ layout: 'panel' }))
    const row = host.querySelector('[data-file-path="a.md"]') as HTMLButtonElement
    const content = host.querySelector<HTMLElement>('[data-files-pane="file"]')!
    await act(async () => { row.focus(); row.click() }); await flush()
    expect(content.className.split(' ')).not.toContain('hidden')
    expect(document.activeElement).toBe(content)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { content.dispatchEvent(esc) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(esc.defaultPrevented).toBe(true) // the workspace leaves the panel open
    expect(content.className.split(' ')).toContain('hidden')
    expect(document.activeElement).toBe(row)
    vi.unstubAllGlobals()
  })

  it('a panel’s ⋯ menu hands it to the main view with the open file; the page has no such menu', async () => {
    const show = vi.fn()
    await render(surface({ layout: 'panel', onShowInMain: show }))
    await act(async () => { (host.querySelector('[data-file-path="a.md"]') as HTMLButtonElement).click() }); await flush()
    const trigger = host.querySelector<HTMLButtonElement>('[data-surface-menu]')!
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === '在主视图中打开')!
    await act(async () => { item.click() })
    expect(show).toHaveBeenCalledWith('a.md')
    await render(surface({ onShowInMain: show }))
    expect(host.querySelector('[data-surface-menu]')).toBeNull()
  })
})
