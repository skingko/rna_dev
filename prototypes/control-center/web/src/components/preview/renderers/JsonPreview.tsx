/**
 * JSON: a collapsible tree (default) or the pretty-printed source. Invalid
 * JSON falls back to the raw source with a note.
 */
import { memo, useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ModeSwitch, Notice, Toolbar, ToolbarButton } from '../parts'
import { CodePreview } from './CodePreview'
import { useHostedView } from '../view-context'
import { t as tr } from '@/i18n'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const PAGE = 200

export function JsonPreview({ text }: { text: string }) {
  const parsed = useMemo(() => { try { return { ok: true as const, value: JSON.parse(text) as Json } } catch (e) { return { ok: false as const, error: (e as Error).message } } }, [text])
  const pretty = useMemo(() => (parsed.ok ? `${JSON.stringify(parsed.value, null, 2)}\n` : text), [parsed, text])
  const hosted = useHostedView()
  const [localMode, setMode] = useState<'tree' | 'source'>('tree')
  const mode = hosted ? 'tree' : localMode
  // Bumping `epoch` remounts the tree with every node open (depth Infinity) or closed (depth 0).
  const [expand, setExpand] = useState<{ depth: number; epoch: number }>({ depth: 2, epoch: 0 })
  if (!parsed.ok) return <><Notice>{tr('JSON 解析失败，显示原文：{message}', { message: parsed.error })}</Notice><CodePreview text={text} lang="json" /></>
  return (
    <>
      <Toolbar>
        {mode === 'tree' && (
          <>
            <ToolbarButton label={tr('全部展开')} onClick={() => setExpand(e => ({ depth: Infinity, epoch: e.epoch + 1 }))}><ChevronsUpDown /></ToolbarButton>
            <ToolbarButton label={tr('全部折叠')} onClick={() => setExpand(e => ({ depth: 0, epoch: e.epoch + 1 }))}><ChevronsDownUp /></ToolbarButton>
          </>
        )}
        {!hosted && <ModeSwitch label={tr('JSON 显示方式')} value={mode} onChange={setMode} items={[{ id: 'tree', label: tr('树形') }, { id: 'source', label: tr('格式化') }]} />}
      </Toolbar>
      {mode === 'source' ? <CodePreview text={pretty} lang="json" /> : (
        <div role="tree" aria-label={tr('JSON 树')} tabIndex={-1} onKeyDown={onTreeKey} className="min-h-0 flex-1 overflow-auto px-3 py-3 font-mono text-[12.5px] leading-[1.75]">
          <Node key={expand.epoch} name={null} value={parsed.value} depth={0} openDepth={expand.depth} />
        </div>
      )}
    </>
  )
}

/** Up/Down move between rows; Left/Right collapse/expand (buttons handle Enter/Space). */
function onTreeKey(e: KeyboardEvent<HTMLDivElement>) {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-json-row]')
  if (!row) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-json-row]')]
  const i = rows.indexOf(row)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus() }
  else if ((e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') || (e.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true')) { e.preventDefault(); row.click() }
}

const Node = memo(function Node({ name, value, depth, openDepth, last = true }: { name: string | number | null; value: Json; depth: number; openDepth: number; last?: boolean }) {
  const container = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < openDepth)
  const [limit, setLimit] = useState(PAGE)
  const label = name === null ? null : <><span className={typeof name === 'number' ? 'text-fg-4' : 'text-accent-text'}>{typeof name === 'number' ? name : JSON.stringify(name)}</span><span className="text-fg-4">: </span></>
  const comma = last ? null : <span className="text-fg-4">,</span>
  if (!container) {
    return <div role="treeitem" tabIndex={0} data-json-row className="rounded pl-[18px] outline-none focus-visible:bg-hover" style={{ marginLeft: depth ? 14 : 0 }}>{label}<Scalar value={value} />{comma}</div>
  }
  const array = Array.isArray(value)
  const entries: [string | number, Json][] = array ? value.map((v, i) => [i, v]) : Object.entries(value)
  const [lb, rb] = array ? ['[', ']'] : ['{', '}']
  return (
    <div style={{ marginLeft: depth ? 14 : 0 }}>
      <button type="button" role="treeitem" aria-expanded={open} data-json-row onClick={() => setOpen(o => !o)}
        className="flex w-full items-center rounded text-left outline-none hover:bg-hover focus-visible:bg-hover">
        <ChevronRight className={cn('mr-0.5 size-3.5 shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 truncate">
          {label}<span className="text-fg-3">{lb}</span>
          {!open && <><span className="mx-1 rounded bg-subtle px-1 text-[11px] text-fg-3">{array ? tr('{count} 项', { count: entries.length }) : tr('{count} 个键', { count: entries.length })}</span><span className="text-fg-3">{rb}</span>{comma}</>}
        </span>
      </button>
      {open && (
        <div role="group" className="border-l border-line-faint" style={{ marginLeft: 6 }}>
          {entries.slice(0, limit).map(([k, v], i) => <Node key={k} name={array ? i : k} value={v} depth={depth + 1} openDepth={openDepth} last={i === entries.length - 1} />)}
          {entries.length > limit && (
            <button type="button" onClick={() => setLimit(l => l + PAGE)} className="ml-[32px] rounded px-1 text-[12px] text-accent-text hover:underline">{tr('显示更多（剩余 {count} 项）', { count: entries.length - limit })}</button>
          )}
        </div>
      )}
      {open && <div className="pl-[18px]"><span className="text-fg-3">{rb}</span>{comma}</div>}
    </div>
  )
})

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="text-fg-4">null</span>
  if (typeof value === 'boolean') return <span className="text-[var(--ansi-magenta,#8250df)]">{String(value)}</span>
  if (typeof value === 'number') return <span className="text-[var(--ansi-blue,#0550ae)]">{value}</span>
  return <span className="break-all text-[var(--diff-add-fg)]">{JSON.stringify(value)}</span>
}
