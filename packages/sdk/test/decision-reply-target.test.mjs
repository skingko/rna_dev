import test from 'node:test';
import assert from 'node:assert/strict';
import { replyTargetTemplate, combineReplyTarget, captureQuestions, combineCapture, lintDecisionTemplate, validateSpecTemplate, MAX_REPLY_CANDIDATES, DECISION_THRESHOLDS } from '../src/decision-templates.mjs';
import { buildDecisionState } from '../src/decision-state.mjs';
import { validateHostTemplatePlan, minimizeDecisionState } from '../src/decision-kernel.mjs';

// C3 reply.target (docs/research/jev-reply-target-probe-20261005.md): which recent proactive message does a user message
// answer? Options are enumerated by host code; `none` and `latest_reply` mean "none of the proactive messages".
const choice = (picked, probabilities) => ({ replies_to: { type: 'choice', choice: picked, probabilities } });

test('the template is valid for the kernel, lints clean, and lists a delivery per candidate (newest first) plus the escapes', () => {
  for (const [candidates, latestReply] of [[1, false], [3, true], [MAX_REPLY_CANDIDATES, true]]) {
    const plan = replyTargetTemplate({ candidates, latestReply });
    assert.doesNotThrow(() => validateHostTemplatePlan(plan));
    assert.deepEqual(lintDecisionTemplate(plan), []);
    assert.ok(validateSpecTemplate(plan));
    const keys = Object.keys(plan.questions.replies_to.criteria);
    assert.deepEqual(keys, [...Array.from({ length: candidates }, (_, index) => `dlv_${index}`), ...(latestReply ? ['latest_reply'] : []), 'none', 'unknown']);
  }
  assert.equal(replyTargetTemplate({ candidates: 0 }), null, 'nothing to attribute, nothing to ask');
  assert.equal(Object.keys(replyTargetTemplate({ candidates: 9 }).questions.replies_to.criteria).filter(key => key.startsWith('dlv_')).length, MAX_REPLY_CANDIDATES);
});

test('the state carries the message, each delivery with its kind and a bucketed age, and the latest reply only when there is one', () => {
  const state = buildDecisionState('reply.target', { message: 'm', deliveries: [{ kind: 'scheduled report', text: 'report', ageMs: 3 * 3600000 }, { kind: 'finding', text: 'older' }], latestReply: 'last reply', project: { title: 'x', taskTypes: ['writing'] } });
  assert.deepEqual(Object.keys(state), ['reply', 'project']);
  assert.deepEqual(state.reply.deliveries, [{ id: 'D0', kind: 'scheduled report', sent: 'earlier_today', text: 'report' }, { id: 'D1', kind: 'finding', text: 'older' }], 'an age only when the host computed one');
  assert.equal(state.reply.latestReply, 'last reply');
  assert.equal(buildDecisionState('reply.target', { message: 'm', deliveries: [{ text: 'd' }] }).reply.latestReply, undefined);
  assert.equal(minimizeDecisionState(state, { maxChars: 8000 }).reply.deliveries.length, 2, 'the whole state reaches the judge');
});

test('a confident delivery is a target; a confident none or latest reply is no delivery; anything else has no verdict', () => {
  const t = DECISION_THRESHOLDS.points['reply.target'];
  assert.deepEqual(t, { target: .9, none: 'medium' }, 'read off the labelled distribution, not copied (see the study)');
  assert.deepEqual(combineReplyTarget(choice('dlv_1', { dlv_0: .01, dlv_1: .97, dlv_2: .01, none: .01 }), { candidates: 3 }), { target: 1 });
  assert.deepEqual(combineReplyTarget(choice('none', { dlv_0: .02, none: .97, unknown: .01 }), { candidates: 1 }), { target: null });
  assert.deepEqual(combineReplyTarget(choice('latest_reply', { dlv_0: .02, latest_reply: .96, none: .01, unknown: .01 }), { candidates: 1 }), { target: null, other: 'latest_reply' });
  // The labelled set's one wrong delivery pick (a new task on the same file) was 0.78-0.88; the right ones 0.92 and up.
  assert.deepEqual(combineReplyTarget(choice('dlv_0', { dlv_0: .88, none: .12 }), { candidates: 2 }), {}, 'the wrong pick of the labelled set stays unplaced');
  assert.deepEqual(combineReplyTarget(choice('dlv_0', { dlv_0: .92, none: .08 }), { candidates: 2 }), { target: 0 }, 'the lowest right pick of the labelled set is placed');
  // Unsure: below the none tier (0.75), or "unknown", or an option the host did not offer.
  assert.deepEqual(combineReplyTarget(choice('none', { none: .7, dlv_0: .3 }), { candidates: 1 }), {}, 'none needs 0.75');
  assert.deepEqual(combineReplyTarget(choice('unknown', { unknown: .9, dlv_0: .1 }), { candidates: 1 }), {}, 'a thumbs-up the judge cannot place stays unplaced');
  assert.deepEqual(combineReplyTarget(choice('dlv_3', { dlv_3: .99 }), { candidates: 2 }), {}, 'an index beyond the list is not a match');
  assert.deepEqual(combineReplyTarget({}, { candidates: 2 }), {});
  assert.deepEqual(combineReplyTarget(choice('dlv_0', { dlv_0: .9, none: .1 }), { candidates: 1, thresholds: { target: .95, none: .75 } }), {}, 'thresholds can be given explicitly (the probe sweeps them)');
});

test('the capture\'s own target question says "none" confidently as a verdict, not as an abstention', () => {
  const questions = captureQuestions({ outputs: [{ text: 'a' }, { text: 'b' }], threads: [] });
  assert.ok(questions.target_of_feedback.criteria.none);
  const answer = (picked, probabilities) => ({ target_of_feedback: { type: 'choice', choice: picked, probabilities } });
  assert.deepEqual(combineCapture(answer('out_1', { out_1: .9, none: .1 }), { outputs: 2 }).target, { kind: 'output', index: 1 });
  assert.equal(combineCapture(answer('none', { none: .92, out_0: .08 }), { outputs: 2 }).target, null, 'JEV is sure it reacts to nothing earlier');
  assert.equal(Object.hasOwn(combineCapture(answer('none', { none: .55, out_0: .45 }), { outputs: 2 }), 'target'), false, 'unsure: no verdict');
  assert.equal(Object.hasOwn(combineCapture(answer('unknown', { unknown: .95, none: .05 }), { outputs: 2 }), 'target'), false, 'unknown: no verdict');
});
