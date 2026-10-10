import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversationContext } from '../project-conversation-context.mjs';

const question = (id = 'focus', text = 'Which part comes first?') => ({ id, question: text, options: [{ id: 'visual', label: 'Visual design' }, { id: 'behavior', label: 'Working behavior' }], allowCustom: true });
function card(id, { status = 'answered', questions = [question()], custom = 'Keep the current content.', source = 'initiative', ...rest } = {}) {
  return { id: `item-${id}`, kind: 'question', source: 'interaction', interaction: { kind: 'question', id, source, status, canRespond: ['pending', 'interrupted'].includes(status), actionId: `action-${id}`, createdAt: '2026-09-25T07:00:00Z', questions, answers: questions.map(q => ({ id: q.id, selected: ['visual'], custom })), ...rest } };
}
const answer = id => ({ id: `answer-${id}`, kind: 'user', source: 'interaction-answer', interactionId: id, text: 'Do not use this flattened copy to lose the actual answer.', createdAt: '2026-09-25T07:01:00Z' });
const finding = id => ({ id, kind: 'assistant', source: 'initiative', initiativeActionId: `action-${id}`, text: `Observed ${id}`, evidenceIds: ['evidence'], createdAt: '2026-09-25T07:00:00Z' });
const session = items => ({ id: 'session', projectId: 'project', items });

test('no actual delivered handoff returns null; a bounded finding is plainly model-authored', () => {
  assert.equal(projectConversationContext(undefined), null);
  assert.equal(projectConversationContext(session([{ kind: 'assistant', text: 'ordinary model reply' }])), null);
  const long = { ...finding('one'), text: 'x'.repeat(2100) };
  const projection = projectConversationContext(session([long]));
  assert.equal(projection.messages[0].kind, 'collaborator_finding'); assert.equal(projection.messages[0].text.length, 2000); assert.equal(projection.messages[0].truncated, true);
  assert.deepEqual(projection.pendingQuestions, []);
});

test('three legal 2000-character questions never consume the budget of their full 4000-character user answers', () => {
  const tail = 'MUST PRESERVE THIS FINAL USER CONSTRAINT';
  const custom = 'x'.repeat(4000 - tail.length) + tail;
  const questions = [0, 1, 2].map(n => question(`question-${n}`, 'q'.repeat(2000)));
  const input = session([card('long', { questions, custom }), answer('long')]);
  const before = structuredClone(input), projection = projectConversationContext(input);
  const record = projection.messages[0]; assert.equal(record.kind, 'user_answer'); assert.equal(record.status, 'answered'); assert.equal(record.permissionChangedByHost, false);
  assert.equal(record.questions.length, 3);
  for (const q of record.questions) {
    assert.equal(q.text.length, 600); assert.equal(q.textTruncated, true);
    assert.deepEqual(q.selected, [{ id: 'visual', label: 'Visual design' }]);
    assert.equal(q.custom, custom); assert.equal(q.customTruncated, false); assert.ok(q.custom.endsWith(tail));
  }
  assert.deepEqual(input, before, 'projection never mutates stored questions or answers');
  record.questions[0].selected[0].label = 'caller changed'; assert.deepEqual(input, before);
});

test('cancelled answers name the exact questions and convey neither choices nor authorization', () => {
  const projection = projectConversationContext(session([card('cancel', { status: 'cancelled', permissionChanged: true }), answer('cancel')]));
  const record = projection.messages[0]; assert.equal(record.status, 'cancelled'); assert.equal(record.interactionId, 'cancel');
  assert.equal(record.permissionChangedByHost, false); assert.equal(record.questions[0].text, 'Which part comes first?');
  assert.deepEqual(record.questions[0].selected, []); assert.equal(record.questions[0].custom, '');
});

test('pending initiative cards are context about an unanswered question, never user answers', () => {
  const projection = projectConversationContext(session([card('pending', { status: 'pending' }), answer('pending'), card('paused', { status: 'interrupted' }), card('inactive', { status: 'pending', canRespond: false })]));
  assert.deepEqual(projection.messages, []); assert.deepEqual(projection.pendingQuestions.map(row => row.status), ['pending', 'interrupted']);
  for (const row of projection.pendingQuestions) {
    assert.equal('answers' in row, false); assert.equal('selected' in row.questions[0], false); assert.equal('custom' in row.questions[0], false);
    assert.equal(row.questions[0].options[0].label, 'Visual design');
  }
});

test('deleted, revoked, simulated, foreign-project and tool questions cannot become initiative answers', () => {
  const input = session([
    { ...finding('deleted'), sourceDeleted: true }, { ...finding('revoked'), contextRevoked: true }, { ...finding('simulation'), simulated: true }, { ...finding('foreign'), projectId: 'other' },
    { ...card('hidden'), sourceDeleted: true }, answer('hidden'),
    card('revoked-answer'), { ...answer('revoked-answer'), contextRevoked: true },
    { ...card('foreign-question'), projectId: 'other' }, answer('foreign-question'),
    card('foreign-record', { projectId: 'other' }), answer('foreign-record'),
    card('deleted-record', { sourceDeleted: true }), answer('deleted-record'),
    card('revoked-record', { contextRevoked: true }), answer('revoked-record'),
    card('tool', { source: 'tool' }), answer('tool'),
    { ...card('simulated'), simulated: true }, answer('simulated'),
    card('valid'), answer('valid'), card('pending-revoked', { status: 'pending' })
  ]);
  input.items.at(-1).contextRevoked = true;
  const projection = projectConversationContext(input);
  assert.deepEqual(projection.messages.map(row => row.interactionId), ['valid']); assert.deepEqual(projection.pendingQuestions, []);
});

test('keep only the latest four delivered records and report omitted history', () => {
  const projection = projectConversationContext(session([finding('one'), card('answer'), answer('answer'), finding('two'), finding('three'), finding('four')]));
  assert.deepEqual(projection.messages.map(row => row.id), ['answer-answer', 'two', 'three', 'four']); assert.equal(projection.coverage.omittedMessages, 1);
});

test('worst-case JSON escaping removes old records instead of truncating the latest answer', () => {
  const custom = '\u0000'.repeat(3990) + 'constraint';
  assert.equal(custom.length, 4000);
  const questions = [0, 1, 2].map(n => ({ id: `q-${n}`, question: '\u0000'.repeat(2000), multiSelect: true, options: Array.from({ length: 8 }, (_, index) => ({ id: `option-${index}`, label: '\u0000'.repeat(160) })) }));
  const items = [];
  for (let n = 0; n < 4; n++) {
    const row = card(`full-${n}`, { questions, custom }); row.interaction.answers.forEach(a => { a.selected = questions[0].options.map(option => option.id); });
    items.push(row, answer(`full-${n}`));
  }
  for (let n = 0; n < 4; n++) items.push(card(`pending-${n}`, { status: 'pending', questions }));
  const projection = projectConversationContext(session(items));
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= 220 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: JSON.stringify(projection) }), 'utf8') <= 220 * 1024, 'include the SDK attachment string escaping, leaving room for other named context');
  assert.ok(projection.coverage.omittedMessages > 0);
  const latest = projection.messages.find(row => row.interactionId === 'full-3'); assert.ok(latest);
  for (const q of latest.questions) { assert.equal(q.custom, custom); assert.equal(q.customTruncated, false); assert.equal(q.selected.length, 8); assert.equal(q.selected[7].label, questions[0].options[7].label); }
});

// TC-2 / MIND-6: each delivered message is its own complete, immutable window-scoped block (sent once while it is among
// the last four, again after a compaction), pending questions and the guide are separate; a withdrawn entry says so.
test('per-entry collaboration blocks, a separate pending block, the guide, and a withdrawn revision for a revoked entry', async () => {
  const { projectConversationUpdates, COLLABORATION_GUIDE_KEY, COLLABORATION_PENDING_KEY } = await import('../project-conversation-context.mjs');
  const { visibleContext, freshUpdates, collaborationUpdates } = await import('../host-context-updates.mjs');
  assert.equal(projectConversationUpdates(session([{ kind: 'assistant', text: 'ordinary model reply' }])), null);
  const items = [finding('f1'), finding('f2'), card('ask', { status: 'pending' })];
  const updates = projectConversationUpdates(session(items));
  assert.deepEqual(updates.map(row => [row.key, row.scope ?? 'conversation']), [[COLLABORATION_GUIDE_KEY, 'conversation'], ['project-collaboration:f1', 'window'], ['project-collaboration:f2', 'window'], [COLLABORATION_PENDING_KEY, 'conversation']]);
  assert.equal(JSON.parse(updates[1].text).text, 'Observed f1', 'the entry is the same per-entry projection as before');
  assert.equal(JSON.parse(updates[3].text).pendingQuestions[0].interactionId, 'ask');
  // What the conversation already holds is not offered again; a revoked entry gets one withdrawn revision.
  const messages = updates.map((row, index) => ({ id: `m${index}`, role: 'user', source: 'context', contextKey: row.key, ...(row.scope ? { contextScope: row.scope } : {}), context: [{ source: row.source, text: row.text }] }));
  const visible = visibleContext({ messages });
  assert.deepEqual(freshUpdates(collaborationUpdates(session(items), null, visible), visible), []);
  const revoked = [{ ...finding('f1'), contextRevoked: true }, finding('f2'), finding('f3'), card('ask', { status: 'pending' })];
  const next = freshUpdates(collaborationUpdates(session(revoked), null, visible), visible);
  assert.deepEqual(next.map(row => row.key), ['project-collaboration:f1', 'project-collaboration:f3']);
  assert.deepEqual(JSON.parse(next[0].text).withdrawn, true);
  // After a compaction the window entries are not restored: the latest four are offered again; the guide was restored.
  const compacted = visibleContext({ messages: [{ id: 'u0', role: 'user', source: 'user' }, ...messages], compaction: { throughMessageId: messages.at(-1).id } });
  assert.deepEqual(freshUpdates(collaborationUpdates(session(items), null, compacted), compacted).map(row => row.key), ['project-collaboration:f1', 'project-collaboration:f2']);
  // A conversation that holds the pre-0.66 single block gets its tombstone once.
  const legacy = visibleContext({ messages: [{ id: 'old', role: 'user', source: 'context', contextKey: 'project-collaboration', context: [{ source: 'delivered-project-messages', text: '{"messages":[]}' }] }] });
  assert.ok(collaborationUpdates(session(items), null, legacy).some(row => row.key === 'project-collaboration' && JSON.parse(row.text).moved));
});

/** What the SDK appends for an update (addContextUpdate): one keyed context message. */
const appended = (updates, from = 0) => updates.map((row, index) => ({ id: `m${from + index}`, role: 'user', source: 'context', contextKey: row.key, ...(row.scope ? { contextScope: row.scope } : {}), ...(row.accumulates ? { contextAccumulates: true } : {}), context: [{ source: row.source, text: row.text }] }));

// SCOPE-2: an entry that left the last four is still the model's latest copy of that message; when its projection
// changes (the user reverted the finding's background change) it gets a revision, or it would read as applied.
test('an older visible entry gets a revision when its projection changes, and none while it does not', async () => {
  const { visibleContext, freshUpdates, collaborationUpdates } = await import('../host-context-updates.mjs');
  const changed = { ...finding('f1'), initiative: { backgroundChange: 'change-1' } };
  const items = [changed, finding('f2'), finding('f3'), finding('f4')], project = { backgroundChanges: [{ id: 'change-1' }] };
  const messages = appended(collaborationUpdates(session(items), project, new Map()));
  // Four newer messages arrive: f1 leaves the window but stays visible.
  const later = [...items, finding('f5'), finding('f6'), finding('f7'), finding('f8')];
  let visible = visibleContext({ messages });
  const added = freshUpdates(collaborationUpdates(session(later), project, visible), visible);
  assert.deepEqual(added.map(row => row.key), ['project-collaboration:f5', 'project-collaboration:f6', 'project-collaboration:f7', 'project-collaboration:f8'], 'unchanged older entries are not sent again');
  visible = visibleContext({ messages: [...messages, ...appended(added, messages.length)] });
  const reverted = { backgroundChanges: [{ id: 'change-1', revertNote: 'The user reverted these background changes.' }] };
  const revision = freshUpdates(collaborationUpdates(session(later), reverted, visible), visible);
  assert.deepEqual(revision.map(row => [row.key, row.scope]), [['project-collaboration:f1', 'window']]);
  assert.equal(JSON.parse(revision[0].text).revertedByUser, 'The user reverted these background changes.');
  assert.equal(JSON.parse(revision[0].text).id, 'f1');
});

// MC-4 / MC-6: keys never reach the model, so a withdrawal names the id it withdraws; and when the hook payload is over
// its allowance, the oldest real entries go first — never a withdrawal (tiny, and the only thing that revokes a message).
test('a withdrawal names its message and is never what the byte bound drops', async () => {
  const { visibleContext, freshUpdates, collaborationUpdates, boundUpdates } = await import('../host-context-updates.mjs');
  const items = [finding('f1'), finding('f2')];
  const visible = visibleContext({ messages: appended(collaborationUpdates(session(items), null, new Map())) });
  const long = id => ({ ...finding(id), text: 'x'.repeat(1900) });
  const next = freshUpdates(collaborationUpdates(session([{ ...finding('f1'), sourceDeleted: true }, finding('f2'), long('f3'), long('f4'), long('f5')]), null, visible), visible);
  const withdrawal = next.find(row => row.key === 'project-collaboration:f1');
  assert.deepEqual(JSON.parse(withdrawal.text).id, 'f1'); assert.equal(JSON.parse(withdrawal.text).withdrawn, true);
  assert.match(JSON.parse(withdrawal.text).instruction, /with this id was withdrawn/);
  const bounded = boundUpdates(next, Buffer.byteLength(JSON.stringify(next), 'utf8') - 500);
  assert.ok(bounded.some(row => row.key === 'project-collaboration:f1'), 'the withdrawal stays');
  assert.ok(!bounded.some(row => row.key === 'project-collaboration:f3'), 'the oldest real entry was set aside instead');
  assert.ok(bounded.every(row => !('withdrawn' in row)), 'the marker never reaches the SDK');
});

// FOLD-1: the pre-0.66 block slid over the last four messages, so its copies are history the summary must keep: the
// tombstone declares the key accumulating (once more for a conversation whose tombstone predates the declaration).
test('the legacy collaboration tombstone declares the key accumulating', async () => {
  const { visibleContext, freshUpdates, collaborationUpdates } = await import('../host-context-updates.mjs');
  const old = { id: 'old', role: 'user', source: 'context', contextKey: 'project-collaboration', context: [{ source: 'delivered-project-messages', text: '{"messages":[]}' }] };
  const items = [finding('f1')], first = collaborationUpdates(session(items), null, visibleContext({ messages: [old] })).find(row => row.key === 'project-collaboration');
  assert.equal(first.accumulates, true);
  const declared = visibleContext({ messages: [old, ...appended([first], 1)] });
  assert.equal(freshUpdates(collaborationUpdates(session(items), null, declared), declared).some(row => row.key === 'project-collaboration'), false, 'sent once');
  const undeclared = visibleContext({ messages: [old, ...appended([{ ...first, accumulates: undefined }], 1)] });
  assert.equal(freshUpdates(collaborationUpdates(session(items), null, undeclared), undeclared).filter(row => row.key === 'project-collaboration' && row.accumulates).length, 1, 'a tombstone without the declaration gets it once');
});
