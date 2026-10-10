import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { streamCompletion } from '../src/providers.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const evidence = [{ id: 'observed-source', summary: 'Completion was claimed without checking the actual boundary.' }];
const context = { schemaVersion: 1, evidence: [{ id: 'observed-source', content: 'The actual tool receipt reported an unresolved boundary.' }], files: [{ path: 'src/method.js', content: '0123456789'.repeat(20) }] };
const proposal = () => {
  const genome = projectGenomeFixture({ candidate: true }); delete genome.evaluationSuite;
  return { summary: 'Check completion against actual evidence', hypothesis: 'An explicit completion check prevents unchecked delivery claims.', diagnosis: { ...diagnosisFixture(), evidenceIds: ['observed-source'] }, changes: ['Require a completion check'], genome };
};
const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
const event = (response, data) => response.write(`data: ${JSON.stringify(data)}\n\n`);

async function authorEndpoint(t, final = 'json') {
  const calls = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.method, 'POST');
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); calls.push(body); const number = calls.length;
      assert.ok(number <= 6, 'One authoring run must not grow beyond its original six-request allowance');
      assert.equal(JSON.stringify(body).includes('WITHHELD_ORACLE'), false);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (number <= 5) {
        assert.ok(body.tools.some(tool => tool.function.name === 'learning_context_read'));
        assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined);
        event(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `source-page-${number}`, type: 'function', function: { name: 'learning_context_read', arguments: JSON.stringify({ id: 'file:src/method.js', offset: (number - 1) * 8, limit: 8 }) } }] }, finish_reason: null }] });
        event(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
      } else {
        assert.equal(body.tools?.length ?? 0, 0);
        assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none');
        const prompt = body.messages.find(row => row.role === 'system').content;
        assert.match(prompt, /five research requests followed by one reserved tool-free final response/);
        assert.match(prompt, /complete proposal JSON required above, not a prose research summary/);
        assert.match(prompt, /Tools are unavailable in this final response/);
        assert.doesNotMatch(prompt, /Summarize only facts established by the recorded conversation/);
        const contract = prompt.slice(prompt.lastIndexOf('Final response task:'));
        assert.match(contract, /Return exactly one complete proposal JSON object/);
        assert.match(contract, /hypothesis and genome describe unverified proposed interventions/);
        const schema = JSON.parse(contract.match(/Output schema:\n([^\n]+)/)?.[1] ?? 'null');
        assert.deepEqual(schema.required, ['summary', 'hypothesis', 'diagnosis', 'changes', 'genome']);
        const results = body.messages.filter(row => row.role === 'tool');
        assert.deepEqual(results.map(row => row.tool_call_id), [1, 2, 3, 4, 5].map(n => `source-page-${n}`));
        for (let index = 0; index < results.length; index++) assert.equal(JSON.parse(results[index].content).content, context.files[0].content.slice(index * 8, index * 8 + 8));
        const delta = final === 'tool_call' ? { tool_calls: [{ index: 0, id: 'forbidden-final-read', type: 'function', function: { name: 'learning_context_read', arguments: '{"id":"file:src/method.js"}' } }] }
          : final === 'empty' || final === 'cancel' ? {} : { content: final === 'length' ? '{"summary":"unfinished' : final === 'prose_dsml' ? `I have a candidate. <｜DSML｜tool_calls> ${JSON.stringify(proposal())}` : JSON.stringify(proposal()) };
        event(response, { choices: [{ index: 0, delta, finish_reason: null }] });
        event(response, { choices: [{ index: 0, delta: {}, finish_reason: final === 'tool_call' ? 'tool_calls' : final === 'length' ? 'length' : 'stop' }], usage });
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const model = { providerId: 'http-author-fixture', modelId: 'fixture', execution: 'rna', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off', compat: { supportsJsonObject: true, supportsToolChoiceNone: true } };
  const baseline = projectGenomeFixture(); baseline.evaluationSuite.cases[0].input = 'WITHHELD_ORACLE';
  return { calls, options: { project: { id: 'finalization' }, baseline, evidence, learningContext: context, model, maxAttempts: 1 } };
}

test('HTTP authoring reserves its sixth request for complete proposal JSON after five completed read batches', async t => {
  const app = await authorEndpoint(t), admissions = [], settlements = [], reads = [];
  const result = await proposeProjectGenome({ ...app.options, onProgress: row => { if (row.type === 'learning_context_read') reads.push(row); }, requestControl: { beforeRequest: row => admissions.push(row), onUsage: row => settlements.push(row) } });
  assert.equal(app.calls.length, 6); assert.equal(result.validation.passed, true); assert.equal(result.usage.totalTokens, 180);
  assert.equal(result.learningContextReads.length, 5); assert.equal(reads.length, 5); assert.deepEqual(reads.map(row => row.offset), [0, 8, 16, 24, 32]);
  assert.equal(admissions.length, 6); assert.deepEqual(settlements.map(row => row.id), admissions.map(row => row.id));
  assert.ok(settlements.every(row => row.usageReported && row.completed)); assert.deepEqual(result.proposal.genome.evaluationSuite, app.options.baseline.evaluationSuite);
  assert.ok(settlements.slice(0, 5).every(row => row.responseFormat === null && row.toolChoice === null)); assert.deepEqual(settlements[5].responseFormat, { type: 'json_object' }); assert.equal(settlements[5].toolChoice, 'none');
});

test('native JSON mode never licenses extracting a candidate from prose or DSML returned in violation of the requested contract', async t => {
  const app = await authorEndpoint(t, 'prose_dsml');
  await assert.rejects(proposeProjectGenome(app.options), failure => { assert.equal(failure.code, 'invalid_output'); assert.equal(failure.evolutionDiagnostic.kind, 'invalid_json'); assert.equal(failure.usage.totalTokens, 180); assert.equal(failure.learningContextReads.length, 5); return true; });
  assert.equal(app.calls.length, 6);
});

for (const final of ['tool_call', 'empty', 'length']) test(`HTTP authoring ${final} finalization remains an audited failure without replaying tools or adding another request`, async t => {
  const app = await authorEndpoint(t, final), settlements = [];
  await assert.rejects(proposeProjectGenome({ ...app.options, requestControl: { onUsage: row => settlements.push(row) } }), failure => {
    assert.equal(failure.code, final === 'tool_call' ? 'step_limit' : 'invalid_output'); assert.equal(failure.evolutionDiagnostic.phase, 'proposal');
    if (final !== 'tool_call') { assert.equal(failure.evolutionDiagnostic.kind, final === 'length' ? 'output_truncated' : 'empty_response'); assert.equal(failure.evolutionDiagnostic.stopReason, final === 'length' ? 'length' : 'stop'); assert.equal(failure.evolutionDiagnostic.responseDiagnostic.completed, true); }
    assert.equal(failure.learningContextReads.length, 5); assert.equal(failure.requests.length, 6); assert.equal(failure.usage.totalTokens, 180); return true;
  });
  assert.equal(app.calls.length, 6); assert.equal(settlements.length, 6);
});

test('authoring finalization admission rejection retains five paid reads and never dispatches or charges the sixth request', async t => {
  const app = await authorEndpoint(t), settlements = []; let admissions = 0;
  await assert.rejects(proposeProjectGenome({ ...app.options, requestControl: { beforeRequest: () => { if (++admissions === 6) throw Object.assign(new Error('Budget rejected'), { code: 'budget_exhausted' }); }, onUsage: row => settlements.push(row) } }), failure => {
    assert.equal(failure.code, 'budget_exhausted'); assert.equal(failure.learningContextReads.length, 5); assert.equal(failure.requests.length, 5); assert.equal(failure.usage.totalTokens, 150); return true;
  });
  assert.equal(admissions, 6); assert.equal(app.calls.length, 5); assert.equal(settlements.length, 5);
});

test('cancelling HTTP finalization preserves measured billing and completed reads without publishing a proposal', async t => {
  const app = await authorEndpoint(t, 'cancel'), controller = new AbortController(), settlements = [];
  const provider = async function* (request) {
    for await (const result of streamCompletion(request)) {
      yield result;
      if (!request.tools.length && result.type === 'usage') { controller.abort(Object.assign(new Error('Explicit fixture cancellation'), { code: 'cancelled' })); request.signal.throwIfAborted(); }
    }
  };
  await assert.rejects(proposeProjectGenome({ ...app.options, signal: controller.signal, provider, requestControl: { onUsage: row => settlements.push(row) } }), failure => {
    assert.equal(failure.code, 'cancelled'); assert.equal(failure.learningContextReads.length, 5); assert.equal(failure.usage.totalTokens, 180); assert.equal(failure.requests.length, 6); return true;
  });
  assert.equal(app.calls.length, 6); assert.equal(settlements.length, 6); assert.equal(settlements.at(-1).completed, false); assert.equal(settlements.at(-1).usageReported, true);
});
