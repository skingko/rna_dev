/**
 * 判断: built-in JEV judgment. Editable: exactly `settings.editable` (JEV key,
 * fast model, 自动选择模型). Read-only: the automatic judge order with the one
 * answering now, any diagnostic override, the built-in points, calibration
 * and the audit trail. No mode, per-point or backend switches.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { DecisionKernelConfig, PlanSource } from '@/api/panels-types'
import { Button, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Badge, Disclosure, Field, Group, Note, Row, SaveBar, Select, SettingsSection, TextInput, ToggleRow, useFormState, type FormStatus, type Option } from '../form'
import { useConfiguration } from '../config-store'
import { JUDGE_HINTS, JUDGE_LABELS, STAKE_LABELS, checkJudgmentKey, decisionAssessmentDisplay, decisionEntryDisplay, describedPoints, diagnosticLine, editableSettings, judgeOrder, judgmentDraft, judgmentPayload, judgmentStatus, keyCheckStatus, percent, pointEffectOf, pointLabel, pointTitleOf, questionTitle, type JudgmentDraft } from '../judgment'
import { CalibrationPanel } from '../CalibrationPanel'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, intlTag } from '@/i18n'

const KEY_INPUT_ID = 'settings-jev-api-key'

export default function JudgmentSection({ registerBusy, registerDirty }: SectionProps) {
  const [config, setConfig] = useState<DecisionKernelConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The form remounts when the saved settings change; the last save's status outlives it.
  const [notice, setNotice] = useState<FormStatus>(null)
  const load = async () => {
    try { setConfig(await panelsApi.decisionKernel()); setError(null) } catch (e) { setError(t('JEV 判断模型配置暂不可用：{message}', { message: (e as Error).message })) }
  }
  useEffect(() => { void load() }, [])
  if (error) return <Note tone="danger" action={<Button size="sm" onClick={() => void load()}>{t('重试')}</Button>}>{error}</Note>
  if (!config) return <div className="space-y-3"><Skeleton className="h-10 w-full rounded-lg" /><Skeleton className="h-48 w-full rounded-xl" /></div>
  const status = judgmentStatus(config)
  const planCount = Number.isSafeInteger(config.planReadyCount) ? config.planReadyCount! : (config.plans ?? []).length
  return (
    <>
      <p className="mb-4 text-[12.5px] leading-[1.65] text-fg-3">{t('判断已内置：JEV 只为主模型或宿主提出的选项快速评分，从不授予权限；项目理解、计划与执行仍由主模型负责。')}</p>
      <Note tone={status.tone} className="mb-2" action={status.tone === 'danger' ? <Button size="sm" onClick={() => document.getElementById(KEY_INPUT_ID)?.focus()}>{t('重新填写密钥')}</Button> : undefined}>{status.text}</Note>
      <p className="mb-6 text-[12px] text-fg-4">{planCount ? t('{planCount} 个项目已有主模型判断选项。仅使用与当前策略版本匹配的选项评分。', { planCount }) : t('等待主模型提供判断选项。连接配置就绪也不会自行生成问题、选项或任务计划。')}</p>
      <JudgmentForm key={JSON.stringify([config.apiKeyConfigured, config.fastModel ?? config.llmModel ?? null, config.autoModel === true])} config={config} notice={notice} onSaved={(next, status) => { setConfig(next); setNotice(status) }} registerBusy={registerBusy} registerDirty={registerDirty} />
      {config.points?.length ? <CalibrationPanel config={config} /> : null}
      <SettingsSection title={t('运行记录')} description={t('近期保留的判断记录；评分用于比较已有选项，任务完成与版本质量仍以实际证据为准。')}>
        <div className="space-y-1">
          <PlansDisclosure config={config} />
          <PerformanceDisclosure config={config} />
          <HistoryDisclosure config={config} />
        </div>
      </SettingsSection>
    </>
  )
}

function JudgmentForm({ config, notice, onSaved, registerBusy, registerDirty }: { config: DecisionKernelConfig; notice: FormStatus; onSaved: (c: DecisionKernelConfig, status: FormStatus) => void } & Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  // Whether the effort points send their choice on GLM-like models (the internal-reasoning routing switch).
  const internalReasoning = useConfiguration(s => s.value?.internalReasoning ?? null)
  const providers = useConfiguration(s => s.value?.providers) ?? []
  const form = useFormState()
  const [draft, setDraft] = useState<JudgmentDraft>(() => judgmentDraft(config))
  useRegistered(registerBusy, 'judgment', form.busy)
  useRegistered(registerDirty, 'judgment', form.dirty)
  useEffect(() => { if (notice) form.setStatus(notice) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<JudgmentDraft>) => { setDraft(d => ({ ...d, ...patch })); form.touch() }
  const fastModels: Option[] = providers.filter(p => p.protocol !== 'demo' && p.usagePolicy !== 'interactive_only').flatMap(p => p.models.map(m => ({ value: `${p.id}\u0000${m.id}`, label: m.name || m.id, description: p.name, group: p.name })))
  const editable = editableSettings(config)
  const order = judgeOrder(config)
  const diagnostic = diagnosticLine(config)

  // A new key gets one minimal JEV call right away, so a wrong key shows here and not as silent fallbacks later.
  const save = (body: Parameters<typeof panelsApi.patchDecisionKernel>[0]) => form.submit(() => panelsApi.patchDecisionKernel(body), async () => {
    setDraft(d => ({ ...d, apiKey: '' }))
    let status: FormStatus = { text: t('已保存 JEV 设置'), tone: 'saved' }
    if (body.apiKey) { form.setStatus({ text: t('已保存，正在验证密钥…'), tone: 'default' }); status = keyCheckStatus(await checkJudgmentKey()) }
    form.setStatus(status)
    onSaved(await panelsApi.decisionKernel(), status)
  }, t('已保存 JEV 设置'))
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void save(judgmentPayload(draft, config)) }

  return (
    <form onSubmit={onSubmit}>
      <SettingsSection title={t('判断方式')} description={t('判断点全部内置，按下面的顺序自动选择判断方：有 JEV 密钥用 TypeSafe，否则用快速模型，都没有则不做判断。')}>
        <ol className="grid gap-2 sm:grid-cols-3" aria-label={t('判断顺序')} data-judge-order>
          {order.map(({ step, judge, active }, i) => (
            <li key={step} data-judge-step={step} aria-current={active ? 'true' : undefined}
              className={cn('rounded-xl p-3', active ? 'bg-accent-softer shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_var(--line)]')}>
              <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-subtle text-[11px] tabular-nums text-fg-3">{i + 1}</span>
                {judge ? t(JUDGE_LABELS[judge]) : step}
                {active && <Badge tone={judge === 'none' ? 'default' : 'success'} className="ml-auto">{t('当前')}</Badge>}
              </span>
              {judge && <span className="mt-1 block text-[12px] leading-[1.5] text-fg-3">{t(JUDGE_HINTS[judge])}</span>}
            </li>
          ))}
        </ol>
        {diagnostic && <Note tone="warning" className="mt-3">{diagnostic}</Note>}
        {editable.has('apiKey') && (
          <Field label={t('JEV 独立 API Key')} className="mt-4" help={t('密钥只写入本机凭据文件，读取配置时不会返回。')}>
            <div className="flex gap-2">
              <TextInput id={KEY_INPUT_ID} type="password" autoComplete="new-password" value={draft.apiKey} placeholder={config.apiKeyConfigured ? t('已保存密钥；留空保持不变') : 'JEV API Key'} onChange={e => set({ apiKey: e.target.value })} />
              <Button variant="ghost" className="h-9 shrink-0" disabled={!config.apiKeyConfigured || form.busy} leading={<KeyRound className="size-3.5" />} onClick={() => void save({ apiKey: '' })}>{t('移除密钥')}</Button>
            </div>
          </Field>
        )}
        {editable.has('fastModel') && (
          <Field label={t('快速模型')} className="mt-4" help={t('没有 JEV 密钥时作为判断模型，也用于每轮路由的模型档位建议。只能选择可用于后台的 API 模型；建议选择响应快的小模型。留空则不使用。')}>
            <Select aria-label={t('快速模型')} value={draft.fastModel} onChange={v => set({ fastModel: v })} options={[{ value: '', label: t('不使用') }, ...fastModels]} className="max-w-80" />
          </Field>
        )}
        {editable.has('autoModel') && (
          <Group className="mt-4">
            <ToggleRow label={t('自动选择模型')} description={t('每轮路由判断本轮较简单时，改用快速模型回答；需要快速模型。默认关闭。')}
              checked={draft.autoModel} disabled={!draft.fastModel && !draft.autoModel} onChange={v => set({ autoModel: v })} />
          </Group>
        )}
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} submitLabel={t('保存 JEV 设置')} />
      </SettingsSection>

      <SettingsSection title={t('判断点')} description={t('判断点内置，没有开关；每个判断点只做有界的快速判断，从不授予或放宽权限，结果都会记录并用于校准。')}>
        <Group>
          {describedPoints(config).map(info => {
            const summary = config.calibration?.[info.point]
            return (
              <Row key={info.point}
                label={<span className="inline-flex flex-wrap items-center gap-1.5">{pointTitleOf(info)}
                  {info.stake && <Badge tone={info.stake === 'high' ? 'warning' : info.stake === 'medium' ? 'accent' : 'default'}>{t(STAKE_LABELS[info.stake])}</Badge>}
                  <code className="font-mono text-[11px] font-normal text-fg-4">{info.point}{info.templateVersion ? ` v${info.templateVersion}` : ''}</code></span>}
                description={<>
                  {pointEffectOf(info, internalReasoning)}
                  {info.rides ? <span className="block text-fg-4">{t('随 {point} 同一请求发出', { point: info.rides })}</span> : null}
                  {summary ? <span className="block tabular-nums text-fg-4" data-point-calibration={info.point}>{t('近 7 天 {decisions} 次 · 覆盖 {coverage} · 弃权 {abstain} · 已标注 {labeled} · 省去主模型 {saved} 次', { decisions: summary.decisions, coverage: percent(summary.coverage), abstain: percent(summary.abstainRate), labeled: summary.labeled, saved: summary.savings?.mainModelCalls ?? 0 })}</span> : null}
                </>}>
                <span className="shrink-0 whitespace-nowrap text-[12px] text-fg-3" data-point-builtin="true">{t('内置')}</span>
              </Row>
            )
          })}
        </Group>
        <div className="mt-3 space-y-3">
          <Note>{config.endpoint ? t('TypeSafe 服务地址（环境变量 TYPESAFE_ENDPOINT，只读）：{endpoint}', { endpoint: config.endpoint }) : t('TypeSafe 服务地址只能通过环境变量 TYPESAFE_ENDPOINT 修改，此处不可编辑；密钥不会发往其他主机。')}</Note>
          {config.thresholds && <ThresholdsDisclosure thresholds={config.thresholds} />}
        </div>
      </SettingsSection>
    </form>
  )
}

function SourceLines({ source, revision, template }: { source?: PlanSource; revision?: string; template?: boolean }) {
  return (
    <>
      {template ? <p>{t('问题来自内置判断模板，不需要主模型选项。')}</p> : source?.kind === 'main_model' ? (
        <>
          <p>{t('选项来源：主模型{v} · {v2}', { v: source.modelId ? ` · ${source.modelId}` : '', v2: source.createdAt ? new Date(source.createdAt).toLocaleString(intlTag()) : t('未记录时间') })}</p>
          {source.turnId && <p>{t('生成轮次：{turnId}', { turnId: source.turnId })}</p>}
        </>
      ) : <p>{t('本条未保存主模型选项来源。')}</p>}
      {revision && <p>{t('策略版本：')}<code className="break-all font-mono text-[11px]">{revision.slice(0, 16)}…</code></p>}
    </>
  )
}

function PlansDisclosure({ config }: { config: DecisionKernelConfig }) {
  const plans = config.plans ?? []
  return (
    <Disclosure summary={t('主模型判断选项 · {length} 个项目', { length: plans.length })}>
      <div className="space-y-2">
        {plans.map(plan => (
          <div key={plan.projectId} className="rounded-lg bg-subtle px-3 py-2.5 text-[12px] leading-[1.6] text-fg-3">
            <strong className="block text-[12.5px] text-fg-2">{t('{v} · {v2} 项判断', { v: plan.projectName || t('项目'), v2: plan.questionCount ?? plan.questionKeys?.length ?? 0 })}</strong>
            <SourceLines source={plan.source} revision={plan.revision} />
            {plan.questionKeys?.length ? <p>{t('判断项：{v}', { v: plan.questionKeys.map(questionTitle).join(t('、')) })}</p> : null}
          </div>
        ))}
        {!plans.length && <p className="text-[12px] text-fg-4">{t('尚无主模型判断选项；项目初始化或后续主模型复查可更新这些选项。')}</p>}
      </div>
    </Disclosure>
  )
}

function PerformanceDisclosure({ config }: { config: DecisionKernelConfig }) {
  const groups = config.performance?.groups ?? []
  return (
    <Disclosure summary={t('运行表现 · 耗时与开销')}>
      <p className="mb-2 text-[12px] leading-[1.6] text-fg-4">{t('仅观察评分与主流程并行。以下是近期保留记录，请求耗时不等于用户等待；尚不能用它推算节省或准确率。设置真实 token 限额时，自动跳过仅观察评分，将额度留给实际任务。')}</p>
      {groups.length ? (
        <div className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]">
          <table className="w-full text-[12px] tabular-nums">
            <thead className="bg-subtle text-left text-fg-4">
              <tr><th className="px-3 py-1.5 font-medium">{t('场景')}</th><th className="px-3 py-1.5 font-medium">{t('方式')}</th><th className="px-3 py-1.5 text-right font-medium">{t('实测请求')}</th><th className="px-3 py-1.5 text-right font-medium">p50 / p95</th><th className="px-3 py-1.5 text-right font-medium">tokens</th></tr>
            </thead>
            <tbody className="text-fg-2">
              {groups.map(row => (
                <tr key={row.point} className="border-t border-line-faint">
                  <td className="px-3 py-1.5">{pointLabel(row.point, config.points)}</td>
                  <td className="px-3 py-1.5 text-fg-3">{row.mode === 'shadow' ? t('仅观察') : row.mode === 'active' ? t('采用评分') : t('关闭')}</td>
                  <td className="px-3 py-1.5 text-right">{row.measuredRequests ?? 0}</td>
                  <td className="px-3 py-1.5 text-right">{row.p50Ms ?? '—'} / {row.p95Ms ?? '—'} ms</td>
                  <td className="px-3 py-1.5 text-right">{(row.reportedTokens ?? 0).toLocaleString()}{row.unknownUsageRequests ? <span className="text-fg-4"> {t('· {unknownUsageRequests} 未报告', { unknownUsageRequests: row.unknownUsageRequests })}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[12px] text-fg-4">{t('尚无可展示的运行样本。')}</p>}
    </Disclosure>
  )
}

function HistoryDisclosure({ config }: { config: DecisionKernelConfig }) {
  const recent = (config.recent ?? []).slice(0, 10)
  return (
    <Disclosure summary={t('近期选项评分')}>
      <div className="space-y-2">
        {recent.map((entry, index) => {
          const shown = decisionEntryDisplay(entry)
          return (
            <div key={entry.id ?? index} className="rounded-lg bg-subtle px-3 py-2.5 text-[12px] leading-[1.6] text-fg-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[12.5px] text-fg-2">{pointLabel(entry.point, config.points)}</strong>
                <Badge>{entry.cached ? t('复用已有评分') : shown.source}</Badge>
                {entry.backend && <Badge tone="accent">{entry.backend === 'llm' ? t('快速模型') : 'TypeSafe'}</Badge>}
                <span className="ml-auto text-fg-4">{entry.at ? new Date(entry.at).toLocaleString(intlTag()) : ''}</span>
              </div>
              <p className="mt-1">{shown.reason}{shown.disposition ? ` · ${shown.disposition}` : ''}</p>
              <Disclosure summary={t('查看来源、评分与用量')}>
                <div className="space-y-2">
                  <SourceLines source={entry.planSource} revision={entry.planRevision} template={shown.template} />
                  {(entry.assessmentDisplay ?? []).map((assessment, i) => {
                    const value = decisionAssessmentDisplay(assessment)
                    return (
                      <div key={assessment.key ?? i} className="rounded-md bg-elevated px-2.5 py-2 shadow-[0_0_0_1px_var(--line-faint)]">
                        <strong className="block text-fg-2">{value.title}</strong>
                        <p className="line-clamp-3">{value.label}</p>
                        {value.value && <p className="tabular-nums text-fg-4">{value.value}</p>}
                      </div>
                    )
                  })}
                  {!entry.assessmentDisplay?.length && !shown.template && <p>{t('本条未保存选项评分明细。')}</p>}
                  <p className="text-fg-4">{t('{v}请求耗时 {v2} · 输入 {v3} tokens · 输出 {v4} tokens', { v: entry.execution?.latencyClass === 'parallel' ? t('并行评分，不阻塞主流程 · ') : '', v2: Number.isFinite(entry.latencyMs) ? `${entry.latencyMs} ms` : t('未报告'), v3: entry.usage?.inputTokens ?? t('未报告'), v4: entry.usage?.outputTokens ?? t('未报告') })}</p>
                </div>
              </Disclosure>
            </div>
          )
        })}
        {!recent.length && <p className="text-[12px] text-fg-4">{t('尚无选项评分记录。主模型产生可用判断选项后，才会按已开启的场景调用 JEV。')}</p>}
      </div>
    </Disclosure>
  )
}

function ThresholdsDisclosure({ thresholds }: { thresholds: Record<string, unknown> & { version?: number } }) {
  const tiers = (['floor', 'low', 'medium', 'high'] as const).map(key => [key, thresholds[key]] as const).filter(([, v]) => typeof v === 'number')
  return (
    <Disclosure summary={t('置信门槛（只读 · 版本 {version}）', { version: thresholds.version ?? '—' })}>
      <p className="text-[12px] leading-[1.6] text-fg-3">{t('门槛随代码评审修改，界面中不可编辑。判断置信度 = max(p, 1 − p)；使用快速模型判断时所有门槛再加 {offset}。', { offset: typeof thresholds.llmOffset === 'number' ? thresholds.llmOffset : 0.1 })}</p>
      <dl className="mt-2 grid grid-cols-4 gap-2 text-[12px] tabular-nums">
        {tiers.map(([key, value]) => <div key={key} className="rounded-lg bg-subtle px-2.5 py-1.5"><dt className="text-fg-4">{key}</dt><dd className="text-fg">{String(value)}</dd></div>)}
      </dl>
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-subtle p-2.5 font-mono text-[11px] leading-[1.6] text-fg-3">{JSON.stringify(thresholds.points ?? {}, null, 2)}</pre>
    </Disclosure>
  )
}
