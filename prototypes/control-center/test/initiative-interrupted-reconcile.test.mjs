import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';

// Work the conversation took over is marked needs_review by the SDK whatever
// happened; the host settles it itself when the run left no unconfirmed tool.
function host(jobs, actions, { busy = false } = {}) {
  const resolved = [];
  const self = Object.create(ProjectInitiativeController.prototype);
  self.project = () => ({ id: 'p', jobs });
  const coordinator = { active: new Set(busy ? ['x'] : []), unsettled: new Set(), resolvingExecutions: new Set(), state: { actions },
    async resolveAction(id, input) { resolved.push({ id, ...input }); const action = actions.find(row => row.id === id); action.status = 'cancelled'; action.resolvedAt = 1; } };
  return { self, context: { projectId: 'p', coordinator, activeHandles: new Set() }, resolved };
}

test('interrupted with every tool settled: resolved by the host, nobody is asked', async () => {
  const actions = [
    { id: 'clean', action: 'work', status: 'needs_review', errorCode: 'foreground_started' },
    { id: 'unknown', action: 'work', status: 'needs_review', blocksExecution: true },
    { id: 'in-flight', action: 'work', status: 'needs_review' },
  ];
  const jobs = [{ id: 'clean', status: 'cancelled', toolReceiptCounts: { total: 40, completed: 40, failed: 0, uncertain: 0 } }, { id: 'unknown', status: 'needs_review' }, { id: 'in-flight', status: 'needs_review' }];
  const f = host(jobs, actions);
  await f.self.reconcileInterrupted(f.context);
  assert.deepEqual(f.resolved.map(row => [row.id, row.status, row.source]), [['clean', 'cancelled', 'host']]);
  assert.match(f.resolved[0].summary, /40 completed step\(s\) stay as done/);
  assert.equal(actions[1].status, 'needs_review'); assert.equal(actions[2].status, 'needs_review', 'a tool left unconfirmed still needs the user');
});

test('nothing is resolved while the coordinator still runs something', async () => {
  const actions = [{ id: 'clean', action: 'work', status: 'needs_review' }];
  const f = host([{ id: 'clean', status: 'cancelled' }], actions, { busy: true });
  await f.self.reconcileInterrupted(f.context);
  assert.equal(f.resolved.length, 0);
});
