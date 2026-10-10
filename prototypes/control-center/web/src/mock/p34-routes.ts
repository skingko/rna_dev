/**
 * Mock routes for P3 (project inbox, delivery feedback) and P4 (evolution
 * changelog / components / history / signals / failures, task types, system
 * evolution). State lives on the ProjectStore details so the project summary
 * counts (`inbox`, `inboxUnread`) stay consistent. `?scenario=notify` pushes a
 * notify-tier delivery a few seconds after load.
 */
import { ApiError } from '@/api/transport'
import type { InboxEntry } from '@/api/communication-api'
import * as fx from './p34-fixtures'
import { projects } from './fixtures'

type Json = Record<string, unknown>
const clone = <T,>(v: T): T => structuredClone(v)
const DAY = 86_400_000
const WINDOWS: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
const TASK_TYPES = ['research', 'coding', 'creative', 'design', 'analysis', 'writing', 'recurring', 'data']
const TIER_RANK: Record<string, number> = { digest: 0, inbox: 1, inline: 2, notify: 3 }

export interface P34Host {
  detail(id: string): Json | undefined
  touch(id: string): void
  emitAll(type: string, data: unknown): void
}

export function inboxCounts(d: Json) {
  const rows = (d.inbox as InboxEntry[] | undefined) ?? []
  return { inbox: rows.length, inboxUnread: rows.filter(r => r.status === 'unread' && !r.contextRevoked).length }
}

export function classifyFailures(list: { id: string; versions?: Json[] }[]) {
  const rows = list.flatMap(p => (p.versions ?? []).filter(v => v.simulated === false && ['failed', 'interrupted'].includes(String(v.state))).map(v => {
    const error = (v.error ?? {}) as { code?: string; diagnostic?: { phase?: string; kind?: string } }
    const code = error.code ?? 'unknown', kind = error.diagnostic?.kind ?? code, phase = error.diagnostic?.phase ?? 'unknown'
    const cls = v.state === 'interrupted' || ['connection', 'provider_error', 'timeout'].includes(kind) ? 'infra' : ['proposal', 'author'].includes(phase) ? 'author' : 'eval'
    const cause = cls === 'infra' ? (kind === 'connection' ? 'provider_connection' : kind) : cls === 'author' ? (['invalid_json', 'invalid_submission'].includes(kind) ? 'author_output_format' : `author_${kind}`) : phase === 'judge' ? 'judge_output_schema' : `eval_${kind}`
    return { projectId: p.id, versionId: String(v.id), state: String(v.state), phase, code, kind, class: cls, cause, at: String(v.createdAt ?? '') }
  }))
  const count = (key: 'class' | 'cause') => rows.reduce<Record<string, number>>((out, r) => (out[r[key]] = (out[r[key]] ?? 0) + 1, out), {})
  const states = list.flatMap(p => (p.versions ?? []).filter(v => v.simulated === false)).reduce<Record<string, number>>((out, v) => (out[String(v.state)] = (out[String(v.state)] ?? 0) + 1, out), {})
  return { total: rows.length, versionStates: states, byClass: count('class'), byCause: count('cause'), rows }
}

export class P34Store {
  constructor(private host: P34Host) {
    const ink = host.detail('p-ink')
    if (ink) {
      ink.inbox = fx.inbox()
      ink.initiative = { ...(ink.initiative as Json), desktopNotifications: true, digestHour: 9 }
      ink.skillFoundation = { status: 'completed', screening: clone(fx.screening) }
      const versions = ink.versions as Json[]
      for (const v of versions) Object.assign(v, clone(fx.versionPatches[String(v.id)] ?? {}))
      versions.push(...clone(fx.extraVersions) as unknown as Json[])
      const actions = ((ink.initiativeRuntime as Json).sdkState as { actions: Json[] }).actions
      for (const a of actions) if (fx.handoffs[String(a.id)]) a.handoff = fx.handoffs[String(a.id)]
      for (const j of ink.jobs as Json[]) if (fx.handoffs[String(j.id)]) j.handoff = fx.handoffs[String(j.id)]
    }
    for (const p of projects) { const d = host.detail(p.id); if (d && !d.inbox) d.inbox = [] }
    if (new URLSearchParams(location.search).get('scenario') === 'notify') setTimeout(() => this.simulateNotify(), 4000)
  }

  private need(id: string) {
    const d = this.host.detail(decodeURIComponent(id))
    if (!d) throw new ApiError('项目不存在', 404)
    return d
  }

  simulateNotify() {
    const d = this.host.detail('p-ink')
    if (!d) return
    const entry: InboxEntry = { id: `ibx-${Math.random().toString(36).slice(2, 8)}`, actionId: 'act-notify', kind: 'share', tier: 'notify', requestedTier: 'notify', text: '**夜间构建失败**：`vite build` 在压缩纸纹理时内存不足。已定位到 4K 贴图，建议先降到 2K。', sessionId: 's-ui', createdAt: new Date().toISOString(), status: 'unread', notifiedAt: new Date().toISOString(), feedback: null }
    ;(d.inbox as InboxEntry[]).push(entry)
    this.host.touch('p-ink')
    this.host.emitAll('notify', { projectId: 'p-ink', entryId: entry.id, sessionId: 's-ui', title: '夜间构建失败', body: 'vite build 在压缩纸纹理时内存不足。', at: entry.createdAt })
  }

  /** Returns undefined when not a P3/P4 route. */
  handle(method: string, url: URL, body: Json): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'GET' && p === '/api/v2/evolution/failures') return classifyFailures(projects.map(pr => ({ id: pr.id, versions: this.host.detail(pr.id)?.versions as Json[] })))
    if (method === 'GET' && p === '/api/v2/evolution/system') return fx.system(projects.map(pr => pr.id))
    if (method === 'POST' && p === '/api/v2/evolution/system/proposals') {
      const target = fx.system([]).targets.find(t => (!body.key || t.key === body.key) && (!body.component || t.component === body.component)) ?? null
      return { schemaVersion: 1, id: `sys-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), status: 'proposed', autoAdopt: false, adoption: 'manual_review_required', target, note: String(body.note ?? '') }
    }
    if (!(m = p.match(/^\/api\/v2\/projects\/([^/]+)\/(.+)$/))) return undefined
    const projectId = decodeURIComponent(m[1]), rest = m[2]
    if (rest === 'inbox' && method === 'GET') return this.list(projectId, url)
    if (rest === 'inbox/read-all' && method === 'POST') {
      const d = this.need(projectId)
      for (const e of d.inbox as InboxEntry[]) if (e.status === 'unread') { e.status = 'read'; e.readAt = new Date().toISOString() }
      this.host.touch(projectId)
      return this.list(projectId, new URL('http://mock/?limit=1'))
    }
    if ((m = rest.match(/^inbox\/([^/]+)$/)) && method === 'POST') return this.act(projectId, decodeURIComponent(m[1]), String(body.action))
    if (rest === 'delivery-feedback' && method === 'GET') return this.feedback(projectId, url.searchParams.get('window') ?? '7d')
    if (rest === 'task-types') {
      const d = this.need(projectId)
      const explicit = Array.isArray(d.taskTypes) && (d.taskTypes as string[]).length > 0
      if (method === 'PATCH') {
        const types = body.taskTypes
        if (!(types === null || (Array.isArray(types) && types.length >= 1 && types.length <= 4 && types.every(t => TASK_TYPES.includes(String(t))) && new Set(types).size === types.length))) throw new ApiError('taskTypes 必须为 1–4 个不同的类型，或 null 表示自动推断。', 400, 'task_types_invalid')
        if (types === null) delete d.taskTypes
        else d.taskTypes = [...types]
        this.host.touch(projectId)
        return { projectId, taskTypes: types ?? fx.taskTypes.taskTypes, explicit: types !== null, vocabulary: TASK_TYPES }
      }
      return { projectId, taskTypes: explicit ? d.taskTypes : projectId === 'p-ink' ? fx.taskTypes.taskTypes : ['coding'], explicit, vocabulary: TASK_TYPES }
    }
    if (!(m = rest.match(/^evolution\/(changelog|components|history|signals|failures|replay-standard)$/))) return undefined
    const d = this.need(projectId)
    const rich = projectId === 'p-ink'
    switch (m[1]) {
      case 'changelog': return { projectId, entries: rich ? clone(fx.changelog) : [] }
      case 'components': {
        const key = url.searchParams.get('key')
        const rows = rich ? fx.components() : []
        return { projectId, components: rows.filter(r => !key || r.key === key), tried: rich ? ['system_section', 'skill', 'evaluation_standard'] : [], untried: rich ? ['tool_description', 'mcp_assignment', 'rhythm', 'communication_style'] : ['system_section', 'skill'], falsified: rich ? clone(fx.history.falsified) : [], pruneSet: rich ? clone(fx.history.pruneSet) : [], ...(key ? { git: rich ? clone(fx.componentGit) : [] } : {}) }
      }
      case 'history': return { projectId, ...clone(fx.history), ...(rich ? {} : { frontier: { round: 0, sStar: null, trajectory: [] }, falsified: [], pruneSet: [] }) }
      case 'signals': return rich ? { projectId, ...clone(fx.signals) } : { projectId, counts: {}, score: { score: null, signals: 0 }, heldOut: 0, signals: [], replay: [] }
      case 'failures': return classifyFailures([{ id: projectId, versions: d.versions as Json[] }])
      default: return { projectId, component: 'evaluation_standard', cases: [], heldOut: [], capacity: 7, adoption: 'reviewed_evaluation_revision_required' }
    }
  }

  private list(projectId: string, url: URL) {
    const d = this.need(projectId)
    const status = url.searchParams.get('status') ?? 'active'
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
    const all = (d.inbox as InboxEntry[]).filter(r => !r.contextRevoked)
    const rows = all.filter(r => status === 'all' || (status === 'active' ? r.status !== 'dismissed' : r.status === status))
    const hour = (d.initiative as { digestHour?: number } | undefined)?.digestHour ?? 9
    const nextDigest = (from: string) => { const t = new Date(from); t.setHours(hour, 0, 0, 0); if (t.getTime() < Date.parse(from)) t.setDate(t.getDate() + 1); return t.toISOString() }
    return {
      projectId, unread: inboxCounts(d).inboxUnread, total: rows.length, now: new Date().toISOString(),
      entries: rows.slice(-limit).reverse().map(r => ({ ...clone(r), ...(r.heldForDigest ? { digestAt: nextDigest(r.createdAt) } : {}) })),
    }
  }

  private act(projectId: string, entryId: string, action: string) {
    const d = this.need(projectId)
    if (!['read', 'dismiss', 'act'].includes(action)) throw new ApiError('action 必须为 read、dismiss 或 act', 400, 'invalid_inbox_action')
    const entry = (d.inbox as InboxEntry[]).find(r => r.id === entryId && !r.contextRevoked)
    if (!entry) throw new ApiError('收件箱中没有这条消息', 404, 'inbox_entry_not_found')
    const now = new Date().toISOString()
    if (entry.status === 'unread') { entry.status = 'read'; entry.readAt = now }
    if (action === 'dismiss' && entry.status !== 'dismissed') { entry.status = 'dismissed'; entry.dismissedAt = now; entry.heldForDigest = false; entry.feedback ??= { outcome: 'dismissed', at: now, windowMs: 12 * 3_600_000 } }
    if (action === 'act') { entry.actedAt ??= now; entry.feedback ??= { outcome: 'acted', at: now, windowMs: 12 * 3_600_000 } }
    this.host.touch(projectId)
    return { entry: clone(entry), unread: inboxCounts(d).inboxUnread }
  }

  private feedback(projectId: string, window: string) {
    const d = this.need(projectId)
    const windowMs = WINDOWS[window]
    if (!windowMs) throw new ApiError('window 必须为 24h、7d 或 30d', 400)
    const since = Date.now() - windowMs
    const rows = (d.inbox as InboxEntry[]).filter(r => !r.contextRevoked && Date.parse(r.createdAt) >= since)
    const counts = { delivered: rows.length, pending: 0, replied: 0, acted: 0, dismissed: 0, ignored: 0 }
    const byTier: Record<string, number> = { inline: 0, inbox: 0, notify: 0, digest: 0 }
    for (const r of rows) { counts[(r.feedback?.outcome ?? 'pending') as keyof typeof counts]++; byTier[r.tier] = (byTier[r.tier] ?? 0) + 1 }
    const settled = counts.replied + counts.acted + counts.dismissed + counts.ignored
    const rate = (n: number) => (settled ? Math.round(n / settled * 1000) / 1000 : null)
    return {
      projectId, windowMs, window, since: new Date(since).toISOString(), counts, byTier, settled,
      usefulShareRate: rate(counts.replied + counts.acted), replyRate: rate(counts.replied), actRate: rate(counts.acted), dismissRate: rate(counts.dismissed), ignoreRate: rate(counts.ignored),
      lowered: rows.filter(r => r.requestedTier && (TIER_RANK[r.tier] ?? 0) < (TIER_RANK[r.requestedTier] ?? 0)).length,
      recent: rows.filter(r => r.feedback).map(r => ({ entryId: r.id, actionId: r.actionId, kind: r.kind, tier: r.tier, requestedTier: r.requestedTier, deliveredAt: r.createdAt, outcome: r.feedback!.outcome, observedAt: r.feedback!.at })),
    }
  }
}
