#!/usr/bin/env node
// D2 labelled probe for `work.completion` (docs/research/jev-work-completion-probe-20261005.md): the option-B completion gate
// asks three literal questions of the handoff a finished background run left (reports_untold, names_next_step,
// evidence_relevant). Two sets, both built with the production state builder and template and judged with the production
// combine function and thresholds:
//   real       — every finished, non-scheduled work run a COPY of live state holds (RNA_STATE, never the live file: copy
//                state.json and state.json.d, no secrets). The state is rebuilt as the gate would have seen it just after
//                the run: its handoff, and what the user had been told by then (proactive messages, the run's own work
//                line). Foreground replies are left out on purpose (private conversation text): the probe reads only the
//                host's own records. Labels come from C2's work-outcome view (work-completion.mjs completionLabel), never
//                from what the model chose: told (a message citing the run reached the user), followedWork (the decision
//                that followed the run admitted a work action: decisionFollowUps), productive (told, or the action that
//                decision admitted became visible). `labelCitation` reads the actions that merely cite the completion
//                instead, for comparison (the model cites the newest events whatever they are).
//   synthetic  — hand-labelled handoffs, Chinese and English, with the three expectations by construction (the outcome
//                labels are noisy for the question itself: a run can have something untold that the model chose not to share).
// Each call asks the live daemon's JEV probe (POST /api/v2/decision-kernel/probe: one raw call with the app's configured key,
// no thresholds, cache or ledger).
// Usage: RNA_STATE=<copy>/state.json node benchmark/work-completion-probe.mjs [--real] [--synthetic] [--out results.json]
//        (RNA_URL, default http://127.0.0.1:4317). Prints metadata only (ids cut to 8 characters, lengths, probabilities): no
//        project text.
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { workCompletionTemplate, combineWorkCompletion, stakeVerdict, stakeThreshold, WORK_COMPLETION_QUESTIONS } from '../../../packages/sdk/src/decision-templates.mjs';
import { recentReportRows } from '../decision-service.mjs';
import { completionFacts, completionLabel, followUpsOf } from '../work-completion.mjs';
import { outcomeFacts, actionOutcome } from '../work-outcome.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;

const NOVEL = { title: '长篇小说《雾港》', goal: '写完并修订 30 章，人物和时间线前后一致' };
const CODE = { title: 'Billing service', goal: 'Keep the invoice API correct and its tests green' };
const msg = text => `[proactive message] ${text}`, line = text => `[background work line] ${text}`, reply = text => `[foreground reply] ${text}`;

/**
 * `expect`: { untold, next, relevant } by construction (`null`: ambiguous, not scored). `reports`: what the user was told,
 * oldest first, in the rows the host builds (recentReportRows).
 */
export const CASES = [
  // --- a problem, a failure or a question nobody has stated
  { id: 'en-failing-tests', project: CODE, handoff: 'Failed: tax.spec.ts has 3 failing tests after the rounding change in src/tax.js; the change is still in place. Next: decide whether to revert it.', reports: [reply('Added the CSV export for invoices.')], expect: { untold: true, next: false, relevant: true } },
  { id: 'zh-broken-link-question', project: NOVEL, handoff: '已完成：检查第二章；第 14 行链接指向的 notes/harbor.md 已被删除，没有修复；需要你确认是否恢复这个文件。', reports: [], expect: { untold: true, next: false, relevant: true } },
  { id: 'en-question-for-user', project: CODE, handoff: 'Done: migrated 12 invoices. Question: should the 3 invoices with no tax code be skipped or given the default code?', reports: [line('Background work changed 2 files: scripts/migrate.js, data/invoices.json. Migrated 12 invoices.')], expect: { untold: true, next: false, relevant: true } },
  { id: 'zh-timeout-failure', project: NOVEL, handoff: '未完成：检查第七章时模型服务超时，没有结果；需要重新跑一遍。', reports: [], expect: { untold: true, next: true, relevant: true } },
  { id: 'en-new-finding', project: CODE, handoff: 'Found that POST /invoices returns a 500 when an invoice has no line items: totals.js reduces over null. Not fixed.', reports: [msg('The /refunds endpoint accepts negative amounts; there is no validation.')], expect: { untold: true, next: null, relevant: true } },
  { id: 'zh-new-contradiction', project: NOVEL, handoff: '核对第三章：第 3 节写周二、第 5 节写周一，两处时间线矛盾，没有改动。', reports: [reply('第四章开头两节写好了。')], expect: { untold: true, next: null, relevant: true } },
  // --- the same things, already told
  { id: 'en-fixed-and-told', project: CODE, handoff: 'Fixed rounding in src/tax.js (half-up for 0.005 amounts); tax.spec.ts passes. Nothing left.', reports: [line('Background work changed 1 file: src/tax.js\n\nFixed rounding of 0.005 amounts (half-up); tax.spec.ts passes.')], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-fixed-and-told', project: NOVEL, handoff: '修改了 chapter2.md：修复 2 处失效链接（第 14、37 行），其余链接正常。没有后续步骤。', reports: [line('后台改了 1 个文件：chapter2.md\n\n修复了第二章 2 处失效链接（第 14、37 行），其余链接正常。')], expect: { untold: false, next: false, relevant: true } },
  { id: 'en-finding-already-sent', project: CODE, handoff: 'Found that the /refunds endpoint accepts negative amounts. Not fixed.', reports: [msg('The /refunds endpoint accepts negative amounts; there is no validation.')], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-finding-paraphrased', project: NOVEL, handoff: '第三章时间线矛盾：第 3 节写周二，第 5 节写周一。没有改动。', reports: [msg('第三章有两处时间线矛盾：第 3 节写的是周二，第 5 节写的是周一，中间只隔了一夜。')], expect: { untold: false, next: false, relevant: true } },
  { id: 'en-failure-already-sent', project: CODE, handoff: 'Failed: the staging deploy script exited with code 2 (missing AWS profile). Nothing else was changed.', reports: [msg('The staging deploy failed: the AWS profile is missing on this machine.')], expect: { untold: false, next: null, relevant: true } },
  // --- nothing to report
  { id: 'en-nothing-found', project: CODE, handoff: 'Checked all 14 endpoints against the OpenAPI file; no differences found. Nothing left.', reports: [], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-nothing-found', project: NOVEL, handoff: '核对了 7 个来源，全部能找到原文，没有问题。', reports: [], expect: { untold: false, next: false, relevant: true } },
  { id: 'en-routine-done', project: CODE, handoff: 'Done: added the CSV export for invoices (src/export.js, 2 tests). Nothing left.', reports: [reply('Started on the CSV export.')], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-routine-done', project: NOVEL, handoff: '已完成：把第六章的结尾改成开放式。没有后续步骤。', reports: [], expect: { untold: false, next: false, relevant: true } },
  // --- a further step that needs nothing from the user
  { id: 'en-next-run-tests', project: CODE, handoff: 'Done: wrote the tests for invoices.js. Next: run them against the staging copy.', reports: [], expect: { untold: false, next: true, relevant: true } },
  { id: 'zh-next-chapter', project: NOVEL, handoff: '已写完第三章。下一步：写第四章开头两节。', reports: [], expect: { untold: false, next: true, relevant: true } },
  { id: 'en-next-pin-tz', project: CODE, handoff: 'Fixed 2 of 5 flaky tests; the other 3 depend on the machine time zone. Next: pin TZ in the CI config.', reports: [], expect: { untold: true, next: true, relevant: true } },
  { id: 'zh-next-remaining', project: NOVEL, handoff: '完成了资料整理，还剩第五、六章的核对，接着做。', reports: [], expect: { untold: false, next: true, relevant: true } },
  { id: 'en-next-with-line', project: CODE, handoff: 'Refactored totals.js to use the shared rounding helper. Next: update the 6 callers in src/reports.', reports: [line('Background work changed 1 file: src/totals.js\n\nRefactored totals.js to use the shared rounding helper.')], expect: { untold: false, next: true, relevant: true } },
  // --- a further step that waits for the user
  { id: 'en-next-needs-user', project: CODE, handoff: 'Done: drafted the migration. Next: waiting for your decision on whether to drop the legacy table.', reports: [], expect: { untold: true, next: false, relevant: true } },
  { id: 'zh-next-needs-user', project: NOVEL, handoff: '已完成：对比了两种写法。接下来取决于你选哪一种。', reports: [], expect: { untold: true, next: false, relevant: true } },
  { id: 'en-no-step', project: CODE, handoff: 'Done: updated the README deployment section. No further steps.', reports: [], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-no-step', project: NOVEL, handoff: '已完成：整理了参考资料。没有后续步骤。', reports: [], expect: { untold: false, next: false, relevant: true } },
  // --- a further step that cannot start now: it waits for a scheduled time, another session or the user's review
  { id: 'zh-next-waits-schedule', project: NOVEL, handoff: '已完成：核对第二章。下一步：等明天 09:00 的日程触发后按既定口径汇报。', reports: [], expect: { untold: false, next: false, relevant: true } },
  { id: 'en-next-waits-nightly', project: CODE, handoff: 'Done: audited the config. Next: the nightly job runs at 02:00 and will pick this up.', reports: [], expect: { untold: false, next: false, relevant: true } },
  { id: 'zh-next-foreground', project: NOVEL, handoff: '已完成资料整理；下一步由前台对话继续写第四章。', reports: [], expect: { untold: false, next: null, relevant: true } },
  { id: 'zh-next-waits-review', project: NOVEL, handoff: '30 章审计完成，7 处缺陷已修；下一步等用户审阅 30 章，无指令不开第 31 章。', reports: [], expect: { untold: null, next: false, relevant: true } },
  { id: 'zh-next-do-now', project: NOVEL, handoff: '第三章已写完；下一步：立即核对第三章与第一章的年龄设定是否一致。', reports: [], expect: { untold: false, next: true, relevant: true } },
  // --- off the project goal
  { id: 'en-off-goal', project: CODE, handoff: 'Renamed the holiday photos folder and compressed the images. Nothing left.', reports: [], expect: { untold: false, next: false, relevant: false } },
  { id: 'zh-off-goal', project: NOVEL, handoff: '整理了桌面壁纸并更新了系统字体。没有后续步骤。', reports: [], expect: { untold: false, next: false, relevant: false } },
  // --- harder: wording that tempts a wrong answer
  { id: 'en-hard-optional-later', project: CODE, handoff: 'Done: pinned the lint version. Optionally re-run the full suite after the next release.', reports: [], expect: { untold: false, next: null, relevant: true } },
  { id: 'zh-hard-next-in-line', project: NOVEL, handoff: '已改好第二章的称呼。下一步：第三章的称呼也要统一。', reports: [line('后台改了 1 个文件：chapter2.md\n\n统一了第二章的人物称呼。')], expect: { untold: null, next: true, relevant: true } },
  { id: 'en-hard-told-in-reply', project: CODE, handoff: 'Found that totals.js reduces over null for an invoice with no line items. Not fixed.', reports: [reply('The invoice with no line items fails in totals.js because it reduces over null; I have not fixed it yet.')], expect: { untold: false, next: null, relevant: true } },
  { id: 'zh-hard-risk-note', project: NOVEL, handoff: '已完成：重写第三章开头。注意：新开头与第一章的年龄设定可能冲突，需要你看一眼。', reports: [], expect: { untold: true, next: false, relevant: true } },
];

const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
const kernelAnswers = raw => Object.fromEntries(Object.entries(raw ?? {}).map(([id, answer]) => [id, { type: 'boolean', probability: answer.noul }]));
async function ask(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
/** The state the host sends for a completion (DecisionService.completionState builds the same one), minimized as the kernel does. */
export function completionState({ handoff, reports, project }) {
  const state = buildDecisionState('work.completion', { handoff, recentReports: reports, project: { title: project.title, goal: project.goal } });
  return minimizeDecisionState(state, { maxChars: deriveDecisionPolicy('work.completion').maxStateChars, knownSecrets: [] });
}
async function judge(spec) {
  const questions = wire(workCompletionTemplate()), body = await ask(completionState(spec), questions), answers = kernelAnswers(body.answers);
  return { answers, probabilities: Object.fromEntries(WORK_COMPLETION_QUESTIONS.map(id => [id, round(answers[id]?.probability)])), verdict: combineWorkCompletion(answers), inputTokens: body.usage?.input_tokens ?? 0, latencyMs: body.latencyMs };
}

// ---------------------------------------------------------------------- the real set
const MIN = 60000;
/**
 * The review a completion woke, rebuilt from the project's own decision records for a copy that has no wake log (0.68.0 kept only
 * the last 50 wake rows): the first accepted decision after the run ended (`project.decisions`, kept 200). A wait admitted
 * nothing; any other action is the SDK action created at that instant. In production the wake row says the same
 * (`wake.actionId`, work-completion.mjs reviewFollowUps). null: no decision since, or the action is no longer held.
 */
export function decisionFollowUps(project, action, facts, now) {
  const next = (project.decisions ?? []).filter(row => Number.isFinite(Date.parse(row.at)) && Date.parse(row.at) > action.finishedAt).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!next) return { reviewed: false, followUps: [] };
  if (next.action === 'wait') return { reviewed: true, followUps: [] };
  const at = Date.parse(next.at), made = (project.initiativeRuntime?.sdkState?.actions ?? []).find(row => !row.hostSchedule && row.action === next.action && Number.isFinite(row.createdAt) && Math.abs(row.createdAt - at) <= 2 * MIN);
  if (!made) return { reviewed: true, followUps: null };
  const record = actionOutcome(project, made.id, now, { facts });
  return { reviewed: true, followUps: [{ id: made.id, kind: made.action, outcome: record?.outcome ?? 'pending', ...(record?.neutral ? { neutral: true } : {}) }] };
}
/** The state a completion would have been judged on just after the run ended, from the host's own records (no conversation replies). */
export function realSpecs(state, now = Date.now()) {
  const specs = [];
  for (const project of state.projects ?? []) {
    if (project.simulated) continue;
    const sessions = (state.sessions ?? []).filter(row => row.projectId === project.id && row.kind !== 'side'), facts = outcomeFacts(project, sessions, { state, now });
    const lines = sessions.flatMap(session => (session.items ?? []).filter(item => item.initiative?.backgroundWork && !['running', 'paused'].includes(item.initiative.backgroundWork.status) && String(item.text ?? '').trim()));
    const inbox = (project.inbox ?? []).filter(row => !row.contextRevoked);
    for (const action of project.initiativeRuntime?.sdkState?.actions ?? []) {
      if (action.action !== 'work' || action.status !== 'completed' || action.hostSchedule || !Number.isFinite(action.finishedAt)) continue;
      const known = completionFacts(project, action);
      const at = action.finishedAt, early = value => { const time = Date.parse(value); return Number.isFinite(time) && time <= at + 5 * MIN; };
      const reports = recentReportRows({ inbox: inbox.filter(row => early(row.createdAt)).slice(-3), lines: lines.filter(item => early(item.updatedAt ?? item.createdAt)), finals: [] });
      const record = actionOutcome(project, action.id, now, { facts }), cited = followUpsOf(project, action.id, facts, now), woke = decisionFollowUps(project, action, facts, now);
      // The label is the review the completion woke (its decision's own action); the actions that merely cite it are kept as `labelCitation`
      // (the model cites the newest events whatever they are, so a chain of work cites each run in turn).
      const label = woke.followUps === null ? { label: 'pending', told: false, followedWork: false, followedVisible: false } : completionLabel({ run: record, followUps: woke.followUps, reviewed: woke.reviewed });
      specs.push({ project: project.id.slice(0, 8), id: action.id.slice(0, 8), class: known.class, change: known.change, handoffLength: known.handoff.length, reports: reports.length, spec: { handoff: known.handoff, reports, project: { title: project.name, goal: project.description } },
        label, labelCitation: completionLabel({ run: record, followUps: cited, reviewed: woke.reviewed }).label, run: record ? { outcome: record.outcome, reason: record.reason } : null, followUps: (woke.followUps ?? []).map(item => `${item.kind}:${item.outcome}`) });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------- reading the results
const stats = values => { const sorted = [...values].sort((a, b) => a - b), at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null; return { n: sorted.length, min: round(sorted[0] ?? null), p10: round(at(.1)), p50: round(at(.5)), p90: round(at(.9)), max: round(sorted.at(-1) ?? null) }; };
/**
 * One question at each stake tier (and a plain 0.5 line): how a confident verdict compares with the truth. `positive` is the
 * truth the question names (untold, a next step); `yes` right = verdict true on a positive, `no` right = verdict false on a
 * negative. A confident `no` on a positive is the error a skip is built on: the number to keep at zero.
 */
export function readQuestion(rows, id, truthOf) {
  const set = rows.filter(row => typeof truthOf(row) === 'boolean' && Number.isFinite(row.probabilities?.[id]));
  const out = { n: set.length, positives: stats(set.filter(row => truthOf(row)).map(row => row.probabilities[id])), negatives: stats(set.filter(row => !truthOf(row)).map(row => row.probabilities[id])), tiers: {} };
  for (const tier of ['floor', 'low', 'medium', 'high']) {
    const cell = { threshold: stakeThreshold(tier), yesOnPositive: 0, noOnPositive: 0, undecidedOnPositive: 0, yesOnNegative: 0, noOnNegative: 0, undecidedOnNegative: 0 };
    for (const row of set) {
      const verdict = stakeVerdict({ type: 'boolean', probability: row.probabilities[id] }, tier), positive = truthOf(row);
      cell[`${verdict === true ? 'yes' : verdict === false ? 'no' : 'undecided'}On${positive ? 'Positive' : 'Negative'}`]++;
    }
    out.tiers[tier] = cell;
  }
  return out;
}
export const summarize = (rows, truth) => Object.fromEntries(WORK_COMPLETION_QUESTIONS.filter(id => truth[id]).map(id => [id, readQuestion(rows, id, truth[id])]));
/** The combined route at the shipped thresholds against the label: what a skip would lose and what it would save. */
export function readRoute(rows, productive) {
  const out = { review: { productive: 0, notProductive: 0 }, defer: { productive: 0, notProductive: 0 }, reasons: {} };
  for (const row of rows) {
    const verdict = row.verdict, label = productive(row); if (typeof label !== 'boolean') continue;
    out[verdict.route][label ? 'productive' : 'notProductive']++; out.reasons[verdict.reason] = (out.reasons[verdict.reason] ?? 0) + 1;
  }
  return out;
}

export async function run({ real = true, synthetic = true, stateFile = process.env.RNA_STATE } = {}) {
  const result = { at: new Date().toISOString(), base: BASE, calls: 0, inputTokens: 0 };
  if (synthetic) {
    const rows = [];
    for (const row of CASES) { const judged = await judge({ handoff: row.handoff, reports: row.reports, project: row.project }); result.calls++; result.inputTokens += judged.inputTokens; rows.push({ id: row.id, expect: row.expect, ...judged }); }
    const truth = { reports_untold: row => row.expect.untold ?? undefined, names_next_step: row => row.expect.next ?? undefined, evidence_relevant: row => row.expect.relevant ?? undefined };
    result.synthetic = { rows, questions: summarize(rows, truth), route: readRoute(rows, row => row.expect.untold === true || row.expect.next === true) };
  }
  if (real) {
    if (!stateFile) throw new Error('RNA_STATE: a copy of state.json (never the live file)');
    const loaded = readStateFile(stateFile);
    if (!loaded) throw new Error(`no state at ${stateFile}`);
    const specs = realSpecs(loaded.state), rows = [], classes = {};
    for (const spec of specs) {
      classes[spec.class] = (classes[spec.class] ?? 0) + 1;
      if (!['judge', 'resolves_pending'].includes(spec.class)) continue;
      const judged = await judge(spec.spec); result.calls++; result.inputTokens += judged.inputTokens;
      const { spec: _spec, ...meta } = spec; rows.push({ ...meta, ...judged });
    }
    const settled = rows.filter(row => row.label.label !== 'unreviewed' && row.label.label !== 'pending');
    const truth = { reports_untold: row => row.label.label === 'unreviewed' ? undefined : row.label.told, names_next_step: row => row.label.label === 'unreviewed' ? undefined : row.label.followedWork, evidence_relevant: row => row.label.label === 'productive' };
    result.real = { classes, rows, settled: settled.length, questions: summarize(settled, truth), route: readRoute(settled, row => row.label.label === 'productive'), routeJudgeOnly: readRoute(settled.filter(row => row.class === 'judge'), row => row.label.label === 'productive') };
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const only = process.argv.includes('--real') ? { synthetic: false } : process.argv.includes('--synthetic') ? { real: false } : {};
  const result = await run(only), out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  const view = { ...result, ...(result.real ? { real: { ...result.real, rows: undefined } } : {}), ...(result.synthetic ? { synthetic: { ...result.synthetic, rows: undefined } } : {}) };
  console.log(JSON.stringify(view, null, 2));
}
