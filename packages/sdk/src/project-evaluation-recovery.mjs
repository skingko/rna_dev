/** Host-owned evaluation audit. This does not retry tools or erase failures.
 * validationReceipt MUST come from the SDK pre-execution validation event,
 * never from tool-authored text, details, or a parsed remote error body.
 * writeGuardReceipt (schema-recovery-v2) MUST come from the evaluator's own
 * wrapper around the host workspace project_write/project_edit instances: a
 * refusal that wrote nothing because the file was not observed in this
 * conversation or changed since (not_observed / conflict). */
export const PROJECT_EVALUATION_RECOVERY_POLICIES = Object.freeze(['strict-v1', 'schema-recovery-v1', 'schema-recovery-v2']);
export const WRITE_GUARD_CODES = Object.freeze(['not_observed', 'conflict']);
const writeTools = new Set(['project_write', 'project_edit']);
const MAX_EVENTS = 512, MAX_OUTPUT = 128, MAX_ARGUMENT_BYTES = 262144;
const names = /^[A-Za-z0-9_.:-]{1,160}$/;
const workspaceTools = new Set(['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeId = value => typeof value === 'string' && names.test(value) ? value : null;
const own = (value, key) => Object.hasOwn(value, key);
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_evaluation_recovery' }); };

function argumentPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\]){1,8}$/.test(value)) return null;
  const parts = [...value.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)].map(match => match[1] ?? Number(match[2]));
  return parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) ? null : parts;
}
function canonicalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u001f]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const parts = value.split('/');
  if (parts.some(part => part === '..')) return null;
  const path = parts.filter(part => part && part !== '.').join('/');
  return path || null;
}
function safeArguments(value) {
  const ancestors = new Set(); let count = 0, bytes = 0;
  const visit = item => {
    if (++count > 8192 || ancestors.size > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); return bytes <= MAX_ARGUMENT_BYTES; }
    if ((!object(item) && !Array.isArray(item)) || ancestors.has(item)) return false;
    ancestors.add(item);
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !visit(item[key])) return false;
    }
    ancestors.delete(item); return true;
  };
  return object(value) && visit(value);
}
function isSubtreeEqual(left, right, ignored) {
  if (!ignored.length) return { equal: true, compared: 0 };
  if (left === null || typeof left !== 'object') return { equal: Object.is(left, right), compared: 1 };
  if (Array.isArray(left) !== Array.isArray(right) || !right || typeof right !== 'object' || Array.isArray(left) && left.length !== right.length) return { equal: false, compared: 0 };
  let compared = 0;
  for (const key of Object.keys(left)) {
    const match = String(ignored[0]) === key;
    if (match && ignored.length === 1) continue;
    if (!own(right, key)) return { equal: false, compared: 0 };
    const result = match ? isSubtreeEqual(left[key], right[key], ignored.slice(1)) : exact(left[key], right[key]);
    if (!result.equal) return result;
    compared += result.compared;
  }
  return { equal: true, compared };
}
function exact(left, right) {
  if (left === null || typeof left !== 'object') return { equal: Object.is(left, right), compared: 1 };
  if (Array.isArray(left) !== Array.isArray(right) || !right || typeof right !== 'object') return { equal: false, compared: 0 };
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return { equal: false, compared: 0 };
  let compared = 0;
  for (const key of keys) { if (!own(right, key)) return { equal: false, compared: 0 }; const result = exact(left[key], right[key]); if (!result.equal) return result; compared += result.compared; }
  return { equal: true, compared };
}
function targetMatches(before, after, path) {
  if (!safeArguments(before.arguments) || !safeArguments(after.arguments)) return false;
  const left = before.arguments, right = after.arguments;
  let invalid = left;
  for (const part of path) { if (invalid === null || typeof invalid !== 'object' || !own(invalid, part)) return false; invalid = invalid[part]; }
  if (workspaceTools.has(before.name)) {
    const target = canonicalPath(left.path);
    // A malformed/missing target never establishes which operation was being
    // corrected. Do not allow changing the target as the invalid-field repair.
    if (!target || target !== canonicalPath(right.path) || path[0] === 'path') return false;
    const compared = isSubtreeEqual({ ...left, path: target }, { ...right, path: target }, path);
    return compared.equal && compared.compared > 0;
  }
  const compared = isSubtreeEqual(left, right, path);
  return compared.equal && compared.compared > 0;
}
function trustedValidation(result) {
  const receipt = result.validationReceipt;
  if (!object(receipt) || Object.keys(receipt).sort().join(',') !== 'argumentPath,code,neverExecuted,source' ||
      receipt.source !== 'sdk_argument_validation' || receipt.code !== 'invalid_tool_arguments' || receipt.neverExecuted !== true || result.uncertain === true || result.outcomeUnknown === true ||
      result.code !== undefined && result.code !== 'invalid_tool_arguments' || result.details?.written === true) return null;
  return argumentPath(receipt.argumentPath);
}
// A write guard refusal: the host tool wrote nothing, and reading the file then writing or editing that same path is
// the correction its message asks for (harness fs-observation-policy; zcode write.ts:281-299).
function trustedWriteGuard(result, call) {
  const receipt = result.writeGuardReceipt;
  if (!object(receipt) || Object.keys(receipt).sort().join(',') !== 'code,source,written' || receipt.source !== 'host_write_guard' || !WRITE_GUARD_CODES.includes(receipt.code) || receipt.written !== false ||
      result.validationReceipt !== undefined || result.uncertain === true || result.outcomeUnknown === true || !writeTools.has(call.name) || !safeArguments(call.arguments)) return null;
  return canonicalPath(call.arguments.path);
}

export function evaluateToolRecovery({ calls = [], toolResults = [], policyId = 'strict-v1' } = {}) {
  if (!PROJECT_EVALUATION_RECOVERY_POLICIES.includes(policyId)) fail('Unknown host evaluation recovery policy');
  const recovered = [], unresolved = [];
  const finish = (complete = true) => ({ policyId, recovered: recovered.slice(0, MAX_OUTPUT), unresolved: unresolved.slice(0, MAX_OUTPUT),
    recoveredCount: recovered.length, unresolvedCount: unresolved.length, truncated: recovered.length > MAX_OUTPUT || unresolved.length > MAX_OUTPUT || !complete,
    allResolved: complete && unresolved.length === 0 });
  const note = (result, reason) => unresolved.push({ toolCallId: safeId(result?.toolCallId), toolName: safeId(result?.toolName), reason });
  if (!Array.isArray(calls) || !Array.isArray(toolResults) || calls.length > MAX_EVENTS || toolResults.length > MAX_EVENTS) {
    note(null, 'history_unavailable_or_limit'); return finish(false);
  }
  const callMap = new Map(), resultMap = new Map(), duplicateIds = new Set();
  for (const [index, call] of calls.entries()) {
    if (!object(call) || !safeId(call.id) || !safeId(call.name)) { note(null, 'invalid_call_identity'); continue; }
    if (callMap.has(call.id)) duplicateIds.add(call.id); else callMap.set(call.id, { ...call, index });
  }
  for (const [index, result] of toolResults.entries()) {
    if (!object(result) || !safeId(result.toolCallId) || !safeId(result.toolName) || typeof result.isError !== 'boolean') { note(result, 'invalid_result_identity'); continue; }
    if (resultMap.has(result.toolCallId)) duplicateIds.add(result.toolCallId); else resultMap.set(result.toolCallId, { ...result, index });
  }
  for (const id of duplicateIds) { const call = callMap.get(id); note({ toolCallId: id, toolName: call?.name }, 'ambiguous_call_identity'); }
  for (const [id, call] of callMap) if (!resultMap.has(id)) note({ toolCallId: id, toolName: call.name }, 'missing_result_unknown_outcome');
  for (const [id, result] of resultMap) {
    if (duplicateIds.has(id)) continue;
    const call = callMap.get(id);
    if (!call || call.name !== result.toolName) { note(result, 'unmatched_result'); continue; }
    if (result.uncertain === true || result.outcomeUnknown === true) { note(result, 'unknown_outcome'); continue; }
    if (!result.isError) continue;
    if (policyId === 'strict-v1') { note(result, 'strict_tool_error'); continue; }
    const guarded = policyId === 'schema-recovery-v2' ? trustedWriteGuard(result, call) : null;
    if (guarded) {
      const success = [...resultMap.values()].find(next => {
        const nextCall = callMap.get(next.toolCallId);
        return next.index > result.index && !duplicateIds.has(next.toolCallId) && next.isError === false && next.uncertain !== true && next.outcomeUnknown !== true &&
          !next.validationReceipt && !next.writeGuardReceipt && nextCall && nextCall.index > call.index && writeTools.has(nextCall.name) && next.toolName === nextCall.name && safeArguments(nextCall.arguments) && canonicalPath(nextCall.arguments.path) === guarded;
      });
      if (!success) { note(result, 'no_matching_successful_correction'); continue; }
      recovered.push({ toolCallId: id, toolName: call.name, recoveredByCallId: success.toolCallId, reason: 'write_guard_correction', code: result.writeGuardReceipt.code });
      continue;
    }
    const path = trustedValidation(result);
    if (!path) { note(result, 'not_verified_preexecution_validation'); continue; }
    const success = [...resultMap.values()].find(next => {
      const nextCall = callMap.get(next.toolCallId);
      return next.index > result.index && !duplicateIds.has(next.toolCallId) && next.isError === false && next.uncertain !== true && next.outcomeUnknown !== true &&
        !next.validationReceipt && nextCall && nextCall.index > call.index && nextCall.name === call.name && next.toolName === call.name && targetMatches(call, nextCall, path);
    });
    if (!success) { note(result, 'no_matching_successful_correction'); continue; }
    recovered.push({ toolCallId: id, toolName: call.name, recoveredByCallId: success.toolCallId, reason: 'validated_correction', argumentPath: result.validationReceipt.argumentPath });
  }
  return finish();
}
