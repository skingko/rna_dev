/**
 * A number that is always right: it renders the true value on mount (history
 * never animates from zero) and, while mounted, eases from the previous value
 * when it changes. Replaces CountUp where a stale 0 was left behind when the
 * value changed after its one-time in-view animation.
 */
import { useEffect, useRef, useState } from 'react'
import { animate, useReducedMotion } from 'motion/react'

export function LiveCount({ value, duration = 0.5, className }: { value: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)
  const reduced = useReducedMotion()
  // React renders the first value only; later values are written by the effect, so React never
  // updates a text node the animation has replaced.
  const [initial] = useState(value)
  useEffect(() => {
    const node = ref.current, from = shown.current
    shown.current = value
    if (!node) return
    if (reduced || from === value) { node.textContent = String(value); return }
    const controls = animate(from, value, { duration, ease: 'easeOut', onUpdate: latest => { node.textContent = String(Math.round(latest)) }, onComplete: () => { node.textContent = String(value) } })
    return () => { controls.stop(); node.textContent = String(value) }
  }, [value, duration, reduced])
  return <span ref={ref} className={className}>{initial}</span>
}
