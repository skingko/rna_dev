/**
 * 模型: default model + reasoning (from `reasoningCapability`), provider list,
 * provider editor (presets, auth modes, credentials, subscription login,
 * model catalog draft, test/discovery/refresh/delete). Claude is used with an
 * Anthropic API key: Anthropic allows subscription logins only in Claude Code
 * and Claude.ai. Port of renderModels/renderProviderEditor.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, ExternalLink, KeyRound, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { ModelSpec, ProviderConfig, ProviderPreset, ProviderTestModel } from '@/api/panels-types'
import { capabilityOf, effortLabel } from '@/lib/models'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import {
  Badge, Empty, Field, FieldRow, Group, Note, SaveBar, Select, SettingsSection, TextInput, ToggleRow, formatDateTime, useConfirmStep, useFormState, type NoteTone, type Option,
} from '../form'
import { adoptConfiguration, reloadConfiguration, useConfiguration } from '../config-store'
import {
  applyPreset, catalogModelForDraft, draftOf, formFromProvider, legacyReasoningLabel, modelInputDisplay, modelRow, presetForAuthMode, providerBody, sameModelProvider,
  type CredentialMode, type ModelRowDraft, type ProviderForm,
} from '../model-catalog'
import { SubscriptionAuth } from './SubscriptionAuth'
import { MediaModelsSection } from './MediaModelsSection'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, localized, currentLocale } from '@/i18n'

const SEP = '\u0000'

export default function ModelsSection({ registerBusy, registerDirty }: SectionProps) {
  const config = useConfiguration(s => s.value)!
  // `key` stays the same when a new provider is created, so the editor keeps the result of that save on screen.
  const [editing, setEditing] = useState<{ id: string | null; key: string } | null>(null)
  const provider = editing?.id ? config.providers.find(p => p.id === editing.id) ?? null : null

  if (editing) return <ProviderEditor key={editing.key} provider={provider} presets={config.providerPresets ?? []} onClose={() => setEditing(null)} onSaved={id => setEditing(e => e && { ...e, id })} registerBusy={registerBusy} registerDirty={registerDirty} />

  return (
    <>
      <Note className="mb-6">{config.runtime?.modelExecution === 'rna' ? t('真实提供商通过 Rna SDK 执行；演示模型仅用于界面验证。模型连接测试不会生成内容。') : t('提供商配置与连接测试已接入；聊天和自主判断尚待接入真实 Rna SDK 运行时。')}</Note>
      <DefaultModelSection registerBusy={registerBusy} registerDirty={registerDirty} />
      <InternalReasoningSection registerBusy={registerBusy} registerDirty={registerDirty} />
      <SettingsSection
        title={t('模型提供商')}
        description={t('配置凭据后自动获取模型与可验证参数，保留你的手动设置。')}
        action={<Button size="sm" variant="secondary" leading={<Plus className="size-3.5" />} onClick={() => setEditing({ id: null, key: 'new' })}>{t('添加提供商')}</Button>}
      >
        {config.providers.length ? (
          <Group>
            {config.providers.map(p => <ProviderRow key={p.id} provider={p} onManage={() => setEditing({ id: p.id, key: p.id })} />)}
          </Group>
        ) : <Empty>{t('还没有模型提供商。添加 API 端点后，就可以管理模型目录。')}</Empty>}
      </SettingsSection>
      <MediaModelsSection registerBusy={registerBusy} registerDirty={registerDirty} />
    </>
  )
}

function ProviderRow({ provider, onManage }: { provider: ProviderConfig; onManage: () => void }) {
  const demo = provider.protocol === 'demo'
  const auth = provider.authMode === 'subscription'
    ? provider.subscription?.authenticated ? t('订阅已登录') : t('订阅未登录')
    : provider.apiKeyConfigured ? provider.authMode === 'coding_plan' ? t('套餐 Key 已配置') : t('密钥已配置') : provider.apiKeyEnv ? t('环境变量 {apiKeyEnv}', { apiKeyEnv: provider.apiKeyEnv }) : t('未设置密钥')
  const ok = provider.authMode === 'subscription' ? provider.subscription?.authenticated : provider.apiKeyConfigured || Boolean(provider.apiKeyEnv)
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-[13px] font-semibold text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">{(provider.name || provider.id).slice(0, 1).toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="truncate text-[13.5px] font-medium text-fg">{provider.name || provider.id}</strong>
          {provider.usagePolicy === 'interactive_only' && <Badge tone="warning">{t('仅交互')}</Badge>}
        </div>
        <p className="truncate text-[12px] text-fg-3">
          {demo ? t('内置演示 · 不发送外部请求') : <>{t('{v} 个模型 ·', { v: provider.models?.length ?? 0 })} <span className={ok ? 'text-success' : 'text-warning'}>{auth}</span></>}
        </p>
      </div>
      {demo ? <span className="text-[12px] text-fg-4">{t('内置')}</span> : <Button size="sm" variant="ghost" onClick={onManage}>{t('管理')}</Button>}
    </div>
  )
}

/* ------------------------------------------------------- default model */

function DefaultModelSection({ registerBusy, registerDirty }: Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const config = useConfiguration(s => s.value)!
  const form = useFormState()
  const saved = config.defaultModel
  const [route, setRoute] = useState(saved?.providerId ? `${saved.providerId}${SEP}${saved.modelId}` : '')
  const [reasoning, setReasoning] = useState(saved?.reasoning ?? '')
  useRegistered(registerBusy, 'default-model', form.busy)
  useRegistered(registerDirty, 'default-model', form.dirty)
  useEffect(() => {
    if (form.dirty) return
    setRoute(saved?.providerId ? `${saved.providerId}${SEP}${saved.modelId}` : '')
    setReasoning(saved?.reasoning ?? '')
  }, [saved?.providerId, saved?.modelId, saved?.reasoning]) // eslint-disable-line react-hooks/exhaustive-deps

  const choices: Option[] = config.providers.flatMap(p => (p.models ?? []).map(m => ({ value: `${p.id}${SEP}${m.id}`, label: m.name || m.id, description: p.name, group: p.name })))
  const [providerId, modelId] = route.split(SEP)
  const model = config.providers.find(p => p.id === providerId)?.models.find(m => m.id === modelId)
  const cap = capabilityOf(model as never)
  const reasoningOptions: Option[] = cap.v2
    ? [
      { value: 'auto', label: t('自动'), description: t('每轮根据任务选择档位') },
      { value: 'default', label: t('供应商默认'), description: cap.providerDefault ? t('当前为 {v}', { v: effortLabel(cap, cap.providerDefault) }) : t('省略推理参数') },
      ...cap.efforts.map(e => ({ value: e.id, label: e.label })),
      ...(cap.canDisable ? [{ value: 'off', label: t('关闭思考') }] : []),
    ]
    : [{ value: '', label: t('模型默认') }, ...(model?.reasoning ?? []).map(value => ({ value, label: legacyReasoningLabel(value, model?.compat?.thinkingFormat) }))]
  const showReasoning = cap.v2 ? cap.control !== 'none' || cap.canDisable : Boolean(model?.reasoning?.some(v => v !== 'off'))
  const reasoningValue = reasoningOptions.some(o => o.value === reasoning) ? reasoning : reasoningOptions[0]?.value ?? ''

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!route) return
    void form.submit(() => panelsApi.patchConfiguration({ defaultModel: { providerId, modelId, reasoning: showReasoning ? reasoningValue || null : null } }), async value => { adoptConfiguration(value); await reloadConfiguration() })
  }
  return (
    <SettingsSection title={t('默认模型')} description={t('用于新会话及未单独指定模型的项目后台工作；已有会话保留自己的选择。')}>
      <form onSubmit={onSubmit}>
        <FieldRow>
          <Field label={t('模型')}><Select aria-label={t('默认模型')} value={route} onChange={v => { setRoute(v); form.touch() }} options={choices} placeholder={t('选择模型')} /></Field>
          {showReasoning && <Field label={t('推理等级')} help={cap.v2 ? t('自动：由快速判断或规则为每轮选择档位，失败时回退供应商默认。') : undefined}><Select aria-label={t('推理等级')} value={reasoningValue} onChange={v => { setReasoning(v); form.touch() }} options={reasoningOptions} /></Field>}
        </FieldRow>
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} />
      </form>
    </SettingsSection>
  )
}

/* --------------------------------------------- internal reasoning effort */

/** One select: internal calls follow the provider default / JEV per task (auto), or the chat level (chat). */
function InternalReasoningSection({ registerBusy, registerDirty }: Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const config = useConfiguration(s => s.value)!
  const form = useFormState()
  const saved = config.internalReasoning?.mode ?? 'auto'
  const [mode, setMode] = useState<'auto' | 'chat'>(saved)
  useRegistered(registerBusy, 'internal-reasoning', form.busy)
  useRegistered(registerDirty, 'internal-reasoning', form.dirty)
  useEffect(() => { if (!form.dirty) setMode(saved) }, [saved]) // eslint-disable-line react-hooks/exhaustive-deps
  const options: Option[] = [
    { value: 'auto', label: t('自动（推荐）'), description: t('主动决策、后台工作、子任务等：供应商默认能自行调节时用默认，否则由 JEV 按任务难度选择，不超过对话档位') },
    { value: 'chat', label: t('与对话相同'), description: t('内部调用沿用上面的对话推理等级（以前的做法）') },
  ]
  // The default model's own default is its deepest level (GLM) or unknown: JEV's choice is recorded only until validated.
  const model = config.providers.find(p => p.id === config.defaultModel?.providerId)?.models.find(m => m.id === config.defaultModel?.modelId)
  const cap = capabilityOf(model as never)
  const routes = mode === 'auto' && cap.v2 && cap.control === 'effort' && (!cap.providerDefault || cap.providerDefault === cap.efforts.at(-1)?.id) && cap.efforts.length > 1
  const recordedOnly = routes && config.internalReasoning?.routing !== 'route'
  // Routing sends only the purposes whose paid replay passed (decisions, rewrites); everything else stays recorded only.
  const routedNames = routes && config.internalReasoning?.routing === 'route' ? (config.internalReasoning.purposes ?? ['decision', 'narrator']).map(purpose => purpose === 'decision' ? t('主动决策') : t('消息改写')) : []
  const help = recordedOnly ? t('这个模型的默认档位就是最高档：JEV 的选择目前只记录、仍按原档位发送，验证通过后才生效。')
    : routedNames.length ? t('这个模型的默认档位就是最高档：验证通过的用途（{purposes}）按 JEV 的选择发送；其余内部调用仍只记录、按原档位发送。', { purposes: routedNames.join(currentLocale() === 'en' ? ', ' : '、') }) : undefined
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void form.submit(() => panelsApi.patchConfiguration({ internalReasoning: { mode } }), async value => { adoptConfiguration(value); await reloadConfiguration() }, t('内部调用推理强度已保存'))
  }
  return (
    <SettingsSection title={t('后台与内部调用的推理强度')}>
      <form onSubmit={onSubmit}>
        <Field label={t('推理等级')} help={help}>
          <Select aria-label={t('后台与内部调用的推理强度')} value={mode} onChange={v => { setMode(v as 'auto' | 'chat'); form.touch() }} options={options} />
        </Field>
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} />
      </form>
    </SettingsSection>
  )
}

/* ------------------------------------------------------ provider editor */

const AUTH_OPTIONS: Option<ProviderForm['authMode']>[] = localized([
  { value: 'api_key', label: 'API Key · 按量服务' },
  { value: 'subscription', label: '订阅登录 · OAuth' },
  { value: 'coding_plan', label: 'Coding / Token Plan · 套餐 Key' },
])
const PROTOCOLS: Option[] = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai-codex', label: 'OpenAI Codex Responses' },
]

type ResultNote = { text: string; tone: NoteTone }

function ProviderEditor({ provider, presets, onClose, onSaved, registerBusy, registerDirty }: { provider: ProviderConfig | null; presets: ProviderPreset[]; onClose: () => void; onSaved: (id: string) => void } & Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const editing = Boolean(provider)
  const defaultModel = useConfiguration(s => s.value?.defaultModel)
  const [form, setForm] = useState<ProviderForm>(() => formFromProvider(provider))
  const state = useFormState()
  const [result, setResult] = useState<ResultNote | null>(() => provider?.modelDiscovery ? discoveryNote(provider) : null)
  const [discovered, setDiscovered] = useState<ProviderTestModel[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState<null | 'test' | 'refresh' | 'delete'>(null)
  const removal = useConfirmStep()
  const [deletion, setDeletion] = useState<string | null>(null)
  // Deleting unmounts the editor in the same tick its request ends: the cleanup, not the next render, clears the key.
  useRegistered(registerBusy, 'provider-editor', state.busy || working !== null)
  useRegistered(registerDirty, 'provider-editor', state.dirty)

  const update = (patch: Partial<ProviderForm> | ((f: ProviderForm) => ProviderForm)) => { setForm(f => (typeof patch === 'function' ? patch(f) : { ...f, ...patch })); state.touch() }
  const draft = draftOf(form)
  const subscription = form.authMode === 'subscription'
  // Subscription accounts: ChatGPT signs in here (OAuth); Claude is offered through an Anthropic API key instead.
  const [account, setAccount] = useState<'chatgpt' | 'claude'>('chatgpt')
  const claudeAccount = !editing && subscription && account === 'claude'

  const onPreset = (id: string) => update(f => applyPreset({ ...f, presetId: id }, presets.find(p => p.id === id)))
  const onAuthMode = (mode: ProviderForm['authMode']) => {
    const target = presetForAuthMode(mode, form.presetId)
    if (target) update(f => applyPreset({ ...f, authMode: mode, presetId: target }, presets.find(p => p.id === target)))
    else update({ authMode: mode })
  }

  const busy = state.busy || working !== null
  const savedText = editing ? t('提供商已保存') : t('提供商已创建')
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!e.currentTarget.reportValidity()) return
    const body = providerBody(form)
    void state.submit(
      () => (editing ? panelsApi.updateProvider(provider!.id, body) : panelsApi.createProvider(body)),
      async saved => {
        setForm(f => ({ ...f, apiKey: '' }))
        let note: ResultNote | null = null
        if (form.autoDiscover && (saved.authMode !== 'subscription' || saved.subscription?.authenticated)) {
          setResult({ text: t('提供商已保存，正在自动获取模型…'), tone: 'default' })
          try {
            const discovery = await panelsApi.refreshModels(saved.id)
            note = { text: discovery.message ?? t('模型已同步'), tone: discovery.connectionVerified === false ? 'default' : 'success' }
          } catch (error) { note = { text: t('提供商已保存；模型获取未完成：{message}', { message: (error as Error).message }), tone: 'danger' } }
        }
        const fresh = await reloadConfiguration()
        const current = fresh?.providers.find(p => p.id === saved.id)
        // reset() clears the draft flag; the save's own status stays visible.
        if (current) { setForm(formFromProvider(current)); state.reset(); state.setStatus({ text: savedText, tone: 'saved' }) }
        setResult(note ?? (current?.modelDiscovery ? discoveryNote(current) : null))
        if (!editing) onSaved(saved.id)
      },
      savedText,
    )
  }

  const test = async () => {
    if (state.dirty) { setResult({ text: t('请先保存当前更改，再获取已保存端点的模型。'), tone: 'default' }); return }
    setWorking('test'); setResult({ text: t('正在连接已保存的端点…'), tone: 'default' }); setDiscovered(null)
    try {
      const response = await panelsApi.testProvider(provider!.id)
      setResult({ text: response.message || (response.ok ? t('连接成功') : t('连接失败')), tone: response.connectionVerified === false ? 'default' : response.ok ? 'success' : 'danger' })
      if (response.models?.length) { setDiscovered(response.models); setPicked(new Set()) }
    } catch (error) { setResult({ text: (error as Error).message, tone: 'danger' }) } finally { setWorking(null) }
  }
  const refresh = async () => {
    if (state.dirty) { setResult({ text: t('请先保存当前更改，再刷新模型。'), tone: 'default' }); return }
    setWorking('refresh'); setResult({ text: t('正在读取目录并同步已托管的参数…'), tone: 'default' })
    try {
      const response = await panelsApi.refreshModels(provider!.id)
      await reloadConfiguration()
      setForm(formFromProvider(response.provider)); state.reset()
      setResult({ text: response.message ?? t('模型已同步'), tone: response.connectionVerified === false ? 'default' : 'success' })
    } catch (error) { setResult({ text: (error as Error).message, tone: 'danger' }) } finally { setWorking(null) }
  }
  const remove = async () => {
    if (!removal.armed) { removal.arm(); setDeletion(t('默认模型或会话仍在使用此提供商时，需要先切换模型。现有会话记录会保留。')); return }
    setWorking('delete')
    try { await panelsApi.deleteProvider(provider!.id); await reloadConfiguration(); onClose() } catch (error) { setDeletion((error as Error).message); removal.disarm() } finally { setWorking(null) }
  }
  const addDiscovered = () => {
    const chosen = (discovered ?? []).filter(m => picked.has(m.id))
    if (!chosen.length) return
    update(f => ({ ...f, models: [...f.models, ...chosen.map(m => modelRow(m, draftOf(f)))] }))
    setPicked(new Set())
  }
  const back = () => {
    if (busy) return
    if (state.dirty && !confirm(t('放弃未保存的提供商更改？'))) return
    onClose()
  }
  /** The saved default model cannot leave this provider's catalog (the host refuses the save). */
  const pinned = (id: string) => (editing && defaultModel?.providerId === provider!.id && defaultModel.modelId === id.trim() ? t('这是默认模型，不能直接移除。请先在「默认模型」里换一个模型并保存，再回来移除。') : null)

  return (
    <div>
      <button type="button" onClick={back} disabled={busy} className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-fg-3 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"><ArrowLeft className="size-3.5" />{t('全部提供商')}</button>
      <form onSubmit={onSubmit}>
        <SettingsSection title={editing ? t('管理 {name}', { name: provider!.name }) : t('添加模型提供商')} description={editing ? t('修改后保存；密钥只写入本机凭据文件，读取配置时不会返回。') : t('选择供应商预设可自动填写地址与已核对的模型目录。')}>
          <div className="space-y-4">
            <FieldRow>
              <Field label={editing ? t('应用供应商预设（替换模型目录草稿）') : t('供应商预设')}>
                <Select aria-label={t('供应商预设')} value={form.presetId} onChange={onPreset} options={[{ value: 'custom', label: t('自定义 API') }, ...presets.filter(p => p.id !== 'custom').map(p => ({ value: p.id, label: p.name }))]} />
              </Field>
              <Field label={t('接入方式')}><Select aria-label={t('接入方式')} value={form.authMode} onChange={onAuthMode} options={AUTH_OPTIONS} /></Field>
            </FieldRow>
            {!editing && subscription && (
              <Field label={t('订阅账户')}><Select aria-label={t('订阅账户')} value={account} onChange={v => setAccount(v)} options={[{ value: 'chatgpt', label: t('ChatGPT · Plus / Pro（OAuth 登录）') }, { value: 'claude', label: t('Claude · Pro / Max（第三方应用不可用，改用 API Key）') }]} /></Field>
            )}
            {claudeAccount ? <ClaudeApiKeyNote onUseApiKey={() => { setAccount('chatgpt'); update(f => applyPreset({ ...f, authMode: 'api_key', presetId: 'anthropic' }, presets.find(p => p.id === 'anthropic'))) }} /> : <>
            <Field label={t('显示名称')}><TextInput required value={form.name} placeholder={t('例如：我的模型网关')} onChange={e => update({ name: e.target.value })} /></Field>
            {!subscription && (
              <FieldRow>
                <Field label={t('API 地址')}><TextInput type="url" required value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={e => update({ baseUrl: e.target.value })} /></Field>
                <Field label={t('API 协议')}><Select aria-label={t('API 协议')} value={form.protocol} onChange={v => update({ protocol: v })} options={PROTOCOLS} /></Field>
              </FieldRow>
            )}
            <Note>
              {subscription ? t('ChatGPT 订阅使用官方 OAuth 登录和账户模型目录；Kimi 套餐仅用于交互聊天，后台使用开放平台 API Key。')
                : form.authMode === 'coding_plan' ? t('使用套餐专用 Key 与端点；智谱 Coding Plan 不需要网页登录。套餐授权范围以提供商规则为准。')
                  : t('按量 API 与订阅账户独立；切换接入方式不会借用另一种凭据。')}
            </Note>
            {subscription ? (
              <SubscriptionAuth
                providerId={provider?.authMode === 'subscription' ? provider.id : null}
                canStart={() => !state.dirty && !state.busy}
                onAuthenticated={async () => {
                  if (state.dirty) { setResult({ text: t('订阅已登录；保存当前草稿后可刷新账户模型。'), tone: 'default' }); return }
                  const response = await panelsApi.refreshModels(provider!.id)
                  await reloadConfiguration()
                  setForm(formFromProvider(response.provider)); state.reset()
                  setResult({ text: response.message ?? t('账户模型已同步'), tone: 'success' })
                }}
              />
            ) : (
              <fieldset className="space-y-3 rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]">
                <legend className="px-1 text-[12px] font-medium text-fg-3"><KeyRound className="mr-1 inline size-3.5" />{t('连接凭据')}</legend>
                <FieldRow>
                  <Field label={t('凭据来源')}><Select<CredentialMode> aria-label={t('凭据来源')} value={form.credentialMode} onChange={v => update({ credentialMode: v })} options={[{ value: 'key', label: t('API 密钥') }, { value: 'env', label: t('环境变量') }, { value: 'none', label: t('无需凭据') }]} /></Field>
                  {form.credentialMode === 'key' && (
                    <Field label={form.authMode === 'coding_plan' ? t('套餐专用 Key') : t('API 密钥')} help={t('密钥只写入本机凭据文件，读取配置时不会返回。')}>
                      <TextInput type="password" autoComplete="new-password" value={form.apiKey} placeholder={provider?.apiKeyConfigured ? t('已保存密钥；留空保持不变') : t('输入 API 密钥')} onChange={e => update({ apiKey: e.target.value })} />
                    </Field>
                  )}
                  {form.credentialMode === 'env' && (
                    <Field label={t('环境变量名')} help={t('由启动本地服务的环境提供。')}><TextInput required pattern="[A-Za-z_][A-Za-z0-9_]*" title={t('字母或下划线开头，只含字母、数字和下划线')} value={form.apiKeyEnv} placeholder={t('例如：MY_PROVIDER_API_KEY')} onChange={e => update({ apiKeyEnv: e.target.value })} /></Field>
                  )}
                </FieldRow>
              </fieldset>
            )}
            <Group><ToggleRow label={t('保存后自动获取模型')} description={t('读取供应商目录，自动识别图片等输入能力；保留手动容量与单次输出设置。')} checked={form.autoDiscover} onChange={v => update({ autoDiscover: v })} /></Group>
            </>}
          </div>
        </SettingsSection>

        {!claudeAccount && <>
        <SettingsSection title={t('模型目录')} description={t('容量来自供应商目录或已核对的官方规格。未知参数会明确标出，不会以猜测值加入智能体。单次输出额度由你控制。')}>
          <div className="space-y-3">
            {form.models.map((row, index) => (
              <ModelRowEditor
                key={row.key}
                row={row}
                subscription={subscription}
                provider={provider}
                presets={presets}
                draft={draft}
                removeBlocked={pinned(row.id)}
                onChange={next => update(f => ({ ...f, models: f.models.map((r, i) => (i === index ? next : r)) }))}
                onRemove={() => update(f => ({ ...f, models: f.models.filter((_, i) => i !== index) }))}
              />
            ))}
            {!form.models.length && <Empty>{t('还没有模型。应用预设、获取模型，或手动添加。')}</Empty>}
            <Button size="sm" variant="ghost" leading={<Plus className="size-3.5" />} onClick={() => update(f => ({ ...f, models: [...f.models, modelRow({}, draftOf(f))] }))}>{t('添加模型')}</Button>
          </div>
        </SettingsSection>

        <div className="sticky -bottom-10 z-10 -mx-8 mt-2 border-t border-line-faint bg-elevated px-8 pb-4 pt-0.5 max-md:-mx-5 max-md:px-5">
          <SaveBar status={state.status} busy={state.busy} dirty={editing ? state.dirty : undefined} alwaysEnabled={!editing} submitLabel={editing ? t('保存提供商') : t('创建提供商')} extras={<Button variant="ghost" onClick={back} disabled={state.busy}>{t('取消')}</Button>} />
        </div>
        </>}
      </form>

      {editing && (
        <SettingsSection title={t('连接与模型')} className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={busy} leading={<Wand2 className="size-3.5" />} onClick={() => void test()}>{working === 'test' ? t('正在测试…') : t('测试连接 / 获取模型')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} leading={<RefreshCw className={cn('size-3.5', working === 'refresh' && 'spin')} />} onClick={() => void refresh()}>{t('刷新并同步模型')}</Button>
            <span className="flex-1" />
            <Button size="sm" variant={removal.armed ? 'danger' : 'ghost'} className={removal.armed ? '' : 'text-danger hover:text-danger'} disabled={busy} leading={<Trash2 className="size-3.5" />} onClick={() => void remove()}>{removal.armed ? t('确认删除') : t('删除提供商')}</Button>
          </div>
          {deletion && <p className="mt-2 text-right text-[12px] text-fg-3">{deletion}</p>}
          {result && <Note className="mt-3" tone={result.tone}>{result.text}</Note>}
          {discovered && (
            <div className="mt-3 rounded-xl p-3 shadow-[inset_0_0_0_1px_var(--line)]">
              <p className="mb-2 text-[12.5px] font-medium text-fg-2">{t('端点返回的模型')}</p>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {discovered.map(model => {
                  const exists = form.models.some(r => r.id === model.id)
                  const disabled = exists || model.unavailableReason === 'no-tool-calling'
                  const removed = !disabled && Boolean(provider?.removedModels?.includes(model.id))
                  return (
                    <label key={model.id} className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]', disabled ? 'opacity-55' : 'cursor-pointer hover:bg-hover')}>
                      <input type="checkbox" className="size-3.5 accent-[var(--accent)]" disabled={disabled} checked={picked.has(model.id)} onChange={e => setPicked(p => { const n = new Set(p); if (e.target.checked) n.add(model.id); else n.delete(model.id); return n })} />
                      <span className="min-w-0 flex-1 truncate text-fg">{model.name || model.id}</span>
                      <span className="shrink-0 text-[11.5px] text-fg-4">
                        {exists ? t('已添加') : removed ? t('你已移除 · 勾选并保存可重新添加') : model.readyForAgent ? t('上下文 {v} · 工具能力已核对', { v: Number(model.contextWindow).toLocaleString() }) : model.unavailableReason === 'no-tool-calling' ? t('不支持工具调用') : !model.readyForConfiguration ? t('容量未知 · 需手动核对') : t('工具能力尚未核对')}
                      </span>
                    </label>
                  )
                })}
              </div>
              <Button size="sm" variant="secondary" className="mt-2" disabled={!picked.size} onClick={addDiscovered}>{t('添加所选模型')}</Button>
            </div>
          )}
        </SettingsSection>
      )}
      {!editing && result && <Note className="mt-3" tone={result.tone}>{result.text}</Note>}
    </div>
  )
}

/**
 * Levels from the bundled catalog or the provider's own listing win over the typed list (host reasoning-capability.mjs).
 * So do protocol levels the host fixes, as the saved model's capability shows them: a toggle model is only on/off, and
 * an endpoint whose own levels the host knows (DeepSeek) comes with the provider's default level. There the host still
 * reads `off` from the list (whether thinking can be turned off), so that one choice stays (thinkingSwitch).
 */
export function reasoningSourceNote(spec: ModelSpec) {
  const capability = spec.reasoningCapability, source = capability?.source
  if (source === 'preset') return t('来自已核对的模型规格，自动维护；在这里修改不会生效。')
  if (source === 'discovery') return t('来自供应商的模型列表，刷新模型时自动更新；在这里修改不会生效。')
  if (thinkingSwitch(spec)) return t('档位由这家供应商的接口固定，自动维护；这里只能选是否允许关闭思考。')
  return null
}
/** Protocol-fixed levels: the only part of the typed list the host still reads is `off`. */
export const thinkingSwitch = (spec: ModelSpec) => {
  const capability = spec.reasoningCapability
  return capability?.source === 'protocol' && (capability.control === 'toggle' || Boolean(capability.providerDefault))
}
const levelsOf = (reasoning: string) => reasoning.split(',').map(level => level.trim()).filter(Boolean)
/** The typed list with `off` added or taken out, the fixed levels kept as they are. */
export const withThinkingOff = (reasoning: string, on: boolean) => [...levelsOf(reasoning).filter(level => level !== 'off'), ...(on ? ['off'] : [])].join(', ')

function discoveryNote(provider: ProviderConfig): ResultNote {
  const d = provider.modelDiscovery!
  return { text: t('上次获取 {v} · {v2} 个模型{v3}{v4}', { v: formatDateTime(d.checkedAt), v2: d.discovered ?? 0, v3: d.connectionVerified === false ? t(' · 官方预设，账户授权未验证') : '', v4: d.unknown ? t(' · {unknown} 个需要核对', { unknown: d.unknown }) : '' }), tone: 'default' }
}

function ModelRowEditor({ row, onChange, onRemove, subscription, provider, presets, draft, removeBlocked }: {
  row: ModelRowDraft; onChange: (next: ModelRowDraft) => void; onRemove: () => void; subscription: boolean; provider: ProviderConfig | null; presets: ProviderPreset[]; draft: ReturnType<typeof draftOf>; removeBlocked: string | null
}) {
  const [blockedHint, setBlockedHint] = useState(false)
  // Endpoint changes invalidate facts learned for another route.
  const spec = useMemo(() => (sameModelProvider(row.specProvider, draft) ? row.spec : catalogModelForDraft(draft, row.id.trim(), presets) ?? {}), [row.spec, row.specProvider, draft.baseUrl, draft.protocol, draft.authMode, row.id, presets]) // eslint-disable-line react-hooks/exhaustive-deps
  const input = modelInputDisplay({ provider: draft, modelId: row.id.trim(), presets, savedProvider: provider })
  const known = (spec as { catalogDefaults?: typeof spec }).catalogDefaults ?? spec
  const k = known as { modelMaxOutputTokens?: number | null; contextWindow?: number; maxOutputTokens?: number; source?: { url?: string; checkedAt?: string } }
  const set = (patch: Partial<ModelRowDraft>) => onChange({ ...row, ...patch })
  const onIdCommit = () => {
    const id = row.id.trim()
    const found = catalogModelForDraft(draft, id, presets)
    if (found) onChange({ ...row, spec: { ...structuredClone(found), useCatalogLimits: true }, specProvider: draft, contextWindow: String(found.contextWindow ?? ''), maxOutputTokens: String(found.maxOutputTokens ?? ''), reasoning: (found.reasoning ?? []).join(', ') })
    else if (id !== (row.spec as { id?: string }).id) onChange({ ...row, spec: {}, specProvider: draft, contextWindow: '', maxOutputTokens: '', reasoning: '' })
  }
  const reasoningSource = reasoningSourceNote(spec as ModelSpec)
  const offOnly = thinkingSwitch(spec as ModelSpec), levels = levelsOf(row.reasoning)
  const catalogMismatch = Boolean((spec as { catalogDefaults?: unknown }).catalogDefaults) && (Number(row.contextWindow) !== k.contextWindow || Number(row.maxOutputTokens) > (k.modelMaxOutputTokens ?? Infinity))
  return (
    <div className="rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]">
      <div className="mb-3 flex items-center gap-2">
        <strong className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{row.name || row.id || t('新模型')}</strong>
        <Badge tone={input.status === 'known' ? 'accent' : 'default'}>{input.label}</Badge>
        <Button size="sm" variant="ghost" aria-label={t('移除模型')} onClick={() => (removeBlocked ? setBlockedHint(true) : onRemove())}>{t('移除')}</Button>
      </div>
      {removeBlocked && blockedHint && <Note className="mb-3" tone="warning">{removeBlocked}</Note>}
      <div className="space-y-3">
        <FieldRow>
          <Field label={t('模型 ID')}><TextInput required value={row.id} placeholder="model-id" onChange={e => set({ id: e.target.value })} onBlur={onIdCommit} /></Field>
          <Field label={t('显示名称')}><TextInput value={row.name} placeholder={t('显示名称（选填）')} onChange={e => set({ name: e.target.value })} /></Field>
        </FieldRow>
        <FieldRow>
          <Field label={t('上下文窗口（模型容量）')}><TextInput type="number" required min={1024} step={1} value={row.contextWindow} placeholder={t('供应商文档中的真实上下文长度')} onChange={e => { const s = { ...(row.spec as object) } as Record<string, unknown>; delete s.useCatalogLimits; onChange({ ...row, contextWindow: e.target.value, spec: s as never }) }} /></Field>
          <Field label={subscription ? t('本地输出预留 token') : t('单次最大输出 token')}><TextInput type="number" required min={1} step={1} value={row.maxOutputTokens} placeholder={t('本次请求最多生成多少 token')} onChange={e => set({ maxOutputTokens: e.target.value })} /></Field>
        </FieldRow>
        {reasoningSource ? (
          <Field label={t('支持的推理等级')} help={reasoningSource}>
            <TextInput readOnly value={offOnly ? levels.filter(level => level !== 'off').join(', ') : row.reasoning} />
            {offOnly && (
              <label className="mt-2 flex items-center gap-2 text-[12.5px] text-fg-2">
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={levels.includes('off')} onChange={e => set({ reasoning: withThinkingOff(row.reasoning, e.target.checked) })} />
                {t('允许关闭思考')}
              </label>
            )}
          </Field>
        ) : <Field label={t('支持的推理等级')}><TextInput value={row.reasoning} placeholder={t('例如：off, low, high, max')} onChange={e => set({ reasoning: e.target.value })} /></Field>}
      </div>
      <div className="mt-3 space-y-1 text-[12px] leading-[1.6] text-fg-4">
        <p>
          {t('输入能力 · {label}：{description}', { label: input.label, description: input.description })} <span className="text-fg-4">{t('（')}{input.url ? <a className="text-accent-text hover:underline" href={input.url} target="_blank" rel="noopener noreferrer">{input.sourceLabel}</a> : input.sourceLabel}{t('{v}）', { v: input.checkedAt ? ` · ${input.checkedAt.includes('T') ? formatDateTime(input.checkedAt) : input.checkedAt}` : '' })}</span>
        </p>
        <p>
          {k.modelMaxOutputTokens ? t('模型输出能力上限 {v} tokens。', { v: Number(k.modelMaxOutputTokens).toLocaleString() }) : subscription ? t('订阅目录未声明模型输出能力；此处为本地上下文输出预留，不是服务端硬限制。') : t('模型输出能力尚未核对。')}
          {(spec as { limitsSource?: { contextWindow?: string } }).limitsSource?.contextWindow === 'custom' && t(' 上下文由你手动设置，自动刷新会保留。')}
          {k.source?.url && <> <a className="inline-flex items-center gap-0.5 text-accent-text hover:underline" href={k.source.url} target="_blank" rel="noopener noreferrer">{t('规格来源 · {v}', { v: k.source.checkedAt ?? t('已核对') })}<ExternalLink className="size-3" /></a></>}
        </p>
        {catalogMismatch && (
          <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => onChange({ ...row, contextWindow: String(k.contextWindow), maxOutputTokens: String(Math.min(Number(row.maxOutputTokens) || (k.maxOutputTokens ?? 0), k.modelMaxOutputTokens ?? Infinity)), spec: { ...(row.spec as object), ...(known as object), useCatalogLimits: true } as never })}>
            {t('使用已核对容量')}
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Claude */

/** Anthropic allows Claude Free/Pro/Max logins only in Claude Code and Claude.ai (terms of 2026-02-19); third-party
 * apps, including ones driving the official client, are not permitted. Claude runs here with an API key. */
function ClaudeApiKeyNote({ onUseApiKey }: { onUseApiKey: () => void }) {
  return (
    <div className="space-y-2">
      <Note>{t('Anthropic 只允许在 Claude Code 和 Claude.ai 中使用 Claude 订阅登录，第三方应用（包括驱动官方 Claude Code 的应用）不在允许范围内，使用订阅可能导致账号受限。在 Rna 中使用 Claude，请添加 Anthropic API Key，按用量计费。')}</Note>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" leading={<KeyRound className="size-3.5" />} onClick={onUseApiKey}>{t('改用 Anthropic API Key')}</Button>
        <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">{t('获取 API Key')}<ExternalLink className="size-3" /></a>
      </div>
    </div>
  )
}
