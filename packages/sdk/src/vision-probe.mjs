import { deflateSync } from 'node:zlib';
import { streamCompletion, ProviderError } from './providers.mjs';
import { llmJudgeReasoning } from './decision-llm-judge.mjs';

/** Identify image input from the upstream model's own response, not from its
 * name or a catalog: send a small solid red picture and ask for its colour.
 *   - answers "red"                      → ['text', 'image']
 *   - answers something else (pixels were
 *     silently dropped)                  → ['text']
 *   - rejects the image request while an
 *     identical text-only request passes → ['text']
 *   - anything else (auth, rate limit, network, both rejected) → null (unknown)
 */
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
/** A solid-colour RGB PNG (default 64×64 red). */
export function solidPng(size = 64, [r, g, b] = [220, 20, 20]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const QUESTION = 'What is the main colour of the attached image? Reply with one English word only.';
const REJECTED = new Set([400, 404, 415, 422]);

async function ask(provider, request, content, signal) {
  let text = '';
  for await (const event of provider({ ...request, messages: [{ role: 'user', content }], tools: [], signal, maxRetries: 0 })) if (event.type === 'text_delta') { text += event.delta; if (text.length > 400) break; }
  return text;
}

export async function probeImageInput({ model, apiKey, provider = streamCompletion, signal, purpose = 'vision' } = {}) {
  const reasoning = llmJudgeReasoning(model.reasoningCapability);
  const request = { model: { ...model, input: ['text', 'image'], reasoning, maxOutputTokens: Math.max(1, Math.min(model.maxOutputTokens ?? 2048, reasoning === 'off' ? 64 : 2048)) }, apiKey, systemPrompt: 'Answer the question directly.', purpose };
  for (const key of ['reasoningCapability', 'reasoningSelection', 'reasoningDecision']) delete request.model[key];
  const image = { type: 'image', mimeType: 'image/png', data: solidPng().toString('base64') };
  try {
    const answer = await ask(provider, request, [{ type: 'text', text: QUESTION }, image], signal);
    if (!answer.trim()) return null;
    return { input: /\bred\b|红/i.test(answer) ? ['text', 'image'] : ['text'], evidence: /\bred\b|红/i.test(answer) ? 'answered' : 'ignored_image', answer: answer.trim().slice(0, 80) };
  } catch (error) {
    signal?.throwIfAborted();
    const status = error instanceof ProviderError ? error.status : undefined;
    if (!REJECTED.has(status)) return null;
    // The same request without the picture must pass, or the rejection was not about images.
    try { await ask(provider, { ...request, model: { ...request.model, input: ['text'] } }, [{ type: 'text', text: 'Reply with the word ok.' }], signal); }
    catch { signal?.throwIfAborted(); return null; }
    return { input: ['text'], evidence: 'rejected_image', status };
  }
}
