import { useState, type ReactNode } from 'react'
import { ContextMenu as RContextMenu, Dialog as RDialog, DropdownMenu, Popover as RPopover } from 'radix-ui'
import { AnimatePresence, motion } from 'motion/react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui-store'
import { t as tr } from '@/i18n'

/* ------------------------------------------------------------------ Menu */

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger

export function MenuContent({ children, className, align = 'start', side = 'bottom', sideOffset = 6 }: { children: ReactNode; className?: string; align?: 'start' | 'center' | 'end'; side?: 'top' | 'bottom' | 'left' | 'right'; sideOffset?: number }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn('menu-content z-50 min-w-48 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none', className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ children, icon, hint, onSelect, danger, className, disabled }: { children: ReactNode; icon?: ReactNode; hint?: ReactNode; onSelect?: () => void; danger?: boolean; className?: string; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3',
        danger && 'text-danger [&_svg]:text-danger',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[12px] text-fg-4">{hint}</span>}
    </DropdownMenu.Item>
  )
}

export function MenuCheckItem({ children, checked, description, onSelect, trailing }: { children: ReactNode; checked: boolean; description?: ReactNode; onSelect: () => void; trailing?: ReactNode }) {
  return (
    <DropdownMenu.Item
      onSelect={e => { e.preventDefault(); onSelect() }}
      className="flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 outline-none transition-colors duration-100 data-[highlighted]:bg-hover"
    >
      <span className="grid size-4 shrink-0 place-items-center text-accent">{checked && <Check className="size-3.5" strokeWidth={2.2} />}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', checked ? 'text-fg font-medium' : 'text-fg-2')}>{children}</span>
        {description && <span className="line-clamp-2 text-[12px] leading-4 text-fg-4">{description}</span>}
      </span>
      {trailing}
    </DropdownMenu.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-fg-4">{children}</DropdownMenu.Label>
}
export function MenuSeparator() {
  return <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
}

/* ----------------------------------------------------------- ContextMenu */
// Right-click menus, styled like Menu (a tab strip's close actions and similar).

export const ContextMenu = RContextMenu.Root
export const ContextMenuTrigger = RContextMenu.Trigger

export function ContextMenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RContextMenu.Portal>
      <RContextMenu.Content collisionPadding={10} className={cn('menu-content z-50 min-w-48 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none', className)}>
        {children}
      </RContextMenu.Content>
    </RContextMenu.Portal>
  )
}

export function ContextMenuItem({ children, icon, hint, onSelect, danger, disabled }: { children: ReactNode; icon?: ReactNode; hint?: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <RContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3',
        danger && 'text-danger [&_svg]:text-danger',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[12px] text-fg-4">{hint}</span>}
    </RContextMenu.Item>
  )
}

export function ContextMenuSeparator() {
  return <RContextMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
}

/* --------------------------------------------------------------- Popover */

export const Popover = RPopover.Root
export const PopoverTrigger = RPopover.Trigger
export function PopoverContent({ children, className, align = 'start', side = 'top' }: { children: ReactNode; className?: string; align?: 'start' | 'center' | 'end'; side?: 'top' | 'bottom' }) {
  return (
    <RPopover.Portal>
      <RPopover.Content align={align} side={side} sideOffset={8} collisionPadding={10} className={cn('menu-content z-50 rounded-xl bg-elevated p-3 text-[13px] shadow-lg outline-none', className)}>
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  )
}

/* ---------------------------------------------------------------- Dialog */

/** The button that opened the menu or popover holding `element`, when that menu or popover names it. */
function openerOf(element: HTMLElement): HTMLElement | null {
  const menu = element.closest('[role="menu"]')
  if (menu) {
    const trigger = menu.getAttribute('aria-labelledby')
    return trigger ? document.getElementById(trigger) : null
  }
  const popover = element.closest('[data-radix-popper-content-wrapper] [role="dialog"][id]')
  return popover ? document.querySelector<HTMLElement>(`[aria-controls="${popover.id.replace(/["\\]/g, '\\$&')}"]`) : null
}

/**
 * Where the keyboard goes back to when a dialog closes, best first: the element focused when it opened, then the
 * button that opened the menu or popover it sat in (a menu item is gone by the time the dialog closes), and so on
 * out through submenus. Empty when nothing was focused (the page itself).
 */
export function returnFocusTargets(active: Element | null): HTMLElement[] {
  const chain: HTMLElement[] = []
  for (let element = active instanceof HTMLElement && active !== document.body ? active : null; element && chain.length < 8; element = openerOf(element)) {
    if (chain.includes(element)) break
    chain.push(element)
  }
  return chain
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Focus `element`; false when it cannot take focus (hidden, disabled, gone). */
function focusTaken(element: HTMLElement) {
  element.focus({ preventScroll: true })
  return document.activeElement === element
}

/** The first other control around `element` (its row's own button, say) that can take focus. */
function nearbyFocusable(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement, depth = 0; parent && parent !== document.body && depth < 3; parent = parent.parentElement, depth++) {
    for (const candidate of parent.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (candidate !== element && !candidate.matches(':disabled') && candidate.checkVisibility?.() !== false) return candidate
    }
  }
  return null
}

/**
 * Focus back to what opened a dialog that has no Dialog.Trigger (they open from menus, buttons and stores): Radix
 * returns focus to the trigger, and without one it fell to the page and the keyboard lost its place. Pass the result
 * as Dialog.Content's `onCloseAutoFocus`; `Dialog` below does. What had focus is read while rendering the opening
 * dialog, before Radix or an autoFocus field moves it. A menu button shown only while its row is hovered or has focus
 * (a sidebar row's ⋯) cannot take focus by then: its row's own control takes it, and the button again if that shows it.
 * @param onCloseAutoFocus - runs first; `preventDefault()` there to place focus yourself.
 */
export function useReturnFocus(open: boolean, onCloseAutoFocus?: (event: Event) => void): (event: Event) => void {
  const [opened, setOpened] = useState(() => ({ open, openers: open ? returnFocusTargets(document.activeElement) : [] }))
  if (opened.open !== open) setOpened({ open, openers: open ? returnFocusTargets(document.activeElement) : opened.openers })
  const { openers } = opened
  return (event: Event) => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    // Something the dialog's action opened has taken focus on the way out: leave it there.
    const active = document.activeElement
    if (active && active !== document.body && active !== document.documentElement) return
    for (const opener of openers) {
      if (!opener.isConnected) continue
      if (focusTaken(opener)) return
      const near = nearbyFocusable(opener)
      if (near && focusTaken(near)) { focusTaken(opener); return }
    }
  }
}

/**
 * The last element focus was sent to inside a dialog, even when a closing menu's focus trap pulled it straight back:
 * focusout names it (relatedTarget) before the trap reacts, and focusin may then never fire for it. That is how an
 * autoFocus field in a dialog picked from a menu was lost (重命名 landed on 关闭, not the name field). Watched once, from
 * the first dialog's render, so it is in place before React focuses an autoFocus field.
 */
let dialogFocusRequest: HTMLElement | null = null
let watchingDialogFocus = false
function watchDialogFocus() {
  if (watchingDialogFocus || typeof document === 'undefined') return
  watchingDialogFocus = true
  const note = (target: EventTarget | null) => { if (target instanceof HTMLElement && target.closest('[role="dialog"]')) dialogFocusRequest = target }
  document.addEventListener('focusout', event => note(event.relatedTarget), true)
  document.addEventListener('focusin', event => note(event.target), true)
}

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /**
   * The dialog has closed and focus is about to return to the element that opened it. Call `preventDefault()` to move
   * focus somewhere else yourself.
   */
  onCloseAutoFocus?: (event: Event) => void
}

export function Dialog({ open, onOpenChange, ...layer }: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && <DialogLayer {...layer} />}
      </AnimatePresence>
    </RDialog.Root>
  )
}

/** Mounted while the dialog is open (and through its exit), so it knows what had focus before it opened. */
function DialogLayer({ title, description, children, footer, onCloseAutoFocus }: Omit<DialogProps, 'open' | 'onOpenChange'>) {
  watchDialogFocus()
  const returnFocus = useReturnFocus(true, onCloseAutoFocus)
  // Focus sent into the dialog as it mounted (an autoFocus field) wins over Radix's first button.
  const focusOnOpen = (event: Event) => {
    const field = dialogFocusRequest
    if (!field?.isConnected || !(event.currentTarget as Node | null)?.contains(field)) return
    event.preventDefault()
    field.focus({ preventScroll: true })
  }
  return (
    <RDialog.Portal forceMount>
      <RDialog.Overlay asChild forceMount>
        <motion.div className="fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      </RDialog.Overlay>
      <RDialog.Content asChild forceMount onOpenAutoFocus={focusOnOpen} onCloseAutoFocus={returnFocus}>
        <motion.div
          className="fixed left-1/2 top-[18vh] z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl bg-elevated p-5 shadow-lg outline-none"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.985 }}
          transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
        >
          <div className="flex items-start justify-between gap-4">
            <RDialog.Title className="text-[15px] font-semibold text-fg">{title}</RDialog.Title>
            <RDialog.Close className="-mr-1.5 -mt-1 grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg" aria-label={tr('关闭')}><X className="size-4" /></RDialog.Close>
          </div>
          {description && <RDialog.Description className="mt-1.5 text-[13px] leading-5 text-fg-3">{description}</RDialog.Description>}
          {children && <div className="mt-4">{children}</div>}
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </motion.div>
      </RDialog.Content>
    </RDialog.Portal>
  )
}

/* ---------------------------------------------------------------- Toaster */

export function Toaster() {
  const toasts = useUi(s => s.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.16 } }}
            transition={{ type: 'spring', stiffness: 480, damping: 36 }}
            className={cn(
              'pointer-events-auto max-w-[min(520px,calc(100vw-32px))] rounded-xl px-3.5 py-2 text-[13px] leading-5 shadow-lg',
              t.tone === 'danger' ? 'bg-danger text-white' : 'bg-[#1b2130] text-white dark:bg-[#e9ebf0] dark:text-[#121418]',
            )}
          >
            <span className="flex items-center gap-3">
              <span>{t.text}</span>
              {t.action && <button type="button" onClick={t.action.run} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium underline-offset-2 hover:underline">{t.action.label}</button>}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
