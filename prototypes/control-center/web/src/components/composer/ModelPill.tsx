/**
 * Model pill ("GLM-5.3") and a separate reasoning pill ("自动 · 本轮 中",
 * "最高"). The reasoning menu lists the selected model's options from its
 * `reasoningCapability`: 自动 (default), 供应商默认, each effort, and 关闭思考
 * when the model can disable thinking.
 */
import { useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { loadModelReasoning } from '@/api/client'
import type { ModelSelection, ReasoningDecision } from '@/api/types'
import { useApp } from '@/store/app-store'
import { capabilityOf, decisionSource, effortLabel, findModel, reasoningSummary } from '@/lib/models'
import { Menu, MenuCheckItem, MenuContent, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { Pill } from '@/components/ui/primitives'
import { t } from '@/i18n'

interface Props {
  selection: ModelSelection | null | undefined
  decision?: ReasoningDecision | null
  onChange: (next: ModelSelection) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function useCurrent(selection: ModelSelection | null | undefined) {
  const configuration = useApp(s => s.configuration)
  const current = selection ?? configuration?.defaultModel ?? null
  const model = findModel(configuration, current?.providerId, current?.modelId)
  const cap = capabilityOf(model)
  const reasoning = current?.reasoning ?? (cap.v2 ? 'auto' : cap.efforts[0]?.id)
  return { configuration, current, model, cap, reasoning }
}

export function ModelPill({ selection, onChange, open, onOpenChange }: Props) {
  const { configuration, current, model, cap, reasoning } = useCurrent(selection)
  const providers = (configuration?.providers ?? []).filter(p => p.protocol !== 'demo' && p.models.length)
  const pick = (providerId: string, modelId: string) => {
    const nextCap = capabilityOf(findModel(configuration, providerId, modelId))
    // Keep the reasoning choice when the new model supports it, else fall back.
    const keep = reasoning && (reasoning === 'auto' || reasoning === 'default' ? nextCap.v2 : reasoning === 'off' ? nextCap.canDisable : nextCap.efforts.some(e => e.id === reasoning))
    onChange({ providerId, modelId, reasoning: keep ? reasoning : nextCap.v2 ? 'auto' : nextCap.efforts[0]?.id ?? 'off' })
  }
  void cap
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <Pill trailing={<ChevronDown className="!size-3 text-fg-4" />} className="max-w-[180px]" aria-label={t('模型')}>
          {model?.name ?? t('选择模型')}
        </Pill>
      </MenuTrigger>
      <MenuContent side="top" align="end" className="max-h-[min(520px,70vh)] w-64 overflow-y-auto">
        {providers.map((provider, i) => (
          <div key={provider.id}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{provider.name}</MenuLabel>
            {provider.models.map(m => (
              <MenuCheckItem key={m.id} checked={current?.providerId === provider.id && current?.modelId === m.id} onSelect={() => pick(provider.id, m.id)}
                description={m.contextWindow ? t('{v}k 上下文', { v: Math.round(m.contextWindow / 1000) }) : undefined}>
                {m.name}
              </MenuCheckItem>
            ))}
          </div>
        ))}
        {!providers.length && <p className="px-2.5 py-2 text-[12.5px] text-fg-3">{t('尚未配置可用模型。')}</p>}
      </MenuContent>
    </Menu>
  )
}

export function ReasoningPill({ selection, decision, onChange, compact }: Props & { compact?: boolean }) {
  const { current, cap, reasoning } = useCurrent(selection)
  const [autoAvailable, setAutoAvailable] = useState<boolean | null>(null)
  if (cap.efforts.length === 0 && !cap.canDisable) return null
  const label = compact ? effortLabel(cap, reasoning) : reasoningSummary(cap, reasoning, reasoning === 'auto' ? decision : null)
  const set = (value: string) => current && onChange({ ...current, reasoning: value })
  const providerDefault = cap.providerDefault ? effortLabel(cap, cap.providerDefault) : null
  const onOpenChange = (open: boolean) => {
    if (!open || !current || !cap.v2) return
    void loadModelReasoning(current.providerId, current.modelId).then(info => setAutoAvailable(info ? info.auto.available : null))
  }
  const autoDescription = decision && reasoning === 'auto'
    ? t('本轮 {v} · {v2}', { v: decision.effective === 'off' ? t('不思考') : effortLabel(cap, decision.effective), v2: decisionSource(decision) })
    : autoAvailable === false ? t('判断模型暂不可用，将按供应商默认') : t('每轮根据任务自动选择档位')
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <Pill leading={<Brain />} trailing={<ChevronDown className="!size-3 text-fg-4" />} className="max-w-[170px]" aria-label={t('推理强度')}>
          {label}
        </Pill>
      </MenuTrigger>
      <MenuContent side="top" align="end" className="w-72">
        <MenuLabel>{t('推理强度')}</MenuLabel>
        {cap.v2 && <MenuCheckItem checked={reasoning === 'auto'} onSelect={() => set('auto')} description={autoDescription} trailing={<span className="text-[11px] text-fg-4">{t('默认')}</span>}>{t('自动')}</MenuCheckItem>}
        {cap.v2 && <MenuCheckItem checked={reasoning === 'default'} onSelect={() => set('default')} description={providerDefault ? t('由供应商决定（通常为{providerDefault}）', { providerDefault }) : t('不指定档位，由供应商决定')}>{t('供应商默认')}</MenuCheckItem>}
        {cap.efforts.map(e => <MenuCheckItem key={e.id} checked={reasoning === e.id} onSelect={() => set(e.id)}>{effortLabel(cap, e.id)}</MenuCheckItem>)}
        {cap.canDisable && <MenuCheckItem checked={reasoning === 'off'} onSelect={() => set('off')} description={t('更快，适合简单问答')}>{t('关闭思考')}</MenuCheckItem>}
        {cap.visibility === 'hidden' && <p className="px-2.5 pb-1.5 pt-1 text-[11.5px] leading-4 text-fg-4">{t('该模型不返回思考原文，界面只显示计时与 token 数。')}</p>}
      </MenuContent>
    </Menu>
  )
}
