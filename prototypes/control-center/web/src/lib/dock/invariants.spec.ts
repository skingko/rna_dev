import { describe, expect, it } from 'vitest'
import { MAIN, type Binding, type Edge, type LayoutState, type ScopeCtx } from './types'
import { groupIds, layoutProblems, treeIds } from './tree'
import {
  activateTab, closeGroup, closeTab, closeTabs, focusGroup, maximize, minimize, moveGroup, moveTab, moveTabToward, openTab, resize,
  resizeDivider, splitGroup, toggleCollapsed, type Change, type DockPolicy,
} from './actions'
import { arrange, type Preset } from './arrange'
import { computeRects } from './geometry'
import { Sequencer } from './sequence'
import { A, B, prng, Q, roundTrips, startLayout, tab, testPolicy, type TestTab } from './testing'

const TYPES = ['launcher', 'tool', 'file', 'browser', 'terminal', 'tasks', 'review']
const EDGES: Edge[] = ['left', 'right', 'top', 'bottom']
const PRESETS: Preset[] = ['sidebar', 'bottom', 'right-stacked', 'three-column', 'fill']
const CTXS: ScopeCtx[] = [A, B, Q, {}]

function invariants(state: LayoutState<TestTab>) {
  expect(layoutProblems(state, true)).toEqual([])
  expect(treeIds(state).filter(id => state.nodes[id].kind === 'main')).toEqual([MAIN])
  for (const node of Object.values(state.nodes)) {
    if (node.kind === 'split') {
      expect(node.children.length).toBeGreaterThanOrEqual(2)
      expect(Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9)
    }
    if (node.kind === 'group') {
      for (const id of node.tabIds) expect(state.tabs[id]).toBeDefined()
      if (groupIds(state).length > 1) expect(node.tabIds.length).toBeGreaterThan(0)
    }
  }
}

function step(state: LayoutState<TestTab>, rand: ReturnType<typeof prng>, policy: DockPolicy<TestTab>, n: number): Change<TestTab> {
  const ctx = rand.pick(CTXS)
  const groups = groupIds(state)
  const tabs = Object.keys(state.tabs)
  const anyTab = () => rand.pick(tabs)
  const anyGroup = () => rand.pick(groups)
  const anyNode = () => rand.pick(treeIds(state))
  const binding = (): Binding => rand.pick<Binding>(['workspace', { session: rand.pick(['A', 'B', 'C']) }, { project: rand.pick(['P', 'Q']) }])
  const fresh = () => tab(`t${n}`, rand.pick(TYPES), binding(), rand.next() < 0.3 ? { key: `k${rand.int(6)}` } : {})
  const roll = rand.int(19)
  if (roll < 5 || !tabs.length) {
    const target = rand.next() < 0.6 || !groups.length ? 'auto' as const : rand.next() < 0.5 ? anyGroup() : { edge: rand.pick(EDGES), of: anyNode() }
    return openTab(state, fresh(), target, ctx, policy, { background: rand.next() < 0.2 })
  }
  switch (roll) {
    case 5: return closeTab(state, anyTab(), ctx, policy)
    case 6: return closeTabs(state, anyTab(), rand.pick(['others', 'left', 'right', 'all'] as const), ctx, policy)
    case 7: return moveTab(state, anyTab(), anyGroup(), ctx, policy, rand.next() < 0.5 ? rand.int(5) : undefined)
    case 8: return moveTab(state, anyTab(), { edge: rand.pick(EDGES), of: anyNode() }, ctx, policy)
    case 9: return moveTabToward(state, anyTab(), rand.pick(EDGES), ctx, policy)
    case 10: return groups.length ? moveGroup(state, anyGroup(), rand.pick(EDGES), policy) : toggleCollapsed(state)
    case 11: return groups.length ? splitGroup(state, anyGroup(), rand.pick(['right', 'down'] as const), ctx, policy, rand.next() < 0.5 ? anyTab() : undefined) : toggleCollapsed(state)
    case 12: return groups.length && rand.next() < 0.4 ? closeGroup(state, anyGroup(), policy) : activateTab(state, anyTab(), ctx)
    case 13: {
      const splits = treeIds(state).filter(id => state.nodes[id].kind === 'split')
      if (!splits.length) return focusGroup(state, anyGroup())
      const id = rand.pick(splits)
      const node = state.nodes[id]
      return resize(state, id, node.kind === 'split' ? node.children.map(() => rand.next() + 0.01) : [])
    }
    case 14: {
      const geometry = computeRects(state, { width: 600 + rand.int(1600), height: 400 + rand.int(800) })
      return geometry.dividers.length ? resizeDivider(state, geometry, rand.pick(geometry.dividers), rand.int(600) - 300) : toggleCollapsed(state)
    }
    case 15: return groups.length ? maximize(state, rand.next() < 0.8 ? anyGroup() : null) : toggleCollapsed(state)
    case 16: return groups.length ? minimize(state, anyGroup(), rand.next() < 0.7) : toggleCollapsed(state)
    case 17: return arrange(state, rand.pick(PRESETS), { mint: policy.mint, size: { width: 800 + rand.int(1400), height: 500 + rand.int(700) }, seed: rand.next() < 0.5 ? policy.seed : undefined })
    default: return toggleCollapsed(state)
  }
}

describe('random op sequences keep the layout sound', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const rand = prng(seed)
      const policy = testPolicy({
        seed: rand.next() < 0.5 ? id => tab(id, 'launcher') : undefined,
        keepLastGroup: seed % 3 !== 0,
        cap: { max: 4 + rand.int(8), lightweight: t => ['launcher', 'tool', 'file'].includes(t.type) },
      })
      const start = startLayout(seed % 2 === 0)
      const seq = new Sequencer(start, 10_000)
      let applied = 0
      for (let n = 0; n < 250; n++) {
        const before = seq.state
        const change = step(before, rand, policy, n)
        if (!change.ops.length) expect(change.state).toBe(before)
        else applied++
        roundTrips(before, change)
        invariants(change.state)
        for (const closed of change.closed) expect(change.state.tabs[closed.id]).toBeUndefined()
        seq.commit(change)
        const width = 300 + rand.int(2000), height = 200 + rand.int(1200)
        const geometry = computeRects(change.state, { width, height })
        for (const rect of Object.values(geometry.rects)) {
          expect(Number.isFinite(rect.x + rect.y + rect.width + rect.height)).toBe(true)
          expect(rect.x).toBeGreaterThanOrEqual(0)
          expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1e-6)
          expect(rect.y + rect.height).toBeLessThanOrEqual(height + 1e-6)
        }
        if (!geometry.compact && geometry.rects[MAIN].width >= 420) expect(geometry.rects[MAIN].height).toBeGreaterThan(0)
      }
      expect(applied).toBeGreaterThan(150) // the sequence really exercised the engine
      const end = seq.state
      while (seq.undo());
      expect(seq.state).toEqual(start)
      while (seq.redo());
      expect(seq.state).toEqual(end)
    })
  }
})
