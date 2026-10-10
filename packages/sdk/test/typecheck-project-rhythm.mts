import {
  ProjectRhythmError, projectRhythmAssessmentSchema, validateProjectRhythmAssessment,
  resolveProjectRhythm, getInitiativeDecisionSchema, InitiativeCoordinator,
  type ProjectRhythmAssessment, type ProjectRhythmOptions, type ProjectRhythmResolution,
  type ProjectRhythmHostContract, type ProjectRhythmLearningAttempt, type ProjectRhythmReason,
  type InitiativeDecision, type InitiativeFailure, type JsonSchema,
} from '@rna-agent/sdk';

const rhythm: ProjectRhythmAssessment = {
  lifecycle: 'recurring', reason: 'Actual daily duty; current occurrence complete.', evidenceIds: ['current-evidence'], scheduleIds: ['daily-duty'],
  initiative: { mode: 'event_only', reviewAfterMs: 86400000 },
  evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: 86400000 },
};
const contract: ProjectRhythmHostContract = { enabled: true, requiresAssessment: true, schemaVersion: 1 };
const attempt: ProjectRhythmLearningAttempt = { id: 'batch-1', source: 'automatic', at: Date.now(), status: 'failed' };
const options: ProjectRhythmOptions = { assessment: rhythm, schedules: [{ id: 'daily-duty', enabled: true, nextRunAt: '2026-09-28T00:00:00Z' }], learningAttempts: [attempt], lastLearningAt: attempt.at, freshEvidence: false, hasPendingLearning: true, control: 'auto' };
const resolved: ProjectRhythmResolution = resolveProjectRhythm(options);
const reason: ProjectRhythmReason = resolved.evolution.reason;
resolved.evolution.quota.window satisfies 'rolling';
resolved.initiative.nextAt satisfies number | null;
projectRhythmAssessmentSchema satisfies JsonSchema;
validateProjectRhythmAssessment(rhythm, { allowedEvidenceIds: ['current-evidence'], schedules: [{ id: 'daily-duty' }] });
getInitiativeDecisionSchema({ project: { id: 'project', actionContracts: { rhythm: contract } } });
const decision: InitiativeDecision = { action: 'wait', reason: 'Current responsibility is done.', content: '', evidenceIds: [], nextReviewAfterMs: 86400000, rhythm };
const missing: NonNullable<InitiativeFailure['decisionValidation']>['missingFields'] = ['rhythm'];
const coordinator = new InitiativeCoordinator();
await coordinator.tick({ decisionEnabled: false });
await coordinator.close();
new ProjectRhythmError('Invalid host admission clock.').code satisfies string;

// @ts-expect-error no invented lifecycle values
const unknownLifecycle: ProjectRhythmAssessment['lifecycle'] = 'whatever';
// @ts-expect-error clock input requires epoch milliseconds
const badClock: ProjectRhythmOptions = { now: '2026-09-26' };
// @ts-expect-error transport retries are not independently billable batch sources
const badSource: ProjectRhythmLearningAttempt = { id: 'batch', source: 'transport_retry', at: 0 };
// @ts-expect-error the gate is explicitly boolean, not a persisted string setting
void coordinator.tick({ decisionEnabled: 'false' });
void [decision, missing, reason, unknownLifecycle, badClock, badSource];
