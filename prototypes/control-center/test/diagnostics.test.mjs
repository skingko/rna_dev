import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DiagnosticsService, PERSISTENT_ATTEMPTS, MAX_ITEMS, boundFindings } from '../diagnostics-service.mjs';
import { Store } from '../store.mjs';
import { ensureMind } from '../project-mind.mjs';

// Plan §4.2: diagnostics after edits. Real checkers, local files only.
function workspace(t) { const dir = mkdtempSync(join(tmpdir(), 'rna-diag-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('json, node --check and python compile report the broken line; clean files report nothing', async t => {
  const dir = workspace(t), service = new DiagnosticsService({ pythonPath: 'python3', ruffPath: 'ruff-not-installed' }); t.after(() => service.close());
  writeFileSync(join(dir, 'a.json'), '{\n  "a": 1,\n  "b": \n}\n');
  const json = await service.diagnose(dir, 'a.json');
  assert.equal(json.tool, 'json'); assert.equal(json.items[0].severity, 'error'); assert.equal(json.items[0].line, 4);
  writeFileSync(join(dir, 'b.mjs'), 'export const a = 1;\nexport const b = ;\n');
  const node = await service.diagnose(dir, 'b.mjs');
  assert.equal(node.tool, 'node'); assert.equal(node.items[0].line, 2); assert.match(node.items[0].message, /SyntaxError/);
  writeFileSync(join(dir, 'ok.mjs'), 'export const a = 1;\n');
  assert.deepEqual((await service.diagnose(dir, 'ok.mjs')).items, []);
  writeFileSync(join(dir, 'c.py'), 'def f(:\n    pass\n');
  const py = await service.diagnose(dir, 'c.py');
  assert.ok(py === null || py.items[0]?.severity === 'error', 'python3 present: a syntax error; absent: nothing');
  assert.equal(await service.diagnose(dir, 'node_modules/x/a.js'), null, 'dependencies are never checked');
  assert.equal(await service.diagnose(dir, '../outside.json'), null);
});

test('a file\'s findings are kept in line order and cut at the bound; a cut list says so (a baseline relies on it)', () => {
  const rows = Array.from({ length: MAX_ITEMS + 5 }, (_, index) => ({ line: MAX_ITEMS + 5 - index, column: 1, severity: 'error', code: 'E', message: `m${MAX_ITEMS + 5 - index}` }));
  const cut = boundFindings('typescript', [{ line: null, column: null, severity: 'error', code: 'E', message: 'no line' }, ...rows]);
  assert.equal(cut.items.length, MAX_ITEMS); assert.equal(cut.truncated, true);
  assert.deepEqual(cut.items.map(row => row.line), Array.from({ length: MAX_ITEMS }, (_, index) => index + 1), 'the first lines, in order; no line goes last');
  const whole = boundFindings('ruff', [{ line: 3, column: 9 }, { line: 3, column: 2 }, { line: 1, column: 5 }]);
  assert.deepEqual(whole, { tool: 'ruff', items: [{ line: 1, column: 5 }, { line: 3, column: 2 }, { line: 3, column: 9 }] }, 'nothing cut: no flag');
});

test('typescript 7: a stop ends the whole-project check at once and answers nothing', { timeout: 30000 }, async t => {
  const dir = workspace(t), service = new DiagnosticsService({ firstTimeoutMs: 12000 }); t.after(() => service.close());
  // A stand-in for the native compiler that never finishes on its own.
  mkdirSync(join(dir, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"7.0.0"}');
  writeFileSync(join(dir, 'node_modules', 'typescript', 'lib', 'tsc.js'), "require('node:fs').writeFileSync('started.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  const controller = new AbortController();
  const checking = service.diagnose(dir, 'a.ts', { signal: controller.signal });
  for (let tries = 0; !existsSync(join(dir, 'started.pid')) && tries < 400; tries++) await delay(10);
  const pid = Number(readFileSync(join(dir, 'started.pid'), 'utf8'));
  const stoppedAt = Date.now(); controller.abort();
  assert.equal(await checking, null, 'an interrupted check is no finding (and never a clean file)');
  assert.ok(Date.now() - stoppedAt < 3000, `answered right after the stop (${Date.now() - stoppedAt} ms)`);
  let alive = true; for (let tries = 0; alive && tries < 100; tries++) { try { process.kill(pid, 0); await delay(20); } catch { alive = false; } }
  assert.equal(alive, false, 'the compiler process is gone');
});

test('a pre-write baseline waits at most a warm check\'s bound: a slower check is stopped and gives no baseline; a cut-off check is never a clean file', { timeout: 30000 }, async t => {
  const dir = workspace(t), service = new DiagnosticsService({ timeoutMs: 1500, firstTimeoutMs: 5000 }); t.after(() => service.close());
  // A stand-in for the native compiler (TypeScript 7: a whole-project tsc) that prints nothing and never finishes.
  mkdirSync(join(dir, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"7.0.0"}');
  writeFileSync(join(dir, 'node_modules', 'typescript', 'lib', 'tsc.js'), "require('node:fs').appendFileSync('started.pid', process.pid + '\\n'); setInterval(() => {}, 1000);\n");
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  const hook = service.hook({ workspace: dir });
  assert.equal(hook.takesText('a.ts'), false, 'the native compiler reads the file itself: its baseline is taken before the write');
  const startedAt = Date.now();
  assert.equal(await hook.baseline('a.ts'), null, 'no answer within the bound: no baseline (and never a clean one)');
  assert.ok(Date.now() - startedAt < 4000, `the write waited the warm bound, not the compiler's (${Date.now() - startedAt} ms)`);
  const pid = Number(readFileSync(join(dir, 'started.pid'), 'utf8').split('\n')[0]);
  let alive = true; for (let tries = 0; alive && tries < 100; tries++) { try { process.kill(pid, 0); await delay(20); } catch { alive = false; } }
  assert.equal(alive, false, 'the stopped check\'s process is gone');
  // The project's check does not fit in the bound: the next write is not held for it at all.
  const again = Date.now(); assert.equal(await hook.baseline('a.ts'), null); assert.ok(Date.now() - again < 200, 'not asked again');
  assert.equal(readFileSync(join(dir, 'started.pid'), 'utf8').trim().split('\n').length, 1, 'no second compiler run');
  // The check after a write has the compiler's own bound; cut off there, it printed no errors, but that is no answer.
  assert.equal(await service.diagnose(dir, 'a.ts'), null);
  // A whole-project check that fits in the bound again lets baselines be taken again.
  writeFileSync(join(dir, 'node_modules', 'typescript', 'lib', 'tsc.js'), "process.stdout.write('a.ts(1,14): error TS2322: Type mismatch.\\n'); process.exit(2);\n");
  assert.deepEqual((await service.diagnose(dir, 'a.ts')).items.map(row => row.code), ['TS2322']);
  assert.deepEqual((await hook.baseline('a.ts')).items.map(row => row.code), ['TS2322']);
});

test('typescript: the workspace\'s own compiler reports type errors through a warm language service', { timeout: 60000 }, async t => {
  const dir = workspace(t), service = new DiagnosticsService({ firstTimeoutMs: 45000 }); t.after(() => service.close());
  mkdirSync(join(dir, 'node_modules')); symlinkSync(resolve('web/node_modules/typescript'), join(dir, 'node_modules', 'typescript'));
  writeFileSync(join(dir, 'package.json'), '{"name":"t","type":"module"}');
  writeFileSync(join(dir, 'a.ts'), 'export const count: number = "three";\n');
  const first = await service.diagnose(dir, 'a.ts');
  assert.equal(first.tool, 'typescript'); assert.equal(first.items[0].code, 'TS2322'); assert.equal(first.items[0].line, 1);
  writeFileSync(join(dir, 'a.ts'), 'export const count: number = 3;\n');
  assert.deepEqual((await service.diagnose(dir, 'a.ts')).items, [], 'the warm service sees the edit');
});

test('hook: errors always, warnings only when judged to matter; three failed fixes in a turn ask to stop; an error code in three turns becomes a lesson to confirm', async t => {
  const dir = workspace(t), store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'App', workspace: dir, initiative: { enabled: false } });
  store.mutate(state => ensureMind(state.projects.find(row => row.id === project.id)));
  const invited = [];
  const service = new DiagnosticsService({ store, mind: { inviteLesson: (projectId, id) => invited.push(id) }, decisions: { diagnosticsDelivery: async (_project, input) => ({ deliver: input.warnings.map((row, index) => row.code === 'W-bug' ? index : -1).filter(index => index >= 0) }) } });
  t.after(() => service.close());
  service.diagnose = async () => ({ tool: 'fake', items: [{ line: 3, severity: 'error', code: 'E1', message: 'broken' }, { line: 4, severity: 'warning', code: 'W-style', message: 'style' }, { line: 5, severity: 'warning', code: 'W-bug', message: 'likely bug' }] });
  const current = () => store.state.projects.find(row => row.id === project.id);
  let hook = service.hook({ project: current(), workspace: dir, turnId: 't1', request: '修复登录' });
  const first = await hook.run('a.ts');
  assert.deepEqual(first.errors.map(row => row.code), ['E1']); assert.deepEqual(first.warnings.map(row => row.code), ['W-bug']); assert.equal(first.withheld, 1); assert.equal(first.persistent, false);
  await hook.run('a.ts');
  assert.equal((await hook.run('a.ts')).persistent, true, `after ${PERSISTENT_ATTEMPTS} failed fixes`);
  for (const turnId of ['t2', 't3']) await service.hook({ project: current(), workspace: dir, turnId }).run('b.ts');
  const entry = current().diagnostics.codes.E1;
  assert.deepEqual(entry.turns, ['t1', 't2', 't3']); assert.ok(entry.lessonId);
  const lesson = current().mind.lessons.find(row => row.id === entry.lessonId);
  assert.equal(lesson.kind, 'pitfall'); assert.equal(lesson.needsConfirmation, true); assert.match(lesson.text, /E1/); assert.deepEqual(invited, [entry.lessonId]);
});

// TypeScript ≤ 6 uses the warm language service in a child process. Point RNA_TEST_TYPESCRIPT5 at a
// typescript@5 package directory to run it (the repository itself ships TypeScript 7).
test('typescript 5: the language service worker reports and then clears a type error', { skip: !process.env.RNA_TEST_TYPESCRIPT5, timeout: 60000 }, async t => {
  const dir = workspace(t), service = new DiagnosticsService({ firstTimeoutMs: 45000 }); t.after(() => service.close());
  mkdirSync(join(dir, 'node_modules')); symlinkSync(resolve(process.env.RNA_TEST_TYPESCRIPT5), join(dir, 'node_modules', 'typescript'));
  writeFileSync(join(dir, 'package.json'), '{"name":"t","type":"module"}');
  writeFileSync(join(dir, 'a.ts'), 'export const count: number = "three";\n');
  assert.equal((await service.diagnose(dir, 'a.ts')).items[0].code, 'TS2322');
  writeFileSync(join(dir, 'a.ts'), 'export const count: number = 3;\n');
  assert.deepEqual((await service.diagnose(dir, 'a.ts')).items, []);
});

test('typescript 5: a request with the pre-write text answers for it too, checked in memory beside the file as written', { skip: !process.env.RNA_TEST_TYPESCRIPT5, timeout: 60000 }, async t => {
  const dir = workspace(t), service = new DiagnosticsService({ firstTimeoutMs: 45000 }); t.after(() => service.close());
  mkdirSync(join(dir, 'node_modules')); symlinkSync(resolve(process.env.RNA_TEST_TYPESCRIPT5), join(dir, 'node_modules', 'typescript'));
  writeFileSync(join(dir, 'package.json'), '{"name":"t","type":"module"}');
  writeFileSync(join(dir, 'b.ts'), 'export const helperRenamed = 1;\n');
  assert.equal(service.hook({ workspace: dir }).takesText('a.ts'), true);
  // The file as written has the old import error plus a new one; the pre-write text had only the import error.
  writeFileSync(join(dir, 'a.ts'), "import { helper } from './b.js';\nexport const one = helper;\nexport const count: number = 'three';\n");
  const both = await service.diagnose(dir, 'a.ts', { before: "import { helper } from './b.js';\nexport const one = helper;\n" });
  assert.deepEqual(both.before.items.map(row => [row.line, row.code]), [[1, 'TS2305']], 'the pre-write text, with the program as it is now');
  assert.deepEqual(both.items.map(row => [row.line, row.code]), [[1, 'TS2305'], [3, 'TS2322']], 'the file as written');
  assert.deepEqual((await service.diagnose(dir, 'a.ts')).items.map(row => row.code), ['TS2305', 'TS2322'], 'the overlay is gone after the request');
});
