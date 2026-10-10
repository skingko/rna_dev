import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { DomainError } from '../store.mjs';
import { localizeErrorMessage, localizeErrorBody, hasHan, englishToolText, englishToolResult, englishToolExecute } from '../api-error-text.mjs';
import catalog, { CATALOG_MODULES, catalogConflicts } from '../api-error-catalog/index.mjs';
import { scanLiterals, sampleTexts, cook, IDEOGRAPH } from './helpers/literal-scan.mjs';

// API errors (2026-10-10 decision: "接口报错仔细检查并修复"): with interfaceLanguage en every HTTP error body reads in English, and the model
// reads tool errors in English; Chinese stays byte-identical. The catalog (api-error-catalog/) maps the Chinese texts, and the static scan
// below fails on a new Chinese error literal nobody added to it.

const root = fileURLToPath(new URL('..', import.meta.url)), sdkRoot = fileURLToPath(new URL('../../../packages/sdk/src', import.meta.url)), catalogDir = fileURLToPath(new URL('../api-error-catalog/', import.meta.url));

test('the engine: Chinese and text without Chinese pass through, English fills captured values, unknown text stays', () => {
  assert.equal(localizeErrorMessage('项目不存在', 'zh'), '项目不存在'); assert.equal(localizeErrorMessage('项目不存在', undefined), '项目不存在');
  assert.equal(localizeErrorMessage('Project not found', 'en'), 'Project not found'); assert.equal(localizeErrorMessage('', 'en'), ''); assert.equal(localizeErrorMessage(undefined, 'en'), undefined);
  assert.equal(localizeErrorMessage('项目不存在', 'en'), 'Project not found');
  assert.equal(localizeErrorMessage('会话标题 必须为 1–160 字符的文本', 'en'), 'Session title must be 1–160 characters of text');
  assert.equal(localizeErrorMessage('requestId 必须为 1–160 字符的文本', 'en'), 'requestId must be 1–160 characters of text', 'ids and field names stay literal');
  assert.equal(localizeErrorMessage('模型请求失败（HTTP 502）：模型服务没有返回 SSE 流', 'en'), 'The model request failed (HTTP 502): the model service returned no SSE stream', 'a captured part is translated too');
  assert.equal(localizeErrorMessage('这句话没有收录', 'en'), '这句话没有收录', 'unknown text is returned as written, never guessed');
  assert.equal(localizeErrorMessage('能力不存在：报告（终版）、草稿：v2', 'en'), 'Capability not found: 报告（终版）、草稿：v2', 'a captured name or path is kept byte for byte, its punctuation too');
  const body = { error: '项目不存在', code: 'x' }; assert.deepEqual(localizeErrorBody(body, 'en'), { error: 'Project not found', code: 'x' }); assert.equal(localizeErrorBody(body, 'zh'), body); assert.equal(localizeErrorBody({ ok: true }, 'en').ok, true);
  assert.ok(hasHan('（') && hasHan('项目') && !hasHan('Project not found'));
});

test('the catalog: no module disagrees with another, no key is written twice in one module, and every entry resolves to its own English', () => {
  assert.deepEqual(catalogConflicts, [], 'two modules translate the same Chinese text differently');
  const repeated = [];
  for (const file of readdirSync(catalogDir).filter(name => name.endsWith('.mjs') && name !== 'index.mjs')) {
    const seen = new Set();
    for (const [number, line] of readFileSync(join(catalogDir, file), 'utf8').split('\n').entries()) { const key = /^\s+(['"])((?:\\.|(?!\1).)*)\1:\s/.exec(line)?.[2]; if (key === undefined) continue; if (seen.has(key)) repeated.push(`${file}:${number + 1} ${key}`); seen.add(key); }
  }
  assert.deepEqual(repeated, [], 'a repeated key silently replaces the earlier one');
  assert.ok(Object.keys(CATALOG_MODULES).length >= 10 && Object.keys(catalog).length > 900);
  const shadowed = [];
  for (const [zh, en] of Object.entries(catalog)) {
    const sample = zh.replace(/\{\d+\}/g, 'X'), expected = en.replace(/\{\d+\}/g, 'X'), actual = localizeErrorMessage(sample, 'en');
    if (actual !== expected) shadowed.push(`${zh}\n    wants: ${expected}\n    gets:  ${actual}`);
  }
  assert.deepEqual(shadowed, [], 'an entry another template (or exact key) answers instead');
});

// The texts a client or the model can read: Chinese passed to the error constructors and helpers of the host and the SDK. Process-level text
// (the CLI, supervisor, recovery and shard tooling print to stderr; the CLI localizes its own) and the Electron shell are not HTTP errors.
const ERROR_CALLEE = /(^|\.)(new )?[A-Za-z]*(Error|Failure)$|^(fail|this\.fail|invalid|bad|reject|failure|corrupt|error|denied|inboxError|maintenanceFailure|this\.gitFailed|this\.service\.gitFailed)$/;
// Gitignored local directories are not source either: `.state` holds the user's own project workspaces, `qa` frozen copies and run artifacts.
const SKIP_DIRECTORY = new Set(['node_modules', 'test', 'test-support', 'benchmark', 'web', '.runtime', '.state', 'qa', 'browser', 'desktop']), SKIP_FILE = /^(cli(-|\.mjs)|service-cli|application-recovery-cli|daemon-supervisor|state-shards)/;
const sourcesUnder = (directory, base = directory) => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  if (statSync(path).isDirectory()) return SKIP_DIRECTORY.has(name) ? [] : sourcesUnder(path, base);
  return /\.mjs$/.test(name) && !SKIP_FILE.test(relative(base, path)) ? [path] : [];
});
function uncovered(directory) {
  const missing = new Map();
  for (const file of sourcesUnder(directory)) {
    for (const literal of scanLiterals(readFileSync(file, 'utf8'))) {
      const callee = literal.callees.at(-1) ?? '';
      // A literal in a { zh, en } pair, or handed to say(), is already worded for both languages.
      if (!ERROR_CALLEE.test(callee) || /\bzh:\s*$/.test(literal.before) || /(^|\.)say$/.test(callee)) continue;
      for (const sample of sampleTexts(literal)) if (IDEOGRAPH.test(sample) && hasHan(localizeErrorMessage(sample, 'en')) && !missing.has(sample)) missing.set(sample, `${relative(directory, file)}:${literal.line} ${callee}`);
    }
  }
  return [...missing].map(([text, where]) => `${where}  ${text}`);
}
test('every Chinese error text in the host and the SDK has an English entry in the catalog', () => {
  const missing = [...uncovered(root), ...uncovered(sdkRoot)];
  assert.deepEqual(missing, [], `add these to prototypes/control-center/api-error-catalog/ (an entry may use {1}, {2} for the parts that vary), or write the text as a { zh, en } pair:\n  ${missing.join('\n  ')}`);
});
test('the scan sees what it is meant to see: quoted, template and optional-suffix literals', () => {
  const found = scanLiterals("fail('项目不存在', 404); throw new DomainError(`${key} 必须为文本${extra ? `：${extra}` : ''}`); const note = { zh: '你好' }; // fail('注释')\nrun(\"it\\'s 好\");");
  assert.deepEqual(found.map(row => [row.callees.at(-1) ?? '', row.kind, row.before.trim().endsWith('zh:')]), [['fail', "'", false], ['new DomainError', '`', false], ['', "'", true], ['run', '"', false]]);
  assert.deepEqual(sampleTexts(found[1]), ['X 必须为文本', 'X 必须为文本：X']); assert.equal(cook(found[3].raw), "it's 好");
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-error-text-')), app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false });
  await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const { project, session } = app.store.createProject({ name: 'Errors', workspace, initiative: { enabled: false } });
  const ask = async (method, path, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path.replace('<P>', project.id).replace('<S>', session.id)}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  return { app, project, session, ask };
}
const AREAS = {
  inbox: [
    ['GET', '/api/v2/projects/nope/inbox', undefined, 404, '项目不存在', 'Project not found'],
    ['GET', '/api/v2/projects/<P>/inbox?status=bogus', undefined, 400, 'status 必须为 active、all、unread、read 或 dismissed', 'status must be active, all, unread, read or dismissed'],
    ['GET', '/api/v2/projects/<P>/inbox/missing', undefined, 404, '收件箱中没有这条消息', 'This message is not in the inbox'],
    ['POST', '/api/v2/projects/<P>/inbox/missing', { action: 'read', extra: 1 }, 400, '请求只能包含 action（read、dismiss 或 act）', 'The request may only contain action (read, dismiss or act)'],
    ['GET', '/api/v2/projects/<P>/delivery-feedback?window=1y', undefined, 400, 'window 必须为 24h、7d 或 30d', 'window must be 24h, 7d or 30d']],
  'project permissions': [
    ['PATCH', '/api/projects/<P>/permissions', { workspace: 'bogus', background: 'read' }, 400, '项目权限配置无效', 'Invalid project permission configuration'],
    ['PATCH', '/api/projects/nope/permissions', { workspace: 'read', background: 'read' }, 404, '项目不存在', 'Project not found']],
  'mind routes': [
    ['GET', '/api/v2/projects/<P>/mind?status=bogus', undefined, 400, 'status 必须为 all 或 active', 'status must be all or active'],
    ['POST', '/api/v2/projects/<P>/mind/reconcile', { dryRun: 'yes' }, 400, '请求只能包含布尔值 dryRun 与 force', 'The request may only contain the booleans dryRun and force'],
    ['POST', '/api/v2/projects/<P>/mind/agenda/x/answer', {}, 400, '请求只能包含 text（1–4000 字）', 'The request may only contain text (1–4000 characters)']],
  'gene routes': [
    ['GET', '/api/v2/projects/<P>/genes/nope', undefined, 404, '基因不存在', 'Gene not found'],
    ['GET', '/api/v2/projects/<P>/genes/bad%ZZ', undefined, 400, '基因标识无效', 'Invalid gene identifier'],
    ['POST', '/api/v2/projects/<P>/genes/guard:x', { action: 'bogus' }, 400, '请求只能包含 action（confirm、revoke 或 rewrite）以及 rewrite 时的 text', 'The request may only contain action (confirm, revoke or rewrite) and, for rewrite, text']],
  schedules: [
    ['POST', '/api/projects/<P>/schedules', { requestId: 'not valid!' }, 400, '日程请求标识格式无效', 'Invalid schedule request identifier format'],
    ['POST', '/api/projects/<P>/schedules', { bogus: 1 }, 400, '日程包含无效字段。', 'The schedule has fields that are not allowed.'],
    ['PATCH', '/api/projects/<P>/schedules/nope', { enabled: true }, 404, '日程不存在', 'The schedule does not exist.']],
  'store text()': [
    ['POST', '/api/sessions', { title: '' }, 400, '会话标题 必须为 1–160 字符的文本', 'Session title must be 1–160 characters of text'],
    ['POST', '/api/sessions', { title: 'ok', model: 'm'.repeat(130) }, 400, '模型标签 必须为 1–120 字符的文本', 'Model label must be 1–120 characters of text']],
  'request layer': [
    ['GET', '/api/nope', undefined, 404, '路径或方法不存在', 'The path or method does not exist'],
    ['GET', '/api/sessions/nope', undefined, 404, '会话不存在', 'Session not found'],
    ['POST', '/api/sessions/<S>/messages', 'not an object', 400, '请求必须是 JSON 对象', 'The request must be a JSON object']]
};
test('HTTP errors read in the interface language: English when it is en, the same Chinese bytes when it is zh', async t => {
  const f = await serve(t);
  for (const [area, rows] of Object.entries(AREAS)) await t.test(area, async () => {
    for (const language of ['zh', 'en', 'zh']) {
      f.app.store.interfaceLanguage(language);
      for (const [method, path, input, status, zh, en] of rows) {
        const { status: got, body } = await f.ask(method, path, input), label = `${language} ${method} ${path}`;
        assert.equal(got, status, label); assert.deepEqual(body, { error: language === 'en' ? en : zh }, label);
        if (language === 'en') assert.ok(!hasHan(body.error), label);
      }
    }
  });
});
test('a Chinese error that carries a code keeps the code and the status while its text follows the language', async t => {
  const f = await serve(t);
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).archivedAt = new Date().toISOString(); });
  for (const [language, text] of [['zh', '请先恢复归档项目再修改权限'], ['en', 'Restore the archived project before changing permissions']]) {
    f.app.store.interfaceLanguage(language);
    const { status, body } = await f.ask('PATCH', '/api/projects/<P>/permissions', { workspace: 'read', background: 'read' });
    assert.equal(status, 409); assert.equal(body.error, text);
  }
});
test('an unexpected failure answers 500 in the interface language, without the internal message', async t => {
  const f = await serve(t); t.mock.method(console, 'error', () => {}); f.app.store.get = () => { throw new Error('secret internal detail /Users/x/state.json'); };
  for (const [language, text] of [['zh', '内部错误；状态未确认，请检查 daemon 日志'], ['en', 'Internal error; the state is unconfirmed, check the daemon log']]) {
    f.app.store.interfaceLanguage(language);
    const { status, body } = await f.ask('GET', '/api/sessions'); assert.equal(status, 500); assert.deepEqual(body, { error: text });
  }
});

test('host tool errors reach the model in English: a throw, a rejection and an error result; success output and English text are untouched', async () => {
  const declared = (name, execute) => ({ name, execute: englishToolExecute(execute) });
  const thrown = declared('t1', () => { throw new DomainError('项目不存在', 404); });
  assert.throws(() => thrown.execute('call-1'), error => error instanceof DomainError && error.message === 'Project not found' && error.status === 404, 'the same error object, so status and code survive');
  const rejected = declared('t2', async () => { throw Object.assign(new Error('会话标题 必须为 1–160 字符的文本'), { code: 'invalid_title' }); });
  await assert.rejects(rejected.execute('call-2'), { message: 'Session title must be 1–160 characters of text', code: 'invalid_title' });
  const returned = await declared('t3', async () => ({ isError: true, content: [{ type: 'text', text: '项目不存在' }, { type: 'image', data: 'x' }] })).execute('call-3');
  assert.deepEqual(returned, { isError: true, content: [{ type: 'text', text: 'Project not found' }, { type: 'image', data: 'x' }] });
  const structured = englishToolText(JSON.stringify({ ok: false, error: '项目不存在', detail: { reason: '基因不存在' } }, null, 2));
  assert.deepEqual(JSON.parse(structured), { ok: false, error: 'Project not found', detail: { reason: 'Gene not found' } }); assert.match(structured, /^\{\n  "ok"/, 'the layout of a JSON result is kept');
  const fine = { content: [{ type: 'text', text: '项目不存在' }] }; assert.equal(englishToolResult(fine), fine, 'a success result is the tool\'s own words, not an error');
  assert.equal(await declared('t4', () => 'plain').execute('call-4'), 'plain'); assert.equal(englishToolText('Already English'), 'Already English'); assert.equal(englishToolText('这句话没有收录'), '这句话没有收录');
});
