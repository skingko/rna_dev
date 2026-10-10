import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readStateFile, writeStateFile } from './state-shards.mjs';
import { acquireProcessLease, processBirth } from './process-lease.mjs';
import { acquireCheckpointLease, assertStateRecoveryReady, createStateCheckpoint, verifyStateCheckpoint } from './state-checkpoint.mjs';
import { maintenancePaths, ensureMaintenancePaths, persistMaintenance, publicMaintenanceOperation, readMaintenance, withMaintenanceControl } from './application-maintenance-state.mjs';

const fail = (message, code = 'application_recovery_invalid') => { throw Object.assign(new Error(message), { code, status: 409 }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const warning = '仅恢复本机记录；项目文件、远端记忆及恢复点之后发生的外部操作没有回滚。旧待办保持待核查，不会自动重放。';
const active = new Set(['queued', 'running', 'pending', 'paused', 'waiting', 'scheduled']);
const memoryActive = new Set(['pending', 'ready', 'creating', 'uploading', 'committing', 'polling', 'failed', 'uncertain', 'retained']);
const learnActive = new Set(['pending', 'deferred', 'awaiting_evidence', 'reviewing', 'queued_experiment', 'executing', 'interrupted']);
const stamp = () => new Date().toISOString();
async function secureControlPaths(stateFile) {
  ensureMaintenancePaths(stateFile);
  const paths = maintenancePaths(stateFile), directory = await lstat(paths.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(paths.directory) !== paths.directory) fail('维护目录不能是符号链接。', 'application_recovery_unsafe_path');
  for (const path of [paths.worker, paths.control]) for (const suffix of ['', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm']) {
    const info = await lstat(`${path}${suffix}`).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('维护锁路径无法安全核对。', 'application_recovery_unsafe_path');
  }
  return paths;
}
async function readState(stateFile) {
  const info = await lstat(stateFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024 ** 2) fail('恢复状态无法安全读取。');
  let state; try { state = readStateFile(stateFile)?.state; } catch { fail('恢复状态不是有效 JSON。'); }
  if (!plain(state) || state.version !== 2 || !['sessions', 'projects', 'tasks', 'events'].every(key => Array.isArray(state[key]))) fail('恢复核查需要当前应用的会话格式。');
  return state;
}
function reviewPlan(state, operationId, at) {
  const next = structuredClone(state), counts = { projects: 0, sessions: 0, turns: 0, queuedMessages: 0, goals: 0, schedules: 0, occurrences: 0, actions: 0, jobs: 0, learningReviews: 0, learningEpisodes: 0, evolutionRequests: 0, versions: 0, initializations: 0, memoryWrites: 0, memoryIndexes: 0, memorySummaries: 0, sessionDeletions: 0 };
  const mark = (row, extra = {}) => {
    row.appRecovery = { schemaVersion: 1, operationId, reason: 'restore_review', required: true, at, ...(row.status === undefined ? {} : { previousStatus: row.status }), ...extra };
  };
  const memoryWrite = write => {
    if (!plain(write)) return;
    if (memoryActive.has(write.status)) { mark(write, { memory: true }); write.status = 'recovery_review'; counts.memoryWrites++; }
    // A completed resource may otherwise be deleted by revocation cleanup even
    // with autoStore=false. Retain the real completed receipt and guard the row.
    if (plain(write.resourceIndex) && write.resourceIndex.status !== 'deleted') {
      if (write.appRecovery?.operationId !== operationId) mark(write, { memory: true });
      mark(write.resourceIndex, { memory: true }); counts.memoryIndexes++;
    }
  };
  for (const session of next.sessions) {
    if (!plain(session) || !['items', 'turns', 'inbox', 'submissions'].every(key => Array.isArray(session[key]))) fail('会话结构无法核对，未改写恢复状态。');
    mark(session, { foreground: true, activeTurnId: session.activeTurnId ?? null }); counts.sessions++;
    if (active.has(session.status) || session.activeTurnId || session.inbox.length) {
      session.status = 'paused'; session.pauseReason = 'restore_review';
    }
    for (const turn of session.turns) {
      if (active.has(turn.status)) { mark(turn, { foreground: true }); turn.status = 'paused'; turn.pauseReason = 'restore_review'; counts.turns++; }
      memoryWrite(turn.memoryWrite); for (const write of turn.memoryCheckpoints ?? []) memoryWrite(write);
    }
    for (const message of session.inbox) { mark(message, { foreground: true }); counts.queuedMessages++; }
    for (const write of session.memoryEvidenceOutbox ?? []) memoryWrite(write);
    for (const item of session.items) if (item.streaming || item.tool?.status === 'running') {
      mark(item, { foreground: true }); item.streaming = false;
      // No fabricated success or failed tool receipt: the journal and current
      // item retain their original evidence, with an explicit restore review.
      if (item.tool) item.tool.appRecovery = { operationId, reason: 'restore_review', required: true, at };
    }
  }
  for (const project of next.projects) {
    if (!plain(project)) fail('项目结构无法核对。');
    mark(project, { background: true, memory: true }); counts.projects++;
    // Switched off for the user's own review: lifting the emergency stop that comes with it must not switch it back on (C-h).
    project.initiative = { ...project.initiative, enabled: false }; delete project.initiative.pausedByEmergency;
    project.evolution = { ...project.evolution, enabled: false };
    if (project.initiativeRuntime?.sdkState?.policy) project.initiativeRuntime.sdkState.policy.enabled = false;
    for (const schedule of project.schedules ?? []) {
      mark(schedule, { background: true, previousEnabled: schedule.enabled, previousUserPaused: schedule.userPaused ?? null });
      schedule.enabled = false; schedule.userPaused = true; counts.schedules++;
    }
    for (const occurrence of project.scheduleRuntime?.occurrences ?? []) if (['queued', 'running', 'delivery_pending', 'needs_review', 'paused'].includes(occurrence.status)) {
      mark(occurrence, { background: true }); occurrence.status = 'needs_review'; occurrence.errorCode = 'restore_review'; counts.occurrences++;
    }
    for (const action of project.initiativeRuntime?.sdkState?.actions ?? []) if (['queued', 'running', 'paused', 'needs_review'].includes(action.status)) {
      mark(action, { background: true }); action.status = 'needs_review'; action.blocksExecution = true; action.reasonForReview = 'restore_review'; counts.actions++;
      for (const control of action.controls ?? []) if (control.status === 'pending') {
        mark(control, { background: true }); control.status = 'rejected'; control.settledAt = Date.parse(at); control.summary = '应用从恢复点还原；旧控制请求需人工核查，不自动重新投递。';
      }
    }
    for (const job of project.jobs ?? []) if (active.has(job.status)) { mark(job, { background: true }); job.status = 'paused'; job.errorCode = 'restore_review'; counts.jobs++; }
    const learning = project.learningRuntime?.sdkState;
    for (const review of learning?.reviews ?? []) if (learnActive.has(review.status)) {
      mark(review, { background: true }); review.interruptedPhase ??= ['executing', 'queued_experiment'].includes(review.status) ? 'executing' : 'reviewing';
      review.status = 'interrupted'; review.reconciledAt = Date.parse(at); review.resolution = 'restore_review'; counts.learningReviews++;
    }
    for (const episode of learning?.episodes ?? []) if (learnActive.has(episode.status)) { mark(episode, { background: true }); episode.status = 'interrupted'; counts.learningEpisodes++; }
    if (active.has(project.evolution.request?.status)) { mark(project.evolution.request, { background: true }); project.evolution.request.status = 'paused'; counts.evolutionRequests++; }
    for (const version of project.versions ?? []) if (['proposing', 'evaluating'].includes(version.state)) {
      mark(version, { background: true, previousState: version.state }); version.state = 'interrupted'; version.notice = '恢复点之后的评估结果尚未核对；原始评估证据保留。'; counts.versions++;
    }
    if (['queued', 'initializing', 'running'].includes(project.initialization?.status)) { mark(project.initialization, { background: true }); project.initialization.status = 'paused'; counts.initializations++; }
    if (project.memorySummary && !['completed', 'skipped'].includes(project.memorySummary.status)) { mark(project.memorySummary, { memory: true }); project.memorySummary.status = 'recovery_review'; counts.memorySummaries++; }
  }
  for (const goal of next.goals ?? []) if (active.has(goal.status)) { mark(goal, { background: true }); goal.resumeStatus ??= goal.status; goal.status = 'paused'; goal.pauseReason = 'restore_review'; counts.goals++; }
  for (const task of next.tasks) if (active.has(task.status)) { mark(task, { background: true }); task.status = 'paused'; task.pauseReason = 'restore_review'; }
  for (const deletion of next.sessionDeletions ?? []) if (deletion.status !== 'completed') { mark(deletion, { memory: true }); deletion.status = 'recovery_review'; deletion.code = 'RESTORE_REVIEW_REQUIRED'; counts.sessionDeletions++; }
  next.configuration ??= {}; next.configuration.memory = { ...next.configuration.memory, autoStore: false };
  next.emergency = true;
  if (!Number.isSafeInteger(next.revision) || next.revision < 0) fail('恢复状态修订号无效。');
  next.revision++;
  return { next, counts };
}

export async function applicationRecoveryStatus({ stateFile, operationId } = {}) {
  stateFile = resolve(stateFile); if (operationId !== undefined && !id(operationId)) fail('恢复核查身份无效。');
  const row = readMaintenance(stateFile);
  if (operationId && row?.id !== operationId) fail('恢复核查请求身份已变化。', 'application_recovery_identity');
  const state = await readState(stateFile), value = state.applicationRecovery;
  return { operation: publicMaintenanceOperation(row), required: row?.restoreCompleted === true && row.held === true,
    reconciled: Boolean(value && row && value.operationId === row.id && value.status === 'reconciled'), emergency: state.emergency === true,
    ...(value ? { review: { operationId: value.operationId, at: value.at, counts: value.counts, barriers: value.barriers, preReviewCheckpointId: value.preReviewCheckpointId } } : {}),
    warning, next: '核查完成后先解除全局急停，再由用户逐项恢复主动协作、进化、定时任务及记忆。旧执行记录仍需单独核对。' };
}

/** Explicit local reconciliation, not a claim that external effects were undone.
 * The three state-owner locks and maintenance control are held through state
 * publication. A crash between state and maintenance publication stays held;
 * retry finds the exact durable review and finishes without repeating edits. */
export async function reconcileRestoredState({ stateFile, operationId } = {}) {
  stateFile = resolve(stateFile); if (!id(operationId)) fail('恢复核查身份无效。');
  stateFile = join(await realpath(dirname(stateFile)), basename(stateFile));
  let paths = await secureControlPaths(stateFile);
  const workerRelease = await acquireProcessLease(paths.worker, { operationId, purpose: 'restored-state-review' });
  let lease;
  try {
    lease = await acquireCheckpointLease(stateFile); stateFile = lease.stateFile; paths = maintenancePaths(stateFile);
    return await withMaintenanceControl(stateFile, async () => {
      let row = readMaintenance(stateFile);
      if (row?.id !== operationId || row.restoreCompleted !== true || row.kind !== 'restore') fail('不存在匹配的已还原维护操作。', 'application_recovery_identity');
      const state = await readState(stateFile), previous = state.applicationRecovery;
      if (row.phase === 'completed' && row.held === false && previous?.operationId === operationId && previous.status === 'reconciled') return applicationRecoveryStatus({ stateFile, operationId });
      if (!row.held || row.phase !== 'recovery_required') fail('恢复操作未处于待核查保护状态。', 'application_recovery_not_held');
      await assertStateRecoveryReady(stateFile);
      if (previous?.operationId === operationId && previous.status === 'reconciled') {
        const saved = await verifyStateCheckpoint({ directory: previous.preReviewCheckpoint });
        if (saved.id !== previous.preReviewCheckpointId || saved.manifest.sourceStateFile !== stateFile) fail('核查前恢复点身份无法确认。', 'application_recovery_checkpoint');
      } else {
        const at = stamp(), { next, counts } = reviewPlan(state, operationId, at);
        if (!await lstat(paths.checkpoints).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; })) await mkdir(paths.checkpoints, { mode: 0o700 });
        if ((await realpath(paths.checkpoints)) !== paths.checkpoints) fail('恢复核查目录不能是符号链接。');
        const checkpoint = await createStateCheckpoint({ stateFile, destination: join(paths.checkpoints, randomUUID()), lease });
        next.applicationRecovery = { schemaVersion: 1, operationId, status: 'reconciled', at, counts, barriers: { memory: true, background: true },
          preReviewCheckpoint: checkpoint.directory, preReviewCheckpointId: checkpoint.id, previousOperationId: previous?.operationId ?? null,
          externalEffectsRolledBack: false, remoteMemoryRolledBack: false, projectFilesRolledBack: false };
        writeStateFile(stateFile, next, { sweep: true });
      }
      row = persistMaintenance(stateFile, { ...row, phase: 'completed', held: false, completedAt: stamp(), owner: { pid: process.pid, birth: processBirth(process.pid) },
        errorCode: undefined, restoredStateReconciled: true, summary: '恢复记录已核查并隔离旧待办；全局急停、主动协作、进化、任务与记忆自动写入仍暂停，待逐项恢复。' });
      return applicationRecoveryStatus({ stateFile, operationId });
    });
  } finally { lease?.release(); workerRelease(); }
}
