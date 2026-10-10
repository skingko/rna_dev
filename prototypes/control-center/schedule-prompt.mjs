// The texts that tell a model what a schedule's `task` is (design2 §7 W2). They exist in two versions behind one
// setting, `schedulePromptVersion` ('v1' | 'v2', default 'v1'), so a release that carries the new texts changes nothing
// until the paired replay (benchmark/schedule-text-replay.mjs, `./rna schedule-text replay`) has shown that the new
// texts do not stop the model from writing a lasting user rule into the schedule. One setting switches every text
// together: the foreground instruction paragraph, the `project_schedule` tool description and parameter descriptions,
// the planner's guidance (SDK initiative-schedule.mjs, passed through decideInitiative) and the three one-sentence
// amendments (the schedule action contract's authorization and scope, and the planner view's policy.reason).
//
// v1 is today's text, kept byte for byte (test/schedule-prompt-version.test.mjs pins each by hash). v2 is English like
// every model-visible text, with no interpolated state: it changes the cached prefix once, when the setting changes.
// Neither version removes an input the model reads; they only say what may be written into a task.
import { projectScheduleRuleSchema } from '../../packages/sdk/src/project-schedules.mjs';

export const SCHEDULE_PROMPT_VERSIONS = Object.freeze(['v1', 'v2']);
export const DEFAULT_SCHEDULE_PROMPT_VERSION = 'v1';
const KEY = 'schedulePromptVersion';
/** The version a configuration selects (anything but 'v2' is today's v1: an old or damaged value never changes a text). */
export const schedulePromptVersionOf = configuration => configuration?.[KEY] === 'v2' ? 'v2' : DEFAULT_SCHEDULE_PROMPT_VERSION;
/** The version at a call site that holds the store. */
export const schedulePromptVersionOfStore = store => schedulePromptVersionOf(store?.state?.configuration);
/** Validated settings input for ConfigurationService.update; throws a 400 naming the field. */
export function schedulePromptVersionInput(value) {
  if (!SCHEDULE_PROMPT_VERSIONS.includes(value)) throw Object.assign(new Error(`schedulePromptVersion 必须是 ${SCHEDULE_PROMPT_VERSIONS.join(' 或 ')}`), { status: 400 });
  return value;
}

// ---------------------------------------------------------------- v1: today's texts, verbatim
const FOREGROUND_V1 = '项目要求每日、每周或其他重复交付时，先用 project_schedule_list 检查真实日程；按已表达的需求用 project_schedule 保存规则与投递会话。只有宿主返回已保存及下次执行时间后才能承诺已安排。未指定具体时间可使用应用默认值并告知用户，可随时修改。用户交代的当前工作不是日程：在本轮内做完，不要改成定时任务，也不要让用户再说“继续”；只有真的需要用户的决定、信息或授权时才停下来问。';
const TOOL_DESCRIPTION_V1 = '按用户已表达的定期任务需求创建、修改或删除当前项目日程。先 list 避免重复。action=create 需 title/task/rule；update/delete 需 id。daily/weekly 必须指定 HH:mm 和 IANA timeZone；用户未指定时可采用 list 返回的应用默认09:00及本地时区，并明确告知默认值。默认投递此会话，不会向外部发送消息。用户仅需一次任务时不要创建周期日程。保存后如实说明下次执行与暂停状态，不能仅口头承诺已安排。执行仍受项目主动开关、权限、预算和静音控制。';
const POLICY_REASON_V1 = 'Choose and maintain useful commitments from project evidence, without requiring a new user command. Existing human edits and cancellations are constraints. Reuse the same purposeKey for the same responsibility, including cancelled responsibilities; do not evade a cancellation with a different name or key. Prefer updating an existing task over duplicating it. Immediate useful work and conversation do not need a schedule. Registered tasks have not yet been executed; worker permissions still apply.';
const AUTHORIZATION_V1 = 'Project initiative authorizes maintaining useful project intentions and schedules, not only responding to manual scheduler setup. Infer responsibilities from current project evidence; no keyword or new command is required.';
const SCOPE_V1 = 'Create, amend, pause or cancel persistent future/recurring work in this project. Preserve human overrides and existing purpose keys; use project.schedules (actual records) and scheduleContext.cancelled. Metadata changes never grant workspace execution permissions.';

// ---------------------------------------------------------------- v2: the new texts
const FOREGROUND_V2 = 'Recurring or later work. When the user asks for work every day or week, or at a later time, call project_schedule_list and save it with project_schedule, and promise it only after the host reports it saved with a next run time. If no time is given, use the application default and tell the user it can be changed. Work the user hands you now is not a schedule: finish it in this turn and do not ask the user to say "continue". A request made once never becomes part of an existing task. Stop and ask only when you need the user\'s decision, information or authorization.';
const TOOL_DESCRIPTION_V2 = [
  'Create, change or delete a project task that the host runs on a schedule (daily, weekly, every N minutes, or once). Call project_schedule_list first and change the matching task instead of adding another. create needs title, task and rule; update and delete need id.',
  '`task` is the standing instruction every run receives. Write only what holds on every run: what to produce, in what form, where it goes, the user\'s lasting rules. Leave out one-time requests, a fix to one day\'s output, what happened in earlier runs, steps for one date or for the next run only, progress, and anything the project\'s runbook, templates, validators or guards already say (the run reads those). Do not repeat the rule\'s time, time zone or frequency.',
  'When you change `task`, change only what the user\'s request touches and keep every other sentence as it is, unless the user asked you to rewrite it. Pass `basis`: the user\'s own words, copied exactly from one of their messages, that ask for this to apply from now on. Never write that the user decided something unless their words say so.',
  'Something the user asked for once: do it now and leave the task alone. Once at a later time: create a separate task with rule kind "once". With the next run only: add a project_plan item (status next) and mark it done afterwards. Unsure whether they want it every time: treat it as a request for now, and say in one sentence that you can make it standing.',
  'daily and weekly rules need HH:mm and an IANA timeZone; if the user gave none, use the application defaults from project_schedule_list (09:00 and the local time zone) and say so. Delivery is to this project\'s conversation, never an external channel. After saving, report the next run time and pause state from the result; do not call it scheduled before the host has saved it. Runs stay subject to the project\'s activity switch, permissions, budget and mute setting.'
].join('\n\n');
const TASK_PARAMETER_V2 = 'Standing instruction for every run (see the tool description). Not a log, not progress, and not a place for one-time requests.';
const BASIS_PARAMETER_V2 = 'When an update changes task: the user\'s own words, copied exactly from one of their messages, that ask for the change to apply to every future run.';
const REVISION_PARAMETER_V2 = 'Revision from project_schedule_list. The update fails if the schedule changed since.';
const POLICY_REASON_V2 = 'Choose and maintain useful commitments from project evidence, without requiring a new user command to register one. Existing human edits and cancellations are constraints. Reuse the same purposeKey for the same responsibility, including cancelled responsibilities; do not evade a cancellation with a different name or key. Prefer updating an existing task over duplicating it, but only for a lasting change the user asked for: its task text is the standing instruction, not a log. Immediate useful work and conversation do not need a schedule. Registered tasks have not yet been executed; worker permissions still apply.';
const AUTHORIZATION_V2 = 'Project initiative authorizes maintaining useful project intentions and schedules, not only responding to manual scheduler setup. Infer responsibilities from current project evidence; no keyword or new command is required to register one. Amending an existing task\'s text needs the user\'s lasting request.';
const SCOPE_V2 = 'Create, amend a task\'s text only for a lasting change the user asked for, pause or cancel persistent future/recurring work in this project. Preserve human overrides and existing purpose keys; use project.schedules (actual records) and scheduleContext.cancelled. Metadata changes never grant workspace execution permissions.';

const pick = (table, version) => table[version === 'v2' ? 'v2' : 'v1'];
/** The foreground system-prompt paragraph about recurring or later work (rna-runtime capabilityInstructions). */
export const scheduleForegroundParagraph = version => pick({ v1: FOREGROUND_V1, v2: FOREGROUND_V2 }, version);
export const scheduleToolDescription = version => pick({ v1: TOOL_DESCRIPTION_V1, v2: TOOL_DESCRIPTION_V2 }, version);
/** `project_schedule`'s parameters. v1 declares what it always did; v2 adds the three descriptions, with the optional
 * `basis` and `expectedRevision` (the host accepts both under either version and ignores what it does not declare). */
export function scheduleToolParameters(version, rule = projectScheduleRuleSchema) {
  const properties = { action: { enum: ['create', 'update', 'delete'] }, id: { type: 'string', minLength: 1, maxLength: 120 }, title: { type: 'string', minLength: 1, maxLength: 160 }, task: { type: 'string', minLength: 1, maxLength: 6000 }, rule, destinationSessionId: { type: 'string', minLength: 1, maxLength: 120 }, enabled: { type: 'boolean' } };
  if (version === 'v2') {
    properties.task = { ...properties.task, description: TASK_PARAMETER_V2 };
    properties.basis = { type: 'string', minLength: 1, maxLength: 1000, description: BASIS_PARAMETER_V2 };
    properties.expectedRevision = { type: 'integer', minimum: 1, description: REVISION_PARAMETER_V2 };
  }
  return { type: 'object', additionalProperties: false, required: ['action'], properties };
}
/** The schedule action contract's authorization and scope (project-initiative-controller actionContracts.schedule). */
export const scheduleContractText = version => version === 'v2' ? { authorization: AUTHORIZATION_V2, scope: SCOPE_V2 } : { authorization: AUTHORIZATION_V1, scope: SCOPE_V1 };
/** The planner view's policy.reason (ProjectScheduleService.agentView). */
export const schedulePolicyReason = version => pick({ v1: POLICY_REASON_V1, v2: POLICY_REASON_V2 }, version);
/** The v1 texts, for the pin test (test/schedule-prompt-version.test.mjs). */
export const SCHEDULE_TEXT_V1 = Object.freeze({ foreground: FOREGROUND_V1, toolDescription: TOOL_DESCRIPTION_V1, policyReason: POLICY_REASON_V1, authorization: AUTHORIZATION_V1, scope: SCOPE_V1 });
/** The v2 texts (the replay swaps one version's paragraph and declaration for the other's). */
export const SCHEDULE_TEXT_V2 = Object.freeze({ foreground: FOREGROUND_V2, toolDescription: TOOL_DESCRIPTION_V2, policyReason: POLICY_REASON_V2, authorization: AUTHORIZATION_V2, scope: SCOPE_V2 });
