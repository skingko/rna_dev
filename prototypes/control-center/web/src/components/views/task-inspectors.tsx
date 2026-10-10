/**
 * The 任务 page's inspector: one selected item in full. Background work
 * (controls, handoff, result, review, tool receipts folded away), a
 * schedule (rule, next run, results, deliveries, edit), a piece of 自主学习
 * (an evolution generation) and a project's rhythm.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, Compass, FolderOpen, Pause, Play, Square, Sprout, X } from 'lucide-react'
import { deliveryReceipt, projectActivity, type ActivityRow } from '@/lib/display/activity'
import { projectApi, type Occurrence, type ProjectDetail, type Schedule, type ScheduleList } from '@/api/project-api'
import { loadItem, loadSession, locateRun } from '@/api/client'
import { ApiError } from '@/api/transport'
import type { Item } from '@/api/types'
import { useApp } from '@/store/app-store'
import { openInboxEntry, openSessionItem } from '@/store/deep-link'
import { communicationApi } from '@/api/communication-api'
import { toast } from '@/store/ui-store'
import { openMind } from '@/store/mind-store'
import { answerTask, controlTask, refreshActions, setPlanStatus, toggleSchedule, useTasks } from '@/store/tasks-store'
import { deliveredOccurrence, matchDelivery, scheduleRows, WEEKDAYS } from '@/lib/schedules'
import { occurrenceText, planOpen, type ActionView, type TaskControl, type TaskEntry } from '@/lib/tasks'
import { Markdown } from '@/components/markdown/Markdown'
import { BackgroundDeliverables } from '@/components/timeline/BackgroundDeliverables'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { CONTROL_LABELS, FailedAnswerButtons, TaskCircle, TaskFlags, openProject, openSteer } from '@/components/tasks/task-parts'
import { cn } from '@/lib/utils'
import { Badge, DefinitionList, Field, ListSkeleton, Note, Select, TextArea, TextInput, fullTime, stamp } from './kit'
import { RhythmCard } from './RhythmCard'
import { useProjectDetail } from './useProjectDetail'
import { t, localized } from '@/i18n'
import { failureSentence, hostFailureHandoff, reviewDiagnosis, stripHandoffMarker, type JobReceipt } from '@/lib/task-failure'

/* ------------------------------------------------------------- shared */

function Head({ task, children }: { task: TaskEntry; children?: ReactNode }) {
  return (
    <header className="space-y-2">
      <div className="flex items-start gap-2.5">
        <TaskCircle state={task.state} className="mt-[5px]" />
        <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-[1.6] text-fg">{task.title}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-[25px] text-[12.5px] text-fg-3">
        <span>{task.label}</span><span aria-hidden className="text-fg-4">·</span><span>{task.stateLabel}</span>
        {task.when && <><span aria-hidden className="text-fg-4">·</span><span className="tabular-nums">{task.when}</span></>}
        <TaskFlags flags={task.flags} />
      </div>
      {children}
    </header>
  )
}

function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <section className={cn('border-t border-line-faint pt-4', className)}><h4 className="mb-2 text-[12px] font-medium text-fg-3">{title}</h4>{children}</section>
}

/** Long text folded to six lines, with 展开全文. */
function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 280 || text.split('\n').length > 6
  return (
    <div>
      <p className={cn('whitespace-pre-wrap', long && !open && 'line-clamp-6')}>{text}</p>
      {long && <button type="button" onClick={() => setOpen(v => !v)} className="mt-1 rounded-md text-[12.5px] text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{open ? t('收起') : t('展开全文')}</button>}
    </div>
  )
}

function loadedSessions() {
  return Object.values(useApp.getState().sessions).map(slice => ({ id: slice.meta.id, projectId: slice.meta.projectId, items: slice.order.map(id => slice.items[id]) }))
}

/* --------------------------------------------------- background action */

const CONTROL_ICONS: Record<TaskControl, typeof Pause> = { pause: Pause, resume: Play, stop: Square, steer: Compass }
const RECEIPT_STATUS: Record<string, string> = localized({ queued: '等待执行', running: '执行中', paused: '已暂停', completed: '已结束', failed: '未完成', cancelled: '已取消', needs_review: '结果待核对', interrupted: '已中断' })
const receiptLabel = (row: ActivityRow) => row.kind === 'schedule' ? (row.planSaved ? t('已登记任务安排；具体工作与投递另有回执') : t('尚无持久任务安排回执'))
  : row.counts ? t('工具回执 {total}：完成 {completed} / 失败 {failed} / 待核对 {uncertain}', { total: row.counts.total, completed: row.counts.completed, failed: row.counts.failed, uncertain: row.counts.uncertain }) : t('尚无保留的工具执行回执')
type JobRecord = { id: string; handoff?: string; toolReceipts?: JobReceipt[] }

/**
 * How to open what a share / ask delivered (F59): its message or question card in a conversation already loaded, else
 * the project inbox's record of it (every proactive delivery is there, with where it landed). Nothing in an archived
 * conversation, and nothing when no record is found (no button rather than one that lands at a conversation's bottom).
 */
function useActionDelivery(projectId: string, actionId: string, kind: string | undefined, enabled: boolean) {
  const [open, setOpen] = useState<(() => void) | null>(null)
  useEffect(() => {
    setOpen(null)
    if (!enabled || !kind) return
    let cancelled = false
    const live = (sessionId: string) => { const s = useApp.getState().sessionIndex[sessionId]; return Boolean(s) && !s.archivedAt }
    for (const session of loadedSessions().filter(s => s.projectId === projectId && live(s.id))) {
      const item = session.items.find(row => deliveryReceipt(row, session.id)?.[0] === `${kind}:${actionId}`)
      if (item) { setOpen(() => () => void openSessionItem(session.id, item.id)); return }
    }
    void communicationApi.inbox(projectId, 'all', 200).then(list => {
      const entry = list?.entries.find(row => row.actionId === actionId && !row.contextRevoked && !row.sourceDeleted)
      if (!cancelled && entry && (!entry.sessionId || live(entry.sessionId))) setOpen(() => () => void openInboxEntry(projectId, entry.id, entry))
    }).catch(() => { /* no inbox record: no button */ })
    return () => { cancelled = true }
  }, [projectId, actionId, kind, enabled])
  return open
}

export function ActionInspector({ task }: { task: TaskEntry }) {
  const { project, reload, error, loading } = useProjectDetail(task.projectId, ['jobs', 'initiativeRuntime', 'learningRuntime'])
  const busy = useTasks(s => s.busy === task.key)
  const row = useMemo(() => (project ? projectActivity(project, loadedSessions()).find(r => r.id === task.id) ?? null : null), [project, task.id])
  const action: ActionView | undefined = project?.initiativeRuntime?.sdkState?.actions?.find(a => a.id === task.id)
  const job = (project?.jobs as JobRecord[] | undefined)?.find(j => j.id === task.id)
  // Only a run's own handoff line goes under 交接 (a result summary is shown as 结果).
  const handoff = action?.handoff ?? job?.handoff ?? action?.receipt?.handoff ?? null
  const pending = (action?.controls ?? []).filter(c => c.status === 'pending')
  const changes = (useApp(s => s.projects[task.projectId]?.backgroundChanges) ?? []).filter(row => row.actionId === task.id)
  const communication = task.actionKind === 'share' || task.actionKind === 'ask'
  // A share / ask that went out: find its message even in a conversation not opened yet (F59).
  const openDelivery = useActionDelivery(task.projectId, task.id, task.actionKind, communication && task.state === 'done' && !task.revoked)
  const [acknowledging, setAcknowledging] = useState(false)
  const acknowledge = async () => {
    setAcknowledging(true)
    // Through the store, so 需要你 drops everywhere at once (the sidebar, this page, the 后台任务 panel).
    try { await answerTask(task, 'acknowledge') }
    finally { setAcknowledging(false) }
  }
  const revoked = task.revoked || action?.contextRevoked === true
  const unsent = communication && task.state === 'cancelled'
  const code = row?.errorCode || action?.failure?.code || action?.errorCode
  // What the row already knows (its title, state, controls, answers and how it stopped) shows at once; the project's
  // records (jobs, runtime) can take a while to read on a large project, and only the parts below wait for them.
  return (
    <div className="space-y-4 text-[13.5px] leading-[1.7] text-fg-2">
      <Head task={task} />
      {task.controls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {task.controls.map(op => {
            const Icon = CONTROL_ICONS[op]
            return (
              <Button key={op} size="sm" variant="secondary" disabled={busy} leading={<Icon className="size-3.5" />}
                title={op === 'pause' || op === 'stop' ? t('当前工具批次结束后{v}，保留已完成的操作。', { v: CONTROL_LABELS[op] }) : undefined}
                onClick={() => { if (op === 'steer') openSteer(task); else void controlTask(task, op).catch(() => { /* toasted */ }) }}>
                {op === 'steer' ? t('调整方向…') : CONTROL_LABELS[op]}
              </Button>
            )
          })}
        </div>
      )}
      {/* A failed run that waits on the user: 接着做 (where it can work) and 不用了, as on its row. */}
      <FailedAnswerButtons task={task} variant="inspector" />
      {revoked && <Note>{t('项目之后有了调整（例如新建会话、换模型或采用新版本），这项工作只保留了结果回执，当时的详细内容不再保留。')}</Note>}
      {task.lost && task.state === 'failed' && <Note>{t('这项工作没留下能接着做的内容；要继续的话，在对话里直接说要做什么。')}</Note>}
      {/* An unsent share / ask was not stopped work (F13): it was not sent, and why — the same line as its row (never an earlier wait). */}
      {unsent ? task.summary && <Note>{task.summary}</Note>
        : (task.state === 'failed' || task.state === 'cancelled') && <Note>{project ? failureSentence(code, action?.status ?? (task.state === 'cancelled' ? 'cancelled' : undefined)) : task.summary}</Note>}
      {task.state === 'done' && task.flags.includes('attention') && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warning-soft/60 px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-[13px] text-fg-2">{t('这个结果需要你看一下。看过后点「知道了」，它就不再算在“需要你”里。')}</p>
          <Button size="sm" disabled={acknowledging} onClick={() => void acknowledge()}>{t('知道了')}</Button>
        </div>
      )}
      {!project && (error && !loading
        ? <p role="status" className="text-[12.5px] text-fg-3">{t('详细记录没读到：{message}', { message: error })} <button type="button" onClick={() => void reload()} className="rounded-md px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('重试')}</button></p>
        : <ListSkeleton rows={3} />)}
      {handoff && !hostFailureHandoff(handoff) && <p className="rounded-lg bg-subtle px-3 py-2 text-fg-2"><span className="text-fg-3">{t('交接：')}</span>{stripHandoffMarker(handoff)}</p>}
      {task.state === 'paused' && <Note>{t('已保留进度，继续后接续当前工作。新的自动调查会等待；已安排的任务照常执行。{v}', { v: pending.some(c => c.kind === 'steer') ? t('调整已保存，继续时处理。') : '' })}</Note>}
      {task.state === 'running' && pending.length > 0 && <Note>{pending.some(c => c.kind === 'pause' || c.kind === 'cancel') ? t('正在处理控制请求，等待当前工具批次结束；已完成的操作会保留。') : t('调整已收到，等待工作接续时处理。')}</Note>}
      {task.state === 'review' && action && project && <ReviewForm project={project} actionId={action.id} content={task.title} diagnosis={reviewDiagnosis(action.failure?.code ?? action.errorCode, job?.toolReceipts)} onDone={reload} />}
      {row?.detail && !unsent && <Note>{row.detail}</Note>}
      {row?.intent && row.intent !== task.title && <Block title={t('要做什么')}><ClampText text={row.intent} /></Block>}
      {row?.reason && <Block title={t('为什么做')}><ClampText text={row.reason} /></Block>}
      {/* A share / ask's result is what it came to for the user (the task's line), never the receipt written for the model. */}
      {communication ? task.state === 'done' && task.summary && <Block title={t('结果')}><p>{task.summary}</p></Block>
        : row?.summary && <Block title={t('结果')}><Markdown text={row.summary} variant="compact" className="text-[13.5px]" /></Block>}
      {changes.length > 0 && (
        <Block title={t('后台改动的文件')}>
          {changes.map(change => <BackgroundDeliverables key={change.id} projectId={task.projectId} changeId={change.id} className="mb-2 last:mb-0" />)}
        </Block>
      )}
      {openDelivery && (
        <Button size="sm" variant="ghost" leading={<ArrowUpRight className="size-3.5" />} onClick={openDelivery}>{t('在会话中查看')}</Button>
      )}
      {/* Tool receipts and the diagnostic code stay folded away (no codes on screen). */}
      {row && !communication && (row.receipts.length > 0 || row.counts || row.errorCode) && (
        <details className="border-t border-line-faint pt-4 text-[12.5px]">
          <summary className="cursor-pointer text-fg-3">{receiptLabel(row)}</summary>
          {row.errorCode && <p className="mt-1 font-mono text-[12px] text-fg-4">{t('诊断：{errorCode}', { errorCode: row.errorCode })}</p>}
          {row.counts && row.counts.total > row.receipts.length && <p className="mt-2 text-fg-4">{t('此处展示 {length} 条保留明细，包含失败与近期结果；完整记录见执行轨迹。', { length: row.receipts.length })}</p>}
          <ul className="mt-2 space-y-1">
            {row.receipts.map((r, i) => (
              <li key={i}>
                <details className="rounded-md bg-subtle px-2.5 py-1">
                  <summary className="cursor-pointer text-fg-2"><span className="font-mono text-[12px]">{r.toolName}</span><span className="text-fg-4"> · {RECEIPT_STATUS[r.status] ?? (r.status === 'uncertain' ? t('待核对') : r.status)} · {stamp(r.at)}</span></summary>
                  <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-fg-2">{r.output || t('无文本输出')}</pre>
                  {r.truncated && <small className="text-fg-3">{t('输出已截取。')}</small>}
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function ReviewForm({ project, actionId, content, diagnosis, onDone }: { project: ProjectDetail; actionId: string; content?: string; diagnosis: string[]; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    if (!status) { setError(t('请选择已核对的结果。')); return }
    if (!summary.trim()) { setError(t('请填写实际核对依据。')); return }
    setBusy(true); setError('')
    try {
      await projectApi.resolveAction(project.id, actionId, { status, summary: summary.trim() }); onDone(); setOpen(false); toast(t('核对结论已保存，原操作未重放。'))
      // The task list and the conversation's 去核对 / 重试请求 notice read the actions snapshot: settle them now (C2-d).
      void refreshActions(project.id, { fresh: true })
    }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <div className="rounded-lg bg-warning-soft/60 px-3.5 py-3">
      <p className="text-[13px] text-fg-2">{t('中断留下的记录还不能确认执行结果。涉及未确认操作时，后台工作会保持隔离，直到完成实际核对。')}</p>
      {diagnosis.length > 0 && <details className="mt-1.5 text-[12.5px]"><summary className="cursor-pointer text-fg-3">{t('执行记录与诊断')}</summary>{diagnosis.map(line => <p key={line} className="mt-1 text-fg-2">{line}</p>)}</details>}
      <Button className="mt-2" size="sm" onClick={() => { setOpen(true); setStatus(''); setSummary(''); setError('') }}>{t('核对执行结果')}</Button>
      <Dialog open={open} onOpenChange={o => { if (!o && !busy) setOpen(false) }} title={t('核对后台执行结果')}
        description={<>{project.name} · {content || t('后台行动')}<br />{t('先检查实际文件、运行结果及相关进程，再记录结论。记录后不会重放原操作；项目可按现有设置继续判断下一步。')}</>}
        footer={<><Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('返回')}</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{t('保存核对结论')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('核对结论')}>
            <Select value={status} onChange={e => setStatus(e.target.value)} disabled={busy}>
              <option value="">{t('请选择已核对的结果')}</option>
              <option value="completed">{t('已完成，结果已验证')}</option>
              <option value="not-executed">{t('确认没有执行')}</option>
              <option value="cancelled">{t('已检查并终止，结果未验证')}</option>
            </Select>
          </Field>
          <Field label={t('核对依据')}><TextArea rows={5} maxLength={16000} value={summary} disabled={busy} placeholder={t('记录检查了哪些文件、回执或进程，以及仍未知的结果。')} onChange={e => setSummary(e.target.value)} /></Field>
          {error && <p role="status" className="text-[12.5px] text-danger">{error}</p>}
        </div>
      </Dialog>
    </div>
  )
}

/* ------------------------------------------------------------ learning */

export function LearningInspector({ task }: { task: TaskEntry }) {
  const forming = task.actionKind === 'forming'
  return (
    <div className="space-y-4 text-[13.5px] leading-[1.7] text-fg-2">
      <Head task={task} />
      <p>{forming ? t('项目正在把一条反馈变成可复用的做法：先写出来，再在临时目录验证，通过后才会生效。') : t('这一代把一条反馈固化成了项目的做法，之后的工作会自动用上。')}</p>
      {task.summary && !forming && <p className="text-fg-3">{task.summary}</p>}
      {forming && task.summary && <Block title={t('它会做什么')}><p>{task.summary}</p></Block>}
      <Button size="sm" variant="secondary" leading={<Sprout className="size-3.5" />} onClick={() => openMind(task.projectId)}>{t('在进化页查看')}</Button>
    </div>
  )
}

/* ---------------------------------------------------------------- plan */

export function PlanInspector({ task }: { task: TaskEntry }) {
  // A change the plan does not show yet: the buttons wait for it (it is undone if refused). One the plan has moved past
  // since (the agent put the line back: its row is newer than the change) holds nothing.
  const busy = useTasks(s => { const change = s.settling[task.key]; return change?.kind === 'plan' && change.since === task.at })
  return (
    <div className="space-y-4 text-[13.5px] leading-[1.7] text-fg-2">
      <Head task={task} />
      <p>{t('这是 Agent 自己维护的工作计划，对话和后台工作共用。你说“继续”时，它会从正在做的一项接着做。')}</p>
      {planOpen(task) && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" disabled={busy} leading={<Check className="size-3.5" />} onClick={() => void setPlanStatus(task, 'done')}>{t('标记完成')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} leading={<X className="size-3.5" />} title={t('从计划里拿掉；Agent 不会再接着做这一项')} onClick={() => void setPlanStatus(task, 'dropped')}>{t('不再做')}</Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- project */

export function ProjectInspector({ projectId }: { projectId: string }) {
  const { project } = useProjectDetail(projectId, ['jobs', 'initiativeRuntime', 'learningRuntime'])
  if (!project) return <ListSkeleton rows={3} />
  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-2 text-[15px] font-medium text-fg"><FolderOpen className="size-4 text-fg-3" strokeWidth={1.8} />{project.name}</h3>
      <RhythmCard project={project} />
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" leading={<ArrowUpRight className="size-3.5" />} onClick={() => openProject(projectId)}>{t('打开项目')}</Button>
        <Button size="sm" variant="ghost" leading={<Sprout className="size-3.5" />} onClick={() => openMind(projectId)}>{t('查看进化')}</Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ schedule */

function useSchedules(projectId: string) {
  const { project, error, loading, reload } = useProjectDetail(projectId, ['jobs', 'initiativeRuntime', 'learningRuntime'])
  const [data, setData] = useState<ScheduleList | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const sig = JSON.stringify([project?.schedules, project?.scheduleRuntime])
  const load = useCallback(async () => {
    try { setData(await projectApi.schedules(projectId)); setStatus(null) }
    catch (e) { setStatus(t('日程读取失败：{message}', { message: (e as Error).message })) }
  }, [projectId])
  useEffect(() => { void load() }, [load, sig])
  const [busy, setBusy] = useState(false)
  /**
   * null when saved, else why not. A schedule the host refused (400 / 409) reads as the host wrote it: a whole sentence
   * in the interface language (C-i). Anything else (no connection …) says the schedule was not saved. A create / edit
   * shows it inside its dialog.
   */
  const mutate = async (id: string | undefined, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<string | null> => {
    if (busy) return t('正在保存，请稍候。')
    setBusy(true)
    try {
      if (method === 'POST') await projectApi.createSchedule(projectId, body ?? {})
      else if (method === 'PATCH') await projectApi.updateSchedule(projectId, id!, body ?? {})
      else await projectApi.deleteSchedule(projectId, id!)
      reload(); await load()
      return null
    } catch (e) {
      const refused = method !== 'DELETE' && e instanceof ApiError && e.status >= 400 && e.status < 500
      const message = refused ? (e as Error).message : t('日程未保存：{message}', { message: (e as Error).message })
      if (method === 'DELETE') setStatus(message)
      return message
    } finally { setBusy(false) }
  }
  return { project, error, loading, reload, data, status, busy, mutate }
}

export function ScheduleInspector({ task, occurrenceKey, onOpenDelivery, onRemoved }: { task: TaskEntry; occurrenceKey: string | null; onOpenDelivery: (key: string | null) => void; onRemoved: () => void }) {
  const { project, data, status, busy, mutate } = useSchedules(task.projectId)
  const emergency = useApp(s => s.emergency)
  const sessionIndex = useApp(s => s.sessionIndex)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const row = useMemo(() => project ? scheduleRows({ ...project, schedules: data?.schedules ?? project.schedules ?? [] }, { occurrences: data?.occurrences ?? project.scheduleRuntime?.occurrences ?? [], emergency, sessions: Object.values(sessionIndex), projectId: project.id }).find(r => r.id === task.id) ?? null : null, [project, data, emergency, sessionIndex, task.id])
  useEffect(() => { setConfirmDelete(false) }, [task.id])
  if (!project) return <ListSkeleton rows={3} />
  if (occurrenceKey) return (
    <div className="space-y-3">
      <button type="button" onClick={() => onOpenDelivery(null)} className="inline-flex items-center gap-1 rounded-md px-1 text-[12.5px] text-fg-3 hover:text-fg"><ArrowLeft className="size-3.5" />{task.title}</button>
      <DeliveryReader project={project} scheduleId={task.id} occurrenceKey={occurrenceKey} />
    </div>
  )
  if (!row) return <p className="text-[13px] text-fg-3">{status ?? t('这个日程已删除。')}</p>
  return (
    <div className="space-y-4 text-[13.5px] leading-[1.7] text-fg-2">
      <Head task={task} />
      <DefinitionList rows={[[t('规则'), row.rule], [t('下一次'), row.paused || !row.record.nextRunAt ? row.next : fullTime(row.record.nextRunAt)], [t('上一次'), <span key="r" className={cn(['failed', 'needs_review'].includes(row.lastStatus ?? '') && 'text-danger')}>{row.history[0] ? `${fullTime(row.history[0].scheduledAt)} · ${occurrenceText(row.history[0])}` : row.result}</span>], [t('送到'), row.destination], [t('来源'), row.origin.label]]} />
      <div className="flex flex-wrap gap-1.5">
        {confirmDelete ? (
          <>
            <span className="self-center text-[12.5px] text-fg-2">{t('删除后不再安排新任务，已有执行记录保留。')}</span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void mutate(row.id, 'DELETE').then(failed => { if (!failed) onRemoved() })}>{t('确认删除')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>{t('取消')}</Button>
          </>
        ) : (
          <>
            {row.deliveryKey && <Button size="sm" variant="secondary" disabled={busy} leading={<ArrowUpRight className="size-3.5" />} onClick={() => onOpenDelivery(row.deliveryKey)}>{row.deliveryKey === row.latestKey ? t('查看交付') : t('查看上次交付')}</Button>}
            <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>{t('编辑')}</Button>
            {task.state !== 'running' && <Button size="sm" disabled={busy} onClick={() => void toggleSchedule(task)}>{row.record.enabled ? t('暂停日程') : t('恢复日程')}</Button>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>{t('删除日程')}</Button>
          </>
        )}
      </div>
      {status && <p role="status" className="text-[12.5px] text-danger">{status}</p>}
      <Block title={t('每次执行的任务')}><ClampText text={row.task} /></Block>
      {row.origin.reason && <Block title={t('为什么安排')}><p>{row.origin.reason}</p>{row.origin.edited && <p className="text-[12px] text-fg-3">{row.origin.edited}</p>}</Block>}
      {row.history.length > 0 && (
        <Block title={t('执行与投递记录 · {length}', { length: row.history.length })}>
          <ul className="space-y-1">
            {row.history.slice(0, 12).map((item: Occurrence) => (
              <li key={item.key} className={cn('flex flex-wrap items-center gap-2 text-[12.5px]', ['failed', 'needs_review'].includes(item.status) ? 'text-danger' : 'text-fg-2')}>
                <time className="tabular-nums text-fg-3">{fullTime(item.scheduledAt)}</time>
                <span>{occurrenceText(item)}</span>
                {item.deliveredAt && item.key && <button type="button" onClick={() => onOpenDelivery(item.key)} className="rounded-md px-1.5 text-accent-text hover:bg-hover">{t('查看交付')}</button>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      <ScheduleEditor open={editing} record={row.record} project={project} defaults={data?.defaults} busy={busy}
        onClose={() => setEditing(false)} onSave={(body, record) => mutate(record?.id, 'PATCH', body).then(failed => { if (!failed) setEditing(false); return failed })} />
    </div>
  )
}

/**
 * 新建日程 for one project: the same editor, empty. Until the project is read, the dialog says so (never a silent no-op);
 * 重试 shows the read in progress, and a read that fails again says how many times it was retried.
 */
export function ScheduleCreator({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { project, error, loading, reload, data, busy, mutate } = useSchedules(projectId)
  const [retries, setRetries] = useState(0)
  if (!project) {
    const failed = Boolean(error) && !loading
    return (
      <Dialog open onOpenChange={o => { if (!o) onClose() }} title={t('新建补充任务')}
        footer={error ? <><Button variant="ghost" onClick={onClose}>{t('取消')}</Button><Button variant="primary" disabled={loading} onClick={() => { setRetries(n => n + 1); void reload() }}>{loading ? t('正在读取…') : t('重试')}</Button></> : undefined}>
        {failed ? <p role="status" className="text-[12.5px] text-danger">{t('项目读取失败：{message}', { message: error! })}{retries > 0 ? t('（已重试 {n} 次）', { n: retries }) : ''}</p> : <ListSkeleton rows={3} />}
      </Dialog>
    )
  }
  return <ScheduleEditor open record={null} project={project} defaults={data?.defaults} busy={busy} onClose={onClose}
    onSave={(body) => mutate(undefined, 'POST', body).then(failed => { if (!failed) { onClose(); toast(t('已新建日程。')) } return failed })} />
}

function localDateTimeValue(iso?: string) {
  const local = new Date(iso ?? Date.now() + 3_600_000)
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function ScheduleEditor({ open, record, project, defaults, busy, onClose, onSave }: {
  open: boolean; record: Schedule | null; project: ProjectDetail; defaults?: { time: string; timeZone: string }; busy: boolean
  onClose: () => void; onSave: (body: Record<string, unknown>, record: Schedule | null) => Promise<string | null>
}) {
  const sessionIndex = useApp(s => s.sessionIndex)
  const sessions = Object.values(sessionIndex).filter(s => s.projectId === project.id && !s.archivedAt)
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [title, setTitle] = useState('')
  const [task, setTask] = useState('')
  const [kind, setKind] = useState('daily')
  const [clock, setClock] = useState('09:00')
  const [zone, setZone] = useState(localZone)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [minutes, setMinutes] = useState(1440)
  const [at, setAt] = useState(localDateTimeValue())
  const [destination, setDestination] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState('')
  const request = useRef<{ payload: string; id: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle(record?.title ?? ''); setTask(record?.task ?? ''); setKind(record?.rule.kind ?? 'daily')
    setClock(record?.rule.time ?? defaults?.time ?? '09:00'); setZone(record?.rule.timeZone ?? defaults?.timeZone ?? localZone)
    setDays(record?.rule.days ?? [1, 2, 3, 4, 5]); setMinutes(record?.rule.everyMs ? record.rule.everyMs / 60000 : 1440)
    setAt(localDateTimeValue(record?.rule.at)); setDestination(record?.destinationSessionId ?? project.primarySessionId ?? sessions[0]?.id ?? '')
    setEnabled(record?.enabled !== false); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!title.trim() || !task.trim() || !destination) { setError(t('请填写日程名称、任务和投递会话。')); return }
    const rule = kind === 'interval' ? { kind: 'interval', everyMs: Number(minutes) * 60000, ...(record?.rule.kind === 'interval' ? { anchorAt: record.rule.anchorAt } : {}) }
      : kind === 'once' ? { kind: 'once', at: new Date(at).toISOString() }
        : { kind, time: clock, timeZone: zone.trim(), ...(kind === 'weekly' ? { days: [...days].sort() } : {}) }
    if (kind === 'weekly' && !days.length) { setError(t('每周日程至少选择一天。')); return }
    if (kind === 'interval' && (!Number.isFinite(minutes) || minutes < 5)) { setError(t('间隔最少 5 分钟。')); return }
    const body = { title: title.trim(), task: task.trim(), destinationSessionId: destination, enabled, rule }
    const payload = JSON.stringify(body)
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() }
    setError('')
    // A refused save (a time already past, an unknown time zone, the schedule limit …) is said here, in the dialog.
    const failed = await onSave(record ? body : { ...body, requestId: request.current.id }, record)
    if (failed) setError(failed)
    else request.current = null
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onClose() }} title={record ? t('编辑日程') : t('新建补充任务')}
      description={t('执行仍受项目开关、权限和预算约束。暂停主动发言时日程也暂停：到点的执行会跳过，恢复后只补跑最近一次（一个周期内）；已经开始的会做完，并安静地放进收件箱。不补跑所有错过时刻；改名不影响正在执行的那次，间隔日程编辑时保留原锚点。')}
      footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{t('取消编辑')}</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{t('保存日程')}</Button></>}>
      <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
        <Field label={t('日程名称')}><TextInput autoFocus value={title} maxLength={160} onChange={e => setTitle(e.target.value)} /></Field>
        <Field label={t('每次执行的任务')}><TextArea rows={4} maxLength={6000} value={task} onChange={e => setTask(e.target.value)} /></Field>
        <Field label={t('执行方式')}>
          <Select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="daily">{t('每天')}</option><option value="weekly">{t('每周')}</option><option value="interval">{t('固定间隔')}</option><option value="once">{t('仅一次')}</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('执行时间（24 小时）')} hidden={!['daily', 'weekly'].includes(kind)}><TextInput type="time" value={clock} onChange={e => setClock(e.target.value)} /></Field>
          <Field label={t('时区（IANA 名称）')} hidden={!['daily', 'weekly'].includes(kind)}><TextInput value={zone} maxLength={100} placeholder="Asia/Shanghai" onChange={e => setZone(e.target.value)} /></Field>
        </div>
        {kind === 'weekly' && (
          <fieldset>
            <legend className="mb-1.5 text-[12.5px] font-medium text-fg-2">{t('执行日期')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, i) => {
                const on = days.includes(i + 1)
                return <button key={d} type="button" aria-pressed={on} onClick={() => setDays(v => (on ? v.filter(x => x !== i + 1) : [...v, i + 1]))} className={cn('h-8 rounded-lg px-2.5 text-[12.5px] transition-colors', on ? 'bg-accent-soft text-accent-text' : 'bg-subtle text-fg-3 hover:text-fg')}>{t('周{d}', { d })}</button>
              })}
            </div>
          </fieldset>
        )}
        <Field label={t('间隔（分钟，最少 5 分钟）')} hidden={kind !== 'interval'}><TextInput type="number" min={5} max={527040} step={1} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></Field>
        <Field label={t('执行时刻（本机时区 {localZone}）', { localZone })} hidden={kind !== 'once'}><TextInput type="datetime-local" value={at} min={localDateTimeValue(new Date().toISOString())} onChange={e => setAt(e.target.value)} /></Field>
        <Field label={t('结果投递到')}>
          <Select value={destination} onChange={e => setDestination(e.target.value)}>
            {sessions.map(s => <option key={s.id} value={s.id}>{s.title || t('项目会话')}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-fg-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="size-4 accent-[var(--accent)]" />{t('启用此日程')}</label>
      </div>
      {/* Outside the scrolling form, so a refusal is seen without scrolling. */}
      {error && <p role="status" className="mt-3 text-[12.5px] text-danger">{error}</p>}
    </Dialog>
  )
}

/* ------------------------------------------------------ delivery reader */

function DeliveryReader({ project, scheduleId, occurrenceKey }: { project: ProjectDetail; scheduleId: string; occurrenceKey: string }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; item: Item; sessionId: string; sessionTitle: string; archived: boolean; occurrence: Occurrence }>({ status: 'loading' })
  const occurrences = project.scheduleRuntime?.occurrences ?? []
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    const occurrence = deliveredOccurrence(occurrences, scheduleId, occurrenceKey)
    if (!occurrence) { setState({ status: 'unavailable' }); return }
    const app = useApp.getState()
    const destination = project.schedules?.find(s => s.id === scheduleId)?.destinationSessionId
    const candidates = Object.values(app.sessionIndex).filter(s => s.projectId === project.id).sort((a, b) => Number(b.id === destination) - Number(a.id === destination))
    void (async () => {
      const found: { item: Item; sessionId: string }[] = []
      for (const summary of candidates) {
        const slice = app.sessions[summary.id]
        let items: Item[]
        // A conversation held whole (a daemon without windows, or every page read) is searched where it is.
        if (slice && !slice.window?.hasMore) items = slice.order.map(id => slice.items[id])
        else if (app.mode !== 'v2') {
          try { items = (await loadSession(summary.id, app.mode ?? 'legacy')).items } catch { continue }
        } else {
          // B9: conversations open on their tail window, and a delivery can be older than it: the host reads the item the
          // occurrence names, else finds the line the occurrence posted (GET …/locate).
          try {
            const id = occurrence.deliveryItemId ?? await locateRun(summary.id, { occurrenceKey: occurrence.key })
            const item = id ? await loadItem(summary.id, id) : null
            items = item ? [item] : []
          } catch { continue }
        }
        for (const item of matchDelivery(items, { projectId: project.id, scheduleId, occurrence })) found.push({ item, sessionId: summary.id })
        if (cancelled) return
        // An item id names one item: the conversations after the one holding it cannot hold it too.
        if (occurrence.deliveryItemId && found.length) break
      }
      if (cancelled) return
      if (found.length !== 1) { setState({ status: 'unavailable' }); return }
      const s = useApp.getState().sessionIndex[found[0].sessionId]
      setState({ status: 'ready', item: found[0].item, sessionId: found[0].sessionId, sessionTitle: s?.title || t('项目会话'), archived: Boolean(s?.archivedAt), occurrence })
    })()
    return () => { cancelled = true }
  }, [project.id, scheduleId, occurrenceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = project.schedules?.find(s => s.id === scheduleId)?.title || t('任务交付')
  return (
    <article>
      <h3 className="text-[16px] font-semibold leading-[1.5] text-fg">{title}</h3>
      {state.status === 'loading' && <ListSkeleton rows={2} />}
      {state.status === 'unavailable' && <p className="mt-3 text-[13px] leading-[1.7] text-fg-3">{t('这次交付的原始内容已删除或无法关联，执行记录仍保留。')}</p>}
      {state.status === 'ready' && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-3">
            <Badge tone="accent">{t('定时交付')}</Badge>
            <time>{fullTime(state.occurrence.deliveredAt)}</time>
            <span>{state.sessionTitle}{state.archived ? t(' · 已归档') : ''}</span>
            {/* Opens the conversation at this delivery, highlighted (not at its bottom). */}
            {!state.archived && <button type="button" className="ml-auto rounded-md px-1.5 py-0.5 text-accent-text hover:bg-hover" onClick={() => void openSessionItem(state.sessionId, state.item.id)}>{t('在会话中查看')}</button>}
          </div>
          <Markdown text={state.item.text} className="mt-4" />
        </>
      )}
    </article>
  )
}
