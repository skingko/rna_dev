/**
 * P3 project inbox state: the entry list per project (read lazily by the
 * 收件箱 view), inbox actions with optimistic unread counts, `notify` events
 * from the index stream and desktop-notification click routing.
 */
import { create } from 'zustand'
import { communicationApi, type InboxEntry, type InboxFilter, type InboxList, type NotifyEvent } from '@/api/communication-api'
import { notificationRoute } from '@/lib/communication'
import type { NotificationTarget } from '@/lib/desktop'
import { useApp } from './app-store'
import { supportApi } from '@/api/support-api'
import { focusTimelineItem } from '@/components/timeline/timeline-focus'
import { onNotify, selectProject, selectSession } from './sync'
import { toast, useUi } from './ui-store'
import { t } from '@/i18n'

export interface ProjectInbox {
  filter: InboxFilter
  /** `null` while loading the first time; `'unsupported'` on daemons without P3. */
  list: InboxList | null | 'unsupported'
  error: string | null
}

interface InboxState {
  projects: Record<string, ProjectInbox>
  /** Entry to scroll to / highlight after a notification click. */
  focus: { projectId: string; entryId: string } | null
  busy: string | null
}

export const useInbox = create<InboxState>(() => ({ projects: {}, focus: null, busy: null }))
const set = useInbox.setState
const get = useInbox.getState

const EMPTY: ProjectInbox = { filter: 'active', list: null, error: null }
const patchProject = (projectId: string, patch: Partial<ProjectInbox>) =>
  set(s => ({ projects: { ...s.projects, [projectId]: { ...EMPTY, ...s.projects[projectId], ...patch } } }))

/** Mirror the server's unread count into the project summary (the index stream will confirm). */
export function setUnread(projectId: string, unread: number) {
  useApp.setState(s => {
    const project = s.projects[projectId]
    if (!project || project.counts?.inboxUnread === unread) return {}
    return { projects: { ...s.projects, [projectId]: { ...project, counts: { ...project.counts, inboxUnread: unread } } } }
  })
}

let epoch = 0
export async function loadInbox(projectId: string, filter?: InboxFilter) {
  const current = get().projects[projectId]
  const next = filter ?? current?.filter ?? 'active'
  if (filter && filter !== current?.filter) patchProject(projectId, { filter, list: current?.list === 'unsupported' ? 'unsupported' : current?.list ?? null })
  const mine = ++epoch
  try {
    const list = await communicationApi.inbox(projectId, next)
    if (mine !== epoch) return
    patchProject(projectId, { filter: next, list: list ?? 'unsupported', error: null })
    if (list) setUnread(projectId, list.unread)
  } catch (error) {
    if (mine === epoch) patchProject(projectId, { error: (error as Error).message })
  }
}

export function replaceEntry(projectId: string, entry: InboxEntry, unread: number) {
  const state = get().projects[projectId]
  if (state && state.list && state.list !== 'unsupported') {
    const hidden = (state.filter === 'active' && entry.status === 'dismissed') || (['unread', 'read', 'dismissed'].includes(state.filter) && entry.status !== state.filter)
    const entries = hidden ? state.list.entries.filter(e => e.id !== entry.id) : state.list.entries.map(e => (e.id === entry.id ? entry : e))
    patchProject(projectId, { list: { ...state.list, unread, entries, total: state.list.total - (state.list.entries.length - entries.length) } })
  }
  setUnread(projectId, unread)
}

export async function inboxAction(projectId: string, entryId: string, action: 'read' | 'dismiss' | 'act') {
  if (get().busy) return
  set({ busy: entryId })
  try {
    const result = await communicationApi.act(projectId, entryId, action)
    replaceEntry(projectId, result.entry, result.unread)
    if (action === 'dismiss') toast(t('已忽略这条消息，之后不再提醒。'))
    else if (action === 'act') toast(t('已记录为已处理。'))
  } catch (error) {
    toast((error as Error).message, 'danger')
    void loadInbox(projectId)
  } finally { set({ busy: null }) }
}

export async function readAllInbox(projectId: string) {
  set({ busy: 'all' })
  try {
    const result = await communicationApi.readAll(projectId)
    setUnread(projectId, result.unread)
    await loadInbox(projectId)
    toast(t('已全部标为已读。'))
  } catch (error) { toast((error as Error).message, 'danger') } finally { set({ busy: null }) }
}

/** In-app echo of a `notify` delivery; the desktop shell shows the native notification. */
export function handleNotify(event: NotifyEvent) {
  const project = useApp.getState().projects[event.projectId]
  toast(`${project ? `${project.name} · ` : ''}${event.title || t('新消息')}${event.body ? t('：{v}', { v: event.body.slice(0, 60) }) : ''}`)
  if (get().projects[event.projectId]?.list) void loadInbox(event.projectId)
}

/**
 * Resolves once the first bootstrap settled (true = ready). A notification that brings back a closed
 * window arrives while the app is still loading: routing it then found no projects and said the project
 * was gone. Waiting one more task lets startApp finish restoring the remembered conversation first, so
 * the notification's conversation wins.
 */
export function appSettled(): Promise<boolean> {
  const status = useApp.getState().status
  if (status !== 'loading') return Promise.resolve(status === 'ready')
  return new Promise(resolve => {
    const off = useApp.subscribe(s => {
      if (s.status === 'loading') return
      off()
      setTimeout(() => resolve(s.status === 'ready'), 0)
    })
  })
}

/** A clicked desktop notification: open the conversation (or the inbox) and mark the entry read. */
export async function openNotificationTarget(target: NotificationTarget) {
  if (!(await appSettled())) return
  const app = useApp.getState()
  const route = notificationRoute(target, { projects: app.projects, sessions: app.sessionIndex })
  if (!route) { toast(t('这条消息所在的项目已不可用。')); return }
  if (route.kind === 'session') {
    await selectSession(route.sessionId)
    useUi.setState({ view: 'chat' })
    // H4 deep link: scroll to the exact delivered message when the host can locate it.
    if (route.projectId && route.entryId) void supportApi.inboxEntry(route.projectId, route.entryId).then(found => { if (found?.location?.sessionId === route.sessionId) focusTimelineItem(found.location.sessionId, found.location.itemId) }).catch(() => {})
  } else {
    selectProject(route.projectId)
    useUi.setState({ view: 'inbox' })
  }
  if (route.projectId && route.entryId) {
    set({ focus: { projectId: route.projectId, entryId: route.entryId } })
    setTimeout(() => { if (get().focus?.entryId === route.entryId) set({ focus: null }) }, 8000)
    try {
      const result = await communicationApi.act(route.projectId, route.entryId, 'read')
      replaceEntry(route.projectId, result.entry, result.unread)
    } catch { /* the entry may be gone; navigation already happened */ }
  }
}

onNotify(handleNotify)

// Listen from module load, not from a React effect: a notification that reopens a closed window is sent
// on did-finish-load, which can come before the first effects run, and an unheard IPC message is lost.
const stopListening = typeof window !== 'undefined' ? window.rnaDesktop?.onNotificationOpen?.(target => void openNotificationTarget(target)) : undefined
// Dev hot reload re-runs this module: drop the old listener, or one click is handled twice.
import.meta.hot?.dispose(() => { if (typeof stopListening === 'function') stopListening() })
