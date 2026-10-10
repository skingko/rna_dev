import { validateToolArguments } from './capabilities.mjs';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const selector = { ...string(500), pattern: '^[^\\u0000\\r\\n]+$' }, id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' };
export const browserEvaluationEnvironmentSchema = object({
  kind: { const: 'browser' }, entry: string(400),
  viewport: object({ width: { type: 'integer', minimum: 320, maximum: 1920 }, height: { type: 'integer', minimum: 240, maximum: 1200 } }),
  steps: { type: 'array', minItems: 1, maxItems: 24, items: { oneOf: [
    object({ id, kind: { const: 'click' }, selector }),
    object({ id, kind: { const: 'input' }, selector, value: { type: 'string', maxLength: 4000 } }),
    object({ id, kind: { const: 'assert_text' }, selector, expected: string(4000) }),
    object({ id, kind: { const: 'assert_visible' }, selector }),
    object({ id, kind: { const: 'assert_count' }, selector, expected: { type: 'integer', minimum: 0, maximum: 1000 } }),
  ] } },
  screenshot: { type: 'boolean' }, settleMs: { type: 'integer', minimum: 0, maximum: 1000 },
  visualReview: { type: 'boolean' },
}, ['kind', 'entry', 'viewport', 'steps']);

export function validateBrowserEvaluationEnvironment(value) {
  if (value === undefined) return undefined;
  try {
    validateToolArguments(browserEvaluationEnvironmentSchema, value);
    if (value.entry.startsWith('/') || value.entry.includes('\\') || value.entry.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !/\.html?$/i.test(value.entry)) throw new Error('Browser entry must be a relative HTML artifact');
    if (new Set(value.steps.map(step => step.id)).size !== value.steps.length) throw new Error('Browser step IDs must be unique');
    if (!value.steps.some(step => step.kind.startsWith('assert_'))) throw new Error('Browser evaluation requires at least one host assertion');
    if (value.visualReview && value.screenshot === false) throw new Error('Visual review requires host screenshots');
    return structuredClone(value);
  } catch (error) { throw Object.assign(new Error(`Invalid browser evaluation environment: ${error.message}`), { code: 'invalid_evaluation_environment' }); }
}

// Public authoring guidance describes capabilities, never frozen assertions.
export const PROJECT_EVALUATION_DOMAIN_AUTHORING = `Task-specific evaluation fixtures are optional additions to the existing workspace contract. Use them when the project actually needs their behavior; do not add unsupported checks or weaken existing standards. Browser cases use environment:{kind:"browser",entry:"index.html",viewport:{width:1280,height:800},steps:[{id:"visible",kind:"assert_visible",selector:"main"}]}. Steps support click, input(value), assert_text(expected exact text), assert_visible and assert_count(expected). A browser case requires workspace and checks; create self-contained local HTML/JS/CSS without external dependencies. The host opens a fresh real Chromium page after the task and runs the frozen steps. This verifies those interactions and records runtime errors, not aesthetic quality or arbitrary live websites. Browser installation is a host prerequisite; a missing browser is an unavailable environment, never a zero quality score. Research and automation cases can use the domain schema: frozen source reads and citation provenance, or a deterministic local protocol service with host-controlled retry/idempotency receipts. Their instructions must state the public output format and success contract. Sources and protocol fixtures are test data, never evidence that live-world facts or external services were verified. Private checks, faults and expected values are never given to either evaluated agent. Model-authored fixtures are working standards, not independent confirmation data.`;
