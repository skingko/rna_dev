/**
 * The way into 工作区改动 (the launcher card, other panels): a panel already
 * showing the project is brought up instead of a second one; else one opens,
 * following the current project when that is the one asked for. Kept apart
 * from the panel's registration (panels-worktree.tsx), so callers do not
 * register it as a side effect.
 */
import { bindingMatches } from '@/lib/dock'
import { activateTab, closeTab, findTab, openTab, updateTab, useSidePanel, type OpenOptions, type SideTab } from '@/store/side-panel-store'
import type { WorktreeSource } from '@/components/panels/worktree/model'

type ChangesTab = Extract<SideTab, { type: 'worktree' }>

/** The 工作区改动 tab showing `projectId` in the current selection: one bound to it, or one following it. */
export function worktreeTab(projectId: string | null): ChangesTab | null {
  const { layout, ctx } = useSidePanel.getState()
  for (const tab of Object.values(layout.tabs)) {
    if (tab.type === 'worktree' && bindingMatches(tab.binding, ctx) && (tab.projectId ?? ctx.projectId) === projectId) return tab
  }
  return null
}

/**
 * Show 工作区改动 for a project (null: the current one). An open panel showing it comes up (a chooser the request came
 * from gives way); `source` picks its switch (e.g. 本次任务).
 * @returns the tab id.
 */
export function openWorktree(projectId: string | null = null, { place, source }: { place?: Pick<OpenOptions, 'replace' | 'target' | 'besideType'>; source?: WorktreeSource } = {}): string {
  const current = useSidePanel.getState().ctx.projectId
  const wanted = projectId ?? current
  const open = worktreeTab(wanted)
  if (open) {
    activateTab(open.id)
    if (source && open.source !== source) updateTab(open.id, { source })
    if (place?.replace && place.replace !== open.id && findTab(place.replace)) closeTab(place.replace)
    return open.id
  }
  return openTab({ type: 'worktree', projectId: wanted === current ? null : wanted, ...(source ? { source } : {}) }, place)
}
