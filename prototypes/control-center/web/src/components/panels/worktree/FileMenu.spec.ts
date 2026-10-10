import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useUi } from '@/store/ui-store'
import { desktopErrorText, desktopRevealPath, type RnaDesktop } from '@/lib/desktop'
import { FileMenu } from './FileMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); useUi.setState({ toasts: [] }) })
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.rnaDesktop; useUi.setState({ toasts: [] }) })

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(el => el.textContent === label)
const toasts = () => useUi.getState().toasts.map(row => [row.text, row.tone])
async function menu(props: { workspace?: string; deleted?: boolean } = {}) {
  await act(async () => {
    root.render(createElement(FileMenu, { path: 'src/app/main.ts', workspace: '/w/p1', projectId: 'p1', ...props, children: createElement('button', { type: 'button', 'data-row': '' }, 'main.ts') }))
  })
  await act(async () => { host.querySelector('[data-row]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  await flush()
}

describe('在访达中显示 (desktop reveal bridge)', () => {
  it('shows once the desktop shell offers revealPath, and asks it for the file’s absolute path', async () => {
    const revealPath = vi.fn(async () => ({ revealed: true }))
    window.rnaDesktop = { revealPath }
    await menu()
    await act(async () => { item('在访达中显示')!.click() }); await flush()
    expect(revealPath).toHaveBeenCalledWith('/w/p1/src/app/main.ts')
    expect(toasts()).toEqual([])
  })

  it('says why the shell refused, without Electron’s wrapper; a bare failure gets the general line', async () => {
    window.rnaDesktop = { revealPath: async () => { throw new Error("Error invoking remote method 'rna:reveal-path': Error: 这个文件已经不在了。") } }
    await menu()
    await act(async () => { item('在访达中显示')!.click() }); await flush()
    expect(toasts()).toEqual([['这个文件已经不在了。', 'danger']])

    useUi.setState({ toasts: [] })
    window.rnaDesktop = { revealPath: () => { throw new Error('') } }
    await menu()
    await act(async () => { item('在访达中显示')!.click() }); await flush()
    expect(toasts()).toEqual([['没能在访达中显示这个文件。', 'danger']])
  })

  it('is absent in the browser and without a workspace, and disabled for a deleted file', async () => {
    await menu()
    expect(item('在访达中显示')).toBeUndefined()
    window.rnaDesktop = { revealPath: async () => ({}) }
    await menu({ workspace: undefined })
    expect(item('在访达中显示')).toBeUndefined()
    await menu({ deleted: true })
    expect(item('在访达中显示')!.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('desktop bridge helpers', () => {
  it('desktopRevealPath: null without the bridge; a synchronous throw becomes a rejection', async () => {
    expect(desktopRevealPath()).toBeNull()
    window.rnaDesktop = { revealPath: (() => { throw new Error('x') }) as RnaDesktop['revealPath'] }
    await expect(desktopRevealPath()!('/a')).rejects.toThrow('x')
  })

  it('desktopErrorText keeps only the main process’s reason', () => {
    expect(desktopErrorText(new Error("Error invoking remote method 'rna:reveal-path': Error: Only files inside a project folder can be shown."))).toBe('Only files inside a project folder can be shown.')
    expect(desktopErrorText(new Error('只能显示项目目录里的文件。'))).toBe('只能显示项目目录里的文件。')
    expect(desktopErrorText(null)).toBe('')
    expect(desktopErrorText('Error: 文本')).toBe('文本')
  })
})
