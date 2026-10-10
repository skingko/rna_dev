import { diffLines } from 'diff'
import { t } from '@/i18n'

/**
 * One row of a diff. A `gap` row stands between hunks (or carries a note); when it stands for unchanged lines that are
 * not shown, `skipped` says how many (what "展开 N 行" would reveal), and a hunk read from a git patch keeps git's
 * function context in `context`.
 */
export type DiffLine = { type: 'add' | 'del' | 'ctx' | 'gap'; text: string; oldNo?: number; newNo?: number; skipped?: number; context?: string }

/**
 * How much of a comparison is shown (layout plan §3, zcode's patch limits):
 * - `full`: today's view, every change with its context.
 * - `hunks`: over {@link DIFF_LIMITS.hunkLines} lines or {@link DIFF_LIMITS.hunkChars} characters: the changed
 *   stretches only, introduced by a note (the same hunks; a full-file view would not be offered).
 * - `coarse`: the comparison ran past {@link DIFF_LIMITS.timeoutMs}: what differs between the common start and
 *   end is shown as one replacement, so the line counts are an upper bound.
 * - `over`: past {@link DIFF_LIMITS.maxLines} lines nothing is compared; one line says so.
 */
export type DiffTier = 'full' | 'hunks' | 'coarse' | 'over'

export interface FileDiff { lines: DiffLine[]; added: number; removed: number; tier: DiffTier }

export const DIFF_LIMITS = { hunkLines: 1200, hunkChars: 180_000, maxLines: 5000, timeoutMs: 100 } as const

/** Small comparisons are memoized by their text (they run on render); big ones are few and kept apart, so their long keys never pile up. */
const cache = new Map<string, FileDiff>()
const bigCache = new Map<string, FileDiff>()
const remember = (store: Map<string, FileDiff>, key: string, value: FileDiff, size: number) => {
  if (store.size >= size) store.delete(store.keys().next().value as string)
  store.set(key, value)
  return value
}

const split = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : [])
const lineCount = (text: string) => {
  if (!text) return 0
  let breaks = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks++
  return text.endsWith('\n') ? breaks : breaks + 1
}

/** Where two texts' lines stop matching from the start, and from the end. */
function commonEnds(a: string[], b: string[]) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  return { start, endA, endB }
}

/** The lines of a coarse comparison: the common start and end as context, everything between as one removal and one addition. */
function coarse(oldText: string, newText: string): DiffLine[] {
  const a = split(oldText), b = split(newText), { start, endA, endB } = commonEnds(a, b)
  const all: DiffLine[] = []
  for (let i = 0; i < start; i++) all.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 })
  for (let i = start; i < endA; i++) all.push({ type: 'del', text: a[i], oldNo: i + 1 })
  for (let i = start; i < endB; i++) all.push({ type: 'add', text: b[i], newNo: i + 1 })
  for (let i = endA, j = endB; i < a.length; i++, j++) all.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: j + 1 })
  return all
}

/** Collapse unchanged runs longer than 2*context into a gap marker. */
function collapse(all: DiffLine[], context: number): DiffLine[] {
  const keep = new Array(all.length).fill(false)
  all.forEach((line, i) => {
    if (line.type === 'ctx') return
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true
  })
  const lines: DiffLine[] = []
  let skipped = 0
  all.forEach((line, i) => {
    if (keep[i] || all.length <= context * 2 + 1) {
      if (skipped) lines.push({ type: 'gap', text: t('{skipped} 行未改动', { skipped }), skipped })
      skipped = 0
      lines.push(line)
    } else skipped++
  })
  if (skipped) lines.push({ type: 'gap', text: t('{skipped} 行未改动', { skipped }), skipped })
  return lines
}

/** Line diff with 3 lines of context, tiered by size and time (see {@link DiffTier}); memoized because it runs on render. */
export function computeDiff(oldText: string, newText: string, context = 3): FileDiff {
  return diffTexts(oldText, newText, context, false)
}

/**
 * The diff of an edit's snippets (`oldText` → `newText` of one edit call, not whole files): a snippet usually ends
 * without its line's newline, so the last line of one side and the same line followed by more lines on the other
 * would otherwise read as one line removed and added again (jsdiff `ignoreNewlineAtEof`). Whole-file comparisons
 * keep using {@link computeDiff}, where a newline added or removed at the end is a real change.
 */
export function snippetDiff(oldText: string, newText: string, context = 3): FileDiff {
  return diffTexts(oldText, newText, context, true)
}

function diffTexts(oldText: string, newText: string, context: number, snippet: boolean): FileDiff {
  const key = `${context}\u0000${snippet ? 's' : 'f'}\u0000${oldText}\u0000${newText}`
  const hit = cache.get(key) ?? bigCache.get(key)
  if (hit) return hit
  const lines = Math.max(lineCount(oldText), lineCount(newText))
  const big = lines > DIFF_LIMITS.hunkLines || oldText.length + newText.length > DIFF_LIMITS.hunkChars
  if (lines > DIFF_LIMITS.maxLines) {
    // Not compared at all; the counts are the cheap upper bound of the coarse view (exact for a new or emptied file).
    const { start, endA, endB } = commonEnds(split(oldText), split(newText))
    return remember(bigCache, key, { lines: [{ type: 'gap', text: t('文件有 {lines} 行，太大了，这里不显示差异。', { lines }) }], added: endB - start, removed: endA - start, tier: 'over' }, 8)
  }
  const parts = diffLines(oldText, newText, { timeout: DIFF_LIMITS.timeoutMs, ...(snippet ? { ignoreNewlineAtEof: true } : {}) })
  let all: DiffLine[]
  let tier: DiffTier = big ? 'hunks' : 'full'
  if (!parts) { all = coarse(oldText, newText); tier = 'coarse' }
  else {
    all = []
    let oldNo = 1, newNo = 1
    for (const part of parts) {
      for (const text of part.value.replace(/\n$/, '').split('\n')) {
        if (part.added) all.push({ type: 'add', text, newNo: newNo++ })
        else if (part.removed) all.push({ type: 'del', text, oldNo: oldNo++ })
        else all.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
      }
    }
  }
  let added = 0, removed = 0
  for (const line of all) { if (line.type === 'add') added++; else if (line.type === 'del') removed++ }
  const shown = collapse(all, context)
  const note = tier === 'coarse' ? t('比较太慢，改成整段对照：开头和结尾相同的部分之间都算改动。') : tier === 'hunks' ? t('文件较大，只显示改动的部分。') : null
  const result: FileDiff = { lines: note ? [{ type: 'gap', text: note }, ...shown] : shown, added, removed, tier }
  return big || tier === 'coarse' ? remember(bigCache, key, result, 8) : remember(cache, key, result, 200)
}

/** One hunk of a unified patch, numbered from its `@@ -oldStart,oldLines +newStart,newLines @@` header. */
export interface PatchHunk {
  oldStart: number
  /** Lines of the old file the hunk covers (git leaves out a count of 1). */
  oldLines: number
  newStart: number
  newLines: number
  /** Git's function context after the header (`''` when there is none). */
  context: string
  /** Unchanged lines between the previous hunk (or the start of the file) and this one. */
  skipped: number
  /** The hunk's rows (`ctx`, `add`, `del`), each with its old and/or new line number. */
  lines: DiffLine[]
}

export interface ParsedPatch {
  hunks: PatchHunk[]
  added: number
  removed: number
  /** Reading stopped after {@link DIFF_LIMITS.maxLines} rows (hunk headers count as rows). */
  capped: boolean
  /** Git said the file is binary ("Binary files … differ" or a binary patch): there are no hunks to show. */
  binary: boolean
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? (?:-\d+(?:,\d+)? )*\+(\d+)(?:,(\d+))? @@+(.*)$/

/**
 * A unified patch (git's `diff` output) read hunk by hunk: file headers dropped, every row numbered on its side(s),
 * at most {@link DIFF_LIMITS.maxLines} rows. A multi-file patch is read as consecutive hunks; `skipped` starts over
 * at each `diff` header.
 */
export function parsePatch(patch: string): ParsedPatch {
  const hunks: PatchHunk[] = []
  let hunk: PatchHunk | null = null
  let oldNo = 0, newNo = 0, added = 0, removed = 0, rows = 0, capped = false, binary = false
  /** The first old line after the previous hunk. */
  let next = 1
  const all = patch.split('\n')
  if (all.at(-1) === '') all.pop()
  for (const row of all) {
    if (rows >= DIFF_LIMITS.maxLines) { capped = true; break }
    const header = HUNK_HEADER.exec(row)
    if (header) {
      const oldStart = Number(header[1]), oldLines = header[2] === undefined ? 1 : Number(header[2])
      const newStart = Number(header[3]), newLines = header[4] === undefined ? 1 : Number(header[4])
      // A hunk that removes nothing names the line it follows (`-5,0`), so its old side starts one later.
      const first = oldLines === 0 ? oldStart + 1 : oldStart
      hunk = { oldStart, oldLines, newStart, newLines, context: header[5].trim(), skipped: Math.max(0, first - next), lines: [] }
      next = first + oldLines
      hunks.push(hunk); rows++
      oldNo = oldStart; newNo = newStart
      continue
    }
    if (!hunk) {
      if (row.startsWith('Binary files ') || row === 'GIT binary patch') binary = true
      if (row.startsWith('diff ')) next = 1
      continue
    }
    if (row.startsWith('\\')) continue
    if (row.startsWith('diff ')) { hunk = null; next = 1; continue }
    const mark = row[0], text = row.slice(1)
    if (mark === '+') { hunk.lines.push({ type: 'add', text, newNo: newNo++ }); added++ }
    else if (mark === '-') { hunk.lines.push({ type: 'del', text, oldNo: oldNo++ }); removed++ }
    else hunk.lines.push({ type: 'ctx', text: mark === ' ' ? text : row, oldNo: oldNo++, newNo: newNo++ })
    rows++
  }
  return { hunks, added, removed, capped, binary }
}

/** The gap row that introduces a hunk: where it starts, git's context, and how many unchanged lines lie before it. */
function hunkGap(hunk: PatchHunk): DiffLine {
  const gap: DiffLine = { type: 'gap', text: hunk.context ? t('第 {line} 行起 · {context}', { line: hunk.newStart, context: hunk.context }) : t('第 {line} 行起', { line: hunk.newStart }) }
  if (hunk.skipped) gap.skipped = hunk.skipped
  if (hunk.context) gap.context = hunk.context
  return gap
}

/** A unified patch (git's `diff` output) as diff lines: file headers dropped, each hunk introduced by a gap, at most {@link DIFF_LIMITS.maxLines} lines. */
export function patchLines(patch: string): { lines: DiffLine[]; added: number; removed: number; capped: boolean } {
  const { hunks, added, removed, capped } = parsePatch(patch)
  const lines: DiffLine[] = []
  for (const hunk of hunks) {
    lines.push(hunkGap(hunk))
    for (const line of hunk.lines) lines.push(line)
  }
  if (capped) lines.push({ type: 'gap', text: t('改动超过 {max} 行，后面的不再显示。', { max: DIFF_LIMITS.maxLines }) })
  return { lines, added, removed, capped }
}
