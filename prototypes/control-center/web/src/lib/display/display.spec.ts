import { describe, expect, it } from 'vitest'
import { authorAbstentionDisplay, evaluationBenefitDisplay, evaluationMethodDisplay, evolutionFunnelDisplay, observationSummary, retryRelations, skillFoundationDisplay, versionChangeSummary } from './evolution-evidence'
import { durationLabel, evolutionStatusRows, frequencyPreset, frequencySummary } from './autonomy-frequency'
import { adaptiveRhythmDisplay, rhythmReason } from './rhythm'
import { observationSourceDisplay } from './observation-source'
import { actionControlStatus, continuationLabel, projectActivity } from './activity'
import { backgroundModelRestriction } from './background-model'

const genome = (skills: { id: string; name?: string }[], prompt = 'p') => ({ systemPrompt: prompt, skills, tools: [{ id: 't1' }], evaluationSuite: { cases: [] } })

describe('evolution evidence projections (ported from legacy)', () => {
  const base = { id: 'v1', version: '1', state: 'baseline', bundle: { genome: genome([{ id: 's1' }]) } }
  const child = { id: 'v2', version: '2', state: 'ready', parentVersionId: 'v1', createdAt: '2026-09-28T01:00:00Z', bundle: { hash: 'h', genome: genome([{ id: 's1' }, { id: 's2', name: '**New** skill' }], 'q') }, evaluation: { evaluationComplete: true, gatePassed: true, selection: { baselineScore: 0.5, candidateScore: 0.62 }, suite: { thresholds: { minImprovement: 0.05 } } } }
  const project = { id: 'p', activeVersionId: 'v1', versions: [base, child] }

  it('summarizes an initial baseline and a changed child', () => {
    expect(versionChangeSummary(project, base).kind).toBe('initial')
    const change = versionChangeSummary(project, child)
    expect(change.kind).toBe('changed')
    expect(change.summary).toBe('调整提示词、技能（新增 1 项）。')
    expect(change.categories.find(c => c.key === 'skills')?.added).toEqual([{ id: 's2', name: 'New skill' }])
    expect(change.baselineLabel).toBe('v1')
  })
  it('counts the evolution funnel from retained records only', () => {
    const funnel = evolutionFunnelDisplay({ versions: [base, child, { ...child, id: 'v3', sourceDeleted: true }] })
    expect([funnel.attempts, funnel.generated, funnel.measured, funnel.passed, funnel.adopted]).toEqual([1, 1, 1, 1, 0])
  })
  it('explains the benefit against the frozen threshold', () => {
    expect(evaluationBenefitDisplay(child)?.summary).toBe('本次评分 0.5000 → 0.6200；分差 +0.1200，冻结门槛要求至少 +0.0500。')
    expect(evaluationMethodDisplay(child)?.summary).toBe('当前任务对照已通过，尚无独立确认结论。')
    expect(evaluationMethodDisplay({ source: 'skill-foundation' })?.phases).toEqual([])
  })
  it('links retries both ways and reads author abstention', () => {
    const retry = { id: 'v4', retryOfVersionId: 'v2', state: 'evaluating', createdAt: '2026-09-28T02:00:00Z' }
    expect(retryRelations({ versions: [child, retry] }, child).retries.map((r: { id: string }) => r.id)).toEqual(['v4'])
    expect(retryRelations({ versions: [child, retry] }, retry).source?.id).toBe('v2')
    expect(authorAbstentionDisplay({ state: 'no_change', authorAbstention: { reason: 'insufficient_evidence', revisitWhen: [{ description: 'new data' }] } })?.label).toBe('等待更多证据')
  })
  it('extracts a concise observation sentence and hides internal clauses', () => {
    expect(observationSummary({ text: '移动端首屏的按钮与标题重叠。需要调整间距。' }).summary).toBe('移动端首屏的按钮与标题重叠。')
    expect(observationSummary({ action: 'wait' }, { kind: 'decision' })).toMatchObject({ source: 'fallback', label: '保持安静' })
    expect(observationSummary({ status: 'withdrawn', text: 'x' }).source).toBe('unavailable')
  })
  it('projects the skill foundation coverage', () => {
    const value = skillFoundationDisplay({ skillFoundation: { schemaVersion: 1, status: 'ready', sourceCount: 2, coverage: [{ id: 'a', status: 'selected', skillIds: ['x'] }] } })
    expect(value?.summary).toBe('基础能力已就绪：2 项来源技能，覆盖 1/1 项能力。')
  })
})

describe('rhythm, frequency, sources, activity (ported from legacy)', () => {
  it('formats durations and presets', () => {
    expect(durationLabel(0)).toBe('不设最短间隔')
    expect(durationLabel(3600000)).toBe('1 小时')
    expect(durationLabel(90000)).toBe('90 秒')
    expect(frequencyPreset([30000, 900000, 300000, 3600000])).toBe('balanced')
    expect(frequencySummary({})).toBe('无新证据时复查 30 秒至 15 分钟；主动发言 5 分钟；自动进化最短间隔 1 小时。')
  })
  it('lists evolution status rows without inventing receipts', () => {
    const rows = evolutionStatusRows({ evolution: { enabled: true }, initiative: { enabled: false } }, { formatTime: d => d.toISOString() })
    expect(rows.find(r => r.key === 'enabled')?.value).toBe('已开启；项目主动能力已暂停')
    expect(rows.find(r => r.key === 'started')?.value).toBe('尚无自动学习启动记录。')
  })
  it('reads the adaptive rhythm or reports it unsynced', () => {
    expect(adaptiveRhythmDisplay({})).toMatchObject({ available: false, title: '自动适配 · 等待项目判断' })
    expect(adaptiveRhythmDisplay({ initiative: { enabled: false }, rhythmStatus: { control: 'auto', lifecycle: 'active' } }).title).toBe('主动协作已关闭')
    expect(rhythmReason('daily_quota')).toBe('已达到滚动 24 小时复盘上限')
    expect(rhythmReason('custom')).toBe('调度依据：custom')
  })
  it('projects an observation source', () => {
    const d = observationSourceDisplay({ id: 'ws', status: 'watching', enabled: true, stats: { received: 3 } })
    expect(d).toMatchObject({ label: '项目目录变化', stateLabel: '正在关注', stats: { received: 3, coalesced: null } })
    expect(observationSourceDisplay({ enabled: false }).status).toBe('paused')
  })
  it('orders project activity and labels controls', () => {
    const project = { id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [
      { id: 'a1', action: 'work', status: 'completed', createdAt: '2026-09-28T01:00:00Z' },
      { id: 'a2', action: 'work', status: 'running', createdAt: '2026-09-28T00:00:00Z', controls: [{ kind: 'pause', status: 'pending' }] },
    ] } } }
    const rows = projectActivity(project, [])
    expect(rows.map(r => r.id)).toEqual(['a2', 'a1'])
    expect(rows[0].statusLabel).toBe('正在暂停')
    expect(actionControlStatus({ status: 'cancelled', controls: [{ kind: 'cancel', status: 'applied' }] })).toBe('已停止')
    expect(projectActivity({ simulated: true }, [])).toEqual([])
    expect(continuationLabel({ status: 'running', continuation: { segments: 2, status: 'running' } })).toBe('正在继续')
  })
  it('flags an interactive-only background model', () => {
    const cfg = { defaultModel: { providerId: 'x', modelId: 'm' }, providers: [{ id: 'x', name: 'Sub', usagePolicy: 'interactive_only', models: [{ id: 'm', name: 'M' }] }] }
    expect(backgroundModelRestriction({ simulated: false }, cfg)).toMatchObject({ code: 'interactive_only', route: 'Sub / M', source: '应用默认模型' })
    expect(backgroundModelRestriction({ simulated: true }, cfg)).toBeNull()
  })
})

// Live, 2026-10-03: 查看进度 showed a scheduled run's whole host instruction under 要做什么 and an English host sentence under 为什么做.
it('a scheduled run reads as the schedule the user set up: its task as the intent, its due time as the reason', () => {
  const project = { schedules: [{ id: 'daily', title: '每日 AI 日报', task: '写今天的日报。' }], scheduleRuntime: { occurrences: [{ key: 'schedule:daily:k', actionId: 'schedule-work-k', deliveryActionId: 'schedule-delivery-k' }] },
    initiativeRuntime: { sdkState: { actions: [
      { id: 'schedule-work-k', action: 'work', status: 'running', content: 'Scheduled occurrence schedule:daily:k\nDue: 2026-10-03T01:00:00.000Z\nTime rule: {}\n\n写今天的日报。\n\nProduce the requested deliverable…', reason: 'A persisted project schedule is due; perform this occurrence once within current permissions.', hostSchedule: { key: 'schedule:daily:k', scheduleId: 'daily' } },
      { id: 'schedule-delivery-k', action: 'share', status: 'queued', content: '每日 AI 日报\n\n结果', reason: 'Deliver the completed scheduled occurrence to its configured project conversation.', hostSchedule: { key: 'schedule:daily:k', scheduleId: 'daily' } },
      { id: 'own', action: 'work', status: 'running', content: '核对第 8 章。', reason: '用户提到第 8 章有矛盾。' },
    ] } } }
  const rows = Object.fromEntries(projectActivity(project, []).map((row: any) => [row.id, row]))
  expect([rows['schedule-work-k'].intent, rows['schedule-work-k'].reason]).toEqual(['写今天的日报。', '到了定时任务「每日 AI 日报」设定的时间。'])
  expect(rows['schedule-delivery-k'].reason).toBe('定时任务做完了，结果送到它设置的对话。')
  expect([rows.own.intent, rows.own.reason]).toEqual(['核对第 8 章。', '用户提到第 8 章有矛盾。'])
  // Edited or deleted since it ran: 要做什么 is still what this run was given.
  const edited = { ...project, schedules: [{ id: 'daily', title: '每日 AI 日报', task: '写本周周报。' }] }
  expect(projectActivity(edited, []).find((row: any) => row.id === 'schedule-work-k')?.intent).toBe('写今天的日报。')
  expect(projectActivity({ ...project, schedules: [] }, []).find((row: any) => row.id === 'schedule-work-k')?.intent).toBe('写今天的日报。')
})

