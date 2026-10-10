/**
 * Quiet line under the composer: context ring + percentage and cache hit
 * rate. Cache comes from /api/v2/usage/cache when the daemon provides it,
 * otherwise from the latest reported assistant usage in this session.
 */
import { useEffect } from 'react'
import { useApp } from '@/store/app-store'
import { refreshCacheSoon } from '@/store/sync'
import { formatPercent, formatTokens } from '@/lib/format'
import { Tooltip } from '@/components/ui/primitives'
import type { CacheUsage, Item, SessionMeta } from '@/api/types'
import { t } from '@/i18n'

function ContextRing({ ratio }: { ratio: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const color = clamped > 0.85 ? 'var(--state-danger)' : clamped > 0.65 ? 'var(--state-warning)' : 'var(--accent)'
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - clamped)} className="transition-[stroke-dashoffset] duration-500 ease-out" />
    </svg>
  )
}

/** This conversation's latest own reply that reported cache use (initiative messages say nothing about this chat). */
export function latestUsageReply(slice: { items: Record<string, Item>; order: string[] } | undefined): Item | null {
  if (!slice) return null
  for (let i = slice.order.length - 1; i >= 0; i--) {
    const it = slice.items[slice.order[i]]
    if (it?.kind === 'assistant' && it.source !== 'initiative' && it.usage?.cacheUsageReported !== false && typeof it.usage?.cacheRead === 'number') return it
  }
  return null
}

/** Context use against the conversation's own model (C2-a): the host keeps `usage.capacity` on that model, also after
 * a turn auto-routed to a faster one, and marks the figure `estimated` whenever it rescaled a measurement to it (the
 * model was changed, or the last request ran on the faster model). */
export function contextMeter(meta: SessionMeta | undefined) {
  const context = meta?.context
  const tokens = context?.usage?.estimatedInputTokens ?? context?.tokens ?? null
  const capacity = context?.usage?.capacity || meta?.modelConfig?.contextWindow || context?.capacity || null
  return { tokens, capacity, ratio: tokens !== null && capacity ? tokens / capacity : null, estimated: context?.usage?.estimated === true }
}

const DAY_MS = 24 * 3600_000

/** Cache hit shown under the composer: this conversation's last reply first, then foreground requests in the window. */
export function cacheMeter(reply: Item | null, cache: CacheUsage | null, now = Date.now()) {
  const u = reply?.usage
  const prompt = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0
  const local = u && prompt > 0 ? (u.cacheRead ?? 0) / prompt : null
  // The window figures are read every so often and can lag a turn behind; a reply inside the window counts.
  const fresh = local !== null && now - Date.parse(reply!.createdAt) < DAY_MS
  // No request in the window (e.g. right after a restart): '—', never 0% or an old session value.
  const idle = Boolean(cache && cache.overall.requests === 0) && !fresh
  // The global `latest` can be a background (initiative) request whose cache profile says nothing about this chat.
  const foreground = cache?.byPurpose?.foreground
  const hit = idle ? null : local ?? (foreground && foreground.requests > 0 ? foreground.hitRate : null) ?? cache?.overall.hitRate ?? null
  return { hit, idle, windowed: Boolean(cache && cache.overall.requests > 0), foreground }
}

export function ComposerMeters() {
  const meta = useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId]?.meta : undefined))
  // Item objects are replaced on change, so this re-renders when a reply's usage lands, not on text deltas.
  const reply = useApp(s => latestUsageReply(s.selectedSessionId ? s.sessions[s.selectedSessionId] : undefined))
  const projectId = useApp(s => s.selectedProjectId)
  const cache = useApp(s => s.cache)
  const status = meta?.status
  // The window figures follow the project in front and each finished turn (sync.ts reads at most every 30 s).
  useEffect(() => { if (status !== 'running') refreshCacheSoon() }, [projectId, status])
  const { tokens, capacity, ratio, estimated } = contextMeter(meta)
  const context = meta?.context
  const { hit, idle, windowed, foreground } = cacheMeter(reply, cache)

  return (
    <div className="mt-2 flex h-5 items-center gap-3 overflow-hidden whitespace-nowrap px-2 text-[11.5px] text-fg-4">
      {ratio !== null && (
        <Tooltip content={t('上下文约 {v} / {v2} tokens{v3}', { v: formatTokens(tokens!), v2: formatTokens(capacity!), v3: (context?.compactions ? t(' · 已整理 {compactions} 次', { compactions: context.compactions }) : '') + (estimated ? t(' · 按本会话模型的容量估算，下次请求后更新') : '') })} side="top">
          <span className="inline-flex cursor-default items-center gap-1.5 tabular-nums"><ContextRing ratio={ratio} />{t('上下文 {v}', { v: formatPercent(ratio) })}</span>
        </Tooltip>
      )}
      {(idle || (hit !== null && hit !== undefined)) && (
        <Tooltip
          side="top"
          content={idle ? t('近 {window} 还没有模型请求', { window: cache!.window }) : windowed ? t('近 {window} 缓存命中 {v} · 覆盖 {v2} · 冷启动 {coldStarts} 次', { window: cache!.window, v: formatPercent(foreground?.hitRate ?? cache!.overall.hitRate), v2: formatPercent(cache!.overall.coverage), coldStarts: cache!.overall.coldStarts }) : t('最近一次对话请求的输入缓存比例（按 token 加权）')}
        >
          <span className="cursor-default tabular-nums">{t('缓存命中 {v}', { v: formatPercent(hit) })}</span>
        </Tooltip>
      )}
      <span className="flex-1" />
      <span className="hidden @[640px]/composer:inline">{t('Enter 发送 · Shift Enter 换行 · / 命令')}</span>
    </div>
  )
}
