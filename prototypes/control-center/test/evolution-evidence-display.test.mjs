import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDiscoveryDisplay, installedProjectSkills, evaluationProgressDisplay, retryRelations, evolutionSearchDisplay } from '../presentation/evolution-evidence-display.mjs';
const discovery = { mode: 'public_reference_adaptation_not_installed', searches: 2, filesRead: 1, installed: false, sources: [{ provider: 'skills-sh', id: 'owner/repo/research', commit: 'a'.repeat(40), path: 'SKILL.md', contentHash: 'b'.repeat(64), sourceUrl: 'https://github.com/owner/repo/blob/main/SKILL.md' }] };
test('a restart never keeps an old running search feedback visible as an active experiment', () => {
  const version = { simulated: false, state: 'interrupted', searchSummary: { schemaVersion: 1, method: 'host-bounded-search-v1', maxChangedAssets: 4 }, searchFeedback: { reason: 'in_progress' } };
  assert.match(evolutionSearchDisplay(version).feedback, /已中断/); assert.doesNotMatch(evolutionSearchDisplay(version).feedback, /仍在执行/);
  version.sourceDeleted = true; assert.equal(evolutionSearchDisplay(version), null);
});
test('real source receipts are displayed independently of model prose and install claims', () => {
  const v = { id: 'v', title: 'Already searched and installed', referenceDiscovery: discovery };
  const view = referenceDiscoveryDisplay({ versions: [v] }, v);
  assert.match(view.label, /公开搜索 2 次.*读取 1 次.*没有安装/);
  assert.equal(view.sources[0].commit, 'a'.repeat(40));
  assert.match(referenceDiscoveryDisplay({ versions: [] }, { id: 'x', title: 'I searched 20 sources and installed all' }).label, /未保留.*不能/);
});
test('old retry records resolve original source receipts without mutating history or claiming a new search', () => {
  const a = { id: 'a', referenceDiscovery: discovery }, b = { id: 'b', retryOfVersionId: 'a' }, p = { versions: [a, b] }, before = JSON.stringify(p);
  assert.equal(referenceDiscoveryDisplay(p, b).inheritedFromVersionId, 'a');
  assert.match(referenceDiscoveryDisplay(p, b).label, /本次未重新检索/);
  assert.equal(JSON.stringify(p), before);
  a.contextRevoked = true; assert.equal(referenceDiscoveryDisplay(p, b).status, 'unknown');
  b.retryOfVersionId = 'b'; assert.equal(referenceDiscoveryDisplay(p, b).status, 'unknown');
});
test('bootstrap source summary belongs only to its exact baseline and unsafe links are not rendered', () => {
  const v = { id: 'base' }, p = { initialization: { versionId: v.id, referenceDiscovery: { ...discovery, sources: [{ sourceUrl: 'javascript:alert(1)' }] } }, versions: [v] };
  assert.equal(referenceDiscoveryDisplay(p, v).status, 'recorded');
  assert.equal(referenceDiscoveryDisplay(p, v).sources[0].sourceUrl, null);
  assert.equal(referenceDiscoveryDisplay(p, { id: 'new' }).status, 'unknown');
  assert.equal(referenceDiscoveryDisplay(p, { id: 'base', sourceDeleted: true }), null);
});
test('installed skill requires independent installation and matching manifest identity, active assignment stays distinct', () => {
  const p = { id: 'p', assignments: { skillIds: ['daily'] } }, cap = { installations: [{ installationId: 'i', projectId: 'p', status: 'installed', entries: [{ kind: 'skills', id: 'daily' }, { kind: 'skills', id: 'inactive' }, { kind: 'skills', id: 'removed' }], sources: [{ type: 'git', commit: 'c'.repeat(40) }] }], skills: [{ id: 'daily', installationId: 'i', enabled: true }, { id: 'inactive', installationId: 'i', enabled: false }] };
  const rows = installedProjectSkills(p, cap); assert.equal(rows.length, 2); assert.match(rows[0].status, /已安装并分配/); assert.match(rows[1].status, /未启用或未分配/);
  cap.installations[0].projectId = 'another'; assert.deepEqual(installedProjectSkills(p, cap).map(row => row.id), ['daily']);
  cap.installations[0].status = 'failed'; assert.deepEqual(installedProjectSkills(p, cap), []);
});
test('no completed scores cannot be mistaken for a quality score of zero and missing counts remain unknown', () => {
  const view = evaluationProgressDisplay({ assessment: { scoredCases: 0, totalCases: 4 }, evaluation: { cases: 1, skippedCases: 3 } });
  assert.match(view.label, /尚未进行质量评分.*共 4.*已执行 1.*未执行 3.*不等于质量得分为 0/);
  assert.match(evaluationProgressDisplay({}).label, /未记录/);
  assert.doesNotMatch(evaluationProgressDisplay({}).label, /已执行 0/);
});
test('retry navigation reflects actual project records and omits revoked sources', () => {
  const a = { id: 'a', state: 'interrupted' }, b = { id: 'b', retryOfVersionId: 'a', state: 'rejected', createdAt: '2026-01-02T00:00:00Z', assessment: { label: '行为检查未通过' } }, p = { versions: [a, b, { id: 'hidden', retryOfVersionId: 'a', contextRevoked: true }] };
  assert.equal(retryRelations(p, a).retries[0].label, '行为检查未通过');
  assert.equal(retryRelations(p, b).source.id, 'a');
  assert.equal(retryRelations(p, a).retries.length, 1);
});
