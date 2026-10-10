import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGenomeStore, genomeSkillId, genomeIdentity } from '../project-genome-store.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { genomeToolName } from '../../../packages/sdk/src/project-genome.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'rna-genome-store-')); t.after(() => rm(dir, { recursive: true, force: true })); return { dir, genomes: new ProjectGenomeStore({ file: join(dir, 'state.json') }) }; }

test('project genome generation stores system, complete skill resources, scripts and editable evaluation source without executing them', async t => {
  const { genomes } = await fixture(t), project = { id: 'project-one' }, genome = projectGenomeFixture();
  const prepared = await genomes.prepare(project, { genome, versionId: 'version-one' });
  assert.equal(prepared.record.namespace, 'project-one:version-one'); assert.equal(prepared.skillManifests[0].id, genomeSkillId(genomeIdentity(project.id), 'gameplay_scope')); assert.equal(prepared.toolDescriptors[0].id, genomeToolName(genomeIdentity(project.id), 'estimate_scope'));
  assert.equal(prepared.skillManifests[0].managed, 'project-genome'); assert.equal(prepared.skillManifests[0].projectId, project.id);
  await assert.rejects(genomes.read(project.id, 'version-one'), { code: 'ENOENT' });
  await prepared.commit(); const saved = await genomes.read(project.id, 'version-one'); assert.deepEqual(saved.genome, genome);
  assert.match(await readFile(join(saved.dir, 'SYSTEM.md'), 'utf8'), /游戏开发工作台/); assert.match(await readFile(join(saved.dir, 'skills/gameplay_scope/references/acceptance.md'), 'utf8'), /玩家输入/); assert.match(await readFile(join(saved.dir, 'tools/estimate_scope.mjs'), 'utf8'), /export default async function/); assert.deepEqual(JSON.parse(await readFile(join(saved.dir, 'evaluation.json'), 'utf8')), genome.evaluationSuite);
  const second = await genomes.prepare({ id: 'project-two' }, { genome, versionId: 'version-one' }); assert.notEqual(second.skillManifests[0].id, prepared.skillManifests[0].id); assert.notEqual(second.toolDescriptors[0].id, prepared.toolDescriptors[0].id); await second.rollback();
});

test('EVO-3: two generations of one project give their skills and tools the same names, and keep their own storage identity', async t => {
  const { genomes } = await fixture(t), project = { id: 'project-one' };
  const v1 = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: 'V1' }), edited = projectGenomeFixture('编辑后工作台');
  edited.tools[0].description = 'A revised description.';
  const v2 = await genomes.prepare(project, { genome: edited, versionId: 'V2', parentVersionId: 'V1' });
  assert.deepEqual(v2.skillManifests.map(row => row.id), v1.skillManifests.map(row => row.id)); assert.deepEqual(v2.toolDescriptors.map(row => row.id), v1.toolDescriptors.map(row => row.id));
  assert.deepEqual(v2.toolDescriptors.map(row => row.toolName), v1.toolDescriptors.map(row => row.toolName));
  assert.deepEqual([v1.record.namespace, v2.record.namespace], ['project-one:V1', 'project-one:V2'], 'record.json and its hashes keep the per-version storage identity');
  assert.deepEqual([v1.skillManifests[0].versionId, v2.skillManifests[0].versionId], ['V1', 'V2']); assert.notEqual(v1.skillManifests[0].path, v2.skillManifests[0].path);
  await v1.rollback(); await v2.rollback();
});

test('a committed generation cannot be overwritten, and failed competing publication cannot remove it', async t => {
  const { genomes } = await fixture(t), project = { id: 'project-one' };
  const first = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: 'version-one' }); await first.commit();
  const edited = projectGenomeFixture('编辑后工作台'), duplicate = await genomes.prepare(project, { genome: edited, versionId: 'version-one' }); await assert.rejects(duplicate.commit(), { code: 'version_conflict' }); await duplicate.rollback();
  assert.equal((await genomes.read(project.id, 'version-one')).hash, first.record.hash);
  const next = await genomes.prepare(project, { genome: edited, versionId: 'version-two', parentVersionId: 'version-one' }); await next.commit(); assert.notEqual(next.record.hash, first.record.hash); assert.equal((await genomes.read(project.id, 'version-one')).hash, first.record.hash);
});

test('invalid paths and cancellation publish nothing; direct edits are detected instead of silently mutating a pinned generation', async t => {
  const { genomes } = await fixture(t), project = { id: 'project-one' }, unsafe = projectGenomeFixture(); unsafe.skills[0].resources[0].path = '../escape';
  await assert.rejects(genomes.prepare(project, { genome: unsafe, versionId: 'unsafe' }), /safe package-relative/);
  const controller = new AbortController(), cancelled = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: 'cancelled', signal: controller.signal }); controller.abort(); await assert.rejects(cancelled.commit(), { name: 'AbortError' }); await cancelled.rollback(); assert.deepEqual(await readdir(join(genomes.rootDir, project.id)), []);
  const intact = await genomes.prepare(project, { genome: projectGenomeFixture(), versionId: 'intact' }); await intact.commit(); await writeFile(join(intact.record.dir, 'SYSTEM.md'), 'edited outside the version editor'); await assert.rejects(genomes.read(project.id, 'intact'), { code: 'genome_changed' });
});
