#!/usr/bin/env node
// Isolated acceptance against a real OpenViking service. This never commits a
// session, calls a paid model, or selects an existing tenant/project/session.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../prototypes/control-center/store.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--endpoint', '--server-config', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid acceptance option');
  options[args[i].slice(2)] = args[i + 1];
}
const endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:1933');
assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && endpoint.pathname === '/' && !endpoint.username && !endpoint.password && !endpoint.search);
let config;
try { config = JSON.parse(readFileSync(resolve(options['server-config'] ?? join(root, 'deploy/openviking/.runtime/semantic/ov.conf')), 'utf8')); }
catch { throw new Error('Private deployment configuration unavailable'); }
assert.equal(typeof config.server?.root_api_key, 'string');
const runId = randomUUID(), accountId = `rna-delete-qa-${runId.slice(0, 12)}`, userId = 'deletion-verifier';
const directory = mkdtempSync(join(tmpdir(), 'rna-real-session-delete-')), store = new Store(join(directory, 'state.json'));
const reportPath = resolve(options.report ?? join(root, 'prototypes/control-center/qa/openviking-session-deletion-report.json'));
const report = { schemaVersion: 1, runId, accountId, endpoint: endpoint.origin, startedAt: new Date().toISOString(), checks: [], requests: [],
  scope: 'New isolated QA tenant; artificial chat only; production MemoryService deletion method; no session commit or paid model call',
  limitations: ['No real extraction task was created; active-task cancellation remains covered by HTTP fixtures.', 'No extracted memory was generated; preservation is checked with project resource content and peer-memory directory.', 'This validates remote deletion, not removal from backups or all local private projections.'] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(typeof url === 'string' ? url : url.url ?? String(url));
  if (target.origin !== endpoint.origin || /\/(?:commit|reindex|completions)(?:\/|$)/.test(target.pathname)) throw new Error('Acceptance request blocked by no-model/no-commit guard');
  if (target.pathname === '/api/v1/content/write' && JSON.parse(init.body ?? '{}').processing_mode !== 'vectors_only') throw new Error('Only explicit vectors_only writes are allowed');
  const row = { method: init.method ?? 'GET', path: target.pathname }; report.requests.push(row);
  const response = await originalFetch(url, init); row.status = response.status; return response;
};
let client, project, localSession, binding, record;
const digest = value => createHash('sha256').update(value).digest('hex');
async function request(path, { method = 'GET', body, rootKey = false, allow404 = false, actor = true } = {}) {
  const response = await fetch(`${endpoint.origin}${path}`, { method, headers: { 'content-type': 'application/json', 'X-API-Key': rootKey ? config.server.root_api_key : client.api_key, ...(actor && project ? { 'X-OpenViking-Actor-Peer': `forge-${project.id}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  if (allow404 && response.status === 404) return { notFound: true };
  if (!response.ok) throw Object.assign(new Error('QA_API_HTTP_ERROR'), { code: `QA_HTTP_${response.status}` });
  const envelope = await response.json(); assert.equal(envelope.status, 'ok'); return envelope.result;
}
async function check(name, fn) {
  const start = Date.now();
  try { const details = await fn(); report.checks.push({ name, ok: true, elapsedMs: Date.now() - start, details }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, ok: false, elapsedMs: Date.now() - start, code: /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'QA_CHECK_FAILED' }); console.error(`FAIL ${name}`); throw error; }
}
try {
  await check('new isolated tenant and temporary Rna state', async () => {
    const created = await request('/api/v1/admin/accounts', { method: 'POST', rootKey: true, actor: false, body: { account_id: accountId, admin_user_id: userId } });
    const key = created.user_key ?? created.admin_api_key ?? created.api_key; assert.ok(typeof key === 'string' && key.length > 0);
    client = { endpoint: endpoint.origin, account_id: accountId, user_id: userId, api_key: key };
    const audit = join(root, 'deploy/openviking/.runtime/semantic/qa'); mkdirSync(audit, { recursive: true, mode: 0o700 });
    writeFileSync(join(audit, `delete-${runId}.json`), JSON.stringify(client), { mode: 0o600 });
    store.configurationService.update({ memory: { backend: 'openviking', endpoint: endpoint.origin, apiKey: key } });
    const createdProject = store.createProject({ name: 'Isolated session deletion acceptance', description: 'Artificial data only; no model initialization.' }); project = createdProject.project; localSession = createdProject.session;
    report.projectId = project.id; report.localSessionId = localSession.id;
    return { newTenant: true, temporaryState: true, credentialPrinted: false };
  });
  let resourceUri, expectedHash, peerMemoryUri;
  await check('create project resource without semantic generation and verify raw content', async () => {
    await store.memoryService.initialize(project.id);
    const remote = store.memoryService.remote(project.id), identity = await store.memoryService.identity(remote);
    resourceUri = `${remote.namespace}/preserved-qa-resource.md`;
    const content = 'Artificial deletion acceptance resource. Session deletion must preserve this independent project document.'; expectedHash = digest(content);
    await request('/api/v1/content/write', { method: 'POST', body: { uri: resourceUri, content, mode: 'create', wait: true, timeout: 30, processing_mode: 'vectors_only' } });
    assert.equal(digest(await request(`/api/v1/content/read?${new URLSearchParams({ uri: resourceUri })}`)), expectedHash);
    peerMemoryUri = `viking://user/${identity}/peers/forge-${project.id}/memories`;
    await request('/api/v1/fs/mkdir', { method: 'POST', body: { uri: peerMemoryUri } });
    report.resource = { uri: resourceUri, sha256: expectedHash }; report.peerMemoryUri = peerMemoryUri;
    return { processingMode: 'vectors_only', externalVlmRequested: false, projectResourceCreated: true, peerMemoryDirectoryCreated: true };
  });
  await check('real session identity, append and task pagination shapes match the adapter', async () => {
    binding = await store.memoryService.createSession(project.id, { sourceSessionId: localSession.id }); report.remoteSessionId = binding.sessionId;
    await store.memoryService.sessionMessages(project.id, binding.sessionId, { messages: [{ role: 'user', content: 'Artificial isolated QA message for deletion. This is not user conversation data.' }, { role: 'assistant', content: 'Artificial QA acknowledgement; no extraction requested.' }] });
    const session = await request(`/api/v1/sessions/${binding.sessionId}`);
    assert.equal(session.session_id, binding.sessionId); assert.equal(session.user.user_id, binding.userId); assert.equal(session.uri, `viking://user/${binding.userId}/sessions/${binding.sessionId}`); assert.equal(session.auto_commit_policy, null);
    const tasks = await request(`/api/v1/tasks?${new URLSearchParams({ task_type: 'session_commit', resource_id: binding.sessionId, pagination: 'cursor', limit: '200' })}`);
    assert.ok(Array.isArray(tasks.items)); assert.equal(tasks.items.length, 0); assert.equal(tasks.has_more, false);
    const info = await request(`/api/v1/fs/stat?${new URLSearchParams({ uri: session.uri })}`); assert.equal(info.isDir, true);
    return { verifiedUser: true, canonicalSessionUri: true, autoCommitDisabled: true, taskList: { items: tasks.items.length, hasMore: tasks.has_more, nextCursor: tasks.next_cursor ?? null }, sessionDirectoryPresent: true };
  });
  await check('production MemoryService deletes real remote chat and directory', async () => {
    store.deleteSession(localSession.id); record = store.state.sessionDeletions.find(row => row.sessionId === localSession.id); assert.equal(record.bindings.length, 1);
    const result = await store.memoryService.deleteSessionArchive(record, record.bindings[0]); assert.equal(result.deleted, true);
    assert.equal((await request(`/api/v1/sessions/${binding.sessionId}`, { allow404: true })).notFound, true);
    assert.equal((await request(`/api/v1/fs/stat?${new URLSearchParams({ uri: `viking://user/${binding.userId}/sessions/${binding.sessionId}` })}`, { allow404: true })).notFound, true);
    return { remoteSession404: true, canonicalDirectory404: true, adapterDeleted: true };
  });
  await check('repeated real deletion is 404-idempotent and preserves project resource', async () => {
    const result = await store.memoryService.deleteSessionArchive(record, record.bindings[0]); assert.equal(result.deleted, true);
    assert.equal(digest(await request(`/api/v1/content/read?${new URLSearchParams({ uri: resourceUri })}`)), expectedHash);
    assert.equal((await request(`/api/v1/fs/stat?${new URLSearchParams({ uri: peerMemoryUri })}`)).isDir, true);
    const deletions = report.requests.filter(row => row.method === 'DELETE'); assert.equal(deletions.length, 2); assert.ok(deletions.every(row => row.path === `/api/v1/sessions/${binding.sessionId}`));
    return { deleteStatuses: deletions.map(row => row.status), resourceHashUnchanged: true, peerMemoryDirectoryPresent: true, deleteTargetOnlyNewQaSession: true };
  });
} catch { process.exitCode = 1; }
finally {
  globalThis.fetch = originalFetch;
  report.finishedAt = new Date().toISOString(); report.passed = report.checks.length === 5 && report.checks.every(row => row.ok);
  report.noSessionCommitRequested = !report.requests.some(row => /\/commit$/.test(row.path));
  mkdirSync(resolve(reportPath, '..'), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.filter(row => row.ok).length, total: report.checks.length, reportPath }));
}
