import { describe, expect, it } from 'vitest'
import type { Item, Session, Turn } from '@/api/types'
import { addOptimistic, applyDelta, buildStructure, createSlice, upsertItems, upsertTurns } from './session-model'
import { reduce } from './sync'

const at = '2026-09-28T10:00:00.000Z'
const turn = (id: string, status = 'running', userItemId = `u-${id}`): Turn => ({ id, status, userItemId, createdAt: at })
const user = (id: string, turnId: string, text = 'hi'): Item => ({ id, turnId, kind: 'user', text, createdAt: at })
const assistant = (id: string, turnId: string, text = '', extra: Partial<Item> = {}): Item => ({ id, turnId, kind: 'assistant', text, createdAt: at, ...extra })
const tool = (id: string, turnId: string, name: string, args: Record<string, unknown> = {}, status = 'succeeded'): Item =>
  ({ id, turnId, kind: 'tool', text: name, createdAt: at, tool: { name, args, status } })

function session(items: Item[], turns: Turn[] = [turn('t1')]): Session {
  return { id: 's1', title: 't', status: 'running', items, turns, revision: 1 }
}

describe('applyDelta', () => {
  const base = () => createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'Hello')]))

  it('appends when offset equals the current length', () => {
    const r = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 5, append: ' world' })
    expect(r.status).toBe('applied')
    expect(r.slice.items.a1.text).toBe('Hello world')
    expect(r.slice.items.a1.streaming).toBe(true)
  })

  it('ignores a duplicate delta already covered by local text', () => {
    const s = base()
    const r = applyDelta(s, { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 0, append: 'Hell' })
    expect(r.status).toBe('duplicate')
    expect(r.slice).toBe(s)
  })

  it('applies only the unseen tail of an overlapping delta', () => {
    const r = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 3, append: 'lo!!' })
    expect(r.status).toBe('applied')
    expect(r.slice.items.a1.text).toBe('Hello!!')
  })

  it('flags a gap for resync instead of guessing', () => {
    const r = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 9, append: 'x' })
    expect(r.status).toBe('gap')
    expect(r.slice.needsResync).toBe(true)
    expect(r.slice.items.a1.text).toBe('Hello')
  })

  it('creates a placeholder for an unknown item at offset 0, and resyncs past 0', () => {
    const ok = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a2', block: 'thinking', offset: 0, append: 'Let me' })
    expect(ok.status).toBe('applied')
    expect(ok.slice.order.at(-1)).toBe('a2')
    expect(ok.slice.items.a2.thinking?.text).toBe('Let me')
    const gap = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a3', block: 'text', offset: 4, append: 'x' })
    expect(gap.status).toBe('gap')
  })

  it('streams tool output and args into their own blocks', () => {
    const s = createSlice(session([user('u-t1', 't1'), tool('c1', 't1', 'project_exec', { command: 'ls' }, 'running')]))
    const out = applyDelta(s, { sessionId: 's1', turnId: 't1', itemId: 'c1', block: 'tool_output', offset: 0, append: 'a\n' }).slice
    const out2 = applyDelta(out, { sessionId: 's1', turnId: 't1', itemId: 'c1', block: 'tool_output', offset: 2, append: 'b\n' }).slice
    expect(out2.items.c1.tool?.output).toBe('a\nb\n')
    const args = applyDelta(out2, { sessionId: 's1', turnId: 't1', itemId: 'c1', block: 'tool_args', offset: 0, append: 'src/' }).slice
    expect(args.items.c1.tool?.argsPreview).toBe('src/')
  })

  it('keeps other item references and the structure stable on a plain append', () => {
    const s = base()
    const r = applyDelta(s, { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 5, append: '!' })
    expect(r.slice.items['u-t1']).toBe(s.items['u-t1'])
    // First delta flips `streaming` (a structural signal); later appends must not rebuild.
    const r2 = applyDelta(r.slice, { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 6, append: '!' })
    expect(r2.slice.structure).toBe(r.slice.structure)
  })

  it('lets the persisted upsert override locally stitched text', () => {
    const s = applyDelta(base(), { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 5, append: ' wrld' }).slice
    const fixed = upsertItems(s, [assistant('a1', 't1', 'Hello world')])
    expect(fixed.items.a1.text).toBe('Hello world')
  })
})

describe('resync via reduce()', () => {
  it('reports needsResync after a gap so the controller refetches', () => {
    const s = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'abc')]))
    const next = reduce(s, { type: 'delta', data: { sessionId: 's1', turnId: 't1', itemId: 'a1', block: 'text', offset: 10, append: 'z' } })
    expect(next.needsResync).toBe(true)
  })

  it('createSlice(session, previous) clears the flag and reuses unchanged items', () => {
    const prev = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'abc')]))
    const flagged = { ...prev, needsResync: true }
    const fresh = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'abcdef')]), flagged)
    expect(fresh.needsResync).toBe(false)
    expect(fresh.items['u-t1']).toBe(prev.items['u-t1'])
    expect(fresh.items.a1.text).toBe('abcdef')
  })

  it('keeps an optimistic message until the server echo arrives', () => {
    let s = createSlice(session([], []))
    s = addOptimistic(s, { id: 'optimistic:1', kind: 'user', text: '你好', createdAt: at, optimistic: true, turnId: null })
    expect(s.structure.rows[0]).toMatchObject({ type: 'pending' })
    s = upsertTurns(s, [turn('t9', 'running', 'u9')])
    s = upsertItems(s, [user('u9', 't9', '你好')])
    expect(s.items['optimistic:1']).toBeUndefined()
    expect(s.structure.rows).toHaveLength(1)
    expect(s.structure.rows[0]).toMatchObject({ type: 'turn', userItemId: 'u9' })
  })
})

describe('buildStructure / step grouping', () => {
  const items = [
    user('u-t1', 't1'),
    assistant('a1', 't1', '', { thinking: { text: 'plan', visibility: 'full' } }),
    tool('r1', 't1', 'project_read', { path: 'a.ts' }),
    tool('r2', 't1', 'project_read', { path: 'b.ts' }),
    assistant('a-empty', 't1', ''), // tool-call-only request: invisible, must not split the group
    tool('r3', 't1', 'project_read', { path: 'c.ts' }),
    tool('e1', 't1', 'project_edit', { path: 'a.ts', oldText: 'x', newText: 'y' }),
    tool('r4', 't1', 'project_read', { path: 'd.ts' }),
    tool('c1', 't1', 'project_exec', { command: 'npm test' }),
    assistant('a2', 't1', 'Done.'),
  ]

  it('groups consecutive same-kind reads and keeps blocks separate', () => {
    const s = createSlice(session(items, [turn('t1', 'completed')]))
    const row = s.structure.rows[0]
    expect(row.type).toBe('turn')
    if (row.type !== 'turn') return
    expect(row.userItemId).toBe('u-t1')
    expect(row.answerId).toBe('a2')
    expect(row.toolCount).toBe(6)
    expect(row.steps.map(step => step.type === 'group' ? `group:${step.itemIds.length}` : `${step.type}:${'itemId' in step ? step.itemId : ''}`)).toEqual([
      'assistant:a1', 'group:3', 'tool:e1', 'tool:r4', 'tool:c1',
    ])
  })

  it('treats a trailing assistant without a later tool as the answer, but not when a tool follows', () => {
    const running = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'Looking…'), tool('r1', 't1', 'project_read', { path: 'a' }, 'running')]))
    const row = running.structure.rows[0]
    expect(row.type === 'turn' && row.answerId).toBe(null)
  })

  it('places proactive and turnless items as standalone rows', () => {
    const s = createSlice(session([
      user('u-t1', 't1'), assistant('a1', 't1', 'ok'),
      { id: 'p1', kind: 'assistant', text: 'FYI', createdAt: at, source: 'initiative', turnId: null },
    ], [turn('t1', 'completed')]))
    expect(s.structure.rows.map(r => r.type)).toEqual(['turn', 'item'])
  })

  it('shows a proactive message that arrives during a turn above that turn, and keeps it there once the turn ends', () => {
    const proactive = (id: string): Item => ({ id, kind: 'assistant', text: 'FYI', createdAt: at, source: 'initiative', turnId: null })
    const order = (s: ReturnType<typeof createSlice>) => s.structure.rows.map(r => r.key)
    // Arrives while the turn is running, before any further step: above the turn.
    const running = createSlice(session([user('u-t1', 't1'), tool('r1', 't1', 'project_read', { path: 'a' }), proactive('p1')], [turn('t1', 'running')]))
    expect(order(running)).toEqual(['item:p1', 'turn:t1'])
    // More steps and the final answer arrive later; the turn ends: the message stays above it.
    const more = upsertItems(running, [tool('r2', 't1', 'project_read', { path: 'b' }), assistant('a1', 't1', 'Done.')])
    expect(order(more)).toEqual(['item:p1', 'turn:t1'])
    const ended = upsertTurns(more, [turn('t1', 'completed')])
    expect(order(ended)).toEqual(['item:p1', 'turn:t1'])
    // A paused turn is not finished either.
    expect(order(createSlice(session([user('u-t1', 't1'), proactive('p1')], [turn('t1', 'paused')])))).toEqual(['item:p1', 'turn:t1'])
    // After a finished turn, in order; with two turns, only the one under way is passed.
    expect(order(createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'ok'), proactive('p1')], [turn('t1', 'completed')])))).toEqual(['turn:t1', 'item:p1'])
    const two = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'ok'), user('u-t2', 't2'), proactive('p1'), proactive('p2')], [turn('t1', 'completed'), turn('t2', 'running')]))
    expect(order(two)).toEqual(['turn:t1', 'item:p1', 'item:p2', 'turn:t2'])
  })

  it('shares unchanged row objects across rebuilds', () => {
    const s = createSlice(session([user('u-t1', 't1'), assistant('a1', 't1', 'ok'), user('u-t2', 't2'), assistant('b1', 't2', 'x')], [turn('t1', 'completed'), turn('t2')]))
    const next = upsertItems(s, [tool('r9', 't2', 'project_read', { path: 'z' })])
    expect(next.structure.rows[0]).toBe(s.structure.rows[0])
    expect(next.structure.rows[1]).not.toBe(s.structure.rows[1])
    expect(buildStructure(next, next.structure)).toBe(next.structure)
  })
})

describe('subagents (E2)', () => {
  it('replaces the originating agent tool row and treats deliveries as notices', () => {
    const call: Item = { id: 'c1', turnId: 't1', kind: 'tool', text: 'agent_delegate', createdAt: at, tool: { id: 'call-1', name: 'agent_delegate', kind: 'other', status: 'succeeded' } }
    const sub: Item = { id: 'sa1', turnId: 't1', kind: 'subagent', text: 'x', createdAt: at, subagent: { agentId: 'a1', status: 'running', toolCallId: 'call-1' } }
    const delivery: Item = { id: 'd1', turnId: 't1', kind: 'user', source: 'subagent', agentId: 'a1', text: '子代理完成：ok', createdAt: at }
    const slice = createSlice(session([user('u-t1', 't1'), call, tool('r1', 't1', 'project_read', { path: 'a' }), sub, delivery]))
    const row = slice.structure.rows[0]
    if (row.type !== 'turn') throw new Error('turn row expected')
    expect(row.userItemId).toBe('u-t1')
    expect(row.steps.map(s => s.type)).toEqual(['subagent', 'tool', 'notice'])
    expect(row.steps[0]).toMatchObject({ itemId: 'sa1' })
  })
})
