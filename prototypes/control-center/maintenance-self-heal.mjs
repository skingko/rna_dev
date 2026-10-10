import { changeMaintenance, maintenanceOwnerAlive, maintenanceTerminal } from './application-maintenance-state.mjs';
import { startMaintenanceWorker } from './application-maintenance.mjs';

// Plan 2026-09-30 §5 (D6): the upgrade chain heals itself where it used to wait
// for `./rna recovery resume`. When the new service is up but the update was
// left held because its readiness check ran out of time (a slow first start,
// a memory service still warming up), the running service resumes the same
// maintenance worker after a pause — the worker repeats every identity and
// readiness check itself. A few tries, then it stays held for a person.
// Restores, identity changes and every other failure are never touched.
export const SELF_HEAL_CODES = Object.freeze(['maintenance_verification_failed', 'maintenance_start_unconfirmed']);
export const SELF_HEAL_LIMIT = 3, SELF_HEAL_DELAY_MS = 60000, SELF_HEAL_EVERY_MS = 15000;

/** Whether a held operation may be resumed automatically now. */
export function selfHealable(row, { now = Date.now(), seenAt = now } = {}) {
  if (!row || maintenanceTerminal(row.phase) || row.phase !== 'recovery_required' || row.held !== true) return false;
  if (!SELF_HEAL_CODES.includes(row.errorCode) || row.restoreCompleted || maintenanceOwnerAlive(row)) return false;
  const attempts = row.selfHeal?.attempts ?? 0, last = Date.parse(row.selfHeal?.lastAt ?? '') || seenAt;
  return attempts < SELF_HEAL_LIMIT && now - last >= SELF_HEAL_DELAY_MS;
}

export class MaintenanceSelfHeal {
  constructor(store, { gate, launch = startMaintenanceWorker, now = Date.now, everyMs = SELF_HEAL_EVERY_MS } = {}) {
    Object.assign(this, { store, gate, launch, now });
    this.seen = new Map(); this.running = null;
    this.timer = setInterval(() => { void this.tick(); }, everyMs); this.timer.unref?.();
  }
  /** One check: resume the held operation once it has waited long enough; returns the operation id when resumed. */
  async tick() {
    if (this.running) return null;
    const row = this.gate?.row;
    if (!row?.id) return null;
    if (!this.seen.has(row.id)) this.seen.set(row.id, this.now());
    if (!selfHealable(row, { now: this.now(), seenAt: this.seen.get(row.id) })) return null;
    this.running = (async () => {
      let claimed = false;
      // Count the attempt under the maintenance lock, re-checking the journal as it is now.
      await changeMaintenance(this.store.file, row.id, value => {
        if (!selfHealable(value, { now: this.now(), seenAt: this.seen.get(row.id) })) return value;
        claimed = true;
        return { ...value, selfHeal: { attempts: (value.selfHeal?.attempts ?? 0) + 1, lastAt: new Date(this.now()).toISOString() }, summary: '新服务已启动，正在自动重新核对就绪状态。' };
      });
      if (!claimed) return null;
      await this.launch({ stateFile: this.store.file, id: row.id });
      return row.id;
    })().catch(() => null).finally(() => { this.running = null; });
    return this.running;
  }
  close() { clearInterval(this.timer); }
}
