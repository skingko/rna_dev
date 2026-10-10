import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import type { GitStatus } from '@/api/git-api'
import type { DirectoryListing } from '@/api/project-api'
import { useApp } from '@/store/app-store'
import { resetPreviews } from '@/store/preview-store'
import { resetSidePanel } from '@/store/side-panel-store'
import { loadGitStatus, resetGitStatus, type ChangeKind } from '@/lib/workspace-changes'
import { changeOf, FilesSurface, folderChanges, goneEntries, treeRows } from './FilesView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const PLAIN: GitStatus = { repo: 'none', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } }
const REPO: GitStatus = {
  repo: 'main', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, operation: null,
  files: {
    conflicted: [],
    staged: [{ path: 'src/new.ts', status: 'A', added: 4, removed: 0 }],
    unstaged: [
      { path: 'README.md', status: 'M', added: 1, removed: 1 },
      { path: 'docs/old.md', status: 'D', added: 0, removed: 3 },
      { path: 'gone/x.md', status: 'D', added: 0, removed: 2 },
    ],
    untracked: [{ path: 'scratch/', status: '?', added: null, removed: null }],
  },
}
const entry = (path: string, type: 'file' | 'directory' = 'file') => ({ name: path.split('/').pop()!, path, type, ...(type === 'file' ? { size: 3 } : {}) })
const LISTINGS: Record<string, DirectoryListing> = {
  '': { path: '', entries: [entry('docs', 'directory'), entry('scratch', 'directory'), entry('src', 'directory'), entry('README.md'), entry('a.md')] } as DirectoryListing,
  src: { path: 'src', entries: [entry('src/keep.ts'), entry('src/new.ts')] } as DirectoryListing,
  docs: { path: 'docs', entries: [entry('docs/plan.md')] } as DirectoryListing,
  scratch: { path: 'scratch', entries: [entry('scratch/tmp.txt')] } as DirectoryListing,
}

let git: GitStatus = REPO, calls: string[] = []
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string): Promise<T> {
    const url = new URL(path, 'http://x')
    calls.push(`${url.pathname}${url.search}`)
    if (url.pathname.endsWith('/preview/discovery')) return { status: 'none' } as T
    if (url.pathname.endsWith('/preview')) return { status: 'stopped' } as T
    if (url.pathname.endsWith('/git')) return git as T
    if (url.pathname.endsWith('/files')) {
      const listing = LISTINGS[url.searchParams.get('path') ?? '']
      if (!listing) throw new ApiError('没有这个目录。', 404, 'not_found')
      return listing as T
    }
    return { path: url.searchParams.get('path'), content: '# A', bytes: 3, truncated: false } as T
  },
  openStream() { throw new Error('unused') },
}

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  git = REPO; calls = []
  resetPreviews(); resetSidePanel(); resetGitStatus()
  useApp.setState({ status: 'ready', projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never }, sessions: {}, sessionIndex: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous); resetPreviews(); resetGitStatus() })

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const render = async () => { await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(FilesSurface, { projectId: 'p', visible: true, layout: 'panel' }))) }); await flush() }
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-file-path]')].map(row => `${row.dataset.filePath}${row.dataset.change ? `:${row.dataset.change}` : ''}${row.dataset.gone ? ' (gone)' : ''}`)
const filter = () => host.querySelector<HTMLButtonElement>('[data-files-changed-only]')
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await flush() }

describe('change markers (pure)', () => {
  const changes = new Map<string, ChangeKind>([['src/new.ts', 'added'], ['src/lib/a.ts', 'modified'], ['docs/old.md', 'deleted'], ['gone/deep/x.md', 'deleted'], ['scratch', 'added']])

  it('a folder shows what changed inside it: one kind when all alike, else modified; cached per map', () => {
    const folders = folderChanges(changes)
    expect(Object.fromEntries(folders)).toEqual({ src: 'modified', 'src/lib': 'modified', docs: 'deleted', gone: 'deleted', 'gone/deep': 'deleted' })
    expect(folderChanges(changes)).toBe(folders)
    expect(Object.fromEntries(folderChanges(new Map([['a/b.ts', 'added'], ['a/c.ts', 'added']])))).toEqual({ a: 'added' })
  })

  it('a deleted file is listed where it was, with the folders on its way', () => {
    const gone = goneEntries(changes)
    expect(gone.get('')).toEqual([{ name: 'docs', path: 'docs', type: 'directory' }, { name: 'gone', path: 'gone', type: 'directory' }])
    expect(gone.get('gone/deep')).toEqual([{ name: 'x.md', path: 'gone/deep/x.md', type: 'file' }])
    expect(gone.has('src')).toBe(false)
  })

  it('a file inside a new folder (git lists an untracked folder once) reads new', () => {
    expect(changeOf(changes, 'scratch/tmp/a.txt', 'file')).toBe('added')
    expect(changeOf(changes, 'src', 'directory')).toBe('modified')
    expect(changeOf(changes, 'src/keep.ts', 'file')).toBeUndefined()
  })

  it('only the changes: the folders holding them and what changed inside, deleted entries included', () => {
    const dirs = new Map(Object.entries(LISTINGS))
    const repo = new Map<string, ChangeKind>([['src/new.ts', 'added'], ['README.md', 'modified'], ['docs/old.md', 'deleted'], ['scratch', 'added']])
    const all = treeRows(dirs, new Set(['src', 'docs']), repo, false).map(row => `${row.path}${row.change ? `:${row.change}` : ''}${row.gone ? '!' : ''}`)
    expect(all).toEqual(['docs:deleted', 'docs/plan.md', 'docs/old.md:deleted!', 'scratch:added', 'src:added', 'src/keep.ts', 'src/new.ts:added', 'README.md:modified', 'a.md'])
    const only = treeRows(dirs, new Set(['src', 'docs', 'scratch']), repo, true).map(row => row.path)
    expect(only).toEqual(['docs', 'docs/old.md', 'scratch', 'scratch/tmp.txt', 'src', 'src/new.ts', 'README.md'])
  })
})

describe('the 文件 surface marks what changed (layout plan §3)', () => {
  it('marks changed files from git, dots folders by what changed inside, and shows deleted files struck through', async () => {
    await render()
    expect(rows()).toEqual(['docs:deleted', 'scratch:added', 'src:added', 'README.md:modified', 'a.md', 'gone:deleted (gone)'])
    const readme = host.querySelector('[data-file-path="README.md"]')!
    expect(readme.textContent).toBe('README.mdM已修改')
    expect(readme.getAttribute('title')).toBe('README.md · 已修改')
    expect(host.querySelector('[data-file-path="docs"]')!.getAttribute('title')).toBe('docs · 里面有改动')
    // A deleted folder opens from the changes alone (nothing on disk to list); its file does not open.
    await click(host.querySelector('[data-file-path="gone"]'))
    expect(calls.some(call => call.includes('/files?path=gone'))).toBe(false)
    const ghost = host.querySelector('[data-file-path="gone/x.md"]')!
    expect(ghost.getAttribute('aria-disabled')).toBe('true')
    await click(ghost)
    expect(ghost.getAttribute('aria-selected')).toBe('false')
    expect(calls.some(call => call.includes('/file?'))).toBe(false)
  })

  it('只看改动 narrows the tree to the changes and opens the folders holding them; turning it off shows everything again', async () => {
    await render()
    expect(filter()!.getAttribute('aria-label')).toBe('只看改动，共 5 处改动')
    expect(filter()!.getAttribute('aria-pressed')).toBe('false')
    // Reading a file shows its content (one pane at a time when narrow); the filter brings the list back into view.
    const treePane = () => host.querySelector('[data-files-pane="tree"]')!.className.split(' ')
    await click(host.querySelector('[data-file-path="README.md"]'))
    expect(treePane()).toContain('hidden')
    await click(filter())
    expect(treePane()).not.toContain('hidden')
    expect(filter()!.getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toEqual(['docs:deleted', 'docs/old.md:deleted (gone)', 'scratch:added', 'src:added', 'src/new.ts:added', 'README.md:modified', 'gone:deleted (gone)', 'gone/x.md:deleted (gone)'])
    // The folders were listed in one go; a folder that is gone from disk is no error.
    expect(calls.filter(call => call.includes('/files?path=') && !call.endsWith('path=')).sort()).toEqual(['/api/projects/p/files?path=docs', '/api/projects/p/files?path=gone', '/api/projects/p/files?path=src'])
    expect(host.querySelector('[role="status"]')).toBeNull()
    // A new folder's files are all new: opening it shows them.
    await click(host.querySelector('[data-file-path="scratch"]'))
    expect(rows()).toContain('scratch/tmp.txt:added')
    await click(filter())
    expect(rows()).toContain('a.md')
    expect(rows()).toContain('src/keep.ts')
  })

  it('without git, marks what Rna recorded changing (kept background change sets)', async () => {
    git = PLAIN
    useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w', backgroundChanges: [{ id: 'bg', actionId: 'a', at: '', status: 'kept', count: 1, paths: ['/w/docs/plan.md'] }] } as never } })
    await render()
    expect(rows()).toEqual(['docs:modified', 'scratch', 'src', 'README.md', 'a.md'])
    await click(filter())
    expect(rows()).toEqual(['docs:modified', 'docs/plan.md:modified'])
  })

  it('offers 只看改动 only while something changed; with the filter on and nothing left, says so and offers everything back', async () => {
    git = PLAIN
    await render()
    expect(filter()).toBeNull()
    git = REPO
    resetGitStatus()
    await act(async () => { root.unmount() }); root = createRoot(host); await render()
    await click(filter())
    // A run ends and git's status is read again: nothing changed any more.
    git = PLAIN
    await act(async () => { await loadGitStatus('p') }); await flush()
    expect(host.querySelector('[data-files-no-changes]')!.textContent).toBe('没有改动的文件。显示全部文件')
    await click([...host.querySelectorAll('button')].find(button => button.textContent === '显示全部文件')!)
    expect(filter()).toBeNull()
    expect(rows()).toContain('a.md')
  })
})
