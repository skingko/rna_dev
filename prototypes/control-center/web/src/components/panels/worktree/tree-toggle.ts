/**
 * ⇧⌘Y (worktree design §3.7): the workspace finds the visible, focused
 * 工作区改动 tab and asks its panel to show or hide the file tree. The panel
 * decides what that means at its width (a narrow panel opens the tree over
 * its diffs), so it registers the toggle here while it is mounted.
 */
const toggles = new Map<string, () => boolean>()

/** A mounted panel's toggle for its tab; returns the unregister function. The toggle says whether it did anything. */
export function registerTreeToggle(tabId: string, toggle: () => boolean): () => void {
  toggles.set(tabId, toggle)
  return () => { if (toggles.get(tabId) === toggle) toggles.delete(tabId) }
}

/** Show or hide the tab's file tree; false when no panel of that tab is mounted or it shows no tree (本次对话的改动, grouping by stage). */
export function toggleWorktreeTree(tabId: string): boolean {
  return toggles.get(tabId)?.() ?? false
}

/** The shortcut in the platform's notation. */
export const treeShortcut = (mac: boolean) => (mac ? '⇧⌘Y' : 'Ctrl+Shift+Y')
