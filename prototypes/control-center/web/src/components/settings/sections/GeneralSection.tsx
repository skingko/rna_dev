import { useEffect, useId, useState, type FormEvent } from 'react'
import { ChevronRight, Monitor, Moon, OctagonX, Sun } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import { useApp } from '@/store/app-store'
import { setTheme, useUi, type Theme } from '@/store/ui-store'
import { Button, Kbd, SegmentedTabs } from '@/components/ui/primitives'
import { useActiveProjects } from '@/components/projects/ProjectPicker'
import { Disclosure, Field, FieldRow, Group, Note, Row, SaveBar, Select, SettingsSection, TextInput, ToggleRow, ValueRow, useConfirmStep, useFormState } from '../form'
import { openSettings } from '../panel-store'
import { setPreference, usePreferences, ZOOM_LEVELS, type Language, type LayoutMode, type Zoom } from '../preferences'
import { useConfiguration } from '../config-store'
import { reloadGlobals, useGlobals } from '../globals-store'
import { emergencyText, setEmergency } from '../emergency'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, intlTag } from '@/i18n'

const fmt = { format: (n: number) => new Intl.NumberFormat(intlTag()).format(n) }

export default function GeneralSection({ projectId, registerBusy, registerDirty }: SectionProps) {
  useEffect(() => { void reloadGlobals() }, [])
  return (
    <>
      <AppearanceSection />
      <WorkspaceSection projectId={projectId} />
      <BudgetSection registerBusy={registerBusy} registerDirty={registerDirty} />
      <EmergencySection />
      <ShortcutsSection />
    </>
  )
}

export function AppearanceSection() {
  const theme = useUi(s => s.theme)
  const { language, layout, zoom, tasksAutoOpen } = usePreferences()
  return (
    <SettingsSection title={t('外观')} description={t('只影响此浏览器中的界面，不会改变对话内容或项目设置。')}>
      <Group>
        <Row label={t('界面主题')} description={t('跟随系统时，随 macOS 外观自动切换。')}>
          <SegmentedTabs<Theme>
            layoutId="settings-theme"
            value={theme}
            onChange={setTheme}
            className="rounded-lg bg-subtle p-0.5"
            items={[
              { id: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="size-3.5" />{t('浅色')}</span> },
              { id: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="size-3.5" />{t('深色')}</span> },
              { id: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" />{t('跟随系统')}</span> },
            ]}
          />
        </Row>
        <Row label={t('界面语言')} description={t('界面文字随语言切换；对话内容与服务生成的项目记录保持原文。')}>
          <Select<Language> aria-label={t('界面语言')} value={language} onChange={v => setPreference('language', v)} className="w-40" options={[{ value: 'system', label: t('系统默认') }, { value: 'zh', label: t('中文简体') }, { value: 'en', label: 'English' }]} />
        </Row>
        <Row label={t('界面模式')} description={t('宽屏阅读会放宽对话与回答的阅读宽度。')}>
          <Select<LayoutMode> aria-label={t('界面模式')} value={layout} onChange={v => setPreference('layout', v)} className="w-40" options={[{ value: 'standard', label: t('标准') }, { value: 'wide', label: t('宽屏阅读') }]} />
        </Row>
        <Row label={t('界面缩放')}>
          <Select aria-label={t('界面缩放')} value={String(zoom)} onChange={v => setPreference('zoom', Number(v) as Zoom)} className="w-40" options={ZOOM_LEVELS.map(z => ({ value: String(z), label: `${Math.round(z * 100)}%` }))} />
        </Row>
        <ToggleRow label={t('后台工作开始时打开任务面板')} description={t('当前项目开始后台工作时，在侧边显示后台任务，不替换你正在看的标签。关闭后只在顶栏显示数量。')}
          checked={tasksAutoOpen} onChange={v => setPreference('tasksAutoOpen', v)} />
      </Group>
    </SettingsSection>
  )
}

function WorkspaceSection({ projectId }: { projectId: string | null }) {
  const projects = useActiveProjects()
  const config = useConfiguration(s => s.value)
  const current = projects.find(p => p.id === projectId)
  return (
    <SettingsSection title={t('工作空间')} description={t('对话留在项目中，应用设置在项目之间共享。')}>
      <Group>
        <ValueRow label={t('当前项目')} value={current?.name ?? t('未选择')} />
        <ValueRow label={t('项目数量')} value={projects.length} />
        <ValueRow label={t('模型运行时')} value={`Rna SDK${config?.runtime?.sdkVersion ? ` ${config.runtime.sdkVersion}` : ''}`} />
        <ValueRow label={t('项目记忆')} value={t('自动连接')} />
      </Group>
      <Note className="mt-3">{t('模型、记忆偏好与主动协作设置会保存到本机。具体执行方式取决于所选模型与运行时状态。')}</Note>
    </SettingsSection>
  )
}

function BudgetSection({ registerBusy, registerDirty }: Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const settings = useGlobals(s => s.settings)
  const usage = useGlobals(s => s.health?.workload?.tokenUsage)
  const form = useFormState()
  const [unlimited, setUnlimited] = useState(true)
  const [real, setReal] = useState('')
  const [concurrent, setConcurrent] = useState('1')
  const [daily, setDaily] = useState('')
  const [tokens, setTokens] = useState('')
  const ids = { real: useId(), concurrent: useId(), daily: useId(), tokens: useId() }

  useEffect(() => {
    if (!settings || form.dirty) return
    setUnlimited(settings.realTokenBudget == null)
    setReal(settings.realTokenBudget == null ? '' : String(settings.realTokenBudget))
    setConcurrent(String(settings.maxConcurrent ?? 1))
    setDaily(String(settings.dailyBudget ?? ''))
    setTokens(String(settings.tokenBudget ?? ''))
  }, [settings]) // eslint-disable-line react-hooks/exhaustive-deps
  useRegistered(registerBusy, 'general-budget', form.busy)
  useRegistered(registerDirty, 'general-budget', form.dirty)

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!e.currentTarget.reportValidity()) return
    void form.submit(
      () => panelsApi.patchSettings({ dailyBudget: Number(daily), tokenBudget: Number(tokens), maxConcurrent: Number(concurrent), realTokenBudget: unlimited ? null : Number(real) }),
      () => reloadGlobals(),
      t('已保存到本机'),
    )
  }
  const reported = usage?.reported ?? 0, estimated = usage?.estimated ?? 0, reserved = usage?.reserved ?? 0
  return (
    <SettingsSection title={t('调用额度')} description={t('真实模型与演示分别记账。上下文窗口由模型规格决定，不是每日预算。')}>
      <form onSubmit={onSubmit} onChange={form.touch}>
        <Group>
          <ToggleRow label={t('真实调用不限每日 token')} description={t('开启后不设置应用内每日硬限；仍记录实际用量。')} checked={unlimited} onChange={v => { setUnlimited(v); form.touch() }} />
        </Group>
        <FieldRow className="mt-3">
          {!unlimited && (
            <Field label={t('真实调用每日 token 上限')} htmlFor={ids.real}>
              <TextInput id={ids.real} type="number" min={0} max={100000000} step={1} required value={real} onChange={e => setReal(e.target.value)} />
            </Field>
          )}
          <Field label={t('Rna 会话并发上限')} htmlFor={ids.concurrent}>
            <TextInput id={ids.concurrent} type="number" min={1} max={4} required value={concurrent} onChange={e => setConcurrent(e.target.value)} />
          </Field>
        </FieldRow>
        <p className="mt-2.5 text-[12px] leading-[1.6] text-fg-4">
          {t('今日真实用量 {v} tokens（提供商报告 {v2}，缺失报告时估算 {v3}）；请求预留 {v4}。', { v: fmt.format(reported + estimated), v2: fmt.format(reported), v3: fmt.format(estimated), v4: fmt.format(reserved) })}
        </p>
        <Disclosure summary={t('演示额度')} className="mt-2">
          <FieldRow>
            <Field label={t('每日演示额度（USD）')} htmlFor={ids.daily}><TextInput id={ids.daily} type="number" min={0} max={10000} step={0.01} required value={daily} onChange={e => setDaily(e.target.value)} /></Field>
            <Field label={t('每日演示 token 上限')} htmlFor={ids.tokens}><TextInput id={ids.tokens} type="number" min={0} max={10000000} step={1} required value={tokens} onChange={e => setTokens(e.target.value)} /></Field>
          </FieldRow>
        </Disclosure>
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} />
      </form>
    </SettingsSection>
  )
}

/** Turning the stop on takes a second click that says what stops (the top bar menu asks the same; ../emergency). */
function EmergencySection() {
  const emergency = useGlobals(s => s.emergency)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const confirmStop = useConfirmStep(10000)
  const toggle = async () => {
    if (!emergency && !confirmStop.armed) { confirmStop.arm(); return }
    confirmStop.disarm()
    setBusy(true)
    try { setMessage(await setEmergency(!emergency)) } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  const description = confirmStop.armed ? emergencyText.confirm() : message ?? (emergency ? emergencyText.on() : t('急停会暂停所有项目与会话，保留草稿、队列和进度。'))
  return (
    <SettingsSection title={t('全局执行控制')}>
      <Group>
        <Row label={emergency ? t('急停已开启') : t('全局急停')} description={description}>
          {confirmStop.armed && <Button variant="ghost" size="sm" onClick={confirmStop.disarm}>{t('取消')}</Button>}
          <Button variant={emergency ? 'secondary' : 'danger'} size="sm" disabled={busy} onClick={() => void toggle()} leading={emergency ? undefined : <OctagonX className="size-3.5" />}>
            {emergency ? t('解除急停') : confirmStop.armed ? t('确认急停') : t('全局急停')}
          </Button>
        </Row>
      </Group>
    </SettingsSection>
  )
}

function ShortcutsSection() {
  const mode = useApp(s => s.mode)
  const desktop = Boolean(window.rnaDesktop)
  return (
    <>
      <SettingsSection title={t('快速设置')}>
        <Group>
          {([['models', t('配置模型'), t('提供商、模型目录与默认选择')], ['memory', t('管理项目记忆'), t('记忆偏好与连接')], ['autonomy', t('调整主动协作'), t('发言节奏、预算与自主进化')]] as const).map(([tab, name, description]) => (
            <button key={tab} type="button" onClick={() => openSettings(tab)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover">
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-fg">{name}</span><span className="block text-[12px] text-fg-3">{description}</span></span>
              <ChevronRight className="size-4 text-fg-4" />
            </button>
          ))}
        </Group>
      </SettingsSection>
      <SettingsSection title={t('键盘快捷键')}>
        <Group>
          {/* The bindings live in App.tsx. */}
          <Row label={t('新会话')}><span className="flex items-center gap-0.5 text-[12px] text-fg-4"><Kbd>⇧</Kbd><Kbd>⌘</Kbd><Kbd>O</Kbd>{desktop && <><span className="mx-1">/</span><Kbd>⌘</Kbd><Kbd>N</Kbd></>}</span></Row>
          <Row label={t('搜索会话')}><span className="flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span></Row>
          <Row label={t('显示或隐藏侧边面板')}><span className="flex gap-0.5"><Kbd>⌥</Kbd><Kbd>⌘</Kbd><Kbd>B</Kbd></span></Row>
          <Row label={t('发送消息 / 换行')}><span className="flex items-center gap-1 text-[12px] text-fg-4"><Kbd>Enter</Kbd>/<Kbd>Shift</Kbd><Kbd>Enter</Kbd></span></Row>
        </Group>
        {mode === 'legacy' && <Note className="mt-3" tone="warning">{t('当前 daemon 未提供 v2 读取接口，界面以兼容模式运行。')}</Note>}
      </SettingsSection>
    </>
  )
}
