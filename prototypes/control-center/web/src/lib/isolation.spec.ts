// @vitest-environment node
/** Worktree isolation in words and states (0.63, worktree design §4, §5, §12): computed from the host's fields only. */
import { describe, expect, it } from 'vitest'
import type { ApplyRecord } from '@/api/worktree-api'
import type { Turn } from '@/api/types'
import { conflictKindText, heldReasonText, isolationReasonText, settleable, skippedReasonText, subagentMergeView, turnApplyView, type TurnApplyInput } from './isolation'

const rec = (patch: Partial<ApplyRecord>): ApplyRecord => ({
  id: 'ap-1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 't1' }, state: 'verified', files: 2, added: 0, removed: 0, bothChanged: 0, sample: [], at: '2026-10-04T00:00:00Z', rollback: { available: true }, ...patch,
})
const view = (turn: Partial<Turn>, patch: Partial<TurnApplyInput> = {}) =>
  turnApplyView({ turn: { status: 'completed', ...turn } as Turn, running: false, records: [], loaded: true, changed: 0, commands: false, ...patch })

describe('turnApplyView: a worktree conversation’s turn', () => {
  it('applying, and merging the project folder’s side while the turn continues', () => {
    expect(view({ apply: { status: 'applying', applyIds: [] } }, { running: true })).toEqual({ kind: 'applying' })
    const conflict = { id: 'c1', paths: [{ path: 'a.ts', kind: 'content' }, { path: 'b.png', kind: 'binary' }], attempts: 1 }
    expect(view({ apply: { status: 'conflicted', applyIds: [], conflict } }, { running: true })).toEqual({ kind: 'merging', files: 2 })
    // A running turn without a conflict says nothing yet.
    expect(view({ apply: { status: 'none', applyIds: [] } }, { running: true })).toEqual({ kind: 'none' })
  })

  it('conflicted after the continuations (the card decides), or stopped with changes left in the worktree', () => {
    const conflict = { id: 'c1', paths: [{ path: 'a.ts', kind: 'content' }], attempts: 2 }
    expect(view({ apply: { status: 'conflicted', applyIds: [], conflict } })).toEqual({ kind: 'conflicted', files: 1, paths: conflict.paths })
    expect(view({ apply: { status: 'pending', applyIds: ['ap-1'], conflict } })).toEqual({ kind: 'pending', files: 1, paths: conflict.paths, reason: null })
    // Held by the host without a conflict (the project went read-only): its reason rides along.
    expect(view({ apply: { status: 'pending', applyIds: [], reason: 'read_only' } })).toEqual({ kind: 'pending', files: 0, paths: [], reason: 'read_only' })
    // Held on the user's git operation in the project folder: applied by the host once it ends, and the footer says so.
    expect(view({ apply: { status: 'pending', applyIds: [], reason: 'git_operation' } })).toEqual({ kind: 'pending', files: 0, paths: [], reason: 'git_operation' })
    expect(heldReasonText('git_operation')).toBe('项目文件夹正在进行 Git 操作，结束后自动应用')
  })

  it('applied: files from its turn records once read, the user’s own changes counted by the host', () => {
    const apply = { status: 'applied', applyIds: ['ap-1', 'ap-2'], bothChanged: 1 }
    expect(view({ apply }, { loaded: false })).toEqual({ kind: 'applied', files: null, bothChanged: 1, applyIds: ['ap-1', 'ap-2'], expired: false })
    expect(view({ apply }, { records: [rec({ id: 'ap-1', files: 2 }), rec({ id: 'ap-2', files: 3 })] })).toMatchObject({ kind: 'applied', files: 5 })
  })

  it('rolled back once none of its turn records stands, undone through the rollback record', () => {
    const apply = { status: 'applied', applyIds: ['ap-1'] }
    const records = [rec({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1' })]
    expect(view({ apply }, { records })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
    // The rollback undone in turn (listed or not): the turn's write stands again.
    const undone = [rec({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-again' }), rec({ id: 'ap-again', kind: 'rollback', undoes: 'ap-rb' })]
    expect(view({ apply }, { records: undone })).toMatchObject({ kind: 'applied', files: 2 })
    expect(view({ apply }, { records: undone.slice(0, 2) })).toMatchObject({ kind: 'applied' })
  })
})

describe('turnApplyView: a direct-mode turn', () => {
  it('offers its checkpoint when it changed files or ran a command, and says when there is none', () => {
    const checkpoint = { ref: 'refs/rna/turn/t1', state: 'taken' }
    expect(view({ checkpoint })).toEqual({ kind: 'none' })
    expect(view({ checkpoint }, { changed: 3 })).toEqual({ kind: 'checkpoint', files: 3 })
    expect(view({ checkpoint }, { commands: true })).toEqual({ kind: 'checkpoint', files: 0 })
    expect(view({ checkpoint: { state: 'skipped', reason: 'timeout' } }, { changed: 1 })).toEqual({ kind: 'no_checkpoint', files: 1, reason: 'timeout' })
    expect(view({ checkpoint }, { changed: 1, running: true })).toEqual({ kind: 'none' })
  })

  it('a turn rolled back offers 撤销 through its rollback record; once that is undone, the checkpoint again', () => {
    // The host's turn rollback names the turn (`undoesTurn`).
    const records = [{ ...rec({ id: 'ap-rb', kind: 'rollback' }), undoesTurn: 't1' }]
    expect(view({ checkpoint: { state: 'taken' } }, { changed: 1, records })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
    const undone = [{ ...rec({ id: 'ap-rb', kind: 'rollback', state: 'rolled_back', rolledBackBy: 'ap-x' }), undoesTurn: 't1' }, rec({ id: 'ap-x', kind: 'rollback', undoes: 'ap-rb' })]
    expect(view({ checkpoint: { state: 'taken' } }, { changed: 1, records: undone })).toEqual({ kind: 'checkpoint', files: 1 })
    expect(view({ checkpoint: { state: 'taken' } }, { changed: 1, records: undone.slice(0, 1) })).toEqual({ kind: 'checkpoint', files: 1 })
  })
})

describe('turnApplyView with the host’s count of the turn’s files (GET …/turns/:turnId/changes)', () => {
  it('a direct-mode turn whose only write was a worker merge counts that file instead of 本轮执行过命令', () => {
    const checkpoint = { ref: 'refs/rna/turn/t1', state: 'taken' }
    // No edit or write call (agent_merge only, which counts as a command run): the tool calls give 0 files.
    expect(view({ checkpoint }, { changed: 0, commands: true })).toEqual({ kind: 'checkpoint', files: 0 })
    expect(view({ checkpoint }, { changed: 0, commands: true, hostChanged: 1 })).toEqual({ kind: 'checkpoint', files: 1 })
    expect(view({ checkpoint }, { changed: 0, commands: false, hostChanged: 1 })).toEqual({ kind: 'checkpoint', files: 1 })
    // Edits the turn put back itself: the host says nothing changed, so nothing is offered.
    expect(view({ checkpoint }, { changed: 2, hostChanged: 0 })).toEqual({ kind: 'none' })
    expect(view({ checkpoint: { state: 'expired' } }, { changed: 0, commands: true, hostChanged: 2 })).toEqual({ kind: 'checkpoint_expired', files: 2 })
    // Not known yet (null): the tool calls' count stands.
    expect(view({ checkpoint }, { changed: 3, hostChanged: null })).toEqual({ kind: 'checkpoint', files: 3 })
  })

  it('a worktree turn whose records both wrote one file counts it once', () => {
    const apply = { status: 'applied', applyIds: ['ap-1', 'ap-2'] }
    const records = [rec({ id: 'ap-1', files: 2 }), rec({ id: 'ap-2', files: 2 })]
    expect(view({ apply }, { records })).toMatchObject({ kind: 'applied', files: 4 })
    expect(view({ apply }, { records, hostChanged: 3 })).toMatchObject({ kind: 'applied', files: 3 })
    expect(view({ apply }, { records, loaded: false, hostChanged: 3 })).toMatchObject({ kind: 'applied', files: 3 })
  })
})

describe('turnApplyView past retention (0.63.x)', () => {
  it('a direct-mode turn whose checkpoint the host marks expired offers no 回退本轮 any more', () => {
    expect(view({ checkpoint: { state: 'expired' } }, { changed: 2 })).toEqual({ kind: 'checkpoint_expired', files: 2 })
    expect(view({ checkpoint: { state: 'expired' } }, { commands: true })).toEqual({ kind: 'checkpoint_expired', files: 0 })
    // Nothing changed and no command ran: nothing to say.
    expect(view({ checkpoint: { state: 'expired' } })).toEqual({ kind: 'none' })
    // A turn rolled back before its rollback record expired: 已回退, without 撤销 once that record is past retention too.
    const records = [rec({ id: 'ap-rb', kind: 'rollback', undoesTurn: 't1', state: 'expired' })]
    expect(view({ checkpoint: { state: 'expired' } }, { changed: 1, records })).toEqual({ kind: 'rolled_back', undo: null, left: [] })
  })

  it('a worktree turn whose records expired is still applied, with no 回退', () => {
    const apply = { status: 'applied', applyIds: ['ap-1', 'ap-2'] }
    expect(view({ apply }, { records: [rec({ id: 'ap-1', state: 'expired' }), rec({ id: 'ap-2', state: 'expired' })] })).toMatchObject({ kind: 'applied', files: 4, expired: true })
    // One of them past retention is enough: the host refuses the whole turn (apply_expired).
    expect(view({ apply }, { records: [rec({ id: 'ap-1', state: 'expired' }), rec({ id: 'ap-2' })] })).toMatchObject({ kind: 'applied', expired: true })
    expect(view({ apply }, { records: [rec({ id: 'ap-1' }), rec({ id: 'ap-2' })] })).toMatchObject({ kind: 'applied', expired: false })
    // Rolled back, the rollback itself expired: no 撤销.
    const rolled = [rec({ id: 'ap-1', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-1', state: 'expired' })]
    expect(view({ apply: { status: 'applied', applyIds: ['ap-1'] } }, { records: rolled })).toEqual({ kind: 'rolled_back', undo: null, left: [] })
  })
})

describe('turnApplyView against the host’s records (0.63 review)', () => {
  it('a worktree turn counts and rolls back its writes into the project folder only, not the syncs into its worktree', () => {
    const apply = { status: 'applied', applyIds: ['ap-p'] }
    // The host records the turn-start sync and the merge back into S under the same turn (target session:<id>).
    const sync = rec({ id: 'ap-s1', target: 'session:s1', files: 7, rollback: { available: false, reason: 'target' } })
    const back = rec({ id: 'ap-s2', target: 'session:s1', files: 4, rollback: { available: false, reason: 'target' } })
    expect(view({ apply }, { records: [sync, rec({ id: 'ap-p', files: 2 }), back] })).toMatchObject({ kind: 'applied', files: 2 })
    // Rolled back: the project record is; the worktree's never are (no rollback offered for them).
    const rolled = [sync, rec({ id: 'ap-p', state: 'rolled_back', rolledBackBy: 'ap-rb' }), back, { ...rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-p' }), undoesTurn: 't1' }]
    expect(view({ apply }, { records: rolled })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
  })

  it('a conflict settled with the conversation’s version (a resolve record) is counted and is part of the turn: rolled back with it', () => {
    const apply = { status: 'applied', applyIds: ['ap-p', 'ap-res'] }
    const records = [rec({ id: 'ap-p', files: 2 }), rec({ id: 'ap-res', kind: 'resolve', files: 1 })]
    expect(view({ apply }, { records })).toMatchObject({ kind: 'applied', files: 3 })
    // The host's turn rollback takes both (one rollback record, undoesTurn): 已回退, nothing left over.
    const both = [rec({ id: 'ap-p', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-res', kind: 'resolve', files: 1, state: 'rolled_back', rolledBackBy: 'ap-rb' }), { ...rec({ id: 'ap-rb', kind: 'rollback' }), undoesTurn: 't1' }]
    expect(view({ apply }, { records: both })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
    // Only the turn record rolled back (from 应用记录): the resolve still stands, so the turn is applied and 回退 takes the rest.
    const one = [rec({ id: 'ap-p', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-res', kind: 'resolve', files: 1 }), rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-p' })]
    expect(view({ apply }, { records: one })).toMatchObject({ kind: 'applied' })
    // Nothing clean to write, only the card's take: that resolve is the turn's write, and its rollback reads 已回退.
    const take = { status: 'applied', applyIds: ['ap-res'] }
    expect(view({ apply: take }, { records: [rec({ id: 'ap-res', kind: 'resolve', files: 1 })] })).toMatchObject({ kind: 'applied', files: 1 })
    const taken = [rec({ id: 'ap-res', kind: 'resolve', files: 1, state: 'rolled_back', rolledBackBy: 'ap-rb' }), { ...rec({ id: 'ap-rb', kind: 'rollback' }), undoesTurn: 't1' }]
    expect(view({ apply: take }, { records: taken })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
    // A resolve that undid an interrupted apply (`undoes`) is not the turn's write: it neither holds the turn applied nor counts as left over.
    const restore = rec({ id: 'ap-back', kind: 'resolve', files: 1, undoes: 'ap-x' })
    expect(view({ apply: { status: 'applied', applyIds: ['ap-p', 'ap-back'] } }, { records: [rec({ id: 'ap-p', state: 'rolled_back', rolledBackBy: 'ap-rb' }), restore, { ...rec({ id: 'ap-rb', kind: 'rollback' }), undoesTurn: 't1' }] })).toEqual({ kind: 'rolled_back', undo: 'ap-rb', left: [] })
  })

  it('a direct-mode turn is not shown rolled back when only one of its records was (a worker merge dropped from its card)', () => {
    const records = [rec({ id: 'ap-w', kind: 'worker', state: 'rolled_back', rolledBackBy: 'ap-rb' }), rec({ id: 'ap-rb', kind: 'rollback', undoes: 'ap-w' })]
    expect(view({ checkpoint: { state: 'taken' } }, { changed: 2, records })).toEqual({ kind: 'checkpoint', files: 2 })
  })
})

describe('subagentMergeView (design §4.1 table)', () => {
  it('merged, conflicts waiting on the main conversation or the user, not merged, dropped, shared root', () => {
    expect(subagentMergeView({ status: 'running', merge: { status: 'pending' } }, false)).toEqual({ kind: 'none' })
    expect(subagentMergeView({ status: 'completed', merge: { status: 'merged', files: 4, applyIds: ['a1'] } }, false)).toEqual({ kind: 'merged', files: 4, applyIds: ['a1'] })
    // Its conflicts were settled by keeping the parent's files as they were: nothing written, nothing to roll back.
    expect(subagentMergeView({ status: 'completed', merge: { status: 'merged', files: 0, applyIds: [] } }, false)).toEqual({ kind: 'merged', files: 0, applyIds: [] })
    const conflicts = [{ path: 'a.ts', kind: 'content' }]
    expect(subagentMergeView({ status: 'completed', merge: { status: 'conflict', conflicts } }, true)).toEqual({ kind: 'conflict', files: 1, paths: conflicts, waiting: true, unmerged: false })
    expect(subagentMergeView({ status: 'completed', merge: { status: 'conflict', conflicts } }, false)).toMatchObject({ waiting: false })
    // Merged all or nothing while its conversation was idle (A4): nothing written yet, so its clean files can still come in.
    expect(subagentMergeView({ status: 'completed', merge: { status: 'conflict', conflicts, files: 0, applyIds: [] } }, false)).toMatchObject({ kind: 'conflict', unmerged: true })
    // A partial merge wrote its clean part already.
    expect(subagentMergeView({ status: 'completed', merge: { status: 'conflict', conflicts, files: 2, applyIds: ['a1'] } }, false)).toMatchObject({ kind: 'conflict', unmerged: false })
    expect(subagentMergeView({ status: 'cancelled', merge: { status: 'pending', reason: 'cancelled' } }, false)).toEqual({ kind: 'pending', reason: 'cancelled' })
    expect(subagentMergeView({ status: 'completed', merge: { status: 'dropped' } }, false)).toEqual({ kind: 'dropped', reason: null, applyIds: [] })
    // Dropped after its merge was written: that merge was rolled back.
    expect(subagentMergeView({ status: 'completed', merge: { status: 'dropped', applyIds: ['a1'] } }, false)).toEqual({ kind: 'dropped', reason: null, applyIds: ['a1'] })
    // Its worktree was gone after a restart: the changes were lost, not dropped by anyone.
    expect(subagentMergeView({ status: 'interrupted', merge: { status: 'dropped', reason: 'missing' } }, false)).toEqual({ kind: 'dropped', reason: 'missing', applyIds: [] })
    expect(subagentMergeView({ status: 'completed', merge: { status: 'shared_root', reason: 'no_repository' } }, false)).toEqual({ kind: 'shared_root', reason: 'no_repository' })
    expect(subagentMergeView({ status: 'completed', merge: { status: 'nothing' } }, false)).toEqual({ kind: 'none' })
    expect(subagentMergeView({ status: 'completed' }, false)).toEqual({ kind: 'none' })
  })
})

describe('words', () => {
  it('names every isolation reason and conflict kind the host sends, and passes unknown ones through', () => {
    for (const reason of ['not_ready', 'sandbox_unavailable', 'git_unavailable', 'git_too_old', 'no_repository', 'custom_git_drivers', 'workspace_missing']) expect(isolationReasonText(reason)).not.toBe(reason)
    expect(isolationReasonText('something_new')).toBe('something_new')
    for (const kind of ['content', 'binary', 'modify_delete', 'add_add', 'rename', 'type', 'other', 'submodule', 'case_collision', 'unsafe_symlink', 'unsafe_hardlink', 'changed_during_merge', 'unexpected_file']) expect(conflictKindText(kind)).not.toBe(kind)
    // C5: a worker's merge into a conversation worktree that is gone is skipped by a drop, and the preview says why.
    for (const reason of ['changed_after', 'conflict', 'unattributable', 'worktree_gone']) expect(skippedReasonText(reason)).not.toBe(reason)
    expect(skippedReasonText('worktree_gone')).toBe('对话自己的工作副本已经不在了')
  })

  it('only kept, conflicted and unrecorded worktrees can be applied or discarded from the list', () => {
    expect(settleable({ kind: 'session', state: 'kept' })).toBe(true)
    expect(settleable({ kind: 'worker', state: 'conflicted' })).toBe(true)
    expect(settleable({ kind: 'orphan', state: 'active' })).toBe(true)
    expect(settleable({ kind: 'session', state: 'active' })).toBe(false)
  })
})
