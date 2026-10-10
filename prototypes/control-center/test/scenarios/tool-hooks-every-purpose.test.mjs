// D4 scenario (plan B1): one tool hook layer for every purpose. A foreground turn, a background run and a subagent
// (a worker in its own worktree) each write a file an evolution guard watches; each write's result carries the same
// automatic check, the guard's stats count each run (the subagent under its parent turn, the background run under no
// turn), and the subagent's write that breaks a stated constraint is refused before it runs — the gate subagents never
// had. A hit already in a file before the turn is counted, not handed to the model. A second scenario stops a turn
// while its write waits in the gate: the step shows as running while it waits (the SDK starts it before beforeTool,
// pi order), the call is never dispatched, never uncertain, and settles as cancelled. A third runs a session worktree
// turn whose start sync merges the user's edit of the project folder into the worktree: the write's baseline is read
// after that sync, so a hit the sync brought in is counted, not handed to the model. A fourth pauses a turn while its
// write waits in the gate and resumes it: the write runs once, as the same step. A fifth runs code diagnostics across
// two turns: the user renames an export between them, and the error that makes in the file the agent edits next is
// counted, not called new (nothing is kept across runs); the language service takes the pre-write text into the check
// after the write, so nothing is checked before it.
// Crosses the SDK session's beforeTool/afterTool, createRnaRuntime, the host ToolPolicy, the three factories, the gene
// store, JEV (tool.constraint) and git isolation. Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorld, gitReady, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { createMindEntry } from '../../project-mind.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';
import { installFakeTypescript } from '../helpers/fake-typescript.mjs';

const GUARD_TOOL = { id: 'todo_guard', name: 'TODO check', description: 'Flags lines that still say TODO. Takes {path}.', permission: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  script: "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'left a TODO' }); }); return { hits, summary: hits.length + ' found' };",
  smokeCases: [{ input: { path: 'sample.md' }, expected: { hits: [{ line: 1, excerpt: 'TODO here', note: 'left a TODO' }], summary: '1 found' }, workspace: { files: [{ path: 'sample.md', content: 'TODO here\n' }] } }] };
const GENE_ID = 'guard:todo_guard', CONSTRAINT = 'Never write the word FORBIDDEN into the notes.';
const count = (text, needle) => text.split(needle).length - 1;

/** An in-force guard on notes/**: a real, verified genome bundle with the guard's script as the active version, and the gene. */
async function installGuard(world, { constraint = true } = {}) {
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome: { ...GENOME, tools: [GUARD_TOOL] } }); await prepared.commit();
  world.store.mutate(state => {
    const target = state.projects.find(row => row.id === world.projectId), at = new Date().toISOString();
    target.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: 'baseline', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    target.activeVersionId = prepared.record.versionId;
    target.genes = { genes: [{ id: GENE_ID, layer: 'guard', key: 'todo_guard', title: 'TODO check', summary: 'No TODO left in the notes.', status: 'active', level: 0, body: { toolId: 'todo_guard', trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: at, updatedAt: at, history: [] }], generations: [] };
    if (constraint) createMindEntry(target, 'lessons', { text: CONSTRAINT, kind: 'constraint' });
  });
}
const gene = world => world.project().genes.genes.find(row => row.id === GENE_ID);
const journal = world => readFileSync(world.session().runtime.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('foreground, background and subagent writes go through the same tool hooks', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/a.md': 'Intro\nTODO old one\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  // JEV tool.constraint: a write whose text has FORBIDDEN breaks the stated constraint; everything else abstains.
  world.jev.answer('breaks_0', (_question, body) => String(body.state?.write?.text ?? '').includes('FORBIDDEN') ? 0.98 : 0.02);

  const foreground = await s.send('Add a line to the notes.', { reply: [{ toolCalls: [{ name: 'project_edit', args: { path: 'notes/a.md', oldText: 'TODO old one\n', newText: 'TODO old one\nTODO new one\n' } }] }, 'Added a line.'] });
  await foreground.expect({
    files: { 'notes/a.md': 'Intro\nTODO old one\nTODO new one\n' },
    requests: rows => {
      const after = rows.filter(row => row.tag === 'foreground')[1].wire;
      assert.match(after, /\[Automatic checks\] “TODO check”: 1 hit to fix\\n- line 3: TODO new one/, 'the new hit is handed to the model');
      assert.match(after, /1 hit already in this file before this run's writes; counted only/, 'the hit that was there before is a count');
      assert.doesNotMatch(after, /- line 2: TODO old one/);
    },
    state: () => { assert.equal(gene(world).runs, 1); assert.deepEqual(gene(world).turns, [foreground.outcome.turnId]); },
  });

  const background = await s.backgroundRun({ task: 'Write notes/b.md.', work: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/b.md', content: 'TODO from the background\n' } }] },
    'Wrote notes/b.md.\nHandoff: notes/b.md was written; nothing left to do.',
  ] });
  await background.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.ok(work.length >= 2, 'the worker wrote, then reported');
      assert.match(work[1].wire, /\[Automatic checks\] “TODO check”: 1 hit to fix\\n- line 1: TODO from the background/, 'the background write got the same check');
    },
    state: () => { assert.equal(gene(world).runs, 2); assert.deepEqual(gene(world).turns, [foreground.outcome.turnId], 'a background run charges no foreground turn'); },
  });

  world.faux.script('http',
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/c.md', content: 'FORBIDDEN draft\n' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/c.md', content: 'TODO from a worker\n' } }] },
    'Wrote notes/c.md.');
  const delegated = await s.send('Have a worker write notes/c.md.', { reply: [{ toolCalls: [{ name: 'agent_delegate', args: { task: 'Write notes/c.md.', files: ['notes/c.md'], wait: true } }] }, 'The worker wrote notes/c.md.'] });
  await delegated.expect({
    files: { 'notes/c.md': 'TODO from a worker\n' },
    requests: rows => {
      const child = rows.filter(row => row.tag === 'http');
      assert.ok(child.length >= 3, `the worker made its three requests (${rows.map(row => row.tag).join(',')})`);
      assert.match(child[1].wire, new RegExp(CONSTRAINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the write that breaks the constraint was refused with the reason');
      assert.equal(count(child[1].wire, 'FORBIDDEN draft'), 1, 'only in the refused call\'s arguments');
      assert.match(child[2].wire, /\[Automatic checks\] “TODO check”: 1 hit to fix\\n- line 1: TODO from a worker/, 'the worker\'s write got the same check');
    },
    judgments: calls => assert.ok(calls.some(call => Object.hasOwn(call.questions ?? {}, 'breaks_0') && String(call.state?.write?.text ?? '').includes('FORBIDDEN')), 'the constraint gate asked JEV about the worker\'s write'),
    state: () => { assert.equal(gene(world).runs, 3, 'the refused write never ran, so no guard ran on it'); assert.deepEqual(gene(world).turns, [foreground.outcome.turnId, delegated.outcome.turnId], 'the worker\'s run counts under its parent turn'); },
  });
});

test('a stop while a write waits in the gate leaves the call never dispatched: cancelled, never uncertain', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const decisions = world.app.executor.decisions, original = decisions.toolConstraint;
  let entered; const gateEntered = new Promise(done => { entered = done; });
  // The constraint judgment takes a while (a slow JEV answer): the write waits in the gate when the user stops.
  decisions.toolConstraint = (_project, { signal } = {}) => { entered(); return new Promise(done => signal?.addEventListener('abort', () => done(null), { once: true })); };
  t.after(() => { decisions.toolConstraint = original; });

  const stopped = await s.step('stop the turn while its write waits in the gate', async () => {
    world.faux.script('foreground', { toolCalls: [{ id: 'gated-write', name: 'project_write', args: { path: 'notes/new.md', content: 'A new note\n' } }] }, 'Never reached.');
    const accepted = await world.post(`/api/sessions/${world.sessionId}/messages`, { text: 'Write a new note.', requestId: 'stop-in-gate' });
    assert.equal(accepted.status, 200);
    const turnId = world.session().activeTurnId;
    await gateEntered;
    // While the write waits in the gate it is already the turn's running step (pi agent-loop.ts:539-546).
    await until(() => world.session().items.find(row => row.tool?.id === 'gated-write')?.tool.status === 'running', 'the waiting write to show as the running step');
    const stop = await world.post(`/api/sessions/${world.sessionId}/control`, { action: 'stop' });
    assert.equal(stop.status, 200, JSON.stringify(stop.body).slice(0, 300));
    await until(() => world.session().turns.find(row => row.id === turnId)?.status === 'stopped', 'the turn to stop');
    await world.quiet();
    return { turnId };
  });
  await stopped.expect({
    files: { 'notes/new.md': null },
    state: state => {
      const session = state.sessions.find(row => row.id === world.sessionId), item = session.items.find(row => row.tool?.id === 'gated-write');
      assert.equal(item?.tool.status, 'cancelled', 'the step shows as stopped, not uncertain');
      assert.ok(!session.items.some(row => row.tool?.status === 'uncertain'));
    },
  });
  const records = journal(world);
  assert.ok(records.some(row => row.type === 'request_completed' && row.data.message?.content?.some?.(part => part.type === 'toolCall' && part.id === 'gated-write')), 'the model\'s call is in the journal');
  assert.equal(records.some(row => row.type === 'tool_intent' && row.data.toolCallId === 'gated-write'), false, 'never dispatched');
  assert.equal(records.some(row => row.type === 'tool_uncertain'), false, 'never uncertain');

  // The next message just runs: the never-started call is settled as cancelled, with nothing for anyone to resolve.
  decisions.toolConstraint = original;
  const next = await s.send('Never mind; say hello.', { reply: 'Hello.' });
  await next.expect({ state: state => assert.equal(state.sessions.find(row => row.id === world.sessionId).turns.find(row => row.id === next.outcome.turnId).status, 'completed') });
  const settled = journal(world).find(row => row.type === 'tool_completed' && row.data.message.toolCallId === 'gated-write');
  assert.equal(settled?.data.result.details?.cancelled, true); assert.equal(settled.data.result.details.neverStarted, true);
});

test('a session worktree\'s start sync lands before the write\'s baseline: a hit the project folder brought in is counted, not handed to the model', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world, { constraint: false });
  const session = world.store.createSession({ projectId: world.projectId, title: 'Worktree conversation', worktree: true });
  const first = await s.send('Look around.', { sessionId: session.id, reply: 'Looked.' });
  await first.expect({ state: () => assert.equal(world.session(session.id).worktree.state, 'active', 'the conversation works in its own worktree') });

  // Between turns the user edits the project folder; the next turn's start sync merges that into the worktree.
  writeFileSync(join(world.P, 'notes', 'a.md'), 'Intro\nTODO from the project folder\n');
  // The sync is held until the write's baseline was taken, or a second passed: with the baseline read beside the
  // sync it would see the worktree before the merge; read after the sync, it sees the hit the merge brought in.
  let taken; const baselineTaken = new Promise(done => { taken = done; });
  const guardHook = world.app.genes.guardHook.bind(world.app.genes), syncStart = world.app.sessionWorktrees.syncStart.bind(world.app.sessionWorktrees);
  world.app.genes.guardHook = (...args) => { const hook = guardHook(...args); return { ...hook, baseline: async (...input) => { try { return await hook.baseline(...input); } finally { taken(); } } }; };
  world.app.sessionWorktrees.syncStart = async (...args) => { await Promise.race([baselineTaken, delay(1000)]); return syncStart(...args); };
  t.after(() => { world.app.genes.guardHook = guardHook; world.app.sessionWorktrees.syncStart = syncStart; });

  const second = await s.send('Add a line to the notes.', { sessionId: session.id, reply: [{ toolCalls: [{ name: 'project_edit', args: { path: 'notes/a.md', oldText: 'Intro\n', newText: 'Intro\nMore\n' } }] }, 'Added a line.'] });
  await second.expect({
    files: { 'notes/a.md': 'Intro\nMore\nTODO from the project folder\n' },
    requests: rows => {
      const after = rows.filter(row => row.tag === 'foreground')[1].wire;
      assert.match(after, /\[Automatic checks\] “TODO check”: 1 hit already in this file before this run's writes; counted only/, 'the merged hit is a count');
      assert.doesNotMatch(after, /hit to fix/, 'nothing is handed to the model to fix');
    },
    state: () => assert.equal(gene(world).runs, 1, 'the write\'s check ran once; the baseline is no use'),
  });
});

test('a pause while a write waits in the gate, then a resume: the write runs once, as the same step, never uncertain', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'notes/a.md': 'Intro\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  await installGuard(world);
  const decisions = world.app.executor.decisions, original = decisions.toolConstraint;
  let entered; const gateEntered = new Promise(done => { entered = done; });
  decisions.toolConstraint = (_project, { signal } = {}) => { entered(); return new Promise(done => signal?.addEventListener('abort', () => done(null), { once: true })); };
  t.after(() => { decisions.toolConstraint = original; });

  const resumed = await s.step('pause the turn while its write waits in the gate, then resume it', async () => {
    world.faux.script('foreground', { toolCalls: [{ id: 'paused-write', name: 'project_write', args: { path: 'notes/new.md', content: 'A new note\n' } }] }, 'Wrote the note.');
    assert.equal((await world.post(`/api/sessions/${world.sessionId}/messages`, { text: 'Write a new note.', requestId: 'pause-in-gate' })).status, 200);
    const turnId = world.session().activeTurnId;
    await gateEntered;
    assert.equal((await world.post(`/api/sessions/${world.sessionId}/control`, { action: 'pause' })).status, 200);
    await until(() => world.session().turns.find(row => row.id === turnId)?.status === 'paused', 'the turn to pause');
    await until(() => !world.app.executor.running.has(world.sessionId), 'the paused run to end');
    assert.equal(world.session().items.find(row => row.tool?.id === 'paused-write')?.tool.status, 'interrupted', 'shown as interrupted while paused');
    decisions.toolConstraint = original;
    assert.equal((await world.post(`/api/sessions/${world.sessionId}/control`, { action: 'resume' })).status, 200);
    await until(() => world.session().turns.find(row => row.id === turnId)?.status === 'completed', 'the resumed turn to complete');
    await world.quiet();
    return { turnId };
  });
  await resumed.expect({
    files: { 'notes/new.md': 'A new note\n' },
    state: state => {
      const session = state.sessions.find(row => row.id === world.sessionId), steps = session.items.filter(row => row.tool?.id === 'paused-write');
      assert.equal(steps.length, 1, 'one step for the one call'); assert.equal(steps[0].tool.status, 'succeeded');
      assert.ok(!session.items.some(row => row.tool?.status === 'uncertain'));
    },
  });
  const records = journal(world);
  assert.equal(records.filter(row => row.type === 'tool_intent' && row.data.toolCallId === 'paused-write').length, 1, 'dispatched once, after the resume');
  assert.equal(records.some(row => row.type === 'tool_uncertain'), false);
});

test('code diagnostics across turns: an error another file\'s change made is counted, not called new; the write is not held for the check', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { files: { 'b.ts': 'export const helper = 1;\n', '.gitignore': 'node_modules/\n' } });
  installFakeTypescript(world.P);
  const s = scenario(world), diagnostics = world.app.store.diagnostics, diagnose = diagnostics.diagnose.bind(diagnostics), checks = [];
  diagnostics.diagnose = (workspace, path, options = {}) => { checks.push({ path, before: typeof options.before === 'string' }); return diagnose(workspace, path, options); };
  t.after(() => { diagnostics.diagnose = diagnose; });

  const first = await s.send('Use the helper.', { reply: [{ toolCalls: [{ name: 'project_write', args: { path: 'a.ts', content: "import { helper } from './b';\nexport const one = helper;\n" } }] }, 'Done.'] });
  await first.expect({ requests: rows => assert.doesNotMatch(rows.filter(row => row.tag === 'foreground')[1].wire, /Code diagnostics/, 'clean') });
  assert.deepEqual(checks, [{ path: 'a.ts', before: false }], 'one check, after the write (a new file has nothing to compare)');

  // Between turns the user renames the export: a.ts now has an error the agent did not make.
  writeFileSync(join(world.P, 'b.ts'), 'export const helperRenamed = 1;\n');
  const second = await s.send('Add a constant.', { reply: [{ toolCalls: [{ name: 'project_edit', args: { path: 'a.ts', oldText: 'export const one = helper;\n', newText: 'export const one = helper;\nexport const two = 2;\n' } }] }, 'Added.'] });
  await second.expect({
    files: { 'a.ts': "import { helper } from './b';\nexport const one = helper;\nexport const two = 2;\n" },
    requests: rows => {
      const after = rows.filter(row => row.tag === 'foreground')[1].wire;
      assert.match(after, /\[Code diagnostics\] typescript: no new errors\. 1 error already in this file before this run's writes is counted only/);
      assert.doesNotMatch(after, /\d+ new error|Fix these/);
    },
    state: state => assert.equal(state.projects.find(row => row.id === world.projectId).diagnostics?.codes?.TS2305, undefined, 'not a recurring error code of the turn'),
  });
  assert.deepEqual(checks.slice(1), [{ path: 'a.ts', before: true }], 'one check, after the write, carrying the pre-write text: nothing ran before it');
});
