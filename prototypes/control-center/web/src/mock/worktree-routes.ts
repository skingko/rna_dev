/**
 * Worktree isolation in the mock (?mock=1; contract v2 §8.6–8.8, worktree design §11): every `worktreeApi` route.
 * As the host answers until its release gate opens, isolation is off (`not_ready`); `?isolation=on` (or `enabled`
 * in tests) turns it on for the git project `p-agent`, which then holds a kept conversation worktree, one found
 * without a record, and a few apply records (a background apply, a worker merge, a rollback). A conversation
 * created with `worktree: true` gets its own worktree, and the scripted turn applies to the project folder at its
 * end; a direct-mode turn in `p-agent` leaves a checkpoint. Writes are two steps, with one-time tokens that expire
 * after two minutes, as the host's. Plain folders (every other project) answer `no_repository` and can be
 * initialised (`git/init`): the preview lists files and the `.gitignore` lines, the confirmation makes the folder
 * a repository in the mock git store.
 */
import { ApiError } from '@/api/transport'
import type { ConflictPath, ProjectSummary, Session, SubagentInfo, TurnApply } from '@/api/types'
import type { ApplyDetail, ApplyFile, ApplyRecord, GitInitLine, GitInitPreview, RnaWorktree, RollbackPreview } from '@/api/worktree-api'
import type { GitDiff } from '@/api/git-api'

const REPO = 'p-agent'
const ROOT = '/Users/me/Documents/独立开发项目/Pi_agent'
const TOKEN_MS = 120_000
const INIT_TOKEN_MS = 30 * 60_000
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const id8 = () => Math.random().toString(16).slice(2, 10)
const token = () => Array.from({ length: 4 }, id8).join('')

export interface WorktreeMockHost {
  projects: () => ProjectSummary[]
  session: (id: string) => Session | undefined
  /** A subagent's card changed. */
  upsertAgent: (sessionId: string, agentId: string, patch: Partial<SubagentInfo>) => SubagentInfo | null
  /** The mock git store makes this folder a repository. */
  gitInit: (projectId: string) => void
  isRepository: (projectId: string) => boolean
  /** Push a project's summary (git settings changed). */
  touchProject: (projectId: string) => void
  /** The conversation a turn belongs to (the host finds it for a direct-mode turn's rollback record). */
  sessionOfTurn?: (turnId: string) => string | undefined
}

type Plan = { kind: 'rollback' | 'turn' | 'worktree-apply' | 'worktree-discard' | 'agent-drop' | 'init'; key: string; files: { path: string; action: string }[]; skipped?: { path: string; reason: string }[]; expires: number }

const record = (row: Omit<ApplyRecord, 'rollback'> & Partial<Pick<ApplyRecord, 'rollback'>>): ApplyRecord => ({ rollback: { available: true }, ...row })

export class WorktreeMockStore {
  /** Isolation conditions hold for `p-agent` (else the host's release gate: `not_ready`). */
  enabled: boolean
  readonly worktrees: RnaWorktree[] = []
  readonly applies: ApplyRecord[] = []
  private readonly details = new Map<string, ApplyFile[]>()
  private readonly plans = new Map<string, Plan>()

  constructor(private host: WorktreeMockHost, { enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('isolation') === 'on' }: { enabled?: boolean } = {}) {
    this.enabled = enabled
    if (enabled) this.seed()
  }

  /** The fixture rows of an isolated `p-agent`. */
  private seed() {
    this.worktrees.push(
      { id: 'wt-kept01', kind: 'session', owner: { sessionId: 's-plan' }, path: `${ROOT}/.rna/worktrees.nosync/s-kept01`, state: 'kept', createdAt: ago(3 * 24 * 60 * MIN), sizeBytes: 48_200_000, pending: { files: 3 } },
      { id: 'wt-orphan', kind: 'orphan', owner: {}, path: `${ROOT}/.rna/worktrees.nosync/w-7f3a91c2`, state: 'active', createdAt: ago(26 * 60 * MIN), pending: { files: 1 } },
    )
    this.add(record({ id: 'ap-bg-1', kind: 'background', target: 'project', source: { actionId: 'act-bg-2', worktreeId: 'wt-b-1' }, state: 'verified', files: 2, added: 1, removed: 0, bothChanged: 0, sample: ['docs/specs/stream-protocol-v2.md', 'docs/notes/isolation.md'], at: ago(2 * 60 * MIN) }),
      [{ path: 'docs/specs/stream-protocol-v2.md', status: 'M', added: 12, removed: 2 }, { path: 'docs/notes/isolation.md', status: 'A', added: 30, removed: 0 }])
    this.add(record({ id: 'ap-worker-1', kind: 'worker', target: 'project', source: { sessionId: 's-plan', agentId: 'ag-worker-1', worktreeId: 'wt-w-1' }, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 1, sample: ['prototypes/control-center/web/src/lib/phases.ts'], at: ago(80 * MIN) }),
      [{ path: 'prototypes/control-center/web/src/lib/phases.ts', status: 'M', added: 3, removed: 1 }])
    this.add(record({ id: 'ap-rb-1', kind: 'rollback', target: 'project', source: { sessionId: 's-plan' }, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['README.md'], at: ago(40 * MIN), undoes: 'ap-old-1' }),
      [{ path: 'README.md', status: 'M', added: 1, removed: 4 }])
    this.add(record({ id: 'ap-old-1', kind: 'turn', target: 'project', source: { sessionId: 's-plan', turnId: 't-old' }, state: 'rolled_back', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['README.md'], at: ago(45 * MIN), rolledBackBy: 'ap-rb-1', rollback: { available: false, reason: 'rolled_back' } }),
      [{ path: 'README.md', status: 'M', added: 4, removed: 1 }])
  }

  private add(row: ApplyRecord, files: ApplyFile[]) {
    this.applies.unshift(row)
    this.details.set(row.id, files)
  }

  /** Isolation for a project, as `GET …/worktrees` answers it. */
  isolation(projectId: string) {
    if (!this.enabled) return { enabled: false, reason: 'not_ready', git: '2.39.5' }
    if (projectId !== REPO || !this.host.isRepository(projectId)) return { enabled: false, reason: 'no_repository', git: '2.39.5' }
    return { enabled: true, git: '2.39.5' }
  }

  /** `POST /api/sessions` with `worktree: true`: the session's worktree record (made at its first turn). */
  createSession(session: Session) {
    const isolation = this.isolation(session.projectId ?? '')
    if (!isolation.enabled) throw new ApiError('这个项目现在不能使用独立工作树。', 409, 'worktree_unavailable', { reason: isolation.reason }) // i18n-ignore: mock host text
    const id = `wt-${id8()}`
    session.worktree = { id, state: 'pending' }
    return session.worktree
  }

  /** The first turn's preparing_workspace: the worktree exists now. */
  activate(session: Session) {
    if (!session.worktree || session.worktree.state !== 'pending') return false
    session.worktree = { ...session.worktree, state: 'active' }
    this.worktrees.unshift({ id: session.worktree.id, kind: 'session', owner: { sessionId: session.id }, path: `${ROOT}/.rna/worktrees.nosync/s-${session.id.replace(/^s-/, '').slice(0, 8)}`, state: 'active', createdAt: new Date().toISOString(), pending: { files: 0 } })
    return true
  }

  /**
   * A worktree conversation's turn applied at its end (`turn.apply`). As the host's, the turn also has records of
   * writes into its own worktree (the turn-start sync from the project folder, the merge back after the apply):
   * target `session:<id>`, kept for crash recovery only, never rolled back.
   */
  applyTurn(session: Session, turnId: string, paths: string[]): TurnApply {
    const source = { sessionId: session.id, turnId, worktreeId: session.worktree?.id }
    const sync = record({ id: `ap-${id8()}`, kind: 'turn', target: `session:${session.id}`, source, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: ['README.md'], at: new Date(Date.now() - 2000).toISOString(), rollback: { available: false, reason: 'target' } })
    this.add(sync, [{ path: 'README.md', status: 'M', added: 1, removed: 1 }])
    const row = record({ id: `ap-${id8()}`, kind: 'turn', target: 'project', source, state: 'verified', files: paths.length, added: 0, removed: 0, bothChanged: 0, sample: paths.slice(0, 20), at: new Date().toISOString() })
    this.add(row, paths.map(path => ({ path, status: 'M', added: 3, removed: 1 })))
    return { status: 'applied', applyIds: [row.id], bothChanged: 0 }
  }

  /** A direct-mode turn of a repository leaves a checkpoint. */
  checkpoint(turnId: string) { return { ref: `refs/rna/turn/${turnId}`, state: 'taken' as const } }

  /** The host binds a rollback token to the `paths` it was asked with (sorted; null when none). */
  private static scope(key: string, paths: unknown) { return `${key}|${JSON.stringify(Array.isArray(paths) ? [...new Set(paths as string[])].sort() : null)}` }
  private plan(kind: Plan['kind'], key: string, files: Plan['files'], skipped: Plan['skipped'] = [], ms = TOKEN_MS) {
    const confirm = token()
    this.plans.set(confirm, { kind, key, files, skipped, expires: Date.now() + ms })
    return { confirm, expiresAt: new Date(Date.now() + ms).toISOString() }
  }
  private take(confirm: unknown, kind: Plan['kind'], key: string, code: string): Plan {
    const plan = typeof confirm === 'string' ? this.plans.get(confirm) : undefined
    if (typeof confirm === 'string') this.plans.delete(confirm)
    if (!plan || plan.kind !== kind || plan.key !== key || plan.expires < Date.now()) throw new ApiError('这次确认已经失效，请重新点一次。', 409, code) // i18n-ignore: mock host text
    return plan
  }
  private writable(projectId: string) {
    const project = this.host.projects().find(row => row.id === projectId)
    if (!project) throw new ApiError('项目不存在', 404) // i18n-ignore: mock host text
    if (project.permissions?.workspace === 'read') throw new ApiError('项目是只读的。', 403, 'git_read_only') // i18n-ignore: mock host text
  }
  private view(row: ApplyRecord): ApplyRecord {
    const available = row.target === 'project' && row.state !== 'rolled_back' && row.state !== 'expired' && row.state !== 'interrupted'
    return { ...clone(row), rollback: available ? { available: true } : { available: false, reason: row.state === 'expired' ? 'expired' : row.state === 'rolled_back' ? 'rolled_back' : row.state === 'interrupted' ? 'interrupted' : 'target' } }
  }
  private apply(projectId: string, applyId: string) {
    const row = this.applies.find(item => item.id === decodeURIComponent(applyId))
    if (!row || projectId !== REPO) throw new ApiError('应用记录不存在。', 404, 'apply_not_found') // i18n-ignore: mock host text
    return row
  }
  /** A rollback of `rows` (newest first): a new `rollback` record per row, each marking what it undid. */
  private rollback(rows: ApplyRecord[], session?: string, turnId?: string) {
    const restored: string[] = []
    let last = ''
    for (const row of rows) {
      const files = this.details.get(row.id) ?? []
      // A whole turn's rollback names it (`undoesTurn`), as the host's; one record's rollback carries only `undoes`.
      const undo = Object.assign(record({ id: `ap-${id8()}`, kind: 'rollback', target: 'project', source: { ...(session ? { sessionId: session } : row.source.sessionId ? { sessionId: row.source.sessionId } : {}), ...(turnId ?? row.source.turnId ? { turnId: turnId ?? row.source.turnId } : {}) }, state: 'verified', files: files.length, added: 0, removed: 0, bothChanged: 0, sample: files.map(file => file.path).slice(0, 20), at: new Date().toISOString(), undoes: row.id }), turnId ? { undoesTurn: turnId } : {})
      this.add(undo, files.map(file => ({ ...file, added: file.removed, removed: file.added })))
      row.state = 'rolled_back'; row.rolledBackBy = undo.id
      // Undoing a rollback brings back what it had rolled back (as the host's).
      if (row.kind === 'rollback') for (const original of this.applies) if (original.rolledBackBy === row.id) { original.rolledBackBy = null; original.state = 'verified' }
      restored.push(...files.map(file => file.path))
      last = undo.id
    }
    return { applyId: last, restored, skipped: [], verify: 'verified' as const }
  }

  /** The mock's answer, or undefined when the route is not one of these. */
  handle(method: string, url: URL, body: Record<string, unknown>): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/worktrees$/)) && method === 'GET') {
      const projectId = decodeURIComponent(m[1])
      return { isolation: this.isolation(projectId), worktrees: projectId === REPO ? clone(this.worktrees) : [] }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/worktrees\/([^/]+)\/(apply|discard)$/)) && method === 'POST') {
      const projectId = decodeURIComponent(m[1]), wtId = decodeURIComponent(m[2]), action = m[3] as 'apply' | 'discard'
      this.writable(projectId)
      const row = this.worktrees.find(item => item.id === wtId)
      if (!row) throw new ApiError('工作树不存在。', 404, 'worktree_not_found') // i18n-ignore: mock host text
      if (!(row.kind === 'orphan' || row.state === 'kept' || row.state === 'conflicted')) throw new ApiError('这个工作树还在使用中。', 409, 'worktree_active') // i18n-ignore: mock host text
      const kind = action === 'apply' ? 'worktree-apply' : 'worktree-discard'
      if (typeof body.confirm !== 'string') {
        const files = Array.from({ length: row.pending.files }, (_, i) => ({ path: `src/kept-${i + 1}.ts`, action: action === 'apply' ? 'modify' : 'delete' }))
        const conflicts: ConflictPath[] = action === 'apply' && row.state === 'conflicted' ? [{ path: 'src/conflict.ts', kind: 'content' }] : []
        // B8: secret files the owner changed are never applied; a discard lists them with the rest. The host's note.
        const secret = Array.from({ length: row.pending.secret ?? 0 }, (_, i) => (i ? `config/${i}.env` : '.env'))
        if (action === 'discard') files.push(...secret.map(path => ({ path, action: 'modify' })))
        const note = secret.length ? (action === 'apply' ? `这些文件存放密钥，Rna 从不把它们应用到项目文件夹：${secret.join('、')}。` : `这些文件存放密钥，不在任何检查点里：丢弃时它们移到项目文件夹的 .rna/trash.nosync，保留 7 天：${secret.join('、')}。`) : '' // i18n-ignore: mock host text
        return { ...this.plan(kind, wtId, files), files, ...(conflicts.length ? { conflicts } : {}), ...(secret.length ? { secret, note } : {}) }
      }
      const plan = this.take(body.confirm, kind, wtId, 'worktree_unconfirmed')
      const secret = Array.from({ length: row.pending.secret ?? 0 }, (_, i) => (i ? `config/${i}.env` : '.env'))
      const note = secret.length ? `存放密钥的文件已移到项目文件夹的 .rna/trash.nosync，保留 7 天：${secret.join('、')}。` : '' // i18n-ignore: mock host text
      row.state = 'removed'
      if (action === 'discard') return { worktree: clone(row), ...(secret.length ? { secret, note } : {}) }
      const applied = record({ id: `ap-${id8()}`, kind: 'turn', target: 'project', source: { ...row.owner, worktreeId: row.id }, state: 'verified', files: plan.files.length, added: 0, removed: 0, bothChanged: 0, sample: plan.files.map(file => file.path), at: new Date().toISOString() })
      this.add(applied, plan.files.map(file => ({ path: file.path, status: 'M', added: 2, removed: 1 })))
      return { worktree: clone(row), applyId: applied.id, ...(secret.length ? { secret, note } : {}) }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/applies$/)) && method === 'GET') {
      const projectId = decodeURIComponent(m[1]), sessionId = url.searchParams.get('sessionId'), turnId = url.searchParams.get('turnId')
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const rows = projectId === REPO || this.applies.some(row => row.source.sessionId && this.host.session(row.source.sessionId)?.projectId === projectId)
        ? this.applies.filter(row => (!sessionId || row.source.sessionId === sessionId) && (!turnId || row.source.turnId === turnId) && (projectId === REPO || this.host.session(row.source.sessionId ?? '')?.projectId === projectId))
        : []
      return { applies: rows.slice(0, limit).map(row => this.view(row)) }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/applies\/([^/]+)$/)) && method === 'GET') {
      const row = this.apply(decodeURIComponent(m[1]), m[2])
      return { ...this.view(row), paths: clone(this.details.get(row.id) ?? []) } satisfies ApplyDetail
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/applies\/([^/]+)\/patches$/)) && method === 'GET') {
      const row = this.apply(decodeURIComponent(m[1]), m[2])
      const paths = url.searchParams.getAll('path')
      if (!paths.length || paths.length > 40) throw new ApiError('一次需要 1–40 个文件。', 400, 'git_paths_invalid') // i18n-ignore: mock host text
      const files = this.details.get(row.id) ?? []
      return { patches: paths.map(path => ({ path, diff: files.some(file => file.path === path) ? patchFor(path, row.kind === 'rollback') : { kind: 'unavailable' } as GitDiff })) }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/applies\/([^/]+)\/rollback$/)) && method === 'POST') {
      const projectId = decodeURIComponent(m[1])
      this.writable(projectId)
      const row = this.apply(projectId, m[2])
      if (row.state === 'expired') throw new ApiError('这条记录已过期，不能回退。', 409, 'apply_expired') // i18n-ignore: mock host text
      if (row.state === 'rolled_back') throw new ApiError('这条记录已经回退过。', 409, 'rollback_nothing') // i18n-ignore: mock host text
      const files = (this.details.get(row.id) ?? []).filter(file => !Array.isArray(body.paths) || !(body.paths as string[]).length || (body.paths as string[]).includes(file.path))
      if (typeof body.confirm !== 'string') {
        // The worker merge's file changed since: left alone unless forced.
        const skipped = row.kind === 'worker' ? files.map(file => ({ path: file.path, reason: 'changed_after' })) : []
        const listed = files.filter(file => !skipped.some(item => item.path === file.path)).map(file => ({ path: file.path, action: file.status === 'A' ? 'delete' : file.status === 'D' ? 'recreate' : 'restore' }))
        return { ...this.plan('rollback', WorktreeMockStore.scope(row.id, body.paths), listed, skipped), files: listed, skipped } as RollbackPreview
      }
      const plan = this.take(body.confirm, 'rollback', WorktreeMockStore.scope(row.id, body.paths), 'rollback_unconfirmed')
      const forced = Array.isArray(body.force) ? body.force as string[] : []
      const result = this.rollback([row])
      return { ...result, restored: [...plan.files.map(file => file.path), ...forced], skipped: (plan.skipped ?? []).filter(item => !forced.includes(item.path)) }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/turns\/([^/]+)\/rollback$/)) && method === 'POST') {
      const projectId = decodeURIComponent(m[1]), turnId = decodeURIComponent(m[2])
      this.writable(projectId)
      // As the host's: the turn's own records written into the project folder (not its worktree's).
      const rows = this.applies.filter(row => row.source.turnId === turnId && row.kind === 'turn' && row.target === 'project' && row.state === 'verified')
      const session = [...this.applies, ...rows].find(row => row.source.turnId === turnId)?.source.sessionId ?? this.host.sessionOfTurn?.(turnId)
      // A direct-mode turn: its checkpoint's files (the scripted turn edits one file); another conversation wrote a
      // file at the same time, which cannot be told apart (left alone unless forced).
      const direct = !rows.length
      const wanted = Array.isArray(body.paths) && (body.paths as string[]).length ? body.paths as string[] : null
      const files = direct ? [{ path: 'src/lib/terminal.ts', action: 'restore' }] : rows.flatMap(row => (this.details.get(row.id) ?? []).map(file => ({ path: file.path, action: file.status === 'A' ? 'delete' : 'restore' })))
      const kept = files.filter(file => !wanted || wanted.includes(file.path))
      const skipped = (direct ? [{ path: 'src/lib/shared.ts', reason: 'unattributable' }] : []).filter(row => !wanted || wanted.includes(row.path))
      const key = WorktreeMockStore.scope(turnId, body.paths)
      if (typeof body.confirm !== 'string') {
        if (!kept.length && !skipped.length) throw new ApiError('这一轮没有可以回退的改动。', 409, 'rollback_nothing') // i18n-ignore: mock host text
        return { ...this.plan('turn', key, kept, skipped), files: kept, skipped, ...(direct ? { note: '同一时间在这个文件夹里的其他写入无法区分，可以逐个取消勾选。' } : {}) } as RollbackPreview // i18n-ignore: mock host text
      }
      const plan = this.take(body.confirm, 'turn', key, 'rollback_unconfirmed')
      const forced = (Array.isArray(body.force) ? body.force as string[] : []).filter(path => skipped.some(row => row.path === path))
      if (!direct) return { ...this.rollback([...rows].reverse(), session, turnId), restored: plan.files.map(file => file.path) }
      const restored = [...plan.files.map(file => file.path), ...forced]
      const undo = Object.assign(record({ id: `ap-${id8()}`, kind: 'rollback', target: 'project', source: { ...(session ? { sessionId: session } : {}), turnId }, state: 'verified', files: restored.length, added: 0, removed: 0, bothChanged: 0, sample: restored, at: new Date().toISOString() }), { undoesTurn: turnId })
      this.add(undo, restored.map(path => ({ path, status: 'M', added: 1, removed: 3 })))
      return { applyId: undo.id, restored, skipped: skipped.filter(row => !forced.includes(row.path)), verify: 'verified' }
    }
    if ((m = p.match(/^\/api\/v2\/sessions\/([^/]+)\/agents\/([^/]+)\/merge$/)) && method === 'POST') {
      const sessionId = decodeURIComponent(m[1]), agentId = decodeURIComponent(m[2])
      const session = this.host.session(sessionId)
      if (!session) throw new ApiError('会话不存在', 404) // i18n-ignore: mock host text
      const sub = session.items.find(item => item.subagent?.agentId === agentId)?.subagent
      if (!sub) throw new ApiError('子任务不存在', 404, 'merge_unknown') // i18n-ignore: mock host text
      const action = body.action
      if (action === 'handoff') return { subagent: clone(sub), turnId: `t-${id8()}` }
      if (action === 'merge') {
        const conflicts = sub.merge?.status === 'conflict' ? sub.merge.conflicts ?? [] : []
        const next = this.host.upsertAgent(sessionId, agentId, { merge: conflicts.length ? { ...sub.merge!, status: 'conflict' } : { status: 'merged', files: 2, applyIds: [`ap-${id8()}`] } })
        return { subagent: next, applied: conflicts.length ? [] : ['src/a.ts', 'src/b.ts'], conflicts }
      }
      if (action !== 'drop') throw new ApiError('不认识的动作。', 400) // i18n-ignore: mock host text
      if (typeof body.confirm !== 'string') {
        const files = sub.merge?.status === 'merged' ? Array.from({ length: sub.merge.files ?? 1 }, (_, i) => ({ path: `src/worker-${i + 1}.ts`, action: 'restore' })) : []
        return { ...this.plan('agent-drop', agentId, files), files, skipped: [] }
      }
      this.take(body.confirm, 'agent-drop', agentId, 'rollback_unconfirmed')
      return { subagent: this.host.upsertAgent(sessionId, agentId, { merge: { status: 'dropped' }, worktreeId: null }) }
    }
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/git\/init$/)) && method === 'POST') return this.init(decodeURIComponent(m[1]), body)
    return undefined
  }

  /* --------------------------------------------------------- git init (§8.8) */

  private init(projectId: string, body: Record<string, unknown>): unknown {
    this.writable(projectId)
    const project = this.host.projects().find(row => row.id === projectId)!
    if (this.host.isRepository(projectId)) throw new ApiError('这个文件夹已经是 Git 仓库。', 409, 'git_init_already') // i18n-ignore: mock host text
    const lines: GitInitLine[] = Array.isArray(body.lines)
      ? (body.lines as unknown[]).filter((line): line is string => typeof line === 'string').map(text => DEFAULT_LINES.find(line => line.text === text) ?? { text, rule: 'user' })
      : clone(DEFAULT_LINES)
    if (body.lines !== undefined && !Array.isArray(body.lines)) throw new ApiError('忽略规则的格式不对。', 400, 'git_init_lines_invalid') // i18n-ignore: mock host text
    const ignored = new Set(lines.map(line => line.text))
    // As the host's: edited lines must keep ignoring a nested repository.
    if (!ignored.has('/vendor/three-ext/')) throw new ApiError('「vendor/three-ext」是单独的 Git 仓库，需要在 .gitignore 里保留忽略它的那一行。', 400, 'git_init_lines_invalid') // i18n-ignore: mock host text
    const count = 412 + (ignored.has('build/') ? 0 : 38) + (ignored.has('out/') ? 0 : 12)
    const key = JSON.stringify([projectId, lines.map(line => line.text)])
    if (typeof body.confirm !== 'string') {
      const preview: GitInitPreview = {
        ...this.plan('init', key, [], [], INIT_TOKEN_MS),
        folder: project.workspacePath ?? '', branch: 'main', identity: { name: 'skingko', email: 'skingko@example.com' }, identityRequired: false,
        gitignore: { exists: false, lines: lines.map(line => ({ ...line, ...(line.rule === 'ecosystem' ? { count: line.count ?? 1204, bytes: line.bytes ?? 88_000_000 } : {}) })) },
        files: { count, bytes: 61_400_000, largest: [{ path: 'assets/bgm/theme.ogg', bytes: 9_800_000 }, { path: 'assets/models/bird.glb', bytes: 6_100_000 }, { path: 'docs/screens/hud.png', bytes: 2_400_000 }] },
        largeFiles: [{ path: 'raw/recording.mov', bytes: 412_000_000 }], nested: ['vendor/three-ext/'],
        needsAcknowledge: false, icloud: (project.workspacePath ?? '').includes('/Documents/'), outer: null,
      }
      return preview
    }
    this.take(body.confirm, 'init', key, 'git_init_changed')
    this.host.gitInit(projectId)
    this.host.touchProject(projectId)
    return { commit: id8() + id8() + id8() + id8() + id8(), branch: 'main', files: count, largeFiles: [{ path: 'raw/recording.mov', bytes: 412_000_000 }], status: 'clean' }
  }
}

const DEFAULT_LINES: GitInitLine[] = [
  { text: '.DS_Store', rule: 'always' },
  { text: '.env*', rule: 'always', count: 2, bytes: 640 },
  { text: 'node_modules/', rule: 'always', count: 18_204, bytes: 312_000_000 },
  { text: 'dist/', rule: 'ecosystem', marker: 'package.json', count: 64, bytes: 4_200_000 },
  { text: 'build/', rule: 'ecosystem', marker: 'package.json' },
  { text: 'out/', rule: 'ecosystem', marker: 'package.json' },
  { text: '*.log', rule: 'ecosystem', marker: 'package.json', count: 3, bytes: 12_000 },
  { text: '*.pem', rule: 'secret', count: 1, bytes: 1_700 },
  { text: '/raw/recording.mov', rule: 'large', count: 1, bytes: 412_000_000 },
  { text: '/vendor/three-ext/', rule: 'nested' },
]

/** A small before → after patch of a recorded file (reversed for a rollback). */
function patchFor(path: string, reversed: boolean): GitDiff {
  const [before, after] = reversed ? ['+ 新的一行', '- 旧的一行'] : ['- 旧的一行', '+ 新的一行'] // i18n-ignore: mock file text
  return { kind: 'patch', patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n 第一行\n${before}\n${after}\n 第三行\n` } // i18n-ignore: mock file text
}
