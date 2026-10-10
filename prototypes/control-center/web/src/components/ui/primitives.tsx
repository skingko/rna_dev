/**
 * Design-system primitives. Visual rules: one accent, hairline borders only
 * where a surface needs separation, hover = subtle fill, 140-200ms transitions
 * on color/opacity/transform only.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip as RTooltip } from 'radix-ui'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

/* ----------------------------------------------------------------- Button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent-soft'
type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  leading?: ReactNode
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-fg-inverted hover:opacity-90 active:opacity-85 shadow-xs',
  secondary: 'bg-elevated text-fg-2 shadow-[0_0_0_0.5px_var(--line-strong),var(--shadow-xs)] hover:text-fg hover:bg-subtle',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
  'accent-soft': 'bg-accent-soft text-accent-text hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]',
}
const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', leading, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,opacity,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        buttonVariants[variant], buttonSizes[size], className,
      )}
      {...rest}
    >
      {leading}
      {children}
    </button>
  )
})

/* ------------------------------------------------------------- IconButton */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  tooltip?: boolean
  active?: boolean
  shortcut?: string
}

const iconSizes = { sm: 'size-6 rounded-md [&_svg]:size-3.5', md: 'size-7 rounded-md [&_svg]:size-4', lg: 'size-8 rounded-lg [&_svg]:size-[17px]' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', tooltip = true, active, shortcut, className, children, type = 'button', ...rest }, ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-active={active || undefined}
      className={cn(
        'inline-grid shrink-0 place-items-center text-fg-3 transition-[background-color,color,transform] duration-150 ease-out hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-40 data-[active]:bg-active data-[active]:text-fg',
        iconSizes[size], className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
  if (!tooltip) return button
  return <Tooltip content={label} shortcut={shortcut}>{button}</Tooltip>
})

/* ---------------------------------------------------------------- Tooltip */

export function Tooltip({ content, shortcut, children, side = 'bottom', delay = 450 }: { content: ReactNode; shortcut?: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }) {
  return (
    <RTooltip.Root delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} collisionPadding={8} className="tooltip-content z-50 flex max-w-72 items-center gap-2 rounded-md bg-[#1b2130] px-2 py-1 text-[12px] leading-[18px] text-white shadow-md dark:bg-[#e9ebf0] dark:text-[#121418]">
          {content}
          {shortcut && <Kbd className="border-white/15 bg-white/10 text-white/70 dark:border-black/10 dark:bg-black/5 dark:text-black/55">{shortcut}</Kbd>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export const TooltipProvider = RTooltip.Provider

/* -------------------------------------------------------------------- Kbd */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-elevated px-1 font-sans text-[10.5px] font-medium leading-none text-fg-3', className)}>
      {children}
    </kbd>
  )
}

/* ------------------------------------------------------------------- Pill */

export const Pill = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { leading?: ReactNode; trailing?: ReactNode; tone?: 'default' | 'accent' | 'warning' }>(
  function Pill({ leading, trailing, tone = 'default', className, children, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
          tone === 'default' && 'text-fg-2 hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg',
          tone === 'accent' && 'bg-accent-soft text-accent-text hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]',
          tone === 'warning' && 'bg-warning-soft text-warning-text',
          className,
        )}
        {...rest}
      >
        {leading}
        <span className="min-w-0 truncate">{children}</span>
        {trailing}
      </button>
    )
  },
)

/* -------------------------------------------------------------- StatusDot */

export type DotState = 'idle' | 'running' | 'paused' | 'waiting' | 'unread' | 'error' | 'success' | 'offline'

export function StatusDot({ state, className }: { state: DotState; className?: string }) {
  const color = {
    idle: 'bg-idle', running: 'bg-accent', paused: 'bg-warning', waiting: 'bg-warning', unread: 'bg-accent', error: 'bg-danger', success: 'bg-success', offline: 'bg-idle',
  }[state]
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0 rounded-full', color, className)} aria-hidden>
      {(state === 'running' || state === 'waiting') && (
        <span className={cn('absolute inset-0 rounded-full dot-ring', color)} />
      )}
    </span>
  )
}

/* --------------------------------------------------------------- Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md bg-muted', className)} />
}

/* ---------------------------------------------------------- SegmentedTabs */

export interface TabItem<T extends string> { id: T; label: ReactNode; badge?: ReactNode }

export function SegmentedTabs<T extends string>({ items, value, onChange, layoutId, className }: {
  items: TabItem<T>[]; value: T; onChange: (id: T) => void; layoutId: string; className?: string
}) {
  return (
    <div role="tablist" className={cn('relative flex items-center gap-0.5', className)}>
      {items.map(item => {
        const selected = item.id === value
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors duration-150',
              selected ? 'text-fg font-medium' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-md bg-active"
                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }}
              />
            )}
            <span className="relative">{item.label}</span>
            {item.badge !== undefined && item.badge !== null && <span className="relative text-[11px] tabular-nums text-fg-4">{item.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------- DisclosureRow */

/**
 * The shared single-line row (Harness DisclosureRow): 16px leading glyph,
 * title, optional 2px dot + summary, trailing meta. The leading icon swaps to
 * a chevron on hover when the row can expand.
 */
export function DisclosureRow({
  icon, title, summary, meta, open, expandable, onToggle, onClick, className, titleClassName, summaryClassName, trailing, sweep,
}: {
  icon: ReactNode
  title: ReactNode
  summary?: ReactNode
  meta?: ReactNode
  open?: boolean
  expandable?: boolean
  onToggle?: () => void
  onClick?: () => void
  className?: string
  titleClassName?: string
  summaryClassName?: string
  trailing?: ReactNode
  sweep?: boolean
}) {
  const clickable = expandable || onClick
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={expandable ? Boolean(open) : undefined}
      onClick={expandable ? onToggle : onClick}
      onKeyDown={e => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); (expandable ? onToggle : onClick)?.() } }}
      className={cn(
        'group/row flex h-7 min-w-0 items-center rounded-md text-[13px] leading-5 text-fg-3 outline-none transition-colors duration-150',
        clickable && 'cursor-pointer hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]',
        sweep && 'row-sweep',
        className,
      )}
    >
      <span className="relative mr-2 grid size-4 shrink-0 place-items-center [&_svg]:size-[14px]">
        <span className={cn('grid place-items-center transition-opacity duration-150', expandable && 'group-hover/row:opacity-0')}>{icon}</span>
        {expandable && (
          <svg viewBox="0 0 16 16" className={cn('absolute inset-0 m-auto opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover/row:opacity-100', open ? 'rotate-90' : 'rotate-0')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4" /></svg>
        )}
      </span>
      <span className={cn('shrink-0 text-fg-2 transition-colors group-hover/row:text-fg', titleClassName)}>{title}</span>
      {summary && (
        <>
          <span className="flow-dot mx-2" aria-hidden />
          <span className={cn('min-w-0 flex-1 truncate', summaryClassName)}>{summary}</span>
        </>
      )}
      {!summary && <span className="flex-1" />}
      {meta && <span className="ml-3 shrink-0 text-[12px] tabular-nums text-fg-4">{meta}</span>}
      {trailing}
    </div>
  )
}
