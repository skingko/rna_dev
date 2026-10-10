#!/usr/bin/env node
// mind.judge `stale_<n>` labelled probe (C4; docs/research/revocation-stale-probe-20261005.md). After something the mind
// rested on is withdrawn, ONE batch call asks, per candidate row (a note, an open plan item, a standing lesson), whether
// it still leans on what was withdrawn; a confident yes marks the row stale (out of every model context, shown as stale,
// nothing deleted). Three kinds of withdrawal, three wordings (decision-templates.mjs mindStaleTemplate):
//   lesson  the row states the same rule as a revoked lesson (lesson_revoked: notes and plan items)
//   tool    the row tells the assistant to use a tool or procedure that left (tool_withdrawn: notes, plan items, lessons)
//   source  the row (a note) is no longer stated or implied by the messages that still stand behind it (message_rewound and
//           session_deleted: a note with some of its sources gone; the texts of the removed messages are never sent)
// Labels: Y (must flag), N (must not flag), ? (arguable: recorded, not scored). `lesson` rows are the real notes and plan
// items of the two live projects in RNA_STATE (read only), chosen as production would: the BM25-nearest eight rows to the
// revoked lesson's text; the rest of the cases are synthetic. Each call is one raw call through the live daemon's probe
// (POST /api/v2/decision-kernel/probe: the app's configured key, no thresholds, cache or ledger).
// Usage: RNA_STATE=<state.json copy> node benchmark/revocation-stale-probe.mjs [--only lesson|tool|source] [--out file.json]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { mindStaleTemplate, combineMindStale, DECISION_THRESHOLDS, stakeThreshold } from '../../../packages/sdk/src/decision-templates.mjs';
import { bm25Rank } from '../project-mind.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const only = arg('--only') === 'src' ? 'source' : arg('--only');
const NOVEL = 'd4ed6510-cbfd-4f66-91f8-bed576abd851', RESEARCH = '2ba45503-236b-4b34-897b-7fd9fb953078';
const CANDIDATES = 8;
const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
const live = readStateFile(stateFile).state;
const projectRows = id => {
  const project = live.projects.find(row => row.id === id), mind = project.mind;
  return { name: project.name, lessons: mind.lessons, rows: [...mind.notes.preferences.map((row, index) => ({ id: `P${index}`, kind: 'note', text: row.text })), ...mind.notes.facts.map((row, index) => ({ id: `F${index}`, kind: 'note', text: row.text })),
    ...mind.agenda.filter(row => row.status === 'open' && row.kind === 'todo').map((row, index) => ({ id: `T${index}`, kind: 'plan', text: row.text }))] };
};

// ---- lesson: (project, revoked lesson id prefix) → labels for its BM25-nearest rows, by row id. Real rows.
const LESSON_LABELS = [
  [NOVEL, 'ea3735b2', { F1: 'N', P13: 'N', P12: 'N', P9: 'N', P26: 'N', F13: 'N', F3: 'N', P6: 'N' }],
  [NOVEL, '4f824527', { P12: 'N', P11: 'N', P1: 'N', P24: '?', P9: 'N', F1: 'N', P27: 'N', P26: 'N' }],
  [NOVEL, '619a3ba8', { P1: 'Y', P0: '?', P12: 'N', P16: 'N', T0: 'N', P14: 'N', P3: 'N', P8: 'N' }],
  [NOVEL, 'e7bb076a', { P0: 'Y', P1: 'Y', P3: 'N', P8: '?', P29: 'N', P7: 'N', P26: 'N', P9: 'N' }],
  [NOVEL, '46b14719', { P2: 'Y', P3: 'Y', P1: 'N', P29: 'N', P0: 'N', P14: 'N', P12: 'N' }],
  [NOVEL, '8b2f598b', { P4: '?', F24: 'N', F22: 'N', P39: 'N', P36: 'N', F23: 'N', F25: 'N', F19: 'N' }],
  [NOVEL, '08d4805d', { P6: 'Y', F3: 'Y', F1: 'N', F11: 'N', P11: 'N', P8: 'Y', F22: 'N', P29: '?' }],
  [NOVEL, 'bb92ceb6', { P8: 'Y', P6: '?', F3: '?', P29: '?', P3: 'N', P1: 'N', P0: 'N', P14: 'N' }],
  [NOVEL, 'ed89b41c', { P11: 'Y', P30: 'N', P12: 'N', P5: 'N', P13: 'N', P23: 'N', P24: 'N', P18: 'N' }],
  [NOVEL, 'c40c71a3', { P12: 'Y', P13: 'Y', P16: 'N', P9: 'N', P30: 'N', P11: 'N', P25: 'N', F4: 'N' }],
  [NOVEL, '1a1a3eae', { P14: 'Y', P15: 'Y', P16: 'N', P20: '?', P12: 'N', P10: 'N', P21: 'N', P24: 'N' }],
  [NOVEL, '2e49a5c1', { P5: '?', F10: 'N', P4: '?', F12: 'N', F9: 'N', F5: 'N', P28: 'N', F15: 'N' }],
  [NOVEL, 'd9fb8687', { P19: 'Y', F5: 'N', F0: 'N', F26: 'N', P27: 'N', P12: 'N', F10: 'N', P13: 'N' }],
  [NOVEL, 'ef8f1a74', { F6: 'Y', F7: 'N', P23: '?', P24: '?', P9: 'N', P25: 'N', P38: 'N', F21: 'N' }],
  [NOVEL, '66c95c12', { P21: 'Y', F20: 'N', F16: 'N', P1: 'N', P4: 'N', P22: 'N', F22: 'N', P17: 'N' }],
  [NOVEL, 'f658b384', { P23: 'Y', P27: '?', F7: 'N', F6: 'N', F25: 'N', P9: 'N', F13: 'N', P25: 'N' }],
  [NOVEL, '63b9c6bf', { P24: 'Y', F6: 'N', F4: 'N', P27: '?', P1: 'N', P16: 'N', P9: 'N', F7: 'N' }],
  [NOVEL, '5771bc36', { P12: 'N', F2: 'N', F4: 'N', T0: 'N', P9: 'N', P26: 'Y', P5: 'N', F0: 'N' }],
  [NOVEL, '22c2561f', { P30: 'Y', F1: 'N', P35: 'N', T1: 'N', F2: 'N', F0: 'N', F17: 'N', F4: 'N' }],
  [RESEARCH, '597f780c', { P1: 'Y', P0: '?' }],
  [RESEARCH, 'e25b1dc0', { P4: 'Y', P3: 'Y', P2: 'N', P0: 'N' }],
  [RESEARCH, '3a5073eb', { P4: 'N', P3: 'N', P0: 'N' }],
  [RESEARCH, 'abe54686', { P2: 'N', P0: 'N' }],
];
// Synthetic rows (a revoked lesson, rows that may lean on it): plan items, English, and rows of a different wording.
const LESSON_SYNTHETIC = [
  { name: 'novel', revoked: '写作前先用已修复的搜索接口查证原著（斩神）的整体风格，再参照该风格动笔。', rows: [
    { kind: 'plan', text: '先搜索查证原著风格，再动笔写第 12 章', label: 'Y' }, { kind: 'plan', text: '写第 12 章正文并自检字数', label: 'N' },
    { kind: 'note', text: '动笔前要用搜索接口把原著的整体风格查一遍', label: 'Y' }, { kind: 'note', text: '用户习惯晚上九点以后看稿', label: 'N' },
    { kind: 'plan', text: '整理第 1–11 章的伏笔登记表', label: 'N' }, { kind: 'note', text: '用户已经修复了搜索接口', label: 'N' } ] },
  { name: 'research', revoked: '日报里每条新闻都要附上原文链接。', rows: [
    { kind: 'note', text: '日报每条新闻后面带原文链接', label: 'Y' }, { kind: 'plan', text: '补齐昨天日报里缺失的原文链接', label: 'Y' },
    { kind: 'note', text: '日报标题不超过 20 个字', label: 'N' }, { kind: 'plan', text: '整理本周的融资事件汇总表', label: 'N' },
    { kind: 'note', text: '日报按北京时间归档', label: 'N' }, { kind: 'note', text: '链接失效的来源在日报末尾列出', label: '?' } ] },
  { name: 'dev', revoked: 'Always run the linter before finishing a task.', rows: [
    { kind: 'note', text: 'The user wants the linter run before a task is declared done.', label: 'Y' }, { kind: 'plan', text: 'Run the linter on the changed files before handing over', label: 'Y' },
    { kind: 'note', text: 'The user prefers short answers.', label: 'N' }, { kind: 'plan', text: 'Fix the failing parser test', label: 'N' },
    { kind: 'note', text: 'The project uses ESLint with the airbnb config.', label: 'N' }, { kind: 'note', text: 'Lint errors must be zero before merging to main.', label: '?' } ] },
  { name: 'dev2', revoked: 'Reply in English only.', rows: [
    { kind: 'note', text: 'The user wants every answer written in English.', label: 'Y' }, { kind: 'note', text: '用户要求只用英文回复', label: 'Y' },
    { kind: 'note', text: 'The user is based in Berlin.', label: 'N' }, { kind: 'plan', text: 'Translate the README into German', label: 'N' },
    { kind: 'note', text: 'The user prefers concise replies.', label: 'N' }, { kind: 'plan', text: 'Write the release notes in English', label: '?' } ] },
];
// ---- tool: withdrawn tools, what is left, rows. Rows with prose_* are the live notes and plan items.
const NOVEL_TOOLS = ['project_read', 'project_write', 'project_edit', 'project_exec', 'project_grep', 'web_search', 'web_fetch', 'skill_load', 'project_plan', 'prose_draft', 'prose_assemble', 'prose_check', 'prose_review', 'prose_patch', 'prose_reword'];
const without = names => NOVEL_TOOLS.filter(name => !names.includes(name));
const TOOL_SETS = [
  { name: 'novel: prose_reword withdrawn', withdrawn: ['prose_reword'], available: without(['prose_reword']), rows: [
    { id: 'F22', label: 'Y' }, { id: 'F25', label: 'Y' }, { id: 'P31', label: 'N' }, { id: 'P33', label: 'N' }, { id: 'F20', label: 'N' }, { id: 'P32', label: 'N' }, { id: 'P38', label: '?' }, { id: 'T2', label: 'N' } ] },
  { name: 'novel: prose_patch + prose_review withdrawn', withdrawn: ['prose_patch', 'prose_review'], available: without(['prose_patch', 'prose_review']), rows: [
    { id: 'F20', label: 'Y' }, { id: 'T2', label: 'Y' }, { id: 'F22', label: 'Y' }, { id: 'P31', label: 'N' }, { id: 'P33', label: 'N' }, { id: 'F25', label: 'N' }, { id: 'P32', label: 'N' }, { id: 'P2', label: 'N' } ] },
  { name: 'novel: web_search withdrawn', withdrawn: ['web_search'], available: without(['web_search']), rows: [
    { lesson: 'ea3735b2', label: 'Y' }, { lesson: '22c2561f', label: 'Y' }, { id: 'P30', label: '?' }, { id: 'F1', label: 'N' }, { lesson: 'ed89b41c', label: 'N' }, { id: 'P11', label: 'N' }, { lesson: 'c40c71a3', label: 'N' }, { id: 'F2', label: 'N' } ] },
  { name: 'dev: run_linter withdrawn', withdrawn: ['run_linter'], available: ['read_file', 'write_file', 'run_tests', 'git_commit', 'search_code', 'run_typecheck'], rows: [
    { kind: 'note', text: 'Run run_linter after every edit and fix what it reports.', label: 'Y' }, { kind: 'plan', text: 'Call run_linter on src/ and clean up the findings', label: 'Y' },
    { kind: 'note', text: 'Run the project tests with run_tests before committing.', label: 'N' }, { kind: 'note', text: 'Prefer small commits with a clear message.', label: 'N' },
    { kind: 'plan', text: 'Fix the failing parser test with run_tests', label: 'N' }, { kind: 'note', text: 'The linter configuration lives in .eslintrc.', label: 'N' },
    { kind: 'note', text: 'Check types with run_typecheck before finishing.', label: 'N' }, { kind: 'note', text: 'Lint the code before finishing.', label: '?' } ] },
  { name: 'research: web_fetch + a skill withdrawn', withdrawn: ['web_fetch', 'news-digest'], available: ['project_read', 'project_write', 'web_search', 'skill_load', 'project_plan'], rows: [
    { kind: 'note', text: 'Read each original article with web_fetch before summarising it.', label: 'Y' }, { kind: 'plan', text: 'Load the news-digest skill and build today’s digest', label: 'Y' },
    { kind: 'note', text: '抓取失败的来源在日报末尾列出，不要静默跳过。', label: 'N' }, { kind: 'note', text: 'Search the web for new AI products every morning with web_search.', label: 'N' },
    { kind: 'plan', text: '整理本周的融资事件汇总表', label: 'N' }, { kind: 'note', text: '日报用中文写。', label: 'N' } ] },
];
// ---- source: a note and the messages that still stand behind it (the removed ones are never sent). Y: no remaining message says it.
const SOURCE_CASES = [
  { note: '用户要求日报简洁，不要啰嗦', sources: ['日报写简洁点，别啰嗦', '今天的日报不错'], label: 'N' },
  { note: '用户要求日报简洁，不要啰嗦', sources: ['把数据表放到 data 目录', '标题统一用二级标题'], label: 'Y' },
  { note: '守夜人这个名字不能直接用', sources: ['组织命名别直接用原著里的专有名词', '继续写第 5 章'], label: 'N' },
  { note: '守夜人这个名字不能直接用', sources: ['继续写第 5 章'], label: 'Y' },
  { note: '用户已授权继续补写到 30 章', sources: ['可以，继续写到 30 章', '先看第 3 章'], label: 'N' },
  { note: '用户已授权继续补写到 30 章', sources: ['先把第 3 章改一下'], label: 'Y' },
  { note: 'The user prefers tabs for indentation.', sources: ['Use tabs, not spaces.'], label: 'N' },
  { note: 'The user prefers tabs for indentation.', sources: ['Please fix the failing test.', 'Thanks, that works.'], label: 'Y' },
  { note: "The user's name is Lin.", sources: ["I'm Lin, by the way."], label: 'N' },
  { note: "The user's name is Lin.", sources: ['What is the weather like today?'], label: 'Y' },
  { note: '作品标题确定为《提灯入夜》', sources: ['标题就叫《提灯入夜》吧'], label: 'N' },
  { note: '作品标题确定为《提灯入夜》', sources: ['简介再写短一点'], label: 'Y' },
  { note: '推送渠道用邮件', sources: ['推送发邮件就行'], label: 'N' },
  { note: '推送渠道用邮件', sources: ['推送先不做', '每天早上八点跑一次'], label: 'Y' },
  { note: '用户不喜欢啰嗦', sources: ['能不能简洁点？'], label: 'N' },
  { note: '用户在上海', sources: ['明天早上八点提醒我开会'], label: 'Y' },
  { note: '用户已下载斩神完整版，可作为对照参考', sources: ['我把斩神的完整版放到参考目录了'], label: 'N' },
  { note: '用户要求每章不少于 3000 字，并且每章末尾留悬念', sources: ['每章不少于 3000 字'], label: '?' },
  { note: '用户要求每章不少于 3000 字，并且每章末尾留悬念', sources: ['每章结尾要留个钩子', '字数别太少'], label: '?' },
  { note: 'The user wants releases tagged with a v prefix.', sources: ['Tag it as v1.2.0', 'Push the tag after CI passes.'], label: 'N' },
];

const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
const parsed = raw => Object.fromEntries(Object.entries(raw ?? {}).map(([id, answer]) => [id, answer.type === 'noul' ? { type: 'boolean', probability: answer.noul } : { type: answer.type, choice: answer.choice, probabilities: answer.probabilities }]));
const round = value => Math.round(value * 1000) / 1000;
let calls = 0, inputTokens = 0;
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
const maxChars = deriveDecisionPolicy('mind.judge').maxStateChars;
// One batch call as production sends it: rows [{ kind, text, sources? }], the revoked text or the tools, the stale template of the kind.
async function batch(kind, { rows, revoked, tools }) {
  const state = minimizeDecisionState(buildDecisionState('mind.judge', { rows, ...(revoked !== undefined ? { revoked } : {}), ...(tools ? { tools } : {}) }), { maxChars });
  const answer = await probe(state, wire(mindStaleTemplate({ kind, rows: rows.length })));
  const answers = parsed(answer.answers);
  // The source question asks whether the note is still SUPPORTED: its stale score is the probability of no.
  return rows.map((_, index) => round(kind === 'source' ? 1 - (answers[`stale_${index}`]?.probability ?? .5) : answers[`stale_${index}`]?.probability ?? .5));
}
const results = { at: new Date().toISOString(), base: BASE, maxChars, configured: Object.fromEntries(['staleLesson', 'staleTool', 'staleSource'].map(key => [key, { stake: DECISION_THRESHOLDS.points['mind.judge'][key], line: stakeThreshold(DECISION_THRESHOLDS.points['mind.judge'][key]) }])), kinds: {} };
const scored = [];

if (!only || only === 'lesson') {
  const out = [];
  for (const [pid, prefix, labels] of LESSON_LABELS) {
    const { lessons, rows } = projectRows(pid), lesson = lessons.find(row => row.id.startsWith(prefix));
    const near = bm25Rank(rows, lesson.text).filter(row => row.score > 0).slice(0, CANDIDATES).map(row => rows.find(entry => entry.id === row.id));
    const picked = near.map(row => ({ ...row, label: labels[row.id] ?? null })), unlabeled = picked.filter(row => !row.label);
    if (unlabeled.length) throw new Error(`lesson ${prefix}: unlabeled rows ${unlabeled.map(row => row.id).join(',')}`);
    const p = await batch('lesson', { rows: picked, revoked: lesson.text });
    out.push({ source: `live ${prefix}`, revoked: lesson.text.slice(0, 40), rows: picked.map((row, index) => ({ id: row.id, kind: row.kind, text: row.text.slice(0, 50), label: row.label, p: p[index] })) });
  }
  for (const item of LESSON_SYNTHETIC) {
    const p = await batch('lesson', { rows: item.rows, revoked: item.revoked });
    out.push({ source: `synthetic ${item.name}`, revoked: item.revoked.slice(0, 40), rows: item.rows.map((row, index) => ({ kind: row.kind, text: row.text.slice(0, 50), label: row.label, p: p[index] })) });
  }
  results.kinds.lesson = out;
  for (const entry of out) for (const row of entry.rows) scored.push({ kind: 'lesson', label: row.label, p: row.p, text: `${entry.source}: ${row.text}`, rowKind: row.kind });
}
if (!only || only === 'tool') {
  const out = [], novel = projectRows(NOVEL);
  for (const set of TOOL_SETS) {
    const rows = set.rows.map(row => {
      if (row.text) return { kind: row.kind, text: row.text, label: row.label };
      if (row.lesson) return { kind: 'lesson', text: novel.lessons.find(entry => entry.id.startsWith(row.lesson)).text, label: row.label };
      return { ...novel.rows.find(entry => entry.id === row.id), label: row.label };
    });
    // The host sends each withdrawn tool as "name: description" (project-genes.mjs withdrawn); --desc does the same here.
    const DESCRIPTIONS = { prose_reword: 'reword a draft in the style of a reference text', prose_patch: 'patch a flagged spot in a draft', prose_review: 'review a draft as a reader', web_search: 'search the web', run_linter: 'run the linter on files', web_fetch: 'fetch a web page', 'news-digest': 'build the daily news digest' };
    const withdrawn = process.argv.includes('--desc') ? set.withdrawn.map(name => `${name}: ${DESCRIPTIONS[name] ?? name}`) : set.withdrawn;
    const p = await batch('tool', { rows, tools: { withdrawn, available: set.available } });
    out.push({ source: set.name, rows: rows.map((row, index) => ({ kind: row.kind, text: row.text.slice(0, 50), label: row.label, p: p[index] })) });
  }
  results.kinds.tool = out;
  for (const entry of out) for (const row of entry.rows) scored.push({ kind: 'tool', label: row.label, p: row.p, text: `${entry.source}: ${row.text}`, rowKind: row.kind });
}
if (!only || only === 'source') {
  // Production batches the notes of one event; here the cases go in groups of six so each call stays the size of a real one.
  const out = [];
  for (let start = 0; start < SOURCE_CASES.length; start += 6) {
    const group = SOURCE_CASES.slice(start, start + 6), rowsIn = group.map(row => ({ kind: 'note', text: row.note, sources: row.sources })), p = await batch('source', { rows: rowsIn });
    group.forEach((row, index) => out.push({ source: 'synthetic', rows: [{ kind: 'note', text: row.note.slice(0, 50), sources: row.sources, label: row.label, p: p[index] }] }));
  }
  results.kinds.source = out;
  for (const entry of out) for (const row of entry.rows) scored.push({ kind: 'source', label: row.label, p: row.p, text: row.text, rowKind: row.kind });
}

const thresholds = [.5, .6, .7, .75, .8, .85, .9, .95];
results.summary = {};
for (const kind of ['lesson', 'tool', 'source']) {
  const list = scored.filter(row => row.kind === kind && row.label !== '?'); if (!list.length) continue;
  const sorted = label => list.filter(row => row.label === label).map(row => row.p).sort((a, b) => a - b);
  results.summary[kind] = { yes: { n: sorted('Y').length, values: sorted('Y') }, no: { n: sorted('N').length, max: sorted('N').at(-1), top: sorted('N').slice(-6) }, arguable: scored.filter(row => row.kind === kind && row.label === '?').map(row => row.p),
    byThreshold: thresholds.map(t => ({ t, tp: list.filter(row => row.label === 'Y' && row.p >= t).length, fn: list.filter(row => row.label === 'Y' && row.p < t).length, fp: list.filter(row => row.label === 'N' && row.p >= t).length, fpRows: list.filter(row => row.label === 'N' && row.p >= t).map(row => `${row.text.slice(0, 60)} (${row.p})`) })) };
}
results.calls = calls; results.inputTokens = inputTokens;
const outFile = arg('--out'); if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ configured: results.configured, calls, inputTokens }, null, 2));
for (const [kind, summary] of Object.entries(results.summary)) {
  console.log(`\n== ${kind}: Y n=${summary.yes.n} ${JSON.stringify(summary.yes.values)}\n   N n=${summary.no.n} max ${summary.no.max} top ${JSON.stringify(summary.no.top)}\n   arguable ${JSON.stringify(summary.arguable)}`);
  for (const row of summary.byThreshold) console.log(`   t=${row.t}: tp ${row.tp} fn ${row.fn} fp ${row.fp}${row.fp ? `  FP: ${row.fpRows.join(' | ')}` : ''}`);
}
for (const row of scored.filter(entry => entry.label === 'Y' && entry.p < .85 || entry.label === 'N' && entry.p >= .3 || entry.label === '?')) console.log(`${row.kind.padEnd(7)} ${row.label} ${String(row.p).padEnd(5)} ${row.text.slice(0, 90)}`);
