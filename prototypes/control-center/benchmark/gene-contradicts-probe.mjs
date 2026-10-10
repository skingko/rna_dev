#!/usr/bin/env node
// gene.consolidate `contradicts` labelled probe (C4; docs/research/gene-contradicts-probe-20261005.md). Placement
// (gene-evolution-service.mjs place) puts the user's new word among every rule in force; v2 of the template also asks,
// rule by rule, whether the new word REVERSES that rule. A "yes" retires the older rule without asking (mu: the user's
// latest word wins, features/memory.ts:200-211), so a false yes loses a rule the user still wants. Questions:
//   1. Do rules the new word reverses reach the retire line, and rules it merely overlaps (repeats, narrows, tightens,
//      adds detail to, makes an exception to) stay under it? Label per (case, rule): 'contradicts' (must flag),
//      'ok' (must not flag), 'arguable' (recorded, not scored).
//   2. Do the extra `contradicts_<n>` questions change what `overlap` and `adds` answer (placement runs the same call)?
// Candidates: the live rules of the two real projects in RNA_STATE (read only; the production liveRules), plus a small
// synthetic English project. Each call is one raw call through the live daemon's probe (POST
// /api/v2/decision-kernel/probe: the app's configured key, no thresholds, cache or ledger); the state comes from the
// production builder and the plan from the production template, verdicts from the production combiner.
// Usage: RNA_STATE=<state.json copy> node benchmark/gene-contradicts-probe.mjs [--out file.json] [--label v2]  (RNA_URL)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { geneConsolidateTemplate, combineGeneConsolidate, GENE_PLACE_LIMIT, DECISION_THRESHOLDS, stakeThreshold, contradictsKey } from '../../../packages/sdk/src/decision-templates.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { NOVEL, RESEARCH, DEV, ENGLISH, SET } from './gene-contradicts-cases.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
const live = readStateFile(stateFile).state;
const projects = {};
for (const id of [NOVEL, RESEARCH]) { const row = live.projects.find(project => project.id === id); if (!row) throw new Error(`project ${id} not in ${stateFile}`); projects[id] = { id, name: row.name, taskTypes: row.taskTypes ?? [], genes: { genes: structuredClone(row.genes?.genes ?? []) } }; }
projects[DEV] = { id: DEV, name: 'Web app development', taskTypes: ['software'], genes: { genes: [] } };
const noteSection = gene => String(gene?.body?.note ?? '').replace(/^\s*##[^\n]*\n/, '').trim();
const service = Object.create(GeneEvolutionService.prototype);
const rulesOf = (id, text) => id === DEV ? ENGLISH : service.liveRules(projects[id], text);
const rowsOf = rules => rules.map(row => ({ title: row.title, summary: row.summary ?? '', body: row.layer === 'skill' ? noteSection(row) || row.body : String(row.body?.skillNote ?? '') }));
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
const maxChars = deriveDecisionPolicy('gene.consolidate').maxStateChars;
async function ask(project, text, rules, { contradicts }) {
  const list = rowsOf(rules).slice(0, GENE_PLACE_LIMIT);
  const state = minimizeDecisionState(buildDecisionState('gene.consolidate', { layer: 'request', title: '', summary: '', body: text.slice(0, 900), existing: list, project: { title: project.name, taskTypes: project.taskTypes } }), { maxChars });
  const answer = await probe(state, wire(geneConsolidateTemplate({ existing: list.length, contradicts })));
  const answers = parsed(answer.answers), verdict = combineGeneConsolidate(answers, { existing: list.length });
  return { answers, verdict, latencyMs: answer.latencyMs, count: list.length };
}
const rows = [];
async function askNarrower(project, text, rules) {
  const list = rowsOf(rules).slice(0, GENE_PLACE_LIMIT), all = Array.from({ length: Math.min(list.length, 18) }, (_, index) => index);
  const state = minimizeDecisionState(buildDecisionState('gene.consolidate', { layer: 'request', title: '', summary: '', body: text.slice(0, 900), existing: list, project: { title: project.name, taskTypes: project.taskTypes } }), { maxChars });
  const answer = await probe(state, wire(geneConsolidateTemplate({ existing: list.length, narrower: all })));
  return parsed(answer.answers);
}
for (const item of SET) {
  const project = projects[item.project], rules = rulesOf(item.project, item.text), titles = rules.map(row => row.title);
  for (const title of [...(item.contradicts ?? []), ...(item.arguable ?? [])]) if (!titles.includes(title)) throw new Error(`label names a rule that is not in force: ${title}`);
  const withQuestions = await ask(project, item.text, rules, { contradicts: true }), without = await ask(project, item.text, rules, { contradicts: false });
  const narrower = await askNarrower(project, item.text, rules);
  const rule = index => ({ title: titles[index], p: round(withQuestions.answers[contradictsKey(index)]?.probability ?? .5), narrower: round(narrower[`narrower_${index}`]?.probability ?? .5), exception: Boolean(item.exceptionOf?.includes(titles[index])), label: item.contradicts?.includes(titles[index]) ? 'contradicts' : item.arguable?.includes(titles[index]) ? 'arguable' : 'ok' });
  const overlap = value => ({ action: value.verdict.action, index: value.verdict.index, p: round(value.answers.overlap?.probabilities?.[`rule_${value.verdict.index}`] ?? Math.max(0, ...Object.values(value.answers.overlap?.probabilities ?? {}))), none: round(value.answers.overlap?.probabilities?.none ?? 0), adds: round(value.answers.adds?.probability ?? .5) });
  rows.push({ kind: item.kind, project: item.project === NOVEL ? 'novel' : item.project === RESEARCH ? 'research' : 'dev', text: item.text, rules: titles.map((_, index) => rule(index)), withContradicts: overlap(withQuestions), without: overlap(without), count: withQuestions.count });
}
// Scoring at a threshold t: a rule is flagged when P(contradicts) >= t.
const score = threshold => {
  let tp = 0, fn = 0, fp = 0, tn = 0; const falsePositives = [], missed = [];
  for (const row of rows) for (const rule of row.rules) {
    if (rule.label === 'arguable') continue;
    const flagged = rule.p >= threshold;
    if (rule.label === 'contradicts') { if (flagged) tp++; else { fn++; missed.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p})`); } }
    else if (flagged) { fp++; falsePositives.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p})`); } else tn++;
  }
  return { threshold, tp, fn, fp, tn, recall: round(tp / Math.max(1, tp + fn)), falsePositives, missed };
};
const thresholds = [.5, .6, .7, .75, .8, .85, .9, .95].map(score);
const by = kind => rows.filter(row => row.kind === kind).flatMap(row => row.rules.filter(rule => rule.label !== 'arguable').map(rule => rule.p));
const spread = Object.fromEntries(['reversal', 'exception', 'tighten', 'repeat', 'detail', 'unrelated'].map(kind => { const list = rows.filter(row => row.kind === kind).flatMap(row => row.rules.filter(rule => kind === 'reversal' ? rule.label === 'contradicts' : rule.label === 'ok').map(rule => rule.p)).sort((a, b) => a - b); return [kind, { n: list.length, min: list[0], median: list[Math.floor(list.length / 2)], max: list.at(-1) }]; }));
void by;
// Do the extra questions move placement? Compare overlap/adds with and without them.
const moved = rows.filter(row => row.withContradicts.action !== row.without.action || row.withContradicts.index !== row.without.index);
// The production path: stage one flags the rules at the configured line (`contradicts`, high); stage two asks `narrower` of
// those alone (the host's second call). A rule is retired when it is flagged and not a special case (`narrower` under its line).
const lineOne = stakeThreshold(DECISION_THRESHOLDS.points['gene.consolidate'].contradicts), lineTwo = stakeThreshold(DECISION_THRESHOLDS.points['gene.consolidate'].narrower);
const production = { retiredRight: 0, retiredWrong: [], keptReversal: [], rescuedException: 0, stageTwoCalls: 0 };
for (const row of rows) {
  const flagged = row.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.p >= lineOne);
  if (!flagged.length) { for (const rule of row.rules) if (rule.label === 'contradicts') production.keptReversal.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p}, under the line)`); continue; }
  const item = SET.find(entry => entry.text === row.text), project = projects[item.project], rules = rulesOf(item.project, item.text);
  const list = rowsOf(rules).slice(0, GENE_PLACE_LIMIT);
  const state = minimizeDecisionState(buildDecisionState('gene.consolidate', { layer: 'request', title: '', summary: '', body: item.text.slice(0, 900), existing: list, project: { title: project.name, taskTypes: project.taskTypes } }), { maxChars });
  const second = parsed((await probe(state, wire(geneConsolidateTemplate({ existing: list.length, narrower: flagged.map(({ index }) => index) })))).answers); production.stageTwoCalls++;
  for (const { rule, index } of flagged) {
    const narrowerP = round(second[`narrower_${index}`]?.probability ?? .5), retired = narrowerP < lineTwo;
    if (retired) { if (rule.label === 'contradicts') production.retiredRight++; else production.retiredWrong.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p}, narrower ${narrowerP})`); }
    else if (rule.label === 'contradicts') production.keptReversal.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p}, narrower ${narrowerP})`); else production.rescuedException++;
  }
  for (const rule of row.rules) if (rule.label === 'contradicts' && rule.p < lineOne) production.keptReversal.push(`${row.text.slice(0, 22)} → ${rule.title} (${rule.p}, under the line)`);
}
// Stage two: is the new word a special case of the rule? Distribution over reversed pairs, labelled exception pairs, and the flagged-at-line pairs.
const dist = list => { const sorted = list.sort((a, b) => a - b); return { n: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), values: sorted }; };
const narrowerSpread = { reversed: dist(rows.flatMap(row => row.rules.filter(rule => rule.label === 'contradicts').map(rule => rule.narrower))), exception: dist(rows.flatMap(row => row.rules.filter(rule => rule.exception).map(rule => rule.narrower))),
  other: dist(rows.flatMap(row => row.rules.filter(rule => rule.label !== 'contradicts' && !rule.exception).map(rule => rule.narrower))) };
const exceptionContradicts = rows.flatMap(row => row.rules.filter(rule => rule.exception).map(rule => ({ text: row.text.slice(0, 40), rule: rule.title, contradicts: rule.p, narrower: rule.narrower })));
const results = { at: new Date().toISOString(), production, narrowerSpread, exceptionContradicts, base: BASE, label: arg('--label') ?? 'v2', maxChars, calls, inputTokens, configured: { contradicts: DECISION_THRESHOLDS.points['gene.consolidate'].contradicts, line: stakeThreshold(DECISION_THRESHOLDS.points['gene.consolidate'].contradicts) }, spread, thresholds, placementMoved: moved.map(row => ({ text: row.text, with: row.withContradicts, without: row.without })), rows };
const outFile = arg('--out'); if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ configured: results.configured, spread, calls, inputTokens }, null, 2));
for (const result of thresholds) console.log(`t=${result.threshold}: tp ${result.tp} fn ${result.fn} fp ${result.fp} tn ${result.tn} recall ${result.recall}${result.fp ? `  FP: ${result.falsePositives.join(' | ')}` : ''}`);
console.log('production (stage one at', lineOne, ', stage two at', lineTwo, '):', JSON.stringify(production, null, 1));
console.log('narrower (special case) — reversed pairs:', JSON.stringify(narrowerSpread.reversed.values), '\n  exception pairs:', JSON.stringify(narrowerSpread.exception.values), '\n  other pairs: n', narrowerSpread.other.n, 'max', narrowerSpread.other.max);
for (const row of exceptionContradicts) console.log(`  exception ${row.text.padEnd(42)} ${row.rule.slice(0, 14).padEnd(14)} contradicts=${row.contradicts} narrower=${row.narrower}`);
console.log(`placement (overlap/adds) moved by the extra questions: ${moved.length}/${rows.length}`);
for (const row of rows) console.log(`${row.kind.padEnd(9)} ${row.project.padEnd(8)} ${row.text.slice(0, 30).padEnd(30)} ${row.rules.filter(rule => rule.p >= .3 || rule.label === 'contradicts').map(rule => `${rule.label === 'contradicts' ? '*' : rule.label === 'arguable' ? '?' : ' '}${rule.title.slice(0, 10)}=${rule.p}`).join(' ')}`);
