/**
 * ReactBits SpotlightCard (registry @react-bits/SpotlightCard-TS-TW), restyled:
 * the pointer position is written to CSS variables on the element instead of
 * React state, so hovering never re-renders; colors come from design tokens.
 */
import React, { useRef } from 'react'
import { cn } from '@/lib/utils'

interface SpotlightCardProps extends React.PropsWithChildren {
  className?: string
  spotlightColor?: string
  as?: 'div' | 'a' | 'button'
  href?: string
  onClick?: () => void
  target?: string
}

const SpotlightCard: React.FC<SpotlightCardProps> = ({
  children,
  className = '',
  spotlightColor = 'color-mix(in srgb, var(--accent) 10%, transparent)',
  as = 'div',
  ...rest
}) => {
  const ref = useRef<HTMLElement>(null)

  const handleMove: React.PointerEventHandler<HTMLElement> = e => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--spot-x', `${e.clientX - rect.left}px`)
    el.style.setProperty('--spot-y', `${e.clientY - rect.top}px`)
  }

  const Tag = as as 'div'
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      onPointerMove={handleMove}
      className={cn(
        'group/spot relative isolate overflow-hidden rounded-xl bg-elevated shadow-[0_0_0_1px_var(--line)] transition-[box-shadow,transform] duration-200 ease-out hover:shadow-[0_0_0_1px_var(--line-strong),var(--shadow-sm)]',
        className,
      )}
      style={{ ['--spot-color' as string]: spotlightColor }}
      {...(rest as Record<string, unknown>)}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100 group-focus-visible/spot:opacity-100"
        style={{ background: 'radial-gradient(260px circle at var(--spot-x, 50%) var(--spot-y, 50%), var(--spot-color), transparent 70%)' }}
      />
      {children}
    </Tag>
  )
}

export default SpotlightCard
