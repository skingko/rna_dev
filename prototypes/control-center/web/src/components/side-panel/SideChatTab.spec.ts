import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { STREAM_GRACE_MS } from '@/components/workspace/visibility'
import { SideChatTab } from './SideChatTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => { previous = getTransport(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('side chat: connection budget (design 1.8)', () => {
  it('lets its session stream go once hidden past the grace period, and subscribes again when shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('CSS', { supports: () => true }) // jsdom: the composer sizes itself with field-sizing
    const streams: { path: string; closed: boolean }[] = []
    setTransport({
      kind: 'live',
      async request<T>() { return new Promise<T>(() => {}) },
      openStream(path) {
        const entry = { path, closed: false }
        streams.push(entry)
        return { readyState: 1, onopen: null, onerror: null, addEventListener() {}, close() { entry.closed = true } }
      },
    })
    const tab = { id: 'c', type: 'side-chat' as const, parentSessionId: 'main', sideSessionId: 'side-1', title: null, ordinal: 1 }
    const view = (active: boolean) => createElement(Tooltip.Provider, null, createElement(SideChatTab, { tab, active }))
    await act(async () => { root.render(view(true)) })
    expect(streams).toHaveLength(1)
    expect(streams[0].path).toContain('side-1')
    // Hidden behind another tab or conversation: still streaming for a while (switching back stays instant)…
    await act(async () => { root.render(view(false)) })
    await act(async () => { vi.advanceTimersByTime(STREAM_GRACE_MS - 1_000) })
    expect(streams[0].closed).toBe(false)
    // …then the stream goes (after the subscription's own short grace).
    await act(async () => { vi.advanceTimersByTime(1_000) })
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(streams[0].closed).toBe(true)
    await act(async () => { root.render(view(true)) })
    expect(streams).toHaveLength(2)
    expect(streams[1].closed).toBe(false)
  })
})
