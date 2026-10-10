// Plan 2026-10-05 C2: the wake rows move out of hot state into a sidecar inside the journal root
// (`<state>.rna/metrics/wakes.jsonl`). State keeps only the newest rows (display, the daily fold, a rollback); a start
// imports whatever a release before 0.69 wrote there, so a rollback followed by an upgrade loses no row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeLog, wakeLogFile, wakeRowKey, readWakeLog, WAKE_STATE_TAIL, WAKE_LOG_DAYS } from '../wake-log.mjs';
import { metricsRoot } from '../metrics-rollup.mjs';
import { advanceWake } from '../proactive-pacing.mjs';

const MIN = 60000, DAY = 86400000, NOW = Date.parse('2026-10-05T12:00:00Z');
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'rna-c2-wakes-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, stateFile: join(dir, 'state.json') }; };
const row = (n, extra = {}) => ({ at: new Date(NOW - n * MIN).toISOString(), outcome: 'thought', floor: false, ...extra });
/** A store with the part state the log reads: projects, and mutate over it. */
const fakeStore = projects => ({ state: { projects }, mutations: 0, mutate(fn) { this.mutations++; fn(this.state); } });
const projectWith = (id, history) => ({ id, mind: { pacing: { wake: { level: 0, history } } } });

test('the log is a sidecar inside the journal root; a row is recorded once and found by the action it started', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile);
  assert.equal(file, `${stateFile}.rna/metrics/wakes.jsonl`);
  const log = new WakeLog({ file, now: () => NOW });
  const work = row(5, { outcome: 'work', pending: true, actionId: 'a1', tier: 'request', tierFacts: ['open_commitment'], gate: { ledgerId: 'L1', deferred: ['D1'] } });
  assert.equal(log.append('p1', work), true); assert.equal(log.append('p1', work), false, 'the same row is not recorded twice');
  assert.equal(log.append('p2', work), true, 'ids are per project');
  assert.equal(log.byAction('p1', 'a1').gate.ledgerId, 'L1'); assert.equal(log.byAction('p1', 'nope'), null);
  assert.deepEqual(log.rows('p1').map(wakeRowKey), [wakeRowKey(work)]);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  // A restart reads the same rows back.
  const again = new WakeLog({ file, now: () => NOW });
  assert.equal(again.byAction('p1', 'a1').tier, 'request'); assert.equal(again.append('p1', work), false);
  assert.deepEqual(Object.keys(readWakeLog(file)).sort(), ['p1', 'p2']);
});

test('rows older than the retention leave; a deleted project\'s rows go; lines of an unknown kind survive a rewrite', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile); let now = NOW;
  mkdirSync(metricsRoot(stateFile), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ t: 'future', at: NOW + 40 * DAY, note: 'a later release' })}\n`);
  const log = new WakeLog({ file, now: () => now });
  log.append('p1', row(1)); log.append('p2', row(2, { outcome: 'work', actionId: 'a2' }));
  now += (WAKE_LOG_DAYS + 1) * DAY;
  log.append('p1', { at: new Date(now).toISOString(), outcome: 'thought', floor: false });
  log.prune();
  assert.deepEqual(log.rows('p1').map(r => r.at), [new Date(now).toISOString()]); assert.equal(log.byAction('p2', 'a2'), null);
  assert.ok(readFileSync(file, 'utf8').includes('"t":"future"'), 'the later release\'s line is kept');
  assert.equal(log.removeProject('p1'), 1); assert.deepEqual(log.rows('p1'), []);
  assert.ok(!readFileSync(file, 'utf8').includes('"projectId":"p1"'));
});

test('a start moves the rows an older release left in state into the log and trims state to its tail; the rows are on disk first', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile);
  const history = Array.from({ length: 30 }, (_, n) => row(30 - n));
  const store = fakeStore([projectWith('p1', history), projectWith('p2', [row(3)])]);
  const log = new WakeLog({ file, now: () => NOW });
  assert.equal(log.absorb(store), 31);
  assert.equal(store.state.projects[0].mind.pacing.wake.history.length, WAKE_STATE_TAIL); assert.deepEqual(store.state.projects[0].mind.pacing.wake.history, history.slice(-WAKE_STATE_TAIL), 'the newest rows stay');
  assert.equal(store.state.projects[1].mind.pacing.wake.history.length, 1, 'a shorter history is left as it is');
  assert.equal(readWakeLog(file).p1.length, 30, 'every row is in the file');
  // Idempotent: a second start imports nothing and writes nothing.
  const size = readFileSync(file, 'utf8').length, mutations = store.mutations;
  assert.equal(new WakeLog({ file, now: () => NOW }).absorb(store), 0);
  assert.equal(readFileSync(file, 'utf8').length, size); assert.equal(store.mutations, mutations);
});

test('a rollback to 0.68.0 and an upgrade back loses no wake: the rows the older release appended are imported', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile);
  const store = fakeStore([projectWith('p1', Array.from({ length: 20 }, (_, n) => row(40 - n)))]);
  assert.equal(new WakeLog({ file, now: () => NOW }).absorb(store), 20);
  // 0.68.0 runs: it reads the tail from state and appends its own rows, keeping 50.
  const wake = store.state.projects[0].mind.pacing.wake;
  for (let n = 0; n < 6; n++) store.state.projects[0].mind.pacing.wake = advanceWake(store.state.projects[0].mind.pacing.wake, 'thought', { now: NOW - (10 - n) * MIN });
  assert.equal(store.state.projects[0].mind.pacing.wake.history.length, WAKE_STATE_TAIL + 6, 'what 0.68.0 left: the tail plus its own');
  void wake;
  // The upgrade: its six rows are imported, the earlier ones are not duplicated.
  const log = new WakeLog({ file, now: () => NOW });
  assert.equal(log.absorb(store), 6);
  assert.equal(log.rows('p1').length, 26); assert.equal(store.state.projects[0].mind.pacing.wake.history.length, WAKE_STATE_TAIL);
});

test('a failed write leaves state as it was, and the next start imports again', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile);
  // Where the metrics directory should be there is a file: every write fails.
  writeFileSync(`${stateFile}.rna`, 'not a directory');
  const history = Array.from({ length: 12 }, (_, n) => row(12 - n)), store = fakeStore([projectWith('p1', history)]);
  const log = new WakeLog({ file, now: () => NOW });
  assert.equal(log.absorb(store), 0, 'nothing was saved');
  assert.equal(store.state.projects[0].mind.pacing.wake.history.length, 12, 'state kept every row');
  // A second absorb finds the rows already in memory: it is the mark, not the count, that makes it write again.
  assert.equal(log.absorb(store), 0); assert.equal(store.state.projects[0].mind.pacing.wake.history.length, 12);
  rmSync(`${stateFile}.rna`);
  assert.equal(log.absorb(store), 0, 'now it can write (the rows were already read)');
  assert.equal(store.state.projects[0].mind.pacing.wake.history.length, WAKE_STATE_TAIL); assert.equal(readWakeLog(file).p1.length, 12);
});

test('a row is reported saved only when it is on disk: a full disk keeps state\'s rows, and the next append heals the file from memory (review)', t => {
  const { stateFile } = temp(t), file = wakeLogFile(stateFile);
  // Where the metrics directory should be there is a file: every write fails (ENOTDIR, like a full disk).
  writeFileSync(`${stateFile}.rna`, 'not a directory');
  const log = new WakeLog({ file, now: () => NOW });
  assert.equal(log.append('p1', row(3, { outcome: 'work', actionId: 'a1' })), false, 'not saved: the caller keeps its own copy of the row');
  assert.equal(log.append('p1', row(2)), false);
  assert.equal(log.byAction('p1', 'a1').outcome, 'work', 'held in memory meanwhile');
  assert.equal(log.append('p1', row(2)), false, 'a row already held is not new either');
  // The disk comes back: the next row is written, and the file is rewritten from memory, so the rows that failed are in it.
  rmSync(`${stateFile}.rna`);
  assert.equal(log.append('p1', row(1)), true);
  assert.deepEqual(readWakeLog(file).p1.map(r => r.at), [row(3).at, row(2).at, row(1).at], 'every row, oldest first');
  assert.equal(log.unsaved, false);
  assert.equal(new WakeLog({ file, now: () => NOW }).byAction('p1', 'a1').outcome, 'work');
});

test('without a file the log lives in memory only (a bare store in a test)', () => {
  const log = new WakeLog({ now: () => NOW });
  assert.equal(log.append('p1', row(1, { actionId: 'a' })), true); assert.equal(log.byAction('p1', 'a').outcome, 'thought');
  assert.equal(existsSync(wakeLogFile('/nonexistent/state.json')), false);
});
