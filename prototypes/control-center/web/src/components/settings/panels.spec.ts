import { describe, expect, it } from 'vitest'
import type { ProviderConfig, ProviderPreset } from '@/api/panels-types'
import { applyPreset, catalogModelForDraft, formFromProvider, modelInputDisplay, modelRow, presetForAuthMode, providerBody, draftOf } from './model-catalog'
import { autonomyDraft, autonomyPayload, durationLabel, frequencyPreset } from './autonomy'
import { judgmentDraft, judgmentPayload } from './judgment'
import { formatMaintenanceAttemptHistory, maintenanceCancellable, maintenanceOperationDisplay, maintenanceTerminal } from './maintenance-display'
import { webToolsSettingsPayload } from './sections/WebToolsSection'
import { memoryDisplayTitle, memoryError, memoryPageDisplay, memoryReadableDocument, relativeMemoryPath } from '@/components/memory/memory-display'
import { installInput, emptyInstallDraft } from '@/components/capabilities/install'

const presets: ProviderPreset[] = [
  { id: 'glm', name: '智谱 GLM · API', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 16384, modelMaxOutputTokens: 131072, reasoning: ['low', 'high', 'off'], input: ['text', 'image'], compat: { a: 1 } }] },
  { id: 'glm-coding', name: 'GLM Coding', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', authMode: 'coding_plan', models: [] },
  { id: 'qwen-cn', name: 'Qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen3', name: 'Qwen3' }] },
]

describe('provider editor', () => {
  it('builds the legacy create body from a preset with key credentials', () => {
    const form = { ...applyPreset(formFromProvider(null), presets[0]), apiKey: 'sk-1' }
    const body = providerBody(form)
    expect(body).toMatchObject({ authMode: 'api_key', autoDiscoverModels: true, presetId: 'glm', name: '智谱 GLM · API', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: '', apiKey: 'sk-1' })
    expect((body.models as unknown[])[0]).toEqual({ useCatalogLimits: true, compat: { a: 1 }, modelMaxOutputTokens: 131072, id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 16384, reasoning: ['low', 'high', 'off'] })
  })
  it('drops catalog facts when the endpoint changed and omits an empty key', () => {
    const form = applyPreset(formFromProvider(null), presets[0])
    const moved = { ...form, baseUrl: 'https://other.example/v1' }
    const body = providerBody(moved)
    expect(body).not.toHaveProperty('apiKey')
    expect((body.models as Record<string, unknown>[])[0]).not.toHaveProperty('compat')
  })
  it('handles env / none / subscription credentials like the legacy form', () => {
    const provider = { id: 'p', name: 'X', protocol: 'openai', baseUrl: 'https://x', apiKeyEnv: 'X_KEY', models: [] } as ProviderConfig
    expect(providerBody(formFromProvider(provider))).toMatchObject({ apiKeyEnv: 'X_KEY', apiKey: '' })
    expect(providerBody({ ...formFromProvider(provider), credentialMode: 'none' })).toMatchObject({ apiKeyEnv: '', apiKey: '' })
    const sub = providerBody({ ...formFromProvider(provider), authMode: 'subscription' })
    expect(sub).toMatchObject({ authMode: 'subscription', authProvider: 'openai-codex', apiKeyEnv: '' })
    expect(sub).not.toHaveProperty('apiKey')
  })
  it('pairs auth modes with presets', () => {
    expect(presetForAuthMode('subscription', 'glm')).toBe('openai-codex')
    expect(presetForAuthMode('coding_plan', 'glm')).toBe('glm-coding')
    expect(presetForAuthMode('api_key', 'glm-coding')).toBe('glm')
    expect(presetForAuthMode('api_key', 'custom')).toBeNull()
  })
  it('finds catalog models, including regional Qwen endpoints', () => {
    const draft = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', protocol: 'openai', authMode: 'api_key' as const }
    expect(catalogModelForDraft(draft, 'glm-5.3', presets)?.name).toBe('GLM-5.3')
    expect(catalogModelForDraft({ ...draft, baseUrl: 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }, 'qwen3', presets)?.name).toBe('Qwen3')
    expect(modelInputDisplay({ provider: draft, modelId: 'glm-5.3', presets }).label).toBe('文字与图片')
    expect(modelInputDisplay({ provider: draft, modelId: 'nope', presets }).status).toBe('unknown')
  })
  it('serializes a manual row without catalog spec', () => {
    const draft = draftOf({ baseUrl: 'https://x', protocol: 'openai', authMode: 'api_key' })
    const row = { ...modelRow({}, draft), id: ' m1 ', contextWindow: '8192', maxOutputTokens: '1024', reasoning: 'off, high' }
    const body = providerBody({ ...formFromProvider(null), baseUrl: 'https://x', models: [row] })
    expect((body.models as unknown[])[0]).toEqual({ id: 'm1', name: 'm1', contextWindow: 8192, maxOutputTokens: 1024, reasoning: ['off', 'high'] })
  })
})

describe('autonomy', () => {
  const project = { id: 'p', name: 'P', decisionMode: 'rna-model', simulated: false, initiative: { enabled: true, tokenBudget: 5000, reviewMinMs: 15000, reviewMaxMs: 300000, cooldownMs: 30000 }, evolution: { enabled: false, minIntervalMs: 900000 }, rhythm: { control: 'auto' as const } }
  it('omits frequencies in automatic mode and keeps them in manual mode', () => {
    const draft = autonomyDraft(project)
    expect(frequencyPreset([15000, 300000, 30000, 900000])).toBe('active')
    const auto = autonomyPayload(draft)
    expect(auto).toEqual({ focus: '', rhythm: { control: 'auto' }, initiative: { enabled: true, notificationMuted: false, deferWhileTyping: true, tokenBudget: 5000 }, evolution: { enabled: false } })
    const manual = autonomyPayload({ ...draft, rhythm: 'manual', budget: '' })
    expect(manual.initiative).toMatchObject({ reviewMinMs: 15000, reviewMaxMs: 300000, cooldownMs: 30000, tokenBudget: null })
    expect(manual.evolution).toEqual({ enabled: false, minIntervalMs: 900000 })
  })
  it('sets quietUntil relative to now', () => {
    const payload = autonomyPayload({ ...autonomyDraft(project), quiet: '30' }, Date.UTC(2026, 0, 1))
    expect(payload.initiative.quietUntil).toBe('2026-01-01T00:30:00.000Z')
    expect(autonomyPayload({ ...autonomyDraft(project), quiet: 'off' }).initiative.quietUntil).toBeNull()
  })
  it('uses the demo fields for simulated projects', () => {
    const payload = autonomyPayload(autonomyDraft({ id: 'd', name: 'D', initiative: { minRelevance: 0.4, budgetUsd: 1 } }))
    expect(payload).not.toHaveProperty('rhythm')
    expect(payload.initiative).toMatchObject({ minRelevance: 0.4, budgetUsd: 1, reviewMinMs: 30000 })
  })
  it('sends P3 reach settings only to daemons with an inbox', () => {
    const p3 = { ...project, counts: { inbox: 2, inboxUnread: 1 }, initiative: { ...project.initiative, desktopNotifications: true, digestHour: 7 } }
    const draft = autonomyDraft(p3)
    expect(draft).toMatchObject({ reach: true, desktopNotifications: true, digestHour: '7' })
    expect(autonomyPayload(draft).initiative).toMatchObject({ desktopNotifications: true, digestHour: 7 })
    expect(autonomyPayload({ ...draft, desktopNotifications: false, digestHour: '25' }).initiative).toMatchObject({ desktopNotifications: false, digestHour: 9 })
    expect(autonomyPayload(autonomyDraft(project)).initiative).not.toHaveProperty('desktopNotifications')
  })
  it('labels durations', () => { expect(durationLabel(0)).toBe('不设最短间隔'); expect(durationLabel(3600000)).toBe('1 小时'); expect(durationLabel(90000)).toBe('90 秒') })
})

describe('judgment', () => {
  it('ignores legacy per-point modes and the backend; sends only user settings', () => {
    const draft = judgmentDraft({ mode: 'off', apiKeyConfigured: false, backend: 'llm', modes: { 'chat.route': 'off', 'delivery.reach': 'shadow' } })
    expect(draft).toEqual({ apiKey: '', fastModel: '', autoModel: false })
    const body = judgmentPayload({ ...draft, apiKey: 'k' })
    expect(body).toEqual({ fastModel: null, autoModel: false, apiKey: 'k' })
    for (const key of ['mode', 'modes', 'backend', 'llmModel']) expect(body).not.toHaveProperty(key)
  })
})

describe('maintenance display', () => {
  it('classifies operations', () => {
    expect(maintenanceTerminal(null)).toBe(true)
    expect(maintenanceTerminal({ phase: 'draining' })).toBe(false)
    expect(maintenanceCancellable({ phase: 'waiting_idle' })).toBe(true)
    expect(maintenanceOperationDisplay({ kind: 'apply', phase: 'completed', summary: 'ok\u0007' })).toMatchObject({ title: '更新应用 · 已完成', summary: 'ok' })
  })
  it('formats attempt history', () => {
    const text = formatMaintenanceAttemptHistory({ attemptCount: 2, attempts: [{ number: 2, status: 'completed', elapsedMs: 1500, stages: [{ name: 'stop', status: 'failed', elapsedMs: 200, failureType: 'timeout' }, { name: 'unknown' }] }] })
    expect(text.split('\n')).toEqual(['已记录 2 次执行，展示最近 1 次；接续核对不会重复发出启动请求。', '第 2 次 · 完成 · 1.5 秒', '  关闭原服务 · 未完成 · 0.2 秒', '    失败类型：timeout'])
  })
})

describe('memory display', () => {
  it('pages and labels like the legacy browser', () => {
    const page = memoryPageDisplay({ view: 'recent', offset: 20, limit: 20, hasMore: true, nextOffset: 40, entries: [{ uri: 'a' }] })
    expect(page).toMatchObject({ previousOffset: 0, nextOffset: 40, label: '第 21–21 个文件 · 还有更多' })
  })
  it('titles hashed files and maps errors', () => {
    expect(memoryDisplayTitle({ uri: 'x', title: '3f2a9c1e4b5d6a7f8e9d0c1b2a3f4e5d.md', kind: 'resource' })).toBe('项目资料 · 3f2a9c1e')
    expect(memoryError(new Error('HTTP 401'))).toContain('访问凭据')
    expect(relativeMemoryPath('viking://resources/projects/p/a/b.md', 'viking://resources/projects/p')).toBe('a/b.md')
  })
  it('projects assistant reports only when provenance matches', () => {
    const raw = `# 项目执行资料：助手主动交付\n\n## 原始来源的有界投影\n\n${JSON.stringify({ kind: 'autonomous_delivery', itemId: 'i1', sourceRole: 'assistant', text: '报告正文' })}`
    expect(memoryReadableDocument(raw, { uri: 'u', provenance: { kind: 'autonomous_delivery', role: 'assistant', itemId: 'i1' } })).toMatchObject({ kind: 'assistant-report', text: '报告正文' })
    expect(memoryReadableDocument(raw, { uri: 'u', provenance: { kind: 'autonomous_delivery', role: 'assistant', itemId: 'other' } }).kind).toBe('document')
  })
})

describe('install + web tools payloads', () => {
  it('builds capability install bodies', () => {
    expect(installInput({ ...emptyInstallDraft(), source: 'git-skill', repository: ' r ', ref: 'abc' })).toEqual({ activate: true, reason: '通过当前项目的技能与工具面板安装', kind: 'skill', source: { type: 'git', repository: 'r', subdirectory: '.', ref: 'abc' } })
    expect(installInput({ ...emptyInstallDraft(), source: 'npm-mcp', packageName: 'pkg', args: 'a\n\n b' })).toMatchObject({ kind: 'mcp', toolPermission: 'exec', source: { type: 'npm', package: 'pkg', args: ['a', ' b'] } })
    expect(() => installInput({ ...emptyInstallDraft(), source: 'mcp-json', json: '{' })).toThrow('MCP 配置不是有效 JSON')
  })
  it('web tools: env var wins over a typed key', () => {
    expect(webToolsSettingsPayload({ enabled: true, baseUrl: ' u ', timeoutSeconds: '2.5', apiKeyEnv: 'E', apiKey: 'k' })).toEqual({ webTools: { enabled: true, baseUrl: 'u', timeoutMs: 2500, apiKeyEnv: 'E' } })
    expect(webToolsSettingsPayload({ enabled: false, baseUrl: 'u', timeoutSeconds: '30', apiKeyEnv: '', apiKey: 'k' }).webTools).toMatchObject({ apiKey: 'k' })
  })
})
