/**
 * Source view: Shiki tokens (dual light/dark theme via CSS variables), line
 * numbers, soft-wrap toggle and copy. Long files are virtualized so opening a
 * 10k-line log stays instant; very large inputs skip highlighting.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { WrapText } from 'lucide-react'
import { highlight, normalizeLang, type Token } from '@/lib/highlight'
import { CopyButton } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { Toolbar, ToolbarButton } from '../parts'
import { t as tr } from '@/i18n'

/** Above this many characters the source renders unhighlighted. */
export const HIGHLIGHT_LIMIT = 300_000
/** Above this many lines rows are virtualized. */
const VIRTUAL_LINES = 1500

const wrapKey = 'rna.preview.wrap'
const storedWrap = () => { try { return localStorage.getItem(wrapKey) } catch { return null } }

export function CodePreview({ text, lang, defaultWrap = false, controls = true }: { text: string; lang?: string; defaultWrap?: boolean; controls?: boolean }) {
  const [wrap, setWrap] = useState(() => { const v = storedWrap(); return v === null ? defaultWrap : v === '1' })
  const [tokens, setTokens] = useState<Token[][] | null>(null)
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const normalized = normalizeLang(lang)
  useEffect(() => {
    setTokens(null)
    if (!normalized || text.length > HIGHLIGHT_LIMIT) return
    let live = true
    void highlight(text.replace(/\n$/, ''), normalized).then(result => { if (live) setTokens(result) }).catch(() => {})
    return () => { live = false }
  }, [text, normalized])
  const toggleWrap = () => setWrap(w => { try { localStorage.setItem(wrapKey, w ? '0' : '1') } catch { /* private mode */ } return !w })

  const scroller = useRef<HTMLDivElement>(null)
  const virtual = lines.length > VIRTUAL_LINES
  const rows = useVirtualizer({ count: virtual ? lines.length : 0, getScrollElement: () => scroller.current, estimateSize: () => 22, overscan: 30 })

  const line = (i: number) => (
    <>
      <span className="ln">{i + 1}</span>
      <span className="lc">{tokens?.[i] ? tokens[i].map((tk, j) => <span key={j} className="shiki-token" style={tk.style}>{tk.content}</span>) : lines[i] || ' '}</span>
    </>
  )

  return (
    <>
      {controls && (
        <Toolbar>
          <ToolbarButton label={wrap ? tr('关闭自动换行') : tr('自动换行')} active={wrap} onClick={toggleWrap}><WrapText /></ToolbarButton>
          <CopyButton text={text} className="h-7" />
        </Toolbar>
      )}
      {text.length > HIGHLIGHT_LIMIT && normalized && <p className="shrink-0 border-b border-line-faint px-4 py-1.5 text-[12px] text-fg-3">{tr('文件较大，已关闭语法高亮。')}</p>}
      <div ref={scroller} tabIndex={0} role="region" aria-label={tr('文件源码')} className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--line-focus)]">
        <pre className={cn('code-lines py-3', wrap ? 'wrap' : 'min-w-max')}>
          <code className="block">
            {virtual ? (
              <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
                {rows.getVirtualItems().map(v => (
                  <span key={v.key} data-index={v.index} ref={rows.measureElement} className="absolute left-0 flex w-full" style={{ transform: `translateY(${v.start}px)` }}>{line(v.index)}</span>
                ))}
              </div>
            ) : lines.map((_, i) => <span key={i} className="flex">{line(i)}</span>)}
          </code>
        </pre>
      </div>
    </>
  )
}
