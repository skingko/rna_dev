// @vitest-environment node
/** The mock's isolation routes (?mock=1): every `worktreeApi` route, answered as the host does (protocol §8.6–8.8). */
import { describe, expect, it } from 'vitest'
import type { ProjectSummary, Session } from '@/api/types'
import type { ApplyDetail, ApplyRecord, GitInitPreview, RnaWorktrees, RollbackPreview } from '@/api/worktree-api'
import { WorktreeMockStore, type WorktreeMockHost } from './worktree-routes'

const projects: ProjectSummary[] = [
  { id: 'p-agent', name: 'Rna Agent', workspacePath: '/Users/me/Documents/独立开发项目/Pi_agent', permissions: { workspace: 'execute' } },
  { id: 'p-ink', name: '水墨飞鸟', workspacePath: '/Users/me/Projects/ink-bird', permissions: { workspace: 'write' } },
]
function setup(enabled: boolean) {
  const sessions: Session[] = [{ id: 's-plan', title: 'Plan', projectId: 'p-agent', status: 'idle', items: [{ id: 'sub', kind: 'subagent', text: '', createdAt: '', subagent: { agentId: 'ag-1', role: 'worker', status: 'completed', background: true, merge: { status: 'merged', files: 2, applyIds: ['ap-x'] } } }], turns: [] } as unknown as Session]
  const repos = new Set(['p-agent'])
  const host: WorktreeMockHost = {
    projects: () => projects,
    session: id => sessions.find(s => s.id === id),
    upsertAgent: (sessionId, agentId, patch) => {
      const item = sessions.find(s => s.id === sessionId)?.items.find(i => i.subagent?.agentId === agentId)
      if (!item?.subagent) return null
      item.subagent = { ...item.subagent, ...patch }
      return item.subagent
    },
    gitInit: id => { repos.add(id) },
    isRepository: id => repos.has(id),
    touchProject: () => {},
    sessionOfTurn: turnId => (turnId === 't-direct' ? 's-plan' : undefined),
  }
  const store = new WorktreeMockStore(host, { enabled })
  const get = <T,>(path: string) => store.handle('GET', new URL(path, 'http://mock'), {}) as T
  const post = <T,>(path: string, body: Record<string, unknown> = {}) => store.handle('POST', new URL(path, 'http://mock'), body) as T
  return { store, sessions, repos, get, post }
}
const P = '/api/v2/projects/p-agent'

describe('WorktreeMockStore', () => {
  it('answers as the host does until its release gate opens: not_ready, no worktrees, no records', () => {
    const { get, store } = setup(false)
    expect(get<RnaWorktrees>(`${P}/worktrees`)).toEqual({ isolation: { enabled: false, reason: 'not_ready', git: '2.39.5' }, worktrees: [] })
    expect(get<{ applies: ApplyRecord[] }>(`${P}/applies`).applies).toEqual([])
    expect(() => store.createSession({ id: 's-new', projectId: 'p-agent' } as Session)).toThrow(expect.objectContaining({ status: 409, code: 'worktree_unavailable', details: { reason: 'not_ready' } }))
  })

  it('isolated p-agent: a kept and an unrecorded worktree; plain folders say no_repository', () => {
    const { get } = setup(true)
    const list = get<RnaWorktrees>(`${P}/worktrees`)
    expect(list.isolation.enabled).toBe(true)
    expect(list.worktrees.map(row => [row.kind, row.state])).toEqual([['session', 'kept'], ['orphan', 'active']])
    expect(get<RnaWorktrees>('/api/v2/projects/p-ink/worktrees').isolation).toMatchObject({ enabled: false, reason: 'no_repository' })
  })

  it('a worktree conversation: pending until its first turn, then a record; its turn applies with a record', () => {
    const { store, get } = setup(true)
    const session = { id: 's-new1234', projectId: 'p-agent', items: [], turns: [] } as unknown as Session
    expect(store.createSession(session)).toMatchObject({ state: 'pending' })
    expect(store.activate(session)).toBe(true)
    expect(store.activate(session)).toBe(false)
    expect(get<RnaWorktrees>(`${P}/worktrees`).worktrees[0]).toMatchObject({ kind: 'session', owner: { sessionId: 's-new1234' }, state: 'active' })
    const apply = store.applyTurn(session, 't-1', ['src/a.ts'])
    expect(apply).toMatchObject({ status: 'applied', applyIds: [expect.any(String)] })
    // As the host's: the turn's write into the project folder, and its sync into the worktree (crash recovery only).
    expect(get<{ applies: ApplyRecord[] }>(`${P}/applies?sessionId=s-new1234&turnId=t-1`).applies).toMatchObject([
      { kind: 'turn', target: 'project', files: 1, rollback: { available: true } },
      { kind: 'turn', target: 'session:s-new1234', rollback: { available: false, reason: 'target' } },
    ])
  })

  it('records list newest first with their rollback availability, details and patches', () => {
    const { get } = setup(true)
    const rows = get<{ applies: ApplyRecord[] }>(`${P}/applies`).applies
    expect(rows.find(row => row.id === 'ap-old-1')?.rollback).toEqual({ available: false, reason: 'rolled_back' })
    const detail = get<ApplyDetail>(`${P}/applies/ap-bg-1`)
    expect(detail.paths.map(file => file.status)).toEqual(['M', 'A'])
    const { patches } = get<{ patches: { path: string; diff: { kind: string } }[] }>(`${P}/applies/ap-bg-1/patches?path=docs%2Fnotes%2Fisolation.md`)
    expect(patches[0].diff.kind).toBe('patch')
    expect(() => get(`${P}/applies/nope`)).toThrow(expect.objectContaining({ code: 'apply_not_found' }))
  })

  it('a rollback is two steps; the token works once; files changed since are skipped unless forced; the rollback can be undone', () => {
    const { get, post } = setup(true)
    const preview = post<RollbackPreview>(`${P}/applies/ap-worker-1/rollback`)
    expect(preview.files).toEqual([])
    expect(preview.skipped).toEqual([{ path: 'prototypes/control-center/web/src/lib/phases.ts', reason: 'changed_after' }])
    const result = post<{ applyId: string; restored: string[]; skipped: unknown[] }>(`${P}/applies/ap-worker-1/rollback`, { confirm: preview.confirm, force: ['prototypes/control-center/web/src/lib/phases.ts'] })
    expect(result.restored).toEqual(['prototypes/control-center/web/src/lib/phases.ts'])
    expect(result.skipped).toEqual([])
    expect(() => post(`${P}/applies/ap-worker-1/rollback`, { confirm: preview.confirm })).toThrow(expect.objectContaining({ status: 409 }))
    const rows = get<{ applies: ApplyRecord[] }>(`${P}/applies`).applies
    expect(rows.find(row => row.id === 'ap-worker-1')).toMatchObject({ state: 'rolled_back', rolledBackBy: result.applyId })
    // Undo the rollback: a rollback of the rollback record.
    const undo = post<RollbackPreview>(`${P}/applies/${result.applyId}/rollback`)
    expect(undo.files.map(file => file.path)).toEqual(['prototypes/control-center/web/src/lib/phases.ts'])
  })

  it('a turn rollback: a worktree turn’s records, or a direct-mode turn’s checkpoint with its note; a narrower set by paths', () => {
    const { store, post, get } = setup(true)
    const session = { id: 's-w', projectId: 'p-agent' } as unknown as Session
    const apply = store.applyTurn(session, 't-w', ['src/a.ts', 'src/b.ts'])
    const preview = post<RollbackPreview>(`${P}/turns/t-w/rollback`, { paths: ['src/b.ts'] })
    expect(preview.files).toEqual([{ path: 'src/b.ts', action: 'restore' }])
    post(`${P}/turns/t-w/rollback`, { confirm: preview.confirm, paths: ['src/b.ts'] })
    expect(get<{ applies: ApplyRecord[] }>(`${P}/applies?turnId=t-w`).applies.find(row => row.id === apply.applyIds[0])?.state).toBe('rolled_back')
    const direct = post<RollbackPreview>(`${P}/turns/t-direct/rollback`)
    expect(direct.note).toBeTruthy()
    expect(direct.skipped).toEqual([{ path: 'src/lib/shared.ts', reason: 'unattributable' }])
    expect(() => post(`${P}/turns/t-direct/rollback`, { confirm: 'x'.repeat(32) })).toThrow(expect.objectContaining({ code: 'rollback_unconfirmed' }))
    // As the host's, a token is bound to the paths it was asked with.
    const narrowed = post<RollbackPreview>(`${P}/turns/t-direct/rollback`, { paths: ['src/lib/terminal.ts', 'src/lib/shared.ts'] })
    expect(() => post(`${P}/turns/t-direct/rollback`, { confirm: narrowed.confirm })).toThrow(expect.objectContaining({ code: 'rollback_unconfirmed' }))
    const again = post<RollbackPreview>(`${P}/turns/t-direct/rollback`, { paths: ['src/lib/shared.ts', 'src/lib/terminal.ts'] })
    const done = post<{ applyId: string; restored: string[] }>(`${P}/turns/t-direct/rollback`, { confirm: again.confirm, paths: ['src/lib/terminal.ts', 'src/lib/shared.ts'], force: ['src/lib/shared.ts'] })
    expect(done.restored).toEqual(['src/lib/terminal.ts', 'src/lib/shared.ts'])
    // The record names the turn it rolled back (`undoesTurn`), as the host's.
    expect(get<{ applies: ApplyRecord[] }>(`${P}/applies?turnId=t-direct`).applies[0]).toMatchObject({ id: done.applyId, kind: 'rollback', undoesTurn: 't-direct', source: { sessionId: 's-plan', turnId: 't-direct' } })
  })

  it('kept worktrees apply or discard in two steps; an active one is refused', () => {
    const { post, get } = setup(true)
    const plan = post<{ confirm: string; files: unknown[] }>(`${P}/worktrees/wt-kept01/apply`)
    expect(plan.files).toHaveLength(3)
    expect(post<{ applyId: string }>(`${P}/worktrees/wt-kept01/apply`, { confirm: plan.confirm }).applyId).toBeTruthy()
    expect(get<RnaWorktrees>(`${P}/worktrees`).worktrees.find(row => row.id === 'wt-kept01')?.state).toBe('removed')
    const discard = post<{ confirm: string }>(`${P}/worktrees/wt-orphan/discard`)
    expect(post<{ worktree: { state: string } }>(`${P}/worktrees/wt-orphan/discard`, { confirm: discard.confirm }).worktree.state).toBe('removed')
  })

  it('subagent card buttons: merge, handoff, and dropping a merged worker in two steps', () => {
    const { post, sessions } = setup(true)
    const base = '/api/v2/sessions/s-plan/agents/ag-1/merge'
    expect(post<{ turnId: string }>(base, { action: 'handoff' }).turnId).toBeTruthy()
    const preview = post<{ confirm: string; files: unknown[] }>(base, { action: 'drop' })
    expect(preview.files).toHaveLength(2)
    expect(post<{ subagent: { merge: { status: string } } }>(base, { action: 'drop', confirm: preview.confirm }).subagent.merge.status).toBe('dropped')
    expect(sessions[0].items[0].subagent?.merge?.status).toBe('dropped')
    expect(() => post('/api/v2/sessions/s-plan/agents/nobody/merge', { action: 'merge' })).toThrow(expect.objectContaining({ code: 'merge_unknown' }))
  })

  it('git init: the preview writes nothing; the token binds the lines; the confirmation makes the folder a repository', () => {
    const { post, repos } = setup(true)
    const init = '/api/v2/projects/p-ink/git/init'
    const preview = post<GitInitPreview>(init)
    expect(preview.gitignore.lines.map(line => line.text)).toContain('.env*')
    expect(preview.identityRequired).toBe(false)
    expect(repos.has('p-ink')).toBe(false)
    // Lines edited after the preview: its token no longer fits.
    expect(() => post(init, { confirm: preview.confirm, lines: ['.DS_Store', '/vendor/three-ext/'] })).toThrow(expect.objectContaining({ code: 'git_init_changed' }))
    // As the host's: edited lines must keep ignoring a nested repository.
    expect(() => post(init, { lines: ['.DS_Store', 'node_modules/'] })).toThrow(expect.objectContaining({ status: 400, code: 'git_init_lines_invalid' }))
    const lines = ['.DS_Store', 'node_modules/', '/vendor/three-ext/']
    const narrower = post<GitInitPreview>(init, { lines })
    expect(narrower.files.count).toBeGreaterThan(preview.files.count)
    expect(post<{ status: string }>(init, { confirm: narrower.confirm, lines }).status).toBe('clean')
    expect(repos.has('p-ink')).toBe(true)
    expect(() => post(init)).toThrow(expect.objectContaining({ code: 'git_init_already' }))
  })
})
