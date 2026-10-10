// K4 benchmark fixture schemas (versioned). A fixture set is a directory:
//   <root>/<version>/manifest.json                 FIXTURE_MANIFEST
//   <root>/<version>/<projectId>/<kind>.jsonl       one row per line, kinds below
//   <root>/labels.json                             manual labels (labels.mjs LABEL_SCHEMA), user-editable
// Rows mirror dataset.mjs; text is sanitized (paths/ids/hashes/secrets replaced, clipped).
export const FIXTURE_SCHEMA = 'rna-bench-fixtures/1';
export const FIXTURE_VERSION = 'v1';
const str = value => typeof value === 'string', num = value => typeof value === 'number' && Number.isFinite(value), nullable = test => value => value === null || value === undefined || test(value);
const isoish = value => str(value) && Number.isFinite(Date.parse(value)), arr = value => Array.isArray(value), bool = value => typeof value === 'boolean', obj = value => value && typeof value === 'object' && !Array.isArray(value);
/** kind → { field: predicate } (required fields only; extra fields allowed). */
export const FIXTURE_KINDS = Object.freeze({
  messages: { id: str, sessionId: str, at: isoish, role: value => ['user', 'agent'].includes(value), channel: str, text: str },
  'user-messages': { itemId: str, at: isoish, text: str, labels: arr, labelSource: value => ['heuristic', 'manual'].includes(value) },
  proactive: { itemId: str, at: isoish, scheduled: bool, text: str, chars: num, presence: obj, next: nullable(obj) },
  decisions: { id: str, at: isoish, action: str, context: obj },
  'wake-failures': { at: nullable(isoish), phase: nullable(str), code: nullable(str) },
  turns: { id: str, sessionId: str, status: str, tokens: num, toolCalls: num, toolFailures: num },
  commitments: { id: str, source: str, request: str, createdAt: isoish, status: str },
  scheduled: { itemId: str, at: isoish, chars: num, text: str },
  usage: { at: isoish, purpose: str, input: num, output: num, cacheRead: num },
  'background-work': { id: str, kind: str, status: str },
  inbox: { id: str, tier: str },
});
export const FIXTURE_PROJECT_META = { projectId: str, name: nullable(str), timeZone: str, now: isoish, evolution: obj, openQuestions: arr };
export const FIXTURE_MANIFEST = { schema: value => value === FIXTURE_SCHEMA, version: str, extractedAt: isoish, source: obj, projects: arr };

/** Returns a list of problems ([] when valid). */
export function validateRow(kind, row) {
  const shape = FIXTURE_KINDS[kind]; if (!shape) return [`unknown fixture kind ${kind}`];
  if (!obj(row)) return [`${kind}: row is not an object`];
  return Object.entries(shape).filter(([field, test]) => !test(row[field])).map(([field]) => `${kind}.${field} invalid`);
}
export function validateManifest(manifest) {
  const problems = Object.entries(FIXTURE_MANIFEST).filter(([field, test]) => !test(manifest?.[field])).map(([field]) => `manifest.${field} invalid`);
  for (const project of manifest?.projects ?? []) problems.push(...Object.entries(FIXTURE_PROJECT_META).filter(([field, test]) => !test(project?.[field])).map(([field]) => `project.${field} invalid`));
  return problems;
}
