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
import { lessonGroups, lessonState, mindCounts } from '@/lib/mind'
import type { Lesson } from '@/api/mind-api'
import { NudgeStrip } from './NudgeStrip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// P2 B5 review: a rule Rna concluded on its own that would replace one the user set is held until the user answers.
// Its card names both rules and asks which one to keep; the buttons say what each choice does.
const at = '2026-10-05T10:00:00.000Z'
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
const conflict = (patch: Partial<Invitation> = {}): Invitation => ({ id: 'l1', kind: 'lesson', subject: 'lesson:l1', createdAt: at, lessonId: 'l1', text: '章节字数不要少于 4000 字', lessonKind: 'constraint', reason: 'conflicts_user_lesson', conflictText: '章节字数控制在 3000 字以内', ...patch })

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
const buttons = () => [...host.querySelectorAll('button')].map(b => b.textContent)

describe('a held lesson asks which rule to keep', () => {
  it('names the user\'s rule, and the buttons switch to the new one or keep the user\'s', async () => {
    await show(conflict())
    expect(text()).toContain('我得出了一条新经验“章节字数不要少于 4000 字”，和你定的“章节字数控制在 3000 字以内”冲突。换成新的吗？')
    expect(buttons()).toEqual(expect.arrayContaining(['换成新的', '保留原来的', '改一下…']))
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === '换成新的')!.click() })
    expect(posts.filter(row => row.path === 'POST /api/v2/sessions/s1/invitations/l1').map(row => row.body)).toContainEqual({ action: 'answer', choice: 'confirm' })
    expect(text()).toContain('好，换成新的了。')
  })

  it('reads in English too, and without the rule\'s text says a rule you set', async () => {
    usePreferences.setState({ language: 'en' })
    await show(conflict({ id: 'l1-en', subject: 'lesson:l1-en' }))
    expect(text()).toContain('I concluded a new lesson, "章节字数不要少于 4000 字", which conflicts with your rule "章节字数控制在 3000 字以内". Switch to the new one?')
    expect(buttons()).toEqual(expect.arrayContaining(['Switch', 'Keep mine']))
    usePreferences.setState({ language: 'zh' })
    await show(conflict({ id: 'l2', subject: 'lesson:l2', conflictText: undefined }))
    expect(text()).toContain('和你之前定的一条规则冲突。换成新的吗？')
  })

  it('an ordinary lesson card is unchanged, and the never-applied one now follows the interface language', async () => {
    await show(conflict({ id: 'l3', subject: 'lesson:l3', reason: undefined, conflictText: undefined, text: '先给结论', lessonKind: 'preference' }))
    expect(text()).toContain('我记下了一条偏好：“先给结论”，以后照这样做吗？')
    expect(buttons()).toEqual(expect.arrayContaining(['对', '不再适用']))
    usePreferences.setState({ language: 'en' })
    await show(conflict({ id: 'l4', subject: 'lesson:l4', reason: 'never_applied', conflictText: undefined, text: '先给结论' }))
    expect(text()).toContain('The lesson "先给结论" has come up several times and was never followed. Keep it?')
  })
})

describe('held lessons in the mind views', () => {
  const lesson = (id: string, patch: Partial<Lesson> = {}): Lesson => ({ id, kind: 'constraint', text: id, status: 'active', createdAt: at, ...patch })
  it('a held lesson is not counted or listed as a rule in use', () => {
    const lessons = [lesson('mine'), lesson('held', { status: 'held', needsConfirmation: true, confirmReason: 'conflicts_user_lesson', conflictsWith: ['mine'] })]
    expect(lessonState(lessons[1])).toBe('held')
    expect(lessonGroups(lessons).flatMap(group => group.lessons.map(row => row.id))).toEqual(['mine'])
    expect(mindCounts({ lessons, agenda: [], commitments: [] }).lessons).toBe(1)
  })
})
