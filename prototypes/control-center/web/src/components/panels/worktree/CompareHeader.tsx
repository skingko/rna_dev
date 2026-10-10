/**
 * The 工作区改动 header (worktree design §3.1–3.3), as Claude Code's diff
 * panel lays it out: on the left the file tree's switch (⇧⌘Y) and the
 * comparison chip `<base> → <target> ⌄` with its menu (全部改动 / 未提交的改动 /
 * 本次对话的改动, and 对比分支 ▸ with a branch search); on the right the find
 * button (only when there are changes) and ⋯ (where the folder stands —
 * branch, upstream, ↑ ahead ↓ behind —, 查看其他工作树 ▸, Rna 工作树 and
 * 应用记录 (0.63), 按暂存状态分组, 自动换行, 显示新旧两列行号, 刷新). Maximize and
 * close stay on the group's strip. Without git it names 本次对话的改动 and keeps how
 * the diffs read and 刷新.
 */
import { useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, GitBranch, GitFork, History, ListTree, MoreHorizontal, RotateCw, Search } from 'lucide-react'
import { gitApi, type GitBranches, type GitCompare, type GitStatus, type GitWorktrees } from '@/api/git-api'
import type { WorktreeTabFields } from '@/store/side-panel-store'
import { Tooltip } from '@/components/ui/primitives'
import { isMac } from '@/components/workspace/menus'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { targetLabel, type PanelView } from './compare-model'
import { treeShortcut } from './tree-toggle'
import type { PanelSheet } from './sheets'

const itemClass = 'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3'
const contentClass = 'menu-content z-50 min-w-48 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none'
const iconButton = 'grid size-7 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active'

export interface CompareHeaderProps {
  projectId: string
  /** The folder is a repository whose state could be read. */
  git: boolean
  view: PanelView
  compare: GitCompare | null
  /** Where the shown folder stands (the ⋯ menu's first row); null until read. */
  status: GitStatus | null
  loading: boolean
  /** The project's name when the tab is bound to a project other than the current one. */
  scopeName: string | null
  /** Whether the file tree shows; null when this view has no tree. */
  treeShown: boolean | null
  onToggleTree: () => void
  /** There are changes to search. */
  canSearch: boolean
  findOpen: boolean
  onFind: () => void
  /** The shown folder is the project's own (stage and discard, 按暂存状态分组). */
  ownFolder: boolean
  onView: (patch: WorktreeTabFields) => void
  onRefresh: () => void
  /** The ⋯ menu opened (the panel reads another worktree's state then). */
  onMoreOpen?: () => void
  /** 0.63: open Rna 工作树 or 应用记录 in the panel (absent: not offered). */
  onSheet?: (sheet: PanelSheet) => void
  /** 0.63: the conversation's own worktree (its path), shown first under 查看其他工作树. */
  sessionWorktree?: string | null
}

export function CompareHeader(props: CompareHeaderProps) {
  const t = useT()
  const { git, treeShown, canSearch, findOpen, scopeName } = props
  const mac = isMac()
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-faint pl-1.5 pr-1.5" data-compare-header>
      <h2 className="sr-only">{t('工作区改动')}</h2>
      {treeShown !== null && (
        <Tooltip content={treeShown ? t('隐藏文件') : t('显示文件')} shortcut={treeShortcut(mac)}>
          <button type="button" onClick={props.onToggleTree} aria-pressed={treeShown} aria-label={treeShown ? t('隐藏文件') : t('显示文件')} data-tree-toggle
            className={cn(iconButton, treeShown && 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text')}>
            <ListTree className="size-4" />
          </button>
        </Tooltip>
      )}
      {git ? <CompareChip {...props} /> : <span className="truncate px-1.5 text-[13px] font-medium text-fg" data-compare-chip="rna">{t('本次对话的改动')}</span>}
      {scopeName && <span className="min-w-0 truncate text-[12px] text-fg-4">{scopeName}</span>}
      <span className="flex-1" />
      {canSearch && (
        <Tooltip content={t('在改动中查找')} shortcut={mac ? '⌘F' : 'Ctrl+F'}>
          <button type="button" onClick={props.onFind} aria-pressed={findOpen} aria-label={t('在改动中查找')} data-find-toggle className={cn(iconButton, findOpen && 'bg-active text-fg')}>
            <Search className="size-3.5" />
          </button>
        </Tooltip>
      )}
      <MoreMenu {...props} />
    </header>
  )
}

/** `<base> → <target> ⌄`, or `<target> · 未提交`, or 本次对话的改动, opening the comparison menu. */
function CompareChip({ projectId, view, compare, status, onView }: CompareHeaderProps) {
  const t = useT()
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const base = compare?.base ?? view.base ?? compare?.defaultBase ?? null
  const shownBase = view.mode === 'all' ? base : view.base ?? compare?.defaultBase ?? null
  const read = (open: boolean) => {
    if (!open) return
    setFailed(false); setQuery('')
    gitApi.branches(projectId, { worktree: view.target }).then(setBranches, () => setFailed(true))
  }
  const needle = query.trim().toLowerCase()
  const listed = branches?.branches.filter(branch => !needle || branch.name.toLowerCase().includes(needle)) ?? []
  const selected = view.mode === 'all' ? base ?? branches?.default ?? null : null
  const pick = (name: string) => onView({ mode: 'all', base: name === (compare?.defaultBase ?? branches?.default) ? null : name })

  // Before the comparison is read (or while grouping by stage, which reads none), the branch git status names.
  const target = compare ? targetLabel(compare.target, t) : status ? (status.detached ? t('分离') : status.branch ?? '…') : '…'
  let label: ReactNode, words: string
  if (view.mode === 'rna') { words = t('本次对话的改动'); label = <span className="truncate">{words}</span> }
  else if (view.mode === 'uncommitted') { words = `${target} · ${t('未提交')}`; label = <span className="truncate">{words}</span> }
  else {
    words = `${base ?? '…'} → ${target}`
    label = (
      <>
        <span className="max-w-[14em] min-w-[3em] shrink truncate" data-chip-base>{base ?? '…'}</span>
        <ArrowRight className="size-3 shrink-0 text-fg-4" aria-hidden />
        <span className="min-w-0 truncate" data-chip-target>{target}</span>
      </>
    )
  }
  return (
    <DropdownMenu.Root onOpenChange={read}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={t('选择对比方式：{comparison}', { comparison: words })} title={words} data-compare-chip={view.mode}
          className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-[13px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active">
          {label}
          <ChevronDown className="size-3 shrink-0 text-fg-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={10} className={cn(contentClass, 'w-64')} data-compare-menu>
          <ModeItem checked={view.mode === 'all'} hint={shownBase ? t('对比 {base}', { base: shownBase }) : undefined} onSelect={() => onView({ mode: 'all' })}>{t('全部改动')}</ModeItem>
          <ModeItem checked={view.mode === 'uncommitted'} onSelect={() => onView({ mode: 'uncommitted' })}>{t('未提交的改动')}</ModeItem>
          <ModeItem checked={view.mode === 'rna'} onSelect={() => onView({ mode: 'rna', rnaPicked: true })}>{t('本次对话的改动')}</ModeItem>
          <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
          <DropdownMenu.Sub onOpenChange={open => { if (open) requestAnimationFrame(() => search.current?.focus()) }}>
            <DropdownMenu.SubTrigger className={itemClass} data-compare-branches>
              <span className="min-w-0 flex-1 truncate">{t('对比分支')}</span>
              {shownBase && <span className="max-w-24 truncate text-[12px] text-fg-4">{shownBase}</span>}
              <ChevronRight className="!size-3.5 !text-fg-4" aria-hidden />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={10} className={cn(contentClass, 'w-80 p-0')} data-branch-menu>
                <div className="border-b border-line-faint p-1">
                  <input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder={t('搜索分支')} aria-label={t('搜索分支')} data-branch-search
                    onKeyDown={e => {
                      // Letters go to the field, not to the menu's type-to-select; ↓ steps into the list, Esc closes the menu.
                      if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.closest('[role=menu]')?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); return }
                      if (e.key !== 'Escape') e.stopPropagation()
                    }}
                    className="h-8 w-full rounded-lg bg-transparent px-2 text-[13px] text-fg outline-none placeholder:text-fg-4" />
                </div>
                <div className="max-h-72 overflow-y-auto p-1" role="none">
                  {failed ? <p className="px-2.5 py-1.5 text-[12.5px] text-fg-4">{t('没能读取分支。')}</p>
                    : !branches ? <p className="px-2.5 py-1.5 text-[12.5px] text-fg-4">{t('正在读取…')}</p>
                      : !listed.length ? <p className="px-2.5 py-1.5 text-[12.5px] text-fg-4">{t('没有匹配的分支')}</p>
                        : listed.map(branch => (
                          <DropdownMenu.Item key={branch.name} className={cn(itemClass, 'gap-2')} onSelect={() => pick(branch.name)} data-branch={branch.name}>
                            <span className={cn('min-w-0 flex-1 truncate', branch.name === selected ? 'font-medium text-fg' : 'text-fg-2')} title={branch.name}>{branch.name}</span>
                            {branch.name === selected && <Check className="!size-3.5 !text-accent" strokeWidth={2.2} aria-label={t('已选择')} />}
                            {branch.current && <Tag>{t('当前分支')}</Tag>}
                            {!branch.current && branch.worktreePath && <Tag title={branch.worktreePath}>{t('工作树')}</Tag>}
                            {branch.name === branches.default && <Tag>{t('默认')}</Tag>}
                          </DropdownMenu.Item>
                        ))}
                </div>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="shrink-0 text-[11.5px] text-fg-4" title={title}>{children}</span>
}

function ModeItem({ checked, hint, onSelect, children }: { checked: boolean; hint?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <DropdownMenu.CheckboxItem checked={checked} onSelect={onSelect} className={itemClass}>
      <span className={cn('min-w-0 flex-1 truncate', checked ? 'font-medium text-fg' : 'text-fg-2')}>{children}</span>
      {checked && <Check className="!size-3.5 !text-accent" strokeWidth={2.2} aria-hidden />}
      {hint && <span className="max-w-28 shrink-0 truncate text-[12px] text-fg-4">{hint}</span>}
    </DropdownMenu.CheckboxItem>
  )
}

function Toggle({ checked, disabled, onChange, children, hint }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: ReactNode; hint?: string }) {
  return (
    <DropdownMenu.CheckboxItem checked={checked} disabled={disabled} onCheckedChange={next => onChange(next === true)} onSelect={e => e.preventDefault()} className={itemClass}>
      <span className="grid size-4 shrink-0 place-items-center">{checked && <Check className="!size-3.5 !text-accent" strokeWidth={2.2} aria-hidden />}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[12px] text-fg-4">{hint}</span>}
    </DropdownMenu.CheckboxItem>
  )
}

/** ⋯: where the folder stands, other worktrees, how the diffs read, refresh. */
function MoreMenu({ projectId, git, view, status, loading, ownFolder, onView, onRefresh, onMoreOpen, onSheet, sessionWorktree }: CompareHeaderProps) {
  const t = useT()
  const [worktrees, setWorktrees] = useState<GitWorktrees | null>(null)
  const [failed, setFailed] = useState(false)
  const open = (next: boolean) => {
    if (!next || !git) return
    onMoreOpen?.()
    setFailed(false)
    gitApi.worktrees(projectId).then(setWorktrees, () => setFailed(true))
  }
  return (
    <DropdownMenu.Root onOpenChange={open}>
      {loading && <RotateCw className="size-3 shrink-0 animate-spin text-fg-4" aria-label={t('正在读取…')} data-header-loading />}
      <Tooltip content={t('更多')}>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={t('工作区改动选项')} className={iconButton}>
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={10} className={cn(contentClass, 'w-72')} data-more-menu>
          {git && status && <StandRow status={status} />}
          {git && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={itemClass} data-other-worktrees>
                <GitFork aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t('查看其他工作树')}</span>
                <ChevronRight className="!size-3.5 !text-fg-4" aria-hidden />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={10} className={cn(contentClass, 'w-80')} data-worktree-menu>
                  {failed ? <p className="px-2.5 py-1.5 text-[12.5px] text-fg-4">{t('没能读取工作树。')}</p>
                    : !worktrees ? <p className="px-2.5 py-1.5 text-[12.5px] text-fg-4">{t('正在读取…')}</p>
                      : worktrees.worktrees.map(row => {
                        const shown = view.target ? view.target === row.path : row.current
                        return (
                          <DropdownMenu.Item key={row.path} disabled={row.prunable || row.bare} data-worktree={row.path}
                            onSelect={() => onView(row.current ? { target: null } : { target: row.path, grouped: false })}
                            className={cn(itemClass, 'h-auto min-h-8 items-start py-1.5')}>
                            <GitBranch className="mt-0.5" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className={cn('block truncate', shown ? 'font-medium text-fg' : 'text-fg-2')} title={row.branch ?? undefined}>{row.branch ?? (row.detached ? t('分离') : row.bare ? t('裸仓库') : t('未分支'))}</span>
                              <span className="block truncate text-[11.5px] text-fg-4" title={row.path}>
                                {row.path}{row.locked ? ` · ${t('已锁定')}` : ''}{row.prunable ? ` · ${t('可清理')}` : ''}
                              </span>
                            </span>
                            {shown && <Check className="!size-3.5 !text-accent" strokeWidth={2.2} aria-label={t('已选择')} />}
                            {row.current ? <Tag>{t('项目文件夹')}</Tag> : row.main ? <Tag>{t('主工作树')}</Tag> : row.path === sessionWorktree ? <Tag>{t('这个对话')}</Tag> : row.rna ? <Tag title={row.owner ?? undefined}>Rna</Tag> : null}
                          </DropdownMenu.Item>
                        )
                      })}
                  <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
                  <p className="px-2.5 pb-1.5 pt-1 text-[12px] leading-[1.5] text-fg-4">{t('其他工作树只能查看。提交和推送请在终端或其他工具里完成。')}</p>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}
          {git && onSheet && (
            <>
              <DropdownMenu.Item className={itemClass} onSelect={() => onSheet('worktrees')} data-sheet="worktrees">
                <GitFork aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t('Rna 工作树')}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className={itemClass} onSelect={() => onSheet('applies')} data-sheet="applies">
                <History aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t('应用记录')}</span>
              </DropdownMenu.Item>
            </>
          )}
          {git && <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />}
          {git && (
            <Toggle checked={view.mode === 'uncommitted' && view.grouped && ownFolder} disabled={view.mode !== 'uncommitted' || !ownFolder} onChange={grouped => onView({ grouped })}
              hint={view.mode !== 'uncommitted' ? t('仅未提交的改动') : undefined}>{t('按暂存状态分组')}</Toggle>
          )}
          <Toggle checked={view.wrap} onChange={wrap => onView({ wrap })}>{t('自动换行')}</Toggle>
          <Toggle checked={view.numbers === 'both'} onChange={both => onView({ numbers: both ? 'both' : 'new' })}>{t('显示新旧两列行号')}</Toggle>
          <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
          <DropdownMenu.Item className={itemClass} onSelect={onRefresh} data-refresh>
            <RotateCw aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('刷新')}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The folder's branch, its upstream and how far ahead and behind it is (a row to read, not to pick). */
function StandRow({ status }: { status: GitStatus }) {
  const t = useT()
  return (
    <div className="mb-1 border-b border-line-faint px-2.5 pb-2 pt-1.5 text-[12px] text-fg-3" data-stand>
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-2">
        <GitBranch className="size-3.5 shrink-0 text-fg-4" aria-hidden />
        <span className="truncate" title={status.branch ?? undefined}>{status.detached ? t('分离') : status.branch ?? t('还没有分支')}</span>
        {status.initial && <span className="shrink-0 text-fg-4">· {t('还没有提交')}</span>}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 tabular-nums" data-upstream>
        {status.upstream ? (
          <>
            <span className="min-w-0 truncate text-fg-4" title={t('上游 {upstream}：领先 {ahead} 个提交，落后 {behind} 个', { upstream: status.upstream, ahead: status.ahead, behind: status.behind })}>{status.upstream}</span>
            <span className={cn('inline-flex shrink-0 items-center', status.ahead ? 'text-fg-2' : 'text-fg-4')}><ArrowUp className="size-3" aria-hidden />{status.ahead}</span>
            <span className={cn('inline-flex shrink-0 items-center', status.behind ? 'text-fg-2' : 'text-fg-4')}><ArrowDown className="size-3" aria-hidden />{status.behind}</span>
          </>
        ) : <span className="text-fg-4">{t('没有上游')}</span>}
      </div>
    </div>
  )
}
