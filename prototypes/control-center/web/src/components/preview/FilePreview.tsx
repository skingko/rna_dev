/**
 * Unified workspace file preview. Picks a renderer from the registry by
 * suffix (then host MIME), reads UTF-8 text or complete bytes through the
 * host's path-guarded file routes, and owns the shared states: loading
 * shimmer, "large file — open anyway", over-limit download, failure + retry,
 * and non-text fallback. Renderers portal their controls into the header.
 *
 * Used by the right dock (`file` panel, review dock 预览) and the 文件 view.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FileWarning, RotateCw, TriangleAlert } from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { ApiError } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { previewSpec, sizeVerdict, formatBytes, fileName, type PreviewSpec } from './registry'
import { Button, DownloadButton, LoadingShimmer, Notice, StateCard, ToolbarButton, ToolbarSlot } from './parts'
import { CodePreview } from './renderers/CodePreview'
import { MarkdownPreview } from './renderers/MarkdownPreview'
import { JsonPreview } from './renderers/JsonPreview'
import { DelimitedPreview, ExcelPreview } from './renderers/TablePreview'
import { ImagePreview } from './renderers/ImagePreview'
import { BinaryCard, HtmlPreview, OfficeCard, PdfPreview } from './renderers/DocumentPreviews'
import { PreviewViewContext, type HostedView } from './view-context'
import { ReadSessionContext } from '@/lib/session-root'
import { t as tr } from '@/i18n'

type Loaded =
  | { status: 'loading' }
  | { status: 'confirm'; size: number }
  | { status: 'blocked'; size: number | null }
  /** `since`: how many times the app had come back when the read started (a passing failure retries on the next one). */
  | { status: 'error'; message: string; code: number; since: number }
  | { status: 'binary'; size: number | null; type?: string }
  | { status: 'text'; text: string; truncated: boolean; size: number | null }
  | { status: 'bytes'; blob: Blob; size: number }
  | { status: 'none' }

export interface FilePreviewProps {
  projectId: string
  /** Workspace-relative path. */
  path: string
  /** Size in bytes when the caller knows it (tree listing); otherwise looked up from the parent directory. */
  size?: number | null
  /**
   * A change signal from the caller (the 文件 view bumps it when the run preview reports changed files). Like a new
   * `size`, it reads the file again in place: what is shown stays until the new content arrives, and stays as it is
   * when nothing changed, so the reading position is kept.
   */
  revision?: number
  /** Show the file name in the header (off when the host chrome already names the file). */
  showTitle?: boolean
  /** Extra header content before the renderer controls. */
  leading?: ReactNode
  /**
   * Host-owned view (the 审查 tab's single 预览 / 源码 / 差异 switch): renderers
   * hide their inner 预览/源码 toggles; `source` shows the raw text.
   */
  view?: HostedView
  className?: string
  /**
   * 0.63: read through this worktree conversation's own copy (`?sessionId=`; lib/session-root `readSessionFor`), and
   * so does everything inside (a document's images, the download button). Absent: the project folder.
   */
  sessionId?: string | null
}

export function FilePreview({ projectId, path, size: knownSize, revision, showTitle = true, leading, view, className, sessionId = null }: FilePreviewProps) {
  const spec = previewSpec(path)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [state, setState] = useState<Loaded>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [override, setOverride] = useState(false)
  const [size, setSize] = useState<number | null>(knownSize ?? null)
  const shown = useRef(state)
  shown.current = state
  const read = useRef('')

  useEffect(() => { setOverride(false) }, [projectId, path])
  useEffect(() => { setSize(knownSize ?? null) }, [projectId, path, knownSize])

  // A read that failed for a passing reason (maintenance hold, daemon restart, timeout) is read again once the app
  // is back, once per return, as WorkspaceImage does.
  const back = useApp(s => !s.maintenanceHeld && s.connection === 'online')
  const [returns, setReturns] = useState(0)
  const counted = useRef({ back, returns: 0 })
  useEffect(() => {
    if (back && !counted.current.back) setReturns(++counted.current.returns)
    counted.current.back = back
  }, [back])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const since = counted.current.returns
    // Only the caller's change signals moved (listed size, `revision`) while this file is shown: read it in place.
    const identity = JSON.stringify([projectId, path, override, attempt, sessionId])
    const quiet = read.current === identity && shown.current.status !== 'loading' && shown.current.status !== 'error'
    read.current = identity
    const run = async () => {
      if (!quiet) setState({ status: 'loading' })
      if (spec.load === 'none') {
        const bytes = knownSize ?? await lookupSize(projectId, path, signal, sessionId)
        if (!signal.aborted) { setSize(bytes); setState({ status: 'none' }) }
        return
      }
      let bytes = knownSize ?? null
      if (bytes === null && spec.softLimit !== Infinity) bytes = await lookupSize(projectId, path, signal, sessionId)
      if (signal.aborted) return
      setSize(bytes)
      const verdict = sizeVerdict(spec, bytes)
      if (verdict === 'block') { setState({ status: 'blocked', size: bytes }); return }
      if (verdict === 'confirm' && !override) { setState({ status: 'confirm', size: bytes! }); return }
      try {
        if (spec.load === 'text') {
          const data = await projectApi.read(projectId, path, signal, sessionId)
          const next = { status: 'text', text: data.content, truncated: Boolean(data.truncated), size: data.bytes ?? bytes } as const
          // Unchanged text keeps the rendered document (and its scroll position) as it is.
          if (!signal.aborted) setState(current => (current.status === 'text' && current.text === next.text && current.truncated === next.truncated && current.size === next.size ? current : next))
        } else {
          const data = await projectApi.readBlob(projectId, path, signal, sessionId)
          const current = shown.current
          const same = quiet && current.status === 'bytes' && await sameBytes(current.blob, data.blob)
          if (signal.aborted || same) return
          setSize(data.size); setState({ status: 'bytes', blob: data.blob, size: data.size })
        }
      } catch (e) {
        if (signal.aborted || (e as Error).name === 'AbortError') return
        const code = e instanceof ApiError ? e.status : 0
        // A background re-read that fails keeps the file on screen; only a file that is gone says so.
        if (quiet && code !== 404) return
        if (code === 415) setState({ status: 'binary', size: bytes })
        else if (code === 413) setState({ status: 'blocked', size: bytes })
        else setState({ status: 'error', message: (e as Error).message || tr('读取失败'), code, since })
      }
    }
    void run()
    return () => controller.abort()
    // `spec` derives from `path`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, knownSize, revision, override, attempt, sessionId])

  const retry = useCallback(() => setAttempt(n => n + 1), [])
  useEffect(() => {
    if (back && state.status === 'error' && (state.code === 0 || state.code === 503) && returns > state.since) retry()
  }, [back, returns, state, retry])
  const showSize = size ?? (state.status === 'text' ? state.size : null)

  return (
    <ReadSessionContext.Provider value={sessionId}>
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)} data-preview-kind={spec.kind} data-read-session={sessionId ?? undefined}>
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-faint pl-3 pr-1.5">
        {leading}
        <span className="shrink-0 rounded bg-subtle px-1.5 py-px font-mono text-[10.5px] font-medium tracking-wide text-fg-3" title={spec.lang ?? spec.kind}>{spec.badge}</span>
        {showTitle && <strong className="min-w-0 truncate font-mono text-[12.5px] font-medium text-fg" title={path}>{fileName(path)}</strong>}
        {showSize !== null && showSize !== undefined && <span className="shrink-0 text-[11.5px] tabular-nums text-fg-4">{formatBytes(showSize)}</span>}
        <span className="min-w-0 flex-1" />
        <div ref={setSlot} className="flex shrink-0 items-center gap-1" />
        <ToolbarButton label={tr('重新读取')} onClick={retry}><RotateCw /></ToolbarButton>
        <DownloadButton projectId={projectId} path={path} />
      </header>
      <ToolbarSlot.Provider value={slot}>
        <PreviewViewContext.Provider value={view ?? null}>
          <Body spec={spec} state={state} projectId={projectId} path={path} size={showSize ?? null} retry={retry} openAnyway={() => setOverride(true)} source={view === 'source'} />
        </PreviewViewContext.Provider>
      </ToolbarSlot.Provider>
    </div>
    </ReadSessionContext.Provider>
  )
}

function Body({ spec, state, projectId, path, size, retry, openAnyway, source }: { spec: PreviewSpec; state: Loaded; projectId: string; path: string; size: number | null; retry: () => void; openAnyway: () => void; source?: boolean }) {
  switch (state.status) {
    case 'loading': return <LoadingShimmer />
    case 'confirm':
      return (
        <StateCard tone="warning" icon={<TriangleAlert />} title={tr('文件较大（{size}）', { size: formatBytes(state.size) })} detail={tr('预览可能较慢，或只显示开头部分。')}>
          <Button size="sm" variant="primary" onClick={openAnyway}>{tr('仍然打开')}</Button>
          <DownloadButton projectId={projectId} path={path} variant="button" />
        </StateCard>
      )
    case 'blocked':
      return (
        <StateCard icon={<FileWarning />} title={tr('文件超过预览上限')} detail={state.size ? tr('{size}，请下载后查看。', { size: formatBytes(state.size) }) : tr('请下载后查看。')}>
          <DownloadButton projectId={projectId} path={path} variant="button" />
        </StateCard>
      )
    case 'error':
      return (
        <StateCard tone="danger" icon={<FileWarning />} title={state.code === 404 ? tr('文件不存在或已被移动') : tr('无法打开此文件')} detail={state.message}>
          <Button size="sm" onClick={retry} leading={<RotateCw className="size-3.5" />}>{tr('重试')}</Button>
        </StateCard>
      )
    case 'binary': return <BinaryCard projectId={projectId} path={path} size={state.size ?? size} />
    case 'none': return spec.kind === 'office' ? <OfficeCard projectId={projectId} path={path} size={size} /> : <BinaryCard projectId={projectId} path={path} size={size} />
    case 'bytes': {
      if (spec.kind === 'image') return <ImagePreview blob={state.blob} name={fileName(path)} />
      if (spec.kind === 'pdf') return <PdfPreview blob={state.blob} name={fileName(path)} />
      if (spec.kind === 'excel') return <ExcelPreview blob={state.blob} />
      return <BinaryCard projectId={projectId} path={path} size={state.size} type={state.blob.type} />
    }
    case 'text': {
      const body = (() => {
        if (source) return <CodePreview text={state.text} lang={spec.lang} defaultWrap={spec.kind === 'markdown' || spec.kind === 'text'} />
        switch (spec.kind) {
          case 'markdown': return <MarkdownPreview projectId={projectId} path={path} text={state.text} />
          case 'json': return state.truncated ? <CodePreview text={state.text} lang="json" /> : <JsonPreview text={state.text} />
          case 'table': return <DelimitedPreview text={state.text} delimiter={spec.delimiter ?? ','} />
          case 'html': return <HtmlPreview text={state.text} projectId={projectId} path={path} />
          case 'code': return <CodePreview text={state.text} lang={spec.lang} />
          default: return <CodePreview text={state.text} defaultWrap />
        }
      })()
      return (
        <>
          {state.truncated && <Notice>{tr('文件较大，当前只显示开头部分；下载可获取完整文件。')}</Notice>}
          {body}
        </>
      )
    }
  }
}

/** Whether a re-read returned the same bytes (an image or PDF is not reloaded for nothing). */
async function sameBytes(a: Blob, b: Blob) {
  if (a.size !== b.size || a.type !== b.type) return false
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]).then(buffers => buffers.map(buffer => new Uint8Array(buffer)))
  return x.every((byte, i) => byte === y[i])
}

/** Size from the parent directory listing (one cheap request); null when unavailable. */
async function lookupSize(projectId: string, path: string, signal: AbortSignal, sessionId: string | null): Promise<number | null> {
  const dir = path.split('/').slice(0, -1).join('/')
  try {
    const listing = await projectApi.list(projectId, dir, signal, sessionId)
    return listing.entries.find(e => e.path === path)?.size ?? null
  } catch { return null }
}
