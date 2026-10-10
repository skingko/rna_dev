import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectEvolutionService } from '../test-support/marketplace-isolation.mjs';

// K4 scenario harness: a real Store in a temp directory, the real host
// initiative controller, a fake clock, a scripted ("obedient") decision model
// and an optional fake JEV. No network, no paid calls, no production state.
// The scripted model acts correctly iff the host shows it the right facts, so
// assertions measure host plumbing (capture, pacing, narration), not model luck.
export const HOUR = 3600000, DAY = 24 * HOUR;

export class FakeClock {
  constructor(start = Date.now()) { this.t = typeof start === 'string' ? Date.parse(start) : start; this.now = () => this.t; }
  advance(ms) { this.t += ms; return this.t; }
  set(at) { const next = typeof at === 'string' ? Date.parse(at) : at; if (next > this.t) this.t = next; return this.t; }
  iso() { return new Date(this.t).toISOString(); }
}

/** Parse the host decision request (plain JSON snapshot, or shared-prefix text) and whether it is a repair round. */
export function decisionRequest(options) {
  const texts = (options.messages ?? []).flatMap(message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text));
  let input = null; for (const text of texts) { try { const value = JSON.parse(text); if (value && typeof value === 'object' && value.events) { input = value; break; } } catch { /* not the snapshot */ } }
  return { input: input ?? {}, raw: texts.join('\n'), repair: (options.messages ?? []).length > 1 && /Final repair attempt/.test(texts.at(-1) ?? '') };
}
const evidenceOf = input => input.events?.at(-1)?.id;
/** Decision helpers for scripted models. */
export const decide = {
  wait: (input, ms = HOUR) => ({ action: 'wait', content: '', evidenceIds: evidenceOf(input) ? [evidenceOf(input)] : [], reason: 'Nothing new worth the user\'s attention.', nextReviewAfterMs: ms }),
  share: (input, content, extra = {}) => ({ action: 'share', content, evidenceIds: [evidenceOf(input)], reason: 'A concrete, new finding for the user.', nextReviewAfterMs: HOUR, ...extra }),
  ask: (input, question, extra = {}) => ({ action: 'ask', content: '需要你决定一件事。', questions: [{ id: 'q1', question, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], evidenceIds: [evidenceOf(input)], reason: 'A decision only the user can make.', nextReviewAfterMs: HOUR, ...extra }),
};
/** Scripted streaming provider: fn({ input, raw, repair, call }) → decision object. Repairs default to wait. */
export function scriptedModel(fn, { calls = [] } = {}) {
  const provider = async function* (options) {
    const request = decisionRequest(options); calls.push(request);
    const output = request.repair ? decide.wait(request.input) : await fn({ ...request, call: calls.length });
    yield { type: 'text_delta', delta: JSON.stringify(output ?? decide.wait(request.input)) };
    yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } };
    yield { type: 'done', stopReason: 'stop' };
  };
  provider.calls = calls;
  return provider;
}
/** Fake JEV (decision service): deterministic answers from a table keyed by decision point. */
export function fakeJev(table = {}) {
  const calls = [];
  return { calls, enabled: point => Object.hasOwn(table, point), review: async (point, project, options) => { calls.push({ point }); return typeof table[point] === 'function' ? table[point](project, options) : table[point] ?? { review: true }; },
    messageCheck: async (project, options) => { calls.push({ point: 'message.check' }); return typeof table['message.check'] === 'function' ? table['message.check'](project, options) : []; }, messageValue: async (project, options) => { calls.push({ point: 'message.value' }); return typeof table['message.value'] === 'function' ? table['message.value'](project, options) : null; }, labelDecision: () => {}, calibration: () => ({}) };
}

/**
 * A scenario world. options: { clock, model (scripted provider), jev, project (patch), controller (extra options) }.
 * Methods add user messages/turns, simulate presence, and advance the clock through wakes.
 */
export async function createWorld({ clock = new FakeClock(), model = scriptedModel(({ input }) => decide.wait(input)), jev, project: patch = {}, controller: extra = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-bench-scenario-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Bench fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'bench-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'bench-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: patch.name ?? 'Bench project', description: patch.description ?? 'Benchmark scenario project', workspace: directory, initiative: { cooldownMs: 0 } });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.overview = patch.overview ?? 'Benchmark scenario'; target.assignments = { skillIds: [], toolIds: ['project_read', 'project_list'], mcpServerIds: [] }; target.initiative.tokenBudget = 10_000_000; target.initiative.reviewMinMs = 60000;
    if (patch.openQuestions) target.openQuestions = [...patch.openQuestions]; if (patch.mind) target.mind = structuredClone(patch.mind); patch.mutate?.(target, state); });
  const interactions = new UserInteractionService(store);
  const evolutionService = new ProjectEvolutionService(store, { provider: model });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, decisionProvider: model, evolutionService, interactionService: interactions, decisionService: jev, now: clock.now, feedbackCheckIntervalMs: 0, ...extra });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const sessionNow = () => store.state.sessions.find(row => row.id === session.id);
  const world = {
    directory, store, controller, clock, model, jev, projectId: project.id, sessionId: session.id, current, session: sessionNow, interactions,
    /** Delivered proactive messages (conversation items from initiative, incl. question cards) and inbox entries. */
    delivered: () => (sessionNow()?.items ?? []).filter(item => item.source === 'initiative' || item.kind === 'question' && item.interaction?.actionId),
    inbox: () => current()?.inbox ?? [],
    asks: () => (current()?.inbox ?? []).filter(row => row.kind === 'ask'),
    /** Append a user message; `turn` = 'completed'|'failed'|null adds a terminal foreground turn for it. */
    user(text, { turn = 'completed', reply = null } = {}) {
      const itemId = randomUUID(), turnId = turn ? randomUUID() : null, at = clock.iso();
      store.mutate(state => { const target = state.sessions.find(row => row.id === session.id);
        target.items.push({ id: itemId, turnId, kind: 'user', text, createdAt: at, simulated: false, delivery: 'send', attachments: [], skillIds: [] });
        if (turnId) { target.turns.push({ id: turnId, status: turn, stage: 0, mode: 'build', createdAt: at, startedAt: at, completedAt: at, userItemId: itemId, simulated: false, projectId: project.id, modelConfig: { execution: 'rna', providerId: provider.id, modelId: 'bench-model' } });
          if (reply) target.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: reply, createdAt: at, simulated: false, final: true }); }
        target.updatedAt = at; });
      controller.schedule(); return { itemId, turnId };
    },
    /** New external evidence (a project observation) — wakes the background mind. */
    observe(text, kind = 'note') {
      const id = randomUUID(); store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.observations ??= []; target.observations.push({ id, kind, text, status: 'open', createdAt: clock.iso(), simulated: false, data: {} }); });
      controller.schedule(); return id;
    },
    /** Simulate the user's presence in the project (visible conversation, not typing). */
    present(visible = true, ttlMs = 5 * 60000) { store.presences?.set(project.id, visible ? { projectId: project.id, sessionId: session.id, visible: true, typing: false, expiresAt: new Date(clock.now() + ttlMs).toISOString(), receiptId: randomUUID() } : null); if (!visible) store.presences?.delete(project.id); controller.schedule(); },
    /** Let the controller run to quiescence. */
    async settle({ timeoutMs = 15000, quietPolls = 4 } = {}) {
      const deadline = Date.now() + timeoutMs; let quiet = 0;
      while (Date.now() < deadline) {
        const busy = controller.scheduled || controller.pumping || [...controller.contexts.values()].some(context => context.reviewPromise || context.coordinator.active.size || context.coordinator.unsettled.size);
        quiet = busy ? 0 : quiet + 1; if (quiet >= quietPolls) return; await delay(10);
      }
      throw Object.assign(new Error('Scenario world did not settle'), { code: 'bench_settle_timeout' });
    },
    /** Advance the fake clock and let due reviews run. */
    async wake(ms = 0) { if (ms) clock.advance(ms); controller.schedule(); await world.settle(); },
    /** Step through `span` in `step` increments (a simulated stretch of days). */
    async run(span, step = HOUR, onStep) { for (let elapsed = 0; elapsed < span; elapsed += step) { await world.wake(step); await onStep?.(world, elapsed + step); } },
    async close() { await controller.close(); rmSync(directory, { recursive: true, force: true }); },
  };
  await world.settle();
  return world;
}
