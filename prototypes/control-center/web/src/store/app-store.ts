import { create } from 'zustand'
import type { ReadMode } from '@/api/client'
import type { CacheUsage, Configuration, HostCapabilities, Item, ProjectSummary, SessionSummary, Turn } from '@/api/types'
import type { PhaseState, Row, SessionSlice } from './session-model'

export type Connection = 'connecting' | 'online' | 'offline'

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  mode: ReadMode | null
  connection: Connection
  revision: number
  configuration: Configuration | null
  maintenanceHeld: boolean
  /** Global emergency stop (POST /api/emergency). */
  emergency: boolean
  projects: Record<string, ProjectSummary>
  projectOrder: string[]
  sessionIndex: Record<string, SessionSummary>
  sessionOrder: string[]
  selectedSessionId: string | null
  selectedProjectId: string | null
  sessions: Record<string, SessionSlice>
  cache: CacheUsage | null
  /** S2: bootstrap `capabilities` (null on daemons that predate the side panel). */
  capabilities: HostCapabilities | null
}

export const useApp = create<AppState>(() => ({
  status: 'loading',
  error: null,
  mode: null,
  connection: 'connecting',
  revision: 0,
  configuration: null,
  maintenanceHeld: false,
  emergency: false,
  projects: {},
  projectOrder: [],
  sessionIndex: {},
  sessionOrder: [],
  selectedSessionId: null,
  selectedProjectId: null,
  sessions: {},
  cache: null,
  capabilities: null,
}))

/* ---------------------------------------------------- fine-grained hooks */

const EMPTY_ROWS: Row[] = []

export const useSelectedSlice = () => useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId] : undefined))
export const useSelectedMeta = () => useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId]?.meta ?? s.sessionIndex[s.selectedSessionId] : undefined))
export const useRows = (sessionId: string | null) => useApp(s => (sessionId ? s.sessions[sessionId]?.structure.rows ?? EMPTY_ROWS : EMPTY_ROWS))
/** Subscribes to exactly one item: deltas for other items do not re-render. */
export const useItem = (sessionId: string, itemId: string | null | undefined): Item | undefined =>
  useApp(s => (itemId ? s.sessions[sessionId]?.items[itemId] : undefined))
export const useTurn = (sessionId: string, turnId: string): Turn | undefined => useApp(s => s.sessions[sessionId]?.turns[turnId])
export const usePhase = (sessionId: string, turnId: string): PhaseState | undefined => useApp(s => s.sessions[sessionId]?.phases[turnId])
export const useProject = (projectId: string | null | undefined) => useApp(s => (projectId ? s.projects[projectId] : undefined))
