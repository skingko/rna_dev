import { InitiativeCoordinator, type InitiativeAction, type InitiativeActionControl, type InitiativeHandler } from '@rna-agent/sdk';

const handler: InitiativeHandler = async (action, context) => {
  const pending: InitiativeActionControl[] = context.pendingControls();
  const command = pending[0];
  if (command?.kind === 'steer') await context.acknowledgeControl(command.id, { status: 'applied', summary: command.instruction });
  if (command?.kind === 'pause') return { control: { commandId: command.id, kind: 'pause', checkpoint: { sessionId: action.id }, summary: 'Original session stopped at a verified boundary' } };
  if (command?.kind === 'cancel') return { control: { commandId: command.id, kind: 'cancel', summary: 'All effects are settled' } };
};
const coordinator = new InitiativeCoordinator({ handlers: { work: handler }, actionControlKinds: ['work'] });
await coordinator.requestActionControl('action', { id: 'pause', kind: 'pause', expectedRevision: 0 });
await coordinator.requestActionControl('action', { id: 'steer', kind: 'steer', expectedRevision: 1, instruction: 'Include compatibility evidence', sourceSessionId: 'host-owned-conversation' });
await coordinator.acknowledgeActionControl('action', 'steer', { status: 'applied', summary: 'Written once to the original session inbox' });
coordinator.invalidateDecision('foreground_observation');
// @ts-expect-error A steer requires the actual instruction.
await coordinator.requestActionControl('action', { id: 'steer', kind: 'steer', expectedRevision: 1 });
// @ts-expect-error Lifecycle commands cannot smuggle an instruction.
await coordinator.requestActionControl('action', { id: 'pause', kind: 'pause', expectedRevision: 1, instruction: 'hidden task' });
// @ts-expect-error Every new control needs optimistic concurrency protection.
await coordinator.requestActionControl('action', { id: 'pause', kind: 'pause' });
// @ts-expect-error Evaluation handlers are not implicitly resumable work.
new InitiativeCoordinator({ actionControlKinds: ['learn'] });
// @ts-expect-error Pause needs a retained session checkpoint.
const invalidHandler: InitiativeHandler = async () => ({ control: { kind: 'pause', commandId: 'pause', summary: 'Just aborted' } });
void invalidHandler;
const paused: InitiativeAction['status'] = 'paused';
void paused;
