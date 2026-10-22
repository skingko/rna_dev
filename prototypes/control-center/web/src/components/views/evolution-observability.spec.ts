/**
 * P2 batch D, D3 (EVO-12): the rhythm card says where the gene lanes are instead of the retired whole-genome learning lane's
 * quota and "no candidate guaranteed"; the evolution page's header carries the same lines; the observation block lists
 * exposure, dispositions, outcomes by generation and the scoreboard, in both languages.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getTransport, setTransport } from '@/api/client'
import type { Transport } from '@/api/transport'
import type { EvolutionStatus, GeneObservability } from '@/api/genes-api'
import type { ProjectDetail } from '@/api/project-api'
import { usePreferences } from '@/components/settings/preferences'
import { RhythmCard } from './RhythmCard'
import { Observability, laneLines } from './EvolutionObservability'
import { Headline } from './EvolutionView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STATUS: EvolutionStatus = { at: '2026-10-05T01:00:00Z', enabled: true, status: { generation: null, A: { state: 'due', due: 2, retrying: 1, last: null }, B: { state: 'cooldown', queued: 3, cooldownUntil: '2026-10-05T02:00:00Z', last: null }, C: { state: 'waiting', trouble: 1, needed: 3, lastAnalysisAt: null, last: null } } }
const OBSERVED: GeneObservability = {
  ...STATUS, notes: ['2 checks have never run.'],
  genes: [{ id: 'guard:g', layer: 'guard', title: '守夜检查', status: 'active', generation: 2, ran: 9, ranRecent: 4, hits: 3, real: 1, falseMatches: 0, shown: null, recalled: 0, applied: 0, notFollowed: 0, missed: 0 },
    { id: 'skill-patch:p', layer: 'skill', title: '先核对数字', status: 'trial', generation: 3, ran: 0, ranRecent: null, hits: 0, real: 0, falseMatches: 0, shown: 6, recalled: 5, applied: 2, notFollowed: 1, missed: 0, injectedRecent: 3 }],
  harm: [{ geneId: 'skill-patch:p', title: '先核对数字', shared: 3, schedules: 1, before: { rate: 0, settled: 3 }, after: { rate: 0.67, settled: 3 }, delta: 0.67, harmful: true, state: 'invited' }],
  dispositions: { lessons: { counts: { gene: { guard: 1 }, terminal: { profile_only: 2, covered: 1 }, retryable: { author_error: 1 }, pending: {} }, recent: [] }, corrections: { counts: { terminal: { judged_no: 4 }, retryable: { no_judge: 1 } }, recent: [] }, genes: { retired: { dropped: 2, replaced: 1 }, rejected: { review_failed: 1 }, retryable: {} } },
  generations: [{ n: 3, at: '2026-10-04T00:00:00Z', summary: 's', trigger: 'correction', corrected: 1, undone: 0, approved: 1, accepted: 2, failed: 0, bad: 1, known: 4, rate: 0.25, before: { bad: 2, known: 4, rate: 0.5 } }],
  scoreboard: [{ geneId: 'skill-patch:p', layer: 'skill', title: '先核对数字', generation: 3, at: '2026-10-04T00:00:00Z', status: 'trial', expectation: '数字不再出错', scope: { kind: 'schedule', ids: ['s1'] }, before: { bad: 1, known: 3 }, after: { bad: 2, known: 3 }, applied: 2, real: 0, missed: 0, verdict: 'again' }],
  outcomes: { total: 7, byOutcome: { accepted: 4, corrected: 2, unanswered: 1 }, schedules: [{ scheduleId: 's1', title: '每日报告', occurrences: 7, latestAt: '2026-10-04T00:00:00Z' }] },
  bloat: { ratio: 1.65, minimum: 4, evidence: 8, rules: [{ id: 'skill-patch:p', title: '先核对数字', shown: 9, applied: 0, observed: 9, unproven: true }] },
  contrasts: [{ at: '2026-10-03T00:00:00Z', turns: 12, trouble: 4, pairs: 1, clusters: 2, analyzed: true, patches: 1, committed: 1 }], funnel: null,
}
let root: Root, host: HTMLDivElement, original: Transport
const reply = (calls: string[]) => ({ ...getTransport(), kind: 'mock', request: async (path: string) => { calls.push(path); return path.endsWith('view=status') ? STATUS : OBSERVED } }) as Transport
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
beforeEach(() => { vi.useRealTimers(); original = getTransport(); usePreferences.setState({ language: 'zh' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(original) })

const project = (enabled: boolean) => ({ id: 'p', name: '晨报', rhythm: { control: 'auto' }, initiative: { enabled: true }, evolution: { enabled },
  rhythmStatus: { control: 'auto', lifecycle: 'recurring', assessmentRequired: false, effective: { initiativeEnabled: true, evolutionEnabled: enabled }, schedule: { activeCount: 0, dueCount: 0 }, initiative: { eligible: true, reason: 'user_steering', state: 'ready' },
    evolution: { eligible: true, reason: 'user_steering', nextAt: null, state: 'ready', quota: { dayUsed: 1, maxPerDay: 2, weekUsed: 7, maxPerWeek: 8 } }, assessment: { evolution: { mode: 'evidence' } } } }) as unknown as ProjectDetail

it('names each lane by what it waits for, in both languages', () => {
  expect(laneLines(STATUS.status)).toEqual(['经验转做法：2 条待处理，其中 1 条稍后重试', '纠正复核：3 条排队，写做法冷却中', '对照分析：问题 1/3，攒够了才跑'])
  usePreferences.setState({ language: 'en' })
  expect(laneLines(STATUS.status)).toEqual(['Lessons to rules: 2 waiting, 1 of them to be retried later', 'Correction review: 3 queued, writing a rule is cooling down', 'Contrast analysis: 1/3 problems, it runs when enough pile up'])
  expect(laneLines({ ...STATUS.status, A: { state: 'idle', due: 0, retrying: 0, last: null }, B: { state: 'idle', queued: 0, last: null }, C: { state: 'due', trouble: 3, needed: 3, lastAnalysisAt: null, last: null } })).toEqual(['Lessons to rules: nothing waiting', 'Correction review: nothing waiting', 'Contrast analysis: ready to run'])
})

it('EVO-12: the rhythm card shows the gene lanes, not the whole-genome learning lane\'s quota or its "no candidate guaranteed" line', async () => {
  const calls: string[] = []; setTransport(reply(calls))
  await act(async () => { root.render(createElement(RhythmCard, { project: project(true) })) }); await settle()
  expect(calls).toEqual(['/api/v2/projects/p/genes/observability?view=status'])
  expect(host.textContent).toContain('进化'); expect(host.textContent).toContain('经验转做法：2 条待处理'); expect(host.textContent).toContain('对照分析：问题 1/3')
  expect(host.textContent).not.toContain('到期不保证生成候选'); expect(host.textContent).not.toContain('滚动 24 小时'); expect(host.textContent).not.toContain('自主进化')
})

it('the rhythm card says the rules in force keep working when background evolution is not running, and shows a dash until the lanes are read', async () => {
  const calls: string[] = []
  setTransport({ ...getTransport(), kind: 'mock', request: async (path: string) => { calls.push(path); return { ...STATUS, enabled: false } } } as Transport)
  act(() => { root.render(createElement(RhythmCard, { project: project(true) })) })
  expect(host.textContent).toContain('—')
  await settle()
  expect(host.textContent).toContain('进化已关闭，已有的规则照常起作用。'); expect(host.textContent).not.toContain('经验转做法')
})

it('the rhythm card says evolution is off in its own words when the user turned it off, without asking the host', async () => {
  const calls: string[] = []; setTransport(reply(calls))
  await act(async () => { root.render(createElement(RhythmCard, { project: project(false) })) }); await settle()
  expect(host.textContent).toContain('自主进化已关闭'); expect(host.textContent).not.toContain('经验转做法')
})

it('the observation block lists exposure, dispositions, generation outcomes, the scoreboard, harm readings and the last analyses — zh and en', async () => {
  const calls: string[] = []; setTransport(reply(calls))
  await act(async () => { root.render(createElement(Observability, { projectId: 'p' })) }); await settle()
  const text = host.textContent ?? ''
  for (const expected of ['2 checks have never run.', '守夜检查', '运行 9 次，最近 7 天 4 次，确认 1 处真问题', '放进回合 6 次（最近 7 天 3 个回合），照着做 2 次', '已有定论：只留在画像里 2、已有规则覆盖 1', '稍后重试：写作模型暂时不可用 1', '不是做法问题 4', '已停用：你说不再用 2、被新写法取代 1', '没通过：复审没通过 1', '1/4 被纠正（25%） ← 50%', '之后又被纠正过', '同一个定时任务前 1/3，后 2/3 被纠正', '预期：数字不再出错', '被纠正 0% → 67%（对照 3 对）', '已邀请你决定', '被接受 4、被纠正 2、没人回应 1', '提示词是起点的 165%', '12 轮，问题 4，配对 1，写了 1 条做法'])
    expect(text, expected).toContain(expected)
  expect(calls).toEqual(['/api/v2/projects/p/genes/observability'])
  usePreferences.setState({ language: 'en' })
  await act(async () => { root.render(createElement(Observability, { projectId: 'q' })) }); await settle()
  const english = host.textContent ?? ''
  for (const expected of ['Ran 9 times, 4 in the last 7 days, 1 real problem confirmed', 'Put in front of the agent 6 times (3 turns in the last 7 days), followed 2 times', 'Settled: Kept in the profile only 2, Already covered by a rule 1', 'To retry later: The writing model was unavailable 1', 'Retired: You said stop using it 2, Replaced by a newer wording 1', 'Rejected: Review did not pass 1', 'Corrected again since', 'Same scheduled task: 1/3 corrected before, 2/3 after', 'Expected: 数字不再出错', 'Corrected 0% → 67% (3 pairs compared)', 'you were invited to decide', 'Accepted 4, Corrected 2, Nobody answered 1', 'The prompt is 165% of its first size, and 1 skill rule was put in front of the agent many times and never followed', '12 turns, 4 problems, 1 pair, 1 rule written'])
    expect(english, expected).toContain(expected)
  for (const gone of ['运行 9 次', '已有定论', '之后又被纠正过', '各条线现在']) expect(english, gone).not.toContain(gone)
})

it('a check that ran before its runs were counted by day says how often it ran, not "0 in the last 7 days"', async () => {
  const quiet = { ...OBSERVED, genes: [{ ...OBSERVED.genes[0], ranRecent: null }] }
  setTransport({ ...getTransport(), kind: 'mock', request: async () => quiet } as Transport)
  await act(async () => { root.render(createElement(Observability, { projectId: 'p' })) }); await settle()
  expect(host.textContent).toContain('运行 9 次，确认 1 处真问题'); expect(host.textContent).not.toContain('最近 7 天 0 次')
  usePreferences.setState({ language: 'en' })
  await act(async () => { root.render(createElement(Observability, { projectId: 'q' })) }); await settle()
  expect(host.textContent).toContain('Ran 9 times, 1 real problem confirmed'); expect(host.textContent).not.toContain('0 in the last 7 days')
})

it('EVO-12: the evolution page\'s header carries the lanes\' state; switched off, it says the rules in force keep working', async () => {
  const tree = { projectId: 'p', promptFile: { name: null, exists: false, default: 'AGENTS.md' }, generation: { n: 4, at: '2026-10-04T00:00:00Z', summary: '补充做法' }, generations: [], forming: false, strands: [] }
  await act(async () => { root.render(createElement(Headline, { tree, status: STATUS })) })
  expect(host.querySelector('[data-evolution-lanes]')?.textContent).toBe('经验转做法：2 条待处理，其中 1 条稍后重试 · 纠正复核：3 条排队，写做法冷却中 · 对照分析：问题 1/3，攒够了才跑')
  await act(async () => { root.render(createElement(Headline, { tree, status: { ...STATUS, enabled: false } })) })
  expect(host.querySelector('[data-evolution-lanes]')?.textContent).toBe('进化已关闭，已有的规则照常起作用。')
  await act(async () => { root.render(createElement(Headline, { tree, status: null })) })
  expect(host.querySelector('[data-evolution-lanes]')).toBeNull()
})

it('a read that fails says so and the page goes on', async () => {
  setTransport({ ...getTransport(), kind: 'mock', request: async () => { throw new Error('offline') } } as Transport)
  await act(async () => { root.render(createElement(Observability, { projectId: 'p' })) }); await settle()
  expect(host.textContent).toContain('进化观测暂时读不到：offline')
})

it('a rule only background runs read says so apart from the turns it was put in: those runs are never judged', async () => {
  const runs = { ...OBSERVED, genes: [{ ...OBSERVED.genes[1], shown: 0, applied: 0, injectedRecent: 0, inRuns: 17 }] }
  setTransport({ ...getTransport(), kind: 'mock', request: async () => runs } as Transport)
  await act(async () => { root.render(createElement(Observability, { projectId: 'p' })) }); await settle()
  expect(host.textContent).toContain('放进回合 0 次（最近 7 天 0 个回合），照着做 0 次 · 后台运行读到 17 次（没人评价）')
  usePreferences.setState({ language: 'en' })
  await act(async () => { root.render(createElement(Observability, { projectId: 'q' })) }); await settle()
  expect(host.textContent).toContain('followed 0 times · Read in 17 background runs (nobody judges those)')
})
