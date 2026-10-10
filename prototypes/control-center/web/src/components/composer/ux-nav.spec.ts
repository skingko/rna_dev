import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import type { InitiativeAction } from '@/api/project-api'
import type { Invitation, Item, SessionMeta, Turn } from '@/api/types'
import { useApp } from '@/store/app-store'
import type { SessionSlice } from '@/store/session-model'
import { useTasks } from '@/store/tasks-store'
import { useUi } from '@/store/ui-store'
import { NudgeStrip } from './NudgeStrip'
import { SessionNotice } from './SessionNotice'
import { usePanels } from '@/components/settings/panel-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-03T10:00:00.000Z'
const posts: string[] = []
/** What the host's actions route answers (the project's actions as they are now). */
let hostActions: InitiativeAction[] = []
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: { method?: string } = {}): Promise<T> {
    posts.push(`${init.method ?? 'GET'} ${path}`)
    return (path.endsWith('/initiative/actions') ? { projectId: 'p', actions: hostActions } : {}) as T
  },
  openStream: () => { throw new Error('no streams') },
}

function slice(meta: Partial<SessionMeta>, turns: Turn[] = [], items: Item[] = []): SessionSlice {
  return {
    meta: { id: 's1', title: 't', status: 'idle', projectId: 'p', ...meta } as SessionMeta,
    items: Object.fromEntries(items.map(item => [item.id, item])), order: items.map(item => item.id),
    turns: Object.fromEntries(turns.map(turn => [turn.id, turn])), phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false,
  }
}
const invitation = (id: string, kind: string, patch: Record<string, unknown> = {}): Invitation => ({ id, kind, subject: `${kind}:${id}`, createdAt: at, ...patch })
const failed = (patch: Partial<Turn> & Record<string, unknown> = {}): Turn => ({ id: 't1', status: 'failed', createdAt: at, modelConfig: { execution: 'rna' } as Turn['modelConfig'], ...patch })

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); posts.length = 0; hostActions = []
  useApp.setState({ emergency: false, maintenanceHeld: false, sessions: {}, projects: { p: { id: 'p', name: 'P' } } })
  useUi.setState({ invitationFocus: null, view: 'chat', tasksFocus: null, tasksProject: 'all' })
  useTasks.setState({ actions: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const render = async (element: ReactElement) => {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, element)) })
}
const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')].map(b => b.textContent)

describe('NudgeStrip gates (UX audit F9, F25, F43)', () => {
  it('shows what the user asked to settle while a turn runs, but nothing else', async () => {
    const owed = [invitation('c1', 'commitment', { text: '整理第 3 章', trigger: 'user_request' }), invitation('f1', 'feedback', { itemId: 'a1' })]
    useApp.setState({ sessions: { s1: slice({ status: 'running', invitations: owed }) } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    expect(text()).toBe('')
    await act(async () => { useUi.setState({ invitationFocus: { kind: 'commitment', until: Date.now() + 60_000 } }) })
    expect(text()).toContain('你之前让我“整理第 3 章”，还没做完，要我接着做吗？')
  })

  it('shows the owed cards over a failed turn and an open question card', async () => {
    const question = { id: 'q', kind: 'interaction', createdAt: at, interaction: { status: 'pending' } } as unknown as Item
    useApp.setState({ sessions: { s1: slice({ invitations: [invitation('c1', 'commitment', { text: 'x' })] }, [failed()], [question]) } })
    useUi.setState({ invitationFocus: { kind: 'commitment', until: Date.now() + 60_000 } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    expect(text()).toContain('接着做')
  })

  it('shows the owed cards the user asked for over a draft left in the composer (round 2)', async () => {
    useApp.setState({ sessions: { s1: slice({ invitations: [invitation('c1', 'commitment', { text: '整理第 3 章', trigger: 'user_request' }), invitation('l1', 'lesson', { text: '先给结论' })] }) } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: true }))
    expect(text()).toBe('')
    await act(async () => { useUi.setState({ invitationFocus: { kind: 'commitment', until: Date.now() + 60_000 } }) })
    expect(text()).toContain('你之前让我“整理第 3 章”')
  })

  it('holds the owed cards while the session is paused: a message there would resume the turn (round 2)', async () => {
    useApp.setState({ sessions: { s1: slice({ status: 'paused', pauseReason: 'recovery', invitations: [invitation('c1', 'commitment', { text: '整理第 3 章' })] }) } })
    useUi.setState({ invitationFocus: { kind: 'commitment', until: Date.now() + 60_000 } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    expect(text()).toBe('')
  })

  it('answering a background task card re-reads the project\'s actions (C2-d)', async () => {
    useApp.setState({ sessions: { s1: slice({ invitations: [invitation('k-answered', 'task', { mode: 'review', text: '写第 4 章', actionId: 'a1' })] }) } })
    useTasks.setState({ actions: { p: [{ id: 'a1', action: 'work', status: 'needs_review', blocksExecution: true }] } })
    hostActions = [{ id: 'a1', action: 'work', status: 'completed', blocksExecution: false }]
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '按现在的算')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(posts).toContain('POST /api/v2/sessions/s1/invitations/k-answered')
    expect(posts.at(-1)).toBe('GET /api/projects/p/initiative/actions')
    expect(useTasks.getState().actions.p?.[0].status).toBe('completed')
  })

  it('a failed turn does not hide the background decision it may be waiting on', async () => {
    const rows = [invitation('f1', 'feedback', { itemId: 'a1' }), invitation('k1', 'task', { mode: 'review', text: '写第 4 章' })]
    useApp.setState({ sessions: { s1: slice({ invitations: rows }, [failed({ errorCode: 'background_recovery_required' })]) } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    expect(text()).toContain('后台“写第 4 章”被打断')
    expect(buttons()).toContain('按现在的算')
  })
})

describe('commitment wording follows who promised (UX audit F19)', () => {
  const show = async (patch: Record<string, unknown>) => {
    useApp.setState({ sessions: { s1: slice({ invitations: [invitation(`c-${Object.keys(patch).length}-${String(patch.trigger)}`, 'commitment', { text: '补上测试', ...patch })] }) } })
    await render(createElement(NudgeStrip, { sessionId: 's1', typing: false }))
    return text()
  }
  it('Rna\'s own promise is not put in the user\'s mouth: it asks from its own side', async () => {
    expect(await show({ trigger: 'agent_promise' })).toContain('我之前说过要“补上测试”，还要做吗？')
  })
  it('the user\'s own request reads as before', async () => {
    expect(await show({ trigger: 'user_request' })).toContain('你之前让我“补上测试”，还没做完，要我接着做吗？')
  })
  it('older hosts without a trigger get a neutral line', async () => {
    expect(await show({})).toContain('“补上测试”还没做完，要我接着做吗？')
  })
})

describe('SessionNotice: the project folder is gone', () => {
  it('says what to fix and where the path is, instead of a plain retry that fails again', async () => {
    useApp.setState({ sessions: { s1: slice({}, [failed({ errorCode: 'workspace_missing' })]) } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(text()).toContain('找不到项目文件夹')
    expect(buttons()).toEqual(['重试请求', '查看文件夹路径'])
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '查看文件夹路径')!.click() })
    expect(usePanels.getState().projectSettings).toEqual({ projectId: 'p', tab: 'overview' })
  })
})

describe('SessionNotice: refused until background work is reviewed (UX audit F9, F84)', () => {
  const refused = failed({ errorCode: 'background_recovery_required', blockingActionId: 'a1' })

  it('sends the user to the blocking task instead of offering a retry that fails again', async () => {
    useApp.setState({ sessions: { s1: slice({}, [refused]) } })
    hostActions = [{ id: 'a1', action: 'work', status: 'needs_review', blocksExecution: true }]
    useTasks.setState({ actions: { p: hostActions } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(text()).toContain('后台有一项工作被打断，结果还没核对')
    expect(buttons()).toEqual(['去核对'])
    await act(async () => { host.querySelector('button')!.click() })
    expect(useUi.getState()).toMatchObject({ view: 'tasks', tasksProject: 'p', tasksFocus: { key: 'p:action:a1' }, tasksTab: 'adhoc' })
  })

  it('offers the retry once the action is settled', async () => {
    useApp.setState({ sessions: { s1: slice({}, [refused]) } })
    hostActions = [{ id: 'a1', action: 'work', status: 'completed', blocksExecution: false }]
    useTasks.setState({ actions: { p: hostActions } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(text()).toContain('后台那项工作已经核对')
    expect(buttons()).toEqual(['重试请求'])
  })

  it('reads the actions again: one settled elsewhere no longer holds the notice on 去核对 (C2-d)', async () => {
    useApp.setState({ sessions: { s1: slice({}, [refused]) } })
    useTasks.setState({ actions: { p: [{ id: 'a1', action: 'work', status: 'needs_review', blocksExecution: true }] } })
    hostActions = [{ id: 'a1', action: 'work', status: 'completed', blocksExecution: false }]
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    // The stale notice fades out as the settled one comes in.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(posts).toContain('GET /api/projects/p/initiative/actions')
    expect(text()).toContain('后台那项工作已经核对')
    expect(buttons()).toEqual(['重试请求'])
  })

  it('background work still stopping needs no review: only a retry (C2-b)', async () => {
    useApp.setState({ sessions: { s1: slice({}, [failed({ errorCode: 'background_recovery_required', blockingDraining: true })]) } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(text()).toContain('后台工作刚才还在停下')
    expect(buttons()).toEqual(['重试请求'])
  })

  it('keeps both ways when the action is not known here, and opens 临时任务 whatever tab was last open', async () => {
    useUi.setState({ tasksTab: 'schedules' })
    useApp.setState({ sessions: { s1: slice({}, [failed({ errorCode: 'background_recovery_required' })]) } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(buttons()).toEqual(['重试请求', '去核对'])
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '去核对')!.click() })
    expect(useUi.getState()).toMatchObject({ view: 'tasks', tasksProject: 'p', tasksFocus: null, tasksTab: 'adhoc' })
  })
})

describe('SessionNotice: releasing the emergency stop (contract C-h)', () => {
  afterEach(() => { useUi.setState({ toasts: [] }) })
  it('says what the release switched back on, as 设置 and the top bar do (no "resume every session")', async () => {
    useApp.setState({ emergency: true, sessions: { s1: slice({}) } })
    await render(createElement(SessionNotice, { sessionId: 's1' }))
    expect(buttons()).toEqual(['解除急停'])
    await act(async () => { host.querySelector('button')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(posts).toContain('POST /api/emergency')
    expect(useApp.getState().emergency).toBe(false)
    const toasts = useUi.getState().toasts.map(row => row.text)
    expect(toasts).toContain('急停已解除。因急停关闭的主动协作和定时交付已恢复；暂停的会话可按需手动继续。')
    expect(toasts.join('')).not.toContain('各会话仍需手动恢复')
  })
})
