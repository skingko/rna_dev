/**
 * 项目记忆 browser. Port of the legacy settings "浏览与搜索" tab: recent files
 * (with memory/resource filter and inventory counts), directory browsing with
 * L0/L1 summaries, L2 reading with the assistant-report projection, full
 * project search, pagination, stale-response guards and retry paths.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ChevronLeft, ChevronRight, Clock3, FileText, Folder, FolderTree, RefreshCw, Search, Settings2, X } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { MemoryEntry, MemoryFilter } from '@/api/panels-types'
import { ApiError } from '@/api/transport'
import { Markdown } from '@/components/markdown/Markdown'
import { Button, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Badge, Disclosure, Empty, Note, formatDateTime } from '@/components/settings/form'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { openSettings, usePanels } from '@/components/settings/panel-store'
import { useConfiguration, reloadConfiguration } from '@/components/settings/config-store'
import { ProjectPicker, useActiveProjects, useProjectDetail } from '@/components/projects/ProjectPicker'
import { useApp } from '@/store/app-store'
import {
  MEMORY_LEVEL_NAMES, memoryCollectionDisplay, memoryDisplayTitle, memoryEntryKind, memoryError, memoryPageDisplay, memoryReadableDocument, relativeMemoryPath, summaryStatusMessage,
  type MemoryPage, type ReadableDocument,
} from './memory-display'
import { MemorySyncPanel } from './MemorySyncPanel'
import { t } from '@/i18n'

export function MemoryBrowserDialog() {
  const state = usePanels(s => s.memory)
  const selected = useApp(s => s.selectedProjectId)
  const projects = useActiveProjects()
  const [projectId, setProjectId] = useState<string | null>(null)
  useEffect(() => {
    if (!state) return
    setProjectId(state.projectId ?? selected ?? projects[0]?.id ?? null)
    if (!useConfiguration.getState().value) void reloadConfiguration()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PanelDialog open={state !== null} onClose={() => usePanels.setState({ memory: null })} title={t('项目记忆')} description={t('浏览当前项目保存的资料、约定与重要上下文。记忆按项目隔离。')} size="xl">
      <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
        <ProjectPicker value={projectId} onChange={setProjectId} />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" leading={<Settings2 className="size-3.5" />} onClick={() => { usePanels.setState({ memory: null }); openSettings('memory') }}>{t('记忆偏好')}</Button>
      </div>
      <div className="min-h-0 flex-1 border-t border-line-faint">
        {projectId ? <MemoryLibrary key={projectId} projectId={projectId} /> : <div className="p-6"><Empty>{t('先选择或创建一个项目，再查看项目记忆。')}</Empty></div>}
      </div>
    </PanelDialog>
  )
}

type View = 'recent' | 'directory'
interface Reader { level: 'L0' | 'L1' | 'L2'; state: 'loading' | 'ready' | 'empty' | 'error' | 'unavailable'; doc?: ReadableDocument; message?: string }

export function MemoryLibrary({ projectId }: { projectId: string }) {
  const project = useProjectDetail(projectId)
  const limit = useConfiguration(s => s.value?.memory?.limit ?? 10)
  const namespace = project?.memory?.namespace ?? `viking://resources/projects/${projectId}`
  const [view, setView] = useState<View>('recent')
  const [filter, setFilter] = useState<MemoryFilter>('all')
  const [uri, setUri] = useState(namespace)
  const [page, setPage] = useState<MemoryPage | null>(null)
  const [responseUri, setResponseUri] = useState(namespace)
  const [responseNamespace, setResponseNamespace] = useState(namespace)
  const [inventory, setInventory] = useState<ReturnType<typeof memoryCollectionDisplay>>(null)
  const [counts, setCounts] = useState<{ memory?: number; resource?: number } | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'default' | 'success' | 'danger' }>({ text: t('正在加载项目记忆…'), tone: 'default' })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null)
  const [readers, setReaders] = useState<Record<string, Reader>>({})
  const [updated, setUpdated] = useState(false)
  const generation = useRef(0)
  const readTickets = useRef<Record<string, number>>({})
  const lastArgs = useRef<{ uri: string; offset: number; view: View }>({ uri: namespace, offset: 0, view: 'recent' })

  const browse = useCallback(async (target = namespace, offset = 0, nextView: View = 'directory', refresh = false, nextFilter = filter) => {
    lastArgs.current = { uri: target, offset, view: nextView }
    const ticket = ++generation.current
    setView(nextView); setUri(target); setSearchResults(null); setBusy(true); setFailed(false); setReaders({})
    setStatus({ text: t('正在加载项目记忆…'), tone: 'default' })
    try {
      const response = await panelsApi.memoryBrowse(projectId, { uri: target, offset, limit: 20, ...(nextView === 'recent' ? { view: 'recent' as const, refresh, filter: nextFilter } : {}) })
      if (ticket !== generation.current) return
      const next = memoryPageDisplay(response, offset)
      const collection = memoryCollectionDisplay(response)
      setInventory(collection)
      if (collection && response.collection) setCounts({ memory: response.collection.memoryFiles, resource: response.collection.resourceFiles })
      setResponseUri(response.uri ?? target)
      setResponseNamespace(response.namespace ?? namespace)
      setPage(next)
      setStatus({ text: next.label, tone: 'success' })
      if (offset === 0) setUpdated(false)
    } catch (error) {
      if (ticket !== generation.current) return
      setFailed(true); setPage(null)
      setStatus({ text: memoryError(error), tone: 'danger' })
    } finally {
      if (ticket === generation.current) setBusy(false)
    }
  }, [projectId, namespace, filter])

  const search = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = query.trim()
    if (!text) return
    const ticket = ++generation.current
    setBusy(true); setFailed(false); setReaders({}); setInventory(null)
    setStatus({ text: t('正在搜索全部记忆与项目资料…'), tone: 'default' })
    try {
      const response = await panelsApi.memorySearch(projectId, text, limit)
      if (ticket !== generation.current) return
      if (response.backend !== 'openviking' && response.backend !== 'embedded') throw new Error('Unexpected memory backend')
      setSearchResults(response.entries ?? [])
      setStatus({ text: t('全项目搜索 · 找到 {v} 项相关内容', { v: response.entries?.length ?? 0 }), tone: 'success' })
    } catch (error) {
      if (ticket !== generation.current) return
      setFailed(true); setSearchResults([])
      setStatus({ text: memoryError(error), tone: 'danger' })
    } finally { if (ticket === generation.current) setBusy(false) }
  }

  const read = async (entry: MemoryEntry, level: Reader['level'], force = false) => {
    const target = entry.expandUri ?? entry.uri
    const key = entry.uri
    if (!force && readers[key]?.level === level) { setReaders(r => { const n = { ...r }; delete n[key]; return n }); return }
    const ticket = (readTickets.current[key] ?? 0) + 1
    readTickets.current[key] = ticket
    setReaders(r => ({ ...r, [key]: { level, state: 'loading' } }))
    try {
      const response = await panelsApi.memoryRead(projectId, target, level)
      if (readTickets.current[key] !== ticket) return
      const doc = level === 'L2' ? memoryReadableDocument(response.content, entry) : { text: response.content ?? '', raw: response.content ?? '', kind: 'document' as const }
      setReaders(r => ({ ...r, [key]: { level: (response.level as Reader['level']) ?? level, state: response.content ? 'ready' : 'empty', doc } }))
    } catch (error) {
      if (readTickets.current[key] !== ticket) return
      const unavailable = level !== 'L2' && error instanceof ApiError && error.code === 'MEMORY_LAYER_UNAVAILABLE'
      setReaders(r => ({ ...r, [key]: { level, state: unavailable ? 'unavailable' : 'error', message: unavailable ? t('{v}尚未生成，可浏览目录查看原文。', { v: MEMORY_LEVEL_NAMES[level] }) : memoryError(error) } }))
    }
  }

  useEffect(() => { void browse(namespace, 0, 'recent') }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Memory summary completion is the index-visible signal that content changed.
  const revision = `${project?.memorySummary?.status ?? ''}:${(project?.memorySummary as { updatedAt?: string } | null | undefined)?.updatedAt ?? ''}`
  const firstRevision = useRef(revision)
  useEffect(() => { if (revision !== firstRevision.current) { firstRevision.current = revision; setUpdated(true) } }, [revision])

  const summary = summaryStatusMessage(project?.memorySummary)
  const location = view === 'recent' ? t('文件 · 按更新时间排序') : relativeMemoryPath(responseUri, namespace)
  const parent = responseUri === responseNamespace ? namespace : responseUri.slice(0, responseUri.lastIndexOf('/'))
  const retry = () => (searchResults ? void search() : void browse(lastArgs.current.uri, lastArgs.current.offset, lastArgs.current.view))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 px-6 pt-4">
        <form onSubmit={search} className="flex items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-base px-3 shadow-[inset_0_0_0_1px_var(--line-strong)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]">
            <Search className="size-3.5 shrink-0 text-fg-4" />
            <input value={query} onChange={e => setQuery(e.target.value)} type="search" required maxLength={1000} placeholder={t('搜索记忆与项目资料')} aria-label={t('搜索项目记忆')} className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label={t('清空')} className="text-fg-4 hover:text-fg"><X className="size-3.5" /></button>}
          </label>
          <Button type="submit" variant="secondary" className="h-9" disabled={busy || !query.trim()}>{t('搜索')}</Button>
          {searchResults && <Button variant="ghost" className="h-9" leading={<ArrowLeft className="size-3.5" />} onClick={() => void browse(lastArgs.current.uri, lastArgs.current.offset, lastArgs.current.view)}>{t('返回浏览')}</Button>}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg bg-subtle p-0.5">
            <ViewButton active={!searchResults && view === 'recent'} icon={<Clock3 className="size-3.5" />} disabled={busy} onClick={() => void browse(namespace, 0, 'recent')}>{t('最近更新')}</ViewButton>
            <ViewButton active={!searchResults && view === 'directory'} icon={<FolderTree className="size-3.5" />} disabled={busy} onClick={() => void browse(namespace, 0, 'directory')}>{t('按目录查看')}</ViewButton>
          </div>
          {!searchResults && view === 'recent' && (
            <div className="flex items-center gap-1" role="group" aria-label={t('内容类型')}>
              {([['all', t('全部')], ['memory', t('记忆')], ['resource', t('项目资料')]] as const).map(([value, label]) => {
                const count = value === 'memory' ? counts?.memory : value === 'resource' ? counts?.resource : counts ? (counts.memory ?? 0) + (counts.resource ?? 0) : undefined
                return (
                  <button key={value} type="button" disabled={busy} aria-pressed={filter === value} onClick={() => { setFilter(value); void browse(namespace, 0, 'recent', false, value) }}
                    className={cn('h-7 rounded-full px-2.5 text-[12px] transition-colors', filter === value ? 'bg-accent-soft font-medium text-accent-text' : 'text-fg-3 hover:bg-hover hover:text-fg')}>
                    {label}{Number.isSafeInteger(count) ? <span className="ml-1 tabular-nums opacity-70">{inventory?.partial ? '≥' : ''}{count}</span> : null}
                  </button>
                )
              })}
            </div>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" disabled={busy} leading={<RefreshCw className={cn('size-3.5', busy && 'spin')} />} onClick={() => (searchResults ? void search() : void browse(lastArgs.current.uri, 0, lastArgs.current.view, true))}>{t('刷新')}</Button>
        </div>
        {summary && <Note>{summary}</Note>}
        {!searchResults && <MemorySyncPanel projectId={projectId} revision={revision} />}
        {updated && !searchResults && (
          <Note action={<button type="button" className="shrink-0 text-[12px] font-medium text-accent-text hover:underline" onClick={() => void browse(lastArgs.current.uri, 0, lastArgs.current.view, true)}>{t('查看更新')}</button>}>{t('记忆有更新。查看最新内容不会修改已保存的信息。')}</Note>
        )}
        {inventory && !searchResults && (
          <Disclosure summary={inventory.partial ? t('部分内容未能读取 · 查看原因') : t('统计与同步说明')} meta={inventory.title} defaultOpen={inventory.partial}>
            <p className="text-[12.5px] leading-[1.6] text-fg-3">{inventory.title}</p>
            <p className="text-[12.5px] leading-[1.6] text-fg-3">{inventory.detail}</p>
            {inventory.checkedAt && <p className="text-[12px] text-fg-4">{t('统计于 {v}', { v: formatDateTime(inventory.checkedAt) })}</p>}
          </Disclosure>
        )}
        <div className="flex items-center gap-2 pb-2 text-[12px]" role="status" aria-live="polite">
          <span className={cn('min-w-0 flex-1 truncate', status.tone === 'danger' ? 'text-danger' : 'text-fg-4')}>{status.text}</span>
          {!searchResults && view === 'directory' && responseUri !== namespace && !busy && (
            <span className="flex shrink-0 items-center gap-1">
              <button type="button" className="text-accent-text hover:underline" onClick={() => void browse(namespace)}>{t('全部记忆')}</button>
              <span className="text-fg-4">·</span>
              <button type="button" className="text-accent-text hover:underline" onClick={() => void browse(parent)}>{t('上一级')}</button>
            </span>
          )}
        </div>
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 pb-6" aria-busy={busy}>
        {failed ? (
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="secondary" onClick={retry}>{t('重试')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { usePanels.setState({ memory: null }); openSettings('memory') }}>{t('检查连接设置')}</Button>
          </div>
        ) : busy && !page && !searchResults ? (
          <div className="space-y-2 pt-1">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
        ) : searchResults ? (
          searchResults.length ? (
            <div className="space-y-2">
              {searchResults.map(entry => <SearchCard key={entry.uri} entry={entry} reader={readers[entry.uri]} onRead={read} onBrowse={u => void browse(u)} namespace={namespace} />)}
            </div>
          ) : <Empty>{t('没有找到匹配的记忆。试试其他关键词，或浏览已保存的内容。')}</Empty>
        ) : page ? (
          <>
            <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-fg-4">{view === 'recent' ? <Clock3 className="size-3" /> : <Folder className="size-3" />}{location}</p>
            <div className={cn('space-y-1.5 transition-opacity', busy && 'opacity-60')}>
              {page.entries.map(entry => (
                <DirectoryRow key={entry.uri} entry={entry} reader={readers[entry.uri]} onRead={read} onOpen={u => void browse(u)} namespace={namespace} onBrowse={u => void browse(u)} />
              ))}
            </div>
            {!page.entries.length && (
              <Empty>{filter === 'memory' && view === 'recent' ? t('尚未发现提取后的记忆。助手报告可在“项目资料”中查看；保存报告不一定产生新的长期记忆。') : filter === 'resource' && view === 'recent' ? t('这里还没有可浏览的项目资料。') : t('这里还没有保存的内容；之后保存的项目资料和记忆会显示在这里。')}</Empty>
            )}
            {(page.previousOffset !== null || page.nextOffset !== null) && (
              <nav className="mt-4 flex items-center justify-center gap-3 text-[12px] text-fg-3" aria-label={t('记忆目录分页')}>
                <Button size="sm" variant="secondary" disabled={busy || page.previousOffset === null} leading={<ChevronLeft className="size-3.5" />} onClick={() => void browse(uri, page.previousOffset!, view)}>{t('上一页')}</Button>
                <span className="tabular-nums">{page.label.split(' · ')[0]}</span>
                <Button size="sm" variant="secondary" disabled={busy || page.nextOffset === null} onClick={() => void browse(uri, page.nextOffset!, view)}>{t('下一页')}<ChevronRight className="size-3.5" /></Button>
              </nav>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

function ViewButton({ active, icon, children, onClick, disabled }: { active: boolean; icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors', active ? 'bg-elevated font-medium text-fg shadow-xs' : 'text-fg-3 hover:text-fg')}>
      {icon}{children}
    </button>
  )
}

function SourceDetails({ entry, namespace }: { entry: MemoryEntry; namespace: string }) {
  const source = entry.provenance
  return (
    <Disclosure summary={t('来源与文件信息')} className="mt-1">
      {source?.kind === 'autonomous_delivery' && <p className="text-[12px] leading-[1.6] text-fg-3">{t('助手主动交付{v}。报告本身不代表结论已独立验证。', { v: source.createdAt ? ` · ${formatDateTime(source.createdAt)}` : '' })}</p>}
      <p className="text-[12px] text-fg-3">{t('文件名：{v}', { v: entry.title ?? '' })}</p>
      <code className="mt-1 block break-all rounded-md bg-inset px-2 py-1 font-mono text-[11.5px] text-fg-3">{relativeMemoryPath(entry.uri, namespace)}</code>
    </Disclosure>
  )
}

function DirectoryRow({ entry, reader, onRead, onOpen, onBrowse, namespace }: { entry: MemoryEntry; reader?: Reader; onRead: (entry: MemoryEntry, level: Reader['level'], force?: boolean) => void; onOpen: (uri: string) => void; onBrowse: (uri: string) => void; namespace: string }) {
  const target = entry.expandUri ?? entry.uri
  const badge = entry.provenance?.kind === 'autonomous_delivery' ? t('助手交付 · 资料') : memoryEntryKind(entry)
  return (
    <article className="group rounded-xl px-3 py-2.5 transition-colors hover:bg-hover" data-memory-uri={entry.uri}>
      <div className="flex items-center gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', entry.isDirectory ? 'bg-accent-softer text-accent' : 'bg-subtle text-fg-3')}>
          {entry.isDirectory ? <Folder className="size-3.5" /> : <FileText className="size-3.5" />}
        </span>
        <button type="button" onClick={() => (entry.isDirectory ? onOpen(target) : onRead(entry, 'L2'))} className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-fg hover:text-accent-text">
          {memoryDisplayTitle(entry)}
        </button>
        <Badge tone={entry.kind === 'memory' ? 'accent' : 'default'}>{badge}</Badge>
        {entry.modifiedAt && Number.isFinite(Date.parse(entry.modifiedAt)) && <time dateTime={entry.modifiedAt} className="hidden shrink-0 text-[11.5px] tabular-nums text-fg-4 sm:block">{t('更新于 {v}', { v: formatDateTime(entry.modifiedAt) })}</time>}
        <span className="flex shrink-0 items-center gap-0.5">
          {entry.isDirectory ? (
            <>
              <RowAction active={reader?.level === 'L0'} onClick={() => onRead(entry, 'L0')}>{t('摘要')}</RowAction>
              <RowAction active={reader?.level === 'L1'} onClick={() => onRead(entry, 'L1')}>{t('概览')}</RowAction>
            </>
          ) : <RowAction active={reader?.level === 'L2'} onClick={() => onRead(entry, 'L2')}>{t('阅读')}</RowAction>}
        </span>
      </div>
      {entry.displayExcerpt && <p className="mt-1.5 line-clamp-2 pl-[38px] text-[12.5px] leading-[1.6] text-fg-3">{entry.displayExcerpt}</p>}
      {!entry.isDirectory && <div className="pl-[38px]"><SourceDetails entry={entry} namespace={namespace} /></div>}
      <ReaderPanel entry={entry} reader={reader} onRead={onRead} onBrowse={onBrowse} />
    </article>
  )
}

function SearchCard({ entry, reader, onRead, onBrowse, namespace }: { entry: MemoryEntry; reader?: Reader; onRead: (entry: MemoryEntry, level: Reader['level'], force?: boolean) => void; onBrowse: (uri: string) => void; namespace: string }) {
  const target = entry.expandUri ?? entry.uri
  const text = entry.displayExcerpt || entry.summary || entry.content || ''
  const unavailable = entry.summaryStatus === 'unavailable' || !text.trim()
  return (
    <article className="rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]" data-memory-uri={entry.uri}>
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{memoryDisplayTitle(entry)}</h4>
        <Badge>{entry.isDirectory ? t('目录摘要') : entry.isLeaf ? t('文件摘要') : t('相关摘要')}</Badge>
      </div>
      <p className={cn('mt-1.5 text-[12.5px] leading-[1.65]', unavailable ? 'text-fg-4' : 'text-fg-2')}>{unavailable ? (entry.isDirectory ? t('目录摘要尚未生成，可浏览目录查看原文。') : t('尚无可用摘要，可查看原文。')) : text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {entry.isDirectory && <RowAction onClick={() => onBrowse(target)}>{t('浏览目录')}</RowAction>}
        {entry.availableReads?.includes('L1') && <RowAction active={reader?.level === 'L1'} onClick={() => onRead(entry, 'L1')}>{t('查看概览')}</RowAction>}
        {entry.availableReads?.includes('L2') && <RowAction active={reader?.level === 'L2'} onClick={() => onRead(entry, 'L2')}>{t('阅读')}</RowAction>}
      </div>
      <SourceDetails entry={entry} namespace={namespace} />
      <ReaderPanel entry={entry} reader={reader} onRead={onRead} onBrowse={onBrowse} />
    </article>
  )
}

function RowAction({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('h-6 rounded-md px-2 text-[12px] transition-colors', active ? 'bg-accent-soft text-accent-text' : 'text-fg-3 hover:bg-active hover:text-fg')}>{children}</button>
  )
}

function ReaderPanel({ entry, reader, onRead, onBrowse }: { entry: MemoryEntry; reader?: Reader; onRead: (entry: MemoryEntry, level: Reader['level'], force?: boolean) => void; onBrowse: (uri: string) => void }) {
  const label = reader ? reader.doc?.label ?? MEMORY_LEVEL_NAMES[reader.level] ?? t('记忆内容') : ''
  const target = entry.expandUri ?? entry.uri
  return (
    <AnimatePresence initial={false}>
      {reader && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
          <div className="mt-3 rounded-xl bg-base p-4 shadow-[0_0_0_1px_var(--line)]" aria-busy={reader.state === 'loading'}>
            <div className="mb-2 flex items-center gap-2">
              <strong className="flex-1 text-[12.5px] font-semibold text-fg-2">{reader.state === 'loading' ? t('{label} · 正在读取…', { label }) : reader.state === 'error' ? t('{label} · 读取失败', { label }) : label}</strong>
              {(reader.state === 'error' || reader.state === 'unavailable') && <RowAction onClick={() => onRead(entry, reader.level, true)}>{t('重新读取')}</RowAction>}
              {reader.state === 'unavailable' && <RowAction onClick={() => onBrowse(target.replace(/\/\.(?:abstract|overview)\.md$/, ''))}>{t('浏览目录')}</RowAction>}
              <RowAction onClick={() => onRead(entry, reader.level)}>{t('收起')}</RowAction>
            </div>
            {reader.state === 'loading' && <div className="space-y-2"><Skeleton className="h-3 w-5/6" /><Skeleton className="h-3 w-4/6" /><Skeleton className="h-3 w-3/6" /></div>}
            {(reader.state === 'error' || reader.state === 'unavailable') && <p className="text-[12.5px] text-fg-3">{reader.message}</p>}
            {(reader.state === 'ready' || reader.state === 'empty') && reader.doc && (
              <>
                {reader.doc.description && <p className="mb-2 text-[12px] text-fg-4">{reader.doc.description}</p>}
                <div className="max-h-[420px] overflow-y-auto pr-1"><Markdown text={reader.doc.text || t('此原文为空。')} variant="compact" /></div>
                {reader.doc.truncated && <p className="mt-2 text-[12px] text-fg-4">{t('归档保留了有界节选；此处展示归档内容，不补写缺失部分。')}</p>}
                <Disclosure summary={reader.doc.kind === 'assistant-report' ? t('原始记录与执行回执') : t('查看原始文本')} className="mt-2">
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[11.5px] leading-[1.6] text-fg-3">{reader.doc.raw}</pre>
                </Disclosure>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
