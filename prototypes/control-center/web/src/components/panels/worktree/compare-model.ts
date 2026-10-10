/**
 * 工作区改动 panel, the comparison's pure part (worktree design §3): the tab's
 * view with its defaults, the comparison chip's words, the file tree
 * (single-child folder chains compacted into one row; 本次对话的改动 adds a
 * row per turn or background run above its files), the order the stacked
 * diffs follow, patch batches, section heights and find matches.
 */
import { MAX_PATCH_PATHS, type GitCompare, type GitCompareFile, type GitCompareTarget } from '@/api/git-api'
import type { DiffLine } from '@/lib/diff'
import type { WorktreeMode, WorktreeTabFields } from '@/store/side-panel-store'
import type { TFunction } from '@/i18n'

export type CompareMode = Exclude<WorktreeMode, 'rna'>

/** A tab's view with every default filled in. */
export interface PanelView {
  mode: WorktreeMode
  /** The branch asked for (null: the default branch). */
  base: string | null
  /** Another worktree's path (read-only), or null for the project folder. */
  target: string | null
  /** The tree's saved choice (null: by width). */
  tree: boolean | null
  grouped: boolean
  wrap: boolean
  numbers: 'new' | 'both'
}

/** Without git there is only 本次对话的改动; in a repository the default is 全部改动. */
export function resolveView(fields: WorktreeTabFields, git: boolean): PanelView {
  return {
    mode: git ? fields.mode ?? 'all' : 'rna',
    base: fields.base ?? null,
    target: fields.target ?? null,
    tree: fields.tree ?? null,
    grouped: fields.grouped ?? false,
    wrap: fields.wrap ?? true,
    numbers: fields.numbers ?? 'new',
  }
}

/** Below this width the tree is hidden by default and opens over the diffs. */
export const NARROW_PANEL = 520
export const TREE_WIDTH = 230
export const MIN_TREE_WIDTH = 160
/** The diffs keep at least this much width beside the tree. */
export const MIN_DIFF_WIDTH = 240
/** A file with more changed lines than this is folded behind 显示 N 行改动. */
export const FOLD_LINES = 1000
/** A patch request carries at most this many bytes by estimate (the host's own cap is 1 MB per call). */
export const BATCH_BYTES = 512 * 1024
/** A patch request's paths take at most this many characters of query: the host reads at most 16 KB of request line and headers. */
export const BATCH_QUERY_CHARS = 8 * 1024
/** While the find bar is open, patches are loaded up to this many bytes in all. */
export const FIND_BYTES = 5 * 1024 * 1024
/** Section heights before a section is measured: its header, then each diff row. */
export const HEADER_H = 32
export const LINE_H = 20

/**
 * One file section of the stacked diffs and one file row of the tree: a row of git's listing, or one of Rna's own
 * recorded changes (本次对话的改动), which lists a file once for every turn or background run that changed it.
 */
export interface StackFile extends GitCompareFile {
  /** Tells the same file in two groups apart (`<group>:<path>`); git's listing leaves it out (the path is the key). */
  key?: string
  /** The group it belongs to (`turn:<id>` / `change:<id>`): its label goes above the group's first section. */
  group?: string
  /** Written over whole while its earlier text was not recorded: no counts (已覆盖). */
  overwritten?: boolean
  /** A path a tool reported outside the conversation's folders: shown as it was reported, never opened. */
  external?: boolean
}
/** A file's identity in the tree, the diffs, the patch cache and find. */
export const keyOf = (file: Pick<StackFile, 'key' | 'path'>) => file.key ?? file.path
/** The key of a file in a group of Rna's view (the group's folders are keyed the same way, so a file's folders are found by prefix). */
export const groupFileKey = (group: string, path: string) => `${group}:${path}`

export const changedLines = (file: Pick<GitCompareFile, 'added' | 'removed'>) => (file.added ?? 0) + (file.removed ?? 0)
/** The file is shown folded until asked for (显示 N 行改动). */
export const isFolded = (file: GitCompareFile) => !file.binary && changedLines(file) > FOLD_LINES
/** A folder git lists as one row (a repository of its own inside this one): nothing to diff. */
export const isFolderRow = (file: Pick<GitCompareFile, 'path'>) => file.path.endsWith('/')

/** What a patch is read from: the comparison's merge base, or HEAD for uncommitted work (also before the first commit, when there is no merge base). */
export function patchBase(mode: CompareMode, compare: Pick<GitCompare, 'mergeBase'> | null): string {
  return mode === 'all' && compare?.mergeBase ? compare.mergeBase : 'HEAD'
}
/** The cache key of one file's patch: `mode:base:target:path`. */
export const patchKey = (mode: CompareMode, base: string, target: string | null, path: string) => `${mode}:${base}:${target ?? ''}:${path}`

/** The chip's target: 工作目录 when HEAD's branch is the base itself, the short id when detached, else the branch. */
export function targetLabel(target: GitCompareTarget | null | undefined, t: TFunction): string {
  if (!target) return '…'
  return target.kind === 'working-tree' ? t('本地工作目录') : target.label || t('分离')
}

/* ------------------------------------------------------------------ tree */

/** A group of Rna's view as the tree shows it: a turn of the conversation or a background run, and its files. */
export interface StackGroup {
  /** `turn:<id>` or `change:<id>`. */
  key: string
  kind: 'turn' | 'change'
  label: string
  files: StackFile[]
  /** A short mark after the label (本轮). */
  tag?: string | null
  /** Dimmed: a change set no longer in effect (rolled back). */
  muted?: boolean
}

/** `path` is the row's key (a folder's path, a file's key; in a group, prefixed with the group's key); `title` names it on hover. */
export interface FolderRow { kind: 'folder'; path: string; name: string; depth: number; title: string }
export interface FileRow { kind: 'file'; path: string; name: string; depth: number; file: StackFile }
export interface GroupRow { kind: 'group'; path: string; name: string; depth: number; group: StackGroup }
export type TreeRow = FolderRow | FileRow | GroupRow

interface Folder { name: string; path: string; folders: Map<string, Folder>; files: StackFile[] }

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const folderNode = (name: string, path: string): Folder => ({ name, path, folders: new Map(), files: [] })

/** The folder structure of the changed paths. A row ending in `/` (a repository of its own) is a file of its parent. */
export function buildTree(files: readonly StackFile[]): Folder {
  const root = folderNode('', '')
  for (const file of files) {
    const parts = file.path.replace(/\/$/, '').split('/')
    let at = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = at.folders.get(parts[i])
      if (!next) at.folders.set(parts[i], next = folderNode(parts[i], path))
      at = next
    }
    at.files.push(file)
  }
  return root
}

/** A folder and the folders it opens straight into (one child folder, no files), shown as one row (`api/search`). */
function compact(folder: Folder): { node: Folder; name: string } {
  let node = folder, name = folder.name
  while (!node.files.length && node.folders.size === 1) {
    node = node.folders.values().next().value as Folder
    name = `${name}/${node.name}`
  }
  return { node, name }
}

/**
 * The tree's rows, depth-first: folders first, then files, each in byte order (as git sorts). A collapsed folder's
 * rows are left out; with `only` (file keys), files outside it and folders holding none of it are too. `prefix` keys
 * a group's folders apart from another group's (`<group>:`); `depth` is where the top level starts.
 */
export function treeRows(root: Folder, collapsed: ReadonlySet<string>, only?: ReadonlySet<string> | null, { prefix = '', depth: top = 0 }: { prefix?: string; depth?: number } = {}): TreeRow[] {
  const rows: TreeRow[] = []
  const has = (folder: Folder): boolean => (!only ? true : folder.files.some(file => only.has(keyOf(file))) || [...folder.folders.values()].some(has))
  const walk = (folder: Folder, depth: number) => {
    for (const key of [...folder.folders.keys()].sort(byName)) {
      const child = folder.folders.get(key)!
      if (!has(child)) continue
      const { node, name } = compact(child)
      rows.push({ kind: 'folder', path: prefix + node.path, name, depth, title: node.path })
      if (!collapsed.has(prefix + node.path)) walk(node, depth + 1)
    }
    for (const file of [...folder.files].sort((a, b) => byName(a.path, b.path))) {
      if (only && !only.has(keyOf(file))) continue
      rows.push({ kind: 'file', path: keyOf(file), name: file.path.replace(/\/$/, '').split('/').pop()! + (isFolderRow(file) ? '/' : ''), depth, file })
    }
  }
  walk(root, top)
  return rows
}

/** Every file in the tree's order (whatever is collapsed): the order the diffs stack in. */
export function fileOrder(root: Folder): StackFile[] {
  return treeRows(root, new Set()).flatMap(row => (row.kind === 'file' ? [row.file] : []))
}

/** The folder rows holding a file (by key), outermost first (to open them when the file is picked from elsewhere). */
export function foldersOf(root: Folder, key: string, prefix = ''): string[] {
  return treeRows(root, new Set(), null, { prefix }).filter((row): row is FolderRow => row.kind === 'folder' && key.startsWith(`${row.path}/`)).map(row => row.path)
}

/** A listing as the tree and the stacked diffs read it. */
export interface TreeModel {
  /** Every file in the tree's order (whatever is collapsed): the order the diffs stack in. */
  order: StackFile[]
  /** The rows shown: collapsed folders and groups keep their children out; `only` (file keys) narrows them (find). */
  rows: (collapsed: ReadonlySet<string>, only?: ReadonlySet<string> | null) => TreeRow[]
  /** The rows holding a file (by key), outermost first: opened when the file is shown from elsewhere. */
  holders: (key: string) => string[]
}

/** Git's listing: one tree of the changed paths. */
export function flatTree(files: readonly StackFile[]): TreeModel {
  const root = buildTree(files)
  return { order: fileOrder(root), rows: (collapsed, only) => treeRows(root, collapsed, only), holders: key => foldersOf(root, key) }
}

/**
 * 本次对话的改动: a row per group (a turn, a background run), in the order given, each with its files' tree one level
 * in; the diffs stack group by group. A group is collapsed like a folder (by its key); with `only`, a group holding
 * none of it is left out.
 */
export function groupedTree(groups: readonly StackGroup[]): TreeModel {
  const built = groups.map(group => ({ group, root: buildTree(group.files), prefix: `${group.key}:` }))
  return {
    order: built.flatMap(({ root }) => fileOrder(root)),
    rows: (collapsed, only) => built.flatMap(({ group, root, prefix }) => {
      if (only && !group.files.some(file => only.has(keyOf(file)))) return []
      const head: GroupRow = { kind: 'group', path: group.key, name: group.label, depth: 0, group }
      return collapsed.has(group.key) ? [head] : [head, ...treeRows(root, collapsed, only, { prefix, depth: 1 })]
    }),
    holders: key => {
      const hit = built.find(({ group }) => group.files.some(file => keyOf(file) === key))
      return hit ? [hit.group.key, ...foldersOf(hit.root, key, hit.prefix)] : []
    },
  }
}

/* --------------------------------------------------------------- batches */

/** A patch's size by guess before it is read: about 64 bytes a changed line plus a hunk's context; an uncounted new file as a whole MB. */
export function estimateBytes(file: GitCompareFile): number {
  if (file.binary || isFolderRow(file)) return 256
  if (file.added === null || file.removed === null) return file.untracked ? 1024 * 1024 : 64 * 1024
  return 256 + (file.added + file.removed + 6) * 64
}

/** How many characters a file adds to a patch request's query (`&path=…` and a moved file's `&oldPath=…`, encoded). */
export const queryChars = (file: Pick<GitCompareFile, 'path' | 'oldPath'>) =>
  6 + encodeURIComponent(file.path).length + (file.oldPath ? 9 + encodeURIComponent(file.oldPath).length : 0)

/**
 * Files in request order, packed into batches of at most {@link MAX_PATCH_PATHS} paths and {@link BATCH_BYTES} by
 * estimate, and at most {@link BATCH_QUERY_CHARS} of query (non-Latin paths encode at 9 characters a letter). A file
 * larger than that goes alone, after the batches of the files around it (they draw sooner).
 */
export function patchBatches(files: readonly GitCompareFile[], maxBytes = BATCH_BYTES, maxPaths = MAX_PATCH_PATHS, maxQuery = BATCH_QUERY_CHARS): GitCompareFile[][] {
  const batches: GitCompareFile[][] = [], alone: GitCompareFile[][] = []
  let current: GitCompareFile[] = [], bytes = 0, chars = 0
  for (const file of files) {
    const size = estimateBytes(file), query = queryChars(file)
    if (size > maxBytes) { alone.push([file]); continue }
    if (current.length && (current.length >= maxPaths || bytes + size > maxBytes || chars + query > maxQuery)) { batches.push(current); current = []; bytes = 0; chars = 0 }
    current.push(file); bytes += size; chars += query
  }
  if (current.length) batches.push(current)
  return [...batches, ...alone]
}

/** A section's height before it is drawn: the header alone when folded, else a row per diff line (by guess until the patch is read). */
export function estimateSection(file: GitCompareFile, { collapsed, shown, lines }: { collapsed: boolean; shown: boolean; lines: number | null }): number {
  if (collapsed) return HEADER_H
  if (lines !== null) return HEADER_H + 12 + lines * LINE_H
  if (file.binary || isFolderRow(file) || (isFolded(file) && !shown)) return HEADER_H + 44
  return HEADER_H + 12 + Math.min(changedLines(file) + 8, 2000) * LINE_H
}

/* ------------------------------------------------------------------ find */

/** One place the query was found, in a file (by key): in its path (`line` -1) or in one of its diff rows (`line` is the row's index). */
export interface FindMatch { key: string; line: number; start: number }

/**
 * Every occurrence of `query` (ignoring case) in the files' paths and their loaded diff rows (never in the gaps
 * between hunks), in order. `key` defaults to the path.
 */
export function findMatches(query: string, files: readonly { key?: string; path: string; lines: readonly DiffLine[] | null }[]): FindMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const out: FindMatch[] = []
  for (const { key, path, lines } of files) {
    const id = key ?? path
    const at = path.toLowerCase().indexOf(needle)
    if (at >= 0) out.push({ key: id, line: -1, start: at })
    if (!lines) continue
    lines.forEach((line, index) => {
      if (line.type === 'gap') return
      const text = line.text.toLowerCase()
      for (let from = text.indexOf(needle); from >= 0; from = text.indexOf(needle, from + needle.length)) out.push({ key: id, line: index, start: from })
    })
  }
  return out
}
