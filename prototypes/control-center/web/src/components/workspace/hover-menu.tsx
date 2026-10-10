/**
 * A menu that a strip button shows on hover (after Claude's layout popover):
 * resting the pointer on the button opens it after a short delay; it stays
 * while the pointer is on the button or the menu and closes shortly after it
 * leaves both. Clicking the button still does the button's own thing (and
 * puts the menu away). Hovering never takes the keyboard.
 *
 * From the keyboard: ArrowDown on the button, or Enter / Space / ArrowDown on
 * the menu affordance that shows when tabbed to (a split button's second
 * half), opens it with focus on its first item; the arrows, Home and End move
 * between items; Esc and Tab close it and give the keyboard back to the
 * button. Esc never reaches the workspace (which would hide the panels).
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Rest this long on the button before the menu opens; leave both this long before it closes. */
export const HOVER_OPEN_DELAY = 280
export const HOVER_CLOSE_DELAY = 220
/** Moving straight from one hover menu to another opens it at once (like tooltips' skip delay), closing the first. */
const SKIP_DELAY = 400
const openMenus = new Set<() => void>()
let warmUntil = 0
const warm = () => openMenus.size > 0 || Date.now() < warmUntil

/** What the menu's items are marked with (enabled ones take the arrow keys' focus). */
export const ITEM_ATTR = 'data-hover-item'
const ITEMS = `[${ITEM_ATTR}]:not([disabled]):not([aria-disabled="true"])`

export interface HoverMenuApi {
  /** Put the menu away (after an item ran); from the keyboard, the button gets the keyboard back. */
  close: () => void
}

export interface HoverMenuProps {
  /** `data-hover-menu` on the wrapper and the menu (tests, styling). */
  name: string
  /** The menu's accessible name, also the affordance's label. */
  label: string
  /** The strip button: it keeps its own click. */
  children: ReactNode
  content: (api: HoverMenuApi) => ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}

export function HoverMenu({ name, label, children, content, align = 'end', className }: HoverMenuProps) {
  const [open, setOpen] = useState(false)
  const shown = useRef(false)
  shown.current = open
  const id = useId()
  const wrapper = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Opened from the keyboard: focus goes into the menu, and back to the button when it closes that way.
  const keyboard = useRef(false)
  const returnFocus = useRef(false)

  const clear = () => { clearTimeout(timer.current); timer.current = undefined }

  const button = () => wrapper.current?.querySelector<HTMLElement>('button:not([data-hover-affordance])') ?? null
  const first = () => menu.current?.querySelector<HTMLElement>(ITEMS) ?? null
  /**
   * Put the menu away; `focusButton` gives the keyboard back to the button when it had nowhere else to be (null: as
   * an Esc decided). Focus inside the menu always goes back to the button, however it closes (the pointer leaving a
   * menu opened from the keyboard, another hover menu taking over, an item clicked): it would otherwise fall to the
   * page as the menu unmounts. At once, not when the menu has faded out.
   */
  const hide = useCallback((focusButton: boolean | null) => {
    clear()
    const focus = focusButton ?? returnFocus.current
    returnFocus.current = false
    if (shown.current) { shown.current = false; setOpen(false) }
    const active = document.activeElement
    if (menu.current?.contains(active) || (focus && (!active || active === document.body))) button()?.focus()
  }, [])
  const away = useCallback(() => hide(false), [hide])
  const show = useCallback((byKeyboard: boolean) => {
    clear()
    keyboard.current = byKeyboard
    returnFocus.current = false
    if (shown.current) { if (byKeyboard) first()?.focus(); return }
    for (const other of [...openMenus]) if (other !== away) other()
    shown.current = true
    setOpen(true)
  }, [away])
  // Known as open while it is, so another one opening puts it away at once.
  useEffect(() => {
    if (!open) return
    openMenus.add(away)
    return () => { openMenus.delete(away) }
  }, [open, away])
  useEffect(() => () => clear(), [])

  const later = (fn: () => void, delay: number) => { clear(); timer.current = setTimeout(fn, delay) }
  const mouse = (e: PointerEvent) => e.pointerType === 'mouse'
  const onEnter = (e: PointerEvent) => {
    if (!mouse(e)) return
    if (shown.current) { clear(); return }
    if (e.buttons) return // a drag passing over
    later(() => show(false), warm() ? 0 : HOVER_OPEN_DELAY)
  }
  const onLeave = (e: PointerEvent) => {
    if (!mouse(e)) return
    if (shown.current) later(() => { warmUntil = Date.now() + SKIP_DELAY; hide(false) }, HOVER_CLOSE_DELAY)
    else clear()
  }

  const api: HoverMenuApi = { close: () => hide(keyboard.current) }

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); show(true) }
  }

  const onMenuKey = (e: KeyboardEvent) => {
    // Esc also when an item's tooltip took it first (that layer is the highest): one press puts the menu away.
    if (e.key === 'Escape') { e.preventDefault(); hide(true); return }
    if (e.key === 'Tab') { e.preventDefault(); hide(true); return }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => { e.preventDefault(); items[(index + items.length) % items.length].focus() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(at + 1)
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(at < 0 ? items.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
  }

  return (
    <Popover.Root open={open} onOpenChange={next => (next ? show(keyboard.current) : hide(null))} modal={false}>
      <Popover.Anchor asChild>
        <span ref={wrapper} className={cn('relative inline-flex shrink-0 items-center', className)} data-hover-menu={name}
          onPointerEnter={onEnter} onPointerLeave={onLeave} onPointerDown={() => clear()} onKeyDown={onButtonKey}
          // The button's own click puts the menu away; the affordance's opens it.
          onClickCapture={e => { if (!(e.target as HTMLElement).closest('[data-hover-affordance]')) hide(false) }}>
          {children}
          <button type="button" data-hover-affordance aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
            onClick={() => (shown.current ? hide(false) : show(true))}
            // No width until tabbed to: then a narrow chevron beside the button.
            className="grid h-7 w-0 shrink-0 place-items-center overflow-hidden rounded-md text-fg-3 opacity-0 outline-none focus-visible:w-4 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] [&_svg]:size-3 [&_svg]:shrink-0">
            <ChevronDown aria-hidden />
          </button>
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content ref={menu} id={id} role="menu" aria-label={label} data-hover-menu={name} align={align} side="bottom" sideOffset={6} collisionPadding={10}
          className="menu-content z-50 min-w-44 rounded-xl bg-elevated p-1.5 text-[13px] text-fg shadow-lg outline-none"
          onOpenAutoFocus={e => { e.preventDefault(); if (keyboard.current) first()?.focus() }}
          onCloseAutoFocus={e => e.preventDefault()}
          // Esc closes the menu (Radix keeps the key from the workspace); the keyboard goes back to the button when it was in the menu.
          onEscapeKeyDown={() => { returnFocus.current = keyboard.current || Boolean(menu.current?.contains(document.activeElement)) }}
          onFocusOutside={e => { if (wrapper.current?.contains(e.target as Node)) e.preventDefault() }}
          onPointerEnter={e => { if (mouse(e)) clear() }} onPointerLeave={onLeave} onKeyDown={onMenuKey}>
          {content(api)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
