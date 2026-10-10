/**
 * The tab types the side panel had, registered as workspace panels from their
 * existing bodies (contract P-6). The retired session overview is not one of
 * them (design 1.1); 后台任务 (`tasks`) registers from its own module.
 * Imported once by the workspace host for these side effects.
 */
import { lazy, Suspense } from 'react'
import { FileCheck2, FileText, Globe, LayoutGrid, LayoutList, MessagesSquare, MonitorPlay, SquareTerminal } from 'lucide-react'
import { onTabClosed, type SideTab } from '@/store/side-panel-store'
import { terminalApi } from '@/api/side-panel-api'
import { Launcher } from '@/components/side-panel/Launcher'
import { ChangeReview, FileTab, Review, ToolDetail } from '@/components/side-panel/DetailTabs'
import { AgentBrowserTab } from '@/components/side-panel/AgentBrowserTab'
import { BrowserTab } from '@/components/side-panel/BrowserTab'
import { SideChatTab } from '@/components/side-panel/SideChatTab'
import { tabTitle } from '@/components/side-panel/tab-meta'
import { registerPanel, type PanelDefinition } from './registry'

const TerminalTab = lazy(() => import('@/components/side-panel/TerminalTab'))

type Of<K extends SideTab['type']> = Extract<SideTab, { type: K }>

/** A definition whose body takes the tab of its own type. */
function define<K extends SideTab['type']>(type: K, def: Omit<PanelDefinition, 'type' | 'title' | 'render'> & { render: (tab: Of<K>, ctx: Parameters<PanelDefinition['render']>[1]) => ReturnType<PanelDefinition['render']> }) {
  registerPanel({ ...def, type, title: tabTitle, render: (tab, ctx) => def.render(tab as Of<K>, ctx) })
}

define('launcher', { icon: LayoutGrid, binding: 'workspace', render: (tab, ctx) => <Launcher tabId={tab.id} groupId={ctx.groupId} sessionId={ctx.sessionId} projectId={ctx.projectId} /> })
define('tool', { icon: LayoutList, binding: 'session', render: tab => <ToolDetail sessionId={tab.sessionId} itemId={tab.itemId} /> })
define('review', { icon: FileCheck2, binding: 'session', render: tab => <Review sessionId={tab.sessionId} itemIds={tab.itemIds} focus={tab.focus} turnId={tab.turnId} focusPath={tab.focusPath} /> })
define('file', { icon: FileText, binding: 'project', render: tab => <FileTab key={`${tab.projectId}:${tab.path}:${tab.sessionId ?? ''}`} projectId={tab.projectId} path={tab.path} sessionId={tab.sessionId ?? null} /> })
define('change-review', { icon: FileCheck2, binding: 'project', render: tab => <ChangeReview key={tab.changeId} projectId={tab.projectId} changeId={tab.changeId} focus={tab.focus} /> })
define('agent-browser', { icon: MonitorPlay, binding: 'session', keepAlive: true, render: (tab, ctx) => <AgentBrowserTab tab={tab} active={ctx.visible} /> })
// A run preview (`preview:<projectId>` key) belongs to its project; any other page shows everywhere.
define('browser', { icon: Globe, binding: 'workspace', keepAlive: true, render: (tab, ctx) => <BrowserTab tab={tab} active={ctx.visible} /> })
define('terminal', {
  icon: SquareTerminal, binding: 'project', keepAlive: true,
  render: (tab, ctx) => <Suspense fallback={<div className="min-h-0 flex-1 bg-inset" />}><TerminalTab tab={tab} active={ctx.visible} /></Suspense>,
})
define('side-chat', { icon: MessagesSquare, binding: 'session', keepAlive: true, render: (tab, ctx) => <SideChatTab tab={tab} active={ctx.visible} /> })

// Closing a terminal tab ends its host terminal (the shell would otherwise linger).
onTabClosed(tab => {
  if (tab.type === 'terminal' && tab.terminalId) void terminalApi.remove(tab.terminalId).catch(() => {})
})
