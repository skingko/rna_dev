import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';
import { EffortCapture, purgeEffortCaptures } from '../internal-reasoning.mjs';
import { EffortReplay, selectCases, callEstimate, callCeiling, decisionAllowance, replayEstimate, summarize, selectNarrator, narratorEstimate, narratorCeiling, summarizeNarrator, REPLAY_BUDGET_TOKENS } from '../benchmark/internal-effort-replay.mjs';
import { runEffortCommand } from '../cli-effort.mjs';
import { initialMaintenance, persistMaintenance } from '../application-maintenance-state.mjs';

// Stage B harness (spec p1 effort §6.3): replays captured decisions at the JEV-chosen effort and at today's, inside the
// daemon, within the approved budget and the daily real-token cap, never touching project state.
const plan = { mode: 'route', allowed: ['low', 'high', 'max'], fallback: 'max', ceiling: 'max' };
const row = (id, effort, at, outcome = { status: 'decided', action: 'wait', usage: { totalTokens: 40000 } }, extra = {}) => ({ kind: 'call', purpose: 'decision', id, at, projectId: 'p', plan, verdict: { depth: effort === 'low' ? 'light' : effort === 'high' ? 'standard' : 'deep', effort }, request: { project: { id: 'p' }, events: [] }, outcome, ...extra });

test('cases: newest lighter ones first, today\'s effort on a baseline spread over the depth classes (clean baselines first), deep ones replayed once; the estimate is conservative', () => {
  const rows = [row('a', 'low', '2026-10-04T01:00:00Z'), row('b', 'max', '2026-10-04T02:00:00Z'), row('c', 'high', '2026-10-04T03:00:00Z'), row('d', 'low', '2026-10-04T04:00:00Z', { status: 'stale' }), { ...row('e', 'low', '2026-10-04T05:00:00Z'), verdict: null }];
  const selection = selectCases(rows, { cases: 3, baseline: 1 });
  assert.deepEqual(selection.map(item => [item.row.id, item.conditions]), [['c', ['jev', 'today']], ['a', ['jev']], ['b', ['today']]]);
  assert.deepEqual(selectCases(rows, { cases: 3, baseline: 2 }).map(item => item.conditions), [['jev', 'today'], ['jev', 'today'], ['today']], 'one pair per class before a second one');
  // Within a class a live decision that ran at today's effort (a clean baseline) is paired before a route trial's.
  const light = [row('n', 'low', '2026-10-04T09:00:00Z', undefined, { sent: 'low', verdict: { depth: 'light', effort: 'low', applied: true } }), row('o', 'low', '2026-10-04T08:00:00Z', undefined, { sent: 'max' })];
  assert.deepEqual(selectCases(light, { cases: 2, baseline: 1 }).map(item => [item.row.id, item.conditions]), [['n', ['jev']], ['o', ['jev', 'today']]]);
  assert.equal(callEstimate(rows[0]), 44000); assert.equal(replayEstimate(selection), 4 * 44000);
  assert.ok(callEstimate({ request: { project: { id: 'p' }, events: [] }, outcome: {} }) > 32768, 'unknown usage: request size plus the whole allowance');
});

test('the worst case of a call is its input plus the output allowance it is sent with, never clamped (review EFF-6/RPL-6)', () => {
  const wide = { ...row('w', 'low', '2026-10-04T01:00:00Z'), request: { project: { id: 'p' }, events: [], policy: { decisionMaxTokens: 131072 } } };
  assert.equal(decisionAllowance(wide, { maxOutputTokens: 131072 }), 131072);
  assert.ok(callCeiling(wide, { maxOutputTokens: 131072 }) > 131072, 'a 128K allowance is admitted at 128K, not 32K');
  assert.equal(decisionAllowance(wide, { maxOutputTokens: 32768 }), 32768, 'the model cap bounds the captured allowance');
  assert.equal(decisionAllowance({ ...wide, request: { ...wide.request, policy: { decisionMaxTokens: 2000 } } }, { maxOutputTokens: 131072 }), 2000);
  assert.equal(decisionAllowance({ ...wide, outputCap: 64000, request: { ...wide.request, policy: {} } }), 64000, 'no resolved model: the captured model\'s cap');
  assert.ok(callCeiling(wide, { maxOutputTokens: 131072 }) - 131072 > 2000, 'the decision system prompt is part of the input');
});

const decided = (action, extra = {}) => ({ status: 'decided', action, messageViolations: [], messageChecked: true, usage: { output: 500 }, tokens: 1000, latencyMs: 10, ...extra });
const failed = (extra = {}) => ({ status: 'failed', code: 'invalid_decision', unknownEvidence: true, usage: { output: 500 }, tokens: 1000, latencyMs: 10, ...extra });
const kase = (id, depth, runs, recorded = {}) => ({ id, depth, jevEffort: depth === 'light' ? 'low' : depth === 'standard' ? 'high' : 'max', today: 'max', recorded: { status: 'decided', action: 'work', messageRepairs: 0, attempts: 1, clean: true, ...recorded }, runs });
const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));

test('gate (review EFF-1): a lighter effort that waits where today\'s worked does not pass, and its class is not lowered', () => {
  const s = summarize(many(10, i => kase(`l${i}`, 'light', { jev: decided('wait'), today: decided('work') })));
  assert.equal(s.gate.pass, false);
  assert.ok(s.gate.reasons.includes('worse_agreement') && s.gate.reasons.includes('worse_lost_initiative'), s.gate.reasons.join());
  assert.deepEqual(s.gate.classesNotToLower, ['light']);
  assert.deepEqual(s.paired.agreement, { cases: 10, jev: 0, today: 10 }); assert.deepEqual(s.paired.lostInitiative, { jev: 10, today: 0 }); assert.equal(s.paired.jevWaitedOnly, 10);
});

test('gate (review RPL-3): more message-contract violations at the lighter effort do not pass; the baseline is paired, not mixed', () => {
  const message = summarize(many(6, i => kase(`m${i}`, 'standard', { jev: decided('share', { messageViolations: ['status_ping'] }), today: decided('share') }, { action: 'share' })));
  assert.equal(message.gate.pass, false); assert.ok(message.gate.reasons.includes('worse_message_contract'));
  assert.equal(message.jev.messageContract, 6); assert.equal(message.today.messageContract, 0);
  // Two lighter failures against one at today's effort on the same four states; six deep states where JEV kept today's
  // effort fail at today's effort. Mixed in, they made today's failure rate (0.7) look worse than the lighter one (0.5).
  const mixed = summarize([
    kase('p0', 'light', { jev: failed(), today: failed() }), kase('p1', 'light', { jev: failed(), today: decided('work') }), kase('p2', 'light', { jev: decided('work'), today: decided('work') }), kase('p3', 'light', { jev: decided('work'), today: decided('work') }),
    ...many(6, i => kase(`d${i}`, 'deep', { today: failed() })),
  ]);
  assert.ok(mixed.today.failureRate > mixed.jev.failureRate, 'the mixed rates favour the lighter effort');
  assert.equal(mixed.gate.pass, false); assert.ok(mixed.gate.reasons.includes('worse_failures'));
  assert.deepEqual([mixed.paired.jev.failures, mixed.paired.today.failures], [2, 1]); assert.ok(!mixed.gate.classesNotToLower.includes('deep'), 'deep states are not lowered at all');
});

test('gate: passes only on a clean, complete paired baseline in every lowered class; route-trial rows are no baseline (review RPL-5)', () => {
  const even = [...many(4, i => kase(`l${i}`, 'light', { jev: decided('work'), today: decided('work') })), ...many(4, i => kase(`s${i}`, 'standard', { jev: decided('wait'), today: decided('wait') }, { action: 'wait' }))];
  const pass = summarize(even);
  assert.equal(pass.gate.pass, true, pass.gate.reasons.join()); assert.deepEqual(pass.gate.reasons, []); assert.equal(pass.gate.covers, 'decision'); assert.deepEqual(pass.gate.classesNotToLower, []);
  const trial = summarize(many(4, i => kase(`t${i}`, 'light', { jev: decided('work'), today: decided('work') }, { clean: false })));
  assert.equal(trial.gate.pass, false); assert.ok(trial.gate.reasons.includes('no_clean_recorded_baseline')); assert.equal(trial.recorded.cases, 0);
  const unchecked = summarize(even.map((item, index) => index ? item : { ...item, runs: { ...item.runs, jev: decided('work', { messageChecked: false }) } }));
  assert.ok(unchecked.gate.reasons.includes('message_check_incomplete'));
  // A lowered class with no pair of its own is not lowered.
  const unmeasured = summarize([...many(4, i => kase(`l${i}`, 'light', { jev: decided('work'), today: decided('work') })), kase('s', 'standard', { jev: decided('work') })]);
  assert.deepEqual(unmeasured.gate.classesNotToLower, ['standard']); assert.ok(unmeasured.gate.reasons.includes('class_not_to_lower'));
  // Lighter runs without a pair still answer to their own recorded live first attempts.
  const recorded = summarize([...even, ...many(3, i => kase(`x${i}`, 'light', { jev: failed() }))]);
  assert.ok(recorded.gate.reasons.includes('more_first_attempt_failures_than_recorded')); assert.deepEqual(recorded.recorded.firstAttempt, { cases: 11, jevFailures: 3, recordedFailures: 0, messageUnchecked: 0 });
  assert.deepEqual(summarize([]).gate.reasons, ['no_lighter_runs', 'no_paired_baseline']);
});

async function fixture(t, { answer, decisions = { secrets: () => [], probe: async ({ questions }) => ({ status: 200, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0.01 }])) }) }, narrator = false, recordedTokens = 3000, linked = false }) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-replay-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = store.configurationService.provider(null, { name: 'GLM-like', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'glm-like', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['low', 'high', 'max'], compat: { thinkingFormat: 'zai' } }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'glm-like', reasoning: 'max' } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Replay fixture', description: 'Decisions to replay', workspace: dir });
  const capture = new EffortCapture({ stateFile: store.file }), sessionIds = linked ? [session.id] : [];
  const request = { project: { id: project.id, title: 'Replay fixture' }, events: [{ id: 'e1', type: 'user_message', summary: 'Please check the report.', at: Date.now() - 1000 }], availableActions: ['work', 'share'], promptActions: ['work', 'share'], recentActions: [], previousDecision: null, presence: {}, policy: { decisionMaxTokens: 2000 } };
  for (const [index, effort] of ['low', 'high', 'max'].entries()) {
    const id = capture.record(project.id, 'decision', { sessionIds, providerId: provider.id, modelId: 'glm-like', plan, verdict: { depth: ['light', 'standard', 'deep'][index], effort, source: 'jev', applied: false }, sent: 'max', call: { facts: { wakeSources: ['user message'] } }, request, at: new Date(Date.now() - (3 - index) * 60000).toISOString() });
    capture.outcome(project.id, 'decision', id, { status: 'decided', action: 'work', usage: { totalTokens: recordedTokens } });
  }
  if (narrator) {
    const id = capture.record(project.id, 'narrator', { sessionIds, providerId: provider.id, modelId: 'glm-like', outputCap: 3000, plan, verdict: { depth: 'light', effort: 'low', source: 'jev', applied: false }, sent: 'max', call: { facts: {}, rule: 'light' },
      request: { text: 'Nightly build: see run 9f86d081 for the two failures.', violations: [{ code: 'internal_id', repair: 'Describe the rest in plain words.' }], deliverable: 'The nightly build result', lessons: [] }, at: new Date(Date.now() - 30000).toISOString() });
    capture.outcome(project.id, 'narrator', id, { status: 'revised', recheck: [], result: 'revised', stopReason: 'stop', tokens: 900 });
  }
  const seen = [], ledger = new UsageLedger({ file: join(dir, 'state.json.usage-cache.jsonl') });
  const replay = new EffortReplay(store, { decisions, ledger, provider: async function* (input) { seen.push(input.model.reasoning); yield* answer(input, seen.length); } });
  return { store, replay, seen, project, session, ledger, dir };
}
const work = { action: 'work', title: 'Check the report', content: 'Read the report and list what is missing.', evidenceIds: ['E1'], reason: 'The user asked', nextReviewAfterMs: 60000 };
const answered = async function* () { yield { type: 'text_delta', delta: JSON.stringify(work) }; yield { type: 'usage', usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 } }; yield { type: 'done', stopReason: 'stop' }; };
// Project state, apart from the real-token accounting the replay is charged to.
const projectState = state => JSON.stringify({ ...state, revision: null, realUsage: null });

test('a replay refuses without approval, above the approved budget, or over its estimate; its spend is metered and charged, project state untouched', async t => {
  const f = await fixture(t, { answer: answered });
  assert.throws(() => f.replay.start({}), { code: 'replay_not_approved' });
  assert.throws(() => f.replay.start({ approved: true, budgetTokens: REPLAY_BUDGET_TOKENS + 1 }), { code: 'replay_over_budget' });
  assert.throws(() => f.replay.start({ approved: true, budgetTokens: 5000 }), { code: 'replay_estimate_over_budget' });
  const preview = f.replay.plan({ baseline: 2 });
  assert.equal(preview.selected, 3); assert.equal(preview.calls, 5); assert.equal(preview.withinBudget, true); assert.deepEqual(preview.covers, ['decision', 'narrator']);
  assert.deepEqual(preview.approval, { approved: REPLAY_BUDGET_TOKENS, spent: 0, remaining: REPLAY_BUDGET_TOKENS, approvals: 0 });
  const before = projectState(f.store.state);
  const job = f.replay.start({ approved: true, baseline: 2 });
  assert.equal(job.phase, 'running'); assert.throws(() => f.replay.start({ approved: true }), { code: 'replay_running' });
  await f.replay.promise;
  const status = f.replay.status().job;
  assert.equal(status.phase, 'completed'); assert.equal(status.done, 5); assert.equal(status.spentTokens, 5000);
  assert.deepEqual([...f.seen].sort(), ['high', 'low', 'max', 'max', 'max']);
  assert.equal(status.summary.jev.runs, 2); assert.equal(status.summary.today.runs, 3); assert.equal(status.summary.jev.agreementWithRecorded, 1);
  assert.equal(projectState(f.store.state), before, 'project state untouched');
  // ACC-6 / RPL-7: every call is a usage-ledger row of its own purpose and counts against the daily real-token cap.
  const rows = f.ledger.records();
  assert.equal(rows.length, 5); assert.ok(rows.every(row => row.purpose === 'evaluation' && row.detail === 'effort-replay' && !row.projectId && !row.sessionId));
  assert.deepEqual(rows.map(row => row.reasoning).sort(), ['high', 'low', 'max', 'max', 'max']);
  assert.equal(f.store.state.realUsage.tokens, 5000); assert.deepEqual(f.store.state.realUsage.reservations, {});
  const spend = JSON.parse(await readFile(join(`${f.store.file}.rna`, 'effort-probe', 'replay', 'spend.json'), 'utf8'));
  assert.deepEqual(spend.approvals.map(row => [row.tokens, row.kind, row.jobId]), [[REPLAY_BUDGET_TOKENS, 'initial', job.id]]);
  assert.equal(spend.jobs[job.id].spentTokens, 5000); assert.equal(spend.jobs[job.id].phase, 'completed');
  assert.deepEqual(f.replay.approval(), { approved: REPLAY_BUDGET_TOKENS, spent: 5000, remaining: REPLAY_BUDGET_TOKENS - 5000, approvals: 1 });
  const report = f.replay.report(job.id);
  assert.match(report.markdown, /Internal effort replay \(Stage B\)/); assert.match(report.markdown, /\*\*Gate \(decisions\):\*\* pass/);
  assert.match(report.markdown, /\*\*Next:\*\* `\.\/rna effort routing route --purposes decision`/); assert.match(report.markdown, /Covers decision and narrator only/);
  assert.doesNotMatch(report.markdown, /Please check the report/, 'no request text in the report');
  assert.equal(JSON.parse(await readFile(join(`${f.store.file}.rna`, 'effort-probe', 'replay', `${job.id}.json`), 'utf8')).id, job.id);
  assert.deepEqual(f.replay.reports(), [job.id], 'the spend record is not a report');
});

test('approval is cumulative: a start that does not fit what is left needs a further explicit approval, which is recorded (review RPL-7)', async t => {
  const f = await fixture(t, { answer: answered });
  const dir = join(`${f.store.file}.rna`, 'effort-probe', 'replay'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spend.json'), JSON.stringify({ version: 1, approvals: [{ at: '2026-10-04T00:00:00Z', tokens: REPLAY_BUDGET_TOKENS, kind: 'initial' }], jobs: { 'replay-old': { spentTokens: REPLAY_BUDGET_TOKENS - 5000, phase: 'cancelled' }, 'replay-lost': { spentTokens: 1000, inFlightTokens: 2000, phase: 'running' } } }));
  assert.deepEqual(f.replay.approval(), { approved: REPLAY_BUDGET_TOKENS, spent: REPLAY_BUDGET_TOKENS - 2000, remaining: 2000, approvals: 1 }, 'a run its daemon lost mid-call counts that call at its worst case');
  assert.throws(() => f.replay.start({ approved: true }), { code: 'replay_approval_spent' });
  assert.throws(() => f.replay.start({ approved: true, approveMore: REPLAY_BUDGET_TOKENS + 1 }), { code: 'invalid_replay' });
  const job = f.replay.start({ approved: true, approveMore: 100000 });
  assert.equal(job.budgetTokens, 102000); assert.equal(job.approval.approvedNow, 100000);
  await f.replay.promise;
  const spend = JSON.parse(await readFile(join(dir, 'spend.json'), 'utf8'));
  assert.deepEqual(spend.approvals.map(row => [row.tokens, row.kind]), [[REPLAY_BUDGET_TOKENS, 'initial'], [100000, 'additional']]);
  assert.equal(f.replay.status().job.phase, 'completed');
  // A record that exists but cannot be read is never taken for a fresh approval.
  await writeFile(join(dir, 'spend.json'), '{ not json');
  assert.equal(f.replay.approval().unreadable, true);
  assert.throws(() => f.replay.start({ approved: true }), { code: 'replay_record_unreadable' });
});

test('the daily real-token cap binds a replay: refused at start, or stopped before a call whose worst case it cannot reserve', async t => {
  const f = await fixture(t, { answer: answered, recordedTokens: 100 });
  f.store.mutate(state => { state.settings.realTokenBudget = 100; });
  assert.throws(() => f.replay.start({ approved: true, baseline: 0 }), { code: 'replay_daily_cap' });
  f.store.mutate(state => { state.settings.realTokenBudget = 1000; });
  f.replay.start({ approved: true, baseline: 0 });
  await f.replay.promise;
  const status = f.replay.status().job;
  assert.equal(status.phase, 'budget_stop'); assert.equal(status.stopReason, 'daily_cap'); assert.equal(status.done, 0); assert.equal(f.seen.length, 0);
  assert.equal(status.summary.gate.pass, false); assert.ok(status.summary.gate.reasons.includes('run_incomplete'));
});

test('a run stops before a call that could pass the budget; failures are classified', async t => {
  const f = await fixture(t, { answer: async function* (_input, n) { yield { type: 'text_delta', delta: JSON.stringify(n === 1 ? { ...work, evidenceIds: ['E9'] } : work) }; yield { type: 'usage', usage: { input: 9000, output: 1000, totalTokens: 10000 } }; yield { type: 'done', stopReason: 'stop' }; } });
  const first = f.replay.rows()[2], model = f.replay.resolve(first).model, ceiling = callCeiling(first, model);
  f.replay.start({ approved: true, baseline: 0, budgetTokens: ceiling + 9999 });
  await f.replay.promise;
  const status = f.replay.status().job;
  assert.equal(status.phase, 'budget_stop'); assert.equal(status.done, 1, 'the second call would have passed the budget');
  const failure = status.cases.flatMap(row => Object.values(row.runs)).find(run => run.status === 'failed');
  assert.equal(failure.code, 'invalid_decision'); assert.equal(failure.unknownEvidence, true);
});

test('a deleted conversation\'s captured requests are not sent once it is gone, even by a run already going (review RPL-1); progress is kept after every call', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { linked: true, answer: async function* (input, n) { if (n === 1) await gate; yield* answered(); } });
  const job = f.replay.start({ approved: true, baseline: 2 });
  while (!f.seen.length) await new Promise(resolve => setImmediate(resolve));
  // The conversation is deleted while the first call is in flight: the state drops it, the purge removes its rows.
  f.store.mutate(state => { state.sessions = state.sessions.filter(row => row.id !== f.session.id); });
  assert.equal(purgeEffortCaptures(f.store.file, f.session.id), 3);
  release(); await f.replay.promise;
  const status = f.replay.status().job;
  assert.equal(f.seen.length, 1, 'only the call already sent');
  const skipped = status.cases.flatMap(row => Object.values(row.runs)).filter(run => run.status === 'skipped');
  assert.equal(skipped.length, 4); assert.ok(skipped.every(run => run.reason === 'purged'));
  const spend = JSON.parse(await readFile(join(`${f.store.file}.rna`, 'effort-probe', 'replay', 'spend.json'), 'utf8'));
  assert.equal(spend.jobs[job.id].spentTokens, 1000); assert.equal(spend.jobs[job.id].inFlightTokens, 0);
});

test('a JEV probe failure keeps the deterministic message codes and marks the run unchecked (review RPL-12)', async t => {
  let probes = 0;
  const share = { action: 'share', title: 'Report ready', content: 'The report is ready.', evidenceIds: ['E1'], reason: 'Done', nextReviewAfterMs: 60000 };
  const f = await fixture(t, { decisions: { secrets: () => [], probe: async () => { probes++; throw Object.assign(new Error('JEV unreachable'), { status: 502, code: 'jev_unreachable' }); } }, answer: async function* () { yield { type: 'text_delta', delta: JSON.stringify(share) }; yield { type: 'usage', usage: { input: 900, output: 100, totalTokens: 1000 } }; yield { type: 'done', stopReason: 'stop' }; } });
  const project = { ...f.store.state.projects[0], inbox: [{ createdAt: new Date(Date.now() - 60000).toISOString(), kind: 'share', text: 'The report is ready.' }] };
  const check = await f.replay.messageCheck(project, [], 'The report is ready.', Date.now(), new AbortController().signal);
  assert.deepEqual(check, { deterministic: ['near_duplicate'], jev: null }); assert.equal(probes, 2, 'one retry');
  const [, , light] = f.replay.rows();
  const run = await f.replay.replayOne(light, 'jev', new AbortController().signal);
  assert.equal(run.status, 'decided'); assert.equal(run.messageChecked, false);
  const s = summarize([{ ...f.replay.caseRecord(light), runs: { jev: run, today: { ...run, messageChecked: true } } }]);
  assert.equal(s.jev.messageUnchecked, 1); assert.ok(s.gate.reasons.includes('message_check_incomplete'));
});

test('rewrites: only those whose JEV effort is lighter than today\'s, newest first, each at both efforts; the gate reads the recheck pass rate', () => {
  const rewrite = (id, effort, at, outcome = { status: 'revised', recheck: [], tokens: 9000 }) => ({ kind: 'call', purpose: 'narrator', id, at, projectId: 'p', plan, verdict: { depth: 'light', effort }, request: { text: 'm', violations: [{ code: 'internal_id', repair: 'r' }] }, outcome });
  const rows = [rewrite('a', 'low', '2026-10-04T01:00:00Z'), rewrite('b', 'max', '2026-10-04T02:00:00Z'), rewrite('c', 'high', '2026-10-04T03:00:00Z'), rewrite('d', 'low', '2026-10-04T04:00:00Z', null), { ...rewrite('e', 'low', '2026-10-04T05:00:00Z'), request: { text: 'm', violations: [] } }];
  assert.deepEqual(selectNarrator(rows, { narrator: 5 }).map(item => [item.row.id, item.conditions]), [['c', ['jev', 'today']], ['a', ['jev', 'today']]]);
  assert.equal(narratorEstimate(rows[0]), 9900); assert.ok(narratorCeiling(rows[0]) > 32768, 'worst case: the input plus the whole allowance');
  assert.ok(narratorCeiling(rows[0], { maxOutputTokens: 3000 }) < 32768, 'the resolved model\'s allowance');
  const run = (passed, status = 'revised') => ({ status, passed, recheck: passed ? [] : ['internal_id'], usage: { output: 100 }, tokens: 1000, latencyMs: 5 });
  const s = summarizeNarrator([
    { id: '1', recorded: { status: 'revised', passed: true }, runs: { jev: run(true), today: run(true) } },
    { id: '2', recorded: { status: 'revised', passed: true }, runs: { jev: run(false, 'length'), today: run(true) } },
  ]);
  assert.equal(s.jev.passRate, 0.5); assert.equal(s.today.passRate, 1); assert.equal(s.jev.lengthStops, 1); assert.equal(s.recorded.passRate, 1);
  assert.equal(s.gate.pass, false); assert.deepEqual(s.paired, { cases: 2, bothPassed: 1, jevFailedOnly: 1, todayFailedOnly: 0 });
  const unchecked = summarizeNarrator([{ id: '1', recorded: { status: 'revised', passed: true }, runs: { jev: run(null), today: run(true) } }]);
  assert.equal(unchecked.jev.unchecked, 1); assert.ok(unchecked.gate.reasons.includes('recheck_incomplete'));
});

test('a rewrite replay runs at both efforts and rechecks each revision as the live check does (deliverable included), never changing project state', async t => {
  const probes = [];
  const decisions = { secrets: () => [], probe: async ({ state, questions }) => { probes.push(Object.keys(questions)); const low = JSON.stringify(state).includes('LOW'); return { status: 200, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: id === 'internal_reference' && low ? 0.99 : 0.01 }])) }; } };
  const f = await fixture(t, { decisions, narrator: true, answer: async function* (input) { yield { type: 'text_delta', delta: input.model.reasoning === 'low' ? 'LOW revision: two parser tests fail.' : 'Two parser tests fail: empty input and large files.' }; yield { type: 'usage', usage: { input: 500, output: 200, totalTokens: 700 } }; yield { type: 'done', stopReason: 'stop' }; } });
  const preview = f.replay.plan({ cases: 0 });
  assert.equal(preview.selected, 0); assert.equal(preview.narrator.selected, 1); assert.equal(preview.calls, 2); assert.equal(preview.estimate, 2 * 990);
  const before = projectState(f.store.state);
  const job = f.replay.start({ approved: true, cases: 0 });
  await f.replay.promise;
  const status = f.replay.status().job;
  assert.equal(status.phase, 'completed'); assert.equal(status.done, 2); assert.equal(status.spentTokens, 1400);
  assert.deepEqual([...f.seen].sort(), ['low', 'max']);
  assert.ok(probes.every(keys => keys.includes('describes_instead_of_delivering')), 'the deliverable question is asked, as live');
  const [rewrite] = status.narrator;
  assert.deepEqual([rewrite.runs.jev.passed, rewrite.runs.jev.recheck, rewrite.runs.today.passed], [false, ['internal_id'], true]);
  assert.equal(status.summary.narrator.gate.pass, false); assert.equal(status.summary.narrator.paired.jevFailedOnly, 1);
  assert.equal(projectState(f.store.state), before, 'project state untouched');
  assert.ok(f.ledger.records().every(row => row.purpose === 'evaluation' && row.detail === 'effort-replay'));
  const report = f.replay.report(job.id);
  assert.match(report.markdown, /## Message rewrites \(narrator\)/); assert.match(report.markdown, /\*\*Gate \(rewrites\):\*\* not passed/);
  assert.doesNotMatch(report.markdown, /parser tests|Nightly build/, 'no message text in the report');
});

test('`rna effort replay` ends when the daemon no longer runs its job: from its report, or with a message (review RPL-8)', async () => {
  const id = 'replay-2026-10-05T00-00-00-000Z-abcdef12';
  const daemon = ({ reports }) => async (path, method = 'GET') => {
    if (path.startsWith('/v2/maintenance/effort-replay?') || path === '/v2/maintenance/effort-replay' && method === 'GET') return path.includes('?') ? { plan: { selected: 1, narrator: { selected: 0 }, calls: 2, estimate: 1000, options: { budgetTokens: REPLAY_BUDGET_TOKENS }, approval: { approved: REPLAY_BUDGET_TOKENS, spent: 0, remaining: REPLAY_BUDGET_TOKENS }, covers: ['decision', 'narrator'] } } : { running: false, job: null, reports };
    if (path === '/v2/maintenance/effort-replay' && method === 'POST') return { id, phase: 'running', done: 0, calls: 2, spentTokens: 0 };
    if (path.startsWith('/v2/maintenance/effort-replay/reports/')) return { id, json: { id, phase: 'interrupted', done: 1, calls: 2, spentTokens: 900 }, markdown: '# report' };
    throw new Error(`unexpected ${method} ${path}`);
  };
  // `/v2/maintenance/effort-replay` without a query is the status poll; the preview carries the options as a query.
  let polls = 0;
  const restarted = await runEffortCommand(['replay', '--approved', '--cases', '1'], daemon({ reports: [id] }), { wait: async () => { polls++; }, log: () => {} });
  assert.deepEqual([restarted.phase, restarted.spentTokens, restarted.markdown, polls], ['interrupted', 900, '# report', 1]);
  polls = 0;
  await assert.rejects(runEffortCommand(['replay', '--approved', '--cases', '1'], daemon({ reports: [] }), { wait: async () => { polls++; }, log: () => {} }), new RegExp(id));
  assert.equal(polls, 4, 'bounded');
  // A dry run while another replay runs: the daemon skips the plan, and the CLI says so.
  await assert.rejects(runEffortCommand(['replay'], async () => ({ running: true, job: { id }, plan: null }), { log: () => {} }), /已有回放在运行/);
});

test('daemon routes and the CLI: dry-run plan, refusal without approval, the capture and per-purpose routing switches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-routes-')), stateFile = join(dir, 'state.json');
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, method = 'GET', data) => { const response = await fetch(`${base}${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined }); const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code }); return result; };
  const status = await call('/v2/maintenance/effort-replay');
  assert.equal(status.running, false); assert.equal(status.plan.selected, 0); assert.equal(status.plan.options.budgetTokens, REPLAY_BUDGET_TOKENS); assert.equal(status.approval.remaining, REPLAY_BUDGET_TOKENS);
  await assert.rejects(call('/v2/maintenance/effort-replay', 'POST', {}), error => error.status === 400 && error.code === 'replay_not_approved');
  await assert.rejects(call('/v2/maintenance/effort-replay', 'POST', { approved: true }), error => error.status === 409 && error.code === 'replay_no_cases');
  const logs = [];
  assert.deepEqual((await runEffortCommand(['capture', 'on'], call)).setting, { mode: 'auto', routing: 'shadow', capture: true, purposes: ['decision', 'narrator'] });
  const routed = await runEffortCommand(['routing', 'route', '--purposes', 'decision'], call);
  assert.deepEqual(routed.setting, { mode: 'auto', routing: 'route', capture: true, purposes: ['decision'] }); assert.deepEqual(routed.routed, ['decision']);
  assert.deepEqual(routed.recordedOnly, ['narrator', 'work', 'setup', 'compaction'], 'background work is never routed by the switch');
  assert.deepEqual((await runEffortCommand(['routing', 'route'], call)).routed, ['decision', 'narrator']);
  assert.equal((await runEffortCommand(['status'], call)).setting.routing, 'route');
  assert.deepEqual((await runEffortCommand(['routing', 'shadow'], call)).routed, []);
  const dry = await runEffortCommand(['replay'], call, { log: line => logs.push(line) });
  assert.equal(dry.approved, false); assert.match(logs[0], /回放计划/); assert.match(logs[0], /剩余 2500000/);
  await assert.rejects(runEffortCommand(['routing', 'max'], call), /effort routing/);
  await assert.rejects(runEffortCommand(['routing', 'route', '--purposes', 'work'], call), /--purposes/);
  await assert.rejects(runEffortCommand(['replay', '--approve-more', '5'], call), /--approve-more/);
  await assert.rejects(call('/configuration', 'PATCH', { internalReasoning: { mode: 'fast' } }), error => error.status === 400);
  await assert.rejects(call('/configuration', 'PATCH', { internalReasoning: { purposes: ['work'] } }), error => error.status === 400);
});

test('a running replay never holds an update: it is not active work, starts no call while maintenance holds, and can be cancelled then (review RPL-9)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-effort-hold-')), stateFile = join(dir, 'state.json');
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const store = app.store, provider = store.configurationService.provider(null, { name: 'GLM-like', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'glm-like', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['low', 'high', 'max'], compat: { thinkingFormat: 'zai' } }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'glm-like', reasoning: 'max' } });
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Hold fixture', description: 'Replay under maintenance', workspace: dir });
  const capture = new EffortCapture({ stateFile: store.file }), request = { project: { id: project.id, title: 'Hold fixture' }, events: [{ id: 'e1', type: 'user_message', summary: 'Check.', at: Date.now() - 1000 }], availableActions: ['work'], promptActions: ['work'], recentActions: [], presence: {}, policy: { decisionMaxTokens: 2000 } };
  for (const effort of ['low', 'high']) { const id = capture.record(project.id, 'decision', { sessionIds: [], providerId: provider.id, modelId: 'glm-like', plan, verdict: { depth: effort === 'low' ? 'light' : 'standard', effort, source: 'jev', applied: false }, sent: 'max', request }); capture.outcome(project.id, 'decision', id, { status: 'decided', action: 'work', usage: { totalTokens: 1000 } }); }
  let calls = 0, release; const blocked = new Promise(resolve => { release = resolve; });
  app.effortReplay.provider = async function* (input) { calls++; await Promise.race([blocked, new Promise(resolve => input.signal?.addEventListener('abort', resolve, { once: true }))]); input.signal?.throwIfAborted(); yield* answered(); };
  app.effortReplay.start({ approved: true, baseline: 2 });
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.health().workload.activeWork, false, 'a replay is not work an update waits for');
  persistMaintenance(stateFile, initialMaintenance('backup', {}, randomUUID(), {})); app.maintenanceGate.refresh();
  assert.equal(app.maintenanceGate.held, true);
  release(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 1, 'no further call starts while maintenance holds new work');
  assert.equal(app.effortReplay.status().job.phase, 'maintenance_stop');
  // Cancelling is allowed during a hold (here nothing is left to cancel).
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/maintenance/effort-replay/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { cancelled: false });
});
