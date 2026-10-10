import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTransport, getTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { applyIndex } from '@/store/sync'
import { pendingDeletes } from '@/store/pending-deletes'
import { deleteEntity } from './entity-actions'
import { ApiError } from '@/api/transport'
import { usePanels } from '@/components/settings/panel-store'
import { useUi } from '@/store/ui-store'

// Deleting runs in the background: the session leaves the list at once, index
// updates during the deletion do not bring it back, and a failure restores it.
const summary = (id: string, projectId = 'p1', lastItemAt = '2026-09-30T10:00:00.000Z') => ({ id, projectId, title: id, status: 'idle', lastItemAt, updatedAt: lastItemAt }) as never

function stub(settle: { resolve?: (value: unknown) => void; reject?: (error: Error) => void }): Transport {
  return { kind: 'mock', openStream: () => { throw new Error('no streams') }, request: <T,>(path: string, init?: RequestInit) => new Promise<T>((resolve, reject) => {
    if (init?.method === 'DELETE') { settle.resolve = resolve as (value: unknown) => void; settle.reject = reject; return }
    reject(new Error(`unexpected ${path}`))
  }) }
}

describe('deleteEntity (background)', () => {
  const original = getTransport()
  beforeEach(() => {
    useApp.setState({ sessionIndex: { s1: summary('s1', 'p1', '2026-09-30T11:00:00.000Z'), s2: summary('s2') }, sessionOrder: ['s1', 's2'], sessions: {}, selectedSessionId: 's2', revision: 1 } as never)
  })
  afterEach(() => { setTransport(original); pendingDeletes.sessions.clear(); pendingDeletes.projects.clear() })

  it('removes at once, ignores index updates while deleting, and finishes quietly', async () => {
    const settle: Parameters<typeof stub>[0] = {}
    setTransport(stub(settle))
    const done = deleteEntity('session', 's1')
    expect(useApp.getState().sessionOrder).toEqual(['s2'])
    expect(pendingDeletes.sessions.has('s1')).toBe(true)
    // The host still lists it while it works: the index must not bring it back.
    applyIndex({ revision: 2, sessions: [summary('s1'), summary('s2')] } as never)
    expect(Object.keys(useApp.getState().sessionIndex)).toEqual(['s2'])
    settle.resolve!({ deleted: true })
    await done
    expect(pendingDeletes.sessions.has('s1')).toBe(false)
    expect(useApp.getState().sessionOrder).toEqual(['s2'])
  })

  it('takes the conversation\'s draft and its sidecar of files and carried tasks with it', async () => {
    localStorage.setItem('rna.draft.s1', 'half a thought'); localStorage.setItem('rna.draft.s1.carry', '{"tasks":[]}'); localStorage.setItem('rna.draft.s2', 'keep me')
    const settle: Parameters<typeof stub>[0] = {}
    setTransport(stub(settle))
    const done = deleteEntity('session', 's1')
    settle.resolve!({ deleted: true })
    await done
    expect([localStorage.getItem('rna.draft.s1'), localStorage.getItem('rna.draft.s1.carry'), localStorage.getItem('rna.draft.s2')]).toEqual([null, null, 'keep me'])
    localStorage.removeItem('rna.draft.s2')
  })

  it('puts the session back where it was when the host refuses', async () => {
    const settle: Parameters<typeof stub>[0] = {}
    setTransport(stub(settle))
    const done = deleteEntity('session', 's1')
    expect(useApp.getState().sessionOrder).toEqual(['s2'])
    settle.reject!(new Error('会话正在维护'))
    await expect(done).rejects.toThrow('会话正在维护')
    expect(useApp.getState().sessionOrder).toEqual(['s1', 's2'])
    expect(useApp.getState().sessionIndex.s1).toBeTruthy()
    expect(pendingDeletes.sessions.size).toBe(0)
  })

  it('asks again with the count when the conversation\'s worktree holds unapplied changes, then deletes with confirm', async () => {
    const bodies: unknown[] = []
    let refuse = true
    setTransport({ kind: 'mock', openStream: () => { throw new Error('no streams') }, request: <T,>(_path: string, init?: RequestInit) => {
      bodies.push(init?.body)
      if (refuse) return Promise.reject(new ApiError('还有 3 个文件没有应用', 409, 'worktree_unapplied', { unapplied: 3 }))
      return Promise.resolve({ deleted: true } as T)
    } })
    usePanels.setState({ remove: null })
    await expect(deleteEntity('session', 's1')).rejects.toThrow()
    expect(useApp.getState().sessionOrder).toEqual(['s1', 's2'])
    expect(usePanels.getState().remove).toEqual({ kind: 'session', id: 's1', unapplied: 3 })
    refuse = false
    await deleteEntity('session', 's1', { confirm: true })
    expect(bodies).toEqual([{}, { confirm: true }])
    expect(useApp.getState().sessionOrder).toEqual(['s2'])
    usePanels.setState({ remove: null })
  })

  it('asks again naming how many of the files hold secrets (B8: they go to the trash, not into Git)', async () => {
    const workers = [{ agentId: 'agent-1', worktreeId: 'wt-1', files: 2, task: 'Rotate the key', role: 'worker', secret: 1 }]
    setTransport({ kind: 'mock', openStream: () => { throw new Error('no streams') }, request: () => Promise.reject(new ApiError('还有改动没有应用', 409, 'worktree_unapplied', { unapplied: 1, workers, secret: 2 })) })
    usePanels.setState({ remove: null })
    await expect(deleteEntity('session', 's1')).rejects.toThrow()
    expect(usePanels.getState().remove).toEqual({ kind: 'session', id: 's1', unapplied: 1, workers, secret: 2 })
    usePanels.setState({ remove: null })
  })

  it('asks again listing the subagent copies whose changes are not merged (B8), then deletes with confirm', async () => {
    const bodies: unknown[] = []
    let refuse = true
    const workers = [{ agentId: 'agent-1', worktreeId: 'wt-1', files: 2, task: 'Write chapter 3', role: 'worker' }]
    setTransport({ kind: 'mock', openStream: () => { throw new Error('no streams') }, request: <T,>(_path: string, init?: RequestInit) => {
      bodies.push(init?.body)
      if (refuse) return Promise.reject(new ApiError('子代理的改动还没合并', 409, 'worktree_unapplied', { unapplied: 0, workers }))
      return Promise.resolve({ deleted: true } as T)
    } })
    usePanels.setState({ remove: null })
    await expect(deleteEntity('session', 's1')).rejects.toThrow()
    // Only the workers: no made-up count of the conversation's own worktree.
    expect(usePanels.getState().remove).toEqual({ kind: 'session', id: 's1', workers })
    refuse = false
    await deleteEntity('session', 's1', { confirm: true })
    expect(bodies).toEqual([{}, { confirm: true }])
    usePanels.setState({ remove: null })
  })

  // Review X-1: a cleanup that cannot finish on its own says it needs a decision, never that it continues by itself.
  it('says a blocked cleanup needs the user, for a conversation and for one of a project\'s conversations', async () => {
    for (const [kind, cleanup] of [['session', { status: 'blocked' }], ['project', { status: 'pending', sessions: [{ sessionId: 's1', status: 'blocked' }] }]] as const) {
      useUi.setState({ toasts: [] })
      const settle: Parameters<typeof stub>[0] = {}
      setTransport(stub(settle))
      const done = deleteEntity(kind, kind === 'session' ? 's1' : 'p1')
      settle.resolve!({ deleted: true, cleanup })
      await done
      expect(useUi.getState().toasts.map(row => row.text)).toEqual(['已移除。有一项清理需要你决定，可在「已归档」中查看。'])
    }
  })
})
