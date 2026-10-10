import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { MotionGlobalConfig } from 'motion/react'
import type { DecisionKernelConfig, ModelSpec, ProviderConfig } from '@/api/panels-types'
import { getTransport, setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { TopBar } from '@/components/shell/TopBar'
import { RhythmCard } from '@/components/views/RhythmCard'
import { formFromProvider, providerBody } from './model-catalog'
import { checkJudgmentKey, decisionEntryDisplay, judgmentStatus, keyCheckStatus, pointEffectOf, pointLabel, questionLabel, reasonLabel, unscoredReasonsLine } from './judgment'
import { takeSettingsHandoff, useRegistered, useSettingsProject } from './SettingsDialog'
import { openSettings, usePanels } from './panel-store'
import { purposeName } from './sections/UsageSection'
import ModelsSection, { reasoningSourceNote, thinkingSwitch, withThinkingOff } from './sections/ModelsSection'
import { useConfiguration } from './config-store'
import { usePreferences } from './preferences'
import MemorySection from './sections/MemorySection'
import WebToolsSection from './sections/WebToolsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true
// Radix measures popper content and selects.
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
/** Render into a fresh root; returns the host element, a re-render and an unmount. */
async function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const render = async (next: typeof element) => { await act(async () => { root.render(createElement(Tooltip.Provider, null, next)) }); await flush() }
  await render(element)
  return { host, render, unmount: () => { act(() => root.unmount()); host.remove() } }
}

// UX audit 2026-10-03, settings team.
describe('credentials (F67)', () => {
  it('environment mode with no variable name leaves a saved key alone', () => {
    const provider = { id: 'p', name: 'X', protocol: 'openai', baseUrl: 'https://x', apiKeyEnv: '', apiKeyConfigured: true, models: [] } as unknown as ProviderConfig
    const body = providerBody({ ...formFromProvider(provider), credentialMode: 'env', apiKeyEnv: '  ' })
    expect(body).not.toHaveProperty('apiKey')
    expect(body).not.toHaveProperty('apiKeyEnv')
    expect(providerBody({ ...formFromProvider(provider), credentialMode: 'env', apiKeyEnv: 'MY_KEY' })).toMatchObject({ apiKeyEnv: 'MY_KEY', apiKey: '' })
    expect(providerBody({ ...formFromProvider(provider), credentialMode: 'none' })).toMatchObject({ apiKeyEnv: '', apiKey: '' })
  })
})

describe('JEV key that does not work (F66)', () => {
  const ready: DecisionKernelConfig = { backend: 'typesafe', status: 'ready', apiKeyConfigured: true }
  it('a refused key is a warning, not the green "enabled" line', () => {
    expect(judgmentStatus(ready).tone).toBe('success')
    expect(judgmentStatus({ ...ready, credential: { state: 'invalid', reason: 'auth' } } as DecisionKernelConfig)).toMatchObject({ tone: 'danger' })
    expect(judgmentStatus({ ...ready, credential: { state: 'invalid' } } as DecisionKernelConfig).text).toMatch(/JEV 密钥无效/)
    expect(judgmentStatus({ ...ready, credential: { state: 'payment_required' } } as DecisionKernelConfig).tone).toBe('warning')
    expect(judgmentStatus({ ...ready, credential: { state: 'valid' } } as DecisionKernelConfig).tone).toBe('success')
  })
  it('checks a saved key with one probe call and words the result for the save bar', async () => {
    const original = getTransport(), calls: unknown[] = []
    let reply: () => Promise<unknown> = async () => ({ status: 401, credential: { state: 'invalid' } })
    setTransport({ ...original, kind: 'mock', request: async (path: string, init?: unknown) => { calls.push([path, init]); return reply() } } as Transport)
    try {
      expect(await checkJudgmentKey()).toBe('invalid')
      expect(calls[0]).toEqual(['/api/v2/decision-kernel/probe', { method: 'POST', body: { check: 'credential' } }])
      reply = async () => ({ status: 200, credential: { state: 'valid' } }); expect(await checkJudgmentKey()).toBe('valid')
      reply = async () => { throw new ApiError('只能包含 state 与 questions', 400) }; expect(await checkJudgmentKey()).toBe('unsupported')
      reply = async () => { throw new ApiError('JEV 不可达：network', 502) }; expect(await checkJudgmentKey()).toBe('unreachable')
      reply = async () => { throw new ApiError('无法连接本地服务，请稍后重试。', 0) }; expect(await checkJudgmentKey()).toBe('unreachable')
    } finally { setTransport(original) }
    expect(keyCheckStatus('invalid')).toMatchObject({ tone: 'error' })
    expect(keyCheckStatus('valid')).toMatchObject({ tone: 'saved', text: '已保存 JEV 设置 · 密钥可用' })
    expect(keyCheckStatus('unsupported')).toEqual({ text: '已保存 JEV 设置', tone: 'saved' })
  })
  it('says "can\'t reach JEV" only when JEV or the host could not be reached', async () => {
    const original = getTransport()
    let reply: () => Promise<unknown> = async () => { throw new ApiError('探针需要已配置的 JEV（TypeSafe）凭据', 409, 'jev_unavailable') }
    setTransport({ ...original, kind: 'mock', request: async () => reply() } as Transport)
    try {
      // No TypeSafe judge to ask (the fast model judges): saved, nothing to say about a key.
      expect(await checkJudgmentKey()).toBe('unchecked')
      // JEV answered, with an error that says nothing about the key.
      reply = async () => ({ status: 500, credential: { state: 'unverified' } }); expect(await checkJudgmentKey()).toBe('unchecked')
      reply = async () => ({ status: 400, credential: { state: 'unverified' } }); expect(await checkJudgmentKey()).toBe('unchecked')
      reply = async () => { throw new ApiError('内部错误', 500) }; expect(await checkJudgmentKey()).toBe('unchecked')
    } finally { setTransport(original) }
    expect(keyCheckStatus('unchecked')).toEqual({ text: '已保存 JEV 设置', tone: 'saved' })
  })
})

describe('reasoning levels the host fixes (F68)', () => {
  const spec = (reasoningCapability: Record<string, unknown>) => ({ id: 'm', reasoningCapability }) as unknown as ModelSpec
  const fixed = '档位由这家供应商的接口固定，自动维护；这里只能选是否允许关闭思考。'
  it('reads as read-only with a reason for catalog, listing and protocol-fixed levels, editable otherwise', () => {
    expect(reasoningSourceNote(spec({ source: 'preset', control: 'effort', efforts: [], canDisable: true }))).toMatch(/已核对的模型规格/)
    expect(reasoningSourceNote(spec({ source: 'discovery', control: 'effort', efforts: [], canDisable: true }))).toMatch(/供应商的模型列表/)
    // qwen/toggle thinking: only on/off, whatever levels are typed.
    expect(reasoningSourceNote(spec({ source: 'protocol', control: 'toggle', efforts: [{ id: 'high' }], canDisable: true, providerDefault: null }))).toBe(fixed)
    // api.deepseek.com: the host names the provider's own levels and default.
    expect(reasoningSourceNote(spec({ source: 'protocol', control: 'effort', efforts: [{ id: 'high' }, { id: 'max' }], canDisable: false, providerDefault: 'high' }))).toBe(fixed)
    // Levels inferred from what was typed stay editable.
    expect(reasoningSourceNote(spec({ source: 'protocol', control: 'effort', efforts: [{ id: 'low' }], canDisable: true, providerDefault: null }))).toBeNull()
    expect(reasoningSourceNote({ id: 'm' })).toBeNull()
  })
  it('protocol-fixed levels keep the one choice the host still reads: whether thinking can be turned off (round 2)', () => {
    // host inferred(): canDisable = the typed list includes 'off', for toggle and DeepSeek alike; catalog and listing ignore it.
    expect(thinkingSwitch(spec({ source: 'protocol', control: 'toggle', efforts: [{ id: 'high' }], canDisable: false, providerDefault: null }))).toBe(true)
    expect(thinkingSwitch(spec({ source: 'protocol', control: 'effort', efforts: [{ id: 'high' }, { id: 'max' }], canDisable: true, providerDefault: 'high' }))).toBe(true)
    expect(thinkingSwitch(spec({ source: 'preset', control: 'toggle', efforts: [], canDisable: true }))).toBe(false)
    expect(thinkingSwitch(spec({ source: 'protocol', control: 'effort', efforts: [{ id: 'low' }], canDisable: true, providerDefault: null }))).toBe(false)
    expect(withThinkingOff('high, max', true)).toBe('high, max, off')
    expect(withThinkingOff('high, off, max', false)).toBe('high, max')
    expect(withThinkingOff('high,off', true)).toBe('high, off')
  })
  it('the provider editor shows a fixed model\'s levels read-only and lets the user allow turning thinking off', async () => {
    const capability = { source: 'protocol', control: 'toggle', efforts: [{ id: 'high', label: '开启思考' }], canDisable: false, providerDefault: null }
    const provider = { id: 'q', name: 'Qwen', protocol: 'openai', baseUrl: 'https://llm.example/v1', authMode: 'api_key', apiKeyConfigured: true, apiKeyEnv: '',
      models: [{ id: 'qwen-x', name: 'qwen-x', contextWindow: 131072, maxOutputTokens: 8192, reasoning: ['high'], reasoningCapability: capability, compat: { thinkingFormat: 'qwen' } }] }
    useConfiguration.setState({ value: { providers: [provider], providerPresets: [], runtime: { modelExecution: 'rna' }, defaultModel: null, media: {} } as never })
    const view = await mount(createElement(ModelsSection, { projectId: null, setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose: () => true }))
    try {
      await act(async () => { [...view.host.querySelectorAll('button')].find(b => b.textContent === '管理')!.click() }); await flush()
      const levels = [...view.host.querySelectorAll('input')].find(input => input.readOnly)!
      const off = () => [...view.host.querySelectorAll('label')].find(label => label.textContent === '允许关闭思考')!.querySelector('input')!
      expect(levels.value).toBe('high')
      expect(off().checked).toBe(false)
      await act(async () => { off().click() }); await flush()
      expect(off().checked).toBe(true)
      expect(levels.value).toBe('high')
      expect(view.host.textContent).toContain('这里只能选是否允许关闭思考')
    } finally { view.unmount(); useConfiguration.setState({ value: null }) }
  })
})

describe('judgment names (F70, F74)', () => {
  const points = [{ point: 'mind.judge', title: '项目心智判断' }, { point: 'schedule.suggest', title: '日程建议' }]
  it('names ledger rows by the host title and never shows a raw id', () => {
    expect(pointLabel('mind.judge', points)).toBe('项目心智判断')
    expect(pointLabel('initiative.review', [])).toBe('主动协作')
    expect(pointLabel('tool.constraint', [])).toBe('其他判断')
    expect(pointLabel(undefined, [])).toBe('选项评分')
  })
  it('template judgments are current records, not legacy ones', () => {
    const row = decisionEntryDisplay({ point: 'schedule.suggest', source: 'judge', reason: 'accepted', disposition: 'schedule_suggest' })
    expect(row).toMatchObject({ template: true, source: 'JEV 判断', reason: '已采用判断', disposition: '' })
    expect(decisionEntryDisplay({ point: 'mind.judge', source: 'judge', reason: 'accepted', disposition: 'mind_reconcile' }).disposition).toBe('核对待办与承诺')
    // A plan-based point without its plan revision is still the old record it was.
    expect(decisionEntryDisplay({ point: 'initiative.review', source: 'judge', reason: 'accepted' }).source).toBe('JEV 历史记录')
  })
  it('labels calibration questions, an unknown one by its position', () => {
    expect(questionLabel('needs_memory', 0)).toBe('需要项目记忆')
    expect(questionLabel('needed_3', 2)).toBe('判断项 3')
  })
  it('names ledger reasons and counts every unnamed one once under 其他原因', () => {
    expect(unscoredReasonsLine({ plan_paused: 2, judged_idle: 1, response_limit: 1 })).toBe('判断为暂缓，等有新情况再看 2 · 判断为暂时没有要做的事 1 · 评分结果过大，没有采用 1')
    expect(unscoredReasonsLine({ brand_new_reason: 3, timeout: 1, another_new: 2 })).toBe('选项评分超时，主流程继续 1 · 其他原因 5')
    // Two reasons with one name read as one entry.
    expect(unscoredReasonsLine({ invalid_request: 1, bad_request: 2 })).toBe('评分请求未完成 3')
  })
  // L7: the rows the host writes by rule (no judge asked) read by what happened, never as 已记录选项评分结果, in both languages.
  it('names every reason the host decision service writes on its own rows, and the work-in-progress question', () => {
    const src = readFileSync(join(__dirname, '../../../../decision-service.mjs'), 'utf8'), written = new Set<string>()
    for (const line of src.split('\n')) if (/this\.record\(|networkAttempted: false/.test(line)) for (const m of line.matchAll(/reason: '([a-z_]+)'/g)) written.add(m[1])
    for (const m of src.slice(src.indexOf('  bypassSignal('), src.indexOf('  recordBypass(')).matchAll(/return '([a-z_]+)'/g)) written.add(`bypass_${m[1]}`)
    for (const m of src.matchAll(/recordBypass\(point, project, '([a-z_]+)'/g)) written.add(`bypass_${m[1]}`)
    expect([...written]).toEqual(expect.arrayContaining(['foreground_lease', 'bypass_pending_review', 'bypass_commitment_overdue', 'nothing_actionable']))
    try {
      for (const language of ['zh', 'en'] as const) {
        usePreferences.setState({ language })
        expect([...written].filter(reason => reasonLabel(reason, '∅') === '∅')).toEqual([])
        expect(questionLabel('in_progress_covers', 4)).not.toMatch(/判断项|Question \d|in_progress/)
      }
      expect(reasonLabel('foreground_lease')).toBe('A conversation reply is in progress; review after it ends')
    } finally { usePreferences.setState({ language: 'zh' }) }
    expect(reasonLabel('bypass_commitment_overdue')).toBe('答应你的事已逾期，直接进入主模型复查')
    expect(questionLabel('in_progress_covers', 4)).toBe('新情况属于正在进行的工作')
  })
})

describe('usage purposes (F69)', () => {
  it('names every purpose the host records and never shows an internal id', () => {
    expect(['background-work', 'evaluation', 'skill-foundation', 'other', 'jev'].map(purposeName)).toEqual(['后台工作', '版本评测', '基础技能准备', '其他用途', 'JEV 判断'])
    expect(purposeName('gene-summary')).toBe('其他用途')
    expect(purposeName('toString')).toBe('其他用途')
  })
  it('names the purposes split out of 其他用途 (narrator, mind, evolution)', () => {
    expect(['narrator', 'mind', 'evolution'].map(purposeName)).toEqual(['消息改写', '项目心智', '自进化'])
    usePreferences.setState({ language: 'en' })
    try { expect(['narrator', 'mind'].map(purposeName)).toEqual(['Message rewrites', 'Project mind']) } finally { usePreferences.setState({ language: 'zh' }) }
  })
})

describe('internal reasoning effort (spec p1 effort §3.8)', () => {
  const glm = { id: 'g', name: 'GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', authMode: 'coding_plan', apiKeyConfigured: true, apiKeyEnv: '',
    models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxOutputTokens: 32768, reasoning: ['low', 'high', 'max'], reasoningCapability: { source: 'preset', control: 'effort', efforts: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }, { id: 'max', label: '最大' }], canDisable: false, providerDefault: null } }] }
  const configure = (internalReasoning?: object) => useConfiguration.setState({ value: { providers: [glm], providerPresets: [], runtime: { modelExecution: 'rna' }, defaultModel: { providerId: 'g', modelId: 'glm-5.3', reasoning: 'max' }, media: {}, ...(internalReasoning ? { internalReasoning } : {}) } as never })
  it('offers automatic (default) and same-as-chat, and says a GLM-like default records JEV choices only', async () => {
    configure()
    const view = await mount(createElement(ModelsSection, { projectId: null, setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose: () => true }))
    try {
      expect(view.host.textContent).toContain('后台与内部调用的推理强度')
      expect(view.host.textContent).toContain('自动（推荐）')
      expect(view.host.textContent).toContain('JEV 的选择目前只记录')
    } finally { view.unmount(); useConfiguration.setState({ value: null }) }
  })
  it('shows no recorded-only note once routing is enabled, names what is sent, and renders in English', async () => {
    configure({ mode: 'auto', routing: 'route', capture: false, purposes: ['decision'] })
    usePreferences.setState({ language: 'en' })
    const view = await mount(createElement(ModelsSection, { projectId: null, setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose: () => true }))
    try {
      expect(view.host.textContent).toContain('Reasoning effort of background and internal calls')
      expect(view.host.textContent).toContain('Automatic (recommended)')
      expect(view.host.textContent).not.toContain('recorded only for now')
      expect(view.host.textContent).toContain('the validated uses (Proactive decisions) send JEV\'s choice; every other internal call is recorded only')
    } finally { view.unmount(); useConfiguration.setState({ value: null }); usePreferences.setState({ language: 'zh' }) }
  })
  it('judgment settings: the effort points say whether GLM-like models send the chosen level, by the routing setting (review EFF-8)', () => {
    const effect = (point: string, internal?: object | null) => pointEffectOf({ point, effect: '' }, internal as never)
    expect(effect('effort.decision')).toContain('目前只记录')
    expect(effect('effort.decision', { routing: 'shadow', purposes: ['decision', 'narrator'] })).toContain('目前只记录')
    expect(effect('effort.decision', { routing: 'route', purposes: ['decision', 'narrator'] })).toContain('也按所选档位发送')
    expect(effect('effort.decision', { routing: 'route' })).toContain('也按所选档位发送')
    expect(effect('effort.narrator', { routing: 'route', purposes: ['decision'] })).toContain('目前只记录')
    expect(effect('effort.narrator', { routing: 'route', purposes: ['narrator'] })).toContain('也按所选档位发送')
    expect(effect('effort.work', { routing: 'route', purposes: ['decision', 'narrator'] })).toContain('目前只记录')
    expect(effect('effort.compaction', { routing: 'route' })).toContain('目前只记录')
    usePreferences.setState({ language: 'en' })
    try {
      expect(effect('effort.decision', { routing: 'route' })).toContain('also send the chosen level')
      expect(effect('effort.decision')).toContain('recorded only')
      expect(effect('effort.work', { routing: 'route' })).toContain('until background work has its own replay validation')
    } finally { usePreferences.setState({ language: 'zh' }) }
  })
})

describe('settings panel (F5, F61)', () => {
  afterEach(() => { usePanels.setState({ settings: null, projectSettings: null, memory: null }) })
  it('opens on the project whose panel handed off to it', async () => {
    usePanels.setState({ projectSettings: { projectId: 'B', tab: 'settings' } })
    usePanels.setState({ projectSettings: null }); openSettings('autonomy')
    expect(takeSettingsHandoff()).toBe('B')
    expect(takeSettingsHandoff()).toBeNull()
    // A later opening (another click) starts on the selected project again.
    await Promise.resolve()
    usePanels.setState({ settings: null }); openSettings('memory')
    expect(takeSettingsHandoff()).toBeNull()
  })
  it('picks the opening\'s project before any section renders (no flash of the previous one)', async () => {
    useApp.setState({ selectedProjectId: 'A' })
    const seen: (string | null)[] = []
    let pick: (id: string) => void = () => {}
    const Section = ({ projectId }: { projectId: string | null }) => { seen.push(projectId); return null }
    const Probe = ({ open }: { open: boolean }) => { const [projectId, setProjectId] = useSettingsProject(open); pick = setProjectId; return open ? createElement(Section, { projectId }) : null }
    const view = await mount(createElement(Probe, { open: true }))
    expect(seen).toEqual(['A'])
    // The user switches to C in this opening, then closes settings.
    await act(async () => { pick('C') })
    expect(seen.at(-1)).toBe('C')
    await view.render(createElement(Probe, { open: false }))
    // Reopened from project B's panel: every section render is B, never C first.
    seen.length = 0
    usePanels.setState({ settings: null, projectSettings: { projectId: 'B', tab: 'settings' } })
    usePanels.setState({ projectSettings: null }); openSettings('autonomy')
    await view.render(createElement(Probe, { open: true }))
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['B']))
    // A plain reopening starts on the selected project.
    await view.render(createElement(Probe, { open: false }))
    await Promise.resolve()
    seen.length = 0
    usePanels.setState({ settings: null }); openSettings('memory')
    await view.render(createElement(Probe, { open: true }))
    expect(new Set(seen)).toEqual(new Set(['A']))
    view.unmount()
  })
  it('「打开项目记忆」 leaves through the same guarded close (stays when a draft is kept)', async () => {
    useApp.setState({ projects: { p: { id: 'p', name: 'P' } as never } })
    const requestClose = vi.fn(() => false)
    const props = { projectId: 'p', setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose }
    const view = await mount(createElement(MemorySection, props))
    const button = () => [...view.host.querySelectorAll('button')].find(b => b.textContent?.startsWith('打开项目记忆'))!
    await act(async () => { button().click() })
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(usePanels.getState().memory).toBeNull()
    requestClose.mockReturnValue(true)
    await act(async () => { button().click() })
    expect(usePanels.getState().memory).toEqual({ projectId: 'p' })
    view.unmount()
  })
  it('a typed web-tools draft keeps settings from closing silently (F64)', async () => {
    const registerDirty = vi.fn(), registerBusy = vi.fn()
    const view = await mount(createElement(WebToolsSection, { projectId: null, setProjectId: () => {}, registerBusy, registerDirty, requestClose: () => true }))
    expect(registerDirty).toHaveBeenLastCalledWith('webtools', false)
    const input = view.host.querySelector('input[type="url"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://example.test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(registerDirty).toHaveBeenLastCalledWith('webtools', true)
    view.unmount()
    expect(registerDirty).toHaveBeenLastCalledWith('webtools', false)
    expect(registerBusy).toHaveBeenLastCalledWith('webtools', false)
  })
  it('an unmounted editor clears its busy flag', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const register = vi.fn(), root = createRoot(document.createElement('div'))
    const Editor = ({ busy }: { busy: boolean }) => { useRegistered(register, 'provider-editor', busy); return null }
    act(() => root.render(createElement(Editor, { busy: true })))
    expect(register).toHaveBeenLastCalledWith('provider-editor', true)
    act(() => root.unmount())
    expect(register).toHaveBeenLastCalledWith('provider-editor', false)
  })
})

describe('emergency stop from the top bar (F62, contract C-h)', () => {
  afterEach(() => { useUi.setState({ toasts: [] }) })
  it('asks the same second step as settings before stopping; releasing says project initiative is back', async () => {
    const original = getTransport(), calls: unknown[] = []
    setTransport({ ...original, kind: 'mock', request: async (path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST') { calls.push([path, init.body]); return {} }
      if (path === '/api/v2/bootstrap') return { emergency: calls.length % 2 === 1 }
      throw new ApiError('offline', 503)
    } } as Transport)
    useApp.setState({ status: 'ready', projects: {}, sessionIndex: {}, sessions: {}, selectedSessionId: null, selectedProjectId: null, emergency: false })
    const view = await mount(createElement(TopBar))
    const menuItem = async (label: string) => {
      const trigger = view.host.querySelector('button[aria-label="更多"]') as HTMLButtonElement
      await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }); await flush()
      return [...document.querySelectorAll('[role="menuitem"]')].find(row => row.textContent === label) as HTMLElement
    }
    try {
      await act(async () => { (await menuItem('全局急停…')).click() }); await flush()
      expect(calls).toEqual([])
      expect(document.body.textContent).toContain('确认后会立即停下：所有正在运行的对话、后台工作、各项目的主动协作和定时交付。草稿、队列和进度都会保留。')
      const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === '确认急停') as HTMLButtonElement
      await act(async () => { confirm.click() }); await flush()
      expect(calls).toEqual([['/api/emergency', { stop: true }]])
      expect(useApp.getState().emergency).toBe(true)
      expect(useUi.getState().toasts.map(row => row.text)).toContain('急停已开启。解除后，因急停关闭的主动协作和定时交付会自动恢复；暂停的会话需要你手动继续。')
      // Releasing is one step and says what came back.
      await act(async () => { (await menuItem('解除急停')).click() }); await flush()
      expect(calls).toEqual([['/api/emergency', { stop: true }], ['/api/emergency', { stop: false }]])
      expect(useApp.getState().emergency).toBe(false)
      expect(useUi.getState().toasts.map(row => row.text)).toContain('急停已解除。因急停关闭的主动协作和定时交付已恢复；暂停的会话可按需手动继续。')
    } finally { view.unmount(); setTransport(original) }
  })
})

describe('background blocker in the rhythm card (F79)', () => {
  it('names the cause in plain words, never the raw codes', async () => {
    const project = { id: 'p', name: 'P', initiative: { enabled: true }, rhythmStatus: { control: 'auto', initiative: {}, evolution: {}, schedule: {} },
      initiativeRuntime: { availability: { state: 'blocked', reason: 'session_cleanup_pending', details: { pendingCount: 2, attempts: 1, codes: ['SESSION_EVIDENCE_SCAN_LIMIT'] } } } }
    const view = await mount(createElement(RhythmCard, { project: project as never, compact: true }))
    const summary = view.host.querySelector('summary') as HTMLElement | null
    if (summary) await act(async () => { summary.click() })
    expect(view.host.textContent).toContain('当前后台阻塞')
    expect(view.host.textContent).toContain('关联记录较多，正在分批清理')
    expect(view.host.textContent).not.toContain('SESSION_')
    view.unmount()
  })
})
