#!/usr/bin/env node
// C3 labelled probe for `reply.target` (docs/research/jev-reply-target-probe-20261005.md): a user message that no model
// named a target for (capture.target) — which proactive message, if any, does it answer? Synthetic cases, labelled by
// hand, from a Chinese novel project and an English code project. Each case is sent in three compositions of the state
// (all through the production state builder, template and combine function):
//   plain  — the proactive messages still waiting for a reaction, no ages, no foreground reply;
//   reply  — plus the assistant's latest reply to the user's own request, when one came after them (an option);
//   full   — plus how long before the message each was sent, as a bucket (code computes it).
// and, for comparison, the capture's own `target_of_feedback` question over the last three assistant outputs, built as
// the live turn.route request builds it (what a message gets when it has a captured target).
// Each call asks the live daemon's JEV probe (POST /api/v2/decision-kernel/probe: one raw call with the app's configured
// key, no thresholds, cache or ledger).
// A second set, `--cards` (CARD_CASES), covers the host's own question cards (an ask, a direct fix to keep or revert), which are
// candidates too (review F1): a typed "iOS" answers the card, and no capture can name one. Only the shipped composition is run.
// Usage: node benchmark/reply-target-probe.mjs [--cards] [--out results.json]   (RNA_URL, default http://127.0.0.1:4317)
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState } from '../../../packages/sdk/src/decision-kernel.mjs';
import { cardText } from '../reply-attribution.mjs';
import { replyTargetTemplate, combineReplyTarget, captureQuestions, answerConfidence, stakeThreshold, DECISION_THRESHOLDS } from '../../../packages/sdk/src/decision-templates.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const MINUTE = 60000, HOUR = 60 * MINUTE;
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };

const NOVEL = { title: '长篇小说《雾港》', goal: '写完并修订 30 章，人物和时间线前后一致' };
const CODE = { title: 'Billing service', goal: 'Keep the invoice API correct and its tests green' };
const AGE = { text: '第一章里林舟的年龄前后不一致：开头写 17 岁，第 9 节写 19 岁。', kind: 'finding' };
const LINK = { text: '第二章第 14 行的链接失效了：它指向的 notes/harbor.md 已经被删除。', kind: 'finding' };
const TIME = { text: '第三章有两处时间线矛盾：第 3 节写的是周二，第 5 节写的是周一，中间只隔了一夜。', kind: 'finding' };
const REPORT = { text: '每日报告：今天核对了 7 个来源，其中 2 个没有找到原文，已在 notes/sources.md 标出。', kind: 'scheduled report' };
const REFUND = { text: 'The /refunds endpoint accepts negative amounts; there is no validation.', kind: 'finding' };
const EMPTY = { text: 'POST /invoices returns a 500 when an invoice has no line items: totals.js reduces over null.', kind: 'finding' };
const FLAKY = { text: 'Three tests in tax.spec.ts are flaky on CI: they depend on the machine\'s time zone.', kind: 'finding' };
const night = (...rows) => rows; // newest first; each carries `ago` (minutes before the user message)

/**
 * `deliveries` newest first with `ago` in minutes before the message; `latest` the assistant's latest reply to the user's
 * own request (also with `ago`), only when it came after the oldest delivery. `label`: none | D<i> | latest_reply.
 */
export const CASES = [
  // --- an unrelated message the morning after a night of shares: it answers none of them
  { id: 'novel-morning-new-task', label: 'none', project: NOVEL, message: '开始写第四章，先写开头两节。', deliveries: night({ ...TIME, ago: 240 }, { ...LINK, ago: 360 }, { ...AGE, ago: 480 }) },
  { id: 'novel-morning-new-edit', label: 'none', project: NOVEL, message: '把第六章的结尾改成开放式，不要交代船长的下落。', deliveries: night({ ...TIME, ago: 300 }, { ...LINK, ago: 420 }, { ...AGE, ago: 540 }) },
  { id: 'novel-morning-greeting', label: 'none', project: NOVEL, message: '早上好', deliveries: night({ ...TIME, ago: 270 }, { ...LINK, ago: 390 }, { ...AGE, ago: 510 }) },
  { id: 'novel-morning-lookup', label: 'none', project: NOVEL, message: '帮我查一下“雾港”这个地名在原著里出现过几次。', deliveries: night({ ...TIME, ago: 200 }, { ...LINK, ago: 330 }, { ...AGE, ago: 460 }) },
  { id: 'novel-morning-english', label: 'none', project: NOVEL, message: 'Please export the whole manuscript to PDF before noon.', deliveries: night({ ...TIME, ago: 180 }, { ...LINK, ago: 300 }, { ...AGE, ago: 420 }) },
  { id: 'novel-morning-plan', label: 'none', project: NOVEL, message: '今天先做哪件事比较好？', deliveries: night({ ...TIME, ago: 150 }, { ...LINK, ago: 330 }, { ...AGE, ago: 450 }) },
  { id: 'code-morning-feature', label: 'none', project: CODE, message: 'Add CSV export for invoices.', deliveries: night({ ...FLAKY, ago: 120 }, { ...EMPTY, ago: 240 }, { ...REFUND, ago: 360 }) },
  { id: 'code-morning-tests', label: 'none', project: CODE, message: 'Run the full test suite and tell me what fails.', deliveries: night({ ...FLAKY, ago: 90 }, { ...EMPTY, ago: 210 }, { ...REFUND, ago: 330 }) },
  { id: 'code-morning-status', label: 'none', project: CODE, message: 'what is the status of the migration branch?', deliveries: night({ ...FLAKY, ago: 400 }, { ...EMPTY, ago: 500 }, { ...REFUND, ago: 600 }) },
  // --- a reply to one specific share (any of them, not only the latest)
  { id: 'novel-reply-link-by-content', label: 'D1', project: NOVEL, message: 'harbor.md 我已经恢复了，你再检查一下那个链接。', deliveries: night({ ...TIME, ago: 120 }, { ...LINK, ago: 240 }, { ...AGE, ago: 360 }) },
  { id: 'novel-reply-age-oldest', label: 'D2', project: NOVEL, message: '林舟应该是 19 岁，开头那里改成 19。', deliveries: night({ ...TIME, ago: 120 }, { ...LINK, ago: 240 }, { ...AGE, ago: 360 }) },
  { id: 'novel-reply-time-newest', label: 'D0', project: NOVEL, message: '时间线以周一为准，第 3 节改一下。', deliveries: night({ ...TIME, ago: 20 }, { ...LINK, ago: 140 }, { ...AGE, ago: 260 }) },
  { id: 'novel-reply-link-deleted', label: 'D1', project: NOVEL, message: '那个文件是我自己删的，不需要恢复，把链接去掉就行。', deliveries: night({ ...TIME, ago: 60 }, { ...LINK, ago: 180 }, { ...AGE, ago: 300 }) },
  { id: 'novel-reply-age-agree', label: 'D2', project: NOVEL, message: '年龄的问题你说得对，我疏忽了。', deliveries: night({ ...TIME, ago: 90 }, { ...LINK, ago: 210 }, { ...AGE, ago: 330 }) },
  { id: 'code-reply-refunds', label: 'D2', project: CODE, message: 'The refunds validation is intended: negative amounts are credit notes.', deliveries: night({ ...FLAKY, ago: 30 }, { ...EMPTY, ago: 150 }, { ...REFUND, ago: 270 }) },
  { id: 'code-reply-totals', label: 'D1', project: CODE, message: 'Fix the totals.js null reduce, please.', deliveries: night({ ...FLAKY, ago: 45 }, { ...EMPTY, ago: 165 }, { ...REFUND, ago: 285 }) },
  { id: 'code-reply-flaky-question', label: 'D0', project: CODE, message: 'Which tests are flaky? List them.', deliveries: night({ ...FLAKY, ago: 15 }, { ...EMPTY, ago: 135 }, { ...REFUND, ago: 255 }) },
  // --- agreement or thanks right after the newest share
  { id: 'novel-thumbs-up', label: 'D0', project: NOVEL, message: '👍', deliveries: night({ ...TIME, ago: 5 }, { ...LINK, ago: 125 }, { ...AGE, ago: 245 }) },
  { id: 'novel-thanks', label: 'D0', project: NOVEL, message: '不错，谢谢。', deliveries: night({ ...TIME, ago: 20 }, { ...LINK, ago: 140 }, { ...AGE, ago: 260 }) },
  { id: 'code-good-catch', label: 'D0', project: CODE, message: 'good catch', deliveries: night({ ...EMPTY, ago: 8 }, { ...REFUND, ago: 128 }) },
  { id: 'code-ok-just-now', label: 'D0', project: CODE, message: 'ok', deliveries: night({ ...FLAKY, ago: 1 }, { ...EMPTY, ago: 121 }) },
  // --- a correction to a scheduled report
  { id: 'novel-report-number', label: 'D0', project: NOVEL, message: '这个报告里的数字不对，应该是 9 个来源，不是 7 个。', deliveries: night({ ...REPORT, ago: 180 }), latest: { text: '第四章开头两节写好了，一共 1,200 字。', ago: 600 } },
  { id: 'novel-report-missing', label: 'D0', project: NOVEL, message: '报告漏了第四章，下次把它也核对一下。', deliveries: night({ ...REPORT, ago: 90 }, { ...AGE, ago: 400 }), latest: { text: '第四章开头两节写好了，一共 1,200 字。', ago: 500 } },
  { id: 'novel-report-wrong-source', label: 'D0', project: NOVEL, message: '第二个来源我已经找到原文了，不是缺失的。', deliveries: night({ ...REPORT, ago: 40 }), latest: { text: '第四章开头两节写好了。', ago: 300 } },
  // --- a foreground exchange after the shares: the message is about that reply
  { id: 'novel-after-foreground-shorten', label: 'latest_reply', project: NOVEL, message: '这一段太长了，缩短一半。', deliveries: night({ ...TIME, ago: 300 }, { ...LINK, ago: 420 }, { ...AGE, ago: 540 }), latest: { text: '第四章开头写好了：顾昭推开长明宗的山门，雾从石阶下面涌上来……（共 900 字）', ago: 25 } },
  { id: 'novel-after-foreground-more', label: 'latest_reply', project: NOVEL, message: '再加一个对话场景。', deliveries: night({ ...TIME, ago: 200 }, { ...LINK, ago: 320 }), latest: { text: '第四章开头写好了：顾昭推开长明宗的山门，雾从石阶下面涌上来……（共 900 字）', ago: 10 } },
  { id: 'novel-after-foreground-thanks', label: 'latest_reply', project: NOVEL, message: '谢谢，就这样。', deliveries: night({ ...TIME, ago: 260 }, { ...LINK, ago: 380 }), latest: { text: '第四章开头已经按你的要求改成第三人称了。', ago: 6 } },
  { id: 'code-after-foreground-redo', label: 'latest_reply', project: CODE, message: 'That is not what I asked: keep the old signature.', deliveries: night({ ...FLAKY, ago: 200 }, { ...EMPTY, ago: 320 }), latest: { text: 'I changed formatMoney to take an options object and updated its 14 callers.', ago: 12 } },
  { id: 'code-after-foreground-q', label: 'latest_reply', project: CODE, message: 'why did you update the callers?', deliveries: night({ ...FLAKY, ago: 100 }, { ...EMPTY, ago: 220 }), latest: { text: 'I changed formatMoney to take an options object and updated its 14 callers.', ago: 3 } },
  // --- harder: shared vocabulary, mixed messages, a late reply to the oldest share, a share that asked a question
  { id: 'hard-novel-same-chapter-new-task', label: 'none', hard: true, project: NOVEL, message: '把第三章的开头重写一遍，节奏快一点。', deliveries: night({ ...TIME, ago: 180 }, { ...LINK, ago: 300 }, { ...AGE, ago: 420 }) },
  { id: 'hard-novel-reply-then-new-task', label: 'D0', project: NOVEL, message: '时间线我改好了。接着写第五章。', deliveries: night({ ...TIME, ago: 60 }, { ...LINK, ago: 180 }, { ...AGE, ago: 300 }) },
  { id: 'hard-novel-late-reply-oldest', label: 'D2', project: NOVEL, message: '林舟的年龄我昨天就改过了，那条不用再看。', deliveries: night({ ...TIME, ago: 700 }, { ...LINK, ago: 820 }, { ...AGE, ago: 940 }) },
  { id: 'hard-novel-detail-question', label: 'D2', project: NOVEL, message: '第 9 节具体是哪一句写了 19 岁？', deliveries: night({ ...TIME, ago: 90 }, { ...LINK, ago: 210 }, { ...AGE, ago: 330 }) },
  { id: 'hard-novel-answer-to-ask', label: 'D0', project: NOVEL, message: '要，统一成周一。', deliveries: night({ text: '第三章的时间线有两种写法，要不要我统一成周一？', kind: 'question', ago: 45 }, { ...LINK, ago: 165 }, { ...AGE, ago: 285 }) },
  { id: 'hard-novel-agree-older', label: 'D1', project: NOVEL, message: '链接那个问题，好，你改吧。', deliveries: night({ ...TIME, ago: 100 }, { ...LINK, ago: 220 }, { ...AGE, ago: 340 }) },
  { id: 'hard-novel-name-question', label: 'none', project: NOVEL, message: '“雾港”这个名字要不要换一个？', deliveries: night({ ...TIME, ago: 240 }, { ...LINK, ago: 360 }, { ...AGE, ago: 480 }) },
  { id: 'hard-novel-thumbs-down', label: 'D0', project: NOVEL, message: '👎', deliveries: night({ ...TIME, ago: 4 }, { ...LINK, ago: 124 }, { ...AGE, ago: 244 }) },
  { id: 'hard-code-later-note', label: 'D2', project: CODE, message: 'Thanks, I will look at the refunds one later.', deliveries: night({ ...FLAKY, ago: 70 }, { ...EMPTY, ago: 190 }, { ...REFUND, ago: 310 }) },
  { id: 'hard-code-follow-up-action', label: 'D2', project: CODE, message: 'Add a test for the refund validation.', deliveries: night({ ...FLAKY, ago: 70 }, { ...EMPTY, ago: 190 }, { ...REFUND, ago: 310 }) },
  { id: 'hard-code-same-file-new-task', label: 'none', hard: true, project: CODE, message: 'Refactor totals.js to use a decimal library.', deliveries: night({ ...FLAKY, ago: 200 }, { ...EMPTY, ago: 320 }, { ...REFUND, ago: 440 }) },
  { id: 'hard-novel-report-after-foreground', label: 'D0', hard: true, project: NOVEL, message: '这个报告里第三个来源的链接打不开。', deliveries: night({ ...REPORT, ago: 120 }), latest: { text: '第四章开头两节写好了，一共 1,200 字。', ago: 10 } },
  { id: 'hard-novel-got-it-late', label: 'D0', hard: true, project: NOVEL, message: 'got it', deliveries: night({ ...TIME, ago: 200 }, { ...LINK, ago: 320 }, { ...AGE, ago: 440 }) },
];

// --- question cards: the text is what the host shows (reply-attribution.mjs cardText), the kind 'question card'
const card = (question, labels) => ({ text: cardText({ interaction: { questions: [{ question, options: labels.map(label => ({ label })) }] } }), kind: 'question card' });
const TIMELINE_ASK = card('第三章的时间线有两种写法，要统一成哪一种？', ['周一', '周二']);
const FIX_ZH = card('我发现了几处明确的问题，已经直接修正（2 个文件）。要保留这些修改吗？', ['确认保留', '回退这些修改']);
const PLATFORM = card('Which platform should the build target?', ['iOS', 'Android']);
const FIX_EN = card('I found a few clear mistakes and fixed them directly (2 files). Keep these changes?', ['Keep', 'Revert']);
/** Cases with a pending question card among the deliveries (newest first, `ago` minutes before the message). */
export const CARD_CASES = [
  // --- a typed answer to a card (an option, a sentence, an instruction that answers it)
  { id: 'card-ask-zh-option', label: 'D0', project: NOVEL, message: '周一', deliveries: night({ ...TIMELINE_ASK, ago: 20 }, { ...LINK, ago: 140 }, { ...AGE, ago: 260 }) },
  { id: 'card-ask-zh-sentence', label: 'D0', project: NOVEL, message: '统一成周二吧，第五章也一并改。', deliveries: night({ ...TIMELINE_ASK, ago: 35 }, { ...LINK, ago: 155 }, { ...AGE, ago: 275 }) },
  { id: 'card-ask-en-option', label: 'D0', project: CODE, message: 'iOS', deliveries: night({ ...PLATFORM, ago: 10 }, { ...EMPTY, ago: 130 }, { ...REFUND, ago: 250 }) },
  { id: 'card-ask-en-both', label: 'D0', project: CODE, message: 'both, but Android first', deliveries: night({ ...PLATFORM, ago: 25 }, { ...EMPTY, ago: 145 }) },
  { id: 'card-ask-en-instruction', label: 'D0', hard: true, project: CODE, message: 'Use iOS and update the build script to match.', deliveries: night({ ...PLATFORM, ago: 15 }, { ...FLAKY, ago: 135 }) },
  { id: 'card-ask-older', label: 'D1', project: CODE, message: 'iOS only for now.', deliveries: night({ ...FLAKY, ago: 30 }, { ...PLATFORM, ago: 150 }, { ...REFUND, ago: 270 }) },
  { id: 'card-fix-zh-keep', label: 'D0', project: NOVEL, message: '保留', deliveries: night({ ...FIX_ZH, ago: 12 }, { ...LINK, ago: 132 }, { ...AGE, ago: 252 }) },
  { id: 'card-fix-zh-keep-note', label: 'D0', project: NOVEL, message: '好的，先保留，我晚点再看。', deliveries: night({ ...FIX_ZH, ago: 50 }, { ...LINK, ago: 170 }) },
  { id: 'card-fix-zh-revert', label: 'D0', project: NOVEL, message: '回退吧，第二处改得不对。', deliveries: night({ ...FIX_ZH, ago: 40 }, { ...TIME, ago: 160 }, { ...AGE, ago: 280 }) },
  { id: 'card-fix-en-keep', label: 'D0', project: CODE, message: 'keep them', deliveries: night({ ...FIX_EN, ago: 8 }, { ...EMPTY, ago: 128 }) },
  { id: 'card-fix-en-revert', label: 'D0', project: CODE, message: 'revert the second one', deliveries: night({ ...FIX_EN, ago: 18 }, { ...REFUND, ago: 138 }, { ...EMPTY, ago: 258 }) },
  { id: 'card-fix-thumbs-up', label: 'D0', project: NOVEL, message: '👍', deliveries: night({ ...FIX_ZH, ago: 5 }, { ...LINK, ago: 125 }, { ...AGE, ago: 245 }) },
  // --- an unrelated message while a card is pending: it answers none of them
  { id: 'card-unrelated-novel-task', label: 'none', project: NOVEL, message: '开始写第四章，先写开头两节。', deliveries: night({ ...TIMELINE_ASK, ago: 200 }, { ...LINK, ago: 320 }, { ...AGE, ago: 440 }) },
  { id: 'card-unrelated-code-task', label: 'none', project: CODE, message: 'Add CSV export for invoices.', deliveries: night({ ...PLATFORM, ago: 180 }, { ...EMPTY, ago: 300 }, { ...REFUND, ago: 420 }) },
  { id: 'card-unrelated-lookup', label: 'none', project: NOVEL, message: '帮我查一下“雾港”这个地名在原著里出现过几次。', deliveries: night({ ...FIX_ZH, ago: 300 }, { ...LINK, ago: 420 }) },
  { id: 'card-unrelated-greeting', label: 'none', project: CODE, message: 'good morning', deliveries: night({ ...FIX_EN, ago: 360 }, { ...EMPTY, ago: 480 }) },
  { id: 'hard-card-same-topic-new-task', label: 'none', hard: true, project: NOVEL, message: '把第三章的开头重写一遍，节奏快一点。', deliveries: night({ ...TIMELINE_ASK, ago: 120 }, { ...LINK, ago: 240 }, { ...AGE, ago: 360 }) },
  // --- a reply to a share while a card is pending: it is about the share, not the card
  { id: 'card-share-reply-zh', label: 'D1', project: NOVEL, message: 'harbor.md 我已经恢复了，你再检查一下那个链接。', deliveries: night({ ...FIX_ZH, ago: 30 }, { ...LINK, ago: 150 }, { ...AGE, ago: 270 }) },
  { id: 'card-share-reply-en', label: 'D1', project: CODE, message: 'The refunds validation is intended: negative amounts are credit notes.', deliveries: night({ ...PLATFORM, ago: 20 }, { ...REFUND, ago: 140 }) },
];

const wire = template => Object.fromEntries(Object.entries(template.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
const kernelAnswer = raw => ({ type: 'choice', choice: raw.choice, probabilities: raw.probabilities, ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}) });
export const VARIANTS = {
  plain: row => ({ deliveries: row.deliveries.map(({ text, kind }) => ({ text, kind })), latest: false }),
  reply: row => ({ deliveries: row.deliveries.map(({ text, kind }) => ({ text, kind })), latest: Boolean(row.latest) }),
  full: row => ({ deliveries: row.deliveries.map(({ text, kind, ago }) => ({ text, kind, ageMs: ago * MINUTE })), latest: Boolean(row.latest) }),
};
/** The state the host sends (decision-service replyTarget builds the same one), minimized as the kernel does. */
export function caseState(row, variant) {
  const { deliveries, latest } = VARIANTS[variant](row);
  const state = buildDecisionState('reply.target', { message: row.message, deliveries, ...(latest ? { latestReply: row.latest.text } : {}), project: { title: row.project.title, taskTypes: [] } }, { now: Date.now() });
  return { state: minimizeDecisionState(state, { maxChars: 8000 }), plan: replyTargetTemplate({ candidates: deliveries.length, latestReply: latest }) };
}
/** The capture's own target question for the same case: the last three assistant outputs, newest first (as turn.route builds it). */
export function captureCase(row) {
  const outputs = [...row.deliveries.map(item => ({ text: item.text, ago: item.ago, delivery: true })), ...(row.latest ? [{ text: row.latest.text, ago: row.latest.ago }] : [])].sort((a, b) => a.ago - b.ago).slice(0, 3);
  const state = buildDecisionState('turn.route', { message: row.message, previousReply: outputs[0].text, project: { title: row.project.title, goal: row.project.goal } }, { now: Date.now() });
  const plan = { questions: { target_of_feedback: captureQuestions({ outputs, threads: [], questions: [] }).target_of_feedback } };
  return { state: minimizeDecisionState(state, { maxChars: 8000 }), plan, outputs };
}
/** What the capture would settle: out_<i> → the delivery it is, or "away" (a foreground reply, none). */
export const captureLabel = (choice, outputs) => { const match = /^out_([0-9])$/.exec(choice ?? ''); if (!match) return choice ?? null; const output = outputs[Number(match[1])]; return output?.delivery ? `D${[...outputs.filter(item => item.delivery)].indexOf(output)}` : 'latest_reply'; };

async function ask(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
/** The class a label has: a delivery, or "away" (none, or the latest foreground reply: not a delivery). */
const classOf = label => /^D[0-9]$/.test(label) ? label : 'away';

export async function run({ onlyVariants = Object.keys(VARIANTS), cases = CASES, withCapture = true } = {}) {
  const rows = []; let inputTokens = 0;
  for (const row of cases) {
    for (const variant of onlyVariants) {
      const { state, plan } = caseState(row, variant), questions = wire(plan), body = await ask(state, questions);
      inputTokens += body.usage?.input_tokens ?? 0;
      const answer = kernelAnswer(body.answers?.replies_to ?? {});
      rows.push({ id: row.id, variant, label: row.label, choice: answer.choice, confidence: round(answerConfidence(answer)), probabilities: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([key, value]) => [key, round(value)])), candidates: plan.questions.replies_to.criteria });
    }
    if (!withCapture) continue;
    const { state, plan, outputs } = captureCase(row), questions = wire(plan), body = await ask(state, questions), answer = kernelAnswer(body.answers?.target_of_feedback ?? {});
    inputTokens += body.usage?.input_tokens ?? 0;
    rows.push({ id: row.id, variant: 'capture', label: row.label, choice: captureLabel(answer.choice, outputs), raw: answer.choice, confidence: round(answerConfidence(answer)), probabilities: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([key, value]) => [key, round(value)])) });
  }
  return { rows, calls: rows.length, inputTokens };
}

/**
 * For one variant at a pair of thresholds: how the verdicts of the labelled set come out, through the production combine
 * function (the answer carries the confidence the kernel keeps: JEV's own when it reports one). `capture` rows are the
 * capture question's pick, read the way combineCapture reads it: a delivery or none above `target`.
 */
export function score(rows, variant, { target, none }) {
  const set = rows.filter(row => row.variant === variant), out = { settledRight: 0, settledWrong: 0, wrongTarget: 0, noneRight: 0, noneWrong: 0, abstained: 0, of: set.length, wrong: [] };
  for (const row of set) {
    let verdict;
    if (row.variant === 'capture') {
      verdict = /^D[0-9]$/.test(row.choice) && row.confidence >= stakeThreshold(target) ? { target: Number(row.choice.slice(1)) } : (row.choice === 'none' || row.choice === 'latest_reply') && row.confidence >= stakeThreshold(none) ? { target: null } : {};
    } else {
      const candidates = Object.keys(row.probabilities ?? {}).filter(key => /^dlv_/.test(key)).length;
      verdict = combineReplyTarget({ replies_to: { type: 'choice', choice: row.choice, probabilities: row.probabilities, confidence: row.confidence } }, { candidates, thresholds: { target, none } });
    }
    const klass = classOf(row.label);
    if (verdict.target === undefined) out.abstained++;
    else if (verdict.target === null) { if (klass === 'away') out.noneRight++; else { out.noneWrong++; out.wrong.push([row.id, 'none']); } }
    else if (klass === 'away') { out.settledWrong++; out.wrong.push([row.id, `D${verdict.target}`]); }
    else if (`D${verdict.target}` === row.label) out.settledRight++;
    else { out.wrongTarget++; out.wrong.push([row.id, `D${verdict.target}`]); }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const cards = process.argv.includes('--cards'), result = await run(cards ? { cases: CARD_CASES, onlyVariants: ['reply'], withCapture: false } : {}), out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ calls: result.calls, inputTokens: result.inputTokens, thresholds: DECISION_THRESHOLDS.points['reply.target'] }));
  for (const row of result.rows) console.log([row.id.padEnd(34), row.variant.padEnd(8), `label=${row.label}`.padEnd(20), `choice=${row.choice}`.padEnd(18), `p=${row.confidence}`].join(' '));
}
