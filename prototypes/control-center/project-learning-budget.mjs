import { randomUUID } from 'node:crypto';
import { chargeRealTokens, releaseRealTokens, reserveRealTokens } from './budget-service.mjs';
import { admitProjectRhythmLearning } from './project-rhythm.mjs';

const tokens = value => Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;
const failure = (message, code) => Object.assign(new Error(message), { code });
export function learningTokenUsage(project) {
  const usage = project?.learningRuntime?.usage;
  return { totalTokens: tokens(usage?.totalTokens), reservedTokens: tokens(usage?.reservedTokens) };
}
export function remainingInitiativeTokenBudget(project) {
  const cap = project.initiative?.tokenBudget;
  if (cap == null) return null;
  const learning = learningTokenUsage(project);
  return Math.max(0, cap - learning.totalTokens - learning.reservedTokens);
}
function ensureUsage(project) {
  project.learningRuntime ??= {};
  const usage = project.learningRuntime.usage ??= {};
  for (const key of ['totalTokens', 'reportedTokens', 'estimatedTokens', 'reservedTokens', 'settledRequests', 'recoveredRequests']) usage[key] = tokens(usage[key]);
  return usage;
}
function updateProjectTokens(project, usage) {
  project.initiative.tokens = tokens(project.initiativeRuntime?.sdkState?.usedTokens) + usage.totalTokens;
  project.initiative.costStatus = 'unpriced';
}

/** One persisted learning request, sharing the normal initiative and global caps.
 * A reservation is admission accounting, never proof of a provider bill. Usage
 * receipts still settle after cancellation, a cap reduction or project pause.
 */
export class ProjectLearningBudget {
  constructor(store, projectId, { now = Date.now } = {}) {
    this.store = store; this.projectId = projectId; this.now = now;
    this.key = `learning:${projectId}`; this.pendingId = null;
    // Safe to pass the instance directly as an evolution requestControl.
    this.beforeRequest = this.beforeRequest.bind(this); this.onUsage = this.onUsage.bind(this);
  }
  beforeRequest({ id, requestId: suppliedRequestId, reviewId, phase, estimatedTokens, signal } = {}) {
    signal?.throwIfAborted();
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || !Number.isSafeInteger(Math.ceil(estimatedTokens))) throw failure('Invalid learning token reservation', 'invalid_budget');
    const amount = Math.ceil(estimatedTokens), requestId = id ?? suppliedRequestId ?? randomUUID();
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) throw failure('Invalid learning request identity', 'invalid_budget');
    this.store.mutate(state => {
      signal?.throwIfAborted();
      const project = state.projects.find(project => project.id === this.projectId);
      if (!project) throw failure('Learning project no longer exists', 'project_not_found');
      const usage = ensureUsage(project);
      if (usage.activeRequest || usage.reservedTokens || state.realUsage?.reservations?.[this.key]) throw failure('Learning request must settle before another admission', 'learning_request_pending');
      if (usage.lastReceipt?.requestId === requestId) throw failure('Learning request identity was already settled', 'learning_request_settled');
      const initiative = project.initiativeRuntime?.sdkState;
      const combined = usage.totalTokens + tokens(initiative?.usedTokens) + tokens(initiative?.reservedTokens) + amount;
      if (combined > (project.initiative?.tokenBudget ?? Infinity)) throw failure('Learning request exceeds the current project token allowance', 'budget');
      reserveRealTokens(state, this.key, amount, { now: this.now() });
      // The SDK supplies the durable review identity before dispatch. Cadence
      // and token admission commit together; a failed allowance/pace check
      // writes neither a reservation nor a consumed review slot.
      if (phase === 'learning_reflection') admitProjectRhythmLearning(state, project, { reviewId, now: this.now() });
      usage.reservedTokens = amount;
      usage.activeRequest = { id: requestId, ...(typeof reviewId === 'string' ? { reviewId } : {}), phase: String(phase ?? 'learning').slice(0, 100), estimatedTokens: amount, admittedAt: new Date(this.now()).toISOString() };
      return { requestId };
    });
    this.pendingId = requestId; this.pendingRequest = { id: requestId, ...(typeof reviewId === 'string' ? { reviewId } : {}), phase: String(phase ?? 'learning').slice(0, 100), estimatedTokens: amount };
    return { requestId };
  }
  onUsage(entry = {}) {
    if (!this.pendingId) return { settled: false, reason: 'already_settled' };
    const requestId = this.pendingId;
    if ((entry.id ?? entry.requestId) && (entry.id ?? entry.requestId) !== requestId) return { settled: false, reason: 'different_request' };
    const result = this.store.mutate(state => {
      const project = state.projects.find(project => project.id === this.projectId), usage = project && ensureUsage(project);
      const activeRequest = usage ? usage.activeRequest : this.pendingRequest;
      if (!activeRequest || activeRequest.id !== requestId) return { settled: false, reason: 'reservation_changed' };
      const receipt = entry.usage ?? {};
      const reported = Number.isFinite(receipt.totalTokens) ? tokens(receipt.totalTokens) : ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + tokens(receipt[key]), 0);
      const hasMeasuredUsage = entry.usageReported === true || reported > 0 && entry.estimatedWhenUnknown !== true && !tokens(receipt.estimatedTokens);
      const notSent = entry.requestStarted === false || entry.cancelledBeforeSend === true;
      // Do not throw away a real usage receipt just because cancellation raced
      // with dispatch. Explicit zero before dispatch releases admission only.
      const reserved = usage?.reservedTokens ?? state.realUsage?.reservations?.[this.key] ?? activeRequest.estimatedTokens;
      const count = hasMeasuredUsage ? reported : notSent ? 0 : entry.estimatedWhenUnknown === true || entry.usageReported === false ? reported || reserved : reported;
      const estimated = hasMeasuredUsage ? Math.min(count, tokens(receipt.estimatedTokens)) : notSent ? 0 : Math.min(count, tokens(receipt.estimatedTokens) || (entry.estimatedWhenUnknown === true || entry.usageReported === false ? count : 0));
      chargeRealTokens(state, count - estimated, { now: this.now() });
      chargeRealTokens(state, estimated, { estimated: true, now: this.now() });
      releaseRealTokens(state, this.key, { now: this.now() });
      if (usage) {
        usage.totalTokens += count; usage.reportedTokens += count - estimated; usage.estimatedTokens += estimated; usage.reservedTokens = 0; usage.settledRequests++;
        usage.lastReceipt = { requestId, ...(activeRequest.reviewId ? { reviewId: activeRequest.reviewId } : {}), phase: activeRequest.phase, totalTokens: count, estimatedTokens: estimated, requestStarted: !notSent, completed: entry.completed === true, at: new Date(this.now()).toISOString() };
        delete usage.activeRequest; updateProjectTokens(project, usage);
      }
      return { settled: true, totalTokens: count, estimatedTokens: estimated };
    });
    this.pendingId = null; this.pendingRequest = null;
    return result;
  }
  recover() {
    const project = this.store.state.projects.find(project => project.id === this.projectId);
    const saved = project?.learningRuntime?.usage;
    const reserved = Math.max(tokens(saved?.reservedTokens), tokens(this.store.state.realUsage?.reservations?.[this.key]));
    if (!reserved && !saved?.activeRequest) return { recovered: false, estimatedTokens: 0 };
    const result = this.store.mutate(state => {
      const project = state.projects.find(project => project.id === this.projectId), usage = project && ensureUsage(project);
      const count = Math.max(tokens(usage?.reservedTokens), tokens(state.realUsage?.reservations?.[this.key]));
      chargeRealTokens(state, count, { estimated: true, now: this.now() }); releaseRealTokens(state, this.key, { now: this.now() });
      if (usage) {
        usage.totalTokens += count; usage.estimatedTokens += count; usage.reservedTokens = 0; usage.recoveredRequests++;
        usage.lastReceipt = { requestId: usage.activeRequest?.id ?? null, ...(usage.activeRequest?.reviewId ? { reviewId: usage.activeRequest.reviewId } : {}), phase: usage.activeRequest?.phase ?? 'unknown', totalTokens: count, estimatedTokens: count, outcome: 'interrupted_usage_unknown', at: new Date(this.now()).toISOString() };
        delete usage.activeRequest; updateProjectTokens(project, usage);
      }
      return { recovered: true, estimatedTokens: count };
    });
    this.pendingId = null; this.pendingRequest = null;
    return result;
  }
}
