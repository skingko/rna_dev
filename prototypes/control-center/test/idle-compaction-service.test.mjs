import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../store.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';
import { IdleCompactionService, idleCompactionAssessment, idleSummaryFile, IDLE_KEEP_USER_TURNS } from '../idle-compaction-service.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';

// User decision 2026-10-04 #3 / spec p1 compaction §D: a conversation idle past its model's cache survival and over
// half of its context window is summarized in the background — fake clock, fake provider, real SDK on a temp state.
const HOUR = 3600000, COLD = 2 * HOUR;
const isSummary = request => request.systemPrompt.startsWith('Summarize the provided');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, { contextWindow = 60000, turns = 5, language = 'zh', survival = { estimate: () => ({ coldAfterMs: COLD }) }, compat, protocol = 'openai', reasoning = ['off'], selection = 'off', groups = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-idle-service-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = store.configurationService.provider(null, { name: 'idle fixture', protocol, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-idle-key', models: [{ id: 'main', contextWindow, maxOutputTokens: 1000, reasoning, ...(compat ? { compat } : {}) }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'main', reasoning: selection }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ name: 'Novel', workspace: directory });
  let now = Date.parse('2026-10-04T08:00:00Z');
  const clock = () => now;
  // A real conversation journal: long chapters, so it holds well over half of the window.
  const model = { providerId: provider.id, modelId: 'main', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow, maxOutputTokens: 1000 };
  const stateDir = resolve(`${store.file}.rna`, session.id);
  const chapters = async function* () { yield { type: 'text_delta', delta: `章节 ${'正文'.repeat(3600)}` }; yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' }; };
  // `groups`: a turn is that many tool batches (each a long source) and then the answer, so a turn can be split inside.
  const sources = groups !== 0 ? [{ name: 'inspect', effect: 'read', description: 'Read a source.', parameters: { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false }, execute: async (_id, args) => `来源 ${args.n}：${'资料行。'.repeat(1100)}` }] : [];
  const grouped = async function* (request) {
    const last = request.messages.findLastIndex(message => message.role === 'user' && message.source === 'user'), results = request.messages.slice(last + 1).filter(message => message.role === 'toolResult' || message.role === 'tool').length;
    const wanted = typeof groups === 'function' ? groups(Number(/\d+/.exec(request.messages[last].content[0].text)?.[0])) : groups;
    if (results < wanted) yield { type: 'tool_call', id: `call-${request.messages.length}`, name: 'inspect', arguments: { n: results + 1 } }; else yield { type: 'text_delta', delta: '本章核对完成。' };
    yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const writer = await createSession({ sessionId: session.id, projectId: project.id, cwd: directory, stateDir, model, tools: sources, provider: groups !== 0 ? grouped : chapters, clock });
  for (let index = 1; index <= turns; index++) await writer.prompt(`写第 ${index} 章`);
  const sessionFile = writer.snapshot().sessionFile, tokens = writer.snapshot().contextUsage.estimatedInputTokens;
  await writer.dispose();
  store.mutate(state => {
    const row = state.sessions.find(item => item.id === session.id);
    Object.assign(row, { status: 'idle', simulated: false, runtime: { engine: 'rna', sessionFile, sessionId: session.id } });
    row.context = { tokens, capacity: contextWindow, compactions: 0, usage: { estimatedInputTokens: tokens, capacity: contextWindow, outputReserve: 1000, inputTrigger: 0, method: 'fixture', status: 'ready', automaticEnabled: true, compactionId: null } };
    row.turns.push({ id: 'turn-last', status: 'completed', createdAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), simulated: false });
    state.projects.find(item => item.id === project.id).simulated = false;
    state.settings.realTokenBudget = null; state.settings.interfaceLanguage = language;
  });
  const ledger = new UsageLedger({ now: clock });
  ledger.record({ purpose: 'foreground', projectId: project.id, sessionId: session.id, providerId: provider.id, modelId: 'main', usage: { input: 10, cacheRead: tokens, cacheWrite: 0, cacheUsageReported: true } });
  const requests = [];
  let gate = null;
  const summaries = async function* (request) { requests.push(request); if (gate) await gate.promise; yield { type: 'text_delta', delta: 'Chapters one to three: summary.' }; yield { type: 'usage', usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
  const executor = { running: new Map(), maintenance: new Map(), memorySync: { drainingSessions: new Set() }, claims: [],
    runMaintenance(id, task) {
      if (this.running.has(id) || this.maintenance.has(id)) return Promise.reject(Object.assign(new Error('busy'), { code: 'session_busy' }));
      const operation = { controller: new AbortController(), promise: null }; this.maintenance.set(id, operation); this.claims.push(id);
      operation.promise = Promise.resolve().then(() => task(operation.controller.signal)).finally(() => { if (this.maintenance.get(id) === operation) this.maintenance.delete(id); });
      return operation.promise;
    } };
  const service = new IdleCompactionService(store, { executor, ledger, survival, provider: summaries, now: clock });
  t.after(() => service.close());
  const settle = async () => { while (service.inFlight.size) await Promise.all([...service.inFlight.values()].map(entry => entry.promise)); };
  const current = () => store.state.sessions.find(item => item.id === session.id);
  return { store, service, executor, ledger, session, project, sessionFile, model, stateDir, directory, requests, settle, current, clock, advance: ms => { now += ms; }, block: () => { gate = deferred(); return gate; } };
}

test('due at the last request plus the cold gap; generated with no claim held, committed through a brief claim; notice, accounting and ledger', async t => {
  const f = await setup(t);
  const options = { executor: f.executor, ledger: f.ledger, survival: f.service.survival };
  const assessment = idleCompactionAssessment(f.store.state, f.current(), options);
  assert.equal(assessment.dueAt, f.ledger.lastSessionRequest(f.session.id).at + COLD);
  f.service.plan(); assert.equal(f.service.inFlight.size, 0, 'not due yet');
  f.advance(COLD + 1000);
  const gate = f.block();
  f.service.plan();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.requests.length, 1, 'the summary request is in flight');
  assert.equal(f.executor.maintenance.has(f.session.id), false, 'no claim is held while the summary is generated: a turn would start at once');
  assert.equal(f.current().context.idleCompaction.status, 'preparing');
  gate.resolve(); await f.settle();
  assert.deepEqual(f.executor.claims, [f.session.id, f.session.id], 'one claim to plan, one to commit');
  const record = f.current().context.idleCompaction;
  assert.equal(record.status, 'committed'); assert.ok(record.afterTokens < record.beforeTokens);
  assert.equal(f.current().context.compactions, 1); assert.equal(f.current().context.measurementScope, 'maintenance');
  assert.equal(f.current().items.at(-1).source, 'idle-compaction'); assert.match(f.current().items.at(-1).text, /空闲期间.*摘要/);
  assert.equal(existsSync(idleSummaryFile(f.sessionFile)), false, 'the sidecar was consumed');
  const journal = readFileSync(f.sessionFile, 'utf8');
  assert.match(journal, /"type":"compaction_prepared"/); assert.match(journal, /"trigger":"idle"/);
  const summary = f.requests[0].messages[0].content[0].text;
  assert.match(summary, /写第 1 章/); assert.doesNotMatch(summary, /写第 4 章|写第 5 章/, `the last ${IDLE_KEEP_USER_TURNS} turns stay verbatim`);
  const row = f.ledger.rows.at(-1);
  assert.deepEqual([row.purpose, row.trigger, row.sessionId, row.input], ['compaction', 'idle', f.session.id, 900]);
  assert.equal(f.ledger.lastSessionRequest(f.session.id).at < f.clock() - COLD, true, 'the idle summary does not reset the idle clock');
  assert.equal(f.store.state.realUsage.tokens, 920, 'actual usage is charged');
  // One attempt per idle period.
  f.service.plan(); assert.equal(f.service.inFlight.size, 0);
});

test('not due below half the window, archived, side, deleting, emergency, gate held, append-only, or without an estimate', async t => {
  const f = await setup(t, { contextWindow: 400000 });
  f.advance(COLD + 1000);
  const assess = (patch = {}, options = {}) => idleCompactionAssessment(f.store.state, { ...f.current(), ...patch }, { executor: f.executor, ledger: f.ledger, survival: f.service.survival, ...options });
  assert.equal(assess(), null, 'under half of a 400K window');
  const g = await setup(t);
  g.advance(COLD + 1000);
  const check = (patch = {}, options = {}) => idleCompactionAssessment(g.store.state, { ...g.current(), ...patch }, { executor: g.executor, ledger: g.ledger, survival: g.service.survival, ...options });
  assert.ok(check());
  assert.equal(check({ archivedAt: new Date().toISOString() }), null);
  assert.equal(check({ kind: 'side' }), null);
  assert.equal(check({ status: 'running' }), null);
  assert.equal(check({ appRecovery: { required: true } }), null);
  assert.equal(check({}, { gate: { held: true } }), null);
  assert.equal(check({}, { survival: { estimate: () => ({ coldAfterMs: null }) } }), null, 'no estimate, no idle action');
  g.executor.memorySync.drainingSessions.add(g.session.id); assert.equal(check(), null); g.executor.memorySync.drainingSessions.clear();
  g.store.mutate(state => { state.sessionDeletions = [{ sessionId: g.session.id, status: 'pending' }]; }); assert.equal(check(), null);
  g.store.mutate(state => { state.sessionDeletions = []; state.emergency = true; }); assert.equal(check(), null);
  g.store.mutate(state => { state.emergency = false; state.settings.idleCompaction = false; }); assert.equal(check(), null);
  // The append-only flag is declared by the provider path that needs it (configured models reject unknown compat keys).
  const h = await setup(t);
  h.advance(COLD + 1000);
  h.store.mutate(state => { state.configuration.providers.find(row => row.models.some(model => model.id === 'main')).models.find(model => model.id === 'main').compat = { appendOnly: true }; });
  assert.equal(idleCompactionAssessment(h.store.state, h.current(), { executor: h.executor, ledger: h.ledger, survival: h.service.survival }), null, 'an append-only provider path is never compacted at idle');
});

test('a turn arriving during generation starts at once; the summary is offered to its live handle and committed at its cold request', async t => {
  const f = await setup(t, { language: 'en' });
  f.advance(COLD + 1000);
  const gate = f.block();
  f.service.plan();
  await new Promise(resolve => setTimeout(resolve, 50));
  // The turn opens the journal while the summary is still being generated.
  const turnRequests = [];
  const live = await createSession({ sessionId: f.session.id, projectId: f.project.id, cwd: f.directory, stateDir: f.stateDir, sessionFile: f.sessionFile, model: f.model, clock: f.clock, cacheSurvivalMs: COLD,
    provider: async function* (request) { turnRequests.push(request); yield { type: 'text_delta', delta: 'next chapter' }; yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } }; yield { type: 'done', stopReason: 'stop' }; } });
  t.after(() => live.dispose());
  f.executor.running.set(f.session.id, { handle: live });
  f.store.mutate(state => { state.sessions.find(item => item.id === f.session.id).status = 'running'; });
  gate.resolve(); await f.settle();
  assert.equal(live.snapshot().preparedCompaction?.throughMessageId !== undefined, true, 'offered to the live handle');
  assert.equal(existsSync(idleSummaryFile(f.sessionFile)), false);
  assert.equal(f.current().context.idleCompaction.status, 'prepared');
  // The turn's first request is cold (idle past the survival): the prepared summary is committed there, no new summary request.
  await live.prompt('Write the next chapter.');
  assert.equal(turnRequests.filter(isSummary).length, 0);
  assert.equal(live.snapshot().compaction.trigger, 'idle');
  assert.match(turnRequests[0].messages[0].content[0].text, /Prior conversation summary/);
});

test('rewind and deletion stop a generation; a restart re-plans a stale preparing record; the notice follows the interface language', async t => {
  const f = await setup(t, { language: 'en' });
  f.advance(COLD + 1000);
  f.block();
  f.service.plan();
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.service.quiesce(f.session.id);
  assert.equal(f.current().context.idleCompaction.status, 'skipped'); assert.equal(f.current().context.idleCompaction.code, 'interrupted');
  // A 'preparing' record left by a restart is planned again.
  f.store.mutate(state => { state.sessions.find(item => item.id === f.session.id).context.idleCompaction = { status: 'preparing', at: new Date().toISOString(), basisAt: 0 }; });
  const fresh = new IdleCompactionService(f.store, { executor: f.executor, ledger: f.ledger, survival: f.service.survival, provider: async function* () { yield { type: 'text_delta', delta: 'Summary after restart.' }; yield { type: 'done', stopReason: 'stop' }; }, now: f.clock });
  t.after(() => fresh.close());
  fresh.plan();
  while (fresh.inFlight.size) await Promise.all([...fresh.inFlight.values()].map(entry => entry.promise));
  assert.equal(f.current().context.idleCompaction.status, 'committed');
  assert.equal(f.current().items.at(-1).text, 'While this conversation was idle, earlier context was summarized in the background so the next turn starts faster; the original record and full tool results are still in the conversation log.');
});

test('a journal that cannot be opened is recorded once for the idle period, not reopened on every change; a missing one is no candidate', async t => {
  const { appendFileSync, renameSync } = await import('node:fs');
  const f = await setup(t);
  f.advance(COLD + 1000);
  appendFileSync(f.sessionFile, '{"seq":999,"not":"a chained record"}\n');
  f.service.plan(); await f.settle();
  assert.equal(f.current().context.idleCompaction.status, 'failed'); assert.equal(f.requests.length, 0);
  const claims = f.executor.claims.length;
  f.service.plan(); await f.settle();
  assert.equal(f.executor.claims.length, claims, 'no second attempt in the same idle period');
  renameSync(f.sessionFile, `${f.sessionFile}.moved`);
  assert.equal(idleCompactionAssessment(f.store.state, { ...f.current(), context: { ...f.current().context, idleCompaction: undefined } }, { executor: f.executor, ledger: f.ledger, survival: f.service.survival }), null);
});

// Merge of TC-3 (Claude keep-alive) with idle compaction: a conversation the host keeps warm with keep-alive pings is
// not compacted until its cache is cold, and a ping never counts as the conversation's last request.
test('idle compaction waits while keep-alive keeps the cache warm, and a TTL after its last ping once it lets go', async t => {
  const f = await setup(t);
  const lastRequest = f.ledger.lastSessionRequest(f.session.id).at;
  f.advance(COLD + 1000);
  const options = () => ({ executor: f.executor, ledger: f.ledger, survival: f.service.survival });
  assert.ok(idleCompactionAssessment(f.store.state, f.current(), options()).dueAt <= f.clock(), 'cold without keep-alive');
  // While the keep-alive holds the conversation, its horizon decides.
  let warm = f.clock() + 4 * 60000;
  f.ledger.keepAlive = { warmUntil: id => id === f.session.id ? warm : null };
  assert.equal(idleCompactionAssessment(f.store.state, f.current(), options()).dueAt, warm);
  f.service.plan(); await f.settle();
  assert.equal(f.requests.length, 0, 'no summary while the cache is kept warm');
  assert.equal(f.executor.claims.length, 0, 'not even a planning claim');
  // A ping refreshes the cache; it is metered, but it is not the conversation's last request.
  f.ledger.record({ purpose: 'foreground', projectId: f.project.id, sessionId: f.session.id, providerId: f.model.providerId, modelId: 'main', usage: { input: 1, output: 0, cacheRead: 5000, cacheWrite: 0, cacheUsageReported: true }, keepAlive: true });
  const ping = f.clock();
  assert.equal(f.ledger.lastSessionRequest(f.session.id).at, lastRequest, 'the idle period still counts from the real request');
  assert.equal(f.ledger.lastKeepAlive(f.session.id), ping);
  // The keep-alive lets go: the cache stays warm for the survival after the last ping.
  warm = null;
  const assessment = idleCompactionAssessment(f.store.state, f.current(), options());
  assert.equal(assessment.dueAt, ping + COLD); assert.equal(assessment.lastAt, lastRequest);
  f.service.plan(); await f.settle();
  assert.equal(f.requests.length, 0);
  f.advance(COLD + 1000);
  f.service.plan(); await f.settle();
  assert.equal(f.requests.length, 1, 'compacted once the cache went cold');
  assert.equal(f.current().context.idleCompaction.status, 'committed');
  assert.equal(f.current().context.idleCompaction.basisAt, lastRequest, 'one attempt per idle period of real activity');
});

test('an append-only Claude conversation is still compacted at idle (its commit rebases); a declared append-only path is not', async t => {
  const f = await setup(t);
  f.advance(COLD + 1000);
  const assess = () => idleCompactionAssessment(f.store.state, f.current(), { executor: f.executor, ledger: f.ledger, survival: f.service.survival });
  const main = state => state.configuration.providers.find(row => row.models.some(model => model.id === 'main'));
  f.store.mutate(state => { const provider = main(state); provider.protocol = 'anthropic'; provider.baseUrl = 'https://api.anthropic.com'; provider.models.find(model => model.id === 'main').compat = { appendOnly: true }; });
  assert.ok(assess(), 'append-only Anthropic history compacts with a thinking rebase');
  f.store.mutate(state => { const provider = main(state); provider.protocol = 'openai'; provider.baseUrl = 'http://127.0.0.1:1/v1'; });
  assert.equal(assess(), null, 'a path declared append-only without a rebase never is');
});

// P1 review (compaction D1/D3/D4/D6, claude CLAUDE-5, integration INT-6/INT-9).
const summaryCount = f => f.requests.length;
test('a throw after the paid summary ends the idle period: no second summary is paid for the same basis', async t => {
  const { mkdirSync } = await import('node:fs');
  // The hand-over cannot be written (here: its temp path is a directory).
  const f = await setup(t);
  f.advance(COLD + 1000);
  mkdirSync(`${idleSummaryFile(f.sessionFile)}.${process.pid}.tmp`);
  f.service.plan(); await f.settle();
  const record = f.current().context.idleCompaction;
  assert.deepEqual([record.status, record.code, record.basisAt], ['failed', 'EISDIR', f.ledger.lastSessionRequest(f.session.id).at]);
  for (let pass = 0; pass < 3; pass++) { f.service.plan(); await f.settle(); }
  assert.equal(summaryCount(f), 1, 'paid once');
  // Anything else that throws past the generation's own handling (here: recording the prepared state).
  const g = await setup(t);
  g.advance(COLD + 1000);
  const record0 = g.service.record.bind(g.service);
  g.service.record = (id, value) => { if (value.status === 'prepared') throw Object.assign(new Error('store write failed'), { code: 'EIO' }); return record0(id, value); };
  g.service.plan(); await g.settle();
  assert.equal(g.current().context.idleCompaction.status, 'failed'); assert.equal(g.current().context.idleCompaction.code, 'EIO');
  for (let pass = 0; pass < 3; pass++) { g.service.plan(); await g.settle(); }
  assert.equal(summaryCount(g), 1, 'the backstop holds the idle period too');
});

test('the idle summary is internal work: the usable provider default without a cache write on Claude; GLM keeps its effort and retries one step lower after a length finish', async t => {
  // Claude-style adaptive thinking (no real Anthropic request: the summary provider is a fixture).
  const claude = await setup(t, { protocol: 'anthropic', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], selection: 'max', compat: { adaptiveThinking: true } });
  claude.advance(COLD + 1000);
  claude.service.plan(); await claude.settle();
  assert.equal(claude.requests[0].model.reasoning, 'default', 'not the chat\'s max');
  assert.equal(claude.requests[0].cache.retention, 'none', 'no 1.25× write for a one-off record');
  assert.equal(claude.current().context.idleCompaction.status, 'committed');
  // GLM-style effort control whose default is its deepest level: today's effort, then one lighter retry on 'length'.
  const glm = await setup(t, { reasoning: ['low', 'high', 'max'], selection: 'max', compat: { thinkingFormat: 'zai' } });
  glm.advance(COLD + 1000);
  const seen = [];
  glm.service.provider = async function* (request) {
    seen.push(request.model.reasoning);
    if (seen.length === 1) { yield { type: 'text_delta', delta: 'A summary cut off at the' }; yield { type: 'usage', usage: { input: 900, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 1900, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'length' }; return; }
    yield { type: 'text_delta', delta: 'Chapters one to three: summary.' }; yield { type: 'usage', usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' };
  };
  glm.service.plan(); await glm.settle();
  assert.deepEqual(seen, ['max', 'high']);
  assert.equal(glm.current().context.idleCompaction.status, 'committed');
  assert.equal(glm.store.state.realUsage.tokens, 1900 + 920, 'both attempts are charged');
  assert.equal(glm.ledger.rows.filter(row => row.purpose === 'compaction').length, 2);
  // Truncated again at the lighter level: failed for this idle period, no third attempt.
  const again = await setup(t, { reasoning: ['low', 'high', 'max'], selection: 'max', compat: { thinkingFormat: 'zai' } });
  again.advance(COLD + 1000);
  let attempts = 0;
  again.service.provider = async function* () { attempts++; yield { type: 'text_delta', delta: 'cut' }; yield { type: 'done', stopReason: 'length' }; };
  again.service.plan(); await again.settle(); again.service.plan(); await again.settle();
  assert.equal(attempts, 2);
  assert.deepEqual([again.current().context.idleCompaction.status, again.current().context.idleCompaction.truncated], ['failed', true]);
});

test('the idle summary\'s effort is the one internal plan: "same as chat" keeps the chat\'s effort; on GLM the JEV route only records beside the call', async t => {
  // The user's switch back to the chat's own effort (configuration.internalReasoning.mode 'chat') reaches idle summaries too.
  const claude = await setup(t, { protocol: 'anthropic', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], selection: 'max', compat: { adaptiveThinking: true } });
  claude.store.configurationService.update({ internalReasoning: { mode: 'chat' } });
  claude.advance(COLD + 1000);
  claude.service.plan(); await claude.settle();
  assert.equal(claude.requests[0].model.reasoning, 'max');
  assert.equal(claude.requests[0].cache.retention, 'none');
  // GLM: purpose compaction is recorded only, even when the setting routes; the judge sees the plan and today's effort is sent.
  const glm = await setup(t, { reasoning: ['low', 'high', 'max'], selection: 'max', compat: { thinkingFormat: 'zai' } });
  glm.store.configurationService.update({ internalReasoning: { routing: 'route' } });
  const asked = [], shadowed = [];
  glm.service.decisions = { effortMayApply: purpose => !['setup', 'compaction'].includes(purpose), shadow: (key, work) => { shadowed.push(key); void work(); },
    internalEffort: async (_project, input) => { asked.push(input); return { effort: 'low', depth: 'light', source: 'jev', applied: input.apply === true, ledgerId: 'j1' }; } };
  glm.advance(COLD + 1000);
  glm.service.plan(); await glm.settle();
  assert.deepEqual(glm.requests.map(request => request.model.reasoning), ['max']);
  assert.equal(asked.length, 1); assert.equal(asked[0].purpose, 'compaction'); assert.equal(asked[0].apply, false);
  assert.deepEqual(asked[0].plan, { mode: 'route', allowed: ['low', 'high', 'max'], fallback: 'max', ceiling: 'max' });
  assert.match(shadowed[0], /^effort\.compaction:/);
  assert.equal(glm.current().context.idleCompaction.status, 'committed');
});

test('a provider key for interactive chat only (Kimi Coding plan) never runs an idle summary', async t => {
  const f = await setup(t);
  f.advance(COLD + 1000);
  const assess = () => idleCompactionAssessment(f.store.state, f.current(), { executor: f.executor, ledger: f.ledger, survival: f.service.survival });
  assert.ok(assess());
  f.store.mutate(state => { state.configuration.providers.find(row => row.models.some(model => model.id === 'main')).baseUrl = 'https://api.kimi.com/coding/v1'; });
  assert.equal(assess(), null);
  f.service.plan(); await f.settle();
  assert.equal(summaryCount(f), 0);
});

test('a rewind or manual compaction that stops a generation holds the idle period until the next request', async t => {
  const f = await setup(t);
  f.advance(COLD + 1000);
  const gate = f.block();
  f.service.plan();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(summaryCount(f), 1);
  await f.service.quiesce(f.session.id);
  gate.resolve();
  const lastAt = f.ledger.lastSessionRequest(f.session.id).at, record = f.current().context.idleCompaction;
  assert.deepEqual([record.status, record.code, record.basisAt], ['skipped', 'interrupted', lastAt]);
  // The user is present (the stale pre-rewind measurement still says over half): nothing starts again at once.
  f.service.plan(); await f.settle();
  assert.equal(summaryCount(f), 1, 'no second paid summary while the user is here');
  // Quiesced while still planning (under the brief claim): held the same way, nothing paid.
  const g = await setup(t);
  g.advance(COLD + 1000);
  g.service.plan();
  await g.service.quiesce(g.session.id);
  g.service.plan(); await g.settle();
  assert.equal(summaryCount(g), 0); assert.equal(g.current().context.idleCompaction.basisAt, g.ledger.lastSessionRequest(g.session.id).at);
  // A shutdown is not the user acting: the next start plans the same idle period again.
  const h = await setup(t);
  h.advance(COLD + 1000);
  const stuck = h.block();
  h.service.plan();
  await new Promise(resolve => setTimeout(resolve, 50));
  const closing = h.service.close(); stuck.resolve(); await closing;
  assert.equal(h.current().context.idleCompaction.basisAt, undefined);
  const restarted = new IdleCompactionService(h.store, { executor: h.executor, ledger: h.ledger, survival: h.service.survival, provider: async function* () { yield { type: 'text_delta', delta: 'Summary after restart.' }; yield { type: 'done', stopReason: 'stop' }; }, now: h.clock });
  t.after(() => restarted.close());
  restarted.plan();
  while (restarted.inFlight.size) await Promise.all([...restarted.inFlight.values()].map(entry => entry.promise));
  assert.equal(h.current().context.idleCompaction.status, 'committed');
  // A new request starts a new idle period.
  f.ledger.record({ purpose: 'foreground', projectId: f.project.id, sessionId: f.session.id, providerId: f.model.providerId, modelId: 'main', usage: { input: 10, cacheRead: 100, cacheWrite: 0, cacheUsageReported: true } });
  f.advance(COLD + 1000);
  f.service.plan(); await f.settle();
  assert.equal(summaryCount(f), 2);
  assert.equal(f.current().context.idleCompaction.status, 'committed');
});

// Plan C5, pi's split turn: the retained turns alone keep the conversation over the idle trigger (half the window), so the
// ordinary plan would be empty or still above it; the earliest retained turn is split and its beginning summarized on its
// own. The host runs the plan's requests in order and joins their texts into the one checkpoint it hands over.
test('a split turn: the history and the turn prefix are two summary requests, charged and metered each, joined into one committed checkpoint', async t => {
  // Turn 1 is short; turns 2 and 3 are three long sources each: the last two turns hold two thirds of the window.
  const f = await setup(t, { contextWindow: 40000, turns: 3, groups: turn => turn === 1 ? 0 : 3 });
  const idle = idleCompactionAssessment(f.store.state, f.current(), { executor: f.executor, ledger: f.ledger, survival: f.service.survival });
  assert.ok(idle, 'over half the window'); assert.ok(idle.tokens > 0.5 * 40000 && idle.tokens < 0.8 * 40000, `${idle.tokens} tokens: due, and the writer never compacted`);
  f.advance(COLD + 1000);
  f.service.plan(); await f.settle();
  assert.equal(f.requests.length, 2, 'the history and the turn prefix');
  const [history, prefix] = f.requests.map(request => request.messages[0].content[0].text);
  assert.ok(f.requests[0].systemPrompt.startsWith('Summarize the provided')); assert.match(history, /写第 1 章/); assert.doesNotMatch(history, /写第 2 章|写第 3 章/);
  assert.match(prefix, /写第 2 章/); assert.doesNotMatch(prefix, /写第 1 章|写第 3 章/); assert.match(prefix, /only the beginning of one user turn/);
  const record = f.current().context.idleCompaction;
  assert.equal(record.status, 'committed'); assert.ok(record.afterTokens < record.beforeTokens);
  assert.ok(record.afterTokens < 0.5 * 40000 + 1000, `the projection ${record.afterTokens} is within the idle trigger (plus the summary)`);
  const journal = readFileSync(f.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const compaction = journal.find(row => row.type === 'context_compaction').data;
  assert.equal(compaction.trigger, 'idle'); assert.equal(compaction.summary, 'Chapters one to three: summary.\n\n---\n\n**Turn context (split turn):**\n\nChapters one to three: summary.');
  assert.ok(compaction.retainedMessages > 8 && compaction.retainedMessages < 16, `turn 3 (8 messages) whole and the rest of turn 2: ${compaction.retainedMessages}`);
  // Accounting and metering: both requests, each its own reservation and ledger row; the sidecar holds the first request's id.
  assert.equal(f.store.state.realUsage.tokens, 1840, 'both summaries are charged');
  assert.deepEqual(f.ledger.rows.filter(row => row.purpose === 'compaction').map(row => [row.trigger, row.sessionId, row.input]), [['idle', f.session.id, 900], ['idle', f.session.id, 900]]);
  assert.equal(compaction.requestId, journal.find(row => row.type === 'compaction_prepared').data.requestId);
  // One attempt per idle period.
  f.service.plan(); assert.equal(f.service.inFlight.size, 0);
});

test('a split plan must be affordable as a whole: every request of it counts against the real-token budget', async t => {
  const probe = await setup(t, { contextWindow: 40000, turns: 3, groups: turn => turn === 1 ? 0 : 3 });
  probe.advance(COLD + 1000); probe.service.plan(); await probe.settle();
  const [history, prefix] = probe.requests.map(request => request.estimatedInputTokens);
  assert.ok(history > 0 && prefix > 0, 'the providers are told each request\'s estimate');
  // Enough for the turn prefix alone (and its output allowance), not for both.
  const f = await setup(t, { contextWindow: 40000, turns: 3, groups: turn => turn === 1 ? 0 : 3 });
  f.store.mutate(state => { state.settings.realTokenBudget = prefix + 1000 + 500; });
  f.advance(COLD + 1000); f.service.plan(); await f.settle();
  assert.equal(f.requests.length, 0, 'nothing was sent');
  assert.deepEqual([f.current().context.idleCompaction.status, f.current().context.idleCompaction.code], ['skipped', 'budget']);
});

test('a truncated turn prefix is asked again one effort step lower and the history is not paid for twice', async t => {
  const f = await setup(t, { contextWindow: 40000, turns: 3, groups: turn => turn === 1 ? 0 : 3, protocol: 'openai', reasoning: ['low', 'high'], selection: 'high' });
  const seen = [];
  f.service.provider = async function* (request) {
    const kind = request.messages[0].content[0].text.includes('only the beginning of one user turn') ? 'turn_prefix' : 'history';
    seen.push({ kind, reasoning: request.model.reasoning });
    const truncated = kind === 'turn_prefix' && seen.filter(row => row.kind === 'turn_prefix').length === 1;
    yield { type: 'text_delta', delta: truncated ? 'cut off' : 'Checkpoint text.' };
    yield { type: 'usage', usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 920 } };
    yield { type: 'done', stopReason: truncated ? 'length' : 'stop' };
  };
  f.advance(COLD + 1000); f.service.plan(); await f.settle();
  assert.deepEqual(seen.map(row => row.kind), ['history', 'turn_prefix', 'turn_prefix'], 'the history once, the prefix twice');
  assert.notEqual(seen[2].reasoning, seen[1].reasoning, 'one step lower on the retry');
  assert.equal(f.current().context.idleCompaction.status, 'committed');
});

// Review of C5 (finding 1): the maintenance handle that plans the compaction has no tool catalogue and the default prompt,
// so its estimate is smaller than what the idle trigger counted; the host hands over its own measure with the target.
test('the plan is told the host\'s own measure of the conversation beside the idle trigger, so a split target is compared in the same units', async t => {
  const f = await setup(t, { contextWindow: 40000, turns: 3, groups: turn => turn === 1 ? 0 : 3 });
  const measured = f.current().context.usage.estimatedInputTokens, calls = [];
  f.service.factory = async options => { const handle = await createSession(options), plan = handle.prepareCompaction.bind(handle); handle.prepareCompaction = input => { calls.push(input); return plan(input); }; return handle; };
  f.advance(COLD + 1000); f.service.plan(); await f.settle();
  assert.equal(calls.length, 1, 'one plan');
  assert.deepEqual(calls[0], { keepUserTurns: IDLE_KEEP_USER_TURNS, targetTokens: 20000, measuredTokens: measured });
  assert.equal(f.current().context.idleCompaction.status, 'committed');
});
