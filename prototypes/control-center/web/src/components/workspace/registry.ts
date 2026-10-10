/**
 * Panel registry (contract P-6): what each tab type looks like and renders.
 * The workspace shell draws any registered type; later registrations add new
 * tab types without touching the shell. A tab whose type is not registered
 * (yet) shows a neutral placeholder.
 *
 * `binding` documents where tabs of the type show by default; the layout
 * store derives each tab's binding from its data (side-panel-store's
 * `naturalBinding`). `keepAlive` bodies stay mounted while hidden (moving,
 * collapsing and switching conversations never reload them).
 */
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { SideTab } from '@/store/side-panel-store'

export interface PanelContext {
  sessionId: string | null
  projectId: string | null
  /** The body is on screen (its group is shown and it is that group's active tab). */
  visible: boolean
  groupId: string
}

export interface PanelDefinition {
  type: string
  title: (tab: SideTab) => string
  icon: ComponentType<{ className?: string }>
  binding: 'workspace' | 'session' | 'project'
  keepAlive?: boolean
  render: (tab: SideTab, ctx: PanelContext) => ReactNode
}

const panels = new Map<string, PanelDefinition>()
const listeners = new Set<() => void>()
let version = 0

/** Add or replace the definition of a tab type. */
export function registerPanel(def: PanelDefinition): void {
  panels.set(def.type, def)
  version += 1
  for (const listener of listeners) listener()
}

export const getPanel = (type: string): PanelDefinition | undefined => panels.get(type)
export const panelTypes = (): string[] => [...panels.keys()]
export const isKeepAlive = (type: string) => Boolean(panels.get(type)?.keepAlive)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reactive lookup: re-renders when a definition is registered later (a lazily loaded panel). */
export function usePanel(type: string): PanelDefinition | undefined {
  useSyncExternalStore(subscribe, () => version, () => version)
  return panels.get(type)
}

/** Test helper: forget a registration. */
export function unregisterPanel(type: string) {
  if (panels.delete(type)) {
    version += 1
    for (const listener of listeners) listener()
  }
}
