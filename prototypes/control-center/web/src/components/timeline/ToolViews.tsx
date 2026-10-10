/**
 * Tool presentation in the process flow: single-line rows, grouped runs,
 * the command terminal block and the inline diff card.
 */
import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, ChevronRight, CircleHelp, CircleSlash, Loader2, PanelRightOpen } from 'lucide-react'
import type { Item } from '@/api/types'
import { useApp, useItem } from '@/store/app-store'
import { openDock, toggleDisclosure, useUi } from '@/store/ui-store'
import { basename, dirname, fileChange, groupTitle, parseCommandOutput, preparingVerb, toolFailed, toolKind, toolRunning, toolStopped, toolTarget, toolUncertain, toolVerb, webToolNotice, type ViewKind } from '@/lib/tools'
import { elapsed, formatShortDuration } from '@/lib/format'
import { snippetDiff } from '@/lib/diff'
import { DiffView as DiffBody } from '@/components/diff/DiffView'
import { diffLanguage } from '@/components/diff/language'
import { parseAnsi } from '@/lib/ansi'
import { useNow } from '@/hooks/useNow'
import { skillDisplayName, useSkillCatalog } from '@/lib/skills'
import { DisclosureRow } from '@/components/ui/primitives'
import { CopyButton } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { ToolIcon } from './tool-icons'
import { t as tr } from '@/i18n'

const reveal = {
  initial: { opacity: 0, y: -2 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
}

/* --------------------------------------------------------------- meta */

function ToolMeta({ item }: { item: Item }) {
  const tool = item.tool!
  const running = toolRunning(tool)
  const now = useNow(running && Boolean(tool.startedAt))
  if (toolFailed(tool)) return <span className="inline-flex items-center gap-1 text-danger"><AlertCircle className="size-3.5" />{tr('失败')}</span>
  if (toolStopped(tool)) return <span className="inline-flex items-center gap-1 text-warning"><CircleSlash className="size-3.5" />{tr('已停止')}</span>
  if (toolUncertain(tool)) return <span className="inline-flex items-center gap-1 text-warning" title={tr('没能确认这一步是否生效，请核对结果')}><CircleHelp className="size-3.5" />{tr('未确认')}</span>
  if (running) {
    const ms = elapsed(tool.startedAt, null, now)
    return <span className="inline-flex items-center gap-1.5">{ms !== null && ms > 1500 ? formatShortDuration(ms) : null}<Loader2 className="size-3.5 spin text-fg-4" /></span>
  }
  const ms = elapsed(tool.startedAt, tool.endedAt)
  return ms !== null && tool.endedAt ? <span>{formatShortDuration(ms)}</span> : null
}

/* ---------------------------------------------------------------- row */

const morph = { type: 'spring', stiffness: 520, damping: 44, mass: 0.7 } as const

export const ToolRow = memo(function ToolRow({ sessionId, itemId, nested = false }: { sessionId: string; itemId: string; nested?: boolean }) {
  const item = useItem(sessionId, itemId)
  if (!item?.tool) return null
  const tool = item.tool
  const kind = toolKind(tool)
  // The pending entry and the executed item share a layoutId, so the row
  // glides into place (and its verb crossfades) instead of popping.
  const layoutId = tool.preparing ? `prep:${item.id}` : item.preparedFrom ? `prep:${item.preparedFrom}` : undefined
  const body = tool.preparing ? <PreparingToolRow item={item} kind={kind} nested={nested} />
    : kind === 'command' ? <CommandBlock sessionId={sessionId} item={item} />
      : kind === 'edit' || kind === 'write' ? <DiffCard sessionId={sessionId} item={item} />
        : <PlainToolRow sessionId={sessionId} item={item} kind={kind} nested={nested} />
  return (
    <motion.div layoutId={layoutId} layout={layoutId ? 'position' : undefined} transition={morph} initial={tool.preparing ? reveal.initial : false} animate={reveal.animate}>
      {body}
    </motion.div>
  )
})

/** Harness-style preparing row: "准备读取 src/app.ts…" while arguments stream. */
function PreparingToolRow({ item, kind, nested }: { item: Item; kind: ViewKind; nested: boolean }) {
  const tool = item.tool!
  const target = toolTarget(tool)
  const verb = preparingVerb(tool, target)
  return (
    <DisclosureRow
      icon={<ToolIcon kind={kind} />}
      title={<span className="text-shimmer" data-preparing="">{target ? verb : `${verb}…`}</span>}
      summary={target ? <span className={cn(kind === 'command' && 'font-mono text-[12.5px]')}><TargetText kind={kind} target={target} />…</span> : undefined}
      className={cn(nested && 'pl-6')}
    />
  )
}

/** Skill calls resolve a human name through the project's capability catalog. */
function useTarget(sessionId: string, item: Item | undefined): string {
  const projectId = useApp(s => (item?.tool && toolKind(item.tool) === 'skill' ? s.sessions[sessionId]?.meta.projectId : null))
  const catalog = useSkillCatalog(projectId)
  if (!item?.tool) return ''
  const tool = item.tool
  if (toolKind(tool) !== 'skill') return toolTarget(tool)
  const id = typeof tool.args?.id === 'string' ? tool.args.id : typeof tool.args?.name === 'string' ? tool.args.name : ''
  return id ? skillDisplayName(id, catalog, tool.output) : toolTarget(tool)
}

function PlainToolRow({ sessionId, item, kind, nested }: { sessionId: string; item: Item; kind: ViewKind; nested: boolean }) {
  const tool = item.tool!
  const itemId = item.id
  const running = toolRunning(tool)
  const target = useTarget(sessionId, item)
  const notice = webToolNotice(tool)
  return (
    <DisclosureRow
      icon={<ToolIcon kind={kind} />}
      title={<span className={cn(running && 'text-shimmer')}>{toolVerb(tool)}</span>}
      summary={target || notice ? <>{target && <TargetText kind={kind} target={target} />}{notice && <span className="ml-1.5 text-warning" title={notice}>· {notice}</span>}</> : undefined}
      meta={<ToolMeta item={item} />}
      onClick={() => openDock({ kind: 'tool', sessionId, itemId })}
      className={cn(nested && 'pl-6', toolFailed(tool) && 'text-danger/80')}
    />
  )
}

function TargetText({ kind, target }: { kind: ViewKind; target: string }) {
  if (kind === 'read' || kind === 'list') {
    const dir = dirname(target)
    return (
      <span className="font-normal">
        <span className="text-fg-2 transition-colors group-hover/row:text-fg">{basename(target)}</span>
        {dir && <span className="ml-1.5 text-fg-4">{dir}</span>}
      </span>
    )
  }
  if (kind === 'search' || kind === 'web_search') return <span>“{target}”</span>
  return <span>{target}</span>
}

/* -------------------------------------------------------------- group */

export const ToolGroup = memo(function ToolGroup({ sessionId, itemIds, kind }: { sessionId: string; itemIds: string[]; kind: ViewKind }) {
  const key = `group:${itemIds[0]}`
  const open = useUi(s => s.disclosure[key] ?? false)
  const lastId = itemIds[itemIds.length - 1]
  const last = useItem(sessionId, lastId)
  const first = useItem(sessionId, itemIds[0])
  const second = useItem(sessionId, itemIds[1])
  // Status of every member (a short string each), so a failure anywhere in the run surfaces.
  const statuses = useApp(useShallow(s => itemIds.map(id => s.sessions[sessionId]?.items[id]?.tool?.status ?? '')))
  const failed = statuses.filter(status => status === 'failed' || status === 'error').length
  const running = Boolean(last?.tool && toolRunning(last.tool))
  const firstName = useTarget(sessionId, first)
  const secondName = useTarget(sessionId, second)
  const names = [firstName, secondName].filter(Boolean).map(t => (kind === 'read' || kind === 'list' ? basename(t) : t))
  const summary = `${names.join(tr('、'))}${itemIds.length > 2 ? tr(' 等') : ''}`
  return (
    <div>
      <DisclosureRow
        icon={failed ? <AlertCircle className="text-danger" /> : <ToolIcon kind={kind} />}
        title={
          <span className={cn(running && 'text-shimmer')}>
            {groupTitle(kind, itemIds.length, running)}
            {failed > 0 && <span className="text-danger"> · {tr('{failed} 次失败', { failed })}</span>}
          </span>
        }
        summary={summary}
        expandable
        open={open}
        onToggle={() => toggleDisclosure(key)}
        meta={running && last ? <ToolMeta item={last} /> : undefined}
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...reveal} className="relative ml-2 border-l border-line pl-2">
            {itemIds.map(id => <ToolRow key={id} sessionId={sessionId} itemId={id} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

/* ------------------------------------------------------ command block */

const CAP = 12

export const CommandBlock = memo(function CommandBlock({ sessionId, item }: { sessionId: string; item: Item }) {
  const tool = item.tool!
  const running = toolRunning(tool)
  const { output, exitCode } = useMemo(() => parseCommandOutput(tool.output), [tool.output])
  const failed = toolFailed(tool) || (exitCode !== null && exitCode !== 0)
  const key = `cmd:${item.id}`
  // Live and failed commands show output; settled successful ones fold to a row.
  const open = useUi(s => s.disclosure[key] ?? (running || failed))
  const command = toolTarget(tool)
  const verb = toolVerb(tool)
  const empty = !output.trim()
  return (
    <div className="my-0.5">
      <DisclosureRow
        icon={<ToolIcon kind="command" />}
        title={<span className={cn(running && 'text-shimmer')}>{verb}</span>}
        summary={<span className="font-mono text-[12.5px]">{command}</span>}
        expandable
        open={open}
        onToggle={() => toggleDisclosure(key, running || failed)}
        meta={<ToolMeta item={item} />}
      />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...reveal} className="mb-2 ml-6 mt-1 overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
            <div className="flex h-9 items-center gap-2.5 border-b border-line-faint pl-3 pr-1.5">
              <span className={cn('size-1.5 shrink-0 rounded-full', running ? 'bg-accent pulse-dot' : failed ? 'bg-danger' : 'bg-success')} />
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg"><span className="select-none text-fg-4">$ </span>{command}</code>
              {!running && exitCode !== null && (
                <span className={cn('shrink-0 text-[12px] tabular-nums', failed ? 'text-danger' : 'text-fg-4')}>{tr('退出码 {exitCode}', { exitCode })}</span>
              )}
              <CopyButton text={command} label="" className="px-1" />
              <button type="button" onClick={() => openDock({ kind: 'tool', sessionId, itemId: item.id })} className="grid size-6 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg" aria-label={tr('在侧栏查看')}><PanelRightOpen className="size-3.5" /></button>
            </div>
            {empty ? (
              <div className="px-3 py-2.5 font-mono text-[12.5px] text-fg-4">{running ? tr('等待输出…') : tr('没有输出')}</div>
            ) : (
              <TerminalOutput text={output} cap={CAP} capKey={`cap:${item.id}`} follow={running} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export function TerminalOutput({ text, cap, capKey, follow }: { text: string; cap: number; capKey: string; follow?: boolean }) {
  const expanded = useUi(s => s.disclosure[capKey] ?? false)
  const lines = useMemo(() => text.split('\n'), [text])
  const hidden = lines.length - cap
  const capped = hidden > 0 && !expanded
  // While a command streams, show the latest lines (tail) — that is where the news is.
  const head = capped ? (follow ? [] : lines.slice(0, Math.ceil(cap / 2))) : lines
  const tail = capped ? lines.slice(follow ? -cap : -(cap - Math.ceil(cap / 2))) : []
  return (
    <div className="max-h-[420px] overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.65] text-fg">
      {head.map((line, i) => <AnsiLine key={`h${i}`} line={line} />)}
      {capped && (
        <button type="button" onClick={() => toggleDisclosure(capKey)} className="my-0.5 block text-left text-fg-4 transition-colors hover:text-fg-2">
          {follow ? tr('… 前面 {v} 行', { v: lines.length - cap }) : tr('… 其余 {v} 行', { v: lines.length - cap })}
        </button>
      )}
      {tail.map((line, i) => <AnsiLine key={`t${i}`} line={line} />)}
      {expanded && hidden > 0 && (
        <button type="button" onClick={() => toggleDisclosure(capKey)} className="mt-1 block text-fg-4 hover:text-fg-2">{tr('收起')}</button>
      )}
    </div>
  )
}

const AnsiLine = memo(function AnsiLine({ line }: { line: string }) {
  const spans = useMemo(() => parseAnsi(line), [line])
  return (
    <div className="min-h-[1lh] whitespace-pre">
      {spans.map((s, i) => (
        <span key={i} style={s.fg ? { color: s.fg } : undefined} className={cn(s.bold && 'font-semibold', s.dim && 'opacity-60', s.italic && 'italic', s.underline && 'underline')}>{s.text}</span>
      ))}
    </div>
  )
})

/* ----------------------------------------------------------- diff card */

export const DiffCard = memo(function DiffCard({ sessionId, item }: { sessionId: string; item: Item }) {
  const tool = item.tool!
  const running = toolRunning(tool)
  const change = fileChange(item)
  const kind = toolKind(tool)
  // An overwrite without its earlier text has no diff: everything would read as added.
  const replaced = Boolean(change?.replaced)
  const stopped = toolStopped(tool), uncertain = toolUncertain(tool)
  const diff = useMemo(() => (change && !running && !replaced ? snippetDiff(change.oldText, change.newText) : null), [change?.oldText, change?.newText, running, replaced]) // eslint-disable-line react-hooks/exhaustive-deps
  const key = `diff:${item.id}`
  const open = useUi(s => s.disclosure[key] ?? false)
  const path = change?.path || toolTarget(tool) || tool.argsPreview || ''
  const verb = toolVerb(tool)
  return (
    <div className="my-1 overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--line)] transition-shadow duration-200 hover:shadow-[inset_0_0_0_1px_var(--line-strong)]">
      <div
        role="button"
        tabIndex={0}
        onClick={() => diff && toggleDisclosure(key)}
        onKeyDown={e => { if (e.key === 'Enter' && diff) toggleDisclosure(key) }}
        className="group/row flex h-9 cursor-pointer items-center gap-2 pl-2.5 pr-1.5 text-[13px]"
      >
        <span className="grid size-4 place-items-center text-fg-3 [&_svg]:size-[14px]">
          {diff ? <ChevronRight className={cn('transition-transform duration-200', open && 'rotate-90')} /> : <ToolIcon kind={kind} />}
        </span>
        <span className={cn('shrink-0 text-fg-2', running && 'text-shimmer')}>{verb}</span>
        <span className="min-w-0 truncate">
          <span className="font-medium text-fg">{basename(path)}</span>
          {dirname(path) && <span className="ml-1.5 text-fg-4">{dirname(path)}</span>}
        </span>
        {/* A stopped write did not land, an unconfirmed one may not have: no counts, it says which. */}
        {stopped ? <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-warning"><CircleSlash className="size-3.5" />{tr('已停止')}</span>
          : uncertain ? <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-warning" title={tr('没能确认这一步是否生效，请核对结果')}><CircleHelp className="size-3.5" />{tr('未确认')}</span>
          : diff ? <DiffStat added={diff.added} removed={diff.removed} created={change?.created} />
            : replaced && !running && <DiffStat added={0} removed={0} replaced />}
        <span className="flex-1" />
        {/* Nothing of a stopped write is in the review (it delivered nothing); its attempted text still unfolds here. */}
        {running ? <Loader2 className="mr-1.5 size-3.5 spin text-fg-4" /> : !stopped && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); openDock({ kind: 'diff', sessionId, itemIds: [item.id], focus: item.id }) }}
            className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-fg-3 opacity-80 transition-[opacity,background-color,color] hover:bg-hover hover:text-fg group-hover/row:opacity-100"
          >
            {tr('审阅')}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && diff && (
          <motion.div {...reveal} className="border-t border-line-faint bg-inset">
            <DiffBody lines={diff.lines} maxLines={14} capKey={`diffcap:${item.id}`} language={diffLanguage(path)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

/** `replaced` (and not `created`): the file was overwritten without its earlier text on record, so it says 已覆盖 and gives no counts. */
export function DiffStat({ added, removed, created, replaced }: { added: number; removed: number; created?: boolean; replaced?: boolean }) {
  if (replaced && !created) return <span className="shrink-0 rounded bg-subtle px-1 py-px text-[11px] text-fg-3">{tr('已覆盖')}</span>
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
      {created && <span className="mr-1.5 rounded bg-success-soft px-1 py-px font-sans text-[11px] text-success">{tr('新建')}</span>}
      <span className="text-[var(--diff-add-fg)]">+{added}</span>
      {removed > 0 && <span className="ml-1 text-[var(--diff-del-fg)]">−{removed}</span>}
    </span>
  )
}

