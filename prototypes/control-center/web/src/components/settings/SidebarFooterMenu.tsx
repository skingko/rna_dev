/**
 * Sidebar foot (after the reference account menu): a workspace row that opens
 * a menu with 界面语言 / 界面主题 / 界面模式 / 界面缩放 submenus, usage, the
 * global panels and settings; plus a settings gear and the daemon status.
 */
import type { ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Archive, BarChart3, BookOpen, Check, ChevronRight, Globe, LayoutPanelLeft, Palette, Puzzle, Settings, Store, ZoomIn } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { setTheme, useUi, type Theme } from '@/store/ui-store'
import { StatusDot, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { openArchive, openCapabilities, openMemory, openSettings } from './panel-store'
import { setPreference, usePreferences, ZOOM_LEVELS, type Language, type LayoutMode, type Zoom } from './preferences'
import { useT } from './i18n'
import { t as tr } from '@/i18n'

const itemClass = 'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-[14.5px] outline-none transition-colors duration-100 data-[highlighted]:bg-hover data-[state=open]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3'
const contentClass = 'menu-content z-50 min-w-44 overflow-hidden rounded-xl bg-elevated p-1 text-fg shadow-lg outline-none'

function Item({ icon, children, onSelect, hint }: { icon: ReactNode; children: ReactNode; onSelect: () => void; hint?: ReactNode }) {
  return (
    <DropdownMenu.Item className={itemClass} onSelect={onSelect}>
      {icon}<span className="min-w-0 flex-1 truncate">{children}</span>{hint && <span className="text-[13px] text-fg-4">{hint}</span>}
    </DropdownMenu.Item>
  )
}

function Sub<T extends string | number>({ icon, label, value, options, onChange }: { icon: ReactNode; label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const current = options.find(o => o.value === value)
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={itemClass}>
        {icon}<span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="max-w-20 truncate text-[13px] text-fg-4">{current?.label}</span>
        <ChevronRight className="!size-3.5 !text-fg-4" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={10} className={contentClass}>
          {options.map(option => (
            <DropdownMenu.Item key={String(option.value)} className={cn(itemClass, 'pr-2')} onSelect={e => { e.preventDefault(); onChange(option.value) }}>
              <span className={cn('min-w-0 flex-1 truncate', option.value === value ? 'font-medium text-fg' : 'text-fg-2')}>{option.label}</span>
              {option.value === value && <Check className="!size-3.5 !text-accent" strokeWidth={2.2} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

export function SidebarFooterMenu({ onNavigate }: { onNavigate?: () => void }) {
  const connection = useApp(s => s.connection)
  const mode = useApp(s => s.mode)
  const projectId = useApp(s => s.selectedProjectId)
  const archived = useApp(s => Object.values(s.projects).filter(p => p.archivedAt).length + Object.values(s.sessionIndex).filter(x => x.archivedAt).length)
  const theme = useUi(s => s.theme)
  const { language, layout, zoom } = usePreferences()
  const t = useT()
  const go = (fn: () => void) => () => { fn(); onNavigate?.() }
  const status = connection === 'online' ? (mode === 'legacy' ? t('兼容模式') : t('已连接')) : connection === 'connecting' ? t('连接中') : t('已断开')

  return (
    <div className="flex items-center gap-1 border-t border-line-faint px-2 py-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="group flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-hover data-[state=open]:bg-active" aria-label={tr('界面与应用菜单')}>
            <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-[var(--brand-mark)] text-[13.5px] font-semibold text-[var(--brand-mark-fg)] shadow-[inset_0_-1px_0_rgb(0_0_0/0.18)]" style={{ fontFamily: 'var(--font-brand)', fontStyle: 'italic' }}>
              R
              <span className="absolute -bottom-0.5 -right-0.5 grid size-3 place-items-center rounded-full bg-sidebar"><StatusDot state={connection === 'online' ? 'success' : connection === 'connecting' ? 'waiting' : 'offline'} /></span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-medium leading-4 text-fg">{t('本地工作空间')}</span>
              <span className="block truncate text-[12.5px] leading-4 text-fg-4">{tr('本地 daemon · {status}', { status })}</span>
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="start" sideOffset={8} collisionPadding={10} className={cn(contentClass, 'w-60')}>
            <Sub<Language> icon={<Globe />} label={t('界面语言')} value={language} onChange={v => setPreference('language', v)} options={[{ value: 'system', label: t('系统默认') }, { value: 'en', label: 'English' }, { value: 'zh', label: tr('中文简体') }]} />
            <Sub<Theme> icon={<Palette />} label={t('界面主题')} value={theme} onChange={setTheme} options={[{ value: 'system', label: t('跟随系统') }, { value: 'light', label: t('浅色') }, { value: 'dark', label: t('深色') }]} />
            <Sub<LayoutMode> icon={<LayoutPanelLeft />} label={t('界面模式')} value={layout} onChange={v => setPreference('layout', v)} options={[{ value: 'standard', label: t('标准') }, { value: 'wide', label: t('宽屏阅读') }]} />
            <Sub<Zoom> icon={<ZoomIn />} label={t('界面缩放')} value={zoom} onChange={v => setPreference('zoom', v)} options={ZOOM_LEVELS.map(z => ({ value: z, label: `${Math.round(z * 100)}%` }))} />
            <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
            <Item icon={<BarChart3 />} onSelect={go(() => openSettings('usage'))}>{t('使用统计')}</Item>
            <Item icon={<BookOpen />} onSelect={go(() => openMemory(projectId))}>{t('项目记忆')}</Item>
            <Item icon={<Puzzle />} onSelect={go(() => openCapabilities(projectId))}>{t('技能与工具')}</Item>
            <Item icon={<Store />} onSelect={go(() => openCapabilities(projectId, 'market'))}>{t('技能市场')}</Item>
            <Item icon={<Archive />} hint={archived || undefined} onSelect={go(() => openArchive())}>{t('已归档')}</Item>
            <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-faint" />
            <Item icon={<Settings />} hint="⌘," onSelect={go(() => openSettings())}>{t('设置')}</Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Tooltip content={t('设置')} shortcut="⌘," side="top">
        <button type="button" onClick={go(() => openSettings())} aria-label={t('设置')} className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          <Settings className="size-4" strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  )
}
