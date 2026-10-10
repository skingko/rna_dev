import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyJavascriptFunction } from '../src/project-javascript-function.mjs';
import { validateEvaluationWorkspace, verifyEvaluationWorkspace } from '../src/project-evaluation-workspace.mjs';

const run = (source, args = [], expected = null, options) => verifyJavascriptFunction({ source, exportName: 'check', args, expected }, options);
const good = [
  ['arithmetic', 'export const check=(a,b)=>a+b;', [2, 3], 5],
  ['jump-boundary', 'export function check(distance,max){return {reachable:distance<=max,margin:max-distance};}', [5, 5], { reachable: true, margin: 0 }],
  ['jump-over-limit', 'export function check(distance,max){return distance<=max;}', [5.001, 5], false],
  ['deduplicate-records', 'export function check(rows){return [...new Map(rows.map(row=>[row.id,row])).values()];}', [[{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { id: 'b', n: 3 }]], [{ id: 'a', n: 2 }, { id: 'b', n: 3 }]],
  ['domain-validation', 'export function check(email){return email.slice(email.lastIndexOf("@")+1).toLowerCase()=== "example.com";}', ['User@EXAMPLE.COM'], true],
  ['unicode-json', 'export function check(value){return {title:value,rows:[true,false,null,0]};}', ['中文🧠'], { title: '中文🧠', rows: [true, false, null, 0] }],
];
for (const [name, source, args, expected] of good) test(`isolated pure ESM behavior: ${name}`, async () => {
  const result = await run(source, args, expected); assert.equal(result.passed, true, JSON.stringify(result));
  assert.match(result.resultHash, /^[a-f0-9]{64}$/); assert.ok(result.resultBytes > 0); assert.equal(result.value, undefined);
});
test('ESM export whitespace and declaration style do not determine behavior', async () => {
  for (const source of ['export function check ( x ) { return x * 2 }', 'function twice(x){return x+x}; export {twice as check};', 'export const check = (x) => { return 2*x; };']) assert.equal((await run(source, [4], 8)).passed, true);
});
test('wrong result fails with hash only, never publishing expected or actual data', async () => {
  const result = await run('export function check(){return "ACTUAL_PRIVATE";}', [], 'EXPECTED_PRIVATE');
  assert.equal(result.passed, false); assert.equal(result.code, 'artifact_mismatch'); assert.doesNotMatch(JSON.stringify(result), /ACTUAL_PRIVATE|EXPECTED_PRIVATE/);
});
for (const [name, source, code] of [
  ['thrown error', 'export function check(){throw new Error("PRIVATE_FAILURE");}', 'artifact_function_threw'],
  ['missing export', 'export const different=1;', 'artifact_export_not_function'],
  ['nonfunction export', 'export const check=1;', 'artifact_export_not_function'],
  ['invalid syntax', 'export function check( {', 'artifact_invalid_syntax'],
  ['async function', 'export async function check(){return 1;}', 'artifact_async_result'],
  ['Promise return', 'export function check(){return Promise.resolve(1);}', 'artifact_async_result'],
  ['undefined', 'export function check(){}', 'artifact_non_json_result'],
  ['NaN', 'export function check(){return NaN;}', 'artifact_non_json_result'],
  ['Infinity', 'export function check(){return Infinity;}', 'artifact_non_json_result'],
  ['BigInt', 'export function check(){return 1n;}', 'artifact_non_json_result'],
  ['cycle', 'export function check(){const x={};x.self=x;return x;}', 'artifact_non_json_result'],
  ['getter', 'export function check(){return {get answer(){return 1}};}', 'artifact_non_json_result'],
  ['class result', 'export function check(){return new Date(0);}', 'artifact_non_json_result'],
  ['sparse array', 'export function check(){return Array(2);}', 'artifact_non_json_result'],
  ['function field', 'export function check(){return {toJSON(){return 5}};}', 'artifact_non_json_result'],
]) test(`rejects ${name}`, async () => { const result = await run(source); assert.equal(result.passed, false); assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FAILURE/); });
test('static imports and re-exports are denied without reading external modules', async () => {
  for (const source of ['import fs from "node:fs"; export function check(){return true;}', 'export {readFileSync as check} from "node:fs";', 'import "./neighbor.mjs"; export function check(){return true;}']) assert.equal((await run(source)).code, 'artifact_import_denied');
});
test('caught dynamic imports are still denied and cannot supply a host error constructor escape', async () => {
  const result = await run('export function check(){import("node:fs").catch(e=>{ try { e.constructor.constructor("return process")(); } catch {} });return 1;}', [], 1);
  assert.equal(result.passed, false); assert.equal(result.code, 'artifact_import_denied');
});
test('process, require, Buffer, host environment and filesystem capabilities are absent', async () => {
  const previous = process.env.RNA_FUNCTION_TEST_PRIVATE; process.env.RNA_FUNCTION_TEST_PRIVATE = 'DO_NOT_EXPORT_TO_WORKER';
  try { assert.equal((await run('export function check(){return [typeof process,typeof require,typeof Buffer,typeof fetch,typeof console];}', [], ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'])).passed, true); }
  finally { if (previous === undefined) delete process.env.RNA_FUNCTION_TEST_PRIVATE; else process.env.RNA_FUNCTION_TEST_PRIVATE = previous; }
});
test('arguments are realm-local and cannot recover the host Function constructor', async () => {
  assert.equal((await run('export function check(value){try {value.constructor.constructor("return process")();return false;} catch {return true;}}', [{ safe: true }], true)).passed, true);
});
test('Promise identity cannot be hidden by changing its prototype', async () => {
  const result = await run('export function check(){const value=Promise.resolve(1);Object.setPrototypeOf(value,Object.prototype);return value;}', [], {});
  assert.equal(result.passed, false); assert.equal(result.code, 'artifact_async_result');
});
test('generated code and WebAssembly compilation remain disabled', async () => {
  const result = await run('export function check(){try {Function("return 1")();return false;} catch {return true;}}', [], true); assert.equal(result.passed, true);
  const wasm = await run('export function check(){try {new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));return false;} catch {return true;}}', [], true); assert.equal(wasm.passed, true);
});
test('module mutation of JSON and Object intrinsics cannot replace verifier output', async () => {
  const source = 'JSON.parse=()=>({fake:1}); JSON.stringify=()=>"ORACLE_FAKE"; Object.keys=()=>[];Object.getOwnPropertyDescriptors=()=>({});Array.prototype.toJSON=()=>"FAKE"; export function check(value){return {answer:value,rows:[2,3]};}';
  assert.equal((await run(source, [7], { answer: 7, rows: [2, 3] })).passed, true);
});
test('source-defined global setters cannot intercept the namespace transfer', async () => {
  const result = await run('Object.defineProperty(globalThis,"__rnaArtifactNamespace",{set(){while(true){}},get(){while(true){}}});export function check(){return 5;}', [], 5);
  assert.equal(result.passed, true);
});
test('malicious thrown objects are never inspected through authored getters in the host realm', async () => {
  for (const source of ['export function check(){throw new Proxy({}, {get(){while(true){}}});}', 'throw new Proxy({}, {get(){while(true){}}}); export function check(){return 1;}']) {
    const start = Date.now(), result = await run(source); assert.equal(result.passed, false); assert.ok(Date.now() - start < 4000);
  }
});
for (const [name, source] of [
  ['top-level loop', 'while(true){}; export function check(){return 1;}'],
  ['function loop', 'export function check(){while(true){}}'],
  ['microtask loop', 'Promise.resolve().then(()=>{while(true){}});export function check(){return 1;}'],
  ['serialization trap', 'export function check(){return new Proxy({}, {ownKeys(){while(true){}}});}'],
  ['unsettled top-level await', 'await new Promise(()=>{});export function check(){return 1;}'],
]) test(`bounded execution of ${name}`, async () => {
  const start = Date.now(), result = await run(source); assert.equal(result.passed, false); assert.ok(Date.now() - start < 4000, 'worker must finish or be killed');
});
test('oversized, excessively nested and explosive outputs are rejected without returning content', async () => {
  for (const source of ['export function check(){return "x".repeat(100000);}', 'export function check(){let x={};for(let i=0;i<100;i++)x={x};return x;}', 'export function check(){return Array(10000).fill(0);}']) {
    const result = await run(source); assert.equal(result.passed, false); assert.ok(JSON.stringify(result).length < 300);
  }
});
test('bounded Unicode results preserve multi-byte characters across process pipe chunks', async () => {
  assert.equal((await run('export function check(){return "中".repeat(19000);}', [], '中'.repeat(19000))).passed, true);
  assert.equal((await run('export function check(){return "中".repeat(24000);}', [], null)).code, 'artifact_result_limit');
});
test('cancellation kills the running worker and an already-aborted call never starts', async () => {
  const controller = new AbortController();
  const pending = run('export function check(){while(true){}}', [], null, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error.code === 'aborted');
  await assert.rejects(run('export function check(){return 1;}', [], 1, { signal: controller.signal }), error => error.name === 'AbortError');
});
test('workspace integrates pure-function checks without revealing their inputs or expected values in receipts', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'rna-artifact-function-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'logic.mjs'), 'export function check(value){return value + "-ok";}');
  const fixture = { files: [], checks: [{ id: 'logic_result', kind: 'javascript_function', path: 'logic.mjs', exportName: 'check', args: ['INPUT_PRIVATE'], expected: 'INPUT_PRIVATE-ok' }] };
  const result = await verifyEvaluationWorkspace(workspace, fixture);
  assert.equal(result.passed, true); assert.equal(result.executionClaim, 'file_contents_syntax_and_isolated_pure_functions');
  assert.equal(result.checks[0].passed, true); assert.match(result.checks[0].actualHash, /^[a-f0-9]{64}$/); assert.match(result.checks[0].resultHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /INPUT_PRIVATE/);
});
test('function fixture rejects invalid export names, non-JSON inputs, unbounded args and unbounded expectations', () => {
  const item = { id: 'valid', kind: 'javascript_function', path: 'logic.mjs', exportName: 'check', args: [], expected: null };
  for (const change of [{ exportName: 'x.y' }, { exportName: 'x;process.exit()' }, { args: [NaN] }, { args: Array(33).fill(1) }, { args: ['x'.repeat(64001)] }, { expected: 'x'.repeat(64001) }]) assert.throws(() => validateEvaluationWorkspace({ files: [], checks: [{ ...item, ...change }] }), { code: 'invalid_evaluation_workspace' });
});
