/**
 * Linear undo history over `applyOp`. Recording is grouped by intent: the ops
 * one gesture or command produced form one entry, and a run of consecutive
 * focus-only entries undoes and redoes as one step. Undo applies the inverses
 * captured when the ops ran, redo re-applies the ops, so both directions are
 * exact. A new entry after an undo drops the redo branch.
 *
 * Ported from DeepSeek dockkit `ui-dockkit/src/engine/sequence.ts` (MIT,
 * Copyright (c) 2026 DeepSeek; see LICENSE-dockkit.md). Added: `push` for
 * changes an action already applied, and a length limit.
 */
import type { DockTab, FocusOpType, LayoutOp, LayoutState } from './types'
import { applyOp, applyOps } from './operations'

export interface HistoryEntry<T extends DockTab = DockTab> {
  ops: LayoutOp<T>[]
  /** Already ordered for application: the last op's inverse comes first. */
  inverse: LayoutOp<T>[]
}

/** Plain data, safe to keep in a store. */
export interface History<T extends DockTab = DockTab> {
  entries: HistoryEntry<T>[]
  /** How many entries are applied; entries beyond it are the redo branch. */
  cursor: number
}

export interface HistoryStep<T extends DockTab = DockTab> {
  history: History<T>
  state: LayoutState<T>
}

export const EMPTY_HISTORY: History<never> = { entries: [], cursor: 0 }
export const HISTORY_LIMIT = 200

const FOCUS_OPS = new Set<string>(['focusTab', 'focusGroup', 'setActive', 'restoreFocus'] satisfies FocusOpType[])

export const isFocusOp = (op: LayoutOp<DockTab>) => FOCUS_OPS.has(op.type)

const isFocusEntry = <T extends DockTab>(history: History<T>, index: number) => {
  const entry = history.entries[index]
  return entry !== undefined && entry.ops.every(isFocusOp)
}

export const canStepBack = <T extends DockTab>(history: History<T>) => history.cursor > 0
export const canStepForward = <T extends DockTab>(history: History<T>) => history.cursor < history.entries.length
export const recordedOps = <T extends DockTab>(history: History<T>): LayoutOp<T>[] => history.entries.flatMap(entry => entry.ops)

/** Append an already-applied intent, dropping any redo branch and the oldest entries past `limit`. */
export function push<T extends DockTab>(history: History<T>, entry: HistoryEntry<T>, limit = HISTORY_LIMIT): History<T> {
  if (!entry.ops.length) return history
  const kept = history.entries.slice(0, history.cursor)
  const entries = [...kept, { ops: entry.ops, inverse: entry.inverse }].slice(-limit)
  return { entries, cursor: entries.length }
}

/**
 * Apply one intent's ops and record them as one entry.
 * @throws when an op is invalid against the state it reaches; nothing is recorded.
 */
export function record<T extends DockTab>(history: History<T>, state: LayoutState<T>, ops: LayoutOp<T>[], limit = HISTORY_LIMIT): HistoryStep<T> {
  if (!ops.length) return { history, state }
  const result = applyOps(state, ops)
  return { history: push(history, { ops, inverse: result.inverse }, limit), state: result.state }
}

/** Step back one intent, or one whole run of consecutive focus-only intents. */
export function stepBack<T extends DockTab>(history: History<T>, state: LayoutState<T>): HistoryStep<T> | undefined {
  if (!canStepBack(history)) return undefined
  let count = 1
  if (isFocusEntry(history, history.cursor - 1)) {
    while (isFocusEntry(history, history.cursor - 1 - count)) count += 1
  }
  let next = state
  for (const entry of history.entries.slice(history.cursor - count, history.cursor).reverse()) {
    for (const op of entry.inverse) next = applyOp(next, op).state
  }
  return { history: { entries: history.entries, cursor: history.cursor - count }, state: next }
}

/** Step forward over the intents the matching step back undid. */
export function stepForward<T extends DockTab>(history: History<T>, state: LayoutState<T>): HistoryStep<T> | undefined {
  if (!canStepForward(history)) return undefined
  let count = 1
  if (isFocusEntry(history, history.cursor)) {
    while (isFocusEntry(history, history.cursor + count)) count += 1
  }
  let next = state
  for (const entry of history.entries.slice(history.cursor, history.cursor + count)) {
    for (const op of entry.ops) next = applyOp(next, op).state
  }
  return { history: { entries: history.entries, cursor: history.cursor + count }, state: next }
}

/** Layout state plus its history, for an embedder that would rather hold both here. */
export class Sequencer<T extends DockTab = DockTab> {
  private current: LayoutState<T>
  private recorded: History<T> = EMPTY_HISTORY

  constructor(initial: LayoutState<T>, private readonly limit = HISTORY_LIMIT) {
    this.current = initial
  }

  get state() { return this.current }
  get history() { return this.recorded }
  get ops() { return recordedOps(this.recorded) }
  get canUndo() { return canStepBack(this.recorded) }
  get canRedo() { return canStepForward(this.recorded) }

  /** Apply and record one intent's ops as one entry. */
  dispatch(...ops: LayoutOp<T>[]): LayoutState<T> {
    const stepped = record(this.recorded, this.current, ops, this.limit)
    this.recorded = stepped.history
    this.current = stepped.state
    return this.current
  }

  /** Record a change an action already applied (`state` must follow from the current one). */
  commit(change: { state: LayoutState<T>; ops: LayoutOp<T>[]; inverse: LayoutOp<T>[] }): LayoutState<T> {
    if (!change.ops.length) return this.current
    this.recorded = push(this.recorded, change, this.limit)
    this.current = change.state
    return this.current
  }

  undo(): boolean {
    const stepped = stepBack(this.recorded, this.current)
    if (!stepped) return false
    this.recorded = stepped.history
    this.current = stepped.state
    return true
  }

  redo(): boolean {
    const stepped = stepForward(this.recorded, this.current)
    if (!stepped) return false
    this.recorded = stepped.history
    this.current = stepped.state
    return true
  }
}
