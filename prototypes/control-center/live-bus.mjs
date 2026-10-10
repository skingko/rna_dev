// In-process, display-only live events (stream protocol v2 `delta`,
// `turn.phase`, and a background run's `work.step`). Nothing here is persisted
// or bumps the Store revision; the durable projection remains
// Store.mutate()/projectRuntimeDisplay().
export class LiveBus {
  constructor() { this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event) { for (const listener of this.listeners) { try { listener(event); } catch (error) { console.error('live listener:', error.message); } } }
}
export const liveBus = store => store.live ??= new LiveBus();

// Tool presentation for the v2 UI: a stable verb/icon class and a short target.
const KINDS = new Map(Object.entries({
  project_read: 'read', project_list: 'read', project_exec_output: 'read', project_history: 'read', attachment_read: 'read', project_document_read: 'read', openviking_read: 'read', learning_context_read: 'read', learning_context_list: 'read', read_context: 'read',
  project_find: 'search', project_grep: 'search', openviking_search: 'search', project_write: 'write', project_edit: 'edit', project_exec: 'command',
  web_search: 'web_search', web_fetch: 'web_fetch', skill_load: 'skill', ask_user: 'question', request_project_permission: 'question',
  project_schedule: 'plan', project_schedule_list: 'plan'
}));
export const toolKind = name => typeof name !== 'string' ? 'other' : KINDS.get(name) ?? (name.startsWith('mcp__') ? 'mcp' : 'other');
// What a background run's steps are counted by (summary.work steps.kinds): the coarse kinds the tasks panel shows.
export const STEP_KINDS = ['read', 'search', 'edit', 'write', 'command', 'web', 'other'];
const STEP_KIND = { read: 'read', search: 'search', edit: 'edit', write: 'write', command: 'command', web_search: 'web', web_fetch: 'web' };
export const stepKind = name => STEP_KIND[toolKind(name)] ?? 'other';
const short = (value, limit = 160) => { const line = String(value).trim().split('\n')[0].trim(); return line.length > limit ? `${line.slice(0, limit - 1)}…` : line; };
// Secrets (and their URL-encoded form) go before the target is cut, so a cut never leaves part of one behind.
const redacted = (text, values) => { let value = String(text); for (const secret of values) if (typeof secret === 'string' && secret.length >= 4) for (const form of [secret, encodeURIComponent(secret)]) value = value.split(form).join('[REDACTED]'); return value; };
/** The short target of a tool call (a path, command, query, URL …). `redactValues`: secrets to hide; `limit`: its length. */
export function toolTarget(name, args, { redactValues = [], limit = 160 } = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {}, pick = (...keys) => keys.map(key => a[key]).find(value => typeof value === 'string' && value.trim());
  const kind = toolKind(name);
  let value;
  if (kind === 'command') value = pick('command');
  else if (kind === 'web_fetch') value = pick('url');
  else if (kind === 'web_search' || kind === 'search') { const query = pick('query', 'pattern'), path = pick('path'); value = query && path ? `${query} · ${path}` : query ?? path; }
  else if (kind === 'question') { const question = Array.isArray(a.questions) ? a.questions.find(row => row && typeof row === 'object') : null; value = [question?.question, question?.prompt, question?.title, question?.header].find(text => typeof text === 'string' && text.trim()) ?? pick('reason', 'question', 'capability'); }
  else if (kind === 'skill') value = pick('id', 'name', 'skill');
  else if (kind === 'read' || kind === 'write' || kind === 'edit') value = pick('path', 'uri', 'outputId', 'id', 'name');
  else value = pick('path', 'query', 'url', 'command', 'title', 'name', 'id', 'task') ?? Object.values(a).find(item => typeof item === 'string' && item.trim());
  if (value === undefined && kind === 'mcp') value = name.split('__').slice(2).join('__') || null;
  return value === undefined || value === null ? null : short(redactValues.length ? redacted(value, redactValues) : value, limit);
}

// Tolerant reader for a streaming JSON object prefix: the top-level string
// fields among `keys` seen so far; an unterminated last string is returned as
// far as it has arrived. Never throws; nested values and non-strings are skipped.
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
export const TARGET_FIELDS = ['path', 'command', 'query', 'pattern', 'url', 'uri', 'id', 'name', 'skill', 'title', 'task'];
export function partialJsonFields(text, keys = ['path', 'command', 'query', 'url']) {
  const out = {}, wanted = new Set(keys), source = typeof text === 'string' ? text : '';
  let i = source.indexOf('{'), depth = 0, key = null, expect = 'key';
  if (i < 0) return out;
  const readString = () => { // at an opening quote → [value, complete]
    let value = ''; i++;
    while (i < source.length) {
      const char = source[i];
      if (char === '"') { i++; return [value, true]; }
      if (char !== '\\') { value += char; i++; continue; }
      const next = source[i + 1]; if (next === undefined) break;
      if (next === 'u') { const hex = source.slice(i + 2, i + 6); if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; value += String.fromCharCode(parseInt(hex, 16)); i += 6; continue; }
      value += ESCAPES[next] ?? next; i += 2;
    }
    i = source.length; return [value, false];
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '"') {
      if (depth !== 1) { readString(); continue; }
      const [value, complete] = readString();
      if (expect === 'key') { key = complete ? value : null; expect = 'colon'; }
      else if (expect === 'value') { if (key !== null && wanted.has(key) && !Object.hasOwn(out, key)) out[key] = value; expect = 'next'; }
      continue;
    }
    if (char === '{' || char === '[') { if (depth === 1 && expect === 'value') expect = 'next'; depth++; }
    else if (char === '}' || char === ']') { depth--; if (depth <= 0) break; }
    else if (depth === 1 && char === ':' && expect === 'colon') expect = 'value';
    else if (depth === 1 && char === ',') { expect = 'key'; key = null; }
    else if (depth === 1 && expect === 'value' && !/\s/.test(char)) expect = 'next'; // number, boolean, null
    i++;
  }
  return out;
}
