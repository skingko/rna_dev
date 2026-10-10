/**
 * 工作区改动 panel: the pure part of the list grouped by stage (按暂存状态分组
 * in 未提交的改动) — its rows, the header's summary and the words for a
 * file's state. The comparison view's own: compare-model.ts.
 */
import type { GitFile, GitFileStatus, GitSection, GitStatus } from '@/api/git-api'
import type { MessageKey } from '@/i18n'
import { gitReadable } from '@/lib/workspace-changes'

/**
 * The panel's old switch (本次任务 / 未暂存 / 已暂存 / 相对上游): still accepted from callers that ask for a view by
 * it (`openWorktree`), and read as the comparison it stands for (side-panel-store's `worktreeSourceFields`).
 */
export type WorktreeSource = 'rna' | 'unstaged' | 'staged' | 'upstream'

/** Git's view is offered (a repository whose status could be read); see gitReadable. */
export const hasGit = gitReadable

/** The sections of 按暂存状态分组, in order. */
export const GROUPED_SECTIONS: GitSection[] = ['conflicted', 'staged', 'unstaged', 'untracked']
/** Which diff a row of a section opens. */
export const sectionDiffSource = (section: GitSection) => (section === 'staged' ? 'staged' as const : section === 'upstream' ? 'upstream' as const : 'unstaged' as const)

export type ListRow =
  | { kind: 'section'; key: string; section: GitSection; count: number; folded: boolean }
  | { kind: 'file'; key: string; section: GitSection; file: GitFile }

export function sectionFiles(status: GitStatus, section: GitSection): GitFile[] {
  return section === 'upstream' ? status.files.upstream ?? [] : status.files[section]
}

/** The flat rows the virtual list draws: a header per non-empty section, then its files unless folded. */
export function gitRows(status: GitStatus, folded: ReadonlySet<GitSection>): ListRow[] {
  const rows: ListRow[] = []
  for (const section of GROUPED_SECTIONS) {
    const files = sectionFiles(status, section)
    if (!files.length) continue
    rows.push({ kind: 'section', key: `section:${section}`, section, count: files.length, folded: folded.has(section) })
    if (!folded.has(section)) for (const file of files) rows.push({ kind: 'file', key: fileKey(section, file.path), section, file })
  }
  return rows
}
export const fileKey = (section: GitSection, path: string) => `${section}:${path}`

/** Distinct changed paths and the line counts git knows (staged and unstaged together). */
export function dirtySummary(status: GitStatus): { count: number; added: number; removed: number } {
  const paths = new Set<string>()
  let added = 0, removed = 0
  for (const section of ['conflicted', 'staged', 'unstaged', 'untracked'] as const) {
    for (const file of status.files[section]) {
      paths.add(file.path)
      added += file.added ?? 0; removed += file.removed ?? 0
    }
  }
  return { count: paths.size, added, removed }
}

/** `src/app/main.ts` → name `main.ts`, folder `src/app`; an untracked folder (`dist/`) keeps its slash in the name. */
export function splitPath(path: string): { name: string; dir: string } {
  const folder = path.endsWith('/'), trimmed = folder ? path.slice(0, -1) : path, at = trimmed.lastIndexOf('/')
  return { name: `${trimmed.slice(at + 1)}${folder ? '/' : ''}`, dir: at < 0 ? '' : trimmed.slice(0, at) }
}

/** The letter in the row (git's; a conflict reads `!`, an untracked file `U` as editors show it) and its words. */
export const STATUS_LETTER: Record<GitFileStatus, string> = { M: 'M', A: 'A', D: 'D', R: 'R', U: '!', '?': 'U' }
export const STATUS_WORDS: Record<GitFileStatus, MessageKey> = { M: '已修改', A: '新文件', D: '已删除', R: '已重命名', U: '有冲突', '?': '未跟踪' }
export const STATUS_TONE: Record<GitFileStatus, string> = {
  M: 'text-warning-text', A: 'text-success', D: 'text-danger', R: 'text-accent-text', U: 'text-danger', '?': 'text-success',
}
export const SECTION_TITLE: Record<GitSection, MessageKey> = { conflicted: '有冲突', staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪', upstream: '相对上游' }

/** A patch this long is not worth opening in the panel; the row says 过大 before anything is loaded. */
export const LARGE_CHANGE = 5000
export const isLarge = (file: Pick<GitFile, 'added' | 'removed'>) => (file.added ?? 0) + (file.removed ?? 0) > LARGE_CHANGE
