/**
 * P4 project-agent self-evolution (read-only / propose-only) and task types.
 * Contract: docs/specs/stream-protocol-v2.md §7. Trial / adopt / rollback keep
 * using POST /api/projects/:id/versions/:versionId/control (project-api).
 * Reads resolve to `null` on daemons without these routes (404).
 */
import { getTransport } from './client'
import { isUnsupported } from './communication-api'
import type { ISODate } from './types'

export type RrsiComponent = 'system_section' | 'skill' | 'tool_description' | 'mcp_assignment' | 'rhythm' | 'communication_style' | 'evaluation_standard'
export type RrsiVerdict = 'accepted' | 'rejected' | 'lost' | 'critic_rejected' | 'smoke_failed' | 'prescreen_skipped' | 'author_failed' | 'infra_failed' | 'eval_failed' | 'trial_adopted' | 'trial_rolled_back'

export interface ChangelogEntry { at: ISODate; versionId: string | null; key: string; component: string; label?: string; verdict: string; title: string; detail: string }

export interface ComponentHistoryRow { t: number; at: ISODate; versionId: string | null; verdict: string; hypothesis: string; deltaS: number | null; change?: string }
export interface ComponentRow {
  key: string; component: string; componentLabel?: string; label: string; hash?: string; id?: string
  attempts: number; accepted: number; lastVerdict: string | null; pruneCandidate: boolean
  history: ComponentHistoryRow[]
}
export interface ComponentsView {
  projectId?: string
  components: ComponentRow[]
  tried: string[]
  untried: string[]
  falsified: { key: string; component?: string; hypothesis: string; verdict: string; t?: number }[]
  pruneSet: { key: string; recentBestGain?: number | null }[]
  git?: { commit: string; at: ISODate; refs?: string; subject: string }[]
}

export interface RrsiConfig { T: number; bMin: number; bMax: number; window: number; deltaZ: number; minDelta: number; nPrune: number; wReal: number; wJev: number; minRealCases: number; heldOutFraction: number; smokeCases: number; maxCriticRepairs: number; [key: string]: number | null }
export interface RrsiHistory {
  projectId?: string
  config: RrsiConfig
  frontier: { round: number; sStar: number | null; trajectory: number[] }
  calibration?: { delta: number | null; measured: boolean; method?: string }
  budget?: number
  exploration?: { stall?: number; untried?: string[]; required?: boolean; text?: string }
  falsified?: ComponentsView['falsified']
  pruneSet?: ComponentsView['pruneSet']
  records?: { t: number; at: ISODate; versionId: string | null; key?: string; component?: string | null; hypothesis?: string; change?: string; verdict: string; deltaS?: number | null; deltaC?: number | null }[]
}

export type SignalKind = 'user_correction' | 'retry' | 'aborted_turn' | 'tool_failure' | 'overlong_turn' | 'proactive_outcome' | 'deliverable'
export interface InteractionSignals {
  projectId?: string
  counts: Partial<Record<SignalKind, number>>
  score: { score: number | null; signals: number; negatives?: number }
  heldOut?: number
  signals: { id: string; kind: SignalKind | string; at?: ISODate; sessionId?: string | null; versionId?: string | null; inputExcerpt?: string; detail?: Record<string, unknown> }[]
  replay: { id: string; kind: string; split: 'evolve' | 'heldout' | string; at?: ISODate; versionId?: string | null; checks?: { kind: string; text?: string; tool?: string; value?: number }[]; files?: number; inputExcerpt?: string }[]
}

export interface FailureRow { projectId?: string; versionId: string | null; state: string | null; phase: string; code: string; kind: string; class: 'infra' | 'author' | 'eval' | string; cause: string; at: ISODate | null }
export interface FailureSummary { total: number; versionStates: Record<string, number>; byClass: Partial<Record<'infra' | 'author' | 'eval', number>>; byCause: Record<string, number>; rows: FailureRow[] }

export type TaskType = 'research' | 'coding' | 'creative' | 'design' | 'analysis' | 'writing' | 'recurring' | 'data'
export interface TaskTypesView { projectId: string; taskTypes: TaskType[]; explicit: boolean; vocabulary?: TaskType[] }

export type SystemComponent = 'core_prompt_section' | 'core_tool_description' | 'jev_template' | 'communication_rule'
export interface SystemTarget { component: SystemComponent | string; key: string; evidence?: Record<string, unknown>; hypothesis: string }
export interface SystemEvolution {
  generatedAt: ISODate
  autoAdopt: boolean
  components: string[]
  projects: { projectId: string; counts: Partial<Record<SignalKind, number>>; score: { score: number | null; signals: number; negatives?: number }; replayCases: number; heldOut: number }[]
  signalKinds: Record<string, number>
  toolFailures: Record<string, number>
  /** Per tool: failures by cause (`call` the model's use of it, `environment` a service or site outside, `refused` a host or user rule, `interrupted`) and the latest one. Absent on older daemons. */
  toolFailureCauses?: Record<string, { call: number; environment: number; refused: number; interrupted: number; lastAt: ISODate | null }>
  proactive: { replied?: number; acted?: number; dismissed?: number }
  jevLedger: Record<string, { decisions: number; judged: number; labeled: number }>
  targets: SystemTarget[]
}
export interface SystemProposal { id: string; createdAt: ISODate; status: 'proposed' | string; autoAdopt: false; adoption?: string; target: SystemTarget | null; note?: string }

const enc = encodeURIComponent
const req = <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown) =>
  getTransport().request<T>(path, { method, ...(body === undefined ? {} : { body }) })
async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run() } catch (error) { if (isUnsupported(error)) return null; throw error }
}
const base = (projectId: string) => `/api/v2/projects/${enc(projectId)}`

export const evolutionApi = {
  changelog: (projectId: string, limit = 50) => optional(() => req<{ projectId: string; entries: ChangelogEntry[] }>(`${base(projectId)}/evolution/changelog?limit=${limit}`)),
  components: (projectId: string, key?: string) => optional(() => req<ComponentsView>(`${base(projectId)}/evolution/components${key ? `?key=${enc(key)}` : ''}`)),
  history: (projectId: string, limit = 50) => optional(() => req<RrsiHistory>(`${base(projectId)}/evolution/history?limit=${limit}`)),
  signals: (projectId: string, limit = 50) => optional(() => req<InteractionSignals>(`${base(projectId)}/evolution/signals?limit=${limit}`)),
  failures: (projectId: string) => optional(() => req<FailureSummary>(`${base(projectId)}/evolution/failures`)),
  systemFailures: () => optional(() => req<FailureSummary>('/api/v2/evolution/failures')),
  taskTypes: (projectId: string) => optional(() => req<TaskTypesView>(`${base(projectId)}/task-types`)),
  setTaskTypes: (projectId: string, taskTypes: TaskType[] | null) => req<TaskTypesView>(`${base(projectId)}/task-types`, 'PATCH', { taskTypes }),
  system: () => optional(() => req<SystemEvolution>('/api/v2/evolution/system')),
  propose: (input: { component?: string; key?: string; note?: string }) => req<SystemProposal>('/api/v2/evolution/system/proposals', 'POST', input),
}
