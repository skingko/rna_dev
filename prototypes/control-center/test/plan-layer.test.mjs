import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMind, updatePlan, planView, mindContextText, PLAN_STATUSES } from '../project-mind.mjs';

// Plan layer (plan 2026-09-30 §4.1): one working plan per project, kept as
// agenda todos with a stage, shared by the conversation and background work.
test('project_plan semantics: add, update by id or by the same text, finish, drop; the view lists doing, next and recent done', () => {
  const mind = emptyMind(0);
  let plan = updatePlan(mind, [{ text: '写第 8 章', status: 'doing' }, { text: '写第 9 章', status: 'next' }, { text: '写第 10 章', status: 'next' }], { now: 1000 });
  assert.deepEqual(plan.doing.map(row => row.text), ['写第 8 章']); assert.deepEqual(plan.next.map(row => row.text), ['写第 9 章', '写第 10 章']);
  const eight = plan.doing[0].id, nine = plan.next[0].id;
  plan = updatePlan(mind, [{ id: eight, status: 'done' }, { text: '写第 9 章。', status: 'doing' }], { now: 2000 });
  assert.deepEqual(plan.done.map(row => row.text), ['写第 8 章']); assert.deepEqual(plan.doing.map(row => row.id), [nine], 'the same text (punctuation aside) is the same item');
  plan = updatePlan(mind, [{ text: '写第 10 章', status: 'dropped' }], { now: 3000 });
  assert.equal(plan.next.length, 0);
  assert.equal(mind.agenda.find(row => row.text === '写第 10 章').status, 'dropped');
  assert.equal(mind.agenda.find(row => row.id === eight).resolvedBy.kind, 'agent');
  assert.throws(() => updatePlan(mind, [{ status: 'next' }]), /A new plan item needs text/);
  assert.throws(() => updatePlan(mind, [{ id: 'missing', status: 'done' }]), /The plan has no item missing/);
  assert.throws(() => updatePlan(mind, [{ text: 'x', status: 'later' }]), /status/);
  assert.deepEqual([...PLAN_STATUSES], ['doing', 'next', 'done', 'dropped']);
  // Other agenda kinds are not part of the plan.
  mind.agenda.push({ id: 'q', kind: 'awaiting_user', text: '要不要换主角', status: 'open', updatedAt: 'x' });
  assert.equal(planView(mind).next.length, 0);
});

test('the plan rides in the mind context with the instruction to keep it current and resume it on "continue"', () => {
  const mind = emptyMind(0);
  updatePlan(mind, [{ text: '写第 9 章', status: 'doing' }, { text: '写第 10 章', status: 'next' }], { now: 1 });
  const text = mindContextText({ plan: planView(mind) });
  const payload = JSON.parse(text);
  assert.deepEqual(payload.plan.doing.map(row => row.text), ['写第 9 章']); assert.deepEqual(payload.plan.next.map(row => row.text), ['写第 10 章']);
  assert.match(payload.instruction, /project_plan/); assert.match(payload.instruction, /only asks you to continue, resume the first doing/);
  assert.equal(mindContextText({ plan: planView(emptyMind(0)) }), null, 'an empty plan adds nothing');
});
