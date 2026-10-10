/**
 * The one opener for "show me this file": deliverable cards, presented files,
 * Markdown links and the review dock all call `openFilePreview`, which shows
 * the file in the right dock's unified preview.
 */
import { useApp } from '@/store/app-store'
import { openDock, toast } from '@/store/ui-store'
import { toWorkspacePath } from './registry'
import { readSessionFor, rootsFor } from '@/lib/session-root'
import { projectApi, type PreviewStatus } from '@/api/project-api'
import { clearPreviewStopped, openPreview, startPreviewOnce } from '@/store/preview-store'
import { previewUrlFor, validPreviewUrl } from '@/lib/preview-url'
import { t } from '@/i18n'

/**
 * Open a project file in the dock preview.
 * @param projectId - owning project.
 * @param path - workspace-relative, or absolute inside the project's workspace (or the conversation's worktree).
 * @param fallback - called instead of the explanatory toast when the path is outside the workspace.
 * @param sessionId - the conversation the path comes from: a worktree conversation's files are read from its own copy
 *   (worktree design §9), and its absolute paths are resolved against that copy first. Absent: the project folder.
 * @returns false when the path is outside the workspace.
 */
export function openFilePreview(projectId: string, path: string, fallback?: () => void, sessionId?: string | null): boolean {
  const roots = sessionId ? rootsFor(projectId, sessionId) : [useApp.getState().projects[projectId]?.workspacePath ?? ''].filter(Boolean)
  const relative = toWorkspacePath(path, roots)
  if (!relative) {
    if (fallback) fallback()
    else toast(t('无法预览：文件不在项目目录内。'), 'danger')
    return false
  }
  const reader = readSessionFor(projectId, sessionId)
  // HTML is an app, not a document: run it like the 文件 view does (scripts, modules, assets) in the
  // built-in browser. Only a project without a runnable preview falls back to the static, script-free view.
  // A worktree conversation's page is not in the project folder yet: shown statically from its copy.
  if (/\.html?$/i.test(relative) && !reader) { void openHtmlRun(projectId, relative); return true }
  openDock({ kind: 'file', projectId, path: relative, ...(reader ? { sessionId: reader } : {}) })
  return true
}

/**
 * The project's run preview, ready: one already running is used at once (nothing is held for this quick check);
 * otherwise it is started with a lasting notice while the host boots the service. A start already under way for the
 * project (运行预览 in the 文件 view, another HTML file) is shared, not sent again: the caller says the preview is
 * still starting and gets the same result, so a second file opens too once it is ready.
 */
async function readyPreview(projectId: string): Promise<PreviewStatus> {
  const status = await projectApi.preview(projectId, AbortSignal.timeout(4000))
  if (status.status === 'ready') return status
  clearPreviewStopped(projectId)
  const { result, joined } = startPreviewOnce(projectId, useApp.getState().selectedSessionId)
  if (joined) { toast(t('预览正在启动，请稍候…')); return result }
  const close = toast(t('正在启动预览…'), 'default', { durationMs: 65_000 })
  try { return await result } finally { close() }
}

/** The project's run preview as it is now: a recorded preview URL goes stale when the service restarts
 * (new port), so ask the host, start it when needed, and only then fall back to the recorded URL. Like every
 * run preview it opens beside a 文件 panel when one is open (`openPreview`), never over it. */
export async function openProjectPreview(projectId: string, recorded?: string) {
  try {
    const status = await readyPreview(projectId)
    const url = status.status === 'ready' && validPreviewUrl(status.url) ? status.url : null
    if (url) return openPreview(projectId, url)
  } catch { /* fall back below */ }
  if (recorded) openPreview(projectId, recorded); else toast(t('暂未找到可运行的预览入口。'), 'danger')
}

/** HTML files being opened (project + path): clicking the same one again meanwhile only says it is still starting. */
const opening = new Set<string>()

async function openHtmlRun(projectId: string, path: string) {
  const key = `${projectId}\u0000${path}`
  if (opening.has(key)) { toast(t('预览正在启动，请稍候…')); return }
  opening.add(key)
  // The static view shows the page without running its scripts; say why it is shown instead.
  const staticView = (reason: string) => { toast(reason); openDock({ kind: 'file', projectId, path }) }
  try {
    let status = await readyPreview(projectId)
    if (status.status !== 'ready') status = await projectApi.startPreview(projectId, { mode: 'static', path }, AbortSignal.timeout(30000))
    const url = status.status === 'ready' ? previewUrlFor(status, path) : null
    if (url) openPreview(projectId, url); else staticView(t('暂未找到可运行的预览入口，已改为静态查看（不运行脚本）。'))
  } catch (e) { staticView(t('预览未能启动，已改为静态查看（不运行脚本）。{message}', { message: (e as Error).message })) }
  finally { opening.delete(key) }
}
