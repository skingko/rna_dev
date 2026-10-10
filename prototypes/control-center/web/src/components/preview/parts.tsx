/**
 * Shared chrome for file preview renderers: the toolbar slot renderers portal
 * their controls into, loading shimmer, state lines (too large / failed) and
 * the download action (blob download in mock mode, host route when live).
 */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, RotateCw } from 'lucide-react'
import { downloadBlob, projectApi } from '@/api/project-api'
import { getTransport } from '@/api/client'
import { toast } from '@/store/ui-store'
import { Button, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { fileName } from './registry'
import { t as tr } from '@/i18n'
import { useReadSessionContext } from '@/lib/session-root'

/** The DOM node inside the preview header where renderers mount their controls. */
export const ToolbarSlot = createContext<HTMLElement | null>(null)

/** Render renderer-specific controls (mode toggles, zoom, wrap) into the preview header. */
export function Toolbar({ children }: { children: ReactNode }) {
  const node = useContext(ToolbarSlot)
  return node ? createPortal(children, node) : null
}

export function LoadingShimmer({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label ?? tr('正在加载预览…')} className="space-y-2.5 p-5">
      {[92, 64, 78, 50, 84, 70, 40].map((w, i) => <div key={i} className="skeleton h-3.5 rounded-md bg-muted" style={{ width: `${w}%` }} />)}
    </div>
  )
}

/** A centered message card with actions (too large, failed, unsupported). */
export function StateCard({ icon, title, detail, tone = 'default', children }: { icon?: ReactNode; title: ReactNode; detail?: ReactNode; tone?: 'default' | 'danger' | 'warning'; children?: ReactNode }) {
  return (
    <div className="grid min-h-[220px] flex-1 place-items-center p-6">
      <div className="flex max-w-[380px] flex-col items-center gap-2 text-center">
        {icon && <span className={cn('grid size-10 place-items-center rounded-xl bg-subtle text-fg-3 [&_svg]:size-5', tone === 'danger' && 'bg-danger-soft text-danger', tone === 'warning' && 'bg-warning-soft text-warning-text')}>{icon}</span>}
        <p role={tone === 'danger' ? 'alert' : undefined} className={cn('text-[13.5px] font-medium', tone === 'danger' ? 'text-danger' : 'text-fg')}>{title}</p>
        {detail && <p className="text-[12.5px] leading-relaxed text-fg-3">{detail}</p>}
        {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>}
      </div>
    </div>
  )
}

/** One-line inline failure with retry (used inside renderers, e.g. a broken image). */
export function FailureLine({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <p role="alert" className="flex items-center gap-2 px-4 py-2 text-[12.5px] text-danger">
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-3 hover:bg-hover hover:text-fg"><RotateCw className="size-3" />{tr('重试')}</button>}
    </p>
  )
}

export function Notice({ children, tone = 'warning' }: { children: ReactNode; tone?: 'warning' | 'muted' }) {
  return <p className={cn('shrink-0 border-b border-line-faint px-4 py-1.5 text-[12px]', tone === 'warning' ? 'bg-warning-soft/50 text-warning-text' : 'text-fg-3')}>{children}</p>
}

async function mockDownload(projectId: string, path: string, sessionId: string | null) {
  try { downloadBlob(fileName(path), (await projectApi.readBlob(projectId, path, undefined, sessionId)).blob) }
  catch (e) { toast((e as Error).message, 'danger') }
}

/** Download the original file. Live: the host's attachment route; mock: the fixture blob. */
export function DownloadButton({ projectId, path, variant = 'icon' }: { projectId: string; path: string; variant?: 'icon' | 'button' }) {
  const [busy, setBusy] = useState(false)
  // A worktree conversation's file downloads from its own copy (FilePreview provides the conversation).
  const sessionId = useReadSessionContext()
  const mock = getTransport().kind === 'mock'
  const onClick = mock ? async (e: { preventDefault: () => void }) => { e.preventDefault(); setBusy(true); await mockDownload(projectId, path, sessionId); setBusy(false) } : undefined
  if (variant === 'button') {
    return (
      <a href={projectApi.downloadUrl(projectId, path, sessionId)} download={fileName(path)} onClick={onClick} aria-disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-elevated px-2.5 text-[12px] font-medium text-fg-2 shadow-[0_0_0_0.5px_var(--line-strong),var(--shadow-xs)] transition-colors hover:bg-subtle hover:text-fg">
        <Download className="size-3.5" />{tr('下载原文件')}
      </a>
    )
  }
  return (
    <Tooltip content={tr('下载')}>
      <a href={projectApi.downloadUrl(projectId, path, sessionId)} download={fileName(path)} onClick={onClick} aria-label={tr('下载')}
        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg">
        <Download className="size-4" />
      </a>
    </Tooltip>
  )
}

/** Small two/three-way mode switch for the toolbar (预览 / 源码, 树形 / 格式化 …). */
export function ModeSwitch<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-7 shrink-0 items-center rounded-md bg-subtle p-0.5">
      {items.map(item => (
        <button key={item.id} type="button" role="radio" aria-checked={value === item.id} onClick={() => onChange(item.id)}
          className={cn('h-6 rounded-[5px] px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', value === item.id ? 'bg-elevated font-medium text-fg shadow-xs' : 'text-fg-3 hover:text-fg-2')}>
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function ToolbarButton({ label, onClick, active, children, disabled }: { label: string; onClick: () => void; active?: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}
        className={cn('grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [&_svg]:size-4', active && 'bg-active text-fg')}>
        {children}
      </button>
    </Tooltip>
  )
}

export { Button }
