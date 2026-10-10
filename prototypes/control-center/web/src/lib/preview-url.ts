/** Preview URLs must be an isolated local service, never this app's own origin. */
import { getTransport } from '@/api/client'

export function validPreviewUrl(url?: string): url is string {
  if (!url) return false
  if (getTransport().kind === 'mock' && url.startsWith('data:text/html')) return true
  try { const u = new URL(url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.origin !== location.origin } catch { return false }
}

/** The running preview's URL for one workspace file: static previews serve `<base>/<entryPath>`, so the
 * entry is swapped for the file; any other shape (e.g. a Vite dev server) keeps its own entry URL. */
export function previewUrlFor(status: { url?: string; kind?: string; entryPath?: string }, path: string): string | null {
  if (!validPreviewUrl(status.url)) return null
  const entry = status.entryPath?.replace(/^\/+/, '')
  if (status.kind === 'static' && entry && status.url.endsWith(`/${entry}`)) return `${status.url.slice(0, -entry.length)}${path.split('/').map(encodeURIComponent).join('/')}`
  return status.url
}
