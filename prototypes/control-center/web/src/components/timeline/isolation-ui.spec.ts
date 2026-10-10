/**
 * 0.63 worktree isolation in the conversation (worktree design §12): a turn's footer about the project folder and
 * its two-step rollback, a worker's merge on its card, background change sets applied from a worktree, the
 * conversation's worktree mark, and the new-conversation switch in the composer's launcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, createRef, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import type { Item, ProjectSummary, Turn } from '@/api/types'
import type { ApplyRecord, RnaWorktrees } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetIsolation, useIsolation } from '@/store/isolation-store'
import { useTimelineFocus } from './timeline-focus'
import { TurnApplyLine } from './TurnApply'
import { SubagentCard } from './SubagentCard'
import { BackgroundChangeRevert } from './BackgroundChangeRevert'
import { BackgroundDeliverables } from './BackgroundDeliverables'
import { WorktreeMark } from '@/components/shell/TopBar'
import { ComposerMenu, WorktreeChip, type ComposerMenuHandle } from '@/components/composer/ComposerMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: { method: string; path: string; body?: unknown }[] = []
let records: ApplyRecord[] = []
let isolation: RnaWorktrees['isolation'] = { enabled: true, git: '2.39.5' }
const plan = (files: { path: string; action: string }[], extra: Record<string, unknown> = {}) => ({ confirm: 'c'.repeat(32), expiresAt: new Date(Date.now() + 120_000).toISOString(), files, skipped: [], ...extra })
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: init.body })
    const body = (init.body ?? {}) as Record<string, unknown>
    if (path.endsWith('/worktrees')) return { isolation, worktrees: [{ id: 'wt-w1', kind: 'worker', owner: { agentId: 'ag-1' }, path: '/p/.rna/worktrees.nosync/w-ag1', state: 'active', createdAt: '', pending: { files: 1 } }] } as T
    if (path.includes('/applies?')) return { applies: records } as T
    if (/\/rollback$/.test(path)) {
      if (!body.confirm) return plan((body.paths as string[] | undefined)?.map(p => ({ path: p, action: 'restore' })) ?? [{ path: 'src/a.ts', action: 'restore' }, { path: 'src/b.ts', action: 'delete' }], { skipped: [{ path: 'src/c.ts', reason: 'changed_after' }] }) as T
      return { applyId: 'ap-rb', restored: ['src/a.ts', 'src/b.ts'], skipped: [], verify: 'verified' } as T
    }
    if (method === 'GET' && /\/applies\/ap-(one|two)$/.test(path)) {
      const one = path.endsWith('ap-one')
      return { id: one ? 'ap-one' : 'ap-two', kind: 'background', target: 'project', source: {}, state: 'verified', files: 2, added: 0, removed: 0, bothChanged: 0, sample: [], at: '', rollback: { available: true },
        paths: one ? [{ path: 'added.md', status: 'A', added: 1, removed: 0 }, { path: 'shared.md', status: 'M', added: 1, removed: 1 }] : [{ path: 'notes.md', status: 'M', added: 1, removed: 1 }, { path: 'shared.md', status: 'M', added: 5, removed: 2 }] } as T
    }
    if (/\/background-changes\/[^/]+\/revert$/.test(path)) {
      if (!body.confirm) return plan([{ path: 'x.md', action: 'restore' }, { path: 'y.md', action: 'delete' }]) as T
      return { status: 'reverted', applyId: 'ap-rb', restored: ['x.md', 'y.md'], skipped: [], verify: 'verified', outcome: { restored: ['x.md', 'y.md'], conflicts: [], failed: [] } } as T
    }
    if (/\/agents\/[^/]+\/merge$/.test(path)) {
      if (body.action === 'drop' && !body.confirm) return plan([{ path: 'src/w.ts', action: 'restore' }], { skipped: [{ path: 'src/later.ts', reason: 'changed_after' }] }) as T
      return { subagent: {}, applied: ['src/w.ts'], conflicts: [] } as T
    }
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

const turnItems = (): Record<string, Item> => ({
  e1: { id: 'e1', kind: 'tool', turnId: 't1', createdAt: '', text: '', tool: { name: 'project_edit', status: 'succeeded', args: { path: 'src/a.ts', oldText: 'a', newText: 'b' } } } as unknown as Item,
})
function seed(turn: Partial<Turn>, { items = turnItems(), status = 'idle', worktree = true }: { items?: Record<string, Item>; status?: string; worktree?: boolean } = {}) {
  const project: ProjectSummary = { id: 'p1', name: 'P', workspacePath: '/p', permissions: { workspace: 'write' }, git: { sessionWorktreeDefault: false } }
  const meta = { id: 's1', title: 'S', status, projectId: 'p1', ...(worktree ? { worktree: { id: 'wt-s1', state: 'active' } } : {}) }
  useApp.setState({
    projects: { p1: project }, sessionIndex: { s1: meta } as never,
    sessions: { s1: { meta, items, order: Object.keys(items), turns: { t1: { id: 't1', status: 'completed', ...turn } }, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false } as never },
  })
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  calls = []; records = []; isolation = { enabled: true, git: '2.39.5' }
  resetIsolation(); setTransport(transport); useUi.setState({ toasts: [], disclosure: {} }); useTimelineFocus.setState({ target: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetIsolation() })

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const show = async (node: ReturnType<typeof createElement>) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await settle() }
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const posts = (pattern: RegExp) => calls.filter(call => call.method === 'POST' && pattern.test(call.path)).map(call => call.body)
const line = (sessionRunning = false) => createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: sessionRunning, toolIds: ['e1'] })

describe('turn footer and the project folder', () => {
  it('applied: the turn’s files from its records, the user’s own changes, and a two-step 回退 sending the token only on the second click', async () => {
    records = [{ id: 'ap-1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 't1' }, state: 'verified', files: 2, added: 0, removed: 0, bothChanged: 1, sample: [], at: '', rollback: { available: true } }]
    seed({ apply: { status: 'applied', applyIds: ['ap-1'], bothChanged: 1 } })
    await show(line())
    const footer = host.querySelector('[data-turn-apply="applied"]')!
    expect(footer.textContent).toContain('已应用到项目文件夹 · 2 个文件')
    expect(footer.textContent).toContain('其中 1 个文件同时有你在项目文件夹里的改动')
    await click(button('回退'))
    expect(posts(/\/turns\/t1\/rollback$/)).toEqual([{}])
    const card = host.querySelector('[data-two-step]')!
    expect(card.textContent).toContain('src/a.ts')
    expect(card.textContent).toContain('src/c.ts')
    // Force the file changed since, then confirm.
    await act(async () => { (card.querySelector('[data-two-step-skipped] input') as HTMLInputElement).click() })
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts(/\/turns\/t1\/rollback$/)[1]).toEqual({ confirm: 'c'.repeat(32), force: ['src/c.ts'] })
    expect(host.querySelector('[data-two-step]')).toBeNull()
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已还原 2 个文件。')
  })

  it('works under StrictMode (the dev build mounts effects twice)', async () => {
    seed({ apply: { status: 'applied', applyIds: ['ap-1'] } })
    await show(createElement(StrictMode, null, line()))
    await click(button('回退'))
    expect(host.querySelector('[data-two-step]')).not.toBeNull()
    expect(button('回退')?.disabled).toBe(false)
  })

  it('applying and merging show while the turn still runs', async () => {
    seed({ status: 'running', apply: { status: 'applying', applyIds: [] } })
    await show(line(true))
    expect(host.querySelector('[data-turn-apply]')?.textContent).toBe('正在应用到项目文件夹…')
    seed({ status: 'running', apply: { status: 'conflicted', applyIds: [], conflict: { id: 'c', paths: [{ path: 'a.ts', kind: 'content' }], attempts: 1 } } })
    await settle()
    expect(host.querySelector('[data-turn-apply]')?.textContent).toBe('与项目文件夹冲突，正在合并')
  })

  it('conflicted: the card above the composer decides, and 去处理 goes to this turn’s card', async () => {
    const card = (id: string, interaction: Record<string, unknown>) => ({ id, kind: 'question', text: '', createdAt: '', interaction: { kind: 'question', source: 'worktree', status: 'pending', canRespond: true, ...interaction } } as unknown as Item)
    // As the host posts them: item ids differ from interaction ids; a newer card about another turn sits below.
    const items = { ...turnItems(), q1: card('q1', { id: 'ix-1', actionId: 'worktree-apply:t1' }), q2: card('q2', { id: 'ix-2', actionId: 'worktree-apply:t0' }) }
    seed({ apply: { status: 'conflicted', applyIds: [], conflict: { id: 'c', paths: [{ path: 'a.ts', kind: 'content' }, { path: 'b.png', kind: 'binary' }], attempts: 2 } } }, { items })
    await show(line())
    expect(host.querySelector('[data-turn-apply="conflicted"]')?.textContent).toContain('没有应用：2 个文件冲突')
    await click(button('去处理'))
    expect(useTimelineFocus.getState().target).toMatchObject({ sessionId: 's1', itemId: 'q1' })
    // The card the turn names (`turn.apply.card`, a second one of the turn: `:2`) wins.
    const second = { ...items, q3: card('q3', { id: 'ix-3', actionId: 'worktree-apply:t1:2' }) }
    seed({ apply: { status: 'conflicted', applyIds: [], conflict: { id: 'c', paths: [{ path: 'a.ts', kind: 'content' }], attempts: 2 }, card: { interactionId: 'ix-3', actionId: 'worktree-apply:t1:2' } } }, { items: second })
    await settle()
    await click(button('去处理'))
    expect(useTimelineFocus.getState().target).toMatchObject({ itemId: 'q3' })
    // Answered: no card to go to, and no promise of one.
    seed({ apply: { status: 'conflicted', applyIds: [], conflict: { id: 'c', paths: [{ path: 'a.ts', kind: 'content' }], attempts: 2 } } }, { items: { ...turnItems(), q2: items.q2 } })
    await settle()
    expect(button('去处理')).toBeUndefined()
    expect(host.querySelector('[data-turn-apply="conflicted"]')?.textContent).toBe('没有应用：1 个文件冲突')
  })

  it('held by the host (read-only project): says why the changes stay in the worktree', async () => {
    seed({ apply: { status: 'pending', applyIds: [], reason: 'read_only' } })
    await show(line())
    expect(host.querySelector('[data-turn-apply="pending"]')?.textContent).toContain('项目现在是只读的，改动还在工作树里')
  })

  it('a worktree turn’s footer counts only what reached the project folder, and once rolled back offers 撤销', async () => {
    const row = (patch: Partial<ApplyRecord>): ApplyRecord => ({ id: 'ap-1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 't1' }, state: 'verified', files: 2, added: 0, removed: 0, bothChanged: 0, sample: [], at: '', rollback: { available: true }, ...patch })
    // The host's turn-start sync into the worktree is recorded under the same turn (target session:s1).
    records = [row({ id: 'ap-s', target: 'session:s1', files: 9, rollback: { available: false, reason: 'target' } }), row({ id: 'ap-1' })]
    seed({ apply: { status: 'applied', applyIds: ['ap-1'] } })
    await show(line())
    expect(host.querySelector('[data-turn-apply="applied"]')?.textContent).toContain('已应用到项目文件夹 · 2 个文件')
    records = [records[0], row({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), { ...row({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1' }), undoesTurn: 't1' }]
    useIsolation.setState({ applies: {} }); act(() => root.unmount()); root = createRoot(host)
    await show(line())
    expect(host.querySelector('[data-turn-apply="rolled_back"]')?.textContent).toContain('已回退')
    await click(button('撤销'))
    expect(calls.some(call => call.method === 'POST' && call.path.endsWith('/applies/ap-rb/rollback'))).toBe(true)
    // A conflict settled with this conversation's version (a resolve record) is part of the turn: the host rolls it
    // back with the turn (one rollback record), so the footer reads 已回退 with nothing left over.
    records = [row({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), row({ id: 'ap-res', kind: 'resolve', files: 1, state: 'rolled_back', rolledBackBy: 'ap-rb' }), { ...row({ id: 'ap-rb', kind: 'rollback' }), undoesTurn: 't1' }]
    seed({ apply: { status: 'applied', applyIds: ['ap-1', 'ap-res'] } })
    useIsolation.setState({ applies: {} }); act(() => root.unmount()); root = createRoot(host)
    await show(line())
    expect(host.querySelector('[data-turn-apply="rolled_back"]')?.textContent).toContain('已回退')
    expect(host.querySelector('[data-turn-apply-left]')).toBeNull()
    // Only the turn record rolled back (from 应用记录): the resolve still stands, and 回退 is offered for the rest.
    records = [row({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), row({ id: 'ap-res', kind: 'resolve', files: 1 }), row({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1' })]
    useIsolation.setState({ applies: {} }); act(() => root.unmount()); root = createRoot(host)
    await show(line())
    expect(host.querySelector('[data-turn-apply="applied"]')).not.toBeNull()
    expect(button('回退')).toBeTruthy()
  })

  it('stopped with changes left in the worktree; ignored folders and dependency manifests are said', async () => {
    seed({ status: 'cancelled', apply: { status: 'pending', applyIds: [], ignoredNew: ['dist/'], dependencies: true } })
    await show(line())
    const text = host.querySelector('[data-turn-apply]')!.textContent!
    expect(text).toContain('这一轮停下了，改动还在工作树里')
    expect(text).toContain('工作树里有未应用的被忽略文件：dist/')
    expect(text).toContain('依赖清单变了，项目文件夹需要重新安装')
  })

  it('a direct-mode turn: 回退本轮 from its checkpoint, files can be unticked (asked again with paths)', async () => {
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'taken' } }, { worktree: false })
    await show(line())
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮改动 1 个文件')
    await click(host.querySelector('[data-turn-rollback]'))
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-two-step-files] input')
    expect(boxes).toHaveLength(2)
    await act(async () => { boxes[1].click() }); await settle()
    // The narrowed request keeps the file left alone (skipped), so it stays listed and can still be forced.
    expect(posts(/\/turns\/t1\/rollback$/)).toEqual([{}, { paths: ['src/a.ts', 'src/c.ts'] }])
    expect(host.querySelector('[data-two-step-skipped]')?.textContent).toContain('src/c.ts')
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts(/\/turns\/t1\/rollback$/)[2]).toEqual({ confirm: 'c'.repeat(32), paths: ['src/a.ts', 'src/c.ts'] })
  })

  it('unticked then ticked again: the confirmation names exactly the paths its token was asked with', async () => {
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'taken' } }, { worktree: false })
    await show(line())
    await click(host.querySelector('[data-turn-rollback]'))
    const box = () => host.querySelectorAll<HTMLInputElement>('[data-two-step-files] input')[1]
    await act(async () => { box().click() }); await settle()
    await act(async () => { box().click() }); await settle()
    // All ticked again: the whole plan is asked for again, and its token is the one sent (no `paths`).
    expect(posts(/\/turns\/t1\/rollback$/)).toEqual([{}, { paths: ['src/a.ts', 'src/c.ts'] }, {}])
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts(/\/turns\/t1\/rollback$/)[3]).toEqual({ confirm: 'c'.repeat(32) })
    // Every file unticked: nothing is asked, and nothing can be confirmed.
    await click(host.querySelector('[data-turn-rollback]'))
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-two-step-files] input')
    await act(async () => { boxes[0].click() }); await settle()
    await act(async () => { host.querySelectorAll<HTMLInputElement>('[data-two-step-files] input')[1].click() }); await settle()
    expect(posts(/\/turns\/t1\/rollback$/)).toHaveLength(6)
    expect(host.querySelector<HTMLButtonElement>('[data-two-step-confirm]')?.disabled).toBe(true)
  })

  it('rolled back: 撤销 rolls the rollback record back', async () => {
    records = [{ id: 'ap-rb', kind: 'rollback', target: 'project', source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: [], at: '', rollback: { available: true } }]
    seed({ checkpoint: { state: 'taken' } }, { worktree: false })
    await show(line())
    expect(host.querySelector('[data-turn-apply="rolled_back"]')?.textContent).toContain('已回退')
    await click(button('撤销'))
    expect(calls.some(call => call.method === 'POST' && call.path.endsWith('/applies/ap-rb/rollback'))).toBe(true)
  })

  it('a direct-mode turn whose checkpoint expired says so instead of offering 回退本轮', async () => {
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'expired' } }, { worktree: false })
    await show(line())
    const footer = host.querySelector('[data-turn-apply="checkpoint_expired"]')!
    expect(footer.textContent).toContain('本轮改动 1 个文件')
    expect(footer.querySelector('[data-turn-expired]')?.textContent).toBe('已过期，不能回退')
    expect(host.querySelector('[data-turn-rollback]')).toBeNull()
    expect(button('回退本轮')).toBeUndefined()
    // The short reason is on hover and focus.
    expect(footer.querySelector<HTMLElement>('[data-turn-expired]')?.tabIndex).toBe(0)
  })

  it('a worktree turn whose records expired keeps 查看 but drops 回退', async () => {
    records = [{ id: 'ap-1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 't1' }, state: 'expired', files: 2, added: 0, removed: 0, bothChanged: 0, sample: [], at: '', rollback: { available: false, reason: 'expired' } }]
    seed({ apply: { status: 'applied', applyIds: ['ap-1'] } })
    await show(line())
    const footer = host.querySelector('[data-turn-apply="applied"]')!
    expect(footer.textContent).toContain('已应用到项目文件夹 · 2 个文件')
    expect(button('查看', footer)).toBeDefined()
    expect(button('回退', footer)).toBeUndefined()
    expect(footer.querySelector('[data-turn-expired]')).not.toBeNull()
  })

  it('a read-only turn of a direct-mode conversation says nothing', async () => {
    seed({ checkpoint: { state: 'taken' } }, { items: {}, worktree: false })
    await act(async () => { root.render(createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: [] })) }); await settle()
    expect(host.querySelector('[data-turn-apply]')).toBeNull()
  })
})

describe('a worker’s merge on its card', () => {
  const sub = (merge: Record<string, unknown>, status = 'completed') => ({ sub: { id: 'sub', kind: 'subagent', text: '', createdAt: '', subagent: { agentId: 'ag-1', role: 'worker', status, background: true, task: '改 a.ts', worktreeId: 'wt-w1', merge } } as unknown as Item })
  const card = () => createElement(SubagentCard, { sessionId: 's1', itemId: 'sub' })

  it('merged: 回退这次合并 in two steps through the host', async () => {
    seed({}, { items: sub({ status: 'merged', files: 2, applyIds: ['ap-m'] }) })
    await show(card())
    expect(host.querySelector('[data-subagent-merge="merged"]')?.textContent).toContain('已合并 2 个文件')
    await click(button('回退这次合并'))
    // The host takes no `force` here: files changed since are listed, not offered to restore anyway.
    expect(host.querySelector('[data-two-step-skipped]')?.textContent).toContain('这些文件之后又改过，不会动它们')
    expect(host.querySelector('[data-two-step-skipped] input')).toBeNull()
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts(/\/sessions\/s1\/agents\/ag-1\/merge$/)).toEqual([{ action: 'drop' }, { action: 'drop', confirm: 'c'.repeat(32) }])
  })

  it('a worker whose worktree was gone after a restart says its changes were lost', async () => {
    seed({}, { items: sub({ status: 'dropped', reason: 'missing' }, 'interrupted') })
    await show(card())
    expect(host.querySelector('[data-subagent-merge="dropped"]')?.textContent).toBe('子代理的工作树不见了，它的改动没能合并')
  })

  it('conflicts wait on the main conversation while it runs; once idle the user gets 让 Rna 处理 / 丢弃 / 查看改动', async () => {
    const conflicts = [{ path: 'a.ts', kind: 'content' }, { path: 'link', kind: 'unsafe_symlink' }]
    seed({}, { items: sub({ status: 'conflict', conflicts }), status: 'running' })
    await show(card())
    expect(host.querySelector('[data-subagent-merge]')?.textContent).toBe('有 2 个文件冲突，等待主对话')
    expect(button('让 Rna 处理')).toBeUndefined()
    seed({}, { items: sub({ status: 'conflict', conflicts }) })
    await settle()
    expect(button('丢弃')).toBeDefined()
    expect(button('查看改动')).toBeDefined()
    await click(button('让 Rna 处理'))
    expect(posts(/\/merge$/)).toEqual([{ action: 'handoff' }])
  })

  it('conflicts of a worker merged all or nothing while idle: nothing is written yet, so 合并 brings its clean files in', async () => {
    const conflicts = [{ path: 'a.ts', kind: 'content' }]
    seed({}, { items: sub({ status: 'conflict', conflicts, files: 0, applyIds: [] }), status: 'running' })
    await show(card())
    expect(host.querySelector('[data-subagent-merge]')?.textContent).toBe('有 1 个文件冲突，等待主对话')
    expect(button('合并')).toBeUndefined()
    seed({}, { items: sub({ status: 'conflict', conflicts, files: 0, applyIds: [] }) })
    await settle()
    expect(host.querySelector('[data-subagent-merge="conflict"]')?.textContent).toContain('有 1 个文件冲突，还没有合并任何改动')
    expect(button('让 Rna 处理')).toBeDefined(); expect(button('丢弃')).toBeDefined()
    await click(button('合并'))
    expect(posts(/\/merge$/)).toEqual([{ action: 'merge' }])
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已合并 1 个文件。')
    // Its clean part already written (a partial merge): only the conflicts are left, and 合并 is not offered again.
    seed({}, { items: sub({ status: 'conflict', conflicts, files: 1, applyIds: ['ap-1'] }) })
    await settle()
    expect(host.querySelector('[data-subagent-merge="conflict"]')?.textContent).toContain('有 1 个文件冲突')
    expect(host.querySelector('[data-subagent-merge="conflict"]')?.textContent).not.toContain('还没有合并')
    expect(button('合并')).toBeUndefined()
  })

  it('not merged (cancelled): 合并 asks the host to merge again', async () => {
    seed({}, { items: sub({ status: 'pending', reason: 'cancelled' }, 'cancelled') })
    await show(card())
    expect(host.querySelector('[data-subagent-merge="pending"]')?.textContent).toContain('已取消，改动没有合并')
    await click(button('合并'))
    expect(posts(/\/merge$/)).toEqual([{ action: 'merge' }])
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已合并 1 个文件。')
  })

  it('a worker the host left pending (did not finish; ended while the main conversation was idle) offers 合并 / 丢弃 / 查看改动 with its reason', async () => {
    seed({}, { items: sub({ status: 'pending', applyIds: [], reason: 'unfinished' }, 'failed') })
    await show(card())
    const pendingLine = () => host.querySelector('[data-subagent-merge="pending"]')
    expect(pendingLine()?.textContent).toContain('子代理没有做完，改动没有合并')
    expect(button('合并', pendingLine()!)).toBeDefined(); expect(button('丢弃', pendingLine()!)).toBeDefined(); expect(button('查看改动', pendingLine()!)).toBeDefined()
    await click(button('合并'))
    expect(posts(/\/merge$/)).toEqual([{ action: 'merge' }])
    // Pending while the main conversation runs too: the user may still merge it from the card.
    seed({}, { items: sub({ status: 'pending', applyIds: [], reason: 'parent_idle' }), status: 'running' })
    await settle()
    expect(pendingLine()?.textContent).toContain('主对话没有在运行，改动没有自动合并')
    expect(button('合并', pendingLine()!)).toBeDefined(); expect(button('丢弃', pendingLine()!)).toBeDefined()
  })

  it('a merge held on the user\'s Git operation promises no automatic merge; one a restart cut off points at the card above the composer', async () => {
    seed({}, { items: sub({ status: 'pending', applyIds: [], reason: 'git_operation', operation: 'rebase' }) })
    await show(card())
    const pendingLine = () => host.querySelector('[data-subagent-merge="pending"]')
    expect(pendingLine()?.textContent).toContain('项目文件夹正在进行 Git 操作，改动暂未合并')
    expect(pendingLine()?.textContent).not.toContain('自动合并')
    seed({}, { items: sub({ status: 'pending', applyIds: ['a1'], files: 2, reason: 'apply_interrupted' }, 'interrupted') })
    await settle()
    expect(pendingLine()?.textContent).toContain('合并被重启打断，请先处理输入框上方的卡片')
  })

  it('a shared root and no change say nothing on the card line', async () => {
    seed({}, { items: sub({ status: 'shared_root', reason: 'no_repository' }) })
    await show(card())
    expect(host.querySelector('[data-subagent-merge]')).toBeNull()
  })
})

describe('background change sets from a worktree', () => {
  const project = (row: Record<string, unknown>) => useApp.setState({ projects: { p1: { id: 'p1', name: 'P', workspacePath: '/p', backgroundChanges: [{ id: 'bg', actionId: 'a', at: '', count: 1, paths: ['x.md'], ...row }] } as never } })

  it('an applied git set rolls back through its apply record, with the same button text', async () => {
    project({ status: 'kept', kind: 'git', applyId: 'ap-bg' })
    await show(createElement(BackgroundChangeRevert, { projectId: 'p1', changeId: 'bg' }))
    await click(button('回退这些修改'))
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/v2/projects/p1/applies/ap-bg/rollback'])
    await click(host.querySelector('[data-two-step-confirm]'))
    expect(posts(/applies\/ap-bg\/rollback$/)[1]).toMatchObject({ confirm: 'c'.repeat(32) })
  })

  it('a git set applied by several records (its clean part, then a take) rolls them all back through the set’s own route, in two steps', async () => {
    project({ status: 'kept', kind: 'git', applyId: 'ap-1', applyIds: ['ap-1', 'ap-2'] })
    await show(createElement(BackgroundChangeRevert, { projectId: 'p1', changeId: 'bg' }))
    await click(button('回退这些修改'))
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/projects/p1/background-changes/bg/revert'])
    expect(host.textContent).toContain('y.md')
    await click(host.querySelector('[data-two-step-confirm]'))
    const sent = posts(/background-changes\/bg\/revert$/)
    expect(sent).toHaveLength(2); expect(sent[1]).toMatchObject({ confirm: 'c'.repeat(32) })
    expect(posts(/applies\/.+\/rollback$/)).toEqual([])
    expect(useUi.getState().toasts.at(-1)?.text).toBe('已回退 2 个文件。')
  })

  it('the timeline lists every record’s files of a set applied by several records, a file two wrote from the newer', async () => {
    project({ status: 'kept', kind: 'git', applyId: 'ap-one', applyIds: ['ap-one', 'ap-two'], count: 3 })
    await show(createElement(BackgroundDeliverables, { projectId: 'p1', changeId: 'bg' }))
    const section = host.querySelector('[data-applied-files]')
    expect(section?.getAttribute('data-applied-files')).toBe('ap-one ap-two')
    expect(section?.textContent).toContain('修改了 3 个文件')
    expect([...host.querySelectorAll('[data-applied-files] li')].map(li => li.textContent?.replace(/\s+/g, ''))).toEqual(['added.md新建+1', 'notes.md+1−1', 'shared.md+5−2'])
  })

  it('a set handed to a conversation (让 Rna 处理) says so instead of pointing at a card that is gone', async () => {
    project({ status: 'merge_conflicted', kind: 'git', handedTo: 's1', conflicts: [{ path: 'x.md', kind: 'content' }] })
    await show(createElement(BackgroundChangeRevert, { projectId: 'p1', changeId: 'bg' }))
    expect(host.querySelector('[data-change-status="merge_conflicted"]')?.textContent).toContain('有 1 个文件和项目文件夹里的改动冲突，已交给对话处理')
    project({ status: 'merge_conflicted', kind: 'git', handedTo: 's1' })
    await settle()
    expect(host.querySelector('[data-change-status="merge_conflicted"]')?.textContent).toBe('还没有应用到项目文件夹，已交给对话处理')
  })

  it('deferred and merge_conflicted say why nothing is applied yet; older sets keep the DirectFix revert', async () => {
    project({ status: 'deferred', kind: 'git' })
    await show(createElement(BackgroundChangeRevert, { projectId: 'p1', changeId: 'bg' }))
    expect(host.querySelector('[data-change-status="deferred"]')?.textContent).toBe('做完了，等这一轮对话结束后应用')
    project({ status: 'merge_conflicted', kind: 'git', conflicts: [{ path: 'x.md', kind: 'content' }] })
    await settle()
    expect(host.querySelector('[data-change-status="merge_conflicted"]')?.textContent).toContain('x.md')
    // Held without a conflict (background write access went away): never "0 files conflict".
    project({ status: 'merge_conflicted', kind: 'git' })
    await settle()
    expect(host.querySelector('[data-change-status="merge_conflicted"]')?.textContent).toBe('还没有应用到项目文件夹，等你在输入框上方的卡片里决定')
    project({ status: 'kept' })
    await settle()
    await click(button('回退这些修改'))
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/projects/p1/background-changes/bg/revert'])
  })
})

describe('the conversation’s worktree mark', () => {
  it('says 独立工作树, or that the worktree is missing', async () => {
    await show(createElement(WorktreeMark, { worktree: { id: 'w', state: 'active' } }))
    expect(host.querySelector('[data-worktree-mark="active"]')?.textContent).toBe('独立工作树')
    await show(createElement(WorktreeMark, { worktree: { id: 'w', state: 'missing' } }))
    expect(host.querySelector('[data-worktree-mark="missing"]')?.textContent).toBe('工作树不见了')
  })
})

describe('在独立工作树中运行 in the composer launcher', () => {
  const menu = (sessionId: string | null = null) => createElement(ComposerMenu, {
    ref: createRef<ComposerMenuHandle>(), source: 'launcher', query: '', context: { sessionId, projectId: 'p1', status: 'idle', mode: 'build' }, catalog: null, busy: false, skills: [], attachedSkills: [], onChoose: () => {}, onClose: () => {},
  })
  beforeEach(() => {
    // jsdom has no layout: the menu scrolls its active row into view.
    Element.prototype.scrollIntoView ??= () => {}
    useApp.setState({ projects: { p1: { id: 'p1', name: 'P', workspacePath: '/p', git: { sessionWorktreeDefault: true } } } })
  })

  it('ends a project’s new-conversation launcher (next to the composer), starts at the project’s default, and flips without closing', async () => {
    await show(menu())
    const row = host.querySelector('[data-worktree-switch]')!
    expect([...host.querySelectorAll('[role="option"]')].at(-1)).toBe(row)
    expect(row.textContent).toContain('在独立工作树中运行')
    expect(row.getAttribute('aria-checked')).toBe('true')
    await click(row)
    expect(useIsolation.getState().choice).toEqual({ p1: false })
    expect(host.querySelector('[data-worktree-switch]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('the chip above a new conversation’s editor shows while it is on; × turns it off', async () => {
    await show(createElement(WorktreeChip, { projectId: 'p1' }))
    expect(host.querySelector('[data-worktree-chip]')?.textContent).toBe('独立工作树')
    await click(host.querySelector('[data-worktree-chip] button'))
    expect(useIsolation.getState().choice).toEqual({ p1: false })
    expect(host.querySelector('[data-worktree-chip]')).toBeNull()
  })

  it('greyed out with the reason where isolation is off; not offered behind the release gate or in an existing conversation', async () => {
    isolation = { enabled: false, reason: 'no_repository', git: '2.39.5' }
    await show(menu())
    const row = host.querySelector('[data-worktree-switch]')!
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('项目文件夹还不是 Git 仓库')
    await click(row)
    expect(useIsolation.getState().choice).toEqual({})
    // A fresh menu each time (the conditions are read when it opens).
    const reopen = async (node: ReturnType<typeof menu>) => { act(() => root.unmount()); root = createRoot(host); resetIsolation(); await show(node) }
    isolation = { enabled: false, reason: 'not_ready', git: '2.39.5' }
    await reopen(menu())
    expect(host.querySelector('[data-worktree-switch]')).toBeNull()
    isolation = { enabled: true, git: '2.39.5' }
    await reopen(menu('s1'))
    expect(host.querySelector('[data-worktree-switch]')).toBeNull()
  })
})
