export interface SubscriptionCredential { provider: 'openai-codex'; accessToken: string; refreshToken: string; expiresAt: number; accountId: string }
export interface CredentialResolveOptions { signal?: AbortSignal; forceRefresh?: boolean }
export type CredentialResolver = (options: CredentialResolveOptions) => string | SubscriptionCredential | Promise<string | SubscriptionCredential>;
export type ProviderCredential = string | CredentialResolver;
export interface SubscriptionAuthFlow { flowId: string; provider: string; method: 'browser' | 'device_code'; status: 'pending' | 'complete' | 'error' | 'expired' | 'cancelled'; expiresAt: number; url?: string; callback?: string; manualCallback?: boolean; userCode?: string; verificationUri?: string; intervalSeconds?: number; accountId?: string; error?: string; errorCode?: string }
export class SubscriptionAuthError extends Error { constructor(message: string, code?: string, status?: number); code: string; status?: number }
export const SUBSCRIPTION_PROVIDERS: ReadonlyArray<Readonly<{ id: string; name: string; methods: string[]; protocol?: string; baseUrl?: string; documentation: string; compatibility?: string; interactiveOnly?: boolean; subscriptionStatus?: string }>>;
export class SubscriptionAuthManager {
  constructor(options: { readCredential(provider: string): SubscriptionCredential | null | undefined | Promise<SubscriptionCredential | null | undefined>; writeCredential(provider: string, credential: SubscriptionCredential | null, metadata: { operation: 'login' | 'refresh' | 'logout' | 'invalidated' | 'rollback' }): void | Promise<void>; fetch?: typeof fetch; now?: () => number; onChange?(flow: SubscriptionAuthFlow): void });
  begin(provider: string, options?: { method?: 'browser' | 'device_code'; signal?: AbortSignal }): Promise<SubscriptionAuthFlow>;
  flow(id: string): SubscriptionAuthFlow | null;
  complete(id: string, options: { callbackUrl: string }): Promise<SubscriptionAuthFlow>;
  cancel(id: string): SubscriptionAuthFlow | null;
  logout(provider: string): Promise<void>;
  credential(provider: string, options?: CredentialResolveOptions): Promise<SubscriptionCredential>;
  close(): void;
}
export function createSubscriptionCompletion(options: { resolveCredential(provider: string, options: CredentialResolveOptions): SubscriptionCredential | Promise<SubscriptionCredential> }): import('./index.js').CompletionProvider;
