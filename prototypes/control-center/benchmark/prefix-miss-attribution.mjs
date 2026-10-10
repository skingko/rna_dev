#!/usr/bin/env node
// EVO-3 / TC-1 measurement (docs/planning/p1-specs-20261004/prefix.md §1.5), read-only. For each foreground and
// background-work stream (one sessionId) of a usage-ledger copy, every change of `prefixKey` between consecutive rows is
// attributed to the gene generation that happened between them, if any, classified as skills-only or as one that
// changed tool declarations or the system prompt, and bucketed by the gap. KPI: uncached input on prefix changes within
// 40 minutes after a skills-only generation (0.92M per 6.1 days before stable names; target 0).
// Usage: node benchmark/prefix-miss-attribution.mjs --ledger <usage-cache.jsonl copy> --state <state.json copy>
//        [--projects <GET /api/projects JSON>] [--since ISO]
// Never open a Store on production state: pass copies (readStateFile reads, it never writes).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { parseUsageLedger } from '../usage-cache-service.mjs';

const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const GAPS = [['under_20m', 20 * 60000], ['20_40m', 40 * 60000], ['over_40m', Infinity]];
const bucket = gap => GAPS.find(([, limit]) => gap < limit)[0];

/** What a generation changed relative to its parent: tool declarations (id, description, parameters, permission) or the
 * system prompt (`declarations`), otherwise skills only (`skills_only`); `unknown` without both genomes. */
export function generationKind(version, parent) {
  const genome = version?.bundle?.genome, before = parent?.bundle?.genome;
  if (!genome || !before) return 'unknown';
  const declarations = g => JSON.stringify((g.tools ?? []).map(({ id, description, parameters, permission }) => ({ id, description, parameters, permission })).sort((a, b) => a.id.localeCompare(b.id)));
  return declarations(genome) !== declarations(before) || genome.systemPrompt !== before.systemPrompt ? 'declarations' : 'skills_only';
}
/** Generations of every project: { projectId, at (ms), versionId, kind }. */
export function generations(projects) {
  const rows = [];
  for (const project of projects ?? []) for (const version of project.versions ?? []) {
    if (!version?.bundle || !version.parentVersionId) continue;
    const at = Date.parse(version.createdAt ?? ''); if (!Number.isFinite(at)) continue;
    rows.push({ projectId: project.id, at, versionId: version.id, kind: generationKind(version, project.versions.find(row => row.id === version.parentVersionId)) });
  }
  return rows.sort((a, b) => a.at - b.at);
}
/** Prefix changes per stream, attributed. Rows are the ledger's (at, purpose, projectId, sessionId, input, cacheRead, prefixKey). */
export function attribute(rows, gens, { since = -Infinity } = {}) {
  const streams = new Map();
  for (const row of rows) {
    if (!['foreground', 'background-work'].includes(row.purpose) || !row.sessionId || !row.prefixKey) continue;
    const at = Date.parse(row.at); if (!Number.isFinite(at) || at < since) continue;
    (streams.get(row.sessionId) ?? streams.set(row.sessionId, []).get(row.sessionId)).push({ ...row, atMs: at });
  }
  const changes = [];
  for (const [sessionId, list] of streams) {
    list.sort((a, b) => a.atMs - b.atMs);
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1], row = list[index];
      if (row.prefixKey === previous.prefixKey) continue;
      const between = gens.filter(gen => gen.projectId === row.projectId && gen.at > previous.atMs && gen.at <= row.atMs);
      const kind = !between.length ? 'no_generation' : between.some(gen => gen.kind === 'declarations') ? 'declarations' : between.some(gen => gen.kind === 'unknown') ? 'unknown' : 'skills_only';
      const after = between.length ? row.atMs - between.at(-1).at : null;
      changes.push({ sessionId, purpose: row.purpose, projectId: row.projectId, at: row.at, gap: bucket(row.atMs - previous.atMs), kind, sinceGenerationMs: after, uncached: row.input ?? 0, cacheRead: row.cacheRead ?? 0 });
    }
  }
  return changes;
}
export function summarize(changes) {
  const table = {};
  for (const change of changes) {
    const key = `${change.kind}:${change.gap}`, cell = table[key] ??= { changes: 0, uncached: 0 };
    cell.changes++; cell.uncached += change.uncached;
  }
  const kpi = changes.filter(change => change.kind === 'skills_only' && change.sinceGenerationMs !== null && change.sinceGenerationMs <= 40 * 60000);
  return { changes: changes.length, byKindAndGap: table, kpi: { description: 'uncached input on prefix changes within 40 min after a skills-only generation', changes: kpi.length, uncached: kpi.reduce((sum, row) => sum + row.uncached, 0) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const ledger = arg('--ledger'), statePath = arg('--state'), projectsPath = arg('--projects');
  if (!ledger || !(statePath || projectsPath)) { console.error('Usage: --ledger <jsonl copy> --state <state.json copy> | --projects <json>'); process.exit(2); }
  const rows = parseUsageLedger(readFileSync(ledger, 'utf8'));
  const projects = statePath ? readStateFile(statePath)?.state?.projects : (body => body.projects ?? body)(JSON.parse(readFileSync(projectsPath, 'utf8')));
  const since = arg('--since') ? Date.parse(arg('--since')) : -Infinity;
  console.log(JSON.stringify(summarize(attribute(rows, generations(projects), { since })), null, 2));
}
