import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDecisionKernel, validateHostTemplatePlan, minimizeDecisionState } from '../src/decision-kernel.mjs';
import { buildDecisionState, textFeatures, recencyBucket, countBucket, commandFeatures, lengthBucket } from '../src/decision-state.mjs';
import { DECISION_THRESHOLDS, stakeThreshold, stakeVerdict, noulConfidence, turnRouteTemplate, skillScreenWideTemplate, skillScreenVerifyTemplate, deliveryReachAtomicTemplate, messageCheckTemplate, candidatePrescoreAtomicTemplate, initiativeGateTemplate, toolRiskTemplate, memoryFilterTemplate, lintDecisionTemplate, skillOptionKeys,
  messageValueTemplate, combineMessageValue, combineTurnRoute, turnRouteHints, combineReach, combineMessageCheck, combinePrescore, combineInitiativeGate, combineToolRisk, combineMemoryFilter, combineScreenWide, combineScreenVerify, validateSpecTemplate, skillPickTemplate, combineSkillPick } from '../src/decision-templates.mjs';

const efforts = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];
const skills = Array.from({ length: 40 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`, description: `Does task ${index}` }));
const allTemplates = () => [
  turnRouteTemplate({ efforts, skills, background: true, fastModel: { id: 'fast' } }), skillScreenWideTemplate({ candidates: skills }), skillPickTemplate({ candidates: skills }), skillScreenVerifyTemplate({ shortlist: skills.slice(0, 3).map(row => ({ ...row, body: '# Skill\nUse it.' })) }),
  deliveryReachAtomicTemplate(), messageCheckTemplate(), messageCheckTemplate({ deliverable: true }), messageValueTemplate(), messageValueTemplate({ threads: 3 }), candidatePrescoreAtomicTemplate(), initiativeGateTemplate(), toolRiskTemplate(), memoryFilterTemplate({ count: 5 })];
const noulAnswer = probability => ({ type: 'boolean', probability });
const choiceAnswer = (choice, probabilities, confidence) => ({ type: 'choice', choice, probabilities, ...(confidence !== undefined ? { confidence } : {}) });

test('thresholds are versioned in code with stake tiers and the LLM +0.1 offset', () => {
  assert.equal(DECISION_THRESHOLDS.version, 1);
  assert.deepEqual([DECISION_THRESHOLDS.floor, DECISION_THRESHOLDS.low, DECISION_THRESHOLDS.medium, DECISION_THRESHOLDS.high], [.5, .6, .75, .85]);
  assert.equal(stakeThreshold('medium'), .75); assert.equal(stakeThreshold('medium', 'llm'), .85); assert.equal(stakeThreshold('high', 'llm'), .95);
  assert.deepEqual(DECISION_THRESHOLDS.points['turn.route'].needs_memory, { use: .65, skip: .2 });
  assert.equal(DECISION_THRESHOLDS.skillGate, .3); assert.equal(DECISION_THRESHOLDS.skillFits, .3);
  assert.ok(Object.isFrozen(DECISION_THRESHOLDS) && Object.isFrozen(DECISION_THRESHOLDS.points));
  assert.equal(noulConfidence(.1), .9); assert.equal(noulConfidence(.5), .5);
  // noul: between the two thresholds is uncertain; choice below the floor abstains; escapes abstain.
  assert.equal(stakeVerdict(noulAnswer(.8), 'medium'), true); assert.equal(stakeVerdict(noulAnswer(.2), 'medium'), false); assert.equal(stakeVerdict(noulAnswer(.6), 'medium'), undefined);
  assert.equal(stakeVerdict(noulAnswer(.8), 'medium', 'llm'), undefined);
  assert.equal(stakeVerdict(choiceAnswer('low', { low: .7, unknown: .3 }, .7), 'low'), 'low');
  assert.equal(stakeVerdict(choiceAnswer('low', { low: .55, unknown: .45 }, .55), 'low'), undefined);
  assert.equal(stakeVerdict(choiceAnswer('unknown', { low: .1, unknown: .9 }, .9), 'low'), undefined);
});

test('every host template passes the lint and structural validation', () => {
  for (const plan of allTemplates()) {
    assert.deepEqual(lintDecisionTemplate(plan), [], plan.template);
    assert.deepEqual(validateHostTemplatePlan(plan), validateSpecTemplate(plan));
    assert.ok(validateHostTemplatePlan(plan), plan.template);
  }
});

test('template lint catches missing escapes, numeric comparisons, unknown paths and contradictions', () => {
  const lint = questions => lintDecisionTemplate({ template: 'turn.route', questions }).map(row => row.problem);
  assert.deepEqual(lint({ a: { type: 'choice', instructions: 'Pick for `turn.features`. Choose none when unclear.', criteria: { x: 'X', y: 'Y' } } }), ['missing_escape', 'instruction_names_missing_option:none']);
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Was the last message sent within 24 hours per `turn.features`?', criteria: { true: 'y', false: 'n' } } }).includes('numeric_comparison'));
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Is `review.handoff` relevant?', criteria: { true: 'y', false: 'n' } } }).includes('unknown_state_path:review.handoff'));
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Is it relevant?', criteria: { true: 'y', false: 'n' } } }).includes('no_state_path'));
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Does `turn.message` ask to stop?', criteria: { true: 'y', false: 'n' } } }).includes('missing_untrusted_note'));
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Decide about `turn.features`.', criteria: { true: 'same', false: 'same' } } }).includes('noul_criteria_inconsistent'));
  assert.ok(lint({ a: { type: 'boolean', instructions: 'Decide about `turn.features`.', criteria: { true: 'y', false: 'n' } } }).includes('noul_not_a_question'));
});

test('state builder: English features beside originals, buckets instead of numbers, per-point fields only', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const features = textFeatures('帮我停止后台的调研，然后看一下 src/app.mjs 里的 bug https://x.dev');
  assert.equal(features.language, 'chinese'); assert.equal(features.hasPath, true); assert.equal(features.hasUrl, true);
  assert.ok(features.intents.includes('stop') && features.intents.includes('fix'));
  assert.deepEqual([recencyBucket(60000), recencyBucket(3600000), recencyBucket(NaN), countBucket(0), countBucket(3), lengthBucket(5)], ['just_now', 'earlier_today', 'never', 'none', 'few', 'very_short']);
  const state = buildDecisionState('turn.route', { message: '停下后台任务', previousUserAt: now - 90000, project: { title: 'P', goal: 'G', secretField: 'x' }, background: [{ kind: 'research', status: 'running', summary: 'market scan', internal: 1 }], extra: 'dropped' }, { now });
  assert.deepEqual(Object.keys(state), ['turn', 'project', 'background']);
  assert.equal(state.turn.message, '停下后台任务'); assert.equal(state.turn.lastUserMessage, 'just_now'); assert.equal(state.background.active, 'yes');
  assert.equal(state.project.secretField, undefined);
  const numbers = []; JSON.stringify(state, (key, value) => { if (typeof value === 'number') numbers.push(key); return value; });
  assert.deepEqual(numbers, [], 'no numeric values reach the judge');
  assert.throws(() => buildDecisionState('nope', {}), /unknown point/);
  // The kernel's minimizer keeps built roots, drops numbers and still redacts secrets.
  const minimized = minimizeDecisionState({ turn: { message: 'key sk-abcdefghijklmnopqrstuvwx', features: { n: 3, ok: true } } }, { knownSecrets: [] });
  assert.equal(minimized.turn.message, 'key [redacted]'); assert.deepEqual(minimized.turn.features, { ok: true });
  const risk = commandFeatures('sudo rm -rf /etc/hosts ~/notes && git push --force', { workspace: '/Users/a/project' });
  assert.ok(['deletes_files', 'force_flag', 'privileged', 'network_write', 'history_rewrite', 'system_path', 'home_path'].every(flag => risk.flags.includes(flag)));
  assert.equal(risk.placement, 'mentions_outside_workspace');
  assert.equal(commandFeatures('npm test', { workspace: '/w' }).placement, 'relative_paths_only');
  assert.equal(commandFeatures('cat /w/a.txt', { workspace: '/w' }).placement, 'inside_workspace_only');
});

test('turn.route combination: effort, memory, skill gate, background act/ask and hints at the tail', () => {
  const keys = skillOptionKeys(skills);
  assert.equal(new Set(keys).size, keys.length);
  const answers = { reasoning_effort: choiceAnswer('low', { low: .8, medium: .1, high: .05, unknown: .05 }, .8), needs_memory: noulAnswer(.1), needs_tools: noulAnswer(.9), clarify_needed: noulAnswer(.1),
    skill_pick: choiceAnswer(keys[3], { [keys[3]]: .9, none: .1 }, .9), skill_gate_action: noulAnswer(.8), skill_gate_procedure: noulAnswer(.7), skill_gate_prose: noulAnswer(.2), stop_background: noulAnswer(.9), redirect_background: noulAnswer(.1), model_tier: choiceAnswer('fast', { fast: .9, main: .05, unknown: .05 }, .9) };
  const outcome = combineTurnRoute(answers, { skills, efforts });
  assert.equal(outcome.reasoning, 'low'); assert.equal(outcome.needsMemory, false); assert.equal(outcome.needsTools, true); assert.equal(outcome.skill.id, 'skill-3'); assert.equal(outcome.background.stop, 'act'); assert.equal(outcome.modelTier, 'fast');
  assert.equal(combineTurnRoute({ ...answers, stop_background: noulAnswer(.7) }, { skills, efforts }).background.stop, 'ask');
  assert.equal(combineTurnRoute({ ...answers, stop_background: noulAnswer(.4) }, { skills, efforts }).background.stop, null);
  // LLM backend needs 0.95 to act on stop.
  assert.equal(combineTurnRoute(answers, { skills, efforts, backend: 'llm' }).background.stop, 'ask');
  // Closed gate (mean < 0.30) suggests nothing even with a confident pick.
  assert.equal(combineTurnRoute({ ...answers, skill_gate_action: noulAnswer(.1), skill_gate_procedure: noulAnswer(.1), skill_gate_prose: noulAnswer(.9) }, { skills, efforts }).skill, undefined);
  assert.equal(combineTurnRoute({ ...answers, needs_memory: noulAnswer(.5) }, { skills, efforts }).needsMemory, undefined);
  const hints = turnRouteHints(outcome);
  assert.match(hints.hints[0], /Relevant to the current request: skill "Skill 3"\. Ignore this if it does not fit/);
  assert.match(hints.hints[1], /stop it with project_background_control/);
  assert.equal(turnRouteHints({}), null);
});

test('atomic combiners: reach only lowers, prescore keeps high-stake skip, initiative gate, tool risk, memory filter, message check', () => {
  const yes = noulAnswer(.95), no = noulAnswer(.05), mid = noulAnswer(.5);
  assert.equal(combineReach({ time_sensitive: no, needs_user_decision: no, related_to_current_topic: no, similar_recently_ignored: yes }, { maxTier: 'notify' }).tier, 'digest');
  assert.equal(combineReach({ time_sensitive: no, needs_user_decision: no, related_to_current_topic: no, similar_recently_ignored: no }, { maxTier: 'notify' }).tier, 'inbox');
  assert.equal(combineReach({ time_sensitive: no, needs_user_decision: no, related_to_current_topic: yes, similar_recently_ignored: no }, { maxTier: 'inbox' }).tier, 'inbox', 'never escalates');
  assert.equal(combineReach({ time_sensitive: yes, needs_user_decision: no, related_to_current_topic: no, similar_recently_ignored: yes }, { maxTier: 'notify' }).tier, 'notify');
  assert.equal(combineReach({ time_sensitive: mid }, { maxTier: 'inline' }).lowered, false);
  assert.deepEqual(combinePrescore({ targets_observed_problem: noulAnswer(.05), may_regress_other_tasks: noulAnswer(.7), exceeds_hypothesis: no }).better, false);
  assert.equal(combinePrescore({ targets_observed_problem: noulAnswer(.05), may_regress_other_tasks: noulAnswer(.1), exceeds_hypothesis: no }).better, undefined, 'skip needs a second signal');
  assert.equal(combinePrescore({ targets_observed_problem: noulAnswer(.9), may_regress_other_tasks: noulAnswer(.1), exceeds_hypothesis: no }).better, true);
  assert.ok(combinePrescore({ targets_observed_problem: noulAnswer(.9), may_regress_other_tasks: noulAnswer(.1), exceeds_hypothesis: no }).probability > .8);
  assert.equal(combineInitiativeGate({ needs_main_model: yes }).wake, true);
  assert.equal(combineInitiativeGate({ needs_main_model: no, evidence_relevant: no, already_reported: yes }).wake, false);
  assert.equal(combineInitiativeGate({ needs_main_model: mid, evidence_relevant: mid }).wake, undefined);
  assert.equal(combineInitiativeGate({ likely_action: choiceAnswer('share', { wait: .05, work: .05, share: .85, ask: .02, schedule: .02, unknown: .01 }, .85) }).likelyAction, 'share');
  assert.equal(combineToolRisk({ destructive: noulAnswer(.9), outside_workspace: noulAnswer(.6), irreversible: noulAnswer(.3) }).confirm, true);
  assert.equal(combineToolRisk({ destructive: noulAnswer(.9), outside_workspace: noulAnswer(.1), irreversible: noulAnswer(.1) }).confirm, false, 'needs a second signal');
  assert.equal(combineToolRisk({ destructive: noulAnswer(.9), outside_workspace: noulAnswer(.1), irreversible: noulAnswer(.1) }, { flags: ['deletes_files'] }).confirm, true);
  assert.equal(combineToolRisk({ destructive: noulAnswer(.9), outside_workspace: noulAnswer(.6) }, { backend: 'llm' }).confirm, false);
  assert.deepEqual(combineMemoryFilter({ relevant_0: yes, relevant_1: noulAnswer(.1), relevant_2: mid }, { count: 3 }), { keep: [0, 2], dropped: 1 });
  assert.deepEqual(combineMessageCheck({ status_ping: yes, repeats_recent: mid, internal_reference: yes }), ['status_ping', 'internal_id']);
});

test('skill.screen two-stage combination: gate, shortlist of three, fits floor 0.30', () => {
  const wide = combineScreenWide({ which: choiceAnswer('c_2', { c_0: .1, c_1: .05, c_2: .8, c_3: .05, none: 0 }, .8), gate_action: noulAnswer(.8), gate_procedure: noulAnswer(.6), gate_prose: noulAnswer(.3) }, { count: 4 });
  assert.deepEqual(wide.shortlist, [2, 0, 1]); assert.equal(wide.open, true); assert.equal(wide.rejectRest, false);
  assert.equal(combineScreenWide({ which: choiceAnswer('c_0', { c_0: .95, c_1: .05, none: 0 }, .95), gate_action: noulAnswer(.9), gate_procedure: noulAnswer(.9), gate_prose: noulAnswer(.1) }, { count: 2 }).rejectRest, true);
  assert.deepEqual(combineScreenVerify({ fits_0: noulAnswer(.2), fits_1: noulAnswer(.1) }, { count: 2 }).verdicts, [false, false]);
  const verified = combineScreenVerify({ fits_0: noulAnswer(.9), fits_1: noulAnswer(.5), fits_2: noulAnswer(.1) }, { count: 3 });
  assert.deepEqual(verified.verdicts, [true, undefined, false]); assert.equal(verified.rejectedAll, false);
});

// ------------------------------------------------------------ fake JEV server
async function fakeJev(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); requests.push({ headers: req.headers, body: parsed });
    const reply = await handler(parsed, requests.length);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) }); res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/systemone`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
const answerAll = (questions, pick = {}) => ({ model: 'jev-1.13.0', usage: { input_tokens: 500, output_tokens: 20 }, answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
  if (question.type === 'noul') return [id, { type: 'noul', noul: pick[id] ?? .5 }];
  if (question.type === 'choice') { const keys = Object.keys(question.criteria), chosen = pick[id] ?? keys.at(-1); return [id, { type: 'choice', choice: chosen, probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? 1 : 0])), confidence: .95 }]; }
  return [id, { type: 'score', score: pick[id] ?? 1, legend: {}, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === (pick[id] ?? 1) ? 1 : 0])), confidence: .9 }];
})) });

test('turn.route is one System One request fanning out every question, with nouls on the wire', async () => {
  const jev = await fakeJev(body => ({ body: answerAll(body.questions, { reasoning_effort: 'low', needs_memory: .1, stop_background: .92 }) }));
  try {
    const kernel = createDecisionKernel({ apiKey: 'synthetic-key-123', endpoint: jev.endpoint, mode: 'active' });
    const plan = turnRouteTemplate({ efforts, skills: skills.slice(0, 5), background: true });
    const state = buildDecisionState('turn.route', { message: '先停一下后台调研', background: [{ kind: 'research', status: 'running', summary: 'scan' }] });
    const result = await kernel.decide({ point: 'turn.route', scope: { projectId: 'p', revision: 't1' }, state, assessmentPlan: plan, fallback: {} });
    assert.equal(jev.requests.length, 1);
    const sent = jev.requests[0].body;
    assert.equal(sent.model, 'jev-latest'); assert.equal(jev.requests[0].headers.authorization, 'Bearer synthetic-key-123');
    assert.deepEqual(Object.keys(sent.questions).sort(), ['clarify_needed', 'needs_memory', 'needs_tools', 'reasoning_effort', 'redirect_background', 'skill_gate_action', 'skill_gate_procedure', 'skill_gate_prose', 'skill_pick', 'stop_background'].sort());
    assert.equal(sent.questions.needs_memory.type, 'noul');
    assert.equal(sent.state.routingSignals, undefined, 'spec templates send no numeric routing signals');
    assert.equal(sent.state.turn.message, '先停一下后台调研'); assert.ok(sent.state.turn.features.intents.includes('stop'));
    assert.equal(result.source, 'judge'); assert.equal(result.reason, 'accepted');
    const outcome = combineTurnRoute(result.answers, { skills: skills.slice(0, 5), efforts, backend: result.backend });
    assert.equal(outcome.reasoning, 'low'); assert.equal(outcome.needsMemory, false); assert.equal(outcome.background.stop, 'act');
  } finally { await jev.close(); }
});

test('429/529 retry with exponential backoff inside the budget, then the circuit opens', async () => {
  let calls = 0;
  const jev = await fakeJev((body, n) => { calls = n; return n <= 2 ? { status: n === 1 ? 429 : 529, headers: n === 1 ? { 'retry-after': '0' } : {} } : { body: answerAll(body.questions, { destructive: .9 }) }; });
  try {
    const kernel = createDecisionKernel({ apiKey: 'synthetic-key-123', endpoint: jev.endpoint, mode: 'active', timeoutMs: 3000 });
    const result = await kernel.decide({ point: 'tool.risk', scope: { projectId: 'p', revision: 'c1' }, state: buildDecisionState('tool.risk', { name: 'project_exec', arguments: { command: 'rm -rf build' } }), assessmentPlan: toolRiskTemplate(), fallback: {} });
    assert.equal(calls, 3); assert.equal(result.source, 'judge'); assert.equal(result.answers.destructive.probability, .9);
  } finally { await jev.close(); }
  const busy = await fakeJev(() => ({ status: 529 }));
  try {
    const kernel = createDecisionKernel({ apiKey: 'synthetic-key-123', endpoint: busy.endpoint, mode: 'active', timeoutMs: 3000 });
    const first = await kernel.decide({ point: 'tool.risk', scope: { projectId: 'p', revision: 'c2' }, state: {}, assessmentPlan: toolRiskTemplate(), fallback: {} });
    assert.equal(first.reason, 'overloaded'); assert.equal(busy.requests.length, 4, 'one call plus three backoff retries');
    const second = await kernel.decide({ point: 'tool.risk', scope: { projectId: 'p', revision: 'c3' }, state: {}, assessmentPlan: toolRiskTemplate(), fallback: {} });
    assert.equal(second.reason, 'circuit_open'); assert.equal(busy.requests.length, 4);
  } finally { await busy.close(); }
});

test('initiative.review carries host atomic questions with the main-model plan in one request', async () => {
  const jev = await fakeJev(body => ({ body: answerAll(body.questions, { needs_main_model: .05, evidence_relevant: .1, initiative_need: .5 }) }));
  try {
    const kernel = createDecisionKernel({ apiKey: 'synthetic-key-123', endpoint: jev.endpoint, mode: 'active' });
    const plan = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Need to act?', criteria: { true: 'yes', false: 'no' } } } };
    const result = await kernel.decide({ point: 'initiative.review', scope: { projectId: 'p', revision: 'r' }, state: buildDecisionState('initiative.review', { evidence: [{ type: 'ci', summary: 'green' }] }), assessmentPlan: plan, supplement: initiativeGateTemplate(), fallback: { review: true } });
    assert.equal(jev.requests.length, 1);
    assert.deepEqual(Object.keys(jev.requests[0].body.questions).sort(), ['already_reported', 'evidence_relevant', 'initiative_need', 'likely_action', 'needs_main_model', 'user_engaged']);
    assert.equal(result.source, 'judge'); assert.ok(result.supplementRevision && result.planRevision);
    assert.equal(combineInitiativeGate(result.answers).wake, false);
    // Host templates alone are also accepted for initiative.review; supplements elsewhere are rejected.
    const alone = await kernel.decide({ point: 'initiative.review', scope: { projectId: 'p', revision: 'r2' }, state: {}, assessmentPlan: initiativeGateTemplate(), fallback: { review: true } });
    assert.equal(alone.source, 'judge');
    const wrong = await kernel.decide({ point: 'evolution.review', scope: { projectId: 'p', revision: 'r3' }, state: {}, assessmentPlan: { version: 1, questions: { evolution_need: plan.questions.initiative_need } }, supplement: initiativeGateTemplate(), fallback: { review: true } });
    assert.equal(wrong.reason, 'assessment_point_unconfigured');
  } finally { await jev.close(); }
});

test('the LLM judge backend answers the same templates (thresholds raised by 0.1 at the host)', async () => {
  const kernel = createDecisionKernel({ backend: 'llm', requireCredential: false, mode: 'active', judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: .8 }])) }) });
  const result = await kernel.decide({ point: 'message.check', scope: { projectId: 'p', revision: 'm' }, state: buildDecisionState('message.check', { text: 'Still working on it.' }), assessmentPlan: messageCheckTemplate(), fallback: {} });
  assert.equal(result.backend, 'llm'); assert.equal(result.source, 'judge');
  assert.deepEqual(combineMessageCheck(result.answers, { backend: 'typesafe' }), ['status_ping', 'near_duplicate', 'result_not_first', 'internal_id']);
  assert.deepEqual(combineMessageCheck(result.answers, { backend: 'llm' }), []);
});

test('message.value (narrator): atomic value questions plus the continued thread; message.check is project-kind aware', () => {
  const now = Date.parse('2026-09-28T10:00:00Z'), project = { title: '解析器', taskTypes: ['coding'], deliverable: '每晚构建健康：失败测试与位置' };
  const state = buildDecisionState('message.value', { text: '构建在新版依赖上失败了，需要你决定是否回滚？', kind: 'share', threads: [{ title: '依赖升级', messages: ['上次升级了三个依赖。'], lastMessageAt: now - 3600000 }], findings: [{ summary: '升级了三个依赖', lastSharedAt: now - 3600000 }], openItems: ['确认是否发布'], lastUserAt: now - 60000, currentTopic: '发布计划', project, extra: 'dropped' }, { now });
  assert.deepEqual(Object.keys(state).sort(), ['findings', 'message', 'openItems', 'project', 'threads', 'user']);
  assert.deepEqual(state.threads[0], { id: 'thread_0', title: '依赖升级', recent: ['上次升级了三个依赖。'], lastMessage: 'earlier_today' });
  assert.deepEqual(state.project.kind, ['coding']); assert.equal(state.findings[0].when, 'earlier_today'); assert.equal(state.user.lastMessage, 'just_now');
  assert.deepEqual(Object.keys(messageValueTemplate().questions), ['new_information', 'continues_open_thread_or_commitment', 'relevant_now', 'time_sensitive', 'needs_user_decision', 'already_reported']);
  assert.deepEqual(Object.keys(messageValueTemplate({ threads: 2 }).questions.continues_thread.criteria), ['thread_0', 'thread_1', 'none']);
  const combined = combineMessageValue({ new_information: noulAnswer(.2), already_reported: noulAnswer(.9), time_sensitive: noulAnswer(.4), continues_thread: choiceAnswer('thread_1', { thread_1: .9, none: .1 }, .9) });
  assert.deepEqual(combined, { probabilities: { new_information: .2, time_sensitive: .4, already_reported: .9 }, alreadyReported: true, threadIndex: 1 });
  assert.equal(combineMessageValue({ already_reported: noulAnswer(.6) }).alreadyReported, undefined, 'uncertain is not a verdict');
  assert.equal(combineMessageValue({ already_reported: noulAnswer(.8) }, { backend: 'llm' }).alreadyReported, undefined, 'the LLM backend needs +0.1');
  const check = buildDecisionState('message.check', { text: 'x', recent: [], project }, { now });
  assert.deepEqual(check.project, { title: '解析器', kind: ['coding'], deliverable: '每晚构建健康：失败测试与位置' });
  assert.ok(messageCheckTemplate({ deliverable: true }).questions.describes_instead_of_delivering); assert.equal(messageCheckTemplate().questions.describes_instead_of_delivering, undefined);
  assert.match(messageCheckTemplate().questions.internal_reference.instructions, /References the user needs to act on or open do not count/);
});

test('combineSkillPick takes the top option when it beats none, then options keeping a share of it, up to max', () => {
  const answers = probabilities => ({ which: { type: 'choice', choice: 'c_0', probabilities } });
  assert.deepEqual(combineSkillPick(answers({ c_0: .5, c_1: .02, c_2: .3, c_3: .05, none: .13 }), { count: 4 }).indexes, [0, 2]);
  assert.deepEqual(combineSkillPick(answers({ c_0: .3, c_1: .25, c_2: .2, c_3: .15, none: .1 }), { count: 4 }).indexes, [0, 1, 2], 'at most three');
  assert.deepEqual(combineSkillPick(answers({ c_0: .2, c_1: .1, none: .7 }), { count: 2 }).indexes, [], 'none wins');
  assert.equal(combineSkillPick(answers({ c_0: .2, c_1: .1, none: .7 }), { count: 2 }).none, true);
});

test('delivery.reach engagement: any one reason is enough, and a confident keep is a decision', async () => {
  const { combineReach } = await import('../src/decision-templates.mjs');
  const b = probability => ({ type: 'boolean', probability });
  const related = combineReach({ time_sensitive: b(.1), needs_user_decision: b(.1), related_to_current_topic: b(.9), similar_recently_ignored: b(.1) }, { maxTier: 'inline' });
  assert.ok(related.engagement > .85, `related message engagement ${related.engagement}`);
  assert.deepEqual([related.tier, related.lowered, related.confident], ['inline', false, true]);
  const ignored = combineReach({ time_sensitive: b(.1), needs_user_decision: b(.1), related_to_current_topic: b(.1), similar_recently_ignored: b(.95) }, { maxTier: 'inline' });
  assert.ok(ignored.engagement < .3); assert.equal(ignored.tier, 'digest');
  assert.equal(combineReach({ time_sensitive: b(.5) }, { maxTier: 'inline' }).confident, false);
});

test('gene.route v5 asks whether a rule is a recurring duty; only a confident yes routes it to a schedule', async () => {
  const { geneRouteTemplate, combineGeneRoute, GENE_ROUTE_TEMPLATE_VERSION, lintDecisionTemplate } = await import('../src/decision-templates.mjs');
  assert.equal(GENE_ROUTE_TEMPLATE_VERSION, 5); assert.ok(geneRouteTemplate().questions.periodic); assert.deepEqual(lintDecisionTemplate(geneRouteTemplate()), []);
  // v4 asks about literal evidence in a file; measured on JEV, rules that need judgment answer 0.10–0.27 (low stake: 0.6).
  assert.match(geneRouteTemplate().questions.checkable_by_program.instructions, /literal text of one project file/);
  const checkable = (p, terms = .05) => combineGeneRoute({ checkable_by_program: { type: 'boolean', probability: p }, names_concrete_terms: { type: 'boolean', probability: terms }, changes_method: { type: 'boolean', probability: .9 }, every_write: { type: 'boolean', probability: .5 }, periodic: { type: 'boolean', probability: .05 } });
  assert.equal(checkable(.65).guard, true); assert.equal(checkable(.27).guard, false);
  // v5: naming concrete words no longer makes a rule a guard (labelled probe 2026-10-05: it added only false guards).
  assert.equal(geneRouteTemplate().questions.names_concrete_terms, undefined);
  assert.equal(checkable(.3, .95).guard, false, 'a rule that names examples but needs judgment is not a guard');
  // The checkable verdict itself: confident yes, confident no (≤0.4 at the low stake) or unsure — EVO-7 acts only on no.
  assert.deepEqual([checkable(.65).checkable, checkable(.38).checkable, checkable(.5).checkable], [true, false, null]);
  const answers = (periodic, method = .9) => ({ checkable_by_program: { type: 'boolean', probability: .1 }, changes_method: { type: 'boolean', probability: method }, every_write: { type: 'boolean', probability: .5 }, periodic: { type: 'boolean', probability: periodic } });
  assert.equal(combineGeneRoute(answers(.95)).periodic, true);
  assert.equal(combineGeneRoute(answers(.8)).periodic, false, 'high stake: 0.8 is not enough');
  assert.equal(combineGeneRoute(answers(.1)).periodic, false); assert.equal(combineGeneRoute(answers(.1)).method, true);
  assert.equal(combineGeneRoute({}).periodic, false, 'no answer, no duty');
});

test('gene.consolidate: add when nothing overlaps, revise the overlapping rule, skip only a confident repeat', async () => {
  const { geneConsolidateTemplate, combineGeneConsolidate, lintDecisionTemplate, validateSpecTemplate } = await import('../src/decision-templates.mjs');
  const plan = geneConsolidateTemplate({ existing: 3 });
  assert.deepEqual(Object.keys(plan.questions), ['overlap', 'adds']);
  assert.deepEqual(Object.keys(plan.questions.overlap.criteria), ['rule_0', 'rule_1', 'rule_2', 'none']);
  assert.deepEqual(lintDecisionTemplate(plan), []); assert.ok(validateSpecTemplate(plan));
  const choice = (key, p = .9) => choiceAnswer(key, { rule_0: .02, rule_1: .02, rule_2: .02, none: .02, [key]: p }), noul = noulAnswer;
  assert.deepEqual(combineGeneConsolidate({ overlap: choice('none'), adds: noul(.9) }, { existing: 3 }), { action: 'add', index: null });
  assert.deepEqual(combineGeneConsolidate({ overlap: choice('rule_1'), adds: noul(.9) }, { existing: 3 }), { action: 'revise', index: 1 });
  assert.deepEqual(combineGeneConsolidate({ overlap: choice('rule_1'), adds: noul(.3) }, { existing: 3 }), { action: 'revise', index: 1 }, 'an unsure "adds nothing" still keeps the new point');
  assert.deepEqual(combineGeneConsolidate({ overlap: choice('rule_2'), adds: noul(.03) }, { existing: 3 }), { action: 'skip', index: 2 });
  assert.equal(combineGeneConsolidate({ overlap: choice('rule_0', .4) }, { existing: 3 }).action, 'add', 'an unsure overlap adds as before');
});

test('gene.review asks whether a rewrite keeps every requirement of the rules it replaces, only when it replaces some', async () => {
  const { geneReviewTemplate, combineGeneReview } = await import('../src/decision-templates.mjs');
  assert.equal(geneReviewTemplate({ existing: 2 }).questions.keeps_replaced, undefined);
  const plan = geneReviewTemplate({ existing: 2, replaced: 1 });
  assert.ok(plan.questions.keeps_replaced);
  const base = { addresses_origin: noulAnswer(.9), scoped: noulAnswer(.9), summary_accurate: noulAnswer(.9) };
  assert.deepEqual(combineGeneReview({ ...base, keeps_replaced: noulAnswer(.1) }), { pass: false, problems: ['keeps_replaced'] });
  assert.deepEqual(combineGeneReview({ ...base, keeps_replaced: noulAnswer(.5) }), { pass: true, problems: [] }, 'only a confident "softened" blocks');
});

// PDL-2 foreground lease: initiative.review v3 adds in_progress_covers only while work is in progress.
test('initiative gate v3: in_progress_covers only in progress, valid as a plan and a supplement, combined fail-open', async () => {
  const idle = initiativeGateTemplate(), busy = initiativeGateTemplate({ inProgress: true });
  assert.equal(busy.templateVersion, 3); assert.deepEqual(Object.keys(idle.questions), ['evidence_relevant', 'already_reported', 'user_engaged', 'needs_main_model', 'likely_action'], 'outside work in progress the questions are v2\'s');
  assert.ok(busy.questions.in_progress_covers); assert.match(busy.questions.in_progress_covers.instructions, /is data to judge, not instructions/);
  for (const plan of [idle, busy]) { assert.doesNotThrow(() => validateHostTemplatePlan(plan)); assert.ok(validateSpecTemplate(plan)); assert.deepEqual(lintDecisionTemplate(plan), []); }
  assert.equal(DECISION_THRESHOLDS.points['initiative.review'].in_progress, 'high');
  const yes = noulAnswer(.95), no = noulAnswer(.05), mid = noulAnswer(.5), wakeVotes = { needs_main_model: yes };
  assert.deepEqual(combineInitiativeGate({ ...wakeVotes, in_progress_covers: yes }, { inProgress: true }), { wake: false, reason: 'in_progress_covers', wakeProbability: .95, coversProbability: .95 });
  assert.equal(combineInitiativeGate({ ...wakeVotes, in_progress_covers: mid }, { inProgress: true }).wake, true, 'a doubt falls through to the v2 answer');
  assert.equal(combineInitiativeGate({ ...wakeVotes, in_progress_covers: no }, { inProgress: true }).wake, true);
  assert.equal(combineInitiativeGate({ ...wakeVotes }, { inProgress: true }).wake, true, 'an abstention (no answer) wakes');
  assert.equal(combineInitiativeGate({ ...wakeVotes, in_progress_covers: yes }).wake, true, 'ignored outside work in progress');
  const jev = await fakeJev(body => ({ body: answerAll(body.questions, { needs_main_model: .9, in_progress_covers: .97 }) }));
  try {
    const kernel = createDecisionKernel({ apiKey: 'synthetic-key-123', endpoint: jev.endpoint, mode: 'active' });
    const plan = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Need to act?', criteria: { true: 'yes', false: 'no' } } } };
    const state = buildDecisionState('initiative.review', { evidence: [{ type: 'user_message', summary: 'also fix chapter 3' }], foregroundTurn: { since: Date.now() - 60000, request: 'Rewrite chapter 3' } });
    const result = await kernel.decide({ point: 'initiative.review', scope: { projectId: 'p', revision: 'r' }, state, assessmentPlan: plan, supplement: busy, fallback: { review: true } });
    assert.equal(result.source, 'judge'); assert.ok(Object.hasOwn(jev.requests[0].body.questions, 'in_progress_covers'));
    assert.deepEqual(combineInitiativeGate(result.answers, { inProgress: true }).reason, 'in_progress_covers');
  } finally { await jev.close(); }
});

test('initiative gate state: work in progress comes first in review and survives a maximal state', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const built = buildDecisionState('initiative.review', { evidence: [{ type: 'workspace_change', summary: 'x'.repeat(2000) }], foregroundTurn: { since: now - 600000, request: '请重写第 3 章的结尾'.repeat(80) }, backgroundWork: [{ status: 'running', intent: 'Check the outline'.repeat(40) }, { status: 'queued', intent: 'b' }, { status: 'queued', intent: 'c' }, { status: 'queued', intent: 'd' }], project: { title: 'Novel', goal: 'Write it' } }, { now });
  assert.deepEqual(Object.keys(built.review).slice(0, 3), ['foregroundTurn', 'backgroundWork', 'newEvidence']);
  assert.deepEqual(built.review.foregroundTurn, { running: true, since: 'recent', request: built.review.foregroundTurn.request }); assert.ok(built.review.foregroundTurn.request.length <= 400);
  assert.equal(built.review.backgroundWork.length, 3); assert.ok(built.review.backgroundWork.every(row => row.length <= 240)); assert.match(built.review.backgroundWork[0], /^running: /);
  assert.equal(buildDecisionState('initiative.review', { evidence: [] }, { now }).review.foregroundTurn, undefined, 'absent outside work in progress');
  // The kernel's 8,000-character budget goes to userMessage and the legacy evidence first; the progress fields still fit.
  const state = { userMessage: 'u'.repeat(2400), evidence: Array.from({ length: 6 }, (_, index) => ({ id: `e${index}`, type: 'user_message', summary: 's'.repeat(600) })), task: { title: 'Novel', goal: 'Write the novel', phase: 'active', summary: 'Chapter work' }, ...built };
  const minimized = minimizeDecisionState(state, { maxChars: 8000 });
  assert.equal(minimized.userMessage.length, 2400);
  assert.deepEqual(minimized.review.foregroundTurn, built.review.foregroundTurn);
  assert.deepEqual(minimized.review.backgroundWork, built.review.backgroundWork);
});
