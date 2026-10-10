/**
 * Types for the global panels (settings, memory, capabilities, archive,
 * projects). They mirror what the daemon returns today (see server.mjs and the
 * legacy public/*.js consumers); every field the UI does not strictly need is
 * optional so older daemons degrade instead of crashing.
 */
import type { ISODate, ModelSelection, ProjectSummary, ProviderModel, ReasoningCapability } from './types'

/* ---------------------------------------------------------- configuration */

export type AuthMode = 'api_key' | 'subscription' | 'coding_plan'
export type ProviderProtocol = 'openai' | 'anthropic' | 'openai-codex' | 'demo' | string

export interface InputCapability {
  status: 'known' | 'unknown' | string
  source: 'catalog' | 'provider' | 'configured' | 'unknown' | string
  input?: string[]
  url?: string
  sourceUrl?: string
  checkedAt?: string
}

export interface CatalogSource { url?: string; checkedAt?: string }

export interface ModelSpec extends Partial<ProviderModel> {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  modelMaxOutputTokens?: number | null
  reasoning?: string[]
  reasoningCapability?: ReasoningCapability
  input?: string[]
  inputCapability?: InputCapability
  source?: CatalogSource
  compat?: Record<string, unknown>
  cacheRetention?: unknown
  catalogDefaults?: (ModelSpec & { source?: CatalogSource }) | null
  limitsSource?: { contextWindow?: 'custom' | string }
  discoverySource?: { url?: string }
  useCatalogLimits?: boolean
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKeyEnv?: string
  apiKeyConfigured?: boolean
  credentialSource?: string
  authMode?: AuthMode
  authProvider?: string
  presetId?: string
  autoDiscoverModels?: boolean
  usagePolicy?: 'interactive_only' | string
  subscription?: { authenticated?: boolean }
  /** Media kinds a ChatGPT login serves, with the only model ids each accepts. */
  subscriptionMedia?: Partial<Record<MediaKind, string[]>>
  modelDiscovery?: { checkedAt?: ISODate; discovered?: number; unknown?: number; connectionVerified?: boolean }
  /** Model ids the user removed from the catalog; a refresh does not add them back until they are saved again. */
  removedModels?: string[]
  models: ModelSpec[]
  createdAt?: ISODate
}

export interface ProviderPreset {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKeyEnv?: string
  authMode?: AuthMode
  models?: ModelSpec[]
  notes?: string
  checkedAt?: string
}

export interface MemoryConfig {
  /** 'openviking': a server with semantic search; 'embedded': the built-in store in this app, keyword search, no outside service. */
  backend?: 'openviking' | 'embedded'
  endpoint?: string
  apiKeyEnv?: string
  apiKeyConfigured?: boolean
  autoRecall?: boolean
  autoStore?: boolean
  contextBudget?: number
  limit?: number
}

/** A web search service the daemon can use: whether it needs a key, and whether it reads pages itself ('service') or leaves that to this machine ('direct'). */
export interface WebToolProvider { id: string; label: string; baseUrl: string; key: 'optional' | 'required'; reader: 'service' | 'direct' }
export interface WebToolsCheck { ok?: boolean; provider?: string; service?: string; reader?: string; code?: string; checks?: { tool: string; ok: boolean; code?: string }[] }
export interface WebToolsConfig {
  enabled?: boolean
  provider?: string
  baseUrl?: string
  timeoutMs?: number
  apiKeyEnv?: string
  apiKeyConfigured?: boolean
}

export type MediaKind = 'image' | 'speech' | 'transcription' | 'video'
export interface MediaModelChoice {
  providerId: string
  modelId: string
  editApi?: 'openai' | 'generations'
  api?: 'openai' | 'zhipu' | 'ark' | 'siliconflow' | 'dashscope'
  voice?: string
}

export interface FullConfiguration {
  providers: ProviderConfig[]
  media?: Partial<Record<MediaKind, MediaModelChoice>> & { vision?: { providerId: string; modelId: string } }
  defaultModel?: ModelSelection | null
  /** Internal calls' reasoning effort (proactive decisions, background work, subtasks…): `auto` uses the provider
   * default where it adapts, otherwise JEV picks per task (recorded only while `routing` is `shadow`); `chat` = the chat level. */
  internalReasoning?: { mode: 'auto' | 'chat'; routing: 'shadow' | 'route'; capture: boolean; /** What `route` sends (decision, narrator); work, setup and compaction never route by this setting. */ purposes?: Array<'decision' | 'narrator'> }
  memory?: MemoryConfig
  webTools?: WebToolsConfig
  webToolProviders?: WebToolProvider[]
  providerPresets?: ProviderPreset[]
  runtime?: { modelExecution?: string; sdkVersion?: string }
}

export interface SubscriptionAuthState {
  state?: 'awaiting_authorization' | string
  authenticated?: boolean
  loginState?: 'complete' | string
  attemptId?: string
  authorizationUrl?: string
  verificationUrl?: string
  userCode?: string
  canPasteCallback?: boolean
  error?: string
}

export interface ProviderTestModel extends ModelSpec {
  readyForAgent?: boolean
  readyForConfiguration?: boolean
  unavailableReason?: 'no-tool-calling' | string
}
export interface ProviderTestResult { ok?: boolean; message?: string; connectionVerified?: boolean; models?: ProviderTestModel[] }
export interface ProviderRefreshResult { message?: string; connectionVerified?: boolean; provider: ProviderConfig }

/* ------------------------------------------------------------ app settings */

export interface AppSettings {
  dailyBudget?: number
  tokenBudget?: number
  maxConcurrent?: number
  realTokenBudget?: number | null
  proactive?: boolean
}

export interface Health {
  version?: string
  sdkVersion?: string
  node?: string
  workload?: { tokenUsage?: { reported?: number; estimated?: number; reserved?: number }; activeSessions?: number }
}

/* --------------------------------------------------------- decision kernel */

export type JudgmentPoint = 'initiative.review' | 'evolution.review' | 'chat.preflight' | 'chat.route' | 'delivery.reach' | 'skill.screen' | 'candidate.prescore'
  | 'turn.route' | 'initiative.gate' | 'message.check' | 'memory.filter' | 'tool.risk'
export type JudgmentMode = 'off' | 'shadow' | 'active'
export type JudgmentBackend = 'typesafe' | 'llm' | 'off'

export interface PlanSource { kind?: string; modelId?: string; createdAt?: ISODate; turnId?: string }
export interface AssessmentDisplay { key?: string; title?: string; type?: 'boolean' | 'choice' | 'score' | string; optionLabel?: string; probability?: number; score?: number }
export interface DecisionEntry {
  id?: string
  at?: number | string
  point?: string
  backend?: string
  source?: string
  reason?: string
  disposition?: string
  cached?: boolean
  planRevision?: string
  planSource?: PlanSource
  assessmentDisplay?: AssessmentDisplay[]
  latencyMs?: number
  usage?: { inputTokens?: number; outputTokens?: number }
  execution?: { latencyClass?: string }
}
/** Read-only diagnostic override (environment `RNA_JEV_*`, or a host/test config flagged `diagnostic`). */
export interface JudgmentDiagnosticOverride { env?: { mode?: JudgmentMode; backend?: JudgmentBackend; modes?: Partial<Record<string, JudgmentMode>> }; saved?: boolean }
export type JudgeOrderStep = 'typesafe' | 'fast_model_llm_judge' | 'none' | string
export interface DecisionKernelConfig {
  provider?: string
  model?: string | null
  /** Effective judge backend (read-only; chosen automatically TypeSafe → fast model → none). */
  backend?: JudgmentBackend
  /** Legacy alias of `fastModel` (the judge model is the fast model). */
  llmModel?: { providerId: string; modelId: string }
  /** Effective state only (read-only; never sent back). */
  mode?: JudgmentMode
  modes?: Partial<Record<JudgmentPoint, JudgmentMode>>
  /** 自动选择模型: run simple turns on the fast model when turn.route says so (default off). */
  autoModel?: boolean
  /** K2 v2: the only user-editable keys and the automatic judge order. */
  settings?: { editable?: string[]; judgeOrder?: JudgeOrderStep[] }
  diagnosticOverride?: JudgmentDiagnosticOverride | null
  apiKeyConfigured?: boolean
  status?: 'ready' | 'off' | 'not_configured' | string
  route?: { available: boolean; backend: string | null; point?: string }
  plans?: { projectId: string; projectName?: string; revision?: string; source?: PlanSource; questionCount?: number; questionKeys?: string[] }[]
  planReadyCount?: number
  metrics?: { requests?: number; cacheHits?: number; fallbacks?: number; totalTokens?: number; lastLatencyMs?: number | null }
  performance?: { groups?: { point: string; mode?: string; measuredRequests?: number; p50Ms?: number | null; p95Ms?: number | null; reportedTokens?: number; unknownUsageRequests?: number; legacyUnmeasured?: number }[] }
  recent?: DecisionEntry[]
  /** H5 contract: server-described points, read-only thresholds and a 7-day calibration summary. */
  points?: DecisionPointInfo[]
  thresholds?: Record<string, unknown> & { version?: number }
  thresholdsEditable?: false
  calibration?: Record<string, CalibrationSummary>
  fastModel?: { providerId: string; modelId: string } | null
  /** TYPESAFE_ENDPOINT (environment only; never editable). */
  endpoint?: string | null
  /** Whether the saved TypeSafe key works; null without one, absent on older daemons. */
  credential?: JudgmentCredential | null
}
/** `source`: the settings page's key check or the latest real judgment. */
export interface JudgmentCredential { state: 'valid' | 'invalid' | 'payment_required' | 'unverified'; at?: number; source?: 'check' | 'ledger'; reason?: string }

export type DecisionStake = 'low' | 'medium' | 'high'
export interface DecisionPointInfo {
  point: JudgmentPoint | string; title?: string; stake?: DecisionStake; effect?: string; mode?: JudgmentMode; builtIn?: boolean
  templateVersion?: number | null; legacy?: boolean; supersedes?: string[]; rides?: string
}
export interface CalibrationSavings { mainModelCalls?: number; auxiliaryCalls?: number; latencyMs?: number }
export interface CalibrationSummary { decisions: number; coverage: number | null; abstainRate: number | null; labeled: number; savings?: CalibrationSavings }
export interface CalibrationBucket { range: [number, number]; n: number; predicted: number | null; observed: number | null }
export interface CalibrationQuestion { n: number; labeled: number; brier: number | null; buckets: CalibrationBucket[] }
export interface CalibrationReport extends CalibrationSummary {
  point: string | null; window: CalibrationWindow; thresholdsVersion?: number; thresholdChanges?: string
  scored?: number; decided?: number; applied?: number
  unscoredReasons?: Record<string, number>; modes?: Record<string, number>
  latency?: { p50: number | null; p95: number | null }; tokens?: number
  questions?: Record<string, CalibrationQuestion>
  points?: Record<string, CalibrationReport>
}
export type CalibrationWindow = '24h' | '7d' | '30d' | 'all'


/* ------------------------------------------------------------- maintenance */

export interface MaintenanceStage {
  name: string
  status?: string
  elapsedMs?: number
  reconciled?: boolean
  failureType?: string
  nativePreflight?: { context?: string; status?: string; cleanup?: string }
  checkpoint?: { phase?: string; changes?: { pathIdentity?: string; fields?: string[] }[] }
}
export interface MaintenanceAttempt { number?: number; status?: string; elapsedMs?: number; stages?: MaintenanceStage[] }
export interface MaintenanceOperation {
  id?: string
  requestId?: string
  kind?: string
  phase?: string
  summary?: string
  errorCode?: string
  startedAt?: ISODate
  completedAt?: ISODate
  attemptCount?: number
  attempts?: MaintenanceAttempt[]
  questionHandoff?: { capability?: string; suspended?: number; blocked?: number }
}
export interface MaintenanceCandidate {
  id: string
  hostVersion?: string
  sdkVersion?: string
  digest?: string
  trust?: string
  preparedAt?: ISODate
  baselineOnly?: boolean
  canApply?: boolean
  canRollback?: boolean
}
export interface MaintenanceCheckpoint { id: string; createdAt?: ISODate; files?: number; bytes?: number; verified?: boolean }
export type MaintenanceAction = 'prepare' | 'backup' | 'apply' | 'rollback' | 'restore' | 'cancel'
export interface MaintenanceState {
  current?: { hostVersion?: string; sdkVersion?: string }
  busy?: boolean
  held?: boolean
  capabilities?: Partial<Record<MaintenanceAction, boolean>>
  operation?: MaintenanceOperation | null
  candidates?: MaintenanceCandidate[]
  checkpoints?: MaintenanceCheckpoint[]
  history?: MaintenanceOperation[]
}

/* ------------------------------------------------------------------ memory */

export interface MemoryEntry {
  uri: string
  expandUri?: string
  title?: string
  displayTitle?: string
  displayExcerpt?: string
  summary?: string
  content?: string
  isDirectory?: boolean
  isLeaf?: boolean
  kind?: 'memory' | 'resource' | string
  modifiedAt?: ISODate
  availableReads?: ('L0' | 'L1' | 'L2')[]
  summaryStatus?: 'unavailable' | string
  provenance?: { kind?: string; role?: string; itemId?: string; createdAt?: ISODate }
}
export interface MemoryBrowseResponse {
  uri?: string
  namespace?: string
  view?: 'recent' | string
  offset?: number
  limit?: number
  hasMore?: boolean
  nextOffset?: number
  paginationLimited?: boolean
  entries?: MemoryEntry[]
  collection?: { memoryFiles?: number; resourceFiles?: number; directories?: number; complete?: boolean; checkedAt?: string }
  warnings?: { code?: string }[]
}
export interface MemorySearchResponse { backend?: string; entries?: MemoryEntry[] }
export interface MemoryReadResponse { content?: string; level?: 'L0' | 'L1' | 'L2' }
export type MemoryFilter = 'all' | 'memory' | 'resource'

/* ------------------------------------------------------------ capabilities */

export type CapabilityKind = 'skills' | 'mcpServers' | 'tools'
export interface CapabilityManifest {
  id: string
  name?: string
  description?: string
  enabled?: boolean
  builtin?: boolean
  generated?: boolean
  trusted?: boolean
  permission?: 'read' | 'write' | 'exec' | string
  transport?: 'http' | 'stdio' | string
  discoveredTools?: { name: string; granted?: boolean; permission?: string }[]
}
export interface CapabilityInstallation {
  installationId?: string
  status?: string
  entries: { kind: CapabilityKind; id: string }[]
  sources: { type: string; name?: string; version?: string; commit?: string; repository?: string }[]
}
export interface BuiltinAgentLimits { depth: number; callsPerTurn: number; concurrent: number; concurrentTotal?: number; steps: number; finalSummarySteps: number }
export interface CapabilityCatalog {
  projectId?: string
  skills?: CapabilityManifest[]
  mcpServers?: CapabilityManifest[]
  tools?: CapabilityManifest[]
  assignments?: { skillIds?: string[]; toolIds?: string[]; mcpServerIds?: string[] }
  installations?: CapabilityInstallation[]
  /** limits.concurrent: children running at once per conversation; concurrentTotal: across all conversations (hosts before 0.62.0 omit it). */
  builtinAgents?: { id: string; name: string; description?: string; readOnly?: boolean; limits?: BuiltinAgentLimits }[]
  builtinPlugins?: { id: string; name: string; capabilities: string[] }[]
}
export interface CapabilityInspectResult {
  name?: string
  version?: string
  description?: string
  repository?: string
  source?: string
  scripts?: string[]
  servers?: { id: string; package?: string; transport?: string }[]
}
export interface CapabilityInstallInput {
  kind: 'skill' | 'mcp'
  activate: boolean
  name?: string
  reason: string
  toolPermission?: 'exec'
  requestId?: string
  source: Record<string, unknown>
}

export interface MarketplaceProvider { id: string; name: string; docsUrl?: string; authentication?: 'configured' | 'anonymous_limited' | 'not_required' | string }
export interface MarketplaceResult { id: string; provider?: string; name: string; description?: string; repository?: string; sourceUrl?: string; catalogUrl?: string }
export interface MarketplaceRead {
  path: string
  repository?: string
  subdirectory?: string
  commit: string
  contentHash?: string
  bytes?: number
  content?: string
  licenseFiles?: { path: string; resourcePath: string }[]
  resources?: { path: string; bytes?: number }[]
  installInput?: { kind?: string; source?: { type?: string; repository?: string; subdirectory?: string; ref?: string } }
}

/* -------------------------------------------------------- projects/sessions */

export interface ProjectDetail extends ProjectSummary {
  workspace?: string
  focus?: string
  decisionMode?: string
  simulated?: boolean
  memory?: { namespace?: string }
  memorySummary?: { status?: string; message?: string; code?: string | null } | null
  initiative?: {
    enabled?: boolean; notificationMuted?: boolean; deferWhileTyping?: boolean
    reviewMinMs?: number; reviewMaxMs?: number; cooldownMs?: number
    minRelevance?: number; budgetUsd?: number; spentUsd?: number; tokenBudget?: number | null; tokens?: number
    quietUntil?: ISODate | null; modelSelection?: ModelSelection | null
    /** P3: notify tier opt-in (default off) and local hour of the daily digest (default 9). */
    desktopNotifications?: boolean; digestHour?: number
  }
  evolution?: { enabled?: boolean; minIntervalMs?: number }
  rhythm?: { control?: 'auto' | 'manual' }
}

export interface PermissionsResponse {
  projectId?: string
  workspace: string
  settings: { workspace: 'read' | 'write' | 'execute'; background: 'read' | 'inherit' }
  effective: { foreground: 'read' | 'write' | 'execute'; background: 'read' | 'write' | 'execute' }
  inheritedAssignments?: boolean
  description?: string
}

export interface DirectoryListing {
  path: string
  name?: string
  parent?: string | null
  entries: { name: string; path: string; symlink?: boolean }[]
  nextOffset?: number | null
  projects: { id: string; name: string; archivedAt?: ISODate | null }[]
}
export interface WorkspaceOpenResult { project: ProjectSummary; session?: { id: string } | null; reused?: boolean }
/** A session DELETE answers with that conversation's cleanup; a project DELETE with the aggregate and each conversation's. */
export interface DeleteResult { cleanup?: { status?: 'completed' | 'pending' | 'blocked' | string; sessions?: Array<{ sessionId: string; status?: string }> } }
