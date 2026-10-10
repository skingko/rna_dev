import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWorkspaceEvents, workspaceEvents, turnReversion, actionReversion, snapshotWorkspaceEvents, reversionsContextUpdate, deliveredReversions, undoingRecord, WORKSPACE_EVENT_KINDS, WORKSPACE_EVENTS_LIMIT, REVERSIONS_CONTEXT_KEY, REVERSIONS_SOURCE } from '../workspace-events.mjs';
import { prepareContext } from '../../../packages/sdk/src/context.mjs';

// "The user undid X" (rollback awareness): events derived from apply records and legacy revert rows, pure. Synthetic
// state only; no repository, no model.

const T0 = Date.parse('2026-10-04T05:00:00.000Z');
const at = minutes => new Date(T0 + minutes * 60000).toISOString();
const write = (id, kind, source, minutes, extra = {}) => ({ id, kind, target: 'project', source, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: [`${id}.txt`], at: at(minutes), ...extra });
const undo = (id, minutes, extra = {}) => ({ id, kind: 'rollback', target: 'project', source: {}, state: 'verified', files: 1, added: 0, removed: 0, bothChanged: 0, sample: [`${id}.txt`], at: at(minutes), ...extra });

function world({ applies = [], backgroundChanges = [], directFixes = [], sessions } = {}) {
  const project = { id: 'p1', git: { applies }, backgroundChanges, directFixes };
  const state = { projects: [project], sessions: sessions ?? [
    { id: 's1', projectId: 'p1', turns: [{ id: 't1', completedAt: at(1) }, { id: 't2', completedAt: at(2), delegations: [{ id: 'ag-dropped', merge: { status: 'dropped', applyIds: ['w1'] } }, { id: 'ag-kept', merge: { status: 'merged', applyIds: ['w2'] } }] }, { id: 't3', completedAt: at(3) }], items: [] },
    { id: 's2', projectId: 'p1', turns: [{ id: 'u1', completedAt: at(1) }], items: [] },
    { id: 's-old', projectId: 'p1', archivedAt: at(0), turns: [{ id: 'z1', completedAt: at(1) }], items: [] }] };
  return { state, project };
}

test('each kind of undo is derived from its record, with its owner, paths and newest first', () => {
  const { state, project } = world({ applies: [
    write('t1rec', 'turn', { sessionId: 's1', turnId: 't1', worktreeId: 'wt-s1' }, 1),
    undo('k1', 10, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user', sample: ['src/calc.js'] }),
    write('w1', 'worker', { sessionId: 's1', turnId: 't2', agentId: 'ag-dropped' }, 2, { state: 'rolled_back', rolledBackBy: 'k2' }),
    undo('k2', 11, { source: { sessionId: 's1', turnId: 't2', agentId: 'ag-dropped' }, undoes: 'w1', initiator: 'user' }),
    write('w2', 'worker', { sessionId: 's1', turnId: 't2', agentId: 'ag-kept' }, 2, { state: 'rolled_back', rolledBackBy: 'k3' }),
    undo('k3', 12, { source: { sessionId: 's1', turnId: 't2', agentId: 'ag-kept' }, undoes: 'w2', initiator: 'user' }),
    // A single-record background revert written before rollbacks kept the whole source (live: source {}): the chain names the run.
    write('b1', 'background', { actionId: 'act-1', worktreeId: 'bg-1' }, 3, { state: 'rolled_back', rolledBackBy: 'k4' }),
    undo('k4', 13, { undoes: 'b1' }),
    // A multi-record revert names no `undoes`; the records it settled do.
    write('b2', 'background', { actionId: 'act-2', worktreeId: 'bg-2' }, 3, { state: 'rolled_back', rolledBackBy: 'k5' }),
    write('b3', 'resolve', { actionId: 'act-2', worktreeId: 'bg-2' }, 3, { state: 'rolled_back', rolledBackBy: 'k5' }),
    undo('k5', 14, { source: { actionId: 'act-2' }, initiator: 'user' }),
    { id: 'd1', kind: 'user_discard', target: 'project', source: {}, state: 'verified', files: 2, sample: ['notes.md', 'draft.md'], at: at(15) },
    // An interrupted apply's "go back to before" (its card's answer).
    write('i1', 'turn', { sessionId: 's2', turnId: 'u1' }, 4, { state: 'rolled_back', rolledBackBy: 'r1' }),
    { ...write('r1', 'resolve', { sessionId: 's2', turnId: 'u1' }, 16), undoes: 'i1', initiator: 'user' },
  ] });
  const events = deriveWorkspaceEvents(state, project);
  assert.deepEqual(events.map(row => [row.id, row.kind]), [['r1', 'record_rolled_back'], ['d1', 'discarded'], ['k5', 'background_reverted'], ['k4', 'background_reverted'], ['k3', 'record_rolled_back'], ['k2', 'worker_dropped'], ['k1', 'turn_rolled_back']]);
  const by = id => events.find(row => row.id === id);
  assert.deepEqual(by('k1').owner, { sessionId: 's1', turnId: 't1' });
  assert.deepEqual(by('k1').paths, ['src/calc.js']); assert.equal(by('k1').target, 'project_folder');
  assert.deepEqual(by('k2').owner, { sessionId: 's1', turnId: 't2', agentId: 'ag-dropped' });
  assert.deepEqual(by('k4').owner, { actionId: 'act-1' }, 'the background run is found through undoes');
  assert.deepEqual(by('k5').owner, { actionId: 'act-2' });
  assert.deepEqual(by('d1').owner, {}); assert.equal(by('d1').files, 2);
  assert.deepEqual(by('r1').owner, { sessionId: 's2', turnId: 'u1' });
  assert.ok(events.every(row => WORKSPACE_EVENT_KINDS.includes(row.kind)));
});

test('an undo of an undo is rollback_undone with the original owner, and the first undo says it was reversed', () => {
  const { state, project } = world({ applies: [
    write('t1rec', 'turn', { sessionId: 's1', turnId: 't1' }, 1),
    undo('k1', 10, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user', state: 'rolled_back', rolledBackBy: 'k2' }),
    // The undo kept the source of what it undid (a rollback); the chain still leads to the turn.
    undo('k2', 11, { source: { sessionId: 's1', turnId: 't1' }, undoes: 'k1', initiator: 'user' }),
    // An undo of the panel's discard brings the user's own edits back.
    { id: 'd1', kind: 'user_discard', target: 'project', source: {}, state: 'rolled_back', rolledBackBy: 'k3', files: 1, sample: ['notes.md'], at: at(12) },
    undo('k3', 13, { undoes: 'd1', initiator: 'user' }),
  ] });
  const events = deriveWorkspaceEvents(state, project), by = id => events.find(row => row.id === id);
  // The predicate readers labelling apply records share (an undo of these brings their changes back).
  assert.deepEqual(project.git.applies.map(row => [row.id, undoingRecord(row)]), [['t1rec', false], ['k1', true], ['k2', true], ['d1', true], ['k3', true]]);
  assert.equal(undoingRecord({ kind: 'resolve', undoes: 'x' }), true); assert.equal(undoingRecord({ kind: 'resolve' }), false);
  assert.equal(by('k2').kind, 'rollback_undone'); assert.equal(by('k2').undoes, 'k1'); assert.deepEqual(by('k2').owner, { sessionId: 's1', turnId: 't1' });
  assert.equal(by('k1').undoneLater, true); assert.equal(by('k2').undoneLater, undefined);
  assert.equal(by('k3').kind, 'rollback_undone'); assert.equal(by('k3').undoes, 'd1'); assert.equal(by('d1').undoneLater, true);
  // The turn's undo is no longer in effect: no annotation.
  assert.equal(turnReversion(events, 's1', 't1'), null);
});

test('a partial rollback says so and lists what it skipped; only the user\'s settled undos count', () => {
  const { state, project } = world({ applies: [
    write('w2', 'worker', { sessionId: 's1', turnId: 't3' }, 1),
    undo('k1', 10, { source: { sessionId: 's1', turnId: 't3' }, undoes: 'w2', initiator: 'user', partial: true }),
    undo('k2', 11, { source: { sessionId: 's1', turnId: 't3' }, undoesTurn: 't3', initiator: 'user', skipped: [{ path: 'b.txt', reason: 'changed_after' }] }),
    // The model's own agent_merge drop, a host undo, an undo still being written: not the user's news.
    undo('k3', 12, { source: { sessionId: 's1', turnId: 't2', agentId: 'ag-dropped' }, undoes: 'w1', initiator: 'agent' }),
    undo('k4', 13, { undoes: 'w2', initiator: 'host' }),
    undo('k5', 14, { undoes: 'w2', initiator: 'user', state: 'writing' }),
    // A resolve that undid nothing is a write, not an undo.
    write('r1', 'resolve', { sessionId: 's1', turnId: 't3' }, 15),
  ] });
  const events = deriveWorkspaceEvents(state, project);
  assert.deepEqual(events.map(row => row.id), ['k2', 'k1']);
  assert.equal(events[1].partial, true); assert.equal(events[1].skipped, undefined);
  assert.equal(events[0].partial, true); assert.deepEqual(events[0].skipped, [{ path: 'b.txt', reason: 'changed_after' }]);
  assert.deepEqual(turnReversion(events, 's1', 't3'), { at: at(11), kind: 'turn_rolled_back', partial: true });
});

test('legacy background change sets and direct fixes marked reverted are background_reverted; git rows are their records\' business', () => {
  const { state, project } = world({
    backgroundChanges: [
      { id: 'c1', actionId: 'act-old', at: at(1), status: 'reverted', revertedAt: at(20), files: [{ path: 'a.md' }, { path: 'b.md' }], outcome: { restored: ['a.md'], conflicts: ['b.md'], failed: [] } },
      { id: 'c2', kind: 'git', actionId: 'act-git', at: at(1), status: 'reverted', revertedAt: at(21), applyIds: ['bx'], files: [{ path: 'x.md' }] },
      { id: 'c3', actionId: 'act-kept', at: at(1), status: 'kept', files: [{ path: 'k.md' }] }],
    directFixes: [
      { id: 'f1', actionId: 'act-fix', sessionId: 's1', at: at(2), status: 'reverted', settledAt: at(22), files: [{ path: 'fix.md' }], outcome: { restored: ['fix.md'], conflicts: [], failed: [] } },
      { id: 'f2', kind: 'git', actionId: 'act-gitfix', at: at(2), status: 'reverted', settledAt: at(23), files: [{ path: 'g.md' }] }],
  });
  const events = deriveWorkspaceEvents(state, project);
  assert.deepEqual(events.map(row => [row.id, row.kind]), [['fix:f1', 'background_reverted'], ['change:c1', 'background_reverted']]);
  assert.deepEqual(events[1], { id: 'change:c1', at: at(20), kind: 'background_reverted', owner: { actionId: 'act-old' }, target: 'project_folder', paths: ['a.md', 'b.md'], files: 2, partial: true, skipped: [{ path: 'b.md', reason: 'changed_after' }] });
  assert.deepEqual(actionReversion(events, 'act-old'), { at: at(20), partial: true });
  assert.deepEqual(actionReversion(events, 'act-fix'), { at: at(22) });
  assert.equal(actionReversion(events, 'act-kept'), null);
});

test('owners are filtered to live conversations, `since` cuts the window, and the bounded view keeps the newest', () => {
  const applies = [
    undo('k-gone', 10, { source: { sessionId: 's-deleted', turnId: 'x1' }, undoesTurn: 'x1', initiator: 'user' }),
    undo('k-archived', 11, { source: { sessionId: 's-old', turnId: 'z1' }, undoesTurn: 'z1', initiator: 'user' }),
    undo('k-early', 0.5, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user' }),
  ];
  for (let index = 0; index < 10; index++) applies.push(undo(`k${index}`, 30 + index, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user' }));
  const { state, project } = world({ applies });
  const all = deriveWorkspaceEvents(state, project);
  assert.deepEqual(all.find(row => row.id === 'k-gone').owner, {}, 'a deleted conversation\'s ids are dropped, the event stays');
  assert.deepEqual(all.find(row => row.id === 'k-archived').owner, {});
  assert.ok(!deriveWorkspaceEvents(state, project, { since: T0 + 60000 }).some(row => row.id === 'k-early'));
  const bounded = workspaceEvents(state, project);
  assert.equal(bounded.length, WORKSPACE_EVENTS_LIMIT); assert.equal(bounded[0].id, 'k9');
  const view = snapshotWorkspaceEvents(all);
  assert.equal(view.events.length, WORKSPACE_EVENTS_LIMIT); assert.equal(view.omitted, all.length - WORKSPACE_EVENTS_LIMIT);
  assert.deepEqual(Object.keys(view.events[0]).slice(0, 3), ['id', 'at', 'kind']); assert.equal(view.events[0].sessionId, 's1', 'owner fields are flat in the snapshot');
  assert.match(view.meaning, /do not re-apply/);
  assert.equal(snapshotWorkspaceEvents([]), null);
});

test('the foreground update carries this conversation\'s undos since the previous turn\'s window began, and project-folder undos only in the project folder', () => {
  const { state, project } = world({ applies: [
    undo('k-early', 1.5, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user' }),
    undo('k-before', 2.5, { source: { sessionId: 's1', turnId: 't2' }, undoesTurn: 't2', initiator: 'user' }),
    undo('k-mine', 10, { source: { sessionId: 's1', turnId: 't3' }, undoesTurn: 't3', initiator: 'user', sample: ['src/calc.js'] }),
    write('b1', 'background', { actionId: 'act-1' }, 4, { state: 'rolled_back', rolledBackBy: 'k-bg' }),
    undo('k-bg', 11, { source: { actionId: 'act-1' }, undoes: 'b1', initiator: 'user' }),
    undo('k-other', 12, { source: { sessionId: 's2', turnId: 'u1' }, undoesTurn: 'u1', initiator: 'user' }),
    // A worker dropped from this conversation's own copy (a worktree conversation): S, not the project folder.
    { ...undo('k-copy', 13, { source: { sessionId: 's1', turnId: 't3', agentId: 'ag-dropped' }, undoes: 'w-s', initiator: 'user' }), target: 'session:s1' },
  ] });
  state.sessions[0].turns.push({ id: 't4' });
  const update = reversionsContextUpdate(state, { sessionId: 's1', turnId: 't4' });
  assert.equal(update.key, REVERSIONS_CONTEXT_KEY); assert.equal(update.source, REVERSIONS_SOURCE);
  const payload = JSON.parse(update.text);
  assert.deepEqual(payload.reversions.map(row => [row.id, row.whose ?? null]), [['k-before', 'this_conversation'], ['k-mine', 'this_conversation'], ['k-bg', 'background_work'], ['k-other', 'another_conversation'], ['k-copy', 'this_conversation']], 'oldest first, since the turn before the previous one ended');
  assert.equal(payload.reversions[4].agentId, 'ag-dropped'); assert.equal(payload.reversions[4].target, 'conversation_copy');
  assert.equal(payload.reversions[0].turnId, undefined, 'turn ids mean nothing to the model');
  assert.match(payload.instruction, /current files|as they are now/); assert.match(payload.instruction, /do not re-apply/);
  // A worktree conversation: only its own undos.
  const own = JSON.parse(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't4', projectFolder: false }).text);
  assert.deepEqual(own.reversions.map(row => row.id), ['k-before', 'k-mine', 'k-copy']);
  // Byte-stable: the same records give the same text (the SDK skips an unchanged revision).
  assert.equal(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't4' }).text, update.text);
  // The conversation's first turn, an unknown turn, a session without a project: nothing to send. The second turn's
  // window opens when the first began (t1 here has no createdAt).
  assert.equal(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't1' }), null);
  assert.equal(reversionsContextUpdate(state, { sessionId: 's1', turnId: 'nope' }), null);
  assert.equal(reversionsContextUpdate({ sessions: [{ id: 's', items: [] }] }, { sessionId: 's', turnId: 't' }), null);
  state.sessions[0].turns[0].createdAt = at(0);
  assert.deepEqual(JSON.parse(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't2' }).text).reversions.map(row => row.id), ['k-early', 'k-before', 'k-mine', 'k-bg', 'k-other', 'k-copy']);
  // The window is empty again: nothing to send, or, once the key was sent, its constant settled value.
  state.sessions[0].turns.push({ id: 't5' }, { id: 't6' }); state.sessions[0].turns[3].completedAt = at(20);
  assert.equal(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't6' }), null);
  const settled = reversionsContextUpdate(state, { sessionId: 's1', turnId: 't6', delivered: deliveredReversions([sent(update)]) });
  assert.equal(settled.key, REVERSIONS_CONTEXT_KEY); assert.deepEqual(JSON.parse(settled.text).reversions, []); assert.match(JSON.parse(settled.text).instruction, /describe past undos, not new ones/);
  assert.equal(reversionsContextUpdate(state, { sessionId: 's1', turnId: 't6', delivered: new Set() }).text, settled.text, 'one constant text');
  // FOLD-1: every copy lists undos no later copy repeats, so the key accumulates — the notices stay unfolded and in
  // summary records after a later window or the settled value follows them.
  assert.equal(update.accumulates, true); assert.equal(settled.accumulates, true);
});

test('undo notices are a list: a later window or the settled value supersedes none of them (FOLD-1)', async () => {
  const { supersededContextIds, foldTargets } = await import('../../../packages/sdk/src/context.mjs');
  const { visibleContext, freshUpdates } = await import('../host-context-updates.mjs');
  const notice = (id, text) => ({ id, role: 'user', source: 'context', content: [{ type: 'text', text: 'context' }], context: [{ source: REVERSIONS_SOURCE, text }], contextKey: REVERSIONS_CONTEXT_KEY, contextAccumulates: true });
  const user = id => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: id }] });
  const messages = [user('u1'), notice('n1', '{"reversions":[{"id":"k1"}]}'), user('u2'), notice('n2', '{"reversions":[]}'), user('u3')];
  assert.equal(supersededContextIds(messages).size, 0, 'both notices stay in a summary record');
  assert.deepEqual(foldTargets(messages), [], 'neither folds as superseded');
  // A conversation whose latest notice predates the declaration gets the settled value once more, declared.
  const old = [user('u1'), { ...notice('n1', '{"reversions":[]}'), contextAccumulates: undefined }];
  const update = { key: REVERSIONS_CONTEXT_KEY, source: REVERSIONS_SOURCE, accumulates: true, text: '{"reversions":[]}' };
  assert.equal(freshUpdates([update], visibleContext({ messages: old })).length, 1);
  assert.equal(freshUpdates([update], visibleContext({ messages: [...old, notice('n2', update.text)] })).length, 0);
});

/** An update as the SDK journal keeps it (a context message under its key). */
const sent = (update, id = 'm') => ({ id, role: 'user', source: 'context', content: [{ type: 'text', text: 'context' }], context: [{ source: update.source, text: update.text }], contextKey: update.key });

test('an undo made while the previous turn was finishing reaches the next turn once, and a settled value replaces it for compaction', () => {
  const { state, project } = world({ applies: [] });
  const turns = state.sessions[0].turns, messages = [], request = turnId => reversionsContextUpdate(state, { sessionId: 's1', turnId, delivered: deliveredReversions(messages) });
  /** One provider request: the update appended as the SDK does (once per key + revision). */
  const send = turnId => { const update = request(turnId); const last = messages.findLast(row => row.contextKey === REVERSIONS_CONTEXT_KEY); if (update && last?.context[0].text !== update.text) messages.push(sent(update, `m${messages.length}`)); return update; };
  turns[0].createdAt = at(0); turns[1].completedAt = at(3);
  // t2's last request went out at 2.4: nothing undone yet.
  assert.equal(send('t2'), null);
  // The user rolls back while t2's final reply streams: after its last request (2.4), before it completed (3).
  project.git.applies.push(undo('k-gap', 2.6, { source: { sessionId: 's1', turnId: 't1' }, undoesTurn: 't1', initiator: 'user' }));
  assert.deepEqual(JSON.parse(send('t3').text).reversions.map(row => row.id), ['k-gap'], 't3 carries it although t2 completed after it');
  assert.equal(send('t3'), null, 't3\'s next request: nothing new');
  // An undo during t3: its next request carries the window with both, oldest first.
  project.git.applies.push(undo('k-t3', 4, { source: { sessionId: 's1', turnId: 't2' }, undoesTurn: 't2', initiator: 'user' }));
  assert.deepEqual(JSON.parse(send('t3').text).reversions.map(row => row.id), ['k-gap', 'k-t3']);
  turns[2].completedAt = at(6); turns.push({ id: 't4' }, { id: 't5' }, { id: 't6' });
  // t4's window (since t2 ended) still holds k-t3, which the conversation was told about: nothing is sent again.
  assert.equal(send('t4'), null);
  // t5's window (since t3 ended) is empty: the settled value, once.
  assert.match(send('t5').text, /describe past undos, not new ones/);
  turns[3].completedAt = at(7);
  assert.equal(messages.length, 3); assert.match(send('t6').text, /describe past undos, not new ones/); assert.equal(messages.length, 3, 'the same settled text is not appended twice');
  // A compaction after t5 restores the key's last value right after its summary: the settled one, not the old notice.
  const journal = [{ id: 'u1', role: 'user', source: 'user', content: [{ type: 'text', text: 'hi' }] }, ...messages, { id: 'u2', role: 'user', source: 'user', content: [{ type: 'text', text: 'next' }] }];
  const projected = prepareContext({ systemPrompt: 'stable', messages: journal, compaction: { id: 'c1', summary: 'earlier work', throughMessageId: messages.at(-1).id } }).messages;
  const restored = projected.filter(row => JSON.stringify(row).includes(REVERSIONS_SOURCE));
  assert.equal(restored.length, 1); assert.match(JSON.stringify(restored[0]), /describe past undos, not new ones/); assert.doesNotMatch(JSON.stringify(restored[0]), /k-t3/);
});

test('a direct fix\'s records name the finding\'s action, so the reverted change annotates that action\'s receipt', () => {
  // directHandleIsolated runs the fix as `<actionId>-direct`; its background worktree's apply records carry that id.
  const { state, project } = world({ applies: [
    write('bfix', 'background', { actionId: 'act-x-direct', worktreeId: 'bg-fix' }, 1, { state: 'rolled_back', rolledBackBy: 'kfix' }),
    undo('kfix', 10, { source: { actionId: 'act-x-direct', worktreeId: 'bg-fix' }, undoes: 'bfix', initiator: 'user' }),
  ] });
  const events = deriveWorkspaceEvents(state, project);
  assert.deepEqual([events[0].kind, events[0].owner], ['background_reverted', { actionId: 'act-x' }]);
  assert.deepEqual(actionReversion(events, 'act-x'), { at: at(10) });
  assert.equal(snapshotWorkspaceEvents(events).events[0].actionId, 'act-x', 'the snapshot event names the receipt\'s action');
});

test('a record written before `initiator` existed is the user\'s, unless the model\'s own agent_merge drop wrote it', () => {
  const dropCall = (id, args, status = 'succeeded') => ({ id, turnId: 't2', kind: 'tool', tool: { id: `call-${id}`, name: 'agent_merge', args, status } });
  const sessions = [
    { id: 's1', projectId: 'p1', turns: [{ id: 't2', completedAt: at(2), delegations: [{ id: 'ag-model', merge: { status: 'dropped' } }, { id: 'ag-card', merge: { status: 'dropped' } }, { id: 'ag-refused', merge: { status: 'dropped' } }] }],
      items: [dropCall('i1', { agentId: 'ag-model', action: 'drop' }), dropCall('i2', { changeId: 'c-handed', action: 'drop' }), dropCall('i3', { agentId: 'ag-refused', action: 'drop' }, 'failed'), dropCall('i4', { agentId: 'ag-card', action: 'merge' })] }];
  const { state, project } = world({ sessions, backgroundChanges: [{ id: 'c-handed', kind: 'git', actionId: 'act-h', applyId: 'bh', applyIds: ['bh'], status: 'reverted' }], applies: [
    write('w-model', 'worker', { sessionId: 's1', turnId: 't2', agentId: 'ag-model' }, 1, { state: 'rolled_back', rolledBackBy: 'k-model' }),
    undo('k-model', 10, { source: { sessionId: 's1', turnId: 't2' }, undoes: 'w-model' }),
    write('w-card', 'worker', { sessionId: 's1', turnId: 't2', agentId: 'ag-card' }, 1, { state: 'rolled_back', rolledBackBy: 'k-card' }),
    undo('k-card', 11, { source: { sessionId: 's1', turnId: 't2' }, undoes: 'w-card' }),
    write('w-refused', 'worker', { sessionId: 's1', turnId: 't2', agentId: 'ag-refused' }, 1, { state: 'rolled_back', rolledBackBy: 'k-refused' }),
    undo('k-refused', 12, { source: { sessionId: 's1', turnId: 't2' }, undoes: 'w-refused' }),
    // A background change set handed to the conversation, dropped by its agent_merge({ changeId }).
    write('bh', 'background', { actionId: 'act-h', worktreeId: 'bg-h' }, 2, { state: 'rolled_back', rolledBackBy: 'k-handed' }),
    undo('k-handed', 13, { undoes: 'bh' }),
    // Another background set the user reverted from its line.
    write('bu', 'background', { actionId: 'act-u', worktreeId: 'bg-u' }, 2, { state: 'rolled_back', rolledBackBy: 'k-user' }),
    undo('k-user', 14, { undoes: 'bu' }),
    // A discard and an interrupted apply's "go back to before" were always the user's.
    { id: 'd-old', kind: 'user_discard', target: 'project', source: {}, state: 'verified', files: 1, sample: ['n.md'], at: at(15) },
  ] });
  assert.deepEqual(deriveWorkspaceEvents(state, project).map(row => [row.id, row.kind]), [['d-old', 'discarded'], ['k-user', 'background_reverted'], ['k-refused', 'worker_dropped'], ['k-card', 'worker_dropped']]);
  // A record that says who asked is taken at its word, whatever the conversation holds.
  project.git.applies.find(row => row.id === 'k-model').initiator = 'user';
  assert.ok(deriveWorkspaceEvents(state, project).some(row => row.id === 'k-model'));
});
