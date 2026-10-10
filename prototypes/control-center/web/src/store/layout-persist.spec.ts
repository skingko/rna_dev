import { afterEach, describe, expect, it, vi } from 'vitest'
import { counterMint, defaultLayout, type DockTab } from '@/lib/dock'
import { createLayoutWriter, lastTouchedScope, loadLayout, serializeWorkspace, storedDockWidth, WORKSPACE_KEY } from './layout-persist'

afterEach(() => { vi.useRealTimers() })

const memory = (entries: Record<string, string> = {}) => {
  const data = { ...entries }
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value } }
}
const parse = (value: unknown) => (value && typeof value === 'object' && typeof (value as DockTab).id === 'string' ? value as DockTab : null)

describe('layout persistence (design 1.6)', () => {
  it('writes once, 120 ms after the last change; flush writes now; storage errors are ignored', () => {
    vi.useFakeTimers()
    const store = memory()
    let n = 0
    const writer = createLayoutWriter(() => `v${++n}`, 120, () => store)
    writer.schedule(); vi.advanceTimersByTime(100); writer.schedule(); vi.advanceTimersByTime(100)
    expect(store.data[WORKSPACE_KEY]).toBeUndefined()
    vi.advanceTimersByTime(30)
    expect(store.data[WORKSPACE_KEY]).toBe('v1')
    writer.schedule(); writer.flush()
    expect(store.data[WORKSPACE_KEY]).toBe('v2')
    const broken = createLayoutWriter(() => 'x', 120, () => ({ getItem: () => null, setItem: () => { throw new Error('quota') } }))
    expect(() => broken.flush()).not.toThrow()
  })

  it('starts collapsed at the default layout, sized from the stored dock width', () => {
    const loaded = loadLayout<DockTab>({ parseTab: parse, parseV1Tab: parse, identity: () => null, mint: counterMint(), store: memory({ 'rna.dockWidth': '500' }), width: 1000 })
    expect(loaded.source).toBe('default')
    expect(loaded.layout.collapsed).toBe(true)
    expect(Object.values(loaded.layout.nodes).find(node => node.kind === 'split')).toMatchObject({ sizes: [0.5, 0.5] })
    expect(storedDockWidth(memory())).toBe(460)
  })

  it('takes the open flag of the v1 scope touched last, and keeps saved presets when writing', () => {
    expect(lastTouchedScope(JSON.stringify({ panes: { a: { touched: 1 }, b: { touched: 5 }, c: {} } }))).toBe('b')
    expect(lastTouchedScope('{nope')).toBe('global')
    const layout = defaultLayout<DockTab>(counterMint(), 0.3, false)
    const raw = serializeWorkspace(layout, tab => tab, { mine: { root: 'x' } })
    const loaded = loadLayout<DockTab>({ parseTab: parse, parseV1Tab: parse, identity: () => null, mint: counterMint('n'), store: memory({ [WORKSPACE_KEY]: raw }) })
    expect(loaded).toMatchObject({ source: 'v2', presets: { mine: { root: 'x' } } })
    expect(loaded.layout).toEqual(layout)
  })
})
