/**
 * File preview registry: which renderer a workspace file gets, how its bytes
 * are delivered, and the size guards that apply. Pure data + functions so the
 * selection rules are unit-tested without a DOM.
 *
 * Selection is by the longest matching suffix first (so `report.test.tsx`
 * is still `tsx`, `archive.tar.gz` is binary), then by MIME when the host
 * supplies one, then a text fallback for extensionless names such as
 * `Makefile` or `Dockerfile`.
 */

export type PreviewKind = 'markdown' | 'code' | 'json' | 'table' | 'excel' | 'image' | 'pdf' | 'html' | 'office' | 'text' | 'binary'

/** How the renderer's content is read: UTF-8 text (`/file`) or complete bytes (`/file/raw`). */
export type PreviewLoad = 'text' | 'bytes' | 'none'

export interface PreviewSpec {
  kind: PreviewKind
  load: PreviewLoad
  /** Shiki language id (code, json, html source, markdown source). */
  lang?: string
  /** CSV/TSV delimiter. */
  delimiter?: ',' | '\t'
  /** Short uppercase badge shown in the toolbar (e.g. `PY`, `CSV`). */
  badge: string
  /** Above this many bytes the user confirms before the file is read ("仍然打开"). */
  softLimit: number
  /** Above this many bytes the renderer refuses; only download remains. */
  hardLimit: number
}

const KB = 1024
const MB = 1024 * KB

/** Host ceilings (workspace-inspection-service): text reads truncate at 512 KB, raw bytes stop at 32 MB. */
export const HOST_TEXT_LIMIT = 512 * KB
export const HOST_BYTES_LIMIT = 32 * MB
/**
 * Text files never exceed a hard limit here: the host sends at most the first
 * 512 KB (marked truncated). Past 1 MB the user confirms, knowing only the
 * beginning will show.
 */
const TEXT_SOFT = 1 * MB

/** Extension -> Shiki language (ids must exist in lib/highlight LANGS or its aliases). */
export const CODE_LANGS: Record<string, string> = {
  py: 'python', pyi: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  json5: 'json', jsonc: 'json', ipynb: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', m: 'objective-c',
  rb: 'ruby', php: 'php', lua: 'lua', r: 'r', dart: 'dart', pl: 'perl', ex: 'elixir', exs: 'elixir',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  xml: 'xml', xsd: 'xml', plist: 'xml', vtt: 'text',
  diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
  tex: 'latex', gradle: 'groovy', groovy: 'groovy', tf: 'hcl', hcl: 'hcl', nix: 'nix', zig: 'zig',
}

/** Extensionless filenames that are still source. */
const NAMED: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', justfile: 'makefile', procfile: 'bash',
  '.gitignore': 'text', '.dockerignore': 'text', '.editorconfig': 'ini', '.npmrc': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', 'license': 'text', 'readme': 'text',
}

const TEXT_EXT = new Set(['txt', 'log', 'text', 'rst', 'adoc', 'org', 'srt', 'lock', 'sum', 'mod', 'gitattributes'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const OFFICE_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'odt', 'odp', 'ods', 'rtf', 'pages', 'key', 'numbers'])
const BINARY_EXT = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm', 'pyc', 'mp3', 'mp4', 'mov', 'wav', 'ogg', 'webm', 'ttf', 'otf', 'woff', 'woff2', 'glb', 'gltf', 'sqlite', 'db', 'psd', 'sketch', 'fig', 'dmg', 'iso', 'parquet', 'npy', 'pkl', 'pt'])

const spec = (kind: PreviewKind, load: PreviewLoad, badge: string, softLimit: number, hardLimit: number, extra: Partial<PreviewSpec> = {}): PreviewSpec => ({ kind, load, badge, softLimit, hardLimit, ...extra })

/** The final path segment. */
export function fileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** Lower-cased suffix after the last dot (`''` when none, or for dotfiles like `.env`). */
export function extOf(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Pick the renderer for a file.
 * @param path - workspace-relative path (only the name is inspected).
 * @param mime - optional host content type; used when the suffix says nothing.
 */
export function previewSpec(path: string, mime?: string | null): PreviewSpec {
  const name = fileName(path).toLowerCase()
  const ext = extOf(path)
  if (['md', 'markdown', 'mdx', 'mdown', 'mkd'].includes(ext)) return spec('markdown', 'text', 'MD', TEXT_SOFT, Infinity, { lang: 'markdown' })
  if (ext === 'json' || ext === 'geojson' || ext === 'webmanifest' || name.endsWith('.json.map')) return spec('json', 'text', 'JSON', TEXT_SOFT, Infinity, { lang: 'json' })
  if (ext === 'csv' || ext === 'tsv') return spec('table', 'text', ext.toUpperCase(), TEXT_SOFT, Infinity, { delimiter: ext === 'tsv' ? '\t' : ',' })
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return spec('excel', 'bytes', ext.toUpperCase(), 5 * MB, 20 * MB)
  if (IMAGE_EXT.has(ext)) return spec('image', 'bytes', ext.toUpperCase(), 10 * MB, HOST_BYTES_LIMIT)
  if (ext === 'pdf') return spec('pdf', 'bytes', 'PDF', 16 * MB, HOST_BYTES_LIMIT)
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return spec('html', 'text', 'HTML', TEXT_SOFT, Infinity, { lang: 'html' })
  if (OFFICE_EXT.has(ext)) return spec('office', 'none', ext.toUpperCase(), Infinity, Infinity)
  if (CODE_LANGS[ext]) return spec('code', 'text', ext.toUpperCase(), TEXT_SOFT, Infinity, { lang: CODE_LANGS[ext] })
  if (NAMED[name]) return spec(NAMED[name] === 'text' ? 'text' : 'code', 'text', NAMED[name] === 'text' ? 'TXT' : name.replace(/^\./, '').toUpperCase().slice(0, 10), TEXT_SOFT, Infinity, NAMED[name] === 'text' ? {} : { lang: NAMED[name] })
  if (TEXT_EXT.has(ext)) return spec('text', 'text', ext.toUpperCase(), TEXT_SOFT, Infinity)
  if (BINARY_EXT.has(ext)) return spec('binary', 'none', ext.toUpperCase(), Infinity, Infinity)
  // Nothing in the name: let the host MIME decide, else try it as text (the host answers 415 for non-UTF-8).
  const type = (mime ?? '').split(';')[0].trim().toLowerCase()
  if (type.startsWith('image/')) return spec('image', 'bytes', ext.toUpperCase() || 'IMG', 10 * MB, HOST_BYTES_LIMIT)
  if (type === 'application/pdf') return spec('pdf', 'bytes', 'PDF', 16 * MB, HOST_BYTES_LIMIT)
  if (type === 'text/markdown') return spec('markdown', 'text', 'MD', TEXT_SOFT, Infinity, { lang: 'markdown' })
  if (type === 'application/json') return spec('json', 'text', 'JSON', TEXT_SOFT, Infinity, { lang: 'json' })
  if (type === 'text/html') return spec('html', 'text', 'HTML', TEXT_SOFT, Infinity, { lang: 'html' })
  if (type && !type.startsWith('text/') && type !== 'application/octet-stream') return spec('binary', 'none', ext.toUpperCase() || 'BIN', Infinity, Infinity)
  return spec('text', 'text', ext.toUpperCase() || 'TXT', TEXT_SOFT, Infinity)
}

/** Kinds worth showing rendered by default (review dock: new files open in 预览). */
export function isRichPreview(path: string): boolean {
  const kind = previewSpec(path).kind
  return kind !== 'binary' && kind !== 'office'
}

export type SizeVerdict = 'ok' | 'confirm' | 'block'

/** Size guard before reading: unknown sizes read (the host caps them), large ones ask, huge ones only download. */
export function sizeVerdict(spec: PreviewSpec, bytes: number | null | undefined): SizeVerdict {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'ok'
  if (bytes > spec.hardLimit) return 'block'
  if (bytes > spec.softLimit) return 'confirm'
  return 'ok'
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

/* ------------------------------------------------------------- paths */

/**
 * Normalize a tool/deliverable path to a workspace-relative one, or null when
 * it points outside the workspace (or is not a file path at all).
 * @param path - absolute or relative path as a tool reported it.
 * @param workspace - the project's absolute workspace path, when known; or the roots a conversation's files can be
 *   under, its own first (lib/session-root `rootsOf`: a worktree conversation's copy, then the project folder). With
 *   several roots an absolute path takes the first that holds it, and one that would only resolve to Rna's private
 *   `.rna/` folder (a worktree inside the project folder) is outside every root.
 */
export function toWorkspacePath(path: string, workspace?: string | readonly string[] | null): string | null {
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('\0') || path.includes('\\')) return null
  if (Array.isArray(workspace)) {
    if (!(path.startsWith('/') || path.startsWith('~'))) return normalizeRelative(path)
    for (const root of workspace as readonly string[]) {
      const rel = toWorkspacePath(path, root)
      if (rel !== null) return rel === '.rna' || rel.startsWith('.rna/') ? null : rel
    }
    return null
  }
  let rel = path
  if (path.startsWith('/') || path.startsWith('~')) {
    if (!workspace) return null
    const root = (workspace as string).replace(/\/+$/, '')
    if (path !== root && !path.startsWith(`${root}/`)) return null
    rel = path.slice(root.length + 1)
  }
  return normalizeRelative(rel)
}

/** Collapse `.`/`..`/empty segments; null when the result escapes the root or is empty. */
export function normalizeRelative(path: string): string | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!out.length) return null; out.pop(); continue }
    out.push(part)
  }
  return out.length ? out.join('/') : null
}

/**
 * Resolve a reference inside a document (Markdown image/link) against the
 * document's directory. External URLs, anchors, data/blob URLs and absolute
 * paths return null: the caller leaves them as they are (or drops them).
 */
export function resolveRelative(documentPath: string, href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const clean = href.split(/[?#]/)[0]
  let decoded = clean
  try { decoded = decodeURIComponent(clean) } catch { /* keep raw */ }
  const dir = documentPath.split('/').slice(0, -1).join('/')
  return normalizeRelative(dir ? `${dir}/${decoded}` : decoded)
}

/* ------------------------------------------------------------- delimited text */

/** RFC 4180-style parse (quoted fields, doubled quotes, CRLF), stopping after `maxRows`. */
export function parseDelimited(text: string, delimiter: string, maxRows = 5000): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const pushRow = () => { row.push(field); field = ''; rows.push(row); row = [] }
  while (i < input.length) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      pushRow()
      if (ch === '\r' && input[i + 1] === '\n') i++
      i++
      if (rows.length >= maxRows) return { rows, truncated: i < input.length }
      continue
    }
    field += ch; i++
  }
  if (field !== '' || row.length) pushRow()
  return { rows, truncated: false }
}
