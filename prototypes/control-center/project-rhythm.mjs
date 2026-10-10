import { createHash } from 'node:crypto';
import { resolveProjectRhythm, validateProjectRhythmAssessment } from '../../packages/sdk/src/project-rhythm.mjs';

const WEEK = 7 * 86400000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

/** Stable external/material evidence, never a wall clock or a model's thought.
 * A result with actual tools can wake one review; its narration cannot keep
 * waking itself. Dispatch captures this watermark before the model runs.
 * A conversation's mode (plan mode on or off) is runtime state, not evidence (B3, A1's open question): Headlong records
 * a runtime change as a fact line in the next wake prompt and never wakes on it (wake_prompt_cull.md, runtime section).
 * The decision request already shows the mode where it matters (hostConditions.work.backgroundLevel), plan mode holds
 * background writes itself, and what comes of a plan (the user's message, the turn that carries it out) changes this
 * key anyway. Hashing the mode made every toggle read as new evidence, a review, and a stale gate verdict. */
export function projectRhythmEvidenceKey(state, project) { return evidenceKey(state, project); }
function evidenceKey(state, project, { withMode = false } = {}) {
  const sessions = (state.sessions ?? []).filter(row => row.projectId === project.id && !row.archivedAt);
  return hash({
    project: [project.name, project.description, project.overview, project.focus, project.workspace, project.permissions, project.assignments, project.commitments, project.milestones, project.activeVersionId, project.trialVersionId],
    sessions: sessions.map(session => [session.id, ...(withMode ? [session.mode] : []),
      (session.items ?? []).filter(row => row.kind === 'user' && !row.sourceDeleted && !row.contextRevoked).slice(-16).map(row => [row.id, row.text]),
      (session.turns ?? []).filter(row => row.modelConfig?.execution === 'rna' && row.simulated !== true && ['completed', 'failed', 'stopped'].includes(row.status)).slice(-8).map(row => [row.id, row.status, row.completedAt])]),
    observations: (project.observations ?? []).filter(row => row.simulated !== true && !['withdrawn', 'superseded'].includes(row.status) && !row.data?.messageId && row.source !== 'initiative').slice(-12).map(row => [row.id, row.kind, row.text]),
    work: (project.jobs ?? []).filter(row => row.simulated !== true && ['completed', 'failed'].includes(row.status) && (row.toolReceipts?.length || Object.values(row.toolReceiptCounts ?? {}).some(value => typeof value === 'number' && value > 0))).slice(-8).map(row => [row.id, row.status, row.completedAt]),
    schedules: (project.schedules ?? []).map(row => [row.id, row.revision, row.enabled, row.lastEditedBy]),
    cancelled: (project.scheduleCreationReceipts ?? []).filter(row => row.deletedAt).slice(-32).map(row => [row.id, row.deletedAt]),
    deliveries: (project.scheduleRuntime?.occurrences ?? []).filter(row => row.deliveredAt).slice(-8).map(row => [row.key, row.deliveredAt]),
    failures: (project.initiativeRuntime?.sdkState?.actions ?? []).filter(row => ['failed', 'needs_review'].includes(row.status) && !row.contextRevoked).slice(-8).map(row => [row.id, row.status, row.errorCode, row.failure?.code]),
  });
}
/**
 * Startup, idempotent: a stored key that is the earlier form (with each conversation's mode) of the project's current
 * state had consumed that evidence; it moves to the current form, so the upgrade alone reads as no new evidence (it
 * would have opened every event_only project's lane, and the gate's two-pass bound would have forced a paid review).
 * Any other stored key is left alone: that evidence is still unconsumed. Runs before the genome identity migration,
 * which compares stored keys with the current form.
 */
export function migrateRhythmEvidenceKeys(state) {
  let changed = 0;
  for (const project of Array.isArray(state?.projects) ? state.projects : []) {
    const runtime = project?.rhythmRuntime;
    if (!runtime || typeof runtime !== 'object' || typeof runtime.evidenceKey !== 'string') continue;
    const current = evidenceKey(state, project);
    if (runtime.evidenceKey === current || runtime.evidenceKey !== evidenceKey(state, project, { withMode: true })) continue;
    runtime.evidenceKey = current; changed++;
  }
  return { changed };
}

/** Retain admissions independently of the bounded SDK review history. Legacy
 * measured dispatch receipts count too; upgrading must not erase real usage. */
export function projectRhythmLearningAttempts(project, now = Date.now()) {
  const rows = new Map((project.rhythmRuntime?.learningAttempts ?? []).map(row => [row.id, row]));
  for (const review of project.learningRuntime?.sdkState?.reviews ?? []) {
    const at = instant(review.startedAt);
    if (!rows.has(review.id) && review.request?.phase === 'learning_reflection' && review.request.requestStarted === true && at !== null) rows.set(review.id, { id: review.id, at, source: 'automatic', status: review.status });
  }
  return [...rows.values()].filter(row => row.at > now - WEEK).sort((a, b) => a.at - b.at);
}

const STEERING_SOURCES = new Set(['correction', 'preference', 'feedback', 'steering']);
/** How the user is engaging right now: the last message, messages in the last
 * six hours, and steering (corrections, lasting preferences or improvement
 * requests the mind captured through JEV) since the last learning review. */
export function projectInteraction(state, project, { now = Date.now(), since = null } = {}) {
  let lastUserAt = null, recentUserMessages = 0;
  for (const session of state.sessions ?? []) {
    if (session.projectId !== project.id || session.archivedAt) continue;
    for (const item of session.items ?? []) {
      if (item.kind !== 'user' || item.sourceDeleted || item.contextRevoked) continue;
      const at = instant(item.createdAt); if (at === null || at > now) continue;
      if (lastUserAt === null || at > lastUserAt) lastUserAt = at;
      if (at >= now - 6 * 3600000) recentUserMessages++;
    }
  }
  const after = row => (instant(row.createdAt) ?? 0) > (since ?? 0);
  const mind = project.mind ?? {};
  const steering = (mind.lessons ?? []).filter(row => row.status === 'active' && STEERING_SOURCES.has(row.source?.kind) && after(row)).length
    + (mind.agenda ?? []).filter(row => row.status === 'open' && row.source?.kind === 'steering' && after(row)).length;
  return { lastUserAt, recentUserMessages, steering };
}
export function projectRhythmStatus(state, project, { now = Date.now(), freshEvidence, hasPendingLearning } = {}) {
  const runtime = project.rhythmRuntime ?? {}, sdk = project.learningRuntime?.sdkState;
  const learningAttempts = projectRhythmLearningAttempts(project, now);
  const lastLearningAt = Math.max(0, instant(runtime.lastLearningAt) ?? 0, ...learningAttempts.filter(row => row.source === 'automatic').map(row => row.at)) || null;
  const status = resolveProjectRhythm({
    assessment: runtime.assessment ?? null, schedules: project.schedules ?? [], now,
    initiativeEnabled: project.initiative?.enabled === true && !state.emergency && !project.archivedAt,
    evolutionEnabled: project.initiative?.enabled === true && project.evolution?.enabled === true && !state.emergency && !project.archivedAt,
    control: project.rhythm?.control ?? 'auto',
    freshEvidence: freshEvidence ?? runtime.evidenceKey !== projectRhythmEvidenceKey(state, project),
    hasPendingLearning: hasPendingLearning ?? (sdk?.episodes ?? []).some(row => row.status === 'pending' || row.status === 'deferred' && row.nextReviewAt <= now),
    lastInitiativeAt: instant(runtime.lastInitiativeAt), lastLearningAt, learningAttempts,
    interaction: projectInteraction(state, project, { now, since: lastLearningAt }),
  });
  return { ...status, assessment: runtime.assessment ?? null, assessmentSourceIds: runtime.assessmentSourceIds ?? [], assessedAt: instant(runtime.assessedAt), lastInitiativeAt: instant(runtime.lastInitiativeAt), lastLearningAt, history: runtime.history ?? [] };
}

/** Runs in the same transaction as the SDK's accepted decision. Never consume
 * evidence by merely checking a gate, and never consume arrivals after dispatch. */
export function acceptProjectRhythmDecision(project, decision, { evidenceKey, allowedEvidenceIds = [], schedules = project.schedules ?? [], sourceIds = [], now = Date.now() } = {}) {
  if (project.rhythm?.control === 'manual' || !decision || !evidenceKey || !decision.rhythm && !project.rhythmRuntime?.assessment) return false;
  const identity = hash([decision.at, decision.revision, decision.rhythm, decision.action]);
  if (project.rhythmRuntime?.decisionIdentity === identity) return false;
  const assessment = decision.rhythm ? validateProjectRhythmAssessment(decision.rhythm, { allowedEvidenceIds, schedules }) : project.rhythmRuntime.assessment;
  const previous = project.rhythmRuntime ?? {};
  project.rhythmRuntime = { ...previous, assessment, assessmentSourceIds: decision.rhythm ? [...sourceIds] : previous.assessmentSourceIds ?? [], assessedAt: decision.rhythm ? now : previous.assessedAt, lastInitiativeAt: now, evidenceKey, decisionIdentity: identity,
    history: decision.rhythm ? [...(previous.history ?? []), { at: now, lifecycle: assessment.lifecycle, reason: assessment.reason, initiativeMode: assessment.initiative.mode, evolutionMode: assessment.evolution.mode, evidenceIds: assessment.evidenceIds, sourceIds: [...sourceIds], source: 'model' }].slice(-12) : previous.history ?? [] };
  return true;
}

/** Gate and ledger insertion must share the request reservation transaction.
 * Provider retries for one immutable review do not consume another allowance. */
export function admitProjectRhythmLearning(state, project, { reviewId, now = Date.now() } = {}) {
  if (state.emergency || project.archivedAt || !project.initiative?.enabled || !project.evolution?.enabled) throw Object.assign(new Error('Automatic reflection is disabled'), { code: 'project_rhythm_waiting', reason: 'user_disabled' });
  if (project.rhythm?.control === 'manual') return { admitted: true, manual: true };
  const review = project.learningRuntime?.sdkState?.reviews?.find(row => row.id === reviewId && row.status === 'reviewing' && !row.sourceRevoked);
  if (!review) throw Object.assign(new Error('Automatic reflection requires its durable review claim'), { code: 'rhythm_review_claim_required' });
  const rows = projectRhythmLearningAttempts(project, now);
  if (rows.some(row => row.id === reviewId)) return { admitted: true, repeated: true };
  const status = projectRhythmStatus(state, project, { now, hasPendingLearning: true });
  if (!status.evolution.eligible) throw Object.assign(new Error(`Automatic reflection is waiting: ${status.evolution.reason}`), { code: 'project_rhythm_waiting', reason: status.evolution.reason });
  const runtime = project.rhythmRuntime ??= {};
  runtime.learningAttempts = [...rows, { id: reviewId, at: now, source: 'automatic', status: 'admitted' }];
  runtime.lastLearningAt = now;
  return { admitted: true, repeated: false };
}
