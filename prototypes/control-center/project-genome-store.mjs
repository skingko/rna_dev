import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { genomeToolName, genomeNamespace, projectGenomeHash, validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { projectSkillDocument } from '../../packages/sdk/src/marketplace-genome-skills.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'invalid_genome_store') => { throw Object.assign(new Error(message), { code, status: 400 }); };
const identity = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) fail('项目版本标识无效'); return value; };
const inside = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
export const genomeSkillId = (namespace, localId) => `gen-${digest(namespace).slice(0, 16)}-${localId}`;
/** Storage identity of one generation (record.json, bundle hashes): never the model-facing name. */
export const projectGenomeNamespace = (projectId, versionId) => `${projectId}:${versionId}`;
/** Model-facing identity of a project's generated tools and skills (EVO-3): the same for every generation of the project. */
export const genomeIdentity = projectId => genomeNamespace(projectId);

/** Immutable project generations. Preparing files does not execute generated code. */
export class ProjectGenomeStore {
  constructor(store, { rootDir = resolve(`${store.file}.genomes`) } = {}) { this.rootDir = resolve(rootDir); }

  async prepare(project, { genome, versionId = randomUUID(), parentVersionId = null, signal } = {}) {
    const projectId = identity(project.id); identity(versionId); if (parentVersionId) identity(parentVersionId);
    const validated = validateProjectGenome(genome), namespace = projectGenomeNamespace(projectId, versionId);
    signal?.throwIfAborted(); await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.rootDir), parent = join(root, projectId); await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink() || !inside(root, await realpath(parent))) fail('项目版本目录不能越出受管目录');
    const stagingDir = join(parent, `.pending-${versionId}-${randomUUID()}`), dir = join(parent, versionId);
    await mkdir(stagingDir, { mode: 0o700 }); let committed = false;
    const files = [], skillManifests = [], toolDescriptors = [];
    const file = async (path, content) => {
      signal?.throwIfAborted(); const target = resolve(stagingDir, path); if (!inside(stagingDir, target) || target === stagingDir) fail('项目版本文件路径无效');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { flag: 'wx', mode: 0o600 }); files.push({ path, hash: digest(content), bytes: Buffer.byteLength(content) });
    };
    try {
      await file('SYSTEM.md', `${validated.systemPrompt}\n`);
      for (const skill of validated.skills) {
        const body = projectSkillDocument(skill);
        await file(`skills/${skill.id}/SKILL.md`, body);
        for (const resource of skill.resources) await file(`skills/${skill.id}/${resource.path}`, resource.content);
        skillManifests.push({ id: genomeSkillId(genomeIdentity(projectId), skill.id), localId: skill.id, name: skill.name, description: skill.description, path: join(dir, 'skills', skill.id, 'SKILL.md'), contentHash: digest(body), enabled: true, trusted: true, generated: !skill.source, ...(skill.source ? { source: structuredClone(skill.source), acquired: true } : {}), managed: 'project-genome', projectId, versionId });
      }
      for (const tool of validated.tools) {
        await file(`tools/${tool.id}.mjs`, `// Executed through Rna's restricted API runner.\nexport default async function (input, api) {\n${tool.script}\n}\n`);
        const id = genomeToolName(genomeIdentity(projectId), tool.id);
        toolDescriptors.push({ kind: 'genome-tool', id, name: tool.name, toolName: id, localId: tool.id, description: tool.description, permission: tool.permission, parameters: structuredClone(tool.parameters), enabled: true, trusted: true, generated: true, managed: 'project-genome', projectId, versionId });
      }
      await file('evaluation.json', `${JSON.stringify(validated.evaluationSuite, null, 2)}\n`);
      await file('genome.json', `${JSON.stringify(validated, null, 2)}\n`);
      const record = { schemaVersion: 1, projectId, versionId, parentVersionId, namespace, dir, hash: projectGenomeHash(validated), genome: validated, files, createdAt: new Date().toISOString() };
      await writeFile(join(stagingDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return { record, skillManifests, toolDescriptors, stagingDir,
        async commit() {
          signal?.throwIfAborted(); if (committed) return record;
          try { await lstat(dir); fail('项目版本已存在，不能覆盖；请创建新版本', 'version_conflict'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await rename(stagingDir, dir); committed = true; return record;
        },
        async rollback() { await rm(committed ? dir : stagingDir, { recursive: true, force: true }); committed = false; }
      };
    } catch (error) { await rm(stagingDir, { recursive: true, force: true }); throw error; }
  }

  async read(projectId, versionId) {
    identity(projectId); identity(versionId);
    const root = await realpath(this.rootDir), expected = join(root, projectId, versionId), dir = await realpath(expected);
    if (dir !== expected || !inside(root, dir)) fail('项目版本路径发生变化');
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'));
    if (record.projectId !== projectId || record.versionId !== versionId || record.dir !== dir || record.schemaVersion !== 1) fail('项目版本记录不匹配');
    const genome = validateProjectGenome(JSON.parse(await readFile(join(dir, 'genome.json'), 'utf8')));
    if (projectGenomeHash(genome) !== record.hash || projectGenomeHash(record.genome) !== record.hash) fail('项目版本内容已变化，请通过创建新版本编辑', 'genome_changed');
    if (!Array.isArray(record.files) || record.files.length > 1600) fail('项目版本文件目录无效');
    for (const entry of record.files) {
      const path = resolve(dir, entry.path); if (!inside(dir, path) || await realpath(path) !== path) fail('项目版本文件越出目录');
      const content = await readFile(path); if (digest(content) !== entry.hash || content.byteLength !== entry.bytes) fail('项目版本文件已变化，请通过创建新版本编辑', 'genome_changed');
    }
    return { ...record, genome };
  }
}
