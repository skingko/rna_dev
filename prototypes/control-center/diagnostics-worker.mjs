// Per-project TypeScript language service (plan 2026-09-30 §4.2), run as a
// child process so the workspace's own `typescript` package never loads into
// the daemon. It answers `{ id, file }` with the file's syntactic and semantic
// diagnostics, keeps the program warm between requests, and exits when idle or
// when its parent goes away. A request may carry `before`, the file's text before
// a run's writes: it is checked in memory first (an overlay of that one file, the
// rest of the program as it is now), so a write's pre-write baseline needs no check
// before the write (tool-policy.mjs; mu lsp.ts:243-247).
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const workspace = resolve(process.argv[2] ?? '.');
const IDLE_MS = Number(process.env.RNA_DIAGNOSTICS_IDLE_MS ?? 10 * 60000);
let ts;
try { ts = createRequire(join(workspace, 'package.json'))('typescript'); } catch { process.send?.({ type: 'unavailable', reason: 'no_typescript' }); process.exit(0); }

const configPath = ts.findConfigFile(workspace, path => existsSync(path), 'tsconfig.json');
let options = { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, strict: false };
let roots = [];
if (configPath) {
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config ?? {}, ts.sys, dirname(configPath));
  options = { ...parsed.options, noEmit: true, skipLibCheck: true };
  roots = parsed.fileNames;
}
const files = new Set(roots);
// While a request's `before` text is checked, that file reads as it (its own version, so the service re-reads it).
let overlay = null, overlays = 0;
const version = file => { if (overlay && file === overlay.file) return overlay.version; try { return String(statSync(file).mtimeMs); } catch { return '0'; } };
const host = {
  getScriptFileNames: () => [...files],
  getScriptVersion: version,
  getScriptSnapshot: file => { if (overlay && file === overlay.file) return ts.ScriptSnapshot.fromString(overlay.text); try { return ts.ScriptSnapshot.fromString(readFileSync(file, 'utf8')); } catch { return undefined; } },
  getCurrentDirectory: () => workspace,
  getCompilationSettings: () => options,
  getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const severity = category => category === ts.DiagnosticCategory.Error ? 'error' : category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';

let idle;
const touch = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS); idle.unref?.(); };
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  touch();
  if (message?.type !== 'diagnose' || typeof message.file !== 'string') return;
  const file = resolve(workspace, message.file);
  // In line order, then cut: a cut list is every finding up to its last line (a pre-write baseline relies on it).
  const check = () => {
    const found = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(row => {
      const at = row.file && row.start !== undefined ? row.file.getLineAndCharacterOfPosition(row.start) : null;
      return { line: at ? at.line + 1 : null, column: at ? at.character + 1 : null, severity: severity(row.category), code: `TS${row.code}`, message: ts.flattenDiagnosticMessageText(row.messageText, '\n').slice(0, 300) };
    }).sort((a, b) => ((a.line ?? Infinity) - (b.line ?? Infinity)) || ((a.column ?? 0) - (b.column ?? 0)));
    return { items: found.slice(0, 40), ...(found.length > 40 ? { truncated: true } : {}) };
  };
  try {
    files.add(file);
    let before = null;
    if (typeof message.before === 'string') {
      overlay = { file, text: message.before, version: `before:${++overlays}` };
      try { before = check(); } catch { before = null; } finally { overlay = null; }
    }
    process.send?.({ type: 'result', id: message.id, ...check(), ...(before ? { before } : {}) });
  } catch (error) { process.send?.({ type: 'result', id: message.id, error: String(error?.message ?? error).slice(0, 300) }); }
});
process.send?.({ type: 'ready', typescript: ts.version, config: configPath ? true : false });
touch();
