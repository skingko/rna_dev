import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture, genomeEvaluationProvider } from '../../../packages/sdk/test/fixtures/project-genome.mjs';
import { readStateFile } from '../state-shards.mjs';

test('version API validates the restored generation, permits escape from a damaged trial and retains persisted version pointers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-version-api-')), app = createServer({ stateFile: join(dir, 'state.json'), ticks: false, runtime: false, initiative: false, initiativeOptions: { evolutionProvider: genomeEvaluationProvider() } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const provider = app.store.configurationService.provider(null, { name: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 128000, maxOutputTokens: 4000 }] }); app.store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture' } });
  const { project } = app.store.createProject({ name: 'Restore a verified version', workspace: dir, demo: true }), genomes = new ProjectGenomeStore(app.store), prepared = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: project.activeVersionId }); await prepared.commit();
  app.store.mutate(state => { const p = state.projects.find(p => p.id === project.id); p.initialization = { status: 'ready' }; p.simulated = false; p.decisionMode = 'rna-model'; p.versions[0].bundle = prepared.record; p.versions[0].simulated = false; });
  app.evolution.start(project.id, { genome: projectGenomeFixture({ candidate: true }) }); await app.evolution.operations.get(project.id).promise;
  const current = () => app.store.state.projects.find(p => p.id === project.id), candidate = current().versions.at(-1); assert.equal(candidate.state, 'ready');
  const base = `http://127.0.0.1:${app.server.address().port}/api/projects/${project.id}/versions/${candidate.id}/control`, control = async action => { const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await control('trial')).status, 200);
  const candidatePath = join(candidate.bundle.dir, 'SYSTEM.md'), candidateText = await readFile(candidatePath, 'utf8'); await writeFile(candidatePath, 'damaged trial');
  assert.equal((await control('rollback')).status, 200, 'A damaged trial can be exited to an intact baseline'); assert.equal(current().trialVersionId, null); assert.equal(current().activeVersionId, project.activeVersionId);
  await writeFile(candidatePath, candidateText); assert.equal((await control('trial')).status, 200); assert.equal((await control('adopt')).status, 200); assert.equal(current().activeVersionId, candidate.id);
  const parentPath = join(prepared.record.dir, 'SYSTEM.md'), parentText = await readFile(parentPath, 'utf8'); await writeFile(parentPath, 'damaged parent');
  const rejected = await control('rollback'); assert.equal(rejected.status, 400); assert.match(rejected.body.error, /版本文件已变化/); assert.equal(current().activeVersionId, candidate.id, 'Failed rollback must leave the current selected generation intact');
  await writeFile(parentPath, parentText); assert.equal((await control('rollback')).status, 200); assert.equal(current().activeVersionId, project.activeVersionId);
  const persisted = readStateFile(app.store.file).state.projects.find(p => p.id === project.id); assert.equal(persisted.activeVersionId, project.activeVersionId); assert.equal(persisted.versions.length, 2);
});
