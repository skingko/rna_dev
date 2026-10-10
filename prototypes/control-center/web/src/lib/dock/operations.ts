/**
 * The operation engine: one pure `applyOp` returning the next state plus the
 * ops that undo it. Replaying the same ops over the same state always yields
 * the same result, because every id an op creates travels inside the op.
 *
 * Ported from DeepSeek dockkit `ui-dockkit/src/engine/operations.ts` (MIT,
 * Copyright (c) 2026 DeepSeek; see LICENSE-dockkit.md). Changes: float panes
 * removed; panes became groups with per-scope active tabs; the main node is
 * anchored (never merged or replaced); `detach`/`attach` move whole nodes;
 * `replaceTree` swaps the structure for presets.
 */
import { MAIN, type ApplyResult, type DockTab, type GroupNode, type LayoutNode, type LayoutOp, type LayoutState, type NodeId, type Placement, type ScopeKey, type TabId } from './types'
import { findParent, getGroup, getNode, getSplit, getTab, inTree, insertAt, isGroup, layoutProblems, normalizeSizes, removeAt, replaceInParent, tabGroupId, withNodes, withTabs } from './tree'

type Op<T extends DockTab, K extends LayoutOp['type']> = Extract<LayoutOp<T>, { type: K }>

/** The focus facts of `groupIds` plus global focus, as the op that restores them. */
function focusSnapshot<T extends DockTab>(state: LayoutState<T>, groupIds: NodeId[]): LayoutOp<T> {
  const groups: Record<NodeId, Record<ScopeKey, TabId>> = {}
  for (const id of groupIds) groups[id] = getGroup(state, id).activeByScope
  return { type: 'restoreFocus', activeGroup: state.activeGroup, recent: state.recent, maximizedGroup: state.maximizedGroup, groups }
}

const bump = (recent: NodeId[], id: NodeId) => [id, ...recent.filter(other => other !== id)]

function focused<T extends DockTab>(state: LayoutState<T>, groupId: NodeId): LayoutState<T> {
  return { ...state, activeGroup: groupId, recent: bump(state.recent, groupId) }
}

/** Keep focus fields on live groups after some disappeared. */
function reseat<T extends DockTab>(state: LayoutState<T>): LayoutState<T> {
  const recent = state.recent.filter(id => isGroup(state, id))
  const activeGroup = isGroup(state, state.activeGroup) ? state.activeGroup : recent[0] ?? null
  const maximizedGroup = isGroup(state, state.maximizedGroup) ? state.maximizedGroup : null
  return { ...state, recent, activeGroup, maximizedGroup }
}

const withoutTab = (active: Record<ScopeKey, TabId>, tabId: TabId) =>
  Object.fromEntries(Object.entries(active).filter(([, id]) => id !== tabId))

const assertFreeNode = <T extends DockTab>(state: LayoutState<T>, id: NodeId) => {
  if (state.nodes[id]) throw new Error(`layout: node ${id} already exists`)
}
const assertFreeTab = <T extends DockTab>(state: LayoutState<T>, id: TabId) => {
  if (state.tabs[id]) throw new Error(`layout: tab ${id} already exists`)
}

/** Take a node out of its parent; a two-child parent collapses into the sibling. */
function detachNode<T extends DockTab>(state: LayoutState<T>, id: NodeId): { state: LayoutState<T>; restore: Placement } {
  if (id === MAIN) throw new Error('layout: the main node cannot be detached')
  const parentId = findParent(state, id)
  if (parentId === undefined) throw new Error(`layout: ${id} is the root or already detached`)
  const parent = getSplit(state, parentId)
  const index = parent.children.indexOf(id)
  if (parent.children.length > 2) {
    const next = { ...parent, children: removeAt(parent.children, index), sizes: normalizeSizes(removeAt(parent.sizes, index)) }
    return { state: withNodes(state, { [parentId]: next }), restore: { mode: 'child', parent: parentId, index, sizes: parent.sizes } }
  }
  const sibling = parent.children[1 - index]
  if (sibling === undefined) throw new Error(`layout: split ${parentId} has no sibling for ${id}`)
  return {
    state: withNodes(replaceInParent(state, parentId, sibling), { [parentId]: null }),
    restore: { mode: 'wrap', target: sibling, splitId: parentId, split: parent },
  }
}

/** Put a detached node in place; `resized` names a split whose old sizes undoing must restore. */
function attachNode<T extends DockTab>(state: LayoutState<T>, id: NodeId, at: Placement): { state: LayoutState<T>; resized?: { splitId: NodeId; sizes: number[] } } {
  getNode(state, id)
  if (inTree(state, id)) throw new Error(`layout: ${id} is already in the tree`)
  switch (at.mode) {
    case 'edge': {
      if (!inTree(state, at.target)) throw new Error(`layout: edge target ${at.target} is not in the tree`)
      if (!(at.share > 0 && at.share < 1)) throw new Error('layout: edge share must be between 0 and 1')
      const after = at.side === 'after'
      const parentId = findParent(state, at.target)
      const parent = parentId === undefined ? undefined : getSplit(state, parentId)
      if (parentId !== undefined && parent && parent.axis === at.axis) {
        const index = parent.children.indexOf(at.target)
        const children = insertAt(parent.children, after ? index + 1 : index, id)
        const sizes = parent.sizes.flatMap((size, i) => (i !== index ? [size] : after ? [size * (1 - at.share), size * at.share] : [size * at.share, size * (1 - at.share)]))
        return { state: withNodes(state, { [parentId]: { ...parent, children, sizes } }), resized: { splitId: parentId, sizes: parent.sizes } }
      }
      const target = getNode(state, at.target)
      if (target.kind === 'split' && target.axis === at.axis) {
        // The outer edge of a same-axis split: join it instead of nesting a second split of the same axis.
        const scaled = target.sizes.map(size => size * (1 - at.share))
        const next = after
          ? { ...target, children: [...target.children, id], sizes: [...scaled, at.share] }
          : { ...target, children: [id, ...target.children], sizes: [at.share, ...scaled] }
        return { state: withNodes(state, { [at.target]: next }), resized: { splitId: at.target, sizes: target.sizes } }
      }
      assertFreeNode(state, at.splitId)
      const rehomed = replaceInParent(state, at.target, at.splitId)
      return {
        state: withNodes(rehomed, {
          [at.splitId]: {
            kind: 'split',
            axis: at.axis,
            children: after ? [at.target, id] : [id, at.target],
            sizes: after ? [1 - at.share, at.share] : [at.share, 1 - at.share],
          },
        }),
      }
    }
    case 'child': {
      const parent = getSplit(state, at.parent)
      const children = insertAt(parent.children, at.index, id)
      if (at.sizes.length !== children.length) throw new Error('layout: attach sizes do not match the split')
      return { state: withNodes(state, { [at.parent]: { ...parent, children, sizes: at.sizes } }), resized: { splitId: at.parent, sizes: parent.sizes } }
    }
    case 'wrap': {
      if (!at.split.children.includes(id) || !at.split.children.includes(at.target)) throw new Error('layout: wrap split must list both nodes')
      if (!inTree(state, at.target)) throw new Error(`layout: wrap target ${at.target} is not in the tree`)
      assertFreeNode(state, at.splitId)
      return { state: withNodes(replaceInParent(state, at.target, at.splitId), { [at.splitId]: at.split }) }
    }
  }
}

const undoResize = <T extends DockTab>(resized?: { splitId: NodeId; sizes: number[] }): LayoutOp<T>[] =>
  resized ? [{ type: 'resize', splitId: resized.splitId, sizes: resized.sizes }] : []

function applyAddGroup<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'addGroup'>): ApplyResult<T> {
  assertFreeNode(state, op.groupId)
  if (op.group.kind !== 'group' || op.group.tabIds.length) throw new Error('layout: addGroup takes an empty group; tabs return through insertTab')
  const placed = attachNode(withNodes(state, { [op.groupId]: op.group }), op.groupId, op.at)
  return { state: placed.state, inverse: [{ type: 'merge', groupId: op.groupId }, ...undoResize<T>(placed.resized)] }
}

function applyMerge<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'merge'>): ApplyResult<T> {
  const group = getGroup(state, op.groupId)
  if (group.tabIds.length) throw new Error('layout: merge requires an empty group')
  const focus = focusSnapshot(state, [])
  const detached = detachNode(state, op.groupId)
  return {
    state: reseat(withNodes(detached.state, { [op.groupId]: null })),
    inverse: [{ type: 'addGroup', groupId: op.groupId, group, at: detached.restore }, focus],
  }
}

function applyDetach<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'detach'>): ApplyResult<T> {
  const detached = detachNode(state, op.nodeId)
  return { state: detached.state, inverse: [{ type: 'attach', nodeId: op.nodeId, at: detached.restore }] }
}

function applyAttach<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'attach'>): ApplyResult<T> {
  const placed = attachNode(state, op.nodeId, op.at)
  return { state: placed.state, inverse: [{ type: 'detach', nodeId: op.nodeId }, ...undoResize<T>(placed.resized)] }
}

function applyOpenTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'openTab'>): ApplyResult<T> {
  const group = getGroup(state, op.groupId)
  assertFreeTab(state, op.tab.id)
  const focus = focusSnapshot(state, [op.groupId])
  const next: GroupNode = { ...group, tabIds: insertAt(group.tabIds, op.index, op.tab.id), activeByScope: { ...group.activeByScope, [op.scope]: op.tab.id } }
  return {
    state: focused(withNodes(withTabs(state, { [op.tab.id]: op.tab }), { [op.groupId]: next }), op.groupId),
    inverse: [{ type: 'closeTab', tabId: op.tab.id }, focus],
  }
}

function applyInsertTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'insertTab'>): ApplyResult<T> {
  const group = getGroup(state, op.groupId)
  assertFreeTab(state, op.tab.id)
  const focus = focusSnapshot(state, [op.groupId])
  return {
    state: withNodes(withTabs(state, { [op.tab.id]: op.tab }), { [op.groupId]: { ...group, tabIds: insertAt(group.tabIds, op.index, op.tab.id) } }),
    inverse: [{ type: 'closeTab', tabId: op.tab.id }, focus],
  }
}

function applyCloseTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'closeTab'>): ApplyResult<T> {
  const tab = getTab(state, op.tabId)
  const groupId = tabGroupId(state, op.tabId)
  const group = getGroup(state, groupId)
  const index = group.tabIds.indexOf(op.tabId)
  const focus = focusSnapshot(state, [groupId])
  const next: GroupNode = { ...group, tabIds: removeAt(group.tabIds, index), activeByScope: withoutTab(group.activeByScope, op.tabId) }
  return {
    state: withTabs(withNodes(state, { [groupId]: next }), { [op.tabId]: null }),
    inverse: [{ type: 'insertTab', groupId, tab, index }, focus],
  }
}

function applyMoveTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'moveTab'>): ApplyResult<T> {
  const fromId = tabGroupId(state, op.tabId)
  if (fromId === op.groupId) throw new Error('layout: moveTab within one group; use reorderTab')
  const from = getGroup(state, fromId)
  const to = getGroup(state, op.groupId)
  const index = from.tabIds.indexOf(op.tabId)
  const focus = focusSnapshot(state, [fromId, op.groupId])
  const moved = withNodes(state, {
    [fromId]: { ...from, tabIds: removeAt(from.tabIds, index), activeByScope: withoutTab(from.activeByScope, op.tabId) },
    [op.groupId]: {
      ...to,
      tabIds: insertAt(to.tabIds, op.index, op.tabId),
      activeByScope: op.scope === null ? to.activeByScope : { ...to.activeByScope, [op.scope]: op.tabId },
    },
  })
  return {
    state: op.scope === null ? moved : focused(moved, op.groupId),
    inverse: [{ type: 'moveTab', tabId: op.tabId, groupId: fromId, index, scope: null }, focus],
  }
}

function applyReorderTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'reorderTab'>): ApplyResult<T> {
  const groupId = tabGroupId(state, op.tabId)
  const group = getGroup(state, groupId)
  const from = group.tabIds.indexOf(op.tabId)
  return {
    state: withNodes(state, { [groupId]: { ...group, tabIds: insertAt(removeAt(group.tabIds, from), op.index, op.tabId) } }),
    inverse: [{ type: 'reorderTab', tabId: op.tabId, index: from }],
  }
}

function applyUpdateTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'updateTab'>): ApplyResult<T> {
  const previous = getTab(state, op.tab.id)
  return { state: withTabs(state, { [op.tab.id]: op.tab }), inverse: [{ type: 'updateTab', tab: previous }] }
}

function applyFocusTab<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'focusTab'>): ApplyResult<T> {
  const groupId = tabGroupId(state, op.tabId)
  const group = getGroup(state, groupId)
  const focus = focusSnapshot(state, [groupId])
  return {
    state: focused(withNodes(state, { [groupId]: { ...group, activeByScope: { ...group.activeByScope, [op.scope]: op.tabId } } }), groupId),
    inverse: [focus],
  }
}

function applyFocusGroup<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'focusGroup'>): ApplyResult<T> {
  getGroup(state, op.groupId)
  return { state: focused(state, op.groupId), inverse: [focusSnapshot(state, [])] }
}

function applySetActive<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'setActive'>): ApplyResult<T> {
  const group = getGroup(state, op.groupId)
  if (op.tabId !== null && !group.tabIds.includes(op.tabId)) throw new Error(`layout: ${op.tabId} is not in ${op.groupId}`)
  const focus = focusSnapshot(state, [op.groupId])
  const activeByScope = { ...group.activeByScope }
  if (op.tabId === null) delete activeByScope[op.scope]
  else activeByScope[op.scope] = op.tabId
  return { state: withNodes(state, { [op.groupId]: { ...group, activeByScope } }), inverse: [focus] }
}

function applyResize<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'resize'>): ApplyResult<T> {
  const split = getSplit(state, op.splitId)
  if (op.sizes.length !== split.children.length) throw new Error('layout: resize sizes do not match the split')
  if (op.sizes.some(size => !(size > 0))) throw new Error('layout: resize sizes must all be above zero')
  return {
    state: withNodes(state, { [op.splitId]: { ...split, sizes: normalizeSizes(op.sizes) } }),
    inverse: [{ type: 'resize', splitId: op.splitId, sizes: split.sizes }],
  }
}

function applySetMinimized<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'setMinimized'>): ApplyResult<T> {
  const group = getGroup(state, op.groupId)
  const next: GroupNode = { ...group }
  // Absent rather than false, so a round trip restores the record exactly.
  if (op.minimized) next.minimized = true
  else delete next.minimized
  return { state: withNodes(state, { [op.groupId]: next }), inverse: [{ type: 'setMinimized', groupId: op.groupId, minimized: Boolean(group.minimized) }] }
}

function applyReplaceTree<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'replaceTree'>): ApplyResult<T> {
  const focus = focusSnapshot(state, [])
  const next = reseat({ ...state, root: op.root, nodes: op.nodes })
  const problems = layoutProblems(next)
  if (problems.length) throw new Error(`layout: replaceTree rejected: ${problems.join('; ')}`)
  return { state: next, inverse: [{ type: 'replaceTree', root: state.root, nodes: state.nodes }, focus] }
}

function applyRestoreFocus<T extends DockTab>(state: LayoutState<T>, op: Op<T, 'restoreFocus'>): ApplyResult<T> {
  const inverse = focusSnapshot(state, Object.keys(op.groups))
  const updates: Record<NodeId, LayoutNode> = {}
  for (const [id, activeByScope] of Object.entries(op.groups)) updates[id] = { ...getGroup(state, id), activeByScope }
  for (const id of [op.activeGroup, op.maximizedGroup, ...op.recent]) if (id !== null) getGroup(state, id)
  return {
    state: { ...withNodes(state, updates), activeGroup: op.activeGroup, recent: op.recent, maximizedGroup: op.maximizedGroup },
    inverse: [inverse],
  }
}

/**
 * Apply one op.
 * @throws when the op addresses missing nodes or breaks a model rule.
 */
export function applyOp<T extends DockTab>(state: LayoutState<T>, op: LayoutOp<T>): ApplyResult<T> {
  switch (op.type) {
    case 'addGroup': return applyAddGroup(state, op)
    case 'merge': return applyMerge(state, op)
    case 'detach': return applyDetach(state, op)
    case 'attach': return applyAttach(state, op)
    case 'openTab': return applyOpenTab(state, op)
    case 'insertTab': return applyInsertTab(state, op)
    case 'closeTab': return applyCloseTab(state, op)
    case 'moveTab': return applyMoveTab(state, op)
    case 'reorderTab': return applyReorderTab(state, op)
    case 'updateTab': return applyUpdateTab(state, op)
    case 'focusTab': return applyFocusTab(state, op)
    case 'focusGroup': return applyFocusGroup(state, op)
    case 'setActive': return applySetActive(state, op)
    case 'resize': return applyResize(state, op)
    case 'setCollapsed':
      return { state: { ...state, collapsed: op.collapsed }, inverse: [{ type: 'setCollapsed', collapsed: state.collapsed }] }
    case 'setMaximized':
      if (op.groupId !== null) getGroup(state, op.groupId)
      return { state: { ...state, maximizedGroup: op.groupId }, inverse: [{ type: 'setMaximized', groupId: state.maximizedGroup }] }
    case 'setMinimized': return applySetMinimized(state, op)
    case 'replaceTree': return applyReplaceTree(state, op)
    case 'restoreFocus': return applyRestoreFocus(state, op)
  }
}

/**
 * Apply ops in order.
 * @returns the final state and the ops that undo all of them (last op's inverse first).
 */
export function applyOps<T extends DockTab>(state: LayoutState<T>, ops: LayoutOp<T>[]): ApplyResult<T> {
  let next = state
  const inverse: LayoutOp<T>[] = []
  for (const op of ops) {
    const result = applyOp(next, op)
    next = result.state
    inverse.unshift(...result.inverse)
  }
  return { state: next, inverse }
}

/** Fold ops forward, discarding inverses. */
export const replay = <T extends DockTab>(state: LayoutState<T>, ops: LayoutOp<T>[]): LayoutState<T> =>
  ops.reduce((current, op) => applyOp(current, op).state, state)
