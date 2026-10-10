import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController, applyConversationMembership } from '../project-initiative-controller.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { publishPrefix, forgetPrefix } from '../prompt-prefix-registry.mjs';
import { workspaceBinding, workspaceHistory, workspaceEra } from '../initiative-privacy.mjs';
import { ensureMind, addLesson, addAgenda, mindSource } from '../project-mind.mjs';

// PDL-1 / MEM-2: the initiative scope is a privacy identity; context drift refreshes the coordinator and conversation
// membership changes only what cites the conversation. Only provider output is scripted; no network is used.
const origin = Date.parse('2026-09-26T00:00:00Z');
async function until(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (check()) return; await delay(5); } throw new Error(`Timeout: ${label}`); }
const wait = async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'Nothing else to do', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; };

/**
 * A daily scheduled report that completed during quiet time: its occurrence waits as delivery_pending. With
 * `budget: 0` its run is claimed and queued but cannot start (the occurrence waits as queued).
 */
const QUIET = '2099-01-01T00:00:00.000Z';
async function scheduled(t, { budget = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-scope-split-schedule-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated scope fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Recurring evidence review', description: 'A generic periodic report', workspace: dir });
  let now = origin + 3600000, calls = 0;
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
    Object.assign(target.initiative, { tokenBudget: budget, cooldownMs: 0, quietUntil: QUIET });
    target.schedules = [createProjectSchedule({ id: 'review', title: 'Daily report', task: 'Inspect evidence.txt and deliver the actual finding.', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })];
    state.settings.realTokenBudget = null;
  });
  writeFileSync(join(dir, 'evidence.txt'), 'Measured result: seven verified sources.');
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => now, decisionProvider: wait, runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () {
    calls++; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'text_delta', delta: 'Daily report: seven sources verified.' }; yield { type: 'done', stopReason: 'stop' };
  } }) });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  if (budget === 0) await until(() => current().initiativeRuntime?.sdkState?.actions.some(row => row.hostSchedule && row.deferredReason === 'budget_exhausted'), 'scheduled run queued');
  else await until(() => current().scheduleRuntime?.occurrences[0]?.status === 'delivery_pending', 'delivery_pending');
  const settle = async () => { controller.schedule(); await delay(20); await controller.pendingPump; await controller.contexts.get(project.id)?.reviewPromise; };
  return { dir, store, project, session, controller, current, settle, calls: () => calls, sdk: () => current().initiativeRuntime.sdkState, messages: () => store.state.sessions.flatMap(row => row.items.filter(item => item.scheduleOccurrenceKey)) };
}
/** Another project's capability install: the global registry and that project's own assignments change. */
function installElsewhere(store) {
  const other = store.createProject({ rhythm: { control: 'manual' }, name: 'Another project' }).project;
  store.mutate(state => {
    state.capabilities = { ...state.capabilities, revision: (state.capabilities?.revision ?? 0) + 1, skills: [...(state.capabilities?.skills ?? []), { id: 'other-skill', name: 'Other project skill', description: 'Installed for another project' }] };
    const target = state.projects.find(row => row.id === other.id); target.assignments = { skillIds: ['other-skill'], toolIds: [], mcpServerIds: [] }; target.capabilityRevision = 1;
  });
}
/** A gene generation in this project: a new active version and its own skill, in the registry and the assignments. */
function generation(store, projectId, n) {
  store.mutate(state => {
    const project = state.projects.find(row => row.id === projectId);
    project.versions = [...(project.versions ?? []), { id: `gen-${n}`, version: `gen-${n}`, state: 'active', source: 'gene-tree', bundle: { hash: String(n).repeat(64).slice(0, 64) }, createdAt: new Date(origin).toISOString(), simulated: false, generation: n }];
    project.activeVersionId = `gen-${n}`; project.capabilityRevision = (project.capabilityRevision ?? 0) + 1;
    project.assignments = { ...project.assignments, skillIds: [...(project.assignments?.skillIds ?? []), `gen-${n}-skill`] };
    state.capabilities = { ...state.capabilities, revision: (state.capabilities?.revision ?? 0) + 1, skills: [...(state.capabilities?.skills ?? []), { id: `gen-${n}-skill`, name: `Generation ${n}`, description: 'This project’s own' }] };
  });
}

test('a capability install in another project, a new conversation, a plan toggle and a gene generation leave a delivery_pending occurrence, its queued delivery and the completed scheduled work untouched', async t => {
  const f = await scheduled(t), context = f.controller.contexts.get(f.project.id), drift = context.drift;
  const occurrence = () => f.current().scheduleRuntime.occurrences[0];
  const work = () => f.sdk().actions.find(row => row.id === occurrence().actionId), delivery = () => f.sdk().actions.find(row => row.id === occurrence().deliveryActionId);
  const before = { work: structuredClone(work()), job: structuredClone(f.current().jobs.find(row => row.id === occurrence().actionId)), events: structuredClone(f.sdk().events) };
  assert.equal(delivery().status, 'queued'); assert.equal(delivery().deferredReason, 'quiet_until');
  const steps = [
    ['capability install elsewhere', () => installElsewhere(f.store)],
    ['new conversation', () => f.store.createSession({ projectId: f.project.id, title: 'A second conversation' })],
    ['plan toggle', () => { f.store.updateSession(f.session.id, { mode: 'plan' }); f.store.updateSession(f.session.id, { mode: 'build' }); }],
    ['gene generation', () => generation(f.store, f.project.id, 1)],
  ];
  for (const [label, step] of steps) {
    step(); await f.settle();
    assert.equal(f.controller.contexts.get(f.project.id), context, `${label}: the coordinator is kept`);
    assert.equal(occurrence().status, 'delivery_pending', label); assert.equal(delivery().status, 'queued', label);
    assert.deepEqual(work(), before.work, `${label}: the completed scheduled work keeps its receipt`);
    assert.deepEqual(f.current().jobs.find(row => row.id === occurrence().actionId), before.job, label);
  }
  assert.notEqual(context.drift, drift, 'the gene generation refreshed what the coordinator froze');
  assert.ok(before.events.every(event => f.sdk().events.some(row => row.id === event.id)), 'events are kept');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiative.quietUntil = null; });
  await until(() => f.messages().length === 1, 'delivered once'); await f.settle();
  assert.equal(f.calls(), 1, 'the report was not run again'); assert.equal(f.messages().length, 1);
  assert.match(f.messages()[0].text, /seven sources verified/);
});

test('a privacy boundary (the workspace folder moved) revokes: the scheduled work loses its receipt with privacyRevoked and its pending delivery is cancelled', async t => {
  const f = await scheduled(t), occurrence = () => f.current().scheduleRuntime.occurrences[0], actionId = occurrence().actionId;
  // What the old scope's work left in the project's mind (C4): a lesson and a plan item that cite the action.
  let lessonId, planId;
  f.store.mutate(state => {
    const mind = ensureMind(state.projects.find(row => row.id === f.project.id), origin);
    lessonId = addLesson(mind, { kind: 'preference', text: 'Conclusion drawn from the old scope', source: mindSource('background', { actionId }), evidence: [{ actionId, excerpt: 'old scope excerpt', at: new Date(origin).toISOString() }] }, { now: origin }).id;
    planId = addAgenda(mind, { kind: 'todo', text: 'Follow up on the old scope', source: mindSource('background', { actionId }) }, { now: origin }).id;
  });
  const moved = join(f.dir, 'moved'); mkdirSync(moved);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).workspace = moved; });
  await until(() => occurrence().status === 'cancelled', 'occurrence cancelled');
  const work = f.sdk().actions.find(row => row.id === actionId);
  assert.equal(work.contextRevoked, true); assert.equal(work.privacyRevoked, true); assert.equal(work.resultSummary, undefined);
  assert.equal(f.current().jobs.find(row => row.id === actionId).privacyRevoked, true);
  assert.equal(occurrence().errorCode, 'schedule_revoked'); assert.equal(f.messages().length, 0);
  // The same change takes the mind's copies of that work back, in the same transaction, and records the revocation (privacy_revoked, entry C4).
  const mind = f.current().mind;
  assert.equal(mind.lessons.find(row => row.id === lessonId).status, 'retired', 'the lesson drawn from the old scope is retired');
  assert.equal(mind.lessons.find(row => row.id === lessonId).evidence[0].excerpt, undefined, 'its raw excerpt is gone');
  assert.notEqual(mind.agenda.find(row => row.id === planId).status, 'open', 'and the plan item that cited it is dropped');
  const entries = mind.revocations.filter(row => row.type === 'privacy_revoked');
  assert.equal(entries.length, 1); assert.ok(entries[0].actionIds.includes(actionId), 'the entry names the revoked work (and its delivery) as the sources taken back');
});

test('a privacy boundary re-claims a scheduled occurrence that had not started: same window, a fresh run under the new scope, delivered once (§1.2 #8)', async t => {
  const f = await scheduled(t, { budget: 0 }), occurrence = () => f.current().scheduleRuntime.occurrences[0];
  const key = occurrence().key, first = occurrence().actionId;
  assert.equal(occurrence().status, 'queued'); assert.equal(f.calls(), 0);
  const moved = join(f.dir, 'moved'); mkdirSync(moved); writeFileSync(join(moved, 'evidence.txt'), 'Measured result: seven verified sources.');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).workspace = moved; });
  await until(() => occurrence().actionId !== first, 'the occurrence is claimed again');
  const old = f.sdk().actions.find(row => row.id === first);
  assert.equal(old.status, 'cancelled'); assert.equal(old.privacyRevoked, true, 'the old scope\'s action keeps only its receipt');
  assert.deepEqual([occurrence().key, occurrence().status, occurrence().reclaims, occurrence().reclaimedFrom], [key, 'queued', 1, first], 'the same window, not a new one');
  await until(() => f.sdk().actions.some(row => row.id === occurrence().actionId), 'a fresh run under the new scope');
  f.store.mutate(state => { const target = state.projects.find(row => row.id === f.project.id); target.initiative.tokenBudget = null; target.initiative.quietUntil = null; });
  await until(() => f.messages().length === 1, 'delivered'); await f.settle();
  assert.equal(f.calls(), 1, 'one run'); assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].scheduleOccurrenceKey, key);
  assert.equal(occurrence().status, 'delivered');
});

/** A project with two conversations and a completed work receipt citing each one's message. `seed` adds to the saved state. */
async function twoConversations(t, { models = ['fixture'], seed = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-scope-split-sessions-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated scope fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: models.map(id => ({ id, contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] })) });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session: first } = store.createProject({ rhythm: { control: 'manual' }, name: 'Two conversations', workspace: dir });
  const second = store.createSession({ projectId: project.id, title: 'Second conversation' });
  const at = new Date(origin).toISOString();
  const work = (id, messageId) => ({ id, action: 'work', status: 'completed', title: `Task ${id}`, content: `Investigate ${id}`, resultSummary: `Result of ${id}`, handoff: `Handoff of ${id}`, evidenceIds: [`message:${messageId}`], intentKey: id, revision: 1, startedAt: origin, finishedAt: origin + 1000 });
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
    state.sessions.find(row => row.id === first.id).items.push({ id: 'm1', kind: 'user', text: 'First request', createdAt: at, simulated: false });
    state.sessions.find(row => row.id === second.id).items.push({ id: 'm2', kind: 'user', text: 'Second request', createdAt: at, simulated: false });
    target.initiativeRuntime = { sdkState: { schemaVersion: 1, revision: 2, decisionRevision: 2, nextReviewAt: origin + 86400000 * 365, usedTokens: 0, reservedTokens: 0, seenEventIds: ['message:m1', 'message:m2'],
      events: [{ id: 'message:m1', type: 'user_message', summary: 'First request', at: origin }, { id: 'message:m2', type: 'user_message', summary: 'Second request', at: origin }],
      actions: [work('w1', 'm1'), work('w2', 'm2'), { id: 's1', action: 'share', status: 'completed', content: 'Shared result of w1', evidenceIds: ['action:w1:completed'], intentKey: 's1', revision: 2, finishedAt: origin + 2000 }] } };
    target.jobs = ['w1', 'w2'].map((id, index) => ({ id, projectId: project.id, kind: 'research', lane: 'background', status: 'completed', simulated: false, title: `Task ${id}`, instruction: `Investigate ${id}`, output: `Result of ${id}`, handoff: `Handoff of ${id}`, evidenceIds: [`message:m${index + 1}`], createdAt: at }));
    seed(target, state);
  });
  const start = () => new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => origin, decisionProvider: wait });
  const controller = start(), started = [controller];
  t.after(async () => { for (const row of started) await row.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id), action = id => current().initiativeRuntime.sdkState.actions.find(row => row.id === id);
  await until(() => controller.contexts.get(project.id)?.initialized, 'context');
  /** A restart: another controller on the same state (the caller closes the running one first). */
  const restart = async () => { const next = start(); started.push(next); await until(() => next.contexts.get(project.id)?.initialized, 'context after restart'); return next; };
  return { dir, store, controller, project, first, second, current, action, start: () => { const next = start(); started.push(next); return next; }, restart, settle: async (on = controller) => { on.schedule(); await delay(20); await on.pendingPump; } };
}

test('archiving a conversation withdraws only what came from it (the work citing it and the share of that work); restoring it gives the work back from its job', async t => {
  const f = await twoConversations(t);
  f.store.updateSession(f.first.id, { archived: true }); await f.settle();
  await until(() => f.action('w1').revokedBy === 'session_archived', 'w1 withdrawn');
  assert.equal(f.action('w1').contextRevoked, true); assert.deepEqual(f.action('w1').revokedSessionIds, [f.first.id]); assert.equal(f.action('w1').resultSummary, undefined);
  assert.equal(f.action('s1').revokedBy, 'session_archived', 'the share of work from the archived conversation goes too');
  assert.equal(f.action('w2').contextRevoked, undefined); assert.equal(f.action('w2').resultSummary, 'Result of w2');
  const events = f.current().initiativeRuntime.sdkState.events.map(row => row.id);
  assert.ok(!events.includes('message:m1')); assert.ok(events.includes('message:m2'));
  assert.equal(f.action('w1').privacyRevoked, undefined, 'an archive is not a privacy revocation: memory keeps the deliveries');
  f.store.updateSession(f.first.id, { archived: false }); await f.settle();
  await until(() => !f.action('w1').contextRevoked, 'w1 restored');
  assert.equal(f.action('w1').resultSummary, 'Result of w1'); assert.equal(f.action('w1').handoff, 'Handoff of w1'); assert.deepEqual(f.action('w1').evidenceIds, ['message:m1']);
  assert.equal(f.action('s1').contextRevoked, true, 'a share has no job: it keeps its receipt only');
});

test('deleting a conversation still revokes what cites it (sourceDeleted), and only that', async t => {
  const f = await twoConversations(t);
  const service = new SessionDeletionService(f.store, { projectInitiative: f.controller }); t.after(() => service.close());
  f.store.deleteSession(f.first.id);
  assert.equal((await service.wait(f.first.id)).status, 'completed');
  assert.equal(f.action('w1').sourceDeleted, true); assert.equal(f.action('w1').contextRevoked, true);
  assert.equal(f.action('w2').contextRevoked, undefined); assert.equal(f.action('w2').resultSummary, 'Result of w2'); assert.equal(f.action('w2').handoff, 'Handoff of w2');
});

test('applyConversationMembership is idempotent, cancels queued and paused work from an archived conversation, leaves running work to the caller and scrubs a decision citing it', () => {
  const sessions = [{ id: 'a', archivedAt: '2026-10-04T00:00:00Z', items: [{ id: 'm1' }], turns: [{ id: 't1' }] }, { id: 'b', archivedAt: null, items: [{ id: 'm2' }], turns: [] }];
  const state = { events: [{ id: 'message:m1' }, { id: 'turn:t1:completed@x' }, { id: 'message:m2' }], lastDecision: { action: 'work', content: 'ARCHIVED_TEXT', reason: 'ARCHIVED_TEXT', evidenceIds: ['turn:t1:completed@x'], at: 1, revision: 3 },
    actions: [
      { id: 'q', action: 'work', status: 'queued', content: 'ARCHIVED_TEXT', evidenceIds: ['message:m1'] },
      { id: 'p', action: 'work', status: 'paused', content: 'ARCHIVED_TEXT', evidenceIds: ['turn:t1:completed@x'] },
      { id: 'r', action: 'work', status: 'running', content: 'ARCHIVED_TEXT', evidenceIds: ['message:m1'] },
      { id: 'h', action: 'work', status: 'queued', content: 'Scheduled', evidenceIds: ['occurrence-key'], hostSchedule: { key: 'occurrence-key' } },
      { id: 'k', action: 'work', status: 'completed', content: 'Kept', evidenceIds: ['message:m2'] },
      { id: 'd', action: 'work', status: 'completed', content: 'Deleted receipt', evidenceIds: ['message:m1'], sourceDeleted: true },
    ] };
  const first = applyConversationMembership(state, sessions, [], 0);
  assert.equal(first.changed, true); assert.deepEqual(first.running, ['r']); assert.deepEqual(first.ended.map(row => row.id), ['p']);
  assert.deepEqual(state.events.map(row => row.id), ['message:m2']);
  assert.ok(!JSON.stringify(state.actions.filter(row => row.id !== 'r')).includes('ARCHIVED_TEXT')); assert.ok(!JSON.stringify(state.lastDecision).includes('ARCHIVED_TEXT'));
  assert.deepEqual(state.actions.map(row => [row.id, row.status, row.revokedBy ?? null]), [['q', 'cancelled', 'session_archived'], ['p', 'cancelled', 'session_archived'], ['r', 'running', null], ['h', 'queued', null], ['k', 'completed', null], ['d', 'completed', null]]);
  const snapshot = structuredClone(state), again = applyConversationMembership(state, sessions, [], 0);
  assert.equal(again.changed, false); assert.deepEqual(state, snapshot);
});

test('the one-time restore gives drift-revoked work its record back from its job, and leaves shares, deleted or privacy revocations and work from a gone conversation revoked', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-scope-split-restore-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Restore receipts', workspace: dir });
  const archived = store.createSession({ projectId: project.id, title: 'Archived conversation' });
  const PLACEHOLDER = 'Previous project scope; retained only as an action receipt.', at = new Date(origin).toISOString();
  const revoked = (id, extra = {}) => ({ id, action: 'work', status: 'completed', content: PLACEHOLDER, evidenceIds: [], contextRevoked: true, intentKey: id, revision: 1, ...extra });
  store.mutate(state => {
    state.sessions.find(row => row.id === session.id).items.push({ id: 'live-message', kind: 'user', text: 'Live request', createdAt: at, simulated: false });
    const gone = state.sessions.find(row => row.id === archived.id); gone.items.push({ id: 'archived-message', kind: 'user', text: 'Archived request', createdAt: at, simulated: false }); gone.archivedAt = at;
    const target = state.projects.find(row => row.id === project.id);
    target.initiativeRuntime = { sourceHash: 'pre-split-hash', sdkState: { schemaVersion: 1, revision: 1, decisionRevision: 1, nextReviewAt: 0, usedTokens: 0, reservedTokens: 0, events: [], seenEventIds: [], actions: [
      revoked('restored'), revoked('from-archived'), revoked('no-job'), revoked('deleted', { sourceDeleted: true }), revoked('privacy', { privacyRevoked: true }),
      { id: 'share', action: 'share', status: 'completed', content: PLACEHOLDER, evidenceIds: [], contextRevoked: true, intentKey: 'share', revision: 1 },
      { id: 'untouched', action: 'work', status: 'completed', content: 'Current work', resultSummary: 'Current result', evidenceIds: [], intentKey: 'untouched', revision: 1 },
    ] } };
    const job = (id, messageId, extra = {}) => ({ id, projectId: project.id, kind: 'research', lane: 'background', status: 'completed', simulated: false, title: `Title ${id}`, instruction: `Instruction ${id}`, output: `Output ${id}`, handoff: `Handoff ${id}`, evidenceIds: [`message:${messageId}`], createdAt: at, ...extra });
    target.jobs = [job('restored', 'live-message'), job('from-archived', 'archived-message'), job('deleted', 'live-message'), job('privacy', 'live-message')];
  });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request in the restore fixture'); } });
  t.after(() => controller.close());
  const actions = () => store.state.projects.find(row => row.id === project.id).initiativeRuntime.sdkState.actions, action = id => actions().find(row => row.id === id);
  assert.deepEqual([action('restored').content, action('restored').title, action('restored').resultSummary, action('restored').handoff, action('restored').contextRevoked], ['Instruction restored', 'Title restored', 'Output restored', 'Handoff restored', undefined]);
  assert.deepEqual(action('restored').evidenceIds, ['message:live-message']); assert.equal(action('restored').contextRestored.from, 'scope_drift');
  for (const id of ['from-archived', 'no-job', 'deleted', 'privacy', 'share']) { assert.equal(action(id).contextRevoked, true, id); assert.equal(action(id).content, PLACEHOLDER, id); }
  assert.equal(action('untouched').resultSummary, 'Current result');
  const marker = store.state.projects.find(row => row.id === project.id).initiativeRuntime.driftRestore;
  assert.deepEqual({ restored: marker.restored, kept: marker.kept }, { restored: 1, kept: 3 }, 'deleted and privacy revocations are not candidates; share, no-job and from-archived are kept');
  const writes = store.persistence.writes, snapshot = structuredClone(actions());
  const again = new ProjectInitiativeController(store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request'); } });
  t.after(() => again.close());
  assert.equal(store.persistence.writes, writes, 'nothing more to give back: the project is not written again'); assert.deepEqual(actions(), snapshot);
});

/** What a version before the split (0.64) does to a split runtime on the same state: its own hash of everything replaces
 * sourceHash (the rest of the runtime is kept by its spread) and its scope change revokes every action bare. */
function asOlderVersion(store, projectId) {
  store.mutate(state => {
    const project = state.projects.find(row => row.id === projectId), sdk = project.initiativeRuntime.sdkState;
    project.initiativeRuntime = { ...project.initiativeRuntime, sourceHash: 'f'.repeat(64), retainedEvidenceScopeHash: 'e'.repeat(64) };
    sdk.events = []; sdk.seenEventIds = []; sdk.lastDecision = null; sdk.revision++; sdk.decisionRevision = -1;
    for (const action of sdk.actions) { action.evidenceIds = []; action.content = 'Previous project scope; retained only as an action receipt.'; delete action.resultSummary; delete action.handoff; delete action.title; action.contextRevoked = true; }
  });
}

test('a maintenance rollback to a version before the split, then the upgrade again (A1, MIG-2): nothing is privacy-revoked and what the older version revoked gets its record back; a folder moved meanwhile still revokes', async t => {
  const f = await twoConversations(t); await f.settle();
  const runtime = () => f.current().initiativeRuntime;
  assert.equal(runtime().privacyScopeHash, runtime().sourceHash, 'the privacy scope is saved in a field no earlier version writes');
  await f.controller.close();
  asOlderVersion(f.store, f.project.id);
  const upgraded = f.start();
  // The drift restore runs again at start (the earlier run's marker no longer stops it).
  assert.deepEqual([f.action('w1').resultSummary, f.action('w2').resultSummary, f.action('w1').contextRestored?.from], ['Result of w1', 'Result of w2', 'scope_drift']);
  assert.equal(runtime().driftRestore.restored, 2);
  await until(() => upgraded.contexts.get(f.project.id)?.initialized, 'context after the upgrade');
  assert.ok(runtime().sdkState.actions.every(row => !row.privacyRevoked), 'adopted, not revoked'); assert.ok(f.current().jobs.every(row => !row.privacyRevoked));
  assert.equal(f.action('w1').resultSummary, 'Result of w1');
  assert.equal(runtime().sourceHash, runtime().privacyScopeHash, 'saved as the split version again');
  // The older version runs again, and the project folder is moved meanwhile: a privacy change, found through privacyScopeHash.
  await upgraded.close();
  asOlderVersion(f.store, f.project.id);
  const moved = join(f.dir, 'moved'); mkdirSync(moved);
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).workspace = moved; });
  const third = f.start();
  assert.equal(f.action('w1').resultSummary, undefined, 'nothing is given back across a privacy change');
  await until(() => third.contexts.get(f.project.id)?.initialized, 'context after the move');
  assert.equal(f.action('w1').privacyRevoked, true); assert.equal(f.action('w2').privacyRevoked, true);
  assert.ok(f.current().jobs.every(row => row.privacyRevoked === true));
});

test('restoring one of two archived conversations keeps work that also came from the other withdrawn, until both are back (A2)', () => {
  const sessions = (a, b) => [{ id: 'A', archivedAt: a ? '2026-10-04T00:00:00Z' : null, items: [{ id: 'm1' }], turns: [] }, { id: 'B', archivedAt: b ? '2026-10-04T00:00:00Z' : null, items: [{ id: 'm2' }], turns: [] }];
  const jobs = [{ id: 'w', lane: 'background', simulated: false, status: 'completed', title: 'Task w', instruction: 'Investigate both', output: 'Output quoting B', evidenceIds: ['message:m1', 'message:m2'] }];
  const state = { events: [], actions: [{ id: 'w', action: 'work', status: 'completed', title: 'Task w', content: 'Investigate both', resultSummary: 'Output quoting B', evidenceIds: ['message:m1', 'message:m2'] }] };
  const w = () => state.actions[0];
  applyConversationMembership(state, sessions(true, false), jobs, 0);
  assert.deepEqual([w().revokedBy, w().revokedSessionIds], ['session_archived', ['A']]);
  applyConversationMembership(state, sessions(true, true), jobs, 0);
  assert.deepEqual(w().revokedSessionIds, ['A', 'B'], 'a second archive its job cites is added');
  const restoreA = applyConversationMembership(state, sessions(false, true), jobs, 0);
  assert.equal(restoreA.changed, true); assert.equal(w().revokedBy, 'session_archived'); assert.deepEqual(w().revokedSessionIds, ['B']);
  assert.equal(w().resultSummary, undefined, 'B is still archived: its output is not given back');
  assert.equal(applyConversationMembership(state, sessions(false, true), jobs, 0).changed, false, 'idempotent');
  applyConversationMembership(state, sessions(false, false), jobs, 0);
  assert.equal(w().revokedBy, undefined); assert.equal(w().resultSummary, 'Output quoting B'); assert.deepEqual(w().evidenceIds, ['message:m1', 'message:m2']);
});

// A3 asked that a coordinator kept across a model drift never send the old model's agent prefix. Since spec prefix.md §2
// decisions use no agent prefix at all (their own tool-free one), on any model: nothing to pick up before or after a drift.
test('after a model drift the coordinator is kept and still uses no agent prefix of either model (A3)', async t => {
  const f = await twoConversations(t, { models: ['fixture', 'fixture-b'] });
  const context = f.controller.contexts.get(f.project.id), providerId = context.coordinator.model.providerId;
  t.after(() => forgetPrefix(f.project.id));
  publishPrefix(f.project.id, { systemPrompt: 'Prefix built for A', tools: [], modelKey: `${providerId}/fixture` });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).initiative.modelSelection = { providerId, modelId: 'fixture-b', reasoning: 'off' }; });
  await f.settle();
  await until(() => context.coordinator.model.modelId === 'fixture-b', 'drift refreshed');
  assert.equal(f.controller.contexts.get(f.project.id), context, 'the coordinator is kept');
  publishPrefix(f.project.id, { systemPrompt: 'Prefix built for B', tools: [], modelKey: `${providerId}/fixture-b` });
  assert.equal(context.coordinator.sharedPrefix, undefined, 'decisions never take an agent prefix');
});

test('a restored conversation is observed again, live and across a restart (A7)', async t => {
  const f = await twoConversations(t), events = () => f.current().initiativeRuntime.sdkState.events.map(row => row.id);
  assert.ok(events().includes('message:m1'));
  f.store.updateSession(f.first.id, { archived: true }); await f.settle();
  await until(() => !events().includes('message:m1'), 'withdrawn');
  f.store.updateSession(f.first.id, { archived: false }); await f.settle(); await f.settle();
  await until(() => events().includes('message:m1'), 'observed again');
  assert.equal(events().filter(id => id === 'message:m1').length, 1);
  // Archived, then restored while the daemon is down: the saved archived set says it came back.
  f.store.updateSession(f.first.id, { archived: true }); await f.settle();
  await until(() => !events().includes('message:m1') && f.current().initiativeRuntime.archivedSessionIds?.includes(f.first.id), 'withdrawn again');
  await f.controller.close();
  f.store.updateSession(f.first.id, { archived: false });
  const next = await f.restart(); await f.settle(next); await f.settle(next);
  await until(() => events().includes('message:m1'), 'observed after the restart');
});

test('the drift restore and legacy adoption tell a folder change from drift by the project’s records (A5, MIG-3, X7)', async t => {
  // workspaceHistory / workspaceEra: an earlier folder's observation, then the current one's.
  const project = { id: 'p1', workspace: '/tmp/rna-now', observationSources: [{ id: 'workspace', sourceRevision: 1, identityRevoked: false }], observations: [
    { id: 'o-old', kind: 'workspace_change', createdAt: '2026-09-02T00:00:00Z', status: 'withdrawn', data: { source: { bindingId: 'b'.repeat(64), revision: 1 }, revocationReason: 'workspace_source_changed' } },
    { id: 'o-new', kind: 'workspace_change', createdAt: '2026-09-04T00:00:00Z', status: 'received', data: { source: { bindingId: workspaceBinding({ id: 'p1', workspace: '/tmp/rna-now' }), revision: 1 } } }] };
  const history = workspaceHistory(project), era = (at, evidenceIds = []) => workspaceEra(history, { at: Date.parse(at), evidenceIds });
  assert.equal(history.changed, true); assert.deepEqual([...history.previous], ['observation:o-old']);
  assert.deepEqual([era('2026-09-01T00:00:00Z'), era('2026-09-03T00:00:00Z'), era('2026-09-05T00:00:00Z'), era('2026-09-05T00:00:00Z', ['observation:o-old'])], ['previous', 'unknown', 'current', 'previous']);
  assert.equal(workspaceEra(history, { at: Date.parse('2026-09-05T00:00:00Z'), privacyScope: 'x', scope: 'y' }), 'previous', 'a recorded scope settles it');
  assert.equal(workspaceEra(workspaceHistory({ ...project, observations: [] }), { at: 0 }), 'current', 'no record of a change');
  assert.equal(workspaceHistory({ ...project, observations: [project.observations[1]], observationSources: [{ id: 'workspace', sourceRevision: 1, identityRevoked: true }] }).currentSince, Infinity, 'a held identity has no current observation');

  // The drift restore: only work that ran once the current folder was observed gets its record back.
  const dir = mkdtempSync(join(tmpdir(), 'rna-scope-split-folder-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const created = store.createProject({ rhythm: { control: 'manual' }, name: 'Moved folder', workspace: dir }), pid = created.project.id;
  const PLACEHOLDER = 'Previous project scope; retained only as an action receipt.';
  store.mutate(state => {
    state.sessions.find(row => row.id === created.session.id).items.push({ id: 'live', kind: 'user', text: 'Live request', createdAt: '2026-09-01T00:00:00Z', simulated: false });
    const target = state.projects.find(row => row.id === pid);
    target.observations = [
      { id: 'o-old', kind: 'workspace_change', text: 'old folder', createdAt: '2026-09-02T00:00:00Z', status: 'withdrawn', data: { source: { bindingId: 'b'.repeat(64), revision: 1 }, revocationReason: 'workspace_source_changed' } },
      { id: 'o-new', kind: 'workspace_change', text: 'this folder', createdAt: '2026-09-04T00:00:00Z', status: 'received', data: { source: { bindingId: workspaceBinding(target), revision: 1 } } }];
    const ids = ['cites-old', 'before', 'between', 'after', 'other-scope'];
    target.initiativeRuntime = { sourceHash: 'pre-split-hash', sdkState: { schemaVersion: 1, revision: 1, decisionRevision: 1, nextReviewAt: 0, usedTokens: 0, reservedTokens: 0, events: [], seenEventIds: [],
      actions: ids.map(id => ({ id, action: 'work', status: 'completed', content: PLACEHOLDER, evidenceIds: [], contextRevoked: true, intentKey: id, revision: 1 })) } };
    const job = (id, createdAt, extra = {}) => ({ id, projectId: pid, kind: 'research', lane: 'background', status: 'completed', simulated: false, title: `Title ${id}`, instruction: `Instruction ${id}`, output: `Output ${id}`, evidenceIds: ['message:live'], createdAt, ...extra });
    target.jobs = [job('cites-old', '2026-09-05T00:00:00Z', { evidenceIds: ['observation:o-old'] }), job('before', '2026-09-01T12:00:00Z'), job('between', '2026-09-03T00:00:00Z'), job('after', '2026-09-05T00:00:00Z'), job('other-scope', '2026-09-05T00:00:00Z', { privacyScope: 'c'.repeat(64) })];
  });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 86400000, tickIntervalMs: 0, decisionProvider: async function* () { throw new Error('No model request'); } });
  t.after(() => controller.close());
  const action = id => store.state.projects.find(row => row.id === pid).initiativeRuntime.sdkState.actions.find(row => row.id === id);
  assert.equal(action('after').resultSummary, 'Output after');
  for (const id of ['cites-old', 'before', 'between', 'other-scope']) { assert.equal(action(id).contextRevoked, true, id); assert.equal(action(id).content, PLACEHOLDER, id); }
  const marker = store.state.projects.find(row => row.id === pid).initiativeRuntime.driftRestore;
  assert.deepEqual([marker.restored, marker.kept, marker.workspaceChanged], [1, 4, 4]);
});

test('a runtime saved before the split that has seen an earlier folder is adopted as a privacy change, not as the same scope (A5)', async t => {
  const f = await twoConversations(t, { seed: target => {
    target.observations = [{ id: 'o-old', kind: 'workspace_change', text: 'old folder', createdAt: new Date(origin - 3600000).toISOString(), status: 'withdrawn', data: { source: { bindingId: 'b'.repeat(64), revision: 1 }, revocationReason: 'workspace_source_changed' } }];
    target.initiativeRuntime.sdkState.seenEventIds.push('observation:o-old');
  } });
  assert.equal(f.action('w1').privacyRevoked, true); assert.equal(f.action('w2').privacyRevoked, true); assert.equal(f.action('w1').resultSummary, undefined);
  assert.ok(f.current().jobs.every(row => row.privacyRevoked === true));
});
