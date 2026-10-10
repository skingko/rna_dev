import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4000 };
const evidence = [{ id: 'work', summary: 'A retained development receipt with no claimed quality verdict.' }];
const stop = { decision: 'no_change', abstention: { reason: 'no_method_gap', summary: 'No reusable method change is established by the retained evidence.', explanation: 'This bounded work receipt does not establish a method defect; a later independent failure may justify a new intervention.', evidenceIds: ['work'], revisitWhen: [{ condition: 'reproduced_failure', description: 'Revisit when a new project execution demonstrates a reproducible method failure.' }] } };
const base = extra => ({ project: {}, baseline: projectGenomeFixture(), evidence, model, allowAbstention: true, maxAttempts: 3, ...extra });
const feedback = () => ({ feedback: [{ source: 'host:foundation', text: 'The project foundation still needs the bounded source inspection already requested; continue within this existing attempt.' }] });
const summary = extra => ({ searches: [], references: [], failures: [], packages: [], disposition: null, ...extra });
const tool = execute => ({ name: 'marketplace_search', description: 'Read bounded public capability metadata.', effect: 'read', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, execute });
function providerFor(next, calls = []) { return async function* (request) {
  calls.push(request); const value = await next(request, calls.length);
  if (value.tool) yield { type: 'tool_call', id: `call-${calls.length}`, name: value.tool, arguments: value.args ?? { query: 'research' } };
  else yield { type: 'text_delta', delta: JSON.stringify(value.output ?? stop) };
  yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } };
  yield { type: 'done', stopReason: value.tool ? 'toolUse' : 'stop' };
}; }

test('host foundation feedback continues an early stop inside the actual SDK author loop, then reconfirms it', async () => {
  const state = summary(), calls = [], reviews = []; let searches = 0;
  const result = await proposeProjectGenome(base({
    provider: providerFor((_request, n) => n === 2 ? { tool: 'marketplace_search' } : {}, calls),
    referenceTools: [tool(async () => { searches++; state.searches.push({ provider: 'skills-sh', results: [], coverage: { status: 'empty' } }); return { content: [{ type: 'text', text: '{"results":[],"coverage":{"status":"empty"}}' }] }; })],
    referencePolicy: { snapshot: () => state, async beforeNoChange(input) { reviews.push(input.stage); assert.equal(input.abstention.reason, 'no_method_gap'); if (!searches) return feedback(); } }
  }));
  assert.equal(result.status, 'no_change'); assert.equal(calls.length, 3); assert.equal(searches, 1);
  assert.deepEqual(reviews, ['before_finish', 'before_finish', 'finalize']);
  assert.ok(calls[1].messages.some(message => message.source === 'finish-feedback'));
  assert.equal(result.usage.totalTokens, 90); assert.equal(result.referenceDiscovery.outcome, 'empty');
  assert.equal(result.referenceDiscovery.counts.searches, 1); assert.equal(result.validation, null);
});

test('an already sufficient foundation can stop without marketplace calls or an extra model request', async () => {
  const reviews = [], calls = []; let searches = 0, oldFinish = 0;
  const result = await proposeProjectGenome(base({ provider: providerFor(() => ({}), calls), referenceTools: [tool(async () => { searches++; return { content: [] }; })],
    referencePolicy: { beforeFinish() { oldFinish++; return feedback(); }, beforeNoChange({ stage }) { reviews.push(stage); }, snapshot: () => summary({ disposition: { status: 'existing_package_reused', skillId: 'existing', packageHash: 'a'.repeat(64) } }) }
  }));
  assert.equal(result.status, 'no_change'); assert.equal(calls.length, 1); assert.equal(searches, 0); assert.equal(oldFinish, 0);
  assert.deepEqual(reviews, ['before_finish', 'finalize']); assert.equal(result.referenceDiscovery.outcome, 'existing_reused');
});

test('a reserved tool-free final stop cannot bypass unfinished foundation and never buys another author attempt', async () => {
  const calls = [], reviews = [];
  await assert.rejects(proposeProjectGenome(base({ provider: providerFor(() => ({}), calls), referenceTools: [tool(async () => ({ content: [] }))],
    referencePolicy: { beforeNoChange({ stage }) { reviews.push(stage); return feedback(); }, snapshot: () => summary() }
  })), error => {
    assert.equal(error.code, 'reference_no_change_incomplete'); assert.equal(error.requests.length, 6); assert.equal(error.usage.totalTokens, 180);
    assert.equal(error.referenceDiscovery.outcome, 'not_attempted'); return true;
  });
  assert.equal(calls.length, 6); assert.equal(calls.at(-1).tools.length, 0);
  assert.deepEqual(reviews, [...Array(5).fill('before_finish'), 'finalize']);
});

test('the same final host check covers direct no-tool SDK calls', async () => {
  const calls = [], stages = [];
  await assert.rejects(proposeProjectGenome(base({ provider: providerFor(() => ({}), calls), referencePolicy: { beforeNoChange({ stage }) { stages.push(stage); return feedback(); }, snapshot: () => summary() } })), { code: 'reference_no_change_incomplete' });
  assert.equal(calls.length, 1); assert.deepEqual(stages, ['finalize']);
});

test('a policy error is not swallowed as an allowed stop or ordinary proposal finish', async () => {
  let ordinary = 0; const calls = [];
  await assert.rejects(proposeProjectGenome(base({ provider: providerFor(() => ({}), calls), referenceTools: [tool(async () => ({ content: [] }))],
    referencePolicy: { beforeNoChange() { throw Object.assign(new Error('Host policy unavailable'), { code: 'host_policy_unavailable' }); }, beforeFinish() { ordinary++; }, snapshot: () => summary() }
  })), error => { assert.equal(error.code, 'host_policy_unavailable'); assert.equal(error.requests.length, 1); assert.equal(error.referenceDiscovery.outcome, 'not_attempted'); return true; });
  assert.equal(calls.length, 1); assert.equal(ordinary, 0);
});

test('failed source lookup remains visible when a justified stop is allowed, without retrying the outage', async () => {
  const state = summary(), calls = [];
  const result = await proposeProjectGenome(base({ provider: providerFor((_request, n) => n === 1 ? { tool: 'marketplace_search' } : {}, calls),
    referenceTools: [tool(async () => { state.failures.push({ operation: 'marketplace_search', provider: 'skills-sh', code: 'marketplace_rate_limit', message: 'PRIVATE_FAILURE_BODY' }); return { isError: true, content: [{ type: 'text', text: '{"code":"marketplace_rate_limit"}' }] }; })],
    referencePolicy: { beforeNoChange() {}, snapshot: () => state }
  }));
  assert.equal(result.status, 'no_change'); assert.equal(calls.length, 2); assert.equal(result.referenceDiscovery.outcome, 'failed');
  assert.equal(result.referenceDiscovery.failures[0].code, 'marketplace_rate_limit');
  assert.equal(result.usage.totalTokens, 60); assert.equal(JSON.stringify(result.referenceDiscovery).includes('PRIVATE_FAILURE_BODY'), false);
});

test('discovery receipts distinguish true empty search, explicit incompatibility and unsupported coverage', async () => {
  for (const [state, expected] of [
    [summary(), 'not_attempted'],
    [summary({ searches: [{ provider: 'skills-sh', results: [], skippedUnsupported: 0, coverage: { status: 'empty' } }] }), 'empty'],
    [summary({ searches: [{ results: [] }], disposition: { status: 'no_package_selected', reason: 'PRIVATE_REASON' } }), 'no_package_selected'],
    [summary({ searches: [{ results: [], skippedUnsupported: 1 }], disposition: { status: 'no_package_selected' } }), 'incomplete'],
    [summary({ searches: [{ results: [], coverage: { status: 'unsupported' } }] }), 'incomplete'],
    [summary({ searches: [{ results: [{ id: 'some' }], coverage: { status: 'partial' } }] }), 'incomplete'],
    [summary({ searches: [{ results: [] }], failures: [{ operation: 'marketplace_read', code: 'marketplace_http' }], disposition: { status: 'no_package_selected' } }), 'failed']
  ]) {
    const result = await proposeProjectGenome(base({ provider: providerFor(() => ({})), referencePolicy: { snapshot: () => state } }));
    assert.equal(result.referenceDiscovery.outcome, expected); assert.equal(result.referenceDiscovery.installed, false);
    assert.equal(JSON.stringify(result.referenceDiscovery).includes('PRIVATE_REASON'), false);
  }
});

test('only compact host metadata is retained; source bodies and model justifications never enter discovery receipts', async () => {
  const secret = 'PRIVATE_SOURCE_BODY';
  const state = summary({
    searches: Array.from({ length: 18 }, () => ({ provider: 'skills-sh', query: secret, results: [{ id: secret }], skippedUnsupported: 0 })),
    references: Array.from({ length: 34 }, () => ({ provider: 'skills-sh', id: 'owner/repo/skill', commit: 'a'.repeat(40), contentHash: 'b'.repeat(64), content: secret, resources: [{ content: secret }] })),
    packages: [{ skillId: 'source_skill', provider: 'skills-sh', id: 'owner/repo/skill', packageHash: 'c'.repeat(64), reason: secret, compatibility: secret, files: [{ content: secret }] }],
    failures: [{ operation: 'marketplace_read', code: 'marketplace_http', message: secret }]
  });
  // The existing context callback still supplies the author input. Only the
  // terminal public receipt gives policy.snapshot precedence over that view.
  const result = await proposeProjectGenome(base({ provider: providerFor(() => ({})), referencePolicy: { snapshot: () => state }, referenceContext: () => summary() }));
  const receipt = result.referenceDiscovery;
  assert.equal(receipt.outcome, 'acquired'); assert.equal(receipt.counts.failures, 1); assert.equal(receipt.counts.searches, 18);
  assert.equal(receipt.searches.length, 16); assert.equal(receipt.sources.length, 32); assert.equal(receipt.omitted.sources, 2); assert.equal(receipt.omitted.searches, 2);
  assert.equal(JSON.stringify(receipt).includes(secret), false); state.packages[0].packageHash = 'd'.repeat(64); assert.equal(receipt.packages[0].packageHash, 'c'.repeat(64));
});

test('normal candidate and provider failure use the same discovery projection and retain their own outcome', async () => {
  const state = summary({ failures: [{ operation: 'marketplace_search', code: 'marketplace_timeout' }] });
  const good = await proposeProjectGenome(base({ provider: genomeEvaluationProvider(), referenceContext: () => state }));
  assert.equal(good.validation.passed, true); assert.equal(good.referenceDiscovery.outcome, 'failed');
  const badProvider = async function* () { yield { type: 'usage', usage: { totalTokens: 12 } }; yield { type: 'error', error: 'provider failure' }; };
  await assert.rejects(proposeProjectGenome(base({ provider: badProvider, referenceContext: () => state })), error => {
    assert.equal(error.code, 'provider_error'); assert.equal(error.usage.totalTokens, 12); assert.deepEqual(error.referenceDiscovery, good.referenceDiscovery); return true;
  });
});

test('invalid options and broken baseline retain discovery without invoking a provider', async () => {
  const referenceContext = () => summary({ failures: [{ operation: 'marketplace_read', code: 'marketplace_http' }] }); let requests = 0;
  const provider = async function* () { requests++; };
  for (const extra of [{ allowAbstention: 'invalid' }, { baseline: { ...projectGenomeFixture(), tools: [{ ...projectGenomeFixture().tools[0], script: 'throw new Error("Broken");' }] } }]) {
    await assert.rejects(proposeProjectGenome(base({ ...extra, provider, referenceContext })), error => { assert.equal(error.referenceDiscovery.outcome, 'failed'); return true; });
  }
  assert.equal(requests, 0);
});

test('snapshot failure cannot replace a valid stop or an original provider error', async () => {
  const policy = { snapshot() { throw new Error('PRIVATE_SNAPSHOT_ERROR'); } };
  const result = await proposeProjectGenome(base({ provider: providerFor(() => ({})), referencePolicy: policy }));
  assert.equal(result.status, 'no_change'); assert.equal(result.referenceDiscovery.outcome, 'unavailable');
  await assert.rejects(proposeProjectGenome(base({ provider: async function* () { yield { type: 'error', error: 'provider error' }; }, referencePolicy: policy })), error => { assert.equal(error.code, 'provider_error'); assert.equal(error.referenceDiscovery.outcome, 'unavailable'); assert.equal(JSON.stringify(error.referenceDiscovery).includes('PRIVATE'), false); return true; });
});

test('generic author context and malformed snapshots are unknown rather than false not-attempted evidence', async () => {
  for (const value of [{ publicCatalog: [] }, { ...summary(), searches: 3 }, null]) {
    const result = await proposeProjectGenome(base({ provider: providerFor(() => ({})), referenceContext: () => value }));
    assert.equal(result.status, 'no_change'); assert.equal(result.referenceDiscovery.outcome, 'unavailable'); assert.equal(result.referenceDiscovery.snapshotAvailable, false);
  }
});

test('invalid final hook responses fail closed without retry or fabricated approval', async () => {
  for (const invalid of [null, false, { feedback: [] }, { feedback: [{ source: 'x', text: '' }] }]) {
    const calls = [];
    await assert.rejects(proposeProjectGenome(base({ provider: providerFor(() => ({}), calls), referencePolicy: { beforeNoChange: () => invalid } })), { code: 'invalid_reference_review' });
    assert.equal(calls.length, 1);
  }
});

test('cancellation during final host review is preserved with the complete metered receipt', async () => {
  const controller = new AbortController(), reason = new Error('cancel host review');
  await assert.rejects(proposeProjectGenome(base({ signal: controller.signal, provider: providerFor(() => ({})), referencePolicy: { beforeNoChange() { controller.abort(reason); }, snapshot: () => summary() } })), error => {
    assert.equal(error, reason); assert.equal(error.requests.length, 1); assert.equal(error.usage.totalTokens, 30); assert.equal(error.referenceDiscovery.outcome, 'not_attempted'); return true;
  });
});
