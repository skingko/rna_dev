/**
 * When a turn the user watched finishes successfully, open what it produced in
 * the side panel, already in preview mode (ZCode's assistant-preview auto-open
 * gate, widened from PPTX to our previewable outputs):
 *   project run preview (web app URL) → new HTML file → new document → generated image.
 * Code-only changes are not opened (审阅 stays one click away).
 *
 * The gate arms only for turns seen running in this page, fires once per turn,
 * and only while the window is visible and focused — a reload or a session
 * switch never re-opens old results, and a background tab never pops panels.
 */
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Item } from '@/api/types'
import { useApp } from '@/store/app-store'
import { openFilePreview, openProjectPreview } from '@/components/preview/open'
import { summarizeDeliverables } from '@/components/timeline/Deliverables'

const armed = new Set<string>()
const handled = new Set<string>()
const ACTIVE = new Set(['queued', 'running', 'paused'])

type Target = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/** What to show for one finished turn, or null when it produced nothing previewable. */
export function previewTarget(items: Item[]): Target | null {
  const { produced } = summarizeDeliverables(items)
  const run = produced.findLast(p => p.kind === 'preview' && p.href)
  if (run?.href) return { kind: 'url', url: run.href }
  const html = produced.findLast(p => p.kind === 'doc' && /\.html?$/i.test(p.key))
  if (html) return { kind: 'file', path: html.key }
  const doc = produced.findLast(p => p.kind === 'doc')
  if (doc) return { kind: 'file', path: doc.key }
  // A generated image opens like a new document.
  const image = produced.findLast(p => p.kind === 'media' && p.mimeType?.startsWith('image/'))
  return image ? { kind: 'file', path: image.key } : null
}

export function useAutoOpenPreview(sessionId: string | null) {
  const turns = useApp(useShallow(s => (sessionId ? Object.values(s.sessions[sessionId]?.turns ?? {}).map(turn => `${turn.id}:${turn.status}`) : [])))
  useEffect(() => {
    if (!sessionId) return
    for (const entry of turns) {
      const cut = entry.lastIndexOf(':'), id = entry.slice(0, cut), status = entry.slice(cut + 1)
      if (ACTIVE.has(status)) { armed.add(id); continue }
      if (!armed.has(id) || handled.has(id)) continue
      handled.add(id); armed.delete(id)
      if (status !== 'completed' || document.hidden || !document.hasFocus()) continue
      const state = useApp.getState(), slice = state.sessions[sessionId]
      const projectId = slice?.meta?.projectId ?? state.sessionIndex[sessionId]?.projectId ?? null
      if (!slice || !projectId) continue
      const items = slice.order.map(key => slice.items[key]).filter((item): item is Item => Boolean(item) && item.turnId === id)
      const target = previewTarget(items)
      if (target?.kind === 'url') void openProjectPreview(projectId, target.url)
      else if (target?.kind === 'file') openFilePreview(projectId, target.path, undefined, sessionId)
    }
  }, [sessionId, turns])
}
