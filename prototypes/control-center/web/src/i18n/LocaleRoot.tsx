/**
 * Re-mounts the tree when the interface language changes, so every `t()` call
 * (including module-level `localized` tables and memoized rows) re-renders in
 * the new language. App state lives in zustand stores and survives the remount.
 */
import { Fragment, type ReactNode } from 'react'
import { useLocale } from './index'

export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale()
  return <Fragment key={locale}>{children}</Fragment>
}
