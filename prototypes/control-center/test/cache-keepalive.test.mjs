import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheKeepAlive, KEEP_ALIVE_LEAD_MS, chargeKeepAlive, keepAliveBlocked, keepAliveDecision, returnGaps } from '../cache-keepalive.mjs';
import { CacheSurvival, UsageLedger, aggregateCacheUsage, meteredProvider } from '../usage-cache-service.mjs';
import { survivalSample } from '../../../packages/sdk/src/cache-survival.mjs';
import { createSession } from '../../../packages/sdk/src/session.mjs';

const KEY = 'sk-ant-fixture-not-a-real-key';
const opus = { providerId: 'claude', modelId: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 1000000, maxOutputTokens: 64000, reasoning: 'default', compat: { adaptiveThinking: true } };
const MIN = 60000, HOUR = 60 * MIN, TTL = 5 * MIN;
const usage = { input: 1, output: 0, cacheRead: 5000, cacheWrite: 0, totalTokens: 5001, cacheUsageReported: true };

test('the ping decision is the conditional return probability against the price ratio, from observed gaps', () => {
  // Opus 5.5: read 0.05x, write 1.25x -> pays above 0.05 / 1.2 = 4.2%.
  const quick = Array.from({ length: 40 }, () => 30000);
  const decide = (sessionGaps, pooledGaps, idleMs) => keepAliveDecision({ sessionGaps, pooledGaps, idleMs, ttlMs: TTL, readShare: 0.05 });
  assert.equal(decide([], [], 4 * MIN).ping, false, 'nothing observed: no ping');
  const returning = [...quick, 7 * MIN, 8 * MIN, 9 * MIN, 12 * MIN, 25 * MIN, 240 * MIN];
  const first = decide(returning, [], 4 * MIN);
  assert.equal(first.ping, true); assert.ok(Math.abs(first.threshold - 0.05 / 1.2) < 1e-12);
  assert.equal(decide(returning, [], 30 * MIN).ping, false, 'past the observed returns it stops (no fixed horizon)');
  assert.equal(decide(Array.from({ length: 30 }, () => 600 * MIN), [], 4 * MIN).ping, false, 'a conversation whose user comes back hours later is not kept warm');
  assert.equal(decide([], returning, 4 * MIN).ping, true, 'a new conversation borrows the pooled returns as a one-observation prior');
  // Cheaper reads make pings pay at a lower probability.
  assert.ok(keepAliveDecision({ sessionGaps: returning, idleMs: 4 * MIN, ttlMs: TTL, readShare: 0.025 }).threshold < first.threshold);
  assert.deepEqual(returnGaps([{ at: '2026-10-04T00:00:00Z' }, { at: '2026-10-04T00:04:00Z', keepAlive: true }, { at: '2026-10-04T00:10:00Z' }]), [10 * MIN]);
});

test('an idle official Claude conversation is pinged before expiry while it pays, then let go; other traffic never is', async () => {
  let clock = Date.parse('2026-10-04T10:00:00Z');
  const timers = [], sent = [];
  const ledger = new UsageLedger({ now: () => clock });
  // History: this conversation's user usually returns within 12 minutes.
  for (const [index, minutes] of [0, 1, 9, 10, 20, 21, 31, 32].entries()) ledger.rows.push({ at: new Date(clock - (40 - minutes) * MIN).toISOString(), purpose: 'foreground', sessionId: 'chat', cacheReported: true, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, n: index });
  const keepAlive = new CacheKeepAlive({ ledger, now: () => clock, setTimer: (fn, delay) => { const timer = { fn, at: clock + delay, cleared: false }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cleared = true; },
    send: async request => { sent.push(request); return { usage, stopReason: 'max_tokens' }; }, pricing: () => ({ entry: { input: 4, cacheRead: 0.2 } }) });
  ledger.keepAlive = keepAlive;
  const run = async (sessionId, model = opus, purpose = 'foreground') => {
    const provider = meteredProvider(async function* () { yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; }, { ledger, purpose, projectId: 'p', sessionId });
    await Array.fromAsync(provider({ model, apiKey: KEY, systemPrompt: 'S', messages: [{ role: 'user', content: 'hi' }], cache: { retention: 'short', prefixHash: 'h', sessionKey: 'k' } }));
  };
  await run('chat');
  for (const [model, purpose, sessionId] of [[{ ...opus, baseUrl: 'https://api.kimi.com/coding' }, 'foreground', 'kimi'], [{ ...opus, protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3' }, 'foreground', 'glm'], [opus, 'background-work', 'bg']]) await run(sessionId, model, purpose);
  assert.equal(timers.length, 1, 'only the official Claude foreground conversation is scheduled');
  assert.equal(timers[0].at, clock + TTL - KEEP_ALIVE_LEAD_MS, 'just before the 5-minute entry expires');
  assert.equal(keepAlive.warmUntil('chat'), clock + TTL);
  const fire = async () => { const timer = timers.filter(row => !row.cleared && !row.fired).sort((a, b) => a.at - b.at)[0]; if (!timer) return false; clock = timer.at; timer.fired = true; await timer.fn(); return true; };
  assert.equal(await fire(), true); assert.equal(sent.length, 1, 'first ping');
  assert.equal(sent[0].apiKey, KEY); assert.deepEqual(sent[0].messages, [{ role: 'user', content: 'hi' }], 'the same request is re-sent');
  const pingRow = ledger.records().at(-1);
  assert.equal(pingRow.keepAlive, true); assert.equal(pingRow.purpose, 'foreground'); assert.equal(pingRow.cacheRead, 5000); assert.ok(pingRow.prefixKey);
  while (await fire()) { /* keep pinging while it pays */ }
  assert.ok(sent.length >= 2 && sent.length <= 4, `pings stop once returns are no longer likely (${sent.length})`);
  assert.equal(keepAlive.warmUntil('chat'), null, 'let go');
  // A new request cancels a pending ping.
  await run('chat'); const pending = timers.at(-1);
  await run('chat'); assert.equal(pending.cleared, true);
  keepAlive.close(); assert.equal(timers.at(-1).cleared, true);
});

// Merge of TC-3 with the cache-survival ledger (p1 compaction §A): keep-alive pings neither break a conversation's
// continuity nor count as its last request, and a gap they bridged is never learned as cache survival.
test('a request after keep-alive pings keeps its continuity, is marked bridged and teaches no survival', () => {
  let clock = Date.parse('2026-10-04T10:00:00Z');
  const observed = [];
  const ledger = new UsageLedger({ now: () => clock, survival: { observe: row => observed.push(row) } });
  const row = extra => ledger.record({ purpose: 'foreground', projectId: 'p', sessionId: 'chat', providerId: 'claude', modelId: 'claude-opus-5-5', usage, ...extra });
  row({ continuity: { continuous: true, gapMs: 30000, previousPromptTokens: 5000 } });
  const first = ledger.lastSessionRequest('chat').at;
  clock += 4 * MIN + 40000; row({ keepAlive: true });
  clock += 5 * MIN; row({ keepAlive: true });
  assert.equal(ledger.lastSessionRequest('chat').at, first, 'pings are not conversation requests');
  assert.equal(ledger.lastKeepAlive('chat'), clock);
  clock += 2 * MIN;
  const next = row({ continuity: { continuous: true, gapMs: 11 * MIN + 40000, previousPromptTokens: 5001 } });
  assert.deepEqual(next.continuity, { continuous: true, gapMs: 11 * MIN + 40000, previousPromptTokens: 5001, bridged: true }, 'still continuous: the pings left the projection alone');
  assert.equal(ledger.lastSessionRequest('chat').at, clock);
  // The survival observer sees the row, but a bridged gap yields no sample (it would push the 5-minute TTL out).
  assert.equal(survivalSample({ continuity: next.continuity, cacheReported: true, cacheRead: 5000, at: next.at }), null);
  assert.ok(survivalSample({ continuity: { ...next.continuity, bridged: undefined }, cacheReported: true, cacheRead: 5000, at: next.at }), 'the same gap unbridged would be a warm sample');
  clock += 7 * MIN;
  assert.equal(row({ continuity: { continuous: true, gapMs: 7 * MIN, previousPromptTokens: 5001 } }).continuity.bridged, undefined, 'only gaps a ping fell in are bridged');
  assert.ok(observed.length >= 3);
});

// Review P1 (CLAUDE-2/INT-2, CLAUDE-3, INT-3): an entry lives only while its request is still the next request's
// prefix, its cache is still warm, and a ping is still permitted when it is due.
function fixture({ allowed, enabled, charge } = {}) {
  const state = { clock: Date.parse('2026-10-04T10:00:00Z') };
  const timers = [], sent = [], charged = [];
  const ledger = new UsageLedger({ now: () => state.clock });
  // This conversation's user usually returns within a few minutes, so a ping pays.
  for (const minutes of [0, 1, 6, 7, 13, 14, 20, 21, 27, 28]) ledger.rows.push({ at: new Date(state.clock - (40 - minutes) * MIN).toISOString(), purpose: 'foreground', sessionId: 'chat', cacheReported: true, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  const keepAlive = new CacheKeepAlive({ ledger, now: () => state.clock, setTimer: (fn, delay) => { const timer = { fn, at: state.clock + delay, cleared: false }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cleared = true; },
    send: async request => { sent.push(request); return { usage, stopReason: 'max_tokens' }; }, pricing: () => ({ entry: { input: 4, cacheRead: 0.2 } }),
    ...(enabled ? { enabled } : {}), ...(allowed ? { allowed } : {}), charge: charge ?? (value => charged.push(value)) });
  ledger.keepAlive = keepAlive;
  const run = async ({ requestPurpose, duration = 0, sessionId = 'chat', text = 'hi', events = [] } = {}) => {
    const provider = meteredProvider(async function* () { state.clock += duration; for (const event of events) yield event; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; }, { ledger, purpose: 'foreground', projectId: 'p', sessionId });
    await Array.fromAsync(provider({ model: opus, apiKey: KEY, systemPrompt: 'S', messages: [{ role: 'user', content: text }], cache: { retention: 'short', prefixHash: 'h', sessionKey: 'k' }, ...(requestPurpose ? { purpose: requestPurpose } : {}) }));
  };
  const live = () => timers.filter(row => !row.cleared && !row.fired);
  const fire = async ({ late = 0 } = {}) => { const timer = live().sort((a, b) => a.at - b.at)[0]; if (!timer) return false; state.clock = timer.at + late; timer.fired = true; await timer.fn(); return true; };
  return { state, ledger, keepAlive, run, live, fire, sent, charged };
}

test('any later request of the conversation, a forget, a late settle or a binding recovery leaves nothing to ping', async () => {
  const f = fixture();
  // A deferred or manual compaction runs through the same metered provider (request.purpose compaction): the entry of
  // the last turn holds the full pre-compaction history, which no later request reads.
  await f.run({ text: 'FULL HISTORY BEFORE COMPACTION' });
  assert.ok(f.keepAlive.warmUntil('chat'));
  await f.run({ requestPurpose: 'compaction', text: 'flattened record' });
  assert.equal(f.keepAlive.warmUntil('chat'), null, 'a summary request of the conversation drops its entry');
  assert.equal(f.live().length, 0);
  // A step-limit summary too; an unrelated conversation is untouched.
  await f.run(); await f.run({ sessionId: 'other' });
  await f.run({ requestPurpose: 'summary' });
  assert.equal(f.keepAlive.warmUntil('chat'), null); assert.ok(f.keepAlive.warmUntil('other'));
  // The host forgets an entry on rewind, deletion and a committed compaction.
  assert.equal(f.keepAlive.forget('other'), true); assert.equal(f.keepAlive.forget('other'), false);
  assert.equal(f.live().length, 0);
  // A response that streamed past the entry's lifetime (counted from the request start) left it cold: no ping.
  await f.run({ duration: 6 * MIN });
  assert.equal(f.keepAlive.warmUntil('chat'), null, 'an expired entry is never pinged (a ping would be a full write)');
  assert.equal(f.live().length, 0);
  // Just inside the lead the ping still lands: it fires at once.
  await f.run({ duration: TTL - KEEP_ALIVE_LEAD_MS + 1000 });
  assert.ok(f.keepAlive.warmUntil('chat'));
  assert.equal(await f.fire(), true); assert.equal(f.sent.length, 1);
  // A timer that fires too late (the machine slept) sends nothing and lets go.
  await f.run();
  assert.equal(await f.fire({ late: TTL }), true);
  assert.equal(f.sent.length, 1, 'no ping after expiry'); assert.equal(f.keepAlive.warmUntil('chat'), null);
  // The provider re-sent the request without some thinking: the body held here is not what the cache holds.
  await f.run({ events: [{ type: 'thinking_rebase', reason: 'binding_rejected' }] });
  assert.equal(f.keepAlive.warmUntil('chat'), null);
});

test('a due ping is re-checked: emergency stop, update, deletion, archive, key or endpoint change and budget stop it; a sent ping is charged', async () => {
  const state = { emergency: false, sessions: [{ id: 'chat', projectId: 'p', usage: { tokens: 0 } }], projects: [{ id: 'p' }], sessionDeletions: [], settings: { realTokenBudget: null },
    configuration: { providers: [{ id: 'claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }] } };
  let key = KEY; const gate = { held: false };
  const blocked = entry => keepAliveBlocked(state, entry, { gate, secret: () => key });
  const entry = { sessionId: 'chat', request: { model: opus, apiKey: KEY }, promptTokens: 5001 };
  assert.equal(blocked(entry), null);
  const cases = [
    ['emergency', () => { state.emergency = true; }, () => { state.emergency = false; }],
    ['maintenance', () => { gate.held = true; }, () => { gate.held = false; }],
    ['session', () => { state.sessions[0].archivedAt = 'now'; }, () => { delete state.sessions[0].archivedAt; }],
    ['session', () => { state.sessions[0].appRecovery = { required: true }; }, () => { delete state.sessions[0].appRecovery; }],
    ['deletion', () => { state.sessionDeletions.push({ sessionId: 'chat' }); }, () => { state.sessionDeletions.length = 0; }],
    ['project', () => { state.projects[0].archivedAt = 'now'; }, () => { delete state.projects[0].archivedAt; }],
    ['provider', () => { state.configuration.providers[0].baseUrl = 'https://proxy.example'; }, () => { state.configuration.providers[0].baseUrl = 'https://api.anthropic.com'; }],
    ['credential', () => { key = ''; }, () => { key = KEY; }],
    ['credential', () => { key = 'sk-ant-fixture-rotated-key'; }, () => { key = KEY; }],
    ['budget', () => { state.settings.realTokenBudget = 5000; }, () => { state.settings.realTokenBudget = null; }]
  ];
  for (const [code, apply, undo] of cases) { apply(); assert.equal(blocked(entry), code); undo(); assert.equal(blocked(entry), null); }
  state.sessions.length = 0; assert.equal(blocked(entry), 'session', 'a deleted conversation');
  state.sessions.push({ id: 'chat', projectId: 'p', usage: { tokens: 0 } });
  // Wired like the server: the check runs when the ping is due, and a refused ping drops the entry.
  const f = fixture({ allowed: candidate => !blocked(candidate), charge: ({ sessionId, usage: used }) => chargeKeepAlive(state, sessionId, used) });
  await f.run();
  state.emergency = true;
  assert.equal(await f.fire(), true); assert.equal(f.sent.length, 0, 'no ping during an emergency stop');
  assert.equal(f.keepAlive.warmUntil('chat'), null);
  state.emergency = false;
  await f.run(); state.sessionDeletions.push({ sessionId: 'chat' });
  assert.equal(await f.fire(), true); assert.equal(f.sent.length, 0, 'no ping for a conversation being deleted');
  state.sessionDeletions.length = 0;
  // A permitted ping is sent and charged to the real-token budget and the conversation.
  await f.run();
  assert.equal(await f.fire(), true); assert.equal(f.sent.length, 1);
  assert.equal(state.realUsage.tokens, usage.totalTokens); assert.equal(state.sessions[0].usage.tokens, usage.totalTokens);
  // `enabled` is read again when the ping is due, not only when it was scheduled.
  let on = true;
  const g = fixture({ enabled: () => on });
  await g.run(); on = false;
  assert.equal(await g.fire(), true); assert.equal(g.sent.length, 0); assert.equal(g.keepAlive.warmUntil('chat'), null);
});

// Review P1 INT-7: pings are not conversation requests; cache statistics leave them out and report them apart.
test('keep-alive rows stay out of the cache metrics and latest, and are reported apart under keepAlive (tokens, no price)', () => {
  const now = Date.parse('2026-10-04T12:00:00Z'), at = minutes => new Date(now - minutes * MIN).toISOString();
  const rows = [
    { at: at(30), purpose: 'foreground', sessionId: 'chat', providerId: 'claude', modelId: 'claude-opus-5-5', input: 1000, output: 50, cacheRead: 0, cacheWrite: 9000, cacheReported: true },
    { at: at(25), purpose: 'foreground', sessionId: 'chat', providerId: 'claude', modelId: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 10000, cacheWrite: 0, cacheReported: true, keepAlive: true },
    { at: at(20), purpose: 'foreground', sessionId: 'chat', providerId: 'claude', modelId: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 10000, cacheWrite: 0, cacheReported: true, keepAlive: true }
  ];
  const report = aggregateCacheUsage(rows, { window: '24h', now });
  assert.equal(report.overall.requests, 1); assert.equal(report.byPurpose.foreground.requests, 1);
  assert.equal(report.overall.cacheRead, 0, 'no read the conversation did not make'); assert.equal(report.overall.hitRate, 0);
  assert.equal(report.latest.at, rows[0].at, 'latest is the conversation request, not a ping');
  assert.equal(report.keepAlive.requests, 2); assert.equal(report.keepAlive.cacheRead, 20000);
  assert.equal('cost' in report.keepAlive, false, 'the pings are counted in tokens, not priced');
  assert.equal(aggregateCacheUsage(rows.slice(0, 1), { window: '24h', now }).keepAlive, undefined);
});

// Review P1 INT-8: the survival backfill reads journals, which never hold pings: a gap a ping kept warm must not be
// learned as Claude's cache survival (it would push the documented 5-minute TTL out).
test('the survival backfill leaves out gaps a keep-alive bridged, and Claude gaps above the TTL it cannot check', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-backfill-keepalive-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json'), start = Date.parse('2026-10-04T08:00:00Z');
  const journal = async (sessionId, model) => {
    let now = start;
    // Every answer reads the whole previous prompt from cache (warm), 20 minutes apart.
    const provider = async function* () { yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 5000, cacheWrite: 0, totalTokens: 5012, cacheUsageReported: true } }; yield { type: 'done', stopReason: 'stop' }; };
    const session = await createSession({ sessionId, projectId: 'p', cwd: directory, stateDir: join(`${stateFile}.rna`, sessionId), model, apiKey: KEY, provider, clock: () => now, autoCompaction: false });
    await session.prompt('one'); now += 20 * MIN; await session.prompt('two'); await session.dispose();
  };
  const glm = { providerId: 'glm', modelId: 'glm-5.3', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', contextWindow: 1000000, maxOutputTokens: 1000, reasoning: 'off' };
  await journal('claude-chat', opus); await journal('glm-chat', glm);
  const warm = (survival, key) => (survival.models.get(key) ?? []).filter(row => row.warm).map(row => row.gapMs);
  // A ledger covering the gaps, with a ping in the Claude one: bridged, no sample; GLM keeps its warm 20-minute sample.
  const ledger = new UsageLedger({ now: () => start + HOUR });
  ledger.rows.push({ at: new Date(start - MIN).toISOString(), purpose: 'foreground', sessionId: 'claude-chat', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheReported: true },
    { at: new Date(start + 10 * MIN).toISOString(), purpose: 'foreground', sessionId: 'claude-chat', input: 0, output: 0, cacheRead: 5000, cacheWrite: 0, cacheReported: true, keepAlive: true });
  let survival = new CacheSurvival({ now: () => start + HOUR });
  await survival.backfill({ stateFile, ledger });
  assert.deepEqual(warm(survival, 'claude|claude-opus-5-5'), [], 'the pinged gap is not learned');
  assert.deepEqual(warm(survival, 'glm|glm-5.3'), [20 * MIN], 'other providers keep their samples');
  // Without a ping in a covered gap, the Claude sample is genuine and kept.
  ledger.rows.pop();
  survival = new CacheSurvival({ now: () => start + HOUR });
  await survival.backfill({ stateFile, ledger });
  assert.deepEqual(warm(survival, 'claude|claude-opus-5-5'), [20 * MIN]);
  // A gap older than the ledger's oldest row cannot be checked: above the 5-minute TTL it is left out.
  survival = new CacheSurvival({ now: () => start + HOUR });
  await survival.backfill({ stateFile, ledger: new UsageLedger({ now: () => start + HOUR }) });
  assert.deepEqual(warm(survival, 'claude|claude-opus-5-5'), []);
  assert.deepEqual(warm(survival, 'glm|glm-5.3'), [20 * MIN]);
});
