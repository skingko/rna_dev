// D4 scenario (plan A7): a background run changes a project file, the user reverts it, and both the conversation and
// the next background decision learn about the undo. Crosses the initiative (decision + worker), git isolation (the
// run's worktree, its apply record, the rollback), the stream index and the foreground's tail context
// (workspace-events.mjs `workspace-reversions`). Only the model, OpenViking, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decisionInput } from '../harness/faux-model.mjs';

const ORIGINAL = 'one\ntwo\nthree\n', CHANGED = 'one\ntwo (tidied in the background)\nthree\n';
const count = (text, needle) => text.split(needle).length - 1;

test('a background run is reverted by the user; the conversation and the next decision both see the undo', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes.md': ORIGINAL, '.gitignore': 'dist/\n' } });
  const s = scenario(world);

  await s.send('Keep the notes file tidy.', { reply: 'I will keep notes.md tidy.' });

  // The worker reads the file before replacing it, as a correct model does: a write without expectedHash only
  // replaces the version the run observed (A6; harness fs-observation-policy, zcode write.ts).
  const run = await s.backgroundRun({ task: 'Tidy notes.md: mark the second line as tidied.', work: [
    // A6: overwriting a file the run has not read is refused (not_observed), so the worker reads it first.
    { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: CHANGED } }] },
    'Tidied notes.md.\nHandoff: changed the second line of notes.md; nothing left to do.',
  ] });
  const changeId = run.outcome.change?.id;
  await run.expect({
    files: { 'notes.md': CHANGED },
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), change = project.backgroundChanges?.find(row => row.id === changeId);
      assert.ok(change, `the run left a change set (action ${run.outcome.action.status})`);
      assert.equal(change.kind, 'git', 'a git project runs background writes in a worktree and applies them as records');
      assert.deepEqual(change.files.map(row => row.path), ['notes.md']);
      assert.ok((project.git?.applies ?? []).some(row => (change.applyIds ?? [change.applyId]).includes(row.id)), 'its apply record is in state');
    },
    gitRefs: refs => assert.ok(Object.keys(refs).some(ref => ref.startsWith('refs/rna/')), `apply snapshots are pinned by refs: ${Object.keys(refs).join(', ')}`),
    requests: rows => {
      assert.ok(rows.some(row => row.tag === 'initiative'), 'the initiative decided');
      const work = rows.filter(row => row.tag === 'background-work');
      assert.ok(work.length >= 2, 'the worker ran its write and its report');
      assert.match(work[0].wire, /Tidy notes\.md/, 'the worker was given the decided task');
    },
    frames: frames => assert.ok(true, `${frames.length} frames`),
  });

  const index = await world.sse('/api/v2/stream');
  const revert = await s.revert({ change: changeId });
  await revert.expect({
    files: { 'notes.md': ORIGINAL },
    state: state => assert.equal(state.projects.find(row => row.id === world.projectId).backgroundChanges.find(row => row.id === changeId).status, 'reverted'),
    frames: frames => {
      const rows = frames.filter(frame => frame.event === 'index').flatMap(frame => frame.data.projects ?? []).filter(row => row.id === world.projectId);
      assert.ok(rows.some(row => row.backgroundChanges?.some(change => change.id === changeId && change.status === 'reverted')), 'the index told the open tab the change set was reverted');
    },
  });
  void index;

  // The user's rollback record is what the models are told about (workspace-events.mjs: only the user's undos).
  const undo = world.project().git.applies.find(row => row.kind === 'rollback' && row.initiator === 'user');
  assert.ok(undo, 'the revert left the user\'s rollback record');
  const asked = await s.send('What changed in the notes?', { reply: 'The background edit to notes.md was undone; the file is back to its original lines.' });
  await asked.expect({
    requests: rows => {
      const [first] = rows.filter(row => row.tag === 'foreground');
      assert.equal(count(first.wire, undo.id), 1, 'the next request tells the model about the undo exactly once');
      assert.match(first.wire, /host-workspace-events/, 'in the workspace-reversions context');
      assert.match(first.wire, /background_work/, 'as an undo of background work');
    },
  });
  const after = await s.send('Thanks.', { reply: 'You are welcome.' });
  await after.expect({
    requests: rows => {
      const [first] = rows.filter(row => row.tag === 'foreground');
      assert.equal(count(first.wire, undo.id), 1, 'the undo is not announced again (the earlier notice stays in history, once)');
    },
  });

  // The next background decision reads the undo as project evidence (snapshot workspaceEvents) and must not redo it.
  const decisions = world.faux.of('initiative').length;
  world.app.projectInitiative.schedule();
  const later = await s.advanceClock(2 * 3600000, { until: () => world.faux.of('initiative').length > decisions, label: 'the next background decision' });
  await later.expect({
    requests: rows => {
      const input = decisionInput(rows.filter(row => row.tag === 'initiative').at(-1).request);
      assert.ok(input?.project?.workspaceEvents?.events?.some(event => event.kind === "background_reverted" && event.actionId === run.outcome.action.id), `the decision snapshot lists the revert: ${JSON.stringify(input?.project?.workspaceEvents ?? null).slice(0, 300)}`);
    },
  });
});
