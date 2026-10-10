/** 工作区改动 (worktree design §3): the base → target comparison, its tree and stacked diffs, find, the menus, other worktrees, grouping by stage, and Rna's own records. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import type { GitBranches, GitCompare, GitCompareFile, GitStatus, GitWorktrees } from '@/api/git-api'
import type { Item, ProjectSummary } from '@/api/types'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { findTab, openTab, resetSidePanel, sanitizeTab, useSidePanel, type WorktreeTabFields } from '@/store/side-panel-store'
import { loadGitStatus, resetGitStatus } from '@/lib/workspace-changes'
import { getPanel } from '@/components/workspace/registry'
import '@/components/workspace/panels-worktree'
import { WorktreePanel, type WorktreePanelProps } from './WorktreePanel'
import { dirtySummary, gitRows, splitPath } from './model'
import { toggleWorktreeTree } from './tree-toggle'
import { resetApplyFiles } from './rna-model'
import { usePanelSheets } from './sheets'
import { useChangeDetail } from '@/store/change-detail-store'

vi.mock('@/lib/highlight', async original => ({ ...await original<typeof import('@/lib/highlight')>(), cachedTokens: () => undefined, highlight: async () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MERGE_BASE = 'a'.repeat(40)
const status = (patch: Partial<GitStatus> = {}): GitStatus => ({
  repo: 'main', branch: 'feature/x', detached: false, upstream: 'origin/feature/x', ahead: 2, behind: 1, operation: null, initial: false, untrackedMode: 'all',
  files: {
    conflicted: [{ path: 'src/merge.ts', status: 'U', added: null, removed: null }],
    staged: [{ path: 'docs/new name.md', oldPath: 'docs/old name.md', status: 'R', added: 1, removed: 1 }],
    unstaged: [
      { path: 'src/app/main.ts', status: 'M', added: 3, removed: 1 },
      { path: 'assets/logo.png', status: 'M', added: null, removed: null, binary: true },
    ],
    untracked: [{ path: 'notes/todo.md', status: '?', added: null, removed: null }],
  },
  ...patch,
})
const FILES: GitCompareFile[] = [
  { path: 'api/search/route.ts', status: 'A', added: 4, removed: 0 },
  { path: 'src/app/main.ts', status: 'M', added: 2, removed: 1 },
  { path: 'src/app/old.ts', status: 'D', added: 0, removed: 3 },
  { path: 'docs/new.md', oldPath: 'docs/old.md', status: 'R', added: 1, removed: 1 },
  { path: 'assets/logo.png', status: 'M', added: null, removed: null, binary: true },
  { path: 'data/huge.json', status: '?', added: 1500, removed: 0, untracked: true },
  { path: 'data/blob.bin', status: '?', added: null, removed: null, untracked: true },
]
const compare = (patch: Partial<GitCompare> = {}): GitCompare => ({
  repo: 'main', mode: 'all', base: 'main', defaultBase: 'main', mergeBase: MERGE_BASE, target: { kind: 'branch', label: 'feature/x' }, files: FILES, truncated: false, operation: null, ...patch,
})
/** A two-hunk patch for main.ts (12 unchanged lines between the hunks), else a one-hunk patch naming the file. */
function patchOf(path: string, full = false): string {
  if (full) return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,20 +1,21 @@\n${Array.from({ length: 20 }, (_, i) => (i === 4 ? '-old line\n+new line\n+second new' : ` line ${i + 1}`)).join('\n')}\n`
  if (path === 'src/app/main.ts') return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -2,3 +2,4 @@ function keep() {\n line 2\n-old line\n+new line\n+second new\n line 4\n@@ -17,2 +18,2 @@ function later() {\n line 17\n line 18\n`
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before ${path}\n+after ${path}\n`
}

let calls: string[] = [], answer: GitStatus = status(), listing: GitCompare = compare(), compareError: ApiError | null = null
let branches: GitBranches, worktrees: GitWorktrees, discardFails = false
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}${init.body ? ` ${JSON.stringify(init.body)}` : ''}`)
    const url = new URL(path, 'http://x')
    if (/\/git$/.test(url.pathname)) return (url.searchParams.get('worktree') ? status({ branch: 'claude/other', upstream: null }) : answer) as T
    if (url.pathname.endsWith('/git/compare')) { if (compareError) throw compareError; return { ...listing, mode: url.searchParams.get('mode') as GitCompare['mode'] } as T }
    if (url.pathname.endsWith('/git/patches')) return { patches: url.searchParams.getAll('path').map(p => ({ path: p, diff: p.endsWith('.bin') ? { kind: 'binary' } : { kind: 'patch', patch: patchOf(p) } })) } as T
    if (url.pathname.endsWith('/git/diff')) {
      const file = url.searchParams.get('path')!
      if (url.searchParams.get('source') === 'compare') return { kind: 'patch', patch: patchOf(file, url.searchParams.get('context') === 'all') } as T
      return (file.includes('logo') ? { kind: 'binary' } : { kind: 'patch', patch: patchOf(file) }) as T
    }
    if (url.pathname.endsWith('/git/branches')) return branches as T
    // 本次对话的改动: a change set's own files (before / after), a background-worktree set's apply record and its patches.
    if (url.pathname.endsWith('/background-changes/bg-1')) return { id: 'bg-1', actionId: 'a1', at: '', status: 'kept', skipped: 0, files: [{ path: 'lib/k.ts', created: false, deleted: false, changedSince: false, before: 'keep\nold k\n', after: 'keep\nnew k\nmore k\n', binary: false, truncated: false, available: true }] } as T
    if (url.pathname.endsWith('/applies/ap-bg')) return { id: 'ap-bg', kind: 'background', target: 'project', source: {}, state: 'verified', files: 1, added: 1, removed: 0, bothChanged: 0, sample: ['gen/out.ts'], at: '', rollback: { available: true }, paths: [{ path: 'gen/out.ts', status: 'A', added: 1, removed: 0 }] } as T
    if (url.pathname.endsWith('/applies/ap-bg/patches')) return { patches: url.searchParams.getAll('path').map(p => ({ path: p, diff: { kind: 'patch', patch: `diff --git a/${p} b/${p}\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+export const made = 1\n` } })) } as T
    if (url.pathname.endsWith('/git/worktrees')) return worktrees as T
    if (path.endsWith('/git/stage') || path.endsWith('/git/unstage')) return { status: status({ files: { ...answer.files, unstaged: [], untracked: [] } }) } as T
    if (path.endsWith('/git/discard')) {
      const body = init.body as { paths: string[]; confirm?: string }
      if (!body.confirm) return { confirm: 'c'.repeat(32), expiresAt: new Date(Date.now() + 120_000).toISOString(), files: body.paths.filter(p => !p.startsWith('vendor/')).map(p => ({ path: p, action: p.startsWith('notes') ? 'delete' : 'restore' })), ...(body.paths.some(p => p.startsWith('vendor/')) ? { kept: body.paths.filter(p => p.startsWith('vendor/')).map(p => ({ path: p, reason: 'repository' })) } : {}) } as T
      if (discardFails) throw new ApiError('这次确认已经失效，请重新点一次丢弃。', 409, 'git_discard_unconfirmed')
      return { discarded: [], status: status({ files: { ...answer.files, unstaged: [] } }) } as T
    }
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

const edit = (id: string, path: string, turnId: string): Item => ({ id, kind: 'tool', turnId, createdAt: '2026-10-03T10:00:00Z', tool: { name: 'project_edit', status: 'succeeded', args: { path, oldText: 'a', newText: 'b\nc' } } } as unknown as Item)
const project = (patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'p1', name: '仓库项目', workspacePath: '/w/p1', permissions: { workspace: 'write' },
  backgroundChanges: [{ id: 'bg-1', actionId: 'a1', at: new Date().toISOString(), status: 'kept', count: 9, paths: ['lib/k.ts'] }],
  work: { running: [], recent: [{ id: 'a1', kind: 'work', title: '整理测试报告', status: 'completed', createdAt: '', steps: { total: 1, completed: 1, failed: 0, uncertain: 0, limit: null, kinds: { read: 0, search: 0, edit: 1, write: 0, command: 0, web: 0, other: 0 } }, latest: null, tokens: { total: 0, estimated: false }, model: null, changeId: 'bg-1' }] },
  ...patch,
})

let root: Root, host: HTMLDivElement
let changes: WorktreeTabFields[] = []
// jsdom lays nothing out: the panel and its scroll boxes get a size (wide unless a test narrows it).
let panelWidth = 900
const saved = Object.fromEntries(['offsetHeight', 'offsetWidth'].map(key => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]))
const SCROLLERS = '[data-stacked-diff], [data-change-tree], [data-git-list]'
beforeEach(() => {
  panelWidth = 900
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.matches(SCROLLERS) ? 600 : this.hasAttribute('data-index') ? 80 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => panelWidth })
  // The scroll boxes are a panel tall; what they hold measures nothing, so every section is drawn.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.matches(SCROLLERS) ? 600 : 0
    return { x: 0, y: 0, top: 0, left: 0, right: panelWidth, bottom: height, width: panelWidth, height, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => { for (const [key, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor) })
beforeEach(() => {
  setTransport(transport); calls = []; answer = status(); listing = compare(); compareError = null; discardFails = false; changes = []
  branches = { current: 'feature/x', default: 'main', branches: [
    { name: 'main', sha: '1'.repeat(40), upstream: 'origin/main', committedAt: 1, worktreePath: null, current: false },
    { name: 'feature/x', sha: '2'.repeat(40), upstream: 'origin/feature/x', committedAt: 2, worktreePath: '/w/p1', current: true },
    { name: 'claude/a-very-long-branch-name-for-an-experiment-that-goes-on', sha: '3'.repeat(40), upstream: null, committedAt: 3, worktreePath: '/w/p1/.claude/worktrees/x', current: false },
    { name: 'release/0.61', sha: '4'.repeat(40), upstream: null, committedAt: 4, worktreePath: null, current: false },
  ] }
  worktrees = { repo: 'main', worktrees: [
    { path: '/w/p1', head: 'c0b2953', branch: 'feature/x', detached: false, bare: false, main: true, linked: false, current: true, locked: false, prunable: false, rna: false, owner: null },
    { path: '/w/p1/.claude/worktrees/x', head: 'd253386', branch: 'claude/other', detached: false, bare: false, main: false, linked: true, current: false, locked: true, prunable: false, rna: false, owner: null },
    { path: '/w/gone', head: null, branch: null, detached: true, bare: false, main: false, linked: true, current: false, locked: false, prunable: true, rna: false, owner: null },
  ] }
  resetGitStatus(); resetSidePanel(); useUi.setState({ toasts: [], disclosure: {} }); useChangeDetail.setState({ rows: {} }); resetApplyFiles()
  useApp.setState({
    status: 'ready', projects: { p1: project() }, projectOrder: ['p1'], sessionIndex: { s1: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' } },
    sessions: { s1: { meta: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' }, items: { u1: { id: 'u1', kind: 'user', text: '改一下登录页', turnId: 't1', createdAt: '' } as Item, e1: edit('e1', '/w/p1/src/login.ts', 't1'), e2: edit('e2', 'src/home.ts', 't2') }, order: ['u1', 'e1', 'e2'], turns: { t1: { id: 't1', status: 'completed', userItemId: 'u1' }, t2: { id: 't2', status: 'completed' } }, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false } as never },
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

const settle = async (n = 3) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const frames = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
/** Patch asks are gathered for a moment before they go out: wait for them and their answers. */
const gather = async () => { await frames(); await settle() }
let fields: WorktreeTabFields = {}
const render = async (props: Partial<WorktreePanelProps> = {}) => {
  if (props.fields) fields = props.fields
  const all: WorktreePanelProps = { projectId: 'p1', sessionId: 's1', following: true, fields, tabId: 'tab-w', onChange: patch => { changes.push(patch) }, ...props }
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(WorktreePanel, all))) })
  await settle(); await gather()
}
beforeEach(() => { fields = {} })
const text = () => host.textContent ?? ''
const section = (path: string) => host.querySelector<HTMLElement>(`[data-section-path="${path}"]`)
const treeRow = (path: string) => host.querySelector<HTMLElement>(`[data-tree-row="${path}"]`)
const row = (path: string) => host.querySelector(`[data-file="${path}"]`) as HTMLElement | null
const button = (scope: ParentNode, label: string | RegExp) => [...scope.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent?.trim() === label || b.getAttribute('aria-label') === label : label.test(b.textContent ?? ''))) as HTMLButtonElement | undefined
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await settle() }
const key = async (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => { target.dispatchEvent(event) }); await settle()
  return event
}
/** Opens a Radix menu from its trigger (as the keyboard does). */
const openMenu = (trigger: Element | null) => key(trigger!, { key: 'Enter' })
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem],[role=menuitemcheckbox]')]
const menuItem = (label: string | RegExp) => menuItems().find(el => (typeof label === 'string' ? el.textContent?.trim().startsWith(label) : label.test(el.textContent ?? '')))
const gets = (part: string) => calls.filter(call => call.startsWith('GET') && call.includes(part))

describe('model', () => {
  it('groups by stage in order and counts the work', () => {
    expect(dirtySummary(status())).toEqual({ count: 5, added: 4, removed: 2 })
    expect(splitPath('src/app/main.ts')).toEqual({ name: 'main.ts', dir: 'src/app' })
    expect(splitPath('dist/')).toEqual({ name: 'dist/', dir: '' })
    expect(gitRows(status(), new Set(['untracked'])).map(r => (r.kind === 'section' ? `#${r.section}${r.folded ? '-' : ''}` : r.file.path)))
      .toEqual(['#conflicted', 'src/merge.ts', '#staged', 'docs/new name.md', '#unstaged', 'src/app/main.ts', 'assets/logo.png', '#untracked-'])
  })
})

describe('worktree panel: the comparison', () => {
  it('is registered as a project panel that follows the current project, and reads all changes against the default branch first', async () => {
    const def = getPanel('worktree')
    expect(def?.binding).toBe('project')
    expect(def?.title({ id: 'w', type: 'worktree', binding: 'workspace' })).toBe('工作区改动')
    await act(async () => { root.render(createElement(Tooltip.Provider, null, def!.render({ id: 'w', type: 'worktree', projectId: null, binding: 'workspace' }, { sessionId: 's1', projectId: 'p1', visible: true, groupId: 'g' }))) })
    await settle()
    expect(calls[0]).toBe('GET /api/v2/projects/p1/git')
    expect(gets('/git/compare')).toEqual(['GET /api/v2/projects/p1/git/compare?mode=all'])
    expect(host.querySelector('[data-worktree-panel]')?.getAttribute('data-mode')).toBe('all')
  })

  it('an old-style source asked for (openWorktree) shows at once and is written into the tab; choices are kept with the tab', async () => {
    const id = openTab({ type: 'worktree', projectId: null, source: 'staged' })
    const show = async () => {
      await act(async () => { root.render(createElement(Tooltip.Provider, null, getPanel('worktree')!.render(findTab(id)!, { sessionId: 's1', projectId: 'p1', visible: true, groupId: 'g' }))) })
      await settle()
    }
    await show()
    expect(findTab(id)).toMatchObject({ mode: 'uncommitted', grouped: true, source: null })
    expect(host.querySelector('[data-git-list]')).not.toBeNull()
    await openMenu(host.querySelector('[data-compare-chip]'))
    await click(menuItem('全部改动'))
    expect(findTab(id)).toMatchObject({ mode: 'all', grouped: true })
    await show()
    expect(host.querySelector('[data-worktree-panel]')?.getAttribute('data-mode')).toBe('all')
  })

  it('a tab whose 本次对话的改动 came from the old 本次任务 default opens on 全部改动 in a repository, never showing the old view first', async () => {
    // Read from storage it is unset already (store spec); a tab still holding the old value in memory reads the same here.
    expect(sanitizeTab({ id: 'w-old', type: 'worktree', binding: 'workspace', projectId: null, mode: 'rna' })).toMatchObject({ mode: null })
    const restored = { id: 'w-old', type: 'worktree', binding: 'workspace', projectId: null, mode: 'rna' } as const
    const seen: string[] = []
    const watch = new MutationObserver(() => {
      const panel = host.querySelector('[data-worktree-panel]')
      if (panel?.getAttribute('data-mode')) seen.push(panel.getAttribute('data-mode')!)
      if (host.querySelector('[data-rna-changes]')) seen.push('rna-view')
    })
    watch.observe(host, { subtree: true, childList: true, attributes: true })
    await act(async () => { root.render(createElement(Tooltip.Provider, null, getPanel('worktree')!.render(restored, { sessionId: 's1', projectId: 'p1', visible: true, groupId: 'g' }))) })
    await settle(); await gather()
    watch.disconnect()
    expect(host.querySelector('[data-worktree-panel]')?.getAttribute('data-mode')).toBe('all')
    expect(seen).not.toContain('rna')
    expect(seen).not.toContain('rna-view')
    // Rna's records were never read for it.
    expect(gets('/background-changes')).toEqual([])
    expect(gets('/git/compare')).toEqual(['GET /api/v2/projects/p1/git/compare?mode=all'])
  })

  it('本次对话的改动 picked from the comparison menu sticks, in this tab and once restored', async () => {
    const id = openTab({ type: 'worktree', projectId: null })
    const show = async () => {
      await act(async () => { root.render(createElement(Tooltip.Provider, null, getPanel('worktree')!.render(findTab(id)!, { sessionId: 's1', projectId: 'p1', visible: true, groupId: 'g' }))) })
      await settle(); await gather()
    }
    await show()
    await openMenu(host.querySelector('[data-compare-chip]'))
    await click(menuItem('本次对话的改动'))
    expect(findTab(id)).toMatchObject({ mode: 'rna', rnaPicked: true })
    await show()
    expect(host.querySelector('[data-worktree-panel]')?.getAttribute('data-mode')).toBe('rna')
    expect(sanitizeTab({ ...findTab(id)!, binding: 'workspace' })).toMatchObject({ mode: 'rna', rnaPicked: true })
  })

  it('a tab following the current project leaves the base branch and worktree picked in one project behind in the next', async () => {
    useApp.setState(state => ({ projects: { ...state.projects, p2: project({ id: 'p2', name: '另一个仓库', workspacePath: '/w/p2' }) } }))
    const id = openTab({ type: 'worktree', projectId: null, mode: 'all', base: 'release/0.61', target: '/w/p1/.claude/worktrees/x', wrap: false })
    // The tab as the workspace draws it: read from the store on every change.
    function Live({ projectId }: { projectId: string | null }) {
      const tab = useSidePanel(state => state.layout.tabs[id])
      return getPanel('worktree')!.render(tab, { sessionId: null, projectId, visible: true, groupId: 'g' })
    }
    const show = async (projectId: string | null) => {
      await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(Live, { projectId }))) })
      await settle(); await gather()
    }
    // Restored before the selection is: the tab's own choices stay.
    await show(null)
    await show('p1')
    expect(gets('/git/compare').at(-1)).toContain('base=release%2F0.61')
    expect(findTab(id)).toMatchObject({ base: 'release/0.61', target: '/w/p1/.claude/worktrees/x' })
    calls = []
    await show('p2')
    // p2 is read against its own default branch, in its own folder, from the first request.
    expect(gets('/git/compare')).toEqual(['GET /api/v2/projects/p2/git/compare?mode=all'])
    expect(findTab(id)).toMatchObject({ mode: 'all', base: null, target: null, wrap: false })
    expect(useUi.getState().toasts).toEqual([])
  })

  it('the chip reads <base> → <target>: 工作目录 on the base branch itself, the short id when detached, <branch> · 未提交 for uncommitted work', async () => {
    await render()
    const chip = () => host.querySelector('[data-compare-chip]')!
    expect(chip().querySelector('[data-chip-base]')?.textContent).toBe('main')
    expect(chip().querySelector('[data-chip-target]')?.textContent).toBe('feature/x')
    expect(chip().getAttribute('aria-label')).toBe('选择对比方式：main → feature/x')
    listing = compare({ target: { kind: 'working-tree', label: 'main' } })
    await act(async () => { await loadGitStatus('p1') }); await settle()
    expect(chip().querySelector('[data-chip-target]')?.textContent).toBe('本地工作目录')
    listing = compare({ target: { kind: 'detached', label: 'c0b2953' } })
    await act(async () => { await loadGitStatus('p1') }); await settle()
    expect(chip().querySelector('[data-chip-target]')?.textContent).toBe('c0b2953')
    listing = compare({ base: null, mergeBase: 'b'.repeat(40) })
    await render({ fields: { mode: 'uncommitted' } })
    expect(chip().textContent).toBe('feature/x · 未提交')
    expect(gets('/git/compare').at(-1)).toBe('GET /api/v2/projects/p1/git/compare?mode=uncommitted')
  })

  it('the tree compacts single-child folder chains and shows +N −M, 二进制, 大文件, a crossed-out deletion and a move on hover', async () => {
    await render()
    const rows = [...host.querySelectorAll<HTMLElement>('[data-tree-row]')].map(el => `${'  '.repeat(Number(el.getAttribute('aria-level')) - 1)}${el.dataset.treeRow}`)
    expect(rows).toEqual([
      'api/search', '  api/search/route.ts', 'assets', '  assets/logo.png', 'data', '  data/blob.bin', '  data/huge.json', 'docs', '  docs/new.md', 'src/app', '  src/app/main.ts', '  src/app/old.ts',
    ])
    expect(treeRow('api/search')!.textContent).toContain('api/search')
    expect(treeRow('api/search/route.ts')!.querySelector('[data-stat]')?.textContent).toBe('+4−0')
    expect(treeRow('assets/logo.png')!.textContent).toContain('二进制')
    expect(treeRow('data/blob.bin')!.textContent).toContain('大文件')
    expect(treeRow('src/app/old.ts')!.querySelector('.line-through')?.textContent).toBe('old.ts')
    expect(treeRow('docs/new.md')!.getAttribute('title')).toBe('docs/old.md → docs/new.md')
  })

  it('stacks every file’s diff in the tree’s order with a header each, reading patches in one batch from the merge base', async () => {
    await render()
    expect([...host.querySelectorAll<HTMLElement>('[data-section-path]')].map(el => el.dataset.sectionPath))
      .toEqual(['api/search/route.ts', 'assets/logo.png', 'data/blob.bin', 'data/huge.json', 'docs/new.md', 'src/app/main.ts', 'src/app/old.ts'])
    const header = section('src/app/main.ts')!.querySelector('[data-section-header]')!
    expect(header.textContent).toContain('main.tssrc/app')
    expect(header.querySelector('.font-semibold')?.textContent).toBe('main.ts')
    // Binary files and the folded large one are not asked for; a moved file brings its old name; a new file too large
    // to count (a MB by guess) goes alone.
    expect(gets('/git/patches')).toEqual([
      `GET /api/v2/projects/p1/git/patches?base=${MERGE_BASE}&path=api%2Fsearch%2Froute.ts&path=docs%2Fnew.md&path=src%2Fapp%2Fmain.ts&path=src%2Fapp%2Fold.ts&oldPath=docs%2Fold.md`,
      `GET /api/v2/projects/p1/git/patches?base=${MERGE_BASE}&path=data%2Fblob.bin`,
    ])
    expect(section('src/app/main.ts')!.textContent).toContain('new line')
    expect(section('assets/logo.png')!.textContent).toContain('二进制文件，不显示差异。')
    expect(section('data/blob.bin')!.textContent).toContain('二进制文件，不显示差异。')
    // Added and removed rows, a bar beside each run, line numbers of the new side.
    const added = section('src/app/main.ts')!.querySelector<HTMLElement>('[data-diff-row="add"]')!
    expect(added.className).toContain('bg-[var(--diff-add-bg)]')
    expect(added.className).toContain('shadow-[inset_3px_0_0_var(--state-success)]')
    expect(added.firstElementChild?.textContent).toBe('3')
  })

  it('uncommitted work reads its patches from HEAD', async () => {
    await render({ fields: { mode: 'uncommitted' } })
    expect(gets('/git/patches')[0]).toContain('/git/patches?base=HEAD&')
  })

  it('a file over 1000 changed lines waits behind 显示 N 行改动', async () => {
    await render()
    const huge = section('data/huge.json')!
    expect(huge.textContent).toContain('显示 1500 行改动')
    expect(calls.some(call => call.includes('path=data%2Fhuge.json'))).toBe(false)
    await click(huge.querySelector('[data-show-large]')); await gather()
    expect(gets('/git/patches').at(-1)).toBe(`GET /api/v2/projects/p1/git/patches?base=${MERGE_BASE}&path=data%2Fhuge.json`)
    expect(section('data/huge.json')!.textContent).toContain('after data/huge.json')
  })

  it('展开 N 行 reads the file whole and shows it in place', async () => {
    await render()
    const main = section('src/app/main.ts')!
    // The first hunk starts at line 2 (one line hidden above it); 12 lines lie between the hunks.
    const expand = [...main.querySelectorAll('button')].filter(b => b.textContent?.startsWith('展开'))
    expect(expand.map(b => b.textContent)).toEqual(['展开 1 行', '展开 12 行'])
    expect(main.querySelector('[data-diff-row="gap"]')?.textContent).toContain('function keep() {')
    await click(expand[1])
    expect(gets('/git/diff')).toEqual([`GET /api/v2/projects/p1/git/diff?source=compare&base=${MERGE_BASE}&path=src%2Fapp%2Fmain.ts&context=all`])
    const whole = section('src/app/main.ts')!
    expect(whole.textContent).toContain('line 20')
    expect([...whole.querySelectorAll('button')].some(b => b.textContent?.startsWith('展开'))).toBe(false)
  })

  it('a header folds its file; a pick in the tree marks it and unfolds it', async () => {
    await render()
    const header = section('src/app/main.ts')!.querySelector('[data-section-header]')!
    await click(button(header, '折叠「main.ts」'))
    expect(section('src/app/main.ts')!.querySelector('[data-diff-row]')).toBeNull()
    await click(treeRow('src/app/main.ts'))
    await frames()
    expect(treeRow('src/app/main.ts')!.dataset.active).toBe('true')
    expect(section('src/app/main.ts')!.querySelector('[data-diff-row]')).not.toBeNull()
    // Space on the column folds the file in view; ⌥↓ moves to the next one.
    const column = host.querySelector<HTMLElement>('[data-stacked-diff]')!
    await key(column, { key: ' ' })
    expect(section('src/app/main.ts')!.querySelector('[data-diff-row]')).toBeNull()
    await key(column, { key: 'ArrowDown', altKey: true })
    expect(treeRow('src/app/old.ts')!.dataset.active).toBe('true')
  })

  it('the tree answers the keyboard: ↑/↓ move, ← folds the folder, → opens it, Enter shows the file', async () => {
    await render()
    const tree = host.querySelector<HTMLElement>('[data-change-tree]')!
    expect(tree.getAttribute('role')).toBe('tree')
    // The keyboard starts on the diff in view.
    expect(host.querySelector('[data-cursor]')?.getAttribute('data-tree-row')).toBe('api/search/route.ts')
    await key(tree, { key: 'ArrowDown' })
    expect(host.querySelector('[data-cursor]')?.getAttribute('data-tree-row')).toBe('assets')
    await key(tree, { key: 'ArrowUp' })
    await key(tree, { key: 'ArrowLeft' }) // to its folder
    expect(host.querySelector('[data-cursor]')?.getAttribute('data-tree-row')).toBe('api/search')
    await key(tree, { key: 'ArrowLeft' }) // folds it
    expect(treeRow('api/search/route.ts')).toBeNull()
    expect(treeRow('api/search')!.getAttribute('aria-expanded')).toBe('false')
    await key(tree, { key: 'ArrowRight' })
    expect(treeRow('api/search/route.ts')).not.toBeNull()
    await key(tree, { key: 'End' })
    await key(tree, { key: 'Enter' })
    await frames()
    expect(treeRow('src/app/old.ts')!.dataset.active).toBe('true')
  })

  it('says when there is nothing to show, and when the list was cut short', async () => {
    listing = compare({ files: [] })
    await render()
    expect(host.querySelector('[data-compare-empty]')?.textContent).toBe('没有可显示的改动')
    expect(host.querySelector('[data-find-toggle]')).toBeNull()
    listing = compare({ truncated: true })
    await act(async () => { await loadGitStatus('p1') }); await settle()
    expect(text()).toContain('改动太多，只列出了一部分。')
  })

  it('reads the list again whenever the folder’s git state is read again (focus, a run ending, a write)', async () => {
    await render()
    expect(gets('/git/compare')).toHaveLength(1)
    await act(async () => { await loadGitStatus('p1') }); await settle(); await gather()
    expect(gets('/git/compare')).toHaveLength(2)
    // Patches in view are read again for the new list.
    expect(gets('/git/patches')).toHaveLength(4)
  })

  it('no common history says so and offers the default branch; a branch that is gone falls back to the default once', async () => {
    compareError = new ApiError('与 orphan 没有共同历史。', 409, 'no_common_history')
    await render({ fields: { base: 'orphan' } })
    const problem = host.querySelector('[data-compare-problem="no_common_history"]')!
    expect(problem.textContent).toContain('与 orphan 没有共同历史。')
    await click(button(problem, '对比默认分支'))
    expect(changes).toEqual([{ base: null }])
    changes = []
    compareError = new ApiError('分支「gone」不存在。', 404, 'git_base_not_found')
    await render({ fields: { base: 'gone' } })
    expect(changes).toEqual([{ base: null }])
    expect(useUi.getState().toasts.map(row => row.text)).toContain('分支「gone」已不存在，改为对比默认分支。')
  })

  it('an operation in progress shows its banner', async () => {
    listing = compare({ operation: 'merge' })
    await render()
    expect(host.querySelector('[data-operation="merge"]')?.textContent).toContain('正在合并')
  })
})

describe('worktree panel: menus', () => {
  it('the comparison menu switches modes; 对比分支 lists local branches with ✓ / 默认 / 当前 / 工作树 and a search', async () => {
    await render()
    await openMenu(host.querySelector('[data-compare-chip]'))
    expect(menuItems().slice(0, 3).map(el => [el.textContent, el.getAttribute('aria-checked')])).toEqual([['全部改动对比 main', 'true'], ['未提交的改动', 'false'], ['本次对话的改动', 'false']])
    await click(menuItem('未提交的改动'))
    expect(changes).toEqual([{ mode: 'uncommitted' }])

    await openMenu(host.querySelector('[data-compare-chip]'))
    await key(document.querySelector('[data-compare-branches]')!, { key: 'ArrowRight' })
    expect(gets('/git/branches').at(-1)).toBe('GET /api/v2/projects/p1/git/branches')
    const branch = (name: string) => document.querySelector<HTMLElement>(`[data-branch="${name}"]`)!
    expect(branch('main').textContent).toBe('main默认')
    expect(branch('main').querySelector('[aria-label="已选择"]')).not.toBeNull()
    expect(branch('feature/x').textContent).toBe('feature/x当前分支')
    const long = branch('claude/a-very-long-branch-name-for-an-experiment-that-goes-on')
    expect(long.textContent).toContain('工作树')
    expect(long.querySelector('.truncate')?.getAttribute('title')).toBe('claude/a-very-long-branch-name-for-an-experiment-that-goes-on')
    const search = document.querySelector<HTMLInputElement>('[data-branch-search]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'REL')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...document.querySelectorAll<HTMLElement>('[data-branch]')].map(el => el.dataset.branch)).toEqual(['release/0.61'])
    // Letters typed in the field stay there (the menu's type-to-select never sees them).
    expect((await key(search, { key: 'r' })).defaultPrevented).toBe(false)
    await click(branch('release/0.61'))
    expect(changes.at(-1)).toEqual({ mode: 'all', base: 'release/0.61' })
  })

  it('picking the default branch follows it (base null)', async () => {
    await render({ fields: { base: 'release/0.61' } })
    await openMenu(host.querySelector('[data-compare-chip]'))
    await key(document.querySelector('[data-compare-branches]')!, { key: 'ArrowRight' })
    await click(document.querySelector('[data-branch="main"]'))
    expect(changes.at(-1)).toEqual({ mode: 'all', base: null })
  })

  it('⋯ shows where the folder stands, other worktrees to view, and how diffs read', async () => {
    await render()
    await openMenu(host.querySelector('[aria-label="工作区改动选项"]'))
    const stand = document.querySelector('[data-stand]')!
    expect(stand.textContent).toContain('feature/x')
    expect(stand.querySelector('[data-upstream]')?.textContent).toBe('origin/feature/x21')
    const grouped = menuItem('按暂存状态分组')!
    expect(grouped.getAttribute('aria-disabled')).toBe('true') // 未提交的改动 only
    expect(menuItem('自动换行')!.getAttribute('aria-checked')).toBe('true')
    await click(menuItem('显示新旧两列行号'))
    expect(changes.at(-1)).toEqual({ numbers: 'both' })
    await click(menuItem('自动换行'))
    expect(changes.at(-1)).toEqual({ wrap: false })

    await key(document.querySelector('[data-other-worktrees]')!, { key: 'ArrowRight' })
    const rows = [...document.querySelectorAll<HTMLElement>('[data-worktree]')]
    expect(rows.map(el => [el.dataset.worktree, el.getAttribute('aria-disabled')])).toEqual([['/w/p1', null], ['/w/p1/.claude/worktrees/x', null], ['/w/gone', 'true']])
    expect(rows[0].textContent).toContain('项目文件夹')
    expect(rows[1].textContent).toContain('已锁定')
    expect(rows[2].textContent).toContain('可清理')
    await click(rows[1])
    expect(changes.at(-1)).toEqual({ target: '/w/p1/.claude/worktrees/x', grouped: false })
  })

  it('refresh reads the git state and so the comparison again', async () => {
    await render()
    await openMenu(host.querySelector('[aria-label="工作区改动选项"]'))
    await click(document.querySelector('[data-refresh]'))
    expect(calls.filter(call => call === 'GET /api/v2/projects/p1/git')).toHaveLength(2)
    expect(gets('/git/compare')).toHaveLength(2)
  })

  it('a file’s ⋯ opens it, copies its path, and for uncommitted work stages or discards it (a second question first)', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render({ fields: { mode: 'uncommitted' } })
    await openMenu(section('docs/new.md')!.querySelector('[data-section-menu]'))
    await click(menuItem('复制路径'))
    expect(writeText).toHaveBeenCalledWith('/w/p1/docs/new.md')
    await openMenu(section('docs/new.md')!.querySelector('[data-section-menu]'))
    await click(menuItem('暂存'))
    const posts = () => calls.filter(call => call.startsWith('POST'))
    expect(posts()).toEqual(['POST /api/v2/projects/p1/git/stage {"paths":["docs/new.md","docs/old.md"]}'])
    expect(useUi.getState().toasts.map(row => row.text)).toContain('已暂存「new.md」。')
    await openMenu(section('src/app/main.ts')!.querySelector('[data-section-menu]'))
    await click(menuItem('丢弃改动'))
    expect(posts().at(-1)).toBe('POST /api/v2/projects/p1/git/discard {"paths":["src/app/main.ts"]}')
    expect(host.querySelector('[data-discard-confirm]')?.textContent).toContain('丢弃「main.ts」的改动？')
    await click(host.querySelector('[data-confirm-discard]'))
    expect(calls.filter(call => call.includes('confirm'))).toHaveLength(1)
    // 全部改动 has no stage or discard (committed work is part of it).
    await render({ fields: { mode: 'all' } })
    await openMenu(section('src/app/main.ts')!.querySelector('[data-section-menu]'))
    expect(menuItem('暂存')).toBeUndefined()
    expect(menuItem('打开文件')).toBeDefined()
  })
})

describe('worktree panel: find', () => {
  it('⌘F opens it; it counts matches in paths and diffs, steps with Enter / ⇧Enter, filters the tree; Esc closes it alone', async () => {
    await render()
    const body = host.querySelector<HTMLElement>('[data-stacked-diff]')!
    const opened = await key(body, { key: 'f', metaKey: true, ctrlKey: true })
    expect(opened.defaultPrevented).toBe(true)
    const input = host.querySelector<HTMLInputElement>('[data-find-input]')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'NEW')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(); await gather()
    // docs/new.md (its path, its removed and added rows), main.ts's two new rows.
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('1/5')
    expect([...host.querySelectorAll<HTMLElement>('[data-tree-kind="file"]')].map(el => el.dataset.treeRow)).toEqual(['docs/new.md', 'src/app/main.ts'])
    await key(input, { key: 'Enter' })
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('2/5')
    await key(input, { key: 'Enter', shiftKey: true })
    await key(input, { key: 'Enter', shiftKey: true })
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('5/5')
    await frames()
    expect(section('src/app/main.ts')!.querySelector('[data-find-current]')?.textContent).toContain('second new')
    const esc = await key(input, { key: 'Escape' })
    expect(esc.defaultPrevented).toBe(true)
    expect(host.querySelector('[data-find-bar]')).toBeNull()
    expect(host.querySelectorAll('[data-tree-kind="file"]')).toHaveLength(FILES.length)
  })

  it('reads the rest of the patches to search them, and says when only part could be searched', async () => {
    listing = compare({ files: [...FILES, { path: 'big/one.txt', status: '?', added: null, removed: null, untracked: true }] })
    await render()
    await click(host.querySelector('[data-find-toggle]'))
    const input = host.querySelector<HTMLInputElement>('[data-find-input]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'after')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(); await gather(); await gather()
    // The folded large file is read for the search; an uncounted new file (1 MB by guess) still fits in 5 MB.
    expect(calls.some(call => call.includes('/git/patches') && call.includes('path=data%2Fhuge.json'))).toBe(true)
    expect(calls.some(call => call.includes('/git/patches') && call.includes('path=big%2Fone.txt'))).toBe(true)
    expect(host.querySelector('[data-find-partial]')).toBeNull()
  })

  it('Esc elsewhere in the panel closes the find bar before anything else; a menu that took the key keeps it', async () => {
    await render()
    await click(host.querySelector('[data-find-toggle]'))
    const body = host.querySelector<HTMLElement>('[data-stacked-diff]')!
    await act(async () => { body.focus() })
    const esc = await key(body, { key: 'Escape' })
    expect(esc.defaultPrevented).toBe(true)
    expect(host.querySelector('[data-find-bar]')).toBeNull()
    expect(document.activeElement).toBe(body)
    // Closed: the key is the workspace's again.
    expect((await key(body, { key: 'Escape' })).defaultPrevented).toBe(false)
    await click(host.querySelector('[data-find-toggle]'))
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    await act(async () => { body.dispatchEvent(handled) }); await settle()
    expect(host.querySelector('[data-find-bar]')).not.toBeNull()
  })
})

describe('worktree panel: the tree’s place', () => {
  it('a wide panel shows the tree (remembered per tab); ⇧⌘Y and the button hide it', async () => {
    await render()
    const toggle = host.querySelector<HTMLButtonElement>('[data-tree-toggle]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('隐藏文件')
    expect(host.querySelector('[data-tree-column]')).not.toBeNull()
    await click(toggle)
    expect(changes).toEqual([{ tree: false }])
    let toggled = false
    await act(async () => { toggled = toggleWorktreeTree('tab-w') })
    expect(toggled).toBe(true)
    expect(changes).toEqual([{ tree: false }, { tree: false }])
    await render({ fields: { tree: false } })
    expect(host.querySelector('[data-tree-column]')).toBeNull()
    expect(host.querySelector('[data-tree-toggle]')?.getAttribute('aria-label')).toBe('显示文件')
    expect(toggleWorktreeTree('another-tab')).toBe(false)
  })

  it('below 520 px the tree is hidden and opens over the diffs; a pick or Esc closes it', async () => {
    panelWidth = 400
    await render()
    expect(host.querySelector('[data-tree-column]')).toBeNull()
    await click(host.querySelector('[data-tree-toggle]'))
    expect(changes).toEqual([])
    expect(host.querySelector('[data-tree-overlay]')).not.toBeNull()
    expect(document.activeElement?.hasAttribute('data-change-tree')).toBe(true)
    await click(host.querySelector('[data-tree-overlay] [data-tree-row="src/app/main.ts"]'))
    expect(host.querySelector('[data-tree-overlay]')).toBeNull()
    // The keyboard goes on to the diffs (not dropped on the page with the overlay).
    expect(document.activeElement?.hasAttribute('data-stacked-diff')).toBe(true)
    await act(async () => { toggleWorktreeTree('tab-w') })
    await settle()
    const esc = await key(host.querySelector('[data-tree-overlay] [data-change-tree]')!, { key: 'Escape' })
    expect(esc.defaultPrevented).toBe(true)
    expect(host.querySelector('[data-tree-overlay]')).toBeNull()
    expect(document.activeElement?.hasAttribute('data-stacked-diff')).toBe(true)
  })

  it('a tab restored before its project has loaded still lays out by the panel’s width', async () => {
    panelWidth = 400
    const loaded = useApp.getState().projects
    useApp.setState({ projects: {} })
    await render()
    expect(text()).toContain('改动属于项目')
    await act(async () => { useApp.setState({ projects: loaded }) })
    await settle(); await gather()
    expect(host.querySelector('[data-stacked-diff]')).not.toBeNull()
    // Narrow: the tree waits behind its button instead of squeezing the diffs.
    expect(host.querySelector('[data-tree-column]')).toBeNull()
    expect(host.querySelector('[data-tree-toggle]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('本次对话的改动 has the tree too (⇧⌘Y hides it); grouping by stage has none', async () => {
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    expect(host.querySelector('[data-tree-toggle]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[data-tree-column]')).not.toBeNull()
    await act(async () => { expect(toggleWorktreeTree('tab-w')).toBe(true) })
    expect(changes.at(-1)).toEqual({ tree: false })
    await render({ fields: { mode: 'uncommitted', grouped: true } })
    expect(host.querySelector('[data-tree-toggle]')).toBeNull()
    expect(toggleWorktreeTree('tab-w')).toBe(false)
  })
})

describe('worktree panel: another worktree', () => {
  it('reads it with worktree=, read-only, says which it is and goes back', async () => {
    await render({ fields: { target: '/w/p1/.claude/worktrees/x' } })
    expect(gets('/git/compare')).toEqual(['GET /api/v2/projects/p1/git/compare?mode=all&worktree=%2Fw%2Fp1%2F.claude%2Fworktrees%2Fx'])
    expect(gets('/git/patches')[0]).toContain('&worktree=%2Fw%2Fp1%2F.claude%2Fworktrees%2Fx&path=')
    const bar = host.querySelector('[data-other-worktree]')!
    expect(bar.textContent).toContain('只读')
    expect(bar.textContent).toContain('feature/x')
    expect(bar.textContent).toContain('/w/p1/.claude/worktrees/x')
    await openMenu(section('src/app/main.ts')!.querySelector('[data-section-menu]'))
    expect(menuItem('打开文件')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('暂存')).toBeUndefined()
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
    // Its own state is read for ⋯ (not the shared project status).
    await openMenu(host.querySelector('[aria-label="工作区改动选项"]'))
    expect(calls).toContain('GET /api/v2/projects/p1/git?worktree=%2Fw%2Fp1%2F.claude%2Fworktrees%2Fx')
    expect(document.querySelector('[data-stand]')?.textContent).toContain('claude/other')
    await click(button(bar, '返回项目文件夹'))
    expect(changes.at(-1)).toEqual({ target: null })
  })
})

describe('worktree panel: grouped by stage (未提交的改动)', () => {
  const grouped = { fields: { mode: 'uncommitted', grouped: true } as WorktreeTabFields }

  it('lists conflicted / staged / unstaged / untracked with name, folder, status and +/−', async () => {
    await render(grouped)
    expect(gets('/git/compare')).toEqual([])
    expect([...host.querySelectorAll('[data-git-list] [data-section]:not([data-file])')].map(el => el.getAttribute('data-section'))).toEqual(['conflicted', 'staged', 'unstaged', 'untracked'])
    const main = row('src/app/main.ts')!
    expect(main.textContent).toContain('main.tssrc/app')
    expect(main.textContent).toContain('+3−1')
    expect(row('assets/logo.png')?.textContent).toContain('二进制')
    expect(row('notes/todo.md')?.textContent).toContain('新文件')
    expect(host.querySelector('[data-compare-chip]')?.textContent).toBe('feature/x · 未提交')
  })

  it('a file opens its diff with the panel’s wrap and numbers', async () => {
    await render({ fields: { mode: 'uncommitted', grouped: true, numbers: 'both' } })
    await click(row('src/app/main.ts')!.querySelector('button[aria-expanded]'))
    expect(calls.at(-1)).toBe('GET /api/v2/projects/p1/git/diff?source=unstaged&path=src%2Fapp%2Fmain.ts')
    const added = row('src/app/main.ts')!.querySelector<HTMLElement>('[data-diff-row="add"]')!
    // Two number columns: none on the old side of an added row, the new number on the other.
    expect([...added.children].slice(0, 2).map(cell => cell.textContent)).toEqual(['', '3'])
  })

  it('stages a file and takes the fresh status from the answer', async () => {
    await render(grouped)
    await click(button(row('src/app/main.ts')!, '暂存「main.ts」'))
    expect(calls.at(-1)).toBe('POST /api/v2/projects/p1/git/stage {"paths":["src/app/main.ts"]}')
    expect(row('src/app/main.ts')).toBeNull()
  })

  it('unstaging a rename sends both of its names', async () => {
    await render(grouped)
    await click(button(row('docs/new name.md')!, '取消暂存「new name.md」'))
    expect(calls.at(-1)).toBe('POST /api/v2/projects/p1/git/unstage {"paths":["docs/new name.md","docs/old name.md"]}')
  })

  it('discard asks a second time; only that click sends the confirmation; Esc cancels it alone', async () => {
    await render(grouped)
    const ask = button(row('notes/todo.md')!, '丢弃「todo.md」的改动')!
    await act(async () => { ask.focus() })
    await click(ask)
    const bar = host.querySelector('[data-discard-confirm]')!
    expect(bar.textContent).toContain('新文件会被删除。 这一步不能撤销。')
    expect(document.activeElement).toBe(button(bar, '取消'))
    const esc = await key(document.activeElement!, { key: 'Escape' })
    expect(esc.defaultPrevented).toBe(true)
    expect(host.querySelector('[data-discard-confirm]')).toBeNull()
    expect(document.activeElement).toBe(ask)
    await click(button(host.querySelector('[data-git-list] [data-section="unstaged"]')!, '丢弃这一组的全部改动'))
    await click(host.querySelector('[data-confirm-discard]'))
    expect(calls.at(-1)).toBe(`POST /api/v2/projects/p1/git/discard {"paths":["src/app/main.ts","assets/logo.png"],"confirm":"${'c'.repeat(32)}"}`)
  })

  it('a stale confirmation is reported and changes nothing', async () => {
    discardFails = true
    await render(grouped)
    await click(button(row('src/app/main.ts')!, '丢弃「main.ts」的改动'))
    await click(host.querySelector('[data-confirm-discard]'))
    expect(row('src/app/main.ts')).not.toBeNull()
    expect(calls.at(-1)).toBe('GET /api/v2/projects/p1/git')
  })

  it('a read-only project shows the changes without stage or discard', async () => {
    useApp.setState({ projects: { p1: project({ permissions: { workspace: 'read' } }) } })
    await render(grouped)
    expect(button(row('src/app/main.ts')!, '暂存「main.ts」')).toBeUndefined()
    expect(button(host, '丢弃这一组的全部改动')).toBeUndefined()
  })

  it('grouping applies to the project folder only: another worktree shows its comparison', async () => {
    await render({ fields: { mode: 'uncommitted', grouped: true, target: '/w/x' } })
    expect(host.querySelector('[data-git-list]')).toBeNull()
    expect(gets('/git/compare')).toEqual(['GET /api/v2/projects/p1/git/compare?mode=uncommitted&worktree=%2Fw%2Fx'])
  })
})

describe('worktree panel: Rna’s records and folders without git', () => {
  const groups = () => [...host.querySelectorAll<HTMLElement>('[data-tree-kind="group"]')].map(el => el.dataset.treeRow)
  const overwrite = (id: string, path: string, turnId: string): Item => ({ id, kind: 'tool', turnId, createdAt: '2026-10-03T10:00:00Z', tool: { name: 'project_write', status: 'succeeded', args: { path, content: 'all new\n' }, created: false } } as unknown as Item)

  it('本次对话的改动 lays out as the comparisons do: a tree grouped by turn and run beside every file’s diff', async () => {
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    expect(gets('/git/compare')).toEqual([])
    // The tree: a row per background run and turn, newest first (the set was just recorded; turns newest first).
    expect(groups()).toEqual(['change:bg-1', 'turn:t2', 'turn:t1'])
    expect(treeRow('turn:t1:src/login.ts')?.textContent).toContain('+2−1')
    expect(host.querySelector('[data-tree-row="turn:t2"]')?.textContent).toContain('本轮')
    // The diffs: one section per file of each group, the group's label above its first one, with 审阅.
    const turns = [...host.querySelectorAll<HTMLElement>('[data-rna-group][data-turn]')]
    expect(turns.map(turn => turn.dataset.turn)).toEqual(['t2', 't1'])
    expect(turns[0].textContent).toContain('本轮')
    expect(turns[1].textContent).toContain('改一下登录页')
    // The edit's old and new text, through the shared DiffView: green and red rows with line numbers.
    const login = host.querySelector('[data-section-key="turn:t1:src/login.ts"]')!
    expect(login.querySelector('[data-section-header]')?.textContent).toContain('login.ts')
    expect([...login.querySelectorAll('[data-diff-row]')].map(row => row.getAttribute('data-diff-row'))).toEqual(['del', 'add', 'add'])
    expect(login.textContent).toContain('b')
    await click(button(turns[1], '审阅'))
    expect(Object.values(useSidePanel.getState().layout.tabs).some(tab => tab.type === 'review' && tab.itemIds?.join() === 'e1')).toBe(true)
  })

  it('a change set shows its own before → after with 审阅 and 回退这些修改 kept on its label', async () => {
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    const set = host.querySelector<HTMLElement>('[data-rna-group][data-change-set="bg-1"]')!
    expect(set.textContent).toContain('整理测试报告')
    expect(set.textContent).toContain('9 个文件')
    expect(button(set, '回退这些修改')).toBeDefined()
    const k = host.querySelector('[data-section-key="change:bg-1:lib/k.ts"]')!
    expect([...k.querySelectorAll('[data-diff-row]')].map(row => row.getAttribute('data-diff-row'))).toEqual(['ctx', 'del', 'add', 'add'])
    expect(treeRow('change:bg-1:lib/k.ts')?.textContent).toContain('+2−1')
    await click(button(set, '审阅'))
    expect(Object.values(useSidePanel.getState().layout.tabs).some(tab => tab.type === 'change-review' && tab.changeId === 'bg-1')).toBe(true)
  })

  it('the same file changed in two turns is listed under each; an overwrite without its earlier text reads 已覆盖', async () => {
    useApp.setState(state => {
      const slice = state.sessions.s1
      return { sessions: { s1: { ...slice, items: { ...slice.items, e3: edit('e3', 'src/login.ts', 't2'), e4: overwrite('e4', 'docs/plan.md', 't2') }, order: [...slice.order, 'e3', 'e4'] } } }
    })
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    expect(host.querySelector('[data-section-key="turn:t1:src/login.ts"]')).not.toBeNull()
    expect(host.querySelector('[data-section-key="turn:t2:src/login.ts"]')).not.toBeNull()
    expect(treeRow('turn:t2:docs/plan.md')?.textContent).toContain('已覆盖')
    expect(treeRow('turn:t2:docs/plan.md')?.querySelector('[data-stat="overwritten"]')).not.toBeNull()
    const plan = host.querySelector('[data-section-key="turn:t2:docs/plan.md"]')!
    expect(plan.textContent).toContain('覆盖了整个文件，之前的内容没有记录，所以没有差异可看。')
    expect(plan.querySelector('[data-diff-row]')).toBeNull()
  })

  it('a group folds in the tree; a pick scrolls the diffs to the file and marks it', async () => {
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    await click(host.querySelector('[data-tree-row="change:bg-1"]'))
    expect(treeRow('change:bg-1:lib/k.ts')).toBeNull()
    expect(host.querySelector('[data-tree-row="change:bg-1"]')?.getAttribute('aria-expanded')).toBe('false')
    await click(treeRow('turn:t1:src/login.ts'))
    await frames()
    expect(treeRow('turn:t1:src/login.ts')?.hasAttribute('data-active')).toBe(true)
  })

  it('find searches Rna’s diffs too', async () => {
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    await key(host.querySelector('[data-stacked-diff]')!, { key: 'f', metaKey: true, ctrlKey: true })
    const input = host.querySelector<HTMLInputElement>('[data-find-input]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'more k')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(); await gather()
    expect(host.querySelector('[data-find-count]')?.textContent).toBe('1/1')
    // The tree keeps only the group and file holding a match.
    expect(groups()).toEqual(['change:bg-1'])
    expect([...host.querySelectorAll<HTMLElement>('[data-tree-kind="file"]')].map(el => el.dataset.treeRow)).toEqual(['change:bg-1:lib/k.ts'])
  })

  it('a set made in a background worktree reads its files and patches from its apply record', async () => {
    useApp.setState(state => ({ projects: { p1: { ...state.projects.p1, backgroundChanges: [{ id: 'bg-git', actionId: 'a1', at: new Date().toISOString(), status: 'kept', count: 1, paths: ['gen/out.ts'], kind: 'git', applyId: 'ap-bg' }] } } }))
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    expect(gets('/applies/ap-bg')).toEqual(['GET /api/v2/projects/p1/applies/ap-bg', 'GET /api/v2/projects/p1/applies/ap-bg/patches?path=gen%2Fout.ts'])
    const out = host.querySelector('[data-section-key="change:bg-git:gen/out.ts"]')!
    expect(out.textContent).toContain('export const made = 1')
    expect(treeRow('change:bg-git:gen/out.ts')?.textContent).toContain('+1−0')
    // Its 审阅 opens 应用记录 on the record (the 后台改动 tab has no snapshots of a worktree set).
    const asked: unknown[] = []
    const off = usePanelSheets.subscribe(state => { asked.push(state.requests.p1) })
    await click(button(host.querySelector('[data-rna-group="change:bg-git"]')!, '审阅'))
    off()
    expect(Object.values(useSidePanel.getState().layout.tabs).some(tab => tab.type === 'change-review')).toBe(false)
    expect(asked).toContainEqual(expect.objectContaining({ sheet: 'applies', focus: 'ap-bg' }))
  })

  it('a set whose files cannot be read says so on each file listed', async () => {
    useApp.setState(state => ({ projects: { p1: { ...state.projects.p1, backgroundChanges: [{ id: 'bg-lost', actionId: 'a9', at: new Date().toISOString(), status: 'kept', count: 1, paths: ['lost.txt'] }] } } }))
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    const lost = host.querySelector('[data-section-key="change:bg-lost:lost.txt"]')!
    expect(lost.textContent).toContain('这组改动暂时读不到。')
  })

  it('without git, ⋯ still sets how the diffs read', async () => {
    answer = status({ repo: 'none', files: { conflicted: [], staged: [], unstaged: [], untracked: [] } })
    await render()
    await openMenu(host.querySelector('[aria-label="工作区改动选项"]'))
    expect(menuItem('自动换行')).toBeDefined()
    await click(menuItem('显示新旧两列行号'))
    expect(changes.at(-1)).toEqual({ numbers: 'both' })
    expect(menuItem('Rna 工作树')).toBeUndefined()
  })

  it('nothing recorded yet: says so, with the conversation’s tool calls folded below', async () => {
    useApp.setState(state => ({
      projects: { p1: { ...state.projects.p1, backgroundChanges: [] } },
      sessions: { s1: { ...state.sessions.s1, items: { r1: { id: 'r1', kind: 'tool', turnId: 't1', createdAt: '', tool: { name: 'project_read', status: 'succeeded', args: { path: 'a.ts' } } } as unknown as Item }, order: ['r1'] } },
    }))
    await render({ fields: { mode: 'rna', rnaPicked: true } })
    expect(host.querySelector('[data-rna-empty]')?.textContent).toContain('还没有记录到改动')
    const tools = host.querySelector('[data-recent-tools]')!
    expect(tools.textContent).toContain('最近的工具调用1')
    await click(tools.querySelector('button'))
    expect(tools.querySelectorAll('button')).toHaveLength(2)
  })

  it('a plain folder says it is not a Git repository and shows Rna’s records; git that cannot run says so plainly', async () => {
    answer = status({ repo: 'none', files: { conflicted: [], staged: [], unstaged: [], untracked: [] } })
    await render({ fields: { mode: 'all' } })
    // 0.63: a plain folder can be made a repository from here (git init, two steps in its dialog).
    expect(host.querySelector('[data-not-git]')?.textContent).toBe('这个项目文件夹不是 Git 仓库初始化…')
    expect(host.querySelector('[data-git-init]')).not.toBeNull()
    expect(host.querySelector('[data-compare-chip]')?.textContent).toBe('本次对话的改动')
    expect(host.querySelector('[data-rna-changes]')).not.toBeNull()
    expect(gets('/git/compare')).toEqual([])
    answer = { ...answer, unavailable: 'developer_tools', message: '这台 Mac 还没有安装开发者命令行工具，Git 暂时不可用。' }
    resetGitStatus()
    await act(async () => { root.unmount() }); root = createRoot(host); await render()
    expect(host.querySelector('[data-not-git]')?.textContent).toBe('这台 Mac 还没有安装开发者命令行工具，Git 暂时不可用。')
    // Git that cannot run offers no init.
    expect(host.querySelector('[data-git-init]')).toBeNull()
  })

  it('a turn ending in another project’s conversation reads nothing again; one in this project does', async () => {
    useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s1: { ...s.sessionIndex.s1, status: 'running' }, s2: { id: 's2', title: 'Other', status: 'running', projectId: 'p2' } } }))
    const reads = () => calls.filter(call => call === 'GET /api/v2/projects/p1/git').length
    await render({ sessionId: 's2', following: false })
    expect(reads()).toBe(1)
    await act(async () => { useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s2: { ...s.sessionIndex.s2, status: 'idle' } } })) }); await settle()
    expect(reads()).toBe(1)
    await render({ sessionId: 's1', following: false })
    await act(async () => { useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s1: { ...s.sessionIndex.s1, status: 'idle' } } })) }); await settle()
    expect(reads()).toBe(2)
    expect(gets('/git/compare')).toHaveLength(2)
  })

  it('right-click on a file’s header: copy the paths and show it in the Files panel', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render()
    const target = section('src/app/main.ts')!.querySelector('[data-section-header]')!
    await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
    await settle()
    const item = (label: string) => [...document.querySelectorAll('[role=menuitem]')].find(el => el.textContent === label) as HTMLElement | undefined
    await act(async () => { item('复制绝对路径')!.click() })
    expect(writeText).toHaveBeenCalledWith('/w/p1/src/app/main.ts')
  })

  it('without a project it says changes belong to one', async () => {
    await render({ projectId: null })
    expect(text()).toContain('改动属于项目')
    expect(calls).toEqual([])
  })
})
