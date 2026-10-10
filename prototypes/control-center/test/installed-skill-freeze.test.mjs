import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CapabilityInstaller } from '../../../packages/sdk/src/capability-installation.mjs';
import { projectGenomeFixture } from '../../../packages/sdk/test/fixtures/project-genome-fixture.mjs';
import { validateProjectGenome } from '../../../packages/sdk/src/project-genome.mjs';
import { ProjectGenomeStore } from '../project-genome-store.mjs';
import { freezeAssignedInstalledSkills } from '../installed-skill-freeze.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rawSkill = '---\r\nname: source-method\r\ndescription: Reusable local package\r\n---\r\nUse the original resources. No automatic code execution.';
async function fixture(t, { resources = true, license = true } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rna-installed-freeze-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = join(dir, 'repository'), source = join(repository, 'skills', 'method');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'SKILL.md'), rawSkill);
  if (resources) { await mkdir(join(source, 'references')); await writeFile(join(source, 'references', 'empty.txt'), ''); await writeFile(join(source, 'references', 'method.md'), 'Original reusable method.\n'); await mkdir(join(source, 'scripts')); await writeFile(join(source, 'scripts', 'run.mjs'), 'throw new Error("must remain inert");\n'); }
  if (license) await writeFile(join(repository, 'LICENSE'), 'Fixture license text.\n');
  const git = args => execFileSync('git', args, { cwd: repository, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']), file = join(dir, 'state.json'), root = `${file}.capabilities`;
  const installer = new CapabilityInstaller({ rootDir: root });
  const prepared = await installer.prepare({ kind: 'skill', id: 'external-method', source: { type: 'git', repository, ref: commit, subdirectory: 'skills/method' }, activate: true }, { installationId: 'install-fixture' });
  await prepared.commit();
  const manifest = { ...prepared.manifests[0].manifest, installationId: prepared.installationId }; delete manifest.contentHash; // Host normalization currently omits this; disk receipt retains it.
  const installation = { installationId: prepared.installationId, status: 'installed', projectId: 'project-one', activated: true, installationDir: prepared.installationDir, entries: [{ kind: 'skills', id: manifest.id }], sources: prepared.sources };
  const project = { id: 'project-one', assignments: { skillIds: [manifest.id] } };
  const store = { file, state: { projects: [project], capabilities: { skills: [manifest], installations: [installation] } } };
  return { dir, repository, source, commit, root, store, project, manifest, installation, skillRoot: join(prepared.installationDir, 'skill'), receiptFile: join(prepared.installationDir, 'installation.json') };
}
const onlyCode = (result, code) => { assert.equal(result.skills.length, 0); assert.equal(result.imports.length, 0); assert.deepEqual(result.diagnostics.map(row => row.code), [code]); };

test('real Git installer receipt becomes a complete stable byte-preserving frozen skill and a separate immutable version', async t => {
  const f = await fixture(t), prior = structuredClone(f.store.state);
  const result = await freezeAssignedInstalledSkills(f.store, f.project);
  assert.equal(result.skills.length, 1); assert.deepEqual(result.diagnostics, []); assert.deepEqual(f.store.state, prior);
  const skill = result.skills[0], source = skill.source;
  assert.equal(skill.instructions, rawSkill); assert.equal(source.kind, 'installed-skill-package'); assert.equal(source.integrity, 'installed_snapshot');
  assert.equal(source.repository, f.repository); assert.equal(source.commit, f.commit); assert.equal(source.manifestId, f.manifest.id);
  assert.equal(source.provider, undefined); assert.equal(source.catalogUrl, undefined);
  assert.deepEqual(source.licensePaths, ['@license/LICENSE']); assert.equal(skill.resources.find(row => row.path === 'references/empty.txt').content, '');
  assert.equal(source.installationRecordHash, hash(await readFile(f.receiptFile)));
  assert.equal(result.imports[0].proof.remoteGitBlobVerification, false); assert.equal(result.imports[0].proof.atomicFilesystemSnapshot, false);
  assert.deepEqual(result.imports[0].proof.installationHashVerifiedPaths, ['SKILL.md', '@license/LICENSE']);
  const genome = projectGenomeFixture(); genome.skills.push(skill); validateProjectGenome(genome);
  const versions = new ProjectGenomeStore(f.store), old = await versions.prepare(f.project, { genome: projectGenomeFixture(), versionId: 'old-version' }); await old.commit();
  const next = await versions.prepare(f.project, { genome, versionId: 'foundation-version', parentVersionId: 'old-version' }); await next.commit();
  assert.equal((await versions.read(f.project.id, 'old-version')).hash, old.record.hash);
  assert.equal(await readFile(join(next.record.dir, 'skills', skill.id, 'SKILL.md'), 'utf8'), rawSkill);
  for (const file of source.files) assert.equal(hash(await readFile(join(next.record.dir, 'skills', skill.id, file.path))), file.contentHash);
  assert.equal(next.skillManifests.at(-1).generated, false); assert.equal(next.skillManifests.at(-1).acquired, true);
  const again = await freezeAssignedInstalledSkills(f.store, f.project.id); assert.equal(again.skills[0].id, skill.id); assert.equal(again.skills[0].source.packageHash, source.packageHash);
});

test('a source without supporting resources remains valid and keeps repository license', async t => {
  const f = await fixture(t, { resources: false }), result = await freezeAssignedInstalledSkills(f.store, f.project);
  assert.equal(result.skills.length, 1); assert.deepEqual(result.skills[0].resources.map(row => row.path), ['@license/LICENSE']);
});

test('missing license is an explicit skip without downloading or fabricating a license', async t => {
  const f = await fixture(t, { license: false }); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_license_missing');
});

test('assigned, enabled, trusted and retained installation state are required; unassigned packages are not read', async t => {
  const f = await fixture(t);
  f.project.assignments.skillIds = []; assert.deepEqual((await freezeAssignedInstalledSkills(f.store, f.project)).skills, []);
  f.project.assignments.skillIds = [f.manifest.id]; f.manifest.enabled = false; onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_not_enabled');
  f.manifest.enabled = true; f.manifest.trusted = false; onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_not_enabled');
  f.manifest.trusted = true; f.installation.status = 'removed'; onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_receipt_missing');
});

test('generation path, entry identity and original receipt sources must match current assignment', async t => {
  const f = await fixture(t), path = f.manifest.path;
  f.manifest.path = join(f.source, 'SKILL.md'); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_generation_mismatch');
  f.manifest.path = path; f.installation.entries = []; onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_receipt_mismatch');
  f.installation.entries = [{ kind: 'skills', id: f.manifest.id }]; f.installation.sources[0].commit = 'f'.repeat(40); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_receipt_mismatch');
});

test('SKILL tampering is rejected against the original installation hash even when normalized manifest lacks a hash', async t => {
  const f = await fixture(t); await writeFile(join(f.skillRoot, 'SKILL.md'), `${rawSkill}\nModified`);
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_content_changed');
});

test('unrecorded resources are captured as current installed bytes, never claimed as remote Git verified', async t => {
  const f = await fixture(t); await writeFile(join(f.skillRoot, 'references', 'method.md'), 'Locally changed installed resource.');
  const result = await freezeAssignedInstalledSkills(f.store, f.project);
  assert.equal(result.skills.length, 1); assert.equal(result.skills[0].resources.find(row => row.path === 'references/method.md').content, 'Locally changed installed resource.');
  assert.equal(result.imports[0].proof.remoteGitBlobVerification, false);
});

test('license tampering or undeclared provenance files cannot be silently discarded', async t => {
  const f = await fixture(t), path = join(f.installation.installationDir, 'source-provenance', 'LICENSE');
  await writeFile(path, 'Altered license'); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_license_mismatch');
  await writeFile(path, 'Fixture license text.\n'); await writeFile(join(f.installation.installationDir, 'source-provenance', 'NOTICE'), 'unrecorded');
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_license_mismatch');
});

test('symlinks, binary and oversized resources reject the entire source instead of truncating it', async t => {
  const f = await fixture(t), bad = join(f.skillRoot, 'unsupported');
  await symlink(join(f.repository, 'LICENSE'), bad); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_unsafe_path'); await rm(bad);
  await writeFile(bad, Buffer.from([0xc3, 0x28])); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_binary');
  await writeFile(bad, Buffer.from([0])); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_binary');
  await writeFile(bad, 'a'.repeat(64001)); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_bundle_limit');
});

test('source-provenance projection cannot collide with an installed resource path', async t => {
  const f = await fixture(t); await mkdir(join(f.skillRoot, '@license')); await writeFile(join(f.skillRoot, '@license', 'LICENSE'), 'resource at reserved path');
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_resource_collision');
});

test('combined file count and byte limits include preserved repository license files', async t => {
  const f = await fixture(t, { resources: false });
  for (let i = 0; i < 127; i++) await writeFile(join(f.skillRoot, `part-${i}.txt`), '');
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_bundle_limit');
  for (let i = 0; i < 127; i++) await rm(join(f.skillRoot, `part-${i}.txt`));
  for (let i = 0; i < 17; i++) await writeFile(join(f.skillRoot, `large-${i}.txt`), 'a'.repeat(64000));
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_bundle_limit');
});

test('invalid receipt JSON and incomplete provenance do not expose partial skills', async t => {
  const f = await fixture(t), original = await readFile(f.receiptFile, 'utf8');
  await writeFile(f.receiptFile, '{broken'); onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_receipt_mismatch');
  await writeFile(f.receiptFile, original); await rm(join(f.installation.installationDir, 'source-provenance', 'LICENSE'));
  onlyCode(await freezeAssignedInstalledSkills(f.store, f.project), 'installed_skill_license_mismatch');
});

test('project assignment change during reading invalidates the whole frozen input', async t => {
  const f = await fixture(t), before = f.store.state, after = structuredClone(before); after.projects[0].assignments.skillIds = [];
  let reads = 0; Object.defineProperty(f.store, 'state', { get() { return ++reads === 1 ? before : after; } });
  await assert.rejects(freezeAssignedInstalledSkills(f.store, f.project), { code: 'installed_skill_scope_changed' });
});

test('cancellation and archived projects do not return a usable frozen input', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(freezeAssignedInstalledSkills(f.store, f.project, { signal: controller.signal }), { name: 'AbortError' });
  f.project.archivedAt = new Date().toISOString(); await assert.rejects(freezeAssignedInstalledSkills(f.store, f.project), { code: 'installed_skill_project_unavailable' });
});

test('installed package schema rejects invented marketplace claims and altered body/manifest inventories', async t => {
  const f = await fixture(t), result = await freezeAssignedInstalledSkills(f.store, f.project), genome = projectGenomeFixture(); genome.skills.push(result.skills[0]);
  const forged = structuredClone(genome); forged.skills.at(-1).source.provider = 'skills-sh'; assert.throws(() => validateProjectGenome(forged), /Invalid project genome/);
  const changed = structuredClone(genome); changed.skills.at(-1).resources[0].content += 'changed'; assert.throws(() => validateProjectGenome(changed), /bytes or license inventory/);
  const incomplete = structuredClone(genome); incomplete.skills.at(-1).source.licensePaths = []; assert.throws(() => validateProjectGenome(incomplete), /Invalid project genome/);
});
