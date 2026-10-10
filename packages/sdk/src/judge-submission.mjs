import { randomUUID } from 'node:crypto';
import { digest } from './journal.mjs';
import { validateToolArguments } from './capabilities.mjs';
import { iterateCompletion, resolveJsonOutputContract, ProviderError } from './providers.mjs';
import { validateMessageImages } from './images.mjs';

// Internal output envelope only. There is no execute callback, tool result,
// acknowledgement request, repair loop or authority to perform an operation.
export const JUDGE_SUBMISSION_TOOL = 'submit_evaluation_ratings';
export class JudgeSubmissionError extends Error {
  constructor(message, code = 'invalid_output') { super(message); this.name = 'JudgeSubmissionError'; this.code = code; }
}
const normalizedReason = value => value === undefined ? undefined : new ProviderError('', { providerFinishReason: value }).providerFinishReason;
export function judgeOutputContract(model, toolProtocolEvidence = []) {
  const json = resolveJsonOutputContract(model);
  const verified = ['openai', 'anthropic', 'openai-codex'].includes(model.protocol) ? toolProtocolEvidence.filter(row => row && ['baseline', 'candidate'].includes(row.side) && typeof row.callId === 'string' && row.callId && typeof row.toolName === 'string' && row.toolName) : [];
  const mode = json.mode === 'native' ? 'native_json' : verified.length ? 'native_tool' : 'text';
  return { schemaVersion: 1, mode, reason: mode === 'native_json' ? json.reason : mode === 'native_tool' ? 'completed_paired_native_tool_receipts' : 'native_tool_support_unverified',
    evidenceCount: verified.length, evidenceHash: verified.length ? digest(verified) : null, json,
    requestOptions: mode === 'native_tool' ? {} : structuredClone(json.requestOptions) };
}

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
/** Deterministic, content-preserving repair of two observed judge envelope
 * slips (production 2026-09-26): a criterion split into a left-only and a
 * right-only row, and criterionId sent under an alias key. No score, reason or
 * criterion is invented; anything else still fails the frozen schema. */
export function normalizeJudgeRatings(value, schema) {
  const repairs = [];
  if (!plain(value) || !Array.isArray(value.ratings)) return { value, repairs };
  const allowed = new Set(schema?.properties?.ratings?.items?.properties?.criterionId?.enum ?? []);
  let rows = value.ratings.map(row => {
    if (!plain(row) || typeof row.criterionId === 'string') return row;
    const aliases = ['criterion_id', 'criterion', 'id'].filter(key => typeof row[key] === 'string');
    if (aliases.length !== 1 || allowed.size && !allowed.has(row[aliases[0]])) return row;
    const { [aliases[0]]: criterionId, ...rest } = row; repairs.push('criterion_id_alias'); return { criterionId, ...rest };
  });
  const groups = new Map(); for (const row of rows) if (plain(row) && typeof row.criterionId === 'string') groups.set(row.criterionId, [...(groups.get(row.criterionId) ?? []), row]);
  const merged = new Map();
  for (const [id, group] of groups) {
    if (group.length !== 2) continue;
    const leftOnly = group.find(row => typeof row.left === 'number' && row.right === undefined), rightOnly = group.find(row => typeof row.right === 'number' && row.left === undefined);
    if (!leftOnly || !rightOnly || leftOnly === rightOnly || Object.keys(leftOnly).some(key => !['criterionId', 'left', 'reason'].includes(key)) || Object.keys(rightOnly).some(key => !['criterionId', 'right', 'reason'].includes(key))) continue;
    const reason = [leftOnly.reason, rightOnly.reason].filter(text => typeof text === 'string' && text.trim()).join(' / ').slice(0, 2000);
    merged.set(id, { criterionId: id, left: leftOnly.left, right: rightOnly.right, reason: reason || 'split rating rows merged' });
  }
  if (merged.size) { repairs.push('merged_split_rows'); const seen = new Set(); rows = rows.flatMap(row => plain(row) && merged.has(row.criterionId) ? seen.has(row.criterionId) ? [] : (seen.add(row.criterionId), [merged.get(row.criterionId)]) : [row]); }
  return { value: repairs.length ? { ...value, ratings: rows } : value, repairs: [...new Set(repairs)] };
}

/** A judge receives one request and one chance to deliver a complete rating.
 * Consume the provider AND its metering finally before accepting staged output.
 * Native JSON remains preferred. Tools are used only when this same paired
 * execution has already demonstrated the configured model's native protocol. */
export async function collectJudgeOutput({ model, apiKey, provider, signal, systemPrompt, input, schema, evidenceContent = [], toolProtocolEvidence = [], onProgress = () => {} }) {
  signal?.throwIfAborted();
  const frozenSchema = structuredClone(schema), contract = judgeOutputContract(model, toolProtocolEvidence), requestId = randomUUID();
  const metadata = { requestId, mode: contract.mode, reason: contract.reason, schemaHash: digest(frozenSchema), evidenceCount: contract.evidenceCount, evidenceHash: contract.evidenceHash };
  const tool = { name: JUDGE_SUBMISSION_TOOL, description: 'Submit exactly one complete set of blind ratings. For each frozen criterion, submit exactly one object containing criterionId, left, right and reason together. Both scores must be present in that same object, even when equal; never split a criterion into separate left-only and right-only rows. The reason compares both sides. Envelope shape: {"ratings":[{"criterionId":"exact frozen ID","left":0.5,"right":0.5,"reason":"comparison of both sides"}]}; the example scores are illustrative, never prescribed ratings. This records arguments only; it cannot execute tools, modify files, change criteria, publish a version or perform another evaluation.', parameters: frozenSchema };
  const instructions = contract.mode === 'native_tool'
    ? `Submit exactly one native ${JUDGE_SUBMISSION_TOOL} tool call with the complete ratings matching its schema. Do not emit ratings as prose or JSON text, call another tool, or omit any criterionId. The submission is unverified until the host validates it; no tool execution or follow-up request occurs.\nOutput schema: ${JSON.stringify(frozenSchema)}`
    : `Return exactly one JSON object matching: ${JSON.stringify(frozenSchema)}`;
  if (contract.mode !== 'native_tool') onProgress({ type: 'structured_output_contract', phase: 'blind-judge', contract: structuredClone(contract.json) });
  onProgress({ type: 'judge_output_contract', phase: 'blind-judge', ...metadata });
  let output = '', outputBytes = 0, textBytes = 0, stopReason, providerFinishReason, doneCount = 0, sawAfterDone = false;
  const calls = [];
  const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }, ...structuredClone(evidenceContent)] }];
  validateMessageImages(messages, model);
  try {
    for await (const event of iterateCompletion(provider, { model: structuredClone(model), apiKey, signal, judgeOutput: structuredClone(metadata), systemPrompt: `${systemPrompt}\n${instructions}`, messages, tools: contract.mode === 'native_tool' ? [structuredClone(tool)] : [], ...contract.requestOptions, cache: { sessionKey: `project-evolution:blind-judge:${requestId}`, prefixHash: 'rna-project-evolution-blind-judge-v3' } })) {
      signal?.throwIfAborted();
      if (doneCount && ['text_delta', 'tool_call', 'done'].includes(event.type)) sawAfterDone = true;
      if (event.type === 'text_delta') { output += String(event.delta ?? ''); const bytes = Buffer.byteLength(String(event.delta ?? '')); textBytes += bytes; outputBytes += bytes; }
      if (event.type === 'tool_call') { calls.push(structuredClone(event)); outputBytes += Buffer.byteLength(JSON.stringify(event.arguments) ?? ''); }
      if (outputBytes > 400000 || calls.length > 8) throw new JudgeSubmissionError('Judge output exceeded its bounded envelope', 'output_limit');
      if (event.type === 'error') throw new JudgeSubmissionError('Judge provider failed', 'provider_error');
      if (event.type === 'done') { doneCount++; stopReason = event.stopReason; providerFinishReason = normalizedReason(event.providerFinishReason); }
    }
    signal?.throwIfAborted();
    if (doneCount !== 1 || sawAfterDone) throw new JudgeSubmissionError('Judge response did not have exactly one final completion', 'provider_incomplete');
    if (contract.mode === 'native_tool') {
      const rawExpected = model.protocol === 'anthropic' ? 'tool_use' : model.protocol === 'openai-codex' ? 'completed' : 'tool_calls';
      if (stopReason !== 'toolUse' || providerFinishReason !== undefined && providerFinishReason !== rawExpected) throw new JudgeSubmissionError('Judge submission did not finish with a normal native tool call', 'provider_incomplete');
      if (calls.length !== 1 || calls[0].name !== JUDGE_SUBMISSION_TOOL || typeof calls[0].id !== 'string' || !calls[0].id || calls[0].id.length > 256) throw new JudgeSubmissionError('Judge must submit exactly one matching native call');
      // Native arguments are the sole rating source. Accompanying narration
      // is counted, never parsed as ratings or treated as an instruction.
      output = JSON.stringify(calls[0].arguments) ?? '';
    } else {
      const rawExpected = model.protocol === 'anthropic' ? ['end_turn', 'stop_sequence'] : model.protocol === 'openai-codex' ? ['completed'] : ['stop'];
      if (stopReason !== 'stop' || providerFinishReason !== undefined && !rawExpected.includes(providerFinishReason)) throw new JudgeSubmissionError('Judge JSON did not finish normally', 'provider_incomplete');
      if (calls.length) throw new JudgeSubmissionError('Judge JSON contract cannot accept tool calls');
    }
    let value, repairs = [];
    try {
      value = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1'));
      try { validateToolArguments(frozenSchema, value); }
      catch (error) { const normalized = normalizeJudgeRatings(value, frozenSchema); if (!normalized.repairs.length) throw error; validateToolArguments(frozenSchema, normalized.value); value = normalized.value; repairs = normalized.repairs; output = JSON.stringify(value); }
    }
    catch { throw Object.assign(new JudgeSubmissionError('Judge output does not match the frozen ratings schema'), { draft: typeof output === 'string' ? output.slice(0, 400000) : '' }); }
    const receipt = { ...metadata, captureScope: 'operation_memory', durable: false, evaluationAccepted: false, outputHash: digest(value), outputBytes: Buffer.byteLength(output), ignoredTextBytes: contract.mode === 'native_tool' ? textBytes : 0, ...(repairs.length ? { envelopeRepairs: repairs } : {}), ...(contract.mode === 'native_tool' ? { callId: calls[0].id } : {}), stopReason, ...(providerFinishReason !== undefined ? { providerFinishReason } : {}) };
    onProgress({ type: 'judge_output_captured', phase: 'blind-judge', ...receipt });
    return { output, stopReason: 'stop', ...(providerFinishReason !== undefined ? { providerFinishReason } : {}), receipt };
  } catch (failure) {
    if (!(failure instanceof Error)) failure = new JudgeSubmissionError('Judge provider failed', 'provider_error');
    // Providers/accounting hooks may throw immutable Error objects. Retain
    // their prototype and diagnostics without masking them with an assignment
    // TypeError when adding this operation's bounded evidence.
    if (!Object.isExtensible(failure) || ['providerFinishReason', 'evolutionDiagnostic'].some(key => { const descriptor = Object.getOwnPropertyDescriptor(failure, key); return descriptor && (!('value' in descriptor) || !descriptor.writable); })) {
      const descriptors = Object.getOwnPropertyDescriptors(failure);
      for (const key of ['providerFinishReason', 'evolutionDiagnostic']) if (descriptors[key]) descriptors[key] = { value: failure[key], writable: true, enumerable: true, configurable: true };
      failure = Object.create(Object.getPrototypeOf(failure), descriptors);
    }
    const rawReason = normalizedReason(failure.providerFinishReason === undefined ? providerFinishReason : failure.providerFinishReason);
    if (rawReason !== undefined) failure.providerFinishReason = rawReason;
    failure.evolutionDiagnostic ??= { phase: 'judge', kind: failure.code === 'invalid_output' ? 'invalid_json' : failure.code ?? 'provider_error', stopReason: stopReason ?? null, ...(rawReason !== undefined ? { providerFinishReason: rawReason } : {}), outputContract: metadata, completionCount: doneCount, callCount: calls.length, textBytes, afterCompletionOutput: sawAfterDone };
    onProgress({ type: 'judge_output_failed', phase: 'blind-judge', ...metadata, code: failure.code ?? 'provider_error', completionCount: doneCount, callCount: calls.length, ...(rawReason !== undefined ? { providerFinishReason: rawReason } : {}) });
    throw failure;
  }
}
