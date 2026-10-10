// Compile-only public-package consumer. No credentials, network calls, or CLI
// processes are used by the typecheck command.
import {
  SubscriptionAuthManager, SubscriptionAuthError, SUBSCRIPTION_PROVIDERS,
  createSubscriptionCompletion, createSession, bootstrapProject, decideInitiative,
  InitiativeCoordinator, EvolutionCoordinator, proposeEvolution,
  proposeProjectGenome, evaluateProjectGenomes, executeProjectEvaluationCase,
  reflectProjectLearning, createDecisionKernel,
  type SubscriptionCredential, type SubscriptionAuthFlow,
  type CredentialResolver, type CredentialResolveOptions, type ProviderCredential,
  type ModelConfig, type CompletionProvider, type CompletionRequest,
  type SessionOptions, type BootstrapOptions, type InitiativeDecisionOptions,
  type EvolutionOptions, type ProjectGenomeEvolutionOptions,
  type DecisionLedgerRecord,
} from '@rna-agent/sdk';
import {
  streamCompletion, iterateCompletion, buildRequest,
  type CredentialResolver as TransportResolver,
  type ProviderCredential as TransportCredential,
  type SubscriptionCredential as TransportSubscription,
} from '@rna-agent/sdk/providers';

const vault = new Map<string, SubscriptionCredential>();
const flows: SubscriptionAuthFlow[] = [];
const manager = new SubscriptionAuthManager({
  async readCredential(provider) { return vault.get(provider); },
  async writeCredential(provider, credential, metadata) {
    const operation: 'login' | 'refresh' | 'logout' | 'invalidated' | 'rollback' = metadata.operation;
    if (credential) vault.set(provider, credential); else vault.delete(provider);
    void operation;
  },
  onChange(flow) { flows.push(flow); },
  fetch,
  now: Date.now,
});

const resolver: CredentialResolver = ({ signal, forceRefresh }: CredentialResolveOptions) =>
  manager.credential('openai-codex', { signal, forceRefresh });
const transportResolver: TransportResolver = resolver;
const apiKey: ProviderCredential & TransportCredential = transportResolver;
declare const credential: SubscriptionCredential & TransportSubscription;
declare const model: ModelConfig;
const codexModel: ModelConfig = {
  ...model, providerId: 'account-1', modelId: 'configured-subscription-model',
  protocol: 'openai-codex', subscriptionProvider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
};
const request: CompletionRequest = { model: codexModel, apiKey, messages: [] };
const provider: CompletionProvider = createSubscriptionCompletion({
  resolveCredential(provider, options) { return manager.credential(provider, options); },
});
const stream = iterateCompletion(provider, request);
const direct = streamCompletion({ model: codexModel, subscriptionCredential: credential, messages: [] });
const built = buildRequest({ model: codexModel, messages: [] });
const protocol: ModelConfig['protocol'] = built.protocol;

// A fresh resolver must reach every model-calling public SDK entry point.
const sessionAuth: Pick<SessionOptions, 'apiKey'> = { apiKey };
const bootstrapAuth: Pick<BootstrapOptions, 'apiKey'> = { apiKey };
const initiativeAuth: Pick<InitiativeDecisionOptions, 'apiKey'> = { apiKey };
const coordinatorAuth: Pick<NonNullable<ConstructorParameters<typeof InitiativeCoordinator>[0]>, 'apiKey'> = { apiKey };
const evolutionAuth: Pick<EvolutionOptions, 'apiKey'> = { apiKey };
const genomeAuth: Pick<ProjectGenomeEvolutionOptions, 'apiKey'> = { apiKey };
const learningAuth: Pick<Parameters<typeof reflectProjectLearning>[0], 'apiKey'> = { apiKey };
const allModelEntrypoints: Array<{ apiKey?: ProviderCredential }> = [
  sessionAuth, bootstrapAuth, initiativeAuth, coordinatorAuth, evolutionAuth, genomeAuth, learningAuth,
  {} as Pick<Parameters<typeof createSession>[0], 'apiKey'>,
  {} as Pick<Parameters<typeof bootstrapProject>[0], 'apiKey'>,
  {} as Pick<NonNullable<Parameters<typeof decideInitiative>[0]>, 'apiKey'>,
  {} as Pick<NonNullable<ConstructorParameters<typeof EvolutionCoordinator>[0]>, 'apiKey'>,
  {} as Pick<Parameters<typeof proposeEvolution>[0], 'apiKey'>,
  {} as Pick<Parameters<typeof proposeProjectGenome>[0], 'apiKey'>,
  {} as Pick<Parameters<typeof evaluateProjectGenomes>[0], 'apiKey'>,
  {} as Pick<Parameters<typeof executeProjectEvaluationCase>[0], 'apiKey'>,
];

async function consumeAuthFlow(signal: AbortSignal) {
  const browser = await manager.begin('openai-codex', { method: 'browser', signal });
  const device = await manager.begin('openai-codex', { method: 'device_code', signal });
  const callback: string | undefined = browser.callback;
  const userCode: string | undefined = device.userCode;
  const completed: SubscriptionAuthFlow = await manager.complete(browser.flowId, { callbackUrl: 'http://localhost:1455/auth/callback?code=fixture&state=fixture' });
  const pending: SubscriptionAuthFlow | null = manager.flow(device.flowId);
  manager.cancel(device.flowId);
  await manager.credential('openai-codex', { forceRefresh: true, signal });
  await manager.logout('openai-codex');
  manager.close();
  return { callback, userCode, completed, pending };
}

function consumeAuthError() {
  const authError = new SubscriptionAuthError('Refresh required', 'reauth_required', 401);
  return { authError };
}

const ledger: DecisionLedgerRecord[] = [];
const decisionKernel = createDecisionKernel({ apiKey: async () => undefined, mode: 'shadow', ledger(record) { ledger.push(record); } });
const decision = decisionKernel.decide({ point: 'evolution.review', scope: { projectId: 'project-1' }, state: { pending: { learning: true } }, fallback: { review: true } });

// @ts-expect-error Private subscription objects are resolved per request, not API-key strings.
const invalidCredential: ProviderCredential = credential;
// @ts-expect-error Raw third-party Claude OAuth tokens are not supported credentials.
const unsupported: SubscriptionCredential = { ...credential, provider: 'anthropic' };
// @ts-expect-error Auth supports only grounded browser/device-code methods.
manager.begin('openai-codex', { method: 'password' });
// @ts-expect-error Subscription credentials must include the ChatGPT account identity.
const missingAccount: SubscriptionCredential = { provider: 'openai-codex', accessToken: '', refreshToken: '', expiresAt: 0 };

void [SUBSCRIPTION_PROVIDERS, stream, direct, protocol, allModelEntrypoints, consumeAuthFlow, consumeAuthError, decision, invalidCredential, unsupported, missingAccount];
