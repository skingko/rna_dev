/**
 * Mock routes for the project workspace (tasks, versions, observations,
 * files, preview, capabilities, session commands, recovery, emergency).
 * Mutations update in-memory state and push an `index` event with the new
 * project summary, like the daemon.
 */
import { ApiError } from '@/api/transport'
import type { ProjectPlan, ProjectSummary, Session } from '@/api/types'
import * as fx from './project-fixtures'
import { ago, projects } from './fixtures'
import { inboxCounts } from './p34-routes'
import { mindSummaryCounts } from './mind-routes'
import { mockPlan, mockWork } from './background-fixtures'

type Json = Record<string, unknown>

const MOCK_PREVIEW = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html lang="zh-CN"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#f3efe6;font-family:serif;color:#1d1a17"><div style="text-align:center"><div style="font-size:42px;letter-spacing:.2em">墨跃</div><div style="margin-top:8px;opacity:.6">墨迹成桥 · 预览</div><div style="margin-top:24px;color:#9a3730;font-size:28px">0 分</div></div></body></html>')}`
const HEAVY = ['versions', 'jobs', 'decisions', 'learningRuntime', 'observations', 'memorySessions', 'facts', 'inbox', 'mind']
const clone = <T,>(v: T): T => structuredClone(v)

export interface MockHost {
  session(id: string): Session | undefined
  broadcastProject(summary: ProjectSummary): void
  setEmergency(stop: boolean): void
}

export class ProjectStore {
  details = new Map<string, Json>()
  preview: { projectId: string; status: string; url: string; revision: number; kind: string; entryPath: string; generation: string } | null = null
  constructor(private host: MockHost) {
    for (const p of projects) {
      const rich = p.id === 'p-ink'
      this.details.set(p.id, {
        ...clone(p),
        decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, focus: rich ? '界面重设计后的移动端体验与回归稳定性' : '联调 v2 事件协议',
        initiative: { enabled: true, quietUntil: null, notificationMuted: false }, evolution: { enabled: true, request: null },
        activeVersionId: rich ? 'v11' : null, trialVersionId: null,
        schedules: rich ? clone(fx.schedules) : p.id === 'p-agent' ? clone(fx.agentSchedules) : [], scheduleRuntime: { occurrences: rich ? clone(fx.occurrences) : [] },
        observationSources: rich ? clone(fx.observationSources) : [],
        rhythmStatus: rich ? clone(fx.rhythmStatus) : p.rhythmStatus,
        versions: rich ? clone(fx.versions) : [], jobs: rich ? clone(fx.jobs) : [], decisions: rich ? clone(fx.decisions) : [], observations: rich ? clone(fx.observations) : [],
        learningRuntime: rich ? clone(fx.learningRuntime) : {},
        initiativeRuntime: { status: rich ? 'working' : 'observing', sdkState: { actions: rich ? clone(fx.actions) : p.id === 'p-agent' ? clone(fx.agentActions) : [] } },
        ...(p.id === 'p-agent' ? { plan: clone(fx.agentPlan) } : {}),
      })
    }
  }

  has(id: string) { return this.details.has(id) }

  summary(id: string): ProjectSummary {
    const d = this.need(id)
    // F1 panels edit the shared fixture rows (name, focus, archive…): keep them current here.
    const base = projects.find(p => p.id === id)
    if (base) for (const k of ['name', 'description', 'archivedAt', 'focus', 'initiative', 'evolution', 'rhythm', 'permissions', 'workspacePath', 'git'] as const) { const v = (base as unknown as Json)[k]; if (v !== undefined) d[k] = typeof v === 'object' && v && typeof d[k] === 'object' && d[k] ? { ...(d[k] as Json), ...clone(v as Json) } : clone(v) }
    const out: Json = {}
    for (const [k, v] of Object.entries(d)) if (!HEAVY.includes(k) && k !== 'initiativeRuntime') out[k] = clone(v)
    const versions = (d.versions as { id: string; version: number; title?: string }[]) ?? []
    const active = versions.find(v => v.id === d.activeVersionId)
    const runtime = d.initiativeRuntime as Json
    out.initiativeRuntime = { status: runtime?.status }
    out.counts = { versions: versions.length, jobs: (d.jobs as unknown[]).length, openTasks: (d.jobs as { status: string }[]).filter(j => ['queued', 'running', 'paused'].includes(j.status)).length, observations: (d.observations as unknown[]).length, decisions: (d.decisions as unknown[]).length, ...inboxCounts(d), ...mindSummaryCounts(d) }
    out.activeVersion = active ? { id: active.id, version: active.version, title: active.title } : null
    out.updatedAt = d.updatedAt ?? new Date().toISOString()
    // Tasks panel (background-fixtures): `work` from the action rows as they stand, plan items tied to their runs.
    out.work = mockWork(id, (runtime?.sdkState as { actions?: Json[] } | undefined)?.actions ?? [])
    // The running work's plan items belong to 水墨飞鸟's plan only.
    if (id === 'p-ink') out.plan = mockPlan(out.plan as ProjectPlan | null | undefined)
    return out as unknown as ProjectSummary
  }

  private need(id: string): Json {
    const d = this.details.get(decodeURIComponent(id))
    if (!d) throw new ApiError('项目不存在', 404)
    return d
  }
  /** Bump updatedAt and broadcast the summary (used by the P3/P4 mock routes too). */
  touch(id: string) {
    const d = this.need(id)
    d.updatedAt = new Date().toISOString()
    this.host.broadcastProject(this.summary(id))
  }

  /** Returns undefined when the route is not a project-workspace route. */
  handle(method: string, url: URL, body: Json): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)$/))) {
      const d = this.need(m[1])
      const include = (url.searchParams.get('include') ?? '').split(',').filter(Boolean)
      const out = this.summary(m[1]) as unknown as Json
      for (const k of include.includes('all') ? [...HEAVY, 'initiativeRuntime'] : include) if (d[k] !== undefined) out[k] = clone(d[k])
      return out
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/schedules(?:\/([^/]+))?$/))) return this.schedules(method, m[1], m[2] && decodeURIComponent(m[2]), body)
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/initiative\/actions(?:\/([^/]+)\/(control|resolve))?$/))) return this.actions(method, m[1], m[2], m[3], body)
    if (method === 'POST' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/tasks\/([^/]+)$/))) return this.answerTask(m[1], decodeURIComponent(m[2]), String(body.choice))
    if (method === 'POST' && (m = p.match(/^\/api\/projects\/([^/]+)\/versions\/([^/]+)\/control$/))) return this.versionControl(m[1], m[2], String(body.action))
    if (method === 'POST' && (m = p.match(/^\/api\/projects\/([^/]+)\/evolution$/))) return this.evolution(m[1], body)
    if (method === 'POST' && (m = p.match(/^\/api\/projects\/([^/]+)\/observations$/))) {
      const d = this.need(m[1])
      const record = { id: crypto.randomUUID(), kind: body.kind, text: body.text, status: 'pending', createdAt: new Date().toISOString(), source: 'user-observation', simulated: false }
      ;(d.observations as unknown[]).push(record)
      this.touch(m[1])
      return record
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/sources(?:\/([^/]+))?$/))) {
      const d = this.need(m[1])
      const sources = d.observationSources as Json[]
      if (method === 'PATCH' && m[2]) {
        const s = sources.find(x => x.id === m![2])
        if (!s) throw new ApiError('来源不存在', 404)
        s.enabled = Boolean(body.enabled); s.status = s.enabled ? 'watching' : 'paused'
        this.touch(m[1])
        return { projectId: m[1], sources: clone(sources) }
      }
      return { projectId: m[1], sources: clone(sources) }
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/(files|file|preview)$/))) return this.workspace(method, m[1], m[2], url, body)
    if (method === 'GET' && (m = p.match(/^\/api\/projects\/([^/]+)\/capabilities$/))) return { skills: clone(fx.skills), tools: [], mcpServers: [], installations: [], assignments: { skillIds: fx.skills.map(s => s.id) } }
    if (method === 'PATCH' && (m = p.match(/^\/api\/projects\/([^/]+)$/))) {
      const d = this.need(m[1])
      if (body.initiative) d.initiative = { ...(d.initiative as Json), ...(body.initiative as Json) }
      this.touch(m[1])
      return this.summary(m[1])
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/commands$/))) return this.commands(method, m[1], body)
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/recovery$/))) {
      const s = this.host.session(m[1])
      const tools = s?.runtime?.recovery?.uncertainTools ?? []
      if (s?.runtime?.recovery) s.runtime.recovery.uncertainTools = tools.filter(t => t.callKey !== body.callKey)
      return { ok: true }
    }
    if (method === 'POST' && p === '/api/emergency') { this.host.setEmergency(Boolean(body.stop)); return { emergency: Boolean(body.stop) } }
    return undefined
  }

  private schedules(method: string, projectId: string, id: string | undefined, body: Json) {
    const d = this.need(projectId)
    const list = d.schedules as Json[]
    if (method === 'GET') return { schedules: clone(list), occurrences: clone((d.scheduleRuntime as Json).occurrences), defaults: { time: '09:00', timeZone: 'Asia/Shanghai' } }
    if (method === 'POST') {
      const row = { id: `sch-${Math.random().toString(36).slice(2, 8)}`, source: 'manual', ...body, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }
      delete (row as Json).requestId
      list.push(row)
    } else if (method === 'PATCH' && id) {
      const row = list.find(x => x.id === id)
      if (!row) throw new ApiError('日程不存在', 404)
      Object.assign(row, body, { userEditedAt: new Date().toISOString() })
      if (body.enabled === false) row.nextRunAt = null
      else if (!row.nextRunAt) row.nextRunAt = new Date(Date.now() + 3_600_000).toISOString()
    } else if (method === 'DELETE' && id) {
      d.schedules = list.filter(x => x.id !== id)
    }
    this.touch(projectId)
    return { ok: true }
  }

  private actions(method: string, projectId: string, actionId: string | undefined, verb: string | undefined, body: Json) {
    const d = this.need(projectId)
    const actions = ((d.initiativeRuntime as Json).sdkState as { actions: Json[] }).actions
    if (method === 'GET' && !actionId) {
      return {
        // A revoked action is listed as the host's receipt (revokedView): its kept name, never its content. The host leaves
        // one with nothing kept out unless it waits to be checked; the mock lists it anyway, so the page's guard (no 接着做
        // where the host would refuse it, task_context_revoked) can be seen.
        projectId, actions: actions.map(a => (a.contextRevoked ? {
          id: a.id, action: a.action, status: a.status, revoked: true, label: a.keptLabel ?? '', content: '', failure: clone(a.failure), controlRevision: a.controlRevision ?? 0, availableControls: [], attention: clone(a.attention ?? null),
          receipt: { label: a.keptLabel ?? '', status: a.status, startedAt: a.startedAt, finishedAt: a.finishedAt },
        } : {
          ...clone(a),
          availableControls: a.action !== 'work' ? [] : a.status === 'running' ? ['pause', 'stop', 'steer'] : a.status === 'paused' ? ['resume', 'stop', 'steer'] : a.status === 'queued' ? ['stop', 'steer'] : [],
        })),
      }
    }
    const action = actions.find(a => a.id === decodeURIComponent(actionId ?? ''))
    if (!action) throw new ApiError('行动不存在', 404)
    if (verb === 'resolve') { action.status = body.status === 'completed' ? 'completed' : 'cancelled'; action.resultSummary = body.summary; this.touch(projectId); return { ok: true } }
    if (body.expectedRevision !== action.controlRevision) throw new ApiError('后台状态已变化，请刷新后重试。', 409)
    action.controlRevision = Number(action.controlRevision ?? 0) + 1
    const controls = (action.controls as Json[]) ?? (action.controls = [])
    if (body.action === 'pause') action.status = 'paused'
    else if (body.action === 'resume') action.status = 'running'
    else if (body.action === 'stop') action.status = 'cancelled'
    controls.push({ id: String(body.requestId), kind: body.action === 'stop' ? 'cancel' : body.action, status: body.action === 'steer' ? 'pending' : 'applied', text: body.text })
    this.touch(projectId)
    return { receipt: { status: 'accepted' }, action: { status: action.status } }
  }

  /**
   * The user's call on background work (the host's answerTask): failed → continue | drop; to check → keep | drop;
   * finished → acknowledge (also drop). Marked answered either way; 接着做 on a run nothing was kept of is refused after it is
   * marked (task_context_revoked), as the host does.
   */
  private answerTask(projectId: string, actionId: string, choice: string) {
    const d = this.need(projectId)
    const action = ((d.initiativeRuntime as Json).sdkState as { actions: Json[] }).actions.find(a => a.id === actionId)
    if (!action) throw new ApiError('后台任务不存在', 404, 'task_not_found')
    const review = action.status === 'needs_review', choices = review ? ['keep', 'drop'] : action.status === 'completed' ? ['continue', 'drop', 'acknowledge'] : ['continue', 'drop']
    if (!choices.includes(choice)) throw new ApiError(`choice 必须为 ${choices.join(' 或 ')}`, 400)
    if (review) action.status = choice === 'keep' ? 'completed' : 'cancelled'
    const lost = choice === 'continue' && Boolean(action.contextRevoked) && !action.keptLabel
    action.attention = { ...(action.attention as Json | undefined), acknowledgedAt: new Date().toISOString(), choice: lost ? 'expired' : choice }
    this.touch(projectId)
    if (lost) throw new ApiError('这项后台工作的记录已经失效，没法接着做了。可以直接在对话里说要做什么。', 409, 'task_context_revoked')
    return { projectId, actionId, choice, revision: 1 }
  }

  private versionControl(projectId: string, versionId: string, action: string) {
    const d = this.need(projectId)
    const versions = d.versions as Json[]
    const v = versions.find(x => x.id === versionId)
    if (!v) throw new ApiError('版本不存在', 404)
    if (action === 'trial') { d.trialVersionId = v.id; v.state = 'trial' }
    else if (action === 'adopt') {
      const prev = versions.find(x => x.id === d.activeVersionId)
      if (prev) prev.state = 'archived'
      d.activeVersionId = v.id; d.trialVersionId = null; v.state = 'active'
    } else if (action === 'rollback') {
      if (d.trialVersionId === v.id) { d.trialVersionId = null; v.state = 'ready' }
      else if (d.activeVersionId === v.id && v.parentVersionId) { v.state = 'archived'; d.activeVersionId = v.parentVersionId; const parent = versions.find(x => x.id === v.parentVersionId); if (parent) parent.state = 'active' }
    }
    this.touch(projectId)
    return { ok: true }
  }

  private evolution(projectId: string, body: Json) {
    const d = this.need(projectId)
    const versions = d.versions as Json[]
    if (body.retryVersionId) {
      const src = versions.find(v => v.id === body.retryVersionId)
      versions.push({ id: `v-${Math.random().toString(36).slice(2, 6)}`, version: `candidate-${versions.length + 1}`, title: `重新评估：${src?.title ?? ''}`, state: 'evaluating', parentVersionId: src?.parentVersionId, createdAt: new Date().toISOString(), simulated: false, retryOfVersionId: src?.id })
    } else if (body.baseVersionId) {
      versions.push({ id: `v-${Math.random().toString(36).slice(2, 6)}`, version: `candidate-${versions.length + 1}`, title: String(body.summary ?? '用户编辑的项目能力候选'), state: 'evaluating', parentVersionId: body.baseVersionId, createdAt: new Date().toISOString(), simulated: false })
    }
    this.touch(projectId)
    return { status: 'scheduled' }
  }

  private workspace(method: string, projectId: string, action: string, url: URL, body: Json) {
    this.need(projectId)
    if (action === 'files') {
      const path = url.searchParams.get('path') ?? ''
      return { path, entries: fx.listDirectory(path), truncated: false }
    }
    if (action === 'file') {
      const path = url.searchParams.get('path') ?? ''
      if (fx.isBinaryFixture(path)) throw new ApiError('此文件不是 UTF-8 文本，请下载查看。', 415)
      const content = fx.files[path]
      if (content === undefined) throw new ApiError('文件不存在', 404)
      return { path, content, language: fx.languageOf(path), bytes: new TextEncoder().encode(content).length, truncated: false }
    }
    // preview
    if (method === 'GET') return this.preview?.projectId === projectId ? clone(this.preview) : { status: 'stopped' }
    if (method === 'DELETE') { this.preview = null; return { status: 'stopped' } }
    const entry = String(body.path ?? body.directory ?? 'index.html') || 'index.html'
    if (body.mode === 'auto' && projectId !== 'p-ink') return { status: 'unavailable', discovery: { status: 'ambiguous', reason: 'no_entry', candidates: [] } }
    // A same-machine page on another port (mock stand-in for the daemon's preview server).
    this.preview = { projectId, status: 'ready', kind: body.mode === 'vite' ? 'vite' : 'static', entryPath: body.mode === 'auto' ? 'index.html' : entry, url: MOCK_PREVIEW, revision: 0, generation: crypto.randomUUID() }
    return clone(this.preview)
  }

  private commands(method: string, sessionId: string, body: Json) {
    const s = this.host.session(sessionId)
    if (!s) throw new ApiError('会话不存在', 404)
    const busy = s.status !== 'idle'
    if (method === 'GET') {
      return { sessionId, commands: ['compact', 'plan', 'goal', 'feedback', 'export'].map(id => ({ id, available: !(busy && ['compact', 'plan'].includes(id)), ...(busy && ['compact', 'plan'].includes(id) ? { reason: 'session_busy' } : {}) })) }
    }
    const args = (body.args ?? {}) as Json
    if (body.command === 'plan') { s.mode = args.mode === 'plan' ? 'plan' : 'build'; return { result: { mode: s.mode } } }
    if (body.command === 'goal') { const d = this.details.get(s.projectId ?? ''); if (d) { d.focus = args.text; this.touch(String(s.projectId)) } return { result: { saved: true } } }
    if (body.command === 'compact') return { result: { compacted: (s.context?.tokens ?? 0) > 50_000 } }
    return { result: { saved: true, at: ago(0) } }
  }
}
