import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitializer } from '../test-support/marketplace-isolation.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';

for (const directory of [false, true]) test(`initialization ${directory ? 'post' : 'pre'}-rename failure preserves the correct publication boundary`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-initialize-durability-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), capabilities = new CapabilityService(store), genomes = new ProjectGenomeStore(store);
  const provider = store.configurationService.provider(null, { name: 'injected initializer', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 8192 }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' } });
  let prepared, rollbacks = 0; const prepare = genomes.prepare.bind(genomes);
  genomes.prepare = async (...args) => { prepared = await prepare(...args); const rollback = prepared.rollback; prepared.rollback = async () => { rollbacks++; return rollback(); }; return prepared; };
  const generate = async () => ({ status: 'ready', overview: 'Initial project', focus: 'Review requirements', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture(), usage: { totalTokens: 0, estimatedTokens: 0 }, attempts: 1 });
  const originalSync = fs.fsyncSync, persist = store.persist.bind(store); let publishing = false, injected = false;
  store.persist = next => { publishing = next.projects.some(row => row.initialization?.status === 'ready'); try { return persist(next); } finally { publishing = false; } };
  fs.fsyncSync = fd => { if (publishing && !injected && fs.fstatSync(fd).isDirectory() === directory && (!directory || fs.fstatSync(fd).ino === fs.statSync(store.file.slice(0, store.file.lastIndexOf('/'))).ino)) { injected = true; throw Object.assign(new Error('fixture disk sync'), { code: 'EIO' }); } return originalSync(fd); }; syncBuiltinESMExports();
  const initializer = new ProjectInitializer(store, capabilities, { genomeStore: genomes, generate });
  let project;
  try {
    project = store.createProject({ name: 'Real immutable initialization publication', workspace: dir, initialize: true }).project;
    const end = Date.now() + 5000; while (!injected || initializer.running.size) { if (Date.now() > end) throw Error('initializer timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
  } finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); store.persist = persist; await initializer.close(); }
  assert.ok(injected); assert.ok(store.persistence.failed);
  if (directory) {
    assert.equal(rollbacks, 0); assert.equal((await stat(prepared.record.dir)).isDirectory(), true);
    const current = store.state.projects.find(row => row.id === project.id); assert.equal(current.initialization.status, 'ready');
    assert.equal((await genomes.read(project.id, current.activeVersionId)).hash, prepared.record.hash);
    const recovered = new Store(store.file); assert.equal(recovered.state.projects.find(row => row.id === project.id).activeVersionId, current.activeVersionId);
  } else { assert.equal(rollbacks, 1); await assert.rejects(stat(prepared.record.dir), { code: 'ENOENT' }); assert.equal(store.state.projects.find(row => row.id === project.id).activeVersionId, null); }
});
