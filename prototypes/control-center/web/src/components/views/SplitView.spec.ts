import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { SplitView } from './kit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true

/** A list of two rows; clicking one opens its detail. `inner` adds a field whose Esc is its own, and a dialog. */
function Harness() {
  const [open, setOpen] = useState<string | null>(null)
  return createElement(SplitView, {
    detailLabel: open ?? '', onClose: () => setOpen(null),
    detail: open ? createElement('div', null,
      createElement('p', null, `detail ${open}`),
      createElement('input', { 'aria-label': 'edit', onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault() } }),
      createElement('div', { role: 'dialog' }, createElement('button', { type: 'button' }, 'in dialog'))) : null,
    list: createElement('div', null, ['a', 'b'].map(id => createElement('button', { key: id, type: 'button', 'data-row': id, onClick: () => setOpen(id) }, id))),
  })
}

let root: Root, host: HTMLDivElement
const outside = document.createElement('button')
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host, outside); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); outside.remove(); vi.unstubAllGlobals() })

const render = () => act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(Harness))) })
const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-row="${id}"]`)!
const detail = () => host.querySelector<HTMLElement>('[data-split-detail]')
const escape = (target: Element) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}
const openRow = async (id: string) => { row(id).focus(); await act(async () => { row(id).click() }) }
const frame = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })

describe('SplitView (design 4.3)', () => {
  it('lays the detail out inside its own container, never fixed over the app', async () => {
    await render()
    await openRow('a')
    const pane = detail()!
    expect(pane.className).toContain('absolute')
    expect(pane.className).toContain('@[640px]/split:static')
    expect(pane.className).not.toMatch(/(^|\s)(fixed|md:|max-md:)/)
    expect(host.querySelector('[data-split-view]')!.className).toContain('@container/split')
  })

  it('closes on Esc only when focus is inside it, takes the key, and gives focus back to the row', async () => {
    await render()
    await openRow('a')
    // Focus elsewhere in the app: the key is not ours (the workspace may use it).
    outside.focus()
    expect(escape(outside).defaultPrevented).toBe(false)
    await frame()
    expect(detail()).not.toBeNull()

    // Focus on the row that opened it: closed, the key taken (the workspace sees defaultPrevented and keeps its panel).
    row('a').focus()
    const seen: boolean[] = []
    const workspace = (e: KeyboardEvent) => seen.push(e.defaultPrevented)
    window.addEventListener('keydown', workspace)
    try {
      expect(escape(row('a')).defaultPrevented).toBe(true)
    } finally { window.removeEventListener('keydown', workspace) }
    expect(seen).toEqual([true])
    await frame()
    expect(detail()).toBeNull()
    expect(document.activeElement).toBe(row('a'))
  })

  it('leaves Esc to a field or dialog inside the detail that uses it', async () => {
    await render()
    await openRow('b')
    const input = host.querySelector<HTMLInputElement>('input[aria-label="edit"]')!
    input.focus()
    escape(input)
    await frame()
    expect(detail()).not.toBeNull()
    const inDialog = [...host.querySelectorAll('button')].find(button => button.textContent === 'in dialog')!
    inDialog.focus()
    expect(escape(inDialog).defaultPrevented).toBe(false)
    await frame()
    expect(detail()).not.toBeNull()
    // Anywhere else inside: closes.
    const text = host.querySelector('p')!
    escape(text)
    await frame()
    expect(detail()).toBeNull()
  })

  it('in a narrow container the detail covers the list, takes focus, and the list stays out of reach until it closes', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() { this.callback([{ contentRect: { width: 300 } }]) }
      disconnect() {}
    })
    await render()
    await openRow('a')
    expect(detail()!.dataset.splitDetail).toBe('over')
    expect(document.activeElement).toBe(detail())
    const list = row('a').closest('[inert]')
    expect(list).not.toBeNull()
    escape(detail()!)
    expect(row('a').closest('[inert]')).toBeNull()
    await frame()
    expect(detail()).toBeNull()
    expect(document.activeElement).toBe(row('a'))
  })
})
