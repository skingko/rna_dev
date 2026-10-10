/**
 * 👍/👎 on an assistant message (turn footer, proactive messages). Quiet
 * icon buttons with `aria-pressed`; 👎 opens an optional “哪里不对？” note.
 * Votes apply immediately (optimistic) and feed lessons and thread pacing.
 */
import { useRef, useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { Popover as RPopover } from 'radix-ui'
import { sendFeedback, useFeedback, useVote } from '@/store/feedback-store'
import { Button, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export function FeedbackButtons({ sessionId, itemId, className }: { sessionId: string; itemId: string; className?: string }) {
  const t = useT()
  const unsupported = useFeedback(s => s.unsupported)
  const { vote, comment } = useVote(sessionId, itemId)
  const [asking, setAsking] = useState(false)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  if (unsupported) return null

  const up = () => void sendFeedback(sessionId, itemId, vote === 'up' ? null : 'up')
  const down = () => {
    if (vote === 'down') { void sendFeedback(sessionId, itemId, null); return }
    void sendFeedback(sessionId, itemId, 'down')
    setDraft(comment ?? '')
    setAsking(true)
  }
  const submit = () => {
    const text = draft.trim()
    setAsking(false)
    if (text) void sendFeedback(sessionId, itemId, 'down', text)
  }
  const base = 'grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] [&_svg]:size-3.5'
  return (
    <span className={cn('inline-flex items-center', className)} role="group" aria-label={t('评价这条回复')}>
      <Tooltip content={vote === 'up' ? t('取消有帮助') : t('有帮助')}>
        <button type="button" aria-pressed={vote === 'up'} aria-label={t('有帮助')} onClick={up} className={cn(base, vote === 'up' ? 'text-accent-text' : 'text-fg-4 hover:text-fg-2')}>
          <ThumbsUp fill={vote === 'up' ? 'currentColor' : 'none'} fillOpacity={0.18} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <RPopover.Root open={asking} onOpenChange={open => { if (!open) setAsking(false) }}>
        <Tooltip content={vote === 'down' ? t('取消没帮助') : t('没帮助')}>
          <RPopover.Anchor asChild>
            <button type="button" aria-pressed={vote === 'down'} aria-label={t('没帮助')} onClick={down} className={cn(base, vote === 'down' ? 'text-fg' : 'text-fg-4 hover:text-fg-2')}>
              <ThumbsDown fill={vote === 'down' ? 'currentColor' : 'none'} fillOpacity={0.18} strokeWidth={1.8} />
            </button>
          </RPopover.Anchor>
        </Tooltip>
        <RPopover.Portal>
          <RPopover.Content side="top" align="start" sideOffset={6} collisionPadding={10} aria-label={t('哪里不对？')}
            onOpenAutoFocus={e => { e.preventDefault(); field.current?.focus() }}
            className="menu-content z-50 w-[min(320px,calc(100vw-24px))] rounded-xl bg-elevated p-3 text-[13px] shadow-lg outline-none">
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{t('哪里不对？')}<span className="ml-1 font-normal text-fg-4">{t('（可选）')}</span></span>
              <textarea ref={field} value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={600}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }}
                placeholder={t('例如：太啰嗦、没按我说的做、结论不对…')}
                className="w-full resize-none rounded-lg bg-subtle px-2.5 py-2 text-[13px] leading-[1.6] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
            </label>
            <p className="mt-1 text-[11.5px] leading-[1.6] text-fg-4">{t('Rna 会据此记下经验；已记为“没帮助”。')}</p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>{t('跳过')}</Button>
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={submit}>{t('发送')}</Button>
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
    </span>
  )
}
