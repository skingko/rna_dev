import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import type { Invitation, SessionMeta } from '@/api/types'
import { useApp } from '@/store/app-store'
import type { SessionSlice } from '@/store/session-model'
import { useUi } from '@/store/ui-store'
import { usePreferences } from '@/components/settings/preferences'
import { NudgeStrip } from './NudgeStrip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A schedule is the user's own instruction: when its last results went unread while they were away, the host asks once
// (schedule_pause). Only "pause" changes anything; "keep" is remembered by the host as a refusal.
const posts: { path: string; body: unknown }[] = []
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    posts.push({ path: `${init.method ?? 'GET'} ${path}`, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}
const slice = (invitations: Invitation[]): SessionSlice => ({
  meta: { id: 's1', title: 't', status: 'idle', projectId: 'p', invitations } as SessionMeta,
  items: {}, order: [], turns: {}, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false,
})
const card = (id: string): Invitation => ({ id, kind: 'schedule_pause', subject: `schedule_pause:s:${id}`, createdAt: '2026-10-22T10:00:00.000Z', projectId: 'p', scheduleId: 's', title: '每日调研', count: 5, since: '2026-10-18T01:12:00.000Z' })

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setTransport(transport); posts.length = 0
  useApp.setState({ emergency: false, maintenanceHeld: false, sessions: {}, projects: { p: { id: 'p', name: 'P' } } })
  useUi.setState({ invitationFocus: null, view: 'chat', tasksFocus: null, tasksProject: 'all' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); usePreferences.setState({ language: 'zh' }) })

const show = async (invitation: Invitation) => {
  useApp.setState({ sessions: { s1: slice([invitation]) } })
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(NudgeStrip, { sessionId: 's1', typing: false }))) })
}
const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!
const answers = (id: string) => posts.filter(row => row.path === `POST /api/v2/sessions/s1/invitations/${id}`).map(row => row.body)

describe('a schedule whose results nobody opened asks whether to pause it', () => {
  it('names the schedule and how many results went unread; pause answers "pause" and says so', async () => {
    await show(card('pause-a'))
    expect(text()).toContain('日程“每日调研”最近 5 次的结果都没人看，要暂停吗？')
    expect(answers('pause-a')).toContainEqual({ action: 'shown' })
    await act(async () => { button('暂停').click() })
    expect(answers('pause-a')).toContainEqual({ action: 'answer', choice: 'pause' })
    expect(text()).toContain('好，已暂停。')
  })

  it('"keep running" answers keep', async () => {
    await show(card('pause-b'))
    await act(async () => { button('继续运行').click() })
    expect(answers('pause-b')).toContainEqual({ action: 'answer', choice: 'keep' })
    expect(text()).toContain('好，留着。')
  })

  it('closing the card is a dismissal, which the host keeps as a refusal', async () => {
    await show(card('pause-c'))
    await act(async () => { (host.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).click() })
    expect(answers('pause-c')).toContainEqual({ action: 'dismiss' })
  })

  it('reads in English too', async () => {
    usePreferences.setState({ language: 'en' })
    await show(card('pause-d'))
    expect(text()).toContain('Nobody has opened the last 5 results of the schedule “每日调研”. Pause it?')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['Pause', 'Keep running']))
    await act(async () => { button('Pause').click() })
    expect(text()).toContain('OK, paused.')
  })
})
