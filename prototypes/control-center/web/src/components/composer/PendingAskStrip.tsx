/**
 * A card waiting for the user — a question or a permission request — docked
 * above the composer when it is not at the bottom of the conversation, so one
 * asked earlier (often by background work) is never lost up the history.
 * Claude Code keeps pending approvals at the input for the same reason.
 * "去答复" scrolls to the card and highlights it; answering happens there.
 */
import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useRows } from '@/store/app-store'
import { knownItem, waitingCardIds } from '@/store/session-model'
import { focusTimelineItem, rowIndexForItem } from '@/components/timeline/timeline-focus'
import { t } from '@/i18n'

export function PendingAskStrip({ sessionId }: { sessionId: string | null }) {
  // The whole conversation's waiting cards (B9: also those older than the window held, which the host pins), oldest first.
  const ids = useApp(useShallow(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    return slice ? waitingCardIds(slice) : [] as string[]
  }))
  const first = useApp(s => (sessionId && ids[0] ? knownItem(s.sessions[sessionId], ids[0]) : undefined))
  const rows = useRows(sessionId)
  if (!sessionId || !first?.interaction) return null
  // Already at the bottom of the conversation, in view: nothing to point at.
  const index = rowIndexForItem(rows, first.id, first.turnId)
  if (index >= 0 && index >= rows.length - 2) return null
  const ix = first.interaction, permission = ix.kind === 'permission'
  const what = String(permission ? ix.permission?.reason ?? ix.questions?.[0]?.question ?? '' : ix.questions?.[0]?.question ?? '').replace(/\s+/g, ' ').trim()
  const Icon = permission ? ShieldQuestion : MessageCircleQuestion
  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-xl bg-accent-soft/60 px-3.5 py-1.5 text-[13px] leading-6 text-fg-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_25%,transparent)]" role="status" aria-live="polite">
      <Icon className="size-3.5 shrink-0 text-accent-text" strokeWidth={1.8} />
      <span className="shrink-0 font-medium text-accent-text">{permission ? t('权限申请等你答复') : t('有问题等你答复')}{ids.length > 1 ? ` · ${ids.length}` : ''}</span>
      <span className="min-w-0 flex-1 truncate text-fg-3" title={what}>{what}</span>
      <button type="button" onClick={() => focusTimelineItem(sessionId, first.id)} className="shrink-0 rounded-md px-2 text-[12.5px] font-medium text-accent-text outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('去答复')}</button>
    </div>
  )
}
