import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { persistMaintenance, readMaintenance } from '../application-maintenance-state.mjs';
import { MaintenanceSelfHeal, selfHealable, SELF_HEAL_DELAY_MS, SELF_HEAL_LIMIT } from '../maintenance-self-heal.mjs';

// Plan 2026-09-30 §5 (D6): an update held only because the readiness check ran
// out of time resumes itself after a pause, a few times at most.
function fixture(t, fields = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-self-heal-')), file = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = persistMaintenance(file, { schemaVersion: 1, id: randomUUID(), kind: 'apply', phase: 'recovery_required', held: true, errorCode: 'maintenance_verification_failed', owner: null, ...fields });
  let clock = Date.parse('2026-09-30T10:00:00Z');
  const launched = [], gate = { get row() { return readMaintenance(file); } };
  const heal = new MaintenanceSelfHeal({ file }, { gate, launch: async input => { launched.push(input); }, now: () => clock, everyMs: 3600000 });
  t.after(() => heal.close());
  return { file, row, launched, heal, advance: ms => { clock += ms; } };
}

test('a readiness timeout is resumed after a pause, counted, and given up after a few tries', async t => {
  const f = fixture(t);
  assert.equal(await f.heal.tick(), null, 'not at once: the first sighting starts the pause');
  f.advance(SELF_HEAL_DELAY_MS - 1000); assert.equal(await f.heal.tick(), null);
  f.advance(2000); assert.equal(await f.heal.tick(), f.row.id);
  assert.deepEqual(f.launched, [{ stateFile: f.file, id: f.row.id }]);
  const saved = readMaintenance(f.file);
  assert.equal(saved.selfHeal.attempts, 1); assert.equal(saved.held, true, 'the worker, not the check, clears the hold');
  assert.equal(await f.heal.tick(), null, 'the next try waits again');
  for (let attempt = 2; attempt <= SELF_HEAL_LIMIT; attempt++) { f.advance(SELF_HEAL_DELAY_MS); assert.equal(await f.heal.tick(), f.row.id); }
  f.advance(SELF_HEAL_DELAY_MS * 10); assert.equal(await f.heal.tick(), null, 'after the limit it stays held for a person');
  assert.equal(f.launched.length, SELF_HEAL_LIMIT);
});

test('other failures, data restores, live owners and finished operations are never resumed', () => {
  const base = { phase: 'recovery_required', held: true, errorCode: 'maintenance_verification_failed' }, now = Date.now(), seenAt = now - SELF_HEAL_DELAY_MS * 2;
  assert.equal(selfHealable(base, { now, seenAt }), true);
  assert.equal(selfHealable({ ...base, errorCode: 'maintenance_start_unconfirmed' }, { now, seenAt }), true);
  for (const errorCode of ['maintenance_identity_changed', 'maintenance_native_access_denied', 'restored_state_review', 'maintenance_operation_failed']) assert.equal(selfHealable({ ...base, errorCode }, { now, seenAt }), false, errorCode);
  assert.equal(selfHealable({ ...base, restoreCompleted: true }, { now, seenAt }), false);
  assert.equal(selfHealable({ ...base, owner: { pid: process.pid, birth: 'x' } }, { now, seenAt }) , true, 'a dead or mismatched owner does not block');
  assert.equal(selfHealable({ ...base, phase: 'completed', held: false }, { now, seenAt }), false);
  assert.equal(selfHealable({ ...base, held: false }, { now, seenAt }), false);
  assert.equal(selfHealable(null), false);
});
