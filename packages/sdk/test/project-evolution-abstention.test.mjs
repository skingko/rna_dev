import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000 };
const evidence = [{ id: 'receipt-one', summary: 'The checked artifact already implements the requested procedure.' }];
const noChange = (reason = 'no_method_gap') => ({ decision: 'no_change', abstention: {
  reason, summary: 'The inspected result does not establish a reusable method defect.',
  explanation: 'The supplied work receipt already verifies the requested operation; creating a new procedure would not address a demonstrated capability gap.',
  evidenceIds: reason === 'no_method_gap' ? ['receipt-one'] : [],
  revisitWhen: [{ condition: 'reproduced_failure', description: 'A new work receipt shows this procedure failing on a different ordinary project task.' }]
} });
function providerFor(output, { calls = [], afterOutput } = {}) { return async function* (request) {
  calls.push(request); yield { type: 'text_delta', delta: JSON.stringify(typeof output === 'function' ? output(calls.length) : output) };
  if (afterOutput) yield* afterOutput();
  yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
}; }
const options = overrides => ({ project: {}, baseline: projectGenomeFixture(), evidence, model, allowAbstention: true, ...overrides });

test('an evidence-based author stop is terminal without a genome, paired request or fabricated pass', async () => {
  const calls = [], events = [], original = projectGenomeFixture(), before = structuredClone(original);
  const result = await proposeProjectGenome(options({ baseline: original, provider: providerFor(noChange(), { calls }), onProgress: event => events.push(event) }));
  assert.equal(result.status, 'no_change'); assert.equal(result.attempts, 1); assert.equal(calls.length, 1);
  assert.equal(result.proposal, undefined); assert.equal(result.validation, null); assert.equal(result.requests.length, 1); assert.equal(result.usage.totalTokens, 30);
  assert.deepEqual(result.abstention, noChange().abstention); assert.deepEqual(original, before);
  assert.equal(events.filter(row => row.type === 'proposal_abstained').length, 1);
  assert.equal(events.some(row => row.type === 'proposal_validation' || row.type === 'proposal_search_review'), false);
});

test('missing evidence can justify uncertainty but cannot prove absence of a method gap', async () => {
  const result = await proposeProjectGenome(options({ evidence: [], provider: providerFor(noChange('insufficient_evidence')) }));
  assert.equal(result.status, 'no_change'); assert.deepEqual(result.abstention.evidenceIds, []);
  const invalid = noChange(); invalid.abstention.evidenceIds = [];
  await assert.rejects(proposeProjectGenome(options({ evidence: [], maxAttempts: 1, provider: providerFor(invalid) })), error => error.code === 'invalid_output' && /requires a supplied evidence/.test(error.message));
});

test('legacy callers still require a candidate and reject the new stop envelope', async () => {
  for (const allowAbstention of [undefined, false]) {
    const calls = [];
    await assert.rejects(proposeProjectGenome(options({ allowAbstention, maxAttempts: 1, provider: providerFor(noChange(), { calls }) })), { code: 'invalid_output' });
    assert.equal(calls.length, 1);
  }
  const result = await proposeProjectGenome(options({ provider: genomeEvaluationProvider() }));
  assert.equal(result.status, undefined); assert.equal(result.validation.passed, true); assert.ok(result.proposal.genome);
});

test('author stops reject unknown citations, contradictory payloads, unsupported reasons and invented schedules', async () => {
  const values = [noChange(), noChange(), noChange(), noChange(), noChange()];
  values[0].abstention.evidenceIds = ['invented'];
  values[1].genome = projectGenomeFixture();
  values[2].abstention.reason = 'provider_error';
  values[3].abstention.revisitWhen[0].nextRunAt = '2030-01-01';
  values[4].abstention.revisitWhen = [];
  for (const value of values) await assert.rejects(proposeProjectGenome(options({ maxAttempts: 1, provider: providerFor(value) })), { code: 'invalid_output' });
});

test('a repaired abstention retains failed author attempts and all usage', async () => {
  const invalid = noChange(); invalid.abstention.evidenceIds = ['invented'];
  const result = await proposeProjectGenome(options({ maxAttempts: 2, provider: providerFor(attempt => attempt === 1 ? invalid : noChange()) }));
  assert.equal(result.status, 'no_change'); assert.equal(result.attempts, 2); assert.equal(result.requests.length, 2); assert.equal(result.usage.totalTokens, 60);
  assert.equal(result.repairEvidence.length, 1); assert.equal(result.repairEvidence[0].error.code, 'invalid_output');
});

test('a valid no-candidate judgment does not buy irrelevant marketplace research or finalize a package', async () => {
  let finishes = 0, finalized = 0, searches = 0;
  const result = await proposeProjectGenome(options({ provider: providerFor(noChange()),
    referenceTools: [{ name: 'marketplace_search', description: 'Read public references.', parameters: { type: 'object', properties: {} }, effect: 'read', execute: async () => { searches++; return { content: [] }; } }],
    referencePolicy: { beforeFinish: () => { finishes++; return { feedback: [{ source: 'market', text: 'Search before making a candidate.' }] }; }, finalizeGenome: genome => { finalized++; return genome; } }
  }));
  assert.equal(result.status, 'no_change'); assert.equal(result.requests.length, 1); assert.equal(finishes, 0); assert.equal(finalized, 0); assert.equal(searches, 0);
});

test('an ordinary candidate retains the original reference finalization policy with abstention enabled', async () => {
  let finalized = 0;
  const result = await proposeProjectGenome(options({ provider: genomeEvaluationProvider(), referencePolicy: { finalizeGenome: genome => { finalized++; return genome; } } }));
  assert.equal(result.validation.passed, true); assert.equal(finalized, 1);
});

test('a provider failure after a stop-looking draft remains a metered failure', async () => {
  const provider = providerFor(noChange(), { afterOutput: async function* () { yield { type: 'error', error: 'connection failed' }; } });
  await assert.rejects(proposeProjectGenome(options({ provider })), error => {
    assert.equal(error.code, 'provider_error'); assert.equal(error.requests.length, 1); assert.equal(error.abstention, undefined); return true;
  });
});

test('an invalid opt-in and a broken released baseline cannot be disguised as an author judgment', async () => {
  let calls = 0; const provider = async function* () { calls++; };
  await assert.rejects(proposeProjectGenome(options({ allowAbstention: 'yes', provider })), { code: 'invalid_options' });
  const baseline = projectGenomeFixture(); baseline.tools[0].script = 'throw new Error("broken baseline");';
  await assert.rejects(proposeProjectGenome(options({ baseline, provider })), { code: 'baseline_contract_failed' });
  assert.equal(calls, 0);
});

test('the reserved sixth author request can abstain while retaining five actual source-read receipts', async () => {
  const calls = [], context = { schemaVersion: 1, evidence: [{ id: 'receipt-one', content: 'A checked execution receipt, not a new user request.' }], files: [{ path: 'method.md', content: 'An ordinary retained method source.'.repeat(20) }] };
  const result = await proposeProjectGenome(options({ learningContext: context, maxAttempts: 1, provider: async function* (request) {
    calls.push(request);
    if (calls.length <= 5) {
      yield { type: 'tool_call', id: `read-${calls.length}`, name: 'learning_context_read', arguments: { id: 'file:method.md', offset: (calls.length - 1) * 8, limit: 8 } };
      yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' };
    } else {
      assert.equal(request.tools.length, 0); assert.match(request.systemPrompt, /allowed no_change envelope is a complete final artifact/);
      yield { type: 'text_delta', delta: JSON.stringify(noChange()) };
      yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
    }
  } }));
  assert.equal(result.status, 'no_change'); assert.equal(calls.length, 6); assert.equal(result.requests.length, 6); assert.equal(result.learningContextReads.length, 5);
  assert.equal(result.usage.totalTokens, 180); assert.equal(result.proposal, undefined); assert.equal(result.validation, null);
});
