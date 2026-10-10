import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStateFile } from '../state-shards.mjs';
import { extractFixtures, loadFixtures, sanitizeText, assertSafeOutput } from '../benchmark/extract.mjs';
import { computeProjectMetrics, datasetMetrics } from '../benchmark/metrics.mjs';
import { projectSideData } from '../benchmark/dataset.mjs';
import { validateRow } from '../benchmark/schemas.mjs';
import { LABEL_SCHEMA } from '../benchmark/labels.mjs';
import { main, parseArgs } from '../benchmark/cli.mjs';
import { syntheticState, PROJECT_ID, SYNTHETIC_NOW } from '../benchmark/examples/synthetic-state.mjs';

const NOW = Date.parse(SYNTHETIC_NOW);
function snapshot(directory) { const out = {}; const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else out[path] = createHash('sha256').update(readFileSync(path)).digest('hex'); } }; walk(directory); return out; }
function productionLike(t) {
  const root = mkdtempSync(join(tmpdir(), 'rna-bench-extract-')), stateDir = join(root, '.state'), stateFile = join(stateDir, 'state.json');
  mkdirSync(stateDir, { recursive: true });
  const { state, side } = syntheticState();
  state.sessions[0].items.find(item => item.id === 'u1').text = '继续开发关卡 /Users/someone/secret/game/main.js key sk-abcdefghijklmnopqrstuv 3f2a1b4c5d6e7f8091a2b3c4d5e6f708 a1b2c3d4-e5f6-4789-8abc-def012345678';
  writeStateFile(stateFile, state);
  for (const [namespace, rows] of [[`initiative/${PROJECT_ID}/decisions`, side.archivedDecisions], [`initiative/${PROJECT_ID}/failures`, side.wakeFailures]]) {
    const dir = join(`${stateFile}.archive`, namespace); mkdirSync(dir, { recursive: true });
    for (const row of rows) writeFileSync(join(dir, `${createHash('sha256').update(JSON.stringify(row)).digest('hex')}.json`), JSON.stringify(row));
  }
  writeFileSync(`${stateFile}.usage-cache.jsonl`, side.usageRows.map(row => JSON.stringify(row)).join('\n') + '\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, stateDir, stateFile };
}

test('extractor reads state read-only and writes a sanitized, versioned, valid fixture set', t => {
  const { root, stateDir, stateFile } = productionLike(t), out = join(root, 'fixtures'), before = snapshot(stateDir);
  const { dir, manifest } = extractFixtures({ stateFile, out, now: NOW });
  assert.deepEqual(snapshot(stateDir), before, 'source state directory is byte-for-byte unchanged');
  assert.equal(manifest.schema, 'rna-bench-fixtures/1'); assert.equal(manifest.version, 'v1');
  const counts = manifest.projects[0].counts;
  assert.equal(counts.proactive, 6); assert.equal(counts.decisions, 4, 'state + archive decisions are merged and de-duplicated');
  assert.equal(counts['wake-failures'], 2); assert.equal(counts.usage, 4); assert.equal(counts['user-messages'], 6); assert.equal(counts.scheduled, 1); assert.equal(counts.commitments, 1);
  const rows = kind => readFileSync(join(dir, PROJECT_ID, `${kind}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const kind of ['messages', 'user-messages', 'proactive', 'decisions', 'turns', 'commitments', 'scheduled', 'usage', 'wake-failures']) for (const row of rows(kind)) assert.deepEqual(validateRow(kind, row), [], kind);
  const text = rows('user-messages').find(row => row.itemId === 'u1').text;
  assert.doesNotMatch(text, /Users\/someone|sk-abcdef|3f2a1b4c5d6e|a1b2c3d4-e5f6/); assert.match(text, /<path>/); assert.match(text, /<secret>/); assert.match(text, /<hash>/); assert.match(text, /<id>/);
  const proactive = rows('proactive').find(row => row.itemId === 'p1');
  assert.equal(proactive.presence.away, true); assert.equal(proactive.next.userItemId, 'u2'); assert.deepEqual(proactive.next.labels, ['correction']);
  const template = JSON.parse(readFileSync(join(out, 'labels.template.json'), 'utf8'));
  assert.equal(template.schema, LABEL_SCHEMA); assert.deepEqual(template.labels.u4.labels, ['preference', 'message_complaint']);
  assert.equal(existsSync(join(out, 'labels.json')), false, 'the editable label file is never overwritten or created');
});

test('extractor refuses to write inside the source state directory', t => {
  const { stateDir, stateFile } = productionLike(t);
  assert.throws(() => extractFixtures({ stateFile, out: join(stateDir, 'fixtures'), now: NOW }), { code: 'bench_output_unsafe' });
  assert.throws(() => assertSafeOutput(stateFile, stateDir), { code: 'bench_output_unsafe' });
  assert.equal(existsSync(join(stateDir, 'fixtures')), false);
});

test('fixture metrics reproduce live metrics, and manual labels override heuristics', t => {
  const { root, stateFile } = productionLike(t), out = join(root, 'fixtures');
  extractFixtures({ stateFile, out, now: NOW });
  const { state } = syntheticState();
  const live = computeProjectMetrics(state, PROJECT_ID, '7d', { now: NOW, side: projectSideData(stateFile, PROJECT_ID) });
  const fixture = datasetMetrics(loadFixtures(out).datasets[0], { window: '7d', now: NOW });
  assert.deepEqual(fixture.proactive, live.proactive); assert.deepEqual(fixture.learning, live.learning);
  writeFileSync(join(out, 'labels.json'), JSON.stringify({ schema: LABEL_SCHEMA, labels: { u3: { labels: ['correction'], topic: 'scene' }, u5: { add: [], remove: [], topic: 'scene' } } }));
  const relabelled = datasetMetrics(loadFixtures(out).datasets[0], { window: '7d', now: NOW });
  assert.equal(relabelled.learning.corrections, 3); assert.equal(relabelled.harness.coverage.labelsManual, 2);
  // Topic-labelled rows are grouped by topic only: u5 repeats u3 ("scene"); u3 is the first "scene" correction.
  assert.equal(relabelled.learning.repeatCorrections, 1);
});

test('bench CLI parses options and scores a fixture set offline', async t => {
  const { root, stateFile } = productionLike(t), out = join(root, 'fixtures');
  assert.deepEqual(parseArgs(['metrics', '--fixtures', '--window', '30d', '--project', 'a', '--project', 'b', '--json']), { _: ['metrics'], project: ['a', 'b'], fixtures: true, window: '30d', json: true });
  const logs = []; const log = line => logs.push(line);
  assert.equal(await main(['extract', '--state', stateFile, '--out', out, '--json'], { log }), 0);
  assert.equal(JSON.parse(logs.pop()).manifest.projects.length, 1);
  assert.equal(await main(['metrics', '--fixtures', out, '--window', '7d', '--now', SYNTHETIC_NOW, '--json'], { log }), 0);
  assert.equal(JSON.parse(logs.pop())[0].proactive.longestUnrepliedChain, 2);
  assert.equal(await main(['metrics', '--state', stateFile, '--window', 'all', '--now', SYNTHETIC_NOW], { log }), 0);
  assert.match(logs.pop(), /Synthetic ink game[\s\S]*useful 50%[\s\S]*repeat-correction 50%/);
  await assert.rejects(main(['compare', '--from-fixtures', out], { log }), /--dry-run/);
});
