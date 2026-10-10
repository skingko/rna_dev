// D4 scenario (design2 §7 W2): a one-off request quoted as the basis of a change to a schedule's standing task. Crosses the
// conversation (the user's message and its JEV capture), the foreground model's project_schedule tool (scripted), the
// schedule service (shadow basis check, revision check), the planner (scripted decision with a basis nobody said) and the
// user's own page. The shadow check only RECORDS: the change is saved either way, as `one_off`/`not_found`, in the schedule
// record (tool path) or the planning receipt (planner path); nothing a model reads back carries the record. A stale
// `expectedRevision` is the one thing refused. Only the model and JEV are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { decide, decisionInput } from '../harness/faux-model.mjs';

const BASE = 'Write the daily report. Keep the sources section first.';
const ONE_OFF = 'Fix the 2 problems found in the existing files.';
const userItem = (world, text) => world.session().items.find(row => row.kind === 'user' && row.text === text);

test('a one-off message quoted as the basis of a task change: the change is saved and recorded as one_off; a basis nobody said is not_found; a stale revision is refused', async t => {
  const world = await createWorld(t, { initiative: true, files: { 'README.md': '# Daily report\n' } });
  const s = scenario(world);
  // The v2 texts (the setting is the release switch): the tool declares `basis` and `expectedRevision`.
  assert.equal((await world.patch('/api/configuration', { schedulePromptVersion: 'v2' })).body.schedulePromptVersion, 'v2');
  // JEV judges the one-off message as concerning only this request, everything else as lasting.
  world.jev.answer('durable_vs_one_off', (_question, body) => JSON.stringify(body.state).includes(ONE_OFF) ? 'one_off' : 'durable');
  const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: BASE, destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  const scheduleId = created.body.id, record = () => world.project().schedules.find(row => row.id === scheduleId);

  const asked = await s.send(ONE_OFF, { reply: 'Fixed the two problems in the files.' });
  await until(() => userItem(world, ONE_OFF)?.capture?.durable, 'the message to be captured');
  const messageId = userItem(world, ONE_OFF).id;
  await asked.expect({ state: () => { assert.equal(userItem(world, ONE_OFF).capture.durable, 'one_off'); assert.equal(record().task, BASE, 'the standing task was left alone'); } });

  await t.test('foreground: the model writes the one-off into the task and quotes it; the change is saved, recorded as one_off, and the model reads no record of it', async () => {
    const newTask = `${BASE} Fix the 2 problems found in the existing files before delivery.`;
    const wrote = await s.send('Also keep that in the daily task.', { reply: [{ toolCalls: [{ name: 'project_schedule', args: { action: 'update', id: scheduleId, task: newTask, basis: ONE_OFF, expectedRevision: record().revision } }] }, 'Saved.'] });
    await wrote.expect({
      state: () => {
        assert.equal(record().task, newTask, 'the shadow check never refuses: the change is saved');
        assert.deepEqual([record().taskBasis.check, record().taskBasis.by, record().taskBasis.messageId, record().taskBasis.durable], ['one_off', 'conversation', messageId, 'one_off']);
        assert.equal(record().lastEditedBy, 'user', 'the edit is recorded as the user\'s, as it always was');
      },
      requests: rows => {
        const foreground = rows.filter(row => row.tag === 'foreground');
        assert.equal(foreground.length, 2, 'the tool call, then the reply');
        const tool = foreground[0].request.tools.find(row => row.name === 'project_schedule');
        assert.match(tool.description, /standing instruction every run receives/); assert.ok('basis' in tool.parameters.properties && 'expectedRevision' in tool.parameters.properties);
        assert.match(foreground[0].request.systemPrompt, /A request made once never becomes part of an existing task/);
        assert.doesNotMatch(foreground[1].wire, /taskBasis|one_off/, 'the tool result the model reads carries no record of the check');
      },
    });
    // The user's own page does read it.
    const page = await world.get(`/api/projects/${world.projectId}/schedules`);
    assert.equal(page.body.schedules[0].taskBasis.check, 'one_off');
  });

  await t.test('foreground: a stale expectedRevision is the one thing refused, with a message that says what to do', async () => {
    const before = record().task, stale = record().revision - 1;
    const refused = await s.send('Make it shorter.', { reply: [{ toolCalls: [{ name: 'project_schedule', args: { action: 'update', id: scheduleId, task: 'Write the report.', basis: 'Make it shorter.', expectedRevision: stale } }] }, 'It changed in between; I will read it again.'] });
    await refused.expect({
      state: () => assert.equal(record().task, before, 'nothing was saved'),
      requests: rows => { const second = rows.filter(row => row.tag === 'foreground')[1]; assert.match(second.wire, new RegExp(`The schedule changed since you read it \\(now revision ${record().revision}\\)\\. Read it again with project_schedule_list`)); },
    });
  });

  await t.test('planner: a scripted decision quotes words nobody said; the change is saved and the receipt records not_found, which the planner never reads back', async () => {
    world.jev.answer('needs_main_model', 0.95).answer('evidence_relevant', 0.9).answer('already_reported', 0.05);
    let decisions = 0, receiptSeen = null; const plannerTask = `${BASE} Fix the 2 problems found in the existing files before delivery. Plan the next step.`;
    world.faux.on('initiative', request => {
      const input = decisionInput(request), schedule = input.project.schedules?.[0];
      receiptSeen = JSON.stringify(request.messages);
      if (!schedule || schedule.task === plannerTask || decisions) return decide(input, 'wait', '', { nextReviewAfterMs: 3600000 });
      decisions++;
      const cited = input.events.find(row => row.type === 'user_message' && String(row.summary).includes(ONE_OFF))?.id;
      return decide(input, 'schedule', 'Update the task.', { reason: 'The user asked for a lasting change.', evidenceIds: [cited ?? input.events.at(-1).id], fields: { schedule: { operation: 'update', id: schedule.id, expectedRevision: schedule.revision, task: plannerTask, basis: 'This sentence was never said by anyone.' } } });
    });
    await s.advanceClock(86400000 + 60000, { settleMs: 1500, label: 'the initiative reviews the schedule', until: () => (world.project().scheduleManagementReceipts ?? []).length >= 1 });
    await until(() => (world.project().scheduleManagementReceipts ?? []).length >= 1, 'the planner\'s schedule change to be committed', 20000);
    const [receipt] = world.project().scheduleManagementReceipts;
    assert.equal(record().task, plannerTask, 'saved: the check refuses nothing');
    assert.equal(receipt.basisCheck, 'not_found'); assert.equal(receipt.revision, record().revision); assert.equal(record().taskBasis, undefined, 'the planner path records in the receipt, not on the record');
    // Later decisions read the schedules and their receipts; none of it carries the check or the earlier tool record.
    await s.advanceClock(2 * 3600000, { settleMs: 1500, label: 'the next review' });
    assert.doesNotMatch(String(receiptSeen), /basisCheck|taskBasis|not_found/);
    const requests = world.faux.of('initiative'); assert.ok(requests.length >= 2);
    assert.match(requests.at(-1).request.systemPrompt, /standing instruction that every future run receives/);
    assert.ok(JSON.stringify(JSON.parse(requests.at(-1).request.systemPrompt.split('matching this schema: ').at(-1)).properties.schedule).includes('"basis"'));
  });
});
