/**
 * The 工作区改动 diffs, stacked (worktree design §3.5): one scrolling column,
 * a section per file in the tree's order, virtualized by section (32 px for
 * the header plus 20 px a row by guess, measured once drawn). Each header
 * stays at the top while its file scrolls by: chevron, icon, bold name, dim
 * folder, +N −M and the file's ⋯ (open, show in Finder, copy the path; stage
 * and discard for uncommitted work in the project folder). The body is the
 * shared DiffView: green and red rows, a bar beside each run of changes,
 * syntax colour, soft wrap; 展开 N 行 reads the file whole. A file with more
 * than 1000 changed lines waits behind 显示 N 行改动. Patches are asked for
 * as sections come near the viewport (PatchStore batches them). Keyboard in
 * the column: ⌥↓ / ⌥↑ to the next / previous file, Space folds the file in
 * view. Files are keyed by `keyOf` (本次对话的改动 lists a file once per turn or
 * run); there, a group's label (the turn or run, with its 审阅 and 回退这些修改)
 * goes above the group's first section.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { DropdownMenu } from 'radix-ui'
import { ChevronRight, Copy, ExternalLink, FolderSearch, MoreHorizontal, Plus, Undo2 } from 'lucide-react'
import { patchLines, type DiffLine } from '@/lib/diff'
import { desktopErrorText, desktopRevealPath } from '@/lib/desktop'
import { openDock, toast } from '@/store/ui-store'
import { DiffView } from '@/components/diff/DiffView'
import { diffLanguage } from '@/components/diff/language'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { FileMenu } from './FileMenu'
import { changedLines, estimateSection, isFolded, isFolderRow, keyOf, type FindMatch, type StackFile } from './compare-model'
import { fileIcon, TreeStat } from './ChangeTree'
import { isLarge, splitPath } from './model'
import type { DiffSource, PatchEntry, SectionDiff } from './patch-store'

/** Sections drawn beyond the viewport on each side. */
const OVERSCAN = 2
/** Patches are asked for this many sections beyond what is drawn. */
const AHEAD = 3

const parsed = new WeakMap<SectionDiff, DiffLine[]>()
/**
 * A section's rows (cached per answer): the same array the find bar searches and DiffView draws, so their indexes
 * agree. Rows computed from recorded texts come as they are; a patch is parsed.
 */
export function linesOf(diff: SectionDiff | undefined): DiffLine[] | null {
  if (!diff || (diff.kind !== 'patch' && diff.kind !== 'truncated')) return null
  if (diff.lines) return diff.lines
  if (!diff.patch) return null
  let lines = parsed.get(diff)
  if (!lines) {
    // A first hunk that starts at the top hides nothing: its "第 1 行起" says nothing either.
    const all = patchLines(diff.patch).lines
    parsed.set(diff, lines = all[0]?.type === 'gap' && !all[0].skipped ? all.slice(1) : all)
  }
  return lines
}

export interface FileActions {
  projectId: string
  /** The folder the paths are relative to (copying and showing a file); undefined when it isn't known. */
  root: string | undefined
  /** Another worktree: its files are only read here (no opening, showing in Finder, staging). */
  readOnly: boolean
  /** Stage and discard are offered (uncommitted work in the project folder, which may be written). */
  writable: boolean
  busy: boolean
  onStage: (file: StackFile) => void
  onDiscard: (file: StackFile) => void
}

export interface StackedDiffHandle {
  /** Bring a file (by key) and one of its diff rows into view. */
  scrollToFile: (key: string, line?: number) => void
  focus: () => void
}

export interface StackedDiffProps {
  files: StackFile[]
  store: DiffSource
  /** The store's version: a change draws again. */
  version: number
  wrap: boolean
  numbers: 'new' | 'both'
  /** Folded files (keys), as `shown` and `active`. */
  collapsed: ReadonlySet<string>
  onCollapse: (key: string) => void
  /** Large files shown anyway. */
  shown: ReadonlySet<string>
  onShow: (key: string) => void
  active: string | null
  onActive: (key: string) => void
  /** The find bar's query and current match, while it is open. */
  find: { query: string; current: FindMatch | null } | null
  actions: FileActions
  /** A group's label (本次对话的改动), drawn above the group's first section. */
  groupLabel?: (group: string) => ReactNode
  /** Drawn after the last section, in the same scroll. */
  footer?: ReactNode
}

export const StackedDiff = forwardRef<StackedDiffHandle, StackedDiffProps>(function StackedDiff(props, ref) {
  const { files, store, version, wrap, numbers, collapsed, onCollapse, shown, onShow, active, onActive, find, actions, groupLabel, footer } = props
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const index = useMemo(() => new Map(files.map((file, i) => [keyOf(file), i])), [files])
  const virtual = useVirtualizer({
    count: files.length, getScrollElement: () => scroller.current, overscan: OVERSCAN, getItemKey: i => keyOf(files[i]), initialRect: { width: 600, height: 600 },
    estimateSize: i => {
      const file = files[i], key = keyOf(file)
      // A group's label above its first section: about one row more.
      const lead = groupLabel && file.group && file.group !== files[i - 1]?.group ? 40 : 0
      return lead + estimateSection(file, { collapsed: collapsed.has(key), shown: shown.has(key), lines: linesOf(store.entry(key).diff)?.length ?? null })
    },
  })
  // Drawn sections are measured as they change (a patch read, wrap, folding): the virtualizer watches their size.
  const items = virtual.getVirtualItems()
  const first = items[0]?.index ?? 0, last = items.at(-1)?.index ?? -1
  // Read the patches of what is drawn and a little further.
  useEffect(() => {
    if (last < 0) return
    const near: string[] = []
    for (let i = Math.max(0, first - 1); i <= Math.min(files.length - 1, last + AHEAD); i++) {
      const file = files[i], key = keyOf(file)
      if (collapsed.has(key) || file.binary || isFolderRow(file) || (isFolded(file) && !shown.has(key))) continue
      near.push(key)
    }
    store.want(near)
  }, [first, last, files, collapsed, shown, store, version])

  // The file in view: the first section whose end is below the top.
  const frame = useRef(0)
  const noteActive = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const top = scroller.current?.scrollTop ?? 0
      const item = virtual.getVirtualItems().find(row => row.end > top + 1)
      if (item && files[item.index]) onActive(keyOf(files[item.index]))
    })
  }, [virtual, files, onActive])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // A row asked for (a find match) is brought to the middle once its section is drawn.
  const pending = useRef<{ key: string; line: number } | null>(null)
  const reveal = useCallback(() => {
    const want = pending.current, root = scroller.current
    if (!want || !root) return false
    const section = sectionOf(root, want.key)
    if (!section) return false
    const target = want.line < 0 ? section.querySelector<HTMLElement>('[data-section-header]') : section.querySelectorAll<HTMLElement>('[data-diff-row]')[want.line]
    if (!target) return false
    pending.current = null
    target.scrollIntoView?.({ block: want.line < 0 ? 'start' : 'center' })
    return true
  }, [])
  useImperativeHandle(ref, () => ({
    scrollToFile: (key, line) => {
      const at = index.get(key)
      if (at === undefined) return
      virtual.scrollToIndex(at, { align: 'start' })
      onActive(key)
      if (line === undefined) return
      pending.current = { key, line }
      // The section may not be drawn yet (or its rows not read): tried again as frames go by.
      let tries = 0
      const step = () => { if (!reveal() && pending.current && ++tries < 30) requestAnimationFrame(step) }
      requestAnimationFrame(step)
    },
    focus: () => scroller.current?.focus({ preventScroll: true }),
  }), [index, virtual, onActive, reveal])

  // Find: every match drawn is marked (CSS Custom Highlight where the browser has it), the current one more strongly.
  const current = find?.current ?? null
  const marked = useRef(false)
  useLayoutEffect(() => {
    const root = scroller.current
    if (!root || (!find && !marked.current)) return
    for (const el of root.querySelectorAll('[data-find-current]')) el.removeAttribute('data-find-current')
    if (current) {
      const section = sectionOf(root, current.key)
      const target = current.line < 0 ? section?.querySelector('[data-section-header]') : section?.querySelectorAll('[data-diff-row]')[current.line]
      target?.setAttribute('data-find-current', '')
    }
    marked.current = Boolean(find?.query)
    markMatches(root, find?.query ?? '', current)
  })
  useEffect(() => () => { if (marked.current) clearMarks() }, [])

  const expand = useCallback((key: string) => store.expand(key), [store])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = active ? index.get(active) ?? 0 : 0
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const next = files[Math.max(0, Math.min(files.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { virtual.scrollToIndex(index.get(keyOf(next))!, { align: 'start' }); onActive(keyOf(next)) }
      return
    }
    // Space on the column itself (not on a button inside it) folds the file in view.
    if (e.key === ' ' && e.target === e.currentTarget && active) { e.preventDefault(); onCollapse(active) }
  }

  return (
    <div ref={scroller} tabIndex={0} role="region" aria-label={t('改动')} onKeyDown={onKey} onScroll={noteActive} data-stacked-diff
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--line-focus)] [&_[data-find-current]]:outline [&_[data-find-current]]:outline-1 [&_[data-find-current]]:-outline-offset-1 [&_[data-find-current]]:outline-[var(--accent)]">
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {items.map(item => {
          const file = files[item.index], key = keyOf(file)
          const first = Boolean(groupLabel && file.group && file.group !== files[item.index - 1]?.group)
          return (
            <div key={item.key} ref={virtual.measureElement} data-index={item.index} className="absolute left-0 w-full" style={{ top: item.start }}>
              {first && groupLabel!(file.group!)}
              <Section file={file} entry={store.entry(key)} collapsed={collapsed.has(key)} shown={shown.has(key)} wrap={wrap} numbers={numbers}
                onCollapse={onCollapse} onShow={onShow} onExpand={expand} actions={actions} />
            </div>
          )
        })}
      </div>
      {footer}
    </div>
  )
})

/** A drawn section by its file's key. */
const sectionOf = (root: HTMLElement, key: string) => [...root.querySelectorAll<HTMLElement>('[data-section-key]')].find(el => el.dataset.sectionKey === key)

const Section = memo(function Section({ file, entry, collapsed, shown, wrap, numbers, onCollapse, onShow, onExpand, actions }: {
  file: StackFile; entry: PatchEntry; collapsed: boolean; shown: boolean; wrap: boolean; numbers: 'new' | 'both'
  onCollapse: (key: string) => void; onShow: (key: string) => void; onExpand: (key: string) => void; actions: FileActions
}) {
  const t = useT()
  const key = keyOf(file)
  const { name, dir } = splitPath(file.path)
  const Icon = fileIcon(name)
  // Another worktree's files, and a path reported outside the conversation's folders, are only read here.
  const readOnly = actions.readOnly || Boolean(file.external)
  const header = (
    <div className="sticky top-0 z-[2] flex h-8 items-center gap-1.5 border-b border-line-faint bg-base pl-1.5 pr-1" data-section-header>
      <button type="button" onClick={() => onCollapse(key)} aria-expanded={!collapsed} aria-label={collapsed ? t('展开「{name}」', { name }) : t('折叠「{name}」', { name })}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronRight className={cn('size-3.5 transition-transform duration-150', !collapsed && 'rotate-90')} aria-hidden />
      </button>
      <Icon className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} aria-hidden />
      {/* Name, folder and +N −M read as one line (as Claude's diff shows them); the file's ⋯ keeps the right edge. */}
      <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <span className={cn('min-w-0 max-w-full shrink-0 truncate text-[13px] font-semibold text-fg', file.status === 'D' && 'line-through decoration-fg-4')}>{name}</span>
        {dir && <span className="min-w-0 truncate text-[12px] text-fg-4">{dir}</span>}
      </span>
      <TreeStat file={file} />
      <span className="flex-1" />
      <SectionMenu file={file} actions={actions} />
    </div>
  )
  return (
    <section data-section-path={file.path} data-section-key={key} aria-label={file.path}>
      {readOnly ? header : <FileMenu path={file.path} workspace={actions.root} projectId={actions.projectId} deleted={file.status === 'D'}>{header}</FileMenu>}
      {!collapsed && <div className="pb-1">{body()}</div>}
    </section>
  )

  function body(): ReactNode {
    const note = (text: ReactNode, extra?: ReactNode) => <div className="mx-3 my-2 rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.55] text-fg-3">{text}{extra}</div>
    if (isFolderRow(file)) return note(t('这是一个单独的 Git 仓库，这里不显示它里面的改动。'))
    if (file.binary) return note(t('二进制文件，不显示差异。'))
    if (isFolded(file) && !shown) {
      const lines = changedLines(file)
      return note(isLarge(file) ? t('改动有 {n} 行，显示出来可能会慢。', { n: lines }) : null, (
        <button type="button" onClick={() => onShow(key)} data-show-large
          className={cn('rounded px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', isLarge(file) && 'ml-2')}>
          {t('显示 {n} 行改动', { n: lines })}
        </button>
      ))
    }
    const diff = entry.diff
    if (!diff) {
      if (entry.error !== undefined && !entry.loading) return note(entry.error || t('这个文件的差异暂时读不到。'))
      return <div className="space-y-1.5 px-4 py-2.5" aria-label={t('正在读取…')} data-section-loading><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /><Skeleton className="h-3 w-2/3" /></div>
    }
    if (diff.kind === 'binary') return note(t('二进制文件，不显示差异。'))
    if (diff.kind === 'unavailable') return note(diff.message ?? t('这个文件的差异暂时读不到。'))
    const lines = linesOf(diff)
    if (!lines?.length) return note(t('没有可显示的文字改动（可能只改了文件权限）。'))
    return (
      <div aria-busy={entry.loading || undefined} className={cn(entry.loading && 'opacity-80')}>
        {diff.kind === 'truncated' && <p className="px-4 pt-1.5 text-[12px] text-fg-4">{t('改动太大，只显示前一部分。')}</p>}
        <DiffView lines={lines} wrap={wrap} lineNumbers={numbers} language={diffLanguage(file.path)} changeBar onExpand={entry.full || diff.kind !== 'patch' ? undefined : () => onExpand(key)} />
      </div>
    )
  }
})

const menuItem = 'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3'

/** A file's ⋯: open it, show it in Finder, copy its path; for uncommitted work in the project folder, stage and discard. */
function SectionMenu({ file, actions }: { file: StackFile; actions: FileActions }) {
  const t = useT()
  const { name } = splitPath(file.path)
  const path = file.path.replace(/\/$/, '')
  // A path reported outside the conversation's folders is already absolute.
  const absolute = file.external ? path : actions.root ? `${actions.root.replace(/\/+$/, '')}/${path}` : null
  const readOnly = actions.readOnly || Boolean(file.external)
  const reveal = desktopRevealPath()
  const gone = file.status === 'D'
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast(t('已复制路径')), () => toast(t('没能复制，请手动选择文本复制。'), 'danger'))
  // Discard asks its second question below the diffs, which takes the keyboard: the menu must not take it back on closing.
  const keepFocus = useRef(false)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={t('「{name}」的选项', { name })} data-section-menu
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active">
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={10} onCloseAutoFocus={e => { if (keepFocus.current) { keepFocus.current = false; e.preventDefault() } }} className="menu-content z-50 min-w-48 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none">
          <DropdownMenu.Item className={menuItem} disabled={gone || readOnly || isFolderRow(file)} onSelect={() => openDock({ kind: 'file', projectId: actions.projectId, path }, { besideType: 'worktree' })}>
            <ExternalLink aria-hidden /><span className="min-w-0 flex-1 truncate">{t('打开文件')}</span>
          </DropdownMenu.Item>
          {reveal && absolute && (
            <DropdownMenu.Item className={menuItem} disabled={gone || readOnly} onSelect={() => { void reveal(absolute).catch(error => toast(desktopErrorText(error) || t('没能在访达中显示这个文件。'), 'danger')) }}>
              <FolderSearch aria-hidden /><span className="min-w-0 flex-1 truncate">{t('在访达中显示')}</span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={menuItem} disabled={!absolute} onSelect={() => absolute && copy(absolute)}>
            <Copy aria-hidden /><span className="min-w-0 flex-1 truncate">{t('复制路径')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => copy(path)}>
            <Copy aria-hidden /><span className="min-w-0 flex-1 truncate">{t('复制相对路径')}</span>
          </DropdownMenu.Item>
          {actions.writable && (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
              <DropdownMenu.Item className={menuItem} disabled={actions.busy} onSelect={() => actions.onStage(file)} data-stage>
                <Plus aria-hidden /><span className="min-w-0 flex-1 truncate">{t('暂存')}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className={cn(menuItem, 'text-danger [&_svg]:text-danger')} disabled={actions.busy} onSelect={() => { keepFocus.current = true; actions.onDiscard(file) }} data-discard>
                <Undo2 aria-hidden /><span className="min-w-0 flex-1 truncate">{t('丢弃改动')}</span>
              </DropdownMenu.Item>
            </>
          )}
          <span className="sr-only">{name}</span>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/* ------------------------------------------------------------------ marks */

const MARK = 'rna-diff-find', MARK_CURRENT = 'rna-diff-find-current'
type HighlightRegistry = Map<string, unknown>
const highlights = (): HighlightRegistry | null => {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return registry && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? registry : null
}
function clearMarks() { const registry = highlights(); registry?.delete(MARK); registry?.delete(MARK_CURRENT) }

/** Ranges over a row's text (it may be split into syntax tokens) wherever `needle` occurs, ignoring case. */
function rangesIn(cell: Element, needle: string): { range: Range; start: number }[] {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; at: number }[] = []
  let text = ''
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) { nodes.push({ node, at: text.length }); text += node.data }
  const out: { range: Range; start: number }[] = []
  const lower = text.toLowerCase()
  const locate = (offset: number) => { let i = nodes.length - 1; while (i > 0 && nodes[i].at > offset) i--; return { node: nodes[i].node, offset: offset - nodes[i].at } }
  for (let from = lower.indexOf(needle); from >= 0 && nodes.length; from = lower.indexOf(needle, from + needle.length)) {
    const range = document.createRange(), a = locate(from), b = locate(from + needle.length - 1)
    range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset + 1)
    out.push({ range, start: from })
  }
  return out
}

/** Every drawn occurrence of the query as one highlight, the current one as another. */
function markMatches(root: HTMLElement, query: string, current: FindMatch | null) {
  const registry = highlights()
  if (!registry) return
  const needle = query.toLowerCase()
  if (!needle) { clearMarks(); return }
  const all: Range[] = [], now: Range[] = []
  const Highlight = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
  for (const section of root.querySelectorAll<HTMLElement>('[data-section-key]')) {
    const key = section.dataset.sectionKey
    section.querySelectorAll('[data-diff-row]').forEach((row, line) => {
      if (row.getAttribute('data-diff-row') === 'gap' || !row.lastElementChild) return
      for (const { range, start } of rangesIn(row.lastElementChild, needle)) {
        all.push(range)
        if (current && current.key === key && current.line === line && current.start === start) now.push(range)
      }
    })
  }
  registry.set(MARK, new Highlight(...all))
  registry.set(MARK_CURRENT, new Highlight(...now))
}

/** The highlight colours (a style element: CSS Custom Highlights are styled by name). */
export const FIND_STYLE = `::highlight(${MARK}){background-color:color-mix(in srgb,var(--state-warning) 38%,transparent);color:inherit}::highlight(${MARK_CURRENT}){background-color:color-mix(in srgb,var(--accent) 55%,transparent);color:inherit}`
