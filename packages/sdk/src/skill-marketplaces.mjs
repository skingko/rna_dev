import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from './zip-reader.mjs';
import { skillMetadataField } from './capabilities.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const copy = value => structuredClone(value);
const clean = (value, max = 1000) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
const providers = ['clawhub', 'skills-sh', 'skillsmp'];
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const safePath = path => typeof path === 'string' && path.length <= 400 && /^[A-Za-z0-9_.@+ -]+(?:\/[A-Za-z0-9_.@+ -]+)*$/.test(path) && path.split('/').every(part => !['.', '..', '.git', 'node_modules'].includes(part));
export class SkillMarketplaceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'SkillMarketplaceError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new SkillMarketplaceError(code, message, status); };
const validateProvider = provider => { if (!providers.includes(provider)) fail('marketplace_provider', 'Unknown skill marketplace'); return provider; };
const frontmatter = (content, key) => skillMetadataField(String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '', key);
const LICENSE_NAMES = ['LICENSE', 'LICENCE', 'COPYING', 'NOTICE'];
const LICENSE_PATTERN = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-][A-Za-z0-9.-]+)?$/i;
const isLicense = path => path.startsWith('@license/') || LICENSE_PATTERN.test(path.split('/').at(-1));
/** Text when the bytes are valid UTF-8 without NUL, else null (binary). */
const textOf = buffer => { if (buffer.includes(0)) return null; try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; } };
/** git with no prompts, hooks or LFS downloads; output as text. */
function runGit(args, { signal, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'protocol.file.allow=never', '-c', 'core.hooksPath=/dev/null', ...args], { signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo' } },
      (error, stdout) => error ? reject(Object.assign(new SkillMarketplaceError(signal?.aborted ? 'marketplace_cancelled' : 'marketplace_source_unavailable', 'The skill source repository could not be read', 502), { cause: error })) : resolve(stdout));
  });
}

/** Normalize one ClawHub search row: its own package (owner/slug) or an aggregated skills.sh skill. */
function clawhubEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const verdict = String(row.trust?.clawHubVerdict ?? '').toLowerCase();
  if (row.trust?.installability && row.trust.installability !== 'installable' || ['malicious', 'suspicious', 'blocked'].includes(verdict)) return null;
  const summary = clean(String(row.summary ?? '').replace(/^#\s+[^\n]*?\s{1,}(?=[A-Z0-9])/, '').replace(/^#+\s*/, ''), 1200), name = clean(row.displayName ?? row.slug, 200);
  const base = { provider: 'clawhub', name, description: summary, popularity: Number.isFinite(row.downloads) ? row.downloads : null, trust: 'unreviewed_public_source', compatible: 'requires_source_inspection', refHint: 'HEAD' };
  if (row.source === 'skills-sh') {
    const match = /^skills-sh:([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(row.install?.reference ?? row.id ?? '');
    if (!match) return null;
    const [, owner, repo, slug] = match, repository = `${owner}/${repo}`;
    return { ...base, id: `${repository}/${slug}`, kind: 'skills-sh', repository, slug, sourceUrl: `https://github.com/${repository}`, catalogUrl: `https://skills.sh/${repository}/${slug}`, installCommand: `npx skills add ${repository} --skill ${slug}` };
  }
  if (row.source === 'clawhub') {
    const owner = row.ownerHandle ?? row.owner?.handle, slug = row.slug;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(owner ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(slug ?? '')) return null;
    return { ...base, id: `${owner}/${slug}`, kind: 'clawhub', owner, slug, repository: `clawhub.ai/${owner}/${slug}`, sourceUrl: `https://clawhub.ai/${owner}/skills/${slug}`, catalogUrl: `https://clawhub.ai/${owner}/skills/${slug}`, installCommand: `npx clawhub install ${slug}`, ...(row.version ? { version: clean(row.version, 40) } : {}) };
  }
  return null;
}
/** Public catalog metadata is discovery evidence, never a trust or quality grant.
 * Only fixed official endpoints and public GitHub source are requested. No CLI,
 * package lifecycle, skill script, arbitrary URL or workspace file is executed. */
export class SkillMarketplaceClient {
  constructor({ fetchImpl = fetch, skillsmpApiKey = () => undefined, git = runGit, timeoutMs = 15000, acquisitionTimeoutMs = 90000 } = {}) {
    this.fetch = fetchImpl; this.skillsmpApiKey = skillsmpApiKey; this.git = git; this.timeoutMs = timeoutMs; this.acquisitionTimeoutMs = acquisitionTimeoutMs;
    this.entries = new Map(); this.snapshots = new Map(); this.readers = new Map();
  }
  fork() { return new SkillMarketplaceClient({ fetchImpl: this.fetch, skillsmpApiKey: this.skillsmpApiKey, git: this.git, timeoutMs: this.timeoutMs, acquisitionTimeoutMs: this.acquisitionTimeoutMs }); }
  catalog() { return [
    { id: 'clawhub', name: 'ClawHub', url: 'https://clawhub.ai', docsUrl: 'https://docs.openclaw.ai/clawhub', search: 'semantic', authentication: 'not_required', capabilities: ['semantic_search', 'versioned_package_download', 'aggregates_skills_sh'], plugins: false },
    { id: 'skills-sh', name: 'skills.sh', url: 'https://skills.sh', docsUrl: 'https://skills.sh/docs/cli', search: 'official_cli_public_endpoint', authentication: 'not_required', capabilities: ['keyword_search', 'github_skill_source'], plugins: false },
    { id: 'skillsmp', name: 'SkillsMP', url: 'https://skillsmp.com', docsUrl: 'https://skillsmp.com/docs/api', search: 'keyword', authentication: this.skillsmpApiKey() ? 'configured' : 'anonymous_limited', credentialEnv: 'SKILLSMP_API_KEY', capabilities: ['keyword_search', 'github_skill_source'], plugins: false },
  ]; }
  request(url, options = {}) { return this.fetchSource(url, options); }
  async fetchSource(url, { signal, apiKey, maxBytes = 2 * 1024 * 1024, json = true, binary = false } = {}) {
    // Package downloads (zip) get twice the per-request allowance of a search.
    const timeout = AbortSignal.timeout(binary ? this.timeoutMs * 2 : this.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // skills.sh's documented canonical host is www; never forward credentials
      // to a redirect or to source URLs returned by a catalog.
      const response = await this.fetch(url, { method: 'GET', signal: combined, redirect: 'error', headers: { accept: json ? 'application/json' : 'text/plain', 'user-agent': 'Rna-Agent-Skill-Discovery/1', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // GitHub signals an exhausted quota with 403/429 and x-ratelimit-remaining: 0 — a wait, not a refusal.
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') throw Object.assign(new SkillMarketplaceError('marketplace_rate_limit', 'GitHub API rate limit reached; retry after it resets', 503), Number.isFinite(reset) && reset > 0 ? { retryAt: reset } : {});
        fail(response.status === 401 || response.status === 403 ? 'marketplace_auth' : response.status === 429 ? 'marketplace_rate_limit' : response.status === 404 ? 'marketplace_not_found' : 'marketplace_http', `Skill source request returned HTTP ${response.status}`, response.status === 429 ? 429 : 502);
      }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel().catch(() => {}); fail('marketplace_response_limit', 'Skill source response exceeded the byte limit', 502); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) { combined.throwIfAborted(); bytes += chunk.length; if (bytes > maxBytes) fail('marketplace_response_limit', 'Skill source response exceeded the byte limit', 502); chunks.push(chunk); }
      combined.throwIfAborted(); if (binary) return Buffer.concat(chunks); const body = Buffer.concat(chunks).toString('utf8');
      if (!json) return body;
      try { return JSON.parse(body); } catch { fail('marketplace_response_invalid', 'Skill source did not return valid JSON', 502); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SkillMarketplaceError) throw error;
      fail(timeout.aborted ? 'marketplace_timeout' : 'marketplace_unavailable', timeout.aborted ? 'Skill source request timed out' : 'Skill source is unavailable', 502);
    }
  }
  async search({ provider = 'skills-sh', query, limit = 5 } = {}, { signal } = {}) {
    validateProvider(provider);
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 160 || /[\x00-\x1f]/.test(query) || query.trim() === '*') fail('marketplace_query', 'Search needs 2–160 characters of public capability keywords');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail('marketplace_limit', 'Search limit must be 1–10');
    const endpoint = provider === 'clawhub' ? 'https://clawhub.ai/api/v1/search' : provider === 'skills-sh' ? 'https://www.skills.sh/api/search' : 'https://skillsmp.com/api/v1/skills/search';
    const data = await this.request(`${endpoint}?${new URLSearchParams({ q: query.trim(), limit })}`, { signal, ...(provider === 'skillsmp' ? { apiKey: this.skillsmpApiKey() } : {}) });
    const rows = provider === 'clawhub' ? data.results : provider === 'skills-sh' ? data.skills : data.success === true ? data.data?.skills : null;
    if (!Array.isArray(rows)) fail('marketplace_response_invalid', 'Skill marketplace search shape is unsupported', 502);
    const results = [], seen = new Set(), reasons = new Map(); let duplicateCount = 0;
    const unsupported = code => { reasons.set(code, (reasons.get(code) ?? 0) + 1); };
    for (const row of rows.slice(0, limit)) {
      if (provider === 'clawhub') {
        // ClawHub returns its own packages and skills.sh skills it aggregates, each with a summary and
        // an installability/moderation verdict; flagged or uninstallable rows never reach a judge.
        const entry = clawhubEntry(row);
        if (!entry) { unsupported('unsupported_catalog_row'); continue; }
        if (seen.has(entry.id)) { duplicateCount++; continue; } seen.add(entry.id);
        this.entries.set(`${provider}:${entry.id}`, entry); results.push(copy(entry)); continue;
      }
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,499}$/.test(row.id)) { unsupported('invalid_catalog_identity'); continue; }
      let repository, pathHint, refHint = 'HEAD', slug;
      if (provider === 'skills-sh') { repository = row.source; slug = row.skillId ?? row.id.split('/').at(-1); if (!repoPattern.test(repository ?? '') || typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug) || row.id !== `${repository}/${slug}`) { unsupported('unsupported_catalog_source'); continue; } }
      else {
        let url; try { url = new URL(row.githubUrl); } catch { unsupported('unsupported_source_url'); continue; }
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) { unsupported('unsupported_source_url'); continue; }
        let parts; try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { unsupported('unsupported_source_path'); continue; }
        repository = parts.slice(0, 2).join('/');
        if (!repoPattern.test(repository) || !['tree', 'blob'].includes(parts[2]) || parts.length < 4 || parts.some(part => part.includes('/') || part.includes('\\'))) { unsupported('unsupported_source_path'); continue; }
        refHint = parts[3]; const packageParts = parts.slice(4);
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(refHint) || ['.', '..'].includes(refHint) || parts[2] === 'blob' && packageParts.at(-1) !== 'SKILL.md') { unsupported('unsupported_source_path'); continue; }
        if (packageParts.at(-1) === 'SKILL.md') packageParts.pop();
        pathHint = packageParts.join('/') || '.'; if (pathHint !== '.' && !safePath(pathHint)) { unsupported('unsupported_source_path'); continue; }
      }
      if (seen.has(row.id)) { duplicateCount++; continue; } seen.add(row.id);
      let catalogUrl = provider === 'skills-sh' ? `https://skills.sh/${row.id}` : 'https://skillsmp.com';
      if (provider === 'skillsmp') try { const url = new URL(row.skillUrl); if (url.protocol === 'https:' && url.hostname === 'skillsmp.com' && !url.username && !url.password && !url.search && !url.hash) catalogUrl = url.href; } catch { /* no invented deep-link when the catalog omits one */ }
      const entry = { provider, id: row.id, name: clean(row.name, 200), description: clean(row.description, 1200), repository, ...(slug ? { slug } : {}), ...(pathHint ? { pathHint } : {}), refHint,
        // The marketplace's own one-command install (the official `skills` CLI), shown to people and agents.
        installCommand: provider === 'skills-sh' ? `npx skills add ${repository} --skill ${slug}` : `npx skills add https://github.com/${repository}/tree/${refHint}${pathHint && pathHint !== '.' ? `/${pathHint}` : ''}`,
        sourceUrl: `https://github.com/${repository}`, catalogUrl, popularity: Number.isFinite(row.installs ?? row.stars) ? (row.installs ?? row.stars) : null, trust: 'unreviewed_public_source', compatible: 'requires_source_inspection' };
      this.entries.set(`${provider}:${entry.id}`, entry); results.push(copy(entry));
    }
    while (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value);
    // skills.sh search carries no description: read each result's own SKILL.md from the snapshot (in
    // parallel, bounded) so a judge sees what the skill does; the snapshot is reused by read/acquire.
    if (provider === 'skills-sh' && results.some(row => !row.description)) {
      const budget = AbortSignal.timeout(8000), enrich = signal ? AbortSignal.any([signal, budget]) : budget;
      let limited = false;
      await Promise.all(results.map(async row => {
        if (row.description || limited) return;
        try {
          const entry = this.entries.get(`${provider}:${row.id}`), snapshot = await this.snapshot(entry, { signal: enrich, downloadOnly: true });
          const description = clean(frontmatter(snapshot.files.find(file => file.path === 'SKILL.md')?.content, 'description'), 1200);
          if (description) { entry.description = description; row.description = description; }
        } catch (error) { if (error?.code === 'marketplace_rate_limit') limited = true; /* the result keeps its name and package path */ }
      }));
      signal?.throwIfAborted();
    }
    const inspectedCount = Math.min(rows.length, limit), unsupportedCount = [...reasons.values()].reduce((sum, count) => sum + count, 0), omittedCount = rows.length - inspectedCount;
    const status = rows.length === 0 ? 'empty' : results.length === 0 ? 'unsupported' : unsupportedCount || omittedCount ? 'partial' : 'complete';
    return { provider, query: query.trim(), results, retrievedAt: new Date().toISOString(), rankingMeaning: 'discovery_only_not_quality_or_safety', skippedUnsupported: unsupportedCount,
      coverage: { status, returnedCount: rows.length, inspectedCount, supportedCount: results.length, unsupportedCount, duplicateCount, omittedCount, reasons: [...reasons].map(([code, count]) => ({ code, count })) } };
  }
  async read(input = {}, options = {}) {
    const key = `${input.provider}:${input.id}`, previous = this.readers.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.readPinned(input, options)); this.readers.set(key, operation);
    try { return await operation; } finally { if (this.readers.get(key) === operation) this.readers.delete(key); }
  }
  entry(provider, id) {
    validateProvider(provider);
    const entry = this.entries.get(`${provider}:${id}`);
    if (!entry) fail('marketplace_search_required', 'Search this marketplace before inspecting a result; arbitrary repositories are not accepted', 409);
    return entry;
  }
  /** One skill's files, the way the official `skills` CLI gets them: the skills.sh snapshot endpoint
   * (/api/download/{owner}/{repo}/{skill}) for skills it has indexed, otherwise a sparse shallow git
   * checkout of only the skill directory (plus repository-root license files). Neither path calls the
   * GitHub REST API, so installs are not bound by its anonymous quota. */
  async snapshot(entry, { signal, downloadOnly = false } = {}) {
    const key = `${entry.provider}:${entry.id}`;
    if (this.snapshots.has(key)) return this.snapshots.get(key);
    const [owner, repo] = entry.repository.split('/');
    const directory = entry.pathHint && entry.pathHint !== '.' ? entry.pathHint : null;
    const slug = entry.slug ?? (directory ? directory.split('/').at(-1) : repo);
    let files = null, commit = null, via, unsupported = [];
    if (entry.kind === 'clawhub') {
      // ClawHub package: a versioned zip from its own download endpoint; the archive digest pins it.
      const archive = await this.fetchSource(`https://clawhub.ai/api/v1/download?${new URLSearchParams({ slug: entry.slug, ownerHandle: entry.owner })}`, { signal, binary: true, maxBytes: 8 * 1024 * 1024 });
      let entries; try { entries = readZip(archive); } catch (error) { fail('marketplace_package_invalid', `ClawHub package could not be read: ${error.message}`, 502); }
      files = []; unsupported = [];
      for (const row of entries) {
        if (row.path === '_meta.json') continue;
        if (row.symlink || !safePath(row.path)) { unsupported.push(row.path); continue; }
        const text = textOf(row.data);
        files.push(text === null ? { path: row.path, bytes: row.data.length, binary: true } : { path: row.path, content: text, bytes: row.data.length });
      }
      if (!files.some(file => file.path === 'SKILL.md' && !file.binary)) fail('marketplace_skill_missing', 'The skill has no readable SKILL.md', 404);
      const snapshot = { commit: createHash('sha1').update(archive).digest('hex'), via: 'clawhub', files, unsupported, subdirectory: '.' };
      this.snapshots.set(key, snapshot); while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value);
      return snapshot;
    }
    try {
      const data = await this.request(`https://skills.sh/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`, { signal, maxBytes: 8 * 1024 * 1024 });
      if (Array.isArray(data?.files) && data.files.length && data.files.every(file => typeof file?.path === 'string' && typeof file.contents === 'string'))
        files = data.files.filter(file => safePath(file.path)).map(file => ({ path: file.path, content: file.contents, bytes: Buffer.byteLength(file.contents) })), via = 'skills.sh';
    } catch (error) { if (signal?.aborted) throw signal.reason ?? error; if (!(error instanceof SkillMarketplaceError) || downloadOnly) throw error; /* not indexed, rate limited or unavailable: use git */ }
    if (!files && downloadOnly) fail('marketplace_skill_missing', 'The skills.sh snapshot has no files', 404);
    let located;
    if (!files) ({ files, commit, unsupported, directory: located } = await this.gitSnapshot({ repository: entry.repository, directory, slug, ref: entry.refHint, signal })), via = 'git';
    if (!files.some(file => file.path === 'SKILL.md' && !file.binary)) fail('marketplace_skill_missing', 'The skill has no readable SKILL.md', 404);
    commit ??= await this.headCommit(entry.repository, entry.refHint, { signal });
    // A skills.sh snapshot holds only the skill directory: keep the repository-root license (plain file
    // download at the pinned commit, not the REST API) so provenance matches the git path.
    if (via === 'skills.sh' && !files.some(file => isLicense(file.path))) for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'LICENCE']) {
      try { const text = await this.request(`https://raw.githubusercontent.com/${entry.repository}/${commit}/${name}`, { signal, json: false, maxBytes: 64000 }); if (typeof text === 'string' && text.trim()) { files.push({ path: `@license/${name}`, content: text, bytes: Buffer.byteLength(text) }); break; } }
      catch (error) { if (signal?.aborted) throw signal.reason ?? error; }
    }
    // Provenance and later explicit installs need the skill's real directory in the repository.
    const subdirectory = directory ?? located ?? (via === 'skills.sh' ? await this.locateSkill(entry.repository, commit, slug, files.find(file => file.path === 'SKILL.md').content, { signal }) : '.');
    const snapshot = { commit, via, files, unsupported, subdirectory };
    this.snapshots.set(key, snapshot); while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value);
    return snapshot;
  }
  /** Directory of a skills.sh skill inside its repository: the usual locations are checked against the
   * snapshot's SKILL.md bytes (plain file downloads); otherwise a tree-only git clone lists the paths. */
  async locateSkill(repository, commit, slug, content, { signal } = {}) {
    for (const candidate of [`skills/${slug}`, slug, `.claude/skills/${slug}`, `.agents/skills/${slug}`, `.cursor/skills/${slug}`]) {
      try { if (await this.request(`https://raw.githubusercontent.com/${repository}/${commit}/${candidate.split('/').map(encodeURIComponent).join('/')}/SKILL.md`, { signal, json: false, maxBytes: 64000 }) === content) return candidate; }
      catch (error) { if (signal?.aborted) throw signal.reason ?? error; }
    }
    const root = await mkdtemp(join(tmpdir(), 'rna-skill-tree-')), checkout = join(root, 'repo');
    try {
      await this.git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', `https://github.com/${repository}.git`, checkout], { signal, timeoutMs: 60000 });
      const paths = String(await this.git(['-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD'], { signal, timeoutMs: 20000 })).split('\n').filter(path => path.endsWith(`/${slug}/SKILL.md`) || path === `${slug}/SKILL.md`);
      paths.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
      if (paths[0]) return paths[0].slice(0, -'/SKILL.md'.length);
    } catch (error) { if (signal?.aborted) throw signal.reason ?? error; }
    finally { await rm(root, { recursive: true, force: true }); }
    return slug;
  }
  /** Current commit of a public repository through the git protocol (not the REST API). */
  async headCommit(repository, ref = 'HEAD', { signal } = {}) {
    const output = await this.git(['ls-remote', `https://github.com/${repository}.git`, ref && ref !== 'HEAD' ? ref : 'HEAD'], { signal, timeoutMs: 20000 });
    const sha = String(output).split('\n').map(line => line.split('\t')[0]).find(value => /^[0-9a-f]{40}$/.test(value));
    if (!sha) fail('marketplace_source_identity', 'The repository did not report a fixed commit', 502);
    return sha;
  }
  async gitSnapshot({ repository, directory, slug, ref, signal }) {
    const root = await mkdtemp(join(tmpdir(), 'rna-skill-')), checkout = join(root, 'repo');
    try {
      await this.git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', ...(ref && ref !== 'HEAD' ? ['--branch', ref] : []), `https://github.com/${repository}.git`, checkout], { signal, timeoutMs: 60000 });
      // A catalog name without a path: the tree listing (no file contents) names its directory.
      if (!directory && slug) {
        const paths = String(await this.git(['-C', checkout, 'ls-tree', '-r', '--name-only', 'HEAD'], { signal, timeoutMs: 20000 })).split('\n').filter(path => path.endsWith(`/${slug}/SKILL.md`) || path === `${slug}/SKILL.md`);
        paths.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
        if (paths[0]) directory = paths[0].slice(0, -'/SKILL.md'.length);
      }
      await this.git(['-C', checkout, 'sparse-checkout', 'set', '--no-cone', ...(directory ? [`/${directory}/`] : ['/*']), ...LICENSE_NAMES.map(name => `/${name}*`)], { signal, timeoutMs: 20000 });
      await this.git(['-C', checkout, 'checkout'], { signal, timeoutMs: 60000 });
      const commit = String(await this.git(['-C', checkout, 'rev-parse', 'HEAD'], { signal, timeoutMs: 10000 })).trim();
      const files = [], unsupported = [];
      const walk = async (dir, prefix) => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const path = prefix ? `${prefix}/${item.name}` : item.name, full = join(dir, item.name);
          if (item.name === '.git') continue;
          if (item.isSymbolicLink() || !safePath(path)) { unsupported.push(path); continue; }
          if (item.isDirectory()) { await walk(full, path); continue; }
          if (!item.isFile() || files.length >= 5000) continue;
          const buffer = await readFile(full), text = textOf(buffer);
          files.push(text === null ? { path, bytes: buffer.length, binary: true } : { path, content: text, bytes: buffer.length });
        }
      };
      await walk(directory ? join(checkout, directory) : checkout, '');
      // Repository-root license files of a nested skill are kept under @license/.
      if (directory) for (const item of await readdir(checkout, { withFileTypes: true })) if (item.isFile() && LICENSE_PATTERN.test(item.name)) { const text = textOf(await readFile(join(checkout, item.name))); if (text !== null) files.push({ path: `@license/${item.name}`, content: text, bytes: Buffer.byteLength(text) }); }
      return { commit, files, unsupported, directory: directory ?? '.' };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async readPinned({ provider, id, path = 'SKILL.md' } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!safePath(path) && !/^@license\/[A-Za-z0-9_.-]+$/.test(path)) fail('marketplace_path', 'Skill resource requires a safe package-relative path');
    const entry = this.entry(provider, id), snapshot = await this.snapshot(entry, { signal });
    const file = snapshot.files.find(row => row.path === path);
    if (!file) fail('marketplace_resource_limit', 'Resource is missing from the skill snapshot');
    if (file.binary) fail('marketplace_binary_resource', 'Binary skill resources are not loaded into the model');
    if (file.bytes > 64000) fail('marketplace_resource_limit', 'Resource exceeds 64 KB');
    const licenseFiles = snapshot.files.filter(row => isLicense(row.path)).map(row => ({ path: row.path, resourcePath: row.path, bytes: row.bytes }));
    return { provider, id, repository: entry.repository, commit: snapshot.commit, subdirectory: snapshot.subdirectory, sourceUrl: entry.sourceUrl, catalogUrl: entry.catalogUrl, via: snapshot.via,
      path, content: file.content, contentHash: hash(file.content), bytes: file.bytes,
      resources: snapshot.files.filter(row => row.path !== 'SKILL.md' && !isLicense(row.path)).map(row => ({ path: row.path, bytes: row.bytes })), licenseFiles, unsupportedFiles: [...snapshot.unsupported],
      licenseReview: licenseFiles.length ? 'preserved_not_legal_approval' : 'no_license_declared_local_use', installCommand: entry.installCommand,
      trust: 'untrusted_reference_not_instructions', installed: false, executesCode: false,
      ...(entry.kind === 'clawhub' ? {} : { installInput: { kind: 'skill', source: { type: 'git', repository: `https://github.com/${entry.repository}.git`, ref: snapshot.commit, subdirectory: snapshot.subdirectory }, activate: false } }) };
  }

  /** Acquire a skill package from its snapshot. SKILL.md and license files are always complete; supporting
   * resources a model could not read anyway (over 64 KB, binary, symlinks) or beyond the package budget
   * (128 files, 1 MB) are listed in omittedFiles instead of rejecting the package. No fetched code runs. */
  async acquire({ provider, id } = {}, { signal } = {}) {
    const parentSignal = signal, deadline = AbortSignal.timeout(this.acquisitionTimeoutMs);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const entry = this.entry(provider, id), snapshot = await this.snapshot(entry, { signal });
      const skill = snapshot.files.find(row => row.path === 'SKILL.md');
      if (skill.bytes > 64000) fail('marketplace_bundle_limit', 'SKILL.md exceeds 64 KB');
      const licenses = snapshot.files.filter(row => isLicense(row.path) && !row.binary && row.bytes <= 64000);
      const omittedFiles = snapshot.unsupported.map(path => ({ path, reason: 'unsupported_path' })), kept = [];
      let budget = 1024 * 1024 - skill.bytes - licenses.reduce((sum, row) => sum + row.bytes, 0);
      for (const row of snapshot.files) {
        if (row === skill || licenses.includes(row)) continue;
        if (row.binary) omittedFiles.push({ path: row.path, reason: 'binary' });
        else if (row.bytes > 64000) omittedFiles.push({ path: row.path, reason: 'over_64kb' });
        else if (kept.length + licenses.length + 1 >= 128 || row.bytes > budget) omittedFiles.push({ path: row.path, reason: 'package_budget' });
        else { kept.push(row); budget -= row.bytes; }
      }
      const files = [skill, ...kept, ...licenses].map(row => ({ path: row.path, content: row.content, contentHash: hash(row.content), bytes: row.bytes }));
      const licensePaths = licenses.map(row => row.path), licenseReview = licensePaths.length ? 'preserved_not_legal_approval' : 'no_license_declared_local_use';
      return { provider, id, repository: entry.repository, commit: snapshot.commit, subdirectory: snapshot.subdirectory, sourceUrl: entry.sourceUrl, catalogUrl: entry.catalogUrl,
        files, licensePaths, licenseReview, omittedFiles, packageHash: hash(JSON.stringify(files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })))), acquiredAt: new Date().toISOString(), installed: false, executesCode: false };
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (deadline.aborted) fail('marketplace_acquisition_timeout', 'Complete skill acquisition exceeded its total time limit; no partial package was selected', 502);
      throw error;
    }
  }
}
