/**
 * Provider/model catalog logic ported from public/background-model-display.js
 * and the provider editor in public/settings-ui.js. Pure functions so the
 * request bodies can be unit-tested against the legacy behavior.
 */
import type { AuthMode, FullConfiguration, ModelSpec, ProjectDetail, ProviderConfig, ProviderPreset } from '@/api/panels-types'
import { t } from '@/i18n'

export interface ProviderDraft { baseUrl: string; protocol: string; authMode: AuthMode; authProvider?: string }

const canonical = (value: unknown) => String(value ?? '').trim().replace(/\/+$/, '').replace(/^https:\/\/api\.deepseek\.com\/v1$/, 'https://api.deepseek.com')

export function sameModelProvider(a?: Partial<ProviderDraft> | null, b?: Partial<ProviderDraft> | null) {
  const endpoint = (value: unknown) => String(value ?? '').trim().replace(/\/+$/, '')
  return !!a && !!b && a.protocol === b.protocol && endpoint(a.baseUrl) === endpoint(b.baseUrl) && (a.authMode ?? 'api_key') === (b.authMode ?? 'api_key') && a.authProvider === b.authProvider
}

export function catalogModelForDraft(provider: ProviderDraft, id: string, presets: ProviderPreset[] = []): ModelSpec | undefined {
  let preset = presets.find(row => row.id !== 'custom' && row.protocol === provider.protocol && canonical(row.baseUrl) === canonical(provider.baseUrl))
  if (!preset && provider.protocol === 'openai') {
    try {
      const url = new URL(provider.baseUrl)
      if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/+$/, '') === '/compatible-mode/v1' && !url.hostname.startsWith('token-plan.')) {
        const region = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.exec(url.hostname)?.[1]
        if (region) preset = presets.find(row => row.id === (region === 'cn-beijing' ? 'qwen-cn' : 'qwen-intl'))
      }
    } catch { /* A partially typed URL has no catalog identity. */ }
  }
  return preset?.models?.find(row => row.id === id)
}

export function safeCapabilitySource(value?: string | null) {
  if (!value) return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}

export interface InputDisplay { status: 'known' | 'unknown'; source: string; label: string; description: string; sourceLabel: string; checkedAt?: string; url: string | null }

export function modelInputDisplay({ provider, modelId, presets = [], savedProvider }: { provider: ProviderDraft; modelId: string; presets?: ProviderPreset[]; savedProvider?: ProviderConfig | null }): InputDisplay {
  const known = catalogModelForDraft(provider, modelId, presets)
  const saved = savedProvider && sameModelProvider(provider, savedProvider as Partial<ProviderDraft>) ? savedProvider.models?.find(row => row.id === modelId) : undefined
  // An upstream-observed probe outranks the bundled catalog (same order as the host).
  const capability = saved?.inputCapability?.source === 'probe' ? saved.inputCapability : known?.input ? { status: 'known', source: 'catalog', input: known.input, url: known.source?.url, checkedAt: known.source?.checkedAt } : saved?.inputCapability
  const input = capability?.status === 'known' && ['catalog', 'provider', 'probe'].includes(capability.source) && Array.isArray(capability.input) ? capability.input : null
  if (!input?.includes('text')) {
    const configured = capability?.source === 'configured'
    return { status: 'unknown', source: configured ? 'configured' : 'unknown', label: t('输入能力尚未识别'), description: configured ? t('尚未自动识别，保留已有配置。供应商目录确认后自动更新。') : t('自动获取模型时会读取输入能力；目录未声明时保持未知。'), sourceLabel: t('尚无可核实的能力来源'), url: null }
  }
  const source = capability!.source
  const cap = capability as { url?: string; sourceUrl?: string; checkedAt?: string }
  return {
    status: 'known', source, label: input.includes('image') ? t('文字与图片') : t('仅文字'), description: source === 'probe' ? t('根据模型对测试图片的实际响应自动识别，无需手动设置。') : t('根据模型目录自动识别，无需手动设置。'),
    sourceLabel: source === 'probe' ? t('上游响应实测') : source === 'catalog' ? t('已核对的模型规格') : t('供应商模型目录'),
    checkedAt: cap.checkedAt,
    url: safeCapabilitySource(cap.url ?? cap.sourceUrl ?? (source === 'provider' ? saved?.discoverySource?.url : saved?.catalogDefaults?.source?.url)),
  }
}

export function backgroundModelRestriction(project: ProjectDetail | undefined, configuration: Pick<FullConfiguration, 'providers' | 'defaultModel'> | null | undefined) {
  if (!project || (project.simulated !== false && project.decisionMode !== 'rna-model')) return null
  const selection = project.initiative?.modelSelection ?? configuration?.defaultModel
  const provider = configuration?.providers?.find(value => value.id === selection?.providerId)
  if (provider?.usagePolicy !== 'interactive_only') return null
  const model = provider.models?.find(value => value.id === selection?.modelId)
  return {
    code: 'interactive_only', title: t('后台等待可用模型'),
    route: `${provider.name || provider.id} / ${model?.name || selection?.modelId}`,
    source: project.initiative?.modelSelection ? t('项目后台模型') : t('应用默认模型'),
    message: t('当前套餐仅用于前台交互；主动协作和自进化需要开放平台 API 模型。'),
  }
}

/* ---------------------------------------------------------- editor model */

export interface ModelRowDraft {
  key: string
  id: string
  name: string
  contextWindow: string
  maxOutputTokens: string
  reasoning: string
  /** The spec this row was seeded from (catalog/discovery/saved). */
  spec: ModelSpec | Record<string, never>
  specProvider: ProviderDraft
}

let rowSeq = 0
export function modelRow(model: Partial<ModelSpec>, provider: ProviderDraft): ModelRowDraft {
  return {
    key: `m${++rowSeq}`,
    id: model.id ?? '',
    name: model.name ?? '',
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
    reasoning: (model.reasoning ?? []).join(', '),
    spec: structuredClone(model) as ModelSpec,
    specProvider: provider,
  }
}

/** Serialize one row exactly as the legacy editor did. */
export function serializeModel(row: ModelRowDraft, provider: ProviderDraft) {
  const id = row.id.trim(), name = row.name.trim(), reasoning = row.reasoning.trim()
  const spec = (id === (row.spec as ModelSpec).id && sameModelProvider(row.specProvider, provider) ? row.spec : {}) as ModelSpec
  const { compat, cacheRetention, modelMaxOutputTokens, source, useCatalogLimits } = spec
  return {
    ...(useCatalogLimits ? { useCatalogLimits: true } : {}),
    ...(compat ? { compat } : {}),
    ...(cacheRetention ? { cacheRetention } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    ...(source ? { source } : {}),
    id,
    name: name || id,
    contextWindow: Number(row.contextWindow.trim()),
    maxOutputTokens: Number(row.maxOutputTokens.trim()),
    ...(reasoning ? { reasoning: reasoning.split(',').map(value => value.trim()).filter(Boolean) } : {}),
  }
}

export type CredentialMode = 'key' | 'env' | 'none'

export interface ProviderForm {
  presetId: string
  authMode: AuthMode
  name: string
  baseUrl: string
  protocol: string
  credentialMode: CredentialMode
  apiKey: string
  apiKeyEnv: string
  autoDiscover: boolean
  models: ModelRowDraft[]
}

export function draftOf(form: Pick<ProviderForm, 'baseUrl' | 'protocol' | 'authMode'>): ProviderDraft {
  return { baseUrl: form.baseUrl.trim(), protocol: form.protocol, authMode: form.authMode, ...(form.authMode === 'subscription' ? { authProvider: 'openai-codex' } : {}) }
}

/** POST /api/providers or PATCH /api/providers/:id body (legacy settings-ui.js). */
export function providerBody(form: ProviderForm) {
  const draft = draftOf(form)
  const body: Record<string, unknown> = {
    authMode: form.authMode,
    ...(form.authMode === 'subscription' ? { authProvider: 'openai-codex' } : {}),
    autoDiscoverModels: form.autoDiscover,
    ...(form.presetId !== 'custom' ? { presetId: form.presetId } : {}),
    name: form.name.trim(),
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    models: form.models.map(row => serializeModel(row, draft)),
  }
  if (form.authMode === 'subscription') body.apiKeyEnv = ''
  // Env mode with no variable name leaves the credential as it is: only 无需凭据 clears a saved key.
  else if (form.credentialMode === 'env') { if (form.apiKeyEnv.trim()) { body.apiKeyEnv = form.apiKeyEnv.trim(); body.apiKey = '' } }
  else if (form.credentialMode === 'none') { body.apiKeyEnv = ''; body.apiKey = '' }
  else { body.apiKeyEnv = ''; if (form.apiKey) body.apiKey = form.apiKey }
  return body
}

export function formFromProvider(provider: ProviderConfig | null): ProviderForm {
  const base: ProviderForm = {
    presetId: provider?.presetId ?? 'custom',
    authMode: provider?.authMode ?? 'api_key',
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? '',
    protocol: provider?.protocol ?? 'openai',
    credentialMode: provider?.apiKeyEnv ? 'env' : 'key',
    apiKey: '',
    apiKeyEnv: provider?.apiKeyEnv ?? '',
    autoDiscover: provider?.autoDiscoverModels !== false,
    models: [],
  }
  const draft = draftOf(base)
  base.models = (provider?.models ?? []).map(model => modelRow(model, draft))
  return base
}

/** Apply a preset to the draft (replaces the model catalog draft). */
export function applyPreset(form: ProviderForm, preset: ProviderPreset | undefined): ProviderForm {
  if (!preset || preset.id === 'custom') return { ...form, presetId: preset?.id ?? form.presetId }
  const next: ProviderForm = { ...form, presetId: preset.id, name: preset.name, baseUrl: preset.baseUrl, protocol: preset.protocol, apiKeyEnv: preset.apiKeyEnv ?? '', authMode: preset.authMode ?? 'api_key' }
  const draft = draftOf(next)
  next.models = (preset.models ?? []).map(model => modelRow({ ...model, useCatalogLimits: true }, draft))
  return next
}

/** The legacy auth-mode switch also moves between paired presets. */
export function presetForAuthMode(authMode: AuthMode, currentPreset: string): string | null {
  return authMode === 'subscription' ? 'openai-codex' : authMode === 'coding_plan' ? 'glm-coding' : currentPreset === 'openai-codex' ? 'openai' : currentPreset === 'glm-coding' ? 'glm' : null
}

/** Reasoning labels for the legacy `reasoning: string[]` list. */
export function legacyReasoningLabel(value: string, thinkingFormat?: unknown) {
  if (value === 'high' && ['qwen', 'toggle'].includes(String(thinkingFormat))) return t('开启')
  return ({ off: t('关闭'), low: t('低'), medium: t('中'), high: t('高'), max: t('最高'), xhigh: t('更高'), minimal: t('最少') } as Record<string, string>)[value] ?? value
}
