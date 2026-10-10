/**
 * Mock background progress for the tasks panel (?mock): the host's `work`
 * projection of each project's actions (P-1), plan items tied to the run that
 * staged or resolved them (P-3), a subagent group in 美术技能挑选 and the
 * sessions' `agents` summary (P-4), and live `work.step` events for the
 * running work (P-2). `work` is computed from the action rows on every
 * summary, so pausing or stopping a run in the mock moves it between sections.
 */
import type { Item, ProjectPlan, ProjectWork, Session, SessionAgentsSummary, SubagentInfo, WorkRun, WorkStepEvent } from '@/api/types'
import { ago } from './fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const GLM = { providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3' }
const KIMI = { providerId: 'kimi', modelId: 'kimi-k3', name: 'Kimi K3' }

type Json = Record<string, unknown>
const kinds = (patch: Partial<WorkRun['steps']['kinds']> = {}) => ({ read: 0, search: 0, edit: 0, write: 0, command: 0, web: 0, other: 0, ...patch })

/** What the host knows about each run beyond its action row: steps, its own plan items (as mockPlan tags them), tokens, model, latest step, change set. */
const PROGRESS: Record<string, Partial<WorkRun>> = {
  'act-work-1': {
    title: '核对移动端 390px 下的长路径截断', steps: { total: 24, completed: 23, failed: 1, uncertain: 0, limit: 64, kinds: kinds({ read: 11, search: 4, edit: 5, command: 3, web: 1 }) },
    latest: { name: 'project_edit', kind: 'edit', target: 'src/components/TerminalBlock.tsx', status: 'succeeded', at: ago(40_000) },
    plan: { done: 2, total: 4 }, tokens: { total: 18_200, estimated: false }, model: GLM, changeId: 'bg-1',
  },
  'act-work-2': {
    title: '整理 v12 以来的芦苇穗头贴图性能数据', steps: { total: 9, completed: 9, failed: 0, uncertain: 0, limit: 64, kinds: kinds({ read: 6, command: 3 }) },
    latest: { name: 'project_exec', kind: 'command', target: 'node scripts/fps-sample.mjs --device redmi9', status: 'succeeded', at: ago(3 * HOUR - 5 * MIN) },
    plan: { done: 0, total: 1 }, tokens: { total: 6_400, estimated: false }, model: GLM,
  },
  'act-work-3': {
    title: '复核芦苇穗头透明排序修复后的帧率', steps: { total: 31, completed: 31, failed: 0, uncertain: 0, limit: 64, kinds: kinds({ read: 14, command: 12, edit: 2, web: 3 }) },
    plan: { done: 1, total: 1 }, tokens: { total: 22_400, estimated: false }, model: GLM, summary: '透明排序修复有效：Redmi 9 由 41fps 回到 52fps，iPhone 12 稳定 60fps。',
  },
  'act-agent-1': { title: '对照 stream-protocol-v2 规范复核 tool_args 增量事件的字段命名' },
}

/** This morning's scheduled run of the daily checkpoint (已完成 · 定时任务; its action row has aged out of the list). */
const scheduledRun = (): WorkRun => ({
  id: 'act-sched-1', kind: 'scheduled', title: '试玩反馈每日检查点', status: 'completed', scheduleId: 'sch-daily', occurrenceKey: 'schedule:sch-daily:occ-today',
  createdAt: ago(21 * MIN), startedAt: ago(20 * MIN), completedAt: ago(18 * MIN),
  steps: { total: 18, completed: 18, failed: 0, uncertain: 0, limit: 64, kinds: kinds({ read: 6, command: 12 }) }, plan: null, latest: null,
  tokens: { total: 12_100, estimated: false }, model: GLM, changeId: null, summary: '回归 16/16 全部通过，界面重设计后没有发现新的布局问题。',
})

const LIVE = new Set(['queued', 'running', 'paused'])
const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'needs_review'])
const iso = (value: unknown) => (typeof value === 'number' ? new Date(value).toISOString() : typeof value === 'string' ? value : undefined)

function toRun(action: Json): WorkRun {
  const extra = PROGRESS[String(action.id)] ?? {}
  return {
    id: String(action.id), kind: action.action === 'learn' ? 'learn' : 'work', title: String((action.contextRevoked ? action.keptLabel : action.label ?? action.content) ?? '').split('\n')[0].slice(0, 80),
    status: String(action.status) as WorkRun['status'], createdAt: iso(action.createdAt) ?? ago(0), startedAt: iso(action.startedAt), completedAt: iso(action.finishedAt),
    steps: { total: 0, completed: 0, failed: 0, uncertain: 0, limit: 64, kinds: kinds() }, plan: null, latest: null, tokens: { total: 0, estimated: false }, model: null, changeId: null,
    ...(action.status === 'failed' ? { errorCode: String((action.failure as Json | undefined)?.code ?? 'failed') } : {}),
    ...extra,
  }
}

/** The project summary's `work`: live runs, and work / learning runs that ended within 24 h (newest first, at most 8). */
export function mockWork(projectId: string, actions: Json[]): ProjectWork {
  // A revoked run is named by what the host kept for the user, and left out when nothing was kept (the host's workRun).
  const own = actions.filter(action => (action.action === 'work' || action.action === 'learn') && (!action.contextRevoked || action.keptLabel))
  const running = own.filter(action => LIVE.has(String(action.status))).map(toRun)
  const ended = own.filter(action => ENDED.has(String(action.status))).map(toRun)
  if (projectId === 'p-ink') ended.push(scheduledRun())
  const at = (run: WorkRun) => Date.parse(run.completedAt ?? run.startedAt ?? run.createdAt)
  const recent = ended.filter(run => Date.now() - at(run) < DAY).sort((a, b) => at(b) - at(a)).slice(0, 8)
  return { running, recent }
}

/** P-3: plan items carry the run that staged (doing / next) or resolved (done) them. */
const PLAN_ACTIONS: Record<string, string> = { pl1: 'act-work-1', pl2: 'act-work-1', pl3: 'act-work-2', pl0: 'act-work-3' }
export function mockPlan(plan: ProjectPlan | null | undefined): ProjectPlan | null | undefined {
  if (!plan) return plan
  const tag = (row: ProjectPlan['next'][number]) => ({ ...row, actionId: PLAN_ACTIONS[row.id] ?? row.actionId ?? null })
  // Two items the running work already finished (计划项 2/4 on its card).
  const done = plan.done.some(row => row.id === 'pl-a') ? plan.done : [
    { id: 'pl-a', text: '核对终端块在窄屏的横向滚动', status: 'done', updatedAt: ago(4 * MIN), actionId: 'act-work-1' },
    { id: 'pl-b', text: '列出 390px 下被截断的路径', status: 'done', updatedAt: ago(3 * MIN), actionId: 'act-work-1' },
    ...plan.done,
  ]
  return { doing: plan.doing.map(tag), next: plan.next.map(tag), done: done.map(tag) }
}

/* ------------------------------------------------------- subagent group */

const RESEARCH_TURN = 't-res-1'
const agent = (id: string, offset: number, info: Omit<SubagentInfo, 'agentId' | 'background' | 'turnId'>): Item => ({
  id: `sa-${id}`, turnId: RESEARCH_TURN, kind: 'subagent', text: `${info.roleName} · ${info.task}`, createdAt: ago(offset),
  subagent: { agentId: id, background: true, turnId: RESEARCH_TURN, delivery: info.status === 'running' ? 'awaiting' : 'joined', ...info },
})

/** 美术技能挑选's background helpers: 侦察 2/2 · 实施 1/2 · 审查 0/1. */
export function researchAgents(): Item[] {
  return [
    agent('agent-scout-1', 8 * MIN + 50_000, { role: 'scout', roleName: '项目侦察', task: '盘点项目现有的美术资源与着色器约定', status: 'completed', startedAt: ago(8 * MIN + 50_000), endedAt: ago(7 * MIN), summary: '共 42 个贴图、6 个自定义着色器；水墨笔触集中在 ink.frag。', usage: { totalTokens: 7_800 }, toolCount: 9, model: GLM }),
    agent('agent-scout-2', 8 * MIN + 45_000, { role: 'scout', roleName: '项目侦察', task: '检索技能市场里与水墨、国风相关的候选', status: 'completed', startedAt: ago(8 * MIN + 45_000), endedAt: ago(6 * MIN), summary: '找到 8 个候选，3 个与水墨风格高度契合。', usage: { totalTokens: 9_300 }, toolCount: 7, model: GLM }),
    agent('agent-worker-1', 5 * MIN + 30_000, { role: 'worker', roleName: '实现协作', task: '把三个候选技能装进临时目录并跑一遍示例', status: 'completed', startedAt: ago(5 * MIN + 30_000), endedAt: ago(2 * MIN), summary: 'build-hybrid-game-assets 与 visual-style 示例都能跑通。', usage: { totalTokens: 11_200 }, toolCount: 14, model: KIMI }),
    agent('agent-worker-2', 3 * MIN, { role: 'worker', roleName: '实现协作', task: '对照水墨风格整理候选技能的取舍清单', status: 'running', startedAt: ago(3 * MIN), endedAt: null, summary: null, usage: { totalTokens: 6_900, estimated: true }, toolCount: 5, lastTool: 'project_read', model: KIMI }),
    agent('agent-review-2', 70_000, { role: 'reviewer', roleName: '交付审阅', task: '审阅取舍清单是否与项目约定冲突', status: 'running', startedAt: ago(70_000), endedAt: null, summary: null, usage: { totalTokens: 2_100, estimated: true }, toolCount: 2, model: GLM }),
  ]
}

/** P-4: the session summary's `agents`, from its latest delegating turns. */
export function mockAgentsSummary(session: Pick<Session, 'items'>): SessionAgentsSummary | undefined {
  const agents = session.items.filter(item => item.kind === 'subagent' && item.subagent).map(item => item.subagent!)
  if (!agents.length) return undefined
  const latest = [...session.items].reverse().find(item => item.kind === 'subagent')?.turnId ?? null
  return { running: agents.filter(row => row.status === 'running').length, total: agents.length, tokens: agents.reduce((n, row) => n + (row.usage?.totalTokens ?? 0), 0), latestTurnId: latest }
}

/* ------------------------------------------------------------ live steps */

const SCRIPT: Pick<WorkStepEvent, 'name' | 'kind' | 'target'>[] = [
  { name: 'project_read', kind: 'read', target: 'src/components/TerminalBlock.tsx' },
  { name: 'project_grep', kind: 'search', target: 'text-overflow · src/styles' },
  { name: 'project_edit', kind: 'edit', target: 'src/styles/terminal.css' },
  { name: 'project_exec', kind: 'command', target: 'npx playwright test mobile.spec.ts' },
  { name: 'web_fetch', kind: 'web_fetch', target: 'developer.mozilla.org/docs/Web/CSS/text-overflow' },
  { name: 'project_read', kind: 'read', target: 'tests/mobile.spec.ts' },
]

/** Emit `work.step` for the running mock work every few seconds while it runs; returns a stop function. */
export function startMockWorkSteps(emit: (event: WorkStepEvent) => void, running: () => boolean, { everyMs = 2600 }: { everyMs?: number } = {}) {
  let n = 0
  const timer = setInterval(() => {
    if (!running()) return
    const step = SCRIPT[n % SCRIPT.length]
    n++
    emit({ type: 'work.step', projectId: 'p-ink', actionId: 'act-work-1', toolCallId: `mock-step-${n}`, ...step, status: 'running', at: new Date().toISOString() })
  }, everyMs)
  return () => clearInterval(timer)
}
