/**
 * The diff body shared by the timeline's diff card, the review tabs and the changes panel (worktree design §3.5):
 * a unified diff whose added rows sit on green and removed rows on red (only the background changes), with
 * optional line numbers, soft wrap under the text column, syntax colour from lib/highlight (the text only), a bar
 * beside each run of changes, and "展开 N 行" on the gaps between hunks.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { UnfoldVertical } from 'lucide-react'
import type { DiffLine } from '@/lib/diff'
import { cachedTokens, highlight, normalizeLang, type Token } from '@/lib/highlight'
import { toggleDisclosure, useUi } from '@/store/ui-store'
import { cn } from '@/lib/utils'
import { t as tr } from '@/i18n'

export interface DiffViewProps {
  lines: DiffLine[]
  /** Long lines soft-wrap under the text column (the default); `false` keeps each on one line and scrolls sideways. */
  wrap?: boolean
  /** `new`: one column with the new line number (the old one on removed rows); `both`: old and new columns. None when left out. */
  lineNumbers?: 'new' | 'both'
  /** A Shiki language id or alias (`diffLanguage(path)` picks one by file name). It colours the text only. */
  language?: string
  /** A coloured bar on the left edge of each run of added or removed rows. */
  changeBar?: boolean
  /** With `capKey`: only the first `maxLines` rows until "… 其余 N 行" is clicked; the click is remembered under `capKey`. */
  maxLines?: number
  capKey?: string
  /** Offered on gaps that hide unchanged lines (`skipped`): "展开 N 行" calls it with the gap's index in `lines`. */
  onExpand?: (gapIndex: number) => void
}

/** Past this many characters (both sides together) a diff shows without syntax colour, as a large file preview does. */
const HIGHLIGHT_CHARS = 200_000

const ROW = { add: 'bg-[var(--diff-add-bg)]', del: 'bg-[var(--diff-del-bg)]' } as const
/** The text column sits on a slightly deeper tint than the gutter, as in Claude's diff. */
const TEXT = { add: 'bg-[color-mix(in_srgb,var(--state-success)_5%,transparent)]', del: 'bg-[color-mix(in_srgb,var(--state-danger)_5%,transparent)]' } as const
const MARK = { add: 'text-[var(--diff-add-fg)]', del: 'text-[var(--diff-del-fg)]' } as const
const BAR = { add: 'shadow-[inset_3px_0_0_var(--state-success)]', del: 'shadow-[inset_3px_0_0_var(--state-danger)]' } as const

/** The old side (context and removed rows) and the new side (context and added rows) as two texts to highlight, and where each row lands. */
interface Sides { oldText: string; newText: string; oldCount: number; newCount: number; side: Uint8Array; at: Int32Array }
const OLD = 1, NEW = 2

function sidesOf(lines: DiffLine[]): Sides {
  const oldRows: string[] = [], newRows: string[] = []
  const side = new Uint8Array(lines.length), at = new Int32Array(lines.length)
  lines.forEach((line, i) => {
    if (line.type === 'gap') return
    // A trailing carriage return (a CRLF file) would start a line of its own in the highlighter.
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
    if (line.type !== 'add') oldRows.push(text)
    if (line.type !== 'del') newRows.push(text)
    side[i] = line.type === 'del' ? OLD : NEW
    at[i] = line.type === 'del' ? oldRows.length - 1 : newRows.length - 1
  })
  return { oldText: oldRows.join('\n'), newText: newRows.join('\n'), oldCount: oldRows.length, newCount: newRows.length, side, at }
}

/** Each row's tokens, or `null` when a side is missing or its lines do not line up with the rows (then the text stays plain). */
function rowTokens(sides: Sides, oldTokens: Token[][] | null | undefined, newTokens: Token[][] | null | undefined): (Token[] | undefined)[] | null {
  if (sides.oldCount && oldTokens?.length !== sides.oldCount) return null
  if (sides.newCount && newTokens?.length !== sides.newCount) return null
  return Array.from(sides.side, (side, i) => (side === OLD ? oldTokens![sides.at[i]] : side === NEW ? newTokens![sides.at[i]] : undefined))
}

/** Syntax colour for the shown rows: each side is highlighted as one text so a row keeps the context of the rows around it. */
function useRowTokens(lines: DiffLine[], language: string | undefined) {
  const lang = normalizeLang(language)
  const sides = useMemo(() => {
    if (!lang) return null
    const sides = sidesOf(lines)
    return sides.oldText.length + sides.newText.length <= HIGHLIGHT_CHARS ? sides : null
  }, [lines, lang])
  const cached = useMemo(() => (sides && lang ? rowTokens(sides, sides.oldCount ? cachedTokens(sides.oldText, lang) : null, sides.newCount ? cachedTokens(sides.newText, lang) : null) : null), [sides, lang])
  const [loaded, setLoaded] = useState<{ sides: Sides; rows: (Token[] | undefined)[] | null } | null>(null)
  useEffect(() => {
    if (!sides || !lang || cached) return
    let live = true
    // Plain rows paint first; the colour follows when the browser is idle, so many diffs mounting together never stall a frame.
    const run = () => {
      void Promise.all([sides.oldCount ? highlight(sides.oldText, lang) : null, sides.newCount ? highlight(sides.newText, lang) : null])
        .then(([oldTokens, newTokens]) => { if (live) setLoaded({ sides, rows: rowTokens(sides, oldTokens, newTokens) }) })
        .catch(() => {})
    }
    const idle = typeof requestIdleCallback === 'function'
    const handle = idle ? requestIdleCallback(run, { timeout: 500 }) : window.setTimeout(run, 0)
    return () => { live = false; if (idle) cancelIdleCallback(handle); else window.clearTimeout(handle) }
  }, [sides, lang, cached])
  return cached ?? (loaded?.sides === sides ? loaded.rows : null)
}

const digitsOf = (n: number | undefined) => (n ? String(n).length : 0)

export const DiffView = memo(function DiffView({ lines, wrap = true, lineNumbers, language, changeBar = false, maxLines, capKey, onExpand }: DiffViewProps) {
  const expanded = useUi(s => (capKey ? s.disclosure[capKey] ?? false : true))
  const capped = maxLines !== undefined && lines.length > maxLines && !expanded
  const shown = useMemo(() => (capped ? lines.slice(0, maxLines) : lines), [lines, capped, maxLines])
  const tokens = useRowTokens(shown, language)
  // Number columns fit the longest number shown (at least three digits).
  const numberWidth = useMemo(() => {
    let digits = 3
    if (lineNumbers) for (const line of shown) digits = Math.max(digits, digitsOf(line.oldNo), digitsOf(line.newNo))
    return `calc(${digits}ch + 1rem)`
  }, [shown, lineNumbers])
  const textCell = wrap ? 'min-w-0 flex-1 whitespace-pre-wrap pr-4 [overflow-wrap:anywhere]' : 'flex-1 whitespace-pre pr-4'
  const number = (value: number | undefined, tone: string) => (
    <span className={cn('shrink-0 select-none pr-2 text-right tabular-nums', tone)} style={{ width: numberWidth }}>{value ?? ''}</span>
  )
  const numbers = (line: DiffLine) => {
    if (!lineNumbers) return null
    const tone = line.type === 'add' || line.type === 'del' ? cn(MARK[line.type], 'opacity-80') : 'text-fg-4 opacity-70'
    if (line.type === 'gap') return lineNumbers === 'both' ? <>{number(undefined, tone)}{number(undefined, tone)}</> : number(undefined, tone)
    if (lineNumbers === 'both') return <>{number(line.type === 'add' ? undefined : line.oldNo, tone)}{number(line.type === 'del' ? undefined : line.newNo, tone)}</>
    return number(line.type === 'del' ? line.oldNo : line.newNo, tone)
  }
  return (
    <div className={cn('py-1.5 font-mono text-[12.5px] leading-[1.7] [tab-size:4]', !wrap && 'overflow-x-auto')}>
      <div className={cn(!wrap && 'min-w-max')}>
        {shown.map((line, i) => {
          if (line.type === 'gap') {
            const skipped = onExpand && line.skipped ? line.skipped : 0
            return (
              <div key={i} data-diff-row="gap" className={cn('flex text-fg-4', skipped && 'bg-hover')}>
                {numbers(line)}
                {skipped ? (
                  <span className={cn(textCell, 'flex items-center gap-2 font-sans text-[12px]')}>
                    <button type="button" onClick={() => onExpand!(i)} className="-ml-1 inline-flex h-5 shrink-0 items-center gap-1.5 rounded px-1.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                      <UnfoldVertical className="size-3.5" aria-hidden />{tr('展开 {n} 行', { n: skipped })}
                    </button>
                    {line.context && <span className="min-w-0 truncate font-mono text-[12px]">{line.context}</span>}
                  </span>
                ) : (
                  <>
                    <span className="w-5 shrink-0 select-none text-center opacity-70">⋯</span>
                    <span className={cn(textCell, 'font-sans text-[12px]')}>{line.text}</span>
                  </>
                )}
              </div>
            )
          }
          const change = line.type === 'add' || line.type === 'del' ? line.type : null
          const row = tokens?.[i]
          return (
            <div key={i} data-diff-row={line.type} className={cn('flex', change && ROW[change], change && changeBar && BAR[change])}>
              {numbers(line)}
              <span className={cn('w-5 shrink-0 select-none text-center', change ? MARK[change] : 'opacity-70')}>{change === 'add' ? '+' : change === 'del' ? '−' : ''}</span>
              <span className={cn(textCell, change ? cn(TEXT[change], 'text-fg') : 'text-fg-2')}>
                {row?.length ? row.map((token, j) => <span key={j} className="shiki-token" style={token.style}>{token.content}</span>) : line.text || ' '}
              </span>
            </div>
          )
        })}
        {capped && capKey && (
          <button type="button" onClick={() => toggleDisclosure(capKey)} className="ml-5 mt-0.5 font-sans text-[12px] text-fg-4 hover:text-fg-2">{tr('… 其余 {v} 行', { v: lines.length - maxLines! })}</button>
        )}
      </div>
    </div>
  )
})
