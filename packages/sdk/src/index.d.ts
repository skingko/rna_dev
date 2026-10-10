import type { ProjectEvaluationRepeatPlan, ProjectEvaluationRepeatReceipt, ProjectEvaluationRepeatResult } from './project-evaluation-repeats.js';
export * from './project-evaluation-repeats.js';
import type { ProviderCredential, SubscriptionCredential } from './subscription-auth.js';
import type { DecisionAssessmentPlan } from './decision-kernel.js';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | { [keyword: string]: JsonValue | JsonSchema | undefined };
export type MaybePromise<T> = T | Promise<T>;
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Wire value sent to a provider. 'default' omits the effort parameter (provider default) while keeping any required thinking switch. */
export type Reasoning = 'off' | ReasoningEffort | 'default';
/** User/host selection. 'auto' is resolved per turn by host routing; SDK requests never receive it. */
export type ReasoningSelection = Reasoning | 'auto';
/** Per-model capability (host contract v2 §4). Effort order is weakest to strongest. */
export interface ReasoningCapability {
  control: 'effort' | 'toggle' | 'budget' | 'adaptive' | 'none';
  efforts: { id: ReasoningEffort; label: string }[];
  canDisable: boolean; providerDefault: ReasoningEffort | null;
  visibility: 'full' | 'summary' | 'hidden'; source: 'discovery' | 'preset' | 'protocol';
}
/** Recorded per turn in modelConfig.reasoningDecision (host contract v2 §3). */
export interface ReasoningDecision {
  requested: ReasoningSelection; effective: Reasoning;
  source: 'jev' | 'rule' | 'user' | 'provider-default'; rationale?: string; latencyMs: number | null;
}
export interface ModelConfig {
  providerId: string; modelId: string; protocol: 'openai' | 'anthropic' | 'openai-codex'; baseUrl: string;
  subscriptionProvider?: 'openai-codex';
  contextWindow: number; maxOutputTokens: number; reasoning?: Reasoning;
  /** Explicit supported inputs; missing means image capability is unknown. */
  input?: Array<'text' | 'image'>;
  usagePolicy?: 'interactive_only'; providerName?: string; name?: string; execution?: 'rna'; cacheRetention?: 'none' | 'short' | 'long';
  compat?: { thinkingFormat?: 'openai' | 'qwen' | 'toggle' | 'zai'; reasoningEffortMap?: Partial<Record<Reasoning, Reasoning | 'none'>>; thinkingDisplay?: 'summarized' | 'omitted'; toolStream?: boolean; preserveThinking?: boolean; requiresReasoningContent?: boolean; maxTokensField?: 'max_tokens' | 'max_completion_tokens'; supportsUsageInStreaming?: boolean; supportsPromptCacheKey?: boolean; supportsLongCacheRetention?: boolean; adaptiveThinking?: boolean; supportsJsonObject?: boolean; supportsToolChoiceNone?: boolean; /** TC-6: automatic compaction at context pressure sends the fork request (the conversation's own prefix plus one instruction). Default on for GLM-5.3 on the official open.bigmodel.cn routes (measured), off elsewhere. */ compactionFork?: boolean;
    /** Anthropic preserved thinking (official endpoint only by default): 'drop_block' (default) | 'error' | 'unset' (beta header only) | 'off'. */
    thinkingBindingMode?: 'drop_block' | 'error' | 'unset' | 'off';
    /** Overrides of the Anthropic feature gates (anthropic-features.mjs). */
    thinkingBindingControls?: boolean; appendOnly?: boolean; midConversationSystem?: boolean; perMessageEffort?: boolean; alwaysThinks?: boolean; canDisableThinking?: boolean };
}
export interface Usage {
  estimatedTokens?: number; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costStatus?: 'unpriced';
  /** True only when the provider reports valid cache-read and input counters for this request; absence does not mean zero cache hits. */
  cacheUsageReported?: boolean;
  /** Reasoning tokens (a subset of output) when the provider reports them; Anthropic: output_tokens_details.thinking_tokens. */
  reasoningTokens?: number;
}
/** Safe, closed metadata only. Provider response messages, headers and bodies are never retained. */
export interface ProviderDiagnostic {
  status?: number; providerCode?: string;
  category: 'model_access_denied' | 'authentication' | 'permission' | 'model_unavailable' | 'quota_exhausted' | 'rate_limit' | 'server_unavailable' | 'invalid_request' | 'context_limit' | 'redirect_rejected' | 'connection' | 'timeout' | 'vision_required' | 'image_limit' | 'image_invalid' | 'provider_failure' | 'refusal';
  /** Only with category 'refusal': the provider's `stop_details.category` token (cyber, bio, reasoning_extraction, ...). */
  refusalCategory?: string;
  retryable: boolean; purpose?: 'response' | 'compaction';
}
export interface TextBlock { type: 'text'; text: string }
export interface ImageBlock { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
export function normalizeImage(block: unknown): ImageBlock;
export function requireImageInput(model: ModelConfig): void;
export class ImageInputError extends Error { constructor(message: string, code?: string); code: string }
export const MAX_IMAGE_BYTES: number;
export const MAX_REQUEST_IMAGE_BYTES: number;
export const MAX_REQUEST_IMAGES: number;
export const IMAGE_TOKEN_RESERVE: number;
export interface ContextAttachment { source: string; text: string }
/** `blockIndex`: the provider content-block index (Anthropic), so a response is stored and replayed block-exact. */
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string; blockIndex?: number }
export interface RedactedThinkingBlock { type: 'redactedThinking'; data: string; blockIndex?: number }
export interface ToolCallBlock { type: 'toolCall'; id: string; name: string; arguments: JsonObject; blockIndex?: number }
export type MessageBlock = TextBlock | ImageBlock | ThinkingBlock | RedactedThinkingBlock | ToolCallBlock;
export interface InputTransformation { type: string; reason?: string; path?: string; sourceMessageId?: string }
export interface Message {
  id?: string; role: 'user' | 'assistant' | 'toolResult' | 'tool' | 'system'; content: MessageBlock[] | string;
  source?: string; timestamp?: number; inboxId?: string; assistantId?: string; context?: ContextAttachment[]; contextKey?: string; contextRevision?: string;
  toolCallId?: string; toolName?: string; isError?: boolean;
  model?: string; provider?: string; usage?: Usage; usageReported?: boolean; stopReason?: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted'; errorMessage?: string; providerFinishReason?: string | null;
  errorDiagnostic?: ProviderDiagnostic;
  /** Request-projection generations used to validate provider usage anchors. */
  contextPrefixHash?: string; contextCompactionId?: string | null; contextImageOffloadId?: string | null; contextThinkingFloorId?: string | null;
  /** The run's first request after economy edits: the served request it otherwise extends and the share (by byte estimate) of that request's prompt before the first edited message. */
  contextEdits?: { previousId: string; unchangedShare: number };
  /** A host context copy declared as part of a sliding list (ContextUpdate.accumulates). */
  contextAccumulates?: true;
  /** Anthropic `input_transformations` of this response (at most 32). */
  inputTransformations?: InputTransformation[];
  /** Durable marker: a final answer is not settled until its host check accepts or a new input supersedes it. */
  finishReviewRequired?: boolean;
}
export interface CachePolicy { sessionKey: string; prefixHash: string; retention?: 'none' | 'short' | 'long'; warming?: 'off'; /** Anthropic: the journal message that carried the previous request's tail breakpoint (a second read point). */ previousTailMessageId?: string }
export interface ToolDeclaration { name: string; description?: string; parameters: JsonSchema }
export interface CompletionRequest {
  subscriptionCredential?: SubscriptionCredential;
  model: ModelConfig; apiKey?: ProviderCredential; systemPrompt?: string; messages: Message[];
  tools?: ToolDeclaration[]; signal?: AbortSignal; cache?: Partial<CachePolicy>; maxOutputTokens?: number; timeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number; maxRetries?: number; fetch?: typeof fetch; /** Usage purpose tag (contract v2 §5), e.g. "jev-llm"; not sent to the provider. */ purpose?: string;
  /** Explicit native constraints. Unsupported or unverified models fail before dispatch; no automatic fallback. */
  responseFormat?: { type: 'json_object' }; toolChoice?: 'none';
}
export interface CompletionTimeoutPolicy {
  version: 1; idleTimeoutMs: number; totalTimeoutMs: number;
  idleSource: 'default' | 'explicit' | 'legacy_timeout'; totalSource: 'default' | 'explicit';
}
/** Default transport inactivity is 120s; absolute duration is 900s. CompletionRequest.timeoutMs is a legacy inactivity alias. */
export function resolveCompletionTimeoutPolicy(request?: Pick<CompletionRequest, 'idleTimeoutMs' | 'totalTimeoutMs' | 'timeoutMs'>): CompletionTimeoutPolicy;
export interface JsonOutputContract {
  format: 'json_object'; mode: 'native' | 'prompt_only'; reason: 'unsupported_protocol' | 'disabled_by_compat' | 'explicit_compat' | 'verified_deepseek_chat' | 'unverified_endpoint_or_model';
  requestOptions: Pick<CompletionRequest, 'responseFormat' | 'toolChoice'>;
}
export function resolveJsonOutputContract(model: ModelConfig): JsonOutputContract;
export type ProviderEvent =
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; status: number; errorDiagnostic?: ProviderDiagnostic }
  | { type: 'text_delta' | 'thinking_delta'; delta: string; blockIndex?: number }
  | { type: 'thinking_signature'; signature: string; blockIndex?: number }
  | { type: 'redacted_thinking'; data: string; blockIndex?: number }
  /** Anthropic: blocks the API dropped or let through despite a binding mismatch (empty arrays are reported too). */
  | { type: 'input_transformations'; items: InputTransformation[] }
  /** Anthropic binding recovery: this request was resent without any thinking; the session journals the floor. */
  | { type: 'thinking_rebase'; reason: 'binding_rejected' | 'invalid_signature'; recovery: 'strip'; path?: string; sourceMessageId?: string }
  /** Anthropic binding recovery: this request was resent with prefix_mismatch_behavior "drop_block". */
  | { type: 'thinking_recovery'; recovery: 'drop_block'; path?: string; sourceMessageId?: string }
  /** Display-only tool-call progress; the assembled `tool_call` stays canonical. */
  | { type: 'toolcall_start'; index: number; id?: string; name: string }
  | { type: 'toolcall_delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: JsonObject; blockIndex?: number }
  /** Cumulative snapshot for this request; replace prior frames, then sum across requests. */
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason?: 'stop' | 'toolUse' | 'length'; providerFinishReason?: string | null }
  | { type: 'error'; error?: unknown };
export type CompletionProvider = (request: CompletionRequest) => AsyncIterable<ProviderEvent>;
export function iterateCompletion(provider: CompletionProvider, request: CompletionRequest, options?: { timeoutMs?: number }): AsyncGenerator<ProviderEvent, void, unknown>;
export function streamCompletion(request: CompletionRequest): AsyncGenerator<ProviderEvent, void, unknown>;
export function buildRequest(request: Omit<CompletionRequest, 'apiKey' | 'signal'> & { stripThinking?: boolean; thinkingBindingMode?: 'drop_block' | 'error' | 'unset' }): { url: string; body: JsonObject; headers: Record<string, string>; protocol: 'openai' | 'anthropic' | 'openai-codex'; /** Anthropic only, never sent: per wire message, the source message id of each block. */ blockSources?: Array<Array<string | null>> };
export interface AnthropicFeatures { official: boolean; thinking: boolean; thinkingBindingControls: boolean; bindingMode: 'drop_block' | 'error' | 'unset' | null; appendOnly: boolean; midConversationSystem: boolean; perMessageEffort: boolean; alwaysThinks: boolean; toolChoiceNone: boolean }
/** Anthropic feature gates for a model (official endpoint only; boolean compat flags of the same name override). */
export function anthropicFeatures(model: ModelConfig): AnthropicFeatures;
/** 'append-only': provider-visible history may change only at a journaled thinking rebase (Anthropic preserved thinking). */
export function historyEditing(model: ModelConfig): 'append-only' | 'free';
export function appendOnlyActive(model: ModelConfig): boolean;
/** The provider cache has expired since the last request started. */
export function coldBreak(input: { lastRequestStartedAt?: number | null; now?: number; ttlMs: number }): boolean;
export const THINKING_REBASE_REASONS: ReadonlyArray<'compaction' | 'image_budget' | 'context_pressure' | 'prefix_changed' | 'binding_rejected' | 'binding_dropped' | 'invalid_signature' | 'revoked'>;
/** Anthropic prompt-cache keep-alive: the same request with max_tokens 0 and streaming off (refreshes the cache entry's TTL). */
export function cacheKeepAlive(request: CompletionRequest): Promise<{ usage: Usage; stopReason: string | null }>;
export function normalizeUsage(raw?: Record<string, unknown>, protocol?: 'openai' | 'anthropic'): Usage;
export class ProviderError extends Error { constructor(message: string, options?: { code?: string; status?: number; retryable?: boolean; retryAfterMs?: number; providerFinishReason?: string | null; providerCode?: string; category?: ProviderDiagnostic['category'] }); code: string; status?: number; retryable: boolean; retryAfterMs?: number; completionPending?: Promise<void>; providerFinishReason?: string | null; errorDiagnostic?: ProviderDiagnostic }

export type ToolContent = TextBlock | ImageBlock | { type: string; [key: string]: unknown };
export interface ToolResult { content: ToolContent[]; details?: JsonValue; isError?: boolean; [key: string]: unknown }
/** `observation(path)`: the SHA-256 this conversation last saw for a root-relative path (a read, write or edit result's `details.observation` after the latest compaction), if any. */
export interface ToolExecutionContext { checkpoint(value: JsonValue): void; observation?(path: string): string | undefined }
export interface ToolResolution { status: 'completed' | 'not-executed' | 'abandoned'; result?: ToolResult | JsonValue; isError?: boolean; note?: string }
export interface ToolReconciliation { status: 'resolved'; evidence?: JsonValue; result: ToolResult }
export interface AgentTool extends ToolDeclaration {
  id?: string; label?: string; permission?: 'read' | 'write' | 'exec'; effect?: 'read' | 'write'; idempotent?: boolean;
  /** A read/idempotent user interaction reattaches a saved question after interruption, never a side effect. */
  interaction?: boolean;
  /** false: the tool pages or bounds its own output, so the session never spills it (cuts it a second time). */
  spill?: boolean;
  /** Read current state after interruption; never replay the original effect. */
  reconcile?(input: UncertainTool & { checkpoint?: JsonValue }, signal?: AbortSignal): MaybePromise<ToolReconciliation>;
  execute(callId: string, args: JsonObject, signal?: AbortSignal, onUpdate?: (result: ToolResult | string) => void, execution?: ToolExecutionContext): MaybePromise<ToolResult | JsonValue | void>;
}
export interface FastCrwToolsOptions { baseUrl: string; apiKey?: string; timeoutMs?: number; maxResponseBytes?: number; maxContentChars?: number; fetchImpl?: typeof fetch }
export function createFastCrwTools(options: FastCrwToolsOptions): AgentTool[];
export function normalizeFastCrwBaseUrl(value: string): string;
export class FastCrwError extends Error { constructor(code: string, details?: Record<string, unknown>); code: string; details: Record<string, unknown> }
export type WebProviderId = 'fastcrw' | 'firecrawl' | 'tavily' | 'brave' | 'zhipu' | 'bocha';
/** `key`: whether the service needs a key; `reader`: 'service' reads pages itself, 'direct' has web_fetch read them from this machine. */
export interface WebProvider { id: WebProviderId; label: string; baseUrl: string; key: 'required' | 'optional'; reader: 'service' | 'direct' }
export declare const WEB_PROVIDERS: Readonly<Record<WebProviderId, Readonly<WebProvider>>>;
export declare const WEB_PROVIDER_IDS: readonly WebProviderId[];
export declare const WEB_TOOL_DECLARATIONS: ReadonlyArray<Readonly<{ id: string; name: string; label: string; description: string; parameters: Record<string, unknown> }>>;
export interface DirectPage { status: number; finalUrl: string; contentType: string; title: string; description: string; markdown: string }
export interface DirectFetchOptions { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; signal?: AbortSignal; lookup?: (...args: any[]) => void; allowAddress?: (address: string) => boolean; userAgent?: string }
export interface WebToolsOptions { provider?: WebProviderId; baseUrl?: string; apiKey?: string; timeoutMs?: number; maxResponseBytes?: number; maxContentChars?: number; fetchImpl?: typeof fetch; directFetch?: (url: string, options?: DirectFetchOptions) => Promise<DirectPage> }
export function createWebTools(options?: WebToolsOptions): AgentTool[];
export function normalizeWebBaseUrl(value: string): string;
export class WebToolError extends Error { constructor(code: string, details?: Record<string, unknown>, message?: string); code: string; details: Record<string, unknown> }
export function fetchPageDirect(url: string, options?: DirectFetchOptions): Promise<DirectPage>;
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; description: string; markdown: string };
export function publicAddress(address: string): boolean;
export class DirectFetchError extends Error { constructor(code: string, message: string, details?: Record<string, unknown>); code: string; details: Record<string, unknown> }
export interface InboxItem { id: string; text: string; target: 'steer' | 'followUp'; source?: string; requestId?: string; createdAt: string }
export interface Compaction {
  id: string; summary: string; throughMessageId: string; sourceDigest: string; archivedMessages: number; retainedMessages: number; automatic?: boolean;
  /** Current projected input estimates immediately before/after this compaction; never cumulative billed usage. */
  beforeTokens?: number; afterTokens?: number;
  /** What started it; `idle` = a summary prepared while the conversation was idle (`preparedId`), committed at a cold break. */
  trigger?: CompactionTrigger; preparedId?: string;
  /** Files read only / written or edited through successful project_read, project_document_read, project_write and project_edit calls up to this boundary, merged across compactions; the projection appends them to the summary. Absent on compactions recorded before these fields existed. */
  readFiles?: string[]; modifiedFiles?: string[];
  /** The opaque source ids (`ContextUpdate.sourceIds`) of the keyed context copies this compaction archived, merged across compactions, sorted; at most COMPACTION_SOURCE_IDS_LIMIT (`sourceIdsTruncated` when more were dropped). Absent when no archived copy carried one. */
  sourceIds?: string[]; sourceIdsTruncated?: boolean;
  /** Set on a `revoked` record: the id of the compaction whose summary it withdrew (same boundary, no source ids). */
  withdrew?: string;
  /** The summary request that wrote the text (compaction_request_started/_completed and the usage ledger carry the same id); absent before 0.69. */
  requestId?: string;
  /** TC-6: the text came from the fork request. `prefixMessageId`: the last sent answer whose cached prompt it extends. */
  fork?: true; prefixMessageId?: string;
  /** A fork was ruled out or rejected first and the text is the flattened fallback: `reason` window, cold (`cold`: why the cache was cold), tool_call, invalid_summary or context_limit (the service refused the fork as too long); `requestId`: the rejected fork request. */
  forkRejected?: { reason: 'window' | 'cold' | 'tool_call' | 'invalid_summary' | 'context_limit'; cold?: string; requestId?: string };
}
/** A context update's lifetime: conversation (default; latest wins, restored after compaction), window (latest wins, not restored), turn (not restored; set aside at the first cold break after a later turn). */
export type ContextScope = 'conversation' | 'window' | 'turn';
/** `accumulates`: the key is a sliding list whose copies each carry entries of their own; while its latest copy says so, a later copy never supersedes an earlier one (kept in summary records, never folded as superseded). */
export type ContextUpdate = ContextAttachment & { key: string; scope?: ContextScope; accumulates?: boolean;
  /** Opaque ids (at most 16, each at most 160 characters) of the sources this copy was made from (a message, a background action). The copy carries them in the journal (`contextSources`); a revocation naming one folds the copy, and a compaction record lists the ones it archived. */
  sourceIds?: string[] };
/** What the host takes back, offered by the request hook (`revokeContext`): every keyed copy carrying one of `sourceIds`, and every copy of a key in `contextKeys` made no later than `before` (ms; a later copy is new material and stays), folds to one line (`context_fold`, reason `revoked`). At least one of the lists is needed. */
export interface ContextRevocation { id?: string; contextKeys?: string[]; sourceIds?: string[]; before?: number }
/** A summary generated while the conversation was idle (host sidecar or offerCompaction); committed only on its own base. */
export interface PreparedCompaction { id: string; sessionId?: string; trigger: 'idle'; previousCompactionId: string | null; throughMessageId: string; sourceDigest: string; summary: string; archivedMessages: number; retainedMessages: number; requestId: string; usage: Usage; usageReported: boolean; model: { providerId: string; modelId: string }; startedAt?: number; completedAt?: number; beforeTokens?: number }
/** One summary request of a plan: `summary` (the ordinary one), or a split turn's `history` and `turn_prefix`. */
export interface CompactionPlanRequest { kind: 'summary' | 'history' | 'turn_prefix'; maxOutputTokens: number; request: { systemPrompt: string; messages: Message[]; cache: CachePolicy; estimatedInputTokens: number } }
export interface CompactionPlan { sessionId: string; previousCompactionId: string | null; throughMessageId: string; sourceDigest: string; archivedMessages: number; retainedMessages: number; beforeTokens: number; floorTokens: number; sourceTokens: number; keepUserTurns: number; partial: boolean; model: { providerId: string; modelId: string }; maxOutputTokens: number; request: { systemPrompt: string; messages: Message[]; cache: CachePolicy; estimatedInputTokens: number };
  /** Every request of the plan, in order; `request` and `maxOutputTokens` are the first. */ requests: CompactionPlanRequest[];
  /** Present when the retained turns alone keep the conversation over `targetTokens`: the earliest retained turn's beginning (`turnMessages`) is summarized on its own, after the history (`historyMessages`). `baseSummary`: the previous summary, which stands for the history when no history request is needed. */ split?: { historyMessages: number; turnMessages: number }; baseSummary?: string | null }
/** A request's structural continuity with the session's last served one. `edited`: only this run's economy edits broke it; `comparableTokens` is the part of the previous prompt before the first edited message. */
export interface RequestContinuity { continuous: boolean; gapMs: number; previousPromptTokens: number; edited?: { comparableTokens: number } }
/** Request metadata the SDK hands its provider for metering (providers ignore it). */
export interface RequestLedger { continuity?: RequestContinuity | null; trigger?: CompactionTrigger }
/** Durable request-only image omission; original messages and tool receipts remain intact. */
export interface ImageOffload {
  id: string; reason: 'request-image-budget';
  targets: Array<{ messageId: string; imageIndexes: number[] }>;
  before: { count: number; bytes: number }; after: { count: number; bytes: number };
}
/** Current model-input projection, including tools and retained context. It is an estimate, not billed usage. */
export interface ContextUsage {
  estimatedInputTokens: number; capacity: number; outputReserve: number;
  /** Above this, automatic compaction runs after the current run's answer. */
  inputTrigger: number;
  /** Above this, automatic compaction runs before the next request (blocking). */
  blockingTrigger?: number; method: string; status: 'ready' | 'compacting'; automaticEnabled: boolean;
  compactionId: string | null; beforeTokens?: number; afterTokens?: number; requestId?: string;
  imageOffloadId?: string | null; offloadedImages?: number;
}
export interface UncertainTool { callKey: string; toolCallId: string; toolName: string; arguments: JsonObject }
/** Durable scheduling boundary. Resume the same session only after host cancellation and admission checks. */
export interface SessionContinuation { id: string; reason: 'step_limit' | 'control'; requestId?: string; steps: number; maxSteps: number; createdAt: string }
export interface SessionSnapshot {
  engine: 'rna'; sdkVersion: string; sessionId: string; projectId?: string; sessionFile: string; cwd: string;
  messages: Message[]; streaming: boolean; idle: boolean; phase: 'idle' | 'preparing' | 'streaming' | 'tool' | 'compacting' | 'reviewing'; usage: Usage;
  queue: { steering: InboxItem[]; followUp: InboxItem[] }; tools: string[]; compaction: Compaction | null; cacheWarming: 'off';
  cache: CachePolicy & { estimatedInputTokens: number; estimateMethod: string };
  contextUsage: ContextUsage;
  recovery: { interrupted: boolean; uncertainTools: UncertainTool[]; pendingTools: number; pendingFinish?: true };
  continuation?: SessionContinuation;
  preparedCompaction?: { id: string; previousCompactionId: string | null; throughMessageId: string };
}
export type SessionEventPayload =
  | { type: 'response_contract'; contract: JsonOutputContract }
  | ({ type: 'image_offload' } & ImageOffload)
  | { type: 'context_usage'; usage: ContextUsage }
  | { type: 'message_start' | 'message_end'; message: Message }
  | { type: 'message_update'; requestId: string; message: Message; assistantMessageEvent: { type: 'text_delta' | 'thinking_delta'; delta: string; partial: Message } }
  /** Transient (never journaled; `seq` repeats the last durable record). */
  | { type: 'message_update'; transient: true; requestId: string; messageId: string; assistantMessageEvent: { type: 'toolcall_start' | 'toolcall_delta'; index: number; id?: string; name?: string; argumentsDelta?: string } }
  | { type: 'tool_execution_start'; callKey?: string; toolCallId: string; toolName: string; args: JsonObject }
  | { type: 'tool_execution_update'; callKey?: string; toolCallId: string; toolName: string; partialResult: ToolResult }
  | { type: 'tool_execution_end'; callKey?: string; toolCallId: string; toolName: string; result: ToolResult; isError: boolean; recovered?: boolean; uncertain?: boolean; validationReceipt?: { source: 'sdk_argument_validation'; code: 'invalid_tool_arguments'; argumentPath: string; neverExecuted: true }; /** The host's beforeTool refused the call; it never ran. */ refusalReceipt?: { source: 'host_before_tool'; code: string; neverExecuted: true } }
  | { type: 'agent_start' }
  | { type: 'agent_end'; reason: 'completed' | 'aborted' | 'error' | 'yielded'; messages: Message[] }
  | { type: 'agent_settled'; reason: 'completed' | 'aborted' | 'error' | 'yielded' }
  | { type: 'run_yielded'; continuation: SessionContinuation }
  | { type: 'turn_start' | 'turn_end'; step: number }
  | { type: 'inbox_added'; item: InboxItem }
  | { type: 'inbox_removed'; ids: string[] }
  | { type: 'inbox_claimed'; id: string; target: InboxItem['target'] }
  | { type: 'auto_compaction_end'; result: Compaction }
  | { type: 'compaction_request_start'; requestId: string; estimatedInputTokens: number; maxOutputTokens: number; trigger?: CompactionTrigger }
  /** The service rejected a request as too long although the estimate fit: history is summarized and the request retried once. */
  | { type: 'context_overflow_recovery'; step: number }
  | { type: 'compaction_request_end'; requestId: string; usage: Usage; usageReported: boolean; code?: string; errorDiagnostic?: ProviderDiagnostic; trigger?: CompactionTrigger }
  | { type: 'finish_review'; messageId: string; status: 'started' | 'accepted' | 'continued' | 'superseded' | 'interrupted' | 'failed'; continuations: number; code?: string }
  | { type: 'capabilities_changed'; tools: string[] }
  /** Edits of earlier history at a cache break (spec p1 compaction): reason is the cold-break cause, 'warm', 'compaction', or 'rebase' (an append-only target's economies riding on a thinking rebase). */
  | { type: 'context_economy'; reason: 'prefix_change' | 'model_change' | 'idle' | 'compaction' | 'warm' | 'rebase'; folded: number; settled: number; pruned: number; forgotten: number; preparedCommitted: boolean; freedTokens: number }
  | { type: 'context_fold'; id: string; reason: string; count: number; freedTokens: number }
  /** Transient (not journaled): the host's `revokeContext` was handled. `ids`: the requests handled (the host does not ask for them again), `folded`: the copies folded, `summaries`: committed compactions whose archived span held a revoked source id (or whose source list was cut), `withdrawn`: the one of those in force, whose summary was replaced by a fixed notice (SUMMARY_WITHDRAWN_TEXT) in a new compaction record. */
  | { type: 'context_revoke'; transient: true; ids: string[]; folded: number; summaries: string[]; withdrawn: string[] }
  | { type: 'context_settle'; id: string; count: number; results: number; freedTokens: number }
  | { type: 'context_forget'; id: string; count: number }
  | { type: 'compaction_prepared'; id: string; throughMessageId: string; previousCompactionId: string | null }
  | { type: 'compaction_prepared_discarded'; id: string; code: 'stale_base' | 'not_smaller' | 'superseded' | 'revoked' };
/** `seq` is the journal position of the record carrying the event. Stream deltas are journaled as coalesced segments, so the `message_update` events of one segment share its seq (non-decreasing); every other event's seq is strictly greater than the previous one. */
export type SessionEvent = SessionEventPayload & { sessionId: string; projectId?: string; seq: number; time: string };
export interface SessionOptions {
  sessionId?: string; projectId?: string; cwd?: string; stateDir: string; sessionFile?: string;
  model: ModelConfig; apiKey?: ProviderCredential; tools?: AgentTool[]; customTools?: AgentTool[]; systemPrompt?: string;
  onEvent?: (event: SessionEvent) => MaybePromise<void>; provider?: CompletionProvider; redactValues?: string[];
  beforeRequest?: (input: { signal: AbortSignal; snapshot: SessionSnapshot; /** Set when the hook runs a second time for one request: a compaction committed inside it moved the boundary, so window-scoped context may need offering again. */ recheck?: 'compaction' }) => MaybePromise<{ tools?: AgentTool[]; contextUpdates?: ContextUpdate[]; /** Per-turn routed reasoning for this and later requests of this handle. */ reasoning?: Reasoning; /** Context the user took back (at most 16, handled before `contextUpdates` are added, so a fresh copy of a folded key follows the fold). Reported by the transient `context_revoke` event; idempotent. */ revokeContext?: ContextRevocation[]; /** The host's current cold-gap estimate for this model (null: no idle economy). */ cacheSurvivalMs?: number | null; /** Trusted host closes this run with one metered, tool-free final projection; requires stepLimitBehavior summarize. False is invalid. */ finalResponse?: true } | void>;
  beforeCompletion?: (input: { signal: AbortSignal; snapshot: SessionSnapshot; purpose: 'response' | 'compaction'; estimatedInputTokens: number; maxOutputTokens: number }) => MaybePromise<void>;
  /** After a complete no-tool answer, return sourced observations to continue within the original task, permissions and step budget. Undefined accepts it. Hook errors fail the run; hooks should be read-only and safe to retry after interruption. */
  beforeFinish?: (input: { signal: AbortSignal; snapshot: SessionSnapshot; message: Message; continuations: number; remainingContinuations: number }) => MaybePromise<{ feedback: ContextAttachment[] } | void>;
  /** 0..8, default 1. Durable feedback count since the latest actual input; reopening does not reset it. */
  maxFinishContinuations?: number;
  autoCompaction?: boolean;
  afterRun?: (input: { signal: AbortSignal; reason: 'completed' | 'aborted' | 'error' | 'yielded'; snapshot: SessionSnapshot }) => MaybePromise<void>;
  /** error (default) rejects at maxSteps; summarize permits one extra budgeted, tool-free response; yield returns a durable continuation for host-scheduled resume without synthetic user input. */
  maxSteps?: number; stepLimitBehavior?: 'error' | 'summarize' | 'yield'; maxToolOutputBytes?: number;
  /** Host final-response task, only with summarize. Nonempty, NUL-free, <=32768 UTF-8 bytes. Replaces the default factual summary task; fixed no-tools/budget/cancellation constraints remain. The host validates any requested output schema. */
  stepLimitInstructions?: string;
  /** Prefer verified native JSON only for the summarize tail. Unsupported models emit an audited prompt_only contract; callers still validate the complete output. */
  stepLimitResponseFormat?: 'json_object';
  /** Stable named context blocks placed before the first user message of a new journal (shared cross-purpose prefix). */
  initialContext?: Array<ContextAttachment & { key: string }>;
  /** Overrides the provider cache routing key scope (for example one key per project across purposes). */
  cacheScope?: string;
  /** Idle gap (ms) after which this model's prompt cache is cold (learned or documented); the first request after it is a cold economy point. Null (default): the documented TTL where the provider has one (`coldAfterMs`), else no idle economy. */
  cacheSurvivalMs?: number | null;
  /** The longest idle gap (ms) the host has seen this model's prompt cache survive, or null when it has seen none; leave undefined when the host tracks nothing. Read by the compaction fork only, and only when no survival is known (`cacheSurvivalMs` null and no documented TTL): a gap within it counts as warm, a longer one (or no sample) as a cold cache, so the fork gives way to the flattened request (journaled `compaction_fork_rejected` with `cold: 'unknown_survival'`). */
  cacheWarmMaxMs?: number | null;
  /** Cache prices of the model (any one unit; only the ratios count): `{ input, cacheRead, cacheWrite? }`, or a function of the current model returning it or null. The share of the context a warm edit must free is computed from it; without a price a warm cache is left alone (cold-break and context-pressure economies are unchanged). */
  cachePricing?: { input: number; cacheRead: number; cacheWrite?: number | null } | ((model: { providerId: string; modelId: string }) => { input: number; cacheRead: number; cacheWrite?: number | null } | null | undefined) | null;
  /** Last time (ms) the host refreshed this conversation's prompt cache outside the session (keep-alive pings); the idle check counts from it when later than the last served request. */
  cacheRefreshedAt?: () => number | null | undefined;
  /** Clock for timestamps and idle checks (test seam), default Date.now. */
  clock?: () => number;
  /** Sidecar a host leaves a prepared idle summary in; default `<journal>.idle-summary.json`. Consumed at open. */
  preparedCompactionFile?: string;
  /** The host's reasoning effort for one side request (a summary): applies to that request only; a fork sharing the conversation's prefix keeps the session's. Undefined keeps the session's; without the hook a flattened summary uses summaryReasoning. */
  sideReasoning?: (input: { purpose: 'compaction'; trigger: string; automatic: boolean; estimatedInputTokens: number; maxOutputTokens: number; /** The effort the conversation sends now (a per-turn route may have moved it). */ model: { reasoning?: Reasoning; reasoningSelection?: string; reasoningCapability?: unknown }; signal: AbortSignal }) => MaybePromise<Reasoning | undefined | void>;
  /** The host's tool policy before dispatch, installed once for every tool (pi beforeToolCall): after argument validation and before the durable intent. `{ block: true, reason }` completes the call as never executed (`refusalReceipt` on its end event and journal record); undefined lets it run. `args` is a copy: a hook never rewrites the arguments. The call's `tool_execution_start` is emitted before the hook runs (pi order), so a call waiting here is already the running step. An interruption while it runs leaves the call never dispatched (no intent, never uncertain) and records nothing for it (no end event, no completion): the next input cancels it (`cancelUnstartedTools`) or a resume runs it through the hook again. A hook that throws refuses the call. */
  beforeTool?: (input: { tool: AgentTool; args: JsonObject; signal: AbortSignal; toolCallId: string; callKey: string }) => MaybePromise<{ block: true; reason: string; code?: string; details?: JsonObject } | void>;
  /** The host's tool policy after execution (pi afterToolCall): may append text blocks and details to the result. It never changes the content, `isError` or the arguments; an interruption or failure here leaves the tool's own result. */
  afterTool?: (input: { tool: AgentTool; args: JsonObject; result: ToolResult; isError: boolean; signal: AbortSignal; toolCallId: string; callKey: string }) => MaybePromise<{ content?: Array<{ type: 'text'; text: string }>; details?: JsonObject } | void>;
  /** context.forget judge: ids of earlier tool results later work superseded. */
  forgetStale?: (input: { request: string; recent: string[]; results: Array<{ id: string; toolName: string | null; args: string; preview: string; bytes: number }>; signal?: AbortSignal }) => MaybePromise<string[] | null | void>;
  /** context.settle: the arguments a written call keeps once its text is set aside (null keeps it whole). */
  settleArguments?: (toolName: string, args: JsonObject) => JsonObject | null;
  /** Vision route for a model without image input: returns a text description of the images. */
  describeImages?(input: { images: Array<{ type: 'image'; data: string; mimeType: string }>; question: string; signal?: AbortSignal; modelId: string }): Promise<{ text: string; model?: string } | null>;
}
export interface CompactOptions {
  /** Generate a measured summary with the configured provider; never invent a new user turn. */
  generate?: boolean; signal?: AbortSignal;
  keepLastTurns?: number; summary?: string; instructions?: string;
  summarize?: (request: { messages: Message[]; previousSummary?: string; instructions: string; signal: AbortSignal }) => MaybePromise<string>;
}
export interface Session {
  /** Switch the model between runs only; the next request journals `model_change`. Another model's thinking is not replayed. */
  setModel(model: ModelConfig, options?: { apiKey?: string | ((...args: unknown[]) => unknown); reason?: string }): { from: { providerId: string; modelId: string }; to: { providerId: string; modelId: string }; changed: boolean };
  prompt(text: string, options?: { context?: ContextAttachment[]; images?: ImageBlock[] }): Promise<void>;
  steer(text: string, options?: { requestId?: string; wake?: boolean }): Promise<InboxItem>;
  /** Persists a cooperative stop at a request/tool-batch boundary. Does not abort a running tool or claim it completed. */
  yieldAtBoundary(options: { requestId: string }): Promise<{ requestId: string; createdAt: string }>;
  followUp(text: string): Promise<InboxItem>;
  observe(text: string, options?: { wake?: boolean }): Promise<InboxItem>;
  withdraw(id: string): Promise<boolean>;
  clearQueue(): { steering: InboxItem[]; followUp: InboxItem[] };
  abort(): Promise<void>;
  /** Cancels only pending calls with no durable tool intent; never resolves started/uncertain side effects. */
  cancelUnstartedTools(reason?: string): { cancelled: number; pending: number; uncertain: number };
  /** Ends interrupted declared read/idempotent calls without replay or claiming an outcome. Explicit process cleanup fences remain unresolved. */
  retireInterruptedTools(reason?: string): { retired: number; pending: number; uncertain: number };
  reconcileTools(options?: { signal?: AbortSignal; skipKeys?: string[] }): Promise<{ resolved: Array<{ callKey: string; toolName: string; evidence: JsonValue; isError: boolean }>; unresolved: Array<{ callKey: string; toolName: string; code: string }> }>;
  resolveTools(resolutions?: Record<string, ToolResolution>): { resolved: number; unresolved: Array<{ callKey: string; toolName: string }> };
  resume(options?: { toolResolutions?: Record<string, ToolResolution> }): Promise<SessionSnapshot>;
  compact(options?: CompactOptions | string): Promise<({ compacted: true } & Compaction) | { compacted: false; reason: string }>;
  /** Plan an idle compaction (idle handle; writes nothing); null when nothing would shrink. keepUserTurns default 2. */
  prepareCompaction(options?: { keepUserTurns?: number; instructions?: string; /** The host's idle trigger (tokens): when the retained turns alone leave the projection above it, the earliest retained turn is split (see CompactionPlan.split). */ targetTokens?: number | null; /** The host's own measure of the conversation (tokens, including the real prompt and tool catalogue the maintenance handle lacks): the difference to this handle's own estimate is added to each projection before it is compared with `targetTokens`. */ measuredTokens?: number | null }): CompactionPlan | null;
  /** What a warm prompt cache needs before earlier history is edited: the share of the context settle, prune and forget must free together to repay the cache they break (computed from `cachePricing` and this conversation's median requests per run); null without a known price. */
  cacheBreakEven(): { share: number; read: number; write: number; requests: number } | null;
  /** Journal a summary prepared elsewhere (any phase; projection unchanged until a cold break commits it). */
  offerCompaction(prepared: PreparedCompaction): boolean;
  /** Commit the prepared summary now (idle handle). */
  commitPreparedCompaction(): ({ committed: true } & Compaction) | { committed: false; code: 'none' | 'stale_base' | 'not_smaller' | 'superseded' | 'discarded' };
  /** Set the prepared summary aside without committing it (idle handle; journaled as superseded), e.g. before a manual compaction with the user's own focus. */
  discardPreparedCompaction(): { discarded: true; code: 'superseded'; id: string } | { discarded: false; code: 'none' };
  snapshot(): SessionSnapshot;
  /** The requests an automatic compaction would weigh now (main, TC-6 fork, flattened), built without sending or journaling anything; null without a candidate. `throughMessageId` pins a recorded boundary. */
  compactionRequests(options?: { throughMessageId?: string | null; instructions?: string }): CompactionRequests | null;
  /** The request the next step would send, built without sending or journaling anything (the same view as `compactionRequests().main`, without needing a compaction candidate). */
  mainRequest(): CompactionProbeRequest;
  /** Canonical, read-only proof for reattaching a single persisted ask_user; null while requests, other tools or queued input are unsettled. */
  questionCheckpoint(options: { runtimeMessageId: string }): { phase: 'idle' | 'tool'; sessionFile: string; runtimeMessageId: string; callKey: string; toolCallId: string; argumentsHash: string; arguments: JsonObject } | null;
  dispose(): Promise<void>;
}
export function createSession(options: SessionOptions): Promise<Session>;
/** One request as compactionRequests builds it (never sent by the SDK). */
export interface CompactionProbeRequest { systemPrompt: string; messages: Message[]; tools: ToolDeclaration[]; cache: CachePolicy; estimatedInputTokens: number; heuristicTokens: number; contextDigest: string; prefixTokens: number; toolChoice?: 'none' }
export interface CompactionRequests {
  candidate: { throughMessageId: string; sourceDigest: string; archivedMessages: number; retainedMessages: number; sourceTokens?: number };
  /** The summarized span (journal messages). */
  archived: Message[]; previousSummary: string | null;
  /** The user's own messages (sources user, followUp, steer) up to the boundary; `inSpan`: archived by this compaction itself. */
  requests: { id: string; text: string; inSpan: boolean }[];
  main: CompactionProbeRequest; fork: CompactionProbeRequest & { fits: boolean }; flat: CompactionProbeRequest;
  /** The last request whose usage was reported; `continuous`: `main` extends its projection (same prefix, model, compaction, edits). */
  lastServed: { messageId: string; timestamp: number; usage: JsonObject; contextPrefixHash: string; continuous: boolean } | null;
}
export const SDK_VERSION: '0.14.0';
export const DEFAULT_MAX_STEPS: 64;
export const MAX_STEP_LIMIT_INSTRUCTIONS_BYTES: 32768;
/** Produced only after a complete tool-free final response with a reported terminal reason; contains no response text. */
export type CompletedFinalResponseDiagnostic = { purpose: 'step-limit-summary'; requestId: string; messageId: string; completed: true; toolCallCount: 0; providerFinishReason?: string | null; outputBytes: number } & ({ stopReason: 'stop'; kind: 'empty_response' } | { stopReason: 'length'; kind: 'output_truncated' });
export class SessionError extends Error { constructor(message: string, code: string); code: string; referenceResearch?: ReferenceResearchReceipt; responseDiagnostic?: CompletedFinalResponseDiagnostic; providerFinishReason?: string | null; errorDiagnostic?: ProviderDiagnostic; status?: number; retryable?: boolean }

export interface CapabilityAssignment { skillIds?: string[]; toolIds?: string[]; mcpServerIds?: string[] }
export interface SkillManifest { id: string; path: string; name?: string; description?: string; enabled: boolean; trusted: boolean }
export interface LoadedSkill { id: string; name: string; description: string; instructions: string; contentHash: string; filePath: string; enabled: true; trusted: true }
export interface RegisteredTool extends AgentTool { id: string; permission: 'read' | 'write' | 'exec'; enabled: boolean; trusted: boolean; mcpServerId?: string; rawName?: string }
export type ToolManifest = AgentTool & { id?: string; permission: 'read' | 'write' | 'exec'; enabled: boolean; trusted: boolean };
export type PublicTool = Omit<RegisteredTool, 'execute'>;
export interface McpBaseConfig {
  id: string; name?: string; description?: string; enabled: boolean; trusted: boolean; timeoutMs?: number;
  allowTools?: Record<string, { permission: 'read' | 'write' | 'exec'; idempotent?: boolean }>;
}
export type McpServerConfig = McpBaseConfig & (
  | { transport: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string>; headerEnv?: Record<string, string> }
);
export interface PublicMcpServer { id: string; name: string; description: string; transport: 'stdio' | 'http'; connected: boolean; toolIds: string[]; enabled: true; trusted: true }
export interface CapabilityCatalog { skills: Array<Omit<LoadedSkill, 'instructions' | 'filePath'>>; tools: PublicTool[]; mcpServers: PublicMcpServer[] }
export interface ResolvedCapabilities { skills: LoadedSkill[]; tools: RegisteredTool[]; mcpServers: Array<Pick<PublicMcpServer, 'id' | 'name' | 'transport'>> }
export class CapabilityRegistry {
  constructor(options?: { skills?: SkillManifest[]; tools?: ToolManifest[]; mcpServers?: McpServerConfig[]; clientFactory?: (server: McpServerConfig, options: { signal?: AbortSignal }) => McpClient | Promise<McpClient> });
  skills: Map<string, SkillManifest>; tools: Map<string, RegisteredTool>; mcpServers: Map<string, McpServerConfig>; clients: Map<string, McpClient>;
  registerSkill(manifest: SkillManifest): string;
  registerTool(manifest: ToolManifest): string;
  registerMcpServer(manifest: McpServerConfig): string;
  catalog(): Promise<CapabilityCatalog>;
  connectMcp(id: string, options?: { signal?: AbortSignal }): Promise<McpClient>;
  resolve(assignments?: CapabilityAssignment): Promise<ResolvedCapabilities>;
  close(): Promise<void>;
}
export function loadSkill(manifest: SkillManifest): Promise<LoadedSkill>;
export function validateToolArguments<T>(schema: JsonSchema, value: T): T;
export function mcpToolName(serverId: string, rawName: string): string;
/** `sandbox`: run project_exec in the macOS sandbox (writes confined to `cwd`, temp folders and package caches; `deniedPaths`, paths starting with `deniedPrefixes` and ~/.ssh, ~/.aws, ~/.gnupg unreadable, the Node runtime's own folder readable, outbound connections to `sandboxDenyPorts` refused), refused when the sandbox is unavailable; `deniedPrefixes`: path prefixes denied to the file tools and the sandbox as text, so files created later under them are denied too; `sandboxExtra`: further writable paths; `sandboxDeny`: paths whose writes stay denied (an isolated worktree denies its project folder); `sandboxReadable`: paths inside `deniedPaths` a sandboxed command may read; `withheldEnv`: environment variable names never passed to commands (the ones a command would have inherited are listed in its result details); `maxOutputBytes`: the visible tail of a command's output (default 40 KiB, at most 2000 lines). */
export function createWorkspaceTools(cwd: string, options?: { deniedPaths?: string[]; deniedPrefixes?: string[]; maxFileBytes?: number; includeMutations?: boolean; execLogDir?: string; maxOutputBytes?: number; execTimeoutMs?: number; sandbox?: boolean; sandboxExtra?: string[]; sandboxDeny?: string[]; sandboxReadable?: string[]; sandboxDenyPorts?: number[]; withheldEnv?: string[]; sandboxExec?: string }): Promise<RegisteredTool[]>;
/** Read bounded pages from one private command-log scope without rerunning commands. */
export function createExecOutputTool(options: { execLogDir: string }): RegisteredTool;
export class CapabilityError extends Error { constructor(message: string, code?: string); code: string }
export interface McpTool { name: string; description?: string; inputSchema: JsonSchema; [key: string]: unknown }
export class McpClient {
  constructor(config: McpServerConfig);
  ready: boolean; closed: boolean; protocolVersion: string; sessionId?: string;
  connect(options?: { signal?: AbortSignal }): Promise<this>;
  request(method: string, params?: JsonObject, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params?: JsonObject): Promise<void>;
  listTools(options?: { signal?: AbortSignal }): Promise<McpTool[]>;
  callTool(name: string, args: JsonObject, options?: { signal?: AbortSignal }): Promise<ToolResult>;
  close(): Promise<void>;
}
export class McpError extends Error { constructor(message: string, code?: string); code: string }

export interface BootstrapAssignment extends Required<CapabilityAssignment> { reasons: Array<{ kind: 'skill' | 'tool' | 'mcpServer'; id: string; reason: string }> }
export interface ProjectBootstrap {
  judgmentPolicy?: DecisionAssessmentPlan;
  initialSchedules?: Array<{ title: string; task: string; rule: ProjectScheduleRule; requestEvidence: string }>;
  overview: string; focus: string; facts: string[]; openQuestions: string[];
  milestones: Array<{ title: string; description: string; acceptanceCriteria: string[] }>;
  assignments: BootstrapAssignment; unmetCapabilities: Array<{ capability: string; reason: string }>;
  genome: ProjectGenome;
  smokeRepairs?: Array<{ toolId: string; caseIndex: number; reason: string }>;
}
export interface BootstrapRepairEvidence { attempt: number; before: ProjectBootstrap | null; after: unknown; expectedChanges: Array<{ toolId: string; caseIndex: number; input: JsonObject; originalExpected: JsonValue; beforeExpected: JsonValue; afterExpected: JsonValue; reason: string; verification: 'model_explanation_not_independent_proof' }>; validation: { passed: boolean; executed: boolean; runner: string; results: unknown[] } | null; error?: { code?: string; message: string; responseDiagnostic?: CompletedFinalResponseDiagnostic; argumentDiagnostic?: CompletedSubmissionArgumentDiagnostic }; rawDraft?: string }
export interface BootstrapReady extends ProjectBootstrap { referenceDiscovery?: unknown; status: 'ready'; model: { providerId: string; modelId: string }; usage: Usage; attempts: number; generatedAt: string; genomeValidation: { passed: boolean; executed: boolean; runner: string; results: unknown[] }; repairEvidence: BootstrapRepairEvidence[] }
export interface BlockedResult { status: 'blocked'; reason: string }
/** Completed transport proof; not a successful SDK tool call or validated artifact. No argument body is exposed. */
export interface CompletedSubmissionArgumentDiagnostic { requestId: string; schemaHash: string; contextDigest: string; contractHash: string; kind: 'completed_submission_arguments_invalid_json'; transportCompleted: true; completionMarker: 'openai_done'; assembledToolCount: 1; callId: string; toolName: 'submit_project_artifact'; providerFinishReason: 'tool_calls'; argumentBytes: number; argumentHash: string }
export interface AuthorSubmissionAudit { requestId: string; contextDigest: string; sourceRequestId: string; schemaHash: string; contractHash: string; toolName: 'submit_project_artifact'; reasoning: string }
export type BootstrapEvent = { type: 'bootstrap_authoring_stage'; attempt: number; stage: 'research' | 'artifact'; reason: 'started' | 'research_completed' | 'request_limit' | 'research_ready' | 'correction_granted' | 'research_incomplete'; researchReceipt?: ReferenceResearchReceipt; nextRequestIndex: number; researchCompleted: boolean; systemPromptBytes: number; artifactContractBytes: number } | { type: 'bootstrap_first_reference_tool'; attempt: number; requestIndex: number; requestId: string; toolName: string; elapsedMs: number } | { type: 'bootstrap_submission_selected'; attempt: number; nextAttempt: number; sourceRequestId: string; schemaHash: string } | ({ type: 'bootstrap_submission_started'; attempt: number } & AuthorSubmissionAudit) | ({ type: 'bootstrap_submission_captured'; attempt: number; captureScope: 'operation_memory'; durable: false; callId: string; argumentHash: string; argumentBytes: number; textBytes: number; stopReason: string; providerFinishReason?: string | null } & AuthorSubmissionAudit) | ({ type: 'bootstrap_submission_failed'; attempt: number; code: string; complete: boolean; callCount: number; textBytes: number; argumentDiagnostic?: CompletedSubmissionArgumentDiagnostic; providerFinishReason?: string | null } & AuthorSubmissionAudit) | { type: 'bootstrap_format_feedback'; attempt: number; messageId: string; continuations: number } | { type: 'bootstrap_output_failure'; attempt: number; diagnostic: CompletedFinalResponseDiagnostic } | { type: 'bootstrap_start'; attempt: number } | { type: 'bootstrap_delta'; delta: string } | { type: 'bootstrap_usage'; requestIndex?: number; attempt: number; usage: Usage } | { type: 'bootstrap_request_start'; requestId: string; authorSubmission?: AuthorSubmissionAudit; requestIndex?: number; attempt: number; estimatedTokens: number; usage: Usage; authoringStage?: 'research' | 'artifact'; systemPromptBytes?: number; messageBytes?: number; declaredToolCount?: number } | { type: 'bootstrap_request_end'; requestId: string; completed: boolean; authoringStage?: 'research' | 'artifact'; stopReason?: string; authorSubmission?: AuthorSubmissionAudit; providerFinishReason?: string | null; requestIndex?: number; cancelledBeforeSend?: boolean; attempt: number; estimatedTokens: number; requestUsage: Usage; usage: Usage } | { type: 'bootstrap_complete'; attempts: number; usage: Usage } | { type: 'bootstrap_repair'; attempt: number; reason: string } | { type: 'bootstrap_reasoning_step_down'; attempt: number; nextAttempt: number; reasoning: Reasoning } | { type: 'bootstrap_validation'; evidence: BootstrapRepairEvidence };
export interface BootstrapOptions {
  judgmentPolicyContext?: { enabled: boolean };
  schedulingContext?: { time: string; timeZone: string; timingSource: string; now: string; delivery: string; existingSchedules?: unknown[] };
  referenceTools?: AgentTool[]; referenceContext?: () => unknown; referencePolicy?: ProjectReferencePolicy;
  title: string; description?: string; existingState?: JsonObject; catalog?: Partial<CapabilityCatalog>; model?: ModelConfig; apiKey?: ProviderCredential;
  provider?: CompletionProvider; completion?: CompletionProvider; signal?: AbortSignal; maxAttempts?: number;
  onEvent?: (event: BootstrapEvent) => void;
  /** Runs before every provider attempt; reject to deny spending. Headroom is an estimate, not model context capacity. */
  beforeRequest?: (request: { attempt: number; estimatedTokens: number; usage: Usage; signal?: AbortSignal }) => MaybePromise<void>;
}
export function bootstrapProject(options: BootstrapOptions): Promise<BootstrapReady | BlockedResult>;
export function validateProjectBootstrap(value: unknown, catalog: Partial<CapabilityCatalog>): ProjectBootstrap;
export const projectBootstrapSchema: JsonSchema;
export class BootstrapError extends Error { constructor(message: string, code?: string); code: string; usage?: Usage; bootstrapDraft?: string; attempts?: number; repairEvidence?: BootstrapRepairEvidence[]; responseDiagnostic?: CompletedFinalResponseDiagnostic; argumentDiagnostic?: CompletedSubmissionArgumentDiagnostic }

/** `revoked`: the record that replaces a summary which archived a revoked source with a fixed notice (`Compaction.withdrew` names the record it replaces). */
export type CompactionTrigger = 'manual' | 'before_request' | 'after_response' | 'overflow' | 'idle' | 'revoked';
export interface PreparedContext {
  systemPrompt: string; tools: ToolDeclaration[]; messages: Message[]; cache: CachePolicy;
  estimatedInputTokens: number; estimateMethod: string; contextDigest: string;
  /** Provider-visible UTF-8 bytes / 3 + image reserve, before any usage anchor. */
  heuristicTokens: number; prefixTokens: number;
  /** Pixel images actually sent; observed history images are text placeholders. */
  images: number; imageHistory: ReadonlyMap<string, ReadonlyMap<number, { reason: 'history' | 'unsupported'; excerpt?: string }>>;
}
export function prepareContext(options: { sessionId: string; projectId?: string; systemPrompt?: string; tools?: ToolDeclaration[]; messages?: Message[]; compaction?: Compaction | null; imageOffloads?: ReadonlyMap<string, ReadonlySet<number>>; imageOffloadId?: string | null; model?: Partial<ModelConfig>; imageHistory?: boolean }): PreparedContext;
export function automaticCompactionCandidate(messages: Message[], options?: { previousCompaction?: Compaction | null; maxSourceTokens?: number; keepLastGroups?: number }): { archived: Message[]; remaining: Message[]; throughMessageId: string; sourceDigest: string; sourceTokens: number } | null;
/** Whole older turns to compact by hand; chained on `previousCompaction`, only what lies after its boundary (null when nothing newer). */
export function compactionCandidate(messages: Message[], options?: { keepLastTurns?: number; previousCompaction?: Compaction | null }): { archived: Message[]; remaining: Message[]; throughMessageId: string; sourceDigest: string } | null;
export function idleCompactionCandidate(messages: Message[], options?: { previousCompaction?: Compaction | null; keepUserTurns?: number; maxSourceTokens?: number }): { archived: Message[]; remaining: Message[]; throughMessageId: string; sourceDigest: string; sourceTokens: number } | null;
export function foldTargets(messages: Message[], options?: { compaction?: Compaction | null; folded?: ReadonlyMap<string, unknown> }): Array<{ messageId: string; contextKey: string; kind: 'superseded' | 'turn' }>;
export function foldedContextText(key: string, kind?: 'superseded' | 'turn' | 'revoked'): string;
/** context_fold targets for a revocation: copies carrying a revoked source id, or of a revoked key made no later than `before`; copies already folded as revoked are skipped. */
export function revokeTargets(messages: Message[], options?: { contextKeys?: string[]; sourceIds?: string[]; before?: number | null; folded?: ReadonlyMap<string, { kind?: string }> }): Array<{ messageId: string; contextKey: string; kind: 'revoked' }>;
/** The source ids of the keyed copies a compaction archives (the previous compaction's list merged in), capped; `{}` when none. */
export function compactionSources(messages: Message[], options: { previous?: Compaction | null; throughMessageId: string }): { sourceIds?: string[]; sourceIdsTruncated?: boolean };
export const COMPACTION_SOURCE_IDS_LIMIT: 512;
/** The notice a withdrawn summary projects in place of its text (model-visible, English). */
export const SUMMARY_WITHDRAWN_TEXT: string;
/** Whether a compaction record may restate a revoked source: it lists one, or its list was cut. */
export function compactionTainted(compaction: Compaction | null | undefined, revoked: ReadonlySet<string>): boolean;
export function isTurnStart(message: Message): boolean;
export const CONTEXT_SCOPES: readonly ContextScope[];
export const SUMMARY_PROMPT: string;
export function summaryRequestFor(options: { previousSummary?: string | null; archived: Message[]; instructions?: string; sessionId?: string; projectId?: string; cacheScope?: string; model?: Partial<ModelConfig>; superseded?: ReadonlySet<string> | null; /** accumulatingKeys over the whole conversation (default: over `archived`): their copies always stay in the record. */ accumulating?: ReadonlySet<string> | null }): { systemPrompt: string; messages: Message[]; context: PreparedContext };
export function supersededContextIds(messages: Message[]): Set<string>;
/** Ids of the keyed context copies a compaction ending with `archived` restores verbatim after its boundary (left out of its summary record); copies of `accumulating` keys (default: accumulatingKeys(archived)) are never among them. */
export function restoredContextIds(archived: Message[], options?: { accumulating?: ReadonlySet<string> }): Set<string>;
/** The structured checkpoint directive that ends a summary request; `update` when a previous summary exists; `fork` names the span as ending at the fork task's boundary message. */
export function summaryDirective(options?: { update?: boolean; fork?: boolean; focus?: boolean }): string;
export const COMPACTION_FILE_TOOLS: { readonly read: readonly string[]; readonly modified: readonly string[] };
/** The file lists a compaction through `throughMessageId` carries, merged with `previous` when it has lists and an earlier boundary. */
export function compactionFiles(messages: Message[], options: { previous?: Compaction | null; throughMessageId: string }): { readFiles: string[]; modifiedFiles: string[] };
export function accumulatingKeys(messages: Message[]): Set<string>;
export class SummaryError extends Error { constructor(message: string, code?: string, options?: { truncated?: boolean }); code: string; truncated?: true; receipt?: { requestId: string; usage: Usage; usageReported: boolean; startedAt?: number; completedAt?: number } }
export const MAX_SUMMARY_BYTES: number;
/** The host's reasoning capability of a model (control, ordered efforts, the provider's default). */
export interface ReasoningCapabilityLike { control?: 'none' | 'toggle' | 'adaptive' | 'effort' | 'budget'; efforts?: Array<string | { id: string }>; providerDefault?: string | null; canDisable?: boolean; defaultAdaptive?: boolean }
type SummaryReasoningModel = Partial<ModelConfig> & { reasoningCapability?: ReasoningCapabilityLike; reasoningSelection?: string };
/** True when the provider's own default is usable for internal work: adaptive, a toggle, or a declared default below the deepest level (reasoning-effort.mjs). */
export function defaultReasoningUsable(capability: ReasoningCapabilityLike | null | undefined): boolean;
/** Reasoning for a flattened summary request without a host choice: internalReasoningPlan in 'auto' (the usable provider default, capped by the chat's choice; else the model's own). */
export function summaryReasoning(model: SummaryReasoningModel): Reasoning | undefined;
/** One effort step below `reasoning` on this model (a truncated summary's single retry; stepDownReasoning), or null. */
export function lighterReasoning(model: SummaryReasoningModel, reasoning?: Reasoning): Reasoning | null;
/** One streamed summary request (session compaction and the host's detached idle compaction). */
/** The summary of an idle plan: each of `plan.requests` through `run` (the host's one summary request), the texts joined (a split plan's history and turn prefix become one checkpoint). `done` keeps requests already paid for across retries. */
export function generatePlanSummary(options: { plan: Pick<CompactionPlan, 'request' | 'maxOutputTokens'> & Partial<Pick<CompactionPlan, 'requests' | 'baseSummary'>>; run: (entry: CompactionPlanRequest, index: number) => Promise<{ summary: string; usage: Usage; usageReported: boolean; requestId: string; startedAt: number; completedAt: number }>; done?: Map<number, { summary: string; usage: Usage; usageReported: boolean; requestId: string; startedAt: number; completedAt: number }> }): Promise<{ summary: string; usage: Usage; usageReported: boolean; requestId: string; requestIds?: string[]; startedAt: number; completedAt: number }>;
export function generateSummary(options: { provider?: CompletionProvider; model: ModelConfig; apiKey?: ProviderCredential; request: { systemPrompt: string; messages: Message[]; cache?: CachePolicy }; tools?: ToolDeclaration[]; toolChoice?: 'none'; maxOutputTokens?: number; signal?: AbortSignal; redactValues?: string[]; redact?: (text: string) => string; ledger?: RequestLedger; purpose?: string; requestId?: string; receipt?: Record<string, unknown>; /** The request's estimated input, for the host ledger when the provider reports none. */ estimatedInputTokens?: number }): Promise<{ summary: string; usage: Usage; usageReported: boolean; requestId: string; startedAt: number; completedAt: number }>;
export interface SurvivalSample { gapMs: number; warm: boolean; prompt: number; at: number }
export function structuralContinuity(prev: Partial<Message> | null | undefined, cur: Partial<Message> | null | undefined): boolean;
export function requestContinuity(prev: Partial<Message> | null | undefined, cur: Partial<Message>): RequestContinuity | null;
export function survivalSample(row: { continuity?: (RequestContinuity & { bridged?: boolean }) | null; cacheReported?: boolean; cacheRead?: number; at: string | number }): SurvivalSample | null;
export function survivalFromSamples(samples: SurvivalSample[], options?: { now?: number; maxAgeMs?: number }): { coldAfterMs: number | null; warmMaxMs: number | null; samples: number };
export function historyEditsAllowed(model: Partial<ModelConfig> | null | undefined, provider?: unknown): boolean;
/** 'free': edit at cold breaks; 'rebase': append-only Anthropic history, edits only with a thinking rebase; 'none': declared append-only. */
export function historyEditMode(model: Partial<ModelConfig> | null | undefined, provider?: unknown): 'free' | 'rebase' | 'none';
/** Documented provider prompt-cache lifetime (ms), or null. */
export function cacheTtlMs(model: Partial<ModelConfig> | null | undefined, retention?: 'none' | 'short' | 'long'): number | null;
/** The one cold-gap rule: documented TTL unless a warm sample outlived it, else the learned survival. */
export function coldAfterMs(model: Partial<ModelConfig> | null | undefined, learned?: { coldAfterMs?: number | null; warmMaxMs?: number | null } | null): { coldAfterMs: number | null; warmMaxMs: number | null; documentedTtlMs: number | null; source: 'documented' | 'learned' | null };
export function historyImagesSignature(history: ReadonlyMap<string, ReadonlyMap<number, { reason?: string }>> | null | undefined): string | null;
export function promptTokens(usage: Partial<Usage> | null | undefined): number;
export const SURVIVAL_MIN_GAP_MS: number; export const SURVIVAL_WARM_SHARE: number; export const SURVIVAL_MAX_AGE_MS: number; export const SURVIVAL_EDITED_MIN_SHARE: number;
export function readJournalRecords(file: string, options?: { verify?: boolean; wantEvent?: () => boolean }): Generator<{ seq: number; prevHash: string | null; time: string; type: string; data: JsonValue; hash: string }>;
export function supportsToolChoiceNone(model: Partial<ModelConfig>): boolean;
/** Whether automatic compaction at context pressure sends the TC-6 fork request for this model: `compat.compactionFork` when set, else on for GLM-5.3 on the official open.bigmodel.cn routes only. */
export function compactionForkEnabled(model: Partial<ModelConfig>): boolean;
/** Break-even of an edit to a warm prefix cache: `share = (w − r) / (w + (requests − 1) · r)` with r the cache-read and w the cache-write rate (the uncached rate when none); null without a usable price. */
export function settleBreakEven(options?: { prices?: { input: number; cacheRead: number; cacheWrite?: number | null } | null; requests?: number }): { share: number; read: number; write: number; requests: number } | null;
export function cachePriceShares(prices: { input: number; cacheRead: number; cacheWrite?: number | null } | null | undefined): { read: number; write: number } | null;
/** Median requests (assistant messages) per answered user turn, over the turns after the compaction boundary (all turns before one); 1 with none. */
export function requestsPerRun(messages: Message[], compaction?: { throughMessageId: string } | null): number;
/** Median tokens (byte estimate, before a receipt scales them) one user turn adds to the context, over the answered turns after the compaction boundary (all turns before one); 0 with none. The deferred compaction's margin: economies stand in for a summary only when they leave more room under the trigger than one more run adds. */
export function growthPerRun(messages: Message[], compaction?: { throughMessageId: string } | null): number;
/** The earliest retained turn's beginning as its own summary (idle compaction): the ordinary candidate for the earliest cut inside that turn whose projection `fits`, with `split`; null when none applies. */
export function splitTurnCandidate(messages: Message[], options: { previousCompaction?: { throughMessageId: string; summary?: string } | null; keepUserTurns?: number; maxSourceTokens?: number; fits: (cut: number) => boolean }): { archived: Message[]; remaining: Message[]; throughMessageId: string; sourceDigest: string; sourceTokens: number; split: { historyCount: number; prefixCount: number } } | null;
export function joinSplitSummary(parts: { history?: string | null; turnPrefix: string }): string;
export function validPreparedCompaction(value: unknown): PreparedCompaction | null;
export const MAX_CONTEXT_UPDATES: 64;
export const PREFLIGHT_BUDGET_MS: number;

export interface ProjectContext { id?: string; [key: string]: unknown }
export interface UserQuestion { id: string; question: string; header?: string; detail?: string; options?: Array<{ id: string; label: string; description?: string }>; multiSelect?: boolean; allowCustom?: boolean }
export interface UserAnswer { id: string; selected: string[]; custom?: string }
export class UserInteractionError extends Error { constructor(message: string, code?: string); code: string }
export const userQuestionSchema: JsonSchema;
export const userQuestionsSchema: JsonSchema;
export function validateUserQuestions(input: unknown): UserQuestion[];
export function validateUserAnswers(questions: UserQuestion[], answers: unknown): UserAnswer[];
export function createAskUserTool(options?: { ask?: (request: { toolCallId: string; questions: UserQuestion[]; signal?: AbortSignal }) => MaybePromise<{ status: 'answered'; answers: UserAnswer[] } | { status: 'cancelled'; answers?: [] }> }): AgentTool;
export interface Observation { id: string; type: string; summary: string; at?: number }
export type InitiativeActionKind = 'wait' | 'work' | 'share' | 'learn' | 'ask' | 'schedule';
type InitiativeScheduleFields = Omit<ProjectScheduleInput, 'id'>;
type InitiativeSchedulePatch = {
  [K in keyof InitiativeScheduleFields]-?: Required<Pick<InitiativeScheduleFields, K>> & Partial<Omit<InitiativeScheduleFields, K>>
}[keyof InitiativeScheduleFields];
export type InitiativeScheduleAction =
  | { operation: 'create'; purposeKey: string; title: string; task: string; rule: ProjectScheduleRule; destinationSessionId: string; enabled?: boolean }
  | ({ operation: 'update'; id: string; expectedRevision: number } & InitiativeSchedulePatch)
  | { operation: 'delete'; id: string; expectedRevision: number };
export interface InitiativeDecision { action: InitiativeActionKind; reason: string; evidenceIds: string[]; content: string; nextReviewAfterMs: number; /** work/share: the task in one plain line for the user (asked for by the contract; absent when the model left it out). */ title?: string; schedule?: InitiativeScheduleAction; rhythm?: ProjectRhythmAssessment; judgmentPolicy?: DecisionAssessmentPlan; questions?: UserQuestion[]; permissionRequest?: { workspace: 'write' | 'execute'; background: 'read' | 'inherit'; reason: string } }
export interface Presence { typing?: boolean; activeTurn?: boolean; /** Host guarantees append-only share delivery during a foreground turn. */ allowInterleavedShare?: boolean; /** Host guarantees a nonblocking question card during foreground work. */ allowInterleavedAsk?: boolean; /** A retained pending/interrupted interaction currently accepts an answer. Defers ask only. */ pendingQuestion?: boolean; quiet?: boolean; /** Explicit false defers share before action admission; omission preserves standalone SDK compatibility. */ conversationAvailable?: boolean }
export interface InitiativePolicy {
  enabled?: boolean; notificationMuted?: boolean; deferWhileTyping?: boolean; cooldownMs?: number; tokenBudget?: number | null;
  /** work/learn estimates reserve uncapped actions; they do not set hard spending caps. null/omitted learnBudgetTokens follows workBudgetTokens. */
  decisionMaxTokens?: number; workBudgetTokens?: number; learnBudgetTokens?: number | null; maxConcurrent?: number; maxEvents?: number; reviewMinMs?: number; reviewMaxMs?: number;
  /** The evidence event window keeps maxEvents to maxEvents + eventBlock - 1 events, dropping the oldest eventBlock at once (blockWindow), so the request prefix and the event handles stay the same between those drops. Default 1: the newest maxEvents. */
  eventBlock?: number;
  /** Host-derived absolute eligibility time for autonomous learning. Expiry never creates an action or bypasses evidence checks. */
  learnNotBefore?: number;
  /** Deadlines cancel waiting; a handler that ignores cancellation remains quarantined until it settles. */
  decisionTimeoutMs?: number; actionTimeoutMs?: number; reviewJitterRatio?: number;
  /** History compaction requires archiveHistory. Unconfirmed effects are never evicted. */
  maxHistory?: number; maxSeenEvents?: number; maxPendingActions?: number;
}
export interface InitiativeAction extends InitiativeDecision {
  id: string; revision: number; status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'needs_review'; createdAt: number;
  startedAt?: number; finishedAt?: number; resolvedAt?: number; nextAttemptAt?: number; deferredReason?: string; resultSummary?: string; error?: string; reasonForReview?: string; cancellationReason?: string; blocksExecution?: boolean; resolutionSource?: 'host' | 'user'; resolutionOutcome?: 'completed' | 'not-executed' | 'cancelled'; resolutionSummary?: string;
  errorCode?: string; failure?: InitiativeFailure;
  /** share/ask: what the delivery came to, as the host handler's outcome code (shared, filed, held …). */
  deliveryOutcome?: string;
  hostSchedule?: HostScheduleIdentity; hostIdentity?: string; hostScheduleSettled?: boolean;
  /** Control receipts are bounded to 64; CAS revision rejects retries older than retained receipts. */
  controlRevision?: number; controls?: InitiativeActionControl[]; pausedAt?: number; checkpoint?: InitiativeActionCheckpoint;
  /** Non-evicting host source identities for derived-data deletion, including sources whose receipts were compacted. At most 128 distinct conversations per action. */
  controlSourceSessionIds?: string[];
}
export interface InitiativeActionCheckpoint { sessionId: string; turnId?: string }
export type InitiativeActionControlInput = {
  id: string; expectedRevision: number;
  /** Host-bound conversation provenance for derived-data deletion. This is not an authorization grant. */
  sourceSessionId?: string;
} & ({ kind: 'pause' | 'cancel' | 'resume'; instruction?: never } | { kind: 'steer'; instruction: string });
export type InitiativeActionControl = InitiativeActionControlInput & { revision: number; status: 'pending' | 'applied' | 'rejected'; createdAt: number; settledAt?: number; summary?: string };
export interface InitiativeActionControlReceipt { status: 'applied' | 'rejected'; summary: string }
export type InitiativeActionControlBoundary = { commandId: string; summary: string } & ({ kind: 'pause'; checkpoint: InitiativeActionCheckpoint } | { kind: 'cancel'; checkpoint?: InitiativeActionCheckpoint });
export interface InitiativeFailure {
  id: string; at: number; phase: 'decision' | 'work' | 'learn' | 'share' | 'ask' | 'schedule'; source: 'provider' | 'response_validation' | 'host_handler'; code: string; message: string;
  httpStatus?: number; retryable?: boolean; recoveredAt?: number;
  request?: { id: string; attempt: number; providerId: string; modelId: string; stopReason: string; responseBytes: number; responseSha256: string; responseContract?: JsonOutputContract; timeoutPolicy?: CompletionTimeoutPolicy };
  /** Invalid citations only: bounded counts and one-way hashes, never response text or raw IDs. */
  decisionValidation?: { action: InitiativeActionKind | 'invalid'; missingFields: Array<'action' | 'reason' | 'evidenceIds' | 'content' | 'nextReviewAfterMs' | 'rhythm'>; contentState: 'missing' | 'invalid' | 'present' | 'empty'; evidenceState: 'missing' | 'invalid' | 'present' | 'empty'; evidenceCount: number; questionsPresent: boolean; permissionRequestPresent: boolean; nextReviewState: 'missing' | 'invalid' | 'valid' };
  evidenceValidation?: { allowedCount: number; citedCount: number; invalidCount: number; categories: { actionReceiptId: number; conversationMessageId: number; unknown: number }; invalidIdSha256: string[] };
}
export interface InitiativeState {
  schemaVersion: 1; revision: number; events: Observation[]; seenEventIds: string[]; actions: InitiativeAction[];
  decisionRevision: number; nextReviewAt: number; lastSharedAt: number | null; usedTokens: number; reservedTokens: number;
  idleCount?: number; failureCount?: number; failureRetryAt?: number; estimatedTokens?: number; policy?: InitiativePolicy; lastDecision?: InitiativeDecision & { revision: number; at: number; admission?: InitiativeAdmission; responseContract?: JsonOutputContract; timeoutPolicy?: CompletionTimeoutPolicy };
  reviewSchedule?: { at: number; requested: number; count: number };
  externalReviewBarrier?: { revision: number; key: string };
  pendingFailureReview?: { actionId: string; evidenceKey: string }; lastFailureReviewEvidenceKey?: string; externalEvidenceKey?: string;
  archivedHistory?: { actions: number; seenEventIds: number };
  archiveRetryAt?: number; lastObserverError?: { type: string; at: number };
  lastFailure?: InitiativeFailure;
}
export type InitiativeEvent = { type: string; projectId?: string; revision?: number; [key: string]: unknown };
/** The effort a decision ran at: `effective` (sent), `routed` (the host's choice for the first attempt, or null), `configured` (model.reasoning), `escalated` after a truncation at the routed effort, plus the host's record (source, depth, ledgerId …). */
export interface InitiativeDecisionReasoning { effective: Reasoning; routed: Reasoning | null; configured: Reasoning; escalated?: true; source?: string; [key: string]: unknown }
/** What a decision was charged: reported usage plus estimates (estimatedTokens) for attempts that reported none. */
export interface InitiativeDecisionUsage { totalTokens: number; estimatedTokens: number }
export interface InitiativeDecisionOptions {
  project?: ProjectContext; events?: Observation[]; availableActions?: InitiativeActionKind[]; presence?: Presence; policy?: InitiativePolicy; recentActions?: Array<Pick<InitiativeAction, 'action' | 'evidenceIds' | 'content' | 'status'> & { id?: string; resultSummary?: string; schedule?: InitiativeScheduleAction; failure?: Pick<InitiativeFailure, 'code' | 'message'> }>;
  model?: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; signal?: AbortSignal; maxAttempts?: number; onEvent?: (event: InitiativeEvent) => void; redactValues?: string[];
  /** A previous proposal the host did not admit, shown at the request tail as `previousDecision` with what that means. */
  previousDecision?: { action: InitiativeActionKind; title?: string; content: string; admission: InitiativeAdmission['reason']; meaning: string } | null;
  /** The first attempt's effort (repairs and a retry after a truncation run at model.reasoning); the record rides on the outcome's `reasoning`. */
  reasoning?: Reasoning; reasoningRecord?: Record<string, unknown>;
  /** Which schedule guidance the decision prompt carries (default 'v1': today's text; 'v2' adds the standing-instruction paragraph and declares `schedule.basis`). */
  schedulePromptVersion?: SchedulePromptVersion;
}
export type SchedulePromptVersion = 'v1' | 'v2';
/** Thrown decisions carry `usage` (reported plus estimated, `estimatedTokens`), `{ totalTokens: 0 }` when nothing was sent. */
export function decideInitiative(options?: InitiativeDecisionOptions): Promise<BlockedResult | { status: 'decided'; decision: InitiativeDecision; usage: Usage & { estimatedTokens?: number }; usageReported: boolean; usageEstimated?: true; reasoning: InitiativeDecisionReasoning; attempts: number; messageRepairs?: number; responseContract: JsonOutputContract; timeoutPolicy: CompletionTimeoutPolicy }>;
export function validateInitiativeDecision(decision: unknown, context?: { events?: Observation[]; availableActions?: InitiativeActionKind[]; project?: ProjectContext }): InitiativeDecision;
export const initiativeDecisionSchema: JsonSchema;
export const initiativeScheduleActionSchema: JsonSchema;
/** The planner's schedule guidance for a host's schedulePromptVersion (anything but 'v2' is the v1 text). */
export function initiativeScheduleGuidanceFor(version?: SchedulePromptVersion): string;
/** The optional `basis` of a schedule update: the user's own words that ask for a task change to apply to every future run. */
export const scheduleBasisField: JsonSchema;
/** `initiativeScheduleActionSchema` with the optional update `basis` (schedulePromptVersion v2; validation always accepts it). */
export const initiativeScheduleActionSchemaV2: JsonSchema;
/** The schedule schema a prompt shows for a host's schedulePromptVersion (anything but 'v2' is `initiativeScheduleActionSchema`). */
export function initiativeScheduleActionSchemaFor(version?: SchedulePromptVersion): JsonSchema;
/** Schedule requires its versioned enabled host contract and handler. Rhythm is advertised only when actionContracts.rhythm.enabled is true; requiresAssessment makes that field mandatory in this same decision. */
export function getInitiativeDecisionSchema(context?: { project?: ProjectContext; availableActions?: InitiativeActionKind[]; schedulePromptVersion?: SchedulePromptVersion }): JsonSchema;
/** The schema the decision system prompt shows: per-wake requirements are conditions on hostConditions, so the prompt stays byte-stable. */
export function getInitiativePromptSchema(context?: { project?: ProjectContext; availableActions?: InitiativeActionKind[]; schedulePromptVersion?: SchedulePromptVersion }): JsonSchema;
export type InitiativeHandler = (action: InitiativeAction, context: {
  signal: AbortSignal; project: ProjectContext; actionId: string; idempotencyKey: string; evidence: Observation[]; tokenBudget: number | null;
  /** Sequential request hosts await admission before a request, then report cumulative action usage after it. Final usage is reconciled, never charged twice. */
  reserveTokens: (inFlightEstimate: number) => Promise<void>; reportUsage: (cumulativeUsage: Partial<Usage>) => Promise<void>;
  /** Commands become visible only after durable admission. Steer is acknowledged after its idempotent session journal write. */
  pendingControls: () => InitiativeActionControl[]; acknowledgeControl: (id: string, outcome: InitiativeActionControlReceipt) => Promise<InitiativeActionControl>;
}) => MaybePromise<{ summary?: string; /** share/ask: a short host code for what the delivery came to (kept as action.deliveryOutcome). */ outcome?: string; usage?: Partial<Usage>; deferred?: boolean; reason?: string; retryAfterMs?: number; superseded?: boolean; control?: InitiativeActionControlBoundary } | void>;
export type InitiativeTickResult =
  | { status: 'paused' | 'busy' }
  | { status: 'idle'; reason?: string; running?: number; deferred?: number }
  | (BlockedResult & { remainingTokens?: number })
  /** usage: what the superseded decision was charged (zero when it was superseded before it was sent). */
  | { status: 'stale'; reason: 'new_evidence' | 'interrupted'; usage?: InitiativeDecisionUsage }
  /** admitted:false — the decided action was not queued: an exact duplicate, or work the host's workCheck found already covered. */
  | { status: 'decided'; decision: InitiativeDecision; admitted?: boolean; admission?: InitiativeAdmission; running: number; deferred: number; usage: InitiativeDecisionUsage; attempts: number; messageRepairs?: number; reasoning?: InitiativeDecisionReasoning };
/** Why the host did not admit a decided action; the next decision sees it as `previousDecision` at the request tail. */
export interface InitiativeAdmission { status: 'not_admitted'; reason: 'exact_duplicate' | 'already_covered'; at: number; ledgerId?: string }
/** Which actions a decision carries as recentActions (the host projection uses the same predicate), and how many. */
export function receiptEligible(action: { status?: string; contextRevoked?: boolean }): boolean;
export const RECENT_RECEIPTS: number;
/** The newest `size` rows, the window's start moving only every `block` rows (it holds size to size + block - 1 rows); block 1 is a plain tail. */
export function blockWindow<T>(rows: readonly T[], size: number, block?: number): T[];
/** An idle periodic review may run early inside the prompt-cache window: last quarter of its planned wait, past reviewMinMs, never later. */
export function cacheAlignedReviewDue(state: Partial<InitiativeState>, policy: { reviewMinMs?: number }, now: number, cacheWindowUntil?: number | null): boolean;
export class InitiativeCoordinator {
  constructor(options?: { project?: ProjectContext; model?: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; redactValues?: string[]; state?: InitiativeState; saveState?: (state: InitiativeState, metadata?: { reservationAdmission?: boolean }) => MaybePromise<void>; archiveHistory?: (history: { actions: InitiativeAction[]; seenEventIds: string[] }) => MaybePromise<void>; handlers?: Partial<Record<'work' | 'share' | 'learn' | 'ask' | 'schedule', InitiativeHandler>>; /** Opt in only handlers that resume the original durable session and consume controls at verified boundaries. */ actionControlKinds?: Array<'work'>; policy?: InitiativePolicy; now?: () => number; onEvent?: (event: InitiativeEvent) => void;
    /** Host writing-contract check for share/ask content; violations earn one repair round. */
    messageCheck?: (decision: InitiativeDecision) => MaybePromise<Array<{ code: string }>>;
    /** Host coverage check before a decided work is queued; { covered: true } takes the duplicate path (not queued, review backs off). Errors admit the work. */
    workCheck?: (decision: InitiativeDecision, context: { recentActions: unknown[]; events: Observation[]; signal: AbortSignal }) => MaybePromise<boolean | { covered: boolean; ledgerId?: string }>;
    /** The host's effort for the decision about to be requested, given the exact request data; anything invalid (or a throw) keeps model.reasoning. New evidence or a stop during it ends the tick stale at no charge. */
    decisionReasoning?: (input: { project: ProjectContext; events: Observation[]; availableActions: InitiativeActionKind[]; promptActions: InitiativeActionKind[]; recentActions: unknown[]; previousDecision: unknown; presence: Partial<Presence>; policy: Partial<InitiativePolicy>; lastDecision: { at: number; action: InitiativeActionKind; evidenceIds: string[] } | null; failureReview: boolean; signal: AbortSignal }) => MaybePromise<{ reasoning: Reasoning; record?: Record<string, unknown> } | undefined | void>;
    /** Which schedule guidance the decision prompt carries, or a host function returning it (read at every decision). Default 'v1'. */
    schedulePromptVersion?: SchedulePromptVersion | (() => SchedulePromptVersion | undefined) });
  snapshot(): InitiativeState;
  /** Invalidates only the in-flight judgment. Running actions retain their own lifetime. */
  invalidateDecision(reason?: string): void;
  /** beforeCommit rechecks a host source/signal inside serialized admission. It must throw synchronously on revocation. */
  requestActionControl(actionId: string, input: InitiativeActionControlInput, options?: { beforeCommit?: () => void }): Promise<InitiativeActionControl>;
  pendingActionControls(actionId: string): InitiativeActionControl[];
  acknowledgeActionControl(actionId: string, commandId: string, outcome: InitiativeActionControlReceipt): Promise<InitiativeActionControl>;
  enqueueHostAction(input: { id: string; action: 'work' | 'share'; content: string; reason: string; source: Observation & { type: 'scheduled_occurrence'; at: number }; hostSchedule: HostScheduleIdentity }): Promise<InitiativeAction>;
  drainHostActions(options?: { presence?: Presence; signal?: AbortSignal }): Promise<{ status: 'blocked' | 'drained' }>;
  cancelQueuedHostAction(id: string, reason?: string): Promise<boolean>;
  retireHostOccurrence(key: string): Promise<boolean>;
  observe(event: Observation): Promise<{ accepted: boolean; duplicate?: boolean; revision: number }>;
  updatePolicy(patch: Pick<InitiativePolicy, 'enabled' | 'notificationMuted' | 'deferWhileTyping' | 'cooldownMs' | 'tokenBudget' | 'workBudgetTokens' | 'learnBudgetTokens' | 'learnNotBefore' | 'maxConcurrent' | 'reviewMinMs' | 'reviewMaxMs'>): Promise<Required<InitiativePolicy>>;
  /** decisionEnabled:false drains already admitted actions but skips new model decisions; it never changes persisted user enablement. */
  /** cacheWindowUntil: end (ms) of the provider cache TTL of the last same-prefix request; see cacheAlignedReviewDue. */
  tick(options?: { presence?: Presence; signal?: AbortSignal; decisionEnabled?: boolean; cacheWindowUntil?: number; wakeFloor?: boolean }): Promise<InitiativeTickResult>;
  /** Whether a tick with these options would request a decision now (every gate tick applies after draining except the request-size budget check), without side effects. Ask a judge about a review only when it is true. */
  decisionDue(options?: { cacheWindowUntil?: number; wakeFloor?: boolean }): boolean;
  interrupt(reason?: string, options?: { cancelQueued?: boolean }): void;
  resolveAction(id: string, resolution: { status: 'completed' | 'not-executed' | 'cancelled'; summary: string; source?: 'host' | 'user' }): Promise<InitiativeAction>;
  idle(): Promise<void>;
  close(): Promise<void>;
}
export class InitiativeError extends Error { constructor(message: string, code?: string); code: string }
export interface HostScheduleIdentity { key: string; scheduleId: string; scheduleRevision: number; destinationSessionId: string }
export type ProjectScheduleRule = { kind: 'daily'; time: string; timeZone: string } | { kind: 'weekly'; time: string; timeZone: string; days: number[] } | { kind: 'interval'; everyMs: number; anchorAt?: string } | { kind: 'once'; at: string };
export interface ProjectScheduleInput { id: string; title: string; task: string; rule: ProjectScheduleRule; destinationSessionId: string; enabled?: boolean }
export interface ProjectSchedule extends ProjectScheduleInput { schemaVersion: 1; enabled: boolean; revision: number; /** The record revision at which task, rule, destination or enabled last changed (a title edit leaves it); absent on records saved before it existed (read `revision`). */ executionRevision?: number; /** The revision this was last written at; another value means an older version edited the record since (read `revision`). */ executionRevisionAt?: number; createdAt: string; updatedAt: string; nextRunAt: string | null }
export interface ProjectScheduleOccurrence { key: string; scheduledAt: string; nextRunAt: string | null; coalescedFrom: string | null }
export class ProjectScheduleError extends Error { constructor(message: string, code?: string); code: string }
export const projectScheduleRuleSchema: JsonSchema;
export const projectScheduleInputSchema: JsonSchema;
export function createProjectSchedule(input: ProjectScheduleInput, options?: { now?: number }): ProjectSchedule;
export function updateProjectSchedule(record: ProjectSchedule, patch: Partial<Omit<ProjectScheduleInput, 'id'>>, options?: { now?: number }): ProjectSchedule;
export function projectScheduleDue(record: ProjectSchedule, now?: number): ProjectScheduleOccurrence | null;
export function projectScheduleView(record: ProjectSchedule, now?: number): ProjectSchedule & { state: 'paused' | 'finished' | 'due' | 'scheduled'; deliveryMode: 'project-conversation'; timingPolicy: { missed: 'latest-only'; grace: 'one-period'; whileMuted: 'paused'; daylightSavingGap: 'skip'; daylightSavingFold: 'first' } };
export function projectScheduleExecutionRevision(record: Pick<ProjectSchedule, 'revision' | 'executionRevision' | 'executionRevisionAt'>): number;
/** Whether a claim made at record revision `scheduleRevision` is still current: nothing it performs changed since. */
export function projectScheduleClaimCurrent(record: Pick<ProjectSchedule, 'revision' | 'executionRevision' | 'executionRevisionAt'>, scheduleRevision: number | null | undefined): boolean;
export function projectSchedulePeriodMs(record: Pick<ProjectSchedule, 'rule'>, scheduledAt: string): number | null;
export function projectScheduleWindowOpen(record: Pick<ProjectSchedule, 'rule'>, scheduledAt: string, now?: number): boolean;
export function projectScheduleWindowPassed(record: Pick<ProjectSchedule, 'rule'>, scheduledAt: string, now?: number): boolean;

export interface ProjectRhythmAssessment {
  lifecycle: 'active' | 'recurring' | 'blocked' | 'complete'; reason: string; evidenceIds: string[]; scheduleIds: string[];
  initiative: { mode: 'adaptive' | 'event_only'; reviewAfterMs: number };
  evolution: { mode: 'evidence' | 'daily' | 'weekly' | 'off'; maxPerDay: number; maxPerWeek: number; minIntervalMs: number };
}
/** Host declaration under ProjectContext.actionContracts.rhythm. Assessment never grants permission. */
export interface ProjectRhythmHostContract { schemaVersion?: 1; enabled: boolean; requiresAssessment?: boolean }
/** One durable automatic reflection batch, including failed/unknown results. Transport retries use the same identity. */
export interface ProjectRhythmLearningAttempt { id: string; at: number; source: 'automatic' | 'manual'; status?: string }
export type ProjectRhythmReason = 'user_disabled' | 'manual_control' | 'assessment_required' | 'new_evidence' | 'awaiting_scheduled_work' | 'recurring_schedule_missing' | 'project_complete' | 'awaiting_changed_prerequisite' | 'awaiting_evidence' | 'review_due' | 'review_interval' | 'adaptive_evolution_off' | 'no_unreviewed_evidence' | 'automatic_review_quota_zero' | 'learning_due' | 'learning_interval' | 'weekly_review_quota' | 'daily_review_quota';
/** `nextAt` comes from recorded state, never from the reading clock: the anchor when the lane is or becomes due, or null when nothing anchors it (a due lane that never ran is `nextAt: null, state: 'ready'`). */
export interface ProjectRhythmLane { eligible: boolean; reason: ProjectRhythmReason; nextAt: number | null; state: 'ready' | 'sleeping' | 'disabled' }
export interface ProjectRhythmResolution {
  control: 'auto' | 'manual'; lifecycle: ProjectRhythmAssessment['lifecycle'] | 'unknown'; assessmentRequired: boolean;
  effective: { initiativeEnabled: boolean; evolutionEnabled: boolean };
  schedule: { activeCount: number; dueCount: number; nextAt: number | null };
  initiative: ProjectRhythmLane;
  evolution: ProjectRhythmLane & { quota: { dayUsed: number; weekUsed: number; maxPerDay: number | null; maxPerWeek: number | null; window: 'rolling' } };
}
export interface ProjectRhythmOptions {
  assessment?: ProjectRhythmAssessment | null; schedules?: Array<Pick<ProjectSchedule, 'id' | 'enabled' | 'nextRunAt'>>; now?: number;
  initiativeEnabled?: boolean; evolutionEnabled?: boolean; control?: 'auto' | 'manual';
  /** A host-verified changed external evidence revision, not a timer or model self-observation. */
  freshEvidence?: boolean; hasPendingLearning?: boolean;
  /** Epoch milliseconds of the last actual initiative / automatic learning admission. */
  lastInitiativeAt?: number | null; lastLearningAt?: number | null; learningAttempts?: ProjectRhythmLearningAttempt[];
}
export class ProjectRhythmError extends Error { constructor(message: string, code?: string); code: string }
export const projectRhythmAssessmentSchema: JsonSchema;
export function validateProjectRhythmAssessment(value: unknown, context?: { allowedEvidenceIds?: string[]; schedules?: Array<Pick<ProjectSchedule, 'id'>> }): ProjectRhythmAssessment;
/** Pure gate: hosts atomically persist admission before a request; existing permissions, budgets, backoff, due tasks and reconciliation remain independently authoritative. */
export function resolveProjectRhythm(options?: ProjectRhythmOptions): ProjectRhythmResolution;

export interface EvolutionSkill { id: string; instructions: string; contentHash?: string }
export interface EvolutionBaseline { strategy: string; projectId?: string; id?: string; versionId?: string; assignments?: CapabilityAssignment; skills?: EvolutionSkill[] }
export interface EvolutionVersion extends EvolutionBaseline { versionId: string; projectId: string; contentHash: string; skills: Array<Required<EvolutionSkill>>; assignments: Required<CapabilityAssignment> }
export interface EvolutionProposal {
  summary: string; hypothesis: string; strategy: string; skillUpdates: Array<{ skillId: string; instructions: string; reason: string }>;
  expectedImprovement: string; riskNotes: string[];
}
export interface EvolutionPolicy { tokenBudget?: number; proposalBudgetTokens?: number; evaluationBudgetTokens?: number; minImprovement?: number; regressionTolerance?: number; minCases?: number; maxTokenRatio?: number; timeoutMs?: number }
export interface EvaluationCase { id: string; weight?: number; [key: string]: JsonValue | undefined }
export interface EvaluationResult { score: number; passed: boolean; safetyPassed: boolean; evidence: JsonObject; usage?: Partial<Usage> }
export interface EvaluationPair { caseId: string; caseHash: string; weight: number; baseline?: EvaluationResult & { evaluatedAt: number }; candidate?: EvaluationResult & { evaluatedAt: number } }
export interface EvolutionGate { passed: boolean; failures: string[]; baselineScore: number; candidateScore: number; improvement: number; costMeasured: boolean; baselineTokens: number | null; candidateTokens: number | null; minImprovement: number; regressionTolerance: number }
export interface EvolutionEvaluation {
  id: string; evaluatorId: string; casesHash: string; baselineHash: string; candidateHash: string;
  scope: 'configured_cases_only'; statisticalClaim: 'none'; pairs: EvaluationPair[]; startedAt: number; finishedAt?: number; evidenceHash?: string; gate?: EvolutionGate;
}
export interface EvolutionCandidate {
  id: string; projectId: string; baselineVersionId: string; baselineHash: string; evidenceHash: string; evidence: JsonValue[];
  status: 'proposing' | 'proposed' | 'evaluating' | 'interrupted' | 'failed' | 'rejected' | 'ready' | 'trial' | 'promoted';
  createdAt: number; proposal?: EvolutionProposal; versionId?: string; contentHash?: string; error?: string; evaluation?: EvolutionEvaluation;
}
export interface EvolutionEvent extends Observation { projectId: string; candidateId: string }
export interface EvolutionState {
  schemaVersion: 1; projectId: string; versions: Record<string, EvolutionVersion>; activeVersionId: string; trialVersionId: string | null;
  candidates: EvolutionCandidate[]; history: Array<{ type: 'trial' | 'promote' | 'rollback' | 'end_trial'; candidateId?: string; versionId: string; fromVersionId?: string; at: number }>;
  events: EvolutionEvent[]; usedTokens: number; reservedTokens: number;
}
export type EvolutionProposer = (options: { project: ProjectContext & { id: string }; baseline: EvolutionVersion; evidence: JsonValue[]; signal: AbortSignal; tokenBudget: number }) => MaybePromise<EvolutionProposal | { proposal: EvolutionProposal; usage?: Partial<Usage>; usageReported?: boolean }>;
export type EvolutionEvaluator = (options: { project: ProjectContext & { id: string }; version: EvolutionVersion; testCase: EvaluationCase; side: 'baseline' | 'candidate'; signal: AbortSignal; tokenBudget: number }) => MaybePromise<EvaluationResult>;
export interface EvolutionOptions {
  project: ProjectContext & { id: string }; baseline: EvolutionBaseline; cases: EvaluationCase[]; evaluatorId?: string; evaluate?: EvolutionEvaluator; propose?: EvolutionProposer;
  model?: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; state?: EvolutionState; saveState?: (state: EvolutionState) => MaybePromise<void>;
  onEvent?: (event: EvolutionEvent) => void; policy?: EvolutionPolicy; now?: () => number;
}
export function proposeEvolution(options: { project?: ProjectContext; baseline: EvolutionVersion; evidence?: JsonValue[]; model?: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; signal?: AbortSignal; maxOutputTokens?: number }): Promise<BlockedResult | { status: 'proposed'; proposal: EvolutionProposal; usage: Usage; usageReported: boolean }>;
export function validateEvolutionProposal(proposal: unknown, baseline: Pick<EvolutionVersion, 'skills'>): EvolutionProposal;
export function evolutionHash(value: JsonValue | object): string;
export const evolutionProposalSchema: JsonSchema;
export class EvolutionCoordinator {
  constructor(options: EvolutionOptions);
  snapshot(): EvolutionState;
  currentVersion(options?: { includeTrial?: boolean }): EvolutionVersion;
  proposeCandidate(options?: { evidence?: JsonValue[]; signal?: AbortSignal }): Promise<EvolutionCandidate | BlockedResult>;
  evaluateCandidate(candidateId: string, options?: { signal?: AbortSignal }): Promise<EvolutionCandidate | BlockedResult>;
  runCycle(options?: { evidence?: JsonValue[]; signal?: AbortSignal }): Promise<EvolutionCandidate | BlockedResult>;
  trial(candidateId: string): Promise<EvolutionVersion>;
  promote(candidateId: string): Promise<EvolutionVersion>;
  rollback(versionId?: string): Promise<EvolutionVersion>;
  close(): Promise<void>;
}
export class EvolutionError extends Error { constructor(message: string, code?: string); code: string }


/** Installation is staged; the host validates and persists grants before activation. */
export type CapabilityPermission = 'read' | 'write' | 'exec';
export interface CapabilityInstallSource {
  type: 'local' | 'git' | 'npm' | 'mcp-config' | 'command';
  path?: string; repository?: string; ref?: string; subdirectory?: string;
  package?: string; registry?: string; bin?: string; command?: string; args?: string[];
  cwd?: string; env?: Record<string, string>; config?: JsonObject | string;
}
export interface CapabilityInstallInput {
  kind: 'skill' | 'mcp' | 'tool'; source: CapabilityInstallSource;
  id?: string; name?: string; description?: string; activate?: boolean;
  allowTools?: Record<string, { permission: CapabilityPermission; idempotent?: boolean }>;
  toolPermission?: CapabilityPermission; permission?: CapabilityPermission;
  parameters?: JsonSchema; idempotent?: boolean; reason?: string;
}
export interface InstalledCommandManifest {
  id: string; name: string; description: string; enabled: boolean; trusted: boolean;
  command: string; args: string[]; cwd: string; envMapping: Record<string, string>;
  toolName: string; parameters: JsonSchema; permission: CapabilityPermission;
  idempotent: boolean; protocol: 'json-stdin'; timeoutMs: number;
}
export type InstallationManifest =
  | { kind: 'skills'; manifest: SkillManifest & { contentHash?: string } }
  | { kind: 'mcpServers'; manifest: McpServerConfig & { envMapping?: Record<string, string> } }
  | { kind: 'tools'; manifest: InstalledCommandManifest };
export interface PreparedInstallation {
  installationId: string; stagingDir: string; installationDir: string;
  manifests: InstallationManifest[]; stagedManifests: InstallationManifest[];
  sources: JsonObject[]; diagnostics: JsonValue[];
  commit(): Promise<void>; rollback(): Promise<void>;
}
export class CapabilityInstaller {
  constructor(options: { rootDir: string; npmCommand?: string; gitCommand?: string; timeoutMs?: number });
  inspect(input: CapabilityInstallInput, options?: { signal?: AbortSignal }): Promise<JsonObject>;
  prepare(input: CapabilityInstallInput, options?: { signal?: AbortSignal; installationId?: string }): Promise<PreparedInstallation>;
}
export class CapabilityInstallError extends Error { constructor(message: string, code?: string, details?: unknown); code: string; details?: unknown }
export function capabilityProcessEnv(extra?: Record<string, string>): Record<string, string>;
export function resolveCapabilityCommand(command: string): Promise<string>;
export function runCapabilityProcess(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: Record<string, string>; input?: string | Uint8Array }): Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface ProjectGenomeSkill { id: string; name: string; description: string; instructions: string; resources: Array<{ path: string; content: string }>; source?: MarketplaceSkillProvenance | InstalledSkillProvenance }
export interface ReferenceResearchReceipt { schemaVersion: 1; ready: boolean; researchRequests: number; /** Permission for a correction, not proof that its provider request was admitted or sent. */ correctionGranted: boolean; pendingCapabilityIds: string[] }
export type ReferenceResearchReadiness = { ready: true } | { ready: false; pendingCapabilityIds: string[]; feedback: string; allowOneCorrection: boolean };
export interface ProjectReferencePolicy {
  /** Only staged source research uses this read-only readiness check. A pending result never permits artifact generation. An evidence-backed correction remains subject to request admission and is limited to one. Foundation-only short-summary and ordinary evolution callers retain their original finish/finalize contract. */
  researchReadiness?: (input: { signal: AbortSignal; snapshot: SessionSnapshot; boundary: 'artifact' | 'research_limit' }) => MaybePromise<ReferenceResearchReadiness>;
  beforeFinish?: (input: { message: Message; signal: AbortSignal }) => MaybePromise<{ feedback: Array<{ source: string; text: string }> } | undefined>;
  /** Optional host foundation check. Feedback uses the existing bounded author loop;
   * feedback at finalize rejects the stop without starting another model request. */
  beforeNoChange?: (input: { abstention: ProjectEvolutionAbstention; signal?: AbortSignal; stage: 'before_finish' | 'finalize'; message?: Message }) => MaybePromise<{ feedback: Array<{ source: string; text: string }> } | void>;
  /** Synchronous host-owned discovery snapshot. SDK receipts retain bounded metadata, never source bodies. */
  snapshot?: () => unknown;
  finalizeGenome?: (genome: ProjectGenome) => ProjectGenome;
}
export interface ProjectReferenceDiscovery {
  schemaVersion: 1; outcome: 'unavailable' | 'not_attempted' | 'failed' | 'empty' | 'no_package_selected' | 'acquired' | 'existing_reused' | 'incomplete'; installed: false; snapshotAvailable: boolean;
  counts?: { searches: number; filesRead: number; packages: number; failures: number };
  searches?: Array<{ provider?: string; resultCount: number; skippedUnsupported: number; coverage?: string }>;
  sources?: Array<{ provider?: string; id?: string; commit?: string; contentHash?: string }>;
  failures?: Array<{ operation?: string; provider?: string; code?: string }>;
  packages?: Array<{ skillId?: string; provider?: string; id?: string; commit?: string; packageHash?: string }>;
  disposition?: { status?: 'no_package_selected' | 'existing_package_reused'; skillId?: string; packageHash?: string } | null;
  omitted?: { searches: number; sources: number; failures: number; packages: number };
}
export interface ProjectSkillFoundationRequestReceipt {
  requestId: string; requestIndex: number; estimatedTokens: number; admitted: boolean; requestStarted: boolean; completed: boolean; usageReported: boolean; usage: ProjectGenomeUsage; cancelledBeforeSend?: true; stopReason?: string;
}
export interface ProjectSkillFoundationOptions {
  project: JsonObject; baseline: ProjectGenome;
  /** Verified and frozen by the host from current installed bytes; not supplied by the model. */
  existingInstalledSkills?: Array<ProjectGenomeSkill & { source: InstalledSkillProvenance }>;
  model: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; signal?: AbortSignal;
  beforeRequest?: (input: { requestId: string; requestIndex: number; estimatedTokens: number; usage: ProjectGenomeUsage; signal?: AbortSignal }) => MaybePromise<void>;
  onEvent?: (event: JsonObject) => void;
  referenceTools?: AgentTool[]; referenceContext?: () => unknown;
  referencePolicy: ProjectReferencePolicy & { finalizeGenome: (genome: ProjectGenome) => ProjectGenome };
}
export interface ProjectSkillFoundationResult {
  status: 'ready'; summary: string; genome: ProjectGenome; addedSkillIds: string[]; existingInstalledSkillIds: string[];
  behaviorPreserved: true; evaluationPerformed: false; usage: ProjectGenomeUsage; requests: ProjectSkillFoundationRequestReceipt[]; referenceDiscovery?: ProjectReferenceDiscovery;
}
export class ProjectSkillFoundationError extends Error { constructor(message: string, code?: string); code: string; usage?: ProjectGenomeUsage; requests?: ProjectSkillFoundationRequestReceipt[]; referenceDiscovery?: ProjectReferenceDiscovery; responseDiagnostic?: CompletedFinalResponseDiagnostic }
export function prepareProjectSkillFoundation(options: ProjectSkillFoundationOptions): Promise<ProjectSkillFoundationResult>;
export const PROJECT_GENOME_SCRIPT_API_CONTRACT: string;
export interface ProjectGenomeTool { id: string; name: string; description: string; permission: CapabilityPermission; parameters: JsonSchema; script: string; smokeCases: Array<{ input: JsonObject; expected: JsonValue; workspace?: { files: Array<{ path: string; content: string }> } }> }
export type ProjectArtifactCheck = { id: string; path: string } & ({ kind: 'file_exists' } | { kind: 'text_equals'; expected: string } | { kind: 'text_includes'; values: string[] } | { kind: 'json_equals'; expected: JsonValue } | { kind: 'javascript_syntax'; dialect: 'module' | 'commonjs' } | { kind: 'javascript_function'; exportName: string; args: JsonValue[]; expected: JsonValue });
export interface ProjectGenomeWorkspace { files: Array<{ path: string; content: string }>; checks: ProjectArtifactCheck[] }
export interface ProjectEvaluationClock { now: string; timeZone: string }
export interface ProjectResearchSource { id: string; title: string; url: string; publishedAt: string; body: string; /** May be omitted while authoring. The host computes it before freezing and rejects an explicitly incorrect hash. */ sha256?: string }
export interface ProjectResearchEvaluationDomain {
  kind: 'research'; sources: ProjectResearchSource[]; reportPath: string;
  checks: { requiredSourceIds: string[]; windowStart: string; windowEnd: string; minCitations: number; maxCitations: number };
}
export interface ProjectAutomationEvaluationDomain {
  kind: 'automation'; jobs: Array<{ id: string; payload: JsonValue }>;
  faults: Array<{ jobId: string; attempt: number; boundary: 'before_commit' | 'after_commit' }>;
  checks: { completedJobIds: string[]; maxAttemptsPerJob: number; requireReconciliation: boolean };
}
export type ProjectEvaluationDomain = ProjectResearchEvaluationDomain | ProjectAutomationEvaluationDomain;
export type NormalizedProjectEvaluationDomain = (Omit<ProjectResearchEvaluationDomain, 'sources'> & { sources: Array<ProjectResearchSource & { sha256: string }> }) | ProjectAutomationEvaluationDomain;
export interface ProjectDomainCheckReceipt { id: string; kind: string; passed: boolean; code: string; path?: string }
export interface ProjectDomainArtifactReceipt { path: string; hash: string; bytes: number; content: string; truncated: boolean }
export interface ProjectAutomationJobReceipt { jobId: string; status: 'pending' | 'completed'; attempts: number; receiptId?: string; payloadHash?: string; uncertain: boolean }
export interface ProjectDomainVerification {
  applicable: true; passed: boolean; checks: ProjectDomainCheckReceipt[]; artifacts: ProjectDomainArtifactReceipt[]; receipts: JsonObject[]; verifier: string;
  executionClaim: 'frozen_source_metadata_quote_provenance_only' | 'isolated_protocol_fixture_state_only'; limitations: string[];
  reportHash?: string; protocol?: ProjectAutomationJobReceipt[]; resultHash?: string;
  reviewReport?: { citations: Array<{ sourceId: string; url: string; publishedAt: string; sha256: string; quote: string; claim?: string }>; summary?: string };
}
export interface ProjectEvaluationDomainRuntime {
  tools: AgentTool[]; instructions: string;
  snapshot(): { kind: 'research' | 'automation'; receipts: JsonObject[]; exhausted: boolean; readSourceIds?: string[]; jobs?: ProjectAutomationJobReceipt[]; violations?: string[] };
  verify(signal?: AbortSignal): Promise<ProjectDomainVerification>;
}
export const evaluationDomainSchema: JsonSchema;
export const EVALUATION_DOMAIN_TOOL_NAMES: readonly ['research_search', 'research_read', 'automation_list', 'automation_execute', 'automation_status'];
export const PROJECT_DOMAIN_VERIFIER_VERSION: 'host-research-provenance-and-protocol-v1';
export function validateEvaluationDomain(value: unknown): NormalizedProjectEvaluationDomain;
export function evaluationDomainToolNames(domain?: ProjectEvaluationDomain): string[];
export function createEvaluationDomain(value: ProjectResearchEvaluationDomain, options: { workspace: string; signal?: AbortSignal }): ProjectEvaluationDomainRuntime;
export function createEvaluationDomain(value: ProjectAutomationEvaluationDomain, options?: { workspace?: string; signal?: AbortSignal }): ProjectEvaluationDomainRuntime;
export function createEvaluationDomain(value: ProjectEvaluationDomain, options: { workspace: string; signal?: AbortSignal }): ProjectEvaluationDomainRuntime;

export type BrowserEvaluationStep = { id: string; selector: string } & ({ kind: 'click' | 'assert_visible' } | { kind: 'input'; value: string } | { kind: 'assert_text'; expected: string } | { kind: 'assert_count'; expected: number });
export interface BrowserEvaluationEnvironment { kind: 'browser'; entry: string; viewport: { width: number; height: number }; steps: BrowserEvaluationStep[]; screenshot?: boolean; settleMs?: number; visualReview?: boolean }
export interface BrowserEvaluationCheckReceipt { id: string; kind: BrowserEvaluationStep['kind'] | 'entry'; selector?: string; passed: boolean; code: string; observed?: { count: number; visible: boolean; text?: string | null } }
export interface BrowserEvaluationReceipt {
  applicable: true; passed: boolean; verifier: string; checks: BrowserEvaluationCheckReceipt[];
  executionClaim: 'browser_entry_missing' | 'local_static_browser_interactions_only';
  runtimeErrors?: Array<{ text: string }>; consoleErrors?: Array<{ text: string }>;
  networkAttempts?: Array<{ url: string; blocked: true; directive?: string; method?: string; resourceType?: string }>;
  resourceErrors?: Array<{ path: string; code: string }>; omittedReceipts?: number;
  screenshot?: { mimeType: 'image/png'; hash: string; bytes: number; width: number; height: number; retained: boolean; path?: string };
  browser?: { product: string; protocolVersion: string }; viewport?: { width: number; height: number }; durationMs?: number;
  artifacts?: Array<{ path: string; hash: string; bytes: number }>;
  isolation?: { freshProfile: true; externalNetwork: 'blocked_by_browser_policies_and_request_interception'; workspace: 'in_memory_static_snapshot'; osSandbox: 'not_claimed'; networkBoundary: 'not_an_os_firewall' };
}
export interface BrowserEvaluationProbe { available: true; adapter: string; version: string; executableHash: string; executableHashScope: 'browser_launcher_binary'; policy: 'fresh_profile_static_snapshot_block_external_v1' }
export interface BrowserEvaluationAdapter {
  id: string;
  probe(options?: { signal?: AbortSignal }): Promise<BrowserEvaluationProbe>;
  verify(options: { workspace: string; environment: BrowserEvaluationEnvironment; signal?: AbortSignal; artifactKey?: string }): Promise<BrowserEvaluationReceipt>;
}
export interface ProjectEvaluationEnvironmentAdapters { browser?: BrowserEvaluationAdapter }
export const browserEvaluationEnvironmentSchema: JsonSchema;
export const PROJECT_EVALUATION_DOMAIN_AUTHORING: string;
export const BROWSER_EVALUATION_ADAPTER_ID: 'local-chromium-cdp-v1';
export function validateBrowserEvaluationEnvironment(value: unknown): BrowserEvaluationEnvironment | undefined;
export function createBrowserEvaluationAdapter(options?: { executablePath?: string; startupTimeoutMs?: number; artifactDirectory?: string }): BrowserEvaluationAdapter;

export type ProjectEvaluationPartition = 'development' | 'selection' | 'confirmation';
export interface ProjectEvaluationPartitionAssignment { caseId: string; partition: ProjectEvaluationPartition; taskFamily?: string }
export interface ProjectEvaluationConfirmationProvenance { datasetId: string; version: string; sourceHash: string; reviewId: string; reviewedAt: string; authorship: 'independent_host_review'; exposure: 'withheld' }
export const PROJECT_EVALUATION_PARTITION_METHOD: Readonly<{
  id: 'project-partitions-v1'; version: 1; order: readonly ['selection', 'confirmation']; developmentUse: 'author_diagnostics_only'; confirmationAdmission: 'selection_gates_passed';
  confirmationReuse: 'one_candidate_once'; confirmationRequiredWhenPresent: true; missingConfirmation: 'not_applicable'; independenceClaim: 'host_reviewed_provenance_not_statistical_proof'; hash: string;
}>;
export interface ProjectEvaluationPartitionPlan {
  readonly schemaVersion: 1; readonly method: typeof PROJECT_EVALUATION_PARTITION_METHOD; readonly frozenAt: string; readonly suiteHash: string; readonly planHash: string;
  readonly assignments: ReadonlyArray<Readonly<{ caseId: string; partition: ProjectEvaluationPartition; taskFamily: string; caseHash: string }>>;
  readonly confirmation: Readonly<{ status: 'available' | 'not_applicable'; reason: 'host_reviewed_withheld_cases' | 'independent_confirmation_not_supplied'; dataHash: string | null; taskHashes: readonly string[]; provenance: Readonly<ProjectEvaluationConfirmationProvenance> | null }>;
}
export interface ProjectEvaluationPartitionSummary {
  readonly methodId: string; readonly planHash: string; readonly counts: Readonly<Record<ProjectEvaluationPartition, number>>;
  readonly taskFamilies: ReadonlyArray<Readonly<{ taskFamily: string; development: number; selection: number; confirmation: number }>>;
  readonly confirmation: Readonly<{ status: 'available' | 'not_applicable'; reason: string; passed: null }>; readonly statisticalClaim: 'none';
}
export interface ProjectEvaluationConfirmationClaimIdentity {
  readonly schemaVersion: 1; readonly planHash: string; readonly suiteHash: string; readonly candidateHash: string; readonly confirmationDataHash: string;
  readonly confirmationTaskHashes: readonly string[]; readonly claimedAt: string; readonly claimHash: string;
}
export interface ProjectEvaluationActiveConfirmationClaim extends ProjectEvaluationConfirmationClaimIdentity { readonly status: 'claimed' }
export interface ProjectEvaluationSettledConfirmationClaim extends ProjectEvaluationConfirmationClaimIdentity {
  readonly status: 'passed' | 'failed' | 'interrupted'; readonly settledAt: string; readonly resultHash: string | null; readonly reason: string | null; readonly settlementHash: string;
}
export type ProjectEvaluationConfirmationClaim = ProjectEvaluationActiveConfirmationClaim | ProjectEvaluationSettledConfirmationClaim;
export type ProjectEvaluationPhase = 'author' | 'preflight' | 'deterministic' | 'paired' | 'confirmation';
export type ProjectEvaluationStageStatus = 'not_started' | 'running' | 'passed' | 'failed' | 'interrupted' | 'skipped' | 'not_applicable';
export interface ProjectEvaluationPhaseRequest { id: string; phase: string; usage: Partial<ProjectGenomeUsage>; completed?: boolean; requestStarted?: boolean; [key: string]: unknown }
export interface ProjectEvaluationPhaseLedger {
  readonly schemaVersion: 1; readonly requestCount: number; readonly qualityClaim: 'none'; readonly usage: Readonly<ProjectGenomeUsage>;
  readonly phases: ReadonlyArray<Readonly<{ phase: ProjectEvaluationPhase; status: ProjectEvaluationStageStatus | 'observed_requests'; reasons: readonly string[]; requests: number; completedRequests: number; startedRequests: number; usage: Readonly<ProjectGenomeUsage> }>>;
  readonly unmatched: Readonly<{ requests: number; usage: Readonly<ProjectGenomeUsage> }>;
}
export class ProjectEvaluationPartitionError extends Error { constructor(message: string, code?: string); code: string }
export function createProjectEvaluationPartitionPlan(options: { suite: ProjectGenomeSuite; assignments?: readonly ProjectEvaluationPartitionAssignment[]; confirmationProvenance?: ProjectEvaluationConfirmationProvenance; frozenAt?: string }): ProjectEvaluationPartitionPlan;
export function validateProjectEvaluationPartitionPlan(plan: unknown, suite: ProjectGenomeSuite): ProjectEvaluationPartitionPlan;
export function projectEvaluationPartitionCases(plan: ProjectEvaluationPartitionPlan, suite: ProjectGenomeSuite, partition: ProjectEvaluationPartition): ProjectGenomeCase[];
export function projectEvaluationPartitionSummary(plan: ProjectEvaluationPartitionPlan): ProjectEvaluationPartitionSummary;
export function createProjectEvaluationConfirmationClaim(options: { plan: ProjectEvaluationPartitionPlan; candidateHash: string; existingClaims?: readonly ProjectEvaluationConfirmationClaim[]; claimedAt?: string }): ProjectEvaluationActiveConfirmationClaim;
export function validateProjectEvaluationConfirmationClaim(claim: unknown, options?: { plan?: ProjectEvaluationPartitionPlan; candidateHash?: string }): ProjectEvaluationConfirmationClaim;
export function settleProjectEvaluationConfirmationClaim(claim: ProjectEvaluationConfirmationClaim, outcome: { status: 'passed' | 'failed' | 'interrupted'; settledAt?: string; resultHash?: string | null; reason?: string | null }): ProjectEvaluationSettledConfirmationClaim;
export function createProjectEvaluationPhaseLedger(options?: { requests?: readonly ProjectEvaluationPhaseRequest[]; stages?: ReadonlyArray<{ phase: ProjectEvaluationPhase; status: ProjectEvaluationStageStatus; reason?: string }>; plan?: ProjectEvaluationPartitionPlan }): ProjectEvaluationPhaseLedger;
export interface ProjectGenomeFollowUp { input: string; requiredTerms?: string[]; forbiddenTerms?: string[]; requiredToolIds?: string[]; artifactChecks?: ProjectArtifactCheck[] }
export interface ProjectGenomeCase { reviewConversation?: boolean; followUps?: ProjectGenomeFollowUp[]; clock?: ProjectEvaluationClock; id: string; input: string; requiredTerms: string[]; forbiddenTerms: string[]; requiredToolIds: string[]; weight: number; workspace?: ProjectGenomeWorkspace; domain?: ProjectEvaluationDomain; environment?: BrowserEvaluationEnvironment }
export interface ProjectGenomeSuite { version: string; criteria: Array<{ id: string; description: string; weight: number }>; cases: ProjectGenomeCase[]; execution?: { maxSteps: number; maxOutputTokens: number }; thresholds: { minImprovement: number; maxRegression: number; minScore: number; maxTokenRatio: number } }
export interface ProjectGenome { schemaVersion: 1; systemPrompt: string; skills: ProjectGenomeSkill[]; tools: ProjectGenomeTool[]; evaluationSuite: ProjectGenomeSuite }
export interface ProjectGenomeUsage extends Usage { estimatedTokens: number }
export interface GenomeRunnerOptions { workspace: string; signal?: AbortSignal; deniedPaths?: string[]; timeoutMs?: number; maxOutputBytes?: number }
export const projectGenomeSchema: JsonSchema;
export function validateProjectGenome(value: unknown): ProjectGenome;
export function projectGenomeHash(genome: ProjectGenome): string;
export function genomeToolName(namespace: string | undefined, localId: string): string;
/** Model-facing identity of a project's generated capabilities: stable across generations (EVO-3). */
export function genomeNamespace(projectId: string): string;
export function createGenomeTools(genome: ProjectGenome, options: GenomeRunnerOptions & { namespace?: string }): RegisteredTool[];
export function runGenomeScript(tool: ProjectGenomeTool, input: JsonObject, options: GenomeRunnerOptions): Promise<{ value: JsonValue; effects: JsonObject[]; execution: 'node-restricted-api'; diagnostics: string }>;
export interface ProjectGenomeSmoke { passed: boolean; results: JsonObject[]; executed: boolean; applicable: boolean; runner: 'node-restricted-api' }
export function smokeProjectGenome(genome: ProjectGenome, options?: { signal?: AbortSignal }): Promise<ProjectGenomeSmoke>;
export class ProjectGenomeError extends Error { constructor(message: string, code?: string); code: string; phase?: 'compile' | 'execution' | 'serialization'; line?: number }
export interface ProjectGenomeRequestControl {
  beforeRequest?: (input: { id: string; phase: string; estimatedTokens: number; signal?: AbortSignal; evaluationRepeat?: ProjectEvaluationRepeatReceipt }) => MaybePromise<void>;
  onUsage?: (receipt: { id: string; phase: string; maxOutputTokens?: number; configuredReasoning?: Reasoning; usage: ProjectGenomeUsage; usageReported: boolean; estimatedWhenUnknown: boolean; completed: boolean; requestStarted: boolean; cancelledBeforeSend?: true; evaluationTurn?: { caseId: string; turn: number }; evaluationRepeat?: ProjectEvaluationRepeatReceipt }) => MaybePromise<void>;
}
export interface ProjectGenomeEvolutionOptions { model: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; signal?: AbortSignal; tokenBudget?: number | null; onProgress?: (event: JsonObject) => void; requestControl?: ProjectGenomeRequestControl }
export interface ProjectEvolutionDiagnosis { cause: 'domain_knowledge' | 'task_interpretation' | 'context' | 'skill_method' | 'tool_contract' | 'validation' | 'runtime_infrastructure'; evidenceIds: string[]; explanation: string; intervention: string; validationPlan: string; limitations: string[] }
export interface ProjectEvolutionLearningIntent { content: string; reason: string; evidenceIds: string[] }
export interface ProjectEvolutionChangedAsset { kind: 'prompt' | 'skill' | 'resource' | 'tool'; id: string; path?: string; change: 'added' | 'modified' | 'removed' }
export interface ProjectEvolutionAssetDiff extends ProjectEvolutionChangedAsset { beforeHash: string | null; afterHash: string | null }
export interface ProjectEvolutionBehaviorChanges { baselineBehaviorHash: string; candidateBehaviorHash: string; changes: ProjectEvolutionAssetDiff[]; changedAssetCount: number; countingUnit: 'prompt_or_complete_skill_or_tool'; evaluationSuiteChanged: boolean; smokeContractsChanged: boolean }
/** Host-selected original author hypotheses and selection outcomes. Never include hidden cases, confirmation results, or raw judge feedback. */
/** Delivery facts from retained selection executions; never a quality or adoption score. */
export interface ProjectEvolutionSkillDelivery {
  scope: 'selection_runtime_receipts'; qualityClaim: 'none';
  observedExecutions: number; expectedExecutions: number; omittedItems: number;
  items: Array<{ id: string; path: string; catalogSubmitted: number; resourceInventorySubmitted: number; delivered: number; notRequested: number; contentNotSubmitted: number; partialDelivery: number; unknown: number }>;
}
export interface ProjectEvolutionSearchFeedback { skillDelivery?: ProjectEvolutionSkillDelivery; reason: 'source_unavailable' | 'in_progress' | 'author_incomplete' | 'author_no_change' | 'candidate_not_retained' | 'preflight_incomplete' | 'provider_incomplete' | 'execution_identity_unverified' | 'selection_incomplete' | 'environment_identity_not_preflighted' | 'exposure_unverified' | 'changes_not_exercised' | 'selection_passed' | 'selection_no_gain' | 'selection_constraints_failed'; comparable: boolean; failedGates?: Array<'deterministicCases' | 'minimumScore' | 'improvement' | 'noRegression' | 'tokenRatio'>; exposure?: { required: number; observed: number; unobserved: number; unknown: number } }
export interface ProjectEvolutionSearchHistoryEntry { feedback?: ProjectEvolutionSearchFeedback; id: string; baselineBehaviorHash: string; candidateBehaviorHash: string; evidenceHash: string; comparisonKey: string; hypothesis: string; outcome: 'accepted' | 'rejected' | 'incomplete' | 'not_evaluated'; changedAssets?: ProjectEvolutionChangedAsset[] }
/** A structural bound on affected capabilities, not a statistical/causal edit budget. All resources of a skill share its one unit. */
export interface ProjectEvolutionSearchPolicy { maxChangedAssets?: number; comparisonKey?: string; history?: ProjectEvolutionSearchHistoryEntry[] }
export interface ProjectEvolutionSearchReview extends ProjectEvolutionBehaviorChanges { schemaVersion: 1; evidenceHash: string; comparisonKey?: string; maxChangedAssets?: number; enforced: boolean; repeatedHypothesisIds: string[]; duplicateCandidateIds: string[]; status: 'passed' | 'rejected'; reasons: Array<'no_behavior_change' | 'asset_scope_exceeded' | 'duplicate_measured_candidate'> }
export function projectGenomeBehaviorHash(genome: ProjectGenome): string;
export function projectEvolutionEvidenceHash(evidence?: JsonValue[]): string;
export function describeProjectGenomeChanges(baseline: ProjectGenome, candidate: ProjectGenome): ProjectEvolutionBehaviorChanges;
export function validateProjectEvolutionSearchPolicy(value: unknown): (ProjectEvolutionSearchPolicy & { history: ProjectEvolutionSearchHistoryEntry[] }) | undefined;
export function projectEvolutionAuthorSearchContext(policy?: ProjectEvolutionSearchPolicy): { schemaVersion: 1; maxChangedAssets?: number; countingUnit: 'prompt_or_complete_skill_or_tool'; scope: 'project_capability_package_only'; history: Array<Pick<ProjectEvolutionSearchHistoryEntry, 'id' | 'hypothesis' | 'outcome' | 'feedback'> & { changedAssets: ProjectEvolutionChangedAsset[] }>; historyMeaning: string } | undefined;
export function reviewProjectEvolutionCandidate(options: { baseline: ProjectGenome; candidate: ProjectGenome; evidence?: JsonValue[]; hypothesis?: string; searchPolicy?: ProjectEvolutionSearchPolicy }): ProjectEvolutionSearchReview;
export const PROJECT_EVOLUTION_SEARCH_GUIDANCE: string;
/** Host materialization provenance; inheritance references are never published tools. */
export interface ProjectGenomeToolInheritance { baselineHash: string; tools: Array<{ id: string; toolHash: string }> }
export interface ProjectSkillWithdrawal { id: string; beforeHash: string; reason: string }
export interface ProjectSkillResourceWithdrawal { skillId: string; path: string; beforeHash: string; reason: string }
export interface ProjectAssetDeclarations { withdrawSkills?: ProjectSkillWithdrawal[]; withdrawSkillResources?: ProjectSkillResourceWithdrawal[] }
export interface ProjectAssetChanges { schemaVersion: 1; baselineHash: string; inheritedSkills: Array<{ id: string; beforeHash: string }>; inheritedSkillResources: Array<{ skillId: string; path: string; beforeHash: string }>; withdrawnSkills: ProjectSkillWithdrawal[]; withdrawnSkillResources: ProjectSkillResourceWithdrawal[] }
export interface ProjectEvaluationExecutionManifest { readonly schemaVersion: 1; readonly profile: Readonly<{ id: string; version: number; hash: string }>; readonly sourceSuiteHash: string; readonly modelLimits: Readonly<{ maxOutputTokens: number }>; readonly sessionPolicy: Readonly<{ autoCompaction: false; stepLimitBehavior: 'error' }>; readonly toolErrorPolicy: 'strict-v1' | 'schema-recovery-v1' | 'schema-recovery-v2'; readonly cases: ReadonlyArray<Readonly<{ id: string; conversation?: Readonly<{ turns: number; fixtureHash: string; session: 'persistent'; allowance: 'same_per_turn'; workspaceChecks: 'invariant_after_each_turn' }>; clock?: ProjectEvaluationClock; workspace: boolean; domain?: Readonly<{ kind: 'research' | 'automation'; fixtureHash: string }>; environment?: Readonly<{ kind: 'browser'; fixtureHash: string }>; execution: Readonly<{ maxSteps: number; maxOutputTokens: number }> }>>; readonly effectiveExecutionHash: string; readonly manifestHash: string }
export interface ProjectLearningContext { schemaVersion: 1; evidence: Array<{ id: string; content: string }>; files: Array<{ path: string; content: string }> }
export const LEARNING_CONTEXT_LIMITS: Readonly<{ evidence: 32; files: 24; itemBytes: 128000; totalBytes: 1048576; pageChars: 12000 }>;
export function validateProjectLearningContext(value: unknown, evidence?: JsonValue[]): ProjectLearningContext | undefined;
export interface FrozenProjectLearningContext { snapshot: ProjectLearningContext; contextHash: string; inventory: JsonObject[]; tools: AgentTool[]; reads(): JsonObject[] }
export function createProjectLearningContext(value: unknown, evidence?: JsonValue[], options?: { onRead?: (receipt: JsonObject) => void }): FrozenProjectLearningContext | undefined;
export function validateProjectEvolutionLearningIntent(value: unknown, evidence?: JsonValue[]): ProjectEvolutionLearningIntent | undefined;
export interface ProjectEvolutionAbstention { reason: 'no_method_gap' | 'insufficient_evidence'; summary: string; explanation: string; evidenceIds: string[]; revisitWhen: Array<{ condition: 'new_work_evidence' | 'reproduced_failure' | 'task_scope_changed' | 'capability_available'; description: string }> }
export type ProjectGenomeProposalOptions = ProjectGenomeEvolutionOptions & { project: JsonObject; baseline: ProjectGenome; evidence: JsonValue[]; learningIntent?: ProjectEvolutionLearningIntent; learningContext?: ProjectLearningContext; searchPolicy?: ProjectEvolutionSearchPolicy; maxAttempts?: number; referenceTools?: AgentTool[]; referenceContext?: () => unknown; referencePolicy?: ProjectReferencePolicy };
export type ProjectGenomeProposalResult = { status?: undefined; attempts: number; earlyStopReason?: 'unchanged_repair'; validation: JsonObject; repairEvidence: JsonObject[]; learningContextReads?: JsonObject[]; referenceDiscovery?: ProjectReferenceDiscovery; proposal: { summary: string; hypothesis: string; diagnosis: ProjectEvolutionDiagnosis; changes: string[]; genome: ProjectGenome; evaluationSuiteSource: 'inherited_frozen_baseline' | 'candidate_future_proposal'; toolInheritance?: ProjectGenomeToolInheritance; assetChanges: ProjectAssetChanges; searchReview?: ProjectEvolutionSearchReview; withdrawSkills?: ProjectSkillWithdrawal[]; withdrawSkillResources?: ProjectSkillResourceWithdrawal[] }; usage: ProjectGenomeUsage; requests: JsonObject[] };
export interface ProjectGenomeAbstentionResult { status: 'no_change'; abstention: ProjectEvolutionAbstention; proposal?: never; validation: null; attempts: number; repairEvidence: JsonObject[]; learningContextReads?: JsonObject[]; referenceDiscovery?: ProjectReferenceDiscovery; usage: ProjectGenomeUsage; requests: JsonObject[] }
export function proposeProjectGenome(options: ProjectGenomeProposalOptions & { allowAbstention?: false }): Promise<ProjectGenomeProposalResult>;
export function proposeProjectGenome(options: ProjectGenomeProposalOptions & { allowAbstention: boolean }): Promise<ProjectGenomeProposalResult | ProjectGenomeAbstentionResult>;
export const PROJECT_EVALUATION_RUNTIME: Readonly<{ methodVersion: string; methodHash: string; coreMethodSkillsHash: string; implementationHash: string; nodeVersion: string; verifierVersion: string; protocolVersion: string; executionProfile: Readonly<{ id: string; version: number; hash: string; defaults: Readonly<{ withoutWorkspace: Readonly<{ maxSteps: number; maxOutputTokens: number }>; withWorkspace: Readonly<{ maxSteps: number; maxOutputTokens: number }> }>; sessionPolicy: Readonly<{ autoCompaction: false; stepLimitBehavior: 'error' }> }>; sessionPolicy: Readonly<{ autoCompaction: false; stepLimitBehavior: 'error' }> }>;
export const PROJECT_EVALUATION_RUNTIME_HASH: string;
export interface ProjectEvaluationGroupResult { cases: number; baselineScore: number; candidateScore: number; gates: Record<string, boolean>; gatePassed: boolean }
export interface ProjectEvaluationConfirmationResult extends Partial<ProjectEvaluationGroupResult> { status: 'passed' | 'failed' | 'skipped' | 'not_applicable'; passed: boolean | null; reason?: string }
export interface ProjectEvaluationCoverage {
  conversationReviewedCases?: number; plannedMeasurements?: number; selectionRepeats?: number; visualJudgedCases?: number; researchReviewedCases?: number; multiTurnCases?: number; userTurns?: number; behaviorChecks?: number; totalCases: number; workspaceCases: number; artifactChecks: number; browserCases: number; researchCases: number; automationCases: number;
  browserInteraction: 'planned_host_fixed_interactions' | 'not_verified'; researchProvenance: 'frozen_sources_only'; externalAutomation: 'not_verified';
  behaviorExecution: 'generated_scripts_only' | 'generated_scripts_and_isolated_pure_functions'; artifactVerification: 'file_contents_and_syntax_only' | 'file_contents_syntax_and_isolated_pure_functions'; visualQuality: 'not_verified';
}
export interface ProjectGenomeEvaluation {
  evaluationRevision?: ProjectEvaluationRevision; evaluationExecution: ProjectEvaluationExecutionManifest; assetChanges: ProjectAssetChanges; gatePassed: boolean; evaluationComplete: boolean;
  stage: 'script_preflight' | 'deterministic_case' | 'completed'; earlyStopReason?: 'baseline_contract_failed' | 'candidate_smoke_failed' | 'frozen_tool_contract_failed' | 'candidate_deterministic_failed';
  baseline: number | null; score: number | null; baselineScore: number | null; candidateScore: number | null; cases: number; scoredCases: number; skippedCases: number; details: JsonObject[]; gates: Record<string, boolean | null>;
  baselineSmoke: JsonObject; smoke: ProjectGenomeSmoke; frozenSmoke: JsonObject[]; suite: ProjectGenomeSuite; suiteHash: string; criteriaHash: string; baselineHash: string; candidateHash: string; candidateSuiteHash: string;
  candidateStandardUsed: false; scope: 'frozen_project_cases_only'; statisticalClaim: 'none'; judgeContext: 'blind_separate_context_same_configured_model'; methodologyVersion: string; evaluationRuntimeHash: string; evaluationRuntime: typeof PROJECT_EVALUATION_RUNTIME;
  coverage: ProjectEvaluationCoverage; partitionPlan: ProjectEvaluationPartitionPlan; partitionSummary: ProjectEvaluationPartitionSummary; phaseLedger: ProjectEvaluationPhaseLedger;
  repeatPlan?: ProjectEvaluationRepeatPlan; evaluationComparisonHash?: string; selection?: ProjectEvaluationGroupResult | ProjectEvaluationRepeatResult; confirmation: ProjectEvaluationConfirmationResult; environmentIdentity?: BrowserEvaluationProbe;
  exposure: import('./project-evaluation-exposure.js').ProjectEvaluationExposureSummary;
  model: JsonObject; usage: ProjectGenomeUsage; requests: JsonObject[]; completedAt: string; simulated: false;
}
export interface ProjectEvaluationCaseExecution { caseId: string; result: JsonObject; usage: ProjectGenomeUsage; requests: JsonObject[]; evaluationExecution: ProjectEvaluationExecutionManifest; evaluationRuntimeHash: string; suiteHash: string; scope: 'single_case_execution_only'; promotionEligible: false; simulated: false }
export function executeProjectEvaluationCase(options: ProjectGenomeEvolutionOptions & { genome: ProjectGenome; caseId: string; environmentAdapters?: ProjectEvaluationEnvironmentAdapters }): Promise<ProjectEvaluationCaseExecution>;
export interface ProjectEvaluationConfirmationControl {
  repeatPlan?: ProjectEvaluationRepeatPlan;
  partitionPlan?: ProjectEvaluationPartitionPlan;
  claimConfirmation?: (input: { plan: ProjectEvaluationPartitionPlan; candidateHash: string }) => MaybePromise<ProjectEvaluationActiveConfirmationClaim>;
  settleConfirmation?: (claim: ProjectEvaluationActiveConfirmationClaim, result: { status: 'passed' | 'failed' | 'interrupted'; resultHash?: string; reason?: string }) => MaybePromise<void>;
}
export function evaluateProjectGenomes(options: ProjectGenomeEvolutionOptions & ProjectEvaluationConfirmationControl & { baseline: ProjectGenome; candidate: ProjectGenome; assetDeclarations?: ProjectAssetDeclarations; evaluationRevision?: ProjectEvaluationRevisionInput; environmentAdapters?: ProjectEvaluationEnvironmentAdapters }): Promise<ProjectGenomeEvaluation>;
export function estimateProjectEvolutionBudget(genome: ProjectGenome, model: ModelConfig): number;
export class ProjectEvolutionError extends Error { constructor(message: string, code?: string); code: string; referenceDiscovery?: ProjectReferenceDiscovery; usage?: ProjectGenomeUsage; requests?: JsonObject[]; repairEvidence?: JsonObject[]; evaluationEvidence?: JsonObject; evolutionDiagnostic?: { phase: string; kind: string; caseId?: string; stopReason?: string | null; providerFinishReason?: string | null; responseDiagnostic?: CompletedFinalResponseDiagnostic; argumentDiagnostic?: CompletedSubmissionArgumentDiagnostic; expectedCriterionIds?: string[]; actualCriterionIds?: string[]; expectedCount?: number; actualCount?: number; missingCriterionIds?: string[]; unknownCriterionIds?: string[]; duplicateCriterionIds?: string[]; missingFields?: string[]; invalidIdTypes?: Array<{ index: number; type: 'undefined' | 'null' | 'array' | 'object' | 'number' | 'boolean' | 'bigint' | 'function' | 'symbol' }>; criterionIdsTruncated?: boolean } }

export type BuiltinAgentRole = 'scout' | 'planner' | 'reviewer' | 'worker';
export const BUILTIN_AGENT_ROLES: ReadonlyArray<Readonly<{ id: BuiltinAgentRole; name: string; readOnly: boolean; maxSteps: number; description: string; instruction: string }>>;
/** Model steps a child of this role gets before it must summarize; null for an unknown role. */
export function delegationSteps(role: string): number | null;
export const CONVERSATION_EXCERPT: Readonly<{ messages: number; chars: number }>;
export const CONVERSATION_LABEL: string;
/** The user's own recent messages (oldest first) as the labelled excerpt a child receives; null when there is nothing to attach. */
export function conversationExcerpt(messages: string[], options?: { count?: number; chars?: number }): string | null;
export class DelegationError extends Error { constructor(message: string, code: string); code: string; details?: { cleanupUncertain?: boolean; executionKnown?: boolean } }
export interface DelegatedAgentResult { agentId: string; role: BuiltinAgentRole; status: 'completed'; output: string; truncated: boolean; usage: Usage; reused: boolean; /** The child ran out of model steps and answered with its step-limit summary. */ stepLimitReached: boolean }
export interface DelegatedAgentEvent { type: string; agentId: string; role: BuiltinAgentRole; toolName?: string; toolCallId?: string; isError?: boolean; uncertain?: boolean; status?: string; code?: string; reused?: boolean }
export const DELEGATION_TOOL_NAMES: readonly ['agent_consult', 'agent_delegate', 'agent_status', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_merge'];
export interface DelegatedAgentControl { steer(message: string): Promise<unknown> }
export function runDelegatedAgent(options: { role: BuiltinAgentRole; task: string; sessionId: string; signal: AbortSignal; maxSteps?: number; conversation?: string[]; onUpdate?: (event: DelegatedAgentEvent) => void; onControl?: (control: DelegatedAgentControl) => void; createChild: (options: { sessionId: string; readOnly: boolean; maxSteps: number; stepLimitBehavior: 'summarize'; delegationDepth: 1; systemPrompt: string; onEvent: (event: SessionEvent) => void }) => MaybePromise<Session> }): Promise<DelegatedAgentResult>;
export interface DelegationControlHandlers {
  status(args: { agentId?: string }, signal: AbortSignal): MaybePromise<ToolResult>;
  message(args: { agentId: string; message: string; callId: string }, signal: AbortSignal): MaybePromise<ToolResult>;
  wait(args: { agentIds?: string[]; mode?: 'any' | 'all'; timeoutSeconds?: number }, signal: AbortSignal): MaybePromise<ToolResult>;
  cancel(args: { agentId: string }, signal: AbortSignal): MaybePromise<ToolResult>;
  /** agent_merge: the host settles a worker's changes (or a background change set handed to this conversation) with the parent's files. */
  merge(args: AgentMergeArgs & { callId: string }, signal: AbortSignal): MaybePromise<ToolResult>;
}
/** agent_merge (worktree isolation, 0.63): name, actions, the fixed English description and the agent_delegate sentence about isolated workers. */
export const AGENT_MERGE_TOOL_NAME: 'agent_merge';
export const AGENT_MERGE_ACTIONS: readonly ['merge', 'show', 'take', 'resolved', 'drop'];
export const AGENT_MERGE_TEXT: string;
export const DELEGATE_ISOLATION_TEXT: string;
/** Exactly one of agentId / changeId (the schema refuses both, the host refuses neither); `take` paths must be in the host's conflict list. */
export interface AgentMergeArgs { agentId?: string; changeId?: string; action?: 'merge' | 'show' | 'take' | 'resolved' | 'drop'; path?: string; page?: number; take?: { path: string; side: 'current' | 'incoming' }[] }
/** The agent_merge tool record; `merge` receives the validated arguments plus the call id. */
export function agentMergeTool(merge: (args: AgentMergeArgs & { callId: string }, signal: AbortSignal) => MaybePromise<ToolResult>): AgentTool;
/** Without `control` only agent_consult/agent_delegate are declared (synchronous hosts). */
export function createDelegationTools(run: (callId: string, args: { role: BuiltinAgentRole; task: string; wait?: boolean; continueAfter?: boolean; includeConversation?: boolean; files?: string[] }, signal: AbortSignal, onUpdate?: (result: ToolResult | string) => void) => MaybePromise<ToolResult>, control?: DelegationControlHandlers): AgentTool[];

export type SkillMarketplaceProvider = 'skills-sh' | 'skillsmp';
export interface MarketplaceSkillProvenance { kind: 'marketplace-package'; provider: SkillMarketplaceProvider; id: string; repository: string; commit: string; subdirectory: string; sourceUrl: string; catalogUrl: string; packageHash: string; acquiredAt: string; reason: string; compatibility: string; licenseReview: 'preserved_not_legal_approval'; licensePaths: string[]; files: Array<{ path: string; contentHash: string; bytes: number }> }
export interface InstalledSkillProvenance { kind: 'installed-skill-package'; integrity: 'installed_snapshot'; installationId: string; manifestId: string; installationRecordHash: string; repository: string; commit: string; subdirectory: string; packageHash: string; frozenAt: string; reason: string; compatibility: string; licenseReview: 'preserved_not_legal_approval'; licensePaths: string[]; files: Array<{ path: string; contentHash: string; bytes: number }> }
export interface SkillMarketplaceBundle extends Omit<MarketplaceSkillProvenance, 'kind' | 'reason' | 'compatibility' | 'files'> { files: Array<{ path: string; content: string; contentHash: string; bytes: number }>; installed: false; executesCode: false }
export interface SkillMarketplaceEntry {
  provider: SkillMarketplaceProvider; id: string; name: string; description: string; repository: string;
  sourceUrl: string; catalogUrl: string; popularity: number | null; trust: 'unreviewed_public_source'; compatible: 'requires_source_inspection';
  slug?: string; pathHint?: string; refHint: string;
}
export interface SkillMarketplaceSource {
  provider: SkillMarketplaceProvider; id: string; repository: string; commit: string; subdirectory: string;
  sourceUrl: string; catalogUrl: string; path: string; content: string; contentHash: string; bytes: number;
  resources: Array<{ path: string; bytes: number; gitBlob: string }>;
  unsupportedFiles: string[];
  licenseFiles: Array<{ path: string; resourcePath: string; bytes: number; gitBlob: string }>;
  licenseReview: 'required_before_redistribution'; trust: 'untrusted_reference_not_instructions'; installed: false; executesCode: false;
  installInput: { kind: 'skill'; source: { type: 'git'; repository: string; ref: string; subdirectory: string }; activate: false };
}
export interface SkillMarketplaceSearchCoverage { status: 'complete' | 'partial' | 'unsupported' | 'empty'; returnedCount: number; inspectedCount: number; supportedCount: number; unsupportedCount: number; duplicateCount: number; omittedCount: number; reasons: Array<{ code: string; count: number }> }
export class SkillMarketplaceError extends Error { constructor(code: string, message: string, status?: number); code: string; status: number }
export class SkillMarketplaceClient {
  constructor(options?: { fetchImpl?: typeof fetch; skillsmpApiKey?: () => string | undefined; timeoutMs?: number; acquisitionTimeoutMs?: number });
  fork(): SkillMarketplaceClient;
  catalog(): Array<{ id: SkillMarketplaceProvider; name: string; url: string; docsUrl: string; search: string; authentication: string; credentialEnv?: string; capabilities: string[]; plugins: false }>;
  search(input: { provider?: SkillMarketplaceProvider; query: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<{ provider: SkillMarketplaceProvider; query: string; results: SkillMarketplaceEntry[]; retrievedAt: string; rankingMeaning: 'discovery_only_not_quality_or_safety'; skippedUnsupported: number; coverage: SkillMarketplaceSearchCoverage }>;
  read(input: { provider: SkillMarketplaceProvider; id: string; path?: string }, options?: { signal?: AbortSignal }): Promise<SkillMarketplaceSource>;
  acquire(input: { provider: SkillMarketplaceProvider; id: string }, options?: { signal?: AbortSignal }): Promise<SkillMarketplaceBundle>;
}

export interface LearningEpisode { id: string; fingerprint: string; kind: string; summary: string; at: string; sourceIds?: string[] }
export interface LearningReflection {
  outcome: 'experiment' | 'defer' | 'no_change'; reason: string; evidenceIds: string[];
  diagnosis: string; hypothesis: string; intervention: string; validationPlan: string; limitations: string; nextReviewAfterMs: number;
}
export interface LearningRequestReceipt {
  id: string; reviewId: string; phase: 'learning_reflection'; estimatedTokens: number; requestStarted: boolean; maxOutputTokens?: number;
  usage?: Usage; usageReported?: boolean; estimatedWhenUnknown?: boolean; completed?: boolean; cancelledBeforeSend?: true;
  stopReason?: string | null; responseBytes?: number; responseSha256?: string;
  responseContract?: JsonOutputContract; timeoutPolicy?: CompletionTimeoutPolicy;
  reflectionContractHash?: string; validationDiagnostic?: LearningValidationDiagnostic;
  /** Ordered SHA-256 hashes of [canonical episode ID, fingerprint] for the full admitted batch; absent on legacy receipts. */
  evidenceBatchKeys?: string[];
  /** SHA-256 of ordered [request-local e1..eN reference, batch key] pairs, without original IDs or source text. */
  evidenceBindingHash?: string;
}
/** Value-free contract feedback; no model text, unknown property keys or evidence IDs. */
export interface LearningValidationDiagnostic {
  phase: 'parse' | 'schema' | 'evidence' | 'experiment'; path: string; rule: string;
  actualType?: 'missing' | 'undefined' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'bigint' | 'symbol' | 'function';
  length?: number; count?: number; limit?: number; unknownCount?: number; allowedCount?: number; missingCount?: number;
}
export interface LearningReflectionResult { decision: LearningReflection; usage?: Partial<Usage>; request?: LearningRequestReceipt }
export interface LearningExperimentResult { status: 'ready' | 'rejected' | 'failed' | 'interrupted' | 'stale' | 'no_change'; versionId?: string; summary: string; usage?: Partial<Usage> }
export interface LearningReview {
  id: string; status: 'reviewing' | 'deferred' | 'no_change' | 'queued_experiment' | 'executing' | 'completed' | 'failed' | 'interrupted';
  episodeKeys: string[]; sourceIds?: string[]; startedAt: number; completedAt?: number; executionStartedAt?: number;
  decision?: LearningReflection; result?: Partial<LearningExperimentResult>; usage?: Partial<Usage>; request?: LearningRequestReceipt;
  nextReviewAt?: number; nextAttemptAt?: number; deferredReason?: string; interruptedPhase?: 'reviewing' | 'executing';
  error?: { code: string; message: string; validationDiagnostic?: LearningValidationDiagnostic }; sourceRevoked?: boolean; revocationReason?: string; statusBeforeRevocation?: LearningReview['status']; reconciledAt?: number; resolution?: string;
  outputBudgetRecovery?: { at: number; previousMaxOutputTokens: number; maxOutputTokens: number; reason: 'configured_output_budget_increased' };
  contractRecovery?: { at: number; previousContractHash: string; contractHash: string; reason: 'reflection_contract_updated' };
}
export interface LearningState {
  schemaVersion: 1;
  episodes: Array<LearningEpisode & { key: string; status: 'pending' | 'deferred' | 'awaiting_evidence' | 'reviewing' | 'queued_experiment' | 'executing' | 'interrupted'; nextReviewAt: number; reviewId?: string; consecutiveFailures?: number; deferCount?: number }>;
  reviews: LearningReview[]; seen: Array<{ key: string; reviewId: string; outcome: string; at: number }>; nextReviewAt: number;
}
export interface LearningPolicy { enabled?: boolean; maxPending?: number; maxBatch?: number; maxReviews?: number; minReviewMs?: number; retryAfterMs?: number; experimentNotBefore?: number }
export const learningReflectionSchema: JsonSchema;
export const LEARNING_REFLECTION_METHOD: string;
export const LEARNING_REFLECTION_CONTRACT_HASH: string;
export function validateLearningReflection(value: unknown, episodes?: LearningEpisode[]): LearningReflection;
export function reflectProjectLearning(options: { project?: JsonObject; episodes: LearningEpisode[]; priorReviews?: LearningReview[]; model: ModelConfig; apiKey?: ProviderCredential; provider?: CompletionProvider; signal?: AbortSignal; reviewId?: string; requestControl?: { beforeRequest?: (request: LearningRequestReceipt & { signal?: AbortSignal }) => MaybePromise<void>; onUsage?: (receipt: LearningRequestReceipt) => MaybePromise<void> }; /** Legacy explicit absolute deadline; totalTimeoutMs takes precedence. */ timeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number; maxOutputTokens?: number }): Promise<LearningReflectionResult & { usage: Usage; request: LearningRequestReceipt }>;
export function revokeLearningSources(state: LearningState, sourceIds: string[], reason?: string): LearningState;
export class LearningCoordinator {
  constructor(options: { state?: LearningState; saveState?: (state: LearningState) => MaybePromise<void>; archiveReviews?: (reviews: LearningReview[]) => MaybePromise<void>; review: (input: { episodes: LearningEpisode[]; priorReviews: LearningReview[]; signal: AbortSignal; reviewId: string }) => MaybePromise<LearningReflectionResult>; execute: (input: { decision: LearningReflection; episodes: LearningEpisode[]; reviewId: string; signal: AbortSignal }) => MaybePromise<LearningExperimentResult | { deferred: true; nextAttemptAt: number; reason?: string }>; now?: () => number; policy?: LearningPolicy });
  snapshot(): LearningState;
  /** Whether any review currently has this status, without copying the state. */
  hasReviewStatus(status: LearningReview['status']): boolean;
  ingest(episodes: LearningEpisode[]): Promise<{ accepted: string[]; duplicate: string[]; deferred: Array<{ id: string; reason: 'backlog_full' | 'episode_revision_conflict' }> }>;
  updatePolicy(policy: Pick<LearningPolicy, 'enabled' | 'experimentNotBefore'>): void;
  tick(options?: { signal?: AbortSignal }): Promise<{ status: string; reviewId?: string; nextReviewAt?: number; decision?: LearningReflection; result?: Partial<LearningExperimentResult> }>;
  reconcile(reviewId: string, result: LearningExperimentResult | { status: 'retry_review' | 'retry_experiment'; verifiedNoExecution: true }): Promise<LearningReview>;
  retryTruncatedReflections(options: { maxOutputTokens: number; legacyMaxOutputTokens?: number }): Promise<{ reviewIds: string[] }>;
  retryInvalidReflections(options: { contractHash: string; legacyContractHash?: string }): Promise<{ reviewIds: string[] }>;
  invalidate(reason?: string): void;
  health(): { closed: boolean; inFlight: boolean; unsettledOperations: number; reviewId: string | null; pending: number; deferred: number; awaitingEvidence: number; queued: number; interrupted: number; retainedEpisodes: number; seen: number; nextReviewAt: number; experimentNotBefore: number; persistenceError?: string };
  close(): Promise<void>;
}

export interface ProjectEvaluationRevisionInput { schemaVersion: 1; sourceSuiteHash: string; reason: string; suite: ProjectGenomeSuite; suiteHash?: string; revisionHash?: string; adoption?: 'separate_review_required' }
export interface ProjectEvaluationRevision extends ProjectEvaluationRevisionInput { suiteHash: string; revisionHash: string; adoption: 'separate_review_required' }
export const projectEvaluationClockSchema: JsonSchema;
export function validateProjectEvaluationClock(value: unknown): ProjectEvaluationClock | undefined;
export function projectEvaluationClockInstructions(value?: ProjectEvaluationClock): string;
export function describeProjectEvaluationCase(testCase: Partial<ProjectGenomeCase> | undefined, result: JsonObject): JsonObject;
export function createProjectEvaluationRevision(baseline: ProjectGenome, input: ProjectEvaluationRevisionInput, candidate?: ProjectGenome): ProjectEvaluationRevision;
export function projectEvaluationRevisionDiff(before: ProjectGenomeSuite, after: ProjectGenomeSuite): Array<{path: string; before: JsonValue; after: JsonValue}>;

export * from './decision-kernel.js';
export * from './decision-state.js';
export * from './decision-templates.js';
export * from './project-rrsi.js';
export * from './decision-calibration.js';
export * from './project-evaluation-exposure.js';

export * from './subscription-auth.js';
export declare function solidPng(size?: number, rgb?: [number, number, number]): Uint8Array;
export declare function probeImageInput(options: { model: Record<string, unknown>; apiKey?: unknown; provider?: unknown; signal?: AbortSignal; purpose?: string }): Promise<{ input: Array<'text' | 'image'>; evidence: 'answered' | 'ignored_image' | 'rejected_image'; answer?: string; status?: number } | null>;
export declare const MEDIA_KINDS: readonly ['image', 'speech', 'transcription', 'video'];
export declare const IMAGE_EDIT_APIS: readonly ['openai', 'generations'];
export declare const VIDEO_APIS: readonly ['openai', 'zhipu', 'ark', 'siliconflow', 'dashscope'];
export declare const MAX_MEDIA_BYTES: number;
export interface MediaBytes { bytes: Uint8Array; mimeType: string }
export declare class MediaModelError extends Error { code: string; details: Record<string, unknown> }
interface MediaEndpoint { baseUrl: string; apiKey?: string; model: string; fetchImpl?: typeof fetch; signal?: AbortSignal }
export declare function extensionOf(mimeType: string): string;
export declare function generateImage(options: MediaEndpoint & { prompt: string; size?: string; count?: number; images?: MediaBytes[]; editApi?: 'openai' | 'generations' }): Promise<Array<MediaBytes & { revisedPrompt?: string }>>;
/** Media kinds a ChatGPT login (Codex) serves, with the model ids each accepts. */
export declare const SUBSCRIPTION_MEDIA: Readonly<{ image: readonly string[]; transcription: readonly string[] }>;
export declare const SUBSCRIPTION_IMAGE_REFERENCES: number;
type SubscriptionCredentialResolver = (options?: { signal?: AbortSignal; forceRefresh?: boolean }) => Promise<unknown>;
export declare function generateSubscriptionImage(options: { credential: SubscriptionCredentialResolver; model?: string; prompt: string; size?: string; images?: MediaBytes[]; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<MediaBytes & { revisedPrompt?: string }>;
export declare function transcribeSubscriptionAudio(options: { credential: SubscriptionCredentialResolver; audio: MediaBytes; filename?: string; language?: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<{ text: string }>;
/** The Codex client version presented to the ChatGPT backend (it gates the model catalog by it). */
export declare const CODEX_CLIENT_VERSION_FLOOR: string;
export declare function codexClientVersion(): string;
export declare function laterVersion(a: string | undefined, b: string | undefined): string;
export declare function refreshCodexClientVersion(options?: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): Promise<string>;
export declare function resetCodexClientVersion(): void;
export declare function synthesizeSpeech(options: MediaEndpoint & { input: string; voice?: string; format?: string; instructions?: string }): Promise<MediaBytes>;
export declare function transcribeAudio(options: MediaEndpoint & { audio: MediaBytes; filename?: string; language?: string; prompt?: string }): Promise<{ text: string; language?: string; duration?: number }>;
export declare function generateVideo(options: MediaEndpoint & { api?: 'openai' | 'zhipu' | 'ark' | 'siliconflow' | 'dashscope'; prompt: string; image?: MediaBytes; seconds?: number; size?: string; pollMs?: number; timeoutMs?: number; onProgress?: (event: { status: string; taskId: string; progress?: number }) => void }): Promise<MediaBytes & { taskId: string }>;

export * from './project-events.js';

export type UsagePurpose = 'foreground' | 'initiative' | 'background-work' | 'learning' | 'evaluation' | 'compaction' | 'summary' | 'initialization' | 'jev' | 'jev-llm' | 'skill-foundation' | 'subagent' | 'vision' | 'narrator' | 'mind' | 'evolution' | 'other';
export declare const USAGE_PURPOSES: readonly UsagePurpose[];
/** mind-* and session-suggestions → 'mind'; gene-* → 'evolution'; other unknown values → 'other'. */
export declare function normalizePurpose(value: unknown): UsagePurpose;
/** The raw purpose when it differs from its normalized contract purpose and is a short slug; else undefined. */
export declare function purposeDetail(value: unknown): string | undefined;
export declare const CORE_TOOL_NAMES: readonly string[];
export declare const HOST_INSTRUCTION_SOURCES: readonly string[];
export declare const HOST_INSTRUCTION_LABEL: string;
export declare function authorizationRejection(code: 'authorization_read_only' | 'authorization_scope' | 'tool_unavailable_for_purpose' | 'permission_revoked', input?: { tool?: { name: string; permission?: string; effect?: string }; purpose?: string; level?: string; readOnly?: boolean }): { isError: true; content: Array<{ type: 'text'; text: string }>; details: { code: string; executed: false; tool?: string; purpose?: string; authorization?: string; readOnly?: boolean; writes: boolean } };
export declare const NOT_DECLARED_RULE: string;
export declare function authorizationContext(input: { purpose?: string; level?: string | null; readOnly?: boolean; executable?: string[]; unavailable?: string[]; notDeclared?: string[]; unreachable?: string[] }): { key: 'authorization'; source: 'host-authorization'; text: string };
export declare function purposeContext(text: string): { key: 'purpose-instructions'; source: 'host-purpose-instructions'; text: string };

/** Reasoning levels of one model by its capability (reasoning-effort.mjs; spec p1 effort §3.5). */
export declare function rankEffort(capability: ReasoningCapability | undefined, value: Reasoning): number | null;
/** The effort a request runs at: 'default' resolved to the provider default, else the deepest level ('off' for budget thinking). */
export declare function effectiveEffort(model: { reasoning?: Reasoning; reasoningCapability?: ReasoningCapability }): Reasoning;
/** One level lighter than the model's current reasoning, or undefined when nothing is lighter. */
export declare function stepDownReasoning(model: { reasoning?: Reasoning; reasoningCapability?: ReasoningCapability }): Reasoning | undefined;
/** The lightest reasoning a model can run at (off when it can disable thinking). */
export declare function lightestReasoning(capability?: ReasoningCapability): Reasoning;
/** The effort plan of one internal call (spec p1 effort §2/§3.1): fixed, or a route a judge may pick within `allowed` (never above the chat's level); `fallback` is today's wire value. */
export type InternalReasoningPlan =
  | { mode: 'fixed'; effort: Reasoning; source: 'setting' | 'project' | 'chat-off' | 'no-levels' | 'chat-ceiling' | 'provider-default' }
  | { mode: 'route'; allowed: Reasoning[]; preferred?: Reasoning; fallback: Reasoning; ceiling: Reasoning };
export declare function internalReasoningPlan(model: SummaryReasoningModel | null | undefined, options?: { setting?: 'auto' | 'chat'; projectSelection?: { reasoning?: string } | null }): InternalReasoningPlan;
