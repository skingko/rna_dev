/**
 * Project workspace reads and writes (tasks, versions, observations, files,
 * preview, session commands). Routes and payloads mirror the legacy UI
 * exactly (public/app.js, project-schedules-ui.js, initiative-*.js,
 * files-ui.js, composer-commands.js, session-recovery-ui.js).
 */
import { getTransport } from './client'
import { ApiError, fetchOrFail, transportFailure } from './transport'
import type { BackgroundChangeDetail, ProjectSummary, SessionSummary, SubagentInfo } from './types'
import { t } from '@/i18n'

/* ------------------------------------------------------------------ types */

export type ISODate = string

export interface ScheduleRule { kind: 'daily' | 'weekly' | 'interval' | 'once' | string; time?: string; timeZone?: string; days?: number[]; everyMs?: number; anchorAt?: string; at?: string }
/** `task` and `initiativeProvenance` are absent in a project's index row (`ProjectSummary.schedules`); GET …/schedules and the project route carry them. */
export interface Schedule {
  id: string; title: string; task?: string; enabled: boolean; rule: ScheduleRule; destinationSessionId?: string
  nextRunAt?: string | null; pausedReason?: string | null; source?: string; userEditedAt?: string | null
  initiativeProvenance?: { reason?: string } | null
}
export interface Occurrence {
  key: string; scheduleId: string; scheduledAt: string; status: string; deliveredAt?: string | null; deliveryItemId?: string | null
  errorCode?: string | null; actionId?: string; deliveryActionId?: string; sourceDeleted?: boolean; contextRevoked?: boolean
}
export interface ScheduleList { schedules: Schedule[]; occurrences?: Occurrence[]; defaults?: { time: string; timeZone: string } }

export interface VersionRecord {
  id: string; version: number | string; title?: string; state: string; source?: string; createdAt?: string
  parentVersionId?: string | null; simulated?: boolean; notice?: string; strategy?: string
  assessment?: { category?: string; label?: string; summary?: string; stage?: string; code?: string | null; retry?: { available?: boolean; kind?: string; reason?: string }; authorRetry?: { available?: boolean }; failedChecks?: { label: string; count: number; toolIds?: string[] }[] } | null
  evaluation?: { gatePassed?: boolean; summary?: string; baseline?: number; score?: number; cases?: number; baselineScore?: number; candidateScore?: number; gates?: Record<string, boolean | null>; evaluationComplete?: boolean; stage?: string; skippedCases?: number; simulated?: boolean } | null
  proposal?: { hypothesis?: string } | null
  authorAbstention?: { explanation?: string } | null
  bundle?: { hash?: string; genome?: { schemaVersion?: number; systemPrompt?: string; skills?: { id?: string; name: string; description?: string; instructions?: string }[]; tools?: { id?: string; name: string; description?: string; permission?: string; script?: string }[]; evaluationSuite?: { cases?: unknown[] } } } | null
  error?: { message?: string } | null
  evidenceIds?: string[]
  deletedAt?: string | null; sourceDeleted?: boolean; contextRevoked?: boolean; status?: string
  retryOfVersionId?: string | null
  /** P4 RRSI record for the candidate (edit budget, tiers, prescore, selection, critic). */
  rrsi?: VersionRrsi | null
  /** P4 genome git mirror of the candidate. */
  genomeGit?: { branch?: string; base?: string; commit?: string; diffStat?: string } | null
}
export interface VersionRrsi {
  round?: number | null; editBudget?: number | null
  edits?: { editId?: string; key: string; component: string; change?: string; hypothesis?: string }[]
  tiers?: { tier: 'critic' | 'prescreen' | 'smoke' | 'full' | string; status: 'passed' | 'failed' | 'skipped' | string; reason?: string; cases?: number | string[] }[]
  prescore?: { source?: string; better?: boolean | null; probability?: number | null; expectedGain?: number | null } | null
  selection?: { admissible?: boolean; enforced?: boolean; reason?: string; deltaS?: number | null; deltaC?: number | null; delta?: number | null; blended?: { score?: number | null; sufficientReal?: boolean; real?: number | null; jev?: number | null; weights?: { real: number; jev: number } } | null } | null
  critic?: { verdict?: string; reasons?: { code?: string; message?: string }[]; repaired?: boolean } | null
}
export interface ObservationRecord { id: string; kind?: string; text?: string; status?: string; createdAt?: string; source?: string; data?: unknown; simulated?: boolean; deletedAt?: string | null; sourceDeleted?: boolean; contextRevoked?: boolean }
export interface DecisionRecord { id: string; action?: string; reason?: string; content?: string; status?: string; at?: string; evidenceIds?: string[]; sourceIds?: string[]; nextReviewAfterMs?: number; schedule?: unknown; rhythm?: unknown; simulated?: boolean; deletedAt?: string | null; sourceDeleted?: boolean; contextRevoked?: boolean; /** Set when the host did not start the decided action (an exact repeat, or work receipts already covered). */ admission?: { status: 'not_admitted'; reason: 'exact_duplicate' | 'already_covered' | string } }
export interface ObservationSource { id: string; label?: string; enabled?: boolean; status?: string; summary?: string }
/**
 * C-d: `title` is the decision model's one plain line for the user; `label` is
 * the host's display name (title, else schedule name, else cleaned first
 * sentence). An action revoked for a scope change keeps a user-facing
 * `receipt` and is returned with `revoked: true`. share/ask actions carry a
 * localized `userSummary` for the task page. Why it waits or was cancelled are SDK codes (`deferredReason`,
 * `cancellationReason`; the task page words them). Live times are epoch-ms numbers, a revoked row's are in its
 * receipt. All optional: older hosts omit them.
 */
export interface InitiativeActionReceipt { label: string; status: string; startedAt?: ISODate; finishedAt?: ISODate; handoff?: string }
export interface InitiativeAction { id: string; action: string; status: string; title?: string; label?: string; revoked?: boolean; contextRevoked?: boolean; receipt?: InitiativeActionReceipt | null; userSummary?: string; deferredReason?: string | null; cancellationReason?: string | null; createdAt?: number | ISODate; startedAt?: number | ISODate; finishedAt?: number | ISODate; hostSchedule?: { key?: string; scheduleId?: string }; /** A scheduled run's occurrence (执行 → 交付), as the host's schedule runtime records it; null when it is gone. */ occurrence?: Pick<Occurrence, 'key' | 'status' | 'deliveredAt'> | null; errorCode?: string; handoff?: string; content?: string; reasonForReview?: string; failure?: { code?: string; message?: string }; resultSummary?: string; controlRevision?: number; controls?: { id: string; kind: string; status: string }[]; blocksExecution?: boolean; availableControls?: string[]; attention?: { acknowledgedAt?: string; invitedAt?: string; needsUser?: boolean; alreadyReported?: boolean } | null }

/** Full project object (`/api/v2/projects/:id?include=…`); heavy fields only when included. */
export interface ProjectDetail extends ProjectSummary {
  focus?: string
  decisionMode?: string
  simulated?: boolean
  activeVersionId?: string | null
  trialVersionId?: string | null
  initiative?: { enabled?: boolean; quietUntil?: string | null; notificationMuted?: boolean; desktopNotifications?: boolean; digestHour?: number }
  taskTypes?: string[]
  skillFoundation?: (NonNullable<ProjectSummary['skillFoundation']> & { screening?: SkillScreening | null; [key: string]: unknown }) | null
  evolution?: { enabled?: boolean; request?: { status?: string; summary?: string } | null }
  initialization?: { status?: string; message?: string } | null
  schedules?: Schedule[]
  scheduleRuntime?: { occurrences?: Occurrence[] }
  observationSources?: ObservationSource[]
  versions?: VersionRecord[]
  jobs?: { id: string; status: string; handoff?: string }[]
  decisions?: DecisionRecord[]
  observations?: ObservationRecord[]
  initiativeRuntime?: ProjectSummary['initiativeRuntime'] & { sdkState?: { actions?: InitiativeAction[] }; availability?: { state?: string; title?: string; message?: string } }
  revision?: number
  [key: string]: unknown
}

/** P4 `project.skillFoundation.screening` (market_screen_v1). */
export interface SkillScreening {
  method?: string; taskTypes?: string[]
  review?: { status?: string; candidates?: number; code?: string } | null
  areas?: { id: string; taskType?: string; query?: string; candidates: number; screenSource?: string; fit?: number; reviewFit?: number; rejected?: number; selected?: { skillId: string; status?: string }[]; gap?: string }[]
}

export type ProjectInclude = 'versions' | 'jobs' | 'decisions' | 'observations' | 'learningRuntime' | 'initiativeRuntime' | 'facts' | 'memorySessions'

export interface FileEntry { name: string; path: string; type: 'file' | 'directory'; size: number | null }
export interface DirectoryListing { path: string; entries: FileEntry[]; truncated?: boolean }
export interface FileContent { path: string; content: string; language?: string; bytes?: number; truncated?: boolean }
export interface PreviewStatus {
  status: 'ready' | 'stopped' | 'starting' | 'unavailable' | string; kind?: 'static' | 'vite' | string; url?: string; entryPath?: string
  generation?: string; revision?: number; watchTruncated?: boolean; watchError?: unknown
  discovery?: { status?: string; reason?: string; candidates?: { id: string; mode: string; path: string; label: string; available: boolean }[] }
}

export interface CommandCatalog { sessionId: string; commands: { id: string; available: boolean; reason?: string }[] }
export interface ProjectSkill { id: string; name: string; description?: string; enabled?: boolean; builtin?: boolean; generated?: boolean; localId?: string }
export interface ProjectCapabilities { skills: ProjectSkill[]; assignments?: { skillIds?: string[] } }
/** `observed`: what the step's target looks like now (plan §2.5 item 8). */
export interface UncertainTool { callKey: string; toolName: string; arguments?: unknown; observed?: { path: string; exists: boolean; kind?: string; bytes?: number; lines?: number | null; lastLine?: string | null; modifiedAt?: string } }

/* ------------------------------------------------------------------ calls */

const req = <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal) =>
  getTransport().request<T>(path, { method, ...(body === undefined ? {} : { body }), signal })
const enc = encodeURIComponent
/** `&sessionId=…` for a read through a worktree conversation's root, else nothing. */
const scope = (sessionId?: string | null) => (sessionId ? `&sessionId=${enc(sessionId)}` : '')

/** A card under an empty conversation's composer, drawn from the project's real state (host: session-suggestions.mjs). */
export interface SessionSuggestion { kind: 'continue' | 'answer' | 'review' | 'plan' | 'check' | 'explore' | (string & {}); title: string; text: string }
export interface SessionSuggestions { projectId: string | null; suggestions: SessionSuggestion[]; source: 'model' | 'state' | 'starter' | (string & {}); refreshing: boolean; generatedAt?: string }

export const projectApi = {
  suggestions: (projectId: string | null, signal?: AbortSignal) => req<SessionSuggestions>(`/api/v2/suggestions${projectId ? `?projectId=${enc(projectId)}` : ''}`, 'GET', undefined, signal),
  detail: (projectId: string, include: ProjectInclude[]) =>
    req<ProjectDetail>(`/api/v2/projects/${enc(projectId)}${include.length ? `?include=${include.join(',')}` : ''}`),

  // tasks: schedules (project-schedules-ui.js)
  schedules: (projectId: string) => req<ScheduleList>(`/api/projects/${projectId}/schedules`),
  createSchedule: (projectId: string, body: Record<string, unknown>) => req(`/api/projects/${projectId}/schedules`, 'POST', body),
  updateSchedule: (projectId: string, id: string, body: Record<string, unknown>) => req(`/api/projects/${projectId}/schedules/${enc(id)}`, 'PATCH', body),
  deleteSchedule: (projectId: string, id: string) => req(`/api/projects/${projectId}/schedules/${enc(id)}`, 'DELETE', {}),

  // tasks: background actions (initiative-activity-ui.js, initiative-resolution-ui.js)
  actions: (projectId: string) => req<{ projectId: string; actions: InitiativeAction[] }>(`/api/projects/${enc(projectId)}/initiative/actions`),
  controlAction: (projectId: string, actionId: string, body: { action: string; requestId: string; expectedRevision: number; text?: string }) =>
    req<{ receipt?: { status?: string; summary?: string }; action?: { status?: string } }>(`/api/projects/${enc(projectId)}/initiative/actions/${enc(actionId)}/control`, 'POST', body),
  resolveAction: (projectId: string, actionId: string, body: { status: string; summary: string }) =>
    req(`/api/projects/${enc(projectId)}/initiative/actions/${enc(actionId)}/resolve`, 'POST', body),

  // versions (app.js versionAction / appendVersionCard / appendGenomeEditor)
  versionControl: (projectId: string, versionId: string, action: 'trial' | 'rollback' | 'adopt') =>
    req(`/api/projects/${projectId}/versions/${versionId}/control`, 'POST', { action }),
  evolution: (projectId: string, body: Record<string, unknown>) => req<Record<string, unknown>>(`/api/projects/${projectId}/evolution`, 'POST', body),

  // observations
  addObservation: (projectId: string, kind: string, text: string) =>
    req(`/api/projects/${projectId}/observations`, 'POST', { kind, text, eventId: crypto.randomUUID(), relevance: kind === 'note' ? 0.1 : 0.9 }),
  sources: (projectId: string) => req<{ projectId: string; sources: ObservationSource[] }>(`/api/projects/${projectId}/sources`),
  toggleSource: (projectId: string, sourceId: string, enabled: boolean) =>
    req<{ sources?: ObservationSource[] } & Partial<ObservationSource>>(`/api/projects/${projectId}/sources/${sourceId}`, 'PATCH', { enabled }),
  quiet: (projectId: string, quietUntil: string | null) => req(`/api/projects/${projectId}`, 'PATCH', { initiative: { quietUntil } }),

  // files + preview (files-ui.js). `sessionId` (0.63): read through that conversation's root — its own worktree when
  // it runs in one (lib/session-root `readSessionFor`); absent, the project folder.
  list: (projectId: string, path: string, signal?: AbortSignal, sessionId?: string | null) => req<DirectoryListing>(`/api/projects/${projectId}/files?path=${enc(path)}${scope(sessionId)}`, 'GET', undefined, signal),
  read: (projectId: string, path: string, signal?: AbortSignal, sessionId?: string | null) => req<FileContent>(`/api/projects/${projectId}/file?path=${enc(path)}${scope(sessionId)}`, 'GET', undefined, signal),
  downloadUrl: (projectId: string, path: string, sessionId?: string | null) => `/api/projects/${projectId}/file/download?path=${enc(path)}${scope(sessionId)}`,
  rawUrl: (projectId: string, path: string, sessionId?: string | null) => `/api/projects/${projectId}/file/raw?path=${enc(path)}${scope(sessionId)}`,
  /** Complete file bytes with the host's MIME type (file preview: images, PDF, spreadsheets). */
  readBlob: (projectId: string, path: string, signal?: AbortSignal, sessionId?: string | null) => readFileBlob(projectId, path, signal, sessionId),
  preview: (projectId: string, signal?: AbortSignal) => req<PreviewStatus>(`/api/projects/${projectId}/preview`, 'GET', undefined, signal),
  startPreview: (projectId: string, body: Record<string, unknown>, signal?: AbortSignal) => req<PreviewStatus>(`/api/projects/${projectId}/preview`, 'POST', body, signal),
  stopPreview: (projectId: string) => req(`/api/projects/${projectId}/preview`, 'DELETE', {}),

  // capabilities (skill names + composer skill attach)
  capabilities: (projectId: string) => req<ProjectCapabilities>(`/api/projects/${enc(projectId)}/capabilities`),

  // session commands (composer-commands.js, app.js executeHostCommand)
  commands: (sessionId: string) => req<CommandCatalog>(`/api/sessions/${sessionId}/commands`),
  runCommand: (sessionId: string, command: string, requestId: string, args: Record<string, unknown>) =>
    req<{ result?: { compacted?: boolean } }>(`/api/sessions/${sessionId}/commands`, 'POST', { command, requestId, args }),

  // recovery + emergency (session-recovery-ui.js, settings)
  backgroundChange: (projectId: string, changeId: string) => req<BackgroundChangeDetail>(`/api/projects/${enc(projectId)}/background-changes/${enc(changeId)}`),
  /** The user's call on background work: failed → continue | drop; unconfirmed outcome → keep | drop; a finished result marked 需要你 → acknowledge (知道了). */
  answerTask: (projectId: string, actionId: string, choice: 'continue' | 'drop' | 'keep' | 'acknowledge') => req<{ revision: number }>(`/api/v2/projects/${enc(projectId)}/tasks/${enc(actionId)}`, 'POST', { choice }),
  revertBackgroundChange: (projectId: string, changeId: string) => req<{ status: string; outcome?: { restored: string[]; conflicts: string[]; failed: string[] } | null }>(`/api/projects/${enc(projectId)}/background-changes/${enc(changeId)}/revert`, 'POST', {}),
  /**
   * 0.63: a git set applied by several records rolls them all back as one, in two steps (as the apply routes): without
   * `confirm` what would be restored and a one-time token, with it the rollback (`status: 'reverted'`).
   */
  revertGitChange: <T>(projectId: string, changeId: string, input: { paths?: string[]; force?: string[]; confirm?: string } = {}) => req<T>(`/api/projects/${enc(projectId)}/background-changes/${enc(changeId)}/revert`, 'POST', input),
  recovery: (sessionId: string, conclusion: { callKey: string; status: string; note: string } | { choice: 'continue' | 'redo' }) => req(`/api/sessions/${sessionId}/recovery`, 'POST', conclusion),
  emergency: (stop: boolean) => req(`/api/emergency`, 'POST', { stop }),

  // E2 background subagents
  agents: (sessionId: string) => req<{ sessionId: string; revision: number; agents: SubagentInfo[] }>(`/api/v2/sessions/${enc(sessionId)}/agents`),
  cancelAgent: (sessionId: string, agentId: string) => req<SubagentInfo>(`/api/v2/sessions/${enc(sessionId)}/agents/${enc(agentId)}/cancel`, 'POST', {}),
  messageAgent: (sessionId: string, agentId: string, message: string) =>
    req<{ agentId: string; delivered: boolean; status: string; reason?: string }>(`/api/v2/sessions/${enc(sessionId)}/agents/${enc(agentId)}/message`, 'POST', { message }),
}

/** `/api/sessions/:id/export.zip` is binary, so it bypasses the JSON transport. */
export async function exportSession(sessionId: string): Promise<Blob> {
  const transport = getTransport()
  if (transport.kind === 'mock') return new Blob([`mock export for ${sessionId}\n`], { type: 'application/zip' })
  const response = await fetchOrFail(`/api/sessions/${sessionId}/export.zip`)
  if (!response.ok) {
    let message = t('导出失败')
    try { message = ((await response.json()) as { error?: string }).error ?? message } catch { /* not JSON */ }
    throw new ApiError(message, response.status)
  }
  return response.blob().catch(error => { throw transportFailure(error) })
}

export interface FileBlob { blob: Blob; type: string; size: number }

async function readFileBlob(projectId: string, path: string, signal?: AbortSignal, sessionId?: string | null): Promise<FileBlob> {
  if (getTransport().kind === 'mock') {
    const { mockFileBlob } = await import('@/mock/preview-fixtures')
    const blob = await mockFileBlob(path)
    signal?.throwIfAborted()
    if (!blob) throw new ApiError(t('文件或目录不存在。'), 404, 'WORKSPACE_NOT_FOUND')
    return { blob, type: blob.type, size: blob.size }
  }
  let response = await fetchOrFail(`/api/projects/${projectId}/file/raw?path=${enc(path)}${scope(sessionId)}`, { signal })
  // A daemon from before the raw route answers 404 without a workspace error code.
  if (response.status === 404 && !(await errorOf(response.clone())).code) response = await fetchOrFail(`/api/projects/${projectId}/file/download?path=${enc(path)}${scope(sessionId)}`, { signal })
  if (!response.ok) {
    const error = await errorOf(response)
    throw new ApiError(error.message ?? t('请求失败 ({status})', { status: response.status }), response.status, error.code)
  }
  const blob = await response.blob().catch(error => { throw transportFailure(error) })
  return { blob, type: response.headers.get('content-type') ?? blob.type, size: Number(response.headers.get('x-file-size')) || blob.size }
}

async function errorOf(response: Response): Promise<{ message?: string; code?: string }> {
  try { const value = (await response.json()) as { error?: string; code?: string }; return { message: value.error, code: value.code } } catch { return {} }
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Legacy `retained` filter: records the host has withdrawn stay hidden. */
export const retained = (row: { deletedAt?: string | null; sourceDeleted?: boolean; contextRevoked?: boolean; status?: string } | null | undefined) =>
  Boolean(row) && !row!.deletedAt && !row!.sourceDeleted && !row!.contextRevoked && !['withdrawn', 'superseded'].includes(row!.status ?? '')

export type { ProjectSummary, SessionSummary }
