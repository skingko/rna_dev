import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cliError, languageReady, say } from './cli-language.mjs';

// `rna effort …` (spec p1 effort §6): the internal-reasoning switches and the Stage B replay, through the live daemon
// (its configured credentials; nothing here reads a secrets file).
//   effort status                       setting, capture counts, replay status and the dry-run plan
//   effort capture on|off               capture routed internal calls (opt-in probe data, 14 days)
//   effort routing shadow               only record the JEV-chosen effort
//   effort routing route [--purposes decision,narrator]
//                                       send it for these purposes (default both; work, setup and compaction are never
//                                       routed by the setting: they have no replay or probe of their own yet)
//   effort replay --approved [--approve-more TOKENS] [--cases N] [--baseline N] [--narrator N] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait]
//                                       --approve-more records a further amount the user approved beyond the 2.5M
//   effort cancel                       stop a running replay (results so far are kept)
//   effort report <id> [--out FILE]     a finished replay's research report
export const EFFORT_USAGE = 'effort status | capture on|off | routing shadow | routing route [--purposes decision,narrator] | replay --approved [--approve-more TOKENS] [--cases N] [--baseline N] [--narrator N] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait] | cancel | report <id> [--out FILE]';
const ROUTABLE = ['decision', 'narrator'];
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
    if (!Object.hasOwn(spec, name) || Object.hasOwn(out, name)) fail(EFFORT_USAGE);
    if (spec[name] === 'flag') out[name] = true;
    else { const next = args[++index]; if (next === undefined) fail(`--${name} 需要一个值`, `--${name} needs a value`); out[name] = spec[name] === 'integer' ? Number(next) : next; if (spec[name] === 'integer' && !Number.isSafeInteger(out[name])) fail(`--${name} 必须是整数`, `--${name} must be an integer`); }
  }
  return out;
}
const query = values => { const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])); const text = params.toString(); return text ? `?${text}` : ''; };
export async function runEffortCommand(args, call, { wait = ms => new Promise(done => setTimeout(done, ms)), log = console.log, pollMs = 15000 } = {}) {
  const [action = 'status', ...rest] = args;
  if (action === 'status') {
    const configuration = await call('/configuration'), replay = await call('/v2/maintenance/effort-replay');
    return { setting: configuration.internalReasoning ?? null, replay };
  }
  if (action === 'capture') {
    const [value] = rest;
    if (rest.length !== 1 || !['on', 'off'].includes(value)) fail('effort capture on|off');
    const configuration = await call('/configuration', 'PATCH', { internalReasoning: { capture: value === 'on' } });
    return { setting: configuration.internalReasoning };
  }
  if (action === 'routing') {
    const parsed = parse(rest, { purposes: 'value' }), [value] = parsed.positional;
    if (parsed.positional.length !== 1 || !['shadow', 'route'].includes(value) || value === 'shadow' && parsed.purposes !== undefined) fail('effort routing shadow | routing route [--purposes decision,narrator]');
    const purposes = parsed.purposes === undefined ? undefined : parsed.purposes.split(',').map(item => item.trim()).filter(Boolean);
    if (purposes && (!purposes.length || purposes.some(item => !ROUTABLE.includes(item)))) fail(`--purposes 只能是 ${ROUTABLE.join('、')}（逗号分隔）`, `--purposes can only be ${ROUTABLE.join(', ')} (comma separated)`);
    const configuration = await call('/configuration', 'PATCH', { internalReasoning: { routing: value, ...(value === 'route' ? { purposes: purposes ?? ROUTABLE } : {}) } });
    const setting = configuration.internalReasoning;
    return { setting, routed: setting?.routing === 'route' ? setting.purposes ?? [] : [], recordedOnly: ['decision', 'narrator', 'work', 'setup', 'compaction'].filter(purpose => !(setting?.routing === 'route' && (setting.purposes ?? []).includes(purpose))) };
  }
  if (action === 'cancel') return call('/v2/maintenance/effort-replay/cancel', 'POST', {});
  if (action === 'report') {
    const parsed = parse(rest, { out: 'value' }), [id] = parsed.positional;
    if (!id || parsed.positional.length !== 1) fail('effort report <id> [--out FILE]');
    const report = await call(`/v2/maintenance/effort-replay/reports/${encodeURIComponent(id)}`);
    if (parsed.out) { writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' }); return { id, written: resolve(parsed.out) }; }
    return { id, markdown: report.markdown };
  }
  if (action === 'replay') {
    const parsed = parse(rest, { approved: 'flag', 'approve-more': 'integer', cases: 'integer', baseline: 'integer', narrator: 'integer', budget: 'integer', project: 'value', out: 'value', 'no-wait': 'flag' });
    if (parsed.positional.length) fail(EFFORT_USAGE);
    if (parsed['approve-more'] !== undefined && !parsed.approved) fail('--approve-more 只能与 --approved 一起使用', '--approve-more can only be used with --approved');
    const options = { ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}), ...(parsed.baseline !== undefined ? { baseline: parsed.baseline } : {}), ...(parsed.narrator !== undefined ? { narrator: parsed.narrator } : {}), ...(parsed.budget !== undefined ? { budgetTokens: parsed.budget } : {}), ...(parsed.project ? { projectId: parsed.project } : {}) };
    // The lines below are printed in the interface language, read from the daemon once (a plain-JSON reply needs none).
    await languageReady();
    // The dry run first: what would be replayed and its estimate (refused by the daemon above the approved budget).
    const preview = await call(`/v2/maintenance/effort-replay${query(options)}`);
    // A run in progress: the daemon skips the plan (and would refuse a second start).
    if (!preview.plan) fail(`已有回放在运行（${preview.job?.id ?? '未知'}）：用 ./rna effort status 查看，./rna effort cancel 中止。`, `A replay is already running (${preview.job?.id ?? 'unknown'}): check it with ./rna effort status, stop it with ./rna effort cancel.`);
    const approval = preview.plan.approval;
    log(say(`回放计划：${preview.plan.selected} 个决策、${preview.plan.narrator?.selected ?? 0} 条消息改写，${preview.plan.calls} 次主模型调用，估算 ${preview.plan.estimate} token（单次预算 ${preview.plan.options.budgetTokens}${approval ? `；已批准共 ${approval.approved}，此前回放已用 ${approval.spent}，剩余 ${approval.remaining}` : ''}${Number.isFinite(preview.plan.dailyRemaining) ? `；今日真实 token 限额剩余 ${preview.plan.dailyRemaining}` : ''}）。只验证 ${(preview.plan.covers ?? ROUTABLE).join('、')}。`, `Replay plan: ${preview.plan.selected} decisions, ${preview.plan.narrator?.selected ?? 0} message rewrites, ${preview.plan.calls} main-model calls, estimated ${preview.plan.estimate} tokens (per-run budget ${preview.plan.options.budgetTokens}${approval ? `; approved in total ${approval.approved}, already used by earlier replays ${approval.spent}, remaining ${approval.remaining}` : ''}${Number.isFinite(preview.plan.dailyRemaining) ? `; real tokens left under today's limit ${preview.plan.dailyRemaining}` : ''}). Verifies only ${(preview.plan.covers ?? ROUTABLE).join(', ')}.`));
    if (!parsed.approved) return { approved: false, plan: preview.plan, note: say('未开始：加 --approved 才会调用主模型（计费）。', 'Not started: add --approved to call the main model (billed).') };
    const job = await call('/v2/maintenance/effort-replay', 'POST', { approved: true, ...options, ...(parsed['approve-more'] !== undefined ? { approveMore: parsed['approve-more'] } : {}) });
    log(say(`已开始：${job.id}`, `Started: ${job.id}`));
    if (parsed['no-wait']) return { started: job.id };
    let status = job, report = null, missing = 0;
    while (true) {
      await wait(pollMs);
      const state = await call('/v2/maintenance/effort-replay');
      if (state.job?.id === job.id) { status = state.job; missing = 0; }
      else if ((state.reports ?? []).includes(job.id)) {
        // The daemon restarted (an update, a crash) or another run replaced this one: its report holds where it ended.
        report = await call(`/v2/maintenance/effort-replay/reports/${encodeURIComponent(job.id)}`);
        status = report.json ?? status; log(say(`${status.phase}：${status.done}/${status.calls} 次，已用 ${status.spentTokens} token（守护进程已不再运行它）`, `${status.phase}: ${status.done}/${status.calls} calls, ${status.spentTokens} tokens used (the daemon no longer runs it)`)); break;
      } else if (++missing >= MISSING_POLLS) fail(`回放 ${job.id} 已不在守护进程中，也没有报告（守护进程可能已重启）；用 ./rna effort status 查看，./rna effort report ${job.id} 取报告。`, `Replay ${job.id} is no longer in the daemon and has no report (the daemon may have restarted); check it with ./rna effort status, fetch the report with ./rna effort report ${job.id}.`);
      log(say(`${status.phase}：${status.done}/${status.calls} 次，已用 ${status.spentTokens} token`, `${status.phase}: ${status.done}/${status.calls} calls, ${status.spentTokens} tokens used`));
      if (status.phase !== 'running') break;
    }
    report ??= await call(`/v2/maintenance/effort-replay/reports/${encodeURIComponent(job.id)}`);
    if (parsed.out) writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' });
    return { id: job.id, phase: status.phase, spentTokens: status.spentTokens, gate: status.summary?.gate ?? null, narratorGate: status.summary?.narrator?.gate ?? null, ...(parsed.out ? { written: resolve(parsed.out) } : { markdown: report.markdown }) };
  }
  fail(EFFORT_USAGE);
}
