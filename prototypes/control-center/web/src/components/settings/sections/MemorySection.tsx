/**
 * 记忆: the memory backend (an OpenViking server, or the store built into this
 * app for a machine without Docker), the "记忆偏好" form (auto recall/store,
 * context budget, retrieval limit, OpenViking connection + credentials,
 * health check) and the entry to the project memory browser.
 */
import { useState, type FormEvent } from 'react'
import { Activity, BookOpen } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import { Button } from '@/components/ui/primitives'
import { ProjectPicker, useProjectDetail } from '@/components/projects/ProjectPicker'
import { memoryError, summaryStatusMessage } from '@/components/memory/memory-display'
import { ChoiceCards, Disclosure, Field, FieldRow, Group, Note, SaveBar, Select, SettingsSection, TextInput, ToggleRow, useFormState } from '../form'
import { adoptConfiguration, reloadConfiguration, useConfiguration } from '../config-store'
import { openMemory } from '../panel-store'
import type { CredentialMode } from '../model-catalog'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t, type MessageKey } from '@/i18n'

type MemoryBackend = 'openviking' | 'embedded'
/** The two ways to keep project memory. The embedded store needs nothing installed; OpenViking adds semantic search. */
export const MEMORY_BACKEND_OPTIONS: { value: MemoryBackend; label: MessageKey; hint: MessageKey }[] = [
  { value: 'openviking', label: 'OpenViking 语义记忆', hint: '需要用 Docker 部署 OpenViking 和向量模型。按语义检索，换一种说法也能找到；由模型提炼长期记忆。' },
  { value: 'embedded', label: '本地记忆（内置）', hint: '无需 Docker 或任何外部服务，数据只保存在本机。按关键词检索对话记录与交付资料，不调用模型。' },
]

export default function MemorySection({ projectId, setProjectId, registerBusy, registerDirty, requestClose }: SectionProps) {
  const project = useProjectDetail(projectId)
  const summary = summaryStatusMessage(project?.memorySummary)
  return (
    <>
      <SettingsSection
        title={t('浏览项目记忆')}
        description={t('搜索、浏览与阅读当前项目保存的资料和长期记忆。')}
        action={<ProjectPicker value={projectId} onChange={setProjectId} />}
      >
        {summary && <Note className="mb-3">{summary}</Note>}
        <Button variant="secondary" leading={<BookOpen className="size-4" />} disabled={!projectId} onClick={() => { if (requestClose()) openMemory(projectId) }}>
          {t('打开项目记忆{v}', { v: project ? ` · ${project.name}` : '' })}
        </Button>
      </SettingsSection>
      <MemoryPreferences projectId={projectId} registerBusy={registerBusy} registerDirty={registerDirty} />
    </>
  )
}

function MemoryPreferences({ projectId, registerBusy, registerDirty }: { projectId: string | null } & Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const memory = useConfiguration(s => s.value?.memory) ?? {}
  const form = useFormState()
  const [autoRecall, setAutoRecall] = useState(memory.autoRecall !== false)
  const [autoStore, setAutoStore] = useState(memory.autoStore !== false)
  const [budget, setBudget] = useState(String(memory.contextBudget ?? 2048))
  const [limit, setLimit] = useState(String(memory.limit ?? 10))
  const [backend, setBackend] = useState<MemoryBackend>(memory.backend === 'embedded' ? 'embedded' : 'openviking')
  const saved: MemoryBackend = memory.backend === 'embedded' ? 'embedded' : 'openviking', embedded = backend === 'embedded'
  const [endpoint, setEndpoint] = useState(memory.endpoint ?? 'http://127.0.0.1:1933')
  const [credential, setCredential] = useState<CredentialMode>(memory.apiKeyEnv ? 'env' : 'key')
  const [key, setKey] = useState('')
  const [env, setEnv] = useState(memory.apiKeyEnv ?? '')
  const [health, setHealth] = useState<{ text: string; tone: 'default' | 'success' | 'danger' } | null>(null)
  const [testing, setTesting] = useState(false)
  useRegistered(registerBusy, 'memory-preferences', form.busy)
  useRegistered(registerDirty, 'memory-preferences', form.dirty)

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!e.currentTarget.reportValidity()) return
    const values: Record<string, unknown> = { backend, autoRecall, autoStore, contextBudget: Number(budget), limit: Number(limit) }
    // The embedded store has no address or key; the OpenViking ones stay saved for switching back.
    if (embedded) { void form.submit(() => panelsApi.patchConfiguration({ memory: values }), async value => { adoptConfiguration(value); await reloadConfiguration() }); return }
    values.endpoint = endpoint.trim()
    // Env mode with no variable name leaves the credential as it is: only 无需凭据 clears a saved key.
    if (credential === 'env') { if (env.trim()) { values.apiKeyEnv = env.trim(); values.apiKey = '' } }
    else { values.apiKeyEnv = ''; if (credential === 'none') values.apiKey = ''; else if (key) values.apiKey = key }
    void form.submit(() => panelsApi.patchConfiguration({ memory: values }), async value => { setKey(''); adoptConfiguration(value); await reloadConfiguration() })
  }
  const test = async () => {
    if (!projectId) { setHealth({ text: t('先选择一个项目，再测试连接。'), tone: 'default' }); return }
    setTesting(true); setHealth({ text: t('正在检查连接…'), tone: 'default' })
    try { await panelsApi.memoryHealth(projectId); setHealth({ text: t('连接正常'), tone: 'success' }) } catch (error) { setHealth({ text: memoryError(error), tone: 'danger' }) } finally { setTesting(false) }
  }
  const touch = form.touch
  return (
    <SettingsSection title={t('记忆偏好')} description={t('项目记忆自动连接；以下偏好用于所有项目，记忆内容按项目隔离。')}>
      <form onSubmit={onSubmit} onChange={touch}>
        <ChoiceCards name="memory-backend" aria-label={t('记忆方式')} className="mb-4" value={backend} saved={saved} options={MEMORY_BACKEND_OPTIONS.map(option => ({ value: option.value, label: t(option.label), hint: t(option.hint) }))} onChange={value => { setBackend(value); setHealth(null); touch() }} />
        {backend !== saved && <Note className="mb-4">{t('保存后，新的记忆写入所选的方式。两种方式各自保存自己的记忆，互不迁移；切回原来的方式后，原有记忆仍在。还没写完的记忆不会转到新的方式。')}</Note>}
        <Group>
          <ToggleRow label={t('自动关联项目记忆')} description={t('根据当前讨论查找相关记忆，先提供摘要；AI 需要更多依据时再读取目录概览或原文。')} checked={autoRecall} onChange={v => { setAutoRecall(v); touch() }} />
          <ToggleRow label={t('自动保存项目记忆')} description={embedded ? t('完成真实对话后，把对话内容保存到本机，供之后按关键词关联；不调用模型。删除对话时，它保存的内容一并删除。') : t('完成真实对话后归档并提取项目事实；服务会使用已配置的记忆模型。关闭后停止新上传，已提交任务仍可查询结果。')} checked={autoStore} onChange={v => { setAutoStore(v); touch() }} />
        </Group>
        <div className="mt-4 rounded-xl bg-accent-softer px-4 py-3">
          <strong className="text-[12.5px] font-semibold text-fg-2">{t('按需理解，逐步展开')}</strong>
          <p className="mt-1 text-[12.5px] leading-[1.65] text-fg-3">{t('摘要用于发现线索，概览帮助理解范围，原文提供具体依据。三者协同使用，根据相关性和上下文预算取舍，不会把全部记忆一次放入对话。')}</p>
        </div>
        <FieldRow className="mt-4">
          <Field label={t('自动关联预算（估算 token）')} help={autoRecall ? t('每轮自动关联的记忆上下文上限。按需读取的内容受会话工具输出上限约束。') : t('已关闭自动关联，仍可手动浏览和搜索项目记忆。')}>
            <TextInput type="number" min={256} max={16000} step={1} required disabled={!autoRecall} value={budget} onChange={e => setBudget(e.target.value)} />
          </Field>
        </FieldRow>
        <Disclosure summary={t('检索选项')} className="mt-3">
          <Field label={t('每次检索最多返回的候选数')} help={t('限制候选数量，不决定读取层级。自动关联仍受上下文预算约束。')}>
            <TextInput type="number" min={1} max={100} step={1} required value={limit} onChange={e => setLimit(e.target.value)} className="max-w-48" />
          </Field>
        </Disclosure>
        {embedded && (
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" variant="secondary" disabled={testing || backend !== saved} leading={<Activity className="size-3.5" />} onClick={() => void test()}>{t('检查本地记忆')}</Button>
            {health ? <span role="status" className={health.tone === 'danger' ? 'text-[12px] text-danger' : health.tone === 'success' ? 'text-[12px] text-success' : 'text-[12px] text-fg-3'}>{health.text}</span> : backend !== saved && <span className="text-[12px] text-fg-4">{t('保存后可检查')}</span>}
          </div>
        )}
        {!embedded && <Disclosure summary={t('高级连接设置')}>
          <p className="mb-3 text-[12px] text-fg-4">{t('通常无需修改。连接更改在所有项目生效，各项目内容仍保持独立。')}</p>
          <div className="space-y-3">
            <Field label={t('服务地址')}><TextInput type="url" required value={endpoint} onChange={e => setEndpoint(e.target.value)} /></Field>
            <FieldRow>
              <Field label={t('凭据来源')}><Select<CredentialMode> aria-label={t('凭据来源')} value={credential} onChange={v => { setCredential(v); touch() }} options={[{ value: 'key', label: t('访问密钥') }, { value: 'env', label: t('环境变量') }, { value: 'none', label: t('无需凭据') }]} /></Field>
              {credential === 'key' && <Field label={t('访问密钥')}><TextInput type="password" autoComplete="new-password" value={key} placeholder={memory.apiKeyConfigured ? t('已保存；留空保持不变') : t('访问密钥（可选）')} onChange={e => setKey(e.target.value)} /></Field>}
              {credential === 'env' && <Field label={t('环境变量名')}><TextInput required pattern="[A-Za-z_][A-Za-z0-9_]*" title={t('字母或下划线开头，只含字母、数字和下划线')} value={env} placeholder={t('环境变量名称')} onChange={e => setEnv(e.target.value)} /></Field>}
            </FieldRow>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="secondary" disabled={testing} leading={<Activity className="size-3.5" />} onClick={() => void test()}>{t('测试已保存的连接')}</Button>
              {health && <span role="status" className={health.tone === 'danger' ? 'text-[12px] text-danger' : health.tone === 'success' ? 'text-[12px] text-success' : 'text-[12px] text-fg-3'}>{health.text}</span>}
            </div>
          </div>
        </Disclosure>}
        <SaveBar status={form.status} busy={form.busy} dirty={form.dirty} submitLabel={t('保存偏好')} />
      </form>
    </SettingsSection>
  )
}
