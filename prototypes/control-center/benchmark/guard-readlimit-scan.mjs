#!/usr/bin/env node
// Which generated guards turn a failed read into a violation? (design2 §6.2, §7 W3.)
// A guard that reads a second file (an index, a rules file) inside try/catch and answers "missing" for any failure reports a
// file the worker refused to read (too large, denied) as a violation of the project: on the AI project the dedupe guard did
// that once its index passed 64,000 bytes, and the 09:00 run spent four requests (553,428 tokens) on it.
//
// For every read-permission guard in every genome version of a state copy, and for every smoke case that has a workspace:
// run the guard on its fixture as it is (the baseline: it must still give the smoke case's answer), then once per fixture file
// with that file replaced by one the worker cannot read (`--bytes`, default: one byte over the worker's read bound) and once
// with it removed, all in the real restricted worker (runGenomeScript). The script cannot see the file's content in either
// variant, so any hit the baseline did not have is a consequence of the failed read:
//   reports_unchecked   the answer carries `unchecked` for it (the contract's way): "could not check", never a violation
//   failed_read_is_hit  new hits appear only because a read failed (`same_as_missing`: and they are what a missing file gives)
//   blind               hits the baseline had are gone and nothing says so (the check went quiet without telling)
//   fails_run           the script threw: the host reports "could not run", which is honest and not a violation
//   unaffected          the answer is the baseline's
// Only `failed_read_is_hit` is the bug class; `blind` is the same lack of a "could not check" and is listed apart.
//
// Read-only on everything it is given: it never opens a Store, never touches a project folder, and runs each guard in a
// fresh temporary workspace seeded from the smoke fixture. `--genomes` is a copy of `<state>.genomes` (genome.json files only).
// Usage: node benchmark/guard-readlimit-scan.mjs [--genomes DIR] [--sdk DIR_OF_project-genome.mjs] [--bytes N]
//          [--all-read-tools] [--json OUT] [--workers N]
//   --genomes   default $RNA_GENOMES, else `${RNA_STATE}.genomes`, else `.state/state.json.genomes` beside this checkout
//   --sdk       the SDK `src` folder whose worker runs the guards (default: this checkout's); point it at an older checkout with
//               `--bytes 64001` to see what the old bound did to the same guards
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const flag = name => process.argv.includes(name);
const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = resolve(arg('--sdk') ?? join(here, '../../../packages/sdk/src'));
const genomesDir = resolve(arg('--genomes') ?? process.env.RNA_GENOMES ?? (process.env.RNA_STATE ? `${process.env.RNA_STATE}.genomes` : join(here, '../.state/state.json.genomes')));
const sdk = await import(pathToFileURL(join(sdkDir, 'project-genome.mjs')).href);
const { runGenomeScript, GENOME_READ_LIMIT_BYTES } = sdk;
const bytes = Number(arg('--bytes') ?? (GENOME_READ_LIMIT_BYTES ? GENOME_READ_LIMIT_BYTES + 1 : 64001));
const workers = Math.max(1, Number(arg('--workers') ?? 4));
const allReadTools = flag('--all-read-tools');

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 10);
const keyOf = hit => `${hit.line ?? ''}\0${hit.excerpt ?? hit.text ?? ''}\0${hit.note ?? ''}`;
const hitsOf = value => (Array.isArray(value?.hits) ? value.hits : []).map(keyOf).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every distinct (project, tool id, script) of every genome version under `dir`, with the versions it appears in. */
async function collect(dir) {
  const found = new Map(); let versions = 0;
  for (const project of (await readdir(dir).catch(() => [])).sort()) {
    for (const version of (await readdir(join(dir, project)).catch(() => [])).sort()) {
      const file = join(dir, project, version, 'genome.json'); if (!existsSync(file)) continue;
      let genome; try { genome = JSON.parse(await readFile(file, 'utf8')); } catch { continue; } versions++;
      for (const tool of genome.tools ?? []) {
        if (tool.permission !== 'read' || (!allReadTools && !String(tool.id).startsWith('guard_'))) continue;
        const key = `${project}\0${tool.id}\0${sha(tool.script)}`, row = found.get(key) ?? { project, tool, versions: [] };
        row.versions.push(version.slice(0, 8)); found.set(key, row);
      }
    }
  }
  return { rows: [...found.values()], versions };
}

async function seed(files) {
  const root = await mkdtemp(join(tmpdir(), 'rna-readlimit-scan-'));
  for (const file of files) { const target = join(root, file.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content); }
  return root;
}
async function runIn(tool, input, files, replace = null) {
  const root = await seed(files.filter(file => file.path !== replace?.path));
  try {
    if (replace?.kind === 'oversize') { const target = join(root, replace.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.alloc(bytes, 0x61)); }
    const out = await runGenomeScript(tool, input, { workspace: root, timeoutMs: 8000 });
    return { ok: true, value: out.value };
  } catch (error) { return { ok: false, error: String(error.message).slice(0, 160) }; }
  finally { await rm(root, { recursive: true, force: true }); }
}
const unreadableFor = (value, path) => (Array.isArray(value?.unchecked) ? value.unchecked : []).some(row => row && typeof row === 'object' && String(row.path ?? '').includes(path));

/** One tool, all its smoke cases and fixture files. */
async function scan({ project, tool, versions }) {
  const cases = [];
  for (const [index, smoke] of (tool.smokeCases ?? []).entries()) {
    const files = smoke.workspace?.files ?? []; if (!files.length) continue;
    const base = await runIn(tool, smoke.input, files);
    const row = { case: index, smoke: !base.ok ? 'error' : same(hitsOf(base.value), hitsOf(smoke.expected)) ? 'same_hits' : 'differs', files: [] };
    if (base.ok) for (const file of files) {
      const [over, gone] = await Promise.all([runIn(tool, smoke.input, files, { path: file.path, kind: 'oversize' }), runIn(tool, smoke.input, files, { path: file.path, kind: 'missing' })]);
      const before = hitsOf(base.value), now = over.ok ? hitsOf(over.value) : null, missing = gone.ok ? hitsOf(gone.value) : null;
      let verdict;
      if (!over.ok) verdict = 'fails_run';
      else if (unreadableFor(over.value, file.path)) verdict = 'reports_unchecked';
      else if (now.some(key => !before.includes(key))) verdict = 'failed_read_is_hit';
      else if (before.some(key => !now.includes(key))) verdict = 'blind';
      else verdict = 'unaffected';
      row.files.push({ path: file.path, isTarget: file.path === smoke.input?.path, verdict, ...(verdict === 'failed_read_is_hit' ? { same_as_missing: gone.ok && same(now, missing), hits: now.filter(key => !before.includes(key)).map(key => key.split('\0').slice(1).join(' | ').slice(0, 140)) } : {}), ...(verdict === 'fails_run' ? { error: over.error } : {}) });
    }
    cases.push(row);
  }
  const verdicts = cases.flatMap(row => row.files.map(file => file.verdict));
  // The bug classes first, then the contract's way, then an honest failure (every guard fails its run when the file it checks cannot be read).
  const worst = ['failed_read_is_hit', 'blind', 'reports_unchecked', 'fails_run', 'unaffected'].find(name => verdicts.includes(name)) ?? 'no_fixture';
  return { project: project.slice(0, 8), tool: tool.id, script: sha(tool.script), versions: versions.length, cases, verdict: worst, smoke: cases.every(row => row.smoke === 'same_hits') ? 'same_hits' : cases.some(row => row.smoke === 'error') ? 'error' : 'differs' };
}

const { rows, versions } = await collect(genomesDir);
console.log(`genomes: ${genomesDir}\nsdk: ${sdkDir}\nunreadable file size: ${bytes} bytes${GENOME_READ_LIMIT_BYTES ? ` (read bound ${GENOME_READ_LIMIT_BYTES})` : ' (this SDK exports no read bound)'}\n${versions} genome versions, ${rows.length} distinct guard scripts${allReadTools ? ' (all read tools)' : ''}`);
const results = []; let next = 0;
await Promise.all(Array.from({ length: workers }, async () => { while (next < rows.length) { const mine = rows[next++]; results.push(await scan(mine)); } }));
results.sort((a, b) => a.project.localeCompare(b.project) || a.tool.localeCompare(b.tool) || a.script.localeCompare(b.script));

const byTool = new Map();
for (const row of results) { const key = `${row.project} ${row.tool}`, entry = byTool.get(key) ?? { scripts: 0, versions: 0, verdicts: {}, smoke: new Set(), bad: [] }; entry.scripts++; entry.versions += row.versions; entry.verdicts[row.verdict] = (entry.verdicts[row.verdict] ?? 0) + 1; entry.smoke.add(row.smoke); if (row.verdict === 'failed_read_is_hit') entry.bad.push(row); byTool.set(key, entry); }
console.log('\nper guard (project, id): distinct scripts / genome versions, verdict counts over scripts, smoke cases still answering as recorded');
for (const [key, entry] of [...byTool].sort()) console.log(`  ${key.padEnd(46)} ${String(entry.scripts).padStart(2)} / ${String(entry.versions).padStart(2)}  ${Object.entries(entry.verdicts).map(([name, count]) => `${name} x${count}`).join(', ').padEnd(40)} smoke: ${[...entry.smoke].join(',')}`);
const bad = results.filter(row => row.verdict === 'failed_read_is_hit');
console.log(`\nturn a failed read into a violation: ${bad.length} of ${results.length} distinct scripts (${new Set(bad.map(row => `${row.project} ${row.tool}`)).size} guard${new Set(bad.map(row => `${row.project} ${row.tool}`)).size === 1 ? '' : 's'})`);
for (const row of bad) for (const caseRow of row.cases) for (const file of caseRow.files.filter(item => item.verdict === 'failed_read_is_hit')) console.log(`  ${row.project} ${row.tool} [${row.script}] case ${caseRow.case} file ${file.path}${file.isTarget ? ' (the file being checked)' : ''}${file.same_as_missing ? ' (the same hits as when it is missing)' : ''}\n    ${file.hits.join('\n    ')}`);
const blind = results.filter(row => row.verdict === 'blind');
console.log(`went quiet without saying so (hits the baseline had are gone): ${blind.length} of ${results.length}`);
const unsmoked = results.filter(row => row.smoke !== 'same_hits');
console.log(`smoke cases that no longer answer as recorded in this SDK: ${unsmoked.length}${unsmoked.length ? ` (${unsmoked.map(row => `${row.project} ${row.tool} [${row.script}] ${row.smoke}`).join('; ')})` : ''}`);
if (arg('--json')) { await writeFile(arg('--json'), JSON.stringify({ at: new Date().toISOString(), genomesDir, sdkDir, bytes, readBound: GENOME_READ_LIMIT_BYTES ?? null, results }, null, 1)); console.log(`wrote ${arg('--json')}`); }
