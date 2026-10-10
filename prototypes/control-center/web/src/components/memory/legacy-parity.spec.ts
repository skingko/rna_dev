// @ts-nocheck -- fixtures deliberately use malformed, partial and historical record shapes.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { memoryPageDisplay, memoryCollectionDisplay, memoryEntryKind, memoryReadableDocument, memoryDisplayTitle } from './memory-display'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Ported 1:1 from the host's legacy public/memory-browser-display.js tests when the legacy UI was removed.

// ---- reader (test/memory-reader.test.mjs)
{
const entry = { title: `${'a'.repeat(64)}.md`, kind: 'resource', provenance: { kind: 'autonomous_delivery', role: 'assistant', itemId: 'delivery-1' } };
const payload = { kind: 'autonomous_delivery', itemId: 'delivery-1', sourceRole: 'assistant', text: '# 调研报告\n\n今日发现 <script>test</script>\n\n中文正文', evidence: [{ receipts: [{ toolName: 'project_read', status: 'completed' }] }] };
const document = value => `# 项目执行资料：助手主动交付\n\n来源记录：delivery-1\n\n## 原始来源的有界投影\n\n${JSON.stringify(value)}\n`;

test('reader separates real recorded report from technical receipts while retaining exact original', () => {
  const raw = document(payload), result = memoryReadableDocument(raw, entry);
  assert.equal(result.kind, 'assistant-report'); assert.equal(result.text, payload.text); assert.equal(result.raw, raw);
  assert.doesNotMatch(result.text, /project_read/); assert.match(result.raw, /project_read/);
});
test('reader requires known provenance and matching stored identity, not a JSON-shaped memory', () => {
  for (const meta of [{}, { provenance: { ...entry.provenance, itemId: 'other' } }, { provenance: { ...entry.provenance, role: 'user' } }]) {
    const result = memoryReadableDocument(document(payload), meta); assert.equal(result.kind, 'document'); assert.equal(result.text, document(payload));
  }
  for (const value of [{ ...payload, kind: 'interaction_answer' }, { ...payload, sourceRole: 'user' }, { ...payload, text: null }]) assert.equal(memoryReadableDocument(document(value), entry).kind, 'document');
});
test('malformed or changed archive formats stay readable as original without fabricated content', () => {
  for (const raw of ['普通记忆正文', JSON.stringify(payload), document(payload).replace('有界投影', '新格式'), document(payload) + 'extra', '']) {
    const result = memoryReadableDocument(raw, entry); assert.equal(result.kind, 'document'); assert.equal(result.raw, raw); assert.equal(result.text, raw);
  }
});
test('truncated evidence is labelled as an archive excerpt without fetching or supplementing text', () => {
  const result = memoryReadableDocument(document({ ...payload, textTruncated: true }), entry);
  assert.equal(result.truncated, true); assert.match(result.label, /节选/); assert.equal(result.text, payload.text);
});
test('display names preserve actual provided titles and use explicit neutral identifiers for opaque file names', () => {
  assert.equal(memoryDisplayTitle({ ...entry, displayTitle: 'AI 应用周报' }), 'AI 应用周报');
  assert.equal(memoryDisplayTitle(entry), '项目资料 · aaaaaaaa');
  assert.equal(memoryDisplayTitle({ ...entry, kind: 'memory' }), '项目记忆 · aaaaaaaa');
  assert.equal(memoryDisplayTitle({ title: '研发约定.md' }), '研发约定.md');
});
}

// ---- pagination and inventory (test/memory-browser-display.test.mjs)
test('directory pagination uses explicit backend offsets and never mistakes page size for total', () => {
  const first = memoryPageDisplay({ entries: Array(20).fill({}), total: 20, offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
  assert.equal(first.previousOffset, null); assert.equal(first.nextOffset, 20); assert.match(first.label, /1–20.*还有更多/);
  const last = memoryPageDisplay({ entries: Array(18).fill({}), total: 18, offset: 20, limit: 20, hasMore: false, nextOffset: null });
  assert.equal(last.previousOffset, 0); assert.equal(last.nextOffset, null); assert.match(last.label, /21–38.*末页/);
});
test('invalid next cursors cannot loop backwards or exceed supported browsing range', () => {
  for (const nextOffset of [-1, 0, 20, 10001, NaN, '40']) assert.equal(memoryPageDisplay({ offset: 20, hasMore: true, nextOffset }).nextOffset, null);
  assert.equal(memoryPageDisplay({ offset: 20, hasMore: true, nextOffset: 40 }).nextOffset, 40);
});
test('root directories are categorised explicitly instead of looking like two memory records', () => {
  const page = memoryPageDisplay({ entries: [{ isDirectory: true }, { isDirectory: true }], hasMore: false });
  assert.match(page.label, /2 个目录、0 个文件/); assert.equal(page.directories, 2); assert.equal(page.files, 0);
});
test('bounded inventory only claims observed file counts and keeps resource files distinct', async () => {
  const complete = memoryCollectionDisplay({ collection: { memoryFiles: 45, resourceFiles: 1, directories: 23, complete: true, checkedAt: '2026-09-26T00:00:00Z' } });
  assert.match(complete.title, /45 个记忆文件 · 1 个项目资料文件/); assert.equal(complete.partial, false); assert.match(complete.detail, /目录不是记忆条数/);
  const partial = memoryCollectionDisplay({ collection: { memoryFiles: 45, resourceFiles: 1, directories: 23, complete: false } });
  assert.match(partial.title, /^已扫描范围内/); assert.match(partial.detail, /不是总数/); assert.equal(partial.partial, true);
  assert.equal(memoryCollectionDisplay({}), null); assert.equal(memoryEntryKind({ isDirectory: true, kind: 'memory' }), '目录'); assert.equal(memoryEntryKind({ kind: 'resource' }), '项目资料');
  const recent = memoryPageDisplay({ view: 'recent', entries: [{ kind: 'memory' }, { kind: 'resource' }] }); assert.match(recent.label, /1–2 个文件/); assert.doesNotMatch(recent.label, /2 条记忆/);
});
