#!/usr/bin/env node
// Explicit opt-in acceptance: real OpenViking extraction and summary models,
// controlled source dialogue, and a newly created tenant only. No main chat
// model is called or claimed here. Never enroll an existing user's history.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../prototypes/control-center/store.mjs';
import { readStateFile } from '../prototypes/control-center/state-shards.mjs';
import { MemorySync, memorySyncHealth } from '../prototypes/control-center/memory-sync.mjs';
import { isMemoryDirectoryPlaceholder } from '../prototypes/control-center/memory-service.mjs';
import { requestJSON } from '../prototypes/control-center/configuration.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === '--execute') options.execute = true;
  else if (['--endpoint', '--server-config', '--report'].includes(name) && args[index + 1]) options[name.slice(2)] = args[++index];
  else throw new Error('Usage: test-memory-summary-real.mjs --execute [--endpoint http://127.0.0.1:1933] [--server-config private/ov.conf] [--report report.json]');
}
if (!options.execute) {
  console.log('Prepared only: --execute is required to create a new QA tenant and call real extraction/summary models. No requests were sent.');
  process.exit(0);
}
const endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:1933');
assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && endpoint.port && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/', 'Use an explicit loopback OpenViking origin');
let config;
try { config = JSON.parse(readFileSync(resolve(options['server-config'] ?? join(root, 'deploy/openviking/.runtime/semantic/ov.conf')), 'utf8')); }
catch { throw new Error('Private OpenViking configuration is unreadable; its contents were not printed'); }
const embedding = config.embedding?.dense, vlm = config.vlm, rootKey = config.server?.root_api_key;
assert.ok(embedding && /bge-m3/i.test(embedding.model) && embedding.dimension === 1024, 'Real BGE-M3 1024-dimensional configuration required');
assert.ok(vlm && ['deepseek-flash', 'deepseek-v4-pro'].includes(vlm.model) && /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(vlm.api_base), 'Verified real DeepSeek extraction configuration required');
assert.ok(typeof rootKey === 'string' && rootKey && !JSON.stringify({ embedding, vlm }).includes('fixture'), 'Real authenticated service required');

const runId = randomUUID(), accountId = `rna-summary-qa-${runId.slice(0, 12)}`;
const privateDirectory = join(root, 'deploy/openviking/.runtime/semantic/qa', `summary-${runId}`);
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const stateFile = join(privateDirectory, 'state.json'), reportPath = resolve(options.report ?? join(root, 'prototypes/control-center/qa/memory-summary-real-report.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [], calls = [], transitions = [], atomicObservations = [];
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), endpoint: endpoint.origin, accountId,
  evidenceType: 'controlled source conversation; real remote extraction, embeddings, and summaries; production Store enrollment and MemorySync; no main-chat-model inference',
  models: { embedding: { model: embedding.model, dimension: embedding.dimension }, extraction: { model: vlm.model, apiBase: vlm.api_base } },
  checks, network: calls, transitions, atomicObservations, privateAuditDirectory: privateDirectory };
const dialogue = [
  { role: 'user', content: '请只在这个项目长期记住我们已确定的发布制度：每次客户演示固定安排在周五上午十点，演示彩排在前一天晚上八点进行。这是持续有效的团队约束，不是临时建议，也不能用于其他项目。' },
  { role: 'assistant', content: '已确认本项目的长期发布制度：周五上午十点客户演示，周四晚上八点彩排；后续计划持续遵循，只适用于本项目。' },
  { role: 'user', content: '另外确认一个长期验收标准：界面不能只用红绿颜色表示成败，必须同时提供文字标签和不同形状的图标。今后每次发布都要检查这个标准。' },
  { role: 'assistant', content: '确认：每次发布都检查状态文字和不同形状的图标，不能仅依赖红绿颜色；该标准与已确定的演示及彩排安排一并长期保留。' }
];
report.source = { messageCount: dialogue.length, sha256: hash(JSON.stringify(dialogue)), authoredForAcceptance: true };
let store, sync, client, projectId, sessionId, turnId, peerRoot, unsubscribe, phase = 'setup', traceSource = 'verifier';
const nativeFetch = globalThis.fetch;
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const writeOf = state => state.sessions.find(row => row.id === sessionId)?.turns.find(row => row.id === turnId)?.memoryWrite;
const summaryOf = state => state.projects.find(row => row.id === projectId)?.memorySummary;
const numericUsage = usage => Object.fromEntries(['llm', 'embedding', 'total'].map(kind => [kind, Object.fromEntries(Object.entries(usage?.[kind] ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))]));
function safeFailure(error) { return { code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'ACCEPTANCE_FAILED', phase,
  ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) }; }

// This observer forwards every request to the original real fetch. It never
// fabricates a response. Root authority is restricted to the one fresh tenant
// creation; all later requests must use that tenant's own credential.
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url), method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers), key = headers.get('X-API-Key');
  check(url.origin === endpoint.origin, 'QA_UNEXPECTED_REMOTE_ORIGIN');
  const body = init.body === undefined ? null : JSON.parse(init.body);
  if (key === rootKey) check(!client && method === 'POST' && url.pathname === '/api/v1/admin/accounts' && body?.account_id === accountId && body.admin_user_id === 'summary-verifier', 'QA_ROOT_AUTHORITY_OUT_OF_SCOPE');
  else {
    check(client && key === client.api_key, 'QA_TENANT_AUTHORITY_REQUIRED');
    if (method !== 'GET') {
      const knownSessions = store?.state.projects.find(row => row.id === projectId)?.memorySessions ?? [];
      if (url.pathname === '/api/v1/sessions') check(method === 'POST' && knownSessions.some(row => row.sessionId === body?.session_id), 'QA_SESSION_CREATION_OUT_OF_SCOPE');
      else if (url.pathname === '/api/v1/content/reindex') check(method === 'POST' && body?.uri === peerRoot && body.mode === 'semantic_and_vectors' && body.recursive === true && body.wait === false, 'QA_REINDEX_OUT_OF_SCOPE');
      else {
        const match = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]+)\/(messages\/batch|commit)$/.exec(url.pathname);
        check(method === 'POST' && match && knownSessions.some(row => row.sessionId === match[1]), 'QA_MUTATION_OUT_OF_SCOPE');
      }
    }
  }
  const record = { method, path: url.pathname, source: traceSource, startedAt: new Date().toISOString() };
  calls.push(record); const started = Date.now();
  try { const response = await nativeFetch(input, init); record.status = response.status; return response; }
  finally { record.elapsedMs = Date.now() - started; }
};
async function remote(path, { method = 'GET', body, admin = false } = {}) {
  const value = await requestJSON(`${endpoint.origin}/api/v1/${path}`, { method, body, headers: { 'X-API-Key': admin ? rootKey : client.api_key, ...(peerRoot ? { 'X-OpenViking-Actor-Peer': `forge-${projectId}` } : {}) }, timeoutMs: 20000 });
  check(value?.status === 'ok', 'QA_REMOTE_RESPONSE_INVALID'); return value.result;
}
async function step(name, operation) {
  phase = name; const started = Date.now();
  try { const details = await operation(); checks.push({ name, ok: true, elapsedMs: Date.now() - started, details }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, ok: false, elapsedMs: Date.now() - started, error: safeFailure(error) }); throw error; }
}
function observe() {
  let previous = '';
  unsubscribe = store.subscribe(() => {
    const write = writeOf(store.state), summary = summaryOf(store.state), signature = `${write?.status ?? ''}:${summary?.status ?? ''}:${summary?.taskStatus ?? ''}`;
    if (signature !== previous) { transitions.push({ at: new Date().toISOString(), write: write?.status ?? null, summary: summary?.status ?? null, task: summary?.taskStatus ?? null }); previous = signature; }
    if (write?.status === 'completed' && write.memoriesExtracted > 0) atomicObservations.push({ revision: store.state.revision, writeTaskId: write.taskId, summarySourceTaskId: summary?.lastSourceTaskId ?? null, summaryStatus: summary?.status ?? null });
  });
}
async function pumpUntil(done, milliseconds = 600000) {
  const deadline = Date.now() + milliseconds; let lastProgress = 0;
  while (Date.now() < deadline) {
    if (done()) return;
    traceSource = 'MemorySync'; try { await Promise.all(sync.pump()); } finally { traceSource = 'verifier'; }
    for (const row of [writeOf(store.state), summaryOf(store.state)]) check(!['failed', 'uncertain', 'skipped'].includes(row?.status), row?.code ?? 'QA_SYNC_TERMINAL_FAILURE');
    if (done()) return;
    if (Date.now() - lastProgress > 30000) { console.log(JSON.stringify({ progress: phase, memoryWrite: writeOf(store.state)?.status, memorySummary: summaryOf(store.state)?.status })); lastProgress = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Object.assign(new Error('QA_PHASE_TIMEOUT'), { code: 'QA_PHASE_TIMEOUT' });
}
async function manifest() {
  const rows = await remote(`fs/ls?${new URLSearchParams({ uri: peerRoot, recursive: 'true', output: 'original', node_limit: '501' })}`);
  check(Array.isArray(rows) && rows.length <= 500, 'QA_TREE_INVALID');
  const directories = new Set([peerRoot]), files = new Set();
  for (const row of rows) {
    check(typeof row?.uri === 'string' && row.uri.startsWith(`${peerRoot}/`) && !/[?#%\u0000-\u001f]/u.test(row.uri) && !row.uri.split('/').some(part => part === '.' || part === '..') && row.access !== 'denied' && typeof row.isDir === 'boolean', 'QA_TREE_SCOPE_INVALID');
    if (row.uri.slice(peerRoot.length + 1).split('/').some(part => part.startsWith('.'))) continue;
    (row.isDir ? directories : files).add(row.uri);
  }
  check(files.size > 0, 'QA_EXTRACTED_FILES_MISSING');
  const originals = [];
  for (const uri of [...files].sort()) {
    const content = await remote(`content/read?${new URLSearchParams({ uri, offset: '0', limit: '-1' })}`);
    check(typeof content === 'string' && content.trim(), 'QA_ORIGINAL_EMPTY');
    originals.push({ uri, bytes: Buffer.byteLength(content), sha256: hash(content), matchedTopics: {
      schedule: /周五|星期五|Friday/i.test(content) && /十点|10[:：]00|10\s*a\.?m/i.test(content),
      accessibility: /颜色|色彩|colour|color/i.test(content) && /文字|标签|text|label/i.test(content) && /形状|图标|shape|icon/i.test(content)
    } });
  }
  return { directories: [...directories].sort(), originals };
}

try {
  await step('isolated_real_tenant', async () => {
    const created = await remote('admin/accounts', { admin: true, method: 'POST', body: { account_id: accountId, admin_user_id: 'summary-verifier' } });
    const key = created.user_key ?? created.admin_api_key ?? created.api_key; check(typeof key === 'string' && key.length > 0, 'QA_TENANT_CREDENTIAL_MISSING');
    client = { endpoint: endpoint.origin, account_id: accountId, user_id: 'summary-verifier', api_key: key };
    const credentialFile = join(privateDirectory, 'tenant.json'); writeFileSync(credentialFile, JSON.stringify(client, null, 2), { mode: 0o600 });
    check((statSync(credentialFile).mode & 0o777) === 0o600 && (statSync(privateDirectory).mode & 0o777) === 0o700, 'QA_PRIVATE_AUDIT_PERMISSIONS');
    store = new Store(stateFile);
    store.configurationService.update({ memory: { backend: 'openviking', endpoint: endpoint.origin, apiKey: key, autoStore: true, autoRecall: false } });
    const workspace = join(privateDirectory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const createdProject = store.createProject({ name: '隔离摘要补层验收', description: 'Controlled acceptance dialogue; real remote extraction and summaries.', workspace, initiative: { enabled: false } });
    projectId = createdProject.project.id; sessionId = createdProject.session.id;
    report.projectId = projectId; report.sessionId = sessionId;
    const identity = await store.memoryService.identity(store.memoryService.remote(projectId), { fresh: true });
    check(identity === client.user_id, 'QA_TENANT_IDENTITY_MISMATCH'); peerRoot = `viking://user/${identity}/peers/forge-${projectId}/memories`;
    return { credentialPrinted: false, userProjectModified: false, privateCredentialMode: '0600' };
  });
  await step('controlled_dialogue_enrolled_by_store', async () => {
    store.message(sessionId, { text: dialogue[0].content });
    turnId = store.state.sessions.find(row => row.id === sessionId).activeTurnId; report.turnId = turnId;
    // This is a deliberate input fixture, not a fabricated provider receipt.
    // Production enrollment is exercised while actual extraction stays real.
    store.mutate(state => {
      const session = state.sessions.find(row => row.id === sessionId), turn = session.turns.find(row => row.id === turnId);
      turn.modelConfig = { execution: 'rna' }; turn.acceptanceInput = 'controlled-dialogue-no-main-model';
      for (const message of dialogue.slice(1)) session.items.push({ id: randomUUID(), turnId, kind: message.role, text: message.content, acceptanceInput: true });
    });
    store.finishRuntimeTurn(sessionId, turnId);
    check(writeOf(store.state)?.status === 'pending' && !summaryOf(store.state), 'QA_OUTBOX_ENROLLMENT_FAILED');
    observe(); sync = new MemorySync(store, { pollMs: 2000 });
    return { status: writeOf(store.state).status, mainModelCalls: 0, messageCount: dialogue.length };
  });
  await step('real_commit_and_atomic_summary_enqueue', async () => {
    await pumpUntil(() => writeOf(store.state)?.status === 'completed');
    const write = writeOf(store.state), summary = summaryOf(store.state);
    check(write.memoriesExtracted > 0, 'QA_EXTRACTION_EMPTY');
    check(summary?.status === 'pending' && summary.lastSourceTaskId === write.taskId && summary.revision === 1 && summary.uri === peerRoot, 'QA_SUMMARY_NOT_ATOMICALLY_ENQUEUED');
    check(atomicObservations.length > 0 && atomicObservations.every(row => row.summarySourceTaskId === row.writeTaskId), 'QA_OBSERVER_SAW_INCOMPLETE_TRANSACTION');
    const disk = readStateFile(stateFile).state;
    check(writeOf(disk)?.status === 'completed' && summaryOf(disk)?.status === 'pending' && summaryOf(disk).lastSourceTaskId === write.taskId, 'QA_DURABLE_TRANSACTION_MISMATCH');
    check(!calls.some(row => row.path === '/api/v1/content/reindex'), 'QA_PREMATURE_REINDEX');
    report.extraction = { sessionId: write.sessionId, taskId: write.taskId, memoriesExtracted: write.memoriesExtracted, extractionCounts: write.extractionCounts, reportedTokenUsage: numericUsage(write.tokenUsage) };
    return { extracted: write.memoriesExtracted, transactionObservations: atomicObservations.length, diskConfirmed: true };
  });
  await step('restart_recovers_queued_summary_and_preserves_sources', async () => {
    report.before = await manifest();
    check(report.before.originals.some(row => row.matchedTopics.schedule || row.matchedTopics.accessibility), 'QA_EXTRACTED_CONTENT_NOT_RELEVANT');
    const id = summaryOf(store.state).id; unsubscribe(); await sync.close();
    store = new Store(stateFile); check(summaryOf(store.state)?.id === id && summaryOf(store.state).status === 'pending', 'QA_QUEUED_SUMMARY_LOST_ON_RESTART');
    observe(); sync = new MemorySync(store, { pollMs: 2000 });
    await pumpUntil(() => summaryOf(store.state)?.status === 'completed');
    const summary = summaryOf(store.state), result = summary.result;
    check(summary.verifiedRevision === 1 && summary.verification?.layers > 0 && result?.failedRecords === 0, 'QA_SUMMARY_COMPLETION_UNVERIFIED');
    const commits = calls.filter(row => row.method === 'POST' && row.path.endsWith('/commit')), reindexes = calls.filter(row => row.method === 'POST' && row.path === '/api/v1/content/reindex');
    check(commits.length === 1 && reindexes.length === 1 && reindexes[0].source === 'MemorySync', 'QA_DUPLICATE_OR_MANUAL_MUTATION');
    report.summary = { id: summary.id, taskId: summary.taskId, status: summary.status, revision: summary.revision, verifiedRevision: summary.verifiedRevision, verification: summary.verification, result };
    return { persistedPendingRecovered: true, commitRequests: commits.length, automaticReindexRequests: reindexes.length };
  });
  await step('independent_L0_L1_body_verification_and_L2_hashes', async () => {
    report.after = await manifest();
    assert.deepEqual(report.after.originals, report.before.originals, 'Original file hashes must stay unchanged');
    assert.deepEqual(report.after.directories, report.before.directories, 'Original directory scope must stay unchanged');
    report.layers = [];
    for (const uri of report.after.directories) for (const level of ['L0', 'L1']) {
      const read = await store.memoryService.read(projectId, { uri, level, maxChars: 64000 });
      check(typeof read.content === 'string' && read.content.trim() && !isMemoryDirectoryPlaceholder(read.content, uri), 'QA_SUMMARY_BODY_UNAVAILABLE');
      report.layers.push({ uri, level, chars: read.content.length, sha256: hash(read.content) });
    }
    check(report.layers.length === summaryOf(store.state).verification.layers, 'QA_LAYER_COUNT_MISMATCH');
    const health = memorySyncHealth(store.state); check(health.healthy && health.summaries.counts.completed === 1, 'QA_SYNC_HEALTH_NOT_CONFIRMED');
    const requestCount = calls.length, writes = store.persistence.writes;
    for (let i = 0; i < 100; i++) await Promise.all(sync.pump());
    check(calls.length === requestCount && store.persistence.writes === writes, 'QA_TERMINAL_IDLE_REPLAY');
    return { verifiedLayers: report.layers.length, originalsHashPreserved: report.after.originals.length, completedIdlePumps: 100, extraRequests: 0, extraStoreWrites: 0 };
  });
  report.ok = true;
} catch (error) { report.ok = false; report.error = safeFailure(error); }
finally {
  unsubscribe?.();
  try { await sync?.close(); } catch (error) { report.ok = false; report.cleanupError = safeFailure(error); }
  globalThis.fetch = nativeFetch;
  report.finishedAt = new Date().toISOString();
  report.retention = 'Independent QA tenant and private host state/credentials retained for audit; no existing tenant or production configuration changed.';
  mkdirSync(resolve(reportPath, '..'), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, passed: checks.filter(row => row.ok).length, report: reportPath, error: report.error ?? null }));
  if (!report.ok) process.exitCode = 1;
}
