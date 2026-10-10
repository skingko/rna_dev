/**
 * Worktree isolation in words and states (0.63, worktree design §4, §5, §12): why isolation is off, what kind of
 * conflict a file has, what an apply record or a worktree is, and — as pure functions of the host's fields — what a
 * turn's footer, a worker's card and a background change say. All of it is computed from the host's state; nothing
 * here judges meaning.
 */
import type { ConflictPath, SubagentInfo, Turn } from '@/api/types'
import type { ApplyRecord } from '@/api/worktree-api'
import { localized, t } from '@/i18n'

const REASONS: Record<string, string> = localized({
  not_ready: '这个版本还没有开放工作树隔离',
  sandbox_unavailable: '需要 macOS 沙箱，这台电脑上没有',
  git_unavailable: '没有找到 git',
  git_too_old: 'git 版本低于 2.38',
  no_repository: '项目文件夹还不是 Git 仓库',
  custom_git_drivers: '仓库配置了自定义的过滤器或合并驱动',
  workspace_missing: '项目文件夹不存在',
})
/** Why isolation is off for a project (`isolation.reason`), in the interface language. */
export const isolationReasonText = (reason: string | null | undefined) => (reason ? REASONS[reason] ?? reason : t('暂时不能使用'))

const CONFLICTS: Record<string, string> = localized({
  content: '同一处都改了',
  binary: '二进制文件两边都改了',
  modify_delete: '一边改了、一边删了',
  add_add: '两边都新建了',
  rename: '改名后又改了',
  type: '文件和文件夹互换',
  other: '无法自动合并',
  submodule: '子模块',
  case_collision: '名字只差大小写',
  unsafe_symlink: '链接指向项目之外',
  unsafe_hardlink: '硬链接',
  changed_during_merge: '合并时文件被改动',
  unexpected_file: '项目文件夹里已有同名的被忽略文件',
})
export const conflictKindText = (kind: string) => CONFLICTS[kind] ?? kind

const APPLY_KINDS: Record<string, string> = localized({
  turn: '对话应用', worker: '子代理合并', background: '后台应用', resolve: '冲突处理', rollback: '回退', user_discard: '面板里放弃',
})
export const applyKindText = (kind: string) => APPLY_KINDS[kind] ?? kind

const APPLY_STATES: Record<string, string> = localized({
  writing: '正在写入', verified: '', unverified: '写入后核对不一致', interrupted: '上次写入中断了', rolled_back: '已回退', expired: '已过期，不能回退',
})
export const applyStateText = (state: string) => APPLY_STATES[state] ?? state

const ROLLBACK_BLOCKED: Record<string, string> = localized({
  expired: '已过期，不能回退', rolled_back: '已经回退过', target: '只用于崩溃恢复，不提供回退', interrupted: '先处理中断的写入',
})
export const rollbackBlockedText = (reason: string | null | undefined) => (reason ? ROLLBACK_BLOCKED[reason] ?? reason : t('现在不能回退'))

const WORKTREE_KINDS: Record<string, string> = localized({ session: '对话', worker: '子代理', background: '后台工作', orphan: '没有记录' })
export const worktreeKindText = (kind: string) => WORKTREE_KINDS[kind] ?? kind
const WORKTREE_STATES: Record<string, string> = localized({ active: '使用中', kept: '保留', conflicted: '有冲突', removed: '已删除', missing: '目录不见了' })
export const worktreeStateText = (state: string) => WORKTREE_STATES[state] ?? state
/** Worktrees the user may apply or discard from the list (`POST …/worktrees/:id/apply|discard`). */
export const settleable = (row: { kind: string; state: string }) => row.kind === 'orphan' || row.state === 'kept' || row.state === 'conflicted'

const SKIPPED: Record<string, string> = localized({ changed_after: '之后又改过', conflict: '与之后的改动重叠', unattributable: '同一时间还有别的写入', worktree_gone: '对话自己的工作副本已经不在了' })
export const skippedReasonText = (reason: string) => SKIPPED[reason] ?? reason
const ACTIONS: Record<string, string> = localized({ restore: '还原', delete: '删除', recreate: '重新创建', create: '新建', modify: '修改' })
export const fileActionText = (action: string) => ACTIONS[action] ?? action

/** Conflicts only the user settles (never `take`n by the model; worktree design §4.1). */
export const USER_ONLY = new Set(['submodule', 'case_collision', 'unsafe_symlink', 'unsafe_hardlink'])

/* ------------------------------------------------------------- turn footer */

/**
 * What a finished (or applying) turn's footer says about the project folder (design §12). `records`: this turn's
 * apply records (by `source.turnId`, oldest first); `changed`: files its tools changed (本轮交付); `commands`: it ran
 * a command (a direct-mode rollback covers what commands wrote too).
 */
export type TurnApplyView =
  | { kind: 'none' }
  | { kind: 'applying' }
  | { kind: 'merging'; files: number }
  | { kind: 'conflicted'; files: number; paths: ConflictPath[] }
  /** `reason`: why nothing more was applied (`read_only`, `archived`, `blocked`, `aborted`), when the host says. */
  | { kind: 'pending'; files: number; paths: ConflictPath[]; reason: string | null }
  /** `expired`: its records are past retention, so 回退 is not offered any more. */
  | { kind: 'applied'; files: number | null; bothChanged: number; applyIds: string[]; expired: boolean }
  /**
   * `undo`: the rollback record 撤销 rolls back. `left`: this turn's other writes into the project folder that still
   * stand (a conflict settled with 这些文件用这个对话的版本 is a `resolve` record the turn rollback does not cover).
   */
  | { kind: 'rolled_back'; undo: string | null; left: string[] }
  | { kind: 'checkpoint'; files: number }
  | { kind: 'no_checkpoint'; files: number; reason: string | null }
  /** A direct-mode turn whose checkpoint was swept after the retention period: 回退本轮 is not offered any more. */
  | { kind: 'checkpoint_expired'; files: number }

export interface TurnApplyInput {
  turn: Pick<Turn, 'status' | 'apply' | 'checkpoint'>
  running: boolean
  records: ApplyRecord[]
  /** The records were read (else counts are not shown yet). */
  loaded: boolean
  changed: number
  commands: boolean
  /**
   * Files the host says the turn changed in the project folder and that still stand (`GET …/turns/:turnId/changes`;
   * worker merges and conflict resolutions included, nothing counted twice). Wins over `changed` and over the
   * records' file counts when known; null or absent while it is read or when the host cannot say.
   */
  hostChanged?: number | null
}

/**
 * Whether a record's write still stands: not undone by a rollback that itself still stands (a rollback can be undone
 * in turn). A record whose undoing rollback is not listed counts by its own state.
 */
export function inEffect(row: ApplyRecord, byId: ReadonlyMap<string, ApplyRecord>, depth = 0): boolean {
  const by = row.rolledBackBy ? byId.get(row.rolledBackBy) : undefined
  if (!by || depth > 16) return row.state !== 'rolled_back'
  return !inEffect(by, byId, depth + 1)
}

/** The rollback record 撤销 would roll back, unless it is past retention (then there is nothing to undo with). */
const undoable = (id: string | null | undefined, byId: ReadonlyMap<string, ApplyRecord>) => (id && byId.get(id)?.state !== 'expired' ? id : null)

export function turnApplyView({ turn, running, records, loaded, changed: tools, commands, hostChanged = null }: TurnApplyInput): TurnApplyView {
  const apply = turn.apply
  const changed = hostChanged ?? tools
  const byId = new Map(records.map(row => [row.id, row]))
  // Only writes into the project folder count here: a worktree conversation's turn also records the host's writes into
  // its own worktree (the turn-start sync, the merge back after an apply), which are for crash recovery only.
  const project = records.filter(row => row.target === 'project')
  if (apply) {
    const conflict = apply.conflict
    const conflictFiles = conflict?.paths.length ?? 0
    if (apply.status === 'applying') return { kind: 'applying' }
    // The host merged the project folder's side into the worktree and continues the turn (design §4.2).
    if (running && conflict && apply.status !== 'applied') return { kind: 'merging', files: conflictFiles }
    if (running) return { kind: 'none' }
    if (apply.status === 'conflicted') return { kind: 'conflicted', files: conflictFiles, paths: conflict?.paths ?? [] }
    if (apply.status === 'pending') return { kind: 'pending', files: conflictFiles, paths: conflict?.paths ?? [], reason: apply.reason ?? null }
    // What 回退 undoes (POST …/turns/:turnId/rollback), as the host counts it: the turn's `turn` records in the project
    // folder and the `resolve` records its conflict card wrote there ("this conversation's version"); a resolve that
    // itself undid an interrupted apply (`undoes`) is a rollback in effect and is not the turn's.
    const own = project.filter(row => row.kind === 'turn' || (row.kind === 'resolve' && !row.undoes))
    // What the turn wrote into the project folder: its apply records.
    const written = project.filter(row => apply.applyIds.includes(row.id))
    // Rolled back when none of its records stands; 撤销 undoes the rollback of the newest one.
    if (own.length && own.every(row => !inEffect(row, byId))) {
      const left = written.filter(row => !own.includes(row) && row.kind !== 'rollback' && !row.undoes && inEffect(row, byId)).map(row => row.id)
      return { kind: 'rolled_back', undo: undoable(own.at(-1)!.rolledBackBy, byId), left }
    }
    if (apply.status === 'applied' && apply.applyIds.length) {
      const counted = written.length ? written : own
      // A file two records wrote counts once in the host's answer; the records' own counts add up per record.
      const files = hostChanged ?? (loaded ? counted.reduce((n, row) => n + row.files, 0) : null)
      // The host refuses the whole turn while any record of it still standing is past retention.
      return { kind: 'applied', files, bothChanged: apply.bothChanged ?? 0, applyIds: apply.applyIds, expired: own.some(row => row.state === 'expired') }
    }
    return { kind: 'none' }
  }
  const checkpoint = turn.checkpoint
  if (!checkpoint || running) return { kind: 'none' }
  // A direct-mode turn rolled back as a whole: a rollback record naming the turn (`undoesTurn`) that still stands. A
  // rollback of one of its records alone (a worker's merge, from its card or 应用记录) is not the turn's.
  const rollback = project.filter(row => row.kind === 'rollback' && row.undoesTurn && inEffect(row, byId)).at(-1)
  if (rollback) return { kind: 'rolled_back', undo: undoable(rollback.id, byId), left: [] }
  if (!changed && !commands) return { kind: 'none' }
  if (checkpoint.state === 'taken') return { kind: 'checkpoint', files: changed }
  if (checkpoint.state === 'expired') return { kind: 'checkpoint_expired', files: changed }
  return { kind: 'no_checkpoint', files: changed, reason: checkpoint.reason ?? null }
}

/* ----------------------------------------------------------- subagent card */

export type SubagentMergeView =
  | { kind: 'none' }
  /** `applyIds`: the records its merge wrote; none when its conflicts were settled by keeping your files as they were. */
  | { kind: 'merged'; files: number; applyIds: string[] }
  /** `unmerged`: nothing of it is in your files yet (merged all or nothing while its conversation was idle, A4), so a
   * partial merge can still bring its clean files in (合并). */
  | { kind: 'conflict'; files: number; paths: ConflictPath[]; waiting: boolean; unmerged: boolean }
  | { kind: 'pending'; reason: string | null }
  /** `reason` 'missing': its worktree was gone after a restart, so its changes were lost (not dropped by anyone).
   * `applyIds`: what its merge had written, rolled back when it was dropped (回退这次合并). */
  | { kind: 'dropped'; reason: string | null; applyIds: string[] }
  | { kind: 'shared_root'; reason: string | null }

/**
 * A worker's merge on its card (design §4.1 table). `parentBusy`: the parent conversation has a turn running — a
 * conflict then waits on the main conversation; once it is idle the user gets the buttons.
 */
export function subagentMergeView(sub: Pick<SubagentInfo, 'status' | 'merge'>, parentBusy: boolean): SubagentMergeView {
  const merge = sub.merge
  if (!merge || sub.status === 'running') return { kind: 'none' }
  switch (merge.status) {
    case 'merged': return { kind: 'merged', files: merge.files ?? 0, applyIds: [...(merge.applyIds ?? [])] }
    case 'conflict': return { kind: 'conflict', files: merge.conflicts?.length ?? 0, paths: merge.conflicts ?? [], waiting: parentBusy, unmerged: merge.files === 0 && !merge.applyIds?.length }
    case 'pending': return { kind: 'pending', reason: merge.reason ?? null }
    case 'dropped': return { kind: 'dropped', reason: merge.reason ?? null, applyIds: [...(merge.applyIds ?? [])] }
    case 'shared_root': return { kind: 'shared_root', reason: merge.reason ?? null }
    default: return { kind: 'none' }
  }
}

/** The key of a host card above the composer for a worktree conversation's turn (HOST_CARDS, protocol §8.6). */
export const worktreeCardAction = (turnId: string) => `worktree-apply:${turnId}`
/** Whether a card's `actionId` is this turn's conflict card (a later one in the same turn gets `:<n>`). */
export const isTurnConflictCard = (actionId: unknown, turnId: string) =>
  typeof actionId === 'string' && (actionId === worktreeCardAction(turnId) || actionId.startsWith(`${worktreeCardAction(turnId)}:`))

const TARGETS: Record<string, string> = localized({ session: '写进对话的工作树', background: '写进后台工作树' })
/** Where a record wrote when not into the project folder (`session:<id>` / `background:<id>`): null for the folder. */
export const applyTargetText = (target: string) => (target === 'project' ? null : TARGETS[target.split(':')[0]] ?? target)

const HELD: Record<string, string> = localized({ read_only: '项目现在是只读的', archived: '项目已归档', blocked: '没能写入项目文件夹', aborted: '新的一轮开始了', git_operation: '项目文件夹正在进行 Git 操作，结束后自动应用' })
/** Why a worktree turn's changes were not applied (`turn.apply.reason`). */
export const heldReasonText = (reason: string | null | undefined) => (reason ? HELD[reason] ?? null : null)

/** A rollback's or a worktree's file list shows at most this many before "还有 N 个". */
export const LIST_CAP = 8
