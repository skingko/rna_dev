/**
 * Memory browser presentation, ported line-for-line from
 * browser/memory-browser-display.js (the legacy UI's source of truth) plus the
 * error wording in public/settings-ui.js.
 */
import type { MemoryBrowseResponse, MemoryEntry } from '@/api/panels-types'
import { t, localized } from '@/i18n'

export interface MemoryPage { offset: number; entries: MemoryEntry[]; limit: number; nextOffset: number | null; previousOffset: number | null; directories: number; files: number; label: string }

export function memoryPageDisplay(response: MemoryBrowseResponse = {}, requestedOffset = 0, pageSize = 20): MemoryPage {
  const offset = Number.isSafeInteger(response.offset) && response.offset! >= 0 ? response.offset! : requestedOffset
  const entries = Array.isArray(response.entries) ? response.entries : []
  const limit = Number.isSafeInteger(response.limit) && response.limit! > 0 ? response.limit! : pageSize
  const nextOffset = response.hasMore === true && Number.isSafeInteger(response.nextOffset) && response.nextOffset! > offset && response.nextOffset! <= 10000 ? response.nextOffset! : null
  const directories = entries.filter(entry => entry.isDirectory === true).length, files = entries.length - directories
  const counts = response.view === 'recent' ? '' : t(' · 当前页 {directories} 个目录、{files} 个文件', { directories, files })
  return {
    offset, entries, limit, nextOffset, previousOffset: offset > 0 ? Math.max(0, offset - limit) : null, directories, files,
    label: entries.length
      ? t('第 {v}–{v2} {v3}{counts}{v4}', { v: offset + 1, v2: offset + entries.length, v3: response.view === 'recent' ? t('个文件') : t('项'), counts, v4: response.paginationLimited === true ? t(' · 已达浏览范围上限，请进入子目录继续') : nextOffset !== null ? t(' · 还有更多') : response.view === 'recent' ? t(' · 已到末页') : t(' · 本目录已到末页') })
      : offset ? t('此页暂无条目，可刷新查看') : response.view === 'recent' ? t('尚未发现可浏览的文件') : t('此目录暂无条目'),
  }
}

export function memoryCollectionDisplay(response: MemoryBrowseResponse = {}) {
  const c = response.collection
  if (!c) return null
  const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : t('未知'))
  const complete = c.complete === true, partial = !complete
  const reasons: Record<string, string> = { MEMORY_INDEX_TIMEOUT: t('扫描超时'), MEMORY_INDEX_DIRECTORY_UNAVAILABLE: t('部分目录读取失败'), MEMORY_INDEX_ENTRY_UNAVAILABLE: t('部分目录条目无法识别'), MEMORY_INDEX_SCAN_LIMIT: t('已达本次扫描上限') }
  const warnings = [...new Set((response.warnings ?? []).map(row => reasons[row.code ?? '']).filter(Boolean))]
  return {
    partial,
    title: t('{v}{v2} 个记忆文件 · {v3} 个项目资料文件', { v: partial ? t('已扫描范围内：') : '', v2: count(c.memoryFiles), v3: count(c.resourceFiles) }),
    detail: complete ? t('分布在 {v} 个目录中；目录不是记忆条数。文件可持续更新，归档不保证新增记忆。', { v: count(c.directories) }) : t('{v}，当前数量不是总数，排序仅覆盖已读取范围。可刷新重试或进入目录继续查看。', { v: warnings.length ? warnings.join(t('；')) : t('扫描未完整') }),
    checkedAt: typeof c.checkedAt === 'string' && Number.isFinite(Date.parse(c.checkedAt)) ? c.checkedAt : null,
  }
}

export function memoryEntryKind(entry: MemoryEntry) {
  if (entry.isDirectory) return t('目录')
  return entry.kind === 'memory' ? t('记忆文件') : entry.kind === 'resource' ? t('项目资料') : t('文件')
}

export interface ReadableDocument { text: string; raw: string; kind: 'document' | 'assistant-report'; truncated?: boolean; label?: string; description?: string }

export function memoryReadableDocument(content: unknown, entry: MemoryEntry = { uri: '' }): ReadableDocument {
  const raw = typeof content === 'string' ? content : ''
  const source = entry.provenance
  const marker = '## 原始来源的有界投影\n\n' // i18n-ignore: stored document text, never translated
  if (source?.kind !== 'autonomous_delivery' || source.role !== 'assistant' || !source.itemId || raw.length > 1000000 || !raw.startsWith('# 项目执行资料：助手主动交付\n')) return { text: raw, kind: 'document', raw }
  const offset = raw.indexOf(marker)
  if (offset < 0) return { text: raw, kind: 'document', raw }
  try {
    const value = JSON.parse(raw.slice(offset + marker.length)) as { kind?: string; itemId?: string; sourceRole?: string; text?: unknown; textTruncated?: boolean }
    if (value.kind !== 'autonomous_delivery' || value.itemId !== source.itemId || value.sourceRole !== 'assistant' || typeof value.text !== 'string' || !value.text.trim()) return { text: raw, kind: 'document', raw }
    return {
      text: value.text, raw, kind: 'assistant-report', truncated: value.textTruncated === true,
      label: value.textTruncated === true ? t('助手交付内容 · 归档节选') : t('助手交付内容'),
      description: t('来自助手已发送的报告；内容与执行回执保留各自来源。'),
    }
  } catch { return { text: raw, kind: 'document', raw } }
}

export function memoryDisplayTitle(entry: MemoryEntry) {
  if (typeof entry.displayTitle === 'string' && entry.displayTitle.trim()) return entry.displayTitle
  const title = String(entry.title ?? '')
  if (/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\.[a-z0-9]+)?$/i.test(title)) return `${entry.kind === 'memory' ? t('项目记忆') : t('项目资料')} · ${title.slice(0, 8)}`
  return title || t('项目记忆')
}

export function memoryError(error: unknown) {
  const e = error as { message?: string; code?: string } | null
  const message = String(e?.message ?? '')
  if (e?.code === 'MEMORY_LAYER_UNAVAILABLE' || /此目录尚无可读取的(?:摘要|概览)|no readable (?:summary|overview)/i.test(message)) return t('此目录暂时没有可读取的摘要或概览，内容可能尚未生成。可以浏览目录并查看相关原文。')
  if (/401|403/.test(message)) return t('无法验证记忆连接。请检查高级连接设置中的访问凭据。')
  if (/404/.test(message)) return t('记忆服务地址未找到。请检查高级连接设置中的服务地址。')
  if (/超时|timed out|timeout/i.test(message)) return t('记忆连接暂时没有响应，请稍后重试。')
  return t('暂时无法加载项目记忆，请重试或检查高级连接设置。')
}

export function relativeMemoryPath(uri: string, namespace: string) {
  if (uri === namespace) return t('全部记忆')
  if (uri.startsWith(`${namespace}/`)) return uri.slice(namespace.length + 1)
  if (/^viking:\/\/user\/[^/]+\/peers\/[^/]+\/memories(?:\/|$)/.test(uri)) return uri.replace(/^viking:\/\/user\/[^/]+\/peers\/[^/]+\/memories/, '对话记忆')
  return t('项目记忆条目')
}

export const MEMORY_LEVEL_NAMES: Record<string, string> = localized({ L0: '目录摘要', L1: '目录概览', L2: '原文' })

export const SUMMARY_STATUS_LABELS: Record<string, string> = localized({
  pending: '目录摘要待整理。仍可浏览目录查看原文。', submitting: '正在整理目录摘要。仍可浏览目录查看原文。', polling: '正在整理目录摘要。仍可浏览目录查看原文。',
  failed: '目录摘要整理未完成。仍可浏览目录查看原文。', uncertain: '目录摘要的整理结果还在核对。仍可浏览目录查看原文。',
})

/** The project's directory-summary upkeep as a plain note in the interface language, or null once it completed. None of
 * it is an alarm (A2): a failed summary is a settled gap that leaves the memories themselves intact, and an uncertain one
 * is checked automatically by a read-only look at the tree. The host's own `message` is Chinese only and is not shown. */
export function summaryStatusMessage(summary?: { status?: string } | null): string | null {
  return SUMMARY_STATUS_LABELS[summary?.status ?? ''] ?? null
}
