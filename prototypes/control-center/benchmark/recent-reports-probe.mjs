#!/usr/bin/env node
// B3 labelled probe for the initiative gate's `already_reported` after background work lines joined `recentReports`
// (docs/research/jev-recent-reports-probe-20261005.md). Synthetic cases, labelled by hand: does the gate's new evidence
// repeat something the user was already told? Each case is sent in three compositions of `recentReports`:
//   main   — proactive messages and foreground replies only (0.68.0);
//   branch — plus the latest three host status lines of any status, running ones included (B3 as first written);
//   fixed  — plus at most the latest finished background run's line, within the four rows the SDK keeps (recentReportRows).
// Each call asks the live daemon's JEV probe (POST /api/v2/decision-kernel/probe: one raw call with the app's configured
// key, no thresholds, cache or ledger) the full initiative.review template (v2 questions: no work in progress).
// Usage: node benchmark/recent-reports-probe.mjs [--out results.json]   (RNA_URL, default http://127.0.0.1:4317)
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { initiativeGateTemplate, combineInitiativeGate } from '../../../packages/sdk/src/decision-templates.mjs';
import { recentReportRows } from '../decision-service.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const NOW = Date.parse('2026-10-05T10:00:00Z'), MINUTE = 60000, ago = minutes => new Date(NOW - minutes * MINUTE).toISOString();
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };

const NOVEL = { title: '长篇小说《雾港》', goal: '写完并修订 30 章，人物和时间线前后一致', phase: 'active' };
const CODE = { title: 'Billing service', goal: 'Keep the invoice API correct and its tests green', phase: 'active' };
const share = (text, minutes) => ({ createdAt: ago(minutes), text });
const reply = (text, minutes) => ({ at: ago(minutes), text });
const line = (text, minutes, status = 'done') => ({ createdAt: ago(minutes + 1), updatedAt: ago(minutes), text, status });
const running = (task, minutes, language = 'zh') => line(language === 'zh' ? `后台开始做：${task}\n\n正在进行，做完后会在这里补上做了什么、改了哪些文件。` : `Background work started: ${task}\n\nIn progress; what it did and the files it changed will be added here when it finishes.`, minutes, 'running');

/** label: is the substance of the evidence already told by what the user saw (`fixed` composition)? */
export const CASES = [
  { id: 'novel-line-reports-run', label: 'reported', project: NOVEL, why: 'the finished line is the report of the completion under judgment',
    evidence: [{ type: 'background_work_completed', summary: '后台检查第二章：修复了 2 处失效链接（chapter2.md 第 14、37 行），其余正常。' }],
    inbox: [share('第一章里林舟的年龄前后不一致：开头写 17 岁，第 9 节写 19 岁。', 300)], finals: [reply('已经开始写第四章，先写了开头两节。', 90)],
    lines: [line('后台改了 1 个文件：chapter2.md\n\n修复了第二章 2 处失效链接（第 14、37 行），其余链接正常。', 5)] },
  { id: 'novel-review-scenario', label: 'reported', project: NOVEL, why: 'the B3 review case: a share told the finding; three running lines came after',
    evidence: [{ type: 'background_work_completed', summary: '检查第二章：第 14 行的链接失效，指向的 notes/harbor.md 已被删除。' }],
    inbox: [share('第二章第 14 行的链接失效了：它指向的 notes/harbor.md 已经被删除。', 60)], finals: [reply('好的，已经开始写第四章。', 30)],
    lines: [running('检查第五章的人物称呼', 20), running('核对第三章的时间线', 15), running('整理第六章的大纲', 10)] },
  { id: 'novel-unrelated-user', label: 'new', project: NOVEL, why: 'a new request; the finished line is about another chapter',
    evidence: [{ type: 'user_message', summary: '把第六章的结尾改成开放式，不要交代船长的下落。' }],
    inbox: [share('第一章里林舟的年龄前后不一致：开头写 17 岁，第 9 节写 19 岁。', 300)], finals: [reply('已经开始写第四章，先写了开头两节。', 90)],
    lines: [line('后台改了 1 个文件：chapter2.md\n\n修复了第二章 2 处失效链接（第 14、37 行），其余链接正常。', 20)] },
  { id: 'novel-other-run', label: 'new', project: NOVEL, why: 'a different run finished; the line reports an earlier one',
    evidence: [{ type: 'background_work_completed', summary: '后台统一了第三章的人名写法：“林洲”全部改为“林舟”，共 9 处。' }],
    inbox: [], finals: [reply('第四章开头两节写好了。', 120)],
    lines: [line('后台改了 1 个文件：chapter2.md\n\n修复了第二章 2 处失效链接（第 14、37 行），其余链接正常。', 40)] },
  { id: 'novel-failed-run', label: 'new', project: NOVEL, why: 'a failure nobody was told about; the line reports another run',
    evidence: [{ type: 'background_work_failed', summary: '后台检查第七章没有完成：模型服务超时，没有结果。' }],
    inbox: [], finals: [reply('第四章开头两节写好了。', 120)],
    lines: [line('后台改了 1 个文件：chapter2.md\n\n修复了第二章 2 处失效链接（第 14、37 行），其余链接正常。', 30)] },
  { id: 'novel-same-file-other-finding', label: 'new', project: NOVEL, why: 'same chapter, a different finding than the line reported',
    evidence: [{ type: 'background_work_completed', summary: '检查第八章：时间线矛盾——第 3 节写的是周二，第 5 节写的是周一，中间只隔了一夜。' }],
    inbox: [], finals: [reply('第八章初稿已经写完。', 180)],
    lines: [line('后台改了 1 个文件：chapter8.md\n\n修正了第八章两处错别字（“雾港”误作“雾巷”）。', 10)] },
  { id: 'code-line-reports-run', label: 'reported', project: CODE, why: 'the finished line is the report of the completion under judgment',
    evidence: [{ type: 'background_work_completed', summary: 'Fixed rounding in src/tax.js (half-even to half-up for 0.005 amounts); tax.spec.ts now passes 42/42.' }],
    inbox: [share('The /refunds endpoint accepts negative amounts; there is no validation.', 400)], finals: [reply('Added the CSV export for invoices.', 60)],
    lines: [line('Background work changed 1 file: src/tax.js\n\nFixed rounding of 0.005 amounts (half-up); tax.spec.ts passes 42/42.', 5)] },
  { id: 'code-unrelated-edit', label: 'new', project: CODE, why: 'a workspace change the line does not cover',
    evidence: [{ type: 'workspace_change', summary: 'The user edited README.md (12 lines changed in the Deployment section).' }],
    inbox: [], finals: [reply('Added the CSV export for invoices.', 60)],
    lines: [line('Background work changed 1 file: src/tax.js\n\nFixed rounding of 0.005 amounts (half-up); tax.spec.ts passes 42/42.', 10)] },
  { id: 'code-share-reports-it', label: 'reported', project: CODE, why: 'a proactive message told it; a finished line about something else is newer',
    evidence: [{ type: 'background_work_completed', summary: 'Found that POST /invoices returns 500 when an invoice has no line items (null reduce in totals.js).' }],
    inbox: [share('POST /invoices returns a 500 when the invoice has no line items: totals.js reduces over null.', 45)], finals: [reply('Added the CSV export for invoices.', 120)],
    lines: [line('Background work changed 1 file: src/tax.js\n\nFixed rounding of 0.005 amounts (half-up); tax.spec.ts passes 42/42.', 5)] },
  { id: 'code-started-not-reported', label: 'new', project: CODE, why: 'only the start was told (a running line); the result is new',
    evidence: [{ type: 'background_work_completed', summary: 'Migrated the currency table to ISO 4217 codes in 3 files (currencies.js, format.js, seed.sql); all 118 tests pass.' }],
    inbox: [], finals: [reply('Added the CSV export for invoices.', 60)],
    lines: [running('Migrate the currency table to ISO 4217 codes', 20, 'en')] },
];

const branchRows = ({ inbox, lines, finals }) => [...inbox.map(row => ({ at: row.createdAt, text: `[proactive message] ${row.text}` })), ...[...lines].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-3).map(row => ({ at: row.updatedAt, text: `[background work line] ${row.text}` })), ...finals.map(row => ({ at: row.at, text: `[foreground reply] ${row.text}` }))].sort((a, b) => String(a.at).localeCompare(String(b.at))).map(row => row.text);
const mainRows = ({ inbox, finals }) => [...inbox.map(row => ({ at: row.createdAt, text: `[proactive message] ${row.text}` })), ...finals.map(row => ({ at: row.at, text: `[foreground reply] ${row.text}` }))].sort((a, b) => String(a.at).localeCompare(String(b.at))).map(row => row.text);
// The host passes finished lines only (decision-service initiativeGateState); recentReportRows bounds them.
const fixedRows = row => recentReportRows({ inbox: row.inbox, lines: row.lines.filter(item => !['running', 'paused'].includes(item.status)), finals: row.finals });
export const VARIANTS = { main: mainRows, branch: branchRows, fixed: fixedRows };

export function caseState(row, recentReports) {
  const gate = buildDecisionState('initiative.review', { evidence: row.evidence, lastReportAt: row.inbox.at(-1)?.createdAt, lastUserAt: ago(row.finals.length ? 95 : 200), userActive: false, recentReports, currentTopic: row.project === NOVEL ? '写第四章' : 'CSV export for invoices', pendingQuestions: 0, freshCount: row.evidence.length,
    openWork: { commitments: 0, overdue: 0, agenda: 1, awaitingUser: 0, heldFindings: 0 }, lastWake: 'thought', project: row.project }, { now: NOW });
  const full = { task: { title: row.project.title, goal: row.project.goal, phase: row.project.phase }, evidence: row.evidence.map((item, index) => ({ id: `e${index}`, type: item.type, summary: item.summary, verified: false })), ...gate };
  return minimizeDecisionState(full, { maxChars: deriveDecisionPolicy('initiative.review').maxStateChars });
}
const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
const kernelAnswer = (raw, type) => type === 'noul' ? { type: 'boolean', probability: raw.noul } : { type: 'choice', choice: raw.choice, probabilities: raw.probabilities, ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}) };

async function probe() {
  const questions = wire(initiativeGateTemplate()), rows = [];
  let inputTokens = 0;
  for (const row of CASES) for (const [variant, compose] of Object.entries(VARIANTS)) {
    const recentReports = compose(row), state = caseState(row, recentReports);
    const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
    const body = await response.json();
    if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
    inputTokens += body.usage?.input_tokens ?? 0;
    const raw = body.answers ?? body.body?.answers ?? {}, answers = Object.fromEntries(Object.entries(questions).filter(([id]) => raw[id]).map(([id, question]) => [id, kernelAnswer(raw[id], question.type)]));
    rows.push({ id: row.id, variant, label: row.label, sent: state.review?.recentReports ?? [], reported: answers.already_reported?.probability ?? null, needs: answers.needs_main_model?.probability ?? null, relevant: answers.evidence_relevant?.probability ?? null, likely: answers.likely_action?.choice ?? null, gate: combineInitiativeGate(answers) });
  }
  const summary = Object.fromEntries(Object.keys(VARIANTS).map(variant => {
    const of = label => rows.filter(row => row.variant === variant && row.label === label).map(row => row.reported);
    const right = rows.filter(row => row.variant === variant && (row.label === 'reported') === (row.reported >= .5)).length;
    return [variant, { reported: of('reported'), new: of('new'), rightAtHalf: `${right}/${CASES.length}` }];
  }));
  return { rows, summary, calls: rows.length, inputTokens };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const result = await probe(), out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ summary: result.summary, calls: result.calls, inputTokens: result.inputTokens, rows: result.rows.map(row => [row.id, row.variant, row.label, row.reported, row.gate.wake ?? null]) }, null, 1));
}
