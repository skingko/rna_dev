import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLearningToolReceipts, summarizeLearningToolFailure, projectLearningEpisodes, projectLearningSourceRecords, projectLearningEvaluationAudit } from '../project-learning-evidence.mjs';
import { describeEvolutionAssessment } from '../project-evolution-assessment.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';

const invalid = 'Invalid tool arguments: $.expectedHash: anyOf constraint failed';
const receipt = (n, status = 'completed') => ({ toolCallId: `c${n}`, toolName: 'project_write', status, output: status === 'failed' ? invalid : 'wrote a file' });
function fixture() {
  const action = { id: 'work', action: 'work', status: 'completed', content: 'Create a report', resultSummary: 'The model claims success', finishedAt: 1000 };
  const project = { id: 'p', jobs: [], initiativeRuntime: { sdkState: { actions: [action] } } };
  const session = { id: 's', projectId: 'p', turns: [], items: [] };
  return { project, session, state: { projects: [project], sessions: [session] } };
}

test('rolling receipt retention keeps early and late failures after successful recovery without growing the cap', () => {
  let rows = [];
  for (let n = 0; n < 60; n++) rows = selectLearningToolReceipts([...rows, receipt(n, n === 1 || n === 17 || n === 40 ? 'failed' : 'completed')]);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.filter(row => row.status === 'failed').map(row => row.toolCallId), ['c1', 'c17', 'c40']);
  assert.equal(rows.at(-1).toolCallId, 'c59');
  assert.equal(selectLearningToolReceipts([...rows, rows.at(-1)]).length, 12);
  for (const options of [{ limit: 0 }, { limit: 65 }, { limit: 3, failureLimit: 4 }]) assert.throws(() => selectLearningToolReceipts(rows, options));
});

test('failure selection bounds a long failure storm and preserves original ordering', () => {
  const rows = Array.from({ length: 40 }, (_, n) => receipt(n, 'failed'));
  const selected = selectLearningToolReceipts(rows, { limit: 4, failureLimit: 2 });
  assert.deepEqual(selected.map(row => row.toolCallId), ['c0', 'c37', 'c38', 'c39']);
  assert.deepEqual(selectLearningToolReceipts(rows, { limit: 2, failureLimit: 0 }), rows.slice(-2));
});

test('argument diagnostics distinguish JSON null from string null without copying unrelated parameters', () => {
  const args = { expectedHash: 'null', content: 'private report body', command: 'private command', apiKey: 'private key' };
  const context = summarizeLearningToolFailure({ args, output: invalid });
  assert.equal(context.argumentPath, '$.expectedHash');
  assert.deepEqual(context.argument, { present: true, type: 'string', length: 4, literal: 'null' });
  assert.doesNotMatch(JSON.stringify(context), /private|command|content|apiKey/);
  assert.deepEqual(summarizeLearningToolFailure({ args: { expectedHash: null }, output: invalid }).argument, { present: true, type: 'null', literal: null });
  assert.equal(summarizeLearningToolFailure({ args: {}, output: invalid }).argument.type, 'missing');
});

test('sensitive paths, arbitrary strings and malformed paths cannot copy secrets into failure context', () => {
  const secret = 'PRIVATE_SECRET_'.repeat(10000);
  const privateField = summarizeLearningToolFailure({ args: { authorization: secret }, output: 'Invalid tool arguments: $.authorization: constraint failed' });
  assert.deepEqual(privateField.argument, { present: true, type: 'string', redacted: true });
  const ordinary = summarizeLearningToolFailure({ args: { expectedHash: secret }, output: invalid });
  assert.deepEqual(ordinary.argument, { present: true, type: 'string', length: secret.length });
  for (const output of ['Invalid tool arguments: $["secret"]: failed', 'NameError: private secret', `logged text: ${invalid}`, `Invalid tool arguments: $.${'x'.repeat(500)}: failed`]) assert.equal(summarizeLearningToolFailure({ args: { secret }, output }).kind, 'tool_execution');
  assert.ok(JSON.stringify([ordinary, privateField]).length < 600);
});

test('background reflection receives retained failures and safe field diagnostics instead of only the successful tail', () => {
  const f = fixture(), failed = receipt(0, 'failed');
  failed.failureContext = summarizeLearningToolFailure({ args: { expectedHash: 'null', content: 'DO_NOT_COPY' }, output: invalid });
  failed.failureContext.extra = 'DO_NOT_COPY';
  f.project.jobs.push({ id: 'work', simulated: false, toolReceipts: [failed, ...Array.from({ length: 11 }, (_, n) => receipt(n + 1))], toolReceiptCounts: { total: 36, failed: 5, completed: 31 } });
  const episodes = projectLearningEpisodes(f.state, f.project, 'scope').episodes, detail = JSON.parse(episodes[0].summary);
  assert.equal(detail.tools.length, 4); assert.equal(detail.tools[0].toolCallId, 'c0');
  assert.equal(detail.tools[0].failureContext.argument.literal, 'null');
  assert.equal(detail.coverage.failed, 5); assert.equal(detail.coverage.selectedFailedToolResults, 1);
  assert.equal(detail.resultVerifiedByHost, false); assert.doesNotMatch(episodes[0].summary, /DO_NOT_COPY/);
  const frozen = projectLearningSourceRecords(f.state, f.project, episodes);
  assert.doesNotMatch(JSON.stringify(frozen), /DO_NOT_COPY/);
  failed.failureContext = { schemaVersion: 1, kind: 'tool_argument_validation', argumentPath: '$.credentials.pin', argument: { present: true, type: 'number', literal: 9191837 } };
  const damaged = projectLearningEpisodes(f.state, f.project, 'scope').episodes;
  assert.doesNotMatch(JSON.stringify(damaged), /9191837/);
  assert.equal(JSON.parse(damaged[0].summary).tools[0].failureContext.argument.redacted, true);
  failed.sourceDeleted = true;
  assert.equal(JSON.parse(projectLearningEpisodes(f.state, f.project, 'scope').episodes[0].summary).coverage.selectedFailedToolResults, 0);
});

test('foreground failed arguments are diagnosed with source call identity while successful args remain excluded', () => {
  const f = fixture(); f.project.initiativeRuntime.sdkState.actions = [];
  f.session.turns.push({ id: 'turn', status: 'completed', completedAt: new Date(1000).toISOString(), modelConfig: { execution: 'rna' } });
  f.session.items.push({ id: 'i', turnId: 'turn', kind: 'tool', tool: { id: 'call', name: 'project_write', status: 'failed', args: { expectedHash: 'null', content: 'SECRET_BODY' }, output: invalid } });
  for (let n = 0; n < 8; n++) f.session.items.push({ id: `ok${n}`, turnId: 'turn', kind: 'tool', tool: { id: `ok${n}`, name: 'project_write', status: 'completed', args: { content: 'SECRET_BODY' }, output: 'ok' } });
  const detail = JSON.parse(projectLearningEpisodes(f.state, f.project, 'scope').episodes[0].summary);
  assert.equal(detail.tools[0].toolCallId, 'call'); assert.equal(detail.tools[0].failureContext.argument.literal, 'null');
  assert.equal(detail.coverage.selectedFailedToolResults, 1); assert.doesNotMatch(JSON.stringify(detail), /SECRET_BODY/);
  for (let n = 0; n < 3; n++) f.session.items.push({ id: `request${n}`, turnId: 'turn', kind: 'user', text: '长请求'.repeat(3000) });
  f.session.items.push({ id: 'final', turnId: 'turn', kind: 'assistant', text: '长回复'.repeat(3000) });
  for (const item of f.session.items.filter(row => row.tool?.status === 'completed')) item.tool.output = '长输出'.repeat(3000);
  const bounded = projectLearningEpisodes(f.state, f.project, 'scope').episodes[0];
  assert.ok(bounded.summary.length <= 5800); assert.equal(JSON.parse(bounded.summary).tools[0].failureContext.argument.literal, 'null');
});

test('evaluation audit reveals shared contract failure categories without oracle, score or new evidence claims', () => {
  const result = { checks: { completed: true, requiredTerms: false, toolErrors: false }, answer: 'PRIVATE_ORACLE', calls: [{ arguments: { content: 'PRIVATE_ORACLE' } }] };
  const project = { versions: [{ id: 'rejected', simulated: false, state: 'rejected', evaluation: { stage: 'deterministic_case', evaluationComplete: false, scoredCases: 1, details: [{ id: 'CASE_PRIVATE', baseline: result, candidate: result }] } }] };
  const audit = projectLearningEvaluationAudit(project);
  assert.deepEqual(audit[0].commonFailedChecks, ['requiredTerms', 'toolErrors']);
  assert.equal(audit[0].qualityScoringComplete, false); assert.equal(audit[0].scoredCases, 1); assert.equal(audit[0].isExternalEvidence, false);
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_ORACLE|CASE_PRIVATE/);
  project.versions[0].evaluation.details = [{ baseline: result }, { candidate: result }];
  assert.deepEqual(projectLearningEvaluationAudit(project)[0].commonFailedChecks, []);
  project.versions[0].sourceDeleted = true; assert.deepEqual(projectLearningEvaluationAudit(project), []);
});

test('partially scored deterministic rejection is not labelled as an overall quality loss', () => {
  const assessment = describeEvolutionAssessment({ id: 'v', state: 'rejected', evaluation: { gatePassed: false, stage: 'deterministic_case', scoredCases: 1, details: [], gates: { deterministicCases: false } } });
  assert.equal(assessment.label, '任务检查未通过（部分评分）'); assert.equal(assessment.scoredCases, 1);
  assert.match(assessment.summary, /整体质量评估未完成/); assert.doesNotMatch(assessment.label, /效果/);
  assert.equal(describeEvolutionAssessment({ id: 'v', state: 'rejected', sourceDeleted: true, evaluation: { gatePassed: false, stage: 'deterministic_case', scoredCases: 1 } }).label, '来源会话已删除');
});

test('reflection input includes actual host capability differences and audit but does not manufacture episodes', async () => {
  const project = { id: 'p', activeVersionId: 'base', assignments: { skillIds: ['daily-briefing'], toolIds: ['project_exec'], mcpServerIds: [] }, versions: [{ id: 'base', bundle: { genome: { skills: [], tools: [], evaluationSuite: { cases: [] } } } }, { id: 'rejected', state: 'rejected', simulated: false, evaluation: { stage: 'deterministic_case', evaluationComplete: false, details: [{ id: 'private-case', baseline: { checks: { toolErrors: false } }, candidate: { checks: { toolErrors: false } } }] } }] };
  const store = { state: { configuration: { providers: [{ id: 'provider' }] }, capabilities: {} }, configurationService: { secret: () => undefined } };
  const input = await ProjectLearningController.prototype.review.call({ store, valid: () => true, project: () => project, reflect: async input => input }, { projectId: 'p', model: { providerId: 'provider' }, budget: {} }, { episodes: [], priorReviews: [] });
  assert.deepEqual(input.episodes, []); assert.deepEqual(input.project.runtimeCapabilityScope.assignedSkillIds, ['daily-briefing']);
  assert.ok(input.project.runtimeCapabilityScope.evaluationExcludes.includes('MCP'));
  assert.deepEqual(input.project.evaluationAudit[0].commonFailedChecks, ['toolErrors']);
  assert.doesNotMatch(JSON.stringify(input), /private-case/);
});

test('reflection audit includes bounded exposure from ready and interrupted evaluations without becoming an episode', () => {
  const change = { id: 'skill_instructions:review', kind: 'skill_instructions', target: 'review' };
  const exposure = { schemaVersion: 1, method: 'host-intervention-exposure-v1', plan: { changes: [change], body: 'PRIVATE_PROMPT' }, baseline: { changes: [{ ...change, status: 'observed' }] }, candidate: { changes: [{ ...change, status: 'unobserved', observations: [{ caseId: 'PRIVATE_CASE', reason: 'PRIVATE_RESULT' }] }] } };
  const project = { id: 'p', versions: [{ id: 'ready', simulated: false, state: 'ready', evaluation: { exposure } }, { id: 'interrupted', simulated: false, state: 'interrupted', evaluationEvidence: { exposure } }, { id: 'deleted', simulated: false, state: 'ready', sourceDeleted: true, evaluation: { exposure } }] };
  const audit = projectLearningEvaluationAudit(project);
  assert.deepEqual(audit.map(row => row.versionId), ['ready', 'interrupted']);
  assert.ok(audit.every(row => row.exposure.counts.candidate.unobserved === 1)); assert.ok(audit.every(row => row.exposure.isExternalEvidence === false));
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_/); assert.deepEqual(projectLearningEpisodes({ projects: [project], sessions: [] }, project, 'scope').episodes, []);
});
