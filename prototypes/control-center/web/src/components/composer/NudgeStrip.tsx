/**
 * One light invitation above the composer (plan 2026-09-30 §2.1): a line, one
 * to three answers and ×. It only appears to someone who is here, never while
 * they type, and never over something more important. Answering changes the
 * same strip in place (👎 → "what was off?" → a short thank-you); × or Esc
 * closes it for good, and closing is itself a useful signal.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { mindApi } from '@/api/mind-api'
import type { Invitation } from '@/api/types'
import { useApp } from '@/store/app-store'
import { sendFeedback } from '@/store/feedback-store'
import { refreshActions } from '@/store/tasks-store'
import { toast, useUi } from '@/store/ui-store'
import { pickInvitation, useEngaged } from '@/lib/invitations'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t, localized } from '@/i18n'

/** ask → (👎) reasons → done; ask → (👍) thanks → (optional) more → done; lesson: ask → (rewrite) → done. */
type Stage = 'ask' | 'reasons' | 'thanks' | 'more' | 'rewrite' | 'done'
interface Active { invitation: Invitation; stage: Stage; answered?: boolean; message?: string }

const REASONS = localized(['太啰嗦', '没按我说的做', '结论不对'])
/** One sentence per lesson kind, so each reads naturally in every language. */
const LESSON_QUESTIONS: Record<string, string> = localized({ preference: '我记下了一条偏好：“{text}”，以后照这样做吗？', constraint: '我记下了一条约束：“{text}”，以后照这样做吗？', pitfall: '我记下了一个易错点：“{text}”，以后照这样注意吗？', success_habit: '我记下了一个好做法：“{text}”，以后照这样做吗？', other: '我记下了一条经验：“{text}”，以后照这样做吗？' })
/**
 * Lessons asked about for a reason (a table, so each is translated when read). never_applied: recalled many times, never
 * seen followed. conflicts_user_lesson: a rule Rna concluded on its own that would replace one the user set (B5); it waits
 * for this answer, and switching to it retires the user's rule.
 */
const REASON_QUESTIONS: Record<string, string> = localized({
  never_applied: '“{text}”这条经验已经好几次用得上，却一直没被照做。还留着吗？',
  conflicts_user_lesson: '我得出了一条新经验“{text}”，和你定的“{rule}”冲突。换成新的吗？',
  conflicts_user_lesson_unnamed: '我得出了一条新经验“{text}”，和你之前定的一条规则冲突。换成新的吗？',
})
/** Evolution decisions: one sentence per reason, so each reads naturally in every language. */
const GENE_QUESTIONS: Record<string, string> = localized({ unused: '技能「{title}」一个月没用过了，要停用吗？', never_caught: '检查「{title}」运行了 {runs} 次都没发现问题，要停用吗？', no_effect: '对照最近的对话，「{title}」好像没起作用，要停用吗？', not_checkable: '检查「{title}」查的是需要判断的内容，程序查不准。要停用这项检查吗？规则本身会留下。', never_ran: '检查「{title}」还从没运行过（没有匹配的文件）。工具位已满，要停用它吗？', never_followed: '做法「{title}」已有 {runs} 次用得上，却一次都没照做过。要停用吗？', harm: '同一个定时任务里，「{title}」出现之后被纠正得更多了，要停用吗？' })
const DONE_MS = 2200, THANKS_MS = 4000
/** Decisions are asked once: the host learns this one was put in front of the user, so a message they send instead lets it lapse. */
const DECISION_KINDS = new Set(['lesson', 'gene', 'commitment', 'schedule', 'task'])
const reported = new Set<string>()
/** Invitations the user answered or closed here: never shown again, even before the host's update arrives. */
const settled = new Set<string>()

export function NudgeStrip({ sessionId, typing }: { sessionId: string | null; typing: boolean }) {
  const meta = useApp(s => (sessionId ? s.sessions[sessionId]?.meta : undefined))
  const emergency = useApp(s => s.emergency)
  const held = useApp(s => s.maintenanceHeld)
  // Anything that needs the user more (a failed turn to retry, an open question card) comes first.
  const failed = useApp(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    if (!slice || slice.meta.status !== 'idle') return false
    return Object.values(slice.turns).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).at(-1)?.status === 'failed'
  })
  const asking = useApp(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    const open = (item: { interaction?: { status?: unknown } | null }) => Boolean(item.interaction && ['pending', 'interrupted'].includes(String(item.interaction.status)))
    // B9: a card older than the window held counts too (the host pins it).
    return Boolean(slice && slice.meta.status === 'idle' && (Object.values(slice.items).some(open) || Object.values(slice.outside ?? {}).some(entry => open(entry.item))))
  })
  const engaged = useEngaged()
  const focus = useUi(s => s.invitationFocus)
  const prefer = focus && focus.until > Date.now() ? focus.kind : null
  const open = meta?.invitations?.filter(row => !settled.has(row.id))
  const idle = meta?.status === 'idle', hard = emergency || held || Boolean(meta?.appRecovery?.required)
  // What the user just asked to settle (Rna 欠你 N 件事): those cards show although the composer holds a draft (one left
  // from earlier would otherwise make the click open the conversation with nothing in it, F25).
  const owed = (row: Invitation) => prefer === 'commitment' && row.kind === 'commitment'
  const offered = pickInvitation(open, { idle, blocked: hard || failed || asking, typing, engaged }, prefer)
    // A failed turn may be waiting on exactly this decision (background work to review): the retry bar does not hide it.
    ?? pickInvitation(open?.filter(row => row.kind === 'task'), { idle, blocked: hard || asking, typing, engaged })
    // The owed cards also show while a turn runs or failed, or a question card waits: they only need an answer, and the
    // host posts 接着做 as a follow-up queued behind the running turn, never steering it (C2-c). Not while the session is
    // paused: a message there resumes the paused turn.
    ?? (prefer === 'commitment' && meta?.status !== 'paused' ? pickInvitation(open?.filter(owed), { idle: true, blocked: hard, typing: false, engaged }) : null)
  // `active` holds only an invitation the user is answering (or its thank-you). Otherwise the strip shows what the
  // host has pending: an untouched one follows the host (answered elsewhere → gone), and when one is answered the
  // next takes its place. Before, the next was adopted only when the host's first pending one changed, so with
  // several (Rna 欠你 N 件事) the second never appeared after the first's thank-you (live, 2026-10-03).
  const [active, setActive] = useState<Active | null>(null)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { setActive(null); setDraft('') }, [sessionId])
  useEffect(() => {
    if (active?.stage !== 'done' && active?.stage !== 'thanks') return
    const timer = window.setTimeout(() => setActive(null), active.stage === 'done' ? DONE_MS : THANKS_MS)
    return () => window.clearTimeout(timer)
  }, [active?.stage, active?.invitation.id])
  useEffect(() => { if (active && ['reasons', 'more', 'rewrite'].includes(active.stage)) requestAnimationFrame(() => field.current?.focus()) }, [active?.stage]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown: Active | null = active ?? (offered ? { invitation: offered, stage: 'ask' } : null)
  const visible = shown && (shown.stage !== 'ask' || !typing || owed(shown.invitation)) ? shown : null
  const shownId = visible?.stage === 'ask' && DECISION_KINDS.has(visible.invitation.kind) ? visible.invitation.id : null
  useEffect(() => {
    if (!sessionId || !shownId || reported.has(shownId)) return
    reported.add(shownId)
    void mindApi.invitation(sessionId, shownId, { action: 'shown' }).catch(() => reported.delete(shownId))
  }, [sessionId, shownId])
  if (!sessionId) return null
  const invitation = visible?.invitation
  const finish = (message: string) => { setDraft(''); if (invitation) { settled.add(invitation.id); setActive({ invitation, stage: 'done', answered: true, message }) } }
  const dismiss = () => {
    const row = visible?.invitation, answered = visible?.answered
    if (row) settled.add(row.id)
    setActive(null); setDraft('')
    // Closing before answering is the signal; after a vote it only hides the strip.
    if (row && !answered) void mindApi.invitation(sessionId, row.id, { action: 'dismiss' }).catch(() => {})
  }
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss() } }

  // Feedback: a vote answers it; a note is optional and collected in place.
  const vote = async (value: 'up' | 'down') => {
    if (!invitation?.itemId) return
    settled.add(invitation.id)
    setActive({ invitation, stage: value === 'down' ? 'reasons' : 'thanks', answered: true })
    if (!(await sendFeedback(sessionId, invitation.itemId, value, undefined, { quiet: true }))) { settled.delete(invitation.id); setActive(null) }
  }
  const note = async (text: string, value: 'up' | 'down') => {
    const clean = text.trim()
    if (!invitation?.itemId || !clean) return
    finish(value === 'down' ? t('记下了，以后会注意。') : t('记下了。'))
    await sendFeedback(sessionId, invitation.itemId, value, clean, { quiet: true })
  }
  // Lesson: confirm, retire, or say it better.
  // Evolution decision: retire it, or keep it (never asked again).
  const decide = async (choice: 'retire' | 'keep' | 'fix' | 'later' | 'continue' | 'drop' | 'accept' | 'decline') => {
    if (!invitation) return
    finish(({ retire: t('好，已停用。'), keep: t('好，留着。'), fix: t('好，这就改。'), later: t('好，先不动。'), continue: t('好，接着做。'), drop: t('好，这件不做了。'), accept: t('好，已经排上了。'), decline: t('好，不排。') } as Record<string, string>)[choice])
    try {
      await mindApi.invitation(sessionId, invitation.id, { action: 'answer', choice })
      // A background task settled here: the task page and the 去核对 / 重试请求 notice read the actions snapshot (C2-d).
      if (invitation.kind === 'task' && meta?.projectId) void refreshActions(meta.projectId, { fresh: true })
    } catch (error) { settled.delete(invitation.id); toast(t('没有保存：{message}', { message: (error as Error).message }), 'danger') }
  }
  const answer = async (choice: 'confirm' | 'revoke' | 'rewrite', text?: string) => {
    if (!invitation) return
    const conflict = invitation.reason === 'conflicts_user_lesson'
    finish(choice === 'confirm' ? (conflict ? t('好，换成新的了。') : t('好，以后照这样做。')) : choice === 'revoke' ? (conflict ? t('好，还按你原来定的来。') : t('好，这条不再用了。')) : t('好，按你说的记下了。'))
    try { await mindApi.invitation(sessionId, invitation.id, choice === 'rewrite' ? { action: 'answer', choice, text: text ?? '' } : { action: 'answer', choice }) }
    catch (error) { settled.delete(invitation.id); toast(t('没有保存：{message}', { message: (error as Error).message }), 'danger') }
  }

  const close = (
    <button type="button" aria-label={t('关闭')} onClick={dismiss} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"><X className="size-3.5" /></button>
  )
  const input = (placeholder: string, submit: () => void, label: string) => (
    <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={e => { e.preventDefault(); submit() }}>
      <input ref={field} value={draft} onChange={e => setDraft(e.target.value)} maxLength={600} placeholder={placeholder} aria-label={placeholder}
        className="h-7 min-w-0 flex-1 rounded-md bg-elevated px-2.5 text-[12.5px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
      <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()}>{label}</Button>
    </form>
  )

  let body = null
  if (invitation?.kind === 'feedback') {
    if (visible!.stage === 'ask') body = (
      <>
        <span className="min-w-0 flex-1">{t('这条回复有帮助吗？')}</span>
        <button type="button" aria-label={t('有帮助')} onClick={() => void vote('up')} className="grid size-7 place-items-center rounded-md text-fg-3 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"><ThumbsUp className="size-3.5" strokeWidth={1.8} /></button>
        <button type="button" aria-label={t('没帮助')} onClick={() => void vote('down')} className="grid size-7 place-items-center rounded-md text-fg-3 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"><ThumbsDown className="size-3.5" strokeWidth={1.8} /></button>
      </>
    )
    else if (visible!.stage === 'reasons') body = (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1">{t('哪里不对？')}</span>
          {REASONS.map(reason => <Button key={reason} size="sm" variant="secondary" onClick={() => void note(reason, 'down')}>{reason}</Button>)}
        </div>
        {input(t('输入其他补充…'), () => void note(draft, 'down'), t('发送'))}
      </div>
    )
    else if (visible!.stage === 'thanks') body = (
      <>
        <span className="min-w-0 flex-1">{t('记住了，谢谢。')}</span>
        <button type="button" onClick={() => setActive(current => (current ? { ...current, stage: 'more' } : null))} className="shrink-0 rounded text-[12.5px] text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('补充一句？')}</button>
      </>
    )
    else if (visible!.stage === 'more') body = input(t('哪里好，以后多这样…'), () => void note(draft, 'up'), t('发送'))
  } else if (invitation?.kind === 'lesson') {
    // A lesson recalled many times but never seen followed asks whether it is still wanted, not whether it was heard; one
    // that would replace the user's own rule names that rule and asks which one to keep.
    const conflict = invitation.reason === 'conflicts_user_lesson'
    const reasonKey = conflict && !invitation.conflictText ? 'conflicts_user_lesson_unnamed' : invitation.reason ?? ''
    const question = (REASON_QUESTIONS[reasonKey] ?? LESSON_QUESTIONS[invitation.lessonKind ?? ''] ?? LESSON_QUESTIONS.other).replace('{rule}', invitation.conflictText ?? '').replace('{text}', invitation.text ?? '')
    if (visible!.stage === 'ask') body = (
      <>
        <span className="min-w-0 flex-1">{question}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" leading={<Check className="size-3.5" />} onClick={() => void answer('confirm')}>{conflict ? t('换成新的') : t('对')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void answer('revoke')}>{conflict ? t('保留原来的') : t('不再适用')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(invitation.text ?? ''); setActive({ invitation, stage: 'rewrite' }) }}>{t('改一下…')}</Button>
        </div>
      </>
    )
    else if (visible!.stage === 'rewrite') body = input(t('换成更准确的说法…'), () => void answer('rewrite', draft.trim()), t('保存'))
  } else if (invitation?.kind === 'gene' && invitation.action === 'fix_hits' && visible!.stage === 'ask') {
    body = (
      <>
        <span className="min-w-0 flex-1">{t('检查「{title}」在现有 {files} 个文件里发现 {total} 处问题，要我改掉吗？', { title: invitation.title ?? '', files: invitation.files ?? 0, total: invitation.total ?? 0 })}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => void decide('fix')}>{t('改掉')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void decide('later')}>{t('先不用')}</Button>
        </div>
      </>
    )
  } else if (invitation?.kind === 'commitment' && visible!.stage === 'ask') {
    // Who asked for it: the user (你之前让我…) or Rna itself, said from its side (我之前说过要…); older hosts do not say.
    const trigger = (invitation as Invitation & { trigger?: string }).trigger
    const text = invitation.text ?? ''
    body = (
      <>
        <span className="min-w-0 flex-1">{trigger === 'user_request' ? t('你之前让我“{text}”，还没做完，要我接着做吗？', { text }) : trigger === 'agent_promise' ? t('我之前说过要“{text}”，还要做吗？', { text }) : t('“{text}”还没做完，要我接着做吗？', { text })}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => void decide('continue')}>{t('接着做')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void decide('drop')}>{t('不用了')}</Button>
        </div>
      </>
    )
  } else if (invitation?.kind === 'task' && visible!.stage === 'ask') {
    // Background work that needs the user: answered here, never on the task page.
    const review = invitation.mode === 'review'
    body = (
      <>
        <span className="line-clamp-2 min-w-0 flex-1">{review ? t('后台“{text}”被打断，最后一步没法确认有没有做完，要按现在的结果算吗？', { text: invitation.text ?? '' }) : t('后台“{text}”没做完，要我接着做吗？', { text: invitation.text ?? '' })}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => void decide(review ? 'keep' : 'continue')}>{review ? t('按现在的算') : t('接着做')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void decide('drop')}>{review ? t('不用再做') : t('不用了')}</Button>
        </div>
      </>
    )
  } else if (invitation?.kind === 'schedule' && visible!.stage === 'ask') {
    body = (
      <>
        <span className="min-w-0 flex-1">{t('你这几天都让我“{title}”，要我每天 {time} 自动做吗？', { title: invitation.title ?? '', time: invitation.time ?? '' })}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => void decide('accept')}>{t('好，每天做')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void decide('decline')}>{t('不用')}</Button>
        </div>
      </>
    )
  } else if (invitation?.kind === 'gene' && visible!.stage === 'ask') {
    const question = (GENE_QUESTIONS[invitation.usage ?? ''] ?? GENE_QUESTIONS.unused).replace('{title}', invitation.title ?? '').replace('{runs}', String(invitation.runs ?? ''))
    body = (
      <>
        <span className="min-w-0 flex-1" title={invitation.reason || undefined}>{question}</span>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => void decide('retire')}>{t('停用')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void decide('keep')}>{t('留着')}</Button>
        </div>
      </>
    )
  }
  if (visible?.stage === 'done') body = <span className="min-w-0 flex-1 text-fg-3">{visible.message}</span>

  return (
    <AnimatePresence initial={false}>
      {visible && body && (
        <motion.div key={visible.invitation.id} role="status" aria-live="polite" onKeyDown={onKey}
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 2 }} transition={{ duration: 0.18, ease: 'easeOut' }}
          className={cn('mx-2 mb-2 flex items-start gap-2 rounded-xl bg-subtle px-3.5 py-1.5 text-[13px] leading-7 text-fg-2 shadow-[inset_0_0_0_1px_var(--line)] max-[520px]:flex-wrap')}>
          {body}
          {visible.stage !== 'done' && close}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
