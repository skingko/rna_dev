import { createSession, resolveJsonOutputContract, MAX_STEP_LIMIT_INSTRUCTIONS_BYTES, type SessionOptions, type CompletionRequest } from '@rna-agent/sdk';
declare const options: SessionOptions;
const bound: 32768 = MAX_STEP_LIMIT_INSTRUCTIONS_BYTES;
const session = await createSession({ ...options, stepLimitBehavior: 'summarize', stepLimitInstructions: 'Return the complete proposal JSON; all changes are unverified until evaluated.', stepLimitResponseFormat: 'json_object' });
const contract = resolveJsonOutputContract({ ...options.model, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } });
const request: CompletionRequest = { model: options.model, messages: [], ...contract.requestOptions };
// @ts-expect-error json_schema is not the verified Chat Completions JSON object contract.
const invalidFormat: CompletionRequest['responseFormat'] = { type: 'json_schema' };
// @ts-expect-error Forced tools are not part of the no-tool structured-output contract.
const invalidChoice: CompletionRequest['toolChoice'] = 'required';
// @ts-expect-error The host contract is bounded text; a schema object is not implicitly serialized.
const invalidSchema: SessionOptions['stepLimitInstructions'] = { type: 'object' };
// @ts-expect-error Callbacks cannot mutate the final-response task during execution.
const invalidCallback: SessionOptions['stepLimitInstructions'] = () => 'Return JSON.';
bound; invalidSchema; invalidCallback; request; invalidFormat; invalidChoice;
await session.dispose();
import type { CompletedFinalResponseDiagnostic } from '@rna-agent/sdk';
const terminalDiagnostic: CompletedFinalResponseDiagnostic = { purpose: 'step-limit-summary', requestId: 'request', messageId: 'message', completed: true, toolCallCount: 0, outputBytes: 0, stopReason: 'stop', kind: 'empty_response' };
// @ts-expect-error a terminal diagnostic cannot assert an unobserved completion
const incompleteDiagnostic: CompletedFinalResponseDiagnostic = { ...terminalDiagnostic, completed: false };
// @ts-expect-error truncation evidence requires the reported length stop reason
const inconsistentDiagnostic: CompletedFinalResponseDiagnostic = { ...terminalDiagnostic, kind: 'output_truncated' };
console.log(terminalDiagnostic, incompleteDiagnostic, inconsistentDiagnostic);
import { ProviderError, SessionError, type ProviderEvent, type Message } from '@rna-agent/sdk';
const wireError = new ProviderError('Abnormal termination', { code: 'provider_termination', providerFinishReason: 'content_filter' });
const wireReason: string | null | undefined = wireError.providerFinishReason;
const wireDone: ProviderEvent = { type: 'done', stopReason: 'stop', providerFinishReason: 'end_turn' };
const journalMessage: Message = { role: 'assistant', content: [], stopReason: 'error', providerFinishReason: null };
const sessionFailure = new SessionError('Request failed', 'provider_termination'); sessionFailure.providerFinishReason = 'refusal';
// @ts-expect-error termination diagnostics never contain provider error objects or response bodies
const unsafeReason: ProviderEvent = { type: 'done', stopReason: 'stop', providerFinishReason: { private: true } };
console.log(wireReason, wireDone, journalMessage, sessionFailure, unsafeReason);
import type { BootstrapEvent, AuthorSubmissionAudit } from '@rna-agent/sdk';
const submissionAudit: AuthorSubmissionAudit = { requestId: 'current', contextDigest: 'digest', sourceRequestId: 'native', schemaHash: 'hash', contractHash: 'contract', toolName: 'submit_project_artifact', reasoning: 'high' };
const captureEvent: BootstrapEvent = { type: 'bootstrap_submission_captured', attempt: 2, captureScope: 'operation_memory', durable: false, ...submissionAudit, callId: 'call', argumentHash: 'hash', argumentBytes: 42, textBytes: 0, stopReason: 'toolUse', providerFinishReason: 'tool_calls' };
console.log(captureEvent);

import type { CompletedSubmissionArgumentDiagnostic } from '@rna-agent/sdk';
const syntaxDiagnostic: CompletedSubmissionArgumentDiagnostic = { requestId: 'submission', schemaHash: 'schema', contextDigest: 'context', contractHash: 'contract', kind: 'completed_submission_arguments_invalid_json', transportCompleted: true, completionMarker: 'openai_done', assembledToolCount: 1, callId: 'call', toolName: 'submit_project_artifact', providerFinishReason: 'tool_calls', argumentBytes: 23, argumentHash: 'hash' };
const syntaxEvent: BootstrapEvent = { type: 'bootstrap_submission_failed', attempt: 2, ...submissionAudit, code: 'invalid_output', complete: false, callCount: 0, textBytes: 0, argumentDiagnostic: syntaxDiagnostic };
// @ts-expect-error raw arguments are deliberately absent from public diagnostics
syntaxDiagnostic.rawArguments = 'private body';
// @ts-expect-error an EOF without the explicit terminal marker cannot claim this proof
const eofDiagnostic: CompletedSubmissionArgumentDiagnostic = { ...syntaxDiagnostic, completionMarker: 'eof' };
console.log(syntaxEvent, eofDiagnostic);

import type { ContextUsage, SessionEvent } from '@rna-agent/sdk';
const currentContext: ContextUsage = session.snapshot().contextUsage;
const contextEvent: SessionEvent = { type: 'context_usage', usage: currentContext, sessionId: 'session', seq: 1, time: new Date().toISOString() };
const cacheReported: boolean | undefined = journalMessage.usage?.cacheUsageReported;
// @ts-expect-error context telemetry distinguishes an active compaction from a ready projection
const invalidContext: ContextUsage = { ...currentContext, status: 'full' };
console.log(contextEvent, cacheReported, invalidContext);

const researchStage: BootstrapEvent = { type: 'bootstrap_authoring_stage', attempt: 1, stage: 'research', reason: 'started', nextRequestIndex: 1, researchCompleted: false, systemPromptBytes: 3000, artifactContractBytes: 0 };
const firstTool: BootstrapEvent = { type: 'bootstrap_first_reference_tool', attempt: 1, requestId: 'request', requestIndex: 1, toolName: 'marketplace_plan', elapsedMs: 50 };
// @ts-expect-error Stage telemetry has no provider reasoning or private tool arguments.
firstTool.arguments = { private: true };
// @ts-expect-error A stage event does not certify project quality or installation.
researchStage.qualityPassed = true;
console.log(researchStage, firstTool);

import type { ProjectReferencePolicy, ReferenceResearchReceipt } from '@rna-agent/sdk';
const hostFinal: SessionOptions['beforeRequest'] = () => ({ finalResponse: true });
// @ts-expect-error false cannot switch off an already configured final projection
const invalidHostFinal: SessionOptions['beforeRequest'] = () => ({ finalResponse: false });
const sourceReadiness: ProjectReferencePolicy = { researchReadiness: async ({ boundary, signal, snapshot }) => { signal.throwIfAborted(); return snapshot.messages.length && boundary === 'artifact' ? { ready: true } : { ready: false, pendingCapabilityIds: ['design'], feedback: 'Inspect the remaining source.', allowOneCorrection: true }; } };
const sourceReceipt: ReferenceResearchReceipt = { schemaVersion: 1, ready: false, researchRequests: 5, correctionGranted: false, pendingCapabilityIds: ['design'] };
// @ts-expect-error host readiness must explicitly declare whether it permits the single correction
const invalidReadiness: ProjectReferencePolicy = { researchReadiness: () => ({ ready: false, pendingCapabilityIds: [], feedback: 'Pending' }) };
console.log(hostFinal, invalidHostFinal, sourceReadiness, sourceReceipt, invalidReadiness);
