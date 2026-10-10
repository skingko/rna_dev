import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evolutionHash } from './evolution.mjs';
import { validateToolArguments } from './capabilities.mjs';

const workerSource = readFileSync(new URL('./project-javascript-function-worker.mjs', import.meta.url), 'utf8');
const failure = (message, code) => Object.assign(new Error(message), { code });
const codes = new Set(['artifact_function_input_limit', 'artifact_function_input_invalid', 'artifact_export_unavailable', 'artifact_export_not_function',
  'artifact_function_threw', 'artifact_async_result', 'artifact_non_json_result', 'artifact_invalid_syntax', 'artifact_import_denied',
  'artifact_module_failed', 'artifact_result_limit', 'artifact_function_timeout']);

/** Optional behavior check. Expected values never leave this host closure;
 * receipts disclose result hashes/size only, not hidden inputs or the oracle. */
export async function verifyJavascriptFunction({ source, exportName, args, expected }, { workspace, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64000 || typeof exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(exportName) || !Array.isArray(args) || args.length > 32) throw failure('Invalid JavaScript function check input', 'invalid_evaluation_workspace');
  try { validateToolArguments({ type: 'array', maxItems: 32, items: true }, args); validateToolArguments(true, expected); }
  catch { throw failure('JavaScript function inputs must be finite JSON', 'invalid_evaluation_workspace'); }
  let input;
  try { input = JSON.stringify({ source, exportName, args }); } catch { throw failure('JavaScript function arguments must be bounded JSON', 'invalid_evaluation_workspace'); }
  if (Buffer.byteLength(input) > 160000) throw failure('JavaScript function input exceeds limit', 'invalid_evaluation_workspace');
  return new Promise((resolve, reject) => {
    // No filesystem allowance is necessary: the trusted worker is passed as
    // --eval, and the authored module receives source bytes through stdin.
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=64', '--experimental-vm-modules', '--input-type=module', '--eval', workerSource],
      { cwd: workspace, env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let error, forcedCode, outputBytes = 0, errorBytes = 0; const output = [];
    const stop = code => { forcedCode ??= code; child.kill('SIGKILL'); };
    const abort = () => { error ??= failure('Artifact verification cancelled', 'aborted'); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('artifact_function_timeout'), 3000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 96000) stop('artifact_result_limit'); else output.push(bytes); });
    child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes > 16000) stop('artifact_worker_output_limit'); });
    child.stdin.on('error', () => {});
    child.once('error', () => { error ??= failure('JavaScript verifier could not start', 'artifact_verifier_unavailable'); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { reject(error); return; }
      if (forcedCode) { resolve({ passed: false, code: forcedCode }); return; }
      if (code !== 0) { resolve({ passed: false, code: 'artifact_worker_failed' }); return; }
      let response;
      try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output))); } catch { resolve({ passed: false, code: 'artifact_worker_invalid_response' }); return; }
      if (response?.ok === false && codes.has(response.code)) { resolve({ passed: false, code: response.code }); return; }
      if (response?.ok !== true || typeof response.encoded !== 'string' || Buffer.byteLength(response.encoded) > 64000 || Object.keys(response).sort().join(',') !== 'encoded,ok') { resolve({ passed: false, code: 'artifact_worker_invalid_response' }); return; }
      let actual;
      try { actual = JSON.parse(response.encoded); } catch { resolve({ passed: false, code: 'artifact_worker_invalid_response' }); return; }
      const passed = evolutionHash(actual) === evolutionHash(expected);
      resolve({ passed, code: passed ? 'artifact_matches' : 'artifact_mismatch', resultHash: createHash('sha256').update(response.encoded).digest('hex'), resultBytes: Buffer.byteLength(response.encoded) });
    });
    child.stdin.end(input);
  });
}
