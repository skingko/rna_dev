// @vitest-environment node
/** 本次对话的改动's diffs: computed from recorded texts at once, widened on 展开, and apply-record patches read in batches. */
import { describe, expect, it, vi } from 'vitest'
import type { GitDiff } from '@/api/git-api'
import type { StackFile } from './compare-model'
import { localEntry, RnaDiffs, sameInput, type RnaDiffInput } from './rna-diffs'
import { linesOf } from './StackedDiff'

const file = (key: string, patch: Partial<StackFile> = {}): StackFile => ({ key, path: key.split(':').pop()!, status: 'M', added: 1, removed: 1, ...patch })
const rows = (entry: ReturnType<RnaDiffs['entry']>) => linesOf(entry.diff)?.map(line => `${line.type}:${line.text}`) ?? null
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const LONG = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

describe('computed diffs', () => {
  it('an edit’s old and new text, each edit of the file under its own heading, an unrecorded overwrite said in words', () => {
    expect(rows(localEntry({ kind: 'edits', parts: [{ oldText: 'a', newText: 'b' }] })!)).toEqual(['del:a', 'add:b'])
    expect(rows(localEntry({ kind: 'edits', parts: [{ oldText: 'a', newText: 'b' }, null] })!)).toEqual([
      'gap:第 1 次修改', 'del:a', 'add:b', 'gap:第 2 次修改', 'gap:覆盖了整个文件，之前的内容没有记录，所以没有差异可看。',
    ])
    expect(localEntry({ kind: 'edits', parts: [null] })!.diff).toEqual({ kind: 'unavailable', message: '覆盖了整个文件，之前的内容没有记录，所以没有差异可看。' })
  })

  it('a change set’s own before and after; changed since, cut short, binary and notes each read as such', () => {
    const base = { kind: 'snapshot', before: 'one\n', after: 'one\ntwo\n', binary: false, truncated: false, changedSince: false } as const
    expect(rows(localEntry(base)!)).toEqual(['ctx:one', 'add:two'])
    expect(rows(localEntry({ ...base, changedSince: true })!)?.[0]).toBe('gap:这个文件之后又改过：这里是这次后台工作做的改动。')
    expect(localEntry({ ...base, truncated: true })!.diff?.kind).toBe('truncated')
    expect(localEntry({ ...base, binary: true })!.diff).toEqual({ kind: 'binary' })
    expect(localEntry({ kind: 'note', message: '读不到' })!.diff).toEqual({ kind: 'unavailable', message: '读不到' })
    expect(localEntry({ kind: 'loading' })).toEqual({ loading: true })
    expect(localEntry({ kind: 'apply', applyId: 'ap', path: 'a' })).toBeNull()
  })

  it('folds unchanged lines into gaps; 展开 compares again with every line as context', () => {
    const input: RnaDiffInput = { kind: 'snapshot', before: LONG, after: LONG.replace('line 10\n', 'line ten\n'), binary: false, truncated: false, changedSince: false }
    const store = new RnaDiffs(async () => [])
    store.setListing([file('change:c1:a.txt')], new Map([['change:c1:a.txt', input]]))
    const folded = store.entry('change:c1:a.txt')
    expect(linesOf(folded.diff)!.some(line => line.type === 'gap' && line.skipped)).toBe(true)
    expect(folded.full).toBe(false)
    const listener = vi.fn()
    store.subscribe(listener)
    store.expand('change:c1:a.txt')
    expect(listener).toHaveBeenCalled()
    const whole = store.entry('change:c1:a.txt')
    expect(whole.full).toBe(true)
    expect(linesOf(whole.diff)!.filter(line => line.type === 'gap')).toEqual([])
    expect(linesOf(whole.diff)).toHaveLength(21)
  })

  it('keeps a file’s entry while its input stays the same, and reads it again once it changes', () => {
    const store = new RnaDiffs(async () => [])
    const parts = [{ oldText: 'a', newText: 'b' }]
    store.setListing([file('turn:t1:a.ts')], new Map([['turn:t1:a.ts', { kind: 'edits', parts }]]))
    const first = store.entry('turn:t1:a.ts')
    store.setListing([file('turn:t1:a.ts')], new Map([['turn:t1:a.ts', { kind: 'edits', parts: [{ ...parts[0] }] }]]))
    expect(store.entry('turn:t1:a.ts')).toBe(first)
    store.setListing([file('turn:t1:a.ts')], new Map([['turn:t1:a.ts', { kind: 'edits', parts: [...parts, { oldText: 'b', newText: 'c' }] }]]))
    expect(store.entry('turn:t1:a.ts')).not.toBe(first)
    expect(sameInput({ kind: 'apply', applyId: 'x', path: 'a' }, { kind: 'apply', applyId: 'x', path: 'a' })).toBe(true)
    expect(sameInput({ kind: 'apply', applyId: 'x', path: 'a' }, { kind: 'note', message: 'a' })).toBe(false)
  })
})

describe('apply-record patches', () => {
  const patch = (path: string): GitDiff => ({ kind: 'patch', patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old ${path}\n+new ${path}\n` })

  it('read when wanted, in batches per record of at most 40 paths, and not widened afterwards', async () => {
    const asked: { applyId: string; paths: string[] }[] = []
    const store = new RnaDiffs(async (applyId, paths) => { asked.push({ applyId, paths }); return paths.map(path => ({ path, diff: patch(path) })) }, 0)
    const files = [...Array.from({ length: 45 }, (_, i) => file(`change:g:f${i}.ts`)), file('change:h:z.ts')]
    const inputs = new Map<string, RnaDiffInput>(files.map(row => [row.key!, { kind: 'apply', applyId: row.key!.startsWith('change:g') ? 'ap-g' : 'ap-h', path: row.path }]))
    store.setListing(files, inputs)
    expect(store.entry('change:g:f0.ts')).toEqual({ loading: false })
    store.want(files.map(row => row.key!))
    expect(store.busy()).toBe(true)
    for (let i = 0; i < 6; i++) await tick()
    // Two requests at a time: the first record's two batches, then the other record's.
    expect(asked.map(row => [row.applyId, row.paths.length])).toEqual([['ap-g', 40], ['ap-g', 5], ['ap-h', 1]])
    expect(rows(store.entry('change:g:f3.ts'))).toEqual(['del:old f3.ts', 'add:new f3.ts'])
    expect(store.entry('change:g:f3.ts').full).toBe(true)
    expect(store.busy()).toBe(false)
    // Asked again: read already.
    store.want(['change:g:f3.ts'])
    await tick()
    expect(asked).toHaveLength(3)
  })

  it('a batch past the host’s cap asks for that file alone; an answer for a file whose input changed is dropped', async () => {
    let calls = 0
    let release: () => void = () => {}
    const store = new RnaDiffs(async (_applyId, paths) => {
      calls++
      if (calls === 1) return paths.map(path => ({ path, diff: path === 'b.ts' ? { kind: 'unavailable', reason: 'batch_too_large' } as GitDiff : patch(path) }))
      if (calls === 2) return paths.map(path => ({ path, diff: patch(path) }))
      await new Promise<void>(resolve => { release = resolve })
      return paths.map(path => ({ path, diff: patch(path) }))
    }, 0)
    const files = [file('change:g:a.ts'), file('change:g:b.ts')]
    store.setListing(files, new Map(files.map(row => [row.key!, { kind: 'apply', applyId: 'ap', path: row.path } as RnaDiffInput])))
    store.want(files.map(row => row.key!))
    for (let i = 0; i < 6; i++) await tick()
    expect(calls).toBe(2)
    expect(rows(store.entry('change:g:b.ts'))).toEqual(['del:old b.ts', 'add:new b.ts'])

    const later = [file('change:k:c.ts')]
    store.setListing(later, new Map([['change:k:c.ts', { kind: 'apply', applyId: 'ap-k', path: 'c.ts' }]]))
    store.want(['change:k:c.ts'])
    for (let i = 0; i < 3; i++) await tick()
    expect(store.entry('change:k:c.ts').loading).toBe(true)
    // The set was rolled back meanwhile: its file now reads a note, and the late answer does not land on it.
    store.setListing(later, new Map([['change:k:c.ts', { kind: 'note', message: '已回退' }]]))
    release()
    for (let i = 0; i < 3; i++) await tick()
    expect(store.entry('change:k:c.ts').diff).toEqual({ kind: 'unavailable', message: '已回退' })
  })

  it('a failed read says so on its files; the find bar reads what is left within its budget', async () => {
    const store = new RnaDiffs(async () => { throw new Error('读不到补丁') }, 0)
    const files = [file('change:g:a.ts'), file('turn:t:b.ts')]
    store.setListing(files, new Map<string, RnaDiffInput>([['change:g:a.ts', { kind: 'apply', applyId: 'ap', path: 'a.ts' }], ['turn:t:b.ts', { kind: 'edits', parts: [{ oldText: 'x', newText: 'y' }] }]]))
    expect(store.wantAll(1)).toBe(false)
    expect(store.wantAll(1024 * 1024)).toBe(true)
    for (let i = 0; i < 4; i++) await tick()
    expect(store.entry('change:g:a.ts')).toEqual({ loading: false, error: '读不到补丁' })
    expect(rows(store.entry('turn:t:b.ts'))).toEqual(['del:x', 'add:y'])
  })
})
