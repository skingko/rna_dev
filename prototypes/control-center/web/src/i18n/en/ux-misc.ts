/** UX audit 2026-10-03: strings added by the misc fixes. */
export default {
  // Browser fetch failures (api/transport.ts)
  '请求超时，请重试。': 'The request timed out. Please try again.',
  '无法连接本地服务，请稍后重试。': "Can't reach the local service. Please try again shortly.",
  // Run preview start feedback (preview/open.ts, FilesView)
  '预览正在启动，请稍候…': 'The preview is still starting…',
  '正在启动预览…': 'Starting preview…',
  '暂未找到可运行的预览入口，已改为静态查看（不运行脚本）。': 'No runnable preview entry was found, so the page is shown statically (scripts do not run).',
  '预览未能启动，已改为静态查看（不运行脚本）。{message}': 'The preview could not start, so the page is shown statically (scripts do not run). {message}',
  // Memory sync panel (MemorySyncPanel)
  '这一段没有同步成功。': 'This part did not sync.',
  '{n} 段没有同步成功': "{n} {n|part|parts} didn't sync",
  '{n} 段未同步': '{n} unsynced',
  // Outcomes still being checked, and the project summary upkeep (A2: settled losses are history, nothing to acknowledge)
  '部分记忆同步结果还在核对': 'Some memory sync results are still being checked',
  '{n} 段还在核对': '{n} still being checked',
  '核对中': 'Checking',
  '项目摘要正在整理。': 'The project summary is being rebuilt.',
  '项目摘要的整理结果还在核对。': 'The project summary rebuild is still being checked.',
  '项目摘要没有整理完整，下次提炼后会重新整理；记忆原文不受影响。': 'The project summary was not fully rebuilt; it is rebuilt after the next extraction, and the memories themselves are unaffected.',
  // The same upkeep as a note on the memory page and in settings (memory-display summaryStatusMessage)
  '目录摘要的整理结果还在核对。仍可浏览目录查看原文。': 'The directory summary result is still being checked. You can still browse the directory to read originals.',
  // The optional paid action on a history row (MemorySyncPanel HistoryRow; '取消' is shared)
  '重新提炼（付费）': 'Re-extract (paid)',
  '重新提炼会再上传这一段（{messages} 条消息，{characters} 字），并再付一次提炼费用。': 'Re-extracting uploads this part again ({messages} {messages|message|messages}, {characters} characters) and pays for extraction once more.',
  '确认重新提炼': 'Confirm re-extract',
  // Terminal permission naming matches the permissions dialog (TerminalTab, PermissionsDialog)
  '终端需要「读写并执行命令」权限': 'The terminal needs “Read, write and run commands”',
  '终端以当前用户身份在项目目录中运行命令。把项目的对话执行权限改为「读写并执行命令」后即可使用。': 'The terminal runs commands as your user in the project folder. Set the project’s conversation permission to “Read, write and run commands” to use it.',
  '项目已不能执行命令（权限不是「读写并执行命令」），终端已关闭。': 'The project can no longer run commands (its permission is not “Read, write and run commands”), so the terminal was closed.',
  '终端需要此权限': 'Needed by the terminal',
} as const satisfies Record<string, string>
