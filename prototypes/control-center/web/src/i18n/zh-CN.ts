/**
 * zh-CN is the source language: a key renders as itself. Add an override here
 * only when the displayed Chinese must differ from the key (e.g. a key that
 * carries an English-plural placeholder).
 */
import type { en } from './en'

export const zhCN: Partial<Record<keyof typeof en, string>> = {
  // Headings that are plural in English but read as the bare noun in Chinese.
  项目列表: '项目', 任务列表: '任务', 文件视图: '文件',
  // Short English placeholder; zh-CN keeps the original wording.
  '搜索会话、项目与任务…': '搜索会话、项目与任务',
}
