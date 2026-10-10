import { t } from '@/i18n'
/**
 * Background model route restriction (interactive-only subscriptions).
 * Ported from the legacy `public/background-model-display.js` (behavior unchanged). Inputs are raw
 * host records, so they are loosely typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
// Background work uses the project override, or the application default. A
// session's interactive model does not determine the autonomous model route.
export function backgroundModelRestriction(project: Rec, configuration: Rec | null | undefined): null | { code: string; title: string; message: string; source?: string; route?: string } {
  if (!project || (project.simulated !== false && project.decisionMode !== 'rna-model')) return null;
  const selection = project.initiative?.modelSelection ?? configuration?.defaultModel;
  const provider = configuration?.providers?.find((value: any) => value.id === selection?.providerId);
  if (provider?.usagePolicy !== 'interactive_only') return null;
  const model = provider.models?.find((value: any) => value.id === selection?.modelId);
  return {
    code: 'interactive_only', title: t('后台等待可用模型'),
    route: `${provider.name || provider.id} / ${model?.name || selection.modelId}`,
    source: project.initiative?.modelSelection ? t('项目后台模型') : t('应用默认模型'),
    message: t('当前套餐仅用于前台交互；主动协作和自进化需要开放平台 API 模型。'),
  };
}

