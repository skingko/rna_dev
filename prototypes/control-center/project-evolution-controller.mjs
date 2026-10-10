import { randomUUID } from 'node:crypto';
import { resolveModel } from './configuration.mjs';
import { ProjectEvolutionService } from './project-evolution-service.mjs';
import { estimateProjectEvolutionBudget } from '../../packages/sdk/src/project-evolution.mjs';
import { validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
/** User-edited and autonomous candidates share the same evaluator and lock. */
export class ProjectEvolutionController {
  constructor(store, { service = new ProjectEvolutionService(store) } = {}) {
    this.store = store; this.service = service; this.operations = new Map(); this.closed = false;
    this.unsubscribe = store.subscribe(() => { for (const [id, operation] of this.operations) { const project = store.state.projects.find(p => p.id === id); if (store.state.emergency || !project || project.archivedAt || project.initialization?.status !== 'ready') operation.controller.abort(); } });
  }
  adoptEvaluationStandard(projectId, input = {}) {
    if (this.closed || this.store.state.emergency || this.operations.has(projectId)) throw fail('当前不能采用评估标准。');
    if (Object.keys(input).some(key => !['action', 'reviewVersionId', 'revisionHash'].includes(key))) throw fail('标准采用不能混合候选编辑或执行请求。', 400);
    return this.service.adoptEvaluationStandard(projectId, input);
  }
  preview(projectId, input = {}) {
    if (input.genome !== undefined || input.retryAuthorVersionId !== undefined || input.summary !== undefined || input.evaluationRevision === undefined) throw fail('预览须提供原候选和完整标准修订，不能混合候选编辑。', 400);
    return this.service.previewEvaluationRevision(projectId, input);
  }
  start(projectId, input = {}) {
    if (input.action !== undefined) throw fail('未知进化操作。', 400);
    if (this.closed || this.store.state.emergency) throw fail('执行已暂停。');
    if (this.operations.has(projectId) || this.service.running.has(projectId)) throw fail('当前项目已有进化评测在执行。');
    const project = this.store.state.projects.find(p => p.id === projectId);
    const baseline = project?.versions.find(v => v.id === project.activeVersionId);
    if (!project || project.archivedAt || project.initialization?.status !== 'ready' || !baseline?.bundle) throw fail('请先完成项目能力初始化。');
    if (project.trialVersionId) throw fail('请先结束当前试用，再评估下一版本。');
    if (input.baseVersionId !== undefined && input.baseVersionId !== baseline.id) throw fail('编辑期间项目基线已变化，请重新加载版本。');
    if (input.retryAuthorVersionId !== undefined) {
      if (input.genome !== undefined || input.retryVersionId !== undefined || input.summary !== undefined || input.evaluationRevision !== undefined) throw fail('重试候选生成须使用原冻结输入，不能同时提交修改后的能力包或说明。', 400);
      this.service.authoringRetrySource(project, input.retryAuthorVersionId);
    }
    if (input.retryVersionId !== undefined) {
      if (input.genome !== undefined) throw fail('重评原候选不能同时提交修改后的能力包。', 400);
      this.service.retrySource(project, input.retryVersionId, { revision: input.evaluationRevision !== undefined });
    }
    let revision;
    if (input.evaluationRevision !== undefined) {
      const preview = this.preview(projectId, input); revision = preview.revision;
      if (input.reviewedRevisionHash !== revision.revisionHash) throw fail('请先预览并确认完整标准差异，再提交对应修订哈希。', 400);
    } else if (input.reviewedRevisionHash !== undefined) throw fail('缺少标准修订正文。', 400);
    let genome;
    try { genome = input.genome === undefined ? undefined : validateProjectGenome(input.genome); } catch (error) { throw fail(error.message, 400); }
    if (input.summary !== undefined && (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 300)) throw fail('候选说明必须是 1–300 字符文本', 400);
    const summary = input.summary === undefined ? undefined : String(input.summary).trim().slice(0, 300);
    const model = resolveModel(this.store.state.configuration, project.initiative?.modelSelection ?? null);
    if (model.usagePolicy === 'interactive_only') throw fail('此订阅仅支持交互式使用；进化评估请配置开放平台 API 模型。');
    if (model.execution !== 'rna') throw fail('请配置真实模型后再评估。');
    const provider = this.store.state.configuration.providers.find(p => p.id === model.providerId);
    const apiKey = this.store.configurationService.secret(provider.id, provider);
    const id = randomUUID(), key = `evolution:${id}`, controller = new AbortController();
    const remaining = realBudgetRemaining(this.store.state);
    if (remaining === 0) throw fail('已达到真实调用每日额度。');
    const operation = { id, controller, promise: null }; this.operations.set(projectId, operation);
    try { this.store.mutate(state => { reserveRealTokens(state, key, Number.isFinite(remaining) ? remaining : estimateProjectEvolutionBudget(revision ? { ...baseline.bundle.genome, evaluationSuite: revision.suite } : genome ?? baseline.bundle.genome, model)); state.projects.find(p => p.id === projectId).evolution.request = { id, status: 'running', startedAt: new Date().toISOString() }; }); }
    catch (error) { this.operations.delete(projectId); throw error; }
    const evidence = [...project.observations.filter(o => o.simulated === false).slice(-12).map(o => ({ id: o.id, summary: o.text })), { id: `user-edit:${id}`, summary: summary || (revision ? '用户审阅明确的评估契约修订，要求原基线与原候选在同一修订标准下配对重评。' : genome ? '用户编辑项目能力与评估标准，要求按原基线标准评估。' : '用户请求根据当前项目已有证据生成并验证改进候选。') }];
    const execution = input.retryAuthorVersionId === undefined
      ? this.service.evolve(projectId, { evidence, model, apiKey, signal: controller.signal, tokenBudget: Number.isFinite(remaining) ? remaining : null, genome, summary, retryFailed: true, retryVersionId: input.retryVersionId, evaluationRevision: revision, reviewedRevisionHash: input.reviewedRevisionHash })
      : this.service.regenerateAuthor(projectId, { retryAuthorVersionId: input.retryAuthorVersionId, model, apiKey, signal: controller.signal, tokenBudget: Number.isFinite(remaining) ? remaining : null });
    operation.promise = execution.then(result => { this.finish(projectId, operation, key, result); return result; }, error => { this.finish(projectId, operation, key, { status: 'failed', code: error.code, usage: error.usage, summary: String(error.message).replaceAll(apiKey || '\0', '[REDACTED]') }); }).finally(() => this.operations.delete(projectId));
    return { operationId: id, status: 'running' };
  }
  finish(projectId, operation, key, result) {
    this.store.mutate(state => {
      const reserved = releaseRealTokens(state, key);
      const count = result.usage?.totalTokens;
      const estimated = Number.isFinite(count) ? Math.min(count, Math.max(0, result.usage?.estimatedTokens ?? 0)) : reserved;
      chargeRealTokens(state, Number.isFinite(count) ? count - estimated : 0);
      chargeRealTokens(state, estimated, { estimated: true });
      const project = state.projects.find(p => p.id === projectId); if (!project) return;
      project.evolution.request = { id: operation.id, status: result.status, versionId: result.version?.id, summary: result.summary, ...(result.code ? { code: result.code } : {}), completedAt: new Date().toISOString() };
    });
  }
  async close() { this.closed = true; this.unsubscribe(); for (const operation of this.operations.values()) operation.controller.abort(); await Promise.allSettled([...this.operations.values()].map(o => o.promise)); }
}
