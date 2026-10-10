/**
 * In-memory mock daemon speaking the v2 contract. Enabled with ?mock=1 (or
 * VITE_MOCK=1). A scripted turn streams thinking, grouped reads, a search, an
 * edit with diff, a live command, a web search and a final answer.
 *
 * Query options: scenario=streaming (auto-send on load), scenario=question,
 * scenario=empty, speed=<multiplier>.
 */
import { ApiError, type EventSourceLike, type RequestInit, type Transport } from '@/api/transport'
import { WEB_PROTOCOL, type CacheUsage, type Item, type Session, type SessionSummary, type ToolCall, type Turn } from '@/api/types'
import { BUILD_OUTPUT, LIVE, agentBackgroundChangeDetail, backgroundChangeDetail, configuration, initialSessions, projects } from './fixtures'
import { partialJsonFields, TARGET_FIELDS } from '@/lib/partial-json'
import { NOT_HANDLED, handlePanels, mockEmergency, mockSettings } from './panels'
import { ProjectStore } from './project-routes'
import { P34Store } from './p34-routes'
import { mockGeneDetail, mockGeneTree } from './gene-fixtures'
import { H4Store } from './h4-routes'
import { MindStore } from './mind-routes'
import { narratorItems, pro2Deliverables, threadOpener } from './mind-fixtures'
import { TerminalStore } from './terminal-routes'
import { GitMockStore } from './git-routes'
import { WorktreeMockStore } from './worktree-routes'
import { mockAgentsSummary, researchAgents, startMockWorkSteps } from './background-fixtures'

type Listener = (ev: MessageEvent) => void

/** 浏览器 · Rna in the mock: the agent clicking through a page (an SVG stands in for the JPEG frames). */
class MockBrowserViewSource implements EventSourceLike {
  readyState = 1
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private listeners = new Map<string, Set<Listener>>()
  private timer: ReturnType<typeof setInterval>
  private step = 0
  constructor() {
    const steps = [
      { action: { name: 'mcp__playwright-browser__browser_navigate', detail: 'http://127.0.0.1:5173/' }, fill: '#dbeafe', text: '赛道选择' },
      { action: { name: 'mcp__playwright-browser__browser_click', detail: '进阶挑战 tab' }, fill: '#fde68a', text: '进阶挑战' },
      { action: { name: 'mcp__playwright-browser__browser_wait_for', detail: '2 秒' }, fill: '#bbf7d0', text: '星陨荒原 · 准备开始' },
      { action: null, fill: '#bbf7d0', text: '星陨荒原 · 准备开始' },
    ]
    const emit = () => {
      const current = steps[this.step % steps.length]; this.step++
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="${current.fill}"/><text x="640" y="400" font-size="64" text-anchor="middle" font-family="sans-serif">${current.text}</text></svg>`
      this.dispatch('state', { live: true, attached: true, url: 'http://127.0.0.1:5173/', title: 'Kart Racer', action: current.action })
      this.dispatch('frame', { data: btoa(unescape(encodeURIComponent(svg))), mime: 'image/svg+xml', width: 1280, height: 800, url: 'http://127.0.0.1:5173/', at: Date.now() })
    }
    setTimeout(emit, 50)
    this.timer = setInterval(emit, 1600)
  }
  private dispatch(type: string, data: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) })) }
  addEventListener(type: string, listener: Listener) { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener) }
  close() { this.readyState = 2; clearInterval(this.timer) }
}

class MockEventSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private listeners = new Map<string, Set<Listener>>()
  readonly sessionId: string | null
  private seq = 0
  constructor(private server: MockServer, path: string) {
    const url = new URL(path, 'http://mock')
    this.sessionId = url.searchParams.get('session')
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      this.emit('hello', { protocol: WEB_PROTOCOL, revision: this.sessionId ? server.session(this.sessionId)?.revision ?? 0 : server.revision, seq: 0 })
    }, 30)
    server.streams.add(this)
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  close() {
    this.readyState = 2
    this.server.streams.delete(this)
  }
  emit(type: string, data: unknown) {
    if (this.readyState !== 1) return
    const ev = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(++this.seq) })
    for (const listener of this.listeners.get(type) ?? []) listener(ev)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const clone = <T,>(v: T): T => structuredClone(v)

export class MockServer implements Transport {
  readonly kind = 'mock' as const
  revision = 100
  streams = new Set<MockEventSource>()
  private sessions: Session[] = initialSessions()
  private aborts = new Map<string, { aborted: boolean }>()
  private speed: number

  private freezeAt: number | null = null
  private agents = new Map<string, { session: Session; item: Item; flag: { cancelled: boolean } }>()
  emergency = false
  readonly projectStore = new ProjectStore({
    session: id => this.session(id),
    broadcastProject: summary => { this.revision++; for (const stream of this.streams) stream.emit('index', { revision: this.revision, projects: [summary] }) },
    setEmergency: stop => { this.emergency = stop; this.revision++; for (const stream of this.streams) stream.emit('index', { revision: this.revision, emergency: stop }) },
  })

  readonly p34 = new P34Store({
    detail: id => this.projectStore.details.get(id),
    touch: id => this.projectStore.touch(id),
    emitAll: (type, data) => { for (const stream of this.streams) stream.emit(type, data) },
  })

  readonly h4 = new H4Store({
    detail: id => this.projectStore.details.get(id),
    sessions: () => this.sessions,
    touch: id => this.projectStore.touch(id),
  })

  readonly mind = new MindStore({
    detail: id => this.projectStore.details.get(id),
    touch: id => this.projectStore.touch(id),
    emitAll: (type, data) => { for (const stream of this.streams) if (!stream.sessionId) stream.emit(type, data) },
    item: (sessionId, itemId) => {
      const s = this.session(sessionId)
      const item = s?.items.find(i => i.id === itemId)
      return s && item ? { item: clone(item), commit: next => this.upsert(s, [next]) } : null
    },
  })

  /** S2: fake PTY terminals (`/api/v2/projects/:id/terminals`, `/api/v2/terminals/:tid/…`). */
  readonly terminals = new TerminalStore(id => projects.find(p => p.id === id)?.workspacePath)
  /** 工作区改动: git status, diffs, stage / unstage / discard (`/api/v2/projects/:id/git…`). */
  readonly git = new GitMockStore()
  /** 0.63 isolation: worktrees, apply records, rollback, a worker's merge, git init (`?isolation=on` opens the release gate). */
  readonly isolation = new WorktreeMockStore({
    projects: () => projects,
    session: id => this.session(id),
    upsertAgent: (sessionId, agentId, patch) => {
      const s = this.session(sessionId)
      const item = s?.items.find(i => i.subagent?.agentId === agentId)
      if (!s || !item?.subagent) return null
      item.subagent = { ...item.subagent, ...patch }
      this.upsert(s, [clone(item)])
      return clone(item.subagent)
    },
    gitInit: id => this.git.init(id),
    isRepository: id => this.git.isRepository(id),
    touchProject: id => { if (this.projectStore.has(id)) this.projectStore.touch(id) },
    sessionOfTurn: turnId => this.sessions.find(s => s.turns.some(turn => turn.id === turnId))?.id,
  })
  /** S2 bootstrap capabilities; `?caps=none` simulates a daemon without the side-panel services. */
  private capabilities: { terminal: 'pty' | 'fallback' | false; sideChat: boolean } | null = { terminal: 'pty', sideChat: true }

  constructor() {
    // v2 mind: the earlier message of the “HUD 被芦苇遮挡” thread.
    const ui = this.session('s-ui')
    ui?.items.unshift(clone(threadOpener) as Item)
    // K2 v2 narrator: a share with presented deliverables, a thread close and a structured welcome-back.
    const pro2 = ui?.items.find(i => i.id === 'pro-2')
    if (pro2) pro2.initiative = { ...pro2.initiative, threadId: 'th-hud', deliverables: clone(pro2Deliverables), narrated: { version: 2, outcome: 'send', reasons: ['above_threshold', 'time_sensitive'], via: 'evidence' } }
    ui?.items.push(...(narratorItems() as Item[]))
    // Tasks panel: a running subagent group in 美术技能挑选, and live steps of the running background work.
    const research = this.session('s-research')
    research?.items.splice(Math.max(0, research.items.findIndex(i => i.id === 'q-res-1')), 0, ...researchAgents())
    startMockWorkSteps(event => { for (const stream of this.streams) if (!stream.sessionId) stream.emit('work.step', event) },
      () => (this.projectStore.details.get('p-ink')?.initiativeRuntime as { sdkState?: { actions?: { id: string; status: string }[] } } | undefined)?.sdkState?.actions?.find(a => a.id === 'act-work-1')?.status === 'running')
    const params = new URLSearchParams(location.search)
    this.speed = Number(params.get('speed')) || 1
    // freeze=<ms>: stop the scripted turn that long after load (for screenshots).
    const freeze = Number(params.get('freeze'))
    if (freeze) this.freezeAt = performance.now() + freeze
    if (params.get('caps') === 'none') this.capabilities = null
    // perm=execute: every project at 完全访问 (terminal screenshots).
    const perm = params.get('perm')
    if (perm) for (const project of projects) project.permissions = { ...project.permissions, workspace: perm }
  }

  private async wait(ms: number) {
    await sleep(ms)
    if (this.freezeAt !== null && performance.now() > this.freezeAt) await new Promise(() => {})
  }

  session(id: string) { return this.sessions.find(s => s.id === id) }

  openStream(path: string): EventSourceLike { return /\/browser-view$/.test(path) ? new MockBrowserViewSource() : this.terminals.isStream(path) ? this.terminals.openStream(path) : new MockEventSource(this, path) }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await sleep(40 + Math.random() * 60)
    const method = init.method ?? 'GET'
    const body = (init.body ?? {}) as Record<string, unknown>
    const url = new URL(path, 'http://mock')
    const p = url.pathname
    let m: RegExpMatchArray | null

    // F1 global panels (settings, memory, capabilities, archive, projects).
    const panel = await handlePanels({ sessions: () => this.sessions, emitIndex: payload => this.emitIndex(payload) }, method, url, body)
    if (panel !== NOT_HANDLED) return panel as T

    const isolation = this.isolation.handle(method, url, body)
    if (isolation !== undefined) return isolation as T
    const git = this.git.handle(method, url, body)
    if (git !== undefined) return git as T
    const terminal = this.capabilities?.terminal ? this.terminals.handle(method, url, body) : undefined
    if (terminal !== undefined) return terminal as T
    if (this.capabilities?.sideChat && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/side-chats(\/promote)?$/))) return this.sideChats(method, decodeURIComponent(m[1]), Boolean(m[2]), body) as T
    if (method === 'GET' && p === '/api/v2/bootstrap') {
      return {
        capabilities: this.capabilities,
        protocol: WEB_PROTOCOL, revision: this.revision, emergency: mockEmergency() || this.emergency || null, maintenance: { held: false }, configuration, settings: mockSettings,
        projects: projects.map(p => this.projectStore.summary(p.id)), sessions: this.sessions.map(summary),
      } as T
    }
    if ((m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/agents(?:\/([^/]+)\/(cancel|message))?$/))) {
      const s = this.need(m[1])
      if (method === 'GET' && !m[2]) return { sessionId: s.id, revision: s.revision, agents: s.items.filter(i => i.kind === 'subagent').map(i => clone(i.subagent)) } as T
      const entry = this.agents.get(decodeURIComponent(m[2] ?? ''))
      const item = entry?.item ?? s.items.find(i => i.subagent?.agentId === m![2])
      if (!item?.subagent) throw new ApiError('子任务不存在', 404)
      if (m[3] === 'message') {
        if (item.subagent.status !== 'running') throw new ApiError('子代理已结束', 409)
        item.subagent = { ...item.subagent, messages: (item.subagent.messages ?? 0) + 1 }
        this.upsert(s, [clone(item)])
        return { agentId: item.subagent.agentId, delivered: true, status: 'running' } as T
      }
      if (entry) entry.flag.cancelled = true
      return clone(item.subagent) as T
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/genes$/))) return mockGeneTree(decodeURIComponent(m[1])) as T
    if (method === 'GET' && p === '/api/v2/suggestions') {
      const projectId = url.searchParams.get('projectId')
      return { projectId, source: 'model', refreshing: false, suggestions: projectId ? [
        { kind: 'continue', title: '接着改 HUD 层级', text: '继续把 HUD 分数层级提到芦苇之上（z-index: 30），改完在 390px 宽度下复查。' },
        { kind: 'answer', title: '定低端机方案', text: '关于 Redmi 9 上的穗头透明排序：我倾向于关闭它换帧率，你按这个方案落实。' },
        { kind: 'check', title: '检查未提交改动', text: '检查还没提交的 app.css 和 hud-layering-report.md，有问题就指出来。' },
      ] : [] } as T
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/genes\/([^/]+)$/))) { const found = mockGeneDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2])); if (!found) throw new ApiError('基因不存在', 404); return found as T }
    if (method === 'POST' && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/invitations\/([^/]+)$/))) return { sessionId: decodeURIComponent(m[1]), invitationId: decodeURIComponent(m[2]), ...((body as { action?: string })?.action === 'shown' ? { closed: false, shown: true } : { closed: true, outcome: (body as { action?: string })?.action === 'dismiss' ? 'dismissed' : 'answered' }) } as T
    if (method === 'POST' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/genes\/([^/]+)$/))) return { geneId: decodeURIComponent(m[2]), action: (body as { action?: string })?.action ?? 'confirm' } as T
    if (method === 'GET' && /^\/api\/projects\/[^/]+\/background-changes\/bg-1$/.test(p)) return backgroundChangeDetail as T
    if (method === 'GET' && /^\/api\/projects\/[^/]+\/background-changes\/bg-2$/.test(p)) return agentBackgroundChangeDetail as T
    const mind = this.mind.handle(method, url, body)
    if (mind !== undefined) return mind as T
    const h4 = this.h4.handle(method, url, body)
    if (h4 !== undefined) return h4 as T
    const routed = this.projectStore.handle(method, url, body)
    if (routed !== undefined) return routed as T
    const p34 = this.p34.handle(method, url, body)
    if (p34 !== undefined) { if (method === 'POST' && p === '/api/v2/evolution/system/proposals') this.h4.record(p34 as Record<string, unknown>); return p34 as T }
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)$/))) {
      const s = this.session(decodeURIComponent(m[1]))
      if (!s) throw new ApiError('会话不存在', 404)
      return clone(s) as T
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/items\/([^/]+)$/))) {
      const item = this.session(decodeURIComponent(m[1]))?.items.find(i => i.id === decodeURIComponent(m![2]))
      if (!item) throw new ApiError('条目不存在', 404)
      return clone(item) as T
    }
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/models\/([^/]+)\/([^/]+)\/reasoning$/))) {
      const model = configuration.providers.find(pv => pv.id === decodeURIComponent(m![1]))?.models.find(md => md.id === decodeURIComponent(m![2]))
      if (!model?.reasoningCapability) throw new ApiError('模型不存在', 404)
      return { capability: model.reasoningCapability, auto: { available: model.id !== 'kimi-k3', backend: model.id !== 'kimi-k3' ? 'typesafe' : null } } as T
    }
    if (method === 'GET' && p === '/api/v2/usage/cache') {
      const usage: CacheUsage = {
        window: url.searchParams.get('window') ?? '24h',
        overall: { requests: 128, input: 210_000, cacheRead: 2_380_000, cacheWrite: 41_000, hitRate: 0.901, coverage: 0.87, coldStarts: 5 },
        latest: { purpose: 'foreground', hitRate: 0.89, at: new Date().toISOString() },
      }
      return usage as T
    }
    if (method === 'POST' && p === '/api/sessions') {
      const s: Session = {
        id: `s-${Math.random().toString(36).slice(2, 8)}`, title: '新会话', projectId: (body.projectId as string) ?? null, status: 'idle',
        mode: (body.mode as string) ?? 'build', modelSelection: (body.modelSelection as Session['modelSelection']) ?? configuration.defaultModel,
        modelConfig: { providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000 },
        context: { tokens: 0, capacity: 1_000_000 }, activeTurnId: null, inbox: [], items: [], turns: [], revision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      // 在独立工作树中运行: refused (409 worktree_unavailable) where isolation is off.
      if (body.worktree === true) this.isolation.createSession(s)
      this.sessions.unshift(s)
      this.broadcastIndex(s)
      return clone(s) as T
    }
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
      const s = this.need(m[1])
      const text = String(body.text ?? '')
      if (s.status !== 'idle' && body.delivery !== 'send') {
        const entry = { id: crypto.randomUUID(), text, delivery: body.delivery as string, deliveryStatus: 'queued', createdAt: new Date().toISOString() }
        s.inbox = [...(s.inbox ?? []), entry]
        this.patch(s, { inbox: s.inbox })
        setTimeout(() => { s.inbox = (s.inbox ?? []).filter(e => e.id !== entry.id); this.patch(s, { inbox: s.inbox }) }, 6000 / this.speed)
        return { queued: true } as T
      }
      if (s.kind === 'side') void this.runSideTurn(s, text)
      else void this.runTurn(s, text)
      return { queued: false } as T
    }
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/control$/))) {
      const s = this.need(m[1])
      if (body.action === 'stop') {
        const flag = this.aborts.get(s.id)
        if (flag) flag.aborted = true
      }
      if (body.action === 'resume' && s.status === 'paused') {
        s.status = 'idle'; s.pauseReason = null
        this.patch(s, { status: 'idle', pauseReason: null, runtime: s.runtime ?? null })
        this.broadcastIndex(s)
      }
      return { recovered: [] } as T
    }
    if (method === 'PATCH' && (m = p.match(/^\/api\/sessions\/([^/]+)$/))) {
      const s = this.need(m[1])
      Object.assign(s, body)
      if (body.archived) s.archivedAt = new Date().toISOString()
      if (body.modelSelection) {
        const sel = body.modelSelection as { providerId: string; modelId: string }
        const model = configuration.providers.find(pv => pv.id === sel.providerId)?.models.find(md => md.id === sel.modelId)
        s.modelConfig = { providerId: sel.providerId, modelId: sel.modelId, name: model?.name, contextWindow: model?.contextWindow }
      }
      this.patch(s, body)
      this.broadcastIndex(s)
      return clone(s) as T
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/sessions\/([^/]+)\/inbox\/([^/]+)$/))) {
      const s = this.need(m[1])
      const entry = s.inbox?.find(e => e.id === m![2])
      s.inbox = (s.inbox ?? []).filter(e => e.id !== m![2])
      this.patch(s, { inbox: s.inbox })
      return { recovered: entry ?? { text: '' } } as T
    }
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/interactions\/([^/]+)\/(answer|cancel)$/))) {
      const s = this.need(m[1])
      const item = s.items.find(i => i.interaction?.id === decodeURIComponent(m![2]))
      if (!item?.interaction) throw new ApiError('提问不存在', 404)
      item.interaction = { ...item.interaction, status: m[3] === 'answer' ? 'answered' : 'cancelled', canRespond: false, answers: body.answers as never, answeredAt: new Date().toISOString() }
      this.upsert(s, [item])
      if (m[3] === 'answer') void this.finishQuestionTurn(s)
      return {} as T
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/permissions$/))) {
      const project = projects.find(pr => pr.id === m![1])
      if (method === 'PATCH' && project) project.permissions = { workspace: body.workspace as string, background: body.background as string }
      return { settings: { workspace: project?.permissions?.workspace ?? 'read', background: project?.permissions?.background ?? 'readonly' } } as T
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/presence$/))) return {} as T
    if ((m = p.match(/^\/api\/projects\/([^/]+)$/)) && method === 'PATCH') return {} as T
    throw new ApiError(`mock: 未实现 ${method} ${p}`, 404)
  }

  private need(id: string) {
    const s = this.session(decodeURIComponent(id))
    if (!s) throw new ApiError('会话不存在', 404)
    return s
  }

  /* -------------------------------------------------------- emitters */

  private emit(sessionId: string, type: string, data: unknown) {
    for (const stream of this.streams) if (stream.sessionId === sessionId) stream.emit(type, data)
  }
  emitIndex(payload: { projects?: unknown[]; sessions?: Session[]; removed?: { projects?: string[]; sessions?: string[] } }) {
    this.revision++
    const projectRows = payload.projects?.map(p => this.projectStore.has((p as { id: string }).id) ? this.projectStore.summary((p as { id: string }).id) : p)
    for (const stream of this.streams) if (!stream.sessionId) stream.emit('index', { revision: this.revision, ...payload, ...(projectRows ? { projects: projectRows } : {}), sessions: payload.sessions?.map(summary) })
  }
  private broadcastIndex(s: Session) {
    this.revision++
    for (const stream of this.streams) if (!stream.sessionId) stream.emit('index', { revision: this.revision, sessions: [summary(s)] })
  }
  private upsert(s: Session, items: Item[]) {
    s.revision = (s.revision ?? 0) + 1
    for (const item of items) {
      const i = s.items.findIndex(x => x.id === item.id)
      if (i >= 0) s.items[i] = item
      else s.items.push(item)
    }
    this.emit(s.id, 'items.upsert', { revision: s.revision, sessionId: s.id, items: clone(items) })
  }
  private turns(s: Session, turns: Turn[]) {
    s.revision = (s.revision ?? 0) + 1
    for (const turn of turns) {
      const i = s.turns.findIndex(t => t.id === turn.id)
      if (i >= 0) s.turns[i] = turn
      else s.turns.push(turn)
    }
    this.emit(s.id, 'turns.upsert', { revision: s.revision, sessionId: s.id, turns: clone(turns) })
  }
  private patch(s: Session, fields: Record<string, unknown>) {
    s.revision = (s.revision ?? 0) + 1
    this.emit(s.id, 'session.patch', { revision: s.revision, sessionId: s.id, fields: clone(fields) })
  }
  private phase(s: Session, turnId: string, phase: string) {
    this.emit(s.id, 'turn.phase', { sessionId: s.id, turnId, phase, at: new Date().toISOString() })
  }

  /** Stream text into one block with realistic chunking at ~30 fps. */
  private async stream(s: Session, turnId: string, item: Item, block: 'text' | 'thinking' | 'tool_output' | 'tool_args', text: string, flag: { aborted: boolean }, cps = 90) {
    let offset = 0
    while (offset < text.length && !flag.aborted) {
      const size = Math.max(1, Math.round(cps / 30 * (0.6 + Math.random() * 0.8)))
      const append = text.slice(offset, offset + size)
      this.emit(s.id, 'delta', { sessionId: s.id, turnId, itemId: item.id, block, offset, append })
      offset += append.length
      await this.wait(33 / this.speed)
    }
    // mirror into server state so a resync mid-stream is consistent
    if (block === 'text') item.text = text.slice(0, offset)
    if (block === 'thinking' && item.thinking) item.thinking.text = text.slice(0, offset)
    if (block === 'tool_output' && item.tool) item.tool.output = text.slice(0, offset)
    return offset
  }

  /** Stream a call's arguments as a display-only pending entry (`tool_args` + metadata), as the host does. */
  private async prepareTool(s: Session, turnId: string, flag: { aborted: boolean }, call: ToolCall & { id: string }, cps = 240) {
    const json = JSON.stringify(call.args ?? {})
    const itemId = `pending-tool:mock:${call.id}`
    this.emit(s.id, 'turn.phase', { sessionId: s.id, turnId, phase: 'tool', preparing: true, at: new Date().toISOString() })
    let offset = 0
    while (offset < json.length && !flag.aborted) {
      const size = Math.max(1, Math.round(cps / 30 * (0.6 + Math.random() * 0.8)))
      const append = json.slice(offset, offset + size)
      const fields = partialJsonFields(json.slice(0, offset + append.length), TARGET_FIELDS)
      const target = fields.path ?? fields.command ?? fields.query ?? fields.url
      this.emit(s.id, 'delta', { sessionId: s.id, turnId, itemId, block: 'tool_args', offset, append, tool: { id: call.id, index: 0, name: call.name, ...(call.kind ? { kind: call.kind } : {}), ...(target ? { target: target.split('\n')[0] } : {}), preparing: true } })
      offset += append.length
      await this.wait(33 / this.speed)
    }
  }

  private async tool(s: Session, turnId: string, flag: { aborted: boolean }, call: ToolCall, duration: number, output: string, id = crypto.randomUUID()) {
    if (flag.aborted) return null
    const started = new Date().toISOString()
    const item: Item = { id, turnId, kind: 'tool', text: call.name, createdAt: started, tool: { ...call, status: 'running', startedAt: started, endedAt: null, output: '' } }
    this.phase(s, turnId, 'tool')
    this.upsert(s, [clone(item)])
    await this.wait(duration / this.speed)
    item.tool = { ...item.tool!, status: flag.aborted ? 'cancelled' : 'succeeded', endedAt: new Date().toISOString(), output }
    this.upsert(s, [clone(item)])
    return item
  }

  /* ---------------------------------------------------- scripted turn */

  async runTurn(s: Session, text: string) {
    const flag = { aborted: false }
    this.aborts.set(s.id, flag)
    const turnId = crypto.randomUUID()
    const now = () => new Date().toISOString()
    const user: Item = { id: crypto.randomUUID(), turnId, kind: 'user', text, createdAt: now(), delivery: 'send' }
    const turn: Turn = {
      id: turnId, status: 'running', mode: s.mode, createdAt: now(), startedAt: now(), firstTokenAt: null, completedAt: null, userItemId: user.id,
      modelConfig: { providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3', reasoning: 'medium' },
    }
    s.status = 'running'; s.activeTurnId = turnId
    if (s.title === '新会话') { s.title = text.slice(0, 18); this.patch(s, { title: s.title }) }
    this.patch(s, { status: 'running', activeTurnId: turnId })
    this.broadcastIndex(s)
    this.upsert(s, [user])
    this.turns(s, [turn])
    // E1 turn-start phases, in the order the host sends them.
    for (const [phase, ms] of [['preparing_workspace', 450], ['preparing_memory', 350], ['routing', 300], ['preparing_context', 200], ['connecting', 500]] as const) {
      this.phase(s, turnId, phase)
      // 0.63: a worktree conversation's worktree is made in its first turn's preparing_workspace.
      if (phase === 'preparing_workspace' && this.isolation.activate(s)) { this.patch(s, { worktree: s.worktree }); this.broadcastIndex(s) }
      await this.wait(ms / this.speed)
    }

    // reasoning decision arrives with the first request
    turn.modelConfig = { ...turn.modelConfig, reasoningDecision: { requested: 'auto', effective: 'medium', source: 'jev', rationale: '涉及多文件修改与验证', latencyMs: 380 } }
    turn.firstTokenAt = now()
    turn.timing = { queued: 40, foreground: 0, capabilities: 12, orientation: 1, journal: 430, runtime: 450, preparing: 470, preflight: 30, memory: 350, routing: 300, context: 200, toRequest: 1320, request: 500, firstToken: 1820 }
    this.turns(s, [clone(turn)])

    // 1. thinking
    const a1: Item = { id: crypto.randomUUID(), turnId, kind: 'assistant', text: '', createdAt: now(), startedAt: now(), streaming: true, thinking: { text: '', startedAt: now(), endedAt: null, tokens: null, visibility: 'full' } }
    this.upsert(s, [clone(a1)])
    this.phase(s, turnId, 'thinking')
    await this.stream(s, turnId, a1, 'thinking', LIVE.thinking1, flag, 70)
    a1.thinking = { ...a1.thinking!, text: LIVE.thinking1, endedAt: now(), tokens: 318 }
    a1.streaming = false; a1.endedAt = now()
    this.upsert(s, [clone(a1)])

    // 2. grouped reads + search
    for (const [index, path] of ['src/components/TerminalBlock.tsx', 'src/components/DiffCard.tsx', 'src/lib/ansi.ts', 'src/styles/app.css'].entries()) {
      if (index === 0) { const id = crypto.randomUUID(); await this.prepareTool(s, turnId, flag, { id, name: 'project_read', kind: 'read', args: { path } }, 60); await this.tool(s, turnId, flag, { id, name: 'project_read', kind: 'read', target: path, args: { path } }, 380, `// ${path}\n…`, id); continue }
      await this.tool(s, turnId, flag, { name: 'project_read', kind: 'read', target: path, args: { path } }, 380, `// ${path}\n…`)
    }
    await this.tool(s, turnId, flag, { name: 'project_exec', kind: 'search', target: 'diffStat', args: { command: 'rg -n diffStat src' } }, 520, 'Exit code: 0\n\nsrc/components/DiffCard.tsx:14:  const stat = diffStat(before, after)\nsrc/lib/diff.ts:3:export function diffStat(a, b) {')
    if (flag.aborted) return this.endTurn(s, turn, 'cancelled')

    // 3. interim message (hidden-visibility reasoning)
    const a2: Item = { id: crypto.randomUUID(), turnId, kind: 'assistant', text: '', createdAt: now(), startedAt: now(), streaming: true, thinking: { text: '', startedAt: now(), endedAt: null, tokens: null, visibility: 'hidden' } }
    this.upsert(s, [clone(a2)])
    this.phase(s, turnId, 'thinking')
    await this.wait(1400 / this.speed)
    a2.thinking = { ...a2.thinking!, endedAt: now(), tokens: 142 }
    this.upsert(s, [clone(a2)])
    this.phase(s, turnId, 'writing')
    await this.stream(s, turnId, a2, 'text', LIVE.interim, flag, 110)
    a2.text = LIVE.interim; a2.streaming = false; a2.endedAt = now()
    this.upsert(s, [clone(a2)])

    // 4. edit with streaming args
    const editId = crypto.randomUUID()
    const editArgs = { path: 'src/lib/terminal.ts', oldText: LIVE.diffOld, newText: LIVE.diffNew }
    // Arguments stream first as a pending "准备编辑 terminal.ts…" row.
    await this.prepareTool(s, turnId, flag, { id: editId, name: 'project_edit', kind: 'edit', args: editArgs }, 900)
    await this.tool(s, turnId, flag, { id: editId, name: 'project_edit', kind: 'edit', target: 'src/lib/terminal.ts', args: editArgs }, 500, 'Edited src/lib/terminal.ts', editId)

    // 4b. background reviewer subagent (E2): runs on while the turn continues
    if (!flag.aborted) void this.subagent(s, turnId)

    // 5. command with live output
    if (!flag.aborted) {
      const callId = crypto.randomUUID()
      await this.prepareTool(s, turnId, flag, { id: callId, name: 'project_exec', kind: 'command', args: { command: 'npm run build' } }, 45)
      const started = now()
      const cmd: Item = { id: callId, turnId, kind: 'tool', text: 'project_exec', createdAt: started, tool: { id: callId, name: 'project_exec', kind: 'command', target: 'npm run build', args: { command: 'npm run build' }, status: 'running', startedAt: started, endedAt: null, output: '' } }
      this.phase(s, turnId, 'tool')
      this.upsert(s, [clone(cmd)])
      let offset = 0
      for (const line of BUILD_OUTPUT) {
        if (flag.aborted) break
        const append = `${line}\n`
        this.emit(s.id, 'delta', { sessionId: s.id, turnId, itemId: cmd.id, block: 'tool_output', offset, append })
        offset += append.length
        await this.wait((120 + Math.random() * 220) / this.speed)
      }
      cmd.tool = { ...cmd.tool!, status: flag.aborted ? 'cancelled' : 'succeeded', endedAt: now(), output: `Exit code: 0\n\n${BUILD_OUTPUT.join('\n')}` }
      this.upsert(s, [clone(cmd)])
    }
    await this.tool(s, turnId, flag, { name: 'web_search', kind: 'web_search', target: 'ANSI terminal rendering head tail cap', args: { query: 'ANSI terminal rendering head tail cap' } }, 900, '4 results')
    if (flag.aborted) return this.endTurn(s, turn, 'cancelled')

    // 6. final answer
    const a3: Item = { id: crypto.randomUUID(), turnId, kind: 'assistant', text: '', createdAt: now(), startedAt: now(), streaming: true, thinking: { text: '', startedAt: now(), endedAt: null, visibility: 'full' } }
    this.upsert(s, [clone(a3)])
    this.phase(s, turnId, 'thinking')
    await this.stream(s, turnId, a3, 'thinking', LIVE.thinking2, flag, 60)
    a3.thinking = { ...a3.thinking!, text: LIVE.thinking2, endedAt: now(), tokens: 51 }
    this.upsert(s, [clone(a3)])
    this.phase(s, turnId, 'writing')
    await this.stream(s, turnId, a3, 'text', LIVE.answer, flag, 140)
    a3.text = LIVE.answer; a3.streaming = false; a3.endedAt = now(); a3.firstTokenAt = now()
    a3.usage = { input: 9_400, output: 820, cacheRead: 171_000, cacheWrite: 1_300, cacheUsageReported: true }
    this.upsert(s, [clone(a3)])
    this.phase(s, turnId, 'finishing')
    await this.wait(300 / this.speed)
    // After-answer compaction keeps the turn running briefly (E1).
    this.phase(s, turnId, 'compacting')
    await this.wait(900 / this.speed)
    turn.timing = { ...turn.timing, compactionAfter: 900 }
    // 0.63: a worktree conversation applies its changes to the project folder before handing back; a direct-mode
    // turn in a repository leaves a checkpoint.
    if (!flag.aborted && s.worktree) {
      this.phase(s, turnId, 'applying')
      turn.apply = { status: 'applying', applyIds: [] }
      this.turns(s, [clone(turn)])
      await this.wait(700 / this.speed)
      turn.apply = this.isolation.applyTurn(s, turnId, ['src/lib/terminal.ts'])
    } else if (!flag.aborted && s.projectId && this.git.isRepository(s.projectId)) turn.checkpoint = this.isolation.checkpoint(turnId)
    this.endTurn(s, turn, flag.aborted ? 'cancelled' : 'completed')
  }

  /* ------------------------------------------------ S2 side chats */

  private sideChats(method: string, sessionId: string, promote: boolean, body: Record<string, unknown>) {
    const s = this.need(sessionId)
    if (promote) {
      const parent = s.parentSessionId ? this.session(s.parentSessionId) : undefined
      const item = s.items.find(i => i.id === body.itemId)
      if (!parent || !item) throw new ApiError('条目不存在', 404)
      const existing = parent.items.find(i => i.source === 'side-chat' && i.sideChat?.itemId === item.id)
      if (existing) return { parentSessionId: parent.id, item: clone(existing), duplicate: true }
      const note: Item = { id: crypto.randomUUID(), turnId: null, kind: 'notice', source: 'side-chat', text: item.text, createdAt: new Date().toISOString(), sideChat: { sessionId: s.id, itemId: item.id, title: s.title } }
      this.upsert(parent, [note])
      return { parentSessionId: parent.id, item: clone(note), duplicate: false }
    }
    if (method === 'GET') return { parentSessionId: s.id, sideChats: this.sessions.filter(x => x.kind === 'side' && x.parentSessionId === s.id).map(summary) }
    const selection = body.selection as { text: string; itemId?: string } | undefined
    const side: Session = {
      id: `side-${Math.random().toString(36).slice(2, 8)}`, title: '辅助对话', kind: 'side', parentSessionId: s.id, sideChat: { selection: selection ? { itemId: selection.itemId ?? null, excerpt: selection.text } : null, readOnlyDefault: true, createdAt: new Date().toISOString() },
      projectId: s.projectId ?? null, status: 'idle', mode: 'plan', modelSelection: s.modelSelection ?? configuration.defaultModel,
      context: { tokens: 0, capacity: 1_000_000 }, activeTurnId: null, inbox: [], items: [], turns: [], revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    this.sessions.push(side)
    // The host announces it in the index too; the client must keep it out of the sidebar.
    this.broadcastIndex(side)
    return summary(side)
  }

  /** A short streamed answer for side chats, grounded in the quoted selection. */
  private async runSideTurn(s: Session, text: string) {
    const flag = { aborted: false }
    this.aborts.set(s.id, flag)
    const turnId = crypto.randomUUID()
    const now = () => new Date().toISOString()
    const user: Item = { id: crypto.randomUUID(), turnId, kind: 'user', text, createdAt: now(), delivery: 'send' }
    const turn: Turn = { id: turnId, status: 'running', mode: 'build', createdAt: now(), startedAt: now(), userItemId: user.id, modelConfig: { providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3' } }
    s.status = 'running'; s.activeTurnId = turnId
    this.patch(s, { status: 'running', activeTurnId: turnId })
    this.upsert(s, [user])
    this.turns(s, [turn])
    this.phase(s, turnId, 'thinking')
    await this.wait(500 / this.speed)
    const excerpt = s.sideChat?.selection?.excerpt ?? ''
    const quoted = excerpt ? `你引用的是：「${excerpt.slice(0, 60)}${excerpt.length > 60 ? '…' : ''}」。\n\n` : ''
    const answer = `${quoted}简短回答：这段话的重点是**把输出分段并保留首尾**，这样长命令的结果既能快速扫读，又不会丢失关键的报错信息。\n\n- 首尾各保留 6 行\n- 展开后显示完整输出\n- 退出码单独标出\n\n需要的话，我可以把这个结论同步到主对话。`
    const a: Item = { id: crypto.randomUUID(), turnId, kind: 'assistant', text: '', createdAt: now(), startedAt: now(), streaming: true }
    this.upsert(s, [clone(a)])
    this.phase(s, turnId, 'writing')
    await this.stream(s, turnId, a, 'text', answer, flag, 160)
    a.text = answer; a.streaming = false; a.endedAt = now()
    this.upsert(s, [clone(a)])
    turn.status = flag.aborted ? 'cancelled' : 'completed'; turn.completedAt = now()
    this.turns(s, [clone(turn)])
    s.status = 'idle'; s.activeTurnId = null
    this.patch(s, { status: 'idle', activeTurnId: null })
    this.aborts.delete(s.id)
  }

  private async subagent(s: Session, turnId: string) {
    const callId = crypto.randomUUID()
    const agentId = `agent-${callId.slice(0, 8)}`
    const started = new Date().toISOString()
    const task = '核对终端块在 390px 窄屏下的横向滚动与首尾截断'
    this.upsert(s, [{ id: callId, turnId, kind: 'tool', text: 'agent_delegate', createdAt: started, tool: { id: callId, name: 'agent_delegate', kind: 'other', args: { agent: 'scout', task }, status: 'succeeded', startedAt: started, endedAt: started, output: JSON.stringify({ agentId, status: 'running' }) } }])
    const item: Item = { id: `sa-${callId}`, turnId, kind: 'subagent', text: `项目侦察 · ${task}`, createdAt: started,
      subagent: { agentId, role: 'scout', roleName: '项目侦察', task, status: 'running', background: true, startedAt: started, endedAt: null, summary: null, delivery: 'awaiting', turnId, toolCallId: callId, toolCount: 0, lastTool: null, messages: 0 } }
    const flag = { cancelled: false }
    this.agents.set(agentId, { session: s, item, flag })
    this.upsert(s, [clone(item)])
    for (const tool of ['project_list', 'project_read', 'project_read', 'project_exec']) {
      await this.wait(1600 / this.speed)
      if (flag.cancelled) break
      item.subagent = { ...item.subagent!, toolCount: (item.subagent!.toolCount ?? 0) + 1, lastTool: tool }
      this.upsert(s, [clone(item)])
    }
    const done = !flag.cancelled
    const running = s.status !== 'idle'
    item.subagent = { ...item.subagent!, status: done ? 'completed' : 'cancelled', endedAt: new Date().toISOString(), summary: done ? '终端块在 390px 下横向滚动正常；超过 12 行时首尾各保留 6 行，展开后可完整查看。' : '已按你的要求取消。', usage: { totalTokens: 9_800, input: 9_100, output: 700 }, delivery: running ? 'steered' : 'noticed', ...(done ? {} : { code: 'user_cancelled' }) }
    this.upsert(s, [clone(item)])
    const text = `${done ? '子代理完成' : '子代理已取消'}：${item.subagent.summary}`
    this.upsert(s, [{ id: crypto.randomUUID(), turnId: running ? s.activeTurnId : null, kind: running ? 'user' : 'notice', source: 'subagent', agentId, text, createdAt: new Date().toISOString(), delivery: running ? 'steer' : undefined }])
    this.agents.delete(agentId)
  }

  private endTurn(s: Session, turn: Turn, status: Turn['status']) {
    turn.status = status
    turn.completedAt = new Date().toISOString()
    this.turns(s, [clone(turn)])
    s.status = 'idle'; s.activeTurnId = null
    s.context = { ...s.context, tokens: (s.context?.tokens ?? 0) + 12_000 }
    this.patch(s, { status: 'idle', activeTurnId: null, context: s.context })
    this.broadcastIndex(s)
    this.aborts.delete(s.id)
  }

  private async finishQuestionTurn(s: Session) {
    const turn = s.turns.find(t => t.id === s.activeTurnId)
    if (!turn) return
    const flag = { aborted: false }
    await this.wait(400)
    const skill = await this.tool(s, turn.id, flag, { name: 'capability_install', kind: 'skill', target: 'build-hybrid-game-assets', args: { name: 'build-hybrid-game-assets' } }, 900, 'installed')
    void skill
    const a: Item = { id: crypto.randomUUID(), turnId: turn.id, kind: 'assistant', text: '', createdAt: new Date().toISOString(), streaming: true }
    this.upsert(s, [clone(a)])
    const answer = '已安装所选技能，并把它们分配给当前项目。下次涉及美术资产的任务会自动加载这些技能。'
    await this.stream(s, turn.id, a, 'text', answer, flag, 120)
    a.text = answer; a.streaming = false
    this.upsert(s, [clone(a)])
    this.endTurn(s, turn, 'completed')
  }
}

function summary(s: Session): SessionSummary {
  const { items, turns: _t, ...meta } = s
  void _t
  const last = [...items].reverse().find(i => i.kind === 'assistant' || i.kind === 'user')
  return { ...meta, itemCount: items.length, lastItemAt: items.at(-1)?.createdAt ?? s.updatedAt, preview: last?.text.slice(0, 80), agents: mockAgentsSummary(s) ?? null }
}
