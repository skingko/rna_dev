import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController, wakeOutcome } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { WAKE_LADDER, advanceWake } from '../proactive-pacing.mjs';
import { wakeCell } from '../proactive-metrics.mjs';

// A floor wake (the host's backstop timer on a quiet project with open work) that finds the request unchanged apart from
// the clock keeps the rest the last wait asked for, through the real controller and SDK coordinator: no decision is paid,
// the row is a deferred wake with the request it did not send, and the floor's timer waits for the end of that rest.
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
async function until(check, label, timeout = 8000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await delay(5); } }
const PLAN = { version: 1, questions: { initiative_need: { type: 'boolean', instructions: 'Does verified project evidence call for background action now?', criteria: { true: 'A concrete verified gap needs work.', false: 'Nothing verified needs work now.' } } } };
const assessment = input => ({ lifecycle: 'active', reason: 'Based on the actual provided project evidence and registered responsibilities.', evidenceIds: [input.events.at(-1).id], scheduleIds: [], initiative: { mode: 'event_only', reviewAfterMs: DAY }, evolution: { mode: 'weekly', maxPerDay: 1, maxPerWeek: 1, minIntervalMs: DAY } });

async function fixture(t, { respond }) {
  let clock = Date.now() - DAY;
  const directory = mkdtempSync(join(tmpdir(), 'rna-initiative-rest-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Rest fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4096, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Rest fixture', description: 'Write and revise chapters', workspace: directory, rhythm: { control: 'auto' }, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const p = state.projects.find(row => row.id === project.id); Object.assign(p, { decisionMode: 'rna-model', simulated: false, initialization: { status: 'ready' }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } }); p.initiative.tokenBudget = null; state.settings.realTokenBudget = null; });
  writeFileSync(join(directory, 'chapter.md'), 'Chapter one.');
  const calls = [], f = { store, project, session, calls, now: () => clock, advance: ms => { clock += ms; } };
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => clock, evolutionService: { running: new Map() },
    decisionProvider: async function* (request) {
      const input = JSON.parse(request.messages[0].content[0].text); calls.push(input);
      const output = { reason: 'Fixture decision', content: '', evidenceIds: [], nextReviewAfterMs: DAY, ...respond(input, calls.length), ...(input.hostConditions?.judgment?.requiresAssessment ? { judgmentPolicy: PLAN } : {}) };
      yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { yield { type: 'text_delta', delta: 'Done.\nHandoff: nothing.' }; yield { type: 'done', stopReason: 'stop' }; yield { type: 'usage', usage: { input: 1, output: 1, totalTokens: 2 } }; } }) });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  Object.assign(f, { controller,
    current: () => store.state.projects.find(row => row.id === project.id),
    context: () => controller.contexts.get(project.id),
    wake: () => store.state.projects.find(row => row.id === project.id).mind?.pacing?.wake ?? {},
    async settle(rounds = 3) { for (let n = 0; n < rounds; n++) { await controller.pump(); await f.context()?.reviewPromise; await delay(2); } },
    openAgenda() { store.mutate(state => { const p = state.projects.find(row => row.id === project.id); p.mind ??= {}; p.mind.agenda = [{ id: 'a1', kind: 'todo', text: 'Tune the ending of chapter three', status: 'open', createdAt: new Date(clock).toISOString() }]; }); },
  });
  await until(() => f.context()?.initialized && calls.length >= 1 && !f.context().reviewPromise, 'first review');
  await f.settle();
  return f;
}

test('a floor wake that finds nothing new keeps the rest its last wait asked for: no paid decision, a deferred row with the saving, the timer at the rest\'s end', async t => {
  const REST = 6 * HOUR;
  const f = await fixture(t, { respond: (input, n) => n === 1 ? { action: 'wait', rhythm: assessment(input) } : { action: 'wait', nextReviewAfterMs: REST } });
  f.openAgenda();
  // The floor's first wake: the agenda is new, so the model is asked, and its wait says it can rest six hours.
  f.advance(WAKE_LADDER[0] + MINUTE); await f.settle();
  await until(() => f.calls.length === 2, 'the floor decides');
  const decided = f.context().coordinator.state.lastDecision, restEnd = decided.at + REST;
  assert.equal(decided.action, 'wait'); assert.match(decided.situation, /^[0-9a-f]{32}$/);
  assert.equal(f.wake().lastOutcome, 'thought');
  const used = f.context().coordinator.state.usedTokens;
  // The ladder's next rung falls due, and nothing but the clock has moved.
  f.advance(Date.parse(f.wake().nextAt) - f.now() + MINUTE); await f.settle();
  assert.equal(f.calls.length, 2, 'no decision was paid for');
  const row = f.wake().history.at(-1);
  assert.deepEqual([row.outcome, row.reason, row.floor], ['deferred', 'unchanged_since_wait', true]);
  assert.ok(row.saved > 1000, 'the request it did not send is recorded');
  assert.equal(row.tokens, 0); assert.equal(f.context().coordinator.state.usedTokens, used);
  assert.equal(Date.parse(f.wake().nextAt), restEnd, 'the floor waits for the end of the rest, not for the ladder\'s next rung');
  // Pumps through the rest ask for nothing and write nothing more.
  const rows = f.wake().history.length;
  for (let n = 0; n < 5; n++) { f.advance(HOUR - MINUTE); await f.settle(2); }
  assert.equal(f.calls.length, 2); assert.equal(f.wake().history.length, rows);
  // The rest is over: the model is asked again.
  f.advance(restEnd - f.now() + MINUTE); await f.settle();
  await until(() => f.calls.length === 3, 'asked again once the rest ended');
  assert.equal(f.wake().history.at(-1).outcome, 'thought');
});

test('new evidence ends the rest at once', async t => {
  const f = await fixture(t, { respond: (input, n) => n === 1 ? { action: 'wait', rhythm: assessment(input) } : { action: 'wait', nextReviewAfterMs: 6 * HOUR } });
  f.openAgenda();
  f.advance(WAKE_LADDER[0] + MINUTE); await f.settle();
  await until(() => f.calls.length === 2, 'the floor decides');
  f.advance(Date.parse(f.wake().nextAt) - f.now() + MINUTE); await f.settle();
  assert.equal(f.wake().history.at(-1).reason, 'unchanged_since_wait');
  assert.equal(f.calls.length, 2);
  // The user writes: well inside the rest, the model is asked at once and the row is a paid wait.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u-new', turnId: null, kind: 'user', text: 'Please look at the ending of chapter three.', createdAt: new Date(f.now()).toISOString(), simulated: false }); });
  f.advance(MINUTE); await f.settle(4);
  await until(() => f.calls.length === 3, 'the new message is reviewed');
  assert.equal(f.wake().history.at(-1).outcome, 'thought');
  assert.ok(f.calls[2].events.some(event => /ending of chapter three/.test(event.summary)));
});

test('wakeOutcome names a rested floor wake as a deferred one with its saving; advanceWake and the metrics keep it', () => {
  assert.deepEqual(wakeOutcome({ status: 'idle', reason: 'unchanged_since_wait', restUntil: 5, savedTokens: 70000 }), { outcome: 'deferred', reason: 'unchanged_since_wait', saved: 70000 });
  assert.equal(wakeOutcome({ status: 'idle', reason: 'not_due' }), null, 'any other idle tick is still no wake at all');
  const wake = advanceWake({}, 'deferred', { now: Date.UTC(2026, 9, 22), floor: true, reason: 'unchanged_since_wait', saved: 70000.4 });
  assert.equal(wake.history[0].saved, 70000); assert.equal(wake.quietWakes, 0, 'a deferral is not a paid wait');
  assert.equal(advanceWake({}, 'deferred', { now: 1, saved: 0 }).history[0].saved, undefined);
  const cell = wakeCell('p', wake.history[0]);
  assert.deepEqual([cell.key.outcome, cell.key.reason, cell.values.saved, cell.values.tokens ?? 0], ['deferred', 'unchanged_since_wait', 70000, 0]);
});
