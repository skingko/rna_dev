#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { extractFixtures, loadFixtures, DEFAULT_FIXTURE_ROOT } from './extract.mjs';
import { computeProjectMetrics, datasetMetrics, WINDOWS } from './metrics.mjs';
import { projectSideData } from './dataset.mjs';
import { loadLabelFile } from './labels.mjs';
import { runScenarios, scenarioText } from './runner.mjs';
import { comparePairs, pairsFromDataset } from './judge.mjs';

// rna bench extract|metrics|scenarios|compare — K4 replay benchmark CLI.
// Offline and read-only over state; never talks to the running service.
const HOST = fileURLToPath(new URL('../', import.meta.url));
export const BENCH_HELP = `用法：rna bench <命令> [选项]
  extract   [--state <state.json>] [--out <目录>] [--project <ID>]… [--labels <文件>] [--json]
            只读提取脱敏回放基准（默认写入 benchmark/fixtures/，已被 git 忽略）
  metrics   [--state <state.json> | --fixtures <目录>] [--project <ID>] [--window 7d|30d|all] [--now <ISO>] [--json]
            计算 §5 指标（主动沟通 + 学习 + 数据覆盖）
  scenarios [--only <id,…>] [--force] [--json]
            在假时钟/假模型上驱动真实宿主控制器跑 §5 场景；缺少 K1/K2 能力时跳过（--force 强制运行作基线诊断）
  compare   (--pairs <pairs.jsonl> | --from-fixtures [<目录>]) --dry-run [--out <目录>] [--json]
            新旧消息盲评：仅生成评审提示词，不调用模型
默认 state：$RNA_BENCH_STATE 或 ${join(HOST, '.state/state.json')}`;

export function parseArgs(argv) {
  const out = { _: [], project: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2), flag = ['json', 'force', 'dry-run', 'help'].includes(key);
    const optional = ['fixtures', 'from-fixtures'].includes(key);
    const value = flag ? true : optional ? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true) : argv[++index];
    if (!flag && !optional && value === undefined) throw new Error(`--${key} 需要一个值`);
    if (key === 'project') out.project.push(value); else out[key] = value;
  }
  return out;
}
const stateFileOf = args => resolve(args.state ?? process.env.RNA_BENCH_STATE ?? join(HOST, '.state/state.json'));
const pct = value => value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`;
const num = value => value === null || value === undefined ? '—' : String(value);
const hours = ms => ms === null || ms === undefined ? '—' : `${Math.round(ms / 360000) / 10}h`;

export function metricsText(result) {
  const p = result.proactive, l = result.learning, c = p.commitments ?? {}, w = p.wakes ?? {};
  return [`== ${result.name ?? result.projectId} (${result.window}, proactive: ${result.owners.proactive})`,
    `  proactive  messages ${num(p.counts?.messages)} (unscheduled ${num(p.counts?.unscheduled)}) · useful ${pct(p.usefulShareRate)} · reply ${pct(p.replyRate)} · ignore ${pct(p.ignoreRate)} · dismiss ${pct(p.dismissRate)}`,
    `             longest unreplied ${num(p.longestUnrepliedChain)} · away ${pct(p.awayShare)} · night ${pct(p.nightShare)} · repeat ${pct(p.repeatRate)} · status-report ${pct(p.statusReportShare)} · median ${num(p.medianChars)} chars (scheduled ${num(p.medianScheduledChars)})`,
    `             commitments ${num(c.total)} [${c.source ?? '—'}] p50 ${hours(c.p50Ms)} p90 ${hours(c.p90Ms)} overdue ${num(c.overdue)} · false-silence ${num(p.falseSilence?.silentWithFindings)}/${num(p.falseSilence?.progressQueries)}`,
    `             wakes ${num(w.decisions)} · invalid ${pct(w.invalidRate)} · tokens/wake p50 ${num(w.tokensPerWake)} (${num(w.ledgerRows)} ledger rows) · cache-read ${pct(w.cacheReadShare)} · latency ${num(w.latencyMsP50)}`,
    `  learning   turns ${num(l.turns)} · corrections/turn ${num(l.correctionsPerTurn)} · repeat-correction ${pct(l.repeatCorrectionRate)} · first-attempt ${pct(l.firstAttemptAcceptance)} (${num(l.judgedTurns)} judged)`,
    `             retries/turn ${num(l.retriesPerTurn)} · failed/turn ${num(l.failedTurnRate)} · aborts/turn ${num(l.abortsPerTurn)} · tool-failure ${pct(l.toolFailureRate)} · tokens/accepted ${num(l.tokensPerAcceptedDeliverable)} · min/accepted ${num(l.minutesPerAcceptedDeliverable)}`,
    `             lessons ${num(l.lessons)} hit ${pct(l.lessonHitRate)} · evolution candidates ${num(l.evolution?.candidates)} passed ${num(l.evolution?.passed)}`].join('\n');
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv), [command] = args._;
  if (!command || args.help || command === 'help') { log(BENCH_HELP); return 0; }
  const emit = (value, text) => log(args.json ? JSON.stringify(value, null, 2) : text);
  if (command === 'extract') {
    const { dir, manifest } = extractFixtures({ stateFile: stateFileOf(args), out: resolve(args.out ?? DEFAULT_FIXTURE_ROOT), projectIds: args.project, labelsFile: args.labels });
    emit({ dir, manifest }, `fixtures → ${dir}\n${manifest.projects.map(row => `  ${row.name ?? row.projectId}: ${Object.entries(row.counts).map(([kind, count]) => `${kind} ${count}`).join(' · ')}`).join('\n')}\n可编辑标签：复制 labels.template.json 为 labels.json 后修改。`);
    return 0;
  }
  if (command === 'metrics') {
    const window = args.window ?? '7d'; if (!(window in WINDOWS)) throw new Error('--window 必须为 7d、30d 或 all');
    const now = args.now ? Date.parse(args.now) : undefined; if (args.now && !Number.isFinite(now)) throw new Error('--now 必须为 ISO 时间');
    let results;
    if (args.fixtures) {
      const { datasets } = loadFixtures(resolve(args.fixtures === true ? DEFAULT_FIXTURE_ROOT : args.fixtures));
      results = datasets.filter(row => !args.project.length || args.project.includes(row.projectId)).map(dataset => datasetMetrics(dataset, { window, ...(now ? { now } : {}) }));
    } else {
      const file = stateFileOf(args); if (!existsSync(file)) throw new Error(`找不到 state：${file}（用 --state 指定，或 --fixtures 使用已提取基准）`);
      const state = readStateFile(file)?.state; if (!state) throw new Error('state 无法读取');
      const labels = loadLabelFile(join(DEFAULT_FIXTURE_ROOT, 'labels.json'));
      results = state.projects.filter(row => !args.project.length || args.project.includes(row.id)).map(project => computeProjectMetrics(state, project.id, window, { now: now ?? Date.now(), side: projectSideData(file, project.id), labels }));
    }
    emit(results, results.map(metricsText).join('\n'));
    return 0;
  }
  if (command === 'scenarios') {
    const report = await runScenarios({ only: args.only ? String(args.only).split(',') : undefined, force: args.force === true });
    emit(report, scenarioText(report));
    return report.summary.error ? 1 : 0;
  }
  if (command === 'compare') {
    if (!args['dry-run']) throw new Error('实时模型评审默认关闭；请加 --dry-run 只生成提示词（接入评审模型见 benchmark/judge.mjs comparePairs 的 judge 参数）');
    let pairs;
    if (args.pairs) pairs = readFileSync(resolve(args.pairs), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    else if (args['from-fixtures']) pairs = loadFixtures(resolve(args['from-fixtures'] === true ? DEFAULT_FIXTURE_ROOT : args['from-fixtures'])).datasets.flatMap(dataset => pairsFromDataset(dataset));
    else throw new Error('需要 --pairs <文件> 或 --from-fixtures');
    const outDir = resolve(args.out ?? join(DEFAULT_FIXTURE_ROOT, 'judge'));
    const result = await comparePairs(pairs, { dryRun: true, outDir });
    if (args['from-fixtures']) { writeFileSync(join(outDir, 'pairs.template.jsonl'), pairs.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 }); }
    emit(result, `prompts ${result.prompts} (skipped ${result.skipped} without a new text) → ${join(outDir, 'prompts.jsonl')}${args['from-fixtures'] ? `\npairs template → ${join(outDir, 'pairs.template.jsonl')}（填入 new 后用 --pairs 重跑）` : ''}`);
    return 0;
  }
  throw new Error(`未知命令 ${command}\n${BENCH_HELP}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(failure => { console.error(failure.message); process.exitCode = 2; });
}
