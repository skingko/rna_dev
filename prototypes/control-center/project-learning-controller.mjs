import { randomUUID } from 'node:crypto';
import { privateStatePaths } from './state-privacy.mjs';
import { LearningCoordinator, reflectProjectLearning, revokeLearningSources, LEARNING_REFLECTION_METHOD, LEARNING_REFLECTION_CONTRACT_HASH } from '../../packages/sdk/src/learning.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';
import { resolveModel } from './configuration.mjs';
import { ProjectLearningBudget } from './project-learning-budget.mjs';
import { autonomousLearningNotBefore } from './project-proactivity.mjs';
import { ProjectEvolutionService } from './project-evolution-service.mjs';
import { learningHash, learningRedactor, projectLearningEpisodes, freezeProjectLearningFiles, projectLearningEvaluationAudit } from './project-learning-evidence.mjs';
import { learningSourceBoundary, learningLegacyScope, learningCredentialIdentity, learningEvidenceScope, learningExecutionScope, learningNamespaceMatches, learningEvidenceScopeV2, learningExecutionScopeV2, learningV2Consistent,
  learningDriftIdentity, learningDriftComponents, annotateLearningDrift, archivedLearningSources, LEARNING_SCOPE_SCHEMA_VERSION } from './project-learning-scope.mjs';
import { projectRhythmStatus, projectRhythmEvidenceKey } from './project-rhythm.mjs';
import { purposeProvider } from './usage-cache-service.mjs';
import { sharedPrefixFor } from './prompt-prefix-registry.mjs';

const copy = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const real = project => project && !project.archivedAt && project.decisionMode === 'rna-model' && project.initialization?.status === 'ready';
const statuses = new Set(['ready', 'rejected', 'failed', 'interrupted', 'stale', 'no_change']);
const methodIdentity = learningHash([LEARNING_REFLECTION_METHOD, PROJECT_EVALUATION_RUNTIME_HASH]);
// A legacy scope mixed source boundaries with the complete SDK implementation.
// This is the verified method identity of the 2026-09-26 deployed runtime
// 4889fe29f2f4128efa91ddf56ebfc6e932987e1fca1266c197eb495b1023d074.
// A migration must reproduce the OLD scope using today's complete boundary;
// knowing a release identity alone never authorizes keeping changed sources.
const legacyMethodIdentities = Object.freeze(['f605978f11adbdbdd166774fdf132ab5726e2c03cabf3c2f345e7b0b9ac289b8']);
// Verified 11:05 UTC deployment: its receipts predate reflection contract
// hashes. Attest them only if its complete execution scope still recomputes
// with the current model, credential and project source boundary.
const legacyReflectionContracts = Object.freeze([{ methodIdentity: 'fb1ce0cf91fc54b258b6897d6245f6e313673e32f97e4561b32e909657105c92', contractHash: '7911e68f79c061114dd35215e70db3eed7d974ded4a987a4d22d3734402fc3a9' }]);
const scopeSchemaVersion = LEARNING_SCOPE_SCHEMA_VERSION;

/** Learning consumes a durable backlog independently of the work/conversation
 * router. Only a scope/permission/source revocation interrupts a frozen review.
 * It never installs its own candidate or edits the user's workspace. */
// Terminal identity inputs of one session; committed (frozen) sessions are cached by identity.
const sessionIdentities = new WeakMap();
const sessionIdentityOf = row => [row.turns.map(turn => [turn.id, turn.status, turn.completedAt, turn.runtimeAttempts, turn.steering]), row.items.filter(item => item.kind === 'user' || item.interaction).map(item => [item.id, item.interaction?.status, item.interaction?.answeredAt, item.delivery, item.consumedAt, item.sourceDeleted, item.contextRevoked]), row.commandHistory?.map(command => [command.id, command.command, command.status, command.completedAt, command.result])];
function sessionIdentity(row) {
  if (!Object.isFrozen(row)) return learningHash(sessionIdentityOf(row));
  let value = sessionIdentities.get(row); if (!value) { value = learningHash(sessionIdentityOf(row)); sessionIdentities.set(row, value); }
  return value;
}
export class ProjectLearningController {
  constructor(store, { evolutionService, provider, reflect = reflectProjectLearning, freezeFiles = freezeProjectLearningFiles, decisionService, tickIntervalMs = 1000, initialDelayMs = 45000, minReviewMs = 60000, maxConcurrentReviews = 2, now = Date.now } = {}) {
    if (!evolutionService) throw fail('evolution_service_required');
    Object.assign(this, { store, evolutionService, provider, reflect, freezeFiles, now, initialDelayMs, minReviewMs });
    this.decisions = decisionService;
    if (!Number.isInteger(maxConcurrentReviews) || maxConcurrentReviews < 1 || maxConcurrentReviews > 16) throw fail('invalid_learning_concurrency');
    this.maxConcurrentReviews = maxConcurrentReviews; this.cursor = 0;
    this.contexts = new Map(); this.closed = false; this.writing = false;
    // Billing recovery must also run for disabled/archived/deleted projects.
    // Enabling a model lane is not a prerequisite to release its old admission.
    const recoverIds = new Set([...store.state.projects.filter(row => row.learningRuntime?.usage).map(row => row.id), ...Object.keys(store.state.realUsage?.reservations ?? {}).filter(key => key.startsWith('learning:')).map(key => key.slice(9))]);
    for (const id of recoverIds) new ProjectLearningBudget(store, id, { now }).recover();
    this.unsubscribe = store.subscribe(() => { if (!this.writing) { this.invalidate(); this.schedule(); } }, { display: false });
    this.timer = tickIntervalMs > 0 ? setInterval(() => this.schedule(), tickIntervalMs) : null; this.timer?.unref(); this.schedule();
  }
  project(id) { return this.store.state.projects.find(row => row.id === id); }
  mutate(fn) { this.writing = true; try { return this.store.mutate(fn); } finally { this.writing = false; } }
  enabled(project) { return !this.closed && !this.store.state.emergency && real(project) && project.initiative?.enabled && project.evolution?.enabled && !(this.store.state.sessionDeletions ?? []).some(row => row.projectId === project.id && row.localStatus !== 'completed'); }
  model(project) { const model = resolveModel(this.store.state.configuration, project.initiative?.modelSelection ?? null); if (model.usagePolicy === 'interactive_only') throw fail('interactive_subscription_only'); return model; }
  sourceBoundary(project) {
    return learningSourceBoundary(this.store.state, project);
  }
  legacyScope(project, model, identity = methodIdentity) {
    return learningLegacyScope(this.store.state, project, model, identity);
  }
  evidenceScope(project, model) {
    // Catalog labels, capacity and request tuning are not new experience.
    // Endpoint/credential changes remain a source/privacy boundary. A provider
    // updatedAt/evidenceRevision also changes for output tuning and UI labels,
    // so bind to the actual resolved credential without persisting its value.
    return learningEvidenceScope(this.store.state, project, model, learningCredentialIdentity(this.store, model));
  }
  scope(project, model) {
    return learningExecutionScope(this.store.state, project, model, methodIdentity, learningCredentialIdentity(this.store, model));
  }
  valid(context) { const project = this.project(context.projectId); if (!this.enabled(project)) return false; try { return this.scope(project, this.model(project)) === context.scope; } catch { return false; } }
  invalidate() { for (const context of this.contexts.values()) {
    if (!this.valid(context)) { context.judgeAbort?.abort(); context.coordinator.invalidate('learning_scope_changed'); }
    else if (context.judgeEvidenceKey && context.judgeEvidenceKey !== projectRhythmEvidenceKey(this.store.state, this.project(context.projectId))) { context.judgeAbort?.abort(); context.notBefore = 0; }
  } }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; void this.pump().catch(error => { this.lastError = error.code ?? 'learning_scheduler_failed'; }); });
  }
  async create(project, model, scope) {
    const runtime = project.learningRuntime;
    let saved = runtime?.sdkState && copy(runtime.sdkState);
    const oldScope = runtime?.scopeHash, evidenceScopeHash = this.evidenceScope(project, model), credential = learningCredentialIdentity(this.store, model);
    const legacyIdentity = runtime?.scopeSchemaVersion === undefined && oldScope
      ? [...new Set([methodIdentity, ...legacyMethodIdentities])].find(identity => this.legacyScope(project, model, identity) === oldScope) : undefined;
    const namespaceMatches = learningNamespaceMatches(runtime, evidenceScopeHash);
    // G9: a consistent v2 runtime keeps its namespace under the privacy-only
    // v3 scope; the old model/permission coupling becomes drift, not revocation.
    const v2Migration = !namespaceMatches && learningV2Consistent(runtime) ? { from: 'evidence-scope-v2', verifiedScopeHash: oldScope, verifiedSourceBoundaryHash: evidenceScopeHash, previousEvidenceScopeHash: runtime.evidenceScopeHash,
      exact: learningEvidenceScopeV2(this.store.state, project, model, credential) === runtime.evidenceScopeHash, at: new Date(this.now()).toISOString() } : undefined;
    const retained = Boolean(oldScope && (namespaceMatches || legacyIdentity || v2Migration));
    const legacyReflectionContract = retained && legacyReflectionContracts.find(row => {
      const previousScopes = [learningExecutionScope, learningExecutionScopeV2].map(scopeOf => scopeOf(this.store.state, project, model, row.methodIdentity, credential));
      const proof = runtime.reflectionContractMigration;
      return previousScopes.includes(runtime.executionRevisionHash) || proof?.from === 'legacy-reflection-contract-v1'
        && proof.previousMethodIdentity === row.methodIdentity && proof.previousContractHash === row.contractHash
        && previousScopes.includes(proof.previousExecutionRevisionHash) && [evidenceScopeHash, v2Migration?.previousEvidenceScopeHash].includes(proof.verifiedSourceBoundaryHash);
    });
    // Save the verified old scope with the first new execution revision. A
    // crash before the coordinator records contractRecovery must not discard
    // the proof needed to resume this tool-free recovery on the next start.
    const reflectionContractMigration = legacyReflectionContract ? {
      from: 'legacy-reflection-contract-v1', previousMethodIdentity: legacyReflectionContract.methodIdentity,
      previousContractHash: legacyReflectionContract.contractHash, verifiedSourceBoundaryHash: evidenceScopeHash,
      previousExecutionRevisionHash: learningExecutionScope(this.store.state, project, model, legacyReflectionContract.methodIdentity, learningCredentialIdentity(this.store, model)),
    } : undefined;
    // Keep the existing namespace after a verified migration: it participates
    // in episode fingerprints and seen keys. Re-keying would re-ingest every
    // completed episode even if its summary and underlying source never changed.
    const evidenceNamespace = retained ? oldScope : evidenceScopeHash;
    if (saved && oldScope && !retained) {
      // Only a privacy boundary (project identity/workspace, unverifiable namespace) revokes the backlog.
      saved = revokeLearningSources(saved, [`scope:${oldScope}`], 'privacy_boundary_changed');
      this.mutate(state => { const target = state.projects.find(row => row.id === project.id); if (target?.learningRuntime) delete target.learningRuntime.evidenceFloor; });
    }
    // Archived sessions revoke only their own sources (deletion is drained separately).
    const archived = archivedLearningSources(this.store.state, project);
    if (saved && archived.length) saved = revokeLearningSources(saved, archived, 'session_archived');
    // Context drift annotates unsettled episodes/reviews and is logged; nothing is revoked.
    const driftIdentity = learningDriftIdentity(this.store.state, project, model, credential, methodIdentity);
    // Author replays (evolution-authoring-recovery) keep the strict pre-v3 boundary.
    const strictScopeHash = learningEvidenceScopeV2(this.store.state, project, model, credential);
    const drift = [...(retained ? learningDriftComponents(runtime?.driftIdentity, driftIdentity) : []), ...(v2Migration && !v2Migration.exact ? ['scope_v3_migration'] : [])];
    if (saved && drift.length) saved = annotateLearningDrift(saved, drift);
    if (drift.length) this.mutate(state => { const target = state.projects.find(row => row.id === project.id); if (target) { target.learningRuntime ??= {}; target.learningRuntime.contextDrift = [...(target.learningRuntime.contextDrift ?? []), { at: new Date(this.now()).toISOString(), components: drift }].slice(-20); } });
    const revisionChanged = retained && runtime.executionRevisionHash !== scope;
    if (saved && revisionChanged) for (const review of saved.reviews) if (review.status === 'queued_experiment' && !review.sourceRevoked) {
      // A queued decision has no active provider operation. Re-review it under
      // the new method, preserving the old decision/receipt as audit history.
      // Any durable version still takes precedence over another dispatch.
      review.status = 'interrupted'; review.interruptedPhase = project.versions?.some(row => row.learningReviewId === review.id) ? 'executing' : 'reviewing';
      review.completedAt = this.now(); review.error = { code: 'learning_execution_revision_changed', message: 'Learning runtime changed; retained evidence requires a fresh decision.' };
      delete review.reconciledAt;
      for (const episode of saved.episodes) if (episode.reviewId === review.id) episode.status = 'interrupted';
    }
    const context = { projectId: project.id, scope, evidenceNamespace, evidenceScopeHash, model, notBefore: this.now() + (saved ? 0 : this.initialDelayMs), lastProjection: null, promise: null, lastError: saved?.reviews?.at(-1)?.status === 'failed' ? saved.reviews.at(-1).error?.code : null };
    context.budget = new ProjectLearningBudget(this.store, project.id, { now: this.now });
    await context.budget.recover();
    const saveState = snapshot => this.mutate(state => {
        const target = state.projects.find(row => row.id === project.id); if (!target) return;
        const executionClaims = Object.fromEntries(Object.entries(target.learningRuntime?.executionClaims ?? {}).filter(([id]) => snapshot.reviews.some(row => row.id === id)));
        // This adapter durably creates a version with learningReviewId before
        // any candidate provider call. Save that contract in the same atomic
        // transaction as the SDK execution claim, including the pre-handler gap.
        if (this.evolutionService instanceof ProjectEvolutionService) for (const row of snapshot.reviews) if (row.status === 'executing') executionClaims[row.id] ??= { contract: 'version_before_provider_v1', at: this.now() };
        target.learningRuntime = { ...target.learningRuntime, executionClaims, sdkState: copy(snapshot), scopeSchemaVersion, scopeHash: evidenceNamespace, evidenceScopeHash, executionRevisionHash: scope, driftIdentity, strictScopeHash,
          reflectionContractMigration,
          ...(legacyIdentity ? { scopeMigration: { from: 'legacy-method-coupled-v1', verifiedLegacyMethodIdentity: legacyIdentity, verifiedScopeHash: oldScope, verifiedSourceBoundaryHash: evidenceScopeHash } } : v2Migration ? { scopeMigration: v2Migration } : {}), updatedAt: new Date(this.now()).toISOString() };
      });
    context.coordinator = new LearningCoordinator({ state: saved, now: this.now, policy: { minReviewMs: this.minReviewMs, experimentNotBefore: autonomousLearningNotBefore(project) }, saveState,
      archiveReviews: reviews => this.store.archiveRecords(`learning/${project.id}/reviews`, reviews.map(row => ({ id: row.id, status: row.status, ...(row.sourceRevoked ? { sourceRevoked: true, revocationReason: row.revocationReason, ...(row.statusBeforeRevocation ? { statusBeforeRevocation: row.statusBeforeRevocation } : {}) } : {}), sourceIds: row.sourceIds, episodeKeys: row.episodeKeys, startedAt: row.startedAt, completedAt: row.completedAt, decisionHash: learningHash(row.decision ?? null), request: row.request, usage: row.usage, ...(row.result ? { result: { status: row.result.status, versionId: row.result.versionId, usage: row.result.usage } } : {}) }))),
      review: input => this.review(context, input), execute: input => this.execute(context, input) });
    // Persist the boundary proof and restart interruption before any request.
    saveState(context.coordinator.snapshot());
    this.contexts.set(project.id, context);
    // Recover by exact immutable version identity, never replay a dispatched
    // experiment merely because its caller did not save the return value.
    for (const review of context.coordinator.snapshot().reviews.filter(row => row.status === 'interrupted' && !row.sourceRevoked && !row.reconciledAt)) {
      const version = this.project(project.id)?.versions?.find(row => row.learningReviewId === review.id);
      if (version && statuses.has(version.state)) await context.coordinator.reconcile(review.id, { status: version.state, versionId: version.id, summary: '已从持久化候选记录核对结果。', usage: version.usage });
      else if (!version && review.interruptedPhase === 'executing' && project.learningRuntime?.executionClaims?.[review.id]?.contract === 'version_before_provider_v1' && this.evolutionService instanceof ProjectEvolutionService) await context.coordinator.reconcile(review.id, { status: 'retry_experiment', verifiedNoExecution: true });
      else if (review.interruptedPhase !== 'executing') await context.coordinator.reconcile(review.id, { status: 'retry_review', verifiedNoExecution: true });
    }
    await context.coordinator.retryTruncatedReflections({ maxOutputTokens: context.model.maxOutputTokens, legacyMaxOutputTokens: 4096 });
    if (retained) await context.coordinator.retryInvalidReflections({ contractHash: LEARNING_REFLECTION_CONTRACT_HASH, ...(legacyReflectionContract ? { legacyContractHash: legacyReflectionContract.contractHash } : {}) });
    return context;
  }
  async review(context, input) {
    if (!this.valid(context)) throw fail('learning_scope_changed');
    const project = this.project(context.projectId), baseline = project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.genome;
    const provider = this.store.state.configuration.providers.find(row => row.id === context.model.providerId);
    const redact = learningRedactor(this.store);
    return this.reflect({ ...input, model: context.model, apiKey: this.store.configurationService.secret(provider.id, provider), provider: purposeProvider(this.store, this.provider, 'learning', { projectId: context.projectId }), sharedPrefix: () => sharedPrefixFor(context.projectId, context.model), requestControl: context.budget,
      project: JSON.parse(redact(JSON.stringify({ id: project.id, title: project.name, description: project.description, focus: project.focus, constraints: project.commitments, skills: baseline?.skills?.map(({ id, name, description }) => ({ id, name, description })), tools: baseline?.tools?.map(({ id, name, description }) => ({ id, name, description })), evaluationAudit: projectLearningEvaluationAudit(project), runtimeCapabilityScope: { assignedSkillIds: project.assignments?.skillIds ?? [], assignedToolIds: project.assignments?.toolIds ?? [], assignedMcpServerIds: project.assignments?.mcpServerIds ?? [], evaluationExcludes: ['host-assigned external skills', 'MCP', 'live network', 'shell', 'browser', 'production workspace', 'project memory'], meaning: 'The isolated evaluation measures the genome and explicit fixtures only; it is not equivalent to the ordinary project runtime.' }, evaluationCoverage: { cases: baseline?.evaluationSuite?.cases?.length ?? 0, workspaceCases: baseline?.evaluationSuite?.cases?.filter(row => row.workspace).length ?? 0, browserVisual: 'not_available', meaning: 'Frozen tests limit what a passing version proves. No independent visual or general capability claim follows from a text-only suite.' } }))) });
  }
  async execute(context, { decision, episodes, reviewId, signal }) {
    if (!this.valid(context)) throw fail('learning_scope_changed');
    const project = this.project(context.projectId);
    const deferred = reason => ({ deferred: true, reason, nextAttemptAt: this.now() + 60000 });
    if (project.trialVersionId) return deferred('trial_in_progress');
    if (this.evolutionService.running.has(project.id)) return deferred('evolution_busy');
    if (!project.versions?.find(row => row.id === project.activeVersionId)?.bundle?.genome) return deferred('baseline_bundle_required');
    // Store mutations replace the root snapshot; capture this read version once
    // so the source collector cannot mix in later streaming conversation text.
    const sourceState = this.store.state;
    const redact = learningRedactor(this.store); let frozen;
    try { frozen = await this.freezeFiles(copy(project), episodes, { signal, redact, sourceState, deniedPaths: privateStatePaths(this.store.file) }); }
    catch (error) { if (signal.aborted) throw signal.reason; return deferred('learning_source_unavailable'); }
    signal.throwIfAborted(); if (!this.valid(context)) throw fail('learning_scope_changed');
    const evidence = episodes.map(row => ({ id: row.id, type: row.kind, summary: row.summary, at: Date.parse(row.at) }));
    // The full reflection remains in its review record. This bounded authoring
    // handoff contains the method and falsifiable test, never invented evidence.
    const content = [decision.hypothesis.slice(0, 550), decision.intervention.slice(0, 650), decision.validationPlan.slice(0, 650)].join('\n');
    const provider = this.store.state.configuration.providers.find(row => row.id === context.model.providerId);
    this.mutate(state => { const current = state.projects.find(row => row.id === project.id); current.evolution.lastAutonomousStartedAt = new Date(this.now()).toISOString(); current.learningRuntime.sourceCoverage = frozen.coverage; });
    let result;
    try { result = await this.evolutionService.evolve(project.id, { learningReviewId: reviewId, evidence, learningIntent: { content, reason: decision.reason.slice(0, 600), evidenceIds: decision.evidenceIds }, learningContext: frozen.context,
      model: context.model, apiKey: this.store.configurationService.secret(provider.id, provider), signal, requestControl: context.budget, commitGuard: () => this.valid(context) }); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error.code === 'evolution_busy') return deferred(error.code);
      if (this.evolutionService instanceof ProjectEvolutionService && !this.project(project.id)?.versions.some(row => row.learningReviewId === reviewId)) return deferred('evolution_preflight_failed');
      throw error;
    }
    return { status: result.status, versionId: result.version?.id, summary: result.summary, usage: result.usage };
  }
  deliverReady(project) {
    if (!this.enabled(project) || project.trialVersionId || project.initiative.notificationMuted || Date.parse(project.initiative.quietUntil) > this.now() || this.now() - Date.parse(project.initiative.lastSpokeAt) < (project.initiative.cooldownMs ?? 300000)) return;
    const presence = this.store.presences?.get(project.id);
    if (project.initiative.deferWhileTyping !== false && presence?.visible && presence.typing && Date.parse(presence.expiresAt) > this.now()) return;
    const baseline = project.versions?.find(row => row.id === project.activeVersionId);
    const version = project.versions?.find(row => (row.learningReviewId || row.source === 'explicit-authoring-retry' && row.retryOfLearningReviewId) && row.parentVersionId === project.activeVersionId && row.state === 'ready' && row.bundle?.hash && row.evaluation?.simulated === false && row.evaluation?.candidateHash === row.bundle.hash && row.evaluation?.baselineHash === baseline?.bundle?.hash && row.evaluation?.gatePassed === true && row.evaluationRuntimeHash === PROJECT_EVALUATION_RUNTIME_HASH && row.evaluation?.evaluationRuntimeHash === PROJECT_EVALUATION_RUNTIME_HASH && !row.sourceDeleted && !row.contextRevoked && !row.learningNotificationDeliveredAt);
    if (!version) return;
    const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side'), session = sessions.find(row => row.id === presence?.sessionId) ?? sessions.find(row => row.id === project.primarySessionId) ?? sessions[0];
    if (!session) return;
    this.mutate(state => {
      const current = state.projects.find(row => row.id === project.id), candidate = current.versions.find(row => row.id === version.id), target = state.sessions.find(row => row.id === session.id), key = `learning-version:${version.id}`;
      if (!target.items.some(row => row.initiativeDeliveryKey === key)) target.items.push({ id: randomUUID(), kind: 'assistant', source: 'initiative', simulated: false, projectId: project.id, versionId: version.id, createdAt: new Date(this.now()).toISOString(), decisionMode: 'verified-evaluation', initiativeDeliveryKey: key, initiative: { kind: 'version_ready' }, evidenceIds: copy(version.evidenceIds ?? []), reason: '当前冻结用例及脚本检查已通过，提供可撤销的项目版本试用。', text: `项目能力候选「${version.title}」已通过当前冻结用例和脚本检查，可以试用。评估覆盖有限，尚未证明页面视觉效果或通用能力提升；当前使用的版本没有替换。` });
      candidate.learningNotificationDeliveredAt = new Date(this.now()).toISOString(); current.initiative.lastSpokeAt = candidate.learningNotificationDeliveredAt; target.updatedAt = candidate.learningNotificationDeliveredAt;
    });
  }
  async pump() {
    if (this.closed || this.pumping || this.store.maintenanceHeld) return;
    this.pumping = true;
    try {
      for (const [id, context] of this.contexts) if (!this.valid(context) && !context.closing) context.closing = context.coordinator.close().then(() => { if (this.contexts.get(id) === context) this.contexts.delete(id); this.schedule(); }, error => { context.lastError = error.code ?? 'learning_cleanup_failed'; });
      const projects = [...this.store.state.projects], start = this.cursor % Math.max(1, projects.length);
      for (const project of [...projects.slice(start), ...projects.slice(0, start)]) {
        if (this.closed) break;
        if (!this.enabled(project) || project.skillFoundation?.status === 'preparing') continue;
        let model; try { model = this.model(project); } catch { continue; } if (model.execution !== 'rna') continue;
        const context = this.contexts.get(project.id) ?? await this.create(project, model, this.scope(project, model));
        if (context.closing || !this.valid(context)) continue;
        context.coordinator.updatePolicy({ experimentNotBefore: autonomousLearningNotBefore(this.project(project.id)) });
        // Terminal identities change only after an actual execution outcome.
        const identity = learningHash([this.store.state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side').map(sessionIdentity), project.initiativeRuntime?.sdkState?.actions?.map(row => [row.id, row.action, row.status, row.finishedAt])]);
        if (context.lastProjection !== identity) {
          const current = this.project(project.id), since = current.learningRuntime?.evidenceFloor;
          const projected = projectLearningEpisodes(this.store.state, current, context.evidenceNamespace, { redact: learningRedactor(this.store), since });
          const accepted = await context.coordinator.ingest(projected.episodes);
          if (!accepted.deferred.length) context.lastProjection = identity;
          if (accepted.accepted.length && context.judgeDeferred) { context.notBefore = 0; context.judgeDeferred = false; }
          this.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.learningRuntime ??= {}; target.learningRuntime.evidenceCoverage = projected.coverage; target.learningRuntime.backpressure = accepted.deferred; if (since == null) target.learningRuntime.evidenceFloor = projected.episodes.length ? Math.min(...projected.episodes.map(row => Date.parse(row.at))) : this.now(); });
        }
        this.deliverReady(this.project(project.id));
        if (context.promise || this.now() < context.notBefore || [...this.contexts.values()].filter(row => row.promise || row.coordinator.health().unsettledOperations).length >= this.maxConcurrentReviews) continue;
        // Pace only new model reflections. Evidence ingestion, restart
        // reconciliation, durable experiment decisions and ready notices keep
        // progressing while this project is resting or outside its cadence.
        const queued = context.coordinator.hasReviewStatus('queued_experiment');
        if (!queued && !projectRhythmStatus(this.store.state, this.project(project.id), { now: this.now() }).evolution.eligible) continue;
        context.promise = (async () => {
          const snapshot = context.coordinator.snapshot();
          context.judgeAbort = new AbortController(); context.judgeEvidenceKey = projectRhythmEvidenceKey(this.store.state, this.project(project.id));
          const evidence = snapshot.episodes.filter(row => row.status === 'pending' || row.status === 'deferred' && row.nextReviewAt <= this.now());
          const gate = !queued && evidence.length && this.now() >= snapshot.nextReviewAt ? await this.decisions?.review('evolution.review', this.project(project.id), { evidence, revision: context.scope, signal: context.judgeAbort.signal }) : null;
          if (!this.valid(context)) return { status: 'stale' };
          if (gate?.review === false) { context.notBefore = gate.retryAt; context.judgeDeferred = true; return { status: 'judgment_deferred' }; }
          context.judgeDeferred = false;
          // evidence.select: the batch about to be reviewed keeps only episodes with something to learn from.
          // Not before the main model has authored the project's judgment plan: until then learning makes no JEV requests.
          if (gate && !queued && gate.reason !== 'assessment_plan_required') await this.selectEvidence(context, project.id, evidence);
          if (!this.valid(context)) return { status: 'stale' };
          context.judgeEvidenceKey = null; context.judgeAbort = null;
          return context.coordinator.tick();
        })().then(result => { context.lastResult = result.status; if (['completed', 'no_change', 'deferred', 'queued_experiment', 'experiment_waiting'].includes(result.status)) context.lastError = null; }, error => { if (!context.judgeAbort?.signal.aborted) context.lastError = error.code ?? 'learning_failed'; }).finally(() => { context.judgeAbort = null; context.judgeEvidenceKey = null; context.promise = null; });
      }
      this.cursor = (start + 1) % Math.max(1, projects.length);
      this.lastError = null;
    } finally { this.pumping = false; }
  }
  /** Routine episodes of the next review batch (confidently nothing to learn) are settled unreviewed. */
  async selectEvidence(context, projectId, evidence) {
    if (typeof this.decisions?.evidenceSelect !== 'function') return 0;
    const batch = [...evidence].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, Math.min(8, context.coordinator.policy?.maxBatch ?? 8));
    const judged = await this.decisions.evidenceSelect(this.project(projectId), { episodes: batch.map(row => ({ id: row.id, kind: row.kind, summary: row.summary })), signal: context.judgeAbort?.signal }).catch(() => null);
    if (!judged?.quiet?.length || !this.valid(context)) return 0;
    return context.coordinator.dismiss(judged.quiet.map(index => batch[index]?.id).filter(Boolean), 'no_signal');
  }
  async drainDeletedSession(record) {
    const context = this.contexts.get(record.projectId); if (context) { await context.coordinator.close(); this.contexts.delete(record.projectId); }
    this.mutate(state => { const project = state.projects.find(row => row.id === record.projectId); if (project?.learningRuntime?.sdkState) project.learningRuntime.sdkState = revokeLearningSources(project.learningRuntime.sdkState, [`session:${record.sessionId}`], 'session_deleted'); });
  }
  health() { return { lastError: this.lastError ?? null, projects: [...this.contexts.values()].map(context => ({ projectId: context.projectId, ...context.coordinator.health(), lastResult: context.lastResult ?? null, lastError: context.lastError ?? null })) }; }
  async close() { this.closed = true; clearInterval(this.timer); clearImmediate(this.scheduled); this.unsubscribe(); for (const context of this.contexts.values()) context.judgeAbort?.abort(); await Promise.all([...this.contexts.values()].map(context => context.coordinator.close())); }
}
