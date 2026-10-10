/**
 * The workspace's layout commands, shared by the group menu (⋯), the tab
 * context menu and the shortcuts: one list of actions, drawn as dropdown or
 * context-menu items with the app's menu styling, submenus included.
 *
 * 布局 lists the presets, then the user's saved layouts (applied as one undo
 * step), 保存当前布局… and a submenu to delete a saved one (with 撤销 in the
 * toast that confirms it). A 文件 or 进化 tab (the one a group shows, the one
 * right-clicked) also offers 在主视图中打开: its page takes over.
 */
import type { ReactNode } from 'react'
import { ContextMenu as RContextMenu, DropdownMenu } from 'radix-ui'
import {
  AppWindow, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ChevronRight, Columns3, LayoutDashboard, LayoutGrid, LayoutTemplate,
  Maximize2, Minimize2, Minus, Move, PanelBottom, PanelRight, Redo2, Rows2, Save, SquareSplitHorizontal, SquareSplitVertical, Trash2, Undo2, X,
} from 'lucide-react'
import type { Edge, Preset } from '@/lib/dock'
import {
  applyPreset, applySavedLayout, closeGroup, deleteSavedLayout, maximizeGroup, minimizeGroup, moveGroup, moveTabToward, redoLayout, restoreSavedLayout, setPanelOpen,
  splitGroup, undoLayout, type SideTab,
} from '@/store/side-panel-store'
import type { SavedLayout } from '@/store/layout-persist'
import { isSurfaceKind, showInMainView } from '@/store/surface-router'
import { toast } from '@/store/ui-store'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export interface LayoutAction {
  key: string
  label: string
  icon?: ReactNode
  hint?: string
  disabled?: boolean
  danger?: boolean
  run?: () => void
  /** A submenu instead of a command. */
  items?: MenuEntry[]
}
export type MenuEntry = LayoutAction | 'separator'

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** Shortcut labels in the platform's notation. */
export const keys = {
  toggle: () => (isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'),
  split: () => (isMac() ? '⌥⌘\\' : 'Ctrl+Alt+\\'),
  reopen: () => (isMac() ? '⇧⌘T' : 'Ctrl+Shift+T'),
}

const EDGE_ICON: Record<Edge, ReactNode> = { left: <ArrowLeftToLine />, right: <ArrowRightToLine />, top: <ArrowUpToLine />, bottom: <ArrowDownToLine /> }

/** 移动到 左侧 / 右侧 / 顶部 / 底部: the whole group on that edge of the conversation. */
export const groupEdgeLabels = (): Record<Edge, string> => ({ left: t('左侧'), right: t('右侧'), top: t('顶部'), bottom: t('底部') })
/** 移到左/右/上/下侧的组: one tab toward that side. */
const tabEdgeLabels = (): Record<Edge, string> => ({ left: t('左侧的组'), right: t('右侧的组'), top: t('上方的组'), bottom: t('下方的组') })

export function presetActions(): LayoutAction[] {
  const presets: { id: Preset; label: string; icon: ReactNode }[] = [
    { id: 'sidebar', label: t('侧栏'), icon: <PanelRight /> },
    { id: 'bottom', label: t('底部'), icon: <PanelBottom /> },
    { id: 'right-stacked', label: t('右侧上下'), icon: <Rows2 /> },
    { id: 'three-column', label: t('三栏'), icon: <Columns3 /> },
    { id: 'fill', label: t('填充并排列'), icon: <LayoutDashboard /> },
  ]
  return presets.map(preset => ({ key: `preset-${preset.id}`, label: preset.label, icon: preset.icon, run: () => applyPreset(preset.id) }))
}

/** Apply a saved layout (one undo step). */
export function applySaved(layout: SavedLayout) {
  if (!applySavedLayout(layout.id)) toast(t('这个布局没能应用。'), 'danger')
}

/** Delete a saved layout; the toast offers it back. */
export function removeSaved(layout: SavedLayout) {
  const removed = deleteSavedLayout(layout.id)
  if (removed === undefined) return
  toast(t('已删除布局「{name}」。', { name: layout.name }), 'default', { action: { label: t('撤销'), run: () => restoreSavedLayout(layout.id, removed) } })
}

/** The 布局 submenu: presets, the saved layouts, and (given `onSave`) saving the current one and deleting a saved one. */
export function layoutActions(saved: SavedLayout[] = [], onSave?: () => void): MenuEntry[] {
  const entries: MenuEntry[] = presetActions()
  if (saved.length) entries.push('separator', ...saved.map(layout => ({ key: `saved-${layout.id}`, label: layout.name, icon: <LayoutTemplate />, run: () => applySaved(layout) })))
  if (!onSave) return entries
  entries.push('separator', { key: 'save-layout', label: t('保存当前布局…'), icon: <Save />, run: onSave })
  if (saved.length) {
    entries.push({
      key: 'delete-layout', label: t('删除已保存的布局'), icon: <Trash2 />,
      items: saved.map(layout => ({ key: `delete-${layout.id}`, label: layout.name, run: () => removeSaved(layout) })),
    })
  }
  return entries
}

export interface GroupMenuState {
  groupId: string
  maximized: boolean
  canUndo: boolean
  canRedo: boolean
  /** Edges of the conversation the group already sits on (moving there changes nothing). */
  besides?: Partial<Record<Edge, boolean>>
  /** Saved layouts, listed under 布局. */
  saved?: SavedLayout[]
  /** 保存当前布局…: asks for a name. */
  onSaveLayout?: () => void
  /** The tab the group shows (a 文件 or 进化 one opens in the main view from here). */
  shown?: SideTab | null
}

/** 在主视图中打开 for a 文件 or 进化 tab (its page takes over, the panel closes); nothing for other tabs. */
export function surfaceActions(tab: SideTab | null | undefined): LayoutAction[] {
  if (!tab || !isSurfaceKind(tab.type)) return []
  return [{ key: 'show-in-main', label: t('在主视图中打开'), icon: <AppWindow />, run: () => showInMainView(tab.id) }]
}

/** The group menu (⋯): 在主视图中打开 (文件 / 进化), split, move, maximize, minimize, close, layouts (presets and saved ones), undo. */
export function groupActions(state: GroupMenuState): MenuEntry[] {
  const { groupId } = state
  const edges = groupEdgeLabels()
  const surface = surfaceActions(state.shown)
  return [
    ...(surface.length ? [...surface, 'separator' as const] : []),
    { key: 'split-right', label: t('向右拆分'), icon: <SquareSplitHorizontal />, hint: keys.split(), run: () => splitGroup(groupId, 'right') },
    { key: 'split-down', label: t('向下拆分'), icon: <SquareSplitVertical />, run: () => splitGroup(groupId, 'down') },
    {
      key: 'move', label: t('移动到'), icon: <Move />,
      items: (['left', 'right', 'top', 'bottom'] as const).map(edge => ({ key: `move-${edge}`, label: edges[edge], icon: EDGE_ICON[edge], disabled: Boolean(state.besides?.[edge]), run: () => moveGroup(groupId, edge) })),
    },
    state.maximized
      ? { key: 'restore', label: t('还原'), icon: <Minimize2 />, run: () => maximizeGroup(null) }
      : { key: 'maximize', label: t('最大化'), icon: <Maximize2 />, run: () => maximizeGroup(groupId) },
    { key: 'minimize', label: t('最小化'), icon: <Minus />, run: () => minimizeGroup(groupId) },
    { key: 'close-group', label: t('关闭整组'), icon: <X />, run: () => closeGroup(groupId) },
    'separator',
    { key: 'layout', label: t('布局'), icon: <LayoutGrid />, items: layoutActions(state.saved, state.onSaveLayout) },
    { key: 'undo', label: t('撤销布局更改'), icon: <Undo2 />, disabled: !state.canUndo, run: () => { undoLayout() } },
    { key: 'redo', label: t('重做布局更改'), icon: <Redo2 />, disabled: !state.canRedo, run: () => { redoLayout() } },
    'separator',
    { key: 'hide', label: t('收起全部面板'), hint: keys.toggle(), run: () => setPanelOpen(false) },
  ]
}

/** The tab context menu's layout part: move toward a side, or split it off. */
export function tabLayoutActions(groupId: string, tabId: string): MenuEntry[] {
  const edges = tabEdgeLabels()
  return [
    {
      key: 'move-tab', label: t('移动标签'), icon: <Move />,
      items: (['left', 'right', 'top', 'bottom'] as const).map(edge => ({ key: `tab-${edge}`, label: edges[edge], icon: EDGE_ICON[edge], run: () => moveTabToward(tabId, edge) })),
    },
    { key: 'tab-split-right', label: t('向右拆分'), icon: <SquareSplitHorizontal />, run: () => splitGroup(groupId, 'right', tabId) },
    { key: 'tab-split-down', label: t('向下拆分'), icon: <SquareSplitVertical />, run: () => splitGroup(groupId, 'down', tabId) },
  ]
}

/* ---------------------------------------------------------------- drawing */

const itemClass = cn(
  'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 outline-none transition-colors duration-100',
  'data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3',
)
const contentClass = 'menu-content z-50 min-w-44 max-w-72 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none'

function Label({ action }: { action: LayoutAction }) {
  return (
    <>
      {action.icon ?? <span className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.hint && <span className="shrink-0 text-[12px] text-fg-4">{action.hint}</span>}
      {action.items && <ChevronRight className="!size-3.5 text-fg-4" />}
    </>
  )
}

/** Dropdown items (the ⋯ menu). */
export function DropdownEntries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, i) => {
    if (entry === 'separator') return <DropdownMenu.Separator key={`sep-${i}`} className="mx-1 my-1 h-px bg-line-faint" />
    if (entry.items) {
      return (
        <DropdownMenu.Sub key={entry.key}>
          <DropdownMenu.SubTrigger className={itemClass} data-action={entry.key} disabled={entry.disabled}><Label action={entry} /></DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent sideOffset={6} collisionPadding={10} className={contentClass}><DropdownEntries entries={entry.items} /></DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )
    }
    return (
      <DropdownMenu.Item key={entry.key} data-action={entry.key} disabled={entry.disabled} onSelect={entry.run} className={cn(itemClass, entry.danger && 'text-danger [&_svg]:text-danger')}>
        <Label action={entry} />
      </DropdownMenu.Item>
    )
  })
}

/** Context-menu items (right-click on a tab). */
export function ContextEntries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, i) => {
    if (entry === 'separator') return <RContextMenu.Separator key={`sep-${i}`} className="mx-1 my-1 h-px bg-line-faint" />
    if (entry.items) {
      return (
        <RContextMenu.Sub key={entry.key}>
          <RContextMenu.SubTrigger className={itemClass} data-action={entry.key} disabled={entry.disabled}><Label action={entry} /></RContextMenu.SubTrigger>
          <RContextMenu.Portal>
            <RContextMenu.SubContent sideOffset={6} collisionPadding={10} className={contentClass}><ContextEntries entries={entry.items} /></RContextMenu.SubContent>
          </RContextMenu.Portal>
        </RContextMenu.Sub>
      )
    }
    return (
      <RContextMenu.Item key={entry.key} data-action={entry.key} disabled={entry.disabled} onSelect={entry.run} className={cn(itemClass, entry.danger && 'text-danger [&_svg]:text-danger')}>
        <Label action={entry} />
      </RContextMenu.Item>
    )
  })
}
