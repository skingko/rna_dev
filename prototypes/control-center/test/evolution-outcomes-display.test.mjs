import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionFunnelDisplay, authorAbstentionDisplay, evaluationBenefitDisplay, evaluationMethodDisplay, versionChangeSummary } from '../presentation/evolution-evidence-display.mjs';
import { formatVersionList, formatVersionDetail } from '../cli-evaluation.mjs';
const stopped = { id: 'stop', state: 'no_change', simulated: false, parentVersionId: 'base', candidateGenerated: false, authorAbstention: { reason: 'insufficient_evidence', summary: '还需一次实际故障记录。', explanation: '现有描述未提供复现步骤，暂不能归因于项目能力。', revisitWhen: [{ condition: 'reproduced_failure', description: '新的实际执行回执可以复现故障时再次复核。' }] } };
const candidate = (id, overrides = {}) => ({ id, simulated: false, state: 'rejected', parentVersionId: 'base', bundle: { hash: id }, ...overrides });
test('retained funnel distinguishes attempts, author stops, measurements, gates and actual adoption without improving a synthetic rate', () => {
  const versions = [{ id: 'base', bundle: { hash: 'baseline' }, state: 'active' }, stopped,
    candidate('generated'), candidate('measured', { evaluation: { evaluationComplete: true, gatePassed: false } }),
    candidate('ready', { state: 'ready', evaluation: { evaluationComplete: true, gatePassed: true } }),
    candidate('adopted', { adoptedAt: '2026-01-01T00:00:00Z', evaluation: { evaluationComplete: true, gatePassed: true } }),
    candidate('revoked', { sourceDeleted: true }), candidate('standard', { source: 'adopted-evaluation-standard' }), candidate('standard-review', { source: 'reviewed-evaluation-revision', evaluation: { evaluationComplete: true, gatePassed: true } }),
    { id: 'author-failed', parentVersionId: 'base', state: 'failed' }];
  const project = { id: 'p', versions }, before = structuredClone(project), out = evolutionFunnelDisplay(project);
  assert.deepEqual([out.attempts, out.stopped, out.generated, out.measured, out.passed, out.adopted], [6, 1, 4, 3, 2, 1]);
  assert.match(out.limitation, /无需变更不是评估通过/); assert.equal('adoptionRate' in out, false); assert.deepEqual(project, before);
  assert.match(formatVersionList(project), /4 个已生成候选.*3 次完整评估.*2 次通过门槛.*1 次已采用/);
});
test('GUI and CLI show author abstention as an unscored review, with no fabricated ability changes', () => {
  assert.equal(authorAbstentionDisplay(stopped).label, '等待更多证据');
  assert.match(authorAbstentionDisplay(stopped).limitation, /不是候选质量评分/);
  assert.equal(versionChangeSummary({ versions: [] }, stopped).kind, 'review');
  const phases = { ...stopped, operationPhaseLedger: { schemaVersion: 1, phases: [{ phase: 'author', status: 'passed' }, { phase: 'paired', status: 'skipped' }] } };
  assert.equal(evaluationMethodDisplay(phases).phases[0].label, '作者复核');
  const detail = formatVersionDetail({ id: 'p' }, phases);
  assert.match(detail, /等待更多证据/); assert.match(detail, /未提供复现步骤/); assert.doesNotMatch(detail, /质量得分为 0/);
  assert.equal(evaluationBenefitDisplay(stopped), null);
  for (const key of ['sourceDeleted', 'contextRevoked', 'simulated']) assert.equal(authorAbstentionDisplay({ ...stopped, [key]: true }), null);
});
test('frozen gain diagnostics reveal an impossible ceiling without changing acceptance or rounding a failed gain to a pass', () => {
  const version = candidate('v', { evaluation: { evaluationComplete: true, gatePassed: false, baselineScore: .94, candidateScore: .99999, suite: { thresholds: { minImprovement: .1 } } } }), before = structuredClone(version);
  const view = evaluationBenefitDisplay(version); assert.equal(view.ceilingLimited, true); assert.match(view.limitation, /当前结果和门槛保持/); assert.deepEqual(version, before);
  assert.equal(evaluationBenefitDisplay({ ...version, evaluation: { ...version.evaluation, evaluationComplete: false } }), null);
  assert.equal(evaluationBenefitDisplay({ ...version, sourceDeleted: true }), null);
  version.evaluation.selection = { baselineScore: .8, candidateScore: .86 };
  assert.equal(evaluationBenefitDisplay(version).ceilingLimited, false); assert.equal(evaluationBenefitDisplay(version).gain < .1, true);
});
test('enhanced evaluation coverage separates completed judge evidence from planned multi-turn work and preserves absent history as unknown', () => {
  assert.equal(evaluationMethodDisplay(candidate('old')).enhanced, null);
  const version = candidate('new', { evaluation: { evaluationComplete: false, coverage: { visualJudgedCases: 1, researchReviewedCases: 0, multiTurnCases: 3, userTurns: 15 } } });
  const enhanced = evaluationMethodDisplay(version).enhanced;
  assert.equal(enhanced.visual, 1); assert.equal(enhanced.plannedTurns, 15);
  assert.match(enhanced.summary, /多轮计划 3 个用例、共 15 轮输入/);
  assert.match(enhanced.limitation, /不代表全部完成/);
  assert.match(formatVersionDetail({ id: 'p' }, version), /已完成像素对照 1 个/);
});
