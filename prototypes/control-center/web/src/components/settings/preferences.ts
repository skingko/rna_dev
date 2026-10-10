/**
 * Local interface preferences (this browser only): language, layout mode,
 * zoom and whether the 后台任务 panel opens by itself when work starts. Theme
 * stays in the shared ui-store. Applied to <html> so no component needs to
 * subscribe: `lang`, `zoom`, and the reading width token override.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

export type Language = 'system' | 'zh' | 'en'
export type LayoutMode = 'standard' | 'wide'
export const ZOOM_LEVELS = [0.9, 1, 1.1, 1.25] as const
export type Zoom = (typeof ZOOM_LEVELS)[number]

interface Preferences {
  language: Language
  layout: LayoutMode
  zoom: Zoom
  /** Open the 后台任务 panel when background work starts in the current project (design D4); on by default. */
  tasksAutoOpen: boolean
}

const KEY = 'rna.preferences'
function load(): Preferences {
  const fallback: Preferences = { language: 'system', layout: 'standard', zoom: 1, tasksAutoOpen: true }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Preferences>
    return {
      language: raw.language === 'zh' || raw.language === 'en' ? raw.language : 'system',
      layout: raw.layout === 'wide' ? 'wide' : 'standard',
      zoom: (ZOOM_LEVELS as readonly number[]).includes(Number(raw.zoom)) ? raw.zoom as Zoom : 1,
      tasksAutoOpen: raw.tasksAutoOpen !== false,
    }
  } catch { return fallback }
}

export const usePreferences = create<Preferences>(load)

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  usePreferences.setState({ [key]: value } as Pick<Preferences, K>)
  try { localStorage.setItem(KEY, JSON.stringify(usePreferences.getState())) } catch { /* private mode */ }
}

export function resolvedLanguage(language: Language): 'zh' | 'en' {
  if (language !== 'system') return language
  return typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language) ? 'en' : 'zh'
}

/** Mount once (GlobalPanels). */
export function useApplyPreferences() {
  const { language, layout, zoom } = usePreferences()
  useEffect(() => {
    const root = document.documentElement
    root.lang = resolvedLanguage(language) === 'en' ? 'en' : 'zh-CN'
    root.style.zoom = zoom === 1 ? '' : String(zoom)
    if (layout === 'wide') root.style.setProperty('--content-width', '960px')
    else root.style.removeProperty('--content-width')
  }, [language, layout, zoom])
}
