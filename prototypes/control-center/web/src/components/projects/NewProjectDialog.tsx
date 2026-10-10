/**
 * 新建项目 / 打开项目目录: a daemon-side directory browser (a normal browser
 * cannot reveal absolute paths) → existing-project reuse or project creation.
 * Port of public/workspace-ui.js; uses the desktop native picker when present.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowUp, ChevronRight, CornerUpRight, Folder, FolderPlus, Home, Loader2, Sparkles } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { DirectoryListing, WorkspaceOpenResult } from '@/api/panels-types'
import { Button, Skeleton } from '@/components/ui/primitives'
import { useApp } from '@/store/app-store'
import { selectProject, selectSession } from '@/store/sync'
import { toast, useUi } from '@/store/ui-store'
import { prettyPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Disclosure, Field, Note, Switch, TextArea, TextInput } from '@/components/settings/form'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { usePanels } from '@/components/settings/panel-store'
import { t } from '@/i18n'

export function NewProjectDialog() {
  const open = usePanels(s => s.newProject)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [step, setStep] = useState<'browse' | 'details'>('browse')
  const [hidden, setHidden] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [writing, setWriting] = useState(false)
  const request = useRef(0)
  const generation = useRef(0)

  const browse = async (target?: string, offset = 0, showHidden = hidden) => {
    const ticket = ++request.current, lifetime = generation.current
    setError(null); setBusy(true)
    try {
      const value = await panelsApi.browseDirectories({ ...(target === undefined ? {} : { path: target }), hidden: showHidden, offset })
      if (ticket !== request.current || lifetime !== generation.current) return
      setListing(prev => (offset && prev?.path === value.path ? { ...value, entries: [...prev.entries, ...value.entries] } : value))
      setPath(value.path)
      return value
    } catch (e) {
      if (ticket === request.current && lifetime === generation.current) { if (!offset) { setListing(null); setPath(target ?? '') } setError((e as Error).message) }
    } finally { if (ticket === request.current && lifetime === generation.current) setBusy(false) }
  }

  useEffect(() => {
    if (!open) { generation.current++; return }
    generation.current++
    const lifetime = generation.current
    setListing(null); setStep('browse'); setError(null)
    const initial = (() => { const s = useApp.getState(); const p = s.selectedProjectId ? s.projects[s.selectedProjectId] : null; return p?.workspacePath ?? undefined })()
    const native = window.rnaDesktop?.chooseDirectory
    if (native) {
      void native().then(async chosen => {
        if (lifetime !== generation.current) return
        if (!chosen) { usePanels.setState({ newProject: false }); return }
        if (await browse(chosen)) setStep('details')
      }).catch(e => setError((e as Error).message))
    } else void browse(initial)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => usePanels.setState({ newProject: false })

  const adopt = async (projectId: string | null, restore: boolean, details: { name?: string; description?: string; demo?: boolean } = {}) => {
    if (busy || !listing) return
    const lifetime = generation.current
    setError(null); setWriting(true); setBusy(true)
    try {
      if (restore && projectId) await panelsApi.patchProject(projectId, { archived: false })
      const result: WorkspaceOpenResult = await panelsApi.openWorkspace({ workspace: listing.path, ...details, ...(projectId ? { projectId } : {}) })
      if (lifetime !== generation.current) return
      const project = { ...result.project, archivedAt: null }
      useApp.setState(s => ({ projects: { ...s.projects, [project.id]: { ...s.projects[project.id], ...project } }, projectOrder: s.projectOrder.includes(project.id) ? s.projectOrder : [...s.projectOrder, project.id] }))
      selectProject(project.id)
      if (result.session?.id) await selectSession(result.session.id)
      // Show the project's conversation (and its setup progress) even when opened from 任务 or 收件箱.
      useUi.setState({ view: 'chat', sidebarOpen: false })
      close()
      toast(result.reused ? t('已打开「{name}」', { name: project.name }) : t('已建立项目「{name}」，正在准备项目能力。', { name: project.name }))
    } catch (e) { if (lifetime === generation.current) setError((e as Error).message) } finally { setWriting(false); setBusy(false) }
  }

  return (
    <PanelDialog open={open} onClose={close} guard={() => (writing ? t('正在打开项目，请稍候…') : null)} title={step === 'browse' ? t('打开项目目录') : t('建立项目')} description={step === 'browse' ? t('选择这台电脑上的项目目录。再次打开同一目录会继续原项目。') : prettyPath(listing?.path)} size="md">
      <div className="flex min-h-0 flex-1 flex-col border-t border-line-faint">
        <AnimatePresence mode="wait" initial={false}>
          {step === 'browse' ? (
            <motion.div key="browse" className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
              <Browser listing={listing} busy={busy} path={path} setPath={setPath} hidden={hidden}
                onBrowse={(p, offset) => void browse(p, offset)}
                onHidden={value => { setHidden(value); void browse(listing?.path, 0, value) }}
                onCreate={async name => {
                  if (!listing) return
                  setWriting(true); setBusy(true)
                  try { const value = await panelsApi.createDirectory(listing.path, name); await browse(value.path) } catch (e) { setError((e as Error).message) } finally { setWriting(false); setBusy(false) }
                }} />
              {error && <p className="px-6 pb-2 text-[12.5px] text-danger" role="alert">{error}</p>}
              <div className="flex shrink-0 justify-end gap-2 border-t border-line-faint px-6 py-3">
                <Button variant="ghost" onClick={close}>{t('取消')}</Button>
                <Button variant="primary" disabled={!listing || busy} onClick={() => setStep('details')}>{t('选择此目录')}</Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="details" className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 py-5" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.16 }}>
              <button type="button" onClick={() => setStep('browse')} disabled={writing} className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-fg-3 hover:text-fg"><ArrowLeft className="size-3.5" />{t('选择其他目录')}</button>
              {listing && <Details listing={listing} busy={busy} onAdopt={adopt} />}
              {error && <Note tone="danger" className="mt-3">{error}</Note>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PanelDialog>
  )
}

function Browser({ listing, busy, path, setPath, hidden, onBrowse, onHidden, onCreate }: { listing: DirectoryListing | null; busy: boolean; path: string; setPath: (v: string) => void; hidden: boolean; onBrowse: (path?: string, offset?: number) => void; onHidden: (v: boolean) => void; onCreate: (name: string) => Promise<void> }) {
  const [folder, setFolder] = useState('')
  return (
    <>
      <div className="shrink-0 space-y-2 px-6 pt-4">
        <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (path.trim()) onBrowse(path.trim()) }}>
          <TextInput value={path} required aria-label={t('目录路径')} placeholder={t('输入绝对目录路径')} onChange={e => setPath(e.target.value)} className="font-mono text-[12.5px]" />
          <Button type="submit" variant="secondary" className="h-9 shrink-0" disabled={busy}>{t('前往')}</Button>
        </form>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy || !listing?.parent} leading={<ArrowUp className="size-3.5" />} onClick={() => onBrowse(listing?.parent ?? undefined)}>{t('上一级')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} leading={<Home className="size-3.5" />} onClick={() => onBrowse()}>{t('个人目录')}</Button>
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-[12px] text-fg-3">{t('显示隐藏目录')}<Switch checked={hidden} onChange={onHidden} disabled={busy} label={t('显示隐藏目录')} /></label>
        </div>
      </div>
      <div className="scroll-quiet mt-2 min-h-0 flex-1 overflow-y-auto px-4" aria-label={t('子目录')} aria-busy={busy}>
        {!listing && busy ? <div className="space-y-1.5 px-2">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}</div> : (
          <>
            {listing?.projects.length ? <p className="mx-2 mb-1 rounded-lg bg-accent-softer px-3 py-2 text-[12px] text-accent-text">{t('此目录已关联项目，选择后可直接打开。')}</p> : null}
            {listing?.entries.map(entry => (
              <button key={entry.path} type="button" disabled={busy} onClick={() => onBrowse(entry.path)} className="group flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60">
                <Folder className="size-4 shrink-0 text-fg-4 group-hover:text-accent" strokeWidth={1.7} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.symlink ? <CornerUpRight className="size-3.5 text-fg-4" /> : <ChevronRight className="size-3.5 text-fg-4 opacity-0 transition-opacity group-hover:opacity-100" />}
              </button>
            ))}
            {!listing?.entries.length && <p className="px-3 py-6 text-center text-[12.5px] text-fg-4">{listing ? t('此目录中没有可显示的子目录。') : t('选择一个目录以继续。')}</p>}
            {listing?.nextOffset != null && <Button size="sm" variant="ghost" className="mx-2 my-1" disabled={busy} onClick={() => onBrowse(listing.path, listing.nextOffset!)}>{t('加载更多目录')}</Button>}
          </>
        )}
      </div>
      <form className="flex shrink-0 gap-2 px-6 py-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (folder.trim()) void onCreate(folder.trim()).then(() => setFolder('')) }}>
        <TextInput value={folder} required maxLength={255} aria-label={t('新文件夹名称')} placeholder={t('新文件夹名称')} onChange={e => setFolder(e.target.value)} disabled={!listing || busy} />
        <Button type="submit" variant="secondary" className="h-9 shrink-0" disabled={!listing || busy || !folder.trim()} leading={<FolderPlus className="size-3.5" />}>{t('新建文件夹')}</Button>
      </form>
    </>
  )
}

function Details({ listing, busy, onAdopt }: { listing: DirectoryListing; busy: boolean; onAdopt: (projectId: string | null, restore: boolean, details?: { name?: string; description?: string; demo?: boolean }) => void }) {
  const [name, setName] = useState(listing.name ?? listing.path.split('/').filter(Boolean).at(-1) ?? '')
  const [description, setDescription] = useState('')
  const [demo, setDemo] = useState(false)
  if (listing.projects.length) {
    return (
      <div className="space-y-3">
        <p className="text-[13px] leading-[1.65] text-fg-3">{listing.projects.length > 1 ? t('此目录包含多个历史项目。选择一个继续，原有记录不会合并。') : t('此目录已关联项目，打开后继续原有会话和项目状态。')}</p>
        {listing.projects.map(project => (
          <div key={project.id} className="flex items-center gap-3 rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
            <Folder className="size-4 text-fg-3" />
            <strong className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{project.name}</strong>
            {project.archivedAt && <span className="text-[11.5px] text-fg-4">{t('已归档')}</span>}
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAdopt(project.id, Boolean(project.archivedAt))}>{project.archivedAt ? t('恢复并打开') : t('打开项目')}</Button>
          </div>
        ))}
      </div>
    )
  }
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); onAdopt(null, false, { name, description: description.trim() || undefined, demo }) }}>
      <div className="flex gap-3 rounded-xl bg-accent-softer px-4 py-3 text-[12.5px] leading-[1.65] text-fg-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
        {t('以此目录建立项目。Rna 将根据名称和介绍调用已配置模型生成项目提示词、基础技能与评估标准。')}
      </div>
      <Field label={t('项目名称')}><TextInput autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label={t('项目介绍与当前目标')}><TextArea rows={4} maxLength={4000} value={description} placeholder={t('说明你正在做什么、当前状态与希望 Rna 如何协作…')} onChange={e => setDescription(e.target.value)} /></Field>
      <Disclosure summary={t('演示选项')}>
        <label className="flex items-center gap-3 text-[12.5px] text-fg-2"><Switch checked={demo} onChange={setDemo} label={t('使用演示策略')} />{t('使用演示策略（不调用真实模型）')}</label>
      </Disclosure>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy} className={cn(busy && 'cursor-wait')}>{busy && <Loader2 className="spin size-3.5" />}{t('建立项目并开始对话')}</Button>
      </div>
    </form>
  )
}
