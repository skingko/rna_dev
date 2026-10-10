/** Where a conversation's files are (worktree design §9, web part): its worktree first, then the project folder. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useApp } from '@/store/app-store'
import { resetIsolation, useIsolation } from '@/store/isolation-store'
import { toWorkspacePath } from '@/components/preview/registry'
import { readSessionFor, rootsFor, rootsOf, worktreeRoot } from './session-root'

const P = '/Users/me/game'
const S = `${P}/.rna/worktrees.nosync/s-1a2b3c4d`
const slice = (id: string, meta: Record<string, unknown>) => ({ meta: { id, title: id, status: 'idle', ...meta }, items: {}, order: [], turns: {}, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false })

beforeEach(() => {
  resetIsolation()
  useApp.setState({
    projects: { p1: { id: 'p1', name: 'Game', workspacePath: P }, p2: { id: 'p2', name: 'Other', workspacePath: '/Users/me/other' } },
    sessionIndex: { direct: { id: 'direct', title: 'd', status: 'idle', projectId: 'p1' }, wt: { id: 'wt', title: 'w', status: 'idle', projectId: 'p1', worktree: { id: 'wt-1', state: 'active' } } },
    sessions: { wt: slice('wt', { projectId: 'p1', worktree: { id: 'wt-1', state: 'active' } }) as never },
  })
  useIsolation.setState({ worktrees: { p1: { data: { isolation: { enabled: true, git: '2.39.5' }, worktrees: [{ id: 'wt-1', kind: 'session', owner: { sessionId: 'wt' }, path: S, state: 'active', createdAt: '', pending: { files: 0 } }] }, loading: false, error: null, at: 1 } } })
})
afterEach(() => resetIsolation())

describe('toWorkspacePath with several roots', () => {
  it('takes the first root that holds an absolute path, the conversation’s own first', () => {
    expect(toWorkspacePath(`${S}/src/a.ts`, [S, P])).toBe('src/a.ts')
    expect(toWorkspacePath(`${P}/src/a.ts`, [S, P])).toBe('src/a.ts')
    expect(toWorkspacePath('src/./b.ts', [S, P])).toBe('src/b.ts')
    expect(toWorkspacePath('/elsewhere/a.ts', [S, P])).toBeNull()
  })

  it('never resolves into Rna’s private .rna folder (a worktree path read against the project folder alone)', () => {
    expect(toWorkspacePath(`${S}/src/a.ts`, [P])).toBeNull()
    expect(toWorkspacePath(`${P}/.rna/trash.nosync/x`, [P])).toBeNull()
    // A single root keeps the old behaviour.
    expect(toWorkspacePath(`${S}/src/a.ts`, P)).toBe('.rna/worktrees.nosync/s-1a2b3c4d/src/a.ts')
  })
})

describe('rootsOf / rootsFor / readSessionFor', () => {
  it('a worktree conversation: its worktree, then the project folder; a direct one: the project folder', () => {
    expect(rootsOf('wt')).toEqual([S, P])
    expect(rootsOf('direct')).toEqual([P])
    expect(rootsOf(null)).toEqual([])
  })

  it('the worktree is only known once the project’s list is read; until then the project folder alone', () => {
    resetIsolation()
    expect(rootsOf('wt')).toEqual([P])
  })

  it('another project’s path is read against that project’s folder, never the conversation’s worktree', () => {
    expect(rootsFor('p2', 'wt')).toEqual(['/Users/me/other'])
    expect(rootsFor('p1', 'wt')).toEqual([S, P])
  })

  it('reads go through a worktree conversation of the same project only', () => {
    expect(readSessionFor('p1', 'wt')).toBe('wt')
    expect(readSessionFor('p1', 'direct')).toBeNull()
    expect(readSessionFor('p2', 'wt')).toBeNull()
    expect(readSessionFor('p1', null)).toBeNull()
  })

  it('a worktree not made yet (pending: before its first turn, or after the archive cleaned it up) reads the project folder', () => {
    // The host refuses a read through it (409 worktree_pending); its files are the project folder's.
    for (const state of ['pending']) {
      useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, wt: { ...s.sessionIndex.wt, worktree: { id: 'wt-1', state } } }, sessions: { wt: slice('wt', { projectId: 'p1', worktree: { id: 'wt-1', state } }) as never } }))
      expect(readSessionFor('p1', 'wt')).toBeNull()
    }
    // A kept or missing one still names it: the kept copy is read, a missing one says so (never the folder instead).
    for (const state of ['kept', 'missing']) {
      useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, wt: { ...s.sessionIndex.wt, worktree: { id: 'wt-1', state } } }, sessions: { wt: slice('wt', { projectId: 'p1', worktree: { id: 'wt-1', state } }) as never } }))
      expect(readSessionFor('p1', 'wt')).toBe('wt')
    }
  })

  it('a worktree’s root is the host’s `root` when it names one (a project below its repository’s top)', () => {
    const row = { id: 'w', kind: 'session', owner: {}, path: '/repo/.rna/worktrees.nosync/s-1', state: 'active', createdAt: '', pending: { files: 0 } }
    expect(worktreeRoot(row)).toBe('/repo/.rna/worktrees.nosync/s-1')
    expect(worktreeRoot({ ...row, root: '/repo/.rna/worktrees.nosync/s-1/game' } as typeof row)).toBe('/repo/.rna/worktrees.nosync/s-1/game')
  })
})
