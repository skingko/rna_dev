/**
 * The composer's "+" launcher and slash menu (Harness InputBar + ui-input-
 * trigger, legacy composer-commands.js): 添加 (files/images, goal, plan,
 * feedback), 技能 (attach a project skill to the next message), 指令, and 导航
 * when searching. A listbox over the editor; the keyboard stays in the editor
 * for slash mode and in the search field for the launcher.
 *
 * 0.63 (worktree design §7.1, §12): before a project's new conversation exists,
 * the launcher ends with 在独立工作树中运行 — a switch, not a command (Enter or
 * a click flips it and the menu stays). It starts at the project's default
 * (`project.git.sessionWorktreeDefault`), is chosen for this conversation only
 * and cannot change once it exists; where isolation is off it is greyed out
 * with the reason.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { motion } from 'motion/react'
import {
  Check, Download, FileUp, GitBranch, GitFork, Hammer, LayoutDashboard, Lightbulb, MessageSquareText, Minimize2, Puzzle, Search, Shield, Sparkles, Square, SquarePen, Target, Cpu, X, type LucideIcon,
} from 'lucide-react'
import type { CommandCatalog, ProjectSkill } from '@/api/project-api'
import { setWorktreeChoice, useWorktreeChoice, useWorktrees } from '@/store/isolation-store'
import { isolationReasonText } from '@/lib/isolation'
import { cn } from '@/lib/utils'
import { filterCommands, GROUP_LABELS, unavailableReason, type CommandContext, type CommandId, type ComposerCommand } from './commands'
import { t } from '@/i18n'

const ICONS: Record<CommandId, LucideIcon> = {
  file: FileUp, goal: Target, plan: Lightbulb, feedback: MessageSquareText, compact: Minimize2, permission: Shield, model: Cpu, export: Download,
  project: LayoutDashboard, versions: GitBranch, new: SquarePen, skills: Puzzle, build: Hammer, stop: Square,
}

export type MenuEntry =
  | { type: 'command'; command: ComposerCommand; reason: string | null }
  | { type: 'skill'; skill: ProjectSkill; attached: boolean }

export interface ComposerMenuHandle { onKey: (e: ReactKeyboardEvent) => boolean }

/** 在独立工作树中运行 as the launcher shows it: on or off, and why it cannot be used (null: it can). */
export interface WorktreeSwitch { on: boolean; reason: string | null }
type Row = MenuEntry | ({ type: 'worktree' } & WorktreeSwitch)

/**
 * 独立工作树 above a new conversation's editor while its switch is on, so the choice stays in view once the launcher
 * closes; × turns it off. Isolation is read only when the switch is on (the default is off).
 */
export function WorktreeChip({ projectId }: { projectId: string | null }) {
  const chosen = useWorktreeChoice(projectId)
  const entry = useWorktrees(projectId, { enabled: chosen })
  if (!projectId || !chosen || !entry.data?.isolation.enabled) return null
  return (
    <span className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg bg-accent-softer pl-2 pr-1 text-[12.5px] text-accent-text" data-worktree-chip
      title={t('这个对话在独立的工作副本里改文件，每次交还给你时应用到项目文件夹；被忽略的文件（如 dist/）不会应用。')}>
      <GitFork className="size-3.5" />
      <span className="truncate">{t('独立工作树')}</span>
      <button type="button" aria-label={t('不在独立工作树中运行')} onClick={() => setWorktreeChoice(projectId, false)} className="grid size-5 place-items-center rounded-md opacity-70 hover:bg-hover hover:opacity-100"><X className="size-3" /></button>
    </span>
  )
}

/** The switch for a project's new conversation: the user's choice (else the default), off with a reason where isolation is. */
export function useWorktreeSwitch(projectId: string | null, show: boolean): WorktreeSwitch | null {
  const chosen = useWorktreeChoice(projectId)
  const entry = useWorktrees(projectId, { enabled: show })
  // Not offered by an older host, while the release gate is closed (`not_ready`), or when the conditions could not be read.
  if (!show || !projectId || entry.unsupported) return null
  const isolation = entry.data?.isolation
  if (!isolation) return entry.error ? null : { on: false, reason: t('正在检查…') }
  if (isolation.enabled) return { on: chosen, reason: null }
  return isolation.reason === 'not_ready' ? null : { on: false, reason: isolationReasonText(isolation.reason) }
}

export const ComposerMenu = forwardRef<ComposerMenuHandle, {
  source: 'launcher' | 'slash'
  query: string
  context: CommandContext
  catalog: CommandCatalog | null
  busy: boolean
  skills: ProjectSkill[]
  attachedSkills: string[]
  onChoose: (entry: MenuEntry) => void
  onClose: (refocus: boolean) => void
}>(function ComposerMenu({ source, query: slashQuery, context, catalog, busy, skills, attachedSkills, onChoose, onClose }, ref) {
  const launch = source === 'launcher'
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const query = launch ? search : slashQuery
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // A project's new conversation, before the first message creates it: the worktree switch ends the launcher.
  const worktree = useWorktreeSwitch(context.projectId, launch && !context.sessionId && Boolean(context.projectId))
  const entries = useMemo<Row[]>(() => {
    const commands = filterCommands(query, launch).map(command => ({ type: 'command' as const, command, reason: unavailableReason(command, context, catalog, busy) }))
    const q = query.trim().toLowerCase()
    const skillRows = launch
      ? skills.filter(s => s.enabled !== false && (!q || `${s.name} ${s.id} ${s.description ?? ''}`.toLowerCase().includes(q))).slice(0, q ? 12 : 6)
        .map(skill => ({ type: 'skill' as const, skill, attached: attachedSkills.includes(skill.id) }))
      : []
    // 添加 first, then skills, then 指令 / 导航; the new conversation's switch last, next to the composer (the
    // launcher opens upwards, so its last rows are the ones always in view).
    const add = commands.filter(c => c.command.group === 'add')
    const rest = commands.filter(c => c.command.group !== 'add')
    return [...add, ...skillRows, ...rest, ...(worktree && !q ? [{ type: 'worktree' as const, ...worktree }] : [])]
  }, [query, launch, context, catalog, busy, skills, attachedSkills, worktree])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { if (launch) searchRef.current?.focus({ preventScroll: true }) }, [launch])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    if (entry.type === 'worktree') {
      // A switch: flipped here, the menu stays open.
      if (!entry.reason && context.projectId) setWorktreeChoice(context.projectId, !entry.on)
      return
    }
    if (entry.type === 'command' && entry.reason) return
    onChoose(entry)
  }

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return false
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose(true); return true }
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(e.key)) return false
    e.preventDefault(); e.stopPropagation()
    if (e.key === 'Enter') { choose(active); return true }
    const n = Math.max(1, entries.length)
    setActive(a => (e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n))
    return true
  }
  useImperativeHandle(ref, () => ({ onKey }))

  let lastGroup = ''
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, transition: { duration: 0.1 } }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-2xl bg-elevated shadow-lg"
      onMouseDown={e => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault() }}
    >
      {launch && (
        <label className="flex h-11 items-center gap-2 border-b border-line-faint px-3.5 text-fg-3">
          <Search className="size-4 shrink-0" />
          <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { onKey(e) }}
            role="combobox" aria-expanded aria-controls="composer-command-menu" aria-activedescendant={entries[active] ? `composer-entry-${active}` : undefined}
            placeholder={t('搜索指令或技能')} aria-label={t('搜索指令或技能')} className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-4" />
          <kbd className="rounded border border-line px-1 text-[10.5px] text-fg-4">Esc</kbd>
        </label>
      )}
      <div ref={listRef} id="composer-command-menu" role="listbox" aria-label={t('会话指令')} className="max-h-[min(420px,50vh)] overflow-y-auto overscroll-contain p-1.5">
        {entries.map((entry, index) => {
          if (entry.type === 'worktree') {
            lastGroup = t('新会话')
            return (
              <div key="worktree">
                <div role="presentation" className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-fg-3">{t('新会话')}</div>
                <div
                  id={`composer-entry-${index}`} data-index={index} role="option" aria-selected={index === active} aria-checked={entry.on} aria-disabled={Boolean(entry.reason)} data-worktree-switch={entry.on ? 'on' : 'off'}
                  onPointerMove={() => setActive(index)} onClick={() => choose(index)}
                  title={entry.reason ? undefined : t('这个对话在独立的工作副本里改文件，每次交还给你时应用到项目文件夹；被忽略的文件（如 dist/）不会应用。')}
                  className={cn('flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors', index === active && 'bg-hover', entry.reason ? 'cursor-default text-fg-4' : 'text-fg')}
                >
                  <GitFork className={cn('size-4 shrink-0', entry.reason ? 'text-fg-4' : 'text-fg-3')} strokeWidth={1.7} />
                  <span className="shrink-0">{t('在独立工作树中运行')}</span>
                  <span className="ml-auto min-w-0 truncate text-right text-[12px] text-fg-3">{entry.reason ?? t('只在新建时选择')}</span>
                  <span aria-hidden className={cn('relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200', entry.on ? 'bg-accent' : 'bg-[var(--line-strong)]', entry.reason && 'opacity-45')}>
                    <span className={cn('block size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-200', entry.on && 'translate-x-3')} />
                  </span>
                </div>
              </div>
            )
          }
          const group = entry.type === 'skill' ? t('技能') : GROUP_LABELS[entry.command.group]
          const header = group !== lastGroup ? (lastGroup = group) : null
          const disabled = entry.type === 'command' && Boolean(entry.reason)
          const Icon = entry.type === 'skill' ? Sparkles : ICONS[entry.command.id]
          return (
            <div key={entry.type === 'skill' ? `skill:${entry.skill.id}` : entry.command.id}>
              {header && <div role="presentation" className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-fg-3">{header}</div>}
              <div
                id={`composer-entry-${index}`} data-index={index} role="option" aria-selected={index === active} aria-disabled={disabled}
                onPointerMove={() => setActive(index)} onClick={() => choose(index)}
                className={cn('flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors', index === active && 'bg-hover', disabled ? 'cursor-default text-fg-4' : 'text-fg')}
              >
                <Icon className={cn('size-4 shrink-0', disabled ? 'text-fg-4' : 'text-fg-3')} strokeWidth={1.7} />
                {entry.type === 'skill' ? (
                  <>
                    <span className="min-w-0 truncate">{entry.skill.name}</span>
                    <span className="ml-auto min-w-0 max-w-[55%] truncate text-right text-[12px] text-fg-3">{entry.skill.description}</span>
                    {entry.attached && <Check className="size-3.5 shrink-0 text-accent" />}
                  </>
                ) : (
                  <>
                    <span className="shrink-0">{entry.command.label}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-fg-4">/{entry.command.id}</span>
                    <span className="ml-auto min-w-0 truncate text-right text-[12px] text-fg-3">{entry.reason ?? entry.command.detail}</span>
                  </>
                )}
              </div>
            </div>
          )
        })}
        {!entries.length && <div className="px-3 py-4 text-[13px] text-fg-3">{t('没有匹配的指令')}</div>}
      </div>
    </motion.div>
  )
})
