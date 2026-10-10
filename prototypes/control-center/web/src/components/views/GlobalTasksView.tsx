/**
 * 任务: one task manager for what the agent does on its own, OmniFocus-style.
 * 临时任务 lists agent-initiated work, 自主学习 (evolution generations),
 * planning and outreach, grouped by project; 项目日程 is a forecast of
 * schedules by next run. Every row carries a status circle and automatic
 * marks (需要你 / 未完成 / 已错过 / 新结果); the inspector on the
 * right holds controls, results and records.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BrushCleaning, ChevronDown, ChevronRight, FolderOpen, Plus } from 'lucide-react'
import { adhocSplit, badgeCount, BUCKET_LABELS, byOpen, cleanupRows, failedOpen, needsUser, planOpen, SCHEDULE_BUCKETS, scheduleBucket, taskEnded, type TaskEntry } from '@/lib/tasks'
import { stripHandoffMarker } from '@/lib/task-failure'
import { useApp } from '@/store/app-store'
import { useGlobalTasks, useLearningSync, useTasks } from '@/store/tasks-store'
import { useUi, type TasksTab } from '@/store/ui-store'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { Button, SegmentedTabs } from '@/components/ui/primitives'
import { FailedAnswerButtons, QuickControlButtons, TaskCircle, TaskFlags, TaskMenu } from '@/components/tasks/task-parts'
import { CleanupDialog } from '@/components/tasks/CleanupDialog'
import { cn } from '@/lib/utils'
import { Empty, ListSkeleton, SplitView } from './kit'
import { ActionInspector, LearningInspector, PlanInspector, ProjectInspector, ScheduleCreator, ScheduleInspector } from './task-inspectors'
import { t } from '@/i18n'

type Selection = { kind: 'task'; key: string; occurrenceKey: string | null } | { kind: 'project'; projectId: string } | null

const byRecent = (a: TaskEntry, b: TaskEntry) => (b.at ?? 0) - (a.at ?? 0) || a.key.localeCompare(b.key)

export function GlobalTasksView() {
  useLearningSync()
  const tasks = useGlobalTasks({ ended: true })
  const loaded = useTasks(s => s.loaded)
  const tab = useUi(s => s.tasksTab)
  const chosen = useUi(s => s.tasksProject)
  const focus = useUi(s => s.tasksFocus)
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)
  const live = useMemo(() => projectOrder.filter(id => projects[id] && !projects[id].archivedAt && (projects[id] as { simulated?: boolean }).simulated !== true), [projectOrder, projects])
  const scope = chosen !== 'all' && projects[chosen] ? chosen : 'all'
  const inScope = useMemo(() => tasks.filter(task => scope === 'all' || task.projectId === scope), [tasks, scope])
  const adhoc = useMemo(() => inScope.filter(task => task.kind !== 'schedule'), [inScope])
  const schedules = useMemo(() => inScope.filter(task => task.kind === 'schedule'), [inScope])

  const [selection, setSelection] = useState<Selection>(null)
  useEffect(() => { if (focus) setSelection({ kind: 'task', key: focus.key, occurrenceKey: focus.occurrenceKey ?? null }) }, [focus])
  // A selection belongs to one tab: switching tabs drops a task from the other one.
  useEffect(() => { setSelection(current => (current?.kind === 'task' && current.key.includes(':schedule:') !== (tab === 'schedules') ? null : current)) }, [tab])
  const selectedTask = selection?.kind === 'task' ? tasks.find(task => task.key === selection.key) ?? null : null
  const close = () => { setSelection(null); useUi.setState({ tasksFocus: null }) }
  const select = (task: TaskEntry) => setSelection(current => (current?.kind === 'task' && current.key === task.key ? null : { kind: 'task', key: task.key, occurrenceKey: null }))

  const openCount = badgeCount(adhoc)
  const tabs: { id: TasksTab; label: string; badge?: number }[] = [
    { id: 'adhoc', label: t('临时任务'), badge: openCount || undefined },
    { id: 'schedules', label: t('项目日程'), badge: schedules.length || undefined },
  ]

  const detail = selection?.kind === 'project' ? <ProjectInspector projectId={selection.projectId} />
    : selectedTask?.kind === 'action' ? <ActionInspector task={selectedTask} />
      : selectedTask?.kind === 'learning' ? <LearningInspector task={selectedTask} />
      : selectedTask?.kind === 'plan' ? <PlanInspector task={selectedTask} />
        : selectedTask?.kind === 'schedule' ? <ScheduleInspector task={selectedTask} occurrenceKey={selection?.kind === 'task' ? selection.occurrenceKey : null}
          onOpenDelivery={key => setSelection({ kind: 'task', key: selectedTask.key, occurrenceKey: key })} onRemoved={close} />
          : null
  const detailLabel = selection?.kind === 'project' ? projects[selection.projectId]?.name ?? t('项目') : selectedTask?.label ?? t('任务详情')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label={t('任务视图')} className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint px-3 sm:px-5">
        <SegmentedTabs items={tabs} value={tab} onChange={id => useUi.setState({ tasksTab: id })} layoutId="tasks-tab" />
        <ProjectFilter className="ml-auto" value={scope} ids={live} tasks={tasks} onChange={id => { useUi.setState({ tasksProject: id, tasksFocus: null }); setSelection(null) }} />
      </nav>
      <SplitView detailLabel={detailLabel} onClose={close} detail={detail}
        list={
          <div className="mx-auto w-full max-w-[880px] px-3 pb-16 pt-5 sm:px-6">
            {tab === 'adhoc'
              ? <AdhocList tasks={adhoc} loaded={loaded} ids={scope === 'all' ? live : [scope]} allProjects={scope === 'all'} selection={selection} onSelect={select} onSelectProject={id => setSelection(current => (current?.kind === 'project' && current.projectId === id ? null : { kind: 'project', projectId: id }))} />
              : <ScheduleList tasks={schedules} loaded={loaded} scope={scope} ids={live} selection={selection} onSelect={select} />}
          </div>
        } />
    </div>
  )
}

function ProjectFilter({ value, ids, tasks, onChange, className }: { value: string; ids: string[]; tasks: TaskEntry[]; onChange: (id: string) => void; className?: string }) {
  const projects = useApp(s => s.projects)
  const count = (id: string) => badgeCount(tasks.filter(task => task.projectId === id))
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={cn('inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active', className)}>
          <FolderOpen className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.8} />
          <span className="truncate">{value === 'all' ? t('全部项目') : projects[value]?.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-56">
        <MenuItem onSelect={() => onChange('all')} hint={value === 'all' ? '✓' : undefined}>{t('全部项目')}</MenuItem>
        <MenuSeparator />
        <MenuLabel>{t('项目')}</MenuLabel>
        {ids.map(id => <MenuItem key={id} onSelect={() => onChange(id)} hint={value === id ? '✓' : count(id) || undefined}><span className="truncate">{projects[id]?.name}</span></MenuItem>)}
      </MenuContent>
    </Menu>
  )
}

function PageHead({ title, line, action }: { title: string; line: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-4 flex items-end gap-3 px-1.5">
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
        <p className="mt-0.5 text-[12.5px] text-fg-3">{line}</p>
      </div>
      {action}
    </header>
  )
}

/* ------------------------------------------------------------ 临时任务 */

function AdhocList({ tasks, loaded, ids, allProjects, selection, onSelect, onSelectProject }: {
  tasks: TaskEntry[]; loaded: boolean; ids: string[]; allProjects: boolean; selection: Selection; onSelect: (task: TaskEntry) => void; onSelectProject: (id: string) => void
}) {
  const projects = useApp(s => s.projects)
  const { open, ended } = adhocSplit(tasks)
  const running = open.filter(task => task.state === 'running' || task.state === 'queued').length
  // The sidebar's count: a failed run already answered (接着做 / 不用了) or a result marked 知道了 no longer needs the user.
  const attention = open.filter(needsUser).length
  const today = ended.filter(task => task.state === 'done' && task.at !== null && new Date(task.at).toDateString() === new Date().toDateString()).length
  const line = [t('进行中 {n}', { n: running }), attention ? t('需要你 {n}', { n: attention }) : null, t('今天完成 {n}', { n: today })].filter(Boolean).join(' · ')
  const groups = ids.map(id => ({ id, name: projects[id]?.name ?? id, tasks: tasks.filter(task => task.projectId === id) }))
  const shown = groups.filter(group => group.tasks.length || ids.length === 1)
  const quiet = groups.length - shown.length
  // 清理…: one dialog for the page, opened from 全部项目's button or a project's. It lives here, not with the button: the
  // rows it settles leave the list as it goes, and the button (or the whole group) with them, while it still reports.
  const [cleanup, setCleanup] = useState<CleanupTarget & { open: boolean }>({ open: false, rows: [], title: '', showProject: false })
  const openCleanup = (target: CleanupTarget) => setCleanup({ ...target, open: true })
  return (
    <>
      <PageHead title={t('临时任务')} line={line} action={allProjects && <CleanupButton rows={tasks} title={t('清理全部项目')} showProject onOpen={openCleanup} />} />
      {!loaded && !tasks.length ? <ListSkeleton rows={4} /> : !shown.length ? <Empty>{t('还没有 Agent 自己发起的工作。它会根据项目和对话判断下一步。')}</Empty> : shown.map(group => (
        <ProjectGroup key={group.id} id={group.id} name={group.name} tasks={group.tasks} selection={selection} onSelect={onSelect} onCleanup={openCleanup}
          selected={selection?.kind === 'project' && selection.projectId === group.id} onSelectProject={() => onSelectProject(group.id)} />
      ))}
      {quiet > 0 && <p className="mt-6 px-1.5 text-[12px] text-fg-4">{t('另有 {n} 个项目暂无任务', { n: quiet })}</p>}
      <CleanupDialog open={cleanup.open} onClose={() => setCleanup(current => ({ ...current, open: false }))} rows={cleanup.rows} title={cleanup.title} showProject={cleanup.showProject} />
    </>
  )
}

function ProjectGroup({ id, name, tasks, selection, selected, onSelect, onSelectProject, onCleanup }: {
  id: string; name: string; tasks: TaskEntry[]; selection: Selection; selected: boolean; onSelect: (task: TaskEntry) => void; onSelectProject: () => void; onCleanup: (target: CleanupTarget) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { open, ended } = adhocSplit(tasks)
  // Fresh results stay in view; older finished work folds under 已完成, as a logbook.
  const recent = ended.filter(task => task.flags.includes('fresh')).sort(byRecent).slice(0, 3)
  const rest = ended.filter(task => !recent.includes(task)).sort(byRecent)
  const rows = [...open.sort(byOpen), ...recent]
  return (
    <section className="mt-5 first-of-type:mt-0" data-project-id={id}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onSelectProject} aria-pressed={selected}
          className={cn('group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', selected ? 'bg-active' : 'hover:bg-hover')}>
          <FolderOpen className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.8} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-fg">{name}</span>
          <span className="text-[12px] tabular-nums text-fg-4">{badgeCount(tasks) || ''}</span>
          <span className="ml-auto truncate text-[12px] text-fg-4 opacity-0 transition-opacity group-hover:opacity-100">{t('节奏与设置')}</span>
        </button>
        <CleanupButton rows={tasks} title={t('清理「{name}」', { name })} onOpen={onCleanup} />
      </div>
      <ul className="mt-0.5">
        {rows.map(task => <TaskRow key={task.key} task={task} selected={selection?.kind === 'task' && selection.key === task.key} onSelect={() => onSelect(task)} />)}
        {!rows.length && <li className="py-1.5 pl-[38px] text-[12.5px] text-fg-4">{t('没有进行中的事')}</li>}
        {rest.length > 0 && (
          <li>
            <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
              className="flex items-center gap-1 rounded-md py-1.5 pl-[34px] pr-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
              <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
              {t('已完成 {n}', { n: rest.length })}
            </button>
          </li>
        )}
        {expanded && rest.slice(0, 40).map(task => <TaskRow key={task.key} task={task} selected={selection?.kind === 'task' && selection.key === task.key} onSelect={() => onSelect(task)} />)}
      </ul>
    </section>
  )
}

/** One row: status circle, title, a quiet meta line, automatic marks, and controls on hover. */
function TaskRow({ task, selected, onSelect, meta }: { task: TaskEntry; selected: boolean; onSelect: () => void; meta?: (string | null | undefined)[] }) {
  const busy = useTasks(s => s.busy === task.key)
  const ended = taskEnded(task)
  const note = task.kind === 'schedule' ? null : task.summary?.split('\n').map(line => stripHandoffMarker(line).trim()).find(Boolean)
  const parts = (meta ?? [task.label, task.when, note]).filter((part): part is string => Boolean(part))
  // A plan line still ahead gets 标记完成 / 不再做 on hover and in its menu; a done one is the plan's record.
  const controls = task.kind === 'action' || task.kind === 'schedule' || planOpen(task)
  return (
    <li className={cn('group relative flex items-start gap-2.5 rounded-lg py-[7px] pl-2.5 pr-1.5 transition-colors', selected ? 'bg-active' : 'hover:bg-hover', busy && 'opacity-60')}>
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`${task.title} · ${task.stateLabel}`}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" />
      <TaskCircle state={task.state} className="pointer-events-none mt-[3px]" />
      <span className="pointer-events-none min-w-0 flex-1">
        <span className={cn('block truncate text-[13.5px] leading-[1.5]', ended ? 'text-fg-3' : 'text-fg')}>{task.title}</span>
        {parts.length > 0 && (
          <span className="mt-px flex min-w-0 items-center gap-1.5 text-[12px] leading-[1.5] text-fg-4">
            {parts.map((part, index) => (
              <span key={index} className={cn('flex min-w-0 items-center gap-1.5', index === parts.length - 1 ? 'min-w-0' : 'shrink-0')}>
                {index > 0 && <span aria-hidden>·</span>}
                <span className={cn(index === parts.length - 1 && 'truncate', 'tabular-nums')}>{part}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      <TaskFlags flags={task.flags} className="pointer-events-none mt-px" />
      {/* A failed run that waits on the user is answered right here, in view (not only in ⋯). */}
      {failedOpen(task) && <FailedAnswerButtons task={task} className="relative z-[1] -my-px" />}
      {controls && (
        <span className="relative z-[1] flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <QuickControlButtons task={task} />
          <TaskMenu task={task} showDetail={false} />
        </span>
      )}
    </li>
  )
}

/** What 清理… is opened over: some tasks (it lists their failed work still waiting on the user and open plan lines). */
type CleanupTarget = { rows: TaskEntry[]; title: string; showProject: boolean }

/** 清理…: shown while these tasks have failed work still waiting on the user or open plan lines; opens the page's dialog over them. */
function CleanupButton({ rows, title, showProject = false, onOpen }: { rows: TaskEntry[]; title: string; showProject?: boolean; onOpen: (target: CleanupTarget) => void }) {
  const count = useMemo(() => { const { actions, plan } = cleanupRows(rows); return actions.length + plan.length }, [rows])
  if (!count) return null
  return (
    <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-fg-3" leading={<BrushCleaning className="size-3.5" />}
      aria-label={t('{title}：{n} 项没做完', { title, n: count })} onClick={() => onOpen({ rows, title, showProject })}>
      {t('清理…')}
    </Button>
  )
}

/* ------------------------------------------------------------ 项目日程 */

function ScheduleList({ tasks, loaded, scope, ids, selection, onSelect }: {
  tasks: TaskEntry[]; loaded: boolean; scope: string; ids: string[]; selection: Selection; onSelect: (task: TaskEntry) => void
}) {
  const [creating, setCreating] = useState<string | null>(null)
  const projects = useApp(s => s.projects)
  const buckets = SCHEDULE_BUCKETS.map(bucket => ({ bucket, rows: tasks.filter(task => scheduleBucket(task) === bucket).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.key.localeCompare(b.key)) })).filter(group => group.rows.length)
  const next = tasks.filter(task => task.state === 'scheduled' && task.at !== null && !task.flags.includes('overdue')).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0]
  const line = next ? t('下一次：{title} · {when}', { title: next.title, when: next.when }) : t('Agent 会根据项目自己安排，也可以手动补充。')
  const add = scope !== 'all'
    ? <Button size="sm" variant="ghost" leading={<Plus className="size-3.5" />} onClick={() => setCreating(scope)}>{t('新建日程')}</Button>
    : (
      <Menu>
        <MenuTrigger asChild><Button size="sm" variant="ghost" leading={<Plus className="size-3.5" />}>{t('新建日程')}</Button></MenuTrigger>
        <MenuContent align="end" className="w-56">
          <MenuLabel>{t('选择项目')}</MenuLabel>
          {ids.map(id => <MenuItem key={id} onSelect={() => setCreating(id)}><span className="truncate">{projects[id]?.name}</span></MenuItem>)}
        </MenuContent>
      </Menu>
    )
  return (
    <>
      <PageHead title={t('项目日程')} line={line} action={add} />
      {!loaded && !tasks.length ? <ListSkeleton rows={4} /> : !buckets.length ? <Empty>{t('还没有日程。Agent 会根据项目和对话判断是否需要定期执行；没有日程不代表主动协作关闭。')}</Empty> : buckets.map(({ bucket, rows }) => (
        <section key={bucket} className="mt-5 first-of-type:mt-0">
          <h3 className={cn('flex items-center gap-2 px-1.5 py-1 text-[12px] font-medium', bucket === 'attention' ? 'text-danger' : 'text-fg-3')}>
            {BUCKET_LABELS[bucket]}<span className="font-normal tabular-nums text-fg-4">{rows.length}</span>
          </h3>
          <ul className="mt-0.5">
            {rows.map(task => (
              <TaskRow key={task.key} task={task} selected={selection?.kind === 'task' && selection.key === task.key} onSelect={() => onSelect(task)}
                meta={[task.when !== task.rule ? task.when : null, task.rule, scope === 'all' ? task.projectName : null]} />
            ))}
          </ul>
        </section>
      ))}
      {creating && <ScheduleCreator projectId={creating} onClose={() => setCreating(null)} />}
    </>
  )
}
