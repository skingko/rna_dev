/** Install form → request body (port of installInput in public/capabilities-ui.js). */
import type { CapabilityInstallInput } from '@/api/panels-types'
import { t, localized } from '@/i18n'

export type InstallSource = 'local-skill' | 'browser-preset' | 'git-skill' | 'npm-mcp' | 'mcp-json'

export interface InstallDraft {
  source: InstallSource
  name: string
  activate: boolean
  localPath: string
  repository: string
  subdirectory: string
  ref: string
  packageName: string
  bin: string
  args: string
  browserExecutable: string
  json: string
}

export const emptyInstallDraft = (): InstallDraft => ({ source: 'local-skill', name: '', activate: true, localPath: '', repository: '', subdirectory: '', ref: '', packageName: '', bin: '', args: '', browserExecutable: '', json: '' })

export const SOURCE_LABELS: Record<InstallSource, string> = localized({
  'local-skill': '本地技能目录', 'browser-preset': '浏览器与网页验证（官方 Playwright）', 'git-skill': 'Git 仓库中的技能', 'npm-mcp': 'npm MCP 服务', 'mcp-json': '导入 MCP 配置',
})

export function installInput(d: InstallDraft): CapabilityInstallInput {
  const common = { activate: d.activate, ...(d.name.trim() && d.source !== 'mcp-json' ? { name: d.name.trim() } : {}), reason: t('通过当前项目的技能与工具面板安装') }
  if (d.source === 'local-skill') return { ...common, kind: 'skill', source: { type: 'local', path: d.localPath.trim() } }
  if (d.source === 'git-skill') return { ...common, kind: 'skill', source: { type: 'git', repository: d.repository.trim(), subdirectory: d.subdirectory.trim() || '.', ...(d.ref.trim() ? { ref: d.ref.trim() } : {}) } }
  if (d.source === 'npm-mcp') return { ...common, kind: 'mcp', ...(d.activate ? { toolPermission: 'exec' as const } : {}), source: { type: 'npm', package: d.packageName.trim(), ...(d.bin.trim() ? { bin: d.bin.trim() } : {}), args: d.args.split(/\r?\n/).filter(value => value.trim()) } }
  if (d.source === 'browser-preset') return { ...common, kind: 'mcp', source: { type: 'preset', preset: 'playwright-browser', ...(d.browserExecutable.trim() ? { executablePath: d.browserExecutable.trim() } : {}) } }
  let config: unknown
  try { config = JSON.parse(d.json) } catch { throw new Error(t('MCP 配置不是有效 JSON，请检查括号、引号和逗号。')) }
  return { ...common, kind: 'mcp', ...(d.activate ? { toolPermission: 'exec' as const } : {}), source: { type: 'mcp-config', config } }
}

export function permissionNote(d: Pick<InstallDraft, 'source' | 'activate'>) {
  const mcp = ['npm-mcp', 'mcp-json', 'browser-preset'].includes(d.source)
  if (d.source === 'browser-preset' && d.activate) return t('安装固定版本的官方 MCP，并验证真实浏览器。仅授予导航、快照、交互和截图等限定工具；使用时还须项目允许执行。不同会话隔离，后台权限仍单独设置，不是操作系统或网络沙箱。')
  if (mcp) return d.activate ? t('启用会启动服务，并允许本次发现的工具在本机或远端执行。导入配置已限定工具权限时，严格保留该范围；已停用的服务仍保持停用。仅启用你信任的来源。') : t('只保存安装与连接配置，不启动服务或向项目授予工具。')
  return t('复制完整技能说明与附带资源；安装时不会运行其中的脚本。')
}
