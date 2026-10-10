import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToolRecovery } from '../src/project-evaluation-recovery.mjs';

const receipt = argumentPath => ({ source: 'sdk_argument_validation', code: 'invalid_tool_arguments', argumentPath, neverExecuted: true });
function sample(tool = 'project_write', args = { path: 'reports/daily.md', content: 'PRIVATE_CONTENT', expectedHash: 'null' }, corrected = { path: './reports/daily.md', content: 'PRIVATE_CONTENT', createOnly: true }, path = '$.expectedHash') {
  return { policyId: 'schema-recovery-v1', calls: [{ id: 'failed', name: tool, arguments: args }, { id: 'corrected', name: tool, arguments: corrected }],
    toolResults: [{ toolCallId: 'failed', toolName: tool, isError: true, output: 'PRIVATE_TOOL_OUTPUT', validationReceipt: receipt(path) }, { toolCallId: 'corrected', toolName: tool, isError: false }] };
}
const failed = input => { const audit = evaluateToolRecovery(input); assert.equal(audit.allResolved, false); assert.equal(audit.recovered.length, 0); assert.ok(audit.unresolved.length); return audit; };

test('new policy links a no-execution schema rejection to a later same-target correction without erasing the original', () => {
  const input = sample(), before = structuredClone(input), audit = evaluateToolRecovery(input);
  assert.equal(audit.allResolved, true); assert.deepEqual(audit.unresolved, []);
  assert.deepEqual(audit.recovered, [{ toolCallId: 'failed', toolName: 'project_write', recoveredByCallId: 'corrected', reason: 'validated_correction', argumentPath: '$.expectedHash' }]);
  assert.deepEqual(input, before); assert.doesNotMatch(JSON.stringify(audit), /PRIVATE|reports|content|expectedHash.*null/);
});
test('strict policy and the default retain historical any-error semantics', () => {
  const input = sample(); delete input.policyId;
  assert.equal(failed(input).policyId, 'strict-v1'); assert.equal(failed({ ...input, policyId: 'strict-v1' }).unresolved[0].reason, 'strict_tool_error');
});
test('empty histories and clean complete histories succeed under both policies', () => {
  for (const policyId of ['strict-v1', 'schema-recovery-v1']) {
    assert.equal(evaluateToolRecovery({ policyId }).allResolved, true);
    assert.equal(evaluateToolRecovery({ policyId, calls: [{ id: 'ok', name: 'project_list', arguments: {} }], toolResults: [{ toolCallId: 'ok', toolName: 'project_list', isError: false }] }).allResolved, true);
  }
});
test('different workspace path does not recover an earlier write', () => { const input = sample(); input.calls[1].arguments.path = 'reports/another.md'; failed(input); });
test('same path with unrelated replacement content does not recover the intended write', () => { const input = sample(); input.calls[1].arguments.content = 'OTHER_WORK'; failed(input); });
test('missing or malformed path never establishes a workspace correction target', () => {
  for (const path of [undefined, '', '/tmp/a', '../a', 'a/../b', 'C:\\a', 'a\\b', 'a\0b']) {
    const input = sample(); input.calls[0].arguments.path = path; input.calls[1].arguments.path = path; failed(input);
  }
});
test('repairing the workspace path itself is not evidence of correcting the same target', () => { const input = sample('project_read', { path: 42, offset: 1 }, { path: 'real.md', offset: 1 }, '$.path'); failed(input); });
test('later success by a different tool is unrelated', () => { const input = sample(); input.calls[1].name = input.toolResults[1].toolName = 'project_edit'; failed(input); });
test('success before the failure and mismatched result ordering do not recover it', () => {
  const input = sample(); input.toolResults.reverse(); failed(input);
  input.toolResults.reverse(); input.calls.reverse(); failed(input);
});
test('duplicate call IDs invalidate matching even when receipts agree', () => { const input = sample(); input.calls.push(structuredClone(input.calls[0])); failed(input); });
test('duplicate result IDs invalidate matching even when duplicate contents agree', () => { const input = sample(); input.toolResults.push(structuredClone(input.toolResults[1])); failed(input); });
test('missing original call and missing correction call cannot manufacture recovery', () => {
  for (const index of [0, 1]) { const input = sample(); input.calls.splice(index, 1); failed(input); }
});
test('calls with no result remain unknown outcomes and cannot be erased by unrelated success', () => {
  const input = sample(); input.toolResults.shift(); assert.ok(failed(input).unresolved.some(row => row.reason === 'missing_result_unknown_outcome'));
});
test('native-looking text and error codes are insufficient without the host validation receipt', () => {
  for (const fake of [{ output: 'Invalid tool arguments: $.expectedHash: anyOf constraint failed' }, { code: 'invalid_tool_arguments' }, { details: { code: 'invalid_tool_arguments', written: false } }, { details: { validationReceipt: receipt('$.expectedHash') } }]) {
    const input = sample(); delete input.toolResults[0].validationReceipt; Object.assign(input.toolResults[0], fake); failed(input);
  }
});
for (const code of ['permission_denied', 'not_authorized', 'aborted', 'runtime_error', 'script_error', 'conflict', 'invalid_arguments', 'process_cleanup_uncertain', 'invalid_tool_arguments\npermission_denied']) {
  test(`tool-authored ${JSON.stringify(code)} never recovers merely because the next call succeeds`, () => {
    const input = sample(); delete input.toolResults[0].validationReceipt; input.toolResults[0].details = { code, written: false }; failed(input);
  });
}
test('unknown or side-effect evidence overrides an otherwise native receipt', () => {
  for (const field of [{ uncertain: true }, { outcomeUnknown: true }, { details: { written: true } }, { code: 'permission_denied' }]) {
    const input = sample(); Object.assign(input.toolResults[0], field); failed(input);
  }
});
test('unconfirmed correction never counts as a successful recovery', () => {
  for (const field of [{ isError: true }, { uncertain: true }, { outcomeUnknown: true }, { validationReceipt: receipt('$.content') }]) {
    const input = sample(); Object.assign(input.toolResults[1], field); failed(input);
  }
});
test('incomplete, non-native or expanded receipts do not establish pre-execution rejection', () => {
  for (const change of [{ source: 'tool' }, { neverExecuted: false }, { code: 'invalid_arguments' }, { extra: true }, { argumentPath: null }]) {
    const input = sample(); Object.assign(input.toolResults[0].validationReceipt, change); failed(input);
  }
});
test('root, invalid, absent and prototype-sensitive argument paths are not recovery proofs', () => {
  for (const path of ['$', '$.unknown', '$[0]', '$.constructor.x', '$.__proto__.x', '$.prototype', '$.x.y.z.a.b.c.d.e.f', '$.x\n']) {
    const input = sample(); input.toolResults[0].validationReceipt.argumentPath = path; failed(input);
  }
});
test('generated tools require equal stable input fields excluding exactly the invalid field', () => {
  const input = sample('layout_build', { seed: 7, count: 'ten', mode: 'compact' }, { seed: 7, count: 10, mode: 'compact' }, '$.count');
  assert.equal(evaluateToolRecovery(input).allResolved, true);
  input.calls[1].arguments.seed = 8; failed(input);
});
test('nested and array field correction preserves valid siblings and array shape', () => {
  const input = sample('layout_build', { items: [{ id: 'a', size: 'x' }], seed: 7 }, { items: [{ id: 'a', size: 3 }], seed: 7 }, '$.items[0].size');
  assert.equal(evaluateToolRecovery(input).allResolved, true);
  input.calls[1].arguments.items[0].id = 'b'; failed(input);
  input.calls[1].arguments.items[0].id = 'a'; input.calls[1].arguments.items.push({ id: 'b', size: 1 }); failed(input);
});
test('an invalid field alone, empty objects or omitted valid fields provide no stable operation identity', () => {
  failed(sample('layout_build', { count: 'ten' }, { count: 10 }, '$.count'));
  failed(sample('layout_build', { count: 'ten', context: {} }, { count: 10, context: {} }, '$.count'));
  failed(sample('layout_build', { count: 'ten', seed: 3 }, { count: 10 }, '$.count'));
});
test('one later correction can resolve repeated rejected attempts but every failed call stays linked', () => {
  const input = sample(); input.calls.splice(1, 0, { ...structuredClone(input.calls[0]), id: 'failed-again' });
  input.toolResults.splice(1, 0, { ...structuredClone(input.toolResults[0]), toolCallId: 'failed-again' });
  const audit = evaluateToolRecovery(input); assert.equal(audit.allResolved, true); assert.equal(audit.recovered.length, 2); assert.deepEqual(audit.recovered.map(row => row.toolCallId), ['failed', 'failed-again']);
});
test('a resolved schema error does not hide a separate later business failure', () => {
  const input = sample(); input.calls.push({ id: 'business', name: 'layout_build', arguments: {} }); input.toolResults.push({ toolCallId: 'business', toolName: 'layout_build', isError: true, details: { code: 'unreachable_layout' } });
  const audit = evaluateToolRecovery(input); assert.equal(audit.allResolved, false); assert.equal(audit.recovered.length, 1); assert.equal(audit.unresolved[0].toolCallId, 'business');
});
test('non-JSON, cyclic and oversized arguments remain conservative without throwing', () => {
  for (const bad of [NaN, new Date(), undefined, 'x'.repeat(262145)]) {
    const input = sample(); input.calls[0].arguments.content = bad; failed(input);
  }
  const input = sample(); input.calls[0].arguments.content = input.calls[0].arguments; failed(input);
});
test('malformed identities, result booleans and unmatched tool names remain unresolved', () => {
  for (const change of [{ toolCallId: '<script>' }, { toolName: 'other' }, { isError: 'false' }]) { const input = sample(); Object.assign(input.toolResults[1], change); failed(input); }
});
test('bounded input/output audit cannot emit source text or claim uninspected history is resolved', () => {
  const input = { policyId: 'schema-recovery-v1', calls: [], toolResults: [] };
  for (let n = 0; n < 200; n++) { input.calls.push({ id: `c-${n}`, name: 'tool', arguments: {} }); input.toolResults.push({ toolCallId: `c-${n}`, toolName: 'tool', isError: true, output: 'PRIVATE_BODY' }); }
  const audit = evaluateToolRecovery(input); assert.equal(audit.unresolved.length, 128); assert.equal(audit.unresolvedCount, 200); assert.equal(audit.truncated, true); assert.equal(audit.allResolved, false); assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_BODY/);
  input.calls.length = 513; assert.equal(evaluateToolRecovery(input).unresolved[0].reason, 'history_unavailable_or_limit');
});
test('unknown policy is rejected rather than silently enabling recovery', () => { assert.throws(() => evaluateToolRecovery({ policyId: 'loose' }), { code: 'invalid_evaluation_recovery' }); });

// Review 2026-10-05 (tool-safety): project_write refuses to overwrite a file the conversation has not observed, or that
// changed since, and writes nothing (A6). schema-recovery-v2 (workflow-v3) counts reading it and then writing or editing
// that same path as the correction; the evaluator's own write-tool wrapper is the only source of the receipt.
const guard = (code = 'not_observed') => ({ source: 'host_write_guard', code, written: false });
function blind({ code, correction = 'project_write', path = 'notes.md', policyId = 'schema-recovery-v2', receiptOf = guard } = {}) {
  return { policyId, calls: [{ id: 'blind', name: 'project_write', arguments: { path: 'notes.md', content: 'PRIVATE_NEW' } }, { id: 'read', name: 'project_read', arguments: { path: 'notes.md' } }, { id: 'fixed', name: correction, arguments: correction === 'project_edit' ? { path, edits: [{ oldText: 'a', newText: 'b' }] } : { path, content: 'PRIVATE_NEW' } }],
    toolResults: [{ toolCallId: 'blind', toolName: 'project_write', isError: true, output: 'notes.md already exists and has not been read in this conversation.', ...(receiptOf ? { writeGuardReceipt: receiptOf(code) } : {}) }, { toolCallId: 'read', toolName: 'project_read', isError: false }, { toolCallId: 'fixed', toolName: correction, isError: false }] };
}
test('schema-recovery-v2: a write-guard refusal is recovered by a later successful write or edit of the same path', () => {
  for (const [code, correction, path] of [['not_observed', 'project_write', 'notes.md'], ['conflict', 'project_write', './notes.md'], ['not_observed', 'project_edit', 'notes.md']]) {
    const audit = evaluateToolRecovery(blind({ code, correction, path }));
    assert.equal(audit.allResolved, true, `${code} ${correction}`);
    assert.deepEqual(audit.recovered, [{ toolCallId: 'blind', toolName: 'project_write', recoveredByCallId: 'fixed', reason: 'write_guard_correction', code }]);
  }
  // workflow-v2's policy still counts it as unresolved, as it did.
  assert.equal(failed(blind({ policyId: 'schema-recovery-v1' })).unresolved[0].reason, 'not_verified_preexecution_validation');
  assert.equal(failed(blind({ policyId: 'strict-v1' })).unresolved[0].reason, 'strict_tool_error');
  // A schema rejection keeps its own rule under v2.
  assert.equal(evaluateToolRecovery({ ...sample(), policyId: 'schema-recovery-v2' }).allResolved, true);
});
test('schema-recovery-v2: no receipt, a forged or other receipt, another path or no later success is not a recovery', () => {
  assert.equal(failed(blind({ receiptOf: null })).unresolved[0].reason, 'not_verified_preexecution_validation', 'details text alone is not evidence');
  for (const receiptOf of [code => ({ ...guard(code), written: true }), code => ({ ...guard(code), source: 'tool_details' }), () => guard('path_denied'), code => ({ ...guard(code), extra: 1 })]) failed(blind({ receiptOf }));
  assert.equal(failed(blind({ path: 'other.md' })).unresolved[0].reason, 'no_matching_successful_correction');
  const unanswered = blind(); unanswered.toolResults[2].isError = true; unanswered.toolResults[2].writeGuardReceipt = guard(); failed(unanswered);
  const reordered = blind(); reordered.toolResults.unshift(reordered.toolResults.pop()); failed(reordered);
  // Only the workspace write tools carry write-guard receipts.
  const other = blind(); other.calls[0].name = other.toolResults[0].toolName = 'custom_tool'; failed(other);
});
