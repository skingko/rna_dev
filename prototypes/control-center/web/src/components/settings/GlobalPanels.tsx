/**
 * Mount point for every global panel (settings, memory, capabilities,
 * archive, new project, permissions, rename/delete). App mounts this once.
 */
import { useEffect } from 'react'
import { SettingsDialog } from './SettingsDialog'
import { routeFromLocation, openSettings, usePanels } from './panel-store'
import { useApplyPreferences } from './preferences'
import { MemoryBrowserDialog } from '@/components/memory/MemoryBrowser'
import { CapabilitiesDialog } from '@/components/capabilities/CapabilitiesDialog'
import { ArchiveDialog } from '@/components/archive/ArchiveDialog'
import { NewProjectDialog } from '@/components/projects/NewProjectDialog'
import { PermissionsDialog } from '@/components/projects/PermissionsDialog'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { DeleteDialog, RenameDialog } from '@/components/projects/EntityDialogs'

export function GlobalPanels() {
  useApplyPreferences()
  useEffect(() => {
    routeFromLocation()
    const onHash = () => { if (location.hash.startsWith('#settings')) routeFromLocation(); else if (usePanels.getState().settings) usePanels.setState({ settings: null }) }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(usePanels.getState().settings ?? 'general') }
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey) }
  }, [])
  return (
    <>
      <SettingsDialog />
      <MemoryBrowserDialog />
      <CapabilitiesDialog />
      <ArchiveDialog />
      <NewProjectDialog />
      <PermissionsDialog />
      <ProjectSettingsDialog />
      <RenameDialog />
      <DeleteDialog />
    </>
  )
}
