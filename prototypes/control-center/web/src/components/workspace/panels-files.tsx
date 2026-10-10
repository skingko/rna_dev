/**
 * 文件 (files) and 进化 (evolution) as workspace panels (design 4, decision
 * D5): the same surfaces as their pages, laid out for a panel. A tab with a
 * `projectId` belongs to that project; without one it follows the current
 * project and, with none selected, says so quietly. A 文件 tab's `path` is a
 * one-off request to show that file, dropped once shown. 在主视图中打开 hands
 * the panel over to the page (store/surface-router.ts).
 */
import { useCallback, useEffect, type ReactNode } from 'react'
import { FolderOpen, FolderTree, Sprout } from 'lucide-react'
import { useApp, useProject } from '@/store/app-store'
import { closeTab, findTab, updateTab, type SideTab } from '@/store/side-panel-store'
import { notePanelSelection, showInMainView } from '@/store/surface-router'
import { FilesSurface } from '@/components/views/FilesView'
import { EvolutionSurface } from '@/components/views/EvolutionView'
import { Button } from '@/components/ui/primitives'
import { t as tr, useT } from '@/i18n'
import { registerPanel, type PanelContext } from './registry'

type Of<K extends 'files' | 'evolution'> = Extract<SideTab, { type: K }>

/** The project the panel shows (its own, else the current one), and the conversation to start a preview for. */
function shownIn(tab: Of<'files' | 'evolution'>, ctx: PanelContext) {
  const projectId = tab.projectId ?? ctx.projectId
  return { projectId, sessionId: projectId && projectId === ctx.projectId ? ctx.sessionId : null }
}

function FilesPanel({ tab, ctx }: { tab: Of<'files'>; ctx: PanelContext }) {
  const t = useT()
  const { projectId, sessionId } = shownIn(tab, ctx)
  const applied = useCallback(() => {
    const current = findTab(tab.id)
    if (current?.type === 'files' && current.path) updateTab(tab.id, { path: null })
  }, [tab.id])
  // The file it shows goes along when the page takes over from elsewhere (the view tab's toast).
  const selected = useCallback((path: string | null) => notePanelSelection(tab.id, path), [tab.id])
  useEffect(() => () => notePanelSelection(tab.id, null), [tab.id])
  const gone = useGone(projectId)
  if (!projectId) return <Quiet>{t('文件属于项目。选择一个项目或其中的会话后，这里会显示它的文件。')}</Quiet>
  if (gone) return <Gone tabId={tab.id} />
  return (
    <FilesSurface key={projectId} projectId={projectId} sessionId={sessionId} visible={ctx.visible} layout="panel"
      path={tab.path ?? null} onPathApplied={applied} onSelect={selected} onShowInMain={path => showInMainView(tab.id, path)} />
  )
}

function EvolutionPanel({ tab, ctx }: { tab: Of<'evolution'>; ctx: PanelContext }) {
  const t = useT()
  const { projectId, sessionId } = shownIn(tab, ctx)
  const gone = useGone(projectId)
  if (!projectId) return <Quiet>{t('进化属于项目。选择一个项目或其中的会话后，这里会显示它学到的做法。')}</Quiet>
  if (gone) return <Gone tabId={tab.id} />
  return <EvolutionSurface key={projectId} projectId={projectId} sessionId={sessionId} visible={ctx.visible} layout="panel" onShowInMain={() => showInMainView(tab.id)} />
}

/** A project the app no longer lists (deleted): nothing to show. Only once the app has loaded its projects. */
function useGone(projectId: string | null) {
  const project = useProject(projectId)
  const ready = useApp(s => s.status === 'ready')
  return Boolean(projectId) && ready && !project
}

function Quiet({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6" data-panel-empty>
      <div className="flex max-w-[260px] flex-col items-center gap-3 text-center">
        <span className="grid size-9 place-items-center rounded-xl bg-subtle text-fg-4"><FolderOpen className="size-[18px]" strokeWidth={1.6} /></span>
        <p className="text-[12.5px] leading-[1.7] text-fg-3">{children}</p>
        {action}
      </div>
    </div>
  )
}

function Gone({ tabId }: { tabId: string }) {
  const t = useT()
  return <Quiet action={<Button size="sm" variant="secondary" onClick={() => closeTab(tabId)}>{t('关闭标签')}</Button>}>{t('这个项目已不可用。')}</Quiet>
}

registerPanel({
  type: 'files', binding: 'project', icon: FolderTree, title: () => tr('文件'),
  render: (tab, ctx) => (tab.type === 'files' ? <FilesPanel tab={tab} ctx={ctx} /> : null),
})
registerPanel({
  type: 'evolution', binding: 'project', icon: Sprout, title: () => tr('进化'),
  render: (tab, ctx) => (tab.type === 'evolution' ? <EvolutionPanel tab={tab} ctx={ctx} /> : null),
})
