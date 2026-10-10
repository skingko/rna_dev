// Curated wire-compatible subset, not a claim that every Pi provider is supported.
// Model capacity is kept separate from the configurable request output allowance.
// Sources/decisions: docs/research/model-catalog.md. No keys or network side effects.
const checkedAt = '2026-09-24';
const imageModels = new Set(['deepseek-flash', 'gpt-5.4', 'gpt-4.1-mini', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gemini-2.5-flash', 'openai/gpt-4.1-mini']);
// Reasoning capability per model (host contract v2 §4), from each cited source.
// Efforts are ordered weakest to strongest; legacy `reasoning` = effort ids + off.
export const EFFORT_LABELS = Object.freeze({ minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最大' });
// defaultAdaptive: the provider's own default effort is adaptive and usable as-is (Claude adaptive thinking decides
// the depth per request), so `default` needs no per-purpose choice.
const cap = (control, ids, { canDisable = false, providerDefault = null, visibility = 'full', labels = {}, defaultAdaptive = false } = {}) => ({ control, efforts: ids.map(id => ({ id, label: labels[id] ?? EFFORT_LABELS[id] })), canDisable, providerDefault, visibility, ...(defaultAdaptive ? { defaultAdaptive: true } : {}), source: 'preset' });
export const legacyReasoning = capability => [...capability.efforts.map(effort => effort.id), ...(capability.canDisable ? ['off'] : [])];
const withReasoning = capability => ({ reasoning: legacyReasoning(capability), reasoningCapability: capability });
const model = (id, name, contextWindow, modelMaxOutputTokens, capability, url, extra = {}) => ({ id, name, contextWindow, modelMaxOutputTokens, maxOutputTokens: Math.min(8192, modelMaxOutputTokens), ...withReasoning(capability), input: imageModels.has(id) ? ['text', 'image'] : ['text'], source: { url, checkedAt }, ...extra });
const toggle = cap('toggle', ['high'], { canDisable: true, labels: { high: '开启思考' } });
const alwaysThinks = ids => cap('effort', ids);
const openaiSource = 'https://developers.openai.com/api/docs/models/';
const anthropicSource = 'https://platform.claude.com/docs/en/models/overview';
const deepseekSource = 'https://api-docs.deepseek.com/quick_start/pricing/';
const expandedCheckedAt = '2026-09-26';
const glmSource = 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3';
const glmFlashSource = 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash';
const kimiSource = 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart';
const mimoSource = 'https://mimo.mi.com/static/docs/quick-start/summary/model.md';
const modern = (id, name, context, output, reasoning, url, compat, input = ['text']) => model(id, name, context, output, reasoning, url, { input, maxOutputTokens: 32768, toolCall: true, legacyProjection: false, compat: { supportsPromptCacheKey: false, ...compat }, source: { url, checkedAt: expandedCheckedAt } });
const deepseekReasoning = cap('effort', ['high', 'max'], { canDisable: true, providerDefault: 'high' });
const noReasoning = cap('none', [], { canDisable: true, visibility: 'hidden' });
const qwenModels = ['max', 'flash'].map(tier => modern(`qwen3.8-${tier}`, `Qwen3.8 ${tier === 'max' ? 'Max' : 'Flash'}`, 1000000, 131072, toggle, `https://help.aliyun.com/zh/model-studio/qwen3-8-${tier}`, { maxTokensField: 'max_completion_tokens', thinkingFormat: 'qwen', ...(tier === 'max' ? { preserveThinking: true } : {}) }, ['text', 'image']));
// compactionFork (TC-6): GLM-5.3 only — the paid probe of 2026-10-05 measured that model (docs/research/glm-compaction-fork-probe-20261005.md); Flash and FlashX were not.
const glmModels = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].map(id => modern(id, id.toUpperCase(), 1000000, 131072, alwaysThinks(['low', 'high', 'max']), id === 'glm-5.3' ? glmSource : glmFlashSource, { maxTokensField: 'max_tokens', thinkingFormat: 'zai', toolStream: true, ...(id === 'glm-5.3' ? { compactionFork: true } : {}), reasoningEffortMap: { off: 'low', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' } }, id === 'glm-5.3' ? ['text'] : ['text', 'image']));
const kimiModels = [modern('kimi-k3', 'Kimi K3', 1048576, 1048576, alwaysThinks(['low', 'high', 'max']), kimiSource, { maxTokensField: 'max_completion_tokens', thinkingFormat: 'openai', requiresReasoningContent: true }, ['text', 'image'])];
const kimiCodingSource = 'https://www.kimi.com/code/docs/en/kimi-code/models.html';
const kimiCodingModels = [['k3-256k', 'Kimi K3 · 256K', 262144], ['kimi-for-coding', 'Kimi · Coding', 1048576]].map(([id, name, contextWindow]) => ({ id, name, contextWindow, modelMaxOutputTokens: null, maxOutputTokens: 8192, ...withReasoning(alwaysThinks(['low', 'high', 'max'])), input: ['text', 'image'], toolCall: true, legacyProjection: false, compat: { maxTokensField: 'max_completion_tokens', thinkingFormat: 'openai', requiresReasoningContent: true, supportsPromptCacheKey: false }, source: { url: kimiCodingSource, checkedAt: '2026-09-27' } }));
const mimoModels = ['pro', 'flash'].map(tier => modern(`mimo-v2.6-${tier}`, `MiMo V2.6 ${tier === 'pro' ? 'Pro' : 'Flash'}`, 1048576, 131072, toggle, mimoSource, { maxTokensField: 'max_completion_tokens', thinkingFormat: 'toggle', requiresReasoningContent: true }, ['text', 'image']));
const expandedPresets = [
  { id: 'qwen-cn', name: '千问 Qwen · 中国', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', sourceUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', models: qwenModels, notes: '北京地域百炼 API。可替换为自己的工作空间专用域名；中国与国际 API Key 分开。思考只有启用/关闭，不虚构强度档位。' },
  { id: 'qwen-intl', name: '千问 Qwen · 国际', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_INTL_API_KEY', sourceUrl: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope', models: qwenModels, notes: '新加坡地域 API；与中国地域密钥分开。可使用控制台提供的工作空间专用地址。' },
  { id: 'kimi-cn', name: 'Kimi · 中国', baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', sourceUrl: kimiSource, models: kimiModels, notes: 'Kimi K3 始终启用思考，支持 low/high/max；目录存在不代表账户已开通。' },
  { id: 'kimi', name: 'Kimi · 国际', baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_INTL_API_KEY', sourceUrl: 'https://platform.moonshot.ai/docs/guide/kimi-k3-quickstart', models: kimiModels, notes: '国际开放平台，使用对应账户密钥。' },
  { id: 'kimi-coding', name: 'Kimi Coding · 交互套餐', authMode: 'coding_plan', usagePolicy: 'interactive_only', baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnv: 'KIMI_CODING_API_KEY', sourceUrl: kimiCodingSource, models: kimiCodingModels, notes: '套餐 Key 仅用于交互聊天；主动协作与进化请配置独立 API 提供商。K3-256K 固定 262144 上下文，账户仍须获得模型授权；目录未声明输出能力上限。' },
  { id: 'glm', name: '智谱 GLM · API', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', sourceUrl: glmSource, models: glmModels, notes: '按量 API，与 Coding Plan 端点分开。GLM-5.3 系列始终思考；Flash / FlashX 支持图像。' },
  { id: 'glm-coding', name: '智谱 GLM · Coding Plan', authMode: 'coding_plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZHIPU_CODING_API_KEY', sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/latest-model', models: glmModels.filter(m => m.id !== 'glm-5.3-flashx'), notes: 'Coding Plan 专用端点，使用套餐 Key，不使用网页登录。模型 ID 不添加 [1m] 后缀。' },
  { id: 'mimo', name: '小米 MiMo · API', baseUrl: 'https://api.xiaomimimo.com/v1', apiKeyEnv: 'MIMO_API_KEY', sourceUrl: mimoSource, models: mimoModels, notes: '按量 API；保留工具调用的 reasoning_content。当前 SDK 提供文字/图片，暂不接入该模型音视频输入。' },
  { id: 'mimo-token-plan-cn', name: '小米 MiMo · Token Plan 中国', authMode: 'coding_plan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKeyEnv: 'MIMO_TOKEN_PLAN_API_KEY', sourceUrl: 'https://mimo.mi.com/static/docs/tokenplan/Token%20Plan/quick-access.md', models: mimoModels, notes: 'Token Plan 专用密钥，独立于按量 API；实际地域与模型授权以控制台为准。' }
].map(p => ({ protocol: 'openai', checkedAt: expandedCheckedAt, ...p }));
const presets = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', sourceUrl: deepseekSource, models: [
    model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, 384000, deepseekReasoning, deepseekSource, { input: ['text'], compat: { maxTokensField: 'max_tokens' } }),
    model('deepseek-flash', 'DeepSeek V4.1 Flash', 1000000, 384000, deepseekReasoning, deepseekSource, { compat: { maxTokensField: 'max_tokens' } })
  ], notes: '上下文 1,000,000；模型输出能力 384,000。单次输出另行配置。Flash 支持图像输入；Pro 仅文字，选择 Pro 时不会自动切换模型。图像能力来源：https://api-docs.deepseek.com/guides/vision/（2026-09-25）。' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', sourceUrl: `${openaiSource}gpt-5.4`, models: [
    model('gpt-5.4', 'GPT-5.4', 1050000, 128000, cap('effort', ['low', 'medium', 'high', 'xhigh'], { canDisable: true, visibility: 'hidden' }), `${openaiSource}gpt-5.4`, { compat: { supportsPromptCacheKey: true, reasoningEffortMap: { off: 'none' } } }),
    model('gpt-4.1-mini', 'GPT-4.1 Mini', 1047576, 32768, noReasoning, `${openaiSource}gpt-4.1-mini`, { compat: { supportsPromptCacheKey: true } })
  ], notes: '使用当前 SDK 的 Chat Completions 协议；仅提供已核对该协议和工具调用的模型。预设不代表账户已授权。' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', sourceUrl: anthropicSource, models: [
    // Thinking counts toward max_tokens and cannot be disabled on Opus 5.5: 64K is the documented starting point for
    // agentic turns (an 8K allowance cut tool responses off at high effort). Sonnet 5 offers the same xhigh/max levels,
    // so it gets the same allowance.
    model('claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000, cap('adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], { providerDefault: 'medium', visibility: 'summary', defaultAdaptive: true }), anthropicSource, { maxOutputTokens: 64000, compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } }),
    model('claude-sonnet-5', 'Claude Sonnet 5', 1000000, 128000, cap('adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], { providerDefault: 'high', visibility: 'summary', defaultAdaptive: true }), anthropicSource, { maxOutputTokens: 64000, compat: { adaptiveThinking: true, thinkingDisplay: 'summarized' } }),
    model('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 64000, cap('budget', ['low', 'medium', 'high'], { canDisable: true, visibility: 'summary' }), anthropicSource)
  ], notes: '原生 Messages 协议，只用 API Key，支持提示缓存。Opus 5.5 的自适应思考始终启用；Opus 5.5 与 Sonnet 5 的单次输出额度默认 64K（思考计入输出）；历史思考按对话绑定，Rna 保持只追加历史。能力上限不等于本次输出额度。' },
  { id: 'google', name: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', sourceUrl: 'https://ai.google.dev/gemini-api/docs/openai', models: [
    model('gemini-2.5-flash', 'Gemini 2.5 Flash', 1048576, 65536, cap('effort', ['low', 'medium', 'high'], { visibility: 'hidden' }), 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash', { maxOutputTokens: 32768, compat: { maxTokensField: 'max_tokens', supportsPromptCacheKey: false } })
  ], notes: '通过 Google 官方 OpenAI 兼容端点接入，支持文字、内联图片与工具；不提供原生 Gemini 视频、音频或 thought signature 专属能力。' },
  { id: 'groq', name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', sourceUrl: 'https://console.groq.com/docs/models', models: [
    model('llama-3.3-70b-versatile', 'Llama 3.3 70B', 131072, 32768, noReasoning, 'https://console.groq.com/docs/models', { input: ['text'], compat: { maxTokensField: 'max_completion_tokens', supportsPromptCacheKey: false } })
  ], notes: '使用 OpenAI 兼容端点；账户可用性以连接检测返回的目录为准。' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', sourceUrl: 'https://openrouter.ai/api/v1/models', models: [
    model('openai/gpt-4.1-mini', 'OpenAI · GPT-4.1 Mini', 1047576, 32768, noReasoning, 'https://openrouter.ai/api/v1/models', { compat: { maxTokensField: 'max_tokens', supportsPromptCacheKey: false } })
  ], notes: '路由商容量取其模型目录，不能只按原厂同名模型推断。检测目录后可添加其他具有明确容量的模型。' },
  ...expandedPresets,
  { id: 'openai-codex', name: 'OpenAI · ChatGPT 订阅', authMode: 'subscription', authProvider: 'openai-codex', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', apiKeyEnv: '', sourceUrl: 'https://developers.openai.com/codex/auth', models: [], notes: '浏览器或设备码登录后获取账户模型目录。订阅端点独立于按量 API，不借用 API 模型容量充当账户授权。' },
  { id: 'custom', name: '自定义兼容服务', protocol: 'openai', baseUrl: '', apiKeyEnv: '', sourceUrl: null, models: [], notes: '填写服务地址、模型 ID、实际上下文容量与单次输出上限；未知模型不会自动假定为 128K。' }
].map(preset => ({ checkedAt, ...preset }));
export const catalogInputCapability = model => ({ status: 'known', source: 'catalog', input: [...model.input], ...(model.source?.url ? { sourceUrl: model.source.url } : {}), ...(model.source?.checkedAt ? { checkedAt: model.source.checkedAt } : {}) });
const describePreset = preset => preset && ({ ...structuredClone(preset), models: preset.models.map(model => ({ ...structuredClone(model), ...(model.input ? { inputCapability: catalogInputCapability(model) } : {}) })) });
export const providerPresets = () => presets.map(describePreset);
export const providerPreset = id => describePreset(presets.find(preset => preset.id === id));
const canonical = url => String(url ?? '').replace(/\/+$/, '').replace(/^https:\/\/api\.deepseek\.com\/v1$/, 'https://api.deepseek.com');
export function catalogModel(provider, id) {
  // Hot path (every resolveModel): clone only the one catalog model, not the whole preset.
  const model = matchedPreset(provider)?.models.find(row => row.id === id);
  return model && structuredClone(model);
}

export function matchedProviderPreset(provider) {
  const preset = matchedPreset(provider);
  return preset && (preset.id === 'qwen-cn' || preset.id === 'qwen-intl') && canonical(preset.baseUrl) !== canonical(provider?.baseUrl) ? providerPreset(preset.id) : preset && structuredClone(preset);
}
function matchedPreset(provider) {
  const exact = presets.find(item => item.id !== 'custom' && item.protocol === provider?.protocol && canonical(item.baseUrl) === canonical(provider?.baseUrl));
  if (exact) return exact;
  // Official workspace domains share the same regional Model Studio service.
  // No suffix matching for arbitrary proxies or different API routes.
  try {
    const url = new URL(provider?.baseUrl);
    if (provider?.protocol === 'openai' && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/+$/, '') === '/compatible-mode/v1') {
      const region = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.exec(url.hostname)?.[1];
      if (region && !url.hostname.startsWith('token-plan.')) return presets.find(item => item.id === (region === 'cn-beijing' ? 'qwen-cn' : 'qwen-intl'));
    }
  } catch { /* Invalid/unrecognized endpoints have no borrowed capabilities. */ }
  return undefined;
}
