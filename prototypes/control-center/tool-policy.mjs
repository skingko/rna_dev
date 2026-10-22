import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workspacePrivateSegment } from '../../packages/sdk/src/workspace-tools.mjs';
import { constraintGate, WRITE_TOOLS } from './turn-watch.mjs';
import { guardsOf, guardResult } from './project-genes.mjs';
import { PERSISTENT_ATTEMPTS } from './diagnostics-service.mjs';

// One tool hook layer for every purpose (alignment 2026-10-05 §2.2 B1, §1.3 G rows 1-2). The references put
// interception in the tool pipeline once instead of in wrappers each caller has to remember: pi installs
// beforeToolCall/afterToolCall on the loop (agent-loop.ts:703-771, 816-861; agent-session.ts:520-575 "instead of in
// wrappers"), harness runs pre-execute → guard → post-execute for every agent scope (tools.md:180-436), zcode runs
// PreToolUse/PostToolUse inside executeToolCall (call-runner.ts:232-484). The host builds one ToolPolicy and every
// runtime — foreground turn, background run, subagent — asks it for the same hooks (createRnaRuntime):
//   before: the user's constraint gate (JEV tool.constraint) beside the run's own wait (a turn's start checkpoint or
//           worktree sync), then the pre-write baseline once that wait settled (a start sync may still be writing);
//   after:  evolution guards and code diagnostics on the written file, accounting of direct guard-tool calls, and the working
//           rules a background run read in a skill it loaded (they were put in front of its model: `stats.injected`).
//
// The pre-write baseline is shared by guards and diagnostics (§2.3 #4; mu lsp.ts:243-247, lsp-diagnostics.md §1-3):
// before the first write to a path in a run, the file's text is kept, and what each check finds on it; after each
// write, findings that pair with a baseline finding (same problem, at the place the edit moved its line to) were
// already there. Those are counted, not handed to the model to fix — unless the user accepted fixing a guard's
// existing hits (the fix_hits invitation, for the script that found them). Matching uses the root-relative path the
// write tool resolved (details.path), not the raw argument.
//
// Nothing is kept across runs: a check's findings on a file depend on more than its text (TypeScript reads the files
// it imports; a guard script may read any file in the root), so a run's baseline is always the file as it is now. The
// write waits only for checks that must read the file itself, each within its own bound (a guard script's, a warm
// diagnostics check's); the TypeScript language service takes the pre-write text into the check after the write and
// checks it in memory, as mu lets the server answer for the old text without holding the edit (lsp-diagnostics.md §2).
// A baseline a check could not give (it failed, ran out of its bound, or the file could not be read) calls nothing
// new: what the check finds after the write is counted, and that first answer is the baseline for the run's later
// writes (mu client.ts confirm/baselineExpired: "rather miss one than call an old problem new"). Checkers cut long
// lists at a bound, in line order; a cut baseline says nothing past its last line, so an unpaired finding there is
// counted, never delivered.

// The end-of-run pass (C1, §1.3 G row 1): a write made through project_exec (a shell heredoc, a python script), a
// worker's merge or a generated tool never passes a per-tool hook, so the run's net file changes are checked once more
// where the run is about to end (harness hooks-claude-code index.ts:244-283: the Stop hook that forces a continuation;
// mu swarm-isolation.ts:342: applied patch files count as edits for the done check). The host hands `sweep` the paths
// the run changed and each file's text as the run found it; the guard runner and the baseline rule are the write
// hook's own (a hit the file already had is counted, never delivered). A (guard, path, text) a write hook has checked
// in this run is not checked again, so a file merged from a worker that was guarded in its own root is checked once.

/** Files whose guards run at once in the pass (guard runs are short child processes: 43-71 ms each on this machine). */
export const SWEEP_CONCURRENCY = 4;
/** The pass stops starting files after this long: a run that changed hundreds of files is checked as far as time allows. */
export const SWEEP_BUDGET_MS = 30_000;
/** Runs whose ledgers are kept in memory at once (a ledger belongs to one turn or one background action). */
const LEDGERS_KEPT = 128;
const sha256 = text => createHash('sha256').update(text).digest('hex');
/** A run's key: its foreground turn (a subagent's runs count under its parent turn) or its background action. */
const ledgerKey = ({ turnId, parentTurnId, actionId }) => turnId ?? parentTurnId ? `turn:${turnId ?? parentTurnId}` : actionId ? `action:${actionId}` : null;
/** One ledger row: this guard (and the script it ran) has checked this path as this text. */
const ledgerRow = (entry, path, sum) => `${entry.gene.id}\0${guardScript(entry.tool)}\0${path}\0${sum}`;
/** Root-relative POSIX path of a target inside `base` (a real path), or null (outside it, or a private path). */
function withinRoot(base, target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) return null;
  const rel = relative(base, resolve(base, target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).some(workspacePrivateSegment)) return null;
  return rel.split(sep).join('/');
}
/** `fn` over `items`, at most `limit` at a time, results in order. A rejection ends the whole run. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; out[index] = await fn(items[index], index); } }));
  return out;
}

/** Lines a checker may move a report by without the text having changed (mu diagnostics.ts LINE_SLACK). */
export const LINE_SLACK = 1;
/** A baseline is read only for files the write tools could change at all (createWorkspaceTools maxFileBytes), and never for one a
 * generated check could not read: this is at most GENOME_READ_LIMIT_BYTES (test/tool-policy-unchecked.test.mjs keeps it so). */
export const BASELINE_MAX_BYTES = 1024 * 1024;
/** Cells of the comparison table beyond which the changed region is one hunk (mu diagnostics.ts MAX_DIFF_CELLS). */
const MAX_DIFF_CELLS = 1_000_000;
/** The script a guard runs, as a hash: findings, and the user's acceptance of fixing existing hits, belong to it. */
export const guardScript = tool => createHash('sha256').update(String(tool?.script ?? '')).digest('hex');
/** A guard's findings belong to its gene and the script that found them (a guard revised mid-run has no baseline). */
const guardKey = entry => `${entry.gene.id}\0${guardScript(entry.tool)}`;
/** The user accepted fixing this guard's existing hits, and the guard still runs the script they accepted it for: a
 * revised guard finds other hits, which nobody agreed to fix (session-invitations.mjs records { at, script }). */
export const fixHitsAccepted = entry => typeof entry?.gene?.fixHitsAccepted?.script === 'string' && entry.gene.fixHitsAccepted.script === guardScript(entry?.tool);

/**
 * Where each line of `oldText` is in `newText` (1-based), as mu's lineMap (diagnostics.ts:68-125): unchanged lines map
 * to one line, a changed or removed line to the span between its unchanged neighbours.
 * @returns {(line: number) => { from: number, to: number }}
 */
export function lineMap(oldText, newText) {
  if (oldText === newText) return line => ({ from: line, to: line });
  const before = String(oldText).split('\n'), after = String(newText).split('\n');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const exact = new Int32Array(before.length).fill(-1);
  for (let line = 0; line < head; line++) exact[line] = line;
  for (let offset = 1; offset <= tail; offset++) exact[before.length - offset] = after.length - offset;
  const rows = before.length - head - tail, columns = after.length - head - tail;
  if (rows > 0 && columns > 0 && rows * columns <= MAX_DIFF_CELLS) {
    const width = columns + 1, table = new Uint32Array((rows + 1) * width);
    for (let row = rows - 1; row >= 0; row--) for (let column = columns - 1; column >= 0; column--) {
      table[row * width + column] = before[head + row] === after[head + column] ? table[(row + 1) * width + column + 1] + 1 : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
    let row = 0, column = 0;
    while (row < rows && column < columns) {
      if (before[head + row] === after[head + column]) { exact[head + row] = head + column; row++; column++; }
      else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) row++;
      else column++;
    }
  }
  return line => {
    const index = line - 1;
    if (!Number.isInteger(index) || index < 0 || index >= before.length) return { from: line, to: line };
    if (exact[index] >= 0) return { from: exact[index] + 1, to: exact[index] + 1 };
    let previous = index - 1; while (previous >= 0 && exact[previous] < 0) previous--;
    let next = index + 1; while (next < before.length && exact[next] < 0) next++;
    const from = previous >= 0 ? exact[previous] + 1 : 0, to = next < before.length ? exact[next] - 1 : after.length - 1;
    return { from: from + 1, to: Math.max(from, to) + 1 };
  };
}

/** Same guard finding: the same excerpt and note (the plan's (excerpt, note) pairs). */
export const sameHit = (a, b) => String(a?.excerpt ?? '') === String(b?.excerpt ?? '') && String(a?.note ?? '') === String(b?.note ?? '');
/** Same diagnostic: severity, code and message agree (mu diagnostics.ts sameProblem). */
export const sameDiagnostic = (a, b) => a?.severity === b?.severity && String(a?.code ?? '') === String(b?.code ?? '') && String(a?.message ?? '') === String(b?.message ?? '');

/**
 * Splits `after` into what the baseline already had and what is new (mu pair/subtract, diagnostics.ts:142-170): each
 * finding pairs with the nearest unused baseline finding that is the same problem and lies within LINE_SLACK of where
 * the edit moved that line; duplicates pair by count. Without a line on either side, or without a line map (the
 * file could not be read after the write), the place is not compared.
 * `truncated`: the baseline was cut at its checker's bound, in line order, so it holds every finding before its last
 * line and says nothing from there on. An unpaired finding from where that line went to the end may be one it left
 * out: it is counted as old, never delivered (mu lsp-diagnostics.md §2: rather miss one than call an old one new).
 * @returns {{ fresh: object[], old: object[] }}
 */
export function subtractBaseline(after, before, map, same, { truncated = false } = {}) {
  const anchors = (before ?? []).map(item => ({ item, span: map && Number.isInteger(item?.line) ? map(item.line) : null })), used = new Set(), fresh = [], old = [];
  const lines = truncated ? (before ?? []).map(item => item?.line).filter(Number.isInteger) : [];
  const last = lines.length ? Math.max(...lines) : null, edge = !truncated ? Infinity : last === null ? -Infinity : map ? map(last).from : last;
  for (const finding of after ?? []) {
    let best = -1, bestDistance = Infinity;
    anchors.forEach((anchor, index) => {
      if (used.has(index) || !same(anchor.item, finding)) return;
      const line = finding?.line, away = anchor.span && Number.isInteger(line) ? (line < anchor.span.from ? anchor.span.from - line : line > anchor.span.to ? line - anchor.span.to : 0) : 0;
      if (away <= LINE_SLACK && away < bestDistance) { best = index; bestDistance = away; }
    });
    if (best >= 0) { used.add(best); old.push(finding); }
    else if (Number.isInteger(finding?.line) && finding.line < edge) fresh.push(finding);
    else if (truncated) old.push(finding);
    else fresh.push(finding);
  }
  return { fresh, old };
}

/** A file's text for a baseline: null when it does not exist, undefined when it cannot be one (not a regular file, too large, unreadable). */
async function readText(full) {
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > BASELINE_MAX_BYTES) return undefined;
    return await readFile(full, 'utf8');
  } catch (error) { return error?.code === 'ENOENT' ? null : undefined; }
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** A check's title in the English report: the project's own words in English quotes; a title that opens with its
 * own quoted term (「守夜」字样检查) is shown as it is, never quoted twice. */
const titled = title => {
  const text = String(title ?? '').trim(), whole = /^[「『“"《]([^「」『』“”"《》]*)[」』”"》]$/.exec(text)?.[1];
  return whole !== undefined ? `“${whole}”` : /^[「『“"《]/.test(text) ? text : `“${text}”`;
};

export class ToolPolicy {
  /**
   * @param {object} services  `decisions` (JEV tool.constraint), `genes` (GeneEvolutionService: guardHook, and its
   *   GeneStore for direct guard calls), `diagnostics` (DiagnosticsService). Each may be absent; its part is skipped.
   */
  constructor({ decisions = null, genes = null, diagnostics = null, now = Date.now } = {}) {
    Object.assign(this, { decisions, genes, diagnostics, now });
    /** run key → Map of ledger row → { by: 'write' | 'sweep', hits?: number } (the (guard, path, text) rows already checked in that run) */
    this.ledgers = new Map();
  }
  /** The ledger of one run (a foreground turn with its subagents, or a background action), created on first use; the oldest go first. */
  ledgerOf(key) {
    let rows = this.ledgers.get(key);
    if (rows) this.ledgers.delete(key); else rows = new Map();
    this.ledgers.set(key, rows);
    while (this.ledgers.size > LEDGERS_KEPT) this.ledgers.delete(this.ledgers.keys().next().value);
    return rows;
  }
  /** Whether the project has a guard in force that watches files being written: without one the end-of-run pass has nothing to do and costs nothing. */
  hasGuards(projectId) {
    try {
      const project = this.genes?.project?.(projectId);
      return Boolean(project) && guardsOf(project).some(entry => (entry.gene.body?.trigger?.onWrite ?? []).length > 0);
    } catch { return false; }
  }

  /**
   * The guard pass at the end of a run (C1): the files the run changed, checked once each by the guards that watch
   * them. `changes({ signal })` is the host's change source (run-changes.mjs): `{ paths, read }` (null: nothing can be
   * said about this run's changes). A hit the file already had when the run found it is counted, never delivered
   * (the write hook's baseline, here the file as the run began); a (guard, path, text) a write hook of this run
   * checked is skipped. Files are checked in parallel up to SWEEP_CONCURRENCY and as far as SWEEP_BUDGET_MS allows; a
   * guard run is the same as a write's: its stats, then JEV triage of the new hits.
   * The baseline of a file's guard is what the guard found in it when the run began, asked in the folder as the run found
   * it (`source.materialize`, written once per pass), because a guard may read other files than its own (a rules file, a
   * list of chapters). A source without `materialize` is baselined one file at a time, in a folder holding only that file:
   * for guards that read their own file only. A baseline that cannot be taken (the folder could not be written, the guard
   * failed on it, the file could not be read as the run found it) leaves the hits uncompared: counted, never delivered,
   * and named in `uncompared` (the write hook's rule for a check that gave no baseline).
   * @param {{ projectId: string, root: string, turnId?: string|null, actionId?: string|null, changes: Function, signal?: AbortSignal, concurrency?: number, budgetMs?: number }} run
   * @returns {Promise<null | { fix: number, files: object[], unresolved: object[], uncompared: object[], old: number, checked: number, already: number, unread: number, budget: number, text: string | null }>}
   *   null: the project has no guard watching writes, or no change source could answer. `files`: what is to fix, per
   *   file `{ path, checks: [{ gene, title, hits, old?, withheld? }] }`; `unresolved`: hits this pass delivered before
   *   that are still in the same text (`{ path, gene, title, hits }`); `uncompared`: hits counted only for want of a
   *   baseline (`{ path, gene, title, hits }`); `unchecked`: what a check could not read (`{ path, gene, title, items: [{ path, reason }] }`),
   *   never a hit, so it never makes `fix` positive or continues a run; `text`: the model-visible report of `files`.
   */
  async sweep({ projectId, root, turnId = null, actionId = null, changes, signal, concurrency = SWEEP_CONCURRENCY, budgetMs = SWEEP_BUDGET_MS } = {}) {
    const key = ledgerKey({ turnId, actionId });
    if (!projectId || typeof root !== 'string' || !root || !key || typeof changes !== 'function' || typeof this.genes?.guardHook !== 'function' || !this.hasGuards(projectId)) return null;
    const source = await changes({ signal });
    if (!source || !Array.isArray(source.paths)) return null;
    const guards = this.genes.guardHook(projectId, { turnId, root }), store = this.genes.genes, ledger = this.ledgerOf(key);
    const base = await realpath(root).catch(() => resolve(root)), deadline = this.now() + budgetMs;
    const candidates = [];
    for (const raw of new Set(source.paths)) {
      const path = withinRoot(base, raw);
      let entries = []; try { entries = path ? guards.match(path).slice(0, 6) : []; } catch { entries = []; }
      if (entries.length) candidates.push({ path, entries });
    }
    const outcome = { fix: 0, files: [], unresolved: [], uncompared: [], unchecked: [], old: 0, checked: 0, already: 0, unread: 0, budget: 0, text: null };
    const folders = [];
    const scratchFolder = async () => { const folder = await mkdtemp(join(tmpdir(), 'rna-guard-pass-')); folders.push(folder); return folder; };
    // The run's start as a folder, written once, when the first baseline is wanted. A folder: the tree; null: the source
    // cannot write one (it is baselined a file at a time); false: it could not be written (no baseline for anyone).
    let started;
    const startTree = () => started ??= (async () => {
      if (typeof source.materialize !== 'function') return null;
      const folder = await scratchFolder();
      try { return (await source.materialize(folder, { signal })) === true ? folder : false; } catch (error) { if (signal?.aborted) throw error; return false; }
    })();
    let single = null;
    // A guard's hits on the file as the run found it. Null: no baseline could be taken for it (the run had nothing to compare).
    const baselineOf = async (entry, path, before, signal) => {
      if (typeof store?.runGuard !== 'function') return null;
      const tree = await startTree();
      if (tree === false) return null;
      const project = this.genes.project(projectId);
      if (typeof tree === 'string') {
        // The file as the run found it is in that tree: a guard reads its own file and the others as they were.
        const result = await store.runGuard(project, entry, path, { signal, root: tree, record: false });
        return result.error ? null : { text: before, items: result.hits, truncated: result.truncated === true };
      }
      // No tree to run in: a copy of that one file in a folder of its own (a script reads its input path from the root it is given).
      const folder = await (single ??= scratchFolder()), copy = join(folder, path);
      try {
        await mkdir(dirname(copy), { recursive: true }); await writeFile(copy, before);
        const result = await store.runGuard(project, entry, path, { signal, root: folder, record: false });
        return result.error ? null : { text: before, items: result.hits, truncated: result.truncated === true };
      } finally { await rm(copy, { force: true }); }
    };
    try {
      await mapLimit(candidates, Math.max(1, concurrency), async ({ path, entries }) => {
        signal?.throwIfAborted();
        if (this.now() > deadline) { outcome.budget++; return; }
        const now = await readText(resolve(base, path));
        if (typeof now !== 'string') { outcome.unread++; return; }
        const sum = sha256(now), pending = [], file = { path, checks: [] };
        for (const entry of entries) {
          const row = ledger.get(ledgerRow(entry, path, sum));
          if (!row) pending.push(entry);
          else if (row.by === 'sweep' && row.hits > 0) outcome.unresolved.push({ path, gene: entry.gene.id, title: entry.gene.title, hits: row.hits });
        }
        if (!pending.length) { outcome.already++; return; }
        // The text the run found: undefined when it cannot be said (a file the source cannot read), which compares nothing.
        const before = await Promise.resolve(source.read?.(path)).catch(() => undefined), map = typeof before === 'string' ? lineMap(before, now) : null;
        outcome.checked++;
        for (const entry of pending) {
          signal?.throwIfAborted();
          const accepted = fixHitsAccepted(entry);
          // A file the run created has nothing to compare: everything in it is new. Without a baseline nothing is new.
          // A check the user accepted fixing the old hits of compares nothing, so it needs none.
          const found = accepted ? null : before === null ? { text: '', items: [], truncated: false } : typeof before === 'string' ? await baselineOf(entry, path, before, signal).catch(error => { if (signal?.aborted) throw error; return null; }) : null;
          const ran = await guards.run(entry, path, signal, { split: accepted ? undefined : items => found ? subtractBaseline(items, found.items, map, sameHit, { truncated: found.truncated }) : { fresh: [], old: [...items] } }).catch(error => { if (signal?.aborted) throw error; return { hits: [], summary: '', error: error.message }; });
          if (ran.error) continue;
          ledger.set(ledgerRow(entry, path, sum), { by: 'sweep', hits: ran.hits.length });
          // What the check could not read is no hit: it never counts toward `fix` (the one continuation) or the open list.
          if (ran.unchecked?.length) outcome.unchecked.push({ path, gene: entry.gene.id, title: entry.gene.title, items: ran.unchecked });
          const old = ran.old?.length ?? 0; outcome.old += old;
          if (old && !accepted && !found) outcome.uncompared.push({ path, gene: entry.gene.id, title: entry.gene.title, hits: old });
          if (ran.hits.length) file.checks.push({ gene: entry.gene.id, title: entry.gene.title, hits: ran.hits.map(hit => ({ ...(hit.line ? { line: hit.line } : {}), excerpt: hit.excerpt, ...(hit.note ? { note: hit.note } : {}) })), ...(old ? { old } : {}), ...(ran.withheld ? { withheld: ran.withheld } : {}), ...(accepted ? { fixHitsAccepted: true } : {}) });
        }
        if (file.checks.length) outcome.files.push(file);
      });
    } finally { await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }).catch(() => {}))); }
    outcome.files.sort((a, b) => a.path.localeCompare(b.path));
    outcome.uncompared.sort((a, b) => a.path.localeCompare(b.path));
    outcome.unchecked.sort((a, b) => a.path.localeCompare(b.path));
    outcome.fix = outcome.files.reduce((sum, file) => sum + file.checks.reduce((count, check) => count + check.hits.length, 0), 0);
    outcome.text = outcome.files.length ? sweepReport(outcome.files, outcome.fix, outcome.uncompared, outcome.unchecked) : null;
    return outcome;
  }

  /**
   * The hooks of one run (one runtime handle). `turnId`: the foreground turn; a subagent passes its parent's
   * `parentTurnId` (its guard runs count under the parent turn, project-genes.mjs keeps 12 turns per gene); a
   * background run passes `actionId` and records guard runs with turnId null. `root`: the folder the run's tools
   * write in (the project folder, a session worktree, a worker's or a background run's own worktree).
   * @returns {{ before: Function, after: Function } | null}
   */
  forRun({ projectId, getProject = () => null, root, purpose = 'foreground', turnId = null, actionId = null, parentTurnId = null, request = '' } = {}) {
    if (!projectId || typeof root !== 'string' || !root) return null;
    const runTurn = turnId ?? parentTurnId ?? null, project = () => { try { return getProject() ?? null; } catch { return null; } };
    const constraint = typeof this.decisions?.toolConstraint === 'function' ? constraintGate({ decisions: this.decisions, getProject: project }) : null;
    const guards = typeof this.genes?.guardHook === 'function' ? this.genes.guardHook(projectId, { turnId: runTurn, root }) : null;
    // Diagnostics count recurring error codes per run (a turn, or a background action as before), never across a turn's subagents.
    const diagnosed = typeof this.diagnostics?.hook === 'function' ? this.diagnostics.hook({ project: project(), workspace: root, turnId: runTurn ?? actionId, request }) : null;
    const rootReal = realpath(root).catch(() => resolve(root));
    const baselines = new Map();
    /** Root-relative POSIX path of a write target inside the run's root, or null (outside, private). */
    const within = async target => withinRoot(await rootReal, target);
    // What this run's writes already had checked, as (guard, path, text) rows: the end-of-run pass checks each once (C1).
    const ledger = ledgerKey({ turnId, parentTurnId, actionId }) ? this.ledgerOf(ledgerKey({ turnId, parentTurnId, actionId })) : null;
    const matchGuards = path => { if (!guards) return []; try { return guards.match(path).slice(0, 6); } catch { return []; } };
    const matchDiagnostics = path => { if (!diagnosed) return false; try { return diagnosed.match(path); } catch { return false; } };
    // The run's baseline of one path, taken once, before the run's first write to it (later writes compare with the
    // file as it was before the run touched it, so a hit an earlier write of this run added is still new):
    //   { text, guards: guardKey → Base | null, diagnostics: Base | null | undefined },  Base = { text, items, truncated }
    // `text`: the file before the write (null: it did not exist; undefined: it could not be read). A Base's own text is
    // the text its findings were found on (line positions map from it). null: the check gave no baseline (failed, out
    // of its bound, unreadable file), so nothing it finds is called new. undefined: the check takes the pre-write text
    // after the write (diagnostics takesText: the TypeScript language service), so nothing runs before the write.
    const baseline = (path, signal) => {
      if (baselines.has(path)) return baselines.get(path);
      const entries = matchGuards(path), diagnose = matchDiagnostics(path);
      if (!entries.length && !diagnose) return Promise.resolve(null);
      const job = (async () => {
        const text = await readText(resolve(await rootReal, path)), record = { text, guards: new Map(), diagnostics: undefined };
        // A file that does not exist yet has no problems: everything found in it later is new (mu client.ts setText).
        if (text === null) { const empty = { text: '', items: [], truncated: false }; for (const entry of entries) record.guards.set(guardKey(entry), empty); if (diagnose) record.diagnostics = empty; return record; }
        if (text === undefined) { for (const entry of entries) record.guards.set(guardKey(entry), null); if (diagnose) record.diagnostics = null; return record; }
        const later = diagnose && (() => { try { return diagnosed.takesText?.(path) === true; } catch { return false; } })();
        await Promise.all([
          ...entries.map(async entry => {
            const result = await guards.baseline(entry, path, signal).catch(() => null);
            record.guards.set(guardKey(entry), Array.isArray(result?.hits) ? { text, items: result.hits, truncated: result.truncated === true } : null);
          }),
          diagnose && !later ? Promise.resolve(diagnosed.baseline(path, signal)).catch(() => null).then(result => { record.diagnostics = Array.isArray(result?.items) ? { text, items: result.items, truncated: result.truncated === true } : null; }) : null,
        ]);
        signal?.throwIfAborted();
        return record;
      })();
      baselines.set(path, job);
      // An interrupted baseline is taken again by the next attempt (the write it was for never ran).
      job.catch(() => { if (baselines.get(path) === job) baselines.delete(path); });
      return job;
    };
    /** A write's record when no baseline was taken for its path (the write resolved to another path than its
     * argument): no baseline for any check, so the first answers become the run's baseline. */
    const unrecorded = path => { const record = { text: undefined, guards: new Map(), diagnostics: null }; baselines.set(path, Promise.resolve(record)); return record; };
    /** A direct call of a guard's generated tool counts as a run of that guard; returns the guard and its hit count. */
    const recordDirect = (tool, result, isError) => {
      const current = project(), store = this.genes?.genes;
      if (!current || typeof store?.record !== 'function' || typeof tool?.localId !== 'string') return null;
      let entry; try { entry = guardsOf(current).find(row => row.gene.body?.toolId === tool.localId); } catch { entry = null; }
      if (!entry) return null;
      let hits = 0, unchecked = false;
      if (!isError) try { const answer = guardResult(JSON.parse(result?.content?.find(block => block.type === 'text')?.text ?? 'null')); hits = answer.hits.length; unchecked = Boolean(answer.unchecked); } catch { hits = 0; unchecked = false; }
      const at = new Date(this.now()).toISOString();
      // The same counters GeneStore.runGuard keeps for a hook run: a direct call is a use of the guard too (EVO-1 point 3).
      store.record(projectId, entry.gene.id, gene => {
        gene.runs = (gene.runs ?? 0) + 1;
        if (isError) gene.failures = (gene.failures ?? 0) + 1; else { gene.hits = (gene.hits ?? 0) + hits; if (unchecked) gene.unchecked = (gene.unchecked ?? 0) + 1; }
        gene.lastRunAt = at;
        if (runTurn && !(gene.turns ?? []).includes(runTurn)) gene.turns = [...(gene.turns ?? []), runTurn].slice(-12);
      });
      return { entry, hits };
    };
    /** A background run that reads a skill has the working rules written into it in front of its model: counted, once per run
     * (gene-evolution-service.mjs noteSkillLoad). A foreground turn's rules are put in its turn block, and counted there. */
    const noteSkill = result => {
      if (!actionId || runTurn || typeof this.genes?.noteSkillLoad !== 'function') return;
      try {
        const page = JSON.parse(result?.content?.find(block => block.type === 'text')?.text ?? 'null');
        if (page && typeof page === 'object') this.genes.noteSkillLoad(projectId, { skillId: page.id, actionId, path: page.path, content: page.content });
      } catch { /* counting never blocks a run */ }
    };
    return {
      purpose,
      /**
       * Before dispatch: refuse a write that breaks a stated constraint, and take the path's baseline. `ready`: the
       * run's own write wait (a turn's start checkpoint, a session worktree's start sync, which merges the project
       * folder's changes into the worktree). The judgment runs beside it; the baseline is read only once it settled,
       * so it is the file the write will change, not one the sync is about to rewrite.
       */
      async before({ tool, args, signal, ready } = {}) {
        const settled = Promise.resolve(ready).then(() => undefined, () => undefined);
        if (!WRITE_TOOLS.includes(tool?.name)) { await settled; return undefined; }
        const path = await within(args?.path);
        const [verdict] = await Promise.all([
          constraint ? Promise.resolve(constraint({ tool, args, signal })).catch(() => null) : null,
          settled.then(() => path ? baseline(path, signal) : null).catch(() => null),
        ]);
        return verdict?.deny ? { block: true, code: 'user_constraint', reason: verdict.deny } : undefined;
      },
      /** After the tool ran: checks of the written file, appended to its result. */
      async after({ tool, args, result, isError, signal } = {}) {
        // A call the host refused (an authorization receipt: executed false) never ran: it used no guard, wrote nothing.
        if (result?.details?.executed === false) return undefined;
        if (tool?.name === 'skill_load' && !isError) noteSkill(result);
        const direct = recordDirect(tool, result, isError);
        if (direct) return direct.hits && !fixHitsAccepted(direct.entry) ? directNote(direct.entry) : undefined;
        if (!WRITE_TOOLS.includes(tool?.name) || isError) return undefined;
        const written = typeof result?.details?.path === 'string' ? result.details.path : args?.path, path = await within(written);
        if (!path) return undefined;
        const entries = matchGuards(path), diagnose = matchDiagnostics(path);
        if (!entries.length && !diagnose) return undefined;
        const record = (await (baselines.get(path) ?? Promise.resolve(null)).catch(() => null)) ?? unrecorded(path);
        const now = await readText(resolve(await rootReal, path)), maps = new Map();
        const mapFrom = base => { if (typeof now !== 'string' || typeof base.text !== 'string') return null; if (!maps.has(base.text)) maps.set(base.text, lineMap(base.text, now)); return maps.get(base.text); };
        // Without a baseline nothing is new (mu lsp-diagnostics.md §2: none of the first answer is counted as new).
        const compare = (base, same) => items => base ? subtractBaseline(items, base.items, mapFrom(base), same, { truncated: base.truncated }) : { fresh: [], old: [...items] };
        // The first answer after a baseline was given up on is the baseline for the run's later writes (mu client.ts
        // confirm): it is the file as written, so what those writes add is new again.
        const firstAnswer = found => typeof now === 'string' && found ? { text: now, items: found.items ?? found.hits ?? [], truncated: found.truncated === true } : undefined;
        // The pre-write text the language service checks beside the file as written (diagnostics takesText).
        const pending = record.diagnostics === undefined && typeof record.text === 'string' && (() => { try { return diagnosed.takesText?.(path) === true; } catch { return false; } })();
        const [checked, diagnosis] = await Promise.all([
          Promise.all(entries.map(async entry => {
            const key = guardKey(entry), base = record.guards.get(key) ?? null, accepted = fixHitsAccepted(entry);
            const outcome = await guards.run(entry, path, signal, { split: accepted ? undefined : compare(base, sameHit) }).catch(error => ({ hits: [], summary: '', error: error.message }));
            if (!base && !outcome.error) { const first = firstAnswer(outcome.checked); if (first) record.guards.set(key, first); }
            return { entry, outcome, accepted, uncompared: !base && !accepted && !outcome.error };
          })),
          diagnose ? diagnosed.run(path, signal, { ...(pending ? { before: record.text } : {}), split: (items, before) => compare(record.diagnostics ?? (pending && before ? { text: record.text, items: before.items, truncated: before.truncated === true } : null), sameDiagnostic)(items) }).catch(() => null) : null,
        ]);
        // Each guard that ran on this text has checked it: the end-of-run pass skips the same (guard, path, text).
        if (ledger && typeof now === 'string') { const sum = sha256(now); for (const { entry, outcome } of checked) if (!outcome.error) ledger.set(ledgerRow(entry, path, sum), { by: 'write' }); }
        let uncompared = false;
        if (diagnosis && !record.diagnostics) {
          if (pending && diagnosis.baseline) record.diagnostics = { text: record.text, items: diagnosis.baseline.items, truncated: diagnosis.baseline.truncated === true };
          else { uncompared = true; const first = firstAnswer(diagnosis.checked); if (first) record.diagnostics = first; }
        }
        return report(checked, diagnosis && { ...diagnosis, uncompared });
      },
    };
  }
}

/** Guards committed before B1 carry a skill note that says to fix every hit; the host's rule for older hits is stated
 * where they are reported, so the newest rule is the one at hand. */
const SKILL_RULE = 'even where the project\'s skill says every hit must be fixed';
/** A direct call of a guard's tool lists every hit in the file, older ones included. */
function directNote(entry) {
  return { content: [{ type: 'text', text: `\n\n[Automatic checks] ${titled(entry.gene.title)} lists every hit in the file, including hits it had before this run's writes: leave those unless the user asks, ${SKILL_RULE}. Hits this run's writes added are yours to fix.` }] };
}
const them = count => count === 1 ? 'it' : 'them', are = count => count === 1 ? 'is' : 'are';
/** Findings that are not handed to the model: already there before the run's writes, or not comparable (the check
 * gave no baseline), which is no claim that they are old and no instruction to leave them. */
const counted = (count, word, { uncompared = false, guard = false } = {}) => uncompared
  ? `${plural(count, word)} in this file ${are(count)} counted only: this check could not read the file before this run's writes to tell new from old.`
  : guard ? `${plural(count, word)} already in this file before this run's writes; counted only. Leave ${them(count)} unless the user asks, ${SKILL_RULE}.`
    : `${plural(count, word)} already in this file before this run's writes ${are(count)} counted only; leave ${them(count)} unless the user asks.`;

/** Files a check names as unchecked that a report lists one by one; the rest are counted. */
const UNCHECKED_LISTED = 5;
/**
 * The report's lines for what a check could not read (a rejected read: larger than a read may return, denied). It is no
 * finding about any file and nothing is to be changed for it; the generated check returns it apart from its hits
 * (project-genome.mjs contract), so it never reads as a violation and never continues a run.
 * @param {string} title  the check's title as `titled` shows it
 * @param {{ path: string, reason: string }[]} rows
 */
const couldNotCheck = (title, rows) => [
  ...rows.slice(0, UNCHECKED_LISTED).map(row => `Could not check: ${title} — ${row.path || 'a file'}${row.reason ? ` (${row.reason})` : ''}. This is not a finding about the file; do not change the file for it.`),
  ...(rows.length > UNCHECKED_LISTED ? [`Could not check: ${title} — ${rows.length - UNCHECKED_LISTED} more ${rows.length - UNCHECKED_LISTED === 1 ? 'file' : 'files'}, not listed.`] : []),
];

/** The model-visible check report (fixed English; titles and findings are the project's data). */
function report(checked, diagnosis) {
  const lines = [], rows = [], blocks = [];
  let toFix = 0, passed = 0;
  for (const { entry, outcome, accepted, uncompared } of checked) {
    const title = titled(entry.gene.title), old = outcome.old?.length ?? 0, unread = outcome.unchecked ?? [];
    rows.push({ gene: entry.gene.id, title: entry.gene.title, hits: outcome.hits.length, ...(unread.length ? { unchecked: unread.length } : {}), ...(old ? { old } : {}), ...(old && uncompared ? { uncompared: true } : {}), ...(accepted ? { fixHitsAccepted: true } : {}), ...(outcome.withheld ? { withheld: outcome.withheld } : {}), ...(outcome.error ? { error: outcome.error } : {}) });
    if (outcome.error) { lines.push(`${title}: could not run (${outcome.error})`); continue; }
    if (outcome.hits.length) {
      toFix += outcome.hits.length;
      lines.push(`${title}: ${plural(outcome.hits.length, 'hit')} to fix${accepted ? ' (the user asked to fix this check\'s existing hits too)' : ''}`, ...outcome.hits.slice(0, 8).map(hit => `- ${hit.line ? `line ${hit.line}: ` : ''}${hit.excerpt}${hit.note ? ` (${hit.note})` : ''}`), ...(outcome.hits.length > 8 ? [`- …and ${outcome.hits.length - 8} more`] : []));
    } else if (!old && !unread.length) passed++;
    if (old) lines.push(`${title}: ${counted(old, 'hit', { uncompared, guard: true })}`);
    // A check that could not read a file has not passed, and has not found anything either.
    lines.push(...couldNotCheck(title, unread));
  }
  if (checked.length) blocks.push(lines.length
    ? `\n\n[Automatic checks] ${lines.join('\n')}${passed ? `\n${plural(passed, 'other check')} passed.` : ''}${toFix ? '\nFix the hits listed above before continuing.' : ''}`
    : `\n\n[Automatic checks] ${plural(passed, 'check')} passed.`);
  if (diagnosis) {
    const { errors, warnings, old = { errors: 0, warnings: 0 }, uncompared = false } = diagnosis;
    const at = row => `- ${row.line ? `line ${row.line} ` : ''}${row.severity === 'error' ? '' : '(warning) '}${row.code}: ${row.message}`;
    if (errors.length || warnings.length) blocks.push([`\n\n[Code diagnostics] ${diagnosis.tool}: ${plural(errors.length, 'new error')}${warnings.length ? `, ${plural(warnings.length, 'new warning')} worth attention` : ''}`, ...errors.slice(0, 10).map(at), ...warnings.slice(0, 6).map(at),
      ...(old.errors ? [counted(old.errors, 'error', { uncompared })] : []),
      diagnosis.persistent ? `New errors in this file survived ${PERSISTENT_ATTEMPTS} fixes in this run: stop, say in one sentence where you are stuck, and ask the user once instead of editing again.` : 'Fix these before continuing; mention it in at most one sentence in the reply (for example "also fixed 2 errors").'].join('\n'));
    else if (old.errors) blocks.push(`\n\n[Code diagnostics] ${diagnosis.tool}: no new errors. ${counted(old.errors, 'error', { uncompared })}`);
  }
  const details = { ...(rows.length ? { guards: rows } : {}), ...(diagnosis ? { diagnostics: { tool: diagnosis.tool, errors: diagnosis.errors.length, warnings: diagnosis.warnings.length, withheld: diagnosis.withheld, persistent: diagnosis.persistent, ...(diagnosis.old?.errors || diagnosis.old?.warnings ? { old: diagnosis.old, ...(diagnosis.uncompared ? { uncompared: true } : {}) } : {}) } } : {}) };
  if (!blocks.length && !Object.keys(details).length) return undefined;
  return { content: blocks.length ? [{ type: 'text', text: blocks.join('') }] : [], details };
}

/** Hit lines the pass's report lists in all (a run that changed hundreds of files names the rest in a count). */
const SWEEP_REPORT_LINES = 40;
/**
 * The model-visible report of the end-of-run pass: per file, what each check found that the run added (fixed English;
 * titles, paths and findings are the project's data). Hits past SWEEP_REPORT_LINES are counted, not listed.
 * @param {{ path: string, checks: { title: string, hits: { line?: number, excerpt: string, note?: string }[], fixHitsAccepted?: boolean }[] }[]} files
 * @param {number} total  hits to fix over all files
 * @param {{ path: string, hits: number }[]} [uncompared]  hits counted only, for want of a baseline (the write hook says the same of a check that gave none)
 * @param {{ path: string, gene: string, title: string, items: { path: string, reason: string }[] }[]} [unchecked]  what a check could not read: listed apart from the hits, never to be fixed
 */
export function sweepReport(files, total, uncompared = [], unchecked = []) {
  const lines = [`[Automatic checks] ${plural(files.length, 'file')} changed in this run by a shell command, a worker's merge or another tool that writes without a file-write call, so no check ran as they were written. Each was checked now.`];
  let listed = 0;
  for (const file of files) {
    lines.push(file.path);
    for (const check of file.checks) {
      lines.push(`${titled(check.title)}: ${plural(check.hits.length, 'hit')} to fix${check.fixHitsAccepted ? ' (the user asked to fix this check\'s existing hits too)' : ''}`);
      for (const hit of check.hits) if (listed < SWEEP_REPORT_LINES) { lines.push(`- ${hit.line ? `line ${hit.line}: ` : ''}${hit.excerpt}${hit.note ? ` (${hit.note})` : ''}`); listed++; }
    }
  }
  if (total > listed) lines.push(`- …and ${total - listed} more hit${total - listed === 1 ? '' : 's'} not listed`);
  const unpaired = uncompared.reduce((sum, row) => sum + row.hits, 0), places = [...new Set(uncompared.map(row => row.path))];
  if (unpaired) lines.push(`${plural(unpaired, 'other hit')} in ${places.slice(0, 3).join(', ')}${places.length > 3 ? ` and ${places.length - 3} more` : ''} ${are(unpaired)} counted only: the checks could not read ${places.length === 1 ? 'that file' : 'those files'} as the run began, to tell new from old.`);
  // The same unreadable file, named by the same check, over many changed files is told once.
  const told = new Map();
  for (const row of unchecked) for (const item of row.items ?? []) told.set(`${row.gene}\0${item.path}\0${item.reason}`, { title: titled(row.title), item });
  const rows = [...told.values()];
  for (const { title, item } of rows.slice(0, 10)) lines.push(...couldNotCheck(title, [item]));
  if (rows.length > 10) lines.push(`Could not check: ${rows.length - 10} more files, not listed. None of this is a finding.`);
  lines.push('Fix the hits listed above before finishing. Hits a file already had before this run are not listed.');
  return lines.join('\n');
}
