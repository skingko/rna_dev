/**
 * The 工作区改动 file tree (worktree design §3.4): the comparison's paths as
 * folders and files, single-child folder chains in one row (`api/search`),
 * 14 px per level, each file with +N −M on the right (二进制, 大文件 for a new
 * file too large to count), deleted files struck through, a moved file's old
 * name on hover. The row of the diff in view is marked; a click scrolls the
 * diffs to the file. Keyboard: ↑/↓ move, ← folds or goes to the folder, →
 * opens or steps in, Enter shows the diff. Virtualized, with its own scroll.
 * 本次对话的改动 adds a row per turn or background run (folded like a folder)
 * with its files' tree one level in; there a file row is keyed per group.
 */
import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Clock3, File, FileCode2, FileText, Folder, FolderOpen, FolderGit2, MessageSquareText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { isFolderRow, type StackFile, type TreeRow } from './compare-model'

const ROW = 26
/** Pixels per level of depth (FilesView's tree). */
const INDENT = 14

export function fileIcon(name: string) {
  if (/\.(md|mdx|txt|pdf|docx?)$/i.test(name)) return FileText
  if (/\.(m?[jt]sx?|css|html?|json|ya?ml|py|rs|go|sh|sql|mjs|cjs|toml|swift|kt|java|rb|php|c|h|cpp|cs|vue|svelte)$/i.test(name)) return FileCode2
  return File
}

export interface ChangeTreeProps {
  rows: TreeRow[]
  /** The file whose diff is in view. */
  active: string | null
  collapsed: ReadonlySet<string>
  onToggleFolder: (path: string) => void
  onPick: (path: string) => void
  className?: string
}

export function ChangeTree({ rows, active, collapsed, onToggleFolder, onPick, className }: ChangeTreeProps) {
  const t = useT()
  const id = useId()
  const scroller = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const index = useMemo(() => new Map(rows.map((row, i) => [rowKey(row), i])), [rows])
  const keyOf = rowKey
  // The keyboard's place: where it was moved, else the diff in view, else the first row.
  const at = cursor !== null && index.has(cursor) ? index.get(cursor)! : active && index.has(active) ? index.get(active)! : 0
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12, getItemKey: i => keyOf(rows[i]), initialRect: { width: 230, height: 600 } })

  // The diff in view stays in sight in the tree.
  useEffect(() => { if (active && index.has(active)) virtual.scrollToIndex(index.get(active)!, { align: 'auto' }) }, [active, index, virtual])

  const move = (to: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, to))
    const row = rows[next]
    if (!row) return
    setCursor(keyOf(row))
    virtual.scrollToIndex(next, { align: 'auto' })
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[at]
    if (!row || e.altKey || e.metaKey || e.ctrlKey) return
    const folds = row.kind !== 'file'
    const open = folds && !collapsed.has(row.path)
    let handled = true
    switch (e.key) {
      case 'ArrowDown': move(at + 1); break
      case 'ArrowUp': move(at - 1); break
      case 'Home': move(0); break
      case 'End': move(rows.length - 1); break
      case 'ArrowRight':
        if (folds) { if (!open) onToggleFolder(row.path); else move(at + 1) }
        break
      case 'ArrowLeft': {
        if (open) { onToggleFolder(row.path); break }
        // To the folder holding it: the nearest row above that is less deep.
        for (let i = at - 1; i >= 0; i--) if (rows[i].depth < row.depth) { move(i); break }
        break
      }
      case 'Enter': case ' ':
        if (folds) onToggleFolder(row.path)
        else onPick(row.path)
        break
      default: handled = false
    }
    if (handled) e.preventDefault()
  }

  return (
    <div ref={scroller} role="tree" aria-label={t('改动的文件')} tabIndex={0} onKeyDown={onKey} data-change-tree
      aria-activedescendant={rows[at] ? `${id}-${at}` : undefined}
      className={cn('group/tree min-h-0 overflow-y-auto overflow-x-hidden py-1 outline-none scroll-quiet', className)}>
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map(item => {
          const row = rows[item.index]
          return (
            <div key={item.key} className="absolute left-0 w-full px-1" style={{ top: item.start, height: ROW }}>
              <TreeItem id={`${id}-${item.index}`} row={row} active={row.kind === 'file' && row.path === active} cursor={item.index === at}
                open={row.kind !== 'file' && !collapsed.has(row.path)}
                onClick={() => { setCursor(keyOf(row)); if (row.kind !== 'file') onToggleFolder(row.path); else onPick(row.path) }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A row's place in the tree's keyboard index (a folder and a file never share one, nor a group). */
const rowKey = (row: TreeRow) => (row.kind === 'folder' ? `${row.path}/` : row.kind === 'group' ? `#${row.path}` : row.path)

const TreeItem = memo(function TreeItem({ id, row, active, cursor, open, onClick }: { id: string; row: TreeRow; active: boolean; cursor: boolean; open: boolean; onClick: () => void }) {
  const t = useT()
  if (row.kind === 'group') return <GroupItem id={id} row={row} cursor={cursor} open={open} onClick={onClick} />
  const folder = row.kind === 'folder'
  const file = row.kind === 'file' ? row.file : null
  const repository = file ? isFolderRow(file) : false
  const Icon = folder ? (open ? FolderOpen : Folder) : repository ? FolderGit2 : fileIcon(row.name)
  const title = file ? (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path) : row.kind === 'folder' ? row.title : row.path
  return (
    <div id={id} role="treeitem" aria-level={row.depth + 1} aria-expanded={folder ? open : undefined} aria-selected={active} title={title}
      data-tree-row={row.path} data-tree-kind={row.kind} data-active={active || undefined} data-cursor={cursor || undefined} onClick={onClick}
      className={cn('flex h-[26px] cursor-default select-none items-center gap-1.5 rounded-md pr-1.5 text-[12.5px] transition-colors',
        active ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
        cursor && 'group-focus-visible/tree:shadow-[inset_0_0_0_2px_var(--line-focus)]')}
      style={{ paddingLeft: 4 + row.depth * INDENT }}>
      <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-150', !folder && 'invisible', open && 'rotate-90')} aria-hidden />
      <Icon className={cn('size-3.5 shrink-0', folder ? 'text-fg-3' : 'text-fg-4')} strokeWidth={1.7} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', file?.status === 'D' && 'line-through decoration-fg-4 opacity-80')}>{row.name}</span>
      {file && <TreeStat file={file} />}
      {file?.status === 'D' && <span className="sr-only">{t('已删除')}</span>}
    </div>
  )
})

/** A turn's or a background run's row (本次对话的改动): folds its files; 本轮 marks the conversation's latest turn. */
function GroupItem({ id, row, cursor, open, onClick }: { id: string; row: Extract<TreeRow, { kind: 'group' }>; cursor: boolean; open: boolean; onClick: () => void }) {
  const t = useT()
  const Icon = row.group.kind === 'turn' ? MessageSquareText : Clock3
  return (
    <div id={id} role="treeitem" aria-level={row.depth + 1} aria-expanded={open} aria-selected={false} title={row.name}
      data-tree-row={row.path} data-tree-kind="group" data-cursor={cursor || undefined} onClick={onClick}
      className={cn('flex h-[26px] cursor-default select-none items-center gap-1.5 rounded-md pr-1.5 text-[12px] font-medium transition-colors hover:bg-hover',
        row.group.muted ? 'text-fg-4' : 'text-fg-3 hover:text-fg-2', cursor && 'group-focus-visible/tree:shadow-[inset_0_0_0_2px_var(--line-focus)]')}
      style={{ paddingLeft: 4 + row.depth * INDENT }}>
      <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
      <Icon className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {row.group.tag && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10.5px] font-medium text-accent-text">{row.group.tag}</span>}
      <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-fg-4" aria-label={t('{count} 个文件', { count: row.group.files.length })}>{row.group.files.length}</span>
    </div>
  )
}

/** +N −M on the right; 二进制 / 大文件 / 仓库 / 已覆盖 when there is nothing to count. */
export function TreeStat({ file }: { file: StackFile }) {
  const t = useT()
  if (isFolderRow(file)) return <span className="shrink-0 text-[11.5px] text-fg-4">{t('仓库')}</span>
  if (file.overwritten) return <span className="shrink-0 text-[11.5px] text-fg-4" title={t('覆盖了整个文件，之前的内容没有记录，所以没有差异可看。')} data-stat="overwritten">{t('已覆盖')}</span>
  if (file.binary) return <span className="shrink-0 text-[11.5px] text-fg-4">{t('二进制')}</span>
  if (file.added === null || file.removed === null) return <span className="shrink-0 text-[11.5px] text-fg-4">{file.untracked ? t('大文件') : ''}</span>
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums" data-stat>
      <span className="text-[var(--diff-add-fg)]">+{file.added}</span>
      <span className="ml-1 text-[var(--diff-del-fg)]">−{file.removed}</span>
    </span>
  )
}
