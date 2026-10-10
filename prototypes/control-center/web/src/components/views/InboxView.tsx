/**
 * 收件箱 (P3): every proactive delivery of the project, whatever its reach
 * tier (对话内 / 安静送达 / 桌面通知 / 每日摘要), with read / dismiss / act,
 * and the 沟通效果 summary from delivery feedback (useful-share and dismiss
 * rates). Older daemons without the inbox routes get a short notice.
 */
import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, CheckCheck, ChevronDown, EyeOff, HelpCircle, Inbox, MessageCircleQuestion, Radio } from 'lucide-react'
import type { MindThread } from '@/api/mind-api'
import { groupByThread, pacingDisplay } from '@/lib/mind'
import { PresentedFiles } from '@/components/timeline/Deliverables'
import { ensureMind, useMind } from '@/store/mind-store'
import { ThreadChip, ThreadMenu } from '@/components/mind/parts'
import { communicationApi, type DeliveryFeedback, type FeedbackWindow, type InboxEntry, type InboxFilter } from '@/api/communication-api'
import { entryDisplay, feedbackSummary } from '@/lib/communication'
import { relativeTime } from '@/lib/format'
import { useApp, useProject } from '@/store/app-store'
import { inboxAction, loadInbox, readAllInbox, useInbox } from '@/store/inbox-store'
import { openInboxEntry } from '@/store/deep-link'
import { Markdown } from '@/components/markdown/Markdown'
import { Button, SegmentedTabs, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Badge, Empty, ListSkeleton, Note, Section, Stat, ViewPage, fullTime } from './kit'
import { t as tr, localized } from '@/i18n'

const FILTERS: { id: InboxFilter; label: string }[] = localized([{ id: 'active', label: '未忽略' }, { id: 'unread', label: '未读' }, { id: 'all', label: '全部' }, { id: 'dismissed', label: '已忽略' }])

export function InboxView({ projectId }: { projectId: string }) {
  const state = useInbox(s => s.projects[projectId])
  const busy = useInbox(s => s.busy)
  const summary = useProject(projectId)
  const unread = summary?.counts?.inboxUnread ?? 0
  const total = summary?.counts?.inbox
  const filter = state?.filter ?? 'active'
  const list = state?.list
  const mind = useMind(s => s.projects[projectId])
  const threads = mind && mind !== 'unsupported' ? mind.threads : undefined
  useEffect(() => { void ensureMind(projectId) }, [projectId])

  // Reload when the index reports a new delivery or a count change.
  useEffect(() => { void loadInbox(projectId) }, [projectId, total, unread])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-quiet">
      <ViewPage title={tr('收件箱')} description={tr('项目主动发来的消息都在这里留有记录：对话内消息、只进收件箱的发现、桌面通知与每日摘要。你的回复、采纳与忽略会用于校准以后何时打扰你。')}
        actions={list && list !== 'unsupported' && unread > 0 ? <Button size="sm" variant="secondary" disabled={busy !== null} leading={<CheckCheck className="size-3.5" />} onClick={() => void readAllInbox(projectId)}>{tr('全部标为已读')}</Button> : undefined}>
        {list === 'unsupported' ? (
          <Empty>{tr('当前本地服务版本尚不支持项目收件箱。升级后，主动消息的记录与反馈会显示在这里。')}</Empty>
        ) : (
          <>
            <FeedbackSection projectId={projectId} revision={`${total}:${unread}`} />
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <SegmentedTabs layoutId="inbox-filter" value={filter} onChange={f => void loadInbox(projectId, f)} items={FILTERS.map(f => ({ ...f, badge: f.id === 'unread' && unread ? unread : undefined }))} />
              <span className="ml-auto text-[12px] text-fg-3">{list ? tr('{total} 条', { total: list.total }) : ''}</span>
            </div>
            {state?.error && <Note tone="danger">{tr('收件箱读取失败：{error}', { error: state.error })}</Note>}
            <div className="mt-3 space-y-2">
              {!list ? <ListSkeleton rows={3} /> : list.entries.length === 0 ? (
                <Empty>{filter === 'unread' ? tr('没有未读消息。') : filter === 'dismissed' ? tr('没有已忽略的消息。') : tr('项目还没有主动发来消息。有值得告诉你的发现时，会按你的设置选择打扰程度。')}</Empty>
              ) : groupByThread(list.entries, threads).map(group => (group.entries.length > 1 || group.thread
                ? <ThreadGroup key={group.key} projectId={projectId} thread={group.thread} entries={group.entries} />
                : <EntryCard key={group.key} projectId={projectId} entry={group.entries[0]} />))}
            </div>
          </>
        )}
      </ViewPage>
    </div>
  )
}

/** Deliveries of one thread: the newest in full, earlier ones folded (“话题历程”). */
function ThreadGroup({ projectId, thread, entries }: { projectId: string; thread: MindThread | null; entries: InboxEntry[] }) {
  const [open, setOpen] = useState(false)
  const unread = entries.filter(e => e.status === 'unread').length
  const [latest, ...earlier] = entries
  return (
    <section aria-label={tr('话题：{title}', { title: thread?.title ?? tr('未命名话题') })} className="rounded-2xl bg-subtle/60 p-1.5 shadow-[inset_0_0_0_1px_var(--line-faint)]">
      <div className="flex min-w-0 items-center gap-2 px-2 pb-1.5 pt-1 text-[12px] text-fg-3">
        <ThreadChip thread={thread ?? { title: tr('未命名话题'), status: 'open' }} className="bg-base" />
        <span className="shrink-0 tabular-nums">{tr('{n} 条', { n: entries.length })}{unread ? ` · ${tr('{unread} 条未读', { unread })}` : ''}</span>
        <span className="flex-1" />
        {thread && <ThreadMenu projectId={projectId} thread={thread} />}
      </div>
      <div className="space-y-1.5">
        <div className="rounded-xl bg-base"><EntryCard projectId={projectId} entry={latest} /></div>
        {earlier.length > 0 && (
          <>
            <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
              className="flex h-7 w-full items-center gap-1 rounded-lg px-2 text-left text-[12.5px] text-fg-3 outline-none hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
              <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
              {open ? tr('收起较早的消息') : tr('较早 {n} 条', { n: earlier.length })}
            </button>
            {open && earlier.map(entry => <div key={entry.id} className="rounded-xl bg-base"><EntryCard projectId={projectId} entry={entry} /></div>)}
          </>
        )}
      </div>
    </section>
  )
}

function EntryCard({ projectId, entry }: { projectId: string; entry: InboxEntry }) {
  const d = entryDisplay(entry)
  const pacing = pacingDisplay(entry.pacing)
  const whyLabel = entry.tier === 'inbox' ? tr('为什么放进收件箱') : tr('为什么这样送达')
  const busy = useInbox(s => s.busy)
  const focused = useInbox(s => s.focus?.projectId === projectId && s.focus.entryId === entry.id)
  const session = useApp(s => (entry.sessionId ? s.sessionIndex[entry.sessionId] : undefined))
  const [open, setOpen] = useState(focused)
  const Icon = entry.kind === 'ask' ? MessageCircleQuestion : Radio
  const long = entry.text.length > 180 || entry.text.split('\n').length > 3
  const expand = () => { setOpen(true); if (d.status === 'unread') void inboxAction(projectId, entry.id, 'read') }
  // Deep link: the exact message (or question card / daily digest) in its conversation.
  const openSession = () => { void openInboxEntry(projectId, entry.id, entry) }
  const locatable = Boolean(entry.itemId || entry.interactionId || entry.digestItemId)
  return (
    <article
      ref={el => { if (el && focused) el.scrollIntoView({ block: 'center' }) }}
      aria-label={`${d.kindLabel} · ${d.statusLabel}`}
      className={cn('rounded-xl px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--line)] transition-colors', d.status === 'dismissed' && 'opacity-70', focused && 'shadow-[inset_0_0_0_1.5px_var(--accent)]')}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        {d.status === 'unread' && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={tr('未读')} />}
        <Icon className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.8} />
        <span className="font-medium text-fg-2">{d.kindLabel}</span>
        <Badge tone="muted">{d.tierLabel}</Badge>
        {pacing && (
          <Tooltip content={
            <span className="block max-w-[280px] space-y-0.5 text-left">
              <span className="block font-medium">{whyLabel}</span>
              {pacing.outcome && <span className="block">{tr('决定：{v}', { v: pacing.outcome })}</span>}
              {pacing.reasons.map(r => <span key={r} className="block">· {r}</span>)}
              {pacing.score && <span className="block opacity-80">{pacing.score}</span>}
            </span>
          }>
            <button type="button" aria-label={`${whyLabel}${tr('：{v}', { v: [pacing.outcome, ...pacing.reasons].filter(Boolean).join(tr('；')) })}`}
              className="grid size-5 place-items-center rounded-md text-fg-4 outline-none hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
              <HelpCircle className="size-3.5" strokeWidth={1.8} />
            </button>
          </Tooltip>
        )}
        {d.outcomeLabel && <Badge tone={d.outcomeTone ?? 'default'}>{d.outcomeLabel}</Badge>}
        <time className="ml-auto tabular-nums text-fg-3" title={fullTime(entry.createdAt)}>{relativeTime(entry.createdAt)}</time>
      </div>
      {d.withdrawn ? <p className="mt-2 text-[13px] text-fg-3">{tr('所在会话已删除，消息正文已清除；反馈记录保留。')}</p> : (
        <div className={cn('relative mt-2', !open && long && 'max-h-[5.2em] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]')}>
          <Markdown text={entry.text} variant="compact" className="text-[13.5px]" />
        </div>
      )}
      {!d.withdrawn && <PresentedFiles projectId={projectId} files={entry.deliverables} className="mt-2.5" />}
      {!open && long && !d.withdrawn && <button type="button" className="mt-1 text-[12.5px] text-accent-text hover:underline" onClick={expand}>{tr('展开全文')}</button>}
      <div className="mt-2 space-y-0.5 text-[12px] leading-[1.6] text-fg-3">
        {session && <p>{tr('来自会话「{v}」{v2}', { v: session.title || tr('项目会话'), v2: session.archivedAt ? tr(' · 已归档') : '' })}</p>}
        {d.lowered && <p>{tr('触达已降低：{lowered}', { lowered: d.lowered })}</p>}
        {d.digest && <p>{d.digest}</p>}
      </div>
      {!d.withdrawn && d.status !== 'dismissed' && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {session && !session.archivedAt && <Button size="sm" variant="secondary" leading={<ArrowUpRight className="size-3.5" />} onClick={openSession}>{entry.digestItemId && !entry.itemId ? tr('查看每日摘要') : locatable ? tr('在对话中定位') : tr('打开会话')}</Button>}
          {d.status === 'unread' && <Button size="sm" variant="ghost" disabled={busy !== null} leading={<Check className="size-3.5" />} onClick={() => void inboxAction(projectId, entry.id, 'read')}>{tr('标为已读')}</Button>}
          {d.canAct && <Button size="sm" variant="ghost" disabled={busy !== null} title={tr('据此采取了行动：会计为有用的主动消息')} onClick={() => void inboxAction(projectId, entry.id, 'act')}>{tr('已处理')}</Button>}
          <Button size="sm" variant="ghost" disabled={busy !== null} leading={<EyeOff className="size-3.5" />} title={tr('不再提醒；会计为被忽略的主动消息')} onClick={() => void inboxAction(projectId, entry.id, 'dismiss')}>{tr('忽略')}</Button>
        </div>
      )}
    </article>
  )
}

/* ----------------------------------------------------- delivery feedback */

function FeedbackSection({ projectId, revision }: { projectId: string; revision: string }) {
  const [window, setWindow] = useState<FeedbackWindow>('7d')
  const [data, setData] = useState<DeliveryFeedback | null | 'unsupported'>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    communicationApi.feedback(projectId, window).then(next => { if (live) { setData(next ?? 'unsupported'); setError(null) } }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [projectId, window, revision])
  if (data === 'unsupported') return null
  const s = data ? feedbackSummary(data) : null
  return (
    <Section className="mt-0" title={<span className="inline-flex items-center gap-1.5"><Inbox className="size-3.5" />{tr('沟通效果')}</span>}
      aside={<SegmentedTabs layoutId="feedback-window" value={window} onChange={setWindow} items={[{ id: '24h', label: tr('24 小时') }, { id: '7d', label: tr('7 天') }, { id: '30d', label: tr('30 天') }]} />}>
      {error && <Note tone="danger">{tr('反馈统计读取失败：{error}', { error })}</Note>}
      {!s ? <ListSkeleton rows={1} /> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={tr('有用率（回复或采纳）')} value={s.useful} />
            <Stat label={tr('忽略率')} value={s.dismiss} />
            <Stat label={tr('无反应')} value={s.ignore} />
            <Stat label={tr('已送达 · 待反应')} value={`${s.delivered} · ${s.pending}`} />
          </div>
          <p className="mt-2 px-1 text-[12px] leading-[1.7] text-fg-3">
            {tr('{v}{v2} · {sample}。比率以已判定的消息为分母；对话内与桌面通知 12 小时、收件箱与摘要 48 小时内无反应记为「无反应」。', { v: s.tiers.map(t => `${t.label} ${t.count}`).join(' · '), v2: data && typeof data !== 'string' && data.lowered ? tr(' · {lowered} 条被降低了打扰程度', { lowered: data.lowered }) : '', sample: s.sample })}
          </p>
        </>
      )}
    </Section>
  )
}
