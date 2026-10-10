/**
 * S2 built-in browser: address normalization, the embed policy (desktop
 * `<webview>` vs. sandboxed `<iframe>` vs. "cannot embed"), and the
 * navigation stack the iframe fallback keeps itself (a cross-origin frame's
 * history is not readable). Pure functions, unit-tested.
 */

/** Sandbox for the web-mode iframe. Only ever applied to loopback origins other than the app's own. */
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups'

export type EmbedMode = 'webview' | 'iframe' | 'blocked' | 'invalid'

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** localhost, 127.0.0.0/8 and ::1 (URL.hostname keeps IPv6 brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || LOOPBACK_V4.test(host) || host === '[::1]' || host === '::1'
}

/**
 * Turn what the user typed into a navigable URL, or null.
 * `localhost:5173` / `127.0.0.1:3000/x` get `http://`; `example.com` gets
 * `https://`; only http(s) and `about:blank` are accepted (no search fallback).
 */
export function normalizeAddress(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (raw.toLowerCase() === 'about:blank') return 'about:blank'
  let candidate = raw
  // `host:port…` would otherwise parse as a URL whose scheme is the host name.
  const hostPort = /^([\w.-]+|\[[0-9a-f:]+\]):\d+(?:[/?#]|$)/i.test(raw)
  if (hostPort || !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (/\s/.test(raw)) return null
    const host = raw.split(/[/?#]/)[0].replace(/:\d+$/, '')
    if (!host) return null
    const local = isLoopbackHost(host) || host === '0.0.0.0' || IPV4.test(host)
    if (!local && !host.includes('.')) return null
    candidate = `${local ? 'http' : 'https'}://${raw}`
  }
  let url: URL
  try { url = new URL(candidate) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.href
}

/**
 * How a URL can be shown in the side panel.
 * @param url - a normalized URL.
 * @param options.webview - the desktop shell offers `<webview>` (any http/https page).
 * @param options.appOrigin - the workbench's own origin: never framed with scripts + same-origin (that would lift the sandbox).
 * @param options.allowData - mock mode: `data:text/html` preview stand-ins may be framed.
 */
export function embedMode(url: string, options: { webview?: boolean; appOrigin?: string; allowData?: boolean } = {}): EmbedMode {
  if (url === 'about:blank') return options.webview ? 'webview' : 'iframe'
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'invalid' }
  if (parsed.protocol === 'data:') return options.allowData && /^data:text\/html[;,]/i.test(url) ? 'iframe' : 'invalid'
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalid'
  if (options.webview) return 'webview'
  if (options.appOrigin && parsed.origin === options.appOrigin) return 'blocked'
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname) ? 'iframe' : 'blocked'
}

/** A short label for a tab: `host:port/path` without the scheme; data URLs read as a preview. */
export function addressLabel(url: string): string {
  if (!url || url === 'about:blank') return ''
  if (url.startsWith('data:')) return 'preview'
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.host}${path}${u.search}`
  } catch { return url }
}

/* ---------------------------------------------------- navigation stack */

export interface NavStack { entries: string[]; index: number }

export const navStart = (url: string): NavStack => ({ entries: url ? [url] : [], index: url ? 0 : -1 })
/** Navigate: drop forward entries, append (no duplicate when reloading the same URL). */
export function navPush(stack: NavStack, url: string): NavStack {
  if (stack.entries[stack.index] === url) return stack
  const entries = [...stack.entries.slice(0, stack.index + 1), url].slice(-50)
  return { entries, index: entries.length - 1 }
}
export const canBack = (stack: NavStack) => stack.index > 0
export const canForward = (stack: NavStack) => stack.index >= 0 && stack.index < stack.entries.length - 1
export const navBack = (stack: NavStack): NavStack => (canBack(stack) ? { ...stack, index: stack.index - 1 } : stack)
export const navForward = (stack: NavStack): NavStack => (canForward(stack) ? { ...stack, index: stack.index + 1 } : stack)
export const navCurrent = (stack: NavStack): string => stack.entries[stack.index] ?? ''

/** Device frame widths for the viewport toggle. */
export const DEVICE_WIDTH = { desktop: null, mobile: 390 } as const
export type DeviceMode = keyof typeof DEVICE_WIDTH
