/**
 * Sidebar 任务: every project's running, scheduled and to-review work in one
 * short list right below search, with quick controls on hover/focus and an
 * entry to the full 任务 page. Replaces the per-project 任务 tab. A running,
 * queued or paused row opens its card in the 后台任务 panel (design 2.5); a
 * schedule opens the 任务 page, where it is edited.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlarmClock, Check, ListFilter, SquareArrowOutUpRight } from 'lucide-react'
import type { TaskEntry } from '@/lib/tasks'
import { needsUser, sidebarTaskGroups } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { useGlobalTasks, useTasks } from '@/store/tasks-store'
import { openTasks, setTasksCollapsed, useUi, type TasksTab } from '@/store/ui-store'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/components/ui/overlays'
import { Skeleton, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { openTasksPanel } from '@/components/workspace/tasks-panel'
import { QuickControlButtons, TaskGlyph, TaskMenu, openTaskDetail } from './task-parts'
import { useLiveTasks } from './live-tasks'
import { t as tr } from '@/i18n'
import { useMindHints } from '@/components/mind/useMindHints'
import { askOwed } from '@/store/mind-store'
import { owedSummary } from '@/lib/mind'

const VISIBLE = 5
/** Rows whose card lives in the 后台任务 panel (the sidebar's 进行中). */
const PANEL_STATES = new Set<TaskEntry['state']>(['running', 'queued', 'paused'])

/** Where a row leads: live work to its card in the panel, anything else to the 任务 page. */
export function openSidebarTask(task: TaskEntry) {
  if (task.kind === 'action' && PANEL_STATES.has(task.state)) openTasksPanel({ focusRunId: task.key, projectId: task.projectId })
  else openTaskDetail(task)
}

export function SidebarTasks({ onNavigate }: { onNavigate?: () => void }) {
  // The same entries as the 后台任务 panel and the top bar badge, so 进行中 counts alike everywhere.
  const all = useLiveTasks()
  const loaded = useTasks(s => s.loaded)
  const collapsed = useUi(s => s.tasksCollapsed)
  const filter = useUi(s => s.taskFilter)
  const onPage = useUi(s => s.view === 'tasks')
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)

  const search = useUi(s => s.search.trim().toLowerCase())
  // The header counts what the list below shows: the same project filter and search.
  const shown = useMemo(() => all.filter(t => (filter === 'all' || t.projectId === filter) && (!search || `${t.title} ${t.projectName}`.toLowerCase().includes(search))), [all, filter, search])
  const groups = useMemo(() => sidebarTaskGroups(shown), [shown])
  // 进行中 by default while background work runs, else 日程; the user's pick sticks.
  const [picked, setPicked] = useState<'active' | 'schedules' | null>(null)
  const tab = picked ?? (groups.active.length ? 'active' : 'schedules')
  const tasks = groups[tab]
  // Real work only; overdue promises fold into one quiet row (agenda questions live in the mind panel / conversation).
  const allHints = useMindHints()
  const owed = useMemo(() => owedSummary(allHints.filter(h => filter === 'all' || h.projectId === filter)), [allHints, filter])
  // To review / failed work is not listed here (it lives on the 任务 page): its badge opens it there. It counts over the
  // page's entries (finished work included), so the badge, the page's 需要你 and the panel's 需要你 agree.
  const withEnded = useGlobalTasks({ ended: true })
  const waiting = useMemo(() => withEnded.filter(t => (t.kind === 'action' || t.kind === 'schedule') && needsUser(t) && (filter === 'all' || t.projectId === filter) && (!search || `${t.title} ${t.projectName}`.toLowerCase().includes(search))), [withEnded, filter, search])
  const filterName = filter === 'all' ? null : projects[filter]?.name
  const withTasks = projectOrder.filter(id => !projects[id]?.archivedAt && all.some(t => t.projectId === id))
  // A filter on a project that is gone, archived or has nothing left would strand the list on 「X 暂无任务」.
  useEffect(() => {
    if (filter !== 'all' && loaded && (!projects[filter] || projects[filter].archivedAt || !all.some(t => t.projectId === filter))) useUi.setState({ taskFilter: 'all' })
  }, [filter, loaded, projects, all])

  const open = (tasksTab?: TasksTab) => { openTasks(filter, null, tasksTab); onNavigate?.() }
  const openWaiting = () => {
    if (waiting.length === 1) openTaskDetail(waiting[0])
    else openTasks(filter, null, waiting.some(t => t.kind !== 'schedule') ? 'adhoc' : 'schedules')
    onNavigate?.()
  }

  return (
    <section aria-labelledby="sidebar-tasks-heading" className="px-2 pt-4">
      <div className="group/h flex h-7 items-center gap-1 pl-3 pr-1">
        <button type="button" id="sidebar-tasks-heading" aria-expanded={!collapsed} aria-controls="sidebar-tasks-list" onClick={() => setTasksCollapsed(!collapsed)}
          className="flex min-w-0 items-center gap-1.5 rounded-md text-[13px] font-medium text-fg-4 outline-none transition-colors hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          {tr('任务列表')}
          {groups.active.length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 text-[12px] font-semibold tabular-nums text-accent-text" aria-label={tr('{active} 项进行中', { active: groups.active.length })}><span className="size-1 rounded-full bg-accent" aria-hidden />{groups.active.length}</span>}
          {filterName && <span className="truncate font-normal text-fg-4">· {filterName}</span>}
        </button>
        {waiting.length > 0 && (
          <Tooltip content={tr('{attention} 项需要处理 · 在任务页查看', { attention: waiting.length })}>
            <button type="button" onClick={openWaiting} aria-label={tr('{attention} 项需要处理 · 在任务页查看', { attention: waiting.length })}
              className="rounded-full bg-warning-soft px-1.5 text-[12px] font-semibold tabular-nums text-warning-text outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{waiting.length}</button>
          </Tooltip>
        )}
        <span className="flex-1" />
        {(withTasks.length > 1 || filter !== 'all') && (
          <Menu>
            <Tooltip content={tr('按项目筛选')}>
              <MenuTrigger asChild>
                <button type="button" aria-label={tr('按项目筛选任务')} className={cn('grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active', filter === 'all' ? 'text-fg-4' : 'text-accent-text')}>
                  <ListFilter className="size-3.5" />
                </button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" className="w-48">
              <MenuLabel>{tr('显示任务')}</MenuLabel>
              <MenuItem icon={filter === 'all' ? <Check /> : <span />} hint={all.length || undefined} onSelect={() => useUi.setState({ taskFilter: 'all' })}>{tr('全部项目')}</MenuItem>
              {withTasks.map(id => (
                <MenuItem key={id} icon={filter === id ? <Check /> : <span />} hint={all.filter(t => t.projectId === id).length} onSelect={() => useUi.setState({ taskFilter: id })}>{projects[id]?.name}</MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <Tooltip content={tr('打开任务管理')}>
          <button type="button" onClick={() => open()} aria-label={tr('打开任务管理')} aria-current={onPage ? 'page' : undefined}
            className={cn('grid size-6 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', onPage ? 'bg-active text-fg' : 'text-fg-4')}>
            <SquareArrowOutUpRight className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div id="sidebar-tasks-list" key="list" className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
            {(groups.active.length > 0 || groups.schedules.length > 0) && (
              <div role="tablist" aria-label={tr('任务类型')} className="flex gap-1 px-2 pb-1 pt-0.5">
                {(['active', 'schedules'] as const).map(id => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setPicked(id)}
                    className={cn('h-6 rounded-md px-2 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', tab === id ? 'bg-active text-fg' : 'text-fg-4 hover:bg-hover hover:text-fg-2')}>
                    {id === 'active' ? tr('进行中') : tr('日程')}<span className="ml-1 tabular-nums text-fg-4">{groups[id].length}</span>
                  </button>
                ))}
              </div>
            )}
            {!loaded && all.length === 0 ? (
              <div className="space-y-2 px-3 py-2" aria-hidden><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3.5 w-3/5" /></div>
            ) : tasks.length === 0 ? (owed.count > 0 && !search ? null :
              <p className="px-3 pb-1 pt-1 text-[13.5px] leading-[1.6] text-fg-4">{search ? tr('没有匹配的任务') : filterName ? tr('{filterName} 暂无任务', { filterName }) : (tab === 'active' ? tr('没有正在进行的后台工作') : tr('暂无周期性日程'))}</p>
            ) : (
              <ul className="pt-0.5">
                {tasks.slice(0, VISIBLE).map(task => <SidebarTaskRow key={task.key} task={task} showProject={filter === 'all'} onNavigate={onNavigate} />)}
                {tasks.length > VISIBLE && (
                  <li>
                    <button type="button" onClick={() => open(tab === 'schedules' ? 'schedules' : 'adhoc')} className="flex h-7 w-full items-center rounded-lg pl-9 text-left text-[13.5px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
                      {tr('查看全部 {length} 项', { length: tasks.length })}
                    </button>
                  </li>
                )}
              </ul>
            )}
            {owed.count > 0 && owed.projectId && !search && <OwedRow count={owed.count} projectId={owed.projectId} onNavigate={onNavigate} />}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

const SidebarTaskRow = memo(function SidebarTaskRow({ task, showProject, onNavigate }: { task: TaskEntry; showProject: boolean; onNavigate?: () => void }) {
  const busy = useTasks(s => s.busy === task.key)
  const meta = [showProject ? task.projectName : null, task.stateLabel].filter(Boolean).join(' · ')
  return (
    <li>
      <div className={cn('group relative flex items-center rounded-lg transition-colors duration-150 focus-within:bg-hover hover:bg-hover', busy && 'opacity-60')}>
        <button type="button" onClick={() => { openSidebarTask(task); onNavigate?.() }}
          aria-label={tr('{title}，{meta}{v}', { title: task.title, meta, v: task.when ? tr('，{when}', { when: task.when }) : '' })}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg py-[7px] pl-3 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          <TaskGlyph state={task.state} className="mt-[1.5px]" />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-[14.5px] leading-[18px]', task.state === 'disabled' ? 'text-fg-3' : 'text-fg-2 group-hover:text-fg')}>{task.title}</span>
            <span className="flex items-baseline gap-2 text-[13px] leading-[16px]">
              <span className={cn('min-w-0 flex-1 truncate', task.state === 'review' || task.state === 'failed' ? 'text-warning-text' : task.state === 'running' ? 'text-accent-text' : 'text-fg-4')}>{meta}</span>
              {task.state !== 'review' && <span className="shrink-0 tabular-nums text-fg-4">{task.when}</span>}
            </span>
          </span>
        </button>
        {/* Overlaid, so revealing controls never shifts the row. */}
        <div className="pointer-events-none absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-[var(--bg-sidebar)] opacity-0 transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
          <span className="flex items-center gap-0.5 rounded-md bg-hover">
            <QuickControlButtons task={task} />
            <TaskMenu task={task} />
          </span>
        </div>
      </div>
    </li>
  )
})

/** One quiet row for overdue promises (Rna 欠你 N 件事) → the project conversation, where each is asked above the composer; never one row per item. */
const OwedRow = memo(function OwedRow({ count, projectId, onNavigate }: { count: number; projectId: string; onNavigate?: () => void }) {
  const label = tr('Rna 欠你 {n} 件事', { n: count })
  return (
    <div className="pt-0.5">
      <Tooltip content={tr('Rna 答应过但已逾期的事：点开会进入项目对话，在输入框上方决定接着做还是不用了')}>
        <button type="button" onClick={() => { void askOwed(projectId); onNavigate?.() }} aria-label={label}
          className="group flex h-7 w-full min-w-0 items-center gap-2.5 rounded-lg pl-3 pr-2 text-left text-[13.5px] text-fg-3 outline-none transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          <AlarmClock className="size-4 shrink-0 text-fg-4 group-hover:text-fg-3" strokeWidth={1.8} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </Tooltip>
    </div>
  )
})

