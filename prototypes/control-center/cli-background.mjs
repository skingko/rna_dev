import { randomUUID } from 'node:crypto';
import { cliError, glossEn, languageReady, say } from './cli-language.mjs';

const operations = ['pause', 'resume', 'stop', 'steer'];
const identity = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/.test(value)) throw cliError(`${name} 缺失或格式有误；请使用完整 ID`, `${glossEn(name)} is missing or malformed; use the full ID`);
  return value;
};
export function parseBackgroundArgs(values) {
  const positional = [], flags = {};
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (!['json', 'text', 'request-id', 'revision'].includes(key) || Object.hasOwn(flags, key)) throw cliError(`不支持或重复的后台操作选项：${value}`, `Unsupported or duplicated background option: ${value}`);
    if (key === 'json') flags[key] = true;
    else { if (!values[i + 1] || values[i + 1].startsWith('--')) throw cliError(`${value} 缺少值`, `${value} needs a value`); flags[key] = values[++i]; }
  }
  const [projectId, action = 'list', actionId, ...extra] = positional;
  identity(projectId, '项目 ID');
  if (extra.length || !['list', ...operations].includes(action)) throw cliError('用法：background <项目ID> [list|pause|resume|stop|steer] [完整行动ID] [--text 调整内容] [--json]', 'Usage: background <project ID> [list|pause|resume|stop|steer] [full action ID] [--text adjustment] [--json]');
  if (action === 'list') {
    if (actionId || ['text', 'request-id', 'revision'].some(key => flags[key] !== undefined)) throw cliError('list 不接受行动 ID 或控制参数', 'list takes no action ID or control arguments');
  } else identity(actionId, '后台行动 ID');
  if (action === 'steer' ? !flags.text?.trim() : flags.text !== undefined) throw cliError('steer 必须提供 --text 调整内容；其他操作不接受 --text', 'steer needs --text with the adjustment; the other operations do not accept --text');
  if (flags.text?.trim().length > 4000 || flags.text?.includes('\0')) throw cliError('调整内容最多 4000 字符，不能包含空字符', 'The adjustment is at most 4000 characters and cannot contain a null character');
  if (flags['request-id'] !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(flags['request-id'])) throw cliError('--request-id 格式有误（最多 128 字符）', '--request-id is malformed (at most 128 characters)');
  if (flags.revision !== undefined && (!/^\d+$/.test(flags.revision) || !Number.isSafeInteger(Number(flags.revision)))) throw cliError('--revision 必须是非负整数', '--revision must be a non-negative integer');
  return { projectId, action, actionId, json: flags.json === true, ...(flags.text ? { text: flags.text.trim() } : {}), ...(flags['request-id'] ? { requestId: flags['request-id'] } : {}), ...(flags.revision !== undefined ? { expectedRevision: Number(flags.revision) } : {}) };
}

const STATUS = { queued: ['等待执行', 'Waiting to run'], running: ['执行中', 'Running'], paused: ['已暂停', 'Paused'], cancelled: ['已取消', 'Cancelled'], completed: ['已结束', 'Finished'], failed: ['未完成', 'Not completed'], interrupted: ['已中断', 'Interrupted'], needs_review: ['结果待核对', 'Result awaiting review'] };
/** The status of an action as a [Chinese, English] pair, for text that is built before the language is shown. */
function backgroundStatusPair(action) {
  const pending = action.status === 'running' && [...(action.controls ?? [])].reverse().find(control => control.status === 'pending' && ['pause', 'cancel'].includes(control.kind));
  if (pending) return pending.kind === 'pause' ? ['正在暂停', 'Pausing'] : ['正在停止', 'Stopping'];
  if (action.status === 'cancelled' && action.controls?.some(control => control.kind === 'cancel' && control.status === 'applied')) return ['已停止', 'Stopped'];
  return STATUS[action.status] ?? ['状态未知', 'Status unknown'];
}
export function backgroundStatus(action) {
  return say(...backgroundStatusPair(action));
}
export function backgroundTable(actions = []) {
  const [status, work, available] = say('状态|工作|可用操作', 'Status|Work|Available actions').split('|');
  return actions.map(action => ({ ID: action.id, [status]: backgroundStatus(action), [work]: String(action.label ?? action.content ?? '').replace(/\s+/g, ' ').slice(0, 100), [available]: (action.availableControls ?? []).join(' / ') || '—' }));
}

export async function runBackgroundCommand(values, call) {
  const input = parseBackgroundArgs(values), path = `/projects/${input.projectId}/initiative/actions`;
  // Text (the table, the receipt line) is built in the interface language; the JSON form has none.
  if (!input.json) await languageReady();
  const snapshot = await call(path);
  if (input.action === 'list') return { json: input.json, result: snapshot, rows: backgroundTable(snapshot.actions) };
  const current = snapshot.actions?.find(action => action.id === input.actionId);
  if (!current) throw cliError('后台行动不存在；请先使用 background <项目ID> list 查看完整 ID', 'The background action does not exist; run background <project ID> list first to see the full ID');
  // A supplied id + revision is an explicit retry of the original durable
  // request. Let the host deduplicate it even if its current state has advanced.
  if (!(input.requestId && input.expectedRevision !== undefined) && !current.availableControls?.includes(input.action)) throw cliError(`此行动当前不能 ${input.action}；状态：${backgroundStatusPair(current)[0]}`, `This action cannot ${input.action} right now; status: ${backgroundStatusPair(current)[1]}`);
  const payload = { action: input.action, requestId: input.requestId ?? randomUUID(), expectedRevision: input.expectedRevision ?? current.controlRevision, ...(input.text ? { text: input.text } : {}) };
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) throw cliError('服务未提供有效控制版本；请刷新后台行动后再试', 'The service gave no valid control revision; refresh the background actions and try again');
  try {
    const result = await call(`${path}/${input.actionId}/control`, 'POST', payload);
    return { json: input.json, result, message: say(`后台行动 ${input.actionId} · ${backgroundStatusPair(result.action ?? current)[0]}${result.receipt?.status === 'rejected' ? ` · 操作未执行：${result.receipt.summary ?? '请查看执行记录'}` : input.action === 'steer' ? ' · 调整已提交，以处理回执为准' : ''}`, `Background action ${input.actionId} · ${backgroundStatusPair(result.action ?? current)[1]}${result.receipt?.status === 'rejected' ? ` · Not executed: ${result.receipt.summary ?? 'see the execution record'}` : input.action === 'steer' ? ' · Adjustment submitted; the receipt is authoritative' : ''}`) };
  } catch (error) {
    if (error.status === 409 || error.status === 404) throw cliError(`${error.message}\n后台状态已变化，请查看最新状态后再选择操作。`, `${error.message}\nThe background state has changed; check the latest state before choosing an operation.`, { cause: error });
    const failure = cliError(`${error.message}\n请先查看行动状态。若重试同一操作，请保留 --request-id ${payload.requestId} --revision ${payload.expectedRevision}；不会自动重新发送。`, `${error.message}\nCheck the action state first. To retry the same operation, keep --request-id ${payload.requestId} --revision ${payload.expectedRevision}; it is not resent automatically.`, { cause: error });
    failure.backgroundRetry = { actionId: input.actionId, arguments: [input.projectId, input.action, input.actionId, '--request-id', payload.requestId, '--revision', String(payload.expectedRevision), ...(input.text ? ['--text', input.text] : []), ...(input.json ? ['--json'] : [])] };
    throw failure;
  }
}

export function printBackgroundResult(value) {
  if (value.json) console.log(JSON.stringify(value.result, null, 2));
  else if (value.rows) { if (value.rows.length) console.table(value.rows); else console.log(say('暂无后台行动。', 'No background actions.')); }
  else console.log(value.message);
}
