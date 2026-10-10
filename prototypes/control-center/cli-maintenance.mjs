import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { maintenanceTerminal, formatMaintenanceStatus } from './presentation/maintenance-display.mjs';
import { cliError, cliLanguage, glossEn, say } from './cli-language.mjs';

const usage = 'maintenance status|prepare <本地目录>|backup|apply <候选ID>|rollback <候选ID>|restore <恢复点ID> --confirm|cancel <操作ID> [--json] [--request-id ID]';
const usageError = () => cliError(usage, glossEn(usage));
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export async function runMaintenanceCommand(args, call, { wait = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, timeoutMs = 30000 } = {}) {
  const positional = [], flags = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (!['--json', '--confirm', '--request-id'].includes(value) || Object.hasOwn(flags, value)) throw usageError();
    if (value === '--request-id') { const id = args[++index]; if (!identifier(id)) throw cliError('--request-id 需要有效 ID', '--request-id needs a valid ID'); flags[value] = id; }
    else flags[value] = true;
  }
  const [action = 'status', target] = positional;
  if (!['status', 'prepare', 'backup', 'apply', 'rollback', 'restore', 'cancel'].includes(action)) throw usageError();
  const needsTarget = ['prepare', 'apply', 'rollback', 'restore', 'cancel'].includes(action);
  if (positional.length > (needsTarget ? 2 : 1) || needsTarget && !target || !needsTarget && target || flags['--confirm'] && action !== 'restore' || action === 'status' && flags['--request-id']) throw usageError();
  if (action === 'restore' && !flags['--confirm']) throw cliError('恢复将替换本机应用状态；项目目录和远端记忆不回滚，恢复后保持急停。核对具体恢复点后使用 restore <恢复点ID> --confirm。', 'Restore replaces the local app state; project directories and remote memory are not rolled back, and the emergency stop stays on afterwards. Check the specific recovery point, then use restore <recovery point ID> --confirm.');
  if (needsTarget && action !== 'prepare' && !identifier(target)) throw cliError('维护对象 ID 无效', 'The maintenance target ID is invalid');
  if (action === 'status') return { json: !!flags['--json'], state: await call('/maintenance') };
  const requestId = flags['--request-id'] ?? randomUUID(), body = { requestId };
  if (action === 'prepare') body.source = resolve(target);
  else if (action === 'apply' || action === 'rollback') body.candidateId = target;
  else if (action === 'restore') body.checkpointId = target;
  else if (action === 'cancel') body.operationId = target;
  let receipt;
  try { receipt = await call(`/maintenance/${action}`, 'POST', body); }
  catch (error) { throw cliError(`${error.message}。请求 ID：${requestId}；先运行 maintenance status 核对，不要以新请求 ID 重复提交。`, `${error.message}. Request ID: ${requestId}; run maintenance status to check first, and do not resubmit with a new request ID.`); }
  const operationId = receipt.operation?.id ?? receipt.id, deadline = now() + timeoutMs;
  let state, disconnected = false;
  do {
    try {
      state = await call('/maintenance'); disconnected = false;
      const own = state.operation?.id === operationId ? state.operation : state.history?.find(row => row.id === operationId);
      if (own && maintenanceTerminal(own)) return { json: !!flags['--json'], state, receipt: { requestId, operationId, phase: own.phase }, completed: own.phase === 'completed', failed: ['failed', 'recovery_required'].includes(own.phase) };
    } catch { disconnected = true; }
    if (now() >= deadline) break;
    await wait(1000);
  } while (now() <= deadline);
  return { json: !!flags['--json'], state, receipt: { requestId, operationId }, pending: true, disconnected };
}
export function maintenanceCommandText(result) {
  const lines = result.state ? [formatMaintenanceStatus(result.state, cliLanguage())] : [];
  if (result.pending) lines.push(result.disconnected ? say('服务正在重新连接，结果尚未确认；运行 maintenance status 查看。', 'The service is reconnecting and the result is not confirmed yet; run maintenance status to check.') : say('请求仍在处理或等待安全空闲；退出 CLI 不取消操作，运行 maintenance status 查看。', 'The request is still being processed or waiting for a safe idle moment; leaving the CLI does not cancel it, run maintenance status to check.'));
  if (result.receipt) lines.push(say(`请求 ID：${result.receipt.requestId}${result.receipt.operationId ? ` · 操作 ID：${result.receipt.operationId}` : ''}`, `Request ID: ${result.receipt.requestId}${result.receipt.operationId ? ` · Operation ID: ${result.receipt.operationId}` : ''}`));
  return lines.join('\n');
}
