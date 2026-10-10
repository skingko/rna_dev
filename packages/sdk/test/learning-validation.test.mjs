import test from 'node:test';
import assert from 'node:assert/strict';
import { learningReflectionSchema } from '../src/learning.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { validateReflectionContract, sanitizeLearningValidationDiagnostic, reflectionValidationError } from '../src/learning-validation.mjs';

const sample = patch => ({ outcome: 'no_change', reason: 'No supported reusable change.', evidenceIds: ['episode:actual'], diagnosis: 'Existing evidence supports keeping the method.', hypothesis: '', intervention: '', validationPlan: '', limitations: 'Limited observed tasks.', nextReviewAfterMs: 60000, ...patch });
const failure = (value, schema = learningReflectionSchema) => {
  let actual; try { validateReflectionContract(schema, value); } catch (error) { actual = error; }
  assert.equal(actual?.code, 'invalid_learning_reflection'); assert.equal(actual.message, 'Learning reflection does not match its declared contract.');
  return actual;
};

test('the existing validator remains the only authority and successful objects retain identity', () => {
  const valid = sample(); assert.equal(validateReflectionContract(learningReflectionSchema, valid), valid);
  const cases = [null, [], 3, '', sample({ reason: 4 }), sample({ reason: ' ' }), sample({ outcome: 'invented' }), sample({ evidenceIds: [] }), sample({ evidenceIds: ['a', 'a'] }), sample({ evidenceIds: [null] }), sample({ nextReviewAfterMs: 0 }), sample({ nextReviewAfterMs: 86400001 }), sample({ nextReviewAfterMs: 1000.1 }), sample({ unexpected: true }), sample({ reason: 'x'.repeat(1201) })];
  for (const value of cases) { assert.throws(() => validateToolArguments(learningReflectionSchema, value)); assert.ok(failure(value).validationDiagnostic); }
});

test('schema failures retain fixed field paths, rules and measured types without values', () => {
  const absent = sample(); delete absent.diagnosis;
  assert.deepEqual(failure(absent).validationDiagnostic, { phase: 'schema', path: '$.diagnosis', rule: 'required', actualType: 'missing' });
  assert.deepEqual(failure(sample({ reason: null })).validationDiagnostic, { phase: 'schema', path: '$.reason', rule: 'type', actualType: 'null' });
  assert.deepEqual(failure(sample({ nextReviewAfterMs: 1 })).validationDiagnostic, { phase: 'schema', path: '$.nextReviewAfterMs', rule: 'minimum', actualType: 'number', limit: 1000 });
  assert.deepEqual(failure(sample({ nextReviewAfterMs: 86400001 })).validationDiagnostic, { phase: 'schema', path: '$.nextReviewAfterMs', rule: 'maximum', actualType: 'number', limit: 86400000 });
  assert.deepEqual(failure(sample({ reason: '  ' })).validationDiagnostic, { phase: 'schema', path: '$.reason', rule: 'pattern', actualType: 'string', length: 2 });
  assert.deepEqual(failure(sample({ evidenceIds: ['valid', ''] })).validationDiagnostic, { phase: 'schema', path: '$.evidenceIds[1]', rule: 'minLength', actualType: 'string', length: 0, limit: 1 });
});

test('counts and Unicode code-point limits follow the actual validator and supplied schema', () => {
  const atLimit = sample({ reason: '😀'.repeat(1200) }); assert.equal(validateReflectionContract(learningReflectionSchema, atLimit), atLimit);
  assert.deepEqual(failure(sample({ reason: '😀'.repeat(1201) })).validationDiagnostic, { phase: 'schema', path: '$.reason', rule: 'maxLength', actualType: 'string', length: 1201, limit: 1200 });
  assert.deepEqual(failure(sample({ evidenceIds: [] })).validationDiagnostic, { phase: 'schema', path: '$.evidenceIds', rule: 'minItems', actualType: 'array', count: 0, limit: 1 });
  assert.deepEqual(failure(sample({ evidenceIds: Array.from({ length: 33 }, (_, i) => `e${i}`) })).validationDiagnostic, { phase: 'schema', path: '$.evidenceIds', rule: 'maxItems', actualType: 'array', count: 33, limit: 32 });
  const changed = structuredClone(learningReflectionSchema); changed.properties.reason.maxLength = 2;
  assert.equal(failure(sample({ reason: '😀😀😀' }), changed).validationDiagnostic.limit, 2);
});

test('arbitrary property names and sensitive values never enter errors or diagnostics', () => {
  const secret = 'Bearer_private_credential_918273';
  for (const key of [secret, `reason: ${secret}`, `evidenceIds[0]\n${secret}`, '__proto__', 'constructor', 'validationDiagnostic']) {
    const value = sample(); Object.defineProperty(value, key, { value: { secret }, enumerable: true });
    const error = failure(value), serialized = JSON.stringify({ message: error.message, ...error });
    assert.equal(error.validationDiagnostic.rule, 'additionalProperties'); assert.equal(error.validationDiagnostic.path, '$');
    assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(key), key === 'validationDiagnostic');
    assert.equal(error.cause, undefined); assert.equal(error.draft, undefined);
  }
  for (const patch of [{ outcome: secret }, { reason: secret.repeat(100) }, { evidenceIds: [secret, secret] }, { nextReviewAfterMs: secret }]) assert.equal(JSON.stringify(failure(sample(patch))).includes(secret), false);
});

test('unrecognized schema paths and invalid JSON values fall back safely without inventing a field', () => {
  const secret = 'SECRET_DYNAMIC_FIELD';
  const schema = { type: 'object', required: [secret], properties: { [secret]: { type: 'string', maxLength: 1 } } };
  const missing = failure({}, schema); assert.equal(missing.validationDiagnostic.path, '$'); assert.equal(JSON.stringify(missing).includes(secret), false);
  const nested = failure({ [secret]: 'private data' }, schema); assert.equal(nested.validationDiagnostic.rule, 'validation'); assert.equal(nested.validationDiagnostic.path, '$'); assert.equal(JSON.stringify(nested).includes(secret), false);
  const cyclic = sample(); cyclic.reason = cyclic;
  assert.equal(failure(cyclic).validationDiagnostic.rule, 'finite_json');
  assert.equal(failure(sample({ reason: Infinity })).validationDiagnostic.rule, 'finite_json');
  const getter = sample(); Object.defineProperty(getter, 'reason', { enumerable: true, get() { throw new Error(secret); } });
  assert.deepEqual(failure(getter).validationDiagnostic, { phase: 'schema', path: '$', rule: 'validation', actualType: 'object' });
});

test('parse, evidence and experiment diagnostics only admit their own paths, rules and counters', () => {
  assert.deepEqual(sanitizeLearningValidationDiagnostic({ phase: 'parse', path: '$', rule: 'invalid_json', length: 17, unknownCount: 2, response: 'secret' }), { phase: 'parse', path: '$', rule: 'invalid_json', length: 17 });
  assert.deepEqual(sanitizeLearningValidationDiagnostic({ phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', count: 8, unknownCount: 1, allowedCount: 8, evidenceIds: ['private-id'], length: 900 }), { phase: 'evidence', path: '$.evidenceIds', rule: 'unknown_evidence', count: 8, unknownCount: 1, allowedCount: 8 });
  assert.deepEqual(sanitizeLearningValidationDiagnostic({ phase: 'experiment', path: '$.hypothesis', rule: 'required_nonblank', length: 0, missingCount: 3, limit: 7 }), { phase: 'experiment', path: '$.hypothesis', rule: 'required_nonblank', length: 0, missingCount: 3 });
  for (const value of [null, [], {}, { phase: 'parse', path: '$.reason', rule: 'invalid_json' }, { phase: 'schema', path: '$.secret', rule: 'type' }, { phase: 'schema', path: '$.evidenceIds[32]', rule: 'type' }, { phase: 'schema', path: '$.reason[0]', rule: 'type' }, { phase: 'schema', path: '$.reason', rule: 'secret' }, { phase: 'evidence', path: '$.diagnosis', rule: 'unknown_evidence' }, { phase: 'experiment', path: '$.reason', rule: 'required_nonblank' }, { phase: 'secret', path: '$', rule: 'invalid_json' }]) assert.equal(sanitizeLearningValidationDiagnostic(value), undefined);
});

test('sanitizer ignores inherited fields, getters, nonintegers and values outside bounded enums', () => {
  const valid = { phase: 'schema', path: '$.reason', rule: 'maxLength' };
  for (const bad of [-1, 1.5, Infinity, NaN, 100000001, '123', null, {}, ['secret']]) assert.deepEqual(sanitizeLearningValidationDiagnostic({ ...valid, length: bad, limit: bad, count: bad, actualType: 'private-type' }), valid);
  assert.deepEqual(sanitizeLearningValidationDiagnostic({ ...valid, length: 100000000, actualType: 'string' }), { ...valid, actualType: 'string', length: 100000000 });
  let reads = 0; const getter = { ...valid }; Object.defineProperty(getter, 'length', { enumerable: true, get() { reads++; throw new Error('private-value'); } });
  assert.deepEqual(sanitizeLearningValidationDiagnostic(getter), valid); assert.equal(reads, 0);
  Object.defineProperty(getter, 'path', { get() { reads++; return '$'; } }); assert.equal(sanitizeLearningValidationDiagnostic(getter), undefined); assert.equal(reads, 0);
  assert.equal(sanitizeLearningValidationDiagnostic(Object.create(valid)), undefined);
  assert.deepEqual(sanitizeLearningValidationDiagnostic(Object.assign(Object.create(null), valid)), valid);
  assert.equal(sanitizeLearningValidationDiagnostic(new Proxy({}, { getPrototypeOf() { throw new Error('private-value'); } })), undefined);
});

test('error helper accepts only host messages and copies a sanitized snapshot', () => {
  const diagnostic = { phase: 'parse', path: '$', rule: 'invalid_json', length: 12, secret: 'hidden' };
  const error = reflectionValidationError('Learning reflection returned invalid JSON.', diagnostic); diagnostic.length = 99;
  assert.equal(error.message, 'Learning reflection returned invalid JSON.'); assert.equal(error.code, 'invalid_learning_reflection'); assert.equal(error.validationDiagnostic.length, 12); assert.equal(JSON.stringify(error).includes('hidden'), false);
  const privateError = reflectionValidationError('Unexpected token SECRET at position 3', { phase: 'parse', path: '$', rule: 'invalid_json', token: 'SECRET' });
  assert.equal(privateError.message, 'Learning reflection validation failed.'); assert.equal(JSON.stringify(privateError).includes('SECRET'), false);
});
