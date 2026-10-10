import { validateToolArguments } from './capabilities.mjs';

// Keep model-authored property names, values and validator/JSON exception text
// out of durable receipts. These are the host reflection contract's names.
const fields = new Set(['outcome', 'reason', 'evidenceIds', 'diagnosis', 'hypothesis', 'intervention', 'validationPlan', 'limitations', 'nextReviewAfterMs']);
const experimentPaths = new Set(['$.hypothesis', '$.intervention', '$.validationPlan']);
const schemaRules = new Set(['required', 'type', 'enum', 'const', 'additionalProperties', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'finite_json', 'validation']);
const actualTypes = new Set(['missing', 'undefined', 'null', 'array', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function']);
const messages = new Set([
  'Learning reflection does not match its declared contract.',
  'Learning reflection cited evidence outside its frozen batch.',
  'A learning experiment requires a hypothesis, intervention and falsifiable validation plan.',
  'Learning reflection returned invalid JSON.',
]);
const MAX_DIAGNOSTIC_NUMBER = 100000000;
const own = (value, key) => {
  if (value === null || !['object', 'function'].includes(typeof value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const numeric = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIAGNOSTIC_NUMBER;
function fieldPath(path) {
  if (path === '$') return { root: true };
  if (typeof path !== 'string') return undefined;
  if (path.startsWith('$.') && fields.has(path.slice(2))) return { field: path.slice(2) };
  const match = /^\$\.evidenceIds\[(0|[1-9]|[12][0-9]|3[01])\]$/.exec(path);
  return match ? { field: 'evidenceIds', index: Number(match[1]) } : undefined;
}

/** Rebuild a small data-only diagnostic. Invalid required combinations return
 * undefined. No getters, arbitrary keys/strings, original values or errors are
 * copied; caller/provider lookalike objects do not expand the receipt schema. */
export function sanitizeLearningValidationDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const phase = own(value, 'phase'), path = own(value, 'path'), rule = own(value, 'rule');
    const location = fieldPath(path);
    if (!location) return undefined;
    let numbers;
    if (phase === 'schema' && schemaRules.has(rule)) numbers = ['length', 'count', 'limit'];
    else if (phase === 'parse' && path === '$' && ['invalid_json', 'empty_output'].includes(rule)) numbers = ['length'];
    else if (phase === 'evidence' && path === '$.evidenceIds' && rule === 'unknown_evidence') numbers = ['count', 'unknownCount', 'allowedCount'];
    else if (phase === 'experiment' && experimentPaths.has(path) && rule === 'required_nonblank') numbers = ['length', 'missingCount'];
    else return undefined;
    const clean = { phase, path, rule }, actualType = own(value, 'actualType');
    if (actualTypes.has(actualType)) clean.actualType = actualType;
    for (const field of numbers) { const number = own(value, field); if (numeric(number)) clean[field] = number; }
    return clean;
  } catch { return undefined; }
}

/** Only fixed host messages are accepted, never an interpolated parse/validator
 * error. Unknown messages become a generic failure without retaining a cause. */
export function reflectionValidationError(message, diagnostic) {
  const error = Object.assign(new Error(messages.has(message) ? message : 'Learning reflection validation failed.'), { code: 'invalid_learning_reflection' });
  const clean = sanitizeLearningValidationDiagnostic(diagnostic);
  if (clean) error.validationDiagnostic = clean;
  return error;
}

const rulesByMessage = new Map([
  ['does not equal const', 'const'], ['not in enum', 'enum'], ['too few properties', 'minProperties'], ['too many properties', 'maxProperties'],
  ['too few items', 'minItems'], ['too many items', 'maxItems'], ['duplicate items', 'uniqueItems'],
  ['string is too short', 'minLength'], ['string is too long', 'maxLength'], ['pattern constraint failed', 'pattern'],
  ...['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'anyOf', 'oneOf', 'not'].map(rule => [`${rule} constraint failed`, rule]),
]);
function diagnosticFromValidator(error, schema, value) {
  let path = '$', rule = 'validation';
  const message = own(error, 'message'), code = own(error, 'code');
  if (code === 'invalid_arguments' && message === 'Tool arguments must be finite, acyclic JSON values') rule = 'finite_json';
  else if (code === 'invalid_arguments' && typeof message === 'string') {
    // Match the validator's envelope first, then admit only host-owned paths.
    // The tail can contain an attacker-controlled unexpected property name;
    // recognize that rule without ever copying or interpolating the name.
    const match = /^([^:\r\n]{1,64}): ([\s\S]*)$/.exec(message);
    if (match && fieldPath(match[1])) {
      path = match[1]; const detail = match[2];
      if (rulesByMessage.has(detail)) rule = rulesByMessage.get(detail);
      else if (detail.startsWith('expected ')) rule = 'type';
      else if (detail.startsWith('unexpected property ')) rule = 'additionalProperties';
      else if (detail.startsWith('missing required property ')) {
        rule = 'required'; const field = detail.slice('missing required property '.length);
        if (path === '$' && fields.has(field)) path = `$.${field}`;
      }
    }
  }
  const location = fieldPath(path);
  let actual = value, boundary = schema, present = true;
  if (!location.root) {
    present = value !== null && typeof value === 'object' && Object.hasOwn(value, location.field);
    actual = own(value, location.field); boundary = own(own(schema, 'properties'), location.field);
    if (location.index !== undefined) {
      present = Array.isArray(actual) && Object.hasOwn(actual, location.index);
      actual = own(actual, location.index); boundary = own(boundary, 'items');
    }
  }
  const actualType = !present ? 'missing' : actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
  const diagnostic = { phase: 'schema', path, rule, actualType };
  // Match the existing validator's Unicode code-point length, not UTF-16 units.
  if (typeof actual === 'string') diagnostic.length = [...actual].length;
  else if (Array.isArray(actual)) diagnostic.count = actual.length;
  else if (actual && typeof actual === 'object' && ['additionalProperties', 'minProperties', 'maxProperties'].includes(rule)) diagnostic.count = Object.keys(actual).length;
  const limit = own(boundary, rule);
  if (numeric(limit)) diagnostic.limit = limit;
  return sanitizeLearningValidationDiagnostic(diagnostic);
}

/** Validation remains exclusively owned by the existing JSON Schema validator.
 * This adapter only classifies its first failure; it never repairs/coerces an
 * answer, reimplements schema acceptance, or relaxes the supplied contract. */
export function validateReflectionContract(schema, value) {
  try { return validateToolArguments(schema, value); }
  catch (error) {
    let diagnostic;
    try { diagnostic = diagnosticFromValidator(error, schema, value); } catch {}
    throw reflectionValidationError('Learning reflection does not match its declared contract.', diagnostic ?? { phase: 'schema', path: '$', rule: 'validation' });
  }
}
