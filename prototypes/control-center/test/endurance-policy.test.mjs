import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../durable-files.mjs';
import { createEndurancePolicy, validateEndurancePolicy, createEnduranceCoverage, recordEnduranceCoverage, enduranceAssessment, recommendNextEnduranceWindow } from '../endurance-policy.mjs';
import { createEnduranceRun, recordEnduranceSample, EnduranceMonitor } from '../endurance-monitor.mjs';

// Synthetic time proves accounting and policy, never real wall-clock uptime.
const origin = Date.parse('2026-09-27T00:00:00Z'), runtimeIdentity = 'a'.repeat(64);
const row = (second, work = true, extras = {}) => ({ at: new Date(origin + second * 1000).toISOString(), healthy: true, instanceId: 'instance-a',
  workload: { activeWork: work, activeSessions: work ? 1 : 0, activeExecutions: work ? 1 : 0, memoryOperations: work ? 1 : 0, learningReviews: work ? 1 : 0, tokenUsage: { reported: second, estimated: 0, reserved: 0 }, completedScheduledOccurrences: second >= 60 ? 1 : 0 }, ...extras });
function finish(run, { work = true, failureAt = -1 } = {}) {
  for (let second = 0; second <= run.targetSeconds; second += 60) run = recordEnduranceSample(run, row(second, work, second === failureAt ? { healthy: false, issue: 'RSS_LIMIT' } : {}));
  return run;
}
const startup = () => finish(createEnduranceRun({ id: 'startup', now: origin, runtimeIdentity }));

test('default selects one bounded adaptive startup window; explicit hours remain a fixed contract', () => {
  const plan = createEndurancePolicy(); assert.equal(plan.mode, 'adaptive'); assert.equal(plan.targetHours, 2); assert.equal(plan.stage, 'startup'); assert.deepEqual(plan.requiredCoverage, []);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.profileCoverage), true);
  for (const hours of [.01, 2, 26, 120, 8760]) { const run = createEnduranceRun({ id: 'explicit', hours }); assert.equal(run.policy.mode, 'fixed'); assert.equal(run.targetHours, hours); assert.equal(run.targetSeconds, hours * 3600); assert.equal(run.keepAwake, false); }
  for (const hours of [0, -1, NaN, Infinity, '2', null, 8761]) assert.throws(() => createEndurancePolicy({ hours }));
});

test('same implementation and observed workload advance 2 to 8 to 26, then advise stopping without another automatic window', () => {
  const a = startup(); assert.equal(a.passed, true); assert.equal(a.assessment.scope, 'startup_availability_only');
  const b = finish(createEnduranceRun({ id: 'workload', now: origin + 1, runtimeIdentity, previousRuns: [a] }));
  assert.equal(b.targetHours, 8); assert.equal(b.passed, true); assert.deepEqual(b.assessment.missingCoverage, []);
  const c = finish(createEnduranceRun({ id: 'cycle', now: origin + 2, runtimeIdentity, previousRuns: [a, b] }));
  assert.equal(c.targetHours, 26); assert.equal(c.passed, true); assert.equal(c.assessment.lifetimeAcceptance, false);
  assert.deepEqual(recommendNextEnduranceWindow(c), { action: 'window_evidence_sufficient', nextHours: null, reason: 'profile_window_observed_not_lifetime_proof' });
  assert.equal(c.policy.automaticNextWindow, false);
});

test('idle healthy time is not foreground or memory coverage and does not advance the workload stage', () => {
  const a = startup(), b = finish(createEnduranceRun({ id: 'idle', now: origin + 1, runtimeIdentity, previousRuns: [a] }), { work: false });
  assert.equal(b.targetHours, 8); assert.equal(b.assessment.availabilityPassed, true); assert.equal(b.passed, false); assert.equal(b.assessment.verdict, 'coverage_incomplete');
  assert.deepEqual(b.assessment.missingCoverage, ['foreground', 'memory']);
  assert.equal(b.assessment.coverage.idle, 'observed_healthy'); assert.equal(b.assessment.historicalFaultsRetained, false);
  const next = createEndurancePolicy({ previousRuns: [b], runtimeIdentity }); assert.equal(next.targetHours, 8); assert.equal(next.reviewRequired, false); assert.equal(next.reason, 'coverage_not_observed');
  assert.equal(b.recommendation.action, 'observe_missing_workload');
});

test('a fault cannot be washed out by later recovery, shortening or selecting a preceding healthy run', () => {
  const a = startup(), b = finish(createEnduranceRun({ id: 'faulted', now: origin + 1, runtimeIdentity, previousRuns: [a] }), { failureAt: 60 });
  assert.equal(b.passed, false); assert.equal(b.assessment.verdict, 'window_failed'); assert.equal(b.coverage.recoveredTransitions, 1); assert.equal(b.unhealthySamples, 1);
  const frozen = JSON.stringify(b), plan = createEndurancePolicy({ previousRuns: [b, a], runtimeIdentity });
  assert.equal(plan.stage, 'startup'); assert.equal(plan.targetHours, 2); assert.equal(plan.reviewRequired, true); assert.equal(plan.predecessor.id, b.id); assert.equal(plan.predecessor.faulted, true);
  assert.equal(plan.predecessor.targetHours, 8); assert.equal(plan.history.faultedRuns, 1); assert.equal(JSON.stringify(b), frozen);
  assert.equal(recommendNextEnduranceWindow(b).action, 'review_fault_before_next_window');
});

test('legacy, changed implementation, altered coverage profile and incomplete time never advance a stage', () => {
  const a = startup();
  for (const previous of [{ ...a, policy: undefined }, { ...a, status: 'stopped', passed: null }, { ...a, elapsedWallSeconds: 1 }, { ...a, observedHealthySeconds: 0 }]) {
    assert.equal(createEndurancePolicy({ previousRuns: [previous], runtimeIdentity }).stage, 'startup');
  }
  assert.equal(createEndurancePolicy({ previousRuns: [a], runtimeIdentity: 'b'.repeat(64) }).stage, 'startup');
  assert.equal(createEndurancePolicy({ previousRuns: [a] }).stage, 'startup');
  assert.equal(createEndurancePolicy({ previousRuns: [a], runtimeIdentity, requiredCoverage: ['learning'] }).stage, 'startup');
});

test('running target stays immutable even when a shorter future diagnostic window would be useful', () => {
  const fixed = recordEnduranceSample(createEnduranceRun({ id: 'existing', hours: 120, runtimeIdentity }), row(0, false, { healthy: false }));
  const old = JSON.stringify(fixed); const advice = recommendNextEnduranceWindow(fixed);
  assert.equal(advice.action, 'finish_current_window'); assert.equal(advice.currentTargetHours, 120); assert.equal(advice.nextHours, null);
  assert.equal(JSON.stringify(fixed), old); assert.equal(fixed.passed, null);
  fixed.status = 'stopped'; assert.equal(recommendNextEnduranceWindow(fixed).action, 'operator_choice');
});

test('legacy fixed run preserves its original target and pass semantics without a policy migration', () => {
  let run = createEnduranceRun({ id: 'legacy', hours: .05, now: origin }); delete run.policy; delete run.coverage; delete run.assessment; delete run.recommendation; run.schemaVersion = 1;
  for (let second = 0; second <= 180; second += 60) run = recordEnduranceSample(run, row(second, false));
  assert.equal(run.targetHours, .05); assert.equal(run.schemaVersion, 1); assert.equal(run.policy, undefined); assert.equal(run.passed, true); assert.equal(run.assessment.mode, 'fixed');
});

test('coverage distinguishes unavailable metadata, known idle and actually observed activities', () => {
  const a = recordEnduranceCoverage(undefined, { healthy: true }, null);
  assert.equal(a.samples, 1); assert.equal(a.kinds.foreground.availableSamples, 0);
  const b = recordEnduranceCoverage(a, row(0, false), null);
  assert.equal(b.kinds.foreground.availableSamples, 1); assert.equal(b.kinds.foreground.observedSamples, 0);
  assert.equal(b.kinds.idle.healthyObservedSamples, 1); assert.equal(b.kinds.model_progress.healthyObservedSamples, 0); assert.equal(b.kinds.scheduled_delivery.healthyObservedSamples, 0);
  assert.equal(enduranceAssessment({ status: 'running', coverage: a }).coverage.foreground, 'unknown');
  assert.equal(enduranceAssessment({ status: 'running', coverage: b }).coverage.foreground, 'not_observed');
});

test('historical counters, resets, observation gaps and changed daemon cannot manufacture model or scheduled progress', () => {
  const first = row(0); first.workload.tokenUsage.reported = 9000; first.workload.completedScheduledOccurrences = 50;
  let coverage = recordEnduranceCoverage(undefined, first, null);
  assert.equal(coverage.kinds.model_progress.observedSamples, 0); assert.equal(coverage.kinds.scheduled_delivery.observedSamples, 0);
  coverage = recordEnduranceCoverage(coverage, row(60), first);
  assert.equal(coverage.usageCounterResets, 1); assert.equal(coverage.scheduledCounterResets, 1);
  const later = row(120); later.workload.completedScheduledOccurrences = 2;
  const missing = recordEnduranceCoverage(coverage, later, row(60), { continuity: false });
  assert.equal(missing.kinds.model_progress.observedSamples, 0); assert.equal(missing.kinds.scheduled_delivery.observedSamples, 0);
  const actual = recordEnduranceCoverage(coverage, later, row(60));
  assert.equal(actual.kinds.model_progress.healthyObservedSamples, 1); assert.equal(actual.kinds.scheduled_delivery.healthyObservedSamples, 1);
  let run = recordEnduranceSample(createEnduranceRun({ id: 'restart', now: origin }), first);
  run = recordEnduranceSample(run, { ...later, instanceId: 'instance-b' });
  assert.equal(run.coverage.kinds.scheduled_delivery.observedSamples, 0); assert.equal(run.coverage.kinds.model_progress.observedSamples, 0);
});

test('counter progress crossing an unhealthy sample is retained as degraded evidence, not healthy coverage', () => {
  const previous = row(0, false, { healthy: false }), sample = row(60, false);
  sample.dependencies = { memory: { sync: { counts: { completed: 2 } } } }; previous.dependencies = { memory: { sync: { counts: { completed: 1 } } } };
  const coverage = recordEnduranceCoverage(undefined, sample, previous);
  for (const kind of ['memory', 'model_progress', 'scheduled_delivery']) { assert.equal(coverage.kinds[kind].observedSamples, 1); assert.equal(coverage.kinds[kind].healthyObservedSamples, 0); }
  assert.equal(coverage.recoveredTransitions, 1);
});

test('scheduled work is required only by its selected profile; missing host counters stay explicitly unknown', () => {
  const requiredCoverage = ['scheduled_delivery'], a = finish(createEnduranceRun({ id: 'schedule-smoke', now: origin, runtimeIdentity, requiredCoverage }));
  let b = createEnduranceRun({ id: 'schedule-work', now: origin + 1, runtimeIdentity, requiredCoverage, previousRuns: [a] });
  for (let second = 0; second <= b.targetSeconds; second += 60) { const value = row(second); delete value.workload.completedScheduledOccurrences; b = recordEnduranceSample(b, value); }
  assert.equal(b.passed, false); assert.equal(b.assessment.coverage.scheduled_delivery, 'unknown'); assert.deepEqual(b.assessment.missingCoverage, ['scheduled_delivery']);
  const c = finish(createEnduranceRun({ id: 'scheduled', now: origin + 2, runtimeIdentity, requiredCoverage, previousRuns: [b] }));
  assert.equal(c.targetHours, 8); assert.equal(c.passed, true); assert.equal(c.coverage.kinds.scheduled_delivery.observedSamples, 1);
});

test('plan hashes and exact schema prevent silent target/profile tampering', () => {
  const plan = createEndurancePolicy({ runtimeIdentity }); assert.deepEqual(validateEndurancePolicy(plan), plan);
  for (const change of [p => { p.targetHours = 1; }, p => { p.requiredCoverage = ['memory']; }, p => { p.automaticNextWindow = true; }, p => { p.newField = 'injected'; }]) { const p = structuredClone(plan); change(p); assert.throws(() => validateEndurancePolicy(p)); }
  const p = structuredClone(plan); p.history.privateText = 'must not persist'; const { hash, ...body } = p; p.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex'); assert.throws(() => validateEndurancePolicy(p));
  assert.throws(() => createEnduranceRun({ id: 'conflict', policy: plan, hours: 120 }));
  assert.throws(() => createEndurancePolicy({ runtimeIdentity: 'unknown' }));
  assert.throws(() => createEndurancePolicy({ requiredCoverage: ['memory', 'memory'] }));
});

test('history summary is bounded and never copies workload bodies or private diagnostics', () => {
  const secret = 'PRIVATE PROJECT transcript credential';
  const plan = createEndurancePolicy({ previousRuns: [{ id: secret, requestedAt: '', status: 'stopped', samples: 1, targetHours: 120, lastSample: { private: secret }, lastIssue: { text: secret }, unhealthySamples: 1 }] });
  assert.equal(JSON.stringify(plan).includes(secret), false); assert.match(plan.predecessor.id, /^[a-f0-9]{64}$/);
  assert.throws(() => createEndurancePolicy({ previousRuns: Array(257).fill({}) }));
});

test('supervisor acknowledgement preserves selected policy but reconstructs all counters and coverage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-endurance-policy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = startup(), proposed = createEnduranceRun({ id: 'new-stage', now: origin + 1, runtimeIdentity, previousRuns: [a] });
  proposed.coverage.kinds.memory.healthyObservedSamples = 1000; proposed.samples = 500; proposed.passed = true;
  atomicWrite(join(dir, 'endurance-request.json'), JSON.stringify({ requestId: 'new-request', action: 'start', run: proposed }));
  const monitor = new EnduranceMonitor(dir), accepted = monitor.consumeRequest({ at: origin + 2 });
  assert.equal(accepted.targetHours, 8); assert.equal(accepted.policy.hash, proposed.policy.hash); assert.equal(accepted.samples, 0); assert.equal(accepted.passed, null); assert.equal(accepted.coverage.kinds.memory.healthyObservedSamples, 0);
  atomicWrite(join(dir, 'endurance-request.json'), JSON.stringify({ requestId: 'stop', action: 'stop', runId: accepted.id }));
  const stopped = monitor.consumeRequest({ at: origin + 3 }); assert.equal(stopped.targetHours, 8); assert.equal(stopped.assessment.verdict, 'stopped'); assert.equal(stopped.recommendation.nextHours, 8);
  assert.equal(JSON.parse(readFileSync(monitor.path)).status, 'stopped');
});

test('virtual fault tests and partial windows never add historical seconds or replace a failed archived result', () => {
  const failed = finish(createEnduranceRun({ id: 'failed', hours: .05, now: origin }), { failureAt: 60 });
  const copy = JSON.stringify(failed), next = createEnduranceRun({ id: 'fresh', now: origin + 1000, previousRuns: [failed], runtimeIdentity });
  assert.equal(next.observedHealthySeconds, 0); assert.equal(next.samples, 0); assert.equal(next.assessment.isolatedFaultTestsContributeSeconds, 0); assert.equal(next.passed, null);
  assert.equal(JSON.stringify(failed), copy); assert.equal(failed.passed, false);
});

test('same-run history snapshots are deduplicated and a later incomplete stage never borrows an earlier passed window', () => {
  const first = startup(), partial = createEnduranceRun({ id: 'partial-workload', now: origin + 1, runtimeIdentity, previousRuns: [first] });
  partial.status = 'stopped'; const plan = createEndurancePolicy({ previousRuns: [first, first, partial], runtimeIdentity });
  assert.equal(plan.history.runs, 2); assert.equal(plan.stage, 'workload'); assert.equal(plan.reason, 'prior_window_incomplete'); assert.equal(plan.predecessor.passed, null);
});

test('an acknowledged invalid policy request leaves the active target, coverage and result intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-endurance-tamper-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const current = createEnduranceRun({ id: 'existing-120', hours: 120, now: origin }); atomicWrite(join(dir, 'endurance.json'), JSON.stringify(current));
  const forged = createEnduranceRun({ id: 'forged', now: origin + 1, runtimeIdentity }); forged.policy = { ...forged.policy, targetHours: .01 };
  atomicWrite(join(dir, 'endurance-request.json'), JSON.stringify({ requestId: 'bad', action: 'start', run: forged }));
  const observed = new EnduranceMonitor(dir).consumeRequest({ at: origin + 2 });
  assert.equal(observed.lastRequest.reason, 'invalid_start_request'); assert.equal(observed.id, current.id); assert.equal(observed.targetHours, 120); assert.equal(observed.passed, null); assert.deepEqual(observed.coverage, current.coverage);
});

test('legacy explicit start requests remain fixed and ignore supplied uptime or isolated-test claims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-endurance-legacy-request-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance-request.json'), JSON.stringify({ requestId: 'legacy', action: 'start', run: { id: 'legacy-120', requestedAt: new Date(origin).toISOString(), targetHours: 120, keepAwake: false, sampleIntervalMs: 60000, passed: true, observedHealthySeconds: 432000, isolatedFaultTests: { passed: true, hours: 120 } } }));
  const run = new EnduranceMonitor(dir).consumeRequest({ at: origin }); assert.equal(run.policy.mode, 'fixed'); assert.equal(run.targetHours, 120); assert.equal(run.samples, 0); assert.equal(run.observedHealthySeconds, 0); assert.equal(run.isolatedFaultTests, undefined); assert.equal(run.passed, null);
});

test('fixed explicit windows retain availability semantics even when a different adaptive profile was requested', () => {
  const run = finish(createEnduranceRun({ id: 'explicit-schedule', now: origin, hours: .05, requiredCoverage: ['scheduled_delivery'] }), { work: false });
  assert.equal(run.passed, true); assert.equal(run.policy.mode, 'fixed'); assert.deepEqual(run.policy.requiredCoverage, []); assert.equal(run.targetHours, .05);
});

test('activity and completed counters trigger bounded observations before the normal minute interval', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-endurance-short-work-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicWrite(join(dir, 'endurance.json'), JSON.stringify(createEnduranceRun({ id: 'short-work', now: origin })));
  const monitor = new EnduranceMonitor(dir), health = { ok: true, process: { instanceId: 'one' }, workload: { activeWork: false, activeExecutions: 0, tokenUsage: { reported: 0 }, completedScheduledOccurrences: 0 }, dependencies: { memory: { sync: { counts: { completed: 0 } } } } };
  assert.equal(monitor.sample(health, { at: origin }).samples, 1);
  health.workload.activeWork = true; health.workload.activeExecutions = 1;
  const busy = monitor.sample(health, { at: origin + 1000 }); assert.equal(busy.samples, 2); assert.equal(busy.coverage.kinds.foreground.healthyObservedSamples, 1);
  health.workload.tokenUsage.reserved = 1000; assert.equal(monitor.sample(health, { at: origin + 1500 }).samples, 2, 'reservation changes do not manufacture progress observations');
  health.workload.activeWork = false; health.workload.activeExecutions = 0; health.workload.tokenUsage.reported = 100;
  health.workload.completedScheduledOccurrences = 1; health.dependencies.memory.sync.counts.completed = 1;
  const complete = monitor.sample(health, { at: origin + 2000 }); assert.equal(complete.samples, 3);
  for (const kind of ['memory', 'model_progress', 'scheduled_delivery']) assert.equal(complete.coverage.kinds[kind].healthyObservedSamples, 1);
  assert.equal(monitor.sample(health, { at: origin + 2500 }).samples, 3);
});
