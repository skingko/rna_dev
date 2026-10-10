import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalizeMissingPath } from '../../packages/sdk/src/workspace-paths.mjs';
import { workspacePrivateSegment } from '../../packages/sdk/src/workspace-tools.mjs';
import { generateImage, synthesizeSpeech, transcribeAudio, generateVideo, extensionOf, MediaModelError, MAX_MEDIA_BYTES, SUBSCRIPTION_MEDIA, SUBSCRIPTION_IMAGE_REFERENCES, generateSubscriptionImage, transcribeSubscriptionAudio } from '../../packages/sdk/src/media-models.mjs';
import { normalizeImage } from '../../packages/sdk/src/images.mjs';

const problem = (message, code) => ({ isError: true, content: [{ type: 'text', text: message }], details: { code, executed: false } });
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.aac': 'audio/aac', '.opus': 'audio/opus' };
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Tool names per configured media kind (see Configuration `media`). */
export const MEDIA_TOOL_KINDS = Object.freeze({ image_generate: 'image', speech_generate: 'speech', audio_transcribe: 'transcription', video_generate: 'video' });

const DECLARATIONS = {
  image_generate: { label: '生成或编辑图片', permission: 'write', effect: 'write', idempotent: false,
    description: 'Generate images with the image model configured in settings, or edit/restyle existing project images by passing them as sourceImages. Files are saved into the project (default media/) and never overwrite existing files. The first result is attached so you can check it. Write a concrete prompt: subject, composition, style, text to render, aspect.',
    parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 8000 },
      sourceImages: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 1000 }, description: 'Project-relative PNG/JPEG/WebP files to edit or use as references.' },
      size: { type: 'string', maxLength: 32, description: 'Provider size such as 1024x1024, 1536x1024, or a provider keyword. Omit for the model default.' },
      count: { type: 'integer', minimum: 1, maximum: 4 },
      path: { type: 'string', maxLength: 1000, description: 'Project-relative output file (extension follows the returned format). For count>1 a -2, -3 suffix is added. Default media/image-<time>.' } } } },
  speech_generate: { label: '合成语音', permission: 'write', effect: 'write', idempotent: false,
    description: 'Turn text into speech with the speech model configured in settings and save the audio into the project (default media/). Never overwrites existing files.',
    parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 4096 },
      voice: { type: 'string', maxLength: 200, description: 'Provider voice id; omit to use the configured default.' },
      instructions: { type: 'string', maxLength: 2000, description: 'Speaking style guidance, for models that accept it.' },
      format: { type: 'string', enum: ['mp3', 'wav', 'opus', 'aac', 'flac'] },
      path: { type: 'string', maxLength: 1000 } } } },
  audio_transcribe: { label: '识别音频文字', permission: 'read', effect: 'read', idempotent: true,
    description: 'Transcribe a project audio (or audio track of a small video) file to text with the transcription model configured in settings. For long or unsupported files, first cut or convert them with ffmpeg via project_exec.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1000 },
      language: { type: 'string', maxLength: 16, description: 'ISO-639-1 hint such as zh or en.' },
      prompt: { type: 'string', maxLength: 1000, description: 'Vocabulary or context hint.' } } } },
  video_generate: { label: '生成视频', permission: 'write', effect: 'write', idempotent: false,
    description: 'Generate a short video with the video model configured in settings (text-to-video, or image-to-video with image). Runs as a provider task and can take minutes; the file is saved into the project (default media/). Do not resubmit an uncertain call — it bills again.',
    parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
      image: { type: 'string', maxLength: 1000, description: 'Optional project-relative first-frame/reference image.' },
      seconds: { type: 'integer', minimum: 1, maximum: 60 },
      size: { type: 'string', maxLength: 32, description: 'Provider resolution such as 1280x720 or 720p.' },
      path: { type: 'string', maxLength: 1000 } } } }
};

/** Media generation/processing tools over the media models chosen in
 * settings. Provider, model and credential are resolved at execution, never
 * embedded in the model-visible descriptor. */
export class MediaToolsService {
  constructor(store, { fetchImpl, pollMs, timeoutMs } = {}) { Object.assign(this, { store, fetchImpl, pollMs, timeoutMs }); this.controllers = new Set(); this.closed = false; }
  media() { return this.store.state.configuration?.media ?? {}; }
  /** { provider, model, settings } for a configured kind, or null. */
  binding(kind) {
    const settings = this.media()[kind]; if (!settings?.providerId || !settings.modelId) return null;
    const provider = this.store.state.configuration.providers.find(row => row.id === settings.providerId);
    if (!provider || provider.protocol === 'demo' || !provider.baseUrl) return null;
    // A ChatGPT login serves only the kinds the Codex clients use it for.
    if (provider.authMode === 'subscription' && !(provider.protocol === 'openai-codex' && SUBSCRIPTION_MEDIA[kind]?.includes(settings.modelId))) return null;
    return { provider, settings, subscription: provider.authMode === 'subscription' };
  }
  kinds() { return this.closed ? [] : Object.values(MEDIA_TOOL_KINDS).filter(kind => this.binding(kind)); }
  revision() { return `media-tools-v1:${this.kinds().join(',')}`; }
  declarations() { const kinds = new Set(this.kinds()); return Object.entries(DECLARATIONS).filter(([name]) => kinds.has(MEDIA_TOOL_KINDS[name])).map(([name, declaration]) => ({ name, ...declaration })); }
  /** `root`: the folder the turn's tools work in (a worktree, design 0.63 §9); absent → the project folder. Inputs are
   * read and outputs saved there, so a worktree conversation's media lands in its own copy and is applied with it. */
  createTools(project, { root = null } = {}) {
    if (!project?.workspace) return [];
    return this.declarations().map(declaration => ({ ...declaration, execute: (id, args, signal, onUpdate) => this.execute(declaration.name, project, args, signal, onUpdate, { root }) }));
  }
  async execute(name, project, args, signal, onUpdate, { root: folder = null } = {}) {
    signal?.throwIfAborted();
    if (this.closed) return problem('媒体服务正在关闭；本次请求未执行。', 'MEDIA_CLOSED');
    const kind = MEDIA_TOOL_KINDS[name], bound = this.binding(kind);
    if (!bound) return problem('设置中尚未配置该类媒体模型；请在 设置 → 模型 → 多模态模型 中选择。', 'MEDIA_NOT_CONFIGURED');
    const apiKey = this.store.configurationService.secret(bound.provider.id, bound.provider);
    const controller = new AbortController(); this.controllers.add(controller);
    const combined = AbortSignal.any([controller.signal, signal].filter(Boolean));
    const endpoint = { baseUrl: bound.provider.baseUrl, apiKey, model: bound.settings.modelId, fetchImpl: this.fetchImpl, signal: combined };
    try {
      const root = await realpath(folder ?? project.workspace);
      // A bad output path must fail before the (billed) model call.
      if (args.path !== undefined) await this.resolve(root, args.path);
      if (name === 'image_generate') {
        if (bound.subscription && (args.sourceImages?.length ?? 0) > SUBSCRIPTION_IMAGE_REFERENCES) return problem(`ChatGPT 订阅的图片编辑最多使用 ${SUBSCRIPTION_IMAGE_REFERENCES} 张参考图。`, 'MEDIA_TOO_MANY_IMAGES');
        const images = await Promise.all((args.sourceImages ?? []).map(path => this.readInput(root, path, IMAGE_TYPES, 50 * 1024 * 1024)));
        const results = bound.subscription ? await this.subscriptionImages(endpoint, args, images) : await generateImage({ ...endpoint, prompt: args.prompt, size: args.size, count: args.count ?? 1, images, editApi: bound.settings.editApi ?? 'openai' });
        const saved = [];
        for (const [index, result] of results.entries()) saved.push(await this.save(root, args.path, 'image', result, index));
        const preview = results[0].bytes.length <= 8 * 1024 * 1024 ? (() => { try { return normalizeImage({ type: 'image', mimeType: results[0].mimeType, data: results[0].bytes.toString('base64') }); } catch { return null; } })() : null;
        return { content: [{ type: 'text', text: `${images.length ? 'Edited' : 'Generated'} ${saved.length} image${saved.length === 1 ? '' : 's'}: ${saved.map(row => row.path).join(', ')} (${bound.settings.modelId})${results[0].revisedPrompt ? `\nRevised prompt: ${results[0].revisedPrompt}` : ''}${results.incomplete ? `\nThe other ${(args.count ?? 1) - results.length} not generated: ${results.incomplete}` : ''}` }, ...(preview ? [preview] : [])], details: { kind, model: bound.settings.modelId, providerId: bound.provider.id, files: saved } };
      }
      if (name === 'speech_generate') {
        const result = await synthesizeSpeech({ ...endpoint, input: args.text, voice: args.voice ?? bound.settings.voice, instructions: args.instructions, format: args.format ?? 'mp3' });
        const file = await this.save(root, args.path, 'speech', result);
        return { content: [{ type: 'text', text: `Synthesized speech: ${file.path} (${file.bytes} bytes, ${bound.settings.modelId})` }], details: { kind, model: bound.settings.modelId, providerId: bound.provider.id, files: [file] } };
      }
      if (name === 'audio_transcribe') {
        const audio = await this.readInput(root, args.path, AUDIO_TYPES, 25 * 1024 * 1024);
        const result = bound.subscription
          ? await transcribeSubscriptionAudio({ credential: apiKey, audio, filename: basename(args.path), language: args.language, fetchImpl: this.fetchImpl, signal: combined })
          : await transcribeAudio({ ...endpoint, audio, filename: basename(args.path), language: args.language, prompt: args.prompt });
        return { content: [{ type: 'text', text: result.text }], details: { kind, model: bound.settings.modelId, providerId: bound.provider.id, path: args.path, ...(result.language ? { language: result.language } : {}), ...(result.duration ? { duration: result.duration } : {}) } };
      }
      const image = args.image ? await this.readInput(root, args.image, IMAGE_TYPES, 20 * 1024 * 1024) : undefined;
      const result = await generateVideo({ ...endpoint, api: bound.settings.api ?? 'openai', prompt: args.prompt, image, seconds: args.seconds, size: args.size, ...(this.pollMs ? { pollMs: this.pollMs } : {}), ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
        onProgress: event => { try { onUpdate?.({ content: [{ type: 'text', text: event.status === 'submitted' ? 'Video task submitted, waiting for generation…' : `Generating video${Number.isFinite(event.progress) ? ` ${event.progress}%` : '…'}` }], details: { taskId: event.taskId } }); } catch {} } });
      const file = await this.save(root, args.path, 'video', result);
      return { content: [{ type: 'text', text: `Generated video: ${file.path} (${file.bytes} bytes, ${bound.settings.modelId})` }], details: { kind, model: bound.settings.modelId, providerId: bound.provider.id, taskId: result.taskId, files: [file] } };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof MediaModelError) return { isError: true, content: [{ type: 'text', text: error.message }], details: { code: error.code, ...error.details, executed: !['media_invalid_configuration'].includes(error.code) } };
      if (error?.code === 'MEDIA_PATH') return problem(error.message, 'MEDIA_PATH');
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  /** The subscription route returns one image per call; images made before a later call fails are still kept. */
  async subscriptionImages(endpoint, args, images) {
    const results = [];
    for (let index = 0; index < (args.count ?? 1); index++) {
      try { results.push(await generateSubscriptionImage({ credential: endpoint.apiKey, model: endpoint.model, prompt: args.prompt, size: args.size, images, fetchImpl: endpoint.fetchImpl, signal: endpoint.signal })); }
      catch (error) { if (!results.length || endpoint.signal.aborted) throw error; results.incomplete = error.message; break; }
    }
    return results;
  }
  async resolve(root, input) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0') || isAbsolute(input)) throw Object.assign(new Error('需要项目内的相对路径。'), { code: 'MEDIA_PATH' });
    const path = await canonicalizeMissingPath(resolve(root, input));
    if (!within(root, path) || relative(root, path).split(sep).some(workspacePrivateSegment)) throw Object.assign(new Error('路径超出项目范围或属于私有文件。'), { code: 'MEDIA_PATH' });
    return path;
  }
  async readInput(root, input, types, limit) {
    const path = await this.resolve(root, input), mimeType = types[extname(path).toLowerCase()];
    if (!mimeType) throw Object.assign(new Error(`不支持的文件类型：${input}`), { code: 'MEDIA_PATH' });
    const file = await open(path, 'r').catch(() => { throw Object.assign(new Error(`无法读取：${input}`), { code: 'MEDIA_PATH' }); });
    try { const info = await file.stat(); if (!info.isFile() || info.size > limit) throw Object.assign(new Error(`文件必须是普通文件且不超过 ${Math.round(limit / 1024 / 1024)} MB：${input}`), { code: 'MEDIA_PATH' }); return { bytes: await file.readFile(), mimeType }; }
    finally { await file.close(); }
  }
  /** Exclusive create: an existing file (or symlink) is never replaced. */
  async save(root, requested, prefix, result, index = 0) {
    if (result.bytes.length > MAX_MEDIA_BYTES) throw new MediaModelError('生成结果超过 200 MB 上限', 'media_too_large');
    const ext = extensionOf(result.mimeType);
    let base = requested ? requested.replace(/\.[a-z0-9]{1,5}$/i, '') : `media/${prefix}-${stamp()}`;
    if (index) base = `${base}-${index + 1}`;
    const target = await this.resolve(root, `${base}.${ext}`);
    await mkdir(dirname(target), { recursive: true });
    if (!within(root, await realpath(dirname(target)))) throw Object.assign(new Error('路径超出项目范围。'), { code: 'MEDIA_PATH' });
    const file = await open(target, 'wx').catch(error => { throw Object.assign(new Error(error.code === 'EEXIST' ? `文件已存在，未覆盖：${relative(root, target)}` : `无法写入：${relative(root, target)}`), { code: 'MEDIA_PATH' }); });
    try { await file.writeFile(result.bytes); } finally { await file.close(); }
    return { path: relative(root, target).split(sep).join('/'), mimeType: result.mimeType, bytes: (await stat(target)).size };
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
