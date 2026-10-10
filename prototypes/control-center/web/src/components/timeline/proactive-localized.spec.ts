/** F10: proactive rows render from the host's structured fields in the interface language; older rows keep showing their stored text. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Item } from '@/api/types'
import { useApp } from '@/store/app-store'
import { usePreferences } from '@/components/settings/preferences'
import { DigestCard, ThreadCloseRow } from './Messages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-09T08:00:00.000Z'
const close = (text: string, initiative: NonNullable<Item['initiative']> = { kind: 'thread_close', reach: 'inline', threadId: 'th-1' }): Item =>
  ({ id: 'tc', turnId: null, kind: 'assistant', source: 'initiative', text, createdAt: at, initiative })
const digest = (text: string, initiative: NonNullable<Item['initiative']>): Item =>
  ({ id: 'dg', turnId: null, kind: 'assistant', source: 'initiative', text, createdAt: at, initiative: { kind: 'digest', reach: 'digest', ...initiative } })

let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => {
  act(() => root.unmount()); host.remove()
  useApp.setState({ sessionIndex: {} }); usePreferences.setState({ language: 'zh' })
})

const closeLine = (item: Item) => {
  act(() => { root.render(createElement(ThreadCloseRow, { item, thread: null })) })
  return host.querySelector('span.line-clamp-2')?.textContent
}
const digestRows = (item: Item) => {
  act(() => { root.render(createElement(DigestCard, { sessionId: 's1', item })) })
  return [...host.querySelectorAll('ol > li')].map(li => li.lastElementChild?.textContent)
}

describe('thread close row', () => {
  const structured = (patch: Partial<NonNullable<Item['initiative']>> = {}) => close('「旧文本」已完成。', { kind: 'thread_close', reach: 'inline', threadId: 'th-1', title: '工具行规范', resolution: '规范文档与实现一致', status: 'done', ...patch })

  it('writes the sentence from the fields in Chinese', () => {
    expect(closeLine(structured())).toBe('「工具行规范」已完成：规范文档与实现一致')
    expect(closeLine(structured({ resolution: null }))).toBe('「工具行规范」已完成。')
    expect(closeLine(structured({ resolution: '  ', status: 'resolved' }))).toBe('「工具行规范」已完成。')
  })

  it('writes it in English even when the stored text is Chinese', () => {
    usePreferences.setState({ language: 'en' })
    expect(closeLine(structured())).toBe('"工具行规范" is done: 规范文档与实现一致')
    expect(closeLine(structured({ title: 'Tool row spec', resolution: 'The doc matches the code.' }))).toBe('"Tool row spec" is done: The doc matches the code.')
    expect(closeLine(structured({ title: 'Tool row spec', resolution: null }))).toBe('"Tool row spec" is done.')
  })

  it('follows the interface language when it changes', () => {
    const item = structured({ title: 'Tool row spec', resolution: 'Matches.' })
    expect(closeLine(item)).toBe('「Tool row spec」已完成：Matches.')
    usePreferences.setState({ language: 'en' })
    expect(closeLine(item)).toBe('"Tool row spec" is done: Matches.')
  })

  it('keeps showing the stored text of an older row, without the fields', () => {
    expect(closeLine(close('「工具行规范」已完成：规范文档与实现一致。'))).toBe('「工具行规范」已完成：规范文档与实现一致。')
    usePreferences.setState({ language: 'en' })
    expect(closeLine(close('"Tool row spec" is done.'))).toBe('"Tool row spec" is done.')
    // A malformed title does not blank the row.
    expect(closeLine(close('「X」已完成。', { kind: 'thread_close', reach: 'inline', title: 7 as unknown as string }))).toBe('「X」已完成。')
    expect(closeLine(close('「X」已完成。', { kind: 'thread_close', reach: 'inline', title: ' ' }))).toBe('「X」已完成。')
  })

  it('does not read a placeholder in the title or resolution as a template', () => {
    expect(closeLine(structured({ title: '{resolution}', resolution: '{title}' }))).toBe('「{resolution}」已完成：{title}')
  })
})

describe('digest card', () => {
  it('lists the structured lines, whatever the stored text says', () => {
    const rows = digestRows(digest('今日摘要（2 条）：\n1. 旧一。\n2. 旧二。', { entryIds: ['a', 'b'], lines: ['甲。', '乙。'] }))
    expect(rows).toEqual(['甲。', '乙。'])
    expect(host.textContent).toContain('2 条发现')
  })

  it('lists the lines of an English digest row', () => {
    usePreferences.setState({ language: 'en' })
    const rows = digestRows(digest("Today's digest (2 items):\n1. First.\n2. Second.", { entryIds: ['a', 'b'], lines: ['First.', 'Second.'] }))
    expect(rows).toEqual(['First.', 'Second.'])
    expect(host.textContent).toContain('2 findings')
  })

  it('parses the stored text of an older row, in either header language', () => {
    expect(digestRows(digest('今日摘要（2 条）：\n1. 甲。\n2. 乙。', { entryIds: ['a', 'b'] }))).toEqual(['甲。', '乙。'])
    expect(digestRows(digest("Today's digest (2 items):\n1. First.\n2. Second.", { entryIds: ['a', 'b'] }))).toEqual(['First.', 'Second.'])
  })
})
