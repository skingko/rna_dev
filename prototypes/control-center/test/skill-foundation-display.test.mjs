import test from 'node:test';
import assert from 'node:assert/strict';
import { skillSourceDisplay, skillFoundationDisplay, projectExternalSkillsDisplay, evolutionFunnelDisplay, versionChangeSummary, evaluationMethodDisplay, evaluationBenefitDisplay, referenceDiscoveryDisplay } from '../presentation/evolution-evidence-display.mjs';

const local = { id: 'frozen', name: 'Research method', source: { kind: 'installed-skill-package', manifestId: 'original', installationId: 'install-original', commit: 'a'.repeat(40), packageHash: 'b'.repeat(64) } };
const market = { id: 'market', name: 'Design method', source: { kind: 'marketplace-package', provider: 'skills-sh', commit: 'c'.repeat(40), packageHash: 'd'.repeat(64) } };
const fixture = () => ({
  project: { id: 'p', activeVersionId: 'foundation', assignments: { skillIds: ['original', 'gen-frozen', 'external'] }, versions: [{ id: 'foundation', source: 'skill-foundation', state: 'active', parentVersionId: 'base', bundle: { hash: 'version-hash', genome: { skills: [structuredClone(local), structuredClone(market)] } } }],
    skillFoundation: { schemaVersion: 1, status: 'partial', sourceCount: 2, coverage: [{ id: 'design', description: 'Design and usability', query: 'web design', status: 'selected', skillIds: ['frozen'] }, { id: 'research', description: 'Source verification', query: 'research', status: 'deferred', skillIds: [], reasonCode: 'marketplace_resolution_limit', reason: 'Source identity exceeded the bounded inspection limit.' }] } },
  capabilities: { installations: [{ installationId: 'install-original', projectId: 'p', status: 'installed', entries: [{ kind: 'skills', id: 'original' }] }, { installationId: 'install-other', projectId: 'p', status: 'installed', entries: [{ kind: 'skills', id: 'external' }] }], skills: [{ id: 'original', name: 'Original installed method', installationId: 'install-original', enabled: true, trusted: true }, { id: 'external', installationId: 'install-other', enabled: true, trusted: true }, { id: 'gen-frozen', projectId: 'p', versionId: 'foundation', localId: 'frozen', enabled: true, trusted: true }] },
});

test('installed snapshots retain local installation provenance and never claim remote blob verification', () => {
  const view = skillSourceDisplay(local); assert.equal(view.label, '已安装技能快照'); assert.equal(view.installationId, 'install-original'); assert.equal(view.manifestId, 'original');
  assert.match(view.detail, /不代表全部资源经过远端 Git blob 校验/); assert.doesNotMatch(view.label, /市场|自创/);
  assert.equal(skillSourceDisplay(market).label, '市场原包'); assert.equal(skillSourceDisplay({}).label, '项目自创技能'); assert.equal(skillSourceDisplay({ source: { kind: 'unknown' } }).label, '来源待核对');
});

test('effective version and matching external install are counted once without changing project permissions', () => {
  const f = fixture(), before = structuredClone(f), view = projectExternalSkillsDisplay(f.project, f.capabilities);
  assert.equal(view.count, 3); assert.deepEqual(view.rows.map(row => row.id), ['frozen', 'market', 'external']);
  assert.match(view.rows[0].originStatus, /原安装仍已分配/); assert.deepEqual(f, before);
  f.capabilities.skills.find(row => row.id === 'original').installationId = 'wrong-generation';
  assert.match(projectExternalSkillsDisplay(f.project, f.capabilities).rows[0].originStatus, /配置不可用/);
});

test('snapshot source status preserves revoked, disabled, unassigned and removed installations independently from version state', () => {
  for (const [kind, expected] of [['revoked', '授权已撤销'], ['disabled', '已停用'], ['unassigned', '未分配给此项目'], ['removed', '已注销'], ['missing-entry', '回执或配置不可用'], ['duplicate-receipt', '回执或配置不可用'], ['duplicate-manifest', '回执或配置不可用'], ['generated', '回执或配置不可用'], ['managed', '回执或配置不可用']]) {
    const f = fixture(), original = f.capabilities.skills[0];
    if (kind === 'revoked') original.trusted = false;
    if (kind === 'disabled') original.enabled = false;
    if (kind === 'unassigned') f.project.assignments.skillIds = ['gen-frozen', 'external'];
    if (kind === 'removed') f.capabilities.installations[0].status = 'removed';
    if (kind === 'missing-entry') f.capabilities.installations[0].entries = [];
    if (kind === 'duplicate-receipt') f.capabilities.installations.push(structuredClone(f.capabilities.installations[0]));
    if (kind === 'duplicate-manifest') f.capabilities.skills.push({ ...original, installationId: 'other-installation' });
    if (kind === 'generated') original.generated = true;
    if (kind === 'managed') original.managed = 'project-genome';
    const view = projectExternalSkillsDisplay(f.project, f.capabilities); assert.equal(view.count, 3); assert.match(view.rows[0].originStatus, new RegExp(expected)); assert.equal(view.rows[0].status, '当前项目版本已包含 · 当前不可用'); assert.equal(view.rows[0].unavailable, true);
    f.capabilities.skills[2].trusted = false; assert.match(projectExternalSkillsDisplay(f.project, f.capabilities).rows[0].status, /版本技能授权已撤销/);
  }
});

test('trial selection excludes active-only packages and revoked versions never advertise their sources as current', () => {
  const f = fixture(); f.project.trialVersionId = 'trial'; f.project.versions.push({ id: 'trial', state: 'trial', bundle: { genome: { skills: [market] } } });
  const view = projectExternalSkillsDisplay(f.project, f.capabilities); assert.equal(view.count, 3); assert.deepEqual(view.rows.map(row => row.id), ['market', 'original', 'external']); assert.equal(view.rows[0].status, '当前试用版本已包含');
  f.project.versions[1].contextRevoked = true; assert.deepEqual(projectExternalSkillsDisplay(f.project, f.capabilities).rows.map(row => row.id), ['original', 'external']);
});

test('unassigned external installs cannot appear enabled when trust was revoked', () => {
  const f = fixture(); f.capabilities.skills.find(row => row.id === 'external').trusted = false;
  const row = projectExternalSkillsDisplay(f.project, f.capabilities).rows.find(row => row.id === 'external'); assert.equal(row.trusted, false); assert.match(row.status, /授权已撤销/); assert.doesNotMatch(row.status, /已安装并分配/);
});

test('foundation source versions never inflate evolution attempts, passing scores or adoption, even with stale quality fields', () => {
  const f = fixture(), v = f.project.versions[0]; Object.assign(v, { adoptedAt: '2026-09-28T00:00:00Z', evaluation: { gatePassed: true, evaluationComplete: true, baselineScore: .5, candidateScore: .8, suite: { thresholds: { minImprovement: .1 } } } });
  const funnel = evolutionFunnelDisplay(f.project); for (const key of ['attempts', 'generated', 'measured', 'passed', 'adopted']) assert.equal(funnel[key], 0);
  assert.match(versionChangeSummary(f.project, v).summary, /未作收益评测/); assert.equal(versionChangeSummary(f.project, v).kind, 'foundation'); assert.equal(evaluationBenefitDisplay(v), null); assert.equal(evaluationMethodDisplay(v).recorded, false); assert.match(evaluationMethodDisplay(v).summary, /不计入进化采纳率/);
});

test('foundation concise status preserves explicit coverage gaps and does not invent zero counts from absent fields', () => {
  const f = fixture(), view = skillFoundationDisplay(f.project); assert.equal(view.sourceCount, 2); assert.equal(view.selected, 1); assert.equal(view.deferred, 1); assert.match(view.summary, /2 项来源技能，1 项缺口/); assert.equal(view.coverage[1].reasonCode, 'marketplace_resolution_limit');
  for (const status of ['ready', 'preparing', 'failed', 'stale']) { f.project.skillFoundation.status = status; assert.ok(skillFoundationDisplay(f.project).summary); }
  delete f.project.skillFoundation.sourceCount; assert.equal(skillFoundationDisplay(f.project).sourceCount, null);
  f.project.skillFoundation.schemaVersion = 2; assert.equal(skillFoundationDisplay(f.project), null);
  f.project.skillFoundation.schemaVersion = 1; f.project.contextRevoked = true; assert.equal(skillFoundationDisplay(f.project), null);
});

test('source receipts distinguish actual version membership from acquisition and show search coverage without hiding read failures', () => {
  const f = fixture(), v = f.project.versions[0];
  v.referenceDiscovery = { searches: 3, filesRead: 1, installed: false, packages: [{ skillId: market.id, ...market.source, files: [{ path: 'SKILL.md' }] }], searchCoverage: ['partial', 'unsupported', 'empty'].map(status => ({ provider: 'skills-sh', coverage: { status, supportedCount: status === 'partial' ? 1 : 0, unsupportedCount: status === 'empty' ? 0 : 1 } })), failures: [{ operation: 'marketplace_read', code: 'marketplace_resolution_limit' }] };
  let view = referenceDiscoveryDisplay(f.project, v); assert.equal(view.activation, 'active'); assert.match(view.packages[0].activationLabel, /当前项目版本/); assert.deepEqual(view.searchCoverage.map(row => row.status), ['partial', 'unsupported', 'empty']); assert.equal(view.failures[0].code, 'marketplace_resolution_limit');
  assert.match(view.searchCoverage[1].label, /存在但格式不支持/); assert.match(view.searchCoverage[2].label, /返回空结果/);
  v.bundle.genome.skills = [local]; view = referenceDiscoveryDisplay(f.project, v); assert.equal(view.packages[0].includedInVersion, false); assert.match(view.packages[0].activationLabel, /不能据此宣称已启用/); assert.doesNotMatch(view.label, /已包含在当前/);
});
