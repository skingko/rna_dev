/**
 * 工作区改动 in the mock (?mock=1): `p-agent` is a git repository whose
 * project folder is on `feature/compare-panel`, two commits ahead of its
 * upstream and branched from `main`, with committed, staged, unstaged and
 * untracked work (a rename, a deletion, a binary, a large generated file, a
 * folder chain to compact); a few more local branches, one checked out in a
 * Claude-style linked worktree with only new files, and a locked and a
 * prunable worktree. Every other project is a plain folder, so its panel
 * shows Rna's own records. The comparison (branches / compare / patches /
 * diff source=compare, with context=all for 展开 N 行) is computed from file
 * contents the way git would; stage, unstage and the two-step discard change
 * the in-memory files like the host would.
 */
import { diffLines, structuredPatch } from 'diff'
import { ApiError } from '@/api/transport'
import type { GitBranch, GitCompare, GitCompareFile, GitDiff, GitFile, GitStatus, GitWorktree } from '@/api/git-api'

const REPO = 'p-agent'
const ROOT = '/Users/me/Documents/独立开发项目/Pi_agent'
const LINKED = `${ROOT}/.claude/worktrees/official-site-docs-design-fbd2ac`
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/* --------------------------------------------------------------- contents */

const routesBase = [
  "import { WorkspaceGitService } from './workspace-git-service.mjs';",
  '',
  '// 工作区改动 panel, L2 (layout plan §3; contract v2 §1 `/git`). api-v2 falls',
  '// through unknown /api/v2/* paths, so these routes live here behind one hook.',
  "const ROUTE = /^\\/api\\/v2\\/projects\\/([a-zA-Z0-9-]+)\\/git(?:\\/(diff|worktrees|stage|unstage|discard))?$/;",
  '',
  'export function createWorkspaceGitRoutes({ store, body, git = new WorkspaceGitService(store) }) {',
  '  const handle = async function handle(req, { pathname, url, send }) {',
  "    if (!pathname.startsWith('/api/v2/projects/') || !pathname.includes('/git')) return false;",
  '    const match = pathname.match(ROUTE);',
  '    if (!match) return false;',
  '    const [, projectId, action] = match;',
  '    try {',
  ...Array.from({ length: 24 }, (_, i) => `      // step ${i + 1}: read the request and answer it`),
  "      if (req.method === 'GET' && !action) { send(200, await git.status(projectId)); return true; }",
  "      if (req.method === 'GET' && action === 'diff') { send(200, await git.diff(projectId, url.searchParams)); return true; }",
  "      if (req.method === 'GET' && action === 'worktrees') { send(200, await git.worktrees(projectId)); return true; }",
  '    } catch (error) {',
  '      send(error.status ?? 500, { error: error.message, code: error.code });',
  '      return true;',
  '    }',
  '    return false;',
  '  };',
  '  return Object.assign(handle, { git });',
  '}',
].join('\n') + '\n'
const routesWork = routesBase
  .replace("import { WorkspaceGitService } from './workspace-git-service.mjs';", "import { WorkspaceGitService } from './workspace-git-service.mjs';\nimport { WorkspaceGitCompare } from './workspace-git-compare.mjs';")
  .replace('(diff|worktrees|stage|unstage|discard)', '(diff|worktrees|branches|compare|patches|stage|unstage|discard)')
  .replace('git = new WorkspaceGitService(store) }', 'git = new WorkspaceGitService(store), compare = new WorkspaceGitCompare(git) }')
  .replace("    const [, projectId, action] = match;", "    const [, projectId, action] = match, query = url.searchParams, worktree = query.get('worktree') || undefined;")
  .replace("      if (req.method === 'GET' && action === 'worktrees') { send(200, await git.worktrees(projectId)); return true; }",
    "      if (req.method === 'GET' && action === 'worktrees') { send(200, await git.worktrees(projectId)); return true; }\n      if (req.method === 'GET' && action === 'branches') { send(200, await compare.branches(projectId, { worktree })); return true; }\n      if (req.method === 'GET' && action === 'compare') { send(200, await compare.compare(projectId, { mode: query.get('mode'), base: query.get('base'), worktree })); return true; }")
  .replace('  return Object.assign(handle, { git });', '  return Object.assign(handle, { git, compare });')

const serverBase = ["import { createServer } from 'node:http';", "import { createWorkspaceGitRoutes } from './workspace-git-routes.mjs';", '', 'const routes = [createWorkspaceGitRoutes];', 'export const PORT = 4317;', ''].join('\n')
const diffBase = Array.from({ length: 40 }, (_, i) => (i === 18 ? "export function patchLines(patch: string) {" : i === 19 ? "  return patch.split('\\n')" : `// diff.ts line ${i + 1}`)).join('\n') + '\n'
const diffWork = diffBase.replace("  return patch.split('\\n')", "  // Each hunk starts with a gap that says where it is.\n  return parsePatch(patch).hunks.flatMap(hunk => hunk.lines)").replace('// diff.ts line 37', '// diff.ts line 37 (the cap counts hunk headers)')
const compareModule = [
  "import { createHash } from 'node:crypto';",
  "import { BINARY_PATCH, DIFF_FLAGS, fail, wholeLines } from './workspace-git-service.mjs';",
  '',
  '// 工作区改动 panel, phase 1 of the worktree design (§4): one comparison, base → target.',
  'const MAX_PATCH_PATHS = 40, MAX_COMPARE_FILES = 3000;',
  ...Array.from({ length: 60 }, (_, i) => `export const step${i} = () => ${i}; // the comparison, part ${i + 1}`),
].join('\n') + '\n'
const plan = '# Old plan\n\nSuperseded by the layout design.\n'
const specOld = '# Git panel\n\nThe panel shows the project folder’s git state.\n\n## Sources\n\nUnstaged, staged, upstream.\n'
const specNew = '# Workspace git\n\nThe panel shows the project folder’s git state.\n\n## Comparison\n\nAll changes, uncommitted changes, compare against a branch.\n'
const tree = [
  "import { useVirtualizer } from '@tanstack/react-virtual'",
  "import { ChevronRight, Folder, FolderOpen } from 'lucide-react'",
  '',
  '/** The changed paths as folders and files, single-child chains compacted. */',
  'export function ChangeTree({ rows, active, onPick }: ChangeTreeProps) {',
  '  const scroller = useRef<HTMLDivElement>(null)',
  '  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 26 })',
  ...Array.from({ length: 70 }, (_, i) => `  // row ${i + 1}: draw the folder or the file, with +N −M on the right`),
  '  return <div ref={scroller} role="tree" />',
  '}',
].join('\n') + '\n'
const skill = [
  '---',
  'name: design-taste-frontend',
  'description: Anti-slop frontend skill for landing pages, portfolios, and redesigns. The agent reads the brief, infers the right design direction, and ships interfaces that do not look templated.',
  '---',
  '',
  '# tasteskill: Anti-Slop Frontend Skill',
  '',
  '> Landing pages, portfolios, and redesigns. Not dashboards, not data tables, not multi-step product UI.',
  '> Every rule below is **contextual**. None of it fires automatically. First read the brief, then pull only what fits.',
  '',
  '---',
  '',
  '## 0. BRIEF INFERENCE (Read the Room Before Anything Else)',
  '',
  'Before touching code or tweaking dials, **infer what the user actually wants**. Most LLM design output is bad because the model jumps to a default aesthetic instead of reading the room.',
  ...Array.from({ length: 30 }, (_, i) => `${i + 1}. **Signal ${i + 1}** - what the brief says about the audience, the brand and the constraints.`),
].join('\n') + '\n'
const page = (title: string, n: number) => [`import { Hero } from '@/components/hero'`, '', `export default function Page() {`, `  return (`, `    <main>`, `      <Hero title="${title}" />`, ...Array.from({ length: n }, (_, i) => `      <section id="s${i}">Section ${i + 1}</section>`), `    </main>`, `  )`, `}`].join('\n') + '\n'
const fixtures = `[\n${Array.from({ length: 1500 }, (_, i) => `  { "id": ${i}, "name": "fixture-${i}", "ok": ${i % 3 === 0} }`).join(',\n')}\n]\n`
const changelogOld = '# Changelog\n\n## 0.61.0\n\nFiles, evolution and workspace changes as panels.\n'

/** One file's contents: at the merge base with main, at release/0.61's merge base, at HEAD, in the index, in the working tree. */
interface MockFile { path: string; oldPath?: string; base: string | null; older?: string | null; head: string | null; index?: string | null; work: string | null; binary?: boolean }

function projectFiles(): MockFile[] {
  return [
    // Committed on this branch.
    { path: 'prototypes/control-center/workspace-git-compare.mjs', base: null, head: compareModule, work: compareModule },
    { path: 'prototypes/control-center/workspace-git-routes.mjs', base: routesBase, head: routesWork, work: routesWork },
    { path: 'CHANGELOG.md', base: changelogOld, older: '# Changelog\n', head: changelogOld, work: changelogOld },
    // Staged.
    { path: 'docs/specs/workspace-git.md', oldPath: 'docs/specs/git-panel.md', base: specOld, head: specOld, index: specNew, work: specNew },
    // Unstaged.
    { path: 'prototypes/control-center/server.mjs', base: serverBase, head: serverBase, work: serverBase.replace('export const PORT = 4317;', "// The panel reads this from git.\nexport const PORT = Number(process.env.RNA_PORT) || 4317;\nexport const HOST = '127.0.0.1';") },
    { path: 'prototypes/control-center/web/src/lib/diff.ts', base: diffBase, head: diffBase, work: diffWork },
    { path: 'prototypes/control-center/web/public/logo.png', base: 'PNG-1', head: 'PNG-1', work: 'PNG-2', binary: true },
    { path: 'notes/old-plan.md', base: plan, head: plan, work: null },
    // Untracked.
    { path: 'prototypes/control-center/web/src/components/panels/worktree/ChangeTree.tsx', base: null, head: null, work: tree },
    { path: 'prototypes/control-center/web/src/fixtures/generated.json', base: null, head: null, work: fixtures },
    { path: 'site/app/api/search/route.ts', base: null, head: null, work: "export async function GET(request: Request) {\n  const query = new URL(request.url).searchParams.get('q') ?? ''\n  return Response.json({ query, results: [] })\n}\n" },
  ]
}
function linkedFiles(): MockFile[] {
  return [
    { path: '.agents/skills/design-taste-frontend/SKILL.md', base: null, head: null, work: skill },
    { path: 'site/app/[lang]/(home)/changelog/page.tsx', base: null, head: null, work: page('Changelog', 40) },
    { path: 'site/app/[lang]/(home)/layout.tsx', base: null, head: null, work: page('Layout', 12) },
    { path: 'site/app/[lang]/(home)/page.tsx', base: null, head: null, work: page('Home', 96) },
    { path: 'site/app/[lang]/docs/[[...slug]]/page.tsx', base: null, head: null, work: page('Docs', 74) },
    { path: 'site/app/api/search/route.ts', base: null, head: null, work: "export async function GET() {\n  return Response.json([])\n}\n" },
    { path: 'skills-lock.json', base: null, head: null, work: '{\n  "design-taste-frontend": "1.0.0"\n}\n' },
  ]
}

const BRANCHES: GitBranch[] = [
  { name: 'claude/code-audit-dev-plan-caefaf', sha: '1f3c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39', upstream: null, committedAt: Date.parse('2026-10-02T09:00:00Z'), worktreePath: null, current: false },
  { name: 'claude/official-site-docs-design-fbd2ac', sha: '6796d3f0a1b2c3d4e5f60718293a4b5c6d7e8f90', upstream: null, committedAt: Date.parse('2026-10-03T12:00:00Z'), worktreePath: LINKED, current: false },
  { name: 'claude/xuanhuan-novel-content-detection-and-rewrite-experiment', sha: '9a8b7c6d5e4f30211203f4e5d6c7b8a9f0e1d2c3', upstream: null, committedAt: Date.parse('2026-10-01T08:00:00Z'), worktreePath: null, current: false },
  { name: 'feature/compare-panel', sha: 'c0b2953e1f2a3b4c5d6e7f8091a2b3c4d5e6f708', upstream: 'origin/feature/compare-panel', committedAt: Date.parse('2026-10-04T03:00:00Z'), worktreePath: ROOT, current: true },
  { name: 'main', sha: '2899a96b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f', upstream: 'origin/main', committedAt: Date.parse('2026-10-03T23:00:00Z'), worktreePath: null, current: false },
  { name: 'release/0.61', sha: 'd253386a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e', upstream: 'origin/release/0.61', committedAt: Date.parse('2026-09-30T10:00:00Z'), worktreePath: null, current: false },
  { name: 'review', sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd', upstream: null, committedAt: Date.parse('2026-09-29T10:00:00Z'), worktreePath: `${ROOT}-review`, current: false },
]
const MERGE_BASE: Record<string, string> = { main: '2899a96b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f', 'release/0.61': 'd253386a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e' }
const WORKTREES: GitWorktree[] = [
  { path: ROOT, head: 'c0b2953', branch: 'feature/compare-panel', detached: false, bare: false, main: true, linked: false, current: true, locked: false, prunable: false, rna: false, owner: null },
  { path: LINKED, head: '6796d3f', branch: 'claude/official-site-docs-design-fbd2ac', detached: false, bare: false, main: false, linked: true, current: false, locked: false, prunable: false, rna: false, owner: null },
  { path: `${ROOT}-review`, head: 'aa11bb2', branch: 'review', detached: false, bare: false, main: false, linked: true, current: false, locked: true, lockedReason: 'review', prunable: false, rna: false, owner: null },
  { path: `${ROOT}/.claude/worktrees/gone-experiment`, head: '1234567', branch: null, detached: true, bare: false, main: false, linked: true, current: false, locked: false, prunable: true, prunableReason: 'gitdir file points to non-existent location', rna: false, owner: null },
]

/* ------------------------------------------------------------------- git */

function counts(before: string | null, after: string | null): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const part of diffLines(before ?? '', after ?? '')) { if (part.added) added += part.count ?? 0; else if (part.removed) removed += part.count ?? 0 }
  return { added, removed }
}
/** A git-style patch for one file (`context` lines around each change; a huge number gives the whole file). */
function patchOf(file: MockFile, before: string | null, after: string | null, context = 3): GitDiff {
  if (file.binary) return { kind: 'binary' }
  const a = before === null ? '/dev/null' : `a/${file.oldPath ?? file.path}`, b = after === null ? '/dev/null' : `b/${file.path}`
  const head = [`diff --git a/${file.oldPath ?? file.path} b/${file.path}`]
  if (before === null) head.push('new file mode 100644')
  if (after === null) head.push('deleted file mode 100644')
  if (file.oldPath && before !== null && after !== null) head.push(`rename from ${file.oldPath}`, `rename to ${file.path}`)
  const parsed = structuredPatch(a, b, before ?? '', after ?? '', '', '', { context })
  const out = [...head, `--- ${a}`, `+++ ${b}`]
  const old = (before ?? '').split('\n')
  for (const hunk of parsed.hunks) {
    const range = (start: number, lines: number) => (lines === 1 ? `${start}` : `${lines === 0 ? Math.max(0, start - 1) : start},${lines}`)
    // Git's function context: the nearest line above the hunk that starts a declaration.
    let context = ''
    for (let i = hunk.oldStart - 2; i >= 0; i--) if (/^(?:export |function |const |class |async )/.test(old[i] ?? '')) { context = ` ${old[i].slice(0, 60)}`; break }
    out.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${context}`, ...hunk.lines)
  }
  return { kind: 'patch', patch: `${out.join('\n')}\n` }
}
const ends = (file: MockFile, mode: string, base: string | null): [string | null, string | null] =>
  mode === 'uncommitted' ? [file.head, file.work] : [base === 'release/0.61' && file.older !== undefined ? file.older : file.base, file.work]

export class GitMockStore {
  private files = projectFiles()
  private linked = linkedFiles()
  private pending = new Map<string, { key: string; files: { path: string; action: 'restore' | 'delete' }[] }>()
  /** Folders made repositories by `git/init` (worktree-routes): clean, on main, one commit. */
  private initialized = new Set<string>()

  /** Whether the project folder is a repository in the mock. */
  isRepository(projectId: string) { return projectId === REPO || this.initialized.has(projectId) }
  /** `git/init` confirmed: the folder is a clean repository from now on. */
  init(projectId: string) { this.initialized.add(projectId) }

  private status(): GitStatus {
    const staged: GitFile[] = [], unstaged: GitFile[] = [], untracked: GitFile[] = []
    for (const file of this.files) {
      const index = file.index === undefined ? file.head : file.index
      if (file.head === null && file.index === undefined) {
        if (file.work !== null) untracked.push({ path: file.path, status: '?', added: null, removed: null })
        continue
      }
      if (index !== file.head) staged.push({ path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), status: file.head === null ? 'A' : index === null ? 'D' : file.oldPath ? 'R' : 'M', ...(file.binary ? { added: null, removed: null, binary: true } : counts(file.head, index)) })
      if (file.work !== index) unstaged.push({ path: file.path, status: file.work === null ? 'D' : 'M', ...(file.binary ? { added: null, removed: null, binary: true } : counts(index, file.work)) })
    }
    return { repo: 'main', branch: 'feature/compare-panel', detached: false, upstream: 'origin/feature/compare-panel', ahead: 2, behind: 0, operation: null, initial: false, untrackedMode: 'all', files: { conflicted: [], staged, unstaged, untracked } }
  }

  /** 0.63: a conversation's or worker's worktree Rna made (`.rna/worktrees.nosync/…`): what it has not applied yet. */
  private rnaWorktree = (): MockFile[] => [{ path: 'src/lib/terminal.ts', base: 'export const cap = 200\n', head: 'export const cap = 200\n', work: 'export const head = 120\nexport const tail = 80\n' }]

  private table(worktree: string | null): MockFile[] {
    if (!worktree || worktree === ROOT) return this.files
    if (worktree === LINKED) return this.linked
    if (worktree.startsWith(`${ROOT}/.rna/worktrees.nosync/`)) return this.rnaWorktree()
    throw new ApiError('这个文件夹不是本项目仓库的工作树。', 403, 'git_worktree_denied') // i18n-ignore: mock host text
  }

  private compare(mode: string, base: string | null, worktree: string | null): GitCompare {
    if (mode !== 'all' && mode !== 'uncommitted') throw new ApiError('对比方式只能是 all 或 uncommitted。', 400, 'git_mode_invalid') // i18n-ignore: mock host text
    if (base && !BRANCHES.some(branch => branch.name === base)) throw new ApiError(`分支「${base}」不存在。`, 404, 'git_base_not_found') // i18n-ignore: mock host text
    if (mode === 'all' && base === 'claude/code-audit-dev-plan-caefaf') throw new ApiError(`与 ${base} 没有共同历史。`, 409, 'no_common_history') // i18n-ignore: mock host text
    const rna = Boolean(worktree?.startsWith(`${ROOT}/.rna/worktrees.nosync/`))
    const other = worktree === LINKED || rna, chosen = mode === 'all' ? base ?? 'main' : null
    const files: GitCompareFile[] = []
    for (const file of this.table(worktree)) {
      const [before, after] = ends(file, mode, chosen)
      if (before === after) continue
      const untracked = file.head === null && file.index === undefined
      files.push({
        path: file.path, ...(file.oldPath && before !== null && after !== null ? { oldPath: file.oldPath } : {}),
        status: untracked ? '?' : before === null ? 'A' : after === null ? 'D' : file.oldPath ? 'R' : 'M',
        ...(file.binary ? { added: null, removed: null, binary: true } : counts(before, after)), ...(untracked ? { untracked: true } : {}),
      })
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    const label = other ? 'claude/official-site-docs-design-fbd2ac' : 'feature/compare-panel'
    return {
      repo: other ? 'linked' : 'main', mode, base: chosen, defaultBase: 'main', mergeBase: mode === 'all' ? (other ? '6796d3f0a1b2c3d4e5f60718293a4b5c6d7e8f90' : MERGE_BASE[chosen!] ?? MERGE_BASE.main) : 'c0b2953e1f2a3b4c5d6e7f8091a2b3c4d5e6f708',
      target: rna ? { kind: 'detached', label: 'a1b2c3d' } : { kind: 'branch', label }, files, truncated: false, operation: null,
    }
  }

  /** The patch of `path` from `from` (a merge base, or HEAD) in the worktree's files. */
  private patch(from: string, path: string, worktree: string | null, context = 3): GitDiff {
    const file = this.table(worktree).find(row => row.path === path)
    if (!file) return { kind: 'patch', patch: '' }
    const mode = from === 'HEAD' || from.startsWith('c0b2953') ? 'uncommitted' : 'all'
    const base = Object.entries(MERGE_BASE).find(([, sha]) => sha === from)?.[0] ?? 'main'
    const [before, after] = ends(file, mode, base)
    return before === after ? { kind: 'patch', patch: '' } : patchOf(file, before, after, context)
  }

  /** The mock's answer, or undefined when the route is not a git route. */
  handle(method: string, url: URL, body: Record<string, unknown>): unknown {
    const m = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/git(?:\/(diff|worktrees|branches|compare|patches|stage|unstage|discard))?$/)
    if (!m) return undefined
    const projectId = decodeURIComponent(m[1]), action = m[2], query = url.searchParams, worktree = query.get('worktree')
    const repo = projectId === REPO
    // A folder `git/init` made a repository: clean, nothing else to show.
    if (!repo && this.initialized.has(projectId) && method === 'GET') {
      if (!action) return { repo: 'main', branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, operation: null, initial: false, untrackedMode: 'all', files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } satisfies GitStatus
      if (action === 'compare') return { repo: 'main', mode: query.get('mode') === 'uncommitted' ? 'uncommitted' : 'all', base: 'main', defaultBase: 'main', mergeBase: 'f'.repeat(40), target: { kind: 'working-tree', label: 'main' }, files: [], truncated: false, operation: null } satisfies GitCompare
      if (action === 'branches') return { repo: 'main', current: 'main', default: 'main', branches: [{ name: 'main', sha: 'f'.repeat(40), upstream: null, committedAt: Date.now(), worktreePath: null, current: true }] }
      if (action === 'worktrees') return { repo: 'main', worktrees: [] }
    }
    if (method === 'GET' && !action) {
      if (!repo) return { repo: 'none', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, files: { conflicted: [], staged: [], unstaged: [], untracked: [] } } satisfies GitStatus
      if (worktree === LINKED) return { repo: 'linked', branch: 'claude/official-site-docs-design-fbd2ac', detached: false, upstream: null, ahead: 0, behind: 0, operation: null, untrackedMode: 'all', files: { conflicted: [], staged: [], unstaged: [], untracked: this.linked.map(file => ({ path: file.path, status: '?' as const, added: null, removed: null })) } } satisfies GitStatus
      if (worktree?.startsWith(`${ROOT}/.rna/worktrees.nosync/`)) return { repo: 'linked', branch: null, detached: true, upstream: null, ahead: 0, behind: 0, operation: null, untrackedMode: 'all', files: { conflicted: [], staged: [], unstaged: [{ path: 'src/lib/terminal.ts', status: 'M', added: 2, removed: 1 }], untracked: [] } } satisfies GitStatus
      const status = this.status()
      return query.get('include') === 'upstream' ? { ...status, files: { ...status.files, upstream: [] } } : status
    }
    if (method === 'GET' && action === 'branches') {
      if (!repo) return { repo: 'none', current: null, default: null, branches: [] }
      return { repo: 'main', current: worktree === LINKED ? 'claude/official-site-docs-design-fbd2ac' : 'feature/compare-panel', default: 'main', branches: clone(BRANCHES).map(branch => ({ ...branch, current: branch.worktreePath === (worktree || ROOT) })) }
    }
    if (method === 'GET' && action === 'compare') {
      if (!repo) return { repo: 'none', mode: query.get('mode') === 'uncommitted' ? 'uncommitted' : 'all', base: null, defaultBase: null, mergeBase: null, target: null, files: [], truncated: false, operation: null } satisfies GitCompare
      return this.compare(query.get('mode') ?? 'all', query.get('base'), worktree)
    }
    if (method === 'GET' && action === 'patches') {
      const paths = query.getAll('path'), from = query.get('base') ?? 'HEAD'
      if (!paths.length || paths.length > 40) throw new ApiError('一次需要 1–40 个文件。', 400, 'git_paths_invalid') // i18n-ignore: mock host text
      return { patches: paths.map(path => ({ path, diff: repo ? this.patch(from, path, worktree) : { kind: 'unavailable' } as GitDiff })) }
    }
    if (method === 'GET' && action === 'diff') {
      const path = query.get('path') ?? '', source = query.get('source')
      if (source === 'compare') return repo ? this.patch(query.get('base') ?? 'HEAD', path, worktree, query.get('context') === 'all' ? 1_000_000 : 3) : { kind: 'unavailable' } satisfies GitDiff
      const file = this.files.find(row => row.path === path)
      if (!repo || !file) return { kind: 'unavailable', message: '这个文件的差异暂时读不到。' } satisfies GitDiff // i18n-ignore: mock host text
      const index = file.index === undefined ? file.head : file.index
      return source === 'staged' ? patchOf(file, file.head, index) : patchOf(file, file.head === null && file.index === undefined ? null : index, file.work)
    }
    if (method === 'GET' && action === 'worktrees') return repo ? { repo: 'main', worktrees: clone(WORKTREES) } : { repo: 'none', worktrees: [] }
    if (method !== 'POST' || !action) return undefined
    if (!repo) throw new ApiError('项目文件夹不是 Git 仓库。', 409, 'git_unavailable') // i18n-ignore: mock host text
    if (worktree) throw new ApiError('其他工作树只能查看，暂存和丢弃只作用于项目文件夹。', 403, 'git_worktree_read_only') // i18n-ignore: mock host text
    const paths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === 'string') : []
    if (!paths.length) throw new ApiError('一次需要 1–500 个文件。', 400, 'git_paths_invalid') // i18n-ignore: mock host text
    const named = (path: string) => this.files.find(row => row.path === path || row.oldPath === path)
    if (action === 'stage') {
      for (const path of paths) { const file = named(path); if (file) file.index = file.work }
      return { staged: paths, status: this.status() }
    }
    if (action === 'unstage') {
      for (const path of paths) { const file = named(path); if (file) delete file.index }
      return { unstaged: paths, status: this.status() }
    }
    // Discard: the first request lists what would happen and hands out a token; only the second, carrying it, acts.
    const key = [...paths].sort().join('\u0000')
    if (typeof body.confirm !== 'string') {
      const plan = paths.flatMap((path): { path: string; action: 'restore' | 'delete' }[] => {
        const file = named(path)
        if (!file) return []
        const index = file.index === undefined ? file.head : file.index
        if (file.head === null && file.index === undefined) return file.work === null ? [] : [{ path, action: 'delete' }]
        return file.work !== index ? [{ path, action: 'restore' }] : []
      })
      if (!plan.length) throw new ApiError('这些文件没有可以丢弃的未暂存改动。', 409, 'git_discard_nothing') // i18n-ignore: mock host text
      const confirm = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)
      this.pending.set(confirm, { key, files: plan })
      return { confirm, expiresAt: new Date(Date.now() + 120_000).toISOString(), files: plan }
    }
    const row = this.pending.get(body.confirm)
    this.pending.delete(body.confirm)
    if (!row || row.key !== key) throw new ApiError('这次确认已经失效，请重新点一次丢弃。', 409, 'git_discard_unconfirmed') // i18n-ignore: mock host text
    for (const { path, action: what } of row.files) {
      const file = named(path)
      if (!file) continue
      if (what === 'delete') this.files = this.files.filter(other => other !== file)
      else file.work = file.index === undefined ? file.head : file.index
    }
    return { discarded: row.files, status: this.status() }
  }
}
