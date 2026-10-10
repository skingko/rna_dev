/**
 * The former dock panels as side-panel tab bodies: tool detail, 审查 (every
 * changed file of the session with ONE 预览 / 源码 / 差异 switch per file),
 * and a workspace file preview.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileText } from 'lucide-react'
import type { Item } from '@/api/types'
import { useApp, useItem } from '@/store/app-store'
import { basename, dirname, fileChange, mediaFiles, parseCommandOutput, toolKind, toolTarget, toolVerb } from '@/lib/tools'
import { computeDiff, patchLines, snippetDiff } from '@/lib/diff'
import { clockTime, elapsed, formatShortDuration } from '@/lib/format'
import { CodeBlock, Markdown } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { ToolIcon } from '@/components/timeline/tool-icons'
import { DiffStat, TerminalOutput } from '@/components/timeline/ToolViews'
import { DiffView } from '@/components/diff/DiffView'
import { diffLanguage } from '@/components/diff/language'
import { hasCounts, summarizeDeliverables } from '@/components/timeline/Deliverables'
import { FilePreview } from '@/components/preview/FilePreview'
import { WorkspaceImage } from '@/components/preview/WorkspaceMedia'
import { openFilePreview } from '@/components/preview/open'
import { toWorkspacePath } from '@/components/preview/registry'
import { resolveReviewMode, reviewModes, type ReviewMode } from '@/lib/review-modes'
import { changedFiles, useBackgroundChange } from '@/store/change-detail-store'
import { openTab } from '@/store/side-panel-store'
import { useReadSession, useSessionRoots } from '@/lib/session-root'
import { useHostTurnChanges } from '@/store/turn-changes-store'
import { useWholeHistory } from '@/store/use-whole-history'
import { MAX_APPLY_PATCH_PATHS, worktreeApi, type HostTurnChanges, type TurnChangeFile, type TurnPatch } from '@/api/worktree-api'
import type { GitDiff } from '@/api/git-api'
import { Skeleton } from '@/components/ui/primitives'
import { t as tr } from '@/i18n'

export function PanelHeader({ title, subtitle, icon, trailing }: { title: string; subtitle?: string; icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-faint pl-4 pr-2">
      {icon && <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-subtle text-fg-3 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-fg">{title}</div>
        {subtitle && <div className="truncate text-[11.5px] text-fg-4">{subtitle}</div>}
      </div>
      {trailing}
    </div>
  )
}

/* ---------------------------------------------------------- tool detail */

const HIDDEN_ARGS = new Set(['expectedHash', 'timeoutMs', 'cwd'])

export function ToolDetail({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  const projectId = useApp(s => s.sessionIndex[sessionId]?.projectId ?? null)
  // A worktree conversation's images are in its own copy.
  const reader = useReadSession(projectId, sessionId)
  if (!item?.tool) return <PanelHeader title={tr('工具详情')} />
  const tool = item.tool
  const kind = toolKind(tool)
  const ms = elapsed(tool.startedAt, tool.endedAt)
  const args = Object.fromEntries(Object.entries(tool.args ?? {}).filter(([k]) => !HIDDEN_ARGS.has(k)))
  const command = kind === 'command' || (kind === 'search' && typeof tool.args?.command === 'string')
  const parsed = command ? parseCommandOutput(tool.output) : null
  const change = fileChange(item)
  const images = mediaFiles(tool).filter(file => file.mimeType.startsWith('image/'))
  return (
    <>
      <PanelHeader title={toolVerb(tool)} subtitle={toolTarget(tool)} icon={<ToolIcon kind={kind} />}
        trailing={kind === 'browser' ? <button type="button" onClick={() => openTab({ type: 'agent-browser', sessionId })} className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg">{tr('实时画面')}</button> : undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <dl className="grid grid-cols-[72px_1fr] gap-y-1.5 py-3 text-[12.5px]">
          <dt className="text-fg-4">{tr('状态')}</dt><dd className="text-fg-2">{statusText(item)}</dd>
          {tool.startedAt && <><dt className="text-fg-4">{tr('开始')}</dt><dd className="tabular-nums text-fg-2">{clockTime(tool.startedAt)}</dd></>}
          {ms !== null && tool.endedAt && <><dt className="text-fg-4">{tr('耗时')}</dt><dd className="tabular-nums text-fg-2">{formatShortDuration(ms)}</dd></>}
          {parsed?.exitCode !== null && parsed?.exitCode !== undefined && <><dt className="text-fg-4">{tr('退出码')}</dt><dd className={cn('tabular-nums', parsed.exitCode === 0 ? 'text-fg-2' : 'text-danger')}>{parsed.exitCode}</dd></>}
        </dl>
        {change?.replaced ? (
          // An overwrite without its earlier text: what was written, not a diff of every line as added.
          <Section title={tr('改动')}>
            <ReplacedNote />
            <CodeBlock code={change.newText} lang={/\.([a-z0-9]+)$/i.exec(change.path)?.[1] ?? ''} header={false} />
          </Section>
        ) : change ? (
          <Section title={tr('改动')}>
            <div className="overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
              <DiffView lines={snippetDiff(change.oldText, change.newText).lines} lineNumbers="new" language={diffLanguage(change.path)} />
            </div>
          </Section>
        ) : Object.keys(args).length > 0 && (
          <Section title={tr('参数')}>
            {command && typeof args.command === 'string'
              ? <CodeBlock code={args.command} lang="bash" header={false} />
              : <CodeBlock code={JSON.stringify(args, null, 2)} lang="json" header={false} />}
          </Section>
        )}
        {projectId && images.length > 0 && (
          <Section title={tr('生成的图片')}>
            <div className="space-y-2">
              {images.map(file => <WorkspaceImage key={file.path} projectId={projectId} path={file.path} alt={basename(file.path)} sessionId={reader} className="max-h-[420px] w-auto max-w-full rounded-xl shadow-[0_0_0_1px_var(--line-faint)]" onOpen={() => openFilePreview(projectId, file.path, undefined, sessionId)} />)}
            </div>
          </Section>
        )}
        {tool.output && !change && (
          <Section title={tr('结果')}>
            {parsed ? (
              <div className="overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]"><TerminalOutput text={parsed.output || tr('没有输出')} cap={400} capKey={`dockcap:${item.id}`} /></div>
            ) : looksLikeJson(tool.output) ? (
              <CodeBlock code={prettyJson(tool.output)} lang="json" header={false} />
            ) : (
              <div className="rounded-xl bg-inset p-3 shadow-[inset_0_0_0_1px_var(--line-faint)]"><Markdown text={tool.output.slice(0, 20000)} variant="compact" /></div>
            )}
          </Section>
        )}
      </div>
    </>
  )
}

function statusText(item: Item) {
  const s = item.tool?.status
  return s === 'succeeded' ? tr('已完成') : s === 'failed' ? tr('失败') : s === 'cancelled' || s === 'interrupted' ? tr('已停止') : s === 'uncertain' ? tr('未确认') : tr('进行中')
}
function ReplacedNote() {
  return <p className="mb-2 text-[12.5px] leading-[1.6] text-fg-4">{tr('覆盖了整个文件，之前的内容没有记录，所以没有差异可看。')}</p>
}
function looksLikeJson(text: string) { const t = text.trim(); return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')) }
function prettyJson(text: string) { try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text } }

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      <h3 className="mb-2 text-[12px] font-medium text-fg-4">{title}</h3>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------ file tab */

/**
 * A workspace file in the unified preview (deliverables, presented files, Markdown links). `sessionId`: the file is
 * read from that worktree conversation's own copy, which the subtitle says.
 */
export function FileTab({ projectId, path, sessionId = null }: { projectId: string; path: string; sessionId?: string | null }) {
  const folder = dirname(path) || tr('项目根目录')
  return (
    <>
      <PanelHeader title={basename(path)} subtitle={sessionId ? tr('{folder} · 这个对话的工作树', { folder }) : folder} icon={<FileText />} />
      <FilePreview projectId={projectId} path={path} showTitle={false} sessionId={sessionId} />
    </>
  )
}

/* ---------------------------------------------------------------- 审查 */

const EMPTY: Item[] = []

/** Tool items of the session (all of them when `itemIds` is null: the session-wide review). */
function useReviewItems(sessionId: string, itemIds: string[] | null | undefined): Item[] {
  // The session-wide review covers older turns than the timeline's window too: they are paged in (B9).
  useWholeHistory(sessionId, !itemIds)
  return useApp(useShallow(s => {
    const slice = s.sessions[sessionId]
    if (!slice) return EMPTY
    const ids = itemIds ?? slice.order
    return ids.map(id => slice.items[id]).filter((i): i is Item => Boolean(i?.tool))
  }))
}

/**
 * 审阅 / 审查. With `turnId` and a host answer for that turn (GET …/turns/:turnId/changes), the files and patches are
 * what reached the project folder (HostReview); otherwise — and for the session-wide 审查 — the turn's edit and write
 * calls, one diff per call (ToolReview). `focus`: a tool call to open on; `focusPath`: a file (project path).
 */
export function Review({ sessionId, itemIds, focus, turnId = null, focusPath = null }: { sessionId: string; itemIds?: string[] | null; focus?: string | null; turnId?: string | null; focusPath?: string | null }) {
  const host = useHostTurnChanges(sessionId, turnId)
  // A file the host vouches for but cannot diff (ignored or too big, or also written elsewhere meanwhile) opens on the
  // turn's own calls to it.
  const vouched = Boolean(focusPath && host.changes && !host.changes.files.some(f => f.path === focusPath) && [...(host.changes.uncovered ?? []), ...(host.changes.shared ?? []).map(row => row.path)].includes(focusPath))
  if (turnId && host.changes && !vouched) return <HostReview sessionId={sessionId} turnId={turnId} changes={host.changes} itemIds={itemIds} focus={focus ?? null} focusPath={focusPath} />
  return <ToolReview sessionId={sessionId} itemIds={itemIds} focus={focus} focusPath={focusPath} />
}

function ToolReview({ sessionId, itemIds, focus, focusPath = null }: { sessionId: string; itemIds?: string[] | null; focus?: string | null; focusPath?: string | null }) {
  const items = useReviewItems(sessionId, itemIds)
  const projectId = useApp(s => s.sessions[sessionId]?.meta?.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  // A worktree conversation's files are in its own copy first (worktree design §9).
  const roots = useSessionRoots(sessionId)
  const reader = useReadSession(projectId, sessionId)
  const files = useMemo(() => summarizeDeliverables(items).changed, [items])
  const [active, setActive] = useState<string | null>(null)
  // A new focus (another 审阅 click reusing this tab) wins over the last manual pick.
  useEffect(() => { setActive(null) }, [focus, focusPath, itemIds])
  /** Per-file explicit choice; the default comes from `reviewModes`. */
  const [choices, setChoices] = useState<Record<string, ReviewMode>>({})
  const current = files.find(f => f.path === active) ?? files.find(f => focus && f.itemIds.includes(focus)) ?? files.find(f => focusPath && (toWorkspacePath(f.path, roots) ?? f.path) === focusPath) ?? files[0]
  const previewPath = current && projectId ? toWorkspacePath(current.path, roots) : null
  // One entry per write or edit of the file; an overwrite without its earlier text (`null`) has no diff to show.
  const diffs = useMemo(() => (current ? current.itemIds.flatMap(id => {
    const item = items.find(i => i.id === id)
    const change = item ? fileChange(item) : null
    return change ? [change.replaced ? null : snippetDiff(change.oldText, change.newText)] : []
  }) : []), [current, items])
  // Only overwritten: 差异 is not offered, and a rendered document opens on its preview as a new one does.
  const available = reviewModes({ path: previewPath, hasChange: diffs.some(Boolean), created: current?.created || current?.replaced })
  const mode = resolveReviewMode(current ? choices[current.path] : undefined, available)
  const setMode = (next: ReviewMode) => { if (current) setChoices(m => ({ ...m, [current.path]: next })) }
  const known = files.filter(hasCounts)
  const added = known.reduce((n, f) => n + f.added, 0)
  const removed = known.reduce((n, f) => n + f.removed, 0)
  return (
    <>
      <PanelHeader title={itemIds ? tr('审阅改动') : tr('审查')} subtitle={known.length ? tr('{length} 个文件 · +{added} −{removed}', { length: files.length, added, removed }) : tr('{length} 个文件', { length: files.length })} />
      {files.length > 1 && (
        <div role="tablist" aria-label={tr('改动文件')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-faint px-3 py-2 [scrollbar-width:none]">
          {files.map(f => (
            <button key={f.path} type="button" role="tab" aria-selected={f === current} onClick={() => setActive(f.path)} title={f.path}
              className={cn('inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors', f === current ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2')}>
              {basename(f.path)}<DiffStat added={f.added} removed={f.removed} replaced={f.replaced && !f.created} />
            </button>
          ))}
        </div>
      )}
      {current && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint px-4 text-[12.5px]">
          <span className="shrink-0 font-medium text-fg">{basename(current.path)}</span>
          <span className="min-w-0 truncate text-fg-4" title={current.path}>{dirname(previewPath ?? current.path)}</span>
          <span className="flex-1" />
          <DiffStat added={current.added} removed={current.removed} created={current.created} replaced={current.replaced} />
          {available.modes.length > 1 && <ReviewModeSwitch modes={available.modes} value={mode} onChange={setMode} />}
        </div>
      )}
      {current && mode !== 'diff' && previewPath && projectId ? (
        <FilePreview key={`${projectId}:${previewPath}`} projectId={projectId} path={previewPath} showTitle={false} view={mode} sessionId={reader} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current && (
            <div className="px-4 py-3">
              {diffs.map((d, i) => (d ? (
                <div key={i} className="mb-3 overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
                  <DiffView lines={d.lines} lineNumbers="new" language={diffLanguage(current.path)} />
                </div>
              ) : <ReplacedNote key={i} />))}
            </div>
          )}
          {!files.length && <p className="p-6 text-center text-[13px] text-fg-4">{tr('没有可审阅的改动')}</p>}
        </div>
      )}
    </>
  )
}

/**
 * A turn's files as the host computed them: each file's net change (first before → last after across the turn's
 * records, or its checkpoint), its patch read when opened (the first batch with the first file, as 应用记录 does).
 * A file someone else changed between the turn's records shows one diff per record.
 */
function HostReview({ sessionId, turnId, changes, itemIds, focus, focusPath }: { sessionId: string; turnId: string; changes: HostTurnChanges; itemIds?: string[] | null; focus: string | null; focusPath: string | null }) {
  const projectId = useApp(s => s.sessions[sessionId]?.meta?.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  const roots = useSessionRoots(sessionId)
  const reader = useReadSession(projectId, sessionId)
  const items = useReviewItems(sessionId, itemIds)
  const files = changes.files
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => { setActive(null) }, [focus, focusPath, itemIds, turnId])
  const [choices, setChoices] = useState<Record<string, ReviewMode>>({})
  // A tool call to open on (a produced card, an older tab) names its file by the path the tool got.
  const focused = useMemo(() => {
    if (focusPath) return focusPath
    const item = focus ? items.find(i => i.id === focus) : undefined
    const change = item ? fileChange(item) : null
    return change?.path ? toWorkspacePath(change.path, roots) ?? change.path : null
  }, [focus, focusPath, items, roots])
  const current = files.find(f => f.path === active) ?? files.find(f => f.path === focused) ?? files[0]
  const { patches, retry } = useTurnPatches(projectId, sessionId, turnId, changes, current?.path ?? null)
  const patch = current ? patches[current.path] : undefined
  const deleted = current?.status === 'D'
  const available = reviewModes({ path: current && !deleted ? current.path : null, hasChange: true, created: current?.status === 'A' })
  const mode = resolveReviewMode(current ? choices[current.path] : undefined, available)
  const counted = files.filter(f => f.added !== null && !f.binary)
  const added = counted.reduce((n, f) => n + (f.added ?? 0), 0), removed = counted.reduce((n, f) => n + (f.removed ?? 0), 0)
  const stat = (f: TurnChangeFile) => (f.binary || f.added === null ? <span className="shrink-0 text-[11.5px] text-fg-4">{tr('二进制')}</span> : <DiffStat added={f.added} removed={f.removed ?? 0} created={f.status === 'A'} />)
  const note = !current ? null
    : current.rolledBack ? tr('这个文件之后回退了：这里是这一轮当时的改动。')
      : current.changedBetween ? tr('这一轮的几次写入之间，这个文件还被别处改过：下面是每次写入各自的改动。')
        : current.unattributed ? tr('这一轮运行期间这个文件变了，但这一轮没有哪次调用指名写过它：可能是它执行的命令或其他工具改的，也可能是你或别的对话改的。')
          : null
  const listed = new Set(files.map(f => f.path))
  const shared = [...new Set((changes.shared ?? []).map(row => row.path))].filter(path => !listed.has(path))
  return (
    <>
      <PanelHeader title={tr('审阅改动')} subtitle={counted.length ? tr('{length} 个文件 · +{added} −{removed}', { length: files.length, added, removed }) : tr('{length} 个文件', { length: files.length })} />
      {files.length > 1 && (
        <div role="tablist" aria-label={tr('改动文件')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-faint px-3 py-2 [scrollbar-width:none]">
          {files.map(f => (
            <button key={f.path} type="button" role="tab" aria-selected={f === current} onClick={() => { setActive(f.path); retry() }} title={f.path} data-review-file={f.path}
              className={cn('inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors', f === current ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2', f.rolledBack && 'opacity-60')}>
              {basename(f.path)}{stat(f)}
            </button>
          ))}
        </div>
      )}
      {current && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint px-4 text-[12.5px]">
          <span className="shrink-0 font-medium text-fg">{basename(current.path)}</span>
          <span className="min-w-0 truncate text-fg-4" title={current.path}>{dirname(current.path)}</span>
          <span className="flex-1" />
          {current.rolledBack && <span className="shrink-0 text-[11.5px] text-fg-4">{tr('已回退')}</span>}
          {stat(current)}
          {available.modes.length > 1 && <ReviewModeSwitch modes={available.modes} value={mode} onChange={next => setChoices(m => ({ ...m, [current.path]: next }))} />}
        </div>
      )}
      {note && mode === 'diff' && <p className="shrink-0 border-b border-line-faint px-4 py-2 text-[12.5px] text-fg-4" data-review-note>{note}</p>}
      {(changes.uncovered?.length ?? 0) > 0 && <p className="shrink-0 border-b border-line-faint px-4 py-2 text-[12.5px] text-fg-4" title={changes.uncovered!.join('\n')}>{tr('另有 {n} 个文件被忽略或太大，不在检查点里，这里看不到它们的改动。', { n: changes.uncovered!.length })}</p>}
      {shared.length > 0 && <p className="shrink-0 border-b border-line-faint px-4 py-2 text-[12.5px] text-fg-4" title={shared.join('\n')} data-review-shared>{tr('另有 {n} 个文件这一轮运行期间也被别处写过，这里看不到这一轮对它们的改动。', { n: shared.length })}</p>}
      {current && mode !== 'diff' && !deleted && projectId ? (
        <FilePreview key={`${projectId}:${current.path}`} projectId={projectId} path={current.path} showTitle={false} view={mode} sessionId={reader} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" data-host-review>
          {current && (
            <div className="px-4 py-3">
              {!patch ? <div className="p-2" aria-hidden><Skeleton className="h-4 w-2/3" /></div>
                : 'error' in patch ? <p className="text-[12.5px] text-fg-4">{patch.error}</p>
                  : patch.sections ? patch.sections.map((section, i) => (
                    <div key={section.applyId} className="mb-3" data-review-section={section.applyId}>
                      <div className="mb-1.5 text-[12px] text-fg-4">{tr('第 {n} 次写入', { n: i + 1 })}{section.rolledBack ? ` · ${tr('已回退')}` : ''}</div>
                      <PatchBox diff={section.diff} path={current.path} />
                    </div>
                  ))
                    : patch.diff ? <PatchBox diff={patch.diff} path={current.path} /> : null}
            </div>
          )}
          {!files.length && <p className="p-6 text-center text-[13px] text-fg-4">{tr('没有可审阅的改动')}</p>}
        </div>
      )}
    </>
  )
}

/**
 * A turn's file patches, read lazily: the first {@link MAX_APPLY_PATCH_PATHS} files in one request when one of them is
 * opened. A read that failed is not kept: choosing a file again (`retry`, or another file) reads the failed ones again.
 */
function useTurnPatches(projectId: string | null, sessionId: string, turnId: string, changes: HostTurnChanges, path: string | null): { patches: Record<string, TurnPatch | { error: string }>; retry: () => void } {
  const [state, setState] = useState<{ changes: HostTurnChanges; patches: Record<string, TurnPatch | { error: string }> }>({ changes, patches: {} })
  // Another answer (a rollback since, a newer version) has other patches.
  const patches = state.changes === changes ? state.patches : {}
  const first = useMemo(() => changes.files.slice(0, MAX_APPLY_PATCH_PATHS).map(file => file.path), [changes])
  const retry = useCallback(() => setState(current => {
    if (current.changes !== changes || !Object.values(current.patches).some(row => 'error' in row)) return current
    return { changes, patches: Object.fromEntries(Object.entries(current.patches).filter(([, row]) => !('error' in row))) }
  }), [changes])
  // Another file chosen: what failed before is read again with it.
  useEffect(() => { if (path) retry() }, [path, retry])
  const wanted = Boolean(projectId && path && !patches[path])
  useEffect(() => {
    if (!wanted || !projectId || !path) return
    let live = true
    const batch = first.includes(path) ? first.filter(p => !patches[p]) : [path]
    const add = (rows: [string, TurnPatch | { error: string }][]) => setState(current => ({ changes, patches: { ...(current.changes === changes ? current.patches : {}), ...Object.fromEntries(rows) } }))
    worktreeApi.turnPatches(projectId, turnId, batch, { sessionId }).then(
      ({ patches: rows }) => { if (live) add(rows.map(row => [row.path, row])) },
      (error: Error) => { if (live) add(batch.map(p => [p, { error: error.message }])) },
    )
    return () => { live = false }
  }, [wanted, projectId, sessionId, turnId, path, first, changes]) // eslint-disable-line react-hooks/exhaustive-deps
  return { patches, retry }
}

/** One GitDiff as the panel shows it (as 应用记录 does): the patch's hunks, or why there is none. */
function PatchBox({ diff, path }: { diff: GitDiff; path: string }) {
  const lines = (diff.kind === 'patch' || diff.kind === 'truncated') && diff.patch ? patchLines(diff.patch).lines : null
  return (
    <div className="overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]">
      {lines ? <DiffView lines={diff.kind === 'truncated' ? [...lines, { type: 'gap', text: tr('文件较长，差异只显示前一部分。') }] : lines} lineNumbers="new" language={diffLanguage(path)} />
        : <p className="px-3 py-2 text-[12px] text-fg-4">{diff.kind === 'binary' ? tr('二进制文件，不显示差异。') : diff.kind === 'patch' ? tr('内容没有变化，只改了文件属性。') : diff.message ?? tr('这个文件的差异暂时读不到。')}</p>}
    </div>
  )
}

/* ------------------------------------------------------ 后台改动 (plan §4.4) */

/** One background change set, file by file: what the work did (its own before / after), with 预览 / 源码 / 差异. */
export function ChangeReview({ projectId, changeId, focus }: { projectId: string; changeId: string; focus?: string | null }) {
  const status = useApp(s => s.projects[projectId]?.backgroundChanges?.find(row => row.id === changeId)?.status ?? '')
  const entry = useBackgroundChange(projectId, changeId, status)
  const detail = entry?.detail
  const files = useMemo(() => changedFiles(detail), [detail])
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => { setActive(null) }, [focus])
  const [choices, setChoices] = useState<Record<string, ReviewMode>>({})
  const current = files.find(f => f.path === active) ?? files.find(f => f.path === focus) ?? files[0]
  const raw = detail?.files.find(f => f.path === current?.path)
  const reviewable = Boolean(current?.available && !current.binary)
  const available = reviewModes({ path: current && !current.deleted ? current.path : null, hasChange: reviewable, created: current?.created })
  const mode = resolveReviewMode(current ? choices[current.path] : undefined, available)
  const diff = useMemo(() => (raw && reviewable ? computeDiff(raw.before ?? '', raw.after ?? '') : null), [raw, reviewable])
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0)
  const note = !current ? null
    : !current.available ? tr('这组改动已回退或快照已过期，只能看到文件列表。')
      : current.binary ? tr('二进制文件，不显示差异。')
        : current.changedSince && mode !== 'diff' ? tr('这个文件之后又改过：预览显示的是现在的内容，差异显示的是这次后台工作做的改动。')
          : current.truncated ? tr('文件较长，差异只显示前一部分。') : null
  return (
    <>
      <PanelHeader title={tr('后台改动')} subtitle={entry?.status === 'loading' && !detail ? tr('正在读取…') : tr('{length} 个文件 · +{added} −{removed}', { length: files.length, added, removed })} />
      {files.length > 1 && (
        <div role="tablist" aria-label={tr('改动文件')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-faint px-3 py-2 [scrollbar-width:none]">
          {files.map(f => (
            <button key={f.path} type="button" role="tab" aria-selected={f === current} onClick={() => setActive(f.path)} title={f.path}
              className={cn('inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors', f === current ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2')}>
              {basename(f.path)}<DiffStat added={f.added} removed={f.removed} />
            </button>
          ))}
        </div>
      )}
      {current && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint px-4 text-[12.5px]">
          <span className="shrink-0 font-medium text-fg">{basename(current.path)}</span>
          <span className="min-w-0 truncate text-fg-4" title={current.path}>{dirname(current.path)}</span>
          <span className="flex-1" />
          <DiffStat added={current.added} removed={current.removed} created={current.created} />
          {available.modes.length > 1 && <ReviewModeSwitch modes={available.modes} value={mode} onChange={next => setChoices(m => ({ ...m, [current.path]: next }))} />}
        </div>
      )}
      {note && <p className="shrink-0 border-b border-line-faint px-4 py-2 text-[12.5px] text-fg-4">{note}</p>}
      {current && mode !== 'diff' && !current.deleted ? (
        <FilePreview key={`${projectId}:${current.path}`} projectId={projectId} path={current.path} showTitle={false} view={mode} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {diff && (
            <div className="px-4 py-3">
              <div className="overflow-hidden rounded-xl bg-inset shadow-[inset_0_0_0_1px_var(--line-faint)]"><DiffView lines={diff.lines} lineNumbers="new" language={diffLanguage(current?.path)} /></div>
            </div>
          )}
          {entry?.status === 'error' && <p className="p-6 text-center text-[13px] text-fg-4">{entry.error}</p>}
          {detail && !files.length && <p className="p-6 text-center text-[13px] text-fg-4">{tr('没有可审阅的改动')}</p>}
        </div>
      )}
    </>
  )
}

const MODE_LABEL: Record<ReviewMode, () => string> = { preview: () => tr('预览'), source: () => tr('源码'), diff: () => tr('差异') }

/** The one per-file switch: 预览 / 源码 / 差异 (only the modes this file supports). */
export function ReviewModeSwitch({ modes, value, onChange }: { modes: ReviewMode[]; value: ReviewMode; onChange: (v: ReviewMode) => void }) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = modes[(modes.indexOf(value) + (e.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length]
    onChange(next)
    ;(e.currentTarget.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus()
  }
  return (
    <div role="radiogroup" aria-label={tr('审阅方式')} onKeyDown={onKey} className="inline-flex h-7 shrink-0 items-center rounded-md bg-subtle p-0.5" data-review-modes={modes.join(',')}>
      {modes.map(id => (
        <button key={id} type="button" role="radio" data-mode={id} aria-checked={value === id} tabIndex={value === id ? 0 : -1} onClick={() => onChange(id)}
          className={cn('h-6 rounded-[5px] px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', value === id ? 'bg-elevated font-medium text-fg shadow-xs' : 'text-fg-3 hover:text-fg-2')}>
          {MODE_LABEL[id]()}
        </button>
      ))}
    </div>
  )
}
