// Minimal, bounded ZIP reader for marketplace skill packages (stored or deflate entries only).
// Returns regular files; directory entries are skipped and any unsafe or oversized entry fails.
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error { constructor(message, code = 'zip_invalid') { super(message); this.name = 'ZipError'; this.code = code; } }

export function readZip(buffer, { maxEntries = 2000, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError('Not a ZIP archive');
  // End of central directory: signature 0x06054b50 within the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ZipError('ZIP end record missing');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (count > maxEntries || offset + size > buffer.length) throw new ZipError('ZIP directory out of bounds', 'zip_limit');
  const files = []; let position = offset, total = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) throw new ZipError('ZIP directory entry invalid');
    const method = buffer.readUInt16LE(position + 10), compressed = buffer.readUInt32LE(position + 20), length = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28), extraLength = buffer.readUInt16LE(position + 30), commentLength = buffer.readUInt16LE(position + 32);
    const external = buffer.readUInt32LE(position + 38), local = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    position += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    // Symlinks (unix mode 0120000 in the high bits) are reported, never materialized.
    const symlink = ((external >>> 16) & 0o170000) === 0o120000;
    total += length; if (length > maxBytes || total > maxBytes) throw new ZipError('ZIP contents exceed the size limit', 'zip_limit');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new ZipError('ZIP local header invalid');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28), raw = buffer.subarray(start, start + compressed);
    if (start + compressed > buffer.length) throw new ZipError('ZIP entry out of bounds');
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, length) });
    else throw new ZipError(`Unsupported ZIP compression method ${method}`, 'zip_unsupported');
    if (data.length !== length) throw new ZipError('ZIP entry size mismatch');
    files.push({ path: name, data, symlink });
  }
  return files;
}
