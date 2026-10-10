import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectOrientation, projectWorkingContext, SCHEDULE_TASK_PLACEHOLDER } from '../src/project-context.mjs';
import { createProjectSchedule } from '../src/project-schedules.mjs';

test('orientation is bounded observed context; private files, denied paths and escaping root instructions do not leak', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rna-orientation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd); await mkdir(join(cwd, 'protected'));
  await writeFile(join(root, 'outside.md'), 'outside private instruction'); await symlink(join(root, 'outside.md'), join(cwd, 'AGENTS.md'));
  await writeFile(join(cwd, '.env'), 'secret'); await writeFile(join(cwd, 'README.md'), 'Project purpose\n' + 'a'.repeat(6000));
  await writeFile(join(cwd, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const result = await readProjectOrientation({ cwd, deniedPaths: [join(cwd, 'protected')] });
  assert.deepEqual(result.entries, ['package.json', 'README.md']);
  assert.equal(result.documents.length, 2); assert.equal(result.documents.find(row => row.path === 'README.md').truncated, true);
  assert.ok(result.documents.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.doesNotMatch(JSON.stringify(result), /outside private|secret|protected/);
  assert.equal(result.source, 'host-read-workspace');
});

test('missing read capability is explicit and a cancelled orientation does no further work', async () => {
  assert.match((await readProjectOrientation({ tools: [] })).limitations[0], /unavailable/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readProjectOrientation({ tools: [], signal: abort.signal }), { name: 'AbortError' });
});

test('working state is a bounded intent projection, excludes synthetic commitments and does not claim validation', () => {
  const result = projectWorkingContext({ name: 'Project', description: 'x'.repeat(12000), focus: 'Investigate', commitments: [{ text: 'real', simulated: false }, { text: 'fake', simulated: true }], milestones: [{ title: 'Export', status: 'pending', acceptanceCriteria: ['Reads back correctly'] }] });
  assert.equal(result.description.length, 8000); assert.deepEqual(result.commitments.map(row => row.text), ['real']);
  assert.match(result.evidenceBoundary, /not proof/); assert.equal(result.milestones[0].acceptanceCriteria[0], 'Reads back correctly');
});

// T3 (token burn, design P2): a scheduled run's message already holds its schedule's task, so its planning state says so
// instead of repeating it, but only for the schedule it performs and only while the text is still identical.
test('a scheduled run\'s planning state replaces its own schedule\'s task by the placeholder only while the task is byte-identical', () => {
  const task = 'Report the measured result.\nName the source of every number.', now = Date.parse('2026-10-05T00:00:00Z');
  const make = (id, text) => createProjectSchedule({ id, title: `Schedule ${id}`, task: text, destinationSessionId: 's1', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now });
  const project = { name: 'Project', schedules: [make('daily', task), make('other', task)] };
  const plain = projectWorkingContext(project);
  assert.equal(plain.schedules[0].task, task, 'without the option the state is what it always was');
  assert.deepEqual(projectWorkingContext(project, {}), plain); assert.deepEqual(projectWorkingContext(project, { omitScheduleTask: undefined }), plain);
  const carried = projectWorkingContext(project, { omitScheduleTask: { scheduleId: 'daily', task } });
  assert.equal(carried.schedules[0].task, SCHEDULE_TASK_PLACEHOLDER);
  assert.equal(carried.schedules[1].task, task, 'another schedule with the same words is not the run\'s and keeps its text');
  const withoutTask = state => ({ ...state, schedules: state.schedules.map(({ task: _task, ...row }) => row) });
  assert.deepEqual(withoutTask(carried), withoutTask(plain), 'nothing but the task text changed');
  // The schedule was edited after the occurrence was claimed: the model reads the edit, in full.
  const withTask = (row, text) => ({ ...row, task: text });
  const edited = projectWorkingContext({ ...project, schedules: [withTask(project.schedules[0], `${task}\nAlso list the open risks.`), project.schedules[1]] }, { omitScheduleTask: { scheduleId: 'daily', task } });
  assert.equal(edited.schedules[0].task, `${task}\nAlso list the open risks.`);
  // A task that is a prefix or an extension of the occurrence's, or one with other whitespace, is not identical.
  for (const changed of [task.slice(0, -1), `${task} `, task.replace('\n', ' ')]) assert.equal(projectWorkingContext({ ...project, schedules: [withTask(project.schedules[0], changed)] }, { omitScheduleTask: { scheduleId: 'daily', task } }).schedules[0].task, changed);
  // Nothing to carry: no task text, an unknown schedule, or a task that is not a string.
  for (const omit of [{ scheduleId: 'daily', task: '' }, { scheduleId: 'gone', task }, { scheduleId: 'daily' }, { scheduleId: 'daily', task: 42 }]) assert.deepEqual(projectWorkingContext(project, { omitScheduleTask: omit }), plain);
  assert.match(SCHEDULE_TASK_PLACEHOLDER, /^\(this run's task; identical to the task in this request\)$/);
});
