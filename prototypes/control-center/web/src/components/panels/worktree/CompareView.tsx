/**
 * 全部改动 / 未提交的改动 as Claude Code's diff panel shows a comparison
 * (worktree design §3.4–3.6): the file tree on the left (about 230 px,
 * resizable, its own scroll; over the diffs on a narrow panel), every file's
 * diff stacked on the right, the two kept in step, and the find bar on top
 * of the diffs. The listing comes from the panel; patches are read here as
 * files come near the viewport (PatchStore). ChangesView is that layout for
 * any listing and source: 本次对话的改动 lays out Rna's own records with it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { gitApi, type GitCompare } from '@/api/git-api'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { ChangeTree } from './ChangeTree'
import { FIND_BYTES, findMatches, flatTree, isFolderRow, keyOf, MIN_DIFF_WIDTH, MIN_TREE_WIDTH, patchBase, TREE_WIDTH, type CompareMode, type FindMatch, type TreeModel } from './compare-model'
import { FindBar } from './FindBar'
import { PatchStore, type DiffSource } from './patch-store'
import { linesOf, StackedDiff, type FileActions, type StackedDiffHandle } from './StackedDiff'

/** How the diffs read and where the tree goes: the panel's part of a comparison's view. */
export interface ChangesLayoutProps {
  wrap: boolean
  numbers: 'new' | 'both'
  /** The tree shows beside the diffs (wide panel). */
  treeShown: boolean
  /** The tree shows over the diffs (narrow panel, opened from the header). */
  overlay: boolean
  onCloseOverlay: () => void
  /** The panel's width, to keep the diffs readable beside the tree. */
  width: number
  findOpen: boolean
  findFocus: number
  onCloseFind: () => void
  actions: FileActions
}

export interface CompareViewProps extends ChangesLayoutProps {
  projectId: string
  mode: CompareMode
  /** Another worktree's path, or null for the project folder. */
  target: string | null
  compare: GitCompare
}

const toggled = (set: ReadonlySet<string>, key: string) => { const next = new Set(set); if (!next.delete(key)) next.add(key); return next }

/** Git's comparison: its listing as one tree, patches read from the host. */
export function CompareView({ projectId, mode, target, compare, ...layout }: CompareViewProps) {
  const [store] = useState(() => new PatchStore({
    batch: (from, paths, oldPaths) => gitApi.patches(projectId, { from, paths, oldPaths, worktree: target }).then(answer => answer.patches),
    full: (from, path, oldPath) => gitApi.compareDiff(projectId, { from, path, oldPath, context: 'all', worktree: target }),
  }))
  const model = useMemo(() => flatTree(compare.files), [compare])
  useEffect(() => { store.setListing({ mode, base: patchBase(mode, compare), target }, compare.files) }, [store, mode, compare, target])
  useEffect(() => () => store.clear(), [store])
  return <ChangesView store={store} model={model} truncated={compare.truncated} {...layout} />
}

export interface ChangesViewProps extends ChangesLayoutProps {
  store: DiffSource
  model: TreeModel
  /** The listing stopped short (git lists at most 3000 files). */
  truncated?: boolean
  /** A group's label above its first section (本次对话的改动). */
  groupLabel?: (group: string) => ReactNode
  /** Drawn after the last diff, in the same scroll. */
  footer?: ReactNode
}

/** The tree beside (or over) the stacked diffs, kept in step, with the find bar: for any listing and diff source. */
export function ChangesView({ store, model, truncated, groupLabel, footer, wrap, numbers, treeShown, overlay, onCloseOverlay, width, findOpen, findFocus, onCloseFind, actions }: ChangesViewProps) {
  const t = useT()
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const order = model.order

  const [folders, setFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  const [active, setActive] = useState<string | null>(null)
  const stacked = useRef<StackedDiffHandle>(null)
  const activeKey = active && order.some(file => keyOf(file) === active) ? active : order[0] ? keyOf(order[0]) : null

  // Find: matches over the paths and every patch read so far; while it is open the rest is read too (up to 5 MB).
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const searching = findOpen && query.length > 0
  const matches = useMemo<FindMatch[]>(() => (searching ? findMatches(query, order.map(file => ({ key: keyOf(file), path: file.path, lines: linesOf(store.entry(keyOf(file)).diff) }))) : []),
    [searching, query, order, store, version]) // eslint-disable-line react-hooks/exhaustive-deps -- `version` is the store's change counter
  useEffect(() => { if (searching) store.wantAll(FIND_BYTES) }, [searching, store, version, model])
  const unread = searching ? order.filter(file => !file.binary && !isFolderRow(file) && !store.entry(keyOf(file)).diff).length : 0
  const busy = searching && store.busy()
  const partial = searching && unread > 0 && !busy ? order.length - unread : null
  const current = matches.length ? matches[Math.min(index, matches.length - 1)] : null
  useEffect(() => { if (!findOpen) setQuery('') }, [findOpen])

  const show = useCallback((key: string, line?: number) => {
    setCollapsed(set => (set.has(key) ? toggled(set, key) : set))
    setFolders(set => { const open = model.holders(key).filter(folder => set.has(folder)); if (!open.length) return set; const next = new Set(set); for (const folder of open) next.delete(folder); return next })
    setActive(key)
    requestAnimationFrame(() => stacked.current?.scrollToFile(key, line))
  }, [model])
  const goTo = useCallback((match: FindMatch | null) => {
    if (!match) return
    setShown(set => (set.has(match.key) ? set : new Set(set).add(match.key)))
    show(match.key, match.line)
  }, [show])
  // A new query goes to its first match once there is one.
  const jump = useRef(false)
  useEffect(() => { setIndex(0); jump.current = true }, [query])
  useEffect(() => { if (jump.current && matches.length) { jump.current = false; goTo(matches[0]) } }, [matches, goTo])
  const step = (delta: 1 | -1) => {
    if (!matches.length) return
    const next = ((Math.min(index, matches.length - 1) + delta) % matches.length + matches.length) % matches.length
    setIndex(next); goTo(matches[next])
  }

  const only = useMemo(() => (searching ? new Set(matches.map(match => match.key)) : null), [searching, matches])
  const rows = useMemo(() => model.rows(folders, only), [model, folders, only])
  // Closed from inside (Esc, a pick, the scrim), the overlay hands the keyboard to the diffs rather than dropping it on the page.
  const closeOverlay = useCallback(() => { onCloseOverlay(); stacked.current?.focus() }, [onCloseOverlay])
  const pick = useCallback((key: string) => { show(key); if (overlay) closeOverlay() }, [show, overlay, closeOverlay])
  const toggleFolder = useCallback((key: string) => setFolders(set => toggled(set, key)), [])
  const collapse = useCallback((key: string) => setCollapsed(set => toggled(set, key)), [])
  const reveal = useCallback((key: string) => setShown(set => new Set(set).add(key)), [])

  // The tree's width: dragged or nudged with the arrow keys, always leaving the diffs room.
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH)
  const maxTree = Math.max(MIN_TREE_WIDTH, width - MIN_DIFF_WIDTH)
  const shownWidth = Math.min(treeWidth, maxTree)
  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const start = e.clientX, from = shownWidth
    const move = (ev: PointerEvent) => setTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(maxTree, from + ev.clientX - start)))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(maxTree, shownWidth + (e.key === 'ArrowRight' ? 16 : -16))))
  }

  // The tree opened over the diffs takes the keyboard (Esc or a pick closes it).
  const overlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (overlay) overlayRef.current?.querySelector<HTMLElement>('[data-change-tree]')?.focus({ preventScroll: true }) }, [overlay])

  const empty = !order.length
  const tree = <ChangeTree rows={rows} active={activeKey} collapsed={folders} onToggleFolder={toggleFolder} onPick={pick} className="h-full" />
  return (
    <div className="relative flex min-h-0 flex-1" data-compare-view>
      {treeShown && !empty && (
        <>
          <div className="flex min-h-0 shrink-0 flex-col" style={{ width: shownWidth }} data-tree-column>{tree}</div>
          <div role="separator" aria-orientation="vertical" aria-label={t('调整文件列表宽度')} aria-valuenow={shownWidth} aria-valuemin={MIN_TREE_WIDTH} aria-valuemax={maxTree} tabIndex={0}
            onPointerDown={resize} onKeyDown={nudge} data-tree-resizer
            className="relative w-px shrink-0 cursor-col-resize bg-line-faint outline-none after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-line focus-visible:bg-[var(--line-focus)]" />
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {findOpen && !empty && (
          <FindBar query={query} onQuery={setQuery} index={current ? Math.min(index, matches.length - 1) : -1} total={matches.length} onStep={step} onClose={onCloseFind}
            partial={partial} searching={busy} focusKey={findFocus} />
        )}
        {truncated && <p className="shrink-0 border-b border-line-faint px-3 py-1.5 text-[12px] text-fg-4">{t('改动太多，只列出了一部分。')}</p>}
        {empty
          ? <div className="grid min-h-0 flex-1 place-items-center px-4 text-center text-[13px] text-fg-3" data-compare-empty>{t('没有可显示的改动')}</div>
          : <StackedDiff ref={stacked} files={order} store={store} version={version} wrap={wrap} numbers={numbers} collapsed={collapsed} onCollapse={collapse} shown={shown} onShow={reveal}
            active={activeKey} onActive={setActive} find={searching ? { query, current } : null} actions={actions} groupLabel={groupLabel} footer={footer} />}
      </div>
      {overlay && !empty && (
        <>
          <button type="button" aria-label={t('隐藏文件')} tabIndex={-1} onClick={closeOverlay} className="absolute inset-0 z-20 cursor-default bg-black/10" data-tree-scrim />
          <div ref={overlayRef} className="absolute inset-y-0 left-0 z-30 flex w-[min(280px,85%)] flex-col bg-elevated shadow-lg" data-tree-overlay
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay() } }}>
            {tree}
          </div>
        </>
      )}
    </div>
  )
}

/** The diffs' place while the listing is first read. */
export function CompareSkeleton() {
  return (
    <div className="flex min-h-0 flex-1" aria-hidden data-worktree-loading>
      <div className="space-y-2 px-3 pt-3" style={{ width: 200 }}>{[60, 45, 70, 50].map(w => <Skeleton key={w} className="h-3" />)}</div>
      <div className={cn('flex-1 space-y-2 px-3 pt-3')}>
        <Skeleton className="h-4 w-1/3" />
        {[90, 75, 82, 60, 70].map(w => <Skeleton key={w} className="h-3" />)}
      </div>
    </div>
  )
}
