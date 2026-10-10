/**
 * The second click of a two-step write into the project folder (0.63: rollback, undo of a rollback, dropping a
 * worker's merge, applying or discarding a kept worktree). The first request changed nothing and answered what would
 * happen with a one-time `confirm`; this shows that answer — the files and what happens to each, the ones left
 * alone because they changed since (each can still be forced), the host's note — and sends `confirm` back only on
 * the user's second click. The token expires (2 minutes); an expired or refused one closes the card with the
 * host's sentence, never retried behind the user's back.
 *
 * The host binds a token to the `paths` it was asked with: the second request sends exactly the paths the shown
 * plan was asked with (none when the whole plan was asked for), and only the latest answer is shown. A narrowed
 * plan still names the files left alone (`skipped`), so they stay listed and can still be forced.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import type { ConflictPath } from '@/api/types'
import { toast } from '@/store/ui-store'
import { Button } from '@/components/ui/primitives'
import { conflictKindText, fileActionText, LIST_CAP, skippedReasonText } from '@/lib/isolation'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export interface TwoStepPlan {
  confirm: string
  expiresAt: string
  files: { path: string; action: string }[]
  skipped?: { path: string; reason: string }[]
  conflicts?: ConflictPath[]
  /** The host's own sentence (interface language), e.g. other writes at the same time cannot be told apart. */
  note?: string
}
export interface TwoStepInput { paths?: string[]; force?: string[] }

export interface TwoStepConfirmProps<P extends TwoStepPlan> {
  /** The first request (`paths`: the files the user kept ticked, when `selectable`). */
  preview: (input: TwoStepInput) => Promise<P>
  /** The second request, with the first one's token. */
  confirm: (plan: P, input: TwoStepInput) => Promise<unknown>
  /** What the card is about ("回退本轮" …), shown above the list. */
  title: string
  confirmLabel: string
  /** Said when the plan lists no file (an unmerged worker's drop: its worktree is removed, nothing is written). */
  emptyText?: string
  /** The user may untick files (a direct-mode turn: other writes at the same time cannot be told apart). */
  selectable?: boolean
  /** Skipped files can be restored anyway (`force`); false where the host takes no `force` (dropping a worker). */
  forceable?: boolean
  danger?: boolean
  onDone?: (result: unknown) => void
  /** Renders the first button; `start` sends the first request. */
  trigger: (start: () => void, busy: boolean) => ReactNode
  className?: string
}

export function TwoStepConfirm<P extends TwoStepPlan>({ preview, confirm, title, confirmLabel, emptyText, selectable, forceable = true, danger, onDone, trigger, className }: TwoStepConfirmProps<P>) {
  const t = useT()
  const [plan, setPlan] = useState<P | null>(null)
  /** The `paths` the shown plan was asked with: its token is bound to them (undefined: the whole plan). */
  const [asked, setAsked] = useState<string[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState<string[]>([])
  const [unticked, setUnticked] = useState<string[]>([])
  /** The first plan's files and skipped files: the list the user narrows. */
  const [listed, setListed] = useState<{ files: string[]; skipped: string[] }>({ files: [], skipped: [] })
  const live = useRef(true)
  const asking = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  // The token is good for a short while only: the card closes when it runs out.
  useEffect(() => {
    if (!plan) return
    const timer = setTimeout(() => { setPlan(null); toast(t('确认已过期，请重新点一次。')) }, Math.max(0, Date.parse(plan.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [plan, t])

  /** One preview; an answer that a later request overtook is dropped (its token names other paths). */
  const ask = async (input: TwoStepInput, first: boolean) => {
    const seq = ++asking.current
    setBusy(true)
    try {
      const next = await preview(input)
      if (!live.current || seq !== asking.current) return
      setPlan(next); setAsked(input.paths)
      const skipped = (next.skipped ?? []).map(row => row.path)
      setForce(list => (first ? [] : list.filter(path => skipped.includes(path))))
      if (first) setListed({ files: next.files.map(file => file.path), skipped })
    } catch (error) { if (live.current && seq === asking.current) { setPlan(null); toast((error as Error).message, 'danger') } }
    finally { if (live.current && seq === asking.current) setBusy(false) }
  }
  const start = () => { setUnticked([]); void ask({}, true) }
  const toggle = (path: string) => {
    const next = unticked.includes(path) ? unticked.filter(p => p !== path) : [...unticked, path]
    setUnticked(next)
    // Nothing ticked: nothing to ask (the confirm button waits). All ticked again: the whole plan.
    if (next.length >= listed.files.length) return
    // A narrower set is asked again (the token binds the paths it names); the skipped files stay in it.
    void ask(next.length ? { paths: [...listed.files.filter(p => !next.includes(p)), ...listed.skipped] } : {}, false)
  }
  const go = async () => {
    if (!plan) return
    const input: TwoStepInput = { ...(asked ? { paths: asked } : {}), ...(force.length ? { force } : {}) }
    const seq = ++asking.current
    setBusy(true)
    try {
      const result = await confirm(plan, input)
      if (!live.current) return
      setPlan(null)
      onDone?.(result)
    } catch (error) { if (live.current) { setPlan(null); toast((error as Error).message, 'danger') } }
    finally { if (live.current && seq === asking.current) setBusy(false) }
  }

  const files = plan?.files ?? []
  const shown = selectable ? listed.files.map(path => files.find(file => file.path === path) ?? { path, action: '' }) : files
  const skipped = plan?.skipped ?? []
  const conflicts = plan?.conflicts ?? []
  const nothing = plan && !files.length && !skipped.length && !conflicts.length
  return (
    <>
      {trigger(start, busy)}
      {plan && (
        <div role="group" aria-label={title} className={cn('mt-2 rounded-xl bg-inset px-3.5 py-3 text-[12.5px] leading-[1.6] shadow-[inset_0_0_0_1px_var(--line-faint)]', className)} data-two-step>
          <p className="font-medium text-fg-2">{title}</p>
          {nothing && <p className="mt-1 text-fg-3">{emptyText ?? t('没有要改动的文件。')}</p>}
          {shown.length > 0 && (
            <ul className="mt-1.5 space-y-0.5" data-two-step-files>
              {shown.slice(0, selectable ? undefined : LIST_CAP).map(file => (
                <li key={file.path} className="flex min-w-0 items-center gap-2">
                  {selectable && (
                    <input type="checkbox" checked={!unticked.includes(file.path)} disabled={busy} onChange={() => toggle(file.path)}
                      aria-label={t('还原 {path}', { path: file.path })} className="size-3.5 shrink-0 accent-[var(--accent)]" />
                  )}
                  <span className={cn('min-w-0 flex-1 truncate font-mono text-[12px]', unticked.includes(file.path) ? 'text-fg-4 line-through' : 'text-fg-2')} title={file.path}>{file.path}</span>
                  {file.action && <span className="shrink-0 text-fg-4">{fileActionText(file.action)}</span>}
                </li>
              ))}
              {!selectable && shown.length > LIST_CAP && <li className="text-fg-4">{t('还有 {n} 个文件', { n: shown.length - LIST_CAP })}</li>}
            </ul>
          )}
          {conflicts.length > 0 && (
            <div className="mt-2" data-two-step-conflicts>
              <p className="text-warning-text">{t('{n} 个文件有冲突，不会写入：', { n: conflicts.length })}</p>
              <ul className="mt-0.5 space-y-0.5">
                {conflicts.slice(0, LIST_CAP).map(row => <li key={row.path} className="flex min-w-0 gap-2"><span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-3">{row.path}</span><span className="shrink-0 text-fg-4">{conflictKindText(row.kind)}</span></li>)}
              </ul>
            </div>
          )}
          {skipped.length > 0 && (
            <div className="mt-2" data-two-step-skipped>
              <p className="text-fg-3">{forceable ? t('这些文件之后又改过，默认不动它们；勾选的仍然还原：') : t('这些文件之后又改过，不会动它们：')}</p>
              <ul className="mt-0.5 space-y-0.5">
                {skipped.map(row => (
                  <li key={row.path} className="flex min-w-0 items-center gap-2">
                    {forceable && (
                      <input type="checkbox" checked={force.includes(row.path)} disabled={busy} onChange={() => setForce(list => (list.includes(row.path) ? list.filter(p => p !== row.path) : [...list, row.path]))}
                        aria-label={t('仍然还原 {path}', { path: row.path })} className="size-3.5 shrink-0 accent-[var(--accent)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={row.path}>{row.path}</span>
                    <span className="shrink-0 text-fg-4">{skippedReasonText(row.reason)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.note && <p className="mt-2 text-fg-4">{plan.note}</p>}
          <div className="mt-2.5 flex items-center gap-1.5">
            <Button size="sm" variant={danger ? 'danger' : 'primary'} disabled={busy || (selectable && unticked.length >= listed.files.length && listed.files.length > 0)} leading={<Check className="size-3.5" />} onClick={() => void go()} data-two-step-confirm>{confirmLabel}</Button>
            <Button size="sm" variant="ghost" disabled={busy} leading={<X className="size-3.5" />} onClick={() => { asking.current++; setPlan(null) }}>{t('取消')}</Button>
          </div>
        </div>
      )}
    </>
  )
}
