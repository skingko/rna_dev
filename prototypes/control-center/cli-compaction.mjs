import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cliError, languageReady, say } from './cli-language.mjs';

// `rna compaction …` (plan C5 / TC-6): the user-approved paid GLM compaction-fork probe, through the live daemon (its
// configured credentials; nothing here reads a secrets file).
//   compaction status                   the probe's status, approval and the dry-run preview
//   compaction probe [--approved] [--points N] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait]
//                                       without --approved: the preview only (points, estimated tokens per request and in total)
//   compaction cancel                   stop a running probe (results so far are kept)
//   compaction report <id> [--out FILE] a probe's research report
export const COMPACTION_USAGE = 'compaction status | probe [--approved] [--points N] [--budget TOKENS] [--project ID] [--out FILE] [--no-wait] | cancel | report <id> [--out FILE]';
const ROUTE = '/v2/maintenance/compaction-fork-probe';
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
    if (!Object.hasOwn(spec, name) || Object.hasOwn(out, name)) fail(COMPACTION_USAGE);
    if (spec[name] === 'flag') out[name] = true;
    else { const next = args[++index]; if (next === undefined) fail(`--${name} 需要一个值`, `--${name} needs a value`); out[name] = spec[name] === 'integer' ? Number(next) : next; if (spec[name] === 'integer' && !Number.isSafeInteger(out[name])) fail(`--${name} 必须是整数`, `--${name} must be an integer`); }
  }
  return out;
}
const query = values => { const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])); const text = params.toString(); return text ? `?${text}` : ''; };
const pointLine = point => say(`  ${point.id}  ${point.kind === 'compaction' ? '压缩点（另发平铺请求 C 作覆盖率对照）' : point.demoted ? `大上下文点（原为 ${point.demoted.model ?? '其他模型'} 执行的压缩）` : '大上下文点'}${point.prefix === 'other_project' ? '（借用其他项目的提示前缀，只计入缓存命中）' : ''}  上下文约 ${point.size}  A ${point.warm ? '跳过（缓存仍热）' : point.requests.warmup}  B ${point.requests.fork}${point.requests.flat ? `  C ${point.requests.flat}` : ''}  合计 ${point.estimate}`, `  ${point.id}  ${point.kind === 'compaction' ? 'Compaction point (a flat request C is also sent as the coverage control)' : point.demoted ? `Large-context point (originally a compaction run on ${point.demoted.model ?? 'another model'})` : 'Large-context point'}${point.prefix === 'other_project' ? ' (borrows another project\'s prompt prefix, counted for cache hits only)' : ''}  context about ${point.size}  A ${point.warm ? 'skipped (cache still warm)' : point.requests.warmup}  B ${point.requests.fork}${point.requests.flat ? `  C ${point.requests.flat}` : ''}  total ${point.estimate}`);
export async function runCompactionCommand(args, call, { wait = ms => new Promise(done => setTimeout(done, ms)), log = console.log, pollMs = 15000 } = {}) {
  const [action = 'status', ...rest] = args;
  if (action === 'status') { if (rest.length) fail(COMPACTION_USAGE); return call(ROUTE); }
  if (action === 'cancel') { if (rest.length) fail(COMPACTION_USAGE); return call(`${ROUTE}/cancel`, 'POST', {}); }
  if (action === 'report') {
    const parsed = parse(rest, { out: 'value' }), [id] = parsed.positional;
    if (!id || parsed.positional.length !== 1) fail('compaction report <id> [--out FILE]');
    const report = await call(`${ROUTE}/reports/${encodeURIComponent(id)}`);
    if (parsed.out) { writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' }); return { id, written: resolve(parsed.out) }; }
    return { id, markdown: report.markdown };
  }
  if (action === 'probe') {
    const parsed = parse(rest, { approved: 'flag', points: 'integer', budget: 'integer', project: 'value', out: 'value', 'no-wait': 'flag' });
    if (parsed.positional.length) fail(COMPACTION_USAGE);
    const options = { ...(parsed.points !== undefined ? { points: parsed.points } : {}), ...(parsed.budget !== undefined ? { budgetTokens: parsed.budget } : {}), ...(parsed.project ? { projectId: parsed.project } : {}) };
    // The lines below are printed in the interface language, read from the daemon once (a plain-JSON reply needs none).
    await languageReady();
    // The preview first: the chosen points and their estimates (the daemon refuses a start above the approved budget).
    const preview = await call(`${ROUTE}${query(options)}`);
    if (!preview.plan) fail(`已有探针在运行（${preview.job?.id ?? '未知'}）：用 ./rna compaction status 查看，./rna compaction cancel 中止。`, `A probe is already running (${preview.job?.id ?? 'unknown'}): check it with ./rna compaction status, stop it with ./rna compaction cancel.`);
    const plan = preview.plan, approval = plan.approval;
    log(say(`探针计划：${plan.selected} 个点（${plan.candidates.compactions} 个历史自动压缩候选、${plan.candidates.context} 个大上下文候选），${plan.calls} 次 GLM 请求，估算 ${plan.estimate} token（单次预算 ${plan.options.budgetTokens}${approval ? `；已批准共 ${approval.approved}，此前已用 ${approval.spent}，剩余 ${approval.remaining}` : ''}${Number.isFinite(plan.dailyRemaining) ? `；今日真实 token 限额剩余 ${plan.dailyRemaining}` : ''}）。`, `Probe plan: ${plan.selected} points (${plan.candidates.compactions} earlier automatic compaction candidates, ${plan.candidates.context} large-context candidates), ${plan.calls} GLM requests, estimated ${plan.estimate} tokens (per-run budget ${plan.options.budgetTokens}${approval ? `; approved in total ${approval.approved}, already used ${approval.spent}, remaining ${approval.remaining}` : ''}${Number.isFinite(plan.dailyRemaining) ? `; real tokens left under today's limit ${plan.dailyRemaining}` : ''}).`));
    for (const point of plan.points ?? []) log(pointLine(point));
    for (const row of plan.prefixMissing ?? []) log(say(`  ${row.modelId} 上还没有任何已发布的提示前缀，项目 ${row.projectId} 的 ${row.points} 个候选暂不可用：等任一项目在该模型上发出一次请求后再预览。`, `  No prompt prefix has been published on ${row.modelId} yet, so the ${row.points} candidates of project ${row.projectId} are unavailable for now: preview again after any project has sent one request on that model.`));
    for (const row of plan.prefixBorrowed ?? []) log(say(`  项目 ${row.projectId} 的 ${row.points} 个点借用项目 ${row.fromProjectId ?? '其他项目'} 的提示前缀：纯文本与覆盖率不计入门槛。先在项目 ${row.projectId} 用 GLM 发出一次请求，再预览即可改用它自己的前缀。`, `  The ${row.points} points of project ${row.projectId} borrow the prompt prefix of project ${row.fromProjectId ?? 'another project'}: plain text and coverage do not count toward the gate. Send one request with GLM in project ${row.projectId} first, then preview again to use its own prefix.`));
    if (!parsed.approved) return { approved: false, plan, note: say('未开始：加 --approved 才会调用 GLM（计费）。', 'Not started: add --approved to call GLM (billed).') };
    const job = await call(ROUTE, 'POST', { approved: true, ...options });
    log(say(`已开始：${job.id}`, `Started: ${job.id}`));
    if (parsed['no-wait']) return { started: job.id };
    let status = job, report = null, missing = 0;
    while (true) {
      await wait(pollMs);
      const state = await call(ROUTE);
      if (state.job?.id === job.id) { status = state.job; missing = 0; }
      else if ((state.reports ?? []).includes(job.id)) {
        report = await call(`${ROUTE}/reports/${encodeURIComponent(job.id)}`);
        status = report.json ?? status; log(say(`${status.phase}：${status.done}/${status.calls} 次请求，已用 ${status.spentTokens} token（守护进程已不再运行它）`, `${status.phase}: ${status.done}/${status.calls} requests, ${status.spentTokens} tokens used (the daemon no longer runs it)`)); break;
      } else if (++missing >= MISSING_POLLS) fail(`探针 ${job.id} 已不在守护进程中，也没有报告（守护进程可能已重启）；用 ./rna compaction status 查看，./rna compaction report ${job.id} 取报告。`, `Probe ${job.id} is no longer in the daemon and has no report (the daemon may have restarted); check it with ./rna compaction status, fetch the report with ./rna compaction report ${job.id}.`);
      log(say(`${status.phase}：${status.done}/${status.calls} 次请求，已用 ${status.spentTokens} token`, `${status.phase}: ${status.done}/${status.calls} requests, ${status.spentTokens} tokens used`));
      if (status.phase !== 'running') break;
    }
    report ??= await call(`${ROUTE}/reports/${encodeURIComponent(job.id)}`);
    if (parsed.out) writeFileSync(resolve(parsed.out), report.markdown, { flag: 'w' });
    return { id: job.id, phase: status.phase, spentTokens: status.spentTokens, gate: status.summary?.gate ?? null, ...(parsed.out ? { written: resolve(parsed.out) } : { markdown: report.markdown }) };
  }
  fail(COMPACTION_USAGE);
}
