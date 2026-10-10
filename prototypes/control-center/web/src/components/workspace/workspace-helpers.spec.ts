import { describe, expect, it } from 'vitest'
import { computeRects, counterMint, defaultLayout, MAIN, type DockTab } from '@/lib/dock'
import { layoutScale, nextMounted, toLayout, type MountEntry } from './cells'
import { dropLeaves, dropTargetAt, edgeHighlight, type DropQuery } from './drag'

const KEEP = new Set(['browser', 'terminal', 'agent-browser', 'side-chat'])
const keepAlive = (type: string) => KEEP.has(type)
const run = (prev: readonly MountEntry[], tabs: [string, string][], shown: string[], caps?: Record<string, number>) =>
  nextMounted(prev, { tabs: tabs.map(([id, type]) => ({ id, type })), shown: new Set(shown), keepAlive, caps })

describe('mounted cells (design 1.4)', () => {
  it('mounts a body when shown; ordinary bodies leave when hidden, keep-alive ones stay', () => {
    const tabs: [string, string][] = [['f', 'file'], ['b', 'browser']]
    let log = run([], tabs, ['f'])
    expect(log.map(e => e.id)).toEqual(['f'])
    log = run(log, tabs, ['b'])
    expect(log.map(e => e.id)).toEqual(['b'])
    log = run(log, tabs, ['f'])
    expect(log.map(e => [e.id, e.shown])).toEqual([['b', false], ['f', true]])
  })

  it('keeps mount order (a cell never moves among its siblings) and returns the same log when nothing changed', () => {
    const tabs: [string, string][] = [['a', 'terminal'], ['b', 'browser'], ['c', 'side-chat']]
    let log = run([], tabs, ['c'])
    log = run(log, tabs, ['a'])
    log = run(log, tabs, ['b'])
    expect(log.map(e => e.id)).toEqual(['c', 'a', 'b'])
    expect(run(log, tabs, ['b'])).toBe(log)
  })

  it('drops closed tabs', () => {
    const log = run([], [['a', 'terminal']], ['a'])
    expect(run(log, [], [])).toEqual([])
  })

  it('over a cap, unmounts the body hidden longest, never a shown one', () => {
    const tabs: [string, string][] = [['b1', 'browser'], ['b2', 'browser'], ['b3', 'browser']]
    let log = run([], tabs, ['b1'], { browser: 2 })
    log = run(log, tabs, ['b2'], { browser: 2 })
    log = run(log, tabs, ['b1'], { browser: 2 }) // b2 hidden now, b1 shown again
    log = run(log, tabs, ['b3'], { browser: 2 })
    expect(log.map(e => e.id).sort()).toEqual(['b1', 'b3']) // b2 was hidden longest
    expect(run(log, tabs, ['b1', 'b3'], { browser: 1 }).map(e => e.id).sort()).toEqual(['b1', 'b3'])
  })
})

describe('drop targets (design 1.3)', () => {
  type T = DockTab
  const state = defaultLayout<T>(counterMint(), 0.4, false)
  const group = Object.keys(state.nodes).find(id => state.nodes[id].kind === 'group')!
  const geometry = computeRects(state, { width: 1000, height: 600 })
  const query = (source = 'other'): DropQuery => ({
    geometry,
    leaves: [{ id: MAIN, kind: 'main' }, { id: group, kind: 'group' }],
    strip: 40,
    chips: () => [{ x: 610, y: 6, width: 100, height: 28 }, { x: 712, y: 6, width: 100, height: 28 }],
    source,
  })

  it('a strip offers the slot under the pointer', () => {
    const rect = geometry.rects[group]
    expect(dropTargetAt(query(), rect.x + 5, 20)).toMatchObject({ kind: 'strip', groupId: group, slot: 0 })
    expect(dropTargetAt(query(), 770, 20)).toMatchObject({ kind: 'strip', slot: 2 })
  })

  it('a group’s centre moves the tab in, but not into its own group; the conversation’s centre takes nothing', () => {
    const rect = geometry.rects[group]
    const cx = rect.x + rect.width / 2, cy = 40 + (600 - 40) / 2
    expect(dropTargetAt(query(), cx, cy)).toMatchObject({ kind: 'zone', nodeId: group, zone: 'center' })
    expect(dropTargetAt(query(group), cx, cy)).toBeNull()
    expect(dropTargetAt(query(), geometry.rects[MAIN].width / 2, 300)).toBeNull()
  })

  it('edges split: half of a group, the default share of the conversation', () => {
    const left = dropTargetAt(query(), 10, 300)
    expect(left).toMatchObject({ kind: 'zone', nodeId: MAIN, zone: 'left' })
    expect(left?.kind === 'zone' && left.highlight.width).toBeCloseTo(geometry.rects[MAIN].width * 0.32)
    const rect = geometry.rects[group]
    expect(dropTargetAt(query(), rect.x + rect.width / 2, 590)).toMatchObject({ kind: 'zone', nodeId: group, zone: 'bottom' })
    expect(edgeHighlight({ x: 0, y: 0, width: 100, height: 100 }, 'right', 0.5)).toEqual({ x: 50, y: 0, width: 50, height: 100 })
    // The store's per-axis shares: a group below the conversation is sized by height.
    const below = dropTargetAt({ ...query(), mainShare: axis => (axis === 'column' ? 0.25 : 0.4) }, geometry.rects[MAIN].width / 2, 590)
    expect(below?.kind === 'zone' && below.highlight.height).toBeCloseTo(600 * 0.25)
  })

  it('over a maximized group, its own strip takes the drop, never the conversation underneath', () => {
    const maximized = computeRects({ ...state, maximizedGroup: group }, { width: 1000, height: 600 })
    const covered = { ...query(group), geometry: maximized, leaves: dropLeaves([group], true), chips: () => [{ x: 8, y: 6, width: 100, height: 28 }, { x: 110, y: 6, width: 100, height: 28 }] }
    expect(dropTargetAt(covered, 150, 20)).toMatchObject({ kind: 'strip', groupId: group, slot: 1 })
    expect(dropTargetAt(covered, 500, 300)).toBeNull() // its own centre: nothing to do
    expect(dropLeaves([group], false).map(leaf => leaf.id)).toEqual([MAIN, group])
  })
})

describe('layout pixels under the interface zoom', () => {
  /** An element whose layout box is `layout` wide and whose screen box (zoomed) starts at `left`, `top` with `scale`. */
  const element = (layout: number, scale: number, left = 0, top = 0) => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'offsetWidth', { value: layout })
    el.getBoundingClientRect = () => ({ left, top, x: left, y: top, width: layout * scale, height: 500 * scale, right: left + layout * scale, bottom: top + 500 * scale, toJSON() {} }) as DOMRect
    return el
  }

  it('measures how many screen pixels a layout pixel takes, 1 when they agree or nothing is measured', () => {
    expect(layoutScale(element(1000, 1.25))).toBe(1.25)
    expect(layoutScale(element(1000, 1))).toBe(1)
    expect(layoutScale(element(1000, 1.001))).toBe(1) // rounding noise of a fractional box
    expect(layoutScale(document.createElement('div'))).toBe(1) // jsdom measures nothing
  })

  it('maps client points and boxes into layout pixels from the element’s corner', () => {
    const local = toLayout(element(1000, 1.25, 100, 40))
    expect(local.point(100 + 125, 40 + 250)).toEqual({ x: 100, y: 200 })
    expect(local.rect({ left: 150, top: 40, width: 50, height: 25 } as DOMRect)).toEqual({ x: 40, y: 0, width: 40, height: 20 })
  })
})
