/**
 * Application-wide values the shared app store does not keep: daily budget
 * settings and the emergency flag. Read from the v2 bootstrap on demand (the
 * settings panel is the only consumer) and refreshed after each write.
 */
import { create } from 'zustand'
import { getTransport } from '@/api/client'
import { panelsApi } from '@/api/panels'
import type { AppSettings, Health } from '@/api/panels-types'

interface Globals { settings: AppSettings | null; emergency: boolean; health: Health | null; loaded: boolean }

export const useGlobals = create<Globals>(() => ({ settings: null, emergency: false, health: null, loaded: false }))

export async function reloadGlobals() {
  const [boot, health] = await Promise.allSettled([
    getTransport().request<{ settings?: AppSettings; emergency?: unknown }>('/api/v2/bootstrap'),
    panelsApi.health(),
  ])
  useGlobals.setState(s => ({
    loaded: true,
    settings: boot.status === 'fulfilled' ? boot.value.settings ?? {} : s.settings,
    emergency: boot.status === 'fulfilled' ? Boolean(boot.value.emergency) : s.emergency,
    health: health.status === 'fulfilled' ? health.value : s.health,
  }))
}
