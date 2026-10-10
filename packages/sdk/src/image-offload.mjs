import { createHash } from 'node:crypto';
import { ImageInputError, MAX_REQUEST_IMAGES, MAX_REQUEST_IMAGE_BYTES, normalizeImage, validateMessageImages } from './images.mjs';

/** Plan a request-only repair. New/unobserved pixels and the latest user image
 * remain intact; already completed tools and original journal messages never change. */
export function planImageOffload(messages, model) {
  const latestUserImage = messages.findLast(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image'))?.id;
  const observedThrough = messages.findLastIndex(message => message.role === 'assistant' && !['error', 'aborted'].includes(message.stopReason));
  const images = [];
  for (const [position, message] of messages.entries()) {
    let imageIndex = 0;
    for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'image') {
      // Per-image format, model capability and protocol limits are never repaired
      // by hiding an invalid or unsupported input.
      const { bytes } = validateMessageImages([{ ...message, content: [block] }], model);
      images.push({ messageId: message.id, imageIndex: imageIndex++, bytes, eligible: position < observedThrough && message.id !== latestUserImage });
    }
  }
  const before = { count: images.length, bytes: images.reduce((sum, image) => sum + image.bytes, 0) }, after = { ...before };
  if (after.count <= MAX_REQUEST_IMAGES && after.bytes <= MAX_REQUEST_IMAGE_BYTES) return null;
  const targets = new Map();
  for (const image of images) {
    if (after.count <= MAX_REQUEST_IMAGES && after.bytes <= MAX_REQUEST_IMAGE_BYTES) break;
    if (!image.eligible) continue;
    const indexes = targets.get(image.messageId) ?? [];
    indexes.push(image.imageIndex); targets.set(image.messageId, indexes);
    after.count--; after.bytes -= image.bytes;
  }
  if (after.count > MAX_REQUEST_IMAGES || after.bytes > MAX_REQUEST_IMAGE_BYTES) throw new ImageInputError('最新用户图片或尚未查看的工具图片超过请求上限；请减少本批图片。历史图片和工具结果已保留。', 'image_limit');
  return { reason: 'request-image-budget', before, after, targets: [...targets].map(([messageId, imageIndexes]) => ({ messageId, imageIndexes })) };
}

/** Validate a whole durable selection before publishing it. Indexes count all
 * original image occurrences, including ones already offloaded. */
export function applyImageOffload(messages, previous, targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('Invalid image_offload targets.');
  const next = new Map(previous), seen = new Set();
  for (const target of targets) {
    const message = messages.find(value => value.id === target?.messageId);
    if (!message || !['user', 'tool', 'toolResult'].includes(message.role) || seen.has(message.id) || !Array.isArray(target.imageIndexes) || !target.imageIndexes.length) throw new Error('Invalid image_offload message.');
    seen.add(message.id);
    const count = (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image').length;
    const indexes = new Set(previous.get(message.id) ?? []); let last = -1;
    for (const index of target.imageIndexes) {
      if (!Number.isSafeInteger(index) || index < 0 || index <= last || index >= count || indexes.has(index)) throw new Error('Invalid or repeated image_offload occurrence.');
      indexes.add(index); last = index;
    }
    next.set(message.id, indexes);
  }
  return next;
}

export function projectImageOffloads(messages, offloads = new Map(), history = new Map()) {
  if (!offloads.size && !history.size) return messages;
  return messages.map(message => {
    const indexes = offloads.get(message.id), marks = history.get(message.id);
    if (!indexes?.size && !marks?.size || !Array.isArray(message.content)) return message;
    let index = 0;
    return { ...message, content: message.content.map(block => {
      if (block.type !== 'image') return block;
      const at = index++;
      if (indexes?.has(at)) {
        const { mimeType, bytes, sha256 } = imageIdentity(block);
        return { type: 'text', text: `[Earlier image offloaded from this model request: ${mimeType}; ${bytes} bytes; sha256:${sha256}. Original pixels remain in the session journal. Preserve established observations; this placeholder is not new visual evidence. Re-read the existing attachment or file if its pixels are needed again. The original tool operation already completed; do not repeat its side effects.]` };
      }
      const mark = marks?.get(at);
      return mark ? { type: 'text', text: historyImageText(block, mark) } : block;
    }) };
  });
}

// ---- Observed-image history (request projection only; the journal keeps pixels)
// Pi (transform-messages) and Harness (projectImagesForTextModel) replace
// images with stable text for a text-only model. Rna additionally stops
// resending pixels a vision model already observed once they are older than
// the most recent user turns: each placeholder is derived only from the image
// bytes and the assistant reply that first followed it, so it is byte-stable
// across requests and the cached prefix changes at most once per image.
export const IMAGE_RECENT_USER_TURNS = 2;
const IMAGE_EXCERPT_CHARS = 160;
const identities = new Map();
function imageIdentity(block) {
  const key = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 64)}:${block.data.slice(-64)}`, known = identities.get(key);
  if (known?.data === block.data) return known.identity;
  const image = normalizeImage(block), bytes = Buffer.from(image.data, 'base64');
  const identity = { mimeType: image.mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (identities.size >= 256) identities.delete(identities.keys().next().value);
  identities.set(key, { data: block.data, identity });
  return identity;
}
function historyImageText(block, mark) {
  const { mimeType, bytes, sha256 } = imageIdentity(block);
  if (mark.reason === 'unsupported') return `[Image omitted: the selected model does not accept image input, so these pixels were not inspected. ${mimeType}; ${bytes} bytes; sha256:${sha256.slice(0, 16)}. Do not infer its visual content; the operation that produced it already completed.]`;
  return `[Earlier image omitted from this request: ${mimeType}; ${bytes} bytes; sha256:${sha256.slice(0, 16)}. It was part of an earlier turn; the original pixels remain in the session record and this text is not new visual evidence.${mark.excerpt ? ` The assistant reply that followed it began: ${JSON.stringify(mark.excerpt)}.` : ''} If its pixels are needed again, re-read the original attachment or file with an assigned tool (an image-capable model is required).]`;
}
const USER_INPUT_EXCLUDED = new Set(['context', 'compaction', 'finish-feedback', 'resume']);
const replyExcerpt = message => {
  const text = (Array.isArray(message?.content) ? message.content : []).filter(block => block.type === 'text').map(block => block.text).join(' ').replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, IMAGE_EXCERPT_CHARS).join('') : '';
};
/** Which retained images a request should present as text. Observed = a
 * successful assistant response followed the image. Text-only (or undeclared)
 * models: every observed image, and unobserved tool images; an unobserved user
 * image stays so the capability check reports it. Vision models: observed
 * images older than the last IMAGE_RECENT_USER_TURNS user inputs.
 * `throughMessageId` (append-only Anthropic targets): plan only over messages up to and including that message,
 * so a warm prefix never flips; later images keep their pixels until the thinking floor moves. `null` or an id
 * that is not in `messages` flips nothing. */
export function planHistoryImages(messages, model, offloads = new Map(), { recentUserTurns = IMAGE_RECENT_USER_TURNS, throughMessageId } = {}) {
  const history = new Map();
  if (throughMessageId !== undefined) {
    const end = throughMessageId === null ? -1 : messages.findIndex(message => message.id === throughMessageId);
    if (end < 0) return history;
    messages = messages.slice(0, end + 1);
  }
  if (!messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) return history;
  const vision = Array.isArray(model?.input) && model.input.includes('image');
  const observedThrough = messages.findLastIndex(message => message.role === 'assistant' && !['error', 'aborted'].includes(message.stopReason));
  const users = messages.flatMap((message, index) => message.role === 'user' && !USER_INPUT_EXCLUDED.has(message.source) ? [index] : []);
  const windowStart = users.length >= recentUserTurns ? users[users.length - recentUserTurns] : 0;
  for (const [position, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    const durable = offloads.get(message.id); let index = 0, excerpt;
    for (const block of message.content) if (block.type === 'image') {
      const at = index++, observed = position < observedThrough;
      if (durable?.has(at)) continue;
      const reason = observed ? (!vision || position < windowStart ? 'history' : null) : !vision && message.role !== 'user' ? 'unsupported' : null;
      if (!reason) continue;
      if (reason === 'history' && excerpt === undefined) excerpt = replyExcerpt(messages.slice(position + 1).find(row => row.role === 'assistant'));
      if (!history.has(message.id)) history.set(message.id, new Map());
      history.get(message.id).set(at, { reason, excerpt });
    }
  }
  return history;
}
/** Durable offload selection over projection-retained pixels must skip both
 * durable offloads and request-only history placeholders. */
export function retainedOffloads(offloads, history) {
  if (!history?.size) return offloads;
  const merged = new Map(offloads);
  for (const [id, marks] of history) merged.set(id, new Set([...(offloads.get(id) ?? []), ...marks.keys()]));
  return merged;
}

/** Projection planning counts retained images; durable targets count original
 * occurrences. Translate without relying on image contents or mutable paths. */
export function originalImageTargets(messages, offloads, targets) {
  return targets.map(target => {
    const source = messages.find(message => message.id === target.messageId);
    const previous = offloads.get(target.messageId) ?? new Set();
    const retained = []; let index = 0;
    for (const block of source.content) if (block.type === 'image') { if (!previous.has(index)) retained.push(index); index++; }
    return { messageId: target.messageId, imageIndexes: target.imageIndexes.map(value => retained[value]) };
  });
}
