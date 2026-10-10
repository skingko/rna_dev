/**
 * 工作区改动 panel (worktree design §3): one comparison, `<base> → <target>`,
 * as Claude Code's diff panel shows it. In a repository the default is
 * 全部改动 (merge-base with the default branch → the working tree, committed
 * and uncommitted work and new files together); 未提交的改动 starts from
 * HEAD and can be grouped by stage again (staged / unstaged / untracked with
 * stage, unstage and the two-step discard, on the project folder only);
 * 本次对话的改动 is Rna's own record — laid out the same way, grouped by turn
 * and background run — and the only view of a folder that is not a
 * repository. ⋯ can point the panel at another worktree of the repository,
 * read-only. Lays out by its own width (container queries; below 520 px the
 * file tree opens over the diffs); refreshes on open, on window focus, when a
 * run ends, and from ⋯.
 *
 * 0.63 (worktree design §12): ⋯ also opens Rna 工作树 and 应用记录 in the
 * panel (sheets.ts; a turn footer's 查看 and a subagent card's 查看改动 open
 * them from outside); a worktree conversation's panel shows its own copy
 * (`sessionWorktree`), whose uncommitted changes are what the conversation has
 * not applied yet; a folder that is not a repository offers 初始化….
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { GitFork, GitPullRequestCreate, TriangleAlert } from 'lucide-react'
import { gitApi, type GitCompareFile, type GitDiscardPreview, type GitOperation, type GitStatus } from '@/api/git-api'
import type { ProjectSummary } from '@/api/types'
import type { WorktreeTabFields } from '@/store/side-panel-store'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { loadGitStatus, setGitStatus, useGitStatus, useGitWatch } from '@/lib/workspace-changes'
import { Button, Skeleton } from '@/components/ui/primitives'
import { isMac } from '@/components/workspace/menus'
import { t as tr, useT, type MessageKey } from '@/i18n'
import { CompareHeader } from './CompareHeader'
import { CompareSkeleton, CompareView } from './CompareView'
import { DiscardBar, GitChangeList } from './GitChangeList'
import { RnaChanges } from './RnaChanges'
import { FIND_STYLE, type FileActions } from './StackedDiff'
import { NARROW_PANEL, resolveView, type CompareMode, type PanelView } from './compare-model'
import { readSetFiles, useRnaListing } from './rna-model'
import { hasGit } from './model'
import { registerTreeToggle } from './tree-toggle'
import { useCompare, useWorktreeStatus } from './use-compare'
import { ApplyHistory } from './ApplyHistory'
import { RnaWorktrees } from './RnaWorktrees'
import { takeSheet, usePanelSheets, type PanelSheet } from './sheets'
import { GitInitDialog } from '@/components/git/GitInitDialog'

/** A moved file is staged or discarded by both of its names. */
const namesOf = (file: GitCompareFile) => (file.oldPath ? [file.path, file.oldPath] : [file.path])

const OPERATION: Record<GitOperation, MessageKey> = {
  merge: '正在合并：解决冲突并完成合并之前，这里的改动还没有落定。',
  rebase: '正在变基：完成或放弃变基之前，这里的改动还没有落定。',
  'cherry-pick': '正在拣选提交：完成或放弃之前，这里的改动还没有落定。',
  revert: '正在撤销提交：完成或放弃之前，这里的改动还没有落定。',
  bisect: '正在二分查找出问题的提交：当前文件是某个中间版本。',
}

export interface WorktreePanelProps {
  /** The project shown (the tab's own, or the current one when it follows); null: none selected. */
  projectId: string | null
  /** The selected conversation; its edits are listed when it belongs to this project. */
  sessionId: string | null
  /** The tab follows the current project (the header then leaves the project's name out). */
  following: boolean
  visible?: boolean
  /** The tab's comparison (side-panel-store's `worktreeView`). */
  fields: WorktreeTabFields
  onChange: (patch: WorktreeTabFields) => void
  /** The tab, for ⇧⌘Y. */
  tabId?: string
  /** 0.63: the selected conversation runs in its own worktree of this project (its path, the panel's `target` for it). */
  sessionWorktree?: string | null
}

/** The panel's width as laid out (0 until measured). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.offsetWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export function WorktreePanel({ projectId, sessionId, following, visible = true, fields, onChange, tabId, sessionWorktree = null }: WorktreePanelProps) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  const narrow = width > 0 && width < NARROW_PANEL
  const entry = useGitStatus(s => (projectId ? s.rows[projectId] : undefined))
  const status = entry?.status ?? null
  const git = hasGit(status)
  const view = resolveView(fields, git)
  const project = useApp(s => (projectId ? s.projects[projectId] : undefined))
  const sessionProject = useApp(s => (sessionId ? s.sessionIndex[sessionId]?.projectId ?? s.sessions[sessionId]?.meta.projectId ?? null : null))
  // Only this project's conversation: a turn ending in another project changes nothing here.
  const ownSession = sessionProject === projectId ? sessionId : null
  useGitWatch(projectId, ownSession, { enabled: visible })

  // Rna 工作树 / 应用记录, from ⋯ or asked for from elsewhere (a turn footer's 查看).
  const [sheet, setSheet] = useState<{ sheet: PanelSheet; focus: string | null } | null>(null)
  const request = usePanelSheets(s => (projectId ? s.requests[projectId] : undefined))
  useEffect(() => {
    if (!projectId || !request) return
    setSheet(request.sheet ? { sheet: request.sheet, focus: request.focus ?? null } : null)
    takeSheet(projectId, request)
  }, [projectId, request])

  // The first read of the folder's git state.
  const firstRead = !entry || (entry.at === 0 && !entry.error)
  // One root in every state, so its width is watched from the first render (a restored tab draws before the projects load).
  return (
    <div ref={rootRef} className="@container/worktree relative flex h-full min-h-0 flex-col bg-base" data-worktree-panel data-mode={!projectId || !project || firstRead ? undefined : view.mode}>
      {!projectId || !project ? (
        <>
          <header className="flex h-10 shrink-0 items-center border-b border-line-faint px-3"><h2 className="truncate text-[13px] font-medium text-fg">{t('工作区改动')}</h2></header>
          <p className="mx-auto max-w-[300px] px-4 pt-[clamp(32px,12vh,96px)] text-center text-[12.5px] leading-[1.6] text-fg-3">{t('改动属于项目。选择一个项目或其中的会话后，这里会显示它的改动。')}</p>
        </>
      ) : firstRead
        ? <><header className="flex h-10 shrink-0 items-center border-b border-line-faint px-3" /><ListSkeleton /></>
        : <PanelBody key={`${projectId}:${view.target ?? ''}`} projectId={projectId} project={project} ownSession={ownSession} following={following} status={status} git={git} view={view}
          error={entry?.error ?? null} statusAt={entry?.at ?? 0} statusLoading={Boolean(entry?.loading)} width={width} narrow={narrow} onChange={onChange} tabId={tabId}
          sheet={sheet} onSheet={setSheet} sessionWorktree={sessionWorktree} />}
      <style>{FIND_STYLE}</style>
    </div>
  )
}

interface PanelBodyProps {
  projectId: string
  project: ProjectSummary
  ownSession: string | null
  following: boolean
  status: GitStatus | null
  git: boolean
  view: PanelView
  error: string | null
  statusAt: number
  statusLoading: boolean
  width: number
  narrow: boolean
  onChange: (patch: WorktreeTabFields) => void
  tabId?: string
  sheet: { sheet: PanelSheet; focus: string | null } | null
  onSheet: (sheet: { sheet: PanelSheet; focus: string | null } | null) => void
  sessionWorktree: string | null
}

function PanelBody({ projectId, project, ownSession, following, status, git, view, error, statusAt, statusLoading, width, narrow, onChange, tabId, sheet, onSheet, sessionWorktree }: PanelBodyProps) {
  const t = useT()
  const own = view.target === null
  const grouped = git && view.mode === 'uncommitted' && view.grouped && own
  const compareMode: CompareMode | null = git && view.mode !== 'rna' && !grouped ? view.mode : null
  // 本次对话的改动: Rna's own records, the only view without git.
  const rnaMode = !git || view.mode === 'rna'
  const listing = useRnaListing(projectId, ownSession, project.workspacePath, rnaMode)
  const read = useCompare(projectId, compareMode, view.base, view.target)
  const other = useWorktreeStatus(projectId, view.target)
  const writable = own && project.permissions?.workspace !== 'read' && !project.archivedAt

  // The project folder's list is read again whenever its git state is (focus, a run ending, a write).
  const seenAt = useRef(statusAt)
  const { reload } = read
  useEffect(() => {
    const before = seenAt.current
    seenAt.current = statusAt
    if (before && statusAt !== before && own) reload()
  }, [statusAt, own, reload])
  // A base branch that is gone: back to the default one, said once.
  useEffect(() => {
    if (read.error?.code !== 'git_base_not_found' || !view.base) return
    toast(tr('分支「{name}」已不存在，改为对比默认分支。', { name: view.base }))
    onChange({ base: null })
  }, [read.error, view.base, onChange])

  // The tree: remembered per tab on a wide panel; over the diffs, opened each time, on a narrow one.
  const stacked = compareMode !== null || rnaMode
  const [overlay, setOverlay] = useState(false)
  useEffect(() => { if (!narrow) setOverlay(false) }, [narrow])
  const treeShown = narrow ? overlay : view.tree ?? true
  const toggleTree = useCallback(() => {
    if (!stacked) return false
    if (narrow) setOverlay(open => !open)
    else onChange({ tree: !(view.tree ?? true) })
    return true
  }, [stacked, narrow, view.tree, onChange])
  useEffect(() => (tabId ? registerTreeToggle(tabId, toggleTree) : undefined), [tabId, toggleTree])

  // Find: the magnifier, or ⌘F while the panel has the keyboard.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocus, setFindFocus] = useState(0)
  const hasChanges = rnaMode ? listing.files.length > 0 : Boolean(read.compare?.files.length)
  useEffect(() => { if (!stacked || !hasChanges) setFindOpen(false) }, [stacked, hasChanges])
  const openFind = useCallback(() => { setFindOpen(true); setFindFocus(n => n + 1) }, [])
  const closeFind = useCallback(() => { setFindOpen(false); bodyRef.current?.querySelector<HTMLElement>('[data-stacked-diff]')?.focus({ preventScroll: true }) }, [])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const primary = isMac() ? e.metaKey : e.ctrlKey
    if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && stacked && hasChanges) { e.preventDefault(); e.stopPropagation(); openFind() }
    // Esc anywhere in the panel closes the find bar first (a menu that took the key has marked it handled); the workspace hides the panels only after that.
    else if (e.key === 'Escape' && findOpen && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closeFind() }
  }

  // Stage and discard (uncommitted work in the project folder): the answer carries the folder's fresh state.
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState<{ paths: string[]; preview: GitDiscardPreview } | null>(null)
  const write = useCallback(async (work: () => Promise<{ status: GitStatus }>, done?: string) => {
    setBusy(true)
    try { const result = await work(); setGitStatus(projectId, result.status); if (done) toast(done) }
    catch (failure) { toast((failure as Error).message, 'danger'); void loadGitStatus(projectId) }
    finally { setBusy(false) }
  }, [projectId])
  const workspacePath = project.workspacePath, stageable = writable && view.mode === 'uncommitted'
  // Kept the same between renders, so the diffs' sections redraw only when their own file changes.
  const actions = useMemo<FileActions>(() => ({
    projectId, root: own ? workspacePath : undefined, readOnly: !own, writable: stageable, busy,
    onStage: file => void write(() => gitApi.stage(projectId, namesOf(file)), tr('已暂存「{name}」。', { name: file.path.split('/').pop() ?? file.path })),
    onDiscard: async file => {
      setBusy(true)
      try { const paths = namesOf(file); setDiscard({ paths, preview: await gitApi.previewDiscard(projectId, paths) }) }
      catch (failure) { toast((failure as Error).message, 'danger'); void loadGitStatus(projectId) }
      finally { setBusy(false) }
    },
  }), [projectId, own, workspacePath, stageable, busy, write])
  useEffect(() => {
    if (!discard) return
    const timer = setTimeout(() => setDiscard(null), Math.max(0, Date.parse(discard.preview.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [discard])
  const confirmDiscard = () => {
    if (!discard) return
    const { paths, preview } = discard
    setDiscard(null)
    void write(() => gitApi.confirmDiscard(projectId, paths, preview.confirm), t('已丢弃 {n} 个文件的改动。', { n: preview.files.length }))
  }

  const refresh = () => {
    void loadGitStatus(projectId)
    if (!own) { read.reload(); other.read() }
    // A change set whose files could not be read is read again.
    if (rnaMode) readSetFiles(projectId, project.backgroundChanges ?? [])
  }
  const shownStatus = own ? status : other.status
  const operation = read.compare?.operation ?? (own ? status?.operation : null) ?? null
  const footnote = error && !status ? t('没能读取 Git 状态：{error}', { error }) : status?.unavailable ? status.message ?? null : null
  // A plain folder (git answered, no repository): it can be made one (worktree design §10).
  const initable = !git && status?.repo === 'none' && !status.unavailable && !error && project.permissions?.workspace !== 'read'
  const [initOpen, setInitOpen] = useState(false)
  const layout = {
    wrap: view.wrap, numbers: view.numbers, treeShown: !narrow && treeShown, overlay: narrow && overlay, onCloseOverlay: () => setOverlay(false), width,
    findOpen, findFocus, onCloseFind: closeFind,
  }
  const rna = <RnaChanges projectId={projectId} sessionId={ownSession} workspace={project.workspacePath} listing={listing} {...layout} />

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey} ref={bodyRef}>
      <CompareHeader projectId={projectId} git={git} view={view} compare={read.compare} status={shownStatus} loading={statusLoading || read.loading} scopeName={following ? null : project.name}
        treeShown={stacked ? treeShown : null} onToggleTree={toggleTree} canSearch={stacked && hasChanges} findOpen={findOpen} onFind={() => (findOpen ? setFindOpen(false) : openFind())}
        ownFolder={own} onView={patch => { onSheet(null); onChange(patch) }} onRefresh={refresh} onMoreOpen={own ? undefined : other.read}
        onSheet={next => onSheet({ sheet: next, focus: null })} sessionWorktree={sessionWorktree} />
      {operation && (
        <div role="status" className="flex shrink-0 items-start gap-2 border-b border-line-faint bg-warning-soft px-3 py-2 text-[12.5px] leading-[1.55] text-warning-text" data-operation={operation}>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t(OPERATION[operation])}</span>
        </div>
      )}
      {git && !own && !sheet && <OtherWorktreeBar path={view.target!} branch={read.compare?.target?.label ?? other.status?.branch ?? null} conversation={view.target === sessionWorktree} onBack={() => onChange({ target: null })} />}
      {sheet?.sheet === 'worktrees' ? (
        <RnaWorktrees projectId={projectId} onBack={() => onSheet(null)} onView={path => { onSheet(null); onChange({ target: path, mode: 'uncommitted', grouped: false }) }} />
      ) : sheet?.sheet === 'applies' ? (
        <ApplyHistory projectId={projectId} sessionId={ownSession} focus={sheet.focus} onBack={() => onSheet(null)} />
      ) : !git ? (
        <>
          <p className="flex shrink-0 items-center gap-1.5 border-b border-line-faint px-3 py-1.5 text-[12px] text-fg-4" data-not-git>
            <span className="min-w-0 flex-1">{footnote ?? t('这个项目文件夹不是 Git 仓库')}</span>
            {initable && <button type="button" onClick={() => setInitOpen(true)} className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" data-git-init><GitPullRequestCreate className="size-3.5" />{t('初始化…')}</button>}
          </p>
          {rna}
          {initable && <GitInitDialog projectId={projectId} open={initOpen} onClose={() => setInitOpen(false)} />}
        </>
      ) : view.mode === 'rna' ? rna
        : grouped ? <GitChangeList projectId={projectId} status={status!} workspace={project.workspacePath} writable={writable} readAt={statusAt} wrap={view.wrap} numbers={view.numbers} />
          : read.compare && !read.compare.unavailable && read.compare.target !== null ? (
            <CompareView key={`${compareMode}:${view.base ?? ''}`} projectId={projectId} mode={compareMode!} target={view.target} compare={read.compare} actions={actions} {...layout} />
          ) : read.error || read.compare?.unavailable ? (
            <CompareProblem message={read.error?.message ?? read.compare?.message ?? t('这个文件的差异暂时读不到。')} code={read.error?.code} view={view} onChange={onChange} />
          ) : <CompareSkeleton />}
      {discard && <DiscardBar key={discard.preview.confirm} preview={discard.preview} busy={busy} fallback={bodyRef} onCancel={() => setDiscard(null)} onConfirm={confirmDiscard} />}
    </div>
  )
}

/**
 * Another worktree is shown: which one, that it is read-only, and the way back. `conversation`: the selected
 * conversation's own worktree, whose uncommitted changes are what it has not applied to the project folder yet.
 */
function OtherWorktreeBar({ path, branch, conversation, onBack }: { path: string; branch: string | null; conversation?: boolean; onBack: () => void }) {
  const t = useT()
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-faint bg-subtle px-3 text-[12px] text-fg-3" data-other-worktree={path} data-conversation-worktree={conversation ? '' : undefined}>
      <GitFork className="size-3.5 shrink-0 text-fg-4" aria-hidden />
      {conversation
        ? <span className="shrink-0 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent-text" title={t('未提交的改动就是这个对话还没应用到项目文件夹的改动。')}>{t('这个对话的工作树')}</span>
        : <span className="shrink-0 rounded bg-hover px-1 text-[11px] font-medium text-fg-3">{t('只读')}</span>}
      {branch && <span className="max-w-[40%] shrink-0 truncate text-fg-2" title={branch}>{branch}</span>}
      <span className="min-w-0 flex-1 truncate text-fg-4" title={path}>{path}</span>
      <button type="button" onClick={onBack} className="shrink-0 rounded px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('返回项目文件夹')}</button>
    </div>
  )
}

/** The comparison could not be listed: the host's sentence, and a way out where there is one. */
function CompareProblem({ message, code, view, onChange }: { message: string; code?: string; view: PanelView; onChange: (patch: WorktreeTabFields) => void }) {
  const t = useT()
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4" data-compare-problem={code ?? 'unavailable'}>
      <div className="flex max-w-[320px] flex-col items-center gap-2 text-center">
        <p className="text-[13px] leading-[1.6] text-fg-3">{message}</p>
        {code === 'no_common_history' && (view.base
          ? <Button size="sm" variant="ghost" onClick={() => onChange({ base: null })}>{t('对比默认分支')}</Button>
          : <Button size="sm" variant="ghost" onClick={() => onChange({ mode: 'uncommitted' })}>{t('未提交的改动')}</Button>)}
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2 px-3 pt-3" aria-hidden data-worktree-loading>
      <Skeleton className="h-3 w-20" />
      {[0, 1, 2, 3].map(i => <div key={i} className="flex items-center gap-2"><Skeleton className="size-3.5" /><Skeleton className="h-3 flex-1" /><Skeleton className="h-3 w-8" /></div>)}
    </div>
  )
}
