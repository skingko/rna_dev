import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKPOINT_SIDECARS, excludedSibling } from '../state-checkpoint.mjs';
import { CacheSurvival, UsageLedger, cacheSurvivalFile, legacyCacheSurvivalFile } from '../usage-cache-service.mjs';
import { EffortCapture, captureRoot } from '../internal-reasoning.mjs';
import { removeProjectFiles } from '../project-files.mjs';

// Every `<state file>.<name>` the host writes must be known to checkpoints: an
// unknown sidecar fails the upgrade after the old service has stopped (0.43.0:
// `.background-changes`, first created by background work, blocked the upgrade).
// The release being replaced runs the checkpoint, so the entry must ship first.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** suffix → the source files that name it */
const sidecarMentions = () => {
  const found = new Map();
  for (const name of readdirSync(root).filter(name => name.endsWith('.mjs'))) {
    for (const match of readFileSync(join(root, name), 'utf8').matchAll(/\$\{(?:this\.)?(?:store\.)?(?:file|stateFile)\}(\.[a-z][a-z0-9.-]*[a-z0-9-])/g)) found.set(match[1], new Set([...(found.get(match[1]) ?? []), name]));
  }
  return found;
};
const writtenSuffixes = () => new Set(sidecarMentions().keys());
test('every state sidecar the host writes is in the checkpoint inventory or explicitly excluded', () => {
  const found = writtenSuffixes();
  assert.ok(found.size > 10);
  const unknown = [...found].filter(suffix => !CHECKPOINT_SIDECARS.includes(suffix) && !excludedSibling(suffix) && !excludedSibling(`${suffix}-`));
  assert.deepEqual(unknown, [], `add these to CHECKPOINT_SIDECARS (as a new generation) or exclude them: ${unknown.join(', ')}`);
});

// A rollback (or a failed-verification restore) puts the previous release back in charge of the next checkpoint, with
// whatever this release left beside state.json. So this release must not CREATE a sibling the previous release's
// inventory rejects: register it in one release, write it from the next. Frozen copy of 0.66.0's rules
// (state-checkpoint.mjs at b2b34c8); move it forward to the release this one replaces.
const PREVIOUS_RELEASE = '0.66.0';
const PREVIOUS_SIDECARS = Object.freeze(['', '.secrets', '.subscriptions', '.rna', '.pi', '.genomes', '.initialization', '.evolution', '.capabilities', '.archive', '.observations', '.d', '.skill-foundation', '.direct-fixes', '.background-changes']);
const previousExcluded = suffix => /^\.lock(?:\.sqlite(?:-(?:journal|wal|shm))?)?$/.test(suffix)
  || /^\.(?:before-|v1-backup(?:-|$)|legacy-|tmp-)/.test(suffix) || ['.service', '.recovery', '.recovery.json', '.checkpoints', '.releases'].includes(suffix)
  || /^\.usage-cache(?:\.survival\.json|\.jsonl)(?:\.\d+\.tmp)?$/.test(suffix);
const previousAccepts = suffix => PREVIOUS_SIDECARS.includes(suffix) || previousExcluded(suffix) || previousExcluded(`${suffix}-`);
// Names this release only reads once and removes (never creates), and the one file allowed to name each; each must
// stay excluded by the current release.
const REMOVED_ONLY = new Map([['.usage-cache.survival.json', 'usage-cache-service.mjs']]);
test(`no sidecar this release writes would block the checkpoint of ${PREVIOUS_RELEASE} after a rollback`, () => {
  for (const suffix of REMOVED_ONLY.keys()) assert.equal(excludedSibling(suffix), true, `${suffix} stays tolerated by this release`);
  const blocking = [...sidecarMentions()].filter(([suffix, files]) => !previousAccepts(suffix) && !(REMOVED_ONLY.has(suffix) && [...files].every(file => file === REMOVED_ONLY.get(suffix)))).map(([suffix, files]) => `${suffix} (${[...files].join(', ')})`);
  assert.deepEqual(blocking, [], `${PREVIOUS_RELEASE} would refuse these after a rollback; register them in this release and write them from the next: ${blocking.join(', ')}`);
});

test('the server keeps the learned cache survival in the journal root and removes a legacy sibling', async t => {
  const { createServer } = await import('../server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rna-survival-server-')), stateFile = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(legacyCacheSurvivalFile(stateFile), JSON.stringify({ version: 1, backfilledAt: '2026-10-03T00:00:00.000Z', models: {} }));
  const app = createServer({ stateFile, ticks: false, runtime: false, initiative: false }); await app.initializer.close();
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const survival = app.store.usageLedger.survival;
  assert.equal(survival.file, cacheSurvivalFile(stateFile));
  survival.close();
  assert.equal(existsSync(legacyCacheSurvivalFile(stateFile)), false);
  const siblings = readdirSync(dir).filter(name => name.startsWith('state.json.')).map(name => name.slice('state.json'.length));
  assert.deepEqual(siblings.filter(suffix => !previousAccepts(suffix)), [], `siblings: ${siblings.join(', ')}`);
});

test('the learned cache survival lives inside the journal root; a legacy sibling is migrated and removed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-survival-location-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), legacy = legacyCacheSurvivalFile(stateFile), now = Date.parse('2026-10-04T12:00:00Z');
  // What an unreleased build left beside state.json (plus a crash temp of its rewrite).
  const sample = { gapMs: 600000, warm: true, prompt: 100000, at: now - 1000 };
  writeFileSync(legacy, JSON.stringify({ version: 1, backfilledAt: '2026-10-03T00:00:00.000Z', models: { 'zhipu|glm-5.3': [sample] } }));
  writeFileSync(`${legacy}.4242.tmp`, '{}');
  const survival = new CacheSurvival({ file: cacheSurvivalFile(stateFile), legacyFile: legacy, now: () => now, debounceMs: 0 });
  assert.equal(survival.backfilledAt, '2026-10-03T00:00:00.000Z', 'the legacy samples are kept: no backfill is needed again');
  assert.equal(survival.learned('zhipu|glm-5.3').samples, 1);
  survival.close();
  assert.equal(existsSync(cacheSurvivalFile(stateFile)), true);
  assert.equal(existsSync(legacy), false); assert.equal(existsSync(`${legacy}.4242.tmp`), false);
  // A ledger record and a backfill write nothing new beside state.json that 0.65.0 would reject.
  const ledger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, survival: new CacheSurvival({ file: cacheSurvivalFile(stateFile), now: () => now, debounceMs: 0 }), now: () => now });
  ledger.record({ purpose: 'foreground', sessionId: 's', providerId: 'zhipu', modelId: 'glm-5.3', usage: { input: 1, cacheRead: 99000, cacheWrite: 0, cacheUsageReported: true }, continuity: { continuous: true, gapMs: 1200000, previousPromptTokens: 100000 } });
  assert.deepEqual(await ledger.survival.backfill({ stateFile, force: true }), { journals: 0, samples: 0 }, 'its own file in the journal root is not read as a conversation');
  ledger.survival.close();
  const siblings = readdirSync(dir).filter(name => name.startsWith('state.json.')).map(name => name.slice('state.json'.length));
  assert.deepEqual(siblings.filter(suffix => !previousAccepts(suffix)), [], `siblings: ${siblings.join(', ')}`);
});

test('the opt-in effort captures and replay reports live inside the journal root: nothing new beside state.json', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-effort-capture-location-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), projectId = '11111111-2222-4333-8444-555555555555';
  assert.equal(captureRoot(stateFile), join(`${stateFile}.rna`, 'effort-probe'));
  const capture = new EffortCapture({ stateFile });
  for (const purpose of ['decision', 'work', 'narrator', 'setup', 'compaction']) assert.ok(capture.record(projectId, purpose, { sessionIds: ['s1'] }));
  const reports = join(captureRoot(stateFile), 'replay'); mkdirSync(reports, { recursive: true }); writeFileSync(join(reports, 'r1.json'), '{}');
  const siblings = readdirSync(dir).filter(name => name.startsWith('state.json.')).map(name => name.slice('state.json'.length));
  assert.deepEqual(siblings, ['.rna']);
  assert.deepEqual(siblings.filter(suffix => !previousAccepts(suffix)), [], `${PREVIOUS_RELEASE} would refuse: ${siblings.join(', ')}`);
  // Its survival backfill does not read the captures as a conversation.
  const ledger = new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, survival: new CacheSurvival({ file: cacheSurvivalFile(stateFile), debounceMs: 0 }) });
  assert.deepEqual(await ledger.survival.backfill({ stateFile, force: true }), { journals: 0, samples: 0 });
  ledger.survival.close();
  await removeProjectFiles(stateFile, projectId);
  assert.equal(existsSync(join(captureRoot(stateFile), projectId)), false); assert.equal(existsSync(join(reports, 'r1.json')), true);
});
