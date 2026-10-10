// @vitest-environment node
// UX audit 2026-10-03 (texts): host and SDK codes never reach the user raw, and the rhythm headline is the host's reason.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usePreferences } from '@/components/settings/preferences'
import { RHYTHM_REASONS, adaptiveRhythmDisplay, rhythmReason } from './display/rhythm'
import * as autonomy from '@/components/settings/autonomy'
import { PAUSE_REASONS, healthLine } from './mind'
import { REACH_REASONS, entryDisplay } from './communication'
import type { InboxEntry } from '@/api/communication-api'

const root = join(__dirname, '../../../../..'), host = join(root, 'prototypes/control-center')
const source = (path: string) => readFileSync(path, 'utf8')
/** The text of a call starting at `open` (the index of its `(`), up to the matching `)`. */
function callArgs(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '[' || text[i] === '{') depth++
    else if (text[i] === ')' || text[i] === ']' || text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i) }
  }
  throw new Error('unbalanced call')
}
function topLevelArgs(args: string): string[] {
  const out: string[] = []; let depth = 0, start = 0
  for (let i = 0; i < args.length; i++) {
    if ('([{'.includes(args[i])) depth++
    else if (')]}'.includes(args[i])) depth--
    else if (args[i] === ',' && depth === 0) { out.push(args.slice(start, i).trim()); start = i + 1 }
  }
  return [...out, args.slice(start).trim()]
}
const literals = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map(m => m[1])

/** Every lane reason resolveProjectRhythm can return: the second argument of each lane(...) call (or the `const` it names). */
function sdkRhythmReasons(): string[] {
  const text = source(join(root, 'packages/sdk/src/project-rhythm.mjs')), body = text.slice(text.indexOf('export function resolveProjectRhythm'))
  const codes = new Set<string>()
  for (const match of body.matchAll(/\blane\(/g)) {
    const reason = topLevelArgs(callArgs(body, match.index! + 4))[1]
    if (/^[A-Za-z_$][\w$]*$/.test(reason)) { const decl = body.match(new RegExp(`const ${reason} = ([\\s\\S]*?);`)); literals(decl?.[1] ?? '').forEach(code => codes.add(code)) }
    else literals(reason).forEach(code => codes.add(code))
  }
  return [...codes]
}

afterEach(() => usePreferences.setState({ language: 'zh' }))

describe('project rhythm reasons (F72)', () => {
  it('labels every lane reason the SDK can return', () => {
    const codes = sdkRhythmReasons()
    expect(codes).toEqual(expect.arrayContaining(['user_steering', 'steering_gap', 'conversation_live', 'conversation_follow_up', 'learning_due', 'weekly_review_quota']))
    expect(codes.filter(code => !RHYTHM_REASONS[code])).toEqual([])
    expect(rhythmReason('user_steering')).not.toMatch(/user_steering|调度依据/)
  })
  it('settings and the project page share one projection', () => {
    expect(autonomy.adaptiveRhythmDisplay).toBe(adaptiveRhythmDisplay)
    expect(autonomy.rhythmReason).toBe(rhythmReason)
  })
})

const project = (extra: Record<string, unknown> = {}) => ({
  id: 'p', initiative: { enabled: true }, evolution: { enabled: true }, rhythm: { control: 'auto' },
  rhythmStatus: { control: 'auto', lifecycle: 'blocked', assessmentRequired: false, effective: { initiativeEnabled: true, evolutionEnabled: true }, schedule: { activeCount: 1, dueCount: 0, nextAt: null },
    initiative: { eligible: false, reason: 'awaiting_changed_prerequisite', state: 'sleeping' }, evolution: { eligible: true, reason: 'user_steering', state: 'ready', quota: { dayUsed: 0, weekUsed: 0, maxPerDay: 2, maxPerWeek: 6 } },
    assessment: { reason: '项目处于用户亲手重构中（rev34→35，userPaused、lastEditedBy=user）', initiative: { mode: 'event_only' }, evolution: { mode: 'evidence' } }, history: [] },
  ...extra,
})

describe('rhythm card headline (F90) and admission text (F79)', () => {
  it('leads with the host reason and keeps the model rationale for 模型判断', () => {
    const shown = adaptiveRhythmDisplay(project())
    expect(shown.reason).toBe('等待阻塞条件发生变化')
    expect(shown.modelReason).toMatch(/lastEditedBy=user/)
    expect(shown.evolutionReason).toBe('你刚纠正或提出了改进，现在据此复盘')
  })
  it('names a blocked project by reason in the interface language, with causes instead of raw codes', () => {
    usePreferences.setState({ language: 'en' })
    const blocked = project({ initiativeRuntime: { availability: { state: 'blocked', reason: 'session_cleanup_pending', title: '后台暂缓 · 会话清理待完成', message: '会话关联数据仍在清理…', details: { pendingCount: 1, attempts: 2, codes: ['SESSION_EVIDENCE_JOURNAL_UNKNOWN', 'SOMETHING_ELSE'] } } } })
    const shown = adaptiveRhythmDisplay(blocked)
    expect(shown.title).toBe('Background paused · session cleanup pending')
    expect(shown.reason).toMatch(/^Data linked to a deleted conversation/)
    expect(shown.initiativeReason).toBe(shown.reason)
    expect(shown.blocker).toMatchObject({ pendingCount: 1, attempts: 2, causes: ['A background record could not be recognized; cleanup continues after it is checked', 'Session cleanup has not finished'], diagnostics: ['SESSION_EVIDENCE_JOURNAL_UNKNOWN', 'SOMETHING_ELSE'] })
    expect(shown.blocker?.codes).toBeUndefined()
    // A reason this build does not know keeps the host's own (already localized) wording.
    const other = adaptiveRhythmDisplay(project({ initiativeRuntime: { availability: { state: 'blocked', reason: 'future_gate', title: 'Waiting for X', message: 'Host text.' } } }))
    expect([other.title, other.reason]).toEqual(['Waiting for X', 'Host text.'])
  })
})

describe('learning pause reasons (F75)', () => {
  it('labels every paused(...) code of learningHealth', () => {
    const text = source(join(host, 'project-mind.mjs')), body = text.slice(text.indexOf('export function learningHealth'), text.indexOf('\n}\n', text.indexOf('export function learningHealth')))
    const codes = [...body.matchAll(/paused\('([a-z_]+)'\)/g)].map(m => m[1])
    expect(codes).toEqual(expect.arrayContaining(['emergency_stop', 'session_deletion_pending']))
    expect(codes.filter(code => !PAUSE_REASONS[code])).toEqual([])
    expect(healthLine({ learning: 'paused', reason: 'emergency_stop' }).reason).toBe('全局急停中')
  })
})

describe('reach reasons (C3)', () => {
  it('labels every reach reason the host records', () => {
    const delivery = source(join(host, 'proactive-delivery.mjs')), controller = source(join(host, 'project-initiative-controller.mjs'))
    const codes = new Set([...delivery.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map(m => m[1]))
    for (const m of controller.matchAll(/\.\.\.capped\.reasons, '([a-z_]+)'\]/g)) codes.add(m[1])
    for (const m of controller.matchAll(/recordDelivery\(/g)) { const args = callArgs(controller, m.index! + 'recordDelivery'.length); for (const r of args.matchAll(/reasons: \[([^\]]*)\]/g)) literals(r[1]).forEach(code => codes.add(code)) }
    expect([...codes]).toEqual(expect.arrayContaining(['narrator_pacing', 'jev_lowered', 'desktop_notifications_off', 'ask_in_conversation']))
    expect([...codes].filter(code => !REACH_REASONS[code])).toEqual([])
  })
  it('shows a lowered reach in words and leaves unknown codes out', () => {
    const entry = { id: 'e', actionId: 'a', kind: 'share', tier: 'inbox', requestedTier: 'inline', reachReasons: ['narrator_pacing', 'future_code'], text: 't', createdAt: '2026-10-03T00:00:00Z', status: 'unread' } as unknown as InboxEntry
    expect(entryDisplay(entry).lowered).toBe('请求对话内 · 实际安静送达 · 当时不适合打断你，先放进收件箱')
  })
})
