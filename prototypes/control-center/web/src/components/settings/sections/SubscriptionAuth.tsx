/**
 * Subscription login (ChatGPT / Codex). Port of public/subscription-auth-ui.js:
 * browser or device-code login, 1.5s polling while awaiting authorization,
 * paste-the-callback fallback, cancel and logout. The auth state is
 * independent of the provider form draft.
 */
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LogIn, LogOut, X } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { SubscriptionAuthState } from '@/api/panels-types'
import { Button } from '@/components/ui/primitives'
import { Disclosure, Note, Select, TextInput } from '../form'
import { t } from '@/i18n'

export function SubscriptionAuth({ providerId, canStart, onAuthenticated }: { providerId: string | null; canStart: () => boolean; onAuthenticated: () => Promise<void> }) {
  const [state, setState] = useState<SubscriptionAuthState | null>(null)
  const [message, setMessage] = useState<{ text: string; tone: 'default' | 'success' | 'danger' } | null>(providerId ? { text: t('正在读取登录状态…'), tone: 'default' } : { text: t('先保存提供商，再登录订阅账户。'), tone: 'default' })
  const [method, setMethod] = useState<'browser' | 'device_code'>('browser')
  const [callback, setCallback] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const alive = useRef(true)
  const seenPending = useRef(false)
  const notified = useRef(false)

  const show = (value: SubscriptionAuthState) => {
    clearTimeout(timer.current)
    setState(value)
    const pending = value.state === 'awaiting_authorization'
    if (pending) seenPending.current = true
    setMessage({ text: value.error || (pending ? t('等待授权。完成后会自动更新登录状态。') : value.authenticated ? t('订阅已登录；请求时自动刷新凭据。') : t('尚未登录。')), tone: value.error ? 'danger' : value.authenticated ? 'success' : 'default' })
    if (pending) timer.current = setTimeout(poll, 1500)
    if (value.authenticated && value.loginState === 'complete' && seenPending.current && !notified.current) {
      notified.current = true
      void onAuthenticated().catch(error => setMessage({ text: t('登录已完成；模型同步未完成：{message}', { message: (error as Error).message }), tone: 'danger' }))
    }
  }
  const poll = async () => {
    if (!alive.current || !providerId) return
    try { show(await panelsApi.authStatus(providerId)) } catch (error) { setMessage({ text: (error as Error).message, tone: 'danger' }); timer.current = setTimeout(poll, 5000) }
  }
  const run = async (task: () => Promise<SubscriptionAuthState>) => {
    if (busy) return
    setBusy(true)
    try { show(await task()) } catch (error) { setMessage({ text: (error as Error).message, tone: 'danger' }) } finally { setBusy(false) }
  }

  useEffect(() => {
    alive.current = true
    if (providerId) timer.current = setTimeout(poll, 0)
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [providerId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pending = state?.state === 'awaiting_authorization'
  const url = state?.authorizationUrl || state?.verificationUrl
  return (
    <div className="space-y-3 rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]" aria-label={t('订阅登录')}>
      {message && <Note tone={message.tone}>{message.text}</Note>}
      <div className="flex flex-wrap items-center gap-2">
        {!pending && (
          <>
            <Select<'browser' | 'device_code'> aria-label={t('订阅登录方式')} value={method} onChange={setMethod} disabled={!providerId || busy} className="h-8 w-36 text-[12.5px]" options={[{ value: 'browser', label: t('浏览器登录') }, { value: 'device_code', label: t('设备码登录') }]} />
            <Button size="sm" variant="secondary" disabled={!providerId || busy} leading={<LogIn className="size-3.5" />} onClick={() => {
              if (!canStart()) { setMessage({ text: t('请先保存提供商更改，再开始登录。'), tone: 'default' }); return }
              notified.current = false
              void run(() => panelsApi.authStart(providerId!, method))
            }}>{t('开始登录')}</Button>
          </>
        )}
        {pending && <Button size="sm" variant="secondary" disabled={busy} leading={<X className="size-3.5" />} onClick={() => void run(() => panelsApi.authCancel(providerId!, state?.attemptId))}>{t('取消登录')}</Button>}
        {state?.authenticated && !pending && <Button size="sm" variant="ghost" disabled={busy} leading={<LogOut className="size-3.5" />} onClick={() => void run(() => panelsApi.authLogout(providerId!))}>{t('退出登录')}</Button>}
      </div>
      {pending && (
        <div className="space-y-3">
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-soft px-3 text-[12.5px] font-medium text-accent-text transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]">
              {state?.userCode ? t('打开设备授权页面') : t('在浏览器中授权')}<ExternalLink className="size-3.5" />
            </a>
          )}
          {state?.userCode && (
            <div>
              <p className="mb-1.5 text-[12.5px] text-fg-3">{t('在授权页面输入此设备码：')}</p>
              <code className="inline-block select-all rounded-lg bg-inset px-3 py-1.5 font-mono text-[18px] font-semibold tracking-[0.2em] text-fg">{state.userCode}</code>
            </div>
          )}
          {state?.canPasteCallback && (
            <Disclosure summary={t('浏览器没有自动返回？粘贴回调地址')}>
              <div className="flex gap-2">
                <TextInput type="url" autoComplete="off" aria-label={t('完整登录回调地址')} placeholder="http://localhost:1455/auth/callback?…" value={callback} onChange={e => setCallback(e.target.value)} />
                <Button size="sm" variant="secondary" className="h-9" disabled={busy || !callback} onClick={() => void run(async () => { const result = await panelsApi.authComplete(providerId!, state.attemptId, callback); setCallback(''); return result })}>{t('完成登录')}</Button>
              </div>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  )
}
