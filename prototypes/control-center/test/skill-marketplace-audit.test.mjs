import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillMarketplaceService, referenceDiscoverySummary } from '../skill-marketplace-service.mjs';
import { SkillMarketplaceClient } from '../../../packages/sdk/src/skill-marketplaces.mjs';
import { marketplaceFixture } from '../../../packages/sdk/test/fixtures/skill-marketplace.mjs';
const store = { state: { projects: [{ id: 'p' }, { id: 'other' }] } };
const invoke = (author, name, args) => author.tools.find(row => row.name === name).execute('fixture', args);
test('authoring reads require its own successful discovery, not another project shared client cache', async t => {
  const f = await marketplaceFixture(t), service = new SkillMarketplaceService(store, { client: new SkillMarketplaceClient({ fetchImpl: f.fetchImpl, git: f.git }) });
  await service.search({ projectId: 'other', query: 'research' });
  const author = service.authoring('p'), input = { provider: 'skills-sh', id: 'fixture/skills/research' }, before = f.calls.length;
  assert.equal((await invoke(author, 'marketplace_read', input)).isError, true); assert.equal(f.calls.length, before);
  assert.equal(author.snapshot().failures[0].code, 'marketplace_search_required');
  await invoke(author, 'marketplace_search', { query: 'research' });
  assert.equal((await invoke(author, 'marketplace_read', input)).isError, undefined);
  const view = referenceDiscoverySummary(author.snapshot()); assert.equal(view.searches, 1); assert.equal(view.filesRead, 1); assert.equal(view.failures.length, 1); assert.equal(view.installed, false);
  assert.equal(view.sources[0].commit, f.commit); assert.equal(view.sources[0].content, undefined); assert.equal(view.sources[0].installInput, undefined);
});
test('failed source requests are bounded separate receipts and cannot masquerade as completed searches or leak error bodies', async () => {
  const secret = 'private-provider-response', client = { search: async () => { throw Object.assign(new Error(secret), { code: secret.repeat(100) }); } }, service = new SkillMarketplaceService(store, { client }), author = service.authoring('p');
  for (let i = 0; i < 30; i++) await invoke(author, 'marketplace_search', { query: 'research' });
  const snapshot = author.snapshot(); assert.equal(snapshot.searches.length, 0); assert.equal(snapshot.references.length, 0); assert.equal(snapshot.failures.length, 16);
  assert.doesNotMatch(JSON.stringify(referenceDiscoverySummary(snapshot)), /private-provider/);
  snapshot.failures[0].code = 'modified'; assert.notEqual(author.snapshot().failures[0].code, 'modified');
});
test('cancellation has an aborted audit receipt while preserving cancellation semantics', async () => {
  const controller = new AbortController(), reason = new Error('cancel fixture'), client = { search: async () => { controller.abort(reason); throw reason; } }, service = new SkillMarketplaceService(store, { client }), author = service.authoring('p');
  await assert.rejects(author.tools.find(row => row.name === 'marketplace_search').execute('fixture', { query: 'research' }, controller.signal), error => error === reason);
  assert.equal(author.snapshot().failures[0].code, 'aborted'); assert.equal(author.snapshot().searches.length, 0);
});
