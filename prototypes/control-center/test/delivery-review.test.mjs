import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryReview } from '../delivery-review.mjs';

function sequence(path, isError = false) {
  return { continuations: 0, snapshot: { cwd: '/workspace', messages: [
    { role: 'user', content: [{ type: 'text', text: 'Implement index.html.' }] },
    { id: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'write', name: 'project_write', arguments: { path: 'index.html', content: '<!-- placeholder -->' } }] },
    { role: 'toolResult', toolName: 'project_write', assistantId: 'a', toolCallId: 'write', isError: false },
    { id: 'b', role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'project_read', arguments: { path } }] },
    { role: 'toolResult', toolName: 'project_read', assistantId: 'b', toolCallId: 'read', isError },
  ] } };
}

test('Reading unrelated instructions after a placeholder write cannot stand in for inspecting the delivered artifact', () => {
  const observation = deliveryReview(sequence('README.md'));
  const detail = JSON.parse(observation.feedback[0].text);
  assert.equal(detail.noInspectionAfterLastWrite, true);
  assert.deepEqual(detail.changedPaths, ['index.html']);
  assert.match(detail.evidenceBoundary, /does not judge/);
  assert.equal(deliveryReview({ ...sequence('README.md'), continuations: 1 }), undefined);
});

test('Read-back recognizes equivalent project paths, but failed reads remain unverified', () => {
  for (const path of ['index.html', './index.html', '/workspace/index.html']) assert.equal(deliveryReview(sequence(path)), undefined);
  assert.equal(JSON.parse(deliveryReview(sequence('index.html', true)).feedback[0].text).noInspectionAfterLastWrite, true);
});
