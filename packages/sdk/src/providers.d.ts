export { streamCompletion, iterateCompletion, buildRequest, normalizeUsage, resolveJsonOutputContract, resolveCompletionTimeoutPolicy, ProviderError, cacheKeepAlive } from './index.js';
export type { CompletionRequest, CompletionProvider, ProviderEvent, ProviderDiagnostic, ModelConfig, Usage, CachePolicy, CompletionTimeoutPolicy, ProviderCredential, CredentialResolver, CredentialResolveOptions, SubscriptionCredential } from './index.js';
/** Wire reasoning values accepted by buildRequest; 'default' omits the effort field. */
export declare const REASONING_VALUES: ReadonlySet<import('./index.js').Reasoning>;
export function validateEndpoint(value: string): URL;
export function parseSSE(body: ReadableStream<Uint8Array>, options?: { maxBytes?: number; signal?: AbortSignal; onActivity?: () => void }): AsyncGenerator<{ event: string; data: string }, void, unknown>;
