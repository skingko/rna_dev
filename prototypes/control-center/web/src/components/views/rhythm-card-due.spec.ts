/**
 * The rhythm card's 项目交付 line when a schedule comes due with nothing else changing. The index row carries the
 * schedule's next run (an anchor) and no clock value (protocol 3), so no index event arrives at the due instant: the
 * card re-renders on its own when the anchor passes.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as schema from '../../../../index-schema.mjs'
import type { ProjectDetail } from '@/api/project-api'
import { usePreferences } from '@/components/settings/preferences'
import { RhythmCard } from './RhythmCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIN = 60_000, START = Date.parse('2026-10-05T01:00:00Z'), DUE = START + 10 * MIN
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers({ now: START })
  usePreferences.setState({ language: 'zh' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const project = () => ({
  id: 'p', name: '晨报', rhythm: { control: 'auto' }, initiative: { enabled: false }, evolution: { enabled: false },
  schedules: [{ id: 'daily', title: '晨报', enabled: true, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: null, nextRunAt: new Date(DUE).toISOString() }],
  // As the host sent it at START: the row's schedule line holds the anchor only.
  rhythmStatus: schema.rhythmStatusRow({ control: 'auto', lifecycle: 'recurring', assessmentRequired: false, effective: { initiativeEnabled: false, evolutionEnabled: false },
    schedule: { activeCount: 1, dueCount: 0, nextAt: DUE }, initiative: { eligible: false, reason: 'user_disabled', nextAt: null, state: 'disabled' }, evolution: { eligible: false, reason: 'user_disabled', nextAt: null, state: 'disabled' }, assessment: null, history: [] }),
}) as unknown as ProjectDetail

it('says the schedule is due once its next run passes, without a new row', async () => {
  const same = project()
  await act(async () => { root.render(createElement(RhythmCard, { project: same })) })
  expect(host.textContent).toContain('下次任务')
  expect(host.textContent).not.toContain('项日程到期')
  await act(async () => { vi.advanceTimersByTime(DUE - START + MIN) })
  expect(host.textContent).toContain('1 项日程到期，等待执行或投递')
  expect(host.textContent).not.toContain('下次任务')
})
