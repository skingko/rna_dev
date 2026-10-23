#!/usr/bin/env node
// Gate 1b of a new check (docs/research/harnesspro-evolution-20261023.md): how the independent case writer and the checks
// that exist agree. Two steps, and no model call here, so no key is read:
//   inputs <dir>   writes <dir>/system.txt (GUARD_FIXTURES_SYSTEM, as shipped), <dir>/inputs.json (what the writer is given for
//                  each check the project grew: the rule, the project, the trigger globs; never the script or its status) and
//                  <dir>/key.json (which check each id is). Give system.txt and one input at a time to the model under test
//                  and collect {id: output} in a JSON file.
//   eval <dir> <fixtures.json>...   runs every case of every output through the stored script of its check with the production
//                  runner and prints, per check: whether the writer found it checkable, violating cases caught, compliant
//                  cases flagged, beside the label (below).
// Labels: whether the rule can be told from the literal text of one file (gene-route-terms-probe.mjs, 2026-10-05; null: arguable).
// Read-only on the app state (RNA_STATE, default this checkout's .state/state.json; the genomes sit beside it).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { runGenomeScript } from '../../../packages/sdk/src/project-genome.mjs';
import { prepareWorkspaceFixture } from '../../../packages/sdk/src/project-evaluation-workspace.mjs';
import { guardResult } from '../project-genes.mjs';
import { GUARD_FIXTURES_SYSTEM } from '../gene-evolution-service.mjs';

const LABELS = { guard_zhanshen_shouyeren: true, guard_stiff_expression: null, guard_no_deliverable_list: null, guard_beijing_time_base: false, guard_actionable_ideas: false, guard_briefing_dedupe: false, guard_100ch_summary: false, guard_v52_review_loop: false, guard_echo_foreshadow_check: false, guard_beat_rna054: false, guard_skip_browser_verify: false };
const PARAMETERS = { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 400 } } };
const [mode, dir, ...files] = process.argv.slice(2);
if (!['inputs', 'eval'].includes(mode) || !dir) { console.error('Usage: guard-fixtures.mjs inputs <dir> | eval <dir> <fixtures.json>...'); process.exit(2); }
const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
const live = readStateFile(stateFile)?.state ?? { projects: [] };
const clip = (value, max) => String(value ?? '').slice(0, max);
const guards = [];
for (const project of live.projects) for (const gene of project.genes?.genes ?? []) if (gene.layer === 'guard' && gene.body?.toolId) {
  const lesson = (project.mind?.lessons ?? []).find(row => row.id === gene.origin?.lessonId);
  guards.push({ projectId: project.id, project: project.name, description: project.description ?? project.overview ?? '', toolId: gene.body.toolId, title: gene.title, status: gene.status, kind: lesson?.kind ?? 'constraint', text: lesson?.text ?? gene.origin?.quote ?? gene.summary, quote: gene.origin?.quote ?? '', triggers: gene.body?.trigger?.onWrite ?? [] });
}
guards.forEach((row, index) => { row.id = `r${String(index + 1).padStart(2, '0')}`; });
if (mode === 'inputs') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'system.txt'), GUARD_FIXTURES_SYSTEM);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(guards.map(row => ({ id: row.id, input: { interfaceLanguage: 'Chinese', rule: { kind: row.kind, text: clip(row.text, 800), quote: clip(row.quote, 300) }, project: { title: clip(row.project, 120), description: clip(row.description, 400) }, triggers: row.triggers } })), null, 1));
  writeFileSync(join(dir, 'key.json'), JSON.stringify(guards.map(row => ({ id: row.id, projectId: row.projectId, toolId: row.toolId, title: row.title, status: row.status })), null, 1));
  console.log(`${guards.length} checks → ${dir}`); process.exit(0);
}
// The stored script of each check: the newest genome version that carries its tool.
const tools = new Map(), genomes = `${stateFile}.genomes`;
for (const project of readdirSync(genomes)) for (const version of readdirSync(join(genomes, project)).map(name => ({ name, at: (() => { try { return statSync(join(genomes, project, name, 'genome.json')).mtimeMs; } catch { return 0; } })() })).sort((a, b) => a.at - b.at)) {
  let genome; try { genome = JSON.parse(readFileSync(join(genomes, project, version.name, 'genome.json'), 'utf8')); } catch { continue; }
  for (const tool of genome.tools ?? []) tools.set(`${project}:${tool.id}`, { ...tool, permission: 'read', parameters: PARAMETERS });
}
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
for (const file of files) {
  const fixtures = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n${file}`);
  for (const row of key) {
    const tool = tools.get(`${row.projectId}:${row.toolId}`), out = fixtures[row.id], label = LABELS[row.toolId] ?? 'n/a';
    const head = `${row.id} ${row.toolId.padEnd(30)} ${String(row.status).padEnd(8)} label ${String(label).padEnd(5)}`;
    if (!out) { console.log(`${head} no output`); continue; }
    if (out.checkable === false) { console.log(`${head} writer: not checkable`); continue; }
    if (!tool) { console.log(`${head} writer: checkable, no stored script to run`); continue; }
    let caught = 0, broken = 0, flagged = 0, clean = 0, errors = 0;
    for (const item of out.cases ?? []) {
      const workspace = await mkdtemp(join(tmpdir(), 'rna-fixture-eval-'));
      try {
        await prepareWorkspaceFixture(workspace, { files: [{ path: item.path, content: item.content }] });
        const hit = guardResult((await runGenomeScript(tool, { path: item.path }, { workspace, timeoutMs: 5000 })).value).hits.length > 0;
        if (item.violations) { broken++; if (hit) caught++; } else { clean++; if (hit) flagged++; }
      } catch { errors++; } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    console.log(`${head} writer: checkable; caught ${caught}/${broken}, flagged ${flagged}/${clean} compliant${errors ? `, ${errors} errors` : ''}`);
  }
}
