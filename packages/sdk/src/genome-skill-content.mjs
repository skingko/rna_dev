import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
/** Shared host/evaluation content projection. File authorization and immutable
 * bundle verification belong to the caller, before supplying these bytes. */
export function formatSkillContent({ id, path = 'SKILL.md', raw, offset = 0, limit = 200, resources = [] }) {
  if (typeof id !== 'string' || typeof path !== 'string' || typeof raw !== 'string' || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid skill content request');
  const lines = raw.split('\n'), selected = lines.slice(offset, offset + limit).join('\n'), content = selected.slice(0, 30000);
  return { id, path, content, contentHash: hash(raw), offset, limit, totalLines: lines.length, truncated: offset + limit < lines.length || content.length < selected.length,
    ...(path === 'SKILL.md' ? { resources: resources.map(resource => ({ path: resource.path, bytes: Buffer.byteLength(resource.content), contentHash: hash(resource.content) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } : {}) };
}
