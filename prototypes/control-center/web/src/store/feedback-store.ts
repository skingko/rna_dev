/**
 * 👍/👎 on assistant messages. The vote shows immediately (optimistic
 * override keyed by session + item) and settles when the host echoes
 * `item.feedback`; a failed write rolls back. A daemon without the route
 * (404) hides the controls for the rest of the visit.
 */
import { create } from 'zustand'
import { mindApi, type FeedbackVote } from '@/api/mind-api'
import { isUnsupported } from '@/api/communication-api'
import { t } from '@/i18n'
import { useApp } from './app-store'
import { toast } from './ui-store'

export interface LocalVote { vote: FeedbackVote; comment?: string | null; pending: boolean }
interface FeedbackState {
  votes: Record<string, LocalVote>
  unsupported: boolean
}

export const useFeedback = create<FeedbackState>(() => ({ votes: {}, unsupported: false }))
const set = useFeedback.setState
const get = useFeedback.getState

export const feedbackKey = (sessionId: string, itemId: string) => `${sessionId}:${itemId}`

/** The vote to display: a local (possibly pending) choice wins over the host's echo. */
export function effectiveVote(local: LocalVote | undefined, echoed: { vote?: FeedbackVote } | null | undefined): FeedbackVote {
  if (local) return local.vote
  return echoed?.vote ?? null
}

export function useVote(sessionId: string, itemId: string) {
  const local = useFeedback(s => s.votes[feedbackKey(sessionId, itemId)])
  const echoed = useApp(s => s.sessions[sessionId]?.items[itemId]?.feedback)
  return { vote: effectiveVote(local, echoed), comment: local?.comment ?? echoed?.comment ?? null, pending: Boolean(local?.pending) }
}

/** Clicking the active vote again clears it (`null`). */
export async function sendFeedback(sessionId: string, itemId: string, vote: FeedbackVote, comment?: string, { quiet = false }: { quiet?: boolean } = {}) {
  const key = feedbackKey(sessionId, itemId)
  const previous = get().votes[key]
  set(s => ({ votes: { ...s.votes, [key]: { vote, comment: comment ?? (vote === 'down' ? previous?.comment : null), pending: true } } }))
  try {
    await mindApi.feedback(sessionId, itemId, { vote, ...(comment ? { comment } : {}) })
    set(s => ({ votes: { ...s.votes, [key]: { ...s.votes[key], pending: false } } }))
    if (comment && !quiet) toast(t('谢谢，已记下这条反馈。'))
    return true
  } catch (error) {
    set(s => {
      const votes = { ...s.votes }
      if (previous) votes[key] = previous
      else delete votes[key]
      return { votes, ...(isUnsupported(error) ? { unsupported: true } : {}) }
    })
    toast(isUnsupported(error) ? t('当前本地服务版本尚不支持消息反馈。') : t('反馈没有发送：{message}', { message: (error as Error).message }), 'danger')
    return false
  }
}
