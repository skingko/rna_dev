/**
 * Which tab bodies stay mounted (design 1.4). A body mounts when it is first
 * shown; ordinary bodies unmount once hidden, keep-alive bodies (browser,
 * terminal, agent browser, side chat) stay mounted while hidden — across
 * moves, collapsing and conversation switches — up to a per-type cap
 * (6 browsers, 4 terminals). Over a cap, the body hidden longest unmounts and
 * comes back through its own recovery (a page reloads its URL, a terminal
 * replays from its last sequence).
 *
 * The log keeps mount order: the host renders cells in this order, so a cell
 * never moves among its siblings (moving a `<webview>` resets its guest).
 */
import type { Rect } from '@/lib/dock'

export const KEEP_ALIVE_CAPS: Readonly<Record<string, number>> = { browser: 6, terminal: 4 }

export interface MountEntry {
  id: string
  type: string
  /** Bumped whenever the body is shown or hidden: the smallest hidden stamp was hidden longest. */
  stamp: number
  shown: boolean
}

export interface MountInput {
  tabs: { id: string; type: string }[]
  shown: ReadonlySet<string>
  keepAlive: (type: string) => boolean
  caps?: Readonly<Record<string, number>>
}

/**
 * The next mount log from the previous one.
 * @returns `prev` itself when nothing changed (safe to compare by identity).
 */
export function nextMounted(prev: readonly MountEntry[], input: MountInput): readonly MountEntry[] {
  const caps = input.caps ?? KEEP_ALIVE_CAPS
  const types = new Map(input.tabs.map(tab => [tab.id, tab.type]))
  let clock = prev.reduce((max, entry) => Math.max(max, entry.stamp), 0)
  let changed = false
  const out: MountEntry[] = []
  for (const entry of prev) {
    const type = types.get(entry.id)
    const shown = input.shown.has(entry.id)
    if (type === undefined || (!shown && !input.keepAlive(type))) { changed = true; continue }
    if (shown !== entry.shown || type !== entry.type) { out.push({ id: entry.id, type, stamp: ++clock, shown }); changed = true } else out.push(entry)
  }
  const known = new Set(out.map(entry => entry.id))
  for (const tab of input.tabs) {
    if (!input.shown.has(tab.id) || known.has(tab.id)) continue
    out.push({ id: tab.id, type: tab.type, stamp: ++clock, shown: true })
    changed = true
  }
  for (const [type, cap] of Object.entries(caps)) {
    for (;;) {
      const ofType = out.filter(entry => entry.type === type)
      if (ofType.length <= cap) break
      const victim = ofType.filter(entry => !entry.shown).sort((a, b) => a.stamp - b.stamp)[0]
      if (!victim) break
      out.splice(out.indexOf(victim), 1)
      changed = true
    }
  }
  return changed ? out : prev
}

/**
 * Screen pixels per layout pixel inside `el`. The interface zoom (设置 → 界面缩放, CSS `zoom` on <html>) scales what
 * getBoundingClientRect and pointer events report, while styles, sizes and so the layout geometry stay in unzoomed
 * pixels. Measured rather than read from the setting, so a browser that reports both alike gets 1.
 */
export function layoutScale(el: HTMLElement): number {
  const layout = el.offsetWidth, screen = el.getBoundingClientRect().width
  const scale = layout > 0 && screen > 0 ? screen / layout : 1
  return Math.abs(scale - 1) < 0.005 ? 1 : scale
}

/** A point or rectangle in client (screen) coordinates, in `el`'s layout pixels from its top left corner. */
export function toLayout(el: HTMLElement): { point: (clientX: number, clientY: number) => { x: number; y: number }; rect: (box: DOMRect) => Rect; scale: number } {
  const origin = el.getBoundingClientRect()
  const scale = layoutScale(el)
  return {
    scale,
    point: (clientX, clientY) => ({ x: (clientX - origin.left) / scale, y: (clientY - origin.top) / scale }),
    rect: box => ({ x: (box.left - origin.left) / scale, y: (box.top - origin.top) / scale, width: box.width / scale, height: box.height / scale }),
  }
}

/**
 * Groups are cards (design 1.4): `CARD_GAP` pixels apart and from the window's edges, laid out by `computeRects` with
 * that gap (the constant lives with the geometry, so the store predicts the same layout). A card's hairline edge is
 * drawn outside its rectangle (app.css `.workspace-card`), so bodies fill it.
 */
export { CARD_GAP } from '@/lib/dock/geometry'

/** A group's body: its rectangle below the tab strip. */
export const bodyRect = (rect: Rect, strip: number): Rect => ({ x: rect.x, y: rect.y + strip, width: rect.width, height: Math.max(0, rect.height - strip) })

export const rectStyle = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
