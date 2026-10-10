/**
 * Mock routes for the v2 Project Mind (§8): GET mind, PATCH / DELETE entries,
 * §5 metrics and per-message feedback. Changes bump the project summary
 * counts (index) and push a `project.mind` summary event.
 *
 * Query options: `mind=off` answers 404 everywhere (older daemon);
 * `scenario=mind` learns a new lesson and opens an overdue commitment a few
 * seconds after load (live-update demo).
 */
import { ApiError } from '@/api/transport'
import type { Item, ProjectPlan } from '@/api/types'
import type { InboxEntry } from '@/api/communication-api'
import type { MindCollection, ProjectMind } from '@/api/mind-api'
import { mindCounts } from '@/lib/mind'
import * as fx from './mind-fixtures'

type Json = Record<string, unknown>
const clone = <T,>(v: T): T => structuredClone(v)
const COLLECTIONS: MindCollection[] = ['lessons', 'agenda', 'commitments', 'threads', 'notes']
const STATUS: Record<string, string[]> = {
  lessons: ['active', 'superseded', 'retired'], agenda: ['open', 'done', 'dropped'], commitments: ['pending', 'resolved', 'dismissed'], threads: ['open', 'resolved', 'muted'],
}

export interface MindHost {
  detail(id: string): Json | undefined
  touch(id: string): void
  emitAll(type: string, data: unknown): void
  item(sessionId: string, itemId: string): { item: Item; commit: (item: Item) => void } | null
}

export function mindSummaryCounts(d: Json) {
  const mind = d.mind as ProjectMind | undefined
  return mind ? mindCounts(mind) : {}
}

type PlanRow = ProjectPlan['next'][number]

export class MindStore {
  readonly off = new URLSearchParams(location.search).get('mind') === 'off'
  /** Plan lines taken off the summary's plan (done or dropped), with the stage to put them back in (`open`). */
  private parked = new Map<string, { row: PlanRow; stage: 'doing' | 'next' }>()
  constructor(private host: MindHost) {
    const ink = host.detail('p-ink')
    if (ink) {
      ink.mind = fx.inkMind()
      for (const entry of (ink.inbox as InboxEntry[] | undefined) ?? []) {
        if (fx.inboxThreads[entry.id]) entry.threadId = fx.inboxThreads[entry.id]
        if (fx.inboxPacing[entry.id]) entry.pacing = clone(fx.inboxPacing[entry.id])
        if (entry.id === 'ibx-2') entry.deliverables = clone(fx.pro2Deliverables)
      }
      ;(ink.inbox as InboxEntry[]).push(...(fx.overflowEntries() as InboxEntry[]))
    }
    const agent = host.detail('p-agent')
    if (agent) agent.mind = fx.agentMind()
    if (!this.off && new URLSearchParams(location.search).get('scenario') === 'mind') setTimeout(() => this.simulateLearning(), 3500)
  }

  private mind(projectId: string): ProjectMind {
    const mind = this.host.detail(projectId)?.mind as ProjectMind | undefined
    if (!mind) throw new ApiError('项目不存在', 404)
    return mind
  }

  private changed(projectId: string, changed: MindCollection[]) {
    const mind = this.mind(projectId)
    mind.revision = (mind.revision ?? 0) + 1
    mind.updatedAt = new Date().toISOString()
    this.host.touch(projectId)
    this.host.emitAll('project.mind', { projectId, revision: mind.revision, counts: mindCounts(mind), health: mind.health, changed, updatedAt: mind.updatedAt })
  }

  simulateLearning() {
    const mind = this.host.detail('p-ink')?.mind as ProjectMind | undefined
    if (!mind) return
    const now = new Date().toISOString()
    mind.lessons.unshift({ id: `l-${Math.random().toString(36).slice(2, 6)}`, kind: 'preference', text: '凌晨不要发非紧急的主动消息，等我上线后合并成一条。', scope: 'user', status: 'active', createdAt: now, source: { kind: 'correction', sessionId: 's-ui', itemId: 'u-ui-1' }, uses: { recalled: 0, applied: 0, contradicted: 0 } })
    this.changed('p-ink', ['lessons'])
  }

  /** Returns undefined when not a mind route. */
  handle(method: string, url: URL, body: Json): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'POST' && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/items\/([^/]+)\/feedback$/))) {
      if (this.off) throw new ApiError('mock: 未实现', 404)
      return this.feedback(decodeURIComponent(m[1]), decodeURIComponent(m[2]), body)
    }
    // A mind question card answered in place (the fixture card is not in a mock session): close its agenda item.
    if (method === 'POST' && (m = p.match(/^\/api\/sessions\/([^/]+)\/interactions\/([^/]+)\/answer$/))) {
      for (const projectId of ['p-ink', 'p-agent']) {
        const agenda = ((this.host.detail(projectId)?.mind as ProjectMind | undefined)?.agenda ?? []) as unknown as Json[]
        const target = agenda.find(e => (e.interaction as Json | undefined)?.interactionId === decodeURIComponent(m![2]) && e.status === 'open')
        if (!target) continue
        Object.assign(target, { status: 'done', resolvedBy: { kind: 'answer', at: new Date().toISOString() }, updatedAt: new Date().toISOString(), question: { ...(target.question as Json), status: 'answered', canRespond: false } })
        delete target.blocking
        this.changed(projectId, ['agenda'])
        return {}
      }
      return undefined
    }
    if (method === 'POST' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/mind\/agenda\/([^/]+)\/answer$/))) {
      if (this.off) throw new ApiError('mock: 未实现', 404)
      const projectId = decodeURIComponent(m[1]), target = (this.mind(projectId).agenda as unknown as Json[]).find(e => e.id === decodeURIComponent(m![2]))
      if (!target) throw new ApiError('条目不存在', 404)
      if (target.status !== 'open') throw new ApiError('这一项已经结束', 409)
      if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError('请求只能包含 text（1–4000 字）', 400)
      Object.assign(target, { status: 'done', answer: body.text.trim(), resolvedBy: { kind: 'answer', at: new Date().toISOString() }, updatedAt: new Date().toISOString() })
      delete target.blocking
      this.changed(projectId, ['agenda'])
      return { entry: clone(target) }
    }
    if (!(m = p.match(/^\/api\/v2\/projects\/([^/]+)\/(mind|metrics)(?:\/([^/]+)\/([^/]+))?$/))) return undefined
    if (this.off) throw new ApiError('mock: 未实现', 404)
    const projectId = decodeURIComponent(m[1])
    if (m[2] === 'metrics' && method === 'GET') {
      this.mind(projectId)
      const window = url.searchParams.get('window') ?? '7d'
      if (!['1d', '7d', '30d', 'all'].includes(window)) throw new ApiError('window must be 1d, 7d, 30d or all', 400, 'metrics_window_invalid')
      return fx.metrics(projectId, window)
    }
    if (m[2] !== 'mind') return undefined
    if (!m[3] && method === 'GET') return clone(this.mind(projectId))
    const collection = m[3] as MindCollection
    if (!COLLECTIONS.includes(collection)) throw new ApiError('未知的心智类别', 404)
    const id = decodeURIComponent(m[4])
    const mind = this.mind(projectId)
    const list = collection === 'notes' ? null : (mind[collection] as unknown as Json[])
    const noteList = collection === 'notes' ? (mind.notes.facts.some(n => n.id === id) ? mind.notes.facts : mind.notes.preferences) : null
    const target = (list ?? (noteList as unknown as Json[])).find(e => e.id === id)
    // The plan is the agenda's todo items on the host; the mock's plan lives on the project summary.
    if (!target && collection === 'agenda' && method === 'PATCH') {
      const entry = this.planStatus(projectId, id, String(body.status ?? ''))
      if (entry) return { entry, collection, revision: mind.revision ?? 0 }
    }
    if (!target) throw new ApiError('条目不存在', 404, 'mind_entry_not_found')
    if (method === 'DELETE') {
      const from = list ?? (noteList as unknown as Json[])
      from.splice(from.indexOf(target), 1)
      this.changed(projectId, [collection])
      return { ok: true }
    }
    if (method !== 'PATCH') return undefined
    if (body.status !== undefined && !STATUS[collection]?.includes(String(body.status))) throw new ApiError('status 无效', 400)
    if (body.text !== undefined && !String(body.text).trim()) throw new ApiError('内容不能为空', 400)
    for (const key of ['status', 'text', 'until', 'reason', 'request', 'title']) if (body[key] !== undefined) target[key] = body[key]
    if (collection === 'commitments' && body.status === 'resolved') target.resolvedBy = 'user'
    target.updatedAt = new Date().toISOString()
    this.changed(projectId, [collection])
    return { entry: clone(target) }
  }

  /** A plan line marked done or dropped leaves doing / next (done ones go to the top of done); `open` puts it back where it was. */
  private planStatus(projectId: string, entryId: string, status: string): Json | undefined {
    const plan = this.host.detail(projectId)?.plan as ProjectPlan | undefined
    if (!plan || !STATUS.agenda.includes(status)) return undefined
    const key = `${projectId}:${entryId}`, at = new Date().toISOString()
    const lists = ['doing', 'next', 'done'] as const
    const found = lists.map(list => ({ list, row: plan[list].find(row => row.id === entryId) })).find(hit => hit.row)
    if (status === 'open') {
      const back = this.parked.get(key) ?? (found && found.list === 'done' ? { row: found.row!, stage: 'next' as const } : undefined)
      if (!back) return found ? { id: entryId, kind: 'todo', status: 'open', updatedAt: at } : undefined
      for (const list of lists) plan[list] = plan[list].filter(row => row.id !== entryId)
      plan[back.stage].push({ ...back.row, status: back.stage, updatedAt: at })
      this.parked.delete(key)
    } else if (found && found.list !== 'done') {
      plan[found.list] = plan[found.list].filter(row => row.id !== entryId)
      this.parked.set(key, { row: found.row!, stage: found.list })
      if (status === 'done') plan.done.unshift({ ...found.row!, status: 'done', updatedAt: at })
    } else if (!found) return undefined
    this.host.touch(projectId)
    return { id: entryId, kind: 'todo', status, updatedAt: at, resolvedBy: status === 'open' ? null : { kind: 'user', at } }
  }

  private feedback(sessionId: string, itemId: string, body: Json) {
    const found = this.host.item(sessionId, itemId)
    if (!found) throw new ApiError('条目不存在', 404)
    if (found.item.kind !== 'assistant') throw new ApiError('只能评价助手消息', 400)
    const vote: 'up' | 'down' | null = body.vote === 'up' || body.vote === 'down' ? body.vote : null
    const previous = found.item.feedback?.vote ?? null
    const feedback = { vote, comment: typeof body.comment === 'string' ? body.comment : (vote === 'down' ? found.item.feedback?.comment ?? null : null), at: new Date().toISOString() }
    found.commit({ ...found.item, feedback })
    // Votes on a proactive message count toward its thread.
    for (const detail of ['p-ink', 'p-agent'].map(id => this.host.detail(id))) {
      const thread = (detail?.mind as ProjectMind | undefined)?.threads.find(t => t.messageItemIds.includes(itemId))
      if (!thread) continue
      const r = (thread.reactions ??= {})
      if (previous) r[previous] = Math.max(0, (r[previous] ?? 0) - 1)
      if (vote) r[vote] = (r[vote] ?? 0) + 1
    }
    return { feedback }
  }
}
