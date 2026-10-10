import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectGenomeStore, genomeSkillId, genomeIdentity } from '../project-genome-store.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { genomeToolName } from '../../../packages/sdk/src/project-genome.mjs';
import { CapabilityRegistry } from '../../../packages/sdk/src/capabilities.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';

function respond(res, { name, args, text = 'Observed the pinned project behavior.' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = name ? { tool_calls: [{ index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\n`); res.end('data: [DONE]\n\n');
}
async function fixture(t, reply) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-version-runtime-')), workspace = join(dir, 'workspace'); await mkdir(workspace);
  const store = new Store(join(dir, 'state.json')), { project } = store.createProject({ name: '版本固定项目', description: '依据项目版本实际工具行为进行验证', workspace, demo: true }), genomes = new ProjectGenomeStore(store), capabilities = new CapabilityService(store), requests = [], failures = [], handles = [], records = {}, manifests = {};
  const current = () => store.state.projects.find(item => item.id === project.id);
  for (const marker of ['V1', 'V2']) {
    const genome = projectGenomeFixture(`SYSTEM_${marker}`); genome.skills[0].description = `技能目录_${marker}`; genome.skills[0].resources[0].content = `资源内容_${marker}`;
    genome.tools[0].script = `return {version: '${marker}', effort: input.features.reduce((sum, item) => sum + item.complexity, 0) * ${marker === 'V1' ? 1 : 10}};`;
    genome.tools[0].smokeCases = [{ input: { features: [{ complexity: 2 }] }, expected: { version: marker, effort: marker === 'V1' ? 2 : 20 } }];
    genome.tools.push({ id: 'save_report', name: '保存版本报告', description: '在项目目录保存报告', permission: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, script: `await api.writeFile('report.txt','${marker}'); return {saved:true};`, smokeCases: [{ input: {}, expected: { saved: true } }] });
    const prepared = await genomes.prepare(project, { genome, versionId: marker, parentVersionId: marker === 'V2' ? 'V1' : null }); await prepared.commit(); records[marker] = prepared.record;
    // EVO-3: both versions name their skills and tools alike, so the registry holds one manifest per id (replaced, as a
    // publication does); stacking both would make CapabilityRegistry refuse the duplicate id on every turn.
    store.mutate(state => { const target = state.projects.find(item => item.id === project.id); target.versions.push({ id: marker, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, simulated: false }); state.capabilities ??= { skills: [], tools: [], mcpServers: [], revision: 0 }; const ids = new Set(prepared.skillManifests.map(row => row.id)); state.capabilities.skills = [...state.capabilities.skills.filter(row => !ids.has(row.id)), ...prepared.skillManifests]; });
    manifests[marker] = prepared.skillManifests;
  }
  assert.deepEqual(manifests.V1.map(row => row.id), manifests.V2.map(row => row.id), 'one project, one set of names');
  assert.throws(() => new CapabilityRegistry({ skills: [...manifests.V1, ...manifests.V2] }), /Duplicate skill id/, 'the invariant the publishers keep: one manifest per id');
  const names = { tool: localId => genomeToolName(genomeIdentity(project.id), localId), skill: localId => genomeSkillId(genomeIdentity(project.id), localId) };
  const activate = marker => store.mutate(state => { const target = state.projects.find(item => item.id === project.id); target.activeVersionId = marker; target.trialVersionId = null; target.assignments = { skillIds: [names.skill('gameplay_scope')], toolIds: ['project_read', 'project_write', names.tool('estimate_scope'), names.tool('save_report')], mcpServerIds: [] }; }); activate('V1');
  const server = createServer(async (req, res) => { try { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body); await reply({ body, res, records, store, current, requests, activate, names }); } catch (failure) { failures.push(failure); res.writeHead(500); res.end('fixture assertion failed'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const create = async extra => { const handle = await createRnaRuntime({ project: structuredClone(current()), getProject: current, capabilityService: capabilities, projectId: project.id, cwd: workspace, stateDir: join(dir, 'sessions'), model: { protocol: 'openai', providerId: 'fixture', modelId: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 64000, maxOutputTokens: 1024 }, ...extra }); handles.push(handle); return handle; };
  t.after(async () => { for (const handle of handles) await handle.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); assert.deepEqual(failures, []); });
  return { dir, workspace, store, project, records, requests, create, activate, current, names };
}
// The same names on both versions (EVO-3): which version answers is the handle's pinned bundle, seen in what it returns.
function exercise({ body, res, names }) {
  const system = body.messages.find(message => message.role === 'system').content, marker = system.includes('SYSTEM_V2') ? 'V2' : 'V1', tool = names.tool('estimate_scope'), skill = names.skill('gameplay_scope');
  const start = body.messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('RUN:')), results = body.messages.slice(start).filter(message => message.role === 'tool');
  assert.ok(body.tools.some(entry => entry.function.name === tool)); assert.equal(body.tools.filter(entry => entry.function.name.endsWith('_estimate_scope')).length, 1, 'one declaration under the stable name');
  if (!results.length) return respond(res, { name: tool, args: { features: [{ complexity: 2 }] } });
  if (results.length === 1) { assert.deepEqual(JSON.parse(results[0].content), { version: marker, effort: marker === 'V1' ? 2 : 20 }); return respond(res, { name: 'skill_load', args: { id: skill, path: 'references/acceptance.md' } }); }
  assert.match(results[1].content, new RegExp(`资源内容_${marker}`)); return respond(res, { text: `Verified ${marker}` });
}

test('current handle keeps its system prompt, actual script and skill resource while new handles and explicit resumes select the correct version', async t => {
  const f = await fixture(t, exercise), old = await f.create({ sessionId: 'old-turn' }); await old.prompt('RUN:first'); assert.equal(f.requests.length, 3); const oldSystem = f.requests[0].messages[0].content, snapshot = old.snapshot();
  f.activate('V2'); await old.prompt('RUN:old-handle'); assert.equal(old.snapshot().projectVersionId, 'V1'); assert.equal(f.requests[3].messages[0].content, oldSystem); assert.ok(JSON.stringify(f.requests[3]).includes('技能目录_V1')); assert.ok(!JSON.stringify(f.requests[3]).includes('技能目录_V2'));
  const fresh = await f.create({ sessionId: 'new-turn' }); await fresh.prompt('RUN:new-handle'); assert.equal(fresh.snapshot().projectVersionId, 'V2'); assert.match(f.requests[6].messages[0].content, /SYSTEM_V2/);
  // The V1 and V2 handles declare the same tool name; each ran its own version's script and read its own skill resource.
  const declared = request => request.tools.map(entry => entry.function.name).filter(name => /^gen_/.test(name)).sort();
  assert.deepEqual(declared(f.requests[3]), declared(f.requests[6]));
  assert.deepEqual(JSON.parse(f.requests[5].messages.filter(message => message.role === 'tool').at(-2).content), { version: 'V1', effort: 2 });
  assert.deepEqual(JSON.parse(f.requests[8].messages.filter(message => message.role === 'tool').at(-2).content), { version: 'V2', effort: 20 });
  assert.match(f.requests[5].messages.filter(message => message.role === 'tool').at(-1).content, /资源内容_V1/); assert.match(f.requests[8].messages.filter(message => message.role === 'tool').at(-1).content, /资源内容_V2/);
  await old.dispose(); const resumed = await f.create({ sessionId: 'old-turn', sessionFile: snapshot.sessionFile, projectVersionId: snapshot.projectVersionId }); await resumed.prompt('RUN:explicit-old-resume'); assert.equal(resumed.snapshot().projectBundleHash, f.records.V1.hash); assert.equal(f.requests[9].messages[0].content, oldSystem);
  assert.deepEqual(JSON.parse(f.requests[10].messages.filter(message => message.role === 'tool').at(-1).content), { version: 'V1', effort: 2 }, 'a resumed old handle still runs V1 under the same name');
});

test('readonly composition keeps generated writes, host writes and mutation management tools declared (rejected at execution) without removing readonly generated behavior', async t => {
  const f = await fixture(t, exercise), handle = await f.create({ sessionId: 'readonly', readOnly: true, managementTools: [{ id: 'mutation_manager', name: 'mutation_manager', permission: 'exec', effect: 'write', parameters: { type: 'object' }, execute() { throw new Error('must not execute'); } }] });
  const snapshot = handle.snapshot(); assert.ok(snapshot.tools.includes(f.names.tool('estimate_scope'))); for (const name of [f.names.tool('save_report'), 'project_write', 'mutation_manager']) assert.ok(snapshot.tools.includes(name), `${name} stays declared so plan mode does not fork the cached tools prefix`);
  await handle.prompt('RUN:readonly'); assert.equal(f.requests.length, 3);
});

test('immutable bundle tampering rejects new handles and a pinned handle before further model requests', async t => {
  const f = await fixture(t, exercise), handle = await f.create({ sessionId: 'tamper' }); await writeFile(join(f.records.V1.dir, 'skills/gameplay_scope/references/acceptance.md'), 'unreviewed changed resource');
  await assert.rejects(f.create({ sessionId: 'tampered-new' }), { code: 'genome_changed' }); await assert.rejects(handle.prompt('RUN:tampered'), { code: 'genome_changed', message: /项目版本文件已变化/ }); assert.equal(f.requests.length, 0);
});

test('skill resource changed after a model request is rejected by skill_load and never returned as pinned content', async t => {
  const f = await fixture(t, async ({ body, res, records, names }) => {
    const results = body.messages.filter(message => message.role === 'tool');
    if (!results.length) { await writeFile(join(records.V1.dir, 'skills/gameplay_scope/references/acceptance.md'), 'MUTATED_RESOURCE_SHOULD_NOT_BE_READ'); return respond(res, { name: 'skill_load', args: { id: names.skill('gameplay_scope'), path: 'references/acceptance.md' } }); }
    respond(res);
  });
  const handle = await f.create({ sessionId: 'tamper-between-request-and-call' }); await assert.rejects(handle.prompt('RUN:tamper-during-call'), { code: 'genome_changed', message: /项目版本文件已变化/ });
  const results = handle.snapshot().messages.filter(message => message.role === 'toolResult'); assert.equal(results.length, 1); assert.equal(results[0].isError, true); assert.match(JSON.stringify(results[0]), /The skill material of the project version was changed/); assert.ok(!JSON.stringify(results).includes('MUTATED_RESOURCE_SHOULD_NOT_BE_READ')); assert.equal(f.requests.length, 1);
});
