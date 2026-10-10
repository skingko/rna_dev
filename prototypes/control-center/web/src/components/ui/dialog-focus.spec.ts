import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Dialog as RDialog, Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { openTab, resetSidePanel } from '@/store/side-panel-store'
import { usePanels } from '@/components/settings/panel-store'
import { RenameDialog } from '@/components/projects/EntityDialogs'
import { SessionMenuItems } from '@/components/projects/EntityMenus'
import { CleanupDialog } from '@/components/tasks/CleanupDialog'
import { SaveLayoutDialog } from '@/components/workspace/SaveLayoutDialog'
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger, returnFocusTargets, useReturnFocus } from './overlays'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

const transport: Transport = {
  kind: 'live',
  async request<T>(): Promise<T> { return {} as T },
  openStream() { throw new Error('unused') },
}

let root: Root, host: HTMLDivElement, previous: Transport
const appState = useApp.getState()
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  resetSidePanel(); useUi.setState({ toasts: [] }); usePanels.setState({ rename: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); setTransport(previous)
  useApp.setState(appState, true)
})

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async (node: ReactNode) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await flush() }
const escape = async () => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await flush()
}
const dialog = () => document.querySelector('[role="dialog"]')
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === label)!

/** A button that opens a plain app Dialog; `onCloseAutoFocus` and `onClose` reach the dialog. */
function Opener({ onCloseAutoFocus, onClose, children }: { onCloseAutoFocus?: (event: Event) => void; onClose?: () => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return createElement('div', null,
    createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '打开'),
    children,
    createElement(Dialog, { open, onOpenChange: setOpen, title: '标题', onCloseAutoFocus, footer: createElement('button', { type: 'button', onClick: () => { setOpen(false); onClose?.() } }, '完成') }))
}
const opener = () => document.querySelector<HTMLButtonElement>('[data-opener]')!
const open = async () => {
  opener().focus()
  await act(async () => { opener().click() }); await flush()
  expect(dialog()).not.toBeNull()
  expect(dialog()!.contains(document.activeElement)).toBe(true)
}

describe('Dialog returns focus to what opened it', () => {
  it('closing with Escape, the close button or an action puts focus back on the button that opened it', async () => {
    await show(createElement(Opener))
    await open(); await escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener())

    await open()
    await act(async () => { dialog()!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click() }); await flush()
    expect(document.activeElement).toBe(opener())

    await open()
    await act(async () => { button('完成').click() }); await flush()
    expect(document.activeElement).toBe(opener())
  })

  it('leaves focus where the dialog’s action put it, and lets the caller place it', async () => {
    let other: HTMLInputElement | null = null
    await show(createElement(Opener, { onClose: () => other?.focus() }, createElement('input', { 'aria-label': '别处', ref: (el: HTMLInputElement | null) => { other = el } })))
    await open()
    await act(async () => { button('完成').click() })
    await act(async () => { other!.focus() }); await flush()
    expect(document.activeElement).toBe(other)

    await act(async () => { root.unmount() }); root = createRoot(host)
    const placed: Event[] = []
    await show(createElement(Opener, { onCloseAutoFocus: event => { placed.push(event); event.preventDefault() } }))
    await open(); await escape()
    expect(placed).toHaveLength(1)
    expect(document.activeElement).not.toBe(opener())
  })

  it('a dialog picked from a menu returns to the menu’s button; nothing focused gives nothing to return to', async () => {
    const trigger = document.createElement('button'); trigger.id = 'menu-trigger'
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', 'menu-trigger')
    const item = document.createElement('div'); item.setAttribute('role', 'menuitem'); item.tabIndex = -1
    menu.append(item); host.append(trigger, menu)
    expect(returnFocusTargets(item)).toEqual([item, trigger])
    expect(returnFocusTargets(trigger)).toEqual([trigger])
    expect(returnFocusTargets(document.body)).toEqual([])
    expect(returnFocusTargets(null)).toEqual([])
    trigger.remove(); menu.remove()
  })

  it('through a real menu: the item is gone when the dialog closes, so the menu’s button takes focus', async () => {
    function MenuOpened() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement(Menu, null,
          createElement(MenuTrigger, { asChild: true }, createElement('button', { type: 'button', 'data-menu-trigger': '' }, '更多')),
          createElement(MenuContent, null, createElement(MenuItem, { onSelect: () => setOpen(true), children: '确认…' }))),
        createElement(Dialog, { open, onOpenChange: setOpen, title: '确认' }))
    }
    await show(createElement(MenuOpened))
    const trigger = document.querySelector<HTMLButtonElement>('[data-menu-trigger]')!
    trigger.focus()
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) }); await flush()
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === '确认…')!.click() }); await flush()
    expect(dialog()).not.toBeNull()
    await escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('a row’s ⋯ shown only while its row has focus: the row takes focus, then ⋯ again; a ⋯ that stays hidden leaves focus on the row', async () => {
    function Row({ alwaysHidden = false }: { alwaysHidden?: boolean }) {
      const [open, setOpen] = useState(false)
      return createElement('li', { 'data-row': '' },
        createElement('button', { type: 'button', 'data-row-button': '' }, '会话'),
        // Stands in for `hidden group-focus-within:grid`: the browser cannot focus it until its row holds focus.
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true), ref: (el: HTMLButtonElement | null) => {
          if (!el) return
          el.focus = function (options?: FocusOptions) { if (!alwaysHidden && el.closest('li')!.contains(document.activeElement)) HTMLElement.prototype.focus.call(this, options) }
        } }, '⋯'),
        createElement(Dialog, { open, onOpenChange: setOpen, title: '重命名' }))
    }
    const rowButton = () => document.querySelector<HTMLButtonElement>('[data-row-button]')!
    for (const alwaysHidden of [false, true]) {
      await act(async () => { root.unmount() }); root = createRoot(host)
      await show(createElement(Row, { alwaysHidden }))
      rowButton().focus(); opener().focus()
      expect(document.activeElement).toBe(alwaysHidden ? rowButton() : opener())
      await act(async () => { opener().click() }); await flush()
      expect(dialog()!.contains(document.activeElement)).toBe(true)
      await escape()
      expect(document.activeElement).toBe(alwaysHidden ? rowButton() : opener())
    }
  })

  it('a field focus was sent to as the dialog mounted keeps it, even when a closing menu pulled focus straight back', async () => {
    // Chromium order when a dialog opens from a menu item: React focuses the autoFocus field, the menu's focus trap
    // reacts to the focusout (whose relatedTarget names the field) and takes focus back before the field's focusin.
    function Stolen() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '打开'),
        createElement(Dialog, { open, onOpenChange: setOpen, title: '重命名',
          children: createElement('input', { 'aria-label': '名称', ref: (el: HTMLInputElement | null) => { if (el) document.body.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: el })) } }) }))
    }
    await show(createElement(Stolen))
    opener().focus()
    await act(async () => { opener().click() }); await flush()
    expect(document.activeElement).toBe(dialog()!.querySelector('input[aria-label="名称"]'))
  })
})

describe('useReturnFocus for dialogs built on Radix directly (settings, permissions)', () => {
  it('captures what had focus each time the dialog opens and returns focus there on close', async () => {
    function Raw() {
      const [open, setOpen] = useState(false)
      const returnFocus = useReturnFocus(open)
      return createElement('div', null,
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '设置'),
        createElement('button', { type: 'button', 'data-other': '', onClick: () => setOpen(true) }, '权限'),
        createElement(RDialog.Root, { open, onOpenChange: setOpen },
          createElement(RDialog.Portal, null,
            createElement(RDialog.Content, { onCloseAutoFocus: returnFocus, 'aria-describedby': undefined },
              createElement(RDialog.Title, null, '设置'),
              createElement('button', { type: 'button' }, '里面')))))
    }
    await show(createElement(Raw))
    await open(); await escape()
    expect(document.activeElement).toBe(opener())
    const other = document.querySelector<HTMLButtonElement>('[data-other]')!
    other.focus()
    await act(async () => { other.click() }); await flush()
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    await escape()
    expect(document.activeElement).toBe(other)
  })
})

describe('the app’s dialogs keep their behaviour and give focus back', () => {
  it('重命名 from a session menu: the name field takes focus (not 关闭, though the closing menu takes it back for a moment), and closing returns it to the menu’s button', async () => {
    useApp.setState({ sessionIndex: { s1: { id: 's1', title: '旧名字', status: 'idle', projectId: null } } as never })
    await show(createElement('div', null,
      createElement(Menu, null,
        createElement(MenuTrigger, { asChild: true }, createElement('button', { type: 'button', 'data-menu-trigger': '' }, '会话操作')),
        createElement(MenuContent, null, createElement(SessionMenuItems, { sessionId: 's1' }))),
      createElement(RenameDialog)))
    const trigger = document.querySelector<HTMLButtonElement>('[data-menu-trigger]')!
    trigger.focus()
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) }); await flush()
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === '重命名')!.click() }); await flush()
    const input = dialog()!.querySelector<HTMLInputElement>('input')!
    expect(input.value).toBe('旧名字')
    expect(document.activeElement).toBe(input)
    await escape()
    expect(usePanels.getState().rename).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('保存当前布局…: the name field takes focus, and closing gives it back to ⋯ (the group menu focuses ⋯ before opening it)', async () => {
    openTab({ type: 'tasks' })
    function Save() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '⋯'),
        createElement(SaveLayoutDialog, { open, onOpenChange: setOpen }))
    }
    await show(createElement(Save))
    opener().focus()
    await act(async () => { opener().click() }); await flush()
    const input = document.querySelector<HTMLInputElement>('[data-save-layout] input')!
    expect(input.value).toBe('布局 1')
    expect(document.activeElement).toBe(input)
    await escape()
    expect(document.querySelector('[data-save-layout]')).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  it('清理 confirms from its button and gives focus back to it', async () => {
    function Cleanup() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '清理'),
        createElement(CleanupDialog, { open, onClose: () => setOpen(false), rows: [] }))
    }
    await show(createElement(Cleanup))
    opener().focus()
    await act(async () => { opener().click() }); await flush()
    expect(dialog()?.textContent).toContain('清理没做完的事')
    await escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener())
  })
})
