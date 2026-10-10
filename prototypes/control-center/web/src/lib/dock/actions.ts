/**
 * What the workspace UI calls (design 1.3/1.6). Each action returns the next
 * immutable state, the ops it applied and their inverse (for the sequencer),
 * and the tab records it removed (for `onTabClosed`). A no-op returns the same
 * state object and no ops. Tab-removing actions settle the tree afterwards.
 */
import { MAIN, type Axis, type DockTab, type Edge, type LayoutOp, type LayoutState, type Mint, type NodeId, type ScopeCtx, type TabId } from './types'
import { applyOp } from './operations'
import { activeTab, emptyGroup, freshId, getGroup, getNode, groupIds, isGroup, scopeKey, tabGroupId, visibleTabs } from './tree'
import { besideMain, DEFAULT_SHARE, edgeSplit, planDropTab, planPlaceTab, planResizeDivider, planResizeSplit, planSettle, planSplitGroup } from './planner'
import { neighborNode, type Divider, type Geometry } from './geometry'

export interface DockPolicy<T extends DockTab> {
  mint: Mint
  /** Same identity → reuse the open tab; null = always a new tab. */
  identity?: (tab: T) => string | null
  /** Visible tabs per scope; over it, lightweight tabs close first, oldest first, never an active one. */
  cap?: { max: number; lightweight: (tab: T) => boolean }
  /** Backfills a group a move or split would otherwise empty (the launcher). */
  seed?: (id: TabId) => T
  /** Share a new group takes beside the conversation or a split; default 0.32. Per axis: `row` beside it, `column` above or below. */
  share?: number | { row: number; column: number }
  /** Keep a lone last group (empty) when its last tab closes; default true (today's empty panel). */
  keepLastGroup?: boolean
}

export interface Change<T extends DockTab> {
  state: LayoutState<T>
  ops: LayoutOp<T>[]
  /** Ordered for application. */
  inverse: LayoutOp<T>[]
  /** Tab records this change removed (closed, evicted, replaced). */
  closed: T[]
}

/**
 * Where `openTab` puts a new tab; a group or node that no longer exists falls back to `auto`.
 * An edge target may say what share of `of`'s slot the new group takes (default: half a group, `policy.share` beside main or a split).
 */
export type OpenTarget = 'auto' | NodeId | { edge: Edge; of: NodeId; share?: number }

export interface OpenOptions {
  /** Add without switching to it (still shows the panel). */
  background?: boolean
  /** Replace this tab in place (the launcher a card was picked from). */
  replace?: TabId | null
  /** Strip slot for a new tab; defaults to the end. */
  index?: number
}

/** The share a new group takes beside the conversation (or a split) along `axis`. */
export function sideShare<T extends DockTab>(policy: Pick<DockPolicy<T>, 'share'>, axis: Axis): number {
  const share = policy.share
  return (typeof share === 'object' ? share[axis] : share) ?? DEFAULT_SHARE
}

/** Ops applied as they are planned, so later steps read the state earlier ones produced. */
class Draft<T extends DockTab> {
  ops: LayoutOp<T>[] = []
  inverse: LayoutOp<T>[] = []
  constructor(public state: LayoutState<T>) {}
  push(...ops: LayoutOp<T>[]) {
    for (const op of ops) {
      const result = applyOp(this.state, op)
      this.state = result.state
      this.ops.push(op)
      this.inverse.unshift(...result.inverse)
    }
    return this
  }
}

const unchanged = <T extends DockTab>(state: LayoutState<T>): Change<T> => ({ state, ops: [], inverse: [], closed: [] })

function finish<T extends DockTab>(start: LayoutState<T>, draft: Draft<T>, policy?: Pick<DockPolicy<T>, 'mint' | 'keepLastGroup'>): Change<T> {
  if (!draft.ops.length) return unchanged(start)
  if (policy) draft.push(...planSettle(draft.state, policy.mint, { keepLast: policy.keepLastGroup ?? true }))
  return { state: draft.state, ops: draft.ops, inverse: draft.inverse, closed: Object.values(start.tabs).filter(tab => !(tab.id in draft.state.tabs)) }
}

/** Run planned ops as one change (exported for presets and other planners). */
export function commit<T extends DockTab>(state: LayoutState<T>, ops: LayoutOp<T>[], settle?: Pick<DockPolicy<T>, 'mint' | 'keepLastGroup'>): Change<T> {
  return finish(state, new Draft(state).push(...ops), settle)
}

/** Groups most recently focused first, then the rest in visual order. */
export function groupsByRecency<T extends DockTab>(state: LayoutState<T>): NodeId[] {
  const groups = groupIds(state)
  return [...state.recent.filter(id => groups.includes(id)), ...groups.filter(id => !state.recent.includes(id))]
}

/** Show `groupId`: expand the panel, drop another group's maximize, restore it from the strip. */
function reveal<T extends DockTab>(draft: Draft<T>, groupId: NodeId, unminimize: boolean) {
  if (draft.state.collapsed) draft.push({ type: 'setCollapsed', collapsed: false })
  if (draft.state.maximizedGroup !== null && draft.state.maximizedGroup !== groupId) draft.push({ type: 'setMaximized', groupId: null })
  if (unminimize && getGroup(draft.state, groupId).minimized) draft.push({ type: 'setMinimized', groupId, minimized: false })
}

/** The group a new tab goes to (design 1.6), creating one when needed. */
function targetGroup<T extends DockTab>(draft: Draft<T>, tab: T, target: OpenTarget, policy: DockPolicy<T>): NodeId {
  const state = draft.state
  if (typeof target === 'object' && state.nodes[target.of]) {
    const node = getNode(state, target.of)
    const groupId = freshId(state, policy.mint, 'group')
    const { axis, side } = edgeSplit(target.edge)
    const fallback = node.kind === 'group' ? 0.5 : sideShare(policy, axis)
    const share = target.share !== undefined && target.share > 0 && target.share < 1 ? target.share : fallback
    draft.push({ type: 'addGroup', groupId, group: emptyGroup(), at: { mode: 'edge', target: target.of, axis, side, share, splitId: freshId(state, policy.mint, 'split') } })
    return groupId
  }
  if (typeof target === 'string' && target !== 'auto' && isGroup(state, target)) return target
  const ordered = groupsByRecency(state)
  const sameType = ordered.find(id => getGroup(state, id).tabIds.some(tabId => state.tabs[tabId]?.type === tab.type))
  if (sameType) return sameType
  if (ordered.length) return ordered[0]
  const groupId = freshId(state, policy.mint, 'group')
  draft.push({ type: 'addGroup', groupId, group: emptyGroup(), at: { mode: 'edge', target: MAIN, axis: 'row', side: 'after', share: sideShare(policy, 'row'), splitId: freshId(state, policy.mint, 'split') } })
  return groupId
}

/** Close tabs over the cap for `ctx`: lightweight first, oldest first, never `keep` or a group's active tab. */
function evict<T extends DockTab>(draft: Draft<T>, ctx: ScopeCtx, keep: TabId, policy: DockPolicy<T>) {
  const cap = policy.cap
  if (!cap) return
  for (;;) {
    const groups = groupIds(draft.state)
    const visible = groups.flatMap(id => visibleTabs(draft.state, id, ctx))
    if (visible.length <= cap.max) return
    const guarded = new Set<TabId>([keep, ...groups.map(id => activeTab(draft.state, id, ctx)?.id ?? '')])
    const victim = visible.find(tab => !guarded.has(tab.id) && cap.lightweight(tab)) ?? visible.find(tab => !guarded.has(tab.id))
    if (!victim) return
    draft.push({ type: 'closeTab', tabId: victim.id })
  }
}

const sameRecord = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Open (or re-focus) a tab and show the panel. `auto`: a tab with the same
 * identity is focused (and updated with the new fields); else it goes to the
 * group already holding that type, else the most recently focused group, else
 * a new right-hand group beside the conversation.
 */
export function openTab<T extends DockTab>(
  state: LayoutState<T>, tab: T, target: OpenTarget, ctx: ScopeCtx, policy: DockPolicy<T>, options: OpenOptions = {},
): Change<T> & { tabId: TabId } {
  const scope = scopeKey(ctx)
  const draft = new Draft(state)
  const key = policy.identity?.(tab) ?? null
  // A reused id counts as the same tab too, rather than a collision.
  const existing = (key === null ? undefined : Object.values(state.tabs).find(other => policy.identity!(other) === key)) ?? state.tabs[tab.id]
  const replace = options.replace && state.tabs[options.replace] ? options.replace : null
  let tabId: TabId
  let groupId: NodeId
  if (existing) {
    tabId = existing.id
    const merged = { ...existing, ...tab, id: existing.id }
    if (!sameRecord(merged, existing)) draft.push({ type: 'updateTab', tab: merged })
    if (replace && replace !== tabId) draft.push({ type: 'closeTab', tabId: replace })
    groupId = tabGroupId(draft.state, tabId)
    const shown = getGroup(draft.state, groupId).activeByScope[scope] === tabId && draft.state.activeGroup === groupId
    if (!options.background && !shown) draft.push({ type: 'focusTab', tabId, scope })
  } else {
    tabId = tab.id
    groupId = replace ? tabGroupId(state, replace) : targetGroup(draft, tab, target, policy)
    const index = replace ? getGroup(draft.state, groupId).tabIds.indexOf(replace) : options.index ?? getGroup(draft.state, groupId).tabIds.length
    // A scope that never picked a tab shows the group's last one, which a background tab added at the end would
    // become: pin what it shows now first, so opening in the background never changes the shown tab.
    const before = options.background ? activeTab(draft.state, groupId, ctx) : null
    if (before && getGroup(draft.state, groupId).activeByScope[scope] !== before.id) draft.push({ type: 'setActive', groupId, scope, tabId: before.id })
    draft.push(options.background ? { type: 'insertTab', groupId, tab, index } : { type: 'openTab', groupId, tab, index, scope })
    if (replace) draft.push({ type: 'closeTab', tabId: replace })
  }
  reveal(draft, groupId, !options.background)
  evict(draft, ctx, tabId, policy)
  return { ...finish(state, draft, policy), tabId }
}

/** Close a tab; when it was the shown one, the right neighbour (else the left) takes over, as today. */
export function closeTab<T extends DockTab>(state: LayoutState<T>, tabId: TabId, ctx: ScopeCtx, policy: DockPolicy<T>): Change<T> {
  if (!state.tabs[tabId]) return unchanged(state)
  const groupId = tabGroupId(state, tabId)
  const visible = visibleTabs(state, groupId, ctx)
  const wasActive = activeTab(state, groupId, ctx)?.id === tabId
  const draft = new Draft(state).push({ type: 'closeTab', tabId })
  if (wasActive) {
    const index = visible.findIndex(tab => tab.id === tabId)
    const rest = visible.filter(tab => tab.id !== tabId)
    const next = rest[Math.min(index, rest.length - 1)]
    if (next) draft.push({ type: 'setActive', groupId, scope: scopeKey(ctx), tabId: next.id })
  }
  return finish(state, draft, policy)
}

/** The tab menu's 关闭其他 / 关闭左侧 / 关闭右侧 / 全部关闭, over the tabs the group shows in `ctx`. */
export function closeTabs<T extends DockTab>(state: LayoutState<T>, anchorId: TabId, side: 'others' | 'left' | 'right' | 'all', ctx: ScopeCtx, policy: DockPolicy<T>): Change<T> {
  if (!state.tabs[anchorId]) return unchanged(state)
  const groupId = tabGroupId(state, anchorId)
  const visible = visibleTabs(state, groupId, ctx)
  const index = visible.findIndex(tab => tab.id === anchorId)
  const removed = side === 'all' ? visible : side === 'others' ? visible.filter(tab => tab.id !== anchorId) : side === 'left' ? visible.slice(0, Math.max(0, index)) : index < 0 ? [] : visible.slice(index + 1)
  if (!removed.length) return unchanged(state)
  const active = activeTab(state, groupId, ctx)
  const draft = new Draft(state).push(...removed.map((tab): LayoutOp<T> => ({ type: 'closeTab', tabId: tab.id })))
  if (side !== 'all' && index >= 0 && (side === 'others' || (active && removed.includes(active)))) {
    if (getGroup(draft.state, groupId).activeByScope[scopeKey(ctx)] !== anchorId) draft.push({ type: 'setActive', groupId, scope: scopeKey(ctx), tabId: anchorId })
  }
  return finish(state, draft, policy)
}

/**
 * 关闭其他 / 关闭左侧 / 关闭右侧 / 全部关闭 over a strip that lists several groups' tabs (the phone sheet, a narrow
 * window's overlay): `listed` is that strip in its order, `shownId` the tab it shows. When the shown tab closes (and
 * always for 关闭其他), the anchor takes over and its group comes to the front.
 */
export function closeAmong<T extends DockTab>(
  state: LayoutState<T>, anchorId: TabId, side: 'others' | 'left' | 'right' | 'all', listed: TabId[], shownId: TabId | null, ctx: ScopeCtx, policy: DockPolicy<T>,
): Change<T> {
  const tabs = listed.filter(id => id in state.tabs)
  const index = tabs.indexOf(anchorId)
  if (index < 0) return unchanged(state)
  const removed = side === 'all' ? tabs : side === 'others' ? tabs.filter(id => id !== anchorId) : side === 'left' ? tabs.slice(0, index) : tabs.slice(index + 1)
  if (!removed.length) return unchanged(state)
  const draft = new Draft(state).push(...removed.map((tabId): LayoutOp<T> => ({ type: 'closeTab', tabId })))
  if (side !== 'all' && (side === 'others' || (shownId !== null && removed.includes(shownId)))) draft.push({ type: 'focusTab', tabId: anchorId, scope: scopeKey(ctx) })
  return finish(state, draft, policy)
}

/**
 * Move a tab into a group (at `index`, default the end; within its own group a
 * caret slot reorders it) or to an edge of any node, splitting it.
 */
export function moveTab<T extends DockTab>(
  state: LayoutState<T>, tabId: TabId, to: NodeId | { edge: Edge; of: NodeId }, ctx: ScopeCtx, policy: DockPolicy<T>, index?: number,
): Change<T> {
  if (!state.tabs[tabId]) return unchanged(state)
  const scope = scopeKey(ctx)
  let ops: LayoutOp<T>[]
  if (typeof to === 'string') {
    if (!isGroup(state, to)) return unchanged(state)
    const same = tabGroupId(state, tabId) === to
    if (same && index === undefined) return unchanged(state)
    ops = planPlaceTab(state, tabId, to, index ?? getGroup(state, to).tabIds.length, scope)
  } else {
    if (!state.nodes[to.of]) return unchanged(state)
    ops = planDropTab(state, policy.mint, tabId, to.of, to.edge, scope, { seed: policy.seed, share: sideShare(policy, edgeSplit(to.edge).axis) })
  }
  const draft = new Draft(state).push(...ops)
  // The moved tab stays in view: leaving a maximized group (or entering a hidden one) shows where it went.
  if (draft.ops.length) reveal(draft, tabGroupId(draft.state, tabId), true)
  return finish(state, draft, policy)
}

/** 移到左/右/上/下侧的组: into the neighbouring group on that side, or a new one split off there. */
export function moveTabToward<T extends DockTab>(state: LayoutState<T>, tabId: TabId, edge: Edge, ctx: ScopeCtx, policy: DockPolicy<T>): Change<T> {
  if (!state.tabs[tabId]) return unchanged(state)
  const from = tabGroupId(state, tabId)
  const neighbor = neighborNode(state, from, edge)
  return moveTab(state, tabId, neighbor ?? { edge, of: from }, ctx, policy)
}

/** Hang a whole group on an edge of the conversation. */
export function moveGroup<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, edge: Edge, policy: DockPolicy<T>): Change<T> {
  if (!isGroup(state, groupId) || besideMain(state, groupId, edge)) return unchanged(state)
  const { axis, side } = edgeSplit(edge)
  // A maximized group comes back beside the conversation, where the move shows: one change, one undo step.
  const draft = new Draft(state)
  if (state.maximizedGroup !== null) draft.push({ type: 'setMaximized', groupId: null })
  return finish(state, draft.push(
    { type: 'detach', nodeId: groupId },
    { type: 'attach', nodeId: groupId, at: { mode: 'edge', target: MAIN, axis, side, share: sideShare(policy, axis), splitId: freshId(state, policy.mint, 'split') } },
  ), policy)
}

/**
 * 向右拆分 / 向下拆分: with `tabId`, move that tab into a new group beside;
 * without, open a new group beside seeded with `policy.seed` (the launcher).
 */
export function splitGroup<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, direction: 'right' | 'down', ctx: ScopeCtx, policy: DockPolicy<T>, tabId?: TabId): Change<T> {
  if (!isGroup(state, groupId)) return unchanged(state)
  if (tabId) return moveTab(state, tabId, { edge: direction === 'right' ? 'right' : 'bottom', of: groupId }, ctx, policy)
  const draft = new Draft(state).push(...planSplitGroup(state, policy.mint, groupId, direction, scopeKey(ctx), policy.seed))
  // The new group (focused by its chooser) shows, even when split off a maximized group.
  if (draft.ops.length && draft.state.activeGroup !== null) reveal(draft, draft.state.activeGroup, false)
  return finish(state, draft, policy)
}

/**
 * 关闭整组: the tabs the group shows in `ctx`, then the group itself (the last group may go too). Tabs that show only
 * elsewhere (another conversation's, another project's terminal) are not closed from a view that cannot see them:
 * they move to the most recently focused other group, or, with none, keep the group and the panels hide.
 * Without `ctx`, every tab in every scope closes.
 */
export function closeGroup<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, policy: DockPolicy<T>, ctx?: ScopeCtx): Change<T> {
  if (!isGroup(state, groupId)) return unchanged(state)
  const ids = getGroup(state, groupId).tabIds
  const shown = ctx ? new Set(visibleTabs(state, groupId, ctx).map(tab => tab.id)) : null
  const keeping = shown ? ids.filter(id => !shown.has(id)) : []
  const home = keeping.length ? groupsByRecency(state).find(id => id !== groupId) : undefined
  const draft = new Draft(state).push(...ids.filter(id => !keeping.includes(id)).map((tabId): LayoutOp<T> => ({ type: 'closeTab', tabId })))
  if (home) for (const tabId of keeping) draft.push({ type: 'moveTab', tabId, groupId: home, index: getGroup(draft.state, home).tabIds.length, scope: null })
  if (!keeping.length || home) draft.push({ type: 'merge', groupId })
  // The only group, kept for what other conversations show: here it goes out of view with the panels.
  else if (!draft.state.collapsed) draft.push({ type: 'setCollapsed', collapsed: true })
  return finish(state, draft, policy)
}

/** Set a split's sizes, clamped to a fractional minimum. */
export function resize<T extends DockTab>(state: LayoutState<T>, splitId: NodeId, sizes: number[], minimum?: number): Change<T> {
  if (getNode(state, splitId).kind !== 'split') return unchanged(state)
  return commit(state, planResizeSplit<T>(splitId, sizes, minimum))
}

/** A divider drag of `deltaPx`, holding both neighbours at their pixel minimums. */
export function resizeDivider<T extends DockTab>(state: LayoutState<T>, geometry: Geometry, divider: Divider, deltaPx: number): Change<T> {
  return commit(state, planResizeDivider(state, geometry, divider, deltaPx))
}

/** Show a tab in its group for `ctx` and focus that group. */
export function activateTab<T extends DockTab>(state: LayoutState<T>, tabId: TabId, ctx: ScopeCtx): Change<T> {
  if (!state.tabs[tabId]) return unchanged(state)
  const groupId = tabGroupId(state, tabId)
  const draft = new Draft(state)
  const group = getGroup(state, groupId)
  if (group.activeByScope[scopeKey(ctx)] !== tabId || state.activeGroup !== groupId) draft.push({ type: 'focusTab', tabId, scope: scopeKey(ctx) })
  reveal(draft, groupId, true)
  return finish(state, draft)
}

export function focusGroup<T extends DockTab>(state: LayoutState<T>, groupId: NodeId): Change<T> {
  if (!isGroup(state, groupId) || (state.activeGroup === groupId && state.recent[0] === groupId)) return unchanged(state)
  return commit(state, [{ type: 'focusGroup', groupId }])
}

export function setCollapsed<T extends DockTab>(state: LayoutState<T>, collapsed: boolean): Change<T> {
  return state.collapsed === collapsed ? unchanged(state) : commit(state, [{ type: 'setCollapsed', collapsed }])
}

/** ⌥⌘B. */
export const toggleCollapsed = <T extends DockTab>(state: LayoutState<T>): Change<T> => setCollapsed(state, !state.collapsed)

/** Maximize a group over the whole workspace; the same group (or null) restores. Not persisted. */
export function maximize<T extends DockTab>(state: LayoutState<T>, groupId: NodeId | null): Change<T> {
  const next = groupId === state.maximizedGroup ? null : groupId
  if (next !== null && !isGroup(state, next)) return unchanged(state)
  if (next === state.maximizedGroup) return unchanged(state)
  const draft = new Draft(state).push({ type: 'setMaximized', groupId: next })
  if (next !== null) {
    if (getGroup(state, next).minimized) draft.push({ type: 'setMinimized', groupId: next, minimized: false })
    if (state.collapsed) draft.push({ type: 'setCollapsed', collapsed: false })
  }
  return finish(state, draft)
}

/** Minimize a group to its edge strip, or bring it back. */
export function minimize<T extends DockTab>(state: LayoutState<T>, groupId: NodeId, minimized = true): Change<T> {
  if (!isGroup(state, groupId) || Boolean(getGroup(state, groupId).minimized) === minimized) return unchanged(state)
  const draft = new Draft(state).push({ type: 'setMinimized', groupId, minimized })
  if (minimized && state.maximizedGroup === groupId) draft.push({ type: 'setMaximized', groupId: null })
  return finish(state, draft)
}

/** Patch a tab's fields (id and type stay). */
export function updateTab<T extends DockTab>(state: LayoutState<T>, tabId: TabId, patch: Partial<T>): Change<T> {
  const tab = state.tabs[tabId]
  if (!tab) return unchanged(state)
  const next = { ...tab, ...patch, id: tab.id, type: tab.type }
  return sameRecord(next, tab) ? unchanged(state) : commit(state, [{ type: 'updateTab', tab: next }])
}

/** Look a tab up by id (undefined when closed). */
export const findTab = <T extends DockTab>(state: LayoutState<T>, tabId: TabId): T | undefined => state.tabs[tabId]

/** Every tab that shows in `ctx`, group by group in visual order (the narrow-screen merged strip). */
export const tabsInScope = <T extends DockTab>(state: LayoutState<T>, ctx: ScopeCtx): T[] =>
  groupIds(state).flatMap(id => visibleTabs(state, id, ctx))
