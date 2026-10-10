/** Shared chrome: menus, appearance, settings navigation, generic actions. */
export default {
  界面语言: 'Language', 界面主题: 'Theme', 界面模式: 'Layout', 界面缩放: 'Zoom',
  系统默认: 'System default', 跟随系统: 'Match system', 浅色: 'Light', 深色: 'Dark',
  标准: 'Standard', 宽屏阅读: 'Wide reading', 使用统计: 'Usage', 设置: 'Settings',
  项目记忆: 'Project memory', 技能与工具: 'Skills & tools', 技能市场: 'Skill marketplace', 已归档: 'Archived',
  本地工作空间: 'Local workspace', 已连接: 'Connected', 连接中: 'Connecting', 已断开: 'Disconnected', 兼容模式: 'Compatibility mode',
  '本地 daemon · {status}': 'Local daemon · {status}', 界面与应用菜单: 'Interface and app menu',
  通用: 'General', 模型: 'Models', 记忆: 'Memory', 自主与节奏: 'Autonomy & rhythm', 判断: 'Judgment', 网页工具: 'Web tools', 系统进化: 'System evolution',
  应用与恢复: 'App & recovery', 关于: 'About', 关闭设置: 'Close settings', 应用设置: 'App settings', 当前项目: 'Current project',
  所有项目共用: 'Shared by all projects', 键盘快捷键: 'Keyboard shortcuts',
  关闭: 'Close', 取消: 'Cancel', 保存: 'Save', 保存中: 'Saving', '保存中…': 'Saving…', 已保存: 'Saved', 重试: 'Retry', 刷新: 'Refresh', 确认: 'Confirm', 删除: 'Delete', '删除…': 'Delete…',
  恢复: 'Restore', 返回: 'Back', 打开: 'Open', 查看: 'View', 编辑: 'Edit', 复制: 'Copy', 已复制: 'Copied', 更多: 'More', 显示更多: 'Show more', 收起: 'Collapse', 展开: 'Expand',
  加载中: 'Loading', '加载中…': 'Loading…', '正在加载…': 'Loading…', 暂无: 'None', 未知: 'Unknown', 未记录: 'Not recorded', 未选择: 'Not selected', 是: 'Yes', 否: 'No',
  已开启: 'On', 已关闭: 'Off', 开启: 'On', 关闭中: 'Closing', 项目: 'Project', 会话: 'Session', 项目不存在: 'Project not found', '项目不存在。': 'Project not found.',
  未命名会话: 'Untitled session', 未归属会话: 'Unassigned session', '正在保存，请稍候…': 'Saving, please wait…',
} as const satisfies Record<string, string>
