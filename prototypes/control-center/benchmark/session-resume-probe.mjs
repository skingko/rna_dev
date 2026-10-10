#!/usr/bin/env node
// session.resume labelled probe (spec p1 compaction §D7). Cases come from session journals (read-only; pass copies):
// every idle gap past the learned cache survival after which the user came back is a positive; the final idle period of
// a conversation dormant for 7+ days is a negative. The state is built with the production state builder at the moment
// the idle service would decide (cache survival after the last request), and sent to the live daemon's probe
// (POST /api/v2/decision-kernel/probe: one raw call with the app's configured key; no thresholds, cache or ledger).
//
//   node benchmark/session-resume-probe.mjs <dir with <sessionId>/*.rna.jsonl> [--cold-min 137] [--now ISO] [--dry] [--out file.json]
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournalRecords } from '../../../packages/sdk/src/journal.mjs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { sessionResumeTemplate } from '../../../packages/sdk/src/decision-templates.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317', DAY = 86400000;
const arg = (name, fallback = null) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : fallback; };
const root = process.argv[2], coldMs = Number(arg('--cold-min', 137)) * 60000, now = Date.parse(arg('--now', new Date().toISOString())), dry = process.argv.includes('--dry');
if (!root) { console.error('usage: session-resume-probe.mjs <journal dir> [--cold-min 137] [--now ISO] [--dry] [--out file]'); process.exit(2); }
const idleBucket = ms => ms < 3 * 3600000 ? 'under_3h' : ms < 12 * 3600000 ? '3h_to_12h' : ms < DAY ? '12h_to_1d' : ms < 3 * DAY ? '1d_to_3d' : ms < 7 * DAY ? '3d_to_7d' : 'over_7d';
const countBucket = count => count === 0 ? 'none' : count <= 2 ? '1_to_2' : count <= 9 ? '3_to_9' : '10_or_more';
const textOf = message => (Array.isArray(message?.content) ? message.content : []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/** Turns of one journal: start (user message) and end (last answer before the next start). */
function turnsOf(file) {
  let header = null; const turns = [];
  for (const { type, data } of readJournalRecords(file, { verify: false, wantEvent: () => false })) {
    if (type === 'session_header') header = data;
    const message = type === 'message' || type === 'inbox_claimed' ? data?.message : type === 'request_completed' && data?.discarded !== true ? data?.message : null;
    if (!message) continue;
    if (message.role === 'user' && ['user', 'followUp'].includes(message.source) && Number.isFinite(message.timestamp)) turns.push({ start: message.timestamp, user: textOf(message), end: message.timestamp, reply: '' });
    else if (message.role === 'assistant' && turns.length && Number.isFinite(message.timestamp)) { const turn = turns.at(-1); turn.end = Math.max(turn.end, message.timestamp); const text = textOf(message); if (text.trim()) turn.reply = text; }
  }
  return { header, turns };
}
const sessions = readdirSync(root).filter(name => name !== 'initiative').flatMap(name => readdirSync(join(root, name)).filter(file => file.endsWith('.rna.jsonl')).map(file => ({ session: name, ...turnsOf(join(root, name, file)) }))).filter(row => row.header && row.turns.length);
const cases = [];
for (const row of sessions) {
  const projectId = row.header.projectId;
  row.turns.forEach((turn, index) => {
    const next = row.turns[index + 1], decidedAt = turn.end + coldMs;
    const label = next ? (next.start - turn.end >= coldMs ? 'returned' : null) : now - turn.end >= 7 * DAY ? 'not_returned' : null;
    if (!label) return;
    const inWeek = rows => rows.filter(item => item.start <= decidedAt && item.start >= decidedAt - 7 * DAY).length;
    const siblings = sessions.filter(item => item.header.projectId === projectId);
    const latest = siblings.reduce((best, item) => { const last = Math.max(...item.turns.filter(value => value.end <= decidedAt).map(value => value.end), -Infinity); return last > best.at ? { id: item.session, at: last } : best; }, { id: null, at: -Infinity });
    const input = { sessionId: row.session, idle: idleBucket(coldMs), conversationTurns: countBucket(inWeek(row.turns)), latest: latest.id === row.session, projectTurns: countBucket(siblings.reduce((sum, item) => sum + inWeek(item.turns), 0)), lastUserMessage: turn.user.slice(0, 600), lastReply: turn.reply.slice(-400), plan: [] };
    cases.push({ session: row.session.slice(0, 8), at: new Date(turn.end).toISOString(), gapMin: next ? Math.round((next.start - turn.end) / 60000) : null, label, input });
  });
}
console.error(`${cases.length} cases: ${cases.filter(row => row.label === 'returned').length} returned, ${cases.filter(row => row.label === 'not_returned').length} not returned`);
const template = sessionResumeTemplate(), questions = Object.fromEntries(Object.entries(template.questions).map(([id, question]) => [id, { ...question, type: 'noul' }]));
const results = [];
for (const row of cases) {
  if (dry) { results.push({ ...row, input: { ...row.input, lastUserMessage: row.input.lastUserMessage.slice(0, 60), lastReply: row.input.lastReply.slice(-60) } }); continue; }
  const state = buildDecisionState('session.resume', { ...row.input, project: { title: 'project', taskTypes: [] } }, { now });
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const p = id => Math.round((body.answers?.[id]?.noul ?? NaN) * 1000) / 1000;
  results.push({ session: row.session, at: row.at, gapMin: row.gapMin, label: row.label, workLeft: p('work_left'), iterating: p('iterating'), closed: p('closed'), inputTokens: body.usage?.input_tokens ?? null });
}
const out = arg('--out');
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), coldMin: coldMs / 60000, cases: results }, null, 2));
console.log(JSON.stringify(results, null, 1));
