#!/usr/bin/env node
// gene.consolidate placement with the project instruction file as "already covered" candidates (EVO-15, B2 review
// finding 5; docs/research/gene-place-instructions-probe-20261005.md). Placement (gene-evolution-service.mjs place) puts
// new content among every rule in force before any model writes; B2 adds up to three AGENTS.md sections to those
// candidates, and a confident "same thing, adds nothing" on a section means nothing is written. Three questions:
//   1. Does a section that states the new rule come back as skip on that section (covered)?
//   2. Does a section the new rule adds to stay out of skip (a false "covered" loses the rule)?
//   3. Do the sections change placement among the live rules (padding: AGENTS.md saw 8/8 → 5/8 with unrelated text)?
// Each case runs in four configurations: `live` (the live rules only, as before B2); `unfiltered` (one call, the live
// rules plus the top three sections whatever their score: B2 as first written); `combined` (one call, plus only the
// sections sharing words with the new content: the review's suggested fix); `separate` (production: the live rules
// alone as before, then — only when nothing in force is about it — the sharing sections in a call of their own, where
// only skip counts). The candidates come from the production code (GeneEvolutionService.prototype.place, liveRules,
// instructionSections) over the live rules of the two projects in RNA_STATE (read only) and a synthetic AGENTS.md in a
// temporary folder; the state from the production builder; each call is one raw call through the live daemon's probe
// (POST /api/v2/decision-kernel/probe: the app's configured key, no thresholds, cache or ledger); verdicts from the
// production combiner at its stakes.
// Usage: RNA_STATE=<state.json copy> node benchmark/gene-place-instructions-probe.mjs [--out file.json]  (RNA_URL)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { geneConsolidateTemplate, combineGeneConsolidate, GENE_PLACE_LIMIT } from '../../../packages/sdk/src/decision-templates.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { bm25Rank } from '../project-mind.mjs';
import { readProjectInstructions } from '../project-instructions.mjs';
import { promptSections } from '../project-genes.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const NOVEL = 'd4ed6510-cbfd-4f66-91f8-bed576abd851', RESEARCH = '2ba45503-236b-4b34-897b-7fd9fb953078';
// Synthetic instruction files, written the way a user writes one: a lead paragraph, then short sections. Some lines
// repeat a live rule (users do), most are the user's own.
const AGENTS = {
  [NOVEL]: `# 玄幻小说撰写项目

这是一部参考《斩神》设定、学习《灵境行者》写法的玄幻续写项目。代理负责撰写和修改正文、维护设定集。

## 目录约定
- 正文放在 正文/卷N/第NNN章.md，设定放在 设定集/，大纲放在 大纲/。
- 每章文件第一行必须是“## 第 N 章 标题”。

## 写作风格
- 对话统一用中文直角引号「」，不要用英文双引号。
- 少用“然而”“与此同时”这类翻译腔连接词。
- 每章正文不少于 3000 字。

## 设定与专有名词
- 不得直接使用原著的组织名和专有名词（如「守夜人」），一律用自创名称。
- 新出现的人物、地点要同步写进设定集。

## 工作流程
- 写新章节前先读设定集里的人物表和上一章结尾。
- 每写完一章，更新 大纲/进度.md 里的章节进度。

## 交付
- 改稿时直接修改原文件，不要另存副本。
- 完成后用一两句话说明改了什么，不要贴全文。
`,
  [RESEARCH]: `# Ai 应用调研项目

每天整理 AI 应用领域的新闻和产品动态，输出到 reports/YYYY-MM-DD/daily.md。

## 日报格式
- 每条新闻一行标题加两三句摘要，后面附原文链接。
- 条目标记只用【新】或【更新】。
- 不要写“交付物详单”之类的清单，直接交付 daily.md 内容。

## 时间与归档
- 所有时间按北京时间（UTC+8），目录名用北京时间日期。

## 数据来源
- 优先引用官方博客、论文和 GitHub 发布页，不引用营销号转载。
- 抓取失败的来源在日报末尾列出，不要静默跳过。

## 安全公告
- GitHub 安全公告只看高 star 项目。
`,
};
// expect: { covered: [section heading or live title, …] } — skip on one of them is right (the rule is already stated);
// { adds: true } — the new content adds to something stated: any skip on an instruction section loses it (harmful);
// { live: [title, …] } — skip or revise on one of those live rules is right; { none: true } — add.
const SET = [
  { project: NOVEL, text: '对话一律用中文直角引号「」，别用英文引号。', expect: { covered: ['写作风格'] } },
  { project: NOVEL, text: '每章开头第一行要写成“## 第 N 章 标题”的格式。', expect: { covered: ['目录约定'] } },
  { project: NOVEL, text: '写新章前先看设定集的人物表和上一章的结尾。', expect: { covered: ['工作流程'] } },
  { project: NOVEL, text: '改稿直接改原文件，不要另存一份副本。', expect: { covered: ['交付'] } },
  { project: NOVEL, text: '新出现的人物和地点要记进设定集。', expect: { covered: ['设定与专有名词'] } },
  { project: NOVEL, text: '正文不要出现“然而”“与此同时”这种翻译腔。', expect: { covered: ['写作风格'] } },
  { project: NOVEL, text: '不要直接复用原著的组织名「守夜人」。', expect: { covered: ['设定与专有名词', '「守夜人」字样检查'] } },
  { project: NOVEL, text: '每章正文不少于 4000 字，而且章末必须留一个悬念钩子。', expect: { adds: true } },
  { project: NOVEL, text: '对话用「」，人物内心独白单独成段并用楷体标出。', expect: { adds: true } },
  { project: NOVEL, text: '写新章前除了读人物表和上一章，还要核对时间线表。', expect: { adds: true } },
  { project: NOVEL, text: '改稿直接改原文件，并且在文件末尾附一份修改记录。', expect: { adds: true } },
  // Differs from a stated line only in a number or one more allowed value: a false "covered" here loses the change.
  { project: NOVEL, text: '每章正文不少于 3500 字。', expect: { adds: true } },
  { project: NOVEL, text: '写章节前先去查一下《斩神》原著的整体文风，再照着写。', expect: { live: ['先查原著风格'] } },
  { project: NOVEL, text: '删掉「不是疼，是烧」这种没信息量的修辞句。', expect: { live: ['去修辞赘句'] } },
  { project: NOVEL, text: '简介要先参考同类爆款小说的简介再写。', expect: { live: ['简介先调研爆款'] } },
  { project: NOVEL, text: '战斗场面要写清楚双方的站位和招式先后。', expect: { none: true } },
  { project: NOVEL, text: '章节标题不要剧透本章的结局。', expect: { none: true } },
  { project: RESEARCH, text: '每条新闻后面都要附上原文链接。', expect: { covered: ['日报格式'] } },
  { project: RESEARCH, text: '抓取失败的来源要在日报末尾列出来，不能静默跳过。', expect: { covered: ['数据来源'] } },
  { project: RESEARCH, text: '引用优先用官方博客和论文，别引营销号转载。', expect: { covered: ['数据来源'] } },
  { project: RESEARCH, text: '日报每条新闻除了链接，还要注明原文的发布时间。', expect: { adds: true } },
  { project: RESEARCH, text: '安全公告除了只看高 star 项目，还要写明受影响的版本范围。', expect: { adds: true } },
  { project: RESEARCH, text: '日报条目标记只用【新】【更新】【快讯】这三种。', expect: { adds: true } },
  { project: RESEARCH, text: '时间都按北京时间，目录名用北京时间日期，文件名里也要带上生成时刻。', expect: { adds: true } },
  { project: RESEARCH, text: 'GitHub 安全公告只看大范围使用的项目，只报最严重等级并给出威胁判断。', expect: { live: ['安全报告筛选'] } },
  { project: RESEARCH, text: '盈利分析的每条建议都要写清落地假设和可验证指标。', expect: { live: ['建议可执行性检查'] } },
  { project: RESEARCH, text: '日报最后用一张表汇总当天的融资事件。', expect: { none: true } },
];

const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
const live = readStateFile(stateFile).state;
const folders = {}, projects = {};
for (const id of [NOVEL, RESEARCH]) {
  const row = live.projects.find(project => project.id === id); if (!row) throw new Error(`project ${id} not in ${stateFile}`);
  folders[id] = mkdtempSync(join(tmpdir(), 'rna-place-probe-')); writeFileSync(join(folders[id], 'AGENTS.md'), AGENTS[id]);
  projects[id] = { id, name: row.name, taskTypes: row.taskTypes ?? [], workspace: folders[id], genes: { genes: structuredClone(row.genes?.genes ?? []) } };
}
const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
const parsed = raw => Object.fromEntries(Object.entries(raw ?? {}).map(([id, answer]) => [id, answer.type === 'noul' ? { type: 'boolean', probability: answer.noul } : { type: answer.type, choice: answer.choice, probabilities: answer.probabilities, ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}) }]));
const round = value => Math.round(value * 1000) / 1000;
let calls = 0, inputTokens = 0;
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
// decision-service.mjs geneConsolidate, with the probe in place of decide(): same list, state, plan and combiner.
const maxChars = deriveDecisionPolicy('gene.consolidate').maxStateChars;
async function consolidate(project, { layer, title, summary, body, existing, limit }) {
  const list = existing.slice(0, Math.min(limit, GENE_PLACE_LIMIT));
  const state = minimizeDecisionState(buildDecisionState('gene.consolidate', { layer, title, summary, body, existing: list, project: { title: project.name, taskTypes: project.taskTypes } }), { maxChars });
  const answer = await probe(state, wire(geneConsolidateTemplate({ existing: list.length })));
  const answers = parsed(answer.answers), verdict = combineGeneConsolidate(answers, { existing: list.length });
  const top = Object.entries(answers.overlap?.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { ...verdict, raw: { choice: answers.overlap?.choice ?? null, top: top[0], p: round(top[1]), none: round(answers.overlap?.probabilities?.none ?? 0), adds: round(answers.adds?.probability ?? .5) }, latencyMs: answer.latencyMs };
}
// The B2 section picker as first written (top three by BM25, whatever their score), for the padding comparison.
async function unfilteredSections(project, text) {
  const file = await readProjectInstructions(project.workspace), content = String(file?.content ?? '').trim(); if (!content) return [];
  const headed = content.split(/\n(?=#{1,6}\s)/).map(row => row.trim()).filter(Boolean);
  const sections = (headed.length > 1 ? headed : promptSections(content).map(row => row.body)).map((body, index) => ({ id: `instructions:${index}`, body }));
  return bm25Rank(sections.map(row => ({ id: row.id, text: row.body })), text).slice(0, 3).map(({ id }) => sections.find(row => row.id === id)).map(row => ({ id: row.id, layer: 'instructions', title: `${file.name}: ${row.body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60)}`, summary: '', body: { text: row.body.slice(0, 900) } }));
}
const noteSection = gene => String(gene?.body?.note ?? '').replace(/^\s*##[^\n]*\n/, '').trim();
// B2's first placement: one call over the live rules and the sections together.
async function placeCombined(service, project, text, sectionsOf) {
  const instructions = await sectionsOf(project, text), rules = [...service.liveRules(project, text).slice(0, GENE_PLACE_LIMIT - instructions.length), ...instructions];
  if (!rules.length) return { action: 'add' };
  const verdict = await service.decisions.geneConsolidate(project, { layer: 'request', title: '', summary: '', body: text.slice(0, 900), existing: rules.map(row => ({ title: row.title, summary: row.summary ?? '', body: row.layer === 'instructions' ? row.body.text : row.layer === 'skill' ? noteSection(row) : String(row.body?.skillNote ?? '') })), limit: GENE_PLACE_LIMIT });
  const target = Number.isInteger(verdict.index) ? rules[verdict.index] : null;
  return verdict.action !== 'add' && target ? { action: verdict.action, target } : { action: 'add' };
}
const CONFIGS = {
  live: { overrides: { instructionSections: async () => [] } },
  unfiltered: { run: (service, project, text) => placeCombined(service, project, text, unfilteredSections) },
  combined: { run: (service, project, text) => placeCombined(service, project, text, (...args) => service.instructionSections(...args)) },
  separate: {},
};
const labelOf = target => !target ? null : target.layer === 'instructions' ? target.title.replace(/^AGENTS\.md:\s*/, '') : target.title;
function judge(expect, placed) {
  const action = placed?.action ?? 'add', target = labelOf(placed?.target), onSection = placed?.target?.layer === 'instructions';
  if (expect.covered) return { right: action === 'skip' && expect.covered.includes(target), harmful: false, kind: 'covered' };
  if (expect.adds) return { right: !(action === 'skip' && onSection), harmful: action === 'skip' && onSection, kind: 'adds' };
  if (expect.live) return { right: ['skip', 'revise'].includes(action) && expect.live.includes(target), harmful: action === 'skip' && onSection, kind: 'live' };
  return { right: action === 'add', harmful: action === 'skip' && onSection, kind: 'none' };
}
const rows = [];
for (const row of SET) {
  const project = projects[row.project], out = { text: row.text, expect: row.expect };
  for (const [name, { overrides = {}, run = null }] of Object.entries(CONFIGS)) {
    // Every call of this placement: the last one decided (the sections' call when there was one).
    const asked = [];
    const service = Object.assign(Object.create(GeneEvolutionService.prototype), { decisions: { geneConsolidate: async (_project, input) => { const judged = await consolidate(project, input); asked.push({ input, judged }); return judged; } } }, overrides);
    const placed = run ? await run(service, project, row.text) : await service.place(project, row.text);
    const verdict = judge(row.expect, placed), sent = asked.flatMap(call => call.input.existing);
    out[name] = { action: placed?.action ?? null, target: labelOf(placed?.target), calls: asked.length, sections: sent.filter(item => item.title.startsWith('AGENTS.md:')).map(item => item.title.replace(/^AGENTS\.md:\s*/, '')), ...asked[0]?.judged.raw, ...(asked.length > 1 ? { second: asked[1].judged.raw } : {}), ...verdict };
  }
  rows.push(out);
}
const tally = name => {
  const scored = rows.map(row => ({ kind: row[name].kind, right: row[name].right, harmful: row[name].harmful }));
  const by = kind => { const list = scored.filter(row => row.kind === kind); return `${list.filter(row => row.right).length}/${list.length}`; };
  return { right: `${scored.filter(row => row.right).length}/${scored.length}`, covered: by('covered'), adds: by('adds'), live: by('live'), none: by('none'), harmfulSkips: scored.filter(row => row.harmful).length, calls: rows.reduce((sum, row) => sum + row[name].calls, 0) };
};
const results = { at: new Date().toISOString(), base: BASE, maxChars, rows, summary: Object.fromEntries(Object.keys(CONFIGS).map(name => [name, tally(name)])), calls, inputTokens };
for (const folder of Object.values(folders)) rmSync(folder, { recursive: true, force: true });
const outFile = arg('--out'); if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.summary, null, 2));
const cell = value => `p=${value.p}(${value.top}) none=${value.none} adds=${value.adds}`;
for (const row of rows) console.log([row.text.slice(0, 28), JSON.stringify(row.expect), ...Object.keys(CONFIGS).map(name => `${name}:${row[name].action}${row[name].target ? `@${row[name].target}` : ''} ${cell(row[name])}${row[name].second ? ` then ${cell(row[name].second)}` : ''} ${row[name].right ? 'ok' : 'WRONG'}${row[name].harmful ? ' HARMFUL' : ''} [${row[name].sections.join('|')}]`)].join('\n   '));
console.log(`calls ${calls}, input tokens ${inputTokens}`);
