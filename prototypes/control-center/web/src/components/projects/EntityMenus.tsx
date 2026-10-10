/**
 * Project and session action menus (legacy entity-menus.js). Triggers stay
 * separate from navigation rows, so opening a menu never switches context.
 */
import { AlarmClock, Archive, ArchiveRestore, BookOpen, Lightbulb, FolderInput, MoreHorizontal, Pencil, Puzzle, Settings2, ShieldCheck, SquarePen, Trash2 } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { selectProject } from '@/store/sync'
import { askOwed, openMind } from '@/store/mind-store'
import { toast, useUi } from '@/store/ui-store'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { openArchive, openCapabilities, openDelete, openMemory, openPermissions, openProjectSettings, openRename } from '@/components/settings/panel-store'
import { useT } from '@/i18n'
import { archiveEntity } from './entity-actions'

const fail = (error: unknown) => toast((error as Error).message, 'danger')

/** Items for a session row's existing menu. */
export function SessionMenuItems({ sessionId }: { sessionId: string }) {
  const archived = useApp(s => Boolean(s.sessionIndex[sessionId]?.archivedAt))
  const t = useT()
  return (
    <>
      <MenuItem icon={<Pencil />} onSelect={() => openRename({ kind: 'session', id: sessionId })}>{t('重命名')}</MenuItem>
      <MenuItem icon={archived ? <ArchiveRestore /> : <Archive />} onSelect={() => void archiveEntity('session', sessionId, !archived).catch(fail)}>{archived ? t('恢复会话') : t('归档会话')}</MenuItem>
      <MenuItem icon={<FolderInput />} onSelect={() => openArchive('sessions')}>{t('查看已归档')}</MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} danger onSelect={() => openDelete({ kind: 'session', id: sessionId })}>{t('删除会话…')}</MenuItem>
    </>
  )
}

export function ProjectMenu({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  const t = useT()
  const overdue = useApp(s => s.projects[projectId]?.counts?.overdueCommitments ?? 0)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" onClick={e => e.stopPropagation()} className="hidden size-6 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-visible:grid group-focus-within:grid group-hover:grid data-[state=open]:grid" aria-label={t('项目操作')}>
          <MoreHorizontal className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-52">
        {/* Same as the row's +: a blank conversation in this project, from any page (任务, 收件箱, 文件, 进化). */}
        <MenuItem icon={<SquarePen />} onSelect={() => { selectProject(projectId); useUi.setState({ view: 'chat', sidebarOpen: false }); onNavigate?.() }}>{t('新会话')}</MenuItem>
        <MenuItem icon={<Settings2 />} onSelect={() => { openProjectSettings(projectId); onNavigate?.() }}>{t('项目概览与设置…')}</MenuItem>
        <MenuItem icon={<ShieldCheck />} onSelect={() => openPermissions(projectId)}>{t('项目权限…')}</MenuItem>
        <MenuItem icon={<Puzzle />} onSelect={() => openCapabilities(projectId)}>{t('技能与工具')}</MenuItem>
        <MenuItem icon={<BookOpen />} onSelect={() => openMemory(projectId)}>{t('项目记忆')}</MenuItem>
        <MenuItem icon={<Lightbulb />} onSelect={() => { openMind(projectId); onNavigate?.() }}>{t('进化与经验')}</MenuItem>
        {overdue > 0 && <MenuItem icon={<AlarmClock />} onSelect={() => { void askOwed(projectId); onNavigate?.() }}>{t('Rna 欠你 {n} 件事', { n: overdue })}</MenuItem>}
        <MenuSeparator />
        <MenuItem icon={<Pencil />} onSelect={() => openRename({ kind: 'project', id: projectId })}>{t('重命名')}</MenuItem>
        <MenuItem icon={<Archive />} hint={t('记录保留')} onSelect={() => void archiveEntity('project', projectId, true).catch(fail)}>{t('归档项目')}</MenuItem>
        <MenuItem icon={<FolderInput />} onSelect={() => openArchive('projects')}>{t('查看已归档')}</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onSelect={() => openDelete({ kind: 'project', id: projectId })}>{t('删除项目…')}</MenuItem>
      </MenuContent>
    </Menu>
  )
}
