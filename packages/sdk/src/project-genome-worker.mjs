import { createContext, Script } from 'node:vm';
import { readFile, writeFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { canonicalizeMissingPath } from './workspace-paths.mjs';
import { compileGenomeScript, GENOME_READ_LIMIT_BYTES, GENOME_READ_BUDGET_BYTES } from './project-genome-script.mjs';

let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 400000) process.exit(2); }
const request = JSON.parse(raw), root = await realpath(request.workspace), effects = [];
let operations = 0, readBytes = 0;
/** What a rejected read of `path` is called to the script: `not_found:` (nothing there, or a parent is not a folder) or `denied:` (the API refuses the path, with the rule that did, or the file system does, with its code).
 * The file system's code stays in the message (never its text, which names the absolute path): a script written before the prefixes that tests for ENOENT still finds it. */
const readFailure = (path, failure) => {
  const code = failure?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new Error(`not_found: ${path} (${code})`);
  return new Error(code === undefined ? `denied: ${failure?.message}` : `denied: ${path} cannot be read (${code})`);
};
const inside = path => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const denied = await Promise.all((request.deniedPaths || []).map(canonicalizeMissingPath));
const allowed = path => inside(path) && !denied.some(entry => path === entry || path.startsWith(`${entry}${sep}`));
async function scoped(path, writing = false) {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) throw new Error('API paths must be workspace-relative');
  const target = resolve(root, path); if (!allowed(target)) throw new Error('API path escapes its workspace or is private');
  const segments = relative(root, target).split(sep);
  if (segments.some(part => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.state|\.runtime|auth\.json|credentials(?:\..*)?|.*\.secrets(?:\..*)?)$/i.test(part))) throw new Error('Private paths are unavailable');
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    if (!segments[index]) continue; current = resolve(current, segments[index]);
    let info; try { info = await lstat(current); } catch (failure) { if (!writing || failure.code !== 'ENOENT') throw failure; if (index < segments.length - 1) { await mkdir(current); info = await lstat(current); } else break; }
    if (info?.isSymbolicLink()) throw new Error('Symlinks are unavailable to generated scripts');
    if (!allowed(await realpath(current))) throw new Error('API path escapes its workspace or is private');
  }
  return target;
}
const bridge = async (operation, inputJSON) => {
  const input = JSON.parse(inputJSON);
  if (++operations > 50) throw new Error('Generated script exceeded its file operation limit');
  if (operation === 'writeFile') {
    if (request.permission === 'read') throw new Error('Read-only generated tools cannot write files');
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 64000) throw new Error('Generated file must be bounded text');
    const path = await scoped(input.path, true); await writeFile(path, input.content, { flag: 'w', mode: 0o600 }); effects.push({ operation, path: input.path, bytes: Buffer.byteLength(input.content) }); return JSON.stringify({ written: true });
  }
  if (operation === 'readFile') {
    // A rejected read says why, in a stable prefix a script (and the host) can tell apart: the file is not there, the API
    // does not let it be read, or it is larger than a read may return. Node's own message (an absolute path) never crosses.
    let path, info;
    try { path = await scoped(input.path); info = await lstat(path); } catch (failure) { throw readFailure(input.path, failure); }
    if (!info.isFile()) throw new Error(`not_found: ${input.path} is not a regular file`);
    const exceeds = (size, as = '') => size > GENOME_READ_LIMIT_BYTES ? `read_limit_exceeded: ${input.path} is ${size} bytes${as}; the limit is ${GENOME_READ_LIMIT_BYTES}`
      : readBytes + size > GENOME_READ_BUDGET_BYTES ? `read_limit_exceeded: ${input.path} is ${size} bytes${as}; this run has read ${readBytes} of ${GENOME_READ_BUDGET_BYTES} bytes in all` : null;
    // Checked before the read (the stat) and after it (what was read). The stat's size is counted against the budget while the
    // read is in flight, so a script that starts many reads at once is refused the ones that would not fit before they read
    // anything (50 overlapping reads of a 1 MiB file peaked at 144 MB resident and took 207 ms without it, 67 MB and 58 ms with it).
    // What was read can be larger than the file: bytes that are not UTF-8 each decode to a 3-byte replacement character (a 400,000
    // byte file of them is 1,200,000 bytes of text), and the script is handed the text, so the text is what the bound is on.
    const early = exceeds(info.size); if (early) throw new Error(early);
    readBytes += info.size;
    let content; try { content = await readFile(path, 'utf8'); } catch (failure) { readBytes -= info.size; throw readFailure(input.path, failure); }
    const size = Buffer.byteLength(content); readBytes -= info.size;
    const late = exceeds(size, size === info.size ? '' : ' as text'); if (late) throw new Error(late);
    readBytes += size; effects.push({ operation, path: input.path }); return JSON.stringify(content);
  }
  if (operation === 'listFiles') { const path = await scoped(input.path || '.'); const rows = []; for (const item of (await readdir(path)).sort()) { try { await scoped(relative(root, resolve(path, item))); rows.push(item); } catch {} if (rows.length >= 100) break; } effects.push({ operation, path: input.path || '.' }); return JSON.stringify(rows); }
  throw new Error('Unknown script API');
};
let phase = 'compile';
try {
  const compiled = compileGenomeScript(request.script, request.input);
  // Only realm-local wrappers are visible. Bridge results cross as JSON text;
  // neither host objects nor host errors are handed directly to generated code.
  const context = createContext({ __bridge: bridge }, { codeGeneration: { strings: false, wasm: false } });
  new Script(`const api = ((bridge) => {
    const call = async (operation, value) => { try { return JSON.parse(await bridge(operation, JSON.stringify(value))); } catch (failure) { throw new Error(String(failure.message)); } };
    return Object.freeze({ readFile: path => call('readFile', {path}), writeFile: (path, content) => call('writeFile', {path,content}), listFiles: (path='.') => call('listFiles',{path}) });
  })(globalThis.__bridge); delete globalThis.__bridge;`).runInContext(context, { timeout: 500 });
  phase = 'execution';
  const value = await compiled.runInContext(context, { timeout: 1500 });
  phase = 'serialization';
  const response = JSON.stringify({ ok: true, value: value === undefined ? null : value, effects }); if (response.length > 64000) throw new Error('Generated script result exceeds limit'); process.stdout.write(response);
} catch (failure) { process.stdout.write(JSON.stringify({ ok: false, error: String(failure.message).slice(0, 500), code: failure.code === 'script_syntax' ? 'script_syntax' : 'script_failed', phase, ...(failure.line ? { line: failure.line } : {}), effects })); }
