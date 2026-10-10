/**
 * Turn phase labels. The host adds phases over time (E1: `preparing_memory`,
 * `compacting`, `connecting`, …). What the reader sees before the first output
 * is one word, 思考中: the host's own steps (workspace, memory, routing,
 * the request itself) are its business, and the exact step stays available as
 * a detail (tooltip). Only states that tell the reader something — queued,
 * compacting a long context, retrying, waiting for them — are named.
 */
import { currentLocale, localized, t } from '@/i18n'

/** The host's steps before the first output, shown to the reader as 思考中. */
const HOST_STEPS = new Set(['starting', 'connecting', 'preparing', 'preparing_workspace', 'preparing_context', 'preparing_memory', 'loading_memory', 'memory', 'routing'])
const DETAILS: Record<string, string> = localized({
  starting: '正在开始',
  connecting: '已发出请求，等模型开始输出',
  preparing: '正在准备',
  preparing_workspace: '正在准备工作区',
  preparing_context: '正在整理请求',
  preparing_memory: '正在查找项目记忆',
  loading_memory: '正在查找项目记忆',
  memory: '正在查找项目记忆',
  routing: '正在判断思考深度',
})
const LABELS: Record<string, string> = localized({
  queued: '排队中',
  compacting: '正在整理上下文',
  thinking: '思考中',
  writing: '正在撰写',
  tool: '正在调用工具',
  waiting_user: '等待你的回答',
  waiting_tool: '等待工具结果',
  retrying: '正在重试',
  recovering: '正在恢复',
  finishing: '正在收尾',
  // 0.63: a worktree conversation's turn writing its changes into the project folder (after the answer).
  applying: '正在应用到项目文件夹',
  continuing: '接着做剩下的',
  paused: '已暂停',
})

/** Words used to build a zh-CN label for phases this client has not seen yet (English humanizes the id). */
// i18n-ignore: zh-CN composition only
const WORDS: Record<string, string> = {
  preparing: '准备', prepare: '准备', loading: '读取', load: '读取', memory: '记忆', context: '上下文', compacting: '整理', compact: '整理',
  connecting: '连接', waiting: '等待', wait: '等待', user: '用户', tool: '工具', tools: '工具', model: '模型', skills: '技能', skill: '技能',
  retrying: '重试', retry: '重试', summarizing: '总结', summary: '总结', indexing: '索引', verifying: '校验', planning: '规划', plan: '计划',
  routing: '路由', uploading: '上传', files: '文件', file: '文件', search: '搜索', searching: '搜索', finishing: '收尾', saving: '保存',
}

/** A readable name for a phase this client has not seen yet (English humanizes the id; zh-CN composes from WORDS). */
function composed(phase: string): string | null {
  const parts = phase.toLowerCase().split(/[_\-.\s]+/).filter(Boolean)
  const words = parts.map(p => WORDS[p])
  if (!parts.length || !words.every(Boolean)) return null
  if (currentLocale() === 'en') return parts.join(' ').replace(/^./, c => c.toUpperCase())
  return `正在${words.join('')}` // i18n-ignore: zh-CN only
}

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase || HOST_STEPS.has(phase)) return t('思考中')
  // Contract: unknown new phases are treated as `connecting` — the reader sees 思考中, the detail names the step.
  return LABELS[phase] ?? t('思考中')
}

/** The host step behind 思考中, for a tooltip; null when the label already says it. */
export function phaseDetail(phase: string | null | undefined): string | null {
  if (!phase || LABELS[phase]) return null
  return DETAILS[phase] ?? composed(phase)
}

/** Phases that stand in for the whole process header while the turn has no visible content. */
export const PREPARATION_PHASES = new Set(['queued', 'starting', 'connecting', 'preparing', 'preparing_workspace', 'preparing_context', 'preparing_memory', 'loading_memory', 'memory', 'routing', 'compacting', 'retrying', 'recovering', 'continuing'])

const STREAMING_PHASES = new Set(['thinking', 'writing', 'tool', 'waiting_user', 'finishing', 'paused', 'waiting_tool', 'applying'])

export function isPreparationPhase(phase: string | null | undefined): boolean {
  if (!phase) return false
  // Unknown phases count as `connecting` (contract), i.e. still preparing.
  return PREPARATION_PHASES.has(phase) || !STREAMING_PHASES.has(phase)
}

/* ---------------------------------------------------------- turn timing (E1) */

export type TurnTiming = Partial<Record<'queued' | 'foreground' | 'capabilities' | 'orientation' | 'journal' | 'runtime' | 'preparing' | 'preflight' | 'memory' | 'routing' | 'compaction' | 'context' | 'toRequest' | 'request' | 'firstToken' | 'compactionAfter', number>>

const TIMING_LABELS: [keyof TurnTiming, string][] = localized([
  ['queued', '排队'], ['foreground', '等待后台让出'], ['capabilities', '能力目录'], ['orientation', '工作区概览'], ['journal', '会话日志'],
  ['preparing', '准备会话'], ['preflight', '预判'], ['memory', '等待记忆'], ['routing', '判断思考深度'], ['compaction', '请求前压缩'],
  ['context', '整理请求'], ['toRequest', '发出请求'], ['request', '模型首字延迟'], ['firstToken', '首字'], ['compactionAfter', '回复后压缩'],
])

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)

/** "准备 0.8s · 首字 1.5s" (+ "回复后压缩 2.1s" when it happened). */
export function timingSummary(timing: TurnTiming | null | undefined): string {
  if (!timing) return ''
  const parts: string[] = []
  if (typeof timing.toRequest === 'number') parts.push(t('准备 {v}', { v: secs(timing.toRequest) }))
  if (typeof timing.firstToken === 'number') parts.push(t('首字 {v}', { v: secs(timing.firstToken) }))
  if (timing.compactionAfter) parts.push(t('回复后压缩 {v}', { v: secs(timing.compactionAfter) }))
  return parts.join(' · ')
}

/** Every recorded stage, in order, for detail views. */
export function timingRows(timing: TurnTiming | null | undefined): [string, string][] {
  if (!timing) return []
  return TIMING_LABELS.filter(([key]) => typeof timing[key] === 'number').map(([key, label]) => [label, secs(timing[key]!)])
}
