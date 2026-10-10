/**
 * ReactBits ShinyText (registry @react-bits/ShinyText-TS-TW), restyled: the
 * sheen is a CSS keyframe on a text-clipped gradient built from currentColor
 * (so it inherits the design-system text tier) instead of a per-frame
 * useAnimationFrame loop. Reduced motion falls back to plain text.
 */
import React from 'react'
import { cn } from '@/lib/utils'

interface ShinyTextProps {
  text: React.ReactNode
  disabled?: boolean
  speed?: number
  className?: string
}

const ShinyText: React.FC<ShinyTextProps> = ({ text, disabled = false, speed = 1.8, className = '' }) => (
  <span
    className={cn('inline-block', !disabled && 'text-shimmer', className)}
    style={disabled ? undefined : { animationDuration: `${speed}s` }}
  >
    {text}
  </span>
)

export default ShinyText
