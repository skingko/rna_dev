import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectLearningContext, validateProjectLearningContext, LEARNING_CONTEXT_LIMITS } from '../src/learning-context.mjs';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const evidence = [{ id: 'turn:one', summary: 'The first successful tool output did not settle the complete task.' }];
const source = () => ({ schemaVersion: 1, evidence: [{ id: evidence[0].id, content: JSON.stringify({ tool: 'project_edit', status: 'failed', output: 'oldText matched twice', workerClaim: 'The update is done.' }) }], files: [{ path: 'src/main.js', content: 'const original = "captured source";\nconst other = 2;' }] });
const decoded = result => JSON.parse(result.content[0].text);

test('frozen readers page actual admitted source bytes and receipt hashes without live workspace access', async () => {
  const original = source(), receipts = [], context = createProjectLearningContext(original, evidence, { onRead: row => receipts.push(row) });
  original.files[0].content = 'changed live source';
  const index = decoded(await context.tools[0].execute('list', {}));
  assert.equal(index.records.length, 2); assert.equal(index.records.some(row => 'content' in row), false);
  const first = decoded(await context.tools[1].execute('read', { id: 'file:src/main.js', limit: 8 }));
  const second = decoded(await context.tools[1].execute('next', { id: first.id, offset: first.nextOffset }));
  assert.equal(first.content + second.content, source().files[0].content); assert.equal(second.nextOffset, null);
  assert.equal(receipts.length, 2); assert.equal(receipts[0].contentHash, first.contentHash); assert.equal(receipts[0].contextHash, context.contextHash);
  assert.equal(context.tools.every(tool => tool.permission === 'read' && tool.effect === 'read' && tool.idempotent), true);
  assert.throws(() => { context.snapshot.files[0].content = 'mutated'; }, TypeError);
  assert.throws(() => { context.inventory[0].id = 'mutated'; }, TypeError);
  await assert.rejects(context.tools[1].execute('private', { id: 'file:.env' }), { code: 'invalid_learning_context' });
  await assert.rejects(context.tools[1].execute('past-end', { id: first.id, offset: 999 }), { code: 'invalid_learning_context' });
  await assert.rejects(context.tools[1].execute('large-page', { id: first.id, limit: LEARNING_CONTEXT_LIMITS.pageChars + 1 }));
  assert.equal(receipts.length, 2, 'Denied reads are never recorded as successful source reads');
});

test('canonical identity changes with actual source bytes and not array order', () => {
  const value = source(); value.files.push({ path: 'README.md', content: 'Instructions' });
  const first = createProjectLearningContext(value, evidence); value.files.reverse(); assert.equal(createProjectLearningContext(value, evidence).contextHash, first.contextHash);
  value.files[0].content += ' changed'; assert.notEqual(createProjectLearningContext(value, evidence).contextHash, first.contextHash);
});
test('common scoped packages and filesystem routes remain valid source identities without becoming path access', async () => {
  const value = source(); value.files = ['src/(app)/[slug]/page.tsx', 'src/@types/environment.d.ts', 'docs/设计 (v2).md'].map(path => ({ path, content: `Source for ${path}` }));
  const context = createProjectLearningContext(value, evidence);
  for (const file of value.files) assert.equal(decoded(await context.tools[1].execute('read', { id: `file:${file.path}` })).content, file.content);
});

test('learning snapshots reject unknown evidence, duplicate records, private paths and overlarge UTF-8 bodies', () => {
  const bad = value => assert.throws(() => validateProjectLearningContext(value, evidence), { code: 'invalid_learning_context' });
  for (const path of ['../outside', '/tmp/private', 'C:/private', 'src\\private', 'src/\nprivate', 'x/.env.production', '.state/state.json', '.git/config', 'keys/private.pem', 'state.json.evolution/candidate/proposal.json', 'frozen-evaluation.json']) { const value = source(); value.files[0].path = path; bad(value); }
  let value = source(); value.evidence[0].id = 'invented'; bad(value);
  value = source(); value.evidence.push({ ...value.evidence[0] }); bad(value);
  value = source(); value.files.push({ ...value.files[0] }); bad(value);
  value = source(); value.files[0].content = '中'.repeat(43000); bad(value);
  value = source(); value.files = Array.from({ length: 9 }, (_, i) => ({ path: `file-${i}.txt`, content: 'x'.repeat(128000) })); bad(value);
  value = source(); value.files[0].content = 'a\0b'; bad(value);
});

test('real SDK authoring loop reads the frozen tool failure and source; hidden evaluation data is never exposed', async () => {
  const baseline = projectGenomeFixture(), candidate = projectGenomeFixture({ candidate: true });
  baseline.evaluationSuite.cases[0].input = 'HIDDEN_ORACLE_INPUT';
  baseline.tools[0].smokeCases[0].input = { value: 123 }; baseline.tools[0].smokeCases[0].expected = { doubled: 246 };
  candidate.evaluationSuite = undefined;
  const calls = [], events = [], context = source(), model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 4096 };
  const provider = async function* (request) {
    calls.push(request);
    assert.equal(JSON.stringify(request).includes('HIDDEN_ORACLE_INPUT'), false);
    assert.equal(request.tools.some(tool => ['project_exec', 'project_write', 'project_read'].includes(tool.name)), false);
    if (!request.messages.some(message => message.role === 'toolResult')) {
      const input = JSON.parse(request.messages[0].content[0].text);
      assert.equal(input.learningContext.records.length, 2); assert.equal(input.baseline.tools[0].smokeCases, undefined);
      context.files[0].content = 'changed after first paid request';
      yield { type: 'tool_call', id: 'read-evidence', name: 'learning_context_read', arguments: { id: 'evidence:turn:one' } };
      yield { type: 'tool_call', id: 'read-source', name: 'learning_context_read', arguments: { id: 'file:src/main.js' } };
      yield { type: 'usage', usage: { totalTokens: 10 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    const pages = request.messages.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text));
    assert.equal(pages.some(row => row.content.includes('oldText matched twice')), true);
    assert.equal(pages.some(row => row.content.includes('captured source')), true);
    assert.equal(pages.some(row => row.content.includes('changed after')), false);
    yield { type: 'text_delta', delta: JSON.stringify({ summary: 'Use actual tool completion before claiming delivery', hypothesis: 'A verification step prevents false completion claims', diagnosis: { ...diagnosisFixture(), evidenceIds: ['turn:one'] }, changes: ['Improve evidence method'], genome: candidate }) };
    yield { type: 'usage', usage: { totalTokens: 11 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const result = await proposeProjectGenome({ project: { id: 'source-fixture' }, baseline, evidence, learningContext: context, model, provider, onProgress: event => events.push(event) });
  assert.equal(calls.length, 2); assert.equal(result.usage.totalTokens, 21); assert.equal(result.validation.passed, true);
  assert.equal(result.learningContextReads.length, 2); assert.equal(events.filter(event => event.type === 'learning_context_read').length, 2);
  assert.deepEqual(result.proposal.genome.evaluationSuite, baseline.evaluationSuite);
});
