/** Messages waiting for an app update to finish (§2.5 item 10): shown above the composer, each can be taken back. */
import { useMemo } from 'react'
import { Clock3, X } from 'lucide-react'
import { dropOutbox, useOutbox } from '@/store/outbox'
import { useApp } from '@/store/app-store'
import { t } from '@/i18n'

export function OutboxStrip({ sessionId, projectId }: { sessionId: string | null; projectId: string | null }) {
  // Select the stable array and filter outside the selector: a selector returning a new array loops forever (zustand 5).
  const all = useOutbox(s => s.entries)
  const entries = useMemo(() => all.filter(row => (sessionId ? row.sessionId === sessionId : !row.sessionId && row.projectId === projectId)), [all, sessionId, projectId])
  const held = useApp(s => s.maintenanceHeld)
  if (!entries.length) return null
  return (
    <div className="mx-2 mb-2 space-y-1" role="status" aria-live="polite">
      {entries.map(entry => (
        <div key={entry.id} className="flex items-center gap-2 rounded-xl bg-subtle px-3.5 py-1.5 text-[13px] leading-6 text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">
          <Clock3 className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.8} />
          <span className="shrink-0 text-fg-3">{held ? t('升级完成后自动发送') : t('正在发送')}</span>
          <span className="min-w-0 flex-1 truncate">{entry.text}</span>
          <button type="button" aria-label={t('不发了')} onClick={() => dropOutbox(entry.id)} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  )
}
