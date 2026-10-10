import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evolutionHash } from './evolution.mjs';
import { createWorkspaceTools, workspacePrivateSegment } from './workspace-tools.mjs';
import { validateToolArguments } from './capabilities.mjs';
import { verifyJavascriptFunction } from './project-javascript-function.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const path = { type: 'string', minLength: 1, maxLength: 200 };
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,39}$' };
const boundedText = { type: 'string', maxLength: 64000 };
export const workspaceFixtureSchema = object({ files: { type: 'array', maxItems: 20, items: object({ path, content: boundedText }) } });
const check = (kind, properties = {}) => object({ id, kind: { const: kind }, path, ...properties });
export const PROJECT_ARTIFACT_VERIFIER_VERSION = 'host-file-and-function-assertions-v2';
export const evaluationWorkspaceSchema = object({
  files: workspaceFixtureSchema.properties.files,
  checks: { type: 'array', minItems: 1, maxItems: 24, items: { oneOf: [
    check('file_exists'), check('text_equals', { expected: boundedText }),
    check('text_includes', { values: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4000 } } }),
    check('json_equals', { expected: true }), check('javascript_syntax', { dialect: { enum: ['module', 'commonjs'] } }),
    check('javascript_function', { exportName: { type: 'string', pattern: '^[A-Za-z_$][A-Za-z0-9_$]{0,99}$' }, args: { type: 'array', maxItems: 32, items: true }, expected: true })
  ] } }
});
export const EVALUATION_WORKSPACE_TOOL_NAMES = ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit'];
const fail = (message, code = 'invalid_evaluation_workspace') => Object.assign(new Error(message), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateEvaluationWorkspace(value) {
  try { validateToolArguments(evaluationWorkspaceSchema, value); } catch (error) { throw fail(`Invalid evaluation workspace: ${error.message}`); }
  validateWorkspaceFixture({ files: value.files });
  if (new Set(value.checks.map(item => item.id)).size !== value.checks.length) throw fail('Artifact check IDs must be unique');
  validatePaths(value.checks);
  for (const item of value.checks) if ('expected' in item) {
    let encoded; try { encoded = JSON.stringify(item.expected); } catch { throw fail('Artifact expectations must be bounded JSON'); }
    if (encoded === undefined || Buffer.byteLength(encoded) > 64000) throw fail('Artifact expectations must be at most 64,000 JSON bytes');
  }
  for (const item of value.checks) if (item.kind === 'javascript_function' && Buffer.byteLength(JSON.stringify(item.args)) > 64000) throw fail('Function arguments must be at most 64,000 JSON bytes');
}
function validatePaths(entries) {
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (parts.length > 8 || !/^[\p{L}\p{N}_. -]+(?:\/[\p{L}\p{N}_. -]+)*$/u.test(entry.path) || parts.some(part => ['.', '..'].includes(part) || workspacePrivateSegment(part))) throw fail('Artifact paths must be safe relative non-private file paths');
  }
}
export function validateWorkspaceFixture(value) {
  try { validateToolArguments(workspaceFixtureSchema, value); } catch (error) { throw fail(`Invalid workspace fixture: ${error.message}`); }
  const paths = value.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || paths.some(a => paths.some(b => b.startsWith(`${a}/`)))) throw fail('Fixture files must have unique non-overlapping paths');
  validatePaths(value.files);
  for (const file of value.files) if (Buffer.byteLength(file.content) > 64000 || file.content.includes('\0')) throw fail('Each fixture file must be at most 64,000 UTF-8 bytes without NUL');
  if (value.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 128000) throw fail('A case may seed at most 128,000 UTF-8 bytes');
}
export async function prepareWorkspaceFixture(workspace, fixture, signal) {
  validateWorkspaceFixture(fixture);
  for (const file of fixture.files) {
    signal?.throwIfAborted(); const target = join(workspace, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
  }
}

export async function prepareEvaluationWorkspace(workspace, fixture, signal) {
  validateEvaluationWorkspace(fixture);
  await prepareWorkspaceFixture(workspace, { files: fixture.files }, signal);
  // Use the actual host filesystem contracts. Arbitrary shell, MCP, installation
  // and the user's real workspace are deliberately absent from this evaluator.
  return (await createWorkspaceTools(workspace, { includeMutations: true, maxFileBytes: 64000 })).filter(tool => EVALUATION_WORKSPACE_TOOL_NAMES.includes(tool.name));
}

async function readArtifact(workspace, path) {
  let target = workspace;
  for (const part of path.split('/')) { target = join(target, part); if ((await lstat(target)).isSymbolicLink()) throw fail('Artifact path is a symbolic link', 'artifact_path_denied'); }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 64000) throw fail('Artifact must be a regular text file within 64,000 bytes', 'artifact_file_invalid');
    const bytes = Buffer.alloc(64001); let size = 0;
    while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > 64000 || bytes.subarray(0, size).includes(0)) throw fail('Artifact is not bounded text', 'artifact_file_invalid');
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), bytes: size, hash: hash(bytes.subarray(0, size)) }; }
    catch { throw fail('Artifact is not valid UTF-8', 'artifact_file_invalid'); }
  } finally { await file.close(); }
}

function syntaxCheck(content, dialect, workspace, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // --check only parses stdin. No artifact code, imports, preload hooks or
    // package scripts execute; env is credential-free and NODE_OPTIONS absent.
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=64', '--check', `--input-type=${dialect}`], { cwd: workspace, env: { PATH: dirname(process.execPath), LANG: 'C' }, stdio: ['pipe', 'ignore', 'ignore'] });
    let failure;
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(fail('Artifact verification cancelled', 'aborted'));
    const timer = setTimeout(() => stop(fail('Syntax verifier exceeded its time limit', 'artifact_verifier_timeout')), 3000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.once('error', () => { failure ??= fail('Syntax verifier could not start', 'artifact_verifier_unavailable'); }); child.stdin.on('error', () => {});
    child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0 && code !== 1) reject(fail('Syntax verifier exited unexpectedly', 'artifact_verifier_unavailable')); else resolve(code === 0); });
    child.stdin.end(content);
  });
}

export async function verifyEvaluationWorkspace(workspace, fixture, signal) {
  validateEvaluationWorkspace(fixture); const checks = [], artifacts = [], loaded = new Map(); let remaining = 32000;
  for (const item of fixture.checks) {
    signal?.throwIfAborted(); let actual;
    try {
      actual = loaded.get(item.path) ?? await readArtifact(workspace, item.path);
      if (!loaded.has(item.path)) {
        loaded.set(item.path, actual); const limit = Math.min(8000, remaining); let preview = Buffer.from(actual.content).subarray(0, limit).toString('utf8');
        while (Buffer.byteLength(preview) > limit) preview = preview.slice(0, -1); remaining -= Buffer.byteLength(preview);
        artifacts.push({ path: item.path, hash: actual.hash, bytes: actual.bytes, content: preview, truncated: preview !== actual.content });
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'artifact_path_denied', 'artifact_file_invalid'].includes(error.code)) throw error;
      checks.push({ id: item.id, kind: item.kind, path: item.path, passed: false, code: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'artifact_missing' : error.code }); continue;
    }
    let passed = true, code = 'artifact_matches', functionReceipt;
    if (item.kind === 'text_equals') passed = actual.content === item.expected;
    else if (item.kind === 'text_includes') passed = item.values.every(value => actual.content.includes(value));
    else if (item.kind === 'json_equals') { try { passed = evolutionHash(JSON.parse(actual.content)) === evolutionHash(item.expected); } catch { passed = false; code = 'artifact_invalid_json'; } }
    else if (item.kind === 'javascript_syntax') { passed = await syntaxCheck(actual.content, item.dialect, workspace, signal); if (!passed) code = 'artifact_invalid_syntax'; }
    else if (item.kind === 'javascript_function') { functionReceipt = await verifyJavascriptFunction({ source: actual.content, exportName: item.exportName, args: item.args, expected: item.expected }, { workspace, signal }); ({ passed, code } = functionReceipt); }
    checks.push({ id: item.id, kind: item.kind, path: item.path, passed, code: passed ? 'artifact_matches' : code === 'artifact_matches' ? 'artifact_mismatch' : code, actualHash: actual.hash,
      ...(functionReceipt?.resultHash ? { resultHash: functionReceipt.resultHash, resultBytes: functionReceipt.resultBytes } : {}) });
  }
  signal?.throwIfAborted(); return { applicable: true, passed: checks.every(item => item.passed), checks, artifacts, verifier: PROJECT_ARTIFACT_VERIFIER_VERSION,
    executionClaim: fixture.checks.some(item => item.kind === 'javascript_function') ? 'file_contents_syntax_and_isolated_pure_functions' : 'file_contents_and_syntax_only' };
}
