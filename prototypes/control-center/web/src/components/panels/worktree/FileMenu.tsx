/**
 * Right-click on a changed file (both sources): copy its absolute or relative
 * path, show it in the Files panel, show it in Finder when the desktop shell
 * offers that.
 */
import type { ReactNode } from 'react'
import { Copy, FolderSearch, FolderTree } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/overlays'
import { besideTarget, useSidePanel } from '@/store/side-panel-store'
import { openSurface } from '@/store/surface-router'
import { toast } from '@/store/ui-store'
import { desktopErrorText, desktopRevealPath } from '@/lib/desktop'
import { useT, t } from '@/i18n'

export const absolutePath = (workspace: string | undefined, path: string) => (workspace ? `${workspace.replace(/\/+$/, '')}/${path.replace(/\/$/, '')}` : path)

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast(t('已复制路径')), () => toast(t('没能复制，请手动选择文本复制。'), 'danger'))
}

/**
 * The Files panel on this file, through the surface router: a Files panel already showing the project is focused,
 * else one opens beside the changes panel (following the current project when that is the one shown).
 */
export function revealInFiles(projectId: string, path: string) {
  const { layout, ctx, viewport } = useSidePanel.getState()
  const target = besideTarget(layout, 'worktree', ctx, viewport) ?? undefined
  openSurface('files', projectId, { where: 'panel', from: 'menu', path: path.replace(/\/$/, ''), place: target ? { target } : undefined })
}

export function FileMenu({ path, workspace, projectId, deleted, children }: { path: string; workspace: string | undefined; projectId: string; deleted?: boolean; children: ReactNode }) {
  const tr = useT()
  // The desktop shell's 在访达中显示, when this build has it (the web has no way to).
  const reveal = desktopRevealPath()
  const absolute = absolutePath(workspace, path)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={<Copy />} onSelect={() => copy(absolute)} disabled={!workspace}>{tr('复制绝对路径')}</ContextMenuItem>
        <ContextMenuItem icon={<Copy />} onSelect={() => copy(path.replace(/\/$/, ''))}>{tr('复制相对路径')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<FolderTree />} onSelect={() => revealInFiles(projectId, path)} disabled={deleted}>{tr('在文件面板中显示')}</ContextMenuItem>
        {reveal && workspace && <ContextMenuItem icon={<FolderSearch />} onSelect={() => { void reveal(absolute).catch(error => toast(desktopErrorText(error) || tr('没能在访达中显示这个文件。'), 'danger')) }} disabled={deleted}>{tr('在访达中显示')}</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  )
}
