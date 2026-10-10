import { currentLocale, intlLocale, t as tr } from '@/i18n'
/** Duration as `38s`, `1m12s`, `1h04m` (compact, tabular-friendly). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  const gap = currentLocale() === 'en' ? ' ' : '' // English: "1m 12s"
  if (m < 60) return `${m}m${gap}${String(s).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${gap}${String(m % 60).padStart(2, '0')}m`
}

/** Sub-second precision for short tool durations: `0.4s`, `1.8s`, `12s`. */
export function formatShortDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
  return formatDuration(ms)
}

export function elapsed(from?: string | null, to?: string | null, now = Date.now()): number | null {
  if (!from) return null
  const start = Date.parse(from)
  if (Number.isNaN(start)) return null
  const end = to ? Date.parse(to) : now
  return Math.max(0, end - start)
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return new Intl.NumberFormat(intlLocale(currentLocale())).format(n)
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
  const pct = ratio * 100
  if (pct > 0 && pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

/** Formatters follow the interface language (cached per locale). */
const formatters = new Map<string, { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; year: Intl.DateTimeFormat }>()
function fmt() {
  const tag = intlLocale(currentLocale())
  let f = formatters.get(tag)
  if (!f) {
    const month = tag === 'en-US' ? 'short' : 'long'
    f = { time: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false }), date: new Intl.DateTimeFormat(tag, { month, day: 'numeric' }), year: new Intl.DateTimeFormat(tag, { year: 'numeric', month, day: 'numeric' }) }
    formatters.set(tag, f)
  }
  return f
}

/** "刚刚", "5 分钟前", "14:02", "昨天 14:02", "9月26日" (en: "Just now", "5 min ago", "Yesterday 14:02", "Sep 26") */
export function relativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = now - t
  if (diff < 60_000) return tr('刚刚')
  if (diff < 60 * 60_000) return tr('{v} 分钟前', { v: Math.floor(diff / 60_000) })
  const d = new Date(t)
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return fmt().time.format(d)
  const yesterday = new Date(now - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return tr('昨天 {v}', { v: fmt().time.format(d) })
  return fmt().date.format(d)
}

export function clockTime(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : fmt().time.format(new Date(t))
}

/** Time of day, with the day when it is not today: "14:02", "昨天 14:02", "9月30日 14:02" (en "Yesterday 14:02", "Sep 30 14:02"). */
export function stampTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  const today = new Date(now)
  const time = fmt().time.format(d)
  if (d.toDateString() === today.toDateString()) return time
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return tr('昨天 {v}', { v: time })
  return `${(d.getFullYear() === today.getFullYear() ? fmt().date : fmt().year).format(d)} ${time}`
}

/** Home-relative, middle-truncated project path for subtle display. */
export function prettyPath(path?: string | null): string {
  if (!path) return ''
  return path.replace(/^\/Users\/[^/]+/, '~')
}
