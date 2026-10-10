#!/usr/bin/env node
// P2 D1 review: how many of the lessons a message plainly calls for does the production path ask the exposure judge about at all?
// No daemon and no model: the host's own selectLessons / exposureCandidates over the labelled set (rule-use-cases.mjs EXPOSE_CASES,
// the novel family's twelve lessons written as pitfalls, which the standing-rules block does not carry), counted against the
// `yes` labels. "keyword" is the candidates selectLessons finds by words shared with the message (what exposure asked before the
// review: the keyword prefilter), "asked" is exposureCandidates now (those, then every other lesson in force while there is room).
// Usage: node benchmark/rule-exposure-recall.mjs [--lessons N] [--newer]   (N: pad the project with N more unrelated lessons, older than the
//   novel's unless --newer: the limit of EXPOSE_LESSON_LIMIT lessons per message is where the newest ones win the room)
import { ensureMind, addLesson, selectLessons, exposureCandidates } from '../project-mind.mjs';
import { EXPOSE_CASES, family } from './rule-use-cases.mjs';

const pad = process.argv.includes('--lessons') ? Number(process.argv[process.argv.indexOf('--lessons') + 1]) || 0 : 0, newer = process.argv.includes('--newer'), now = Date.parse('2026-10-05T08:00:00Z');
const project = { id: 'p', mind: null, taskTypes: [] };
const mind = ensureMind(project, now);
const rules = family('novel').lessons, ids = rules.map((text, index) => addLesson(mind, { kind: 'pitfall', text, scope: 'project', source: { kind: 'correction' } }, { now: now - (rules.length - index) * 1000 }).id);
for (let index = 0; index < pad; index++) addLesson(mind, { kind: 'pitfall', text: `Unrelated filler lesson number ${index} about spreadsheets and invoices.`, scope: 'project', source: { kind: 'correction' } }, { now: newer ? now + (index + 1) * 1000 : now - (rules.length + index + 1) * 1000 });
let yes = 0, keyword = 0, asked = 0, perCase = [];
for (const row of EXPOSE_CASES.filter(item => item.family === 'novel')) {
  const wanted = row.yes.filter(key => key.startsWith('L')).map(key => ids[Number(key.slice(1))]);
  if (!wanted.length) continue;
  const selected = selectLessons(project, row.message, { now }), byKeyword = new Set(selected.candidates.map(item => item.id)), byExposure = new Set(exposureCandidates(project, selected, row.message).lessons.map(item => item.id));
  const k = wanted.filter(id => byKeyword.has(id)).length, a = wanted.filter(id => byExposure.has(id)).length;
  yes += wanted.length; keyword += k; asked += a; perCase.push(`${row.id}: ${wanted.length} labelled yes, ${k} by keyword, ${a} asked`);
}
console.log(JSON.stringify({ lessonsInProject: rules.length + pad, labelledYesPairs: yes, byKeyword: keyword, asked, perCase }, null, 1));
