/** The 工作区改动 file tree (worktree design §3.4): rows, counts, marks, the keyboard and the row in view. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GitCompareFile } from '@/api/git-api'
import { ChangeTree, fileIcon, type ChangeTreeProps } from './ChangeTree'
import { buildTree, groupedTree, groupFileKey, treeRows, type StackGroup } from './compare-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILES: GitCompareFile[] = [
  { path: '.agents/skills/design/SKILL.md', status: '?', added: 1206, removed: 0, untracked: true },
  { path: 'site/app/api/search/route.ts', status: 'A', added: 4, removed: 0 },
  { path: 'site/app/old.tsx', status: 'D', added: 0, removed: 21 },
  { path: 'site/app/next.tsx', oldPath: 'site/app/prev.tsx', status: 'R', added: 2, removed: 1 },
  { path: 'site/logo.png', status: 'M', added: null, removed: null, binary: true },
  { path: 'vendor/lib/', status: '?', added: null, removed: null, untracked: true },
]
const root = buildTree(FILES)

let host: HTMLDivElement, view: Root
let collapsed = new Set<string>(), picks: string[] = [], toggles: string[] = []
const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 })
  host = document.createElement('div'); document.body.append(host); view = createRoot(host)
  collapsed = new Set(); picks = []; toggles = []
})
afterEach(() => { act(() => view.unmount()); host.remove(); if (saved) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved); vi.restoreAllMocks() })

const draw = async (props: Partial<ChangeTreeProps> = {}) => {
  const rows = treeRows(root, collapsed)
  await act(async () => {
    view.render(createElement(ChangeTree, {
      rows, active: null, collapsed, onPick: path => { picks.push(path) },
      onToggleFolder: path => { toggles.push(path); collapsed = new Set(collapsed); if (!collapsed.delete(path)) collapsed.add(path); void draw(props) },
      ...props,
    }))
  })
}
const tree = () => host.querySelector<HTMLElement>('[data-change-tree]')!
const row = (path: string) => host.querySelector<HTMLElement>(`[data-tree-row="${path}"]`)
const press = async (key: string) => { await act(async () => { tree().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }) }
const cursor = () => host.querySelector('[data-cursor]')?.getAttribute('data-tree-row')

describe('ChangeTree', () => {
  it('draws folders (chains in one row) and files 14 px a level, with +N −M, 二进制, 仓库, a struck-out deletion and a move on hover', async () => {
    await draw()
    const rows = [...host.querySelectorAll<HTMLElement>('[role=treeitem]')]
    expect(rows.map(el => [el.dataset.treeKind, el.textContent?.replace(/\s+/g, ' ').trim(), el.getAttribute('aria-level'), el.style.paddingLeft])).toEqual([
      ['folder', '.agents/skills/design', '1', '4px'],
      ['file', 'SKILL.md+1206−0', '2', '18px'],
      ['folder', 'site', '1', '4px'],
      ['folder', 'app', '2', '18px'],
      ['folder', 'api/search', '3', '32px'],
      ['file', 'route.ts+4−0', '4', '46px'],
      ['file', 'next.tsx+2−1', '3', '32px'],
      ['file', 'old.tsx+0−21已删除', '3', '32px'],
      ['file', 'logo.png二进制', '2', '18px'],
      ['folder', 'vendor', '1', '4px'],
      ['file', 'lib/仓库', '2', '18px'],
    ])
    expect(row('site/app/next.tsx')!.title).toBe('site/app/prev.tsx → site/app/next.tsx')
    expect(row('site/app/old.tsx')!.querySelector('.line-through')?.textContent).toBe('old.tsx')
    expect(row('site/app')!.getAttribute('aria-expanded')).toBe('true')
    expect(fileIcon('a.tsx').displayName ?? fileIcon('a.tsx').name).not.toBe(fileIcon('a.md').displayName ?? fileIcon('a.md').name)
  })

  it('marks the file in view and starts the keyboard there; a click picks a file or folds a folder', async () => {
    await draw({ active: 'site/app/api/search/route.ts' })
    expect(row('site/app/api/search/route.ts')!.getAttribute('aria-selected')).toBe('true')
    expect(cursor()).toBe('site/app/api/search/route.ts')
    expect(tree().getAttribute('aria-activedescendant')).toBe(row('site/app/api/search/route.ts')!.id)
    await act(async () => { row('site/logo.png')!.click() })
    expect(picks).toEqual(['site/logo.png'])
    await act(async () => { row('site')!.click() })
    expect(toggles).toEqual(['site'])
    expect(row('site/app')).toBeNull()
  })

  it('↑/↓/Home/End move; → opens a folder or steps in; ← folds it or goes to its folder; Enter and Space act', async () => {
    collapsed = new Set(['site'])
    await draw()
    expect(cursor()).toBe('.agents/skills/design')
    await press('ArrowDown'); await press('ArrowDown')
    expect(cursor()).toBe('site')
    await press('ArrowRight') // opens
    expect(toggles).toEqual(['site'])
    expect(row('site/app')).not.toBeNull()
    await press('ArrowRight') // steps in
    expect(cursor()).toBe('site/app')
    await press('ArrowDown'); await press('ArrowDown')
    expect(cursor()).toBe('site/app/api/search/route.ts')
    await press('Enter')
    expect(picks).toEqual(['site/app/api/search/route.ts'])
    await press('ArrowLeft') // to its folder
    expect(cursor()).toBe('site/app/api/search')
    await press('ArrowLeft') // folds it
    expect(toggles.at(-1)).toBe('site/app/api/search')
    await press('End')
    expect(cursor()).toBe('vendor/lib/')
    await press(' ')
    expect(picks.at(-1)).toBe('vendor/lib/')
    await press('Home')
    expect(cursor()).toBe('.agents/skills/design')
    await press(' ')
    expect(toggles.at(-1)).toBe('.agents/skills/design')
  })

  it('本次对话的改动: a row per turn or run (本轮, its file count) folding its files, which sit one level in, keyed per group', async () => {
    const group = (key: string, kind: 'turn' | 'change', paths: string[], extra: Partial<StackGroup> = {}): StackGroup => ({
      key, kind, label: kind === 'turn' ? '改一下登录页' : '整理测试报告', files: paths.map(path => ({ key: groupFileKey(key, path), group: key, path, status: 'M', added: 1, removed: 0 })), ...extra,
    })
    const model = groupedTree([group('turn:t2', 'turn', ['src/a.ts', 'src/b.ts'], { tag: '本轮' }), group('change:bg-1', 'change', ['README.md'], { muted: true })])
    const redraw = async () => {
      await act(async () => {
        view.render(createElement(ChangeTree, {
          rows: model.rows(collapsed), active: 'turn:t2:src/b.ts', collapsed, onPick: path => { picks.push(path) },
          onToggleFolder: path => { toggles.push(path); collapsed = new Set(collapsed); if (!collapsed.delete(path)) collapsed.add(path); void redraw() },
        }))
      })
    }
    await redraw()
    const rows = [...host.querySelectorAll<HTMLElement>('[role=treeitem]')]
    expect(rows.map(el => [el.dataset.treeKind, el.dataset.treeRow, el.getAttribute('aria-level')])).toEqual([
      ['group', 'turn:t2', '1'], ['folder', 'turn:t2:src', '2'], ['file', 'turn:t2:src/a.ts', '3'], ['file', 'turn:t2:src/b.ts', '3'],
      ['group', 'change:bg-1', '1'], ['file', 'change:bg-1:README.md', '2'],
    ])
    expect(row('turn:t2')?.textContent).toBe('改一下登录页本轮2')
    expect(row('change:bg-1')?.className).toContain('text-fg-4')
    // A file names its own path on hover; a folder its folder.
    expect(row('turn:t2:src/a.ts')?.title).toBe('src/a.ts')
    expect(row('turn:t2:src')?.title).toBe('src')
    expect(row('turn:t2:src/b.ts')?.hasAttribute('data-active')).toBe(true)
    // ← from a group's top-level file goes to the group; ← there folds it; a click opens it again.
    await act(async () => { row('change:bg-1:README.md')!.click() })
    expect(picks).toEqual(['change:bg-1:README.md'])
    await press('ArrowLeft')
    expect(cursor()).toBe('change:bg-1')
    await press('ArrowLeft')
    expect(toggles).toEqual(['change:bg-1'])
    expect(row('change:bg-1:README.md')).toBeNull()
    expect(row('change:bg-1')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { row('change:bg-1')!.click() })
    expect(row('change:bg-1:README.md')).not.toBeNull()
  })
})
