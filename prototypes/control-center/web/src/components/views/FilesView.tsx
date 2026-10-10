/**
 * 文件: project tree (lazy directories, keyboard navigation), the unified
 * file preview (components/preview: Markdown, code, JSON, tables, images,
 * PDF, HTML, download); the run preview (static auto-refresh or Vite HMR) opens in the side panel’s built-in browser tab.
 *
 * One surface, two shells (design 4.1): the 文件 page (`layout: 'page'`) and
 * the 文件 panel (`layout: 'panel'`, with 在主视图中打开 in its ⋯ menu). It
 * lays out by its own width (container queries, from 260 px up): below 640 px
 * one column with a 文件列表 / 内容 switch. The run preview's polling and
 * automatic start live once per project in store/preview-store.ts.
 *
 * Change markers (layout plan §3, L1): what changed in the project folder
 * (git's status in a repository, else Rna's own records — lib/workspace-changes)
 * marks its files; a folder shows what changed inside it, and deleted files,
 * which no listing has any more, show struck through where they were.
 * 只看改动 narrows the tree to the changes and opens the folders holding them.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, File, FileCode2, FileText, Folder, FolderOpen, Globe, ListFilter, Loader2, MonitorPlay, RefreshCw, Square } from 'lucide-react'
import { projectApi, type DirectoryListing } from '@/api/project-api'
import { useApp, useProject } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { clearPreviewStopped, openPreview, showPreview, startPreviewOnce, stopPreview, usePreviewStarting, usePreviewWatch } from '@/store/preview-store'
import { prettyPath } from '@/lib/format'
import { useChangedPaths, type ChangeKind } from '@/lib/workspace-changes'
import { FilePreview } from '@/components/preview/FilePreview'
import { Dialog } from '@/components/ui/overlays'
import { Button, IconButton, SegmentedTabs, Skeleton, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Field, Select, SPLIT_MIN_WIDTH, TextInput, useNarrow } from './kit'
import { SurfaceMenu } from './SurfaceMenu'
import { t as tr, localized, type MessageKey } from '@/i18n'

const DISCOVERY: Record<string, string> = localized({ multiple_entries: '找到多个预览入口，请选择运行入口。', framework_requires_build: '项目需要构建或开发服务，请选择预览方式。', vite_dependencies_missing: '尚未安装项目的 Vite 依赖。', execute_permission_required: '启动开发预览需要项目执行权限。', no_entry: '尚未发现可预览的网页，生成后会自动打开。', scan_limit: '项目较大，请手动指定预览入口。' })

/* ------------------------------------------------------------ change markers */

/** Folders 只看改动 opens at once (shallowest first); deeper ones open on a click. */
export const AUTO_OPEN_FOLDERS = 40

const KIND_LETTER: Record<ChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D' }
const KIND_WORDS: Record<ChangeKind, MessageKey> = { added: '新文件', modified: '已修改', deleted: '已删除' }
const KIND_TEXT: Record<ChangeKind, string> = { added: 'text-success', modified: 'text-warning-text', deleted: 'text-danger' }
const KIND_DOT: Record<ChangeKind, string> = { added: 'bg-success', modified: 'bg-warning', deleted: 'bg-danger' }

const parentOf = (path: string) => { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at) }
const depthOf = (path: string) => path.split('/').length

const folderCache = new WeakMap<ReadonlyMap<string, ChangeKind>, ReadonlyMap<string, ChangeKind>>()
/**
 * Every folder above a change, with what changed inside it: one kind when everything inside changed the same way
 * (a folder of new files reads new), else modified. Cached per map (`useChangedPaths` keeps its identity).
 */
export function folderChanges(changes: ReadonlyMap<string, ChangeKind>): ReadonlyMap<string, ChangeKind> {
  let folders = folderCache.get(changes)
  if (!folders) {
    const out = new Map<string, ChangeKind>()
    for (const [path, kind] of changes) {
      for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
        const folder = path.slice(0, at), seen = out.get(folder)
        out.set(folder, seen === undefined || seen === kind ? kind : 'modified')
      }
    }
    folderCache.set(changes, folders = out)
  }
  return folders
}

export interface GoneEntry { name: string; path: string; type: 'file' | 'directory' }
const goneCache = new WeakMap<ReadonlyMap<string, ChangeKind>, ReadonlyMap<string, GoneEntry[]>>()
/**
 * Deleted files are on no listing: per folder, the deleted files in it and the folders on their way (a folder that
 * is still on disk is listed anyway and wins), folders first, by name. Cached per map.
 */
export function goneEntries(changes: ReadonlyMap<string, ChangeKind>): ReadonlyMap<string, GoneEntry[]> {
  let gone = goneCache.get(changes)
  if (!gone) {
    const out = new Map<string, GoneEntry[]>()
    for (const [path, kind] of changes) {
      if (kind !== 'deleted') continue
      for (let child = path, type: GoneEntry['type'] = 'file'; child; child = parentOf(child), type = 'directory') {
        const folder = parentOf(child)
        let list = out.get(folder)
        if (!list) out.set(folder, list = [])
        if (list.some(entry => entry.path === child)) break
        list.push({ name: child.slice(folder ? folder.length + 1 : 0), path: child, type })
      }
    }
    for (const list of out.values()) list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
    goneCache.set(changes, gone = out)
  }
  return gone
}

/** A path's mark: its own change, a folder's from inside it, else that of a new folder it sits in (git lists an untracked folder once). */
export function changeOf(changes: ReadonlyMap<string, ChangeKind>, path: string, type: 'file' | 'directory'): ChangeKind | undefined {
  const own = changes.get(path) ?? (type === 'directory' ? folderChanges(changes).get(path) : undefined)
  if (own) return own
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    const outer = changes.get(path.slice(0, at))
    if (outer) return outer
  }
  return undefined
}

interface TreeRow { path: string; name: string; type: 'file' | 'directory'; depth: number; change?: ChangeKind; gone: boolean }

/**
 * The tree's visible rows: listed folders as they are expanded, deleted entries where they were, and with
 * `changedOnly` only what changed and the folders holding it.
 */
export function treeRows(dirs: ReadonlyMap<string, DirectoryListing>, expanded: ReadonlySet<string>, changes: ReadonlyMap<string, ChangeKind>, changedOnly: boolean): TreeRow[] {
  const out: TreeRow[] = []
  const gone = goneEntries(changes)
  const walk = (path: string, depth: number, ghost: boolean) => {
    const listed = ghost ? [] : dirs.get(path)?.entries
    if (!listed) return
    const known = new Set(listed.map(entry => entry.path))
    const missing = (gone.get(path) ?? []).filter(entry => !known.has(entry.path))
    for (const entry of [...listed, ...missing]) {
      const change = changes.size ? changeOf(changes, entry.path, entry.type) : undefined
      if (changedOnly && !change) continue
      const isGone = ghost || !known.has(entry.path)
      out.push({ path: entry.path, name: entry.name, type: entry.type, depth, change, gone: isGone })
      if (entry.type === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1, isGone)
    }
  }
  walk('', 0, false)
  return out
}

export interface FilesSurfaceProps {
  projectId: string
  sessionId?: string | null
  /** On screen: the run preview is checked only while some surface showing the project is. */
  visible: boolean
  layout: 'page' | 'panel'
  /** A file to select once (its folders open); `onPathApplied` follows so the request is not replayed. */
  path?: string | null
  onPathApplied?: () => void
  /** The file shown changed. */
  onSelect?: (path: string | null) => void
  /** A panel's 在主视图中打开, with the file it shows. */
  onShowInMain?: (path: string | null) => void
}

/** The 文件 page as it was before the panel (callers that render the page directly). */
export function FilesView({ projectId, sessionId }: { projectId: string; sessionId: string | null }) {
  return <FilesSurface projectId={projectId} sessionId={sessionId} visible layout="page" />
}

export function FilesSurface({ projectId, sessionId = null, visible, layout, path = null, onPathApplied, onSelect, onShowInMain }: FilesSurfaceProps) {
  const project = useProject(projectId)
  const [dirs, setDirs] = useState<Map<string, DirectoryListing>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  /** Narrow containers show one pane at a time (tree · file); the run preview lives in the side panel's browser. */
  const [pane, setPane] = useState<'tree' | 'file'>('tree')
  /** 只看改动: the tree narrows to what changed in the folder. */
  const [changedOnly, setChangedOnly] = useState(false)
  const changed = useChangedPaths(projectId, sessionId)
  const paneId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  /** Below 640 px of container width one pane shows at a time (the CSS decides; this follows it for the keyboard). */
  const narrow = useNarrow(rootRef, SPLIT_MIN_WIDTH)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs

  const loadDir = useCallback(async (path: string, gen = generation.current) => {
    const result = await projectApi.list(projectId, path, controller.current?.signal)
    if (gen !== generation.current) return
    setDirs(prev => new Map(prev).set(path, result))
  }, [projectId])

  const refreshTree = useCallback(async (keep: Set<string> = new Set()) => {
    const gen = ++generation.current
    controller.current?.abort()
    controller.current = new AbortController()
    setDirs(new Map()); setTreeError(null)
    try {
      await loadDir('', gen)
      // An open folder that is gone (deleted since, or shown only for its deleted files) just has no listing.
      for (const path of keep) { if (gen !== generation.current) return; await loadDir(path, gen).catch(e => { if ((e as Error).name === 'AbortError') throw e }) }
    } catch (e) { if ((e as Error).name !== 'AbortError' && gen === generation.current) setTreeError((e as Error).message) }
  }, [loadDir])

  /** Re-read the root and open directories in place for a background change: the tree never blanks, so
   * scroll, focus and expansion stay; a directory that cannot be read keeps its last listing. */
  const reloadTree = useCallback(async (keep: Set<string>) => {
    const gen = generation.current, next = new Map<string, DirectoryListing>()
    for (const path of ['', ...keep]) {
      try { next.set(path, await projectApi.list(projectId, path, controller.current?.signal)) } catch { /* keep the last listing */ }
      if (gen !== generation.current) return
    }
    setDirs(prev => new Map([...prev, ...next]))
  }, [projectId])

  // Reset per project.
  useEffect(() => {
    setExpanded(new Set()); setSelected(''); setChangedOnly(false)
    void refreshTree()
    return () => controller.current?.abort()
  }, [projectId, refreshTree])

  /** Selecting a file hands it to the unified preview; `reloadKey` re-reads it when the user picks it again. */
  const [reloadKey, setReloadKey] = useState(0)
  /** Bumped when the run preview reports changed files: the open file reads itself again in place (same-size edits too). */
  const [changes, setChanges] = useState(0)
  const readFile = useCallback((path: string) => {
    setSelected(path); setPane('file'); setReloadKey(n => n + 1)
  }, [])

  // A file asked for from outside (a panel opened on it, the page taking over from a panel): open its folders, show it.
  const applied = useRef(onPathApplied)
  applied.current = onPathApplied
  useEffect(() => {
    const parts = path?.split('/').filter(Boolean) ?? []
    if (!parts.length) return
    const folders = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    if (folders.length) setExpanded(prev => new Set([...prev, ...folders]))
    let live = true
    // Shown once its folder is listed: the preview starts with the listed size and does not read the file twice.
    void (async () => {
      try { for (const folder of folders) if (!dirsRef.current.has(folder)) await loadDir(folder) } catch (e) { if (live) setTreeError((e as Error).message) }
      if (!live) return
      readFile(parts.join('/'))
      applied.current?.()
    })()
    return () => { live = false }
  }, [path, loadDir, readFile])

  const selectedRef = useRef(onSelect)
  selectedRef.current = onSelect
  useEffect(() => { selectedRef.current?.(selected || null) }, [selected])

  /** Open or close a folder; a deleted one (`gone`) has nothing on disk to list. */
  const toggleDir = (path: string, gone = false) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else { next.add(path); if (!gone && !dirs.has(path)) void loadDir(path).catch(e => setTreeError((e as Error).message)) }
      return next
    })
  }

  // Flattened visible tree for rendering + keyboard navigation.
  const rows = useMemo(() => treeRows(dirs, expanded, changed, changedOnly), [dirs, expanded, changed, changedOnly])

  /**
   * 只看改动: the list comes into view (a narrow container shows one pane) and the folders holding changes open
   * (shallowest first, up to AUTO_OPEN_FOLDERS), listed together in one update; a folder gone from disk has no listing.
   */
  const showChanged = (on: boolean) => {
    setChangedOnly(on)
    if (!on) return
    setPane('tree')
    const open = [...folderChanges(changed).keys()].sort((a, b) => depthOf(a) - depthOf(b)).slice(0, AUTO_OPEN_FOLDERS)
    setExpanded(prev => new Set([...prev, ...open]))
    const missing = open.filter(path => !dirsRef.current.has(path))
    if (!missing.length) return
    const gen = generation.current
    void Promise.allSettled(missing.map(path => projectApi.list(projectId, path, controller.current?.signal))).then(results => {
      if (gen !== generation.current) return
      const next = new Map<string, DirectoryListing>()
      results.forEach((result, index) => { if (result.status === 'fulfilled') next.set(missing[index], result.value) })
      if (next.size) setDirs(prev => new Map([...prev, ...next]))
    })
  }

  const selectedSize = useMemo(() => {
    const dir = selected.split('/').slice(0, -1).join('/')
    return dirs.get(dir)?.entries.find(e => e.path === selected)?.size ?? null
  }, [dirs, selected])

  const treeRef = useRef<HTMLDivElement>(null)
  // One pane at a time: a file picked from the list hides the list, so the keyboard goes along to the file (never
  // left on a hidden row, where Esc would reach the workspace and hide the panel).
  useEffect(() => {
    if (!narrow || pane !== 'file') return
    const active = document.activeElement
    if (!active || active === document.body || treeRef.current?.contains(active)) contentRef.current?.focus({ preventScroll: true })
  }, [narrow, pane])
  /** Esc in the file, one pane at a time: back to the list, on the file it came from (the key is taken, as SplitView's). */
  const onFileKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !narrow || e.nativeEvent.defaultPrevented || e.nativeEvent.isComposing) return
    if ((e.target as HTMLElement).closest('[role=dialog], [role=menu], input, textarea, select, [contenteditable="true"]')) return
    e.preventDefault()
    setPane('tree')
    requestAnimationFrame(() => (treeRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? treeRef.current?.querySelector<HTMLElement>('[data-file-path]'))?.focus({ preventScroll: true }))
  }
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-file-path]')
    if (!target || e.nativeEvent.isComposing) return
    const items = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])]
    const index = items.indexOf(target)
    const row = rows[index]
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
      items[next]?.focus()
    } else if (row?.type === 'directory' && ((e.key === 'ArrowRight' && !expanded.has(row.path)) || (e.key === 'ArrowLeft' && expanded.has(row.path)))) {
      e.preventDefault(); toggleDir(row.path, row.gone)
    }
  }

  /* ---- preview (one copy per project: store/preview-store.ts) ---- */
  const { preview, note: previewNote, revision } = usePreviewWatch(projectId, sessionId, visible)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const treeErrorRef = useRef(treeError)
  treeErrorRef.current = treeError

  // The running preview reported changed files: the tree updates in place; the open file reads itself again in place
  // (a same-size edit, or a file in a collapsed folder whose listed size never updates, included), and the
  // narrow-container pane stays where the user put it.
  const seen = useRef({ projectId, revision })
  useEffect(() => {
    if (seen.current.projectId !== projectId) { seen.current = { projectId, revision }; return }
    if (seen.current.revision === revision) return
    seen.current = { projectId, revision }
    let live = true
    void reloadTree(expandedRef.current).then(() => { if (live) setChanges(n => n + 1) })
    return () => { live = false }
  }, [projectId, revision, reloadTree])

  // A tree that failed while the daemon restarted for an update reloads once the app is back.
  const back = useApp(s => !s.maintenanceHeld && s.connection === 'online')
  const wasBack = useRef(back)
  useEffect(() => {
    if (back && !wasBack.current && treeErrorRef.current) void refreshTree(expandedRef.current)
    wasBack.current = back
  }, [back, refreshTree])

  // Starting a dev service can take ~20 s: the button shows it whoever started it (here, an opened HTML file, the
  // automatic start), and a start already under way is shared, never sent twice.
  const starting = usePreviewStarting(projectId)
  const ensurePreview = async () => {
    clearPreviewStopped(projectId)
    try {
      const result = await startPreviewOnce(projectId, sessionId).result
      if (result.status === 'ready') showPreview(projectId, result)
      else { toast(DISCOVERY[result.discovery?.reason ?? ''] || tr('暂未找到可运行的预览入口。')); if (result.discovery?.candidates?.length || result.discovery?.status === 'ambiguous') setFormOpen(true) }
    } catch (e) { toast((e as Error).message, 'danger') }
  }

  const runLabel = starting ? tr('正在启动预览…') : preview ? tr('更换预览') : tr('运行预览')
  return (
    <div ref={rootRef} className="@container/files flex min-h-0 flex-1 flex-col" data-files-surface={layout}>
      <div className={cn('flex shrink-0 items-center gap-2 border-b border-line-faint', layout === 'panel' ? 'h-10 pl-3 pr-1.5' : 'h-11 px-4')}>
        {/* Below 320 px the header keeps its room for the actions (the tab already says 文件). */}
        <strong className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-fg @max-[320px]/files:sr-only">{tr('项目文件')}</strong>
        <span className="hidden min-w-0 truncate text-[12px] text-fg-3 @[420px]/files:block" title={project?.workspacePath}>{prettyPath(project?.workspacePath)}</span>
        <span className="flex-1" />
        <IconButton label={tr('刷新')} onClick={() => void refreshTree(expanded)}><RefreshCw /></IconButton>
        {(changed.size > 0 || changedOnly) && (
          <Tooltip content={tr('只看改动')}>
            <Button size="sm" variant="ghost" aria-pressed={changedOnly} aria-label={tr('只看改动，共 {n} 处改动', { n: changed.size })} data-files-changed-only
              className={cn('shrink-0 px-2', changedOnly && 'bg-active text-fg')} leading={<ListFilter className="size-3.5" />} onClick={() => showChanged(!changedOnly)}>
              <span className="hidden @[520px]/files:inline">{tr('只看改动')}</span>
              {changed.size > 0 && <span className="tabular-nums text-fg-4">{changed.size}</span>}
            </Button>
          </Tooltip>
        )}
        {preview && (
          <span className="hidden min-w-0 max-w-[40%] items-center gap-1.5 text-[12px] text-fg-3 @[640px]/files:inline-flex" title={previewNote}>
            <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
            <span className="truncate">{previewNote}</span>
          </span>
        )}
        {preview && <IconButton label={tr('停止预览')} onClick={() => void stopPreview(projectId)}><Square /></IconButton>}
        {preview && <HeaderButton label={tr('显示预览')} icon={<Globe className="size-3.5" />} variant="ghost" onClick={() => { clearPreviewStopped(projectId); openPreview(projectId, preview.url) }} />}
        <HeaderButton label={runLabel} disabled={starting} busy={starting} icon={starting ? <Loader2 className="size-3.5 animate-spin" /> : <MonitorPlay className="size-3.5" />}
          onClick={() => void (preview ? setFormOpen(true) : ensurePreview())} />
        {layout === 'panel' && onShowInMain && <SurfaceMenu onShowInMain={() => onShowInMain(selected || null)} />}
      </div>
      <div className="flex h-10 shrink-0 items-center border-b border-line-faint px-3 @[640px]/files:hidden">
        <SegmentedTabs<'tree' | 'file'> layoutId={`files-pane-${paneId}`} value={pane} onChange={setPane} className="rounded-lg bg-subtle p-0.5"
          items={[{ id: 'tree', label: tr('文件列表') }, { id: 'file', label: tr('内容') }]} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={treeRef} role="tree" aria-label={tr('项目目录文件')} onKeyDown={onTreeKey} data-files-pane="tree"
          className={cn('shrink-0 overflow-y-auto border-line-faint px-1.5 py-2 scroll-quiet @[640px]/files:block @[640px]/files:w-[260px] @[640px]/files:flex-none @[640px]/files:border-r', pane === 'tree' ? 'min-w-0 flex-1' : 'hidden')}>
          {!dirs.has('') && !treeError && <div className="space-y-2 px-2 pt-1">{[70, 55, 80, 60, 45].map(w => <Skeleton key={w} className="h-4" />)}</div>}
          {rows.map(row => {
            const folder = row.type === 'directory'
            const open = expanded.has(row.path)
            const Icon = folder ? (open ? FolderOpen : Folder) : fileIcon(row.name)
            // A deleted file has nothing to show; it stays in the keyboard order but does not open.
            const inert = row.gone && !folder
            const words = row.change ? tr(folder ? '里面有改动' : KIND_WORDS[row.change]) : null
            return (
              <button key={row.path} type="button" role="treeitem" data-file-path={row.path} data-change={row.change} data-gone={row.gone || undefined}
                aria-level={row.depth + 1} aria-selected={selected === row.path} aria-expanded={folder ? open : undefined} aria-disabled={inert || undefined}
                title={words ? `${row.path} · ${words}` : row.path}
                onClick={() => (folder ? toggleDir(row.path, row.gone) : inert ? undefined : readFile(row.path))}
                className={cn('flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', selected === row.path ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg', inert && 'cursor-default')}
                style={{ paddingLeft: 6 + row.depth * 14 }}>
                <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform', !folder && 'invisible', open && 'rotate-90')} />
                <Icon className={cn('size-3.5 shrink-0', folder ? 'text-fg-3' : 'text-fg-4')} strokeWidth={1.7} />
                <span className={cn('min-w-0 flex-1 truncate', row.change && !folder && KIND_TEXT[row.change], row.gone && 'line-through opacity-70')}>{row.name}</span>
                {row.change && (folder
                  ? <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', KIND_DOT[row.change])} />
                  : <span aria-hidden className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', KIND_TEXT[row.change])}>{KIND_LETTER[row.change]}</span>)}
                {words && <span className="sr-only">{words}</span>}
              </button>
            )
          })}
          {[...dirs.values()].some(d => d.truncated) && <p className="px-2 py-1 text-[12px] text-fg-3">{tr('部分目录条目较多，列表已达到展示上限。')}</p>}
          {dirs.has('') && !rows.length && (changedOnly
            ? (
              <div className="px-2 py-1 text-[12px] text-fg-3" data-files-no-changes>
                <p>{tr('没有改动的文件。')}</p>
                <button type="button" onClick={() => showChanged(false)} className="mt-1 rounded text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{tr('显示全部文件')}</button>
              </div>
            )
            : <p className="px-2 py-1 text-[12px] text-fg-3">{tr('目录暂时没有可展示的文件。')}</p>)}
          {treeError && <p role="status" className="px-2 py-1 text-[12px] text-danger">{treeError}</p>}
        </div>
        <section ref={contentRef} tabIndex={-1} onKeyDown={onFileKey} aria-label={tr('文件内容')} data-files-pane="file" className={cn('min-w-0 flex-1 flex-col overflow-hidden outline-none @[640px]/files:flex', pane === 'tree' ? 'hidden' : 'flex')}>
          {selected
            ? <FilePreview key={`${projectId}:${selected}:${reloadKey}`} projectId={projectId} path={selected} size={selectedSize} revision={changes} />
            : <div className="grid h-full place-items-center px-4 text-center text-[13px] text-fg-3">{tr('选择文件查看内容。')}</div>}
        </section>
      </div>
      <PreviewForm open={formOpen} onOpenChange={setFormOpen} projectName={project?.name ?? tr('项目')} selected={selected} onStart={async (mode, entry) => {
        const result = await projectApi.startPreview(projectId, { mode, ...(mode === 'vite' ? { directory: entry, ...(sessionId ? { sessionId } : {}) } : { path: entry }) })
        showPreview(projectId, result)
      }} />
    </div>
  )
}

/** A header action whose words show from 520 px of container width; narrower, its icon with the words as a tooltip. */
function HeaderButton({ label, icon, onClick, disabled, busy, variant }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; variant?: 'ghost' }) {
  return (
    <Tooltip content={label}>
      <Button size="sm" variant={variant} disabled={disabled} aria-busy={busy} aria-label={label} leading={icon} onClick={onClick}>
        <span className="hidden @[520px]/files:inline">{label}</span>
      </Button>
    </Tooltip>
  )
}

function fileIcon(name: string) {
  if (/\.(md|mdx|txt|pdf|docx?)$/i.test(name)) return FileText
  if (/\.(m?[jt]sx?|css|html?|json|ya?ml|py|rs|go|sh|sql|mjs|cjs)$/i.test(name)) return FileCode2
  return File
}

function PreviewForm({ open, onOpenChange, projectName, selected, onStart }: { open: boolean; onOpenChange: (o: boolean) => void; projectName: string; selected: string; onStart: (mode: string, entry: string) => Promise<void> }) {
  const [mode, setMode] = useState('static')
  const [entry, setEntry] = useState('index.html')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setMode('static'); setEntry(/\.html?$/i.test(selected) ? selected : 'index.html'); setError('') } }, [open, selected])
  const launch = async () => {
    if (mode === 'static' && !entry.trim()) { setError(tr('请填写入口文件。')); return }
    setBusy(true); setError(tr('正在启动本机服务…'))
    try { await onStart(mode, entry.trim()); onOpenChange(false) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={o => { if (!busy) onOpenChange(o) }} title={tr('{projectName} · 运行预览', { projectName })}
      description={tr('静态 HTML 随文件变化自动刷新；已有 Vite 依赖的项目可启用开发服务器热更新。开发服务器执行项目配置，需要命令执行权限，不是操作系统沙箱。不会自动安装依赖。')}
      footer={<><Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{tr('取消')}</Button><Button variant="primary" disabled={busy} onClick={() => void launch()}>{tr('启动预览')}</Button></>}>
      <div className="space-y-3">
        <Field label={tr('预览方式')}>
          <Select value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setEntry(e.target.value === 'static' ? 'index.html' : '') }}>
            <option value="static">{tr('静态 HTML · 自动刷新')}</option>
            <option value="vite">{tr('Vite 项目 · 热更新')}</option>
          </Select>
        </Field>
        <Field label={tr('项目内入口或目录')}><TextInput value={entry} disabled={busy} placeholder={mode === 'static' ? 'index.html' : tr('留空使用项目根目录')} onChange={e => setEntry(e.target.value)} /></Field>
        {error && <p role="status" className="text-[12.5px] text-fg-3">{error}</p>}
      </div>
    </Dialog>
  )
}
