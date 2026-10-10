/**
 * 工作区改动 (worktree) as a workspace panel (layout plan §3, worktree design
 * §3.9). A tab with a `projectId` belongs to that project; without one it
 * follows the current project. Its comparison — mode, base branch, target
 * worktree, whether the file tree shows, grouping by stage, wrap and line
 * numbers — is kept with the tab. An old-style `source` on the tab (a caller
 * asking for 本次任务 / 未暂存 / … through `openWorktree`) is shown at once and
 * written into those fields. The way in is `openWorktree` (worktree-open.ts). 本次对话的改动 stays only when the user
 * picked it from the comparison menu (`rnaPicked`); a tab that got it from the old 本次任务 default opens on the
 * default comparison (全部改动 in a repository) from its first render.
 *
 * 0.63 (worktree design §9): when the selected conversation runs in its own worktree of this project, the panel
 * shows that worktree by default (未提交的改动 there = what the conversation has not applied yet); 返回项目文件夹
 * keeps the project folder for this conversation.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitCompareArrows } from 'lucide-react'
import { updateTab, worktreeMode, worktreeSourceFields, worktreeView, type SideTab, type WorktreeTabFields } from '@/store/side-panel-store'
import { useApp } from '@/store/app-store'
import { sessionWorktreeRow, useWorktrees } from '@/store/isolation-store'
import { WorktreePanel } from '@/components/panels/worktree/WorktreePanel'
import { t } from '@/i18n'
import { registerPanel, type PanelContext } from './registry'

type WorktreeTabData = Extract<SideTab, { type: 'worktree' }>

/** The selected conversation's own worktree in `projectId` (its path), while it has one there. */
export function useConversationWorktree(projectId: string | null, sessionId: string | null): string | null {
  const facts = useApp(s => {
    const meta = sessionId ? s.sessions[sessionId]?.meta ?? s.sessionIndex[sessionId] : undefined
    return meta?.worktree && meta.projectId === projectId ? meta.worktree.id : null
  })
  const list = useWorktrees(projectId, { enabled: facts !== null }).data
  if (!facts || !sessionId) return null
  const row = sessionWorktreeRow(list, sessionId, facts)
  return row && row.state !== 'removed' && row.state !== 'missing' ? row.path : null
}

function WorktreeTab({ tab, ctx }: { tab: WorktreeTabData; ctx: PanelContext }) {
  const projectId = tab.projectId ?? ctx.projectId
  const { base, target: tabTarget, tree, grouped, wrap, numbers, source } = tab
  // 本次对话的改动 stays only as the user's own pick; the old switch's default gives way to the default comparison.
  const tabMode = worktreeMode(tab)
  // A worktree conversation's panel shows its own copy unless the user went back to the project folder for it.
  const conversation = useConversationWorktree(projectId, ctx.sessionId)
  const [folderFor, setFolderFor] = useState<string | null>(null)
  const byDefault = Boolean(conversation && !tabTarget && folderFor !== ctx.sessionId)
  const target = byDefault ? conversation : tabTarget
  const mode = byDefault && !tabMode ? 'uncommitted' : tabMode
  // A tab that follows the current project keeps its mode and how diffs read, but not the base branch or the worktree
  // picked in the project it showed before (they name that repository's branch and folder): from the first render here.
  const [shownProject, setShownProject] = useState(projectId)
  const moved = !tab.projectId && shownProject !== null && shownProject !== projectId
  const fields = useMemo(() => worktreeView({ mode, rnaPicked: mode === 'rna', base: moved ? null : base, target: moved ? null : target, tree, grouped, wrap, numbers, source }),
    [mode, base, target, moved, tree, grouped, wrap, numbers, source])
  useEffect(() => {
    if (shownProject === projectId) return
    setShownProject(projectId)
    if (moved && (base || target)) updateTab(tab.id, { base: null, target: null })
  }, [shownProject, projectId, moved, base, target, tab.id])
  // A requested old-style source becomes the tab's fields (and stops overriding them).
  useEffect(() => { if (source && worktreeSourceFields(source)) updateTab(tab.id, { ...fields, source: null }) }, [source, fields, tab.id])
  const session = ctx.sessionId
  const change = useCallback((patch: WorktreeTabFields) => {
    if ('target' in patch && !patch.target) setFolderFor(session)
    updateTab(tab.id, { ...patch, source: null })
  }, [tab.id, session])
  return (
    <WorktreePanel key={projectId ?? 'none'} projectId={projectId} sessionId={ctx.sessionId} following={!tab.projectId} visible={ctx.visible}
      fields={fields} onChange={change} tabId={tab.id} sessionWorktree={conversation} />
  )
}

registerPanel({
  type: 'worktree', binding: 'project', icon: GitCompareArrows, title: () => t('工作区改动'),
  render: (tab, ctx) => (tab.type === 'worktree' ? <WorktreeTab tab={tab} ctx={ctx} /> : null),
})
