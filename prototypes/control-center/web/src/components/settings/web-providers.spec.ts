import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { MotionGlobalConfig } from 'motion/react'
import type { WebToolProvider } from '@/api/panels-types'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import { useConfiguration } from './config-store'
import WebToolsSection, { webToolProviderOf, webToolsCheckMessage, webToolsSettingsPayload, webToolsSettingsStatus } from './sections/WebToolsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(Tooltip.Provider, null, element)) }); await flush()
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

// The search services as the daemon lists them (GET /api/configuration → webToolProviders).
const catalog: WebToolProvider[] = [
  { id: 'fastcrw', label: 'FastCRW', baseUrl: 'https://api.fastcrw.com', key: 'optional', reader: 'service' },
  { id: 'firecrawl', label: 'Firecrawl', baseUrl: 'https://api.firecrawl.dev', key: 'optional', reader: 'service' },
  { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com', key: 'required', reader: 'service' },
  { id: 'brave', label: 'Brave Search', baseUrl: 'https://api.search.brave.com', key: 'required', reader: 'direct' },
]
const brave = catalog[3], fastcrw = catalog[0]
const props = { projectId: null, setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose: () => true }
const configure = (webTools: object, webToolProviders?: WebToolProvider[]) => useConfiguration.setState({ value: { providers: [], providerPresets: [], runtime: { modelExecution: 'rna' }, defaultModel: null, media: {}, webTools, ...(webToolProviders ? { webToolProviders } : {}) } as never })
const card = (host: HTMLElement, id: string) => host.querySelector(`[data-choice-group="web-provider"] [data-choice="${id}"]`) as HTMLButtonElement
const address = (host: HTMLElement) => (host.querySelector('input[type="url"]') as HTMLInputElement).value

describe('search service choice: what is sent and what is said', () => {
  it('the chosen service goes with the save; a daemon without a list is sent none', () => {
    expect(webToolsSettingsPayload({ enabled: true, provider: 'brave', baseUrl: ' https://api.search.brave.com ', timeoutSeconds: '30', apiKeyEnv: '', apiKey: 'k' }))
      .toEqual({ webTools: { enabled: true, provider: 'brave', baseUrl: 'https://api.search.brave.com', timeoutMs: 30000, apiKeyEnv: '', apiKey: 'k' } })
    expect(webToolsSettingsPayload({ enabled: true, baseUrl: 'u', timeoutSeconds: '30', apiKeyEnv: '', apiKey: '' }).webTools).not.toHaveProperty('provider')
    expect(webToolProviderOf(catalog, 'brave')).toBe(brave)
    expect(webToolProviderOf(catalog, undefined)).toBe(fastcrw)
    expect(webToolProviderOf(catalog, 'retired-service')).toBe(fastcrw)
    expect(webToolProviderOf(undefined, 'brave').id).toBe('fastcrw')
  })
  it('a service that needs a key says so while none is saved', () => {
    expect(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: false }, brave)).toBe('已开启 · Brave Search 需要访问密钥，尚未配置；配置前搜索不可用。')
    expect(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: false }, fastcrw)).toMatch(/免认证服务可直接检查连接/)
    expect(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: true }, brave)).toMatch(/所有项目与会话共用/)
    expect(webToolsSettingsStatus({ enabled: false }, brave)).toMatch(/已关闭/)
  })
  it('a failed check is explained from its typed code, never from the service\'s own prose', () => {
    const failed = (code: string, tool = 'web_search') => ({ ok: false, code, checks: tool === 'web_fetch' ? [{ tool: 'web_search', ok: true }, { tool, ok: false, code }] : [{ tool, ok: false, code }] })
    expect(webToolsCheckMessage(failed('WEB_AUTH'), { apiKeyConfigured: false }, brave)).toBe('Brave Search 需要访问密钥，请先填写并保存。')
    expect(webToolsCheckMessage(failed('WEB_AUTH'), { apiKeyConfigured: true }, brave)).toBe('服务拒绝了访问密钥，请检查密钥是否正确。')
    expect(webToolsCheckMessage(failed('FASTCRW_AUTH'), { apiKeyConfigured: false }, fastcrw)).toBe('服务拒绝了访问密钥，请检查密钥是否正确。')
    expect(webToolsCheckMessage(failed('WEB_QUOTA'))).toMatch(/额度已用完/)
    expect(webToolsCheckMessage(failed('FASTCRW_RATE_LIMIT'))).toMatch(/过于频繁/)
    expect(webToolsCheckMessage(failed('WEB_TARGET_FAILED', 'web_fetch'))).toBe('搜索正常，但读取网页未通过；可稍后再检查。')
    expect(webToolsCheckMessage(failed('WEB_NETWORK'))).toBe('连接检查未通过，请检查服务地址和凭据。')
    expect(webToolsCheckMessage({ ok: false })).toBe('连接检查未通过，请检查服务地址和凭据。')
  })
})

describe('search service cards', () => {
  it('choosing a service shows its address and an empty key; saving sends the service, and going back restores what is saved', async () => {
    configure({ enabled: true, provider: 'fastcrw', baseUrl: 'https://crw.example.test', timeoutMs: 30000, apiKeyEnv: '', apiKeyConfigured: true }, catalog)
    const original = getTransport(), calls: [string, { method?: string; body?: unknown } | undefined][] = []
    setTransport({ ...original, kind: 'mock', request: async (path: string, init?: { method?: string; body?: { webTools: Record<string, unknown> } }) => {
      calls.push([path, init])
      if (path === '/api/web-tools/test') return { ok: false, provider: 'brave', code: 'WEB_AUTH', checks: [{ tool: 'web_search', ok: false, code: 'WEB_AUTH' }] }
      return { ...useConfiguration.getState().value, webTools: { enabled: true, provider: init!.body!.webTools.provider, baseUrl: init!.body!.webTools.baseUrl, timeoutMs: 30000, apiKeyEnv: '', apiKeyConfigured: false } }
    } } as Transport)
    const view = await mount(createElement(WebToolsSection, props))
    try {
      expect([...view.host.querySelectorAll('[data-choice-group="web-provider"] [data-choice]')].map(node => node.getAttribute('data-choice'))).toEqual(['fastcrw', 'firecrawl', 'tavily', 'brave'])
      expect(card(view.host, 'fastcrw').getAttribute('aria-checked')).toBe('true'); expect(card(view.host, 'fastcrw').textContent).toContain('当前')
      expect(address(view.host)).toBe('https://crw.example.test')
      await act(async () => { card(view.host, 'brave').click() })
      expect(card(view.host, 'brave').getAttribute('aria-checked')).toBe('true'); expect(card(view.host, 'fastcrw').textContent).toContain('当前')
      expect(address(view.host)).toBe('https://api.search.brave.com')
      expect(view.host.textContent).toContain('保存后改用 Brave Search。为 FastCRW 保存的密钥会被清除，不会发给新的服务。')
      expect(view.host.textContent).toContain('Brave Search 只提供搜索。读取网页时由本机直接访问目标网站')
      expect((view.host.querySelector('input[type="password"]') as HTMLInputElement).placeholder).toBe('输入访问密钥')
      // Back to the saved service: its saved address, and the saved key stays in place.
      await act(async () => { card(view.host, 'fastcrw').click() })
      expect(address(view.host)).toBe('https://crw.example.test'); expect(view.host.textContent).not.toContain('保存后改用')
      expect((view.host.querySelector('input[type="password"]') as HTMLInputElement).placeholder).toBe('已配置密钥；留空保持不变')
      // Arrow keys move the selection like a radio group.
      await act(async () => { card(view.host, 'tavily').click() })
      await act(async () => { card(view.host, 'tavily').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
      expect(card(view.host, 'brave').getAttribute('aria-checked')).toBe('true'); expect(card(view.host, 'brave').tabIndex).toBe(0); expect(card(view.host, 'tavily').tabIndex).toBe(-1)
      const check = [...view.host.querySelectorAll('button')].find(node => node.textContent === '保存并检查连接') as HTMLButtonElement
      await act(async () => { check.click() }); await flush()
      expect(calls[0]).toEqual(['/api/configuration', { method: 'PATCH', body: { webTools: { enabled: true, provider: 'brave', baseUrl: 'https://api.search.brave.com', timeoutMs: 30000, apiKeyEnv: '' } } }])
      expect(calls[1][0]).toBe('/api/web-tools/test')
      expect(card(view.host, 'brave').textContent).toContain('当前'); expect(card(view.host, 'fastcrw').textContent).not.toContain('当前')
      expect(view.host.textContent).toContain('已开启 · Brave Search 需要访问密钥，尚未配置；配置前搜索不可用。')
      expect(view.host.textContent).toContain('设置已保存，连接检查未完成：Brave Search 需要访问密钥，请先填写并保存。')
    } finally { view.unmount(); setTransport(original); useConfiguration.setState({ value: null }) }
  })
  it('a daemon that lists no services shows the one it has, without a choice', async () => {
    configure({ enabled: false, baseUrl: 'https://api.fastcrw.com', timeoutMs: 30000, apiKeyEnv: '' })
    const view = await mount(createElement(WebToolsSection, props))
    try { expect(view.host.querySelector('[data-choice-group="web-provider"]')).toBeNull(); expect(address(view.host)).toBe('https://api.fastcrw.com') }
    finally { view.unmount(); useConfiguration.setState({ value: null }) }
  })
})
