/**
 * 收件箱 bell (H3): unread count across projects (`counts.inboxUnread`, kept
 * current by the index stream; `notify` events refresh an open popover). The
 * popover lists the unread entries with read / 已处理 / 忽略 and one 全部已读
 * for all projects; read ones stay on the full 收件箱 page (查看全部). A message
 * delivered into a conversation is read once that conversation is in front.
 * One from an archived conversation is left to the 收件箱 (it cannot be continued
 * there until restored); the popover says how many were left out.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Bell, Check, CheckCheck, EyeOff, MessageCircleQuestion, MessagesSquare, Radio } from 'lucide-react'
import { threadForItem } from '@/lib/mind'
import { ensureMind, useMind, type MindSlot } from '@/store/mind-store'
import { communicationApi, type InboxEntry } from '@/api/communication-api'
import { entryDisplay } from '@/lib/communication'
import { relativeTime } from '@/lib/format'
import { useApp } from '@/store/app-store'
import { replaceEntry, setUnread } from '@/store/inbox-store'
import { openInboxEntry } from '@/store/deep-link'
import { onNotify } from '@/store/sync'
import { openInbox, toast } from '@/store/ui-store'
import { Popover, PopoverTrigger } from '@/components/ui/overlays'
import { Skeleton, Tooltip } from '@/components/ui/primitives'
import { Popover as RPopover } from 'radix-ui'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

type Row = InboxEntry & { projectId: string }
const LIMIT = 8

const plain = (text: string) => text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim()

export function InboxBell() {
  const projects = useApp(s => s.projects)
  const live = useMemo(() => Object.values(projects).filter(p => !p.archivedAt), [projects])
  const unread = live.reduce((n, p) => n + (p.counts?.inboxUnread ?? 0), 0)
  const revision = live.map(p => `${p.id}:${p.counts?.inbox ?? ''}:${p.counts?.inboxUnread ?? ''}`).join('|')
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [archived, setArchived] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [pulse, setPulse] = useState(0)
  const minds = useMind(s => s.projects)

  const load = useCallback(async () => {
    const targets = Object.values(useApp.getState().projects).filter(p => !p.archivedAt && (p.counts?.inboxUnread ?? 1) > 0)
    const lists = await Promise.all(targets.map(p => communicationApi.inbox(p.id, 'unread', LIMIT).catch(() => null)))
    const unread = lists.flatMap((list, i) => (list ? list.entries.filter(e => !e.contextRevoked && e.status === 'unread').map(e => ({ ...e, projectId: targets[i].id })) : []))
    const sessions = useApp.getState().sessionIndex
    const merged = unread.filter(e => !(e.sessionId && sessions[e.sessionId]?.archivedAt))
    merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    setRows(merged.slice(0, LIMIT))
    setArchived(unread.length - merged.length)
    // v2 mind: thread titles for the rows (404 → no titles).
    for (const id of new Set(merged.slice(0, LIMIT).map(r => r.projectId))) void ensureMind(id)
  }, [])

  useEffect(() => { if (open) void load() }, [open, revision, load])
  useEffect(() => onNotify(() => { setPulse(n => n + 1); if (open) void load() }), [open, load])

  const act = async (row: Row, action: 'read' | 'dismiss' | 'act') => {
    if (busy) return
    setBusy(row.id)
    try {
      const result = await communicationApi.act(row.projectId, row.id, action)
      replaceEntry(row.projectId, result.entry, result.unread)
      // Only unread entries are listed: any action reads the entry, so it leaves the list.
      setRows(list => (list ?? []).filter(r => r.id !== row.id || r.projectId !== row.projectId))
      if (action === 'dismiss') toast(t('已忽略这条消息，之后不再提醒。'))
      else if (action === 'act') toast(t('已记录为已处理。'))
    } catch (error) { toast((error as Error).message, 'danger') } finally { setBusy(null) }
  }

  // 全部已读: every project with unread entries (the same read as one by one; no feedback signal).
  const readAll = async () => {
    if (busy) return
    setBusy('all')
    try {
      const targets = Object.values(useApp.getState().projects).filter(p => !p.archivedAt && (p.counts?.inboxUnread ?? 0) > 0)
      await Promise.all(targets.map(p => communicationApi.readAll(p.id).then(result => setUnread(p.id, result.unread))))
      setRows([]); setArchived(0)
      toast(t('已全部标为已读。'))
    } catch (error) { toast((error as Error).message, 'danger'); void load() } finally { setBusy(null) }
  }

  const label = unread ? t('通知，{unread} 条未读', { unread }) : t('通知')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={label}
            className="relative grid size-7 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active data-[state=open]:text-fg">
            <motion.span key={pulse} className="grid place-items-center" animate={pulse ? { rotate: [0, -14, 12, -8, 5, 0] } : undefined} transition={{ duration: 0.6 }}>
              <Bell className="size-4" strokeWidth={1.8} />
            </motion.span>
            <AnimatePresence>
              {unread > 0 && (
                <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 30 }}
                  className="absolute -right-0.5 -top-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-semibold tabular-nums text-[var(--accent-contrast)] ring-2 ring-[var(--bg-base)]" aria-hidden>
                  {unread > 99 ? '99+' : unread}
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <RPopover.Portal>
        <RPopover.Content align="end" side="bottom" sideOffset={8} collisionPadding={10} aria-label={t('通知')}
          className="menu-content z-50 flex max-h-[min(560px,calc(100dvh-80px))] w-[min(380px,calc(100vw-20px))] flex-col overflow-hidden rounded-xl bg-elevated text-[13px] shadow-lg outline-none">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line-faint px-3.5">
            <span className="text-[13px] font-semibold text-fg">{t('通知')}</span>
            {unread > 0 && <span className="text-[12px] tabular-nums text-fg-3">{t('{unread} 条未读', { unread })}</span>}
            <span className="flex-1" />
            {unread > 0 && (
              <button type="button" disabled={busy !== null} onClick={() => void readAll()}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3.5">
                <CheckCheck strokeWidth={1.8} />{t('全部已读')}
              </button>
            )}
            <button type="button" onClick={() => { setOpen(false); openInbox(rows?.find(r => r.status === 'unread')?.projectId ?? null) }}
              className="rounded-md px-1.5 py-0.5 text-[12.5px] text-accent-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{t('查看全部')}</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-quiet p-1.5">
            {rows === null ? (
              <div className="space-y-3 p-2.5" aria-hidden><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3.5 w-11/12" /><Skeleton className="h-3.5 w-2/3" /></div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <span className="mx-auto mb-2.5 grid size-9 place-items-center rounded-full bg-subtle text-fg-3"><Bell className="size-4" strokeWidth={1.7} /></span>
                <p className="text-[13px] text-fg-2">{t('没有新的通知')}</p>
                <p className="mt-1 text-[12px] leading-[1.6] text-fg-3">{t('已读的消息都在收件箱里，点「查看全部」查看。')}</p>
              </div>
            ) : (
              <ul>
                {rows.map(row => <BellRow key={`${row.projectId}:${row.id}`} row={row} projectName={projects[row.projectId]?.name ?? ''} busy={busy === row.id}
                  thread={threadTitle(minds[row.projectId], row)}
                  onOpen={() => { setOpen(false); void openInboxEntry(row.projectId, row.id, row) }} onAct={a => void act(row, a)} />)}
              </ul>
            )}
            {rows !== null && archived > 0 && <p className="px-2.5 pb-1.5 pt-1 text-[12px] leading-[1.6] text-fg-4">{t('另有 {n} 条来自已归档的对话，在收件箱里查看。', { n: archived })}</p>}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </Popover>
  )
}

function threadTitle(slot: MindSlot | undefined, row: Row) {
  if (!slot || slot === 'unsupported') return null
  return threadForItem(slot.threads, row.itemId ?? '', row.threadId)?.title ?? null
}

function BellRow({ row, projectName, busy, thread, onOpen, onAct }: { row: Row; projectName: string; busy: boolean; thread: string | null; onOpen: () => void; onAct: (a: 'read' | 'dismiss' | 'act') => void }) {
  const d = entryDisplay(row)
  const Icon = row.kind === 'ask' ? MessageCircleQuestion : Radio
  const unread = d.status === 'unread'
  return (
    <li className={cn('group relative rounded-lg transition-colors focus-within:bg-hover hover:bg-hover', busy && 'opacity-60')}>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <span className="relative mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-subtle text-fg-3">
          <Icon className="size-3.5" strokeWidth={1.8} />
          {unread && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent ring-2 ring-[var(--bg-elevated)]" aria-label={t('未读')} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <span className="max-w-[40%] shrink-0 truncate font-medium text-fg-2">{projectName}</span>
            {thread ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex min-w-0 items-center gap-1 text-fg-2" title={t('话题：{title}', { title: thread })}>
                  <MessagesSquare className="size-3 shrink-0" strokeWidth={1.8} aria-hidden /><span className="sr-only">{t('话题')}</span><span className="truncate">{thread}</span>
                </span>
              </>
            ) : (
              <>
                <span aria-hidden>·</span><span className="shrink-0">{d.kindLabel}</span>
                {/* English labels run longer: the delivery tier truncates before the project name does. */}
                <span aria-hidden>·</span><span className="min-w-0 truncate">{d.tierLabel}</span>
              </>
            )}
            <time className="ml-auto shrink-0 pl-2 tabular-nums">{relativeTime(row.createdAt)}</time>
          </span>
          <span className={cn('mt-0.5 line-clamp-2 text-[13px] leading-[1.55]', unread ? 'text-fg' : 'text-fg-2')}>{d.withdrawn ? t('所在会话已删除，消息正文已清除。') : plain(row.text)}</span>
        </span>
      </button>
      {!d.withdrawn && d.status !== 'dismissed' && (
        <div className="flex gap-0.5 pb-1.5 pl-[44px] pr-2">
          {unread && <BellAction icon={<Check />} label={t('标为已读')} disabled={busy} onClick={() => onAct('read')} />}
          {d.canAct && <BellAction label={t('已处理')} disabled={busy} onClick={() => onAct('act')} />}
          <BellAction icon={<EyeOff />} label={t('忽略')} disabled={busy} onClick={() => onAct('dismiss')} />
        </div>
      )}
    </li>
  )
}

function BellAction({ icon, label, onClick, disabled }: { icon?: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3">
      {icon}{label}
    </button>
  )
}
