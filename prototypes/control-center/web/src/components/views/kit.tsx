/**
 * Small building blocks shared by the project workspace views: page header,
 * list/detail split, record rows, disclosures, badges and form fields. They
 * only read semantic tokens so light and dark modes need no special cases.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, X } from 'lucide-react'
import { IconButton, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { t, intlTag } from '@/i18n'

export function ViewPage({ title, description, actions, children, wide = false }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full px-4 pb-16 pt-6 sm:px-6', wide ? 'max-w-[1100px]' : 'max-w-[860px]')}>
      <header className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
          {description && <p className="mt-1 text-[13px] leading-[1.7] text-fg-3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** Below this container width the detail covers the list instead of standing beside it. */
export const SPLIT_MIN_WIDTH = 640

/** Whether `ref`'s box is narrower than `min` CSS pixels (false until measured, and where it cannot be). */
export function useNarrow(ref: RefObject<HTMLElement | null>, min: number) {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0
      setNarrow(width > 0 && width < min)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, min])
  return narrow
}

/**
 * List on the left, a detail pane on the right. In a container narrower than 640 px (a panel, a phone) the detail
 * covers the list inside the container — never the whole app — and takes the focus. Esc closes the detail only while
 * focus is inside this view, and takes the key, so the workspace does not hide its panel too; focus goes back to the
 * row that opened it.
 */
export function SplitView({ list, detail, onClose, detailLabel }: { list: ReactNode; detail: ReactNode | null; onClose: () => void; detailLabel: string }) {
  const root = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  const narrow = useNarrow(root, SPLIT_MIN_WIDTH)
  const open = Boolean(detail)
  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && root.current?.contains(active) ? active : null
    }
    wasOpen.current = open
    // Covering the list: the row that opened it is behind the detail now.
    if (open && narrow && !pane.current?.contains(document.activeElement)) pane.current?.focus({ preventScroll: true })
  }, [open, narrow])
  const close = () => {
    onClose()
    // Focus left with the detail (or never moved past this view): back to the row that opened it.
    requestAnimationFrame(() => {
      const active = document.activeElement
      const lost = !active || active === document.body || active === root.current || Boolean(pane.current?.contains(active))
      if (lost) (opener.current?.isConnected ? opener.current : root.current)?.focus({ preventScroll: true })
    })
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open || e.nativeEvent.defaultPrevented || e.nativeEvent.isComposing) return
    if ((e.target as HTMLElement).closest('[role=dialog], [role=menu]')) return
    e.preventDefault()
    close()
  }
  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} className="@container/split relative flex min-h-0 flex-1 outline-none" data-split-view>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-quiet" inert={(open && narrow) || undefined}>{list}</div>
      <AnimatePresence initial={false}>
        {detail && (
          <motion.aside
            ref={pane}
            key="detail"
            tabIndex={-1}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            aria-label={detailLabel}
            data-split-detail={narrow ? 'over' : 'beside'}
            className="absolute inset-0 z-20 flex flex-col bg-base outline-none @[640px]/split:static @[640px]/split:z-auto @[640px]/split:w-[min(46%,560px)] @[640px]/split:shrink-0 @[640px]/split:border-l @[640px]/split:border-line-faint"
          >
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-line-faint pl-4 pr-2">
              <span className="truncate text-[13px] font-semibold text-fg">{detailLabel}</span>
              <IconButton label={t('关闭详情')} shortcut="Esc" onClick={close}><X /></IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4">{detail}</div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}

export function RecordRow({ selected, onClick, heading, title, description, footer, className }: {
  selected?: boolean; onClick?: () => void; heading?: ReactNode; title: ReactNode; description?: ReactNode; footer?: ReactNode; className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      aria-expanded={selected}
      className={cn(
        'group block w-full rounded-xl px-3.5 py-3 text-left transition-colors duration-150',
        selected ? 'bg-active' : 'hover:bg-hover',
        className,
      )}
    >
      {heading && <span className="flex items-center gap-2 text-[12px] text-fg-3">{heading}</span>}
      <span className="mt-1 block text-[14px] font-medium leading-[1.55] text-fg [overflow-wrap:anywhere]">{title}</span>
      {description && <span className="mt-1 line-clamp-2 block text-[13px] leading-[1.65] text-fg-3">{description}</span>}
      {footer && <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-3">{footer}</span>}
    </button>
  )
}

export type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'
const TONES: Record<Tone, string> = {
  default: 'bg-muted text-fg-2',
  muted: 'bg-subtle text-fg-3',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
}
export function Badge({ tone = 'default', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium', TONES[tone], className)}>{children}</span>
}

export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={cn('group/d rounded-xl shadow-[inset_0_0_0_1px_var(--line)] [&[open]>summary_svg]:rotate-90', className)}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[13px] font-medium text-fg-2 marker:hidden hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-fg-4 transition-transform duration-200" />
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      <div className="space-y-2 px-3.5 pb-3.5 text-[13px] leading-[1.7] text-fg-2">{children}</div>
    </details>
  )
}

export function Section({ title, children, aside, className }: { title?: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-6', className)}>
      {(title || aside) && (
        <div className="mb-2 flex items-center gap-2 px-1">
          {title && <h2 className="text-[12.5px] font-medium text-fg-3">{title}</h2>}
          <span className="flex-1" />
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

export function Note({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'danger' | 'warning' }) {
  return <p className={cn('text-[12.5px] leading-[1.7]', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg-3')}>{children}</p>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl px-4 py-8 text-center text-[13px] leading-[1.7] text-fg-3 shadow-[inset_0_0_0_1px_var(--line-faint)]">{children}</p>
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-xl px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--line-faint)]">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2.5 h-4 w-3/4" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-subtle px-3.5 py-3">
      <div className="text-[12px] text-fg-3">{label}</div>
      <div className="mt-1 truncate text-[15px] font-semibold tabular-nums text-fg">{value}</div>
    </div>
  )
}

export function DefinitionList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[13px] leading-[1.65]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 text-fg-2 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------------------------------------ form fields */

const fieldBase = 'w-full rounded-lg bg-subtle px-3 text-[13px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] transition-shadow placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)] disabled:opacity-50'

export function Field({ label, hint, children, hidden }: { label: string; hint?: ReactNode; children: ReactNode; hidden?: boolean }) {
  if (hidden) return null
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] leading-[1.6] text-fg-3">{hint}</span>}
    </label>
  )
}
export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldBase, 'h-9', props.className)} />
}
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldBase, 'min-h-24 resize-y py-2 leading-[1.6]', props.className)} />
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldBase, 'h-9 cursor-pointer appearance-none bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8', props.className)} style={{ backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27 fill=%27none%27 stroke=%27%23888%27 stroke-width=%271.6%27><path d=%27M4 6l4 4 4-4%27/></svg>")' }}>{children}</select>
}

export const stamp = (value?: string | number | null) => {
  if (value === null || value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(intlTag(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
}
export const fullTime = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(intlTag(), { hour12: false }) : t('未安排'))
