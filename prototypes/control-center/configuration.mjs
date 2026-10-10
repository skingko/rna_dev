import { providerPresets, providerPreset, catalogModel, matchedProviderPreset } from './provider-presets.mjs';
import { internalReasoningSetting, internalReasoningInput } from './internal-reasoning.mjs';
import { schedulePromptVersionOf, schedulePromptVersionInput } from './schedule-prompt.mjs';
import { normalizeDiscoveredModel, resolveInputCapability, discoveredInputCapability, retainedInputEvidence, retainedProbeEvidence, bindInputEvidence, inputBinding } from './provider-discovery.mjs';
import { SDK_VERSION } from '../../packages/sdk/src/version.mjs';
import { MEDIA_KINDS, IMAGE_EDIT_APIS, VIDEO_APIS, SUBSCRIPTION_MEDIA } from '../../packages/sdk/src/media-models.mjs';
import { codexClientVersion } from '../../packages/sdk/src/codex-client.mjs';
import { COMPACTION_TRIGGER, COMPACTION_BLOCKING_TRIGGER } from '../../packages/sdk/src/session.mjs';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SubscriptionAuthService, CODEX_ENDPOINT, subscriptionAuthCatalog } from './subscription-auth-service.mjs';
import { resolveReasoningCapability, validateReasoningSelection, wireReasoning, validReasoningDiscovery, discoveredReasoning, legacyReasoning, REASONING_SELECTION_VERSION } from './reasoning-capability.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { MEMORY_BACKENDS } from './embedded-memory.mjs';
import { WEB_PROVIDERS, WEB_PROVIDER_IDS } from '../../packages/sdk/src/web-providers.mjs';

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const clone = value => structuredClone(value);
const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须为对象`); return value; };
const text = (value, label, max = 1000, empty = false) => { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(`${label} 必须为有效文本（最多 ${max} 字符）`); return value.trim(); };
const number = (value, label, min, max) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${label} 必须为 ${min}–${max} 的整数`); return value; };
export function endpoint(value) {
  const raw = text(value, '服务地址', 2000); let url;
  try { url = new URL(raw); } catch { fail('请输入完整的 http:// 或 https:// 服务地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('服务地址只允许 HTTP(S)，不能包含凭据、查询或片段');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('远程服务必须使用 HTTPS；HTTP 仅用于本机服务');
  return url.toString().replace(/\/+$/, '');
}
export function providerUsagePolicy(provider) {
  try { const url = new URL(provider?.baseUrl); if (url.protocol === 'https:' && ['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && /^\/coding(?:\/|$)/.test(url.pathname)) return 'interactive_only'; } catch {}
  return 'unrestricted';
}
// The built-in demo provider cannot be edited: it reads with the current product name (older states saved 'Pi · 演示').
const DEMO_NAMES = { provider: { zh: 'Rna · 演示', en: 'Rna · Demo' }, model: { zh: '演示模型', en: 'Demo model' } };
export function initialConfiguration() {
  return {
    providers: [{ id: 'demo', name: 'Rna · 演示', protocol: 'demo', baseUrl: '', apiKeyEnv: '', models: [{ id: 'demo', name: '演示模型', contextWindow: 128000, maxOutputTokens: 8192, reasoning: ['off'] }], createdAt: new Date().toISOString() }],
    defaultModel: { providerId: 'demo', modelId: 'demo', reasoning: 'auto' }, reasoningSelectionVersion: REASONING_SELECTION_VERSION,
    memory: { backend: 'openviking', endpoint: 'http://127.0.0.1:1933', apiKeyEnv: '', autoRecall: true, autoStore: true, contextBudget: 2048, limit: 20 },
    webTools: { enabled: false, provider: 'fastcrw', baseUrl: 'https://api.fastcrw.com', timeoutMs: 30000, apiKeyEnv: '' }
  };
}
// Old defaultLevel selected an index tier globally. It is deliberately retired:
// retrieval discovers candidates across tiers; individual reads choose depth.
function normalizedMemory(value) {
  const memory = { ...initialConfiguration().memory, ...value };
  delete memory.defaultLevel;
  return memory;
}
function normalizedWebTools(value) {
  const defaults = initialConfiguration().webTools;
  // Credentials and public status fields never enter persisted configuration.
  return Object.fromEntries(Object.keys(defaults).map(key => [key, value?.[key] ?? defaults[key]]));
}
const MEDIA_FIELDS = { image: ['editApi'], speech: ['voice'], transcription: [], video: ['api'], vision: [] };
const MEDIA_CHOICES = [...MEDIA_KINDS, 'vision'];
/** Media model choices reference a configured provider by id; its base URL and credential are used at call time. */
function normalizedMedia(value) {
  const media = {};
  for (const kind of MEDIA_CHOICES) { const row = value?.[kind]; if (row?.providerId && row.modelId) media[kind] = Object.fromEntries(['providerId', 'modelId', ...MEDIA_FIELDS[kind]].filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
  return media;
}
function mediaInput(value, providers) {
  object(value, '多模态模型'); const media = {};
  for (const [kind, row] of Object.entries(value)) {
    if (!MEDIA_CHOICES.includes(kind)) fail('未知的多模态模型类型');
    if (row === null) continue;
    object(row, '多模态模型');
    if (Object.keys(row).some(key => !['providerId', 'modelId', ...MEDIA_FIELDS[kind]].includes(key))) fail('多模态模型包含不支持的配置项');
    const provider = providers.find(item => item.id === row.providerId);
    if (!provider || provider.protocol === 'demo') fail('多模态模型需要选择已配置的提供商');
    if (kind === 'vision') {
      // Image understanding runs through the chat protocol, so any configured model that can read images qualifies.
      const model = provider.models.find(item => item.id === row.modelId) ?? fail('图片理解模型需要从该提供商的模型目录中选择');
      const capability = resolveInputCapability(provider, model);
      if (capability.status !== 'known' || !capability.input?.includes('image')) fail('所选模型尚未确认支持图片输入');
      media.vision = { providerId: provider.id, modelId: model.id }; continue;
    }
    if (provider.authMode === 'subscription') {
      // A ChatGPT login serves the kinds the Codex clients use it for (image generation, speech recognition); nothing else.
      const models = provider.protocol === 'openai-codex' ? SUBSCRIPTION_MEDIA[kind] : undefined;
      if (!models) fail(kind === 'speech' || kind === 'video' ? 'ChatGPT 订阅没有可用的语音合成或视频生成接口，请选择 API Key 接入' : '订阅登录的提供商不能用于这类多模态模型，请选择 API Key 接入');
      if (!models.includes(row.modelId)) fail(`ChatGPT 订阅的${kind === 'image' ? '图片' : '语音识别'}模型只能选择 ${models.join('、')}`);
      media[kind] = { providerId: provider.id, modelId: row.modelId }; continue;
    }
    const entry = { providerId: provider.id, modelId: text(row.modelId, '模型 ID', 200) };
    if (kind === 'image' && row.editApi !== undefined) { if (!IMAGE_EDIT_APIS.includes(row.editApi)) fail('图片编辑接口无效'); entry.editApi = row.editApi; }
    if (kind === 'video') { if (!VIDEO_APIS.includes(row.api)) fail('请选择视频接口'); entry.api = row.api; }
    if (kind === 'speech' && row.voice !== undefined && row.voice !== '') entry.voice = text(row.voice, '默认音色', 200);
    media[kind] = entry;
  }
  return media;
}
function modelCompat(value) {
  if (value === undefined) return undefined;
  object(value, '模型兼容配置'); const result = {};
  const booleans = ['supportsUsageInStreaming', 'supportsPromptCacheKey', 'supportsLongCacheRetention', 'adaptiveThinking', 'supportsJsonObject', 'supportsToolChoiceNone', 'toolStream', 'preserveThinking', 'requiresReasoningContent', 'compactionFork'];
  for (const [key, item] of Object.entries(value)) {
    if (booleans.includes(key)) { if (typeof item !== 'boolean') fail('模型兼容开关必须为布尔值'); result[key] = item; }
    else if (key === 'thinkingFormat' && ['openai', 'qwen', 'toggle', 'zai'].includes(item)) result[key] = item;
    else if (key === 'thinkingDisplay' && ['summarized', 'omitted'].includes(item)) result[key] = item;
    else if (key === 'reasoningEffortMap') { object(item, '推理档位映射'); if (Object.entries(item).some(([from, to]) => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(from) || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', ...(from === 'off' ? ['none'] : [])].includes(to))) fail('推理档位映射无效'); result[key] = clone(item); }
    else if (key === 'maxTokensField' && ['max_tokens', 'max_completion_tokens'].includes(item)) result[key] = item;
    else fail('未知或无效的模型兼容配置');
  }
  return result;
}
function modelInputs(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.includes('text') || value.some(item => !['text', 'image'].includes(item)) || new Set(value).size !== value.length) fail('模型输入能力必须为 text 或 text,image');
  return [...value];
}
function models(value, provider, previous = [], discovered = new Map()) {
  if (!Array.isArray(value) || value.length > 100) fail('供应商模型目录必须为数组，最多 100 个模型');
  const result = value.map(row => {
    object(row, '模型');
    const catalog = catalogModel(provider, row.id), existing = previous.find(model => model.id === row.id);
    // Newly added catalogs cannot hydrate extra execution fields into a legacy
    // row during an unrelated edit, especially a capacity-only correction.
    const known = catalog?.legacyProjection === false && existing && !existing.catalogVersion ? undefined : catalog;
    const supplied = row; row = { ...known, ...existing, ...row }; if (supplied.useCatalogLimits === true && catalog) row.contextWindow = catalog.contextWindow;
    if (row.contextWindow === undefined || row.maxOutputTokens === undefined) fail('未知模型必须明确填写上下文容量和单次输出上限；可先选择已核对的模型预设');
    const reasoning = row.reasoning ?? ['off'];
    if (!Array.isArray(reasoning) || !reasoning.length || reasoning.some(x => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(x)) || new Set(reasoning).size !== reasoning.length) fail('推理档位必须为不重复的 off/minimal/low/medium/high/xhigh/max');
    const contextWindow = number(row.contextWindow, '上下文窗口', 1024, 10000000);
    const compat = modelCompat(row.compat);
    const reasoningDiscovery = validReasoningDiscovery(row.reasoningDiscovery);
    // Provenance is host-owned. Ignore submitted inputCapability/discoveredInput
    // fields; only a current discovery receipt or retained bound receipt counts.
    const candidate = discovered.get(row.id);
    const discoveredInput = candidate && retainedInputEvidence(provider, { id: row.id, discoveredInput: candidate }) || retainedInputEvidence(provider, existing);
    const probedInput = retainedProbeEvidence(provider, existing);
    const input = probedInput?.input ?? known?.input ?? discoveredInput?.input ?? modelInputs(row.input);
    // Discovery and custom forms may submit a model capability independently
    // of the requested output. Only the bundled official catalog is verified;
    // submitted values are validated and retained as custom metadata.
    const submittedModelMax = supplied.modelMaxOutputTokens === undefined ? undefined : supplied.modelMaxOutputTokens === null ? null : number(supplied.modelMaxOutputTokens, '模型输出能力', 1, 10000000);
    const modelMaxOutputTokens = (existing?.limitsSource?.modelMaxOutputTokens === 'provider-catalog' ? existing.modelMaxOutputTokens : known?.modelMaxOutputTokens) ?? (submittedModelMax === undefined ? existing?.modelMaxOutputTokens ?? null : submittedModelMax);
    const modelMaxSource = modelMaxOutputTokens === null ? 'unknown' : known?.modelMaxOutputTokens != null ? 'catalog' : 'custom';
    if (modelMaxOutputTokens !== null && row.maxOutputTokens > modelMaxOutputTokens) fail('单次输出上限超过已配置的模型输出能力');
    if (row.cacheRetention !== undefined && !['none', 'short', 'long'].includes(row.cacheRetention)) fail('缓存保留策略必须为 none/short/long');
    return { ...(known?.legacyProjection === false ? { catalogVersion: known.source.checkedAt } : existing?.catalogVersion ? { catalogVersion: existing.catalogVersion } : {}), ...(input ? { input } : {}), ...(reasoningDiscovery ? { reasoningDiscovery } : {}), ...(discoveredInput ? { discoveredInput: clone(discoveredInput) } : {}), ...(probedInput ? { probedInput: clone(probedInput) } : {}), ...(compat ? { compat } : {}), ...(row.cacheRetention ? { cacheRetention: row.cacheRetention } : {}), id: text(row.id, '模型 ID', 200), name: text(row.name ?? row.id, '模型名称', 160), contextWindow, modelMaxOutputTokens, maxOutputTokens: number(row.maxOutputTokens, '输出上限', 1, contextWindow), reasoning, limitsSource: { modelMaxOutputTokens: modelMaxSource, contextWindow: supplied.useCatalogLimits === true && catalog ? 'catalog' : existing && (supplied.contextWindow === undefined || supplied.contextWindow === existing.contextWindow) ? existing.limitsSource?.contextWindow ?? 'custom' : supplied.contextWindow === undefined && known ? 'catalog' : 'custom', maxOutputTokens: existing && (supplied.maxOutputTokens === undefined || supplied.maxOutputTokens === existing.maxOutputTokens) ? existing.limitsSource?.maxOutputTokens ?? 'custom' : supplied.maxOutputTokens === undefined && known ? 'catalog-default' : 'custom' } };
  });
  if (new Set(result.map(x => x.id)).size !== result.length) fail('同一供应商不能有重复模型 ID');
  return result;
}
function keyInput(input) {
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\0]/u.test(input.apiKey)) fail('API Key 格式不正确');
  }
  if (input.apiKeyEnv !== undefined && (typeof input.apiKeyEnv !== 'string' || !/^(?:[A-Za-z_][A-Za-z0-9_]{0,159})?$/.test(input.apiKeyEnv))) fail('凭据环境变量名格式不正确');
}
/** How many removed model ids a provider remembers (a listing is read up to 500 rows). */
const REMOVED_MODELS_LIMIT = 500;
function capacityOnlyProviderChange(previous, next, input) {
  if (!previous || input.apiKey !== undefined || input.apiKeyEnv !== undefined && input.apiKeyEnv !== previous.apiKeyEnv) return false;
  if (previous.models.length !== next.models.length || !previous.models.some((model, index) => model.contextWindow !== next.models[index]?.contextWindow)) return false;
  const withoutCapacity = value => {
    const result = clone(value); delete result.updatedAt; delete result.evidenceRevision;
    result.models = result.models.map(model => { const copy = { ...model }; delete copy.contextWindow; return copy; });
    return result;
  };
  return isDeepStrictEqual(withoutCapacity(previous), withoutCapacity(next));
}
/** A context projection re-expressed against `model`'s limits (the SDK's own formula); the conversation's size is kept. */
export function contextUsageFor(usage, model) {
  const capacity = Math.max(0, model.contextWindow), outputReserve = Number.isFinite(model.maxOutputTokens) ? Math.max(0, model.maxOutputTokens) : 0;
  return { ...usage, capacity, outputReserve, inputTrigger: Math.max(0, Math.floor(capacity * COMPACTION_TRIGGER) - outputReserve), ...(usage?.blockingTrigger !== undefined ? { blockingTrigger: Math.max(0, Math.floor(capacity * COMPACTION_BLOCKING_TRIGGER) - outputReserve) } : {}) };
}
export function resolveModel(configuration, value) {
  const selection = value == null ? configuration.defaultModel : object(value, '模型选择');
  const provider = configuration.providers.find(p => p.id === selection.providerId) ?? fail('供应商不存在', 404);
  const model = provider.models.find(m => m.id === selection.modelId) ?? fail('模型不在供应商允许列表中', 404);
  // Resolution no longer materializes the first listed level: missing means
  // auto; auto is fixed per turn by host routing, else the provider default.
  const reasoningCapability = resolveReasoningCapability(provider, model), reasoningSelection = validateReasoningSelection(reasoningCapability, selection.reasoning);
  // Only future resolutions use current capability evidence. Historical turn
  // snapshots are never rewritten by catalog upgrades or listing refreshes.
  const input = resolveInputCapability(provider, model).input;
  return { ...(input ? { input } : {}), providerId: provider.id, providerName: provider.name, ...(providerUsagePolicy(provider) === 'interactive_only' ? { usagePolicy: 'interactive_only' } : {}), protocol: provider.protocol, baseUrl: provider.baseUrl, ...(provider.authMode === 'subscription' ? { subscriptionProvider: provider.authProvider } : {}), modelId: model.id, name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, reasoning: wireReasoning(reasoningSelection), reasoningSelection, reasoningCapability, ...(model.compat ? { compat: clone(model.compat) } : {}), ...(model.cacheRetention ? { cacheRetention: model.cacheRetention } : {}), execution: provider.protocol === 'demo' ? 'simulation' : 'rna' };
}
export const modelSelection = snapshot => ({ providerId: snapshot.providerId, modelId: snapshot.modelId, reasoning: snapshot.reasoningSelection ?? snapshot.reasoning });
export async function requestJSON(url, { method = 'GET', headers = {}, body, timeoutMs = 5000, signal, captureErrorCode = false } = {}) {
  let response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetch(url, { method, headers: { Accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) fail('服务返回重定向；请填写最终服务地址，凭据不会被转发', 502);
    if (!response.ok) {
      const error = new Error(`服务请求失败（HTTP ${response.status}）；请检查地址和凭据`); error.status = 502; error.upstreamStatus = response.status;
      // Opt-in metadata for ownership-checked reconciliation only. Never retain
      // an upstream message/body; a bare HTTP 404 is not a resource NOT_FOUND.
      if (captureErrorCode && response.body) {
        const reader = response.body.getReader(); let length = 0; const chunks = [];
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8192) { await reader.cancel(); break; } chunks.push(value); }
          if (length <= 8192) { const code = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code; if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) error.upstreamCode = code; }
        } catch { /* Incomplete/error bodies carry no trustworthy error code. */ }
      } else await response.body?.cancel();
      throw error;
    }
    const reader = response.body.getReader(); let length = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 2 * 1024 * 1024) { await reader.cancel(); fail('服务响应超过 2 MB 上限', 502); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('服务未返回有效 JSON', 502); }
  } catch (error) {
    if (error.status) throw error;
    fail(error.name === 'TimeoutError' || error.name === 'AbortError' ? '连接超时，请检查服务是否可用' : '连接失败，请检查服务地址、网络与凭据', 502);
  }
}
export class ConfigurationService {
  constructor(store, options = {}) {
    this.store = store; this.secretFile = `${store.file}.secrets`; this.catalogRequest = options.requestJSON ?? requestJSON; this.inputDiscoveries = new Map();
    // The Codex version for the account catalog; a live server swaps in the current release (no network otherwise).
    this.codexVersion = options.codexVersion ?? (async () => codexClientVersion());
    store.state.configuration.memory = normalizedMemory(store.state.configuration.memory);
    store.state.configuration.webTools = normalizedWebTools(store.state.configuration.webTools);
    const demo = store.state.configuration.providers?.find(row => row.id === 'demo' && row.protocol === 'demo');
    if (demo) demo.name = DEMO_NAMES.provider.zh;
    try { this.secrets = JSON.parse(readFileSync(this.secretFile, 'utf8')); chmodSync(this.secretFile, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('独立凭据文件无法读取，已停止；请检查文件格式与权限'); this.secrets = {}; }
    if (!this.secrets || typeof this.secrets !== 'object' || Array.isArray(this.secrets) || Object.values(this.secrets).some(x => typeof x !== 'string')) throw new Error('独立凭据文件结构不受支持');
    this.subscriptionAuth = new SubscriptionAuthService(this, options.subscriptionAuth);
  }
  secret(id, config) { return config.authMode === 'subscription' ? this.subscriptionAuth.resolver(id) : config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? '') : (this.secrets[id] ?? ''); }
  credentialRevision(id) { const p = this.store.state.configuration.providers.find(row => row.id === id); return p?.authMode === 'subscription' ? this.subscriptionAuth.revision(id) : null; }
  secretValues() { return [...Object.values(this.secrets), ...this.subscriptionAuth.secretValues()]; }
  assertInputDiscoveryCurrent(provider, credentialIdentity) {
    const current = this.store.state.configuration.providers.find(row => row.id === provider.id);
    if (!current || !isDeepStrictEqual(current, provider) || credentialIdentity !== (current.authMode === 'subscription' ? this.credentialRevision(current.id) : this.secret(current.id, current))) fail('获取目录期间提供商配置或凭据已变化，请重新刷新', 409);
  }
  rememberInputDiscovery(provider, rows, credentialIdentity) {
    // A rejected stale listing must not leave a reusable receipt in this cache:
    // ordinary provider saves also consult it after the original request ends.
    this.assertInputDiscoveryCurrent(provider, credentialIdentity);
    const evidence = new Map();
    for (const row of rows) { const receipt = bindInputEvidence(provider, row); if (receipt) evidence.set(row.id, receipt); }
    this.inputDiscoveries.set(provider.id, evidence);
  }
  public() {
    const config = clone(this.store.state.configuration);
    config.memory = normalizedMemory(config.memory);
    config.webTools = normalizedWebTools(config.webTools);
    config.media = normalizedMedia(config.media);
    // Internal calls' reasoning effort (spec p1 effort §3.8): auto | chat, and whether the JEV route is sent or only recorded.
    config.internalReasoning = internalReasoningSetting(config);
    // Which texts tell a model what a schedule's task is (schedule-prompt.mjs): v1 today's, v2 the W2 texts. Report only.
    config.schedulePromptVersion = schedulePromptVersionOf(config);
    config.providerPresets = providerPresets();
    config.providerAuthMethods = subscriptionAuthCatalog();
    // The web search services to choose from: whether each needs a key, and whether it reads pages itself.
    config.webToolProviders = WEB_PROVIDER_IDS.map(id => ({ ...WEB_PROVIDERS[id] }));
    config.providers = config.providers.map(p => { const status = p.authMode === 'subscription' ? this.subscriptionAuth.status(p.id) : null; return { ...p, ...(providerUsagePolicy(p) === 'interactive_only' ? { usagePolicy: 'interactive_only' } : {}), authMode: p.authMode ?? (p.presetId === 'glm-coding' || p.presetId === 'mimo-token-plan-cn' ? 'coding_plan' : 'api_key'), ...(status ? { subscription: { authenticated: status.authenticated, state: status.state, expiresAt: status.expiresAt } } : {}), ...(status && p.protocol === 'openai-codex' ? { subscriptionMedia: SUBSCRIPTION_MEDIA } : {}), models: p.models.map(model => {
      const inputCapability = resolveInputCapability(p, model), reasoningCapability = resolveReasoningCapability(p, model), projected = { ...model, inputCapability, reasoningCapability, reasoning: legacyReasoning(reasoningCapability), modelMaxOutputTokens: model.modelMaxOutputTokens ?? catalogModel(p, model.id)?.modelMaxOutputTokens ?? null, catalogDefaults: catalogModel(p, model.id) ?? null };
      delete projected.discoveredInput; delete projected.probedInput; delete projected.reasoningDiscovery; if (inputCapability.input) projected.input = inputCapability.input; else delete projected.input; return projected;
    }), apiKeyConfigured: !status && Boolean(this.secret(p.id, p)), credentialSource: status ? 'subscription' : p.apiKeyEnv ? 'environment' : this.secrets[p.id] ? 'local-file' : 'none' }; });
    const language = interfaceLanguageOf(this.store.state);
    for (const p of config.providers) if (p.id === 'demo' && p.protocol === 'demo') { p.name = inLanguage(language, DEMO_NAMES.provider); for (const model of p.models) if (model.id === 'demo') model.name = inLanguage(language, DEMO_NAMES.model); }
    config.memory.apiKeyConfigured = Boolean(this.secret('openviking', config.memory));
    config.memory.credentialSource = config.memory.apiKeyEnv ? 'environment' : this.secrets.openviking ? 'local-file' : 'none';
    config.webTools.apiKeyConfigured = Boolean(this.secret('webTools', config.webTools));
    config.webTools.credentialSource = config.webTools.apiKeyEnv ? 'environment' : this.secrets.webTools ? 'local-file' : 'none';
    config.runtime = { modelExecution: 'rna', sdkVersion: SDK_VERSION, memoryExecution: config.memory.backend === 'embedded' ? 'embedded' : 'openviking', memoryBackends: [...MEMORY_BACKENDS], capabilityManagement: 'project-assigned-dynamic', availableBuiltinTools: ['project_read', 'project_list', 'project_write', 'project_edit', 'project_exec', 'openviking_search', 'openviking_read', 'web_search', 'web_fetch', 'image_generate', 'speech_generate', 'audio_transcribe', 'video_generate'], mediaApis: { imageEdit: [...IMAGE_EDIT_APIS], video: [...VIDEO_APIS] }, credentials: 'separate-file-0600-or-environment' };
    return config;
  }
  writeSecret(id, input) {
    if (input.apiKey === undefined) return;
    const next = { ...this.secrets }; if (input.apiKey) next[id] = input.apiKey; else delete next[id];
    const temporary = `${this.secretFile}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, this.secretFile); this.secrets = next;
  }
  update(input) {
    const next = clone(this.store.state.configuration);
    next.memory = normalizedMemory(next.memory);
    next.webTools = normalizedWebTools(next.webTools);
    if (input.defaultModel !== undefined) next.defaultModel = modelSelection(resolveModel(next, input.defaultModel));
    if (input.memory !== undefined) {
      const values = object(input.memory, 'memory'); keyInput(values);
      if (values.backend !== undefined) { if (!MEMORY_BACKENDS.includes(values.backend)) fail('记忆后端只能是 openviking 或 embedded；更早版本的本地记录只保留为归档，不参与检索'); next.memory.backend = values.backend; }
      if (values.endpoint !== undefined) next.memory.endpoint = endpoint(values.endpoint);
      if (values.apiKeyEnv !== undefined) next.memory.apiKeyEnv = values.apiKeyEnv;
      // Accept valid legacy clients, but never persist or apply their fixed tier.
      if (values.defaultLevel !== undefined && !['L0', 'L1', 'L2'].includes(values.defaultLevel)) fail('记忆层级必须为 L0/L1/L2');
      if (values.autoRecall !== undefined) { if (typeof values.autoRecall !== 'boolean') fail('自动引用记忆必须为布尔值'); next.memory.autoRecall = values.autoRecall; }
      if (values.autoStore !== undefined) { if (typeof values.autoStore !== 'boolean') fail('自动保存记忆必须为布尔值'); next.memory.autoStore = values.autoStore; }
      if (values.contextBudget !== undefined) next.memory.contextBudget = number(values.contextBudget, '记忆上下文预算', 256, 16000);
      if (values.limit !== undefined) next.memory.limit = number(values.limit, '记忆检索上限', 1, 100);
    }
    if (input.media !== undefined) next.media = mediaInput(input.media, next.providers);
    if (input.internalReasoning !== undefined) next.internalReasoning = internalReasoningInput(input.internalReasoning, next.internalReasoning);
    if (input.schedulePromptVersion !== undefined) next.schedulePromptVersion = schedulePromptVersionInput(input.schedulePromptVersion);
    let webKey = input.webTools ?? {};
    if (input.webTools !== undefined) {
      const values = object(input.webTools, '联网工具'); keyInput(values);
      if (Object.keys(values).some(key => !['enabled', 'provider', 'baseUrl', 'timeoutMs', 'apiKeyEnv', 'apiKey'].includes(key))) fail('联网工具包含不支持的配置项');
      if (values.provider !== undefined) {
        if (!WEB_PROVIDER_IDS.includes(values.provider)) fail('联网服务必须是受支持的搜索服务');
        if (values.provider !== next.webTools.provider) {
          // One service's address and key are not another's: the address becomes the new service's own unless one comes
          // with the change, and a saved key or variable name is dropped unless a new one does, so it is never sent elsewhere.
          next.webTools.provider = values.provider;
          if (values.baseUrl === undefined) next.webTools.baseUrl = WEB_PROVIDERS[values.provider].baseUrl;
          if (values.apiKeyEnv === undefined) next.webTools.apiKeyEnv = '';
          if (values.apiKey === undefined) webKey = { apiKey: '' };
        }
      }
      if (values.enabled !== undefined) { if (typeof values.enabled !== 'boolean') fail('联网工具开关必须为布尔值'); next.webTools.enabled = values.enabled; }
      if (values.baseUrl !== undefined) next.webTools.baseUrl = endpoint(values.baseUrl);
      if (values.timeoutMs !== undefined) next.webTools.timeoutMs = number(values.timeoutMs, '联网请求超时', 1000, 120000);
      if (values.apiKeyEnv !== undefined) next.webTools.apiKeyEnv = values.apiKeyEnv;
    }
    this.writeSecret('openviking', input.memory ?? {});
    this.writeSecret('webTools', webKey);
    this.store.mutate(state => { state.configuration = next; });
    return this.public();
  }
  /** Persist an upstream image-input observation for exactly the endpoint that answered. */
  recordProbedInput(binding, observation) {
    let changed = false;
    this.store.mutate(state => {
      const provider = state.configuration.providers.find(row => row.id === binding.providerId), model = provider?.models.find(row => row.id === binding.modelId);
      if (!model || !isDeepStrictEqual(inputBinding(provider, model.id), binding)) return;
      model.probedInput = { binding: clone(binding), input: [...observation.input], evidence: observation.evidence, checkedAt: new Date().toISOString() };
      model.input = [...observation.input]; changed = true;
    });
    return changed;
  }
  provider(id, input, remove = false) {
    const config = clone(this.store.state.configuration), existing = config.providers.find(p => p.id === id);
    const previous = existing ? clone(existing) : undefined;
    if (id === 'demo') fail('演示供应商为内置配置，不能修改或删除', 409);
    if (id && !existing) fail('供应商不存在', 404);
    const say = variants => inLanguage(interfaceLanguageOf(this.store.state), variants);
    const modelName = selection => previous?.models.find(row => row.id === selection.modelId)?.name || selection.modelId;
    if (remove) {
      // Name what still holds the provider; archived sessions count too (they keep their model), so they are marked.
      if (config.defaultModel.providerId === id) fail(say({ zh: `默认模型「${modelName(config.defaultModel)}」来自这个提供商。请先在「默认模型」里换成其他提供商的模型，再删除。`, en: `The default model “${modelName(config.defaultModel)}” comes from this provider. Choose a default model from another provider first, then delete it.` }), 409);
      const held = this.store.state.sessions.filter(row => row.modelSelection?.providerId === id);
      if (held.length) fail(say({ zh: `还有会话在用这个提供商的模型：${this.sessionList(held, 'zh')}。请先在这些会话里换一个模型（已归档的会话需先恢复），再删除。`, en: `Sessions still use this provider's models: ${this.sessionList(held, 'en')}. Switch their model first (restore archived ones to do so), then delete it.` }), 409);
      config.providers = config.providers.filter(p => p.id !== id);
      if (config.media) config.media = Object.fromEntries(Object.entries(config.media).filter(([, row]) => row?.providerId !== id));
      this.store.mutate(state => { state.configuration = config; }); this.writeSecret(id, { apiKey: '' }); this.subscriptionAuth.forget(id); return { deleted: true, id };
    }
    if (input.presetId !== undefined) {
      const preset = providerPreset(input.presetId); if (!preset) fail('供应商预设不存在');
      if (input.applyPresetModels !== undefined && typeof input.applyPresetModels !== 'boolean') fail('applyPresetModels 必须为布尔值');
      const defaults = existing ? { presetId: preset.id, ...(input.applyPresetModels ? { models: preset.models.map(m => ({ ...m, useCatalogLimits: true })) } : {}) } : { name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, apiKeyEnv: input.apiKey ? '' : preset.apiKeyEnv, models: preset.models.map(m => ({ id: m.id })), presetId: preset.id, ...(preset.authMode ? { authMode: preset.authMode, ...(preset.authProvider ? { authProvider: preset.authProvider } : {}) } : {}) };
      input = { ...defaults, ...input };
    }
    keyInput(input); const provider = existing ?? { id: randomUUID(), name: '', protocol: 'openai', baseUrl: '', apiKeyEnv: '', models: [], createdAt: new Date().toISOString() };
    if (input.autoDiscoverModels !== undefined) { if (typeof input.autoDiscoverModels !== 'boolean') fail('自动获取模型必须为布尔值'); provider.autoDiscoverModels = input.autoDiscoverModels; } else if (!existing) provider.autoDiscoverModels = true;
    if (input.presetId !== undefined) provider.presetId = input.presetId;
    if (input.name !== undefined || !existing) provider.name = text(input.name, '供应商名称', 160);
    if (input.protocol !== undefined) { if (!['openai', 'anthropic', 'openai-codex'].includes(input.protocol)) fail('协议必须为 openai、anthropic 或 openai-codex'); provider.protocol = input.protocol; }
    if (input.baseUrl !== undefined || !existing) provider.baseUrl = endpoint(input.baseUrl);
    if (input.authMode !== undefined) { if (!['api_key', 'subscription', 'coding_plan'].includes(input.authMode)) fail('接入方式无效'); if (!(existing && provider.authMode === undefined && input.authMode === 'api_key')) provider.authMode = input.authMode; }
    if (input.authProvider !== undefined) { if (input.authProvider !== 'openai-codex') fail('此订阅尚未开放第三方后台接入；请使用 API Key'); provider.authProvider = input.authProvider; }
    if (provider.authMode === 'subscription') {
      if (provider.authProvider !== 'openai-codex' || provider.protocol !== 'openai-codex' || provider.baseUrl !== CODEX_ENDPOINT) fail('ChatGPT 订阅只能使用官方 Codex 协议与固定地址');
      if (input.apiKey || input.apiKeyEnv) fail('订阅登录不使用 API Key 或凭据环境变量');
      provider.apiKeyEnv = '';
    } else {
      if (provider.protocol === 'openai-codex') fail('Codex 协议需要使用订阅登录');
      delete provider.authProvider;
      if (provider.authMode === 'coding_plan' && !['glm-coding', 'mimo-token-plan-cn', 'kimi-coding'].includes(matchedProviderPreset(provider)?.id)) fail('Coding Plan 需要选择受支持的专用端点预设');
    }
    if (input.apiKeyEnv !== undefined) provider.apiKeyEnv = input.apiKeyEnv;
    const routeChanged = previous && !isDeepStrictEqual(inputBinding(previous, ''), inputBinding(provider, ''));
    const credentialsChanged = previous && (input.apiKey !== undefined || input.apiKeyEnv !== undefined && input.apiKeyEnv !== previous.apiKeyEnv);
    if (routeChanged || credentialsChanged) this.inputDiscoveries.delete(provider.id);
    const retained = (previous?.models ?? []).map(model => {
      const row = clone(model);
      if (routeChanged || credentialsChanged && row.discoveredInput) { delete row.input; delete row.discoveredInput; }
      if (routeChanged) delete row.reasoningDiscovery;
      return row;
    });
    if (input.models !== undefined || !existing || routeChanged || credentialsChanged) {
      const requested = input.models ?? (existing ? retained : []);
      provider.models = models(routeChanged ? requested.map(row => { const clean = { ...row }; delete clean.input; return clean; }) : requested, provider, retained, this.inputDiscoveries.get(provider.id));
    }
    // A model the user takes out of the catalog stays out: refreshModels adds what the provider lists, except these.
    // Saving it again (typed, or picked from the listing) puts it back. Another endpoint's ids mean nothing here.
    if (routeChanged) delete provider.removedModels;
    else if (previous && input.models !== undefined) {
      const kept = new Set(provider.models.map(row => row.id));
      const removed = [...new Set([...(previous.removedModels ?? []), ...previous.models.map(row => row.id)])].filter(id => !kept.has(id)).slice(-REMOVED_MODELS_LIMIT);
      if (removed.length) provider.removedModels = removed; else delete provider.removedModels;
    }
    // A capacity correction refreshes execution policy but does not revoke
    // already delivered evidence. Every other update, including explicit key
    // input, rotates this identity; never infer equivalence from public flags.
    provider.evidenceRevision = capacityOnlyProviderChange(previous, provider, input)
      ? previous.evidenceRevision ?? previous.updatedAt ?? randomUUID() : randomUUID();
    provider.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt) || 0) + 1)).toISOString();
    if (!existing) config.providers.push(provider);
    // A model this save drops from the catalog may still be the default model or a session's model: say which.
    const dropped = selection => selection?.providerId === provider.id && !provider.models.some(row => row.id === selection.modelId);
    if (dropped(config.defaultModel)) fail(say({ zh: `「${modelName(config.defaultModel)}」是默认模型，移除后它就不在供应商允许列表中了。请先在「默认模型」里换一个模型并保存，再移除它。`, en: `“${modelName(config.defaultModel)}” is the default model and can't be removed from the catalog. Choose another default model and save first, then remove it.` }), 409);
    const holding = this.store.state.sessions.filter(row => dropped(row.modelSelection));
    if (holding.length) {
      const names = [...new Set(holding.map(row => modelName(row.modelSelection)))].join(say({ zh: '、', en: ', ' }));
      fail(say({ zh: `「${names}」仍被会话使用：${this.sessionList(holding, 'zh')}，移除后它就不在供应商允许列表中了。请先在这些会话里换一个模型（已归档的会话需先恢复），再移除它。`, en: `“${names}” is still used by sessions: ${this.sessionList(holding, 'en')}. Switch their model first (restore archived ones to do so), then remove it.` }), 409);
    }
    resolveModel(config, config.defaultModel);
    for (const session of this.store.state.sessions) if (session.modelSelection?.providerId === provider.id) resolveModel(config, session.modelSelection);
    this.writeSecret(provider.id, input); this.store.mutate(state => {
      state.configuration = config;
      for (const session of state.sessions) if (!session.activeTurnId && session.modelSelection?.providerId === provider.id) {
        const resolved = resolveModel(config, session.modelSelection);
        session.modelConfig = resolved; session.model = `${resolved.providerName} · ${resolved.name}`; session.context.capacity = resolved.contextWindow;
        // Same model with new limits: the last projection is re-expressed against them (no new estimate mark).
        if (session.context.usage && Number.isFinite(resolved.contextWindow)) session.context.usage = contextUsageFor(session.context.usage, resolved);
      }
    });
    if (previous?.authMode === 'subscription' && provider.authMode !== 'subscription') this.subscriptionAuth.forget(provider.id);
    return this.public().providers.find(p => p.id === provider.id);
  }
  /** At most three session titles, archived ones marked, for an "in use" error the user can act on. */
  sessionList(sessions, language) {
    const archived = session => session.archivedAt || this.store.state.projects.find(row => row.id === session.projectId)?.archivedAt;
    const names = sessions.slice(0, 3).map(session => inLanguage(language, { zh: `《${session.title || '未命名会话'}》${archived(session) ? '（已归档）' : ''}`, en: `“${session.title || 'Untitled session'}”${archived(session) ? ' (archived)' : ''}` }));
    const more = sessions.length - names.length;
    return names.join(inLanguage(language, { zh: '、', en: ', ' })) + (more > 0 ? inLanguage(language, { zh: ` 等 ${sessions.length} 个会话`, en: ` and ${more} more` }) : '');
  }
  async subscriptionModels(provider) {
    const credentialIdentity = this.credentialRevision(provider.id);
    const credential = await this.subscriptionAuth.resolve(provider.id), checkedAt = new Date().toISOString();
    // Official Codex ModelsClient takes this client-version query; the account
    // response, not the API catalog, determines effective context capacity.
    // The catalog lists only models whose minimal_client_version the request's client_version meets, so it is the current Codex release.
    const sourceUrl = `${CODEX_ENDPOINT}/codex/models?client_version=${await this.codexVersion()}`;
    const response = await this.catalogRequest(sourceUrl, { headers: { Authorization: `Bearer ${credential.accessToken}`, 'ChatGPT-Account-Id': credential.accountId, originator: 'rna-agent' } });
    if (!Array.isArray(response.models)) fail('订阅模型目录响应缺少 models 数组', 502);
    const reasoningLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const discovered = response.models.slice(0, 500).filter(row => typeof row.slug === 'string' && row.slug && row.slug.length <= 200 && row.visibility !== 'hide').map(row => {
      const contextWindow = Number.isSafeInteger(row.context_window) && row.context_window >= 1024 && row.context_window <= 10000000 ? row.context_window : undefined;
      const output = Number.isSafeInteger(row.max_output_tokens) && row.max_output_tokens > 0 && row.max_output_tokens <= 10000000 ? row.max_output_tokens : null;
      const reasoning = (row.supported_reasoning_levels ?? []).map(level => level.effort).filter(level => reasoningLevels.has(level));
      if (reasoning.includes(row.default_reasoning_level)) reasoning.unshift(...reasoning.splice(reasoning.indexOf(row.default_reasoning_level), 1));
      const ready = Boolean(contextWindow && reasoning.length);
      const inputCapability = discoveredInputCapability(provider, { ...row, id: row.slug }, { sourceUrl, checkedAt }), reasoningFound = discoveredReasoning(row);
      return { id: row.slug, name: String(row.display_name ?? row.slug).slice(0, 160), ...(contextWindow ? { contextWindow } : {}), modelMaxOutputTokens: output,
        maxOutputTokens: Math.min(8192, contextWindow ?? 8192, output ?? Infinity), reasoning: [...new Set(reasoning)], ...(reasoningFound ? { reasoningDiscovery: { ...reasoningFound, checkedAt } } : {}), ...(inputCapability.input ? { input: inputCapability.input } : {}), inputCapability,
        limitsSource: { contextWindow: contextWindow ? 'provider-catalog' : 'unknown', modelMaxOutputTokens: output ? 'provider-catalog' : 'unknown' }, discoverySource: { url: sourceUrl, checkedAt },
        toolCall: true, readyForConfiguration: ready, readyForAgent: ready, unavailableReason: ready ? null : 'missing-capacity-or-reasoning',
        outputLimitNote: output ? null : '订阅目录未声明模型输出能力；8192 是本地上下文输出预留，不是供应商已验证的模型上限或服务端硬限制。' };
    });
    this.rememberInputDiscovery(provider, discovered, credentialIdentity);
    return { ok: true, connectionVerified: true, catalogSource: 'subscription-account', models: discovered, checkedAt, truncated: response.models.length > 500, simulated: false, message: `已读取账户模型目录，共 ${discovered.length} 项。上下文使用账户实际返回值；未提供的输出能力仍保持未知。没有调用生成接口。` };
  }
  async test(id) {
    const provider = clone(this.store.state.configuration.providers.find(p => p.id === id) ?? fail('供应商不存在', 404));
    if (provider.protocol === 'demo') return { ok: true, models: provider.models.map(m => ({ id: m.id, name: m.name })), checkedAt: new Date().toISOString(), message: '内置演示模型，无外部连接或模型调用', simulated: true };
    if (provider.authMode === 'subscription') return this.subscriptionModels(provider);
    const secret = this.secret(id, provider), checkedAt = new Date().toISOString();
    const headers = provider.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(secret ? { 'x-api-key': secret } : {}) } : secret ? { Authorization: `Bearer ${secret}` } : {};
    const apiRoot = provider.protocol === 'anthropic' && !provider.baseUrl.endsWith('/v1') ? `${provider.baseUrl}/v1` : provider.baseUrl;
    const sourceUrl = `${apiRoot}/models`, rows = [], seen = new Set(); let cursor, truncated = false;
    try {
      for (let page = 0; page < 5; page++) {
        const url = new URL(sourceUrl); if (cursor) url.searchParams.set('after_id', cursor);
        const response = await requestJSON(url.href, { headers });
        if (!Array.isArray(response.data)) fail('服务返回格式不兼容：/models 必须包含 data 数组', 502);
        for (const item of response.data) {
          const row = normalizeDiscoveredModel(provider, item, { checkedAt, sourceUrl });
          if (row && !seen.has(row.id)) { rows.push(row); seen.add(row.id); }
          if (rows.length === 500) { truncated = true; break; }
        }
        if (rows.length === 500 || !response.has_more) break;
        const next = response.last_id ?? response.data.at(-1)?.id;
        if (provider.protocol !== 'anthropic' || typeof next !== 'string' || !next || next === cursor || next.length > 200) { truncated = true; break; }
        cursor = next; if (page === 4) truncated = true;
      }
    } catch (error) {
      const preset = matchedProviderPreset(provider);
      // A missing listing route is not a bad generation endpoint. Do not claim
      // a successful credential check and never hide 401/403/network failures.
      if (![404, 405].includes(error.upstreamStatus) || !preset?.models.length) throw error;
      this.assertInputDiscoveryCurrent(provider, secret);
      return { ok: true, connectionVerified: false, catalogSource: 'official-presets', models: preset.models.map(m => normalizeDiscoveredModel(provider, { id: m.id }, { checkedAt, sourceUrl })), checkedAt, simulated: false, message: '此端点未提供模型目录；已读取有来源的官方预设，凭据与账户模型授权尚未验证。' };
    }
    this.rememberInputDiscovery(provider, rows, secret);
    return { ok: true, connectionVerified: true, catalogSource: 'provider', models: rows, checkedAt, truncated, message: `已获取 ${rows.length} 个模型；${rows.filter(m => m.readyForAgent).length} 个具有完整容量与工具能力。未调用生成接口。${truncated ? '目录过大或未完成分页，现有模型不会删除。' : ''}`, simulated: false };
  }
  async refreshModels(id) {
    const before = clone(this.store.state.configuration.providers.find(p => p.id === id) ?? fail('供应商不存在', 404));
    if (before.protocol === 'demo') fail('演示模型没有远程目录', 409);
    const secret = before.authMode === 'subscription' ? this.credentialRevision(id) : this.secret(id, before), discovery = await this.test(id);
    const current = this.store.state.configuration.providers.find(p => p.id === id);
    if (!current || !isDeepStrictEqual(current, before) || secret !== (current.authMode === 'subscription' ? this.credentialRevision(id) : this.secret(id, current))) fail('获取目录期间提供商配置已变化，请重新刷新', 409);
    const next = clone(before), added = [], updated = [], preserved = [], skipped = [], declined = [];
    for (const found of discovery.models) {
      const existing = next.models.find(m => m.id === found.id);
      if (!existing) {
        // The user removed this model from the catalog; the listing still has it and does not bring it back.
        if (before.removedModels?.includes(found.id)) { declined.push(found.id); continue; }
        if (!found.readyForAgent || next.models.length >= 100) { skipped.push({ id: found.id, reason: found.unavailableReason ?? 'model-limit' }); continue; }
        const [saved] = models([found], next, [], this.inputDiscoveries.get(id)); saved.modelMaxOutputTokens = found.modelMaxOutputTokens;
        saved.limitsSource.contextWindow = found.limitsSource.contextWindow;
        saved.limitsSource.modelMaxOutputTokens = found.limitsSource.modelMaxOutputTokens;
        saved.limitsSource.maxOutputTokens = 'catalog-default';
        next.models.push(saved); added.push(found.id); continue;
      }
      const fields = [], old = clone(existing);
      const inputEvidence = bindInputEvidence(next, found);
      if (inputEvidence) {
        if (!inputEvidence.input && existing.discoveredInput?.input) delete existing.input;
        existing.discoveredInput = inputEvidence;
        if (inputEvidence.input) existing.input = [...inputEvidence.input];
      }
      // Declared reasoning levels are capability evidence, not a pinned choice.
      const reasoningEvidence = validReasoningDiscovery(found.reasoningDiscovery);
      if (reasoningEvidence) existing.reasoningDiscovery = reasoningEvidence;
      if (found.contextWindow && found.contextWindow !== existing.contextWindow) {
        if (['catalog', 'provider-catalog', 'verified-preset'].includes(existing.limitsSource?.contextWindow) && found.contextWindow >= existing.maxOutputTokens) { existing.contextWindow = found.contextWindow; existing.limitsSource.contextWindow = found.limitsSource.contextWindow; }
        else fields.push('contextWindow');
      }
      if (found.modelMaxOutputTokens && found.modelMaxOutputTokens !== existing.modelMaxOutputTokens) {
        if (existing.limitsSource?.modelMaxOutputTokens === 'custom' || existing.maxOutputTokens > found.modelMaxOutputTokens) fields.push('modelMaxOutputTokens');
        else { existing.modelMaxOutputTokens = found.modelMaxOutputTokens; existing.limitsSource = { ...existing.limitsSource, modelMaxOutputTokens: found.limitsSource.modelMaxOutputTokens }; }
      }
      // Reasoning/compatibility and request output are execution choices. A
      // directory refresh must not rewrite pinned choices or permission scope.
      if (fields.length) preserved.push({ id: found.id, fields });
      if (!isDeepStrictEqual(existing, old)) updated.push(found.id);
    }
    const capacityChanged = before.models.some(old => old.contextWindow !== next.models.find(m => m.id === old.id)?.contextWindow);
    if (capacityChanged) {
      next.evidenceRevision = before.evidenceRevision ?? before.updatedAt ?? randomUUID();
      next.updatedAt = new Date(Math.max(Date.now(), (Date.parse(before.updatedAt) || 0) + 1)).toISOString();
    }
    next.modelDiscovery = { checkedAt: discovery.checkedAt, connectionVerified: discovery.connectionVerified, catalogSource: discovery.catalogSource, discovered: discovery.models.length, added: added.length, updated: updated.length, unknown: skipped.length, truncated: discovery.truncated === true };
    this.store.mutate(state => {
      const index = state.configuration.providers.findIndex(p => p.id === id); state.configuration.providers[index] = next;
      if (capacityChanged) for (const session of state.sessions) if (!session.activeTurnId && session.modelSelection?.providerId === id) {
        const resolved = resolveModel(state.configuration, session.modelSelection); session.modelConfig = resolved; session.model = `${resolved.providerName} · ${resolved.name}`; session.context.capacity = resolved.contextWindow;
      }
    });
    return { ...discovery, added, updated, preserved, skipped, declined, provider: this.public().providers.find(p => p.id === id), message: `${discovery.message} 已添加 ${added.length} 个、更新 ${updated.length} 个；保留 ${preserved.length} 个手动或执行设置，${skipped.length} 个待核对。${declined.length ? `你移除的 ${declined.length} 个模型没有加回；需要时可在「测试连接 / 获取模型」里勾选后重新添加。` : ''}` };
  }
}
