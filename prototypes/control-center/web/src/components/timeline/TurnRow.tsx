/**
 * One conversation turn: user message, a collapsible process section
 * (reasoning, narration, tools, questions), the final answer, deliverables and
 * a quiet footer. Each piece subscribes to its own items, so streaming one
 * block never re-renders the rest of the turn.
 */
import { routeHints } from '@/lib/route-hints'
import { memo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, ChevronDown } from 'lucide-react'
import type { Step } from '@/store/session-model'
import { turnLastActivity, turnWorkMs, type Row } from '@/store/session-model'
import { useApp, useItem, usePhase, useTurn } from '@/store/app-store'
import { setProcessOpen, useUi } from '@/store/ui-store'
import { formatDuration, stampTime } from '@/lib/format'
import { capabilityOf, decisionSource, findModel, reasoningSummary } from '@/lib/models'
import { useNow } from '@/hooks/useNow'
import { isPreparationPhase, phaseDetail, phaseLabel, timingRows, timingSummary } from '@/lib/phases'
import { Tooltip } from '@/components/ui/primitives'
import { CopyButton } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { processSummary } from '@/lib/tools'
import type { ToolCall } from '@/api/types'
import { AssistantText, ConnectingRow, ForkButton, NoticeRow, ProactiveMessage, UserMessage } from './Messages'
import { ThinkingRow } from './ThinkingRow'
import { ToolGroup, ToolRow } from './ToolViews'
import { QuestionCard } from './QuestionCard'
import { Deliverables } from './Deliverables'
import { SubagentCard } from './SubagentCard'
import { TurnApplyLine } from './TurnApply'
import { FeedbackButtons } from './FeedbackButtons'
import { useVote } from '@/store/feedback-store'
import { t } from '@/i18n'

type TurnRowData = Extract<Row, { type: 'turn' }>

/** Still working: the clock runs and the process stays open. A paused turn is neither, unless it waits on a question. */
const LIVE = new Set(['running', 'pending', 'queued'])

export const TurnRow = memo(function TurnRow({ sessionId, row, isLast = false }: { sessionId: string; row: TurnRowData; isLast?: boolean }) {
  const turn = useTurn(sessionId, row.turnId)
  const questionIds = row.steps.flatMap(s => (s.type === 'question' ? [s.itemId] : []))
  // A pending question means the turn is waiting on the reader (the host pauses it for that), not that it stopped.
  const waiting = useApp(s => questionIds.some(id => {
    const ix = s.sessions[sessionId]?.items[id]?.interaction
    return Boolean(ix && (ix.canRespond ?? ['pending', 'interrupted'].includes(ix.status)))
  }))
  const paused = turn?.status === 'paused' && !waiting
  const running = turn ? LIVE.has(turn.status) || (turn.status === 'paused' && waiting) : true
  const userOpen = useUi(s => s.processOpen[row.turnId])
  const open = userOpen ?? running
  const hasProcess = row.steps.length > 0
  const toolIds = row.steps.flatMap(s => (s.type === 'tool' ? [s.itemId] : s.type === 'group' ? s.itemIds : []))
  const added = row.steps.filter(s => s.type === 'user')
  return (
    <article className="group/turn" data-turn={row.turnId}>
      {row.userItemId && <UserMessage sessionId={sessionId} itemId={row.userItemId} />}
      <div className={cn(row.userItemId && 'mt-5')}>
        {(hasProcess || running || paused) && (
          <ProcessHeader sessionId={sessionId} turnId={row.turnId} open={open} running={running} waiting={waiting} toolIds={toolIds} hasContent={hasProcess} />
        )}
        <AnimatePresence initial={false}>
          {open && hasProcess && (
            <motion.div
              key="process"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              className="pb-1 pt-1.5"
            >
              {row.steps.map(step => <StepView key={step.key} sessionId={sessionId} step={step} />)}
            </motion.div>
          )}
        </AnimatePresence>
        {/* What the user added while it ran stays readable with the process folded. */}
        {!open && added.length > 0 && <div className="pt-1.5">{added.map(step => <StepView key={step.key} sessionId={sessionId} step={step} />)}</div>}
        {running && !row.answerId && <LiveTail sessionId={sessionId} turnId={row.turnId} hasSteps={hasProcess} />}
        {row.answerId && (
          <div className={cn(hasProcess && 'mt-3')}>
            <AssistantText sessionId={sessionId} itemId={row.answerId} />
          </div>
        )}
        {row.errorId && <FailureReason sessionId={sessionId} itemId={row.errorId} />}
        {/* A turn of a git project can change files with no edit call of its own (a worker's merge): the host says what reached the folder. */}
        {!running && (toolIds.length > 0 || Boolean(turn?.apply || turn?.checkpoint)) && <Deliverables sessionId={sessionId} itemIds={toolIds} turnId={row.turnId} />}
        {/* 0.63: whether the turn's changes reached the project folder, and its rollback (also while it applies or merges). */}
        {turn && (turn.apply || turn.checkpoint) && <TurnApplyLine sessionId={sessionId} turnId={row.turnId} running={running} toolIds={toolIds} />}
        {!running && turn && <TurnFooter sessionId={sessionId} turnId={row.turnId} answerId={row.answerId} pinned={isLast} />}
      </div>
    </article>
  )
})

function StepView({ sessionId, step }: { sessionId: string; step: Step }) {
  switch (step.type) {
    case 'assistant': return <AssistantStep sessionId={sessionId} itemId={step.itemId} thinkingOnly={step.key.startsWith('think:')} />
    case 'tool': return <ToolRow sessionId={sessionId} itemId={step.itemId} />
    case 'group': return <ToolGroup sessionId={sessionId} itemIds={step.itemIds} kind={step.kind} />
    case 'question': return <QuestionCard sessionId={sessionId} itemId={step.itemId} />
    case 'notice': return <NoticeRow sessionId={sessionId} itemId={step.itemId} />
    case 'subagent': return <SubagentCard sessionId={sessionId} itemId={step.itemId} />
    case 'user': return <div className="my-3"><UserMessage sessionId={sessionId} itemId={step.itemId} added /></div>
  }
}

/** Why a failed turn stopped, where its answer would be: the reader decides from it whether to retry, switch model or fix settings.
 * A polite status, not an alert: the timeline is virtualized, so failed turns from history mount again while scrolling. */
function FailureReason({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  if (!item?.text) return null
  return (
    <div role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[13.5px] leading-[1.6] text-danger" data-turn-failure>
      <AlertCircle className="mt-[3px] size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
      <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
    </div>
  )
}

const AssistantStep = memo(function AssistantStep({ sessionId, itemId, thinkingOnly }: { sessionId: string; itemId: string; thinkingOnly: boolean }) {
  const hasThinking = useApp(s => Boolean(s.sessions[sessionId]?.items[itemId]?.thinking))
  return (
    <>
      {hasThinking && <ThinkingRow sessionId={sessionId} itemId={itemId} />}
      {!thinkingOnly && <AssistantText sessionId={sessionId} itemId={itemId} interim />}
    </>
  )
})

/* ------------------------------------------------------ process header */

function ProcessHeader({ sessionId, turnId, open, running, waiting, toolIds, hasContent }: { sessionId: string; turnId: string; open: boolean; running: boolean; waiting: boolean; toolIds: string[]; hasContent: boolean }) {
  const turn = useTurn(sessionId, turnId)
  // Finished turns say what was done in one verb line; tool names stay inside.
  const summary = useApp(s => (running ? '' : processSummary(toolIds.map(id => s.sessions[sessionId]?.items[id]?.tool).filter((tool): tool is ToolCall => Boolean(tool)))))
  const phase = usePhase(sessionId, turnId)
  const paused = !running && turn?.status === 'paused'
  // The clock stands still while the turn waits on the reader or is paused.
  const now = useNow(running && !waiting)
  const end = useApp(s => (paused ? turnLastActivity(s.sessions[sessionId], turnId) : null))
  const ms = turnWorkMs(turn, { live: running, now, end })
  const duration = ms !== null ? formatDuration(Math.max(ms, 1000)) : ''
  const preparing = running && (isPreparationPhase(phase?.phase) || (!phase && !turn?.firstTokenAt && !hasContent))
  // 思考中 from the moment the message is sent, with the wait counted from the first second (as harness and zcode
  // show their turn clocks), so a slow start never looks stuck.
  const prepLabel = ms !== null && ms >= 1000 && (phase?.phase ?? 'connecting') !== 'compacting' ? t('{label} · {duration}', { label: phaseLabel(phase?.phase ?? 'connecting'), duration }) : phaseLabel(phase?.phase ?? 'connecting')
  let label: string
  if (preparing && !hasContent) label = prepLabel
  else if (running) {
    label = phase?.phase === 'waiting_user' || waiting ? t('等待你的回答')
      : phase?.phase === 'compacting' ? `${prepLabel} · ${duration}`
        // 0.63: a worktree conversation's turn writing into the project folder after its answer.
        : phase?.phase === 'applying' ? t('{label} · {duration}', { label: phaseLabel('applying'), duration })
          : t('正在深入 · {duration}', { duration })
  } else if (paused) label = duration ? t('已暂停 · {duration}', { duration }) : t('已暂停')
  else if (turn?.status === 'failed') label = t('处理失败 · {duration}', { duration })
  else if (turn?.status === 'cancelled' || turn?.status === 'stopped' || turn?.status === 'interrupted') label = t('已停止 · {duration}', { duration })
  else label = t('已处理 {duration}', { duration })

  if (preparing && !hasContent) return <ConnectingRow label={prepLabel} detail={phaseDetail(phase?.phase ?? 'connecting')} />
  return (
    <button
      type="button"
      disabled={!hasContent}
      aria-expanded={hasContent ? open : undefined}
      onClick={() => setProcessOpen(turnId, !open)}
      className="group/ph flex h-8 w-full min-w-0 items-center gap-1.5 border-b border-line-faint pb-1 text-left text-[13px] text-fg-3 transition-colors duration-150 enabled:hover:text-fg-2 disabled:cursor-default"
    >
      <span className={cn('truncate tabular-nums', running && !waiting && 'text-shimmer', waiting && 'text-accent-text', !running && turn?.status === 'failed' && 'text-danger')}>{label}</span>
      {hasContent && <ChevronDown className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-200 ease-out', open && 'rotate-180')} />}
      <span className="flex-1" />
      {!running && summary && <span className="min-w-0 shrink truncate text-[12px] tabular-nums text-fg-4">{summary}</span>}
    </button>
  )
}

/** Between steps while the model has not produced the next visible block. */
function LiveTail({ sessionId, turnId, hasSteps }: { sessionId: string; turnId: string; hasSteps: boolean }) {
  const phase = usePhase(sessionId, turnId)
  if (!hasSteps) return null
  if (phase?.phase === 'connecting') return <div className="mt-1"><ConnectingRow label={t('思考中')} detail={phaseDetail('connecting')} /></div>
  if (phase?.phase === 'finishing') return <div className="mt-1"><ConnectingRow label={t('正在收尾')} /></div>
  if (phase?.phase === 'applying') return <div className="mt-1"><ConnectingRow label={phaseLabel('applying')} /></div>
  if (phase && phase.phase !== 'compacting' && isPreparationPhase(phase.phase)) return <div className="mt-1"><ConnectingRow label={phaseLabel(phase.phase)} detail={phaseDetail(phase.phase)} /></div>
  return null
}

/* ------------------------------------------------------------- footer */

function TurnFooter({ sessionId, turnId, answerId, pinned }: { sessionId: string; turnId: string; answerId: string | null; pinned: boolean }) {
  const turn = useTurn(sessionId, turnId)
  const answer = useItem(sessionId, answerId)
  const configuration = useApp(s => s.configuration)
  // A cast vote keeps the footer visible, so the choice stays readable.
  const voted = useVote(sessionId, answerId ?? '').vote !== null
  const end = useApp(s => (turn?.status === 'paused' ? turnLastActivity(s.sessions[sessionId], turnId) : null))
  if (!turn) return null
  const mc = turn.modelConfig
  const model = findModel(configuration, mc?.providerId, mc?.modelId)
  const cap = capabilityOf(model)
  const decision = mc?.reasoningDecision
  const reasoning = decision ? reasoningSummary(cap, decision.requested, decision) : mc?.reasoning && mc.reasoning !== 'default' ? cap.efforts.find(e => e.id === mc.reasoning)?.label ?? mc.reasoning : ''
  const modelName = model?.name ?? mc?.name
  // H5: turn.route advice (model tier, suggested skills, clarify) — shown only in the tooltip, marked by a dot.
  const hints = routeHints(turn.route, decision as { modelTier?: string } | undefined)
  // The same working time as the header, in the same format.
  const ms = turnWorkMs(turn, { live: false, end })
  const duration = ms !== null && ms > 0 ? formatDuration(Math.max(ms, 1000)) : null
  return (
    <div className={cn('mt-2 flex h-7 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[12px] text-fg-4 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/turn:opacity-100', (pinned || voted) && 'opacity-100')}>
      {answer?.text && <CopyButton text={answer.text} className="-ml-1.5" />}
      {answer?.text && !answer.streaming && <FeedbackButtons sessionId={sessionId} itemId={answer.id} />}
      {answer?.text && !answer.streaming && <ForkButton sessionId={sessionId} itemId={answer.id} className="grid size-6 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40" />}
      {/* By default only how long it took (plan §2.5 item 21); time of day, stage timings and model on hover. */}
      {duration && <span className="px-1 tabular-nums">{t('用时 {v}', { v: duration })}</span>}
      <span className={cn('flex min-w-0 items-center gap-1 transition-opacity duration-200 group-hover/turn:opacity-100 focus-within:opacity-100', duration && 'opacity-0')}>
      <span className="px-1">{stampTime(turn.completedAt ?? turn.createdAt)}</span>
      {turn.timing && timingSummary(turn.timing) && (
        <Tooltip content={timingRows(turn.timing).map(([k, v]) => `${k} ${v}`).join(' · ')}>
          <span className="cursor-default rounded-md px-1.5 py-0.5 tabular-nums transition-colors hover:bg-hover hover:text-fg-3">{timingSummary(turn.timing)}</span>
        </Tooltip>
      )}
      {modelName && (
        <Tooltip content={[decision ? `${decisionSource(decision)}${decision.rationale ? t('：{rationale}', { rationale: decision.rationale }) : ''}${decision.latencyMs ? ` · ${decision.latencyMs}ms` : ''}` : t('本轮使用的模型'), ...hints].join(' · ')}>
          <span className="min-w-0 cursor-default truncate rounded-md px-1.5 py-0.5 transition-colors hover:bg-hover hover:text-fg-3">{modelName}{reasoning ? ` · ${reasoning}` : ''}{hints.length ? <span className="ml-1 inline-block size-1 rounded-full bg-accent align-middle opacity-70" aria-label={hints.join(t('；'))} /> : null}</span>
        </Tooltip>
      )}
      </span>
    </div>
  )
}

/* --------------------------------------------------------- other rows */

export const PendingRow = memo(function PendingRow({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  return (
    <article>
      <UserMessage sessionId={sessionId} itemId={itemId} />
      <div className="mt-5"><ConnectingRow /></div>
    </article>
  )
})

export const ItemRow = memo(function ItemRow({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  if (!item) return null
  if (item.kind === 'assistant' && item.source === 'initiative') return <ProactiveMessage sessionId={sessionId} itemId={itemId} />
  if (item.kind === 'assistant') return <AssistantText sessionId={sessionId} itemId={itemId} />
  if (item.kind === 'subagent') return <SubagentCard sessionId={sessionId} itemId={itemId} />
  if (item.kind === 'user') return <UserMessage sessionId={sessionId} itemId={itemId} />
  if (item.kind === 'question') return <QuestionCard sessionId={sessionId} itemId={itemId} />
  if (item.kind === 'tool') return <ToolRow sessionId={sessionId} itemId={itemId} />
  return <NoticeRow sessionId={sessionId} itemId={itemId} />
})
