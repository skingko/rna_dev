/**
 * Workspace layout model (design 1.2): a normalized split tree whose leaves
 * are the conversation (`main`, exactly one, id `MAIN`) and tab groups. Tabs
 * are generic — the engine reads only `id`, `type` and `binding`; the store
 * plugs in its own tab union.
 *
 * The operation vocabulary is adapted from DeepSeek dockkit
 * (`ui-dockkit/src/contract/types.ts`, MIT, Copyright (c) 2026 DeepSeek; see
 * LICENSE-dockkit.md): every op carries the ids it creates, and applying one
 * returns the ops that undo it.
 */

export type NodeId = string
export type TabId = string
/** `s:<sessionId>` | `p:<projectId>` | `global` — the same keys as the v1 side panel. */
export type ScopeKey = string

export type Axis = 'row' | 'column'
/** Which side of the reference node a placed node takes. */
export type Side = 'before' | 'after'
export type Edge = 'left' | 'right' | 'top' | 'bottom'
/** The five drop regions a node offers a dragged tab. */
export type DropZone = 'center' | Edge

/** Decides when a tab shows: always, in one conversation, or in one project. */
export type Binding = 'workspace' | { session: string } | { project: string }

export interface DockTab {
  id: TabId
  type: string
  binding: Binding
}

/** What is selected in the app; decides which tabs a group shows. */
export interface ScopeCtx {
  sessionId?: string | null
  projectId?: string | null
}

export interface SplitNode {
  kind: 'split'
  axis: Axis
  /** At least two once settled. */
  children: NodeId[]
  /** Same length as `children`, each above zero, summing to 1. */
  sizes: number[]
}

export interface GroupNode {
  kind: 'group'
  tabIds: TabId[]
  /** Active tab per scope (today's `panes[scope].activeId`). */
  activeByScope: Record<ScopeKey, TabId>
  /** Shown as an icon on an edge strip; the user's choice, persisted. */
  minimized?: boolean
}

export interface MainNode { kind: 'main' }

export type LayoutNode = SplitNode | GroupNode | MainNode

export const MAIN: NodeId = 'main'

export interface LayoutState<T extends DockTab = DockTab> {
  version: 2
  root: NodeId
  nodes: Record<NodeId, LayoutNode>
  tabs: Record<TabId, T>
  activeGroup: NodeId | null
  /** Groups, most recently focused first: `auto` placement and squeezing on narrow screens read it. */
  recent: NodeId[]
  /** ⌥⌘B: every group hidden, geometry kept. */
  collapsed: boolean
  /** Temporary; never persisted. */
  maximizedGroup: NodeId | null
}

/** How a node is put into the tree. */
export type Placement =
  /** Beside `target`, taking `share` of its slot; `splitId` is used only when a new split must wrap `target`. */
  | { mode: 'edge'; target: NodeId; axis: Axis; side: Side; share: number; splitId: NodeId }
  /** Back into a split at `index`, restoring that split's sizes verbatim. */
  | { mode: 'child'; parent: NodeId; index: number; sizes: number[] }
  /** Re-create a collapsed split in `target`'s slot; `split` already lists both children. */
  | { mode: 'wrap'; target: NodeId; splitId: NodeId; split: SplitNode }

export type LayoutOp<T extends DockTab = DockTab> =
  /** Create an empty group and place it. */
  | { type: 'addGroup'; groupId: NodeId; group: GroupNode; at: Placement }
  /** Drop an empty group; a split left with one child collapses into it. */
  | { type: 'merge'; groupId: NodeId }
  /** Take a node out of the tree (it stays in `nodes` until re-attached in the same intent). */
  | { type: 'detach'; nodeId: NodeId }
  /** Put a detached node back into the tree. */
  | { type: 'attach'; nodeId: NodeId; at: Placement }
  /** Add a tab and focus it for `scope`. */
  | { type: 'openTab'; groupId: NodeId; tab: T; index: number; scope: ScopeKey }
  /** Add a tab without moving focus. */
  | { type: 'insertTab'; groupId: NodeId; tab: T; index: number }
  | { type: 'closeTab'; tabId: TabId }
  /** Move a tab to another group; focus it there unless `scope` is null. */
  | { type: 'moveTab'; tabId: TabId; groupId: NodeId; index: number; scope: ScopeKey | null }
  | { type: 'reorderTab'; tabId: TabId; index: number }
  /** Replace a tab record (same id). */
  | { type: 'updateTab'; tab: T }
  | { type: 'focusTab'; tabId: TabId; scope: ScopeKey }
  | { type: 'focusGroup'; groupId: NodeId }
  /** Set (or clear) one group's active tab for one scope without moving group focus. */
  | { type: 'setActive'; groupId: NodeId; scope: ScopeKey; tabId: TabId | null }
  | { type: 'resize'; splitId: NodeId; sizes: number[] }
  | { type: 'setCollapsed'; collapsed: boolean }
  | { type: 'setMaximized'; groupId: NodeId | null }
  | { type: 'setMinimized'; groupId: NodeId; minimized: boolean }
  /** Swap the whole structure (presets, normalization); tabs stay where the new groups list them. */
  | { type: 'replaceTree'; root: NodeId; nodes: Record<NodeId, LayoutNode> }
  /** Restore focus facts an op displaced. */
  | {
    type: 'restoreFocus'
    activeGroup: NodeId | null
    recent: NodeId[]
    maximizedGroup: NodeId | null
    groups: Record<NodeId, Record<ScopeKey, TabId>>
  }

/** Ops that only move focus; the sequencer folds runs of them into one undo step. */
export type FocusOpType = 'focusTab' | 'focusGroup' | 'setActive' | 'restoreFocus'

export interface ApplyResult<T extends DockTab = DockTab> {
  state: LayoutState<T>
  /** Ordered for application. */
  inverse: LayoutOp<T>[]
}

/** Deterministic id source injected by the caller (the engine never invents ids). */
export type Mint = (kind: 'group' | 'split' | 'tab') => string

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
