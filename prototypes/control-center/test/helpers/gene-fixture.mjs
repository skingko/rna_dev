// Shared fixture for evolution tests: a server with a stub model provider and a
// novel project whose active version is a real, verified genome bundle.
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../../server.mjs';
import { streamCompletion } from '../../../../packages/sdk/src/providers.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';

export async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(20); }
  throw new Error('condition did not settle');
}
export function stream(res, content, { tool } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  chunk({ role: 'assistant' });
  if (tool) chunk({ tool_calls: [{ index: 0, id: `tool-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  else chunk({ content });
  chunk({}, tool ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}
export const GUARD_SCRIPT = "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/守夜/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: '含“守夜”字样' }); }); return { hits, summary: hits.length ? `发现 ${hits.length} 处` : '未发现' };";
export const GUARD_ANSWER = { title: '「守夜」字样检查', summary: '检查正文里有没有出现“守夜”字样，写完章节后自动查一遍。', skillNote: '组织名不能沿用原著的「守夜人」，正文里不得出现“守夜”字样。',
  tool: { id: 'guard_nightwatch', name: '守夜字样检查', description: 'Checks one chapter file for the banned term 守夜. Takes {path}.', script: GUARD_SCRIPT,
    smokeCases: [{ violations: true, input: { path: 'sample.md' }, workspace: { files: [{ path: 'sample.md', content: '第一章\n守夜人站在城墙上。\n' }] } }, { violations: false, input: { path: 'sample.md' }, workspace: { files: [{ path: 'sample.md', content: '第一章\n夜巡者站在城墙上。\n' }] } }] },
  trigger: { onWrite: ['正文/**/*.md'] } };
/** A chapter that keeps GUARD_ANSWER's rule: a new check runs on it, finds nothing and is in force at once (EVO-5 keeps a
 * check that matched no file on trial). */
export const keepsRule = workspace => { mkdirSync(join(workspace, '正文', '卷一'), { recursive: true }); writeFileSync(join(workspace, '正文', '卷一', '第001章.md'), '第一章\n夜巡者站在城墙上。\n'); };
export const GENOME = { schemaVersion: 1, systemPrompt: '你是本玄幻小说项目的专职写作代理。先设定后正文。\n\n每章产出前核对设定集。',
  skills: [{ id: 'project-workflow', name: '项目工作流', description: '章节写作流程', instructions: '# 项目工作流\n\n1. 读设定集。\n2. 写章节。', resources: [] }], tools: [],
  evaluationSuite: { version: 'v1', criteria: [{ id: 'consistency', description: '与设定集一致', weight: 1 }], cases: [{ id: 'c1', input: '写一段', requiredTerms: [], forbiddenTerms: [], requiredToolIds: [], weight: 1 }, { id: 'c2', input: '写两段', requiredTerms: [], forbiddenTerms: [], requiredToolIds: [], weight: 1 }, { id: 'c3', input: '写三段', requiredTerms: [], forbiddenTerms: [], requiredToolIds: [], weight: 1 }], thresholds: { minImprovement: 0.05, maxRegression: 0.05, minScore: 0.6, maxTokenRatio: 2 } } };

export async function setup(t, respond) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-genes-')), calls = [];
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {}; calls.push(input);
    await respond(input, response, calls.length);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, initiativeOptions: { mindProvider: streamCompletion } });
  await app.initializer.close();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const p = app.store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-gene-fixture-key', models: [{ id: 'fixture-model', contextWindow: 32000, maxOutputTokens: 4000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const workspace = join(directory, 'novel'); mkdirSync(join(workspace, '正文', '卷一'), { recursive: true });
  const { session, project } = app.store.createProject({ name: '玄幻小说', workspace, initiative: { enabled: false } });
  // A real, verified genome bundle as the active version (what initialization normally produces).
  const genomes = new ProjectGenomeStore(app.store), prepared = await genomes.prepare(project, { genome: GENOME }); await prepared.commit();
  app.store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.simulated = false; target.initialization = { status: 'ready' }; target.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: '基线', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: new Date().toISOString(), simulated: false }];
    target.activeVersionId = prepared.record.versionId;
    // What initialization normally assigns: the workspace tools the project may use.
    target.assignments = { skillIds: prepared.skillManifests.map(row => row.id), toolIds: ['project_read', 'project_list', 'project_find', 'project_grep', 'project_write', 'project_edit'], mcpServerIds: [] };
  });
  const current = () => app.store.state.projects.find(row => row.id === project.id);
  return { app, calls, project, session, workspace, current, url: path => `http://127.0.0.1:${app.server.address().port}${path}` };
}
