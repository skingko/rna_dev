import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProjectEvaluationCase, evaluateProjectGenomes } from '../src/project-evolution.mjs';
import { createBrowserEvaluationAdapter } from '../src/project-evaluation-browser-adapter.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096 };
function genome(candidate = false) {
  const value = projectGenomeFixture({ candidate }); value.tools = [];
  value.evaluationSuite.cases = [1, 2, 3].map(n => ({ id: 'browser_' + n, input: 'Create index.html containing a counter initially 0, an Add button and a heading. Clicking Add increments the counter by exactly one. Deliver a local self-contained page and summarize evidence.', requiredTerms: ['evidence'], forbiddenTerms: [], requiredToolIds: ['project_write'], weight: 1,
    workspace: { files: [], checks: [{ id: 'html', kind: 'file_exists', path: 'index.html' }] },
    environment: { kind: 'browser', entry: 'index.html', viewport: { width: 800, height: 600 }, steps: [{ id: 'button', kind: 'click', selector: '#add' }, { id: 'counter', kind: 'assert_text', selector: '#count', expected: '1' }], screenshot: true }
  }));
  return value;
}
function provider(calls, wrong = false) {
  return async function* (request) {
    calls.push(request);
    assert.ok(!request.messages.some(message => JSON.stringify(message).includes('"selector":"#count"')), 'Frozen browser selectors are withheld');
    assert.ok(!request.systemPrompt.includes('"expected":"1"'), 'Frozen oracle is withheld');
    if (!request.messages.some(message => message.role === 'toolResult')) {
      yield { type: 'tool_call', id: 'create-page', name: 'project_write', arguments: { path: 'index.html', expectedHash: null, content: '<h1>Counter</h1><output id="count">0</output><button id="add" onclick="document.querySelector(\'#count\').textContent=' + (wrong ? 2 : 1) + '">Add</button>' } };
      yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    yield { type: 'text_delta', delta: 'Implemented the counter; actual artifact evidence is available.' }; yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
  };
}

test('SDK evaluation executes model protocol fixture, actual file tool and real Chromium against a withheld browser oracle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rna-browser-integration-')), calls = [];
  try {
    const result = await executeProjectEvaluationCase({ genome: genome(), caseId: 'browser_1', model, provider: provider(calls), environmentAdapters: { browser: createBrowserEvaluationAdapter({ artifactDirectory: join(root, 'receipts') }) } });
    assert.equal(result.result.passed, true); assert.equal(result.result.workspace.passed, true); assert.equal(result.result.environment.passed, true);
    assert.equal(result.result.environment.checks.length, 2); assert.equal(result.result.environment.screenshot.retained, true);
    assert.match(result.result.environment.screenshot.path, /browser_1-case/);
    assert.equal((await readFile(result.result.environment.screenshot.path)).subarray(1, 4).toString(), 'PNG');
    assert.equal(calls.length, 2); assert.equal(result.promotionEligible, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SDK browser check rejects a completed answer with a present but behaviorally wrong artifact', async () => {
  const calls = [], result = await executeProjectEvaluationCase({ genome: genome(), caseId: 'browser_1', model, provider: provider(calls, true), environmentAdapters: { browser: createBrowserEvaluationAdapter() } });
  assert.equal(result.result.checks.completed, true); assert.equal(result.result.workspace.passed, true);
  assert.equal(result.result.environment.passed, false); assert.equal(result.result.passed, false); assert.equal(result.result.environment.checks[1].observed.text, '2');
});

test('SDK missing browser adapter or missing browser binary consumes zero model requests', async () => {
  for (const environmentAdapters of [{}, { browser: createBrowserEvaluationAdapter({ executablePath: '/missing/browser' }) }]) {
    const calls = [];
    await assert.rejects(executeProjectEvaluationCase({ genome: genome(), caseId: 'browser_1', model, provider: provider(calls), environmentAdapters }), { code: 'environment_unavailable' });
    assert.equal(calls.length, 0);
    await assert.rejects(evaluateProjectGenomes({ baseline: genome(), candidate: genome(true), model, provider: provider(calls), environmentAdapters }), { code: 'environment_unavailable' });
    assert.equal(calls.length, 0);
  }
});

test('paired blind visual judge receives actual screenshot pixels without side-labelled host paths while persisted receipts keep images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rna-browser-blind-')), calls = [], judgments = [];
  const ordinary = provider(calls);
  try {
    const result = await evaluateProjectGenomes({ baseline: genome(), candidate: genome(true), model: { ...model, input: ['text', 'image'] }, environmentAdapters: { browser: createBrowserEvaluationAdapter({ artifactDirectory: join(root, 'receipts') }) }, provider: async function* (request) {
      if (request.systemPrompt.includes('blind evaluator')) {
        const input = JSON.parse(request.messages[0].content[0].text); judgments.push(input);
        const images = request.messages[0].content.filter(part => part.type === 'image');
        assert.equal(images.length, 2); assert.equal(input.hostContext.visualEvidence.status, 'provided_to_visual_judge');
        for (const side of ['left', 'right']) {
          assert.equal(Object.hasOwn(input[side].environment.screenshot, 'path'), false);
          assert.equal(input[side].environment.screenshot.retained, true);
          assert.match(input[side].environment.screenshot.hash, /^[a-f0-9]{64}$/);
          assert.equal(JSON.stringify(input[side].environment).includes(root), false);
          const pixels = Buffer.from(images[side === 'left' ? 0 : 1].data, 'base64');
          assert.equal(pixels.subarray(1, 4).toString(), 'PNG'); assert.equal(pixels.length, input[side].environment.screenshot.bytes);
          assert.equal(pixels.readUInt32BE(16), 800); assert.equal(pixels.readUInt32BE(20), 600);
        }
        const ratings = { ratings: input.criteria.map(row => ({ criterionId: row.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'Frozen behavior passed; compare concise evidence explanation.' })) };
        yield { type: 'tool_call', id: 'ratings-' + judgments.length, name: 'submit_evaluation_ratings', arguments: ratings };
        yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      for await (const event of ordinary(request)) {
        if (event.type === 'text_delta' && request.systemPrompt.includes('CANDIDATE_AGENT')) yield { ...event, delta: 'precise evidence: implemented the counter.' };
        else yield event;
      }
    } });
    assert.equal(judgments.length, 3); assert.equal(result.details.length, 3);
    assert.equal(result.coverage.visualJudgedCases, 3); assert.equal(result.coverage.visualQuality, 'not_verified');
    for (const row of result.details) for (const side of ['baseline', 'candidate']) {
      const shot = row[side].environment.screenshot;
      assert.equal(shot.retained, true); assert.ok(shot.path.startsWith(await realpath(root))); assert.ok(shot.path.includes(row.id + '-' + side));
      assert.equal((await readFile(shot.path)).subarray(1, 4).toString(), 'PNG');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
