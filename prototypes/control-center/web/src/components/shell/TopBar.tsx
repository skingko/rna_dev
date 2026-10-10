import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Archive, ArrowLeft, Check, GitFork, Menu as MenuIcon, MessageSquareText, Monitor, Moon, MoreHorizontal, OctagonX, PanelRight, PanelRightOpen, Pause, Play, Route, Settings2, Sun } from 'lucide-react'
import type { SessionWorktree } from '@/api/types'
import { openProjectSettings } from '@/components/settings/panel-store'
import { emergencyText, setEmergency } from '@/components/settings/emergency'
import { RecoveryDialog } from '@/components/composer/SessionNotice'
import { useApp, useProject } from '@/store/app-store'
import { archiveSession, controlSession, renameSession } from '@/store/sync'
import { GLOBAL_VIEWS, setTheme, toast, useUi, type ViewTab } from '@/store/ui-store'
import { togglePanel, usePanelsOpen } from '@/store/side-panel-store'
import { isSurfaceKind, openSurface, setSurfacePreference, useSurfacePreference, type SurfaceKind } from '@/store/surface-router'
import { useTasks } from '@/store/tasks-store'
import { activeCount, useLiveTasks } from '@/components/tasks/live-tasks'
import { toggleTasksPanel, useTasksPanelShown } from '@/components/workspace/tasks-panel'
import { prettyPath } from '@/lib/format'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlays'
import { Button, IconButton, SegmentedTabs, StatusDot, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { InboxBell } from './InboxBell'
import { t as tr, localized } from '@/i18n'

export function TopBar() {
  const sessionId = useApp(s => s.selectedSessionId)
  const meta = useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId]?.meta ?? s.sessionIndex[s.selectedSessionId] : undefined))
  const projectId = useApp(s => s.selectedProjectId)
  const project = useProject(meta?.projectId ?? projectId)
  const theme = useUi(s => s.theme)
  const panelOpen = usePanelsOpen()
  const view = useUi(s => s.view)
  const globalView = GLOBAL_VIEWS.has(view)
  const [editing, setEditing] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const emergency = useApp(s => s.emergency)
  // Stopping takes a second step that says what stops, as in 设置 → 通用; releasing does not.
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [switching, setSwitching] = useState(false)
  const switchEmergency = async (stop: boolean) => {
    setSwitching(true)
    try { toast(await setEmergency(stop)); setConfirmingStop(false) } catch (e) { toast((e as Error).message, 'danger') } finally { setSwitching(false) }
  }
  const full = useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId]?.meta : undefined))
  const uncertain = full?.runtime?.recovery?.uncertainTools ?? []
  const [title, setTitle] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) input.current?.select() }, [editing])

  const commit = async () => {
    setEditing(false)
    const next = title.trim()
    if (!sessionId || !next || next === meta?.title) return
    try { await renameSession(sessionId, next) } catch (e) { toast((e as Error).message, 'danger') }
  }

  const status = meta?.status ?? 'idle'
  // This project's background work: the badge counts 进行中 from the same entries as the sidebar and the 后台任务 panel,
  // and toggles that panel. The initiative runtime says 'working' while a background action runs, before its row is read.
  const entries = useLiveTasks()
  const projectKey = project?.id ?? null
  const active = useMemo(() => (projectKey ? activeCount(entries, projectKey) : 0), [entries, projectKey])
  const working = project?.initiativeRuntime?.status === 'working' || entries.some(e => e.projectId === projectKey && e.kind === 'action' && e.state === 'running')
  const background = !globalView && projectKey !== null && (working || active > 0)
  const tasksShown = useTasksPanelShown()
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2 px-3 sm:px-5">
      <IconButton label={tr('打开会话列表')} className="md:hidden" onClick={() => useUi.setState({ sidebarOpen: true })}><MenuIcon /></IconButton>
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        {globalView ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <IconButton label={tr('返回对话')} className="-ml-1.5" onClick={() => useUi.setState({ view: 'chat' })}><ArrowLeft /></IconButton>
            <h1 className="truncate text-[14px] font-semibold text-fg">{view === 'tasks' ? tr('任务列表') : tr('收件箱')}</h1>
          </span>
        ) : editing ? (
          <input
            ref={input}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false) }}
            maxLength={160}
            aria-label={tr('会话名称')}
            className="h-7 min-w-0 max-w-[420px] flex-1 rounded-md bg-subtle px-2 text-[14px] font-semibold text-fg outline-none shadow-[inset_0_0_0_1px_var(--line-focus)]"
          />
        ) : (
          <Tooltip content={tr('点击修改会话名称')} delay={800}>
            <button
              type="button"
              disabled={!sessionId}
              onClick={() => { setTitle(meta?.title ?? ''); setEditing(true) }}
              className="-ml-1.5 min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-[14px] font-semibold text-fg transition-colors enabled:hover:bg-hover"
            >
              {meta?.title || (project ? project.name : tr('新会话'))}
            </button>
          </Tooltip>
        )}
        {!globalView && sessionId && meta?.worktree && <WorktreeMark worktree={meta.worktree} />}
        {!globalView && project?.workspacePath && <span className="hidden min-w-0 truncate text-[12px] text-fg-4 lg:block">{prettyPath(project.workspacePath)}</span>}
      </div>

      <AnimatePresence>
        {background && (
          <Tooltip content={tasksShown ? tr('收起后台任务') : tr('查看后台任务')}>
            <motion.button type="button" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
              aria-pressed={tasksShown} data-tasks-badge onClick={() => toggleTasksPanel(projectKey)}
              className={cn('hidden h-7 items-center gap-2 rounded-full px-2.5 text-[12px] text-accent-text outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] sm:inline-flex', tasksShown ? 'bg-accent-soft' : 'bg-accent-softer hover:bg-accent-soft')}>
              <StatusDot state={working ? 'running' : 'idle'} />{working ? tr('项目在后台工作') : tr('后台任务')}
              {active > 0 && <><span className="-mr-0.5 font-semibold tabular-nums" aria-hidden>{active}</span><span className="sr-only">{tr('{active} 项进行中', { active })}</span></>}
            </motion.button>
          </Tooltip>
        )}
      </AnimatePresence>

      {sessionId && status !== 'idle' && (
        <span className="hidden h-7 items-center gap-2 px-1.5 text-[12px] text-fg-3 sm:inline-flex">
          <StatusDot state={status === 'running' ? 'running' : 'paused'} />{status === 'running' ? tr('运行中') : tr('已暂停')}
        </span>
      )}
      {sessionId && status === 'running' && <IconButton label={tr('暂停')} onClick={() => void controlSession('pause').catch(e => toast((e as Error).message, 'danger'))}><Pause /></IconButton>}
      {sessionId && status === 'paused' && <IconButton label={uncertain.length ? tr('核对操作后继续') : tr('继续')} onClick={() => (uncertain.length ? setRecovering(true) : void controlSession('resume').catch(e => toast((e as Error).message, 'danger')))}><Play /></IconButton>}
      {full && <RecoveryDialog open={recovering} onClose={() => setRecovering(false)} session={full} tools={uncertain} />}

      {sessionId && !globalView && <ConversationModeSwitch />}
      <InboxBell />
      <IconButton label={panelOpen ? tr('收起侧边面板') : tr('展开侧边面板')} active={panelOpen} className="hidden sm:inline-grid" onClick={() => togglePanel()} shortcut="⌥⌘B"><PanelRight /></IconButton>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-active" aria-label={tr('更多')}><MoreHorizontal className="size-4" /></button>
        </MenuTrigger>
        <MenuContent align="end" className="w-52">
          <MenuItem icon={<ThemeIcon />} onSelect={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')} hint={theme === 'light' ? tr('浅色') : theme === 'dark' ? tr('深色') : tr('跟随系统')}>{tr('外观')}</MenuItem>
          {/* H4 mount: project overview & settings */}
          {project && !globalView && <MenuItem icon={<Settings2 />} onSelect={() => openProjectSettings(project.id)}>{tr('项目概览与设置…')}</MenuItem>}
          {sessionId && <MenuItem icon={<Archive />} onSelect={() => void archiveSession(sessionId).catch(e => toast((e as Error).message, 'danger'))}>{tr('归档会话')}</MenuItem>}
          <MenuItem icon={<OctagonX />} danger={!emergency} disabled={switching} onSelect={() => (emergency ? void switchEmergency(false) : setConfirmingStop(true))}>{emergency ? tr('解除急停') : tr('全局急停…')}</MenuItem>
        </MenuContent>
      </Menu>
      <Dialog open={confirmingStop} onOpenChange={open => { if (!switching) setConfirmingStop(open) }} title={tr('全局急停')} description={emergencyText.confirm()}
        footer={<><Button variant="ghost" disabled={switching} onClick={() => setConfirmingStop(false)}>{tr('取消')}</Button><Button variant="danger" disabled={switching} leading={<OctagonX className="size-3.5" />} onClick={() => void switchEmergency(true)}>{tr('确认急停')}</Button></>} />
    </header>
  )
}

/**
 * 独立工作树 (0.63, worktree design §12): this conversation changes files in its own copy and applies them to the
 * project folder each time it hands control back. Its worktree's state: made at the first turn, missing, or kept.
 */
export function WorktreeMark({ worktree, className }: { worktree: SessionWorktree; className?: string }) {
  const missing = worktree.state === 'missing'
  const detail = worktree.state === 'pending' ? tr('下一轮开始时创建。') : missing ? tr('工作树的目录不见了；下一轮开始前会先修复，修不好就重建。') : worktree.state === 'kept' ? tr('对话归档时还有没应用的改动，工作树保留着。') : ''
  return (
    <Tooltip content={<span className="block max-w-[300px]">{tr('这个对话在独立的工作副本里改文件，每次交还给你时应用到项目文件夹；被忽略的文件（如 dist/）不会应用。')}{detail ? ` ${detail}` : ''}</span>}>
      <span tabIndex={0} className={cn('inline-flex h-5 shrink-0 cursor-default items-center gap-1 self-center rounded-md px-1.5 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', missing ? 'bg-warning-soft text-warning-text' : 'bg-accent-softer text-accent-text', className)} data-worktree-mark={worktree.state}>
        <GitFork className="size-3" strokeWidth={2} aria-hidden />{missing ? tr('工作树不见了') : tr('独立工作树')}
      </span>
    </Tooltip>
  )
}

const TABS: { id: ViewTab; label: string }[] = localized([
  { id: 'chat', label: '对话' },
  { id: 'files', label: '文件视图' },
  { id: 'evolution', label: '进化' },
])
/** Views that belong to a tab without being one: 轨迹 lives in 对话. */
const TAB_OF: Partial<Record<ViewTab, ViewTab>> = { trajectory: 'chat' }

/**
 * 对话 / 文件视图 / 进化. 文件视图 and 进化 open through the surface router (design 4.5): a panel already showing them
 * comes forward, else the page (or the panel, when the user chose so). Right-click (or the context-menu key) on either:
 * 在侧边面板中打开, and whether a click opens the panel from now on.
 */
export function ViewTabs() {
  const view = useUi(s => s.view)
  const projectId = useApp(s => (s.selectedSessionId ? s.sessionIndex[s.selectedSessionId]?.projectId ?? s.selectedProjectId : s.selectedProjectId))
  const project = useProject(projectId)
  // Learning in progress: a running learn action, or an evolution evaluation the user started (rhythm lanes never say 'evaluating').
  const learning = useTasks(s => Boolean(projectId && s.actions[projectId]?.some(a => a.action === 'learn' && a.status === 'running')))
  // …or a gene forming on its own (proposed or under test, reported on the project summary).
  const evolving = project as { evolution?: { request?: { status?: string } | null }; genesForming?: boolean } | undefined
  const pending = learning || evolving?.evolution?.request?.status === 'running' || evolving?.genesForming === true
  const items = TABS.map(t => ({
    ...t,
    label: <span data-view-tab={t.id}>{t.label}</span>,
    badge: t.id === 'evolution' && pending ? <span className="inline-flex size-1.5 rounded-full bg-accent" aria-label={tr('进化进行中')} /> : undefined,
  }))
  const value = TAB_OF[view] ?? view
  const choose = (v: ViewTab) => {
    if (v === value) return
    if (isSurfaceKind(v) && projectId) { openSurface(v, projectId, { from: 'tabs' }); return }
    useUi.setState({ view: v === 'chat' && view === 'trajectory' ? 'trajectory' : v })
  }
  // The tab the context menu is for (read from the right-clicked, long-pressed or focused tab).
  const [menuFor, setMenuFor] = useState<SurfaceKind | null>(null)
  const kindAt = (target: EventTarget) => {
    const id = (target as HTMLElement).closest?.('[role="tab"]')?.querySelector<HTMLElement>('[data-view-tab]')?.dataset.viewTab
    // 对话 has nothing to offer, and neither tab without a project.
    return isSurfaceKind(id) && projectId ? id : null
  }
  const onContextMenu = (e: ReactMouseEvent) => {
    const kind = kindAt(e.target)
    if (!kind) { e.preventDefault(); return }
    setMenuFor(kind)
  }
  // A touch long-press opens the menu without a contextmenu event: name the pressed tab first (none on 对话).
  const onPointerDown = (e: ReactPointerEvent) => { if (e.pointerType === 'touch') setMenuFor(kindAt(e.target)) }
  return (
    <nav aria-label={tr('视图')} className="flex h-10 shrink-0 items-center overflow-x-auto border-b border-line-faint px-3 sm:px-5">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div onContextMenu={onContextMenu} onPointerDown={onPointerDown} className="flex">
            <SegmentedTabs items={items} value={value} onChange={choose} layoutId="view-tab" />
          </div>
        </ContextMenuTrigger>
        {menuFor && projectId && <ViewTabMenu kind={menuFor} projectId={projectId} />}
      </ContextMenu>
    </nav>
  )
}

function ViewTabMenu({ kind, projectId }: { kind: SurfaceKind; projectId: string }) {
  const where = useSurfacePreference(kind)
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuItem icon={<PanelRightOpen />} onSelect={() => openSurface(kind, projectId, { where: 'panel', from: 'tabs' })}>{tr('在侧边面板中打开')}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={where === 'panel' ? <Check /> : <span className="size-4" />} onSelect={() => setSurfacePreference(kind, where === 'panel' ? null : 'panel')}>{tr('总是在侧边面板中打开')}</ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Harness-style 对话 / 轨迹 switch for the selected conversation. */
function ConversationModeSwitch() {
  const view = useUi(s => s.view)
  const modes = [
    { id: 'chat' as const, label: tr('对话'), icon: MessageSquareText },
    { id: 'trajectory' as const, label: tr('轨迹'), icon: Route },
  ]
  return (
    <div role="radiogroup" aria-label={tr('对话显示方式')} className="inline-flex h-7 shrink-0 items-center rounded-lg bg-subtle p-0.5 shadow-[inset_0_0_0_1px_var(--line-faint)]">
      {modes.map(m => {
        const on = view === m.id || (m.id === 'chat' && view !== 'trajectory')
        const Icon = m.icon
        return (
          <Tooltip key={m.id} content={m.id === 'chat' ? tr('对话') : tr('执行轨迹')}>
            <button type="button" role="radio" aria-checked={on} aria-label={m.label} onClick={() => useUi.setState({ view: m.id })}
              className={cn('relative grid h-6 w-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', on ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}>
              {on && <motion.span layoutId="conversation-mode" className="absolute inset-0 rounded-md bg-elevated shadow-[0_0_0_0.5px_var(--line-strong),var(--shadow-xs)]" transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }} />}
              <Icon className="relative size-3.5" strokeWidth={1.9} />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
