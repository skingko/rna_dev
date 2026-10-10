/**
 * Virtualized conversation timeline. Rows are turns (or standalone items);
 * TanStack Virtual measures each row with ResizeObserver and keeps the
 * reading position stable when rows above the viewport change height.
 *
 * B9: a conversation opens on its tail window. Reading up to the top pages
 * older history in (sync.ts loadOlder) and keeps the rows in view where they
 * were; deep links page back to their item (useFocusScroll → loadThrough).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDown } from 'lucide-react'
import { useApp, useRows } from '@/store/app-store'
import { loadOlder, useOlderHistory } from '@/store/sync'
import type { Row } from '@/store/session-model'
import { ItemRow, PendingRow, TurnRow } from './TurnRow'
import { useScrollFollow } from './useScrollFollow'
import { useFocusScroll } from './useFocusScroll'
import { SelectionAsk } from './SelectionAsk'
import { t } from '@/i18n'

/** Keys already shown once per session: only genuinely new rows animate in. */
const seen = new Map<string, Set<string>>()
/** How close to the top (px) reading has to come before the next page of older history is read. */
const OLDER_MARGIN = 800

function estimate(row: Row | undefined): number {
  if (!row) return 200
  if (row.type === 'turn') return 180 + Math.min(row.steps.length, 8) * 28 + (row.answerId ? 220 : 0)
  if (row.type === 'pending') return 120
  return 160
}

/**
 * @param compact - the side panel's 辅助对话 variant: tighter spacing, no
 *   selection popover (asking about a side answer happens in the same tab).
 */

export function Timeline({ sessionId, followSignal, compact = false }: { sessionId: string; followSignal: number; compact?: boolean }) {
  const rows = useRows(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Older history (B9): the line above the first row that reads the page before it.
  const hasMore = useApp(s => Boolean(s.sessions[sessionId]?.window?.hasMore))

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: i => estimate(rows[i]),
    getItemKey: i => rows[i]?.key ?? i,
    overscan: 4,
    paddingStart: (compact ? 16 : 32) + (hasMore ? 28 : 0),
    paddingEnd: 16,
    gap: compact ? 24 : 32,
  })

  // Opening or switching to a conversation always lands on the latest message (the reader asked for this over
  // restoring where they left off); deep links below are the only jump elsewhere.
  const { away, jumpToLatest, following } = useScrollFollow(scrollRef, contentRef, sessionId)
  // Deep links (inbox, digest): scroll to + highlight an item. See timeline-focus.ts.
  useFocusScroll({ sessionId, rows, virtualizer, scrollRef, following })

  // Older history (B9): near the top, read the page before the first item held.
  const loadingOlder = useOlderHistory(s => Boolean(s.loading[sessionId]))
  const readOlder = useCallback(() => { void loadOlder(sessionId) }, [sessionId])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !hasMore) return
    const onScroll = () => { if (el.scrollTop < OLDER_MARGIN && !following.current) readOlder() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore, readOlder, following])

  // Remember what existed at load so history does not animate in.
  const seenSet = seen.get(sessionId) ?? (() => { const s = new Set<string>(); seen.set(sessionId, s); return s })()
  // Rows put in front (older history) keep the reading position, the row that was first moving down by what came
  // above it, and do not animate in.
  const firstKey = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current, previous = firstKey.current
    firstKey.current = rows[0]?.key ?? null
    if (!el || !previous || rows[0]?.key === previous) return
    const index = rows.findIndex(row => row.key === previous)
    if (index <= 0) return
    for (const row of rows.slice(0, index)) seenSet.add(row.key)
    const moved = (virtualizer.measurementsCache[index]?.start ?? 0) - (virtualizer.measurementsCache[0]?.start ?? 0)
    if (moved > 0 && !following.current) el.scrollTop += moved
  }, [rows, virtualizer, following, seenSet])
  const firstPaint = useRef(true)
  useEffect(() => {
    if (firstPaint.current && rows.length) { rows.forEach(r => seenSet.add(r.key)); firstPaint.current = false }
  }, [rows, seenSet])
  useEffect(() => { firstPaint.current = true }, [sessionId])

  // Sending a message re-engages follow.
  useEffect(() => { if (followSignal) jumpToLatest('smooth') }, [followSignal, jumpToLatest])

  const items = virtualizer.getVirtualItems()
  const lastTurnIndex = rows.findLastIndex(r => r.type === 'turn')

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={0}
        aria-label={t('会话内容')}
        className="timeline-mask min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none [overflow-anchor:none]"
      >
        <div ref={contentRef} className="relative mx-auto w-full max-w-[calc(var(--content-width)+48px)]" style={{ height: virtualizer.getTotalSize() }}>
          {hasMore && (
            <div className="absolute inset-x-0 top-0 flex h-7 items-center justify-center text-[12px] text-fg-3">
              {loadingOlder
                ? <span role="status">{t('正在加载更早的消息…')}</span>
                : <button type="button" onClick={readOlder} className="rounded-full px-2.5 py-0.5 transition-colors hover:bg-hover hover:text-fg">{t('加载更早的消息')}</button>}
            </div>
          )}
          {items.map(v => {
            const row = rows[v.index]
            if (!row) return null
            const isNew = !firstPaint.current && !seenSet.has(row.key)
            if (isNew) seenSet.add(row.key)
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className={compact ? 'timeline-compact absolute inset-x-0 top-0 px-4' : 'absolute inset-x-0 top-0 px-5 sm:px-6'}
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <RowView sessionId={sessionId} row={row} animate={isNew} isLast={v.index === lastTurnIndex} />
              </div>
            )
          })}
        </div>
      </div>

      {!compact && <SelectionAsk sessionId={sessionId} scrollRef={scrollRef} />}
      {/* The pill lives in a reserved strip below the scrollport, so it can never cover content. */}
      <div className="pointer-events-none flex h-10 shrink-0 items-center justify-center">
        <AnimatePresence>
          {away && (
            <motion.button
              type="button"
              onClick={() => jumpToLatest('smooth')}
              initial={{ opacity: 0, y: 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97, transition: { duration: 0.14 } }}
              transition={{ type: 'spring', stiffness: 520, damping: 36 }}
              className="pointer-events-auto inline-flex h-7 items-center justify-center gap-1.5 rounded-full bg-elevated px-3 text-[12.5px] font-medium text-fg-2 shadow-md transition-colors hover:text-fg"
            >
              <ArrowDown className="size-3.5" />
              {t('回到最新')}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

const RowView = memo(function RowView({ sessionId, row, animate, isLast }: { sessionId: string; row: Row; animate: boolean; isLast: boolean }) {
  const content = row.type === 'turn'
    ? <TurnRow sessionId={sessionId} row={row} isLast={isLast} />
    : row.type === 'pending'
      ? <PendingRow sessionId={sessionId} itemId={row.userItemId} />
      : <ItemRow sessionId={sessionId} itemId={row.itemId} />
  if (!animate) return content
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
      {content}
    </motion.div>
  )
})
