import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';

const script = fileURLToPath(new URL('../examples/proactive-project.mjs', import.meta.url));
function initialized() {
  return { overview: 'An example project initialized by the HTTP test fixture', focus: 'Read the workspace evidence before sharing a useful finding', facts: ['The project has a title and introduction'], openQuestions: ['Which project detail needs clarification?'], milestones: [{ title: 'Review evidence', description: 'Read available project metadata', acceptanceCriteria: ['Findings cite actual observations'] }], assignments: { skillIds: ['project-analysis'], toolIds: ['project_list'], mcpServerIds: [], reasons: [{ kind: 'skill', id: 'project-analysis', reason: 'Understand the project context' }, { kind: 'tool', id: 'project_list', reason: 'Read workspace directory evidence' }] }, unmetCapabilities: [], genome: projectGenomeFixture('HTTP fixture project') };
}
function sse(res, delta, finishReason = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function runExample({ evolve = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-example-smoke-')), workspace = join(directory, 'workspace'), state = join(directory, 'state');
  await mkdir(workspace); await writeFile(join(workspace, 'README.md'), '# Example workspace\nA real file for the readonly tool.\n');
  const received = [], errors = []; let decisions = 0;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer example-fixture-token');
      let source = ''; for await (const chunk of req) source += chunk;
      const body = JSON.parse(source); received.push(body);
      const system = body.messages.find(message => message.role === 'system')?.content || '';
      if (system.startsWith('You initialize a real, project-specific Rna Agent')) { sse(res, { content: JSON.stringify(initialized()) }); return; }
      if (system.startsWith("You are Rna Agent's ongoing project collaborator")) {
        const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
        assert.equal(input.project.goal, undefined); assert.ok(input.events.length);
        const action = decisions++ === 0 ? evolve ? 'learn' : 'work' : 'share';
        const evidence = action === 'share' ? input.events.findLast(event => event.type === (evolve ? 'evolution_candidate_ready' : 'action_completed')) : input.events.at(-1);
        assert.ok(evidence, 'decision must use an actual observation from this request');
        sse(res, { content: JSON.stringify({ action, reason: 'The observed project state justifies this bounded step', evidenceIds: [evidence.id], content: action === 'work' ? 'List the workspace and summarize the visible file.' : action === 'learn' ? 'Evaluate the explicitly enabled tag-normalizer function example.' : evolve ? 'The function candidate passed its configured cases; it is available for optional trial. This does not prove model quality.' : 'The workspace contains README.md; this finding comes from the completed readonly research.', nextReviewAfterMs: 60000 }) }); return;
      }
      const toolResult = body.messages.find(message => message.role === 'tool');
      if (!toolResult) { assert.ok(body.tools.some(tool => tool.function.name === 'project_list')); sse(res, { tool_calls: [{ index: 0, id: 'fixture-list-call', type: 'function', function: { name: 'project_list', arguments: '{}' } }] }, 'tool_calls'); }
      else { assert.match(toolResult.content, /README\.md/); sse(res, { content: 'The actual workspace listing contains README.md.' }); }
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'HTTP fixture assertion failed' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelPath = join(directory, 'model.json');
  await writeFile(modelPath, JSON.stringify({ apiKeyEnv: 'RNA_EXAMPLE_FIXTURE_KEY', model: { providerId: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture', contextWindow: 32000, maxOutputTokens: 4096, reasoning: 'off' } }));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--model', modelPath, '--title', 'Fixture project', '--description', 'Inspect existing evidence and communicate proactively.', '--workspace', workspace, '--state-dir', state, '--ticks', '2', '--interval-ms', '100', '--jsonl', ...(evolve ? ['--evolve'] : [])], { env: { PATH: '/usr/bin:/bin', RNA_EXAMPLE_FIXTURE_KEY: 'example-fixture-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Example subprocess did not finish within 20 seconds')); }, 20000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    assert.equal(output.code, 0, `${output.stderr}\n${output.stdout}`); assert.deepEqual(errors, []); assert.equal(output.stderr, '');
    assert.ok(!output.stdout.includes('example-fixture-token'));
    const events = output.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === 'project_initialized'));
    assert.ok(events.some(event => event.type === 'chat_message' && event.proactive === true && event.role === 'assistant'));
    const complete = events.find(event => event.type === 'run_complete'); assert.ok(complete); assert.ok(complete.requests > 0);
    const savedProject = JSON.parse(await readFile(join(complete.stateDir, 'project.json'), 'utf8')); assert.equal(savedProject.initial.status, 'ready');
    assert.equal(savedProject.initial.genomeValidation.passed, true); assert.match(await readFile(join(complete.stateDir, 'genome', 'SYSTEM.md'), 'utf8'), /HTTP fixture project/); assert.match(await readFile(join(complete.stateDir, 'genome', 'skills', 'gameplay_scope', 'SKILL.md'), 'utf8'), /玩法范围审查/);
    const savedInitiative = JSON.parse(await readFile(join(complete.stateDir, 'initiative.json'), 'utf8')); assert.ok(savedInitiative.actions.some(action => action.action === 'share' && action.status === 'completed'));
    if (evolve) {
      assert.ok(events.some(event => event.type === 'evolution_scope' && /不是模型质量/.test(event.text)));
      assert.ok(events.some(event => event.type === 'evolution_candidate_ready'));
      const savedEvolution = JSON.parse(await readFile(join(complete.stateDir, 'evolution.json'), 'utf8'));
      const candidate = savedEvolution.candidates[0]; assert.equal(candidate.status, 'ready'); assert.equal(candidate.evaluation.pairs.length, 3); assert.equal(candidate.evaluation.gate.baselineScore, 1 / 3); assert.equal(candidate.evaluation.gate.candidateScore, 1); assert.equal(savedEvolution.activeVersionId, 'normalizer-v1'); assert.equal(savedEvolution.trialVersionId, null);
    } else {
      assert.ok(events.some(event => event.type === 'research_completed'));
      const sessionFiles = await readdir(join(complete.stateDir, 'sessions')); assert.ok(sessionFiles.some(file => file.endsWith('.jsonl')));
      const journal = await readFile(join(complete.stateDir, 'sessions', sessionFiles.find(file => file.endsWith('.jsonl'))), 'utf8'); assert.match(journal, /tool_completed/); assert.match(journal, /README\.md/); assert.ok(!journal.includes('example-fixture-token'));
    }
    return { requests: received.length, events: events.length };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}
test('proactive example runs bootstrap, real readonly tool journal and proactive chat over HTTP', async () => {
  const result = await runExample(); assert.equal(result.requests, 5);
});
test('proactive example runs optional actual function evaluation and announces the inert candidate', async () => {
  const result = await runExample({ evolve: true }); assert.equal(result.requests, 3);
});
