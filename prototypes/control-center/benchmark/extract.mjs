import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { projectDataset, projectSideData } from './dataset.mjs';
import { heuristicLabels, applyManualLabels, labelTemplate, loadLabelFile } from './labels.mjs';
import { FIXTURE_SCHEMA, FIXTURE_VERSION, FIXTURE_KINDS, validateRow, validateManifest } from './schemas.mjs';

// K4 fixture extractor. Reads production state strictly read-only
// (readStateFile + immutable archive/ledger files) and writes a sanitized,
// versioned fixture set into a local directory that is git-ignored
// (benchmark/fixtures/). It never writes next to the source state.
export const DEFAULT_FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MAX_TEXT = 4000;
const RULES = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/(?<![0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}(?![0-9a-z])/gi, '<hash>'],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g, '<secret>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, 'Bearer <secret>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/(?:\/(?:Users|home|private|tmp|var|opt|etc|Volumes|root)\/[^\s"'`)\]，。；：]+|~\/[^\s"'`)\]，。；：]+|[A-Za-z]:\\[^\s"'`)]+)/g, '<path>'],
  [/(https?:\/\/[^\s?#"'`)]+)[?#][^\s"'`)]*/g, '$1?<query>'],
];
/** Deterministic text sanitizer for fixtures. */
export function sanitizeText(value, { max = MAX_TEXT } = {}) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const TEXT_FIELDS = new Set(['text', 'reason', 'content', 'request', 'summary', 'title', 'name']);
/** Sanitize every text-bearing field (recursively), keeping identifiers and numbers. */
export function sanitizeValue(value, key = '') {
  if (typeof value === 'string') return TEXT_FIELDS.has(key) || value.length > 200 ? sanitizeText(value) : value;
  if (Array.isArray(value)) return value.map(row => sanitizeValue(row, key === 'openQuestions' ? 'text' : ''));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, row]) => [field, sanitizeValue(row, field)]));
  return value;
}
const within = (parent, child) => { const rel = relative(parent, child); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
/** Refuse any output location inside (or equal to) the source state directory. */
export function assertSafeOutput(stateFile, out) {
  const source = real(dirname(resolve(stateFile))), target = resolve(out);
  let probe = target; while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const resolved = join(real(probe), relative(probe, target));
  if (within(source, resolved)) throw Object.assign(new Error('Fixture output must not be inside the source state directory'), { code: 'bench_output_unsafe' });
}
const KIND_OF = { messages: 'messages', proactive: 'proactive', decisions: 'decisions', wakeFailures: 'wake-failures', turns: 'turns', commitments: 'commitments', scheduled: 'scheduled', usage: 'usage', backgroundWork: 'background-work', inbox: 'inbox' };

/** Sanitized fixture rows for one dataset. */
export function datasetFixture(dataset) {
  const clean = sanitizeValue(dataset), rows = {};
  for (const [field, kind] of Object.entries(KIND_OF)) rows[kind] = clean[field] ?? [];
  rows['user-messages'] = clean.messages.filter(row => row.role === 'user').map(row => ({ itemId: row.id, sessionId: row.sessionId, at: row.at, channel: row.channel, text: row.text, labels: row.labels, labelSource: row.labelSource, ...(row.topic ? { topic: row.topic } : {}) }));
  const meta = { projectId: clean.projectId, name: clean.name, timeZone: clean.timeZone, now: clean.now, evolution: clean.evolution, openQuestions: clean.openQuestions, mind: clean.mind ?? null };
  return { meta, rows };
}

/**
 * Extract fixtures. options: { stateFile (required), out (fixture root), projectIds?, labelsFile?, now?, version? }
 * Returns { dir, manifest }.
 */
export function extractFixtures({ stateFile, out = DEFAULT_FIXTURE_ROOT, projectIds, labelsFile, now = Date.now(), version = FIXTURE_VERSION, readState = readStateFile } = {}) {
  if (!stateFile) throw Object.assign(new Error('stateFile is required'), { code: 'bench_state_missing' });
  assertSafeOutput(stateFile, out);
  const loaded = readState(resolve(stateFile)); if (!loaded?.state) throw Object.assign(new Error('State file could not be read'), { code: 'bench_state_unreadable' });
  const state = loaded.state, labels = loadLabelFile(labelsFile ?? join(out, 'labels.json'));
  const targets = (state.projects ?? []).filter(row => !projectIds?.length || projectIds.includes(row.id));
  const dir = join(out, version); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const projects = [], allUsers = [];
  for (const project of targets) {
    const dataset = projectDataset(state, project.id, { side: projectSideData(resolve(stateFile), project.id), labels, now });
    const { meta, rows } = datasetFixture(dataset), target = join(dir, project.id); mkdirSync(target, { recursive: true, mode: 0o700 });
    const counts = {};
    for (const [kind, list] of Object.entries(rows)) {
      const problems = list.flatMap(row => validateRow(kind, row)); if (problems.length) throw Object.assign(new Error(`Fixture validation failed: ${problems.slice(0, 3).join('; ')}`), { code: 'bench_fixture_invalid' });
      writeFileSync(join(target, `${kind}.jsonl`), list.map(row => JSON.stringify(row)).join('\n') + (list.length ? '\n' : ''), { mode: 0o600 });
      counts[kind] = list.length;
    }
    writeFileSync(join(target, 'project.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    projects.push({ ...meta, mind: undefined, counts }); allUsers.push(...rows['user-messages']);
  }
  const manifest = { schema: FIXTURE_SCHEMA, version, extractedAt: new Date(now).toISOString(), source: { kind: 'state', generation: loaded.generation ?? null, archive: true, usageLedger: true }, projects };
  const problems = validateManifest(manifest); if (problems.length) throw Object.assign(new Error(problems.join('; ')), { code: 'bench_fixture_invalid' });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(out, 'labels.template.json'), JSON.stringify(labelTemplate(allUsers), null, 2) + '\n', { mode: 0o600 });
  return { dir, manifest };
}

const readJsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
/** Load a fixture set back into datasets (manual labels re-applied from <root>/labels.json). */
export function loadFixtures(root = DEFAULT_FIXTURE_ROOT, { version = FIXTURE_VERSION, labelsFile } = {}) {
  const dir = join(root, version), manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const problems = validateManifest(manifest); if (problems.length) throw Object.assign(new Error(problems.join('; ')), { code: 'bench_fixture_invalid' });
  const labels = loadLabelFile(labelsFile ?? join(root, 'labels.json'));
  const datasets = manifest.projects.map(entry => {
    const target = join(dir, entry.projectId), meta = JSON.parse(readFileSync(join(target, 'project.json'), 'utf8')), rows = {};
    for (const kind of Object.keys(FIXTURE_KINDS)) rows[kind] = readJsonl(join(target, `${kind}.jsonl`));
    const messages = rows.messages.map(row => row.role === 'user' ? { ...row, ...applyManualLabels(row.id, heuristicLabels(row.text, { source: row.channel === 'answer' ? 'interaction-answer' : undefined }), labels) } : row);
    return { schema: 'rna-bench-dataset/1', projectId: meta.projectId, name: meta.name, timeZone: meta.timeZone, now: meta.now, messages, turns: rows.turns, proactive: rows.proactive, decisions: rows.decisions, wakeFailures: rows['wake-failures'], usage: rows.usage,
      backgroundWork: rows['background-work'], commitments: rows.commitments, inbox: rows.inbox, evolution: meta.evolution, scheduled: rows.scheduled, openQuestions: meta.openQuestions, mind: meta.mind ?? null };
  });
  return { manifest, datasets };
}
export const fixtureVersions = (root = DEFAULT_FIXTURE_ROOT) => existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'manifest.json'))) : [];
