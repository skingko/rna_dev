#!/usr/bin/env node
// Delivered-message evidence for the mind reconcile judge (docs/research/jev-delivery-evidence-probe-20261010.md).
// `conversationPassages` (project-mind.mjs) cuts every message into 420-character windows, appends the presented deliverables
// of a delivered proactive message to its text, and the host sends the three best BM25 windows per open item to JEV (mind.judge
// `answered_<n>`). This replays labelled cases (benchmark/jev-delivery-evidence-cases.mjs) through the production path with
// variants of where and how the deliverables appear, one raw call per (case, variant) through the live daemon's probe
// (POST /api/v2/decision-kernel/probe: no thresholds, cache or ledger; the configured key never leaves the app), and judges the
// answers with the production combine function and thresholds.
//   variants   v0-current is a frozen copy of the 0.70.0 builder; `shipped` is whatever project-mind.mjs does now.
//   --real     the same comparison over the open items of a read-only copy of the live state (RNA_STATE), no labels: how often the
//              chosen windows and the verdict differ between the 0.70.0 builder and `shipped`.
// Usage: node benchmark/jev-delivery-evidence-probe.mjs [--only v0-current,shipped] [--repeat 2] [--real] [--out file.json]
//   RNA_URL (default http://127.0.0.1:4317); RNA_STATE for --real (read-only; never opened as a Store).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStateFile } from '../state-shards.mjs';
import { buildDecisionState, recencyBucket } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState } from '../../../packages/sdk/src/decision-kernel.mjs';
import { mindReconcileTemplate, combineMindReconcile, DECISION_THRESHOLDS, stakeThreshold } from '../../../packages/sdk/src/decision-templates.mjs';
import { conversationPassages, bm25Index, reconcileCandidates, latestEvidenceAt } from '../project-mind.mjs';
import { CASES, HANDOFF_CASES, T0, distractors } from './jev-delivery-evidence-cases.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const repeat = Number(arg('--repeat') ?? 2), outFile = arg('--out'), real = process.argv.includes('--real'), handoff = process.argv.includes('--handoff'), onlyKinds = arg('--kinds')?.split(',') ?? null;
const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
const kernelAnswers = (raw, questions) => Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'boolean', probability: raw?.[id]?.noul }]));
let calls = 0, inputTokens = 0;
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };

// ------------------------------------------------------------------ the window builders under test
const PASSAGE = 420, STEP = 360, PER_MESSAGE = 6000;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const describeOld = value => value && typeof value === 'object' ? [value.title, value.path, value.name, value.summary].filter(part => typeof part === 'string').join(' ') : typeof value === 'string' ? value : '';
const describeNew = value => { if (typeof value === 'string') return value; if (!value || typeof value !== 'object') return ''; const where = value.path ?? value.name ?? value.title ?? '', what = value.description ?? value.summary ?? ''; return `${where}${what ? ` (${what})` : ''}`; };
function windowsOf(value, id, base, out, { cut = true } = {}) {
  const text = cut ? oneLine(value).slice(0, PER_MESSAGE) : oneLine(value);
  for (let start = 0; start < text.length; start += STEP) { out.push({ id: `${id}:${start}`, text: text.slice(start, start + PASSAGE), ...base }); if (start + PASSAGE >= text.length) break; }
}
/** Whole entries packed into windows of at most PASSAGE characters, each window starting with the label. */
function packFiles(label, entries, id, base, out) {
  let current = label, window = 0;
  const flush = () => { if (current.length > label.length) out.push({ id: `${id}:files${window ? `:${window}` : ''}`, text: current.trim(), ...base }); window++; current = label; };
  for (const entry of entries.map(oneLine).filter(Boolean)) { const piece = entry.length > PASSAGE - label.length - 1 ? `${entry.slice(0, PASSAGE - label.length - 2)}…` : entry; if (current.length + piece.length + 2 > PASSAGE && current.length > label.length) flush(); current += `${current.length > label.length ? '; ' : ''}${piece}`; }
  flush();
}
const VARIANTS = {
  'v0-current': { label: ' 交付：', describe: describeOld, place: 'tail' },
  'v1-label-en': { label: ' Delivered: ', describe: describeOld, place: 'tail' },
  'v2-description': { label: ' 交付：', describe: describeNew, place: 'tail' },
  'v3-label-first': { label: 'Delivered: ', describe: describeNew, place: 'head' },
  'v4-tail-in-budget': { label: ' Delivered: ', describe: describeNew, place: 'tail-kept' },
  'v5-own-window': { label: 'Delivered files: ', describe: describeNew, place: 'own' },
  'v6-own-window-zh': { label: '交付文件：', describe: describeNew, place: 'own' },
  'v7-no-deliverables': { place: 'none' },
  'v8-own-window-clip-fixed': { label: 'Delivered files: ', describe: describeNew, place: 'own', fixedClip: true },
};
const retained = row => row && !row.archivedAt && !row.sourceDeleted && !row.contextRevoked;
function variantPassages(state, projectId, spec) {
  const out = [];
  for (const session of state.sessions.filter(row => row.projectId === projectId && retained(row))) {
    const lastReply = new Map(); for (const item of session.items) if (item.kind === 'assistant' && item.turnId && !item.streaming && String(item.text ?? '').trim()) lastReply.set(item.turnId, item.id);
    for (const item of session.items) {
      if (!retained(item) || item.streaming || item.simulated === true) continue;
      const role = item.kind === 'user' && (!item.source || ['user', 'interaction-answer', 'mind-answer'].includes(item.source)) ? 'user' : item.kind === 'assistant' && item.source === 'initiative' ? 'delivered' : item.kind === 'assistant' && (item.final || lastReply.get(item.turnId) === item.id) ? 'assistant' : null;
      if (!role) continue;
      const base = { role, at: item.createdAt, sessionId: session.id, itemId: item.id }, text = String(item.text ?? '');
      const entries = (item.initiative?.deliverables ?? []).map(spec.describe ?? (() => '')).filter(Boolean), presented = entries.join('；');
      if (!entries.length || spec.place === 'none') windowsOf(text, item.id, base, out);
      else if (spec.place === 'tail') windowsOf(`${text}${spec.label}${presented}`, item.id, base, out);
      else if (spec.place === 'tail-kept') { const suffix = `${spec.label}${presented}`; windowsOf(`${oneLine(text).slice(0, PER_MESSAGE - suffix.length)}${suffix}`, item.id, base, out, { cut: false }); }
      else if (spec.place === 'head') { const head = `${spec.label}${presented}. `; windowsOf(`${head}${oneLine(text).slice(0, PER_MESSAGE - head.length)}`, item.id, base, out, { cut: false }); }
      else if (spec.place === 'own') { windowsOf(text, item.id, base, out); packFiles(spec.label, entries, item.id, base, out); }
    }
  }
  for (const job of state.projects.find(row => row.id === projectId)?.jobs ?? []) if (retained(job) && job.simulated !== true && job.status === 'completed' && (job.handoff || job.output)) windowsOf(job.handoff ?? job.output, job.id, { role: 'work', at: job.completedAt ?? job.updatedAt, jobId: job.id }, out);
  return out.filter(row => row.text);
}

// ------------------------------------------------------------------ one judged item (the reconcileNow selection, then the production state and template)
function select(passages, item, { anchor = 0 } = {}) {
  const usable = passage => (time(passage.at) ?? 0) >= anchor;
  let picked = bm25Index(passages).rank(item.text, usable).filter(entry => entry.score > 0).slice(0, 3).map(entry => entry.doc);
  if (!picked.length) picked = passages.filter(usable).filter(passage => passage.role !== 'work').sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0)).slice(0, 2);
  return picked;
}
const clip = (value, limit) => { const text = oneLine(value); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
// `legacyClip`: what the 0.70.0 state builder showed, the `[role · age] ` label counted inside the 420-character budget (the last ~30
// characters of every full window were cut). The builder now cuts the text and then adds the label (`shipped`, v8); every other
// variant is replayed with the old cut so that the comparison between them stays about the windows.
async function judge({ item, picked, now, legacyClip = false }) {
  const state = buildDecisionState('mind.judge', { items: [{ id: item.id, kind: item.kind, text: item.text, createdAt: item.createdAt, passages: picked.map(passage => ({ role: passage.role, at: passage.at, text: passage.text, ref: passage.id })) }] }, { now });
  if (legacyClip) state.mind.items[0].passages = picked.map(passage => clip(`[${passage.role} · ${recencyBucket(now - time(passage.at))}] ${passage.text}`, 420));
  const template = mindReconcileTemplate({ items: [{ kind: item.kind }] }), questions = wire(template);
  const body = await probe(minimizeDecisionState(state, { maxChars: 10000 }), questions);
  const verdict = combineMindReconcile(kernelAnswers(body.answers, questions));
  return { answered: round(body.answers.answered_0?.noul), superseded: round(body.answers.superseded_0?.noul), closedAs: verdict.answered.includes(0) ? 'answered' : verdict.superseded.includes(0) ? 'superseded' : null, shown: state.mind.items[0].passages, tokens: body.usage?.input_tokens };
}

// ------------------------------------------------------------------ labelled cases
const caseState = testCase => {
  const items = [], at = minutes => new Date(T0 + minutes * 60000).toISOString(), shuffled = [{ ...testCase.key, key: true }, ...distractors(testCase.language).map(([role, text]) => ({ role, text }))];
  const placement = { 0: 130, 1: 60, 2: 190, 3: 240 };
  shuffled.forEach((message, index) => items.push({ id: `${testCase.id}-m${index}`, kind: message.role === 'user' ? 'user' : 'assistant', ...(message.role === 'delivered' ? { source: 'initiative', ...(message.deliverables ? { initiative: { deliverables: message.deliverables } } : {}) } : message.role === 'assistant' ? { final: true } : {}), text: message.text, createdAt: at(placement[index]), simulated: false }));
  items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { sessions: [{ id: `${testCase.id}-s`, projectId: 'p', items }], projects: [{ id: 'p', jobs: [] }] };
};
const NOW = T0 + 30 * 3600000;
async function runCases(names) {
  const rows = [];
  for (const name of names) {
    const spec = name === 'shipped' ? null : VARIANTS[name];
    await Promise.all(CASES.filter(testCase => !onlyKinds || onlyKinds.includes(testCase.kind)).map(async testCase => {
      const state = caseState(testCase), passages = spec ? variantPassages(state, 'p', spec) : conversationPassages(state, 'p');
      const item = { id: `${testCase.id}-a`, kind: testCase.item.kind, text: testCase.item.text, createdAt: new Date(T0).toISOString() }, picked = select(passages, item, { anchor: T0 });
      const file = testCase.key.deliverables?.[0]?.path ?? '', basename = file.split('/').pop();
      const runs = [];
      for (let round = 0; round < repeat; round++) runs.push(await judge({ item, picked, now: NOW, legacyClip: Boolean(spec && !spec.fixedClip) }));
      const mean = key => round(runs.reduce((sum, run) => sum + (run[key] ?? 0), 0) / runs.length);
      const filesPicked = picked.some(passage => passage.text.includes(basename)), filesShown = runs[0].shown.some(text => text.includes(basename));
      const answered = mean('answered'), superseded = mean('superseded'), threshold = stakeThreshold(DECISION_THRESHOLDS.points['mind.judge'].answered);
      rows.push({ variant: name, id: testCase.id, kind: testCase.kind, expect: testCase.expect, answered, superseded, closed: answered >= threshold ? 'answered' : superseded >= threshold ? 'superseded' : null, filesPicked, filesShown, windows: passages.length, picked: picked.map(passage => passage.id.replace(`${testCase.id}-`, '')), tokens: runs[0].tokens, spread: round(Math.max(...runs.map(run => run.answered)) - Math.min(...runs.map(run => run.answered))) });
    }));
  }
  return rows;
}
const summarize = rows => {
  const out = {};
  for (const variant of [...new Set(rows.map(row => row.variant))]) {
    const own = rows.filter(row => row.variant === variant), yes = own.filter(row => row.expect === 'yes'), no = own.filter(row => !(row.expect === 'yes'));
    const mean = list => list.length ? round(list.reduce((sum, row) => sum + row.answered, 0) / list.length) : null;
    const group = kind => { const rowsOf = own.filter(row => row.kind === kind); return rowsOf.length ? `${rowsOf.filter(row => (row.expect === 'yes') === (row.closed === 'answered') && (row.expect === 'yes' || row.closed === null)).length}/${rowsOf.length}` : null; };
    out[variant] = { correct: own.filter(row => row.expect === 'yes' ? row.closed === 'answered' : row.closed === null).length, total: own.length, truePositive: yes.filter(row => row.closed === 'answered').length, yesTotal: yes.length, falseClose: no.filter(row => row.closed !== null).length, noTotal: no.length, meanAnsweredYes: mean(yes), meanAnsweredNo: mean(no), filesPicked: own.filter(row => row.filesPicked).length, filesShown: own.filter(row => row.filesShown).length, byKind: Object.fromEntries(['settled', 'unsettled', 'irrelevant', 'long-tail', 'mid-tail', 'many-files', 'long-body'].map(kind => [kind, group(kind)])) };
  }
  return out;
};

// ------------------------------------------------------------------ job handoffs: the worker's marker label kept (0.70.0) or dropped (shipped)
// The same ten handoffs as the evidence of an open item, in three forms: `zh-marker` and `en-marker` are the 0.70.0 passage (`交接：…` /
// `HANDOFF: …` shown as written), `shipped` is what conversationPassages makes of a handoff carrying either marker (the label dropped).
async function runHandoff() {
  const rows = [], at = minutes => new Date(T0 + minutes * 60000).toISOString();
  for (const form of ['zh-marker', 'en-marker', 'shipped']) {
    await Promise.all(HANDOFF_CASES.map(async testCase => {
      const items = distractors(testCase.language).map(([role, text], index) => ({ id: `${testCase.id}-m${index}`, kind: role === 'user' ? 'user' : 'assistant', ...(role === 'delivered' ? { source: 'initiative' } : role === 'assistant' ? { final: true } : {}), text, createdAt: at([60, 130, 240][index]), simulated: false }));
      const marker = form === 'en-marker' ? 'HANDOFF: ' : '交接：', job = { id: `${testCase.id}-job`, status: 'completed', completedAt: at(150), handoff: `${marker}${testCase.handoff}` };
      const state = { sessions: [{ id: `${testCase.id}-s`, projectId: 'p', items }], projects: [{ id: 'p', jobs: form === 'shipped' ? [job] : [] }] }, passages = conversationPassages(state, 'p');
      if (form !== 'shipped') windowsOf(job.handoff, job.id, { role: 'work', at: job.completedAt, jobId: job.id }, passages);
      const item = { id: `${testCase.id}-a`, kind: 'todo', text: testCase.item, createdAt: new Date(T0).toISOString() }, picked = select(passages, item, { anchor: T0 }), runs = [];
      for (let index = 0; index < repeat; index++) runs.push(await judge({ item, picked, now: NOW }));
      const answered = round(runs.reduce((sum, run) => sum + run.answered, 0) / runs.length), threshold = stakeThreshold(DECISION_THRESHOLDS.points['mind.judge'].answered);
      rows.push({ form, id: testCase.id, expect: testCase.expect, answered, closed: answered >= threshold, workPicked: picked.some(passage => passage.role === 'work'), shown: runs[0].shown.find(text => text.startsWith('[work')) ?? null });
    }));
  }
  return rows;
}

// ------------------------------------------------------------------ the live state (read-only): which windows and verdicts change
async function runReal(names) {
  const stateFile = process.env.RNA_STATE ?? fileURLToPath(new URL('../.state/state.json', import.meta.url));
  const live = structuredClone(readStateFile(stateFile).state), now = Date.now(), rows = [];
  for (const project of live.projects.filter(row => !row.archivedAt && row.simulated !== true && row.mind)) {
    const candidates = reconcileCandidates(project, latestEvidenceAt(live, project.id), { now, force: true }).filter(entry => entry.collection !== 'lessons');
    for (const name of names) {
      const spec = name === 'shipped' ? null : VARIANTS[name], passages = spec ? variantPassages(live, project.id, spec) : conversationPassages(live, project.id);
      for (const { collection, row } of candidates) {
        const text = collection === 'commitments' ? row.request : row.text, kind = collection === 'agenda' ? row.kind : `commitment_${row.trigger}`;
        const anchor = row.source?.kind === 'migration' ? 0 : Math.min(time(row.createdAt) ?? now, ...(row.evidence ?? []).map(entry => time(entry.at) ?? now));
        const own = new Set([row.source?.itemId, ...(row.evidence ?? []).map(entry => entry.itemId)].filter(Boolean));
        const picked = select(passages.filter(passage => !own.has(passage.itemId)), { text }, { anchor });
        if (!picked.length) { rows.push({ variant: name, project: project.name, item: text.slice(0, 40), picked: [], answered: null }); continue; }
        const run = await judge({ item: { id: row.id, kind, text, createdAt: row.createdAt }, picked, now, legacyClip: Boolean(spec && !spec.fixedClip) });
        rows.push({ variant: name, project: project.name, itemId: row.id, picked: picked.map(passage => passage.id), withFiles: picked.some(passage => /Delivered|交付/.test(passage.text)), answered: run.answered, superseded: run.superseded, closedAs: run.closedAs });
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------ run
const names = (arg('--only') ?? `${Object.keys(VARIANTS).join(',')},shipped`).split(',');
const results = { at: new Date().toISOString(), base: BASE, repeat, threshold: DECISION_THRESHOLDS.points['mind.judge'].answered, cases: CASES.length };
// Which variant the production builder equals (the check that the shipped code is one of the measured variants).
{ const same = {}; for (const name of Object.keys(VARIANTS)) same[name] = CASES.every(testCase => { const state = caseState(testCase); return JSON.stringify(variantPassages(state, 'p', VARIANTS[name]).map(({ id, text, role }) => [id, text, role])) === JSON.stringify(conversationPassages(state, 'p').map(({ id, text, role }) => [id, text, role])); }); results.productionEquals = Object.keys(same).filter(name => same[name]); }
if (handoff) results.handoff = await runHandoff();
else if (!real) { results.rows = await runCases(names); results.summary = summarize(results.rows); }
else results.real = await runReal(names);
results.calls = calls; results.inputTokens = inputTokens;
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 1));
if (handoff) { for (const form of ['zh-marker', 'en-marker', 'shipped']) { const own = results.handoff.filter(row => row.form === form), yes = own.filter(row => row.expect === 'yes'), no = own.filter(row => row.expect !== 'yes'), mean = list => round(list.reduce((sum, row) => sum + row.answered, 0) / list.length); console.log(form.padEnd(10), `correct ${own.filter(row => row.closed === (row.expect === 'yes')).length}/${own.length}`, `p(yes cases) ${mean(yes)}`, `p(no cases) ${mean(no)}`, `work window picked ${own.filter(row => row.workPicked).length}/${own.length}`); } for (const row of results.handoff.filter(row => row.form === 'shipped' || row.form === 'zh-marker').sort((a, b) => a.id.localeCompare(b.id) || a.form.localeCompare(b.form))) console.log(row.id, row.form.padEnd(10), row.expect, row.answered, row.closed ? 'closed' : ''); }
else if (!real) { console.log('production builder equals:', results.productionEquals.join(', ') || '(none of the variants)'); console.table(results.summary, ['correct', 'total', 'truePositive', 'yesTotal', 'falseClose', 'noTotal', 'meanAnsweredYes', 'meanAnsweredNo', 'filesPicked', 'filesShown']); console.log(JSON.stringify(Object.fromEntries(Object.entries(results.summary).map(([name, row]) => [name, row.byKind])), null, 1)); }
else console.log(JSON.stringify(results.real.slice(0, 80), null, 1));
console.log(`calls ${calls}, input tokens ${inputTokens}`);
