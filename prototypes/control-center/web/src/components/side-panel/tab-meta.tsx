/**
 * Icon + title of a workspace tab (strips, edge strips, launcher); types outside this list come from the panel registry.
 * A 文件 / 进化 / 工作区改动 tab bound to a project other than the current one says which (文件 · 项目名), so two of
 * them can be told apart.
 */
import { FileCheck2, FileText, FolderTree, GitCompareArrows, Globe, LayoutGrid, LayoutList, ListChecks, MessagesSquare, MonitorPlay, PanelTop, Sprout, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/store/app-store'
import { useSidePanel, type SideTab } from '@/store/side-panel-store'
import { basename, toolKind, toolTarget, VERBS } from '@/lib/tools'
import { addressLabel } from '@/lib/browser-url'
import { ToolIcon } from '@/components/timeline/tool-icons'
import { getPanel, usePanel } from '@/components/workspace/registry'
import { t as tr, useT } from '@/i18n'

export function TabIcon({ tab, className }: { tab: SideTab; className?: string }): ReactNode {
  const kind = useApp(s => (tab.type === 'tool' ? s.sessions[tab.sessionId]?.items[tab.itemId]?.tool : undefined))
  const def = usePanel(tab.type)
  switch (tab.type) {
    case 'launcher': return <LayoutGrid className={className} />
    case 'tool': return kind ? <ToolIcon kind={toolKind(kind)} className={className} /> : <LayoutList className={className} />
    case 'review': return <FileCheck2 className={className} />
    case 'change-review': return <FileCheck2 className={className} />
    case 'agent-browser': return <MonitorPlay className={className} />
    case 'file': return <FileText className={className} />
    case 'browser': return <Globe className={className} />
    case 'terminal': return <SquareTerminal className={className} />
    case 'side-chat': return <MessagesSquare className={className} />
    case 'tasks': return <ListChecks className={className} />
    case 'files': return <FolderTree className={className} />
    case 'evolution': return <Sprout className={className} />
    case 'worktree': return <GitCompareArrows className={className} />
  }
  const Icon = def?.icon ?? PanelTop
  return <Icon className={className} />
}

/** The project a 文件 / 进化 / 工作区改动 tab is bound to, when that is not the current one (null: it follows, or it is the current one). */
function otherProject(tab: SideTab, current: string | null): string | null {
  if ((tab.type !== 'files' && tab.type !== 'evolution' && tab.type !== 'worktree') || !tab.projectId || tab.projectId === current) return null
  return tab.projectId
}

/** `label · 项目名` for a tab bound to another project (just `label` while that project's name is not known). */
function withProject(label: string, tab: SideTab): string {
  const projectId = otherProject(tab, useSidePanel.getState().ctx.projectId)
  const name = projectId ? useApp.getState().projects[projectId]?.name : null
  return name ? `${label} · ${name}` : label
}

/** Human title for a tab from the current stores (not reactive; `useTabTitle` is). */
export function tabTitle(tab: SideTab): string {
  switch (tab.type) {
    case 'launcher': return tr('新标签页')
    case 'tool': {
      const tool = useApp.getState().sessions[tab.sessionId]?.items[tab.itemId]?.tool
      return tool ? `${VERBS[toolKind(tool)].done} ${basename(toolTarget(tool) || '') || ''}`.trim() : tr('工具详情')
    }
    case 'review': return tab.itemIds ? tr('审阅改动') : tr('审查')
    case 'change-review': return tr('后台改动')
    case 'agent-browser': return tr('Rna 的浏览器')
    case 'file': return basename(tab.path)
    case 'browser': return tab.title || addressLabel(tab.url) || tr('浏览器')
    case 'terminal': return tab.title || tr('终端')
    case 'side-chat': return tab.ordinal > 1 ? `${tr('辅助对话')} ${tab.ordinal}` : tr('辅助对话')
    case 'tasks': return tr('后台任务')
    case 'files': return withProject(tr('文件'), tab)
    case 'evolution': return withProject(tr('进化'), tab)
    case 'worktree': return withProject(tr('工作区改动'), tab)
  }
  return getPanel((tab as SideTab).type)?.title(tab) ?? tr('面板')
}

/** Human title for a tab; reactive to the language, the tool it shows, the project it is bound to and later panel registrations. */
export function useTabTitle(tab: SideTab): string {
  useT()
  useApp(s => (tab.type === 'tool' ? s.sessions[tab.sessionId]?.items[tab.itemId]?.tool : undefined))
  const other = useSidePanel(s => otherProject(tab, s.ctx.projectId))
  useApp(s => (other ? s.projects[other]?.name : undefined))
  usePanel(tab.type)
  return tabTitle(tab)
}
