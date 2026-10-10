/**
 * Files, previews and terminals follow a worktree conversation's root (0.63, worktree design §9): its absolute paths
 * resolve against its own copy first, and reads of its files carry `?sessionId=` so the host reads them from there.
 * A conversation in the project folder reads as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { projectApi } from '@/api/project-api'
import { terminalApi } from '@/api/side-panel-api'
import { useApp } from '@/store/app-store'
import { resetIsolation, useIsolation } from '@/store/isolation-store'
import { findTab, resetSidePanel, tabIdentity, useSidePanel } from '@/store/side-panel-store'
import { openTerminalTab } from '@/components/side-panel/open'
import { FileTab } from '@/components/side-panel/DetailTabs'
import { openFilePreview } from './open'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = '/Users/me/game'
const S = `${P}/.rna/worktrees.nosync/s-1a2b3c4d`
let calls: { path: string; body?: unknown }[] = []
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push({ path, body: init.body })
    if (path.includes('/files?')) return { path: 'src', entries: [{ name: 'a.md', path: 'src/a.md', type: 'file', size: 12 }] } as T
    if (path.includes('/file?')) return { path: 'src/a.md', content: '# A', bytes: 3 } as T
    return { id: 'term-1' } as T
  },
  openStream: () => { throw new Error('no streams') },
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  calls = []; setTransport(transport); resetIsolation(); resetSidePanel()
  useApp.setState({
    projects: { p1: { id: 'p1', name: 'Game', workspacePath: P } },
    sessionIndex: { wt: { id: 'wt', title: 'w', status: 'idle', projectId: 'p1', worktree: { id: 'wt-1', state: 'active' } }, direct: { id: 'direct', title: 'd', status: 'idle', projectId: 'p1' } } as never,
    sessions: {},
  })
  useIsolation.setState({ worktrees: { p1: { data: { isolation: { enabled: true, git: '2.39.5' }, worktrees: [{ id: 'wt-1', kind: 'session', owner: { sessionId: 'wt' }, path: S, state: 'active', createdAt: '', pending: { files: 0 } }] }, loading: false, error: null, at: 1 } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetIsolation() })
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const fileTabs = () => Object.values(useSidePanel.getState().layout.tabs).filter(tab => tab.type === 'file')

describe('opening a conversation’s file', () => {
  it('a worktree conversation’s absolute path resolves in its copy and opens a tab reading from it', () => {
    expect(openFilePreview('p1', `${S}/src/a.md`, undefined, 'wt')).toBe(true)
    expect(fileTabs()).toMatchObject([{ projectId: 'p1', path: 'src/a.md', sessionId: 'wt' }])
  })

  it('a conversation in the project folder opens the folder’s file, as before', () => {
    expect(openFilePreview('p1', `${P}/src/a.md`, undefined, 'direct')).toBe(true)
    expect(fileTabs()[0]).toMatchObject({ path: 'src/a.md' })
    expect(fileTabs()[0]).not.toHaveProperty('sessionId')
    // Without a conversation, a worktree path is outside the project (never `.rna/…`).
    let fell = false
    expect(openFilePreview('p1', `${S}/src/a.md`, () => { fell = true })).toBe(false)
    expect(fell).toBe(true)
  })

  it('a worktree conversation whose worktree is not made yet opens the project folder’s file (the host refuses a pending one)', () => {
    useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, wt: { ...s.sessionIndex.wt, worktree: { id: 'wt-1', state: 'pending' } } } as never }))
    expect(openFilePreview('p1', `${P}/src/a.md`, undefined, 'wt')).toBe(true)
    expect(fileTabs()[0]).toMatchObject({ path: 'src/a.md' })
    expect(fileTabs()[0]).not.toHaveProperty('sessionId')
  })

  it('the same path in the copy and in the folder are two tabs', () => {
    expect(tabIdentity({ type: 'file', projectId: 'p1', path: 'a.md', sessionId: 'wt' } as never)).not.toBe(tabIdentity({ type: 'file', projectId: 'p1', path: 'a.md' } as never))
  })
})

describe('reads through the conversation’s root', () => {
  it('file routes carry sessionId only when asked to', async () => {
    await projectApi.read('p1', 'src/a.md', undefined, 'wt')
    await projectApi.read('p1', 'src/a.md')
    await projectApi.list('p1', 'src', undefined, 'wt')
    expect(calls.map(call => call.path)).toEqual(['/api/projects/p1/file?path=src%2Fa.md&sessionId=wt', '/api/projects/p1/file?path=src%2Fa.md', '/api/projects/p1/files?path=src&sessionId=wt'])
    expect(projectApi.downloadUrl('p1', 'a b.md', 'wt')).toBe('/api/projects/p1/file/download?path=a%20b.md&sessionId=wt')
    expect(projectApi.rawUrl('p1', 'x.png')).toBe('/api/projects/p1/file/raw?path=x.png')
  })

  it('the file tab reads (and downloads) from the worktree it names', async () => {
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(FileTab, { projectId: 'p1', path: 'src/a.md', sessionId: 'wt' }))) })
    await settle()
    expect(calls.map(call => call.path)).toContain('/api/projects/p1/file?path=src%2Fa.md&sessionId=wt')
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('/api/projects/p1/file/download?path=src%2Fa.md&sessionId=wt')
    expect(host.textContent).toContain('这个对话的工作树')
  })

  it('a terminal opened for a worktree conversation starts in its copy', async () => {
    const id = openTerminalTab('p1', {}, 'wt')
    expect(findTab(id)).toMatchObject({ type: 'terminal', sessionId: 'wt' })
    await terminalApi.create('p1', { cols: 80, rows: 24 }, 'wt')
    await terminalApi.create('p1', { cols: 80, rows: 24 })
    expect(calls.map(call => call.body)).toEqual([{ cols: 80, rows: 24, sessionId: 'wt' }, { cols: 80, rows: 24 }])
  })
})
