/**
 * "本轮交付": changed-file summary plus produced-file / preview cards. The files and their counts come from the host
 * when it can say what reached the project folder (`GET …/turns/:turnId/changes`: a worktree turn's apply records,
 * a direct-mode turn's checkpoint, worker merges included); otherwise they are derived from the turn's edit/write
 * tool calls (nothing shows during the moment the host's answer is read). Media and preview cards always come from
 * the tool calls.
 */
import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUpRight, FileCode2, FileText, Film, Globe, Image as ImageIcon, MonitorPlay, Music } from 'lucide-react'
import type { Item, PresentedFile } from '@/api/types'
import { useApp } from '@/store/app-store'
import { openDock } from '@/store/ui-store'
import { openFilePreview, openProjectPreview } from '@/components/preview/open'
import { toWorkspacePath } from '@/components/preview/registry'
import { WorkspaceImage } from '@/components/preview/WorkspaceMedia'
import { openBrowserTab } from '@/components/side-panel/open'
import { useReadSession, useSessionRoots } from '@/lib/session-root'
import { cn } from '@/lib/utils'
import { snippetDiff } from '@/lib/diff'
import { basename, dirname, fileChange, mayChangeFiles, mediaFiles, toolKind, toolUnfinished } from '@/lib/tools'
import type { HostTurnChanges } from '@/api/worktree-api'
import { useHostTurnChanges } from '@/store/turn-changes-store'
import SpotlightCard from '@/components/reactbits/SpotlightCard'
import { LiveCount } from '@/components/ui/LiveCount'
import { DiffStat } from './ToolViews'
import { t } from '@/i18n'

/**
 * `replaced`: a write overwrote the file without its earlier text on record, so its counts are unknown (shown 已覆盖).
 * Host rows (`host`): `binary` has no line counts, `rolledBack` was restored by a rollback since, `deleted` is gone,
 * `unattributed` only changed while the turn ran (no call or record of it wrote the file by name). Rows the host
 * vouches for but cannot diff keep the tool calls' counts: `uncovered` (ignored or too big for the checkpoint),
 * `shared` (another owner also wrote it while the turn ran); `uncounted`: no tool call of the turn gives counts.
 */
export interface Changed { path: string; added: number; removed: number; created: boolean; replaced: boolean; itemIds: string[]; host?: boolean; binary?: boolean; rolledBack?: boolean; deleted?: boolean; unattributed?: boolean; uncovered?: boolean; shared?: boolean; uncounted?: boolean }
/** `itemId`: the tool call that made it (absent for a file only the host knows of, e.g. a worker's merge). */
interface Produced { key: string; title: string; subtitle: string; kind: 'doc' | 'code' | 'preview' | 'media'; href?: string; itemId?: string; mimeType?: string }

const DOC_EXT = /\.(md|mdx|txt|pdf|docx?|html?)$/i

/** A changed file whose line counts are known: not overwritten without its earlier text (or made in this run), not binary. */
export const hasCounts = (row: Changed) => (!row.replaced || row.created) && !row.binary && !row.uncounted

export function summarizeDeliverables(items: Item[]): { changed: Changed[]; produced: Produced[] } {
  const byPath = new Map<string, Changed>()
  const produced: Produced[] = []
  for (const item of items) {
    const tool = item.tool
    // A failed, stopped or interrupted step delivered nothing.
    if (!tool || toolUnfinished(tool)) continue
    const change = fileChange(item)
    if (change && change.path) {
      const row = byPath.get(change.path) ?? { path: change.path, added: 0, removed: 0, created: false, replaced: false, itemIds: [] }
      if (!change.replaced) {
        // An edit's snippets, not whole files: a snippet's last line without its newline is not a changed line.
        const diff = snippetDiff(change.oldText, change.newText)
        row.added += diff.added
        row.removed += diff.removed
      }
      row.created ||= change.created
      row.replaced ||= change.replaced
      row.itemIds.push(item.id)
      byPath.set(change.path, row)
      if (change.created && !produced.some(p => p.key === change.path)) {
        produced.push({ key: change.path, title: basename(change.path), subtitle: dirname(change.path) || t('项目根目录'), kind: DOC_EXT.test(change.path) ? 'doc' : 'code', itemId: item.id })
      }
      continue
    }
    // Generated images, audio and video are deliverables in their own right.
    for (const file of mediaFiles(tool)) if (!produced.some(p => p.key === file.path)) produced.push({ key: file.path, title: basename(file.path), subtitle: dirname(file.path) || t('项目根目录'), kind: 'media', mimeType: file.mimeType, itemId: item.id })
    if (toolKind(tool) === 'preview') {
      const url = previewUrl(tool.output)
      if (url && !produced.some(p => p.key === url)) produced.push({ key: url, title: t('项目预览'), subtitle: url.replace(/^https?:\/\//, '').replace(/\/[0-9a-f]{32,}/, ''), kind: 'preview', href: url, itemId: item.id })
    }
  }
  return { changed: [...byPath.values()], produced }
}

/**
 * 本轮交付 from the host's answer: its files with their real counts (tool calls that touched a file keep their ids,
 * so 审阅 can still fall back to them); created files that still stand become produced cards; media and previews stay
 * as the tool calls give them, and a file made in a folder no snapshot holds (`uncovered`) keeps its card too. Files
 * the host vouches for but cannot diff — edited ones no snapshot holds (`uncovered`), ones another owner also wrote
 * while the turn ran (`shared`) — stay listed with the tool calls' counts. Files that only changed while the turn ran
 * (`unattributed`) come last, marked. `local`: a tool path as a project path (tools may report absolute paths).
 */
export function hostDeliverables(host: HostTurnChanges, tools: { changed: Changed[]; produced: Produced[] }, local: (path: string) => string): { changed: Changed[]; produced: Produced[] } {
  const byPath = new Map<string, Changed>()
  for (const row of tools.changed) {
    const path = local(row.path), seen = byPath.get(path)
    byPath.set(path, seen
      ? { ...seen, added: seen.added + row.added, removed: seen.removed + row.removed, created: seen.created || row.created, replaced: seen.replaced || row.replaced, itemIds: [...seen.itemIds, ...row.itemIds] }
      : { ...row, path, itemIds: [...row.itemIds] })
  }
  const ids = (path: string) => byPath.get(path)?.itemIds ?? []
  const hostRow = (file: HostTurnChanges['files'][number]): Changed => ({
    path: file.path, added: file.added ?? 0, removed: file.removed ?? 0, created: file.status === 'A', replaced: false, itemIds: ids(file.path),
    host: true, ...(file.binary || file.added === null ? { binary: true } : {}), ...(file.rolledBack ? { rolledBack: true } : {}), ...(file.status === 'D' ? { deleted: true } : {}), ...(file.unattributed ? { unattributed: true } : {}),
  })
  const listed = new Set(host.files.map(file => file.path))
  // Vouched for, not in the diff: the tool calls' row (or, with none, the bare file).
  const vouched = (path: string, mark: 'uncovered' | 'shared'): Changed => {
    listed.add(path)
    const tool = byPath.get(path)
    return tool ? { ...tool, [mark]: true } : { path, added: 0, removed: 0, created: false, replaced: false, itemIds: [], [mark]: true, uncounted: true }
  }
  const uncoveredPaths = (host.uncovered ?? []).filter(path => !listed.has(path) && byPath.has(path))
  const uncoveredRows = uncoveredPaths.map(path => vouched(path, 'uncovered'))
  const sharedRows = (host.shared ?? []).map(row => row.path).filter((path, index, all) => !listed.has(path) && all.indexOf(path) === index).map(path => vouched(path, 'shared'))
  const changed = [...host.files.filter(file => !file.unattributed).map(hostRow), ...uncoveredRows, ...sharedRows, ...host.files.filter(file => file.unattributed).map(hostRow)]
  const uncovered = new Set(host.uncovered ?? [])
  const made = host.files.filter(file => file.status === 'A' && !file.rolledBack && !file.unattributed).map((file): Produced => ({ key: file.path, title: basename(file.path), subtitle: dirname(file.path) || t('项目根目录'), kind: DOC_EXT.test(file.path) ? 'doc' : 'code', itemId: ids(file.path)[0] }))
  const kept = tools.produced.filter(p => p.kind === 'media' || p.kind === 'preview' || uncovered.has(local(p.key)))
  return { changed, produced: [...made, ...kept.filter(p => !made.some(m => m.key === local(p.key)))] }
}

/** Why a row is marked: what the mark says, and its explanation (on hover). */
function rowMark(row: Changed): { label: string; title: string } | null {
  if (row.unattributed) return { label: t('来源不确定'), title: t('这一轮运行期间这个文件变了，但这一轮没有哪次调用指名写过它：可能是它执行的命令或其他工具改的，也可能是你或别的对话改的。') }
  if (row.shared) return { label: t('也被别处改过'), title: t('这一轮运行期间，这个文件还被别处写过（另一个对话、后台改动或你的操作），这一轮的改动没法从文件里单独算出来。') }
  if (row.uncovered) return { label: t('不在检查点里'), title: t('这个文件被忽略或太大，不在检查点里：数字来自这一轮的修改调用，回退本轮也不会还原它。') }
  return null
}

function previewUrl(output?: string): string | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as { url?: string }
    if (parsed.url) return parsed.url
  } catch { /* not JSON */ }
  return /https?:\/\/127\.0\.0\.1:\d+\/\S*/.exec(output)?.[0] ?? null
}

export const Deliverables = memo(function Deliverables({ sessionId, itemIds, turnId = null }: { sessionId: string; itemIds: string[]; turnId?: string | null }) {
  const items = useApp(useShallow(s => itemIds.map(id => s.sessions[sessionId]?.items[id]).filter((i): i is Item => Boolean(i?.tool))))
  const projectId = useApp(s => s.sessions[sessionId]?.meta?.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  /** Tools may report absolute paths; show them relative to the conversation's root (a worktree conversation's copy first). */
  const roots = useSessionRoots(sessionId)
  const reader = useReadSession(projectId, sessionId)
  const shown = (path: string) => toWorkspacePath(path, roots) ?? path
  const tools = useMemo(() => summarizeDeliverables(items), [items])
  // What reached the project folder, as the host computed it; the tool calls when it cannot say. A turn none of whose
  // calls could change a file (and with no records of its own) asks nothing.
  const mayWrite = useMemo(() => items.some(item => mayChangeFiles(item.tool!)), [items])
  const host = useHostTurnChanges(sessionId, turnId, { mayWrite })
  const { changed, produced } = useMemo(() => (host.changes ? hostDeliverables(host.changes, tools, path => toWorkspacePath(path, roots) ?? path) : tools), [host.changes, tools, roots])
  // Asked and not answered yet (a local read, a moment): nothing rather than the tool calls' numbers changing under the reader.
  if (host.state === 'loading' || (!changed.length && !produced.length)) return null
  // The turn's own files; those that only changed while it ran are listed after them, not counted as its.
  const own = changed.filter(c => !c.unattributed)
  // Overwritten files have no counts to add up.
  const known = own.filter(hasCounts)
  const totalAdd = known.reduce((n, c) => n + c.added, 0)
  const totalDel = known.reduce((n, c) => n + c.removed, 0)
  // Every edit and write of the turn: 审阅 falls back to them, and maps a call to its file.
  const allIds = tools.changed.flatMap(c => c.itemIds)
  // The count animates, so the sentence is split around its `{count}` slot.
  const [before, after = ''] = (own.length ? t('修改了 {count} 个文件') : t('本轮运行期间有 {count} 个文件变了')).split('{count}')
  return (
    <section className="mt-4" aria-label={t('本轮交付')}>
      <div className="mb-2 text-[12px] font-medium text-fg-4">{t('本轮交付')}</div>
      {changed.length > 0 && (
        <div className="overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--line)]">
          <div className="flex h-10 items-center gap-2 border-b border-line-faint px-3 text-[13px]">
            <span className="text-fg-2">{before}<LiveCount value={own.length || changed.length} className="tabular-nums" />{after}</span>
            {known.length > 0 && (
              <span className="font-mono text-[12px] tabular-nums">
                <span className="text-[var(--diff-add-fg)]">+<LiveCount value={totalAdd} duration={0.7} /></span>
                <span className="ml-1 text-[var(--diff-del-fg)]">−<LiveCount value={totalDel} duration={0.7} /></span>
              </span>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => openDock({ kind: 'diff', sessionId, itemIds: allIds, turnId })} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">
              {t('审阅全部')}
            </button>
          </div>
          <ul className="py-1">
            {changed.map(c => {
              const mark = rowMark(c)
              return (
                <li key={c.path}>
                  <button
                    type="button"
                    onClick={() => openDock({ kind: 'diff', sessionId, itemIds: allIds, turnId, focus: c.itemIds[0], focusPath: shown(c.path) })}
                    className="flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors hover:bg-hover"
                    data-deliverable={c.path}
                  >
                    <FileCode2 className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.7} />
                    <span className={cn('min-w-0 flex-1 truncate', (c.rolledBack || c.unattributed) && 'opacity-60')}>
                      <span className={cn('text-fg', c.deleted && 'line-through decoration-fg-4')}>{basename(c.path)}</span>
                      {dirname(shown(c.path)) && <span className="ml-1.5 text-fg-4">{dirname(shown(c.path))}</span>}
                    </span>
                    {mark && <span className="shrink-0 text-[11.5px] text-fg-4" title={mark.title} data-deliverable-mark>{mark.label}</span>}
                    {c.rolledBack && <span className="shrink-0 text-[11.5px] text-fg-4">{t('已回退')}</span>}
                    {c.binary ? <span className="shrink-0 text-[11.5px] text-fg-4">{t('二进制')}</span> : c.uncounted ? null : <DiffStat added={c.added} removed={c.removed} created={c.created} replaced={c.replaced} />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {produced.length > 0 && (
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
          {produced.map(p => p.href
            // 项目预览 opens in the side panel's built-in browser, not an external window.
            ? <DeliverableCard key={p.key} kind={p.kind} title={p.title} subtitle={p.subtitle} detail={p.href}
                onOpen={() => { if (projectId) void openProjectPreview(projectId, p.href!); else openBrowserTab(p.href!) }} />
            : p.kind === 'media' && projectId
              ? <DeliverableCard key={p.key} kind="media" mimeType={p.mimeType} title={p.title} subtitle={dirname(shown(p.key)) || t('项目根目录')} detail={shown(p.key)} file={{ projectId, path: p.key, sessionId }} reader={reader} />
            : <DeliverableCard key={p.key} kind={p.kind === 'media' ? 'code' : p.kind} title={p.title} subtitle={dirname(shown(p.key)) || t('项目根目录')} detail={shown(p.key)}
                onOpen={() => {
                  // New code opens in 审阅 on its 差异 (what was written); new documents open rendered.
                  const diff = () => openDock({ kind: 'diff', sessionId, itemIds: allIds, turnId, focus: p.itemId, focusPath: shown(p.key) })
                  if (p.kind === 'doc' && projectId) openFilePreview(projectId, p.key, diff, sessionId); else diff()
                }} />)}
        </div>
      )}
    </section>
  )
})

/**
 * One produced / presented file card (本轮交付 and proactive-message deliverables).
 * Pass `file` to open it in the dock's unified preview; `onOpen` overrides that.
 */
export function DeliverableCard({ kind, title, subtitle, href, onOpen, detail, file, mimeType, reader = null }: { kind: 'doc' | 'code' | 'preview' | 'media'; title: string; subtitle: string; href?: string; onOpen?: () => void; detail?: string; file?: { projectId: string; path: string; sessionId?: string | null }; mimeType?: string; reader?: string | null }) {
  const open = onOpen ?? (file ? () => { openFilePreview(file.projectId, file.path, undefined, file.sessionId) } : undefined)
  const Icon = kind === 'preview' ? MonitorPlay : kind === 'doc' ? FileText : kind === 'media' ? (mimeType?.startsWith('audio/') ? Music : mimeType?.startsWith('video/') ? Film : ImageIcon) : FileCode2
  // A generated image shows itself instead of an icon.
  const thumb = kind === 'media' && file && mimeType?.startsWith('image/')
  const body = (
    <div className="flex items-center gap-3 p-3">
      {thumb
        ? <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-subtle [&_img]:size-full [&_img]:object-cover [&>span]:m-0 [&>span]:h-full"><WorkspaceImage projectId={file.projectId} path={file.path} alt={title} sessionId={reader} /></span>
        : <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-softer text-accent-text"><Icon className="size-[18px]" strokeWidth={1.6} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{title}</span>
        <span className="block truncate text-[12px] text-fg-4" title={detail}>{kind === 'preview' ? <><Globe className="mr-1 inline size-3 align-[-1px]" />{subtitle}</> : subtitle}</span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-fg-4 transition-transform duration-200 group-hover/spot:-translate-y-0.5 group-hover/spot:translate-x-0.5" />
    </div>
  )
  return href
    ? <SpotlightCard as="a" href={href} target="_blank" className="block">{body}</SpotlightCard>
    : <SpotlightCard as="button" className="block w-full text-left" onClick={open}>{body}</SpotlightCard>
}

/**
 * K2 v2: files the agent declared with `project_present` ({path, name,
 * description}), shown under a proactive message / welcome-back topic / inbox
 * entry. Opening shows the file in the right dock's unified preview.
 */
export function PresentedFiles({ projectId, files, className }: { projectId: string | null; files: PresentedFile[] | undefined; className?: string }) {
  const rows = (files ?? []).filter(f => f && typeof f.path === 'string' && f.path)
  if (!rows.length) return null
  return (
    <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2', className)} role="list" aria-label={t('交付文件')} data-presented-files>
      {rows.map(file => (
        <div key={file.path} role="listitem">
          <DeliverableCard kind={DOC_EXT.test(file.path) ? 'doc' : 'code'} title={file.name || basename(file.path)} subtitle={file.description || dirname(file.path) || t('项目根目录')} detail={file.path}
            file={projectId ? { projectId, path: file.path } : undefined} />
        </div>
      ))}
    </div>
  )
}
