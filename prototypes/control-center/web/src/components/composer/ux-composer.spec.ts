/**
 * UX audit 2026-10-03, composer: one-shot suggestion fill (F1), the sent first
 * message never comes back as a draft (F2), files picked in a new conversation
 * survive its creation and a failed upload (F7/F23), taken-back messages land
 * in the composer with their files and carried tasks (F30), the queue shows a
 * subagent result by its notice, a command whose answer never came can be
 * checked (F26), and the meters under it (F49/F50).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { api, getTransport, setTransport } from '@/api/client'
import { ApiError, type EventSourceLike, type Transport } from '@/api/transport'
import type { CacheUsage, InboxEntry, Item, SessionMeta } from '@/api/types'
import { useApp } from '@/store/app-store'
import { createSlice } from '@/store/session-model'
import { fillComposer, useUi } from '@/store/ui-store'
import { selectSession } from '@/store/sync'
import { Composer } from './Composer'
import { CommandDialog } from './CommandDialog'
import { ComposerMeters, cacheMeter, contextMeter, latestUsageReply } from './ComposerMeters'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { CSS?: unknown }).CSS ??= { supports: () => true }

class FakeSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  addEventListener() {}
  close() { this.readyState = 2 }
}

const at = '2026-10-03T10:00:00.000Z'
let requests: { path: string; body?: unknown }[] = []
let root: Root, host: HTMLDivElement, previous: Transport

function fakeTransport(): Transport {
  return {
    kind: 'mock',
    async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      requests.push({ path, body: init?.body })
      if (path === '/api/sessions' && init?.method === 'POST') return { id: 's-new', title: '新会话', status: 'idle', projectId: 'p1', items: [], turns: [], createdAt: at } as T
      if (path.endsWith('/messages')) return {} as T
      if (path.startsWith('/api/v2/usage/cache')) return null as T
      if (path.startsWith('/api/v2/sessions/')) return new Promise<T>(() => {}) // snapshot never needed here
      return {} as T
    },
    openStream() { return new FakeSource() },
  }
}

const textarea = () => host.querySelector('textarea')!
const flushAll = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function mount(variant: 'hero' | 'dock' = 'hero', strict = false) {
  const tree = createElement(Tooltip.Provider, null, createElement(Composer, { variant }))
  await act(async () => { root.render(strict ? createElement(StrictMode, null, tree) : tree) })
  await flushAll()
}
async function openSession(id: string, fields: Partial<SessionMeta> & { inbox?: InboxEntry[] } = {}) {
  useApp.setState(s => ({ sessionIndex: { ...s.sessionIndex, [id]: { id, title: 't', status: 'idle', projectId: 'p1' } } }))
  await act(async () => { await selectSession(id) })
  if (Object.keys(fields).length) useApp.setState(s => ({ sessions: { ...s.sessions, [id]: createSlice({ id, title: 't', status: 'idle', projectId: 'p1', items: [], turns: [], ...fields }) } }))
}
const sentTo = (id: string) => requests.filter(r => r.path === `/api/sessions/${id}/messages`).map(r => r.body as Record<string, unknown>)
async function type(value: string) {
  await act(async () => {
    const el = textarea()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function pressEnter() {
  await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flushAll()
}
async function pickFile(file: File) {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

beforeEach(async () => {
  previous = getTransport(); setTransport(fakeTransport()); requests = []
  localStorage.clear()
  await selectSession(null)
  useApp.setState({
    mode: 'v2', sessions: {}, sessionIndex: {}, selectedSessionId: null, selectedProjectId: 'p1', maintenanceHeld: false,
    projects: { p1: { id: 'p1', name: 'P', permissions: { workspace: 'write' } } }, projectOrder: ['p1'],
  })
  useUi.setState({ prefill: null, editing: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); setTransport(previous); vi.restoreAllMocks()
})

describe('composer fills and drafts', () => {
  it('takes a suggestion once: a composer mounted afterwards does not put it back (F1)', async () => {
    await mount('hero')
    await act(async () => { useUi.setState({ prefill: { text: '接着改 HUD 层级', at: 1 } }) })
    expect(textarea().value).toBe('接着改 HUD 层级')
    expect(useUi.getState().prefill).toBeNull()
    // The hero is swapped for the dock composer once the conversation has a row.
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount('dock')
    expect(textarea().value).toBe('')
  })

  it('does not keep the first message of a new conversation as the next new conversation\'s draft (F2)', async () => {
    await mount('hero')
    await type('帮我看看X')
    await act(async () => { await new Promise(r => setTimeout(r, 300)) }) // the debounced draft save ran
    expect(localStorage.getItem('rna.draft.new:p1')).toBe('帮我看看X')
    await pressEnter()
    expect(requests.some(r => r.path === '/api/sessions/s-new/messages')).toBe(true)
    expect(localStorage.getItem('rna.draft.new:p1')).toBeNull()
  })

  it('keeps a file picked in a new conversation when its upload fails after the conversation is created (F7, F23)', async () => {
    vi.spyOn(api, 'uploadAttachment').mockRejectedValue(new Error('附件超过 64MB'))
    await mount('hero')
    await pickFile(new File(['x'], 'scene.glb'))
    await type('看看这个模型')
    await pressEnter()
    expect(useApp.getState().selectedSessionId).toBe('s-new')
    expect(requests.some(r => r.path.endsWith('/messages'))).toBe(false)
    expect(textarea().value).toBe('看看这个模型')
    expect(host.textContent).toContain('scene.glb')
    expect(host.textContent).toContain('上传失败')
    // Sending stays blocked until the file is retried or removed.
    expect((host.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the uploaded file with the first message of a new conversation (F7)', async () => {
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ id: 'a1', name: 'notes.md', type: 'text/markdown', size: 1 })
    await mount('hero')
    await pickFile(new File(['x'], 'notes.md'))
    await type('读一下')
    await pressEnter()
    const sent = requests.find(r => r.path === '/api/sessions/s-new/messages')
    expect((sent?.body as { attachments: { id: string }[] }).attachments.map(a => a.id)).toEqual(['a1'])
  })

  it('puts messages taken back on stop after the typed text, files included (F30)', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: 't', status: 'idle', projectId: 'p1' } } })
    await selectSession('s1')
    await mount('dock')
    await type('先写的')
    await act(async () => { fillComposer('队列里的补充', { append: true, sessionId: 's1', attachments: [{ id: 'a9', name: 'log.txt', type: 'text/plain', size: 3 }] }) })
    expect(textarea().value).toBe('先写的\n\n队列里的补充')
    expect(host.textContent).toContain('log.txt')
    // Meant for another conversation: it waits in that conversation's stored draft.
    localStorage.setItem('rna.draft.s2', '旧草稿')
    await act(async () => { fillComposer('别处的补充', { append: true, sessionId: 's2' }) })
    expect(textarea().value).toBe('先写的\n\n队列里的补充')
    expect(localStorage.getItem('rna.draft.s2')).toBe('旧草稿\n\n别处的补充')
  })

  it('takes a fill that was waiting when the composer mounts, under StrictMode as well (F30)', async () => {
    await openSession('s1')
    localStorage.setItem('rna.draft.s1', '先写的')
    fillComposer('队列里的补充', { append: true, sessionId: 's1', attachments: [{ id: 'a9', name: 'log.txt', type: 'text/plain', size: 3 }] })
    await mount('dock', true)
    expect(textarea().value).toBe('先写的\n\n队列里的补充')
    expect(host.textContent).toContain('log.txt')
    expect(useUi.getState().prefill).toBeNull()
  })

  it('keeps the files of a message taken back for a conversation that is not showing, until it is opened (F30)', async () => {
    await openSession('s1')
    await mount('dock')
    await act(async () => { fillComposer('', { append: true, sessionId: 's2', attachments: [{ id: 'a7', name: 'shot.png', type: 'image/png', size: 9 }] }) })
    expect(host.textContent).not.toContain('shot.png')
    await openSession('s2')
    await flushAll()
    expect(host.textContent).toContain('shot.png')
    // Ready to send as it was: a message with only the file.
    await pressEnter()
    expect(sentTo('s2')).toMatchObject([{ text: '', attachments: [{ id: 'a7' }] }])
  })

  it('brings a 接着完成 back with the task it carries and sends it again as it was (F30)', async () => {
    await openSession('s1')
    await mount('dock')
    await act(async () => { fillComposer('', { append: true, sessionId: 's1', tasks: [{ text: '接着完成：整理第三章', continues: { actionId: 'act-1' } }] }) })
    // Not plain text in the draft: its own chip, which keeps the task with it.
    expect(textarea().value).toBe('')
    expect(host.textContent).toContain('接着完成：整理第三章')
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    expect(JSON.parse(localStorage.getItem('rna.draft.s1.carry') ?? '{}').tasks).toEqual([{ text: '接着完成：整理第三章', continues: { actionId: 'act-1' } }])
    await type('先把标题改短')
    await pressEnter()
    // What was typed goes first; the carried message follows with its task, queued behind (never joining a turn).
    const sent = sentTo('s1')
    expect(sent).toMatchObject([{ text: '先把标题改短', delivery: 'send' }, { text: '接着完成：整理第三章', delivery: 'followup', continues: { actionId: 'act-1' } }])
    expect(sent[0]).not.toHaveProperty('continues')
    await act(async () => { await new Promise(r => setTimeout(r, 600)) }) // the chip row fades out
    expect(host.textContent).not.toContain('接着完成：整理第三章')
    expect(localStorage.getItem('rna.draft.s1.carry')).toBeNull()
  })

  it('sends a carried 接着完成 to the conversation it was sent from, also when the user switches away meanwhile', async () => {
    let release!: () => void
    const base = fakeTransport()
    setTransport({ ...base, request: <T,>(path: string, init?: Parameters<Transport['request']>[1]) => {
      if (path === '/api/sessions/s1/messages' && !requests.some(r => r.path === path)) {
        requests.push({ path, body: init?.body })
        return new Promise<T>(resolve => { release = () => resolve({} as T) })
      }
      return base.request<T>(path, init)
    } })
    await openSession('s1')
    await mount('dock')
    await act(async () => { fillComposer('', { append: true, sessionId: 's1', tasks: [{ text: '接着完成：整理第三章', continues: { actionId: 'act-1' } }] }) })
    await type('先把标题改短')
    await pressEnter()
    // The typed message is still on its way when another conversation is opened.
    await openSession('s2')
    await flushAll()
    await act(async () => { release() })
    await flushAll()
    expect(sentTo('s1')).toMatchObject([{ text: '先把标题改短' }, { text: '接着完成：整理第三章', delivery: 'followup', continues: { actionId: 'act-1' } }])
    expect(sentTo('s2')).toEqual([])
    await vi.waitFor(() => expect(host.textContent).not.toContain('接着完成：整理第三章'))
  })

  it('sends a carried 接着完成 alone when nothing is typed', async () => {
    await openSession('s1')
    await mount('dock')
    await act(async () => { fillComposer('', { append: true, sessionId: 's1', tasks: [{ text: '接着完成：整理第三章', continues: { actionId: 'act-1' } }] }) })
    expect((host.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement).disabled).toBe(false)
    await pressEnter()
    expect(sentTo('s1')).toMatchObject([{ text: '接着完成：整理第三章', delivery: 'send', continues: { actionId: 'act-1' } }])
  })
})

describe('queue above the composer', () => {
  it('shows a queued subagent result by its notice and offers no 取回编辑 for it', async () => {
    await openSession('s1', { status: 'running', inbox: [
      { id: 'q1', text: '[宿主通知 · 子代理完成] agentId=ag1 角色=项目侦察（scout） 状态=completed\n任务：找入口', delivery: 'steer', source: 'subagent', agentId: 'ag1', notice: '子代理完成：项目侦察 · 找到入口' },
      { id: 'q2', text: '顺便改标题', delivery: 'followup' },
    ] })
    await mount('dock')
    expect(host.textContent).toContain('子代理完成：项目侦察 · 找到入口')
    expect(host.textContent).not.toContain('宿主通知')
    expect(host.textContent).toContain('顺便改标题')
    expect([...host.querySelectorAll('button')].filter(b => b.textContent?.includes('取回编辑'))).toHaveLength(1)
  })
})

describe('command dialog (F26)', () => {
  async function failWith(error: Error) {
    const execute = vi.fn().mockRejectedValue(error)
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(CommandDialog, { command: 'compact', sessionId: 's1', contextLabel: 'P · t', onClose: () => {}, execute }))) })
    const start = [...document.body.querySelectorAll('button')].find(b => b.textContent === '开始压缩')!
    await act(async () => { start.click() })
    await flushAll()
    return [...document.body.querySelectorAll('button')].map(b => b.textContent)
  }

  it('offers to check the same request when the connection dropped (status 0)', async () => {
    const buttons = await failWith(new ApiError('无法连接本地服务，请稍后重试。', 0, 'network_unreachable'))
    expect(buttons).toContain('核对同一请求')
  })

  it('offers only a new request when the daemon answered with a failure', async () => {
    const buttons = await failWith(new ApiError('当前轮次尚未结束', 409))
    expect(buttons).toContain('重新执行')
    expect(buttons).not.toContain('核对同一请求')
  })
})

describe('composer meters', () => {
  const meta = (fields: Partial<SessionMeta>): SessionMeta => ({ id: 's', title: 't', status: 'idle', ...fields })

  it('measures context against the conversation\'s own model, an estimate only when the host says so (F49 / C2-a)', () => {
    const before = contextMeter(meta({ modelConfig: { contextWindow: 1_000_000 }, context: { tokens: 578_867, capacity: 1_000_000, usage: { estimatedInputTokens: 578_867, capacity: 1_000_000 } } }))
    expect(before.estimated).toBe(false)
    expect(before.ratio).toBeCloseTo(0.579, 3)
    // After a model change the host rescales the figure to the new model and marks it.
    const after = contextMeter(meta({ modelConfig: { contextWindow: 272_000 }, context: { tokens: 578_867, capacity: 272_000, usage: { estimatedInputTokens: 578_867, capacity: 272_000, estimated: true } } }))
    expect(after.capacity).toBe(272_000)
    expect(after.estimated).toBe(true)
    expect(after.ratio).toBeGreaterThan(2)
    // Windows that differ are no estimate by themselves (e.g. a turn auto-routed to a faster model): the host's capacity stands.
    expect(contextMeter(meta({ modelConfig: { contextWindow: 272_000 }, context: { usage: { estimatedInputTokens: 10_000, capacity: 1_000_000 } } }))).toMatchObject({ capacity: 1_000_000, estimated: false })
    // No capacity measured yet: the window of the conversation's model.
    expect(contextMeter(meta({ modelConfig: { contextWindow: 200_000 }, context: { usage: { estimatedInputTokens: 50_000 } } }))).toMatchObject({ capacity: 200_000, ratio: 0.25, estimated: false })
    // No model config (older sessions): the measured figures as before.
    expect(contextMeter(meta({ context: { usage: { estimatedInputTokens: 10, capacity: 100 } } })).ratio).toBe(0.1)
  })

  it('words an estimate so it also holds after a turn auto-routed to a faster model, where the user changed nothing (C2-a)', async () => {
    useApp.setState(s => ({ selectedSessionId: 's1', sessions: { ...s.sessions, s1: createSlice({ id: 's1', title: 't', status: 'idle', projectId: 'p1', items: [], turns: [], modelConfig: { contextWindow: 400_000 }, context: { tokens: 50_000, capacity: 400_000, usage: { estimatedInputTokens: 50_000, capacity: 400_000, estimated: true } } }) } }))
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(ComposerMeters))) })
    const ring = [...host.querySelectorAll('span')].find(span => span.textContent?.startsWith('上下文'))!
    await act(async () => { ring.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    expect(document.body.textContent).toContain('按本会话模型的容量估算，下次请求后更新')
    expect(document.body.textContent).not.toContain('换模型')
  })

  it('shows this conversation\'s fresh reply even when the window figures were read while idle (F50)', () => {
    const now = Date.parse(at)
    const reply = (createdAt: string): Item => ({ id: 'a', kind: 'assistant', text: '', createdAt, usage: { input: 20, cacheRead: 80, cacheWrite: 0 } })
    const idleCache: CacheUsage = { window: '24h', overall: { requests: 0, hitRate: null, coverage: null, coldStarts: 0 } as CacheUsage['overall'] }
    expect(cacheMeter(reply(at), idleCache, now)).toMatchObject({ hit: 0.8, idle: false, windowed: false })
    expect(cacheMeter(reply('2026-09-30T10:00:00.000Z'), idleCache, now)).toMatchObject({ hit: null, idle: true })
    expect(cacheMeter(null, idleCache, now)).toMatchObject({ hit: null, idle: true })
  })

  it('finds the latest reply with reported usage, skipping initiative messages', () => {
    const items: Record<string, Item> = {
      a1: { id: 'a1', kind: 'assistant', text: '', createdAt: at, usage: { input: 1, cacheRead: 1 } },
      a2: { id: 'a2', kind: 'assistant', text: '', createdAt: at, source: 'initiative', usage: { input: 1, cacheRead: 0 } },
      a3: { id: 'a3', kind: 'assistant', text: '', createdAt: at, streaming: true },
    }
    expect(latestUsageReply({ items, order: ['a1', 'a2', 'a3'] })?.id).toBe('a1')
  })
})
