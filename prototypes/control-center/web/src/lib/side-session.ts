/** S2 side chats (辅助对话): sessions with `kind: 'side'` bound to a parent session. */
import type { SessionMeta } from '@/api/types'

/** True for a 辅助对话 (never shown in the sidebar session list or project session pickers). */
export function isSideSession(session: Pick<SessionMeta, 'kind' | 'parentSessionId'> | null | undefined): boolean {
  if (!session) return false
  if (session.kind === 'side') return true
  return session.kind === undefined && Boolean(session.parentSessionId)
}

/** Longest selection that can seed a side chat (characters). */
export const SELECTION_LIMIT = 8000

/** Trim and bound a text selection for a side chat seed; null when nothing usable is selected. */
export function selectionSeed(text: string | null | undefined): string | null {
  const clean = (text ?? '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return null
  return clean.length > SELECTION_LIMIT ? `${clean.slice(0, SELECTION_LIMIT)}…` : clean
}
