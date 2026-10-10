/**
 * The full configuration (with the provider preset catalog) used by the
 * settings panel. Bootstrap/index carry a preset-less copy; after a save we
 * push the fresh copy into the app store so the composer's model menu
 * updates without waiting for the stream.
 */
import { create } from 'zustand'
import { panelsApi } from '@/api/panels'
import type { FullConfiguration } from '@/api/panels-types'
import type { Configuration } from '@/api/types'
import { useApp } from '@/store/app-store'

interface ConfigState { value: FullConfiguration | null; error: string | null; loading: boolean }

export const useConfiguration = create<ConfigState>(() => ({ value: null, error: null, loading: false }))

let inflight: Promise<FullConfiguration | null> | null = null

export function reloadConfiguration(): Promise<FullConfiguration | null> {
  inflight ??= (async () => {
    useConfiguration.setState({ loading: true })
    try {
      const value = await panelsApi.configuration()
      useConfiguration.setState({ value, error: null, loading: false })
      adoptConfiguration(value)
      return value
    } catch (error) {
      useConfiguration.setState({ error: (error as Error).message, loading: false })
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Accept a configuration returned by a write (PATCH /api/configuration). */
export function adoptConfiguration(value: FullConfiguration) {
  useConfiguration.setState({ value })
  const { providerPresets: _presets, ...rest } = value
  void _presets
  useApp.setState({ configuration: rest as unknown as Configuration })
}
