/**
 * Deep links into conversations (inbox entries, digests, notifications).
 *
 *  - `openSessionItem(sessionId, itemId)`: switch to the conversation and
 *    scroll to + highlight the exact message (timeline-focus).
 *  - `openInboxEntry(projectId, entryId)`: resolve the entry's location on the
 *    host (message / question card / daily digest) and open it; an entry with
 *    no exact position opens its conversation (saying so when the message was
 *    edited away), and one without a usable conversation (deleted, archived)
 *    opens the inbox with the entry highlighted instead.
 *  - `openDigestEntries(projectId, entryIds)`: the reverse direction, from a
 *    digest message to the inbox entries it merged.
 *
 * The shell decides how the inbox is shown (default: the app-level 收件箱
 * page via `openInbox`); override with `setInboxOpener`.
 */
import { supportApi, type InboxEntryLookup } from '@/api/support-api'
import type { InboxEntry } from '@/api/communication-api'
import { communicationApi } from '@/api/communication-api'
import { focusTimelineItem } from '@/components/timeline/timeline-focus'
import { t } from '@/i18n'
import { useApp } from './app-store'
import { useInbox } from './inbox-store'
import { selectSession } from './sync'
import { openInbox, toast, useUi } from './ui-store'
import { openArchive } from '@/components/settings/panel-store'

type InboxOpener = (projectId: string, entryIds: string[]) => void
let inboxOpener: InboxOpener = projectId => openInbox(projectId)
/** Shell hook: how to reveal a project's inbox (view, popover, drawer…). */
export function setInboxOpener(opener: InboxOpener) { inboxOpener = opener }

/** Registered by the shell to show the conversation view (defaults to the 'chat' tab). */
let chatOpener: () => void = () => useUi.setState({ view: 'chat' })
export function setChatOpener(opener: () => void) { chatOpener = opener }

/** 'session' / 'project' when the conversation or its project is archived: it cannot take a message until restored. */
function archivedScope(sessionId: string): 'session' | 'project' | null {
  const app = useApp.getState(), session = app.sessionIndex[sessionId]
  if (session?.archivedAt) return 'session'
  return session?.projectId && app.projects[session.projectId]?.archivedAt ? 'project' : null
}
function tellArchived(scope: 'session' | 'project') {
  toast(scope === 'session' ? t('这段对话已归档，恢复后才能在里面继续。') : t('这段对话所在的项目已归档，恢复后才能在里面继续。'), 'default', { action: { label: t('查看已归档'), run: () => openArchive(scope === 'session' ? 'sessions' : 'projects') }, durationMs: 6000 })
}

export async function openSessionItem(sessionId: string, itemId: string) {
  const app = useApp.getState()
  if (!app.sessionIndex[sessionId]) { toast(t('这段对话已不可用。')); return false }
  // An archived conversation is not listed and refuses messages: say where it is instead of opening a dead end.
  const archived = archivedScope(sessionId)
  if (archived) { tellArchived(archived); return false }
  if (app.selectedSessionId !== sessionId) await selectSession(sessionId)
  chatOpener()
  focusTimelineItem(sessionId, itemId)
  return true
}

function highlightEntries(projectId: string, entryIds: string[]) {
  if (!entryIds.length) return
  useInbox.setState({ focus: { projectId, entryId: entryIds[0] } })
  setTimeout(() => { if (useInbox.getState().focus?.entryId === entryIds[0]) useInbox.setState({ focus: null }) }, 8000)
}

export function openDigestEntries(projectId: string, entryIds: string[]) {
  inboxOpener(projectId, entryIds)
  highlightEntries(projectId, entryIds)
}

/** Best-effort location from list data (daemons without the lookup route). */
export function localEntryLocation(entry: Pick<InboxEntry, 'sessionId' | 'itemId' | 'digestItemId'> & { digestSessionId?: string | null }) {
  if (entry.itemId && entry.sessionId) return { sessionId: entry.sessionId, itemId: entry.itemId }
  if (entry.digestItemId) return { sessionId: entry.digestSessionId ?? entry.sessionId ?? '', itemId: entry.digestItemId }
  return null
}

export async function openInboxEntry(projectId: string, entryId: string, fallback?: InboxEntry): Promise<InboxEntryLookup['location'] | null> {
  let lookup: InboxEntryLookup | null = null
  try { lookup = await supportApi.inboxEntry(projectId, entryId) } catch (error) { toast((error as Error).message, 'danger') }
  const location = lookup ? lookup.location : fallback ? (localEntryLocation(fallback) as InboxEntryLookup['location']) : null
  const entry = lookup?.entry ?? fallback
  const sessionId = location?.sessionId || entry?.sessionId || null
  // Archived conversation or project: keep the entry in view in the inbox and say how to get the conversation back.
  const archived = sessionId ? archivedScope(sessionId) : null
  if (archived) { openDigestEntries(projectId, [entryId]); tellArchived(archived); return null }
  if (location?.sessionId && await openSessionItem(location.sessionId, location.itemId)) {
    // Opening the exact message is reading it.
    if (entry?.status === 'unread') void communicationApi.act(projectId, entryId, 'read').catch(() => {})
    return location
  }
  // No exact message (a quiet share waits for an idle conversation, or the message was edited away): open its conversation anyway.
  // The location may have named another conversation (a digest's) that could not open: this one is checked on its own.
  const fallbackArchived = entry?.sessionId && entry.sessionId !== sessionId ? archivedScope(entry.sessionId) : null
  if (fallbackArchived) { openDigestEntries(projectId, [entryId]); tellArchived(fallbackArchived); return null }
  if (entry?.sessionId && useApp.getState().sessionIndex[entry.sessionId]) {
    if (useApp.getState().selectedSessionId !== entry.sessionId) await selectSession(entry.sessionId)
    chatOpener()
    if (!location && (entry.itemId || entry.digestItemId)) toast(t('原消息已不在对话中，已打开它所在的会话。'))
    return null
  }
  openDigestEntries(projectId, [entryId])
  if (lookup && !lookup.location) toast(t('这条消息只在收件箱中，没有对应的对话位置。'))
  return null
}
