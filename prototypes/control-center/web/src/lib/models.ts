/**
 * Model + reasoning presentation. Uses the v2 `reasoningCapability` when the
 * backend provides it and derives an equivalent from the legacy
 * `reasoning: string[]` list otherwise (in which case auto/default are not
 * offered, since an old backend would reject them).
 */
import type { Configuration, ProviderModel, ReasoningCapability, ReasoningDecision } from '@/api/types'
import { currentLocale, localized, t } from '@/i18n'

const LEGACY_LABELS: Record<string, string> = localized({ minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' })

export interface ResolvedCapability extends ReasoningCapability { v2: boolean }

export function findModel(config: Configuration | null | undefined, providerId?: string, modelId?: string): ProviderModel | undefined {
  return config?.providers.find(p => p.id === providerId)?.models.find(m => m.id === modelId)
}

export function capabilityOf(model: ProviderModel | undefined): ResolvedCapability {
  if (model?.reasoningCapability) return { ...model.reasoningCapability, v2: true }
  const levels = model?.reasoning ?? []
  return {
    v2: false,
    control: levels.filter(l => l !== 'off').length ? 'effort' : 'none',
    efforts: levels.filter(l => l !== 'off').map(id => ({ id, label: LEGACY_LABELS[id] ?? id })),
    canDisable: levels.includes('off'),
    providerDefault: null,
  }
}

export function effortLabel(cap: ResolvedCapability, id?: string | null): string {
  if (!id) return ''
  if (id === 'auto') return t('自动')
  if (id === 'default') return t('供应商默认')
  if (id === 'off') return t('关闭思考')
  const label = cap.efforts.find(e => e.id === id)?.label
  // Provider catalogs may label standard levels in Chinese; English uses our own words for those.
  if (label && !(currentLocale() === 'en' && /[一-鿿]/.test(label) && LEGACY_LABELS[id])) return label
  return LEGACY_LABELS[id] ?? label ?? id
}

/** "自动 · 本轮 中" when the turn's decision is known. */
export function reasoningSummary(cap: ResolvedCapability, selection: string | undefined, decision?: ReasoningDecision | null): string {
  const base = effortLabel(cap, selection ?? (cap.v2 ? 'auto' : cap.efforts[0]?.id))
  if (decision && (selection === 'auto' || decision.requested === 'auto')) {
    if (decision.effective === 'off') return t('自动 · 本轮不思考')
    const effective = decision.effective === 'default' ? t('默认') : effortLabel(cap, decision.effective)
    return t('自动 · 本轮 {effective}', { effective })
  }
  return base
}

export function decisionSource(decision?: ReasoningDecision | null): string {
  if (!decision) return ''
  return ({ jev: t('判断模型选择'), rule: t('规则快速选择'), user: t('手动指定'), 'provider-default': t('供应商默认') } as Record<string, string>)[decision.source] ?? ''
}
