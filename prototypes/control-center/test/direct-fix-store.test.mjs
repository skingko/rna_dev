import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectFixRecorder, saveDirectFix, revertDirectFix, discardDirectFix } from '../direct-fix-store.mjs';
import { combineDirectHandle, directHandleTemplate, lintDecisionTemplate, validateSpecTemplate } from '../../../packages/sdk/src/decision-templates.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-direct-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'ws'), store = join(dir, 'fixes'); mkdirSync(join(root, '正文'), { recursive: true });
  return { root, store };
}

test('snapshots are taken once before the first change; revert restores edits and removes created files', t => {
  const { root, store } = workspace(t);
  writeFileSync(join(root, '正文/第001章.md'), '周一来走进雾里。'); writeFileSync(join(root, 'untouched.md'), 'same');
  const recorder = new DirectFixRecorder(root);
  recorder.capture('正文/第001章.md'); writeFileSync(join(root, '正文/第001章.md'), '周一鸣走进雾里。');
  recorder.capture('正文/第001章.md'); writeFileSync(join(root, '正文/第001章.md'), '周一鸣走进雾里。\n');
  recorder.capture('notes/新增.md'); mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes/新增.md'), 'new');
  recorder.capture('untouched.md'); recorder.capture('../outside.md');
  const changes = recorder.changes();
  assert.deepEqual(changes.map(row => row.path).sort(), ['notes/新增.md', '正文/第001章.md'], 'unchanged and outside files are not part of the fix');
  const files = saveDirectFix(store, 'fix1', changes);
  assert.equal(JSON.stringify(files).includes('周一来'), false, 'the manifest in state carries no file bodies');
  const result = revertDirectFix(store, 'fix1', root, files);
  assert.deepEqual(result.restored.sort(), ['notes/新增.md', '正文/第001章.md']);
  assert.equal(readFileSync(join(root, '正文/第001章.md'), 'utf8'), '周一来走进雾里。');
  assert.equal(existsSync(join(root, 'notes/新增.md')), false);
  discardDirectFix(store, 'fix1'); assert.equal(existsSync(join(store, 'fix1')), false);
});

test('a file changed again after the fix is never overwritten by a revert', t => {
  const { root, store } = workspace(t);
  writeFileSync(join(root, 'a.md'), 'v1'); writeFileSync(join(root, 'b.md'), 'v1');
  const recorder = new DirectFixRecorder(root);
  for (const name of ['a.md', 'b.md']) { recorder.capture(name); writeFileSync(join(root, name), 'v2'); }
  const files = saveDirectFix(store, 'fix2', recorder.changes());
  writeFileSync(join(root, 'b.md'), 'v3 written by the user');
  const result = revertDirectFix(store, 'fix2', root, files);
  assert.deepEqual(result, { restored: ['a.md'], conflicts: ['b.md'], failed: [] });
  assert.equal(readFileSync(join(root, 'a.md'), 'utf8'), 'v1'); assert.equal(readFileSync(join(root, 'b.md'), 'utf8'), 'v3 written by the user');
});

test('initiative.direct needs every condition at high confidence', () => {
  const plan = directHandleTemplate();
  assert.deepEqual(lintDecisionTemplate(plan), []); assert.ok(validateSpecTemplate(plan));
  const b = probability => ({ type: 'boolean', probability });
  const yes = { proposes_file_changes: b(.96), objective_errors_only: b(.95), safe_without_user: b(.94) };
  assert.equal(combineDirectHandle(yes), true);
  for (const id of Object.keys(yes)) assert.equal(combineDirectHandle({ ...yes, [id]: b(.6) }), false, `${id} in doubt keeps the ask`);
  assert.equal(combineDirectHandle({ proposes_file_changes: b(.99), objective_errors_only: b(.99) }), false);
});
