/**
 * 清理…: settle what is left open in one go — failed background work that still waits on the user (不用了: no more
 * reminders, the record stays) and the plan's open lines (marked 不再做). Lists them with checkboxes, all checked, says
 * what happens to each kind, then runs them one by one with progress and reports what did not go through plainly.
 * Used by the 任务 page (per project and for all projects) and the 后台任务 panel's 需要你 (全部不用了).
 */
import { useEffect, useRef, useState } from 'react'
import { cleanupRows, type TaskEntry } from '@/lib/tasks'
import { clearTasks, type CleanupResult } from '@/store/tasks-store'
import { toast } from '@/store/ui-store'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

type Phase = { kind: 'pick' } | { kind: 'running'; done: number; total: number } | { kind: 'done'; result: CleanupResult }

export function CleanupDialog({ open, onClose, rows, title, confirmLabel, showProject = false }: {
  open: boolean
  onClose: () => void
  /** The tasks to offer; only failed runs still waiting on the user and open plan lines are listed. */
  rows: TaskEntry[]
  title?: string
  /** The confirm button's words for `n` checked rows (default 清理 {n} 项). */
  confirmLabel?: (n: number) => string
  /** Name each row's project (the list spans several). */
  showProject?: boolean
}) {
  // What the dialog lists is fixed when it opens: rows leave the live list as they are settled.
  const [listed, setListed] = useState<{ actions: TaskEntry[]; plan: TaskEntry[] }>({ actions: [], plan: [] })
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' })
  const latest = useRef(rows)
  latest.current = rows
  useEffect(() => {
    if (!open) return
    const next = cleanupRows(latest.current)
    setListed(next)
    setChecked(new Set([...next.actions, ...next.plan].map(row => row.key)))
    setPhase({ kind: 'pick' })
  }, [open])

  const running = phase.kind === 'running'
  const close = () => { if (!running) onClose() }
  const all = [...listed.actions, ...listed.plan]
  const picked = all.filter(row => checked.has(row.key))
  const toggle = (keys: string[], on: boolean) => setChecked(current => {
    const next = new Set(current)
    for (const key of keys) { if (on) next.add(key); else next.delete(key) }
    return next
  })

  const run = async () => {
    if (running || !picked.length) return
    setPhase({ kind: 'running', done: 0, total: picked.length })
    const result = await clearTasks(picked, done => setPhase({ kind: 'running', done, total: picked.length }))
    if (!result.failed.length) {
      toast(t('已清理 {n} 项', { n: result.cleared.length }))
      onClose()
      return
    }
    setPhase({ kind: 'done', result })
  }

  const footer = phase.kind === 'done'
    ? <Button variant="primary" onClick={onClose}>{t('关闭')}</Button>
    : <>
      <Button variant="ghost" disabled={running} onClick={close}>{t('取消')}</Button>
      <Button variant="primary" disabled={running || !picked.length} onClick={() => void run()}>
        {phase.kind === 'running' ? t('正在清理 {done}/{total}…', { done: phase.done, total: phase.total }) : confirmLabel ? confirmLabel(picked.length) : t('清理 {n} 项', { n: picked.length })}
      </Button>
    </>

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }} title={title ?? t('清理没做完的事')}
      description={t('勾选的会这样处理，随时可以在对话里重新提起。')} footer={footer}>
      {phase.kind === 'done' ? <Report result={phase.result} /> : (
        <div className="-mx-1 max-h-[46vh] space-y-4 overflow-y-auto px-1" aria-busy={running || undefined}>
          {listed.actions.length > 0 && (
            <Group title={t('没做完的后台工作')} note={t('不再提醒，记录保留')} rows={listed.actions} checked={checked} disabled={running} onToggle={toggle} showProject={showProject} />
          )}
          {listed.plan.length > 0 && (
            <Group title={t('计划')} note={t('标记为不再做')} rows={listed.plan} checked={checked} disabled={running} onToggle={toggle} showProject={showProject} />
          )}
          {!all.length && <p className="text-[13px] text-fg-3">{t('没有需要清理的事。')}</p>}
        </div>
      )}
    </Dialog>
  )
}

function Group({ title, note, rows, checked, disabled, onToggle, showProject }: {
  title: string; note: string; rows: TaskEntry[]; checked: ReadonlySet<string>; disabled: boolean; onToggle: (keys: string[], on: boolean) => void; showProject: boolean
}) {
  const keys = rows.map(row => row.key)
  const count = keys.filter(key => checked.has(key)).length
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => { if (box.current) box.current.indeterminate = count > 0 && count < keys.length }, [count, keys.length])
  return (
    <section>
      <label className="flex items-center gap-2 py-1 text-[12.5px] font-medium text-fg-2">
        <input ref={box} type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={count === keys.length} disabled={disabled} onChange={e => onToggle(keys, e.target.checked)} />
        <span>{title}</span>
        <span className="font-normal tabular-nums text-fg-4">{count}/{keys.length}</span>
        <span className="ml-auto truncate font-normal text-fg-3">{note}</span>
      </label>
      <ul className="mt-0.5 space-y-px">
        {rows.map(row => (
          <li key={row.key}>
            <label className={cn('flex items-start gap-2 rounded-md py-1 pl-5 pr-1 text-[13px] leading-[1.5]', !disabled && 'hover:bg-hover')}>
              <input type="checkbox" className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" checked={checked.has(row.key)} disabled={disabled} onChange={e => onToggle([row.key], e.target.checked)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{row.title}</span>
                <span className="block truncate text-[12px] text-fg-4">{[showProject ? row.projectName : null, row.stateLabel, row.when && row.when !== row.stateLabel ? row.when : null].filter(Boolean).join(' · ')}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Report({ result }: { result: CleanupResult }) {
  return (
    <div role="status" className="space-y-2 text-[13px] leading-[1.6]">
      <p className="text-fg-2">{t('已清理 {done} 项，{failed} 项没清理掉：', { done: result.cleared.length, failed: result.failed.length })}</p>
      <ul className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {result.failed.map(({ task, message }) => (
          <li key={task.key} className="rounded-md bg-subtle px-2.5 py-1.5">
            <span className="block truncate text-fg">{task.title}</span>
            <span className="block text-[12px] text-danger">{message}</span>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-fg-3">{t('没清理掉的还留在列表里，可以稍后再试。')}</p>
    </div>
  )
}
