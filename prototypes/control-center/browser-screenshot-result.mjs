import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeImage } from '../../packages/sdk/src/images.mjs';

const MAX_BYTES = 3 * 1024 * 1024;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fail = () => Object.assign(new Error('Browser screenshot output is unavailable within its owned scope.'), { code: 'browser_screenshot_unavailable' });
export function validBrowserFilename(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value); }
export async function checkBrowserOutput(outputDir, filename) {
  if (!validBrowserFilename(filename)) throw fail();
  const root = await lstat(outputDir);
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(outputDir) !== outputDir) throw fail();
  try { const target = await lstat(join(outputDir, filename)); if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw fail(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return root;
}

/** Playwright 0.0.82 saves explicit filenames relative to cwd and suppresses
 * inline images. Our controlled cwd equals outputDir. Read that exact basename,
 * never a Markdown link, resource URL, model path or another session's file. */
export async function screenshotResult(result, args, outputDir, signal) {
  if (result.isError || result.content.some(part => part.type === 'image') || !args?.filename) return result;
  let file;
  try {
    signal?.throwIfAborted();
    const root = await checkBrowserOutput(outputDir, args.filename), path = join(outputDir, args.filename);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BYTES) throw fail();
    const bytes = Buffer.alloc(before.size); let length = 0;
    while (length < bytes.length) { signal?.throwIfAborted(); const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const current = await lstat(path), after = await file.stat();
    if (length !== before.size || current.isSymbolicLink() || !same(before, current) || current.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !same(root, await lstat(outputDir)) || await realpath(outputDir) !== outputDir) throw fail();
    const format = args.type ?? ({ '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }[extname(args.filename).toLowerCase()] ?? 'png');
    const image = normalizeImage({ type: 'image', mimeType: `image/${format}`, data: bytes.toString('base64') });
    signal?.throwIfAborted();
    return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ source: 'host-owned-browser-screenshot', filename: args.filename, mimeType: image.mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), instruction: 'Native screenshot pixels follow. The saved path is private browser output, not a user attachment or workspace path. Do not search other directories to locate it.' }) }, image] };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...result, isError: true, content: [...result.content, { type: 'text', text: 'Screenshot command returned, but its pixels could not be safely read from the current browser output directory. Pixels were not inspected. Do not search other directories or use attachment_read for this private output; a screenshot without filename can return inline pixels.' }], details: { ...result.details, code: 'browser_screenshot_unavailable', pixelsAvailable: false } };
  } finally { await file?.close(); }
}
