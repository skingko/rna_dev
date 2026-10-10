/**
 * 多模态模型: which configured provider + model serves image generation/editing,
 * speech synthesis, transcription and video generation. The chosen kinds
 * become agent tools (image_generate, speech_generate, audio_transcribe,
 * video_generate) in every project; the provider's own base URL and key are used.
 * A ChatGPT login serves image generation and speech recognition through the
 * routes the Codex clients use it for (the server lists them per provider).
 */
import { useEffect, useState, type FormEvent } from 'react'
import { panelsApi } from '@/api/panels'
import type { FullConfiguration, MediaKind, MediaModelChoice, ProviderConfig } from '@/api/panels-types'
import { Field, FieldRow, Note, SaveBar, Select, SettingsSection, TextInput, useFormState, type Option } from '../form'
import { adoptConfiguration, reloadConfiguration, useConfiguration } from '../config-store'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, localized } from '@/i18n'

type Draft = Record<MediaKind, MediaModelChoice>
const KINDS: { kind: MediaKind; tool: string; placeholder: string }[] = [
  { kind: 'image', tool: 'image_generate', placeholder: 'gpt-image-1 / cogview-4 / doubao-seedream-4-0' },
  { kind: 'speech', tool: 'speech_generate', placeholder: 'gpt-4o-mini-tts / FunAudioLLM/CosyVoice2-0.5B' },
  { kind: 'transcription', tool: 'audio_transcribe', placeholder: 'whisper-1 / gpt-4o-transcribe / FunAudioLLM/SenseVoiceSmall' },
  { kind: 'video', tool: 'video_generate', placeholder: 'sora-2 / cogvideox-3 / doubao-seedance-1-0-pro' },
]
const kindLabel = (kind: MediaKind) => (kind === 'image' ? t('图片生成与编辑') : kind === 'speech' ? t('语音合成') : kind === 'transcription' ? t('语音识别') : t('视频生成'))
const VIDEO_APIS: Option[] = localized([
  { value: 'openai', label: 'OpenAI Videos（/videos）' },
  { value: 'zhipu', label: '智谱（/videos/generations）' },
  { value: 'ark', label: '火山方舟（contents/generations/tasks）' },
  { value: 'siliconflow', label: 'SiliconFlow（/video/submit）' },
  { value: 'dashscope', label: '阿里云百炼（video-synthesis）' },
])
const EDIT_APIS: Option[] = localized([
  { value: 'openai', label: 'OpenAI 编辑接口（/images/edits）' },
  { value: 'generations', label: '生成接口附带参考图（image 字段）' },
])
const host = (provider?: ProviderConfig) => { try { return new URL(provider?.baseUrl ?? '').hostname } catch { return '' } }
/** Starting choice for the provider's task API; the user can change it. */
const defaultVideoApi = (provider?: ProviderConfig) => {
  const name = host(provider)
  return name.endsWith('bigmodel.cn') ? 'zhipu' : name.endsWith('volces.com') ? 'ark' : name.includes('siliconflow') ? 'siliconflow' : name.includes('dashscope') ? 'dashscope' : 'openai'
}
const defaultEditApi = (provider?: ProviderConfig) => (host(provider) === 'api.openai.com' ? 'openai' : 'generations')
const empty = (): MediaModelChoice => ({ providerId: '', modelId: '' })
const draftOf = (media: Partial<Record<MediaKind, MediaModelChoice>> | undefined): Draft =>
  Object.fromEntries(KINDS.map(({ kind }) => [kind, { ...empty(), ...media?.[kind] }])) as Draft

const SEP = '\u0000'
const visionKey = (media: FullConfiguration['media']) => (media?.vision ? `${media.vision.providerId}${SEP}${media.vision.modelId}` : '')

export function MediaModelsSection({ registerBusy, registerDirty }: Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const config = useConfiguration(s => s.value)!
  const form = useFormState()
  const [draft, setDraft] = useState<Draft>(() => draftOf(config.media))
  const [vision, setVision] = useState(() => visionKey(config.media))
  // Models whose image input is confirmed (catalog, provider listing or an observed response).
  const visionOptions: Option[] = [{ value: '', label: t('自动选择'), description: t('优先主模型同一提供商中能看图的模型') }, ...config.providers.filter(p => p.protocol !== 'demo').flatMap(p => (p.models ?? [])
    .filter(m => m.inputCapability?.status === 'known' && m.inputCapability.input?.includes('image'))
    .map(m => ({ value: `${p.id}${SEP}${m.id}`, label: m.name || m.id, description: p.name, group: p.name })))]
  useRegistered(registerBusy, 'media-models', form.busy)
  useRegistered(registerDirty, 'media-models', form.dirty)
  useEffect(() => { if (!form.dirty) { setDraft(draftOf(config.media)); setVision(visionKey(config.media)) } }, [config.media]) // eslint-disable-line react-hooks/exhaustive-deps

  const keyed = config.providers.filter(p => p.protocol !== 'demo' && p.authMode !== 'subscription')
  const providersFor = (kind: MediaKind) => config.providers.filter(p => p.protocol !== 'demo' && (p.authMode !== 'subscription' || Boolean(p.subscriptionMedia?.[kind]?.length)))
  const providerOptions = (kind: MediaKind): Option[] => [{ value: '', label: t('不使用') }, ...providersFor(kind).map(p => ({ value: p.id, label: p.name || p.id, ...(p.authMode === 'subscription' ? { description: t('使用 ChatGPT 订阅额度') } : {}) }))]
  const subscriptionModels = (kind: MediaKind, provider?: ProviderConfig) => (provider?.authMode === 'subscription' ? provider.subscriptionMedia?.[kind] ?? [] : null)
  const set = (kind: MediaKind, patch: Partial<MediaModelChoice>) => { setDraft(d => ({ ...d, [kind]: { ...d[kind], ...patch } })); form.touch() }
  const onProvider = (kind: MediaKind, providerId: string) => {
    const provider = providersFor(kind).find(p => p.id === providerId), fixed = subscriptionModels(kind, provider)
    if (fixed) { set(kind, { providerId, modelId: fixed[0] ?? '', editApi: undefined, api: undefined, voice: undefined }); return }
    set(kind, providerId ? { providerId, ...(kind === 'video' ? { api: defaultVideoApi(provider) } : {}), ...(kind === 'image' ? { editApi: defaultEditApi(provider) } : {}) } : { providerId: '', modelId: '' })
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!e.currentTarget.reportValidity()) return
    const media = Object.fromEntries(KINDS.map(({ kind }) => {
      const row = draft[kind]
      if (!row.providerId || !row.modelId.trim()) return [kind, null]
      if (subscriptionModels(kind, config.providers.find(p => p.id === row.providerId))) return [kind, { providerId: row.providerId, modelId: row.modelId }]
      return [kind, { providerId: row.providerId, modelId: row.modelId.trim(), ...(kind === 'image' ? { editApi: row.editApi ?? 'openai' } : {}), ...(kind === 'video' ? { api: row.api ?? 'openai' } : {}), ...(kind === 'speech' && row.voice?.trim() ? { voice: row.voice.trim() } : {}) }]
    })) as Record<MediaKind, MediaModelChoice | null>
    const [visionProvider, visionModel] = vision.split(SEP)
    void form.submit(() => panelsApi.patchConfiguration({ media: { ...media, vision: vision ? { providerId: visionProvider, modelId: visionModel } : null } }), async value => { adoptConfiguration(value); await reloadConfiguration() }, t('多模态模型已保存'))
  }

  return (
    <SettingsSection title={t('多模态模型')} description={t('为图片、语音和视频选择模型后，所有项目的智能体都能生成与编辑图片、合成与识别语音、生成视频；本地的剪辑、转码、裁切由 ffmpeg / ImageMagick 完成。使用所选提供商的地址与密钥，按提供商计费。')}>
      <form onSubmit={onSubmit} className="space-y-4">
        {!keyed.length && <Note>{t('先添加一个使用 API Key 的提供商（如 OpenAI、智谱、阿里云百炼、火山方舟或 SiliconFlow），再在这里选择模型。')}</Note>}
        <fieldset className="space-y-3 rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]">
          <legend className="px-1 text-[12px] font-medium text-fg-3">{t('图片理解')} <span className="font-mono text-fg-4">image_analyze</span></legend>
          <Field label={t('模型')} help={t('主模型不能看图时，图片（上传、截图、读取的图片文件）会先交给这个模型理解，再把文字结果交回主模型继续。能否看图按模型的实际响应自动识别。')}>
            <Select aria-label={t('图片理解模型')} value={vision} onChange={v => { setVision(v); form.touch() }} options={visionOptions} />
          </Field>
        </fieldset>
        {KINDS.map(({ kind, tool, placeholder }) => {
          const row = draft[kind], provider = providersFor(kind).find(p => p.id === row.providerId), fixed = subscriptionModels(kind, provider)
          return (
            <fieldset key={kind} className="space-y-3 rounded-xl p-4 shadow-[inset_0_0_0_1px_var(--line)]">
              <legend className="px-1 text-[12px] font-medium text-fg-3">{kindLabel(kind)} <span className="font-mono text-fg-4">{tool}</span></legend>
              <FieldRow>
                <Field label={t('提供商')}><Select aria-label={t('{v} 提供商', { v: kindLabel(kind) })} value={row.providerId} onChange={v => onProvider(kind, v)} options={providerOptions(kind)} /></Field>
                {fixed ? <Field label={t('模型 ID')}><Select aria-label={t('{v} 模型', { v: kindLabel(kind) })} value={row.modelId} onChange={v => set(kind, { modelId: v })} options={fixed.map(id => ({ value: id, label: id === 'chatgpt-transcribe' ? t('ChatGPT 语音识别（由后台选择模型）') : id }))} /></Field> : <Field label={t('模型 ID')}>
                  <TextInput required={Boolean(row.providerId)} disabled={!row.providerId} list={`media-models-${kind}`} value={row.modelId} placeholder={placeholder} onChange={e => set(kind, { modelId: e.target.value })} />
                  <datalist id={`media-models-${kind}`}>{(provider?.models ?? []).map(m => <option key={m.id} value={m.id} />)}</datalist>
                </Field>}
              </FieldRow>
              {fixed && <Note>{t('使用 ChatGPT 订阅额度，经 Codex 客户端使用的 ChatGPT 接口调用；它不是公开 API，OpenAI 可能调整。')}</Note>}
              {row.providerId && !fixed && kind === 'image' && <Field label={t('编辑方式')} help={t('OpenAI 使用独立的编辑接口；SiliconFlow、火山方舟等在生成接口里接收参考图。')}><Select aria-label={t('编辑方式')} value={row.editApi ?? 'openai'} onChange={v => set(kind, { editApi: v as MediaModelChoice['editApi'] })} options={EDIT_APIS} /></Field>}
              {row.providerId && kind === 'speech' && <Field label={t('默认音色')} help={t('例如 alloy、coral；SiliconFlow 使用“模型:音色”。智能体可按需指定其他音色。')}><TextInput value={row.voice ?? ''} placeholder="alloy" onChange={e => set(kind, { voice: e.target.value })} /></Field>}
              {row.providerId && kind === 'video' && <Field label={t('视频任务接口')} help={t('视频生成没有通用接口，请选择该提供商对应的任务接口。')}><Select aria-label={t('视频任务接口')} value={row.api ?? 'openai'} onChange={v => set(kind, { api: v as MediaModelChoice['api'] })} options={VIDEO_APIS} /></Field>}
            </fieldset>
          )
        })}
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} />
      </form>
    </SettingsSection>
  )
}
