import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';

// Exercise the production scheduler/projection against inert in-memory state.
// No provider, filesystem persistence, background handler or live Store exists.
function fixture(t) {
  const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', maxOutputTokens: 1000 };
  const project = { rhythm: { control: 'manual' }, id: 'project', name: 'Fixture', workspace: process.cwd(), description: '', overview: '', focus: '', decisionMode: 'rna-model', initialization: { status: 'ready' }, initiative: { enabled: true, tokenBudget: null }, evolution: { enabled: false }, versions: [], assignments: {}, jobs: [], observations: [] };
  const session = { id: 'session', projectId: project.id, items: [], turns: [] };
  for (let i = 0; i < 12; i++) {
    const turn = { id: `turn-${i}`, status: 'completed', modelConfig: { execution: 'rna' }, createdAt: new Date(i * 1000).toISOString(), completedAt: new Date(i * 1000 + 500).toISOString() }; session.turns.push(turn);
    session.items.push({ id: `request-${i}`, turnId: turn.id, kind: 'user', text: `Request ${i}`, createdAt: turn.createdAt });
    for (let j = 0; j < 50; j++) session.items.push({ id: `tool-${i}-${j}`, turnId: turn.id, kind: 'tool', simulated: false, tool: { name: 'project_read', status: 'completed', output: 'Actual fixture receipt '.repeat(100) } });
    session.items.push({ id: `answer-${i}`, turnId: turn.id, kind: 'assistant', simulated: false, text: `Conclusion ${i}`, createdAt: turn.completedAt });
  }
  const state = { projects: [project], sessions: [session], settings: { realTokenBudget: null }, configuration: { providers: [{ id: 'fixture' }], memory: {} }, capabilities: {}, sessionDeletions: [] };
  const controller = Object.create(ProjectInitiativeController.prototype);
  Object.assign(controller, { store: { state, configurationService: { secrets: {} } }, model: () => model, now: Date.now, evolutionService: { running: new Map() }, contexts: new Map(), closed: false, pumping: false, again: false, maxConcurrentReviews: 4, cursor: 0, unsubscribe() {} });
  const sdk = { revision: 1, decisionRevision: 1, usedTokens: 0, reservedTokens: 0, nextReviewAt: Date.now() + 60000, actions: [] }, observed = [], interrupted = [], invalidated = [];
  const coordinator = { state: sdk, active: new Map(), unsettled: new Set(), policy: {}, snapshot: () => structuredClone(sdk), async updatePolicy(patch) { Object.assign(this.policy, patch); }, async observe(row) { observed.push(row); sdk.revision++; }, invalidateDecision(reason) { invalidated.push(reason); }, interrupt(reason) { interrupted.push(reason); for (const execution of this.active.values()) execution.controller.abort(reason); }, async tick() { return { status: 'idle' }; }, decisionDue: () => sdk.decisionRevision !== sdk.revision || Date.now() >= sdk.nextReviewAt, async close() {} };
  const scope = controller.scope(project, model);
  const context = { projectId: project.id, scope, initialized: true, sources: new Set(controller.sources(project, scope).map(row => row.id)), notBefore: 0, activeHandles: new Set(), coordinator };
  controller.contexts.set(project.id, context);
  let projections = 0; const projectSnapshot = controller.snapshot;
  controller.snapshot = function(...args) { projections++; return projectSnapshot.apply(this, args); };
  t.after(() => controller.close());
  return { controller, project, session, context, coordinator, sdk, observed, interrupted, invalidated, projections: () => projections };
}

test('idle, in-flight and backoff pumps do not rebuild conversation/learning snapshots', async t => {
  for (const gate of ['nextReview', 'initialDelay', 'inFlight', 'unsettled', 'failureBackoff', 'capacity']) await t.test(gate, async t => {
    const f = fixture(t); f.sdk.decisionRevision = -1;
    if (gate === 'nextReview') f.sdk.decisionRevision = f.sdk.revision;
    if (gate === 'initialDelay') f.context.notBefore = Date.now() + 60000;
    if (gate === 'inFlight') f.context.reviewPromise = Promise.resolve();
    if (gate === 'unsettled') f.coordinator.unsettled.add('held');
    if (gate === 'failureBackoff') f.sdk.failureRetryAt = Date.now() + 60000;
    if (gate === 'capacity') f.controller.maxConcurrentReviews = 0;
    for (let i = 0; i < 30; i++) await f.controller.pump();
    assert.equal(f.projections(), 0); assert.equal(f.observed.length, 0);
  });
});

test('ready stale-result chains yield to heartbeat timers before the burst finishes', async t => {
  const f = fixture(t); f.sdk.decisionRevision = -1;
  let ticks = 0; const total = 200;
  f.coordinator.tick = async () => ({ status: ++ticks < total ? 'stale' : 'idle' });
  let atHeartbeat;
  const heartbeat = new Promise(resolve => setTimeout(() => { atHeartbeat = ticks; resolve(); }, 0));
  f.controller.schedule(); await heartbeat;
  assert.ok(atHeartbeat < total, `timer must run during the burst, got ${atHeartbeat}/${total}`);
  const deadline = Date.now() + 5000;
  while (ticks < total && Date.now() < deadline) await immediate();
  assert.equal(ticks, total); assert.equal(f.projections(), total);
});

test('new evidence invalidates only judgment while permission revocation synchronously cancels every execution domain', async t => {
  const f = fixture(t); f.project.permissions = { workspace: 'write', background: 'inherit' };
  f.context.reviewPromise = Promise.resolve();
  const judgment = new AbortController(), readonlyWork = new AbortController();
  f.context.judgeAbort = judgment;
  f.coordinator.active.set('independent-readonly-work', { controller: readonlyWork });
  f.session.items.push({ id: 'new-user', kind: 'user', text: 'A new actual instruction', createdAt: new Date().toISOString() });
  f.controller.invalidate(); f.controller.schedule();
  assert.deepEqual(f.invalidated, ['new_project_evidence']); assert.deepEqual(f.interrupted, []); assert.equal(f.observed.length, 0);
  assert.equal(judgment.signal.aborted, true, 'the stale judgment is cancelled before deferred scheduling');
  assert.equal(readonlyWork.signal.aborted, false, 'ordinary evidence is not authority to cancel an independent readonly action');
  await immediate(); await f.controller.pendingPump;
  assert.equal(f.observed.at(-1).id, 'message:new-user'); assert.equal(f.projections(), 0);
  assert.equal(readonlyWork.signal.aborted, false); assert.deepEqual(f.interrupted, []);
  const replacementJudgment = new AbortController(); f.context.judgeAbort = replacementJudgment;
  // A narrower background grant (write → read) is an authority change; context drift is not (PDL-1).
  f.project.permissions = { workspace: 'read', background: 'read' };
  f.controller.invalidate();
  assert.equal(f.interrupted.at(-1), 'project_permission_reduced');
  assert.equal(replacementJudgment.signal.aborted, true); assert.equal(readonlyWork.signal.aborted, true);
});

test('the next admitted tick gets the current state, and closing cancels scheduled work', async t => {
  const f = fixture(t);
  await f.controller.pump(); assert.equal(f.projections(), 0);
  f.project.evolution.enabled = true; f.project.evolution.lastAutonomousStartedAt = new Date().toISOString();
  f.sdk.decisionRevision = -1; let ticks = 0;
  f.coordinator.tick = async () => { ticks++; assert.equal(f.coordinator.project.learningStatus.enabled, true); assert.equal(f.coordinator.project.learningStatus.lastAutonomousStartedAt, f.project.evolution.lastAutonomousStartedAt); return { status: 'idle' }; };
  await f.controller.pump(); await f.context.reviewPromise;
  assert.equal(ticks, 1); assert.equal(f.projections(), 1);
  f.controller.schedule(); await f.controller.close(); await delay(5);
  assert.equal(ticks, 1); assert.equal(f.controller.scheduled, false);
});
