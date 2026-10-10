import { describe, expect, it } from 'vitest'
import { groupIds } from './tree'
import { canStepBack, canStepForward, EMPTY_HISTORY, push, record, recordedOps, Sequencer, stepBack, stepForward, type History } from './sequence'
import { activateTab, closeTab, moveTab, openTab } from './actions'
import { A, startLayout, tab, testPolicy, type TestTab } from './testing'

describe('undo history', () => {
  it('records intents as entries and steps back and forward exactly', () => {
    const start = startLayout()
    const group = groupIds(start)[0]
    let history: History<TestTab> = EMPTY_HISTORY
    let state = start
    ;({ history, state } = record(history, state, [{ type: 'openTab', groupId: group, tab: tab('a'), index: 0, scope: 's:A' }]))
    const afterA = state
    ;({ history, state } = record(history, state, [
      { type: 'openTab', groupId: group, tab: tab('b'), index: 1, scope: 's:A' },
      { type: 'setCollapsed', collapsed: true },
    ]))
    const afterB = state
    expect(history.entries).toHaveLength(2)
    expect(recordedOps(history)).toHaveLength(3)
    let back = stepBack(history, state)!
    expect(back.state).toEqual(afterA)
    back = stepBack(back.history, back.state)!
    expect(back.state).toEqual(start)
    expect(canStepBack(back.history)).toBe(false)
    expect(stepBack(back.history, back.state)).toBeUndefined()
    const forward = stepForward(stepForward(back.history, back.state)!.history, afterA)!
    expect(forward.state).toEqual(afterB)
    expect(canStepForward(forward.history)).toBe(false)
  })

  it('folds a run of focus-only entries into one step, and a new entry drops the redo branch', () => {
    const policy = testPolicy()
    const seq = new Sequencer(startLayout())
    seq.commit(openTab(seq.state, tab('a'), 'auto', A, policy))
    seq.commit(openTab(seq.state, tab('b'), 'auto', A, policy))
    const opened = seq.state
    seq.commit(activateTab(seq.state, 'a', A))
    seq.commit(activateTab(seq.state, 'b', A))
    seq.commit(activateTab(seq.state, 'a', A))
    expect(seq.undo()).toBe(true)
    expect(seq.state).toEqual(opened)
    expect(seq.redo()).toBe(true)
    expect(seq.undo()).toBe(true)
    seq.commit(closeTab(seq.state, 'b', A, policy))
    expect(seq.canRedo).toBe(false)
    expect(seq.redo()).toBe(false)
    while (seq.undo());
    expect(seq.state).toEqual(startLayout())
  })

  it('⌘⇧T style: undoing a close brings the tab back where it was', () => {
    const policy = testPolicy()
    const seq = new Sequencer(startLayout())
    for (const id of ['a', 'b', 'c']) seq.commit(openTab(seq.state, tab(id), 'auto', A, policy))
    const before = seq.state
    seq.commit(closeTab(seq.state, 'b', A, policy))
    seq.commit(moveTab(seq.state, 'c', { edge: 'right', of: groupIds(seq.state)[0] }, A, policy))
    seq.undo()
    seq.undo()
    expect(seq.state).toEqual(before)
  })

  it('ignores empty changes and keeps only the newest entries past the limit', () => {
    let history: History<TestTab> = EMPTY_HISTORY
    expect(push(history, { ops: [], inverse: [] })).toBe(history)
    for (let i = 0; i < 5; i++) history = push(history, { ops: [{ type: 'setCollapsed', collapsed: i % 2 === 0 }], inverse: [] }, 3)
    expect(history.entries).toHaveLength(3)
    expect(history.cursor).toBe(3)
    const seq = new Sequencer(startLayout(), 2)
    const policy = testPolicy()
    for (const id of ['a', 'b', 'c']) seq.commit(openTab(seq.state, tab(id), 'auto', A, policy))
    expect(seq.history.entries).toHaveLength(2)
    expect(seq.ops).toHaveLength(2)
  })

  it('a failing op records nothing', () => {
    const seq = new Sequencer(startLayout())
    expect(() => seq.dispatch({ type: 'closeTab', tabId: 'nope' })).toThrow()
    expect(seq.canUndo).toBe(false)
    expect(seq.state).toEqual(startLayout())
  })
})
