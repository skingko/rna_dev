import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSummary, versionChangeSummary } from '../presentation/evolution-evidence-display.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';

const fixture = () => {
  const base = { id: 'base', version: '0.2.0', state: 'baseline', bundle: { genome: projectGenomeFixture() }, policy: { concise: false } };
  const candidate = { id: 'candidate', version: 'candidate-1', parentVersionId: 'base', state: 'rejected', bundle: { genome: structuredClone(base.bundle.genome) }, policy: structuredClone(base.policy) };
  return { project: { activeVersionId: 'another-active', versions: [base, candidate] }, base, candidate };
};

test('observation uses a saved concise summary before title, text or technical rationale', () => {
  const row = { summary: '报告已准备好，等待明早交付。', title: '文件检查', text: '详细技术信息', reason: 'a'.repeat(800) };
  assert.deepEqual(observationSummary(row), { summary: row.summary, source: 'summary', label: '项目观察', isModelJudgment: false });
  delete row.summary;
  assert.equal(observationSummary(row).summary, '文件检查');
});

test('long model rationale becomes its first readable sentence and remains a model judgment', () => {
  const row = { action: 'wait', reason: '执行前的准备工作已经完成。下一次执行将在明天开始；此后有很多技术详情。' };
  const result = observationSummary(row, { kind: 'decision' });
  assert.equal(result.summary, '执行前的准备工作已经完成。');
  assert.equal(result.source, 'reason'); assert.equal(result.isModelJudgment, true); assert.equal(result.label, '保持安静');
});

test('no sentence boundary still uses a readable clause without dumping hundreds of technical characters', () => {
  const reason = `准备资料仍需核对（a20a2f34），${'核对运行环境与原始文件的边界情况，'.repeat(25)}`;
  const result = observationSummary({ action: 'work', reason }, { kind: 'decision' });
  assert.ok([...result.summary].length <= 89);
  assert.doesNotMatch(result.summary, /a20a2f34/);
  assert.match(result.summary, /^准备资料仍需核对/);
  assert.equal(result.summary.endsWith('。'), true);
});

test('summary keeps negation, numeric evidence and Markdown labels without following link instructions', () => {
  const text = '**尚未完成**：校验 2/3 项，评分 0.73；请看[记录](javascript:alert(1))。后续工作。';
  const result = observationSummary({ text });
  assert.match(result.summary, /尚未完成.*2\/3.*0\.73/);
  assert.doesNotMatch(result.summary, /javascript|\*\*/);
});

test('real research rationale exposes the delivery clause rather than internal commit repair details', () => {
  const reason = 'run 前准备已全部闭环：今日（09-26）报告已交付并通过校验；最后已知遗留（validate_report.py L59 过时注释）已于 20a2f34e 修复。随后等待运行。';
  const result = observationSummary({ action: 'wait', reason }, { kind: 'decision' });
  assert.equal(result.summary, '今日（09-26）报告已交付并通过校验。');
  assert.doesNotMatch(result.summary, /run|20a2f34e|L59/);
});

test('checkpoint-only maintenance uses action intent and never leaves an unclosed parenthesis', () => {
  for (const reason of ['本次唤醒由检查点维护回执触发（revision 7→8 于 13:19:47Z 提交。', '本次唤醒由检查点维护回执触发（revision 7→8 于 13:19:47Z 提交），没有新增业务证据。', 'no_change 是最小诚实决定。']) {
    const result = observationSummary({ action: 'wait', reason }, { kind: 'decision' });
    assert.equal(result.source, 'fallback');
    assert.equal(result.summary, '当前选择保持安静，等待值得跟进的新变化。');
    assert.doesNotMatch(result.summary, /已完成|已交付|revision|13:19/);
  }
});

test('saved user-facing titles preserve identifiers, numbers and negation with Markdown delimiters removed', () => {
  const title = '**调整 validate_report.py**：`max_jump_distance` 不得超过 0.5（半径 0.05）。';
  const result = observationSummary({ title, reason: '全是内部维护回执' }, { kind: 'decision' });
  assert.equal(result.source, 'title');
  assert.equal(result.summary, '调整 validate_report.py：max_jump_distance 不得超过 0.5（半径 0.05）。');
  assert.equal(observationSummary({ summary: '_暂不更新_，仍需完成 3 项验证。' }).summary, '暂不更新，仍需完成 3 项验证。');
  const numeric = '金额上限（1000000）不得突破，编号 1234567890123456 必须原样保留。';
  assert.equal(observationSummary({ summary: numeric }).summary, numeric);
});

test('a later negation qualifies the preceding claim and no-change language never becomes an improvement', () => {
  const result = observationSummary({ action: 'learn', reason: '脚本检查已通过；但质量评分仍未完成，不能认定优于当前版本。提交 20a2f34e 已完成。' }, { kind: 'decision' });
  assert.equal(result.summary, '脚本检查已通过；但质量评分仍未完成，不能认定优于当前版本。');
  assert.equal(observationSummary({ action: 'learn', reason: '本轮不需要修改方法，现有验证没有显示质量提升。' }, { kind: 'decision' }).summary, '本轮不需要修改方法，现有验证没有显示质量提升。');
});

test('punctuation inside a balanced parenthesis cannot cut a title or create a false full sentence', () => {
  const summary = '尚未完成校验（报告包含 A. 方案与 B. 方案，仍需对照），最多允许 2 次尝试。';
  assert.equal(observationSummary({ summary }).summary, summary);
  const reason = `业务结果尚未确认（${'仍需保留各项数值约束，'.repeat(20)}不得超过 3 次），暂不采用。`;
  const result = observationSummary({ action: 'learn', reason }, { kind: 'decision' });
  assert.equal(result.source, 'fallback'); assert.doesNotMatch(result.summary, /已确认|已采用|已通过/);
});

test('missing rationale uses action intent rather than inventing execution or success', () => {
  for (const action of ['work', 'learn', 'share', 'schedule', 'ask', 'wait']) {
    const result = observationSummary({ action }, { kind: 'decision' });
    assert.equal(result.source, 'fallback'); assert.doesNotMatch(result.summary, /已经完成|已完成|成功|已交付/);
  }
});

test('withdrawn, deleted and revoked observations never expose retained private text', () => {
  for (const patch of [{ status: 'withdrawn' }, { status: 'superseded' }, { sourceDeleted: true }, { contextRevoked: true }]) {
    const result = observationSummary({ summary: 'PRIVATE', reason: 'PRIVATE', ...patch }, { kind: 'decision' });
    assert.equal(result.source, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal(observationSummary({ text: '模拟观察', simulated: true }).label, '演示记录');
});

test('real parent delta separates prompt, skills, tools, evaluation and policy changes', () => {
  const { project, base, candidate } = fixture(), genome = candidate.bundle.genome;
  genome.systemPrompt += ' 改为先查证原始资料。';
  genome.skills[0].resources[0].content += ' 增加失败案例。';
  genome.skills.push({ id: 'new_skill', name: '来源审查', instructions: '查看来源', resources: [] });
  genome.tools = [{ ...genome.tools[0], id: 'new_tool', name: '新的估算工具' }];
  genome.evaluationSuite.criteria[0].weight = 2;
  candidate.policy.concise = true;
  project.versions.push({ id: 'another-active', bundle: structuredClone(candidate.bundle) });
  const before = JSON.stringify(project), result = versionChangeSummary(project, candidate);
  assert.equal(result.kind, 'changed'); assert.equal(result.baselineVersionId, base.id); assert.equal(result.baselineLabel, 'v0.2.0');
  assert.deepEqual(result.tags, ['提示词', '技能', '工具', '评估标准', '行为策略']);
  assert.deepEqual(result.categories.find(row => row.key === 'skills').counts, { added: 1, updated: 1, removed: 0 });
  assert.deepEqual(result.categories.find(row => row.key === 'tools').counts, { added: 1, updated: 0, removed: 1 });
  assert.equal(result.categories.find(row => row.key === 'skills').added[0].name, '来源审查');
  assert.doesNotMatch(result.summary, /提升|更好|通过|采用/);
  assert.equal(JSON.stringify(project), before);
});

test('object property order and skill/tool collection order do not count as capability changes', () => {
  const { project, base, candidate } = fixture();
  base.bundle.genome.skills.push({ id: 'second', name: '第二技能', instructions: 'Read first' });
  candidate.bundle.genome = structuredClone(base.bundle.genome);
  candidate.bundle.genome.skills.reverse();
  const skill = candidate.bundle.genome.skills[1];
  candidate.bundle.genome.skills[1] = { resources: skill.resources, instructions: skill.instructions, description: skill.description, name: skill.name, id: skill.id };
  candidate.bundle.genome.tools[0].parameters = { additionalProperties: false, required: ['features'], properties: candidate.bundle.genome.tools[0].parameters.properties, type: 'object' };
  assert.equal(versionChangeSummary(project, candidate).kind, 'unchanged');
});

test('resource bytes, tool code, schema and permission differences each count as a real adjustment', () => {
  for (const change of [
    genome => { genome.skills[0].resources[0].content += ' new'; },
    genome => { genome.tools[0].script += '\n// new'; },
    genome => { genome.tools[0].parameters.required = []; },
    genome => { genome.tools[0].permission = 'write'; }
  ]) {
    const { project, candidate } = fixture(); change(candidate.bundle.genome);
    assert.equal(versionChangeSummary(project, candidate).kind, 'changed');
  }
});

test('evaluation retry compares source bytes and never presents old skill changes as newly authored', () => {
  const { project, candidate } = fixture(); candidate.bundle.genome.skills[0].instructions += ' 验证结果。';
  const retry = { ...structuredClone(candidate), id: 'retry', retryOfVersionId: candidate.id, state: 'ready', evaluation: { candidateScore: 1 } };
  project.versions.push(retry);
  const result = versionChangeSummary(project, retry);
  assert.equal(result.kind, 'reevaluation'); assert.deepEqual(result.tags, ['重新评估']);
  assert.equal(result.categories.find(row => row.key === 'skills').counts.updated, 1);
  assert.match(result.summary, /重新评估.*未修改原候选/);
  retry.bundle.genome.skills[0].instructions += ' 新编辑。';
  assert.equal(versionChangeSummary(project, retry).kind, 'changed');
});

test('changed policy on a retry is a change rather than evaluation-only', () => {
  const { project, candidate } = fixture();
  const retry = { ...structuredClone(candidate), id: 'retry', retryOfVersionId: candidate.id, policy: { concise: true } };
  project.versions.push(retry);
  assert.equal(versionChangeSummary(project, retry).kind, 'changed');
  assert.deepEqual(versionChangeSummary(project, retry).tags, ['行为策略']);
});

test('new assessment or persuasive prose alone cannot imply a capability improvement', () => {
  const { project, candidate } = fixture();
  Object.assign(candidate, { summary: '巨大提升', title: '全部能力已改进', assessment: { label: '通过' }, evaluation: { candidateScore: 0.99 }, bundle: { ...candidate.bundle, hash: 'new transport hash' } });
  const result = versionChangeSummary(project, candidate);
  assert.equal(result.kind, 'unchanged'); assert.deepEqual(result.tags, ['无能力变更']);
});

test('evaluation-suite-only revision has its own category and is not new prompt or skill work', () => {
  const { project, candidate } = fixture(); candidate.bundle.genome.evaluationSuite.thresholds.minScore = 0.8;
  const result = versionChangeSummary(project, candidate);
  assert.equal(result.kind, 'changed'); assert.deepEqual(result.tags, ['评估标准']); assert.equal(result.summary, '调整评估标准。');
});

test('capability assignments compare selected ids, not list order or explanatory prose', () => {
  const { project, base, candidate } = fixture();
  base.assignments = { skillIds: ['read', 'review'], toolIds: ['project_read'], mcpServerIds: [], reasons: [{ reason: 'Original selection' }] };
  candidate.assignments = { skillIds: ['review', 'read'], toolIds: ['project_read'], mcpServerIds: [], reasons: [{ reason: 'Rephrased justification' }] };
  assert.equal(versionChangeSummary(project, candidate).kind, 'unchanged');
  candidate.assignments.mcpServerIds.push('research');
  assert.deepEqual(versionChangeSummary(project, candidate).tags, ['能力分配']);
});

test('initial bundle is an inventory, never an improvement against an invented baseline', () => {
  const { project, base } = fixture(), result = versionChangeSummary(project, base);
  assert.equal(result.kind, 'initial'); assert.equal(result.comparisonAvailable, false);
  assert.match(result.summary, /初始能力.*1 项技能.*1 个工具/);
  assert.doesNotMatch(result.summary, /改进|提升|新增|调整/);
});

test('absent bundle, missing parent and revoked baseline are unknown and never fall back to active', () => {
  for (const change of [
    ({ candidate }) => { delete candidate.bundle; },
    ({ candidate }) => { candidate.parentVersionId = 'missing'; },
    ({ candidate }) => { delete candidate.parentVersionId; },
    ({ base }) => { base.contextRevoked = true; },
    ({ base }) => { base.sourceDeleted = true; },
    ({ base }) => { base.simulated = true; }
  ]) {
    const current = fixture(); change(current);
    current.project.versions.push({ id: 'another-active', bundle: structuredClone(current.base.bundle) });
    const result = versionChangeSummary(current.project, current.candidate);
    assert.equal(result.kind, 'unknown'); assert.equal(result.comparisonAvailable, false); assert.deepEqual(result.categories, []);
  }
});

test('malformed duplicate or null capability entries remain unknown instead of throwing', () => {
  for (const collection of [[null], [{ id: 'duplicate' }, { id: 'duplicate' }]]) {
    const { project, candidate } = fixture(); candidate.bundle.genome.skills = collection;
    assert.equal(versionChangeSummary(project, candidate).kind, 'unknown');
  }
});

test('baseVersionId and retained bundle parent work without using current active', () => {
  for (const key of ['baseVersionId', 'bundle']) {
    const { project, candidate } = fixture(); delete candidate.parentVersionId;
    if (key === 'bundle') candidate.bundle.parentVersionId = 'base'; else candidate.baseVersionId = 'base';
    assert.equal(versionChangeSummary(project, candidate).kind, 'unchanged');
  }
});

test('simulated and revoked versions expose neither invented changes nor source text', () => {
  const { project, candidate } = fixture();
  candidate.simulated = true; assert.deepEqual(versionChangeSummary(project, candidate).tags, ['演示记录']);
  candidate.sourceDeleted = true; assert.deepEqual(versionChangeSummary(project, candidate).categories, []);
});
