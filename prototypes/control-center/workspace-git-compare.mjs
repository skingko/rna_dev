import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BINARY_PATCH, DIFF_FLAGS, fail, quoteName, splitPatch, wholeLines } from './workspace-git-service.mjs';

// The patch text helpers live with the service (its listing checks binary files with them); re-exported here.
export { quoteName, splitPatch, unquoteName } from './workspace-git-service.mjs';

// 工作区改动 panel, phase 1 of the worktree design (§4): one comparison,
// base → target, as Claude Code's diff panel shows it. `all` is
// merge-base(base, HEAD) → working tree (committed, staged, unstaged and
// untracked work together); `uncommitted` is HEAD (the empty tree before the
// first commit) → working tree. The listing reuses the service's
// changedFiles (the upstream view's path); untracked files are listed one by
// one and their lines counted here, never by a git process per file. Patches
// come in batches from one `git diff` split per file, with untracked files'
// patches written in code. Every read runs through WorkspaceGitService.run
// (no locks, no hooks, no external programs) and may name another worktree of
// the same repository, which the service checks.

const MAX_PATCH_PATHS = 40, MAX_COMPARE_FILES = 3000, LIST_BYTES = 4 * 1024 * 1024;
// Untracked files: the first MB is read and counted, a NUL in the first 8000 bytes (git's own probe) means binary. A
// listing reads at most COUNT_BUDGET bytes; counts are remembered by the file's size and times, so a refresh rereads
// only what changed.
const READ_BYTES = 1024 * 1024, BINARY_PROBE = 8000, COUNT_BUDGET = 64 * 1024 * 1024, COUNT_CACHE = 20000, COUNT_PARALLEL = 16;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BRANCH_FIELDS = ['%(refname)', '%(upstream:short)', '%(objectname)', '%(committerdate:unix)'];
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** `for-each-ref refs/heads` lines (fields split by NUL) → branches; `current` is the branch HEAD is on. */
export function parseBranches(text, current = null) {
  const rows = [];
  for (const line of text.split('\n')) {
    const [ref, upstream, sha, date, worktreePath] = line.split('\0');
    if (!ref?.startsWith('refs/heads/') || !sha) continue;
    const name = ref.slice('refs/heads/'.length), seconds = Number(date);
    rows.push({ name, sha, upstream: upstream || null, committedAt: date && Number.isFinite(seconds) ? seconds * 1000 : null, worktreePath: worktreePath || null, current: name === current });
  }
  return rows;
}
/** The default branch: origin's HEAD, else init.defaultBranch, else main or master, else the current branch — the first that is a local branch. */
export function defaultBranch(names, { remoteHead = null, configured = null, current = null } = {}) {
  for (const name of [remoteHead, configured, 'main', 'master', current]) if (name && names.has(name)) return name;
  return null;
}

/** `ls-files --unmerged -z` records (`<mode> <sha> <stage>\t<path>`) → the conflicted paths, each once, in order. */
export function parseUnmerged(text) {
  const paths = new Set();
  for (const record of text.split('\0')) { const tab = record.indexOf('\t'); if (tab > 0 && record.length > tab + 1) paths.add(record.slice(tab + 1)); }
  return paths;
}
/** Lines as git counts them: newlines, plus a last line without one. */
export function countLines(bytes) {
  let lines = 0;
  for (let index = bytes.indexOf(10); index >= 0; index = bytes.indexOf(10, index + 1)) lines++;
  return bytes.length && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines;
}
/**
 * The patch git prints for a new file (`diff --no-index /dev/null <path>`,
 * with core.quotePath=false), written from its bytes. `complete: false` (the
 * file is past the cap): whole lines only, and no blob id, which would need
 * the rest of the file.
 */
export function newFilePatch(path, bytes, { mode = '100644', complete = true } = {}) {
  const b = quoteName(`b/${path}`);
  let patch = `diff --git ${quoteName(`a/${path}`)} ${b}\nnew file mode ${mode}\n`;
  if (complete) patch += `index 0000000..${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex').slice(0, 7)}\n`;
  let text = bytes.toString('utf8');
  if (!complete) text = text.slice(0, text.lastIndexOf('\n') + 1);
  if (!text) return patch;
  const ends = text.endsWith('\n'), lines = (ends ? text.slice(0, -1) : text).split('\n');
  patch += `--- /dev/null\n+++ ${b}${path.includes(' ') ? '\t' : ''}\n@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n`;
  for (const line of lines) patch += `+${line}\n`;
  return ends ? patch : `${patch}\\ No newline at end of file\n`;
}
/** The first `length` bytes of a regular file (never through a link, never waiting on a pipe); null when it can't be read. */
async function readStart(file, length) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const { bytesRead } = await handle.read(buffer, read, length - read, read); if (!bytesRead) break; read += bytesRead; }
    return buffer.subarray(0, read);
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
async function eachLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } }));
  return results;
}

export class WorkspaceGitCompare {
  constructor(git, { maxFiles = MAX_COMPARE_FILES, countBudget = COUNT_BUDGET } = {}) {
    Object.assign(this, { git, maxFiles, countBudget });
    this.inflight = new Map();
    /** Untracked files' counts by path, size and times. */
    this.counts = new Map();
  }
  say(variants) { return this.git.say(variants); }
  unavailableDiff(reason) { return { kind: 'unavailable', ...this.git.unavailable(reason) }; }
  /** Local branches, the branch HEAD is on (it may have no commit yet) and the default branch. */
  async listBranches(cwd) {
    const git = this.git, refs = fields => git.run(cwd, ['for-each-ref', `--format=${fields.join('%00')}`, 'refs/heads'], { maxBytes: LIST_BYTES });
    let [listed, head, remote, configured] = await Promise.all([
      refs([...BRANCH_FIELDS, '%(worktreepath)']),
      git.run(cwd, ['symbolic-ref', '-q', 'HEAD']),
      git.run(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']),
      git.run(cwd, ['config', '--get', 'init.defaultBranch']),
    ]);
    // Git before 2.23 doesn't know a branch's worktree path: listed without it.
    if (listed.code !== 0 && !listed.timedOut && !listed.truncated) listed = await refs(BRANCH_FIELDS);
    if ([listed, head, remote, configured].some(result => result.timedOut)) return { timedOut: true };
    if (listed.code !== 0 && !listed.truncated) return { failed: true };
    const after = (result, prefix) => { const value = result.code === 0 ? result.stdout.trim() : ''; return value.startsWith(prefix) ? value.slice(prefix.length) || null : null; };
    const current = after(head, 'refs/heads/');
    const branches = parseBranches(listed.truncated ? listed.stdout.slice(0, listed.stdout.lastIndexOf('\n') + 1) : listed.stdout, current);
    const names = new Set(branches.map(row => row.name));
    return { current, default: defaultBranch(names, { remoteHead: after(remote, 'refs/remotes/origin/'), configured: configured.code === 0 ? configured.stdout.trim() || null : null, current }), branches, names };
  }
  /** GET …/git/branches[?worktree=] — local branches (refs/heads only), the current one and the default one. */
  async branches(projectId, { worktree } = {}) {
    const located = await this.git.locate(projectId, { worktree });
    const none = (repo, unavailable) => ({ repo, ...(unavailable ? { unavailable, message: this.git.unavailable(unavailable).message } : {}), current: null, default: null, branches: [] });
    if (located.repo === 'none') return none('none', located.unavailable);
    try {
      const listing = await this.listBranches(located.workspace);
      if (listing.timedOut) return none(located.repo, 'timed_out');
      if (listing.failed) return none(located.repo, 'git_failed');
      return { repo: located.repo, current: listing.current, default: listing.default, branches: listing.branches };
    } catch (error) { if (error.gitUnavailable) return none('none', error.gitUnavailable); throw error; }
  }
  /** GET …/git/compare?mode=all|uncommitted[&base=][&worktree=] — the files of one comparison, base → working tree. */
  compare(projectId, { mode, base, worktree } = {}) {
    const kind = mode === undefined || mode === null || mode === '' ? 'all' : mode;
    if (kind !== 'all' && kind !== 'uncommitted') fail(this.say({ zh: '对比方式只能是 all 或 uncommitted。', en: 'The comparison can only be all or uncommitted.' }), 400, 'git_mode_invalid');
    if (base !== undefined && base !== null && typeof base !== 'string') fail(this.say({ zh: '基线分支要是分支名。', en: 'The base must be a branch name.' }), 400, 'git_base_invalid');
    const wanted = kind === 'all' && base ? base : null, key = JSON.stringify([projectId, kind, wanted, worktree ?? null]);
    const running = this.inflight.get(key);
    if (running) return running;
    const request = this.readCompare(projectId, kind, wanted, worktree).finally(() => { if (this.inflight.get(key) === request) this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }
  async readCompare(projectId, mode, wanted, worktree) {
    const git = this.git, located = await git.locate(projectId, { worktree });
    const empty = (repo, unavailable) => ({ repo, ...(unavailable ? { unavailable, message: git.unavailable(unavailable).message } : {}), mode, base: null, defaultBase: null, mergeBase: null, target: null, files: [], truncated: false, operation: null });
    if (located.repo === 'none') return empty('none', located.unavailable);
    const cwd = located.workspace;
    try {
      const [listing, head, operation, untracked] = await Promise.all([this.listBranches(cwd), git.run(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']), git.operation(located.gitDir), git.untrackedMode(located)]);
      if (listing.timedOut || head.timedOut) return empty(located.repo, 'timed_out');
      if (listing.failed) return empty(located.repo, 'git_failed');
      // A base is one of the listed branches, never anything else that would read as a revision or an option.
      if (wanted && !listing.names.has(wanted)) fail(this.say({ zh: `分支「${wanted}」不存在。`, en: `There’s no branch “${wanted}”.` }), 404, 'git_base_not_found');
      const headSha = head.code === 0 ? head.stdout.trim() : null, base = mode === 'all' ? wanted ?? listing.default : null;
      let mergeBase = headSha;
      if (base) {
        const unrelated = () => fail(this.say({ zh: `与 ${base} 没有共同历史。`, en: `This has no history in common with ${base}.` }), 409, 'no_common_history');
        if (!headSha) unrelated();
        const found = await git.run(cwd, ['merge-base', '--end-of-options', `refs/heads/${base}`, 'HEAD']);
        if (found.timedOut) return empty(located.repo, 'timed_out');
        if (found.code === 1 && !found.stdout.trim()) unrelated();
        if (found.code !== 0) return empty(located.repo, 'git_failed');
        mergeBase = found.stdout.trim();
      }
      const [tracked, others, unmerged] = await Promise.all([
        git.changedFiles(cwd, mergeBase ?? await this.emptyTree(cwd)),
        // The repository's own status.showUntrackedFiles=no is honoured here too.
        untracked === 'no' ? null : git.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { maxBytes: LIST_BYTES }),
        // `git diff <commit>` shows a conflicted file as a plain edit, or not at all when its working copy matches the
        // start (modified here, deleted there): the index's unmerged entries say which files still need resolving.
        git.run(cwd, ['ls-files', '--unmerged', '-z'], { maxBytes: LIST_BYTES }),
      ]);
      if (tracked.timedOut) return empty(located.repo, 'timed_out');
      if (tracked.failed) return empty(located.repo, 'git_failed');
      let truncated = tracked.truncated || Boolean(others && (others.truncated || others.timedOut || others.code !== 0));
      const whole = result => (result.truncated ? result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1) : result.stdout);
      const conflicted = unmerged.code === 0 || unmerged.truncated ? parseUnmerged(whole(unmerged)) : new Set();
      const changed = tracked.files.map(row => (conflicted.has(row.path) ? { ...row, status: 'U' } : row));
      const seen = new Set(changed.map(row => row.path));
      for (const path of conflicted) if (!seen.has(path)) { seen.add(path); changed.push({ path, status: 'U', added: null, removed: null }); }
      const listed = others && (others.code === 0 || others.truncated) ? whole(others).split('\0').filter(path => path && !seen.has(path)) : [];
      const files = changed.slice(0, this.maxFiles), room = this.maxFiles - files.length;
      if (changed.length + listed.length > this.maxFiles) truncated = true;
      const budget = { left: this.countBudget };
      files.push(...await eachLimit(listed.slice(0, Math.max(0, room)), COUNT_PARALLEL, path => this.untrackedRow(cwd, path, budget)));
      const current = listing.current;
      const target = !current ? { kind: 'detached', label: headSha ? headSha.slice(0, 7) : '' } : { kind: mode === 'all' && current === base ? 'working-tree' : 'branch', label: current };
      return { repo: located.repo, mode, base, defaultBase: listing.default, mergeBase, target, files: files.sort(byPath), truncated, operation };
    } catch (error) { if (error.gitUnavailable) return empty('none', error.gitUnavailable); throw error; }
  }
  /** The empty tree's id in this repository's object format (the start of everything before the first commit). */
  async emptyTree(cwd) {
    const tree = await this.git.run(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
    return tree.code === 0 && SHA.test(tree.stdout.trim()) ? tree.stdout.trim() : EMPTY_TREE_SHA1;
  }
  async untrackedRow(cwd, path, budget) {
    // A folder here is a repository of its own (git lists one as its folder): no lines to count.
    if (path.endsWith('/')) return { path, status: '?', added: null, removed: null, untracked: true };
    return { path, status: '?', ...await this.lineCounts(join(cwd, path), budget), untracked: true };
  }
  /** An untracked file's counts, as git's numstat would give them: a link is one line; past 1 MB only binary or not is known. */
  async lineCounts(file, budget) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) return info?.isSymbolicLink() ? { added: 1, removed: 0 } : { added: null, removed: null };
    const key = `${file}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.ino}`, known = this.counts.get(key);
    if (known) return known;
    const large = info.size > READ_BYTES, want = large ? BINARY_PROBE : info.size;
    if (want > budget.left) return { added: null, removed: null };
    budget.left -= want;
    const bytes = await readStart(file, want);
    if (!bytes) return { added: null, removed: null };
    const counts = bytes.subarray(0, BINARY_PROBE).includes(0) ? { added: null, removed: null, binary: true } : large ? { added: null, removed: 0 } : { added: countLines(bytes), removed: 0 };
    if (this.counts.size >= COUNT_CACHE) this.counts.delete(this.counts.keys().next().value);
    this.counts.set(key, counts);
    return counts;
  }
  /** A patch's base as the web names it: `HEAD`, or a full commit id (40 or 64 hex digits). */
  checkBase(base) {
    if (typeof base !== 'string' || (base !== 'HEAD' && !SHA.test(base))) fail(this.say({ zh: '对比基点要是 HEAD 或完整的提交编号。', en: 'The comparison base must be HEAD or a full commit id.' }), 400, 'git_base_invalid');
    return base === 'HEAD' ? base : base.toLowerCase();
  }
  /** Where a patch starts: HEAD (the empty tree before the first commit), or a commit that exists. */
  async resolveBase(cwd, base) {
    if (base === 'HEAD') {
      const head = await this.git.run(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      if (head.timedOut) return { unavailable: 'timed_out' };
      return { from: head.code === 0 ? head.stdout.trim() : await this.emptyTree(cwd) };
    }
    const found = await this.git.run(cwd, ['cat-file', '-e', '--end-of-options', `${base}^{commit}`]);
    if (found.timedOut) return { unavailable: 'timed_out' };
    if (found.code !== 0) fail(this.say({ zh: '找不到这个对比基点，请刷新后再试。', en: 'That comparison base can’t be found. Refresh and try again.' }), 404, 'git_base_not_found');
    return { from: base };
  }
  /**
   * GET …/git/patches?base=<mergeBase|HEAD>&path=…[&oldPath=…][&worktree=] —
   * up to 40 files' patches from one `git diff`. `oldPath` (a moved file's
   * old name) lets git pair it with its new name.
   */
  async patches(projectId, { base, paths, oldPaths = [], worktree } = {}) {
    const git = this.git;
    git.project(projectId); git.pathList(paths, { max: MAX_PATCH_PATHS });
    if (oldPaths.length) git.pathList(oldPaths, { max: MAX_PATCH_PATHS });
    const from = this.checkBase(base);
    const located = await git.locate(projectId, { worktree });
    if (located.repo === 'none') { const diff = this.unavailableDiff(located.unavailable ?? 'git_failed'); return { patches: [...new Set(paths)].map(path => ({ path, diff })) }; }
    const checked = await git.checkPaths(located, paths, { folders: true, max: MAX_PATCH_PATHS }), olds = oldPaths.length ? await git.checkPaths(located, oldPaths, { max: MAX_PATCH_PATHS }) : [];
    try {
      const resolved = await this.resolveBase(located.workspace, from);
      if (resolved.unavailable) { const diff = this.unavailableDiff(resolved.unavailable); return { patches: checked.map(path => ({ path, diff })) }; }
      return { patches: await this.patchesFor(located.workspace, resolved.from, checked, olds) };
    } catch (error) { if (error.gitUnavailable) { const diff = this.unavailableDiff(error.gitUnavailable); return { patches: checked.map(path => ({ path, diff })) }; } throw error; }
  }
  /** GET …/git/diff?source=compare&base=<mergeBase|HEAD>&path=[&oldPath=][&context=all][&worktree=] — one file of a comparison, whole with context=all. */
  async diff(projectId, { base, path, oldPath, context, worktree } = {}) {
    const git = this.git;
    git.project(projectId);
    if (typeof path !== 'string' || !path) fail(this.say({ zh: '请选择一个文件。', en: 'Choose a file.' }), 400, 'git_paths_invalid');
    const from = this.checkBase(base);
    git.contextFlags(context);
    const located = await git.locate(projectId, { worktree });
    if (located.repo === 'none') return this.unavailableDiff(located.unavailable ?? 'git_failed');
    const [file] = await git.checkPaths(located, [path], { folders: true }), old = oldPath ? (await git.checkPaths(located, [oldPath]))[0] : null;
    try {
      const resolved = await this.resolveBase(located.workspace, from);
      if (resolved.unavailable) return this.unavailableDiff(resolved.unavailable);
      const [row] = await this.patchesFor(located.workspace, resolved.from, [file], old && old !== file ? [old] : [], { context });
      return row.diff;
    } catch (error) { if (error.gitUnavailable) return this.unavailableDiff(error.gitUnavailable); throw error; }
  }
  /**
   * Each path's GitDiff against `from`. Tracked files come from one `git
   * diff` cut per file (1 MB and 20 s for the whole call, as for one file);
   * untracked files are written in code. Past 1 MB in all, the files not yet
   * filled are `batch_too_large`, to be asked for again on their own: a batch
   * of one always gets its file (a file over the cap comes back truncated).
   */
  async patchesFor(cwd, from, paths, olds = [], { context } = {}) {
    const git = this.git, files = paths.filter(path => !path.endsWith('/')), extra = olds.filter(path => !files.includes(path));
    const [result, listed] = await Promise.all([
      files.length ? git.run(cwd, ['-c', 'core.quotePath=false', 'diff', '--relative', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', ...git.contextFlags(context), '--end-of-options', from, '--', ...files, ...extra], { maxBytes: git.diffMaxBytes, timeoutMs: git.diffTimeoutMs }) : null,
      git.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], { maxBytes: LIST_BYTES }),
    ]);
    // A path git didn't list as untracked because the listing itself failed is unknown, not unchanged.
    const unlisted = listed.timedOut ? 'timed_out' : listed.code !== 0 && !listed.truncated ? 'git_failed' : null;
    const untracked = new Set(unlisted ? [] : (listed.truncated ? listed.stdout.slice(0, listed.stdout.lastIndexOf('\0') + 1) : listed.stdout).split('\0').filter(Boolean));
    const sections = new Map(), parts = result ? splitPatch(result.stdout) : [];
    // Output that stopped early (the byte cap, the time limit, a failure) ends in a section that may be cut short.
    const partial = Boolean(result && (result.truncated || result.timedOut || result.code !== 0));
    let cut = null, used = 0;
    parts.forEach((part, index) => {
      if (part.path === null) return;
      if (partial && index === parts.length - 1) cut = part.path;
      // A file whose type changed comes as two sections (the old one removed, the new one added).
      sections.set(part.path, (sections.get(part.path) ?? '') + part.patch);
      used += Buffer.byteLength(part.patch);
    });
    const cap = git.diffMaxBytes, tooLarge = { kind: 'unavailable', reason: 'batch_too_large', message: this.say({ zh: '这一批改动太大，这个文件需要单独加载。', en: 'This batch of changes is too large; this file needs to load on its own.' }) };
    const cutShort = patch => (result.truncated ? { kind: 'truncated', patch: wholeLines(patch) } : this.unavailableDiff(result.timedOut ? 'timed_out' : 'git_failed'));
    const out = [];
    for (const path of paths) {
      const patch = sections.get(path);
      if (patch !== undefined) { out.push({ path, diff: path === cut ? cutShort(patch) : BINARY_PATCH.test(patch) ? { kind: 'binary' } : { kind: 'patch', patch } }); continue; }
      if (untracked.has(path)) {
        if (path.endsWith('/')) { out.push({ path, diff: { kind: 'unavailable', reason: 'repository', message: this.say({ zh: '这是一个单独的 Git 仓库，这里不显示它里面的改动。', en: 'This is a separate Git repository; its own changes aren’t shown here.' }) } }); continue; }
        const diff = await this.newFileDiff(cwd, path, cap, used ? cap - used : Infinity), size = Buffer.byteLength(diff?.patch ?? '');
        if (!diff || (used && used + size > cap)) { out.push({ path, diff: tooLarge }); continue; }
        used += size; out.push({ path, diff }); continue;
      }
      out.push({ path, diff: result?.timedOut ? this.unavailableDiff('timed_out') : result?.truncated ? tooLarge : result && result.code !== 0 ? this.unavailableDiff('git_failed') : unlisted ? this.unavailableDiff(unlisted) : { kind: 'patch', patch: '' } });
    }
    return out;
  }
  /**
   * An untracked file's patch, written as `git diff --no-index /dev/null`
   * would write it. A link shows the path it points to (never the file
   * there), as git shows a tracked one. null: a text file larger than `room`
   * (what its batch has left), left unread since its patch is longer still.
   */
  async newFileDiff(cwd, path, maxBytes, room = Infinity) {
    const file = join(cwd, path), info = await lstat(file).catch(() => null);
    if (info?.isSymbolicLink()) { const target = await readlink(file, { encoding: 'buffer' }).catch(() => null); return target ? { kind: 'patch', patch: newFilePatch(path, target, { mode: '120000' }) } : { kind: 'patch', patch: '' }; }
    if (!info?.isFile()) return { kind: 'patch', patch: '' };
    const unreadable = { kind: 'unavailable', reason: 'unreadable', message: this.say({ zh: '读不到这个文件。', en: 'This file can’t be read.' }) };
    // Binary or not from git's own probe first: a binary file costs the batch nothing, whatever its size.
    const probe = await readStart(file, Math.min(info.size, BINARY_PROBE));
    if (!probe) return unreadable;
    if (probe.includes(0)) return { kind: 'binary' };
    if (info.size > room) return null;
    const want = Math.min(info.size, maxBytes), bytes = probe.length >= want ? probe.subarray(0, want) : await readStart(file, want);
    if (!bytes) return unreadable;
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { kind: 'binary' };
    const complete = info.size <= maxBytes, patch = newFilePatch(path, bytes, { mode: info.mode & 0o100 ? '100755' : '100644', complete });
    return complete ? { kind: 'patch', patch } : { kind: 'truncated', patch };
  }
}
