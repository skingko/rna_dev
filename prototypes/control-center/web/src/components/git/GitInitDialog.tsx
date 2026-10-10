/**
 * Make a project folder a Git repository (0.63, worktree design §10; protocol §8.8), in two steps. The preview
 * writes nothing: the files the first commit would hold (count, size, the largest), the `.gitignore` lines Rna
 * would write — each can be unticked, and lines added; a change is previewed again —, files past 50 MB and nested
 * repositories left out, the committer, and whether the folder is probably synced by iCloud. Only 初始化 sends the
 * preview's token back, with the edited lines, a committer when git has none, and the size acknowledgement a very
 * large folder needs. No remote is added; nothing is pushed.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Cloud, FolderGit2, Plus, TriangleAlert } from 'lucide-react'
import { worktreeApi, type GitIdentity, type GitInitLine, type GitInitPreview, type GitInitResult } from '@/api/worktree-api'
import { ApiError } from '@/api/transport'
import { toast } from '@/store/ui-store'
import { refreshIsolation } from '@/store/isolation-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { prettyPath } from '@/lib/format'
import { formatBytes } from '@/components/preview/registry'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { TextInput } from '@/components/settings/form'
import { Button, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT, type TFunction } from '@/i18n'

/** Confirmation refusals the host answers before using the preview's token up: the same preview can be confirmed again. */
const KEEPS_TOKEN = new Set(['git_init_identity_required', 'git_init_identity_invalid', 'git_init_large_unacknowledged', 'git_init_lines_invalid', 'git_request_invalid', 'git_read_only'])

/** A `.gitignore` line as the dialog holds it: the preview's line, ticked or not, or one the user added. */
export interface IgnoreRow extends GitInitLine { on: boolean }

/** The preview's lines, all ticked. */
export const rowsOf = (preview: GitInitPreview): IgnoreRow[] => preview.gitignore.lines.map(line => ({ ...line, on: true }))
/** The lines to write: the ticked ones, in order. */
export const tickedLines = (rows: IgnoreRow[]) => rows.filter(row => row.on).map(row => row.text)
/** A new preview's counts on the rows the user holds (unticked and added rows stay as they are). */
export function withCounts(rows: IgnoreRow[], preview: GitInitPreview): IgnoreRow[] {
  const byText = new Map(preview.gitignore.lines.map(line => [line.text, line]))
  return rows.map(row => {
    const line = byText.get(row.text)
    return line && row.on ? { ...row, count: line.count, bytes: line.bytes } : row
  })
}
/** A line the user typed, trimmed; null when empty, a comment, already listed, or not one line. */
export function addedLine(text: string, rows: IgnoreRow[]): string | null {
  const line = text.trim()
  if (!line || line.startsWith('#') || /[\r\n]/.test(line) || rows.some(row => row.text === line)) return null
  return line
}

function ruleLabel(line: GitInitLine, t: TFunction): string {
  switch (line.rule) {
    case 'always': return t('总是忽略')
    case 'ecosystem': return line.marker ? t('因为有 {marker}', { marker: line.marker }) : t('按项目类型')
    case 'secret': return t('存放密钥的文件')
    case 'venv': return t('Python 虚拟环境')
    case 'large': return t('超过 50 MB')
    case 'nested': return t('单独的仓库')
    case 'user': return t('你添加的')
    default: return line.rule
  }
}

export interface GitInitDialogProps {
  projectId: string
  open: boolean
  onClose: () => void
  onDone?: (result: GitInitResult) => void
}

export function GitInitDialog({ projectId, open, onClose, onDone }: GitInitDialogProps) {
  const t = useT()
  const busy = useRef(false)
  return (
    <PanelDialog open={open} onClose={onClose} size="md" title={t('初始化为 Git 仓库')}
      description={t('先看会提交哪些文件、忽略哪些，确认后才写入。不会添加远端，也不会推送。')}
      guard={() => (busy.current ? t('正在初始化，请稍候。') : null)}>
      {open && <InitBody projectId={projectId} onClose={onClose} onDone={onDone} busyRef={busy} />}
    </PanelDialog>
  )
}

function InitBody({ projectId, onClose, onDone, busyRef }: { projectId: string; onClose: () => void; onDone?: (result: GitInitResult) => void; busyRef: { current: boolean } }) {
  const t = useT()
  const [preview, setPreview] = useState<GitInitPreview | null>(null)
  /** The latest preview's refusal (the first one, or one of the edited lines): nothing can be confirmed until it passes. */
  const [failure, setFailure] = useState<{ message: string; code?: string; repository?: string } | null>(null)
  /** The last 初始化 that failed: the host's sentence (what was undone) and, when the commit would have differed, how. */
  const [failed, setFailed] = useState<{ message: string; unexpected: string[]; missing: string[] } | null>(null)
  const failedRef = useRef<HTMLDivElement>(null)
  // Said where the user is looking: the dialog scrolls to it.
  useEffect(() => { if (failed) failedRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [failed])
  const [rows, setRows] = useState<IgnoreRow[]>([])
  const [edited, setEdited] = useState(false)
  const [reading, setReading] = useState(true)
  const [adding, setAdding] = useState('')
  const [identity, setIdentity] = useState<GitIdentity>({ name: '', email: '' })
  const [acknowledge, setAcknowledge] = useState(false)
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const asked = useRef(0)

  const read = useCallback(async (lines?: string[]) => {
    const ask = ++asked.current
    setReading(true)
    try {
      const next = await worktreeApi.previewGitInit(projectId, lines ? { lines } : {})
      if (!live.current || ask !== asked.current) return
      setPreview(next); setFailure(null)
      setRows(current => (lines && current.length ? withCounts(current, next) : rowsOf(next)))
    } catch (error) {
      if (!live.current || ask !== asked.current) return
      const e = error as ApiError
      const repository = e.details?.repository
      setFailure({ message: e.message, code: e.code, repository: typeof repository === 'string' ? repository : undefined })
    } finally { if (live.current && ask === asked.current) setReading(false) }
  }, [projectId])
  useEffect(() => { void read() }, [read])

  // An edited list is previewed again a moment after the last change (the token binds the lines).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const edit = (next: IgnoreRow[]) => {
    setRows(next); setEdited(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; void read(tickedLines(next)) }, 450)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const add = () => {
    const line = addedLine(adding, rows)
    if (!line) return
    setAdding('')
    edit([...rows, { text: line, rule: 'user', on: true }])
  }
  const identityOk = !preview?.identityRequired || (identity.name.trim() && /.+@.+/.test(identity.email.trim()))
  const ready = Boolean(preview && !failure && !reading && !busy && !timer.current && identityOk && (!preview.needsAcknowledge || acknowledge))
  const confirm = async () => {
    if (!preview || !ready) return
    setBusy(true); busyRef.current = true; setFailed(null)
    try {
      const result = await worktreeApi.confirmGitInit(projectId, preview.confirm, {
        ...(edited ? { lines: tickedLines(rows) } : {}),
        ...(preview.identityRequired ? { identity: { name: identity.name.trim(), email: identity.email.trim() } } : {}),
        ...(preview.needsAcknowledge ? { acknowledgeLarge: true } : {}),
      })
      if (!live.current) return
      toast(result.status === 'changed'
        ? t('已初始化：提交了 {n} 个文件；初始化期间有 {m} 个文件又变了，没有包含在提交里。', { n: result.files, m: result.changed?.length ?? 0 })
        : t('已初始化：分支 {branch}，提交了 {n} 个文件。', { branch: result.branch, n: result.files }), 'success')
      void loadGitStatus(projectId)
      refreshIsolation(projectId)
      onDone?.(result)
      onClose()
    } catch (error) {
      const e = error as ApiError
      // The folder changed since the preview: show the new one and ask again.
      if (e.code === 'git_init_changed' || e.code === 'git_init_unconfirmed') { toast(t('文件夹在预览之后有变化，已重新列出，请再确认一次。')); void read(edited ? tickedLines(rows) : undefined) }
      else {
        // Said in the dialog, with how the commit would have differed; the host undid what it had done.
        const differences = e.details?.differences as { unexpected?: unknown; missing?: unknown } | undefined
        const paths = (value: unknown) => (Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [])
        setFailed({ message: e.message, unexpected: paths(differences?.unexpected), missing: paths(differences?.missing) })
        // Only a missing committer, the size acknowledgement or a malformed request keep the preview's token.
        if (!e.code || !KEEPS_TOKEN.has(e.code)) void read(edited ? tickedLines(rows) : undefined)
      }
    } finally { busyRef.current = false; if (live.current) setBusy(false) }
  }

  if (failure && !preview) {
    return (
      <div className="px-6 py-4 text-[13px] leading-[1.7]" data-git-init-error={failure.code ?? 'failed'}>
        <p className="flex items-start gap-2 text-fg-2"><TriangleAlert className="mt-1 size-4 shrink-0 text-warning-text" />{failure.message}</p>
        {failure.repository && <p className="mt-1 pl-6 font-mono text-[12px] text-fg-3">{prettyPath(failure.repository)}</p>}
        <div className="mt-4 flex gap-2"><Button size="sm" variant="secondary" onClick={() => void read()}>{t('重试')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('关闭')}</Button></div>
      </div>
    )
  }
  if (!preview) return <div className="space-y-3 px-6 py-4" aria-busy><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-24 w-full" /></div>

  return (
    <>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto border-t border-line-faint px-6 py-4 text-[13px] leading-[1.6]" data-git-init>
        <p className="flex min-w-0 items-center gap-2 text-fg-2">
          <FolderGit2 className="size-4 shrink-0 text-fg-3" />
          <span className="min-w-0 truncate font-mono text-[12.5px]" title={preview.folder}>{prettyPath(preview.folder)}</span>
          <span className="shrink-0 text-fg-4">{t('分支 {branch}', { branch: preview.branch })}</span>
        </p>
        {preview.icloud && <Hint icon={<Cloud />}>{t('这个文件夹可能由 iCloud 同步。Rna 的工作树会放在 .rna/worktrees.nosync 里，不会被同步。')}</Hint>}
        {preview.outer && <Hint>{preview.outer.kind === 'dotfiles' ? t('外层的 {top} 是主目录下的点文件仓库，不影响这里。', { top: prettyPath(preview.outer.top) }) : t('外层仓库 {top} 忽略了这个文件夹，这里会成为单独的仓库。', { top: prettyPath(preview.outer.top) })}</Hint>}

        <Section title={t('第一次提交')}>
          <p className={cn('text-fg-2', reading && 'opacity-60')} data-git-init-files={preview.files.count}>{t('{count} 个文件，共 {size}', { count: preview.files.count, size: formatBytes(preview.files.bytes) || '0 B' })}</p>
          {preview.files.largest.length > 0 && (
            <details className="mt-1 text-[12.5px] text-fg-3">
              <summary className="cursor-pointer select-none text-fg-3">{t('最大的 {n} 个文件', { n: preview.files.largest.length })}</summary>
              <ul className="mt-1 space-y-0.5">{preview.files.largest.map(file => <FileLine key={file.path} path={file.path} bytes={file.bytes} />)}</ul>
            </details>
          )}
        </Section>

        <Section title={preview.gitignore.exists ? t('追加到已有的 .gitignore') : t('新建 .gitignore')}>
          {preview.gitignore.exists && <p className="mb-1.5 text-[12.5px] text-fg-3">{t('原有内容不变，只在末尾追加一段“# Added by Rna Agent”。')}</p>}
          <ul className="space-y-0.5" data-git-init-lines>
            {rows.map((row, i) => (
              <li key={`${row.text}:${i}`} className="flex min-w-0 items-center gap-2">
                <input type="checkbox" checked={row.on} disabled={busy} onChange={() => edit(rows.map((other, j) => (j === i ? { ...other, on: !other.on } : other)))}
                  aria-label={t('写入 {line}', { line: row.text })} className="size-3.5 shrink-0 accent-[var(--accent)]" />
                <code className={cn('min-w-0 truncate font-mono text-[12.5px]', row.on ? 'text-fg' : 'text-fg-4 line-through')} title={row.text}>{row.text}</code>
                <span className="shrink-0 text-[12px] text-fg-4">{ruleLabel(row, t)}</span>
                <span className="flex-1" />
                {row.on && row.count ? <span className="shrink-0 text-[12px] tabular-nums text-fg-4">{t('忽略 {n} 个文件', { n: row.count })}{row.bytes ? ` · ${formatBytes(row.bytes)}` : ''}</span> : null}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-1.5">
            <TextInput value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }}
              placeholder={t('再忽略一行，例如 out/')} aria-label={t('添加一行忽略规则')} className="h-8 font-mono text-[12.5px]" disabled={busy} />
            <Button size="sm" variant="secondary" leading={<Plus className="size-3.5" />} disabled={busy || !addedLine(adding, rows)} onClick={add}>{t('添加')}</Button>
          </div>
          {/* Next to the lines it is about: an edited list the host refuses (e.g. a nested repository left un-ignored). */}
          {failure && (
            <p role="alert" className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-git-init-refused={failure.code ?? 'failed'}>
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{failure.message}
            </p>
          )}
        </Section>

        {preview.largeFiles.length > 0 && (
          <Section title={t('超过 50 MB，不提交')}>
            <ul className="space-y-0.5">{preview.largeFiles.map(file => <FileLine key={file.path} path={file.path} bytes={file.bytes} />)}</ul>
            <p className="mt-1 text-[12px] text-fg-4">{t('它们会写进 .gitignore；工作树里会复制一份，但子代理对它们的修改不会合并回来。')}</p>
          </Section>
        )}
        {preview.nested.length > 0 && (
          <Section title={t('单独的仓库，不提交')}>
            <ul className="space-y-0.5">{preview.nested.map(path => <li key={path} className="truncate font-mono text-[12.5px] text-fg-3">{path}</li>)}</ul>
          </Section>
        )}

        <Section title={t('提交者')}>
          {preview.identityRequired ? (
            <div className="grid gap-2 sm:grid-cols-2" data-git-init-identity>
              <TextInput value={identity.name} onChange={e => setIdentity(v => ({ ...v, name: e.target.value }))} placeholder={t('名字')} aria-label={t('提交者名字')} disabled={busy} />
              <TextInput value={identity.email} onChange={e => setIdentity(v => ({ ...v, email: e.target.value }))} placeholder={t('邮箱')} aria-label={t('提交者邮箱')} type="email" disabled={busy} />
              <p className="text-[12px] text-fg-4 sm:col-span-2">{t('git 里还没有设置名字和邮箱；只写进这个仓库自己的设置。')}</p>
            </div>
          ) : <p className="text-fg-2">{preview.identity ? `${preview.identity.name} <${preview.identity.email}>` : ''}</p>}
        </Section>

        {failed && (
          <div ref={failedRef} role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-git-init-failed>
            <p className="flex items-start gap-2"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{failed.message}</p>
            {failed.unexpected.length > 0 && <p className="mt-1 pl-5.5 font-mono text-[12px]">{t('多出的文件：{paths}', { paths: failed.unexpected.slice(0, 8).join(', ') })}</p>}
            {failed.missing.length > 0 && <p className="mt-1 pl-5.5 font-mono text-[12px]">{t('缺少的文件：{paths}', { paths: failed.missing.slice(0, 8).join(', ') })}</p>}
          </div>
        )}

        {preview.needsAcknowledge && (
          <label className="mt-4 flex items-start gap-2 rounded-lg bg-warning-soft/50 px-3 py-2 text-[12.5px] text-warning-text">
            <input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} disabled={busy} className="mt-1 size-3.5 shrink-0 accent-[var(--accent)]" data-git-init-ack />
            <span>{t('这个文件夹很大（{count} 个文件，{size}）。我已看过上面的忽略规则，确认要提交这些文件。', { count: preview.files.count, size: formatBytes(preview.files.bytes) })}</span>
          </label>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line-faint px-6 py-3">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-4">{reading ? t('正在重新预览…') : !tickedLines(rows).length ? t('会执行 git init、提交一次，不写 .gitignore；不添加远端。') : preview.gitignore.exists ? t('会执行 git init、在 .gitignore 末尾追加、提交一次；不添加远端。') : t('会执行 git init、写 .gitignore、提交一次；不添加远端。')}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('取消')}</Button>
        <Button size="sm" variant="primary" disabled={!ready} onClick={() => void confirm()} data-git-init-confirm>{busy ? t('正在初始化…') : t('初始化')}</Button>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[12.5px] font-medium text-fg-3">{title}</h3>
      {children}
    </section>
  )
}
function Hint({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <p className="mt-2 flex items-start gap-2 rounded-lg bg-subtle px-3 py-2 text-[12.5px] text-fg-3 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">{icon}{children}</p>
}
function FileLine({ path, bytes }: { path: string; bytes: number }) {
  return <li className="flex min-w-0 gap-2"><span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-3" title={path}>{path}</span><span className="shrink-0 text-[12px] tabular-nums text-fg-4">{formatBytes(bytes)}</span></li>
}
