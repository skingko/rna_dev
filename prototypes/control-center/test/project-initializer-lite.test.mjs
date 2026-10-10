import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectInitializer } from '../project-initializer.mjs';

// The production default: one small brief request, genome assembled by code, several projects in parallel.
const brief = title => ({ overview: `${title} 概述`, focus: '先做可用原型', facts: [], openQuestions: [], milestones: [], charter: `${title} 的项目章程`, workflow: '读取、修改、验证',
  criteria: [{ id: 'works', description: '结果可用' }], sampleTasks: [1, 2, 3].map(n => ({ id: `t${n}`, input: `示例请求 ${n}`, requiredTerms: [] })), skillQueries: ['novel writing', 'story outline'], catalogSkillIds: [], mcpServerIds: [], reasons: [], unmetCapabilities: [] });
async function until(check, ms = 10000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } }

test('a new project initializes from one small brief request in well under a second of host time, three projects in parallel', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-lite-init-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), requests = [];
  let inFlight = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 150)); inFlight--;
    const title = JSON.parse(body.messages.at(-1).content).title ?? 'x';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(brief(title)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 600 } })}\n\n`); res.end('data: [DONE]\n\n');
  }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const p = store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 32768 }] });
  store.configurationService.update({ defaultModel: { providerId: p.id, modelId: 'fixture', reasoning: 'off' } });
  const initializer = new ProjectInitializer(store, new CapabilityService(store), { autoFoundation: false }); t.after(() => initializer.close());
  const started = Date.now();
  const projects = ['卡丁车游戏', '玄幻小说', '新闻日报'].map((name, index) => { const workspace = join(dir, `w${index}`); return store.createProject({ name, description: `${name}项目`, workspace, initialize: true }).project; });
  await until(() => projects.every(project => store.state.projects.find(row => row.id === project.id).initialization.status === 'ready'));
  const elapsed = Date.now() - started;
  assert.equal(requests.length, 3, 'one request per project'); assert.ok(peak >= 2, `projects initialize in parallel (peak ${peak})`);
  assert.ok(elapsed < 3000, `three initializations took ${elapsed} ms against a 150 ms model`);
  assert.ok(requests.every(body => (body.max_completion_tokens ?? body.max_tokens) <= 6144), 'bounded output allowance');
  for (const project of projects) {
    const saved = store.state.projects.find(row => row.id === project.id);
    assert.equal(saved.decisionMode, 'rna-model'); assert.equal(saved.versions.length, 1); assert.match(saved.systemPrompt, /项目章程/);
    assert.ok(saved.assignments.toolIds.includes('project_read'), 'common tools are assigned to every project');
    assert.equal(saved.skillFoundation.status, 'queued', 'the skill step runs next (it is not marked done by the brief)');
    assert.deepEqual(saved.skillQueries, ['novel writing', 'story outline'], 'marketplace queries written by the brief are kept for the skill step');
  }
});
