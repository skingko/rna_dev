/**
 * Question card: one or more questions with options (single/multi select) and
 * an optional free-form answer. Submits through the existing interaction
 * routes; the server's state stays authoritative.
 */
import { memo, useState } from 'react'
import { motion } from 'motion/react'
import { Check, CircleSlash, MessageCircleQuestion, ShieldQuestion } from 'lucide-react'
import type { Interaction } from '@/api/types'
import { api } from '@/api/client'
import { useItem } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

type Answer = { id: string; selected: string[]; custom: string }

export const QuestionCard = memo(function QuestionCard({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  const interaction = item?.interaction
  // Permission requests are question cards too (allow / keep current permissions); they were hidden before.
  if (!interaction || !['question', 'permission'].includes(interaction.kind)) return null
  return <QuestionBody sessionId={sessionId} interaction={interaction} proactive={interaction.source === 'initiative'} />
})

function QuestionBody({ sessionId, interaction, proactive }: { sessionId: string; interaction: Interaction; proactive: boolean }) {
  const questions = interaction.questions ?? []
  const canRespond = interaction.canRespond ?? ['pending', 'interrupted'].includes(interaction.status)
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(q => ({ id: q.id, selected: [], custom: '' })))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const [requestId] = useState(() => crypto.randomUUID())

  const toggle = (qi: number, optionId: string, multi: boolean) => {
    setError('')
    setAnswers(prev => prev.map((a, i) => i !== qi ? a : {
      ...a,
      selected: multi ? (a.selected.includes(optionId) ? a.selected.filter(x => x !== optionId) : [...a.selected, optionId]) : [optionId],
    }))
  }

  const submit = async (cancel = false) => {
    if (!cancel && answers.some(a => a.selected.length === 0 && !a.custom.trim())) { setError(t('请选择一个选项，或输入你的回答。')); return }
    setBusy(cancel ? 'cancel' : 'answer')
    try {
      if (cancel) await api.cancelQuestion(sessionId, interaction.id, requestId)
      else await api.answer(sessionId, interaction.id, { requestId, answers: answers.map(a => ({ id: a.id, selected: a.selected, ...(a.custom.trim() ? { custom: a.custom.trim() } : {}) })) })
      toast(cancel ? t('已取消本次提问，没有代替你作出选择。') : t('回答已提交。'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const answeredMap = new Map((interaction.answers ?? []).map(a => [a.id, a]))
  const status = interaction.status === 'answered' ? t('已回答') : interaction.status === 'cancelled' ? t('已取消') : interaction.status === 'interrupted' ? t('执行已暂停 · 仍可回答') : t('等待你的回答')

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={cn('my-2 rounded-2xl bg-elevated p-4 shadow-[0_0_0_1px_var(--line),var(--shadow-sm)]', canRespond && 'shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_30%,transparent),0_4px_18px_color-mix(in_srgb,var(--accent)_8%,transparent)]')}
    >
      <div className="mb-3 flex items-center gap-2 text-[12.5px]">
        <span className={cn('inline-flex items-center gap-1.5 font-medium', canRespond ? 'text-accent-text' : 'text-fg-3')}>
          {interaction.status === 'cancelled' ? <CircleSlash className="size-3.5" /> : interaction.status === 'answered' ? <Check className="size-3.5" /> : interaction.kind === 'permission' ? <ShieldQuestion className="size-3.5" /> : <MessageCircleQuestion className="size-3.5" />}
          {interaction.kind === 'permission' ? t('权限申请') : proactive ? t('主动提问') : t('需要你的选择')}
        </span>
        <span className="text-fg-4">·</span>
        <span className="text-fg-4">{status}</span>
      </div>
      {questions.map((q, qi) => {
        const answered = answeredMap.get(q.id)
        return (
          <div key={q.id} className={cn(qi > 0 && 'mt-4')}>
            {q.header && <div className="mb-0.5 text-[12px] font-medium text-fg-3">{q.header}</div>}
            <div className="mb-2.5 text-[14.5px] leading-6 text-fg">{q.question}</div>
            {q.detail && <p className="-mt-1 mb-2.5 whitespace-pre-wrap text-[13px] leading-[1.65] text-fg-3">{q.detail}</p>}
            <div className="flex flex-col gap-1">
              {q.options.map(option => {
                const selected = canRespond ? answers[qi]?.selected.includes(option.id) : answered?.selected.includes(option.id)
                if (!canRespond && !selected) return null
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={!canRespond || busy !== null}
                    onClick={() => toggle(qi, option.id, Boolean(q.multiSelect))}
                    className={cn(
                      'group/opt flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-150',
                      selected ? 'bg-accent-softer shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-subtle',
                      !canRespond && 'cursor-default',
                    )}
                  >
                    <span className={cn(
                      'mt-[3px] grid size-4 shrink-0 place-items-center border transition-colors duration-150',
                      q.multiSelect ? 'rounded-[5px]' : 'rounded-full',
                      selected ? 'border-accent bg-accent text-accent-contrast' : 'border-line-strong bg-elevated',
                    )}>
                      {selected && (q.multiSelect ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-accent-contrast" />)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-medium leading-5 text-fg">{option.label}</span>
                      {option.description && <span className="mt-0.5 block text-[12.5px] leading-[1.6] text-fg-3">{option.description}</span>}
                    </span>
                  </button>
                )
              })}
              {!canRespond && answered?.custom && <div className="rounded-xl px-3 py-2 text-[13px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">{answered.custom}</div>}
            </div>
            {canRespond && q.allowCustom !== false && (
              <input
                value={answers[qi]?.custom ?? ''}
                onChange={e => { const v = e.target.value; setAnswers(prev => prev.map((a, i) => i === qi ? { ...a, custom: v } : a)) }}
                placeholder={t('其他想法（可选）')}
                className="mt-2 h-9 w-full rounded-xl bg-subtle px-3 text-[13px] text-fg outline-none transition-shadow placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)]"
              />
            )}
          </div>
        )
      })}
      {error && <p className="mt-2.5 text-[12.5px] text-danger" role="alert">{error}</p>}
      {canRespond && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void submit(true)}>{busy === 'cancel' ? t('正在取消…') : t('取消提问')}</Button>
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void submit(false)}>{busy === 'answer' ? t('正在提交…') : t('提交回答')}</Button>
        </div>
      )}
    </motion.div>
  )
}
