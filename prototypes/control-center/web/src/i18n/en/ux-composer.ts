/** UX audit 2026-10-03: strings added by the composer fixes. */
export default {
  // Not only after a model change: the host also rescales a turn auto-routed to a faster model (C2-a).
  ' · 按本会话模型的容量估算，下次请求后更新': " · estimated against this conversation's model; updates after the next request",
  '发送时单独成一条消息，带上这项后台任务的完整记录': "Sent as its own message, with this background task's full record",
  '子代理的结果': "A subagent's result",
  '已设为「读写并执行命令」：前台和后台都可直接读写和执行，不再逐项询问。': 'Set to “Read, write and run commands”: foreground and background work can read, write and run commands directly, without asking each time.',
} as const satisfies Record<string, string>
