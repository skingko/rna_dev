/**
 * What a group strip's buttons show on hover (hover-menu.tsx), after Claude's
 * layout popover:
 *
 * - the maximize button: 移动 — the group to the left, right, top or bottom of
 *   the conversation (the side it is on marked) — and 填充并排列 — 最大化此组
 *   and 填充并排列 (every group arranged); 在新窗口打开 once the desktop shell
 *   can pop a group out. Each is one layout change, undone like the others.
 * - the "+" button: the chooser's kinds of tab (the launcher's own list, with
 *   what each needs), opened into this group.
 */
import { useId, type ReactNode } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import type { Edge } from '@/lib/dock'
import { applyPreset, maximizeGroup, moveGroup, useSidePanel } from '@/store/side-panel-store'
import { useLauncherCards } from '@/components/side-panel/Launcher'
import { Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { ITEM_ATTR } from './hover-menu'

const EDGES: readonly Edge[] = ['left', 'right', 'top', 'bottom']
const item = { [ITEM_ATTR]: '' }

/* ------------------------------------------------------------------ glyphs */

/** A window with the part on `side` filled: where the group goes. */
export function SideGlyph({ side }: { side: Edge }) {
  const bar = { left: { x: 3, y: 3, width: 4.5, height: 10 }, right: { x: 8.5, y: 3, width: 4.5, height: 10 }, top: { x: 3, y: 3, width: 10, height: 4 }, bottom: { x: 3, y: 9, width: 10, height: 4 } }[side]
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <rect {...bar} rx="1" fill="currentColor" />
    </svg>
  )
}

/** The whole window filled (one group maximized), or tiled (every group arranged). */
export function FillGlyph({ tiled = false }: { tiled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      {tiled
        ? <><rect x="3" y="3" width="4.5" height="10" rx="1" fill="currentColor" /><rect x="8.5" y="3" width="4.5" height="4.5" rx="1" fill="currentColor" /><rect x="8.5" y="8.5" width="4.5" height="4.5" rx="1" fill="currentColor" /></>
        : <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />}
    </svg>
  )
}

/* ---------------------------------------------------------------- pieces */

function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="px-1 pb-1.5 pt-1">
      <div id={id} className="pb-1.5 text-[11.5px] font-medium text-fg-4">{label}</div>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  )
}

/** An icon choice; `checked` marks the current state (the group's side, maximized). */
function GlyphItem({ label, checked, role = 'menuitem', onSelect, children }: { label: string; checked?: boolean; role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'; onSelect: () => void; children: ReactNode }) {
  // Named above the icon: below it the tooltip would cover the next section's label.
  return (
    <Tooltip content={label} delay={300} side="top">
      <button type="button" role={role} tabIndex={-1} aria-label={label} aria-checked={role === 'menuitem' ? undefined : Boolean(checked)} data-checked={checked || undefined}
        onClick={onSelect} {...item}
        className={cn('grid size-8 place-items-center rounded-lg text-fg-3 outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]',
          'data-[checked]:bg-accent-soft data-[checked]:text-accent-text data-[checked]:hover:bg-accent-soft')}>
        {children}
      </button>
    </Tooltip>
  )
}

/** A text row (icon, label, and for one that cannot open now, why). */
function RowItem({ icon, label, hint, disabled, onSelect, data }: { icon: ReactNode; label: string; hint?: string; disabled?: boolean; onSelect: () => void; data?: Record<string, string> }) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onSelect} {...item} {...data}
      className={cn('flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left outline-none transition-colors duration-100 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3',
        disabled ? 'cursor-default opacity-45' : 'hover:bg-hover focus-visible:bg-hover')}>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {disabled && hint && <span className="block truncate text-[11.5px] leading-4 text-fg-4">{hint}</span>}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------ the menus */

export interface LayoutMenuProps {
  groupId: string
  /** The side of the conversation the group is on (marked). */
  edge: Edge
  maximized: boolean
  /** Closes the menu once a choice ran. */
  onDone: () => void
  /** 在新窗口打开: given only where the desktop shell can pop a group out into its own window. */
  onOpenInWindow?: () => void
}

/** The maximize button's menu: move the group beside the conversation, maximize it, arrange every group. */
export function LayoutMenu({ groupId, edge, maximized, onDone, onOpenInWindow }: LayoutMenuProps) {
  const t = useT()
  const labels: Record<Edge, string> = { left: t('移到对话左侧'), right: t('移到对话右侧'), top: t('移到对话上方'), bottom: t('移到对话下方') }
  const run = (fn: () => void) => () => { fn(); onDone() }
  return (
    <div className="w-[176px]" data-layout-menu={groupId}>
      <Section label={t('移动')}>
        {EDGES.map(side => (
          <GlyphItem key={side} role="menuitemradio" label={labels[side]} checked={side === edge} onSelect={run(() => {
            // The marked side is where the group already is (also when nested beside another group there): a maximized
            // group is only restored. Moving restores it in the same step (one undo).
            if (side !== edge) moveGroup(groupId, side)
            else if (maximized) maximizeGroup(null)
          })}>
            <SideGlyph side={side} />
          </GlyphItem>
        ))}
      </Section>
      <Section label={t('填充并排列')}>
        <GlyphItem role="menuitemcheckbox" label={maximized ? t('还原此组') : t('最大化此组')} checked={maximized} onSelect={run(() => maximizeGroup(maximized ? null : groupId))}>
          <FillGlyph />
        </GlyphItem>
        <GlyphItem label={t('填充并排列')} onSelect={run(() => applyPreset('fill'))}><FillGlyph tiled /></GlyphItem>
      </Section>
      {onOpenInWindow && (
        <>
          <div role="separator" className="mx-1 my-1 h-px bg-line-faint" />
          <RowItem icon={<SquareArrowOutUpRight />} label={t('在新窗口打开')} onSelect={run(onOpenInWindow)} />
        </>
      )}
    </div>
  )
}

/** The "+" button's menu: the chooser's kinds of tab, opened into this group. */
export function NewTabMenu({ groupId, onDone }: { groupId: string; onDone: () => void }) {
  const ctx = useSidePanel(s => s.ctx)
  const cards = useLauncherCards({ place: { target: groupId }, sessionId: ctx.sessionId, projectId: ctx.projectId })
  return (
    <div className="w-[220px]" data-new-tab-menu={groupId}>
      {cards.map(card => (
        <RowItem key={card.id} icon={card.icon} label={card.label} hint={card.hint} disabled={card.disabled} data={{ 'data-new-tab': card.id }}
          onSelect={() => { card.onOpen(); onDone() }} />
      ))}
    </div>
  )
}
