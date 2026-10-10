/**
 * 本次对话的改动 (Rna's own records, with or without git) laid out as the git comparisons are (worktree design §3.4–3.6):
 * the file tree on the left — a row per turn of the conversation and per background run, newest first, each with
 * its files compacted and +N −M — and every file's diff stacked on the right with the shared DiffView (line numbers,
 * syntax colour, wrap, sticky headers). Above each group's first diff its label says where the changes came from:
 * the turn's request (本轮 for the latest) or the run's title, when, how many files, and its actions — 审阅 opens
 * the turn's review or the set's 后台改动 tab beside the panel (a set made in a background worktree has no snapshots
 * there: 审阅 opens 应用记录 on its newest record), and a change set keeps 回退这些修改. An overwrite
 * whose earlier text was not recorded reads 已覆盖, without counts. The conversation's latest tool calls follow
 * the diffs, folded (what the retired 会话资源 overview listed).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Clock3, History, MessageSquareText } from 'lucide-react'
import type { Item } from '@/api/types'
import { worktreeApi } from '@/api/worktree-api'
import { openDock } from '@/store/ui-store'
import { BackgroundChangeRevert } from '@/components/timeline/BackgroundChangeRevert'
import { ToolIcon } from '@/components/timeline/tool-icons'
import { relativeTime } from '@/lib/format'
import { toolKind, toolTarget, toolVerb } from '@/lib/tools'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { ChangesView, type ChangesLayoutProps } from './CompareView'
import { RnaDiffs } from './rna-diffs'
import { setApplyIds, type RnaGroup, type RnaListing } from './rna-model'
import { openApplyHistory } from './sheets'
import type { FileActions } from './StackedDiff'

/** Reviews, change sets and tool details open next to the changes panel (contract P-7), not over it. */
const BESIDE = { besideType: 'worktree' } as const
const link = 'shrink-0 rounded px-1 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]'

export interface RnaChangesProps extends Omit<ChangesLayoutProps, 'actions'> {
  projectId: string
  /** The conversation shown (this project's); null: background work only. */
  sessionId: string | null
  workspace: string | undefined
  listing: RnaListing
}

export function RnaChanges({ projectId, sessionId, workspace, listing, ...layout }: RnaChangesProps) {
  const [store] = useState(() => new RnaDiffs((applyId, paths) => worktreeApi.applyPatches(projectId, applyId, paths).then(answer => answer.patches)))
  // Before the first paint: the sections draw their computed diffs at once, never a skeleton first.
  useLayoutEffect(() => { store.setListing(listing.files, listing.inputs) }, [store, listing])
  useEffect(() => () => store.dispose(), [store])
  const byKey = useMemo(() => new Map(listing.groups.map(group => [group.key, group])), [listing.groups])
  const groupLabel = useCallback((key: string) => {
    const group = byKey.get(key)
    return group ? <GroupLabel group={group} projectId={projectId} sessionId={sessionId} /> : null
  }, [byKey, projectId, sessionId])
  // Files of the project folder: opened, shown in Finder and copied; nothing here stages or discards.
  const actions = useMemo<FileActions>(() => ({ projectId, root: workspace, readOnly: false, writable: false, busy: false, onStage: () => {}, onDiscard: () => {} }), [projectId, workspace])
  const footer = listing.recent.length && sessionId ? <RecentTools sessionId={sessionId} items={listing.recent} /> : null

  if (!listing.groups.length) return <Empty footer={footer} />
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-rna-changes>
      <ChangesView store={store} model={listing.tree} groupLabel={groupLabel} footer={footer} actions={actions} {...layout} />
    </div>
  )
}

/** Where a group's changes came from, above its first diff: the turn or run, when, how many files, and its actions. */
function GroupLabel({ group, projectId, sessionId }: { group: RnaGroup; projectId: string; sessionId: string | null }) {
  const t = useT()
  const counted = group.files.filter(file => file.added !== null && file.removed !== null)
  const added = counted.reduce((n, file) => n + (file.added ?? 0), 0), removed = counted.reduce((n, file) => n + (file.removed ?? 0), 0)
  const turn = group.kind === 'turn' ? group : null, set = group.kind === 'change' ? group : null
  const records = set?.change.kind === 'git' ? setApplyIds(set.change) : []
  // A turn's 审阅 shows what reached the project folder when the host can say (its tool calls otherwise).
  const review = turn ? (sessionId ? () => openDock({ kind: 'diff', sessionId, itemIds: turn.itemIds, turnId: turn.turnId || null }, BESIDE) : null)
    : set!.change.kind === 'git' ? (records.length ? () => openApplyHistory(projectId, { focus: records.at(-1) }) : null)
      : () => openDock({ kind: 'change', projectId, changeId: set!.change.id }, BESIDE)
  const Icon = turn ? MessageSquareText : Clock3
  const files = set ? set.change.count : group.files.length
  return (
    <div className="border-b border-line-faint bg-subtle" data-rna-group={group.key} data-turn={turn?.turnId} data-change-set={set?.change.id}>
      <div className="flex h-9 min-w-0 items-center gap-1.5 pl-3 pr-2 text-[12.5px]">
        <Icon className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.8} aria-hidden />
        {turn?.latest && <span className="shrink-0 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent-text">{t('本轮')}</span>}
        <span className={cn('min-w-0 flex-1 truncate font-medium', group.muted ? 'text-fg-4' : 'text-fg-2')} title={group.title ?? undefined}>{group.label}</span>
        {/* On a narrow panel the request keeps the room: when it was goes first, then the counts (the tree and headers have them). */}
        <span className="shrink-0 text-[12px] tabular-nums text-fg-4">
          {t('{count} 个文件', { count: files })}
          {group.at && <span className="hidden @[480px]/worktree:inline"> · {relativeTime(group.at)}</span>}
        </span>
        {counted.length > 0 && (
          <span className="hidden shrink-0 font-mono text-[11.5px] tabular-nums @[400px]/worktree:inline" data-group-stat>
            <span className="text-[var(--diff-add-fg)]">+{added}</span>
            <span className="ml-1 text-[var(--diff-del-fg)]">−{removed}</span>
          </span>
        )}
        {review && <button type="button" onClick={review} className={link} data-group-review>{t('审阅')}</button>}
      </div>
      {set && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[12px] text-fg-4">
          {set.more > 0 && <span>{t('还有 {n} 个文件，在审阅里查看。', { n: set.more })}</span>}
          <BackgroundChangeRevert projectId={projectId} changeId={set.change.id} className={REVERT_CLASS[set.change.status] ?? ''} />
        </div>
      )}
    </div>
  )
}

/** BackgroundChangeRevert's own line, per state, set into the label's second row. */
const REVERT_CLASS: Record<string, string> = {
  deferred: 'flex items-center gap-1.5 text-fg-3',
  merge_conflicted: 'min-w-0 text-fg-3',
  reverted: 'text-fg-4',
}

function Empty({ footer }: { footer: ReactNode }) {
  const t = useT()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-rna-changes>
      <div className="mx-auto flex max-w-[300px] flex-col items-center px-4 pt-[clamp(32px,12vh,96px)] text-center" data-rna-empty>
        <span className="grid size-10 place-items-center rounded-xl bg-accent-softer text-accent-text"><History className="size-[18px]" strokeWidth={1.8} /></span>
        <h3 className="mt-3 text-[14px] font-medium text-fg">{t('还没有记录到改动')}</h3>
        <p className="mt-1 text-[12.5px] leading-[1.6] text-fg-3">{t('Rna 在这个项目里改文件时（对话里或后台），会在这里按轮次和运行列出。')}</p>
      </div>
      {footer && <div className="mt-6">{footer}</div>}
    </div>
  )
}

/** The conversation's latest tool calls, folded until asked for; each opens its details beside the panel. */
function RecentTools({ sessionId, items }: { sessionId: string; items: Item[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <section className="border-t border-line-faint px-1.5 pb-8 pt-1" data-recent-tools>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
        className="flex h-7 items-center gap-1 rounded-md px-1 text-[12px] font-medium text-fg-3 outline-none transition-colors hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronRight className={cn('size-3 text-fg-4 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
        <span className="truncate">{t('最近的工具调用')}</span>
        <span className="font-normal tabular-nums text-fg-4">{items.length}</span>
      </button>
      {open && items.map(item => (
        <button key={item.id} type="button" onClick={() => openDock({ kind: 'tool', sessionId, itemId: item.id }, BESIDE)}
          className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          <ToolIcon kind={toolKind(item.tool!)} className="size-3.5 shrink-0" />
          <span className="shrink-0 text-fg-2">{toolVerb(item.tool!)}</span>
          <span className="min-w-0 flex-1 truncate">{toolTarget(item.tool!)}</span>
        </button>
      ))}
    </section>
  )
}
