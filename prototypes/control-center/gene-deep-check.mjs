import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCompletion } from '../../packages/sdk/src/providers.mjs';
import { evaluateProjectGenomes, estimateProjectEvolutionBudget } from '../../packages/sdk/src/project-evolution.mjs';
import { createBrowserEvaluationAdapter } from '../../packages/sdk/src/project-evaluation-browser-adapter.mjs';
import { resolveModel } from './configuration.mjs';
import { purposeProvider } from './usage-cache-service.mjs';
import { DEEP_CHECK_LAYERS, generationVersions } from './project-genes.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';

// Evolution v3 §3, optional deep check (plan §9 D5): the old paired evaluation,
// kept for large changes and never run by default. The user starts it on a gene
// that formed a generation; the generation's bundle is compared with its parent
// on the project's evaluation cases. The result is shown on the gene; nothing is
// adopted or retired by it.
const fail = (message, code, status = 409) => Object.assign(new Error(message), { code, status });
const iso = value => new Date(value).toISOString();

export class GeneDeepCheck {
  constructor(store, { genes, provider = streamCompletion, evaluate = evaluateProjectGenomes, browserAdapterFactory = createBrowserEvaluationAdapter, now = Date.now } = {}) {
    Object.assign(this, { store, genes, provider, evaluate, browserAdapterFactory, now });
    this.running = new Map(); this.closed = false;
  }
  project(id) { return this.store.state.projects.find(row => row.id === id && !row.archivedAt) ?? null; }
  /** The version a gene's generation created and its parent, when both still carry a bundle. */
  versions(project, gene) { return generationVersions(project, gene); }
  eligible(project, gene) { return Boolean(gene && DEEP_CHECK_LAYERS.includes(gene.layer) && ['trial', 'active'].includes(gene.status) && this.versions(project, gene)); }
  record(projectId, geneId, deepCheck) { this.genes.record(projectId, geneId, row => { row.deepCheck = deepCheck; }); }
  /** Start a deep check (it runs in the background); refuses when one is running, without a real model or budget. */
  start(projectId, geneId) {
    const project = this.project(projectId); if (!project) throw fail('项目不存在', 'project_unavailable', 404);
    const gene = (project.genes?.genes ?? []).find(row => row.id === geneId);
    if (!this.eligible(project, gene)) throw fail('这个基因没有可以对比的上一代', 'deep_check_unavailable');
    if (this.running.has(projectId)) throw fail('这个项目正在做一次深入检查', 'deep_check_busy');
    const model = resolveModel(this.store.state.configuration, project.initiative?.modelSelection ?? null);
    if (model.execution !== 'rna' || model.usagePolicy === 'interactive_only') throw fail('深入检查需要已配置的开放平台 API 模型', 'configured_model_required');
    const providerRow = this.store.state.configuration.providers.find(row => row.id === model.providerId);
    if (!providerRow) throw fail('深入检查需要已配置的模型', 'configured_model_required');
    const { version, parent } = this.versions(project, gene), key = `deep-check:${projectId}:${geneId}`;
    const remaining = realBudgetRemaining(this.store.state); if (remaining === 0) throw fail('已达到真实调用每日额度', 'budget');
    const estimate = estimateProjectEvolutionBudget(version.bundle.genome, model);
    this.store.mutate(state => reserveRealTokens(state, key, Number.isFinite(remaining) ? Math.min(remaining, estimate) : estimate));
    const controller = new AbortController(), startedAt = iso(this.now());
    this.record(projectId, geneId, { status: 'running', startedAt });
    const promise = this.run(project, gene, { version, parent, model, providerRow, signal: controller.signal })
      .then(result => ({ status: 'done', startedAt, at: iso(this.now()), ...result }), error => ({ status: 'failed', startedAt, at: iso(this.now()), code: /^[a-z_]{1,60}$/.test(error?.code ?? '') ? error.code : 'deep_check_failed' }))
      .then(outcome => {
        const { usage, ...shown } = outcome;
        this.store.mutate(state => { releaseRealTokens(state, key); if (Number.isFinite(usage?.totalTokens)) chargeRealTokens(state, usage.totalTokens); });
        if (!this.closed) this.record(projectId, geneId, shown);
        return shown;
      }).finally(() => this.running.delete(projectId));
    this.running.set(projectId, { controller, promise });
    return { status: 'running', startedAt };
  }
  async run(project, gene, { version, parent, model, providerRow, signal }) {
    const [baseline, candidate] = await Promise.all([parent, version].map(async row => { try { return (await this.genes.genomes.read(project.id, row.id)).genome; } catch { return row.bundle.genome; } }));
    if (!baseline?.evaluationSuite?.cases?.length) return { verdict: 'unavailable', reason: 'no_cases' };
    const dir = await mkdtemp(join(tmpdir(), 'rna-deep-check-'));
    try {
      const apiKey = this.store.configurationService.secret(providerRow.id, providerRow);
      const evaluation = await this.evaluate({ baseline, candidate, model, apiKey, provider: purposeProvider(this.store, this.provider, 'evaluation', { projectId: project.id }), signal, environmentAdapters: { browser: this.browserAdapterFactory({ artifactDirectory: join(dir, 'browser') }) } });
      const before = evaluation.baselineScore, after = evaluation.candidateScore;
      const verdict = !Number.isFinite(before) || !Number.isFinite(after) ? 'unclear' : after > before && evaluation.gatePassed ? 'better' : after < before ? 'worse' : 'same';
      return { verdict, baselineScore: Number.isFinite(before) ? before : null, candidateScore: Number.isFinite(after) ? after : null, cases: Array.isArray(evaluation.details) ? evaluation.details.length : evaluation.cases ?? null, usage: evaluation.usage ?? null };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async close() { this.closed = true; for (const row of this.running.values()) row.controller.abort(); await Promise.allSettled([...this.running.values()].map(row => row.promise)); }
}
