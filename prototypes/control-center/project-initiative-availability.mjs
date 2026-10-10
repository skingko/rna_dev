import { resolveModel } from './configuration.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

const blocked = (reason, title, message, details) => ({ eligible: false, state: 'blocked', reason, title, message, ...(details ? { details } : {}) });
const disabled = (reason, title) => ({ eligible: false, state: 'disabled', reason, title, message: title });
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const cleanupCodes = new Set(['SESSION_EVIDENCE_JOURNAL_UNKNOWN', 'SESSION_BACKGROUND_CLEANUP_PENDING', 'SESSION_CLEANUP_PENDING', 'SESSION_EVIDENCE_SCAN_LIMIT', 'SESSION_EVIDENCE_INVALID_PATH', 'SESSION_EVIDENCE_LINK_UNSAFE']);
// Title and message per reason, in the interface language (the web maps `reason` itself and uses these as the fallback).
const TEXT = {
  emergency: { zh: ['全局已急停'], en: ['Emergency stop is on'] },
  project_archived: { zh: ['项目已归档'], en: ['Project archived'] },
  initiative_disabled: { zh: ['主动协作已关闭'], en: ['Proactive collaboration is off'] },
  real_project_required: { zh: ['等待真实项目初始化', '项目尚未启用真实模型协作。'], en: ['Waiting for real project setup', 'This project does not use real-model collaboration yet.'] },
  initialization_pending: { zh: ['等待项目初始化', '项目能力初始化尚未完成，后台协作等待就绪。'], en: ['Waiting for project setup', 'Project capabilities are still being set up; background work waits until they are ready.'] },
  session_cleanup_pending: { zh: ['后台暂缓 · 会话清理待完成', '会话关联数据仍在清理，主动协作、定时交付与自动进化暂缓。清理完成后按原设置继续。'], en: ['Background paused · session cleanup pending', 'Data linked to a deleted conversation is still being cleaned up; proactive work, scheduled deliveries and self-evolution are paused and resume with your settings afterwards.'] },
  interactive_subscription_only: { zh: ['后台等待可用模型', '当前模型仅支持交互式使用，请为后台协作选择支持自动运行的模型。'], en: ['Background waiting for an available model', 'The current model is for interactive use only; choose a model that allows automatic runs for background work.'] },
  model_unavailable: { zh: ['后台等待可用模型', '项目后台模型配置不可用，请检查已选择的提供商、模型与推理档位。'], en: ['Background waiting for an available model', "The project's background model setup is unavailable; check the selected provider, model and reasoning level."] },
  real_model_required: { zh: ['后台等待真实模型', '后台协作需要已配置的真实模型。'], en: ['Background waiting for a real model', 'Background work needs a configured real model.'] },
  admitted: { zh: ['后台协作可运行', '实际执行仍遵循项目节奏、权限、预算与未决操作约束。'], en: ['Background work can run', 'It still follows the project rhythm, permissions, budget and any unsettled operations.'] },
};

/** Read-only explanation of existing host admission gates. It neither clears
 * deletion barriers nor changes user switches, cadence, permissions or state. */
export function projectInitiativeAvailability(state, project, { modelResolver = value => resolveModel(state.configuration, value.initiative?.modelSelection ?? null) } = {}) {
  const language = interfaceLanguageOf(state), text = reason => inLanguage(language, TEXT[reason]);
  const wait = (reason, details) => blocked(reason, ...text(reason), details), off = reason => disabled(reason, text(reason)[0]);
  if (state.emergency) return off('emergency');
  if (project.archivedAt) return off('project_archived');
  if (!project.initiative?.enabled) return off('initiative_disabled');
  if (project.decisionMode !== 'rna-model') return wait('real_project_required');
  if (project.initialization?.status !== 'ready') return wait('initialization_pending');
  const pending = (state.sessionDeletions ?? []).filter(row => row.projectId === project.id && row.localStatus !== 'completed');
  if (pending.length) {
    const retryAt = pending.map(row => instant(row.retryAt)).filter(Boolean).sort()[0] ?? null;
    const updatedAt = pending.map(row => instant(row.updatedAt)).filter(Boolean).sort().at(-1) ?? null;
    // A cleanup that waits for the user's decision (status blocked, review X-1) is named as such, whatever blocked it.
    const codes = [...new Set(pending.map(row => row.status === 'blocked' ? 'SESSION_CLEANUP_DECISION' : cleanupCodes.has(row.code) ? row.code : row.code ? 'SESSION_CLEANUP_PENDING' : null).filter(Boolean))];
    const attempts = pending.reduce((sum, row) => sum + (Number.isSafeInteger(row.attempts) && row.attempts > 0 ? row.attempts : 0), 0);
    return wait('session_cleanup_pending', { pendingCount: pending.length, attempts, updatedAt, retryAt, codes });
  }
  let model;
  try { model = modelResolver(project); }
  catch (error) {
    if (error?.code === 'interactive_subscription_only') return wait('interactive_subscription_only');
    return wait('model_unavailable');
  }
  if (model?.usagePolicy === 'interactive_only') return wait('interactive_subscription_only');
  if (model?.execution !== 'rna') return wait('real_model_required');
  const [title, message] = text('admitted');
  return { eligible: true, state: 'ready', reason: 'admitted', title, message };
}
