import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cliError, languageReady, say } from './cli-language.mjs';

// `rna schedule-text …` (design2 §7 W2): the version of the texts that tell a model what a schedule's task is, and the paired
// replay that must pass before v2 may be the default, through the live daemon (its configured credentials; nothing here
// reads a secrets file).
//   schedule-text status                the setting, the replay's status and approval, and the dry-run plan
//   schedule-text version [v1|v2]       show, or set, schedulePromptVersion (v1 today's texts; v2 the W2 texts)
//   schedule-text replay [--approved] [--approve-more TOKENS] [--foreground N] [--planner N] [--baseline all|effect] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait]
//                                       without --approved: the plan only (cases, estimated tokens, what is left of the approval).
//                                       --baseline effect: a lasting request only under v2 (about 30% cheaper; default all = every case under both)
//                                       --approve-more: a further amount the user approved; what is approved and unspent plus it is the run's
//                                       budget, at most 8,000,000 (the daemon refuses more), and the plan fills 90% of that budget
//   schedule-text cancel                stop a running replay (results so far are kept)
//   schedule-text report <id> [--out FILE]   a replay's research report
export const SCHEDULE_TEXT_USAGE = 'schedule-text status | version [v1|v2] | replay [--approved] [--approve-more TOKENS] [--foreground N] [--planner N] [--baseline all|effect] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait] | cancel | report <id> [--out FILE]';
const ROUTE = '/v2/maintenance/schedule-text-replay';
/** Polls in a row that may miss the job before giving up (a daemon restart lost it and left no report). */
const MISSING_POLLS = 4;
// A CLI-side error: the Chinese line, and its English variant (the usage lines are English already, so one string serves both).
const fail = (zh, en = zh) => { throw cliError(zh, en); };
function parse(args, spec) {
  const out = { positional: [] };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { out.positional.push(value); continue; }
    const name = value.slice(2);
    if (!Object.hasOwn(spec, name) || Object.hasOwn(out, name)) fail(SCHEDULE_TEXT_USAGE);
    if (spec[name] === 'flag') out[name] = true;
    else { const next = args[++index]; if (next === undefined) fail(`--${name} 需要一个值`, `--${name} needs a value`); out[name] = spec[name] === 'integer' ? Number(next) : next; if (spec[name] === 'integer' && !Number.isSafeInteger(out[name])) fail(`--${name} 必须是整数`, `--${name} must be an integer`); }
  }
  return out;
}
const query = values => { const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])); const text = params.toString(); return text ? `?${text}` : ''; };
const caseLine = row => `  ${row.id.padEnd(8)} rev ${String(row.rev).padEnd(2)} ${row.label.padEnd(10)} ${row.status === 'selected' ? say(`回放，估算 ${row.estimate}`, `Replay, estimated ${row.estimate}`) : row.status === 'deferred' ? say(`暂缓（预算放不下，估算 ${row.estimate ?? '?'}）`, `Deferred (does not fit the budget, estimated ${row.estimate ?? '?'})`) : say(`无法回放：${row.reason}`, `Cannot replay: ${row.reason}`)}${row.informational ? say('（仅供参考）', ' (for reference only)') : ''}`;
export async function runScheduleTextCommand(args, call, { wait = ms => new Promise(done => setTimeout(done, ms)), log = console.log, pollMs = 15000 } = {}) {
  const [action = 'status', ...rest] = args;
  if (action === 'status') {
    if (rest.length) fail(SCHEDULE_TEXT_USAGE);
    const configuration = await call('/configuration'), replay = await call(ROUTE);
    return { schedulePromptVersion: configuration.schedulePromptVersion ?? 'v1', replay };
  }
  if (action === 'version') {
    if (rest.length > 1 || rest.length === 1 && !['v1', 'v2'].includes(rest[0])) fail('schedule-text version [v1|v2]');
    const configuration = rest.length ? await call('/configuration', 'PATCH', { schedulePromptVersion: rest[0] }) : await call('/configuration');
    return { schedulePromptVersion: configuration.schedulePromptVersion ?? 'v1' };
  }
  if (action === 'cancel') { if (rest.length) fail(SCHEDULE_TEXT_USAGE); return call(`${ROUTE}/cancel`, 'POST', {}); }
  if (action === 'report') {
    const parsed = parse(rest, { out: 'value' }), [id] = parsed.positional;
    if (!id || parsed.positional.length !== 1) fail('schedule-text report <id> [--out FILE]');
    const report = await call(`${ROUTE}/reports/${encodeURIComponent(id)}`);
    if (parsed.out) { writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' }); return { id, written: resolve(parsed.out) }; }
    return { id, markdown: report.markdown };
  }
  if (action === 'replay') {
    const parsed = parse(rest, { approved: 'flag', 'approve-more': 'integer', foreground: 'integer', planner: 'integer', baseline: 'value', budget: 'integer', project: 'value', out: 'value', 'no-wait': 'flag' });
    if (parsed.baseline !== undefined && !['all', 'effect'].includes(parsed.baseline)) fail('--baseline 只能是 all 或 effect', '--baseline must be all or effect');
    if (parsed.positional.length) fail(SCHEDULE_TEXT_USAGE);
    if (parsed['approve-more'] !== undefined && !parsed.approved) fail('--approve-more 只能与 --approved 一起使用', '--approve-more can only be used with --approved');
    const options = { ...(parsed.foreground !== undefined ? { foreground: parsed.foreground } : {}), ...(parsed.planner !== undefined ? { planner: parsed.planner } : {}), ...(parsed.baseline !== undefined ? { baseline: parsed.baseline } : {}), ...(parsed.budget !== undefined ? { budgetTokens: parsed.budget } : {}), ...(parsed.project ? { projectId: parsed.project } : {}) };
    // The lines below are printed in the interface language, read from the daemon once (a plain-JSON reply needs none).
    await languageReady();
    // The plan first: which cases, under both versions, and the estimate (the daemon refuses a start above the approved budget).
    const preview = await call(`${ROUTE}${query({ ...options, ...(parsed['approve-more'] !== undefined ? { approveMore: parsed['approve-more'] } : {}) })}`);
    if (!preview.plan) fail(`已有回放在运行（${preview.job?.id ?? '未知'}）：用 ./rna schedule-text status 查看，./rna schedule-text cancel 中止。`, `A replay is already running (${preview.job?.id ?? 'unknown'}): check it with ./rna schedule-text status, stop it with ./rna schedule-text cancel.`);
    const plan = preview.plan, approval = plan.approval;
    log(say(`回放计划：${plan.selected} 个案例，每个在 v1 与 v2 两套文本下各发 1 次请求，共 ${plan.calls} 次主模型请求，估算 ${plan.estimate} token（单次预算 ${plan.options.budgetTokens}${approval ? `；已批准共 ${approval.approved}，此前回放已用 ${approval.spent}，剩余 ${approval.remaining}` : ''}${Number.isFinite(plan.dailyRemaining) ? `；今日真实 token 限额剩余 ${plan.dailyRemaining}` : ''}）。`, `Replay plan: ${plan.selected} cases, each sends 1 request under each of the v1 and v2 texts, ${plan.calls} main-model requests in total, estimated ${plan.estimate} tokens (per-run budget ${plan.options.budgetTokens}${approval ? `; approved in total ${approval.approved}, already used by earlier replays ${approval.spent}, remaining ${approval.remaining}` : ''}${Number.isFinite(plan.dailyRemaining) ? `; real tokens left under today's limit ${plan.dailyRemaining}` : ''}).`));
    for (const row of plan.cases ?? []) log(caseLine(row));
    // The gate needs every lasting and one-off case under both versions: what that costs, and whether this plan reaches it.
    if (plan.required) log(plan.required.covered ? say(`必需案例（持久要求与一次性）${plan.required.cases.length} 个，估算共 ${plan.required.estimate} token：本计划全部覆盖。`, `Required cases (lasting requests and one-off) ${plan.required.cases.length}, estimated ${plan.required.estimate} tokens in total: this plan covers all of them.`) : say(`必需案例（持久要求与一次性）${plan.required.cases.length} 个，估算共 ${plan.required.estimate} token：本计划没有全部覆盖，门槛不会通过；需要更多额度时由用户批准后加 --approve-more <token 数>（不加 --budget 则本次预算为已批准且未花的全部；未花的额度加它至多 8000000，计划只填满预算的九成，估算 N 的计划需要预算至少 N / 0.9）。`, `Required cases (lasting requests and one-off) ${plan.required.cases.length}, estimated ${plan.required.estimate} tokens in total: this plan does not cover all of them, so the gate will not pass; when more budget is needed, the user approves it and you add --approve-more <tokens> (without --budget this run's budget is everything approved and unspent; unspent plus it is at most 8000000, and the plan fills only nine tenths of the budget, so a plan estimated at N needs a budget of at least N / 0.9).`));
    if (plan.required?.missing?.length) log(say(`状态里找不到必需案例的记录：rev ${plan.required.missing.join('、')}。`, `No record of the required cases was found in the state: rev ${plan.required.missing.join(', ')}.`));
    if (!parsed.approved) return { approved: false, plan, note: say('未开始：加 --approved 才会调用主模型（计费）。', 'Not started: add --approved to call the main model (billed).') };
    const job = await call(ROUTE, 'POST', { approved: true, ...options, ...(parsed['approve-more'] !== undefined ? { approveMore: parsed['approve-more'] } : {}) });
    log(say(`已开始：${job.id}`, `Started: ${job.id}`));
    if (parsed['no-wait']) return { started: job.id };
    let status = job, report = null, missing = 0;
    while (true) {
      await wait(pollMs);
      const state = await call(ROUTE);
      if (state.job?.id === job.id) { status = state.job; missing = 0; }
      else if ((state.reports ?? []).includes(job.id)) {
        // The daemon restarted (an update, a crash) or another run replaced this one: its report holds where it ended.
        report = await call(`${ROUTE}/reports/${encodeURIComponent(job.id)}`);
        status = report.json ?? status; log(say(`${status.phase}：${status.done}/${status.calls} 次请求，已用 ${status.spentTokens} token（守护进程已不再运行它）`, `${status.phase}: ${status.done}/${status.calls} requests, ${status.spentTokens} tokens used (the daemon no longer runs it)`)); break;
      } else if (++missing >= MISSING_POLLS) fail(`回放 ${job.id} 已不在守护进程中，也没有报告（守护进程可能已重启）；用 ./rna schedule-text status 查看，./rna schedule-text report ${job.id} 取报告。`, `Replay ${job.id} is no longer in the daemon and has no report (the daemon may have restarted); check it with ./rna schedule-text status, fetch the report with ./rna schedule-text report ${job.id}.`);
      log(say(`${status.phase}：${status.done}/${status.calls} 次请求，已用 ${status.spentTokens} token`, `${status.phase}: ${status.done}/${status.calls} requests, ${status.spentTokens} tokens used`));
      if (status.phase !== 'running') break;
    }
    report ??= await call(`${ROUTE}/reports/${encodeURIComponent(job.id)}`);
    if (parsed.out) writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' });
    const summary = report.json?.summary ?? status.summary ?? null;
    return { id: job.id, phase: status.phase, spentTokens: status.spentTokens, gate: summary ? { pass: summary.pass, safe: summary.safe, effectDemonstrated: summary.effectDemonstrated, complete: summary.complete, reasons: summary.reasons, durable: summary.durable, oneOff: summary.oneOff, mechanical: summary.mechanical } : null, ...(parsed.out ? { written: resolve(parsed.out) } : { markdown: report.markdown }) };
  }
  fail(SCHEDULE_TEXT_USAGE);
}
