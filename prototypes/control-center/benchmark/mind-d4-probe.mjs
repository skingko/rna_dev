#!/usr/bin/env node
// D4 probes (docs/research/mind-d4-probes-20261005.md), through the live daemon only: read-only GETs and the JEV probe
// (POST /api/v2/decision-kernel/probe: one raw call with the app's configured key, no thresholds, cache or ledger; the key never
// leaves the app). No paid model call. Production state builders, templates and combine functions; the cases are in
// mind-d4-cases.mjs (synthetic, labelled by hand).
//   restates  MIND-5: turn.route's `restates_pending_request` choice, sent inside the whole production capture plan.
//   promise   MIND-4: turn.settled's `commits_to_later_work` noul (with `waiting_on_user`), against the retired agent_promise regex.
//   waiting   D4 review: turn.settled's `waiting_on_user` read as "the reply ended waiting for the user" (it silences the request that reply answered).
//   notes-saving  what the notes dedupe saves in the notes block (tokens), over a state copy.
//   covered   D4 notes: mind.judge's `covered_<n>` over a state copy's preference notes (or OpenViking bullets) and the standing
//             rules (RNA_STATE: a copy of the live state file, read only, never opened as a Store).
// Usage: node benchmark/mind-d4-probe.mjs [--only restates,promise,covered] [--runs 2] [--out file.json]
import { writeFileSync, readFileSync } from 'node:fs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState } from '../../../packages/sdk/src/decision-kernel.mjs';
import { turnRouteTemplate, turnSettledTemplate, replySentences, combineCapture, combineTurnSettled, mindCoveredTemplate, combineMindCovered, stakeVerdict, DECISION_THRESHOLDS } from '../../../packages/sdk/src/decision-templates.mjs';
import { agentPromises } from '../project-mind.mjs';
import { RESTATES_CASES, PROMISE_CASES, WAITING_CASES } from './mind-d4-cases.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const only = new Set((arg('--only') ?? 'restates,promise').split(',')), runs = Math.max(1, Number(arg('--runs') ?? 1));
const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
let calls = 0, inputTokens = 0;
export async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
/** A raw probe answer as the kernel hands it to the combine functions. */
const kernel = raw => raw?.type === 'choice' || raw?.choice !== undefined ? { type: 'choice', choice: raw.choice, probabilities: raw.probabilities, ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}) } : { type: 'boolean', probability: raw?.noul };
const results = { at: new Date().toISOString(), base: BASE, runs, suites: {} };

// ----------------------------------------------------------------------------------------------------- restates (MIND-5)
export function restatesCase(row, { now = Date.now() } = {}) {
  const requests = row.pending.map(text => ({ text }));
  const plan = turnRouteTemplate({ efforts: ['low', 'medium', 'high'], memory: true, tools: true, skills: [], background: false, fastModel: null, capture: { outputs: [{ text: '好的，已处理。' }], threads: [], questions: [], requests } });
  const state = buildDecisionState('turn.route', { message: row.message, previousStatus: 'completed', previousUserAt: now - 3600000, previousReply: '好的，已处理。', project: { title: row.project.title, goal: row.project.goal } }, { now });
  return { plan, state: minimizeDecisionState(state, { maxChars: 6000 }), requests };
}
/** The index of the pending request a join at `threshold` would pick (the combine function's reading, with the line moved), or null. */
export const joinedAt = (answer, requests, threshold) => { const verdict = stakeVerdict(answer, threshold), match = typeof verdict === 'string' ? /^req_([0-9])$/.exec(verdict) : null; return match && Number(match[1]) < requests ? Number(match[1]) : null; };
if (only.has('restates')) {
  const rows = [];
  for (const row of RESTATES_CASES) for (let run = 0; run < runs; run++) {
    const { plan, state, requests } = restatesCase(row), body = await probe(state, wire(plan)), answer = kernel(body.answers.restates_pending_request);
    const top = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
    rows.push({ id: row.id, hard: row.hard === true, label: row.label, choice: answer.choice, p: round(top?.[1]), probabilities: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([key, value]) => [key, round(value)])), pLabel: round(answer.probabilities?.[row.label]), run });
  }
  const summarize = threshold => {
    const out = { threshold, rightJoin: 0, wrongJoin: 0, wrongTarget: 0, missedJoin: 0, rightNone: 0 };
    for (const row of rows) {
      const answer = { type: 'choice', choice: row.choice, probabilities: row.probabilities };
      const target = row.label === 'none' ? null : Number(row.label.slice(4)), count = Math.max(...Object.keys(row.probabilities).filter(key => /^req_/.test(key)).map(key => Number(key.slice(4)) + 1), 0);
      const got = joinedAt(answer, count, threshold);
      if (row.label === 'none') got === null ? out.rightNone++ : out.wrongJoin++;
      else if (got === null) out.missedJoin++; else if (got === target) out.rightJoin++; else out.wrongTarget++;
    }
    return out;
  };
  results.suites.restates = { rows, byThreshold: [.7, .75, .8, .85, .9, .95].map(summarize), configured: DECISION_THRESHOLDS.points['turn.capture'].restates };
}

// ------------------------------------------------------------------------------------------------------ promise (MIND-4)
export function promiseCase(row, { now = Date.now() } = {}) {
  const sentences = replySentences(row.reply), plan = turnSettledTemplate({ scheduled: false, askedBefore: false, sentences });
  const state = buildDecisionState('turn.settled', { request: row.request, reply: row.reply, effects: [], continuations: 0, project: { title: row.project.title, taskTypes: [] } }, { now });
  return { plan, sentences, state: minimizeDecisionState(state, { maxChars: 8000 }) };
}
if (only.has('promise')) {
  const rows = [];
  for (const row of PROMISE_CASES) for (let run = 0; run < runs; run++) {
    const { plan, sentences, state } = promiseCase(row), body = await probe(state, wire(plan)), located = body.answers.promise_sentence ? kernel(body.answers.promise_sentence) : null;
    const pick = located ? stakeVerdict(located, DECISION_THRESHOLDS.points['turn.settled'].promise) : undefined, index = typeof pick === 'string' && /^s_[0-9]$/.test(pick) ? Number(pick.slice(2)) : null;
    rows.push({ id: row.id, hard: row.hard === true, label: row.label, commits: round(body.answers.commits_to_later_work?.noul), waiting: round(body.answers.waiting_on_user?.noul), regex: agentPromises(row.reply).length > 0, run,
      ...(located ? { sentences: sentences.length, located: located.choice, pLocated: round(located.probabilities?.[located.choice]), locatedRight: row.sentence ? index !== null && sentences[index]?.includes(row.sentence) : null } : {}) });
  }
  const at = threshold => {
    const out = { threshold, truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, unsure: 0 }, waitingStake = DECISION_THRESHOLDS.points['turn.settled'].waiting;
    for (const row of rows) {
      // combineTurnSettled's reading of the two answers, with the promise line moved.
      const committed = stakeVerdict({ type: 'boolean', probability: row.commits }, threshold), blocked = stakeVerdict({ type: 'boolean', probability: row.waiting }, waitingStake);
      const promise = committed === false || committed === true && blocked === true ? false : committed === true && blocked === false ? true : null;
      if (promise === null) { out.unsure++; if (row.label) out.falseNegative++; continue; }
      if (promise) row.label ? out.truePositive++ : out.falsePositive++; else row.label ? out.falseNegative++ : out.trueNegative++;
    }
    return out;
  };
  const regex = { truePositive: rows.filter(row => row.label && row.regex).length, falsePositive: rows.filter(row => !row.label && row.regex).length, falseNegative: rows.filter(row => row.label && !row.regex).length, trueNegative: rows.filter(row => !row.label && !row.regex).length };
  results.suites.promise = { locator: { asked: rows.filter(row => row.located).length, right: rows.filter(row => row.locatedRight === true).length, wrong: rows.filter(row => row.label && row.located && row.locatedRight === false).length }, rows, byThreshold: [.6, .75, .85, .9, .95].map(at), regex, configured: DECISION_THRESHOLDS.points['turn.settled'].promise };
}

// ------------------------------------------------------------------------------------------------- waiting (D4 review)
// The same production turn.settled plan as `promise`, read for `waiting_on_user` alone: a `true` verdict leaves the request that reply took on
// unowed until the user speaks again (project-mind.mjs afterTurnNow), so a wrong yes is the costly side.
if (only.has('waiting')) {
  const rows = [];
  for (const row of WAITING_CASES) for (let run = 0; run < runs; run++) {
    const { plan, state } = promiseCase(row), body = await probe(state, wire(plan));
    rows.push({ id: row.id, hard: row.hard === true, label: row.label, waiting: round(body.answers.waiting_on_user?.noul), complete: round(body.answers.instruction_complete?.noul), run });
  }
  const at = threshold => {
    const out = { threshold, rightWaiting: 0, missedWaiting: 0, wrongWaiting: 0, rightNot: 0, unsure: 0, hardWrongWaiting: 0 };
    for (const row of rows) {
      const says = stakeVerdict({ type: 'boolean', probability: row.waiting }, threshold), unsure = says === null || says === undefined;
      if (row.hard) { if (says === true && !row.label) out.hardWrongWaiting++; continue; }
      if (unsure) out.unsure++;
      if (row.label) says === true ? out.rightWaiting++ : out.missedWaiting++; else says === true ? out.wrongWaiting++ : out.rightNot++;
    }
    return out;
  };
  const probs = list => list.map(row => row.waiting).sort((a, b) => a - b);
  results.suites.waiting = { rows, byThreshold: [.6, .7, .75, .8, .85, .9, .95].map(at), configured: DECISION_THRESHOLDS.points['turn.settled'].waiting,
    waitingP: probs(rows.filter(row => row.label)), notWaitingP: probs(rows.filter(row => !row.label && !row.hard)), hardP: rows.filter(row => row.hard).map(row => [row.id, row.waiting]) };
}

// ---------------------------------------------------------------------------------------------------- covered (notes)
if (only.has('covered')) {
  const { readStateFile } = await import('../state-shards.mjs');
  const { selectLessons } = await import('../project-mind.mjs');
  const state = readStateFile(process.env.RNA_STATE).state;
  const suite = {};
  for (const project of state.projects.filter(row => !row.archivedAt && row.simulated !== true && row.mind)) {
    const notes = (project.mind.notes?.preferences ?? []).filter(row => !row.stale), { always } = selectLessons(project, '');
    if (!notes.length || !always.length) continue;
    const rules = always.map(row => ({ text: row.text }));
    const rows = [];
    for (let at = 0; at < notes.length; at += 12) {
      const batch = notes.slice(at, at + 12);
      const stateOf = buildDecisionState('mind.judge', { rows: batch.map(row => ({ kind: 'note', text: row.text })), rules }, { now: Date.now() });
      const body = await probe(minimizeDecisionState(stateOf, { maxChars: 10000 }), wire(mindCoveredTemplate({ rows: batch.length })));
      batch.forEach((row, index) => rows.push({ text: row.text, p: round(body.answers[`covered_${index}`]?.noul) }));
    }
    suite[project.name] = { rules: rules.map(row => row.text), rows, stake: DECISION_THRESHOLDS.points['mind.judge'].covered };
    // Hand labels (RNA_COVERED_LABELS: { project name: { covered: [note index], hard: [note index] } }; kept outside the repository, the notes are the user's).
    const labels = process.env.RNA_COVERED_LABELS ? JSON.parse(readFileSync(process.env.RNA_COVERED_LABELS, 'utf8'))[project.name] : null;
    if (labels) suite[project.name].byThreshold = [.6, .7, .75, .8, .85, .9].map(threshold => {
      const out = { threshold, rightCovered: 0, missedCovered: 0, wrongCovered: 0, rightNot: 0, hardCovered: 0 };
      rows.forEach((row, index) => { const yes = labels.covered.includes(index), hard = labels.hard.includes(index), says = stakeVerdict({ type: 'boolean', probability: row.p }, threshold) === true; if (hard) { if (says) out.hardCovered++; return; } if (yes) says ? out.rightCovered++ : out.missedCovered++; else says ? out.wrongCovered++ : out.rightNot++; });
      return { ...out, highestNotCovered: Math.max(...rows.filter((_, index) => !labels.covered.includes(index)).map(row => row.p)), lowestCovered: Math.min(...rows.filter((_, index) => labels.covered.includes(index) && !labels.hard.includes(index)).map(row => row.p)) };
    });
  }
  results.suites.covered = suite;
}

// ------------------------------------------------------------------------------- notes-saving (what the dedupe saves)
// The notes block as the mind sends it, before and after the preference notes the rules already state are left out (the last ten of
// each list; the judge's answer at the shipped line, plus equal text), over a state copy. Tokens: the SDK's own estimate of the
// block as a host-context attachment. The notes block is sent once per conversation and again when it changes or after a compaction.
if (only.has('notes-saving')) {
  const { readStateFile } = await import('../state-shards.mjs');
  const { selectLessons, mindContextUpdates, liveNotes, normalizedKeyOf } = await import('../project-mind.mjs');
  const { prepareContext } = await import('../../../packages/sdk/src/context.mjs');
  const tokens = text => prepareContext({ messages: [{ role: 'user', content: [{ type: 'text', text: '.' }], context: text ? [{ source: 'host-project-mind', text }] : [] }] }).estimatedInputTokens;
  const state = readStateFile(process.env.RNA_STATE).state, suite = {}, stake = DECISION_THRESHOLDS.points['mind.judge'].covered;
  for (const project of state.projects.filter(row => !row.archivedAt && row.simulated !== true && row.mind)) {
    const notes = liveNotes(project.mind.notes), { always } = selectLessons(project, '');
    if (!(notes?.preferences ?? []).length || !always.length) continue;
    const rules = always.map(row => ({ text: row.text })), last = notes.preferences.slice(-10), seen = new Set(rules.map(row => normalizedKeyOf(row.text)));
    const stateOf = buildDecisionState('mind.judge', { rows: last.map(row => ({ kind: 'note', text: row.text })), rules }, { now: Date.now() });
    const body = await probe(minimizeDecisionState(stateOf, { maxChars: 10000 }), wire(mindCoveredTemplate({ rows: last.length })));
    const answers = Object.fromEntries(last.map((_, index) => [`covered_${index}`, kernel(body.answers[`covered_${index}`])]));
    const covered = new Set(combineMindCovered(answers, { rows: last.length }).covered);
    const kept = last.filter((row, index) => !seen.has(normalizedKeyOf(row.text)) && !covered.has(index));
    const block = list => mindContextUpdates({ rules: always, notes: { ...notes, facts: notes.facts.slice(-10), preferences: list } }).find(update => update.key === 'project-mind-notes').text;
    const before = tokens(block(last)), after = tokens(block(kept)), rulesBlock = tokens(mindContextUpdates({ rules: always }).find(update => update.key === 'project-mind-rules').text);
    suite[project.name] = { preferenceNotes: notes.preferences.length, injected: last.length, leftOut: last.length - kept.length, notesBlockTokens: { before, after, saved: before - after }, rulesBlockTokens: rulesBlock };
  }
  results.suites['notes-saving'] = suite;
}

// -------------------------------------------------------------------------------- covered (OpenViking preference passages)
// How much of what OpenViking's `preferences/` files say (the unit is a bullet of a file's abstract, as recall attaches it) the model
// already reads in the rules block and the notes block: the lines a recall could leave out. A file is fully covered when every bullet is.
if (only.has('covered-ov')) {
  const { readStateFile } = await import('../state-shards.mjs');
  const { selectLessons } = await import('../project-mind.mjs');
  const get = async path => { const response = await fetch(`${BASE}${path}`); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
  const state = readStateFile(process.env.RNA_STATE).state, suite = {};
  for (const project of state.projects.filter(row => !row.archivedAt && row.simulated !== true && row.mind && (row.memorySessions ?? []).some(binding => binding.memoryNamespace))) {
    const namespace = project.memorySessions.find(binding => binding.memoryNamespace).memoryNamespace, root = await get(`/api/projects/${project.id}/memory?uri=${encodeURIComponent(`${namespace}/preferences`)}&limit=100`), files = [];
    for (const entry of root.entries) { if (entry.isLeaf) { files.push(entry.uri); continue; } const inner = await get(`/api/projects/${project.id}/memory?uri=${encodeURIComponent(entry.uri)}&limit=100`); files.push(...inner.entries.filter(row => row.isLeaf).map(row => row.uri)); }
    const abstracts = new Map();
    for (const uri of files) { if (abstracts.has(uri)) continue; const found = await get(`/api/projects/${project.id}/memory?query=${encodeURIComponent(decodeURIComponent(uri.split('/').at(-1)).replace(/\.md$/, '').replace(/_/g, ' '))}&limit=10`); for (const row of found.entries ?? []) if (files.includes(row.uri) && row.summary && !abstracts.has(row.uri)) abstracts.set(row.uri, row.summary); }
    const { always } = selectLessons(project, ''), notes = (project.mind.notes?.preferences ?? []).filter(row => !row.stale).slice(-10);
    const rules = [...always.map(row => ({ text: row.text })), ...notes.map(row => ({ text: row.text }))].slice(0, 24);
    const bullets = files.flatMap(uri => (abstracts.get(uri) ?? '').split('\n').map(line => line.replace(/^\s*-\s*/, '').trim()).filter(line => line.length > 6).map(text => ({ uri, text })));
    const answers = [];
    for (let at = 0; at < bullets.length; at += 12) {
      const batch = bullets.slice(at, at + 12), body = await probe(minimizeDecisionState(buildDecisionState('mind.judge', { rows: batch.map(row => ({ kind: 'line', text: row.text })), rules }, { now: Date.now() }), { maxChars: 10000 }), wire(mindCoveredTemplate({ rows: batch.length })));
      batch.forEach((row, index) => answers.push({ ...row, p: round(body.answers[`covered_${index}`]?.noul) }));
    }
    const stake = DECISION_THRESHOLDS.points['mind.judge'].covered, covered = row => stakeVerdict({ type: 'boolean', probability: row.p }, stake) === true;
    const perFile = [...new Set(answers.map(row => row.uri))].map(uri => { const rows = answers.filter(row => row.uri === uri); return { uri: decodeURIComponent(uri.split('/').slice(-2).join('/')), bullets: rows.length, covered: rows.filter(covered).length, chars: rows.reduce((sum, row) => sum + row.text.length, 0), coveredChars: rows.filter(covered).reduce((sum, row) => sum + row.text.length, 0) }; });
    suite[project.name] = { rules: rules.length, files: files.length, bullets: answers.length, covered: answers.filter(covered).length, perFile, rows: answers, fullyCoveredFiles: perFile.filter(row => row.bullets && row.covered === row.bullets).length };
  }
  results.suites['covered-ov'] = suite;
}

results.calls = calls; results.inputTokens = inputTokens;
const out = arg('--out');
if (out) writeFileSync(out, JSON.stringify(results, null, 1));
for (const [name, suite] of Object.entries(results.suites)) {
  console.log(`\n== ${name}`);
  if (suite.byThreshold) console.table(suite.byThreshold);
  if (suite.regex) console.log('retired regex:', suite.regex);
  if (suite.locator) console.log('locator:', suite.locator);
  if (name === 'notes-saving') console.log(JSON.stringify(suite, null, 1));
  if (name === 'covered') for (const [project, row] of Object.entries(suite)) if (row.byThreshold) { console.log(project); console.table(row.byThreshold); }
}
console.log(`\n${calls} calls, ${inputTokens} input tokens`);
