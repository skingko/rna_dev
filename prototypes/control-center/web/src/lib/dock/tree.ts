/**
 * Pure tree helpers over `LayoutState`. Readers throw on a dangling id (the op
 * vocabulary is closed, so a miss is a caller defect); writers return a new
 * state that keeps untouched nodes at their old identity.
 *
 * Adapted from DeepSeek dockkit `ui-dockkit/src/engine/tree.ts` (MIT,
 * Copyright (c) 2026 DeepSeek; see LICENSE-dockkit.md).
 */
import { MAIN, type Binding, type DockTab, type GroupNode, type LayoutNode, type LayoutState, type Mint, type NodeId, type ScopeCtx, type ScopeKey, type SplitNode, type TabId } from './types'

export const scopeKey = (ctx: ScopeCtx): ScopeKey =>
  ctx.sessionId ? `s:${ctx.sessionId}` : ctx.projectId ? `p:${ctx.projectId}` : 'global'

export function bindingMatches(binding: Binding, ctx: ScopeCtx): boolean {
  if (binding === 'workspace') return true
  if ('session' in binding) return Boolean(ctx.sessionId) && binding.session === ctx.sessionId
  return Boolean(ctx.projectId) && binding.project === ctx.projectId
}

export function getNode<T extends DockTab>(state: LayoutState<T>, id: NodeId): LayoutNode {
  const node = state.nodes[id]
  if (!node) throw new Error(`layout: unknown node ${id}`)
  return node
}

export function getGroup<T extends DockTab>(state: LayoutState<T>, id: NodeId): GroupNode {
  const node = getNode(state, id)
  if (node.kind !== 'group') throw new Error(`layout: ${id} is not a group`)
  return node
}

export function getSplit<T extends DockTab>(state: LayoutState<T>, id: NodeId): SplitNode {
  const node = getNode(state, id)
  if (node.kind !== 'split') throw new Error(`layout: ${id} is not a split`)
  return node
}

export function getTab<T extends DockTab>(state: LayoutState<T>, id: TabId): T {
  const tab = state.tabs[id]
  if (!tab) throw new Error(`layout: unknown tab ${id}`)
  return tab
}

export const isGroup = <T extends DockTab>(state: LayoutState<T>, id: NodeId | null | undefined): id is NodeId =>
  Boolean(id) && state.nodes[id!]?.kind === 'group'

/** The split holding `id`, or undefined for the root and detached nodes. */
export function findParent<T extends DockTab>(state: LayoutState<T>, id: NodeId): NodeId | undefined {
  for (const [key, node] of Object.entries(state.nodes)) {
    if (node.kind === 'split' && node.children.includes(id)) return key
  }
  return undefined
}

/** The group listing `tabId`. */
export function tabGroupId<T extends DockTab>(state: LayoutState<T>, tabId: TabId): NodeId {
  for (const [key, node] of Object.entries(state.nodes)) {
    if (node.kind === 'group' && node.tabIds.includes(tabId)) return key
  }
  throw new Error(`layout: tab ${tabId} has no group`)
}

/** Every node reachable from the root, depth first (visual order). */
export function treeIds<T extends DockTab>(state: LayoutState<T>, from: NodeId = state.root): NodeId[] {
  const out: NodeId[] = []
  const walk = (id: NodeId) => {
    out.push(id)
    const node = getNode(state, id)
    if (node.kind === 'split') for (const child of node.children) walk(child)
  }
  walk(from)
  return out
}

/** Groups in visual order. */
export const groupIds = <T extends DockTab>(state: LayoutState<T>): NodeId[] =>
  treeIds(state).filter(id => state.nodes[id].kind === 'group')

export const inTree = <T extends DockTab>(state: LayoutState<T>, id: NodeId): boolean => treeIds(state).includes(id)

/** Whether `id` lies in the subtree rooted at `ancestor` (itself included). */
export const within = <T extends DockTab>(state: LayoutState<T>, ancestor: NodeId, id: NodeId): boolean =>
  treeIds(state, ancestor).includes(id)

/** Tabs of a group that show in `ctx`, in strip order. */
export function visibleTabs<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, ctx: ScopeCtx): T[] {
  return getGroup(state, groupId).tabIds.map(id => state.tabs[id]).filter(tab => tab && bindingMatches(tab.binding, ctx))
}

/** The tab a group shows in `ctx`: the scope's choice when visible, else the last visible tab. */
export function activeTab<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, ctx: ScopeCtx): T | null {
  const visible = visibleTabs(state, groupId, ctx)
  const chosen = getGroup(state, groupId).activeByScope[scopeKey(ctx)]
  return visible.find(tab => tab.id === chosen) ?? visible.at(-1) ?? null
}

/**
 * Scale `sizes` so they sum to 1. Input already summing to 1 is copied
 * unchanged, so restoring recorded sizes never drifts.
 */
export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (!(total > 0)) throw new Error('layout: sizes must sum above zero')
  if (Math.abs(total - 1) < 1e-12) return [...sizes]
  return sizes.map(size => size / total)
}

export function withNodes<T extends DockTab>(state: LayoutState<T>, updates: Record<NodeId, LayoutNode | null>): LayoutState<T> {
  const nodes: Record<NodeId, LayoutNode> = {}
  for (const [id, node] of Object.entries(state.nodes)) if (!(id in updates)) nodes[id] = node
  for (const [id, node] of Object.entries(updates)) if (node) nodes[id] = node
  return { ...state, nodes }
}

export function withTabs<T extends DockTab>(state: LayoutState<T>, updates: Record<TabId, T | null>): LayoutState<T> {
  const tabs: Record<TabId, T> = {}
  for (const [id, tab] of Object.entries(state.tabs)) if (!(id in updates)) tabs[id] = tab
  for (const [id, tab] of Object.entries(updates)) if (tab) tabs[id] = tab
  return { ...state, tabs }
}

export function insertAt<V>(items: V[], index: number, value: V): V[] {
  const at = Math.max(0, Math.min(index, items.length))
  return [...items.slice(0, at), value, ...items.slice(at)]
}

export const removeAt = <V>(items: V[], index: number): V[] => [...items.slice(0, index), ...items.slice(index + 1)]

/** Swap a node for another in its parent's slot, or make the replacement the root. */
export function replaceInParent<T extends DockTab>(state: LayoutState<T>, targetId: NodeId, replacementId: NodeId): LayoutState<T> {
  const parentId = findParent(state, targetId)
  if (parentId === undefined) {
    if (state.root !== targetId) throw new Error(`layout: ${targetId} is neither rooted nor parented`)
    return { ...state, root: replacementId }
  }
  const parent = getSplit(state, parentId)
  return withNodes(state, { [parentId]: { ...parent, children: parent.children.map(child => (child === targetId ? replacementId : child)) } })
}

/** A minted id no node or tab uses yet, so a counter mint is safe across reloads. */
export function freshId<T extends DockTab>(state: LayoutState<T>, mint: Mint, kind: 'group' | 'split' | 'tab'): string {
  for (let tries = 0; tries < 10_000; tries++) {
    const id = mint(kind)
    if (!(id in state.nodes) && !(id in state.tabs)) return id
  }
  throw new Error('layout: the mint keeps returning ids in use')
}

/** A counter mint: `group-1`, `split-2`, … (deterministic; `freshId` skips taken ids). */
export function counterMint(prefix = ''): Mint {
  let n = 0
  return kind => `${prefix}${kind}-${++n}`
}

export const emptyGroup = (): GroupNode => ({ kind: 'group', tabIds: [], activeByScope: {} })

/** Main only: no groups. */
export function emptyLayout<T extends DockTab = DockTab>(): LayoutState<T> {
  return { version: 2, root: MAIN, nodes: { [MAIN]: { kind: 'main' } }, tabs: {}, activeGroup: null, recent: [], collapsed: false, maximizedGroup: null }
}

/**
 * Structural problems, empty when the layout is sound: one reachable tree with
 * exactly one main, splits with matching positive sizes summing to 1, every
 * tab in exactly one group, focus fields naming live groups. `settled` also
 * requires splits of two or more children and no empty group (except a lone
 * last group, which settle keeps as the panel's skeleton).
 */
export function layoutProblems<T extends DockTab>(state: LayoutState<T>, settled = false): string[] {
  const problems: string[] = []
  const seen = new Set<NodeId>()
  const walk = (id: NodeId, depth: number) => {
    const node = state.nodes[id]
    if (!node) return void problems.push(`dangling node ${id}`)
    if (seen.has(id)) return void problems.push(`node ${id} reached twice`)
    if (depth > 64) return void problems.push('tree too deep')
    seen.add(id)
    if (node.kind !== 'split') return
    if (node.children.length < 1 || (settled && node.children.length < 2)) problems.push(`split ${id} has ${node.children.length} children`)
    if (node.sizes.length !== node.children.length) problems.push(`split ${id} sizes do not match children`)
    if (node.sizes.some(size => !(size > 0))) problems.push(`split ${id} has a non-positive size`)
    if (Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) > 1e-6) problems.push(`split ${id} sizes do not sum to 1`)
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(state.root, 0)
  for (const id of Object.keys(state.nodes)) if (!seen.has(id)) problems.push(`orphan node ${id}`)
  const mains = Object.entries(state.nodes).filter(([, node]) => node.kind === 'main')
  if (mains.length !== 1 || mains[0][0] !== MAIN) problems.push(`expected one main node, found ${mains.map(([id]) => id).join(',') || 'none'}`)
  const placed = new Map<TabId, NodeId>()
  const groups = Object.entries(state.nodes).filter((entry): entry is [NodeId, GroupNode] => entry[1].kind === 'group')
  for (const [id, group] of groups) {
    for (const tabId of group.tabIds) {
      if (!state.tabs[tabId]) problems.push(`group ${id} lists unknown tab ${tabId}`)
      if (placed.has(tabId)) problems.push(`tab ${tabId} is in ${placed.get(tabId)} and ${id}`)
      placed.set(tabId, id)
    }
    for (const [scope, tabId] of Object.entries(group.activeByScope)) {
      if (!group.tabIds.includes(tabId)) problems.push(`group ${id} activates foreign tab ${tabId} in ${scope}`)
    }
    if (settled && group.tabIds.length === 0 && groups.length > 1) problems.push(`group ${id} is empty`)
  }
  for (const [tabId, tab] of Object.entries(state.tabs)) {
    if (tab.id !== tabId) problems.push(`tab ${tabId} carries id ${tab.id}`)
    if (!placed.has(tabId)) problems.push(`tab ${tabId} is in no group`)
  }
  if (state.activeGroup !== null && !isGroup(state, state.activeGroup)) problems.push(`activeGroup ${state.activeGroup} is not a group`)
  if (state.maximizedGroup !== null && !isGroup(state, state.maximizedGroup)) problems.push(`maximizedGroup ${state.maximizedGroup} is not a group`)
  if (state.recent.some(id => !isGroup(state, id)) || new Set(state.recent).size !== state.recent.length) problems.push('recent lists a non-group or a duplicate')
  return problems
}
