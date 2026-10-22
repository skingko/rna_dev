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

// A trial working rule that background runs keep reading while the user is away gets no feedback that could prove it: when
// they are back the host asks once whether to retire it (usage no_evidence). Retire answers "retire"; "keep" and closing the
// card are refusals the host remembers (it asks again only when the placements have doubled).
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
const card = (id: string): Invitation => ({ id, kind: 'gene', subject: `retire:skill-patch:abc:${id}`, createdAt: '2026-10-22T10:00:00.000Z', projectId: 'p', geneId: 'skill-patch:abc', action: 'retire', title: '安全报告筛选', usage: 'no_evidence', runs: 17, reason: '放进过 17 次，没有一次能判断有没有照做；你已经 20 天没来了。' })

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

describe('a trial rule that cannot get its proof asks whether to retire it', () => {
  it('names the rule and how many times it was used with nothing to judge it by; the host\'s reason is the hover text', async () => {
    await show(card('trial-a'))
    expect(text()).toContain('做法「安全报告筛选」已经用了 17 次，却一次都没能评价它，试用没法往下走。要停用吗？')
    expect(host.querySelector('span[title]')?.getAttribute('title')).toBe('放进过 17 次，没有一次能判断有没有照做；你已经 20 天没来了。')
    expect(answers('trial-a')).toContainEqual({ action: 'shown' })
  })

  it('retire answers "retire" and says so', async () => {
    await show(card('trial-b'))
    await act(async () => { button('停用').click() })
    expect(answers('trial-b')).toContainEqual({ action: 'answer', choice: 'retire' })
    expect(text()).toContain('好，已停用。')
  })

  it('keep answers "keep" (the host remembers it as a refusal, not "never again")', async () => {
    await show(card('trial-c'))
    await act(async () => { button('留着').click() })
    expect(answers('trial-c')).toContainEqual({ action: 'answer', choice: 'keep' })
    expect(text()).toContain('好，留着。')
  })

  it('closing the card is a dismissal', async () => {
    await show(card('trial-d'))
    await act(async () => { (host.querySelector('button[aria-label="关闭"]') as HTMLButtonElement).click() })
    expect(answers('trial-d')).toContainEqual({ action: 'dismiss' })
  })

  it('reads in English too', async () => {
    usePreferences.setState({ language: 'en' })
    await show(card('trial-e'))
    expect(text()).toContain('The working rule “安全报告筛选” has been used 17 times without anything that could judge it, so its trial cannot move on. Retire it?')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['Retire', 'Keep']))
  })

  it('the other retire reasons keep their own sentences', async () => {
    await show({ ...card('trial-f'), usage: 'never_followed' })
    expect(text()).toContain('做法「安全报告筛选」已有 17 次用得上，却一次都没照做过。要停用吗？')
  })
})
