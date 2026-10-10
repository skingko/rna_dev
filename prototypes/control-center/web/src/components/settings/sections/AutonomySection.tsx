/**
 * 自主与节奏: per-project autonomy form (legacy renderAutonomy) with the
 * read-only adaptive rhythm card and the interactive-only model restriction.
 * Project schedules live in the project 任务 view.
 */
import { useState, type FormEvent } from 'react'
import { Activity, CalendarClock, Sparkles } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import { Button } from '@/components/ui/primitives'
import { ProjectPicker, useProjectDetail } from '@/components/projects/ProjectPicker'
import { useApp } from '@/store/app-store'
import { Disclosure, Empty, Field, FieldRow, Group, Note, SaveBar, Select, SettingsSection, TextArea, TextInput, ToggleRow, formatDateTime, useFormState } from '../form'
import { useConfiguration } from '../config-store'
import { openSettings } from '../panel-store'
import { backgroundModelRestriction } from '../model-catalog'
import { FREQUENCY_PRESETS, adaptiveRhythmDisplay, autonomyDraft, autonomyPayload, durationLabel, frequencyPreset, readFrequency, rhythmChangesAt, type AutonomyDraft, type RhythmDisplay } from '../autonomy'
import { useNowUntil } from '@/hooks/useNow'
import type { ProjectDetail } from '@/api/panels-types'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { TaskTypesSection } from './TaskTypesSection'
import { evolutionRowValue, useEvolutionLanes } from '@/components/views/EvolutionObservability'
import { t } from '@/i18n'

export default function AutonomySection({ projectId, setProjectId, registerBusy, registerDirty }: SectionProps) {
  const project = useProjectDetail(projectId)
  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-fg-3">{t('这些设置只作用于所选项目。')}</p>
        <ProjectPicker value={projectId} onChange={setProjectId} />
      </div>
      {project ? <AutonomyForm key={project.id} project={project} registerBusy={registerBusy} registerDirty={registerDirty} /> : <Empty>{t('先选择或创建项目，再设置主动协作。')}</Empty>}
    </>
  )
}

function AutonomyForm({ project, registerBusy, registerDirty }: { project: ProjectDetail } & Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const form = useFormState()
  const [draft, setDraft] = useState<AutonomyDraft>(() => autonomyDraft(project))
  useRegistered(registerBusy, `autonomy-${project.id}`, form.busy)
  useRegistered(registerDirty, `autonomy-${project.id}`, form.dirty)
  const set = (patch: Partial<AutonomyDraft>) => { setDraft(d => ({ ...d, ...patch })); form.touch() }
  const actual = draft.actual
  const automatic = actual && draft.rhythm === 'auto'
  const values = readFrequency(draft)
  const invalidRange = values[1] < values[0]
  const preset = frequencyPreset(values)
  const initiative = project.initiative ?? {}
  const quietNow = initiative.quietUntil && Date.parse(initiative.quietUntil) > Date.now()

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (invalidRange || !e.currentTarget.reportValidity()) return
    void form.submit(() => panelsApi.patchProject(project.id, autonomyPayload(draft)), () => setDraft(d => ({ ...d, quiet: 'keep' })), t('已保存项目设置'))
  }

  return (
    <>
      {actual && <RhythmPanel project={project} />}
      <form onSubmit={onSubmit}>
        {actual && (
          <SettingsSection title={t('运行节奏')} description={t('AI 根据项目类型、交付日程和完成状态调整沟通与进化；新的需求或结果可重新唤醒。下方开关始终由你控制。')}>
            <Select<'auto' | 'manual'> aria-label={t('运行节奏')} value={draft.rhythm} onChange={v => set({ rhythm: v })} className="max-w-72" options={[{ value: 'auto', label: t('自动适配项目（推荐）') }, { value: 'manual', label: t('手动固定节奏') }]} />
          </SettingsSection>
        )}
        <SettingsSection title={t('持续关注')} description={t('决定 AI 何时工作、何时与你沟通。')}>
          <Group>
            <ToggleRow label={t('项目主动协作')} description={actual ? t('持续理解项目与对话，自行决定研究、沟通或等待。关闭后停止主动判断和后台动作。') : t('根据项目新信息继续研究、提问或保持安静。')} checked={draft.enabled} onChange={v => set({ enabled: v })} />
            <ToggleRow label={t('暂停主动发言')} description={t('不提醒你，也不主动提问；该尽快看的发现留到恢复后再说，不急的照常安静送达。定时任务也暂停：到点的跳过，恢复后只补跑最近一次，已经开始的那次结果只放进收件箱。后台工作照常。')} checked={draft.muted} onChange={v => set({ muted: v })} />
            <ToggleRow label={t('输入时等待')} description={t('你正在输入时，延后主动消息。')} checked={draft.deferTyping} onChange={v => set({ deferTyping: v })} />
            <ToggleRow label={t('自主进化')} description={actual ? t('根据项目证据改进提示词、技能与脚本，执行评测后邀请试用，通过采用后才成为默认版本。') : t('根据项目反馈生成并评测候选；通过后邀请试用。')} checked={draft.evolve} onChange={v => set({ evolve: v })} />
          </Group>
          <Field label={t('当前关注')} className="mt-4">
            <TextArea rows={3} value={draft.focus} placeholder={t('当前项目最值得持续关注什么？')} onChange={e => set({ focus: e.target.value })} />
          </Field>
        </SettingsSection>
        {actual && (
          <SettingsSection title={t('沟通与通知')} description={t('主模型为每条主动消息给出紧急程度；你的设置与判断模型只会降低打扰程度，不会升级。')}>
            {draft.reach ? (
              <>
                <Group>
                  <ToggleRow label={t('桌面通知')} description={t('允许最紧急的发现另发系统通知（桌面版）。默认关闭；关闭时这类消息只出现在对话中。')} checked={draft.desktopNotifications} onChange={v => set({ desktopNotifications: v })} />
                </Group>
                <Field label={t('每日摘要时间')} className="mt-4" help={t('不紧急的发现先暂存，每天在这个时间（本机时区）合并为一条「今日摘要」。')}>
                  <Select aria-label={t('每日摘要时间')} value={draft.digestHour} className="max-w-40" onChange={v => set({ digestHour: v })} options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))} />
                </Field>
              </>
            ) : <Note>{t('当前本地服务版本不支持分级触达（收件箱、桌面通知与每日摘要）。')}</Note>}
          </SettingsSection>
        )}
        <SettingsSection title={t('节奏与预算')} description={t('自动适配会减少没有新信息时的重复判断。预算始终生效。')}>
          {automatic ? (
            <Note>{t('当前节奏与原因显示在上方，并随项目状态调整。切换到手动模式可固定频率。')}</Note>
          ) : (
            <div className="space-y-3">
              <Field label={t('协作节奏')} help={t('预设同时调整复查窗口、主动发言与自动进化间隔；现有自定义值不会被覆盖。')}>
                <Select aria-label={t('协作节奏')} value={preset} className="max-w-72" onChange={id => { const p = FREQUENCY_PRESETS.find(x => x.id === id); if (p) set({ frequency: p.values.map(v => String(v / 1000)) as AutonomyDraft['frequency'] }) }}
                  options={[...FREQUENCY_PRESETS.map(p => ({ value: p.id, label: p.label })), { value: 'custom', label: t('自定义'), disabled: true }]} />
              </Field>
              <p className="text-[12px] tabular-nums text-fg-4">{t('复查 {v}至 {v2} · 发言 {v3} · 自动进化 {v4}', { v: durationLabel(values[0]), v2: durationLabel(values[1]), v3: durationLabel(values[2]), v4: durationLabel(values[3]) })}</p>
              <Disclosure summary={t('精确设置频率')}>
                <FieldRow>
                  {([[t('无新证据复查 · 最短（秒）'), 1, 86400, t('复查逐步放慢的起点，不代表每隔这些秒一定发言。')], [t('无新证据复查 · 最长（秒）'), 1, 86400, t('等待窗口的上限；新消息、执行结果等仍可提前唤醒。')], [t('主动发言最短间隔（秒）'), 0, 86400, t('限制主动接话和提问；0 表示不额外设置间隔。')], [t('自动进化尝试最短间隔（秒）'), 0, 604800, t('仍需新的项目证据和模型判断；时间到不强制生成候选。手动评估不受此间隔限制。')]] as const).map(([title, min, max, help], index) => (
                    <Field key={title} label={title} help={help} error={index === 1 && invalidRange ? t('最长复查间隔不能短于最短复查间隔。') : undefined}>
                      <TextInput type="number" required min={min} max={max} step={0.001} value={draft.frequency[index]} aria-invalid={index === 1 && invalidRange} onChange={e => { const next = [...draft.frequency] as AutonomyDraft['frequency']; next[index] = e.target.value; set({ frequency: next }) }} />
                    </Field>
                  ))}
                </FieldRow>
              </Disclosure>
            </div>
          )}
          <FieldRow className="mt-4">
            {!actual && <Field label={t('相关性门槛（0–1）')}><TextInput type="number" min={0} max={1} step={0.05} value={draft.relevance} onChange={e => set({ relevance: e.target.value })} /></Field>}
            <Field label={actual ? t('项目主动协作 token 上限') : t('项目预算上限（USD）')} help={actual ? t('留空表示不限额。累计计入 {v} tokens；优先采用提供商用量，无法确认时按预留量结算。判断、研究与候选生成共用此上限，并受全局每日预算约束。', { v: Number(initiative.tokens ?? 0).toLocaleString() }) : t('当前已使用 ${v}。演示期间按模拟用量计费，全局预算仍然有效。', { v: Number(initiative.spentUsd ?? 0).toFixed(3) })}>
              <TextInput type="number" min={0} max={actual ? 100000000 : 10000} step={actual ? 1 : 0.01} value={draft.budget} placeholder={actual ? t('不限额') : undefined} onChange={e => set({ budget: e.target.value })} />
            </Field>
          </FieldRow>
          <Field label={t('临时安静')} className="mt-4" help={actual ? t('仅暂停主动发言；后台研究与候选整理仍可继续。需要停止后台工作时，关闭「项目主动协作」。') : t('安静期暂停主动发言和新增后台动作，项目观察仍然保留。')}>
            <Select<AutonomyDraft['quiet']> aria-label={t('临时安静')} value={draft.quiet} className="max-w-72" onChange={v => set({ quiet: v })} options={[
              { value: 'keep', label: quietNow ? t('保持安静至 {v}', { v: formatDateTime(initiative.quietUntil) }) : t('按当前设置运行') },
              { value: 'off', label: actual ? t('恢复主动发言') : t('恢复主动协作') },
              { value: '30', label: t('安静 30 分钟') }, { value: '60', label: t('安静 1 小时') }, { value: '480', label: t('安静 8 小时') },
            ]} />
          </Field>
        </SettingsSection>
        <div className="sticky -bottom-10 z-10 -mx-8 mt-2 border-t border-line-faint bg-elevated px-8 pb-4 pt-0.5 max-md:-mx-5 max-md:px-5">
          <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} submitLabel={t('保存项目设置')} />
        </div>
      </form>
      <Note className="mt-6">{actual ? t('这些设置只作用于当前项目。模型在后台读取已分配的能力和证据，合适时回到对话。候选脚本先执行冒烟检查，再用冻结的基线标准比较两个版本；评估记录与版本保留在项目中，通过后主动邀请试用。修改评估标准会创建新候选，不会覆盖已有基线。') : t('这些设置只作用于当前项目。关闭自主进化不会替换已采用的版本；版本试用与采用仍由你在对话或项目版本中选择。')}</Note>
      {actual && <TaskTypesSection projectId={project.id} registerBusy={registerBusy} registerDirty={registerDirty} />}
      {actual && <p className="mt-3 flex items-center gap-1.5 text-[12px] text-fg-4"><CalendarClock className="size-3.5" />{t('项目日程（定时交付）在项目的「任务」页面管理。')}</p>}
    </>
  )
}

function RhythmPanel({ project }: { project: ProjectDetail }) {
  const configuration = useConfiguration(s => s.value) ?? useApp.getState().configuration
  const restriction = backgroundModelRestriction(project, configuration as never)
  const now = useNowUntil(at => rhythmChangesAt(project, at))
  const display = adaptiveRhythmDisplay(project, now)
  // EVO-12: the gene lanes' own state replaces the retired whole-genome learning lane's row and quota note.
  const lanes = useEvolutionLanes(project.id)
  const card = <RhythmCard display={display} evolution={evolutionRowValue(project.evolution?.enabled === false, display.evolution, lanes)} />
  return (
    <div className="mb-8 space-y-3">
      {restriction && (
        <Note tone="warning" action={<Button size="sm" variant="secondary" onClick={() => openSettings('models')}>{t('打开模型设置')}</Button>}>
          <p>{restriction.message}</p>
          <p className="mt-0.5 text-[12px] opacity-80">{t('{source}：{route}。开关与频率设置已保留。', { source: restriction.source, route: restriction.route })}</p>
        </Note>
      )}
      {restriction ? <Disclosure summary={t('已保存的项目节奏（等待可用模型后生效）')}>{card}</Disclosure> : card}
    </div>
  )
}

function RhythmCard({ display, evolution }: { display: RhythmDisplay; evolution: string }) {
  return (
    <section aria-label={t('当前项目节奏')} className="relative overflow-hidden rounded-2xl p-5 shadow-[0_0_0_1px_var(--line)] [background:radial-gradient(120%_140%_at_0%_0%,var(--accent-softer),transparent_60%),var(--bg-base)]">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><Sparkles className="size-3.5" /></span>
        <strong className="text-[14px] font-semibold text-fg">{display.title}</strong>
      </div>
      <p className="mt-2 line-clamp-3 text-[12.5px] leading-[1.65] text-fg-3" title={display.reason}>{display.reason}</p>
      {display.available && (
        <>
          <dl className="mt-4 grid gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-[88px_1fr]">
            {([[t('主动沟通'), display.initiative], [t('进化'), evolution], [t('项目交付'), display.schedule]] as const).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-fg-4">{label}</dt>
                <dd className="text-fg-2">{value}</dd>
              </div>
            ))}
          </dl>
          <Disclosure summary={t('节奏依据与最近调整{v}', { v: display.assessedAt ? ` · ${display.assessedAt}` : '' })} className="mt-2">
            <div className="space-y-2 text-[12.5px] leading-[1.6] text-fg-3">
              {display.blocker && (
                <>
                  <strong className="block text-fg-2">{t('当前后台阻塞')}</strong>
                  {display.blocker.pendingCount ? <p>{t('{pendingCount} 项会话清理待完成，已尝试 {v} 次。{v2}', { pendingCount: display.blocker.pendingCount, v: display.blocker.attempts ?? 0, v2: display.blocker.retryAt ? t('下次检查 {retryAt}。', { retryAt: display.blocker.retryAt }) : '' })}</p> : null}
                  {display.blocker.causes?.map(cause => <p key={cause}>{cause}</p>)}
                </>
              )}
              <strong className="block text-fg-2">{t('系统调度依据')}</strong>
              <p>{t('主动判断：{initiativeReason}', { initiativeReason: display.initiativeReason })}</p>
              {display.modelReason && (<><strong className="block text-fg-2">{display.control === 'manual' ? t('最近模型判断（历史依据）') : t('模型判断')}</strong><p className="whitespace-pre-wrap">{display.modelReason}</p></>)}
              {display.history.map((row, i) => (
                <div key={i} className="border-l-2 border-line pl-3">
                  <small className="text-fg-4">{[row.at, row.stage, row.initiative, row.evolution].filter(Boolean).join(' · ')}</small>
                  <p>{row.reason || t('本次调整未保留文字说明')}</p>
                </div>
              ))}
              {!display.history.length && <p className="flex items-center gap-1.5"><Activity className="size-3.5" />{t('尚无模型调整记录。')}</p>}
            </div>
          </Disclosure>
        </>
      )}
    </section>
  )
}
