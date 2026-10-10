/**
 * Shared pieces of the H3 global tasks surface: the state glyph, the quick
 * controls + overflow menu used by the sidebar rows and the 任务 page, the
 * steer dialog (mounted once in App) and navigation helpers.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, CalendarClock, CalendarOff, Check, CircleAlert, CircleCheck, CircleMinus, CirclePause, CircleX, Clock3, Compass, Flag, FolderOpen, MoreHorizontal, Pause, Play, Square, X } from 'lucide-react'
import { create } from 'zustand'
import { planOpen, taskAnswers, type TaskAnswer, type TaskControl, type TaskEntry, type TaskFlag, type TaskState } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { selectProject, selectSession } from '@/store/sync'
import { answerTask, controlTask, setPlanStatus, toggleSchedule, useTasks } from '@/store/tasks-store'
import { openTasks, useUi } from '@/store/ui-store'
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { Button, StatusDot, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t, localized } from '@/i18n'

export const STATE_TONE: Record<TaskState, 'accent' | 'warning' | 'danger' | 'muted' | 'success' | 'default'> = {
  running: 'accent', queued: 'default', paused: 'warning', review: 'warning', scheduled: 'default', failed: 'danger', disabled: 'muted', done: 'success', cancelled: 'muted',
}

export function TaskGlyph({ state, className }: { state: TaskState; className?: string }) {
  const box = cn('grid size-4 shrink-0 place-items-center [&_svg]:size-[14px]', className)
  if (state === 'running') return <span className={box}><StatusDot state="running" className="size-[7px]" /></span>
  const Icon = { queued: Clock3, paused: CirclePause, review: CircleAlert, scheduled: CalendarClock, failed: CircleX, disabled: CalendarOff, done: CircleCheck, cancelled: CircleMinus }[state]
  const tone = { queued: 'text-fg-3', paused: 'text-warning', review: 'text-warning', scheduled: 'text-fg-3', failed: 'text-danger', disabled: 'text-fg-4', done: 'text-success', cancelled: 'text-fg-4' }[state]
  return <span className={cn(box, tone)} aria-hidden><Icon strokeWidth={1.8} /></span>
}

/**
 * The 任务 page's status circle (OmniFocus-like): an open ring for work still
 * ahead, a live ring while running, a filled check once done. The state is
 * set by the host; nothing here is clicked to complete.
 */
export function TaskCircle({ state, className }: { state: TaskState; className?: string }) {
  const ring = cn('relative grid size-[15px] shrink-0 place-items-center rounded-full [&_svg]:size-[9px]', className)
  if (state === 'done') return <span className={cn(ring, 'bg-success text-white')} aria-hidden><Check strokeWidth={3} /></span>
  if (state === 'running') return (
    <span className={cn(ring, 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]')} aria-hidden>
      <span className="size-[5px] animate-pulse rounded-full bg-accent" />
    </span>
  )
  if (state === 'review') return <span className={cn(ring, 'bg-warning-soft text-warning shadow-[inset_0_0_0_1.5px_var(--color-warning)]')} aria-hidden><span className="text-[9px] font-bold leading-none">!</span></span>
  if (state === 'failed') return <span className={cn(ring, 'text-danger shadow-[inset_0_0_0_1.5px_var(--color-danger)]')} aria-hidden><X strokeWidth={3} /></span>
  if (state === 'paused') return <span className={cn(ring, 'text-warning shadow-[inset_0_0_0_1.5px_var(--color-warning)]')} aria-hidden><Pause strokeWidth={3} fill="currentColor" /></span>
  if (state === 'cancelled') return <span className={cn(ring, 'text-fg-4 shadow-[inset_0_0_0_1.5px_var(--color-fg-4)]')} aria-hidden><span className="h-[1.5px] w-[7px] rounded-full bg-current" /></span>
  if (state === 'queued' || state === 'disabled') return <span className={cn(ring, 'border-[1.5px] border-dashed border-fg-4')} aria-hidden />
  return <span className={cn(ring, 'shadow-[inset_0_0_0_1.5px_var(--color-fg-3)]')} aria-hidden />
}

export const FLAG_LABELS: Record<TaskFlag, string> = localized({ attention: '需要你', failed: '未完成', overdue: '已错过', fresh: '新结果', stopping: '正在停止', handled: '已处理' })
const FLAG_TONE: Record<TaskFlag, string> = {
  attention: 'bg-warning-soft text-warning-text', failed: 'bg-danger-soft text-danger', overdue: 'bg-danger-soft text-danger',
  fresh: 'bg-accent-softer text-accent-text', stopping: 'bg-warning-soft text-warning-text', handled: 'bg-subtle text-fg-3',
}

/** The automatic status marks on a row: 需要你 / 未完成 / 已错过 / 新结果 / 正在停止. */
export function TaskFlags({ flags, className }: { flags: TaskFlag[]; className?: string }) {
  if (!flags.length) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {flags.map(flag => (
        <span key={flag} className={cn('inline-flex items-center gap-0.5 rounded-[5px] px-1.5 text-[11px] font-medium leading-[18px]', FLAG_TONE[flag])}>
          {flag === 'attention' && <Flag className="size-2.5" strokeWidth={2.4} />}
          {FLAG_LABELS[flag]}
        </span>
      ))}
    </span>
  )
}

export const CONTROL_LABELS: Record<TaskControl, string> = localized({ pause: '暂停', resume: '继续', stop: '停止', steer: '调整方向' })
const CONTROL_ICONS: Record<TaskControl, typeof Pause> = { pause: Pause, resume: Play, stop: Square, steer: Compass }

/* --------------------------------------------------------- navigation */

/** Open the project's main conversation (or the project itself when it has none). */
export function openProject(projectId: string) {
  const app = useApp.getState()
  const project = app.projects[projectId]
  const primary = project?.primarySessionId && app.sessionIndex[project.primarySessionId] && !app.sessionIndex[project.primarySessionId].archivedAt ? project.primarySessionId : null
  if (primary) void selectSession(primary)
  else selectProject(projectId)
  useUi.setState({ view: 'chat', sidebarOpen: false })
}

/** Open the 任务 page on this task (its tab, its project, its inspector). */
export function openTaskDetail(task: TaskEntry, { delivery = false }: { delivery?: boolean } = {}) {
  openTasks(task.projectId, { key: task.key, occurrenceKey: delivery ? task.deliveryKey ?? null : null }, task.kind === 'schedule' ? 'schedules' : 'adhoc')
}

/* -------------------------------------------------------------- steer */

const useSteer = create<{ task: TaskEntry | null }>(() => ({ task: null }))
export const openSteer = (task: TaskEntry) => useSteer.setState({ task })
const drafts = new Map<string, string>()

export function SteerTaskDialog() {
  const task = useSteer(s => s.task)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (task) { setText(drafts.get(task.key) ?? ''); setError('') } }, [task])
  const close = () => { if (!busy) useSteer.setState({ task: null }) }
  const submit = async () => {
    if (!task || busy) return
    if (!text.trim()) { setError(t('请填写调整内容。')); return }
    setBusy(true); setError('')
    try { await controlTask(task, 'steer', text.trim()); drafts.delete(task.key); useSteer.setState({ task: null }) }
    catch (e) { setError(t('{message} 输入内容已保留。', { message: (e as Error).message })) }
    finally { setBusy(false) }
  }
  return (
    <Dialog open={Boolean(task)} onOpenChange={open => { if (!open) close() }} title={t('调整后台工作方向')}
      description={task ? `${task.projectName} · ${task.title}` : undefined}
      footer={<><Button variant="ghost" disabled={busy} onClick={close}>{t('返回')}</Button><Button variant="primary" disabled={busy} onClick={() => void submit()}>{t('提交调整')}</Button></>}>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{t('补充重点或改变方向')}</span>
        <textarea autoFocus rows={4} maxLength={4000} value={text} disabled={busy} placeholder={t('例如：优先核对官方来源，先给出影响最大的两个问题。')}
          onChange={e => { setText(e.target.value); if (task) drafts.set(task.key, e.target.value) }}
          className="w-full resize-none rounded-lg bg-subtle px-3 py-2 text-[13px] leading-[1.7] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
      </label>
      <p className="mt-1.5 text-[12px] leading-[1.6] text-fg-3">{t('只发给这项后台工作；暂停中的工作需要点击继续后处理。')}</p>
      {error && <p role="status" className="mt-2 text-[12.5px] text-danger">{error}</p>}
    </Dialog>
  )
}

/* ----------------------------------------------------------- controls */

/** 接着做 goes to the project's conversation in the user's name (and opens it); the other answers just settle the task. */
export async function answer(task: TaskEntry, choice: TaskAnswer) {
  const outcome = await answerTask(task, choice)
  if (outcome.ok && choice === 'continue') openProject(task.projectId)
}

function run(task: TaskEntry, op: TaskControl) {
  if (op === 'steer') { openSteer(task); return }
  void controlTask(task, op).catch(() => { /* toasted */ })
}

/** The one or two most likely controls, as icon buttons. A plan line: 标记完成 and 不再做. */
export function quickControls(task: TaskEntry): { id: string; label: string; icon: ReactNode; onClick: () => void }[] {
  if (planOpen(task)) return [
    { id: 'plan-done', label: t('标记完成'), icon: <Check />, onClick: () => void setPlanStatus(task, 'done') },
    { id: 'plan-drop', label: t('不再做'), icon: <X />, onClick: () => void setPlanStatus(task, 'dropped') },
  ]
  if (task.kind === 'schedule') {
    if (task.state === 'running') return []
    return [{ id: 'toggle', label: task.enabled ? t('暂停日程') : t('恢复日程'), icon: task.enabled ? <Pause /> : <Play />, onClick: () => void toggleSchedule(task) }]
  }
  return task.controls.filter(op => op !== 'steer').slice(0, 2).map(op => {
    const Icon = CONTROL_ICONS[op]
    return { id: op, label: CONTROL_LABELS[op], icon: <Icon />, onClick: () => run(task, op) }
  })
}

export function TaskMenuItems({ task, showDetail = true }: { task: TaskEntry; showDetail?: boolean }) {
  const busy = useTasks(s => s.busy !== null)
  const answers = taskAnswers(task)
  return (
    <>
      {/* A plan line the agent keeps: the user can call it done or drop it (the host records it as the user's call). */}
      {planOpen(task) && <>
        <MenuItem icon={<Check />} onSelect={() => void setPlanStatus(task, 'done')}>{t('标记完成')}</MenuItem>
        <MenuItem icon={<X />} onSelect={() => void setPlanStatus(task, 'dropped')}>{t('不再做')}</MenuItem>
        <MenuSeparator />
      </>}
      {task.kind === 'action' && task.controls.map(op => {
        const Icon = CONTROL_ICONS[op]
        return <MenuItem key={op} icon={<Icon />} disabled={busy} onSelect={() => run(task, op)}>{op === 'steer' ? t('调整方向…') : CONTROL_LABELS[op]}</MenuItem>
      })}
      {/* Work that needs the user is settled right here (or from the strip above the composer), no detour. */}
      {task.state === 'review' && answers.length > 0 && <>
        <MenuItem icon={<Check />} disabled={busy} onSelect={() => void answer(task, 'keep')}>{t('按现在的算')}</MenuItem>
        <MenuItem icon={<X />} disabled={busy} onSelect={() => void answer(task, 'drop')}>{t('不用再做')}</MenuItem>
        <MenuSeparator />
      </>}
      {/* 接着做 only where it can work: a run the host kept nothing of has nothing to carry on with. */}
      {task.state === 'failed' && answers.length > 0 && <>
        {answers.includes('continue') && <MenuItem icon={<Play />} disabled={busy} onSelect={() => void answer(task, 'continue')}>{t('接着做')}</MenuItem>}
        <MenuItem icon={<X />} disabled={busy} onSelect={() => void answer(task, 'drop')}>{t('不用了')}</MenuItem>
        <MenuSeparator />
      </>}
      {/* A finished result marked 需要你: seen here, like the inspector's 知道了 (C-e). */}
      {answers.includes('acknowledge') && <>
        <MenuItem icon={<Check />} disabled={busy} onSelect={() => void answer(task, 'acknowledge')}>{t('知道了')}</MenuItem>
        <MenuSeparator />
      </>}
      {task.kind === 'schedule' && task.state !== 'running' && <MenuItem icon={task.enabled ? <Pause /> : <Play />} disabled={busy} onSelect={() => void toggleSchedule(task)}>{task.enabled ? t('暂停日程') : t('恢复日程')}</MenuItem>}
      {task.kind === 'schedule' && task.deliveryKey && <MenuItem icon={<ArrowUpRight />} onSelect={() => openTaskDetail(task, { delivery: true })}>{t('查看上次交付')}</MenuItem>}
      {(task.kind === 'action' && task.controls.length > 0 || task.kind === 'schedule') && <MenuSeparator />}
      {showDetail && <MenuItem icon={<ArrowUpRight />} onSelect={() => openTaskDetail(task)}>{task.state === 'review' ? t('核对执行结果') : t('查看详情与记录')}</MenuItem>}
      <MenuItem icon={<FolderOpen />} onSelect={() => openProject(task.projectId)}>{t('打开项目')}</MenuItem>
    </>
  )
}

export function TaskMenu({ task, className, showDetail }: { task: TaskEntry; className?: string; showDetail?: boolean }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" onClick={e => e.stopPropagation()} aria-label={t('任务操作：{title}', { title: task.title })}
          className={cn('grid size-6 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active data-[state=open]:text-fg', className)}>
          <MoreHorizontal className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-48"><TaskMenuItems task={task} showDetail={showDetail} /></MenuContent>
    </Menu>
  )
}

export function QuickControlButtons({ task, className }: { task: TaskEntry; className?: string }) {
  const busy = useTasks(s => s.busy === task.key)
  return (
    <>
      {quickControls(task).map(c => (
        <Tooltip key={c.id} content={c.label}>
          <button type="button" aria-label={t('{label}：{title}', { label: c.label, title: task.title })} disabled={busy}
            onClick={e => { e.stopPropagation(); c.onClick() }}
            className={cn('grid size-6 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3.5', className)}>
            {c.icon}
          </button>
        </Tooltip>
      ))}
    </>
  )
}

/**
 * A failed run's answers in view (not only in ⋯): 接着做 where it can work, and 不用了. `row`: compact, for a list row or
 * the 后台任务 panel; `inspector`: the task inspector's buttons.
 */
export function FailedAnswerButtons({ task, variant = 'row', className }: { task: TaskEntry; variant?: 'row' | 'inspector'; className?: string }) {
  const answers = taskAnswers(task)
  const pending = useTasks(s => s.settling[task.key]?.kind === 'answer')
  if (task.state !== 'failed' || !answers.length) return null
  const buttons = (['continue', 'drop'] as const).filter(choice => answers.includes(choice))
  if (variant === 'inspector') return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {buttons.map(choice => (
        <Button key={choice} size="sm" variant={choice === 'continue' ? 'secondary' : 'ghost'} disabled={pending} leading={choice === 'continue' ? <Play className="size-3.5" /> : <X className="size-3.5" />}
          title={choice === 'continue' ? t('在项目对话里以你的名义接着做') : t('不再提醒，记录保留')} onClick={() => void answer(task, choice)}>
          {choice === 'continue' ? t('接着做') : t('不用了')}
        </Button>
      ))}
    </div>
  )
  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {buttons.map(choice => (
        <Tooltip key={choice} content={choice === 'continue' ? t('在项目对话里以你的名义接着做') : t('不再提醒，记录保留')}>
          <button type="button" disabled={pending} onClick={e => { e.stopPropagation(); void answer(task, choice) }}
            aria-label={t('{label}：{title}', { label: choice === 'continue' ? t('接着做') : t('不用了'), title: task.title })}
            className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40">
            {choice === 'continue' ? t('接着做') : t('不用了')}
          </button>
        </Tooltip>
      ))}
    </span>
  )
}
