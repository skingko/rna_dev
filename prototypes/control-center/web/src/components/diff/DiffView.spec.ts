/** The shared diff body (worktree design §3.5): rows, numbers, wrap, change bar, cap, 展开 N 行, syntax colour, and its callers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import type { Item, Session } from '@/api/types'
import { computeDiff, patchLines, type DiffLine } from '@/lib/diff'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { createSlice } from '@/store/session-model'
import { ToolRow } from '@/components/timeline/ToolViews'
import { Review } from '@/components/side-panel/DetailTabs'
import { DiffView, type DiffViewProps } from './DiffView'
import { diffLanguage } from './language'

// The highlighter is faked: one token per line, tagged so a test can tell which text it came from.
const hl = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, cache: new Map<string, unknown>(), short: false }))
vi.mock('@/lib/highlight', async original => {
  const real = await original<typeof import('@/lib/highlight')>()
  const tokens = (code: string) => code.split('\n').map(line => (line ? [{ content: line, style: { '--shiki-light': '#123456' } }] : []))
  return {
    ...real,
    cachedTokens: (code: string, lang: string) => hl.cache.get(`${lang}\u0000${code}`),
    highlight: async (code: string, lang: string) => {
      hl.calls.push([lang, code])
      const out = hl.short ? tokens(code).slice(1) : tokens(code)
      hl.cache.set(`${lang}\u0000${code}`, out)
      return out
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => {
  act(() => root.unmount()); host.remove()
  useUi.setState({ disclosure: {} })
  hl.calls.length = 0; hl.cache.clear(); hl.short = false
})

/** Lets the highlighting the view schedules for an idle moment run (a timer where there is no requestIdleCallback). */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = async (props: DiffViewProps) => { await act(async () => { root.render(createElement(DiffView, props)) }); await settle() }
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-diff-row]')]
const cells = (row: HTMLElement) => [...row.children] as HTMLElement[]
const textCell = (row: HTMLElement) => row.lastElementChild as HTMLElement
const edit = computeDiff('a\nb\nc\n', 'a\nx\nc\n').lines // ctx a, del b, add x, ctx c

describe('rows', () => {
  it('puts added rows on green and removed rows on red, tinting the background only', async () => {
    await render({ lines: edit })
    expect(rows().map(row => row.dataset.diffRow)).toEqual(['ctx', 'del', 'add', 'ctx'])
    const [ctx, del, add] = rows()
    expect(add.className).toContain('bg-[var(--diff-add-bg)]')
    expect(del.className).toContain('bg-[var(--diff-del-bg)]')
    expect(ctx.className).not.toContain('bg-[')
    // The marker carries the colour; the text keeps the normal one on a slightly deeper tint.
    expect(cells(add)[0].textContent).toBe('+')
    expect(cells(add)[0].className).toContain('text-[var(--diff-add-fg)]')
    expect(cells(del)[0].textContent).toBe('−')
    expect(textCell(add).className).toContain('text-fg')
    expect(textCell(add).className).toContain('var(--state-success)')
    expect(textCell(add).className).not.toContain('diff-add-fg')
    expect(textCell(del).className).toContain('var(--state-danger)')
    expect(textCell(ctx).className).toContain('text-fg-2')
    expect(rows().map(row => textCell(row).textContent)).toEqual(['a', 'b', 'x', 'c'])
  })

  it('soft-wraps long lines under the text column by default; wrap={false} keeps one line and scrolls sideways', async () => {
    await render({ lines: edit })
    expect(textCell(rows()[2]).className).toContain('whitespace-pre-wrap')
    expect((host.firstElementChild as HTMLElement).className).not.toContain('overflow-x-auto')
    await render({ lines: edit, wrap: false })
    expect(textCell(rows()[2]).className).toMatch(/(^| )whitespace-pre( |$)/)
    expect((host.firstElementChild as HTMLElement).className).toContain('overflow-x-auto')
  })

  it('shows no line numbers unless asked; `new` is one column (the old number on removed rows); `both` is two', async () => {
    await render({ lines: edit })
    expect(rows().map(row => cells(row).length)).toEqual([2, 2, 2, 2])
    await render({ lines: edit, lineNumbers: 'new' })
    expect(rows().map(row => cells(row)[0].textContent)).toEqual(['1', '2', '2', '3'])
    await render({ lines: edit, lineNumbers: 'both' })
    expect(rows().map(row => [cells(row)[0].textContent, cells(row)[1].textContent])).toEqual([['1', '1'], ['2', ''], ['', '2'], ['3', '3']])
  })

  it('sizes the number columns to the longest number shown', async () => {
    await render({ lines: edit, lineNumbers: 'new' })
    expect(cells(rows()[0])[0].style.width).toBe('calc(3ch + 1rem)')
    await render({ lines: [{ type: 'add', text: 'far down', newNo: 12345 }], lineNumbers: 'new' })
    expect(cells(rows()[0])[0].style.width).toBe('calc(5ch + 1rem)')
  })

  it('draws a bar on the left of each run of changes when asked', async () => {
    await render({ lines: edit })
    expect(rows().some(row => row.className.includes('inset_3px'))).toBe(false)
    await render({ lines: edit, changeBar: true })
    const [ctx, del, add, end] = rows()
    expect(del.className).toContain('shadow-[inset_3px_0_0_var(--state-danger)]')
    expect(add.className).toContain('shadow-[inset_3px_0_0_var(--state-success)]')
    expect(ctx.className + end.className).not.toContain('inset_3px')
  })
})

describe('cap', () => {
  const twenty = computeDiff('', Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')).lines

  it('keeps today’s cap: the first rows until “… 其余 N 行” is clicked, remembered under capKey', async () => {
    await render({ lines: twenty, maxLines: 14, capKey: 'cap:x' })
    expect(rows()).toHaveLength(14)
    const more = [...host.querySelectorAll('button')].find(b => b.textContent === '… 其余 6 行')!
    await act(async () => { more.click() })
    expect(rows()).toHaveLength(20)
    expect(useUi.getState().disclosure['cap:x']).toBe(true)
  })

  it('shows everything without a capKey', async () => {
    await render({ lines: twenty, maxLines: 14 })
    expect(rows()).toHaveLength(20)
  })
})

describe('展开 N 行', () => {
  const patch = patchLines('@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10 +10 @@ fn()\n-x\n+y\n').lines

  it('offers the unchanged lines a gap hides when onExpand is given, and passes the gap’s index', async () => {
    const onExpand = vi.fn()
    await render({ lines: patch, onExpand })
    const gaps = rows().filter(row => row.dataset.diffRow === 'gap')
    // The first hunk starts at line 1: nothing is hidden, so it stays a plain gap.
    expect(gaps[0].textContent).toBe('⋯第 1 行起')
    expect(gaps[0].querySelector('button')).toBeNull()
    const button = gaps[1].querySelector('button')!
    expect(button.textContent).toBe('展开 7 行')
    expect(gaps[1].textContent).toContain('fn()')
    expect(gaps[1].className).toContain('bg-hover')
    await act(async () => { button.click() })
    expect(onExpand).toHaveBeenCalledWith(4)
    expect(patch[4]).toMatchObject({ type: 'gap', skipped: 7 }) // old lines 3-9
  })

  it('works on a comparison’s collapsed context too', async () => {
    const lines = computeDiff(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'LINE 15' : `line ${i}`)).join('\n')).lines
    const onExpand = vi.fn()
    await render({ lines, onExpand })
    const labels = [...host.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).toEqual(['展开 12 行', '展开 11 行'])
  })

  it('without onExpand every gap reads as before', async () => {
    await render({ lines: patch })
    expect(host.querySelector('button')).toBeNull()
    expect(rows().filter(row => row.dataset.diffRow === 'gap').map(row => row.textContent)).toEqual(['⋯第 1 行起', '⋯第 10 行起 · fn()'])
  })
})

describe('syntax colour', () => {
  const code = computeDiff('const a = 1\nold()\nend\n', 'const a = 1\nnew()\nend\n').lines
  const coloured = () => rows().map(row => [...textCell(row).querySelectorAll('.shiki-token')].map(span => span.textContent).join(''))

  it('highlights the old and the new side each as one text and gives every row its own line', async () => {
    await render({ lines: code, language: 'ts' })
    expect(hl.calls).toEqual([['typescript', 'const a = 1\nold()\nend'], ['typescript', 'const a = 1\nnew()\nend']])
    expect(rows().map(row => row.dataset.diffRow)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(coloured()).toEqual(['const a = 1', 'old()', 'new()', 'end'])
    // The added row still changes only its background.
    expect(rows()[2].className).toContain('bg-[var(--diff-add-bg)]')
  })

  it('paints plain rows first and colours them when the browser is idle; a view gone by then asks for nothing', async () => {
    await act(async () => { root.render(createElement(DiffView, { lines: code, language: 'ts' })) })
    expect(hl.calls).toEqual([])
    expect(host.querySelector('.shiki-token')).toBeNull()
    expect(rows().map(row => textCell(row).textContent)).toEqual(['const a = 1', 'old()', 'new()', 'end'])
    await settle()
    expect(coloured()).toEqual(['const a = 1', 'old()', 'new()', 'end'])
    hl.calls.length = 0
    // Rendered and gone in the same task: no timer can run in between (an awaited act could let it under load).
    act(() => { root.render(createElement(DiffView, { lines: computeDiff('a\n', 'b\n').lines, language: 'ts' })) })
    act(() => root.render(null))
    await settle()
    expect(hl.calls).toEqual([])
  })

  it('paints from the cache on the first frame when the text was highlighted before', async () => {
    await render({ lines: code, language: 'ts' })
    act(() => root.render(null))
    act(() => root.render(createElement(DiffView, { lines: code, language: 'typescript' })))
    expect(coloured()).toEqual(['const a = 1', 'old()', 'new()', 'end'])
    expect(hl.calls).toHaveLength(2)
  })

  it('stays plain without a known language, past 200k characters, or when the lines do not line up', async () => {
    await render({ lines: code })
    await render({ lines: code, language: 'no-such-language' })
    await render({ lines: [{ type: 'add', text: 'x'.repeat(250_000), newNo: 1 }], language: 'ts' })
    expect(hl.calls).toEqual([])
    hl.short = true
    await render({ lines: code, language: 'ts' })
    expect(hl.calls).toHaveLength(2)
    expect(host.querySelector('.shiki-token')).toBeNull()
    expect(rows().map(row => textCell(row).textContent)).toEqual(['const a = 1', 'old()', 'new()', 'end'])
  })

  it('drops a CRLF line end before highlighting and colours only the rows shown', async () => {
    const lines: DiffLine[] = [{ type: 'add', text: 'one\r', newNo: 1 }, { type: 'add', text: 'two\r', newNo: 2 }, { type: 'add', text: 'three\r', newNo: 3 }]
    await render({ lines, language: 'ts', maxLines: 2, capKey: 'cap:crlf' })
    expect(hl.calls).toEqual([['typescript', 'one\ntwo']])
    expect(coloured()).toEqual(['one', 'two'])
  })

  it('picks the language from the file name as the file preview does', () => {
    expect(diffLanguage('src/a.ts')).toBe('typescript')
    expect(diffLanguage('web/App.tsx')).toBe('tsx')
    expect(diffLanguage('正文/第001章.md')).toBe('markdown')
    expect(diffLanguage('Makefile')).toBe('makefile')
    expect(diffLanguage('notes.txt')).toBeUndefined()
    expect(diffLanguage('')).toBeUndefined()
    expect(diffLanguage(null)).toBeUndefined()
  })
})

describe('callers keep their behaviour', () => {
  const at = '2026-10-04T10:00:00.000Z'
  const editItem = (id: string, path: string, oldText: string, newText: string): Item => ({ id, turnId: 't1', kind: 'tool', text: 'project_edit', createdAt: at, tool: { name: 'project_edit', status: 'succeeded', args: { path, oldText, newText } } })
  const session = (items: Item[]): Session => ({ id: 's1', title: 't', status: 'idle', projectId: 'p1', items, turns: [{ id: 't1', status: 'completed', userItemId: 'u1', createdAt: at }], revision: 1 })
  afterEach(() => { useApp.setState({ sessions: {} }) })

  it('the timeline diff card: 14 rows, then “… 其余 N 行”, long lines wrapped, coloured by the file’s language', async () => {
    const after = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i}\n`).join('')
    useApp.setState({ sessions: { s1: createSlice(session([editItem('e1', 'src/a.ts', 'const v0 = 0\n', after)])) } })
    useUi.setState({ disclosure: { 'diff:e1': true } })
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(ToolRow, { sessionId: 's1', itemId: 'e1' }))) })
    await settle()
    expect(rows()).toHaveLength(14)
    expect(rows().every(row => cells(row).length === 2)).toBe(true)
    expect(textCell(rows()[1]).className).toContain('whitespace-pre-wrap') // long Chinese paragraphs read without sideways scrolling
    expect(host.textContent).toContain('… 其余 6 行')
    expect(hl.calls.map(([lang]) => lang)).toContain('typescript')
  })

  it('the review tab: one number column, long lines wrapped, coloured by the file’s language', async () => {
    useApp.setState({ sessions: { s1: createSlice(session([editItem('e1', 'src/a.ts', 'let a = 1\n', 'let a = 2\n')])) } })
    await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(Review, { sessionId: 's1', itemIds: ['e1'] }))) })
    await settle()
    expect(rows().map(row => row.dataset.diffRow)).toEqual(['del', 'add'])
    expect(rows().map(row => cells(row)[0].textContent)).toEqual(['1', '1'])
    expect(textCell(rows()[0]).className).toContain('whitespace-pre-wrap')
    expect(hl.calls).toEqual([['typescript', 'let a = 1'], ['typescript', 'let a = 2']])
  })
})
