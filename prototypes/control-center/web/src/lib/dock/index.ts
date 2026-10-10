/** Workspace layout engine (WP1): pure, no React, no DOM. */
export * from './types'
export {
  activeTab, bindingMatches, counterMint, emptyGroup, emptyLayout, findParent, freshId, getGroup, getNode, getSplit, getTab,
  groupIds, isGroup, layoutProblems, scopeKey, tabGroupId, treeIds, visibleTabs,
} from './tree'
export { applyOp, applyOps, replay } from './operations'
export {
  besideMain, clampSizes, DEFAULT_SHARE, DOCK_EDGE_FRACTION, edgeSplit, MIN_FRACTION, normalizeNodes, planDropTab, planPlaceTab,
  planResizeDivider, planResizeSplit, planSettle, planSplitGroup, zoneAt,
} from './planner'
export {
  activateTab, closeAmong, closeGroup, closeTab, closeTabs, commit, findTab, focusGroup, groupsByRecency, maximize, minimize, moveGroup, moveTab,
  moveTabToward, openTab, resize, resizeDivider, setCollapsed, sideShare, splitGroup, tabsInScope, toggleCollapsed, updateTab,
  type Change, type DockPolicy, type OpenOptions, type OpenTarget,
} from './actions'
export {
  CARD_GAP, computeRects, insertionIndex, MIN_GROUP, MIN_MAIN, neighborNode, shareOf, STRIP, unitRects, vacantGroups, zoneInRect,
  type Divider, type Geometry, type GeometryOptions, type Strip,
} from './geometry'
export { arrange, arrangeTree, BOTTOM_TYPES, LEFT_TYPES, planArrange, TAB_WEIGHTS, type ArrangeOptions, type Preset } from './arrange'
export { defaultLayout, migrateV1, persistLayout, sanitizeLayout, V1_MAX_TABS, type MigrateOptions, type SanitizeOptions } from './migrate'
export {
  canStepBack, canStepForward, EMPTY_HISTORY, HISTORY_LIMIT, isFocusOp, push, record, recordedOps, Sequencer, stepBack, stepForward,
  type History, type HistoryEntry, type HistoryStep,
} from './sequence'
