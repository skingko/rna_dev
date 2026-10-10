import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULE_TEXT_V1, SCHEDULE_TEXT_V2, scheduleToolDescription, scheduleToolParameters, scheduleForegroundParagraph, scheduleContractText, schedulePolicyReason } from '../schedule-prompt.mjs';

// W2 text checks (design2 §7 W2, test project-schedule-tool-text): the v2 tool description says what a task is and where a
// one-off request goes, keeps every information point of the v1 description, and is English with no interpolated state.
const cjk = /[㐀-鿿　-〿＀-￯]/;
const description = scheduleToolDescription('v2');

test('v2 tool description: the standing instruction, the one-off decision table, and the basis rule', () => {
  for (const phrase of ['standing instruction', '`basis`', 'rule kind "once"', 'project_plan item (status next)', 'do it now and leave the task alone', 'change only what the user\'s request touches', 'keep every other sentence as it is', 'Never write that the user decided something unless their words say so', 'treat it as a request for now', 'Do not repeat the rule\'s time, time zone or frequency']) assert.ok(description.includes(phrase), phrase);
  assert.doesNotMatch(description, cjk);
  assert.doesNotMatch(description, /\$\{|undefined|\[object/);
});

test('v2 tool description keeps the nine information points of the v1 description', () => {
  const points = {
    'list first, to avoid a duplicate': /Call project_schedule_list first and change the matching task instead of adding another/,
    'create needs title, task and rule': /create needs title, task and rule/,
    'update and delete need id': /update and delete need id/,
    'daily and weekly need HH:mm and an IANA time zone': /daily and weekly rules need HH:mm and an IANA timeZone/,
    'defaults come from list and are announced': /use the application defaults from project_schedule_list \(09:00 and the local time zone\) and say so/,
    'delivery is this conversation, never external': /Delivery is to this project's conversation, never an external channel/,
    'a one-time task is no recurring schedule': /Something the user asked for once: do it now and leave the task alone/,
    'report the next run and the pause state, never promise before saved': /report the next run time and pause state from the result; do not call it scheduled before the host has saved it/,
    'subject to the switch, permissions, budget and mute': /Runs stay subject to the project's activity switch, permissions, budget and mute setting/ };
  for (const [name, pattern] of Object.entries(points)) assert.match(description, pattern, name);
  // …and the v1 description said the same nine things (a guard against pinning the wrong set).
  const v1 = SCHEDULE_TEXT_V1.toolDescription;
  for (const word of ['先 list', 'title/task/rule', 'update/delete 需 id', 'HH:mm', 'IANA timeZone', '应用默认09:00', '不会向外部发送消息', '一次任务时不要创建周期日程', '下次执行与暂停状态', '预算和静音']) assert.ok(v1.includes(word), word);
});

test('v2 parameters add the three descriptions with an optional basis (at most 1000 characters) and expectedRevision; v1 adds nothing', () => {
  const v1 = scheduleToolParameters('v1'), v2 = scheduleToolParameters('v2');
  assert.equal(v1.properties.basis, undefined); assert.equal(v1.properties.expectedRevision, undefined); assert.equal(v1.properties.task.description, undefined);
  assert.deepEqual(Object.keys(v2.properties), [...Object.keys(v1.properties), 'basis', 'expectedRevision']);
  assert.equal(v2.properties.task.description, 'Standing instruction for every run (see the tool description). Not a log, not progress, and not a place for one-time requests.');
  assert.deepEqual(v2.properties.basis, { type: 'string', minLength: 1, maxLength: 1000, description: 'When an update changes task: the user\'s own words, copied exactly from one of their messages, that ask for the change to apply to every future run.' });
  assert.deepEqual(v2.properties.expectedRevision, { type: 'integer', minimum: 1, description: 'Revision from project_schedule_list. The update fails if the schedule changed since.' });
  assert.deepEqual(v2.required, ['action']); assert.equal(v2.additionalProperties, false);
  // Everything else is the v1 declaration.
  const { task: v1Task, ...v1Rest } = v1.properties, { task: v2Task, basis, expectedRevision, ...v2Rest } = v2.properties;
  assert.deepEqual(v2Rest, v1Rest); assert.deepEqual({ ...v2Task, description: undefined }, { ...v1Task, description: undefined });
  assert.doesNotMatch(JSON.stringify(v2), cjk);
});

test('v2 foreground paragraph: recurring or later work, a one-off request never joins a task, and no Chinese', () => {
  const paragraph = scheduleForegroundParagraph('v2');
  for (const phrase of ['call project_schedule_list and save it with project_schedule', 'promise it only after the host reports it saved with a next run time', 'use the application default and tell the user it can be changed', 'finish it in this turn and do not ask the user to say "continue"', 'A request made once never becomes part of an existing task', 'Stop and ask only when you need the user\'s decision, information or authorization']) assert.ok(paragraph.includes(phrase), phrase);
  assert.doesNotMatch(paragraph, cjk);
  // The v1 paragraph's information points are all still there.
  for (const word of ['project_schedule_list', '保存规则与投递会话', '下次执行时间后才能承诺已安排', '应用默认值并告知用户', '当前工作不是日程', '再说“继续”', '决定、信息或授权']) assert.ok(SCHEDULE_TEXT_V1.foreground.includes(word), word);
});

test('the three one-sentence amendments differ from v1 in exactly the specified places', () => {
  const { authorization: a1, scope: s1 } = scheduleContractText('v1'), { authorization: a2, scope: s2 } = scheduleContractText('v2');
  assert.equal(a2, a1.replace('no keyword or new command is required.', 'no keyword or new command is required to register one. Amending an existing task\'s text needs the user\'s lasting request.'));
  assert.equal(s2, s1.replace('Create, amend, pause or cancel', 'Create, amend a task\'s text only for a lasting change the user asked for, pause or cancel'));
  assert.equal(schedulePolicyReason('v2'), SCHEDULE_TEXT_V1.policyReason.replace('without requiring a new user command.', 'without requiring a new user command to register one.').replace('Prefer updating an existing task over duplicating it.', 'Prefer updating an existing task over duplicating it, but only for a lasting change the user asked for: its task text is the standing instruction, not a log.'));
  for (const text of [a2, s2, schedulePolicyReason('v2')]) assert.doesNotMatch(text, cjk);
  assert.deepEqual(SCHEDULE_TEXT_V2.foreground, scheduleForegroundParagraph('v2'));
});
