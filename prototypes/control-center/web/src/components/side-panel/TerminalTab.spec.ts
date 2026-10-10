// UX audit 2026-10-03 (C5, round 2): the app's ⌘K yields inside the terminal, where it clears the screen as in Terminal.app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import TerminalTab from './TerminalTab'

const xterm = vi.hoisted(() => ({ handler: null as ((event: KeyboardEvent) => boolean) | null, cleared: 0, focused: 0 }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; options = {}
    loadAddon() {} open() {} dispose() {} write() {} reset() {}
    focus() { xterm.focused++ }
    hasSelection() { return false }
    getSelection() { return '' }
    onData() { return { dispose() {} } }
    clear() { xterm.cleared++ }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { xterm.handler = handler }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} dispose() {} } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const transport: Transport = {
  kind: 'mock',
  async request<T>(): Promise<T> { throw new ApiError('offline', 503) },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport)
  xterm.handler = null; xterm.cleared = 0; xterm.focused = 0
  useApp.setState({ capabilities: { terminal: true } as never, projects: { p: { id: 'p', name: 'P', permissions: { workspace: 'execute' } } as never } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

describe('terminal keys', () => {
  it('⌘K clears the screen; Ctrl+K stays with the shell', async () => {
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(TerminalTab, { tab: { id: 't1', type: 'terminal', projectId: 'p', terminalId: null }, active: false }))) })
    expect(xterm.handler).not.toBeNull()
    expect(xterm.handler!(key({ key: 'k', metaKey: true }))).toBe(false)
    expect(xterm.cleared).toBe(1)
    expect(xterm.handler!(key({ key: 'k', ctrlKey: true }))).toBe(true)
    expect(xterm.handler!(key({ key: 'K', metaKey: true, shiftKey: true }))).toBe(true)
    expect(xterm.cleared).toBe(1)
  })
})

describe('focus', () => {
  const frame = () => act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))) })
  const view = (active: boolean) => createElement(Tooltip.Provider, null, createElement(TerminalTab, { tab: { id: 't1', type: 'terminal', projectId: 'p', terminalId: null }, active }))

  it('takes the keyboard when shown, but never from someone typing elsewhere (panels expanding while they write)', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const composer = document.createElement('textarea')
    document.body.append(composer)
    try {
      await act(async () => { root.render(view(false)) })
      composer.focus()
      await act(async () => { root.render(view(true)) })
      await frame()
      expect(xterm.focused).toBe(0)
      expect(document.activeElement).toBe(composer)
      // Picked by the user (focus on its tab, not in a field): it takes the keyboard.
      await act(async () => { root.render(view(false)) })
      composer.blur()
      await act(async () => { root.render(view(true)) })
      await frame()
      expect(xterm.focused).toBe(1)
    } finally { composer.remove(); vi.unstubAllGlobals() }
  })
})

describe('connection budget (design 1.8)', () => {
  it('a hidden terminal closes its stream after 30 s and resumes after the last sequence when shown again', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const streams: { path: string; closed: boolean; emit: (type: string, data: unknown) => void }[] = []
    setTransport({
      kind: 'live',
      async request<T>() { return {} as T },
      openStream(path) {
        const listeners: Record<string, (event: MessageEvent) => void> = {}
        const entry = { path, closed: false, emit: (type: string, data: unknown) => listeners[type]?.({ data: JSON.stringify(data) } as MessageEvent) }
        streams.push(entry)
        return { readyState: 1, onopen: null, onerror: null, addEventListener(type, listener) { listeners[type] = listener }, close() { entry.closed = true } }
      },
    })
    const view = (active: boolean) => createElement(Tooltip.Provider, null, createElement(TerminalTab, { tab: { id: 't1', type: 'terminal', projectId: 'p', terminalId: 'host-1' }, active }))
    try {
      await act(async () => { root.render(view(true)) })
      expect(streams).toHaveLength(1)
      await act(async () => { streams[0].emit('data', { seq: 7, b64: '' }) })
      await act(async () => { root.render(view(false)) })
      await act(async () => { vi.advanceTimersByTime(29_000) })
      expect(streams[0].closed).toBe(false) // switching back right away stays instant
      await act(async () => { vi.advanceTimersByTime(1_500) })
      expect(streams[0].closed).toBe(true)
      await act(async () => { root.render(view(true)) })
      expect(streams).toHaveLength(2)
      expect(streams[1].path).toContain('lastEventId=7')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
