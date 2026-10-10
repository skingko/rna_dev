import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { AgentBrowserTab } from './AgentBrowserTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => { previous = getTransport(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous); vi.useRealTimers() })

describe('agent browser view: connection budget (design 1.8)', () => {
  it('stops streaming 30 s after it is hidden, keeps the last frame, and streams again when shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const streams: { closed: boolean; emit: (type: string, data: unknown) => void }[] = []
    setTransport({
      kind: 'live',
      async request<T>() { return {} as T },
      openStream() {
        const listeners: Record<string, (event: MessageEvent) => void> = {}
        const entry = { closed: false, emit: (type: string, data: unknown) => listeners[type]?.({ data: JSON.stringify(data) } as MessageEvent) }
        streams.push(entry)
        return { readyState: 1, onopen: null, onerror: null, addEventListener(type, listener) { listeners[type] = listener }, close() { entry.closed = true } }
      },
    })
    const view = (active: boolean) => createElement(Tooltip.Provider, null, createElement(AgentBrowserTab, { tab: { id: 'a', type: 'agent-browser', sessionId: 's' }, active }))
    await act(async () => { root.render(view(true)) })
    await act(async () => { streams[0].emit('frame', { data: 'AAAA', at: 1 }) })
    expect(host.querySelector('img')).not.toBeNull()
    await act(async () => { root.render(view(false)) })
    await act(async () => { vi.advanceTimersByTime(30_500) })
    expect(streams[0].closed).toBe(true)
    await act(async () => { root.render(view(true)) })
    expect(streams).toHaveLength(2)
    expect(host.querySelector('img')).not.toBeNull() // the last frame stays while the stream reconnects
  })
})
