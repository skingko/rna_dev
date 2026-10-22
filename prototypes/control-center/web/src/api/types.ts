/**
 * Types for the host interface contract v2 (docs/specs/stream-protocol-v2.md).
 * Fields are additive over the legacy session shape, so everything the
 * backend has not shipped yet is optional and the UI degrades gracefully.
 */
// The index rows' field names are the host's allowlists (prototypes/control-center/index-schema.mjs).
import type {
  ArchivedProjectSummaryField, InitializationField, InitiativeRuntimeField, MemorySummaryField, OccurrenceField, ProjectSummaryField,
  ScheduleField, SessionSummaryField, SkillFoundationField,
} from '../../../index-schema.mjs'
import type { Occurrence, Schedule } from './project-api'

export type ISODate = string

export type ReasoningVisibility = 'full' | 'summary' | 'hidden'

export interface ThinkingBlock {
  text: string
  startedAt?: ISODate | null
  endedAt?: ISODate | null
  tokens?: number | null
  visibility?: ReasoningVisibility
}

export type ToolKind =
  | 'read' | 'write' | 'edit' | 'search' | 'command' | 'web_search' | 'web_fetch'
  | 'skill' | 'mcp' | 'question' | 'plan' | 'other'

export type ToolStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | string

export interface ToolCall {
  id?: string
  callKey?: string
  name: string
  args?: Record<string, unknown>
  status?: ToolStatus
  output?: string
  // v2 additions
  kind?: ToolKind
  target?: string
  argsPreview?: string
  /** Client-only: a pending entry whose arguments are still streaming (never persisted). */
  preparing?: boolean
  /** Provider stream position of a pending call (display-only). */
  index?: number
  /** Files a media tool wrote into the project (image_generate, speech_generate, video_generate). */
  files?: { path: string; mimeType: string; bytes: number }[]
  /** A whole-file write: true when it made a new file, false when it replaced one (C-b, from the SDK receipt). */
  created?: boolean
  startedAt?: ISODate | null
  endedAt?: ISODate | null
}

export interface QuestionOption { id: string; label: string; description?: string }
export interface Question {
  id: string
  header?: string
  question: string
  /** What the question is about in more words (a permission request's reason, directory and scope). */
  detail?: string
  multiSelect?: boolean
  allowCustom?: boolean
  options: QuestionOption[]
}
export interface Interaction {
  kind: 'question' | 'permission' | string
  id: string
  source?: 'tool' | 'initiative' | string
  status: 'pending' | 'answered' | 'cancelled' | 'interrupted' | string
  canRespond?: boolean
  questions?: Question[]
  answers?: { id: string; selected: string[]; custom?: string }[]
  answeredAt?: ISODate
  permission?: { workspace?: string; background?: string; projectId?: string; workspacePath?: string; reason?: string }
}

export interface ItemUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheUsageReported?: boolean
}

/** A file the agent presented (`project_present`): workspace-relative `path`, file `name`, one-line `description`. */
export interface PresentedFile { path: string; name?: string; description?: string }
export interface WelcomeBackTopic { threadId: string; title: string; text: string; deliverables?: PresentedFile[] }

export interface Attachment { id?: string; name: string; type?: string; size?: number }

export interface Item {
  id: string
  turnId?: string | null
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'question' | string
  text: string
  createdAt: ISODate
  simulated?: boolean
  /** notice: still running (a manual compaction); the text becomes its outcome when it ends */
  progress?: boolean
  streaming?: boolean
  source?: string | null
  delivery?: 'send' | 'steer' | 'followup' | string
  attachments?: Attachment[]
  /** lesson.applied: the first time a lesson from the user's feedback is followed, one quiet note on that reply. */
  lessonNote?: { lessonId: string; text: string } | null
  /** P3: `reach` is the actual tier; daily digests are `{ kind: 'digest', reach: 'digest', entryIds, lines }`. */
  initiative?: {
    kind?: string; reach?: string; entryIds?: string[]; threadId?: string | null
    /** F10 `digest`: the first line of each digested entry, in order. Older rows lack it and the card parses `text`. */
    lines?: string[]
    /** F10 `thread_close`: what the row says, as fields; the web writes the sentence in the interface language. Older rows lack them and show `text`. */
    title?: string
    resolution?: string | null
    status?: 'done' | 'resolved'
    /** K2 narrator: `welcome_back` covers several threads (same order as `topics`). */
    threadIds?: string[]
    /** K2 v2 `welcome_back`: one entry per topic in display order; `overflowCount` more went to the inbox. */
    topics?: WelcomeBackTopic[]
    overflowCount?: number
    /** Plan §4.4: this line reports a background change set that can be reverted. */
    backgroundChange?: string
    /** This background-work line belongs to a scheduled run the user set up (badge 定时任务). */
    scheduledWork?: boolean
    /** The line of one writing background run: posted when it starts, completed in place when it ends. */
    backgroundWork?: { actionId: string; status: 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'stopped' | 'unreported' | 'interrupted'; startedAt?: string; endedAt?: string }
    /** K2 v2: files the agent declared with `project_present` (1–5). */
    deliverables?: PresentedFile[]
    /** K2 v1 only (older items): the full text before condensing. No longer produced. */
    details?: string | null
    narrated?: { version?: number; count?: number; outcome?: string; reasons?: string[]; via?: string } | null
  } | null
  /** v2 mind: the reader's 👍/👎 on an assistant message (echoed by the host). */
  feedback?: { vote: 'up' | 'down' | null; comment?: string | null; at?: ISODate } | null
  scheduleOccurrenceKey?: string
  tool?: ToolCall
  interaction?: Interaction
  usage?: ItemUsage
  // v2 additions (assistant)
  thinking?: ThinkingBlock
  startedAt?: ISODate | null
  firstTokenAt?: ISODate | null
  endedAt?: ISODate | null
  /** Client-only: optimistic user message awaiting the server echo. */
  optimistic?: boolean
  /** Client-only: id of the pending (preparing) tool entry this durable tool item replaced. */
  preparedFrom?: string
  // E2: background subagents (kind 'subagent'), and their deliveries (source 'subagent')
  subagent?: SubagentInfo
  agentId?: string
  /** A subagent delivery's readable line (C-c); `text` keeps the prompt written for the model. */
  displayText?: string | null
  /** S2: a side-chat answer the user added to the main conversation (`kind: 'notice'`, `source: 'side-chat'`). */
  sideChat?: { sessionId: string; itemId?: string; title?: string } | null
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | string

export interface SubagentInfo {
  agentId: string
  role?: 'scout' | 'planner' | 'reviewer' | 'worker' | string
  roleName?: string
  task?: string
  status: SubagentStatus
  background?: boolean
  startedAt?: ISODate | null
  endedAt?: ISODate | null
  summary?: string | null
  usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; estimated?: boolean } | null
  code?: string
  cleanupUncertain?: boolean
  delivery?: 'awaiting' | 'joined' | 'reported' | 'pending' | 'steered' | 'noticed' | 'woke' | 'none' | string
  turnId?: string | null
  toolCallId?: string | null
  toolCount?: number
  lastTool?: string | null
  messages?: number
  output?: string
  /** P-4: the model the child ran on (from its turn's modelConfig); absent on older hosts. */
  model?: RunModel | null
  /** 0.63 (§8.6): how a worker's changes reached the parent's files; absent for read-only roles and older hosts. */
  merge?: SubagentMerge | null
  /** 0.63: the worker's own worktree (GET …/worktrees row id), while it has one. */
  worktreeId?: string | null
}

/* ---- Worktree isolation (0.63; contract v2 §8.6–8.8) ---- */

/** Why isolation is off for a project (`isolation.reason`); `not_ready`: the release gate is still closed. */
export type IsolationReason = 'not_ready' | 'sandbox_unavailable' | 'git_unavailable' | 'git_too_old' | 'no_repository' | 'custom_git_drivers' | 'workspace_missing'
/**
 * What kind of conflict a file has. content: overlapping text edits; binary; modify_delete: changed on one side,
 * deleted on the other; add_add: added on both; rename; type: file versus folder or link; submodule, case_collision,
 * unsafe_symlink, unsafe_hardlink: left to the user; changed_during_merge / unexpected_file: the file moved while
 * the host wrote.
 */
export type ConflictKind = 'content' | 'binary' | 'modify_delete' | 'add_add' | 'rename' | 'type' | 'other' | 'submodule' | 'case_collision' | 'unsafe_symlink' | 'unsafe_hardlink' | 'changed_during_merge' | 'unexpected_file'
export interface ConflictPath { path: string; kind: ConflictKind | (string & {}) }

/** A session that runs in its own worktree (absent = it works in the project folder itself). Chosen at creation only. */
export interface SessionWorktree { id: string; state: 'pending' | 'active' | 'missing' | 'kept' | (string & {}) }

export type TurnApplyStatus = 'none' | 'applying' | 'applied' | 'conflicted' | 'pending'
/** A worktree session's turn: whether its changes reached the project folder (footer). */
export interface TurnApply {
  status: TurnApplyStatus | (string & {})
  /** Apply records written for this turn (a pause and the finish each write one), oldest first. */
  applyIds: string[]
  /** Files that also had the user's own changes in the project folder (merged). */
  bothChanged?: number
  /** Still conflicted: the card above the composer decides (`attempts`: host continuations used). */
  conflict?: { id: string; preMerge?: string; paths: ConflictPath[]; attempts: number } | null
  /** Ignored folders the worktree has and the project folder lacks (e.g. `dist/`): never applied. */
  ignoredNew?: string[]
  /** A dependency manifest or lock file was applied: the project folder may need a reinstall. */
  dependencies?: boolean
  /**
   * The card above the composer that decides this turn's conflict (HOST_CARDS.sessionConflict; a later card of the
   * same turn has actionId `worktree-apply:<turnId>:<n>`); `answered`: the option the user chose, once the host took it
   * up (rna | conversation | project | later).
   */
  card?: { interactionId: string; actionId?: string | null; answered?: string | null } | null
  /** `pending`: why the changes stay in the worktree for now (the project is read-only or archived, the write failed, a new turn started). */
  reason?: TurnApplyHeldReason | (string & {}) | null
  /** A later turn whose apply settled this turn's conflict. */
  settledBy?: string | null
}
export type TurnApplyHeldReason = 'read_only' | 'archived' | 'blocked' | 'aborted' | 'git_operation'
/**
 * A direct-mode turn's checkpoint (git projects): `skipped` turns cannot be rolled back as a whole; `expired`: its
 * refs were swept after the retention period (30 days), so it cannot be rolled back as a whole any more.
 */
/** `endedAt` (taken): when the latest attempt's end snapshot was recorded; each attempt of the turn (a retry, a resume) records its own. */
export interface TurnCheckpoint { ref?: string; state: 'taken' | 'skipped' | 'expired' | (string & {}); reason?: 'timeout' | 'no_repository' | 'snapshot_failed' | 'read_only' | (string & {}); endedAt?: ISODate }

export type SubagentMergeStatus = 'pending' | 'merged' | 'conflict' | 'dropped' | 'nothing' | 'shared_root'
/** A worker's merge into its parent's root (subagent card line and buttons). */
export interface SubagentMerge {
  status: SubagentMergeStatus | (string & {})
  applyIds?: string[]
  conflicts?: ConflictPath[]
  /** Files merged into the parent's files. */
  files?: number
  /** pending: `unfinished` | `parent_idle` | `cancelled` | `read_only` | `apply_interrupted` (a merge a restart cut off; the "interrupted apply" card settles it) | `git_operation` (the user's git operation in the project folder; the host merges it when that ends only if a turn of the conversation is running then, else it becomes `parent_idle`); shared_root: an IsolationReason. */
  reason?: string
  /** pending `git_operation`: which one (merge, rebase, cherry-pick, revert, bisect). */
  operation?: string
}

/** The project's git settings in its summary (`applies` and `worktrees` are fetched from their routes). */
export interface ProjectGitSummary {
  /** New conversations start in their own worktree (the composer switch's initial value). */
  sessionWorktreeDefault: boolean
  /** Rna made this folder a repository (git init). */
  init?: { at: ISODate; by: 'rna'; commit: string; branch: string } | null
}

/** A model as the host names it for display (provider, model id, readable name); never carries keys. */
export interface RunModel { providerId: string; modelId: string; name: string }

export type WorkRunKind = 'work' | 'scheduled' | 'learn'
export type WorkRunStatus = 'queued' | 'running' | 'paused' | 'needs_review' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** One tool step of background work as the host shows it: the tool `name` (the web words it), a short redacted `target`. */
export interface WorkStep { name: string; kind: string; target: string | null; status: 'running' | 'succeeded' | 'failed' | 'uncertain'; at: ISODate }
/**
 * P-1: one background run in the project summary's `work` (host progress projection). `id` is the initiative action id;
 * `title` is the host's cleaned label in the user's language. `summary` / `errorCode` only on recent (finished) runs.
 */
export interface WorkRun {
  id: string
  kind: WorkRunKind
  title: string
  status: WorkRunStatus
  createdAt: ISODate
  startedAt?: ISODate
  resumedAt?: ISODate
  completedAt?: ISODate
  scheduleId?: string
  occurrenceKey?: string
  steps: { total: number; completed: number; failed: number; uncertain: number; limit: number | null; kinds: { read: number; search: number; edit: number; write: number; command: number; web: number; other: number } }
  latest: WorkStep | null
  tokens: { total: number; estimated: boolean }
  model: RunModel | null
  /** Its background change set, if it changed files. */
  changeId: string | null
  summary?: string
  errorCode?: string
  /** Its own plan items, done of all (null: it has none); absent on older hosts, which the web counts from `summary.plan`. */
  plan?: { done: number; total: number } | null
  /**
   * The user's marks on the run (the project's `taskMarks`, as the actions route sends them): whether its result waits
   * for them and when they answered. A run the actions read does not list yet is marked from this.
   */
  attention?: { acknowledgedAt?: string; invitedAt?: string; needsUser?: boolean; alreadyReported?: boolean } | null
}
/** P-1: running runs, and runs finished within 24 h (newest first, at most 8). Older hosts send no `work`. */
export interface ProjectWork { running: WorkRun[]; recent: WorkRun[] }
/** P-4: a session's background subagents, from its latest turns that delegated. */
export interface SessionAgentsSummary { running: number; total: number; tokens: number; latestTurnId: string | null }

export interface ReasoningDecision {
  requested: string
  /** An effort id, 'default', or 'off'. */
  effective: string
  source: 'jev' | 'rule' | 'user' | 'provider-default' | string
  rationale?: string
  latencyMs?: number | null
}

export interface ModelConfig {
  providerId?: string
  providerName?: string
  modelId?: string
  name?: string
  contextWindow?: number
  reasoning?: string
  reasoningDecision?: ReasoningDecision
  reasoningCapability?: ReasoningCapability
  execution?: string
}

export type TurnStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped' | 'paused' | 'interrupted' | string

export interface Turn {
  id: string
  status: TurnStatus
  /** A transient failure that will be retried automatically at `nextAt` (attempt `attempts` of `of`). */
  autoRetry?: { attempts: number; of: number; nextAt: ISODate; category?: string | null } | null
  errorCode?: string
  mode?: 'build' | 'plan' | string
  createdAt?: ISODate
  startedAt?: ISODate | null
  firstTokenAt?: ISODate | null
  completedAt?: ISODate | null
  userItemId?: string | null
  source?: string
  modelConfig?: ModelConfig
  /** E1: per-stage turn start timing in ms (absent stages omitted). */
  timing?: Record<string, number> | null
  /** C-a attempt clock: working time of the attempts before the current one, which began at `attemptStartedAt`. */
  activeMs?: number | null
  attemptStartedAt?: ISODate | null
  /** When a paused turn stopped working. */
  pausedAt?: ISODate | null
  /** One record per retry: how the earlier attempt ended and when it was retried. */
  retryHistory?: { status?: string; completedAt?: ISODate | null; errorCode?: string; retriedAt?: ISODate | null; auto?: boolean }[]
  /** background_recovery_required: the background step under review that blocks this turn (C2-b). */
  blockingActionId?: string | null
  /** background_recovery_required while background work is still finishing: nothing to review yet (C2-b). */
  blockingDraining?: boolean
  /** 0.63: a worktree session's turn and the project folder (absent in direct mode). */
  apply?: TurnApply | null
  /** 0.63: a direct-mode turn's checkpoint in a git project (absent elsewhere). */
  checkpoint?: TurnCheckpoint | null
  /** H5: the router's advice for the turn (model tier, suggested skills, clarify, background); the footer's hints. */
  route?: TurnRoute | null
}

/** H5 `turn.route`: advice only; the host never switches models or loads skills because of it. */
export interface TurnRoute { point?: string; skills?: string[]; clarify?: boolean; needsTools?: boolean; modelTier?: 'fast' | 'main' | string; background?: { stop?: boolean; redirect?: boolean } }

export interface ModelSelection { providerId: string; modelId: string; reasoning?: string }

export interface InboxEntry {
  id: string
  text: string
  delivery?: 'steer' | 'followup' | string
  deliveryStatus?: string
  createdAt?: ISODate
  attachments?: Attachment[]
  /** 'subagent': a subagent's result queued for the model (`text` is the prompt written for it, `notice` the readable line). */
  source?: string
  agentId?: string
  notice?: string
  /** A host-posted "接着完成" in the user's name: the background task the turn receives in full. */
  continues?: { actionId: string }
}

export interface ContextUsage {
  tokens?: number | null
  capacity?: number | null
  compactions?: number
  /** `capacity` is the session's own model's window; `estimated` once the host rescaled it for a model change (C2-a). */
  usage?: { estimatedInputTokens?: number; capacity?: number; status?: string; estimated?: boolean }
}

export type SessionStatus = 'idle' | 'running' | 'paused' | string

/** Session-level fields (everything except items/turns). */
export interface SessionMeta {
  id: string
  title: string
  projectId?: string | null
  status: SessionStatus
  mode?: 'build' | 'plan' | string
  model?: string
  modelSelection?: ModelSelection | null
  modelConfig?: ModelConfig | null
  context?: ContextUsage
  activeTurnId?: string | null
  workspace?: string
  inbox?: InboxEntry[]
  plan?: unknown[]
  archivedAt?: ISODate | null
  createdAt?: ISODate
  updatedAt?: ISODate
  pauseReason?: string | null
  simulated?: boolean
  runtime?: { recovery?: { uncertainTools?: { callKey: string; toolName: string; arguments?: unknown }[] }; engine?: string; sdkVersion?: string; projectVersionId?: string | null; updatedAt?: ISODate } | null
  appRecovery?: { required?: boolean } | null
  /** S2: `side` = a 辅助对话 bound to `parentSessionId`; never listed in the sidebar. Absent = a normal session. */
  kind?: 'main' | 'side' | string
  parentSessionId?: string | null
  /** S2 side chat metadata (host §8.2): the seeding selection and the read-only default. */
  sideChat?: { selection?: { itemId?: string | null; excerpt?: string | null } | null; readOnlyDefault?: boolean; createdAt?: ISODate } | null
  /** Light invitations above the composer (feedback on the latest reply, a lesson to confirm); shared by every open window. */
  invitations?: Invitation[]
  /** 0.63: this conversation runs in its own worktree (absent = in the project folder). `workspace` stays the project folder. */
  worktree?: SessionWorktree | null
}

export interface Invitation {
  id: string
  kind: 'feedback' | 'lesson' | 'gene' | (string & {})
  subject: string
  createdAt: ISODate
  itemId?: string
  turnId?: string
  ledgerId?: string
  projectId?: string
  lessonId?: string
  text?: string
  lessonKind?: string | null
  /**
   * lesson: why it is being asked about (never_applied: recalled many times, never seen followed; conflicts_user_lesson:
   * a rule Rna concluded that would replace one the user set, held until answered).
   * gene no_effect: why the contrast analysis thinks it does not help (interface language).
   */
  reason?: string
  /** lesson conflicts_user_lesson: the user's rule the new lesson would replace. */
  conflictText?: string
  /** gene: an evolution decision (retire an unused skill or a check that never caught anything) */
  geneId?: string
  action?: 'retire' | (string & {})
  title?: string
  usage?: 'unused' | 'never_caught' | 'no_effect' | (string & {})
  runs?: number
  /** gene fix_hits: hits of a new check in existing files */
  total?: number
  files?: number
  /** commitment: the earlier request, asked for by the user or promised by the agent */
  commitmentId?: string
  trigger?: 'user_request' | 'agent_promise'
  /** task: background work that failed (mode failed) or whose last step could not be confirmed (mode review) */
  actionId?: string
  mode?: 'failed' | 'review' | (string & {})
  /** schedule: the suggested daily time */
  time?: string
  timeZone?: string
  /** schedule_pause: a schedule whose last `count` results nobody opened while the user was away (`since`: when the oldest arrived); `title` is the schedule's */
  scheduleId?: string
  count?: number
  since?: ISODate
}

/**
 * What GET /api/v2/sessions/:id left out (B9; zcode rowsWindowSchema): `?window=tail` sends the newest whole turns
 * (≥50 messages and ≥2 turns, ≤500 messages); `hasMore` says older items exist, read back through
 * GET …/items?before=&limit (≤200). Absent (an older daemon, the legacy read mode) means every item came.
 */
export interface SessionWindow { totalCount: number; firstItemId: string | null; hasMore: boolean }

export interface Session extends SessionMeta {
  items: Item[]
  turns: Turn[]
  revision?: number
  window?: SessionWindow
  /** Cards older than the window still waiting for the user (a question or permission request); absent when none. */
  pinned?: Item[]
}

/** GET /api/v2/sessions/:id/items?before=&limit=: the page just before `before`, with the turns its items name. */
export interface SessionPage { revision: number; sessionId: string; items: Item[]; turns: Turn[]; hasMore: boolean; totalCount: number }

/**
 * A session's index row (bootstrap, `index` events): exactly the host's allowlist (`SESSION_SUMMARY_FIELDS`). The open
 * conversation's own fields (inbox, recovery details, …) come with GET /api/v2/sessions/:id.
 */
export interface SessionSummary extends Pick<SessionMeta,
  'id' | 'title' | 'projectId' | 'kind' | 'parentSessionId' | 'status' | 'pauseReason' | 'mode' | 'model' | 'modelSelection' | 'modelConfig'
  | 'context' | 'activeTurnId' | 'plan' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'simulated' | 'sideChat' | 'invitations' | 'worktree'
  | 'appRecovery' | 'runtime'> {
  usage?: Record<string, unknown> | null
  /** The memory pipeline's evidence outbox as counts (absent when the session has none). */
  memoryEvidence?: { total: number; pending: number; failed: number }
  inboxCount?: number
  /** Question / permission cards still waiting for the user. */
  waiting?: number
  /** When the last proactive message arrived (sidebar dot for new ones). */
  lastInitiativeAt?: ISODate | null
  itemCount?: number
  lastItemAt?: ISODate
  /** The newest settled user or assistant message, ≤ 80 characters (a reply still streaming is not one yet). */
  preview?: string
  /** P-4: background subagents of its latest delegating turns (absent on older hosts and sessions that never delegated). */
  agents?: SessionAgentsSummary | null
}

/** P-3: `actionId` is the background run that staged (doing / next) or resolved (done) the item. */
export interface PlanItem { id: string; text: string; status: 'doing' | 'next' | 'done' | 'dropped' | (string & {}); updatedAt?: ISODate; actionId?: string | null }
/** The working plan (plan layer §4.1), shared by the conversation and background work. */
export interface ProjectPlan { doing: PlanItem[]; next: PlanItem[]; done: PlanItem[] }
/** One file of a background change set as the work left it (GET /api/projects/:id/background-changes/:changeId). */
export interface BackgroundChangeFile { path: string; created: boolean; deleted: boolean; changedSince: boolean; before: string | null; after: string | null; binary: boolean; truncated: boolean; available: boolean }
export interface BackgroundChangeDetail { id: string; actionId: string; at: ISODate; status: string; skipped: number; files: BackgroundChangeFile[] }
/**
 * 0.63: `kind: 'git'` rows came from a background worktree and roll back through their apply record (`applyId`);
 * `deferred`: done, applied after the current direct-mode turn; `merge_conflicted`: conflicts wait on a card.
 */
export interface BackgroundChange {
  id: string; actionId: string; at: ISODate; status: 'kept' | 'reverted' | 'deferred' | 'merge_conflicted' | (string & {}); count: number; paths: string[]; kind?: 'git'; applyId?: string | null; worktreeId?: string | null; conflicts?: ConflictPath[]
  /** 0.63, a git set: every apply record it wrote into the project folder, oldest first (at most 20; `applyId` is the first). */
  applyIds?: string[]
  /** 0.63, a git set waiting (deferred / merge_conflicted): why — a conversation's turn is running, the write failed, the project is read only, or the user's git operation (merge, rebase, …) is in progress in the project folder. */
  hold?: 'deferred' | 'blocked' | 'read_only' | 'git_operation' | (string & {})
  /** hold `git_operation`: which one (merge, rebase, cherry-pick, revert, bisect). */
  operation?: string
  /** 0.63, a git set whose card was answered 让 Rna 处理: the conversation it was handed to (it settles the set with agent_merge). */
  handedTo?: string
}
/**
 * A project's index row (bootstrap, `index` events): exactly the host's allowlist (`PROJECT_SUMMARY_FIELDS`); an
 * archived project's row has only `ARCHIVED_PROJECT_SUMMARY_FIELDS`. Large records ride as small projections of what
 * the UI reads from them; the whole project (presence, planning receipts, the full rhythm history and schedule runs,
 * …) is GET /api/v2/projects/:id (`ProjectDetail`).
 */
export interface ProjectSummary {
  id: string
  name: string
  description?: string
  workspacePath?: string
  createdAt?: ISODate
  updatedAt?: ISODate
  archivedAt?: ISODate | null
  primarySessionId?: string
  permissions?: { workspace?: 'read' | 'write' | 'execute' | string; background?: string }
  decisionMode?: string
  simulated?: boolean
  focus?: string
  taskTypes?: string[]
  /** The project's proactive settings (`ProjectDetail` names the fields). */
  initiative?: { enabled?: boolean; notificationMuted?: boolean; [key: string]: unknown }
  evolution?: { enabled?: boolean; minIntervalMs?: number; [key: string]: unknown }
  rhythm?: { control?: 'auto' | 'manual' | (string & {}) }
  memory?: { namespace?: string }
  activeVersionId?: string | null
  trialVersionId?: string | null
  activeVersion?: { id: string; version: number; title?: string } | null
  counts?: { versions?: number; jobs?: number; openTasks?: number; observations?: number; decisions?: number; facts?: number; inbox?: number; inboxUnread?: number; lessons?: number; openAgenda?: number; pendingCommitments?: number; overdueCommitments?: number }
  /** A gene is being formed or checked (the evolution tab's dot). */
  genesForming?: boolean
  initialization?: { status?: string; phase?: string; attempt?: number; maxAttempts?: number; message?: string; diagnostic?: string; requestedAt?: ISODate; startedAt?: ISODate; completedAt?: ISODate } | null
  skillFoundation?: { status?: string; attemptedAt?: ISODate; completedAt?: ISODate } | null
  memorySummary?: { status?: string; message?: string; code?: string | null; updatedAt?: ISODate } | null
  /** Lanes, schedule line and the latest five assessments (`RHYTHM_HISTORY_ROWS`), as the rhythm card reads them. */
  rhythmStatus?: { initiative?: { state?: string; reason?: string }; evolution?: { state?: string } } | null
  initiativeRuntime?: { status?: string; availability?: { state?: string; reason?: string; title?: string; message?: string; eligible?: boolean; details?: Record<string, unknown> } } | null
  /** What the task list reads of each schedule (its task text and provenance are on the project route). */
  schedules?: Pick<Schedule, ScheduleField>[]
  /** Per schedule its latest and latest delivered occurrence, the open ones and those of the runs in `work`. */
  scheduleRuntime?: { occurrences?: Occurrence[] }
  plan?: ProjectPlan | null
  /** P-1: background runs in progress and recently finished (host progress projection; absent on older hosts). */
  work?: ProjectWork | null
  /** Files background work changed, revertible while kept (plan §4.4). */
  backgroundChanges?: BackgroundChange[]
  /** 0.63: git settings (absent on older hosts and before the project was first saved with them). */
  git?: ProjectGitSummary | null
}
/** The rows name exactly the host's fields: a field added on one side only fails here. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Holds<T extends true> = T
export type IndexRowContract = [
  Holds<Exact<keyof SessionSummary, SessionSummaryField>>,
  Holds<Exact<keyof ProjectSummary, ProjectSummaryField>>,
  Holds<Exact<Exclude<ArchivedProjectSummaryField, ProjectSummaryField>, never>>,
  Holds<Exact<keyof NonNullable<ProjectSummary['initialization']>, InitializationField>>,
  Holds<Exact<keyof NonNullable<ProjectSummary['skillFoundation']>, SkillFoundationField>>,
  Holds<Exact<keyof NonNullable<ProjectSummary['memorySummary']>, MemorySummaryField>>,
  Holds<Exact<keyof NonNullable<ProjectSummary['initiativeRuntime']>, InitiativeRuntimeField>>,
  Holds<Exact<keyof Occurrence, OccurrenceField>>,
]
/**
 * The index protocol this UI was built for (`hello.protocol`, `Bootstrap.protocol`); the host's is `INDEX_PROTOCOL` in
 * index-schema.mjs (index-contract.spec compares them). A daemon speaking another one makes the page reload (store/sync).
 */
export const WEB_PROTOCOL = 3

export interface ReasoningEffort { id: string; label: string }
export interface ReasoningCapability {
  control: 'effort' | 'toggle' | 'budget' | 'adaptive' | 'none'
  efforts: ReasoningEffort[]
  canDisable: boolean
  providerDefault?: string | null
  visibility?: ReasoningVisibility
  source?: string
}

export interface ProviderModel {
  id: string
  name: string
  contextWindow?: number
  reasoning?: string[]
  reasoningCapability?: ReasoningCapability
}

export interface Provider {
  id: string
  name: string
  protocol?: string
  models: ProviderModel[]
}

export interface Configuration {
  providers: Provider[]
  defaultModel?: ModelSelection | null
}

export interface Bootstrap {
  protocol: number
  revision: number
  emergency?: boolean | null
  maintenance?: { held?: boolean } | null
  configuration?: Configuration
  settings?: Record<string, unknown>
  projects: ProjectSummary[]
  sessions: SessionSummary[]
  /** S2: host features the side panel depends on (absent on older daemons = unavailable). */
  capabilities?: HostCapabilities | null
}

export interface HostCapabilities {
  /** `pty` = real pseudo-terminal, `fallback` = pipe-based shell, false = no terminal service. */
  terminal?: 'pty' | 'fallback' | false | null
  sideChat?: boolean | null
}

export interface CacheStats {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  hitRate: number | null
  coverage: number | null
  coldStarts: number
  unreported?: number
  cacheAligned?: { aligned: number; outside: number; unknownTtl: number }
  /** Output over every request (estimated ones included), its reasoning part when reported, truncations. */
  output?: number
  reasoningTokens?: number
  lengthStops?: number
  /** Requests that reported no usage (aborted or unreported), recorded with an estimate and kept out of the hit rate.
   * `partial`: reported requests cut off before their final report, whose output past it was estimated (in `output`). */
  estimated?: { requests: number; input: number; output: number; partial?: number }
  /** Per reasoning effort sent; `estimatedInput` is the estimated requests' input, apart from the reported `input`. */
  byReasoning?: Record<string, { requests: number; input: number; cacheRead: number; output: number; reasoningTokens: number; estimatedInput?: number }>
}
/** One session of the usage report's "largest runs" (raw ledger only: the daily rollup keeps no session). `title`/`kind`/`scheduleId`/`projectName` are read from the project state at report time. */
export interface UsageRun {
  sessionId: string
  purpose: string
  projectId?: string
  projectName?: string
  /** `scheduled`: a run of a schedule (`title` is the schedule's); `job`: another background run (`title` is the job's). */
  kind?: 'scheduled' | 'job'
  scheduleId?: string
  title?: string
  requests: number
  /** input + cacheRead + cacheWrite + output */
  tokens: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  firstAt: ISODate
  lastAt: ISODate
}
export interface CacheUsage {
  window: string
  overall: CacheStats
  byPurpose?: Record<string, CacheStats>
  /** JEV judgments: no prompt cache, never part of the cache metrics above. `product`: the daemon's own decisions; `probe`: calls through the developer probe endpoint (absent on older daemons). */
  judge?: { requests: number; input: number; output: number; product?: { requests: number; input: number; output: number }; probe?: { requests: number; input: number; output: number } } | null
  /** The largest sessions of the window by their tokens (at most 8; raw ledger only). No price or cost enters the report: the backend does not track real prices. */
  runs?: UsageRun[]
  /** Idle prompt-cache keep-alive pings (Claude): not conversation requests, never part of the cache metrics above. */
  keepAlive?: { requests: number; input: number; cacheRead: number; cacheWrite: number } | null
  latest?: { purpose: string; hitRate: number | null; at: ISODate } | null
}

/** Known phases; the host may add more (e.g. `preparing_memory`), rendered via lib/phases. */
export type TurnPhase = 'connecting' | 'thinking' | 'writing' | 'tool' | 'waiting_user' | 'compacting' | 'finishing' | 'preparing_memory' | 'applying' | (string & {})

/** `tool_args` streams a pending tool entry's raw arguments (display-only, see PendingToolMeta). */
export type DeltaBlock = 'text' | 'thinking' | 'tool_output' | 'tool_args'

/* ---- SSE events ---- */
export interface HelloEvent { protocol: number; revision: number; seq: number; maintenance?: { held?: boolean } | null; sessionId?: string }
export interface IndexEvent {
  revision: number
  projects?: ProjectSummary[]
  sessions?: SessionSummary[]
  removed?: { projects?: string[]; sessions?: string[] }
  maintenance?: { held?: boolean } | null
  emergency?: boolean | null
  settings?: Record<string, unknown>
  configuration?: Configuration
}
export interface SessionPatchEvent { revision: number; sessionId: string; fields: Partial<SessionMeta> }
export interface ItemsUpsertEvent { revision: number; sessionId: string; items: Item[] }
export interface ItemsRemoveEvent { revision: number; sessionId: string; ids: string[] }
export interface TurnsUpsertEvent { revision: number; sessionId: string; turns: Turn[] }
/** Metadata of a pending tool entry, sent on every `tool_args` delta (append may be empty). */
export interface PendingToolMeta { id?: string; index: number; name: string; kind?: ToolKind; target?: string; preparing: true }
export interface DeltaEvent { type?: 'delta'; sessionId: string; turnId: string; itemId: string; block: DeltaBlock; offset: number; append: string; tool?: PendingToolMeta }
/** `preparing` accompanies `phase: 'tool'` while tool arguments are still streaming. */
export interface TurnPhaseEvent { sessionId: string; turnId: string; phase: TurnPhase; preparing?: boolean; at: ISODate }
/** P-2: a background work tool started (index stream only, display-only, never persisted; ≤ 4 per second per action). */
export interface WorkStepEvent { type?: 'work.step'; projectId: string; actionId: string; toolCallId: string; name: string; kind: string; target: string | null; status: 'running'; at: ISODate }
/** `event_too_large` names exactly what to refetch; no scope means the whole session. */
export interface ResyncEvent {
  reason?: string
  itemIds?: string[]
  turnIds?: string[]
  fields?: string[]
  projectIds?: string[]
  sessionIds?: string[]
}

export type StreamEvent =
  | { type: 'hello'; data: HelloEvent }
  | { type: 'index'; data: IndexEvent }
  | { type: 'session.patch'; data: SessionPatchEvent }
  | { type: 'items.upsert'; data: ItemsUpsertEvent }
  | { type: 'items.remove'; data: ItemsRemoveEvent }
  | { type: 'turns.upsert'; data: TurnsUpsertEvent }
  | { type: 'delta'; data: DeltaEvent }
  | { type: 'turn.phase'; data: TurnPhaseEvent }
  | { type: 'resync'; data: ResyncEvent }

export interface ModelReasoningInfo {
  capability: ReasoningCapability
  auto: { available: boolean; backend: 'typesafe' | 'llm' | null }
}
