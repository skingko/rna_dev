#!/usr/bin/env node
// mind.judge `stale_<n>` for kind `source`, with sources shaped as production keeps them (C4 review finding 3;
// docs/research/revocation-stale-probe-20261005.md, "批量来源"). A note links EVERY message of the batch it was written from
// (mergeNotes: up to 8), of which usually one says it. When a message of the batch is rewound, the judge must see the remaining
// messages that could say it, not the first three of the batch: a note whose real source was message #7 of the batch was judged
// against messages #1, #3 and #4 and marked stale although its source stands.
// Each case is a note and the messages of its batch that REMAIN (4-7), in order. Labels: S = one remaining message says it (the note
// stands: must not be marked stale), U = none does (its source was the removed message: must be marked stale). The supporting
// message sits at every position, also late ones; some cases are paraphrases that share no word with the note (BM25 cannot find
// them), some have the statement at the end of a long message.
// Strategies (which sources to show, in code): first3 (what shipped with C4), bm25_3 / bm25_4 (the nearest remaining messages to
// the note by BM25, the app's own), all (every remaining message, shorter), each with its per-message character budget.
// Every call is one raw call through the live daemon's probe (POST /api/v2/decision-kernel/probe: the app's configured key, no
// thresholds, cache or ledger). Usage: node benchmark/revocation-source-batch-probe.mjs [--strategy name] [--out file.json]
import { writeFileSync } from 'node:fs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { mindStaleTemplate } from '../../../packages/sdk/src/decision-templates.mjs';
import { bm25Rank } from '../project-mind.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const clip = (text, limit) => { const value = String(text).replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; };

// Neighbours: messages of the same batch that say nothing about any note below (a writing project in Chinese, a code project in English).
const ZH = ['继续写第 5 章', '把第 3 章的开头改短一点', '今天先到这里', '这个人物的名字再想想', '帮我看看第 2 章有没有错别字', '谢谢，这版可以', '把目录更新一下', '明天上午再接着写', '先不要动第 1 章', '字数统计一下', '第 4 章的节奏有点慢', '换一个更紧凑的开场'];
const EN = ['Please fix the failing test in parser.test.js', 'Thanks, that works now.', 'Can you also update the README?', 'Run the build again.', 'What does this error mean?', 'Let me check the logs first.', 'Open a PR when you are done.', 'Rename the helper to parseConfig.', 'Add a unit test for the empty input case.', 'The CI is red again.'];
const LONG_FILLER = '第 6 章的前半部分我读了一遍，整体节奏还行，不过人物对话偏多，描写太少，场景转换也有点突兀，前后两段之间缺一个过渡的句子，而且几处时间线对不上：上一章结尾是黄昏，这一章开头却是清晨，中间没有任何交代。另外把主角的口头禅统一一下，不要每次都换说法，读者会觉得是两个人在说话。';
// [note, supporting message or null, the other remaining messages (picked from the pools by `neighbours`), position of the supporter, language]
const CASES = [
  ['用户要求日报简洁，不要啰嗦', '日报写简洁点，别啰嗦', 5], ['用户要求日报简洁，不要啰嗦', null],
  ['守夜人这个名字不能直接用', '组织命名别直接用原著里的专有名词，比如守夜人', 4], ['守夜人这个名字不能直接用', null],
  ['用户已授权继续补写到 30 章', '可以，继续写到 30 章吧', 6], ['用户已授权继续补写到 30 章', null],
  ['作品标题确定为《提灯入夜》', '标题就叫《提灯入夜》吧', 0], ['作品标题确定为《提灯入夜》', null],
  ['推送渠道用邮件', '推送发邮件就行', 3], ['推送渠道用邮件', null],
  ['用户在上海', '我在上海，明天上午帮我约个会议室', 5], ['用户在上海', null],
  // Paraphrases: no word in common with the note.
  ['用户希望回复语气轻松自然', '别那么正式，随意聊就行', 4], ['用户希望回复语气轻松自然', null],
  ['用户不想看到太长的回答', '说重点就好，我没时间看长文', 5], ['用户不想看到太长的回答', null],
  // The statement at the end of a long message.
  ['每章末尾要留悬念', `${LONG_FILLER}还有一点，以后每一章的结尾都要留个悬念，让人想接着往下读。`, 4], ['每章末尾要留悬念', `${LONG_FILLER}还有一点，目录里把章节编号改成阿拉伯数字。`, 4, true],
  ['The user prefers tabs for indentation.', 'Use tabs, not spaces, in all new files.', 4, false, 'en'], ['The user prefers tabs for indentation.', null, 0, false, 'en'],
  ["The user's name is Lin.", "I'm Lin, by the way. Can you update the README?", 5, false, 'en'], ["The user's name is Lin.", null, 0, false, 'en'],
  ['Releases are tagged with a v prefix.', 'Tag it as v1.2.0 and push the tag.', 3, false, 'en'], ['Releases are tagged with a v prefix.', null, 0, false, 'en'],
  ['The user wants short answers.', 'Just give me the gist, no essays.', 4, false, 'en'], ['The user wants short answers.', null, 0, false, 'en'],
];
// Deterministic pick of neighbours: the case index and the variant decide which and how many (5-8 messages remain in all: a batch
// holds up to 8 messages, one of them the removed one). Two variants of every case, so a case is judged with two different batches.
const cases = [0, 1].flatMap(variant => CASES.map((row, index) => {
  const [note, support, position = 0, longOther, language = 'zh'] = row, pool = language === 'en' ? EN : ZH;
  const count = 5 + (index * 3 + variant * 2) % 4, others = Array.from({ length: count - (support ? 1 : 0) }, (_, k) => pool[(index * 5 + variant * 7 + k * 3) % pool.length]);
  const unique = [...new Set(others)];
  const messages = [...unique]; if (support) messages.splice(Math.min(position + variant * 2, messages.length), 0, support);
  const label = support && !longOther ? 'S' : 'U';
  return { note, label, messages, support, position: support ? messages.indexOf(support) : null, language, long: Boolean(support && support.length > 200) || Boolean(longOther) };
}));

const STRATEGIES = {
  first3: { pick: (note, messages) => messages.slice(0, 3), chars: 220 },
  bm25_3: { pick: (note, messages) => rankBy(note, messages).slice(0, 3), chars: 220 },
  bm25_4: { pick: (note, messages) => rankBy(note, messages).slice(0, 4), chars: 300 },
  all: { pick: (note, messages) => messages, chars: 120 },
  all_long: { pick: (note, messages) => messages, chars: 400 },
  // Every remaining message, the nearest to the note first (BM25, ties in the batch's order).
  ranked_400: { pick: (note, messages) => rankBy(note, messages), chars: 400 },
  ranked_250: { pick: (note, messages) => rankBy(note, messages), chars: 250 },
};
function rankBy(note, messages) {
  const docs = messages.map((text, index) => ({ id: String(index), text })), score = new Map(bm25Rank(docs, note).map(row => [row.id, row.score]));
  return messages.map((text, index) => ({ text, index, score: score.get(String(index)) ?? 0 })).sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.text);
}

const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, q]) => [id, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }]));
let calls = 0, inputTokens = 0;
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  calls++; inputTokens += body.usage?.input_tokens ?? 0;
  return body;
}
const maxChars = deriveDecisionPolicy('mind.judge').maxStateChars;
// Rows of one call fit the state limit (as decision-service does: greedily, in order); a row too big for a call of its own is cut by the kernel.
function chunks(rows) {
  const stateOf = list => buildDecisionState('mind.judge', { rows: list }), out = [];
  for (let at = 0; at < rows.length;) { let n = Math.min(8, rows.length - at); while (n > 1 && JSON.stringify(stateOf(rows.slice(at, at + n))).length > 9000) n--; out.push(rows.slice(at, at + n)); at += n; }
  return out;
}
async function run(name) {
  const strategy = STRATEGIES[name], rows = cases.map(row => ({ kind: 'note', text: row.note, sources: strategy.pick(row.note, row.messages).map(text => clip(text, strategy.chars)) }));
  const scores = [];
  for (const group of chunks(rows)) {
    const state = minimizeDecisionState(buildDecisionState('mind.judge', { rows: group }), { maxChars });
    const answer = await probe(state, wire(mindStaleTemplate({ kind: 'source', rows: group.length })));
    group.forEach((_, index) => { const a = answer.answers?.[`stale_${index}`]; scores.push(Math.round((1 - (a?.noul ?? .5)) * 1000) / 1000); });
  }
  return { name, calls: chunks(rows).length, scores };
}
const names = arg('--strategy') ? [arg('--strategy')] : Object.keys(STRATEGIES), results = [];
for (const name of names) results.push(await run(name));
const line = .75, report = results.map(({ name, calls: n, scores }) => {
  const s = scores.filter((_, i) => cases[i].label === 'S'), u = scores.filter((_, i) => cases[i].label === 'U');
  const wrong = cases.flatMap((row, i) => row.label === 'S' && scores[i] >= line ? [`${row.note.slice(0, 24)} @${row.position}${row.long ? ' long' : ''} (${scores[i]})`] : []);
  const missed = cases.flatMap((row, i) => row.label === 'U' && scores[i] < line ? [`${row.note.slice(0, 24)}${row.long ? ' long' : ''} (${scores[i]})`] : []);
  return { strategy: name, calls: n, supported: { n: s.length, max: Math.max(...s), top: [...s].sort((a, b) => b - a).slice(0, 5) }, unsupported: { n: u.length, min: Math.min(...u), low: [...u].sort((a, b) => a - b).slice(0, 5) },
    atLine: { line, falseStale: wrong, missed } };
});
console.log(JSON.stringify({ calls, inputTokens, cases: cases.length, supported: cases.filter(row => row.label === 'S').length, unsupported: cases.filter(row => row.label === 'U').length, report }, null, 2));
if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify({ at: new Date().toISOString(), cases, results, report }, null, 2));
