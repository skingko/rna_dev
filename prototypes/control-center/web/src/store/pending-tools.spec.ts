import { describe, expect, it } from 'vitest'
import type { DeltaEvent, Item, PendingToolMeta, Session, Turn } from '@/api/types'
import { applyDelta, createSlice, upsertItems, upsertTurns, type SessionSlice } from './session-model'
import { reduce } from './sync'
import { partialJsonFields, TARGET_FIELDS } from '@/lib/partial-json'
import { toolTarget, toolVerb } from '@/lib/tools'

const at = '2026-09-28T10:00:00.000Z'
const turn = (id: string, status = 'running'): Turn => ({ id, status, userItemId: `u-${id}`, createdAt: at })
const base = (turns: Turn[] = [turn('t1')]) => createSlice({ id: 's1', title: 't', status: 'running', revision: 1, turns, items: [
  { id: 'u-t1', turnId: 't1', kind: 'user', text: 'go', createdAt: at },
  { id: 'a1', turnId: 't1', kind: 'assistant', text: 'Reading first.', createdAt: at },
] } as Session)
const meta = (extra: Partial<PendingToolMeta> = {}): PendingToolMeta => ({ id: 'call-1', index: 0, name: 'project_read', kind: 'read', preparing: true, ...extra })
const args = (offset: number, append: string, tool = meta(), itemId = 'pending-tool:m1:0'): DeltaEvent => ({ sessionId: 's1', turnId: 't1', itemId, block: 'tool_args', offset, append, tool })
const durable = (id: string, extra: Partial<Item['tool']> = {}): Item => ({ id, turnId: 't1', kind: 'tool', text: 'project_read', createdAt: at, tool: { id: 'call-1', name: 'project_read', kind: 'read', target: 'src/app.ts', args: { path: 'src/app.ts' }, status: 'running', ...extra } })
const stepIds = (slice: SessionSlice) => slice.structure.rows.flatMap(row => (row.type === 'turn' ? row.steps.flatMap(step => ('itemIds' in step ? step.itemIds : [step.itemId])) : []))

describe('partialJsonFields', () => {
  it('reads top-level strings from any streaming prefix', () => {
    const cases: [string, Record<string, string>][] = [
      ['', {}], ['{', {}], ['{"pa', {}], ['{"path"', {}], ['{"path": ', {}],
      ['{"path": "src/a', { path: 'src/a' }],
      ['{"path":"src/a.ts","x":{"path":"nested"},"command":"np', { path: 'src/a.ts', command: 'np' }],
      ['{"n":1,"ok":true,"command":"a\\nb\\u00e9 \\"q\\"', { command: 'a\nbé "q"' }],
      ['{"command":"x\\u00', { command: 'x' }],
      ['{"a":["path",{"query":"inner"}],"query":"outer"}', { query: 'outer' }],
      ['{"path": 42, "query": "q"}', { query: 'q' }],
    ]
    for (const [input, expected] of cases) expect(partialJsonFields(input), input).toEqual(expected)
    expect(partialJsonFields(undefined)).toEqual({})
    expect(partialJsonFields('{"file_path":"x.ts"', TARGET_FIELDS)).toEqual({ file_path: 'x.ts' })
  })

  it('gives preparing rows a Harness-style verb and target', () => {
    expect(toolVerb({ name: 'project_read', preparing: true, status: 'pending' })).toBe('准备读取')
    const cmd = { name: 'project_exec', preparing: true, status: 'pending', argsPreview: '{"command":"npm te' }
    expect(toolTarget(cmd)).toBe('npm te')
    expect(toolVerb(cmd)).toBe('准备运行')
    expect(toolVerb({ name: 'project_exec', preparing: true, status: 'pending', argsPreview: '{"comm' })).toBe('准备运行命令')
    expect(toolVerb({ name: 'project_edit', preparing: true, status: 'pending', target: 'a.ts' })).toBe('准备编辑')
    // Raw JSON is never shown as a target.
    expect(toolTarget({ name: 'other_tool', preparing: true, argsPreview: '{"x":1' })).toBe('')
  })
})

describe('pending tool entries', () => {
  it('creates a display-only placeholder from tool_args metadata and appends by offset', () => {
    let s = applyDelta(base(), args(0, '{"pa', meta())).slice
    s = applyDelta(s, args(4, 'th":"src/app.ts"}', meta({ target: 'src/app.ts' }))).slice
    const item = s.items['pending-tool:m1:0']
    expect(item.kind).toBe('tool')
    expect(item.tool).toMatchObject({ id: 'call-1', name: 'project_read', kind: 'read', target: 'src/app.ts', preparing: true, status: 'pending', argsPreview: '{"path":"src/app.ts"}' })
    expect(stepIds(s)).toContain('pending-tool:m1:0')
    // The interim narration is a process step, not the final answer.
    const row = s.structure.rows.find(r => r.type === 'turn')
    expect(row?.type === 'turn' && row.answerId).toBe(null)
  })

  it('never resyncs on a gap; metadata-only updates still apply', () => {
    const joined = applyDelta(base(), args(120, 'tail', meta({ target: 'src/app.ts' })))
    expect(joined.status).toBe('applied')
    expect(joined.slice.needsResync).toBe(false)
    expect(joined.slice.items['pending-tool:m1:0'].tool?.target).toBe('src/app.ts')
    const renamed = applyDelta(joined.slice, args(120, '', meta({ name: 'project_exec', kind: 'command', target: 'npm test' })))
    expect(renamed.status).toBe('applied')
    expect(renamed.slice.items['pending-tool:m1:0'].tool).toMatchObject({ name: 'project_exec', kind: 'command', target: 'npm test' })
    expect(applyDelta(renamed.slice, args(120, '', meta({ name: 'project_exec', kind: 'command', target: 'npm test' }))).status).toBe('duplicate')
  })

  it('the durable item with the same call id supersedes the placeholder in place', () => {
    let s = applyDelta(base(), args(0, '{"path":"src/app.ts"}', meta({ target: 'src/app.ts' }))).slice
    s = upsertItems(s, [{ id: 'a2', turnId: 't1', kind: 'assistant', text: '', createdAt: at, streaming: true }])
    const order = s.order.indexOf('pending-tool:m1:0')
    s = upsertItems(s, [durable('tool-item-1')])
    expect(s.items['pending-tool:m1:0']).toBeUndefined()
    expect(s.order.indexOf('tool-item-1')).toBe(order)
    expect(s.items['tool-item-1'].preparedFrom).toBe('pending-tool:m1:0')
    expect(stepIds(s)).toEqual(['a1', 'tool-item-1'])
    // Later completion keeps the morph link; late deltas for the call are ignored.
    s = upsertItems(s, [durable('tool-item-1', { status: 'succeeded' })])
    expect(s.items['tool-item-1'].preparedFrom).toBe('pending-tool:m1:0')
    const late = applyDelta(s, args(21, 'x', meta()))
    expect(late.status).toBe('duplicate')
    expect(late.slice.items['pending-tool:m1:0']).toBeUndefined()
  })

  it('parallel calls stay separate and each is superseded by its own id', () => {
    let s = applyDelta(base(), args(0, '{"path":"a"}', meta({ target: 'a' }))).slice
    s = applyDelta(s, args(0, '{"command":"ls"}', meta({ id: 'call-2', index: 1, name: 'project_exec', kind: 'command', target: 'ls' }), 'pending-tool:m1:1')).slice
    expect(stepIds(s)).toEqual(['a1', 'pending-tool:m1:0', 'pending-tool:m1:1'])
    s = upsertItems(s, [durable('r1', { target: 'a', args: { path: 'a' } })])
    expect(stepIds(s)).toEqual(['a1', 'r1', 'pending-tool:m1:1'])
    s = upsertItems(s, [{ id: 'x1', turnId: 't1', kind: 'tool', text: 'project_exec', createdAt: at, tool: { id: 'call-2', name: 'project_exec', kind: 'command', status: 'running' } }])
    expect(stepIds(s)).toEqual(['a1', 'r1', 'x1'])
  })

  it('pending entries are dropped when the turn ends and ignored for ended turns', () => {
    let s = applyDelta(base(), args(0, '{"pa', meta())).slice
    s = upsertTurns(s, [turn('t1', 'completed')])
    expect(s.items['pending-tool:m1:0']).toBeUndefined()
    expect(s.order).not.toContain('pending-tool:m1:0')
    expect(applyDelta(s, args(0, '{"pa', meta())).status).toBe('duplicate')
  })

  it('a resync keeps a running turn\'s placeholder unless the snapshot already has the durable item', () => {
    const s = applyDelta(base(), args(0, '{"pa', meta())).slice
    const snapshot = (items: Item[] = []) => ({ id: 's1', title: 't', status: 'running', revision: 2, turns: [turn('t1')], items: [
      { id: 'u-t1', turnId: 't1', kind: 'user', text: 'go', createdAt: at }, { id: 'a1', turnId: 't1', kind: 'assistant', text: 'Reading first.', createdAt: at }, ...items] } as Session)
    expect(createSlice(snapshot(), s).items['pending-tool:m1:0']?.tool?.preparing).toBe(true)
    expect(createSlice(snapshot([durable('d1')]), s).items['pending-tool:m1:0']).toBeUndefined()
  })

  it('turn.phase carries the preparing flag through the reducer', () => {
    const s = reduce(base(), { type: 'phase', data: { sessionId: 's1', turnId: 't1', phase: 'tool', preparing: true, at } })
    expect(s.phases.t1).toEqual({ phase: 'tool', at, preparing: true })
    expect(reduce(s, { type: 'phase', data: { sessionId: 's1', turnId: 't1', phase: 'tool', at } }).phases.t1.preparing).toBeUndefined()
  })
})
