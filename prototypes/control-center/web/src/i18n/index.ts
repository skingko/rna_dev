/**
 * i18n layer. Simplified Chinese is the source language: message keys are the
 * zh-CN source strings, so `t('设置')` reads naturally in code and renders the
 * key itself in zh-CN. The English catalog (`./en`) is typed as the set of
 * valid keys, so `t()` with a string that has no English entry is a compile
 * error — the catalogs cannot silently drift apart.
 *
 * Placeholders: `{name}` is replaced by `vars.name`; `{n|one|other}` picks the
 * singular form when `vars.n === 1` (English plurals; zh-CN keys simply repeat
 * the same word).
 *
 * The language preference lives in `components/settings/preferences.ts`
 * (persisted in localStorage, 'system' follows navigator.language).
 */
import { en } from './en'
import { zhCN } from './zh-CN'
import { resolvedLanguage, usePreferences } from '@/components/settings/preferences'

export type Locale = 'zh-CN' | 'en'
export type MessageKey = keyof typeof en
export type Vars = Record<string, string | number | null | undefined>

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { 'zh-CN': zhCN, en }

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template
    .replace(/\{(\w+)\|([^|{}]*)\|([^{}]*)\}/g, (_, name: string, one: string, other: string) => (Number(vars[name]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (match, name: string) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])))
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  return interpolate(catalogs[locale][key] ?? key, vars)
}

export const localeOf = (language: 'zh' | 'en'): Locale => (language === 'en' ? 'en' : 'zh-CN')
/** Current locale outside React (stores, toasts, pure helpers). */
export function currentLocale(): Locale { return localeOf(resolvedLanguage(usePreferences.getState().language)) }
/** Non-hook translate for code outside components; components use `useT()` so they re-render on change. */
export function t(key: MessageKey, vars?: Vars): string { return translate(currentLocale(), key, vars) }

export type TFunction = (key: MessageKey, vars?: Vars) => string

/**
 * Module-level label tables (`const LABELS = localized({ a: '中文' })`): string
 * values are translated when read, so tables defined at import time still
 * follow the current language. Nested objects/arrays are wrapped lazily.
 */
const CJK = /[　-〿一-鿿＀-￯]/
const proxies = new WeakMap<object, object>()
/** Only plain data (arrays / object literals) — never React elements, lazy components, promises or class instances. */
function tableLike(value: unknown): value is object {
  if (!value || typeof value !== 'object' || '$$typeof' in value) return false
  const proto = Object.getPrototypeOf(value)
  return Array.isArray(value) || proto === Object.prototype || proto === null
}
export function localized<T>(value: T): T {
  if (!tableLike(value)) return value
  const cached = proxies.get(value as object)
  if (cached) return cached as T
  const proxy = new Proxy(value as object, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v === 'string') return CJK.test(v) ? translate(currentLocale(), v as MessageKey) : v
      return tableLike(v) ? localized(v) : v
    },
  })
  proxies.set(value as object, proxy)
  return proxy as T
}

export function useLocale(): Locale {
  return localeOf(resolvedLanguage(usePreferences(s => s.language)))
}
export function useT(): TFunction {
  const locale = useLocale()
  return (key, vars) => translate(locale, key, vars)
}

/** BCP 47 tag for Intl formatting. */
export const intlLocale = (locale: Locale) => (locale === 'en' ? 'en-US' : 'zh-CN')
/** BCP 47 tag of the current interface language, for `toLocaleString(intlTag(), …)` outside React. */
export const intlTag = () => intlLocale(currentLocale())
export function formatDate(value: string | number | Date, locale: Locale, options: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(intlLocale(locale), options) : ''
}
export function formatNumber(value: number, locale: Locale) { return new Intl.NumberFormat(intlLocale(locale)).format(value) }
