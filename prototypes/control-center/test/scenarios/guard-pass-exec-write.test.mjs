// D4 scenario (plan C1): the guard pass at the end of a run. A write made through project_exec (a shell heredoc) passes
// no per-tool hook, so on the novel project 118 chapter writes were never checked by a guard. The turn's net changes are
// checked once more before the turn is judged settled and before a worktree reaches the project folder:
//  1. a direct-mode turn writes a note through a shell heredoc: the guard's new hit (not the one the file already had)
//     is handed back as one continuation, the model fixes the file, and the pass ran before turn.settled;
//  2. with that one continuation spent the hit stays: it is written on the turn row and the timeline says so;
//  3. a worker's merged file, already checked in the worker's own root, is not checked again; the worker's first request
//     carries the same standing-rules block as its parent's;
//  4. a background run in its own worktree: the pass ran before B was applied to the project folder;
//  5. a conversation's worktree: the pass ran before the apply, and the hit was fixed in the worktree;
//  6. a guard that reads another file (a rules file) gets its baseline in the folder as the turn found it: a new hit is
//     delivered, the one the file already had is only counted;
//  7. the user steers while the pass runs: the SDK drops the finding, and that must not use the turn's one continuation up.
// Crosses the SDK session's finish hook, the controllers' finish steps, ToolPolicy, turn checkpoints, git isolation,
// the gene store and JEV. Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { createMindEntry } from '../../project-mind.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const GUARD_TOOL = { id: 'todo_guard', name: 'TODO check', description: 'Flags lines that still say TODO. Takes {path}.', permission: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  script: "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'left a TODO' }); }); return { hits, summary: hits.length + ' found' };",
  smokeCases: [{ input: { path: 'sample.md' }, expected: { hits: [{ line: 1, excerpt: 'TODO here', note: 'left a TODO' }], summary: '1 found' }, workspace: { files: [{ path: 'sample.md', content: 'TODO here\n' }] } }] };
// A guard that reads another file than the one written: the words notes/rules.md bans.
const RULES_TOOL = { id: 'banned_words', name: 'Banned words', description: 'Flags words that notes/rules.md bans. Takes {path}.', permission: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  script: "const rules = (await api.readFile('notes/rules.md')).split('\\n').filter(Boolean); const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { for (const word of rules) if (line.includes(word)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'banned ' + word }); }); return { hits, summary: hits.length + ' found' };",
  smokeCases: [{ input: { path: 'notes/sample.md' }, expected: { hits: [{ line: 1, excerpt: 'a forbidden word', note: 'banned forbidden' }], summary: '1 found' }, workspace: { files: [{ path: 'notes/rules.md', content: 'forbidden\n' }, { path: 'notes/sample.md', content: 'a forbidden word\n' }] } }] };
const GENE_ID = 'guard:todo_guard', RULES_GENE_ID = 'guard:banned_words', RULE = 'Always answer the user in short sentences.';
const skip = gitReady ? false : 'git 2.38 or later is needed';

/** An in-force guard on notes/**: a real, verified genome bundle with the guard's script as the active version, and the gene. */
async function installGuard(world, { rule = false, tool = GUARD_TOOL } = {}) {
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome: { ...GENOME, tools: [tool] } }); await prepared.commit();
  world.store.mutate(state => {
    const target = state.projects.find(row => row.id === world.projectId), at = new Date().toISOString();
    target.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: 'baseline', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    target.activeVersionId = prepared.record.versionId;
    target.genes = { genes: [{ id: `guard:${tool.id}`, layer: 'guard', key: tool.id, title: tool.name, summary: tool.description, status: 'active', level: 0, body: { toolId: tool.id, trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: at, updatedAt: at, history: [] }], generations: [] };
    if (rule) createMindEntry(target, 'lessons', { text: RULE, kind: 'preference', scope: 'user' });
  });
}
const gene = world => world.project().genes.genes.find(row => row.id === GENE_ID);
/**
 * Spies on the host's end-of-run steps, in the order they happen. `order` rows: 'sweep' | 'sweep+fix' (it delivered a
 * hit) | 'settled' (turn.settled) | 'apply' (a worktree's apply at the turn's end) | 'merge' (a background run's B → P).
 * `onSweep` runs as a pass begins.
 */
function spy(world, t, { onSweep } = {}) {
  const order = [], sweeps = [], policy = world.app.executor.toolPolicy, decisions = world.app.executor.decisions, restore = [];
  const wrap = (target, name, before, after) => { const original = target[name]; target[name] = async function wrapped(...args) { await before?.(...args); const result = await original.apply(this, args); after?.(result, ...args); return result; }; restore.push(() => { target[name] = original; }); };
  wrap(policy, 'sweep', () => onSweep?.(), result => { sweeps.push(result); order.push(result?.fix ? 'sweep+fix' : 'sweep'); });
  wrap(decisions, 'settled', () => order.push('settled'));
  if (world.app.sessionWorktrees) wrap(world.app.sessionWorktrees, 'applyAtFinish', () => order.push('apply'));
  const background = world.app.projectInitiative?.background;
  if (background) wrap(background, 'finish', () => order.push('merge'));
  t.after(() => { for (const undo of restore.reverse()) undo(); });
  return { order, sweeps };
}
const turnRow = (world, turnId, sessionId = world.sessionId) => world.session(sessionId).turns.find(row => row.id === turnId);
/** The text of the host's finish feedback in a model request (the last finish-feedback message), '' when there is none. */
const feedbackOf = row => { const message = (row.request.messages ?? []).findLast(item => item.source === 'finish-feedback'); return message ? message.content.map(part => part.text ?? '').join('\n') : ''; };
/** The standing-rules block a foreground request carries (a keyed context message), or null. */
const rulesIn = row => {
  const keyed = (row.request.messages ?? []).findLast(item => item.contextKey === 'project-mind-rules');
  if (!keyed) return null;
  const text = keyed.content.map(part => part.text ?? '').join('');
  return JSON.parse(text.slice(text.indexOf('[{'))).find(item => item.source === 'host-project-mind').text;
};

test('a shell heredoc write is checked at the turn\'s end, before the turn is judged settled: the new hit continues the turn once, the old one is only counted', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\nTODO old one\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const { order, sweeps } = spy(world, t);
  const step = await s.send('Write notes with the shell.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Intro\\nTODO old one\\nMore\\nTODO from a shell\\n' > notes/a.md && cat <<'EOF' > notes/b.md\nTODO in a new file\nEOF\n" } }] },
    'Wrote the notes.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Intro\\nTODO old one\\nMore\\nDone\\n' > notes/a.md && printf 'A new file\\n' > notes/b.md" } }] },
    'Fixed the notes.',
  ] });
  await step.expect({
    files: { 'notes/a.md': 'Intro\nTODO old one\nMore\nDone\n', 'notes/b.md': 'A new file\n' },
    requests: rows => {
      const model = rows.filter(row => row.tag === 'foreground');
      assert.equal(model.length, 4, 'one tool round, the reply, one continuation (a tool round and its reply)');
      const feedback = feedbackOf(model[2]);
      assert.match(feedback, /host-guard-pass/); assert.match(feedback, /\[Automatic checks\] 2 files changed in this run by a shell command/);
      assert.match(feedback, /notes\/a\.md\\n“TODO check”: 1 hit to fix\\n- line 4: TODO from a shell \(left a TODO\)\\nnotes\/b\.md\\n“TODO check”: 1 hit to fix\\n- line 1: TODO in a new file/, 'the new hits, with their lines');
      assert.doesNotMatch(feedback, /TODO old one/, 'the hit the file already had before the turn is not handed over');
    },
    state: () => {
      const turn = turnRow(world, step.outcome.turnId);
      assert.equal(turn.status, 'completed');
      assert.deepEqual([turn.guardPass.continued, turn.guardPass.files, turn.guardPass.hits, turn.guardPass.open], [true, 2, 2, []], 'one continuation, and nothing left once the files were fixed');
      assert.equal(gene(world).runs, 4, 'two files checked, then the two fixed files checked again (a changed text is checked again)'); assert.deepEqual(gene(world).turns, [step.outcome.turnId]);
      assert.ok(!world.session().items.some(row => row.kind === 'notice' && row.source === 'guard-pass'), 'nothing to tell the user: it was fixed');
    },
  });
  assert.deepEqual(order, ['sweep+fix', 'sweep', 'settled'], 'the pass ran before the turn was judged settled, and again after the continuation');
  assert.deepEqual(sweeps.map(row => [row.checked, row.already, row.fix]), [[2, 0, 2], [2, 0, 0]]);
});

test('the pass costs nothing when no guard watches writes: a shell write is nobody\'s to check, and the change source is never asked', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  let asked = 0; const progress = world.app.checkpoints.progress.bind(world.app.checkpoints);
  world.app.checkpoints.progress = (...args) => { asked++; return progress(...args); };
  t.after(() => { world.app.checkpoints.progress = progress; });
  const plain = await scenario(world).send('Write a note with the shell.', { reply: [{ toolCalls: [{ name: 'project_exec', args: { command: "printf 'TODO nobody watches\\n' > notes/a.md" } }] }, 'Wrote the note.'] });
  assert.equal(asked, 0, 'no guard: the pass did not even look at what the turn changed'); assert.equal(turnRow(world, plain.outcome.turnId).guardPass, undefined);
  assert.equal(world.faux.of('foreground').length, 2);
});

test('the pass has nothing to add where every write was checked as it happened: file tools only, or a file a write hook checked before a command ran', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const { sweeps } = spy(world, t);
  // A write tool's own result carries the check; the model then reads the file back, so the delivery review has nothing to add either.
  const guardRounds = rows => rows.filter(row => row.tag === 'foreground' && (row.request.messages ?? []).some(message => message.source === 'finish-feedback' && JSON.stringify(message.content).includes('host-guard-pass'))).length;
  const written = await s.send('Write a note.', { reply: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/w.md', content: 'TODO from a write tool\n' } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'notes/w.md' } }] },
    'Wrote the note, with a TODO.',
  ] });
  await written.expect({ requests: rows => { assert.equal(rows.filter(row => row.tag === 'foreground').length, 3, 'no continuation'); assert.match(rows.filter(row => row.tag === 'foreground')[1].wire, /\[Automatic checks\] “TODO check”: 1 hit to fix/, 'the write\'s own result carried the check'); }, state: () => assert.equal(gene(world).runs, 1) });
  assert.equal(sweeps.length, 0, 'no command, generated or MCP tool ran: the pass was skipped');

  // The same write followed by a command (it can write unseen, so the pass runs) that does not: the file is already checked.
  const mixed = await s.send('Write another note and list the folder.', { reply: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/x.md', content: 'TODO from a write tool again\n' } }] },
    { toolCalls: [{ name: 'project_exec', args: { command: 'ls notes' } }] },
    'Wrote it and listed the folder.',
  ] });
  await mixed.expect({ requests: rows => assert.equal(guardRounds(rows), 0, 'the pass gave no continuation'), state: () => assert.equal(gene(world).runs, 2, 'the pass did not run the guard on the file again') });
  assert.deepEqual(sweeps.map(row => [row.checked, row.already, row.fix]), [[0, 1, 0]]);
});

test('with its one continuation spent a hit stays: it is written on the turn row, and the timeline says so once', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  world.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  const { order } = spy(world, t);
  const step = await s.send('Write a note with the shell.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/c.md\nTODO left behind\nEOF\n" } }] },
    'Wrote the note.',
    'I will leave it as it is.',
  ] });
  await step.expect({
    files: { 'notes/c.md': 'TODO left behind\n' },
    requests: rows => { const model = rows.filter(row => row.tag === 'foreground'); assert.equal(model.length, 3, 'one continuation only'); assert.match(feedbackOf(model[2]), /line 1: TODO left behind/); },
    state: () => {
      const turn = turnRow(world, step.outcome.turnId);
      assert.equal(turn.status, 'completed', 'the guard never fails a turn');
      assert.equal(turn.guardPass.continued, true); assert.deepEqual(turn.guardPass.open, [{ path: 'notes/c.md', gene: GENE_ID, title: 'TODO check', hits: 1 }]);
      const notices = world.session().items.filter(row => row.kind === 'notice' && row.source === 'guard-pass');
      assert.deepEqual(notices.map(row => row.text), ['1 hit from “TODO check” was left unfixed in the files this turn changed: notes/c.md.']);
    },
  });
  assert.deepEqual(order, ['sweep+fix', 'sweep', 'settled']);
});

test('a worker\'s merged file is checked once, in the worker\'s own root; the worker\'s first request carries the parent\'s standing rules, byte for byte', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, { rule: true });
  const { sweeps } = spy(world, t);
  world.faux.script('http', { toolCalls: [{ name: 'project_write', args: { path: 'notes/c.md', content: 'TODO from a worker\n' } }] }, 'Wrote notes/c.md.');
  const step = await s.send('Have a worker write notes/c.md, then add notes/d.md yourself.', { reply: [
    { toolCalls: [{ name: 'agent_delegate', args: { task: 'Write notes/c.md.', files: ['notes/c.md'], wait: true } }] },
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/d.md\nTODO from the turn\nEOF\n" } }] },
    'Both notes are written.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Done\\n' > notes/d.md" } }] },
    'Fixed notes/d.md.',
  ] });
  await step.expect({
    files: { 'notes/c.md': 'TODO from a worker\n', 'notes/d.md': 'Done\n' },
    requests: rows => {
      const parent = rows.filter(row => row.tag === 'foreground'), child = rows.filter(row => row.tag === 'http');
      const feedback = feedbackOf(parent[3]);
      assert.match(feedback, /notes\/d\.md\\n“TODO check”: 1 hit to fix\\n- line 1: TODO from the turn/);
      assert.doesNotMatch(feedback, /notes\/c\.md|TODO from a worker/, 'the worker\'s file was checked in its own root: not again');
      // MIND-6 for a child: the standing rules, once, on its first request, as the parent carries them.
      const block = rulesIn(parent[0]); assert.ok(block, 'the parent carries the standing-rules block'); assert.match(block, new RegExp(RULE));
      // In the worker's request the block is part of a context message, as the string the parent's block is (the OpenAI wire).
      const mark = JSON.stringify(block), textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
      const holds = row => row.request.messages.filter(message => textOf(message).includes(mark));
      assert.equal(holds(child[0]).length, 1, 'the worker\'s first request carries the block, byte for byte');
      assert.deepEqual(child.map(row => holds(row).length), child.map(() => 1), 'once: it stays in the worker\'s history, and no later request adds it again');
    },
    state: () => assert.equal(gene(world).runs, 3, 'the worker\'s write, then notes/d.md, then notes/d.md fixed; notes/c.md was not checked a second time'),
  });
  assert.deepEqual(sweeps.map(row => [row.checked, row.already, row.fix]), [[1, 1, 1], [1, 1, 0]], 'the merged file was skipped by its (guard, path, text), both times; the turn\'s own file was checked, then checked again once fixed');
});

test('a background run in its own worktree is checked before its changes reach the project folder; a hit left in it goes on the change set\'s line', { skip }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const { order, sweeps } = spy(world, t);
  const fixed = await s.backgroundRun({ task: 'Write notes/b.md with the shell.', work: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/b.md\nTODO from the background\nEOF\n" } }] },
    'Wrote notes/b.md.\nHandoff: notes/b.md was written; nothing left to do.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Done\\n' > notes/b.md" } }] },
    'Fixed notes/b.md.\nHandoff: notes/b.md was written and checked; nothing left to do.',
  ] });
  await fixed.expect({
    files: { 'notes/b.md': 'Done\n' },
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.equal(work.length, 4, 'the run, then its one continuation');
      assert.match(feedbackOf(work[2]), /\[Automatic checks\] 1 file changed in this run by a shell command[^]*notes\/b\.md\\n“TODO check”: 1 hit to fix\\n- line 1: TODO from the background/);
    },
    state: () => { assert.equal(gene(world).runs, 2, 'checked in B, then the fixed file checked again'); assert.deepEqual(gene(world).turns ?? [], [], 'a background run charges no turn'); assert.equal(fixed.outcome.change?.guard, undefined, 'nothing left unfixed'); },
  });
  assert.ok(order.indexOf('sweep+fix') >= 0 && order.indexOf('sweep+fix') < order.indexOf('merge'), `the pass ran before B was merged into the project folder (${order.join(',')})`);
  assert.equal(sweeps[0].fix, 1);

  // A run that leaves the hit: its one continuation is spent, the change set says so on its row and its line.
  const left = await s.backgroundRun({ task: 'Write notes/c.md with the shell.', work: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/c.md\nTODO left behind\nEOF\n" } }] },
    'Wrote notes/c.md.\nHandoff: notes/c.md was written; nothing left to do.',
    'Leaving it.\nHandoff: notes/c.md was written with a TODO in it.',
  ] });
  await left.expect({
    files: { 'notes/c.md': 'TODO left behind\n' },
    state: () => {
      const change = left.outcome.change; assert.ok(change, 'the change set was recorded');
      assert.deepEqual(change.guard, { open: [{ path: 'notes/c.md', gene: GENE_ID, title: 'TODO check', hits: 1 }], continued: true });
      const line = world.session().items.find(row => row.initiative?.backgroundChange === change.id);
      assert.match(line?.text ?? '', /这次后台工作改的文件里，「TODO check」还有 1 处命中没有处理：notes\/c\.md。/);
    },
  });
});

test('a conversation\'s worktree is checked before its changes are applied to the project folder, and the hit is fixed in the worktree', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const inProject = [];
  const { order, sweeps } = spy(world, t, { onSweep: () => inProject.push(world.file('notes/s.md')) });
  const session = world.store.createSession({ projectId: world.projectId, title: 'Worktree conversation', worktree: true });
  const step = await s.send('Write a note with the shell.', { sessionId: session.id, reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/s.md\nTODO in the worktree\nEOF\n" } }] },
    'Wrote the note.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Done\\n' > notes/s.md" } }] },
    'Fixed the note.',
  ] });
  await step.expect({
    files: { 'notes/s.md': 'Done\n' },
    requests: rows => assert.match(feedbackOf(rows.filter(row => row.tag === 'foreground')[2]), /notes\/s\.md\\n“TODO check”: 1 hit to fix\\n- line 1: TODO in the worktree/),
    state: () => assert.equal(turnRow(world, step.outcome.turnId, session.id).apply.status, 'applied'),
  });
  assert.deepEqual(inProject, [null, null], 'the project folder had no such file while the pass ran: it checked the worktree, and the fix landed there');
  assert.deepEqual(order, ['sweep+fix', 'sweep', 'settled', 'apply'], 'the pass ran before the turn was judged settled and before the apply');
  assert.equal(sweeps[0].fix, 1);
});

test('a guard that reads a rules file gets its baseline in the folder as the turn found it: a new hit is delivered, the one the file already had is only counted', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/rules.md': 'forbidden\n', 'notes/a.md': 'Intro\nforbidden before\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, { tool: RULES_TOOL });
  const { sweeps } = spy(world, t);
  const step = await s.send('Extend the notes with the shell.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Intro\\nforbidden before\\nMore\\na forbidden word, new\\n' > notes/a.md" } }] },
    'Extended the notes.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Intro\\nforbidden before\\nMore\\nDone\\n' > notes/a.md" } }] },
    'Fixed the notes.',
  ] });
  await step.expect({
    files: { 'notes/a.md': 'Intro\nforbidden before\nMore\nDone\n' },
    requests: rows => {
      const model = rows.filter(row => row.tag === 'foreground'); assert.equal(model.length, 4, 'one continuation');
      const feedback = feedbackOf(model[2]);
      assert.match(feedback, /notes\/a\.md\\n“Banned words”: 1 hit to fix\\n- line 4: a forbidden word, new \(banned forbidden\)/, 'the new hit, with its line');
      assert.doesNotMatch(feedback, /forbidden before/, 'the hit the file had before the turn is not handed over (it was found by reading the rules file as the turn found it)');
    },
    state: () => { const turn = turnRow(world, step.outcome.turnId); assert.deepEqual([turn.guardPass.continued, turn.guardPass.hits, turn.guardPass.open], [true, 1, []]); },
  });
  assert.deepEqual(sweeps.map(row => [row.fix, row.old, row.uncompared.length]), [[1, 1, 0], [0, 1, 0]]);
  assert.equal(world.project().genes.genes.find(row => row.id === RULES_GENE_ID).runs, 2, 'checked, then checked again once fixed; the baseline run is no use of the guard');
});

test('the user steers while the pass runs: the SDK drops the finding, and that does not use the turn\'s one continuation up', { skip }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  let steered = 0;
  const { order } = spy(world, t, { onSweep: async () => { if (steered++) return; await world.app.executor.running.get(world.sessionId).handle.steer('Add a second line to it as well.'); } });
  const step = await s.send('Write a note with the shell.', { reply: [
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/c.md\nTODO first\nEOF\n" } }] },
    'Wrote the note.',
    // The steering message is answered by a rewrite of the file that still has a TODO in it.
    { toolCalls: [{ name: 'project_exec', args: { command: "cat <<'EOF' > notes/c.md\nTODO first\nTODO second\nEOF\n" } }] },
    'Added the second line.',
    { toolCalls: [{ name: 'project_exec', args: { command: "printf 'Done\\nDone too\\n' > notes/c.md" } }] },
    'Fixed the note.',
  ] });
  await step.expect({
    files: { 'notes/c.md': 'Done\nDone too\n' },
    requests: rows => {
      const model = rows.filter(row => row.tag === 'foreground'), ours = row => (row.request.messages ?? []).filter(message => message.source === 'finish-feedback' && JSON.stringify(message.content).includes('host-guard-pass'));
      assert.equal(model.length, 6, 'the run, the steering, the one continuation');
      assert.deepEqual(model.map(row => ours(row).length), [0, 0, 0, 0, 1, 1], 'the first finding never reached the model; the second did, once, and stays in its history');
      assert.match(feedbackOf(model[4]), /line 1: TODO first[^]*line 2: TODO second/, 'the file as it was when the second finding was made');
    },
    state: () => {
      const turn = turnRow(world, step.outcome.turnId);
      assert.equal(turn.status, 'completed'); assert.deepEqual([turn.guardPass.continued, turn.guardPass.open], [true, []], 'the continuation that was delivered is the one on the row');
      assert.ok(!world.session().items.some(row => row.kind === 'notice' && row.source === 'guard-pass'), 'nothing left to tell the user: it was fixed');
    },
  });
  assert.deepEqual(order, ['sweep+fix', 'sweep+fix', 'sweep', 'settled'], 'the first finding was dropped, the second continued the turn, the third was clean');
});
