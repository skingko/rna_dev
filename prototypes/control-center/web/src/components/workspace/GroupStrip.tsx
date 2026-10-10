/**
 * A tab group's strip: tabs (icon · title · close), "+" for the chooser, the
 * maximize toggle and the group menu (⋯). Keyboard: ←/→/Home/End move between
 * tabs (and activate), Delete closes, Alt+←/→ reorders; middle-click closes;
 * tabs drag to another strip or onto an edge of a group or the conversation.
 * Right-click a tab: close it, the others, those to its left or right, or all
 * of them (in this group), move it toward a side, or split it off; a 文件 or
 * 进化 tab also opens in the main view.
 *
 * Resting the pointer on "+" shows the kinds of tab to open into this group;
 * on the maximize button, where to move the group, maximizing it and
 * arranging every group (strip-menus.tsx). Their clicks stay as they were.
 *
 * A merged strip (the phone sheet, a window too narrow for the conversation
 * beside a group) lists every group's tabs, groups in visual order with a thin
 * rule between them; its menu closes among the tabs it lists, and picking a
 * tab of another group brings that group up. Its chips do not drag.
 */
import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { DropdownMenu } from 'radix-ui'
import { ArrowLeftToLine, ArrowRightToLine, ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp, Maximize2, Minimize2, MoreHorizontal, Plus, X } from 'lucide-react'
import { activeTab, besideMain, type Edge } from '@/lib/dock'
import {
  activateTab, closeAmongTabs, closeOtherTabs, closeTab, closeTabsBeside, maximizeGroup, moveTab, openLauncher, setPanelOpen, useCanRedo, useCanUndo, useSavedLayouts,
  useSidePanel, type SideTab,
} from '@/store/side-panel-store'
import { IconButton } from '@/components/ui/primitives'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Menu, MenuTrigger } from '@/components/ui/overlays'
import { cn } from '@/lib/utils'
import { TabIcon, useTabTitle } from '@/components/side-panel/tab-meta'
import { ContextEntries, DropdownEntries, groupActions, surfaceActions, tabLayoutActions } from './menus'
import { TAB_MIME } from './drag'
import { SaveLayoutDialog } from './SaveLayoutDialog'
import { HoverMenu } from './hover-menu'
import { LayoutMenu, NewTabMenu } from './strip-menus'
import { useT } from '@/i18n'

export const STRIP_HEIGHT = 40

const COLLAPSE_ICON: Record<Edge, typeof ChevronsRight> = { right: ChevronsRight, left: ChevronsLeft, bottom: ChevronsDown, top: ChevronsUp }

export interface GroupStripProps {
  groupId: string
  /** The tabs this group shows for the selected conversation, in strip order. */
  tabs: SideTab[]
  activeId: string | null
  /** The focused group (marks its active tab more strongly when several groups show). */
  focused: boolean
  /** Several groups show: the collapse button moves into the group menu. */
  multi: boolean
  /** Which side of the conversation the group sits on (the collapse arrow points there). */
  edge: Edge
  maximized: boolean
  /** Drawn over the conversation (narrow window) or as the phone sheet. */
  overlay: boolean
  mobile: boolean
  /** A merged strip: `tabs` are every group's, and this maps each to its own group. */
  merged?: ReadonlyMap<string, string> | null
  onDragTab?: (tabId: string, groupId: string) => void
  onDragEnd?: () => void
}

export function GroupStrip({ groupId, tabs, activeId, focused, multi, edge, maximized, overlay, mobile, merged = null, onDragTab, onDragEnd }: GroupStripProps) {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)
  const Collapse = mobile ? ChevronsDown : COLLAPSE_ICON[edge]

  // Keep the active tab visible when it changes (new tab, keyboard, reuse).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')
    if (!target) return
    const id = target.dataset.tabId!
    const index = tabs.findIndex(tab => tab.id === id)
    const focus = (next: string | undefined) => { if (!next) return; activateTab(next); requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus()) }
    // Reordering moves a tab within its own group, which a merged strip does not show as such.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { if (merged) return; e.preventDefault(); moveTab(id, e.key === 'ArrowLeft' ? -1 : 1); requestAnimationFrame(() => target.focus()); return }
    // Other modified keys are the workspace's (⌥⌘ arrows move focus between groups).
    if (e.altKey || ((e.metaKey || e.ctrlKey) && e.key !== 'Backspace')) return
    if (e.key === 'ArrowRight') { e.preventDefault(); focus(tabs[(index + 1) % tabs.length]?.id) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(tabs[(index - 1 + tabs.length) % tabs.length]?.id) }
    else if (e.key === 'Home') { e.preventDefault(); focus(tabs[0]?.id) }
    else if (e.key === 'End') { e.preventDefault(); focus(tabs.at(-1)?.id) }
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      const rest = tabs.filter(tab => tab.id !== id)
      closeTab(id)
      focus(rest[Math.min(index, rest.length - 1)]?.id)
    }
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line-faint px-1.5" data-group-strip={groupId}>
      {(!multi || overlay) && (
        <IconButton label={t('收起侧边面板')} onClick={() => setPanelOpen(false)}><Collapse /></IconButton>
      )}
      <div ref={listRef} role="tablist" aria-label={t('侧边面板标签')} aria-orientation="horizontal" onKeyDown={onKey}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scroll-quiet [scrollbar-width:none]">
        <AnimatePresence initial={false}>
          {tabs.map((tab, index) => {
            const owner = merged?.get(tab.id) ?? groupId
            const rule = merged && index > 0 && merged.get(tabs[index - 1].id) !== owner
            return (
              <Fragment key={tab.id}>
                {rule && <span aria-hidden data-group-rule className="mx-1 h-4 w-px shrink-0 bg-line" />}
                <TabChip tab={tab} groupId={owner} active={tab.id === activeId} strong={focused || !multi} index={index} count={tabs.length}
                  draggable={!mobile && !merged} layoutMenu={!mobile} among={merged ? { listed: tabs, shownId: activeId } : null} onDragTab={onDragTab} onDragEnd={onDragEnd} />
              </Fragment>
            )
          })}
        </AnimatePresence>
      </div>
      <HoverMenu name="new-tab" label={t('选择要打开的标签')} content={menu => <NewTabMenu groupId={groupId} onDone={menu.close} />}>
        <IconButton label={t('新增标签')} tooltip={false} aria-keyshortcuts="ArrowDown" onClick={() => openLauncher(groupId)}><Plus /></IconButton>
      </HoverMenu>
      {!mobile && !overlay && (
        <HoverMenu name="layout" label={t('布局选项')} content={menu => <LayoutMenu groupId={groupId} edge={edge} maximized={maximized} onDone={menu.close} />}>
          <IconButton label={maximized ? t('还原') : t('最大化')} tooltip={false} aria-keyshortcuts="ArrowDown" active={maximized} onClick={() => maximizeGroup(maximized ? null : groupId)}>
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </HoverMenu>
      )}
      {!mobile && <GroupMenu groupId={groupId} maximized={maximized} />}
    </div>
  )
}

function GroupMenu({ groupId, maximized }: { groupId: string; maximized: boolean }) {
  const t = useT()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  // 保存当前布局… names the layout in a dialog that opens once the menu has closed: the menu would otherwise hand the
  // keyboard back to ⋯ after the name field took it.
  const [saving, setSaving] = useState(false)
  const askName = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button ref={trigger} type="button" aria-label={t('面板操作')} data-group-menu={groupId}
            className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-active [&_svg]:size-4">
            <MoreHorizontal />
          </button>
        </MenuTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={10}
            className="menu-content z-50 w-56 min-w-48 overflow-hidden rounded-xl bg-elevated p-1 text-[13px] text-fg shadow-lg outline-none"
            onCloseAutoFocus={e => {
              if (!askName.current) return
              askName.current = false
              e.preventDefault()
              trigger.current?.focus()
              setSaving(true)
            }}>
            <GroupMenuEntries groupId={groupId} maximized={maximized} canUndo={canUndo} canRedo={canRedo} onSaveLayout={() => { askName.current = true }} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </Menu>
      <SaveLayoutDialog open={saving} onOpenChange={setSaving} />
    </>
  )
}

/** Read when the menu opens, so "move to" knows where the group sits now and what it shows. */
function GroupMenuEntries({ groupId, maximized, canUndo, canRedo, onSaveLayout }: { groupId: string; maximized: boolean; canUndo: boolean; canRedo: boolean; onSaveLayout: () => void }) {
  const { layout, ctx } = useSidePanel.getState()
  const saved = useSavedLayouts()
  const besides = Object.fromEntries((['left', 'right', 'top', 'bottom'] as const).map(edge => [edge, layout.nodes[groupId] ? besideMain(layout, groupId, edge) : false]))
  const shown = layout.nodes[groupId] ? activeTab(layout, groupId, ctx) : null
  return <DropdownEntries entries={groupActions({ groupId, maximized, canUndo, canRedo, besides, saved, onSaveLayout, shown })} />
}

interface TabChipProps {
  /** Its own group (also on a merged strip). */
  groupId: string
  tab: SideTab
  active: boolean
  /** The group is focused (or alone): the active tab gets the strong fill. */
  strong: boolean
  /** Its place among the chips drawn, and how many there are. */
  index: number
  count: number
  draggable: boolean
  /** The menu offers moving and splitting (not on the phone sheet). */
  layoutMenu: boolean
  /** On a merged strip: the chips it lists and the one it shows, which the close entries act on. */
  among: { listed: SideTab[]; shownId: string | null } | null
  onDragTab?: (tabId: string, groupId: string) => void
  onDragEnd?: () => void
}

function TabChip({ tab, groupId, active, strong, index, count, draggable, layoutMenu, among, onDragTab, onDragEnd }: TabChipProps) {
  const t = useT()
  const title = useTabTitle(tab)
  const onDragStart = (e: DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(TAB_MIME, tab.id)
    e.dataTransfer.effectAllowed = 'move'
    onDragTab?.(tab.id, groupId)
  }
  // 在主视图中打开 for a 文件 or 进化 tab.
  const surface = surfaceActions(tab)
  // What the user sees is what closes: the chips of this strip (its group's, or every group's when merged).
  const closeBeside = (side: 'others' | 'left' | 'right' | 'all') => {
    if (among) closeAmongTabs(tab.id, side, among.listed.map(other => other.id), among.shownId)
    else if (side === 'others') closeOtherTabs(tab.id)
    else closeTabsBeside(tab.id, side)
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          layout="position"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', stiffness: 560, damping: 40, mass: 0.7 }}
          className={cn('group/tab relative flex h-7 max-w-[176px] shrink-0 items-center rounded-md transition-colors duration-150',
            active ? (strong ? 'bg-active text-fg' : 'bg-hover text-fg-2') : 'text-fg-3 hover:bg-hover hover:text-fg-2')}
        >
          <button
            type="button"
            role="tab"
            data-tab-id={tab.id}
            data-tab-type={tab.type}
            aria-selected={active}
            aria-controls={`side-tab-${tab.id}`}
            tabIndex={active ? 0 : -1}
            title={title}
            draggable={draggable}
            onDragStart={draggable ? onDragStart : undefined}
            onDragEnd={draggable ? onDragEnd : undefined}
            onClick={() => activateTab(tab.id)}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id) } }}
            className="flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]"
          >
            <TabIcon tab={tab} className="size-3.5 shrink-0" />
            <span className={cn('min-w-0 truncate', active && 'font-medium')}>{title}</span>
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('关闭 {title}', { title })}
            onClick={() => closeTab(tab.id)}
            className={cn('mr-1 grid size-5 shrink-0 place-items-center rounded text-fg-4 transition-opacity hover:bg-hover hover:text-fg', active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100')}
          >
            <X className="size-3" />
          </button>
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<X />} onSelect={() => closeTab(tab.id)}>{t('关闭')}</ContextMenuItem>
        <ContextMenuItem disabled={count < 2} onSelect={() => closeBeside('others')}>{t('关闭其他标签')}</ContextMenuItem>
        <ContextMenuItem icon={<ArrowLeftToLine />} disabled={index === 0} onSelect={() => closeBeside('left')}>{t('关闭左侧标签')}</ContextMenuItem>
        <ContextMenuItem icon={<ArrowRightToLine />} disabled={index >= count - 1} onSelect={() => closeBeside('right')}>{t('关闭右侧标签')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => closeBeside('all')}>{t('关闭全部标签')}</ContextMenuItem>
        {surface.length > 0 && <><ContextMenuSeparator /><ContextEntries entries={surface} /></>}
        {layoutMenu && <><ContextMenuSeparator /><ContextEntries entries={tabLayoutActions(groupId, tab.id)} /></>}
      </ContextMenuContent>
    </ContextMenu>
  )
}
