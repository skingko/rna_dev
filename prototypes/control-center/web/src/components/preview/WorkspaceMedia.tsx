/**
 * Project files shown in place: an image the agent wrote into the workspace
 * (generated with image_generate, or referenced from Markdown as
 * `media/x.png`) loads as workspace bytes through a blob URL (the page CSP
 * allows blob:/data: images only) and opens the file preview when clicked.
 * Relative Markdown links open the target file in the preview dock.
 *
 * A worktree conversation's files (0.63) are read from its own copy: the
 * conversation comes as `sessionId`, or from the file preview around
 * (ReadSessionContext), and absolute paths resolve against its roots.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { ImageOff } from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { ApiError } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { resolveRelative, toWorkspacePath } from './registry'
import { openFilePreview } from './open'
import { ReadSessionContext, useReadSession, useReadSessionContext, useSessionRoots } from '@/lib/session-root'
import { t as tr } from '@/i18n'

/** Failures that end on their own: the maintenance hold, an unreachable or restarting daemon, a timeout. */
const passing = (error: unknown) => error instanceof ApiError && (error.status === 0 || error.status === 503)

/** A workspace image by project-relative path. `onOpen` makes it a button (default: none). */
export function WorkspaceImage({ projectId, path, alt, className, onOpen, sessionId: own }: { projectId: string; path: string | null; alt: string; className?: string; onOpen?: () => void; sessionId?: string | null }) {
  const around = useReadSessionContext()
  const sessionId = own === undefined ? around : own
  const [url, setUrl] = useState<string | null>(null)
  // A read that failed for a passing reason (maintenance hold, daemon restart,
  // timeout) is read again once the app is back: `since` is how many returns
  // had happened when it started, so each return retries it once, never in a loop.
  const [failed, setFailed] = useState<{ retry: boolean; since: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const back = useApp(s => !s.maintenanceHeld && s.connection === 'online')
  const [returns, setReturns] = useState(0)
  const counted = useRef({ back, returns: 0 })
  useEffect(() => {
    if (back && !counted.current.back) setReturns(++counted.current.returns)
    counted.current.back = back
  }, [back])
  useEffect(() => {
    if (!path) return
    let live = true, created: string | null = null
    const since = counted.current.returns
    setFailed(null); setUrl(null)
    projectApi.readBlob(projectId, path, undefined, sessionId).then(({ blob }) => {
      if (!live) return
      created = URL.createObjectURL(blob); setUrl(created)
    }).catch((e: unknown) => { if (live) setFailed({ retry: passing(e), since }) })
    return () => { live = false; if (created) URL.revokeObjectURL(created) }
  }, [projectId, path, attempt, sessionId])
  useEffect(() => { if (back && failed?.retry && returns > failed.since) setAttempt(n => n + 1) }, [back, returns, failed])
  if (url) {
    const image = <img src={url} alt={alt} loading="lazy" className={className} />
    return onOpen ? <button type="button" className="block max-w-full cursor-zoom-in" title={tr('在预览中打开')} onClick={onOpen}>{image}</button> : image
  }
  if (!path || failed) {
    return (
      <span className="my-2 inline-flex items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-[12px] text-fg-3" title={path ?? alt}>
        <ImageOff className="size-3.5" />{alt || path}{path ? '' : ` · ${tr('外部图片未加载')}`}
      </span>
    )
  }
  return <span className={cn('skeleton my-2 block h-40 w-full max-w-[520px] rounded-md bg-muted', className)} aria-label={alt} />
}

/** Markdown image: data/blob URLs as-is, anything else as a workspace path relative to the document. */
export function MarkdownImage({ projectId, documentPath, src, alt, workspace, openable }: { projectId: string; documentPath: string; src: string; alt: string; workspace?: string | readonly string[] | null; openable?: boolean }) {
  const sessionId = useReadSessionContext()
  if (/^(data|blob):/i.test(src)) return <img src={src} alt={alt} loading="lazy" />
  // Agents write either project-relative paths or the absolute path inside the workspace.
  const target = resolveRelative(documentPath, src) ?? (workspace ? toWorkspacePath(src, workspace) : null)
  return <WorkspaceImage projectId={projectId} path={target} alt={alt || src} onOpen={openable && target ? () => openFilePreview(projectId, target, undefined, sessionId) : undefined} />
}

/** Relative links open workspace files in the preview; everything else is an external link. */
export function DocumentLink({ projectId, documentPath, href, children, workspace }: { projectId: string; documentPath: string; href: string; children: ReactNode; workspace?: string | readonly string[] | null }) {
  const sessionId = useReadSessionContext()
  if (href.startsWith('#')) return <a href={href}>{children}</a>
  const target = resolveRelative(documentPath, href) ?? (workspace ? toWorkspacePath(href, workspace) : null)
  if (target) {
    return <a href={`#${encodeURIComponent(target)}`} title={target} onClick={e => { e.preventDefault(); openFilePreview(projectId, target, undefined, sessionId) }}>{children}</a>
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

/**
 * Markdown element overrides for a conversation in a project: its images and file links resolve in the workspace —
 * a worktree conversation's (`sessionId`) in its own copy first.
 */
export function useWorkspaceMarkdown(projectId: string | null | undefined, sessionId?: string | null): Components | undefined {
  const roots = useSessionRoots(sessionId)
  const workspace = useApp(s => (projectId ? s.projects[projectId]?.workspacePath : undefined))
  const reader = useReadSession(projectId, sessionId)
  const key = roots.join('\u0000')
  return useMemo<Components | undefined>(() => {
    if (!projectId) return undefined
    const where: string | readonly string[] | undefined = sessionId && roots.length ? roots : workspace
    const wrap = (node: ReactNode) => (reader ? <ReadSessionContext.Provider value={reader}>{node}</ReadSessionContext.Provider> : node)
    return {
      img: ({ src, alt }) => wrap(<MarkdownImage projectId={projectId} documentPath="" src={typeof src === 'string' ? src : ''} alt={alt ?? ''} workspace={where} openable />),
      a: ({ href, children }) => wrap(<DocumentLink projectId={projectId} documentPath="" href={href ?? ''} workspace={where}>{children}</DocumentLink>),
    }
  // `key` stands for `roots`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workspace, sessionId, key, reader])
}
