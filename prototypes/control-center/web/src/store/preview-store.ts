/**
 * The project run preview, one copy per project (design 4.4). The 文件 page
 * and a 文件 panel can both show a project: they subscribe here instead of
 * each polling. While at least one subscriber is visible, the host's preview
 * state is read every 1.5 s (never trusting URLs from model text) and, when no
 * preview runs, the read-only discovery is probed every 2 s for an automatic
 * start (legacy files-ui.js `ensurePreview({ automatic: true })`): never after
 * the user stopped or dismissed the project's preview (kept for the page
 * session), never while the window is hidden, at most once per `RETRY_MS`.
 * Discovery cannot grant command permission — the host still enforces project
 * permissions. With no visible subscriber nothing runs; with none at all the
 * project's state is dropped after a short grace (a remount keeps it).
 *
 * A newly discovered preview opens in the built-in browser once per page
 * session (closing the tab keeps it closed until the service restarts); a
 * static preview whose files changed reloads that tab once, and `revision`
 * counts those changes so each surface reloads its own tree and open file.
 *
 * Starts are shared too: 运行预览, an opened HTML file and the automatic start
 * all go through `startPreviewOnce` (a dev service can take ~20 s to boot).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { getTransport } from '@/api/client'
import { projectApi, type PreviewStatus } from '@/api/project-api'
import { openPreviewTab, reloadPreviewTab } from '@/components/side-panel/open'
import { validPreviewUrl } from '@/lib/preview-url'
import { t } from '@/i18n'
import { toast } from './ui-store'

export const POLL_MS = 1500
export const PROBE_MS = 2000
export const RETRY_MS = 12_000
/** How long a project's state outlives its last subscriber (a surface remounting keeps it). */
export const DROP_MS = 1000

export type ReadyPreview = PreviewStatus & { url: string }
export interface ProjectPreview {
  /** The running preview the host reports, or null. */
  preview: ReadyPreview | null
  /** One line on how it runs (or why it cannot be checked). */
  note: string
  /** Bumped when a running preview reports changed files: each surface re-reads its tree and open file. */
  revision: number
}

const EMPTY: ProjectPreview = Object.freeze({ preview: null, note: '', revision: 0 })

export const usePreviews = create<{ projects: Record<string, ProjectPreview> }>(() => ({ projects: {} }))

/** The project's preview state (EMPTY when nobody watches it). */
export const useProjectPreview = (projectId: string) => usePreviews(s => s.projects[projectId] ?? EMPTY)
const stateOf = (projectId: string) => usePreviews.getState().projects[projectId] ?? EMPTY

export const statusText = (v: PreviewStatus) => v.kind === 'vite'
  ? t('Vite 开发服务 · 热更新已启用 · {v}', { v: v.entryPath || t('项目根目录') })
  : t('静态预览 · 文件变化自动刷新 · {entryPath}{v}{v2}', { entryPath: v.entryPath, v: v.watchTruncated ? t(' · 部分资源需手动刷新') : '', v2: v.watchError ? t(' · 自动更新暂不可用，可手动刷新') : '' })

/* ------------------------------------------------------------ starting */

const userStopped = new Set<string>()
/** The user stopped or dismissed the preview: no automatic start for this project until they start one. */
export function markPreviewStopped(projectId: string) { userStopped.add(projectId) }
/** A manual start re-enables automatic restarts. */
export function clearPreviewStopped(projectId: string) { userStopped.delete(projectId) }
export const previewStoppedByUser = (projectId: string) => userStopped.has(projectId)

/** Starts in flight per project, and who watches them (the 文件 surfaces' 运行预览 button). */
const inflight = new Map<string, Promise<PreviewStatus>>()
const startWatchers = new Set<() => void>()
const startsChanged = () => { for (const watcher of startWatchers) watcher() }
const watchStarts = (watcher: () => void) => { startWatchers.add(watcher); return () => { startWatchers.delete(watcher) } }

/**
 * Start the project's run preview (`mode: 'auto'`) once. The 文件 surfaces' 运行预览, an opened HTML file and the
 * automatic start all start here: asked while a start for the project is still booting, the caller shares that start
 * (`joined`) and its result instead of sending a second one.
 */
export function startPreviewOnce(projectId: string, sessionId: string | null): { result: Promise<PreviewStatus>; joined: boolean } {
  const current = inflight.get(projectId)
  if (current) return { result: current, joined: true }
  const result = projectApi.startPreview(projectId, { mode: 'auto', ...(sessionId ? { sessionId } : {}) }, AbortSignal.timeout(30_000))
    .finally(() => { inflight.delete(projectId); startsChanged() })
  inflight.set(projectId, result); startsChanged()
  return { result, joined: false }
}

/** True while a start for the project is in flight, from any entry point. */
export function usePreviewStarting(projectId: string) {
  return useSyncExternalStore(watchStarts, () => inflight.has(projectId))
}

interface Discovery { status?: string; preferred?: string | null; candidates?: { id: string; available?: boolean }[] }
/** True when the host reports a preferred, available entry. */
export function runnable(discovery: Discovery | null | undefined) {
  const preferred = discovery?.candidates?.find(row => row.id === discovery.preferred)
  return Boolean(preferred?.available)
}

async function discover(projectId: string, sessionId: string | null): Promise<Discovery | null> {
  try {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const result = await getTransport().request<Discovery & { discovery?: Discovery }>(`/api/projects/${encodeURIComponent(projectId)}/preview/discovery${query}`, { signal: AbortSignal.timeout(5000) })
    return result.discovery ?? result
  } catch { return null }
}

/* ------------------------------------------------------------- watching */

interface Subscriber { visible: boolean; sessionId: string | null; stamp: number }
interface Watch {
  subs: Map<number, Subscriber>
  poll: ReturnType<typeof setInterval> | null
  probe: ReturnType<typeof setInterval> | null
  drop: ReturnType<typeof setTimeout> | null
  /** The host has answered (or failed) once: probing waits for it, so a running preview is never probed for. */
  checked: boolean
  /** A status read / an automatic start attempt is in flight. */
  polling: boolean
  probing: boolean
  lastProbe: number
}

const watches = new Map<string, Watch>()
/** Preview identities (generation / URL) already opened in the built-in browser, per project, for the page session. */
const opened = new Map<string, Set<string>>()
let seq = 0

/**
 * The project's preview tab (key `preview:<projectId>`): next to a 文件 panel when one is open, so the panel that ran
 * it is not covered by it; otherwise where new tabs go.
 */
export const openPreview = (projectId: string, url: string) => openPreviewTab(projectId, url, { besideType: 'files' })

const openedOf = (projectId: string) => {
  let set = opened.get(projectId)
  if (!set) { set = new Set(); opened.set(projectId, set) }
  return set
}

function patch(projectId: string, next: Partial<ProjectPreview>) {
  const before = stateOf(projectId)
  usePreviews.setState(s => ({ projects: { ...s.projects, [projectId]: { ...before, ...next } } }))
  // Whether a preview runs decides whether the automatic start probes.
  if (Boolean(before.preview) !== Boolean(stateOf(projectId).preview)) sync(projectId)
}

/** The session of the visible subscriber that spoke last (a dev preview starts for its conversation). */
function sessionOf(watch: Watch): string | null {
  let best: Subscriber | null = null
  for (const sub of watch.subs.values()) if (sub.visible && (!best || sub.stamp > best.stamp)) best = sub
  return best?.sessionId ?? null
}

/**
 * Start or stop the reads to match who watches: polling while anyone visible watches, probing while nothing runs too.
 * The first read waits for the current task, so surfaces mounting together (a page and a panel) share it; probing
 * starts once that read has answered.
 */
function sync(projectId: string) {
  const watch = watches.get(projectId)
  if (!watch) return
  const visible = [...watch.subs.values()].some(sub => sub.visible)
  if (visible && !watch.poll) {
    watch.poll = setInterval(() => void tick(projectId, watch), POLL_MS)
    queueMicrotask(() => { if (watch.poll) void tick(projectId, watch) })
  } else if (!visible && watch.poll) { clearInterval(watch.poll); watch.poll = null }
  const probing = visible && watch.checked && !stateOf(projectId).preview
  if (probing && !watch.probe) {
    watch.probe = setInterval(() => void attempt(projectId, watch), PROBE_MS)
    queueMicrotask(() => { if (watch.probe) void attempt(projectId, watch) })
  } else if (!probing && watch.probe) { clearInterval(watch.probe); watch.probe = null }
}

/** Read the host's preview state once (H4: never trust URLs from model text). */
async function tick(projectId: string, watch: Watch) {
  if (watch.polling || document.visibilityState === 'hidden') return
  watch.polling = true
  try {
    const result = await projectApi.preview(projectId, AbortSignal.timeout(4000))
    if (watches.get(projectId) !== watch) return
    const current = stateOf(projectId).preview
    if (result.status !== 'ready') {
      if (current) patch(projectId, { preview: null, note: t('预览服务已停止，可使用顶部预览按钮重新启动。') })
      return
    }
    if (userStopped.has(projectId) || !validPreviewUrl(result.url)) return
    const identity = result.generation ?? result.url
    if (!current || current.url !== result.url) {
      patch(projectId, { preview: result as ReadyPreview, note: statusText(result) })
      // A newly discovered preview opens in the built-in browser once; closing the tab keeps it closed.
      const seen = openedOf(projectId)
      if (!seen.has(identity)) { seen.add(identity); openPreview(projectId, result.url) }
      return
    }
    const changed = result.revision !== current.revision
    const next = { ...current, ...result } as ReadyPreview, note = statusText(result)
    // Most reads say the same thing again: nothing is written, so the surfaces showing it do not render every 1.5 s.
    if (!changed && note === stateOf(projectId).note && JSON.stringify(next) === JSON.stringify(current)) return
    patch(projectId, { preview: next, note, ...(changed ? { revision: stateOf(projectId).revision + 1 } : {}) })
    // Static previews reload the document (once, whoever watches); Vite owns its own HMR.
    if (changed && result.kind === 'static') reloadPreviewTab(projectId)
  } catch { if (watches.get(projectId) === watch && stateOf(projectId).preview) patch(projectId, { note: t('暂时无法核对预览服务状态。') }) }
  finally {
    watch.polling = false
    if (!watch.checked) { watch.checked = true; sync(projectId) }
  }
}

/** One automatic start attempt: discovery first, a start only for a preferred, available entry. */
async function attempt(projectId: string, watch: Watch) {
  // A start already under way (运行预览 or an opened HTML file) brings the preview up; the poll picks it up.
  if (watch.probing || stateOf(projectId).preview || userStopped.has(projectId) || inflight.has(projectId) || document.visibilityState === 'hidden' || Date.now() - watch.lastProbe < RETRY_MS) return
  watch.probing = true; watch.lastProbe = Date.now()
  try {
    const sessionId = sessionOf(watch)
    const discovery = await discover(projectId, sessionId)
    if (watches.get(projectId) !== watch || userStopped.has(projectId) || !runnable(discovery)) return
    const result = await startPreviewOnce(projectId, sessionId).result
    if (watches.get(projectId) === watch && !userStopped.has(projectId) && result.status === 'ready') showPreview(projectId, result)
  } catch { /* automatic: stay silent, the manual button reports errors */ } finally { watch.probing = false }
}

export interface PreviewWatch {
  /** The subscriber is shown or hidden, or its conversation changed. */
  update: (next: { visible: boolean; sessionId: string | null }) => void
  release: () => void
}

/** Watch a project's preview (ref-counted per project; see the file comment). */
export function watchPreview(projectId: string, init: { visible: boolean; sessionId: string | null }): PreviewWatch {
  let watch = watches.get(projectId)
  if (!watch) {
    watch = { subs: new Map(), poll: null, probe: null, drop: null, checked: false, polling: false, probing: false, lastProbe: 0 }
    watches.set(projectId, watch)
  }
  if (watch.drop) { clearTimeout(watch.drop); watch.drop = null }
  const id = ++seq, own = watch
  own.subs.set(id, { visible: init.visible, sessionId: init.sessionId, stamp: ++seq })
  sync(projectId)
  return {
    update(next) {
      const sub = own.subs.get(id)
      if (!sub || (sub.visible === next.visible && sub.sessionId === next.sessionId)) return
      own.subs.set(id, { visible: next.visible, sessionId: next.sessionId, stamp: ++seq })
      sync(projectId)
    },
    release() {
      if (!own.subs.delete(id)) return
      sync(projectId)
      if (own.subs.size || watches.get(projectId) !== own) return
      own.drop = setTimeout(() => {
        if (watches.get(projectId) !== own || own.subs.size) return
        watches.delete(projectId)
        usePreviews.setState(s => {
          if (!(projectId in s.projects)) return s
          const projects = { ...s.projects }
          delete projects[projectId]
          return { projects }
        })
      }, DROP_MS)
    },
  }
}

/** A surface's subscription: watched while mounted, counted as visible while `visible`. */
export function usePreviewWatch(projectId: string, sessionId: string | null, visible: boolean): ProjectPreview {
  const handle = useRef<PreviewWatch | null>(null)
  const latest = useRef({ visible, sessionId })
  latest.current = { visible, sessionId }
  useEffect(() => {
    const own = watchPreview(projectId, latest.current)
    handle.current = own
    return () => { own.release(); if (handle.current === own) handle.current = null }
  }, [projectId])
  useEffect(() => { handle.current?.update({ visible, sessionId }) }, [visible, sessionId])
  return useProjectPreview(projectId)
}

/* ------------------------------------------------------------- actions */

/**
 * Show a ready preview in the side panel's built-in browser (reusing the project's preview tab, see `openPreview`);
 * a manual start also re-enables automatic restarts.
 * @throws when the host's answer is not a ready, isolated local service.
 */
export function showPreview(projectId: string, result: PreviewStatus): ReadyPreview {
  if (result.status !== 'ready' || !validPreviewUrl(result.url)) throw new Error(t('预览必须使用独立的本机服务地址。'))
  clearPreviewStopped(projectId)
  openedOf(projectId).add(result.generation ?? result.url)
  if (watches.has(projectId)) patch(projectId, { preview: result as ReadyPreview, note: statusText(result) })
  openPreview(projectId, result.url)
  return result as ReadyPreview
}

/** The user stops the preview: no automatic start for the project until they start one again. */
export async function stopPreview(projectId: string) {
  markPreviewStopped(projectId)
  try {
    await projectApi.stopPreview(projectId)
    if (watches.has(projectId)) patch(projectId, { preview: null })
    toast(t('预览服务已停止。'))
  } catch (e) { toast((e as Error).message, 'danger') }
}

/* --------------------------------------------------------------- tests */

/** What runs for a project (tests and diagnostics). */
export function previewActivity(projectId: string) {
  const watch = watches.get(projectId)
  return { subscribers: watch?.subs.size ?? 0, visible: watch ? [...watch.subs.values()].filter(sub => sub.visible).length : 0, polling: Boolean(watch?.poll), probing: Boolean(watch?.probe) }
}

/** Test helper: stop everything and forget every project. */
export function resetPreviews() {
  for (const watch of watches.values()) {
    if (watch.poll) clearInterval(watch.poll)
    if (watch.probe) clearInterval(watch.probe)
    if (watch.drop) clearTimeout(watch.drop)
  }
  watches.clear(); opened.clear(); userStopped.clear(); inflight.clear()
  usePreviews.setState({ projects: {} })
}
