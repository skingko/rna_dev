import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillMarketplaceClient } from '../src/skill-marketplaces.mjs';
import { marketplaceFixture } from './fixtures/skill-marketplace.mjs';

// Skills come through the marketplace's own install path (the official `skills` CLI): the skills.sh
// snapshot endpoint, else a sparse git checkout of the skill directory. The GitHub REST API is never used.
const client = (f, options = {}) => new SkillMarketplaceClient({ fetchImpl: f.fetchImpl, git: f.git, ...options });
const noRestApi = f => assert.ok(f.calls.every(row => !row.url.startsWith('https://api.github.com/')), 'no GitHub REST API call');

test('skills.sh search reads each result\'s description from its own SKILL.md and carries the official install command', async t => {
  const f = await marketplaceFixture(t), c = client(f);
  const [row] = (await c.search({ query: 'research' })).results;
  assert.equal(row.description, 'Check claims against original sources.');
  assert.equal(row.installCommand, 'npx skills add fixture/skills --skill research');
  noRestApi(f);
});
test('reading a skill uses the skills.sh snapshot, pins the commit through git ls-remote and lists resources', async t => {
  const f = await marketplaceFixture(t), c = client(f); await c.search({ query: 'research' });
  const read = await c.read({ provider: 'skills-sh', id: 'fixture/skills/research' });
  assert.equal(read.via, 'skills.sh'); assert.equal(read.commit, f.commit); assert.equal(read.content, f.sources['skills/research/SKILL.md']);
  assert.deepEqual(read.resources.map(row => row.path), ['references/method.md']);
  assert.equal((await c.read({ provider: 'skills-sh', id: 'fixture/skills/research', path: 'references/method.md' })).content, f.sources['skills/research/references/method.md']);
  assert.ok(f.gitCalls.some(args => args[0] === 'ls-remote')); noRestApi(f);
});
test('concurrent first reads share one snapshot download', async t => {
  const f = await marketplaceFixture(t), c = client(f); await c.search({ provider: 'skillsmp', query: 'research' });
  const id = 'fixture-skills-research-skill-md';
  await Promise.all([c.read({ provider: 'skillsmp', id }), c.read({ provider: 'skillsmp', id }), c.read({ provider: 'skillsmp', id })]);
  assert.equal(f.calls.filter(row => row.url.includes('/api/download/')).length, 1);
});
test('only a searched result may be read and resource paths cannot escape the package', async t => {
  const f = await marketplaceFixture(t), c = client(f);
  await assert.rejects(c.read({ provider: 'skills-sh', id: 'fixture/skills/research' }), { code: 'marketplace_search_required' });
  await c.search({ query: 'research' });
  for (const path of ['../LICENSE', '/etc/passwd', 'a/../../x']) await assert.rejects(c.read({ provider: 'skills-sh', id: 'fixture/skills/research', path }), { code: 'marketplace_path' });
});
test('a skill skills.sh has not indexed falls back to a sparse git checkout of its directory plus root licenses', async t => {
  const f = await marketplaceFixture(t, { transform: (value, url) => url.pathname.startsWith('/api/download/') ? { status: 404 } : value }), c = client(f);
  await c.search({ provider: 'skillsmp', query: 'research' });
  const acquired = await c.acquire({ provider: 'skillsmp', id: 'fixture-skills-research-skill-md' });
  assert.ok(f.git.patterns.includes('/skills/research/') && f.git.patterns.includes('/LICENSE*'));
  assert.deepEqual(acquired.files.map(row => row.path), ['SKILL.md', 'references/method.md', '@license/LICENSE']);
  assert.equal(acquired.licenseReview, 'preserved_not_legal_approval'); assert.deepEqual(acquired.licensePaths, ['@license/LICENSE']); assert.equal(acquired.commit, f.commit);
  noRestApi(f);
});
test('acquisition keeps SKILL.md whole; binary, oversized and budget-exceeding resources are recorded, not fatal; no license means local use', async t => {
  const f = await marketplaceFixture(t, { transform: (value, url) => url.pathname.startsWith('/api/download/') ? { status: 404 } : value }), c = client(f);
  f.git.sources = { ...f.sources, 'skills/research/assets/logo.png': 'PNG\0\x01binary', 'skills/research/data/huge.md': 'x'.repeat(70000) };
  delete f.git.sources.LICENSE;
  await c.search({ provider: 'skillsmp', query: 'research' });
  const acquired = await c.acquire({ provider: 'skillsmp', id: 'fixture-skills-research-skill-md' });
  assert.equal(acquired.files[0].path, 'SKILL.md');
  assert.deepEqual(acquired.omittedFiles.map(row => [row.path, row.reason]).sort(), [['assets/logo.png', 'binary'], ['data/huge.md', 'over_64kb']]);
  assert.equal(acquired.licenseReview, 'no_license_declared_local_use'); assert.deepEqual(acquired.licensePaths, []);
  assert.equal(acquired.packageHash.length, 64); assert.equal(acquired.installed, false); assert.equal(acquired.executesCode, false);
});
test('a skill without a readable SKILL.md is reported, not guessed', async t => {
  const f = await marketplaceFixture(t, { transform: (value, url) => url.pathname.startsWith('/api/download/') ? { files: [{ path: 'README.md', contents: 'no skill' }], hash: 'x' } : value }), c = client(f);
  await c.search({ provider: 'skillsmp', query: 'research' });
  await assert.rejects(c.acquire({ provider: 'skillsmp', id: 'fixture-skills-research-skill-md' }), { code: 'marketplace_skill_missing' });
});
test('SkillsMP malformed, non-skill blob and encoded path separators are reported as unsupported without source requests', async t => {
  const suffixes = ['blob/main/README.md', 'blob/main/skills%2Fresearch/SKILL.md', 'tree/main/plugins%5Cresearch', 'tree/main/bad%xx'];
  const f = await marketplaceFixture(t, { transform(value, url) {
    if (url.hostname === 'skillsmp.com') return { ...value, data: { skills: suffixes.map((suffix, index) => ({ ...value.data.skills[0], id: `invalid-${index}`, githubUrl: `https://github.com/fixture/skills/${suffix}` })) } };
    return value;
  } });
  const result = await new SkillMarketplaceClient({ fetchImpl: f.fetchImpl }).search({ provider: 'skillsmp', query: 'research', limit: 4 });
  assert.equal(result.coverage.status, 'unsupported'); assert.equal(result.coverage.unsupportedCount, 4); assert.deepEqual(result.coverage.reasons, [{ code: 'unsupported_source_path', count: 4 }]); assert.equal(f.calls.length, 1);
});

test('search coverage distinguishes genuine empty, unsupported, partial, duplicate and bounded pages', async t => {
  const valid = { id: 'fixture/skills/research', source: 'fixture/skills', skillId: 'research', name: 'Source checking' };
  for (const [rows, limit, expected] of [
    [[], 3, { status: 'empty', returnedCount: 0, inspectedCount: 0, supportedCount: 0, unsupportedCount: 0, duplicateCount: 0, omittedCount: 0 }],
    [[null, { ...valid, source: 'secret://unsupported' }], 3, { status: 'unsupported', returnedCount: 2, inspectedCount: 2, supportedCount: 0, unsupportedCount: 2, duplicateCount: 0, omittedCount: 0 }],
    [[valid], 3, { status: 'complete', returnedCount: 1, inspectedCount: 1, supportedCount: 1, unsupportedCount: 0, duplicateCount: 0, omittedCount: 0 }],
    [[valid, null], 3, { status: 'partial', returnedCount: 2, inspectedCount: 2, supportedCount: 1, unsupportedCount: 1, duplicateCount: 0, omittedCount: 0 }],
    [[valid, valid], 3, { status: 'complete', returnedCount: 2, inspectedCount: 2, supportedCount: 1, unsupportedCount: 0, duplicateCount: 1, omittedCount: 0 }],
    [[valid, null], 1, { status: 'partial', returnedCount: 2, inspectedCount: 1, supportedCount: 1, unsupportedCount: 0, duplicateCount: 0, omittedCount: 1 }],
  ]) {
    const f = await marketplaceFixture(t, { transform(value, url) { return url.hostname === 'www.skills.sh' ? { skills: rows } : value; } });
    const result = await new SkillMarketplaceClient({ fetchImpl: f.fetchImpl }).search({ query: 'research', limit });
    const { reasons, ...coverage } = result.coverage; assert.deepEqual(coverage, expected);
    assert.equal(result.skippedUnsupported, expected.unsupportedCount); assert.ok(Array.isArray(reasons)); assert.ok(!JSON.stringify(result).includes('secret://unsupported'));
  }
});

test('both public keyword APIs normalize discovery without conferring trust or executing scripts', async t => {
  const f = await marketplaceFixture(t), client = new SkillMarketplaceClient({ fetchImpl: f.fetchImpl });
  for (const provider of ['skills-sh', 'skillsmp']) { const result = await client.search({ provider, query: 'research', limit: 2 }); assert.equal(result.results.length, 1); assert.equal(result.results[0].repository, 'fixture/skills'); assert.equal(result.results[0].trust, 'unreviewed_public_source'); }
  assert.ok(f.calls.every(row => row.authorization === undefined)); assert.equal(client.catalog().find(row => row.id === 'skillsmp').authentication, 'anonymous_limited');
});

test('auth remains scoped to SkillsMP and provider response errors never expose bearer keys or raw response', async t => {
  const f = await marketplaceFixture(t), client = new SkillMarketplaceClient({ fetchImpl: f.fetchImpl, git: f.git, skillsmpApiKey: () => 'private-fixture' });
  const result = await client.search({ provider: 'skillsmp', query: 'research' }); await client.read({ provider: 'skillsmp', id: result.results[0].id });
  assert.equal(f.calls[0].authorization, 'Bearer private-fixture'); assert.ok(f.calls.slice(1).every(row => row.authorization === undefined)); assert.ok(!JSON.stringify(client.catalog()).includes('private-fixture'));
  const unavailable = new SkillMarketplaceClient({ fetchImpl: async () => new Response('private-fixture', { status: 401 }) }); await assert.rejects(unavailable.search({ query: 'research' }), error => error.code === 'marketplace_auth' && !error.message.includes('private-fixture'));
});

test('timeouts and cancellation are bounded and query/result byte limits hold', async t => {
  const f = await marketplaceFixture(t, { delay: 200 }), client = new SkillMarketplaceClient({ fetchImpl: f.fetchImpl, timeoutMs: 20 });
  await assert.rejects(client.search({ query: 'research' }), { code: 'marketplace_timeout' });
  const controller = new AbortController(); controller.abort(new Error('cancelled before source request')); await assert.rejects(client.search({ query: 'research' }, { signal: controller.signal }), /cancelled before/);
  await assert.rejects(client.search({ query: '*', limit: 500 }), { code: 'marketplace_query' });
  const oversized = new SkillMarketplaceClient({ fetchImpl: async () => new Response('large', { headers: { 'content-length': 99999999 } }) }); await assert.rejects(oversized.search({ query: 'research' }), { code: 'marketplace_response_limit' });
});
test('a rate-limited skills.sh download falls back to git, which finds the skill directory from the tree listing', async t => {
  const f = await marketplaceFixture(t, { transform: (value, url) => url.pathname.startsWith('/api/download/') ? { status: 429 } : value }), c = client(f);
  const search = await c.search({ query: 'research' });
  assert.equal(search.results[0].description, '', 'enrichment stops at the rate limit instead of cloning');
  assert.equal(f.gitCalls.length, 0, 'search never clones');
  const acquired = await c.acquire({ provider: 'skills-sh', id: 'fixture/skills/research' });
  assert.equal(acquired.subdirectory, 'skills/research'); assert.deepEqual(acquired.files.map(row => row.path), ['SKILL.md', 'references/method.md', '@license/LICENSE']);
  assert.ok(f.gitCalls.some(args => args.includes('ls-tree'))); noRestApi(f);
});
test('ClawHub search returns its own packages and aggregated skills.sh skills with summaries; flagged rows are dropped', async t => {
  const f = await marketplaceFixture(t), c = client(f);
  const { results } = await c.search({ provider: 'clawhub', query: 'serial fiction' });
  assert.deepEqual(results.map(row => [row.id, row.kind]), [['fixture/story-method', 'clawhub'], ['fixture/skills/research', 'skills-sh']]);
  assert.equal(results[0].description, 'Plan long serial fiction chapter by chapter.'); assert.equal(results[1].description, 'Check claims against original sources.');
  assert.equal(results[0].installCommand, 'npx clawhub install story-method'); assert.equal(results[1].installCommand, 'npx skills add fixture/skills --skill research');
});
test('a ClawHub package installs from its versioned zip, pinned by the archive digest; an aggregated skills.sh skill uses skills.sh', async t => {
  const f = await marketplaceFixture(t), c = client(f); await c.search({ provider: 'clawhub', query: 'serial fiction' });
  const own = await c.acquire({ provider: 'clawhub', id: 'fixture/story-method' });
  assert.deepEqual(own.files.map(row => row.path), ['SKILL.md', 'references/arcs.md']); assert.match(own.commit, /^[0-9a-f]{40}$/); assert.equal(own.sourceUrl, 'https://clawhub.ai/fixture/skills/story-method');
  assert.equal(own.licenseReview, 'no_license_declared_local_use');
  const aggregated = await c.acquire({ provider: 'clawhub', id: 'fixture/skills/research' });
  assert.equal(aggregated.subdirectory, 'skills/research'); assert.equal(aggregated.commit, f.commit); noRestApi(f);
});
test('whole-package deadline bounds a slow source and caller cancellation is preserved', async t => {
  const f = await marketplaceFixture(t, { delay: 30 }), c = client(f, { timeoutMs: 1000, acquisitionTimeoutMs: 10 });
  await c.search({ provider: 'skillsmp', query: 'research' });
  await assert.rejects(c.acquire({ provider: 'skillsmp', id: 'fixture-skills-research-skill-md' }), { code: 'marketplace_acquisition_timeout' });
  const controller = new AbortController(), reason = new Error('cancel package before dispatch'); controller.abort(reason);
  await assert.rejects(c.acquire({ provider: 'skillsmp', id: 'fixture-skills-research-skill-md' }, { signal: controller.signal }), error => error === reason);
});
