// @ts-nocheck -- fixtures deliberately use malformed, partial and historical record shapes.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { decisionEntryDisplay, decisionAssessmentDisplay } from './judgment'
import { catalogModelForDraft as catalogModel, modelInputDisplay as inputDisplay, sameModelProvider as sameProvider } from './model-catalog'
import { webToolsSettingsPayload, webToolsSettingsStatus } from './sections/WebToolsSection'
import { providerPresets } from '../../../../provider-presets.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Ported 1:1 from the host's legacy public/*.js display tests when the legacy UI was removed.
const catalogModelForDraft = catalogModel as (...args: any[]) => any
const modelInputDisplay = inputDisplay as (...args: any[]) => any
const sameModelProvider = sameProvider as (...args: any[]) => any

// ---- JEV entries (test/decision-settings-display.test.mjs)
{
test('auxiliary status describes an adopted routing judgement without claiming task or evolution completion', () => {
  const result = decisionEntryDisplay({ source: 'judge', reason: 'accepted', disposition: 'deferred', planRevision: 'main-plan-revision' });
  assert.equal(result.source, 'JEV 选项评分'); assert.equal(result.reason, '已采用选项评分'); assert.equal(result.disposition, '暂缓普通复查');
  assert.doesNotMatch(JSON.stringify(result), /任务已完成|评估通过|准确率/);
});
test('legacy accepted records cannot be relabeled as main-model authored option scores', () => {
  const result = decisionEntryDisplay({ source: 'judge', reason: 'accepted', policy: { yes: .99 } });
  assert.equal(result.source, 'JEV 历史记录'); assert.match(result.reason, /未保存主模型选项来源/); assert.doesNotMatch(result.reason, /已采用选项评分/);
});
test('auxiliary failures and shadow mode remain distinguishable from authoritative project decisions', () => {
  assert.equal(decisionEntryDisplay({ source: 'fallback', reason: 'timeout', disposition: 'main_review' }).disposition, '继续主模型复查');
  assert.match(decisionEntryDisplay({ source: 'fallback', reason: 'timeout' }).reason, /超时/);
  assert.match(decisionEntryDisplay({ source: 'fallback', reason: 'shadow' }).reason, /仅记录评分/);
  assert.match(decisionEntryDisplay({ source: 'rule', reason: 'duplicate_evidence' }).reason, /证据没有变化/);
});
test('boolean score is explicitly for the main model true option, never a completed task fact', () => {
  const shown = decisionAssessmentDisplay({ key: 'initiative_pause', title: '是否等待', type: 'boolean', optionLabel: '等待新的用户证据', probability: .92 });
  assert.equal(shown.title, '是否等待'); assert.equal(shown.label, '“是”选项：等待新的用户证据'); assert.equal(shown.value, '符合该选项的分值 0.92');
  assert.doesNotMatch(JSON.stringify(shown), /已暂停|已完成|准确率|预测/);
});
test('choice and satisfaction display only reported options and measured values', () => {
  assert.deepEqual(decisionAssessmentDisplay({ key: 'task_state', type: 'choice', optionLabel: '当前已有交付，等待反馈', score: .81 }), { title: '项目状态', label: '选中已有选项：当前已有交付，等待反馈', value: '选项分值 0.81' });
  assert.equal(decisionAssessmentDisplay({ key: 'user_satisfaction', type: 'score', score: 0 }).value, '评分 0 / 1');
  assert.equal(decisionAssessmentDisplay({ key: 'user_satisfaction', type: 'score', score: 1 }).value, '评分 1 / 1');
});
test('missing or invalid numerical scores are not fabricated from confidence or policy thresholds', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 1.1, '0.9']) assert.match(decisionAssessmentDisplay({ type: 'boolean', probability: value, confidence: .99 }).value, /未报告/);
  assert.match(decisionAssessmentDisplay({ type: 'choice', choice: 'finished' }).label, /未保留/);
  assert.equal(decisionAssessmentDisplay({ type: 'prediction', score: .9 }).value, '');
});
}

// ---- model capability (test/model-capability-display.test.mjs)
{
const presets = providerPresets();
const official = id => presets.find(row => row.id === id);
test('draft model capabilities follow verified catalogs and distinguish image, text and unknown IDs', () => {
  const provider = official('glm');
  assert.equal(modelInputDisplay({ provider, modelId: 'glm-5.3-flash', presets }).label, '文字与图片');
  assert.equal(modelInputDisplay({ provider, modelId: 'glm-5.3', presets }).label, '仅文字');
  const unknown = modelInputDisplay({ provider, modelId: 'glm-5.3-vision-custom', presets });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.url, null);
});
test('model ID, route and protocol edits cannot retain another model or provider capability', () => {
  const provider = { protocol: 'openai', baseUrl: 'https://proxy.example/v1', authMode: 'api_key', models: [{ id: 'custom', inputCapability: { status: 'known', source: 'provider', input: ['text', 'image'], sourceUrl: 'https://proxy.example/v1/models', checkedAt: '2026-09-27' } }] };
  const show = (changes = {}, modelId = 'custom') => modelInputDisplay({ provider: { ...provider, ...changes }, savedProvider: provider, modelId, presets });
  assert.equal(show().source, 'provider'); assert.equal(show().label, '文字与图片'); assert.equal(show().checkedAt, '2026-09-27');
  for (const changes of [{ baseUrl: 'https://another.example/v1' }, { protocol: 'anthropic' }, { authMode: 'subscription' }]) assert.equal(show(changes).status, 'unknown');
  assert.equal(show({}, 'renamed').status, 'unknown');
  assert.equal(show({ baseUrl: 'https://proxy.example/v1/' }).status, 'known');
});
test('old manually configured image flags remain unverified and never become image evidence', () => {
  const provider = { protocol: 'openai', baseUrl: 'https://proxy.example/v1', models: [{ id: 'custom', input: ['text', 'image'], inputCapability: { status: 'unknown', source: 'configured', input: ['text', 'image'] } }] };
  const display = modelInputDisplay({ provider, savedProvider: provider, modelId: 'custom', presets });
  assert.equal(display.status, 'unknown'); assert.equal(display.source, 'configured'); assert.match(display.description, /保留已有配置/); assert.ok(!display.label.includes('图片'));
});
test('catalog matching accepts verified official aliases but not lookalike proxies or credential-bearing routes', () => {
  assert.ok(catalogModelForDraft({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1/' }, 'deepseek-flash', presets));
  assert.ok(catalogModelForDraft({ protocol: 'openai', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }, 'qwen3.8-max', presets));
  for (const baseUrl of ['https://api.deepseek.com.evil/v1', 'https://username:secret@api.deepseek.com/v1', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1?proxy=1']) assert.equal(catalogModelForDraft({ protocol: 'openai', baseUrl }, 'deepseek-flash', presets), undefined);
  assert.equal(sameModelProvider(official('glm'), { ...official('glm'), baseUrl: 'https://proxy.example/v1' }), false);
  assert.equal(sameModelProvider({ protocol: 'openai', baseUrl: 'https://api.deepseek.com' }, { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' }), false, 'Only catalog matching accepts the official alias; discovered custom models stay bound to their actual request route');
});
test('unsafe discovery source URLs do not become clickable links', () => {
  const provider = { protocol: 'openai', baseUrl: 'https://proxy.example/v1', models: [{ id: 'custom', inputCapability: { status: 'known', source: 'provider', input: ['text'], sourceUrl: 'javascript:alert(1)' } }] };
  const display = modelInputDisplay({ provider, savedProvider: provider, modelId: 'custom' });
  assert.equal(display.label, '仅文字'); assert.equal(display.url, null);
});
}

// ---- web tools settings (test/web-tools-configuration.test.mjs)
test('settings payload preserves blank credentials, omits typed keys for env auth, and status does not claim connectivity', () => {
  const values = { enabled: false, baseUrl: ' https://api.fastcrw.com/ ', timeoutSeconds: '30', apiKeyEnv: '', apiKey: '' };
  assert.deepEqual(webToolsSettingsPayload(values), { webTools: { enabled: false, baseUrl: 'https://api.fastcrw.com/', timeoutMs: 30000, apiKeyEnv: '' } });
  assert.equal(webToolsSettingsPayload({ ...values, apiKey: 'typed-key' }).webTools.apiKey, 'typed-key');
  assert.deepEqual(webToolsSettingsPayload({ ...values, apiKeyEnv: ' ENV_KEY ', apiKey: 'do-not-activate' }).webTools, { enabled: false, baseUrl: 'https://api.fastcrw.com/', timeoutMs: 30000, apiKeyEnv: 'ENV_KEY' });
  assert.match(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: true }), /所有项目与会话共用/);
  assert.match(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: false }), /尚未配置/);
  assert.match(webToolsSettingsStatus({ enabled: false, apiKeyConfigured: true }), /已关闭/);
  assert.doesNotMatch(webToolsSettingsStatus({ enabled: true, apiKeyConfigured: true }), /连接正常|检查通过/);
});
