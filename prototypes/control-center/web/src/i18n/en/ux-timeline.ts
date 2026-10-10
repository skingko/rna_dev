/** UX audit 2026-10-03: strings added by the timeline fixes. */
export default {
  '已暂停 · {duration}': 'Paused · {duration}',
  // "Subagent", as the host writes its notices (builtin-agent-service); this entry supersedes sweep1's "Sub-agent".
  '子代理': 'Subagent',
  '子代理完成：{name} · {summary}': 'Subagent finished: {name} · {summary}',
  '子代理未完成：{name} · {summary}': 'Subagent did not finish: {name} · {summary}',
  '子代理已取消：{name} · {summary}': 'Subagent cancelled: {name} · {summary}',
  '子代理已中断：{name} · {summary}': 'Subagent interrupted: {name} · {summary}',
  // The SDK's role names (agent-delegation.mjs), in the host's English.
  '交付审阅': 'Reviewer',
  '实现协作': 'Worker',
  '已覆盖': 'Overwritten',
  '{length} 个文件': '{length} {length|file|files}',
  '覆盖了整个文件，之前的内容没有记录，所以没有差异可看。': 'The whole file was overwritten and its earlier content was not recorded, so there is no diff to show.',
  '未确认': 'Unconfirmed',
  '没能确认这一步是否生效，请核对结果': 'Couldn’t confirm whether this step took effect. Please check the result.',
  // B9: a conversation opens on its newest turns; older ones are read when the reader scrolls up to them.
  '加载更早的消息': 'Load earlier messages',
  '正在加载更早的消息…': 'Loading earlier messages…',
  '更早的消息加载失败：{message}': 'Couldn’t load earlier messages: {message}',
} as const satisfies Record<string, string>
