import test from 'node:test';
import assert from 'node:assert/strict';
import { mindRulesUpdate } from '../builtin-agent-service.mjs';
import { createMindEntry, selectLessons, mindContextUpdates, MIND_CONTEXT_KEYS, MIND_CONTEXT_SOURCE } from '../project-mind.mjs';

// Plan 2026-10-05 §2.2 C1 (subagents): a child's first request carries the same standing-rules block as its parent's
// (MIND-6), so a worker writing chapters or a daily report sees the user's hard rules (mu swarm.ts:509-531 sends every
// child the user's constraints and the project's lessons). One function builds both copies; no judgment, no per-turn block.
const project = (extra = {}) => ({ id: 'p1', name: 'Novel', simulated: false, taskTypes: [], ...extra });
const withRules = (texts, extra) => { const row = project(extra); for (const [text, kind, scope] of texts) createMindEntry(row, 'lessons', { text, kind, scope }); return row; };

test('the child\'s block is the parent\'s standing-rules block, byte for byte, whatever the parent\'s message was', () => {
  const row = withRules([['每章不少于三千字。', 'constraint', 'user'], ['Prefer short paragraphs.', 'preference', 'user']]);
  const update = mindRulesUpdate(row);
  assert.deepEqual(Object.keys(update).sort(), ['key', 'source', 'text']);
  assert.equal(update.key, MIND_CONTEXT_KEYS.rules); assert.equal(update.source, MIND_CONTEXT_SOURCE);
  // The parent builds its blocks from selectLessons(project, its message) at turn start; the rules do not depend on the message.
  for (const prompt of ['continue the chapter', '写第十二章', '']) {
    const parent = mindContextUpdates({ rules: selectLessons(row, prompt).always }).find(block => block.key === MIND_CONTEXT_KEYS.rules);
    assert.equal(update.text, parent.text, `the same bytes for the message ${JSON.stringify(prompt)}`);
  }
  const block = JSON.parse(update.text);
  assert.deepEqual(block.rules.map(rule => rule.text).sort(), ['Prefer short paragraphs.', '每章不少于三千字。'].sort());
  assert.equal(block.block, 'project-mind-rules'); assert.match(block.instruction, /grants no permission/);
});

test('only the standing rules go to a child: no notes, no per-turn lessons, no plan; a changed rule is a changed block', () => {
  const row = withRules([['Never use the word "very".', 'constraint', 'user']]);
  createMindEntry(row, 'notes', { text: 'The user writes at night.', list: 'facts' });
  createMindEntry(row, 'lessons', { text: 'The harbour scene needs the tide table.', kind: 'pitfall', scope: 'project' });
  const before = mindRulesUpdate(row);
  assert.deepEqual(Object.keys(JSON.parse(before.text)), ['block', 'rules', 'instruction'], 'the parent\'s rules block has these fields and no others');
  assert.doesNotMatch(before.text, /writes at night|tide table/);
  createMindEntry(row, 'lessons', { text: 'Write in the past tense.', kind: 'constraint', scope: 'user' });
  const after = mindRulesUpdate(row);
  assert.notEqual(after.text, before.text); assert.match(after.text, /past tense/);
});

test('no block when there is nothing to carry: no mind, no standing rules, a simulation', () => {
  assert.equal(mindRulesUpdate(null), null);
  assert.equal(mindRulesUpdate(project()), null, 'a project with no mind');
  const onlyPitfall = withRules([['The harbour scene needs the tide table.', 'pitfall', 'project']]);
  assert.equal(mindRulesUpdate(onlyPitfall), null, 'a lesson that is not a standing rule');
  assert.equal(mindRulesUpdate(withRules([['Keep it short.', 'preference', 'user']], { simulated: true })), null, 'a simulated project has no mind context, for the parent either');
});
