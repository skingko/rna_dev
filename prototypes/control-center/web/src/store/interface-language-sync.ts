/**
 * The host writes some text for the user to read (gene summaries, guard
 * titles, announcements). It follows the interface language chosen here, so
 * the client tells the host whenever that language is known or changes. The
 * host ignores an unchanged value; older daemons without the setting just
 * reject it, which is harmless.
 */
import { useEffect } from 'react'
import { getTransport } from '@/api/client'
import { resolvedLanguage, usePreferences } from '@/components/settings/preferences'
import { useApp } from './app-store'

let sent: string | null = null

export function useInterfaceLanguageSync() {
  const status = useApp(s => s.status)
  const language = usePreferences(s => resolvedLanguage(s.language))
  useEffect(() => {
    if (status !== 'ready' || sent === language) return
    sent = language
    getTransport().request('/api/settings', { method: 'PATCH', body: { interfaceLanguage: language } }).catch(() => { sent = null })
  }, [status, language])
}
