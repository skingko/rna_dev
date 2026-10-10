// @vitest-environment node
/** 本次对话的改动, the listing: turn and change-set groups, their files and keys, and where each diff is read from. */
import { describe, expect, it } from 'vitest'
import type { BackgroundChange, BackgroundChangeFile, Item } from '@/api/types'
import { toWorkspacePath } from '@/components/preview/registry'
import { buildRnaListing, setApplyIds, type RnaListingInput } from './rna-model'

const edit = (id: string, path: string, turnId: string, oldText = 'a', newText = 'b\nc', at = '2026-10-03T10:00:00Z'): Item =>
  ({ id, kind: 'tool', turnId, createdAt: at, tool: { name: 'project_edit', status: 'succeeded', args: { path, oldText, newText } } } as unknown as Item)
const write = (id: string, path: string, turnId: string, created: boolean | undefined, content = 'x\ny\n'): Item =>
  ({ id, kind: 'tool', turnId, createdAt: '2026-10-03T10:00:00Z', tool: { name: 'project_write', status: 'succeeded', args: { path, content }, ...(created === undefined ? {} : { created }) } } as unknown as Item)
const set = (patch: Partial<BackgroundChange> = {}): BackgroundChange => ({ id: 'bg-1', actionId: 'a1', at: '2026-10-03T12:00:00Z', status: 'kept', count: 2, paths: ['docs/a.md', 'README.md'], ...patch })
const snap = (path: string, patch: Partial<BackgroundChangeFile> = {}): BackgroundChangeFile => ({ path, created: false, deleted: false, changedSince: false, before: 'one\n', after: 'one\ntwo\n', binary: false, truncated: false, available: true, ...patch })

const listing = (patch: Partial<RnaListingInput> = {}) => buildRnaListing({
  tools: [], latestTurnId: null, turnInfo: () => ({ title: null, at: null }), sets: [], details: {}, runTitle: () => null,
  local: path => toWorkspacePath(path, ['/w/p1']), ...patch,
})

describe('the conversation’s turns', () => {
  it('a group per turn with a changed file, newest first; 本轮 marks the latest; the request is its title', () => {
    const tools = [edit('e1', '/w/p1/src/login.ts', 't1'), edit('e2', 'src/home.ts', 't2'), { id: 'r1', kind: 'tool', turnId: 't3', createdAt: '', tool: { name: 'project_read', status: 'succeeded', args: { path: 'x' } } } as unknown as Item]
    const out = listing({ tools, latestTurnId: 't2', turnInfo: turnId => ({ title: turnId === 't1' ? '改一下登录页' : null, at: null }) })
    expect(out.groups.map(group => [group.key, group.label, group.tag ?? null])).toEqual([['turn:t2', '一轮对话', '本轮'], ['turn:t1', '改一下登录页', null]])
    // Paths as the project folder names them, keyed per group.
    expect(out.files.map(file => [file.key, file.path, file.status, file.added, file.removed])).toEqual([
      ['turn:t2:src/home.ts', 'src/home.ts', 'M', 2, 1],
      ['turn:t1:src/login.ts', 'src/login.ts', 'M', 2, 1],
    ])
    expect(out.inputs.get('turn:t1:src/login.ts')).toEqual({ kind: 'edits', parts: [{ oldText: 'a', newText: 'b\nc' }] })
    expect(out.groups[0]).toMatchObject({ kind: 'turn', turnId: 't2', latest: true, itemIds: ['e2'] })
  })

  it('a file written to twice in a turn (by an absolute and a relative path) is one file with both edits in order', () => {
    const out = listing({ tools: [edit('e1', '/w/p1/src/a.ts', 't1', 'a', 'b'), edit('e2', 'src/a.ts', 't1', 'b', 'c\nd')] })
    expect(out.files).toHaveLength(1)
    expect(out.files[0]).toMatchObject({ key: 'turn:t1:src/a.ts', added: 3, removed: 2 })
    expect(out.inputs.get('turn:t1:src/a.ts')).toEqual({ kind: 'edits', parts: [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c\nd' }] })
  })

  it('a new file reads A; an overwrite without its earlier text is 已覆盖 with no counts; a failed call delivered nothing', () => {
    const failed = { ...edit('e9', 'src/x.ts', 't1'), tool: { name: 'project_edit', status: 'failed', args: { path: 'src/x.ts', oldText: 'a', newText: 'b' } } } as unknown as Item
    const out = listing({ tools: [write('w1', 'docs/new.md', 't1', true), write('w2', 'docs/old.md', 't1', false), failed] })
    expect(out.files.map(file => [file.path, file.status, file.added, file.removed, file.overwritten ?? false])).toEqual([
      ['docs/new.md', 'A', 2, 0, false],
      ['docs/old.md', 'M', null, null, true],
    ])
    expect(out.inputs.get('turn:t1:docs/old.md')).toEqual({ kind: 'edits', parts: [null] })
  })

  it('a path a tool reported outside the conversation’s folders is shown as reported and marked external', () => {
    const out = listing({ tools: [edit('e1', '/elsewhere/notes.md', 't1')] })
    expect(out.files[0]).toMatchObject({ path: '/elsewhere/notes.md', external: true })
  })
})

describe('background change sets', () => {
  it('a set read through the change-review API lists its own files with counts from its before and after', () => {
    const out = listing({ sets: [set()], details: { 'bg-1': { kind: 'snapshot', files: [snap('docs/a.md'), snap('new.txt', { created: true, before: null, after: 'x\n' }), snap('gone.txt', { deleted: true, after: null }), snap('logo.png', { binary: true })] } }, runTitle: () => '整理文档' })
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]).toMatchObject({ kind: 'change', key: 'change:bg-1', label: '整理文档', more: 0 })
    expect(out.files.map(file => [file.path, file.status, file.added, file.removed, file.binary ?? false])).toEqual([
      ['docs/a.md', 'M', 1, 0, false], ['gone.txt', 'D', 0, 1, false], ['logo.png', 'M', null, null, true], ['new.txt', 'A', 1, 0, false],
    ])
    expect(out.inputs.get('change:bg-1:docs/a.md')).toEqual({ kind: 'snapshot', before: 'one\n', after: 'one\ntwo\n', binary: false, truncated: false, changedSince: false })
  })

  it('a rolled-back set is dimmed and its files say why there is nothing to compare', () => {
    const out = listing({ sets: [set({ status: 'reverted' })], details: { 'bg-1': { kind: 'snapshot', files: [snap('docs/a.md', { available: false, before: null, after: null })] } } })
    expect(out.groups[0]).toMatchObject({ muted: true, label: '后台改动' })
    expect(out.inputs.get('change:bg-1:docs/a.md')).toEqual({ kind: 'note', message: '这组改动已回退或快照已过期，只能看到文件列表。' })
  })

  it('until its files are read the summary’s paths stand in (还有 N 个); a failed read says why', () => {
    const waiting = listing({ sets: [set({ count: 5 })], details: { 'bg-1': { kind: 'loading' } } })
    expect(waiting.files.map(file => [file.key, file.added])).toEqual([['change:bg-1:docs/a.md', null], ['change:bg-1:README.md', null]])
    expect(waiting.groups[0]).toMatchObject({ more: 3 })
    expect(waiting.inputs.get('change:bg-1:README.md')).toEqual({ kind: 'loading' })
    const failed = listing({ sets: [set()], details: { 'bg-1': { kind: 'failed', message: '这组后台改动不存在或已过期' } } })
    expect(failed.inputs.get('change:bg-1:docs/a.md')).toEqual({ kind: 'note', message: '这组后台改动不存在或已过期' })
  })

  it('a set made in a background worktree lists its apply record’s files and reads their patches from it', () => {
    const git = set({ kind: 'git', applyId: 'ap-9', count: 3, paths: ['src/a.ts'] })
    const out = listing({ sets: [git], details: { 'bg-1': { kind: 'apply', records: [{ applyId: 'ap-9', truncated: true, files: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }, { path: 'src/b.ts', oldPath: 'src/c.ts', status: 'R', added: 0, removed: 0 }] }] } } })
    expect(out.files.map(file => [file.path, file.oldPath ?? null, file.status, file.added])).toEqual([['src/a.ts', null, 'M', 3], ['src/b.ts', 'src/c.ts', 'R', 0]])
    expect(out.inputs.get('change:bg-1:src/b.ts')).toEqual({ kind: 'apply', applyId: 'ap-9', path: 'src/b.ts' })
    expect(out.groups[0]).toMatchObject({ more: 1 })
    // Not applied yet (deferred, no record): its paths, and why there is no diff.
    const held = listing({ sets: [set({ kind: 'git', status: 'deferred', applyId: null })] })
    expect(held.inputs.get('change:bg-1:docs/a.md')).toEqual({ kind: 'note', message: '这组改动还没有应用到项目文件夹。' })
  })

  it('a set applied by several records (its clean part, then a take) lists every record’s files, a file two wrote from the newer', () => {
    const git = set({ kind: 'git', applyId: 'ap-1', applyIds: ['ap-1', 'ap-2'], count: 3, paths: ['src/a.ts'] })
    const out = listing({ sets: [git], details: { 'bg-1': { kind: 'apply', records: [
      { applyId: 'ap-1', truncated: false, files: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }, { path: 'src/shared.ts', status: 'M', added: 1, removed: 0 }] },
      { applyId: 'ap-2', truncated: false, files: [{ path: 'notes.md', status: 'M', added: 2, removed: 2 }, { path: 'src/shared.ts', status: 'M', added: 4, removed: 1 }] },
    ] } } })
    expect(out.files.map(file => [file.path, file.added]).sort()).toEqual([['notes.md', 2], ['src/a.ts', 3], ['src/shared.ts', 4]])
    expect(out.inputs.get('change:bg-1:notes.md')).toEqual({ kind: 'apply', applyId: 'ap-2', path: 'notes.md' })
    expect(out.inputs.get('change:bg-1:src/a.ts')).toEqual({ kind: 'apply', applyId: 'ap-1', path: 'src/a.ts' })
    expect(out.inputs.get('change:bg-1:src/shared.ts')).toEqual({ kind: 'apply', applyId: 'ap-2', path: 'src/shared.ts' })
    expect(out.groups[0]).toMatchObject({ more: 0 })
    expect(setApplyIds({ applyId: 'ap-1', applyIds: ['ap-1', 'ap-2'] })).toEqual(['ap-1', 'ap-2'])
    expect(setApplyIds({ applyId: 'ap-1' })).toEqual(['ap-1'])
  })
})

describe('order and the tree', () => {
  it('turns and sets newest first by time; the same file in two groups has two keys; the tree folds by group', () => {
    const tools = [edit('e1', 'README.md', 't1', 'a', 'b', '2026-10-03T09:00:00Z'), edit('e2', 'README.md', 't2', 'b', 'c', '2026-10-03T11:00:00Z')]
    const out = listing({ tools, sets: [set({ at: '2026-10-03T10:00:00Z', paths: ['README.md'], count: 1 })], turnInfo: turnId => ({ title: null, at: turnId === 't1' ? '2026-10-03T09:00:00Z' : '2026-10-03T11:00:00Z' }) })
    expect(out.groups.map(group => group.key)).toEqual(['turn:t2', 'change:bg-1', 'turn:t1'])
    expect(out.files.map(file => file.key)).toEqual(['turn:t2:README.md', 'change:bg-1:README.md', 'turn:t1:README.md'])
    expect(out.tree.rows(new Set(['change:bg-1'])).map(row => `${row.kind}:${row.path}`)).toEqual([
      'group:turn:t2', 'file:turn:t2:README.md', 'group:change:bg-1', 'group:turn:t1', 'file:turn:t1:README.md',
    ])
    expect(out.tree.holders('change:bg-1:README.md')).toEqual(['change:bg-1'])
  })

  it('lists the conversation’s latest tool calls newest first', () => {
    const tools = Array.from({ length: 35 }, (_, i) => edit(`e${i}`, `f${i}.ts`, 't1'))
    const out = listing({ tools })
    expect(out.recent).toHaveLength(30)
    expect(out.recent[0].id).toBe('e34')
  })
})
