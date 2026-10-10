/**
 * Rename / archive / restore / delete for projects and sessions. Same routes
 * and payloads as public/app.js; the local index is patched immediately and
 * the v2 index stream then confirms (or corrects) it.
 */
import { panelsApi } from '@/api/panels'
import type { DeleteResult } from '@/api/panels-types'
import { useApp } from '@/store/app-store'
import { selectProject, selectSession, sortSessions } from '@/store/sync'
import { pendingDeletes } from '@/store/pending-deletes'
import { toast } from '@/store/ui-store'
import { openDelete, type EntityKind, type UnmergedWorker } from '@/components/settings/panel-store'
import { ApiError } from '@/api/transport'
import { t } from '@/i18n'

const get = useApp.getState
const set = useApp.setState

export function entityName(kind: EntityKind, id: string) {
  const s = get()
  return kind === 'project' ? s.projects[id]?.name ?? t('项目') : s.sessionIndex[id]?.title || t('未命名会话')
}

function patchLocal(kind: EntityKind, id: string, fields: Record<string, unknown>) {
  set(s => kind === 'project'
    ? { projects: s.projects[id] ? { ...s.projects, [id]: { ...s.projects[id], ...fields } } : s.projects }
    : {
      sessionIndex: s.sessionIndex[id] ? { ...s.sessionIndex, [id]: { ...s.sessionIndex[id], ...fields } } : s.sessionIndex,
      sessions: s.sessions[id] ? { ...s.sessions, [id]: { ...s.sessions[id], meta: { ...s.sessions[id].meta, ...fields } } } : s.sessions,
    })
}

export async function renameEntity(kind: EntityKind, id: string, value: string) {
  const field = kind === 'project' ? 'name' : 'title'
  if (kind === 'project') await panelsApi.patchProject(id, { [field]: value })
  else await panelsApi.patchSession(id, { [field]: value })
  patchLocal(kind, id, { [field]: value })
  toast(t('名称已更新。'))
}

export async function archiveEntity(kind: EntityKind, id: string, archived: boolean) {
  if (kind === 'project') await panelsApi.patchProject(id, { archived })
  else await panelsApi.patchSession(id, { archived })
  patchLocal(kind, id, { archivedAt: archived ? new Date().toISOString() : null })
  if (archived) {
    const s = get()
    const selectedGone = kind === 'session' ? s.selectedSessionId === id : s.selectedProjectId === id || (s.selectedSessionId && s.sessionIndex[s.selectedSessionId]?.projectId === id)
    if (selectedGone) {
      if (kind === 'project') selectProject(s.projectOrder.find(pid => pid !== id && !s.projects[pid]?.archivedAt) ?? null)
      else await selectSession(null)
    }
  }
  toast(archived ? t('已归档，记录和草稿已保留。可在「已归档」中恢复。') : t('已恢复。暂停的工作可按需手动继续。'))
}

export function deleteDescription(kind: EntityKind, id: string) {
  const count = kind === 'project' ? Object.values(get().sessionIndex).filter(session => session.projectId === id).length : 0
  return kind === 'project'
    ? t('永久删除此项目及其中 {count} 个会话的聊天记录和会话专属运行文件，并停止正在进行的工作。此操作无法撤销。项目文件和已提取的项目记忆不会删除。归档可保留聊天记录。', { count })
    : t('永久删除该会话的聊天记录和会话专属运行文件，并停止正在进行的工作。此操作无法撤销。项目文件和已提取的项目记忆不会删除。归档可保留聊天记录。')
}

/**
 * What a `worktree_unapplied` refusal names: the worktree's unapplied files, the workers' unmerged copies, and how
 * many of those files hold secrets (B8: they go to the trash, not into Git).
 */
function unappliedOf(details: Record<string, unknown> | undefined): { unapplied?: number; workers?: UnmergedWorker[]; secret?: number } {
  const workers = (Array.isArray(details?.workers) ? details.workers : []).filter((row): row is UnmergedWorker => Boolean(row) && typeof row === 'object' && typeof (row as UnmergedWorker).worktreeId === 'string' && Number.isFinite((row as UnmergedWorker).files))
  const unapplied = Number(details?.unapplied) || 0
  const secret = Math.max(0, Math.floor(Number(details?.secret) || 0))
  // An older host names only a count (a missing one still means "something is unapplied").
  return { ...(unapplied || !workers.length ? { unapplied: unapplied || 1 } : {}), ...(workers.length ? { workers } : {}), ...(secret ? { secret } : {}) }
}

/**
 * Delete in the background: the entity leaves the lists (and the screen, if it
 * is open) at once while the host deletes it; a failure puts it back as it was
 * and says why. The returned promise settles when the host has answered.
 */
export async function deleteEntity(kind: EntityKind, id: string, { confirm = false }: { confirm?: boolean } = {}): Promise<DeleteResult> {
  const before = get()
  const deleted = kind === 'project' ? Object.values(before.sessionIndex).filter(s => s.projectId === id).map(s => s.id) : [id]
  const kept = {
    sessionIndex: Object.fromEntries(deleted.filter(sid => before.sessionIndex[sid]).map(sid => [sid, before.sessionIndex[sid]])),
    sessions: Object.fromEntries(deleted.filter(sid => before.sessions[sid]).map(sid => [sid, before.sessions[sid]])),
    project: kind === 'project' ? before.projects[id] ?? null : null,
    projectAt: kind === 'project' ? before.projectOrder.indexOf(id) : -1,
  }
  if (kind === 'project') pendingDeletes.projects.add(id)
  for (const sid of deleted) pendingDeletes.sessions.add(sid)
  if (before.selectedSessionId && deleted.includes(before.selectedSessionId)) void selectSession(null)
  set(s => {
    const sessionIndex = { ...s.sessionIndex }
    const sessions = { ...s.sessions }
    for (const sid of deleted) { delete sessionIndex[sid]; delete sessions[sid] }
    const projects = { ...s.projects }
    if (kind === 'project') delete projects[id]
    return {
      sessionIndex, sessions, projects,
      sessionOrder: s.sessionOrder.filter(sid => !deleted.includes(sid)),
      projectOrder: kind === 'project' ? s.projectOrder.filter(pid => pid !== id) : s.projectOrder,
      selectedProjectId: kind === 'project' && s.selectedProjectId === id ? s.projectOrder.find(pid => pid !== id && !s.projects[pid]?.archivedAt) ?? null : s.selectedProjectId,
    }
  })
  try {
    const result = await panelsApi.deleteEntity(kind, id, { confirm })
    // Each draft and its sidecar (uploaded files, carried 接着完成 tasks) goes with the conversation.
    const drafts = [...deleted.map(sid => `rna.draft.${sid}`), ...(kind === 'project' ? [`rna.draft.new:${id}`] : [])]
    for (const key of drafts.flatMap(key => [key, `${key}.carry`])) try { localStorage.removeItem(key) } catch { /* ignore */ }
    // A cleanup that cannot finish on its own (blocked) says so, instead of promising it continues by itself.
    const blocked = result?.cleanup?.status === 'blocked' || (result?.cleanup?.sessions ?? []).some(row => row.status === 'blocked')
    toast(blocked ? t('已移除。有一项清理需要你决定，可在「已归档」中查看。') : result?.cleanup?.status === 'pending' ? t('已移除。聊天记录仍在清理，服务恢复后会自动继续，可在「已归档」中查看。') : kind === 'project' ? t('项目及会话记录已删除，项目文件和已提取记忆保留。') : t('会话聊天记录和会话专属运行文件已删除。'))
    return result
  } catch (error) {
    // Not deleted: back where it was.
    set(s => {
      const sessionIndex = { ...s.sessionIndex, ...kept.sessionIndex }
      const projectOrder = kept.project && !s.projectOrder.includes(id) ? [...s.projectOrder.slice(0, Math.max(0, kept.projectAt)), id, ...s.projectOrder.slice(Math.max(0, kept.projectAt))] : s.projectOrder
      return {
        sessionIndex, sessions: { ...s.sessions, ...kept.sessions },
        projects: kept.project ? { ...s.projects, [id]: kept.project } : s.projects,
        projectOrder, sessionOrder: sortSessions(Object.values(sessionIndex)).map(row => row.id),
      }
    })
    // A conversation whose own worktree still holds changes the project folder doesn't have (0.63), or whose subagent
    // workers' copies hold changes not merged yet (B8): asked again, with the count and the workers.
    if (kind === 'session' && !confirm && error instanceof ApiError && error.code === 'worktree_unapplied') openDelete({ kind, id, ...unappliedOf(error.details) })
    else toast(t('删除没有完成：{message}', { message: (error as Error).message }), 'danger')
    throw error
  } finally {
    if (kind === 'project') pendingDeletes.projects.delete(id)
    for (const sid of deleted) pendingDeletes.sessions.delete(sid)
  }
}
