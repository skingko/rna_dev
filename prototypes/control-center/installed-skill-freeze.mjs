import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { skillMetadataField } from '../../packages/sdk/src/capabilities.mjs';
import { validateMarketplaceSkillBytes } from '../../packages/sdk/src/marketplace-genome-skills.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identifier = value => typeof value === 'string' && !/[\0\r\n]/.test(value) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const safePath = value => typeof value === 'string' && value.length <= 400 && !/[\0\r\n]/.test(value) && /^[A-Za-z0-9_.@+ -]+(?:\/[A-Za-z0-9_.@+ -]+)*$/.test(value) && !value.split('/').some(part => ['.', '..', '.git', 'node_modules'].includes(part));
const inside = (root, path) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
const inventory = files => files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes }));
const cancelled = signal => signal?.throwIfAborted();

async function directory(path, root) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, path) || await realpath(path) !== path) fail('installed_skill_unsafe_path');
}
async function readText(path, { signal, maxBytes = 64000 } = {}) {
  cancelled(signal);
  if (await realpath(path) !== path) fail('installed_skill_unsafe_path');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) fail('installed_skill_bundle_limit');
    const buffer = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < buffer.length) { cancelled(signal); const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > maxBytes) fail('installed_skill_bundle_limit');
    const bytes = buffer.subarray(0, offset); cancelled(signal);
    const after = await handle.stat(), current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) fail('installed_skill_changed');
    const content = bytes.toString('utf8');
    if (content.includes('\0') || !Buffer.from(content).equals(bytes)) fail('installed_skill_binary');
    return { content, contentHash: hash(bytes), bytes: bytes.length };
  } finally { await handle.close(); }
}
async function readTree(root, signal) {
  const files = [], paths = []; let totalBytes = 0, entries = 0;
  async function visit(path, prefix = '', depth = 0) {
    cancelled(signal); if (depth > 32) fail('installed_skill_bundle_limit');
    await directory(path, root);
    for (const name of (await readdir(path)).sort()) {
      const key = prefix ? `${prefix}/${name}` : name;
      if (!safePath(key)) fail('installed_skill_unsafe_path');
      if (++entries > 512) fail('installed_skill_bundle_limit');
      const target = join(path, name), info = await lstat(target);
      if (info.isSymbolicLink()) fail('installed_skill_unsafe_path');
      if (info.isDirectory()) { paths.push(`${key}/`); await visit(target, key, depth + 1); }
      else if (info.isFile()) {
        if (files.length >= 128) fail('installed_skill_bundle_limit');
        const file = { path: key, ...await readText(target, { signal }) };
        if ((totalBytes += file.bytes) > 1024 * 1024) fail('installed_skill_bundle_limit');
        files.push(file); paths.push(key);
      } else fail('installed_skill_unsafe_path');
    }
  }
  await visit(root);
  return { files, identity: canonical({ inventory: inventory(files), paths }) };
}
function projectScope(store, projectId) {
  const state = store.state, project = state.projects.find(p => p.id === projectId);
  if (!project || project.archivedAt) fail('installed_skill_project_unavailable');
  const assigned = [...new Set(project.assignments?.skillIds ?? [])];
  const manifests = (state.capabilities?.skills ?? []).filter(row => assigned.includes(row.id) && row.installationId && !row.generated && row.managed !== 'project-genome');
  const installations = (state.capabilities?.installations ?? []).filter(row => manifests.some(manifest => manifest.installationId === row.installationId));
  const snapshot = structuredClone({ projectId, assigned, manifests, installations });
  return { ...snapshot, hash: hash(canonical(snapshot)) };
}
function sourceIdentity(value) {
  if (!value || value.type !== 'git' || value.commit?.length !== 40 || !/^[a-f0-9]{40}$/.test(value.commit) || value.subdirectory !== '.' && !safePath(value.subdirectory)) fail('installed_skill_source_unsupported');
  if (typeof value.repository !== 'string' || !value.repository.length || value.repository.length > 2000 || /[\0\r\n]/.test(value.repository)) fail('installed_skill_source_unsupported');
  if (!isAbsolute(value.repository)) {
    let url; try { url = new URL(value.repository); } catch { fail('installed_skill_source_unsupported'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('installed_skill_source_unsupported');
  }
  return value;
}

async function freezeOne(manifest, installation, root, signal, frozenAt) {
  if (manifest.enabled !== true || manifest.trusted !== true) fail('installed_skill_not_enabled');
  if (!installation || installation.status !== 'installed' || !identifier(installation.installationId) || !identifier(manifest.id)) fail('installed_skill_receipt_missing');
  if (!installation.entries?.some(row => row.kind === 'skills' && row.id === manifest.id)) fail('installed_skill_receipt_mismatch');
  const generation = join(root, installation.installationId), skillRoot = join(generation, 'skill');
  if (installation.installationDir !== generation || manifest.path !== join(skillRoot, 'SKILL.md')) fail('installed_skill_generation_mismatch');
  await directory(generation, root);
  const recordFile = join(generation, 'installation.json'), record = await readText(recordFile, { signal, maxBytes: 1024 * 1024 });
  let receipt; try { receipt = JSON.parse(record.content); } catch { fail('installed_skill_receipt_mismatch'); }
  if (receipt.installationId !== installation.installationId || canonical(receipt.sources) !== canonical(installation.sources)) fail('installed_skill_receipt_mismatch');
  const selected = receipt.manifests?.filter(row => row.kind === 'skills' && row.manifest?.id === manifest.id) ?? [];
  if (selected.length !== 1 || selected[0].manifest.path !== manifest.path || !/^[a-f0-9]{64}$/.test(selected[0].manifest.contentHash ?? '')) fail('installed_skill_receipt_mismatch');
  if (receipt.sources?.length !== 1) fail('installed_skill_source_unsupported');
  const source = sourceIdentity(receipt.sources[0]);
  if (!source.licenseFiles?.length || source.licenseReview !== 'preserved_not_legal_approval') fail('installed_skill_license_missing');
  const initial = await readTree(skillRoot, signal), original = initial.files.find(file => file.path === 'SKILL.md');
  if (!original || !original.content.trim() || original.contentHash !== selected[0].manifest.contentHash || manifest.contentHash && manifest.contentHash !== original.contentHash) fail('installed_skill_content_changed');
  const licenseRoot = join(generation, 'source-provenance'), licenses = await readTree(licenseRoot, signal);
  if (licenses.files.length !== source.licenseFiles.length) fail('installed_skill_license_mismatch');
  for (const file of licenses.files) {
    const entry = source.licenseFiles.find(row => row.path === `source-provenance/${file.path}`);
    if (!entry || entry.contentHash !== file.contentHash || entry.bytes !== file.bytes) fail('installed_skill_license_mismatch');
  }
  const licenseFiles = licenses.files.map(file => ({ ...file, path: `@license/${file.path}` }));
  const files = [original, ...initial.files.filter(file => file.path !== 'SKILL.md'), ...licenseFiles];
  if (new Set(files.map(file => file.path)).size !== files.length) fail('installed_skill_resource_collision');
  if (files.length > 128 || files.reduce((sum, file) => sum + file.bytes, 0) > 1024 * 1024) fail('installed_skill_bundle_limit');
  const again = await readTree(skillRoot, signal), licensesAgain = await readTree(licenseRoot, signal), recordAgain = await readText(recordFile, { signal, maxBytes: 1024 * 1024 });
  await directory(generation, root);
  if (initial.identity !== again.identity || licenses.identity !== licensesAgain.identity || record.contentHash !== recordAgain.contentHash) fail('installed_skill_changed');
  const fileProof = inventory(files), packageHash = hash(JSON.stringify(fileProof));
  const id = `installed_${hash(canonical({ installationId: installation.installationId, manifestId: manifest.id, packageHash })).slice(0, 24)}`;
  const header = original.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  const skill = { id, name: String(skillMetadataField(header, 'name') || manifest.name || manifest.id).slice(0, 100), description: String(skillMetadataField(header, 'description') || manifest.description || `Installed skill ${manifest.id}`).slice(0, 1000),
    instructions: original.content, resources: files.slice(1).map(({ path, content }) => ({ path, content })),
    source: { kind: 'installed-skill-package', integrity: 'installed_snapshot', installationId: installation.installationId, manifestId: manifest.id, installationRecordHash: record.contentHash,
      repository: source.repository, commit: source.commit, subdirectory: source.subdirectory, packageHash, frozenAt,
      reason: 'Already installed, enabled, trusted and assigned to this project; frozen without a new download or permission grant.',
      compatibility: 'This preserves the installed text package, not an execution environment or proof of task quality. Dependencies and tool requirements still require candidate review and validation.',
      licenseReview: 'preserved_not_legal_approval', licensePaths: licenseFiles.map(file => file.path), files: fileProof } };
  validateMarketplaceSkillBytes(skill);
  return { skill, receipt: { manifestId: manifest.id, installationId: installation.installationId, genomeSkillId: id, packageHash, installationRecordHash: record.contentHash,
    proof: { integrity: 'installed_snapshot', completeInstalledDirectory: true, stableDoubleRead: true, atomicFilesystemSnapshot: false, installationHashVerifiedPaths: ['SKILL.md', ...licenseFiles.map(file => file.path)], remoteGitBlobVerification: false, files: fileProof } } };
}

/** Reads only existing authorized installation generations. No download, write,
 * registry change, activation, code execution, or baseline mutation occurs. */
export async function freezeAssignedInstalledSkills(store, project, { signal } = {}) {
  cancelled(signal);
  const scope = projectScope(store, typeof project === 'string' ? project : project.id), skills = [], imports = [], diagnostics = [];
  if (!scope.manifests.length) return { skills, imports, diagnostics, scopeHash: scope.hash };
  const configuredRoot = resolve(`${store.file}.capabilities`);
  let root; try { root = await realpath(configuredRoot); if (root !== configuredRoot) fail('installed_skill_unsafe_path'); await directory(root, root); }
  catch (error) { cancelled(signal); return { skills, imports, diagnostics: scope.manifests.map(row => ({ manifestId: row.id, installationId: row.installationId, code: error.code?.startsWith('installed_skill_') ? error.code : 'installed_skill_read_failed' })), scopeHash: scope.hash }; }
  const frozenAt = new Date().toISOString();
  for (const manifest of scope.manifests) {
    cancelled(signal);
    try {
      const matches = scope.installations.filter(row => row.installationId === manifest.installationId);
      if (matches.length !== 1) fail('installed_skill_receipt_missing');
      const frozen = await freezeOne(manifest, matches[0], root, signal, frozenAt);
      skills.push(frozen.skill); imports.push(frozen.receipt);
    } catch (error) { cancelled(signal); diagnostics.push({ manifestId: manifest.id, installationId: manifest.installationId, code: error.code?.startsWith('installed_skill_') ? error.code : 'installed_skill_read_failed' }); }
  }
  cancelled(signal);
  if (projectScope(store, scope.projectId).hash !== scope.hash) fail('installed_skill_scope_changed');
  return { skills, imports, diagnostics, scopeHash: scope.hash };
}
