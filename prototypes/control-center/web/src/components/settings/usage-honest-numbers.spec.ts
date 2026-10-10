import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { MotionGlobalConfig } from 'motion/react'
import type { CacheStats, CacheUsage, UsageRun } from '@/api/types'
import { getTransport, setTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { usePreferences } from './preferences'
import UsageSection from './sections/UsageSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
MotionGlobalConfig.skipAnimations = true
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

/** Render the usage section on a canned /api/v2/usage/cache answer; the rendered text of the whole section. */
async function page(usage: CacheUsage, language: 'zh' | 'en' = 'zh') {
  const original = getTransport(), before = usePreferences.getState().language
  usePreferences.setState({ language })
  setTransport({ ...original, kind: 'mock', request: async (path: string) => { if (path.startsWith('/api/v2/usage/cache')) return usage; throw new ApiError('offline', 503) } } as Transport)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(UsageSection, { projectId: null, setProjectId: () => {}, registerBusy: () => {}, registerDirty: () => {}, requestClose: () => true }))) })
    await flush()
    return { text: host.textContent ?? '', rows: [...host.querySelectorAll('tr')].map(row => row.textContent ?? '') }
  } finally { act(() => root.unmount()); host.remove(); setTransport(original); usePreferences.setState({ language: before }) }
}

// The 24h window of the 2026-10-05 report, from the ledger copy (token-burn study): 8.57M tokens, 78% of them cache reads.
// The page shows tokens only: the backend does not track real prices (user decision 2026-10-05), so no cost, list-price estimate or price-weighted number.
const stats = (input: number, cacheRead: number, output: number, requests: number): CacheStats => ({ requests, input, cacheRead, cacheWrite: 0, output, hitRate: cacheRead / (input + cacheRead), coverage: 1, coldStarts: 0, unreported: 0 })
const overall = stats(1_688_243, 6_702_400, 217_554, 95)
const dailyRun: UsageRun = { sessionId: 'schedule-work-af55b64d', purpose: 'background-work', projectId: 'p1', projectName: '长篇小说', kind: 'scheduled', scheduleId: 'sch1', title: '每日调研', requests: 44, tokens: 4_445_847, input: 183_000, cacheRead: 4_246_592, cacheWrite: 0, output: 16_255, firstAt: '2026-10-05T01:00:00.000Z', lastAt: '2026-10-05T01:40:00.000Z' }
const fetchRun: UsageRun = { sessionId: 'e0b4447f', purpose: 'background-work', projectId: 'p1', projectName: '长篇小说', kind: 'job', title: 'Fetch the missing section', requests: 17, tokens: 1_653_468, input: 187_000, cacheRead: 1_465_664, cacheWrite: 0, output: 800, firstAt: '2026-10-05T05:41:00.000Z', lastAt: '2026-10-05T05:55:00.000Z' }
const usage = (extra: Partial<CacheUsage> = {}): CacheUsage => ({
  window: '24h', overall, byPurpose: { 'background-work': stats(298_008, 5_767_552, 116_444, 63), initiative: stats(495_337, 233_856, 67_038, 18) },
  judge: { requests: 5561, input: 11_736_229, output: 829_768, product: { requests: 77, input: 216_003, output: 7859 }, probe: { requests: 5484, input: 11_520_226, output: 821_909 } },
  runs: [dailyRun, fetchRun], ...extra,
})
// Words that would claim a cost, a price or a weighting of tokens by price.
const COST_WORDS_ZH = /相对成本|假设权重|公开价格比|单位|花费|费用|公开价|未定价/
const COST_WORDS_EN = /relative cost|assumed weights|list[- ]price|\bunits?\b|\bspend\b|\bcost\b|unpriced/i

describe('usage page: honest numbers (token-burn study Z1/Z2), without cost', () => {
  it('shows cache reads apart from fresh tokens, the largest runs by tokens and the product / probe split, in Chinese', async () => {
    const { text, rows } = await page(usage())
    // 8.6M tokens, of which 1.9M freshly processed and 6.7M cache reads (78%): said in the section note and under the cache tiles.
    expect(text).toContain('tokens 含缓存读取（重复读到的已缓存前缀），不都是新处理的输入')
    expect(text).toContain('tokens 8.6M = 新处理 1.9M + 缓存读取 6.7M（缓存读取占 78%）。缓存读取是重复读到的已缓存前缀，不是新处理的输入。')
    expect(text).toContain('最大的运行'); expect(text).toContain('按 tokens 排序的前 2 个会话')
    // The 09:00 run first, named by its schedule, with fresh tokens and cache reads apart and its tokens.
    const runRows = rows.filter(row => row.includes('每日调研') || row.includes('Fetch the missing section'))
    expect(runRows).toHaveLength(2); expect(runRows[0]).toContain('每日调研'); expect(runRows[0]).toContain('定时任务 · 长篇小说'); expect(runRows[0]).toContain('44'); expect(runRows[0]).toContain('199k / 4.2M'); expect(runRows[0]).toMatch(/4\.4M$/)
    expect(runRows[1]).toContain('后台工作 · 长篇小说'); expect(runRows[1]).toContain('188k / 1.5M'); expect(runRows[1]).toMatch(/1\.7M$/)
    expect(rows.find(row => row.startsWith('运行'))).toContain('合计 tokens')
    expect(text).toContain('这些运行合计 6.1M，占本时间范围 tokens 的 71%')
    expect(text).toContain('JEV 判断：产品判断 77 次（输入 216k · 输出 7.9k）· 探针 5484 次（输入 12M · 输出 822k）')
    expect(text).not.toContain('JEV 判断 5561 次')
    expect(text).not.toContain('相对成本'); expect(text).not.toContain('假设权重'); expect(text).not.toContain('公开价格比'); expect(text).not.toContain('单位')
  })

  it('says the same in English', async () => {
    const { text, rows } = await page(usage(), 'en')
    expect(text).toContain('Tokens include cache reads (a cached prefix read again)')
    expect(text).toContain('Tokens 8.6M = freshly processed 1.9M + cache reads 6.7M (cache reads are 78%).'); expect(text).toContain('Largest runs')
    const run = rows.find(row => row.includes('每日调研'))
    expect(run).toContain('Scheduled task · 长篇小说'); expect(run).toContain('199k / 4.2M'); expect(run).toMatch(/4\.4M$/)
    expect(rows.find(row => row.startsWith('Run'))).toContain('Total tokens')
    expect(text).toContain('The 2 sessions with the most tokens')
    expect(text).toContain('JEV judgments: product 77 (input 216k · output 7.9k) · probe 5484 (input 12M · output 822k)')
    expect(text).toContain('These runs add up to 6.1M, 71% of the tokens in this range.')
    expect(text).not.toMatch(/[一-鿿]{3}.*(缓存读取|最大的运行)/)
    expect(text).not.toMatch(COST_WORDS_EN)
  })

  it('shows no cost block even from a daemon that still sends the old relative-cost or list-price cost fields', async () => {
    const listPrice = { status: 'priced', amounts: { USD: 0.00271 }, pricedRequests: 3, partialRequests: 0, unpricedRequests: 0 }
    const stale = { ...usage({ overall: { ...overall, cost: listPrice, estimated: { requests: 1, input: 10000, output: 300, cost: listPrice }, misses: { count: 1, tokens: 9500, cost: { USD: 0.00855 }, byReason: { idle: { count: 1, tokens: 9500, cost: { USD: 0.00855 } } } } } as CacheStats, keepAlive: { requests: 2, input: 0, cacheRead: 20_000, cacheWrite: 0, cost: listPrice } as CacheUsage['keepAlive'], judge: { requests: 1, input: 10, output: 1, cost: listPrice } as CacheUsage['judge'] }), relative: { unit: 'uncached_input_token', weights: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 4.5 }, total: { units: 3_337_476, assumedUnits: 3_337_476 }, byPurpose: { 'background-work': { units: 1_398_761, assumedUnits: 1_398_761 } } }, runs: [{ ...dailyRun, relative: { units: 810_422.2, assumedUnits: 810_422.2 } }] } as unknown as CacheUsage
    for (const language of ['zh', 'en'] as const) {
      const { text, rows } = await page(stale, language)
      expect(text).not.toMatch(language === 'zh' ? COST_WORDS_ZH : COST_WORDS_EN)
      expect(text).not.toContain('3.3M'); expect(text).not.toContain('810k'); expect(text).not.toContain('0.0027'); expect(text).not.toContain('$')
      expect(rows.find(row => row.includes('每日调研'))).toMatch(/4\.4M$/)
    }
  })

  it('shows the idle keep-alive pings as requests and cache reads only', async () => {
    const keepAlive = { requests: 2, input: 0, cacheRead: 20_000, cacheWrite: 0 }
    expect((await page(usage({ keepAlive }))).text).toContain('空闲时保持缓存 2 次 · 缓存读取 20k（不是对话请求，不计入以上缓存统计）')
    expect((await page(usage({ keepAlive }), 'en')).text).toContain('Idle cache keep-alive 2 times · cache read 20k (not conversation requests; not part of the cache metrics above)')
  })

  it('shows no run table for a daemon that does not send runs, keeps the old JEV line, and still splits the tokens it does send', async () => {
    const { text } = await page({ window: '24h', overall, byPurpose: {}, judge: { requests: 5561, input: 11_736_229, output: 829_768 } })
    expect(text).not.toContain('最大的运行')
    expect(text).toContain('JEV 判断 5561 次'); expect(text).not.toContain('产品判断')
    expect(text).toContain('tokens 8.6M = 新处理 1.9M + 缓存读取 6.7M'); expect(text).not.toMatch(COST_WORDS_ZH)
  })

  it('says nothing about a split for a window without requests, and shows no run table when no session ran', async () => {
    const empty = usage({ overall: { ...overall, requests: 0, input: 0, cacheRead: 0, output: 0 }, byPurpose: {}, runs: [] })
    const { text } = await page(empty)
    expect(text).not.toContain('tokens 含缓存读取'); expect(text).not.toContain('缓存读取占'); expect(text).not.toContain('最大的运行')
    const noRuns = (await page(usage({ runs: [] }))).text
    expect(noRuns).toContain('缓存读取占 78%'); expect(noRuns).not.toContain('最大的运行')
  })

  it('names a run without a title by its purpose, and survives missing optional fields', async () => {
    const bare: UsageRun = { ...fetchRun, sessionId: 'x', title: undefined, kind: undefined, projectName: undefined, projectId: undefined, purpose: 'foreground' }
    const { rows } = await page(usage({ runs: [bare] }))
    expect(rows.some(row => row.startsWith('前台对话') && row.includes('188k / 1.5M') && row.endsWith('1.7M'))).toBe(true)
  })
})
