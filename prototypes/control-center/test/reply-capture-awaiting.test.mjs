import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { ProjectMindService } from '../project-mind.mjs';
import { recordDelivery, settleDeliveryFeedback } from '../proactive-delivery.mjs';

// C3 (review note): the project mind announces a user message's capture before it lands (captureInput) and the delivery
// ledger does not read the message until it has, so B3's order rule cannot settle a share first. This pins the mind's
// half (announce, let go when the capture lands, let go of a leak) and the ledger's reading of it through the store, which
// the unit tests only covered with an injected set. No model, no JEV, no network.
const CLOCK = Date.parse('2026-10-05T01:00:00Z'), HOUR = 3600000, iso = ms => new Date(ms).toISOString();
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-capture-awaiting-')), store = new Store(join(dir, 'state.json')), clock = { value: CLOCK };
  const { project, session } = store.createProject({ name: '玄幻小说', workspace: dir });
  store.mutate(state => { Object.assign(state.projects.find(row => row.id === project.id), { simulated: false, decisionMode: 'rna-model', initialization: { status: 'ready' } }); state.sessions.find(row => row.id === session.id).simulated = false; });
  const mind = store.mind = new ProjectMindService(store, { decisions: null, provider: null, now: () => clock.value, sweepIntervalMs: 0, notesIntervalMs: 3600000 });
  t.after(async () => { await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, mind, project, session, clock, sessionOf: () => store.state.sessions.find(row => row.id === session.id) };
}
const route = capture => ({ capture: { isCorrection: false, isPreference: false, isApproval: false, pendingRequest: false, selfImprovement: false, ...capture } });

test('a message whose capture is announced is not read by the ledger until the capture lands; a leaked announcement is let go', async t => {
  const f = setup(t), shareId = randomUUID();
  f.store.mutate(state => {
    const target = state.projects.find(row => row.id === f.project.id);
    state.sessions.find(row => row.id === f.session.id).items.push({ id: shareId, kind: 'assistant', source: 'initiative', text: '第三章有两处时间线矛盾。', createdAt: iso(CLOCK), initiativeActionId: 'act-1', initiative: { kind: 'insight', reach: 'inline' }, final: true });
    recordDelivery(target, { actionId: 'act-1', tier: 'inline', text: '第三章有两处时间线矛盾。', sessionId: f.session.id, itemId: shareId, now: CLOCK });
  });
  // The user's message, an hour later; its turn is admitted and the route announces the capture.
  f.clock.value = CLOCK + HOUR;
  const turnId = randomUUID(), userItemId = randomUUID();
  f.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status: 'completed', userItemId, createdAt: iso(f.clock.value), completedAt: iso(f.clock.value), modelConfig: { execution: 'rna' }, simulated: false }); s.items.push({ id: userItemId, turnId, kind: 'user', text: '今天先写第四章', createdAt: iso(f.clock.value), simulated: false }); });
  f.mind.captureInput(f.sessionOf(), f.sessionOf().items.find(row => row.id === userItemId));
  assert.deepEqual([...f.mind.capturesAwaited()], [userItemId]);
  const options = { decisions: { enabled: () => false }, now: CLOCK + HOUR + 1000 };
  assert.deepEqual(settleDeliveryFeedback(f.store, f.project.id, options), [], 'announced: the share is not settled by order while its capture is on the way');
  assert.equal(f.store.state.projects.find(row => row.id === f.project.id).inbox[0].feedback, null);
  // The capture lands without naming a target: the announcement is gone and the message is read, now by the order rule.
  await f.mind.capture({ sessionId: f.session.id, turnId, route: route({}) });
  assert.equal(f.mind.capturesAwaited().size, 0, 'settled when the capture ends');
  assert.equal(f.sessionOf().items.find(row => row.id === userItemId).capture.target, undefined);
  const [settled] = settleDeliveryFeedback(f.store, f.project.id, options);
  assert.deepEqual([settled.feedback.outcome, settled.feedback.replyVia], ['replied', 'order'], 'no one named a target (the capture had none): B3 reads it, now that nothing is awaited');
  // A capture that never lands is not waited for for ever: the announcement is let go after the longest a capture can last.
  const leaked = randomUUID(); f.mind.captureAwaiting.set(leaked, f.clock.value);
  assert.equal(f.mind.capturesAwaited().has(leaked), true);
  f.clock.value += 121000; assert.equal(f.mind.capturesAwaited().has(leaked), false);
});
