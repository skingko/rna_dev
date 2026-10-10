/**
 * H5 turn.route advice shown subtly in the turn footer: model-tier advice,
 * suggested skills, clarify / tools hints. Advice only — the host never
 * switches models or loads skills because of it.
 */
import { t } from '@/i18n'
import type { TurnRoute } from '@/api/types'
import { humanizeSkillId } from './skill-names'

export type TurnRouteRecord = TurnRoute

export function routeHints(route: TurnRouteRecord | null | undefined, decision?: { modelTier?: string } | null): string[] {
  const hints: string[] = []
  const tier = decision?.modelTier ?? route?.modelTier
  if (tier === 'fast') hints.push(t('建议：小型快速模型即可完成本轮'))
  else if (tier === 'main') hints.push(t('建议：本轮需要主模型'))
  if (route?.skills?.length) hints.push(t('建议技能：{list}', { list: route.skills.map(id => humanizeSkillId(id) || id).join(t('、')) }))
  if (route?.clarify) hints.push(t('提示：先向用户澄清'))
  if (route?.background?.stop) hints.push(t('提示：可停止后台工作'))
  else if (route?.background?.redirect) hints.push(t('提示：可调整后台方向'))
  return hints
}
