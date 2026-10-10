/**
 * 轨迹 (after Harness ui-trajectory): a dense, turn-aware ledger of every event
 * in the session — kind, content, tokens, thinking time, duration, model — with
 * search, fold-all, proportional duration bars and a tabbed detail pane
 * (概述 / 参数 / 结果 / 思考 / 计时 / 用量). Virtualized for long sessions.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock3, Search } from 'lucide-react'
import type { Item, Turn } from '@/api/types'
import { useApp } from '@/store/app-store'
import { toolFailed, toolKind, toolRunning, toolStopped, toolTarget, VERBS, parseCommandOutput } from '@/lib/tools'
import { clockTime, elapsed, formatShortDuration, formatTokens } from '@/lib/format'
import { phaseLabel, timingRows, timingSummary } from '@/lib/phases'
import { Markdown } from '@/components/markdown/Markdown'
import { SegmentedTabs } from '@/components/ui/primitives'
import { TerminalOutput } from '@/components/timeline/ToolViews'
import { subagentNoticeText, subagentRoleName, subagentStatusLabel } from '@/components/timeline/SubagentCard'
import { turnLastActivity, turnWorkMs } from '@/store/session-model'
import { useWholeHistory } from '@/store/use-whole-history'
import { cn } from '@/lib/utils'
import { Badge, DefinitionList, SplitView, type Tone } from './kit'
import { t as tr, localized, intlTag } from '@/i18n'

type Kind = 'user' | 'assistant' | 'thinking' | 'tool' | 'question' | 'notice' | 'proactive' | 'subagent'
const KIND: Record<Kind, { label: string; tone: Tone }> = localized({
  user: { label: '用户', tone: 'accent' },
  assistant: { label: '助手', tone: 'default' },
  thinking: { label: '思考', tone: 'muted' },
  tool: { label: '工具', tone: 'warning' },
  question: { label: '提问', tone: 'success' },
  notice: { label: '提示', tone: 'muted' },
  proactive: { label: '主动', tone: 'accent' },
  subagent: { label: '子代理', tone: 'success' },
})

interface Entry {
  item: Item; kind: Kind; text: string; status: 'ok' | 'failed' | 'running' | 'stopped'
  ms: number | null; thinkMs: number | null; input?: number; output?: number
}
type Row = { type: 'turn'; key: string; turnId: string; index: number; turn?: Turn; count: number; ms: number | null; input: number; output: number } | { type: 'entry'; key: string; entry: Entry; turnId: string | null }

const LIVE_TURN = new Set(['running', 'pending', 'queued'])

function describe(item: Item): Entry {
  const thinkMs = item.thinking ? elapsed(item.thinking.startedAt, item.thinking.endedAt ?? null) : null
  if (item.kind === 'tool' && item.tool) {
    const t = item.tool
    const kind = toolKind(t)
    const status = toolFailed(t) ? 'failed' : toolStopped(t) ? 'stopped' : toolRunning(t) ? 'running' : 'ok'
    return { item, kind: 'tool', text: `${VERBS[kind].done} ${toolTarget(t)}`.trim(), status, ms: elapsed(t.startedAt, t.endedAt ?? null), thinkMs: null }
  }
  if (item.kind === 'subagent' && item.subagent) {
    const a = item.subagent
    const status = a.status === 'failed' ? 'failed' : a.status === 'running' ? 'running' : a.status === 'completed' ? 'ok' : 'stopped'
    return { item, kind: 'subagent', text: `${subagentRoleName(a)} · ${a.task ?? item.text}`, status, ms: elapsed(a.startedAt, a.endedAt ?? null), thinkMs: null, input: a.usage?.input, output: a.usage?.output }
  }
  const base = { item, status: item.streaming ? 'running' as const : 'ok' as const, ms: elapsed(item.startedAt, item.endedAt ?? null), thinkMs, input: item.usage?.input, output: item.usage?.output }
  if (item.kind === 'assistant' && item.source === 'initiative') return { ...base, kind: 'proactive', text: item.text }
  if (item.kind === 'assistant' && !item.text && item.thinking) return { ...base, kind: 'thinking', text: item.thinking.text || (item.thinking.visibility === 'hidden' ? tr('（思考内容未公开）') : '') }
  if (item.kind === 'question') return { ...base, kind: 'question', text: item.interaction?.questions?.[0]?.question ?? tr('提问') }
  // A subagent delivery reads as its notice line, not the prompt the model was given.
  if (item.source === 'subagent') return { ...base, kind: 'notice', text: subagentNoticeText(item).text, ms: null }
  if (item.kind === 'user') return { ...base, kind: 'user', text: item.text, ms: null }
  if (item.kind === 'assistant') return { ...base, kind: 'assistant', text: item.text }
  return { ...base, kind: 'notice', text: item.text, ms: null }
}

export function TrajectoryView({ sessionId }: { sessionId: string }) {
  // The whole trajectory: older turns than the timeline's window are paged in (B9).
  useWholeHistory(sessionId)
  const order = useApp(s => s.sessions[sessionId]?.order)
  const items = useApp(s => s.sessions[sessionId]?.items)
  const turns = useApp(s => s.sessions[sessionId]?.turns)
  const phases = useApp(s => s.sessions[sessionId]?.phases)
  const configuration = useApp(s => s.configuration)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [durations, setDurations] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { rows, turnIds, maxMs, totals } = useMemo(() => {
    const list = (order ?? []).map(id => items?.[id]).filter((i): i is Item => Boolean(i) && !i!.optimistic)
    const turnOrder = Object.values(turns ?? {}).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    const turnIndex = new Map(turnOrder.map((t, i) => [t.id, i + 1]))
    const q = query.trim().toLowerCase()
    const out: Row[] = []
    const ids: string[] = []
    let maxMs = 0
    let totalIn = 0
    let totalOut = 0
    let currentTurn: string | null = null
    let header: Extract<Row, { type: 'turn' }> | null = null
    for (const item of list) {
      const entry = describe(item)
      if (entry.ms) maxMs = Math.max(maxMs, entry.ms)
      totalIn += entry.input ?? 0
      totalOut += entry.output ?? 0
      if (q && !`${entry.text} ${KIND[entry.kind].label} ${item.tool?.name ?? ''}`.toLowerCase().includes(q)) continue
      const turnId = item.turnId && item.source !== 'initiative' ? item.turnId : null
      if (turnId && turnId !== currentTurn) {
        const turn = turns?.[turnId]
        // Working time across attempts, as the conversation shows it (a retry's idle wait is not counted).
        const ms = turnWorkMs(turn, { live: LIVE_TURN.has(turn?.status ?? ''), end: turn?.status === 'paused' ? turnLastActivity({ items: items ?? {}, order: order ?? [] }, turnId) : null })
        header = { type: 'turn', key: `turn:${turnId}`, turnId, index: turnIndex.get(turnId) ?? 0, turn, count: 0, ms, input: 0, output: 0 }
        out.push(header)
        ids.push(turnId)
      }
      if (!turnId) header = null
      currentTurn = turnId
      if (header) { header.count++; header.input += entry.input ?? 0; header.output += entry.output ?? 0 }
      if (turnId && collapsed.has(turnId)) continue
      out.push({ type: 'entry', key: item.id, entry, turnId })
    }
    return { rows: out, turnIds: ids, maxMs, totals: { items: list.length, turns: turnOrder.length, input: totalIn, output: totalOut } }
  }, [order, items, turns, query, collapsed])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: i => (rows[i]?.type === 'turn' ? 40 : 32),
    getItemKey: i => rows[i]?.key ?? i,
    overscan: 12,
  })

  const allCollapsed = turnIds.length > 0 && turnIds.every(id => collapsed.has(id))
  const toggleTurn = (id: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const close = useCallback(() => setSelected(null), [])
  const selectedItem = selected ? items?.[selected] : undefined
  const modelName = (turn?: Turn) => turn?.modelConfig?.name ?? configuration?.providers.find(p => p.id === turn?.modelConfig?.providerId)?.models.find(m => m.id === turn?.modelConfig?.modelId)?.name ?? ''

  return (
    <SplitView detailLabel={tr('轨迹详情')} onClose={close} detail={selectedItem ? <EntryDetail item={selectedItem} turn={selectedItem.turnId ? turns?.[selectedItem.turnId] : undefined} phase={selectedItem.turnId ? phases?.[selectedItem.turnId]?.phase : undefined} /> : null} list={
      <div className="@container flex h-full min-h-0 flex-col">
        <div role="toolbar" aria-label={tr('轨迹工具栏')} className="flex h-11 shrink-0 items-center gap-2 border-b border-line-faint px-4">
          <label className="flex h-8 w-[min(280px,40vw)] items-center gap-2 rounded-lg bg-subtle px-2.5 text-fg-3 focus-within:shadow-[inset_0_0_0_1px_var(--line-focus)]">
            <Search className="size-3.5 shrink-0" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('搜索轨迹')} aria-label={tr('搜索轨迹')} className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4" />
          </label>
          <span className="hidden truncate whitespace-nowrap text-[12px] tabular-nums text-fg-3 @[760px]:inline">{tr('{items} 条记录 · {turns} 轮{v}', { items: totals.items, turns: totals.turns, v: totals.input ? tr(' · 输入 {v} · 输出 {v2}', { v: formatTokens(totals.input), v2: formatTokens(totals.output) }) : '' })}</span>
          <span className="flex-1" />
          <button type="button" aria-pressed={durations} onClick={() => setDurations(v => !v)} title={durations ? tr('使用等宽操作') : tr('使用实际时长')} className={cn('inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] transition-colors', durations ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg')}>
            <Clock3 className="size-3.5" />{tr('时长')}
          </button>
          <button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(turnIds))} className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">
            {allCollapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}<span className="hidden @[640px]:inline">{allCollapsed ? tr('展开所有轮次') : tr('收起所有轮次')}</span>
          </button>
        </div>
        <div className="grid h-8 shrink-0 grid-cols-[48px_minmax(0,1fr)_64px_44px] items-center gap-3 border-b border-line-faint px-4 text-[11.5px] font-medium text-fg-3 @[760px]:grid-cols-[56px_minmax(0,1fr)_60px_60px_52px_120px_48px]">
          <span>{tr('类型')}</span><span>{tr('内容')}</span><span className="hidden text-right @[760px]:block">{tr('输入')}</span><span className="hidden text-right @[760px]:block">{tr('输出')}</span><span className="hidden text-right @[760px]:block">{tr('思考')}</span><span>{tr('时间')}</span><span className="text-right">{tr('时刻')}</span>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scroll-quiet" tabIndex={-1}>
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(v => {
              const row = rows[v.index]
              return (
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                  {row.type === 'turn'
                    ? <TurnHeader row={row} collapsed={collapsed.has(row.turnId)} onToggle={() => toggleTurn(row.turnId)} model={modelName(row.turn)} />
                    : <EntryRow entry={row.entry} maxMs={maxMs} durations={durations} selected={selected === row.entry.item.id} onSelect={() => setSelected(row.entry.item.id)} />}
                </div>
              )
            })}
          </div>
          {!rows.length && <p className="px-4 py-10 text-center text-[13px] text-fg-3">{query ? tr('没有匹配的记录') : tr('这段会话还没有记录')}</p>}
        </div>
      </div>
    } />
  )
}

const EFFORT: Record<string, string> = localized({ minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高', off: '不思考', default: '默认' })

const TURN_STATUS: Record<string, { label: string; tone: Tone }> = localized({
  completed: { label: '已完成', tone: 'muted' }, running: { label: '运行中', tone: 'accent' }, failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已停止', tone: 'warning' }, stopped: { label: '已停止', tone: 'warning' }, interrupted: { label: '已中断', tone: 'warning' }, paused: { label: '已暂停', tone: 'warning' },
})

function TurnHeader({ row, collapsed, onToggle, model }: { row: Extract<Row, { type: 'turn' }>; collapsed: boolean; onToggle: () => void; model: string }) {
  const status = TURN_STATUS[row.turn?.status ?? ''] ?? { label: row.turn?.status ?? '', tone: 'muted' as Tone }
  return (
    <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex h-10 w-full items-center gap-2 overflow-hidden whitespace-nowrap border-b border-line-faint bg-subtle/60 px-4 text-left text-[12.5px] transition-colors hover:bg-hover">
      <ChevronRight className={cn('size-3.5 shrink-0 text-fg-3 transition-transform', !collapsed && 'rotate-90')} />
      <strong className="shrink-0 font-semibold text-fg">{tr('第 {index} 轮', { index: row.index })}</strong>
      {status.label && <Badge tone={status.tone}>{status.label}</Badge>}
      <span className="shrink-0 text-fg-3">{tr('{count} 条', { count: row.count })}</span>
      {row.ms !== null && <span className="shrink-0 tabular-nums text-fg-3">· {formatShortDuration(row.ms)}</span>}
      {row.input > 0 && <span className="hidden min-w-0 truncate tabular-nums text-fg-3 sm:inline">{tr('· 输入 {v} · 输出 {v2}', { v: formatTokens(row.input), v2: formatTokens(row.output) })}</span>}
      {row.turn?.timing && timingSummary(row.turn.timing) && <span className="hidden min-w-0 truncate tabular-nums text-fg-3 lg:inline" title={timingRows(row.turn.timing).map(([k, v]) => `${k} ${v}`).join(' · ')}>· {timingSummary(row.turn.timing)}</span>}
      <span className="flex-1" />
      {model && <span className="min-w-[4rem] truncate text-fg-3">{model}{row.turn?.modelConfig?.reasoningDecision ? ` · ${EFFORT[row.turn.modelConfig.reasoningDecision.effective] ?? row.turn.modelConfig.reasoningDecision.effective}` : ''}</span>}
    </button>
  )
}

const EntryRow = memo(function EntryRow({ entry, maxMs, durations, selected, onSelect }: { entry: Entry; maxMs: number; durations: boolean; selected: boolean; onSelect: () => void }) {
  const k = KIND[entry.kind]
  const pct = entry.ms && maxMs ? Math.max(2, Math.round((entry.ms / maxMs) * 100)) : 0
  return (
    <button type="button" onClick={onSelect} aria-current={selected || undefined}
      className={cn('grid h-8 w-full grid-cols-[48px_minmax(0,1fr)_64px_44px] items-center gap-3 px-4 text-left text-[12.5px] transition-colors @[760px]:grid-cols-[56px_minmax(0,1fr)_60px_60px_52px_120px_48px]', selected ? 'bg-active' : 'hover:bg-hover')}>
      <span><Badge tone={entry.status === 'failed' ? 'danger' : k.tone} className="w-[40px] justify-center">{k.label}</Badge></span>
      <span className={cn('truncate', entry.status === 'failed' ? 'text-danger' : 'text-fg-2')}>{entry.text.replace(/\s+/g, ' ') || '—'}</span>
      <span className="hidden text-right tabular-nums text-fg-3 @[760px]:block">{entry.input ? formatTokens(entry.input) : ''}</span>
      <span className="hidden text-right tabular-nums text-fg-3 @[760px]:block">{entry.output ? formatTokens(entry.output) : ''}</span>
      <span className="hidden text-right tabular-nums text-fg-3 @[760px]:block">{entry.thinkMs ? formatShortDuration(entry.thinkMs) : ''}</span>
      <span className="flex min-w-0 items-center gap-2">
        {durations && pct > 0 && <span className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted @[760px]:block"><span className={cn('block h-full rounded-full', entry.status === 'failed' ? 'bg-danger' : entry.kind === 'tool' ? 'bg-warning/70' : 'bg-accent/70')} style={{ width: `${pct}%` }} /></span>}
        <span className="shrink-0 tabular-nums text-fg-3">{entry.status === 'running' ? tr('进行中') : entry.ms !== null ? formatShortDuration(entry.ms) : ''}</span>
      </span>
      <span className="text-right tabular-nums text-fg-3">{clockTime(entry.item.createdAt)}</span>
    </button>
  )
})

/* ------------------------------------------------------------------ detail */

type Tab = 'summary' | 'payload' | 'result' | 'thinking' | 'timing' | 'usage'

function EntryDetail({ item, turn, phase }: { item: Item; turn?: Turn; phase?: string }) {
  const entry = describe(item)
  const tabs: { id: Tab; label: string }[] = [{ id: 'summary', label: tr('概述') }]
  if (item.tool) tabs.push({ id: 'payload', label: tr('参数') }, { id: 'result', label: tr('结果') })
  if (item.thinking) tabs.push({ id: 'thinking', label: tr('思考') })
  tabs.push({ id: 'timing', label: tr('计时') })
  if (item.usage) tabs.push({ id: 'usage', label: tr('用量') })
  const [tab, setTab] = useState<Tab>('summary')
  const current = tabs.some(t => t.id === tab) ? tab : 'summary'
  const k = KIND[entry.kind]
  const shown = item.source === 'subagent' ? entry.text : item.text
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={entry.status === 'failed' ? 'danger' : k.tone}>{k.label}</Badge>
        <span className="text-[12.5px] text-fg-3">{new Date(item.createdAt).toLocaleString(intlTag(), { hour12: false })}</span>
        {turn?.status === 'running' && phase && <Badge tone="accent">{phaseLabel(phase)}</Badge>}
      </div>
      <SegmentedTabs layoutId="traj-tab" value={current} onChange={setTab} items={tabs} />
      {current === 'summary' && (
        item.tool ? (
          <DefinitionList rows={[[tr('操作'), VERBS[toolKind(item.tool)].done], [tr('对象'), toolTarget(item.tool) || '—'], [tr('状态'), entry.status === 'failed' ? tr('失败') : entry.status === 'running' ? tr('进行中') : entry.status === 'stopped' ? tr('已停止') : tr('已完成')], [tr('时长'), entry.ms !== null ? formatShortDuration(entry.ms) : tr('未记录')]]} />
        ) : item.kind === 'question' ? (
          <div className="space-y-2 text-[13.5px]">
            {(item.interaction?.questions ?? []).map(q => (
              <div key={q.id}><p className="font-medium text-fg">{q.question}</p><ul className="mt-1 list-disc pl-5 text-fg-2">{q.options.map(o => <li key={o.id}>{o.label}</li>)}</ul></div>
            ))}
            {item.interaction?.answers && <p className="text-fg-3">{tr('已回答：{v}', { v: item.interaction.answers.map(a => [...a.selected, a.custom].filter(Boolean).join(tr('、'))).join(tr('；')) })}</p>}
          </div>
        ) : item.subagent ? (
          <div className="space-y-2"><DefinitionList rows={[[tr('角色'), subagentRoleName(item.subagent)], [tr('状态'), subagentStatusLabel(item.subagent.status)], [tr('工具'), String(item.subagent.toolCount ?? 0)], [tr('任务'), item.subagent.task ?? '']]} />{item.subagent.summary && <Markdown text={item.subagent.summary} variant="compact" className="text-[13.5px]" />}</div>
        ) : shown ? <Markdown text={shown} className="text-[14px]" /> : <p className="text-[13px] text-fg-3">{tr('无内容')}</p>
      )}
      {current === 'payload' && <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-3 font-mono text-[12px] text-fg-2">{item.tool?.args ? JSON.stringify(item.tool.args, null, 2) : tr('未捕获参数')}</pre>}
      {current === 'result' && (item.tool?.output ? (
        <div className="overflow-hidden rounded-lg bg-inset"><TerminalOutput text={toolKind(item.tool) === 'command' ? parseCommandOutput(item.tool.output).output : item.tool.output} cap={40} capKey={`traj:${item.id}`} /></div>
      ) : <p className="text-[13px] text-fg-3">{tr('未捕获结果')}</p>)}
      {current === 'thinking' && (item.thinking?.text ? <Markdown text={item.thinking.text} variant="compact" className="text-[13.5px] text-fg-2" /> : <p className="text-[13px] text-fg-3">{tr('该模型不返回思考原文{v}。', { v: item.thinking?.tokens ? tr('（{tokens} tokens）', { tokens: item.thinking.tokens }) : '' })}</p>)}
      {current === 'timing' && <Timing item={item} />}
      {current === 'timing' && turn?.timing && timingRows(turn.timing).length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[12.5px] font-medium text-fg-3">{tr('本轮开轮耗时')}</h4>
          <DefinitionList rows={timingRows(turn.timing)} />
        </section>
      )}
      {current === 'usage' && item.usage && (
        <DefinitionList rows={[[tr('输入'), formatTokens(item.usage.input ?? 0)], [tr('缓存读取'), formatTokens(item.usage.cacheRead ?? 0)], [tr('缓存写入'), formatTokens(item.usage.cacheWrite ?? 0)], [tr('输出'), formatTokens(item.usage.output ?? 0)], ...(item.usage.cacheUsageReported === false ? [[tr('说明'), tr('未报告缓存用量')] as [string, string]] : [])]} />
      )}
    </div>
  )
}

function Timing({ item }: { item: Item }) {
  const start = item.tool?.startedAt ?? item.startedAt ?? item.createdAt
  const end = item.tool?.endedAt ?? item.endedAt
  const total = elapsed(start, end ?? null)
  const ttft = elapsed(item.startedAt, item.firstTokenAt ?? null)
  const think = item.thinking ? elapsed(item.thinking.startedAt, item.thinking.endedAt ?? null) : null
  const gen = item.firstTokenAt && item.endedAt ? elapsed(item.firstTokenAt, item.endedAt) : null
  const rate = gen && item.usage?.output ? `${Math.round(item.usage.output / (gen / 1000))} tok/s` : null
  const rows: [string, string][] = [[tr('开始时间'), start ? new Date(start).toLocaleTimeString(intlTag(), { hour12: false }) : tr('未记录')], [tr('总时长'), total !== null && end ? formatShortDuration(total) : end ? tr('未记录') : tr('进行中')]]
  if (ttft !== null && item.firstTokenAt) rows.push([tr('首 token 延迟'), formatShortDuration(ttft)])
  if (think !== null && item.thinking?.endedAt) rows.push([tr('思考'), formatShortDuration(think)])
  if (gen !== null) rows.push([tr('生成'), formatShortDuration(gen)])
  if (rate) rows.push([tr('吞吐量'), rate])
  rows.push([tr('计时来源'), end ? tr('会话时间戳') : tr('会话时间戳（运行中）')])
  return <DefinitionList rows={rows} />
}
