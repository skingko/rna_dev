import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runMaintenanceCommand, maintenanceCommandText } from '../cli-maintenance.mjs';
import { maintenanceCancellable, maintenanceOperationDisplay, formatMaintenanceStatus, formatMaintenanceAttemptHistory } from '../presentation/maintenance-display.mjs';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const state = () => ({ current: { hostVersion: '0.15.0', sdkVersion: '0.9.0' }, capabilities: { prepare: true, backup: true, apply: true, restore: true, rollback: true }, busy: false, held: false, operation: null, history: [], candidates: [{ id: 'candidate-1', hostVersion: '0.15.0', sdkVersion: '0.9.0' }], checkpoints: [{ id: 'checkpoint-1', createdAt: '2026-09-27T00:00:00Z', verified: true }] });

test('maintenance CLI validates all destructive targets and restore confirmation before making any request', async () => {
  const calls = [], call = async (...args) => { calls.push(args); return state(); };
  for (const args of [['oops'], ['apply'], ['apply', '../outside'], ['restore', 'checkpoint-1'], ['backup', '--confirm'], ['status', 'extra'], ['status', '--request-id', 'r'], ['backup', '--json', '--json'], ['prepare'], ['backup', '--unknown'], ['cancel', 'a/b'], ['backup', '--request-id']]) await assert.rejects(runMaintenanceCommand(args, call));
  assert.equal(calls.length, 0);
});
test('maintenance submission reuses explicit request IDs and polls without replay after reconnection', async () => {
  const calls = []; let reads = 0, clock = 0;
  const call = async (...args) => { calls.push(args); if (args[1] === 'POST') return { id: 'operation-1', phase: 'waiting_idle' }; if (++reads === 1) throw Error('restart'); return { ...state(), operation: { id: 'operation-1', kind: 'apply', phase: 'completed' } }; };
  const result = await runMaintenanceCommand(['apply', 'candidate-1', '--request-id', 'stable-1'], call, { now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(result.completed, true); assert.equal(calls.filter(row => row[1] === 'POST').length, 1); assert.deepEqual(calls[0], ['/maintenance/apply', 'POST', { requestId: 'stable-1', candidateId: 'candidate-1' }]); assert.equal(reads, 2);
});
test('pending and uncertain submission never masquerade as completion; failed and recovery-required return failure', async () => {
  const call = async (_path, method) => method === 'POST' ? { operation: { id: 'operation-1' } } : { ...state(), operation: { id: 'operation-1', phase: 'waiting_idle', kind: 'backup' } };
  const result = await runMaintenanceCommand(['backup'], call, { timeoutMs: 0 }); assert.equal(result.pending, true); assert.equal(result.completed, undefined); assert.match(maintenanceCommandText(result), /退出 CLI 不取消/);
  let writes = 0; await assert.rejects(runMaintenanceCommand(['backup', '--request-id', 'stable-2'], async () => { writes++; throw Error('connection lost'); }), /stable-2.*先运行 maintenance status/); assert.equal(writes, 1);
  for (const phase of ['failed', 'recovery_required']) { const result = await runMaintenanceCommand(['backup'], async (_path, method) => method === 'POST' ? { id: 'op' } : { ...state(), operation: { id: 'op', phase } }); assert.equal(result.failed, true); assert.equal(result.completed, false); }
});
test('maintenance results retain own history when another client starts a newer operation', async () => {
  const result = await runMaintenanceCommand(['backup'], async (_path, method) => method === 'POST' ? { id: 'own' } : { ...state(), operation: { id: 'other', phase: 'preparing' }, history: [{ id: 'own', phase: 'completed' }] }); assert.equal(result.completed, true); assert.equal(result.receipt.operationId, 'own');
});
test('maintenance presentation only permits cancelling waiting_idle, treats recovery_required explicitly, and strips terminal controls', () => {
  for (const phase of ['preparing', 'draining', 'checkpointing', 'stopping', 'offline', 'switching', 'verifying', 'completed', 'failed', 'cancelled', 'recovery_required', 'waiting']) assert.equal(maintenanceCancellable({ phase }), false);
  assert.equal(maintenanceCancellable({ phase: 'waiting_idle' }), true); assert.match(maintenanceOperationDisplay({ kind: 'restore', phase: 'recovery_required' }).title, /需要核对/);
  assert.doesNotMatch(formatMaintenanceStatus({ ...state(), operation: { summary: 'secret\u009bclear', id: 'id\u001b' } }), /[\u001b\u009b]/);
});
test('actual CLI supports ten application-level maintenance commands through the shared host API', async t => {
  const snapshot = state(), calls = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    // The interface-language probe (GET /api/health) is not a command request: `calls` is what the command itself sent.
    if (request.url !== '/api/health') calls.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null }); response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') { snapshot.operation = { id: `operation-${calls.length}`, kind: request.url.split('/').at(-1), phase: 'completed', summary: 'completed\u009b' }; response.end(JSON.stringify(snapshot.operation)); }
    else response.end(JSON.stringify(snapshot));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (...args) => exec(process.execPath, [cli, 'maintenance', ...args], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 });
  const commands = [['status'], ['status', '--json'], ['prepare', '/tmp/Rna Agent.app'], ['backup'], ['apply', 'candidate-1', '--request-id', 'stable-3'], ['rollback', 'candidate-1'], ['restore', 'checkpoint-1', '--confirm'], ['cancel', 'operation-1'], ['backup', '--json'], ['status']];
  const results = []; for (const args of commands) results.push(await run(...args));
  assert.ok(results.every(value => value.stderr === '')); assert.match(results[0].stdout, /Rna Agent 0.15.0/); assert.equal(JSON.parse(results[1].stdout).state.current.sdkVersion, '0.9.0'); assert.equal(JSON.parse(results[8].stdout).completed, true); assert.equal(results[8].stdout.includes('\u009b'), false);
  const writes = calls.filter(row => row.method === 'POST'); assert.equal(writes.length, 7); assert.equal(writes[0].body.source, '/tmp/Rna Agent.app'); assert.deepEqual(writes.find(row => row.path.endsWith('/apply')).body, { requestId: 'stable-3', candidateId: 'candidate-1' }); assert.equal(writes.find(row => row.path.endsWith('/restore')).body.checkpointId, 'checkpoint-1');
  const before = calls.length; await assert.rejects(run('restore', 'checkpoint-1'), error => error.code === 1 && /--confirm/.test(error.stderr)); assert.equal(calls.length, before);
  const help = await exec(process.execPath, [cli, 'help', 'all']); assert.match(help.stdout, /maintenance restore/); assert.match(help.stdout, /恢复后急停/);
});

test('question handoff is concise and consistent across current status, legacy waiting, recovery and history', () => {
  const legacy = { kind: 'apply', phase: 'waiting_idle', questionHandoff: { capability: 'unsupported', phase: 'waiting_legacy' } };
  const display = maintenanceOperationDisplay(legacy);
  assert.equal(display.terminal, false); assert.equal(display.cancellable, true); assert.match(display.handoff, /旧服务不支持自动交接.*仍在等待/); assert.doesNotMatch(display.handoff, /失败|已完成/);
  assert.match(formatMaintenanceStatus({ ...state(), held: true, operation: legacy }), new RegExp(display.handoff));
  const saved = { ...legacy, questionHandoff: { capability: 'supported', suspended: 2, blocked: 0 } };
  assert.match(maintenanceOperationDisplay(saved).handoff, /已保留 2 个待答问题.*原问题接续/);
  assert.match(maintenanceOperationDisplay({ ...saved, phase: 'recovery_required' }).handoff, /暂不自动接续/);
  const completed = maintenanceOperationDisplay({ ...saved, phase: 'completed' }).handoff;
  assert.match(completed, /本次保留了 2.*以原会话为准/); assert.doesNotMatch(completed, /已重新接续|已经恢复|正在等待/);
  assert.doesNotMatch(maintenanceOperationDisplay({ ...legacy, phase: 'failed' }).handoff, /仍在等待/);
  assert.match(maintenanceOperationDisplay({ ...saved, questionHandoff: { capability: 'supported', suspended: 0, blocked: 3 } }).handoff, /3 个会话.*等待安全交接/);
  for (const value of ['<script>', -1, 0.1, Infinity, NaN]) assert.equal(maintenanceOperationDisplay({ ...saved, questionHandoff: { capability: 'supported', suspended: value, blocked: value } }).handoff, '');
  assert.equal(maintenanceOperationDisplay({ ...saved, questionHandoff: { capability: 'unknown', suspended: 2 } }).handoff, '');
});

test('actual CLI status presents waiting legacy handoff and saved questions without adding commands', async t => {
  const snapshot = state(); snapshot.held = true; snapshot.operation = { id: 'question-maintenance', kind: 'apply', phase: 'waiting_idle', questionHandoff: { capability: 'unsupported', phase: 'waiting_legacy' } };
  // `calls` is what the command itself sent; the interface-language probe (GET /api/health) is not a command request.
  const calls = [], server = createServer((request, response) => { if (request.url !== '/api/health') calls.push([request.method, request.url]); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(snapshot)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const run = () => exec(process.execPath, [cli, 'maintenance', 'status'], { env: { ...process.env, RNA_AGENT_PORT: String(server.address().port) }, timeout: 10000 });
  const legacy = await run(); assert.match(legacy.stdout, /旧服务不支持自动交接.*仍在等待/); assert.equal(legacy.stderr, '');
  snapshot.operation.questionHandoff = { capability: 'supported', suspended: 1, blocked: 0 };
  const saved = await run(); assert.match(saved.stdout, /已保留 1 个待答问题.*原问题接续/); assert.equal(saved.stderr, '');
  assert.deepEqual(calls, [['GET', '/api/maintenance'], ['GET', '/api/maintenance']]);
});

test('maintenance phase history shows a failed receipt and successful read-only reconciliation separately', () => {
  const operation = { attemptCount: 2, attempts: [{ number: 2, status: 'completed', elapsedMs: 36850, stages: [
    { name: 'start', status: 'unconfirmed', elapsedMs: 35100, failureType: 'command_exit_nonzero' },
    { name: 'verify_successor', status: 'completed', elapsedMs: 1700, reconciled: true },
    { name: 'untrusted-stage', status: 'failed', failureType: '/private/secret' },
  ] }] };
  const text = formatMaintenanceAttemptHistory(operation);
  assert.match(text, /已记录 2 次执行.*展示最近 1 次/); assert.match(text, /发出启动请求 · 回执未确认 · 35.1 秒/);
  assert.match(text, /核对已启动服务 · 完成 · 1.7 秒 · 已核对迟到的启动结果/);
  assert.doesNotMatch(text, /untrusted-stage|private/); assert.ok(formatMaintenanceStatus({ ...state(), operation }).includes(text));
});
