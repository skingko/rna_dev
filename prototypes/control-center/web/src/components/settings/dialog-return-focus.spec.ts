/**
 * The dialogs built on Radix directly (PanelDialog and everything on it, 设置, 项目权限) have no Dialog.Trigger:
 * closing one gives focus back to what opened it (useReturnFocus), not to the page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { PermissionsDialog } from '@/components/projects/PermissionsDialog'
import { PanelDialog } from './PanelDialog'
import { closeSettings, openPermissions, openSettings, usePanels } from './panel-store'
import { SettingsDialog } from './SettingsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true
// jsdom has no element scrolling (设置 scrolls its pane to the top on every tab).
Element.prototype.scrollTo ??= function scrollTo() {}

// Nothing these dialogs read matters here: every request fails, which they show as an error inside.
const transport: Transport = {
  kind: 'live',
  async request<T>(): Promise<T> { throw new Error('offline') },
  openStream() { throw new Error('unused') },
}

let root: Root, host: HTMLDivElement, previous: Transport
const appState = useApp.getState()
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  usePanels.setState({ permissions: null, settings: null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove(); setTransport(previous)
  usePanels.setState({ permissions: null, settings: null })
  if (location.hash) history.replaceState(null, '', location.pathname)
  useApp.setState(appState, true)
})

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async (node: ReactNode) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, node)) }); await flush() }
const dialog = () => document.querySelector('[role="dialog"]')
const escape = async () => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  await flush()
}
const opener = () => document.querySelector<HTMLButtonElement>('[data-opener]')!
/** Focus the opener and press it; the dialog opens with focus inside. */
const press = async () => {
  opener().focus()
  await act(async () => { opener().click() }); await flush()
  expect(dialog()).not.toBeNull()
  expect(dialog()!.contains(document.activeElement)).toBe(true)
}

describe('dialogs built on Radix directly give focus back to what opened them', () => {
  it('PanelDialog (记忆, 能力, 归档, 新建项目, 项目设置): Escape and its close button return to the opener', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return createElement('div', null,
        createElement('button', { type: 'button', 'data-opener': '', onClick: () => setOpen(true) }, '打开'),
        createElement(PanelDialog, { open, onClose: () => setOpen(false), title: '面板', children: createElement('p', null, '内容') }))
    }
    await show(createElement(Host))
    await press(); await escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener())

    await press()
    await act(async () => { dialog()!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click() }); await flush()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  it('设置 and 项目权限, opened through their store: Escape returns to the button that opened them', async () => {
    useApp.setState({ projects: { p1: { id: 'p1', name: '水墨飞鸟', workspacePath: '/w/p1' } } as never })
    await show(createElement('div', null,
      createElement('button', { type: 'button', 'data-opener': '', onClick: () => openSettings('general') }, '设置'),
      createElement('button', { type: 'button', 'data-permissions': '', onClick: () => openPermissions('p1') }, '权限'),
      createElement(SettingsDialog), createElement(PermissionsDialog)))
    await press(); await escape()
    expect(usePanels.getState().settings).toBeNull()
    expect(document.activeElement).toBe(opener())

    const permissions = document.querySelector<HTMLButtonElement>('[data-permissions]')!
    permissions.focus()
    await act(async () => { permissions.click() }); await flush()
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    await escape()
    expect(usePanels.getState().permissions).toBeNull()
    expect(document.activeElement).toBe(permissions)
    act(() => closeSettings())
  })
})
