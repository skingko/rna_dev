import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { McpClient } from './mcp.mjs';

export class CapabilityError extends Error {
  constructor(message, code = 'invalid_capability') { super(message); this.name = 'CapabilityError'; this.code = code; }
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const permissions = new Set(['read', 'write', 'exec']);
// These content/format fields annotate a schema; this validator does not claim
// format assertion or media decoding support. Structural validation is unchanged.
const supported = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'format', 'contentEncoding', 'contentMediaType', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'type', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { if (typeof value !== 'string' || !idPattern.test(value)) throw new CapabilityError('Capability id must be 1–160 simple characters'); return value; }
function assertSchema(schema, root = schema, seen = new Set()) {
  if (typeof schema === 'boolean') return;
  if (!object(schema)) throw new CapabilityError('Tool parameters must be a JSON schema', 'invalid_schema');
  if (seen.has(schema)) return; seen.add(schema);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new CapabilityError(`Unsupported JSON schema keyword: ${key}`, 'unsupported_schema');
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) throw new CapabilityError('Only local JSON schema references are supported', 'unsupported_schema');
    resolveRef(schema.$ref, root);
  }
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).length) throw new CapabilityError('Schema type list cannot be empty', 'invalid_schema');
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).every(t => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t))) throw new CapabilityError('Unknown JSON schema type', 'invalid_schema');
  for (const key of ['required', 'enum']) if (schema[key] !== undefined && (!Array.isArray(schema[key]) || key === 'enum' && !schema[key].length || key === 'required' && !schema[key].every(value => typeof value === 'string'))) throw new CapabilityError(`Invalid ${key}`, 'invalid_schema');
  for (const key of ['$defs', 'definitions', 'properties']) if (schema[key] !== undefined && !object(schema[key])) throw new CapabilityError(`Invalid ${key}`, 'invalid_schema');
  for (const key of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minLength', 'maxLength']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) throw new CapabilityError(`Invalid ${key}`, 'invalid_schema');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || key === 'multipleOf' && schema[key] <= 0)) throw new CapabilityError(`Invalid ${key}`, 'invalid_schema');
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') throw new CapabilityError('Invalid uniqueItems', 'invalid_schema');
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') throw new CapabilityError('Invalid pattern', 'invalid_schema');
  if (schema.pattern !== undefined) { try { new RegExp(schema.pattern, 'u'); } catch { throw new CapabilityError('Invalid JSON schema pattern', 'invalid_schema'); } }
  for (const key of ['$defs', 'definitions', 'properties']) if (schema[key]) for (const child of Object.values(schema[key])) assertSchema(child, root, seen);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (schema[key]) { if (!Array.isArray(schema[key])) throw new CapabilityError(`Invalid ${key}`, 'invalid_schema'); for (const child of schema[key]) assertSchema(child, root, seen); }
  for (const key of ['not', 'items', 'additionalProperties']) if (schema[key] !== undefined) assertSchema(schema[key], root, seen);
}
function resolveRef(ref, root) {
  let current = root;
  for (const raw of ref.slice(2).split('/')) { const key = raw.replace(/~1/g, '/').replace(/~0/g, '~'); if (!object(current) || !Object.hasOwn(current, key)) throw new CapabilityError('Unresolved local JSON schema reference', 'invalid_schema'); current = current[key]; }
  return current;
}
function validate(schema, value, path, root, depth) {
  const fail = message => { throw new CapabilityError(`${path}: ${message}`, 'invalid_arguments'); };
  if (depth > 80) fail('schema nesting limit exceeded');
  if (schema === true) return; if (schema === false) fail('value is forbidden');
  if (schema.$ref) validate(resolveRef(schema.$ref, root), value, path, root, depth + 1);
  if (schema.const !== undefined && !isDeepStrictEqual(schema.const, value)) fail('does not equal const');
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) fail('not in enum');
  if (schema.allOf) for (const child of schema.allOf) validate(child, value, path, root, depth + 1);
  for (const key of ['anyOf', 'oneOf']) if (schema[key]) {
    let hits = 0; for (const child of schema[key]) { try { validate(child, value, path, root, depth + 1); hits++; } catch (error) { if (error.code !== 'invalid_arguments') throw error; } }
    if (!hits || (key === 'oneOf' && hits !== 1)) fail(`${key} constraint failed`);
  }
  if (schema.not) { let matches = true; try { validate(schema.not, value, path, root, depth + 1); } catch (error) { if (error.code !== 'invalid_arguments') throw error; matches = false; } if (matches) fail('not constraint failed'); }
  const typeMatches = type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)) fail(`expected ${JSON.stringify(schema.type)}`);
  if (object(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing required property ${key}`);
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail('too few properties');
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail('too many properties');
    for (const key of keys) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(schema.properties[key], value[key], `${path}.${key}`, root, depth + 1);
      else if (schema.additionalProperties === false) fail(`unexpected property ${key}`);
      else if (object(schema.additionalProperties)) validate(schema.additionalProperties, value[key], `${path}.${key}`, root, depth + 1);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some(other => isDeepStrictEqual(item, other)))) fail('duplicate items');
    value.forEach((item, i) => { const sub = schema.prefixItems?.[i] ?? schema.items; if (sub !== undefined) validate(sub, item, `${path}[${i}]`, root, depth + 1); });
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('string is too short');
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('string is too long');
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('pattern constraint failed');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('number must be finite');
    for (const [key, ok] of [['minimum', value >= schema.minimum], ['maximum', value <= schema.maximum], ['exclusiveMinimum', value > schema.exclusiveMinimum], ['exclusiveMaximum', value < schema.exclusiveMaximum]]) if (schema[key] !== undefined && !ok) fail(`${key} constraint failed`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) fail('multipleOf constraint failed');
  }
}
function assertJsonValue(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size > 80 || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new CapabilityError('Tool arguments must be finite, acyclic JSON values', 'invalid_arguments');
  ancestors.add(value); for (const item of Object.values(value)) assertJsonValue(item, ancestors); ancestors.delete(value);
}
export function validateToolArguments(schema, value) { assertSchema(schema); assertJsonValue(value); validate(schema, value, '$', schema, 0); return value; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export function mcpToolName(serverId, rawName) {
  // Retain the tuple separately: public normalization is never used to reverse-map wire names.
  const raw = `mcp__${serverId}__${rawName}`, clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean === raw && raw.length <= 64 ? raw : `${clean.slice(0, 49)}_${hash(JSON.stringify([serverId, rawName])).slice(0, 14)}`;
}
// A small inert YAML scalar reader for common SKILL.md metadata, not a general
// YAML parser. Only exact top-level keys are read; tags/anchors are not evaluated.
export function skillMetadataField(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/), index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const scalar = lines[index].slice(key.length + 1).trim();
  const block = scalar.match(/^([>|])([1-9]?[+-]?|[+-][1-9]?)\s*(?:#.*)?$/);
  if (block) {
    const body = []; for (const line of lines.slice(index + 1)) { if (line.trim() && !/^ +/.test(line)) break; body.push(line); }
    const indent = Number(block[2].match(/[1-9]/)?.[0]) || body.find(line => line.trim())?.match(/^ */)[0].length || 0;
    const values = body.map(line => line.trim() ? line.slice(indent) : '');
    if (block[1] === '|') return values.join('\n').trim();
    let folded = '';
    for (let i = 0; i < values.length; i++) {
      folded += values[i]; if (i === values.length - 1) break;
      const current = values[i], next = values[i + 1];
      folded += current && next && !/^\s/.test(current) && !/^\s/.test(next) ? ' ' : !current && next ? '' : '\n';
    }
    return folded.trim();
  }
  if (scalar.startsWith("'")) return scalar.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)?.[1].replace(/''/g, "'");
  if (scalar.startsWith('"')) { const value = scalar.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/)?.[1]; if (!value) return undefined; try { return JSON.parse(value); } catch { return undefined; } }
  return scalar.replace(/\s+#.*$/, '').trim();
}
export async function loadSkill(manifest) {
  if (!manifest?.enabled || !manifest?.trusted) throw new CapabilityError('Skill is not enabled and trusted', 'not_authorized');
  identifier(manifest.id);
  const filePath = await realpath(manifest.path?.endsWith('SKILL.md') ? manifest.path : join(manifest.path || '', 'SKILL.md'));
  const info = await stat(filePath); if (!info.isFile() || info.size > 512 * 1024) throw new CapabilityError('SKILL.md must be a file no larger than 512 KiB');
  const instructions = await readFile(filePath, 'utf8');
  if (!instructions.trim()) throw new CapabilityError('SKILL.md is empty');
  // Skill content is inert instructions. Code blocks/frontmatter are never evaluated.
  const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = key => skillMetadataField(frontmatter, key);
  return { id: manifest.id, name: manifest.name || field('name') || manifest.id, description: manifest.description || field('description') || '', instructions, contentHash: hash(instructions), filePath, enabled: true, trusted: true };
}
function authorized(value) { return value.enabled === true && value.trusted === true; }
// A definite MCP failure is an ordinary tool error the model can act on: the
// server answered with a JSON-RPC error, or the request never left the client.
// Only a lost transport/timeout on a mutating tool leaves its outcome unknown
// (the session then marks the call uncertain); a read tool's failure never does.
const MCP_NOT_EXECUTED = new Set(['remote_error', 'not_ready']);
async function callMcpTool(client, name, args, signal, rule) {
  try { return await client.callTool(name, args, { signal }); }
  catch (error) {
    if (signal?.aborted || !(MCP_NOT_EXECUTED.has(error?.code) || rule.permission === 'read')) throw error;
    return { isError: true, content: [{ type: 'text', text: `MCP tool ${name} failed (${error?.code ?? 'error'}): ${String(error?.message ?? error).slice(0, 2000)}` }] };
  }
}
function publicTool(tool) { return { id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters, permission: tool.permission, effect: tool.effect, idempotent: tool.idempotent, mcpServerId: tool.mcpServerId, enabled: true, trusted: true }; }
export class CapabilityRegistry {
  constructor({ skills = [], tools = [], mcpServers = [], clientFactory = config => new McpClient(config) } = {}) {
    if (typeof clientFactory !== 'function') throw new CapabilityError('MCP clientFactory must be a function'); this.clientFactory = clientFactory;
    this.skills = new Map(); this.tools = new Map(); this.mcpServers = new Map(); this.clients = new Map(); this.connecting = new Map(); this.pendingClients = new Map(); this.closed = false;
    for (const item of skills) this.registerSkill(item);
    for (const item of tools) this.registerTool(item);
    for (const item of mcpServers) this.registerMcpServer(item);
  }
  registerSkill(manifest) { const id = identifier(manifest.id); if (this.skills.has(id)) throw new CapabilityError(`Duplicate skill id: ${id}`); if (typeof manifest.path !== 'string' || !manifest.path.trim()) throw new CapabilityError('Skill requires an explicit SKILL.md path'); this.skills.set(id, { ...manifest }); return id; }
  registerTool(manifest) {
    const id = identifier(manifest.id || manifest.name); if (this.tools.has(id)) throw new CapabilityError(`Duplicate tool id: ${id}`);
    const name = manifest.name || id; if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || [...this.tools.values()].some(tool => tool.name === name)) throw new CapabilityError('Tool names must be unique provider-compatible names');
    const permission = manifest.permission; if (!permissions.has(permission)) throw new CapabilityError('Tool must declare read, write or exec permission');
    const parameters = structuredClone(manifest.parameters || manifest.inputSchema || { type: 'object', properties: {}, additionalProperties: false }); assertSchema(parameters);
    if (typeof manifest.execute !== 'function') throw new CapabilityError('Tool requires an execute function');
    const execute = async (callId, args, signal, onUpdate, execution) => { if (!authorized(manifest)) throw new CapabilityError('Tool is not enabled and trusted', 'not_authorized'); signal?.throwIfAborted(); validateToolArguments(parameters, args); return manifest.execute(callId, args, signal, onUpdate, execution); };
    this.tools.set(id, { ...manifest, id, name, description: manifest.description || '', permission, effect: permission === 'read' ? 'read' : 'write', parameters, execute }); return id;
  }
  registerMcpServer(manifest) {
    const id = identifier(manifest.id); if (this.mcpServers.has(id)) throw new CapabilityError(`Duplicate MCP server id: ${id}`);
    if (!['stdio', 'http'].includes(manifest.transport)) throw new CapabilityError('MCP transport must be stdio or http');
    if (manifest.allowTools !== undefined && !object(manifest.allowTools)) throw new CapabilityError('MCP allowTools must map raw tool names to explicit permission declarations');
    for (const rule of Object.values(manifest.allowTools || {})) if (!object(rule) || !permissions.has(rule.permission)) throw new CapabilityError('Each allowed MCP tool requires read, write or exec permission');
    this.mcpServers.set(id, structuredClone(manifest)); return id;
  }
  async catalog() {
    const skills = [];
    // A skill whose SKILL.md is gone (its package or project was removed) is left out of the catalog instead of failing
    // everything built on it (live, 2026-10-04: two deleted projects' skills made every new project's setup fail with
    // ENOENT). It stays listed in skillFailures for diagnostics.
    this.skillFailures = [];
    for (const manifest of this.skills.values()) if (authorized(manifest)) {
      try { const { instructions, filePath, ...publicSkill } = await loadSkill(manifest); skills.push(publicSkill); }
      catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error; this.skillFailures.push({ id: manifest.id, code: 'skill_missing' }); }
    }
    return { skills, tools: [...this.tools.values()].filter(authorized).map(publicTool), mcpServers: [...this.mcpServers.values()].filter(authorized).map(server => ({ id: server.id, name: server.name || server.id, description: server.description || '', transport: server.transport, connected: this.clients.get(server.id)?.ready === true && !this.clients.get(server.id)?.closed, toolIds: [...this.tools.values()].filter(tool => tool.mcpServerId === server.id && authorized(tool)).map(tool => tool.id), enabled: true, trusted: true })) };
  }
  async connectMcp(id, { signal } = {}) {
    if (this.closed) throw new CapabilityError('Capability registry is closed', 'registry_closed');
    const existing = this.clients.get(id);
    if (existing?.ready && !existing.closed) return existing;
    if (existing) { this.clients.delete(id); for (const [toolId, tool] of this.tools) if (tool.mcpServerId === id) this.tools.delete(toolId); await existing.close(); }
    if (this.closed) throw new CapabilityError('Capability registry is closed', 'registry_closed');
    if (this.connecting.has(id)) return this.connecting.get(id);
    const pending = this._connectMcp(id, { signal }); this.connecting.set(id, pending);
    try { return await pending; } finally { this.connecting.delete(id); }
  }
  async _connectMcp(id, { signal } = {}) {
    const server = this.mcpServers.get(id); if (!server || !authorized(server)) throw new CapabilityError('MCP server is not explicitly configured, enabled and trusted', 'not_authorized');
    if (this.clients.has(id)) return this.clients.get(id);
    const client = await this.clientFactory(server, { signal }); this.pendingClients.set(id, client);
    try {
      if (this.closed) throw new CapabilityError('Capability registry closed during connection', 'registry_closed');
      await client.connect({ signal }); const discovered = await client.listTools({ signal });
      if (this.closed || client.closed) throw new CapabilityError('Capability registry closed during connection', 'registry_closed');
      signal?.throwIfAborted();
      const additions = discovered.filter(tool => Object.hasOwn(server.allowTools || {}, tool.name)).map(tool => {
        const rule = server.allowTools[tool.name]; const rawId = `mcp:${id}:${tool.name}`; return { id: idPattern.test(rawId) ? rawId : `mcp:${hash(JSON.stringify([id, tool.name])).slice(0, 32)}`, name: mcpToolName(id, tool.name), description: tool.description || '', parameters: tool.inputSchema, permission: rule.permission, idempotent: rule.idempotent === true, mcpServerId: id, rawName: tool.name, enabled: true, trusted: true, execute: (_callId, args, requestSignal) => callMcpTool(client, tool.name, args, requestSignal, rule) };
      });
      // Stage validation before changing the live directory.
      const staging = new CapabilityRegistry({ tools: additions });
      for (const tool of staging.tools.values()) if (this.tools.has(tool.id) || [...this.tools.values()].some(existing => existing.name === tool.name)) throw new CapabilityError('Discovered MCP tool conflicts with an existing tool');
      for (const tool of additions) this.registerTool(tool);
      this.clients.set(id, client); return client;
    } catch (error) { await client.close(); throw error; }
    finally { this.pendingClients.delete(id); }
  }
  async resolve({ skillIds = [], toolIds = [], mcpServerIds = [] } = {}) {
    const select = (ids, source, kind) => [...new Set(ids)].map(id => { const item = source.get(id); if (!item || !authorized(item)) throw new CapabilityError(`Unknown or unauthorized ${kind}: ${id}`, 'not_authorized'); return item; });
    const skills = await Promise.all(select(skillIds, this.skills, 'skill').map(loadSkill));
    const tools = select(toolIds, this.tools, 'tool'); const servers = select(mcpServerIds, this.mcpServers, 'MCP server');
    for (const tool of tools) if (tool.mcpServerId && !mcpServerIds.includes(tool.mcpServerId)) throw new CapabilityError('Assigned MCP tools require their server assignment', 'not_authorized');
    return { skills, tools, mcpServers: servers.map(server => ({ id: server.id, name: server.name || server.id, transport: server.transport })) };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; const clients = [...new Set([...this.clients.values(), ...this.pendingClients.values()])]; this.clients.clear();
    this.closePromise = (async () => { await Promise.allSettled(clients.map(client => client.close())); await Promise.allSettled([...this.connecting.values()]); for (const [id, tool] of this.tools) if (tool.mcpServerId) this.tools.delete(id); })();
    return this.closePromise;
  }
}
