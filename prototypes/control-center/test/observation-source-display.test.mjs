import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSourceDisplay, formatObservationSources } from '../presentation/observation-source-display.mjs';
import { observationSummary } from '../presentation/evolution-evidence-display.mjs';

test('source projection distinguishes actual collection states and does not infer task completion', () => {
  for (const [status, label] of [['watching','正在关注'],['initializing','正在建立起点'],['paused','已暂停'],['unavailable','暂时不可用'],['incomplete','部分范围未覆盖'],['root_changed','目录位置已变化']]) {
    const output = observationSourceDisplay({ id: 'workspace', status, enabled: status !== 'paused' });
    assert.equal(output.stateLabel, label); assert.doesNotMatch(output.summary, /任务已完成|全部已验证/);
  }
  assert.equal(observationSourceDisplay({ status: 'future_status' }).stateLabel, '等待状态更新');
  assert.equal(observationSourceDisplay({ status: 'watching', enabled: false }).stateLabel, '已暂停');
  assert.equal(observationSourceDisplay({}).enabled, null);
});
test('source display bounds metadata and preserves unknown counts rather than manufacturing zero', () => {
  const output = observationSourceDisplay({ label: 'name\x1b\x9b', summary: 'a'.repeat(1000), pendingCount: -1, lastCheckedAt: 'bad', stats: { received: 0, coalesced: Infinity }, limits: { maxFiles: 10 }, recent: Array.from({length:50}, (_, n) => ({ summary: `row-${n}` })) });
  assert.equal(output.label, 'name'); assert.equal(output.summary.length, 320); assert.equal(output.pendingCount, null); assert.equal(output.checkedAt, null);
  assert.equal(output.stats.received, 0); assert.equal(output.stats.coalesced, null); assert.equal(output.limits.maxEntries, null); assert.equal(output.recent.length, 12); assert.equal(output.recent[0].summary, 'row-49');
});
test('CLI summary and directory observations remain concise and separate evidence from actions', () => {
  assert.match(formatObservationSources({}), /暂无项目观察来源/);
  const output = formatObservationSources({ sources: [{ id: 'workspace', enabled: true, status: 'watching', summary: 'some\x1b\x9b evidence', recent: [{ summary: 'hidden detailed receipt' }] }] });
  assert.match(output, /正在关注/); assert.doesNotMatch(output.replaceAll('\n', ''), /hidden detailed receipt|[\x00-\x1f\x7f-\x9f]/u);
  assert.equal(observationSummary({kind:'workspace_change', text:'项目目录有 2 项变化。'}).label, '目录变化');
  assert.equal(observationSummary({kind:'note', text:'hello'}).label, '项目观察');
});
