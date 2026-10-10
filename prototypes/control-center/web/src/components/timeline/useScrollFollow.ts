/**
 * Bottom-follow for a streaming scrollport (after Harness use-scroll-follow).
 * Follow intent is kept in a ref (no React updates per scroll sample); only
 * the "away from bottom" boolean for the jump pill is React state.
 *
 *  - Content growth while following pins to the floor instantly (smooth
 *    scrolling fights streaming growth and stutters).
 *  - A reader gesture that moves away from the floor releases follow; coming
 *    back within the threshold re-engages it.
 *  - Programmatic scrolls are not mistaken for reader movement.
 *  - A newly opened conversation settles at the bottom: while its rows are
 *    still being measured, only a reader gesture (wheel, touch, keys) can
 *    release follow — scroll jumps from measurement never do.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const THRESHOLD = 56
/** How long a newly opened conversation keeps settling at the bottom while rows are measured. */
const SETTLE_MS = 1500

/** `resetKey`: a new value (another conversation) starts again at the bottom. */
export function useScrollFollow(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, resetKey: unknown) {
  const following = useRef(true)
  const settling = useRef(false)
  const programmatic = useRef(false)
  const smoothTarget = useRef<number | null>(null)
  const [away, setAway] = useState(false)

  const floor = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight)

  const pin = useCallback(() => {
    const el = scrollRef.current
    if (!el || !following.current || smoothTarget.current !== null) return
    const target = floor(el)
    if (Math.abs(el.scrollTop - target) < 1) return
    programmatic.current = true
    el.scrollTop = target
  }, [scrollRef])

  // Reader movement
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = floor(el) - el.scrollTop
      if (programmatic.current) {
        programmatic.current = false
      } else if (settling.current) {
        // Measurement moved the content: stay on the floor.
        if (following.current && distance > 1) pin()
      } else if (smoothTarget.current === null) {
        following.current = distance <= THRESHOLD
      }
      if (smoothTarget.current !== null && distance <= 2) smoothTarget.current = null
      const nextAway = distance > THRESHOLD * 2
      setAway(prev => (prev === nextAway ? prev : nextAway))
    }
    const interrupt = (e: Event) => {
      // Upward intent releases follow immediately, even mid-animation.
      if (e instanceof WheelEvent && e.deltaY >= 0) return
      if (e instanceof KeyboardEvent && !['ArrowUp', 'PageUp', 'Home'].includes(e.key)) return
      smoothTarget.current = null
      settling.current = false
      following.current = false
    }
    // Any press (a scrollbar drag has no wheel or touch event) ends settling; follow is then judged by position again.
    const release = () => { settling.current = false }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointerdown', release, { passive: true })
    el.addEventListener('wheel', interrupt, { passive: true })
    el.addEventListener('touchmove', interrupt, { passive: true })
    el.addEventListener('keydown', interrupt)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerdown', release)
      el.removeEventListener('wheel', interrupt)
      el.removeEventListener('touchmove', interrupt)
      el.removeEventListener('keydown', interrupt)
    }
  }, [scrollRef])

  // Content growth
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => pin())
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, pin])

  // New conversation: at the latest message, held there while its rows settle.
  useEffect(() => {
    following.current = true
    settling.current = true
    smoothTarget.current = null
    setAway(false)
    let frame = requestAnimationFrame(function settle() { pin(); if (settling.current) frame = requestAnimationFrame(settle) })
    const timer = setTimeout(() => { settling.current = false; pin() }, SETTLE_MS)
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); settling.current = false }
  }, [resetKey, pin])

  const jumpToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    following.current = true
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (behavior === 'smooth' && !reduced) {
      smoothTarget.current = floor(el)
      el.scrollTo({ top: floor(el), behavior: 'smooth' })
      // Safety: if content grew during the animation, settle on the floor.
      setTimeout(() => { smoothTarget.current = null; pin() }, 700)
    } else {
      programmatic.current = true
      el.scrollTop = floor(el)
    }
  }, [scrollRef, pin])

  return { away, jumpToLatest, pin, following }
}
