/** 已归档: archived projects and sessions with restore / delete (legacy #archive-dialog), plus pending session cleanups. */
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArchiveRestore, FolderClosed, MessageSquare, Trash2 } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { Button, SegmentedTabs } from '@/components/ui/primitives'
import { Empty } from '@/components/settings/form'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { openDelete, usePanels } from '@/components/settings/panel-store'
import { archiveEntity } from '@/components/projects/entity-actions'
import { formatDate, useLocale, useT } from '@/i18n'
import { CleanupRows } from './CleanupRows'

export function ArchiveDialog() {
  const tab = usePanels(s => s.archive)
  const projects = useApp(s => s.projects)
  const sessions = useApp(s => s.sessionIndex)
  const [busy, setBusy] = useState<string | null>(null)
  const t = useT()
  const locale = useLocale()
  const rows = useMemo(() => {
    const kind = tab === 'sessions' ? 'session' : 'project'
    const list = kind === 'project' ? Object.values(projects) : Object.values(sessions)
    return list.filter(item => item.archivedAt).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt))).map(item => {
      const date = formatDate(item.archivedAt!, locale, { year: 'numeric', month: 'numeric', day: 'numeric' })
      if (kind === 'project') {
        const count = Object.values(sessions).filter(s => s.projectId === item.id).length
        return { kind, id: item.id, name: (item as { name: string }).name, meta: t('{count} 个会话 · {date} 归档', { count, date }), blocked: false }
      }
      const project = projects[(item as { projectId?: string | null }).projectId ?? '']
      return { kind, id: item.id, name: (item as { title: string }).title || t('未命名会话'), meta: `${project?.name ?? t('未归属会话')}${project?.archivedAt ? ` · ${t('请先恢复所属项目')}` : ` · ${t('{date} 归档', { date })}`}`, blocked: Boolean(project?.archivedAt) }
    }) as { kind: 'project' | 'session'; id: string; name: string; meta: string; blocked: boolean }[]
  }, [tab, projects, sessions, t, locale])
  const counts = useMemo(() => ({ projects: Object.values(projects).filter(p => p.archivedAt).length, sessions: Object.values(sessions).filter(s => s.archivedAt).length }), [projects, sessions])

  const restore = async (kind: 'project' | 'session', id: string) => {
    setBusy(id)
    try { await archiveEntity(kind, id, false) } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(null) }
  }

  return (
    <PanelDialog open={tab !== null} onClose={() => usePanels.setState({ archive: null })} title={t('已归档')} description={t('归档内容保留在这里。恢复后，暂停的工作需要手动继续。')} size="md">
      <div className="shrink-0 px-6 pb-3">
        <SegmentedTabs<'projects' | 'sessions'> layoutId="archive-tab" value={tab ?? 'projects'} onChange={next => usePanels.setState({ archive: next })} className="rounded-lg bg-subtle p-0.5" items={[{ id: 'projects', label: t('项目'), badge: counts.projects || undefined }, { id: 'sessions', label: t('会话'), badge: counts.sessions || undefined }]} />
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto border-t border-line-faint px-4 py-3" role="tabpanel">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map(row => (
            <motion.div key={row.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12, transition: { duration: 0.16 } }} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-hover">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-3">{row.kind === 'project' ? <FolderClosed className="size-4" /> : <MessageSquare className="size-4" />}</span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-[13.5px] font-medium text-fg">{row.name}</strong>
                <span className="block truncate text-[12px] text-fg-4">{row.meta}</span>
              </div>
              <Button size="sm" variant="secondary" leading={<ArchiveRestore className="size-3.5" />} disabled={row.blocked || busy === row.id} title={row.blocked ? t('请先恢复所属项目') : undefined} onClick={() => void restore(row.kind, row.id)}>{t('恢复')}</Button>
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger" leading={<Trash2 className="size-3.5" />} onClick={() => openDelete({ kind: row.kind, id: row.id })}>{t('删除…')}</Button>
            </motion.div>
          ))}
        </AnimatePresence>
        {!rows.length && <div className="p-2"><Empty>{tab === 'sessions' ? t('没有已归档的会话') : t('没有已归档的项目')}</Empty></div>}
        <CleanupRows active={tab !== null} />
      </div>
    </PanelDialog>
  )
}
