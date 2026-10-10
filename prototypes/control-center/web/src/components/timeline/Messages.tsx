import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Copy, GitBranch, Pencil, Trash2, MessagesSquare, ArrowUpRight, CalendarClock, CheckCircle2, ChevronDown, CornerDownRight, Info, Loader2, Newspaper, Radio, Sparkles, Sunrise } from 'lucide-react'
import type { Item } from '@/api/types'
import type { MindThread } from '@/api/mind-api'
import { ensureMind, useMind } from '@/store/mind-store'
import { useVote } from '@/store/feedback-store'
import { DELETE_UNDO_MS, openInbox, toast, toggleDisclosure, useUi } from '@/store/ui-store'
import { api } from '@/api/client'
import { selectSession } from '@/store/sync'
import { openExistingSideChat } from '@/components/side-panel/open'
import { openTasksPanel } from '@/components/workspace/tasks-panel'
import { plainText, threadForItem, threadPosition, welcomeBackDisplay } from '@/lib/mind'
import { BackgroundDeliverables } from './BackgroundDeliverables'
import { ThreadChip, ThreadMenu } from '@/components/mind/parts'
import { FeedbackButtons } from './FeedbackButtons'
import { focusTimelineItem } from './timeline-focus'
import { useApp, useItem } from '@/store/app-store'
import { relativeTime, stampTime } from '@/lib/format'
import { Markdown } from '@/components/markdown/Markdown'
import { useWorkspaceMarkdown } from '@/components/preview/WorkspaceMedia'
import { Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { SubagentNotice } from './SubagentCard'
import { PresentedFiles } from './Deliverables'
import { TIER_HINTS, digestDisplay } from '@/lib/communication'
import { openDigestEntries, openSessionItem } from '@/store/deep-link'
import { t } from '@/i18n'

/* --------------------------------------------------------------- user */

/** `added`: a message taken into a running turn. Rewind and fork start from a turn's own message, so it offers copy only. */
export const UserMessage = memo(function UserMessage({ sessionId, itemId, added = false }: { sessionId: string; itemId: string; added?: boolean }) {
  const item = useItem(sessionId, itemId)
  const deleting = useUi(s => s.deleting === `${sessionId}:${itemId}`)
  if (!item) return null
  if (item.source === 'subagent') return <SubagentNotice sessionId={sessionId} item={item} />
  return (
    <div className={cn('group/user flex flex-col items-end gap-1 transition-opacity duration-300', deleting && 'opacity-40')}>
      <div
        className={cn(
          'max-w-[min(82%,600px)] whitespace-pre-wrap break-words rounded-[20px] bg-subtle px-4 py-2.5 text-[15px] leading-[1.7] text-fg shadow-[inset_0_0_0_0.5px_var(--line-faint)] transition-opacity duration-300',
          item.optimistic && 'opacity-70',
        )}
      >
        {item.text}
      </div>
      {item.attachments && item.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.attachments.map(a => <span key={a.id ?? a.name} className="rounded-md bg-subtle px-2 py-0.5 text-[12px] text-fg-3">{a.name}</span>)}
        </div>
      )}
      <div className="flex h-6 items-center gap-1 pr-1 text-[11.5px] text-fg-4 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/user:opacity-100">
        <span>{item.optimistic ? t('发送中…') : `${item.delivery === 'steer' ? t('已在运行中加入 · ') : item.delivery === 'followup' ? t('下一轮补充 · ') : ''}${stampTime(item.createdAt)}`}</span>
        {!item.optimistic && item.turnId && <UserMessageActions sessionId={sessionId} itemId={itemId} text={item.text ?? ''} copyOnly={added} />}
      </div>
    </div>
  )
})

/** Copy, edit and delete. Edit and delete rewind the conversation to just before
 * this message (Harness rewind): the replies after it and the model context
 * built from them are removed, not only hidden. */
function UserMessageActions({ sessionId, itemId, text, copyOnly = false }: { sessionId: string; itemId: string; text: string; copyOnly?: boolean }) {
  const running = useApp(s => { const meta = s.sessions[sessionId]?.meta; return Boolean(meta && meta.status !== 'idle') })
  const [busy, setBusy] = useState(false)
  const button = 'grid size-6 place-items-center rounded-md text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40'
  const blocked = running ? t('当前轮次运行中，停止后才能编辑或删除') : undefined
  // Act first, undo within a few seconds: the rewind runs only when the undo window closes.
  const remove = () => {
    const key = `${sessionId}:${itemId}`
    setBusy(true); useUi.setState({ deleting: key })
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.rewindItem(sessionId, itemId, 'user_delete')
        toast(t('已删除这条消息及之后的 {n} 条内容，模型上下文已一并回退。', { n: Math.max(0, result.removedItems - 1) }))
      } catch (error) { toast(t('删除未完成：{message}', { message: (error as Error).message }), 'danger') }
      finally { setBusy(false); useUi.setState(s => (s.deleting === key ? { deleting: null } : {})) }
    }, DELETE_UNDO_MS)
    toast(t('将删除这条消息和之后的回复'), 'default', { durationMs: DELETE_UNDO_MS, action: { label: t('撤销'), run: () => { window.clearTimeout(timer); setBusy(false); useUi.setState(s => (s.deleting === key ? { deleting: null } : {})) } } })
  }
  return (
    <span className="flex items-center gap-0.5">
      <Tooltip content={t('复制')}><button type="button" className={button} aria-label={t('复制消息')} onClick={() => { void navigator.clipboard.writeText(text).then(() => toast(t('已复制'))) }}><Copy className="size-3.5" /></button></Tooltip>
      {!copyOnly && <>
      <Tooltip content={blocked ?? t('编辑消息')}><button type="button" className={button} disabled={running || busy} aria-label={t('编辑消息')} onClick={() => useUi.setState({ editing: { sessionId, itemId, text } })}><Pencil className="size-3.5" /></button></Tooltip>
      <ForkButton sessionId={sessionId} itemId={itemId} className={button} />
      <Tooltip content={blocked ?? t('删除这条消息及之后的回复')}><button type="button" className={button} disabled={running || busy} aria-label={t('删除消息')} onClick={remove}><Trash2 className="size-3.5" /></button></Tooltip>
      </>}
    </span>
  )
}

/** Plan §4.5: 从这里分叉 — try another way from this message; the original conversation stays as it is. */
export function ForkButton({ sessionId, itemId, className }: { sessionId: string; itemId: string; className: string }) {
  const [busy, setBusy] = useState(false)
  const fork = async () => {
    setBusy(true)
    try { const created = await api.forkSession(sessionId, itemId); await selectSession(created.id); toast(t('已从这里分叉出新会话，原对话保留。')) }
    catch (error) { toast(t('分叉没有完成：{message}', { message: (error as Error).message }), 'danger') } finally { setBusy(false) }
  }
  return <Tooltip content={t('从这里分叉')}><button type="button" className={className} disabled={busy} aria-label={t('从这里分叉')} onClick={() => void fork()}><GitBranch className="size-3.5" /></button></Tooltip>
}

/* ------------------------------------------------------ assistant text */

export const AssistantText = memo(function AssistantText({ sessionId, itemId, interim = false }: { sessionId: string; itemId: string; interim?: boolean }) {
  const item = useItem(sessionId, itemId)
  // Images and file links the agent writes as project paths (media/x.png) resolve in the project's workspace.
  const workspaceMarkdown = useWorkspaceMarkdown(useApp(s => s.sessionIndex[sessionId]?.projectId ?? null), sessionId)
  if (!item?.text) return null
  return (
    // `data-assistant-item`: text selections here offer 在辅助对话中提问 (SelectionAsk).
    <div data-assistant-item={itemId}>
      <Markdown
        text={item.text}
        streaming={Boolean(item.streaming)}
        overrides={workspaceMarkdown}
        className={cn(interim && 'my-2 text-[14px] leading-[1.7] text-fg-2 [&_strong]:text-fg-2')}
      />
      {/* Closing the loop (plan §2.1.1): once, when a lesson from the user's own feedback is first followed. */}
      {item.lessonNote && !item.streaming && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-fg-4"><Sparkles className="size-3 shrink-0" strokeWidth={1.8} />{t('按你之前说的：{text}', { text: item.lessonNote.text })}</p>
      )}
    </div>
  )
})

/* ------------------------------------------------------ relative time */

/** One shared half-minute clock for "刚刚 / 5 分钟前" on screen; only the time text re-renders. */
const AGO_TICK_MS = 30_000
const agoListeners = new Set<() => void>()
let agoTimer: ReturnType<typeof setInterval> | null = null
function subscribeAgo(listener: () => void) {
  agoListeners.add(listener)
  agoTimer ??= setInterval(() => { for (const l of agoListeners) l() }, AGO_TICK_MS)
  return () => {
    agoListeners.delete(listener)
    if (!agoListeners.size && agoTimer) { clearInterval(agoTimer); agoTimer = null }
  }
}
const agoSnapshot = () => Math.floor(Date.now() / AGO_TICK_MS) * AGO_TICK_MS

/** `relativeTime` that keeps itself current while the app stays open; `format` wraps it in a sentence. */
export function Ago({ iso, format }: { iso?: string | null; format?: (ago: string) => string }) {
  const now = useSyncExternalStore(subscribeAgo, agoSnapshot, agoSnapshot)
  const ago = relativeTime(iso, now)
  return <>{format ? format(ago) : ago}</>
}

/* --------------------------------------------------- proactive message */

export function originOf(item: Item): { label: string; icon: typeof Radio; description: string } | null {
  // Origin comes from recorded host fields only; revoked records are not restyled.
  const record = item as Item & { sourceDeleted?: boolean; contextRevoked?: boolean }
  if (item.source !== 'initiative' || record.sourceDeleted || record.contextRevoked) return null
  // A scheduled badge needs the durable occurrence identity, not just the kind.
  if (item.initiative?.kind === 'scheduled' && item.scheduleOccurrenceKey) return { label: t('定时交付'), icon: CalendarClock, description: t('来自已登记日程的项目会话投递。') }
  // The line a scheduled run posts while it works: the user set this up, it is not an unprompted share.
  if (item.initiative?.scheduledWork) return { label: t('定时任务'), icon: CalendarClock, description: ['running', 'paused'].includes(item.initiative.backgroundWork?.status ?? '') ? t('你登记的定时任务正在后台运行，做完后结果会送到这里。') : t('你登记的定时任务这次在后台做的工作。') }
  if (item.initiative?.kind === 'digest') return { label: t('每日摘要'), icon: Newspaper, description: t('暂存的发现在每天固定时间合并为一条摘要。') }
  if (item.initiative?.kind === 'welcome_back') return { label: t('你不在时的进展'), icon: Sunrise, description: t('你离开期间暂存的发现，回来后合并为一条。') }
  if (item.initiative?.kind === 'thread_close') return { label: t('话题收尾'), icon: CheckCircle2, description: t('这个话题已经完成，不会再主动提起。') }
  if (item.initiative?.kind === 'version_ready') return { label: t('版本建议'), icon: Sparkles, description: t('项目能力有新的候选版本。') }
  return { label: t('主动分享'), icon: Radio, description: t('项目主动协作发来的独立消息，不是当前请求的回复。') }
}

export const ProactiveMessage = memo(function ProactiveMessage({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  const projectId = useApp(s => s.sessionIndex[sessionId]?.projectId ?? null)
  const slot = useMind(s => (projectId ? s.projects[projectId] : undefined))
  useEffect(() => { if (projectId) void ensureMind(projectId) }, [projectId])
  const voted = useVote(sessionId, itemId).vote !== null
  const workspaceMarkdown = useWorkspaceMarkdown(projectId)
  if (!item) return null
  if (item.initiative?.kind === 'digest') return <DigestCard sessionId={sessionId} item={item} />
  const threads = slot && slot !== 'unsupported' ? slot.threads : undefined
  if (item.initiative?.kind === 'welcome_back') return <WelcomeBackCard sessionId={sessionId} item={item} projectId={projectId} threads={threads} />
  if (item.initiative?.kind === 'thread_close') return <ThreadCloseRow item={item} thread={threadForItem(threads, itemId, item.initiative?.threadId)} />
  const origin = originOf(item) ?? { label: t('项目消息'), icon: Radio, description: '' }
  const Icon = origin.icon
  const reach = TIER_HINTS[item.initiative?.reach ?? '']
  const thread = slot && slot !== 'unsupported' ? threadForItem(slot.threads, itemId, item.initiative?.threadId) : null
  const position = thread ? threadPosition(thread, itemId) : null
  return (
    <div className="group/pro relative pl-4" data-thread={thread?.id}>
      <span className="absolute bottom-1 left-0 top-1 w-[2px] rounded-full bg-[color-mix(in_srgb,var(--accent)_28%,transparent)]" aria-hidden />
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <Tooltip content={origin.description}>
          <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-accent-softer px-2 font-medium text-accent-text">
            <Icon className="size-3.5" strokeWidth={1.8} />
            {origin.label}
          </span>
        </Tooltip>
        {thread && <ThreadChip thread={thread} />}
        <span className="text-fg-4"><Ago iso={item.createdAt} /></span>
        {reach && <span className="text-fg-4" title={t('实际触达方式')}>· {reach}</span>}
        {thread && projectId && <ThreadMenu projectId={projectId} thread={thread} className="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover/pro:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100" />}
      </div>
      {thread && position?.continues && <ThreadHistory sessionId={sessionId} thread={thread} earlier={position.earlier} />}
      <Markdown text={item.text} streaming={Boolean(item.streaming)} overrides={workspaceMarkdown} />
      {projectId && item.initiative?.backgroundWork && ['running', 'paused'].includes(item.initiative.backgroundWork.status) && <WorkingLine projectId={projectId} actionId={item.initiative.backgroundWork.actionId} paused={item.initiative.backgroundWork.status === 'paused'} />}
      {!item.streaming && <PresentedFiles projectId={projectId} files={item.initiative?.deliverables} className="mt-2.5" />}
      {!item.streaming && projectId && item.initiative?.backgroundChange && <BackgroundDeliverables projectId={projectId} changeId={item.initiative.backgroundChange} />}
      {item.initiative?.details && !item.streaming && <NarratedDetails itemKey={`${sessionId}:${itemId}`} details={item.initiative.details} />}
      {!item.streaming && (
        <div className={cn('mt-1 flex h-6 items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/pro:opacity-100 max-md:opacity-100', voted && 'opacity-100')}>
          <FeedbackButtons sessionId={sessionId} itemId={itemId} className="-ml-1.5" />
        </div>
      )}
    </div>
  )
})

/** A background run still going (or paused): its line says so until the run fills in what it did; 查看进度 opens its card in the 后台任务 panel. */
function WorkingLine({ projectId, actionId, paused }: { projectId: string; actionId: string; paused: boolean }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-fg-3" role="status" data-background-working>
      {paused ? <span className="size-1.5 rounded-full bg-fg-4" aria-hidden /> : <Loader2 className="size-3.5 animate-spin text-accent-text" aria-hidden />}
      <span>{paused ? t('已暂停') : t('工作中…')}</span>
      <button type="button" onClick={() => openTasksPanel({ focusRunId: `${projectId}:action:${actionId}`, projectId })}
        className="rounded-md px-1 text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('查看进度')}</button>
    </div>
  )
}

/** K2 v1 items only (`initiative.details` is no longer produced): the full report behind a quiet disclosure. */
function NarratedDetails({ itemKey, details }: { itemKey: string; details: string }) {
  const key = `narrated-details:${itemKey}`
  const open = useUi(s => s.disclosure[key] ?? false)
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} onClick={() => toggleDisclosure(key)}
        className="-ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
        {open ? t('收起详情') : t('展开详情')}
      </button>
      {open && (
        <div className="mt-1 rounded-xl bg-subtle px-3.5 py-2.5">
          <Markdown text={details} variant="compact" className="text-[13.5px] text-fg-2" />
        </div>
      )}
    </div>
  )
}

/** “你不在时的进展”: the host's topics in display order (each tied to its thread by id); the rest went to the inbox. */
function WelcomeBackCard({ sessionId, item, projectId, threads }: { sessionId: string; item: Item; projectId: string | null; threads: MindThread[] | undefined }) {
  const view = welcomeBackDisplay(item.initiative, item.text, threads ?? [])
  return (
    <section aria-label={t('你不在时的进展')} className="rounded-2xl px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--line)] [background:linear-gradient(180deg,var(--accent-softer),transparent_70%),var(--bg-base)]">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="grid size-6 place-items-center rounded-lg bg-accent-soft text-accent"><Sunrise className="size-3.5" strokeWidth={1.8} /></span>
        <strong className="text-[13.5px] font-semibold text-fg">{t('你不在时的进展')}</strong>
        <span className="text-fg-4">{view.fallback === null ? <Ago iso={item.createdAt} format={v => t('{n} 个话题 · {v}', { n: view.topics.length, v })} /> : <Ago iso={item.createdAt} />}</span>
      </div>
      {view.fallback !== null ? <Markdown text={view.fallback} variant="compact" className="mt-2.5" /> : (
        <ol className="mt-2.5 space-y-2.5">
          {view.topics.map((topic, i) => (
            <li key={topic.threadId ?? i} className="flex gap-2.5 text-[14px] leading-[1.7] text-fg" data-topic-thread={topic.threadId ?? undefined}>
              <span className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-subtle text-[11px] tabular-nums text-fg-3">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {topic.thread ? (
                  <button type="button" onClick={() => jumpToThread(sessionId, topic.thread!, item.id)} title={t('查看这个话题的历程')}
                    className="mb-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
                    <ThreadChip thread={topic.thread} className="hover:bg-hover" />
                  </button>
                ) : topic.title ? <strong className="mb-0.5 block text-[13px] font-medium text-fg-2">{topic.title}</strong> : null}
                <Markdown text={topic.text} variant="compact" />
                <PresentedFiles projectId={projectId} files={topic.deliverables} className="mt-2" />
              </div>
            </li>
          ))}
        </ol>
      )}
      {view.filed > 0 && (
        <button type="button" disabled={!projectId} onClick={() => projectId && openInbox(projectId)}
          className="mt-2.5 inline-flex items-center gap-1 rounded-md px-1 -ml-1 text-[12.5px] text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
          {t('另有 {n} 条较次要的进展在收件箱', { n: view.filed })}<ArrowUpRight className="size-3" aria-hidden />
        </button>
      )}
    </section>
  )
}

/** Jump to the newest earlier message of a thread in this conversation (else its session). */
function jumpToThread(sessionId: string, thread: MindThread, fromItemId: string) {
  const ids = thread.messageItemIds.filter(id => id !== fromItemId)
  const target = ids.at(-1)
  if (!target) return
  const other = thread.messageSessions?.[target]
  if (other && other !== sessionId) void openSessionItem(other, target)
  else focusTimelineItem(sessionId, target)
}

/** What a closed thread's line says: written here from the host's fields in the interface language, else the text the host stored (older rows). */
function threadCloseText(item: Item): string {
  const { title, resolution } = item.initiative ?? {}
  if (typeof title !== 'string' || !title.trim()) return plainText(item.text)
  const detail = typeof resolution === 'string' ? resolution.trim() : ''
  return plainText(detail ? t('「{title}」已完成：{resolution}', { title: title.trim(), resolution: detail }) : t('「{title}」已完成。', { title: title.trim() }))
}

/** A thread closed: one quiet line, no card. */
export function ThreadCloseRow({ item, thread }: { item: Item; thread: MindThread | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-[13px] leading-6 text-fg-3" role="note" aria-label={t('话题收尾')}>
      <CheckCircle2 className="size-3.5 shrink-0 text-success" strokeWidth={1.8} aria-hidden />
      {thread && <ThreadChip thread={thread} className="shrink-0" />}
      <span className="line-clamp-2 min-w-0 flex-1">{threadCloseText(item)}</span>
      <span className="shrink-0 text-[12px] text-fg-4"><Ago iso={item.createdAt} /></span>
    </div>
  )
}

/** “接上次”: earlier messages of the same thread, collapsed by default. */
function ThreadHistory({ sessionId, thread, earlier }: { sessionId: string; thread: MindThread; earlier: string[] }) {
  const key = `thread-history:${sessionId}:${thread.id}:${earlier.length}`
  const open = useUi(s => s.disclosure[key] ?? false)
  const items = useApp(s => s.sessions[sessionId]?.items)
  const rows = useMemo(() => earlier.map(id => ({ id, item: items?.[id] })).reverse(), [earlier, items])
  return (
    <div className="mb-1.5">
      <button type="button" aria-expanded={open} onClick={() => toggleDisclosure(key)}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1 -ml-1 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <CornerDownRight className="size-3.5" strokeWidth={1.8} aria-hidden />
        {t('接上次')}
        <span className="text-fg-4">· {t('较早 {n} 条', { n: earlier.length })}</span>
        <ChevronDown className={cn('size-3 text-fg-4 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ol className="mt-1 space-y-1 border-l border-line pl-3" aria-label={t('话题历程：{title}', { title: thread.title })}>
          {rows.map(({ id, item }) => {
            const other = thread.messageSessions?.[id]
            return (
              <li key={id}>
                {item ? (
                  <button type="button" onClick={() => focusTimelineItem(sessionId, id)}
                    className="block w-full rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
                    <span className="block text-[11.5px] text-fg-4"><Ago iso={item.createdAt} /></span>
                    <span className="line-clamp-2 text-[13px] leading-[1.6] text-fg-3">{plainText(item.text)}</span>
                  </button>
                ) : other ? (
                  <button type="button" onClick={() => void openSessionItem(other, id)} className="rounded-md px-1.5 py-1 text-[12.5px] text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('在另一段对话中 · 打开')}</button>
                ) : <span className="block px-1.5 py-1 text-[12.5px] text-fg-4">{t('这条消息不在当前对话中。')}</span>}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** Daily digest (`initiative.kind: 'digest'`): held findings merged into one summary card. */
export function DigestCard({ sessionId, item }: { sessionId: string; item: Item }) {
  const digest = digestDisplay(item.text, item.initiative?.entryIds, item.initiative?.lines)
  const projectId = useApp(s => s.sessionIndex[sessionId]?.projectId ?? null)
  return (
    <section aria-label={t('每日摘要')} className="rounded-2xl px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--line)] [background:linear-gradient(180deg,var(--accent-softer),transparent_70%),var(--bg-base)]">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="grid size-6 place-items-center rounded-lg bg-accent-soft text-accent"><Newspaper className="size-3.5" strokeWidth={1.8} /></span>
        <strong className="text-[13.5px] font-semibold text-fg">{t('每日摘要')}</strong>
        <span className="text-fg-4"><Ago iso={item.createdAt} format={v => t('{count} 条发现 · {v}', { count: digest.count, v })} /></span>
        <button type="button" disabled={!projectId} onClick={() => projectId && openDigestEntries(projectId, item.initiative?.entryIds ?? [])} className="ml-auto rounded-md px-1.5 py-0.5 text-accent-text hover:bg-hover">{t('在收件箱查看')}</button>
      </div>
      <ol className="mt-2.5 space-y-1.5">
        {digest.lines.map((line, i) => (
          <li key={i} className="flex gap-2.5 text-[14px] leading-[1.7] text-fg">
            <span className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-subtle text-[11px] tabular-nums text-fg-3">{i + 1}</span>
            <Markdown text={line} variant="compact" className="min-w-0 flex-1" />
          </li>
        ))}
      </ol>
    </section>
  )
}

/* -------------------------------------------------------------- notice */

export const NoticeRow = memo(function NoticeRow({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  if (!item) return null
  if (item.source === 'subagent') return <SubagentNotice sessionId={sessionId} item={item} />
  if (item.source === 'side-chat') return <SideChatNote sessionId={sessionId} item={item} />
  return (
    <div className={cn('flex items-start gap-2 py-1 text-[12.5px] leading-5', item.progress ? 'text-fg-3' : 'text-fg-4')} {...(item.progress ? { role: 'status', 'aria-live': 'polite' as const } : {})}>
      {item.progress ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" strokeWidth={1.8} /> : <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />}
      <span>{item.text}</span>
    </div>
  )
})

/** S2: a side-chat answer the user added here — quiet, quoted, and a link back to its 辅助对话. */
function SideChatNote({ sessionId, item }: { sessionId: string; item: Item }) {
  const side = item.sideChat
  const open = () => { if (side?.sessionId) openExistingSideChat(sessionId, side.sessionId) }
  return (
    <div className="border-l-2 border-line py-0.5 pl-3" data-side-chat-note>
      <button type="button" onClick={open} disabled={!side?.sessionId} className="mb-1 inline-flex items-center gap-1.5 rounded text-[12px] text-fg-4 transition-colors enabled:hover:text-fg-2">
        <MessagesSquare className="size-3.5" strokeWidth={1.8} />{t('来自辅助对话')}
      </button>
      <div className="text-fg-3 [&_strong]:text-fg-2"><Markdown text={item.text} variant="compact" /></div>
    </div>
  )
}

/* ---------------------------------------------------------- connecting */

export function ConnectingRow({ label = t('思考中'), detail = null }: { label?: string; detail?: string | null }) {
  return (
    <div className="flex h-7 items-center gap-2 text-[13px] text-fg-3" title={detail ?? undefined}>
      <span className="flex size-4 items-center justify-center gap-[3px]" aria-hidden>
        {[0, 1, 2].map(i => (
          <span key={i} className="size-[3px] rounded-full bg-fg-4 pulse-dot" style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </span>
      <span className="text-shimmer">{label}</span>
    </div>
  )
}
