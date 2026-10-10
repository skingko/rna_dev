import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ensureMind } from '../project-mind.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { DiagnosticsService } from '../diagnostics-service.mjs';
import { ToolPolicy, sweepReport, BASELINE_MAX_BYTES } from '../tool-policy.mjs';
import { guardResult, UNCHECKED_LIMIT, UNCHECKED_TEXT } from '../project-genes.mjs';
import { GENOME_READ_LIMIT_BYTES } from '../../../packages/sdk/src/project-genome.mjs';

// design2 §7 W3 (generated tools: a read failure is not a violation). A check that could not read a file reports it
// apart from its hits (`unchecked`); the host says "Could not check", counts nothing to fix and never continues a run
// for it. The guard scripts here are real (they run in the SDK's restricted worker, reading real files); JEV is absent.
const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const TODAY = '2026-10-05';
// What a check written to the new contract does: a rejected read of the index is told apart by its prefix; only a
// missing index is a finding, and a read it was not allowed to make is returned as unchecked.
const NEW_STYLE = { id: 'index_guard', name: 'Index check', description: 'A note that says [new] needs an entry for today in notes/index.json. Takes {path}.', permission: 'read', parameters,
  script: `const text = await api.readFile(input.path); const hits = [], unchecked = [];
if (/\\[new\\]/.test(text)) {
  let index = null;
  try { index = await api.readFile('notes/index.json'); }
  catch (error) { const reason = String(error.message); if (reason.startsWith('not_found:')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'notes/index.json is missing' }); else unchecked.push({ path: 'notes/index.json', reason }); }
  if (index !== null && !index.includes('${TODAY}')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'the index has no entry for today' });
}
return { hits, unchecked, summary: hits.length + ' found' };` };
// What the project's own guard does (guard_briefing_dedupe): any failed read is "missing".
const CONFLATING = { ...NEW_STYLE, id: 'index_guard',
  script: `const text = await api.readFile(input.path); const hits = [];
if (/\\[new\\]/.test(text)) {
  let index = null;
  try { index = await api.readFile('notes/index.json'); } catch (error) { index = null; }
  if (index === null) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'notes/index.json does not exist or cannot be read' });
  else if (!index.includes('${TODAY}')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'the index has no entry for today' });
}
return { hits, summary: hits.length + ' found' };` };
const GENE_ID = 'guard:index_guard';

function world(t, tool = NEW_STYLE) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-unchecked-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'project'); mkdirSync(join(workspace, 'notes'), { recursive: true });
  const store = new Store(join(dir, 'state', 'state.json'));
  const { project } = store.createProject({ name: 'Notes', workspace, initiative: { enabled: false } });
  store.mutate(state => {
    const row = state.projects.find(item => item.id === project.id); ensureMind(row);
    row.versions = [{ id: 'v1', state: 'active', bundle: { genome: { tools: [tool] } } }]; row.activeVersionId = 'v1';
    row.genes = { genes: [{ id: GENE_ID, layer: 'guard', key: tool.id, title: tool.name, summary: 'Notes that say [new] are in the index.', status: 'active', body: { toolId: tool.id, trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: new Date().toISOString(), history: [] }], generations: [] };
  });
  const genes = new GeneEvolutionService(store, { decisions: {}, enabled: false });
  const diagnostics = new DiagnosticsService({ store, decisions: {} }); t.after(() => diagnostics.close());
  const policy = new ToolPolicy({ decisions: {}, genes, diagnostics });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const gene = () => current().genes.genes.find(row => row.id === GENE_ID);
  const run = (keys = { turnId: 'turn-1' }) => policy.forRun({ projectId: project.id, getProject: current, root: workspace, purpose: 'foreground', request: 'Tidy the notes.', ...keys });
  const tools = name => ({ name, effect: 'write' });
  const write = async (hooks, path, content) => {
    const args = { path, content };
    await hooks.before({ tool: tools('project_write'), args });
    writeFileSync(join(workspace, path), content);
    const after = await hooks.after({ tool: tools('project_write'), args, result: { content: [{ type: 'text', text: `Saved ${path}` }], details: { path: join(workspace, path) } }, isError: false });
    return { after, text: after?.content?.map(block => block.text).join('') ?? '' };
  };
  const index = size => writeFileSync(join(workspace, 'notes', 'index.json'), `{"${TODAY}": "${'x'.repeat(size)}"}`);
  return { dir, workspace, store, project, policy, current, gene, run, write, index };
}
const NOTE = `# Notes ${TODAY}\n\n- A new item [new]\n`;
/** An index of about `bytes` bytes that has an entry for today. */
const sized = bytes => bytes - `{"${TODAY}": ""}`.length;

test('guardResult: unchecked rows are kept apart from the hits, bounded, and absent when the script returned none', () => {
  assert.deepEqual(guardResult({ hits: [], summary: 'ok' }), { hits: [], summary: 'ok' }, 'a result without unchecked keeps its old shape');
  assert.deepEqual(guardResult({ hits: [], summary: 'ok', unchecked: [] }), { hits: [], summary: 'ok' });
  const one = guardResult({ hits: [{ line: 3, excerpt: 'x' }], unchecked: [{ path: 'data/index.json', reason: 'read_limit_exceeded: data/index.json is 2000000 bytes; the limit is 1048576' }] });
  assert.deepEqual(one.unchecked, [{ path: 'data/index.json', reason: 'read_limit_exceeded: data/index.json is 2000000 bytes; the limit is 1048576' }]);
  assert.equal(one.hits.length, 1, 'unchecked rows are not hits');
  const many = guardResult({ hits: [], unchecked: Array.from({ length: 30 }, (_, index) => ({ path: `p${index}.md`, reason: 'r'.repeat(500) })) });
  assert.equal(many.unchecked.length, UNCHECKED_LIMIT); assert.ok(many.unchecked.every(row => row.reason.length <= UNCHECKED_TEXT));
  assert.deepEqual(guardResult({ hits: [], unchecked: ['a.md', null, 7, [], { path: 3 }, {}, { reason: 'why' }] }).unchecked, [{ path: '3', reason: '' }, { path: '', reason: 'why' }], 'only objects with something to say are kept');
  assert.equal(guardResult({ hits: [], unchecked: 'a.md' }).unchecked, undefined, 'a list is required');
});

test('the host\'s baseline bound is never larger than what a generated check can read', () => {
  assert.ok(BASELINE_MAX_BYTES <= GENOME_READ_LIMIT_BYTES, `a baseline of a ${BASELINE_MAX_BYTES} byte file would be taken for a check that reads at most ${GENOME_READ_LIMIT_BYTES}`);
});

test('a write whose check could not read the index reports "Could not check", asks for no fix, and counts it as neither a hit nor a pass', async t => {
  const f = world(t);
  f.index(sized(GENOME_READ_LIMIT_BYTES + 100));
  const result = await f.write(f.run(), 'notes/a.md', NOTE);
  const size = GENOME_READ_LIMIT_BYTES + 100;
  assert.match(result.text, new RegExp(`^\\n\\n\\[Automatic checks\\] Could not check: “Index check” — notes/index\\.json \\(read_limit_exceeded: notes/index\\.json is ${size} bytes; the limit is ${GENOME_READ_LIMIT_BYTES}\\)\\. This is not a finding about the file; do not change the file for it\\.$`));
  assert.doesNotMatch(result.text, /hit|passed|Fix the/, 'nothing to fix, nothing passed');
  assert.deepEqual(result.after.details.guards, [{ gene: GENE_ID, title: 'Index check', hits: 0, unchecked: 1 }]);
  assert.equal(f.gene().hits, 0); assert.equal(f.gene().unchecked, 1, 'counted, so how often a check could not look is known');
});

test('a hit and an unchecked file in one report: the hit is to fix, the unchecked file is not, and "Fix the hits" is about the hit', async t => {
  const f = world(t, { ...NEW_STYLE, id: 'index_guard',
    script: `const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line, note: 'left a TODO' }); });
let unchecked = []; try { await api.readFile('notes/index.json'); } catch (error) { unchecked = [{ path: 'notes/index.json', reason: String(error.message) }]; }
return { hits, unchecked, summary: 'x' };` });
  f.index(sized(GENOME_READ_LIMIT_BYTES + 1));
  const result = await f.write(f.run(), 'notes/a.md', 'TODO one\n');
  assert.match(result.text, /“Index check”: 1 hit to fix\n- line 1: TODO one \(left a TODO\)\nCould not check: “Index check” — notes\/index\.json \(read_limit_exceeded: [^)]*\)\. This is not a finding about the file; do not change the file for it\.\nFix the hits listed above before continuing\.$/);
  assert.deepEqual(result.after.details.guards, [{ gene: GENE_ID, title: 'Index check', hits: 1, unchecked: 1 }]);
});

test('more unchecked files than a report lists are counted, not listed one by one', async t => {
  const f = world(t, { ...NEW_STYLE, id: 'index_guard',
    script: `await api.readFile(input.path); return { hits: [], unchecked: Array.from({ length: 8 }, (_, index) => ({ path: 'notes/big' + index + '.json', reason: 'read_limit_exceeded: too big' })), summary: 'x' };` });
  const result = await f.write(f.run(), 'notes/a.md', 'text\n');
  assert.equal(result.text.match(/Could not check: “Index check” — notes\/big\d\.json/g).length, 5);
  assert.match(result.text, /Could not check: “Index check” — 3 more files, not listed\.$/);
  assert.equal(f.gene().unchecked, 1, 'a run that could not read eight files is one run that could not look: the count is of runs, so runs - unchecked is what looked');
});

test('a direct call of the check\'s tool is a run of it: hits are counted, a run that could not read something is counted as unchecked once, and an error is neither', async t => {
  const f = world(t), hooks = f.run({ turnId: 'turn-9' }), tool = { name: 'gen_0123abcd_index_guard', localId: 'index_guard', effect: 'read' };
  const call = (text, isError = false) => hooks.after({ tool, args: { path: 'notes/a.md' }, result: { content: [{ type: 'text', text }] }, isError });
  const reason = `read_limit_exceeded: notes/index.json is ${GENOME_READ_LIMIT_BYTES + 1} bytes; the limit is ${GENOME_READ_LIMIT_BYTES}`;
  await call(JSON.stringify({ hits: [], unchecked: [{ path: 'notes/index.json', reason }, { path: 'notes/other.json', reason }], summary: '0 found' }));
  assert.deepEqual([f.gene().runs, f.gene().hits, f.gene().unchecked], [1, 0, 1], 'two unreadable files in one run: one run that could not look, no hit');
  await call(JSON.stringify({ hits: [{ line: 1, excerpt: 'TODO' }], unchecked: [{ path: 'notes/index.json', reason }], summary: '1 found' }));
  assert.deepEqual([f.gene().runs, f.gene().hits, f.gene().unchecked], [2, 1, 2]);
  await call(JSON.stringify({ hits: [], summary: '0 found' }));
  assert.deepEqual([f.gene().runs, f.gene().hits, f.gene().unchecked], [3, 1, 2], 'a run that read everything adds none');
  await call('Generated script failed', true);
  assert.deepEqual([f.gene().runs, f.gene().failures, f.gene().unchecked], [4, 1, 2], 'an error is a failure, not an unchecked run');
  await call('not json at all');
  assert.deepEqual([f.gene().runs, f.gene().hits, f.gene().unchecked], [5, 1, 2], 'an answer that is not a result counts as a run and nothing else');
});

test('the index grew past 64,000 bytes: a check that reads it still passes, a missing index is still a hit, and a check that conflates a failed read with "missing" still does above the new bound', async t => {
  const f = world(t, CONFLATING);
  f.index(sized(67561));   // the dedupe index that made the 09:00 run report "missing or unreadable"
  const grown = await f.write(f.run(), 'notes/a.md', NOTE);
  assert.match(grown.text, /^\n\n\[Automatic checks\] 1 check passed\.$/, 'a 67,561 byte index is read: it has today');
  const missing = world(t, CONFLATING);
  assert.match((await missing.write(missing.run(), 'notes/a.md', NOTE)).text, /1 hit to fix\n- line 1: # Notes 2026-10-05 \(notes\/index\.json does not exist or cannot be read\)/, 'a missing index is still found');
  const huge = world(t, CONFLATING); huge.index(sized(GENOME_READ_LIMIT_BYTES + 1));
  assert.match((await huge.write(huge.run(), 'notes/a.md', NOTE)).text, /does not exist or cannot be read/, 'a check written before the contract cannot be repaired by the host: only a regenerated one tells the cases apart');
});

test('sweep: unchecked is reported apart, never makes fix positive, and does not open the continuation', async t => {
  const f = world(t);
  f.index(sized(GENOME_READ_LIMIT_BYTES + 1));
  writeFileSync(join(f.workspace, 'notes', 'a.md'), NOTE);
  const source = async () => ({ paths: ['notes/a.md'], read: async () => null });
  const only = await f.policy.sweep({ projectId: f.project.id, root: f.workspace, turnId: 'turn-1', changes: source });
  assert.deepEqual([only.fix, only.files, only.unresolved, only.text], [0, [], [], null], 'no hit: nothing to fix, nothing open, no continuation text');
  assert.deepEqual(only.unchecked, [{ path: 'notes/a.md', gene: GENE_ID, title: 'Index check', items: [{ path: 'notes/index.json', reason: `read_limit_exceeded: notes/index.json is ${GENOME_READ_LIMIT_BYTES + 1} bytes; the limit is ${GENOME_READ_LIMIT_BYTES}` }] }]);
  assert.equal(f.gene().unchecked, 1);
});

test('sweepReport: unchecked lines come after the hits, once per check and file, and the closing line still speaks of hits only', () => {
  const files = [{ path: 'notes/a.md', checks: [{ gene: GENE_ID, title: 'Index check', hits: [{ line: 2, excerpt: 'TODO' }] }] }];
  const unchecked = [{ path: 'notes/a.md', gene: GENE_ID, title: 'Index check', items: [{ path: 'notes/index.json', reason: 'read_limit_exceeded: too big' }] }, { path: 'notes/b.md', gene: GENE_ID, title: 'Index check', items: [{ path: 'notes/index.json', reason: 'read_limit_exceeded: too big' }] }];
  const text = sweepReport(files, 1, [], unchecked);
  assert.equal(text.match(/Could not check/g).length, 1, 'the same unreadable file, named by the same check, is told once');
  assert.ok(text.indexOf('- line 2: TODO') < text.indexOf('Could not check'));
  assert.match(text, /Could not check: “Index check” — notes\/index\.json \(read_limit_exceeded: too big\)\. This is not a finding about the file; do not change the file for it\.\nFix the hits listed above before finishing\./);
  assert.equal(sweepReport(files, 1), sweepReport(files, 1, [], []), 'without unchecked the report is what it was');
});
