/**
 * What happened to background work that stopped, in plain words (plan §2.4:
 * no error codes on screen; say what happened). What to do next is the
 * 接着做 / 不用了 choice in the conversation, so it is not repeated here.
 * Display only: the codes stay in the collapsed diagnostics.
 */
import type { ToolCall } from '@/api/types'
import { currentLocale, formatDate, localized, t } from '@/i18n'
import { PACING_REASONS } from './mind'
import { toolKind, type ViewKind } from './tools'

export function failureSentence(code: string | null | undefined, status?: string): string {
  const c = String(code ?? '').toLowerCase()
  // GN-1: resumed after the user rolled back (or ended the trial of) the version it started on.
  if (/version_withdrawn/.test(c)) return t('开始时用的项目版本已被回退或退出试用，这项后台工作没有接着做；已做完的部分都保留着。')
  if (/foreground_started|superseded/.test(c)) return t('你开始在对话里工作，后台先让出来了；已做完的部分都保留着。')
  // The host's deadline for one background run (the work was too big for one go), not the model service.
  if (/action_timeout/.test(c)) return t('这次工作超过了单次后台时限，没做完；已做完的部分都保留着。')
  if (/idle_timeout|timeout|connection|network|econn|fetch|provider|rate_limit|overload|http_5/.test(c)) return t('模型服务这次没有及时响应，工作没做完。')
  if (/empty_result/.test(c)) return t('这次没有产出结果。')
  if (/uncertain_tool|cleanup_uncertain/.test(c)) return t('有一步操作没法确认是否完成，其余结果都保留着。')
  if (/budget|quota/.test(c)) return t('额度不够，这次没有做。')
  if (/permission|authorization|read_only/.test(c)) return t('当时的权限不够，这次没有做。')
  if (status === 'cancelled') return t('这项后台工作已停止；已做完的部分都保留着。')
  return t('这次没做完。')
}

/** A handoff marker the model or an older host put in front of the line (`HANDOFF:` is what the worker prompt asks for, `交接：` what older runs wrote). */
export const stripHandoffMarker = (text: string) => text.replace(/^(?:交接|HANDOFF)[:：]\s*/i, '')

/**
 * Handoff lines the host writes for the model about a stop or failure; not for the user. New rows are fixed English
 * (work-run-text.mjs HOST_HANDOFF); rows written before carry the Chinese form.
 */
export const hostFailureHandoff = (text: string | null | undefined) => /^(未完成（|已中断：|结果待核对（|已停止：|已暂停：|Unfinished \(|Interrupted: |Result to verify \(|Stopped: |Paused: )/.test(stripHandoffMarker(String(text ?? '')))

// deferredReason / cancellationReason codes the SDK and host write (initiative.mjs, project-initiative-controller.mjs).
const REASONS: Record<string, string> = localized({
  narrator_user_focused: '你正在专注，等自然停顿再说', narrator_hold: '并入话题，稍后一起说', narrator_held: '问题已暂存，等你回来再问', active_turn: '当前回复进行中，等待接话', pending_question: '已有待回答的问题，暂缓再次提问',
  user_typing: '正在输入，暂缓接话', notification_muted: '主动发言已暂停', quiet_until: '处于安静时段', cooldown: '等待沟通间隔', no_conversation: '暂无可投递会话',
  foreground_busy: '你正在对话里工作，等这一轮结束', learning_interval: '离上次学习太近，到时间再做', learning_paused: '自主学习已暂停', budget_exhausted: '额度用完了，先不做',
  unresolved_execution: '有一项执行结果还没核对，先等核对',
  new_project_evidence: '新项目证据到达，原消息已取消', new_evidence: '新证据到达，原消息已取消', context_changed: '项目上下文已变化', action_control: '已按指令停止这项工作',
  message_contract: '消息没通过发送前的检查', message_duplicate: '和最近发过的消息重复', host_context_changed: '项目情况已变化', version_withdrawn: '开始时用的项目版本已被回退或退出试用，没有接着做',
  project_scope_changed: '项目范围变了（新建会话、换模型等），没有继续', learning_requires_new_evidence: '没有新的工作记录可学', learning_lane_migrated: '学习改由独立流程负责',
  schedule_changed: '日程已修改', schedule_contract_unavailable: '日程当时无法执行', paused: '主动协作已暂停', controller_closed: '应用关闭或重启了', project_unavailable_or_changed: '项目已不可用或已变化',
})

/**
 * Why background work waited (`deferred`) or was called off (`cancelled`), in plain words. The narrator's
 * pacing codes (narrator_away …) read as the pacing reasons the inbox shows; a code nobody mapped yet reads
 * as a general line, never as the code itself.
 */
export function actionReason(code: string | null | undefined, kind: 'deferred' | 'cancelled'): string {
  const c = String(code ?? '')
  if (!c) return ''
  if (Object.hasOwn(REASONS, c)) return REASONS[c]
  const pacing = c.replace(/^narrator_/, '')
  if (Object.hasOwn(PACING_REASONS, pacing)) return PACING_REASONS[pacing]
  return kind === 'deferred' ? t('暂缓，等合适的时机再做') : t('情况有变，这次取消了')
}

// One tool step, named for the user (the review diagnosis); never the tool's internal name.
const STEP_NAMES: Partial<Record<ViewKind, string>> = localized({ read: '读取文件', list: '查看目录', write: '写入文件', edit: '编辑文件', search: '搜索', command: '运行命令', web_search: '搜索网页', web_fetch: '访问网页', skill: '加载技能', mcp: '调用外部工具', browser: '操作浏览器', preview: '处理预览', agent: '咨询协作代理', memory: '读取记忆' })
/** A host tool receipt kept on a background job. */
export type JobReceipt = { toolName?: string; status?: string; at?: string }

/**
 * Why a run waits for review, in plain words (F15): what went wrong and which step could not be confirmed. The
 * host's own reason is an instruction to the model (English, “do not replay…”) and stays out; codes stay folded.
 */
export function reviewDiagnosis(code: string | null | undefined, receipts: JobReceipt[] = []): string[] {
  const step = receipts.findLast(r => r.status === 'uncertain')
  const name = step?.toolName ? STEP_NAMES[toolKind({ name: step.toolName } as ToolCall)] ?? t('调用工具') : null
  const at = step?.at ? formatDate(step.at, currentLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  return [code ? failureSentence(code) : '', name ? (at ? t('没能确认是否完成的一步：{step}（{at}）', { step: name, at }) : t('没能确认是否完成的一步：{step}', { step: name })) : ''].filter(Boolean)
}
