/**
 * 0.63 in the 工作区改动 panel and the dialogs (worktree design §10, §12): 应用记录 with patches and two-step
 * rollback, Rna 工作树 with apply / discard, pages asked for from elsewhere, a worktree conversation's own copy
 * shown by default, git init for a plain folder, and the project settings' 工作树与 Git. Answered by the mock
 * daemon's own stores (?mock=1), so the shapes are the contract's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { ProjectSummary, Session } from '@/api/types'
import type { GitInitPreview } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetIsolation } from '@/store/isolation-store'
import { resetSidePanel } from '@/store/side-panel-store'
import { resetGitStatus } from '@/lib/workspace-changes'
import { GitMockStore } from '@/mock/git-routes'
import { WorktreeMockStore } from '@/mock/worktree-routes'
import { getPanel } from '@/components/workspace/registry'
import '@/components/workspace/panels-worktree'
import { ProjectSettingsBody } from '@/components/projects/ProjectSettingsDialog'
import { GitInitDialog, addedLine, rowsOf, tickedLines, withCounts } from '@/components/git/GitInitDialog'
import { ApplyHistory } from './ApplyHistory'
import { RnaWorktrees } from './RnaWorktrees'
import { requestSheet } from './sheets'

vi.mock('@/lib/highlight', async original => ({ ...await original<typeof import('@/lib/highlight')>(), cachedTokens: () => undefined, highlight: async () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/Users/me/Documents/独立开发项目/Pi_agent'
const projects: ProjectSummary[] = [
  { id: 'p-agent', name: 'Rna Agent', workspacePath: ROOT, permissions: { workspace: 'execute' }, git: { sessionWorktreeDefault: false } },
  { id: 'p-ink', name: '水墨飞鸟', workspacePath: '/Users/me/Projects/ink-bird', permissions: { workspace: 'write' } },
]
let calls: { method: string; path: string; body?: unknown }[] = []
let git: GitMockStore, isolation: WorktreeMockStore
const sessions: Session[] = []
function backend() {
  git = new GitMockStore()
  isolation = new WorktreeMockStore({
    projects: () => projects, session: id => sessions.find(s => s.id === id), upsertAgent: () => null,
    gitInit: id => git.init(id), isRepository: id => git.isRepository(id), touchProject: () => {},
  }, { enabled: true })
}
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET', body = (init.body ?? {}) as Record<string, unknown>
    calls.push({ method, path, body: init.body })
    const url = new URL(path, 'http://mock')
    const answer = isolation.handle(method, url, body) ?? git.handle(method, url, body)
    if (answer !== undefined) return answer as T
    if (method === 'PATCH' && /^\/api\/projects\/[^/]+$/.test(url.pathname)) return {} as T
    if (url.pathname.includes('/v2/projects/') && method === 'GET') return {} as T
    throw new Error(`unexpected ${method} ${path}`)
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 900 })
  Element.prototype.scrollIntoView ??= () => {}
  calls = []; backend(); setTransport(transport)
  resetIsolation(); resetGitStatus(); resetSidePanel(); useUi.setState({ toasts: [] })
  useApp.setState({ status: 'ready', projects: Object.fromEntries(projects.map(p => [p.id, structuredClone(p)])), projectOrder: projects.map(p => p.id), sessionIndex: {}, sessions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); if (saved) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved); vi.useRealTimers() })

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const show = async (node: ReactNode) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await settle() }
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const posts = (part: string) => calls.filter(call => call.method === 'POST' && call.path.includes(part)).map(call => call.body)

describe('应用记录', () => {
  it('lists every write into the folder, newest first; a record opens on its files and their patches', async () => {
    await show(createElement(ApplyHistory, { projectId: 'p-agent' }))
    const rows = [...host.querySelectorAll('[data-apply]')].map(row => row.getAttribute('data-apply'))
    expect(rows).toEqual(['ap-old-1', 'ap-rb-1', 'ap-worker-1', 'ap-bg-1'])
    const bg = host.querySelector('[data-apply="ap-bg-1"]')!
    expect(bg.textContent).toContain('后台应用')
    await click(bg.querySelector('button[aria-expanded]'))
    expect(bg.querySelectorAll('[data-apply-files] [data-path]')).toHaveLength(2)
    await click(bg.querySelector('[data-path="docs/notes/isolation.md"]'))
    expect(calls.some(call => call.path.includes('/applies/ap-bg-1/patches?path=docs%2Fspecs%2Fstream-protocol-v2.md&path=docs%2Fnotes%2Fisolation.md'))).toBe(true)
    expect(bg.textContent).toContain('新的一行')
    // A record already rolled back offers nothing; the rollback record can itself be undone.
    expect(host.querySelector('[data-apply="ap-old-1"] [data-apply-rollback]')).toBeNull()
    expect(host.querySelector('[data-apply="ap-rb-1"] [data-apply-rollback]')?.textContent).toBe('撤销回退')
  })

  it('a write into a conversation’s worktree (kept for crash recovery) says where it went and offers no rollback', async () => {
    isolation.applyTurn({ id: 's-w', projectId: 'p-agent', worktree: { id: 'wt-s', state: 'active' } } as unknown as Session, 't-w', ['src/a.ts'])
    await show(createElement(ApplyHistory, { projectId: 'p-agent' }))
    const rows = [...host.querySelectorAll('[data-apply]')]
    const inWorktree = rows.find(row => row.querySelector('[data-apply-target]'))!
    expect(inWorktree.querySelector('[data-apply-target]')?.textContent).toBe('写进对话的工作树')
    expect(inWorktree.querySelector('[data-apply-rollback]')).toBeNull()
    expect(rows.filter(row => row.querySelector('[data-apply-target]'))).toHaveLength(1)
  })

  it('a record asked for from elsewhere that is not the conversation’s (a background apply) is shown, not filtered away', async () => {
    await show(createElement(ApplyHistory, { projectId: 'p-agent', sessionId: 's-plan', focus: 'ap-bg-1' }))
    expect(host.querySelector('[data-apply="ap-bg-1"]')).not.toBeNull()
    expect(host.querySelector<HTMLInputElement>('[data-apply-history] input[type="checkbox"]')?.checked).toBe(false)
    // Without a focus, the conversation's own records only.
    act(() => root.unmount()); root = createRoot(host)
    await show(createElement(ApplyHistory, { projectId: 'p-agent', sessionId: 's-plan' }))
    expect([...host.querySelectorAll('[data-apply]')].map(row => row.getAttribute('data-apply'))).toEqual(['ap-old-1', 'ap-rb-1', 'ap-worker-1'])
  })

  it('a rollback is two steps; the list is read again after it', async () => {
    await show(createElement(ApplyHistory, { projectId: 'p-agent', focus: 'ap-bg-1' }))
    expect(host.querySelector('[data-apply="ap-bg-1"] [data-apply-files]')).not.toBeNull()
    await click(host.querySelector('[data-apply="ap-bg-1"] [data-apply-rollback]'))
    expect(posts('/applies/ap-bg-1/rollback')).toEqual([{}])
    expect(host.querySelector('[data-two-step]')?.textContent).toContain('docs/notes/isolation.md')
    const reads = calls.filter(call => call.path.includes('/applies?')).length
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts('/applies/ap-bg-1/rollback')[1]).toMatchObject({ confirm: expect.any(String) })
    expect(calls.filter(call => call.path.includes('/applies?')).length).toBe(reads + 1)
    expect(host.querySelector('[data-apply="ap-bg-1"]')?.getAttribute('data-apply-state')).toBe('rolled_back')
    // The rollback undone in turn: that record says 撤销回退, and rolling it back is 再次回退.
    const rollback = host.querySelector('[data-apply-state="verified"] [data-apply-rollback]')!
    expect(rollback.textContent).toBe('撤销回退')
    await click(rollback)
    await click(host.querySelector('[data-two-step-confirm]'))
    const undo = [...host.querySelectorAll('[data-apply]')][0]
    expect(undo.textContent).toContain('撤销回退')
    expect(undo.querySelector('[data-apply-rollback]')?.textContent).toBe('再次回退')
    expect(host.querySelector('[data-apply="ap-bg-1"]')?.getAttribute('data-apply-state')).toBe('verified')
  })
})

describe('Rna 工作树', () => {
  it('says isolation is on, lists the kept and unrecorded worktrees, and applies one in two steps', async () => {
    const viewed: string[] = []
    await show(createElement(RnaWorktrees, { projectId: 'p-agent', onView: path => viewed.push(path) }))
    expect(host.querySelector('[data-isolation="on"]')).not.toBeNull()
    const kept = host.querySelector('[data-worktree-row="wt-kept01"]')!
    expect(kept.textContent).toContain('3 个文件还没应用到项目文件夹')
    await click(kept.querySelector('[data-worktree-view]'))
    expect(viewed).toEqual([`${ROOT}/.rna/worktrees.nosync/s-kept01`])
    await click(kept.querySelector('[data-worktree-apply]'))
    expect(host.querySelectorAll('[data-two-step-files] li')).toHaveLength(3)
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts('/worktrees/wt-kept01/apply')).toEqual([{}, { confirm: expect.any(String) }])
    // Applied worktrees are removed and leave the list.
    expect(host.querySelector('[data-worktree-row="wt-kept01"]')).toBeNull()
  })

  it('a row the host could not place (no path: the folder or its repository is gone) still lists, without 查看', async () => {
    isolation.worktrees.push({ id: 'wt-lost', kind: 'orphan', owner: {}, path: null, state: 'kept', createdAt: '', pending: { files: 0 } })
    await show(createElement(RnaWorktrees, { projectId: 'p-agent', onView: () => {} }))
    const row = host.querySelector('[data-worktree-row="wt-lost"]')!
    expect(row.textContent).toContain('wt-lost')
    expect(row.querySelector('[data-worktree-view]')).toBeNull()
  })

  it('secret files a worktree\'s owner changed (B8) are counted apart; the discard lists them with the host\'s note, which the outcome repeats', async () => {
    isolation.worktrees.push({ id: 'wt-key', kind: 'worker', owner: { agentId: 'agent-key00001' }, path: `${ROOT}/.rna/worktrees.nosync/w-key00001`, state: 'kept', createdAt: '', pending: { files: 0, secret: 1 } })
    await show(createElement(RnaWorktrees, { projectId: 'p-agent' }))
    const row = host.querySelector('[data-worktree-row="wt-key"]')!
    expect(row.querySelector('[data-worktree-secret]')?.textContent).toBe('1 个存放密钥的文件不会应用，只在工作树里')
    expect(row.textContent).not.toContain('还没应用到项目文件夹')
    await click(row.querySelector('[data-worktree-discard]'))
    const card = host.querySelector('[data-two-step]')!
    expect([...card.querySelectorAll('[data-two-step-files] li')].map(li => li.textContent)).toEqual(['.env修改'])
    expect(card.textContent).toContain('丢弃时它们移到项目文件夹的 .rna/trash.nosync')
    await click(card.querySelector('[data-two-step-confirm]'))
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已丢弃这个工作树。存放密钥的文件已移到项目文件夹的 .rna/trash.nosync，保留 7 天：.env。')
  })

  it('the project settings list only the ones waiting on the user', async () => {
    await show(createElement(RnaWorktrees, { projectId: 'p-agent', filter: 'kept' }))
    expect([...host.querySelectorAll('[data-worktree-row]')].map(row => row.getAttribute('data-worktree-row'))).toEqual(['wt-kept01', 'wt-orphan'])
  })
})

describe('the panel', () => {
  const panel = (sessionId: string | null, projectId = 'p-agent') => getPanel('worktree')!.render({ id: 'w', type: 'worktree', projectId: null, binding: 'workspace' }, { sessionId, projectId, visible: true, groupId: 'g' })

  it('opens 应用记录 or Rna 工作树 when asked from elsewhere, and goes back to the changes', async () => {
    await show(panel(null))
    await act(async () => { requestSheet('p-agent', 'applies', { focus: 'ap-worker-1' }) }); await settle()
    expect(host.querySelector('[data-apply-history]')).not.toBeNull()
    expect(host.querySelector('[data-apply="ap-worker-1"] [data-apply-files]')).not.toBeNull()
    await act(async () => { requestSheet('p-agent', 'worktrees') }); await settle()
    expect(host.querySelector('[data-rna-worktrees]')).not.toBeNull()
    await click(button('返回改动', host))
    expect(host.querySelector('[data-rna-worktrees]')).toBeNull()
  })

  it('a worktree conversation’s panel shows its own copy; 返回项目文件夹 keeps the folder for it', async () => {
    const meta = { id: 's-w', title: 'W', status: 'idle', projectId: 'p-agent', worktree: { id: 'wt-kept01', state: 'active' } }
    useApp.setState({ sessionIndex: { 's-w': meta } as never })
    await show(panel('s-w'))
    await settle()
    const bar = host.querySelector('[data-conversation-worktree]')
    expect(bar?.getAttribute('data-other-worktree')).toBe(`${ROOT}/.rna/worktrees.nosync/s-kept01`)
    expect(bar?.textContent).toContain('这个对话的工作树')
    await click(button('返回项目文件夹', host))
    expect(host.querySelector('[data-other-worktree]')).toBeNull()
  })

  it('a plain folder offers 初始化…, which opens the two-step git init', async () => {
    await show(panel(null, 'p-ink'))
    await click(host.querySelector('[data-git-init]'))
    expect(document.querySelector('[data-git-init-files]')).not.toBeNull()
    expect(posts('/git/init')).toEqual([{}])
  })
})

describe('git init', () => {
  it('previews without writing; an unticked line is previewed again with the lines; 初始化 sends them with the token', async () => {
    let closed = false
    await show(createElement(GitInitDialog, { projectId: 'p-ink', open: true, onClose: () => { closed = true } }))
    expect(document.querySelector('[data-git-init-files]')?.getAttribute('data-git-init-files')).toBe('412')
    expect(git.isRepository('p-ink')).toBe(false)
    // A line for files that hold secrets (B8) is labelled as such.
    const pem = [...document.querySelectorAll('[data-git-init-lines] li')].find(row => row.textContent?.includes('*.pem'))
    expect(pem?.textContent).toContain('存放密钥的文件')
    const build = [...document.querySelectorAll<HTMLInputElement>('[data-git-init-lines] input')].find(input => input.getAttribute('aria-label') === '写入 build/')!
    await act(async () => { build.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) }); await settle()
    const lines = (posts('/git/init')[1] as { lines: string[] }).lines
    expect(lines).not.toContain('build/')
    expect(lines).toContain('.env*')
    expect(document.querySelector('[data-git-init-files]')?.getAttribute('data-git-init-files')).toBe('450')
    await click(document.querySelector('[data-git-init-confirm]'))
    expect(posts('/git/init')[2]).toEqual({ confirm: expect.any(String), lines })
    expect(git.isRepository('p-ink')).toBe(true)
    expect(closed).toBe(true)
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已初始化：分支 main，提交了 450 个文件。')
  })

  it('a folder git refuses says why (already a repository)', async () => {
    await show(createElement(GitInitDialog, { projectId: 'p-agent', open: true, onClose: () => {} }))
    expect(document.querySelector('[data-git-init-error]')?.getAttribute('data-git-init-error')).toBe('git_init_already')
  })

  it('a missing committer must be filled in, and a very large folder acknowledged, before 初始化', async () => {
    const preview: GitInitPreview = {
      confirm: 'c'.repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString(), folder: '/f', branch: 'main', identity: null, identityRequired: true,
      gitignore: { exists: true, lines: [{ text: '.DS_Store', rule: 'always' }] }, files: { count: 25_000, bytes: 3e9, largest: [] }, largeFiles: [], nested: [], needsAcknowledge: true, icloud: true, outer: null,
    }
    const sent: unknown[] = []
    setTransport({ ...transport, async request<T>(path: string, init: RequestInit = {}) {
      if (!path.endsWith('/git/init')) return {} as T
      sent.push(init.body)
      return ((init.body as { confirm?: string }).confirm ? { commit: 'x', branch: 'main', files: 25_000, largeFiles: [], status: 'clean' } : preview) as T
    } })
    await show(createElement(GitInitDialog, { projectId: 'p-ink', open: true, onClose: () => {} }))
    const confirm = document.querySelector<HTMLButtonElement>('[data-git-init-confirm]')!
    expect(confirm.disabled).toBe(true)
    const [name, email] = document.querySelectorAll<HTMLInputElement>('[data-git-init-identity] input')
    const type = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    await type(name, 'Me'); await type(email, 'me@example.com')
    expect(confirm.disabled).toBe(true)
    await act(async () => { document.querySelector<HTMLInputElement>('[data-git-init-ack]')!.click() })
    expect(confirm.disabled).toBe(false)
    await click(confirm)
    expect(sent.at(-1)).toEqual({ confirm: 'c'.repeat(32), identity: { name: 'Me', email: 'me@example.com' }, acknowledgeLarge: true })
  })

  it('edited lines the host refuses say why in the dialog, and 初始化 waits until they pass (its token names other lines)', async () => {
    await show(createElement(GitInitDialog, { projectId: 'p-ink', open: true, onClose: () => {} }))
    const box = () => [...document.querySelectorAll<HTMLInputElement>('[data-git-init-lines] input')].find(input => input.getAttribute('aria-label') === '写入 /vendor/three-ext/')!
    const wait = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) }); await settle() }
    await act(async () => { box().click() }); await wait()
    expect(document.querySelector('[data-git-init-refused]')?.getAttribute('data-git-init-refused')).toBe('git_init_lines_invalid')
    expect(document.querySelector('[data-git-init-refused]')?.textContent).toContain('vendor/three-ext')
    expect(document.querySelector<HTMLButtonElement>('[data-git-init-confirm]')?.disabled).toBe(true)
    await act(async () => { box().click() }); await wait()
    expect(document.querySelector('[data-git-init-refused]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-git-init-confirm]')?.disabled).toBe(false)
  })

  it('a failed 初始化 says what the host undid and how the commit would have differed, and previews again for a new token', async () => {
    let n = 0
    const sent: unknown[] = []
    setTransport({ ...transport, async request<T>(path: string, init: RequestInit = {}) {
      if (!path.endsWith('/git/init')) return {} as T
      sent.push(init.body)
      if ((init.body as { confirm?: string }).confirm) {
        throw new ApiError('初始化没有完成：加入的文件和预览不一致（多了 1 个，少了 0 个）。.git 已移到 .rna/trash.nosync/init-x.git。', 500, 'git_init_failed', { stage: 'compare', differences: { unexpected: ['secret.env'], missing: [] }, undone: { git: 'trash' } }) // i18n-ignore: host text in a test
      }
      return { confirm: `t${++n}`.padEnd(32, '0'), expiresAt: new Date(Date.now() + 60_000).toISOString(), folder: '/f', branch: 'main', identity: { name: 'Me', email: 'me@example.com' }, identityRequired: false,
        gitignore: { exists: false, lines: [{ text: '.DS_Store', rule: 'always' }] }, files: { count: 3, bytes: 10, largest: [] }, largeFiles: [], nested: [], needsAcknowledge: false, icloud: false, outer: null } as T
    } })
    await show(createElement(GitInitDialog, { projectId: 'p-ink', open: true, onClose: () => {} }))
    await click(document.querySelector('[data-git-init-confirm]'))
    const failed = document.querySelector('[data-git-init-failed]')!
    expect(failed.textContent).toContain('.git 已移到 .rna/trash.nosync/init-x.git')
    expect(failed.textContent).toContain('多出的文件：secret.env')
    // The token was used up: the preview is read again, and 初始化 sends the new one.
    expect(sent).toEqual([{}, { confirm: 't1'.padEnd(32, '0') }, {}])
    await click(document.querySelector('[data-git-init-confirm]'))
    expect(sent.at(-2)).toEqual({ confirm: 't2'.padEnd(32, '0') })
  })

  it('line helpers: the ticked lines in order, counts from a new preview on the rows held, one new line at a time', () => {
    const preview = { gitignore: { exists: false, lines: [{ text: 'a/', rule: 'always', count: 1 }, { text: 'b/', rule: 'ecosystem', marker: 'package.json' }] } } as GitInitPreview
    const rows = rowsOf(preview)
    expect(tickedLines(rows)).toEqual(['a/', 'b/'])
    const edited = [{ ...rows[0], on: false }, rows[1], { text: 'c/', rule: 'user', on: true }]
    expect(tickedLines(edited)).toEqual(['b/', 'c/'])
    const next = { gitignore: { exists: false, lines: [{ text: 'b/', rule: 'ecosystem', count: 7, bytes: 9 }, { text: 'c/', rule: 'user', count: 2 }] } } as GitInitPreview
    expect(withCounts(edited, next).map(row => [row.text, row.on, row.count])).toEqual([['a/', false, 1], ['b/', true, 7], ['c/', true, 2]])
    expect(addedLine('  out/ ', rows)).toBe('out/')
    expect(addedLine('a/', rows)).toBeNull()
    expect(addedLine('# note', rows)).toBeNull()
    expect(addedLine('', rows)).toBeNull()
  })
})

describe('工作树与 Git (project settings)', () => {
  it('switches the new-conversation default through the project, and lists the kept worktrees', async () => {
    await show(createElement(ProjectSettingsBody, { projectId: 'p-agent', tab: 'git' }))
    await settle()
    const toggle = document.querySelector<HTMLButtonElement>('[data-project-git] [role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(calls.find(call => call.method === 'PATCH')).toMatchObject({ path: '/api/projects/p-agent', body: { git: { sessionWorktreeDefault: true } } })
    expect(useApp.getState().projects['p-agent'].git?.sessionWorktreeDefault).toBe(true)
    expect(document.querySelectorAll('[data-project-git] [data-worktree-row]')).toHaveLength(2)
  })

  it('a plain folder offers git init; the default cannot be switched on where isolation is off', async () => {
    await show(createElement(ProjectSettingsBody, { projectId: 'p-ink', tab: 'git' }))
    await settle()
    expect(document.querySelector('[data-project-git] [data-git-init]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-project-git] [role="switch"]')!.disabled).toBe(true)
  })
})
