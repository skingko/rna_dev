import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Oversized tool output stays out of the model context (plan 2026-09-30 §4.3,
// after Harness spill-policy and pi's bash truncation): the model keeps the
// ordered head and tail plus a line-addressed pointer, and the complete text is
// saved privately in this session and read back with tool_output_read. This is
// lossless and deterministic; judging which omitted parts matter is the
// separate `tool.admission` point.
export const SPILL_INLINE_BYTES = 40 * 1024;
export const SPILL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const SPILL_ID = /^out-[a-f0-9]{12}$/;
const READ_DEFAULT_LINES = 200, READ_MAX_LINES = 2000, READ_MAX_BYTES = 50 * 1024, LINE_CHARS = 2000, MATCHES = 100;
const fail = (message, code) => Object.assign(new Error(message), { code });
const bytes = value => Buffer.byteLength(value, 'utf8');

/**
 * Each tool declares its own spill policy (harness spill-policy exempts read, index.ts:135; zcode gives read a budget
 * equal to its own limit, read.ts:501-508; mu passes read/edit/write through): a tool that already pages or bounds
 * its output (project_read, tool_output_read, project_exec_output, skill_load, project_exec) sets `spill: false`, so
 * its result is never cut a second time. Every other tool's oversized text is spilled.
 */
export const spillsOutput = tool => tool?.spill !== false;

export const spillId = key => `out-${createHash('sha256').update(String(key)).digest('hex').slice(0, 12)}`;

/** Lines from one end until the byte budget is used (at least one, cut if a single line is too long). */
function take(lines, budget, fromEnd) {
  const picked = []; let used = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[fromEnd ? lines.length - 1 - index : index], size = bytes(line) + 1;
    if (used + size > budget) { if (!picked.length) picked.push(line.slice(0, Math.max(1, Math.floor(budget / 3))) + '…'); break; }
    picked.push(line); used += size;
  }
  return fromEnd ? picked.reverse() : picked;
}

/** Replace an oversized text with head + pointer + tail and save the whole. Returns null when it fits. */
export function spillText(text, { dir, id, inlineBytes = SPILL_INLINE_BYTES } = {}) {
  if (typeof text !== 'string' || bytes(text) <= inlineBytes || !dir || !SPILL_ID.test(id ?? '')) return null;
  if (bytes(text) > SPILL_MAX_FILE_BYTES) text = text.slice(0, SPILL_MAX_FILE_BYTES);
  const lines = text.split('\n'), budget = Math.floor(inlineBytes * .45);
  const head = take(lines, budget, false), tail = take(lines.slice(head.length), budget, true);
  const from = head.length + 1, to = lines.length - tail.length;
  if (to < from) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${id}.txt`), text, { mode: 0o600 });
  const omittedBytes = bytes(lines.slice(from - 1, to).join('\n'));
  const notice = `[Lines ${from}-${to} of ${lines.length} are omitted here (${omittedBytes} bytes). The complete output is saved as "${id}". Read any range with tool_output_read {"id": "${id}", "offset": ${from}, "limit": ${READ_DEFAULT_LINES}}, or find lines with {"id": "${id}", "pattern": "..."}. Do not rerun the tool just to see the rest.]`;
  return { text: `${head.join('\n')}\n\n${notice}\n\n${tail.join('\n')}`, spill: { id, bytes: bytes(text), lines: lines.length, omitted: [from, to] } };
}

/** tool_output_read: line pages or a search over one saved output of this session. */
export function createSpillReadTool({ dir } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('A private spill directory is required.');
  const root = resolve(dir);
  const load = id => {
    if (!SPILL_ID.test(id ?? '')) throw fail('Unknown output id.', 'SPILL_ID_INVALID');
    const path = join(root, `${id}.txt`);
    let info; try { info = lstatSync(path); } catch { throw fail(`No saved output "${id}" in this conversation.`, 'SPILL_NOT_FOUND'); }
    if (!info.isFile() || info.isSymbolicLink()) throw fail('Saved output is unavailable.', 'SPILL_NOT_FILE');
    return readFileSync(path, 'utf8').split('\n');
  };
  const clip = line => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}… [line truncated]` : line);
  return {
    id: 'tool_output_read', name: 'tool_output_read', label: '读取完整输出', permission: 'read', effect: 'read', idempotent: true, spill: false,
    description: 'Read the complete text of a tool result that was too long to show in full. When a result says lines were omitted and gives an id like out-1a2b3c4d5e6f, pass that id with offset (1-based line) and limit to read a range, or pattern (a regular expression, or plain text if it is not one) to list matching lines with their numbers. Read only the part you need; never rerun the original tool just to see the rest.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: { type: 'string', pattern: '^out-[a-f0-9]{12}$' },
      offset: { type: 'integer', minimum: 1, description: '1-based first line to read; default 1.' },
      limit: { type: 'integer', minimum: 1, maximum: READ_MAX_LINES, description: `Lines to read; default ${READ_DEFAULT_LINES}.` },
      pattern: { type: 'string', minLength: 1, maxLength: 500, description: 'List lines matching this regular expression (case-insensitive) instead of reading a range.' },
      context: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match; default 0.' },
    } },
    async execute(_callId, args = {}, signal) {
      signal?.throwIfAborted();
      try {
        const lines = load(args.id), total = lines.length;
        if (args.pattern !== undefined) {
          let regex; try { regex = new RegExp(args.pattern, 'i'); } catch { regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
          const context = args.context ?? 0, shown = new Set(), hits = [];
          for (let index = 0; index < total && hits.length < MATCHES; index++) if (regex.test(lines[index])) hits.push(index);
          const out = [];
          for (const hit of hits) for (let index = Math.max(0, hit - context); index <= Math.min(total - 1, hit + context); index++) if (!shown.has(index)) { shown.add(index); out.push(`${index + 1}${index === hit ? ':' : '-'}\t${clip(lines[index])}`); }
          const footer = hits.length ? `${hits.length}${hits.length === MATCHES ? '+' : ''} matching lines of ${total}.${hits.length === MATCHES ? ' Narrow the pattern to see more.' : ''}` : `No line of ${total} matches.`;
          return { content: [{ type: 'text', text: `${out.join('\n')}${out.length ? '\n\n' : ''}${footer}` }], details: { id: args.id, total, matches: hits.map(index => index + 1) } };
        }
        const start = Math.max(1, args.offset ?? 1), limit = Math.min(READ_MAX_LINES, args.limit ?? READ_DEFAULT_LINES);
        if (start > total) throw fail(`Offset ${start} is past the end (${total} lines).`, 'SPILL_OFFSET_INVALID');
        const out = []; let used = 0, end = start - 1;
        for (let index = start - 1; index < Math.min(total, start - 1 + limit); index++) {
          const row = `${index + 1}\t${clip(lines[index])}`;
          if (used + bytes(row) + 1 > READ_MAX_BYTES && out.length) break;
          out.push(row); used += bytes(row) + 1; end = index + 1;
        }
        const footer = end < total ? `Showing lines ${start}-${end} of ${total}. Use offset=${end + 1} to continue.` : `Showing lines ${start}-${end} of ${total} (end).`;
        return { content: [{ type: 'text', text: `${out.join('\n')}\n\n${footer}` }], details: { id: args.id, total, range: [start, end] } };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }], details: { code: error.code ?? 'SPILL_READ_FAILED' } };
      }
    },
  };
}
