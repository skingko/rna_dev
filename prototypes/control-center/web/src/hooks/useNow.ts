import { useEffect, useReducer, useSyncExternalStore } from 'react'

/**
 * One shared 1 Hz clock for every live timer on screen. Components subscribe
 * only while `active`, so settled rows never re-render on ticks.
 */
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null }
  }
}
const noop = () => () => {}

export function useNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : noop, () => (active ? now : 0), () => 0) || Date.now()
}

/**
 * The time to render with, plus one re-render when `nextChange(now)` arrives: for text derived from a recorded anchor
 * and the clock (a schedule's next run passing), where index rows carry the anchor and no clock value. No ticking in
 * between; a new anchor re-arms the timer.
 */
export function useNowUntil(nextChange: (now: number) => number | null): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0)
  const current = Date.now()
  const at = nextChange(current)
  useEffect(() => {
    if (at === null || !Number.isFinite(at)) return
    // setTimeout holds at most 2^31-1 ms; a farther anchor waits again after that (`tick` re-arms it).
    const wait = setTimeout(bump, Math.min(Math.max(0, at - Date.now()) + 50, 2_147_483_647))
    return () => clearTimeout(wait)
  }, [at, tick])
  return current
}
