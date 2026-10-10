/**
 * 本轮交付, the turn footer's count and 审阅 from the host's answer for a turn (GET …/turns/:turnId/changes): what
 * reached the project folder, file by file, instead of the turn's edit snippets added up — and the tool calls again
 * whenever the host cannot say (`tools`) or the read fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import type { Item, ProjectSummary, Turn } from '@/api/types'
import type { ApplyRecord, TurnChanges, TurnPatch } from '@/api/worktree-api'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetIsolation, useIsolation } from '@/store/isolation-store'
import { RETRY_MS, resetTurnChanges, turnChangesVersion } from '@/store/turn-changes-store'
import { currentPane, resetSidePanel } from '@/store/side-panel-store'
import { Review } from '@/components/side-panel/DetailTabs'
import { Deliverables } from './Deliverables'
import { TurnApplyLine } from './TurnApply'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: { method: string; path: string }[] = []
let records: ApplyRecord[] = []
let answer: TurnChanges | 'fail' = { source: 'tools', reason: 'pending' }
let patches: TurnPatch[] = []
let patchesFail = false
const transport: Transport = {
  kind: 'mock',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    calls.push({ method: init.method ?? 'GET', path })
    if (path.includes('/applies?')) return { applies: records } as T
    if (path.includes('/changes/patches')) {
      if (patchesFail) throw new Error('Git took too long to answer. Try again shortly.')
      const asked = new URLSearchParams(path.slice(path.indexOf('?'))).getAll('path')
      return { patches: patches.filter(row => asked.includes(row.path)) } as T
    }
    if (/\/turns\/t1\/changes(\?|$)/.test(path)) {
      if (answer === 'fail') throw new Error('offline')
      return answer as T
    }
    return {} as T
  },
  openStream: () => { throw new Error('no streams') },
}

const tool = (id: string, name: string, args: Record<string, unknown>) => ({ id, kind: 'tool', turnId: 't1', createdAt: '', text: '', tool: { name, status: 'succeeded', args } }) as unknown as Item
const BLOCK = '<<<<<<< refs/rna/m/abc/this-conversation\ntwo\nx1\nx2\nx3\n=======\nTWO\n>>>>>>> refs/rna/m/abc/project-folder\n'
/** The live turn this reproduces: three lines added, then a conflict the continuation merged by hand. */
const edits = (): Record<string, Item> => ({
  e1: tool('e1', 'project_edit', { path: 'src/calc.js', oldText: 'two\n', newText: 'two\nx1\nx2\nx3\n' }),
  e2: tool('e2', 'project_edit', { path: 'src/calc.js', oldText: BLOCK, newText: 'TWO\nx1\nx2\nx3\n' }),
})
const record = (patch: Partial<ApplyRecord> = {}): ApplyRecord => ({ id: 'ap-1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 't1' }, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: [], at: '', rollback: { available: true }, ...patch })

function seed(turn: Partial<Turn>, items: Record<string, Item> = edits()) {
  const project: ProjectSummary = { id: 'p1', name: 'P', workspacePath: '/p', permissions: { workspace: 'write' }, git: { sessionWorktreeDefault: false } }
  const meta = { id: 's1', title: 'S', status: 'idle', projectId: 'p1' }
  useApp.setState({
    projects: { p1: project }, sessionIndex: { s1: meta } as never,
    sessions: { s1: { meta, items, order: Object.keys(items), turns: { t1: { id: 't1', status: 'completed', ...turn } }, phases: {}, structure: { signature: '', rows: [] }, revision: 1, needsResync: false } as never },
  })
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  calls = []; records = [record()]; answer = { source: 'tools', reason: 'pending' }; patches = []; patchesFail = false
  resetIsolation(); resetTurnChanges(); resetSidePanel(); setTransport(transport); useUi.setState({ toasts: [], disclosure: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetIsolation(); resetTurnChanges(); vi.restoreAllMocks() })

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const show = async (node: ReturnType<typeof createElement>) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await settle() }
/** Each 本轮交付 row: its path, and its text (name, folder, marks, counts) run together. */
const rows = () => [...host.querySelectorAll('[data-deliverable]')].map(row => [row.getAttribute('data-deliverable'), row.textContent?.replace(/\s+/g, '')])
const changesCalls = () => calls.filter(call => /\/turns\/t1\/changes\?/.test(call.path))
const deliverables = (itemIds = ['e1', 'e2']) => createElement(Deliverables, { sessionId: 's1', itemIds, turnId: 't1' })
const applied = { apply: { status: 'applied', applyIds: ['ap-1'] } }

describe('本轮交付 from the host', () => {
  it('a worktree turn whose conflict a continuation merged: the net +3 that reached the folder, not the snippets added up', async () => {
    answer = { source: 'records', files: [{ path: 'src/calc.js', status: 'M', added: 3, removed: 0 }, { path: 'src/util.js', status: 'A', added: 2, removed: 0 }], applyIds: ['ap-1'] }
    seed(applied)
    await show(deliverables())
    expect(changesCalls().map(call => call.path)).toEqual(['/api/v2/projects/p1/turns/t1/changes?sessionId=s1'])
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+3'], ['src/util.js', 'util.jssrc新建+2']])
    expect(host.querySelector('section')?.textContent).toContain('修改了 2 个文件')
    // The file the host says was created is a produced card, as a created file is today.
    expect(host.querySelector('section')?.textContent).toContain('util.js')
    expect([...host.querySelectorAll('button')].some(b => b.textContent?.includes('util.js') && !b.hasAttribute('data-deliverable'))).toBe(true)
    // Read once for this version: another render asks for nothing.
    await show(deliverables())
    expect(changesCalls()).toHaveLength(1)
    // A row opens 审阅 on the turn's host files, at that file.
    await act(async () => { (host.querySelector('[data-deliverable="src/calc.js"]') as HTMLElement).click() })
    expect(currentPane().tabs.find(tab => tab.type === 'review')).toMatchObject({ sessionId: 's1', turnId: 't1', focusPath: 'src/calc.js', itemIds: ['e1', 'e2'] })
  })

  it('the host cannot say (`tools`), or the read fails: the tool calls stay, a snippet’s missing newline no longer counted', async () => {
    seed(applied)
    await show(deliverables())
    // +3 and +1 −5 (the merged block; its last line no longer counted twice) per call, added up.
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+4−5']])
    act(() => root.unmount()); root = createRoot(host); resetTurnChanges()
    answer = 'fail'
    await show(deliverables())
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+4−5']])
  })

  it('a direct-mode turn whose only write was a worker merge: the file shows, and the footer counts it instead of 本轮执行过命令', async () => {
    const items = { x1: tool('x1', 'project_exec', { command: 'npm test' }) }
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'taken' } }, items)
    records = [record({ kind: 'worker', source: { sessionId: 's1', turnId: 't1', agentId: 'ag-1' } })]
    answer = { source: 'tools', reason: 'no_checkpoint' }
    await show(createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['x1'] }))
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮执行过命令')
    act(() => root.unmount()); root = createRoot(host); resetTurnChanges()
    answer = { source: 'checkpoint', files: [{ path: 'src/calc.js', status: 'M', added: 1, removed: 0 }] }
    await show(createElement('div', null, deliverables(['x1']), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['x1'] })))
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+1']])
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮改动 1 个文件')
    // One read for both (the first render's read was for the earlier answer).
    expect(changesCalls()).toHaveLength(2)
  })

  it('a rollback since moves the version: read again, the files marked 已回退', async () => {
    answer = { source: 'records', files: [{ path: 'src/calc.js', status: 'M', added: 3, removed: 0 }], applyIds: ['ap-1'] }
    seed(applied)
    await show(deliverables())
    expect(rows()[0][1]).not.toContain('已回退')
    answer = { source: 'records', files: [{ path: 'src/calc.js', status: 'M', added: 3, removed: 0, rolledBack: true }], applyIds: ['ap-1'] }
    // The isolation store reads the conversation's records again (a push said the turn moved): a new version.
    await act(async () => { useIsolation.setState(s => ({ applies: { ...s.applies, s1: { ...s.applies.s1!, data: [record({ state: 'rolled_back', rolledBackBy: 'ap-rb' }), record({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1' })] } } })) })
    await settle()
    expect(changesCalls()).toHaveLength(2)
    expect(rows()[0][1]).toContain('已回退')
  })

  it('nothing is read for a turn the host would answer `tools` for, or one still running', async () => {
    seed({})
    await show(deliverables())
    for (const turn of [{ status: 'running', ...applied }, { apply: { status: 'pending', applyIds: [] } }, { apply: { status: 'conflicted', applyIds: [] } }, { checkpoint: { state: 'skipped', reason: 'timeout' } }, { checkpoint: { state: 'expired' } }]) {
      seed(turn as Partial<Turn>)
      await settle()
    }
    expect(changesCalls()).toHaveLength(0)
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+4−5']])
  })

  it('the version names what can still change the answer', () => {
    const turn = { status: 'completed', apply: { status: 'applied', applyIds: ['ap-1'] } } as Turn
    const one = turnChangesVersion(turn, [record()])
    expect(turnChangesVersion(turn, [record()])).toBe(one)
    expect(turnChangesVersion(turn, [record({ state: 'rolled_back' })])).not.toBe(one)
    expect(turnChangesVersion({ ...turn, apply: { status: 'applied', applyIds: ['ap-1', 'ap-2'] } }, [record()])).not.toBe(one)
    expect(turnChangesVersion({ ...turn, checkpoint: { state: 'expired' } }, [record()])).not.toBe(one)
  })

  it('the version names the attempt: a retried turn that fails again, or a turn paused again after a resume, is read again', () => {
    const checkpoint = { ref: 'refs/rna/turn/t1', state: 'taken', endedAt: '2026-10-04T08:00:10.000Z' }
    const first = { status: 'failed', attemptStartedAt: '2026-10-04T08:00:00.000Z', completedAt: '2026-10-04T08:00:09.000Z', checkpoint } as Turn
    const again = { ...first, attemptStartedAt: '2026-10-04T08:00:20.000Z', completedAt: '2026-10-04T08:00:29.000Z', retryHistory: [{ status: 'failed', completedAt: first.completedAt }], checkpoint: { ...checkpoint, endedAt: '2026-10-04T08:00:30.000Z' } } as Turn
    expect(turnChangesVersion(again, [])).not.toBe(turnChangesVersion(first, []))
    // The second attempt's status is already in while its end is still being recorded: the end moves it once more.
    expect(turnChangesVersion({ ...again, checkpoint }, [])).not.toBe(turnChangesVersion(again, []))
    const paused = { status: 'paused', attemptStartedAt: '2026-10-04T08:00:00.000Z', checkpoint } as Turn
    expect(turnChangesVersion({ ...paused, attemptStartedAt: '2026-10-04T08:05:00.000Z' }, [])).not.toBe(turnChangesVersion(paused, []))
  })

  it('a turn none of whose calls could change a file, and with no records of its own, asks nothing; one with a write, a command or a record does', async () => {
    const checkpoint = { ref: 'refs/rna/turn/t1', state: 'taken' }
    records = []
    answer = { source: 'checkpoint', files: [] }
    // Chat only, then only reads and searches.
    seed({ checkpoint }, {})
    await show(createElement('div', null, deliverables([]), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: [] })))
    const reads = { r1: tool('r1', 'project_read', { path: 'a.txt' }), r2: tool('r2', 'project_grep', { pattern: 'x' }), r3: tool('r3', 'web_search', { query: 'x' }) }
    seed({ checkpoint }, reads)
    await show(createElement('div', null, deliverables(['r1', 'r2', 'r3']), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['r1', 'r2', 'r3'] })))
    expect(changesCalls()).toHaveLength(0)
    expect(host.querySelector('[data-turn-apply]')).toBeNull()
    // A command may change files it never names: asked.
    seed({ checkpoint }, { ...reads, x1: tool('x1', 'project_exec', { command: 'npm run format' }) })
    await show(createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['r1', 'x1'] }))
    expect(changesCalls()).toHaveLength(1)
    // No call that writes, but a record of the turn (a worker's merge): asked.
    act(() => root.unmount()); root = createRoot(host); resetTurnChanges(); resetIsolation(); calls = []
    records = [record({ kind: 'worker', source: { sessionId: 's1', turnId: 't1', agentId: 'ag-1' } })]
    seed({ checkpoint }, reads)
    await show(deliverables(['r1']))
    expect(changesCalls()).toHaveLength(1)
  })

  it('an edited file the checkpoint does not hold (ignored, too big) stays listed and counted with the tool calls’ numbers', async () => {
    const items = { e1: tool('e1', 'project_edit', { path: '.env.local', oldText: 'A=1\n', newText: 'A=2\n' }), e2: tool('e2', 'project_edit', { path: 'src/calc.js', oldText: 'a\n', newText: 'b\n' }) }
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'taken' } }, items)
    records = []
    answer = { source: 'checkpoint', files: [], uncovered: ['.env.local'] }
    await show(createElement('div', null, deliverables(['e1']), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['e1'] })))
    expect(rows()).toEqual([['.env.local', '.env.local不在检查点里+1−1']])
    expect(host.querySelector('section')?.textContent).toContain('修改了 1 个文件')
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮改动 1 个文件')
    // 审阅 on that file shows the turn's own call to it (the host has no diff of it); 审阅全部 stays the host's.
    await show(createElement(Review, { sessionId: 's1', itemIds: ['e1'], turnId: 't1', focusPath: '.env.local' }))
    expect(host.querySelector('[data-host-review]')).toBeNull()
    expect(host.textContent).toContain('A=2')
    await show(createElement(Review, { sessionId: 's1', itemIds: ['e1'], turnId: 't1' }))
    expect(host.textContent).toContain('另有 1 个文件被忽略或太大')
  })

  it('a file the turn wrote that another owner also wrote meanwhile stays listed (shared) and counted; one that only changed while it ran is marked and not counted', async () => {
    const items = { e1: tool('e1', 'project_edit', { path: 'ch12.md', oldText: 'a\n', newText: 'b\nc\n' }), x1: tool('x1', 'project_exec', { command: 'npm run format' }) }
    seed({ checkpoint: { ref: 'refs/rna/turn/t1', state: 'taken' } }, items)
    records = []
    answer = { source: 'checkpoint', files: [{ path: 'README.md', status: 'M', added: 1, removed: 1, unattributed: true }, { path: 'src/calc.js', status: 'M', added: 2, removed: 0 }], shared: [{ path: 'ch12.md', applyId: 'ap-other' }, { path: 'notes.md', applyId: 'ap-other' }] }
    await show(createElement('div', null, deliverables(['e1', 'x1']), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['e1', 'x1'] })))
    // The turn's own file, then the shared ones (ch12.md with its call's counts; notes.md has no call to count from), then the unattributed one.
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+2'], ['ch12.md', 'ch12.md也被别处改过+2−1'], ['notes.md', 'notes.md也被别处改过'], ['README.md', 'README.md来源不确定+1−1']])
    expect(host.querySelector('section')?.textContent).toContain('修改了 3 个文件')
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮改动 3 个文件')
    // Only files that changed while the turn ran: said as such, not as the turn's.
    act(() => root.unmount()); root = createRoot(host); resetTurnChanges()
    answer = { source: 'checkpoint', files: [{ path: 'README.md', status: 'M', added: 1, removed: 1, unattributed: true }] }
    await show(createElement('div', null, deliverables(['x1']), createElement(TurnApplyLine, { sessionId: 's1', turnId: 't1', running: false, toolIds: ['x1'] })))
    expect(host.querySelector('section')?.textContent).toContain('本轮运行期间有 1 个文件变了')
    expect(host.querySelector('[data-turn-apply="checkpoint"]')?.textContent).toContain('本轮执行过命令')
  })

  it('a failed read, or git away, is asked again on a later mount once a short while has passed; a settled answer is not', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const remount = async () => { act(() => root.unmount()); root = createRoot(host); await show(deliverables()) }
    seed(applied)
    answer = 'fail'
    await show(deliverables())
    expect(changesCalls()).toHaveLength(1)
    await remount()
    expect(changesCalls()).toHaveLength(1)
    now += RETRY_MS
    answer = { source: 'tools', reason: 'git_unavailable' }
    await remount()
    expect(changesCalls()).toHaveLength(2)
    now += RETRY_MS
    answer = { source: 'records', files: [{ path: 'src/calc.js', status: 'M', added: 3, removed: 0 }], applyIds: ['ap-1'] }
    await remount()
    expect(changesCalls()).toHaveLength(3)
    expect(rows()).toEqual([['src/calc.js', 'calc.jssrc+3']])
    now += RETRY_MS * 10
    await remount()
    expect(changesCalls()).toHaveLength(3)
  })
})

describe('审阅 with a turn', () => {
  const patch = (body: string) => ({ kind: 'patch' as const, patch: `diff --git a/src/calc.js b/src/calc.js\n--- a/src/calc.js\n+++ b/src/calc.js\n${body}` })

  it('lists the host’s files and shows their patches; a file changed between records shows one diff per record', async () => {
    answer = { source: 'records', applyIds: ['ap-1', 'ap-2'], files: [
      { path: 'src/calc.js', status: 'M', added: 3, removed: 0 },
      { path: 'src/other.js', status: 'M', added: 2, removed: 2, changedBetween: true, sections: [
        { applyId: 'ap-1', at: '', kind: 'turn', status: 'M', added: 1, removed: 1 }, { applyId: 'ap-2', at: '', kind: 'turn', status: 'M', added: 1, removed: 1 }] },
    ] }
    patches = [
      { path: 'src/calc.js', diff: patch('@@ -1,3 +1,6 @@\n one\n TWO\n+x1\n+x2\n+x3\n three\n') },
      { path: 'src/other.js', sections: [{ applyId: 'ap-1', diff: patch('@@ -1 +1 @@\n-a\n+A\n') }, { applyId: 'ap-2', diff: patch('@@ -3 +3 @@\n-c\n+C\n') }] },
    ]
    seed(applied)
    await show(createElement(Review, { sessionId: 's1', itemIds: ['e1', 'e2'], turnId: 't1', focusPath: 'src/other.js' }))
    expect(host.textContent).toContain('2 个文件 · +5 −2')
    expect([...host.querySelectorAll('[data-review-file]')].map(tab => tab.getAttribute('data-review-file'))).toEqual(['src/calc.js', 'src/other.js'])
    // Opened on the file asked for: one diff per record, under the note that someone else changed it in between.
    expect(host.querySelector('[data-review-note]')?.textContent).toContain('还被别处改过')
    expect([...host.querySelectorAll('[data-review-section]')].map(row => row.getAttribute('data-review-section'))).toEqual(['ap-1', 'ap-2'])
    // Both files' patches came in one request (the first batch).
    expect(calls.filter(call => call.path.includes('/changes/patches')).map(call => call.path)).toEqual(['/api/v2/projects/p1/turns/t1/changes/patches?sessionId=s1&path=src%2Fcalc.js&path=src%2Fother.js'])
    await act(async () => { (host.querySelector('[data-review-file="src/calc.js"]') as HTMLElement).click() }); await settle()
    const shown = host.querySelector('[data-host-review]')!.textContent!
    expect(shown).toContain('x3')
    expect(shown).not.toContain('<<<<<<<')
    expect(host.querySelector('[data-review-section]')).toBeNull()
    expect(calls.filter(call => call.path.includes('/changes/patches'))).toHaveLength(1)
  })

  it('patches that could not be read are read again when a file is chosen again', async () => {
    answer = { source: 'records', applyIds: ['ap-1'], files: [{ path: 'src/calc.js', status: 'M', added: 3, removed: 0 }, { path: 'src/util.js', status: 'A', added: 1, removed: 0 }] }
    patches = [{ path: 'src/calc.js', diff: patch('@@ -1,2 +1,3 @@\n one\n+x3\n three\n') }, { path: 'src/util.js', diff: patch('@@ -0,0 +1 @@\n+util\n') }]
    patchesFail = true
    seed(applied)
    await show(createElement(Review, { sessionId: 's1', itemIds: ['e1', 'e2'], turnId: 't1' }))
    expect(host.querySelector('[data-host-review]')?.textContent).toContain('Git took too long')
    patchesFail = false
    // The same file chosen again: read again.
    await act(async () => { (host.querySelector('[data-review-file="src/calc.js"]') as HTMLElement).click() }); await settle()
    expect(host.querySelector('[data-host-review]')?.textContent).toContain('x3')
    expect(calls.filter(call => call.path.includes('/changes/patches'))).toHaveLength(2)
    // The other file of that batch came with it.
    await act(async () => { (host.querySelector('[data-review-file="src/util.js"]') as HTMLElement).click() }); await settle()
    expect(host.querySelector('[data-host-review]')?.textContent).toContain('util')
    expect(calls.filter(call => call.path.includes('/changes/patches'))).toHaveLength(2)
  })

  it('without a host answer it shows the turn’s calls, one diff per call', async () => {
    seed(applied)
    await show(createElement(Review, { sessionId: 's1', itemIds: ['e1', 'e2'], turnId: 't1' }))
    expect(host.querySelector('[data-host-review]')).toBeNull()
    expect(host.textContent).toContain('1 个文件 · +4 −5')
    expect(calls.filter(call => call.path.includes('/changes/patches'))).toHaveLength(0)
  })
})
