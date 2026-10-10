// D4 scenario (design2 §7 W3, token fixes 2026-10-05): a generated check that could not read a file is not a violation.
// On the AI project the dedupe check read its index with a try/catch that turned any failed read into "missing or
// unreadable"; the index passed 64,000 bytes, the worker refused to read it, and the 09:00 run spent four more requests
// (553,428 tokens, 10.4% of the run) on a finding that was never true. Now:
//  1. a run in its own worktree whose check could not read the index (over the read bound) reports it as "Could not check":
//     the end-of-run pass finds nothing to fix, so the run is not continued, the change set carries no open guard row,
//     and the files still reach the project folder;
//  2. the same pass with a real hit and an unreadable file: the one continuation carries the hit and, apart, the
//     "Could not check" line; the hit is fixed in it; the unreadable file never opens a second continuation;
//  3. a file-write tool's own result carries the line, with nothing to fix, and no pass or continuation follows;
//  4. the index that grew past 64,000 bytes (the incident, 70,000 here) is read: the check passes; a missing index is still found.
// Crosses the SDK's restricted worker (its read errors), the gene store, ToolPolicy's write hook and end-of-run pass, the
// controllers' finish steps, git isolation and the run's change set. Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';
import { GENOME_READ_LIMIT_BYTES } from '../../../../packages/sdk/src/project-genome.mjs';

const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const TODAY = '2026-10-05', TITLE = 'Index check';
// Written to the new contract: a rejected read of the index is told apart by its prefix; only a missing index is a finding.
const INDEX_TOOL = { id: 'index_guard', name: TITLE, description: 'A note that says [new] needs an entry for today in notes/index.json; flags TODO lines. Takes {path}.', permission: 'read', parameters,
  script: `const text = await api.readFile(input.path); const hits = [], unchecked = [];
text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'left a TODO' }); });
if (/\\[new\\]/.test(text)) {
  let index = null;
  try { index = await api.readFile('notes/index.json'); }
  catch (error) { const reason = String(error.message); if (reason.startsWith('not_found:')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'notes/index.json is missing' }); else unchecked.push({ path: 'notes/index.json', reason }); }
  if (index !== null && !index.includes('${TODAY}')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'the index has no entry for today' });
}
return { hits, unchecked, summary: hits.length + ' found' };`,
  smokeCases: [{ input: { path: 'notes/s.md' }, expected: { hits: [], unchecked: [], summary: '0 found' }, workspace: { files: [{ path: 'notes/s.md', content: 'plain\n' }] } }] };
// What the project's own guard does (guard_briefing_dedupe): any failed read of the index is "missing".
const CONFLATING_TOOL = { ...INDEX_TOOL, script: `const text = await api.readFile(input.path); const hits = [];
if (/\\[new\\]/.test(text)) {
  let index = null;
  try { index = await api.readFile('notes/index.json'); } catch (error) { index = null; }
  if (index === null) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'notes/index.json does not exist or cannot be read' });
  else if (!index.includes('${TODAY}')) hits.push({ line: 1, excerpt: text.split('\\n')[0].slice(0, 160), note: 'the index has no entry for today' });
}
return { hits, summary: hits.length + ' found' };`,
  smokeCases: [{ input: { path: 'notes/s.md' }, expected: { hits: [], summary: '0 found' }, workspace: { files: [{ path: 'notes/s.md', content: 'plain\n' }] } }] };
const GENE_ID = 'guard:index_guard';
const skip = gitReady ? false : 'git 2.38 or later is needed';
/** An index file of exactly `bytes` bytes with an entry for today. */
const indexOf = bytes => { const frame = `{"${TODAY}": ""}`; return `{"${TODAY}": "${'x'.repeat(bytes - frame.length)}"}`; };
const OVER = indexOf(GENOME_READ_LIMIT_BYTES + 1), GROWN = indexOf(70000);

async function installGuard(world, tool) {
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome: { ...GENOME, tools: [tool] } }); await prepared.commit();
  world.store.mutate(state => {
    const target = state.projects.find(row => row.id === world.projectId), at = new Date().toISOString();
    target.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: 'baseline', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    target.activeVersionId = prepared.record.versionId;
    target.genes = { genes: [{ id: `guard:${tool.id}`, layer: 'guard', key: tool.id, title: tool.name, summary: tool.description, status: 'active', level: 0, body: { toolId: tool.id, trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: at, updatedAt: at, history: [] }], generations: [] };
  });
}
const gene = world => world.project().genes.genes.find(row => row.id === GENE_ID);
/** Spies on the end-of-run pass: what each pass answered, in order. */
function spy(world, t) {
  const sweeps = [], policy = world.app.executor.toolPolicy, original = policy.sweep;
  policy.sweep = async function wrapped(...args) { const result = await original.apply(this, args); sweeps.push(result); return result; };
  t.after(() => { policy.sweep = original; });
  return { sweeps };
}
const foreground = rows => rows.filter(row => row.tag === 'foreground');
const guardFeedback = row => (row.request.messages ?? []).filter(item => item.source === 'finish-feedback' && JSON.stringify(item.content).includes('host-guard-pass'));
const feedbackText = row => guardFeedback(row).at(-1)?.content.map(part => part.text ?? '').join('\n') ?? '';
const UNREADABLE = `Could not check: “${TITLE}” — notes/index.json (read_limit_exceeded: notes/index.json is ${GENOME_READ_LIMIT_BYTES + 1} bytes; the limit is ${GENOME_READ_LIMIT_BYTES}). This is not a finding about the file; do not change the file for it.`;

test('a run in its own worktree whose check could not read the index is not continued: nothing to fix, no open guard row, and its files still reach the project folder', { skip }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/a.md': 'Intro\n', 'notes/index.json': OVER, '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, INDEX_TOOL);
  const { sweeps } = spy(world, t);
  const run = await s.backgroundRun({ task: 'Write notes/b.md with the shell.', work: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/b.md\n# Notes\n- A new item [new]\nEOF\n" } }] },
    'Wrote notes/b.md.\nHandoff: notes/b.md was written; nothing left to do.',
  ] });
  await run.expect({
    files: { 'notes/b.md': '# Notes\n- A new item [new]\n' },
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.equal(work.length, 2, 'the run and its reply: the unreadable index asked for no continuation');
      assert.deepEqual(work.map(row => guardFeedback(row).length), [0, 0], 'nothing of the guard pass reached the model');
    },
    state: () => {
      assert.equal(run.outcome.change?.guard, undefined, 'no open guard row on the change set: the unreadable index is not a hit left unfixed');
      assert.deepEqual(gene(world).turns ?? [], [], 'a background run charges no turn');
      assert.equal(gene(world).unchecked, 1, 'counted: how often a check could not look is known'); assert.equal(gene(world).hits, 0);
    },
  });
  assert.equal(sweeps.length, 1);
  assert.deepEqual([sweeps[0].fix, sweeps[0].files.length, sweeps[0].text], [0, 0, null], 'the pass found nothing to fix');
  assert.deepEqual(sweeps[0].unchecked.map(row => [row.path, row.items.map(item => item.path)]), [['notes/b.md', ['notes/index.json']]], 'and said what it could not read');
  assert.match(sweeps[0].unchecked[0].items[0].reason, /^read_limit_exceeded: notes\/index\.json is \d+ bytes; the limit is \d+$/);
});

test('a real hit and an unreadable file in one pass: the one continuation carries both, apart; the hit is fixed; the unreadable file opens no second one', { skip }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/a.md': 'Intro\n', 'notes/index.json': OVER, '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, INDEX_TOOL);
  const { sweeps } = spy(world, t);
  const run = await s.backgroundRun({ task: 'Write notes/c.md with the shell.', work: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/c.md\n# Notes\n- A new item [new]\nTODO left behind\nEOF\n" } }] },
    'Wrote notes/c.md.\nHandoff: notes/c.md was written; nothing left to do.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf '# Notes\\n- A new item [new]\\nDone\\n' > notes/c.md" } }] },
    'Fixed notes/c.md.\nHandoff: notes/c.md was written and checked; nothing left to do.',
  ] });
  await run.expect({
    files: { 'notes/c.md': '# Notes\n- A new item [new]\nDone\n' },
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.equal(work.length, 4, 'the run, then its one continuation, and no second one');
      const feedback = feedbackText(work[2]);
      assert.match(feedback, /notes\/c\.md\\n“Index check”: 1 hit to fix\\n- line 3: TODO left behind \(left a TODO\)/, 'the hit, to fix');
      assert.ok(feedback.includes(UNREADABLE), 'the unreadable index, as what it is');
      assert.ok(feedback.indexOf('line 3: TODO left behind') < feedback.indexOf('Could not check'), 'after the hits, not among them');
      assert.match(feedback, /Fix the hits listed above before finishing\./);
      assert.equal(guardFeedback(work[3]).length, 1, 'the continuation is still the only one');
    },
    state: () => { assert.equal(run.outcome.change?.guard, undefined, 'the hit was fixed; the unreadable index is no open row'); assert.equal(gene(world).hits, 1); assert.equal(gene(world).unchecked, 2, 'twice unreadable: before the fix and after it'); },
  });
  assert.deepEqual(sweeps.map(row => [row.fix, row.unchecked.length, row.text === null]), [[1, 1, false], [0, 1, true]], 'the second pass has only the unreadable index: nothing to fix, so nothing to continue');
});

test('a file-write tool\'s own result says "Could not check" with nothing to fix, and no pass or continuation follows', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', 'notes/index.json': OVER, '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, INDEX_TOOL);
  const { sweeps } = spy(world, t);
  // The model reads the note back, so the delivery review has nothing to add either (as in guard-pass-exec-write).
  const step = await s.send('Write a note.', { reply: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/w.md', content: '# Notes\n- A new item [new]\n' } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'notes/w.md' } }] },
    'Wrote the note.',
  ] });
  await step.expect({
    files: { 'notes/w.md': '# Notes\n- A new item [new]\n' },
    requests: rows => {
      const model = foreground(rows); assert.equal(model.length, 3, 'the write, the read-back, the reply: nothing was asked of the model');
      assert.ok(model[1].wire.includes(UNREADABLE), 'the write\'s result carried the line');
      assert.doesNotMatch(model[1].wire, /hit to fix|Fix the hits|1 check passed/, 'no violation, no pass');
      assert.deepEqual(model.map(row => guardFeedback(row).length), [0, 0, 0]);
    },
    state: () => { const turn = world.session().turns.find(row => row.id === step.outcome.turnId); assert.equal(turn.status, 'completed'); assert.equal(turn.guardPass, undefined, 'no pass row: nothing was left open'); assert.equal(gene(world).unchecked, 1); assert.equal(gene(world).hits, 0); },
  });
  assert.equal(sweeps.length, 0, 'a file tool\'s write was checked as it happened; no command ran, so the end-of-run pass never started');
});

test('the index that grew past 64,000 bytes is read and the check passes; a missing index is still found (a check that was written before the contract stays as it was)', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', 'notes/index.json': GROWN, '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, CONFLATING_TOOL);
  const grown = await s.send('Write a note.', { reply: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/w.md', content: '# Notes\n- A new item [new]\n' } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'notes/w.md' } }] },
    'Wrote the note.',
  ] });
  await grown.expect({ requests: rows => { const model = foreground(rows); assert.equal(model.length, 3); assert.match(model[1].wire, /\[Automatic checks\] 1 check passed\./); assert.doesNotMatch(model[1].wire, /does not exist or cannot be read|Fix the hits/); }, state: () => { assert.equal(gene(world).hits ?? 0, 0); assert.equal(gene(world).unchecked, undefined); } });
  // The index really is missing: the check says so, as before.
  const removed = await s.send('Remove the index and write another note.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: 'rm notes/index.json' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/x.md', content: '# Notes\n- Another new item [new]\n' } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'notes/x.md' } }] },
    'Wrote the second note.',
  ] });
  await removed.expect({ requests: rows => assert.match(foreground(rows)[2].wire, /“Index check”: 1 hit to fix\\n- line 1: # Notes \(notes\/index\.json does not exist or cannot be read\)/, 'a missing index is a finding, as it always was') });
});
