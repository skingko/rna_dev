/** UX audit 2026-10-03: strings added by the agents fixes; 0.62.0: subagent delegation limits. */
export default {
  '最多 {depth} 层协作 · 每次 {steps} 步与 {finalSummarySteps} 次收束 · 每个对话同时 {concurrent} 个 · 每轮最多 {callsPerTurn} 次': 'Up to {depth} level of collaboration · {steps} steps and {finalSummarySteps} wrap-up each · {concurrent} at a time per conversation · up to {callsPerTurn} per turn',
  // The worker needs the project's write permission (not command execution), as the host checks.
  '子任务沿用父会话所选模型与额度，不自行扩展权限、安装工具或递归派生助手。实现类助手还要求父会话允许修改项目文件；停止父任务会取消子任务。': "Subtasks inherit the parent session's model and limits and never expand permissions, install tools or spawn helpers recursively. Implementation helpers also need the parent session to allow editing project files; stopping the parent task cancels its subtasks.",
  '最多 {depth} 层协作 · 每次 {steps} 步与 {finalSummarySteps} 次收束 · 每个对话同时 {concurrent} 个，所有对话合计 {concurrentTotal} 个 · 每轮最多 {callsPerTurn} 次': 'Up to {depth} level of collaboration · {steps} steps and {finalSummarySteps} wrap-up each · {concurrent} at a time per conversation, {concurrentTotal} across all conversations · up to {callsPerTurn} per turn',
} as const satisfies Record<string, string>
