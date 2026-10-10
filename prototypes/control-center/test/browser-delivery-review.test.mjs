import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDeliveryReview } from '../browser-delivery-review.mjs';

const browser = 'mcp__browser__browser_snapshot';
function input(path = 'index.html', extra = [], continuations = 0) {
  return { continuations, snapshot: { messages: [
    { role: 'user', content: [{ type: 'text', text: 'Build interface' }] },
    { role: 'assistant', id: 'a', content: [{ type: 'toolCall', id: 'w', name: 'project_write', arguments: { path } }] },
    { role: 'toolResult', assistantId: 'a', toolCallId: 'w', toolName: 'project_write', content: [] },
    { role: 'toolResult', toolName: 'project_exec', content: [{ type: 'text', text: 'syntax passed' }] }, ...extra,
  ] } };
}
test('frontend syntax success still receives one factual browser observation when assigned', () => {
  const result = browserDeliveryReview(input(), [browser]);
  assert.equal(result.feedback.length, 1); assert.equal(result.feedback[0].source, 'host-browser-delivery-observation');
  assert.match(result.feedback[0].text, /not visual acceptance/);
  assert.equal(browserDeliveryReview(input('index.html', [], 1), [browser]), undefined);
});
test('successful actual observation ends the reminder without claiming quality; navigation or errors do not', () => {
  assert.equal(browserDeliveryReview(input('index.html', [{ role: 'toolResult', toolName: browser }]), [browser]), undefined);
  assert.ok(browserDeliveryReview(input('style.css', [{ role: 'toolResult', toolName: browser, isError: true }]), [browser]));
  assert.ok(browserDeliveryReview(input('app.tsx', [{ role: 'toolResult', toolName: 'mcp__browser__browser_navigate' }]), [browser]));
});
test('unassigned browser, backend edits, previous turns and old observations are not invented evidence', () => {
  assert.equal(browserDeliveryReview(input(), []), undefined);
  assert.equal(browserDeliveryReview(input('server.mjs'), [browser]), undefined);
  const next = input(); next.snapshot.messages.push({ role: 'user', content: [{ type: 'text', text: 'Just explain it' }] });
  assert.equal(browserDeliveryReview(next, [browser]), undefined);
  const old = input(); old.snapshot.messages.unshift({ role: 'toolResult', toolName: browser });
  assert.ok(browserDeliveryReview(old, [browser]));
});
