/**
 * 浏览器 tab: back / forward / reload, an address bar, a desktop/mobile
 * viewport toggle and a "…" menu (open in the default browser, DevTools).
 *
 * Desktop shell with `rnaDesktop.browser.capabilities.webview`: an Electron
 * `<webview>` (real history, titles, DevTools). Plain web: a sandboxed
 * `<iframe>` for loopback origins only (never the workbench's own origin);
 * anything else shows "该网站不允许内嵌" with an open-external button. The
 * iframe keeps its own navigation stack (a cross-origin frame's history is
 * not readable), so back/forward cover addresses entered here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Bug, Copy, ExternalLink, Globe, Monitor, MoreHorizontal, RotateCw, ShieldOff, Smartphone, X } from 'lucide-react'
import { getTransport } from '@/api/client'
import { updateTab, type SideTabData } from '@/store/side-panel-store'
import { toast } from '@/store/ui-store'
import { desktopBrowser, openExternalUrl } from '@/lib/desktop'
import { addressLabel, canBack, canForward, DEVICE_WIDTH, embedMode, IFRAME_SANDBOX, navBack, navCurrent, navForward, navPush, navStart, normalizeAddress, type NavStack } from '@/lib/browser-url'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { Button, IconButton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

/** Electron `<webview>` guest element (desktop shell only). */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  getWebContentsId(): number
}


type BrowserTabData = Extract<SideTabData, { type: 'browser' }>

export function BrowserTab({ tab, active }: { tab: BrowserTabData; active: boolean }) {
  const t = useT()
  const bridge = useMemo(() => desktopBrowser(), [])
  const mock = getTransport().kind === 'mock'
  const [stack, setStack] = useState<NavStack>(() => navStart(tab.url))
  const [address, setAddress] = useState(tab.url.startsWith('data:') ? '' : tab.url)
  const [nonce, setNonce] = useState(0)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [menuOpen, setMenuOpen] = useState(false)
  const webview = useRef<WebviewElement | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const url = navCurrent(stack)
  const device = tab.device ?? 'desktop'
  const mode = url ? embedMode(url, { webview: Boolean(bridge), appOrigin: location.origin, allowData: mock }) : null

  // A reused tab (run preview, "在浏览器中打开") navigates to the new URL and reloads.
  // (Openers always stamp a new `reload`; the tab's own navigation only updates `url`.)
  const lastReload = useRef(tab.reload)
  useEffect(() => {
    if (tab.reload === lastReload.current) return
    lastReload.current = tab.reload
    if (!tab.url) return
    if (mode === 'webview' && webview.current && tab.url === url) { webview.current.reload(); return }
    setStack(s => navPush(s, tab.url))
    setAddress(tab.url.startsWith('data:') ? '' : tab.url)
    setNonce(n => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.reload])

  // New empty tab: focus the address bar.
  useEffect(() => { if (active && !url) requestAnimationFrame(() => input.current?.focus()) }, [active, url])
  // The iframe reports load completion only; show progress from each navigation until then.
  useEffect(() => { if (mode === 'iframe' && url) setLoading(true) }, [mode, url, nonce])

  const remember = useCallback((next: string, title?: string | null) => {
    updateTab(tab.id, { url: next, ...(title !== undefined ? { title } : {}) })
  }, [tab.id])

  const navigate = (next: string) => {
    setStack(s => navPush(s, next))
    setAddress(next)
    setNonce(n => n + 1)
    remember(next, null)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next = normalizeAddress(address)
    if (!next) { toast(t('仅支持 http 与 https 地址'), 'danger'); return }
    if (bridge && webview.current && mode === 'webview' && next !== url) { void webview.current.loadURL(next).catch(() => {}); setStack(s => navPush(s, next)); remember(next, null); return }
    navigate(next)
  }

  /* ---- webview wiring (desktop) ---- */
  useEffect(() => {
    const el = webview.current
    if (!el || mode !== 'webview') return
    const sync = () => { try { setHistory({ back: el.canGoBack(), forward: el.canGoForward() }) } catch { /* not attached yet */ } }
    const onNavigate = (ev: Event) => {
      const next = (ev as Event & { url?: string }).url
      if (next) { setAddress(next); setStack(s => navPush(s, next)); remember(next) }
      sync()
    }
    const onTitle = (ev: Event) => { const title = (ev as Event & { title?: string }).title; if (title) remember(el.getURL(), title) }
    const onStart = () => setLoading(true)
    const onStop = () => { setLoading(false); sync() }
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    return () => {
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
    }
  }, [mode, remember])

  const back = () => {
    if (mode === 'webview' && webview.current) { webview.current.goBack(); return }
    const next = navBack(stack)
    setStack(next); setAddress(visible(navCurrent(next))); setNonce(n => n + 1); remember(navCurrent(next))
  }
  const forward = () => {
    if (mode === 'webview' && webview.current) { webview.current.goForward(); return }
    const next = navForward(stack)
    setStack(next); setAddress(visible(navCurrent(next))); setNonce(n => n + 1); remember(navCurrent(next))
  }
  const reload = () => {
    if (mode === 'webview' && webview.current) { webview.current.reload(); return }
    setNonce(n => n + 1)
  }
  const openDevTools = () => {
    const el = webview.current
    if (!el || !bridge?.openDevTools) return
    try { void Promise.resolve(bridge.openDevTools(el.getWebContentsId())).catch(e => toast((e as Error).message, 'danger')) } catch (e) { toast((e as Error).message, 'danger') }
  }
  const copyUrl = () => { void navigator.clipboard?.writeText(url).then(() => toast(t('已复制链接')), () => {}) }

  const backEnabled = mode === 'webview' ? history.back : canBack(stack)
  const forwardEnabled = mode === 'webview' ? history.forward : canForward(stack)
  const external = url && !url.startsWith('data:') && url !== 'about:blank'

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-browser-mode={mode ?? 'empty'}>
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line-faint px-1.5">
        <IconButton label={t('后退')} disabled={!backEnabled} onClick={back}><ArrowLeft /></IconButton>
        <IconButton label={t('前进')} disabled={!forwardEnabled} onClick={forward}><ArrowRight /></IconButton>
        {loading && mode === 'webview'
          ? <IconButton label={t('停止')} onClick={() => webview.current?.stop()}><X /></IconButton>
          : <IconButton label={t('刷新')} disabled={!url} onClick={reload}><RotateCw /></IconButton>}
        <form onSubmit={submit} className="mx-1 min-w-0 flex-1">
          <label className="relative flex h-7 items-center">
            <Globe className="pointer-events-none absolute left-2.5 size-3.5 text-fg-4" aria-hidden />
            <input
              ref={input}
              value={address}
              onChange={e => setAddress(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              onKeyDown={e => { if (e.key === 'Escape') { setAddress(visible(url)); e.currentTarget.blur() } }}
              placeholder={t('输入网址后回车')}
              aria-label={t('网址')}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="h-7 w-full rounded-md bg-subtle pl-8 pr-2 font-mono text-[12px] text-fg outline-none transition-shadow placeholder:font-sans placeholder:text-fg-4 focus:bg-elevated focus:shadow-[inset_0_0_0_1px_var(--line-focus)]"
            />
          </label>
        </form>
        <IconButton label={device === 'mobile' ? t('切换为桌面宽度') : t('切换为手机宽度')} active={device === 'mobile'} onClick={() => updateTab(tab.id, { device: device === 'mobile' ? 'desktop' : 'mobile' })}>
          {device === 'mobile' ? <Smartphone /> : <Monitor />}
        </IconButton>
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button type="button" aria-label={t('更多浏览器操作')} className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"><MoreHorizontal className="size-4" /></button>
          </MenuTrigger>
          <MenuContent align="end" className="w-56">
            <MenuItem icon={<ExternalLink />} disabled={!external} onSelect={() => openExternalUrl(url)}>{t('在默认浏览器中打开')}</MenuItem>
            {bridge?.openDevTools && <MenuItem icon={<Bug />} disabled={mode !== 'webview'} onSelect={openDevTools}>{t('打开调试工具')}</MenuItem>}
            <MenuSeparator />
            <MenuItem icon={<Copy />} disabled={!external} onSelect={copyUrl}>{t('复制链接')}</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className={cn('relative min-h-0 flex-1', device === 'mobile' ? 'overflow-auto bg-subtle' : 'bg-white dark:bg-inset')}>
        {loading && <span className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-accent" aria-hidden />}
        <div className={cn('h-full', device === 'mobile' && 'mx-auto my-3 h-[calc(100%-24px)] overflow-hidden rounded-xl bg-white shadow-md')} style={device === 'mobile' ? { width: DEVICE_WIDTH.mobile } : undefined}>
          {!url && <EmptyBrowser />}
          {mode === 'webview' && (
            <webview ref={el => { webview.current = el as WebviewElement | null }} src={url} partition={bridge?.partition || 'persist:rna-browser'} allowpopups className="flex h-full w-full" />
          )}
          {mode === 'iframe' && (
            <iframe key={`${url}#${nonce}`} src={url} title={t('内置浏览器：{url}', { url: addressLabel(url) })} sandbox={IFRAME_SANDBOX} referrerPolicy="no-referrer"
              onLoad={() => setLoading(false)} className="h-full w-full border-0 bg-white" />
          )}
          {mode === 'blocked' && (
            <Blocked url={url} />
          )}
          {mode === 'invalid' && <Blocked url={url} invalid />}
        </div>
      </div>
    </div>
  )
}

const visible = (url: string) => (url.startsWith('data:') ? '' : url)

function EmptyBrowser() {
  const t = useT()
  return (
    <div className="grid h-full place-items-center bg-base p-6">
      <div className="flex max-w-[320px] flex-col items-center gap-2 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-subtle text-fg-3"><Globe className="size-5" /></span>
        <p className="text-[13.5px] font-medium text-fg">{t('浏览器')}</p>
        <p className="text-[12.5px] leading-relaxed text-fg-3">{t('粘贴或输入 URL 以打开网页。本机开发服务（localhost / 127.0.0.1）可直接在这里预览。')}</p>
      </div>
    </div>
  )
}

function Blocked({ url, invalid }: { url: string; invalid?: boolean }) {
  const t = useT()
  return (
    <div className="grid h-full place-items-center bg-base p-6">
      <div className="flex max-w-[340px] flex-col items-center gap-2 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-warning-soft text-warning-text"><ShieldOff className="size-5" /></span>
        <p className="text-[13.5px] font-medium text-fg">{invalid ? t('无法打开该地址') : t('该网站不允许内嵌')}</p>
        <p className="break-all text-[12.5px] leading-relaxed text-fg-3">
          {invalid ? t('仅支持 http 与 https 地址') : t('网页版只在侧边面板中显示本机页面（localhost / 127.0.0.1）。其他网站请在默认浏览器中打开。')}
        </p>
        {!invalid && (
          <Button size="sm" variant="secondary" className="mt-2" leading={<ExternalLink className="size-3.5" />} onClick={() => openExternalUrl(url)}>{t('在默认浏览器中打开')}</Button>
        )}
      </div>
    </div>
  )
}
