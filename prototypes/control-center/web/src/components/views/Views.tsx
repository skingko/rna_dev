/**
 * Secondary views. Top tabs (H3): 对话 / 文件 / 进化. 进化 is the project's gene
 * tree (EvolutionSurface). 轨迹 is the 对话/轨迹 switch in the conversation header.
 * 任务 (sidebar) and 收件箱 (top-bar bell) are app-level pages across all projects.
 * 文件 and 进化 are the page shell of surfaces that also open as panels
 * (design 4.1, store/surface-router.ts).
 */
import { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { useUi, type ViewTab } from '@/store/ui-store'
import { SegmentedTabs } from '@/components/ui/primitives'
import { TrajectoryView } from './TrajectoryView'
import { FilesSurface } from './FilesView'
import { InboxView } from './InboxView'
import { GlobalTasksView } from './GlobalTasksView'
import { EvolutionSurface } from './EvolutionView'
import { clearPagePath, notePageSelection, usePagePath } from '@/store/surface-router'
import { t } from '@/i18n'

export { TrajectoryView }

export function ProjectView({ view, projectId, sessionId }: { view: Exclude<ViewTab, 'chat' | 'trajectory'>; projectId: string | null; sessionId: string | null }) {
  if (view === 'tasks') return <GlobalTasksView />
  if (view === 'inbox') return <InboxHub projectId={projectId} />
  if (!projectId) return <NoProject />
  switch (view) {
    case 'evolution': return <EvolutionSurface key={projectId} projectId={projectId} sessionId={sessionId} visible layout="page" />
    case 'files': return <FilesPage key={projectId} projectId={projectId} sessionId={sessionId} />
  }
}

/** The 文件 page: selects a file handed over from a panel, and remembers the one it shows so a move to a panel takes it along. */
function FilesPage({ projectId, sessionId }: { projectId: string; sessionId: string | null }) {
  const path = usePagePath(projectId)
  useEffect(() => () => notePageSelection(projectId, null), [projectId])
  return <FilesSurface projectId={projectId} sessionId={sessionId} visible layout="page" path={path} onPathApplied={clearPagePath} onSelect={selected => notePageSelection(projectId, selected)} />
}

function NoProject({ text = t('文件与进化都属于项目。从左侧选择项目或其中的会话。') }: { text?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-xl bg-subtle text-fg-3"><FolderOpen className="size-5" strokeWidth={1.6} /></span>
        <h2 className="text-[15px] font-semibold text-fg">{t('先选择一个项目')}</h2>
        <p className="mt-1.5 text-[13px] leading-[1.7] text-fg-3">{text}</p>
      </div>
    </div>
  )
}

/** 收件箱 page: pick a project (unread first), then F-P3's InboxView. */
function InboxHub({ projectId }: { projectId: string | null }) {
  const chosen = useUi(s => s.inboxProject)
  const projects = useApp(s => s.projects)
  const projectOrder = useApp(s => s.projectOrder)
  const live = projectOrder.filter(id => projects[id] && !projects[id].archivedAt)
  const firstUnread = live.find(id => (projects[id].counts?.inboxUnread ?? 0) > 0)
  const current = [chosen, projectId, firstUnread, live[0]].find(id => id && live.includes(id)) ?? null
  // The explicit pick (bell, project switcher) lasts for this visit only.
  useEffect(() => () => useUi.setState({ inboxProject: null }), [])
  if (!current) return <NoProject text={t('收件箱属于项目。创建或打开一个项目后，主动消息会记录在这里。')} />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {live.length > 1 && (
        <nav aria-label={t('收件箱项目')} className="flex h-10 shrink-0 items-center overflow-x-auto border-b border-line-faint px-3 scroll-quiet sm:px-5">
          <SegmentedTabs layoutId="inbox-project" value={current} onChange={id => useUi.setState({ inboxProject: id })}
            items={live.map(id => ({ id, label: <span className="max-w-[160px] truncate">{projects[id].name}</span>, badge: projects[id].counts?.inboxUnread || undefined }))} />
        </nav>
      )}
      <InboxView key={current} projectId={current} />
    </div>
  )
}
