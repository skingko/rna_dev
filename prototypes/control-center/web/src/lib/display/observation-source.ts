import { t, localized, intlTag } from '@/i18n'
/**
 * Observation source (workspace watcher) receipt projection.
 * Ported from the legacy `public/observation-source-display.js` (behavior unchanged). Inputs are raw
 * host records, so they are loosely typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>
export interface ObservationSourceDisplay {
  id: string; label: string; status: string; stateLabel: string; enabled: boolean | null; summary: string
  checkedAt: string | null; eventAt: string | null; pendingCount: number | null; errorCode: string
  limits: { maxFiles: number | null; maxEntries: number | null }
  stats: { received: number | null; coalesced: number | null; suppressedDuringExecution: number | null }
  recent: { at: string | null; kind: string; summary: string }[]
}
// Shared, read-only projection. A source receipt is not a task result or a
// model instruction. The host remains authoritative for controls and status.
const text = (value: any, max = 320): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : '';
const count = (value: any): number | null => Number.isSafeInteger(value) && value >= 0 ? value : null;
const states: Record<string, string> = localized({ watching: '正在关注', initializing: '正在建立起点', paused: '已暂停', unavailable: '暂时不可用', incomplete: '部分范围未覆盖', root_changed: '目录位置已变化' });
const time = (value: any): string | null => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString(intlTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : null; };
export function observationSourceDisplay(source: Rec = {}): ObservationSourceDisplay {
  const status = states[source.status] ? source.status : 'unknown', paused = source.enabled === false || status === 'paused';
  return { id: text(source.id, 100), label: text(source.label, 80) || t('项目目录变化'), status: paused ? 'paused' : status,
    stateLabel: paused ? states.paused : states[status] || t('等待状态更新'), enabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    summary: text(source.summary) || (paused ? t('目录观察已暂停；已有对话和任务继续。') : status === 'watching' ? t('目录发生变化时提供新证据，由 Agent 决定是否需要行动。') : status === 'initializing' ? t('正在记录当前目录状态，不把已有文件当成新变化。') : t('打开详情查看当前范围与状态。')),
    checkedAt: time(source.lastCheckedAt), eventAt: time(source.lastEventAt), pendingCount: count(source.pendingCount), errorCode: text(source.lastErrorCode, 100),
    limits: { maxFiles: count(source.limits?.maxFiles), maxEntries: count(source.limits?.maxEntries) },
    stats: { received: count(source.stats?.received), coalesced: count(source.stats?.coalesced), suppressedDuringExecution: count(source.stats?.suppressedDuringExecution) },
    recent: (Array.isArray(source.recent) ? source.recent : []).slice(-12).reverse().map((row: any) => ({ at: time(row?.at), kind: text(row?.kind, 60), summary: text(row?.summary, 600) })) };
}
