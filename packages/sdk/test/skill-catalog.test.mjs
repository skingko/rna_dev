import test from 'node:test';
import assert from 'node:assert/strict';
import { executeProjectEvaluationCase } from '../src/project-evolution.mjs';
import { formatSkillCatalog, SKILL_DISCOVERY_GUIDANCE } from '../src/skill-catalog.mjs';

test('catalog keeps caller order and revision identity without disclosing bodies or host paths', () => {
  const catalog = JSON.parse(formatSkillCatalog([
    { id: 'z', name: 'JSON', description: 'Validate JSON outputs', instructions: 'PRIVATE_BODY', filePath: '/private/package', contentHash: 'revision' },
    { id: 'a', name: 'Research', description: 'Compare primary sources', resources: [{ path: 'PRIVATE_RESOURCE' }] },
  ]));
  assert.deepEqual(catalog.skills.map(row => row.id), ['z', 'a']);
  assert.equal(catalog.skills[0].contentHash, 'revision');
  assert.equal(JSON.stringify(catalog).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(catalog).includes('/private'), false);
});

test('evaluation uses normal discovery guidance while a nonmatching task proceeds without forced loading', async () => {
  const genome = { schemaVersion: 1, systemPrompt: 'Carry out the user task.', skills: [{ id: 'ledger', name: 'Ledger', description: 'Reconcile accounting records.', instructions: 'PRIVATE_LEDGER_METHOD', resources: [] }], tools: [], evaluationSuite: { version: 'catalog-contract', criteria: [{ id: 'quality', description: 'Answer the task', weight: 1 }], cases: [1, 2, 3].map(n => ({ id: `task_${n}`, input: 'Reply hello.', requiredTerms: [], forbiddenTerms: [], requiredToolIds: [], weight: 1 })), thresholds: { minImprovement: .1, maxRegression: 0, minScore: .7, maxTokenRatio: 2 } } };
  const requests = [];
  const result = await executeProjectEvaluationCase({ genome, caseId: 'task_1', model: { providerId: 'fixture', modelId: 'fixture', contextWindow: 64000, maxOutputTokens: 4096 }, provider: async function* (request) {
    requests.push(request); yield { type: 'text_delta', delta: 'hello' }; yield { type: 'usage', usage: { totalTokens: 1 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  assert.equal(result.result.passed, true); assert.equal(requests.length, 1);
  assert.ok(requests[0].systemPrompt.includes(SKILL_DISCOVERY_GUIDANCE));
  assert.ok(!requests[0].systemPrompt.includes('PRIVATE_LEDGER_METHOD'));
  assert.ok(requests[0].tools.some(tool => tool.name === 'skill_load'));
  assert.equal(result.result.toolResults.length, 0);
});
