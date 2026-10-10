#!/usr/bin/env node
// mind.judge `contradicts_<n>` between LESSONS, labelled (C4 review finding 13; docs/research/gene-contradicts-probe-20261005.md,
// "lesson 一层"). The lesson writer asks (project-mind.mjs consolidateLesson / addLesson path) whether a new lesson contradicts or
// replaces each of the five nearest existing lessons; before C4 a "yes" at the high line only superseded the older lesson. With C4 the
// same "yes" also takes back what grew from it (the rule the lesson grew is retired with restore:false). That consequence had only
// been probed at the rule level (gene.consolidate), so this asks the lesson-level question of the same labelled pairs.
// Pairs: the 58 labelled words of gene-contradicts-cases.mjs against the rules of the live projects in force (RNA_STATE, a read-only
// copy), written as the lessons they stand for: the rule's title and summary as one sentence. Production compares with the five
// nearest by BM25 (consolidateLesson), so each word is put among its five nearest rules, plus the rule it reverses when BM25 did not
// find it (recorded separately: production would never have asked about that pair). Each call is one raw call through the live
// daemon's probe (no thresholds, cache or ledger), with the production state builder and template.
// Usage: RNA_STATE=<state.json copy> node benchmark/lesson-contradicts-probe.mjs [--confirm] [--out file.json]  (RNA_URL)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { mindJudgeTemplate, geneConsolidateTemplate, MIND_JUDGE_LIMITS, DECISION_THRESHOLDS, stakeThreshold } from '../../../packages/sdk/src/decision-templates.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { bm25Rank } from '../project-mind.mjs';
import { NOVEL, RESEARCH, DEV, ENGLISH, SET } from './gene-contradicts-cases.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
const live = readStateFile(stateFile).state;
const projects = {};
for (const id of [NOVEL, RESEARCH]) { const row = live.projects.find(project => project.id === id); if (!row) throw new Error(`project ${id} not in ${stateFile}`); projects[id] = row; }
const service = Object.create(GeneEvolutionService.prototype);
const rulesOf = (id, text) => id === DEV ? ENGLISH : service.liveRules(projects[id], text);
const lessonText = rule => `${rule.title}: ${rule.summary ?? ''}`.trim();
const round = value => Math.round(value * 1000) / 1000;
const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
let calls = 0, inputTokens = 0;
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}

const rows = [];
for (const item of SET) {
  const rules = rulesOf(item.project, item.text), texts = rules.map(lessonText);
  const near = bm25Rank(texts.map((text, index) => ({ id: String(index), text })), item.text).filter(row => row.score > 0).slice(0, MIND_JUDGE_LIMITS.dedup).map(row => Number(row.id));
  // The pairs production asks about (the five nearest), then the labelled reversals BM25 left out (a second call, not part of the production distribution).
  const reversed = rules.map((rule, index) => (item.contradicts ?? []).includes(rule.title) ? index : -1).filter(index => index >= 0);
  const groups = [{ indices: near, production: true }, ...(reversed.some(index => !near.includes(index)) ? [{ indices: [...near.slice(0, MIND_JUDGE_LIMITS.dedup - reversed.filter(index => !near.includes(index)).length), ...reversed.filter(index => !near.includes(index))], production: false }] : [])];
  for (const group of groups) {
    if (!group.indices.length) continue;
    const lessons = group.indices.map(index => ({ kind: 'preference', text: texts[index] }));
    const answer = await probe(buildDecisionState('mind.judge', { candidate: item.text, lessons }), wire(mindJudgeTemplate({ dedup: lessons.length })));
    group.indices.forEach((ruleIndex, position) => {
      const title = rules[ruleIndex].title, label = (item.contradicts ?? []).includes(title) ? 'contradicts' : (item.arguable ?? []).includes(title) ? 'arguable' : 'ok';
      const p = key => round(answer.answers?.[`${key}_${position}`]?.noul ?? .5);
      rows.push({ kind: item.kind, text: item.text, rule: title, label, exception: (item.exceptionOf ?? []).includes(title), production: group.production, contradicts: p('contradicts'), refines: p('refines'), same: p('same') });
    });
  }
}
// The confirmation the host asks before a lesson-level "contradicts" retires a rule (gene-evolution-service.mjs reversedRules): the rules
// grown from the older lesson alone (here: the one rule of the pair), the new word, gene.consolidate `contradicts` (stage one at its
// high line) and, for what stage one flags, `narrower` (stage two at its low line: a special case keeps the rule). Run over every pair
// the lesson-level question flagged at its line, and over every labelled reversal, so what the first step lets through and what the
// second keeps are both seen. Only with --confirm (more calls).
const ruleRow = rule => ({ title: rule.title, summary: rule.summary ?? '', body: rule.layer === 'skill' ? String(rule.body?.note ?? '').replace(/^\s*##[^\n]*\n/, '').trim() || (typeof rule.body === 'string' ? rule.body : '') : String(rule.body?.skillNote ?? '') });
async function confirm(item, rule, narrower) {
  const project = item.project === DEV ? { name: 'Web app development', taskTypes: ['software'] } : { name: projects[item.project].name, taskTypes: projects[item.project].taskTypes ?? [] };
  const state = buildDecisionState('gene.consolidate', { layer: 'request', title: '', summary: '', body: item.text.slice(0, 900), existing: [ruleRow(rule)], project: { title: project.name, taskTypes: project.taskTypes } });
  const answer = await probe(state, wire(geneConsolidateTemplate({ existing: 1, ...(narrower ? { narrower: [0] } : { contradicts: true }) })));
  return round(answer.answers?.[narrower ? 'narrower_0' : 'contradicts_0']?.noul ?? .5);
}
const lineOne = stakeThreshold(DECISION_THRESHOLDS.points['gene.consolidate'].contradicts), lineTwo = stakeThreshold(DECISION_THRESHOLDS.points['gene.consolidate'].narrower);
const confirmation = { lineOne, lineTwo, retired: [], kept: [], pairs: 0 };
if (process.argv.includes('--confirm')) {
  const lineLesson = stakeThreshold(DECISION_THRESHOLDS.points['mind.judge'].contradicts);
  for (const row of rows.filter(entry => entry.production && entry.label !== 'arguable' && (entry.label === 'contradicts' || entry.exception || entry.contradicts >= lineLesson))) {
    const item = SET.find(entry => entry.text === row.text), rule = rulesOf(item.project, item.text).find(entry => entry.title === row.rule);
    const one = await confirm(item, rule, false); confirmation.pairs++;
    const two = one >= lineOne ? await confirm(item, rule, true) : null, retired = one >= lineOne && two < lineTwo;
    (retired ? confirmation.retired : confirmation.kept).push(`${row.label === 'contradicts' ? 'REVERSAL' : row.exception ? 'exception' : 'other'}: ${row.text.slice(0, 26)} → ${row.rule} (lesson ${row.contradicts}, rule ${one}${two === null ? '' : `, narrower ${two}`})`);
  }
}
const line = stakeThreshold(DECISION_THRESHOLDS.points['mind.judge'].contradicts);
const scored = rows.filter(row => row.label !== 'arguable' && row.production);
const dist = list => { const sorted = list.map(row => row.contradicts).sort((a, b) => a - b); return { n: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }; };
const summary = {
  line, stake: DECISION_THRESHOLDS.points['mind.judge'].contradicts, calls, inputTokens,
  reversed: dist(scored.filter(row => row.label === 'contradicts')), exception: dist(scored.filter(row => row.exception)),
  tighten: dist(scored.filter(row => row.kind === 'tighten')), detail: dist(scored.filter(row => row.kind === 'detail')), repeat: dist(scored.filter(row => row.kind === 'repeat')),
  other: dist(scored.filter(row => row.label === 'ok' && !row.exception && !['tighten', 'detail', 'repeat'].includes(row.kind))),
  notAskedByProduction: rows.filter(row => !row.production).map(row => `${row.text.slice(0, 24)} → ${row.rule} (${row.contradicts})`),
  byThreshold: [.5, .6, .7, .75, .8, .85, .9, .95].map(t => ({ t, tp: scored.filter(row => row.label === 'contradicts' && row.contradicts >= t).length, fn: scored.filter(row => row.label === 'contradicts' && row.contradicts < t).length,
    fp: scored.filter(row => row.label === 'ok' && row.contradicts >= t).length, falsePositives: scored.filter(row => row.label === 'ok' && row.contradicts >= t).map(row => `${row.kind}: ${row.text.slice(0, 26)} → ${row.rule} (${row.contradicts})`) })),
};
if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify({ at: new Date().toISOString(), base: BASE, summary, confirmation, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (confirmation.pairs) console.log(JSON.stringify({ confirmation: { ...confirmation, retiredRight: confirmation.retired.filter(row => row.startsWith('REVERSAL')).length, retiredWrong: confirmation.retired.filter(row => !row.startsWith('REVERSAL')), keptReversals: confirmation.kept.filter(row => row.startsWith('REVERSAL')), keptNotReversals: confirmation.kept.filter(row => !row.startsWith('REVERSAL')).length } }, null, 2));
