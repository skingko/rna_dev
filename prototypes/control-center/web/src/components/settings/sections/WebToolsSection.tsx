/**
 * 网页工具: global web search/fetch configuration. Port of
 * public/web-tools-settings-ui.js (save, save + check connection, clear
 * credentials without discarding other unsaved fields), plus the choice of
 * search service: the daemon lists the services, each with its own address
 * and key, and a saved key never follows a change of service.
 */
import { useState, type FormEvent } from 'react'
import { panelsApi } from '@/api/panels'
import type { WebToolProvider, WebToolsCheck, WebToolsConfig } from '@/api/panels-types'
import { Button } from '@/components/ui/primitives'
import { ChoiceCards, Disclosure, Field, FieldRow, FormStatusText, Group, Note, SettingsSection, TextInput, ToggleRow, type FormStatus } from '../form'
import { adoptConfiguration, useConfiguration } from '../config-store'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, type MessageKey } from '@/i18n'

/** The only service of a daemon older than the choice; a newer daemon sends its own list. */
const FASTCRW: WebToolProvider = { id: 'fastcrw', label: 'FastCRW', baseUrl: 'https://api.fastcrw.com', key: 'optional', reader: 'service' }
/** What each service is, in a line. A service this page has no line for is still listed, by its name alone. */
const PROVIDER_HINTS: Record<string, MessageKey> = {
  fastcrw: '搜索并读取网页。可使用自建的兼容服务，免认证的服务不用填密钥。',
  firecrawl: '搜索并读取网页。不填密钥也能用，按 IP 限制次数。',
  tavily: '为 Agent 设计的搜索，可提取网页正文。需要密钥。',
  brave: '独立索引的搜索。只提供搜索，网页由本机直接读取。需要密钥。',
  zhipu: '智谱开放平台的联网搜索与网页阅读。使用智谱 API 密钥。',
  bocha: '博查搜索。只提供搜索，网页由本机直接读取。需要密钥。',
}
export const webToolProviderOf = (catalog: WebToolProvider[] | undefined, id: string | undefined): WebToolProvider => {
  const list = catalog?.length ? catalog : [FASTCRW]
  return list.find(row => row.id === id) ?? list.find(row => row.id === 'fastcrw') ?? list[0]
}

export function webToolsSettingsPayload({ enabled, provider, baseUrl, timeoutSeconds, apiKeyEnv, apiKey }: { enabled: boolean; provider?: string; baseUrl: string; timeoutSeconds: string; apiKeyEnv: string; apiKey: string }) {
  const environment = apiKeyEnv.trim()
  return { webTools: { enabled: Boolean(enabled), ...(provider ? { provider } : {}), baseUrl: baseUrl.trim(), timeoutMs: Math.round(Number(timeoutSeconds) * 1000), apiKeyEnv: environment, ...(apiKey && !environment ? { apiKey } : {}) } }
}
export function webToolsSettingsStatus(config: WebToolsConfig = {}, provider?: WebToolProvider) {
  if (!config.enabled) return t('联网工具已关闭。开启后，所有项目与会话都可按需使用。')
  if (config.apiKeyConfigured) return t('已开启 · 所有项目与会话共用，Agent 按需搜索和读取网页。')
  return provider?.key === 'required' ? t('已开启 · {name} 需要访问密钥，尚未配置；配置前搜索不可用。', { name: provider.label }) : t('已开启 · 尚未配置访问密钥。免认证服务可直接检查连接。')
}
/** Why the connection check did not pass, from its typed result (the service's own prose is written for the model). */
export function webToolsCheckMessage(check: WebToolsCheck = {}, config: WebToolsConfig = {}, provider?: WebToolProvider) {
  const failed = check.checks?.find(row => !row.ok), code = failed?.code ?? check.code ?? ''
  if (/_AUTH$/.test(code)) return provider?.key === 'required' && !config.apiKeyConfigured ? t('{name} 需要访问密钥，请先填写并保存。', { name: provider.label }) : t('服务拒绝了访问密钥，请检查密钥是否正确。')
  if (code === 'WEB_QUOTA') return t('该服务账户的额度已用完，补充额度后再检查。')
  if (/_RATE_LIMIT$/.test(code)) return t('请求过于频繁，请稍后再检查。')
  if (failed?.tool === 'web_fetch' && check.checks?.some(row => row.tool === 'web_search' && row.ok)) return t('搜索正常，但读取网页未通过；可稍后再检查。')
  return t('连接检查未通过，请检查服务地址和凭据。')
}

export default function WebToolsSection({ registerBusy, registerDirty }: SectionProps) {
  const initial = useConfiguration(s => s.value?.webTools) ?? {}
  const catalog = useConfiguration(s => s.value?.webToolProviders)
  const providers = catalog?.length ? catalog : [FASTCRW]
  const [saved, setSaved] = useState<WebToolsConfig>(initial)
  const [enabled, setEnabled] = useState(initial.enabled === true)
  const [provider, setProvider] = useState(webToolProviderOf(catalog, initial.provider).id)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? FASTCRW.baseUrl)
  const [key, setKey] = useState('')
  const [env, setEnv] = useState(initial.apiKeyEnv ?? '')
  const [timeout, setTimeoutValue] = useState(String((initial.timeoutMs ?? 30000) / 1000))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<FormStatus>(null)
  useRegistered(registerBusy, 'webtools', busy)
  useRegistered(registerDirty, 'webtools', dirty)
  const touch = () => { setDirty(true); setStatus({ text: t('有未保存的更改'), tone: 'default' }) }
  const savedProvider = webToolProviderOf(catalog, saved.provider), chosen = webToolProviderOf(catalog, provider), switching = chosen.id !== savedProvider.id
  // Each service has its own address and key: choosing another shows that service's address and an empty key, and
  // going back to the saved one shows what is saved.
  const choose = (id: string) => {
    const next = webToolProviderOf(catalog, id), back = next.id === savedProvider.id
    setProvider(next.id); setBaseUrl(back ? saved.baseUrl ?? next.baseUrl : next.baseUrl); setEnv(back ? saved.apiKeyEnv ?? '' : ''); setKey(''); touch()
  }

  const update = async ({ testConnection = false, clearCredentials = false } = {}, formEl?: HTMLFormElement | null) => {
    if (busy || (!clearCredentials && formEl && !formEl.reportValidity())) return
    const values = clearCredentials ? { webTools: { apiKey: '', apiKeyEnv: '' } } : webToolsSettingsPayload({ enabled, provider: catalog?.length ? chosen.id : undefined, baseUrl, apiKey: key, apiKeyEnv: env, timeoutSeconds: timeout })
    setBusy(true); setStatus({ text: t('正在保存…'), tone: 'default' })
    let persisted = false
    try {
      const result = await panelsApi.patchConfiguration(values)
      const now = result.webTools ?? {}
      setSaved(now); persisted = true
      setKey(''); if (clearCredentials) setEnv('')
      if (!clearCredentials) setDirty(false)
      setStatus({ text: clearCredentials ? t('凭据已清除{v}', { v: dirty ? t('；其他更改尚未保存') : '' }) : t('设置已保存'), tone: 'saved' })
      adoptConfiguration(result)
      if (testConnection) {
        setStatus({ text: t('已保存，正在检查连接…'), tone: 'default' })
        const check = await panelsApi.testWebTools()
        if (check.ok !== true) throw new Error(webToolsCheckMessage(check, now, webToolProviderOf(result.webToolProviders ?? catalog, now.provider)))
        setStatus({ text: t('连接检查通过'), tone: 'saved' })
      }
    } catch (error) {
      setStatus({ text: `${persisted && testConnection ? t('设置已保存，连接检查未完成：') : ''}${(error as Error).message}`, tone: 'error' })
    } finally { setBusy(false) }
  }
  const onSubmit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void update({}, e.currentTarget) }
  const needsKey = saved.enabled === true && !saved.apiKeyConfigured && savedProvider.key === 'required'

  return (
    <SettingsSection title={t('联网搜索与抓取')} description={t('让 Agent 按需搜索资料、读取网页。开启后对所有项目和会话生效，无需逐个分配工具。')}>
      <Note tone={saved.enabled ? (saved.apiKeyConfigured ? 'success' : needsKey ? 'warning' : 'default') : 'default'} className="mb-4">{webToolsSettingsStatus(saved, savedProvider)}</Note>
      <form id="web-tools-form" onSubmit={onSubmit} onChange={touch}>
        <Group>
          <ToggleRow label={t('启用联网工具')} description={t('由 Agent 根据任务需要调用；关闭后不再发起新的搜索或抓取。')} checked={enabled} onChange={v => { setEnabled(v); touch() }} />
        </Group>
        {providers.length > 1 && (
          <div className="mt-4">
            <div className="mb-2 text-[13px] font-medium text-fg">{t('搜索服务')}</div>
            <ChoiceCards name="web-provider" aria-label={t('搜索服务')} columns={3} disabled={busy} value={chosen.id} saved={savedProvider.id} onChange={choose}
              options={providers.map(row => ({ value: row.id, label: row.label, hint: PROVIDER_HINTS[row.id] ? t(PROVIDER_HINTS[row.id]) : undefined }))} />
            {switching && (saved.apiKeyConfigured || saved.apiKeyEnv) && <Note className="mt-2">{t('保存后改用 {name}。为 {previous} 保存的密钥会被清除，不会发给新的服务。', { name: chosen.label, previous: savedProvider.label })}</Note>}
            {chosen.reader === 'direct' && <Note className="mt-2">{t('{name} 只提供搜索。读取网页时由本机直接访问目标网站：不经过搜索服务，也不发送密钥；本机和内网地址不会被读取，靠脚本渲染的页面可能读不到正文。', { name: chosen.label })}</Note>}
          </div>
        )}
        <div className="mt-4 space-y-3">
          <Field label={t('服务地址')} help={chosen.id === 'fastcrw' ? t('支持 FastCRW 兼容服务。') : t('{name} 的官方地址；经代理访问时再修改。', { name: chosen.label })}><TextInput type="url" required maxLength={2000} autoComplete="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></Field>
          <Field label={t('访问密钥')} help={env.trim() ? t('正在使用高级设置中的环境变量。清空变量名后可改为保存密钥。') : t('密钥只写入本机独立凭据文件，读取设置时不会返回。')}>
            <TextInput type="password" autoComplete="new-password" maxLength={8192} disabled={Boolean(env.trim()) || busy} value={key} placeholder={saved.apiKeyConfigured && !switching ? t('已配置密钥；留空保持不变') : chosen.key === 'required' ? t('输入访问密钥') : t('访问密钥（可选）')} onChange={e => setKey(e.target.value)} />
          </Field>
          <Disclosure summary={t('高级设置')}>
            <FieldRow>
              <Field label={t('请求超时（秒）')}><TextInput type="number" min={1} max={120} step={0.001} required value={timeout} onChange={e => setTimeoutValue(e.target.value)} /></Field>
              <Field label={t('凭据环境变量')} help={t('由启动本地服务的环境提供；填写后优先使用该变量。')}><TextInput maxLength={160} pattern="[A-Za-z_][A-Za-z0-9_]{0,159}" autoComplete="off" placeholder={t('可选，例如 WEB_TOOLS_API_KEY')} value={env} onChange={e => setEnv(e.target.value)} /></Field>
            </FieldRow>
          </Disclosure>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <FormStatusText status={status} />
          <Button variant="ghost" disabled={busy || (!saved.apiKeyConfigured && !saved.apiKeyEnv)} onClick={() => void update({ clearCredentials: true })}>{t('清除凭据')}</Button>
          <Button variant="secondary" disabled={busy} onClick={e => void update({ testConnection: true }, (e.currentTarget as HTMLButtonElement).form)}>{t('保存并检查连接')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>{t('保存设置')}</Button>
        </div>
      </form>
    </SettingsSection>
  )
}
