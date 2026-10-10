/**
 * "打开标签页": the chooser behind a group's "+" (and what an empty group
 * shows). Cards for 辅助对话, 审查, 终端 and 浏览器, plus 后台任务, 文件,
 * 工作区改动 and 进化 once their panels are registered; picking one replaces
 * the chooser tab, or opens into the group the empty chooser stands in for.
 * 文件, 工作区改动 and 进化 follow the current project, and a panel already
 * showing it is brought up instead. One column below 320 px of width.
 * `useLauncherCards` is the list itself, which the "+" button's hover menu
 * shows too.
 */
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { FileCheck2, FolderTree, GitCompareArrows, Globe, ListChecks, MessagesSquare, Sprout, SquareTerminal } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { openTab, type OpenOptions } from '@/store/side-panel-store'
import { usePanel } from '@/components/workspace/registry'
import { openTasksPanel } from '@/components/workspace/tasks-panel'
import { openWorktree } from '@/components/workspace/worktree-open'
import { openSurface } from '@/store/surface-router'
import { cn } from '@/lib/utils'
import { openBrowserTab, openSideChat, openTerminalTab } from './open'
import { useT } from '@/i18n'
import { readSessionFor } from '@/lib/session-root'

/** One kind of tab the chooser offers: its card here, its row in the "+" button's hover menu. */
export interface LauncherCard {
  id: string
  icon: ReactNode
  label: string
  /** What it opens, or why it cannot open now. */
  hint: string
  disabled?: boolean
  onOpen: () => void
}

/**
 * The kinds of tab to open, with what each needs (a conversation, a project, the service's support) and where it
 * goes: `place` replaces a chooser tab or targets a group. Shared by the chooser and the "+" hover menu.
 */
export function useLauncherCards({ place, sessionId, projectId }: { place: Pick<OpenOptions, 'replace' | 'target'>; sessionId: string | null; projectId: string | null }): LauncherCard[] {
  const t = useT()
  const capabilities = useApp(s => s.capabilities)
  const tasks = usePanel('tasks')
  const files = usePanel('files')
  const evolution = usePanel('evolution')
  const worktree = usePanel('worktree')
  const sideChat = Boolean(sessionId) && Boolean(capabilities?.sideChat)
  const terminal = Boolean(projectId) && Boolean(capabilities?.terminal)
  return [
    {
      id: 'side-chat', icon: <MessagesSquare />, label: t('辅助对话'),
      hint: !sessionId ? t('先开始一段会话') : sideChat ? t('不打断主对话，单独追问') : t('当前的 Rna 服务暂不支持'),
      disabled: !sideChat, onOpen: () => { if (sessionId) openSideChat(sessionId, null, place) },
    },
    {
      id: 'review', icon: <FileCheck2 />, label: t('审查'),
      hint: sessionId ? t('本会话改动的全部文件') : t('先开始一段会话'),
      disabled: !sessionId, onOpen: () => { if (sessionId) openTab({ type: 'review', sessionId, itemIds: null, focus: null }, place) },
    },
    {
      id: 'terminal', icon: <SquareTerminal />, label: t('终端'),
      hint: !projectId ? t('先选择项目') : !capabilities?.terminal ? t('当前的 Rna 服务暂不支持') : projectId && readSessionFor(projectId, sessionId) ? t('在这个对话的工作树中运行命令') : t('在项目目录中运行命令'),
      // A worktree conversation's terminal starts in its own copy (worktree design §9).
      disabled: !terminal, onOpen: () => { if (projectId) openTerminalTab(projectId, place, readSessionFor(projectId, sessionId)) },
    },
    {
      id: 'browser', icon: <Globe />, label: t('浏览器'), hint: t('预览本机网页与开发服务'),
      onOpen: () => openBrowserTab('', place),
    },
    ...(tasks ? [{
      id: 'tasks', icon: <ListChecks />, label: t('后台任务'), hint: t('查看正在运行和最近完成的后台工作'),
      onOpen: () => { openTasksPanel({}, place) },
    }] : []),
    ...(files ? [{
      id: 'files', icon: <FolderTree />, label: t('文件'), hint: projectId ? t('浏览项目文件，运行网页预览') : t('先选择项目'),
      disabled: !projectId, onOpen: () => { openSurface('files', projectId, { where: 'panel', from: 'launcher', place }) },
    }] : []),
    ...(worktree ? [{
      id: 'worktree', icon: <GitCompareArrows />, label: t('工作区改动'), hint: projectId ? t('项目里改了哪些文件，逐个查看差异') : t('先选择项目'),
      disabled: !projectId, onOpen: () => { openWorktree(projectId, { place }) },
    }] : []),
    ...(evolution ? [{
      id: 'evolution', icon: <Sprout />, label: t('进化'), hint: projectId ? t('项目学到的做法和规则') : t('先选择项目'),
      disabled: !projectId, onOpen: () => { openSurface('evolution', projectId, { where: 'panel', from: 'launcher', place }) },
    }] : []),
  ]
}

export function Launcher({ tabId, groupId = null, sessionId, projectId }: { tabId: string | null; groupId?: string | null; sessionId: string | null; projectId: string | null }) {
  const t = useT()
  // A chooser tab is replaced in place; the empty-group chooser opens into its group.
  const place: Pick<OpenOptions, 'replace' | 'target'> = tabId ? { replace: tabId } : groupId ? { target: groupId } : {}
  const cards = useLauncherCards({ place, sessionId, projectId })
  return (
    <div className="@container/launcher flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[440px] px-4 pb-10 pt-[clamp(28px,12vh,96px)] @[320px]/launcher:px-6">
        <h2 className="text-[16px] font-semibold text-fg">{t('打开标签页')}</h2>
        <p className="mt-1 text-[13px] text-fg-3">{t('选择要在侧边面板中打开的标签。')}</p>
        <div className="mt-5 grid grid-cols-1 gap-2.5 @[320px]/launcher:grid-cols-2" role="list">
          {cards.map((card, i) => (
            <motion.button
              key={card.id}
              type="button"
              role="listitem"
              data-launcher={card.id}
              disabled={card.disabled}
              onClick={card.onOpen}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: i * 0.035, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'group flex min-h-[92px] flex-col items-start gap-2.5 rounded-xl bg-elevated p-3.5 text-left shadow-[0_0_0_0.5px_var(--line-strong),var(--shadow-xs)] outline-none transition-[background-color,box-shadow,transform] duration-150',
                'hover:bg-subtle focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="grid size-8 place-items-center rounded-lg bg-accent-softer text-accent-text transition-colors group-hover:bg-accent-soft [&_svg]:size-[17px]">{card.icon}</span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-fg">{card.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-4 text-fg-4">{card.hint}</span>
              </span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  )
}
