/**
 * Settings: centered panel with a section rail (after the Harness settings
 * shell). Application sections are shared by all projects; 记忆 and 自主与节奏
 * also carry per-project content, chosen with the project switcher.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as RDialog, VisuallyHidden } from 'radix-ui'
import { BarChart3, Brain, ChevronRight, Cpu, Dna, Globe, Info, LifeBuoy, Scale, Settings2, Sparkles, type LucideIcon } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { closeSettings, openSettings, usePanels, type SettingsTab } from './panel-store'
import { reloadConfiguration, useConfiguration } from './config-store'
import { CloseButton } from './PanelDialog'
import { Note } from './form'
import { useT, type MessageKey } from './i18n'
import { Button } from '@/components/ui/primitives'
import { useReturnFocus } from '@/components/ui/overlays'
import { t as tr, localized } from '@/i18n'

const GeneralSection = lazy(() => import('./sections/GeneralSection'))
const ModelsSection = lazy(() => import('./sections/ModelsSection'))
const MemorySection = lazy(() => import('./sections/MemorySection'))
const AutonomySection = lazy(() => import('./sections/AutonomySection'))
const JudgmentSection = lazy(() => import('./sections/JudgmentSection'))
const SystemEvolutionSection = lazy(() => import('./sections/SystemEvolutionSection'))
const WebToolsSection = lazy(() => import('./sections/WebToolsSection'))
const UpdatesSection = lazy(() => import('./sections/UpdatesSection'))
const UsageSection = lazy(() => import('./sections/UsageSection'))
const AboutSection = lazy(() => import('./sections/AboutSection'))

/** `advanced`: rarely needed; listed under a collapsed 高级 group (plan 2026-09-30 §2.6). */
interface TabDef { id: SettingsTab; label: MessageKey; icon: LucideIcon; scope: 'app' | 'project'; component: ComponentType<SectionProps>; advanced?: boolean }
/** `registerBusy` / `registerDirty`: a section reports an in-flight save or an unsaved draft, and clears its key in the
 * effect cleanup (an editor that unmounts mid-request must not keep the panel from closing). `requestClose`: close
 * settings the way the close button does (wait for a save, confirm unsaved drafts); false when it stays open. */
export interface SectionProps { projectId: string | null; setProjectId: (id: string | null) => void; registerBusy: (key: string, busy: boolean) => void; registerDirty: (key: string, dirty: boolean) => void; requestClose: () => boolean }
/** Report one busy/dirty flag under `key` while the caller is mounted. */
export function useRegistered(register: (key: string, value: boolean) => void, key: string, value: boolean) {
  useEffect(() => { register(key, value); return () => register(key, false) }, [register, key, value])
}

const TABS: TabDef[] = localized([
  { id: 'general', label: '通用', icon: Settings2, scope: 'app', component: GeneralSection },
  { id: 'models', label: '模型', icon: Cpu, scope: 'app', component: ModelsSection },
  { id: 'updates', label: '应用更新', icon: LifeBuoy, scope: 'app', component: UpdatesSection },
  { id: 'about', label: '关于', icon: Info, scope: 'app', component: AboutSection },
  { id: 'memory', label: '记忆', icon: Brain, scope: 'project', component: MemorySection, advanced: true },
  { id: 'autonomy', label: '自主与节奏', icon: Sparkles, scope: 'project', component: AutonomySection, advanced: true },
  { id: 'judgment', label: '判断', icon: Scale, scope: 'app', component: JudgmentSection, advanced: true },
  { id: 'evolution', label: '系统进化', icon: Dna, scope: 'app', component: SystemEvolutionSection, advanced: true },
  { id: 'webtools', label: '网页工具', icon: Globe, scope: 'app', component: WebToolsSection, advanced: true },
  { id: 'usage', label: '使用统计', icon: BarChart3, scope: 'app', component: UsageSection, advanced: true },
])

const DESCRIPTIONS: Record<SettingsTab, MessageKey> = localized({
  general: '界面偏好、调用额度与全局执行控制',
  models: '提供商、模型目录、凭据与默认模型',
  memory: '项目记忆的连接、自动关联与保存',
  autonomy: '当前项目的主动协作、节奏与预算',
  judgment: '内置判断：JEV 密钥、快速模型与判断点',
  evolution: '跨项目信号汇总与通用组件的待审提议（只读）',
  webtools: '联网搜索与网页抓取',
  updates: '当前版本与自动更新',
  usage: '真实用量、缓存命中与各用途开销',
  about: '版本信息',
})

// A project panel that hands off to settings (项目设置 →「打开完整主动设置」, 记忆浏览 →「记忆偏好」) closes itself and
// opens settings in the same click: settings then opens on that project, not on the selected one.
let closedPanelProject: string | null = null, handoffProject: string | null = null
usePanels.subscribe((state, prev) => {
  const closed = (prev.projectSettings && !state.projectSettings ? prev.projectSettings.projectId : null) ?? (prev.memory && !state.memory ? prev.memory.projectId : null)
  if (closed) { closedPanelProject = closed; queueMicrotask(() => { closedPanelProject = null }) }
  if (state.settings && !prev.settings) handoffProject = closedPanelProject
})
/** The project handed to this opening of settings, once. */
export function takeSettingsHandoff() { const project = handoffProject; handoffProject = null; return project }

/**
 * The project the per-project sections show. Every opening picks it while rendering, before any section mounts (an
 * effect would let them fetch and draw the previous opening's project first): the project a panel handed off, else
 * the selected one. A ProjectPicker switch lasts until the panel closes.
 */
export function useSettingsProject(open: boolean) {
  const selectedProjectId = useApp(s => s.selectedProjectId)
  const [projectId, setProjectId] = useState<string | null>(selectedProjectId)
  const [opened, setOpened] = useState(false)
  if (open !== opened) {
    setOpened(open)
    if (open) setProjectId(handoffProject ?? selectedProjectId ?? projectId)
  }
  useEffect(() => { if (open) takeSettingsHandoff() }, [open])
  useEffect(() => { if (!projectId && selectedProjectId) setProjectId(selectedProjectId) }, [selectedProjectId, projectId])
  return [projectId, setProjectId] as const
}

export function SettingsDialog() {
  const tab = usePanels(s => s.settings)
  const open = tab !== null
  const [projectId, setProjectId] = useSettingsProject(open)
  // Focus back to what opened it (the top bar's menu, a panel's link) when it closes: there is no Dialog.Trigger.
  const returnFocus = useReturnFocus(open)
  const busy = useRef(new Set<string>())
  const dirty = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)
  const configError = useConfiguration(s => s.error)
  const hasConfig = useConfiguration(s => Boolean(s.value))
  const t = useT()

  useEffect(() => { if (open) void reloadConfiguration() }, [open])

  const [visited, setVisited] = useState<Set<SettingsTab>>(() => new Set())
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    if (tab) setVisited(v => (v.has(tab) ? v : new Set(v).add(tab)))
    else setVisited(new Set())
  }, [tab])

  const registerBusy = useCallback((key: string, value: boolean) => { if (value) busy.current.add(key); else busy.current.delete(key) }, [])
  const registerDirty = useCallback((key: string, value: boolean) => { if (value) dirty.current.add(key); else dirty.current.delete(key) }, [])
  // Closing unmounts every section, so an unsaved draft (a typed API key included) would be lost without a word.
  // Sections that leave settings (「打开项目记忆」) close through this too.
  const guardedClose = () => {
    if (busy.current.size) { toast(t('正在保存，请稍候…')); return false }
    if (dirty.current.size && !confirm(t('设置里有未保存的更改，关闭后会丢失。仍要关闭吗？'))) return false
    dirty.current.clear()
    closeSettings()
    return true
  }

  const active = TABS.find(x => x.id === tab) ?? TABS[0]
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => { if (active.advanced) setAdvancedOpen(true) }, [active.advanced])

  return (
    <RDialog.Root open={open} onOpenChange={next => { if (!next) guardedClose() }}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-[var(--bg-overlay)] backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </RDialog.Overlay>
            <RDialog.Content asChild forceMount tabIndex={-1} onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus() }} onCloseAutoFocus={returnFocus}>
              <motion.div
                className="fixed left-1/2 top-1/2 z-50 flex h-[min(780px,calc(100dvh-48px))] w-[min(960px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] bg-elevated text-fg shadow-lg outline-none max-md:inset-0 max-md:h-dvh max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:flex-col max-md:rounded-none"
                initial={{ opacity: 0, scale: 0.975, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.985, y: 6, transition: { duration: 0.14 } }}
                transition={{ type: 'spring', stiffness: 460, damping: 38, mass: 0.85 }}
                aria-label={tr('设置')}
              >
                <VisuallyHidden.Root><RDialog.Description>{tr('应用设置与项目偏好')}</RDialog.Description></VisuallyHidden.Root>
                {/* rail */}
                <nav className="flex w-[212px] shrink-0 flex-col bg-sidebar px-3 pb-3 pt-5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1 max-md:overflow-x-auto max-md:px-2 max-md:py-2" aria-label={tr('设置分类')}>
                  <RDialog.Title className="mb-4 px-3 text-[16px] font-semibold leading-6 max-md:hidden">{t('设置')}</RDialog.Title>
                  <div className="flex flex-col gap-0.5 max-md:flex-row">
                    {TABS.filter(item => !item.advanced).map(item => <NavItem key={item.id} item={item} selected={item.id === active.id} label={t(item.label)} />)}
                    <button type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(v => !v)}
                      className="mt-2 flex h-8 shrink-0 items-center gap-2 rounded-[10px] px-3 text-left text-[12.5px] text-fg-4 transition-colors hover:bg-hover hover:text-fg-2">
                      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-150', advancedOpen && 'rotate-90')} strokeWidth={1.8} />
                      <span className="whitespace-nowrap">{t('高级')}</span>
                      {advancedOpen && <span className="whitespace-nowrap text-[11px] max-md:hidden">· {t('一般不需要改')}</span>}
                    </button>
                    {TABS.filter(item => item.advanced && (advancedOpen || item.id === active.id)).map(item => <NavItem key={item.id} item={item} selected={item.id === active.id} label={t(item.label)} />)}
                  </div>
                  <div className="mt-auto flex items-center gap-2 px-3 pt-4 text-[11.5px] text-fg-4 max-md:hidden">
                    <span className="size-1.5 rounded-full bg-success" />
                    {t('本地工作空间')} · {t('配置保存在本机')}
                  </div>
                </nav>
                {/* content */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <header className="flex shrink-0 items-start gap-4 px-8 pb-2 pt-6 max-md:px-5 max-md:pt-4">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.01em]">{t(active.label)}</h2>
                      <p className="mt-0.5 text-[12.5px] text-fg-3">{active.scope === 'project' ? `${t('当前项目')} · ${t('可切换')}` : `${t('应用设置')} · ${t('所有项目共用')}`} · {t(DESCRIPTIONS[active.id])}</p>
                    </div>
                    <CloseButton onClick={guardedClose} label={t('关闭设置')} />
                  </header>
                  <div ref={scroller} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-4 max-md:px-5">
                    {!hasConfig && configError ? (
                      <Note tone="danger" action={<Button size="sm" onClick={() => void reloadConfiguration()}>{tr('重试')}</Button>}>{configError}</Note>
                    ) : !hasConfig ? (
                      <SectionSkeleton />
                    ) : (
                      TABS.filter(item => visited.has(item.id) || item.id === active.id).map(item => (
                        // Visited sections stay mounted (hidden) so unsaved drafts survive tab switches, as in the legacy panel.
                        <div key={item.id} hidden={item.id !== active.id} className="animate-[rna-pop-in_200ms_var(--ease-out)]">
                          <Suspense fallback={<SectionSkeleton />}>
                            <item.component projectId={projectId} setProjectId={setProjectId} registerBusy={registerBusy} registerDirty={registerDirty} requestClose={guardedClose} />
                          </Suspense>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  )
}

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-72" />
      <Skeleton className="mt-4 h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  )
}

function NavItem({ item, selected, label }: { item: TabDef; selected: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={() => openSettings(item.id)}
      className={cn(
        'relative flex h-9 shrink-0 items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] transition-colors duration-150 max-md:h-8',
        selected ? 'font-medium text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2',
      )}
    >
      {selected && <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-[10px] bg-active" transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }} />}
      <item.icon className={cn('relative size-4 shrink-0', selected ? 'text-accent' : 'text-fg-4')} strokeWidth={1.8} />
      <span className="relative whitespace-nowrap">{label}</span>
    </button>
  )
}
