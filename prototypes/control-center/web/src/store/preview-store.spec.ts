import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTransport, setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { tabGroupId } from '@/lib/dock'
import { closeTab, openTab, resetSidePanel, tabOnScreen, updateTab, useSidePanel } from './side-panel-store'
import { DROP_MS, POLL_MS, previewActivity, resetPreviews, RETRY_MS, showPreview, stopPreview, usePreviews, watchPreview } from './preview-store'

const URL_1 = 'http://127.0.0.1:5999/t/index.html'
const ready = (patch: Record<string, unknown> = {}) => ({ status: 'ready', kind: 'static', url: URL_1, entryPath: 'index.html', generation: 'g1', revision: 1, ...patch })

let status: Record<string, unknown>, discovery: Record<string, unknown>, onStart: () => Record<string, unknown>
let calls: string[] = []
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, 'http://x')
    calls.push(`${init.method ?? 'GET'} ${url.pathname}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    if (url.pathname.endsWith('/preview/discovery')) return discovery as T
    if (init.method === 'POST') return onStart() as T
    if (init.method === 'DELETE') { status = { status: 'stopped' }; return {} as T }
    return status as T
  },
  openStream() { throw new Error('unused') },
}

const count = (prefix: string) => calls.filter(call => call.startsWith(prefix)).length
const reads = () => count('GET /api/projects/p/preview') - count('GET /api/projects/p/preview/discovery')
const probes = () => count('GET /api/projects/p/preview/discovery')
const previewTabs = () => Object.values(useSidePanel.getState().layout.tabs).filter(tab => tab.type === 'browser' && tab.key === 'preview:p')
const state = () => usePreviews.getState().projects.p
const settle = () => vi.advanceTimersByTimeAsync(0)

let previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  resetPreviews(); resetSidePanel()
  calls = []
  status = { status: 'stopped' }
  discovery = { status: 'none' }
  onStart = () => ({ status: 'unavailable' })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => { resetPreviews(); vi.useRealTimers(); setTransport(previous) })

describe('one preview check per project (design 4.4)', () => {
  it('reads the host once per interval however many visible surfaces watch the project, and stops with the last', async () => {
    const page = watchPreview('p', { visible: true, sessionId: null })
    const panel = watchPreview('p', { visible: true, sessionId: 's1' })
    await settle()
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(reads()).toBe(4)
    page.release()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(reads()).toBe(5)
    panel.release()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(reads()).toBe(5)
    expect(previewActivity('p')).toEqual({ subscribers: 0, visible: 0, polling: false, probing: false })
  })

  it('reads and probes only while a subscriber is visible', async () => {
    const watch = watchPreview('p', { visible: false, sessionId: null })
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(calls).toEqual([])
    expect(previewActivity('p')).toEqual({ subscribers: 1, visible: 0, polling: false, probing: false })

    watch.update({ visible: true, sessionId: null })
    await settle()
    expect(previewActivity('p')).toMatchObject({ visible: 1, polling: true, probing: true })
    expect(reads()).toBe(1); expect(probes()).toBe(1)
    // Probing waits RETRY_MS between attempts.
    await vi.advanceTimersByTimeAsync(RETRY_MS - 100)
    expect(probes()).toBe(1)
    await vi.advanceTimersByTimeAsync(2100)
    expect(probes()).toBe(2)

    watch.update({ visible: false, sessionId: null })
    const before = calls.length
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3)
    expect(calls.length).toBe(before)
    watch.release()
  })

  it('starts a runnable entry automatically, once, for the conversation that shows it, then stops probing', async () => {
    discovery = { status: 'ready', preferred: 'web', candidates: [{ id: 'web', available: true }] }
    onStart = () => { status = ready(); return status }
    const page = watchPreview('p', { visible: true, sessionId: null })
    const panel = watchPreview('p', { visible: true, sessionId: 's1' })
    await settle(); await settle()
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/projects/p/preview {"mode":"auto","sessionId":"s1"}'])
    expect(state()?.preview?.url).toBe(URL_1)
    expect(previewActivity('p').probing).toBe(false)
    expect(previewTabs()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(probes()).toBe(1)
    page.release(); panel.release()
  })

  it('opens a newly found preview in the built-in browser once, and reloads a static one once per change', async () => {
    status = ready()
    const page = watchPreview('p', { visible: true, sessionId: null })
    const panel = watchPreview('p', { visible: true, sessionId: null })
    await settle()
    expect(state()).toMatchObject({ preview: { url: URL_1 }, revision: 0 })
    expect(state()?.note).toContain('静态预览')
    const [tab] = previewTabs()
    expect(tab).toBeDefined()

    updateTab(tab.id, { reload: 0 })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(useSidePanel.getState().layout.tabs[tab.id]).toMatchObject({ reload: 0 })
    status = ready({ revision: 2 })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(state()?.revision).toBe(1)
    expect((useSidePanel.getState().layout.tabs[tab.id] as { reload?: number }).reload).toBeGreaterThan(0)

    // Closing the tab keeps it closed; a restarted service (new generation) opens again.
    closeTab(tab.id)
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(previewTabs()).toHaveLength(0)
    status = ready({ url: 'http://127.0.0.1:6001/t/index.html', generation: 'g2' })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(previewTabs()).toHaveLength(1)
    page.release(); panel.release()
  })

  it('opens the preview next to a 文件 panel, not over it', async () => {
    const files = openTab({ type: 'files', projectId: null })
    status = ready()
    const watch = watchPreview('p', { visible: true, sessionId: null })
    await settle()
    const [tab] = previewTabs()
    const { layout } = useSidePanel.getState()
    expect(tabGroupId(layout, tab.id)).not.toBe(tabGroupId(layout, files))
    expect(tabOnScreen(files, useSidePanel.getState())).toBe(true)
    watch.release()
  })

  it('a read that says the same thing again writes nothing (the surfaces do not render every poll)', async () => {
    status = ready()
    const watch = watchPreview('p', { visible: true, sessionId: null })
    await settle()
    const first = state()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(reads()).toBe(4)
    expect(state()).toBe(first)
    status = ready({ watchTruncated: true })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(state()).not.toBe(first)
    expect(state()?.note).toContain('部分资源需手动刷新')
    watch.release()
  })

  it('keeps a project’s state across a quick remount and drops it after the last subscriber leaves', async () => {
    status = ready()
    const first = watchPreview('p', { visible: true, sessionId: null })
    await settle()
    first.release()
    const second = watchPreview('p', { visible: true, sessionId: null })
    expect(state()?.preview?.url).toBe(URL_1)
    second.release()
    await vi.advanceTimersByTimeAsync(DROP_MS + 10)
    expect(state()).toBeUndefined()
    expect(previewActivity('p').subscribers).toBe(0)
  })

  it('leaves a preview the user stopped alone until they start one', async () => {
    status = ready()
    discovery = { status: 'ready', preferred: 'web', candidates: [{ id: 'web', available: true }] }
    const watch = watchPreview('p', { visible: true, sessionId: null })
    await settle()
    expect(probes()).toBe(0) // a preview already runs
    await stopPreview('p')
    expect(state()?.preview).toBeNull()
    expect(calls).toContain('DELETE /api/projects/p/preview {}')
    // Started again elsewhere (an agent, another window): not picked up, and no automatic start either.
    status = ready({ generation: 'g3' })
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(state()?.preview).toBeNull()
    expect(probes()).toBe(0)
    // The user starts it: shown again.
    showPreview('p', ready({ generation: 'g3' }))
    expect(state()?.preview?.url).toBe(URL_1)
    expect(() => showPreview('p', { status: 'ready', url: 'https://example.com/' })).toThrow('预览必须使用独立的本机服务地址。')
    watch.release()
  })
})
