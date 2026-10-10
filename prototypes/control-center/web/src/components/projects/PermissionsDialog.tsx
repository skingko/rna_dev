/** 项目权限: foreground + background execution scope (port of public/project-permissions-ui.js). */
import { useEffect, useRef, useState } from 'react'
import { Dialog as RDialog, VisuallyHidden } from 'radix-ui'
import { AnimatePresence, motion } from 'motion/react'
import { FolderOpen, ShieldAlert } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { PermissionsResponse } from '@/api/panels-types'
import { Button, Skeleton } from '@/components/ui/primitives'
import { useReturnFocus } from '@/components/ui/overlays'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { prettyPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CloseButton } from '@/components/settings/PanelDialog'
import { openPermissions, usePanels } from '@/components/settings/panel-store'
import { t, localized } from '@/i18n'

const LABELS: Record<string, string> = localized({ read: '只读检查', write: '读写项目文件', execute: '读写并执行命令' })
const LEVELS = localized([
  { id: 'read', title: '只读检查', description: '读取与检索项目文件，不修改。' },
  { id: 'write', title: '读写项目文件', description: '在项目目录内创建和编辑文件。' },
  { id: 'execute', title: '读写并执行命令', description: '额外允许以当前用户身份运行命令。' },
] as const)

type Level = 'read' | 'write' | 'execute'
/** Opened from the terminal: 读写并执行命令 is preselected and marked as what the terminal needs; saving stays the user's choice. */
let requested: { projectId: string; level: Level } | null = null
export function openPermissionsForTerminal(projectId: string) { requested = { projectId, level: 'execute' }; openPermissions(projectId) }

export function PermissionsDialog() {
  const projectId = usePanels(s => s.permissions)
  const project = useApp(s => (projectId ? s.projects[projectId] : undefined))
  const [config, setConfig] = useState<PermissionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<Level>('read')
  const [needed, setNeeded] = useState<Level | null>(null)
  const [background, setBackground] = useState<'read' | 'inherit'>('read')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!projectId) { requested = null; return }
    const ticket = ++generation.current, need = requested?.projectId === projectId ? requested.level : null
    setConfig(null); setError(null); setNeeded(need)
    panelsApi.permissions(projectId).then(value => {
      if (ticket !== generation.current) return
      setConfig(value); setWorkspace(need ?? value.settings.workspace); setBackground(value.settings.background)
    }).catch(e => { if (ticket === generation.current) setError((e as Error).message) })
  }, [projectId])

  const close = () => { if (!busy) { generation.current++; usePanels.setState({ permissions: null }) } }
  const save = async () => {
    if (!projectId || busy) return
    setBusy(true); setError(null)
    try {
      await panelsApi.setPermissions(projectId, workspace, background, AbortSignal.timeout(15000))
      useApp.setState(s => (s.projects[projectId] ? { projects: { ...s.projects, [projectId]: { ...s.projects[projectId], permissions: { workspace, background } } } } : {}))
      usePanels.setState({ permissions: null })
      toast(t('项目权限已保存，后续执行使用新设置。'))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const effective = background === 'inherit' ? workspace : 'read'
  const open = projectId !== null
  // Focus back to what opened it (a project menu, the terminal's prompt) when it closes: there is no Dialog.Trigger.
  const returnFocus = useReturnFocus(open)

  return (
    <RDialog.Root open={open} onOpenChange={next => { if (!next) close() }}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            </RDialog.Overlay>
            <RDialog.Content asChild forceMount tabIndex={-1} onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus() }} onCloseAutoFocus={returnFocus}>
              <motion.div className="fixed left-1/2 top-[12vh] z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl bg-elevated p-5 shadow-lg outline-none"
                initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.985 }} transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <RDialog.Title className="text-[15px] font-semibold text-fg">{t('{v} · 项目权限', { v: project?.name ?? t('项目') })}</RDialog.Title>
                    <VisuallyHidden.Root><RDialog.Description>{t('设置对话执行与后台自主工作的权限')}</RDialog.Description></VisuallyHidden.Root>
                    {config && <p className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-fg-4"><FolderOpen className="size-3.5 shrink-0" />{prettyPath(config.workspace)}</p>}
                  </div>
                  <CloseButton onClick={close} label={t('关闭项目权限')} />
                </div>
                {!config ? (
                  error ? <p className="mt-4 text-[13px] text-danger">{error}</p> : <div className="mt-4 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-32 w-full rounded-xl" /></div>
                ) : (
                  <>
                    <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.6] text-fg-3">
                      {t('当前生效：对话执行 ·')} <span className="text-fg-2">{config.inheritedAssignments ? t('原有工具授权（尚未设置统一权限）') : LABELS[config.effective.foreground]}</span>{t('；后台自主工作 ·')} <span className="text-fg-2">{LABELS[config.effective.background]}</span>
                    </p>
                    {config.inheritedAssignments && <p className="mt-2 text-[12px] text-fg-4">{t('尚未设置统一权限，继续使用原有已分配工具的授权；保存后统一按所选权限执行。')}</p>}
                    <p className="mb-2 mt-4 text-[12.5px] font-medium text-fg-2">{t('对话执行权限')}</p>
                    <div className="space-y-1.5" role="radiogroup" aria-label={t('对话执行权限')}>
                      {LEVELS.map(level => (
                        <button key={level.id} type="button" role="radio" aria-checked={workspace === level.id} onClick={() => setWorkspace(level.id)} disabled={busy}
                          className={cn('flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow]', workspace === level.id ? 'bg-accent-softer shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover')}>
                          <span className={cn('mt-[3px] size-3.5 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--line-strong)]', workspace === level.id && 'shadow-[inset_0_0_0_4px_var(--accent)]')} />
                          <span><span className="block text-[13px] font-medium text-fg">{level.title}{needed === level.id && <span className="ml-2 rounded bg-warning-soft px-1.5 py-px text-[11px] font-normal text-warning-text">{t('终端需要此权限')}</span>}</span><span className="block text-[12px] text-fg-3">{level.description}</span></span>
                        </button>
                      ))}
                    </div>
                    <p className="mb-2 mt-4 text-[12.5px] font-medium text-fg-2">{t('后台自主工作权限')}</p>
                    <div className="flex gap-1 rounded-lg bg-subtle p-0.5">
                      {([['read', t('仅只读检查')], ['inherit', t('使用项目权限')]] as const).map(([value, label]) => (
                        <button key={value} type="button" disabled={busy} aria-pressed={background === value} onClick={() => setBackground(value)} className={cn('h-8 flex-1 rounded-md text-[12.5px] transition-colors', background === value ? 'bg-elevated font-medium text-fg shadow-xs' : 'text-fg-3 hover:text-fg')}>{label}</button>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] leading-[1.6] text-fg-3">{background === 'read' ? t('后台自主工作只检查和研究，不改项目文件、不执行命令。要允许后台实施修改，可选择“使用项目权限”。') : t('后台自主工作将使用“{v}”。这会影响后续自主执行，不要求每次再发送新命令。', { v: LABELS[effective] })}</p>
                    <p className="mt-3 text-[12.5px] font-medium text-fg-2">{t('保存后：对话执行 · {v}；后台自主工作 · {v2}', { v: LABELS[workspace], v2: LABELS[effective] })}</p>
                    <p className="mt-3 flex gap-2 text-[12px] leading-[1.6] text-fg-4"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />{t('命令以当前用户身份运行，并非操作系统沙箱。外部 MCP 工具仍需单独分配并确认可信；这里不会替它们授予权限。')}</p>
                    {error && <p className="mt-2 text-[12.5px] text-danger" role="alert">{error}</p>}
                    <div className="mt-5 flex justify-end gap-2">
                      <Button variant="ghost" onClick={close} disabled={busy}>{t('取消')}</Button>
                      <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? t('正在保存…') : t('保存项目权限')}</Button>
                    </div>
                  </>
                )}
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  )
}
