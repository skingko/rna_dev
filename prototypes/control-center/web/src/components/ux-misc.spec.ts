import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import { ApiError, liveTransport, type Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {}
    loadAddon() {} open() {} attachCustomKeyEventHandler() {} dispose() {} reset() {} focus() {} clear() {} write() {}
    onData() { return { dispose() {} } }
    getSelection() { return '' }
    hasSelection() { return false }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

let root: Root, host: HTMLDivElement, previous: Transport
const appState = useApp.getState()
beforeEach(() => {
  previous = getTransport()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); setTransport(previous)
  useApp.setState(appState, true); useUi.setState({ toasts: [] })
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const render = async (element: Parameters<Root['render']>[0]) => { await act(async () => { root.render(element) }); await flush() }
const toasts = () => useUi.getState().toasts.map(row => row.text)

describe('project initialization banner (F4)', () => {
  const project = (id: string, initialization: Record<string, unknown>) => ({ id, name: id, initialization }) as never
  it('shows 项目初始化完成 for six seconds, then leaves; another project never inherits it', async () => {
    const { ProjectInitStatus } = await import('@/components/projects/ProjectInitStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useApp.setState({ projects: { a: project('a', { status: 'initializing' }), b: project('b', { status: 'ready' }) } })
    await act(async () => { root.render(createElement(ProjectInitStatus, { projectId: 'a' })) })
    expect(host.textContent).toContain('正在初始化项目')
    await act(async () => { useApp.setState(s => ({ projects: { ...s.projects, a: project('a', { status: 'ready' }) } })) })
    expect(host.textContent).toContain('项目初始化完成')
    await act(async () => { vi.advanceTimersByTime(6100) })
    expect(host.textContent).not.toContain('项目初始化完成')

    await act(async () => { useApp.setState(s => ({ projects: { ...s.projects, a: project('a', { status: 'initializing' }) } })) })
    await act(async () => { useApp.setState(s => ({ projects: { ...s.projects, a: project('a', { status: 'ready' }) } })) })
    expect(host.textContent).toContain('项目初始化完成')
    await act(async () => { root.render(createElement(ProjectInitStatus, { projectId: 'b' })) })
    expect(host.textContent).not.toContain('项目初始化完成')
  })
})

describe('browser fetch failures (F26)', () => {
  it('become localized ApiErrors with status 0; a caller abort stays an AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError')))
    const network = await liveTransport.request('/api/x').catch((e: ApiError) => e) as ApiError
    expect(network).toBeInstanceOf(ApiError); expect(network.message).toBe('无法连接本地服务，请稍后重试。'); expect(network.status).toBe(0)
    const timeout = await liveTransport.request('/api/x').catch((e: ApiError) => e) as ApiError
    expect(timeout.message).toBe('请求超时，请重试。'); expect(timeout.code).toBe('request_timeout')
    const aborted = await liveTransport.request('/api/x').catch((e: ApiError) => e) as ApiError
    expect(aborted.name).toBe('AbortError')
  })
  it('also for raw file reads and attachment uploads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    setTransport(liveTransport)
    const { projectApi } = await import('@/api/project-api')
    const { api } = await import('@/api/client')
    expect((await projectApi.readBlob('p', 'a.png').catch(e => e)).message).toBe('无法连接本地服务，请稍后重试。')
    expect((await api.uploadAttachment('s', new File(['x'], 'a.txt')).catch(e => e)).message).toBe('无法连接本地服务，请稍后重试。')
  })
})

describe('workspace image (F22)', () => {
  it('reads again once maintenance ends instead of staying broken', async () => {
    const { WorkspaceImage } = await import('@/components/preview/WorkspaceMedia')
    setTransport(liveTransport)
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '应用维护期间暂不开始新工作，草稿已保留。', code: 'maintenance_held' }), { status: 503 }))
      .mockResolvedValue(new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetch)
    useApp.setState({ connection: 'online', maintenanceHeld: true })
    await render(createElement(WorkspaceImage, { projectId: 'p', path: 'media/a.png', alt: '封面' }))
    expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('封面')
    await act(async () => { useApp.setState({ maintenanceHeld: false }) }); await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:x')
  })
  it('does not retry a missing file', async () => {
    const { WorkspaceImage } = await import('@/components/preview/WorkspaceMedia')
    setTransport(liveTransport)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '文件或目录不存在。', code: 'WORKSPACE_NOT_FOUND' }), { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    useApp.setState({ connection: 'online', maintenanceHeld: true })
    await render(createElement(WorkspaceImage, { projectId: 'p', path: 'gone.png', alt: 'gone' }))
    await act(async () => { useApp.setState({ maintenanceHeld: false }) }); await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('memory sync panel (F86, A2)', () => {
  it('reads as a closed notice with the host’s plain line instead of a red error code', async () => {
    const { MemorySyncPanel } = await import('@/components/memory/MemorySyncPanel')
    const issue = { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', updatedAt: '2026-10-01T00:00:00Z', message: '上次同步没有收到确认，无法确定是否已保存；不会重复上传。' }
    const status = { projectId: 'p', status: 'attention', health: 'degraded', completedTurns: 54, incremental: 0, pending: 0, attention: 2, retained: 0,
      evidence: { records: 0, completed: 0, extracted: 0, indexed: 0, indexPending: 0, indexIssues: 0 }, counts: {}, lastSuccessAt: null,
      summary: { status: 'failed', resolution: 'settled', code: 'MEMORY_SUMMARY_TREE_LIMIT', updatedAt: null, completedAt: null },
      sessions: [{ sessionId: 's', title: '第一章', archivedAt: null, status: 'attention', turns: 2, completedTurns: 1, writes: 2, incremental: 0, pending: 0, attention: 2, retained: 0,
        evidence: { records: 0, completed: 0, extracted: 0, indexed: 0, indexPending: 0, indexIssues: 0 }, lastSuccessAt: null, issues: [issue, { status: 'uncertain', code: 'MEMORY_OTHER' }] }] }
    setTransport({ kind: 'live', async request<T>() { return status as T }, openStream() { throw new Error('unused') } })
    await render(createElement(MemorySyncPanel, { projectId: 'p' }))
    expect(host.textContent).toContain('部分记忆同步结果还在核对')
    expect(host.querySelector('[data-memory-sync-issue]')).toBeNull()
    await act(async () => { host.querySelector('button')!.click() }); await flush()
    expect([...host.querySelectorAll('[data-memory-sync-issue]')].map(row => row.textContent?.split(' · ')[0])).toEqual([issue.message, '这一段没有同步成功。'])
    // A failed project summary is a plain settled note, never a code.
    expect(host.querySelector('[data-memory-summary]')?.textContent).toBe('项目摘要没有整理完整，下次提炼后会重新整理；记忆原文不受影响。')
    expect(host.textContent).not.toContain('MEMORY_')
    expect(host.querySelector('[data-memory-sync-action]')).toBeNull()
  })

  it('lists a settled loss under history with nothing to acknowledge; re-extracts only after the paid confirmation (MEM-4, A2)', async () => {
    const { MemorySyncPanel } = await import('@/components/memory/MemorySyncPanel')
    const unresolved = { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', turnId: 't2', message: '上次同步没有收到确认。', resolution: 'unresolved', actions: [] }
    const history = [
      { status: 'failed', code: 'MEMORY_EXTRACTION_FAILED', turnId: 't1', message: '这一轮对话已归档，但记忆提炼没有成功。', resolution: 'settled', actions: ['reextract'], updatedAt: '2026-10-04T00:00:00Z' },
      { status: 'failed', code: 'MEMORY_WRITE_REJECTED', turnId: 't0', message: '记忆服务拒绝了同步请求。', resolution: 'settled', actions: [], acknowledgedAt: '2026-10-04T00:00:00Z' },
    ]
    const row = { sessionId: 's', title: '第一章', archivedAt: null, status: 'attention', turns: 3, completedTurns: 0, writes: 3, incremental: 0, pending: 0, attention: 1, settledLoss: 2, retained: 0,
      evidence: { records: 0, completed: 0, extracted: 0, indexed: 0, indexPending: 0, indexIssues: 0 }, lastSuccessAt: null, issues: [unresolved], history }
    const status = { projectId: 'p', status: 'attention', health: 'degraded', completedTurns: 0, incremental: 0, pending: 0, attention: 1, settledLoss: 2, retained: 0,
      evidence: row.evidence, counts: {}, lastSuccessAt: null, summary: null, sessions: [row] }
    const calls: { path: string; body?: unknown }[] = []
    setTransport({ kind: 'live', async request<T>(path: string, init?: { method?: string; body?: unknown }) {
      calls.push({ path, body: init?.body })
      if (path.endsWith('/reextract')) return ((init?.body as { confirm?: string }).confirm ? { status: 'queued', paid: true, messages: 2, characters: 40 } : { status: 'confirm_required', paid: true, confirm: 'c'.repeat(32), messages: 2, characters: 40 }) as T
      return status as T
    }, openStream() { throw new Error('unused') } })
    await render(createElement(MemorySyncPanel, { projectId: 'p' }))
    await act(async () => { host.querySelector('button')!.click() }); await flush()
    expect(host.querySelector('[data-memory-sync-detail]')?.textContent).toContain('1 段还在核对')
    expect(host.querySelector('[data-memory-sync-detail]')?.textContent).toContain('2 段没有同步成功')
    expect([...host.querySelectorAll('[data-memory-sync-history]')].map(node => node.getAttribute('data-memory-sync-history'))).toEqual(['MEMORY_EXTRACTION_FAILED', 'MEMORY_WRITE_REJECTED'])
    // Only the failed extraction offers anything, and it is the optional paid one: no 知道了 anywhere.
    expect([...host.querySelectorAll('[data-memory-sync-action]')].map(button => button.getAttribute('data-memory-sync-action'))).toEqual(['reextract'])
    expect(host.textContent).not.toContain('知道了')
    const click = async (selector: string) => { await act(async () => { (host.querySelector(selector) as HTMLButtonElement).click() }); await flush() }
    await click('[data-memory-sync-action="reextract"]')
    expect(calls.at(-1)).toEqual({ path: '/api/v2/projects/p/memory-sync/reextract', body: { sessionId: 's', turnId: 't1' } })
    expect(host.querySelector('[data-memory-sync-confirm]')?.textContent).toContain('2 条消息')
    const confirm = [...host.querySelectorAll('[data-memory-sync-confirm] button')].find(button => button.textContent === '确认重新提炼') as HTMLButtonElement
    await act(async () => { confirm.click() }); await flush()
    expect(calls.find(call => call.path.endsWith('/reextract') && (call.body as { confirm?: string }).confirm)?.body).toEqual({ sessionId: 's', turnId: 't1', confirm: 'c'.repeat(32) })
    expect(calls.some(call => call.path.endsWith('/acknowledge'))).toBe(false)
  })

  it('the memory page notes the summary upkeep in the interface language, never the host’s Chinese line or an alarm (A2)', async () => {
    const { summaryStatusMessage } = await import('@/components/memory/memory-display')
    const { usePreferences } = await import('@/components/settings/preferences')
    // What the host records on the row; Chinese only, and its failed line predates the A2 split.
    const recorded = { failed: '目录摘要尚未整理完整；原文未被删除，不会自动重复付费重建。', uncertain: '目录摘要请求结果待核对；先只读核对目录，不会盲目重复提交可能已经付费的请求。' }
    expect(summaryStatusMessage({ status: 'failed', message: recorded.failed } as { status: string })).toBe('目录摘要整理未完成。仍可浏览目录查看原文。')
    expect(summaryStatusMessage({ status: 'uncertain', message: recorded.uncertain } as { status: string })).toBe('目录摘要的整理结果还在核对。仍可浏览目录查看原文。')
    expect(summaryStatusMessage({ status: 'completed' })).toBeNull()
    expect(summaryStatusMessage(null)).toBeNull()
    usePreferences.setState({ language: 'en' })
    try {
      expect(summaryStatusMessage({ status: 'failed', message: recorded.failed } as { status: string })).toBe('The directory summary did not finish. You can still browse the directory to read originals.')
      expect(summaryStatusMessage({ status: 'uncertain', message: recorded.uncertain } as { status: string })).toBe('The directory summary result is still being checked. You can still browse the directory to read originals.')
    } finally { usePreferences.setState({ language: 'zh' }) }
  })
})

describe('terminal (C2, C8)', () => {
  it('新建终端 creates the terminal again after a failed create', async () => {
    const { default: TerminalTab } = await import('@/components/side-panel/TerminalTab')
    const creates: string[] = []
    setTransport({ kind: 'live', async request<T>(path: string) {
      creates.push(path)
      if (creates.length === 1) throw new ApiError('limit', 409, 'TERMINAL_LIMIT')
      return new Promise<T>(() => {})
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ capabilities: { terminal: true } as never, projects: { p: { id: 'p', name: 'p', permissions: { workspace: 'execute', background: 'read' } } as never } })
    await render(createElement(Tooltip.Provider, null, createElement(TerminalTab, { tab: { id: 't1', type: 'terminal', projectId: 'p', terminalId: null, title: null } as never, active: true })))
    expect(host.textContent).toContain('终端数量已达上限')
    const again = [...host.querySelectorAll('button')].find(button => button.textContent === '新建终端')!
    await act(async () => { again.click() }); await flush()
    expect(creates).toHaveLength(2)
    expect(host.textContent).not.toContain('终端数量已达上限')
  })
  it('names the permission the way the permissions dialog does', async () => {
    const { default: TerminalTab } = await import('@/components/side-panel/TerminalTab')
    useApp.setState({ capabilities: { terminal: true } as never, projects: { p: { id: 'p', name: 'p', permissions: { workspace: 'write', background: 'read' } } as never } })
    await render(createElement(TerminalTab, { tab: { id: 't1', type: 'terminal', projectId: 'p', terminalId: null, title: null } as never, active: true }))
    expect(host.textContent).toContain('「读写并执行命令」')
    expect(host.textContent).not.toContain('完全访问')
  })
})

describe('HTML run preview (C6)', () => {
  it('says it is starting and does not start twice on a repeated click', async () => {
    const { openFilePreview } = await import('@/components/preview/open')
    const calls: string[] = []
    let finish: (value: unknown) => void = () => {}
    setTransport({ kind: 'live', async request<T>(path: string, init?: { method?: string }) {
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (init?.method === 'POST') return new Promise<T>(resolve => { finish = resolve as never })
      return { status: 'stopped' } as T
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never } })
    openFilePreview('p', 'report.html'); await flush()
    expect(toasts()).toContain('正在启动预览…')
    openFilePreview('p', 'report.html'); await flush()
    expect(toasts()).toContain('预览正在启动，请稍候…')
    expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1)
    await act(async () => { finish({ status: 'unavailable' }) }); await flush()
    expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(2)
    await act(async () => { finish({ status: 'unavailable' }) }); await flush()
    expect(toasts()).not.toContain('正在启动预览…')
    expect(toasts()).toContain('暂未找到可运行的预览入口，已改为静态查看（不运行脚本）。')
  })
})

describe('HTML run preview: a second file (C6)', () => {
  it('opens every HTML file of the project: the quick check holds nothing, and a file asked for while it starts opens after that one start', async () => {
    const { openFilePreview } = await import('@/components/preview/open')
    const { useSidePanel } = await import('@/store/side-panel-store')
    const opened: string[] = []
    const unsubscribe = useSidePanel.subscribe(state => {
      for (const tab of Object.values(state.layout.tabs)) {
        if (tab.type === 'browser' && tab.key === 'preview:q' && tab.url && tab.url !== opened.at(-1)) opened.push(tab.url)
      }
    })
    const ready = { status: 'ready', kind: 'static', url: 'http://127.0.0.1:5999/t/index.html', entryPath: 'index.html' }
    let status: Record<string, unknown> = ready
    const posts: string[] = []
    let finish: (value: unknown) => void = () => {}
    setTransport({ kind: 'live', async request<T>(path: string, init?: { method?: string }) {
      if (init?.method === 'POST') { posts.push(path); return new Promise<T>(resolve => { finish = resolve as never }) }
      return status as T
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ projects: { q: { id: 'q', name: 'q', workspacePath: '/w' } as never } })
    try {
      openFilePreview('q', 'a.html'); openFilePreview('q', 'b.html'); await flush()
      expect(opened).toEqual(['http://127.0.0.1:5999/t/a.html', 'http://127.0.0.1:5999/t/b.html'])
      expect(posts).toEqual([])

      status = { status: 'stopped' }
      openFilePreview('q', 'c.html'); await flush()
      openFilePreview('q', 'd.html'); await flush()
      expect(posts).toHaveLength(1)
      expect(toasts()).toContain('预览正在启动，请稍候…')
      await act(async () => { finish(ready) }); await flush()
      expect(opened.slice(-2)).toEqual(['http://127.0.0.1:5999/t/c.html', 'http://127.0.0.1:5999/t/d.html'])
      expect(posts).toHaveLength(1)
    } finally { unsubscribe() }
  })
})

describe('files view while a run preview is live (C4, C6)', () => {
  it('updates the tree in place, keeps the open file and the chosen pane, and reads the open file again in place on a change, a same-size edit included', async () => {
    const { FilesView } = await import('@/components/views/FilesView')
    let revision = 1, content = '# A', hold: Promise<void> | null = null
    const reads: string[] = []
    setTransport({ kind: 'live', async request<T>(path: string): Promise<T> {
      const url = new URL(path, 'http://x')
      if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
      if (url.pathname.endsWith('/preview')) return { status: 'ready', kind: 'static', url: 'http://127.0.0.1:5999/t/index.html', entryPath: 'index.html', generation: 'g', revision } as T
      if (url.pathname.endsWith('/files')) return { path: '', entries: [{ name: 'a.md', path: 'a.md', type: 'file', size: 3 }, { name: 'index.html', path: 'index.html', type: 'file', size: 9 }] } as T
      if (url.pathname.endsWith('/git')) return { repo: 'none', files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } as T
      reads.push(url.searchParams.get('path') ?? '')
      if (hold) await hold
      return { path: 'a.md', content, bytes: 3, truncated: false } as T
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never } })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await render(createElement(Tooltip.Provider, null, createElement(FilesView, { projectId: 'p', sessionId: null })))
    const row = host.querySelector('[data-file-path="a.md"]') as HTMLButtonElement
    await act(async () => { row.click() }); await flush()
    const heading = () => host.querySelector('.md-doc h1')?.textContent
    expect(reads).toEqual(['a.md']); expect(heading()).toBe('A')
    const preview = host.querySelector('[data-preview-kind]')
    const list = [...host.querySelectorAll('[role="tab"], button')].find(button => button.textContent === '文件列表') as HTMLButtonElement
    await act(async () => { list.click() }); await flush()
    const contentPane = () => host.querySelector('section[aria-label="文件内容"]')!.className
    expect(contentPane().split(' ')).toContain('hidden')

    // The agent rewrites the open file with the same byte size: it is read again, and the old text stays on screen
    // (no loading blank) until the new one arrives.
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
    expect(contentPane().split(' ')).toContain('hidden')

    // A change elsewhere: the open file is read once more and, unchanged, stays exactly as rendered.
    const shown = host.querySelector('.md-doc h1')
    revision = 3
    await act(async () => { vi.advanceTimersByTime(1500) }); await flush()
    expect(reads).toEqual(['a.md', 'a.md', 'a.md'])
    expect(host.querySelector('.md-doc h1')).toBe(shown)
  })

  it('shows 运行预览 as starting and starts once while the host boots the service', async () => {
    const { FilesView } = await import('@/components/views/FilesView')
    const starts: string[] = []
    let finish: (value: unknown) => void = () => {}
    setTransport({ kind: 'live', async request<T>(path: string, init?: { method?: string }): Promise<T> {
      const url = new URL(path, 'http://x')
      if (init?.method === 'POST') { starts.push(path); return new Promise<T>(resolve => { finish = resolve as never }) }
      if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
      if (url.pathname.endsWith('/preview')) return { status: 'stopped' } as T
      return { path: '', entries: [] } as T
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never } })
    await render(createElement(Tooltip.Provider, null, createElement(FilesView, { projectId: 'p', sessionId: null })))
    const button = () => [...host.querySelectorAll('button')].find(b => /运行预览|正在启动预览/.test(b.textContent ?? '')) as HTMLButtonElement
    await act(async () => { button().click() }); await flush()
    expect(button().textContent).toBe('正在启动预览…'); expect(button().disabled).toBe(true)
    await act(async () => { button().click() }); await flush()
    expect(starts).toHaveLength(1)
    await act(async () => { finish({ status: 'unavailable' }) }); await flush()
    expect(button().textContent).toBe('运行预览')
  })

  it('运行预览 and an opened HTML file share one start, whichever came first', async () => {
    const { FilesView } = await import('@/components/views/FilesView')
    const { openFilePreview } = await import('@/components/preview/open')
    const starts: string[] = []
    let finish: (value: unknown) => void = () => {}
    setTransport({ kind: 'live', async request<T>(path: string, init?: { method?: string }): Promise<T> {
      const url = new URL(path, 'http://x')
      if (init?.method === 'POST') { starts.push(path); return new Promise<T>(resolve => { finish = resolve as never }) }
      if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
      if (url.pathname.endsWith('/preview')) return { status: 'stopped' } as T
      return { path: '', entries: [] } as T
    }, openStream() { throw new Error('unused') } })
    useApp.setState({ projects: { r: { id: 'r', name: 'r', workspacePath: '/w' } as never } })
    await render(createElement(Tooltip.Provider, null, createElement(FilesView, { projectId: 'r', sessionId: null })))
    const button = () => [...host.querySelectorAll('button')].find(b => /运行预览|正在启动预览/.test(b.textContent ?? '')) as HTMLButtonElement
    const ready = { status: 'ready', kind: 'static', url: 'http://127.0.0.1:5999/t/index.html', entryPath: 'index.html' }

    // An HTML deliverable starts it: the 文件 page shows that start and cannot send another.
    openFilePreview('r', 'report.html'); await flush()
    expect(starts).toHaveLength(1)
    expect(button().textContent).toBe('正在启动预览…'); expect(button().disabled).toBe(true)
    await act(async () => { finish(ready) }); await flush()
    expect(button().textContent).toBe('运行预览')

    // 运行预览 starts it: an HTML file opened meanwhile joins that start.
    await act(async () => { button().click() }); await flush()
    openFilePreview('r', 'other.html'); await flush()
    expect(starts).toHaveLength(2)
    expect(toasts()).toContain('预览正在启动，请稍候…')
    await act(async () => { finish(ready) }); await flush()
    expect(starts).toHaveLength(2)
  })
})

describe('file preview after a passing failure (F22)', () => {
  const files = (read: () => Promise<unknown>) => setTransport({ kind: 'live', async request<T>(path: string): Promise<T> {
    if (new URL(path, 'http://x').pathname.endsWith('/files')) return { path: '', entries: [{ name: 'a.md', path: 'a.md', type: 'file', size: 3 }] } as T
    return read() as Promise<T>
  }, openStream() { throw new Error('unused') } })
  it('reads again once maintenance ends', async () => {
    const { FilePreview } = await import('@/components/preview/FilePreview')
    let calls = 0
    files(async () => { if (++calls === 1) throw new ApiError('应用维护期间暂不开始新工作，草稿已保留。', 503, 'maintenance_held'); return { path: 'a.md', content: '# A', bytes: 3, truncated: false } })
    useApp.setState({ connection: 'online', maintenanceHeld: true })
    await render(createElement(Tooltip.Provider, null, createElement(FilePreview, { projectId: 'p', path: 'a.md', size: 3 })))
    expect(host.textContent).toContain('无法打开此文件')
    await act(async () => { useApp.setState({ maintenanceHeld: false }) }); await flush()
    expect(calls).toBe(2)
    expect(host.querySelector('.md-doc h1')?.textContent).toBe('A')
  })
  it('does not retry a missing file', async () => {
    const { FilePreview } = await import('@/components/preview/FilePreview')
    let calls = 0
    files(async () => { calls++; throw new ApiError('文件或目录不存在。', 404, 'WORKSPACE_NOT_FOUND') })
    useApp.setState({ connection: 'online', maintenanceHeld: true })
    await render(createElement(Tooltip.Provider, null, createElement(FilePreview, { projectId: 'p', path: 'a.md', size: 3 })))
    await act(async () => { useApp.setState({ maintenanceHeld: false }) }); await flush()
    expect(calls).toBe(1)
    expect(host.textContent).toContain('文件不存在或已被移动')
  })
})
