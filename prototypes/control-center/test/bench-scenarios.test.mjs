import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFeatures, missingFeature, FEATURES } from '../benchmark/features.mjs';
import { runScenarios, loadScenarios, scenarioText } from '../benchmark/runner.mjs';
import { FakeClock, decisionRequest, scriptedModel, decide } from '../benchmark/harness.mjs';

function temp(t, prefix) { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const adapters = (t, files) => { const dir = temp(t, 'rna-bench-adapters-'); for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source); return dir; };
const MIND = `export default { available: () => true, read: (store, projectId) => store.state.projects.find(row => row.id === projectId)?.mind ?? null };\n`;

test('feature detection: absent adapters skip with reasons; adapters, availability and env overrides are honoured', async t => {
  const empty = await detectFeatures({ adapterDir: temp(t, 'rna-bench-none-'), env: {} });
  assert.deepEqual(Object.keys(empty), FEATURES);
  for (const feature of FEATURES) { assert.equal(empty[feature].available, false); assert.match(empty[feature].reason, /no benchmark[ /]adapter/); }
  const dir = adapters(t, { 'mind.mjs': MIND, 'capture.mjs': 'export default { available: () => false };\n', 'narrator.mjs': 'throw new Error("broken adapter");\n' });
  const found = await detectFeatures({ adapterDir: dir, env: {} });
  assert.equal(found.mind.available, true); assert.equal(typeof found.mind.adapter.read, 'function');
  assert.match(found.capture.reason, /reports unavailable/); assert.match(found.narrator.reason, /failed to load: broken adapter/);
  const restricted = await detectFeatures({ adapterDir: dir, env: { RNA_BENCH_FEATURES: 'none' } });
  assert.match(restricted.mind.reason, /RNA_BENCH_FEATURES/);
  assert.equal(missingFeature(found, ['mind']), null); assert.match(missingFeature(found, ['mind', 'capture']), /^requires capture: /);
});

test('runner: skip, pass, fail and error are reported without throwing', async t => {
  const dir = temp(t, 'rna-bench-scenarios-');
  writeFileSync(join(dir, 'a.mjs'), 'export default { id: "needs-mind", title: "t", requires: ["mind"], run: async () => [] };\n');
  writeFileSync(join(dir, 'b.mjs'), 'export default { id: "passes", title: "t", requires: [], run: async ({ check }) => [check("ok", true)] };\n');
  writeFileSync(join(dir, 'c.mjs'), 'export default { id: "fails", title: "t", requires: [], run: async ({ check }) => [check("ok", true), check("bad", false, { n: 1 })] };\n');
  writeFileSync(join(dir, 'd.mjs'), 'export default { id: "throws", title: "t", requires: [], run: async () => { throw Object.assign(new Error("kaput"), { code: "x" }); } };\n');
  const features = await detectFeatures({ adapterDir: temp(t, 'rna-bench-none-'), env: {} });
  const report = await runScenarios({ dir, features });
  assert.deepEqual(report.results.map(row => [row.id, row.status]), [['needs-mind', 'skip'], ['passes', 'pass'], ['fails', 'fail'], ['throws', 'error']]);
  assert.deepEqual(report.summary, { pass: 1, fail: 1, skip: 1, error: 1 });
  assert.match(report.results[0].reason, /requires mind/); assert.equal(report.results[3].code, 'x');
  assert.match(scenarioText(report), /\[SKIP\] needs-mind[\s\S]*FAIL bad — \{"n":1\}/);
  const forced = await runScenarios({ dir, features, force: true, only: ['needs-mind'] });
  assert.equal(forced.results[0].status, 'pass'); assert.match(forced.results[0].forced, /requires mind/);
});

test('the plan §5 suite declares nine scenarios (incl. coding and design projects); K1/K2-dependent ones skip on a branch without adapters', async t => {
  const scenarios = await loadScenarios();
  assert.equal(scenarios.length, 9);
  assert.deepEqual(scenarios.filter(row => row.requires.length).map(row => row.id).sort(), ['answered-question-closes-agenda', 'coding-nightly-build', 'design-deliverable', 'no-asks-after-preference', 'overnight-welcome-back', 'scheduled-report-rewritten']);
  const features = await detectFeatures({ adapterDir: temp(t, 'rna-bench-none-'), env: {} });
  const report = await runScenarios({ features, only: ['overnight-welcome-back', 'no-asks-after-preference', 'scheduled-report-rewritten', 'answered-question-closes-agenda'] });
  assert.deepEqual(report.results.map(row => row.status), ['skip', 'skip', 'skip', 'skip']);
});

test('a main-branch scenario drives the real initiative controller end to end', async t => {
  const features = await detectFeatures({ adapterDir: temp(t, 'rna-bench-none-'), env: {} });
  const report = await runScenarios({ features, only: ['decision-confirmed-within-one-wake'] });
  const [result] = report.results;
  assert.notEqual(result.status, 'error', result.reason);
  assert.ok(result.checks.find(row => row.name === 'first wake after the failed turn sees the decision').pass);
});

test('adapter-backed scenarios run once adapters exist (fake K1/K2 adapters)', async t => {
  const dir = adapters(t, {
    'mind.mjs': MIND,
    'capture.mjs': `export default { available: () => true, async captureUserMessage({ store, projectId, sessionId, itemId }) {
      const text = store.state.sessions.find(row => row.id === sessionId).items.find(row => row.id === itemId).text;
      store.mutate(state => { const project = state.projects.find(row => row.id === projectId); project.mind ??= { lessons: [], agenda: [], commitments: [], findings: [], threads: [], notes: { facts: [], preferences: [] } };
        for (const entry of project.mind.agenda) if (entry.status === 'open' && entry.kind === 'awaiting_user' && /平台/.test(entry.text) && /平台/.test(text)) { entry.status = 'done'; project.mind.notes.facts.push(text); } }); } };\n`,
    'narrator.mjs': `export default { available: () => true, async rewriteScheduled({ text }) { return text.split('\\n').filter(line => /^\\d\\./.test(line)).map(line => line.replace(/^\\d\\.\\s*/, '')).join('\\n'); } };\n`,
  });
  const features = await detectFeatures({ adapterDir: dir, env: {} });
  const report = await runScenarios({ features, only: ['answered-question-closes-agenda', 'scheduled-report-rewritten'] });
  for (const row of report.results) assert.equal(row.status, 'pass', `${row.id}: ${JSON.stringify(row.checks.filter(check => !check.pass))} ${row.reason ?? ''}`);
});

test('harness primitives: fake clock, request parsing and scripted repairs', async () => {
  const clock = new FakeClock('2026-10-01T00:00:00Z'); clock.advance(60000); clock.set('2026-09-01T00:00:00Z');
  assert.equal(clock.iso(), '2026-10-01T00:01:00.000Z', 'the fake clock never runs backwards');
  const input = { events: [{ id: 'e1', type: 'note' }] };
  const parsed = decisionRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }, { role: 'user', content: [{ type: 'text', text: 'broken. Final repair attempt.' }] }] });
  assert.deepEqual(parsed.input, input); assert.equal(parsed.repair, true);
  const model = scriptedModel(({ input: value }) => decide.share(value, 'x'));
  const chunks = []; for await (const chunk of model({ messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }] })) chunks.push(chunk);
  assert.equal(JSON.parse(chunks[0].delta).action, 'share'); assert.equal(model.calls.length, 1);
  const repaired = []; for await (const chunk of model({ messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }, { role: 'user', content: [{ type: 'text', text: 'Final repair attempt.' }] }] })) repaired.push(chunk);
  assert.equal(JSON.parse(repaired[0].delta).action, 'wait');
});
