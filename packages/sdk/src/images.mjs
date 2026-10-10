import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_REQUEST_IMAGES = 16;
// Admission estimate, not a provider tokenizer or billed usage. Actual reported
// usage remains authoritative; reserve pixels separately from base64 transport.
export const IMAGE_TOKEN_RESERVE = 8192;
export class ImageInputError extends Error {
  constructor(message, code = 'invalid_image') { super(message); this.name = 'ImageInputError'; this.code = code; }
}
export function normalizeImage(block) {
  if (!block || block.type !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mimeType) || typeof block.data !== 'string') throw new ImageInputError('图片需要 PNG/JPEG/GIF/WebP 的内联 base64 内容；不接受 URL。');
  if (block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new ImageInputError('图片超过 8 MiB 上限。', 'image_limit');
  if (!block.data.length || block.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw new ImageInputError('图片 base64 内容无效。');
  const bytes = Buffer.from(block.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageInputError('图片超过 8 MiB 上限。', 'image_limit');
  if (bytes.toString('base64') !== block.data) throw new ImageInputError('图片必须使用规范 base64 编码。');
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (detected !== block.mimeType) throw new ImageInputError('图片 MIME 与文件内容不一致，或图片格式无效。');
  return { type: 'image', data: block.data, mimeType: block.mimeType };
}
export function requireImageInput(model) {
  if (!Array.isArray(model?.input) || !model.input.includes('image')) throw new ImageInputError(model?.input?.includes('text')
    ? `模型 ${model.modelId} 不支持图像输入；尚未读取图片像素，请选择支持图像的已配置模型。`
    : `模型 ${model?.modelId ?? ''} 尚未声明图像输入能力；尚未读取图片像素，请核对模型配置。`, model?.input ? 'image_not_supported' : 'image_capability_unknown');
}
export function validateMessageImages(messages, model) {
  let count = 0, bytes = 0;
  for (const message of messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'image') {
    if (!['user', 'tool', 'toolResult'].includes(message.role)) throw new ImageInputError('图片仅支持用户输入和工具结果。', 'image_role_unsupported');
    const image = normalizeImage(block); count++; const size = Buffer.byteLength(image.data, 'base64'); bytes += size;
    if (model?.protocol === 'anthropic' && size > 5 * 1024 * 1024) throw new ImageInputError('Messages 协议单图不能超过 5 MiB；请先缩小图片。', 'image_limit');
  }
  if (count > MAX_REQUEST_IMAGES || bytes > MAX_REQUEST_IMAGE_BYTES) throw new ImageInputError('请求图片超过 16 张或 16 MiB 上限；请减少图片或压缩早期上下文。', 'image_limit');
  if (count && model) requireImageInput(model);
  return { count, bytes };
}
/** Summaries contain handles, never base64 masquerading as visual evidence. */
export function imageTranscript(messages) {
  return messages.map(message => ({ ...message, ...(Array.isArray(message.content) ? { content: message.content.map(block => {
    if (block.type !== 'image') return block;
    const image = normalizeImage(block), bytes = Buffer.from(image.data, 'base64');
    return { type: 'text', text: `[Image reference: ${image.mimeType}; ${bytes.length} bytes; sha256:${createHash('sha256').update(bytes).digest('hex')}. Pixels are not included in this summary input. Preserve prior evidenced observations; do not infer visual content. Original pixels remain in the session journal.]` };
  }) } : {}) }));
}
