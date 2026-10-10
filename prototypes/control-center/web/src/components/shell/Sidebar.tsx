import { memo, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlarmClock, FolderClosed, FolderOpen, GitFork, MoreHorizontal, Plus, Search, SquarePen, X } from 'lucide-react'
import type { SessionSummary } from '@/api/types'
import { useApp } from '@/store/app-store'
import { selectProject, selectSession } from '@/store/sync'
import { isUnseen, useSeen } from '@/store/seen-store'
import { GLOBAL_VIEWS, useUi } from '@/store/ui-store'
import { relativeTime } from '@/lib/format'
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/overlays'
import { Kbd, StatusDot, Tooltip, type DotState } from '@/components/ui/primitives'
import { SidebarFooterMenu } from '@/components/settings/SidebarFooterMenu'
import { openNewProject } from '@/components/settings/panel-store'
import { ProjectMenu, SessionMenuItems } from '@/components/projects/EntityMenus'
import { cn } from '@/lib/utils'
import { SidebarTasks } from '@/components/tasks/SidebarTasks'
import { t } from '@/i18n'

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[8px] bg-[var(--brand-mark)] text-[var(--brand-mark-fg)] shadow-[inset_0_-1px_0_rgb(0_0_0/0.18),0_1px_2px_rgb(22_30_52/0.18)]"
      style={{ width: size, height: size, fontFamily: 'var(--font-brand)', fontStyle: 'italic', fontSize: size * 0.78, lineHeight: 1 }}
      aria-hidden
    >
      <span className="-mt-[2px] -ml-[1px]">R</span>
    </span>
  )
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)
  const sessionIndex = useApp(s => s.sessionIndex)
  const sessionOrder = useApp(s => s.sessionOrder)
  const selectedSessionId = useApp(s => s.selectedSessionId)
  const selectedProjectId = useApp(s => s.selectedProjectId)
  const search = useUi(s => s.search)
  const onGlobalView = useUi(s => GLOBAL_VIEWS.has(s.view))
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const tree = useMemo(() => {
    const q = search.trim().toLowerCase()
    const byProject = new Map<string, SessionSummary[]>()
    for (const id of sessionOrder) {
      const s = sessionIndex[id]
      if (!s || s.archivedAt) continue
      if (q && !`${s.title} ${projects[s.projectId ?? '']?.name ?? ''}`.toLowerCase().includes(q)) continue
      const key = s.projectId ?? 'unassigned'
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key)!.push(s)
    }
    const ordered = projectOrder.filter(id => !projects[id]?.archivedAt && (!q || byProject.has(id) || projects[id].name.toLowerCase().includes(q)))
    if (byProject.has('unassigned')) ordered.push('unassigned')
    return ordered.map(id => ({ id, name: projects[id]?.name ?? t('未归属项目'), sessions: byProject.get(id) ?? [] }))
  }, [projects, projectOrder, sessionIndex, sessionOrder, search])

  const newSession = () => {
    void selectSession(null)
    useUi.setState({ view: 'chat' })
    onNavigate?.()
  }
  const newInProject = (projectId: string) => {
    selectProject(projectId === 'unassigned' ? null : projectId)
    useUi.setState({ view: 'chat' })
    onNavigate?.()
  }

  return (
    <aside className="surface-sidebar flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-sidebar [--spacing:calc(0.25rem*1.125)]" aria-label={t('会话导航')}>
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2.5 px-4 pt-1">
        <BrandMark />
        <span className="text-[18px] font-semibold tracking-[-0.01em] text-fg">Rna Agent</span>
        <span className="ml-auto text-[11px] font-semibold tracking-[0.12em] text-fg-4">LOCAL</span>
      </div>

      <div className="space-y-2 px-3 pt-1.5">
        <button
          type="button"
          onClick={newSession}
          className="group flex h-10 w-full items-center gap-2.5 rounded-[10px] bg-fg px-3 text-[15px] font-medium text-fg-inverted shadow-[var(--shadow-xs)] outline-none transition-[opacity,transform,box-shadow] duration-150 hover:opacity-90 active:scale-[0.99] focus-visible:shadow-[0_0_0_2px_var(--bg-sidebar),0_0_0_4px_var(--line-focus)]"
        >
          <SquarePen className="size-[17px] transition-transform duration-200 group-hover:-rotate-6" strokeWidth={1.9} />
          {t('新会话')}
          <span className="ml-auto text-[13px] font-normal tracking-[0.08em] opacity-55 max-md:hidden" aria-hidden>⇧⌘O</span>
        </button>
        <SearchField />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-quiet pb-2">
        <SidebarTasks onNavigate={onNavigate} />

        <div className="mt-3 flex h-7 items-center pl-5 pr-3 text-[13px] font-medium text-fg-4">
          <span id="sidebar-projects-heading">{t('项目列表')}</span>
          <Tooltip content={t('打开项目目录')}>
            <button type="button" onClick={() => { openNewProject(); onNavigate?.() }} className="ml-auto grid size-6 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" aria-label={t('打开项目目录')}><Plus className="size-3.5" /></button>
          </Tooltip>
        </div>

        <nav className="px-2" aria-labelledby="sidebar-projects-heading">
          {tree.map(project => {
            const isCollapsed = collapsed[project.id] ?? false
            const active = selectedProjectId === project.id && !selectedSessionId && !onGlobalView
            const Folder = isCollapsed ? FolderClosed : FolderOpen
            return (
              <div key={project.id} className="mb-0.5">
                <div className={cn('group relative flex h-8 items-center rounded-lg text-[14.5px] transition-colors hover:bg-hover focus-within:bg-hover', active && 'bg-active')}>
                  <button
                    type="button"
                    onClick={() => setCollapsed(c => ({ ...c, [project.id]: !isCollapsed }))}
                    aria-expanded={!isCollapsed}
                    className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-3 pr-16 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"
                  >
                    <Folder className="size-4 shrink-0 text-fg-3 transition-colors group-hover:text-fg-2" strokeWidth={1.7} />
                    <span className="truncate font-medium text-fg-2 group-hover:text-fg">{project.name}</span>
                  </button>
                  {/* Trailing slot: count at rest, actions on hover/focus — overlaid, so nothing shifts. */}
                  <span className="pointer-events-none absolute right-2.5 inline-flex items-center gap-2 text-[12.5px] tabular-nums text-fg-4 transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
                    {(projects[project.id]?.counts?.overdueCommitments ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-warning-text">
                        <AlarmClock className="size-3" strokeWidth={2} aria-hidden />
                        <span aria-hidden>{projects[project.id]!.counts!.overdueCommitments}</span>
                        <span className="sr-only">{t('{n} 项承诺已逾期', { n: projects[project.id]!.counts!.overdueCommitments! })}</span>
                      </span>
                    )}
                    {project.sessions.length || ''}
                  </span>
                  <div className="absolute right-1 flex items-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                    <Tooltip content={t('在此项目中新建会话')}>
                      <button type="button" onClick={() => newInProject(project.id)} className="grid size-6 place-items-center rounded-md text-fg-3 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]" aria-label={t('在 {name} 中新建会话', { name: project.name })}><Plus className="size-3.5" /></button>
                    </Tooltip>
                    {project.id !== 'unassigned' && <ProjectMenu projectId={project.id} onNavigate={onNavigate} />}
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {!isCollapsed && (
                    <motion.ul
                      className="overflow-hidden"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
                      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                    >
                      {project.sessions.map(s => (
                        <SessionRow key={s.id} session={s} selected={s.id === selectedSessionId && !onGlobalView} onNavigate={onNavigate} />
                      ))}
                      {project.sessions.length === 0 && <li className="py-1 pl-9.5 text-[13.5px] text-fg-4">{t('还没有会话')}</li>}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
          {tree.length === 0 && <p className="px-3 py-6 text-center text-[14px] text-fg-4">{search.trim() ? t('没有匹配的项目或会话') : t('还没有会话，从右侧开始第一段对话')}</p>}
        </nav>
      </div>

      <SidebarFooterMenu onNavigate={onNavigate} />
    </aside>
  )
}

export const SEARCH_INPUT_ID = 'sidebar-search'

function SearchField() {
  const search = useUi(s => s.search)
  const input = useRef<HTMLInputElement>(null)
  return (
    <label className="group/search flex h-9 cursor-text items-center gap-2 rounded-[10px] bg-elevated px-2.5 shadow-[inset_0_0_0_1px_var(--line)] transition-shadow duration-150 hover:shadow-[inset_0_0_0_1px_var(--line-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--line-focus),0_0_0_3px_var(--accent-softer)]">
      <Search className="size-4 shrink-0 text-fg-3 transition-colors group-focus-within/search:text-fg-2" strokeWidth={1.8} />
      <input
        ref={input}
        id={SEARCH_INPUT_ID}
        type="search"
        value={search}
        onChange={e => useUi.setState({ search: e.target.value })}
        onKeyDown={e => { if (e.key === 'Escape') { useUi.setState({ search: '' }); input.current?.blur() } }}
        placeholder={t('搜索会话、项目与任务…')}
        aria-label={t('搜索会话、项目与任务')}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[14.5px] text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
      />
      {search ? (
        <button type="button" onClick={() => { useUi.setState({ search: '' }); input.current?.focus() }} className="grid size-5 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg" aria-label={t('清除搜索')}><X className="size-3.5" /></button>
      ) : (
        <span className="flex shrink-0 gap-0.5 group-focus-within/search:hidden max-md:hidden" aria-hidden><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
      )}
    </label>
  )
}

const SessionRow = memo(function SessionRow({ session, selected, onNavigate }: { session: SessionSummary; selected: boolean; onNavigate?: () => void }) {
  const seenAt = useSeen(s => s.at[session.id] ?? s.baseline)
  // Only what needs the user and new proactive messages get a dot (plan §2.4), besides running / paused.
  const dot: DotState = (session.waiting ?? 0) > 0 ? 'waiting' : session.status === 'running' ? 'running' : session.status === 'paused' ? 'paused'
    : !selected && isUnseen(session.lastInitiativeAt, seenAt) ? 'unread' : 'idle'
  return (
    <li>
      <div
        className={cn(
          'group relative flex h-8 items-center rounded-lg text-[14.5px] transition-colors duration-150 focus-within:bg-hover',
          selected ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2',
        )}
      >
        <button
          type="button"
          aria-current={selected ? 'page' : undefined}
          onClick={() => { void selectSession(session.id); if (GLOBAL_VIEWS.has(useUi.getState().view)) useUi.setState({ view: 'chat' }); onNavigate?.() }}
          className="relative flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-9.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"
        >
          {/* The dot sits in the project icon's column (pl-3 inset + centered in the size-4 icon), so titles align with the project name. */}
          <StatusDot state={dot} className={cn('absolute left-[calc(var(--spacing)*4.25)]', dot === 'idle' && 'opacity-0')} />
          <span className="min-w-0 flex-1 truncate">{session.title || t('未命名会话')}</span>
          {/* 0.63: the conversation runs in its own worktree. */}
          {session.worktree && <GitFork className={cn('size-3 shrink-0', session.worktree.state === 'missing' ? 'text-warning-text' : 'text-fg-4')} strokeWidth={2} role="img" aria-label={t('独立工作树')} data-worktree-session />}
          <span className="shrink-0 text-[12.5px] text-fg-4 group-focus-within:hidden group-hover:hidden">{relativeTime(session.lastItemAt ?? session.updatedAt)}</span>
          {dot !== 'idle' && <span className="sr-only">{dot === 'waiting' ? t('等你答复') : dot === 'unread' ? t('有新消息') : dot === 'running' ? t('运行中') : t('已暂停')}</span>}
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="mr-1 hidden size-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-visible:grid group-focus-within:grid group-hover:grid data-[state=open]:grid" aria-label={t('会话操作：{v}', { v: session.title || t('未命名会话') })}><MoreHorizontal className="size-4" /></button>
          </MenuTrigger>
          <MenuContent align="end" className="w-44">
            <SessionMenuItems sessionId={session.id} />
          </MenuContent>
        </Menu>
      </div>
    </li>
  )
})
