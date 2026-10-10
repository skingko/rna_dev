// D4 scenario (W1, token-burn study 2026-10-05): what a follow-up run is told and what the next decision reads of it.
// On 2026-10-05 the 13:41 instruction said "tell the user the new entry's text in a separate share"; the worker believed
// its next wake reads only its handoff line, wrote the text into a file and gave the gist in its reply, and the next
// decision had to start a second run (83K tokens) plus a decision to fetch the text word for word. Now:
//  1. the worker's purpose text says what the next decision reads (the first 6,000 characters of the final reply and the
//     handoff line), and the text the worker puts word for word in its final reply is in the next decision's events;
//  2. a run in its own worktree is told so in its brief (stable part, so not in any decision request), and what it says is
//     true in the world: a file tool refuses the real project folder, a command cannot write there, and the host applies
//     the copy's changes to the project folder when the run ends;
//  3. a project whose runs are in the project folder (no repository, so no worktree) gets no such note.
// Crosses the initiative's decision, worker brief and purpose text, background worktrees (the sandbox, the apply), the SDK's
// action_completed observation. Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, until, gitReady } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';
import { WORKER_REPLY_NOTE, WORKER_COPY_NOTE } from '../../work-run-text.mjs';

const skip = gitReady ? false : 'git 2.38 or later is needed';
const ENTRY = 'Entry 7: the harbour was grey at dawn, and the third chapter opens with the ferry that never came.';
const TASK = 'Write the new register entry to notes/entry-7.md, then tell the user what it says.';

/** The text of a keyed context message of a request (a JSON array of { source, text }), or null. */
const contextOf = (row, key, source) => {
  const message = (row.request.messages ?? []).findLast(item => item.contextKey === key);
  if (!message) return null;
  const text = Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('') : String(message.content);
  return JSON.parse(text.slice(text.indexOf('[{'))).find(item => item.source === source)?.text ?? null;
};
const briefOf = row => JSON.parse(contextOf(row, 'project-brief', 'project-brief'));
const purposeOf = row => contextOf(row, 'purpose-instructions', 'host-purpose-instructions');
/** Waits for the decision after the run: the request whose events carry the run's completion. */
const afterRun = world => until(() => world.faux.of('initiative').map(row => ({ row, input: decisionInput(row.request) })).find(({ input }) => input?.events?.some(event => event.type === 'action_completed')), 'the decision after the run');

test('the next decision reads the text the worker put in its final reply word for word, and the worker in its own copy was told so and told true', { skip }, async t => {
  const world = await createWorld(t, { initiative: true, files: { 'notes/entry-6.md': 'Entry 6: the lighthouse.\n', '.gitignore': 'dist/\n' } });
  const s = scenario(world), main = join(world.P, 'notes');
  const run = await s.backgroundRun({ task: TASK, work: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/entry-7.md', content: `${ENTRY}\n` } }] },
    // The worker tries the real project folder, by a file tool and by a command: both are refused, as its brief says.
    { toolCalls: [{ name: 'project_write', args: { path: join(main, 'direct.md'), content: 'written straight into the project folder\n' } }] },
    { toolCalls: [{ name: 'project_exec', args: { command: `cp notes/entry-7.md '${join(main, 'copied.md')}'; echo "exit $?"` } }] },
    `Wrote notes/entry-7.md. Its text, word for word:\n\n${ENTRY}\n\nHandoff: wrote entry 7 to notes/entry-7.md and put its text in this reply; nothing left but telling the user.`,
  ] });
  const rows = world.faux.of('background-work');
  assert.equal(rows.length, 4, 'three tool rounds and the final reply');

  // 1. The worker's purpose text: what the next decision reads.
  assert.ok(purposeOf(rows[0]).includes(WORKER_REPLY_NOTE));
  assert.match(purposeOf(rows[0]), /The next decision reads the first 6,000 characters of your final reply/);
  assert.doesNotMatch(purposeOf(rows[0]), /下次唤醒只读这一行/);

  // 2. In its own copy: told in the brief; true in the world.
  assert.equal(briefOf(rows[0]).work.workspace, WORKER_COPY_NOTE, 'the isolated worker\'s brief says it is in a copy');
  assert.match(rows[2].wire, /outside the project scope or is private/, 'the file tool refused the real project folder');
  assert.equal(world.file('notes/direct.md'), null, 'and wrote nothing there');
  assert.match(rows[3].wire, /Operation not permitted|sandbox/i, 'the command was refused too');
  assert.equal(world.file('notes/copied.md'), null, 'and copied nothing there');
  assert.equal(world.file('notes/entry-7.md'), `${ENTRY}\n`, 'what the run changed in its copy was applied to the project folder when it ended');
  assert.ok(run.outcome.change, 'as a recorded change set');

  // The decision requests never carry the note: the stable brief is the worker's.
  const decisions = world.faux.of('initiative');
  assert.ok(decisions.length >= 1);
  for (const row of decisions) assert.equal(row.wire.includes('its own copy of the project folder'), false, 'a decision request does not carry the worker\'s workspace note');

  // 3. The next decision reads the worker's final reply: the text, word for word, in its events.
  const { input } = await afterRun(world);
  const seen = input.events.find(event => event.type === 'action_completed');
  assert.ok(seen.summary.includes(ENTRY), 'the next decision\'s events hold the text word for word');
  assert.ok(seen.summary.length <= 16000);
  assert.equal(run.outcome.job.output.includes(ENTRY), true, 'it is the job\'s output, bounded at 6,000 characters');
  assert.ok(run.outcome.job.output.length <= 6000);
  assert.equal(input.recentActions.some(row => /wrote entry 7 to notes\/entry-7\.md and put its text in this reply/.test(row.handoff ?? '')), true, 'and the handoff line is in its receipt');
  // So the follow-up the instruction asked for needs no run of its own: the decision can share the text it just read.
  assert.equal(world.faux.of('background-work').length, 4, 'no second run was needed to fetch the text');
});

test('a run in the project folder (no repository, so no worktree) is told nothing about a copy', { skip }, async t => {
  const world = await createWorld(t, { initiative: true, git: false, files: { 'notes/entry-6.md': 'Entry 6: the lighthouse.\n' } });
  const s = scenario(world);
  const run = await s.backgroundRun({ task: TASK, work: [
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/entry-7.md', content: `${ENTRY}\n` } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'notes/entry-7.md' } }] },
    `Wrote notes/entry-7.md.\n\n${ENTRY}\n\nHandoff: wrote entry 7 and put its text in this reply; nothing left.`,
  ] });
  const rows = world.faux.of('background-work');
  assert.equal(rows.length, 3, 'the write, the read-back, the final reply');
  assert.equal(briefOf(rows[0]).work.workspace, undefined, 'no workspace key in the brief');
  assert.equal(rows[0].wire.includes('its own copy of the project folder'), false);
  assert.ok(purposeOf(rows[0]).includes(WORKER_REPLY_NOTE), 'the purpose text is the same in both');
  assert.equal(world.file('notes/entry-7.md'), `${ENTRY}\n`, 'written in the project folder itself');
  assert.equal(run.outcome.job.status, 'completed');
});
