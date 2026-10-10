import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitiativeController, EARLIER_TASK_PLACEHOLDER } from '../project-initiative-controller.mjs';
import { projectWorkingContext, SCHEDULE_TASK_PLACEHOLDER } from '../../../packages/sdk/src/project-context.mjs';
import { SCHEDULED_DELIVERY_INSTRUCTION } from '../proactive-narrator.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';
import { checkOccurrence, inclusionCheck, leafDiff, recordedFirstRequest, estimateTokens } from '../benchmark/brief-inclusion.mjs';

// benchmark/brief-inclusion.mjs is the equivalence check of the scheduled-run dedupe (token burn T3): on a recorded
// occurrence it builds the first request as it was and as it is, and fails when something the new one leaves out is not
// found word for word in what it keeps. Its own gates: it passes on a faithful dedupe, and it fails on a lossy one.
const RULE = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
const TAIL = `\n\nProduce the requested deliverable using current evidence and authorized tools. Report actual outputs and any limitation. The host will deliver this result to the configured project conversation; do not send it to another channel. ${SCHEDULED_DELIVERY_INSTRUCTION}`;
const TASK = `Daily research. ${'Cover the models, frameworks and products that changed today and cite a source for every item. '.repeat(12)}Deliver the report text.`;
const content = (key, due, task) => `Scheduled occurrence ${key}\nDue: ${due}\nTime rule: ${JSON.stringify(RULE)}\n\n${task}${TAIL}`;
const scheduled = (id, key, due, extra = {}) => ({ id, action: 'work', status: 'completed', content: content(key, due, TASK), evidenceIds: [key], intentKey: id, revision: 1, hostSchedule: { key, scheduleId: 'daily', scheduleRevision: 1, destinationSessionId: 's' }, finishedAt: Date.parse(due) + 600000, handoff: `HANDOFF_OF_${id}`, ...extra });

/** A real Store with a project that has run a schedule three times, and the journal of the third run's first request. */
function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-brief-inclusion-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Inclusion fixture', workspace: directory, initiative: { cooldownMs: 0 } });
  const running = scheduled('day-3', 'schedule:daily:k3', '2026-10-03T01:00:00.000Z', { status: 'running' });
  delete running.handoff; delete running.finishedAt;
  store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    Object.assign(p, { decisionMode: 'rna-model', initialization: { status: 'ready' }, simulated: false, permissions: { workspace: 'write', background: 'inherit', revision: 1 }, assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
    p.initiativeRuntime = { sdkState: { actions: [scheduled('day-1', 'schedule:daily:k1', '2026-10-01T01:00:00.000Z'), scheduled('day-2', 'schedule:daily:k2', '2026-10-02T01:00:00.000Z'), running], events: [] } };
    p.jobs = [{ id: 'day-3', projectId: p.id, kind: 'research', lane: 'background', status: 'running', simulated: false, instruction: running.content, createdAt: '2026-10-03T01:00:00.000Z' }];
    p.schedules = [createProjectSchedule({ id: 'daily', title: 'Daily', task: TASK, destinationSessionId: 's1', rule: RULE })];
  });
  const current = () => store.state.projects.find(row => row.id === project.id), at = Date.parse('2026-10-03T01:00:05.000Z');
  const controller = Object.assign(Object.create(ProjectInitiativeController.prototype), { store, now: () => at, independentLearning: true });
  const brief = controller.workerBrief(current(), { evidence: [], query: running.content }), planning = projectWorkingContext(current());
  const line = (seq, type, data) => JSON.stringify({ seq, type, time: '2026-10-03T01:00:05.000Z', data });
  const message = (id, source, text, context) => ({ id, role: 'user', content: [{ type: 'text', text }], source, timestamp: at, ...(context ? { context } : {}) });
  const journal = [
    line(1, 'session_header', { format: 'rna-session', version: 1, sessionId: 'day-3', projectId: project.id }),
    line(2, 'message', { message: message('m1', 'context', 'Updated reference catalog.', [{ source: 'project-brief', text: JSON.stringify(brief.stable) }]) }),
    line(3, 'message', { message: message('m2', 'user', running.content, [{ source: 'project-evidence', text: JSON.stringify({ project: brief.volatile, evidence: [] }) }]) }),
    line(4, 'message', { message: message('m3', 'context', 'Updated reference catalog.', [{ source: 'project-planning-state', text: JSON.stringify(planning) }]) }),
    line(5, 'request_started', {}),
  ].join('\n');
  return { state: store.state, journal, project: current };
}

test('the check passes on the dedupe: everything the new request leaves out is found word for word, nothing else is added', t => {
  const { state, journal } = world(t), result = checkOccurrence({ state, journal });
  assert.equal(result.ok, true, JSON.stringify(result.inclusion.missing.concat(result.inclusion.unexpectedAdditions)));
  assert.deepEqual(result.inclusion.missing, []); assert.deepEqual(result.inclusion.unexpectedAdditions, []);
  // The schedule's task, the run's own receipt (intent, evidence id) and pending job, and the earlier runs' task excerpts: all in the occurrence message.
  assert.ok(result.inclusion.inTaskMessage >= 6, `${result.inclusion.inTaskMessage} fragments were found in the occurrence message`);
  assert.deepEqual(result.inclusion.exempt.filter(row => row.why.startsWith('the run')).map(row => row.text).sort(), ['day-3', 'day-3'], 'the one thing nothing else names is the run\'s own action id');
  assert.deepEqual(result.inclusion.additions.map(row => row.text).sort(), [EARLIER_TASK_PLACEHOLDER, EARLIER_TASK_PLACEHOLDER, SCHEDULE_TASK_PLACEHOLDER].sort());
  assert.deepEqual(result.earlier, { replaced: 2, sameWholeTask: 2 }, 'both earlier runs had the very same task');
  // The rebuilt old request is the recorded one, and the new one is shorter.
  assert.deepEqual([result.fidelity.evidenceEqual, result.fidelity.planningEqual, result.fidelity.receiptsEqual, result.fidelity.pendingJobsEqual], [true, true, true, true]);
  assert.ok(result.first.charsRemoved > 2500 && result.first.tokensRemoved > 0, JSON.stringify(result.first));
  assert.equal(result.first.oldChars, result.first.recordedChars);
});

test('the check counts the earlier runs whose task differed from today\'s in the part the excerpt never showed (the statement says so)', t => {
  const { state: live, journal } = world(t), state = structuredClone(live), middle = 600;
  // Day 1's task has one more sentence in the middle: its excerpt (start and end) is the same, so it is replaced, and the statement is the honest one.
  const day1 = state.projects.flatMap(row => row.initiativeRuntime?.sdkState?.actions ?? []).find(row => row.id === 'day-1');
  day1.content = day1.content.slice(0, 200 + middle) + ' A sentence added in the middle. ' + day1.content.slice(200 + middle);
  const result = checkOccurrence({ state, journal });
  assert.equal(result.ok, true, JSON.stringify(result.inclusion.missing.concat(result.inclusion.unexpectedAdditions)));
  assert.deepEqual(result.earlier, { replaced: 2, sameWholeTask: 1 });
});

test('the check fails when the model wrote the run\'s own action id, the one identifier the new request no longer names', t => {
  const { state, journal } = world(t), written = JSON.stringify({ seq: 6, type: 'request_completed', time: '2026-10-03T01:00:09.000Z', data: { message: { content: [{ type: 'thinking', thinking: 'My own receipt day-3 says running.' }] } } });
  const result = checkOccurrence({ state, journal: `${journal}\n${written}` });
  assert.equal(result.ownIdWrittenByModel, true); assert.equal(result.ok, false);
  assert.equal(checkOccurrence({ state, journal }).ownIdWrittenByModel, false);
});

test('the check fails when a fragment the new request dropped is not kept anywhere, or when it adds more than a placeholder', () => {
  const before = { evidence: { receipts: [{ actionId: 'a', intent: 'Header\n\nTASK START\n[… middle omitted; project_history can read the original …]\nTASK END', handoff: 'HANDOFF A' }], jobs: [] }, planning: { task: 'THE WHOLE TASK' } };
  const kept = [{ name: 'task message', text: 'Header\n\nTHE WHOLE TASK ... TASK START ... TASK END' }];
  const faithful = { evidence: { receipts: [{ actionId: 'a', intent: 'Header\n\n(task text left out)', handoff: 'HANDOFF A' }], jobs: [] }, planning: { task: '(this run\'s task)' } };
  const placeholders = ['(task text left out)', '(this run\'s task)'];
  const ok = inclusionCheck({ before, after: faithful, kept, placeholders });
  assert.equal(ok.ok, true); assert.equal(ok.found.length, 3, 'the task, the excerpt\'s start and its end');
  // Lossy: the handoff is dropped and it is not in the occurrence message.
  const lossy = inclusionCheck({ before, after: { ...faithful, evidence: { receipts: [{ actionId: 'a', intent: 'Header\n\n(task text left out)' }], jobs: [] } }, kept, placeholders });
  assert.equal(lossy.ok, false); assert.deepEqual(lossy.missing.map(row => row.text), ['HANDOFF A']);
  // The task text is dropped but the occurrence message that should hold it does not.
  assert.equal(inclusionCheck({ before, after: faithful, kept: [{ name: 'task message', text: 'something else' }], placeholders }).ok, false);
  // Reworded: the new request says something the old one did not.
  const reworded = inclusionCheck({ before, after: { ...faithful, planning: { task: 'a brand new sentence' } }, kept, placeholders });
  assert.equal(reworded.ok, false); assert.deepEqual(reworded.unexpectedAdditions.map(row => row.text), ['a brand new sentence']);
  // A dropped row's labels are listed, not searched for; a long identifier is only excused when it is the run's own id.
  const row = { actionId: 'schedule-work-0123456789abcdef', status: 'running', action: 'work' };
  const dropped = inclusionCheck({ before: { rows: [row, { actionId: 'b', status: 'completed', action: 'work' }] }, after: { rows: [{ actionId: 'b', status: 'completed', action: 'work' }] }, kept: [], ownActionId: 'schedule-work-0123456789abcdef', placeholders });
  assert.equal(dropped.ok, true); assert.deepEqual(dropped.exempt.map(item => item.key).sort(), ['action', 'actionId', 'status']);
  assert.equal(inclusionCheck({ before: { rows: [row] }, after: { rows: [] }, kept: [], ownActionId: 'another-id', placeholders }).ok, false);
});

test('leafDiff aligns rows by id, keeps the lines a changed string shares, and reports additions', () => {
  const diff = leafDiff({ rows: [{ id: 'a', text: 'L1\n\nOLD' }, { id: 'b', text: 'same' }] }, { rows: [{ id: 'b', text: 'same' }, { id: 'a', text: 'L1\n\nNEW' }] });
  assert.deepEqual(diff.removed.map(row => [row.path, row.text]), [['rows[a].text', 'OLD']]); assert.deepEqual(diff.added.map(row => [row.path, row.text]), [['rows[a].text', 'NEW']]);
  assert.deepEqual(leafDiff({ list: ['x', 'y'] }, { list: ['x'] }).removed.map(row => row.text), ['y']);
  assert.deepEqual(leafDiff({ a: 'x' }, { a: 'x', b: 'new' }).added.map(row => row.text), ['new']);
});

test('recordedFirstRequest reads the messages before the first request and the task message', t => {
  const { journal } = world(t), recorded = recordedFirstRequest(journal);
  assert.equal(recorded.sessionId, 'day-3'); assert.equal(recorded.messages.length, 3);
  assert.match(recorded.taskText, /^Scheduled occurrence schedule:daily:k3/); assert.ok(recorded.context('project-evidence')); assert.equal(recorded.context('nothing'), null);
  assert.throws(() => recordedFirstRequest(journal.split('\n').slice(0, 1).join('\n')), /no first user message/);
});

test('the token estimate weighs Chinese characters heavier than other text (fitted on the 2026-10-05 run)', () => {
  assert.equal(estimateTokens('a'.repeat(1000)), 293); assert.equal(estimateTokens('字'.repeat(1000)), 868); assert.equal(estimateTokens(''), 0);
});
