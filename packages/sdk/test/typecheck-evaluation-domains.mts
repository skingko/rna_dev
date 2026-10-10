import {
  createEvaluationDomain, validateEvaluationDomain, evaluationDomainToolNames,
  createBrowserEvaluationAdapter, validateBrowserEvaluationEnvironment,
  createProjectEvaluationPartitionPlan, validateProjectEvaluationPartitionPlan, projectEvaluationPartitionCases,
  projectEvaluationPartitionSummary, createProjectEvaluationConfirmationClaim, settleProjectEvaluationConfirmationClaim,
  createProjectEvaluationPhaseLedger, executeProjectEvaluationCase, evaluateProjectGenomes,
  type ProjectGenome, type ModelConfig, type ProjectResearchEvaluationDomain, type ProjectAutomationEvaluationDomain,
  type BrowserEvaluationEnvironment, type ProjectEvaluationConfirmationClaim,
} from '@rna-agent/sdk';

declare const genome: ProjectGenome;
declare const model: ModelConfig;
const research: ProjectResearchEvaluationDomain = {
  kind: 'research', reportPath: 'report.json',
  sources: [{ id: 'source', title: 'Frozen source', url: 'https://example.test/source', publishedAt: '2026-09-27T01:00:00Z', body: 'Frozen text.' }],
  checks: { requiredSourceIds: ['source'], windowStart: '2026-09-27T00:00:00Z', windowEnd: '2026-09-27T23:59:59Z', minCitations: 1, maxCitations: 2 },
};
const normalized = validateEvaluationDomain(research);
if (normalized.kind === 'research') { const digest: string = normalized.sources[0].sha256; void digest; }
const runtime = createEvaluationDomain(research, { workspace: '/tmp/frozen-case' });
const checked = await runtime.verify(); const provenance: string = checked.executionClaim;
const automation: ProjectAutomationEvaluationDomain = {
  kind: 'automation', jobs: [{ id: 'daily', payload: { date: '2026-09-27' } }], faults: [{ jobId: 'daily', attempt: 1, boundary: 'after_commit' }],
  checks: { completedJobIds: ['daily'], maxAttemptsPerJob: 3, requireReconciliation: true },
};
const protocol = createEvaluationDomain(automation); protocol.snapshot(); evaluationDomainToolNames(automation);
// @ts-expect-error Research verification requires an isolated workspace.
createEvaluationDomain(research);
// @ts-expect-error Protocol fixtures do not accept arbitrary network addresses.
automation.faults.push({ jobId: 'daily', attempt: 1, boundary: 'external_fetch' });

const browser: BrowserEvaluationEnvironment = { kind: 'browser', entry: 'index.html', viewport: { width: 1000, height: 700 }, steps: [{ id: 'click', kind: 'click', selector: '#add' }, { id: 'count', kind: 'assert_text', selector: '#count', expected: '1' }] };
validateBrowserEvaluationEnvironment(browser);
const adapter = createBrowserEvaluationAdapter({ artifactDirectory: '/tmp/private-artifacts' });
const browserResult = await adapter.verify({ workspace: '/tmp/frozen-case', environment: browser, artifactKey: 'selection-case' });
const visualClaim: 'browser_entry_missing' | 'local_static_browser_interactions_only' = browserResult.executionClaim;
await executeProjectEvaluationCase({ genome, caseId: 'web', model, environmentAdapters: { browser: adapter } });

const plan = createProjectEvaluationPartitionPlan({ suite: genome.evaluationSuite });
validateProjectEvaluationPartitionPlan(plan, genome.evaluationSuite);
projectEvaluationPartitionCases(plan, genome.evaluationSuite, 'selection');
const summary = projectEvaluationPartitionSummary(plan); const cases: number = summary.counts.selection;
// @ts-expect-error Frozen partition assignments cannot be changed after planning.
plan.assignments[0].partition = 'confirmation';
const claims: ProjectEvaluationConfirmationClaim[] = [];
await evaluateProjectGenomes({ baseline: genome, candidate: genome, model, partitionPlan: plan, environmentAdapters: { browser: adapter },
  async claimConfirmation(input) { const claim = createProjectEvaluationConfirmationClaim({ ...input, existingClaims: claims }); claims.push(claim); return claim; },
  async settleConfirmation(claim, outcome) { const terminal = settleProjectEvaluationConfirmationClaim(claim, outcome); claims.push(terminal); },
});
const ledger = createProjectEvaluationPhaseLedger({ plan, requests: [{ id: 'request-1', phase: 'judge:web', usage: { input: 100, output: 20, totalTokens: 120 }, completed: true }], stages: [{ phase: 'paired', status: 'passed' }] });
const tokens: number = ledger.usage.totalTokens;
void provenance; void visualClaim; void cases; void tokens;
