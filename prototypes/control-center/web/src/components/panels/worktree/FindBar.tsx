/**
 * Find in the changes (worktree design §3.6): a bar at the top of the diffs
 * with the query, "3/17", previous / next and close. Enter goes to the next
 * match, ⇧Enter to the previous one, Esc closes (the key stops here, so the
 * workspace keeps the panel open). It says when only part of the changes
 * could be searched.
 */
import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useT } from '@/i18n'

export interface FindBarProps {
  query: string
  onQuery: (query: string) => void
  /** 0-based index of the current match, or -1. */
  index: number
  total: number
  onStep: (delta: 1 | -1) => void
  onClose: () => void
  /** Files searched when not all of them could be (their patches past the find budget); null when all were. */
  partial: number | null
  /** Patches are still being read for the search. */
  searching: boolean
  /** Bumped to put the keyboard back in the field (⌘F again). */
  focusKey: number
}

export function FindBar({ query, onQuery, index, total, onStep, onClose, partial, searching, focusKey }: FindBarProps) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusKey])
  const button = 'grid size-6 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40'
  return (
    <div role="search" className="shrink-0 border-b border-line-faint bg-base px-2 py-1.5" data-find-bar>
      <div className="flex items-center gap-1">
        <input ref={input} value={query} onChange={e => onQuery(e.target.value)} placeholder={t('在改动中查找')} aria-label={t('在改动中查找')} data-find-input
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-subtle px-2 text-[12.5px] text-fg outline-none placeholder:text-fg-4 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" />
        <span className="min-w-[3.5em] shrink-0 text-center text-[12px] tabular-nums text-fg-4" aria-live="polite" data-find-count>
          {query ? (total ? `${index + 1}/${total}` : searching ? '…' : t('没有结果')) : ''}
        </span>
        <button type="button" className={button} disabled={!total} onClick={() => onStep(-1)} aria-label={t('上一个')} title={t('上一个')}><ChevronUp className="size-3.5" /></button>
        <button type="button" className={button} disabled={!total} onClick={() => onStep(1)} aria-label={t('下一个')} title={t('下一个')}><ChevronDown className="size-3.5" /></button>
        <button type="button" className={button} onClick={onClose} aria-label={t('关闭查找')} title={t('关闭查找')}><X className="size-3.5" /></button>
      </div>
      {query && partial !== null && !searching && <p className="px-1 pt-1 text-[11.5px] text-fg-4" data-find-partial>{t('只搜索了已加载的 {n} 个文件', { n: partial })}</p>}
    </div>
  )
}
