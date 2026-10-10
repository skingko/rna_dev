import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createExecTool, EXEC_TAIL_BYTES } from './workspace-exec.mjs';
import { canonicalizeMissingPath } from './workspace-paths.mjs';
import { normalizeImage } from './images.mjs';

const within = (root, path) => { const value = relative(root, path); return !value || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)); };
// `.rna`: Rna's worktrees and trash inside the project folder (worktree design 0.63 §9); a worktree's own relative
// paths never contain it, so tools rooted in a worktree are unaffected.
export const workspacePrivateSegment = value => /^(?:\.env(?:\..*)?|\.git|\.rna|\.ssh|\.aws|\.state|\.runtime|node_modules|auth\.json|credentials(?:\..*)?|.*\.(?:secrets|subscriptions)(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/iu.test(value);
const privateSegment = workspacePrivateSegment;
const result = text => ({ content: [{ type: 'text', text }], details: {} });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const imageMime = bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
// Serialize the complete read/compare/replace operation across registry instances.
const mutations = new Map();
async function serial(path, task) {
  const previous = mutations.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(task); mutations.set(path, pending);
  try { return await pending; } finally { if (mutations.get(path) === pending) mutations.delete(path); }
}
const problem = (message, code) => Object.assign(new Error(message), { code });
const expectedHash = { anyOf: [{ type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, { type: 'null' }], description: 'SHA-256 returned by project_read; JSON null (not the string "null") requires that the file does not exist. A mismatch never overwrites the file.' };
const missing = error => error.code === 'ENOENT';
const posix = path => path.split(sep).join('/');

/** project_edit's replacements: `edits`, with the legacy single oldText/newText folded in (pi edit.ts:103-134). */
export function projectEdits(args = {}) {
  if (args.edits !== undefined && !Array.isArray(args.edits)) throw problem('edits must be an array of {oldText, newText} replacements.', 'invalid_arguments');
  const edits = [...(args.edits ?? [])];
  if (args.oldText !== undefined || args.newText !== undefined) edits.push({ oldText: args.oldText, newText: args.newText });
  if (!edits.length) throw problem('edits must contain at least one replacement.', 'invalid_arguments');
  edits.forEach((edit, index) => {
    const name = edits.length > 1 ? `edits[${index}].` : '';
    if (!edit || typeof edit !== 'object' || typeof edit.oldText !== 'string' || !edit.oldText.length) throw problem(`${name}oldText must be non-empty exact text.`, 'invalid_arguments');
    if (typeof edit.newText !== 'string' || edit.newText.includes('\0')) throw problem(`${name}newText must be text.`, 'invalid_content');
  });
  return edits;
}

/**
 * pi edit.ts:32-41, 190-197 without its fuzzy fallback (NFKC would turn “” ， ： ； into ASCII): every edit is matched
 * exactly against the original text as project_read shows it — a byte-order mark and CRLF line breaks are set aside
 * for matching only — and must be unique and must not overlap another. Replacements are written into the original,
 * so untouched bytes (other line breaks included) stay as they were; a replacement's line breaks follow the file's.
 */
const BOM = String.fromCharCode(0xfeff);
/**
 * project_read shows a line as its number, one separator character, then the line (a tab now, a space until 0.72;
 * zcode read.ts: cat -n). When the line itself starts with that character the two run together, and a model writes
 * the line with one too many: live to 2026-10-10, 15 of 31 unmatched edits were exactly one extra leading space on
 * every indented line ("12:   x" read as three spaces for a line indented by two), and the new lines carried it too,
 * so one file's indentation grew from 3 to 8 spaces over nine days. Lines that do not start with it were written right.
 */
export const READ_LINE_SEPARATOR = '\t';
const LINE_SEPARATORS = [[READ_LINE_SEPARATOR, 'tab'], [' ', 'space']];
/** `text` with one leading `separator` taken off each line from `from` on that starts with it. */
const unprefixed = (text, separator, from) => text.split('\n').map((line, index) => (index >= from && line.startsWith(separator) ? line.slice(1) : line)).join('\n');
/**
 * The edit without the extra separator, when oldText then matches one place: taken off both texts, from every line
 * that starts with it, or from every such line after the first (oldText that starts inside a line, at a real space).
 * `{ hint }` when it matches several places, null when the separator is not what keeps oldText from matching.
 */
function withoutLineSeparator(old, replacement, view) {
  let seen = null;
  for (const [separator, label] of LINE_SEPARATORS) for (const from of [0, 1]) {
    const found = unprefixed(old, separator, from); if (!found || found === old) continue;
    const start = view.indexOf(found); if (start < 0) continue;
    if (view.indexOf(found, start + 1) < 0) return { start, old: found, text: unprefixed(replacement, separator, from), separator };
    seen ??= label;
  }
  return seen ? { hint: seen } : null;
}
function applyEdits(original, edits) {
  const bom = original.startsWith(BOM) ? BOM : '', body = original.slice(bom.length), crlf = body.includes('\r\n');
  // view: the text project_read shows; at[i]: where view character i starts in body (a CRLF maps to its \r).
  let view = body, at = null;
  if (crlf) {
    view = body.replace(/\r\n/g, '\n'); at = new Int32Array(view.length + 1);
    for (let index = 0, offset = 0; index < view.length; index++, offset++) { at[index] = offset; if (body.charCodeAt(offset) === 13 && body.charCodeAt(offset + 1) === 10) offset++; }
    at[view.length] = body.length;
  }
  const place = index => (at ? at[index] : index), ending = crlf && body.indexOf('\r\n') === body.indexOf('\n') - 1 ? '\r\n' : '\n';
  const name = index => (edits.length > 1 ? `edits[${index}].oldText` : 'oldText');
  const matched = edits.map((edit, index) => {
    let old = edit.oldText.replace(/\r\n/g, '\n'), start = view.indexOf(old), next = edit.newText.replace(/\r\n/g, '\n'), separator = null;
    if (start < 0) {
      const repaired = withoutLineSeparator(old, next, view);
      // Found only without the separator, and in several places: say what to change instead of "read the file again".
      if (repaired?.hint) throw problem(`Exact ${name(index)} was not found. Without one leading ${repaired.hint} on its indented lines it matches more than one place: a line of project_read output starts with its number and a separator, which are not part of the file. Remove that ${repaired.hint} from the indented lines of oldText and newText, include enough text for one unique match, and retry; nothing was written.`, 'no_match');
      if (!repaired) throw problem(`Exact ${name(index)} was not found. Read the current file before retrying; nothing was written.`, 'no_match');
      ({ start, old, text: next, separator } = repaired);
    } else if (view.indexOf(old, start + 1) >= 0) throw problem(`${name(index)} matches more than once. Include enough context for one unique exact match; nothing was written.`, 'ambiguous_match');
    const text = ending === '\r\n' ? next.replace(/\n/g, '\r\n') : separator === null ? edit.newText : next;
    return { index, start, end: start + old.length, text, separator };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < matched.length; index++) if (matched[index - 1].end > matched[index].start) throw problem(`edits[${matched[index - 1].index}] and edits[${matched[index].index}] overlap. Merge them into one edit or target separate regions; nothing was written.`, 'overlapping_edits');
  let next = body;
  for (const edit of [...matched].reverse()) next = next.slice(0, place(edit.start)) + edit.text + next.slice(place(edit.end));
  return { content: bom + next, firstChangedLine: body.slice(0, place(matched[0].start)).split('\n').length, replacements: matched.length, linePrefixRemoved: matched.filter(edit => edit.separator !== null).map(edit => edit.index).sort((a, b) => a - b) };
}
// Output bounds shared by read and grep (Pi/Harness): whole lines only, never more than this per call.
export const READ_DEFAULT_LINES = 2000, READ_MAX_BYTES = 50 * 1024, LINE_MAX_CHARS = 2000, GREP_DEFAULT_MATCHES = 100, GREP_MAX_MATCHES = 500, GREP_LINE_CHARS = 500;
/** Streams a text file line by line with no size cap. The encoding (UTF-8,
 * else GB18030) is chosen from the first 64 KiB; NUL bytes or undecodable
 * bytes mean binary. `onLine(text, number)` returns false to stop early; the
 * whole file is still hashed and counted when `complete` is set. */
async function streamTextLines(handle, { onLine, complete = false } = {}) {
  const info = await handle.stat();
  if (!info.isFile()) throw problem('File must be a regular file.', 'invalid_file');
  const sample = Buffer.alloc(Math.min(info.size, 64 * 1024)); if (sample.length) await handle.read(sample, 0, sample.length, 0);
  if (imageMime(sample) || sample.includes(0)) throw problem('File is binary, not text.', 'binary_file');
  let encoding = null;
  for (const label of ['utf-8', 'gb18030']) { try { new TextDecoder(label, { fatal: true }).decode(sample, { stream: true }); encoding = label; break; } catch {} }
  if (!encoding) throw problem('File is not UTF-8 or GBK text.', 'binary_file');
  const decoder = new TextDecoder(encoding), digest = createHash('sha256'), chunk = Buffer.alloc(256 * 1024);
  let position = 0, carry = '', number = 0, reading = true;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position); if (!bytesRead) break;
    const bytes = chunk.subarray(0, bytesRead); position += bytesRead; digest.update(bytes);
    if (!reading && !complete) break;
    const text = carry + decoder.decode(bytes, { stream: true }), parts = text.split('\n'); carry = parts.pop();
    for (const line of parts) { number++; if (reading && onLine(line.endsWith('\r') ? line.slice(0, -1) : line, number) === false) reading = false; }
  }
  const tail = carry + decoder.decode();
  if (tail || position === 0) { number++; if (reading) onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail, number); }
  return { lines: number, bytes: position, encoding, hash: reading || complete ? digest.digest('hex') : null, complete: reading || complete };
}

/**
 * `deniedPaths` (and `execLogDir`) are never read or written by the file tools, and a sandboxed command can neither
 * read nor write them, except `sandboxReadable` (read only). `deniedPrefixes` deny every path whose text starts with
 * one of them the same way, present or created later (`/s/state.json.` covers `/s/state.json.secrets.tmp-1`).
 * `withheldEnv` names never reach a command; a sandboxed command cannot connect to `sandboxDenyPorts`.
 */
export async function createWorkspaceTools(cwd, { deniedPaths = [], deniedPrefixes = [], maxFileBytes = 1024 * 1024, includeMutations = false, execLogDir, maxOutputBytes = EXEC_TAIL_BYTES, execTimeoutMs = 120000, sandbox = false, sandboxExtra = [], sandboxDeny = [], sandboxReadable = [], sandboxDenyPorts = [], withheldEnv = [], sandboxExec } = {}) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 64 * 1024 * 1024) throw new Error('maxFileBytes must be between 1 and 64 MiB.');
  if (typeof includeMutations !== 'boolean') throw new Error('includeMutations must be boolean.');
  for (const [name, list] of [['sandboxReadable', sandboxReadable], ['deniedPrefixes', deniedPrefixes]]) if (!Array.isArray(list) || list.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw new Error(`${name} must list absolute paths.`);
  const root = await realpath(cwd), denied = await Promise.all([...deniedPaths, ...(execLogDir ? [execLogDir] : [])].map(canonicalizeMissingPath)), readable = await Promise.all(sandboxReadable.map(canonicalizeMissingPath));
  // A prefix's folder is canonical; its last segment stays text (the state file itself may be a link).
  const deniedText = await Promise.all(deniedPrefixes.map(async prefix => resolve(await canonicalizeMissingPath(dirname(resolve(prefix))), basename(resolve(prefix)))));
  const allowed = path => {
    if (!within(root, path) || relative(root, path).split(sep).some(privateSegment) || denied.some(entry => within(entry, path)) || deniedText.some(prefix => path.startsWith(prefix))) throw problem('Path is outside the project scope or is private.', 'path_denied');
    return path;
  };
  const lexical = input => {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw problem('A valid project path is required.', 'invalid_path');
    return allowed(resolve(root, input));
  };
  const check = async input => {
    return allowed(await realpath(lexical(input || '.')));
  };
  const openRead = path => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const readBytes = async (path, optional = false, allowImage = false) => {
    let file;
    try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) { if (optional && missing(error)) return null; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxFileBytes) throw problem('File must be regular and within the size limit.', 'invalid_file');
      const bytes = Buffer.alloc(maxFileBytes + 1); let length = 0;
      while (length < bytes.length) { const chunk = await file.read(bytes, length, bytes.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (length > maxFileBytes) throw problem('File must be within the size limit.', 'invalid_file');
      const raw = bytes.subarray(0, length), mimeType = imageMime(raw), metadata = { bytes: raw, hash: hash(raw), mode: info.mode & 0o777 };
      if (mimeType && allowImage) return { ...metadata, image: normalizeImage({ type: 'image', mimeType, data: raw.toString('base64') }) };
      // Mutation and search remain strictly text-only, including image formats
      // whose particular bytes could also happen to decode as UTF-8.
      if (mimeType || raw.includes(0)) throw problem('File must be text within the size limit.', 'invalid_file');
      try { new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch {
        // project_read shows GBK/GB18030 text, but Node has no encoder for it: changing it here would re-encode it.
        let gbk = false; try { new TextDecoder('gb18030', { fatal: true }).decode(raw); gbk = true; } catch {}
        throw problem(gbk ? 'File is GBK/GB18030 text. project_write and project_edit only change UTF-8 files, and converting it would change its encoding; nothing was written. Ask the user before converting it (for example with iconv through project_exec).' : 'File is not valid UTF-8 text.', 'invalid_file');
      }
      return metadata;
    } finally { await file.close(); }
  };
  const mutationPath = async (input, createParents = false) => {
    const target = lexical(input);
    if (target === root) throw problem('The project directory cannot be replaced.', 'invalid_path');
    // Mutations reject all symlink segments, including links within the project.
    // This is path validation, not an OS sandbox or a cross-process filesystem lock.
    let current = root;
    const segments = relative(root, target).split(sep);
    for (let index = 0; index < segments.length; index++) {
      current = allowed(resolve(current, segments[index]));
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!missing(error)) throw error;
        if (index === segments.length - 1) break;
        if (!createParents) throw error;
        try { await mkdir(current, { mode: 0o755 }); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        info = await lstat(current);
      }
      if (info.isSymbolicLink()) throw problem('File mutations do not follow symbolic links.', 'path_denied');
      if (index < segments.length - 1 && !info.isDirectory()) throw problem('A parent path is not a directory.', 'invalid_path');
      allowed(await realpath(current));
    }
    return target;
  };
  const save = async (path, before, content, signal) => {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > maxFileBytes || bytes.includes(0)) throw problem('New content must be text within the size limit.', 'invalid_content');
    const afterHash = hash(bytes);
    if (before?.hash === afterHash) return { path, beforeHash: before.hash, hash: afterHash, bytes: bytes.length, changed: false };
    const temporary = resolve(dirname(path), `.rna-write-${randomUUID()}.tmp`);
    let file;
    try {
      signal?.throwIfAborted(); file = await open(temporary, 'wx', before?.mode ?? 0o644);
      await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
      signal?.throwIfAborted(); await mutationPath(path);
      const latest = await readBytes(path, true);
      if ((latest?.hash ?? null) !== (before?.hash ?? null)) throw problem('File changed before saving. Read it again and retry the intended change.', 'conflict');
      signal?.throwIfAborted();
      if (before === null) {
        // link is an atomic create-if-absent; an external creator between the
        // last hash check and commit must not be overwritten.
        try { await link(temporary, path); }
        catch (error) { if (error.code === 'EEXIST') throw problem('File appeared before saving; nothing was overwritten.', 'conflict'); throw error; }
      } else await rename(temporary, path);
      // Once rename succeeds, report the committed result even if cancellation
      // arrives just afterward. A caller must not infer rollback from abort.
      return { path, beforeHash: before?.hash ?? null, hash: afterHash, bytes: bytes.length, changed: true };
    } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  };
  // Observations are keyed by the file's name on disk, as project_read records it from the real path: on a
  // case-insensitive or normalization-insensitive volume `readme.md` and `README.md` (or NFC and NFD) are one file.
  // Mutation paths have no symbolic links (mutationPath), so the real path differs only in that spelling.
  const observedName = async path => { try { return posix(relative(root, await realpath(path))); } catch { return posix(relative(root, path)); } };
  const mutate = async (args, signal, edit, execution) => {
    try {
      signal?.throwIfAborted(); const target = lexical(args.path);
      if (args.createOnly !== undefined && (edit || typeof args.createOnly !== 'boolean')) throw problem('createOnly is a boolean option for project_write only.', 'invalid_arguments');
      if (args.createOnly === true && Object.hasOwn(args, 'expectedHash')) throw problem('createOnly:true cannot be combined with expectedHash. Omit expectedHash when creating a new file.', 'invalid_arguments');
      if (args.expectedHash !== undefined && args.expectedHash !== null && (typeof args.expectedHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(args.expectedHash))) throw problem('expectedHash must be a SHA-256 hash or null.', 'invalid_arguments');
      const edits = edit ? projectEdits(args) : null, content = edit ? null : args.content;
      if (!edit && (typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes || content.includes('\0'))) throw problem('New content must be text within the size limit.', 'invalid_content');
      return await serial(target, async () => {
        signal?.throwIfAborted(); const path = await mutationPath(target, !edit), before = await readBytes(path, !edit), name = posix(relative(root, path));
        if (args.createOnly === true && before !== null) throw problem('File already exists. createOnly never overwrites; read the file before choosing an update.', 'conflict');
        if (args.expectedHash !== undefined && (before?.hash ?? null) !== (args.expectedHash?.toLowerCase() ?? null)) throw problem('File hash changed. Read the current file before retrying; nothing was written.', 'conflict');
        // Without expectedHash an existing file must be the version this conversation last observed through a read (a
        // partial one counts), write or edit result (harness fs-observation-policy; zcode write.ts:281-299,
        // read-file-state.ts:41-49). A file it never observed is not overwritten.
        if (!edit && args.expectedHash === undefined && args.createOnly !== true && before !== null) {
          const seen = typeof execution?.observation === 'function' ? execution.observation(await observedName(path)) : undefined;
          // null: observed only before the latest compaction, whose checkpoint lists the file (session latestObservation).
          if (typeof seen !== 'string') throw problem(seen === null
            ? `${name} has not been read since this conversation was last compacted; reads before that point no longer count. Read it again (project_read returns its SHA-256), then write again; nothing was written.`
            : `${name} already exists and has not been read in this conversation. Read it first (project_read returns its SHA-256), then write again; nothing was written.`, 'not_observed');
          if (seen !== before.hash) throw problem(`${name} changed since this conversation last read or wrote it (a command, another tool or the user changed it). Read the current file before retrying; nothing was written.`, 'conflict');
        }
        let next = content, firstChangedLine, replacements, linePrefixRemoved = [];
        if (edit) ({ content: next, firstChangedLine, replacements, linePrefixRemoved } = applyEdits(before.bytes.toString('utf8'), edits));
        if (Buffer.byteLength(next) > maxFileBytes) throw problem('New content must be text within the size limit.', 'invalid_content');
        execution?.checkpoint({ kind: 'workspace-file-v1', path: relative(root, path), beforeHash: before?.hash ?? null, afterHash: hash(Buffer.from(next, 'utf8')), ...(args.createOnly === true ? { createOnly: true } : {}) });
        const saved = await save(path, before, next, signal), details = { ...saved, ...(edit ? { firstChangedLine, replacements, ...(linePrefixRemoved.length ? { linePrefixRemoved } : {}) } : {}), ...(args.createOnly === true ? { createOnly: true } : {}), observation: { path: await observedName(path), hash: saved.hash } };
        return { ...result(`${edit ? `Edited ${relative(root, path)}${replacements > 1 ? ` (${replacements} replacements)` : ''}` : `Saved ${relative(root, path)}`}\nSHA-256: ${saved.hash}\n${saved.bytes} bytes${saved.changed ? '' : ' (already identical)'}${linePrefixRemoved.length ? `\nNote: ${edits.length > 1 ? `edits[${linePrefixRemoved.join('], edits[')}] were` : 'the edit was'} matched after removing one leading separator character (the one project_read shows after each line number) from the indented lines of oldText and newText. It is not part of the file: write indentation exactly as it follows the separator.` : ''}`), details };
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ...result(String(error.message)), isError: true, details: { code: error.code ?? 'file_error', written: false, ...(!edit && args.createOnly === true ? { createOnly: true } : {}) } };
    }
  };
  // How often each edit's oldText occurs now (reconciliation evidence; a number for one edit, a list for several).
  const occurrences = (text, args) => {
    let edits; try { edits = projectEdits(args); } catch { return {}; }
    const view = text.replace(/\r\n/g, '\n'), counts = edits.map(row => view.split(row.oldText.replace(/\r\n/g, '\n')).length - 1);
    return { oldTextOccurrences: counts.length === 1 ? counts[0] : counts };
  };
  // Reconciliation observes the current file and never replays a mutation. A
  // legacy edit without a checkpoint remains historically uncertain, but its
  // current state can be handed back to the model as an interrupted result.
  // This is deliberately not supported for external commands or MCP effects.
  const reconcile = async ({ arguments: args, checkpoint }, signal, edit) => {
    signal?.throwIfAborted();
    const target = lexical(args.path);
    return serial(target, async () => {
      let path;
      try { path = await mutationPath(target); }
      catch (error) { if (!missing(error)) throw error; path = target; }
      const current = await readBytes(path, true);
      signal?.throwIfAborted();
      const witnessed = checkpoint?.kind === 'workspace-file-v1' && checkpoint.path === relative(root, target)
        && /^[a-f0-9]{64}$/.test(checkpoint.afterHash ?? '') && (checkpoint.beforeHash === null || /^[a-f0-9]{64}$/.test(checkpoint.beforeHash ?? ''))
        && (args.createOnly !== true || !edit && checkpoint.createOnly === true && checkpoint.beforeHash === null);
      const desiredHash = witnessed ? checkpoint.afterHash : !edit && typeof args.content === 'string' ? hash(Buffer.from(args.content, 'utf8')) : null;
      const present = current !== null && desiredHash !== null && current.hash === desiredHash;
      const evidence = { kind: 'workspace-file-observation', path: relative(root, target), currentHash: current?.hash ?? null,
        desiredHash, checkpointAvailable: witnessed, desiredContentPresent: present, replayed: false,
        ...(!edit && args.createOnly === true ? { createOnly: true, historicalCreation: 'not_claimed' } : {}),
        ...(witnessed ? { beforeHash: checkpoint.beforeHash, matchesBefore: (current?.hash ?? null) === checkpoint.beforeHash } : {}),
        ...(edit && current ? occurrences(current.bytes.toString('utf8'), args) : {}) };
      return { status: 'resolved', evidence, result: { ...result(present
        ? `Recovered file state: ${relative(root, target)} already contains the intended complete contents. SHA-256: ${current.hash}. The old operation was not replayed.`
        : `Interrupted file operation reconciled by reading current state: ${relative(root, target)}; current SHA-256: ${current?.hash ?? '(file absent)'}. Its historical outcome is not claimed. The old operation has been retired without replay. Read the current file and apply any still-needed change as a NEW operation within the latest user instructions; do not assume the interrupted edit was applied or rolled back.`),
        isError: !present, details: { recovery: evidence } } };
    });
  };
  const tools = [
    // project_read pages itself (READ_DEFAULT_LINES / READ_MAX_BYTES), so its result is never spilled a second time.
    { id: 'project_read', name: 'project_read', label: '读取项目文件', spill: false, description: `Read a project text file as line-numbered content, or a PNG/JPEG/GIF/WebP image as pixels. Text files of any size are supported (UTF-8 or GBK): a call returns at most ${READ_DEFAULT_LINES} lines or ${READ_MAX_BYTES / 1024} KB, whichever comes first, each line shown as its line number, a tab, then the line (cat -n); the number and the tab are not part of the file. When more remains the result ends with the exact offset to continue from. For a large file, find the relevant line numbers with project_grep first, then read just that range with offset/limit; read the next range only if you need it. Use this tool instead of cat, head, sed or tail in project_exec. Private paths are denied. Images are returned whole (at most 8 MiB); do not pass offset or limit for images.`, enabled: true, trusted: true, permission: 'read', effect: 'read', idempotent: true,
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, description: 'Project-relative file path.' }, offset: { type: 'integer', minimum: 1, description: '1-based line number to start from. Defaults to 1.' }, limit: { type: 'integer', minimum: 1, maximum: READ_DEFAULT_LINES, description: `Maximum number of lines to return. Defaults to ${READ_DEFAULT_LINES}.` } }, required: ['path'], additionalProperties: false },
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const path = await check(args.path);
        if ((await lstat(path)).isDirectory()) throw problem(`${relative(root, path) || '.'} is a directory; use project_list or project_find.`, 'invalid_file');
        const handle = await openRead(path);
        try {
          const head = Buffer.alloc(16); await handle.read(head, 0, 16, 0);
          if (imageMime(head)) {
            await handle.close().catch(() => {});
            const file = await readBytes(path, false, true);
            if (args.offset !== undefined || args.limit !== undefined) throw problem('Image reads return the complete image; offset and limit apply only to text files.', 'image_range_unsupported');
            return { content: [{ type: 'text', text: `File: ${relative(root, path)}\nSHA-256: ${file.hash}\nImage: ${file.image.mimeType}; ${file.bytes.length} bytes; original pixels attached.` }, file.image], details: { hash: file.hash, mimeType: file.image.mimeType, bytes: file.bytes.length, truncated: false, observation: { path: posix(relative(root, path)), hash: file.hash } } };
          }
          const offset = args.offset ?? 1, limit = args.limit ?? READ_DEFAULT_LINES, out = []; let bytes = 0, longLines = 0, stopped = null;
          const stats = await streamTextLines(handle, { complete: true, onLine: (line, number) => {
            if (number < offset) return true;
            if (out.length >= limit) { stopped = 'lines'; return false; }
            const text = line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)} …[line ${number} truncated: ${line.length} characters]` : line;
            if (line.length > LINE_MAX_CHARS) longLines++;
            const rendered = `${number}${READ_LINE_SEPARATOR}${text}`, size = Buffer.byteLength(rendered) + 1;
            if (out.length && bytes + size > READ_MAX_BYTES) { stopped = 'bytes'; return false; }
            out.push(rendered); bytes += size; return true;
          } });
          signal?.throwIfAborted();
          const first = out.length ? offset : null, last = out.length ? offset + out.length - 1 : null;
          const observation = { path: posix(relative(root, path)), hash: stats.hash };
          if (offset > stats.lines) return { ...result(`File: ${relative(root, path)}\nSHA-256: ${stats.hash}\nLines: ${stats.lines}\n\n[offset ${offset} is past the end of the file (${stats.lines} lines).]`), details: { totalLines: stats.lines, offset, returnedLines: 0, hash: stats.hash, truncated: false, observation } };
          const more = last !== null && last < stats.lines;
          const footer = more ? `\n\n[Showing lines ${first}-${last} of ${stats.lines}${stopped === 'bytes' ? ` (${READ_MAX_BYTES / 1024} KB limit)` : ''}. Use offset=${last + 1} to continue.]` : `\n\n[End of file: lines ${first}-${last} of ${stats.lines}.]`;
          const header = `File: ${relative(root, path)}\nSHA-256: ${stats.hash}\nLines: ${stats.lines}; ${(stats.bytes / 1024 / 1024).toFixed(stats.bytes > 1048576 ? 1 : 3)} MB${stats.encoding !== 'utf-8' ? `; encoding ${stats.encoding}` : ''}`;
          return { ...result(`${header}\n\n${out.join('\n')}${footer}`), details: { totalLines: stats.lines, offset, returnedLines: out.length, hash: stats.hash, truncated: more || longLines > 0, ...(more ? { nextOffset: last + 1 } : {}), encoding: stats.encoding, longLines, observation } };
        } catch (error) {
          if (error.code === 'binary_file') throw problem(`${relative(root, path)} is binary, not text; use a suitable parser through project_exec if needed.`, 'invalid_file');
          throw error;
        } finally { await handle.close().catch(() => {}); }
      } },
    { id: 'project_list', name: 'project_list', label: '列出项目目录', description: 'List up to 100 immediate entries of a project directory (files and folders), excluding private paths. Use project_find to locate files by name pattern anywhere below, and project_grep to find text inside files.', enabled: true, trusted: true, permission: 'read', effect: 'read', idempotent: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted(); const path = await check(args.path ?? '.'), items = await readdir(path, { withFileTypes: true }), names = [];
        for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) { if (privateSegment(item.name)) continue; try { await check(resolve(path, item.name)); } catch { continue; } names.push(`${item.name}${item.isDirectory() ? '/' : ''}`); if (names.length === 100) break; }
        signal?.throwIfAborted(); return result(names.join('\n') || '(empty directory)');
      } }
  ];
  const walk = async (input, signal, visit) => {
    const directory = await check(input || '.'), pending = [directory]; let scanned = 0, truncated = false;
    while (pending.length) {
      signal?.throwIfAborted(); const parent = pending.pop();
      const entries = (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const item of entries) {
        signal?.throwIfAborted(); if (++scanned > 2000) { truncated = true; break; }
        if (privateSegment(item.name) || item.isSymbolicLink()) continue;
        const path = resolve(parent, item.name);
        try { await check(path); } catch { continue; }
        if (item.isDirectory()) pending.push(path);
        else if (item.isFile() && await visit(path, relative(root, path).split(sep).join('/')) === false) { truncated = true; break; }
      }
      if (truncated) break;
    }
    return { scanned, truncated };
  };
  tools.push(
    { id: 'project_find', name: 'project_find', label: '查找项目文件', permission: 'read', effect: 'read', idempotent: true, enabled: true, trusted: true,
      description: 'Find project files using a wildcard pattern (* and ?). A pattern without / matches filenames. Traverses at most 2000 entries and returns at most 200 paths, excluding private paths and symlinks. Narrow path when truncated.',
      parameters: { type: 'object', properties: { pattern: { type: 'string', minLength: 1, maxLength: 200 }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
      execute: async (_id, args, signal) => {
        if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 200) throw problem('A wildcard pattern of 1–200 characters is required.', 'invalid_arguments');
        // Linear wildcard matcher avoids regex backtracking on user input.
        const matches = (pattern, value) => { let p = 0, v = 0, star = -1, mark = 0; while (v < value.length) { if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++; } else if (pattern[p] === '*') { star = p++; mark = v; } else if (star >= 0) { p = star + 1; v = ++mark; } else return false; } while (pattern[p] === '*') p++; return p === pattern.length; };
        const paths = [], traversal = await walk(args.path, signal, (_path, relativePath) => { if (matches(args.pattern, args.pattern.includes('/') ? relativePath : relativePath.split('/').at(-1))) paths.push(relativePath); return paths.length < 200; });
        return { ...result(JSON.stringify({ paths, ...traversal })), details: { count: paths.length, ...traversal } };
      } },
    { id: 'project_grep', name: 'project_grep', label: '搜索项目内容', permission: 'read', effect: 'read', idempotent: true, enabled: true, trusted: true,
      description: `Search project text files for a literal string (default) or a regular expression, returning matches grouped by file, each as its line number, a colon (a hyphen for a context line), a tab, then the line. Files of any size are scanned line by line (UTF-8 or GBK); binaries, private paths and symlinks are skipped and reported. Returns up to ${GREP_DEFAULT_MATCHES} matches by default (limit up to ${GREP_MAX_MATCHES}); a capped result says so. Use this first to locate content in large files, then project_read with offset near the matched line for the surrounding text. Use this tool instead of grep in project_exec.`,
      parameters: { type: 'object', properties: {
        query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Text to find. Literal unless regex is true.' },
        path: { type: 'string', description: 'Project-relative file or directory to search; defaults to the project directory.' },
        regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression (e.g. "^第[0-9一二三四五六七八九十百]+章"). Default false.' },
        caseSensitive: { type: 'boolean', description: 'Default false.' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines to show before and after each match. Default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: GREP_MAX_MATCHES, description: `Maximum matches to return. Default ${GREP_DEFAULT_MATCHES}.` } }, required: ['query'], additionalProperties: false },
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        if (typeof args.query !== 'string' || !args.query || args.query.length > 1000) throw problem('A query of 1–1000 characters is required.', 'invalid_arguments');
        let pattern = null;
        if (args.regex) { try { pattern = new RegExp(args.query, args.caseSensitive ? 'u' : 'iu'); } catch (error) { throw problem(`Invalid regular expression: ${error.message}`, 'invalid_arguments'); } }
        const needle = args.caseSensitive ? args.query : args.query.toLowerCase(), limit = args.limit ?? GREP_DEFAULT_MATCHES, around = args.context ?? 0;
        const test = line => pattern ? pattern.test(line) : (args.caseSensitive ? line : line.toLowerCase()).includes(needle);
        const clip = line => line.length > GREP_LINE_CHARS ? `${line.slice(0, GREP_LINE_CHARS)}…` : line;
        const groups = [], skipped = []; let total = 0, capped = false, bytesScanned = 0, filesScanned = 0;
        const visit = async (path, relativePath) => {
          signal?.throwIfAborted();
          let handle;
          try { handle = await openRead(path); } catch (error) { if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) { skipped.push({ path: relativePath, reason: error.code }); return true; } throw error; }
          const hits = [], before = []; let pendingAfter = 0;
          try {
            const stats = await streamTextLines(handle, { onLine: (line, number) => {
              if (test(line)) {
                if (total >= limit) { capped = true; return false; }
                total++; hits.push({ line: number, text: clip(line), before: around ? before.slice() : undefined, after: around ? [] : undefined }); pendingAfter = around;
              } else if (pendingAfter > 0) { hits.at(-1).after.push({ line: number, text: clip(line) }); pendingAfter--; }
              if (around) { before.push({ line: number, text: clip(line) }); if (before.length > around) before.shift(); }
              return true;
            } });
            filesScanned++; bytesScanned += stats.bytes;
          } catch (error) { if (['binary_file', 'invalid_file'].includes(error.code)) { skipped.push({ path: relativePath, reason: 'binary' }); return true; } throw error; }
          finally { await handle.close().catch(() => {}); }
          if (hits.length) groups.push({ path: relativePath, hits });
          return !capped;
        };
        const target = await check(args.path || '.'), info = await lstat(target); let traversal;
        if (info.isDirectory()) traversal = await walk(args.path, signal, visit);
        else {
          // A newly supported explicit file must not turn a skipped symlink
          // into an additional read capability. Keep directory walk semantics.
          let current = root;
          for (const part of relative(root, lexical(args.path || '.')).split(sep)) {
            signal?.throwIfAborted(); current = resolve(current, part);
            if ((await lstat(current)).isSymbolicLink()) throw problem('File searches do not follow symbolic links.', 'path_denied');
          }
          traversal = { scanned: 1, truncated: info.isFile() ? await visit(target, relative(root, target).split(sep).join('/')) === false : false };
        }
        signal?.throwIfAborted();
        const lines = [];
        for (const group of groups) {
          lines.push(group.path);
          for (const hit of group.hits) {
            for (const row of hit.before ?? []) lines.push(`  ${row.line}-${READ_LINE_SEPARATOR}${row.text}`);
            lines.push(`  ${hit.line}:${READ_LINE_SEPARATOR}${hit.text}`);
            for (const row of hit.after ?? []) lines.push(`  ${row.line}-${READ_LINE_SEPARATOR}${row.text}`);
          }
        }
        const notes = [
          total ? `${total} match${total === 1 ? '' : 'es'} in ${groups.length} file${groups.length === 1 ? '' : 's'} (${filesScanned} scanned).` : `No matches (${filesScanned} file${filesScanned === 1 ? '' : 's'} scanned).`,
          ...(capped ? [`Result capped at ${limit} matches; more exist. Narrow path or query, or raise limit (max ${GREP_MAX_MATCHES}).`] : []),
          ...(traversal?.truncated && !capped ? ['Directory traversal stopped at its entry limit; narrow path to search the rest.'] : []),
          ...(skipped.length ? [`Skipped ${skipped.length} file(s): ${skipped.slice(0, 5).map(row => `${row.path} (${row.reason})`).join(', ')}${skipped.length > 5 ? ', …' : ''}.`] : []),
          ...(total ? ['Use project_read with offset near a matched line to read its surroundings.'] : []),
        ];
        return { ...result(`${lines.join('\n')}${lines.length ? '\n\n' : ''}[${notes.join(' ')}]`), details: { count: total, files: groups.length, filesScanned, bytesScanned, capped, truncated: capped || Boolean(traversal?.truncated), skipped: skipped.length, skippedFiles: skipped.slice(0, 50), matches: groups.flatMap(group => group.hits.map(hit => ({ path: group.path, line: hit.line, text: hit.text }))), ...traversal } };
      } }
  );
  if (includeMutations) tools.push(
    { id: 'project_write', name: 'project_write', label: '保存项目文件', description: 'Atomically save a UTF-8 project file. For a NEW file, prefer createOnly:true and OMIT expectedHash; existing files are never overwritten in this mode. Parent directories are created when needed. For an UPDATE, pass the SHA-256 returned by project_read as expectedHash, or omit it: the file must then still be the version this conversation last read or wrote (a partial read counts). A file this conversation never read is not overwritten. Legacy JSON null also requires a new file; the string "null" is invalid. Returns SHA-256. Private paths and symlinks are denied. Do not automatically replay an uncertain write.', enabled: true, trusted: true, permission: 'write', effect: 'write', idempotent: false,
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, createOnly: { type: 'boolean', description: 'Prefer true for a new file: atomically create only if absent. Must not be combined with expectedHash. False or omitted preserves normal write/update behavior.' }, expectedHash }, required: ['path', 'content'], additionalProperties: false, not: { properties: { createOnly: { const: true } }, required: ['createOnly', 'expectedHash'] } }, execute: (_id, args, signal, _update, execution) => mutate(args, signal, false, execution), reconcile: (input, signal) => reconcile(input, signal, false) },
    { id: 'project_edit', name: 'project_edit', label: '精确修改项目文件', description: 'Replace exact text in one UTF-8 project file, then save it atomically. Each edits[].oldText must match exactly one place in the file as it was before this call (edits are not applied one after another) and must not overlap another edit; to change several places in one file, send one call with several edits instead of several calls. Keep each oldText as small as possible while still unique in the file; do not pad it with large unchanged regions. oldText must match the file exactly, including indentation: strip the project_read line prefix (line number + tab) before matching, and keep it out of newText. CRLF line breaks and a byte-order mark are handled for you. A missing, ambiguous or overlapping match, or a changed expectedHash, fails without writing anything. Returns before/after SHA-256. Do not automatically replay an uncertain edit.', enabled: true, trusted: true, permission: 'write', effect: 'write', idempotent: false,
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, edits: { type: 'array', minItems: 1, description: 'One or more replacements, each matched against the original file.', items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1, description: 'Exact text that occurs once in the file.' }, newText: { type: 'string' } }, required: ['oldText', 'newText'], additionalProperties: false } }, oldText: { type: 'string', minLength: 1, description: 'Older single-edit form; prefer edits.' }, newText: { type: 'string', description: 'Older single-edit form; prefer edits.' }, expectedHash }, required: ['path'], additionalProperties: false }, execute: (_id, args, signal, _update, execution) => mutate(args, signal, true, execution), reconcile: (input, signal) => reconcile(input, signal, true) },
    createExecTool({ root, check, execLogDir, maxOutputBytes, execTimeoutMs, sandbox, sandboxExtra, sandboxDeny, sandboxDenyRead: denied, sandboxDenyPrefixes: deniedText, sandboxReadable: readable, sandboxDenyPorts, withheldEnv, ...(sandboxExec ? { sandboxExec } : {}) })
  );
  return tools;
}
