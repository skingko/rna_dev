/**
 * 使用统计: today's real token usage (/api/health) and prompt-cache coverage by
 * purpose (/api/v2/usage/cache). Stat tiles for the headline numbers and a
 * per-purpose table with single-hue magnitude bars (one measure, one hue).
 */
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { CacheStats, CacheUsage, UsageRun } from '@/api/types'
import { ProjectPicker } from '@/components/projects/ProjectPicker'
import { Button, SegmentedTabs, Skeleton } from '@/components/ui/primitives'
import { formatPercent, formatTokens, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Empty, Note, SettingsSection } from '../form'
import { reloadGlobals, useGlobals } from '../globals-store'
import type { SectionProps } from '../SettingsDialog'
import { t, localized } from '@/i18n'

/** Every purpose the host records (USAGE_PURPOSES in packages/sdk/src/prompt-layers.mjs) plus older ledger ids; an id this
 * build does not know reads as 其他用途, never as the raw id. */
const PURPOSES: Record<string, string> = localized({
  foreground: '前台对话', initiative: '主动协作', 'background-work': '后台工作', learning: '自主学习', evaluation: '版本评测', evolution: '自进化', compaction: '上下文整理', summary: '摘要', initialization: '项目初始化',
  jev: 'JEV 判断', 'jev-llm': '快速判断', 'skill-foundation': '基础技能准备', subagent: '协作助手', vision: '图片理解', memory: '记忆', narrator: '消息改写', mind: '项目心智', other: '其他用途',
})
export const purposeName = (id: string) => (Object.hasOwn(PURPOSES, id) ? PURPOSES[id] : PURPOSES.other)

type Window = '1h' | '24h' | '7d'

export default function UsageSection({ projectId, setProjectId }: SectionProps) {
  const usage = useGlobals(s => s.health?.workload?.tokenUsage)
  const settings = useGlobals(s => s.settings)
  const [window, setWindow] = useState<Window>('24h')
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [cache, setCache] = useState<CacheUsage | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setCache(await panelsApi.cacheUsage(window, scope === 'project' ? projectId ?? undefined : undefined)); setError(null) }
    catch (e) { setError((e as Error).message); setCache(null) }
    finally { setLoading(false) }
  }
  useEffect(() => { void reloadGlobals() }, [])
  useEffect(() => { void load() }, [window, scope, projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reported = usage?.reported ?? 0, estimated = usage?.estimated ?? 0, reserved = usage?.reserved ?? 0
  const limit = settings?.realTokenBudget ?? null
  const overall = cache?.overall
  const rows = Object.entries(cache?.byPurpose ?? {}).sort((a, b) => (b[1].input + b[1].cacheRead) - (a[1].input + a[1].cacheRead))
  const maxVolume = Math.max(1, ...rows.map(([, s]) => s.input + s.cacheRead))
  // Cache reads apart from fresh tokens (token-burn study Z1): "8.2M tokens" was mostly a cached prefix read again, not 8.2M of fresh input.
  // No cost or price enters this page: the backend does not track real prices. Older daemons send no `runs`.
  const runs = cache?.runs ?? []
  const maxRunTokens = Math.max(1, ...runs.map(run => run.tokens))
  const totalTokens = overall ? overall.input + overall.cacheRead + overall.cacheWrite + (overall.output ?? 0) : 0
  const showSplit = Boolean(overall && overall.requests > 0 && totalTokens > 0)

  return (
    <>
      <SettingsSection title={t('今日真实用量')} description={<>{t('提供商报告优先；缺失报告时按估算记账。')}{showSplit ? ` ${t('tokens 含缓存读取（重复读到的已缓存前缀），不都是新处理的输入，拆分见下方“缓存命中”。')}` : ''}</>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label={t('今日 tokens')} value={formatTokens(reported + estimated)} hint={limit ? t('每日上限 {v} · 已用 {v2}', { v: formatTokens(limit), v2: formatPercent((reported + estimated) / limit) }) : t('未设置每日上限')} />
          <Tile label={t('提供商报告')} value={formatTokens(reported)} hint={t('估算 {v}', { v: formatTokens(estimated) })} />
          <Tile label={t('请求预留')} value={formatTokens(reserved)} hint={t('进行中请求的预留量')} />
        </div>
        {limit ? (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-label={t('今日用量占每日上限')} aria-valuenow={Math.min(100, Math.round((reported + estimated) / limit * 100))} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.min(100, (reported + estimated) / limit * 100)}%` }} />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('缓存命中')}
        description={t('命中率 = 缓存读取 ÷（输入 + 缓存读取），按已报告的请求加权；覆盖率 = 报告了缓存用量的请求占比。')}
        action={<Button size="sm" variant="ghost" disabled={loading} leading={<RefreshCw className={cn('size-3.5', loading && 'spin')} />} onClick={() => void load()}>{t('刷新')}</Button>}
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SegmentedTabs<Window> layoutId="usage-window" value={window} onChange={setWindow} className="rounded-lg bg-subtle p-0.5" items={[{ id: '1h', label: t('1 小时') }, { id: '24h', label: t('24 小时') }, { id: '7d', label: t('7 天') }]} />
          <SegmentedTabs<'all' | 'project'> layoutId="usage-scope" value={scope} onChange={setScope} className="rounded-lg bg-subtle p-0.5" items={[{ id: 'all', label: t('全部项目') }, { id: 'project', label: t('单个项目') }]} />
          {scope === 'project' && <ProjectPicker value={projectId} onChange={setProjectId} />}
        </div>
        {error ? <Note tone="danger">{error}</Note> : cache === undefined ? (
          <div className="space-y-3"><Skeleton className="h-20 w-full rounded-xl" /><Skeleton className="h-40 w-full rounded-xl" /></div>
        ) : cache === null || !overall ? <Empty>{t('当前 daemon 未提供缓存统计接口。')}</Empty> : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Tile label={t('命中率')} value={formatPercent(overall.hitRate)} emphasis />
              <Tile label={t('覆盖率')} value={formatPercent(overall.coverage)} hint={overall.unreported ? t('{unreported} 次未报告', { unreported: overall.unreported }) : undefined} />
              <Tile label={t('请求')} value={String(overall.requests)} hint={t('冷启动 {coldStarts}', { coldStarts: overall.coldStarts })} />
              <Tile label={t('缓存读取')} value={formatTokens(overall.cacheRead)} hint={t('输入 {v}', { v: formatTokens(overall.input) })} />
            </div>
            {showSplit && <p className="mt-2 text-[12px] text-fg-4">{t('tokens {v} = 新处理 {v2} + 缓存读取 {v3}（缓存读取占 {v4}）。缓存读取是重复读到的已缓存前缀，不是新处理的输入。', { v: formatTokens(totalTokens), v2: formatTokens(freshTokens(overall)), v3: formatTokens(overall.cacheRead), v4: formatPercent(overall.cacheRead / totalTokens) })}</p>}
            {cache.judge && (cache.judge.product && cache.judge.probe
              ? <p className="mt-2 text-[12px] text-fg-4">{t('JEV 判断：产品判断 {v} 次（输入 {v2} · 输出 {v3}）· 探针 {v4} 次（输入 {v5} · 输出 {v6}）。探针是开发者的调试入口，不是产品行为；两者都没有提示缓存，不计入以上缓存统计。', { v: cache.judge.product.requests, v2: formatTokens(cache.judge.product.input), v3: formatTokens(cache.judge.product.output), v4: cache.judge.probe.requests, v5: formatTokens(cache.judge.probe.input), v6: formatTokens(cache.judge.probe.output) })}</p>
              : <p className="mt-2 text-[12px] text-fg-4">{t('JEV 判断 {v} 次 · 输入 {v2} · 输出 {v3}（没有提示缓存，不计入以上缓存统计）', { v: cache.judge.requests, v2: formatTokens(cache.judge.input), v3: formatTokens(cache.judge.output) })}</p>)}
            {cache.keepAlive && <p className="mt-2 text-[12px] text-fg-4">{t('空闲时保持缓存 {v} 次 · 缓存读取 {v2}（不是对话请求，不计入以上缓存统计）', { v: cache.keepAlive.requests, v2: formatTokens(cache.keepAlive.cacheRead) })}</p>}
            {cache.latest && <p className="mt-2 text-[12px] text-fg-4">{t('最近一次请求：{v} · 命中 {v2} · {v3}', { v: purposeName(cache.latest.purpose), v2: formatPercent(cache.latest.hitRate), v3: relativeTime(cache.latest.at) })}</p>}
            {rows.length ? (
              <div className="mt-4 overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line)]">
                <table className="w-full text-[12.5px] tabular-nums">
                  <thead className="bg-subtle text-left text-[11.5px] text-fg-4">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('用途')}</th>
                      <th className="px-3 py-2 font-medium">{t('命中率')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('请求')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('输入 / 缓存读取')}</th>
                      <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t('覆盖率')}</th>
                    </tr>
                  </thead>
                  <tbody>{rows.map(([id, s]) => <PurposeRow key={id} id={id} stats={s} maxVolume={maxVolume} />)}</tbody>
                </table>
              </div>
            ) : <Empty>{t('这个时间范围内还没有模型请求。')}</Empty>}
          </>
        )}
      </SettingsSection>

      {runs.length > 0 && (
        <SettingsSection title={t('最大的运行')} description={t('按 tokens 排序的前 {v} 个会话（后台运行、定时任务、前台对话），tokens 含缓存读取。没有会话的请求（决策、评测等）不在其中。', { v: runs.length })}>
          <div className="overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line)]">
            <table className="w-full text-[12.5px] tabular-nums">
              <thead className="bg-subtle text-left text-[11.5px] text-fg-4">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('运行')}</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">{t('开始')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('请求')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('新处理 / 缓存读取')}</th>
                  <th className="px-4 py-2 font-medium">{t('合计 tokens')}</th>
                </tr>
              </thead>
              <tbody>{runs.map(run => <RunRow key={run.sessionId} run={run} maxTokens={maxRunTokens} />)}</tbody>
            </table>
          </div>
          <p className="mt-2 text-[12px] text-fg-4">{t('这些运行合计 {v}，占本时间范围 tokens 的 {v2}。', { v: formatTokens(runs.reduce((sum, run) => sum + run.tokens, 0)), v2: formatPercent(totalTokens ? runs.reduce((sum, run) => sum + run.tokens, 0) / totalTokens : null) })}</p>
        </SettingsSection>
      )}
    </>
  )
}

/** Tokens a request processed fresh (uncached input, cache writes, output), apart from what it read from the cache. */
const freshTokens = (s: { input: number; cacheWrite: number; output?: number }) => s.input + s.cacheWrite + (s.output ?? 0)

function RunRow({ run, maxTokens }: { run: UsageRun; maxTokens: number }) {
  const name = run.title || purposeName(run.purpose)
  const detail = [run.kind === 'scheduled' ? t('定时任务') : run.title ? purposeName(run.purpose) : null, run.projectName].filter(Boolean).join(' · ')
  return (
    <tr className="border-t border-line-faint transition-colors hover:bg-hover" title={`${name} · ${run.sessionId}`}>
      <td className="max-w-[16rem] px-4 py-2.5">
        <p className="truncate text-fg">{name}</p>
        {detail && <p className="truncate text-[11.5px] text-fg-4">{detail}</p>}
      </td>
      <td className="hidden px-3 py-2.5 text-fg-3 sm:table-cell">{relativeTime(run.firstAt)}</td>
      <td className="px-3 py-2.5 text-right text-fg-2">{run.requests}</td>
      <td className="px-3 py-2.5 text-right text-fg-3">{formatTokens(freshTokens(run))} / {formatTokens(run.cacheRead)}</td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, run.tokens / maxTokens * 100)}%` }} /></div>
          <span className="text-fg-2">{formatTokens(run.tokens)}</span>
        </div>
      </td>
    </tr>
  )
}

function Tile({ label, value, hint, emphasis }: { label: string; value: string; hint?: string; emphasis?: boolean }) {
  return (
    <div className="rounded-xl bg-base px-4 py-3 shadow-[0_0_0_1px_var(--line)]">
      <p className="text-[11.5px] font-medium text-fg-4">{label}</p>
      <p className={cn('mt-1 text-[22px] font-semibold leading-7 tracking-[-0.02em] tabular-nums', emphasis ? 'text-accent-text' : 'text-fg')}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11.5px] text-fg-4">{hint}</p>}
    </div>
  )
}

function PurposeRow({ id, stats, maxVolume }: { id: string; stats: CacheStats; maxVolume: number }) {
  const hit = stats.hitRate ?? 0
  return (
    <tr className="border-t border-line-faint transition-colors hover:bg-hover" title={t('{v}：命中 {v2} · 输入 {v3} · 缓存读取 {v4} · 缓存写入 {v5}', { v: purposeName(id), v2: formatPercent(stats.hitRate), v3: stats.input.toLocaleString(), v4: stats.cacheRead.toLocaleString(), v5: stats.cacheWrite.toLocaleString() })}>
      <td className="px-4 py-2.5 text-fg">{purposeName(id)}</td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(hit * 100)}%` }} /></div>
          <span className="w-10 text-fg-2">{formatPercent(stats.hitRate)}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right text-fg-2">{stats.requests}</td>
      <td className="px-3 py-2.5 text-right text-fg-3">
        <span className="inline-flex items-center gap-2">
          <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-muted sm:inline-block"><span className="block h-full rounded-full bg-fg-4" style={{ width: `${Math.max(2, (stats.input + stats.cacheRead) / maxVolume * 100)}%` }} /></span>
          {formatTokens(stats.input)} / {formatTokens(stats.cacheRead)}
        </span>
      </td>
      <td className="hidden px-4 py-2.5 text-right text-fg-3 sm:table-cell">{formatPercent(stats.coverage)}</td>
    </tr>
  )
}
