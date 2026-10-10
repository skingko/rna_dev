/**
 * Tabular data: CSV/TSV (parsed in the page) and Excel workbooks (SheetJS,
 * loaded on demand). One grid with a sticky header row, sticky row numbers
 * and virtualized rows; row/column caps keep huge sheets responsive.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { TableProperties } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseDelimited } from '../registry'
import { ModeSwitch, Notice, StateCard, Toolbar, LoadingShimmer } from '../parts'
import { CodePreview } from './CodePreview'
import { useHostedView } from '../view-context'
import { t as tr } from '@/i18n'

export const MAX_ROWS = 5000
export const MAX_COLS = 200

export function DelimitedPreview({ text, delimiter }: { text: string; delimiter: string }) {
  const hosted = useHostedView()
  const [localMode, setMode] = useState<'table' | 'source'>('table')
  const mode = hosted ? 'table' : localMode
  const parsed = useMemo(() => parseDelimited(text, delimiter, MAX_ROWS + 1), [text, delimiter])
  return (
    <>
      {!hosted && <Toolbar><ModeSwitch label={tr('表格显示方式')} value={mode} onChange={setMode} items={[{ id: 'table', label: tr('表格') }, { id: 'source', label: tr('源码') }]} /></Toolbar>}
      {mode === 'source' ? <CodePreview text={text} defaultWrap={false} /> : <DataGrid rows={parsed.rows} truncated={parsed.truncated} />}
    </>
  )
}

interface Sheet { name: string; rows: string[][]; truncated: boolean }

export function ExcelPreview({ blob }: { blob: Blob }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; sheets: Sheet[] } | { status: 'error'; message: string }>({ status: 'loading' })
  const [active, setActive] = useState(0)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' }); setActive(0)
    void (async () => {
      try {
        const [XLSX, buffer] = await Promise.all([import('xlsx'), blob.arrayBuffer()])
        // sheetRows bounds parsing work; formulas are read as their cached values.
        const book = XLSX.read(buffer, { type: 'array', sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false, cellStyles: false })
        const sheets = book.SheetNames.map(name => {
          const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false })
          return { name, rows: rows.map(r => r.map(c => (c === null || c === undefined ? '' : String(c)))), truncated: rows.length > MAX_ROWS }
        })
        if (live) setState({ status: 'ready', sheets })
      } catch (e) { if (live) setState({ status: 'error', message: (e as Error).message }) }
    })()
    return () => { live = false }
  }, [blob])
  if (state.status === 'loading') return <LoadingShimmer label={tr('正在解析表格…')} />
  if (state.status === 'error') return <StateCard tone="danger" icon={<TableProperties />} title={tr('无法解析此表格文件')} detail={state.message} />
  const sheet = state.sheets[active] ?? state.sheets[0]
  return (
    <>
      {sheet ? <DataGrid key={active} rows={sheet.rows} truncated={sheet.truncated} /> : <StateCard icon={<TableProperties />} title={tr('工作簿没有工作表')} />}
      {state.sheets.length > 0 && (
        <div role="tablist" aria-label={tr('工作表')} className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-line-faint bg-subtle/60 px-2">
          {state.sheets.map((s, i) => (
            <button key={s.name + i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}
              className={cn('h-7 shrink-0 rounded-md px-3 text-[12.5px] transition-colors', i === active ? 'bg-elevated font-medium text-fg shadow-xs' : 'text-fg-3 hover:bg-hover hover:text-fg')}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

const ROW_H = 30

/** Spreadsheet-style grid: first row is the header; row numbers stay pinned while scrolling sideways. */
export function DataGrid({ rows, truncated }: { rows: string[][]; truncated: boolean }) {
  const header = rows[0] ?? []
  const body = useMemo(() => rows.slice(1, MAX_ROWS + 1), [rows])
  const width = Math.min(MAX_COLS, rows.reduce((n, r) => Math.max(n, r.length), 0))
  const numeric = useMemo(() => Array.from({ length: width }, (_, c) => {
    const values = body.slice(0, 200).map(r => r[c]).filter(v => v !== undefined && v !== '')
    return values.length > 0 && values.every(v => /^-?[\d,.]+%?$/.test(v!.trim()))
  }), [body, width])
  // Rows are separate grids (virtualized), so column widths are fixed from a content sample.
  const widths = useMemo(() => Array.from({ length: width }, (_, c) => columnWidth([header[c], ...body.slice(0, 300).map(r => r[c])])), [header, body, width])
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({ count: body.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 })
  if (!rows.length) return <StateCard icon={<TableProperties />} title={tr('表格为空')} />
  const cols = Array.from({ length: width }, (_, c) => c)
  const template = `${gutter(body.length)}px ${widths.map(w => `${w}px`).join(' ')}`
  const items = virtual.getVirtualItems()
  return (
    <>
      {(truncated || rows.some(r => r.length > MAX_COLS)) && <Notice>{tr('仅显示前 {rows} 行、{cols} 列，完整数据请下载查看。', { rows: MAX_ROWS, cols: MAX_COLS })}</Notice>}
      <div ref={scroller} tabIndex={0} role="table" aria-rowcount={body.length + 1} aria-colcount={width} className="min-h-0 flex-1 overflow-auto text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--line-focus)]">
        <div className="min-w-max">
          <div role="row" className="sticky top-0 z-[2] grid border-b border-line bg-subtle font-medium text-fg" style={{ gridTemplateColumns: template, height: ROW_H }}>
            <span className="sticky left-0 z-[1] border-r border-line-faint bg-subtle" />
            {cols.map(c => <span key={c} role="columnheader" title={header[c]} className={cn('truncate border-r border-line-faint px-2.5 leading-[30px]', numeric[c] && 'text-right')}>{header[c] ?? ''}</span>)}
          </div>
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {items.map(v => {
              const row = body[v.index]
              return (
                <div key={v.key} role="row" className="absolute left-0 grid w-full border-b border-line-faint text-fg-2 hover:bg-hover/60" style={{ gridTemplateColumns: template, height: ROW_H, transform: `translateY(${v.start}px)` }}>
                  <span className="sticky left-0 z-[1] border-r border-line-faint bg-base pr-2 text-right leading-[30px] tabular-nums text-fg-4">{v.index + 2}</span>
                  {cols.map(c => <span key={c} role="cell" title={row[c]} className={cn('max-w-[420px] truncate border-r border-line-faint px-2.5 leading-[30px]', numeric[c] && 'text-right tabular-nums')}>{row[c] ?? ''}</span>)}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <p className="shrink-0 border-t border-line-faint px-4 py-1 text-[11.5px] text-fg-4">{tr('{rows} 行 · {cols} 列', { rows: body.length, cols: width })}</p>
    </>
  )
}

/** Approximate rendered width of a column (CJK counts double), clamped to 72-360 px. */
export function columnWidth(values: (string | undefined)[]): number {
  let longest = 0
  for (const v of values) {
    if (!v) continue
    let n = 0
    for (const ch of v.slice(0, 80)) n += /[\u2e80-\uffff]/.test(ch) ? 2 : 1
    longest = Math.max(longest, n)
  }
  return Math.max(72, Math.min(360, Math.round(longest * 8 + 30)))
}
const gutter = (rows: number) => Math.max(40, String(rows + 1).length * 8 + 20)
