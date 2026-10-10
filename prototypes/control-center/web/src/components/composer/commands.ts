/**
 * Composer command registry (public/composer-commands.js). One registry owns
 * both the "+" launcher and slash resolution. These are host/client actions;
 * none is implemented by sending a command-shaped prompt to the model.
 */
import type { CommandCatalog } from '@/api/project-api'
import { t, localized } from '@/i18n'

export type CommandId = 'file' | 'goal' | 'plan' | 'feedback' | 'compact' | 'permission' | 'model' | 'export' | 'project' | 'versions' | 'new' | 'skills' | 'build' | 'stop'
export type CommandGroup = 'add' | 'command' | 'navigate'
/** Section headings in the "+" launcher / slash menu. */
export const GROUP_LABELS: Record<CommandGroup, string> = localized({ add: '添加', command: '指令', navigate: '导航' })

export interface ComposerCommand { id: CommandId; label: string; group: CommandGroup; detail: string; aliases?: string[] }

export const COMPOSER_COMMANDS: ComposerCommand[] = localized([
  { id: 'file', label: '文件或图片', group: 'add', detail: '添加文件到当前会话' },
  { id: 'goal', label: '目标', group: 'add', detail: '设置或查看项目当前关注' },
  { id: 'plan', label: '计划', group: 'add', detail: '进入或退出只读计划模式' },
  { id: 'feedback', label: '反馈', group: 'add', detail: '记录当前项目的反馈' },
  { id: 'compact', label: '压缩', group: 'command', detail: '用实际模型整理会话上下文' },
  { id: 'permission', aliases: ['permissions'], label: '权限', group: 'command', detail: '项目执行权限与后台权限' },
  { id: 'model', label: '模型', group: 'command', detail: '选择本会话使用的模型' },
  { id: 'export', label: '下载日志', group: 'command', detail: '导出脱敏会话 ZIP' },
  { id: 'project', label: '项目概览', group: 'navigate', detail: '查看项目状态' },
  { id: 'versions', aliases: ['evolution'], label: '进化', group: 'navigate', detail: '看项目学到了什么、变得怎样' },
  { id: 'new', label: '新会话', group: 'navigate', detail: '保留当前草稿并新建会话' },
  { id: 'skills', label: '技能与工具', group: 'navigate', detail: '管理项目能力' },
  { id: 'build', label: '执行模式', group: 'navigate', detail: '退出只读计划模式' },
  { id: 'stop', label: '停止', group: 'navigate', detail: '停止当前轮次' },
])

export interface CommandContext { sessionId: string | null; projectId: string | null; status: string; mode: string }

const HOST_REASONS: Record<string, string> = localized({ session_busy: '先结束当前轮次', project_required: '需要项目会话', runtime_unavailable: '真实运行时尚未启用' })

/** Why a command cannot run right now (null when available). Same rules as the legacy launcher. */
export function unavailableReason(command: ComposerCommand, context: CommandContext, catalog: CommandCatalog | null, busy = false): string | null {
  if (busy) return t('上一个指令正在执行')
  const host = catalog && catalog.sessionId === context.sessionId ? catalog.commands.find(item => item.id === (command.id === 'build' ? 'plan' : command.id)) : null
  if (host?.available === false && !(host.reason === 'session_busy' && context.status === 'idle')) return HOST_REASONS[host.reason ?? ''] ?? t('当前不可用')
  if (['file', 'goal', 'plan', 'feedback', 'compact', 'export', 'build', 'stop'].includes(command.id) && !context.sessionId) {
    // Before the first message the file picker and mode switch act on the draft.
    if (command.id === 'file' || command.id === 'plan' || command.id === 'build') return null
    return t('先新建一段会话')
  }
  if (['plan', 'build', 'compact'].includes(command.id) && context.status !== 'idle') return t('先结束当前轮次')
  if (command.id === 'stop' && context.status === 'idle') return t('当前没有运行中的轮次')
  return null
}

/** Launcher shows 添加 + 指令; typing a slash query searches every command (legacy behaviour). */
export function filterCommands(query: string, launch: boolean): ComposerCommand[] {
  const q = query.trim().toLowerCase()
  return COMPOSER_COMMANDS.filter(command => {
    if (launch && !q) return command.group !== 'navigate'
    return [command.id, ...(command.aliases ?? []), command.label].some(value => value.toLowerCase().startsWith(q) || (launch && value.toLowerCase().includes(q)))
  })
}

export function resolveSlash(text: string): { command: ComposerCommand; argument: string } | null {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return null
  const command = COMPOSER_COMMANDS.find(c => c.id === match[1] || c.aliases?.includes(match[1]))
  return command ? { command, argument: match[2] ?? '' } : null
}

/** `/xyz` alone on the line opens the slash menu. */
export function slashQuery(text: string): string | null {
  const match = /^\s*\/([\w-]*)$/.exec(text)
  return match ? match[1] : null
}
