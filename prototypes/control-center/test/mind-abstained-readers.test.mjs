import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, setup } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { GUARD_AUTHOR_SYSTEM } from '../gene-evolution-service.mjs';
import { mineProjectSignals } from '../project-interaction-signals.mjs';

// P2 B5 review, MIND-12 (mu decisions/memory.ts:240-249: unclear is no verdict): when JEV answered a message's capture
// questions but abstained on is_correction, item.capture.correction is null. The readers of that field outside the
// mind (evolution leveling and lane B, lane C outcomes, the interaction signal miner) read it as unknown and change
// nothing; they used to read the stored `false` as a confident "not a correction". Models are local stubs.
const CORRECTION = '不对，重写这一章';

test('a correction JEV abstained on counts no clean use, starts no review, gives no lane C outcome and no correction signal', async t => {
  const f = await setup(t, (input, res) => stream(res, (input.messages.find(row => row.role === 'system')?.content ?? '').includes(GUARD_AUTHOR_SYSTEM.slice(0, 60)) ? JSON.stringify(GUARD_ANSWER) : 'ok'));
  let lessonId;
  f.app.store.mutate(state => { lessonId = createMindEntry(state.projects.find(row => row.id === f.project.id), 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  const guard = () => f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  f.app.genes.genes.record(f.project.id, guard().id, row => { row.status = 'trial'; });
  let judged = 0; f.app.genes.decisions.mindJudge = async () => { judged++; return { same: [], contradicts: [], applies: [], resolved: [] }; };
  // A real (not simulated) conversation, as the signal miner reads only those.
  f.app.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).simulated = false; });
  // A guarded turn, then the user's next message, captured with the given correction verdict (null: JEV abstained).
  const pair = correction => {
    const previous = randomUUID(), next = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => {
      const s = state.sessions.find(row => row.id === f.session.id), item = (turnId, kind, text, extra = {}) => s.items.push({ id: randomUUID(), turnId, kind, text, createdAt: at, simulated: false, ...extra });
      s.turns.push({ id: previous, status: 'completed', userItemId: `u-${previous}`, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false });
      item(previous, 'user', '写第 1 章', { id: `u-${previous}` }); item(previous, 'assistant', '第一章写好了。', { final: true });
      s.turns.push({ id: next, status: 'completed', userItemId: `u-${next}`, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false });
      item(next, 'user', CORRECTION, { id: `u-${next}`, ...(correction === undefined ? {} : { capture: { correction, preference: false, approval: false, pendingRequest: false, selfImprovement: false, source: 'jev', sources: correction === null ? {} : { correction: 'jev' }, at } }) });
      item(next, 'assistant', '好的。', { final: true });
    });
    f.app.genes.genes.record(f.project.id, guard().id, row => { row.turns = [...(row.turns ?? []), previous]; });
    return { previous, next };
  };
  const capture = async (ids, correction) => f.app.genes.afterCapture({ projectId: f.project.id, sessionId: f.session.id, turnId: ids.next, record: { correction }, text: CORRECTION });
  const outcomeOf = turnId => f.app.genes.contrastOutcomes(f.current()).find(row => row.source.turnId === turnId)?.outcome ?? null;
  const correctionSignal = turnId => mineProjectSignals(f.app.store.state, f.project.id, { now: Date.now() + 1000 }).find(row => row.kind === 'user_correction' && row.turnId === turnId) ?? null;

  const unknown = pair(null);
  assert.deepEqual(await capture(unknown, null), { used: 1, unknown: true });
  assert.equal(guard().stats?.clean ?? 0, 0, 'no clean use counted on a guess'); assert.equal(guard().status, 'trial');
  assert.equal(f.current().genes.funnel?.B?.corrections, undefined, 'lane B is not started'); assert.equal(judged, 0);
  assert.equal(outcomeOf(unknown.previous), null, 'lane C does not read it as accepted');
  assert.equal(correctionSignal(unknown.previous), null, 'the signal miner does not fall back to its regex on a captured message');

  // The verdicts JEV gave are read as before: "not a correction" is a clean use and an accepted turn.
  const clean = pair(false);
  assert.deepEqual(await capture(clean, false), { used: 1 });
  assert.equal(guard().stats.clean, 1); assert.equal(outcomeOf(clean.previous), 'accepted'); assert.equal(correctionSignal(clean.previous), null);
  const corrected = pair(true);
  await capture(corrected, true);
  assert.equal(f.current().genes.funnel.B.corrections, 1); assert.equal(outcomeOf(corrected.previous), 'corrected');
  assert.equal(correctionSignal(corrected.previous).detail.via, 'capture:jev');
  // A message never captured still meets the miner's weak regex fallback.
  const uncaptured = pair(undefined);
  assert.equal(correctionSignal(uncaptured.previous).detail.via, 'regex');
});
