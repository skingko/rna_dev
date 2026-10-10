/** The comparison's pure part (worktree design §3): defaults, the chip's words, the tree, batches, heights and find. */
import { describe, expect, it } from 'vitest'
import { patchLines } from '@/lib/diff'
import { t } from '@/i18n'
import {
  BATCH_BYTES, BATCH_QUERY_CHARS, buildTree, estimateBytes, estimateSection, fileOrder, findMatches, flatTree, FOLD_LINES, foldersOf, groupedTree, groupFileKey, HEADER_H, isFolded, LINE_H,
  patchBase, patchBatches, patchKey, queryChars, resolveView, targetLabel, treeRows, type StackFile, type StackGroup,
} from './compare-model'

const file = (path: string, patch: Partial<StackFile> = {}): StackFile => ({ path, status: 'M', added: 1, removed: 1, ...patch })

describe('the view', () => {
  it('fills in defaults: 全部改动 in a repository, only 本次对话的改动 without one, wrap on, the new line numbers', () => {
    expect(resolveView({}, true)).toEqual({ mode: 'all', base: null, target: null, tree: null, grouped: false, wrap: true, numbers: 'new' })
    expect(resolveView({ mode: 'uncommitted', grouped: true, wrap: false, numbers: 'both', base: 'dev', target: '/w/x', tree: false }, true))
      .toEqual({ mode: 'uncommitted', base: 'dev', target: '/w/x', tree: false, grouped: true, wrap: false, numbers: 'both' })
    expect(resolveView({ mode: 'all' }, false).mode).toBe('rna')
  })

  it('names the target as the chip reads it, and where patches start', () => {
    expect(targetLabel({ kind: 'working-tree', label: 'main' }, t)).toBe('本地工作目录')
    expect(targetLabel({ kind: 'detached', label: 'c0b2953' }, t)).toBe('c0b2953')
    expect(targetLabel({ kind: 'branch', label: 'rna/fix' }, t)).toBe('rna/fix')
    expect(targetLabel(null, t)).toBe('…')
    expect(patchBase('all', { mergeBase: 'abc' })).toBe('abc')
    expect(patchBase('all', { mergeBase: null })).toBe('HEAD') // no commit yet
    expect(patchBase('uncommitted', { mergeBase: 'abc' })).toBe('HEAD')
    expect(patchKey('all', 'abc', null, 'src/a.ts')).toBe('all:abc::src/a.ts')
    expect(patchKey('uncommitted', 'HEAD', '/w/x', 'src/a.ts')).toBe('uncommitted:HEAD:/w/x:src/a.ts')
  })
})

describe('the tree', () => {
  const files = [
    file('site/app/[lang]/(home)/page.tsx'), file('site/app/[lang]/(home)/layout.tsx'), file('site/app/[lang]/(home)/changelog/page.tsx'),
    file('site/app/api/search/route.ts'), file('site/app/not-found.tsx'), file('.agents/skills/design/SKILL.md'), file('README.md'), file('vendor/lib/', { added: null, removed: null }),
  ]
  const root = buildTree(files)
  const shown = (rows: ReturnType<typeof treeRows>) => rows.map(row => `${'  '.repeat(row.depth)}${row.kind === 'folder' ? `${row.name}/` : row.name}`)

  it('compacts chains of single-child folders, lists folders before files in byte order (as Claude’s panel does)', () => {
    expect(shown(treeRows(root, new Set()))).toEqual([
      '.agents/skills/design/', '  SKILL.md',
      'site/app/', '  [lang]/(home)/', '    changelog/', '      page.tsx', '    layout.tsx', '    page.tsx', '  api/search/', '    route.ts', '  not-found.tsx',
      'vendor/', '  lib/',
      'README.md',
    ])
    // A compacted row is keyed by its deepest folder.
    expect(treeRows(root, new Set()).find(row => row.name === '[lang]/(home)')?.path).toBe('site/app/[lang]/(home)')
  })

  it('leaves a collapsed folder’s rows out; with `only`, files outside it and folders holding none of it', () => {
    expect(shown(treeRows(root, new Set(['site/app'])))).toEqual(['.agents/skills/design/', '  SKILL.md', 'site/app/', 'vendor/', '  lib/', 'README.md'])
    expect(shown(treeRows(root, new Set(), new Set(['site/app/api/search/route.ts', 'README.md'])))).toEqual(['site/app/', '  api/search/', '    route.ts', 'README.md'])
  })

  it('the diffs stack in the tree’s order; a file’s folders are named outermost first', () => {
    expect(fileOrder(root).map(row => row.path)).toEqual([
      '.agents/skills/design/SKILL.md', 'site/app/[lang]/(home)/changelog/page.tsx', 'site/app/[lang]/(home)/layout.tsx', 'site/app/[lang]/(home)/page.tsx',
      'site/app/api/search/route.ts', 'site/app/not-found.tsx', 'vendor/lib/', 'README.md',
    ])
    expect(foldersOf(root, 'site/app/[lang]/(home)/changelog/page.tsx')).toEqual(['site/app', 'site/app/[lang]/(home)', 'site/app/[lang]/(home)/changelog'])
  })
})

describe('the tree grouped by turn and run (本次对话的改动)', () => {
  const group = (key: string, paths: string[]): StackGroup => ({ key, kind: key.startsWith('turn') ? 'turn' : 'change', label: key, files: paths.map(path => file(path, { key: groupFileKey(key, path), group: key })) })
  const model = groupedTree([group('turn:t2', ['src/app/a.ts', 'README.md']), group('change:bg-1', ['src/app/a.ts'])])

  it('a row per group in the order given, its files’ tree one level in with keys of its own; the diffs stack group by group', () => {
    expect(model.rows(new Set()).map(row => `${'  '.repeat(row.depth)}${row.kind}:${row.path}`)).toEqual([
      'group:turn:t2', '  folder:turn:t2:src/app', '    file:turn:t2:src/app/a.ts', '  file:turn:t2:README.md',
      'group:change:bg-1', '  folder:change:bg-1:src/app', '    file:change:bg-1:src/app/a.ts',
    ])
    expect(model.order.map(row => row.key)).toEqual(['turn:t2:src/app/a.ts', 'turn:t2:README.md', 'change:bg-1:src/app/a.ts'])
  })

  it('folds a group or one of its folders by key; `only` leaves out groups holding no match; holders open a file’s group and folders', () => {
    expect(model.rows(new Set(['turn:t2', 'change:bg-1:src/app'])).map(row => row.path)).toEqual(['turn:t2', 'change:bg-1', 'change:bg-1:src/app'])
    expect(model.rows(new Set(), new Set(['change:bg-1:src/app/a.ts'])).map(row => row.path)).toEqual(['change:bg-1', 'change:bg-1:src/app', 'change:bg-1:src/app/a.ts'])
    expect(model.holders('change:bg-1:src/app/a.ts')).toEqual(['change:bg-1', 'change:bg-1:src/app'])
    expect(model.holders('nowhere')).toEqual([])
    // Git's listing: one tree, keyed by path.
    expect(flatTree([file('src/x.ts')]).holders('src/x.ts')).toEqual(['src'])
  })
})

describe('batches and heights', () => {
  it('guesses a patch’s size from its line counts; an uncounted new file as a whole MB', () => {
    expect(estimateBytes(file('a', { added: 10, removed: 0 }))).toBe(256 + 16 * 64)
    expect(estimateBytes(file('a', { binary: true, added: null, removed: null }))).toBe(256)
    expect(estimateBytes(file('a', { added: null, removed: null, untracked: true }))).toBe(1024 * 1024)
  })

  it('packs at most 40 paths and 512 KB a request; a file larger than that goes alone, after the others', () => {
    const many = Array.from({ length: 95 }, (_, i) => file(`f${i}`))
    expect(patchBatches(many).map(batch => batch.length)).toEqual([40, 40, 15])
    const big = file('big', { added: 5000, removed: 0 }), huge = file('new', { added: null, removed: null, untracked: true })
    expect(estimateBytes(big)).toBeLessThan(BATCH_BYTES)
    expect(2 * estimateBytes(big)).toBeGreaterThan(BATCH_BYTES)
    expect(patchBatches([file('a'), huge, big, file('b'), big, file('c')]).map(batch => batch.map(row => row.path))).toEqual([['a', 'big', 'b'], ['big', 'c'], ['new']])
  })

  it('keeps a request’s paths short enough for the host to read (non-Latin names encode at 9 characters a letter)', () => {
    // 40 chapters with long Chinese names, some moved: in one request their query alone would pass the host's 16 KB.
    const chapters = Array.from({ length: 40 }, (_, i) => file(`作品/长篇小说·山河故人/正文/第三卷 风起云涌，山雨欲来/第${i + 1}章 夜雨潇潇，故人归来，旧事重提.md`, i % 4 ? {} : { oldPath: `作品/长篇小说·山河故人/草稿/第${i + 1}章.md` }))
    expect(chapters.reduce((sum, row) => sum + queryChars(row), 0)).toBeGreaterThan(16 * 1024)
    const batches = patchBatches(chapters)
    expect(batches.flat()).toEqual(chapters)
    for (const batch of batches) expect(batch.reduce((sum, row) => sum + queryChars(row), 0)).toBeLessThanOrEqual(BATCH_QUERY_CHARS)
    expect(queryChars(file('a/b.ts', { oldPath: 'c.ts' }))).toBe('&path=a%2Fb.ts'.length + '&oldPath=c.ts'.length)
    // Short Latin paths still go 40 at a time.
    expect(patchBatches(Array.from({ length: 41 }, (_, i) => file(`src/f${i}.ts`))).map(batch => batch.length)).toEqual([40, 1])
  })

  it('folds a file of more than 1000 changed lines; guesses a section from its header and rows', () => {
    expect(isFolded(file('a', { added: FOLD_LINES, removed: 1 }))).toBe(true)
    expect(isFolded(file('a', { added: FOLD_LINES, removed: 0 }))).toBe(false)
    expect(isFolded(file('a', { added: 5000, removed: 0, binary: true }))).toBe(false)
    expect(estimateSection(file('a'), { collapsed: true, shown: false, lines: 99 })).toBe(HEADER_H)
    expect(estimateSection(file('a'), { collapsed: false, shown: false, lines: 10 })).toBe(HEADER_H + 12 + 10 * LINE_H)
    expect(estimateSection(file('a', { added: 3, removed: 1 }), { collapsed: false, shown: false, lines: null })).toBe(HEADER_H + 12 + 12 * LINE_H)
    expect(estimateSection(file('a', { added: 4000, removed: 0 }), { collapsed: false, shown: false, lines: null })).toBe(HEADER_H + 44)
  })
})

describe('find', () => {
  it('finds every occurrence ignoring case, in paths and diff rows (never in the gaps), in order', () => {
    const lines = patchLines('@@ -1,2 +1,2 @@ function newThing()\n keep new\n-old\n+New and new\n').lines
    expect(findMatches('NEW', [{ path: 'src/new.ts', lines }, { path: 'src/other.ts', lines: null }])).toEqual([
      { key: 'src/new.ts', line: -1, start: 4 },
      { key: 'src/new.ts', line: 1, start: 5 },
      { key: 'src/new.ts', line: 3, start: 0 },
      { key: 'src/new.ts', line: 3, start: 8 },
    ])
    expect(findMatches('', [{ path: 'a', lines }])).toEqual([])
    // A file listed once per group (本次对话的改动) is found by its own key; its path is what is searched.
    expect(findMatches('new', [{ key: 'turn:t1:src/new.ts', path: 'src/new.ts', lines: null }, { key: 'turn:t2:src/new.ts', path: 'src/new.ts', lines: null }]))
      .toEqual([{ key: 'turn:t1:src/new.ts', line: -1, start: 4 }, { key: 'turn:t2:src/new.ts', line: -1, start: 4 }])
  })
})
