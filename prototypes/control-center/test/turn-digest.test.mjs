import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnDigest, digestCurrent, digestStep, formatTurnDigest, turnDigestOf, turnSteps, turnWrittenPaths, DIGEST_HEAD_STEPS, DIGEST_TAIL_STEPS } from '../turn-digest.mjs';

// B5 (align 2026-10-05 §2.3 #1): the one turn digest the mind, the gene lanes and lesson.applied read. mu
// kyrn-judge memory/phrasing.ts:51-77 (request, first 6 and last 14 steps as `kind target -> ok/error`, the ending),
// plus the paths the turn wrote. Synthetic records only.

const tool = (turnId, name, args, status = 'succeeded', extra = {}) => ({ id: `t-${Math.random()}`, turnId, kind: 'tool', tool: { name, args, status, ...extra } });
function fixture({ steps = 0, written = [], status = 'completed', reply = '第三章写好了，已保存。' } = {}) {
  const turn = { id: 'turn-1', status, userItemId: 'u1', completedAt: '2026-10-05T01:00:00.000Z' };
  const items = [{ id: 'u1', turnId: 'turn-1', kind: 'user', text: '把第三章写完，  保存到 chapters/03.md' }];
  for (let index = 0; index < steps; index++) items.push(tool('turn-1', 'project_read', { path: `notes/${index}.md` }));
  for (const path of written) items.push(tool('turn-1', 'project_write', { path, content: 'x' }));
  items.push({ id: 'a1', turnId: 'turn-1', kind: 'assistant', text: 'draft', final: false }, { id: 'a2', turnId: 'turn-1', kind: 'assistant', text: reply, final: true });
  items.push({ id: 'other', turnId: 'turn-0', kind: 'tool', tool: { name: 'project_write', args: { path: 'not-this-turn.md' }, status: 'succeeded' } });
  return { session: { id: 's1', items, turns: [turn] }, turn };
}

test('a step reads `kind target -> ok|error`; tools without a telling kind go by their name', () => {
  assert.equal(digestStep({ name: 'project_exec', args: { command: 'npm test' }, status: 'failed' }), 'command npm test -> error');
  assert.equal(digestStep({ name: 'project_edit', kind: 'edit', target: 'src/a.js', status: 'succeeded' }), 'edit src/a.js -> ok');
  assert.equal(digestStep({ name: 'project_plan', args: {}, status: 'succeeded' }), 'project_plan -> ok');
  assert.equal(digestStep({ name: 'gen_42_guard_stiff', args: { path: 'c/1.md' }, status: 'uncertain' }), 'gen_42_guard_stiff c/1.md -> uncertain');
});

test('the digest keeps the request, the first 6 and the last 14 steps with the count between, the written paths and the end of the reply', () => {
  const { session, turn } = fixture({ steps: 30, written: ['chapters/03.md'] });
  const steps = turnSteps(session, turn);
  assert.equal(steps.length, 31, 'only this turn\'s steps');
  const digest = buildTurnDigest(session, turn, { now: Date.parse('2026-10-05T01:00:01Z') });
  assert.equal(digest.request, '把第三章写完， 保存到 chapters/03.md');
  assert.equal(digest.steps.length, DIGEST_HEAD_STEPS + DIGEST_TAIL_STEPS); assert.equal(digest.skipped, 31 - 20);
  assert.equal(digest.steps[0], 'read notes/0.md -> ok'); assert.equal(digest.steps.at(-1), 'write chapters/03.md -> ok');
  assert.deepEqual(digest.written, ['chapters/03.md']); assert.equal(digest.writtenTotal, 1);
  assert.equal(digest.reply, '第三章写好了，已保存。', 'the final reply, not an earlier draft');
  assert.equal(digest.paths, 'record');
  const text = formatTurnDigest(digest).split('\n');
  assert.equal(text[0], 'user: 把第三章写完， 保存到 chapters/03.md');
  assert.equal(text[DIGEST_HEAD_STEPS + 1], '(11 more steps)');
  assert.equal(text.at(-2), 'wrote: chapters/03.md'); assert.equal(text.at(-1), 'assistant: 第三章写好了，已保存。');
  // The tail of a long reply (where a turn reports what it did), not its head.
  const long = fixture({ reply: `${'开头'.repeat(600)}结尾：全部完成` });
  assert.match(buildTurnDigest(long.session, long.turn).reply, /^….*结尾：全部完成$/);
});

test('written paths come from the write steps that succeeded, media receipts, the turn\'s project applies and its checkpoint', () => {
  const { session, turn } = fixture({ written: ['a.md'] });
  session.items.push(tool('turn-1', 'project_edit', { path: 'b.md', edits: [] }), tool('turn-1', 'project_write', { path: 'failed.md' }, 'failed'), tool('turn-1', 'image_generate', { prompt: 'x' }, 'succeeded', { files: [{ path: 'assets/cover.png' }] }));
  const project = { git: { applies: [
    { id: 'ap1', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 'turn-1' }, sample: ['c.md', 'a.md'] },
    { id: 'ap2', kind: 'turn', target: 'session:s1', source: { sessionId: 's1', turnId: 'turn-1' }, sample: ['synced-in.md'] },
    { id: 'ap3', kind: 'worker', target: 'project', source: { sessionId: 's1', turnId: 'turn-1', agentId: 'w' }, sample: ['w.md'] },
    { id: 'ap4', kind: 'turn', target: 'project', source: { sessionId: 's1', turnId: 'turn-9' }, sample: ['other.md'] }] } };
  assert.deepEqual(turnWrittenPaths(session, turn, { project, checkpoint: ['chapters/03.md', 'a.md'] }), ['a.md', 'b.md', 'assets/cover.png', 'c.md', 'w.md', 'chapters/03.md']);
  const digest = buildTurnDigest(session, turn, { project, checkpoint: ['chapters/03.md'] });
  assert.equal(digest.paths, 'checkpoint'); assert.equal(digest.applies, 2);
  // At most 20 paths are kept, with the count of all of them.
  const many = buildTurnDigest(session, turn, { checkpoint: Array.from({ length: 30 }, (_, index) => `p${index}.md`) });
  assert.equal(many.written.length, 20); assert.equal(many.writtenTotal, 33);
  assert.match(formatTurnDigest(many), /\(\+13 more\)/);
});

test('a stored digest is current for the same end of the turn; a retry, a later checkpoint or a later apply needs it built again', () => {
  const { session, turn } = fixture({ written: ['a.md'] });
  const stored = buildTurnDigest(session, turn);
  assert.equal(digestCurrent(stored, turn), true);
  assert.equal(turnDigestOf(session, { ...turn, digest: stored }), stored);
  assert.equal(digestCurrent(stored, { ...turn, completedAt: '2026-10-05T02:00:00.000Z' }), false, 'a retry ended it again');
  assert.equal(digestCurrent(stored, { ...turn, status: 'failed' }), false);
  const checkpointed = { ...turn, checkpoint: { state: 'taken', endedAt: '2026-10-05T01:00:02.000Z' } };
  assert.equal(digestCurrent(stored, checkpointed), false, 'the checkpoint now holds this end: its paths are wanted');
  const withPaths = buildTurnDigest(session, checkpointed, { checkpoint: ['x.md'] });
  assert.equal(digestCurrent(withPaths, checkpointed), true);
  const project = { git: { applies: [{ kind: 'turn', target: 'project', source: { turnId: 'turn-1' }, sample: ['late.md'] }] } };
  assert.equal(digestCurrent(stored, turn, project), false, 'a worktree apply written after the turn ended');
  assert.notEqual(turnDigestOf(session, { ...turn, digest: { ...stored, version: 0 } }), stored, 'an older version is rebuilt');
  // A failed turn says so.
  const failed = fixture({ status: 'failed', reply: '' });
  assert.match(formatTurnDigest(buildTurnDigest(failed.session, failed.turn)), /\nended: failed\nassistant: /);
});
