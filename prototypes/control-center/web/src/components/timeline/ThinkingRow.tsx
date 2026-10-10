/**
 * Reasoning disclosure (after Harness ReasoningRow). Collapsed it is one line:
 * "思考中" with a shimmer plus the first line of the latest *completed*
 * paragraph, so the preview advances in calm steps instead of jittering with
 * every token. Expanded it renders the full Markdown. Hidden-visibility
 * models show timer + token count only.
 */
import { memo, useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Brain } from 'lucide-react'
import type { Item } from '@/api/types'
import { useItem } from '@/store/app-store'
import { toggleDisclosure, useUi } from '@/store/ui-store'
import { elapsed, formatDuration, formatTokens } from '@/lib/format'
import { useNow } from '@/hooks/useNow'
import { DisclosureRow } from '@/components/ui/primitives'
import { Markdown } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const next = separator.exec(text)
    const paragraphEnd = next === null ? text.length : next.index + next[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      let candidate = text.slice(paragraphStart, newline).trim()
      // A bold section title alone says little; join it with its first completed line.
      if (/^\*\*[^*]+\*\*$/.test(candidate)) {
        const next = text.indexOf('\n', newline + 1)
        const body = next !== -1 && next <= paragraphEnd ? text.slice(newline + 1, next).trim() : ''
        if (body) candidate = `${candidate} · ${body}`
      }
      if (candidate !== '') summary = candidate
    }
    if (next === null) return summary
    paragraphStart = next.index + next[0].length
  }
}

const firstLine = (text: string) => text.split('\n').find(l => l.trim())?.trim() ?? ''

export const ThinkingRow = memo(function ThinkingRow({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  if (!item?.thinking) return null
  return <ThinkingInner item={item} />
})

function ThinkingInner({ item }: { item: Item }) {
  const thinking = item.thinking!
  const running = !thinking.endedAt && Boolean(item.streaming)
  const hidden = thinking.visibility === 'hidden' || (!thinking.text && !running)
  const key = `think:${item.id}`
  const open = useUi(s => s.disclosure[key] ?? false)
  const now = useNow(running)
  const ms = elapsed(thinking.startedAt ?? item.startedAt, thinking.endedAt, now)
  const duration = ms !== null ? formatDuration(Math.max(ms, 1000)) : null
  const tokens = thinking.tokens ? `${formatTokens(thinking.tokens)} tokens` : null

  const preview = useMemo(() => {
    if (hidden || open) return ''
    const line = running ? latestCompletedParagraphFirstLine(thinking.text) : ''
    return (line || (running ? '' : firstLine(thinking.text))).replaceAll('**', '')
  }, [hidden, open, running, thinking.text])

  const title = running
    ? <span className="text-shimmer">{t('思考中{v}', { v: hidden && duration ? ` · ${duration}` : '' })}</span>
    : <span>{t('已思考 {v}', { v: duration ?? '' })}</span>

  return (
    <div className="flex flex-col">
      <DisclosureRow
        icon={<Brain />}
        title={title}
        summary={preview && running ? <span className="block truncate [mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]">{preview}</span> : undefined}
        summaryClassName="text-fg-4"
        meta={hidden ? tokens : undefined}
        expandable={!hidden}
        open={open}
        onToggle={() => toggleDisclosure(key)}
        sweep={running && !open}
        titleClassName={cn(!running && 'text-fg-3')}
      />
      <AnimatePresence initial={false}>
        {open && !hidden && (
          <motion.div
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className="mb-1 ml-2 border-l border-line pl-4 pt-0.5"
          >
            <Markdown text={thinking.text} streaming={running} variant="compact" />
            {tokens && !running && <div className="mt-1 text-[12px] text-fg-4">{tokens}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
