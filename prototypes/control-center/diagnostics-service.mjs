import { execFile, fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { addLesson, mindSource } from './project-mind.mjs';

// Code diagnostics after edits (plan 2026-09-30 §4.2). TypeScript / JavaScript
// use the workspace's own `typescript` in a warm per-project language service
// (a child process, like an LSP server); without it, plain JavaScript gets a
// syntax check. Python uses ruff, else pyflakes, else a compile check. JSON is
// parsed. Errors always reach the model; which warnings do is JEV's call
// (`diagnostics.delivery`). Nothing here blocks or alters a write.
const here = dirname(fileURLToPath(import.meta.url));
export const DIAGNOSABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|json)$/i;
const TS_LIKE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, PLAIN_JS = /\.(?:js|mjs|cjs)$/i;
// `stopped`: the process was ended by its time bound or a stop before it finished; what it printed is not an answer
// (a cut-off check is not a clean file, and a baseline that reads it as one calls every older problem new).
const run = (file, args, { cwd, timeoutMs, signal }) => new Promise(done => {
  const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 2_000_000, signal, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => done({ code: error?.code === 'ENOENT' ? 'missing' : error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: error?.code === 'ENOENT', stopped: Boolean(error && (error.killed || error.signal || error.name === 'AbortError')) }));
  child.on?.('error', () => {});
});
const withTimeout = (promise, ms, fallback) => { let timer; return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); })]); };
// A file whose errors survive this many fixes in one turn: stop and ask once. An error code seen in this many turns: a lesson to confirm.
export const PERSISTENT_ATTEMPTS = 3, RECURRING_TURNS = 3;
/** Offset of the first JSON syntax error (a small recursive-descent scan), or -1 when valid. Node's messages no longer carry a position. */
export function jsonErrorOffset(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const fail = () => { throw i; };
  const value = () => {
    ws(); const c = text[i];
    if (c === '{') { i++; ws(); if (text[i] === '}') { i++; return; } for (;;) { ws(); if (text[i] !== '"') fail(); string(); ws(); if (text[i] !== ':') fail(); i++; value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } fail(); } }
    if (c === '[') { i++; ws(); if (text[i] === ']') { i++; return; } for (;;) { value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } fail(); } }
    if (c === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!literal) fail(); i += literal[0].length;
  };
  const string = () => { i++; while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === '"') { i++; return; } if (text[i] === '\n') fail(); i++; } fail(); };
  try { value(); ws(); if (i < text.length) fail(); return -1; } catch (at) { return typeof at === 'number' ? at : 0; }
}
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
/** Findings a check reports for one file, at most. */
export const MAX_ITEMS = 40;
const byPlace = (a, b) => ((a.line ?? Infinity) - (b.line ?? Infinity)) || ((a.column ?? 0) - (b.column ?? 0));
/** A file's findings in line order, cut at MAX_ITEMS: a cut list (`truncated`) is every finding up to its last line,
 * which a pre-write baseline relies on (tool-policy.mjs subtractBaseline). */
export const boundFindings = (tool, items) => { const ordered = [...items].sort(byPlace); return { tool, items: ordered.slice(0, MAX_ITEMS), ...(ordered.length > MAX_ITEMS ? { truncated: true } : {}) }; };

export class DiagnosticsService {
  constructor({ store = null, mind = null, decisions = null, nodePath = process.execPath, pythonPath = 'python3', ruffPath = 'ruff', timeoutMs = 6000, firstTimeoutMs = 20000, idleMs } = {}) {
    Object.assign(this, { store, mind, decisions, nodePath, pythonPath, ruffPath, timeoutMs, firstTimeoutMs, idleMs });
    this.workers = new Map(); this.python = null; this.closed = false;
    /** Workspaces whose whole-project check (TypeScript 7) last ran past `timeoutMs`. */
    this.slowProjects = new Set();
  }
  /** Files this service can check (never dependencies). */
  match(path) { return typeof path === 'string' && DIAGNOSABLE.test(path) && !/(^|\/)node_modules\//.test(path) && !/(^|\/)\.[^/]+\//.test(path); }
  /** { tool, items: [{ line, column, severity, code, message }] } or null when nothing could check it. `before`: the
   * file's text before a run's writes; a checker that can check given text (the TypeScript language service, takesText)
   * also answers for it, as `before: { items, truncated? }` (the pre-write baseline, tool-policy.mjs). */
  async diagnose(workspace, path, { signal, before } = {}) {
    if (this.closed || !this.match(path)) return null;
    const full = resolve(workspace, path), within = relative(workspace, full);
    if (!within || within.startsWith('..') || isAbsolute(within)) return null;
    const ext = extname(path).toLowerCase();
    if (ext === '.json') return this.json(full);
    if (ext === '.py') return this.pythonCheck(workspace, full, signal);
    if (TS_LIKE.test(path)) {
      const viaTs = await this.typescript(workspace, full, signal, before).catch(() => null);
      if (viaTs) return viaTs;
      if (PLAIN_JS.test(path)) return this.nodeCheck(workspace, full, signal);
    }
    return null;
  }
  async json(full) {
    let text; try { text = await readFile(full, 'utf8'); } catch { return null; }
    try { JSON.parse(text); return { tool: 'json', items: [] }; } catch (error) {
      const offset = jsonErrorOffset(text), line = offset >= 0 ? text.slice(0, offset).split('\n').length : null;
      return { tool: 'json', items: [{ line, column: null, severity: 'error', code: 'JSON', message: clip(error.message, 300) }] };
    }
  }
  async nodeCheck(workspace, full, signal) {
    const result = await run(this.nodePath, ['--check', full], { cwd: workspace, timeoutMs: this.timeoutMs, signal });
    if (result.missing || result.stopped) return null;
    if (result.code === 0) return { tool: 'node', items: [] };
    const line = Number(new RegExp(`${full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(result.stderr)?.[1]);
    const message = result.stderr.split('\n').find(row => /Error/.test(row)) ?? result.stderr.split('\n').find(Boolean) ?? 'syntax error';
    return { tool: 'node', items: [{ line: Number.isFinite(line) ? line : null, column: null, severity: 'error', code: 'SyntaxError', message: clip(message, 300) }] };
  }
  /** ruff → pyflakes → py_compile, whichever this machine has (probed once). */
  async pythonCheck(workspace, full, signal) {
    this.python ??= (async () => {
      if (!(await run(this.ruffPath, ['--version'], { cwd: workspace, timeoutMs: 3000 })).missing) return 'ruff';
      const probe = await run(this.pythonPath, ['-c', 'import pyflakes'], { cwd: workspace, timeoutMs: 3000 });
      return probe.missing ? null : probe.code === 0 ? 'pyflakes' : 'compile';
    })();
    const tool = await this.python;
    if (!tool) return null;
    if (tool === 'ruff') {
      const result = await run(this.ruffPath, ['check', '--output-format', 'json', '--no-cache', full], { cwd: workspace, timeoutMs: this.timeoutMs, signal });
      if (result.stopped) return null;
      let rows = []; try { rows = JSON.parse(result.stdout || '[]'); } catch { rows = []; }
      return boundFindings('ruff', rows.map(row => ({ line: row.location?.row ?? null, column: row.location?.column ?? null, severity: /^(?:E9|F8[2-4]|F63|F7)/.test(row.code ?? '') ? 'error' : 'warning', code: row.code ?? 'ruff', message: clip(row.message, 300) })));
    }
    if (tool === 'pyflakes') {
      const result = await run(this.pythonPath, ['-m', 'pyflakes', full], { cwd: workspace, timeoutMs: this.timeoutMs, signal });
      if (result.stopped) return null;
      const items = `${result.stdout}\n${result.stderr}`.split('\n').filter(Boolean).map(row => { const match = /:(\d+):(?:(\d+):)?\s*(.*)$/.exec(row); const message = match?.[3] ?? row; return { line: match ? Number(match[1]) : null, column: match?.[2] ? Number(match[2]) : null, severity: /syntax|undefined name|invalid/i.test(message) ? 'error' : 'warning', code: 'pyflakes', message: clip(message, 300) }; });
      return boundFindings('pyflakes', items);
    }
    const result = await run(this.pythonPath, ['-m', 'py_compile', full], { cwd: workspace, timeoutMs: this.timeoutMs, signal });
    if (result.stopped) return null;
    if (result.code === 0) return { tool: 'python', items: [] };
    const line = Number(/line (\d+)/.exec(result.stderr)?.[1]);
    return { tool: 'python', items: [{ line: Number.isFinite(line) ? line : null, column: null, severity: 'error', code: 'SyntaxError', message: clip(result.stderr.split('\n').filter(Boolean).at(-1) ?? 'syntax error', 300) }] };
  }
  /** The warm language service for this workspace; null when the workspace has no `typescript`. `before`: the file's
   * pre-write text, checked in memory in the same request (the worker's overlay), beside the file as it is now. */
  typescript(workspace, full, signal, before) {
    const major = this.typescriptMajor(workspace);
    if (major === null) return Promise.resolve(null);
    if (major >= 7) return this.nativeTypescript(workspace, full, signal);
    let worker = this.workers.get(workspace);
    if (worker?.unavailable) return Promise.resolve(null);
    if (!worker || worker.exited) {
      const child = fork(join(here, 'diagnostics-worker.mjs'), [workspace], { cwd: workspace, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execPath: this.nodePath, env: { ...process.env, ...(this.idleMs ? { RNA_DIAGNOSTICS_IDLE_MS: String(this.idleMs) } : {}) } });
      worker = { child, pending: new Map(), ready: false, unavailable: false, exited: false, answered: 0 };
      child.on('message', message => {
        if (message?.type === 'unavailable') { worker.unavailable = true; for (const done of worker.pending.values()) done(null); worker.pending.clear(); }
        else if (message?.type === 'ready') worker.ready = true;
        else if (message?.type === 'result') { const done = worker.pending.get(message.id); worker.pending.delete(message.id); worker.answered++; done?.(message.error ? null : { tool: 'typescript', items: message.items ?? [], ...(message.truncated ? { truncated: true } : {}), ...(message.before ? { before: { items: message.before.items ?? [], ...(message.before.truncated ? { truncated: true } : {}) } } : {}) }); }
      });
      child.on('exit', () => { worker.exited = true; for (const done of worker.pending.values()) done(null); worker.pending.clear(); });
      child.on('error', () => { worker.exited = true; });
      this.workers.set(workspace, worker);
    }
    const id = randomUUID(), timeout = worker.answered ? this.timeoutMs : this.firstTimeoutMs;
    return new Promise(done => {
      const timer = setTimeout(() => { worker.pending.delete(id); done(null); }, timeout); timer.unref?.();
      worker.pending.set(id, value => { clearTimeout(timer); done(value); });
      try { worker.child.send({ type: 'diagnose', id, file: full, ...(typeof before === 'string' ? { before } : {}) }); } catch { clearTimeout(timer); worker.pending.delete(id); done(null); }
    });
  }
  /**
   * The runtime's post-write hook for one run (tool-policy.mjs): errors always, warnings JEV (`diagnostics.delivery`)
   * says matter, and a stop-and-ask note once a file's errors survived three fixes in this run. With the run's
   * pre-write baseline (`split(items, before)` → { fresh, old }, mu lsp.ts:243-247), only problems this run introduced
   * count: old ones are reported as counts, never delivered to fix, never counted as attempts or recurring codes.
   */
  hook({ project = null, workspace, turnId = null, request = '' } = {}) {
    const attempts = new Map();
    return {
      match: path => Boolean(workspace) && this.match(path),
      /** Whether the check of `path` takes the file's pre-write text into the check after the write (`run`'s
       * `before`), as mu keeps the text before an edit and lets the server answer for it without holding the write
       * (lsp.ts:243-247, lsp-diagnostics.md §2): the TypeScript language service, which checks it in memory beside the
       * file as written. Other checkers read the file itself, so their baseline is taken before the write. */
      takesText: path => {
        if (!workspace || !TS_LIKE.test(path ?? '')) return false;
        const major = this.typescriptMajor(workspace);
        return major !== null && major < 7 && !this.workers.get(workspace)?.unavailable;
      },
      /** The file's diagnostics as it is now, before a write (the baseline), within the bound of a warm check
       * (`timeoutMs`): a write never waits longer for it. Null when nothing answered in time; the check is stopped.
       * A workspace whose whole-project check (TypeScript 7) last took longer than that bound is not asked at all
       * (it would only hold the write and answer nothing) until a check fits in the bound again. */
      baseline: async (path, signal) => {
        const whole = TS_LIKE.test(path ?? '') && (this.typescriptMajor(workspace) ?? 0) >= 7;
        if (whole && this.slowProjects.has(workspace)) return null;
        const bound = new AbortController(), timer = setTimeout(() => bound.abort(), this.timeoutMs); timer.unref?.();
        const stop = signal ? AbortSignal.any([signal, bound.signal]) : bound.signal;
        try {
          const result = await Promise.race([this.diagnose(workspace, path, { signal: stop }).catch(() => null), new Promise(done => stop.addEventListener('abort', () => done(null), { once: true }))]);
          if (whole && bound.signal.aborted && !signal?.aborted) this.slowProjects.add(workspace);
          return stop.aborted ? null : result;
        } finally { clearTimeout(timer); }
      },
      // `before`: the pre-write text, for a checker that takes it (takesText); `split(items, before)` gets what that
      // check found on it ({ items, truncated? }, or null). The result carries it as `baseline`, and everything the
      // check found on the file as written as `checked` (tool-policy.mjs keeps either as the run's baseline).
      run: async (path, signal, { split, before } = {}) => {
        const result = await this.diagnose(workspace, path, { signal, before }).catch(() => null);
        if (!result) return null;
        const { fresh, old } = typeof split === 'function' ? split(result.items, result.before ?? null) : { fresh: result.items, old: [] };
        const errors = fresh.filter(row => row.severity === 'error'), warnings = fresh.filter(row => row.severity !== 'error');
        let delivered = [];
        if (warnings.length && project && typeof this.decisions?.diagnosticsDelivery === 'function') {
          const judged = await withTimeout(this.decisions.diagnosticsDelivery(project, { request, file: path, tool: result.tool, warnings: warnings.slice(0, 6), signal }).catch(() => null), 4000, null);
          delivered = judged ? judged.deliver.map(index => warnings[index]).filter(Boolean) : [];
        }
        const count = errors.length ? (attempts.get(path) ?? 0) + 1 : 0; attempts.set(path, count);
        if (errors.length && project && turnId) this.recordErrors(project.id, turnId, path, errors);
        return { tool: result.tool, errors, warnings: delivered, withheld: warnings.length - delivered.length, persistent: count >= PERSISTENT_ATTEMPTS, old: { errors: old.filter(row => row.severity === 'error').length, warnings: old.filter(row => row.severity !== 'error').length }, checked: { items: result.items, truncated: result.truncated === true }, ...(result.before ? { baseline: { items: result.before.items, truncated: result.before.truncated === true } } : {}) };
      },
    };
  }
  /** The same error code across several turns becomes a lesson for the user to confirm (plan §4.2). */
  recordErrors(projectId, turnId, path, errors) {
    if (!this.store) return;
    let lessonId = null;
    try {
      this.store.mutate(state => {
        const project = state.projects.find(row => row.id === projectId); if (!project) return;
        const codes = (project.diagnostics ??= { codes: {} }).codes ??= {};
        for (const error of errors) {
          const entry = codes[error.code] ??= { turns: [], message: '', file: '' };
          if (!entry.turns.includes(turnId)) entry.turns = [...entry.turns, turnId].slice(-10);
          Object.assign(entry, { message: clip(error.message, 200), file: path, lastAt: new Date().toISOString() });
          if (entry.turns.length >= RECURRING_TURNS && !entry.lessonId && project.mind) {
            const text = inLanguage(interfaceLanguageOf(state), { zh: `这个项目里反复出现 ${error.code}（${clip(error.message, 80)}），改这类文件后先自查一遍。`, en: `${error.code} keeps coming back in this project (${clip(error.message, 80)}); check for it after editing such files.` });
            const lesson = addLesson(project.mind, { text, kind: 'pitfall', source: mindSource('agent') });
            lesson.needsConfirmation = true; entry.lessonId = lessonId = lesson.id;
          }
        }
        const keys = Object.keys(codes); if (keys.length > 60) for (const key of keys.sort((a, b) => String(codes[a].lastAt).localeCompare(String(codes[b].lastAt))).slice(0, keys.length - 60)) delete codes[key];
      });
    } catch { return; }
    if (lessonId) try { this.mind?.inviteLesson?.(projectId, lessonId); } catch {}
  }
  /** Major version of the workspace's own `typescript`, or null when it has none (cached per workspace). */
  typescriptMajor(workspace) {
    this.tsVersions ??= new Map();
    if (!this.tsVersions.has(workspace)) {
      let major = null;
      try { major = Number(JSON.parse(readFileSync(join(workspace, 'node_modules', 'typescript', 'package.json'), 'utf8')).version.split('.')[0]); } catch { major = null; }
      this.tsVersions.set(workspace, Number.isFinite(major) ? major : null);
    }
    return this.tsVersions.get(workspace);
  }
  /** TypeScript 7 (native compiler, no JavaScript API): its own tsc, output kept for the edited file only. A stop ends
   * the run (a whole-project check, often the longest wait before a write's baseline) and answers nothing. */
  async nativeTypescript(workspace, full, signal) {
    const tsc = join(workspace, 'node_modules', 'typescript', 'lib', 'tsc.js');
    const config = existsSync(join(workspace, 'tsconfig.json'));
    const args = config ? [tsc, '--noEmit', '--pretty', 'false', '-p', workspace] : [tsc, '--noEmit', '--pretty', 'false', '--allowJs', '--skipLibCheck', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--jsx', 'react-jsx', full];
    const startedAt = Date.now(), result = await run(this.nodePath, args, { cwd: workspace, timeoutMs: this.firstTimeoutMs, signal });
    if (signal?.aborted || result.missing || result.stopped || result.code === 'missing') return null;
    // Whether a pre-write baseline of this project fits in a warm check's bound (hook baseline).
    if (Date.now() - startedAt > this.timeoutMs) this.slowProjects.add(workspace); else this.slowProjects.delete(workspace);
    const items = [];
    for (const row of `${result.stdout}\n${result.stderr}`.split('\n')) {
      const match = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(row.trim());
      if (match && resolve(workspace, match[1]) === full) items.push({ line: Number(match[2]), column: Number(match[3]), severity: match[4], code: match[5], message: clip(match[6], 300) });
    }
    return boundFindings('typescript', items);
  }
  close() { this.closed = true; for (const worker of this.workers.values()) try { worker.child.kill(); } catch {} this.workers.clear(); }
}
