/**
 * Openers for the workspace tab types, used by the launcher cards, the run
 * preview, deliverable cards, HTML previews and the timeline's text-selection
 * popover. `target` / `besideType` place a new tab (contract P-7).
 */
import { projectApi } from '@/api/project-api'
import { sideChatApi } from '@/api/side-panel-api'
import { useApp } from '@/store/app-store'
import { findTab, nextSideOrdinal, openTab, setSeed, updateTab, useSidePanel, type OpenOptions } from '@/store/side-panel-store'
import { toast } from '@/store/ui-store'
import { selectionSeed } from '@/lib/side-session'
import { t } from '@/i18n'

type Place = Pick<OpenOptions, 'replace' | 'target' | 'besideType'>
const place = (options: Place): OpenOptions => ({ replace: options.replace, target: options.target, besideType: options.besideType })

/** Open a URL in a built-in browser tab. `key` reuses a tab (and reloads it). */
export function openBrowserTab(url: string, options: { key?: string | null; title?: string | null } & Place = {}) {
  return openTab({ type: 'browser', url, key: options.key ?? null, title: options.title ?? null, reload: Date.now() }, place(options))
}

/** Where a run preview goes unless its caller places it: beside a 文件 panel when one is open (an adjacent group, else
 * a new one next to it), so the panel that ran it is never covered; otherwise where new tabs go. */
const BESIDE_FILES: Place = { besideType: 'files' }

/** The project's run preview (static or dev server) in its reusable browser tab. */
export function openPreviewTab(projectId: string, url: string, options: Place = BESIDE_FILES) {
  return openBrowserTab(url, { key: `preview:${projectId}`, title: t('项目预览'), ...options })
}

/** Reload the project's preview tab in place (static preview revision changed); no-op when it is not open. */
export function reloadPreviewTab(projectId: string) {
  const key = `preview:${projectId}`
  for (const tab of Object.values(useSidePanel.getState().layout.tabs)) {
    if (tab.type === 'browser' && tab.key === key) updateTab(tab.id, { reload: Date.now() })
  }
}

/** Serve an HTML file through the host's static preview and open it in the preview tab, beside a 文件 panel when one is open. */
export async function openHtmlInBrowser(projectId: string, path: string) {
  try {
    const result = await projectApi.startPreview(projectId, { mode: 'static', path }, AbortSignal.timeout(30_000))
    if (result.status !== 'ready' || !result.url) throw new Error(t('暂未找到可运行的预览入口。'))
    openPreviewTab(projectId, result.url)
  } catch (e) {
    toast((e as Error).message || t('无法启动预览'), 'danger')
  }
}

/** A new terminal tab for the project (the tab creates the host terminal once it can measure its size). */
/** `sessionId`: a worktree conversation the terminal starts in (lib/session-root `readSessionFor`); else the project folder. */
export function openTerminalTab(projectId: string, options: Place = {}, sessionId?: string | null) {
  return openTab({ type: 'terminal', projectId, terminalId: null, title: null, ...(sessionId ? { sessionId } : {}) }, place(options))
}

/**
 * Open a new 辅助对话 for `parentSessionId`, optionally seeded with a text
 * selection from an assistant message. The side session is created here;
 * the tab shows a pending state until the host answers.
 */
export function openSideChat(parentSessionId: string, selection?: { text: string; itemId?: string | null } | null, options: Place = {}) {
  if (!useApp.getState().capabilities?.sideChat) { toast(t('当前的 Rna 服务暂不支持辅助对话。')); return null }
  const text = selectionSeed(selection?.text)
  const seed = text ? { text, itemId: selection?.itemId ?? null } : null
  const id = openTab({ type: 'side-chat', parentSessionId, sideSessionId: null, title: null, ordinal: nextSideOrdinal() }, place(options))
  if (seed) setSeed(id, seed)
  createSideSession(id, parentSessionId, seed).catch(() => { /* the tab shows the failure with a retry */ })
  return id
}

/** Re-open an existing side chat (e.g. from a promoted note), keeping its tab number. */
export function openExistingSideChat(parentSessionId: string, sideSessionId: string) {
  const tab = Object.values(useSidePanel.getState().layout.tabs).find(t => t.type === 'side-chat' && t.sideSessionId === sideSessionId)
  return openTab({ type: 'side-chat', parentSessionId, sideSessionId, ordinal: tab?.type === 'side-chat' ? tab.ordinal : nextSideOrdinal() })
}

const creating = new Map<string, Promise<void>>()

/** Create the host side session for a pending tab (once, even across remounts). */
export function createSideSession(tabId: string, parentSessionId: string, seed: { text: string; itemId?: string | null } | null): Promise<void> {
  const pending = creating.get(tabId)
  if (pending) return pending
  const run = (async () => {
    try {
      const summary = await sideChatApi.create(parentSessionId, seed)
      if (findTab(tabId)) updateTab(tabId, { sideSessionId: summary.id })
    } finally {
      creating.delete(tabId)
    }
  })()
  creating.set(tabId, run)
  return run
}
