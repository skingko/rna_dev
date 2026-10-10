#!/usr/bin/env node
// Decision request and worker context on a captured state, for comparing two code revisions (spec prefix.md §4.6: TC-2,
// TC-3, PDL-5; A1 block windows), read-only and without any network: a fake provider captures the exact request the SDK
// would send for each live project now (coordinator ticks on a copy of its saved runtime), and the worker brief and
// attachment of its latest work action. capabilityContext is left out (it needs the live capability registry; the
// planning-capabilities and projection tests cover it).
//
// Besides sizes it checks what the projections promise (`checks`; `ok` false names a failure):
// - planMode / foregroundBusy: the background permission in force flips to read (plan mode; a running foreground turn on
//   a project without its own worktree). The system prompt and the request through its events stay byte-identical; only
//   the tail (hostConditions, presence) may differ. The worker brief's stable part stays byte-identical too.
// - newAction: four wakes in a row, each after one more completed action: each keeps the previous request's bytes up to
//   where its action first appears, except a wake on which a window's start moves (WINDOW_BLOCK; a plain tail moves on
//   every one).
// - newEvent: four wakes in a row, each after one more evidence event: each keeps the previous request through its events
//   (the new event only appends; no handle moves), except a wake on which the event window's start moves.
// - conditions: hostActionContracts with hostConditions put back (withConditions, what validation reads) equal the
//   snapshot's contracts; allowedEvidenceIds is the event set; every turn reference names a sent event; schedules sit at
//   project.schedules and scheduleContext keeps `cancelled`.
// Usage: node benchmark/initiative-request-size.mjs <code root, e.g. an exported checkout> <state.json copy>
// Run it once per revision (e.g. `git archive <rev> | tar -x -C dir`) and compare. Never point it at production state:
// readStateFile only reads, but pass a copy.
import { isDeepStrictEqual } from 'node:util';
const [root, statePath] = process.argv.slice(2);
if (!root || !statePath) { console.error('Usage: initiative-request-size.mjs <code root> <state.json copy>'); process.exit(2); }
const cc = `${root}/prototypes/control-center`, sdk = `${root}/packages/sdk/src`;
const { readStateFile } = await import(`${cc}/state-shards.mjs`);
const controllerModule = await import(`${cc}/project-initiative-controller.mjs`);
const { ProjectInitiativeController } = controllerModule;
// The events a request carries whole (a revision without the helper: every event); a revision without block windows: 1.
const eventIdsOf = controllerModule.carriedEventIds ?? (events => new Set(events.map(event => event.id)));
const eventBlock = controllerModule.WINDOW_BLOCK ?? 1;
const { ProjectScheduleService } = await import(`${cc}/project-schedule-service.mjs`);
const { mindBackgroundView } = await import(`${cc}/project-mind.mjs`);
const sdkModule = await import(`${sdk}/initiative.mjs`);
const { InitiativeCoordinator } = sdkModule;
const { state } = readStateFile(statePath);
const now = Date.parse('2026-10-04T13:00:00Z');
// The worker's project-mind attachment (ProjectMind.backgroundContext without its recall accounting).
const mind = { backgroundContext: (projectId, { query = '' } = {}) => { const view = mindBackgroundView(state.projects.find(row => row.id === projectId), { now, query }); return view ? JSON.stringify(view) : null; } };
const store = { state, file: null, usageLedger: null, configurationService: { secrets: {}, secretValues: () => [] }, presences: new Map(), mind };
const controller = Object.create(ProjectInitiativeController.prototype);
Object.assign(controller, { store, now: () => now, independentLearning: true, interactions: {}, decisions: { enabled: () => true }, scheduleService: new ProjectScheduleService(store, { now: () => now }), evolutionService: { running: new Map() }, background: { ready: () => false } });
const hasNew = typeof controller.workerBrief === 'function';
const bytes = text => Buffer.byteLength(text, 'utf8');
const shared = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
/** The dotted JSON key path at a character offset of `text` (where two requests first differ). */
function keyAt(text, offset) {
  const stack = []; let inString = false, key = '', reading = false, last = '';
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') { i++; continue; } if (c === '"') { inString = false; if (reading) last = key; } else if (reading) key += c; continue; }
    if (c === '"') { inString = true; key = ''; reading = stack.at(-1)?.type === 'object' && stack.at(-1).expectKey; continue; }
    if (c === '{') stack.push({ type: 'object', expectKey: true, key: null }); else if (c === '[') stack.push({ type: 'array' });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ':' && stack.at(-1)?.type === 'object') { stack.at(-1).key = last; stack.at(-1).expectKey = false; }
    else if (c === ',' && stack.at(-1)?.type === 'object') stack.at(-1).expectKey = true;
  }
  return stack.filter(row => row.type === 'object' && row.key).map(row => row.key).slice(0, 3).join('.') || null;
}
/** Two renders compared: whether the system prompt is equal, how many bytes the text shares, and where it diverges. */
const compare = (before, after) => { const n = shared(before.text, after.text); return { systemEqual: before.system === after.system, sharedBytes: bytes(before.text.slice(0, n)), textBytes: bytes(after.text), divergedIn: n === after.text.length && n === before.text.length ? 'none' : keyAt(after.text, n) }; };
const results = [];
for (const project of state.projects.filter(row => !row.archivedAt && row.initiativeRuntime?.sdkState)) {
  const sdkState = structuredClone(project.initiativeRuntime.sdkState);
  for (const action of sdkState.actions) if (['queued', 'running'].includes(action.status)) action.status = 'completed';
  sdkState.decisionRevision = -1; sdkState.failureRetryAt = 0; sdkState.archiveRetryAt = 0; sdkState.reservedTokens = 0;
  const live = structuredClone(project), sessions = state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side');
  state.projects[state.projects.indexOf(project)] = live; live.initiativeRuntime.sdkState = sdkState;
  // A decision now: the SDK's own request builder through coordinator ticks, captured by a fake provider.
  let captured = null;
  const provider = async function* (request) { captured = request; yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'measure', content: '', evidenceIds: [], nextReviewAfterMs: 3600000 }) }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' }; };
  const idle = async () => ({ deferred: true, retryAfterMs: 1e9, usage: { totalTokens: 0 } });
  const coordinator = new InitiativeCoordinator({ project: {}, model: { providerId: 'measure', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://measure.invalid/v1', maxOutputTokens: 32000, contextWindow: 200000 }, apiKey: 'measure', provider, state: sdkState, saveState: async () => {}, now: () => now,
    policy: { ...project.initiative, tokenBudget: null, decisionAttempts: 1, maxConcurrent: 1, maxEvents: 16, eventBlock, decisionMaxTokens: 32000 }, handlers: { work: idle, share: idle, ask: idle, schedule: idle } });
  const snapshotNow = () => { live.initiativeRuntime.sdkState = coordinator.snapshot(); return hasNew ? controller.snapshot(live, null, null, { eventIds: eventIdsOf(coordinator.state.events), liveActions: coordinator.state.actions }) : controller.snapshot(live, null, null); };
  const render = async () => { coordinator.project = snapshotNow(); coordinator.state.decisionRevision = -1; captured = null; const outcome = await coordinator.tick({ presence: { conversationAvailable: true }, decisionEnabled: true }); return { status: outcome.status, project: coordinator.project, events: structuredClone(coordinator.state.events), system: captured?.systemPrompt ?? '', text: captured?.messages?.[0]?.content?.[0]?.text ?? '' }; };
  const work = [...sdkState.actions].reverse().find(action => action.action === 'work');
  const evidence = work ? sdkState.events.filter(event => (work.evidenceIds ?? []).includes(event.id)) : [];
  const worker = () => { if (!hasNew) { const attachment = JSON.stringify({ project: controller.snapshot(live, null, null), evidence }); return { attachment }; } const brief = controller.workerBrief(live, { evidence, query: work?.content ?? '' }); return { brief: JSON.stringify(brief.stable), attachment: JSON.stringify({ project: brief.volatile, evidence }) }; };
  const base = await render(), baseWorker = worker();
  // The permission in force flips to read: plan mode, then a running foreground turn (no worktree here).
  const flip = async mutate => { const saved = sessions.map(row => ({ mode: row.mode, activeTurnId: row.activeTurnId })); mutate(sessions[0]); try { return { request: await render(), worker: worker() }; } finally { sessions.forEach((row, index) => Object.assign(row, saved[index])); } };
  const plan = sessions.length ? await flip(session => { session.mode = 'plan'; }) : null, busy = sessions.length ? await flip(session => { session.activeTurnId = '__benchmark_running_turn__'; }) : null;
  const through = request => { const at = request.text.indexOf('"allowedEvidenceIds"'); return at < 0 ? request.text.length : at; };
  const flipCheck = flipped => { if (!flipped) return null; const result = compare(base, flipped.request); return { ...result, briefEqual: (flipped.worker.brief ?? null) === (baseWorker.brief ?? null), ok: result.systemEqual && shared(base.text, flipped.request.text) >= through(base) && flipped.worker.brief === baseWorker.brief }; };
  // Wakes after one more completed action each (no new evidence event): the prefix reaches the new action's receipt (its
  // separator from the row before it may differ) unless a window's start moved on that wake.
  const steps = []; let previous = base, withAction = base;
  for (let step = 1; step <= Math.max(4, eventBlock); step++) {
    const actionId = `benchmark-new-action-${step}`;
    coordinator.state.actions.push({ id: actionId, action: 'work', status: 'completed', content: `Benchmark: completed check ${step}.`, evidenceIds: [], intentKey: actionId, revision: coordinator.state.revision, createdAt: now - 60000 + step, startedAt: now - 50000 + step, finishedAt: now - 1000 + step, resultSummary: `Benchmark: check ${step} passed.` });
    withAction = await render();
    const receiptStart = withAction.text.lastIndexOf('{', withAction.text.indexOf(`"${actionId}"`)), kept = shared(previous.text, withAction.text) >= receiptStart - 1;
    steps.push({ ...compare(previous, withAction), firstNewAt: bytes(withAction.text.slice(0, receiptStart)), kept });
    previous = withAction;
  }
  const newAction = { kept: steps.filter(row => row.kept).length, wakes: steps.length, steps, ok: steps.filter(row => !row.kept).length <= Math.ceil(steps.length / Math.max(2, eventBlock)) && eventBlock > 1 };
  // Wakes after one more evidence event each (observed the SDK's way, so its event window applies): the prefix reaches
  // the end of the previous request's events (no handle moves) unless the event window's start moved on that wake.
  const eventSteps = []; previous = withAction;
  for (let step = 1; step <= Math.max(4, eventBlock); step++) {
    await coordinator.observe({ id: `observation:benchmark-new-event-${step}`, type: 'workspace_change', summary: JSON.stringify({ evidenceType: 'workspace_metadata', summary: `Benchmark: file ${step} changed.`, changes: [{ path: `benchmark-${step}.md`, change: 'modified' }] }), at: now + step });
    const withEvent = await render(), eventsEnd = previous.text.indexOf('],"allowedEvidenceIds"');
    eventSteps.push({ ...compare(previous, withEvent), eventsThroughBytes: bytes(previous.text.slice(0, eventsEnd)), kept: shared(previous.text, withEvent.text) >= eventsEnd });
    previous = withEvent;
  }
  const newEvent = { kept: eventSteps.filter(row => row.kept).length, wakes: eventSteps.length, steps: eventSteps, ok: eventSteps.filter(row => !row.kept).length <= Math.ceil(eventSteps.length / Math.max(2, eventBlock)) && eventBlock > 1 };
  // What validation reads is still in the request.
  const parsed = JSON.parse(base.text), aliases = new Map(parsed.events.map((event, index) => [`E${index + 1}`, event]));
  const contracts = typeof sdkModule.withConditions === 'function' ? sdkModule.withConditions(parsed.hostActionContracts, parsed.hostConditions) : null;
  const expected = sdkModule.evidenceAliases ? JSON.parse(JSON.stringify(sdkModule.evidenceAliases(base.events).alias(base.project.actionContracts))) : null;
  const references = (parsed.project?.continuity?.recentTurns ?? []).filter(row => row.evidence).map(row => row.evidence);
  const conditions = { contractsRestored: contracts && expected ? isDeepStrictEqual(contracts, expected) : null, allowedEvidenceIds: JSON.stringify(parsed.allowedEvidenceIds) === JSON.stringify(parsed.events.map(event => event.id)), turnReferences: references.length, referencesResolve: references.every(id => aliases.has(id)),
    schedules: Array.isArray(parsed.project?.schedules) || !base.project.scheduleContext, cancelled: !base.project.scheduleContext || Array.isArray(parsed.project?.scheduleContext?.cancelled) };
  conditions.ok = conditions.contractsRestored !== false && conditions.allowedEvidenceIds && conditions.referencesResolve && conditions.schedules && conditions.cancelled;
  const part = value => value === undefined ? 0 : bytes(JSON.stringify(value));
  results.push({ project: project.name, status: base.status, systemBytes: bytes(base.system), requestBytes: bytes(base.text), events: parsed.events.length,
    windows: { recentActions: parsed.recentActions.length, events: parsed.events.length, actionReceipts: parsed.project?.continuity?.actionReceipts?.length ?? 0, recentTurns: parsed.project?.continuity?.recentTurns?.length ?? 0, recentConversation: parsed.project?.recentConversation?.length ?? 0 },
    parts: { hostActionContracts: part(parsed.hostActionContracts), project: part(parsed.project), continuity: part(parsed.project?.continuity), recentConversation: part(parsed.project?.recentConversation), communication: part(parsed.project?.communication), schedules: part(parsed.project?.schedules) + part(parsed.project?.scheduleContext), handoffs: part(parsed.project?.handoffs), recentActions: part(parsed.recentActions), events: part(parsed.events), hostConditions: part(parsed.hostConditions) },
    worker: { ...(baseWorker.brief ? { briefBytes: bytes(baseWorker.brief) } : {}), attachmentBytes: bytes(baseWorker.attachment) },
    checks: { planMode: flipCheck(plan), foregroundBusy: flipCheck(busy), newAction, newEvent, conditions } });
}
console.log(JSON.stringify(results, null, 2));
