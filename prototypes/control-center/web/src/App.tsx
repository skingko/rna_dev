import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { selectSession, startApp } from '@/store/sync'
import { GLOBAL_VIEWS, useUi } from '@/store/ui-store'
import { useTaskSync } from '@/store/tasks-store'
// P3: a clicked desktop notification opens its conversation (or the project inbox); the store listens from load.
import '@/store/inbox-store'
import { SEARCH_INPUT_ID, Sidebar } from '@/components/shell/Sidebar'
import { SteerTaskDialog } from '@/components/tasks/task-parts'
import { TopBar, ViewTabs } from '@/components/shell/TopBar'
import { EmptyHero } from '@/components/shell/EmptyHero'
import { WorkspaceHost } from '@/components/workspace/WorkspaceHost'
// 后台任务 registers as a workspace panel (contract P-6).
import '@/components/workspace/panels'
import { useTasksAutoOpen } from '@/components/workspace/tasks-panel'
import { Timeline } from '@/components/timeline/Timeline'
import { Composer } from '@/components/composer/Composer'
import { ProjectInitStatus } from '@/components/projects/ProjectInitStatus'
import { useAutoOpenPreview } from '@/components/side-panel/useAutoOpenPreview'
import { useAutoOpenAgentBrowser } from '@/components/side-panel/useAutoOpenAgentBrowser'
import { ProjectView, TrajectoryView } from '@/components/views/Views'
import { Toaster } from '@/components/ui/overlays'
import { GlobalPanels } from '@/components/settings/GlobalPanels'
import { Button, Skeleton, TooltipProvider } from '@/components/ui/primitives'
import { t } from '@/i18n'
import { useInterfaceLanguageSync } from '@/store/interface-language-sync'
import { useOutboxFlush } from '@/store/outbox'

function useTheme() {
  const theme = useUi(s => s.theme)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#161616' : '#ffffff')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

export default function App() {
  useTheme()
  const status = useApp(s => s.status)
  const error = useApp(s => s.error)
  const sessionId = useApp(s => s.selectedSessionId)
  const projectId = useApp(s => (s.selectedSessionId ? s.sessionIndex[s.selectedSessionId]?.projectId ?? s.selectedProjectId : s.selectedProjectId))
  const hasRows = useApp(s => (s.selectedSessionId ? (s.sessions[s.selectedSessionId]?.structure.rows.length ?? -1) : 0))
  const view = useUi(s => s.view)
  const sidebarOpen = useUi(s => s.sidebarOpen)
  const followSignal = useUi(s => s.followSignal)
  // A watched turn that finished with a web preview or document opens it in a panel (preview mode).
  useAutoOpenPreview(sessionId)
  // A browser step the agent takes shows live in a panel.
  useAutoOpenAgentBrowser(sessionId)
  // The current project's first running background run shows 后台任务 (design D4).
  useTasksAutoOpen()
  const mobile = useMedia('(max-width: 767px)')

  useEffect(() => { void startApp() }, [])
  useTaskSync()
  useInterfaceLanguageSync()
  useOutboxFlush()

  // ⌘K / Ctrl+K: focus search (opens the drawer on mobile). ⇧⌘O (and ⌘N in the desktop shell): new session.
  // Panel shortcuts (⌥⌘B and the layout keys) live with the workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'k' && !e.shiftKey) {
        // ⌘K / Ctrl+K belong to the terminal while it has focus (clear screen, kill line).
        if (e.target instanceof Element && e.target.closest('[data-terminal-host]')) return
        e.preventDefault()
        const focus = () => { const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null; el?.focus(); el?.select() }
        if (matchMedia('(max-width: 767px)').matches && !useUi.getState().sidebarOpen) { useUi.setState({ sidebarOpen: true }); setTimeout(focus, 80) } else focus()
      } else if ((key === 'o' && e.shiftKey) || (key === 'n' && !e.shiftKey && window.rnaDesktop)) {
        e.preventDefault()
        void selectSession(null)
        useUi.setState({ view: 'chat', sidebarOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const main = (() => {
    if (status === 'loading') return <LoadingState />
    if (status === 'error') return <ErrorState message={error} />
    if (view !== 'chat' && view !== 'trajectory') return <ProjectView view={view} projectId={projectId ?? null} sessionId={sessionId} />
    if (!sessionId) return <><ProjectInitStatus projectId={projectId} /><EmptyHero onSent={() => {}} /></>
    if (view === 'trajectory') return <TrajectoryView sessionId={sessionId} />
    if (hasRows === -1) return <LoadingState />
    if (hasRows === 0) return <><ProjectInitStatus projectId={projectId} /><EmptyHero onSent={() => {}} /></>
    return (
      <>
        <ProjectInitStatus projectId={projectId} />
        <Timeline sessionId={sessionId} followSignal={followSignal} />
        <Composer />
      </>
    )
  })()

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={450} skipDelayDuration={200}>
        <div className="flex h-dvh w-full overflow-hidden bg-base text-fg">
          {!mobile && <Sidebar />}
          <AnimatePresence>
            {mobile && sidebarOpen && (
              <>
                <motion.div key="scrim" className="fixed inset-0 z-40 bg-[var(--bg-overlay)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => useUi.setState({ sidebarOpen: false })} />
                <motion.div key="drawer" className="fixed inset-y-0 left-0 z-50 shadow-lg" initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'spring', stiffness: 420, damping: 42 }}>
                  <Sidebar onNavigate={() => useUi.setState({ sidebarOpen: false })} />
                </motion.div>
              </>
            )}
          </AnimatePresence>
          <main className="flex min-w-0 flex-1 flex-col md:rounded-none">
            <TopBar />
            {(sessionId || projectId) && !GLOBAL_VIEWS.has(view) && <ViewTabs />}
            {/* The conversation is the workspace's fixed main cell; panel groups lay out around it. */}
            <WorkspaceHost mobile={mobile}>{main}</WorkspaceHost>
          </main>
        </div>
        <Toaster />
        {/* F1: settings, memory, capabilities, archive, projects */}
        <GlobalPanels />
        <SteerTaskDialog />
      </TooltipProvider>
    </MotionConfig>
  )
}

function LoadingState() {
  return (
    <div className="mx-auto w-full max-w-[var(--content-width)] px-6 pt-10">
      <div className="flex justify-end"><Skeleton className="h-11 w-2/5 rounded-[20px]" /></div>
      <Skeleton className="mt-8 h-4 w-32" />
      <Skeleton className="mt-4 h-4 w-11/12" />
      <Skeleton className="mt-2.5 h-4 w-10/12" />
      <Skeleton className="mt-2.5 h-4 w-7/12" />
    </div>
  )
}

function ErrorState({ message }: { message: string | null }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl bg-danger-soft text-danger"><AlertTriangle className="size-5" /></span>
        <h2 className="text-[15px] font-semibold">{t('无法连接本地 daemon')}</h2>
        <p className="mt-1.5 text-[13px] leading-[1.7] text-fg-3">{message ?? t('请确认 Rna Agent 正在运行。')}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" size="sm" leading={<RefreshCw className="size-3.5" />} onClick={() => location.reload()}>{t('重试')}</Button>
        </div>
      </div>
    </div>
  )
}
