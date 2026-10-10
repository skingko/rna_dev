/**
 * Panels registered beyond the side panel's own types (contract P-6). Today:
 * 后台任务 (`tasks`), one tab per window bound to the workspace and filtered
 * by project inside; what it opens goes beside it (tasks-panel.ts). Imported
 * once by the app for these side effects.
 */
import { useCallback } from 'react'
import { ListChecks } from 'lucide-react'
import { findTab, updateTab, type SideTab } from '@/store/side-panel-store'
import { BackgroundTasksPanel } from '@/components/panels/tasks/BackgroundTasksPanel'
import { t } from '@/i18n'
import { registerPanel, type PanelContext } from './registry'
import { openFromTasks } from './tasks-panel'
import './panels-files'
import './panels-worktree'

function TasksPanel({ tab, ctx }: { tab: Extract<SideTab, { type: 'tasks' }>; ctx: PanelContext }) {
  // The focus is one-off: dropped once the panel has brought the run into view (however late its row arrives), so the
  // same run can be pointed at again. It is never written, so a reload does not replay it either.
  const applied = useCallback((runId: string) => {
    const current = findTab(tab.id)
    if (current?.type === 'tasks' && current.focusRunId === runId) updateTab(tab.id, { focusRunId: null })
  }, [tab.id])
  return (
    <BackgroundTasksPanel projectFilter={tab.projectFilter} focusRunId={tab.focusRunId} currentProjectId={ctx.projectId} visible={ctx.visible}
      onOpenTab={openFromTasks} onFilterChange={next => updateTab(tab.id, { projectFilter: next })} onFocusApplied={applied} />
  )
}

registerPanel({
  type: 'tasks', binding: 'workspace', icon: ListChecks, title: () => t('后台任务'),
  render: (tab, ctx) => (tab.type === 'tasks' ? <TasksPanel tab={tab} ctx={ctx} /> : null),
})
