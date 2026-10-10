/**
 * 本次对话的改动's diffs (worktree design §3.5 layout, Rna's own records): the stacked diffs read their sections from
 * here instead of git. A turn's edits and writes carry their old and new text in the tool arguments, and a
 * background change set read through the change-review API carries its own before and after, so those rows are
 * computed here (the same comparison 审阅 shows) and drawn at once; 展开 N 行 compares them again with all of the
 * text as context. A set made in a background worktree is read from its apply record's patches, in batches of at
 * most 40 paths, two requests at a time. Entries are kept while a file's input stays the same, so a new turn's
 * edits do not redraw the older ones.
 */
import { MAX_APPLY_PATCH_PATHS } from '@/api/worktree-api'
import type { GitDiff } from '@/api/git-api'
import { computeDiff, snippetDiff, type DiffLine } from '@/lib/diff'
import { t } from '@/i18n'
import { estimateBytes, keyOf, type StackFile } from './compare-model'
import type { DiffSource, PatchEntry, SectionDiff } from './patch-store'

/** Where one of Rna's recorded file changes is read from. */
export type RnaDiffInput =
  /** A turn's edits and writes of the file, in order; null: a whole-file write over text that was not recorded. */
  | { kind: 'edits'; parts: ({ oldText: string; newText: string } | null)[] }
  /** A background change set as the work left it: its own before and after (`truncated`: the texts were cut short). */
  | { kind: 'snapshot'; before: string; after: string; binary: boolean; truncated: boolean; changedSince: boolean }
  /** A change set made in a background worktree: its apply record's patch, read from the host. */
  | { kind: 'apply'; applyId: string; path: string }
  /** The set's files are being read. */
  | { kind: 'loading' }
  /** Nothing to compare: the sentence that says why (rolled back or expired, the read failed). */
  | { kind: 'note'; message: string }

const EMPTY: PatchEntry = { loading: false }
const LOADING: PatchEntry = { loading: true }
/** Requests in flight at once. */
const PARALLEL = 2
/** Asks made within this long go out together (the drawn range grows over a few frames while sections are measured). */
const GATHER_MS = 24
/** Context wide enough to show every line (展开 N 行). */
const ALL = 1_000_000

/** Whether two inputs read the same diff (a file's entry is kept across listings while they do). */
export function sameInput(a: RnaDiffInput | undefined, b: RnaDiffInput | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'edits': {
      const other = (b as typeof a).parts
      return a.parts.length === other.length && a.parts.every((part, i) => (part === null ? other[i] === null : other[i] !== null && part.oldText === other[i]!.oldText && part.newText === other[i]!.newText))
    }
    case 'snapshot': {
      const other = b as typeof a
      return a.before === other.before && a.after === other.after && a.binary === other.binary && a.truncated === other.truncated && a.changedSince === other.changedSince
    }
    case 'apply': return a.applyId === (b as typeof a).applyId && a.path === (b as typeof a).path
    case 'note': return a.message === (b as typeof a).message
    case 'loading': return true
  }
}

const overwritten = () => t('覆盖了整个文件，之前的内容没有记录，所以没有差异可看。')

/** A diff computed from recorded texts (`full`: with every line as context); null for one read from the host. */
export function localEntry(input: RnaDiffInput, full = false): PatchEntry | null {
  const context = full ? ALL : 3
  switch (input.kind) {
    case 'apply': return null
    case 'loading': return LOADING
    case 'note': return { diff: { kind: 'unavailable', message: input.message }, loading: false }
    case 'snapshot': {
      if (input.binary) return { diff: { kind: 'binary' }, loading: false }
      const lines = computeDiff(input.before, input.after, context).lines
      const note: DiffLine[] = input.changedSince ? [{ type: 'gap', text: t('这个文件之后又改过：这里是这次后台工作做的改动。') }] : []
      const diff: SectionDiff = { kind: input.truncated ? 'truncated' : 'patch', lines: [...note, ...lines] }
      return { diff, loading: false, full }
    }
    case 'edits': {
      if (input.parts.every(part => part === null)) return { diff: { kind: 'unavailable', message: overwritten() }, loading: false }
      const many = input.parts.length > 1
      const lines: DiffLine[] = []
      input.parts.forEach((part, i) => {
        // Each edit of the file in the turn under its own heading, in the order they were made.
        if (many) lines.push({ type: 'gap', text: t('第 {n} 次修改', { n: i + 1 }) })
        if (part === null) lines.push({ type: 'gap', text: overwritten() })
        else lines.push(...snippetDiff(part.oldText, part.newText, context).lines)
      })
      return { diff: { kind: 'patch', lines }, loading: false, full }
    }
  }
}

export class RnaDiffs implements DiffSource {
  private files = new Map<string, StackFile>()
  private inputs = new Map<string, RnaDiffInput>()
  /** Entries by file key, with the input each was made from. */
  private entries = new Map<string, { input: RnaDiffInput; entry: PatchEntry }>()
  private queue: string[] = []
  private queued = new Set<string>()
  /** Files a batch could not fit: each is asked for on its own. */
  private alone = new Set<string>()
  private running = 0
  private listeners = new Set<() => void>()
  private version = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly readPatches: (applyId: string, paths: string[]) => Promise<{ path: string; diff: GitDiff }[]>, private readonly gatherMs = GATHER_MS) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private changed() { this.version++; for (const listener of this.listeners) listener() }

  /** The listing changed: entries whose input changed are dropped (and read again when wanted). */
  setListing(files: readonly StackFile[], inputs: ReadonlyMap<string, RnaDiffInput>) {
    this.files = new Map(files.map(file => [keyOf(file), file]))
    this.inputs = new Map(inputs)
    for (const [key, held] of this.entries) if (!sameInput(held.input, this.inputs.get(key))) this.entries.delete(key)
    this.queue = this.queue.filter(key => this.inputs.get(key)?.kind === 'apply')
    this.queued = new Set(this.queue)
    this.changed()
  }

  /** A computed diff is made on first ask (and kept); one read from the host is empty until it arrives. */
  entry(key: string): PatchEntry {
    const held = this.entries.get(key)
    if (held) return held.entry
    const input = this.inputs.get(key)
    const local = input ? localEntry(input) : null
    if (!input || !local) return EMPTY
    this.entries.set(key, { input, entry: local })
    return local
  }

  want(keys: readonly string[]) {
    let added = false
    for (const key of keys) {
      const input = this.inputs.get(key)
      if (input?.kind !== 'apply' || this.queued.has(key) || this.entries.has(key)) continue
      this.queue.push(key); this.queued.add(key); added = true
    }
    if (added && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump() }, this.gatherMs)
  }

  wantAll(budget: number): boolean {
    let used = 0, complete = true
    const more: string[] = []
    for (const [key, file] of this.files) {
      const entry = this.entry(key)
      used += entry.diff?.patch?.length ?? 0
      if (entry.diff || entry.loading || this.queued.has(key) || this.inputs.get(key)?.kind !== 'apply' || file.binary) continue
      const size = estimateBytes(file)
      if (used + size > budget) { complete = false; continue }
      used += size; more.push(key)
    }
    this.want(more)
    return complete
  }

  expand(key: string) {
    const input = this.inputs.get(key)
    const whole = input ? localEntry(input, true) : null
    if (!input || !whole) return
    this.entries.set(key, { input, entry: whole })
    this.changed()
  }

  busy(): boolean { return this.running > 0 || this.queue.length > 0 }

  /** Clear timers (the view went away). */
  dispose() { if (this.timer) { clearTimeout(this.timer); this.timer = null } this.queue = []; this.queued.clear() }

  private pump() {
    while (this.running < PARALLEL && this.queue.length) {
      const first = this.queue[0], input = this.inputs.get(first)
      if (input?.kind !== 'apply') { this.queue.shift(); this.queued.delete(first); continue }
      const batch = this.alone.has(first) ? [first]
        : this.queue.filter(key => { const other = this.inputs.get(key); return other?.kind === 'apply' && other.applyId === input.applyId && !this.alone.has(key) }).slice(0, MAX_APPLY_PATCH_PATHS)
      const taken = new Set(batch)
      this.queue = this.queue.filter(key => !taken.has(key))
      for (const key of batch) this.queued.delete(key)
      this.running++
      this.run(input.applyId, batch)
    }
  }

  private run(applyId: string, keys: string[]) {
    const asked = keys.map(key => ({ key, input: this.inputs.get(key) as Extract<RnaDiffInput, { kind: 'apply' }> }))
    for (const { key, input } of asked) this.entries.set(key, { input, entry: LOADING })
    this.changed()
    // Each answer lands only on a file whose input is still the one asked about.
    const current = (key: string, input: RnaDiffInput) => sameInput(this.inputs.get(key), input)
    this.readPatches(applyId, asked.map(row => row.input.path)).then(
      answer => {
        const got = new Map(answer.map(row => [row.path, row.diff]))
        for (const { key, input } of asked) {
          if (!current(key, input)) { this.entries.delete(key); continue }
          const diff = got.get(input.path)
          // The batch ran past the host's cap before this file: it is asked for on its own.
          if (diff?.kind === 'unavailable' && diff.reason === 'batch_too_large' && asked.length > 1) {
            this.entries.delete(key); this.alone.add(key); this.queue.unshift(key); this.queued.add(key)
            continue
          }
          // No wider context can be asked for an apply record's patch: 展开 is not offered.
          this.entries.set(key, { input, entry: { diff: diff ?? { kind: 'unavailable' }, loading: false, full: true } })
        }
      },
      (error: Error) => {
        for (const { key, input } of asked) {
          if (current(key, input)) this.entries.set(key, { input, entry: { loading: false, error: error.message } })
          else this.entries.delete(key)
        }
      },
    ).finally(() => { this.running--; this.changed(); this.pump() })
  }
}
