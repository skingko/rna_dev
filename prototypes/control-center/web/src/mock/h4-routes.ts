/**
 * Mock routes for H4: session cleanup receipts (+ retry), memory sync status,
 * inbox entry lookup / item position (deep links), system proposal list, the
 * evaluation-standard revision (preview → paired re-evaluation, adoption),
 * and project overview facts/commitments. Checked before the project routes.
 */
import { ApiError } from '@/api/transport'
import type { InboxEntry } from '@/api/communication-api'
import type { Session } from '@/api/types'
import { ago } from './fixtures'

type Json = Record<string, unknown>
const clone = <T,>(v: T): T => structuredClone(v)
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

export interface H4Host {
  detail(id: string): Json | undefined
  sessions(): Session[]
  touch(id: string): void
}

export class H4Store {
  deletions: Json[] = [
    { sessionId: '5f0c2a9e-mock', projectId: 'p-ink', status: 'pending', localStatus: 'completed', remoteStatus: 'pending', createdAt: ago(2 * HOUR), updatedAt: ago(20 * MIN), completedAt: null, code: 'MEMORY_SERVICE_UNAVAILABLE', retryAt: ago(-10 * MIN), attempts: 3 },
    { sessionId: 'a81d7c33-mock', projectId: 'p-agent', status: 'recovery_review', localStatus: 'pending', remoteStatus: 'not_required', createdAt: ago(DAY), updatedAt: ago(DAY), completedAt: null, code: 'RESTORE_REVIEW_REQUIRED', retryAt: null, attempts: 1 },
    { sessionId: 'c3e9b120-mock', projectId: 'p-ink', status: 'blocked', localStatus: 'pending', remoteStatus: 'not_required', createdAt: ago(3 * HOUR), updatedAt: ago(HOUR), completedAt: null, code: 'SESSION_EVIDENCE_JOURNAL_UNKNOWN', retryAt: null, attempts: 2, decision: 'damaged', choice: 'remove_entry', notice: null },
  ]
  proposals: Json[] = [
    { schemaVersion: 1, id: 'sys-mock2', createdAt: ago(3 * HOUR), status: 'proposed', autoAdopt: false, adoption: 'manual_review_required', target: { component: 'core_tool_description', key: 'core_tool_description:workspace_edit', hypothesis: '工具「workspace_edit」的描述未能让模型正确调用；更清晰的参数与失败处理说明会减少失败。', evidence: { failures: 5, projects: 2 } }, note: '先看参数示例是否足够', evidence: { signalKinds: { tool_failure: 5 }, projects: 2 } },
    { schemaVersion: 1, id: 'sys-mock1', createdAt: ago(2 * DAY), status: 'proposed', autoAdopt: false, adoption: 'manual_review_required', target: null, note: '手动记录：主动消息偏长', evidence: { signalKinds: { proactive_outcome: 4 }, projects: 1 } },
  ]

  constructor(private host: H4Host) {
    const ink = host.detail('p-ink')
    if (ink) {
      Object.assign(ink, {
        overview: '一款 Three.js 水墨风休闲游戏：玩家控制飞鸟在芦苇间跳跃。当前阶段聚焦移动端可读性与低端机帧率。',
        facts: [
          { id: 'f1', text: '目标设备包含 iPhone 12 与 Redmi 9；低端机需保持 45fps 以上。', source: 'conversation', simulated: false, createdAt: ago(3 * DAY) },
          { id: 'f2', text: 'HUD 使用印章风格分数，必须在芦苇前景之上可读。', source: 'conversation', simulated: false, createdAt: ago(DAY) },
          { id: 'f3', text: '项目采用 Vite + Three.js，构建产物部署到静态托管。', source: 'model-project-initialization', simulated: false, createdAt: ago(9 * DAY) },
          { id: 'f4', text: '用户偏好先给结论，再展开依据。', source: 'user-observation', simulated: false, createdAt: ago(4 * DAY) },
        ],
        commitments: [{ id: 'c1', text: '每天 18:00 发送回归测试检查点。' }, { id: 'c2', text: '下次调整芦苇材质时，先在 Redmi 9 上复测帧率。' }],
        initialization: { status: 'ready', attempt: 1, maxAttempts: 4 },
        memorySummary: { status: 'completed', updatedAt: ago(30 * MIN), completedAt: ago(30 * MIN) },
      })
      const versions = ink.versions as Json[]
      const v13 = versions.find(v => v.id === 'v13')
      if (v13) (v13.assessment as Json).candidateRetained = true
      const suite = ((versions.find(v => v.id === 'v11')?.bundle as Json)?.genome as Json)?.evaluationSuite
      versions.push({
        id: 'v17', version: 'candidate-17', title: '修订评估标准后重评：HUD 可读性用例改为以真实遮挡截图为准', state: 'rejected', parentVersionId: 'v11', createdAt: ago(40 * MIN), simulated: false, source: 'reviewed-evaluation-revision', retryOfVersionId: 'v13',
        evaluationRevision: { schemaVersion: 1, revisionHash: 'b7f3c1d2e4a5968778695a4b3c2d1e0f11223344556677889900aabbccddeeff', reason: '原用例把 HUD 分数的像素位置写死，与真实遮挡场景不一致。', suite: clone(suite) },
        evaluation: { gatePassed: false, baselineScore: 0.80, candidateScore: 0.83, cases: 5, simulated: false, evaluationComplete: true },
        assessment: { label: '效果门槛未达到', summary: '在修订后的标准下重新配对评估；候选提升未达到门槛。', stage: 'completed', standardAdoption: { available: true } },
      })
    }
  }

  handle(method: string, url: URL, body: Json): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'GET' && p === '/api/v2/session-deletions') return { revision: Date.now(), deletions: clone(this.deletions) }
    if (method === 'POST' && (m = p.match(/^\/api\/session-deletions\/([^/]+)\/retry$/))) {
      const row = this.deletions.find(r => r.sessionId === decodeURIComponent(m![1]))
      if (!row) throw new ApiError('清理记录不存在', 404)
      row.attempts = Number(row.attempts) + 1
      row.updatedAt = new Date().toISOString()
      if (row.status === 'pending' && Number(row.attempts) >= 5) Object.assign(row, { status: 'completed', remoteStatus: 'completed', completedAt: row.updatedAt, code: null })
      return { sessionId: row.sessionId, cleanup: { status: row.status, localStatus: row.localStatus, remoteStatus: row.remoteStatus, code: row.code, retryAt: row.retryAt } }
    }
    if (method === 'POST' && (m = p.match(/^\/api\/session-deletions\/([^/]+)\/decide$/))) {
      const row = this.deletions.find(r => r.sessionId === decodeURIComponent(m![1]))
      if (!row) throw new ApiError('清理记录不存在', 404)
      if (row.status !== 'blocked' || !row.choice || (body as { choice?: unknown } | null)?.choice !== row.choice) throw new ApiError('这项清理现在不需要这个决定，请刷新后再看。', 409)
      const at = new Date().toISOString()
      Object.assign(row, { status: 'completed', localStatus: 'completed', remoteStatus: row.choice === 'keep_remote' ? 'kept_by_user' : row.remoteStatus === 'pending' ? 'completed' : row.remoteStatus, completedAt: at, updatedAt: at, code: null, decision: undefined, choice: undefined, notice: undefined })
      return { sessionId: row.sessionId, cleanup: { status: row.status, localStatus: row.localStatus, remoteStatus: row.remoteStatus, code: row.code, retryAt: row.retryAt } }
    }
    if (method === 'GET' && (m = p.match(/^\/api\/projects\/([^/]+)\/preview\/discovery$/))) {
      const runnable = decodeURIComponent(m[1]) === 'p-ink'
      return runnable
        ? { status: 'found', preferred: 'static:index.html', candidates: [{ id: 'static:index.html', mode: 'static', path: 'index.html', label: 'index.html', available: true }] }
        : { status: 'none', preferred: null, candidates: [], reason: 'no_entry' }
    }
    if (method === 'GET' && p === '/api/v2/evolution/system/proposals') return { total: this.proposals.length, proposals: clone(this.proposals), autoAdopt: false }
    if (method === 'POST' && p === '/api/v2/evolution/system/proposals') return undefined // p34 records it; list reads include new ones via `record()`
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/memory-sync$/))) return this.memorySync(decodeURIComponent(m[1]))
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/projects\/([^/]+)\/inbox\/([^/]+)$/)) && m[2] !== 'read-all') return this.inboxEntry(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (method === 'GET' && (m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/items\/([^/]+)$/))) return this.item(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (method === 'POST' && (m = p.match(/^\/api\/projects\/([^/]+)\/evolution$/)) && (body.evaluationRevision || body.action === 'adopt-evaluation-standard')) return this.revision(decodeURIComponent(m[1]), body)
    return undefined
  }

  /** Remember a proposal created through the P3/P4 mock so the list shows it. */
  record(proposal: Json) { this.proposals.unshift(clone(proposal)) }

  private memorySync(projectId: string) {
    if (!this.host.detail(projectId)) throw new ApiError('项目不存在', 404)
    const sessions = this.host.sessions().filter(s => s.projectId === projectId)
    const rich = projectId === 'p-ink'
    const rows = sessions.map((s, i) => {
      const attention = rich && i === 1 ? 1 : 0, pending = rich && i === 0 ? 2 : 0
      return {
        sessionId: s.id, title: s.title, archivedAt: s.archivedAt ?? null, status: attention ? 'attention' : pending ? 'syncing' : 'synced',
        turns: 6 + i * 3, completedTurns: 5 + i * 2, writes: 9 + i * 3, incremental: 3 + i, pending, attention, retained: rich && i === 0 ? 1 : 0,
        evidence: { records: 2, completed: 2 - attention, extracted: 4 + i, indexed: 1, indexPending: pending ? 1 : 0, indexIssues: 0, initializedAt: ago(5 * DAY) },
        lastSuccessAt: ago((i + 1) * 25 * MIN),
        issues: attention ? [{ turnId: 't-mock', status: 'uncertain', code: 'MEMORY_COMMIT_UNCONFIRMED', upstreamStatus: 504, updatedAt: ago(2 * HOUR) }] : [],
      }
    })
    const sum = (key: 'completedTurns' | 'incremental' | 'pending' | 'attention' | 'retained') => rows.reduce((n, r) => n + r[key], 0)
    const attention = sum('attention'), pending = sum('pending')
    return {
      projectId, status: attention ? 'attention' : pending ? 'syncing' : rows.length ? 'synced' : 'none', health: attention ? 'degraded' : rows.length ? 'healthy' : 'not_observed',
      completedTurns: sum('completedTurns'), incremental: sum('incremental'), pending, attention, retained: sum('retained'),
      evidence: { records: rows.length * 2, completed: rows.reduce((n, r) => n + r.evidence.completed, 0), extracted: rows.reduce((n, r) => n + r.evidence.extracted, 0), indexed: rows.length, indexPending: pending ? 1 : 0, indexIssues: 0 },
      counts: { pending, inFlight: 0, polling: 0, completed: sum('completedTurns'), retained: sum('retained'), skipped: 0, failed: 0, uncertain: attention, retrying: 0 },
      lastSuccessAt: rows[0]?.lastSuccessAt ?? null, summary: rich ? { status: 'completed', updatedAt: ago(30 * MIN), completedAt: ago(30 * MIN), code: null } : null,
      sessions: rows.sort((a, b) => b.attention - a.attention || b.pending - a.pending), revision: Date.now(),
    }
  }

  private inboxEntry(projectId: string, entryId: string) {
    const d = this.host.detail(projectId)
    if (!d) throw new ApiError('项目不存在', 404)
    const entry = ((d.inbox as InboxEntry[] | undefined) ?? []).find(e => e.id === entryId && !e.contextRevoked)
    if (!entry) throw new ApiError('收件箱中没有这条消息', 404)
    const locate = (sessionId: string | null | undefined, match: (item: Json) => boolean, kind: string) => {
      const s = sessionId ? this.host.sessions().find(x => x.id === sessionId && x.projectId === projectId) : undefined
      const index = s ? s.items.findIndex(i => match(i as unknown as Json)) : -1
      if (!s || index < 0) return null
      const item = s.items[index]
      return { kind, sessionId: s.id, itemId: item.id, turnId: item.turnId ?? null, index, count: s.items.length, sessionArchived: Boolean(s.archivedAt) }
    }
    const location = (entry.itemId && locate(entry.sessionId, i => i.id === entry.itemId, 'message'))
      || (entry.interactionId && locate(entry.sessionId, i => (i.interaction as Json | undefined)?.id === entry.interactionId, 'question'))
      || (entry.digestItemId && locate(entry.digestSessionId ?? entry.sessionId, i => i.id === entry.digestItemId, 'digest'))
      || null
    const digest = entry.digestItemId ? { itemId: entry.digestItemId, sessionId: entry.sessionId ?? null, entryIds: ((d.inbox as InboxEntry[]) ?? []).filter(e => e.digestItemId === entry.digestItemId).map(e => e.id) } : null
    return { projectId, entry: clone(entry), location, digest, now: new Date().toISOString(), revision: Date.now() }
  }

  private item(sessionId: string, itemId: string) {
    const s = this.host.sessions().find(x => x.id === sessionId)
    if (!s) throw new ApiError('会话不存在', 404)
    const index = s.items.findIndex(i => i.id === itemId)
    if (index < 0) throw new ApiError('条目不存在', 404)
    const item = s.items[index]
    const inbox = ((this.host.detail(s.projectId ?? '')?.inbox as InboxEntry[] | undefined) ?? [])
    const digestIds = item.initiative?.kind === 'digest' ? item.initiative.entryIds ?? [] : []
    const linked = inbox.filter(e => digestIds.includes(e.id) || e.digestItemId === item.id || (e.sessionId === s.id && e.itemId === item.id))
    return {
      revision: Date.now(), sessionId, item: clone(item), position: { index, count: s.items.length, turnId: item.turnId ?? null },
      inboxEntries: linked.map(e => ({ id: e.id, kind: e.kind, tier: e.tier, status: e.status, relation: digestIds.includes(e.id) || e.digestItemId === item.id ? 'digest' : 'message', createdAt: e.createdAt })),
      ...(digestIds.length ? { digest: { entryIds: [...digestIds] } } : {}),
    }
  }

  private revision(projectId: string, body: Json) {
    const d = this.host.detail(projectId)
    if (!d) throw new ApiError('项目不存在', 404)
    const versions = d.versions as Json[]
    if (body.action === 'adopt-evaluation-standard') {
      const review = versions.find(v => v.id === body.reviewVersionId)
      if (!review) throw new ApiError('版本不存在', 404)
      const baseline = versions.find(v => v.id === d.activeVersionId)
      const id = `v-std-${Math.random().toString(36).slice(2, 6)}`
      versions.push({ ...clone(baseline ?? {}), id, version: `${Number((baseline?.version as number) ?? 0) + 1}`, title: '采用修订后的评估标准', state: 'baseline', source: 'adopted-evaluation-standard', parentVersionId: baseline?.id ?? null, createdAt: new Date().toISOString(), standardRevision: { reviewVersionId: review.id, revisionHash: body.revisionHash } })
      this.host.touch(projectId)
      return { status: 'adopted', versionId: id }
    }
    const revision = body.evaluationRevision as { reason?: string; suite?: Json; sourceSuiteHash?: string }
    if (!revision?.reason || !revision.suite) throw new ApiError('修订理由与评估套件都不能为空。', 400)
    if (JSON.stringify(revision.suite).includes('minImprovement":0')) throw new ApiError('分数门槛不能在此降低。', 400)
    const source = versions.find(v => v.id === body.retryVersionId)
    if (body.preview) {
      const before = (((versions.find(v => v.id === d.activeVersionId)?.bundle as Json)?.genome as Json)?.evaluationSuite ?? {}) as Json
      const changes = Object.keys({ ...before, ...revision.suite }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(revision.suite![k])).map(k => ({ path: `/${k}`, before: before[k] ?? null, after: revision.suite![k] ?? null }))
      return { status: 'preview', baseVersionId: d.activeVersionId, revision: { revisionHash: `mock-${Math.random().toString(16).slice(2, 10)}${'0'.repeat(48)}`, sourceSuiteHash: revision.sourceSuiteHash }, changes }
    }
    versions.push({ id: `v-rev-${Math.random().toString(36).slice(2, 6)}`, version: `candidate-${versions.length + 1}`, title: `按修订标准重评：${String(source?.title ?? '')}`, state: 'evaluating', parentVersionId: body.baseVersionId, retryOfVersionId: source?.id, source: 'reviewed-evaluation-revision', createdAt: new Date().toISOString(), simulated: false, evaluationRevision: { schemaVersion: 1, revisionHash: body.reviewedRevisionHash, reason: revision.reason, suite: revision.suite } })
    this.host.touch(projectId)
    return { status: 'scheduled' }
  }
}
