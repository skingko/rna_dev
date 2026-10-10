/**
 * Tool presentation: classify host tool calls into a small set of kinds and
 * produce Chinese verbs/targets for single-line rows. Prefers the v2 `kind` /
 * `target` fields and falls back to name-based rules for legacy items. Never
 * surfaces raw tool names, call IDs or host-internal paths.
 */
import type { Item, ToolCall, ToolKind } from '@/api/types'
import { frontMatterName, humanizeSkillId } from './skill-names'
import { partialJsonFields, TARGET_FIELDS } from './partial-json'
import { interpolate, localized, t } from '@/i18n'

export type ViewKind = ToolKind | 'list' | 'preview' | 'agent' | 'memory' | 'browser'

const NAME_KIND: Record<string, ViewKind> = {
  project_read: 'read', attachment_read: 'read', project_document_read: 'read', openviking_read: 'memory', read_context: 'memory', read: 'read', read_file: 'read',
  project_list: 'list', list: 'list', glob: 'search',
  project_write: 'write', write: 'write', write_file: 'write',
  project_edit: 'edit', edit: 'edit', apply_patch: 'edit',
  project_exec: 'command', project_exec_output: 'command', bash: 'command', shell: 'command', exec: 'command',
  grep: 'search', search: 'search', project_search: 'search', project_grep: 'search', project_find: 'search', openviking_search: 'search', marketplace_search: 'search',
  web_search: 'web_search', web_fetch: 'web_fetch', fetch_url: 'web_fetch', marketplace_read: 'web_fetch',
  skill_load: 'skill', capability_install: 'skill', capability_assign: 'skill', capability_list: 'skill',
  ask_user: 'question', ask_user_question: 'question',
  plan_update: 'plan', todo_write: 'plan', update_plan: 'plan',
  project_preview: 'preview',
  agent_consult: 'agent', agent_delegate: 'agent', agent_status: 'agent', agent_message: 'agent', agent_wait: 'agent', agent_cancel: 'agent', agent_merge: 'agent',
  judgment_policy_update: 'other',
}

/** The browser tools (Playwright MCP): `mcp__<server>__browser_navigate` → `navigate`. */
export function browserAction(tool: Pick<ToolCall, 'name'>): string | null {
  return /^mcp__[^_].*__browser_([a-z_]+)$/.exec(tool.name)?.[1] ?? null
}
/** What a browser step does, in words ("点击", "打开"…); the live view and the rows share it. */
export function browserVerb(action: string): string {
  const verbs: Record<string, string> = {
    navigate: t('打开'), navigate_back: t('返回上一页'), click: t('点击'), type: t('输入'), fill_form: t('填写表单'), press_key: t('按键'), hover: t('悬停'), drag: t('拖动'),
    select_option: t('选择'), wait_for: t('等待'), snapshot: t('读取页面结构'), take_screenshot: t('截图'), console_messages: t('查看控制台'), network_requests: t('查看网络请求'),
    tabs: t('切换标签页'), resize: t('调整窗口'), handle_dialog: t('处理对话框'), close: t('关闭浏览器'),
  }
  return verbs[action] ?? t('操作页面')
}

export function toolKind(tool: ToolCall): ViewKind {
  if (browserAction(tool)) return 'browser'
  if (tool.kind && tool.kind !== 'other') {
    // v2 kind is authoritative, but keep our finer split for list/preview/agent.
    const byName = NAME_KIND[tool.name]
    if (tool.kind === 'read' && byName === 'list') return 'list'
    if (tool.kind === 'read' && byName === 'memory') return 'memory'
    return tool.kind
  }
  if (tool.name.startsWith('mcp__') || tool.name.startsWith('mcp_')) return 'mcp'
  return NAME_KIND[tool.name] ?? tool.kind ?? 'other'
}

/** View kinds whose calls only read: they never change a file in the project folder. */
const READ_ONLY_KINDS = new Set<ViewKind>(['read', 'list', 'search', 'web_search', 'web_fetch', 'question', 'plan', 'memory'])
/**
 * Whether a call may have changed files in the project folder: any call not known to only read (a write or an edit,
 * a command, a delegation or a merge, a media, browser or MCP tool, a tool of unknown kind).
 */
export const mayChangeFiles = (tool: ToolCall) => !READ_ONLY_KINDS.has(toolKind(tool))

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Short, human-readable object of the call (path, command first line, query…). */
export function toolTarget(tool: ToolCall): string {
  // Browser steps read as what they do ("点击 开始比赛按钮"); the host's target is only the bare argument.
  const action = browserAction(tool)
  if (action) {
    const a = tool.args ?? {}
    // Local test pages keep their port; the long preview token in the path is noise.
    const detail = action === 'navigate' ? str(a.url).replace(/^https?:\/\//, '').replace(/\/[0-9a-f]{32,}/, '') : action === 'wait_for' ? (typeof a.time === 'number' ? t('{n} 秒', { n: a.time }) : str(a.text) || str(a.textGone)) : action === 'console_messages' ? str(a.level) : str(a.element) || str(a.text) || str(a.key) || str(a.filename)
    return [browserVerb(action), detail].filter(Boolean).join(' ')
  }
  // The host's target for these is the first string argument (a bare "all", an agent id); say what was asked instead.
  const managed = agentManagementTarget(tool)
  if (managed !== null) return managed
  if (tool.target) return tool.target
  // A preparing entry only has the raw argument prefix; read what has arrived.
  const a = tool.args ?? (tool.preparing && tool.argsPreview ? partialJsonFields(tool.argsPreview, TARGET_FIELDS) : {})
  const kind = toolKind(tool)
  if (kind === 'command') {
    if (tool.name === 'project_exec_output') return t('查看之前的命令输出')
    return str(a.command).split('\n')[0].trim()
  }
  if (kind === 'web_search' || kind === 'search') return str(a.query) || str(a.pattern) || str(a.q)
  if (kind === 'web_fetch') return prettyUrl(str(a.url)) || str(a.ref) || str(a.id) || str(a.source)
  if (kind === 'skill') return str(a.name) || frontMatterName(tool.output) || humanizeSkillId(str(a.id)) || str(a.path)
  if (kind === 'question') return firstQuestion(a)
  if (kind === 'preview') return ({ start: t('启动预览'), status: t('检查预览状态'), stop: t('停止预览'), open: t('打开预览') } as Record<string, string>)[str(a.action)] ?? t('项目预览')
  if (kind === 'memory') return str(a.uri).replace(/^viking:\/\/.*\//, '') || (Array.isArray(a.sources) ? t('会话上下文') : t('项目记忆'))
  if (kind === 'agent') return str(a.task).split('\n')[0] || str(a.question).split('\n')[0] || str(a.agent)
  if (kind === 'list') return str(a.path) || '.'
  const path = str(a.path) || str(a.file_path) || str(a.file)
  if (path) return path
  if (tool.argsPreview && !tool.preparing) return tool.argsPreview
  return ''
}

const SIDES: Record<string, string> = localized({ current: '保留你的版本', incoming: '用子代理的版本' })
/** The object of a step that manages subagents (null for other tools): never a raw agent id. */
function agentManagementTarget(tool: ToolCall): string | null {
  if (!tool.args || !(tool.name in AGENT_VERBS || tool.name === 'agent_merge')) return null
  const a = tool.args
  if (tool.name === 'agent_wait') {
    const n = Array.isArray(a.agentIds) ? a.agentIds.length : 0
    return n > 1 ? (a.mode === 'all' ? t('{n} 个都完成', { n }) : t('{n} 个中任一完成', { n })) : ''
  }
  if (tool.name === 'agent_message') return str(a.message).split('\n')[0].trim()
  if (tool.name !== 'agent_merge') return ''
  const take = Array.isArray(a.take) ? a.take.filter((row): row is { path: string; side: string } => Boolean(row) && typeof row === 'object' && typeof (row as { path?: unknown }).path === 'string') : []
  if (take.length) return [take.length > 1 ? t('{path} 等 {n} 个文件', { path: take[0].path, n: take.length }) : take[0].path, new Set(take.map(row => row.side)).size === 1 ? SIDES[take[0].side] : ''].filter(Boolean).join(' · ')
  return str(a.path)
}

function firstQuestion(args: Record<string, unknown>): string {
  const qs = args.questions
  if (Array.isArray(qs) && qs[0] && typeof qs[0] === 'object') return str((qs[0] as Record<string, unknown>).question)
  return str(args.question)
}

export function prettyUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

/**
 * Caveat for a succeeded web_search whose provider could not apply the time
 * filter (explicit host notice, or the fastcrw result envelope says so).
 */
export function webToolNotice(tool: Partial<ToolCall> & { notice?: { kind?: string } } = {}): string | null {
  if (tool.name !== 'web_search' || tool.status !== 'succeeded') return null
  let unfiltered = tool.notice?.kind === 'web_time_filter_not_applied'
  if (!unfiltered && typeof tool.output === 'string' && tool.output.length <= 64000) {
    try {
      const result = JSON.parse(tool.output)
      unfiltered = result?.ok === true && result.provider === 'fastcrw' && result.operation === 'search' && result.filterApplied === false && result.filterStatus === 'not_applied'
    } catch { /* not JSON */ }
  }
  return unfiltered ? t('时间筛选暂不可用；已返回未按时间筛选的结果，请核对发布日期。') : null
}

export function toolRunning(tool: ToolCall): boolean {
  return tool.status === 'running' || tool.status === 'pending' || tool.status === undefined
}
export function toolFailed(tool: ToolCall): boolean {
  return tool.status === 'failed' || tool.status === 'error'
}
export function toolStopped(tool: ToolCall): boolean {
  return tool.status === 'cancelled' || tool.status === 'interrupted' || tool.status === 'stopped'
}
/** The host could not confirm whether the step took effect (the turn then failed asking the user to check). */
export function toolUncertain(tool: ToolCall): boolean {
  return tool.status === 'uncertain'
}
/** Ended without confirmed work (failed, stopped by the user or a restart, or unconfirmed): never counted as done or delivered. */
export function toolUnfinished(tool: ToolCall): boolean {
  return toolFailed(tool) || toolStopped(tool) || toolUncertain(tool)
}

/**
 * `prepareWith` replaces `prepare` once the target is known (准备运行 npm test…).
 * `group` / `groupRunning` are templates for merged rows ("读取了 {n} 个文件");
 * `{n|one|other}` gives English plurals.
 */
interface VerbSet { running: string; done: string; failed: string; prepare: string; prepareWith?: string; group?: string; groupRunning?: string }

/** Harness step-process copy; strings are translated when read (localized). */
export const VERBS: Record<ViewKind, VerbSet> = localized({
  read: { running: '正在读取', done: '已读取', failed: '读取失败', prepare: '准备读取', group: '读取了 {n} 个文件', groupRunning: '正在读取 · {n} 个文件' },
  list: { running: '正在查看目录', done: '查看了目录', failed: '查看目录失败', prepare: '准备查看目录', group: '查看了 {n} 个目录', groupRunning: '正在查看目录 · {n} 个目录' },
  write: { running: '正在写入', done: '已写入', failed: '写入失败', prepare: '准备写入' },
  edit: { running: '正在编辑', done: '已编辑', failed: '编辑失败', prepare: '准备编辑' },
  search: { running: '正在搜索', done: '已搜索', failed: '搜索失败', prepare: '准备搜索', group: '搜索了 {n} 次', groupRunning: '正在搜索 · {n} 次' },
  command: { running: '正在运行', done: '已运行', failed: '运行失败', prepare: '准备运行命令', prepareWith: '准备运行' },
  web_search: { running: '正在搜索网页', done: '已搜索网页', failed: '搜索网页失败', prepare: '准备搜索网页', group: '搜索了 {n} 次网页', groupRunning: '正在搜索网页 · {n} 次网页' },
  web_fetch: { running: '正在访问', done: '已访问', failed: '访问失败', prepare: '准备访问网页', prepareWith: '准备访问', group: '访问了 {n} 个网页', groupRunning: '正在访问 · {n} 个网页' },
  skill: { running: '正在加载技能', done: '已加载技能', failed: '加载技能失败', prepare: '准备加载技能', group: '加载了 {n} 项技能', groupRunning: '正在加载技能 · {n} 项技能' },
  mcp: { running: '正在调用工具', done: '已调用工具', failed: '调用工具失败', prepare: '准备调用工具' },
  browser: { running: '正在操作浏览器', done: '浏览器', failed: '浏览器操作失败', prepare: '准备操作浏览器' },
  question: { running: '等待你的回答', done: '已提问', failed: '提问失败', prepare: '准备提问' },
  plan: { running: '正在更新计划', done: '更新了计划', failed: '更新计划失败', prepare: '准备更新计划' },
  preview: { running: '正在处理预览', done: '预览', failed: '预览失败', prepare: '准备预览' },
  agent: { running: '正在咨询协作代理', done: '咨询了协作代理', failed: '咨询协作代理失败', prepare: '准备咨询协作代理' },
  memory: { running: '正在读取记忆', done: '读取了记忆', failed: '读取记忆失败', prepare: '准备读取记忆', group: '读取了 {n} 条记忆', groupRunning: '正在读取记忆 · {n} 条记忆' },
  other: { running: '正在调用工具', done: '已调用工具', failed: '调用工具失败', prepare: '准备调用工具' },
})

/** Media tools say what they made rather than "已调用工具". */
const MEDIA_VERBS: Record<string, VerbSet> = localized({
  image_generate: { running: '正在生成图片', done: '已生成图片', failed: '生成图片失败', prepare: '准备生成图片' },
  speech_generate: { running: '正在合成语音', done: '已合成语音', failed: '合成语音失败', prepare: '准备合成语音' },
  audio_transcribe: { running: '正在识别音频', done: '已识别音频', failed: '识别音频失败', prepare: '准备识别音频' },
  video_generate: { running: '正在生成视频', done: '已生成视频', failed: '生成视频失败', prepare: '准备生成视频' },
})
/** Steps that manage subagents say what they did with them, not "咨询了协作代理" (agent_consult keeps that). */
const AGENT_VERBS: Record<string, VerbSet> = localized({
  agent_wait: { running: '正在等待协作代理', done: '等待了协作代理', failed: '等待协作代理失败', prepare: '准备等待协作代理' },
  agent_status: { running: '正在查看协作代理', done: '查看了协作代理', failed: '查看协作代理失败', prepare: '准备查看协作代理' },
  agent_message: { running: '正在给协作代理发消息', done: '给协作代理发了消息', failed: '给协作代理发消息失败', prepare: '准备给协作代理发消息' },
  agent_cancel: { running: '正在取消协作代理', done: '取消了协作代理', failed: '取消协作代理失败', prepare: '准备取消协作代理' },
})
/** agent_merge, by its `action` (default merge). */
const MERGE_VERBS: Record<string, VerbSet> = localized({
  merge: { running: '正在合并子代理的改动', done: '合并了子代理的改动', failed: '合并子代理的改动失败', prepare: '准备合并子代理的改动' },
  show: { running: '正在查看冲突', done: '查看了冲突', failed: '查看冲突失败', prepare: '准备查看冲突' },
  take: { running: '正在选定合并版本', done: '选定了合并版本', failed: '选定合并版本失败', prepare: '准备选定合并版本' },
  resolved: { running: '正在确认冲突已解决', done: '确认了冲突已解决', failed: '确认冲突已解决失败', prepare: '准备确认冲突已解决' },
  drop: { running: '正在丢弃子代理的改动', done: '丢弃了子代理的改动', failed: '丢弃子代理的改动失败', prepare: '准备丢弃子代理的改动' },
})
const verbsOf = (tool: ToolCall): VerbSet => MEDIA_VERBS[tool.name] ?? AGENT_VERBS[tool.name] ?? (tool.name === 'agent_merge' ? MERGE_VERBS[str(tool.args?.action)] ?? MERGE_VERBS.merge : VERBS[toolKind(tool)])

/** Kinds whose consecutive calls merge into one "读取了 6 个文件" row. */
export const GROUPABLE = new Set<ViewKind>(['read', 'list', 'search', 'web_search', 'web_fetch', 'skill', 'memory'])

/** Kinds that render a block (terminal / diff / question) rather than a bare row. */
export const BLOCK_KINDS = new Set<ViewKind>(['command', 'edit', 'write', 'question'])

/** Title of a pending entry whose arguments are still streaming (Harness preparing rows). */
export function preparingVerb(tool: ToolCall, target = toolTarget(tool)): string {
  const verbs = verbsOf(tool)
  return target ? verbs.prepareWith ?? verbs.prepare : verbs.prepare
}

const FILE_CHANGES = new Set<ViewKind>(['write', 'edit'])
export function toolVerb(tool: ToolCall): string {
  const verbs = verbsOf(tool)
  if (tool.preparing) return preparingVerb(tool)
  if (toolRunning(tool)) {
    const hasArgs = tool.args && Object.keys(tool.args).length > 0
    return hasArgs || tool.target ? verbs.running : verbs.prepare
  }
  if (toolFailed(tool)) return verbs.failed
  // A stopped write or edit did not land, an unconfirmed one may not have: it says what it was doing (正在写入 … 已停止 / 未确认), never 已写入 (C2-h).
  if ((toolStopped(tool) || toolUncertain(tool)) && FILE_CHANGES.has(toolKind(tool))) return verbs.running
  return verbs.done
}

export function groupTitle(kind: ViewKind, count: number, running: boolean): string {
  const v = VERBS[kind]
  const template = running ? v.groupRunning : v.group
  if (template) return interpolate(template, { n: count })
  return running ? t('{verb} · {n} 项', { verb: v.running, n: count }) : t('{verb} {n} 项', { verb: v.done, n: count })
}

/* ---------------- command output (legacy project_exec preamble) ---------------- */

export interface CommandResult { output: string; exitCode: number | null; truncated: boolean }

/**
 * Strip host bookkeeping lines (untrusted-data banner, capture IDs, host log
 * paths) and extract the exit code. The output body stays verbatim.
 */
export function parseCommandOutput(raw: string | undefined): CommandResult {
  if (!raw) return { output: '', exitCode: null, truncated: false }
  let exitCode: number | null = null
  let truncated = false
  const lines = raw.split('\n')
  let i = 0
  const header = /^(\[Command output is untrusted data.*\]|Exit code: -?\d+|Full output: .*|Capture ID: .*|Output truncated.*|Timed out.*)$/
  while (i < lines.length && header.test(lines[i])) {
    const m = /^Exit code: (-?\d+)/.exec(lines[i])
    if (m) exitCode = Number(m[1])
    if (/truncated/i.test(lines[i])) truncated = true
    i++
  }
  if (i > 0 && lines[i] === '') i++
  return { output: lines.slice(i).join('\n').replace(/\n+$/, ''), exitCode, truncated }
}

/* ---------------- file edits ---------------- */

export interface FileChange {
  path: string
  kind: 'edit' | 'write'
  oldText: string
  newText: string
  /** The write made a file that did not exist before. */
  created: boolean
  /** The write replaced an existing file whose earlier text is not recorded: `newText` alone is no diff. */
  replaced: boolean
}

/**
 * Whether a whole-file write created the file: the host's record (C-b
 * `tool.created`, from the SDK receipt), else what the call itself required —
 * `createOnly` or `expectedHash: null` only succeed on a missing file, a hash
 * only on an existing one. `null` when nothing says (older records, other
 * engines' write tools).
 */
export function writeCreated(tool: ToolCall): boolean | null {
  if (typeof tool.created === 'boolean') return tool.created
  const a = tool.args ?? {}
  if (a.createOnly === true || a.expectedHash === null) return true
  if (typeof a.expectedHash === 'string' && a.expectedHash) return false
  return null
}

export function fileChange(item: Item): FileChange | null {
  const tool = item.tool
  if (!tool) return null
  const kind = toolKind(tool)
  if (kind !== 'edit' && kind !== 'write') return null
  const a = tool.args ?? {}
  const path = str(a.path) || str(a.file_path) || tool.target || ''
  if (kind === 'write') {
    // A known overwrite is never shown as a new file; an unrecorded write keeps reading as one.
    const created = writeCreated(tool)
    return { path, kind, oldText: '', newText: str(a.content), created: created !== false, replaced: created === false }
  }
  // project_edit sends edits[] (several replacements in one call); the older single oldText/newText still appears.
  const parts = [...(Array.isArray(a.edits) ? a.edits : []), ...(a.oldText !== undefined || a.newText !== undefined ? [{ oldText: a.oldText, newText: a.newText }] : [])]
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
  // Separate places in the file stay apart in the snippet diff: a shared "…" line sits between them.
  if (parts.length) return { path, kind, oldText: parts.map(part => str(part.oldText)).join('\n…\n'), newText: parts.map(part => str(part.newText)).join('\n…\n'), created: false, replaced: false }
  return { path, kind, oldText: str(a.old_string), newText: str(a.new_string), created: false, replaced: false }
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
/** Files a media tool wrote into the project. Calls recorded before the host kept them fall back to the one image path asked for. */
export function mediaFiles(tool: ToolCall | undefined): { path: string; mimeType: string }[] {
  if (!tool || tool.status !== 'succeeded') return []
  if (tool.files?.length) return tool.files
  const path = tool.name === 'image_generate' ? str(tool.args?.path) : ''
  const type = IMAGE_TYPES[/\.([a-z]+)$/i.exec(path)?.[1].toLowerCase() ?? '']
  return path && type && (tool.args?.count ?? 1) === 1 ? [{ path, mimeType: type }] : []
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}
export function dirname(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

/**
 * One verb line for a finished turn's tool calls (plan 2026-09-30 §2.4):
 * "读了 12 次、改了 3 个文件、运行 2 条命令" — what was done, never tool names.
 */
export function processSummary(tools: ToolCall[]): string {
  const counts = { read: 0, search: 0, files: new Set<string>(), command: 0, web: 0, other: 0 }
  for (const tool of tools) {
    if (toolUnfinished(tool)) continue
    const kind = toolKind(tool)
    if (kind === 'read' || kind === 'list' || kind === 'memory') counts.read++
    else if (kind === 'search' || kind === 'web_search') counts.search++
    else if (kind === 'write' || kind === 'edit') counts.files.add(toolTarget(tool) || tool.id || String(counts.files.size))
    else if (kind === 'command') counts.command++
    else if (kind === 'web_fetch') counts.web++
    else if (kind !== 'question' && kind !== 'skill' && kind !== 'plan') counts.other++
  }
  const parts = [
    counts.read ? t('读了 {n} 次', { n: counts.read }) : '',
    counts.search ? t('搜索 {n} 次', { n: counts.search }) : '',
    counts.files.size ? t('改了 {n} 个文件', { n: counts.files.size }) : '',
    counts.command ? t('运行 {n} 条命令', { n: counts.command }) : '',
    counts.web ? t('查看 {n} 个网页', { n: counts.web }) : '',
    counts.other ? t('其他 {n} 步', { n: counts.other }) : '',
  ].filter(Boolean)
  return parts.join(t('、'))
}
