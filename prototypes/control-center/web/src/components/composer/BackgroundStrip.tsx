/**
 * Background work running in this conversation's project, shown where the user
 * is about to type: what it is doing and, when it can change files, that a
 * message now would stop it first (a foreground turn always drains background
 * writers; what it already changed is kept). One line, with 停止 and 查看
 * (its card in the 后台任务 panel).
 */
import { useMemo } from 'react'
import { useApp } from '@/store/app-store'
import { controlTask, useTasks } from '@/store/tasks-store'
import { useLiveTasks } from '@/components/tasks/live-tasks'
import { openTasksPanel } from '@/components/workspace/tasks-panel'
import { StatusDot } from '@/components/ui/primitives'
import { t } from '@/i18n'

export function BackgroundStrip({ projectId, turnRunning }: { projectId: string | null; turnRunning: boolean }) {
  const tasks = useLiveTasks()
  const permissions = useApp(s => (projectId ? s.projects[projectId]?.permissions : undefined))
  const busy = useTasks(s => s.busy)
  const running = useMemo(() => tasks.filter(task => task.projectId === projectId && task.kind === 'action' && task.actionKind === 'work' && task.state === 'running'), [tasks, projectId])
  if (!projectId || !running.length) return null
  const task = running[0]!
  // Only work that may change files is stopped by a foreground turn; while a turn runs it has already been stopped.
  const writes = permissions?.background !== 'read' && ['write', 'execute'].includes(String(permissions?.workspace ?? ''))
  const button = 'shrink-0 rounded-md px-1.5 text-[12.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40'
  return (
    <div className="mx-2 mb-2 rounded-xl bg-accent-softer px-3.5 py-1.5 text-[13px] leading-6 text-fg-2" role="status" aria-live="polite" data-background-strip>
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state="running" />
        <span className="shrink-0 text-accent-text">{t('后台正在做')}</span>
        <span className="min-w-0 flex-1 truncate" title={task.title}>{task.title}{running.length > 1 ? t('（另有 {n} 项）', { n: running.length - 1 }) : ''}</span>
        <button type="button" onClick={() => openTasksPanel({ focusRunId: task.key, projectId })} className={button}>{t('查看')}</button>
        {task.controls.includes('stop') && <button type="button" disabled={busy !== null} onClick={() => void controlTask(task, 'stop').catch(() => {})} className={button}>{t('停止')}</button>}
      </div>
      {writes && !turnRunning && <p className="truncate pl-[18px] text-[12px] leading-5 text-fg-3">{t('这时发消息会先让它停下，已做的保留')}</p>}
    </div>
  )
}
