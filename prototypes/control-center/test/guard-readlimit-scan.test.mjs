import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// benchmark/guard-readlimit-scan.mjs on a genome folder of known guards: each kind of answer to an unreadable file is
// told apart (the check says so, it calls it a violation, it goes quiet, it fails) and the smoke cases still answer as recorded.
const run = promisify(execFile), scan = fileURLToPath(new URL('../benchmark/guard-readlimit-scan.mjs', import.meta.url));
const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const workspace = { files: [{ path: 'notes/a.md', content: '[new] item\nTODO\n' }, { path: 'notes/index.json', content: '{"ok":true}' }] };
const tool = (id, script, expectedHits) => ({ id, name: id, description: `${id}. Takes {path}.`, permission: 'read', parameters, script,
  smokeCases: [{ input: { path: 'notes/a.md' }, expected: { hits: expectedHits, summary: '' }, workspace }] });
const HIT = { line: 2, excerpt: 'TODO', note: 'left a TODO' };
const TODO = "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, i) => { if (/TODO/.test(line)) hits.push({ line: i + 1, excerpt: line, note: 'left a TODO' }); });";
const INDEX = "let index = null, reason = null; try { index = await api.readFile('notes/index.json'); } catch (error) { reason = String(error.message); }";
const tools = [
  // The contract's way: a rejected read of the index goes to unchecked, a missing one is a finding.
  tool('guard_new_style', `${TODO} ${INDEX} const unchecked = []; if (reason && !reason.startsWith('not_found:')) unchecked.push({ path: 'notes/index.json', reason }); return { hits, unchecked, summary: '' };`, [HIT]),
  // The bug class: any failed read of the index is "missing".
  tool('guard_conflating', `${TODO} ${INDEX} if (index === null) hits.push({ line: 1, excerpt: 'index', note: 'index missing or unreadable' }); return { hits, summary: '' };`, [HIT]),
  // Goes quiet: with the index unreadable it drops the TODO finding and says nothing.
  tool('guard_blind', `${TODO} ${INDEX} return { hits: index === null ? [] : hits, summary: '' };`, [HIT]),
  // Reads only the file it checks: an unreadable file fails the run, which the host reports as "could not run".
  tool('guard_target_only', `${TODO} return { hits, summary: '' };`, [HIT]),
];

test('the scan tells apart a check that says it could not read, one that calls it a violation, one that goes quiet and one that fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-scan-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'genomes', 'p1', 'v1'), { recursive: true }); await mkdir(join(dir, 'genomes', 'p1', 'v2'), { recursive: true });
  await writeFile(join(dir, 'genomes', 'p1', 'v1', 'genome.json'), JSON.stringify({ tools }));
  // The same scripts in a later version, and a read tool that is no guard: neither adds a distinct guard script.
  await writeFile(join(dir, 'genomes', 'p1', 'v2', 'genome.json'), JSON.stringify({ tools: [...tools, { ...tool('plain_reader', 'return {};', []) }] }));
  const out = join(dir, 'scan.json');
  const { stdout } = await run(process.execPath, [scan, '--genomes', join(dir, 'genomes'), '--json', out], { maxBuffer: 1 << 24, timeout: 120000 });
  const result = JSON.parse(await readFile(out, 'utf8')), byTool = Object.fromEntries(result.results.map(row => [row.tool, row]));
  assert.equal(result.results.length, 4, 'four distinct guard scripts; the second version repeats them and plain_reader is not a guard');
  assert.deepEqual(Object.fromEntries(Object.entries(byTool).map(([id, row]) => [id, row.verdict])), { guard_new_style: 'reports_unchecked', guard_conflating: 'failed_read_is_hit', guard_blind: 'blind', guard_target_only: 'fails_run' });
  assert.ok(Object.values(byTool).every(row => row.smoke === 'same_hits' && row.versions === 2), 'each guard still answers its smoke case as recorded, in both versions');
  const bad = byTool.guard_conflating.cases[0].files.find(file => file.verdict === 'failed_read_is_hit');
  assert.equal(bad.path, 'notes/index.json'); assert.equal(bad.same_as_missing, true, 'what it says of an unreadable index is what it says of a missing one');
  assert.match(stdout, /turn a failed read into a violation: 1 of 4 distinct scripts \(1 guard\)/);
  assert.match(stdout, /went quiet without saying so \(hits the baseline had are gone\): 1 of 4/);
  assert.match(stdout, /smoke cases that no longer answer as recorded in this SDK: 0/);
  assert.equal(result.readBound, 1048576); assert.equal(result.bytes, 1048577, 'the unreadable file is one byte over the worker\'s read bound');
});
