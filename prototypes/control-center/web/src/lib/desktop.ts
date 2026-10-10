/** Desktop shell bridge (`desktop/preload.cjs`); absent in the browser. */
export interface NotificationTarget { projectId?: string | null; entryId?: string | null; sessionId?: string | null }

/**
 * S2 built-in browser bridge (implemented by the desktop shell, S1). When
 * `capabilities.webview` is true the renderer may mount Electron `<webview>`
 * tags (the BrowserWindow needs `webviewTag: true`).
 */
export interface RnaDesktopBrowser {
  capabilities?: { webview?: boolean } | null
  /** Open a URL in the user's default browser. */
  openExternal?: (url: string) => Promise<unknown> | unknown
  /** Open Chromium DevTools for a guest page (`<webview>.getWebContentsId()`). */
  openDevTools?: (webContentsId: number) => Promise<unknown> | unknown
  /** Popups / `target=_blank` from guests arrive here to open as new browser tabs. Returns an unsubscribe. */
  onOpenUrl?: (callback: (event: { url: string; disposition?: string; sourceWebContentsId?: number }) => void) => (() => void) | void
  /** Session partition the host hardens (`persist:rna-browser`). */
  partition?: string
}

export interface RnaDesktop {
  chooseApplicationSource?: () => Promise<string | null>
  chooseDirectory?: () => Promise<string | null>
  openPreview?: (input: unknown) => Promise<unknown>
  /**
   * 在访达中显示: select an existing file or folder in Finder. The desktop shell shows only paths inside a project
   * workspace the service has registered, and rejects anything else with a reason in the interface language.
   */
  revealPath?: (absolutePath: string) => Promise<unknown>
  /** P3: a clicked proactive-delivery notification. Returns an unsubscribe. */
  onNotificationOpen?: (callback: (target: NotificationTarget) => void) => (() => void) | void
  browser?: RnaDesktopBrowser
}
declare global { interface Window { rnaDesktop?: RnaDesktop } }

/** The desktop browser bridge when `<webview>` is available, else null (plain web: iframe fallback). */
export function desktopBrowser(): (RnaDesktopBrowser & { webview: true }) | null {
  const bridge = typeof window === 'undefined' ? undefined : window.rnaDesktop?.browser
  return bridge?.capabilities?.webview ? { ...bridge, webview: true } : null
}

/** Open a URL outside the app: the desktop default browser, else a new tab without opener. */
export function openExternalUrl(url: string) {
  const bridge = typeof window === 'undefined' ? undefined : window.rnaDesktop?.browser
  if (bridge?.openExternal) { void Promise.resolve(bridge.openExternal(url)).catch(() => window.open(url, '_blank', 'noopener,noreferrer')); return }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** The desktop shell's 在访达中显示 when this build offers it, else null (the browser has no way to). */
export function desktopRevealPath(): ((absolutePath: string) => Promise<unknown>) | null {
  const bridge = typeof window === 'undefined' ? undefined : window.rnaDesktop
  const reveal = bridge?.revealPath
  return typeof reveal === 'function' ? async absolutePath => reveal.call(bridge, absolutePath) : null
}

/**
 * The reason a desktop bridge call was refused, as the main process wrote it: Electron wraps it as
 * "Error invoking remote method 'rna:…': Error: <reason>". Empty when there is none.
 */
export function desktopErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '').trim()
}
