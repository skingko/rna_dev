import test from 'node:test';
import assert from 'node:assert/strict';
import { captureQuestions, combineCapture, turnRouteTemplate, turnSettledTemplate, combineTurnSettled, replySentences, mindCoveredTemplate, combineMindCovered, lintDecisionTemplate, validateSpecTemplate, MAX_CAPTURE_REQUESTS, REPLY_SENTENCES, MIND_COVERED_LIMIT, DECISION_THRESHOLDS } from '../src/decision-templates.mjs';
import { buildDecisionState } from '../src/decision-state.mjs';
import { validateHostTemplatePlan, minimizeDecisionState } from '../src/decision-kernel.mjs';

// D4 (docs/research/mind-d4-probes-20261005.md): the judgments behind a commitment's identity (MIND-5), an assistant's promise
// (MIND-4) and the notes the rules already state. Options and sentences are enumerated by host code; JEV only picks.
const choice = (picked, probabilities) => ({ restates_pending_request: { type: 'choice', choice: picked, probabilities } });
const yes = probability => ({ type: 'boolean', probability });

test('MIND-5: the capture plan asks which pending request a message asks for again, with the escapes, and stays valid for the kernel', () => {
  const requests = [{ text: '明天把第 12 章写完发我' }, { text: 'Run the full test suite' }];
  const questions = captureQuestions({ outputs: [{ text: 'earlier reply' }], threads: [], questions: [], requests });
  assert.deepEqual(Object.keys(questions.restates_pending_request.criteria), ['req_0', 'req_1', 'none', 'unknown']);
  assert.match(questions.restates_pending_request.criteria.req_0, /^Pending request: 明天把第 12 章写完发我$/);
  const plan = turnRouteTemplate({ efforts: ['low', 'medium', 'high'], memory: true, tools: true, capture: { outputs: [{ text: 'earlier reply' }], threads: [], questions: [], requests } });
  assert.doesNotThrow(() => validateHostTemplatePlan(plan));
  assert.ok(validateSpecTemplate(plan));
  assert.deepEqual(lintDecisionTemplate(plan), []);
  // A bounded list; no pending request, no question.
  assert.equal(Object.keys(captureQuestions({ requests: Array.from({ length: 9 }, (_, index) => ({ text: `r${index}` })) }).restates_pending_request.criteria).filter(key => key.startsWith('req_')).length, MAX_CAPTURE_REQUESTS);
  assert.equal(Object.hasOwn(captureQuestions({ outputs: [{ text: 'a' }] }), 'restates_pending_request'), false);
  // The question is part of the state it reads: the message in turn.message (the state builder is the turn.route one).
  assert.ok(buildDecisionState('turn.route', { message: 'm' }).turn);
});

test('MIND-5: the fullest turn.route plan (every option on, five pending requests) still fits the kernel\'s twenty questions', () => {
  const skills = [{ id: 'a', name: 'A', description: 'a' }, { id: 'b', name: 'B', description: 'b' }];
  const plan = turnRouteTemplate({ efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], memory: true, tools: true, skills, background: true, fastModel: { providerId: 'p', modelId: 'm' },
    capture: { outputs: [{ text: 'o' }], threads: [{ title: 't' }], questions: [{ text: 'q' }], requests: Array.from({ length: 9 }, (_, index) => ({ text: `request ${index}` })) } });
  assert.equal(Object.keys(plan.questions).length, 20, 'at the kernel\'s limit, not past it');
  assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.ok(validateSpecTemplate(plan)); assert.deepEqual(lintDecisionTemplate(plan), []);
});

test('MIND-5: a pending request is joined only on a confident pick; "none", "unknown", a doubt and an option the host did not offer join nothing', () => {
  const stake = DECISION_THRESHOLDS.points['turn.capture'].restates;
  assert.equal(stake, 'high', 'read off the labelled distribution (the study): right joins 0.76-0.99, no wrong one above 0.64');
  assert.equal(combineCapture(choice('req_1', { req_0: .02, req_1: .97, none: .01 }), { requests: 2 }).restates, 1);
  assert.equal(combineCapture(choice('req_0', { req_0: .91, none: .09 }), { requests: 2 }).restates, 0);
  // The labelled set's closest wrong pick (a new column for the same table) was 0.64, a back-up-now request against a weekly reminder 0.5.
  assert.equal(Object.hasOwn(combineCapture(choice('req_1', { req_1: .64, none: .32, unknown: .04 }), { requests: 2 }), 'restates'), false);
  assert.equal(Object.hasOwn(combineCapture(choice('none', { none: .97, req_0: .03 }), { requests: 2 }), 'restates'), false);
  assert.equal(Object.hasOwn(combineCapture(choice('unknown', { unknown: .9, req_0: .1 }), { requests: 2 }), 'restates'), false);
  assert.equal(Object.hasOwn(combineCapture(choice('req_3', { req_3: .99 }), { requests: 2 }), 'restates'), false, 'an index beyond the list is not a match');
  assert.equal(Object.hasOwn(combineCapture({}, { requests: 2 }), 'restates'), false);
});

test('MIND-4: turn.settled asks whether the reply commits the assistant to later work of its own, and points at the sentence only when it has several', () => {
  const one = turnSettledTemplate({ sentences: ['好的。'] }), many = turnSettledTemplate({ sentences: ['第一节写好了。', '第二节我会今晚写完。', '写完发你。'] });
  assert.ok(one.questions.commits_to_later_work && !one.questions.promise_sentence);
  assert.deepEqual(Object.keys(many.questions.promise_sentence.criteria), ['s_0', 's_1', 's_2', 'none', 'unknown']);
  for (const plan of [one, many]) { assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.ok(validateSpecTemplate(plan)); assert.deepEqual(lintDecisionTemplate(plan), []); }
  assert.deepEqual(replySentences('第一节写好了。第二节我会今晚写完；写完后把全文发你！\n短'), ['第一节写好了。', '第二节我会今晚写完；', '写完后把全文发你！'], 'split in code, readings of fewer than six characters dropped');
  assert.equal(replySentences(Array.from({ length: 20 }, (_, index) => `Sentence number ${index} says something.`).join(' ')).length, REPLY_SENTENCES, 'the last few only');
  assert.equal(replySentences('x'.repeat(500))[0].length, 160);
});

test('MIND-4: a promise is a confident yes that is not waiting on the user; a doubt on either side is no verdict, never a guess', () => {
  const stake = DECISION_THRESHOLDS.points['turn.settled'].promise;
  assert.equal(stake, 'high', 'true promises scored 0.94-0.98, every non-promise 0.28 or less (the study)');
  const promise = (commits, waiting, extra = {}) => combineTurnSettled({ commits_to_later_work: yes(commits), ...(waiting === undefined ? {} : { waiting_on_user: yes(waiting) }), ...extra }, { sentences: 3 }).promise;
  assert.equal(promise(.97, .06), true);
  assert.equal(promise(.97, .91), false, 'a promise that waits for the user is not the assistant\'s own: the conditional offer the wording rule opened a commitment for');
  assert.equal(promise(.97, .5), null, 'unsure whether it waits: no verdict');
  assert.equal(promise(.97, undefined), null);
  assert.equal(promise(.05, .06), false);
  assert.equal(promise(.5, .06), null);
  assert.equal(promise(.9, .06), true, '0.9 is above the high line');
  assert.equal(promise(.8, .06), null, '0.8 is under it');
  assert.equal(combineTurnSettled({ instruction_complete: yes(.97), waiting_on_user: yes(.03), deferred_without_cause: yes(.03) }).promise, null, 'not asked, no verdict');
  // The sentence that states it: only for a promise, and only inside the list offered.
  const located = (pick, sentences = 3) => combineTurnSettled({ commits_to_later_work: yes(.97), waiting_on_user: yes(.05), promise_sentence: { type: 'choice', choice: pick, probabilities: { [pick]: .95, none: .05 } } }, { sentences });
  assert.equal(located('s_1').promiseSentence, 1);
  assert.equal(Object.hasOwn(located('s_5'), 'promiseSentence'), false, 'beyond the offered sentences');
  assert.equal(Object.hasOwn(located('none'), 'promiseSentence'), false);
  assert.equal(Object.hasOwn(combineTurnSettled({ commits_to_later_work: yes(.05), promise_sentence: { type: 'choice', choice: 's_0', probabilities: { s_0: .99 } } }, { sentences: 2 }), 'promiseSentence'), false, 'a reply with no promise names no sentence');
  // The existing conclusions are untouched.
  assert.deepEqual(combineTurnSettled({ instruction_complete: yes(.97), waiting_on_user: yes(.03), deferred_without_cause: yes(.03) }).finished, true);
});

test('D4 notes: mind.judge covered_<n> is a spec-valid batch of nouls over the rules, and a confident yes marks a line covered', () => {
  const plan = mindCoveredTemplate({ rows: 3 });
  assert.deepEqual(Object.keys(plan.questions), ['covered_0', 'covered_1', 'covered_2']);
  assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.ok(validateSpecTemplate(plan)); assert.deepEqual(lintDecisionTemplate(plan), []);
  assert.equal(Object.keys(mindCoveredTemplate({ rows: 40 }).questions).length, MIND_COVERED_LIMIT);
  assert.equal(mindCoveredTemplate({ rows: 0 }), null);
  assert.equal(DECISION_THRESHOLDS.points['mind.judge'].covered, 'high', 'covered lines 0.82-0.96, no other line above 0.46 (the study)');
  assert.deepEqual(combineMindCovered({ covered_0: yes(.95), covered_1: yes(.46), covered_2: yes(.82) }, { rows: 3 }), { covered: [0] }, '0.82 is a recall the high line gives up for a wide margin to the lines that are not covered');
  assert.deepEqual(combineMindCovered({ covered_0: yes(.9), covered_1: yes(.1) }, { rows: 1 }), { covered: [0] }, 'only the rows asked');
  const state = buildDecisionState('mind.judge', { rows: [{ kind: 'note', text: '表达不要生硬' }], rules: [{ text: '保持活人感' }, '数字用汉字'] });
  assert.deepEqual(state.mind.rows.map(row => row.id), ['N0']);
  assert.deepEqual(state.mind.rules, [{ id: 'R0', text: '保持活人感' }, { id: 'R1', text: '数字用汉字' }]);
  assert.equal(minimizeDecisionState(state, { maxChars: 10000 }).mind.rules.length, 2);
});

test('D4 review: a request is left unowed only for a confident "waiting on the user" (the high line); the medium reading keeps its lighter uses', () => {
  assert.equal(DECISION_THRESHOLDS.points['turn.settled'].waiting, 'medium', 'continuing and the promise\'s blocker keep their line');
  assert.equal(DECISION_THRESHOLDS.points['turn.settled'].waitingUnowed, 'high', 'waiting replies 0.83-0.96, the others 0.31 or less, the hard ones up to 0.84 (the study)');
  const read = probability => combineTurnSettled({ instruction_complete: yes(.3), waiting_on_user: yes(probability), deferred_without_cause: yes(.1) });
  assert.deepEqual([read(.96).waitingForUser, read(.9).waitingForUser, read(.85).waitingForUser], [true, true, true]);
  assert.equal(read(.83).waitingForUser, null, 'between the lines: no verdict, the request stays owed as before');
  assert.equal(read(.83).waiting, true, 'the lighter reading still says it waits');
  assert.equal(read(.5).waitingForUser, null);
  assert.equal(read(.1).waitingForUser, false);
  assert.equal(combineTurnSettled({ instruction_complete: yes(.9) }).waitingForUser, null, 'not asked: no verdict');
});
