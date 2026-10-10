/** 工作区改动 tabs (worktree design §3.9, §7): their comparison fields, how stored and old-style tabs are read, and identity. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applySavedLayout, closeTab, openTab, resetSidePanel, sanitizeTab, saveLayout, setContext, setViewport, tabIdentity, useSidePanel, worktreeMode, worktreeSourceFields, worktreeView,
} from './side-panel-store'

beforeEach(() => {
  resetSidePanel()
  setViewport({ width: 1400, height: 900 })
  setContext({ sessionId: 's1', projectId: 'p1' })
})

const stored = (fields: Record<string, unknown>) => sanitizeTab({ id: 'w1', type: 'worktree', binding: 'workspace', ...fields })

describe('worktree tab fields', () => {
  it('reads mode, base, target and tree, and the reading choices; an unknown value takes its default', () => {
    expect(stored({ projectId: 'p1', mode: 'uncommitted', base: 'dev', target: '/w/p1-review', tree: false, grouped: true, wrap: false, numbers: 'both' }))
      .toEqual({ id: 'w1', type: 'worktree', binding: 'workspace', projectId: 'p1', mode: 'uncommitted', base: 'dev', target: '/w/p1-review', tree: false, grouped: true, wrap: false, numbers: 'both' })
    expect(stored({ mode: 'everything', base: '', target: 7, tree: 'yes', grouped: 'no', numbers: 'old' }))
      .toEqual({ id: 'w1', type: 'worktree', binding: 'workspace', projectId: null, mode: null, base: null, target: null, tree: null })
  })

  it('an old `source` becomes the comparison it stood for (and is not kept)', () => {
    // 本次任务 was the old switch's default, not a choice: the default comparison (全部改动 in a repository).
    expect(stored({ source: 'rna' })).toMatchObject({ mode: null })
    expect(stored({ source: 'rna' })).not.toHaveProperty('rnaPicked')
    expect(stored({ source: 'unstaged' })).toMatchObject({ mode: 'uncommitted', grouped: true })
    expect(stored({ source: 'staged' })).toMatchObject({ mode: 'uncommitted', grouped: true })
    expect(stored({ source: 'upstream' })).toMatchObject({ mode: 'all', base: null })
    expect(stored({ source: 'staged' })).not.toHaveProperty('source')
    expect(stored({ source: 'nonsense' })).toMatchObject({ mode: null })
    // A tab that already has a mode keeps it.
    expect(stored({ source: 'staged', mode: 'all' })).toEqual(expect.objectContaining({ mode: 'all' }))
    expect(stored({ source: 'staged', mode: 'all' })).not.toHaveProperty('grouped')
    expect(worktreeSourceFields('mystery')).toBeNull()
  })

  it('本次对话的改动 stays only as the user’s own pick: one written from the old 本次任务 default reads as the default', () => {
    // 0.62 wrote the old switch's default into `mode`: read as unset, so a repository opens on 全部改动.
    expect(stored({ mode: 'rna' })).toEqual({ id: 'w1', type: 'worktree', binding: 'workspace', projectId: null, mode: null, base: null, target: null, tree: null })
    expect(stored({ mode: 'rna', rnaPicked: 'yes' })).toMatchObject({ mode: null })
    // Picked from the comparison menu: it sticks.
    expect(stored({ mode: 'rna', rnaPicked: true })).toMatchObject({ mode: 'rna', rnaPicked: true })
    // The mark means nothing for another mode and is not kept with it.
    expect(stored({ mode: 'all', rnaPicked: true })).not.toHaveProperty('rnaPicked')
    expect(worktreeMode({ mode: 'rna' })).toBeNull()
    expect(worktreeMode({ mode: 'rna', rnaPicked: true })).toBe('rna')
    expect(worktreeMode({ mode: 'uncommitted' })).toBe('uncommitted')
    // The panel's reading of a tab: the same rule, and an old 本次任务 request gives way to the default too.
    expect(worktreeView({ mode: 'rna' })).toMatchObject({ mode: null })
    expect(worktreeView({ mode: 'rna' })).not.toHaveProperty('rnaPicked')
    expect(worktreeView({ mode: 'rna', rnaPicked: true })).toMatchObject({ mode: 'rna', rnaPicked: true })
    expect(worktreeView({ mode: 'rna', rnaPicked: true, source: 'rna' })).toEqual({ mode: null, base: null, target: null, tree: null })
  })

  it('a saved layout keeps a picked 本次对话的改动 and drops one that was not picked', () => {
    const picked = openTab({ type: 'worktree', projectId: 'p1', mode: 'rna', rnaPicked: true })
    const saved = saveLayout('记录')!
    closeTab(picked)
    expect(applySavedLayout(saved.id)).toBe(true)
    expect(Object.values(useSidePanel.getState().layout.tabs).find(row => row.type === 'worktree')).toMatchObject({ mode: 'rna', rnaPicked: true })
  })

  it('a pending source (openWorktree asking for a view) is read over the fields until the panel writes it in', () => {
    expect(worktreeView({ mode: 'all', base: 'dev', tree: true, wrap: false })).toEqual({ mode: 'all', base: 'dev', target: null, tree: true, wrap: false })
    expect(worktreeView({ mode: 'all', base: 'dev', source: 'staged' })).toEqual({ mode: 'uncommitted', base: 'dev', target: null, tree: null, grouped: true })
    expect(worktreeView({ mode: 'uncommitted', source: 'upstream', base: 'dev' })).toMatchObject({ mode: 'all', base: null })
  })

  it('stays one tab per project (or one following), whatever it compares', () => {
    expect(tabIdentity({ type: 'worktree', projectId: 'p1', mode: 'all', base: 'dev' })).toBe('worktree:p1')
    expect(tabIdentity({ type: 'worktree', projectId: null, target: '/w/other' })).toBe('worktree:follow')
  })

  it('a saved layout opens it again with its view; a panel following the current project leaves its branch behind', () => {
    const tab = openTab({ type: 'worktree', projectId: null, mode: 'uncommitted', base: 'dev', tree: false, grouped: true, numbers: 'both' })
    const saved = saveLayout('审阅')!
    closeTab(tab)
    expect(applySavedLayout(saved.id)).toBe(true)
    const [again] = Object.values(useSidePanel.getState().layout.tabs).filter(row => row.type === 'worktree')
    // The branch belonged to the project it was saved in; applied elsewhere it may not exist.
    expect(again).toMatchObject({ projectId: null, mode: 'uncommitted', base: null, target: null, tree: false, grouped: true, numbers: 'both' })
  })
})
