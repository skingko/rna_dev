/** 项目记忆 browser and memory sync status. */
export default {
  记忆同步有待核对项: 'Memory sync needs review', 记忆正在同步: 'Memory is syncing', 归档已同步: 'Archive in sync', 尚无同步记录: 'No sync records yet',
  '{n} 轮对话已归档': '{n} {n|turn|turns} archived',
  '对话记忆：{done} 轮归档完成，{inc} 次增量已同步，{pending} 段等待处理': 'Conversation memory: {done} {done|turn|turns} archived, {inc} incremental {inc|sync|syncs}, {pending} {pending|segment|segments} pending',
  '{n} 段已同步待整理': '{n} synced, awaiting consolidation',
  '{n} 段需要核对': '{n} need review',
  '自主交付与交互答复：{done} 项归档完成，服务回报抽取 {extracted} 条长期记忆；项目执行资料 {indexed} 项已索引、{pending} 项待索引。': 'Autonomous deliveries and answers: {done} archived; the service reported {extracted} long-term {extracted|memory|memories} extracted. Project execution material: {indexed} indexed, {pending} pending.',
  '，': ', ', '。': '.',
  '归档完成不等于产生新记忆。': 'Archiving does not mean new memories were produced.',
  需要核对: 'Needs review', 同步中: 'Syncing', 已同步: 'Synced', 无记录: 'No records',
  '记忆同步状态读取失败：{error}': 'Could not read memory sync status: {error}',
  '{n} 个会话': '{n} {n|session|sessions}',
  刷新同步状态: 'Refresh sync status', '项目摘要：{status}': 'Project summary: {status}', 各会话同步状态: 'Sync status by session',
  '{n} 轮归档': '{n} archived', '{n} 次增量': '{n} incremental', '{n} 段等待': '{n} pending', '{n} 段需核对': '{n} to review',
  '交付资料 {done}/{total}': 'Deliveries {done}/{total}', '最近同步 {time}': 'last synced {time}',
} as const satisfies Record<string, string>
