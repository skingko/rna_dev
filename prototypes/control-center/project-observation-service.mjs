import { createHash } from 'node:crypto';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { createProjectEventInbox } from '../../packages/sdk/src/project-events.mjs';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { createWorkspaceObserver, fingerprintPaths } from './workspace-observer.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const stamp = now => new Date(now()).toISOString();
const real = p => p && !p.archivedAt && (p.simulated === false || p.decisionMode === 'rna-model') && isAbsolute(p.workspace ?? '');
const binding = p => hash([p.id, resolve(p.workspace)]);
const failure = (message, status = 400, code = 'observation_state_unavailable') => Object.assign(new Error(message), { status, code });
const defaultStats = () => ({ received: 0, coalesced: 0, suppressedDuringExecution: 0 });
const recent = (doc, row) => [...(doc.recent ?? []), row].slice(-8);
const committedStatuses = new Set(['baseline', 'unchanged', 'acknowledged', 'settling', 'changed']);
/** At most this many files of users' undos wait per project for the next committed scan (the oldest go first). */
const UNDO_PATHS = 4000;
/** A user's undo still writing after this long is taken as ended (its files are then reported like any change). */
const UNDO_WRITE_MAX_MS = 10 * 60000;
const activityKey = (state, p) => hash([p.archivedAt, p.workspace, p.initialization?.status, p.initiative?.enabled, p.rhythmRuntime?.assessment?.lifecycle,
  state.emergency, state.sessions.filter(s => s.projectId === p.id).map(s => [s.id, s.status, s.activeTurnId, s.items?.findLast(row => row.kind === 'user')?.id])]);

/** External metadata is evidence, never a user instruction. Every scanner and
 * inbox has one lifecycle queue; subscriptions only record stop/activity barriers. */
export class ProjectObservationService {
  constructor(store, { autoStart = true, now = Date.now, intervalMs = 15000, settleMs = 1000,
    limits = {}, observerFactory = createWorkspaceObserver, write = atomicWrite, isBusy = () => false } = {}) {
    Object.assign(this, { store, now, intervalMs, settleMs, limits, observerFactory, write, isBusy });
    this.contexts = new Map(); this.failures = new Map(); this.closed = false; this.running = null; this.operations = Promise.resolve();
    /** projectId → the users' undos writing into its folder: { writing, revision, paths: path → fingerprint|null }. */
    this.undos = new Map();
    this.unsubscribe = store.subscribe(() => {
      for (const c of this.contexts.values()) {
        const p = this.project(c.id), invalid = !real(p) || this.store.state.emergency || binding(p) !== c.bindingId;
        if (p) { const key = activityKey(this.store.state, p); if (key !== c.activityKey) { c.activityKey = key; c.nextAt = 0; c.unchanged = 0; } }
        if (invalid) {
          c.abort?.abort(); c.suspended = true;
          if (!c.doc.resetRequired && !c.persistenceUncertain) {
            try { this.persist(c, { ...c.doc, scanner: null, resetRequired: true, recent: recent(c.doc, { at: stamp(this.now), kind: 'observation_gap', summary: '观察暂停；恢复时重新建立目录基线，暂停期间的变化不逐条补报。' }) }); }
            catch (error) { this.rememberFailure(c.id, c.bindingId, error); }
          }
        }
        if (p && this.busy(p)) {
          c.mixed = true; c.activityRevision++; c.nextAt = 0;
          if (!c.doc.executionSeen && !c.persistenceUncertain) {
            try { this.persist(c, { ...c.doc, executionSeen: true }); }
            catch (error) { this.rememberFailure(c.id, c.bindingId, error); }
          }
        }
      }
    }, { display: false });
    this.timer = autoStart ? setInterval(() => { void this.pump(); }, Math.min(intervalMs, 15000)) : null;
    this.timer?.unref();
    if (autoStart) setImmediate(() => { if (!this.closed) void this.pump(); });
  }
  enqueue(operation) { const result = this.operations.then(operation); this.operations = result.catch(() => {}); return result; }
  /**
   * A user's undo is writing into a project folder (a rollback, a background change set's revert, the changes panel's
   * discard: the isolation engine calls this; server.mjs wires it). The undo reaches the models as a workspace event
   * (workspace-events.mjs) and is deliberately never evidence that wakes the loop, so its own writes must not come back
   * as an unexplained directory change either (review F2, K1-2). While it writes, scans are dropped; `end(paths)`
   * records the fingerprint each written path has right after the write, and the next committed scan folds a path
   * into its baseline only while the path still has that fingerprint: a later edit by the user or another program is
   * still a change. `end` never throws; without it (a failed write) the files are reported as before.
   * @param {string} projectId
   * @returns {{ end: (paths?: string[]) => Promise<void> }}
   */
  undoWrite(projectId) {
    const ledger = this.undos.get(projectId) ?? { writing: 0, revision: 0, paths: new Map() };
    this.undos.set(projectId, ledger); ledger.writing++; ledger.revision++;
    let open = true;
    const end = async (paths = []) => {
      if (!open) return; open = false; clearTimeout(timer);
      try {
        const root = this.project(projectId)?.workspace;
        if (root && paths.length) for (const [path, fingerprint] of await fingerprintPaths({ root, paths, limits: this.limits })) { ledger.paths.delete(path); ledger.paths.set(path, fingerprint); }
        while (ledger.paths.size > UNDO_PATHS) ledger.paths.delete(ledger.paths.keys().next().value);
      } catch { /* not recorded: the next scan reports these files as it would have */ }
      finally { ledger.writing--; ledger.revision++; }
    };
    // A writer that never ends (a caller cut off between its steps) must not stop this folder's observation for good.
    const timer = setTimeout(() => { void end(); }, UNDO_WRITE_MAX_MS); timer.unref?.();
    return { end };
  }
  /** Whether a user's undo wrote, or is writing, into the project folder since `revision` was read. */
  undoMoved(id, revision) { const ledger = this.undos.get(id); return Boolean(ledger?.writing) || (ledger?.revision ?? 0) !== revision; }
  project(id) { return this.store.state.projects.find(p => p.id === id); }
  busy(p) { return Boolean(p && (this.isBusy(p.id) || ['queued', 'initializing', 'running', 'pending'].includes(p.initialization?.status) || this.store.state.sessions.some(s => s.projectId === p.id && !s.archivedAt && s.status === 'running'))); }
  valid(c, p = this.project(c.id)) { return !this.closed && real(p) && !this.store.state.emergency && binding(p) === c.bindingId && c.doc.enabled && !c.suspended && !c.persistenceUncertain; }
  file(id) { if (!/^[a-zA-Z0-9-]+$/.test(id)) throw failure('项目 ID 无效'); return resolve(`${this.store.file}.observations`, `${id}.json`); }
  persist(c, next) {
    if (c.persistenceUncertain) throw failure('目录观察保存结果尚未确认，等待重载', 503, 'observation_persistence_uncertain');
    try { this.write(this.file(c.id), JSON.stringify(next)); } catch (error) { c.persistenceUncertain = true; throw error; }
    c.doc = copy(next);
  }
  observer(c) {
    // Exact owned files/directories only; a neighboring user file sharing the
    // state filename prefix is still observable. Exclusion is part of policyHash.
    const excludePaths = ['', '.secrets', '.subscriptions', '.rna', '.pi', '.genomes', '.initialization', '.evolution', '.capabilities', '.archive', '.observations', '.d', '.service', '.recovery', '.recovery.json', '.v1-backup', '.before-projects-backup']
      .map(suffix => relative(resolve(c.root), resolve(`${this.store.file}${suffix}`)))
      .filter(path => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)).map(path => path.split(sep).join('/'));
    c.observer = this.observerFactory({ root: c.root, checkpoint: c.doc.scanner, now: this.now, settleMs: this.settleMs, limits: this.limits, excludePaths });
    if (c.doc.scanner && c.observer.checkpoint?.() === null) throw failure('目录观察基线无效，需显式重新建立', 503, 'observation_checkpoint_invalid');
  }
  rememberFailure(id, bindingId, error) {
    const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code) ? error.code : 'observation_persistence_failed';
    const value = { bindingId, nextAt: this.now() + Math.max(this.intervalMs, 60000), code }; this.failures.set(id, value); return value;
  }
  readDocument(id) {
    const doc = readJSON(this.file(id), null);
    if (doc && (doc.version !== 1 || typeof doc.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(doc.bindingId ?? '') || !Number.isSafeInteger(doc.sourceRevision) || doc.sourceRevision < 1
      || !Object.hasOwn(doc, 'inbox') || doc.inbox === null && doc.scanner !== null || !doc.stats || Object.values(doc.stats).some(value => !Number.isSafeInteger(value) || value < 0)
      || !Array.isArray(doc.recent) || doc.recent.length > 8 || doc.hold !== undefined && doc.hold !== null && doc.hold !== 'root_changed'
      || doc.resetRequired !== undefined && typeof doc.resetRequired !== 'boolean' || doc.executionSeen !== undefined && typeof doc.executionSeen !== 'boolean'
      || doc.rootIdentity !== undefined && doc.rootIdentity !== null && !/^[a-f0-9]{64}$/.test(doc.rootIdentity))) throw failure('目录观察记录需恢复', 503);
    return doc;
  }
  async context(p) {
    const id = p.id, bindingId = binding(p), previous = this.contexts.get(id);
    if (previous?.bindingId === bindingId && !previous.persistenceUncertain) return previous;
    if (previous) { previous.abort?.abort(); await previous.observer?.close(); this.contexts.delete(id); }
    const saved = this.readDocument(id);
    const doc = saved?.bindingId === bindingId ? saved : { version: 1, bindingId, enabled: saved?.enabled ?? true, sourceRevision: 1, scanner: null, inbox: null, stats: defaultStats(), recent: [] };
    doc.rootIdentity ??= doc.scanner?.rootIdentity ?? null;
    const c = { id, root: p.workspace, bindingId, doc: copy(doc), nextAt: 0, pollIntervalMs: this.intervalMs, unchanged: 0, status: doc.hold ?? (doc.enabled ? 'initializing' : 'paused'), lastCheckedAt: doc.lastCheckedAt ?? null,
      lastErrorCode: doc.hold ? 'root_identity_changed' : null, mixed: doc.executionSeen === true, activityRevision: 0, activityKey: activityKey(this.store.state, p), suspended: doc.resetRequired === true, persistenceUncertain: false };
    c.inbox = createProjectEventInbox({ projectId: id, bindingId, state: doc.inbox ?? undefined, now: this.now,
      saveState: (state, metadata) => {
        if ((c.doc.inbox?.revision ?? 0) !== metadata.expectedRevision) throw failure('观察收件箱版本已变化', 503, 'observation_revision_conflict');
        this.persist(c, { ...c.doc, ...(c.staged ?? {}), inbox: state });
      } });
    await c.inbox.registerSource({ id: 'workspace', revision: doc.sourceRevision, kind: 'workspace' });
    const registered = c.inbox.snapshot().sources.find(row => row.id === 'workspace');
    if (!registered || registered.revoked || registered.revision !== c.doc.sourceRevision || registered.kind !== 'workspace') throw failure('目录观察来源版本不一致', 503, 'observation_revision_conflict');
    this.observer(c); this.contexts.set(id, c); this.withdrawStale(c, c.doc.hold === 'root_changed'); return c;
  }
  withdrawStale(c, rootChanged = false) {
    const p = this.project(c.id), stale = row => row.kind === 'workspace_change' && row.status !== 'withdrawn' && (rootChanged || row.data?.source?.bindingId !== c.bindingId || row.data?.source?.revision !== c.doc.sourceRevision);
    if ((p?.observations ?? []).some(stale)) this.store.mutate(state => { for (const row of state.projects.find(row => row.id === c.id).observations) if (stale(row)) { row.status = 'withdrawn'; row.data ??= {}; row.data.revocationReason = rootChanged ? 'workspace_root_changed' : 'workspace_source_changed'; } });
  }
  view(c, p) {
    const retained = p?.observationSources?.[0], enabled = c?.doc.enabled ?? retained?.enabled ?? true;
    const state = c?.status ?? retained?.status ?? (enabled ? 'initializing' : 'paused'), problem = this.failures.get(p?.id);
    const pausedSummary = this.store.state.emergency ? '已全局暂停，目录观察同步停止；恢复后重新建立基线。' : p?.archivedAt ? '项目已归档，目录观察已暂停。' : !real(p) ? '等待真实项目和有效目录，尚未开始观察。' : !enabled ? '已暂停采集；恢复时从当前目录状态开始。' : null;
    return { id: 'workspace', kind: 'workspace', label: '项目目录变化', enabled, bindingId: c?.bindingId ?? retained?.bindingId ?? null, revision: c?.doc.sourceRevision ?? retained?.revision ?? null,
      sourceRevision: c?.doc.sourceRevision ?? retained?.sourceRevision ?? retained?.revision ?? 1, identityRevoked: c ? c.doc.hold === 'root_changed' : retained?.identityRevoked === true,
      status: !real(p) || this.store.state.emergency || !enabled ? 'paused' : problem ? 'unavailable' : state,
      lastCheckedAt: c?.lastCheckedAt ?? retained?.lastCheckedAt ?? null, lastEventAt: c?.doc.lastEventAt ?? retained?.lastEventAt ?? null,
      nextCheckAt: c?.nextAt ? new Date(c.nextAt).toISOString() : null, pollIntervalMs: c?.pollIntervalMs ?? this.intervalMs,
      pendingCount: (c?.inbox.status().pending ?? 0) + Number(Boolean(c?.doc.scanner?.pending)), lastErrorCode: problem?.code ?? c?.lastErrorCode ?? null,
      summary: pausedSummary ?? (state === 'root_changed' ? '目录身份已改变；恢复观察时将重新建立基线。' : state === 'incomplete' ? '扫描未完整完成，保留原有基线，不推断文件删除。' : problem || state === 'unavailable' ? '目录观察暂不可用；聊天和已登记任务仍可继续。' : '自动检查目录变化；由 Agent 判断是否需要行动。'),
      scope: 'workspace_metadata', limits: { maxFiles: this.limits.maxFiles ?? 2000, maxEntries: this.limits.maxEntries ?? 6000 },
      stats: copy(c?.doc.stats ?? retained?.stats ?? defaultStats()), recent: copy(c?.doc.recent ?? retained?.recent ?? []) };
  }
  list(id) { const p = this.project(id); if (!p) throw failure('项目不存在', 404); return { projectId: id, sources: [this.view(this.contexts.get(id), p)] }; }
  publish(c) {
    const p = this.project(c.id); if (!p || !isAbsolute(p.workspace ?? '') || binding(p) !== c.bindingId || this.closed) return;
    const value = this.view(c, p);
    if (JSON.stringify(p.observationSources) !== JSON.stringify([value])) this.store.mutate(state => { state.projects.find(row => row.id === c.id).observationSources = [value]; });
  }
  control(id, source, input) {
    if (source !== 'workspace') return Promise.reject(failure('观察来源不存在', 404));
    if (!input || typeof input.enabled !== 'boolean' || Object.keys(input).some(key => key !== 'enabled')) return Promise.reject(failure('enabled 必须为布尔值'));
    const requested = this.project(id); if (!requested) return Promise.reject(failure('项目不存在', 404));
    if (!real(requested)) return Promise.reject(failure('请先恢复项目并选择有效目录', 409));
    const requestedBinding = binding(requested), enabled = input.enabled;
    this.contexts.get(id)?.abort?.abort();
    return this.enqueue(async () => {
      let c;
      try {
        const p = this.project(id);
        if (this.closed || !real(p) || binding(p) !== requestedBinding) throw failure('项目状态已变化，请重试', 409);
        c = await this.context(p); const rootChanged = c.doc.hold === 'root_changed';
        if (enabled === c.doc.enabled && !rootChanged) return this.list(id);
        await c.observer.close();
        if (enabled && rootChanged) {
          c.staged = { enabled, scanner: null, rootIdentity: null, hold: null, resetRequired: false, sourceRevision: c.doc.sourceRevision + 1, executionSeen: this.busy(p) };
          try { await c.inbox.registerSource({ id: 'workspace', revision: c.staged.sourceRevision, kind: 'workspace' }); } finally { c.staged = null; }
          this.withdrawStale(c);
        } else this.persist(c, { ...c.doc, enabled, scanner: null, resetRequired: !enabled, executionSeen: this.busy(p), recent: recent(c.doc, { at: stamp(this.now), kind: 'observation_gap', summary: enabled ? '观察已恢复，从当前目录状态重新建立基线。' : '观察已暂停，已接收的事件仍保留。' }) });
        c.suspended = !enabled; c.mixed = c.doc.executionSeen === true; this.observer(c); c.status = c.doc.hold ?? (enabled ? 'initializing' : 'paused'); c.lastErrorCode = null; c.nextAt = 0;
        this.failures.delete(id); this.publish(c); return this.list(id);
      } catch (error) {
        if (c?.persistenceUncertain || error.code === 'project_event_persistence_uncertain') this.rememberFailure(id, requestedBinding, error);
        throw error;
      }
    });
  }
  async deliver(c) {
    if (!this.valid(c) || c.doc.hold) return;
    const rows = c.inbox.pending(); if (!rows.length) return;
    const project = this.project(c.id), existing = new Set((project.observations ?? []).map(row => row.eventId)), fresh = rows.filter(row => !existing.has(row.id));
    const currentIds = new Set(rows.map(row => row.id)), old = (project.observations ?? []).filter(row => row.kind === 'workspace_change');
    const candidates = old.filter(row => !currentIds.has(row.eventId) && (['processed', 'dismissed', 'withdrawn', 'handled', 'ignored', 'superseded'].includes(row.status)
      || row.status === 'received' && row.id === row.eventId && row.data?.runtimeReceipt?.eventId === `observation:${row.id}`));
    const archive = candidates.slice(0, Math.max(0, old.length + fresh.length - 64));
    if (old.length + fresh.length - archive.length > 64) throw failure('目录观察积压等待处理', 503, 'event_backpressure');
    if (archive.length) this.store.archiveRecords(`observations/${c.id}/workspace`, archive);
    if (fresh.length || archive.length) this.store.mutate(state => {
      const p = state.projects.find(row => row.id === c.id);
      if (!real(p) || this.store.state.emergency || binding(p) !== c.bindingId || !this.valid(c, p)) throw failure('项目状态已变化', 409);
      p.observations = (p.observations ?? []).filter(row => !archive.some(item => item.id === row.id));
      for (const row of fresh) p.observations.push({ id: row.id, eventId: row.id, kind: 'workspace_change', text: row.summary, relevance: 0.7, status: 'pending', simulated: false,
        source: 'workspace_metadata', createdAt: new Date(row.observedAt ?? row.receivedAt).toISOString(),
        data: { source: { id: 'workspace', kind: 'workspace', bindingId: c.bindingId, revision: row.sourceRevision }, trust: row.trust, instruction: false, ...row.data, coverage: row.coverage } });
    });
    await c.inbox.checkpoint({ eventIds: rows.map(row => row.id), receiptId: `projection:${rows.at(-1).id}` });
  }
  async scan(c) {
    c.abort = new AbortController();
    // A user's undo writing now: this scan would see part of it. Its files, once written, are folded in (undoWrite).
    const undo = this.undos.get(c.id), undoRevision = undo?.revision ?? 0;
    if (undo?.writing) return null;
    const known = undo ? [...undo.paths].map(([path, fingerprint]) => ({ path, fingerprint })) : [];
    const activityRevision = c.activityRevision, acknowledged = c.mixed || this.busy(this.project(c.id));
    const result = await c.observer.poll({ signal: c.abort.signal, acknowledgeOnly: acknowledged, suppressPaths: known });
    if (c.persistenceUncertain) throw failure('目录观察保存结果尚未确认，等待重载', 503, 'observation_persistence_uncertain');
    if (!this.valid(c) || c.abort.signal.aborted || (!acknowledged && c.mixed) || this.undoMoved(c.id, undoRevision)) { await c.observer.close(); this.observer(c); return null; }
    c.lastCheckedAt = stamp(this.now); c.lastErrorCode = result.reason ?? null;
    const rootChanged = result.status === 'root_replaced' || result.status === 'baseline' && c.doc.rootIdentity && result.checkpoint?.rootIdentity !== c.doc.rootIdentity;
    if (rootChanged) { c.status = 'root_changed'; this.persist(c, { ...c.doc, hold: 'root_changed', lastCheckedAt: c.lastCheckedAt }); this.withdrawStale(c, true); this.publish(c); return result.status; }
    c.status = ['incomplete', 'unavailable'].includes(result.status) ? result.status : result.status === 'cancelled' ? 'initializing' : 'watching';
    if (committedStatuses.has(result.status)) {
      const stillMixed = this.busy(this.project(c.id)) || c.activityRevision !== activityRevision;
      const stats = { ...defaultStats(), ...c.doc.stats, suppressedDuringExecution: (c.doc.stats?.suppressedDuringExecution ?? 0) + (result.suppressed ?? 0) };
      const history = result.suppressed ? recent(c.doc, { at: c.lastCheckedAt, kind: 'mixed_origin_during_execution', summary: `执行期间合并了 ${result.suppressed} 项变化；未区分 Agent 与其他程序的写入。` }) : c.doc.recent;
      c.staged = { scanner: result.checkpoint, rootIdentity: result.checkpoint.rootIdentity, lastCheckedAt: c.lastCheckedAt, executionSeen: stillMixed, stats, recent: history };
      try {
        if (result.status === 'changed') {
          const changes = []; let bytes = 0;
          for (const item of result.changes) { const row = { path: item.path, change: item.kind }; bytes += Buffer.byteLength(JSON.stringify(row)); if (changes.length >= 32 || bytes > 4000) break; changes.push(row); }
          const summary = `项目目录有 ${result.changes.length} 项变化；内容尚待核对。`;
          c.staged.stats.received++; c.staged.lastEventAt = c.lastCheckedAt; c.staged.recent = [...(history ?? []), { at: c.lastCheckedAt, kind: 'workspace_change', summary }].slice(-8);
          const source = c.inbox.snapshot().sources.find(row => row.id === 'workspace');
          const accepted = await c.inbox.ingest({ sourceId: 'workspace', sourceRevision: source.revision, sequence: source.sequence + 1, kind: 'workspace_change', summary,
            data: { changes, totalChanges: result.changes.length, truncated: changes.length < result.changes.length }, observedAt: this.now() });
          if (!['accepted', 'coalesced'].includes(accepted.status)) throw failure('目录观察积压等待处理', 503, 'event_backpressure');
        } else this.persist(c, { ...c.doc, ...c.staged });
        c.observer.commit(result.checkpoint); c.mixed = stillMixed;
        // The undo files this scan was given are settled now (folded in, or reported when something changed them since).
        for (const { path, fingerprint } of known) if (undo.paths.get(path) === fingerprint) undo.paths.delete(path);
      } finally { c.staged = null; }
      // Validate the current root before even replaying already durable events.
      await this.deliver(c);
    }
    return result.status;
  }
  async suspend(p) {
    const c = this.contexts.get(p.id);
    if (c) { c.suspended = true; c.abort?.abort(); await c.observer?.close(); if (!c.doc.resetRequired) this.persist(c, { ...c.doc, scanner: null, resetRequired: true }); this.publish(c); return; }
    const doc = this.readDocument(p.id);
    if (doc && !doc.resetRequired) this.write(this.file(p.id), JSON.stringify({ ...doc, scanner: null, resetRequired: true, rootIdentity: doc.rootIdentity ?? doc.scanner?.rootIdentity ?? null,
      recent: recent(doc, { at: stamp(this.now), kind: 'observation_gap', summary: '观察暂停；恢复时重新建立目录基线，暂停期间的变化不逐条补报。' }) }));
  }
  pump({ force = false } = {}) {
    if (this.closed || this.store.maintenanceHeld) return Promise.resolve(); if (this.running) return this.running;
    this.running = this.enqueue(async () => {
      for (const original of [...this.store.state.projects]) {
        if (this.closed) break;
        const p = this.project(original.id); if (!p) continue;
        const retry = this.failures.get(p.id);
        if (retry && (!isAbsolute(p.workspace ?? '') || retry.bindingId === binding(p)) && this.now() < retry.nextAt) continue;
        let c;
        try {
          if (!real(p) || this.store.state.emergency) { await this.suspend(p); continue; }
          c = await this.context(p);
          if (!c.doc.enabled) { this.publish(c); continue; }
          if (c.suspended) { await c.observer.close(); this.persist(c, { ...c.doc, scanner: null, resetRequired: false }); this.observer(c); c.suspended = false; c.nextAt = 0; }
          if ((!force && this.now() < c.nextAt) || c.doc.hold === 'root_changed') { this.publish(c); continue; }
          const result = await this.scan(c); this.failures.delete(p.id);
          c.unchanged = result === 'unchanged' && !c.mixed ? c.unchanged + 1 : 0;
          const assessment = p.rhythmRuntime?.assessment, quiet = ['complete', 'blocked', 'recurring'].includes(assessment?.lifecycle) || assessment?.initiative?.mode === 'event_only' || p.initiative?.enabled === false;
          const cap = quiet ? 300000 : 60000;
          c.pollIntervalMs = c.doc.scanner?.pending || c.mixed ? this.intervalMs : Math.min(Math.max(this.intervalMs, cap), this.intervalMs * 2 ** Math.min(c.unchanged, 6));
          c.nextAt = this.now() + c.pollIntervalMs; this.publish(c);
        } catch (error) {
          const problem = this.rememberFailure(p.id, isAbsolute(p.workspace ?? '') ? binding(p) : null, error);
          if (c) { c.status = 'unavailable'; c.lastErrorCode = problem.code; await c.observer?.close(); this.contexts.delete(c.id); }
          const project = this.project(p.id);
          if (project && !this.closed) { try { this.store.mutate(state => { state.projects.find(row => row.id === p.id).observationSources = [{ ...this.view(c, project), status: 'unavailable' }]; }); } catch { /* Original durability failure takes precedence over a failed display write. */ } }
        }
      }
      for (const [id, c] of this.contexts) if (!this.project(id)) { await c.observer?.close(); this.contexts.delete(id); this.failures.delete(id); }
      for (const [id, ledger] of this.undos) if (!this.project(id) && !ledger.writing) this.undos.delete(id);
    }).finally(() => { this.running = null; });
    return this.running;
  }
  health() {
    const ids = new Set([...this.contexts.keys(), ...this.failures.keys()]);
    return { active: Boolean(this.running), sources: [...ids].filter(id => this.project(id)).map(id => { const c = this.contexts.get(id), problem = this.failures.get(id); return { projectId: id, status: problem ? 'unavailable' : c.status, pending: c?.inbox.status().pending ?? 0, lastErrorCode: problem?.code ?? c?.lastErrorCode ?? null, ...(problem ? { retryAt: new Date(problem.nextAt).toISOString() } : {}) }; }) };
  }
  async close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); for (const c of this.contexts.values()) c.abort?.abort(); await this.operations; await Promise.allSettled([...this.contexts.values()].map(c => c.observer?.close())); }
}
