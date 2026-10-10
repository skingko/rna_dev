/**
 * Project Mind state: the mind per project (read lazily by the 进化 tree's
 * profile strand, timeline thread chips, the inbox and the sidebar hints), optimistic
 * edits with rollback, and live refresh from the `project.mind` SSE summary.
 * Daemons without the mind routes resolve to `'unsupported'` and every
 * surface hides.
 */
import { create } from 'zustand'
import { mindApi, type AgendaItem, type MindCollection, type MindEvent, type ProjectMind, type UserNote } from '@/api/mind-api'
import { api } from '@/api/client'
import { mindCounts } from '@/lib/mind'
import { t } from '@/i18n'
import { useApp } from './app-store'
import { toast, useUi } from './ui-store'
import { onProjectMind, selectProject, selectSession } from './sync'

export type MindSlot = ProjectMind | 'unsupported' | null
export interface MindFocus { projectId: string; id: string; at: number }

interface MindState {
  /** `null` = not loaded yet; absent = never requested. */
  projects: Record<string, MindSlot>
  errors: Record<string, string | null>
  /** Entry to scroll to / highlight in 进化 (a lesson in the 画像 strand). */
  focus: MindFocus | null
  busy: string | null
}

export const useMind = create<MindState>(() => ({ projects: {}, errors: {}, focus: null, busy: null }))
const set = useMind.setState
const get = useMind.getState

const inflight = new Map<string, Promise<void>>()

export function loadMind(projectId: string): Promise<void> {
  const running = inflight.get(projectId)
  if (running) return running
  if (!(projectId in get().projects)) set(s => ({ projects: { ...s.projects, [projectId]: null } }))
  const task = (async () => {
    try {
      const mind = await mindApi.get(projectId)
      set(s => ({ projects: { ...s.projects, [projectId]: mind ?? 'unsupported' }, errors: { ...s.errors, [projectId]: null } }))
      if (mind) syncCounts(projectId, mind)
    } catch (error) {
      set(s => ({ errors: { ...s.errors, [projectId]: (error as Error).message } }))
    } finally { inflight.delete(projectId) }
  })()
  inflight.set(projectId, task)
  return task
}

/** Load once (no-op when loaded, loading or known unsupported). */
export function ensureMind(projectId: string) {
  if (projectId in get().projects) return inflight.get(projectId) ?? Promise.resolve()
  return loadMind(projectId)
}

export const mindOf = (projectId: string | null | undefined): ProjectMind | null => {
  const slot = projectId ? get().projects[projectId] : null
  return slot && slot !== 'unsupported' ? slot : null
}

/** Mirror the derived counts into the project summary (the index stream will confirm). */
function syncCounts(projectId: string, mind: ProjectMind) {
  const counts = mindCounts(mind)
  useApp.setState(s => {
    const project = s.projects[projectId]
    if (!project) return {}
    const current = project.counts ?? {}
    if ((Object.keys(counts) as (keyof typeof counts)[]).every(k => current[k] === counts[k])) return {}
    return { projects: { ...s.projects, [projectId]: { ...project, counts: { ...current, ...counts } } } }
  })
}

function replaceMind(projectId: string, mind: ProjectMind) {
  set(s => ({ projects: { ...s.projects, [projectId]: mind } }))
  syncCounts(projectId, mind)
}

type Entry = { id: string } & Record<string, unknown>
function mapCollection(mind: ProjectMind, collection: MindCollection, id: string, fn: (entry: Entry) => Entry | null): ProjectMind {
  const apply = <T extends { id: string }>(list: T[]) => list.flatMap(entry => {
    if (entry.id !== id) return [entry]
    const next = fn(entry as unknown as Entry)
    return next ? [next as unknown as T] : []
  })
  if (collection === 'notes') return { ...mind, notes: { ...mind.notes, facts: apply<UserNote>(mind.notes.facts), preferences: apply<UserNote>(mind.notes.preferences) } }
  return { ...mind, [collection]: apply(mind[collection] as { id: string }[]) }
}

/**
 * Optimistic PATCH: apply locally, send, adopt the server's entry; on failure
 * roll back to the previous mind and report.
 */
export async function patchMindEntry(projectId: string, collection: MindCollection, id: string, patch: Record<string, unknown>, done?: string) {
  const before = mindOf(projectId)
  if (!before) return false
  const now = new Date().toISOString()
  replaceMind(projectId, mapCollection(before, collection, id, entry => ({ ...entry, ...patch, updatedAt: now })))
  set({ busy: id })
  try {
    const entry = await mindApi.patch<Entry>(projectId, collection, id, patch)
    const current = mindOf(projectId)
    if (entry && current && typeof entry === 'object' && entry.id === id) replaceMind(projectId, mapCollection(current, collection, id, () => entry))
    if (done) toast(done)
    return true
  } catch (error) {
    replaceMind(projectId, before)
    toast(t('没有保存：{message}', { message: (error as Error).message }), 'danger')
    return false
  } finally { set({ busy: null }) }
}

export async function deleteMindEntry(projectId: string, collection: MindCollection, id: string, done?: string) {
  const before = mindOf(projectId)
  if (!before) return false
  replaceMind(projectId, mapCollection(before, collection, id, () => null))
  try {
    await mindApi.remove(projectId, collection, id)
    if (done) toast(done)
    return true
  } catch (error) {
    replaceMind(projectId, before)
    toast(t('没有删除：{message}', { message: (error as Error).message }), 'danger')
    return false
  }
}

/**
 * Answer an awaiting_user agenda item where it is shown: through its question
 * card (options + free text, the same interaction route the conversation uses)
 * when one is open, otherwise the mind answer route (recorded in the latest
 * conversation). The server closes the item; the mind is re-read.
 */
export async function answerAgendaItem(projectId: string, item: AgendaItem, answer: { selected: string[]; text: string }) {
  set({ busy: item.id })
  try {
    const card = item.question?.canRespond && item.interaction ? item.interaction : null
    if (card) {
      const questions = item.question?.questions ?? []
      await api.answer(card.sessionId, card.interactionId, { requestId: crypto.randomUUID(), answers: questions.map((q, index) => ({ id: q.id, selected: index === 0 ? answer.selected : [], ...(answer.text.trim() ? { custom: answer.text.trim() } : {}) })) })
    } else await mindApi.answerAgenda(projectId, item.id, answer.text.trim())
    toast(t('已回答，Rna 会按你的回答继续。'))
    await loadMind(projectId)
    return true
  } catch (error) {
    toast(t('没有提交：{message}', { message: (error as Error).message }), 'danger')
    return false
  } finally { set({ busy: null }) }
}

/* ------------------------------------------------------------------ SSE */

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** `project.mind`: update summary counts now; refetch a loaded mind (debounced). */
export function applyMindEvent(event: MindEvent) {
  if (!event?.projectId) return
  if (event.counts) {
    useApp.setState(s => {
      const project = s.projects[event.projectId]
      return project ? { projects: { ...s.projects, [event.projectId]: { ...project, counts: { ...project.counts, ...event.counts } } } } : {}
    })
  }
  const slot = get().projects[event.projectId]
  if (slot && slot !== 'unsupported' && event.health) set(s => ({ projects: { ...s.projects, [event.projectId]: { ...slot, health: event.health } } }))
  if (!(event.projectId in get().projects) || slot === 'unsupported') return
  clearTimeout(timers.get(event.projectId))
  timers.set(event.projectId, setTimeout(() => { timers.delete(event.projectId); void loadMind(event.projectId) }, 250))
}

export function focusMindEntry(projectId: string, id: string) {
  const at = Date.now()
  set({ focus: { projectId, id, at } })
  setTimeout(() => { if (get().focus?.at === at) set({ focus: null }) }, 8000)
}

/**
 * Settle what Rna owes the user where decisions are made: the project conversation opens and every overdue promise
 * gets a card above the composer (接着做 / 不用了). No separate page to visit. The cards show even while a turn runs,
 * a question card waits or the composer holds a draft (NudgeStrip honours `invitationFocus`); an emergency stop, an
 * app update or a paused conversation holds them, and the user is told so (the click never opens an empty conversation).
 */
export async function askOwed(projectId: string) {
  try {
    const result = await mindApi.askOwed(projectId)
    if (!result.sessionId) { toast(t('这个项目还没有可以对话的会话。')); return }
    useUi.setState({ view: 'chat', sidebarOpen: false, invitationFocus: { kind: 'commitment', until: Date.now() + 10 * 60_000 } })
    await selectSession(result.sessionId)
    const app = useApp.getState()
    const status = app.sessions[result.sessionId]?.meta.status ?? app.sessionIndex[result.sessionId]?.status
    if (!result.overdue) toast(t('现在没有逾期的事了。'))
    else if (app.emergency || app.maintenanceHeld) toast(t('急停或更新结束后，会在输入框上方逐件问你。'))
    // A message there would resume the paused turn, so the cards wait until it is resumed.
    else if (status === 'paused') toast(t('这段对话暂停着，恢复后会在输入框上方逐件问你。'))
  } catch (error) { toast((error as Error).message, 'danger') }
}

/** Open 进化 for a project (lessons live in its 画像 strand), keeping the current conversation when it belongs there. */
export function openMind(projectId: string, focusId?: string) {
  const app = useApp.getState()
  const current = app.selectedSessionId ? app.sessionIndex[app.selectedSessionId]?.projectId ?? app.selectedProjectId : app.selectedProjectId
  if (current !== projectId) selectProject(projectId)
  useUi.setState({ view: 'evolution', sidebarOpen: false })
  if (focusId) focusMindEntry(projectId, focusId)
}

onProjectMind(applyMindEvent)
