import { ProviderError, SessionError, type Message, type SessionEvent, type ProviderDiagnostic } from '@rna-agent/sdk';
import { type ProviderDiagnostic as ProviderSurfaceDiagnostic, type ProviderEvent } from '@rna-agent/sdk/providers';
const error = new ProviderError('safe', { status: 429, providerCode: '1311', category: 'model_access_denied', retryable: false });
const diagnostic: ProviderSurfaceDiagnostic | undefined = error.errorDiagnostic;
declare const sessionError: SessionError;
declare const message: Message;
declare const event: SessionEvent;
declare const providerEvent: ProviderEvent;
const fromError: ProviderDiagnostic | undefined = sessionError.errorDiagnostic;
const fromMessage: ProviderDiagnostic | undefined = message.errorDiagnostic;
if (event.type === 'compaction_request_end') { const compaction: ProviderDiagnostic | undefined = event.errorDiagnostic; console.log(compaction); }
if (providerEvent.type === 'retry') { const retry: ProviderDiagnostic | undefined = providerEvent.errorDiagnostic; console.log(retry); }
// @ts-expect-error raw provider bodies are intentionally absent
diagnostic?.body;
// @ts-expect-error categories must be the closed public set
new ProviderError('invalid', { category: 'raw_server_message' });
console.log(diagnostic, fromError, fromMessage);
