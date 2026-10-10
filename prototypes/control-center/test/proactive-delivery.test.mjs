import test from 'node:test';
import { sayAndFinish } from './helpers/foreground-turn.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createServer } from '../server.mjs';
import { liveBus } from '../live-bus.mjs';
import { captureSessionEvidence, scrubSessionEvidence } from '../session-evidence-cleanup.mjs';
import { capReach, recordDelivery, settleFeedback, deliveryMetrics, composeDigest, nextDigestAt, recentDeliveries, inboxView, applyInboxAction, messageRecheck, MESSAGE_CHECK_BUDGET_MS } from '../proactive-delivery.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, label = 'condition') { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const decide = (input, action = 'wait', content = '', evidence = input.events.at(-1).id, extra = {}) => ({ action, content, evidenceIds: action === 'wait' ? [] : [evidence], reason: 'Observed a concrete project fact', nextReviewAfterMs: 86400000, ...extra });
function decisions(fn, calls = []) { return async function* (options) { const input = JSON.parse(options.messages[0].content[0].text); calls.push({ input, options }); const output = await fn(input, options, calls.length); yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { input: 12, output: 8, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; }; }
const workProvider = text => options => createRnaRuntime({ ...options, provider: async function* () { yield { type: 'text_delta', delta: text }; yield { type: 'usage', usage: { totalTokens: 20, input: 10, output: 10 } }; yield { type: 'done', stopReason: 'stop' }; } });

async function fixture(t, options = {}) {
  const { initiative = {}, file, ...controllerOptions } = options;
  const directory = file ? null : mkdtempSync(join(tmpdir(), 'rna-proactive-delivery-'));
  const store = new Store(file ?? join(directory, 'state.json'));
  let project = store.state.projects.find(row => row.name === 'Proactive delivery fixture'), session = project && store.state.sessions.find(row => row.projectId === project.id);
  if (!project) {
    const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
    store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
    ({ project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Proactive delivery fixture', description: 'Check compatibility evidence', workspace: directory, initiative: { cooldownMs: 0, ...initiative } }));
    store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; target.initiative.tokenBudget = 200000; state.settings.realTokenBudget = null; });
    writeFileSync(join(directory, 'evidence.txt'), 'compatibility: second input variant is missing');
  }
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, feedbackCheckIntervalMs: 0, ...controllerOptions });
  t.after(async () => { await controller.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { directory, store, controller, project, session, current, file: store.file, messages: () => store.state.sessions.find(row => row.id === session.id)?.items.filter(item => item.source === 'initiative') ?? [], inbox: () => current().inbox ?? [] };
}

test('reach caps: notify needs the desktop opt-in, asks stay in the conversation, unknown tiers default inline', () => {
  const project = { initiative: {} };
  assert.deepEqual(capReach(project, { requested: 'notify' }), { requested: 'notify', tier: 'inline', reasons: ['desktop_notifications_off'] });
  assert.equal(capReach({ initiative: { desktopNotifications: true } }, { requested: 'notify' }).tier, 'notify');
  assert.equal(capReach(project, { requested: 'inbox', kind: 'ask' }).tier, 'inline');
  assert.equal(capReach(project, { requested: 'loud' }).tier, 'inline');
  assert.equal(capReach(project, { requested: 'digest' }).tier, 'digest');
});

test('feedback labels: dismissed, acted, replied after visibility, ignored only after the window; metrics give rates', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z'), hour = 3600000;
  const project = { id: 'p', initiative: {}, inbox: [] };
  const sessions = [{ id: 's', items: [
    { id: 'q', kind: 'question', interaction: { id: 'i1', status: 'answered', answeredAt: new Date(t0 + hour).toISOString() } },
    { id: 'u1', kind: 'user', text: 'thanks, fixing it', createdAt: new Date(t0 + 2 * hour).toISOString() }] }];
  const add = (fields, at = t0) => recordDelivery(project, { actionId: `a${project.inbox.length}`, text: `finding ${project.inbox.length}`, sessionId: 's', now: at, ...fields });
  const replied = add({ tier: 'inline' }), acted = add({ kind: 'ask', tier: 'inline', interactionId: 'i1' }), dismissed = add({ tier: 'inbox' }), unread = add({ tier: 'inbox' }), late = add({ tier: 'inline' }, t0 + 3 * hour);
  applyInboxAction(project, dismissed.id, 'dismiss', { now: t0 + 30 * 60000 });
  assert.deepEqual(settleFeedback(project, sessions, { now: t0 + 4 * hour }).map(row => [row.id, row.feedback.outcome]), [[replied.id, 'replied'], [acted.id, 'acted'], [dismissed.id, 'dismissed']]);
  assert.equal(unread.feedback, null, 'an unread inbox entry is not ignored before its window closes');
  assert.equal(late.feedback, null);
  settleFeedback(project, sessions, { now: t0 + 3 * 86400000 });
  assert.equal(unread.feedback.outcome, 'ignored'); assert.equal(late.feedback.outcome, 'ignored');
  const metrics = deliveryMetrics(project, { now: t0 + 3 * 86400000 });
  assert.deepEqual(metrics.counts, { delivered: 5, pending: 0, replied: 1, acted: 1, dismissed: 1, ignored: 2 });
  assert.equal(metrics.usefulShareRate, 0.4); assert.equal(metrics.dismissRate, 0.2); assert.equal(metrics.ignoreRate, 0.4);
  assert.equal(inboxView(project).unread, 4, 'only the dismissed entry left the unread set');
});

test('digest timing and host-authored digest text', () => {
  const at = new Date(2026, 8, 28, 10, 30).getTime();
  assert.equal(new Date(nextDigestAt(at, 9)).getDate(), 29); assert.equal(new Date(nextDigestAt(at, 9)).getHours(), 9);
  assert.equal(new Date(nextDigestAt(at, 18)).getDate(), 28);
  assert.equal(composeDigest([{ text: 'Parser fails on empty files. Reproduced twice with a fixture.' }]), '今日摘要：Parser fails on empty files.');
  assert.match(composeDigest([{ text: '第一条发现。补充说明' }, { text: '第二条发现' }]), /今日摘要（2 条）：\n1\. 第一条发现。\n2\. 第二条发现/);
});

test('an inbox-tier finding while muted joins the conversation quietly (answerable there), and survives a restart without redelivery', async t => {
  const calls = [];
  const f = await fixture(t, { initiative: { notificationMuted: true }, decisionProvider: decisions(input => {
    const shared = input.recentActions.some(row => row.action === 'share');
    return shared ? decide(input) : decide(input, 'share', 'The second input variant has no compatibility example yet.', undefined, { urgency: 'inbox' });
  }, calls) });
  await until(() => f.inbox().length === 1, 'inbox entry');
  const entry = f.inbox()[0];
  assert.equal(entry.tier, 'inbox'); assert.equal(entry.requestedTier, 'inbox'); assert.equal(entry.status, 'unread');
  assert.equal(f.messages().length, 1, 'the quiet share is in the conversation, where it can be answered'); assert.equal(f.messages()[0].initiative.reach, 'inbox'); assert.ok(entry.itemId, 'the inbox entry locates it');
  assert.equal(f.current().initiative.lastSpokeAt, null, 'a quiet delivery does not start the conversation cooldown');
  const contract = calls[0].input.hostActionContracts.share;
  assert.equal(contract.messageContract, 1); assert.deepEqual(contract.reach.tiers, ['digest', 'inbox', 'inline']);
  // PDL-5: whether notifications are muted changes from wake to wake, so it rides at the request tail.
  assert.equal(contract.reach.notificationsMuted, undefined); assert.equal(calls[0].input.hostConditions.share.reach.notificationsMuted, true);
  assert.match(calls[0].options.systemPrompt, /sentLast24h/);
  await f.controller.close();
  const reopened = new Store(f.file);
  assert.equal(reopened.state.projects.find(row => row.id === f.project.id).inbox.length, 1, 'inbox is durable across restart');
  let redecided = 0;
  const restarted = new ProjectInitiativeController(reopened, { initialDelayMs: 0, tickIntervalMs: 0, decisionProvider: decisions(input => { redecided++; assert.equal(input.project.communication.sentLast24h.length, 1); assert.equal(input.project.communication.sentLast24h[0].reaction, 'pending'); return decide(input); }) });
  t.after(() => restarted.close());
  await until(() => restarted.contexts.size === 1); await delay(50);
  assert.equal(reopened.state.projects.find(row => row.id === f.project.id).inbox.length, 1);
  assert.equal(redecided, 0, 'restart resumes without repeating the delivery or its decision');
});

test('a message the judge flags is revised by its author in one extra round; an exact repeat of a message sent in 24h is never delivered twice', async t => {
  const calls = [];
  // The judge (JEV message.check), not a host regex, flags the leaked identifier.
  const decisionService = { enabled: point => point === 'message.check', review: async () => ({ review: true }), messageCheck: async (_project, { text }) => /action:/.test(text) ? ['internal_id'] : [] };
  const f = await fixture(t, { decisionService, decisionProvider: decisions((input, options, count) => {
    const repair = JSON.stringify(options.messages).includes('writing contract');
    if (count === 1) return decide(input, 'share', 'Found it, see action:9b1c2d3e-1111-4222-8333-444455556666 for details.');
    if (count === 2) { assert.ok(repair); return decide(input, 'share', 'The second input variant has no compatibility example yet.'); }
    return decide(input, 'share', 'The second input variant has no compatibility example yet!');
  }, calls) });
  await until(() => f.messages().length === 1, 'repaired delivery');
  assert.equal(f.messages()[0].text, 'The second input variant has no compatibility example yet.');
  assert.equal(f.current().initiativeRuntime.sdkState.lastDecision.messageRepairs, 1);
  sayAndFinish(f.store, f.session.id, 'Any other compatibility gap?');
  await until(() => calls.length >= 4 && f.current().initiativeRuntime.sdkState.lastFailure?.code === 'message_contract', 'duplicate rejected after its repair round');
  assert.equal(f.messages().length, 1);
  assert.ok(calls.slice(2).every(call => call.input.project.communication.sentLast24h.some(row => /compatibility example yet/.test(row.message))));
});

test('late results are re-judged at delivery: a near repeat delivered meanwhile supersedes the queued share', async t => {
  const f = await fixture(t, { decisionProvider: decisions(input => decide(input)) });
  await until(() => f.controller.contexts.size === 1);
  const context = f.controller.contexts.get(f.project.id), signal = new AbortController().signal;
  const first = { id: 'late-1', intentKey: 'k1', revision: context.coordinator.state.revision, content: 'The empty-file parser bug is reproduced with a fixture.', evidenceIds: [] };
  assert.equal((await f.controller.share(context, first, { signal })).reach, 'inline');
  const late = await f.controller.share(context, { ...first, id: 'late-2', intentKey: 'k2', content: 'The empty file parser bug is reproduced with a fixture!' }, { signal });
  assert.deepEqual([late.superseded, late.reason], [true, 'message_duplicate']);
  assert.equal(f.messages().length, 1);
  f.store.updateSession(f.session.id, { archived: true });
  assert.equal(recentDeliveries(f.current(), f.store.state.sessions.filter(row => row.projectId === f.project.id && !row.archivedAt)).length, 0, 'messages in an archived conversation leave the model digest');
});

test('notify is opt-in: without it the share stays inline; with it a desktop event and notifiedAt are recorded', async t => {
  const events = [];
  const f = await fixture(t, { decisionProvider: decisions(input => decide(input)) });
  const off = liveBus(f.store).subscribe(event => { if (event.type === 'project.notify') events.push(event); }); t.after(off);
  await until(() => f.controller.contexts.size === 1);
  const context = f.controller.contexts.get(f.project.id), signal = new AbortController().signal, revision = context.coordinator.state.revision;
  assert.equal((await f.controller.share(context, { id: 'n1', intentKey: 'n1', revision, urgency: 'notify', content: 'The nightly build broke on the parser change.', evidenceIds: [] }, { signal })).reach, 'inline');
  assert.deepEqual(f.inbox()[0].reachReasons, ['desktop_notifications_off']); assert.equal(events.length, 0);
  f.store.updateProject(f.project.id, { initiative: { desktopNotifications: true } });
  const current = f.controller.contexts.get(f.project.id);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).items.push({ id: 'reader', kind: 'user', text: 'ok', createdAt: new Date().toISOString() }); });
  assert.equal((await f.controller.share(current, { id: 'n2', intentKey: 'n2', revision: current.coordinator.state.revision, urgency: 'notify', content: 'Deploy is blocked: the release key expired an hour ago.', evidenceIds: [] }, { signal })).reach, 'notify');
  const entry = f.inbox().find(row => row.actionId === 'n2');
  assert.equal(entry.tier, 'notify'); assert.ok(entry.notifiedAt);
  assert.deepEqual(events.map(row => [row.projectId, row.entryId, row.title]), [[f.project.id, entry.id, 'Proactive delivery fixture']]);
  assert.equal(f.messages().filter(item => item.initiative.reach === 'notify').length, 1);
});

test('delivery.reach JEV may lower the tier and its ledger row is labelled with the user reaction; it can never raise', async t => {
  const labels = [], scored = [];
  let answer = 'inbox';
  const decisionService = { enabled: point => point === 'delivery.reach', review: async () => ({ review: true }), reach: async (_project, input) => { scored.push(input.maxTier); return { tier: answer, lowered: answer !== input.maxTier, ledgerId: `ledger-${scored.length}` }; }, labelDecision: (id, label) => labels.push([id, label]) };
  const f = await fixture(t, { decisionService, decisionProvider: decisions(input => decide(input)) });
  await until(() => f.controller.contexts.size === 1);
  const context = f.controller.contexts.get(f.project.id), signal = new AbortController().signal;
  const lowered = await f.controller.share(context, { id: 'j1', intentKey: 'j1', revision: context.coordinator.state.revision, urgency: 'inline', content: 'Minor: two docs pages use the old product name.', evidenceIds: [] }, { signal });
  assert.equal(lowered.reach, 'inbox'); assert.equal(f.messages().length, 1, 'a lowered share still joins the conversation, quietly'); assert.equal(f.messages()[0].initiative.reach, 'inbox');
  answer = 'notify';
  const kept = await f.controller.share(context, { id: 'j2', intentKey: 'j2', revision: context.coordinator.state.revision, urgency: 'inline', content: 'The migration script deletes rows it should archive.', evidenceIds: [] }, { signal });
  assert.ok(['inline', 'inbox'].includes(kept.reach), 'a score cannot escalate past the capped request (pacing may keep it quiet after the previous message)');
  const [first] = f.inbox();
  assert.deepEqual(first.reachReasons, ['jev_lowered']); assert.deepEqual(first.ledgerIds, ['ledger-1']);
  f.controller.deliveryUpkeep(context);
  assert.deepEqual(labels, []);
  f.store.mutate(state => applyInboxAction(state.projects.find(row => row.id === f.project.id), first.id, 'dismiss'));
  f.controller.deliveryUpkeep(context);
  assert.deepEqual(labels, [['ledger-1', 'delivery_dismissed']]);
});

test('a quiet share filed while the conversation is busy joins it once it is idle, and the inbox entry then locates it', async t => {
  const f = await fixture(t, { decisionProvider: decisions(input => decide(input)) });
  await until(() => f.controller.contexts.size === 1);
  const context = f.controller.contexts.get(f.project.id), signal = new AbortController().signal, session = f.store.state.sessions.find(row => row.projectId === f.project.id);
  f.store.mutate(state => { state.sessions.find(row => row.id === session.id).activeTurnId = 'busy-turn'; });
  await f.controller.share(context, { id: 'q1', intentKey: 'q1', revision: context.coordinator.state.revision, urgency: 'inbox', content: 'Two docs pages still use the old product name.', evidenceIds: [] }, { signal });
  assert.equal(f.messages().length, 0, 'not inserted into a running turn'); assert.equal(f.inbox()[0].itemId ?? null, null);
  f.controller.deliveryUpkeep(context); assert.equal(f.messages().length, 0, 'still busy');
  f.store.mutate(state => { state.sessions.find(row => row.id === session.id).activeTurnId = null; });
  f.controller.deliveryUpkeep(context); f.controller.deliveryUpkeep(context);
  assert.equal(f.messages().length, 1, 'posted once'); assert.equal(f.messages()[0].text, 'Two docs pages still use the old product name.');
  assert.equal(f.inbox()[0].itemId, f.messages()[0].id);
});
test('digest-tier findings are held and delivered once as one host-authored summary at the digest hour', async t => {
  let clock = new Date(2026, 8, 28, 10, 0).getTime();
  const f = await fixture(t, { now: () => clock, initiative: { digestHour: 9 }, decisionProvider: decisions(input => decide(input)) });
  await until(() => f.controller.contexts.size === 1);
  const context = f.controller.contexts.get(f.project.id), signal = new AbortController().signal;
  for (const [id, content] of [['d1', 'Two dependencies have minor updates available.'], ['d2', '文档里有三处旧版截图需要更新。']]) assert.equal((await f.controller.share(context, { id, intentKey: id, revision: context.coordinator.state.revision, urgency: 'digest', content, evidenceIds: [] }, { signal })).reach, 'digest');
  f.controller.deliveryUpkeep(context);
  assert.equal(f.messages().length, 0); assert.ok(f.inbox().every(row => row.heldForDigest));
  clock = new Date(2026, 8, 29, 9, 1).getTime();
  f.controller.deliveryUpkeep(context); f.controller.deliveryUpkeep(context);
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].text, '今日摘要（2 条）：\n1. Two dependencies have minor updates available.\n2. 文档里有三处旧版截图需要更新。');
  assert.ok(f.inbox().every(row => !row.heldForDigest && row.digestItemId === f.messages()[0].id));
});

test('background work ends with a durable one-line handoff that the next wake reads instead of the transcript', async t => {
  const calls = [];
  const f = await fixture(t, { decisionProvider: decisions(input => input.events.some(event => event.type === 'action_completed') ? decide(input) : decide(input, 'work', 'Check whether the second input variant has an example'), calls),
    runtimeFactory: workProvider('Read the notes; the second input variant has no example.\n交接：核对了兼容性说明，第二种输入仍缺示例，结论在项目说明里，下一步补写该示例并重测') });
  await until(() => calls.length >= 2, 'wake after work');
  const action = f.current().initiativeRuntime.sdkState.actions.find(row => row.action === 'work'), job = f.current().jobs.find(row => row.id === action.id);
  assert.equal(action.handoff, '核对了兼容性说明，第二种输入仍缺示例，结论在项目说明里，下一步补写该示例并重测'); assert.equal(job.handoff, action.handoff);
  const next = calls.at(-1).input;
  // TC-3: the handoff reaches the next wake once, on the SDK receipt; the project snapshot no longer repeats it.
  assert.equal(next.project.handoffs, undefined);
  assert.equal(Object.keys(next).at(-1), 'clock', 'the per-wake clock is the last field of the request'); assert.equal(next.project.clock, undefined);
  const receipt = next.recentActions.find(row => row.actionId === action.id);
  assert.equal(receipt.handoff, action.handoff); assert.equal(receipt.resultSummary, undefined);
  assert.ok(!JSON.stringify(next.project).includes(action.handoff), 'the project part does not repeat it (slim receipt, no handoffs, no summary)');
});

test('inbox HTTP API lists, marks read, dismisses and reports feedback rates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-inbox-api-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const { project, session } = app.store.createProject({ name: 'Inbox API', workspace: directory });
  app.store.mutate(state => { const target = state.projects.find(row => row.id === project.id); for (const [index, tier] of ['inline', 'inbox', 'inbox'].entries()) recordDelivery(target, { actionId: `a${index}`, tier, text: `finding ${index}`, sessionId: session.id }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}`;
  const call = async (path, body) => { const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const listed = await call('/inbox');
  assert.equal(listed.status, 200); assert.equal(listed.body.unread, 3); assert.equal(listed.body.entries.length, 3); assert.equal(listed.body.entries[0].text, 'finding 2');
  const [newest, middle] = listed.body.entries;
  assert.equal((await call(`/inbox/${middle.id}`, { action: 'read' })).body.entry.status, 'read');
  const dismissed = await call(`/inbox/${newest.id}`, { action: 'dismiss' });
  assert.equal(dismissed.body.entry.status, 'dismissed'); assert.equal(dismissed.body.entry.feedback.outcome, 'dismissed'); assert.equal(dismissed.body.unread, 1);
  assert.equal((await call('/inbox?status=active')).body.entries.length, 2);
  assert.equal((await call(`/inbox/${newest.id}`, { action: 'explode' })).status, 400);
  assert.equal((await call('/inbox/unknown-entry', { action: 'read' })).status, 404);
  assert.equal((await call('/inbox/read-all', {})).body.unread, 0);
  const feedback = await call('/delivery-feedback?window=7d');
  assert.equal(feedback.status, 200); assert.equal(feedback.body.counts.dismissed, 1); assert.equal(feedback.body.dismissRate, 1); assert.equal(feedback.body.recent[0].outcome, 'dismissed');
  const summary = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/projects/${project.id}`)).json();
  assert.equal(summary.inbox, undefined, 'the inbox is a heavy field'); assert.equal(summary.counts.inbox, 3); assert.equal(summary.counts.inboxUnread, 0);
});

test('deleting a conversation removes its proactive message text from the inbox while keeping the receipt', () => {
  const session = { id: 'session-one', projectId: 'project-one', items: [], turns: [], inbox: [], submissions: [] };
  const project = { id: 'project-one', observations: [], facts: [], jobs: [], decisions: [], initiative: {}, inbox: [] };
  recordDelivery(project, { actionId: 'a1', tier: 'inline', text: 'finding delivered into the deleted conversation', sessionId: 'session-one' });
  recordDelivery(project, { actionId: 'a2', tier: 'inbox', text: 'finding in another conversation', sessionId: 'session-two' });
  const state = { projects: [project], sessions: [session], events: [] };
  scrubSessionEvidence(state, { sessionId: session.id, projectId: project.id, evidence: captureSessionEvidence(state, session) });
  const [deleted, kept] = project.inbox;
  assert.ok(!JSON.stringify(project.inbox).includes('deleted conversation'));
  assert.equal(deleted.sourceDeleted, true); assert.equal(deleted.contextRevoked, true); assert.equal(deleted.actionId, 'a1');
  assert.equal(kept.text, 'finding in another conversation');
  assert.equal(inboxView(project).total, 1);
});

test('the recheck of a revision tells "unchecked" from "clean": no verdict, an error or the budget is null (review EFF-7)', async t => {
  const project = { id: 'p', name: 'Recheck fixture', inbox: [] }, base = { enabled: point => point === 'message.check' }, asked = [];
  const recheck = decisions => messageRecheck(project, [], 'Two parser tests fail.', { decisions });
  assert.deepEqual(await recheck({ ...base, messageCheck: async (_project, input) => { asked.push(input.verdict); return ['status_ping', 'not_a_code']; } }), ['status_ping'], 'semantic codes only, as the live check keeps them');
  assert.deepEqual(asked, [true], 'asks for a verdict, not a default');
  assert.deepEqual(await recheck({ ...base, messageCheck: async () => [] }), [], 'checked and clean');
  assert.equal(await recheck({ ...base, messageCheck: async () => null }), null, 'no verdict (judge in shadow, no answer)');
  assert.equal(await recheck({ ...base, messageCheck: async () => { throw new Error('judge down'); } }), null);
  assert.equal(await recheck({ enabled: () => false, messageCheck: async () => [] }), null, 'judge off');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = recheck({ ...base, messageCheck: () => new Promise(() => {}) });
  await Promise.resolve(); t.mock.timers.tick(MESSAGE_CHECK_BUDGET_MS);
  assert.equal(await slow, null, 'the budget elapsed');
});
