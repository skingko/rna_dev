/**
 * Live background-work steps (P-2 `work.step`, index stream only): the last
 * few tool starts of each running action, for the tasks panel's "正在…" line
 * and step list. Display-only and never persisted — after a reconnect the
 * project summary's `work.latest` is the fallback. Also the panel's clock: the
 * app's shared 1 Hz clock, ticking only while a visible panel shows something
 * running and the window itself is shown.
 */
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import type { WorkStepEvent } from '@/api/types'
import { useNow } from '@/hooks/useNow'

export interface LiveStep { toolCallId: string; name: string; kind: string; target: string | null; at: string; projectId: string }

interface BackgroundLiveState {
  /** Per action id, oldest first, at most `MAX_LIVE_STEPS`. */
  steps: Record<string, LiveStep[]>
}

/** Steps kept per action (the host keeps 12 receipts; the step list shows as many). */
export const MAX_LIVE_STEPS = 12
/** Actions tracked at once; the least recently active is dropped first. */
export const MAX_LIVE_ACTIONS = 24

export const useBackgroundLive = create<BackgroundLiveState>(() => ({ steps: {} }))

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Record one `work.step`; malformed events and repeats of a step already seen are ignored. */
export function recordWorkStep(event: WorkStepEvent | null | undefined) {
  const actionId = text(event?.actionId), toolCallId = text(event?.toolCallId), name = text(event?.name)
  if (!event || !actionId || !toolCallId || !name || !Number.isFinite(Date.parse(text(event.at)))) return
  const step: LiveStep = { toolCallId, name, kind: text(event.kind) || 'other', target: text(event.target) || null, at: event.at, projectId: text(event.projectId) }
  useBackgroundLive.setState(s => {
    const current = s.steps[actionId] ?? []
    if (current.some(row => row.toolCallId === toolCallId)) return s
    const next = [...current, step].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_LIVE_STEPS)
    const steps = { ...s.steps, [actionId]: next }
    const ids = Object.keys(steps)
    if (ids.length > MAX_LIVE_ACTIONS) {
      const latest = (id: string) => Date.parse(steps[id].at(-1)?.at ?? '') || 0
      for (const id of ids.sort((a, b) => latest(a) - latest(b)).slice(0, ids.length - MAX_LIVE_ACTIONS)) delete steps[id]
    }
    return { steps }
  })
}

/* ------------------------------------------------------------------ clock */

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
function onVisibility(listener: () => void) {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * Now (ms), ticking once a second only while `active` (the panel is visible and something runs) and the window is
 * shown. Otherwise a settled value, so cards do not re-render.
 */
export function useRunClock(active: boolean): number {
  const windowHidden = useSyncExternalStore(onVisibility, hidden, () => false)
  return useNow(active && !windowHidden)
}
