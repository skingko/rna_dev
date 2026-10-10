import { createBrowserEvaluationAdapter } from '../../packages/sdk/src/project-evaluation-browser-adapter.mjs';
import { createProjectEvaluationPartitionPlan, validateProjectEvaluationPartitionPlan, createProjectEvaluationConfirmationClaim, settleProjectEvaluationConfirmationClaim, createProjectEvaluationPhaseLedger } from '../../packages/sdk/src/project-evaluation-partitions.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, appendFile, readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { streamCompletion } from '../../packages/sdk/src/providers.mjs';
import { proposeProjectGenome, evaluateProjectGenomes, validateProjectEvolutionLearningIntent, PROJECT_EVALUATION_RUNTIME, PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';
import { createProjectEvaluationRevision, projectEvaluationRevisionDiff } from '../../packages/sdk/src/project-evaluation-revision.mjs';
import { createProjectEvaluationExecutionManifest } from '../../packages/sdk/src/project-evaluation-profile.mjs';
import { projectGenomeHash, validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { evolutionHash } from '../../packages/sdk/src/evolution.mjs';
import { ProjectGenomeStore } from './project-genome-store.mjs';
import { describeEvolutionAssessment } from './project-evolution-assessment.mjs';
import { SkillMarketplaceService, referenceDiscoverySummary } from './skill-marketplace-service.mjs';
import { getProjectEvolutionIdentity, findMatchingEvolutionAttempt } from './project-evolution-identity.mjs';
import { createProjectLearningContext, validateProjectLearningContext } from '../../packages/sdk/src/learning-context.mjs';
import { learningRedactor } from './project-learning-evidence.mjs';
import { loadAuthoringRecoveryArtifacts, reconstructFailedAuthorInput } from './evolution-authoring-recovery.mjs';
import { learningCredentialIdentity } from './project-learning-scope.mjs';
import { standardOnlyBaselineChange, standardAdoptionAvailable } from './project-standard-lineage.mjs';
import { resolveModel } from './configuration.mjs';
import { projectLearningEvaluationAudit } from './project-learning-evidence.mjs';
import { createEvolutionSearchContext, createEvolutionSearchPolicy, describeEvolutionSearchOutcome } from './project-evolution-search.mjs';
import { createEvolutionSkillDeliveryDiagnostic } from './project-skill-discovery-feedback.mjs';
import { purposeProvider } from './usage-cache-service.mjs';
import { ProjectEvolutionRrsi } from './project-evolution-rrsi.mjs';
import { rrsiPrescreen } from '../../packages/sdk/src/project-rrsi.mjs';

const copy = value => structuredClone(value), now = () => new Date().toISOString();
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedTokens: 0 });
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const anchor = project => evolutionHash([project.id, project.name, project.description, project.workspace, project.activeVersionId, project.trialVersionId, project.assignments, project.focus, project.commitments]);
const active = project => project && !project.archivedAt && project.initialization?.status === 'ready';

/** Produces immutable, actually evaluated candidates. Choosing a candidate for
 * trial/adoption remains a separate host operation. Evaluation files survive
 * failures; a rejected generation never replaces the active runtime bundle.
 */
export class ProjectEvolutionService {
  constructor(store, { genomeStore = new ProjectGenomeStore(store), provider = streamCompletion, marketplaceService = new SkillMarketplaceService(store), browserAdapterFactory = createBrowserEvaluationAdapter, rrsi, decisionService = null } = {}) {
    // P4 RRSI: history, budget, critic, JEV prior, smoke tier and selection.
    // Advisory until the noise band is measured; never adopts a version.
    this.rrsi = rrsi === undefined ? new ProjectEvolutionRrsi(store) : rrsi; this.decisions = decisionService;
    this.browserAdapterFactory = browserAdapterFactory; this.store = store; this.genomes = genomeStore; this.provider = provider; this.marketplaces = marketplaceService; this.running = new Map(); this.rootDir = resolve(`${store.file}.evolution`);
    // A persisted in-flight request has an unknown completion boundary. Retain
    // its trace and mark it interrupted instead of repeating paid requests.
    if (store.state.projects.some(project => project.versions?.some(version => version.simulated === false && ['proposing', 'evaluating'].includes(version.state)) || project.evolution?.request?.status === 'running')) store.mutate(state => {
      for (const project of state.projects) {
        for (const version of project.versions ?? []) if (version.simulated === false && ['proposing', 'evaluating'].includes(version.state)) Object.assign(version, { state: 'interrupted', completedAt: now(), notice: '服务在进化过程中重启；已有执行证据保留，不自动重放评测。', error: { code: 'restart_interrupted', message: 'Evolution was interrupted by a service restart.' } });
        if (project.evolution?.request?.status === 'running') Object.assign(project.evolution.request, { status: 'interrupted', completedAt: now(), summary: '服务重启中断评测；保留已有证据，需显式重新发起。' });
      }
    });
  }
  project(id) { return this.store.state.projects.find(project => project.id === id); }
  freezeLearningContext(value, evidence, apiKey) {
    const snapshot = validateProjectLearningContext(value, evidence); if (!snapshot) return undefined;
    const configuration = this.store.state.configuration, capabilities = this.store.state.capabilities ?? {};
    const environments = [...(configuration.providers ?? []).map(provider => provider.apiKeyEnv), configuration.memory?.apiKeyEnv, ...[...(capabilities.tools ?? []), ...(capabilities.mcpServers ?? [])].flatMap(item => [...(item.envNames ?? []), ...Object.values(item.envMapping ?? {}), ...Object.values(item.headerEnv ?? {})])];
    const secrets = [...new Set([apiKey, ...Object.values(this.store.configurationService.secrets ?? {}), ...(this.store.configurationService.secretValues?.() ?? []), ...environments.filter(Boolean).map(name => process.env[name])].filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
    for (const row of [...snapshot.evidence, ...snapshot.files]) for (const secret of secrets) for (const form of new Set([secret, encodeURIComponent(secret)])) row.content = row.content.split(form).join('[REDACTED]');
    return createProjectLearningContext(snapshot, evidence);
  }
  retrySource(project, versionId, { revision = false } = {}) {
    const source = project?.versions.find(version => version.id === versionId);
    if (typeof versionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(versionId) || !source || source.simulated !== false) throw fail('未找到可重评的真实候选。', 'retry_source_invalid', 400);
    if (source.sourceDeleted || source.contextRevoked) throw fail('候选来源会话已删除，原评估不能重放；请基于保留的项目证据重新评估。', 'retry_source_deleted');
    const assessment = describeEvolutionAssessment(source, { activeVersionId: project.activeVersionId, project });
    if (revision) {
      if (!active(project) || source.parentVersionId !== project.activeVersionId || !assessment.candidateRetained || ['proposing', 'evaluating'].includes(source.state) || source.evaluationRevision) throw fail('基准修订需要同一已采用基线下保留完整的原候选。', 'revision_source_invalid');
    } else if (!assessment.retry.available && !this.standardOnlyBaselineChange(project, source)) throw fail(assessment.retry.reason, 'retry_unavailable');
    return source;
  }
  standardOnlyBaselineChange(project, source) { return standardOnlyBaselineChange(project, source); }
  previewEvaluationRevision(projectId, { retryVersionId, evaluationRevision } = {}) {
    const project = this.project(projectId), source = this.retrySource(project, retryVersionId, { revision: true });
    const baseline = project.versions.find(item => item.id === project.activeVersionId);
    const revision = createProjectEvaluationRevision(baseline.bundle.genome, evaluationRevision);
    return { status: 'preview', baseVersionId: baseline.id, sourceVersionId: source.id, sourceCandidateHash: source.candidateHash ?? source.bundle?.hash, revision, changes: projectEvaluationRevisionDiff(baseline.bundle.genome.evaluationSuite, revision.suite), adoption: 'separate_review_required' };
  }
  async adoptEvaluationStandard(projectId, { reviewVersionId, revisionHash } = {}) {
    if (this.running.has(projectId)) throw fail('当前项目仍有进化操作。', 'evolution_busy');
    const project = copy(this.project(projectId)), review = project?.versions.find(item => item.id === reviewVersionId);
    if (!standardAdoptionAvailable(project, review) || review.evaluationRevision.revisionHash !== revisionHash) throw fail('标准采用需要当前基线下完整且未撤销的配对评估及精确修订哈希。', 'standard_adoption_invalid');
    const controller = new AbortController(), expectedAnchor = anchor(project), versionId = randomUUID(); let prepared, published = false;
    this.running.set(projectId, { controller, versionId });
    const valid = () => !controller.signal.aborted && !this.store.state.emergency && active(this.project(projectId)) && anchor(this.project(projectId)) === expectedAnchor && this.project(projectId).versions.some(item => item.id === reviewVersionId && !item.sourceDeleted && !item.contextRevoked && evolutionHash(item.evaluationRevision) === evolutionHash(review.evaluationRevision)) && this.project(projectId).versions.some(item => item.id === review.retryOfVersionId && !item.sourceDeleted && !item.contextRevoked);
    try {
      const baseline = await this.genomes.read(projectId, project.activeVersionId);
      if (baseline.hash !== review.baselineHash) throw fail('原基线内容已变化。', 'standard_baseline_changed');
      const root = await realpath(this.rootDir), path = join(root, projectId, reviewVersionId, 'frozen-evaluation.json');
      if (await realpath(path) !== path) throw fail('标准证据路径已变化。', 'standard_evidence_changed');
      const frozen = JSON.parse(await readFile(path, 'utf8')), revision = createProjectEvaluationRevision(baseline.genome, review.evaluationRevision);
      if (evolutionHash(frozen.evaluationRevision) !== evolutionHash(revision) || frozen.hash !== revision.suiteHash || evolutionHash(frozen.suite) !== revision.suiteHash || review.evaluation.suiteHash !== revision.suiteHash) throw fail('修订标准与冻结评估证据不符。', 'standard_evidence_changed');
      const genome = { ...baseline.genome, evaluationSuite: revision.suite };
      const unchangedCapabilitiesHash = evolutionHash({ systemPrompt: baseline.genome.systemPrompt, skills: baseline.genome.skills, tools: baseline.genome.tools });
      prepared = await this.genomes.prepare(project, { genome, versionId, parentVersionId: baseline.versionId, signal: controller.signal });
      if (!valid()) throw fail('标准采用期间项目已变化。', 'stale');
      await prepared.commit();
      const version = { id: versionId, version: `standard-${project.versions.length}`, title: '评估标准修订（项目能力保持）', state: 'active', source: 'adopted-evaluation-standard', simulated: false, parentVersionId: baseline.versionId, createdAt: now(), adoptedAt: now(), bundle: prepared.record, assignments: copy(project.assignments), generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, skillManifests: prepared.skillManifests, toolDescriptors: prepared.toolDescriptors,
        standardRevision: { schemaVersion: 1, reviewVersionId, revisionHash, sourceBaselineVersionId: baseline.versionId, sourceBaselineHash: baseline.hash, sourceSuiteHash: revision.sourceSuiteHash, suiteHash: revision.suiteHash, unchangedCapabilitiesHash, reason: revision.reason }, notice: '仅采用已审阅的评估标准；系统提示、技能和工具原文保持。候选未采用，没有新的能力提升评分。' };
      this.store.mutate(state => { if (!valid()) throw fail('标准采用提交前项目已变化。', 'stale'); const current = state.projects.find(item => item.id === projectId); current.versions.push(version); current.activeVersionId = versionId; });
      published = true; return { status: 'standard_adopted', version: copy(version), usage: zeroUsage() };
    } finally { if (prepared && !published) await prepared.rollback().catch(() => {}); this.running.delete(projectId); }
  }
  authoringRetrySource(project, versionId) {
    const source = project?.versions?.find(version => version.id === versionId);
    if (typeof versionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(versionId) || !source || source.simulated !== false) throw fail('未找到可恢复生成的真实失败记录。', 'author_retry_source_invalid', 400);
    if (source.sourceDeleted || source.contextRevoked) throw fail('原候选来源已撤销，不能恢复其生成。', 'author_retry_source_revoked');
    if (!active(project) || source.parentVersionId !== project.activeVersionId) throw fail('项目或已采用基线已变化，不能恢复原作者实验。', 'author_retry_baseline_changed');
    if (source.state !== 'failed' || source.bundle || source.proposal || source.candidateHash || source.error?.diagnostic?.phase !== 'proposal'
      || !/^[a-f0-9]{64}$/.test(source.learningContextHash ?? '') || !source.learningIntent || typeof source.learningReviewId !== 'string' || !source.learningReviewId) throw fail('该记录不是具有冻结来源的未完成候选生成；已有候选请使用重评。', 'author_retry_unavailable');
    return copy(source);
  }
  async regenerateAuthor(projectId, { retryAuthorVersionId, model, apiKey, signal, tokenBudget = null, requestControl, onProgress = () => {}, commitGuard = () => true } = {}) {
    const incurred = zeroUsage(), receipts = new Set();
    try {
      signal?.throwIfAborted(); this.authoringRetrySource(this.project(projectId), retryAuthorVersionId);
      const artifacts = await loadAuthoringRecoveryArtifacts({ rootDir: this.rootDir, projectId, versionId: retryAuthorVersionId, signal });
      signal?.throwIfAborted();
      const recovered = reconstructFailedAuthorInput({ state: this.store.state, projectId, versionId: retryAuthorVersionId, artifacts, model, credentialIdentity: learningCredentialIdentity(this.store, model), redact: learningRedactor(this.store) });
      const valid = () => {
        if (signal?.aborted || !commitGuard()) return false;
        try {
          const current = this.project(projectId); this.authoringRetrySource(current, retryAuthorVersionId);
          const currentModel = resolveModel(this.store.state.configuration, current.initiative?.modelSelection ?? null);
          return evolutionHash(currentModel) === evolutionHash(model) && recovered.guard({ state: this.store.state, model: currentModel, credentialIdentity: learningCredentialIdentity(this.store, currentModel), redact: learningRedactor(this.store) }) === true;
        }
        catch { return false; }
      };
      if (!valid()) throw fail('冻结来源或项目权限已变化，未重新发送作者请求。', 'author_retry_context_changed');
      const control = {
        beforeRequest: async input => {
          input.signal?.throwIfAborted(); if (!valid()) throw fail('原实验来源已变化，后续模型请求已停止。', 'author_retry_context_changed');
          await requestControl?.beforeRequest?.(input);
          try { input.signal?.throwIfAborted(); if (!valid()) throw fail('原实验来源在请求准入时变化，未发送模型请求。', 'author_retry_context_changed'); }
          catch (error) {
            // The SDK has not yet received a successful admission return, so
            // settle this adapter's accepted reservation before propagating.
            await control.onUsage({ id: input.id, phase: input.phase, usage: zeroUsage(), usageReported: false, estimatedWhenUnknown: false, completed: false, requestStarted: false, cancelledBeforeSend: true });
            throw error;
          }
        },
        onUsage: async entry => {
          if (!receipts.has(entry.id)) { receipts.add(entry.id); for (const key of Object.keys(incurred)) incurred[key] += Math.max(0, Number(entry.usage?.[key]) || 0); }
          await requestControl?.onUsage?.(entry);
        },
      };
      return await this.evolve(projectId, { evidence: recovered.evidence, learningContext: recovered.learningContext, learningIntent: recovered.learningIntent,
        authoringRecovery: recovered.provenance, model, apiKey, signal, tokenBudget, requestControl: control, onProgress, commitGuard: valid, retryFailed: true });
    } catch (error) {
      // Preflight has no provider bill. If an adapter unexpectedly throws after
      // dispatch, keep every actual request receipt rather than resetting it.
      error.usage ??= copy(incurred); throw error;
    }
  }
  async retryGenome(project, versionId, baselineHash, { revision = false } = {}) {
    const source = this.retrySource(project, versionId, { revision });
    if (source.baselineHash !== baselineHash && !this.standardOnlyBaselineChange(project, source)) throw fail('原冻结基线已变化，不能重放旧评估。', 'retry_baseline_changed');
    if (source.baselineHash !== baselineHash) { const oldBaseline = await this.genomes.read(project.id, source.parentVersionId); if (oldBaseline.hash !== source.baselineHash) throw fail('原基线证据已变化。', 'retry_baseline_changed'); }
    let genome, retainedProposal;
    const readProposal = async () => {
      const path = join(await realpath(this.rootDir), project.id, source.id, 'proposal.json');
      if (await realpath(path) !== path) throw fail('候选证据路径发生变化。', 'retry_evidence_changed');
      return JSON.parse(await readFile(path, 'utf8'));
    };
    if (source.bundle) genome = (await this.genomes.read(project.id, source.id)).genome;
    else {
      retainedProposal = await readProposal(); genome = validateProjectGenome(retainedProposal.genome);
    }
    if (projectGenomeHash(genome) !== (source.candidateHash ?? source.bundle?.hash)) throw fail('候选内容与保存的评估身份不符。', 'retry_evidence_changed');
    if (source.evaluationExecution || source.proposal?.assetChanges || retainedProposal?.assetChanges) {
      retainedProposal ??= await readProposal();
      if (projectGenomeHash(validateProjectGenome(retainedProposal.genome)) !== projectGenomeHash(genome) || evolutionHash(retainedProposal.assetChanges ?? null) !== evolutionHash(source.proposal?.assetChanges ?? null)) throw fail('候选资产变更声明与原始提案不符。', 'retry_evidence_changed');
    }
    let standardRebase;
    if (source.baselineHash !== baselineHash) {
      const currentBaseline = await this.genomes.read(project.id, project.activeVersionId);
      if (currentBaseline.hash !== baselineHash || !this.standardOnlyBaselineChange(project, source)) throw fail('标准重定位身份已变化。', 'retry_baseline_changed');
      const capabilitiesHash = value => evolutionHash({ systemPrompt: value.systemPrompt, skills: value.skills, tools: value.tools });
      const before = capabilitiesHash(genome), priorCandidateHash = projectGenomeHash(genome);
      genome = validateProjectGenome({ ...genome, evaluationSuite: currentBaseline.genome.evaluationSuite });
      if (capabilitiesHash(genome) !== before) throw fail('标准重定位不能改变候选能力。', 'retry_evidence_changed');
      standardRebase = { schemaVersion: 1, priorCandidateHash, unchangedCandidateCapabilitiesHash: before, sourceVersionId: source.id, adoptedStandardVersionId: project.activeVersionId, suiteHash: evolutionHash(genome.evaluationSuite) };
    }
    return { source, genome, standardRebase };
  }
  async evolve(projectId, { evidence = [], learningIntent, learningContext, learningReviewId, authoringRecovery, model, apiKey, signal, tokenBudget = null, genome, summary, retryFailed = false, retryVersionId, evaluationRevision, reviewedRevisionHash, partitionPlan, onProgress = () => {}, commitGuard = () => true, requestControl } = {}) {
    if (this.running.has(projectId)) throw fail('当前项目正在评估一个版本，请等待完成。', 'evolution_busy');
    evidence = copy(evidence); evaluationRevision = evaluationRevision === undefined ? undefined : copy(evaluationRevision);
    const project = copy(this.project(projectId));
    if (!active(project)) throw fail('项目尚未完成初始化或已归档。', 'project_unavailable');
    if (project.skillFoundation?.status === 'preparing') throw fail('正在将项目基础技能纳入版本，请稍后再评估改进。', 'foundation_busy');
    if (project.trialVersionId) throw fail('请先结束当前试用，再从已采用版本生成下一候选。', 'trial_in_progress');
    const baselineVersion = project.versions.find(version => version.id === project.activeVersionId);
    if (!baselineVersion?.bundle?.genome) throw fail('当前版本没有可执行项目能力包，请先重新初始化项目能力。', 'baseline_bundle_required');
    if (!model || model.execution === 'simulation' || model.providerId === 'demo') throw fail('真实进化需要已配置模型。', 'configured_model_required');
    model = copy(model);
    if (evaluationRevision !== undefined && (retryVersionId === undefined || genome !== undefined || authoringRecovery)) throw fail('基准修订只适用于原候选的独立配对重评。', 'revision_conflicting_input', 400);
    const intent = validateProjectEvolutionLearningIntent(learningIntent, evidence);
    if (learningReviewId !== undefined && (typeof learningReviewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(learningReviewId))) throw fail('学习评估标识无效。', 'invalid_learning_review_id', 400);
    const sources = this.freezeLearningContext(learningContext, evidence, apiKey);
    const controller = new AbortController(), merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    merged.throwIfAborted(); const versionId = randomUUID(), expectedAnchor = anchor(project), usage = zeroUsage(), requests = [], dir = join(this.rootDir, projectId, versionId);
    let prepared, published = false, savedVersion, evaluationExecution, evaluationPartitions, search, searchContext, trace = Promise.resolve(); this.running.set(projectId, { controller, versionId });
    let rrsiDirectives, rrsiReview, rrsiRecords = 0, rrsiTiers = [], rrsiEdits = [], rrsiPrescore, rrsiSignals, rrsiBaseline, rrsiProposal, rrsiSmoke, rrsiContext, rrsiGit;
    const addUsage = value => { for (const key of Object.keys(usage)) usage[key] += Math.max(0, Number(value?.[key]) || 0); };
    let revisionSource;
    const revisionSourceValid = () => !revisionSource || this.project(projectId)?.versions.some(item => item.id === revisionSource.id && !item.sourceDeleted && !item.contextRevoked && (item.candidateHash ?? item.bundle?.hash) === (revisionSource.candidateHash ?? revisionSource.bundle?.hash));
    const searchSourcesValid = () => (search?.sourceVersionIds ?? []).every(id => this.project(projectId)?.versions.some(row => row.id === id && !row.sourceDeleted && !row.contextRevoked));
    const valid = () => revisionSourceValid() && searchSourcesValid() && !merged.aborted && active(this.project(projectId)) && anchor(this.project(projectId)) === expectedAnchor && commitGuard();
    const update = (patch, { evaluatedAt } = {}) => this.store.mutate(state => { const current = state.projects.find(item => item.id === projectId), version = current?.versions.find(item => item.id === versionId); if (version) { Object.assign(version, copy(patch)); version.assessment = describeEvolutionAssessment(version, { activeVersionId: current.activeVersionId, project: current }); version.searchFeedback = describeEvolutionSearchOutcome(version, baselineVersion.bundle.genome); if (evaluatedAt) current.evolution.lastEvaluatedAt = evaluatedAt; } });
    const report = event => { const row = { at: now(), ...copy(event) }; trace = trace.then(() => appendFile(join(dir, 'trace.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 })); onProgress(row); };
    const artifact = async (name, data) => { const path = join(dir, name), pending = `${path}.tmp`; await writeFile(pending, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(pending, path); };
    try {
      const baselineRecord = await this.genomes.read(project.id, baselineVersion.id), baseline = validateProjectGenome(baselineRecord.genome);
      evaluationExecution = createProjectEvaluationExecutionManifest(baseline.evaluationSuite, model);
      let retrySource, standardRebase;
      if (retryVersionId !== undefined) {
        if (genome !== undefined) throw fail('重评原候选不能同时提交修改后的能力包。', 'retry_conflicting_input', 400);
        const retry = await this.retryGenome(project, retryVersionId, baselineRecord.hash, { revision: evaluationRevision !== undefined }); retrySource = retry.source; revisionSource = retrySource; standardRebase = retry.standardRebase; genome = retry.genome; retryFailed = true;
      }
      if (evaluationRevision !== undefined) {
        evaluationRevision = createProjectEvaluationRevision(baseline, evaluationRevision, genome);
        if (reviewedRevisionHash !== evaluationRevision.revisionHash) throw fail('提交内容与已审阅的标准修订不一致，请重新预览。', 'revision_review_required', 400);
        revisionSource = retrySource; evaluationExecution = createProjectEvaluationExecutionManifest(evaluationRevision.suite, model);
      }
      const priorPlanSource = retrySource ?? (authoringRecovery ? this.authoringRetrySource(project, authoringRecovery.sourceVersionId) : undefined);
      if (priorPlanSource?.evaluationPartitions) {
        const frozenRoot = await realpath(this.rootDir), frozenPath = join(frozenRoot, projectId, priorPlanSource.id, 'frozen-evaluation.json');
        const frozenStat = await lstat(frozenPath);
        if (!frozenStat.isFile() || frozenStat.size > 8 * 1024 * 1024 || await realpath(frozenPath) !== frozenPath) throw fail('原实验冻结证据路径无效。', 'evaluation_partition_changed');
        const priorFrozen = JSON.parse(await readFile(frozenPath, 'utf8'));
        if (evolutionHash(priorFrozen.evaluationPartitions) !== evolutionHash(priorPlanSource.evaluationPartitions)) throw fail('原实验分区与冻结证据不匹配。', 'evaluation_partition_changed');
        if (priorPlanSource.evaluationPartitions.confirmation.status === 'available' && partitionPlan?.confirmation.status === 'not_applicable') throw fail('重评不能移除原独立确认门槛。', 'evaluation_confirmation_downgrade');
      }
      const inheritedPlan = priorPlanSource?.evaluationPartitions;
      const revisedSelectionOnly = (evaluationRevision || standardRebase) && inheritedPlan?.assignments.every(row => row.partition === 'selection') && inheritedPlan.suiteHash !== evolutionHash(evaluationRevision?.suite ?? baseline.evaluationSuite);
      const requestedPlan = partitionPlan ?? (revisedSelectionOnly ? undefined : inheritedPlan);
      evaluationPartitions = requestedPlan
        ? validateProjectEvaluationPartitionPlan(requestedPlan, evaluationRevision?.suite ?? baseline.evaluationSuite)
        : createProjectEvaluationPartitionPlan({ suite: evaluationRevision?.suite ?? baseline.evaluationSuite });
      const inputGenomeHash = genome ? projectGenomeHash(validateProjectGenome(genome)) : null;
      const evaluationPartitionIdentity = evaluationPartitions.assignments.some(row => row.partition !== 'selection') ? evolutionHash({ method: evaluationPartitions.method, assignments: evaluationPartitions.assignments, suiteHash: evaluationPartitions.suiteHash, confirmation: evaluationPartitions.confirmation }) : undefined;
      const identity = getProjectEvolutionIdentity(project, { evidence, model, inputGenomeHash, baselineHash: baselineRecord.hash, learningContextHash: sources?.contextHash, evaluationPartitionIdentity });
      const { evidenceHash, modelHash, evidenceIdentityVersion, evidenceFingerprints, inputFingerprint } = identity;
      // A hypothesis is falsified only against the same incumbent and model; an adopted
      // baseline or another model may re-test it (explicit retries are never blocked).
      rrsiContext = { model: modelHash, baseline: baselineRecord.hash };
      searchContext = createEvolutionSearchContext({ baseline, evidence, modelHash, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, evaluationExecution, evaluationPartitions, learningContextHash: sources?.contextHash });
      search = createEvolutionSearchPolicy(project, { baseline, context: searchContext, redact: learningRedactor(this.store) });
      if (genome) search.sourceVersionIds = [];
      // RRSI proposer context: annealed edit budget tightens the structural scope;
      // history/falsified/exploration directives reach the author once history exists.
      if (!genome && this.rrsi) try {
        rrsiDirectives = await this.rrsi.directives(projectId, { baselineHash: baselineRecord.hash }); rrsiRecords = (await this.rrsi.records(projectId)).length;
        if (search.policy && Number.isInteger(search.policy.maxChangedAssets)) search.policy.maxChangedAssets = Math.max(1, Math.min(search.policy.maxChangedAssets, rrsiDirectives.budget));
      } catch { rrsiDirectives = undefined; }
      if (authoringRecovery) {
        const source = this.authoringRetrySource(project, authoringRecovery.sourceVersionId);
        if (genome || retryVersionId || source.learningReviewId !== authoringRecovery.sourceReviewId || source.baselineHash !== baselineRecord.hash || source.evidenceHash !== evidenceHash || source.learningContextHash !== sources?.contextHash) throw fail('恢复作者实验的冻结输入不匹配。', 'author_retry_input_changed');
      }
      const existing = retryVersionId === undefined && findMatchingEvolutionAttempt(project, identity, { retryFailed });
      if (existing) return { status: existing.state, version: copy(existing), usage, replayed: true, summary: existing.state === 'ready' ? '同一证据已有通过评测的项目候选，可继续试用。' : existing.state === 'no_change' ? '相同证据已完成作者复核，尚不支持新的能力变更；已复用判断，等待新的工作证据。' : '相同基线与证据已有未通过或中断的进化记录；本次复用证据，没有重复付费。需要新的外部证据或显式的新评估请求。' };
      if (evaluationPartitions.confirmation.status === 'available') {
        try {
          // Pure admission check, not a durable claim: do not pay for authoring
          // or selection when these hidden tasks were already consumed. The
          // real claim remains after selection passes and rechecks current
          // durable history before any confirmation request. For an as-yet
          // unauthored candidate the baseline hash is only a valid placeholder;
          // no returned claim is persisted or reused.
          createProjectEvaluationConfirmationClaim({ plan: evaluationPartitions, candidateHash: inputGenomeHash ?? baselineRecord.hash, existingClaims: this.project(projectId).evolution.confirmationClaims ?? [] });
        } catch (error) {
          if (error.code === 'evaluation_confirmation_consumed') throw fail('这组独立确认任务已用于先前评估，不能再次使用。请提供经过独立审阅、尚未使用的确认数据后重评；本次没有启动新的模型请求。', 'evaluation_confirmation_consumed');
          throw error;
        }
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      savedVersion = { id: versionId, version: `candidate-${project.versions.length}`, title: summary || '项目能力进化候选', state: genome ? 'evaluating' : 'proposing', parentVersionId: baselineVersion.id, baselineHash: baselineRecord.hash, evidenceHash, inputGenomeHash, modelHash, evidenceIds: evidence.map(item => item.id), createdAt: now(), simulated: false, artifactDir: dir, evaluation: null, assignments: copy(project.assignments), source: genome ? 'edited-project-genome' : 'autonomous-project-evolution' };
      Object.assign(savedVersion, { ...(evaluationPartitionIdentity ? { evaluationPartitionIdentity } : {}), evaluationPartitions, evaluationExecution, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, evaluationRuntime: PROJECT_EVALUATION_RUNTIME });
      Object.assign(savedVersion, { evidenceIdentityVersion, evidenceFingerprints, inputFingerprint, evidenceSnapshotHash: evolutionHash(evidence) });
      Object.assign(savedVersion, { searchContext, searchSummary: { ...search.summary, authorPolicyApplied: !genome }, searchSourceVersionIds: genome ? [] : search.sourceVersionIds });
      if (sources) Object.assign(savedVersion, { learningContextHash: sources.contextHash, learningContextSources: sources.inventory });
      if (learningReviewId !== undefined) savedVersion.learningReviewId = learningReviewId;
      if (intent) savedVersion.learningIntent = copy(intent);
      if (retrySource) Object.assign(savedVersion, { retryOfVersionId: retrySource.id, priorEvaluationRuntimeHash: retrySource.evaluationRuntimeHash ?? null, priorEvaluationExecution: copy(retrySource.evaluationExecution ?? null), source: 'retry-project-genome', ...(retrySource.referenceDiscovery ? { referenceDiscovery: { ...copy(retrySource.referenceDiscovery), inheritedFromVersionId: retrySource.id } } : {}) });
      if (standardRebase) Object.assign(savedVersion, { standardRebase: copy(standardRebase) });
      if (evaluationRevision) Object.assign(savedVersion, { evaluationRevision: copy(evaluationRevision), source: 'reviewed-evaluation-revision' });
      if (authoringRecovery) Object.assign(savedVersion, { retryOfVersionId: authoringRecovery.sourceVersionId, retryOfLearningReviewId: authoringRecovery.sourceReviewId, source: 'explicit-authoring-retry', authoringRecovery: copy(authoringRecovery) });
      this.store.mutate(state => { const current = state.projects.find(item => item.id === projectId); if (!valid()) throw fail('项目状态已变化，进化已取消。', 'stale'); current.versions.push(savedVersion); current.evolution.candidateCount = (current.evolution.candidateCount || 0) + 1; });
      await artifact('evidence.json', { schemaVersion: 1, evidenceIdentityVersion, evidenceHash, evidenceFingerprints, snapshotHash: evolutionHash(evidence), evidence });
      await artifact('baseline.json', { versionId: baselineVersion.id, hash: baselineRecord.hash, genome: baseline });
      await artifact('frozen-evaluation.json', { evaluationPartitions, ...(evaluationRevision ? { evaluationRevision: copy(evaluationRevision) } : {}), evaluationExecution, suite: evaluationRevision?.suite ?? baseline.evaluationSuite, hash: evolutionHash(evaluationRevision?.suite ?? baseline.evaluationSuite), evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, evaluationRuntime: PROJECT_EVALUATION_RUNTIME });
      await artifact('search-policy.json', { schemaVersion: 1, context: searchContext, summary: savedVersion.searchSummary, ...(genome ? { policy: null, sourceVersionIds: [] } : { policy: search.policy, sourceVersionIds: search.sourceVersionIds }), scope: 'authoring_selection_feedback_only' });
      if (sources) await artifact('learning-context.json', { ...sources.snapshot, contextHash: sources.contextHash, scope: 'frozen_authoring_sources_only' });
      if (intent) await artifact('learning-intent.json', { schemaVersion: 1, status: 'unverified_hypothesis', learningIntent: intent, externalEvidence: false, affectsEvidenceIdentity: false });
      let proposal;
      if (genome) proposal = { summary: summary || retrySource?.title || '手工编辑的项目能力候选', hypothesis: evaluationRevision ? '在显式审阅的修订标准下配对评估原基线和原候选；标准采用与候选激活均是独立操作' : retrySource ? '在当前执行契约下重新配对评估相同候选能力与冻结基线；原评估记录保持' : '由用户编辑后在冻结标准下验证', changes: evaluationRevision ? ['只变更本次评估契约，原候选及基线能力包未改动；修订哈希与差异已记录'] : standardRebase ? ['候选系统提示、技能、工具不变；仅同步已采用标准后重新配对评估'] : retrySource ? ['原候选重评，能力包与冻结用例内容未变；本次执行配置单独记录'] : ['项目能力包编辑'], genome: validateProjectGenome(genome), ...(retrySource?.proposal?.assetChanges ? { assetChanges: copy(retrySource.proposal.assetChanges) } : {}) };
      else {
        const references = this.marketplaces.authoring(projectId, { baseline });
        let generated, generationFailure;
        const authorControl = { onUsage: requestControl?.onUsage, beforeRequest: async input => {
          input.signal?.throwIfAborted();
          // Preserve the existing source/credential/authority controller's
          // precise rejection and accounting contract. This callback is only
          // admission, never provider dispatch. If its reservation succeeds,
          // our additional guard must release it before rejecting below.
          await requestControl?.beforeRequest?.(input);
          try {
            input.signal?.throwIfAborted();
            if (!searchSourcesValid()) throw fail('搜索历史来源已撤销，未发送后续候选请求。', 'search_source_revoked');
            if (!valid()) throw fail('项目来源在准入期间变化，未发送后续候选请求。', 'stale');
          }
          catch (error) { await requestControl?.onUsage?.({ id: input.id, phase: input.phase, usage: zeroUsage(), usageReported: false, estimatedWhenUnknown: false, completed: false, requestStarted: false, cancelledBeforeSend: true }); throw error; }
        } };
        try { generated = await proposeProjectGenome({ project: { id: project.id, title: project.name, description: project.description, overview: project.overview, focus: project.focus, constraints: project.commitments, evaluationAudit: projectLearningEvaluationAudit(project), ...(rrsiDirectives && rrsiRecords ? { evolutionDirectives: { round: rrsiDirectives.round, editBudget: rrsiDirectives.budget, guidance: rrsiDirectives.text, untriedComponents: rrsiDirectives.untried, falsifiedHypotheses: rrsiDirectives.falsified.slice(-12).map(row => ({ component: row.component, key: row.key, hypothesis: row.hypothesis })), pruneCandidates: rrsiDirectives.pruneSet.slice(0, 8).map(row => row.key) } } : {}) }, baseline, evidence, learningIntent: intent, learningContext: sources?.snapshot, searchPolicy: search.policy, ...(this.rrsi ? { critic: async ({ proposal: draft, baseline: frozen }) => { rrsiReview = this.rrsi.critic({ baseline: frozen, candidate: draft.genome, project, proposal: draft, directives: retryFailed && rrsiDirectives ? { ...rrsiDirectives, falsified: [] } : rrsiDirectives, context: rrsiContext }); if (rrsiReview.verdict === 'reject') rrsiReview.reasons = rrsiReview.reasons.filter(row => row.code !== 'no_edit'); return rrsiReview.reasons.length ? rrsiReview : { verdict: 'accept', reasons: [] }; } } : {}), allowAbstention: true, model, apiKey, provider: purposeProvider(this.store, this.provider, 'learning', { projectId: project.id }), signal: merged, tokenBudget, requestControl: authorControl, onProgress: report, referenceTools: references.tools, referenceContext: references.context, referencePolicy: references.policy }); }
        catch (error) { generationFailure = error; throw error; }
        finally {
          try { const snapshot = references.snapshot(); await artifact('reference-sources.json', snapshot); update({ referenceDiscovery: referenceDiscoverySummary(snapshot) }); }
          catch { const measured = generated ?? generationFailure; throw Object.assign(fail('参考来源审计未能持久保存，候选未发布。', 'reference_audit_failed'), { usage: measured?.usage, requests: measured?.requests, learningContextReads: measured?.learningContextReads, evolutionDiagnostic: { phase: 'proposal', kind: 'reference_audit_failed', ...(generationFailure?.code ? { priorCode: generationFailure.code } : {}) } }); }
        }
        addUsage(generated.usage); requests.push(...generated.requests); proposal = generated.proposal;
        await artifact('proposal-validation.json', { attempts: generated.attempts, earlyStopReason: generated.earlyStopReason ?? null, validation: generated.validation, repairEvidence: generated.repairEvidence, ...(sources ? { learningContextHash: sources.contextHash, learningContextReads: generated.learningContextReads ?? [] } : {}) });
        if (sources) update({ learningContextReads: generated.learningContextReads ?? [] });
        update({ proposalAttempts: generated.attempts, proposalEarlyStopReason: generated.earlyStopReason ?? null, repairEvidence: generated.repairEvidence.map(row => ({ attempt: row.attempt, beforeHash: row.before ? projectGenomeHash(row.before) : null, afterHash: row.after ? projectGenomeHash(row.after) : null, expectationChanges: row.expectationChanges, fixtureChanges: row.fixtureChanges, withdrawals: row.withdrawals, ...(row.toolInheritance ? { toolInheritance: copy(row.toolInheritance) } : {}), ...(row.assetChanges ? { assetChanges: copy(row.assetChanges) } : {}), passed: row.validation?.passed ?? false, error: row.error })) });
        if (generated.status === 'no_change') {
          merged.throwIfAborted(); if (!valid()) throw fail('项目来源已变化，本轮复核仅保留执行记录。', 'stale');
          const authorAbstention = copy(generated.abstention);
          const operationPhaseLedger = createProjectEvaluationPhaseLedger({ requests, plan: evaluationPartitions, stages: [{ phase: 'author', status: 'passed', reason: 'author_no_change' }, { phase: 'paired', status: 'skipped', reason: 'author_no_change' }] });
          await artifact('author-review.json', { schemaVersion: 1, status: 'no_change', abstention: authorAbstention, sourceEvidenceIds: [...new Set(evidence.map(item => item.id).filter(id => typeof id === 'string'))], baselineHash: baselineRecord.hash, evidenceHash, ...(sources ? { learningContextHash: sources.contextHash } : {}), usage, requests });
          await trace;
          merged.throwIfAborted(); if (!valid()) throw fail('项目来源在保存复核期间变化，未发布判断。', 'stale');
          update({ state: 'no_change', title: authorAbstention.summary, authorAbstention, candidateGenerated: false, operationPhaseLedger, usage: copy(usage), completedAt: now(), notice: '作者复核后未生成能力候选，未运行配对评估或消费独立确认。当前能力保持；新的工作证据仍可触发后续学习。' });
          await artifact('result.json', { status: 'no_change', versionId, candidateGenerated: false, usage, requests });
          return { status: 'no_change', version: copy(this.project(projectId).versions.find(item => item.id === versionId)), usage, summary: `本轮进化复核：${authorAbstention.summary}。${authorAbstention.explanation} 当前项目能力保持，未启动候选评测。` };
        }
      }
      merged.throwIfAborted(); if (!valid()) throw fail('项目上下文已变化，候选没有应用。', 'stale');
      if (projectGenomeHash(proposal.genome) === baselineRecord.hash) throw fail('候选能力包没有实际变化。', 'no_change', 400);
      await artifact('proposal.json', proposal); update({ title: proposal.summary, state: 'evaluating', candidateHash: projectGenomeHash(proposal.genome), ...(proposal.searchReview ? { searchReview: copy(proposal.searchReview) } : {}), proposal: { summary: proposal.summary, hypothesis: proposal.hypothesis, changes: proposal.changes, ...(proposal.diagnosis ? { diagnosis: proposal.diagnosis } : {}), ...(proposal.evaluationSuiteSource ? { evaluationSuiteSource: proposal.evaluationSuiteSource } : {}), ...(proposal.toolInheritance ? { toolInheritance: copy(proposal.toolInheritance) } : {}), ...(proposal.assetChanges ? { assetChanges: copy(proposal.assetChanges) } : {}) } });
      const assetChanges = proposal.assetChanges ?? retrySource?.proposal?.assetChanges;
      const assetDeclarations = assetChanges ? { withdrawSkills: assetChanges.withdrawnSkills ?? [], withdrawSkillResources: assetChanges.withdrawnSkillResources ?? [] } : undefined;
      prepared = await this.genomes.prepare(project, { genome: proposal.genome, versionId, parentVersionId: baselineVersion.id, signal: merged });
      const evaluationControl = retrySource ? { onUsage: requestControl?.onUsage, beforeRequest: async input => {
        input.signal?.throwIfAborted(); if (!valid()) throw fail('修订评估来源已变化。', 'stale');
        await requestControl?.beforeRequest?.(input);
        try { input.signal?.throwIfAborted(); if (!valid()) throw fail('准入期间修订评估来源已变化。', 'stale'); }
        catch (error) { await requestControl?.onUsage?.({ id: input.id, phase: input.phase, usage: zeroUsage(), usageReported: false, estimatedWhenUnknown: false, completed: false, requestStarted: false, cancelledBeforeSend: true }); throw error; }
      } } : requestControl;
      const claimConfirmation = async ({ plan, candidateHash }) => {
        if (!valid()) throw fail('确认评估来源已变化。', 'stale');
        let claim;
        // Store.mutate synchronously fsyncs before returning. A crash after this
        // point consumes the confirmation set; it cannot become a free retry.
        this.store.mutate(state => {
          const current = state.projects.find(item => item.id === projectId);
          const claims = current.evolution.confirmationClaims ??= [];
          claim = createProjectEvaluationConfirmationClaim({ plan, candidateHash, existingClaims: claims });
          claims.push(claim);
        });
        await artifact('confirmation-claim.json', claim); return claim;
      };
      const settleConfirmation = async (claim, outcome) => {
        const settled = settleProjectEvaluationConfirmationClaim(claim, outcome);
        this.store.mutate(state => {
          const claims = state.projects.find(item => item.id === projectId)?.evolution.confirmationClaims;
          const index = claims?.findIndex(item => item.claimHash === claim.claimHash);
          if (index === undefined || index < 0) throw fail('确认评估登记缺失。', 'evaluation_confirmation_claim_missing');
          // Terminal evidence may not be overwritten by a later failure path.
          claims[index] = settleProjectEvaluationConfirmationClaim(claims[index], outcome);
        });
        await artifact('confirmation-claim.json', settled);
      };
      // RRSI tiers for authored candidates: critic (ran in the author loop) -> JEV
      // prior (may only skip evaluation) -> <=3-case smoke of selection cases -> full.
      if (!genome && this.rrsi) {
        rrsiBaseline = baseline; rrsiProposal = proposal; rrsiTiers = [{ tier: 'critic', status: rrsiReview ? 'passed' : 'skipped' }];
        try { rrsiEdits = this.rrsi.edits({ baseline, candidate: proposal.genome, project, proposal }); } catch { rrsiEdits = []; }
        // The git mirror is audit-only: it runs alongside the paid evaluation and is awaited before completion.
        rrsiGit = Promise.resolve(this.rrsi.git?.candidate(projectId, { baseline, genome: proposal.genome, project: this.project(projectId) ?? project, versionId, parentVersionId: baselineVersion.id, message: `candidate ${versionId}: ${String(proposal.summary ?? '').slice(0, 120)}`, edits: rrsiEdits })).then(git => git ? { branch: git.branch, base: git.base, commit: git.commit, diffStat: git.diffStat } : null, () => null);
        rrsiSignals = await this.rrsi.realSignals(projectId);
        try { rrsiPrescore = await this.decisions?.prescoreCandidate?.({ projectId, summary: proposal.summary, hypothesis: proposal.hypothesis, changedAreas: this.rrsi.changedAreas(rrsiEdits), evidence: [...evidence.slice(-3).map(row => ({ id: row.id, type: 'evidence', summary: String(row.summary ?? row.text ?? '').slice(0, 400) })), ...rrsiSignals.signals.slice(-3).map(row => ({ id: row.id, type: row.kind, summary: `${row.kind} ${row.detail?.tool ?? row.detail?.label ?? row.detail?.status ?? ''}`.trim() }))], signal: merged }); } catch (error) { if (merged.aborted) throw error; rrsiPrescore = undefined; }
        const gate = rrsiPrescreen(rrsiPrescore ?? {});
        rrsiTiers.push({ tier: 'prescreen', status: rrsiPrescore ? gate.evaluate ? 'passed' : 'failed' : 'skipped', reason: gate.reason });
        if (!gate.evaluate) throw Object.assign(fail('JEV 先验判断此候选不值得评测，已跳过付费评测；JEV 不能单独采用候选。', 'prescreen_skipped'), { evolutionDiagnostic: { phase: 'rrsi', kind: 'prescreen_skipped' } });
        // Smoke tier = the first ≤3 selection cases of the full paired evaluation
        // (replay cases first); a regression there stops before the rest.
        const selectionIds = new Set(evaluationPartitions.assignments.filter(row => row.partition === 'selection').map(row => row.caseId)), selectionSuite = { ...baseline.evaluationSuite, cases: baseline.evaluationSuite.cases.filter(row => selectionIds.has(row.id)) };
        rrsiSmoke = !evaluationRevision && selectionSuite.cases.length > this.rrsi.config.smokeCases ? { caseIds: this.rrsi.smokeCaseIds(selectionSuite, (rrsiSignals.replay ?? []).map(row => row.id)), band: rrsiDirectives?.calibration?.delta ?? this.rrsi.config.minDelta } : null;
        if (!rrsiSmoke) rrsiTiers.push({ tier: 'smoke', status: 'skipped', reason: 'suite_not_larger_than_smoke' });
        rrsiTiers.push({ tier: 'full', status: 'running' });
      }
      const environmentAdapters = { browser: this.browserAdapterFactory({ artifactDirectory: join(dir, 'browser') }) };
      const evaluation = await evaluateProjectGenomes({ partitionPlan: evaluationPartitions, claimConfirmation, settleConfirmation, environmentAdapters, baseline, candidate: proposal.genome, assetDeclarations, evaluationRevision, ...(rrsiSmoke ? { smokeCaseIds: rrsiSmoke.caseIds, smokeBand: rrsiSmoke.band } : {}), model, apiKey, provider: purposeProvider(this.store, this.provider, 'evaluation', { projectId: project.id }), signal: merged, tokenBudget: tokenBudget == null ? null : Math.max(0, tokenBudget - usage.totalTokens), requestControl: evaluationControl, onProgress: report });
      addUsage(evaluation.usage); requests.push(...evaluation.requests);
      const operationPhaseLedger = createProjectEvaluationPhaseLedger({ requests, plan: evaluationPartitions, stages: [{ phase: 'author', status: genome ? 'not_applicable' : 'passed' }, ...evaluation.phaseLedger.phases.filter(row => row.phase !== 'author' && row.status !== 'observed_requests').map(({ phase, status, reasons }) => ({ phase, status, ...(reasons?.length ? { reason: reasons[0] } : {}) }))] });
      await artifact('evaluation.json', evaluation); await trace;
      merged.throwIfAborted(); if (!valid()) throw fail('项目已变化，评测结果仅保留为证据。', 'stale');
      // Rejected bundles are retained for inspection, never activated. Both pass
      // and failure evidence refer to the exact immutable generated files.
      await prepared.commit();
      if (!valid()) throw fail('项目在提交前发生变化，候选未发布。', 'stale');
      // RRSI selection (Algorithm 2) with the blended real/JEV score. Enforced
      // only once the noise band is measured; the frozen gates always apply first.
      let rrsiSelection;
      if (!genome && this.rrsi && evaluation.gatePassed && !evaluationRevision) try { rrsiSelection = await this.rrsi.select(projectId, { baselineHash: baselineRecord.hash, evaluation, edits: rrsiEdits, prescore: rrsiPrescore, replayCaseIds: (rrsiSignals?.replay ?? []).map(row => row.id) }); } catch { rrsiSelection = undefined; }
      const rrsiBlocked = Boolean(rrsiSelection?.enforced && !rrsiSelection.admissible);
      const smokeStopped = evaluation.earlyStopReason === 'smoke_regressed' || Boolean(rrsiSmoke && evaluation.stage === 'deterministic_case' && (evaluation.details ?? []).some(row => row.judgmentSkipped && rrsiSmoke.caseIds.includes(row.id)));
      if (rrsiTiers.length) {
        rrsiTiers.pop();
        if (rrsiSmoke) rrsiTiers.push({ tier: 'smoke', status: smokeStopped || evaluation.rrsiSmoke?.passed === false ? 'failed' : evaluation.rrsiSmoke ? 'passed' : 'failed', cases: rrsiSmoke.caseIds, ...(evaluation.rrsiSmoke ? { baselineScore: evaluation.rrsiSmoke.baselineScore, candidateScore: evaluation.rrsiSmoke.candidateScore } : {}) });
        if (!smokeStopped) rrsiTiers.push({ tier: 'full', status: evaluation.gatePassed && !rrsiBlocked ? 'passed' : 'failed', ...(rrsiBlocked ? { reason: rrsiSelection.reason } : {}) });
      }
      const state = evaluation.gatePassed && !rrsiBlocked ? evaluationRevision ? 'reviewed' : 'ready' : 'rejected';
      update({ state, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, skillManifests: prepared.skillManifests, toolDescriptors: prepared.toolDescriptors, evaluation, operationPhaseLedger, usage: copy(usage), completedAt: now(), ...(rrsiTiers.length ? { rrsi: { round: rrsiDirectives?.round ?? null, editBudget: rrsiDirectives?.budget ?? null, edits: rrsiEdits.map(({ editId, key, component, change, hypothesis }) => ({ editId, key, component, change, hypothesis: String(hypothesis ?? '').slice(0, 400) })), tiers: rrsiTiers, prescore: rrsiPrescore ?? null, selection: rrsiSelection ? { admissible: rrsiSelection.admissible, enforced: rrsiSelection.enforced, reason: rrsiSelection.reason, deltaS: rrsiSelection.deltaS, deltaC: rrsiSelection.deltaC, delta: rrsiSelection.calibration?.delta ?? null, blended: rrsiSelection.blended } : null } } : {}), notice: rrsiBlocked ? `通过冻结门槛，但未通过 RRSI 选择（噪声带/成本规则）：${rrsiSelection.reason}。保留证据且不可试用。` : evaluationRevision ? '已保存修订标准下的新配对评估；旧标准、候选与历史结果保留，标准未采用且不可据此试用候选。' : evaluation.gatePassed ? '在当前冻结用例中的对照评测及生成脚本检查通过，可试用；这不代表通用能力提升，当前版本未替换。' : evaluation.evaluationComplete === false ? '本地脚本或确定性检查未通过，后续模型评测已早停；未生成能力分数，保留证据且不可试用。' : '已执行真实评测，未满足全部冻结门槛，保留证据且不可试用。' }, { evaluatedAt: evaluation.completedAt }); published = true;
      const genomeGit = await rrsiGit; if (genomeGit) update({ genomeGit });
      if (rrsiTiers.length) await this.rrsi.recordOutcome(projectId, { version: { id: versionId }, baseline, candidate: proposal.genome, project, proposal, evaluation, verdict: state === 'ready' ? 'accepted' : smokeStopped ? 'smoke_failed' : 'rejected', selection: rrsiSelection, tiers: rrsiTiers, prescore: rrsiPrescore, context: rrsiContext }).catch(() => {});
      const version = copy(this.project(projectId).versions.find(item => item.id === versionId));
      await artifact('result.json', { status: state, versionId, usage, requests });
      return { status: state, version, usage, summary: rrsiBlocked ? `项目能力候选「${proposal.summary}」通过了冻结门槛（${evaluation.baselineScore.toFixed(3)} → ${evaluation.candidateScore.toFixed(3)}），但未通过 RRSI 选择：${rrsiSelection.reason}。已保留证据，当前版本保持有效。` : evaluationRevision ? `修订基准的配对重评${evaluation.gatePassed ? '通过' : '未通过'}；评分 ${evaluation.baselineScore ?? '未产生'} → ${evaluation.candidateScore ?? '未产生'}，旧记录与能力包未改动，标准与候选均未激活。` : evaluation.gatePassed ? `项目能力候选「${proposal.summary}」在当前冻结用例中的对照评测为 ${evaluation.baselineScore.toFixed(3)} → ${evaluation.candidateScore.toFixed(3)}，${evaluation.cases} 个用例及生成脚本检查通过。这是有限用例的验证，可以试用；尚未替换当前版本。` : evaluation.evaluationComplete === false ? `项目能力候选「${proposal.summary}」在 ${evaluation.stage === 'script_preflight' ? '本地脚本检查' : '确定性用例检查'} 中未通过（${evaluation.earlyStopReason}），已停止后续付费评测，${evaluation.skippedCases} 个用例未执行；没有生成能力提升分数。已保留诊断，当前版本保持有效。` : `项目能力候选「${proposal.summary}」已完成真实评测，但未通过 ${Object.entries(evaluation.gates).filter(([, passed]) => passed === false).map(([name]) => name).join('、')} 门槛。已保留执行证据，当前版本保持有效。` };
    } catch (failure) {
      if (failure.usage) addUsage(failure.usage); if (failure.requests) requests.push(...failure.requests);
      await trace.catch(() => {}); if (prepared && !published) await prepared.rollback().catch(() => {});
      const rrsiGate = ['critic_rejected', 'prescreen_skipped'].includes(failure.code);
      const state = merged.aborted ? 'interrupted' : failure.code === 'stale' ? 'stale' : rrsiGate ? 'rejected' : 'failed';
      const message = String(failure.message || '项目能力进化失败').replaceAll(apiKey || '\0', '[REDACTED]').slice(0, 2000);
      const diagnostic = failure.evolutionDiagnostic ?? { phase: savedVersion?.proposal || this.project(projectId)?.versions.find(version => version.id === versionId)?.proposal ? 'evaluation' : 'proposal', kind: failure.code || 'evolution_failed' };
      const searchReview = failure.searchReview ?? failure.repairEvidence?.findLast(row => row.searchReview)?.searchReview;
      const learningContextReads = sources ? failure.learningContextReads ?? this.project(projectId)?.versions.find(version => version.id === versionId)?.learningContextReads ?? [] : undefined;
      if (savedVersion) {
        const currentPhase = diagnostic.phase === 'proposal' || diagnostic.phase === 'script-repair' ? 'author' : 'paired';
        const retainedStages = (failure.evaluationEvidence?.phaseLedger?.phases ?? []).filter(row => row.status !== 'observed_requests' && row.phase !== 'author').map(({ phase, status, reasons }) => ({ phase, status, ...(reasons?.length ? { reason: reasons[0] } : {}) }));
        retainedStages.push({ phase: 'author', status: genome ? 'not_applicable' : currentPhase === 'author' ? (merged.aborted ? 'interrupted' : 'failed') : 'passed', ...(currentPhase === 'author' ? { reason: String(failure.code || 'author_failed').slice(0, 160) } : {}) });
        failure.evaluationEvidence ??= {}; failure.evaluationEvidence.phaseLedger = createProjectEvaluationPhaseLedger({ requests, plan: evaluationPartitions, stages: retainedStages });
      }
      // Rollback removes the unpublished files, not the in-memory immutable
      // candidate identity. Keep only bound delivery facts for future author
      // diagnosis; this is neither a committed bundle nor a quality verdict.
      const failedVersion = savedVersion && this.project(projectId)?.versions.find(version => version.id === versionId);
      const skillDeliveryDiagnostic = failedVersion && prepared?.record?.genome
        ? createEvolutionSkillDeliveryDiagnostic({ ...failedVersion, state, evaluationEvidence: failure.evaluationEvidence }, baselineVersion.bundle.genome, prepared.record.genome) : undefined;
      if (skillDeliveryDiagnostic) await artifact('skill-delivery-diagnostic.json', skillDeliveryDiagnostic).catch(() => {});
      if (savedVersion) update({ state, error: { code: failure.code || 'evolution_failed', message, diagnostic }, usage: copy(usage), evaluationEvidence: failure.evaluationEvidence, ...(skillDeliveryDiagnostic ? { skillDeliveryDiagnostic } : {}), ...(searchReview ? { searchReview: copy(searchReview) } : {}), ...(sources ? { learningContextReads } : {}), completedAt: now(), notice: '进化未完成，执行诊断已保留；这不是候选效果评分，当前项目版本没有改变。' });
      await artifact('failure.json', { evaluationExecution, state, code: failure.code, message, diagnostic, usage, requests, evaluationRuntimeHash: PROJECT_EVALUATION_RUNTIME_HASH, evaluationRuntime: PROJECT_EVALUATION_RUNTIME, evidence: failure.evaluationEvidence, repairEvidence: failure.repairEvidence, ...(sources ? { learningContextHash: sources.contextHash, learningContextReads } : {}) }).catch(() => {});
      if (rrsiGit) { const genomeGit = await rrsiGit; if (genomeGit && savedVersion) try { update({ genomeGit }); } catch { /* audit only */ } }
      if (savedVersion && !genome && this.rrsi) {
        const failedRecord = this.project(projectId)?.versions.find(version => version.id === versionId);
        if (rrsiGate) { const tier = failure.code === 'critic_rejected' ? 'critic' : 'prescreen'; if (!rrsiTiers.some(row => row.tier === tier && row.status === 'failed')) rrsiTiers.push({ tier, status: 'failed', reason: failure.code }); if (failedRecord) update({ rrsi: { round: rrsiDirectives?.round ?? null, editBudget: rrsiDirectives?.budget ?? null, tiers: rrsiTiers, prescore: rrsiPrescore ?? null, ...(failure.criticReview ? { critic: failure.criticReview } : {}) } }); }
        await (rrsiGate ? this.rrsi.recordOutcome(projectId, { version: failedRecord ?? { id: versionId }, baseline: rrsiBaseline, candidate: rrsiProposal?.genome, project, proposal: rrsiProposal, edits: failure.code === 'critic_rejected' ? rrsiReview?.edits : undefined, verdict: failure.code, tiers: rrsiTiers, prescore: rrsiPrescore, context: rrsiContext })
          : this.rrsi.recordFailure(projectId, { version: failedRecord, baseline: rrsiBaseline, candidate: rrsiProposal?.genome, project, proposal: rrsiProposal, context: rrsiContext })).catch(() => {});
      }
      if (!savedVersion) throw Object.assign(failure, { usage });
      return { status: state, version: copy(this.project(projectId)?.versions.find(item => item.id === versionId)), usage, summary: `项目进化未完成：${message}。已保留证据，没有更改当前版本。` };
    } finally { await trace.catch(() => {}); this.running.delete(projectId); }
  }
  close() { for (const operation of this.running.values()) operation.controller.abort(); }
}
