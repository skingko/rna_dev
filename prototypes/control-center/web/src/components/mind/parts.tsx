/**
 * Small pieces shared by the mind surfaces: thread chip + menu (timeline,
 * inbox, 进化 › Rna 学到的), provenance link and the learning-health line.
 */
import type { ReactNode } from 'react'
import { ArrowUpRight, BellOff, CheckCircle2, MessagesSquare, MoreHorizontal, RotateCcw } from 'lucide-react'
import type { MindHealth, MindSource, MindThread } from '@/api/mind-api'
import { healthLine, SOURCE_KINDS } from '@/lib/mind'
import { patchMindEntry } from '@/store/mind-store'
import { openSessionItem } from '@/store/deep-link'
import { useApp } from '@/store/app-store'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/components/ui/overlays'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export function threadStatusLabel(status: string, t: ReturnType<typeof useT>) {
  return status === 'resolved' ? t('已解决') : status === 'muted' ? t('已静音') : null
}

/** Mute / resolve / reopen a thread; acts on all later messages of the topic. */
export function ThreadMenu({ projectId, thread, className, label }: { projectId: string; thread: MindThread; className?: string; label?: ReactNode }) {
  const t = useT()
  const set = (status: string, done: string) => void patchMindEntry(projectId, 'threads', thread.id, { status }, done)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={t('话题操作：{title}', { title: thread.title })}
          className={cn('inline-grid h-6 min-w-6 place-items-center rounded-md px-1 text-fg-4 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] data-[state=open]:bg-active data-[state=open]:text-fg', className)}>
          {label ?? <MoreHorizontal className="size-3.5" />}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-56">
        <MenuLabel>{t('话题 · {title}', { title: thread.title })}</MenuLabel>
        {thread.status !== 'muted' && <MenuItem icon={<BellOff />} hint={t('不再主动提起')} onSelect={() => set('muted', t('已静音这个话题。'))}>{t('静音话题')}</MenuItem>}
        {thread.status !== 'resolved' && <MenuItem icon={<CheckCircle2 />} onSelect={() => set('resolved', t('话题已标为解决。'))}>{t('标为已解决')}</MenuItem>}
        {thread.status !== 'open' && <MenuItem icon={<RotateCcw />} onSelect={() => set('open', t('话题已重新打开。'))}>{thread.status === 'muted' ? t('取消静音') : t('重新打开')}</MenuItem>}
      </MenuContent>
    </Menu>
  )
}

export function ThreadChip({ thread, className }: { thread: Pick<MindThread, 'title' | 'status'>; className?: string }) {
  const t = useT()
  const state = threadStatusLabel(thread.status, t)
  return (
    <span className={cn('inline-flex h-[22px] min-w-0 max-w-[260px] items-center gap-1 rounded-full px-2 text-[12px] shadow-[inset_0_0_0_1px_var(--line)]', thread.status === 'open' ? 'text-fg-2' : 'text-fg-3', className)}>
      <MessagesSquare className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
      <span className="sr-only">{t('话题')}</span>
      <span className="min-w-0 truncate">{thread.title}</span>
      {state && <span className="shrink-0 text-fg-4">· {state}</span>}
    </span>
  )
}

/** “来自你的纠正 ↗” — jumps to the source message when it still exists. */
export function Provenance({ source }: { source?: MindSource | null }) {
  const t = useT()
  const known = useApp(s => Boolean(source?.sessionId && s.sessionIndex[source.sessionId] && !s.sessionIndex[source.sessionId].archivedAt))
  if (!source) return null
  const label = SOURCE_KINDS[source.kind] ?? t('来源：{v}', { v: source.kind })
  if (!source.sessionId || !source.itemId || !known) return <span>{label}</span>
  return (
    <button type="button" onClick={() => void openSessionItem(source.sessionId!, source.itemId!)} title={t('跳到出处消息')}
      className="inline-flex items-center gap-0.5 rounded text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
      {label}<ArrowUpRight className="size-3" aria-hidden />
    </button>
  )
}

export function HealthLine({ health, lessons, className }: { health?: MindHealth | null; lessons: number; className?: string }) {
  const t = useT()
  const h = healthLine(health)
  return (
    <p role="status" className={cn('flex items-center gap-2 text-[12.5px]', h.paused ? 'text-warning-text' : 'text-fg-3', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', h.paused ? 'bg-warning' : 'bg-success')} aria-hidden />
      {h.paused ? (h.reason ? t('学习暂停：{reason}', { reason: h.reason }) : t('学习暂停')) : t('正在学习 · {n} 条经验生效', { n: lessons })}
    </p>
  )
}
