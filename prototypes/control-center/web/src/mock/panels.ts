/**
 * Mock routes for the global panels (F1): configuration/providers, settings,
 * JEV, web tools, maintenance, memory, capabilities, marketplace, archive,
 * delete, permissions and the workspace directory picker. Shapes follow the
 * real daemon (captured read-only from GET endpoints).
 */
import { ApiError } from '@/api/transport'
import type { Session } from '@/api/types'
import type {
  AppSettings, CapabilityCatalog, DecisionKernelConfig, FullConfiguration, MaintenanceState, MemoryEntry, ProjectDetail, ProviderConfig, ProviderPreset,
} from '@/api/panels-types'
import { ago, configuration, projects } from './fixtures'

export const NOT_HANDLED = Symbol('not-handled')

export interface PanelsHost {
  sessions(): Session[]
  emitIndex(payload: { projects?: unknown[]; sessions?: Session[]; removed?: { projects?: string[]; sessions?: string[] } }): void
}

const clone = <T,>(v: T): T => structuredClone(v)
const HOUR = 3_600_000

/* ---------------------------------------------------------- fixtures */

const presets: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 1_050_000, maxOutputTokens: 8192, modelMaxOutputTokens: 128_000, reasoning: ['low', 'medium', 'high', 'xhigh', 'off'], input: ['text', 'image'], source: { url: 'https://developers.openai.com/api/docs/models/gpt-5.4', checkedAt: '2026-09-24' } }] },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-opus', name: 'Claude Opus', contextWindow: 200_000, maxOutputTokens: 8192, modelMaxOutputTokens: 64_000, reasoning: ['low', 'medium', 'high', 'max'], input: ['text', 'image'] }] },
  { id: 'glm', name: '智谱 GLM · API', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 16384, modelMaxOutputTokens: 131_072, reasoning: ['low', 'medium', 'high', 'off'], input: ['text'] }] },
  { id: 'glm-coding', name: '智谱 GLM · Coding Plan', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', authMode: 'coding_plan', models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 16384, reasoning: ['low', 'high', 'off'], input: ['text'] }] },
  { id: 'openai-codex', name: 'OpenAI · ChatGPT 订阅', protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', authMode: 'subscription', models: [] },
  { id: 'custom', name: '自定义兼容服务', protocol: 'openai', baseUrl: '', models: [] },
]

const full: FullConfiguration = {
  defaultModel: configuration.defaultModel,
  providers: configuration.providers.map((p, i) => ({
    ...clone(p), baseUrl: ['https://open.bigmodel.cn/api/paas/v4', 'https://api.anthropic.com', 'https://api.moonshot.cn/v1'][i], authMode: 'api_key', apiKeyConfigured: i !== 2, apiKeyEnv: i === 2 ? 'MOONSHOT_API_KEY' : '', autoDiscoverModels: true, presetId: ['glm', 'anthropic', undefined][i],
    ...(i === 0 ? { modelDiscovery: { checkedAt: ago(3 * HOUR), discovered: 2, unknown: 0, connectionVerified: true } } : {}),
    models: p.models.map(m => ({ ...clone(m), maxOutputTokens: 16384, inputCapability: { status: 'known', source: 'catalog', input: ['text'] } })),
  })) as ProviderConfig[],
  memory: { backend: 'openviking', endpoint: 'http://127.0.0.1:1933', apiKeyEnv: '', autoRecall: true, autoStore: true, contextBudget: 2048, limit: 20, apiKeyConfigured: true },
  webTools: { enabled: true, provider: 'fastcrw', baseUrl: 'https://crawl.example.com', timeoutMs: 30000, apiKeyEnv: '', apiKeyConfigured: true },
  webToolProviders: [
    { id: 'fastcrw', label: 'FastCRW', baseUrl: 'https://api.fastcrw.com', key: 'optional', reader: 'service' },
    { id: 'firecrawl', label: 'Firecrawl', baseUrl: 'https://api.firecrawl.dev', key: 'optional', reader: 'service' },
    { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com', key: 'required', reader: 'service' },
    { id: 'brave', label: 'Brave Search', baseUrl: 'https://api.search.brave.com', key: 'required', reader: 'direct' },
    { id: 'zhipu', label: '智谱 Web Search', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', key: 'required', reader: 'service' },
    { id: 'bocha', label: '博查 Bocha', baseUrl: 'https://api.bochaai.com', key: 'required', reader: 'direct' },
  ],
  providerPresets: presets,
  runtime: { modelExecution: 'rna', sdkVersion: '0.15.0' },
}

export const mockSettings: AppSettings & { emergency?: boolean } = { dailyBudget: 10000, tokenBudget: 100000, maxConcurrent: 3, realTokenBudget: null, proactive: false }
let emergency = false

let decision: DecisionKernelConfig = {
  // K2 v2: every point built in and active; backend picked automatically (TypeSafe → fast model → none).
  provider: 'jev', model: 'jev-latest', backend: 'typesafe', mode: 'active',
  modes: { 'initiative.review': 'active', 'evolution.review': 'active', 'chat.preflight': 'off', 'chat.route': 'off', 'delivery.reach': 'active', 'skill.screen': 'active', 'candidate.prescore': 'active' },
  autoModel: false, settings: { editable: ['apiKey', 'fastModel', 'autoModel'], judgeOrder: ['typesafe', 'fast_model_llm_judge', 'none'] }, diagnosticOverride: null,
  apiKeyConfigured: true, status: 'ready', route: { available: false, backend: null }, planReadyCount: 2,
  plans: [{ projectId: 'p-ink', projectName: '水墨飞鸟', revision: 'bac02ef75055582d7d18d36af93db4d78aaf6d76', source: { kind: 'main_model', modelId: 'glm-5.3', createdAt: ago(5 * HOUR) }, questionCount: 5, questionKeys: ['task_state', 'initiative_need', 'memory_need', 'user_satisfaction', 'evolution_need'] }],
  metrics: { requests: 13, cacheHits: 2, fallbacks: 4, totalTokens: 35_800, lastLatencyMs: 808 },
  performance: { groups: [
    { point: 'initiative.review', mode: 'active', measuredRequests: 5, p50Ms: 1254, p95Ms: 1530, reportedTokens: 17_555, unknownUsageRequests: 0 },
    { point: 'chat.preflight', mode: 'active', measuredRequests: 3, p50Ms: 808, p95Ms: 969, reportedTokens: 6159, unknownUsageRequests: 0, legacyUnmeasured: 4 },
  ] },
  recent: [
    { id: 'd1', at: Date.now() - 20 * 60_000, point: 'chat.preflight', backend: 'typesafe', source: 'judge', reason: 'accepted', disposition: 'chat_preflight', latencyMs: 808, usage: { inputTokens: 1937, outputTokens: 106 }, planRevision: 'de2084a2', planSource: { kind: 'main_model', modelId: 'glm-5.3', createdAt: ago(6 * HOUR) },
      assessmentDisplay: [{ key: 'task_state', title: '任务状态', type: 'choice', optionLabel: '最近交付已收口，等待用户实机反馈', score: 0.53 }, { key: 'memory_need', title: '项目记忆需要', type: 'boolean', optionLabel: '回答涉及历史约定或决策', probability: 0.83 }] },
    { id: 'd2', at: Date.now() - 2 * HOUR, point: 'initiative.review', backend: 'typesafe', source: 'fallback', reason: 'timeout', latencyMs: 1600, usage: { inputTokens: 2100 } },
  ],
}

/* H5 decision points (GET /api/decision-kernel `points`) and calibration. */
const POINT_INFO: [string, string, 'low' | 'medium' | 'high', string, Record<string, unknown>?][] = [
  ['turn.route', '每轮路由', 'low', 'reasoning effort, memory skip, tail hints (skill, background stop/redirect, clarify)', { supersedes: ['chat.route', 'chat.preflight'] }],
  ['chat.route', '推理档位（旧）', 'low', 'legacy; superseded by turn.route', { legacy: true }],
  ['chat.preflight', '记忆预判（旧）', 'low', 'legacy; superseded by turn.route', { legacy: true }],
  ['initiative.review', '后台复核', 'medium', 'defer the main-model review using the main-model plan (bounded deferral)'],
  ['initiative.gate', '后台唤醒', 'medium', 'host atomic questions decide wake vs wait (bounded deferral)', { rides: 'initiative.review' }],
  ['evolution.review', '进化复核', 'medium', 'defer an evolution review (bounded deferral)'],
  ['delivery.reach', '触达档位', 'medium', 'lower (never raise) proactive delivery reach'],
  ['message.check', '主动消息检查', 'medium', 'request one rewrite of a proactive message'],
  ['message.value', '主动消息价值', 'medium', 'score new/continuing/relevant/time-sensitive/decision/already-told for the narrator; code combines it with pacing to send, hold, file or drop'],
  ['memory.filter', '召回筛选', 'medium', 'drop recalled passages judged irrelevant'],
  ['skill.screen', '技能市场筛选', 'high', 'fit / reject marketplace candidates before main-model review'],
  ['candidate.prescore', '进化候选先验', 'high', 'skip paid evaluation of a candidate (never adopt)'],
  ['tool.risk', '工具风险确认', 'high', 'ask the user to confirm a high-risk call under full permission (never widens permission)'],
  ['mind.judge', '项目心智判断', 'medium', 'dedup/supersede learned lessons, filter recalled lessons, settle pending commitments (visible and revocable in the mind view)'],
]
const THRESHOLDS = { version: 1, floor: 0.5, low: 0.6, medium: 0.75, high: 0.85, llmOffset: 0.1, skillGate: 0.3, skillFits: 0.3, points: { 'turn.route': { reasoning_effort: 'low', needs_memory: { use: 0.65, skip: 0.2 }, skill_pick: 'medium', model_tier: 'medium' }, 'tool.risk': { confirm: 'high', second: 0.5 } } }
decision.modes = { ...decision.modes, 'turn.route': 'active', 'initiative.gate': 'active', 'message.check': 'active', 'memory.filter': 'active', 'tool.risk': 'active' }
// `?jev=fast` / `?jev=none` / `?jev=diag` preview the other judge states.
{
  const jev = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('jev')
  if (jev === 'fast') Object.assign(decision, { backend: 'llm', provider: 'llm', model: 'glm-4.5-air', apiKeyConfigured: false, fastModel: { providerId: 'glm', modelId: 'glm-4.5-air' }, llmModel: { providerId: 'glm', modelId: 'glm-4.5-air' }, autoModel: true })
  if (jev === 'none') Object.assign(decision, { apiKeyConfigured: false, status: 'not_configured' })
  if (jev === 'diag') decision.diagnosticOverride = { env: { backend: 'typesafe', modes: { 'tool.risk': 'shadow' } }, saved: false }
}
decision.route = { available: true, backend: 'typesafe', point: 'turn.route' }
function mockCalibration(point: string | null, window: string) {
  const scale = window === '24h' ? 0.2 : window === '30d' ? 3.4 : window === 'all' ? 5 : 1
  const n = (v: number) => Math.round(v * scale)
  const report = (name: string | null, base: number) => {
    const decisions = n(base), labeled = n(base * 0.6)
    const buckets = [[0, 0.1, 0.06, 0.1], [0.1, 0.3, 0.2, 0.26], [0.3, 0.5, 0.41, 0.35], [0.5, 0.7, 0.62, 0.55], [0.7, 0.9, 0.81, 0.74], [0.9, 1, 0.95, 0.9]].map(([a, b, p, o], i) => ({ range: [a, b], n: n([12, 9, 6, 8, 14, 22][i] * base / 120), predicted: p, observed: o }))
    return {
      point: name, window, thresholdsVersion: 1, thresholdChanges: 'manual', decisions, scored: n(base * 0.92), decided: n(base * 0.75), applied: n(base * 0.5), labeled,
      coverage: 0.818, abstainRate: 0.182, unscoredReasons: { timeout: n(4), shadow: n(6) }, modes: { active: n(base * 0.8), shadow: n(base * 0.2) },
      latency: { p50: 180, p95: 420 }, tokens: n(base * 426), savings: { mainModelCalls: n(base / 10), auxiliaryCalls: n(base / 2), latencyMs: 0 },
      questions: decisions ? { needs_memory: { n: n(base * 0.9), labeled, brier: 0.12, buckets }, reasoning_effort: { n: n(base * 0.9), labeled: n(base * 0.4), brier: 0.19, buckets: buckets.map(b => ({ ...b, observed: Math.max(0, Math.min(1, (b.observed ?? 0) - 0.08)) })) } } : {},
    }
  }
  if (point) return report(point, point === 'turn.route' ? 120 : point === 'tool.risk' ? 0 : 40)
  return { ...report(null, 200), points: { 'turn.route': report('turn.route', 120), 'initiative.review': report('initiative.review', 40) } }
}
function withPoints(config: DecisionKernelConfig) {
  return clone({
    ...config,
    points: POINT_INFO.map(([point, title, stake, effect, extra]) => ({ point, title, stake, effect, mode: config.modes?.[point as keyof NonNullable<DecisionKernelConfig['modes']>] ?? 'active', builtIn: !extra?.legacy, templateVersion: ['delivery.reach', 'skill.screen', 'candidate.prescore', 'message.check', 'message.value'].includes(point) ? 2 : 1, ...(extra ?? {}) })),
    thresholds: THRESHOLDS, thresholdsEditable: false,
    calibration: { 'turn.route': { decisions: 120, coverage: 0.82, abstainRate: 0.18, labeled: 70, savings: { mainModelCalls: 12, auxiliaryCalls: 60 } }, 'initiative.review': { decisions: 40, coverage: 0.9, abstainRate: 0.1, labeled: 22, savings: { mainModelCalls: 9, auxiliaryCalls: 0 } } },
  } as DecisionKernelConfig)
}

let maintenance: MaintenanceState = {
  current: { hostVersion: '0.22.2', sdkVersion: '0.15.0' }, busy: false, held: false,
  capabilities: { prepare: true, backup: true, apply: true, rollback: true, restore: true },
  operation: { id: 'op-1', requestId: 'r-1', kind: 'apply', phase: 'completed', summary: '应用版本已切换，身份与就绪检查通过。', startedAt: ago(2 * HOUR), completedAt: ago(2 * HOUR - 60_000), attemptCount: 1,
    attempts: [{ number: 1, status: 'completed', elapsedMs: 949, stages: [{ name: 'validate_runtime', status: 'completed', elapsedMs: 536 }, { name: 'checkpoint', status: 'completed', elapsedMs: 4120 }, { name: 'validate_target', status: 'completed', elapsedMs: 269 }, { name: 'verify_successor', status: 'completed', elapsedMs: 34, reconciled: true }] }] },
  candidates: [{ id: 'cand-0221', hostVersion: '0.22.1', sdkVersion: '0.15.0', digest: '47dc85575dd72304033de705061b904d5c413ac806d67a9db155d6e5c4128154', trust: 'local_content_verified', preparedAt: ago(3 * HOUR), baselineOnly: false, canApply: true, canRollback: true }],
  checkpoints: [
    { id: 'ckpt-2', createdAt: ago(2 * HOUR), files: 2310, bytes: 831_093_335, verified: true },
    { id: 'ckpt-1', createdAt: ago(28 * HOUR), files: 2198, bytes: 790_553_112, verified: true },
  ],
  history: [
    { id: 'h1', kind: 'backup', phase: 'completed', summary: '恢复点已创建并验证。', startedAt: ago(28 * HOUR), completedAt: ago(28 * HOUR) },
    { id: 'h2', kind: 'apply', phase: 'completed', summary: '已更新至 0.22.2。', startedAt: ago(2 * HOUR), completedAt: ago(2 * HOUR) },
  ],
}

const capabilities: CapabilityCatalog = {
  skills: [
    { id: 'project-analysis', name: '项目分析', description: '根据证据理解项目目标、约束与结构，明确待确认的决策。', enabled: true, builtin: true },
    { id: 'research', name: '资料研究', description: '核对一手来源并区分事实与不确定结论。', enabled: true, builtin: true },
    { id: 'frontend-design', name: 'frontend-design', description: '为界面实现提供排版、色彩、动效与可访问性检查清单。', enabled: true },
    { id: 'gen-ink-art', name: '水墨资产规范', description: '项目版本生成的美术资产技能。', enabled: true, generated: true },
  ],
  mcpServers: [{ id: 'playwright', name: '浏览器与网页验证', description: '官方 Playwright MCP：独立浏览器会话、导航、截图与错误检查。', enabled: false, transport: 'stdio', discoveredTools: [] }],
  tools: [
    { id: 'project_read', name: '读取项目文件', permission: 'read', description: '读取项目工作目录中的文件。', builtin: true, enabled: true },
    { id: 'project_write', name: '写入项目文件', permission: 'write', description: '在项目目录内创建和覆盖文件。', builtin: true, enabled: true },
    { id: 'project_exec', name: '运行项目命令', permission: 'exec', description: '在项目目录中以当前用户运行命令。', builtin: true, enabled: true },
  ],
  assignments: { skillIds: ['project-analysis', 'research', 'gen-ink-art'], toolIds: ['project_read', 'project_write', 'openviking_search'], mcpServerIds: [] },
  installations: [{ installationId: 'install-1', status: 'installed', entries: [{ kind: 'skills', id: 'frontend-design' }], sources: [{ type: 'git', repository: 'https://github.com/anthropics/skills.git', commit: '6cc7aed315919f268e5114b201991876cd3af1d0' }] }],
  builtinAgents: [
    { id: 'scout', name: '项目侦察', readOnly: true, description: '定位相关文件、依赖和已有证据，报告路径与未知项。', limits: { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 24, finalSummarySteps: 1 } },
    { id: 'implementer', name: '实现助手', readOnly: false, description: '按父会话授权实施限定范围的修改并验证。', limits: { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 32, finalSummarySteps: 1 } },
  ],
  builtinPlugins: [{ id: 'rna-workspace', name: '项目文件与命令', capabilities: ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit', 'project_exec'] }],
}

const memoryEntries = (projectId: string): MemoryEntry[] => {
  const ns = `viking://resources/projects/${projectId}`
  return [
    { uri: `${ns}/decisions`, title: 'decisions', isDirectory: true, kind: 'resource', modifiedAt: ago(40 * 60_000), displayExcerpt: '项目决策与约定：美术风格、发布节奏、性能预算。' },
    { uri: `${ns}/art-direction.md`, title: 'art-direction.md', kind: 'memory', modifiedAt: ago(2 * HOUR), displayExcerpt: '水墨风格：留白 ≥ 40%，主色墨黑与赭石，禁止高饱和霓虹色；HUD 使用细线描边。' },
    { uri: `${ns}/daily-report-2026-09-27.md`, title: '3f2a9c1e4b5d6a7f8e9d0c1b2a3f4e5d.md', kind: 'resource', modifiedAt: ago(20 * HOUR), displayExcerpt: '昨日交付：芦苇羽穗动画、HUD 重设计；待确认：难度曲线第三关。', provenance: { kind: 'autonomous_delivery', role: 'assistant', itemId: 'i-1', createdAt: ago(20 * HOUR) } },
    { uri: `${ns}/perf-budget.md`, title: 'perf-budget.md', kind: 'memory', modifiedAt: ago(3 * 24 * HOUR), displayExcerpt: '移动端首屏 < 2.5s，主包 gzip < 180 kB，60fps 下单帧脚本 < 6ms。' },
  ]
}

const DOC = `# 美术方向

- **留白**：画面留白不少于 40%，让飞鸟轨迹成为视觉焦点。
- **色彩**：墨黑 \`#1b1b1b\`、赭石 \`#a0522d\`、宣纸 \`#f4efe4\`；避免高饱和霓虹色。
- **HUD**：细线描边，数字使用等宽字体，动效不超过 200ms。

> 用户在 9 月 25 日确认：第三关背景改为远山，不再使用城市剪影。`

/* ------------------------------------------------------------ router */

export async function handlePanels(host: PanelsHost, method: string, url: URL, body: Record<string, unknown>): Promise<unknown | typeof NOT_HANDLED> {
  const p = url.pathname
  let m: RegExpMatchArray | null
  const project = (id: string) => projects.find(x => x.id === decodeURIComponent(id)) as ProjectDetail | undefined

  /* configuration */
  if (p === '/api/configuration' && method === 'GET') return clone(full)
  if (p === '/api/configuration' && method === 'PATCH') {
    if (body.defaultModel) { full.defaultModel = body.defaultModel as never; configuration.defaultModel = body.defaultModel as never }
    if (body.memory) { const { apiKey, ...rest } = body.memory as Record<string, unknown>; full.memory = { ...full.memory, ...rest, ...(apiKey !== undefined ? { apiKeyConfigured: Boolean(apiKey) } : {}) } }
    if (body.webTools) { const { apiKey, ...rest } = body.webTools as Record<string, unknown>; full.webTools = { ...full.webTools, ...rest, ...(apiKey !== undefined ? { apiKeyConfigured: Boolean(apiKey) } : {}) } }
    return clone(full)
  }
  if (p === '/api/providers' && method === 'POST') {
    const provider = { ...(body as object), id: `prov-${Math.random().toString(36).slice(2, 7)}`, apiKeyConfigured: Boolean(body.apiKey), apiKey: undefined } as unknown as ProviderConfig
    full.providers.push(provider)
    return clone(provider)
  }
  if ((m = p.match(/^\/api\/providers\/([^/]+)$/))) {
    const index = full.providers.findIndex(x => x.id === decodeURIComponent(m![1]))
    if (index < 0) throw new ApiError('提供商不存在', 404)
    if (method === 'DELETE') {
      if (full.defaultModel?.providerId === full.providers[index].id) throw new ApiError(`「${full.defaultModel.modelId}」是默认模型，移除后它就不在供应商允许列表中了。请先在「默认模型」里换一个模型并保存，再移除它。`, 409)
      full.providers.splice(index, 1); return {}
    }
    full.providers[index] = { ...full.providers[index], ...(body as object), apiKeyConfigured: body.apiKey ? true : body.apiKey === '' ? false : full.providers[index].apiKeyConfigured } as ProviderConfig
    return clone(full.providers[index])
  }
  if ((m = p.match(/^\/api\/providers\/([^/]+)\/(test|refresh-models)$/))) {
    const provider = full.providers.find(x => x.id === decodeURIComponent(m![1]))
    if (!provider) throw new ApiError('提供商不存在', 404)
    await new Promise(r => setTimeout(r, 600))
    if (m[2] === 'test') return { ok: true, message: `连接成功 · 端点返回 3 个模型`, connectionVerified: true, models: [
      { id: provider.models[0]?.id ?? 'model-a', name: provider.models[0]?.name, contextWindow: 1_000_000, readyForAgent: true },
      { id: `${provider.id}-lite`, name: `${provider.name} Lite`, contextWindow: 128_000, readyForAgent: true, maxOutputTokens: 8192 },
      { id: `${provider.id}-embed`, name: 'Embedding', unavailableReason: 'no-tool-calling' },
    ] }
    provider.modelDiscovery = { checkedAt: new Date().toISOString(), discovered: provider.models.length, unknown: 0, connectionVerified: true }
    return { message: `已同步 ${provider.models.length} 个模型，保留手动设置。`, connectionVerified: true, provider: clone(provider) }
  }
  if ((m = p.match(/^\/api\/providers\/([^/]+)\/auth(?:\/(start|complete|cancel|logout))?$/))) return { authenticated: false, state: 'idle' }

  /* general */
  if (p === '/api/settings' && method === 'PATCH') { Object.assign(mockSettings, body); return clone(mockSettings) }
  if (p === '/api/emergency' && method === 'POST') { emergency = Boolean(body.stop); mockSettings.emergency = emergency; return { emergency } }
  if (p === '/api/health') return { ok: true, version: '0.22.2', sdkVersion: '0.15.0', node: '22.19.0', workload: { tokenUsage: { reported: 1_284_530, estimated: 12_400, reserved: 8192 }, activeSessions: 0 } }
  if (p === '/api/v2/usage/cache') {
    const window = url.searchParams.get('window') ?? '24h'
    const k = window === '1h' ? 0.08 : window === '7d' ? 6.2 : 1
    const stat = (requests: number, input: number, cacheRead: number, hitRate: number, coverage: number) => ({ requests: Math.max(1, Math.round(requests * k)), input: Math.round(input * k), cacheRead: Math.round(cacheRead * k), cacheWrite: Math.round(input * k * 0.05), output: Math.round(input * k * 0.1), hitRate, coverage, coldStarts: Math.max(1, Math.round(2 * k)), unreported: 0 })
    return {
      window,
      overall: { ...stat(128, 210_000, 2_380_000, 0.901, 0.87), unreported: 3 },
      byPurpose: { foreground: stat(96, 117_708, 2_153_984, 0.948, 0.95), initiative: stat(18, 45_229, 198_000, 0.814, 0.72), 'jev-llm': stat(9, 21_000, 28_016, 0.571, 1), compaction: stat(5, 26_063, 0, 0, 0.6) },
      judge: { requests: Math.round(5561 * k), input: Math.round(11_736_229 * k), output: Math.round(829_768 * k), product: { requests: Math.round(77 * k), input: Math.round(216_003 * k), output: Math.round(7859 * k) }, probe: { requests: Math.round(5484 * k), input: Math.round(11_520_226 * k), output: Math.round(821_909 * k) } },
      // The largest runs by tokens, cache reads apart from fresh ones (token-burn study Z1). No cost: the backend does not track real prices.
      runs: [
        { sessionId: 'schedule-work-af55b64d', purpose: 'background-work', projectName: '水墨飞鸟', kind: 'scheduled', title: '每日行业调研', requests: 44, tokens: 1_330_000, input: 54_900, cacheRead: 1_270_000, cacheWrite: 0, output: 5_100, firstAt: ago(10 * 3_600_000), lastAt: ago(9 * 3_600_000) },
        { sessionId: 'e0b4447f', purpose: 'background-work', projectName: '水墨飞鸟', kind: 'job', title: '补取缺失的一节文字', requests: 17, tokens: 496_000, input: 56_100, cacheRead: 439_600, cacheWrite: 0, output: 300, firstAt: ago(6 * 3_600_000), lastAt: ago(5 * 3_600_000) },
        { sessionId: '4ed897f8', purpose: 'compaction', projectName: '水墨飞鸟', requests: 1, tokens: 102_850, input: 102_400, cacheRead: 0, cacheWrite: 0, output: 450, firstAt: ago(3 * 3_600_000), lastAt: ago(3 * 3_600_000) },
      ].map(run => ({ ...run, requests: Math.max(1, Math.round(run.requests * k)), tokens: Math.round(run.tokens * k), input: Math.round(run.input * k), cacheRead: Math.round(run.cacheRead * k), output: Math.round(run.output * k) })),
      latest: { purpose: 'foreground', hitRate: 0.96, at: ago(4 * 60_000) },
    }
  }

  /* JEV */
  if (p === '/api/decision-kernel' && method === 'GET') return withPoints(decision)
  if (p === '/api/v2/decision-kernel/calibration' && method === 'GET') return mockCalibration(url.searchParams.get('point'), url.searchParams.get('window') ?? '7d')
  if (p === '/api/decision-kernel' && method === 'PATCH') {
    // K2 v2: only apiKey / fastModel (legacy alias llmModel) / autoModel are saved; mode, modes and backend are ignored.
    if (body.apiKey !== undefined) decision.apiKeyConfigured = Boolean(body.apiKey)
    const fast = body.fastModel !== undefined ? body.fastModel : body.llmModel
    if (fast === null) { delete decision.fastModel; delete decision.llmModel }
    else if (fast && typeof fast === 'object') decision.fastModel = decision.llmModel = fast as { providerId: string; modelId: string }
    if (typeof body.autoModel === 'boolean') decision.autoModel = body.autoModel
    decision.backend = decision.apiKeyConfigured ? 'typesafe' : decision.fastModel ? 'llm' : 'typesafe'
    decision.provider = decision.backend === 'llm' ? 'llm' : 'jev'
    decision.model = decision.backend === 'llm' ? decision.fastModel?.modelId ?? null : 'jev-latest'
    decision.status = decision.apiKeyConfigured || decision.fastModel ? 'ready' : 'not_configured'
    decision.route = { available: decision.status === 'ready', backend: decision.status === 'ready' ? decision.backend ?? null : null, point: 'turn.route' }
    return withPoints(decision)
  }
  // Key check after a save (judgment.ts checkJudgmentKey): a configured key reads as valid; without one the fast model judges (409).
  if (p === '/api/v2/decision-kernel/probe' && method === 'POST' && body.check === 'credential') {
    if (!decision.apiKeyConfigured) throw new ApiError('没有保存 JEV 密钥，判断由快速模型完成。', 409)
    return { status: 200, latencyMs: 180, credential: { state: 'valid', source: 'check', at: new Date().toISOString() } }
  }
  if (p === '/api/web-tools/test') { await new Promise(r => setTimeout(r, 500)); return { ok: true } }

  /* maintenance */
  if (p === '/api/maintenance' && method === 'GET') return clone(maintenance)
  if ((m = p.match(/^\/api\/maintenance\/(prepare|backup|apply|rollback|restore|cancel)$/)) && method === 'POST') {
    const kind = m[1]
    const operation = { id: crypto.randomUUID(), requestId: body.requestId as string, kind, phase: 'preparing', summary: '正在处理…', startedAt: new Date().toISOString() }
    maintenance = { ...maintenance, operation }
    setTimeout(() => {
      const done = { ...operation, phase: 'completed', summary: kind === 'backup' ? '恢复点已创建并验证。' : kind === 'prepare' ? '更新包内容已校验。' : '已完成（演示）。', completedAt: new Date().toISOString() }
      maintenance = {
        ...maintenance, operation: done, history: [...(maintenance.history ?? []), done],
        ...(kind === 'backup' ? { checkpoints: [{ id: `ckpt-${Date.now()}`, createdAt: new Date().toISOString(), files: 2320, bytes: 832_000_000, verified: true }, ...(maintenance.checkpoints ?? [])] } : {}),
      }
    }, 2500)
    return { operation }
  }

  /* memory */
  if ((m = p.match(/^\/api\/projects\/([^/]+)\/memory\/(browse|search|read|health)$/))) {
    const pid = decodeURIComponent(m[1])
    await new Promise(r => setTimeout(r, 250))
    const entries = memoryEntries(pid)
    if (m[2] === 'health') return { ok: true }
    if (m[2] === 'browse') {
      const uri = String(body.uri ?? '')
      const inDir = uri.endsWith('/decisions')
      const filter = body.filter as string | undefined
      const list = inDir
        ? [{ uri: `${uri}/release-cadence.md`, title: 'release-cadence.md', kind: 'memory', modifiedAt: ago(5 * HOUR), displayExcerpt: '每周四发布，一次只上线一个关卡。' }]
        : body.view === 'recent' ? entries.filter(e => !e.isDirectory && (!filter || filter === 'all' || e.kind === filter)) : entries
      return { uri, namespace: `viking://resources/projects/${pid}`, view: body.view, offset: 0, limit: 20, hasMore: false, entries: list, ...(body.view === 'recent' ? { collection: { memoryFiles: 2, resourceFiles: 1, directories: 3, complete: true, checkedAt: new Date().toISOString() } } : {}) }
    }
    if (m[2] === 'search') return { backend: 'openviking', entries: entries.filter(e => `${e.title}${e.displayExcerpt}`.includes(String(body.query)) || String(body.query).length < 3).map(e => ({ ...e, availableReads: e.isDirectory ? ['L1'] : ['L2'], isLeaf: !e.isDirectory })) }
    if (body.level !== 'L2' && String(body.uri).endsWith('/decisions')) {
      if (body.level === 'L0') throw new ApiError('此目录尚无可读取的摘要', 404, 'MEMORY_LAYER_UNAVAILABLE')
      return { content: '## 目录概览\n\n包含 1 个文件：发布节奏约定。', level: body.level }
    }
    return { content: DOC, level: body.level }
  }

  /* capabilities + marketplace */
  if ((m = p.match(/^\/api\/projects\/([^/]+)\/capabilities(?:\/(inspect|install|assign|remove))?$/))) {
    const action = m[2]
    if (!action) return { projectId: decodeURIComponent(m[1]), ...clone(capabilities) }
    await new Promise(r => setTimeout(r, 400))
    if (action === 'inspect') return { name: 'my-skill', version: '1.0.0', description: '示例技能（来源检查结果）。', source: (body.source as { type?: string })?.type }
    if (action === 'install') { capabilities.skills!.push({ id: `skill-${Date.now()}`, name: String(body.name ?? '新技能'), description: '刚刚安装的技能。', enabled: true }); return { activated: body.activate } }
    const a = capabilities.assignments!
    if (action === 'assign') { for (const key of ['skillIds', 'toolIds', 'mcpServerIds'] as const) for (const id of (body[key] as string[] | undefined) ?? []) if (!a[key]!.includes(id)) a[key]!.push(id); return {} }
    const field = ({ skills: 'skillIds', tools: 'toolIds', mcpServers: 'mcpServerIds' } as const)[body.kind as 'skills']
    a[field] = a[field]!.filter(id => id !== body.id)
    if (body.uninstall) capabilities[body.kind as 'skills'] = capabilities[body.kind as 'skills']!.filter(x => x.id !== body.id)
    return {}
  }
  if (p === '/api/skill-marketplaces') return { providers: [{ id: 'skills-sh', name: 'skills.sh', docsUrl: 'https://skills.sh/docs/cli', authentication: 'not_required' }, { id: 'skillsmp', name: 'SkillsMP', docsUrl: 'https://skillsmp.com/docs/api', authentication: 'anonymous_limited' }] }
  if (p === '/api/skill-marketplaces/search') {
    await new Promise(r => setTimeout(r, 450))
    return { results: [
      { id: 'anthropics/skills/frontend-design', provider: body.provider, name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', repository: 'anthropics/skills', sourceUrl: 'https://github.com/anthropics/skills', catalogUrl: 'https://skills.sh' },
      { id: 'obra/superpowers/brainstorming', provider: body.provider, name: 'brainstorming', description: 'Refine rough ideas into designs through collaborative questioning.', repository: 'obra/superpowers', sourceUrl: 'https://github.com/obra/superpowers' },
      { id: 'vercel/next-skills/research', provider: body.provider, name: 'market-research', description: '竞品与市场研究：来源分级、结论可证伪。', repository: 'vercel-labs/agent-skills' },
    ] }
  }
  if (p === '/api/skill-marketplaces/read') {
    await new Promise(r => setTimeout(r, 350))
    const commit = '6cc7aed315919f268e5114b201991876cd3af1d0'
    return {
      path: (body.path as string) ?? 'SKILL.md', repository: 'https://github.com/anthropics/skills', subdirectory: 'frontend-design', commit, contentHash: 'b4f906a1b7c22270f73720bf18ec526d56fe398f13230ed37bc69b66331874c4', bytes: 2841,
      content: body.path ? 'MIT License\n\nCopyright (c) Anthropic' : '---\nname: frontend-design\ndescription: Create distinctive, production-grade frontend interfaces.\n---\n\n# Frontend design\n\nBefore coding, commit to a bold aesthetic direction…',
      licenseFiles: [{ path: 'LICENSE', resourcePath: 'LICENSE' }], resources: [{ path: 'reference/typography.md', bytes: 1204 }],
      installInput: { kind: 'skill', source: { type: 'git', repository: 'https://github.com/anthropics/skills.git', subdirectory: 'frontend-design', ref: commit } },
    }
  }

  /* projects & sessions */
  if ((m = p.match(/^\/api\/projects\/([^/]+)$/))) {
    const target = project(m[1])
    if (!target) throw new ApiError('项目不存在', 404)
    if (method === 'DELETE') {
      const ids = host.sessions().filter(s => s.projectId === target.id).map(s => s.id)
      projects.splice(projects.indexOf(target), 1)
      host.emitIndex({ removed: { projects: [target.id], sessions: ids } })
      return { cleanup: { status: 'completed' } }
    }
    if (method === 'PATCH') {
      if (body.archived !== undefined) target.archivedAt = body.archived ? new Date().toISOString() : null
      if (typeof body.name === 'string') target.name = body.name
      for (const key of ['focus', 'initiative', 'evolution', 'rhythm', 'git'] as const) if (body[key] !== undefined) (target as unknown as Record<string, unknown>)[key] = typeof body[key] === 'object' && body[key] ? { ...((target as unknown as Record<string, object>)[key]), ...(body[key] as object) } : body[key]
      host.emitIndex({ projects: [clone(target)] })
      return clone(target)
    }
  }
  if ((m = p.match(/^\/api\/sessions\/([^/]+)$/))) {
    const s = host.sessions().find(x => x.id === decodeURIComponent(m![1]))
    if (!s) throw new ApiError('会话不存在', 404)
    if (method === 'DELETE') {
      host.sessions().splice(host.sessions().indexOf(s), 1)
      host.emitIndex({ removed: { sessions: [s.id] } })
      return { cleanup: { status: 'completed' } }
    }
    if (method === 'PATCH' && body.archived !== undefined) {
      s.archivedAt = body.archived ? new Date().toISOString() : null
      host.emitIndex({ sessions: [s] })
      return clone(s)
    }
  }
  if ((m = p.match(/^\/api\/projects\/([^/]+)\/permissions$/))) {
    const target = project(m[1])
    if (!target) throw new ApiError('项目不存在', 404)
    if (method === 'PATCH') target.permissions = { workspace: body.workspace as string, background: body.background as string }
    const workspace = (target.permissions?.workspace ?? 'read') as 'read'
    const background = (target.permissions?.background === 'inherit' ? 'inherit' : 'read') as 'read'
    return { projectId: target.id, workspace: target.workspacePath, settings: { workspace, background }, effective: { foreground: workspace, background: background === 'read' ? 'read' : workspace }, inheritedAssignments: false }
  }

  /* workspace picker */
  if (p === '/api/workspaces/browse') {
    const path = String(body.path ?? '/Users/me/Projects').replace(/\/+$/, '') || '/'
    const names = path.endsWith('Projects') ? ['ink-bird', 'daily-research', 'portfolio-site', 'rna-notes', ...(body.hidden ? ['.cache'] : [])] : ['src', 'assets', 'docs']
    return {
      path, name: path.split('/').at(-1), parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
      entries: names.map(name => ({ name, path: `${path}/${name}` })), nextOffset: null,
      projects: projects.filter(x => x.workspacePath === path).map(x => ({ id: x.id, name: x.name, archivedAt: x.archivedAt ?? null })),
    }
  }
  if (p === '/api/workspaces/directories') return { path: `${body.parent}/${body.name}` }
  if (p === '/api/workspaces/open') {
    await new Promise(r => setTimeout(r, 500))
    const existing = projects.find(x => x.id === body.projectId)
    if (existing) return { project: clone(existing), reused: true }
    const created: ProjectDetail = { id: `p-${Math.random().toString(36).slice(2, 7)}`, name: String(body.name ?? '新项目'), description: body.description as string, workspacePath: String(body.workspace), permissions: { workspace: 'read', background: 'read' }, counts: {} }
    projects.push(created)
    host.emitIndex({ projects: [clone(created)] })
    return { project: clone(created), reused: false }
  }

  return NOT_HANDLED
}

export const mockEmergency = () => emergency

/* Enrich the shared project fixtures with the fields the panels read. */
Object.assign(projects[0] as ProjectDetail, {
  decisionMode: 'rna-model', simulated: false, focus: '完成第三关的远山背景与难度曲线，保持移动端 60fps。',
  initiative: { enabled: true, notificationMuted: false, deferWhileTyping: true, reviewMinMs: 30000, reviewMaxMs: 900000, cooldownMs: 300000, tokenBudget: null, tokens: 1_804_752 },
  evolution: { enabled: true, minIntervalMs: 3_600_000 }, rhythm: { control: 'auto' },
  memorySummary: { status: 'completed', updatedAt: ago(40 * 60_000) },
  rhythmStatus: {
    control: 'auto', lifecycle: 'active', assessedAt: ago(35 * 60_000),
    assessment: { reason: '用户正在迭代第三关视觉，近期交付频繁；保持适时复查，新证据出现时复盘。', evolution: { mode: 'evidence' }, initiative: { mode: 'adaptive' } },
    initiative: { reason: 'review_interval', eligible: false, nextAt: Date.now() + 25 * 60_000 },
    evolution: { reason: 'no_unreviewed_evidence', eligible: false, quota: { dayUsed: 1, maxPerDay: 3, weekUsed: 4, maxPerWeek: 10 } },
    schedule: { nextAt: Date.now() + 14 * HOUR, activeCount: 1, dueCount: 0 },
    history: [{ at: ago(35 * 60_000), lifecycle: 'active', reason: '交付节奏加快，缩短复查间隔。', initiativeMode: 'adaptive', evolutionMode: 'evidence' }],
  },
})
projects.push({ id: 'p-old', name: '旧版官网改版', description: '已暂停', workspacePath: '/Users/me/Projects/portfolio-site', archivedAt: ago(9 * 24 * HOUR), counts: {} } as ProjectDetail)
