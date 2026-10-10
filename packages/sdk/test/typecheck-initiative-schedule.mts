import {
  InitiativeCoordinator, decideInitiative, getInitiativeDecisionSchema,
  initiativeDecisionSchema, initiativeScheduleActionSchema, validateInitiativeDecision,
  type InitiativeScheduleAction, type InitiativeDecision, type InitiativeHandler,
  type InitiativeFailure, type InitiativeActionKind, type ProjectContext, type JsonSchema,
} from '@rna-agent/sdk';

const project: ProjectContext = { id: 'typed-project', actionContracts: { schedule: { schemaVersion: 1, enabled: true } } };
const evidence = [{ id: 'typed-evidence', type: 'project_state', summary: 'Current project responsibility' }];
const create: InitiativeScheduleAction = { operation: 'create', purposeKey: 'weekly-project-review', title: 'Review progress', task: 'Check evidence and identify a useful next step.', rule: { kind: 'weekly', days: [1], time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: 'typed-session' };
const update: InitiativeScheduleAction = { operation: 'update', id: 'typed-schedule', expectedRevision: 1, enabled: false };
const remove: InitiativeScheduleAction = { operation: 'delete', id: 'typed-schedule', expectedRevision: 2 };
const decision: InitiativeDecision = { action: 'schedule', reason: 'Maintain an ongoing responsibility.', evidenceIds: ['typed-evidence'], content: 'Record the project plan.', nextReviewAfterMs: 30000, schedule: create };
const kind: InitiativeActionKind = 'schedule';
const schema: JsonSchema = getInitiativeDecisionSchema({ project, availableActions: [kind, 'work', 'share'] });
initiativeScheduleActionSchema satisfies JsonSchema;
initiativeDecisionSchema satisfies JsonSchema;
validateInitiativeDecision(decision, { project, events: evidence, availableActions: ['schedule'] });
const handler: InitiativeHandler = async (action, context) => {
  if (action.schedule?.operation === 'create') {
    action.schedule.purposeKey satisfies string;
    action.schedule.destinationSessionId satisfies string;
    context.idempotencyKey satisfies string;
  }
  if (action.schedule?.operation === 'update') action.schedule.expectedRevision satisfies number;
  return { summary: 'A durable registration receipt; work has not yet run.', usage: { totalTokens: 0 } };
};
const coordinator = new InitiativeCoordinator({ project, handlers: { schedule: handler } });
await coordinator.observe(evidence[0]);
const receipt = await coordinator.resolveAction('interrupted-registration', { status: 'completed', summary: 'Verified exact prior commit receipt.', source: 'host' });
receipt.schedule satisfies InitiativeScheduleAction | undefined;
await coordinator.close();
const failure: InitiativeFailure = { id: 'failure-id', at: 1, phase: 'schedule', source: 'host_handler', code: 'schedule_conflict', message: 'The user changed this revision.' };
void decideInitiative({ project, events: evidence, availableActions: ['schedule'], recentActions: [{ action: 'schedule', evidenceIds: ['typed-evidence'], content: 'Prior plan', status: 'completed', schedule: create }] });

// @ts-expect-error create requires the stable responsibility identity
const missingPurpose: InitiativeScheduleAction = { operation: 'create', title: 'Review', task: 'Read evidence', rule: { kind: 'once', at: '2026-09-27T00:00:00Z' }, destinationSessionId: 'session' };
// @ts-expect-error create requires an explicit destination
const missingDestination: InitiativeScheduleAction = { operation: 'create', purposeKey: 'review', title: 'Review', task: 'Read evidence', rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' } };
// @ts-expect-error updates require the version the model actually read
const missingRevision: InitiativeScheduleAction = { operation: 'update', id: 'schedule', enabled: false };
// @ts-expect-error an empty update is invalid in the runtime schema as well
const emptyUpdate: InitiativeScheduleAction = { operation: 'update', id: 'schedule', expectedRevision: 1 };
// @ts-expect-error deletion cannot smuggle a replacement task
const extraDeleteField: InitiativeScheduleAction = { operation: 'delete', id: 'schedule', expectedRevision: 1, task: 'Different work' };
// @ts-expect-error purpose identity cannot be replaced by an update
const changedPurpose: InitiativeScheduleAction = { operation: 'update', id: 'schedule', expectedRevision: 1, enabled: false, purposeKey: 'different-purpose' };
void [create, update, remove, schema, failure, missingPurpose, missingDestination, missingRevision, emptyUpdate, extraDeleteField, changedPurpose];
