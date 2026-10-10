/**
 * The stacked diffs' patches (worktree design §3.5): only the comparison's
 * file list comes first; patches are read in batches (at most 40 paths and
 * 512 KB by estimate per request, two requests at a time) for the files near
 * the viewport, or for every file while the find bar searches. A generation
 * counter drops answers to a listing that has since been replaced (zcode's
 * way); patches are cached under `mode:base:target:path`, and a new listing
 * marks them stale, so a file in view keeps its old patch on screen while it
 * is read again. A file whose patch was widened to the whole file (展开 N 行)
 * is read whole again.
 */
import type { GitCompareFile, GitDiff } from '@/api/git-api'
import type { DiffLine } from '@/lib/diff'
import { patchBatches, type CompareMode, estimateBytes, isFolderRow, patchKey } from './compare-model'

/** A section's diff: git's patch, or rows computed here from texts Rna recorded (本次对话的改动), drawn as they are. */
export type SectionDiff = GitDiff & { lines?: DiffLine[] }

export interface PatchEntry {
  diff?: SectionDiff
  loading: boolean
  error?: string
  /** Read for an older listing: shown until the new read lands. */
  stale?: boolean
  /** Read with the whole file as context. */
  full?: boolean
}

/**
 * What the stacked diffs read their sections from, by file key: PatchStore for git's listing (keys are paths),
 * RnaDiffs for Rna's own records. `version` changes whenever an entry does.
 */
export interface DiffSource {
  subscribe: (listener: () => void) => () => void
  getVersion: () => number
  entry: (key: string) => PatchEntry
  /** Read these files' diffs unless they are read or on their way. */
  want: (keys: readonly string[]) => void
  /** Read more for the find bar, up to `budget` characters; whether every file with text is read or on its way. */
  wantAll: (budget: number) => boolean
  /** Read one file again with all of it as context (展开 N 行). */
  expand: (key: string) => void
  /** A read is on its way or waiting. */
  busy: () => boolean
}

export interface PatchScope { mode: CompareMode; base: string; target: string | null }
export interface PatchFetchers {
  batch: (base: string, paths: string[], oldPaths: string[]) => Promise<{ path: string; diff: GitDiff }[]>
  full: (base: string, path: string, oldPath: string | undefined) => Promise<GitDiff>
}

/** Requests in flight at once. */
const PARALLEL = 2
/** Asks made within this long go out together (the drawn range grows over a few frames while sections are measured). */
const GATHER_MS = 24
/** Cached patches kept in all (any comparison); the oldest go first past it. */
const MAX_ENTRIES = 3000
const MAX_BYTES = 48 * 1024 * 1024
const EMPTY: PatchEntry = { loading: false }

export class PatchStore implements DiffSource {
  private entries = new Map<string, PatchEntry>()
  private bytes = 0
  private files = new Map<string, GitCompareFile>()
  private scope: PatchScope | null = null
  private generation = 0
  private queue: string[] = []
  private queued = new Set<string>()
  /** Files a batch could not fit: each is asked for in a request of its own. */
  private alone = new Set<string>()
  private running = 0
  private listeners = new Set<() => void>()
  private version = 0

  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly fetchers: PatchFetchers, private readonly gatherMs = GATHER_MS) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private changed() { this.version++; for (const listener of this.listeners) listener() }

  /**
   * A listing arrived: the comparison it belongs to and its files. Answers to earlier requests are dropped from here
   * on, and what is cached for these files is kept but marked stale.
   */
  setListing(scope: PatchScope, files: readonly GitCompareFile[]) {
    this.generation++
    this.scope = scope
    this.files = new Map(files.map(file => [file.path, file]))
    this.queue = []; this.queued.clear(); this.alone.clear(); this.running = 0
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const file of files) {
      const key = this.key(file.path), entry = this.entries.get(key)
      if (entry) this.entries.set(key, { ...entry, loading: false, stale: true })
    }
    this.changed()
  }
  /** Forget the listing (another view took over); cached patches stay for when it comes back. */
  clear() {
    this.generation++; this.scope = null; this.files = new Map(); this.queue = []; this.queued.clear(); this.alone.clear(); this.running = 0
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.changed()
  }

  private key(path: string) { return patchKey(this.scope!.mode, this.scope!.base, this.scope!.target, path) }
  entry(path: string): PatchEntry { return this.scope ? this.entries.get(this.key(path)) ?? EMPTY : EMPTY }
  /** Characters of the current listing's patches read so far. */
  loadedBytes(): number {
    let total = 0
    if (this.scope) for (const path of this.files.keys()) total += this.entry(path).diff?.patch?.length ?? 0
    return total
  }
  /** Whether a request is on its way or waiting. */
  busy(): boolean { return this.running > 0 || this.queue.length > 0 }

  private put(key: string, entry: PatchEntry) {
    const before = this.entries.get(key)
    this.bytes += (entry.diff?.patch?.length ?? 0) - (before?.diff?.patch?.length ?? 0)
    this.entries.delete(key); this.entries.set(key, entry)
    for (const [old, value] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break
      if (old === key) continue
      this.bytes -= value.diff?.patch?.length ?? 0
      this.entries.delete(old)
    }
  }

  /** Read these files' patches unless they are read already (fresh) or on their way. Nothing for folders (another repository). */
  want(paths: readonly string[]) {
    if (!this.scope) return
    let added = false
    for (const path of paths) {
      const file = this.files.get(path)
      if (!file || isFolderRow(file) || this.queued.has(path)) continue
      const entry = this.entries.get(this.key(path))
      if (entry && (entry.loading || (entry.diff && !entry.stale) || (entry.error && !entry.stale))) continue
      this.queue.push(path); this.queued.add(path); added = true
    }
    if (added && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump() }, this.gatherMs)
  }

  /**
   * Read more of the listing for the find bar, in order, until `budget` characters are read or asked for. Returns
   * whether every file that has text is read or on its way.
   */
  wantAll(budget: number): boolean {
    if (!this.scope) return true
    let used = this.loadedBytes()
    const more: string[] = []
    let complete = true
    for (const file of this.files.values()) {
      if (file.binary || isFolderRow(file)) continue
      const entry = this.entry(file.path)
      if (entry.diff || entry.loading || this.queued.has(file.path)) continue
      const size = estimateBytes(file)
      if (used + size > budget) { complete = false; continue }
      used += size; more.push(file.path)
    }
    this.want(more)
    return complete
  }

  /**
   * Read one file again with the whole file as its context (展开 N 行). The entry is marked whole at once: a second
   * click asks nothing more, and a listing that lands meanwhile (which drops this answer) reads it whole again.
   */
  expand(path: string) {
    const scope = this.scope, file = this.files.get(path)
    if (!scope || !file) return
    const key = this.key(path), generation = this.generation, entry = this.entries.get(key)
    if (entry?.full && entry.loading) return
    this.put(key, { ...entry, loading: true, error: undefined, full: true })
    this.changed()
    this.fetchers.full(scope.base, path, file.oldPath).then(
      diff => { if (generation === this.generation) { this.put(key, { diff, loading: false, full: true }); this.changed() } },
      // It stays as it was read before (with 展开 N 行 offered again).
      (error: Error) => { if (generation === this.generation) { this.put(key, { ...this.entries.get(key), loading: false, error: error.message, full: entry?.full }); this.changed() } },
    )
  }

  private pump() {
    const scope = this.scope
    if (!scope) return
    while (this.running < PARALLEL && this.queue.length) {
      // A file read whole before is read whole again, on its own.
      const first = this.queue[0], firstEntry = this.entries.get(this.key(first))
      if (firstEntry?.full) { this.queue.shift(); this.queued.delete(first); this.running++; this.runFull(first); continue }
      const files = this.queue.filter(path => !this.entries.get(this.key(path))?.full && !this.alone.has(path)).map(path => this.files.get(path)!).filter(Boolean)
      const [batch] = this.alone.has(first) ? [[this.files.get(first)!]] : patchBatches(files)
      if (!batch) break
      const paths = new Set(batch.map(file => file.path))
      this.queue = this.queue.filter(path => !paths.has(path))
      for (const path of paths) this.queued.delete(path)
      this.running++
      this.runBatch(batch)
    }
  }

  private runFull(path: string) {
    const scope = this.scope!, key = this.key(path), generation = this.generation, file = this.files.get(path)
    this.put(key, { ...this.entries.get(key), loading: true })
    this.changed()
    this.fetchers.full(scope.base, path, file?.oldPath).then(
      diff => { if (generation === this.generation) this.put(key, { diff, loading: false, full: true }) },
      (error: Error) => { if (generation === this.generation) this.put(key, { ...this.entries.get(key), loading: false, error: error.message }) },
    ).finally(() => this.settle(generation))
  }

  private runBatch(batch: GitCompareFile[]) {
    const scope = this.scope!, generation = this.generation
    for (const file of batch) this.put(this.key(file.path), { ...this.entries.get(this.key(file.path)), loading: true, error: undefined })
    this.changed()
    const oldPaths = batch.flatMap(file => (file.oldPath ? [file.oldPath] : []))
    this.fetchers.batch(scope.base, batch.map(file => file.path), oldPaths).then(
      answer => {
        if (generation !== this.generation) return
        const got = new Map(answer.map(row => [row.path, row.diff]))
        const again: string[] = []
        for (const file of batch) {
          const key = this.key(file.path), diff = got.get(file.path)
          // The batch ran past the host's cap before this file: it is asked for on its own.
          if (diff?.kind === 'unavailable' && diff.reason === 'batch_too_large' && batch.length > 1) { this.put(key, { ...this.entries.get(key), loading: false }); again.push(file.path); continue }
          this.put(key, { diff: diff ?? { kind: 'unavailable' }, loading: false })
        }
        for (const path of again.reverse()) { this.queue.unshift(path); this.queued.add(path); this.alone.add(path) }
      },
      (error: Error) => {
        if (generation !== this.generation) return
        for (const file of batch) this.put(this.key(file.path), { ...this.entries.get(this.key(file.path)), loading: false, error: error.message })
      },
    ).finally(() => this.settle(generation))
  }

  private settle(generation: number) {
    if (generation !== this.generation) return
    this.running--
    this.changed()
    this.pump()
  }
}
