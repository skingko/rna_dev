import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BuiltinAgentLimits, CapabilityCatalog } from '@/api/panels-types'
import { usePreferences } from '@/components/settings/preferences'
import { handlePanels } from '@/mock/panels'
import { AgentLimits } from './CapabilitiesDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Design 2026-10-04 §9.3: the helper limits read as the host enforces them (steps by role, concurrency per
// conversation under a ceiling for all conversations, a per-turn guard).
const scout: BuiltinAgentLimits = { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 24, finalSummarySteps: 1 }
let root: Root | null = null, host: HTMLElement | null = null

function render(limits: BuiltinAgentLimits): string {
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(createElement(AgentLimits, { limits })))
  return host.textContent ?? ''
}

afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null
  usePreferences.setState({ language: 'zh' })
})

describe('AgentLimits', () => {
  it('names the steps, the per-conversation and overall concurrency and the per-turn guard', () => {
    usePreferences.setState({ language: 'zh' })
    expect(render(scout)).toBe('最多 1 层协作 · 每次 24 步与 1 次收束 · 每个对话同时 4 个，所有对话合计 6 个 · 每轮最多 12 次')
  })

  it('reads in English in the English interface', () => {
    usePreferences.setState({ language: 'en' })
    expect(render({ ...scout, steps: 32 })).toBe('Up to 1 level of collaboration · 32 steps and 1 wrap-up each · 4 at a time per conversation, 6 across all conversations · up to 12 per turn')
  })

  it('leaves out the overall ceiling when an older host does not report it', () => {
    usePreferences.setState({ language: 'zh' })
    const { concurrentTotal: _omitted, ...older } = scout
    expect(render(older)).toBe('最多 1 层协作 · 每次 24 步与 1 次收束 · 每个对话同时 4 个 · 每轮最多 12 次')
  })

  it('the mock catalog carries the current limits', async () => {
    const catalog = await handlePanels({ sessions: () => [], emitIndex: () => {} }, 'GET', new URL('http://mock/api/projects/p1/capabilities'), {}) as CapabilityCatalog
    expect(catalog.builtinAgents?.map(agent => agent.limits)).toEqual([scout, { ...scout, steps: 32 }])
  })
})
