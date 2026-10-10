/**
 * The first browser step of a turn the user is watching opens 浏览器 · Rna in
 * the side panel, so testing happens where it can be seen (zcode opens its
 * in-app browser when the agent starts using it). Once per turn: closing the
 * tab or switching away is respected for the rest of that turn.
 */
import { useEffect } from 'react'
import { useApp } from '@/store/app-store'
import { openTab } from '@/store/side-panel-store'
import { browserAction } from '@/lib/tools'

const opened = new Set<string>()
const RECENT = 40

export function useAutoOpenAgentBrowser(sessionId: string | null) {
  // The turn of a browser step running now (a string, so the selector never allocates).
  const turnId = useApp(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    if (!slice) return null
    for (let i = slice.order.length - 1; i >= Math.max(0, slice.order.length - RECENT); i--) {
      const item = slice.items[slice.order[i]], tool = item?.tool
      if (tool && browserAction(tool) && (tool.status === 'running' || tool.status === 'pending' || tool.preparing)) return item.turnId ?? item.id
    }
    return null
  })
  useEffect(() => {
    if (!sessionId || !turnId || opened.has(turnId)) return
    opened.add(turnId)
    if (document.hidden) return
    openTab({ type: 'agent-browser', sessionId })
  }, [sessionId, turnId])
}
