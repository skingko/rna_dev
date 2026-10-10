import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import type { GitStatus } from '@/api/git-api'
import type { Item, ProjectSummary } from '@/api/types'
import { useApp } from '@/store/app-store'
import { changedFolders, changesFromGit, changesFromRecords, loadGitStatus, resetGitStatus, useChangedPaths, useGitStatus, useGitWatch, type ChangeKind } from './workspace-changes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = (patch: Partial<GitStatus['files']> = {}): GitStatus => ({
  repo: 'main', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, operation: null,
  files: { conflicted: [], staged: [], unstaged: [], untracked: [], ...patch },
})
const plain: GitStatus = { ...repo(), repo: 'none' }
const edit = (id: string, path: string, created = false, turnId = 't1'): Item => ({
  id, kind: 'tool', turnId, createdAt: '2026-10-03T10:00:00Z',
  tool: created ? { name: 'project_write', status: 'succeeded', args: { path, content: 'x' }, created: true } : { name: 'project_edit', status: 'succeeded', args: { path, oldText: 'a', newText: 'b' } },
} as unknown as Item)

let calls: string[] = [], answer: GitStatus = repo(), pending: (() => void) | null = null
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push(`${init.method ?? 'GET'} ${path}`)
    if (pending === null) return answer as T
    await new Promise<void>(resolve => { pending = resolve })
    return answer as T
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
const project = (patch: Partial<ProjectSummary> = {}): ProjectSummary => ({ id: 'p1', name: 'P', workspacePath: '/w/p1', ...patch })
beforeEach(() => {
  setTransport(transport); calls = []; answer = repo(); pending = null; resetGitStatus()
  useApp.setState({ status: 'ready', projects: { p1: project() }, projectOrder: ['p1'], sessionIndex: { s1: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' } }, sessions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

describe('change kinds', () => {
  it('git: what is on disk wins, a new file stays new, untracked folders lose their slash', () => {
    const status = repo({
      staged: [{ path: 'a.ts', status: 'A', added: 1, removed: 0 }, { path: 'gone.ts', status: 'D', added: 0, removed: 3 }, { path: 'n.ts', status: 'R', oldPath: 'o.ts', added: 0, removed: 0 }],
      unstaged: [{ path: 'a.ts', status: 'M', added: 1, removed: 1 }, { path: 'b/c.ts', status: 'M', added: 2, removed: 0 }, { path: 'x.ts', status: 'D', added: 0, removed: 1 }],
      untracked: [{ path: 'dist/', status: '?', added: null, removed: null }],
      conflicted: [{ path: 'm.ts', status: 'U', added: null, removed: null }],
    })
    expect(Object.fromEntries(changesFromGit(status))).toEqual({ 'a.ts': 'added', 'gone.ts': 'deleted', 'n.ts': 'added', 'b/c.ts': 'modified', 'x.ts': 'deleted', dist: 'added', 'm.ts': 'modified' })
  })

  it('records: kept background sets and finished edits of the conversation, as workspace paths', () => {
    const items = { e1: edit('e1', '/w/p1/src/a.ts'), e2: edit('e2', 'docs/new.md', true), e3: { ...edit('e3', 'src/b.ts'), tool: { name: 'project_edit', status: 'failed', args: { path: 'src/b.ts', oldText: 'a', newText: 'b' } } } as unknown as Item, e4: edit('e4', '/elsewhere/x.ts') }
    const changes = [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['lib/k.ts'] }, { id: 'c2', actionId: 'a2', at: '', status: 'reverted', count: 1, paths: ['lib/r.ts'] }]
    expect(Object.fromEntries(changesFromRecords(changes, items, ['e1', 'e2', 'e3', 'e4'], '/w/p1'))).toEqual({ 'lib/k.ts': 'modified', 'src/a.ts': 'modified', 'docs/new.md': 'added' })
  })

  it('folders above changed files, cached per map', () => {
    const map = new Map<string, ChangeKind>([['a/b/c.ts', 'modified'], ['a/d.ts', 'added'], ['e.ts', 'deleted']])
    const folders = changedFolders(map)
    expect([...folders].sort()).toEqual(['a', 'a/b'])
    expect(changedFolders(map)).toBe(folders)
  })
})

describe('git status store', () => {
  it('shares a load already on its way, and skips a focus refresh right after one', async () => {
    pending = () => {}
    const first = loadGitStatus('p1'), second = loadGitStatus('p1')
    expect(first).toBe(second)
    expect(useGitStatus.getState().rows.p1.loading).toBe(true)
    pending!(); pending = null
    await first
    expect(calls).toEqual(['GET /api/v2/projects/p1/git'])
    expect(useGitStatus.getState().rows.p1).toMatchObject({ loading: false, error: null, status: answer })
    await loadGitStatus('p1', { minAgeMs: 60_000 })
    expect(calls).toHaveLength(1)
    await loadGitStatus('p1', { upstream: true })
    expect(calls.at(-1)).toBe('GET /api/v2/projects/p1/git?include=upstream')
    expect(useGitStatus.getState().rows.p1.upstreamFiles).toEqual([])
  })

  it('watching: reads on mount and on window focus, and again when a run ends — not while one only starts', async () => {
    function Watch() { useGitWatch('p1', 's1'); return null }
    await act(async () => { root.render(createElement(Watch)) }); await settle()
    expect(calls).toEqual(['GET /api/v2/projects/p1/git'])
    useGitStatus.setState(s => ({ rows: { ...s.rows, p1: { ...s.rows.p1, at: 0 } } }))
    await act(async () => { window.dispatchEvent(new Event('focus')) }); await settle()
    expect(calls).toHaveLength(2)
    // The conversation starts a turn (no read), then finishes it (read).
    await act(async () => { useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s1: { ...s.sessionIndex.s1, status: 'running' } } })) }); await settle()
    expect(calls).toHaveLength(2)
    await act(async () => { useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s1: { ...s.sessionIndex.s1, status: 'idle' } } })) }); await settle()
    expect(calls).toHaveLength(3)
    // A background change set appears, then is reverted.
    await act(async () => { useApp.setState({ projects: { p1: project({ backgroundChanges: [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['x'] }] }) } }) }); await settle()
    expect(calls).toHaveLength(4)
    await act(async () => { useApp.setState({ projects: { p1: project({ backgroundChanges: [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['x'] }], description: 'renamed' }) } }) }); await settle()
    expect(calls).toHaveLength(4) // an unrelated summary change is not a run ending
  })
})

describe('useChangedPaths', () => {
  let seen: ReadonlyMap<string, ChangeKind>[] = []
  function Probe({ sessionId }: { sessionId: string | null }) { seen.push(useChangedPaths('p1', sessionId)); return null }
  beforeEach(() => { seen = [] })

  it('git present: its status, with an identity that holds while the content does', async () => {
    answer = repo({ unstaged: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 0 }], untracked: [{ path: 'new.md', status: '?', added: null, removed: null }] })
    await act(async () => { root.render(createElement(Probe, { sessionId: 's1' })) }); await settle()
    const last = seen.at(-1)!
    expect(Object.fromEntries(last)).toEqual({ 'src/a.ts': 'modified', 'new.md': 'added' })
    await act(async () => { useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, s1: { ...s.sessionIndex.s1, title: 'renamed' } } })) })
    await act(async () => { root.render(createElement(Probe, { sessionId: 's1' })) })
    expect(seen.at(-1)).toBe(last)
  })

  it('no repository: Rna’s records of the project and the conversation', async () => {
    answer = plain
    useApp.setState({
      projects: { p1: project({ backgroundChanges: [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['lib/k.ts'] }] }) },
      sessions: { s1: { meta: { id: 's1', title: 'S', status: 'idle', projectId: 'p1' }, items: { e1: edit('e1', 'src/a.ts') }, order: ['e1'], turns: {}, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false } as never },
    })
    await act(async () => { root.render(createElement(Probe, { sessionId: 's1' })) }); await settle()
    expect(Object.fromEntries(seen.at(-1)!)).toEqual({ 'lib/k.ts': 'modified', 'src/a.ts': 'modified' })
    await act(async () => { root.render(createElement(Probe, { sessionId: null })) })
    expect(Object.fromEntries(seen.at(-1)!)).toEqual({ 'lib/k.ts': 'modified' })
  })

  it('no repository: streaming text re-renders nothing; a finished edit does, and wins over a change set’s mark', async () => {
    answer = plain
    const slice = (items: Record<string, Item>, order: string[]) => ({ meta: { id: 's1', title: 'S', status: 'running', projectId: 'p1' }, items, order, turns: {}, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false }) as never
    const reply = (text: string) => ({ id: 'm1', kind: 'assistant', turnId: 't1', text }) as unknown as Item
    useApp.setState({
      projects: { p1: project({ backgroundChanges: [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['docs/new.md'] }] }) },
      sessions: { s1: slice({ e1: edit('e1', 'src/a.ts'), m1: reply('写') }, ['e1', 'm1']) },
    })
    await act(async () => { root.render(createElement(Probe, { sessionId: 's1' })) }); await settle()
    const renders = seen.length, before = seen.at(-1)!
    for (const text of ['写一', '写一段', '写一段说明']) {
      await act(async () => { useApp.setState(s => ({ sessions: { s1: slice({ ...(s.sessions.s1 as unknown as { items: Record<string, Item> }).items, m1: reply(text) }, ['e1', 'm1']) } })) })
    }
    expect(seen).toHaveLength(renders)
    await act(async () => { useApp.setState({ sessions: { s1: slice({ e1: edit('e1', 'src/a.ts'), m1: reply('写'), e2: edit('e2', 'docs/new.md', true) }, ['e1', 'm1', 'e2']) } }) })
    expect(seen.length).toBeGreaterThan(renders)
    expect(seen.at(-1)).not.toBe(before)
    expect(Object.fromEntries(seen.at(-1)!)).toEqual({ 'docs/new.md': 'added', 'src/a.ts': 'modified' })
  })

  it('a repository whose status could not be read falls back to Rna’s records', async () => {
    answer = { ...repo(), unavailable: 'timed_out' }
    useApp.setState({ projects: { p1: project({ backgroundChanges: [{ id: 'c1', actionId: 'a1', at: '', status: 'kept', count: 1, paths: ['lib/k.ts'] }] }) } })
    await act(async () => { root.render(createElement(Probe, { sessionId: null })) }); await settle()
    expect(Object.fromEntries(seen.at(-1)!)).toEqual({ 'lib/k.ts': 'modified' })
  })
})
