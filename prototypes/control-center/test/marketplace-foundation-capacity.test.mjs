import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { SkillMarketplaceService } from '../skill-marketplace-service.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { validateToolArguments } from '../../../packages/sdk/src/capabilities.mjs';
import { validateProjectGenome } from '../../../packages/sdk/src/project-genome.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';

// Real local HTTP catalog, pinned Git trees and complete source downloads. Each
// large package is individually legal; their aggregate is not. No real market,
// model, installation or production state participates in these contract tests.
const ids = ['design', 'review', 'research', 'delivery'];
const area = id => ({ id, description: `Cover the distinct ${id} capability with its documented original method.`, query: `${id} method` });
const entry = id => ({ provider: 'skills-sh', id: `fixture/skills/${id}` });
const digest = value => createHash('sha256').update(value).digest('hex');
const choice = id => ({ ...entry(id), capabilityIds: [id], reason: `The original ${id} package covers this project's separate capability.`, compatibility: 'Only text resources are consumed; this fixture requires no executable dependency.' });
async function call(author, name, args) {
  const tool = author.tools.find(row => row.name === name); validateToolArguments(tool.parameters, args);
  const result = await tool.execute(`capacity-${name}`, args, new AbortController().signal);
  return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
}
async function fixture(t, { smallDelivery = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-foundation-capacity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { LICENSE: 'MIT License\nCopyright fixture authors\n' };
  for (const id of ids) {
    files[`skills/${id}/SKILL.md`] = `---\nname: ${id}\ndescription: Apply the documented ${id} method when this capability is needed.\n---\nRead the numbered references as needed; retain their complete source bytes.\n`;
    for (let index = 0; index < 16; index++) files[`skills/${id}/references/${index}.md`] = smallDelivery && id === 'delivery' ? `Short ${id} reference ${index}.\n` : `${id}:${index}:`.padEnd(64000, 'x');
  }
  const tree = Object.entries(files).map(([path, content]) => ({ type: 'blob', mode: '100644', path, size: Buffer.byteLength(content), sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex') }));
  const http = await marketplaceFixture(t, { transform: (value, url) => {
    if (url.hostname === 'www.skills.sh') return { skills: ids.map(id => ({ id: `fixture/skills/${id}`, source: 'fixture/skills', skillId: id, name: id, installs: 1 })) };
    if (url.hostname === 'api.github.com' && !url.pathname.includes('/commits/')) return { truncated: false, tree };
    if (url.hostname === 'raw.githubusercontent.com') return files[url.pathname.split('/').slice(4).map(decodeURIComponent).join('/')];
    return value;
  } });
  const store = new Store(join(dir, 'state.json')), project = store.createProject({ name: 'Capacity fixture', workspace: dir }).project;
  const service = new SkillMarketplaceService(store, { client: new SkillMarketplaceClient({ fetchImpl: http.fetchImpl, git: http.git }) });
  const author = baseline => service.authoring(project.id, { purpose: 'foundation', baseline });
  const inspect = async (a, selection) => {
    assert.equal((await call(a, 'marketplace_search', { query: 'complementary methods', limit: 4, capabilityIds: selection })).isError, false);
    for (const id of selection) assert.equal((await call(a, 'marketplace_read', { ...entry(id), capabilityIds: [id] })).isError, false);
  };
  return { store, files, author, inspect };
}
function assertComplete(genome, files) {
  validateProjectGenome(genome);
  for (const skill of genome.skills.filter(row => row.source)) {
    assert.equal(skill.source.files.length, 18);
    assert.equal(skill.instructions, files[`${skill.source.subdirectory}/SKILL.md`]);
    for (const receipt of skill.source.files) {
      const expected = files[receipt.path === '@license/LICENSE' ? 'LICENSE' : `${skill.source.subdirectory}/${receipt.path}`];
      const actual = receipt.path === 'SKILL.md' ? skill.instructions : skill.resources.find(row => row.path === receipt.path).content;
      assert.equal(actual, expected); assert.equal(receipt.bytes, Buffer.byteLength(expected)); assert.equal(receipt.contentHash, digest(expected));
    }
  }
}
const defer = (author, id) => call(author, 'marketplace_skip', { capabilityIds: [id], reasonCode: 'unavailable', reason: 'The complete source package exceeded the recorded aggregate capacity; retain this gap without truncating or rewriting its source.' });

test('four individually valid 1 MB packages cannot poison foundation finalization, even when acquired concurrently', async t => {
  const f = await fixture(t), baseline = projectGenomeFixture(), author = f.author(baseline);
  assert.equal((await call(author, 'marketplace_plan', { capabilities: ids.map(area) })).isError, false); await f.inspect(author, ids);
  const results = await Promise.all(ids.map(id => call(author, 'marketplace_acquire', choice(id))));
  const accepted = ids.filter((_, index) => !results[index].isError), rejected = ids.filter((_, index) => results[index].isError);
  assert.equal(accepted.length, 2); assert.equal(rejected.length, 2);
  for (const id of rejected) assert.equal(results[ids.indexOf(id)].code, 'marketplace_bundle_limit');
  const before = author.snapshot(); assert.equal(before.packages.length, 2);
  for (const id of rejected) { assert.equal(before.coverage.find(row => row.id === id).status, 'pending'); assert.ok(before.failures.some(row => row.code === 'marketplace_bundle_limit' && row.capabilityIds.includes(id))); }
  assert.throws(() => author.policy.finalizeGenome(baseline), { code: 'marketplace_research_incomplete' });
  for (const id of rejected) assert.equal((await defer(author, id)).isError, false);
  const genome = author.policy.finalizeGenome(baseline); assertComplete(genome, f.files);
  assert.equal(genome.skills.filter(row => row.source).length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(genome.skills.filter(row => row.source))) < 2500000);
  assert.equal(author.snapshot().coverage.filter(row => row.status === 'deferred').length, 2);
  assert.equal(f.store.state.capabilities?.installations?.length ?? 0, 0);
});

test('retained source bytes count toward capacity, and a rejected package does not block a smaller relevant source', async t => {
  const f = await fixture(t, { smallDelivery: true }), baseline = projectGenomeFixture(), initial = f.author(baseline);
  await call(initial, 'marketplace_plan', { capabilities: ids.slice(0, 2).map(area) }); await f.inspect(initial, ids.slice(0, 2));
  for (const id of ids.slice(0, 2)) assert.equal((await call(initial, 'marketplace_acquire', choice(id))).isError, false);
  const retained = initial.policy.finalizeGenome(baseline), author = f.author(retained);
  await call(author, 'marketplace_plan', { capabilities: ids.map(area) });
  for (const skill of retained.skills.filter(row => row.source)) assert.equal((await call(author, 'marketplace_reuse', { existingSkillId: skill.id, capabilityIds: [skill.name], reason: 'This exact retained package already covers its distinct foundation capability.' })).isError, false);
  await f.inspect(author, ids.slice(2));
  assert.equal((await call(author, 'marketplace_acquire', choice('research'))).code, 'marketplace_bundle_limit');
  assert.equal(author.snapshot().packages.length, 0);
  assert.equal((await call(author, 'marketplace_acquire', choice('delivery'))).isError, false);
  assert.equal((await defer(author, 'research')).isError, false);
  const genome = author.policy.finalizeGenome(retained); assertComplete(genome, f.files);
  assert.equal(genome.skills.filter(row => row.source).length, 3);
  for (const skill of retained.skills) assert.deepEqual(genome.skills.find(row => row.id === skill.id), skill);
  assert.equal(author.snapshot().failures.filter(row => row.code === 'marketplace_bundle_limit').length, 1);
});
