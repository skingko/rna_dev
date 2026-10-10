/**
 * 后台任务 panel (design 2.1, 2.4; Claude desktop's background task panel):
 * 运行中 as cards with live progress, 排队与即将运行 and 已完成 (24 h) as
 * compact rows, filtered to the current project or all of them. Reads the
 * index-stream data the app already holds — no extra stream, no polling; a
 * subagent group's agents are read when its table opens. Lays out by its own
 * width (container queries) from 260 px up.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Layers, MoreHorizontal, RotateCcw, SquareArrowOutUpRight } from 'lucide-react'
import { anyLive, findRun, resolveFilter, type BackgroundRun, type RunSection } from '@/lib/background-runs'
import { failedOpen, needsUser } from '@/lib/tasks'
import { useApp } from '@/store/app-store'
import { useRunClock } from '@/store/background-live'
import { openTasks } from '@/store/ui-store'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlays'
import { CleanupDialog } from '@/components/tasks/CleanupDialog'
import { SegmentedTabs, Skeleton, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { RunCard } from './RunCard'
import { useBackgroundRuns } from './useBackgroundRuns'
import type { BackgroundTasksPanelProps } from './types'

/** How long a run brought into view stays outlined, and how long a row takes to open. */
const FOCUS_MS = 1800, OPEN_MS = 240

export function BackgroundTasksPanel({ projectFilter, focusRunId, currentProjectId, visible = true, onOpenTab, onFilterChange, onFocusApplied }: BackgroundTasksPanelProps) {
  const t = useT()
  const filter = resolveFilter(projectFilter, currentProjectId)
  const { view, loading, clear, restore, countAll } = useBackgroundRuns(filter)
  const now = useRunClock(visible && anyLive(view))
  const projects = useApp(s => s.projects)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [folded, setFolded] = useState<Partial<Record<RunSection, boolean>>>({})
  const [outlined, setOutlined] = useState<string | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const toggle = useCallback((key: string) => setExpanded(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next }), [])
  // Settled rows read the time once per change of the data; only running cards follow the clock.
  const settled = useMemo(() => Date.now(), [view]) // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useRef(new Map<string, (node: HTMLElement | null) => void>())
  const nodeRef = (key: string) => {
    let fn = refs.current.get(key)
    if (!fn) refs.current.set(key, fn = node => { if (node) nodes.current.set(key, node); else nodes.current.delete(key) })
    return fn
  }

  // Bring the run a sidebar row, a conversation line or the integration points at into view, opened — once it is in the
  // data (it may arrive after the panel opens) and the panel is on screen — then tell the host, which drops the focus.
  const focus = findRun(view, focusRunId)
  const focusKey = focus?.key ?? null, focusSection = focus?.section ?? null
  const applied = useRef(onFocusApplied)
  useEffect(() => { applied.current = onFocusApplied })
  useEffect(() => {
    if (!focusRunId || !focusKey || !focusSection || !visible) return
    setExpanded(current => (current.has(focusKey) ? current : new Set(current).add(focusKey)))
    setFolded(current => ({ ...current, [focusSection]: false }))
    setOutlined(focusKey)
    // Scrolled once the row has opened (its body animates in), so all of it comes into view.
    const scroll = setTimeout(() => {
      nodes.current.get(focusKey)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
      applied.current?.(focusRunId)
    }, OPEN_MS)
    return () => clearTimeout(scroll)
  }, [focusRunId, focusKey, focusSection, visible])
  // The outline fades on its own, also when the host drops the focus meanwhile (the run showed up late).
  useEffect(() => {
    if (!outlined) return
    const timer = setTimeout(() => setOutlined(current => (current === outlined ? null : current)), FOCUS_MS)
    return () => clearTimeout(timer)
  }, [outlined])

  const pinned = filter !== 'all' && filter !== currentProjectId ? projects[filter]?.name : null
  const scopeLabel = pinned ?? t('当前项目')
  const showProject = filter === 'all'
  const empty = !view.attention.length && !view.running.length && !view.upcoming.length && !view.finished.length
  const clearable = useMemo(() => view.finished.filter(run => !(run.task && needsUser(run.task))), [view.finished])
  // 全部不用了: the failed runs in 需要你 (not a result to check: that one is checked first), confirmed in the 任务 page's dialog.
  const failed = useMemo(() => view.attention.flatMap(run => (run.task && failedOpen(run.task) ? [run.task] : [])), [view.attention])
  const [dropping, setDropping] = useState(false)
  const card = (run: BackgroundRun, variant: 'card' | 'row') => (
    <RunCard key={run.key} ref={nodeRef(run.key)} run={run} variant={variant} now={run.state === 'running' ? now : settled}
      expanded={expanded.has(run.key)} onToggle={toggle} focused={outlined === run.key} showProject={showProject} onOpenTab={onOpenTab} />
  )

  return (
    <div className="@container/tasks flex h-full min-h-0 flex-col bg-base" data-tasks-panel>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint pl-3 pr-1.5">
        <h2 className="truncate text-[13px] font-medium text-fg @max-[300px]/tasks:sr-only">{t('后台任务')}</h2>
        {view.counts.active > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 text-[12px] font-semibold tabular-nums text-accent-text" aria-label={t('{active} 项进行中', { active: view.counts.active })}>
            <span className="size-1 rounded-full bg-accent" aria-hidden />{view.counts.active}
          </span>
        )}
        <span className="flex-1" />
        {(currentProjectId || pinned) && (
          <SegmentedTabs layoutId="tasks-panel-filter" className="shrink-0 [&_[role=tab]]:h-6 [&_[role=tab]]:px-2 [&_[role=tab]]:text-[12px]"
            value={filter === 'all' ? 'all' : 'project'}
            onChange={id => onFilterChange(id === 'all' ? 'all' : pinned ? filter : undefined)}
            items={[{ id: 'project', label: <span className="block max-w-[9em] truncate">{scopeLabel}</span> }, { id: 'all', label: t('全部') }]} />
        )}
        <Menu>
          <Tooltip content={t('更多')}>
            <MenuTrigger asChild>
              <button type="button" aria-label={t('后台任务选项')} className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active">
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" className="w-52">
            <MenuItem icon={<SquareArrowOutUpRight />} onSelect={() => openTasks(filter)}>{t('在任务页查看全部')}</MenuItem>
            {view.counts.cleared > 0 && <MenuItem icon={<RotateCcw />} onSelect={restore}>{t('显示已清除的 {n} 项', { n: view.counts.cleared })}</MenuItem>}
          </MenuContent>
        </Menu>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-8 pt-2" aria-busy={loading || undefined}>
        {empty && loading ? <PanelSkeleton />
          : empty ? <EmptyState filtered={filter !== 'all'} name={filter !== 'all' ? projects[filter]?.name ?? null : null} countAll={countAll} onShowAll={() => onFilterChange('all')} cleared={view.counts.cleared} onRestore={restore} />
            : (
              <>
                {view.attention.length > 0 && (
                  <Section id="attention" title={t('需要你')} count={view.attention.length} folded={folded.attention} onFold={() => setFolded(s => ({ ...s, attention: !s.attention }))}
                    action={failed.length > 0 && (
                      <Tooltip content={t('没做完的后台工作不再提醒，记录保留')}>
                        <button type="button" onClick={() => setDropping(true)} className="rounded-md px-1.5 text-[12px] text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('全部不用了')}</button>
                      </Tooltip>
                    )}>
                    <div className="space-y-px">{view.attention.map(run => card(run, 'row'))}</div>
                  </Section>
                )}
                <Section id="running" title={t('运行中')} count={view.running.length} folded={folded.running} onFold={() => setFolded(s => ({ ...s, running: !s.running }))}
                  empty={t('现在没有在运行的任务')}>
                  <div className="space-y-2 px-0.5 pb-1">{view.running.map(run => card(run, 'card'))}</div>
                </Section>
                {view.upcoming.length > 0 && (
                  <Section id="upcoming" title={t('排队与即将运行')} count={view.upcoming.length} folded={folded.upcoming} onFold={() => setFolded(s => ({ ...s, upcoming: !s.upcoming }))}>
                    <div className="space-y-px">{view.upcoming.map(run => card(run, 'row'))}</div>
                  </Section>
                )}
                {view.finished.length > 0 && (
                  <Section id="finished" title={t('已完成')} hint={t('近 24 小时')} count={view.finished.length} folded={folded.finished} onFold={() => setFolded(s => ({ ...s, finished: !s.finished }))}
                    action={clearable.length > 0 && (
                      <Tooltip content={t('只在这台设备上隐藏，不影响记录')}>
                        <button type="button" onClick={() => clear(clearable)} className="rounded-md px-1.5 text-[12px] text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('清除')}</button>
                      </Tooltip>
                    )}>
                    <div className="space-y-px">{view.finished.map(run => card(run, 'row'))}</div>
                  </Section>
                )}
              </>
            )}
      </div>
      <CleanupDialog open={dropping} onClose={() => setDropping(false)} rows={failed} showProject={showProject}
        title={t('这些没做完的后台工作都不用了？')} confirmLabel={n => t('不用了（{n} 项）', { n })} />
    </div>
  )
}

function Section({ id, title, hint, count, folded, onFold, action, empty, children }: { id: RunSection; title: string; hint?: string; count: number; folded?: boolean; onFold: () => void; action?: ReactNode; empty?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`tasks-panel-${id}`} className="pb-2" data-section={id}>
      <div className="flex h-7 items-center gap-1 px-1">
        <button type="button" id={`tasks-panel-${id}`} onClick={onFold} aria-expanded={!folded}
          className="group/s flex min-w-0 items-center gap-1 rounded-md text-[12px] font-medium text-fg-3 outline-none transition-colors hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          <ChevronRight className={cn('size-3 text-fg-4 transition-transform duration-200', !folded && 'rotate-90')} aria-hidden />
          <span className="truncate">{title}</span>
          <span className="tabular-nums font-normal text-fg-4">{count}</span>
          {hint && <span className="truncate font-normal text-fg-4">· {hint}</span>}
        </button>
        <span className="flex-1" />
        {action}
      </div>
      {!folded && (count > 0 ? children : empty ? <p className="px-2 pb-1 text-[12.5px] text-fg-4">{empty}</p> : null)}
    </section>
  )
}

function EmptyState({ filtered, name, countAll, onShowAll, cleared, onRestore }: { filtered: boolean; name: string | null; countAll: () => number; onShowAll: () => void; cleared: number; onRestore: () => void }) {
  const t = useT()
  const elsewhere = filtered ? countAll() : 0
  return (
    <div className="mx-auto flex max-w-[300px] flex-col items-center px-4 pt-[clamp(32px,14vh,112px)] text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-accent-softer text-accent-text"><Layers className="size-[18px]" strokeWidth={1.8} /></span>
      <h3 className="mt-3 text-[14px] font-medium text-fg">{name ? t('{name} 现在没有后台任务', { name }) : t('没有后台任务')}</h3>
      <p className="mt-1 text-[12.5px] leading-[1.6] text-fg-3">{t('Rna 在后台做事、定时任务到点运行或子代理协作时，会在这里显示进度。')}</p>
      {elsewhere > 0 && <button type="button" onClick={onShowAll} className="mt-3 rounded-md px-2 py-1 text-[12.5px] text-accent-text outline-none hover:bg-accent-softer focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('查看全部项目（{n}）', { n: elsewhere })}</button>}
      {cleared > 0 && <button type="button" onClick={onRestore} className="mt-1 rounded-md px-2 py-1 text-[12.5px] text-fg-3 outline-none hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('显示已清除的 {n} 项', { n: cleared })}</button>}
    </div>
  )
}

function PanelSkeleton() {
  return (
    <div className="space-y-2 px-0.5 pt-1" aria-hidden>
      <Skeleton className="mx-1 h-3 w-16" />
      {[0, 1].map(i => (
        <div key={i} className="space-y-2 rounded-xl bg-elevated px-3 py-3 shadow-[0_0_0_0.5px_var(--line-strong)]">
          <Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-1.5 w-full" />
        </div>
      ))}
    </div>
  )
}
