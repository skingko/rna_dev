/** Shared fixtures for the dock specs (not used by app code). */
import { expect } from 'vitest'
import type { Binding, DockTab, LayoutOp, LayoutState, ScopeCtx } from './types'
import { applyOps, replay } from './operations'
import { counterMint, layoutProblems } from './tree'
import type { Change, DockPolicy } from './actions'
import { defaultLayout } from './migrate'

export interface TestTab extends DockTab { key?: string | null; title?: string }

export const tab = (id: string, type = 'tool', binding: Binding = 'workspace', extra: Partial<TestTab> = {}): TestTab =>
  ({ id, type, binding, ...extra })

export const A: ScopeCtx = { sessionId: 'A', projectId: 'P' }
export const B: ScopeCtx = { sessionId: 'B', projectId: 'P' }
export const Q: ScopeCtx = { sessionId: 'C', projectId: 'Q' }

const LIGHT = new Set(['launcher', 'tool', 'file'])

export function testPolicy(overrides: Partial<DockPolicy<TestTab>> = {}): DockPolicy<TestTab> {
  return {
    mint: counterMint(),
    identity: t => t.key ?? null,
    cap: { max: 12, lightweight: t => LIGHT.has(t.type) },
    ...overrides,
  }
}

/** The default layout: row[main, group-1] with a 0.32 share, expanded. */
export const startLayout = (collapsed = false): LayoutState<TestTab> => defaultLayout<TestTab>(counterMint('d'), 0.32, collapsed)

export function sound<T extends DockTab>(state: LayoutState<T>, settled = true) {
  expect(layoutProblems(state, settled)).toEqual([])
}

/** The inverse restores the start exactly, and replaying the ops reproduces the end. */
export function roundTrips<T extends DockTab>(before: LayoutState<T>, change: Pick<Change<T>, 'state' | 'ops' | 'inverse'>) {
  expect(applyOps(change.state, change.inverse).state).toEqual(before)
  expect(replay(before, change.ops)).toEqual(change.state)
}

/** Apply ops one by one and check each op's own inverse. */
export function opRoundTrips<T extends DockTab>(before: LayoutState<T>, ops: LayoutOp<T>[]) {
  const result = applyOps(before, ops)
  roundTrips(before, { state: result.state, ops, inverse: result.inverse })
  return result.state
}

/** Deterministic PRNG (mulberry32) for the randomized specs. */
export function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <V>(items: V[]): V => items[Math.floor(next() * items.length)] }
}
