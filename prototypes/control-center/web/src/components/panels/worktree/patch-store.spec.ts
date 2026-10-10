/** Reading the stacked diffs' patches (worktree design §3.5): batches, the generation counter, stale entries, retries, find and 展开. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitCompareFile, GitDiff } from '@/api/git-api'
import { PatchStore, type PatchFetchers } from './patch-store'

const file = (path: string, patch: Partial<GitCompareFile> = {}): GitCompareFile => ({ path, status: 'M', added: 1, removed: 1, ...patch })
const patch = (path: string, tag = ''): GitDiff => ({ kind: 'patch', patch: `@@ -1 +1 @@\n-a\n+${path}${tag}\n` })

interface Pending { base: string; paths: string[]; oldPaths: string[]; resolve: (rows: { path: string; diff: GitDiff }[]) => void; reject: (error: Error) => void }
let batches: Pending[] = [], fulls: { base: string; path: string; oldPath?: string; resolve: (diff: GitDiff) => void }[] = []
const fetchers: PatchFetchers = {
  batch: (base, paths, oldPaths) => new Promise((resolve, reject) => { batches.push({ base, paths, oldPaths, resolve, reject }) }),
  full: (base, path, oldPath) => new Promise(resolve => { fulls.push({ base, path, oldPath, resolve }) }),
}
const answer = (pending: Pending, tag = '') => pending.resolve(pending.paths.map(path => ({ path, diff: patch(path, tag) })))
const tick = async () => { await vi.advanceTimersByTimeAsync(30) }

let store: PatchStore
beforeEach(() => { vi.useFakeTimers(); batches = []; fulls = []; store = new PatchStore(fetchers) })
afterEach(() => { vi.useRealTimers() })

describe('PatchStore', () => {
  it('gathers asks made close together into one request, two requests at a time, a moved file with its old name', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a'), file('b', { oldPath: 'old-b' }), file('c'), file('dir/', { added: null, removed: null })])
    store.want(['a']); store.want(['b', 'dir/']); store.want(['a'])
    expect(batches).toHaveLength(0)
    await tick()
    expect(batches.map(row => [row.base, row.paths, row.oldPaths])).toEqual([['abc', ['a', 'b'], ['old-b']]])
    expect(store.entry('a')).toEqual({ loading: true, error: undefined })
    expect(store.busy()).toBe(true)
    answer(batches[0]); await tick()
    expect(store.entry('a').diff).toEqual(patch('a'))
    expect(store.busy()).toBe(false)
    // Read already: asking again reads nothing.
    store.want(['a', 'b']); await tick()
    expect(batches).toHaveLength(1)
  })

  it('a new listing drops answers to the old one and marks what is cached stale; the file in view is read again', async () => {
    const changes = vi.fn()
    store.subscribe(changes)
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    store.want(['a']); await tick()
    answer(batches[0]); await tick()
    store.want(['a']) // fresh: nothing
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    expect(store.entry('a')).toMatchObject({ diff: patch('a'), stale: true, loading: false })
    store.want(['a']); await tick()
    expect(batches).toHaveLength(2)
    // A third listing arrives before the second answer: that answer is dropped.
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    answer(batches[1], ' again'); await tick()
    expect(store.entry('a').diff).toEqual(patch('a'))
    expect(changes).toHaveBeenCalled()
  })

  it('keeps each comparison’s patches apart (mode:base:target:path)', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    store.want(['a']); await tick(); answer(batches[0]); await tick()
    store.setListing({ mode: 'uncommitted', base: 'HEAD', target: null }, [file('a')])
    expect(store.entry('a')).toEqual({ loading: false })
    store.want(['a']); await tick()
    expect(batches[1].base).toBe('HEAD')
    store.setListing({ mode: 'all', base: 'abc', target: '/w/x' }, [file('a')])
    expect(store.entry('a').diff).toBeUndefined()
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    expect(store.entry('a').diff).toEqual(patch('a'))
  })

  it('a file the batch could not fit is asked for again on its own', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a'), file('b'), file('c')])
    store.want(['a', 'b', 'c']); await tick()
    batches[0].resolve([
      { path: 'a', diff: patch('a') },
      { path: 'b', diff: { kind: 'unavailable', reason: 'batch_too_large' } },
      { path: 'c', diff: { kind: 'unavailable', reason: 'batch_too_large' } },
    ])
    await tick()
    expect(batches.slice(1).map(row => row.paths)).toEqual([['b'], ['c']])
    answer(batches[1]); await tick()
    // Alone, the answer is what it is.
    batches[2].resolve([{ path: 'c', diff: { kind: 'truncated', patch: '@@ -1 +1 @@\n+c\n' } }]); await tick()
    expect(store.entry('b').diff).toEqual(patch('b'))
    expect(store.entry('c').diff?.kind).toBe('truncated')
  })

  it('a failed request is said on its files', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    store.want(['a']); await tick()
    batches[0].reject(new Error('网络断了')); await tick()
    expect(store.entry('a')).toMatchObject({ loading: false, error: '网络断了' })
    store.want(['a']); await tick()
    expect(batches).toHaveLength(1)
  })

  it('for find, reads the rest in order up to a budget and says whether everything with text was asked for', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a'), file('bin', { binary: true, added: null, removed: null }), file('big', { added: null, removed: null, untracked: true }), file('c')])
    expect(store.wantAll(2 * 1024 * 1024)).toBe(true)
    await tick()
    expect(batches.map(row => row.paths)).toEqual([['a', 'c'], ['big']])
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a'), file('big', { added: null, removed: null, untracked: true }), file('c')])
    expect(store.wantAll(4096)).toBe(false) // the MB file does not fit
  })

  it('展开: reads one file whole, and whole again after a new listing', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a', { oldPath: 'z' }), file('b')])
    store.want(['a', 'b']); await tick(); answer(batches[0]); await tick()
    store.expand('a')
    expect(fulls.map(row => [row.base, row.path, row.oldPath])).toEqual([['abc', 'a', 'z']])
    expect(store.entry('a')).toMatchObject({ loading: true, diff: patch('a') })
    fulls[0].resolve(patch('a', ' whole')); await tick()
    expect(store.entry('a')).toMatchObject({ full: true, diff: patch('a', ' whole') })
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a', { oldPath: 'z' }), file('b')])
    store.want(['a', 'b']); await tick()
    expect(fulls).toHaveLength(2)
    expect(batches.at(-1)!.paths).toEqual(['b'])
  })

  it('展开 asked once: a second click reads nothing more, and a listing landing meanwhile reads the file whole again', async () => {
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    store.want(['a']); await tick(); answer(batches[0]); await tick()
    store.expand('a'); store.expand('a')
    expect(fulls).toHaveLength(1)
    // The window took focus (or a run ended) while it was on its way: that answer belongs to the old listing.
    store.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    fulls[0].resolve(patch('a', ' whole')); await tick()
    expect(store.entry('a')).toMatchObject({ diff: patch('a'), stale: true, full: true })
    store.want(['a']); await tick()
    expect(batches).toHaveLength(1)
    expect(fulls).toHaveLength(2)
    fulls[1].resolve(patch('a', ' whole')); await tick()
    expect(store.entry('a')).toMatchObject({ diff: patch('a', ' whole'), full: true, loading: false })
  })

  it('a failed 展开 leaves the file as it was read, with 展开 offered again', async () => {
    const failing = new PatchStore({ ...fetchers, full: () => Promise.reject(new Error('读不到')) })
    failing.setListing({ mode: 'all', base: 'abc', target: null }, [file('a')])
    failing.want(['a']); await tick(); answer(batches[0]); await tick()
    failing.expand('a'); await tick()
    expect(failing.entry('a')).toMatchObject({ diff: patch('a'), loading: false, error: '读不到', full: undefined })
  })
})
