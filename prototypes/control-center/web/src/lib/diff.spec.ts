import { afterEach, describe, expect, it, vi } from 'vitest'

// The comparison itself is jsdiff's; one test makes it give up (its timeout) to reach the coarse tier.
const giveUp = vi.hoisted(() => ({ on: false, options: [] as unknown[] }))
vi.mock('diff', async original => {
  const real = await original<typeof import('diff')>()
  return { ...real, diffLines: (a: string, b: string, options?: unknown) => { giveUp.options.push(options); return giveUp.on ? undefined : real.diffLines(a, b, options as never) } }
})

const { computeDiff, DIFF_LIMITS, parsePatch, patchLines, snippetDiff } = await import('./diff')

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n')
afterEach(() => { giveUp.on = false; giveUp.options.length = 0 })

describe('snippetDiff: an edit call’s snippets', () => {
  it('a snippet’s last line without its newline is not a changed line', () => {
    // Snippets usually end mid-file without a newline: the same last line followed by more lines on the other side.
    expect([computeDiff('x = 1', 'x = 1\ny = 2').added, computeDiff('x = 1', 'x = 1\ny = 2').removed]).toEqual([2, 1])
    const snippet = snippetDiff('x = 1', 'x = 1\ny = 2')
    expect([snippet.added, snippet.removed]).toEqual([1, 0])
    expect(snippet.lines.map(line => `${line.type}:${line.text}`)).toEqual(['ctx:x = 1', 'add:y = 2'])
    expect(giveUp.options.at(-1)).toMatchObject({ ignoreNewlineAtEof: true })
    // A conflict block merged by an edit whose old snippet stops at the end of a line the new one continues past:
    // the four marker / old lines go and one line comes, the shared `three` is no change.
    const block = '<<<<<<< refs/rna/m/abc/this-conversation\ntwo\n=======\nTWO\n>>>>>>> refs/rna/m/abc/project-folder\nthree'
    const merged = snippetDiff(block, 'TWO\nthree\nfour')
    expect([merged.added, merged.removed]).toEqual([1, 4])
    expect([computeDiff(block, 'TWO\nthree\nfour').added, computeDiff(block, 'TWO\nthree\nfour').removed]).toEqual([2, 5])
    // Snippets that end with their newlines count as before.
    expect([snippetDiff('two\n', 'two\nx1\nx2\nx3\n').added, snippetDiff('two\n', 'two\nx1\nx2\nx3\n').removed]).toEqual([3, 0])
  })

  it('whole files keep a newline added or removed at the end as a change, and the two are cached apart', () => {
    expect([computeDiff('a\nb', 'a\nb\n').added, computeDiff('a\nb', 'a\nb\n').removed]).toEqual([1, 1])
    expect([snippetDiff('a\nb', 'a\nb\n').added, snippetDiff('a\nb', 'a\nb\n').removed]).toEqual([0, 0])
    expect(computeDiff('a\nb', 'a\nb\n')).not.toBe(snippetDiff('a\nb', 'a\nb\n'))
  })
})

describe('computeDiff tiers', () => {
  it('a small change: the full view with context and gap markers, counted', () => {
    const before = lines(30), after = before.replace('line 15', 'LINE 15')
    const diff = computeDiff(before, after)
    expect(diff.tier).toBe('full')
    expect([diff.added, diff.removed]).toEqual([1, 1])
    // A gap says how many unchanged lines it hides: what 展开 N 行 would reveal.
    expect(diff.lines[0]).toEqual({ type: 'gap', text: '12 行未改动', skipped: 12 })
    expect(diff.lines.filter(line => line.type === 'ctx')).toHaveLength(6)
    expect(diff.lines.at(-1)).toEqual({ type: 'gap', text: '11 行未改动', skipped: 11 })
    expect(computeDiff(before, after)).toBe(diff) // memoized
    expect(giveUp.options[0]).toEqual({ timeout: DIFF_LIMITS.timeoutMs })
  })

  it('over 1200 lines or 180k characters: the changed stretches only, said once at the top', () => {
    const before = lines(1500), after = before.replace('line 700\n', 'line 700 changed\n')
    const diff = computeDiff(before, after)
    expect(diff.tier).toBe('hunks')
    expect(diff.lines[0]).toEqual({ type: 'gap', text: '文件较大，只显示改动的部分。' }) // a note hides nothing: no skipped
    expect([diff.added, diff.removed]).toEqual([1, 1])
    expect(diff.lines.length).toBeLessThan(12)
    const wide = 'x'.repeat(100_000)
    expect(computeDiff(`${wide}\na`, `${wide}\nb`).tier).toBe('hunks')
  })

  it('past 5000 lines nothing is compared and the view says so; counts are the cheap upper bound', () => {
    const before = lines(6000), after = before.replace('line 3000\n', 'line 3000 changed\n')
    giveUp.options.length = 0
    const diff = computeDiff(before, after)
    expect(diff.tier).toBe('over')
    expect(giveUp.options).toHaveLength(0)
    expect(diff.lines).toEqual([{ type: 'gap', text: '文件有 6000 行，太大了，这里不显示差异。' }])
    expect([diff.added, diff.removed]).toEqual([1, 1])
    expect(computeDiff('', lines(5001)).added).toBe(5001)
  })

  it('a comparison past its time budget falls back to one coarse replacement between the common start and end', () => {
    giveUp.on = true
    const diff = computeDiff('a\nb\nc\nd\ne', 'a\nB\nC\nd\ne')
    expect(diff.tier).toBe('coarse')
    expect(diff.lines[0].type).toBe('gap')
    expect(diff.lines.slice(1).map(line => `${line.type}:${line.text}`)).toEqual(['ctx:a', 'del:b', 'del:c', 'add:B', 'add:C', 'ctx:d', 'ctx:e'])
    expect([diff.added, diff.removed]).toEqual([2, 2])
  })

  it('keeps the output Review and ChangeReview rely on for new files and edits', () => {
    const created = computeDiff('', 'one\ntwo\n')
    expect(created).toMatchObject({ tier: 'full', added: 2, removed: 0 })
    expect(created.lines.map(line => [line.type, line.newNo])).toEqual([['add', 1], ['add', 2]])
    const edit = computeDiff('a\nb\nc\n', 'a\nx\nc\n')
    expect(edit.lines.map(line => `${line.type}${line.oldNo ?? ''}/${line.newNo ?? ''}:${line.text}`)).toEqual(['ctx1/1:a', 'del2/:b', 'add/2:x', 'ctx3/3:c'])
  })
})

describe('patchLines', () => {
  it('reads a git patch: headers dropped, hunks introduced by where they start, numbers carried', () => {
    const patch = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@ function demo() {\n one\n-two\n+TWO\n three\n+four\n\\ No newline at end of file\n'
    const parsed = patchLines(patch)
    expect(parsed.capped).toBe(false)
    expect([parsed.added, parsed.removed]).toEqual([2, 1])
    expect(parsed.lines.map(line => `${line.type}${line.oldNo ?? ''}/${line.newNo ?? ''}:${line.text}`)).toEqual([
      'gap/:第 1 行起 · function demo() {', 'ctx1/1:one', 'del2/:two', 'add/2:TWO', 'ctx3/3:three', 'add/4:four',
    ])
  })

  it('stops after 5000 lines and says so', () => {
    const big = `@@ -0,0 +1,6000 @@\n${Array.from({ length: 6000 }, (_, i) => `+${i}`).join('\n')}\n`
    const parsed = patchLines(big)
    expect(parsed.capped).toBe(true)
    expect(parsed.lines).toHaveLength(DIFF_LIMITS.maxLines + 1)
    expect(parsed.lines.at(-1)?.text).toBe('改动超过 5000 行，后面的不再显示。')
  })

  it('reads a combined (conflict) hunk header and the next file of a multi-file patch', () => {
    const parsed = patchLines('@@@ -1,2 -1,2 +1,3 @@@\n  base\n++mine\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -5 +5 @@\n-x\n+y\n')
    expect(parsed.lines.map(line => line.type)).toEqual(['gap', 'ctx', 'add', 'gap', 'del', 'add'])
    expect(parsed.lines[3].text).toBe('第 5 行起')
  })
})

describe('parsePatch', () => {
  const two = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -3,4 +3,5 @@ export function demo() {', ' keep', '-old', '+new', '+added', ' keep', ' keep',
    '@@ -20 +21 @@', '-x', '+y',
    '@@ -30,0 +32,2 @@ tail', '+p', '+q',
  ].join('\n') + '\n'

  it('reads each hunk with its header numbers, git context and every row numbered on its side', () => {
    const parsed = parsePatch(two)
    expect(parsed).toMatchObject({ added: 5, removed: 2, capped: false, binary: false })
    expect(parsed.hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.context])).toEqual([
      [3, 4, 3, 5, 'export function demo() {'], [20, 1, 21, 1, ''], [30, 0, 32, 2, 'tail'],
    ])
    expect(parsed.hunks[0].lines.map(line => `${line.type}${line.oldNo ?? ''}/${line.newNo ?? ''}:${line.text}`)).toEqual([
      'ctx3/3:keep', 'del4/:old', 'add/4:new', 'add/5:added', 'ctx5/6:keep', 'ctx6/7:keep',
    ])
    expect(parsed.hunks[2].lines.map(line => `${line.type}/${line.newNo}`)).toEqual(['add/32', 'add/33'])
  })

  it('counts the unchanged lines before each hunk (a hunk that removes nothing follows its line)', () => {
    // Lines 1-2 before the first; 7-19 between the first two; 21-30 before an insertion after line 30.
    expect(parsePatch(two).hunks.map(h => h.skipped)).toEqual([2, 13, 10])
    expect(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b\n').hunks[0].skipped).toBe(0) // a new file
    expect(parsePatch('@@ -1,2 +1,2 @@\n-a\n+b\n c\n').hunks[0].skipped).toBe(0)
  })

  it('starts the count over at the next file of a multi-file patch', () => {
    const parsed = parsePatch('@@ -50 +50 @@\n-a\n+b\ndiff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -4 +4 @@\n-c\n+d\n')
    expect(parsed.hunks.map(h => h.skipped)).toEqual([49, 3])
  })

  it('says when git reports a binary file, with no hunks', () => {
    expect(parsePatch('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n')).toMatchObject({ hunks: [], binary: true })
    expect(parsePatch('diff --git a/i.png b/i.png\nGIT binary patch\nliteral 4\nLcmZ?d00001\n').binary).toBe(true)
  })

  it('stops after 5000 rows, hunk headers included, as patchLines does', () => {
    const big = `@@ -0,0 +1,6000 @@\n${Array.from({ length: 6000 }, (_, i) => `+${i}`).join('\n')}\n`
    const parsed = parsePatch(big)
    expect(parsed.capped).toBe(true)
    expect(parsed.hunks[0].lines).toHaveLength(DIFF_LIMITS.maxLines - 1)
    expect(parsed.added).toBe(DIFF_LIMITS.maxLines - 1)
  })

  it('gives patchLines its gaps: where each hunk starts, its context and what it hides', () => {
    const gaps = patchLines(two).lines.filter(line => line.type === 'gap')
    expect(gaps).toEqual([
      { type: 'gap', text: '第 3 行起 · export function demo() {', skipped: 2, context: 'export function demo() {' },
      { type: 'gap', text: '第 21 行起', skipped: 13 },
      { type: 'gap', text: '第 32 行起 · tail', skipped: 10, context: 'tail' },
    ])
  })
})
