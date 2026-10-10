import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFailureMessage } from '../runtime-errors.mjs';

test('an unusable model response names its shape, so the next report says what came back', () => {
  // Live, 2026-10-02: ChatGPT Codex compaction failed as provider_failure with nothing else to go on.
  const text = runtimeFailureMessage({ errorDiagnostic: { category: 'provider_failure', retryable: false, purpose: 'compaction', responseShape: 'not_sse:text/html' } });
  assert.match(text, /^上下文压缩未完成，原始对话已保留。模型服务未返回完整、有效的响应/);
  assert.match(text, /（响应 not_sse:text\/html）$/);
  // Anything that is not a protocol token is dropped, never shown.
  assert.doesNotMatch(runtimeFailureMessage({ errorDiagnostic: { category: 'provider_failure', responseShape: 'not_sse:<b>hi</b>' } }), /响应 /);
});
