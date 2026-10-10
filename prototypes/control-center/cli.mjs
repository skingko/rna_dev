#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { followSession, sessionRecord } from './cli-stream.mjs';
import { completeCommand, createLineQueue, incrementalItem } from './cli-interactive.mjs';
import { printCliHelp } from './cli-help.mjs';
import { cliError, errorReady, errorText, glossEn, languageReady, say, useDaemonLanguage } from './cli-language.mjs';
import { runBackgroundCommand, printBackgroundResult } from './cli-background.mjs';
import { readFileSync, realpathSync, statSync, writeFileSync , createReadStream } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createCliPresence } from './cli-presence.mjs';
import { PROJECT_SCHEDULE_PRESETS } from './project-proactivity.mjs';
import { formatObservationSources } from './presentation/observation-source-display.mjs';
import { formatVersionList, formatVersionDetail } from './cli-evaluation.mjs';
import { formatDecisionStatus } from './decision-observability.mjs';
import { runMaintenanceCommand, maintenanceCommandText } from './cli-maintenance.mjs';
import { runRetentionCli, retentionText } from './maintenance-retention.mjs';
import { runJournalCompactionCli, journalCompactionText } from './journal-maintenance.mjs';
import { runEffortCommand } from './cli-effort.mjs';
import { runScheduleTextCommand } from './cli-schedule-text.mjs';
import { runCompactionCommand } from './cli-compaction.mjs';
import { evolutionSection } from './cli-evolution.mjs';

const terminalJson = (...args) => JSON.stringify(...args)?.replace(/[\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const [rawCommand = 'help', ...args] = process.argv.slice(2);
const command = ['-h','--help'].includes(rawCommand) ? 'help' : rawCommand;
const base = `http://127.0.0.1:${process.env.RNA_AGENT_PORT ?? process.env.PI_FORGE_PORT ?? 4317}`;
// The text this CLI prints itself follows the interface language the daemon holds (cli-language.mjs); a command that
// prints only the daemon's JSON never asks for it.
useDaemonLanguage({ base });
async function call(path, method = 'GET', data) {
  const response = await fetch(`${base}/api${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code }); return result;
}
const commandCall = (id, command, args = {}) => call(`/sessions/${identifier(id, '会话 ID')}/commands`, 'POST', { command, args, requestId: randomUUID() });
async function upload(id, path) {
  identifier(id, '会话 ID'); const file = resolve(path), info = statSync(file);
  if (!info.isFile()) throw cliError('附件必须为普通文件', 'The attachment must be a regular file');
  const response = await fetch(`${base}/api/sessions/${id}/attachments?name=${encodeURIComponent(basename(file))}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: createReadStream(file), duplex: 'half' });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code }); return result;
}
async function exportSession(id, path) {
  identifier(id, '会话 ID'); const response = await fetch(`${base}/api/sessions/${id}/export.zip`);
  if (!response.ok) throw new Error((await response.json()).error);
  const file = resolve(path); writeFileSync(file, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
  return { file, exported: true };
}
function workspace(value) {
  const path = realpathSync(resolve(value)); if (!statSync(path).isDirectory()) throw cliError('--workspace 必须指向现有目录', '--workspace must point to an existing directory'); return path;
}
function inputFile(value, json = false) {
  const path = resolve(value); if (!statSync(path).isFile() || statSync(path).size > 60000) throw cliError('配置或内容文件必须为不超过 60 KB 的普通文件', 'The configuration or content file must be a regular file of at most 60 KB');
  const content = readFileSync(path, 'utf8'); if (!json) return content;
  try { const value = JSON.parse(content); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw cliError('配置文件必须包含有效 JSON 对象', 'The configuration file must contain a valid JSON object'); }
}
// watch, run and chat follow the conversation over the v2 stream (cli-stream.mjs): the tail window once, then only
// what changed. `onUpdate(session, changedItemIds, { maintenance })`; a `state` JSONL line is
// { type, revision, maintenance, session } with the items the CLI holds (the tail window and everything after it) and
// the maintenance gate, as the old whole-state stream's lines were.
async function consumeStream(id, onUpdate, signal) {
  return followSession({ base, sessionId: id, onUpdate, signal,
    onConnection: info => { void languageReady().then(() => { if (info.state === 'connected') console.error(say('事件流已重新连接；已恢复最新会话。', 'The event stream reconnected; the latest session is restored.')); else console.error(say(`连接暂时中断，${Math.ceil(info.delayMs / 1000)} 秒后重连；后台会话继续保留。`, `The connection was interrupted; reconnecting in ${Math.ceil(info.delayMs / 1000)} s. The background session is kept.`)); }); } });
}
const stateLine = (session, { maintenance = null } = {}) => terminalJson({ type: 'state', revision: session.revision, maintenance, session });
/** Prints what changed in `ids` (every item when null), in conversation order, each once and then by increments. */
function printChanged(session, ids, shown, skip = () => false, print = printItem) {
  const wanted = ids ? new Set(ids) : null;
  for (const item of session.items) {
    if (wanted && !wanted.has(item.id) || skip(item)) continue;
    const changed = incrementalItem(shown.get(item.id), item);
    if (changed) print(changed);
    shown.set(item.id, structuredClone(item));
  }
}
async function watchSession(id, jsonl = false) {
  identifier(id, '会话 ID'); if (!jsonl) await languageReady(); const abort = new AbortController(), shown = new Map();
  const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await consumeStream(id, (session, ids, extra) => { if (jsonl) console.log(stateLine(session, extra)); else printChanged(session, ids, shown); }, abort.signal); }
  catch (error) { if (!abort.signal.aborted) throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
async function runSession(values) {
  const parsed = options(values, { jsonl: 'flag', timeout: 'value' }); count(parsed.positional, 2, Infinity, 'run <会话ID> <内容> [--jsonl] [--timeout 秒]');
  const [id, ...words] = parsed.positional; identifier(id, '会话 ID');
  const seconds = Number(parsed.timeout ?? 300); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw cliError('--timeout 必须为大于 0 且不超过 86400 的秒数', '--timeout must be a number of seconds greater than 0 and at most 86400');
  if (!parsed.jsonl) await languageReady();
  const accepted = await call(`/sessions/${id}/messages`, 'POST', { text: words.join(' '), delivery: 'followup', requestId: randomUUID() });
  const submissionId = accepted.entry.id, abort = new AbortController(), shown = new Map(); let timedOut = false, turnId = accepted.queued ? null : accepted.session.activeTurnId, outcome;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, seconds * 1000);
  const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (parsed.jsonl) console.log(terminalJson({ type: 'accepted', sessionId: id, submissionId, queued: accepted.queued }));
  try {
    await consumeStream(id, (session, _ids, extra) => {
      if (!turnId) { const prompt = session.items.find(item => item.submissionId === submissionId); turnId = session.turns.find(turn => turn.userItemId === prompt?.id)?.id ?? null; }
      if (parsed.jsonl) console.log(stateLine(session, extra));
      else if (turnId) for (const item of session.items.filter(item => item.turnId === turnId)) { const changed = incrementalItem(shown.get(item.id), item); if (changed) printItem(changed); shown.set(item.id, structuredClone(item)); }
      const turn = session.turns.find(turn => turn.id === turnId);
      if (turn && ['completed', 'failed', 'stopped'].includes(turn.status)) { outcome = { type: 'result', sessionId: id, turnId, status: turn.status }; if (parsed.jsonl) console.log(terminalJson(outcome)); return false; }
      if (!turnId && !(session.inbox ?? []).some(item => item.id === submissionId) && session.items.some(item => item.recoveredMessages?.some(message => message.id === submissionId))) throw cliError('本次消息已被撤回，未执行', 'This message was withdrawn and was not run');
    }, abort.signal);
    if (abort.signal.aborted) throw abort.signal.reason;
  } catch (error) { if (timedOut) throw cliError('等待超时；服务端会话继续保留，可使用 watch 查看或 interrupt 停止', 'Timed out waiting; the session is kept on the server, use watch to follow it or interrupt to stop it'); if (abort.signal.aborted) { process.exitCode = 130; return; } throw error; }
  finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (outcome?.status !== 'completed') throw cliError(`本轮结束状态为 ${outcome?.status ?? 'unknown'}`, `The turn ended with status ${outcome?.status ?? 'unknown'}`);
}
const goalControl = (id, action, data = {}) => call(`/goals/${id}/control`, 'POST', { action, ...data });
const sessionControl = (id, action) => call(`/sessions/${id}/control`, 'POST', { action });
async function recovery(id, values = []) {
  identifier(id, '会话 ID');
  // The record is enough (status, pause reason, recovery): the tail window, not every item.
  if (!values.length) { const session = await call(`/v2/sessions/${id}?window=tail`); return { sessionId: id, status: session.status, pauseReason: session.pauseReason, recovery: session.runtime?.recovery ?? null }; }
  count(values, 4, Infinity, 'recovery <会话ID> resolve <callKey> completed|not-executed|abandoned <核对说明>');
  const [action, callKey, status, ...words] = values, note = words.join(' ').trim();
  if (action !== 'resolve' || !callKey || callKey.length > 500 || /[\s\x00-\x1f]/.test(callKey) || !['completed', 'not-executed', 'abandoned'].includes(status) || !note || note.length > 4000) throw cliError('请提供 recovery 中的完整 callKey、completed|not-executed|abandoned 及 1–4000 字核对说明；abandoned 保留结果未确认，不自动重放', 'Provide the full callKey from recovery, completed|not-executed|abandoned, and a reconciliation note of 1–4000 characters; abandoned keeps the result unconfirmed and is not replayed automatically');
  return call(`/sessions/${id}/recovery`, 'POST', { callKey, status, note });
}
async function marketplace(values) {
  const action = values[0] ?? 'catalog';
  const parsed = options(values.slice(1), action === 'search' ? { provider: 'value', limit: 'value', project: 'value' } : action === 'read' ? { path: 'value', project: 'value' } : {});
  const projectId = parsed.project === undefined ? undefined : identifier(parsed.project, '项目 ID');
  if (action === 'catalog') { count(parsed.positional, 0, 0, 'marketplace [catalog]'); return call('/skill-marketplaces'); }
  if (action === 'search') {
    count(parsed.positional, 1, Infinity, 'marketplace search <公开能力关键词> [--provider skills-sh|skillsmp] [--limit 1–10] [--project ID]');
    const provider = parsed.provider ?? 'skills-sh', query = parsed.positional.join(' ').trim(), limit = Number(parsed.limit ?? 5);
    if (!['clawhub', 'skills-sh', 'skillsmp'].includes(provider) || !Number.isInteger(limit) || limit < 1 || limit > 10 || query.length < 2 || query.length > 160 || /[\x00-\x1f]/.test(query) || query === '*') throw cliError('搜索要求公开能力关键词（2–160 字）、有效供应商和 1–10 条结果', 'Search needs public capability keywords (2–160 characters), a valid provider and 1–10 results');
    return call('/skill-marketplaces/search', 'POST', { provider, query, limit, ...(projectId ? { projectId } : {}) });
  }
  if (action === 'read') {
    count(parsed.positional, 2, 2, 'marketplace read skills-sh|skillsmp <搜索结果ID> [--path 包内相对路径] [--project ID]');
    const [provider, id] = parsed.positional;
    if (!['clawhub', 'skills-sh', 'skillsmp'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,499}$/.test(id)) throw cliError('请提供供应商和搜索返回的完整结果 ID', 'Provide the provider and the full result ID returned by the search');
    return call('/skill-marketplaces/read', 'POST', { provider, id, ...(parsed.path ? { path: parsed.path } : {}), ...(projectId ? { projectId } : {}) });
  }
  throw cliError('技能来源操作为 catalog、search 或 read；读取不安装、不授予执行权限', 'The skill source operation is catalog, search or read; reading installs nothing and grants no execution permission');
}
function count(values, min, max, usage) {
  if (values.length < min || values.length > max) throw cliError(`参数有误，用法：${usage}`, `Invalid arguments. Usage: ${glossEn(usage)}`);
}
function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value)) throw cliError(`${label} 缺失或格式有误`, `${glossEn(label)} is missing or malformed`);
  return value;
}
async function providerAuth(values) {
  const action = values[0] ?? 'catalog';
  const parsed = options(values.slice(1), { method: 'value', attempt: 'value', 'callback-file': 'value', wait: 'flag' });
  if (action === 'catalog') { count(parsed.positional, 0, 0, 'provider-auth catalog'); return call('/provider-auth-methods'); }
  if (!['start', 'status', 'complete', 'cancel', 'logout'].includes(action)) throw cliError('provider-auth 操作为 catalog/start/status/complete/cancel/logout', 'The provider-auth operation is catalog/start/status/complete/cancel/logout');
  count(parsed.positional, 1, 1, `provider-auth ${action} <供应商ID>`); const id = identifier(parsed.positional[0], '供应商 ID'), path = `/providers/${id}/auth`;
  if (action === 'status') return call(path);
  if (action === 'complete') {
    if (!parsed.attempt || !parsed['callback-file']) throw cliError('请提供 --attempt 登录流程ID 与 --callback-file 回调地址文件；回调地址不接受命令行参数', 'Provide --attempt with the sign-in flow ID and --callback-file with the callback address file; the callback address is not accepted as a command-line argument');
    return call(`${path}/complete`, 'POST', { attemptId: parsed.attempt, callbackUrl: inputFile(parsed['callback-file']).trim() });
  }
  if (action === 'cancel') return call(`${path}/cancel`, 'POST', parsed.attempt ? { attemptId: parsed.attempt } : {});
  if (action === 'logout') return call(`${path}/logout`, 'POST', {});
  const method = parsed.method ?? 'browser'; if (!['browser', 'device_code'].includes(method)) throw cliError('--method 必须是 browser 或 device_code', '--method must be browser or device_code');
  let state = await call(`${path}/start`, 'POST', { method });
  if (!parsed.wait) return state;
  console.log(terminalJson(state, null, 2)); let cancelled = false; const stop = () => { cancelled = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const deadline = Date.now() + 16 * 60000;
    while (state.state === 'awaiting_authorization' && Date.now() < deadline && !cancelled) { await new Promise(resolve => setTimeout(resolve, 1000)); if (!cancelled) state = await call(path); }
    if (cancelled) { state = await call(`${path}/cancel`, 'POST', { attemptId: state.attemptId }); process.exitCode = 130; }
    else if (!state.authenticated) throw state.error ? new Error(state.error) : cliError('登录未完成；使用 provider-auth status 查看或重新开始', 'Sign-in did not complete; use provider-auth status to check or start over');
    return state;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
function options(values, allowed) {
  const result = { positional: [] };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === '--') { result.positional.push(...values.slice(i + 1)); break; }
    if (!value.startsWith('--')) { result.positional.push(value); continue; }
    const key = value.slice(2);
    if (!(key in allowed)) throw cliError(`不支持的选项：${value}`, `Unsupported option: ${value}`);
    if (Object.hasOwn(result, key)) throw cliError(`重复选项：${value}`, `Duplicate option: ${value}`);
    if (allowed[key] === 'flag') result[key] = true;
    else {
      if (!values[i + 1] || values[i + 1].startsWith('--')) throw cliError(`${value} 缺少值`, `${value} needs a value`);
      result[key] = values[++i];
    }
  }
  return result;
}
async function getProject(id) {
  identifier(id, '项目 ID');
  const project = (await call('/projects')).find(project => project.id === id);
  if (!project) throw cliError('项目不存在', 'The project does not exist');
  return project;
}
async function initiative(id, action) {
  identifier(id, '项目 ID');
  const settings = { on: { enabled: true }, off: { enabled: false }, mute: { notificationMuted: true }, unmute: { notificationMuted: false }, quiet: { quietUntil: new Date(Date.now() + 30 * 60000).toISOString() }, resume: { enabled: true, quietUntil: null } }[action];
  if (!settings) throw cliError('主动操作必须为 on、off、mute、unmute、quiet 或 resume', 'The proactive action must be on, off, mute, unmute, quiet or resume');
  return call(`/projects/${id}`, 'PATCH', { initiative: settings });
}
function printItem(item) {
  if (item.interaction) {
    const interaction = item.interaction;
    console.log(say(`\n[Rna Agent · ${interaction.kind === 'permission' ? '权限确认' : '待确认事项'}] ${interaction.status}\n  交互 ID：${interaction.id}`, `\n[Rna Agent · ${interaction.kind === 'permission' ? 'Permission request' : 'Pending item'}] ${interaction.status}\n  Interaction ID: ${interaction.id}`));
    if (interaction.permission) console.log(say(`  权限范围：项目 ${interaction.permission.projectId} · 工作区 ${interaction.permission.workspace} · 后台 ${interaction.permission.background}`, `  Permission scope: project ${interaction.permission.projectId} · workspace ${interaction.permission.workspace} · background ${interaction.permission.background}`));
    for (const question of interaction.questions) {
      console.log(say(`  问题 ${question.id}：${question.question}${question.multiSelect ? '（可多选）' : ''}${question.allowCustom !== false ? '（可补充文字）' : ''}`, `  Question ${question.id}: ${question.question}${question.multiSelect ? ' (multiple choice)' : ''}${question.allowCustom !== false ? ' (free text allowed)' : ''}`));
      if (question.detail) console.log(`    ${question.detail}`);
      for (const option of question.options ?? []) console.log(`    ${option.id} · ${option.label}${option.description ? ` — ${option.description}` : ''}`);
      const answer = interaction.answers?.find(answer => answer.id === question.id);
      if (answer) console.log(`    ${say('已回答：', 'Answered: ')}${answer.selected.join(', ')}${answer.custom ? ` · ${answer.custom}` : ''}`);
    }
    if (interaction.canRespond) console.log(say('  使用 answer <会话ID> <交互ID> --answers-file <JSON文件> 回答，或 cancel-question <会话ID> <交互ID> 取消。普通聊天回复不会自动授予权限。', '  Answer with answer <session ID> <interaction ID> --answers-file <JSON file>, or cancel with cancel-question <session ID> <interaction ID>. An ordinary chat reply does not grant permission automatically.'));
    return;
  }
  const origin = item.source ?? item.origin;
  const label = origin === 'initiative' ? say('Rna Agent · 主动发现', 'Rna Agent · Proactive finding') : origin === 'evolution' ? say('Rna Agent · 版本进化', 'Rna Agent · Version evolution') : { user: say('你', 'You'), assistant: 'Rna Agent', tool: say(`工具 · ${item.tool?.name}`, `Tool · ${item.tool?.name}`), notice: origin === 'autonomy' ? say('旧目标唤醒', 'Legacy goal wake-up') : say('会话', 'Session') }[item.kind] ?? say('项目事件', 'Project event');
  console.log(`\n[${label}${item.continuation ? say(' · 续', ' · continued') : ''}${item.delivery === 'steer' ? say(' · 中途引导', ' · mid-turn steer') : ''}] ${item.text}`);
  if (item.tool) console.log(`  ${item.tool.status} ${JSON.stringify(item.tool.args)}${item.tool.output ? `\n${item.tool.output}` : ''}`);
  if (origin === 'initiative' && item.reason) console.log(say(`  原因：${item.reason} · ${item.decisionMode === 'demo-policy' ? '演示策略判断' : origin}`, `  Reason: ${item.reason} · ${item.decisionMode === 'demo-policy' ? 'demo policy judgment' : origin}`));
  if (item.versionId) console.log(say(`  项目版本：${item.versionId}（可用 versions / version 命令查看和试用）`, `  Project version: ${item.versionId} (view and try it with the versions / version commands)`));
  if (item.artifactIds?.length) console.log(say(`  产物：${item.artifactIds.join(', ')}（在桌面 UI 中预览）`, `  Artifacts: ${item.artifactIds.join(', ')} (preview in the desktop UI)`));
}
async function chat(id, projectId, directory) {
  await languageReady();
  if (directory) { if (id || projectId) throw cliError('chat --workspace 不能同时指定会话或 --project', 'chat --workspace cannot be combined with a session or --project'); const opened = await call('/workspaces/open', 'POST', { workspace: workspace(directory) }); id = opened.session.id; }
  if (id) identifier(id, '会话 ID');
  if (projectId) identifier(projectId, '项目 ID');
  if (id && projectId) throw cliError('chat --project 用于新建项目会话；打开已有会话请只传会话 ID', 'chat --project starts a new project session; to open an existing session pass only the session ID');
  if (!id) id = (await call('/sessions', 'POST', projectId ? { projectId } : {})).id;
  // The conversation comes from the v2 stream: its tail window first, then what changes (cli-stream.mjs).
  const subscription = new AbortController(), shown = new Map(), backgroundRetries = new Map();
  let session = null, presence, rl, draftAttachments = [], closed = false, quitting = false, started = false, arrival;
  const first = new Promise((resolve, reject) => { arrival = { resolve, reject }; });
  const show = item => { if (rl && process.stdout.isTTY) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); } printItem(item); if (rl && !rl.closed && process.stdout.isTTY) rl.prompt(true); };
  // Proactive messages wait while the user types (presence); `ids` null shows everything not shown yet.
  const render = (ids = null) => { if (started) printChanged(session, ids, shown, item => item.source === 'initiative' && presence?.deferOutput(), show); };
  // A write route answered with the session: its record counts now, its items arrive through the stream.
  const adopt = latest => { if (session && latest) session = { ...session, ...sessionRecord(latest) }; };
  const streaming = consumeStream(id, (latest, ids) => { session = latest; if (started) render(ids); else arrival.resolve(); }, subscription.signal)
    .then(() => arrival.reject(cliError('事件流已结束', 'The event stream ended')), error => { arrival.reject(error); if (started && !closed && !subscription.signal.aborted) console.error(say(`事件流：${error.message}`, `Event stream: ${error.message}`)); });
  await first;
  console.log(say(`Rna Agent · 会话 ${session.id}\n${session.title} · ${session.mode} · ${session.model}${session.projectId ? `\n项目 ${session.projectId}` : ''}\n${session.modelConfig?.execution === 'rna' ? '真实 Rna SDK 执行；OpenViking 为唯一记忆后端。' : '内置演示模型；切换提供商后使用真实 Rna SDK 执行。'}CLI 与桌面 UI 共用此会话。/help 查看命令，/quit 退出 CLI。`, `Rna Agent · session ${session.id}\n${session.title} · ${session.mode} · ${session.model}${session.projectId ? `\nproject ${session.projectId}` : ''}\n${session.modelConfig?.execution === 'rna' ? 'Runs on the real Rna SDK; OpenViking is the only memory backend. ' : 'Built-in demo model; switch providers to run on the real Rna SDK. '}The CLI and the desktop UI share this session. /help lists the commands, /quit exits the CLI.`));
  started = true; render();
  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: say('你 › ', 'You › '), terminal: Boolean(process.stdin.isTTY), completer: completeCommand });
  presence = createCliPresence({ projectId: session.projectId, sessionId: session.id, base: `${base}/api`, onIdle: () => { render(); if (!closed) rl.prompt(true); } });
  const stopChat = () => { quitting = true; queue.cancel(); rl.close(); }; process.once('SIGINT', stopChat); process.once('SIGTERM', stopChat);
  const recover = result => {
    adopt(result.session);
    if (result.recovered?.length) {
      console.log(say('\n本轮未消费的消息已取回：', '\nMessages this turn did not consume were taken back:'));
      for (const message of result.recovered) console.log(`  [${message.delivery}] ${message.text}`);
      // readline treats literal newlines as submitted commands; restore as one editable line.
      if (process.stdin.isTTY) rl.write(result.recovered.map(message => message.text.replace(/[\r\n]+/g, ' ')).join(' | '));
    }
  };
  rl.prompt();
  const queue = createLineQueue(async line => {
      if (quitting) return;
      presence.submitting(true);
      try {
        const content = line.trim();
        if (!content) return;
        if (content === '/quit' || content === '/exit') { quitting = true; queue.cancel(); rl.close(); return; }
        if (content === '/help') console.log(say('/status · 当前轮次、模型与队列\n/model · 可用模型\n/attachments · 待发附件\n/detach <序号> · 移除待发附件\n/send · 仅发送附件\n/project · 当前项目\n/sources · 查看项目目录观察\n/source workspace pause|resume · 暂停/恢复变化采集\n/versions · 项目版本\n/initiative on|off|mute|unmute|quiet|resume · 项目主动状态\n/background · 查看后台行动\n/background pause|resume|stop <完整行动ID> · 控制指定后台行动\n/background steer <完整行动ID> <内容> · 调整后台研究方向\n/background retry <完整行动ID> · 用原请求重试未确认操作\n/goal [项目关注] · 查看或更新项目关注\n/feedback <内容> · 保存项目反馈\n/legacy-goal [pause|resume|cancel|advance|signal] · 旧目标演示\n/steer <内容> · 本轮引导\n/followup <内容> · 下轮排队\n/pause · /resume · /stop · /retry · /compact\n/recovery · 查看未决操作\n/recovery resolve <callKey> completed|not-executed|abandoned <核对说明> · 仅记录结果，之后 /resume\n/mode plan|build · 只读计划模式\n/model <供应商ID> <模型ID> [推理档位]\n/attach <文件路径> · 随下一条消息发送\n/permission [read|write|execute]\n/export <ZIP路径>\n/inbox · /withdraw <消息ID>\n/quit · 退出 CLI（会话继续保留）', '/status · the current turn, model and queue\n/model · the available models\n/attachments · attachments waiting to be sent\n/detach <number> · remove a waiting attachment\n/send · send only the attachments\n/project · the current project\n/sources · view the project directory observation\n/source workspace pause|resume · pause/resume change collection\n/versions · project versions\n/initiative on|off|mute|unmute|quiet|resume · the project proactive state\n/background · view the background actions\n/background pause|resume|stop <full action ID> · control the given background action\n/background steer <full action ID> <text> · adjust the background research direction\n/background retry <full action ID> · retry an unconfirmed operation with its original request\n/goal [project focus] · view or update the project focus\n/feedback <text> · save project feedback\n/legacy-goal [pause|resume|cancel|advance|signal] · the legacy goal demo\n/steer <text> · steer this turn\n/followup <text> · queue for the next turn\n/pause · /resume · /stop · /retry · /compact\n/recovery · view the unresolved operations\n/recovery resolve <callKey> completed|not-executed|abandoned <reconciliation note> · only records the result, then /resume\n/mode plan|build · read-only plan mode\n/model <provider ID> <model ID> [reasoning level]\n/attach <file path> · send with the next message\n/permission [read|write|execute]\n/export <ZIP path>\n/inbox · /withdraw <message ID>\n/quit · quit the CLI (the session is kept)'));
        else if (content === '/status') console.log(terminalJson({ sessionId: session.id, status: session.status, mode: session.mode, model: session.model, queued: session.inbox.length, recovery: session.runtime?.recovery ?? null }, null, 2));
        else if (content === '/model') console.table((await call('/configuration')).providers.flatMap(provider => provider.models.map(model => ({ provider: provider.id, model: model.id, name: model.name, context: model.contextWindow, input: model.inputCapability?.status === 'known' ? model.inputCapability.input?.join(', ') : say('待识别', 'pending') }))));
        else if (content === '/attachments') console.table(draftAttachments.map((item, index) => ({ index: index + 1, id: item.id, name: item.name })));
        else if (content.startsWith('/detach ')) { const index = Number(content.slice(8).trim()); if (!Number.isInteger(index) || index < 1 || index > draftAttachments.length) throw cliError('/detach <附件序号>，使用 /attachments 查看', '/detach <attachment number>, use /attachments to list them'); const [removed] = draftAttachments.splice(index - 1, 1); console.log(say(`已移除待发送附件：${removed.name}`, `Removed the pending attachment: ${removed.name}`)); }
        else if (content === '/sources' || content === '/source' || content.startsWith('/source ')) {
          if (!session.projectId) throw cliError('此会话未关联项目', 'This session is not linked to a project');
          if (content === '/sources') console.log(formatObservationSources(await call(`/projects/${session.projectId}/sources`)));
          else { const action = content.match(/^\/source\s+workspace\s+(pause|resume)$/)?.[1]; if (!action) throw new Error('/source workspace pause|resume'); console.log(formatObservationSources(await call(`/projects/${session.projectId}/sources/workspace`, 'PATCH', { enabled: action === 'resume' }))); }
        }
        else if (content === '/background' || content.startsWith('/background ')) {
          if (!session.projectId) throw cliError('此会话未关联项目', 'This session is not linked to a project');
          const values = content.slice('/background'.length).trim(), steering = values.match(/^steer\s+(\S+)\s+([\s\S]+)$/);
          const retry = values.match(/^retry\s+([A-Za-z0-9-]+)$/);
          if (values.startsWith('retry') && !retry) throw cliError('/background retry <完整行动ID>', '/background retry <full action ID>');
          const backgroundArgs = retry ? backgroundRetries.get(retry[1]) : [session.projectId, ...(steering ? ['steer', steering[1], '--text', steering[2]] : values ? values.split(/\s+/) : [])];
          if (!backgroundArgs) throw cliError('当前 CLI 没有这项待重试请求；先 /background 查看状态。', 'This CLI has no pending request to retry for that; check the state with /background first.');
          try {
            const outcome = await runBackgroundCommand(backgroundArgs, call); await printBackgroundResult(outcome);
            if (outcome.result?.action?.id) backgroundRetries.delete(outcome.result.action.id);
          } catch (error) {
            if (error.backgroundRetry) { backgroundRetries.set(error.backgroundRetry.actionId, error.backgroundRetry.arguments); throw cliError(`${error.cause?.message ?? '后台请求结果尚未确认'}\n先 /background 查看状态；/background retry ${error.backgroundRetry.actionId} 可用原请求 ID、版本与完整方向重试。不会自动重新发送。`, `${error.cause?.message ?? 'The background request result is not confirmed yet'}\nCheck the state with /background first; /background retry ${error.backgroundRetry.actionId} retries with the original request ID, version and full direction. It is not resent automatically.`); }
            if (retry) backgroundRetries.delete(retry[1]); throw error;
          }
        }
        else if (content === '/project' || content === '/versions' || content.startsWith('/initiative ')) {
          if (!session.projectId) throw cliError('此会话未关联项目；使用 chat --project PROJECT_ID 新建项目会话', 'This session is not linked to a project; use chat --project PROJECT_ID to start a project session');
          if (content.startsWith('/initiative ')) console.log(terminalJson(await initiative(session.projectId, content.slice(12).trim()), null, 2));
          else { const project = await getProject(session.projectId); console.log(content === '/versions' ? formatVersionList(project) : JSON.stringify(project, null, 2)); }
        }
        else if (content.startsWith('/goal ') || content.startsWith('/feedback ')) {
          const name = content.startsWith('/goal ') ? 'goal' : 'feedback';
          console.log(terminalJson(await commandCall(session.id, name, { text: content.slice(name.length + 2).trim() }), null, 2));
        }
        else if (content === '/goal') console.log(terminalJson(session.projectId ? { focus: (await getProject(session.projectId)).focus } : { focus: null }, null, 2));
        else if (content === '/legacy-goal' || content.startsWith('/legacy-goal ')) {
          const goal = (await call('/state')).goals?.find(g => g.sessionId === session.id);
          if (!goal) throw cliError('此会话没有旧Goal调度演示；项目主动性无需创建Goal。', 'This session has no legacy Goal scheduling demo; project proactivity needs no Goal.');
          const action = content.slice(12).trim();
          if (action) { const result = await goalControl(goal.id, action); adopt(result.session); console.log(terminalJson(result.goal, null, 2)); }
          else console.log(terminalJson(goal, null, 2));
        }
        else if (content === '/compact' || content.startsWith('/compact ')) console.log(terminalJson(await commandCall(session.id, 'compact', content.slice(8).trim() ? { instructions: content.slice(8).trim() } : {}), null, 2));
        else if (/^\/(pause|resume|stop|retry)$/.test(content)) recover(await sessionControl(session.id, content.slice(1)));
        else if (content === '/recovery' || content.startsWith('/recovery ')) console.log(terminalJson(await recovery(session.id, content.slice(9).trim() ? content.slice(9).trim().split(/\s+/) : []), null, 2));
        else if (content.startsWith('/attach ')) { const result = await upload(session.id, content.slice(8).trim()); draftAttachments.push(result.attachment); console.log(say(`已上传 ${result.attachment.name}${result.attachment.imageMimeType ? '（图片，读取时需支持图片的模型）' : result.attachment.readable ? '' : '（二进制未解析）'}，随下一条消息发送。`, `Uploaded ${result.attachment.name}${result.attachment.imageMimeType ? ' (image; reading it needs a model that supports images)' : result.attachment.readable ? '' : ' (binary, not parsed)'}; it is sent with the next message.`)); }
        else if (content.startsWith('/export ')) console.log(terminalJson(await exportSession(session.id, content.slice(8).trim()), null, 2));
        else if (content === '/permission' || content.startsWith('/permission ')) {
          if (!session.projectId) throw cliError('此会话未关联项目', 'This session is not linked to a project');
          const permission = await call(`/projects/${session.projectId}/permissions`), preset = content.slice(11).trim();
          console.log(terminalJson(preset ? await call(`/projects/${session.projectId}/permissions`, 'PATCH', { workspace: preset, background: permission.settings.background }) : permission, null, 2));
        }
        else if (content === '/inbox') console.log(terminalJson(session.inbox, null, 2));
        else if (content.startsWith('/withdraw ')) {
          const result = await call(`/sessions/${session.id}/inbox/${content.slice(10).trim()}`, 'DELETE', {});
          adopt(result.session); console.log(say(`已取回：${result.recovered.text}`, `Taken back: ${result.recovered.text}`));
          if (process.stdin.isTTY) rl.write(result.recovered.text.replace(/[\r\n]+/g, ' '));
        } else if (content.startsWith('/mode ') || content.startsWith('/plan ')) { await commandCall(session.id, 'plan', { mode: content.slice(6).trim() }); }
        else if (content.startsWith('/model ')) { const [providerId, modelId, reasoning, ...extra] = content.slice(7).trim().split(/\s+/); if (!providerId || !modelId || extra.length) throw cliError('/model <供应商ID> <模型ID> [推理档位]', '/model <provider ID> <model ID> [reasoning level]'); adopt(await call(`/sessions/${session.id}`, 'PATCH', { modelSelection: { providerId, modelId, ...(reasoning ? { reasoning } : {}) } })); }
        else {
          const prefix = content.match(/^\/(steer|followup)\s+([\s\S]+)$/);
          if (content.startsWith('/') && !prefix && content !== '/send') throw cliError('未知命令。使用 /help 查看可用命令。', 'Unknown command. Use /help to list the available commands.');
          if (content === '/send' && !draftAttachments.length) throw cliError('暂无附件；请使用 /attach <路径>，或直接输入消息。', 'No attachments yet; use /attach <path>, or just type a message.');
          const result = await call(`/sessions/${session.id}/messages`, 'POST', { text: prefix ? prefix[2] : content === '/send' ? '' : content, delivery: prefix ? prefix[1] : 'send', attachments: draftAttachments, requestId: randomUUID() });
          draftAttachments = [];
          adopt(result.session);
          if (result.queued) console.log(say(`已排入 ${result.entry.delivery}：${result.entry.id}`, `Queued as ${result.entry.delivery}: ${result.entry.id}`));
        }
      } catch (error) { console.error(`Rna Agent: ${errorText(error)}`); }
      finally { presence.submitting(false); if (!closed && !quitting) rl.prompt(); }
  });
  await new Promise(resolve => {
    rl.on('line', line => { void queue.push(line); });
    rl.on('close', () => { closed = true; void queue.drain().finally(() => { subscription.abort(); resolve(); }); });
  });
  try { await streaming; }
  finally { process.removeListener('SIGINT', stopChat); process.removeListener('SIGTERM', stopChat); await presence.close(); }
}
try {
  let result;
  if (command === '--version' || command === 'version-info') { count(args, 0, 0, '--version'); console.log(`Rna Agent ${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version}`);
  } else if (command === 'run') { await runSession(args);
  } else if (command === 'maintenance' && args[0] === 'compact-journals') { const value = await runJournalCompactionCli(args.slice(1)); if (value.json) result = value.result; else console.log(journalCompactionText(value.result)); if (value.result.failed.length) process.exitCode = 1;
  } else if (command === 'maintenance' && args[0] === 'prune') { const value = await runRetentionCli(args.slice(1)); if (value.json) result = value.result; else console.log(retentionText(value.result)); if (value.result.failed?.length) process.exitCode = 1;
  } else if (command === 'maintenance') { const value = await runMaintenanceCommand(args, call); if (value.json) result = value; else { await languageReady(); console.log(maintenanceCommandText(value)); } if (value.failed) process.exitCode = 1;
  } else if (command === 'effort') { result = await runEffortCommand(args, call);
  } else if (command === 'compaction') { result = await runCompactionCommand(args, call);
  } else if (command === 'schedule-text') { result = await runScheduleTextCommand(args, call);
  } else if (command === 'retry') { count(args, 1, 1, 'retry <会话ID>'); result = await sessionControl(identifier(args[0], '会话 ID'), 'retry');
  } else if (command === 'recovery') { count(args, 1, Infinity, 'recovery <会话ID> [resolve <callKey> completed|not-executed|abandoned <核对说明>]'); result = await recovery(args[0], args.slice(1));
  } else if (command === 'marketplace') { result = await marketplace(args);
  } else if (command === 'foundation') { count(args, 1, 2, 'foundation <项目ID> [retry]'); if (args[1] && args[1] !== 'retry') throw cliError('仅支持 foundation <项目ID> [retry]', 'Only foundation <project ID> [retry] is supported'); result = await call(`/projects/${identifier(args[0])}/skill-foundation`, args[1] === 'retry' ? 'POST' : 'GET', args[1] === 'retry' ? {} : undefined);
  } else if (command === 'mind') {
    // K1: project mind. `reconcile` closes agenda/commitments already answered or superseded in the conversation (JEV judge; none = unchanged).
    const parsed = options(args, { 'dry-run': 'flag' }), [sub, id] = parsed.positional, usage = 'mind <项目ID> | mind reconcile <项目ID> [--dry-run]';
    if (sub === 'reconcile') { count(parsed.positional, 2, 2, usage); result = await call(`/v2/projects/${identifier(id)}/mind/reconcile`, 'POST', { dryRun: parsed['dry-run'] === true }); }
    else { count(parsed.positional, 1, 1, usage); result = await call(`/v2/projects/${identifier(sub)}/mind`); }
  } else if (command === 'evolution') {
    // P4: evolution data (read-only) and the manual system-level proposal path; nothing here adopts a version.
    const [sub, ...rest] = args, usage = 'evolution failures [项目ID] | system | proposals [数量] | resolve-proposal <ID> <addressed|rejected|proposed> [说明] | propose-system [组件] [说明] | changelog|components|history|signals <项目ID> [组件键] | task-types <项目ID> [类型…|auto]';
    if (sub === 'failures') { count(rest, 0, 1, usage); result = await call(rest[0] ? `/v2/projects/${identifier(rest[0])}/evolution/failures` : '/v2/evolution/failures'); }
    else if (sub === 'system') { count(rest, 0, 0, usage); result = await call('/v2/evolution/system'); }
    else if (sub === 'proposals') { count(rest, 0, 1, usage); result = await call(`/v2/evolution/system/proposals?limit=${Number(rest[0]) || 50}`); }
    else if (sub === 'resolve-proposal') { if (rest.length < 2) throw cliError(usage, glossEn(usage)); result = await call(`/v2/evolution/system/proposals/${encodeURIComponent(rest[0])}`, 'PATCH', { status: rest[1], ...(rest.length > 2 ? { note: rest.slice(2).join(' ') } : {}) }); }
    else if (sub === 'propose-system') result = await call('/v2/evolution/system/proposals', 'POST', { ...(rest[0] ? { component: rest[0] } : {}), ...(rest.length > 1 ? { note: rest.slice(1).join(' ') } : {}) });
    else if (['changelog', 'components', 'history', 'signals'].includes(sub)) { count(rest, 1, sub === 'components' ? 2 : 1, usage); result = await call(`/v2/projects/${identifier(rest[0])}/evolution/${sub}${sub === 'components' && rest[1] ? `?key=${encodeURIComponent(rest[1])}` : ''}`); }
    else if (sub === 'task-types') { count(rest, 1, 5, usage); result = await call(`/v2/projects/${identifier(rest[0])}/task-types`, rest.length > 1 ? 'PATCH' : 'GET', rest.length > 1 ? { taskTypes: rest[1] === 'auto' ? null : rest.slice(1) } : undefined); }
    else throw cliError(usage, glossEn(usage));
  } else if (command === 'background') { await printBackgroundResult(await runBackgroundCommand(args, call));
  } else if (command === 'schedule') {
    const parsed = options(args, { file: 'value', 'request-id': 'value' }), values = parsed.positional;
    count(values, 1, 3, 'schedule <项目ID> [list|create|update|pause|resume|delete] [日程ID] [--file JSON文件] [--request-id ID]');
    const [projectId, action = 'list', scheduleId] = values, path = `/projects/${identifier(projectId, '项目 ID')}/schedules`;
    if (action === 'list' && !scheduleId && !parsed.file && !parsed['request-id']) result = await call(path);
    else if (action === 'create' && !scheduleId && parsed.file) result = await call(path, 'POST', { ...inputFile(parsed.file, true), requestId: parsed['request-id'] ?? randomUUID() });
    else if (['update', 'pause', 'resume', 'delete'].includes(action) && scheduleId && !parsed['request-id'] && (action === 'update' ? parsed.file : !parsed.file)) result = await call(`${path}/${identifier(scheduleId, '日程 ID')}`, action === 'delete' ? 'DELETE' : 'PATCH', action === 'update' ? inputFile(parsed.file, true) : action === 'delete' ? {} : { enabled: action === 'resume' });
    else throw cliError('create/update 要求 --file；update/pause/resume/delete 要求日程 ID；list 不接受修改参数。', 'create/update need --file; update/pause/resume/delete need the schedule ID; list takes no modifying arguments.');
  } else if (command === 'watch') { const parsed = options(args, { jsonl: 'flag' }); count(parsed.positional, 1, 1, 'watch <会话ID> [--jsonl]'); await watchSession(parsed.positional[0], parsed.jsonl);
  } else if (['commands', 'focus', 'feedback', 'plan', 'compact', 'attach', 'export'].includes(command)) {
    if (command === 'commands') { count(args, 1, 1, 'commands <会话ID>'); result = await call(`/sessions/${identifier(args[0])}/commands`); }
    else if (command === 'attach' || command === 'export') { count(args, 2, 2, `${command} <会话ID> <文件路径>`); result = command === 'attach' ? await upload(args[0], args[1]) : await exportSession(args[0], args[1]); }
    else { count(args, command === 'compact' ? 1 : 2, command === 'plan' ? 2 : Infinity, `${command} <会话ID> ${command === 'plan' ? 'plan|build' : '[内容]'}`); result = await commandCall(args[0], command === 'focus' ? 'goal' : command, command === 'plan' ? { mode: args[1] } : command === 'compact' ? (args[1] ? { instructions: args.slice(1).join(' ') } : {}) : { text: args.slice(1).join(' ') }); }
  } else if (command === 'frequency') {
    count(args, 1, 2, 'frequency <项目ID> [active|balanced|quiet]'); const id = identifier(args[0]);
    if (!args[1]) { const project = await getProject(id); result = { initiative: project.initiative, evolution: project.evolution }; }
    else { const preset = PROJECT_SCHEDULE_PRESETS[args[1]]; if (!preset) throw cliError('频率预设为 active、balanced 或 quiet', 'The frequency preset is active, balanced or quiet'); result = await call(`/projects/${id}`, 'PATCH', { initiative: { reviewMinMs: preset.reviewMinMs, reviewMaxMs: preset.reviewMaxMs, cooldownMs: preset.cooldownMs }, evolution: { minIntervalMs: preset.minIntervalMs } }); }
  } else if (command === 'files' || command === 'file') {
    count(args, command === 'file' ? 2 : 1, 2, `${command} <项目ID> [项目相对路径]`);
    result = await call(`/projects/${identifier(args[0])}/${command}?path=${encodeURIComponent(args[1] ?? '')}`);
  } else if (command === 'preview') {
    const parsed = options(args, { mode: 'value', session: 'value' }), values = parsed.positional;
    count(values, 1, 3, 'preview <项目ID> [status|start|stop] [HTML相对路径或Vite目录] [--mode static|vite] [--session 会话ID]'); const action = values[1] ?? 'status', mode = parsed.mode ?? 'static';
    if (!['status', 'start', 'stop'].includes(action) || !['static', 'vite'].includes(mode) || action !== 'start' && (values[2] !== undefined || parsed.mode !== undefined || parsed.session !== undefined)) throw cliError('预览操作为 status、start 或 stop；仅 start 接受路径、--mode static|vite 和 --session', 'The preview action is status, start or stop; only start accepts a path, --mode static|vite and --session');
    const payload = { mode, ...(mode === 'vite' ? { directory: values[2] ?? '' } : { path: values[2] ?? 'index.html' }), ...(parsed.session ? { sessionId: identifier(parsed.session, '会话 ID') } : {}) };
    result = await call(`/projects/${identifier(values[0])}/preview`, { status: 'GET', start: 'POST', stop: 'DELETE' }[action], action === 'status' ? undefined : action === 'start' ? payload : {});
  } else if (command === 'questions') {
    count(args, 1, 1, 'questions <会话ID>'); const sessionId = identifier(args[0], '会话 ID');
    // Every card of the conversation: the v2 session with all its items (allowlisted), not the legacy whole record.
    const session = await call(`/v2/sessions/${sessionId}`); result = { sessionId, interactions: session.items.filter(item => item.interaction).map(item => item.interaction) };
  } else if (command === 'answer' || command === 'cancel-question') {
    const parsed = options(args, { ...(command === 'answer' ? { 'answers-file': 'value' } : {}), 'request-id': 'value' });
    count(parsed.positional, 2, 2, `${command} <会话ID> <交互ID>${command === 'answer' ? ' --answers-file <JSON文件>' : ''} [--request-id ID]`);
    const sessionId = identifier(parsed.positional[0], '会话 ID'), interactionId = parsed.positional[1];
    if (!/^[a-f0-9]{64}$/.test(interactionId)) throw cliError('交互 ID 必须为 questions 中的完整 ID', 'The interaction ID must be the full ID from questions');
    let payload = {};
    if (command === 'answer') {
      if (!parsed['answers-file']) throw cliError('请使用 --answers-file 提供包含 answers 数组的 JSON 文件', 'Use --answers-file to provide a JSON file containing an answers array');
      payload = inputFile(parsed['answers-file'], true);
      if (Object.keys(payload).some(key => key !== 'answers') || !Array.isArray(payload.answers)) throw cliError('回答文件只接受 {"answers":[{"id":"问题ID","selected":["选项ID"],"custom":"可选补充"}]}；权限范围由服务端固定', 'The answer file accepts only {"answers":[{"id":"question ID","selected":["option ID"],"custom":"optional addition"}]}; the permission scope is fixed by the server');
    }
    const requestId = parsed['request-id'] ?? `cli-${createHash('sha256').update(JSON.stringify([sessionId, interactionId, command, payload])).digest('hex')}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(requestId)) throw cliError('--request-id 格式有误（仅字母、数字、下划线、连字符，最多 160 字符）', '--request-id is malformed (letters, digits, underscores and hyphens only, at most 160 characters)');
    result = await call(`/sessions/${sessionId}/interactions/${interactionId}/${command === 'answer' ? 'answer' : 'cancel'}`, 'POST', { requestId, ...payload });
  } else if (command === 'permissions' || command === 'permissions-set') {
    const parsed = options(args, command === 'permissions-set' ? { workspace: 'value', background: 'value' } : {});
    count(parsed.positional, 1, 1, `${command} <项目ID>${command === 'permissions-set' ? ' --workspace read|write|execute --background read|inherit' : ''}`);
    const id = identifier(parsed.positional[0], '项目 ID');
    if (command === 'permissions-set' && (!['read', 'write', 'execute'].includes(parsed.workspace) || !['read', 'inherit'].includes(parsed.background))) throw cliError('必须明确指定 --workspace read|write|execute 和 --background read|inherit', 'Specify both --workspace read|write|execute and --background read|inherit explicitly');
    result = await call(`/projects/${id}/permissions`, command === 'permissions-set' ? 'PATCH' : 'GET', command === 'permissions-set' ? { workspace: parsed.workspace, background: parsed.background } : undefined);
  } else if (command === 'judge') {
    const usage = 'judge [status|ledger|calibration|completion] [--point 决策点] [--project 项目ID] [--window 24h|7d|30d|all] [--json]';
    const parsed = options(args, { json: 'flag', point: 'value', project: 'value', window: 'value' }); count(parsed.positional, 0, 1, usage);
    const action = parsed.positional[0] ?? 'status'; if (!['status', 'ledger', 'calibration', 'completion'].includes(action)) throw cliError(`用法：${usage}`, `Usage: ${glossEn(usage)}`);
    // An option an action does not read is refused, never silently dropped: `--project` is for completion alone, which reads one point.
    if (parsed.project && action !== 'completion') throw cliError('--project 只用于 judge completion', '--project is only for judge completion');
    if (parsed.point && action === 'completion') throw cliError('judge completion 只看 work.completion，不接受 --point', 'judge completion only looks at work.completion and does not accept --point');
    const query = new URLSearchParams({ ...(parsed.point && action !== 'completion' ? { point: parsed.point } : {}), ...(parsed.project && action === 'completion' ? { projectId: parsed.project } : {}), ...(parsed.window ? { window: parsed.window } : {}) }).toString();
    const data = await call(action === 'ledger' ? '/decision-kernel/ledger' : action === 'calibration' ? `/v2/decision-kernel/calibration${query ? `?${query}` : ''}` : action === 'completion' ? `/v2/decision-kernel/completion${query ? `?${query}` : ''}` : '/decision-kernel');
    if (parsed.json || action !== 'status') result = data; else console.log(formatDecisionStatus(data));
  } else if (command === 'config' || command === 'providers') {
    count(args, 0, 0, command); const configuration = await call('/configuration'); result = command === 'providers' ? configuration.providers : configuration;
  } else if (command === 'web-config') {
    const parsed = options(args, { enabled: 'value', provider: 'value', endpoint: 'value', 'api-key-env': 'value', 'timeout-ms': 'value', file: 'value' });
    count(parsed.positional, 0, 0, 'web-config [--enabled true|false] [--provider fastcrw|firecrawl|tavily|brave|zhipu|bocha] [--endpoint URL] [--api-key-env 名称] [--timeout-ms 毫秒] | --file <JSON文件>');
    if (parsed.file && Object.keys(parsed).some(key => !['file', 'positional'].includes(key))) throw cliError('--file 不能与其他设置参数混用；密钥只接受文件或环境变量引用', '--file cannot be combined with other settings arguments; keys are accepted only as a file or an environment variable reference');
    if (parsed.enabled !== undefined && !['true', 'false'].includes(parsed.enabled)) throw cliError('--enabled 必须是 true 或 false', '--enabled must be true or false');
    const patch = parsed.file ? inputFile(parsed.file, true) : { ...(parsed.enabled !== undefined ? { enabled: parsed.enabled === 'true' } : {}), ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}), ...(parsed.endpoint !== undefined ? { baseUrl: parsed.endpoint } : {}), ...(parsed['api-key-env'] !== undefined ? { apiKeyEnv: parsed['api-key-env'] } : {}), ...(parsed['timeout-ms'] !== undefined ? { timeoutMs: Number(parsed['timeout-ms']) } : {}) };
    result = Object.keys(patch).length ? (await call('/configuration', 'PATCH', { webTools: patch })).webTools : (await call('/configuration')).webTools;
  } else if (command === 'web-test') {
    count(args, 0, 0, 'web-test'); result = await call('/web-tools/test', 'POST', {}); if (!result.ok) process.exitCode = 1;
  } else if (command === 'model-default' || command === 'model-set') {
    const offset = command === 'model-set' ? 1 : 0;
    count(args, 2 + offset, 3 + offset, `${command} ${offset ? '<会话ID> ' : ''}<供应商ID> <模型ID> [推理档位]`);
    if (offset) identifier(args[0], '会话 ID'); identifier(args[offset], '供应商 ID');
    const selection = { providerId: args[offset], modelId: args[offset + 1], ...(args[offset + 2] ? { reasoning: args[offset + 2] } : {}) };
    result = offset ? await call(`/sessions/${args[0]}`, 'PATCH', { modelSelection: selection }) : await call('/configuration', 'PATCH', { defaultModel: selection });
  } else if (command === 'provider-auth') {
    result = await providerAuth(args);
  } else if (command === 'provider-add') {
    const parsed = options(args, { file: 'value' }); count(parsed.positional, 0, 0, 'provider-add --file <JSON文件>'); if (!parsed.file) throw cliError('请使用 --file 指定提供商 JSON；API Key 不接受命令行参数', 'Use --file to give the provider JSON; the API key is not accepted as a command-line argument'); result = await call('/providers', 'POST', inputFile(parsed.file, true));
  } else if (command === 'provider-test') {
    count(args, 1, 1, 'provider-test <供应商ID>'); identifier(args[0], '供应商 ID'); result = await call(`/providers/${args[0]}/test`, 'POST', {});
  } else if (command === 'memory-config') {
    const parsed = options(args, { backend: 'value', endpoint: 'value', 'api-key-env': 'value', 'auto-recall': 'value', 'auto-store': 'value', 'context-budget': 'value', limit: 'value' }); count(parsed.positional, 0, 0, 'memory-config [--backend openviking|embedded] [--endpoint URL] [--api-key-env 环境变量名] [--auto-recall true|false] [--auto-store true|false] [--context-budget tokens] [--limit 数量]');
    if (parsed['auto-recall'] !== undefined && !['true', 'false'].includes(parsed['auto-recall'])) throw cliError('--auto-recall 必须为 true 或 false', '--auto-recall must be true or false');
    if (parsed['auto-store'] !== undefined && !['true', 'false'].includes(parsed['auto-store'])) throw cliError('--auto-store 必须为 true 或 false', '--auto-store must be true or false');
    if (parsed.backend !== undefined && !['openviking', 'embedded'].includes(parsed.backend)) throw cliError('--backend 必须为 openviking 或 embedded', '--backend must be openviking or embedded');
    // Only a named backend is sent: changing another setting must not switch the backend back.
    const memory = { ...(parsed.backend !== undefined ? { backend: parsed.backend } : {}), ...(parsed['auto-store'] !== undefined ? { autoStore: parsed['auto-store'] === 'true' } : {}), ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}), ...(parsed['api-key-env'] ? { apiKeyEnv: parsed['api-key-env'] } : {}), ...(parsed['auto-recall'] !== undefined ? { autoRecall: parsed['auto-recall'] === 'true' } : {}), ...(parsed['context-budget'] ? { contextBudget: Number(parsed['context-budget']) } : {}), ...(parsed.limit ? { limit: Number(parsed.limit) } : {}) };
    result = Object.keys(memory).length ? (await call('/configuration', 'PATCH', { memory })).memory : (await call('/configuration')).memory;
  } else if (command === 'memory') {
    const parsed = options(args, { level: 'value', file: 'value', title: 'value', mode: 'value', uri: 'value', limit: 'value', offset: 'value' });
    count(parsed.positional, 1, Infinity, 'memory <项目ID> list|search|browse|read|write|health|initialize');
    const [projectId, action = 'list', ...words] = parsed.positional; identifier(projectId, '项目 ID');
    if (parsed.level && !['L0', 'L1', 'L2'].includes(parsed.level)) throw cliError('记忆层级必须为 L0、L1 或 L2', 'The memory level must be L0, L1 or L2');
    const input = { ...(parsed.level ? { level: parsed.level } : {}), ...(parsed.limit ? { limit: Number(parsed.limit) } : {}), ...(parsed.offset ? { offset: Number(parsed.offset) } : {}) }, path = `/projects/${projectId}/memory`;
    if (action === 'list') { count(words, 0, 0, 'memory <项目ID> list'); result = await call(`${path}${parsed.level ? `?level=${parsed.level}` : ''}`); }
    else if (action === 'search') { count(words, 1, Infinity, 'memory <项目ID> search <内容> [--level L0|L1|L2]'); result = await call(`${path}/search`, 'POST', { ...input, query: words.join(' ') }); }
    else if (action === 'browse' || action === 'read') { count(words, action === 'read' && !parsed.uri ? 1 : 0, 1, `memory <项目ID> ${action} [URI] [--level L0|L1|L2]`); const uri = parsed.uri ?? words[0]; result = await call(`${path}/${action}`, 'POST', { ...input, ...(uri ? { uri } : {}), ...(action === 'read' && !parsed.level ? { level: 'L2' } : {}) }); }
    else if (action === 'health' || action === 'initialize') { count(words, 0, 0, `memory <项目ID> ${action}`); result = await call(`${path}/${action}`, 'POST', {}); }
    else if (action === 'write') { count(words, 0, 0, 'memory <项目ID> write --file <文本文件> [--title 标题] [--uri URI] [--mode create|replace|append|upsert]'); if (!parsed.file) throw cliError('写入记忆请使用 --file 指定文本文件', 'To write a memory use --file to give a text file'); result = await call(`${path}/write`, 'POST', { content: inputFile(parsed.file), ...(parsed.title ? { title: parsed.title } : {}), ...(parsed.uri ? { uri: parsed.uri } : {}), ...(parsed.mode ? { mode: parsed.mode } : {}) }); }
    else throw cliError('memory 操作必须为 list、search、browse、read、write、health 或 initialize', 'The memory operation must be list, search, browse, read, write, health or initialize');
  } else if (command === 'doctor') {
    count(args, 0, 1, 'doctor [项目ID]'); const health = await call('/health'), config = await call('/configuration');
    result = { daemon: health, runtime: config.runtime, defaultModel: config.defaultModel, providers: config.providers.map(p => ({ id: p.id, name: p.name, modelCount: p.models.length, credentialSource: p.credentialSource, apiKeyConfigured: p.apiKeyConfigured })), memory: { backend: config.memory.backend, endpoint: config.memory.endpoint } };
    // The first project from the v2 index rows when none is named (not every project's whole record).
    const projectId = args[0] ?? (await call('/v2/bootstrap')).projects?.[0]?.id;
    if (projectId) { identifier(projectId, '项目 ID'); try { result.memory.health = await call(`/projects/${projectId}/memory/health`, 'POST', {}); } catch (error) { result.memory.health = { connected: false, error: error.message }; process.exitCode = 1; } }
    else result.memory.health = { checked: false, reason: '尚无项目；创建项目后可检查 OpenViking' };
    // Experience over the last week (plan §5): proactive replies, invitations, wakes, JEV label coverage, open system problems.
    try { result.experience = await call('/v2/experience?days=7'); } catch (error) { result.experience = { available: false, error: error.message }; }
    // The evolution's own state (D3): where each lane is and why nothing happens, what every rule was run or shown for, what became of lessons and corrections, how the work fared per generation.
    try { result.evolution = await evolutionSection(call, args[0] ?? null); } catch (error) { result.evolution = { available: false, error: error.message }; }
  } else if (command === 'projects') {
    count(args, 0, 0, 'projects'); result = await call('/projects');
  } else if (command === 'project-open') {
    const parsed = options(args, { project: 'value' });
    count(parsed.positional, 1, 1, 'project-open <目录> [--project <历史项目ID>]');
    if (parsed.project) identifier(parsed.project, '项目 ID');
    result = await call('/workspaces/open', 'POST', { workspace: workspace(parsed.positional[0]), ...(parsed.project ? { projectId: parsed.project } : {}) });
  } else if (command === 'project-new') {
    const parsed = options(args, { demo: 'flag', workspace: 'value' });
    count(parsed.positional, 1, Infinity, 'project-new <名称> [项目说明] [--demo] [--workspace 目录]');
    result = await call('/projects', 'POST', { name: parsed.positional[0], ...(parsed.positional.length > 1 ? { description: parsed.positional.slice(1).join(' ') } : {}), ...(parsed.demo ? { demo: true } : {}), ...(parsed.workspace ? { workspace: workspace(parsed.workspace) } : {}) });
  } else if (command === 'evolve') {
    count(args, 1, 2, 'evolve <项目ID> [能力包JSON文件]'); identifier(args[0], '项目 ID');
    const project = await getProject(args[0]); result = await call(`/projects/${args[0]}/evolution`, 'POST', { baseVersionId: project.activeVersionId, ...(args[1] ? { genome: inputFile(args[1], true) } : {}) });
  } else if (command === 'genome') {
    count(args, 1, 2, 'genome <项目ID> [版本ID]'); identifier(args[0], '项目 ID'); const project = await getProject(args[0]);
    const version = project.versions.find(v => v.id === (args[1] ?? project.trialVersionId ?? project.activeVersionId));
    if (!version?.bundle) throw cliError('此版本尚无真实能力包', 'This version has no real capability package yet'); result = version.bundle.genome;
  } else if (command === 'project-init') {
    count(args, 1, 1, 'project-init <项目ID>'); identifier(args[0], '项目 ID'); result = await call(`/projects/${args[0]}/initialize`, 'POST', {});
  } else if (command === 'capabilities') {
    count(args, 0, 0, 'capabilities'); result = await call('/capabilities');
  } else if (command === 'project-capabilities') {
    count(args, 1, 1, 'project-capabilities <项目ID>'); identifier(args[0], '项目 ID');
    result = await call(`/projects/${args[0]}/capabilities`);
  } else if (['capability-inspect', 'capability-install', 'capability-assign', 'capability-remove'].includes(command)) {
    count(args, 2, 2, `${command} <项目ID> <JSON文件>`); identifier(args[0], '项目 ID');
    result = await call(`/projects/${args[0]}/capabilities/${command.slice('capability-'.length)}`, 'POST', inputFile(args[1], true));
  } else if (command === 'capability-add') {
    count(args, 2, 2, 'capability-add skills|mcpServers <JSON文件>');
    if (!['skills', 'mcpServers'].includes(args[0])) throw cliError('能力类型必须为 skills 或 mcpServers', 'The capability type must be skills or mcpServers');
    result = await call(`/capabilities/${args[0]}`, 'POST', JSON.parse(readFileSync(resolve(args[1]), 'utf8')));
  } else if (command === 'project' || command === 'versions') {
    const parsed = options(args, command === 'versions' ? { json: 'flag' } : {}); count(parsed.positional, 1, 1, `${command} <项目ID>${command === 'versions' ? ' [--json]' : ''}`);
    const project = await getProject(parsed.positional[0]);
    if (command === 'versions' && !parsed.json) console.log(formatVersionList(project));
    else result = command === 'project' ? project : { projectId: project.id, activeVersionId: project.activeVersionId, trialVersionId: project.trialVersionId, versions: project.versions };
  } else if (command === 'sources' || command === 'source') {
    const parsed = options(args, { json: 'flag' });
    count(parsed.positional, command === 'sources' ? 1 : 3, command === 'sources' ? 1 : 3, command === 'sources' ? 'sources <项目ID> [--json]' : 'source <项目ID> workspace pause|resume [--json]');
    const projectId = identifier(parsed.positional[0], '项目 ID');
    if (command === 'source' && (parsed.positional[1] !== 'workspace' || !['pause', 'resume'].includes(parsed.positional[2]))) throw cliError('用法：source <项目ID> workspace pause|resume [--json]', 'Usage: source <project ID> workspace pause|resume [--json]');
    const data = command === 'sources' ? await call(`/projects/${projectId}/sources`) : await call(`/projects/${projectId}/sources/workspace`, 'PATCH', { enabled: parsed.positional[2] === 'resume' });
    if (parsed.json) result = data; else console.log(formatObservationSources(data));
  } else if (command === 'observe') {
    count(args, 3, Infinity, 'observe <项目ID> <类型> <内容>'); identifier(args[0], '项目 ID');
    if (!['context', 'ci_failure', 'ci_recovered', 'preference', 'research_result', 'note', 'conversation'].includes(args[1])) throw cliError('观察类型必须为 context、ci_failure、ci_recovered、preference、research_result、note 或 conversation', 'The observation type must be context, ci_failure, ci_recovered, preference, research_result, note or conversation');
    result = await call(`/projects/${args[0]}/observations`, 'POST', { kind: args[1], text: args.slice(2).join(' '), eventId: randomUUID() });
  } else if (command === 'initiative') {
    count(args, 2, 2, 'initiative <项目ID> on|off|mute|unmute|quiet|resume'); result = await initiative(args[0], args[1]);
  } else if (command === 'initiative-resolve') {
    const parsed = options(args, { status: 'value', summary: 'value' });
    count(parsed.positional, 2, 2, 'initiative-resolve <项目ID> <动作ID> --status completed|not-executed|cancelled --summary <核对说明>');
    const [projectId, actionId] = parsed.positional; identifier(projectId, '项目 ID'); identifier(actionId, '动作 ID');
    if (!['completed', 'not-executed', 'cancelled'].includes(parsed.status)) throw cliError('--status 必须明确为 completed、not-executed 或 cancelled（已核对终止，结果未验证）', '--status must be explicitly completed, not-executed or cancelled (reconciled as ended, result not verified)');
    const summary = parsed.summary?.trim();
    if (!summary || summary.length > 16000) throw cliError('--summary 必须为 1–16000 字符的实际核对说明', '--summary must be an actual reconciliation note of 1–16000 characters');
    result = await call(`/projects/${projectId}/initiative/actions/${actionId}/resolve`, 'POST', { status: parsed.status, summary });
  } else if (command === 'version') {
    const parsed = options(args, { json: 'flag' }), [projectId, versionId, action] = parsed.positional;
    count(parsed.positional, 2, 3, 'version <项目ID> <版本ID> [trial|rollback|adopt] [--json]'); identifier(projectId, '项目 ID'); identifier(versionId, '版本 ID');
    if (action) { if (!['trial', 'rollback', 'adopt'].includes(action)) throw cliError('版本操作必须为 trial、rollback 或 adopt', 'The version action must be trial, rollback or adopt'); result = await call(`/projects/${projectId}/versions/${versionId}/control`, 'POST', { action }); }
    else { const project = await getProject(projectId), version = project.versions.find(row => row.id === versionId); if (!version) throw cliError('版本不存在', 'The version does not exist'); if (parsed.json) result = version; else console.log(formatVersionDetail(project, version)); }
  } else if (command === 'check') {
    if (![1, 4].includes(args.length)) throw cliError('用法：check <项目ID> [signal revision smoke]；三个可选值均为 true 或 false', 'Usage: check <project ID> [signal revision smoke]; the three optional values are each true or false');
    identifier(args[0], '项目 ID');
    if (args.length === 4 && args.slice(1).some(value => !['true', 'false'].includes(value))) throw cliError('signal、revision、smoke 必须为 true 或 false', 'signal, revision and smoke must each be true or false');
    const [signal, revision, smoke] = args.length === 4 ? args.slice(1).map(value => value === 'true') : [true, false, false];
    const input = { signal, revision, smoke };
    result = { input, ...await call(`/projects/${args[0]}/checks`, 'POST', input) };
  } else if (command === 'autonomy') {
    const created = await call('/autonomy/demos', 'POST', args[0] === undefined ? {} : { budget: Number(args[0]) });
    result = { goalId: created.goal.id, sessionId: created.session.id, status: created.goal.status, url: `${base}/?session=${created.session.id}`, simulatedExecutor: true, message: '这是旧Goal调度兼容演示，非项目主动能力入口；后台推进需要daemon运行。' };
  } else if (command === 'goals') {
    const state = await call('/state'); console.table((state.goals ?? []).map(g => ({ id: g.id, title: g.title, status: g.status, stage: g.stage, runs: g.runCount, simulatedUSD: g.budget.spentUsd, nextWakeAt: g.nextWakeAt })));
  } else if (command === 'goal') {
    if (!args[1]) { result = (await call('/state')).goals?.find(g => g.id === args[0]); if (!result) throw cliError('目标不存在', 'The goal does not exist'); }
    else result = await goalControl(args[0], args[1], args[1] === 'budget' ? { limitUsd: Number(args[2]), ...(args[3] === undefined ? {} : { maxRuns: Number(args[3]) }) } : {});
  } else if (command === 'list') {
    const state = await call('/state'); await languageReady(); console.log(say('Rna Agent · 模拟执行任务', 'Rna Agent · Simulated tasks'));
    console.table(state.tasks.map(({ id, title, status, progress, spend }) => ({ id, title, status, progress, simulatedUSD: spend })));
  } else if (command === 'sessions') {
    // The v2 index rows (id, title, status, mode, updatedAt are on each), not every conversation with all its items.
    const sessions = (await call('/v2/bootstrap')).sessions ?? [];
    console.table(sessions.map(({ id, title, status, mode, updatedAt }) => ({ id, title, status, mode, updatedAt })));
  } else if (command === 'new') { const parsed = options(args, { project: 'value', workspace: 'value' }); if (parsed.project) identifier(parsed.project, '项目 ID'); result = await call('/sessions', 'POST', { ...(parsed.positional.length ? { title: parsed.positional.join(' ') } : {}), ...(parsed.project ? { projectId: parsed.project } : {}), ...(parsed.workspace ? { workspace: workspace(parsed.workspace) } : {}) }); }
  else if (command === 'demo') result = await call('/sessions', 'POST', { title: '会话工作台示例', demo: true });
  else if (command === 'chat') { const parsed = options(args, { project: 'value', workspace: 'value' }); count(parsed.positional, 0, 1, 'chat [会话ID] 或 chat --project <项目ID> 或 chat --workspace <目录>'); await chat(parsed.positional[0], parsed.project, parsed.workspace); }
  // The whole conversation as v2 sends it: every item, the allowlisted record and turns (no memory bookkeeping).
  else if (command === 'history') result = await call(`/v2/sessions/${identifier(args[0], '会话 ID')}`);
  else if (['send', 'steer', 'followup'].includes(command)) { const parsed = options(args, { attachment: 'value' }); count(parsed.positional, 2, Infinity, `${command} <会话ID> <内容> [--attachment <附件ID>]`); const [id, ...words] = parsed.positional; result = await call(`/sessions/${identifier(id)}/messages`, 'POST', { text: words.join(' '), delivery: command, attachments: parsed.attachment ? [{ id: parsed.attachment }] : [], requestId: randomUUID() }); }
  else if (command === 'interrupt') result = await sessionControl(args[0], 'stop');
  else if (command === 'withdraw') result = await call(`/sessions/${args[0]}/inbox/${args[1]}`, 'DELETE', {});
  // The daemon's health, not the whole state (28 MB on a long-used install).
  else if (command === 'status') { const h = await call('/health'); result = { ok: h.ok, mode: h.mode, version: h.version, sdkVersion: h.sdkVersion, emergency: h.emergency ?? null, revision: h.revision ?? null, settings: h.settings ?? null, usage: h.usage ?? null, maintenance: h.maintenance, autonomyDegraded: h.autonomyDegraded, memorySyncDegraded: h.memorySyncDegraded, workload: h.workload }; }
  else if (command === 'create') result = await call('/tasks', 'POST', { title: args.join(' '), description: '通过 CLI 创建的设计验证任务' });
  else if (['pause', 'resume', 'cancel'].includes(command)) {
    // Is it a conversation? The v2 index rows say so without the whole state.
    const sessions = command === 'cancel' ? [] : (await call('/v2/bootstrap')).sessions ?? [];
    if (sessions.some(session => session.id === args[0])) result = await sessionControl(args[0], command);
    else result = await call(`/tasks/${args[0]}`, 'PATCH', { action: command });
  }
  else if (command === 'edit') result = await call(`/tasks/${args[0]}`, 'PATCH', { title: args.slice(1).join(' ') });
  else if (command === 'delete') result = await call(`/tasks/${args[0]}`, 'DELETE', {});
  else if (command === 'budget') result = await call('/settings', 'PATCH', { dailyBudget: Number(args[0]), ...(args[1] === undefined ? {} : { tokenBudget: Number(args[1]) }) });
  else if (command === 'stop' || command === 'reset') result = await call('/emergency', 'POST', { stop: command === 'stop' });
  else if (command === 'events') result = await call('/events');
  else if (command === 'help') { count(args, 0, 1, 'help [chat|all]'); await printCliHelp(args[0]); }
  else throw cliError('未知命令，请运行 node cli.mjs help', 'Unknown command; run node cli.mjs help');
  if (result !== undefined) console.log(terminalJson(result, null, 2));
} catch (error) { await errorReady(error); console.error(`Rna Agent: ${errorText(error)}${error.cause?.code === 'ECONNREFUSED' ? say('。请先 ./rna service start 或 ./rna start', '. Start the service first with ./rna service start or ./rna start') : ''}`); process.exitCode = 1; }
