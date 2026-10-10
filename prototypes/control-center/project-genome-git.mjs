import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { systemPromptSections, projectComponentRegistry } from '../../packages/sdk/src/project-rrsi.mjs';

// P4: every project agent's genome is a small git repository under the state
// directory (RRSI gitops.py). The incumbent is `main`; each candidate is drafted
// in its own worktree on `cand/<versionId>`; adopting fast-forwards `main`;
// rolling back reverts the adopted commit. The genome store stays the source
// of truth; this repo is the audit/diff/lineage mirror. Plain `git` CLI only.

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
const safe = value => String(value ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'item';
const json = value => `${JSON.stringify(value ?? null, null, 2)}\n`;
const branchOf = versionId => `cand/${safe(versionId)}`;
export const GENOME_GIT_AUTHOR = ['-c', 'user.name=Rna Agent', '-c', 'user.email=rna@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false'];

/** Files for one genome snapshot. Source packages keep identity + SKILL.md only. */
export function genomeFiles({ genome, project = {}, versionId = null } = {}) {
  const files = new Map();
  if (genome) {
    for (const section of systemPromptSections(genome.systemPrompt)) files.set(`system/${safe(section.id)}.md`, `${section.content.trim()}\n`);
    for (const skill of genome.skills ?? []) {
      const dir = `skills/${safe(skill.id)}`;
      files.set(`${dir}/SKILL.md`, `---\nname: ${String(skill.name).replace(/\n/g, ' ')}\ndescription: ${String(skill.description).replace(/\n/g, ' ')}\n---\n${skill.instructions}\n`);
      if (skill.source) files.set(`${dir}/SOURCE.json`, json({ kind: skill.source.kind, provider: skill.source.provider ?? null, id: skill.source.id ?? skill.source.manifestId ?? null, commit: skill.source.commit ?? null, packageHash: skill.source.packageHash ?? null }));
      if ((skill.resources ?? []).length) files.set(`${dir}/resources.json`, json(skill.resources.map(row => ({ path: row.path, sha256: hash(row.content ?? ''), bytes: Buffer.byteLength(row.content ?? '') }))));
    }
    for (const tool of genome.tools ?? []) { files.set(`tools/${safe(tool.id)}.json`, json({ id: tool.id, name: tool.name, description: tool.description, permission: tool.permission, parameters: tool.parameters })); if (tool.script) files.set(`tools/${safe(tool.id)}.js`, `${tool.script}\n`); }
    if (genome.evaluationSuite) files.set('evaluation/standard.json', json({ version: genome.evaluationSuite.version, criteria: genome.evaluationSuite.criteria, thresholds: genome.evaluationSuite.thresholds, execution: genome.evaluationSuite.execution ?? null, cases: (genome.evaluationSuite.cases ?? []).map(row => ({ id: row.id, weight: row.weight ?? 1, sha256: hash(row) })) }));
  }
  files.set('agent/mcp.json', json([...(project.assignments?.mcpServerIds ?? [])].sort()));
  files.set('agent/rhythm.json', json({ rhythm: project.rhythm ?? null, schedules: (project.schedules ?? []).filter(row => !row.archivedAt && !row.deletedAt).map(row => ({ id: row.id, cadence: row.cadence ?? row.cron ?? row.intervalMs ?? null, enabled: row.enabled ?? null })) }));
  const initiative = project.initiative ?? {};
  files.set('agent/communication.json', json({ notificationMuted: initiative.notificationMuted ?? null, deferWhileTyping: initiative.deferWhileTyping ?? null, minRelevance: initiative.minRelevance ?? null, style: project.communication ?? null }));
  files.set('GENOME.json', json({ schemaVersion: 1, versionId, components: projectComponentRegistry({ genome, project }).map(({ key, hash: digest }) => ({ key, hash: digest })) }));
  return files;
}
/** Registry key → repository path prefix (per-component history). */
export function componentPath(key) {
  const [component, ...rest] = String(key).split(':'), id = safe(rest.join(':'));
  return { system_section: `system/${id}.md`, skill: `skills/${id}`, tool_description: `tools/${id}.json`, mcp_assignment: 'agent/mcp.json', rhythm: 'agent/rhythm.json', communication_style: 'agent/communication.json', evaluation_standard: 'evaluation' }[component] ?? null;
}

export class ProjectGenomeGit {
  // Default location: `<state>.evolution/<projectId>/rrsi/genome` (inside the checkpointed evolution sidecar).
  constructor(store, { root = resolve(`${store.file}.evolution`), dirOf = (base, projectId) => join(base, projectId, 'rrsi', 'genome'), git = 'git', timeoutMs = 20000 } = {}) { this.store = store; this.root = root; this.dirOf = dirOf; this.git = git; this.timeoutMs = timeoutMs; this.queues = new Map(); this.disabled = null; }
  dir(projectId) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId ?? '')) throw Object.assign(new Error('invalid project id'), { code: 'genome_git_project' }); return this.dirOf(this.root, projectId); }
  /** Serialize per project; git state is single-writer. */
  serial(projectId, work) { const previous = this.queues.get(projectId) ?? Promise.resolve(), next = previous.catch(() => {}).then(work); this.queues.set(projectId, next); return next.finally(() => { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }); }
  run(cwd, args, { allowFailure = false } = {}) {
    // GIT_CEILING_DIRECTORIES stops discovery at the genome root, so a missing
    // .git can never fall through to an enclosing product repository.
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    return new Promise((resolvePromise, reject) => execFile(this.git, [...GENOME_GIT_AUTHOR, ...args], { cwd, env, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) return reject(Object.assign(new Error(`git ${args[0]} failed: ${String(stderr || error.message).slice(-400)}`), { code: error.code === 'ENOENT' ? 'genome_git_unavailable' : 'genome_git_failed' }));
      resolvePromise({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    }));
  }
  async available() { if (this.disabled === null) { try { await this.run(process.cwd(), ['--version']); this.disabled = false; } catch { this.disabled = true; } } return !this.disabled; }
  async ensure(projectId) {
    const dir = this.dir(projectId); if (this.verified?.has(dir)) return dir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try { await stat(join(dir, '.git')); } catch { await this.run(dir, ['init', '-q', '-b', 'main']); await writeFile(join(dir, '.gitignore'), '.worktrees/\n'); await this.run(dir, ['add', '-A']); await this.run(dir, ['commit', '-q', '-m', 'genome: repository created']); }
    // Defense in depth (once per process and repo): the toplevel must be exactly this directory.
    const top = (await this.run(dir, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== await realpath(dir)) throw Object.assign(new Error('genome repository escaped its directory'), { code: 'genome_git_scope' });
    (this.verified ??= new Set()).add(dir); return dir;
  }
  async write(dir, files) {
    for (const entry of await readdir(dir)) if (!['.git', '.gitignore', '.worktrees'].includes(entry)) await rm(join(dir, entry), { recursive: true, force: true });
    for (const [path, content] of files) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), content); }
  }
  async commitAll(cwd, message) {
    // "Nothing to commit" is a normal no-op (exit 1), not an error.
    await this.run(cwd, ['add', '-A']); await this.run(cwd, ['commit', '-q', '-m', message], { allowFailure: true });
    return (await this.run(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  /** Make `main` equal to a genome snapshot (baseline sync or non-ff adoption). */
  snapshot(projectId, { genome, project, versionId, message } = {}) {
    return this.serial(projectId, async () => { const dir = await this.ensure(projectId); await this.write(dir, genomeFiles({ genome, project, versionId })); const commit = await this.commitAll(dir, message ?? `genome: ${versionId ?? 'snapshot'}`); if (versionId) await this.run(dir, ['tag', '-f', `v/${safe(versionId)}`, commit]); return { commit }; });
  }
  /** Draft a candidate in its own worktree on cand/<versionId> off the incumbent. */
  candidate(projectId, { baseline, genome, project, versionId, parentVersionId, message, edits = [] } = {}) {
    return this.serial(projectId, async () => {
      // The main working tree always stays on `main`; candidates never switch it.
      const dir = await this.ensure(projectId);
      await this.write(dir, genomeFiles({ genome: baseline, project, versionId: parentVersionId })); const base = await this.commitAll(dir, `genome: sync incumbent ${parentVersionId ?? ''}`.trim());
      const branch = branchOf(versionId), tree = join(dir, '.worktrees', safe(versionId));
      if (await stat(tree).then(() => true, () => false)) await this.run(dir, ['worktree', 'remove', '--force', tree], { allowFailure: true });
      await this.run(dir, ['worktree', 'add', '-q', '-B', branch, tree, base]);
      try {
        await this.write(tree, genomeFiles({ genome, project, versionId }));
        const body = edits.map(row => `- [${row.component}] ${row.key} (${row.change}): ${String(row.hypothesis ?? '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
        const commit = await this.commitAll(tree, `${message ?? `candidate ${versionId}`}\n\n${body}`.trim());
        const out = (await this.run(dir, ['diff', '--no-color', '--stat', '--patch', `${base}..${commit}`])).stdout, split = out.indexOf('\ndiff --git ');
        const diffStat = (split < 0 ? out : out.slice(0, split)).trim(), diff = split < 0 ? '' : out.slice(split + 1);
        return { branch, base, commit, diffStat: diffStat.slice(-4000), diff: diff.slice(0, 200000), diffTruncated: diff.length > 200000 };
      } finally { await this.run(dir, ['worktree', 'remove', '--force', tree], { allowFailure: true }); }
    });
  }
  /** Adopt = fast-forward main to the candidate; falls back to a snapshot commit if main moved. */
  adopt(projectId, versionId, fallback = {}) {
    return this.serial(projectId, async () => {
      const dir = await this.ensure(projectId), branch = branchOf(versionId);
      const exists = (await this.run(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })).ok;
      let mode = 'fast_forward';
      if (!exists || !(await this.run(dir, ['merge', '--ff-only', '-q', branch], { allowFailure: true })).ok) { mode = 'snapshot'; await this.write(dir, genomeFiles({ genome: fallback.genome, project: fallback.project, versionId })); await this.commitAll(dir, `adopt ${versionId} (main had moved; snapshot)`); }
      const commit = (await this.run(dir, ['rev-parse', 'HEAD'])).stdout.trim(); await this.run(dir, ['tag', '-f', `adopted/${safe(versionId)}`, commit]); return { mode, commit };
    });
  }
  /** Rollback = revert the adopted commit on main (a new commit; history is kept). */
  rollback(projectId, versionId, fallback = {}) {
    return this.serial(projectId, async () => {
      const dir = await this.ensure(projectId);
      const tag = await this.run(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/adopted/${safe(versionId)}`], { allowFailure: true });
      let mode = 'revert';
      if (!tag.ok || !(await this.run(dir, ['revert', '--no-edit', tag.stdout.trim()], { allowFailure: true })).ok) { await this.run(dir, ['revert', '--abort'], { allowFailure: true }); mode = 'snapshot'; if (fallback.genome) { await this.write(dir, genomeFiles({ genome: fallback.genome, project: fallback.project, versionId: fallback.versionId })); await this.commitAll(dir, `rollback ${versionId} (snapshot of ${fallback.versionId ?? 'parent'})`); } }
      return { mode, commit: (await this.run(dir, ['rev-parse', 'HEAD'])).stdout.trim() };
    });
  }
  /** Per-component (or whole-genome) history on main and candidate branches. */
  async log(projectId, { key, limit = 50 } = {}) {
    const dir = this.dir(projectId); try { await stat(join(dir, '.git')); } catch { return []; }
    const path = key ? componentPath(key) : null; if (key && !path) return [];
    const out = (await this.run(dir, ['log', '--all', `--max-count=${Math.max(1, Math.min(200, limit))}`, '--format=%H%x1f%aI%x1f%D%x1f%s', ...(path ? ['--', path] : [])], { allowFailure: true })).stdout;
    return out.split('\n').filter(Boolean).map(line => { const [commit, at, refs, subject] = line.split('\x1f'); return { commit, at, refs: refs ? refs.split(', ').filter(Boolean) : [], subject }; });
  }
}
