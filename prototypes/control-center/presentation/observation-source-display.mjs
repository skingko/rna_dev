// Shared, read-only projection. A source receipt is not a task result or a
// model instruction. The host remains authoritative for controls and status.
const text = (value, max = 320) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const states = { watching: '正在关注', initializing: '正在建立起点', paused: '已暂停', unavailable: '暂时不可用', incomplete: '部分范围未覆盖', root_changed: '目录位置已变化' };
const time = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : null; };
export function observationSourceDisplay(source = {}) {
  const status = states[source.status] ? source.status : 'unknown', paused = source.enabled === false || status === 'paused';
  return { id: text(source.id, 100), label: text(source.label, 80) || '项目目录变化', status: paused ? 'paused' : status,
    stateLabel: paused ? states.paused : states[status] || '等待状态更新', enabled: typeof source.enabled === 'boolean' ? source.enabled : null,
    summary: text(source.summary) || (paused ? '目录观察已暂停；已有对话和任务继续。' : status === 'watching' ? '目录发生变化时提供新证据，由 Agent 决定是否需要行动。' : status === 'initializing' ? '正在记录当前目录状态，不把已有文件当成新变化。' : '打开详情查看当前范围与状态。'),
    checkedAt: time(source.lastCheckedAt), eventAt: time(source.lastEventAt), pendingCount: count(source.pendingCount), errorCode: text(source.lastErrorCode, 100),
    limits: { maxFiles: count(source.limits?.maxFiles), maxEntries: count(source.limits?.maxEntries) },
    stats: { received: count(source.stats?.received), coalesced: count(source.stats?.coalesced), suppressedDuringExecution: count(source.stats?.suppressedDuringExecution) },
    recent: (Array.isArray(source.recent) ? source.recent : []).slice(-12).reverse().map(row => ({ at: time(row?.at), kind: text(row?.kind, 60), summary: text(row?.summary, 600) })) };
}
export function formatObservationSources(result = {}) {
  const sources = Array.isArray(result.sources) ? result.sources : [], projectId = /^[A-Za-z0-9-]+$/.test(result.projectId ?? '') ? result.projectId : '<项目ID>';
  if (!sources.length) return '暂无项目观察来源。打开项目目录后会自动连接。';
  return sources.map(source => { const d = observationSourceDisplay(source); return [`${d.label} · ${d.stateLabel} (${d.id})`, `  ${d.summary}`, d.eventAt ? `  最近变化 ${d.eventAt}` : '  尚未记录新变化', d.checkedAt ? `  最近检查 ${d.checkedAt}` : '', d.pendingCount ? `  待处理 ${d.pendingCount} 项` : '', `  查看详情：sources ${projectId} --json；暂停/恢复：source ${projectId} workspace pause|resume`].filter(Boolean).join('\n'); }).join('\n\n');
}
