import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { useApp } from './app-store'
import { dropOutbox, queueOutbox, useOutbox, useOutboxFlush } from './outbox'
import { resetIsolation } from './isolation-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const previous = getTransport()
afterEach(() => { setTransport(previous); useOutbox.setState({ entries: [], sending: false }); localStorage.clear() })

// Plan §2.5 item 10: messages sent during an app update wait in this browser and survive a reload.
describe('outbox', () => {
  it('keeps queued messages in order across a reload and lets one be taken back', () => {
    const a = queueOutbox({ sessionId: 's1', projectId: 'p1', text: '写第 9 章' })
    const b = queueOutbox({ sessionId: null, projectId: 'p1', text: '顺便列人物表' })
    expect(useOutbox.getState().entries.map(row => row.text)).toEqual(['写第 9 章', '顺便列人物表'])
    expect(JSON.parse(localStorage.getItem('rna.outbox') ?? '[]').map((row: { id: string }) => row.id)).toEqual([a.id, b.id])
    dropOutbox(a.id)
    expect(useOutbox.getState().entries.map(row => row.id)).toEqual([b.id])
    dropOutbox(b.id)
    expect(localStorage.getItem('rna.outbox')).toBeNull()
  })

  it('sends a carried 接着完成 with its task, queued behind the turn like when it was first posted', async () => {
    const sent: Record<string, unknown>[] = []
    setTransport({ kind: 'mock', async request<T>(_path: string, init?: { body?: unknown }): Promise<T> { sent.push(init?.body as Record<string, unknown>); return {} as T }, openStream: () => { throw new Error('no streams') } } as Transport)
    useApp.setState({ status: 'ready', maintenanceHeld: true, sessionIndex: { s1: { id: 's1', title: 't', status: 'running' } } })
    queueOutbox({ sessionId: 's1', projectId: 'p1', text: '先把标题改短' })
    queueOutbox({ sessionId: 's1', projectId: 'p1', text: '接着完成：整理第三章', continues: { actionId: 'act-1' } })
    expect(JSON.parse(localStorage.getItem('rna.outbox') ?? '[]')[1].continues).toEqual({ actionId: 'act-1' })
    const host = document.createElement('div'), root = createRoot(host)
    const Flush = () => { useOutboxFlush(); return null }
    await act(async () => { root.render(createElement(Flush)) })
    await act(async () => { useApp.setState({ maintenanceHeld: false }) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(sent).toMatchObject([{ text: '先把标题改短', delivery: 'send' }, { text: '接着完成：整理第三章', delivery: 'followup', continues: { actionId: 'act-1' } }])
    expect(sent[0]).not.toHaveProperty('continues')
    expect(useOutbox.getState().entries).toEqual([])
    act(() => root.unmount())
  })

  it('a new conversation written during the update keeps its 在独立工作树中运行 choice (dropped where isolation is off)', async () => {
    const sent: { path: string; body: Record<string, unknown> }[] = []
    let enabled = true
    setTransport({ kind: 'mock', async request<T>(path: string, init?: { body?: unknown }): Promise<T> {
      sent.push({ path, body: init?.body as Record<string, unknown> })
      if (path.endsWith('/worktrees')) return { isolation: { enabled, git: '2.39.5' }, worktrees: [] } as T
      if (path === '/api/sessions') return { id: `s-${sent.length}` } as T
      return {} as T
    }, openStream: () => { throw new Error('no streams') } } as Transport)
    resetIsolation()
    useApp.setState({ status: 'ready', maintenanceHeld: true, sessionIndex: {} })
    const entry = queueOutbox({ sessionId: null, projectId: 'p1', text: '在副本里改', worktree: true })
    expect(entry.worktree).toBe(true)
    expect(JSON.parse(localStorage.getItem('rna.outbox') ?? '[]')[0].worktree).toBe(true)
    // An existing conversation never carries it.
    expect(queueOutbox({ sessionId: 's9', projectId: 'p1', text: 'x', worktree: true })).not.toHaveProperty('worktree')
    dropOutbox(useOutbox.getState().entries[1].id)
    const host = document.createElement('div'), root = createRoot(host)
    const Flush = () => { useOutboxFlush(); return null }
    await act(async () => { root.render(createElement(Flush)) })
    await act(async () => { useApp.setState({ maintenanceHeld: false }) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(sent.find(call => call.path === '/api/sessions')?.body).toMatchObject({ projectId: 'p1', worktree: true })
    act(() => root.unmount())
    // Isolation went away meanwhile: created in the project folder, as sendMessage does.
    sent.length = 0; enabled = false; resetIsolation()
    useApp.setState({ maintenanceHeld: true })
    queueOutbox({ sessionId: null, projectId: 'p1', text: '再来', worktree: true })
    const again = createRoot(document.createElement('div'))
    await act(async () => { again.render(createElement(Flush)) })
    await act(async () => { useApp.setState({ maintenanceHeld: false }) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(sent.find(call => call.path === '/api/sessions')?.body).not.toHaveProperty('worktree')
    act(() => again.unmount())
  })
})
