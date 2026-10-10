/**
 * The workspace (design 1.4, WP3): the conversation is the fixed `main` cell
 * and every panel group gets a strip, all laid out from the layout tree by
 * `computeRects` inside one measured container.
 *
 * Rendering keeps every body where React put it: the conversation and all tab
 * bodies are flat sibling cells, absolutely positioned into their group's
 * rectangle and rendered in mount order. Moving, splitting, collapsing or
 * switching conversations only changes a cell's position and visibility —
 * never its DOM parent or its place among siblings — so a `<webview>` keeps
 * its page and a terminal its shell. Keep-alive bodies stay mounted while
 * hidden (cells.ts caps them). No transform sits on a common ancestor; cells
 * glide with left/top/width/height transitions.
 *
 * Groups are cards: rounded, edged and softly shadowed, `CARD_GAP` apart and
 * from the window's edges over a slightly different ground, the conversation
 * reaching to the edges it touches; the dividers live in the gaps.
 *
 * Space: groups that do not fit are squeezed onto an edge strip, and a group
 * with nothing to show for the selected conversation takes none; when not even
 * the conversation plus one group fits, one group is drawn over the
 * conversation, its strip merging every group's tabs (picking another group's
 * tab brings that group up). Below 768 px the panel is today's bottom sheet
 * with the same merged strip.
 *
 * Pointer positions are read in layout pixels: the interface zoom scales what
 * the browser reports for the pointer and for element boxes (cells.ts).
 */
import './builtin-panels'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { motion } from 'motion/react'
import { PanelTop } from 'lucide-react'
import {
  activeTab, computeRects, getGroup, groupIds, groupsByRecency, isGroup, MAIN, neighborNode, resizeDivider as planResize, tabGroupId, unitRects, vacantGroups, visibleTabs,
  type Divider, type Edge, type Geometry, type LayoutState, type NodeId, type Rect, type Size, type Strip,
} from '@/lib/dock'
import {
  closeTab, focusGroup, maximizeGroup, minimizeGroup, moveTabTo, moveTabToward, panelsOpen, placeTab, reopenClosedTab, resizeDivider, setPanelOpen,
  setSheet, setViewport, shownTab, sideShares, splitGroup, togglePanel, useSidePanel, type SideTab, type WorkspaceCtx,
} from '@/store/side-panel-store'
import { setDockWidth } from '@/store/ui-store'
import { normalizeAddress } from '@/lib/browser-url'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '@/components/ui/primitives'
import { Launcher } from '@/components/side-panel/Launcher'
import { openBrowserTab } from '@/components/side-panel/open'
import { TabIcon, useTabTitle } from '@/components/side-panel/tab-meta'
import { isKeepAlive, usePanel, type PanelContext } from './registry'
import { bodyRect, CARD_GAP, layoutScale, nextMounted, rectStyle, toLayout, type MountEntry } from './cells'
import { dropLeaves, dropTargetAt, TAB_MIME, type DropTarget } from './drag'
import { GroupStrip, STRIP_HEIGHT } from './GroupStrip'
import { isMac } from './menus'
import { toggleWorktreeTree } from '@/components/panels/worktree/tree-toggle'
import { useT } from '@/i18n'

/** Phone sheet: below the 40 px top bar, its strip on top. */
const SHEET_TOP = 40
const ARROWS: Record<string, Edge> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-terminal-host]'

/** Which side of the conversation a group sits on. */
function edgeOfGroup(unit: Record<NodeId, Rect>, id: NodeId): Edge {
  const g = unit[id], m = unit[MAIN]
  if (!g || !m) return 'right'
  if (g.x >= m.x + m.width - 1e-6) return 'right'
  if (g.x + g.width <= m.x + 1e-6) return 'left'
  if (g.y >= m.y + m.height - 1e-6) return 'bottom'
  return 'top'
}

/** The container's size; cell transitions pause while it changes (`layout-instant`). */
function useContainerSize(ref: RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = (width: number, height: number) => {
      el.classList.add('layout-instant')
      clearTimeout(timer)
      timer = setTimeout(() => el.classList.remove('layout-instant'), 160)
      const next = { width: Math.round(width), height: Math.round(height) }
      setSize(prev => (prev.width === next.width && prev.height === next.height ? prev : next))
      if (next.width > 0 && next.height > 0) setViewport(next)
    }
    // Layout pixels (as ResizeObserver reports them), not the zoomed box getBoundingClientRect gives.
    measure(el.clientWidth, el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return () => clearTimeout(timer)
    const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect) measure(rect.width, rect.height) })
    observer.observe(el)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [ref])
  return size
}

/** A divider drag's sizes for one split, shown before they are committed. */
interface SizesPreview { split: NodeId; sizes: number[] }

/** The live layout with a dragged split's sizes: tabs opened and bodies updated meanwhile show at once. */
function withPreview(layout: LayoutState<SideTab>, preview: SizesPreview | null): LayoutState<SideTab> {
  const node = preview ? layout.nodes[preview.split] : undefined
  if (!preview || node?.kind !== 'split' || node.sizes.length !== preview.sizes.length) return layout
  return { ...layout, nodes: { ...layout.nodes, [preview.split]: { ...node, sizes: preview.sizes } } }
}

export function WorkspaceHost({ mobile, children }: { mobile: boolean; children: ReactNode }) {
  const t = useT()
  const layout = useSidePanel(s => s.layout)
  const ctx = useSidePanel(s => s.ctx)
  const container = useRef<HTMLDivElement>(null)
  const size = useContainerSize(container)
  const region = useRef<{ group: NodeId | null }>({ group: null })
  // A divider drag shows its sizes here first and commits one change on release; everything else stays live.
  const [preview, setPreview] = useState<SizesPreview | null>(null)
  const [drag, setDrag] = useState<{ tabId: string; source: NodeId } | null>(null)
  const shown = useMemo(() => withPreview(layout, preview), [layout, preview])
  const measured = size.width > 0 && size.height > 0
  useEffect(() => { setSheet(mobile) }, [mobile])

  // The phone sheet and an unmeasured container draw no groups in the tree.
  const geometry = useMemo(() => computeRects(mobile || !measured ? { ...shown, collapsed: true } : shown, size, { ctx, gap: CARD_GAP }), [shown, size, mobile, measured, ctx])
  const groups = useMemo(() => groupIds(shown), [shown])
  const unit = useMemo(() => unitRects(shown), [shown])
  const owner = useMemo(() => {
    const map = new Map<string, NodeId>()
    for (const id of groups) for (const tabId of getGroup(shown, id).tabIds) map.set(tabId, id)
    return map
  }, [shown, groups])
  const views = useMemo(() => new Map(groups.map(id => [id, { tabs: visibleTabs(shown, id, ctx), active: activeTab(shown, id, ctx) }])), [shown, groups, ctx])
  const drawn = groups.filter(id => geometry.rects[id])
  const covered = Boolean(geometry.maximized || geometry.compact)

  // The phone sheet and a narrow window's overlay: one strip with every group's tabs (groups in visual order).
  const mergedTabs = useMemo(() => (mobile || geometry.compact ? groups.flatMap(id => views.get(id)?.tabs ?? []) : []), [mobile, geometry.compact, groups, views])
  const sheetOpen = mobile && measured && panelsOpen(shown)
  const sheetActive = mobile ? shownTab(shown, ctx) : null
  const sheetGroup = sheetActive ? owner.get(sheetActive.id) ?? null : groupsByRecency(shown)[0] ?? null

  const visible = new Set<string>()
  if (mobile) { if (sheetOpen && sheetActive) visible.add(sheetActive.id) } else for (const id of drawn) { const tab = views.get(id)?.active; if (tab) visible.add(tab.id) }

  // Mounted bodies, in mount order (derived from the previous render: state set during render).
  const [log, setLog] = useState<readonly MountEntry[]>([])
  const mounted = nextMounted(log, { tabs: Object.values(shown.tabs), shown: visible, keepAlive: isKeepAlive })
  if (mounted !== log) setLog(mounted)

  useDesktopPopups()
  useWorkspaceKeys(container, region, mobile)

  const noteRegion = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null
    const group = el?.closest('[data-group-id]')?.getAttribute('data-group-id') ?? null
    region.current.group = group
    if (group && isGroup(useSidePanel.getState().layout, group) && useSidePanel.getState().layout.activeGroup !== group) focusGroup(group)
  }

  const startResize = (divider: Divider, event: ReactPointerEvent) => {
    event.preventDefault()
    const startLayout = useSidePanel.getState().layout
    const startGeometry = geometry
    const row = divider.axis === 'row'
    const origin = row ? event.clientX : event.clientY
    // The pointer moves in screen pixels; the geometry is in layout pixels (they differ under the interface zoom).
    const scale = container.current ? layoutScale(container.current) : 1
    const offset = (ev: PointerEvent) => ((row ? ev.clientX : ev.clientY) - origin) / scale
    let delta = 0
    let frame = 0
    const move = (ev: PointerEvent) => {
      delta = offset(ev)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const node = planResize(startLayout, startGeometry, divider, delta).state.nodes[divider.split]
        setPreview(node?.kind === 'split' ? { split: divider.split, sizes: node.sizes } : null)
      })
    }
    const up = (ev: PointerEvent) => {
      delta = offset(ev)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      cancelAnimationFrame(frame)
      document.body.style.cursor = ''
      document.body.classList.remove('layout-resizing')
      setPreview(null)
      commitResize(startGeometry, divider, delta, size, ctx)
    }
    document.body.style.cursor = row ? 'col-resize' : 'row-resize'
    // Frames (browser / webview) swallow pointer events mid-drag unless disabled; transitions would lag the pointer.
    document.body.classList.add('layout-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const leaves = dropLeaves(drawn, covered)

  return (
    <div ref={container} className="workspace layout-instant relative min-h-0 min-w-0 flex-1 bg-gutter" data-workspace
      onPointerDownCapture={e => noteRegion(e.target)} onFocusCapture={e => noteRegion(e.target)}>
      <div data-cell="main" className="workspace-cell absolute z-0 flex min-h-0 min-w-0 flex-col bg-base" style={rectStyle(measured ? geometry.mainCell : { x: 0, y: 0, width: size.width, height: size.height })} inert={covered || undefined}>
        {children}
      </div>
      {/* A maximized or overlay card stands on the gutter's ground, not on the conversation it covers. */}
      {!mobile && covered && <div aria-hidden data-covered className="absolute inset-0 z-[5] bg-gutter" />}

      {!mobile && drawn.map(id => (
        <GroupFrame key={id} groupId={id} rect={geometry.rects[id]} tabs={geometry.compact ? mergedTabs : views.get(id)?.tabs ?? []} active={views.get(id)?.active ?? null}
          focused={shown.activeGroup === id} multi={drawn.length > 1} edge={edgeOfGroup(unit, id)} maximized={geometry.maximized === id}
          overlay={geometry.compact} merged={geometry.compact ? owner : null} ctx={ctx}
          onDragTab={(tabId, source) => { setTimeout(() => setDrag({ tabId, source }), 0) }} onDragEnd={() => setDrag(null)} />
      ))}

      {sheetOpen && sheetGroup && (
        <motion.div className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl bg-base shadow-lg" style={{ top: SHEET_TOP }} data-group-id={sheetGroup}
          initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 40, mass: 0.9 }}
          role="region" aria-label={t('侧边面板')} data-side-panel>
          <GroupStrip groupId={sheetGroup} tabs={mergedTabs} activeId={sheetActive?.id ?? null} focused multi={false} edge="bottom" maximized={false} overlay mobile merged={owner} />
          {!sheetActive && <Launcher tabId={null} groupId={sheetGroup} sessionId={ctx.sessionId} projectId={ctx.projectId} />}
        </motion.div>
      )}

      {mounted.map(entry => {
        const tab = shown.tabs[entry.id]
        const groupId = owner.get(entry.id)
        if (!tab || !groupId) return null
        const rect = !mobile && geometry.rects[groupId] ? bodyRect(geometry.rects[groupId], STRIP_HEIGHT) : null
        return (
          <TabCell key={tab.id} tab={tab} groupId={groupId} visible={visible.has(tab.id)} mobile={mobile} sessionId={ctx.sessionId} projectId={ctx.projectId}
            x={rect?.x ?? 0} y={rect?.y ?? 0} width={rect?.width ?? 0} height={rect?.height ?? 0} />
        )
      })}

      {!mobile && !preview && !drag && geometry.dividers.map(divider => (
        <DividerHandle key={`${divider.split}:${divider.before}:${divider.after}`} divider={divider} gap={geometry.gap} onStart={startResize}
          onNudge={delta => commitResize(geometry, divider, delta, size, ctx)} />
      ))}
      {!mobile && preview && geometry.dividers.map(divider => <DividerLine key={`${divider.split}:${divider.before}:${divider.after}`} divider={divider} />)}

      {!mobile && geometry.strips.map(strip => <EdgeStrip key={strip.edge} strip={strip} layout={shown} ctx={ctx} squeezed={geometry.squeezed} />)}

      {!mobile && drag && (
        <DropOverlay drag={drag} geometry={geometry} leaves={leaves} container={container} onDone={() => setDrag(null)} />
      )}
    </div>
  )
}

/** Commit a divider move; a group beside the conversation also becomes the preferred side width. */
function commitResize(geometry: Geometry, divider: Divider, delta: number, size: Size, ctx: WorkspaceCtx) {
  if (!delta) return
  resizeDivider(geometry, divider, delta)
  if (divider.axis !== 'row' || (divider.beforeNode !== MAIN && divider.afterNode !== MAIN)) return
  const side = divider.beforeNode === MAIN ? divider.afterNode : divider.beforeNode
  const layout = useSidePanel.getState().layout
  if (!isGroup(layout, side)) return
  // The dock width is read back as a share of the whole frame (sideShares → shareOf), so it is the group's slot, gaps
  // included, not the card drawn inside it: a group opened later is then as wide as this one.
  const split = layout.nodes[divider.split], index = split?.kind === 'split' ? split.children.indexOf(side) : -1
  const card = computeRects(layout, size, { ctx, gap: CARD_GAP }).rects[side]?.width
  const width = divider.split === layout.root && split?.kind === 'split' && index >= 0 ? split.sizes[index] * size.width : card ? card + 2 * CARD_GAP : 0
  if (width) setDockWidth(Math.round(width))
}

/* ------------------------------------------------------------------ frame */

interface GroupFrameProps {
  groupId: NodeId
  rect: Rect
  /** What its strip lists: its own tabs, or every group's on a narrow window's overlay (`merged`). */
  tabs: SideTab[]
  active: SideTab | null
  focused: boolean
  multi: boolean
  edge: Edge
  maximized: boolean
  overlay: boolean
  merged: ReadonlyMap<string, NodeId> | null
  ctx: WorkspaceCtx
  onDragTab: (tabId: string, source: NodeId) => void
  onDragEnd: () => void
}

/** A group's card: its strip and background; an empty group shows the chooser. Bodies are separate cells above it. */
function GroupFrame({ groupId, rect, tabs, active, focused, multi, edge, maximized, overlay, merged, ctx, onDragTab, onDragEnd }: GroupFrameProps) {
  const t = useT()
  return (
    <section className="workspace-cell workspace-card absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-base" style={rectStyle(rect)}
      data-group-id={groupId} data-side-panel aria-label={t('侧边面板')}>
      <GroupStrip groupId={groupId} tabs={tabs} activeId={active?.id ?? null} focused={focused} multi={multi} edge={edge} maximized={maximized} overlay={overlay} mobile={false}
        merged={merged} onDragTab={onDragTab} onDragEnd={onDragEnd} />
      {!active && <Launcher tabId={null} groupId={groupId} sessionId={ctx.sessionId} projectId={ctx.projectId} />}
    </section>
  )
}

/* ------------------------------------------------------------------- cells */

interface TabCellProps {
  tab: SideTab
  groupId: NodeId
  visible: boolean
  mobile: boolean
  sessionId: string | null
  projectId: string | null
  x: number
  y: number
  width: number
  height: number
}

/** One tab body. Its element is created once and only ever restyled (moving it would reset a webview). */
const TabCell = memo(function TabCell({ tab, groupId, visible, mobile, sessionId, projectId, x, y, width, height }: TabCellProps) {
  const def = usePanel(tab.type)
  const title = useTabTitle(tab)
  const panel = useMemo<PanelContext>(() => ({ sessionId, projectId, visible, groupId }), [sessionId, projectId, visible, groupId])
  const style = mobile ? { position: 'fixed' as const, left: 0, right: 0, top: SHEET_TOP + STRIP_HEIGHT, bottom: 0 } : { left: x, top: y, width, height }
  return (
    <div id={`side-tab-${tab.id}`} role="tabpanel" aria-label={title} hidden={!visible} data-tab-cell={tab.id} data-tab-type={tab.type} data-group-id={groupId}
      className={cn('workspace-cell absolute min-h-0 min-w-0 flex-col bg-base', mobile ? 'z-[41]' : 'workspace-card-body z-20 overflow-hidden', visible ? 'flex' : 'hidden')} style={style}>
      {def ? def.render(tab, panel) : <UnknownPanel tab={tab} />}
    </div>
  )
})

/** A tab whose panel is not registered (yet): say so plainly. */
function UnknownPanel({ tab }: { tab: SideTab }) {
  const t = useT()
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6" data-unknown-panel={tab.type}>
      <div className="flex max-w-[300px] flex-col items-center gap-2 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-subtle text-fg-3"><PanelTop className="size-5" /></span>
        <p className="text-[13.5px] font-medium text-fg">{t('这个面板暂时无法显示')}</p>
        <p className="text-[12.5px] leading-relaxed text-fg-3">{t('此类面板在当前版本中还不可用。')}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => closeTab(tab.id)}>{t('关闭标签')}</Button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- dividers */

function DividerHandle({ divider, gap, onStart, onNudge }: { divider: Divider; gap: number; onStart: (divider: Divider, event: ReactPointerEvent) => void; onNudge: (delta: number) => void }) {
  const t = useT()
  const row = divider.axis === 'row'
  const { rect } = divider
  // The handle fills the gap between the cards (at least 8 px to grab), centred on the seam.
  const reach = Math.max(8, gap)
  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16
    const delta = row ? (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) : (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
    if (!delta || e.altKey || e.metaKey || e.ctrlKey) return
    e.preventDefault()
    onNudge(delta)
  }
  return (
    <div role="separator" aria-orientation={row ? 'vertical' : 'horizontal'} aria-label={t('调整面板大小')} tabIndex={0} data-divider={divider.split}
      onPointerDown={e => onStart(divider, e)} onKeyDown={onKey}
      className={cn('workspace-divider group workspace-cell absolute z-30 outline-none', row ? 'cursor-col-resize' : 'cursor-row-resize')}
      style={row ? { left: rect.x - reach / 2, top: rect.y, width: reach, height: rect.height } : { left: rect.x, top: rect.y - reach / 2, width: rect.width, height: reach }}>
      <span className={cn('absolute rounded-full bg-accent/45 group-focus-visible:bg-accent', row ? 'inset-y-3 left-1/2 w-[2px] -translate-x-1/2' : 'inset-x-3 top-1/2 h-[2px] -translate-y-1/2')} />
    </div>
  )
}

/** The seam while a divider drag previews (no handles: the drag owns the pointer). */
function DividerLine({ divider }: { divider: Divider }) {
  const row = divider.axis === 'row'
  const { rect } = divider
  return (
    <span className="workspace-divider-line absolute z-30 rounded-full"
      style={row ? { left: rect.x - 1, top: rect.y + 12, width: 2, height: Math.max(0, rect.height - 24) } : { left: rect.x + 12, top: rect.y - 1, width: Math.max(0, rect.width - 24), height: 2 }} />
  )
}

/* ------------------------------------------------------------- edge strip */

/** Minimized groups (and those squeezed out by a narrow window) as icons on an edge. */
function EdgeStrip({ strip, layout, ctx, squeezed }: { strip: Strip; layout: LayoutState<SideTab>; ctx: WorkspaceCtx; squeezed: NodeId[] }) {
  const t = useT()
  const vertical = strip.edge === 'left' || strip.edge === 'right'
  // On the gutter's ground, like the cards around it.
  return (
    <div role="toolbar" aria-label={t('最小化的面板')} aria-orientation={vertical ? 'vertical' : 'horizontal'} data-edge-strip={strip.edge}
      className={cn('workspace-cell absolute z-30 flex items-center gap-1 bg-gutter p-1', vertical ? 'flex-col pt-2' : 'flex-row pl-2')} style={rectStyle(strip.rect)}>
      {strip.groups.map(id => (
        <EdgeButton key={id} groupId={id} tab={activeTab(layout, id, ctx) ?? visibleTabs(layout, id, ctx)[0] ?? null} squeezed={squeezed.includes(id)} />
      ))}
    </div>
  )
}

function EdgeButton({ groupId, tab, squeezed }: { groupId: NodeId; tab: SideTab | null; squeezed: boolean }) {
  const t = useT()
  const placeholder: SideTab = { id: `${groupId}:empty`, type: 'launcher', binding: 'workspace' }
  const title = useTabTitle(tab ?? placeholder)
  // A group squeezed out by space comes back by becoming the most recent (another, older one yields its place); a minimized one is restored.
  return (
    <IconButton label={t('显示 {title}', { title })} data-edge-group={groupId} onClick={() => (squeezed ? focusGroup(groupId) : minimizeGroup(groupId, false))}>
      <TabIcon tab={tab ?? placeholder} />
    </IconButton>
  )
}

/* -------------------------------------------------------------- dropping */

function DropOverlay({ drag, geometry, leaves, container, onDone }: {
  drag: { tabId: string; source: NodeId }
  geometry: Geometry
  leaves: { id: NodeId; kind: 'main' | 'group' }[]
  container: RefObject<HTMLDivElement | null>
  onDone: () => void
}) {
  const [target, setTarget] = useState<DropTarget | null>(null)
  // A drop that unmounts the dragged chip never fires its dragend: end the drag on any drop or dragend.
  useEffect(() => {
    const end = () => onDone()
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end) }
  }, [onDone])
  const locate = (e: DragEvent): DropTarget | null => {
    const host = container.current
    if (!host) return null
    // In layout pixels, like the geometry (the interface zoom scales client coordinates and boxes alike).
    const local = toLayout(host)
    const chips = (groupId: string) => [...host.querySelectorAll<HTMLElement>(`[data-group-strip="${groupId}"] [data-tab-id]`)].map(el => local.rect(el.getBoundingClientRect()))
    const shares = sideShares(useSidePanel.getState().viewport)
    const at = local.point(e.clientX, e.clientY)
    return dropTargetAt({ geometry, leaves, strip: STRIP_HEIGHT, chips, source: drag.source, mainShare: axis => shares[axis] }, at.x, at.y)
  }
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const next = locate(e)
    setTarget(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const at = locate(e)
    onDone()
    if (!at) return
    if (at.kind === 'strip') placeTab(drag.tabId, at.groupId, at.slot)
    else if (at.zone === 'center') moveTabTo(drag.tabId, at.nodeId)
    else moveTabTo(drag.tabId, { edge: at.zone, of: at.nodeId })
  }
  const box = target?.kind === 'strip' ? target.caret : target?.highlight
  return (
    <div className="absolute inset-0 z-40" data-drop-overlay onDragOver={onDragOver} onDragLeave={e => { if (e.currentTarget === e.target) setTarget(null) }} onDrop={onDrop}>
      {box && (
        <div className={cn('pointer-events-none absolute transition-[left,top,width,height] duration-100 ease-out',
          target?.kind === 'strip' ? 'rounded-full bg-accent' : 'rounded-lg bg-accent/10 shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--accent)_45%,transparent)]')}
          style={rectStyle(target?.kind === 'strip' ? box : { x: box.x + 4, y: box.y + 4, width: Math.max(0, box.width - 8), height: Math.max(0, box.height - 8) })} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- behaviour */

/** Desktop: popups / target=_blank from <webview> guests open as new browser tabs. */
function useDesktopPopups() {
  useEffect(() => {
    const off = window.rnaDesktop?.browser?.onOpenUrl?.(event => { if (normalizeAddress(event.url)) openBrowserTab(event.url) })
    return () => { if (typeof off === 'function') off() }
  }, [])
}

/**
 * Shortcuts (design 1.3 item 6): ⌥⌘B shows or hides the panels; ⌥⌘ + arrows
 * move focus between groups (and the conversation); ⌃⌥⌘ + arrows move the
 * current tab that way; ⌥⌘\ splits right; ⇧⌘T reopens the tab closed last;
 * ⇧⌘Y shows or hides 工作区改动's file tree when it is the current group's tab.
 * Esc hides the panels only when focus is inside a group, never from a page,
 * a terminal, a side chat or a field, and never after something else took it.
 */
function useWorkspaceKeys(container: RefObject<HTMLDivElement | null>, region: RefObject<{ group: NodeId | null }>, mobile: boolean) {
  useEffect(() => {
    const currentGroup = () => {
      const layout = useSidePanel.getState().layout
      const noted = region.current?.group
      return noted && isGroup(layout, noted) ? noted : layout.activeGroup && isGroup(layout, layout.activeGroup) ? layout.activeGroup : groupsByRecency(layout)[0] ?? null
    }
    const focusChip = (groupId: NodeId) => requestAnimationFrame(() =>
      container.current?.querySelector<HTMLElement>(`[data-group-strip="${groupId}"] [role="tab"][aria-selected="true"]`)?.focus())

    const moveFocus = (edge: Edge) => {
      const { layout, ctx } = useSidePanel.getState()
      if (!panelsOpen(layout)) return
      const from = region.current?.group && isGroup(layout, region.current.group) ? region.current.group : MAIN
      const to = neighborNode(layout, from, edge, { includeMain: true })
      // A group with nothing to show here is not drawn: there is nothing to focus.
      if (!to || vacantGroups(layout, ctx).includes(to)) return
      if (to === MAIN) {
        region.current!.group = null
        container.current?.querySelector<HTMLElement>('[data-cell="main"] textarea, [data-cell="main"] [tabindex="0"]')?.focus()
        return
      }
      region.current!.group = to
      focusGroup(to)
      focusChip(to)
    }
    const moveCurrentTab = (edge: Edge) => {
      const { layout, ctx } = useSidePanel.getState()
      const group = currentGroup()
      const tab = group ? activeTab(layout, group, ctx) : null
      if (!tab) return
      moveTabToward(tab.id, edge)
      const next = useSidePanel.getState().layout
      if (next.tabs[tab.id]) { const at = tabGroupId(next, tab.id); region.current!.group = at; focusChip(at) }
    }
    const splitCurrent = () => {
      const { layout, ctx } = useSidePanel.getState()
      const group = currentGroup()
      if (!group) return
      const tab = activeTab(layout, group, ctx)
      splitGroup(group, 'right', tab && visibleTabs(layout, group, ctx).length > 1 ? tab.id : undefined)
    }
    // ⇧⌘Y: the file tree of 工作区改动, when that panel is the one shown in the current group (worktree design §3.7).
    const toggleChangesTree = () => {
      const { layout, ctx } = useSidePanel.getState()
      const group = currentGroup()
      if (!group || !panelsOpen(layout) || vacantGroups(layout, ctx).includes(group) || (layout.maximizedGroup && layout.maximizedGroup !== group)) return false
      const tab = mobile ? shownTab(layout, ctx) : activeTab(layout, group, ctx)
      return tab?.type === 'worktree' ? toggleWorktreeTree(tab.id) : false
    }
    const onEscape = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const inside = target?.closest('[data-group-id]')?.getAttribute('data-group-id') ?? null
      const atBody = !target || target === document.body || target === document.documentElement
      const groupId = inside ?? (atBody ? region.current?.group ?? null : null)
      if (!groupId || target?.closest(EDITABLE)) return
      const { layout, ctx } = useSidePanel.getState()
      if (!panelsOpen(layout) || !isGroup(layout, groupId)) return
      const tab = mobile ? shownTab(layout, ctx) : activeTab(layout, groupId, ctx)
      // Pages, terminals and side chats keep the key.
      if (tab && isKeepAlive(tab.type)) return
      e.preventDefault()
      if (layout.maximizedGroup) maximizeGroup(null)
      else setPanelOpen(false)
      region.current!.group = null
    }

    const onKey = (e: KeyboardEvent) => {
      // Layout shortcuts are the app's even where a terminal marks keys handled; Esc yields to whoever took it.
      if (e.key === 'Escape') { if (!e.defaultPrevented) onEscape(e); return }
      const mac = isMac()
      // ⌥⌘B / Ctrl+Alt+B (e.code: Option changes e.key on macOS).
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyB') { e.preventDefault(); togglePanel(); return }
      const edge = ARROWS[e.key]
      if (edge && !mobile) {
        const moveCombo = mac ? e.metaKey && e.altKey && e.ctrlKey && !e.shiftKey : e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey
        const focusCombo = mac ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey
        if (moveCombo) { e.preventDefault(); moveCurrentTab(edge) } else if (focusCombo) { e.preventDefault(); moveFocus(edge) }
        return
      }
      const primary = mac ? e.metaKey : e.ctrlKey
      if (primary && e.altKey && !e.shiftKey && e.code === 'Backslash' && !mobile) { e.preventDefault(); splitCurrent(); return }
      if (primary && e.shiftKey && !e.altKey && e.code === 'KeyY') { if (toggleChangesTree()) e.preventDefault(); return }
      if (primary && e.shiftKey && !e.altKey && e.code === 'KeyT') { if (reopenClosedTab()) e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [container, region, mobile])
}
