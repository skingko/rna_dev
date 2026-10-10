/**
 * REST client for the global panels. Every route, method and payload matches
 * the legacy UI exactly (public/settings-ui.js, maintenance-ui.js,
 * capabilities-ui.js, skill-marketplace-ui.js, workspace-ui.js, app.js) so the
 * daemon sees no difference between the two front ends.
 */
import { getTransport } from './client'
import type { RequestInit } from './transport'
import type { CacheUsage } from './types'
import type {
  MediaKind, MediaModelChoice,
  AppSettings, CalibrationReport, CalibrationWindow, CapabilityCatalog, CapabilityInspectResult, CapabilityInstallInput, CapabilityKind, DecisionKernelConfig, JudgmentCredential,
  DeleteResult, DirectoryListing, FullConfiguration, Health, MaintenanceAction,
  MaintenanceState, MarketplaceProvider, MarketplaceRead, MarketplaceResult, MemoryBrowseResponse, MemoryConfig, MemoryFilter,
  MemoryReadResponse, MemorySearchResponse, PermissionsResponse, ProviderConfig, ProviderRefreshResult,
  ProviderTestResult, SubscriptionAuthState, WebToolsCheck, WebToolsConfig, WorkspaceOpenResult,
} from './panels-types'

const req = <T,>(path: string, init?: RequestInit) => getTransport().request<T>(`/api${path}`, init)
const post = <T,>(path: string, body: unknown = {}, signal?: AbortSignal) => req<T>(path, { method: 'POST', body, signal })
const patch = <T,>(path: string, body: unknown) => req<T>(path, { method: 'PATCH', body })
const enc = encodeURIComponent

export const panelsApi = {
  /* configuration + providers */
  configuration: () => req<FullConfiguration>('/configuration'),
  patchConfiguration: (input: { defaultModel?: { providerId: string; modelId: string; reasoning?: string | null }; internalReasoning?: Partial<{ mode: 'auto' | 'chat'; routing: 'shadow' | 'route'; capture: boolean; purposes: Array<'decision' | 'narrator'> }>; memory?: Partial<MemoryConfig> & { apiKey?: string }; webTools?: Partial<WebToolsConfig> & { apiKey?: string }; media?: Partial<Record<MediaKind, MediaModelChoice | null>> & { vision?: { providerId: string; modelId: string } | null } }) =>
    patch<FullConfiguration>('/configuration', input),
  createProvider: (body: Record<string, unknown>) => post<ProviderConfig>('/providers', body),
  updateProvider: (id: string, body: Record<string, unknown>) => patch<ProviderConfig>(`/providers/${enc(id)}`, body),
  deleteProvider: (id: string) => req<unknown>(`/providers/${enc(id)}`, { method: 'DELETE', body: {} }),
  testProvider: (id: string) => post<ProviderTestResult>(`/providers/${enc(id)}/test`),
  refreshModels: (id: string) => post<ProviderRefreshResult>(`/providers/${enc(id)}/refresh-models`),
  authStatus: (id: string) => req<SubscriptionAuthState>(`/providers/${enc(id)}/auth`),
  authStart: (id: string, method: 'browser' | 'device_code') => post<SubscriptionAuthState>(`/providers/${enc(id)}/auth/start`, { method }),
  authComplete: (id: string, attemptId: string | undefined, callbackUrl: string) => post<SubscriptionAuthState>(`/providers/${enc(id)}/auth/complete`, { attemptId, callbackUrl }),
  authCancel: (id: string, attemptId: string | undefined) => post<SubscriptionAuthState>(`/providers/${enc(id)}/auth/cancel`, { attemptId }),
  authLogout: (id: string) => post<SubscriptionAuthState>(`/providers/${enc(id)}/auth/logout`),

  /* general */
  patchSettings: (input: AppSettings) => patch<AppSettings>('/settings', input),
  emergency: (stop: boolean) => post<unknown>('/emergency', { stop }),
  health: () => req<Health>('/health'),
  updateCheck: () => req<{ status: 'available' | 'current' | 'source_unavailable' | 'unreachable'; current?: string; latest?: string | null; source: string; checkedAt: string; releaseUrl?: string }>('/updates/check'),
  cacheUsage: (window: '1h' | '24h' | '7d', projectId?: string) =>
    req<CacheUsage>(`/v2/usage/cache?${new URLSearchParams({ window, ...(projectId ? { projectId } : {}) })}`),

  /* judgment (JEV) */
  decisionKernel: () => req<DecisionKernelConfig>('/decision-kernel'),
  /** K2 v2: only `apiKey`, `fastModel` and `autoModel` are user settings (mode/modes/backend are ignored by the daemon). */
  patchDecisionKernel: (input: { apiKey?: string; fastModel?: { providerId: string; modelId: string } | null; autoModel?: boolean }) =>
    patch<DecisionKernelConfig>('/decision-kernel', input),
  calibration: (point: string | null, window: CalibrationWindow) =>
    req<CalibrationReport>(`/v2/decision-kernel/calibration?${new URLSearchParams({ window, ...(point ? { point } : {}) })}`),
  /** One minimal JEV call with the saved key; `status` is JEV's own answer, `credential` the host's verdict. */
  checkJudgmentKey: () => post<{ status: number; credential?: JudgmentCredential | null }>('/v2/decision-kernel/probe', { check: 'credential' }),

  /* web tools */
  testWebTools: () => post<WebToolsCheck>('/web-tools/test'),

  /* maintenance */
  maintenance: () => req<MaintenanceState>('/maintenance'),
  maintenanceAction: (action: MaintenanceAction, payload: Record<string, unknown>) => post<{ operation?: MaintenanceState['operation'] }>(`/maintenance/${action}`, payload),

  /* project memory */
  memoryBrowse: (projectId: string, body: { uri: string; offset: number; limit: number; view?: 'recent'; refresh?: boolean; filter?: MemoryFilter }) =>
    post<MemoryBrowseResponse>(`/projects/${enc(projectId)}/memory/browse`, body),
  memorySearch: (projectId: string, query: string, limit: number) => post<MemorySearchResponse>(`/projects/${enc(projectId)}/memory/search`, { query, limit }),
  memoryRead: (projectId: string, uri: string, level: 'L0' | 'L1' | 'L2') => post<MemoryReadResponse>(`/projects/${enc(projectId)}/memory/read`, { uri, level }),
  memoryHealth: (projectId: string) => post<unknown>(`/projects/${enc(projectId)}/memory/health`),

  /* capabilities + marketplace */
  capabilities: (projectId: string) => req<CapabilityCatalog>(`/projects/${enc(projectId)}/capabilities`),
  inspectCapability: (projectId: string, input: CapabilityInstallInput) => post<CapabilityInspectResult>(`/projects/${enc(projectId)}/capabilities/inspect`, input),
  installCapability: (projectId: string, input: CapabilityInstallInput) => post<{ activated?: boolean }>(`/projects/${enc(projectId)}/capabilities/install`, input),
  assignCapability: (projectId: string, body: Record<string, unknown>) => post<unknown>(`/projects/${enc(projectId)}/capabilities/assign`, body),
  removeCapability: (projectId: string, body: { kind: CapabilityKind; id: string; uninstall?: boolean }) => post<unknown>(`/projects/${enc(projectId)}/capabilities/remove`, body),
  marketplaces: (signal?: AbortSignal) => req<{ providers?: MarketplaceProvider[] }>('/skill-marketplaces', { signal }),
  marketplaceSearch: (body: { provider: string; query: string; limit: number; projectId: string }, signal?: AbortSignal) =>
    post<{ results?: MarketplaceResult[] }>('/skill-marketplaces/search', body, signal),
  marketplaceRead: (body: { provider?: string; id: string; path?: string; projectId: string }, signal?: AbortSignal) =>
    post<MarketplaceRead>('/skill-marketplaces/read', body, signal),

  /* projects, sessions, archive */
  patchProject: (id: string, body: Record<string, unknown>) => patch<unknown>(`/projects/${id}`, body),
  patchSession: (id: string, body: Record<string, unknown>) => patch<unknown>(`/sessions/${id}`, body),
  /** `confirm` (0.63): delete a conversation whose worktree still holds changes not applied to the project folder (409 worktree_unapplied otherwise). */
  deleteEntity: (kind: 'project' | 'session', id: string, options: { confirm?: boolean } = {}) => req<DeleteResult>(`/${kind === 'project' ? 'projects' : 'sessions'}/${id}`, { method: 'DELETE', body: options.confirm ? { confirm: true } : {} }),
  retryDeletion: (sessionId: string) => post<DeleteResult>(`/session-deletions/${sessionId}/retry`),
  /** The user's decision on a blocked cleanup: `choice` is the one the receipt offers (409 cleanup_decision_unavailable otherwise). */
  decideDeletion: (sessionId: string, choice: string) => post<DeleteResult>(`/session-deletions/${sessionId}/decide`, { choice }),
  permissions: (projectId: string) => req<PermissionsResponse>(`/projects/${enc(projectId)}/permissions`),
  setPermissions: (projectId: string, workspace: string, background: string, signal?: AbortSignal) =>
    req<PermissionsResponse>(`/projects/${enc(projectId)}/permissions`, { method: 'PATCH', body: { workspace, background }, signal }),

  /* workspaces (new project) */
  browseDirectories: (body: { path?: string; hidden: boolean; offset: number }) => post<DirectoryListing>('/workspaces/browse', body),
  createDirectory: (parent: string, name: string) => post<{ path: string }>('/workspaces/directories', { parent, name }),
  openWorkspace: (body: { workspace: string; projectId?: string; name?: string; description?: string; demo?: boolean }) => post<WorkspaceOpenResult>('/workspaces/open', body),
}
