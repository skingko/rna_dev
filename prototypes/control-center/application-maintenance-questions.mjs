import { readMaintenance, withMaintenanceControl, persistMaintenance, maintenanceFailure } from './application-maintenance-state.mjs';
import { startAttempt } from './store.mjs';

const stamp = () => new Date().toISOString();
const turnOf = session => session?.turns.find(turn => turn.id === session.activeTurnId);
const questionOf = (session, receipt) => session?.items.find(item => item.interaction?.id === receipt?.interactionId)?.interaction;
const owns = (session, row) => session?.maintenanceQuestion?.schemaVersion === 1 && session.maintenanceQuestion.operationId === row?.id && session.maintenanceQuestion.requestId === row?.questionHandoff?.requestId;
const eligible = (state, session, receipt) => session && !state.emergency && !session.archivedAt && !session.appRecovery?.required && !state.projects.find(project => project.id === session.projectId)?.archivedAt && session.activeTurnId === receipt.turnId && turnOf(session)?.runtimeMessageId === receipt.runtimeMessageId && session.runtime?.sessionFile === receipt.sessionFile && !session.inbox.length;
const released = row => row && !row.held && (row.phase === 'completed' && row.kind !== 'restore' || ['cancelled', 'failed'].includes(row.phase) && !row.stopped && !row.startAttempted);

/** A question is not idle work. This negotiated handoff pauses exactly one
 * durable read-only interaction per turn, waits for its SDK owner to drain,
 * then lets the ordinary maintenance checkpoint preserve both receipts.
 * Session state is authoritative: a lost HTTP/maintenance receipt is retryable.
 */
export class MaintenanceQuestionHandoff {
  constructor(store, { gate, executor, interactions, otherWork = () => false } = {}) {
    this.store = store; this.gate = gate; this.executor = executor; this.interactions = interactions; this.otherWork = otherWork; this.closed = false;
    if (executor) executor.questionHandoff = this;
    this.unsubscribe = store.subscribe(() => this.schedule(), { display: false });
    this.timer = setInterval(() => this.schedule(), 250); this.timer.unref(); this.schedule();
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; try { this.reconcile(); } catch { /* Persistence errors keep the original question paused. */ } });
  }
  async suspend({ operationId, requestId } = {}) {
    return withMaintenanceControl(this.store.file, () => {
      const row = readMaintenance(this.store.file);
      if (this.closed || !this.executor || row?.id !== operationId || !row.held || row.phase !== 'waiting_idle' || row.cancelRequested || row.questionHandoff?.version !== 1 || row.questionHandoff.requestId !== requestId) throw maintenanceFailure('问题交接不属于当前维护操作。', 'maintenance_question_conflict');
      // No await between canonical inspection and Store commit. Answers,
      // steering and manual controls therefore win wholly before or after it.
      const running = this.store.state.sessions.filter(session => session.status === 'running');
      const candidates = running.map(session => ({ sessionId: session.id, proof: this.executor.maintenanceQuestionCandidate(session.id) }));
      const ready = !this.otherWork() && candidates.length > 0 && candidates.every(item => item.proof) && this.executor.running.size === candidates.length;
      if (ready) this.store.mutate(state => {
        for (const { sessionId, proof } of candidates) {
          const session = state.sessions.find(item => item.id === sessionId), turn = turnOf(session);
          session.maintenanceQuestion = { schemaVersion: 1, operationId, requestId, ...proof, phase: 'suspended', createdAt: stamp() };
          // The turn clock stops at the handoff and counts again from the reattach (C-a).
          session.status = 'paused'; session.pauseReason = 'maintenance_question'; turn.status = 'paused'; turn.pausedAt = stamp(); session.updatedAt = stamp();
        }
      });
      const receipts = this.store.state.sessions.filter(session => owns(session, row)).map(session => ({ sessionId: session.id, turnId: session.maintenanceQuestion.turnId, interactionId: session.maintenanceQuestion.interactionId, phase: session.maintenanceQuestion.phase }));
      // Full receipts belong to their session and are deleted with it. The
      // bounded maintenance journal only needs aggregate handoff telemetry.
      const summary = { version: 1, requestId, capability: 'supported', suspended: receipts.filter(item => item.phase === 'suspended').length, blocked: ready ? 0 : running.length, receiptCount: receipts.length, updatedAt: stamp() };
      persistMaintenance(this.store.file, { ...row, questionHandoff: summary }); this.gate.refresh();
      return { operationId, ...summary };
    });
  }
  canAnswer(sessionId) {
    const session = this.store.state.sessions.find(row => row.id === sessionId), receipt = session?.maintenanceQuestion;
    const question = questionOf(session, receipt);
    // Saving a real answer does not authorize continuation. Retained new input
    // can block automatic resume without making the original answer disappear.
    return this.gate.row?.phase === 'waiting_idle' && owns(session, this.gate.row) && ['suspended', 'user_paused'].includes(receipt.phase) && question?.fingerprint === receipt.fingerprint && session.activeTurnId === receipt.turnId && this.interactions.valid(this.store.state, session, question);
  }
  holdsAnswer(sessionId) {
    const session = this.store.state.sessions.find(row => row.id === sessionId);
    return ['suspended', 'reattaching', 'user_paused'].includes(session?.maintenanceQuestion?.phase);
  }
  reconcile() {
    if (this.closed || !this.executor || this.executor.closed) return;
    this.gate.refresh(); const row = this.gate.row;
    if (this.gate.held || !released(row)) return;
    for (const session of this.store.state.sessions) {
      const receipt = session.maintenanceQuestion;
      if (!owns(session, row) || !['suspended', 'reattaching'].includes(receipt.phase) || session.status !== 'paused' || !['maintenance_question', 'recovery'].includes(session.pauseReason) || this.executor.running.has(session.id)) continue;
      const question = questionOf(session, receipt);
      if (!eligible(this.store.state, session, receipt) || question?.fingerprint !== receipt.fingerprint || !['pending', 'interrupted', 'answered', 'cancelled'].includes(question?.status)) { this.block(session.id, 'state_changed'); continue; }
      this.store.mutate(state => {
        const current = state.sessions.find(item => item.id === session.id);
        current.maintenanceQuestion.phase = 'reattaching'; current.maintenanceQuestion.updatedAt = stamp();
        startAttempt(current, turnOf(current));
        current.status = 'running'; current.pauseReason = null; turnOf(current).status = 'running';
      });
    }
  }
  block(sessionId, reason) {
    this.store.mutate(state => {
      const session = state.sessions.find(row => row.id === sessionId); if (!session) return;
      if (!['suspended', 'reattaching'].includes(session.maintenanceQuestion?.phase)) return;
      session.maintenanceQuestion.phase = 'blocked'; session.maintenanceQuestion.reason = reason; session.maintenanceQuestion.updatedAt = stamp();
      if (session.status === 'running') { session.status = 'paused'; session.pauseReason = 'maintenance_question'; const turn = turnOf(session); if (turn) { turn.status = 'paused'; turn.pausedAt = stamp(); } }
    });
  }
  admit(context, handle) {
    this.gate.refresh(); const session = this.store.state.sessions.find(row => row.id === context.sessionId), receipt = session?.maintenanceQuestion, row = this.gate.row;
    const proof = handle.questionCheckpoint?.({ runtimeMessageId: receipt?.runtimeMessageId }), question = questionOf(session, receipt);
    if (context.cancelled || this.gate.held || !released(row) || !owns(session, row) || !eligible(this.store.state, session, receipt) || receipt.phase !== 'reattaching' || !proof || proof.phase !== 'idle' || !this.interactions.questionMatches(question, proof) || question.fingerprint !== receipt.fingerprint || ['callKey', 'toolCallId', 'argumentsHash', 'runtimeMessageId', 'sessionFile'].some(key => proof[key] !== receipt[key])) {
      this.block(context.sessionId, 'canonical_question_changed'); return false;
    }
    // Consume the entitlement durably before resuming. If the process dies in
    // this tiny window, ordinary explicit recovery applies; never auto-replay
    // a later answered tool/model request on a subsequent daemon restart.
    this.store.mutate(state => { const current = state.sessions.find(item => item.id === context.sessionId); current.maintenanceQuestion.phase = 'reattached'; current.maintenanceQuestion.reattachedAt = stamp(); });
    return true;
  }
  close() { this.closed = true; clearInterval(this.timer); if (this.scheduled) clearImmediate(this.scheduled); this.unsubscribe?.(); }
}
