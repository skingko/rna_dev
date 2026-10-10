import { memoryEvidenceMessages } from './memory-evidence-outbox.mjs';

const clip = (value, limit) => { const chars = Array.from(value); return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value; };
const opaqueName = /^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\.[a-z0-9]+)?$/i;

// A display projection, not a generated summary. Keep the author's wording,
// omit Markdown decoration and fenced/structured data, and bound every field.
export function memoryTextPresentation(text) {
  const lines = []; let fence = null;
  for (const raw of Array.from(String(text ?? '')).slice(0, 24000).join('').split(/\r?\n/)) {
    const marker = raw.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; continue; }
    if (fence) continue;
    let value = raw.trim();
    if (!value || /^(?:[-*_]\s*){3,}$/.test(value) || /^[{}|,]/.test(value) || /^[\[\]]\s*$/.test(value) || /^\[\s*["{\d\[]/.test(value) || /^\s*"[^"\n]+"\s*:/.test(value)) continue;
    value = value.replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').replace(/(?:\*\*|__|~~|`+)/g, '').replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[，。！？,.!?])/g, '$1$2')
      .replace(/\\([\\`*_{}\[\]()#+.!>~-])/g, '$1').replace(/\s+/g, ' ').trim();
    if (value && /[\p{L}\p{N}]/u.test(value)) lines.push(value);
    if (lines.length >= 8) break;
  }
  if (!lines.length) return {};
  const sentence = lines[0].match(/^.*?[。！？]|^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? lines[0];
  return { displayTitle: clip(sentence, 100), displayExcerpt: clip(lines.join(' '), 180) };
}

/** Called after visibility checks, never while building browseSnapshots.
 * Verify the immutable source again before deriving text; do not trust a
 * filename, remote summary, or an outbox's unverified copied display fields. */
export function memoryEntryPresentation(state, projectId, namespace, entry) {
  const fileName = String(entry.title ?? entry.uri.split('/').at(-1));
  const generic = { ...entry, fileName, displayTitle: opaqueName.test(fileName)
    ? `${entry.isDirectory ? '资料目录' : entry.kind === 'memory' ? '项目记忆' : '项目资料'} · ${fileName.slice(0, 8)}`
    : fileName.replace(/\.md$/i, ''), displayTitleSource: opaqueName.test(fileName) ? 'identifier' : 'filename' };
  const root = `${namespace}/rna-execution-evidence`;
  if (entry.uri === root) return { ...generic, displayTitle: '主动交付资料', displayTitleSource: 'category' };
  if (!entry.uri.startsWith(`${root}/`) || !entry.isLeaf) return generic;
  for (const session of state.sessions ?? []) {
    if (session.projectId !== projectId) continue;
    const write = session.memoryEvidenceOutbox?.find(row => row.resourceIndex?.uri === entry.uri && row.resourceIndex.status === 'completed');
    if (!write || write.sourceKind !== 'autonomous_delivery' || entry.uri !== `${root}/${session.id}/${write.sourceRefs?.[0]?.sourceHash}.md`) continue;
    try {
      const source = JSON.parse(memoryEvidenceMessages(state, session.id, write).map(row => row.content).join(''));
      if (source.kind !== 'autonomous_delivery' || source.itemId !== write.sourceRefs[0].itemId || typeof source.text !== 'string') return null;
      const presentation = memoryTextPresentation(source.text);
      return { ...generic, ...presentation, displayTitleSource: presentation.displayTitle ? 'assistant_delivery' : generic.displayTitleSource,
        provenance: { kind: 'autonomous_delivery', role: 'assistant', sessionId: session.id, itemId: source.itemId,
          createdAt: source.createdAt ?? null, sourceHash: write.sourceRefs[0].sourceHash } };
    } catch { return null; }
  }
  return null;
}
