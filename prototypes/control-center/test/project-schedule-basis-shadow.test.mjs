import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { ProjectScheduleService } from '../project-schedule-service.mjs';
import { scheduleBasisCheck, projectUserItems, citedMessageIds, BASIS_CHECKS } from '../schedule-basis.mjs';

// W2 shadow `basis` check (design2 §7): when a schedule task changes, the model's `basis` (the user's own words) is compared
// with the project's user messages and the outcome — quoted, not_found, absent, one_off — is recorded; the change is ALWAYS
// saved. The tool path keeps it on the record (`taskBasis`), the planner path in the planning receipt (`basisCheck`). Neither
// is shown back to a model. A stale revision, on the other hand, is refused when the tool names `expectedRevision`.
const at = Date.parse('2026-10-03T01:00:00Z');
const draft = { title: 'Daily research', task: 'Collect first-hand sources and write the daily report.', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } };
const user = (id, text, extra = {}) => ({ id, turnId: `turn-${id}`, kind: 'user', text, createdAt: '2026-10-03T01:29:30.000Z', ...extra });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-basis-shadow-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project, session } = store.createProject({ name: 'Research', workspace: dir });
  store.mutate(state => {
    const row = state.projects.find(p => p.id === project.id); row.initiative.enabled = true; row.permissions = { workspace: 'write', background: 'read' };
    state.sessions.find(s => s.id === session.id).items = [
      user('m-durable', 'From now on the GitHub section only reports the most severe level.', { capture: { durable: 'durable', source: 'jev' } }),
      user('m-oneoff', 'Fix the 2 problems you found in the existing files.', { capture: { durable: 'one_off', source: 'jev' } }),
      user('m-plain', 'Keep the sources   section\nfirst.'),
      user('m-deleted', 'This message was deleted by the user.', { sourceDeleted: true }),
      { id: 'a-1', turnId: 'turn-a', kind: 'assistant', text: 'I will put the assistant words first.' }];
  });
  const service = new ProjectScheduleService(store, { now: () => at }), record = service.create(project.id, structuredClone(draft), { requestId: 'daily' });
  const tools = service.createTools({ projectId: project.id, sessionId: session.id }), write = tools.find(tool => tool.name === 'project_schedule'), list = tools.find(tool => tool.name === 'project_schedule_list');
  const run = async (args, id = 'call') => { const result = await write.execute(id, args); return { result, body: result.isError ? null : JSON.parse(result.content[0].text), text: result.content[0].text }; };
  const stored = () => store.state.projects.find(p => p.id === project.id).schedules[0];
  return { dir, store, project, session, service, record, write, list, run, stored };
}

test('scheduleBasisCheck: plain containment after whitespace normalization; the most recent matching message is named', () => {
  const items = [{ id: 'a', sessionId: 's', text: 'Report   only\nthe worst level.', at: '1', durable: null }, { id: 'b', sessionId: 's', text: 'report only the worst level, thanks', at: '2', durable: 'one_off' }, { id: 'c', sessionId: 's', text: 'Something else', at: '3', durable: 'durable' }];
  assert.deepEqual(BASIS_CHECKS, ['quoted', 'not_found', 'absent', 'one_off']);
  assert.deepEqual(scheduleBasisCheck({ basis: 'Report only the worst level', items }), { check: 'quoted', basisChars: 27, messageId: 'a', sessionId: 's' }, 'case matters: the lowercase message does not contain it');
  assert.equal(scheduleBasisCheck({ basis: ' Report only\n the worst   level. ', items }).check, 'quoted');
  assert.deepEqual(scheduleBasisCheck({ basis: 'report only the worst level', items }), { check: 'one_off', basisChars: 27, messageId: 'b', sessionId: 's', durable: 'one_off' });
  assert.deepEqual(scheduleBasisCheck({ basis: 'Something', items }), { check: 'quoted', basisChars: 9, messageId: 'c', sessionId: 's', durable: 'durable' });
  for (const basis of [undefined, null, '', '   \n\t', 7]) assert.deepEqual(scheduleBasisCheck({ basis, items }), { check: 'absent' });
  assert.deepEqual(scheduleBasisCheck({ basis: 'never said', items }), { check: 'not_found', basisChars: 10 });
  // The planner counts only the messages its decision cites.
  assert.equal(scheduleBasisCheck({ basis: 'Something else', items, referenced: ['a'] }).check, 'not_found');
  assert.equal(scheduleBasisCheck({ basis: 'Something else', items, referenced: ['c'] }).check, 'quoted');
  assert.equal(scheduleBasisCheck({ basis: 'Something else', items, referenced: [] }).check, 'not_found');
  assert.deepEqual(citedMessageIds(['message:x1', 'turn:t:completed', 'message:', 7, 'message:x2']), ['x1', 'x2']);
  assert.deepEqual(citedMessageIds(undefined), []);
});

test('projectUserItems: only live user messages of this project\'s conversations that are not archived', t => {
  const f = fixture(t);
  f.store.mutate(state => {
    state.sessions.push({ ...structuredClone(state.sessions.find(s => s.id === f.session.id)), id: 'archived', archivedAt: '2026-10-01T00:00:00.000Z', items: [user('m-archived', 'An archived conversation message.')] });
    state.sessions.find(s => s.id === f.session.id).items.push(user('m-revoked', 'Revoked by the user.', { contextRevoked: true }));
  });
  const ids = projectUserItems(f.store.state, f.project.id).map(row => row.id);
  assert.deepEqual(ids.sort(), ['m-durable', 'm-oneoff', 'm-plain']);
  assert.deepEqual(projectUserItems(f.store.state, 'other-project'), []);
});

test('tool path: a changed task is always saved; the check is recorded on the record as quoted, one_off, not_found or absent', async t => {
  const f = fixture(t), id = f.record.id;
  let revision = f.record.revision;
  const change = async (task, basis, extra = {}) => { const out = await f.run({ action: 'update', id, task, ...(basis === undefined ? {} : { basis }), ...extra }, `c-${task.length}`); assert.equal(out.result.isError, undefined, out.text); revision++; assert.equal(f.stored().task, task); assert.equal(f.stored().revision, revision); return f.stored().taskBasis; };
  const quoted = await change('Write the daily report. The GitHub section only reports the most severe level.', 'From now on the GitHub section only reports the most severe level.');
  assert.equal(quoted.check, 'quoted'); assert.equal(quoted.messageId, 'm-durable'); assert.equal(quoted.durable, 'durable'); assert.equal(quoted.by, 'conversation'); assert.equal(quoted.at, new Date(at).toISOString());
  const oneOff = await change('Write the daily report. Fix the 2 problems in the existing files.', 'Fix the 2 problems you found');
  assert.equal(oneOff.check, 'one_off'); assert.equal(oneOff.messageId, 'm-oneoff');
  const spaced = await change('Write the daily report. Sources first.', 'Keep the sources section first.');
  assert.equal(spaced.check, 'quoted'); assert.equal(spaced.messageId, 'm-plain');
  assert.equal((await change('Write the daily report. The user decided to skip browsers.', 'The user decided to skip browsers.')).check, 'not_found', 'only a user message counts, and nobody said this');
  assert.equal((await change('Write the daily report. Assistant words first.', 'I will put the assistant words first.')).check, 'not_found', 'an assistant message is not the user\'s words');
  assert.equal((await change('Write the daily report. A deleted message.', 'This message was deleted by the user.')).check, 'not_found');
  assert.equal((await change('Write the daily report. Nothing quoted.')).check, 'absent');
  // A change that leaves the task alone records nothing and keeps the earlier record.
  const before = f.stored().taskBasis;
  assert.equal((await f.run({ action: 'update', id, enabled: false })).result.isError, undefined);
  assert.deepEqual(f.stored().taskBasis, before); assert.equal(f.stored().enabled, false);
  // The edit is still recorded as the user's, as it always was (no B3).
  assert.equal(f.stored().lastEditedBy, 'user'); assert.ok(f.stored().userEditedAt);
});

test('tool path: the page or the API changing the task drops the earlier record; the model never reads taskBasis', async t => {
  const f = fixture(t), id = f.record.id;
  const saved = await f.run({ action: 'update', id, task: 'Sources first.', basis: 'Keep the sources section first.' });
  assert.ok(f.stored().taskBasis); assert.equal(saved.body.taskBasis, undefined); assert.doesNotMatch(saved.text, /taskBasis|basisCheck/);
  const listed = JSON.parse((await f.list.execute('list', {})).content[0].text);
  assert.equal(listed.schedules[0].task, 'Sources first.'); assert.equal(listed.schedules[0].taskBasis, undefined);
  assert.ok(f.service.list(f.project.id).schedules[0].taskBasis, 'the user\'s page still reads it');
  assert.equal(f.service.agentView(f.project.id).schedules[0].taskBasis, undefined);
  f.service.update(f.project.id, id, { task: 'Written on the page.' });
  assert.equal(f.stored().taskBasis, undefined);
  assert.equal(f.stored().task, 'Written on the page.');
});

test('tool path: expectedRevision refuses a stale update, is optional, and basis and expectedRevision are never schedule fields', async t => {
  const f = fixture(t), id = f.record.id;
  const stale = await f.run({ action: 'update', id, task: 'Stale change.', expectedRevision: 5 });
  assert.equal(stale.result.isError, true); assert.equal(stale.result.details.code, 'schedule_revision_conflict');
  assert.equal(stale.text, 'The schedule changed since you read it (now revision 1). Read it again with project_schedule_list and repeat the smallest change.');
  assert.equal(f.stored().task, draft.task); assert.equal(f.stored().revision, 1);
  const fresh = await f.run({ action: 'update', id, task: 'Fresh change.', expectedRevision: 1, basis: 'Keep the sources section first.' });
  assert.equal(fresh.result.isError, undefined); assert.equal(f.stored().task, 'Fresh change.'); assert.equal(f.stored().revision, 2);
  assert.equal(f.stored().expectedRevision, undefined); assert.equal(f.stored().basis, undefined);
  assert.equal((await f.run({ action: 'update', id, title: 'Renamed' })).result.isError, undefined, 'expectedRevision is optional');
  for (const bad of [{ expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: '3' }, { basis: 7 }, { basis: 'x'.repeat(1001) }]) assert.equal((await f.run({ action: 'update', id, task: 'Never saved.', ...bad })).result.isError, true, JSON.stringify(bad).slice(0, 40));
  assert.notEqual(f.stored().task, 'Never saved.');
  // create and delete ignore the two keys; delete still takes no other field.
  assert.equal((await f.run({ action: 'delete', id, expectedRevision: 1, basis: 'x' })).body.deleted, true);
});

test('tool path: a revision that moved because the user paused or renamed the schedule is refused as "the schedule changed", not as a task change that never happened', async t => {
  const f = fixture(t), id = f.record.id;
  const read = JSON.parse((await f.list.execute('list', {})).content[0].text).schedules.find(row => row.id === id).revision;
  f.service.update(f.project.id, id, { enabled: false });
  f.service.update(f.project.id, id, { title: 'Renamed by the user' });
  const refused = await f.run({ action: 'update', id, task: 'Changed after the user paused it.', expectedRevision: read });
  assert.equal(refused.result.isError, true); assert.equal(refused.result.details.code, 'schedule_revision_conflict');
  assert.match(refused.text, /^The schedule changed since you read it \(now revision 3\)\./); assert.doesNotMatch(refused.text, /task changed/i, 'the task was not what moved');
  assert.equal(f.stored().task, draft.task, 'nothing was saved'); assert.equal(f.stored().enabled, false);
  // The refusal is the whole price: reading again and sending the current revision saves the change, and the pause stays.
  const again = await f.run({ action: 'update', id, task: 'Changed after the user paused it.', expectedRevision: 3 });
  assert.equal(again.result.isError, undefined); assert.equal(f.stored().task, 'Changed after the user paused it.'); assert.equal(f.stored().enabled, false);
});

// ----- the planner path
function planner(f, over = {}) {
  const evidence = [{ id: 'message:m-durable', type: 'user_message', summary: 'From now on…' }, { id: 'message:m-oneoff', type: 'user_message', summary: 'Fix the…' }, { id: 'project-state', type: 'project_state', summary: 'State.' }];
  let n = 0;
  return { evidence, apply: (schedule, ids = ['message:m-durable'], extra = {}) => f.service.applyInitiativeAction(f.project.id, { actionId: `act-${++n}`, schedule, reason: 'The user asked for a lasting change.', evidenceIds: ids, evidence, ...extra }), ...over };
}
const receipts = f => f.store.state.projects.find(p => p.id === f.project.id).scheduleManagementReceipts;

test('planner path: the check reads only the cited user messages, lands in the planning receipt, and never refuses', t => {
  const f = fixture(t), p = planner(f), id = f.record.id;
  let revision = f.record.revision;
  const change = (task, basis, ids) => { const receipt = p.apply({ operation: 'update', id, expectedRevision: revision, task, ...(basis === undefined ? {} : { basis }) }, ids); revision = receipt.revision; assert.equal(f.stored().task, task); return { receipt, row: receipts(f).at(-1) }; };
  const quoted = change('Report only the most severe level.', 'GitHub section only reports the most severe level');
  assert.equal(quoted.row.basisCheck, 'quoted'); assert.equal(quoted.row.basisMessageId, 'm-durable');
  assert.equal(change('Fix the files once.', 'Fix the 2 problems you found', ['message:m-oneoff']).row.basisCheck, 'one_off');
  assert.equal(change('Cited the wrong message.', 'Fix the 2 problems you found', ['message:m-durable']).row.basisCheck, 'not_found', 'a real user message the decision did not cite does not count');
  assert.equal(change('Cited no message.', 'GitHub section only reports', ['project-state']).row.basisCheck, 'not_found');
  assert.equal(change('No basis at all.', undefined).row.basisCheck, 'absent');
  assert.equal(change('Mechanical change.', '   ').row.basisCheck, 'absent');
  // An update that leaves the task alone writes no check; nothing the planner reads back carries one.
  const before = receipts(f).length;
  const meta = p.apply({ operation: 'update', id, expectedRevision: revision, enabled: false });
  assert.equal(receipts(f).length, before + 1); assert.equal(receipts(f).at(-1).basisCheck, undefined);
  for (const row of [quoted.receipt, meta, f.service.initiativeReceipt(f.project.id, receipts(f)[0].actionId)]) assert.equal(row.basisCheck, undefined, JSON.stringify(row).slice(0, 80));
  assert.equal(f.stored().taskBasis, undefined, 'the planner path records in the receipt, not on the record');
});

test('planner path: a retried action returns the same receipt without the check, a create refuses basis, and a bad basis is a refused action', t => {
  const f = fixture(t), p = planner(f), id = f.record.id;
  const action = { actionId: 'same', schedule: { operation: 'update', id, expectedRevision: 1, task: 'Once.', basis: 'GitHub section only reports' }, reason: 'The user asked.', evidenceIds: ['message:m-durable'], evidence: p.evidence };
  const first = f.service.applyInitiativeAction(f.project.id, action), again = f.service.applyInitiativeAction(f.project.id, action);
  assert.deepEqual(again, first); assert.equal(again.basisCheck, undefined); assert.equal(receipts(f).filter(row => row.actionId === 'same').length, 1);
  assert.equal(receipts(f).at(-1).basisCheck, 'quoted');
  assert.deepEqual(f.service.reconcileInitiativeAction(f.project.id, action), f.service.initiativeReceipt(f.project.id, 'same'));
  assert.throws(() => p.apply({ operation: 'create', purposeKey: 'new-one', ...draft, destinationSessionId: f.session.id, basis: 'x' }), /无效字段/);
  assert.throws(() => p.apply({ operation: 'update', id, expectedRevision: 2, task: 'x', basis: 7 }), /basis/);
  assert.throws(() => p.apply({ operation: 'update', id, expectedRevision: 2, task: 'x', basis: 'y'.repeat(1001) }), /basis/);
  assert.throws(() => p.apply({ operation: 'delete', id, expectedRevision: 2, basis: 'x' }), /无效字段/);
  assert.equal(f.stored().task, 'Once.');
});

test('planner path: a task another author changes no longer carries an earlier tool record, and the planner view hides it', async t => {
  const f = fixture(t), p = planner(f), id = f.record.id;
  await f.run({ action: 'update', id, task: 'Tool edit.', basis: 'Keep the sources section first.' });
  assert.ok(f.stored().taskBasis);
  assert.equal(f.service.agentView(f.project.id).schedules[0].taskBasis, undefined);
  p.apply({ operation: 'update', id, expectedRevision: f.stored().revision, task: 'Planner edit.', basis: 'GitHub section only reports' });
  assert.equal(f.stored().taskBasis, undefined);
  assert.equal(receipts(f).at(-1).basisCheck, 'quoted');
});
