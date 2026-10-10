/**
 * Provider-neutral media model calls: image generation/editing, speech
 * synthesis, transcription and video generation. Each call uses the base URL
 * and key of a model provider the user already configured; nothing here reads
 * credentials itself. Image/speech/transcription follow the OpenAI-compatible
 * endpoints most providers implement; video generation has no common API, so
 * the provider's task API is selected explicitly (`VIDEO_APIS`).
 */
import { codexAuthHeaders, codexClientHeaders } from './subscription-provider.mjs';
export const MEDIA_KINDS = Object.freeze(['image', 'speech', 'transcription', 'video']);
/** openai: /images/edits multipart; generations: /images/generations with an `image` field (SiliconFlow, Volcengine Ark, ...). */
export const IMAGE_EDIT_APIS = Object.freeze(['openai', 'generations']);
export const VIDEO_APIS = Object.freeze(['openai', 'zhipu', 'ark', 'siliconflow', 'dashscope']);
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export class MediaModelError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = 'MediaModelError'; this.code = code; this.details = details; }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }
  signal?.addEventListener('abort', abort, { once: true });
});
const join = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`;
const mimeOf = (bytes, fallback = 'application/octet-stream') => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  return fallback;
};
export const extensionOf = mimeType => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/opus': 'opus', 'video/mp4': 'mp4', 'video/webm': 'webm' })[mimeType] ?? 'bin';

async function failure(response, label) {
  let detail = '';
  try { const body = await response.text(); try { const data = JSON.parse(body); detail = data.error?.message ?? data.message ?? data.msg ?? data.error ?? body; } catch { detail = body; } } catch {}
  detail = String(typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').slice(0, 300);
  const code = response.status === 401 || response.status === 403 ? 'media_auth' : response.status === 429 ? 'media_rate_limit' : response.status === 404 || response.status === 405 ? 'media_endpoint_unsupported' : 'media_request_failed';
  return new MediaModelError(`${label}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`, code, { status: response.status });
}
function client({ baseUrl, apiKey, fetchImpl = globalThis.fetch, signal, headers: extra = {} }) {
  const auth = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const request = async (url, { method = 'POST', json, form, headers = {}, label = '媒体请求' } = {}) => {
    const response = await fetchImpl(url.startsWith('http') ? url : join(baseUrl, url), { method, signal, headers: { ...auth, ...extra, ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, ...(json ? { body: JSON.stringify(json) } : form ? { body: form } : {}) });
    if (!response.ok) throw await failure(response, label);
    return response;
  };
  return {
    json: async (url, options) => { const response = await request(url, options); try { return await response.json(); } catch { throw new MediaModelError(`${options?.label ?? '媒体请求'}返回的不是 JSON`, 'media_bad_response'); } },
    bytes: async (url, options) => bytesOf(await request(url, options)),
    // Result URLs are signed object-store links: fetched without the provider key.
    download: async url => {
      if (!/^https:\/\//i.test(url)) throw new MediaModelError('媒体结果地址不是 HTTPS', 'media_bad_response');
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw await failure(response, '下载生成结果');
      return bytesOf(response);
    }
  };
}
async function bytesOf(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > MAX_MEDIA_BYTES) throw new MediaModelError('生成结果超过 200 MB 上限', 'media_too_large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaModelError('生成结果超过 200 MB 上限', 'media_too_large');
  const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim();
  return { bytes, mimeType: mimeOf(bytes, type && type !== 'application/octet-stream' ? type : undefined) };
}
const blob = ({ bytes, mimeType }) => new Blob([bytes], { type: mimeType ?? mimeOf(bytes) });
const dataUrl = ({ bytes, mimeType }) => `data:${mimeType ?? mimeOf(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;

/** `images` (optional) are source images to edit or reference. Returns [{ bytes, mimeType }]. */
export async function generateImage({ baseUrl, apiKey, model, prompt, size, count = 1, images = [], editApi = 'openai', fetchImpl, signal }) {
  const api = client({ baseUrl, apiKey, fetchImpl, signal });
  let data;
  if (images.length && editApi === 'openai') {
    const form = new FormData();
    form.set('model', model); form.set('prompt', prompt); form.set('n', String(count)); if (size) form.set('size', size);
    images.forEach((image, index) => form.append(images.length > 1 ? 'image[]' : 'image', blob(image), `image-${index + 1}.${extensionOf(image.mimeType ?? mimeOf(image.bytes))}`));
    data = await api.json('/images/edits', { form, label: '图片编辑' });
  } else {
    const reference = images.length ? { image: images.length > 1 ? images.map(dataUrl) : dataUrl(images[0]) } : {};
    data = await api.json('/images/generations', { json: { model, prompt, n: count, ...(size ? { size } : {}), ...reference }, label: images.length ? '图片编辑' : '图片生成' });
  }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.images) ? data.images : [];
  const results = [];
  for (const row of rows) {
    if (typeof row?.b64_json === 'string') { const bytes = Buffer.from(row.b64_json, 'base64'); results.push({ bytes, mimeType: mimeOf(bytes, 'image/png'), ...(row.revised_prompt ? { revisedPrompt: row.revised_prompt } : {}) }); }
    else if (typeof row?.url === 'string') results.push({ ...(await api.download(row.url)), ...(row.revised_prompt ? { revisedPrompt: row.revised_prompt } : {}) });
  }
  if (!results.length) throw new MediaModelError('图片接口没有返回图片', 'media_bad_response');
  return results;
}

/**
 * A ChatGPT subscription (Codex login) covers image generation and speech
 * recognition through the routes the Codex clients themselves use with that
 * login: Codex's image tool (codex/images/generations|edits, one image per
 * call) and Codex's dictation (backend-api/transcribe, the backend chooses the
 * speech model). They are ChatGPT's own routes, not the public OpenAI API, and
 * may change. Speech synthesis and video have no such route.
 *
 * The image models are listed here because nothing lists them (live,
 * 2026-10-10): the account catalog (codex/models) holds chat models only (10
 * rows, none of them an image model), and the image route returns an image
 * for any model name, a made-up one included, so asking it about a name tells
 * nothing and costs an image. A new GPT Image model is added to this list
 * when OpenAI releases it.
 */
export const SUBSCRIPTION_MEDIA = Object.freeze({ image: Object.freeze(['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']), transcription: Object.freeze(['chatgpt-transcribe']) });
export const SUBSCRIPTION_IMAGE_REFERENCES = 5;
const CHATGPT = 'https://chatgpt.com/backend-api';
/** `credential({ signal, forceRefresh })` resolves the login; a rejected token is refreshed once. */
async function subscriptionRequest({ credential, fetchImpl = globalThis.fetch, signal }, path, { json, form }, label) {
  for (let refreshed = false; ; refreshed = true) {
    let auth;
    try { auth = codexAuthHeaders(await credential({ signal, ...(refreshed ? { forceRefresh: true } : {}) })); }
    catch (error) { if (signal?.aborted) throw error; throw new MediaModelError('ChatGPT 订阅尚未登录或登录已失效，请在 设置 → 模型 中重新登录', 'media_auth'); }
    const response = await fetchImpl(`${CHATGPT}${path}`, { method: 'POST', signal, redirect: 'manual', headers: { ...auth, ...codexClientHeaders(), accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : form });
    if (response.status === 401 && !refreshed) { void response.body?.cancel().catch(() => {}); continue; }
    if (!response.ok) throw await failure(response, label);
    try { return await response.json(); } catch { throw new MediaModelError(`${label}返回的不是 JSON`, 'media_bad_response'); }
  }
}
/** One image from the ChatGPT subscription; `images` (up to 5) are edited or used as references. */
export async function generateSubscriptionImage({ credential, model = 'gpt-image-2', prompt, size, images = [], fetchImpl, signal }) {
  if (images.length > SUBSCRIPTION_IMAGE_REFERENCES) throw new MediaModelError(`订阅图片编辑最多使用 ${SUBSCRIPTION_IMAGE_REFERENCES} 张参考图`, 'media_invalid_configuration');
  const json = { model, prompt, ...(size ? { size } : {}), ...(images.length ? { images: images.map(image => ({ image_url: dataUrl(image) })) } : {}) };
  const data = await subscriptionRequest({ credential, fetchImpl, signal }, images.length ? '/codex/images/edits' : '/codex/images/generations', { json }, images.length ? '图片编辑' : '图片生成');
  const row = Array.isArray(data?.data) ? data.data[0] : undefined;
  if (typeof row?.b64_json !== 'string' || !row.b64_json) throw new MediaModelError('图片接口没有返回图片', 'media_bad_response');
  const bytes = Buffer.from(row.b64_json, 'base64');
  return { bytes, mimeType: mimeOf(bytes, 'image/png'), ...(typeof row.revised_prompt === 'string' ? { revisedPrompt: row.revised_prompt } : {}) };
}
export async function transcribeSubscriptionAudio({ credential, audio, filename = 'audio', language, fetchImpl, signal }) {
  const form = new FormData();
  form.set('file', blob(audio), filename); if (language) form.set('language', language);
  const data = await subscriptionRequest({ credential, fetchImpl, signal }, '/transcribe', { form }, '语音识别');
  if (typeof data?.text !== 'string') throw new MediaModelError('语音识别接口没有返回文本', 'media_bad_response');
  return { text: data.text.trim() };
}

export async function synthesizeSpeech({ baseUrl, apiKey, model, input, voice, format = 'mp3', instructions, fetchImpl, signal }) {
  const result = await client({ baseUrl, apiKey, fetchImpl, signal }).bytes('/audio/speech', { json: { model, input, ...(voice ? { voice } : {}), response_format: format, ...(instructions ? { instructions } : {}) }, label: '语音合成' });
  if (result.mimeType === 'application/json' || !result.bytes.length) throw new MediaModelError('语音接口没有返回音频', 'media_bad_response');
  return result;
}

export async function transcribeAudio({ baseUrl, apiKey, model, audio, filename = 'audio', language, prompt, fetchImpl, signal }) {
  const form = new FormData();
  form.set('model', model); form.set('file', blob(audio), filename); if (language) form.set('language', language); if (prompt) form.set('prompt', prompt);
  const data = await client({ baseUrl, apiKey, fetchImpl, signal }).json('/audio/transcriptions', { form, label: '语音识别' });
  if (typeof data?.text !== 'string') throw new MediaModelError('语音识别接口没有返回文本', 'media_bad_response');
  return { text: data.text, ...(typeof data.language === 'string' ? { language: data.language } : {}), ...(Number.isFinite(data.duration) ? { duration: data.duration } : {}) };
}

/** Submit, poll and download one video. `onProgress({ status, progress })` reports polling. */
export async function generateVideo({ api: kind = 'openai', baseUrl, apiKey, model, prompt, image, seconds, size, fetchImpl, signal, onProgress = () => {}, pollMs = 5000, timeoutMs = 15 * 60 * 1000 }) {
  if (!VIDEO_APIS.includes(kind)) throw new MediaModelError('未知的视频接口', 'media_invalid_configuration');
  const native = kind === 'dashscope' ? `${new URL(baseUrl).origin}/api/v1` : baseUrl;
  const api = client({ baseUrl: native, apiKey, fetchImpl, signal });
  const deadline = Date.now() + timeoutMs;
  const submit = {
    openai: async () => {
      const form = new FormData(); form.set('model', model); form.set('prompt', prompt);
      if (seconds) form.set('seconds', String(seconds)); if (size) form.set('size', size);
      if (image) form.set('input_reference', blob(image), `reference.${extensionOf(image.mimeType ?? mimeOf(image.bytes))}`);
      return (await api.json('/videos', { form, label: '视频生成' })).id;
    },
    zhipu: async () => (await api.json('/videos/generations', { json: { model, prompt, ...(image ? { image_url: dataUrl(image) } : {}), ...(size ? { size } : {}), ...(seconds ? { duration: seconds } : {}) }, label: '视频生成' })).id,
    ark: async () => {
      const suffix = [size ? ` --resolution ${size}` : '', seconds ? ` --duration ${seconds}` : ''].join('');
      return (await api.json('/contents/generations/tasks', { json: { model, content: [{ type: 'text', text: `${prompt}${suffix}` }, ...(image ? [{ type: 'image_url', image_url: { url: dataUrl(image) } }] : [])] }, label: '视频生成' })).id;
    },
    siliconflow: async () => (await api.json('/video/submit', { json: { model, prompt, ...(image ? { image: dataUrl(image) } : {}), ...(size ? { image_size: size } : {}) }, label: '视频生成' })).requestId,
    dashscope: async () => (await api.json('/services/aigc/video-generation/video-synthesis', { json: { model, input: { prompt, ...(image ? { img_url: dataUrl(image) } : {}) }, parameters: { ...(size ? { size } : {}), ...(seconds ? { duration: seconds } : {}) } }, headers: { 'X-DashScope-Async': 'enable' }, label: '视频生成' })).output?.task_id
  }[kind];
  const id = await submit();
  if (typeof id !== 'string' || !id) throw new MediaModelError('视频接口没有返回任务编号', 'media_bad_response');
  onProgress({ status: 'submitted', taskId: id });
  // Each poll normalizes to { state: pending|done|failed, url?, progress?, message? }.
  const poll = {
    openai: async () => { const row = await api.json(`/videos/${encodeURIComponent(id)}`, { method: 'GET', label: '查询视频任务' }); return { state: row.status === 'completed' ? 'done' : row.status === 'failed' ? 'failed' : 'pending', progress: row.progress, message: row.error?.message }; },
    zhipu: async () => { const row = await api.json(`/async-result/${encodeURIComponent(id)}`, { method: 'GET', label: '查询视频任务' }); return { state: row.task_status === 'SUCCESS' ? 'done' : row.task_status === 'FAIL' ? 'failed' : 'pending', url: row.video_result?.[0]?.url }; },
    ark: async () => { const row = await api.json(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: 'GET', label: '查询视频任务' }); return { state: row.status === 'succeeded' ? 'done' : ['failed', 'cancelled', 'expired'].includes(row.status) ? 'failed' : 'pending', url: row.content?.video_url, message: row.error?.message }; },
    siliconflow: async () => { const row = await api.json('/video/status', { json: { requestId: id }, label: '查询视频任务' }); return { state: row.status === 'Succeed' ? 'done' : row.status === 'Failed' ? 'failed' : 'pending', url: row.results?.videos?.[0]?.url, message: row.reason }; },
    dashscope: async () => { const row = await api.json(`/tasks/${encodeURIComponent(id)}`, { method: 'GET', label: '查询视频任务' }); const status = row.output?.task_status; return { state: status === 'SUCCEEDED' ? 'done' : ['FAILED', 'CANCELED', 'UNKNOWN'].includes(status) ? 'failed' : 'pending', url: row.output?.video_url, message: row.output?.message }; }
  }[kind];
  for (;;) {
    await sleep(pollMs, signal);
    const row = await poll();
    if (row.state === 'failed') throw new MediaModelError(`视频生成失败${row.message ? `：${String(row.message).slice(0, 300)}` : ''}`, 'media_generation_failed', { taskId: id });
    if (row.state === 'done') {
      const result = kind === 'openai' ? await api.bytes(`/videos/${encodeURIComponent(id)}/content`, { method: 'GET', label: '下载视频' }) : typeof row.url === 'string' ? await api.download(row.url) : null;
      if (!result) throw new MediaModelError('视频任务完成但没有返回视频地址', 'media_bad_response', { taskId: id });
      return { ...result, mimeType: result.mimeType.startsWith('video/') ? result.mimeType : 'video/mp4', taskId: id };
    }
    onProgress({ status: 'running', taskId: id, ...(Number.isFinite(row.progress) ? { progress: row.progress } : {}) });
    if (Date.now() > deadline) throw new MediaModelError('视频生成超过等待时限；任务可能仍在供应商处运行', 'media_timeout', { taskId: id });
  }
}
