/** The mock's 工作区改动 repository (?mock=1): branches, the comparison, patches and the writes, as the host answers them. */
import { describe, expect, it } from 'vitest'
import type { GitBranches, GitCompare, GitDiff, GitPatches, GitStatus } from '@/api/git-api'
import { parsePatch } from '@/lib/diff'
import { GitMockStore } from './git-routes'

const BASE = '/api/v2/projects/p-agent/git'
const get = <T,>(store: GitMockStore, path: string) => store.handle('GET', new URL(path, 'http://mock'), {}) as T
const post = <T,>(store: GitMockStore, path: string, body: Record<string, unknown>) => store.handle('POST', new URL(path, 'http://mock'), body) as T
const LINKED = encodeURIComponent('/Users/me/Documents/独立开发项目/Pi_agent/.claude/worktrees/official-site-docs-design-fbd2ac')

describe('GitMockStore', () => {
  it('lists local branches with the default, the current one and the worktrees they are checked out in', () => {
    const store = new GitMockStore()
    const branches = get<GitBranches>(store, `${BASE}/branches`)
    expect(branches.default).toBe('main')
    expect(branches.current).toBe('feature/compare-panel')
    expect(branches.branches.filter(row => row.current).map(row => row.name)).toEqual(['feature/compare-panel'])
    expect(branches.branches.find(row => row.name.startsWith('claude/official'))?.worktreePath).toContain('.claude/worktrees/')
  })

  it('全部改动 holds committed, staged, unstaged and untracked work; 未提交的改动 leaves the committed out; another base adds its own', () => {
    const store = new GitMockStore()
    const all = get<GitCompare>(store, `${BASE}/compare?mode=all`)
    expect(all).toMatchObject({ mode: 'all', base: 'main', defaultBase: 'main', target: { kind: 'branch', label: 'feature/compare-panel' } })
    expect(all.mergeBase).toMatch(/^[0-9a-f]{40}$/)
    const paths = all.files.map(file => file.path)
    expect(paths).toContain('prototypes/control-center/workspace-git-compare.mjs') // committed
    expect(paths).toContain('docs/specs/workspace-git.md') // staged rename
    expect(paths).toContain('notes/old-plan.md') // deleted
    expect(all.files.find(file => file.path.endsWith('generated.json'))).toMatchObject({ status: '?', untracked: true, added: 1502, removed: 0 })
    expect(all.files.find(file => file.path.endsWith('logo.png'))).toMatchObject({ binary: true, added: null })
    const uncommitted = get<GitCompare>(store, `${BASE}/compare?mode=uncommitted`)
    expect(uncommitted.files.map(file => file.path)).not.toContain('prototypes/control-center/workspace-git-compare.mjs')
    expect(get<GitCompare>(store, `${BASE}/compare?mode=all&base=release%2F0.61`).files.map(file => file.path)).toContain('CHANGELOG.md')
    expect(() => get(store, `${BASE}/compare?mode=all&base=nope`)).toThrow(expect.objectContaining({ code: 'git_base_not_found' }))
    expect(() => get(store, `${BASE}/compare?mode=all&base=claude%2Fcode-audit-dev-plan-caefaf`)).toThrow(expect.objectContaining({ code: 'no_common_history' }))
    expect(get<GitCompare>(store, '/api/v2/projects/p-ink/git/compare?mode=all')).toMatchObject({ repo: 'none', files: [] })
  })

  it('patches read as git’s, several hunks apart; context=all gives the whole file', () => {
    const store = new GitMockStore()
    const { mergeBase, files } = get<GitCompare>(store, `${BASE}/compare?mode=all`)
    const routes = files.find(file => file.path.endsWith('workspace-git-routes.mjs'))!
    const { patches } = get<GitPatches>(store, `${BASE}/patches?base=${mergeBase}&path=${encodeURIComponent(routes.path)}&path=notes%2Fold-plan.md`)
    const parsed = parsePatch(patches[0].diff.patch!)
    expect(parsed.hunks.length).toBeGreaterThan(1)
    expect(parsed.hunks[1].skipped).toBeGreaterThan(0)
    expect([parsed.added, parsed.removed]).toEqual([routes.added, routes.removed])
    expect(parsePatch(patches[1].diff.patch!).removed).toBe(3)
    const whole = get<GitDiff>(store, `${BASE}/diff?source=compare&base=${mergeBase}&path=${encodeURIComponent(routes.path)}&context=all`)
    expect(parsePatch(whole.patch!).hunks).toHaveLength(1)
    expect(get<GitDiff>(store, `${BASE}/diff?source=compare&base=HEAD&path=prototypes%2Fcontrol-center%2Fweb%2Fpublic%2Flogo.png`)).toEqual({ kind: 'binary' })
  })

  it('another worktree has its own changes and is read-only', () => {
    const store = new GitMockStore()
    const linked = get<GitCompare>(store, `${BASE}/compare?mode=all&worktree=${LINKED}`)
    expect(linked.target).toEqual({ kind: 'branch', label: 'claude/official-site-docs-design-fbd2ac' })
    expect(linked.files.every(file => file.untracked)).toBe(true)
    expect(linked.files.map(file => file.path)).toContain('.agents/skills/design-taste-frontend/SKILL.md')
    expect(() => post(store, `${BASE}/stage?worktree=${LINKED}`, { paths: ['skills-lock.json'] })).toThrow(expect.objectContaining({ code: 'git_worktree_read_only' }))
    expect(() => get(store, `${BASE}/compare?mode=all&worktree=%2Fsomewhere`)).toThrow(expect.objectContaining({ code: 'git_worktree_denied' }))
  })

  it('stage and the two-step discard change the files the comparison lists', () => {
    const store = new GitMockStore()
    const staged = post<{ status: GitStatus }>(store, `${BASE}/stage`, { paths: ['prototypes/control-center/server.mjs'] })
    expect(staged.status.files.staged.map(file => file.path)).toContain('prototypes/control-center/server.mjs')
    expect(staged.status.files.unstaged.map(file => file.path)).not.toContain('prototypes/control-center/server.mjs')
    const path = 'site/app/api/search/route.ts'
    const preview = post<{ confirm: string; files: unknown[] }>(store, `${BASE}/discard`, { paths: [path] })
    expect(preview.files).toEqual([{ path, action: 'delete' }])
    post(store, `${BASE}/discard`, { paths: [path], confirm: preview.confirm })
    expect(get<GitCompare>(store, `${BASE}/compare?mode=uncommitted`).files.map(file => file.path)).not.toContain(path)
  })
})
