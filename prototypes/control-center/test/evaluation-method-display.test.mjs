import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationMethodDisplay } from '../presentation/evolution-evidence-display.mjs';
import { formatVersionList, formatVersionDetail } from '../cli-evaluation.mjs';
import { describeEvolutionAssessment } from '../project-evolution-assessment.mjs';

const ledger = () => ({ schemaVersion: 1, requestCount: 6, usage: { totalTokens: 3400 }, phases: ['author', 'preflight', 'deterministic', 'paired', 'confirmation'].map(phase => ({ phase, status: phase === 'confirmation' ? 'not_applicable' : 'passed', requests: phase === 'author' ? 1 : phase === 'paired' ? 5 : 0, usage: { totalTokens: phase === 'author' ? 400 : phase === 'paired' ? 3000 : 0 } })) });
const candidate = () => ({ id: 'v1', state: 'ready', title: '更可靠的来源与交付', simulated: false, assessment: { label: '评估通过', summary: 'Detailed diagnostic text belongs in details.' }, evaluation: { gatePassed: true, phaseLedger: ledger(), partitionSummary: { counts: { development: 1, selection: 3, confirmation: 0 }, confirmation: { status: 'not_applicable' } }, confirmation: { status: 'not_applicable', passed: null }, coverage: { researchCases: 2, automationCases: 1, browserCases: 1 }, details: [{ id: 'research', candidate: { domain: { passed: true, executionClaim: 'frozen_source_metadata_quote_provenance_only' } } }, { id: 'automation', candidate: { domain: { passed: false, executionClaim: 'isolated_protocol_fixture_state_only' } } }, { id: 'browser', candidate: { environment: { applicable: true, passed: true } } }] } });

test('one-line summary does not turn absent independent confirmation into a pass', () => {
  const version = candidate(), before = structuredClone(version), view = evaluationMethodDisplay(version);
  assert.match(view.summary, /尚无独立确认/); assert.equal(view.confirmation.passed, null); assert.match(view.confirmation.label, /未提供/); assert.equal(view.phases.at(-1).statusLabel, '未提供'); assert.deepEqual(version, before);
  version.evaluation.confirmation = { status: 'passed', passed: true }; assert.equal(evaluationMethodDisplay(version).confirmation.passed, null, 'missing data overrides contradictory status');
});

test('actual independent confirmation remains distinct from paired selection', () => {
  const version = candidate(); version.evaluation.partitionSummary.confirmation.status = 'available'; version.evaluation.confirmation = { status: 'passed', passed: true }; let view = evaluationMethodDisplay(version); assert.equal(view.confirmation.passed, true); assert.match(view.summary, /均已通过/);
  version.evaluation.confirmation = { status: 'failed', passed: false }; version.evaluation.gatePassed = false; view = evaluationMethodDisplay(version); assert.equal(view.confirmation.passed, false); assert.match(view.confirmation.label, /未通过/);
  version.evaluation.confirmation = { status: 'skipped', passed: null }; assert.equal(evaluationMethodDisplay(version).confirmation.passed, null);
});

test('method projection separates declared coverage from observed candidate receipts', () => {
  const view = evaluationMethodDisplay(candidate()), [research, automation, browser] = view.domains;
  assert.deepEqual([research.declared, research.executed, research.passed], [2, 1, 1]); assert.deepEqual([automation.declared, automation.executed, automation.passed], [1, 1, 0]); assert.deepEqual([browser.declared, browser.executed, browser.passed], [1, 1, 1]);
  assert.match(research.limitation, /不代表已联网/); assert.match(automation.limitation, /不代表外部/); assert.match(browser.limitation, /不代表美观/);
  const version = candidate(); version.evaluation.details = []; assert.ok(evaluationMethodDisplay(version).domains.every(row => row.executed === 0 && row.passed === 0));
});

test('operation-level author accounting takes precedence without modifying frozen evaluation ledger', () => {
  const version = candidate(); version.operationPhaseLedger = ledger(); version.operationPhaseLedger.phases[0].usage.totalTokens = 800; version.operationPhaseLedger.usage.totalTokens = 3800;
  const view = evaluationMethodDisplay(version); assert.equal(view.phases[0].tokens, 800); assert.equal(view.tokens, 3800); assert.equal(version.evaluation.phaseLedger.phases[0].usage.totalTokens, 400);
});

test('environment failure remains incomplete with actual costs and no manufactured score', () => {
  const version = candidate(); version.state = 'failed'; version.error = { code: 'environment_unavailable' }; version.evaluationEvidence = { phaseLedger: ledger(), inFlightCase: version.evaluation.details[2] }; delete version.evaluation;
  version.assessment = describeEvolutionAssessment(version); const view = evaluationMethodDisplay(version);
  assert.equal(view.environmentUnavailable, true); assert.match(view.summary, /尚无完整质量结论/); assert.equal(view.tokens, 3400); assert.equal(view.domains[0].id, 'browser'); assert.equal(version.assessment.scoredCases, 0); assert.match(version.assessment.summary, /浏览器评测环境/); assert.doesNotMatch(view.summary, /得分.*0|0分/);
});

test('historical absent accounting is unknown, never inferred as zero or passed', () => {
  const view = evaluationMethodDisplay({}); assert.equal(view.requests, null); assert.equal(view.tokens, null); assert.ok(view.phases.every(row => row.status === 'unrecorded' && row.requests === null && row.tokens === null)); assert.equal(view.confirmation.passed, null); assert.equal(view.recorded, false);
});

test('source-revoked and demonstration versions do not reveal private assessment details', () => {
  for (const patch of [{ sourceDeleted: true }, { contextRevoked: true }, { simulated: true }]) assert.equal(evaluationMethodDisplay({ ...candidate(), ...patch }), null);
});

test('failure diagnostics are projected without source bodies, quotes, expected values or protocol payloads', () => {
  const version = candidate(); version.state = 'rejected'; version.evaluation.gatePassed = false; version.evaluation.details[0].candidate.domain.checks = [{ id: 'provenance', kind: 'research_quote_provenance', passed: false, code: 'quote_not_in_source', expected: 'private expectation', actual: 'private quote' }];
  version.evaluation.details[2].candidate.environment.checks = [{ id: 'button', kind: 'assert_text', passed: false, code: 'assertion_mismatch', expected: 'private browser text' }];
  const assessment = describeEvolutionAssessment(version); assert.ok(assessment.failedChecks.some(row => row.group === 'domain')); assert.ok(assessment.failedChecks.some(row => row.group === 'environment')); assert.doesNotMatch(JSON.stringify(assessment), /private expectation|private quote|private browser text/);
});

test('CLI list is concise while detail exposes phases, accounting and actual verification limits', () => {
  const version = candidate(), project = { id: 'p', name: 'Research project', activeVersionId: 'base', versions: [version] };
  const list = formatVersionList(project); assert.match(list, /v1.*评估通过/); assert.doesNotMatch(list, /Detailed diagnostic|脚本与兼容检查|3,400|phaseLedger/); assert.match(list, /--json/);
  const detail = formatVersionDetail(project, version); for (const value of ['候选生成', '脚本与兼容检查', '产物与行为检查', '双边质量对照', '独立确认', '400', '3,000', '研究来源与引用', '自动化协议', '浏览器交互']) assert.ok(detail.includes(value), value);
  assert.match(detail, /未提供独立确认数据/); assert.match(detail, /--json/);
});

test('CLI strips untrusted terminal control sequences and bounds prose', () => {
  const version = { ...candidate(), title: '\x1b[2J\x1b]0;injected\x07A\nB\tC\u009b31m' + 'x'.repeat(1000) }; const project = { id: 'p', name: 'name\x1b[31m', versions: [version] };
  const output = formatVersionList(project); assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]|\x1b/); assert.ok(output.length < 500);
});

test('exposure details distinguish supplied prompt, unused skill and missing receipts without a quality claim', async () => {
  const { evaluationExposureDisplay } = await import('../presentation/evolution-evidence-display.mjs');
  const display = evaluationExposureDisplay({ schemaVersion: 1, method: 'host-intervention-exposure-v1', candidate: { changes: [
    { kind: 'system_prompt', mode: 'request_context', target: 'project', status: 'observed' },
    { kind: 'skill_instructions', mode: 'skill_content', target: 'review', status: 'unobserved' },
    { kind: 'tool_script', mode: 'tool_execution', target: 'validator', status: 'unknown' },
  ] } });
  assert.match(display.summary, /1 项已进入请求或执行，1 项未使用，1 项待确认/);
  assert.match(display.rows[0].label, /送入模型请求/); assert.match(display.rows[1].label, /未使用/);
  assert.match(display.limitation, /不代表改动提升了质量/);
  assert.equal(evaluationExposureDisplay(undefined), null);
});

test('legacy unknown exposure status remains unknown and human CLI summaries reject terminal escapes', async () => {
  const { evaluationExposureDisplay } = await import('../presentation/evolution-evidence-display.mjs');
  const d = evaluationExposureDisplay({ schemaVersion: 1, method: 'host-intervention-exposure-v1', candidate: { changes: [{ kind: 'skill_instructions', target: 'review', status: 'future_unknown' }] } });
  assert.match(d.summary, /1 项待确认/);
  const version = candidate(); version.evaluation.gatePassed = false; version.assessment.label = '\x1b[2JUnreadable\u009bclear';
  assert.doesNotMatch(formatVersionDetail({ id: 'p' }, version), /[\x1b\u009b]/);
});
