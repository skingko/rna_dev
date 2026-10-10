import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { createEndurancePolicy, validateEndurancePolicy, createEnduranceCoverage, recordEnduranceCoverage, enduranceCoverageObservationKey, enduranceAssessment, recommendNextEnduranceWindow } from './endurance-policy.mjs';
export { createEndurancePolicy, enduranceAssessment, recommendNextEnduranceWindow } from './endurance-policy.mjs';

const diagnosticCode = value => value == null ? null : typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value) ? value : 'diagnostic_redacted';
const diagnosticBoolean = value => typeof value === 'boolean' ? value : null;
const diagnosticCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const diagnosticId = value => typeof value !== 'string' ? null : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : `sha256:${createHash('sha256').update(value).digest('hex')}`;
const diagnosticTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Keep the causes that /health aggregates, not reflection text, source context,
// provider errors or arbitrary future health fields. This projection does not
// reinterpret health or change when a sample is admitted.
function learningDiagnostics(learning) {
  if (!learning || typeof learning !== 'object') return null;
  const projects = Array.isArray(learning.projects) ? learning.projects : [];
  const hasIssue = project => Boolean(project?.lastError || project?.persistenceError || project?.unsettledOperations);
  // Prefer projects contributing to degraded health if the diagnostic bound is
  // reached; retain counts so omitted projects cannot look like an empty lane.
  const selected = [];
  for (const issue of [true, false]) for (const project of projects) if (selected.length < 64 && hasIssue(project) === issue) selected.push(project);
  return { lastError: diagnosticCode(learning.lastError), projectCount: projects.length,
    issueProjectCount: projects.filter(hasIssue).length, omittedProjects: projects.length - selected.length,
    projects: selected.map(project => ({ projectId: diagnosticId(project?.projectId), reviewId: diagnosticId(project?.reviewId),
      closed: diagnosticBoolean(project?.closed), inFlight: diagnosticBoolean(project?.inFlight),
      ...Object.fromEntries(['unsettledOperations', 'pending', 'deferred', 'awaitingEvidence', 'queued', 'interrupted', 'retainedEpisodes', 'seen'].map(key => [key, diagnosticCount(project?.[key])])),
      nextReviewAt: diagnosticTime(project?.nextReviewAt), experimentNotBefore: diagnosticTime(project?.experimentNotBefore),
      lastResult: diagnosticCode(project?.lastResult), lastError: diagnosticCode(project?.lastError), persistenceError: diagnosticCode(project?.persistenceError) })) };
}

/** Bounded operational logs; model transcripts and evidence use their own
 * immutable archives and are never removed by log rotation. */
export function appendRotated(path, content, { maxBytes = 2 * 1024 * 1024, copies = 3 } = {}) {
  let size = 0;
  try { size = statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size + Buffer.byteLength(content) > maxBytes) {
    try { unlinkSync(`${path}.${copies}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let i = copies - 1; i >= 0; i--) {
      try { renameSync(i ? `${path}.${i}` : path, `${path}.${i + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  // Even one pathological stderr chunk may not defeat the size bound.
  const bytes = Buffer.from(content);
  appendFileSync(path, bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes, { mode: 0o600 });
}

export function createEnduranceRun({ id, hours, policy, previousRuns = [], runtimeIdentity = null, requiredCoverage, keepAwake = false, now = Date.now(), sampleIntervalMs = 60000 }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id) || typeof keepAwake !== 'boolean' || !Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 1 || sampleIntervalMs > 86400000) throw new Error('耐久观测参数无效');
  const plan = policy ? validateEndurancePolicy(policy) : createEndurancePolicy({ hours, previousRuns, runtimeIdentity, requiredCoverage });
  if (hours !== undefined && hours !== plan.targetHours) throw new Error('耐久观测目标与冻结计划不一致');
  const run = { schemaVersion: 2, id, status: 'running', requestedAt: new Date(now).toISOString(), startedAt: null,
    targetHours: plan.targetHours, targetSeconds: plan.targetHours * 3600, keepAwake, sampleIntervalMs, policy: plan, coverage: createEnduranceCoverage(),
    samples: 0, healthySamples: 0, unhealthySamples: 0, observedHealthySeconds: 0,
    observedUnavailableSeconds: 0, unobservedSeconds: 0, longestHealthySeconds: 0,
    currentHealthySeconds: 0, daemonRestarts: 0, managedHelperRestarts: 0, clockDiscontinuities: 0,
    maxRssBytes: 0, maxStateBytes: 0, minimumDiskFreeBytes: null, completedAt: null,
    passed: null, lastSample: null, lastIssue: null };
  run.assessment = enduranceAssessment(run); run.recommendation = recommendNextEnduranceWindow(run); return run;
}

/** A virtual clock test can exercise this accounting, but cannot manufacture
 * real uptime. Only actual observations from the supervisor feed live files. */
export function recordEnduranceSample(run, sample) {
  if (run.status !== 'running') return run;
  const next = structuredClone(run), at = sample.at;
  next.startedAt ??= at;
  const previous = next.lastSample;
  const delta = previous ? (Date.parse(at) - Date.parse(previous.at)) / 1000 : 0;
  const healthy = sample.healthy === true;
  // The direct managed spawn generation is available even when a child never
  // reaches HTTP readiness. HTTP instance IDs remain a legacy fallback, not a
  // second counter that could charge the same replacement twice.
  const managed = sample.managedDaemon;
  const restarted = managed
    ? Boolean(next.lastKnownDaemon && (next.lastKnownDaemon.supervisorRunId !== managed.supervisorRunId || next.lastKnownDaemon.generation !== managed.generation))
    : !next.lastKnownDaemon && Boolean(next.lastKnownInstanceId && sample.instanceId && next.lastKnownInstanceId !== sample.instanceId);
  if (managed) next.lastKnownDaemon = { supervisorRunId: managed.supervisorRunId, generation: managed.generation, pid: managed.pid ?? null };
  let helperRestarts = 0;
  next.lastKnownHelpers ??= {};
  for (const helper of sample.managedHelpers ?? []) {
    const old = next.lastKnownHelpers[helper.id];
    const counterDelta = old ? Math.max(0, (helper.restarts ?? 0) - (old.restarts ?? 0)) : 0;
    const generationChanged = old?.generation && helper.generation && old.generation !== helper.generation;
    // Preserve A through an unavailable sample, including supervisor counter
    // reset; but do not count A -> backoff(counter+1) -> B twice.
    if (old) helperRestarts += Math.max(counterDelta, generationChanged && !old.awaitingGeneration ? 1 : 0);
    next.lastKnownHelpers[helper.id] = { generation: helper.generation ?? old?.generation ?? null, restarts: helper.restarts ?? 0,
      awaitingGeneration: !helper.generation && Boolean(old?.awaitingGeneration || counterDelta) };
  }
  next.managedHelperRestarts = (next.managedHelperRestarts ?? 0) + helperRestarts;
  if (sample.instanceId) next.lastKnownInstanceId = sample.instanceId;
  if (restarted) next.daemonRestarts++;
  if (previous) {
    // A sleep, monitor restart or clock discontinuity is never silently counted
    // as availability, even if the next HTTP request succeeds.
    if (delta < 0 || sample.monotonicDeltaSeconds < 0 || Math.abs(delta - (sample.monotonicDeltaSeconds ?? delta)) > 5) {
      next.clockDiscontinuities++; next.unobservedSeconds += Math.max(0, delta); next.currentHealthySeconds = 0;
      next.lastIssue = { at, reason: 'clock_discontinuity' };
    } else if (delta > next.sampleIntervalMs / 1000 * 2.5 || sample.monitorRestarted || restarted || helperRestarts) {
      next.unobservedSeconds += delta; next.currentHealthySeconds = 0;
      next.lastIssue = { at, reason: restarted ? 'daemon_restarted' : helperRestarts ? 'managed_helper_restarted' : 'observation_gap', seconds: delta };
    } else if (healthy && previous.healthy) {
      next.observedHealthySeconds += delta; next.currentHealthySeconds += delta;
      next.longestHealthySeconds = Math.max(next.longestHealthySeconds, next.currentHealthySeconds);
    } else {
      next.observedUnavailableSeconds += delta; next.currentHealthySeconds = 0;
      next.lastIssue = { at, reason: sample.issue ?? previous.issue ?? 'unhealthy', seconds: delta };
    }
  }
  next.samples++; next[healthy ? 'healthySamples' : 'unhealthySamples']++;
  if (!healthy) next.lastIssue = { at, reason: sample.issue ?? 'unhealthy' };
  next.maxRssBytes = Math.max(next.maxRssBytes, sample.rssBytes ?? 0);
  next.maxStateBytes = Math.max(next.maxStateBytes, sample.stateBytes ?? 0);
  if (Number.isFinite(sample.diskFreeBytes)) next.minimumDiskFreeBytes = Math.min(next.minimumDiskFreeBytes ?? Infinity, sample.diskFreeBytes);
  next.lastSample = sample;
  next.elapsedWallSeconds = Math.max(0, (Date.parse(at) - Date.parse(next.startedAt)) / 1000);
  const continuity = Boolean(previous && delta >= 0 && delta <= next.sampleIntervalMs / 1000 * 2.5 && !sample.monitorRestarted && !restarted && !helperRestarts && !(sample.monotonicDeltaSeconds < 0) && Math.abs(delta - (sample.monotonicDeltaSeconds ?? delta)) <= 5);
  next.coverage = recordEnduranceCoverage(next.coverage, sample, previous, { continuity });
  // Completion is a recorded result (pass or fail), never an assertion merely
  // because the process was launched with --hours 100.
  if (next.elapsedWallSeconds >= next.targetSeconds) {
    next.status = 'completed'; next.completedAt = at;
    next.passed = next.observedHealthySeconds >= next.targetSeconds && next.unhealthySamples === 0 && next.unobservedSeconds === 0 && next.daemonRestarts === 0 && next.managedHelperRestarts === 0 && next.clockDiscontinuities === 0 && enduranceAssessment(next).coverageSatisfied;
  }
  next.assessment = enduranceAssessment(next); next.recommendation = recommendNextEnduranceWindow(next);
  return next;
}

export class EnduranceMonitor {
  constructor(directory) { this.directory = directory; this.path = `${directory}/endurance.json`; this.requestPath = `${directory}/endurance-request.json`; this.log = `${directory}/endurance-samples.jsonl`; this.lastRunId = null; this.lastMonotonic = null; }
  /** The supervisor is the only live report writer. A CLI replaces the request
   * file under its operation lease, then waits for this durable acknowledgement.
   * Even if it arrives during a sample commit, the request remains pending for
   * the next poll; an acknowledged stop can never be overwritten by a sample.
   * Keep the request file: deleting it could delete a newer CLI request. */
  consumeRequest({ at = Date.now() } = {}) {
    const request = readJSON(this.requestPath), current = readJSON(this.path);
    if (!request || request.requestId === current?.lastRequestId) return current;
    if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 200) throw new Error('耐久观测控制请求缺少有效 requestId');
    const acknowledge = (run, status, reason) => {
      const next = { ...(run ?? { status: 'not_started' }), lastRequestId: request.requestId,
        lastRequest: { requestId: request.requestId, action: request.action, status, ...(reason ? { reason } : {}), at: new Date(at).toISOString() } };
      if (next.id) { next.assessment = enduranceAssessment(next); next.recommendation = recommendNextEnduranceWindow(next); }
      atomicWrite(this.path, JSON.stringify(next, null, 2)); return next;
    };
    if (request.action === 'stop') {
      if (!current?.id || current.id !== request.runId) return acknowledge(current, 'ignored', 'run_id_mismatch');
      if (current.status !== 'running') return acknowledge(current, 'ignored', 'run_not_running');
      return acknowledge({ ...current, status: 'stopped', stoppedAt: new Date(at).toISOString(), passed: null }, 'applied');
    }
    if (request.action !== 'start') return acknowledge(current, 'ignored', 'invalid_action');
    let run;
    try {
      const input = request.run;
      if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.id) || typeof input.requestedAt !== 'string' || !Number.isFinite(Date.parse(input.requestedAt)) || typeof input.keepAwake !== 'boolean' || !Number.isFinite(input.sampleIntervalMs) || input.sampleIntervalMs < 1 || input.sampleIntervalMs > 86400000) throw new Error('invalid run');
      // Reconstruct counters; a command cannot manufacture prior uptime or a
      // successful score by supplying fields in its proposed run object.
      run = createEnduranceRun({ id: input.id, hours: input.targetHours, ...(input.policy ? { policy: input.policy } : {}), keepAwake: input.keepAwake, now: Date.parse(input.requestedAt), sampleIntervalMs: input.sampleIntervalMs });
    } catch { return acknowledge(current, 'ignored', 'invalid_start_request'); }
    if (run.id === current?.id) return acknowledge(current, 'ignored', 'run_already_processed');
    if (current?.status === 'running') return acknowledge(current, 'ignored', 'already_running');
    // CLI requests are serialized; an older (or same-clock) delayed start must
    // not resurrect a replaced run after a later run has already stopped.
    if (current?.requestedAt && Date.parse(run.requestedAt) <= Date.parse(current.requestedAt)) return acknowledge(current, 'ignored', 'stale_start_request');
    if (current?.id) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(current.id)) throw new Error('旧耐久观测标识无效，已保留现有记录');
      const content = JSON.stringify(current, null, 2), primary = `${this.directory}/endurance-${current.id}.json`, existing = readJSON(primary);
      if (existing === null) atomicWrite(primary, content);
      else if (JSON.stringify(existing) !== JSON.stringify(current)) {
        // A crash can leave an earlier archive of this run. Preserve both
        // revisions rather than overwrite any previously archived evidence.
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16), path = `${this.directory}/endurance-${current.id}-${hash}.json`, same = readJSON(path);
        if (same === null) atomicWrite(path, content);
        else if (JSON.stringify(same) !== JSON.stringify(current)) throw new Error('耐久观测历史归档指纹冲突');
      }
    }
    const next = acknowledge(run, 'applied'); this.lastRunId = null; this.lastMonotonic = null; return next;
  }
  sample(health, { at = Date.now(), diskFreeBytes = null, issue = null, managedDaemon = null } = {}) {
    let run = this.consumeRequest({ at });
    if (!run || run.status !== 'running') return run;
    const healthy = health?.ok === true && !issue;
    const sampleIssue = issue ?? (health && !health.ok ? 'daemon_degraded' : !health ? 'daemon_unreachable' : null);
    const managedHelpers = (health?.dependencies?.managedHelpers?.helpers ?? []).map(helper => ({ id: helper.id, generation: helper.pid ? helper.generation ?? null : null, restarts: helper.restarts ?? 0 }));
    const changed = run.lastSample && (run.lastSample.healthy !== healthy || run.lastSample.issue !== sampleIssue || run.lastSample.instanceId !== (health?.process?.instanceId ?? null) || JSON.stringify(run.lastSample.managedDaemon ?? null) !== JSON.stringify(managedDaemon) || JSON.stringify(run.lastSample.managedHelpers ?? []) !== JSON.stringify(managedHelpers) || enduranceCoverageObservationKey(run.lastSample) !== enduranceCoverageObservationKey(health));
    if (!changed && run.lastSample && at >= Date.parse(run.lastSample.at) && at - Date.parse(run.lastSample.at) < run.sampleIntervalMs) return run;
    const monotonic = performance.now();
    const monitorRestarted = this.lastRunId !== run.id && run.samples > 0;
    const sample = { runId: run.id, at: new Date(at).toISOString(), healthy,
      issue: sampleIssue,
      instanceId: health?.process?.instanceId ?? null, pid: health?.process?.pid ?? null, managedDaemon,
      rssBytes: health?.memory?.rss ?? null, stateBytes: health?.persistence?.bytes ?? null,
      // Numeric process diagnostics distinguish JS heap, buffers and total RSS.
      // They do not change health, sampling cadence or any memory threshold.
      memory: Object.fromEntries(['heapUsed', 'heapTotal', 'external', 'arrayBuffers'].map(key => [key, diagnosticCount(health?.memory?.[key])])),
      diskFreeBytes, streams: health?.streams ?? null, workload: health?.workload ?? null,
      initiative: health?.scheduler?.initiative ?? null,
      learning: learningDiagnostics(health?.scheduler?.learning),
      diagnostics: { autonomyDegraded: diagnosticBoolean(health?.autonomyDegraded), memorySyncDegraded: diagnosticBoolean(health?.memorySyncDegraded),
        closing: diagnosticBoolean(health?.process?.closing), persistenceFailed: diagnosticBoolean(health?.persistence?.failed), lastTickError: diagnosticCode(health?.scheduler?.lastTickError) },
      dependencies: health?.dependencies ?? null, managedHelpers,
      monitorRestarted, monotonicDeltaSeconds: this.lastMonotonic === null ? null : (monotonic - this.lastMonotonic) / 1000 };
    run = recordEnduranceSample(run, sample);
    appendRotated(this.log, `${JSON.stringify(sample)}\n`);
    atomicWrite(this.path, JSON.stringify(run, null, 2));
    this.lastRunId = run.id; this.lastMonotonic = monotonic;
    return run;
  }
}
