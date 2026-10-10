import { t } from '@/i18n'
/**
 * Transport seam between the typed client and either the real daemon (fetch +
 * EventSource, same origin) or the in-memory mock backend (?mock=1).
 */

export class ApiError extends Error {
  status: number
  code?: string
  /** The rest of the host's error body (e.g. `reason` of 409 worktree_unavailable, `repository` of git_init_inside_repo). */
  details?: Record<string, unknown>
  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    if (details && Object.keys(details).length) this.details = details
  }
}

/**
 * The browser's own fetch failures ('Failed to fetch', 'signal timed out')
 * become localized ApiErrors with status 0, so callers that show
 * error.message never show browser English. A caller's own abort stays an
 * AbortError for its `name === 'AbortError'` checks.
 */
export function transportFailure(error: unknown): unknown {
  if (error instanceof ApiError) return error
  if ((error as { name?: string } | null)?.name === 'TimeoutError') return new ApiError(t('请求超时，请重试。'), 0, 'request_timeout')
  if (error instanceof TypeError) return new ApiError(t('无法连接本地服务，请稍后重试。'), 0, 'network_unreachable')
  return error
}

/** fetch() whose network and timeout failures are transportFailure()s. */
export async function fetchOrFail(input: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  try { return await fetch(input, init) } catch (error) { throw transportFailure(error) }
}

export interface RequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** The subset of EventSource the stream layer needs. */
export interface EventSourceLike {
  readonly readyState: number
  onopen: ((ev: Event) => void) | null
  onerror: ((ev: Event) => void) | null
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void
  close(): void
}

export interface Transport {
  readonly kind: 'live' | 'mock'
  request<T>(path: string, init?: RequestInit): Promise<T>
  openStream(path: string): EventSourceLike
}

/**
 * Live transport. Mirrors the legacy client exactly: same-origin fetch, JSON
 * bodies with Content-Type application/json only (the daemon rejects other
 * write content types and cross-site requests; there is no token/CSRF header).
 */
export const liveTransport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { method = 'GET', body, signal } = init
    const res = await fetchOrFail(path, {
      method,
      signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    let value: unknown = null
    // The connection can also drop while the body arrives.
    const text = await res.text().catch(error => { throw transportFailure(error) })
    if (text) {
      try { value = JSON.parse(text) } catch { value = null }
    }
    if (!res.ok) {
      const { error, code, ...details } = (value && typeof value === 'object' ? value : {}) as { error?: string; code?: string } & Record<string, unknown>
      throw new ApiError(error ?? t('请求失败 ({status})', { status: res.status }), res.status, code, details)
    }
    return value as T
  },
  openStream(path: string): EventSourceLike {
    return new EventSource(path)
  },
}
