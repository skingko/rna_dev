import { createHash, randomUUID } from 'node:crypto';
import { createDecisionKernel, decisionVerdict, deriveDecisionPolicy, minimizeDecisionState, JEV_MODEL, JEV_ENDPOINT, chatRouteTemplate, routeSkillKey, MAX_ROUTE_SKILLS, deliveryReachTemplate, skillScreenTemplate, screenCandidateKey, candidatePrescoreTemplate, MAX_SCREEN_CANDIDATES } from '../../packages/sdk/src/decision-kernel.mjs';
import { createLlmDecisionJudge } from '../../packages/sdk/src/decision-llm-judge.mjs';
import { purposeProvider } from './usage-cache-service.mjs';
import { resolveModel } from './configuration.mjs';
import { validJudgmentPolicy } from './judgment-policy-service.mjs';
import { selectLearningToolReceipts, learningEpisodeOutcome } from './project-learning-evidence.mjs';
import { projectRhythmEvidenceKey } from './project-rhythm.mjs';
import { reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';
import { decisionPerformance } from './decision-observability.mjs';
import { buildDecisionState, commandFeatures, EFFORT_POINTS, EXPOSE_LESSON_LIMIT, EXPOSE_METHOD_LIMIT } from '../../packages/sdk/src/decision-state.mjs';
import { effortForDepth, SHADOW_ONLY_PURPOSES } from './internal-reasoning.mjs';
import { DECISION_THRESHOLDS, TEMPLATE_SPECS, turnRouteTemplate, combineTurnRoute, turnRouteHints, deliveryReachAtomicTemplate, combineReach, skillScreenWideTemplate, skillScreenVerifyTemplate, combineScreenWide, combineScreenVerify, skillPickTemplate, combineSkillPick, screenOptionKey, fitsKey,
  candidatePrescoreAtomicTemplate, combinePrescore, initiativeGateTemplate, combineInitiativeGate, workCoverageTemplate, combineWorkCoverage, toolRiskTemplate, combineToolRisk, messageCheckTemplate, combineMessageCheck, messageValueTemplate, combineMessageValue, memoryFilterTemplate, combineMemoryFilter, relevantKey, answerConfidence, MAX_ROUTE_CATALOG,
  combineCapture, mindJudgeTemplate, combineMindJudge, mindReconcileTemplate, combineMindReconcile, MIND_RECONCILE_BATCH, mindStaleTemplate, combineMindStale, MIND_STALE_LIMIT, directHandleTemplate, combineDirectHandle, turnSettledTemplate, combineTurnSettled, toolAdmissionTemplate, combineToolAdmission, inputInterjectionTemplate, combineInputInterjection, feedbackSignalTemplate, combineFeedbackSignal, notesWorthTemplate, combineNotesWorth, guardTriageTemplate, combineGuardTriage, turnReviewTemplate, combineTurnReview, inviteStaleTemplate, combineInviteStale, standardLinkTemplate, combineStandardLink, STANDARD_LINK_LIMIT, geneConsolidateTemplate, combineGeneConsolidate, GENE_CONSOLIDATE_LIMIT, GENE_PLACE_LIMIT, skillRetireTemplate, combineSkillRetire, answerMatchTemplate, combineAnswerMatch, lessonAppliedTemplate, combineLessonApplied, LESSON_APPLIED_LIMIT, METHOD_APPLIED_LIMIT, combineRuleExposure, diagnosticsDeliveryTemplate, combineDiagnosticsDelivery, DIAGNOSTICS_WARNINGS, scheduleSuggestTemplate, combineScheduleSuggest, SCHEDULE_SUGGEST_LIMIT, toolConstraintTemplate, combineToolConstraint, TOOL_CONSTRAINT_LIMIT, turnDriftTemplate, combineTurnDrift, turnRewindTemplate, combineTurnRewind, planBetterTemplate, combinePlanBetter, commitmentDueTemplate, combineCommitmentDue, COMMITMENT_DUE_LIMIT, shareResolvedTemplate, combineShareResolved, attentionNowTemplate, combineAttentionNow, evidenceSelectTemplate, combineEvidenceSelect, EVIDENCE_SELECT_LIMIT, capabilityDisclosureTemplate, combineCapabilityDisclosure, CAPABILITY_DISCLOSURE_LIMIT, contextForgetTemplate, combineContextForget, CONTEXT_FORGET_LIMIT, sessionResumeTemplate, combineSessionResume, askNecessityTemplate, combineAskNecessity, combineAskKnown, geneRouteTemplate, combineGeneRoute, geneReviewTemplate, combineGeneReview, effortTemplate, combineEffortDepth, MAX_REPLY_CANDIDATES, replyTargetTemplate, combineReplyTarget, workCompletionTemplate, combineWorkCompletion, replySentences, mindCoveredTemplate, combineMindCovered, MIND_COVERED_LIMIT, MAX_CAPTURE_REQUESTS } from '../../packages/sdk/src/decision-templates.mjs';
import { CALIBRATION_WINDOWS, calibrationReport, pendingObservations } from './decision-calibration-report.mjs';
import { DecisionLedger, decisionLedgerFile, LABEL_SOURCES, rowLabelSource } from './decision-ledger.mjs';
import { windowRange, within } from './metric-windows.mjs';
import { heldItems, overdueCommitments, pursuedOverdue, proactiveRowKind } from './proactive-pacing.mjs';
import { workCoverageInput } from './work-coverage.mjs';
import { evidenceText } from './evidence-text.mjs';
import { COMPLETION_POINT, unreviewedCompletions, completionFacts, completionReport } from './work-completion.mjs';
export { evidenceText } from './evidence-text.mjs';

/** Effort depths, lightest first (decision-templates.mjs effortTemplate). */
const EFFORT_DEPTHS = ['light', 'standard', 'deep'];
const points = ['initiative.review', 'initiative.gate', 'work.coverage', 'work.completion', 'evolution.review', 'chat.preflight', 'chat.route', 'turn.route', 'delivery.reach', 'skill.screen', 'candidate.prescore', 'tool.risk', 'message.check', 'message.value', 'memory.filter', 'mind.judge', 'initiative.direct', 'turn.settled', 'tool.admission', 'input.interjection', 'feedback.signal', 'notes.worth', 'ask.necessity', 'gene.route', 'gene.review', 'guard.triage', 'turn.review', 'invite.stale', 'standard.link', 'gene.consolidate', 'skill.retire', 'answer.match', 'lesson.applied', 'diagnostics.delivery', 'schedule.suggest', 'tool.constraint', 'turn.drift', 'turn.rewind', 'plan.better', 'commitment.due', 'share.resolved', 'reply.target', 'attention.now', 'evidence.select', 'capability.disclosure', 'context.forget', 'session.resume', ...EFFORT_POINTS];
// UI contract for the 判断 settings page: point metadata (stake, what it may change).
export const DECISION_POINT_INFO = Object.freeze({
  'turn.route': { title: '每轮路由', stake: 'low', effect: 'reasoning effort, memory skip, tail hints (skill, background stop/redirect, clarify), which lessons and working rules the message calls for; a message that confidently asks again for one of your pending requests (or tells the assistant to carry on with it) joins that request instead of opening a second one, and is settled with it when the turn finishes', supersedes: ['chat.route', 'chat.preflight'] },
  'chat.route': { title: '推理档位（旧）', stake: 'low', effect: 'legacy; superseded by turn.route', legacy: true },
  'chat.preflight': { title: '记忆预判（旧）', stake: 'low', effect: 'legacy; superseded by turn.route', legacy: true },
  'initiative.review': { title: '后台复核', stake: 'medium', effect: 'defer the main-model review using the main-model plan (bounded deferral)' },
  'initiative.gate': { title: '后台唤醒', stake: 'medium', effect: 'host atomic questions decide wake vs wait, with or without a main-model plan (bounded deferral)', rides: 'initiative.review' },
  'work.coverage': { title: '后台是否重复', stake: 'high', effect: 'before a background work the main model proposed starts, skip it when it only repeats checks that tool receipts, finished background work or work still running already covered in the same place, and nothing they checked changed since; the next decision is told why' },
  // D2 (option B): shadow. Every finished background run still makes the host send the next review to the main model; this
  // works out, beside it, whether that review would have been skipped, and records it for the comparison with what the review
  // came to (GET /api/v2/decision-kernel/completion).
  'work.completion': { title: '后台完成要复查吗', stake: 'medium', effect: 'shadow: when a background run finishes, work out whether the main-model review it triggers could be skipped (nothing untold in its handoff, no step to start now); recorded beside the real review and compared with what that review came to; never skips one' },
  'evolution.review': { title: '进化复核', stake: 'medium', effect: 'defer an evolution review (bounded deferral)' },
  'delivery.reach': { title: '触达档位', stake: 'medium', effect: 'lower (never raise) proactive delivery reach' },
  'message.check': { title: '主动消息检查', stake: 'medium', effect: 'request one rewrite of a proactive message' },
  'message.value': { title: '主动消息价值', stake: 'medium', effect: 'score new/continuing/relevant/time-sensitive/decision/already-told for the narrator; code combines it with pacing to send, hold, file or drop' },
  'memory.filter': { title: '召回筛选', stake: 'medium', effect: 'drop recalled passages judged irrelevant' },
  'skill.screen': { title: '技能市场筛选', stake: 'high', effect: 'fit / reject marketplace candidates before main-model review' },
  'candidate.prescore': { title: '进化候选先验', stake: 'high', effect: 'skip paid evaluation of a candidate (never adopt)' },
  'tool.risk': { title: '工具风险确认（已停用）', stake: 'high', effect: 'retired: a full-access grant is never re-asked per call' },
  'initiative.direct': { title: '直接处理', stake: 'high', effect: 'apply a proactive finding\'s fixes of clear objective errors in the background, then let the user keep or revert them, instead of asking first' },
  'gene.route': { title: '经验成机制', stake: 'high', effect: 'decide what a learned rule becomes: a guard (checker tool run after writes), a skill patch, or profile only' },
  'gene.review': { title: '基因复审', stake: 'medium', effect: 'gate before a proposed gene enters the project: addresses its origin, one bounded unit, no conflict, faithful summary' },
  'feedback.signal': { title: '反馈归类', stake: 'medium', effect: 'decide whether a note on a reply becomes a standing lesson or stays about that reply, and which kind of lesson' },
  'guard.triage': { title: '检查命中分诊', stake: 'medium', effect: 'withhold a guard hit from the agent only when it is confidently a false match; guards with many false matches drop back to trial' },
  'turn.review': { title: '回合复盘', stake: 'medium', effect: 'evolution lane B: after a correction, spend one small model call on a skill patch only when the correction shows a recurring method problem no existing note covers' },
  'invite.stale': { title: '邀请是否过期', stake: 'low', effect: 'after the user was away for over a day, fold a decision invitation that the conversation has settled or made pointless' },
  'standard.link': { title: '标准与检查', stake: 'low', effect: 'link a new check to the acceptance standard it helps verify (shown on the evolution page)' },
  'gene.consolidate': { title: '新增还是修改', stake: 'medium', effect: 'before a new rule or check is added, compare it with the existing ones of the same kind: add it, rewrite the one it overlaps to include it (the old one is retired and comes back if the rewrite fails trial), or drop it when that one already says it; and when the user\'s newer word reverses a rule in force, retire that rule (never the other way round: what the assistant concluded does not override a kept rule)' },
  'skill.retire': { title: '退役提议', stake: 'high', effect: 'propose retiring a skill or check that has gone unused, only when it is confidently no longer needed; the user decides' },
  'answer.match': { title: '文字回答卡片', stake: 'high', effect: 'when the user types a message while a question card is open, mark the card answered with their choice when the message confidently answers every question, so the model does not ask again' },
  'lesson.applied': { title: '经验用上了吗', stake: 'low', effect: 'at the end of a turn, count a rule that was in its context (a learned lesson or a working rule) as used only when the turn clearly followed it, and as ignored only when it clearly went against it (a rule that did not come up counts nothing); the first time a lesson from your feedback is followed, the reply carries one quiet note' },
  'diagnostics.delivery': { title: '代码诊断取舍', stake: 'low', effect: 'after an edit, errors always reach the model; a warning does only when it likely causes a bug or breaks the request, not for style' },
  'schedule.suggest': { title: '日程建议', stake: 'medium', effect: 'when the user keeps asking for the same deliverable on different days, offer (never create) a schedule for it above the composer' },
  'tool.constraint': { title: '写入前查约束', stake: 'high', effect: 'before a file write, block it (with the reason, so the model adjusts) only when it confidently breaks a constraint the user stated' },
  'turn.drift': { title: '有没有跑偏', stake: 'medium', effect: 'every few steps of a long turn, put the request back in front of the model when the recent steps have clearly wandered away from it' },
  'turn.rewind': { title: '死路回头', stake: 'high', effect: 'when the same failure keeps repeating, and the approach is confidently a dead end, restore the files changed since it began and tell the model to take another way' },
  'plan.better': { title: '更优方案', stake: 'medium', effect: 'a proactive card proposing a different approach from the one the user asked for is shown only unless the user\'s approach is confidently not worse' },
  'commitment.due': { title: '请求该推进了吗', stake: 'medium', effect: 'pending requests become due for progress or an update by the evidence, not a fixed four hours' },
  'reply.target': { title: '回复了哪条消息', stake: 'medium', effect: 'when a message of yours may answer one of the proactive messages sent recently, judge which one (or none of them, or the latest reply): the delivery ledger counts a reply only for the message it answered, and evolution credits a correction to the turn or run it was about' },
  'share.resolved': { title: '话题结束了吗', stake: 'high', effect: 'when the user\'s reply confidently settles a proactive topic, it is closed and not raised again' },
  'attention.now': { title: '在专注吗', stake: 'medium', effect: 'while the user is in focused work, a non-urgent proactive message waits for a natural pause' },
  'evidence.select': { title: '值得复盘吗', stake: 'medium', effect: 'learning reviews only see episodes with something to learn from; routine ones are set aside unreviewed' },
  'capability.disclosure': { title: '要带哪些工具', stake: 'high', effect: 'a tool service the conversation clearly will not need is kept behind the mcp loader instead of declared up front; used once, it is declared again' },
  'context.forget': { title: '旧结果还要吗', stake: 'high', effect: 'at a cold cache break, or when the context is nearly full, earlier tool results that later work confidently superseded become one line each before any summary is written' },
  // Internal reasoning effort (spec p1 effort): one point per purpose family; GLM-like providers record it in shadow
  // (configuration.internalReasoning.routing and .purposes) until the paid replay clears it; work, setup and compaction
  // stay recorded only until their own validation (internal-reasoning.mjs SHADOW_ONLY_PURPOSES).
  'effort.decision': { title: '主动决策推理强度', stake: 'medium', effect: 'choose the reasoning effort of a proactive decision from the wake it decides on (never above the chat level); a plan, rhythm or failure review always gets the deepest; unknown keeps today\'s effort' },
  'effort.work': { title: '后台工作推理强度', stake: 'medium', effect: 'choose the reasoning effort of a background run or a delegated subtask from its task (never above the chat level); unknown keeps today\'s effort' },
  'effort.narrator': { title: '消息改写推理强度', stake: 'medium', effect: 'choose the reasoning effort of the agent\'s rewrite of its own flagged message (never above the chat level); unknown keeps today\'s effort' },
  'effort.setup': { title: '项目初始化推理强度', stake: 'medium', effect: 'choose the reasoning effort of project setup from its description (never above the chat level); unknown keeps today\'s effort' },
  'effort.compaction': { title: '压缩推理强度', stake: 'medium', effect: 'choose the reasoning effort of a conversation summary from how much and what kind of history it keeps (never above the chat level); unknown keeps today\'s effort' },
  'session.resume': { title: '会回来继续吗', stake: 'low', effect: 'shadow: before an idle conversation is summarized in the background, judge whether the user is likely to come back to it; recorded only, labeled by whether a user turn follows within 7 days' },
  'notes.worth': { title: '笔记要不要记', stake: 'low', effect: 'skip the periodic user-notes model call when no recent message states a new fact about the user or a preference' },
  'ask.necessity': { title: '要不要问', stake: 'high', effect: 'let the model go on with a careful, easily changed default instead of showing a question card; never for permission requests' },
  'input.interjection': { title: '中途插话', stake: 'medium', effect: 'stop the response being written when a new message changes or cancels it, instead of always waiting for the step to finish' },
  'tool.admission': { title: '工具输出取舍', stake: 'medium', effect: 'shadow: for an oversized tool result whose middle was saved aside, judge which omitted parts the request needs; recorded only, labeled by whether the model later read them back' },
  'turn.settled': { title: '回合收尾', stake: 'medium', effect: 'continue unfinished work in the same turn instead of waiting for the user to repeat it; drop a schedule created only to postpone it; offer a feedback invitation when the reply made a judgment call; open a pending commitment for work the reply promises to do later by itself; leave the request a reply confidently waits on you for out of what is owed, not overdue and not pursued, until you speak again in that conversation' },
  'mind.judge': { title: '项目心智判断', stake: 'medium', effect: 'dedup/supersede learned lessons, filter recalled lessons, settle pending commitments (visible and revocable in the mind view); leave a note the assistant learned out of the notes block when a rule in force already says it (nothing is deleted; the note stays on the mind page and returns when that rule goes); after a lesson is revoked, a tool or skill withdrawn, or a conversation message removed, mark the notes, plan items and lessons that still rest on it as stale (out of every model context, shown on the mind page, never deleted)' },
});
// Host-template points that change user-visible routing never inherit the global mode; each is enabled explicitly.
// Every judgment point is built in and active whenever a judge backend exists
// (TypeSafe JEV, else the configured fast model through the same templates).
// There are no user switches; only legacy points superseded by turn.route stay
// off. `mode`/`modes`/`backend` survive solely as a diagnostic override
// (RNA_JEV_MODE, RNA_JEV_MODES="point=mode,…", RNA_JEV_BACKEND, or a saved
// config flagged `diagnostic: true` by the host/tests), never as a setting.
// tool.risk is retired: a full-access grant is the user's decision, so the host never re-asks per call.
const legacyPoints = new Set(['chat.route', 'chat.preflight', 'tool.risk']);
// New points observe first (plan 2026-09-30 §3.4): scored and recorded, never applied, until calibrated.
const shadowPoints = new Set(['tool.admission', 'session.resume', 'work.completion']);
// Diagnostic selections keep their exact meaning: a named mode/modes set turns on
// only what it names (these points stay off unless named), as before the switch removal.
const diagnosticOptIn = new Set(['initiative.gate', 'chat.route', 'turn.route', 'delivery.reach', 'tool.risk', 'message.check', 'message.value', 'memory.filter', 'mind.judge']);
const USER_SETTINGS = ['apiKey', 'fastModel', 'llmModel', 'autoModel'], DIAGNOSTIC_SETTINGS = ['mode', 'modes', 'backend'];
function diagnosticOverride(env = process.env) {
  const out = { modes: {} };
  if (modes.includes(env.RNA_JEV_MODE)) out.mode = env.RNA_JEV_MODE;
  if (['typesafe', 'llm', 'off'].includes(env.RNA_JEV_BACKEND)) out.backend = env.RNA_JEV_BACKEND;
  for (const pair of String(env.RNA_JEV_MODES ?? '').split(',')) { const [point, mode] = pair.split('=').map(value => value?.trim()); if (points.includes(point) && modes.includes(mode)) out.modes[point] = mode; }
  return out;
}
const modes = ['off', 'shadow', 'active'];
const backends = ['typesafe', 'llm', 'off', 'auto'];
// chat.route is opt-in per point: an existing global mode keeps its reviewed
// chat.preflight behavior until the user explicitly enables routing.
const LABEL = /^[a-z][a-z0-9_]{0,39}$/;
// The ledger (every judgment for 31 days, labels kept with it: an outcome that arrives after the row left any window — a
// reply hours later, a gene retired days later — still finds its judgment; mu joins later signals on the ledger id the
// same way) lives in `<state>.rna/metrics/decision-ledger.jsonl` (decision-ledger.mjs), not in the hot state.
const ARCHIVED_VIEWS = ['exclude', 'include', 'only'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const bounded = (value, limit = 700) => String(value ?? '').slice(0, limit);
const retained = row => !row.archivedAt && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
// TypeSafe direct or a gateway exposing the same System One wire format (https; http only on loopback).
const validEndpoint = value => { try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) && value.length <= 300; } catch { return false; } };
const finite = value => typeof value === 'number' && Number.isFinite(value);
// Ledger rows keep compact answers: choice distributions are cut to the top five.
const compactAnswers = answers => answers && Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { type: answer.type, ...(finite(answer.probability) ? { probability: answer.probability } : {}), ...(answer.choice !== undefined ? { choice: answer.choice } : {}), ...(finite(answer.score) ? { score: answer.score } : {}), ...(finite(answer.confidence) ? { confidence: answer.confidence } : {}),
  ...(answer.probabilities ? { probabilities: Object.fromEntries(Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5)) } : {}) }]));
// Per-question positive-class probability for calibration: noul p, choice p(chosen).
const predictionsOf = (answers, keys) => Object.fromEntries((keys ?? Object.keys(answers ?? {})).flatMap(key => { const answer = answers?.[key]; if (!answer) return []; const value = answer.type === 'boolean' ? answer.probability : answer.type === 'choice' ? answer.probabilities?.[answer.choice] ?? answer.confidence : undefined; return finite(value) ? [[key, Math.round(value * 1000) / 1000]] : []; }));
/** The text a promise commitment keeps: the sentence that states it, on one line, at most 300 characters. */
const clipPromise = text => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > 300 ? `${value.slice(0, 299)}…` : value; };
const active = result => result?.source === 'judge' && result.mode === 'active';
// A deterministic host rule (mu: rules before the judge) is applied like an active verdict and recorded like one.
const applied = result => active(result) || result?.source === 'rule';
// Outcome labels for a wake decision (initiative.review / initiative.gate): what the main model then did.
const WAKE_ACTIONS = new Set(['wait', 'work', 'share', 'ask', 'schedule', 'learn']);
const fail = () => { throw Object.assign(new Error('判断辅助配置无效。'), { status: 400, code: 'invalid_decision_configuration' }); };
const titles = { task_state: '任务状态', initiative_need: '主动沟通需要', initiative_pause: '保持安静', schedule_need: '定时职责需要', evolution_need: '方法改进需要', memory_need: '项目记忆需要', user_satisfaction: '用户反馈' };
// A saved key reads as configured even when JEV refuses it. What JEV last did with it says whether it works: the
// newest TypeSafe answer or credential refusal since the key was saved, or the check the settings page runs on save.
const CREDENTIAL_FAILURES = { auth: 'invalid', invalid_credentials: 'invalid', payment_required: 'payment_required' };
const ANSWERED = new Set(['accepted', 'shadow', 'abstain', 'provider_warning']);
const credentialOfStatus = status => status >= 200 && status < 300 ? 'valid' : status === 401 || status === 403 ? 'invalid' : status === 402 ? 'payment_required' : null;
const atOf = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) ? at : 0; };
// One minimal System One question for that check (JEV is cheap; output is free).
const CREDENTIAL_CHECK = { state: 'Credential check.', questions: { reachable: { type: 'noul', instructions: 'Is `state` a non-empty text?', criteria: { true: 'It is.', false: 'It is not.' } } } };
/** Labeled rows by where the label came from (outcome / self / heuristic), so self-labels can be told apart. */
/** Whether a wake or delivery label says the wake was needed (true), was not (false), or says neither (the calibration's reading, decision-calibration-report.mjs wakeObserved / engaged). */
const wakeTruth = value => /^wake_needed|^defer_missed|^delivery_(replied|acted)$/.test(value) ? true : /^wake_unneeded|^defer_right|^delivery_(dismissed|ignored)$/.test(value) ? false : undefined;
const labelSources = rows => { const out = Object.fromEntries(LABEL_SOURCES.map(source => [source, 0])); for (const row of rows) { const source = rowLabelSource(row); if (source) out[source]++; } return out; };
/**
 * session.resume against its outcome label (returned / not_returned within 7 days, idle-compaction-service): how often
 * the conversations it called likely came back, against those it did not, beside the base rate. Measurement only: the
 * point stays in shadow until this beats the base rate (pi measured per-session estimates no better than a constant).
 */
function sessionResumeCheck(rows) {
  const out = { labeled: 0, likely: { returned: 0, notReturned: 0 }, unlikely: { returned: 0, notReturned: 0 } };
  for (const row of rows) {
    const value = row.label?.value, likely = row.outcome?.likely;
    if (!['returned', 'not_returned'].includes(value) || typeof likely !== 'boolean') continue;
    out.labeled++; out[likely ? 'likely' : 'unlikely'][value === 'returned' ? 'returned' : 'notReturned']++;
  }
  if (!out.labeled) return null;
  const share = (part, whole) => whole ? Math.round(part / whole * 1000) / 1000 : null, returned = out.likely.returned + out.unlikely.returned;
  return { ...out, baseRate: share(returned, out.labeled), precision: share(out.likely.returned, out.likely.returned + out.likely.notReturned), accuracy: share(out.likely.returned + out.unlikely.notReturned, out.labeled) };
}
const verdict = (result, key) => result?.source === 'judge' && result.mode === 'active' && result.answers?.[key] ? decisionVerdict(result.answers[key], result.policy) : undefined;
const dissatisfied = result => { const score = verdict(result, 'user_satisfaction'); return typeof score === 'number' && score <= Math.min(.25, result.policy.no + .08); };
const excerpt = (value, limit) => { const text = String(value ?? ''); return text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .55))} […excerpt…] ${text.slice(-Math.floor(limit * .35))}`; };
// Bind a recall hint to the material project evidence and the task/interaction
// state that was actually scored. Clock ticks, other projects' load, and an
// initiative cadence/quiet preference alone do not change the need for memory.
// This identity is local-only: it is never added to JEV's prompt or the ledger.
const chatContextIdentity = input => hash([input.scope.revision, input.state.task, input.state.pending, input.state.recentSummaries, input.state.currentAction]);
function foregroundEvidence(sessions, sessionId) {
  const rows = [];
  for (const session of sessionId ? sessions.filter(row => row.id === sessionId) : sessions) {
    const turns = (session.turns ?? []).filter(row => retained(row) && row.modelConfig?.execution === 'rna' && ['completed', 'failed', 'stopped'].includes(row.status)).slice(-2);
    for (const turn of turns) {
      const items = (session.items ?? []).filter(row => row.turnId === turn.id && retained(row) && !row.streaming && !row.interaction?.contextRevoked && !row.interaction?.sourceDeleted);
      const tools = items.filter(row => row.tool), selected = selectLearningToolReceipts(tools, { limit: 2, failureLimit: 1 });
      const lastExec = tools.findLast(row => row.tool.name === 'project_exec');
      const receipts = [...new Set([...(lastExec ? [lastExec] : []), ...selected])].slice(0, 3).map(row => ({ name: row.tool.name, status: row.tool.status,
        ...((row.tool.name === 'project_exec' || ['failed', 'uncertain'].includes(row.tool.status)) && row.tool.output ? { resultExcerpt: excerpt(row.tool.output, 230) } : {}) }));
      rows.push({ at: turn.completedAt ?? turn.createdAt, value: JSON.stringify({ source: 'foreground_turn', scope: 'Actual tool receipts, possibly excerpted. Assistant claim is unverified. Tool success does not prove overall project completion.', status: turn.status, receipts,
        userRequest: excerpt(items.find(row => row.kind === 'user')?.text, 140), assistantClaim: excerpt(items.findLast(row => row.kind === 'assistant')?.text, 180) }) });
    }
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 2).map(row => row.value);
}

/** The final replies of the latest two finished foreground turns (what the user was told in the conversation). Runs on
 * every gate review: per session one walk from the newest item that stops at its second final, never a scan of the
 * items per turn (a long conversation has thousands of turns). */
/** The gate's recentReports rows the SDK keeps (decision-state.mjs, initiative.review: the latest four). */
export const RECENT_REPORT_ROWS = 4;
/** A background run's line once the run ended: its text is the run's report. A running or paused line says only what review.backgroundWork already says. */
const finishedWorkLine = row => { const work = row.initiative?.backgroundWork; return Boolean(work) && !['running', 'paused'].includes(work.status) && !work.recovering; };
/**
 * What the user was told, for the initiative gate's `recentReports` (already_reported reads it): labelled, oldest first,
 * the latest RECENT_REPORT_ROWS of the proactive deliveries (`inbox`, the latest entries), the foreground replies
 * (`finals`) and the latest finished background run's line (`lines`). The run's line is there because already_reported
 * must see a result the user just read on it (Headlong's wake prompt lists every outbound record, common.sh:210-242); it
 * is at most one row, so it never pushes more than one message or reply out of the rows the SDK keeps (B3 review: three
 * "in progress" lines pushed the only report of a finding out). Lines never count as proactive messages for pacing (F7).
 */
export function recentReportRows({ inbox = [], lines = [], finals = [] } = {}) {
  const lineAt = row => row.updatedAt ?? row.createdAt, line = [...lines].sort((a, b) => String(lineAt(a)).localeCompare(String(lineAt(b)))).at(-1);
  return [...inbox.map(row => ({ at: row.createdAt, text: `[proactive message] ${row.text ?? ''}` })), ...(line ? [{ at: lineAt(line), text: `[background work line] ${line.text}` }] : []), ...finals.map(row => ({ at: row.at, text: `[foreground reply] ${row.text}` }))]
    .sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-RECENT_REPORT_ROWS).map(row => row.text);
}
function foregroundFinals(sessions) {
  const rows = [];
  for (const session of sessions) {
    const turns = new Map((session.turns ?? []).filter(turn => retained(turn) && turn.status === 'completed' && turn.modelConfig?.execution === 'rna').map(turn => [turn.id, turn]));
    if (!turns.size) continue;
    const items = session.items ?? [], seen = new Set();
    for (let index = items.length - 1; index >= 0 && seen.size < 2; index--) {
      const item = items[index], turn = turns.get(item.turnId);
      // The newest qualifying assistant item of a turn is its final reply.
      if (!turn || seen.has(turn.id) || item.kind !== 'assistant' || !retained(item) || item.streaming || item.source === 'initiative' || !String(item.text ?? '').trim()) continue;
      seen.add(turn.id); rows.push({ at: turn.completedAt ?? turn.createdAt, text: item.text });
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-2);
}
/**
 * Does a work.coverage state reach the judge whole? The kernel spends one character budget over the state in root order
 * and cuts what is left; a judge asked about C<j> or R<i> it cannot see answers about nothing, and a confident "no" about
 * an unseen change would let a stale receipt count as covering. The state is sized to fit (decision-state.mjs); this is
 * the check that it did (secret redaction can lengthen a string).
 */
export function workCoverageVisible(state, { maxChars = deriveDecisionPolicy('work.coverage').maxStateChars } = {}) {
  const sent = minimizeDecisionState(state, { maxChars });
  let size = 0;
  const count = value => { if (typeof value === 'string') size += value.length; else if (value && typeof value === 'object') for (const item of Object.values(value)) count(item); };
  count(sent);
  // The minimizer stops at its (clamped) budget: a state that used all of it lost whatever came after.
  if (size >= Math.min(Math.max(maxChars, 256), 10000)) return false;
  const whole = (built, kept, fields) => (built ?? []).length === (kept ?? []).length && (built ?? []).every((row, index) => kept[index]?.id === row.id
    && fields.every(field => Array.isArray(row[field]) ? kept[index][field]?.length === row[field].length : !row[field] || (typeof kept[index][field] === 'string' && kept[index][field].length > 0)));
  return whole(state.changes, sent.changes, ['kind', 'text']) && whole(state.receipts, sent.receipts, ['asked', 'checks', 'result']);
}
/** When an SDK action ended: completion sets finishedAt, a failure only failure.at, a review resolvedAt. */
const endedAt = row => Math.max(...[row.finishedAt, row.resolvedAt, row.failure?.at].filter(Number.isFinite), 0) || row.startedAt || row.createdAt || 0;
function initiativeAssessment(project, sessions) {
  const runtime = project.initiativeRuntime, decision = runtime?.sdkState?.lastDecision;
  if (!decision || !retained(decision) || typeof decision.reason !== 'string' || !decision.reason.trim()
    || !['wait', 'work', 'share', 'learn', 'ask', 'schedule'].includes(decision.action)) return [];
  // A decision is a model assessment, not a tool/delivery receipt. Source
  // sessions may have been removed since it was recorded; never reintroduce
  // their prose while deletion scrubbing or a scoped chat is in progress.
  const sources = runtime.lastDecisionSourceIds;
  const liveSessions = new Set(sessions.map(row => `session:${row.id}`));
  if (Array.isArray(sources) && sources.some(id => !liveSessions.has(id))) return [];
  const evidence = new Map((runtime.sdkState.events ?? []).filter(retained).map(row => [row.id, row]));
  if ((decision.evidenceIds ?? []).some(id => !evidence.has(id))) return [];
  return [JSON.stringify({ source: 'initiative_assessment', action: decision.action,
    interpretation: 'Prior main-model assessment or communication preference, not an execution result, verified completion, permission grant, or evidence that a message was delivered.',
    reason: bounded(decision.reason, 400) })];
}
function failedInitiativeTurn(project, sessions, evidence) {
  if (!retained(evidence) || evidence.type !== 'conversation_result' || typeof evidence.id !== 'string') return false;
  for (const session of sessions) for (const turn of session.turns ?? []) {
    if (!retained(turn) || turn.status !== 'failed' || turn.modelConfig?.execution !== 'rna') continue;
    const base = `turn:${turn.id}:${turn.status}`;
    const occurrence = hash([Number.isFinite(Date.parse(turn.completedAt)) ? Date.parse(turn.completedAt) : turn.createdAt ?? null, Number.isSafeInteger(turn.runtimeAttempts) ? turn.runtimeAttempts : 0]).slice(0, 20);
    const legacy = project.initiativeRuntime?.terminalSourceIdentity?.legacy?.some(row => row.id === base && row.occurrence === occurrence);
    if (evidence.id === (legacy ? base : `${base}@${occurrence}`)) return true;
  }
  return false;
}

/** The auxiliary judge routes a review; it never supplies a project decision,
 * consumes learning evidence, grants a capability or approves a candidate. */
export class DecisionService {
  constructor(store, { kernelFactory = createDecisionKernel, now = Date.now } = {}) {
    this.store = store; this.kernelFactory = kernelFactory; this.now = now; this.deferrals = new Map(); this.closed = false; this.shadows = new Map(); this.lastBackfill = 0;
    this.migrateSettings();
    // The decision ledger (decision-ledger.mjs): the host's, else one beside this store's state (in memory without a file).
    // Rows an older release kept in state move into it now (and again after a rollback and an upgrade back).
    this.ledgerStore = store.decisionLedger ??= new DecisionLedger({ file: typeof store.file === 'string' ? decisionLedgerFile(store.file) : null, now });
    this.absorbLedger();
    this.migrateProvisionalLabels();
  }
  /** Move rows an older release left in state into the ledger file (idempotent; nothing to do almost always). */
  absorbLedger() { try { return this.ledgerStore.absorb(this.store); } catch { return 0; } }
  /** Every ledger row as readers see it now (rows not yet absorbed included), oldest first. */
  ledgerRows() { return this.ledgerStore.view(this.store.state); }
  /**
   * Startup, idempotent (PDL-7, B3; on the ledger since B7): a label taken from the main model's own next choice is a
   * `self` label (decision-ledger.mjs labelSourceOf). A wake label written before labels carried their source — by
   * 0.68.0 and earlier, by a host rolled back to one, or flagged `provisional` before the ledger moved out of state — is
   * read as `self` when the rows move into the ledger (DecisionLedger.absorb), and the observation the calibration backfill
   * took from it is dropped there. This drops such observations still on ledger rows, so the Brier, the buckets and label
   * coverage leave self labels out now instead of once they age out. A later outcome label still replaces one and is
   * observed. Writes only when something changed (a second start writes nothing). C2, which writes wake labels from
   * outcomes, passes `source: 'outcome'` explicitly; the label value alone never makes a label an outcome.
   */
  migrateProvisionalLabels() { try { return this.ledgerStore.dropSelfObservations(); } catch { return 0; /* a read-only host reports them as before; the next start tries again */ } }
  /** One-time migration: the old per-point/global mode and backend selectors were
   * user switches; they are dropped (all points active, backend automatic). A
   * legacy separate judge model becomes the fast model when none is set. */
  migrateSettings() {
    const saved = this.store.state?.configuration?.decisionKernel;
    // Only objects written by the old settings UI are user switches: it always saved backend, a global mode and the
    // per-point modes it showed at the time (7 points in older releases, so the count is not a reliable marker).
    const fromSettingsUi = saved && typeof saved === 'object' && saved.diagnostic !== true && saved.settingsVersion !== 2 && Object.hasOwn(saved, 'backend') && modes.includes(saved.mode) && saved.modes && typeof saved.modes === 'object' && Object.keys(saved.modes).length > 0;
    if (!fromSettingsUi || typeof this.store.mutate !== 'function') return;
    try { this.store.mutate(state => { const target = state.configuration.decisionKernel; for (const key of DIAGNOSTIC_SETTINGS) delete target[key]; if (target.llmModel && !target.fastModel) target.fastModel = target.llmModel; delete target.llmModel; target.settingsVersion = 2; }); } catch { /* a read-only host keeps its config; config() still ignores nothing it cannot migrate */ }
  }
  config() {
    const saved = this.store.state.configuration.decisionKernel ?? {}, env = diagnosticOverride();
    const llmModel = saved.llmModel && typeof saved.llmModel.providerId === 'string' && typeof saved.llmModel.modelId === 'string' ? { providerId: saved.llmModel.providerId, modelId: saved.llmModel.modelId } : null;
    const fastModel = saved.fastModel && typeof saved.fastModel.providerId === 'string' && typeof saved.fastModel.modelId === 'string' ? { providerId: saved.fastModel.providerId, modelId: saved.fastModel.modelId } : null;
    // Diagnostic override only (see top of file); the default is every point active.
    const explicit = { ...Object.fromEntries(Object.entries(saved.modes && typeof saved.modes === 'object' ? saved.modes : {}).filter(([point, value]) => points.includes(point) && modes.includes(value))), ...env.modes };
    // A saved diagnostic selection means exactly what it names; env RNA_JEV_MODES only overrides the named points.
    const diagnostic = Boolean(env.mode || modes.includes(saved.mode) || Object.keys(explicit).some(point => env.modes[point] === undefined));
    const mode = env.mode ?? (modes.includes(saved.mode) ? saved.mode : diagnostic ? 'off' : 'active');
    const pick = point => explicit[point] ?? (diagnostic ? (diagnosticOptIn.has(point) ? 'off' : mode) : legacyPoints.has(point) ? 'off' : shadowPoints.has(point) && mode === 'active' ? 'shadow' : mode);
    // Backend order: TypeSafe JEV when a key exists, else the fast model as an LLM judge (thresholds +0.1), else none.
    const setting = env.backend ?? (backends.includes(saved.backend) ? saved.backend : 'auto'), judge = llmModel ?? fastModel;
    const backend = setting !== 'auto' ? setting : this.key() ? 'typesafe' : judge && this.judgeModel({ llmModel: judge }) ? 'llm' : 'typesafe';
    // Migration: turn.route inherits an explicitly enabled chat.route (it supersedes chat.route + chat.preflight).
    return { backend, mode,
      modes: Object.fromEntries(points.map(point => [point, point === 'turn.route' && explicit['turn.route'] === undefined && explicit['chat.route'] !== undefined ? explicit['chat.route'] : pick(point)])),
      ...(judge ? { llmModel: judge } : {}), ...(fastModel ? { fastModel } : {}),
      // "自动选择模型": run simple turns on fastModel when turn.route says so. Off by default.
      autoModel: saved.autoModel === true };
  }
  /** Base URL for TypeSafe or a gateway with the same System One wire format.
   * Environment only (TYPESAFE_ENDPOINT, as in the official SDKs): the
   * settings API can never redirect the stored key to another host. */
  endpoint() { const value = process.env.TYPESAFE_ENDPOINT; return typeof value === 'string' && validEndpoint(value) ? value : null; }
  key() { return this.store.configurationService.secrets['judge:jev'] ?? process.env.TYPESAFE_API_KEY ?? ''; }
  /**
   * POST /api/v2/decision-kernel/probe — one raw System One call with the configured key, for studying how JEV
   * answers a question before it becomes a template (docs/research/jev-capability-study). Not a decision: no
   * templates, thresholds, cache or ledger; the answers come back as JEV gave them. Counted as 'jev' usage.
   */
  async probe(input = {}) {
    const fail = (message, status = 400, code = 'invalid_probe') => Object.assign(new Error(message), { status, code });
    // { check: 'credential' }: the settings page's one call after a key is saved; the host owns its question.
    const check = Boolean(input && typeof input === 'object' && !Array.isArray(input) && input.check === 'credential' && Object.keys(input).length === 1);
    if (check) input = CREDENTIAL_CHECK;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['state', 'questions'].includes(key))) throw fail('只能包含 state 与 questions');
    const { state, questions } = input, entries = questions && typeof questions === 'object' && !Array.isArray(questions) ? Object.entries(questions) : [];
    if (state === undefined || state === null || !entries.length || entries.length > 64) throw fail('需要 state 和 1–64 个 questions');
    if (entries.some(([id, question]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) || !question || !['noul', 'choice', 'score'].includes(question.type) || question.instructions === undefined || question.criteria === undefined)) throw fail('每个问题需要 type（noul/choice/score）、instructions 与 criteria');
    const body = JSON.stringify({ model: JEV_MODEL, state, questions });
    if (body.length > 400000) throw fail('请求过大');
    const config = this.config(), key = this.key();
    if (config.backend === 'llm' || !key) throw fail('探针需要已配置的 JEV（TypeSafe）凭据', 409, 'jev_unavailable');
    const started = performance.now();
    let response;
    try { response = await fetch(this.endpoint() ?? JEV_ENDPOINT, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) }); }
    catch (error) { throw fail(`JEV 不可达：${error?.name === 'TimeoutError' ? 'timeout' : 'network'}`, 502, 'jev_unreachable'); }
    const text = (await response.text()).slice(0, 256000), latencyMs = Math.round(performance.now() - started);
    let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (response.ok && parsed?.usage) try { this.store.usageLedger?.record({ purpose: 'jev', detail: 'probe', providerId: 'typesafe', modelId: JEV_MODEL, usage: { input: parsed.usage.input_tokens ?? 0, output: parsed.usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false } }); } catch {}
    // Any probe runs on the saved key, so a definite answer or refusal marks that key.
    const marked = credentialOfStatus(response.status);
    if (marked) this.keyCheck = { digest: hash(key), state: marked, at: this.now() };
    if (check) return { status: response.status, latencyMs, credential: this.credential() };
    // The service's error body never carries the key; strip it anyway in case an upstream echoes headers.
    const clean = value => JSON.parse(JSON.stringify(value ?? null).split(key).join('[redacted]'));
    return { status: response.status, latencyMs, ...(parsed ? clean(parsed) : { error: text.split(key).join('[redacted]').slice(0, 2000) }) };
  }
  /** The judge model must be a real API model; interactive-only plans and demo are excluded. */
  judgeModel(config = this.config()) {
    if (!config.llmModel) return null;
    try { const model = resolveModel(this.store.state.configuration, { ...config.llmModel, reasoning: 'default' }); return model.execution === 'rna' && model.usagePolicy !== 'interactive_only' ? model : null; } catch { return null; }
  }
  backendReady(config = this.config()) { return config.backend === 'llm' ? Boolean(this.judgeModel(config)) : config.backend === 'typesafe' && Boolean(this.key()); }
  /** Whether the TypeSafe key works: { state: valid | invalid | payment_required | unverified, at?, source?, reason? }, null without one. */
  credential(config = this.config()) {
    const key = this.key();
    if (config.backend !== 'typesafe' || !key) return null;
    const since = atOf(this.store.state.configuration.decisionKernel?.credentialUpdatedAt), digest = hash(key);
    const last = this.ledgerRows().findLast(row => row.backend === 'typesafe' && atOf(row.at) >= since && (CREDENTIAL_FAILURES[row.reason] || row.networkAttempted === true && ANSWERED.has(row.reason)));
    const seen = last ? { state: CREDENTIAL_FAILURES[last.reason] ?? 'valid', at: atOf(last.at), source: 'ledger', ...(CREDENTIAL_FAILURES[last.reason] ? { reason: last.reason } : {}) } : null;
    const checked = this.keyCheck?.digest === digest && this.keyCheck.at >= since ? { state: this.keyCheck.state, at: this.keyCheck.at, source: 'check' } : null;
    return [seen, checked].filter(Boolean).sort((a, b) => a.at - b.at).at(-1) ?? { state: 'unverified' };
  }
  /** turn.route when enabled (it supersedes chat.route and chat.preflight), else legacy chat.route. */
  routePoint() { return this.config().modes['turn.route'] !== 'off' ? 'turn.route' : 'chat.route'; }
  routeAvailability() { const point = this.routePoint(), available = this.enabled(point); return { available, backend: available ? this.config().backend : null, point }; }
  secrets() { return [...Object.values(this.store.configurationService.secrets ?? {}), ...(this.store.configurationService.secretValues?.() ?? []), ...Object.entries(process.env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(name)).map(([, value]) => value)].filter(value => typeof value === 'string' && value); }
  enabled(point) { const config = this.config(); return !this.closed && config.mode !== 'off' && config.modes[point] !== 'off' && this.backendReady(config); }
  kernel() {
    const config = this.config(), model = config.backend === 'llm' ? this.judgeModel(config) : null, revision = hash([config, model, this.endpoint()]);
    if (this.kernelRevision !== revision) {
      this.instance?.close();
      const provider = model && this.store.state.configuration.providers.find(row => row.id === model.providerId);
      // Resolve credentials per call so rotation applies without a restart.
      const apiKey = (...args) => { const secret = this.store.configurationService.secret(provider.id, provider); return typeof secret === 'function' ? secret(...args) : secret; };
      const { llmModel: _unused, fastModel: _fast, autoModel: _auto, ...options } = config, endpoint = this.endpoint();
      this.instance = this.kernelFactory({ ...options, ...(endpoint && !model ? { endpoint } : {}), ...(model ? { backend: 'llm', requireCredential: false, judge: createLlmDecisionJudge({ model, apiKey, provider: purposeProvider(this.store, undefined, 'jev-llm') }), apiKey: () => '' } : { backend: 'typesafe', apiKey: () => this.key() }), knownSecrets: () => this.secrets(), now: this.now });
      this.kernelRevision = revision;
    }
    return this.instance;
  }
  /** The settings-API view of an update: diagnostic keys from an older settings page are dropped. */
  userSettings(input) { return input && typeof input === 'object' && !Array.isArray(input) ? Object.fromEntries(Object.entries(input).filter(([key]) => !DIAGNOSTIC_SETTINGS.includes(key))) : input; }
  update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => ![...USER_SETTINGS, ...DIAGNOSTIC_SETTINGS].includes(key))) fail();
    const saved = this.store.state.configuration.decisionKernel ?? {}, next = { ...structuredClone(saved), settingsVersion: 2 };
    const model = value => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['providerId', 'modelId'].includes(key)) || typeof value.providerId !== 'string' || typeof value.modelId !== 'string') fail(); return { providerId: value.providerId, modelId: value.modelId }; };
    // `llmModel` is the legacy name of the judge model; it is the fast model now.
    for (const key of ['fastModel', 'llmModel']) {
      if (input[key] === null) { delete next.fastModel; delete next.llmModel; continue; }
      if (input[key] === undefined) continue;
      const value = model(input[key]);
      try { if (resolveModel(this.store.state.configuration, { ...value, reasoning: 'default' }).execution !== 'rna') fail(); } catch { fail(); }
      next.fastModel = value; delete next.llmModel;
    }
    if (input.autoModel !== undefined) { if (typeof input.autoModel !== 'boolean') fail(); next.autoModel = input.autoModel; }
    // Diagnostic override (hosts/tests, not the settings UI).
    if (input.backend !== undefined) { if (!backends.includes(input.backend)) fail(); next.backend = input.backend; next.diagnostic = true; }
    if (input.mode !== undefined) { if (!modes.includes(input.mode)) fail(); next.mode = input.mode; next.diagnostic = true; }
    if (input.modes !== undefined) {
      if (!input.modes || typeof input.modes !== 'object' || Array.isArray(input.modes) || Object.entries(input.modes).some(([point, mode]) => !points.includes(point) || !modes.includes(mode))) fail();
      next.modes = { ...(next.modes ?? {}), ...input.modes }; next.diagnostic = true;
      // Naming a legacy route (chat.route / chat.preflight) selects the legacy path unless turn.route is named too.
      if (['chat.route', 'chat.preflight'].some(point => input.modes[point] !== undefined) && next.modes['turn.route'] === undefined) next.modes['turn.route'] = 'off';
    }
    if (next.backend === 'llm' && !this.judgeModel({ llmModel: next.fastModel ?? next.llmModel })) fail();
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))) fail();
    // Refusals recorded for an earlier key say nothing about this one.
    if (input.apiKey !== undefined) { next.credentialUpdatedAt = this.now(); this.keyCheck = null; }
    this.store.configurationService.writeSecret('judge:jev', input);
    this.store.mutate(state => { state.configuration.decisionKernel = next; });
    this.instance?.close(); this.instance = null; this.kernelRevision = null; this.deferrals.clear();
    return this.public();
  }
  /**
   * Which ledger rows a reader sees. Deleted (or revoked, simulated) projects and conversations never; `archived`
   * (zcode's explicit archived list kind): `exclude` leaves out rows of archived projects and conversations, `include`
   * keeps them, `only` shows nothing else. A row with neither a project nor a conversation is not a project's.
   */
  ledgerFilter({ projectId, point, archived = 'exclude' } = {}) {
    if (!ARCHIVED_VIEWS.includes(archived)) throw Object.assign(new Error('archived must be exclude, include or only'), { status: 400, code: 'archived_invalid' });
    if (point !== undefined && point !== '' && !points.includes(point)) throw Object.assign(new Error('unknown decision point'), { status: 400, code: 'ledger_point_invalid' });
    const live = row => !row.sourceDeleted && !row.contextRevoked && row.simulated !== true;
    const projects = new Map(this.store.state.projects.filter(live).map(row => [row.id, Boolean(row.archivedAt)]));
    const sessions = new Map(this.store.state.sessions.filter(live).map(row => [row.id, Boolean(row.archivedAt) || projects.get(row.projectId) === true]));
    return row => {
      const scope = row.scope ?? {};
      if (!(scope.projectId ? projects.has(scope.projectId) : scope.sessionId && !projectId) || (scope.sessionId && !sessions.has(scope.sessionId)) || (projectId && scope.projectId !== projectId) || (point && row.point !== point)) return false;
      const archivedRow = (scope.projectId && projects.get(scope.projectId)) || (scope.sessionId && sessions.get(scope.sessionId)) || false;
      return archived === 'include' || (archived === 'only') === archivedRow;
    };
  }
  /**
   * GET /api/v2/decision-kernel/ledger: newest first, a page of at most LEDGER_PAGE_MAX rows older than `before` (a
   * ledger id); `nextBefore` continues. The newest rows carry full detail, older ones their compact form (`compact`).
   */
  ledgerPage({ projectId, point, limit = 50, before, archived = 'exclude' } = {}) {
    this.absorbLedger();
    const keep = this.ledgerFilter({ projectId, point, archived }), page = this.ledgerStore.page({ before, limit, keep });
    return { rows: copy(page.rows), hasMore: page.hasMore, nextBefore: page.nextBefore };
  }
  /** GET /api/decision-kernel/ledger (legacy shape: the page's rows only). */
  ledger(options = {}) { return this.ledgerPage(options).rows; }
  public() {
    const config = this.config();
    const plans = this.store.state.projects.flatMap(project => { const saved = validJudgmentPolicy(project); return saved ? [{ projectId: project.id, projectName: project.name, revision: saved.revision, source: saved.source, questionCount: Object.keys(saved.plan.questions).length, questionKeys: Object.keys(saved.plan.questions) }] : []; });
    return { provider: config.backend === 'llm' ? 'llm' : 'jev', model: config.backend === 'llm' ? config.llmModel?.modelId ?? null : JEV_MODEL, ...config, apiKeyConfigured: Boolean(this.key()), status: config.backend === 'off' ? 'off' : !this.backendReady(config) ? 'not_configured' : config.mode === 'off' ? 'off' : 'ready', credential: this.credential(config), route: this.routeAvailability(), plans, planReadyCount: plans.length, metrics: copy(this.store.state.decisionKernelRuntime?.metrics ?? { requests: 0, cacheHits: 0, fallbacks: 0, deferredReviews: 0, totalTokens: 0, lastLatencyMs: null }), performance: decisionPerformance(this.ledger({ limit: 100 })), recent: this.ledger({ limit: 12 }),
      // 判断 settings contract: per-point enable (modes), read-only thresholds and a calibration summary.
      // Read-only: every point is built in (no per-point switches); `mode` shows the effective state.
      points: points.map(point => ({ point, ...DECISION_POINT_INFO[point], mode: config.modes[point], builtIn: !legacyPoints.has(point), templateVersion: TEMPLATE_SPECS[point]?.version ?? null })),
      settings: { editable: USER_SETTINGS.filter(key => key !== 'llmModel'), judgeOrder: ['typesafe', 'fast_model_llm_judge', 'none'] }, diagnosticOverride: (() => { const env = diagnosticOverride(), saved = this.store.state.configuration.decisionKernel ?? {}; return env.mode || env.backend || Object.keys(env.modes).length || saved.diagnostic === true ? { env, saved: saved.diagnostic === true } : null; })(),
      thresholds: copy(DECISION_THRESHOLDS), thresholdsEditable: false, calibration: this.calibrationSummary() };
  }
  record(result, scope, disposition, judgmentPolicy, outcome, extra = {}) {
    const matched = judgmentPolicy && result.planRevision === judgmentPolicy.revision;
    const assessmentDisplay = matched ? Object.entries(result.answers ?? {}).flatMap(([key, answer]) => {
      const question = judgmentPolicy.plan.questions[key]; if (!question || question.type !== answer.type) return [];
      const label = answer.type === 'choice' ? question.criteria[answer.choice] : answer.type === 'boolean' ? question.criteria.true : null;
      const safeLabel = label && this.secrets().reduce((text, secret) => text.split(secret).join('[redacted]'), bounded(label, 400));
      return [{ key, title: titles[key], type: answer.type, ...(safeLabel ? { optionLabel: safeLabel } : {}), ...(Number.isFinite(answer.probability) ? { probability: answer.probability } : {}), ...(Number.isFinite(answer.score) ? { score: answer.score } : answer.type === 'choice' && Number.isFinite(answer.probabilities?.[answer.choice]) ? { score: answer.probabilities[answer.choice] } : {}), ...(Number.isFinite(answer.confidence) ? { confidence: answer.confidence } : {}) }];
    }) : [];
    const row = { id: typeof result.ledgerId === 'string' && result.ledgerId ? result.ledgerId : randomUUID(), at: this.now(), point: result.point, backend: result.backend ?? 'typesafe', outcome: copy(outcome ?? disposition), source: result.source, mode: result.mode, reason: result.reason, scope, disposition,
      policy: result.policy, answers: compactAnswers(result.answers), ...(extra.predictions && Object.keys(extra.predictions).length ? { predictions: extra.predictions } : {}), ...(extra.decided !== undefined ? { decided: extra.decided === true, applied: extra.decided === true && applied(result) } : {}), ...(extra.savings && applied(result) ? { savings: extra.savings } : {}), ...(result.supplementRevision ? { supplementRevision: result.supplementRevision } : {}), latencyMs: result.latencyMs, networkAttempted: result.networkAttempted === true, cached: result.cached, coalesced: result.coalesced, usage: result.usage,
      execution: { latencyClass: result.reason === 'shadow_budget_priority' ? 'not_requested' : result.mode === 'shadow' ? 'parallel' : 'inline', blocksHost: result.mode !== 'shadow', cacheImpact: result.mode === 'shadow' ? 'none' : 'unmeasured', thresholdStatus: 'heuristic_uncalibrated' },
      ...(matched ? { planRevision: judgmentPolicy.revision, planSource: copy(judgmentPolicy.source), assessmentDisplay } : {}) };
    // Deliberately no state, prompts, provider responses, keys or free-form
    // outcomes. Keep a bounded operational ledger separate from project memory.
    // The row goes to the ledger file; state keeps only the running counters (and the empty `recent` an older release
    // appends to after a rollback, absorbed again by this one).
    try { this.absorbLedger(); this.ledgerStore.add(row); } catch { /* telemetry must not block the foreground or main review */ }
    try { this.store.mutate(state => {
      const runtime = state.decisionKernelRuntime ??= { metrics: { requests: 0, cacheHits: 0, fallbacks: 0, deferredReviews: 0, totalTokens: 0, lastLatencyMs: null }, recent: [] };
      runtime.metrics ??= { requests: 0, cacheHits: 0, fallbacks: 0, deferredReviews: 0, totalTokens: 0, lastLatencyMs: null };
      const metrics = runtime.metrics;
      if (result.networkAttempted === true) metrics.requests++;
      if (result.cached) metrics.cacheHits++;
      if (result.source === 'fallback') metrics.fallbacks++;
      if (disposition === 'deferred') metrics.deferredReviews++;
      metrics.totalTokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0); metrics.lastLatencyMs = result.latencyMs;
      if (result.mode === 'shadow' && result.reason !== 'shadow_budget_priority') metrics.parallelScores = (metrics.parallelScores ?? 0) + 1;
      if (result.networkAttempted && !(Number.isFinite(result.usage?.inputTokens) && Number.isFinite(result.usage?.outputTokens))) metrics.unknownUsageRequests = (metrics.unknownUsageRequests ?? 0) + 1;
      if (!Array.isArray(runtime.recent)) runtime.recent = [];
    }); } catch { /* telemetry must not block the foreground or main review */ }
    // Purpose `jev` in the usage ledger: TypeSafe requests (the LLM judge is metered as jev-llm by its provider). `detail: 'decision'` says this is a judgment the daemon asked for (a decision point outside any project and session has no scope to say so); the probe endpoint's rows say 'probe'.
    if (result.networkAttempted && result.backend !== 'llm') try { this.store.usageLedger?.record({ purpose: 'jev', detail: 'decision', projectId: scope?.projectId, sessionId: scope?.sessionId, providerId: 'typesafe', modelId: JEV_MODEL, usage: { input: result.usage?.inputTokens ?? 0, output: result.usage?.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0, cacheUsageReported: false } }); } catch {}
  }
  async decide(input) {
    input.signal?.throwIfAborted();
    // Auxiliary traffic shares the real usage cap. Reservations also survive
    // crashes through the host's normal uncertain-request accounting.
    const key = `judgment:${randomUUID()}`, estimate = Math.min(36000, Math.ceil(JSON.stringify([input.state ?? {}, input.assessmentPlan ?? {}]).length * 1.5) + 2000);
    try { this.store.mutate(state => reserveRealTokens(state, key, estimate, { now: this.now() })); }
    catch (error) { if (error.code === 'budget') return null; throw error; }
    let result;
    try { result = await this.kernel().decide(input); return result; }
    finally { this.store.mutate(state => {
      const reserved = releaseRealTokens(state, key, { now: this.now() });
      if (result?.networkAttempted) {
        const measured = Number.isFinite(result.usage?.inputTokens) && Number.isFinite(result.usage?.outputTokens);
        chargeRealTokens(state, measured ? result.usage.inputTokens + result.usage.outputTokens : reserved, { estimated: !measured, now: this.now() });
      }
    });
      // Cancellation still has a measurable request cost. Record only its
      // bounded receipt; the result cannot defer a review or suppress recall.
      if (input.signal?.aborted && result) this.record(result, { projectId: input.scope.projectId, ...(input.scope.sessionId ? { sessionId: input.scope.sessionId } : {}) }, 'cancelled', input.hostPolicy);
    }
  }
  projection(project, { evidence = [], sessionId, userMessage } = {}) {
    const state = this.store.state, assessment = project.rhythmRuntime?.assessment;
    const sessions = state.sessions.filter(row => row.projectId === project.id && retained(row));
    const priorAssessment = initiativeAssessment(project, sessionId ? sessions.filter(row => row.id === sessionId) : sessions);
    const actions = (project.initiativeRuntime?.sdkState?.actions ?? []).filter(retained);
    const questions = sessions.flatMap(row => row.items ?? []).filter(row => retained(row) && ['pending', 'interrupted'].includes(row.interaction?.status) && row.interaction?.canRespond);
    const running = sessions.some(row => row.status === 'running');
    const pending = actions.filter(row => ['queued', 'running', 'needs_review'].includes(row.status));
    const schedules = (project.schedules ?? []).filter(row => row.enabled);
    const recent = evidence.slice(-6).map(row => ({ id: row.id, type: row.type ?? row.kind, summary: bounded(row.summary ?? row.text), verified: false }));
    const lastAction = actions.at(-1), decidedAt = project.initiativeRuntime?.sdkState?.lastDecision?.at;
    const lifecycle = assessment?.lifecycle ?? 'unknown';
    const recurring = lifecycle === 'recurring' || schedules.length > 0;
    const knownEvidence = new Set([...(priorAssessment.length ? project.initiativeRuntime.sdkState.lastDecision.evidenceIds ?? [] : []), ...(project.learningRuntime?.sdkState?.reviews ?? []).filter(row => retained(row) && !row.sourceRevoked && ['no_change', 'completed'].includes(row.status)).flatMap(row => row.decision?.evidenceIds ?? [])]);
    const novelCount = evidence.filter(row => !knownEvidence.has(row.id)).length;
    const latestUser = (sessionId ? sessions.filter(row => row.id === sessionId) : sessions).flatMap(session => (session.items ?? []).filter(row => {
      const turn = row.turnId && session.turns?.find(turn => turn.id === row.turnId);
      return retained(row) && row.kind === 'user' && typeof row.text === 'string' && (!turn || (retained(turn) && (!turn.modelConfig?.execution || turn.modelConfig.execution === 'rna')));
    })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1)?.text;
    userMessage ??= latestUser;
    return { state: { ...(userMessage ? { userMessage: bounded(userMessage, 2400) } : {}),
      task: { title: project.name, goal: bounded(project.description), phase: lifecycle, summary: bounded(project.focus), completed: lifecycle === 'complete', recurring },
      evidence: recent, recentSummaries: [...foregroundEvidence(sessions, sessionId), ...priorAssessment],
      currentAction: lastAction ? `${lastAction.action}: ${lastAction.status}; ${bounded(lastAction.resultSummary, 500)}` : '',
      pending: { work: pending.some(row => row.action === 'work'), delivery: pending.some(row => ['ask', 'share'].includes(row.action)), questions: questions.length, learning: evidence.length },
      rhythm: { lifecycle, initiativeMode: assessment?.initiative?.mode ?? 'adaptive', evolutionMode: assessment?.evolution?.mode ?? 'evidence', nextRunAt: schedules.map(row => row.nextRunAt).filter(Boolean).sort()[0] ?? '' } },
      signals: { recurring, completed: lifecycle === 'complete', taskType: recurring ? 'recurring' : 'unknown',
        novelty: evidence.length ? novelCount / evidence.length : .15,
        evidenceStrength: evidence.length ? Math.min(.9, .4 + evidence.length / 15) : .25,
        maturity: assessment ? .8 : .2, load: Math.min(1, state.sessions.filter(row => row.status === 'running').length / 4),
        consequence: .7, hasPendingWork: pending.length > 0 || running,
        // PDL-2: the parts of hasPendingWork, apart. Only an action waiting to be checked bypasses the initiative gate; work
        // queued or running and a running foreground turn reach it (hasPendingWork itself still feeds kernel policy).
        pendingReview: actions.some(row => row.status === 'needs_review'), activeWork: pending.some(row => ['queued', 'running'].includes(row.status)), foregroundRunning: running,
        dueSchedule: schedules.some(row => Date.parse(row.nextRunAt) <= this.now()), unansweredQuestion: questions.length > 0,
        // Only a completion the main model has not reviewed yet forces a review: once a decision follows it, the gate judges again.
        deliveryJustCompleted: unreviewedCompletions(evidence, actions, decidedAt).length > 0,
        severeFailure: evidence.some(row => /failed|failure|error/.test(row.type ?? row.kind ?? '') || learningEpisodeOutcome(state, project, row)?.status === 'failed' || failedInitiativeTurn(project, sessions, row)), duplicateEvidence: false },
      scope: { projectId: project.id, ...(sessionId ? { sessionId } : {}), revision: projectRhythmEvidenceKey(state, project) } };
  }
  // Observation-only scoring must not add a serial provider wait or inject
  // auxiliary answers into the main-model prompt. Bound and coalesce work at
  // the host as well as inside the provider kernel; cancellation and billing
  // remain owned by the normal decide path.
  shadow(key, work) {
    if (this.closed || this.shadows.has(key) || this.shadows.size >= 16) return;
    const pending = work().catch(() => {}).finally(() => { if (this.shadows.get(key) === pending) this.shadows.delete(key); });
    this.shadows.set(key, pending);
  }
  shadowBudgetPriority(point, project, { sessionId } = {}) {
    // A parallel observer must not reserve the last allowance before the main
    // request is admitted. With an explicit host cap, spend no auxiliary
    // tokens; this is admission telemetry, not an unperformed model score.
    if (this.store.state.settings.realTokenBudget == null) return false;
    this.record({ ledgerId: randomUUID(), point, source: 'fallback', mode: 'shadow', reason: 'shadow_budget_priority',
      networkAttempted: false, cached: false, coalesced: false, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    { projectId: project.id, ...(sessionId ? { sessionId } : {}) }, point === 'chat.preflight' ? 'chat_preflight' : 'main_review');
    return true;
  }
  async drain() { await Promise.allSettled([...this.shadows.values()]); }
  async review(point, project, options = {}) {
    if (this.enabled(point) && this.config().modes[point] === 'shadow' && !options.force) {
      if (this.shadowBudgetPriority(point, project, options)) return { review: true, reason: 'shadow_budget_priority' };
      this.shadow(`${point}:${project.id}`, () => this.reviewScored(point, project, options));
      return { review: true, reason: 'shadow_parallel' };
    }
    return this.reviewScored(point, project, options);
  }
  /**
   * The signal that sends a review to the main model without asking the judge, or null. Only an action waiting to be
   * checked bypasses as pending work (PDL-2: queued or running work reaches the gate); a delivery that just completed
   * during a foreground turn is judged too, since the turn may already cover it.
   */
  bypassSignal(signals, { progress } = {}) {
    if (signals.dueSchedule) return 'due_schedule';
    if (signals.pendingReview) return 'pending_review';
    if (signals.unansweredQuestion) return 'unanswered_question';
    if (signals.deliveryJustCompleted && !progress?.foreground) return 'delivery_just_completed';
    if (signals.severeFailure) return 'severe_failure';
    return null;
  }
  /**
   * One rule ledger row for a review the host sent to the main model without the judge (`bypass_<signal>`), once per
   * situation: the signal, what the review reads (`identity`: evidence, coordinator revision, rhythm key), the signal's
   * own items (`detail`, e.g. which requests are overdue) and the point's review clock (next review, last decision,
   * failures). A bypass signal can last for hours (an overdue request, a result waiting to be checked); asked again for
   * the same situation (a pump while the coordinator still waits) it writes nothing, so the ledger never fills with
   * copies. A review the main model actually made moves the clock, so the next one gets its own row.
   */
  recordBypass(point, project, signal, judgmentPolicy, { identity = null, detail = null } = {}) {
    const sdk = (point === 'evolution.review' ? project.learningRuntime?.sdkState : project.initiativeRuntime?.sdkState) ?? {};
    const key = `${project.id}:${point}`, situation = hash([signal, identity, detail, sdk.nextReviewAt ?? null, sdk.lastDecision?.at ?? null, sdk.failureCount ?? 0]);
    this.bypassRows ??= new Map();
    if (this.bypassRows.get(key) === situation) return false;
    this.bypassRows.set(key, situation);
    this.record({ ledgerId: randomUUID(), point, backend: 'rule', source: 'rule', mode: 'active', reason: `bypass_${signal}`, policy: null, latencyMs: 0, networkAttempted: false }, { projectId: project.id }, 'main_review', judgmentPolicy);
    return true;
  }
  /**
   * PDL-2 foreground lease: the controller holds decisions while a foreground turn of the project runs (its own user
   * messages are observed, its conversation_result is the wake). One rule row per (project, progress key) makes the
   * hold visible in the ledger; nothing is asked of the judge.
   */
  recordLeaseHold(project, key) {
    if (!project?.id || typeof key !== 'string' || !key) return false;
    this.leaseHolds ??= new Map();
    if (this.leaseHolds.get(project.id) === key) return false;
    this.leaseHolds.set(project.id, key);
    this.record({ ledgerId: randomUUID(), point: 'initiative.review', backend: 'rule', source: 'rule', mode: 'active', reason: 'foreground_lease', policy: null, latencyMs: 0, networkAttempted: false }, { projectId: project.id }, 'deferred', validJudgmentPolicy(project), undefined, { decided: true, savings: { mainModelCalls: 1 } });
    return true;
  }
  /**
   * D2 (plan §2.2, the option-B completion gate): SHADOW ONLY. Every finished background run still sends the next review to
   * the main model (`bypass_delivery_just_completed`, bypassSignal), as before: a paid decision whether or not the run left
   * anything to decide. mu routes a finished job now | next_turn | drop (notify-routing.ts:33-60) and wakes nothing when idle
   * (background.ts:108-121). Here the route each completion WOULD take is worked out beside the real one and recorded in
   * the ledger (point `work.completion`), once per run, to be compared with what the review came to (`completionReport`,
   * from C2's work-outcome view). No verdict is acted on.
   *
   * Code facts first (work-completion.mjs completionFacts): a run whose job needs a check, one that ended without a report,
   * one that resolves a request, one with no handoff: review, as today; a scheduled occurrence: no review (the host delivers
   * it). Everything else goes to the completion template, three literal questions about its handoff (reports_untold,
   * names_next_step, evidence_relevant), combined by combineWorkCompletion; the fallback (no judge, no answer, a budget cap)
   * is `review`, exactly today's behaviour. It is never asked whether the work is done or right (mu goal-met.ts:7-17).
   * `others`: how many other new items the same review reads, a user message and another run's completion alike (every new
   * item but this completion): its outcome is not this completion's alone, and the report keeps those apart. Reviews that
   * read different items in different passes are told apart by the report (rows that share a wake).
   * Only with a JEV backend: the questions were measured on JEV and a fast model would be an unmeasured, paid observer on every
   * completion (the LLM backend's thresholds are 0.1 higher and were never probed). Without a JEV key nothing is recorded, not even
   * the code facts (a row is only ever a verdict beside a review).
   */
  completionShadow(project, evidence = [], { freshCount, bypass = null } = {}) {
    if (this.closed || !this.enabled(COMPLETION_POINT) || this.config().backend !== 'typesafe') return 0;
    const sdk = project.initiativeRuntime?.sdkState, actions = (sdk?.actions ?? []).filter(retained), completions = unreviewedCompletions(evidence, actions, sdk?.lastDecision?.at);
    // Every new item but this completion; with no count from the caller, the items it reads that are not an already-reviewed completion.
    const fresh = new Set(completions.map(row => `action:${row.id}:completed`)), othersOf = action => Number.isFinite(freshCount) ? Math.max(0, freshCount - 1) : evidence.filter(row => row?.id !== `action:${action.id}:completed` && (row?.type !== 'action_completed' || fresh.has(row.id))).length;
    let started = 0;
    for (const action of completions) {
      if (this.completionJudged(action.id) || this.shadows.has(`${COMPLETION_POINT}:${project.id}:${action.id}`)) continue;
      const others = othersOf(action), facts = completionFacts(project, action), info = { actionId: action.id, class: facts.class, change: facts.change, changed: facts.changed, real: bypass ?? 'judged', ...(others ? { others } : {}) };
      if (facts.route) { this.recordCompletion(project, info, { basis: 'code_fact', route: facts.route, reason: `completion_${facts.class}` }); started++; continue; }
      // The judge call runs in parallel with the real review and never blocks it (shadow(): bounded, one per run).
      this.shadow(`${COMPLETION_POINT}:${project.id}:${action.id}`, () => this.completionScored(project, action, facts, info));
      started++;
    }
    return started;
  }
  /** Whether a run's completion already has its row (the ledger is the memory: a restart does not ask again). */
  completionJudged(actionId) {
    if (!this.judgedCompletions) { this.judgedCompletions = new Set(); try { for (const row of this.ledgerRows()) if (row.point === COMPLETION_POINT && typeof row.outcome?.actionId === 'string') this.judgedCompletions.add(row.outcome.actionId); } catch { /* the ledger never blocks a review */ } }
    return this.judgedCompletions.has(actionId);
  }
  /** What the user was told, as the gate reads it (recentReportRows): proactive messages, the latest finished run's line, the foreground replies. */
  completionReports(project) {
    const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && retained(row)), lines = [];
    for (const session of sessions) for (const row of session.items ?? []) if (retained(row) && proactiveRowKind(row) === 'status' && finishedWorkLine(row) && String(row.text ?? '').trim()) lines.push(row);
    return recentReportRows({ inbox: (project.inbox ?? []).filter(row => !row.contextRevoked).slice(-3), lines, finals: foregroundFinals(sessions) });
  }
  /** One ledger row for a completion: the verdict (`route`, why), the code facts and the real routing it sits beside. */
  recordCompletion(project, info, verdict, result = null) {
    const outcome = { ...info, basis: verdict.basis, route: verdict.route, reason: verdict.reason };
    // A code fact is a rule, a budget skip a fallback; both are recorded as the shadow they are (nothing here is applied).
    const rule = verdict.basis === 'code_fact';
    const row = result ?? { ledgerId: randomUUID(), point: COMPLETION_POINT, ...(rule ? { backend: 'rule' } : {}), source: rule ? 'rule' : 'fallback', mode: 'shadow', reason: verdict.reason, policy: null, latencyMs: 0, networkAttempted: false, cached: false, coalesced: false, usage: { inputTokens: 0, outputTokens: 0 } };
    try { this.record(row, { projectId: project.id }, 'work_completion', null, outcome, result ? { predictions: predictionsOf(result.answers), decided: verdict.basis === 'judge' } : {}); } catch { /* telemetry never blocks a review */ }
    this.judgedCompletions?.add(info.actionId);
    return row.ledgerId ?? null;
  }
  async completionScored(project, action, facts, info) {
    // A parallel observer must not reserve the last allowance before the main request is admitted: with an explicit host cap
    // the judge is not asked, and the row says so (a completion without a verdict).
    if (this.store.state.settings.realTokenBudget != null) { this.recordCompletion(project, info, { basis: 'budget', route: 'review', reason: 'shadow_budget_priority' }); return; }
    const state = buildDecisionState('work.completion', { handoff: facts.handoff, recentReports: this.completionReports(project), project: { title: project.name, goal: project.description } }, { now: this.now() });
    const result = await this.decide({ point: COMPLETION_POINT, state, signals: { consequence: .3 }, scope: { projectId: project.id, revision: `completion:${action.id}` }, assessmentPlan: workCompletionTemplate(), fallback: { review: true } });
    if (!result || this.closed) return;
    const combined = result.answers ? combineWorkCompletion(result.answers, { backend: result.backend }) : null;
    // No answer (the judge off, unreachable, abstaining): the route is review, today's behaviour, and the row is no verdict.
    // A diagnostic override can put this point in `active` mode; nothing here is applied whatever the mode, and the row says so.
    const shadow = active(result) ? { ...result, source: 'fallback', mode: 'shadow', reason: 'shadow' } : result;
    this.recordCompletion(project, info, combined ? { basis: 'judge', route: combined.route, reason: combined.reason } : { basis: 'fallback', route: 'review', reason: result.reason ?? 'unavailable' }, shadow);
  }
  /**
   * GET /api/v2/decision-kernel/completion: the shadow verdicts of the window against what the reviews came to
   * (work-completion.mjs completionReport); `projectId`, `window` (24h | 7d | 30d | all), `archived`. Read-only.
   */
  completionReport({ projectId, window = '7d', archived = 'exclude' } = {}) {
    if (!Object.hasOwn(CALIBRATION_WINDOWS, window)) throw Object.assign(new Error('window must be 24h, 7d, 30d or all'), { status: 400, code: 'window_invalid' });
    this.absorbLedger();
    const keep = this.ledgerFilter({ projectId, point: COMPLETION_POINT, archived });
    return completionReport(this.store.state, { rows: this.ledgerRows().filter(keep), wakes: this.store.wakeLog ?? null, window, now: this.now(), projectId: projectId || null });
  }
  async reviewScored(point, project, { evidence = [], signal, revision, force = false, freshCount, progress = null } = {}) {
    if (!this.enabled(point) || force) return { review: true };
    const judgmentPolicy = validJudgmentPolicy(project);
    // initiative.review: host atomic questions ("wake the main model?") ride with
    // the main-model plan, or run alone when the project has no plan yet.
    const gate = point === 'initiative.review' && this.config().modes['initiative.gate'] !== 'off';
    if (!judgmentPolicy && !gate) return { review: true, reason: 'assessment_plan_required' };
    // Work in progress (a foreground turn, background work queued or running): the gate also asks whether the new
    // evidence is about that same work (template v3); a confident yes holds the review until that work ends.
    const inProgress = gate && Boolean(progress?.foreground || progress?.work?.length);
    const input = this.projection(project, { evidence }), identity = hash([judgmentPolicy?.revision ?? 'host-gate', revision ?? null, input.scope.revision, evidence.map(row => [row.id, row.summary, row.status])]);
    const open = gate ? this.openWork(project) : null;
    if (gate) Object.assign(input.state, this.initiativeGateState(project, evidence, { freshCount, open, progress: inProgress ? progress : null }));
    const bypass = this.bypassSignal(input.signals, { progress });
    // D2 (shadow): beside the review the host makes whatever happens next, work out the one a completion would take.
    if (gate && input.signals.deliveryJustCompleted) try { this.completionShadow(project, evidence, { freshCount, bypass }); } catch { /* the shadow never blocks a review */ }
    if (bypass) { this.recordBypass(point, project, bypass, judgmentPolicy, { identity }); return { review: true, reason: 'main_review_required', bypass }; }
    // Rules before the judge (mu; Headlong's pending request outranks the menu): an overdue request from the user reaches
    // the main model, whatever a judge would say, with Headlong's bounds (monolith/step:204-237, 425-441; B3). It never
    // bypasses the foreground lease: during a turn the judge weighs it with the work in progress (the turn may be serving
    // it), and the turn's conversation_result brings it here. A decision that saw it and chose to wait declined it with its
    // reason: not again until new evidence (another revision). Not pursued past PENDING_MAX_AGE_MS. The judge still sees
    // every overdue request in openWork.
    const owed = open?.overdue > 0 && !progress?.foreground ? pursuedOverdue(project.mind, { now: this.now(), revision }) : [];
    if (owed.length) { this.recordBypass(point, project, 'commitment_overdue', judgmentPolicy, { identity, detail: owed.map(row => row.id ?? row.text ?? null) }); return { review: true, reason: 'commitment_overdue' }; }
    const key = `${project.id}:${point}`, old = this.deferrals.get(key), prior = old?.identity === identity ? old.ledgerIds ?? [] : [];
    // The same evidence already judged covered by the same work in progress: held again, without a judge call.
    if (inProgress && old?.holdUntilProgressEnd && old.identity === hash([identity, progress.key])) return { review: false, holdUntilProgressEnd: true, reason: 'in_progress_covers', deferredLedgerIds: old.ledgerIds ?? [] };
    // A small model may delay, never permanently discard. After two negative
    // passes a full review occurs; new evidence invalidates the delay at once.
    if (old?.identity === identity && old.until > this.now()) return { review: false, retryAt: old.until, deferredLedgerIds: prior };
    if (old?.identity === identity && old.count >= 2) { this.deferrals.delete(key); return { review: true, forced: true, deferredLedgerIds: prior }; }
    const defer = (ledgerId, reason) => { const retryAt = this.now() + this.deferralDelay(point, input, project); this.deferrals.set(key, { identity, until: retryAt, count: old?.identity === identity ? old.count + 1 : 1, ledgerIds: [...prior, ledgerId] }); return { review: false, retryAt, reason, ledgerId }; };
    // Rule: nothing arrived since the last decision and everything open waits on the user (open questions to
    // them, no pending request, no other agenda, no held finding): a main-model review would only decide to
    // wait, as it did 27 times in a row on the research project. Deferred without a judge call; the two-pass
    // bound still applies. With nothing open at all the judge decides: the model may still start useful work.
    const fresh = Number.isFinite(freshCount) ? freshCount : evidence.length;
    if (open && fresh === 0 && open.awaitingUser > 0 && open.commitments === 0 && open.agenda - open.awaitingUser <= 0 && open.heldFindings === 0) {
      const row = { ledgerId: randomUUID(), point, backend: 'rule', source: 'rule', mode: 'active', reason: 'nothing_actionable', policy: null, latencyMs: 0, networkAttempted: false };
      this.record(row, { projectId: project.id }, 'deferred', judgmentPolicy, undefined, { decided: true, savings: { mainModelCalls: 1 } });
      return defer(row.ledgerId, 'nothing_actionable');
    }
    const result = await this.decide({ point, ...input, assessmentPlan: judgmentPolicy?.plan ?? initiativeGateTemplate({ inProgress }), ...(gate && judgmentPolicy ? { supplement: initiativeGateTemplate({ inProgress }) } : {}), hostPolicy: judgmentPolicy, fallback: { review: true }, signal });
    signal?.throwIfAborted();
    if (!result || this.closed || !this.enabled(point)) return { review: true };
    const current = this.store.state.projects.find(row => row.id === project.id);
    if (!current || !retained(current) || projectRhythmEvidenceKey(this.store.state, current) !== input.scope.revision || validJudgmentPolicy(current)?.revision !== judgmentPolicy?.revision) {
      this.record(result, { projectId: project.id }, 'stale', judgmentPolicy); return { review: true, stale: true };
    }
    const liveSignals = this.projection(current, { evidence }).signals;
    if (this.bypassSignal(liveSignals, { progress })) {
      this.deferrals.delete(key); this.record({ ...result, reason: 'main_review_required' }, { projectId: project.id }, 'main_review', judgmentPolicy);
      return { review: true, forced: true, reason: 'main_review_required', deferredLedgerIds: prior };
    }
    // JEV supplies scores for existing main-model options only. Host routing
    // can defer an eligible ordinary review, never choose a project action.
    // The host gate may wake a review the plan would defer; a confident "nothing
    // to do" from the gate defers a review the plan is unsure about (the plan's
    // own confident pause still defers). Both stay within the two-pass bound.
    const host = gate && result.answers ? combineInitiativeGate(result.answers, { backend: result.backend, inProgress }) : {}, hostWake = active(result) && this.config().modes['initiative.gate'] === 'active' ? host.wake : undefined;
    const gatePredictions = { ...(finite(host.wakeProbability) ? { needs_main_model: host.wakeProbability } : {}), ...(finite(host.coversProbability) ? { in_progress_covers: host.coversProbability } : {}) };
    // Covered by the work in progress: held until that work ends (its end, or new evidence, wakes the review again). Not a
    // deferral of the two-pass bound: the end of the work always brings a fresh source or a new progress key.
    if (hostWake === false && host.reason === 'in_progress_covers') {
      this.record(result, { projectId: project.id }, 'deferred', judgmentPolicy, undefined, { predictions: gatePredictions, decided: true, savings: { mainModelCalls: 1 } });
      this.deferrals.set(key, { identity: hash([identity, progress.key]), until: Infinity, count: 0, ledgerIds: [...prior, result.ledgerId], holdUntilProgressEnd: true });
      return { review: false, holdUntilProgressEnd: true, reason: 'in_progress_covers', ledgerId: result.ledgerId, result, deferredLedgerIds: prior, ...(host.likelyAction ? { likelyAction: host.likelyAction } : {}) };
    }
    const planKeys = judgmentPolicy ? Object.keys(judgmentPolicy.plan.questions) : [], planAbstained = planKeys.every(key => verdict(result, key) === undefined);
    const planReview = !judgmentPolicy ? true : point === 'initiative.review'
      ? !(verdict(result, 'initiative_need') === false && verdict(result, 'initiative_pause') === true && (!judgmentPolicy.plan.questions.schedule_need || verdict(result, 'schedule_need') === false))
      : verdict(result, 'evolution_need') !== false || dissatisfied(result);
    const review = hostWake === true ? true : hostWake === false ? false : planReview;
    this.record(result, { projectId: project.id }, review ? 'main_review' : 'deferred', judgmentPolicy, undefined, gate ? { predictions: gatePredictions, decided: host.wake !== undefined || !planAbstained, savings: { mainModelCalls: review ? 0 : 1 } } : {});
    if (review) { this.deferrals.delete(key); return { review, retryAt: this.now() + this.deferralDelay(point, input, project), result, deferredLedgerIds: prior, ...(host.likelyAction ? { likelyAction: host.likelyAction } : {}) }; }
    return { ...defer(result.ledgerId, hostWake === false ? 'judged_idle' : 'plan_paused'), result, ...(host.likelyAction ? { likelyAction: host.likelyAction } : {}) };
  }
  /** How long a deferred review waits: the project's assessed cadence, shortened by novelty, bounded. */
  deferralDelay(point, input, project) {
    const assessment = project.rhythmRuntime?.assessment;
    const configuredDelay = point === 'evolution.review' ? assessment?.evolution?.minIntervalMs : assessment?.initiative?.reviewAfterMs;
    const fallbackDelay = point === 'evolution.review' ? (input.signals.recurring ? 30 : 10) * 60000 : (input.signals.completed ? 5 : 1) * 60000;
    // Reuse the project's existing model-assessed cadence. New evidence and
    // higher urgency shorten a deferral; it can never exceed the bounded audit
    // interval, or turn an eligible review into permanently consumed evidence.
    return Math.round(Math.max(60000, Math.min(point === 'evolution.review' ? 1800000 : 300000,
      (Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : fallbackDelay) * (1 - input.signals.novelty * .5))));
  }
  /** What is open in the project mind, as counts: pending requests (and overdue ones), open agenda (and how
   * many of those wait on the user), findings held for the user. Code-computed; the judge sees buckets. */
  openWork(project) {
    const mind = project?.mind ?? {}, now = this.now();
    // An item whose settling work only waits for its changes to be applied (awaitingApply, X-5) is not open work.
    const commitments = (Array.isArray(mind.commitments) ? mind.commitments : []).filter(row => row && (row.status ?? 'pending') === 'pending' && !row.awaitingApply);
    const agenda = (Array.isArray(mind.agenda) ? mind.agenda : []).filter(row => row && (row.status ?? 'open') === 'open' && !row.awaitingApply);
    return { commitments: commitments.length, overdue: overdueCommitments(mind, now).length,
      agenda: agenda.length, awaitingUser: agenda.filter(row => row.kind === 'awaiting_user').length, heldFindings: heldItems(mind).length };
  }
  /**
   * The main model's decision labels the wake judgment that preceded it: a gate that woke it for a
   * `wait` was unneeded; a deferral followed by a non-wait decision on the same evidence was missed.
   * PDL-7: these are `self` labels (B3 called them provisional). They come from the model's own next choice, not from an
   * outcome (mu keeps a judgment point in shadow until its verdicts are compared with outcomes, decision.ts:25-31; a woken
   * decision that proposed redundant work still labelled the gate wake_needed_work). Calibration and label coverage leave
   * them out, and they never write over an outcome label. Where an outcome exists (the decision admitted an action) the
   * outcome's own label replaces this one (labelOutcome, C2); a wait, or a decision the host did not admit, has none
   * and keeps it.
   */
  labelWake(gate, decision) {
    const action = decision?.action;
    if (!gate || typeof action !== 'string' || !WAKE_ACTIONS.has(action)) return 0;
    let labeled = 0;
    const put = (id, label) => { try { if (id && this.labelDecision(id, label, { source: 'self' })) labeled++; } catch { /* labels never block a wake */ } };
    if (gate.review !== false) put(gate.result?.ledgerId, action === 'wait' ? 'wake_unneeded' : `wake_needed_${action}`);
    for (const id of gate.deferredLedgerIds ?? []) put(id, action === 'wait' ? 'defer_right' : 'defer_missed');
    return labeled;
  }
  /**
   * C2 (PDL-7): the outcome of the action a wake admitted labels the judgments behind that wake (work-outcome.mjs
   * outcomeLabels: a change kept, a message that reached the user and got a reaction; none, undone, dismissed, ignored).
   * `source: 'outcome'`: unlike labelWake's `self` labels these are calibrated (an observation, the Brier, the buckets),
   * and they replace a self label. An outcome that moves (a change reverted after it was kept) relabels the row with
   * the new truth, and the observation read from the old one is dropped (DecisionLedger.label). Idempotent: a row whose
   * outcome label already says the same (an earlier pass, or the delivery reaction label `delivery_replied`) is left as it is.
   * Returns whether a label was written.
   */
  labelOutcome(id, label) {
    if (typeof id !== 'string' || !id || typeof label !== 'string' || !LABEL.test(label)) return false;
    if (!this.ledgerStore.has(id)) this.absorbLedger();
    const known = this.ledgerStore.get(id)?.label;
    if (known && rowLabelSource({ label: known }) === 'outcome' && (known.value === label || wakeTruth(known.value) !== undefined && wakeTruth(known.value) === wakeTruth(label))) return false;
    return this.labelDecision(id, label, { source: 'outcome' });
  }
  /** Code-computed state for the initiative gate: buckets, never raw clocks. */
  initiativeGateState(project, evidence = [], { freshCount, open = this.openWork(project), progress = null } = {}) {
    const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && retained(row));
    // One walk over the items (the gate runs on every review): the user's messages, the open question cards, and the
    // lines of finished background runs (F7: told, not sent; a finished run's line carries its report).
    const users = [], questions = [], lines = [];
    for (const session of sessions) for (const row of session.items ?? []) {
      if (!retained(row)) continue;
      if (row.kind === 'user') users.push(row);
      else if (['pending', 'interrupted'].includes(row.interaction?.status) && row.interaction?.canRespond) questions.push(row);
      else if (proactiveRowKind(row) === 'status' && finishedWorkLine(row) && String(row.text ?? '').trim()) lines.push(row);
    }
    users.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const inbox = (project.inbox ?? []).filter(row => !row.contextRevoked).slice(-3);
    // The latest background handoff lives on the SDK action (project.handoffs was never written: the gate saw none).
    const handoff = (project.initiativeRuntime?.sdkState?.actions ?? []).filter(row => retained(row) && typeof row.handoff === 'string' && row.handoff.trim() && ['work', 'learn'].includes(row.action) && ['completed', 'failed', 'cancelled', 'needs_review'].includes(row.status))
      .sort((a, b) => endedAt(a) - endedAt(b)).at(-1)?.handoff;
    const reports = recentReportRows({ inbox, lines, finals: foregroundFinals(sessions) });
    const built = buildDecisionState('initiative.review', { evidence: evidence.map(row => ({ type: row.type ?? row.kind, summary: evidenceText(row) })), handoff,
      lastReportAt: inbox.at(-1)?.createdAt, lastUserAt: users.at(-1)?.createdAt, userActive: sessions.some(row => row.status === 'running'), recentReports: reports, currentTopic: users.at(-1)?.text, pendingQuestions: questions.length,
      freshCount, openWork: open, lastWake: project.mind?.pacing?.wake?.lastOutcome,
      // Work in progress (PDL-2), from code: the running foreground turn's request and the background work queued or running.
      ...(progress?.foreground ? { foregroundTurn: { since: progress.foreground.startedAt, request: progress.foreground.request } } : {}),
      ...(progress?.work?.length ? { backgroundWork: progress.work.slice(0, 3).map(row => ({ status: row.status, intent: row.intent })) } : {}),
      project: { title: project.name, goal: project.description, phase: project.rhythmRuntime?.assessment?.lifecycle } }, { now: this.now() });
    return built;
  }
  async chat(project, options = {}) {
    if (this.enabled('chat.preflight') && this.config().modes['chat.preflight'] === 'shadow') {
      if (this.shadowBudgetPriority('chat.preflight', project, options)) return { needsMemory: true, source: 'fallback', reason: 'shadow_budget_priority' };
      this.shadow(`chat.preflight:${project.id}:${options.sessionId}:${options.turnId}`, () => this.chatScored(project, options));
      return { needsMemory: true, source: 'fallback', reason: 'shadow_parallel' };
    }
    return this.chatScored(project, options);
  }
  async chatScored(project, { sessionId, turnId, userMessage, signal } = {}) {
    if (!this.enabled('chat.preflight')) return { needsMemory: true };
    const judgmentPolicy = validJudgmentPolicy(project);
    if (!judgmentPolicy) return { needsMemory: true, source: 'fallback', reason: 'assessment_plan_required' };
    const input = this.projection(project, { sessionId, userMessage });
    const contextIdentity = chatContextIdentity(input);
    input.scope.revision = turnId; input.signals.consequence = .2;
    const result = await this.decide({ point: 'chat.preflight', ...input, assessmentPlan: judgmentPolicy.plan, hostPolicy: judgmentPolicy, fallback: { needsMemory: true }, signal });
    signal?.throwIfAborted();
    if (!result) return { needsMemory: true, source: 'fallback' };
    const current = this.store.state.projects.find(row => row.id === project.id);
    const sourceRetained = !sessionId || this.store.state.sessions.some(row => row.id === sessionId && row.projectId === project.id && retained(row));
    const live = current && sourceRetained && validJudgmentPolicy(current)?.revision === judgmentPolicy.revision ? this.projection(current, { sessionId, userMessage }) : null;
    const fresh = live && chatContextIdentity(live) === contextIdentity;
    this.record(result, { projectId: project.id, sessionId }, fresh ? 'chat_preflight' : 'stale', judgmentPolicy);
    const skip = fresh && this.enabled('chat.preflight') && verdict(result, 'memory_need') === false && !live.signals.unansweredQuestion && !live.state.pending.work;
    return { needsMemory: !skip, ledgerId: result.ledgerId, source: fresh ? result.source : 'fallback', ...(fresh && result.answers ? { assessment: { planRevision: judgmentPolicy.revision, answers: result.answers, source: result.source } } : {}) };
  }
  /** chat.route (contract v2 §6): one host-template request for reasoning
   * effort, memory need and up to four skill hints. The caller owns the
   * <=900 ms budget and fallback; only active confident verdicts apply. */
  async route(options = {}) {
    if (this.routePoint() === 'turn.route') return this.turnRoute(options);
    const { project = null, sessionId, turnId, userMessage, efforts = [], memory = false, skills = [], signal } = options;
    if (!this.enabled('chat.route')) return null;
    const candidates = skills.filter(skill => typeof skill?.id === 'string' && skill.id).slice(0, MAX_ROUTE_SKILLS);
    const assessmentPlan = chatRouteTemplate({ efforts, memory, skills: candidates });
    if (!Object.keys(assessmentPlan.questions).length) return null;
    const input = project ? this.projection(project, { sessionId, userMessage }) : { state: { ...(userMessage ? { userMessage: bounded(userMessage, 2400) } : {}) }, signals: {}, scope: { ...(sessionId ? { sessionId } : {}) } };
    input.scope = { ...input.scope, revision: turnId }; input.signals.consequence = .2;
    const result = await this.decide({ point: 'chat.route', ...input, assessmentPlan, fallback: { reasoning: 'default', needsMemory: true }, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const effort = assessmentPlan.questions.reasoning_effort ? verdict(result, 'reasoning_effort') : undefined, needsMemory = assessmentPlan.questions.memory_need ? verdict(result, 'memory_need') : undefined;
    const outcome = { reasoning: typeof effort === 'string' ? effort : 'default', needsMemory: needsMemory !== false, skills: candidates.filter(skill => verdict(result, routeSkillKey(skill.id)) === true).map(skill => skill.id) };
    this.record(result, { ...(project ? { projectId: project.id } : {}), ...(sessionId ? { sessionId } : {}) }, 'chat_route', null, outcome);
    return { ...outcome, reasoningDecided: typeof effort === 'string', memoryDecided: typeof needsMemory === 'boolean', ledgerId: result.ledgerId, source: result.source, backend: result.backend ?? this.config().backend, latencyMs: result.latencyMs, reason: result.reason };
  }
  /** turn.route (design §4.1): one speculative fan-out at turn start that
   * supersedes chat.route and chat.preflight. Only the reasoning effort and a
   * confident memory skip change the turn; the rest are tail-context hints
   * (skill suggestion, background stop/redirect, clarify) and prewarm/model
   * tier advice. The caller owns the <=900 ms budget and fallback. */
  async turnRoute({ project = null, sessionId, turnId, userMessage, efforts = [], memory = false, skills = [], background = [], mode, hasAttachments = false, previousStatus, previousUserAt, capture = null, rulebook = null, signal } = {}) {
    if (!this.enabled('turn.route')) return null;
    const config = this.config(), catalog = skills.filter(skill => typeof skill?.id === 'string' && skill.id).slice(0, MAX_ROUTE_CATALOG);
    // K1: per-message signal capture rides in the same request (project turns only).
    const captured = project && capture ? { outputs: (capture.outputs ?? []).slice(0, 3), threads: (capture.threads ?? []).slice(0, 5), questions: (capture.questions ?? []).slice(0, 5), requests: (capture.requests ?? []).slice(0, MAX_CAPTURE_REQUESTS) } : null;
    // D1 exposure: which of the project's lessons and working rules this message calls for (rule_<n>, method_<n>), in the same request.
    const rules = project && rulebook ? { lessons: (rulebook.lessons ?? []).slice(0, EXPOSE_LESSON_LIMIT), methods: (rulebook.methods ?? []).slice(0, EXPOSE_METHOD_LIMIT) } : null, counts = rules && (rules.lessons.length || rules.methods.length) ? { lessons: rules.lessons.length, methods: rules.methods.length } : null;
    const assessmentPlan = turnRouteTemplate({ efforts, memory, tools: true, skills: catalog, background: background.length > 0, fastModel: config.fastModel ?? null, capture: captured, rulebook: counts });
    const state = buildDecisionState('turn.route', { message: userMessage, mode, hasAttachments, previousStatus, previousUserAt, background, ...(captured?.outputs.length ? { previousReply: captured.outputs[0].text } : {}), ...(project ? { project: { title: project.name, goal: project.description } } : {}), ...(counts ? { rulebook: rules } : {}) }, { now: this.now() });
    const scope = { ...(project ? { projectId: project.id } : {}), ...(sessionId ? { sessionId } : {}), revision: turnId };
    const result = await this.decide({ point: 'turn.route', state, signals: { consequence: .2 }, scope, assessmentPlan, fallback: { reasoning: 'default', needsMemory: true }, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const combined = active(result) ? combineTurnRoute(result.answers, { backend: result.backend, skills: catalog, efforts }) : {};
    // Shadow rows still carry predictions and what would have been decided.
    const wouldBe = result.answers ? combineTurnRoute(result.answers, { backend: result.backend, skills: catalog, efforts }) : {};
    const outcome = { reasoning: combined.reasoning ?? 'default', needsMemory: combined.needsMemory !== false, skills: combined.skill ? [combined.skill.id] : [],
      ...(combined.background ? { background: { stop: combined.background.stop, redirect: combined.background.redirect } } : {}), ...(combined.clarify ? { clarify: true } : {}), ...(typeof combined.needsTools === 'boolean' ? { needsTools: combined.needsTools } : {}), ...(combined.modelTier ? { modelTier: combined.modelTier } : {}) };
    const decided = typeof wouldBe.reasoning === 'string' || typeof wouldBe.needsMemory === 'boolean' || Boolean(wouldBe.skill || wouldBe.background?.stop || wouldBe.background?.redirect);
    this.record(result, { ...(project ? { projectId: project.id } : {}), ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }, 'turn_route', null, outcome,
      { predictions: predictionsOf(result.answers), decided, savings: { auxiliaryCalls: memory ? 1 : 0, mainModelCalls: 0 } });
    // Capture verdicts apply only in active mode; abstentions fall back in the host.
    const capturedSignals = captured && active(result) ? combineCapture(result.answers, { backend: result.backend, outputs: captured.outputs.length, threads: captured.threads.length, questions: captured.questions.length, requests: captured.requests.length }) : null;
    // The rules the message calls for apply only in active mode (shadow rows still carry the predictions).
    const exposure = counts && result.answers && active(result) ? combineRuleExposure(result.answers, { backend: result.backend, ...counts }) : null;
    return { ...outcome, point: 'turn.route', ...(exposure ? { exposure } : {}), reasoningDecided: typeof combined.reasoning === 'string', memoryDecided: typeof combined.needsMemory === 'boolean', hints: turnRouteHints(combined), ...(combined.skill ? { skill: combined.skill } : {}),
      ...(capturedSignals ? { capture: capturedSignals } : {}),
      ledgerId: result.ledgerId, source: result.source, backend: result.backend ?? config.backend, latencyMs: result.latencyMs, reason: result.reason };
  }
  /** mind.judge (K1): dedup/supersede a candidate lesson (`candidate` +
   * `lessons`), lesson relevance (`message` + `lessons`, applies) or
   * commitment resolution (`evidence` + `commitments`). Returns index lists
   * or null (off, shadow, unavailable) so the caller uses its fallback. */
  async mindJudge(project, { candidate, lessons = [], message, commitments = [], evidence = [], applies = false, signal } = {}) {
    if (!this.enabled('mind.judge') || !project) return null;
    const counts = { dedup: candidate !== undefined ? Math.min(lessons.length, 5) : 0, applies: applies ? Math.min(lessons.length, 12) : 0, resolved: evidence.length ? Math.min(commitments.length, 8) : 0 };
    if (!counts.dedup && !counts.applies && !counts.resolved) return null;
    const assessmentPlan = mindJudgeTemplate(counts);
    const state = buildDecisionState('mind.judge', { candidate, lessons: lessons.slice(0, Math.max(counts.dedup, counts.applies)), message, commitments: commitments.slice(0, counts.resolved), evidence }, { now: this.now() });
    const result = await this.decide({ point: 'mind.judge', state, signals: { consequence: .4 }, scope: { projectId: project.id, revision: `mind:${hash([candidate ?? null, message ?? null, evidence]).slice(0, 16)}` }, assessmentPlan, fallback: {}, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const combined = result.answers ? combineMindJudge(result.answers, { backend: result.backend }) : null;
    this.record(result, { projectId: project.id }, 'mind_judge', null, combined && active(result) ? { same: combined.same.length, contradicts: combined.contradicts.length, applies: combined.applies.length, resolved: combined.resolved.length, refines: combined.refines?.length ?? 0 } : null, { predictions: predictionsOf(result.answers), decided: Boolean(combined) });
    return active(result) && combined ? { ...combined, ledgerId: result.ledgerId, backend: result.backend } : null;
  }
  /** mind.judge reconciliation (K1): ≤4 open items with their own passages →
   * { answered[], superseded[], blocking{index: bool} } or null (no judge). */
  async mindReconcile(project, { items = [], signal } = {}) {
    if (!this.enabled('mind.judge') || !project || !items.length) return null;
    const batch = items.slice(0, MIND_RECONCILE_BATCH), assessmentPlan = mindReconcileTemplate({ items: batch });
    const state = buildDecisionState('mind.judge', { items: batch }, { now: this.now() });
    const result = await this.decide({ point: 'mind.judge', state, signals: { consequence: .6 }, scope: { projectId: project.id, revision: `reconcile:${hash(batch.map(row => [row.id, row.passages?.map(passage => passage.ref)])).slice(0, 16)}` }, assessmentPlan, fallback: {}, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const combined = result.answers ? combineMindReconcile(result.answers, { backend: result.backend }) : null;
    this.record(result, { projectId: project.id }, 'mind_reconcile', null, combined && active(result) ? { answered: combined.answered.length, superseded: combined.superseded.length, blocking: Object.values(combined.blocking).filter(Boolean).length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(combined) });
    return active(result) && combined ? { ...combined, ledgerId: result.ledgerId, backend: result.backend } : null;
  }
  /** delivery.reach (P3): score whether a ready proactive message could reach
   * the user less intrusively. Options stop at the host-capped tier, so only an
   * active confident verdict for a strictly lower tier changes delivery. */
  async reach(project, { entry = {}, maxTier, recent = [], signal } = {}) {
    if (!this.enabled('delivery.reach') || !['inbox', 'inline', 'notify'].includes(maxTier)) return null;
    // Template v2: atomic nouls combined in code; the tier can only be lowered.
    const assessmentPlan = deliveryReachAtomicTemplate();
    const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && retained(row));
    const lastUser = sessions.flatMap(row => row.items ?? []).filter(row => retained(row) && row.kind === 'user').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
    const state = buildDecisionState('delivery.reach', { text: entry.text, kind: entry.kind, requestedTier: maxTier, lastUserAt: lastUser?.createdAt, activeConversation: sessions.some(row => row.status === 'running'), currentTopic: lastUser?.text, recent }, { now: this.now() });
    const result = await this.decide({ point: 'delivery.reach', state, signals: { consequence: .3, novelty: .5 }, scope: { projectId: project.id, revision: `reach:${entry.actionId ?? randomUUID()}` }, assessmentPlan, fallback: { tier: maxTier }, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const combined = result.answers ? combineReach(result.answers, { maxTier, backend: result.backend }) : { tier: maxTier, lowered: false };
    const tier = active(result) ? combined.tier : maxTier;
    this.record(result, { projectId: project.id }, 'delivery_reach', null, { tier }, { predictions: finite(combined.engagement) ? { engaged: combined.engagement } : {}, decided: active(result) && combined.confident === true });
    return { tier, lowered: tier !== maxTier, ledgerId: result.ledgerId, source: result.source, mode: result.mode };
  }
  /** skill.screen (P4 initialization): per marketplace candidate a boolean
   * "fits these task types" plus an overall score. Only active confident
   * verdicts are returned as decisions; everything else stays ambiguous and
   * goes to the main-model review. JEV never installs or selects alone. */
  async screenSkills({ projectId, title, taskTypes = [], candidates = [], signal } = {}) {
    if (!this.enabled('skill.screen')) return null;
    const rows = candidates.map(row => ({ name: bounded(row?.name, 100), description: bounded(row?.description, 400), source: bounded(row?.source, 160), body: bounded(row?.body ?? row?.skillHead, 700), taskType: typeof row?.taskType === 'string' ? row.taskType : null }));
    if (!rows.length) return null;
    const project = this.store.state.projects.find(row => row.id === projectId), types = taskTypes.filter(type => typeof type === 'string').slice(0, 6);
    // Two-stage screen (official skill-suggestion method). More than 254
    // candidates are bucketed by task type; each bucket gets its own wide pass.
    const buckets = rows.length <= MAX_ROUTE_CATALOG ? [rows.map((_, index) => index)] : Object.values(rows.reduce((out, row, index) => { (out[row.taskType ?? 'other'] ??= []).push(index); return out; }, {})).flatMap(group => Array.from({ length: Math.ceil(group.length / MAX_ROUTE_CATALOG) }, (_, n) => group.slice(n * MAX_ROUTE_CATALOG, (n + 1) * MAX_ROUTE_CATALOG)));
    const verdicts = rows.map(() => undefined), probabilities = rows.map(() => null), ledgerIds = []; let judged = false, gateClosed = true;
    const state = buildDecisionState('skill.screen', { title: title ?? project?.name, goal: project?.description, taskTypes: types });
    for (const bucket of buckets) {
      const wide = skillScreenWideTemplate({ candidates: bucket.map(index => rows[index]) });
      const first = await this.decide({ point: 'skill.screen', scope: { projectId, revision: hash(['wide', types, bucket.map(index => rows[index].name)]) }, state, signals: { consequence: .4, taskType: types[0] }, assessmentPlan: wide, fallback: {}, signal });
      signal?.throwIfAborted();
      if (!first) continue;
      ledgerIds.push(first.ledgerId);
      const stage1 = first.answers ? combineScreenWide(first.answers, { count: bucket.length, backend: first.backend }) : null;
      this.record(first, { projectId }, 'skill_screen', null, { stage: 'wide', gate: stage1?.gate ?? null, shortlist: stage1?.shortlist.length ?? 0 }, { predictions: stage1 ? { gate: stage1.gate } : {}, decided: Boolean(stage1?.open) });
      if (!stage1 || !stage1.open) continue;
      gateClosed = false;
      const shortlist = stage1.shortlist.map(position => bucket[position]);
      const verify = skillScreenVerifyTemplate({ shortlist: shortlist.map(index => rows[index]) });
      const second = await this.decide({ point: 'skill.screen', scope: { projectId, revision: hash(['verify', types, shortlist.map(index => rows[index].name)]) }, state, signals: { consequence: .4, taskType: types[0] }, assessmentPlan: verify, fallback: {}, signal });
      signal?.throwIfAborted();
      if (!second) continue;
      ledgerIds.push(second.ledgerId);
      const stage2 = second.answers ? combineScreenVerify(second.answers, { count: shortlist.length, backend: second.backend }) : null;
      this.record(second, { projectId }, 'skill_screen', null, { stage: 'verify', fit: stage2?.verdicts.filter(value => value === true).length ?? 0, rejectedAll: stage2?.rejectedAll ?? false }, { predictions: stage2 ? Object.fromEntries(stage2.fits.map((value, index) => [fitsKey(index), value])) : {}, decided: Boolean(stage2 && stage2.verdicts.some(value => value !== undefined)), savings: { mainModelCalls: stage2 && stage2.verdicts.every(value => value !== undefined) ? 1 : 0 } });
      if (!active(first) || !active(second) || !stage2) continue;
      judged = true;
      shortlist.forEach((index, position) => { verdicts[index] = stage2.verdicts[position]; probabilities[index] = stage2.fits[position]; });
      // Candidates outside the shortlist are rejected only with a confident wide pass and open gate (high stake).
      if (stage1.rejectRest || stage2.rejectedAll) bucket.forEach(index => { if (!shortlist.includes(index)) verdicts[index] = false; });
    }
    return { source: judged ? 'judge' : 'fallback', verdicts, probabilities, method: 'two_stage_v2', ...(gateClosed && ledgerIds.length ? { gate: 'closed' } : {}), ledgerId: ledgerIds[0] ?? null, ledgerIds };
  }
  /** skill.screen pick (project foundation): ONE choice request over the
   * candidates' names and descriptions; its probability distribution selects
   * up to `max` skills to install. No main-model review, no source reading. */
  async pickSkills({ projectId, title, candidates = [], min = 2, max = 3, signal } = {}) {
    if (!this.enabled('skill.screen')) return null;
    const rows = candidates.slice(0, MAX_ROUTE_CATALOG).map(row => ({ name: bounded(row?.name, 100), description: bounded(row?.description, 400), ...(row?.source ? { source: bounded(row.source, 160) } : {}) }));
    if (!rows.length) return null;
    const project = this.store.state.projects.find(row => row.id === projectId);
    const state = buildDecisionState('skill.screen', { title: title ?? project?.name, goal: project?.description });
    const result = await this.decide({ point: 'skill.screen', scope: { projectId, revision: hash(['pick', rows.map(row => row.name)]) }, state, signals: { consequence: .4 }, assessmentPlan: skillPickTemplate({ candidates: rows }), fallback: {}, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    const picked = result.answers ? combineSkillPick(result.answers, { count: rows.length, min, max }) : null;
    this.record(result, { projectId }, 'skill_screen', null, { stage: 'pick', picked: picked?.indexes.length ?? 0, none: picked?.none ?? null }, { predictions: picked ? { picked: picked.indexes.length } : {}, decided: Boolean(picked) });
    if (!active(result) || !picked) return { source: 'fallback', indexes: [], ledgerId: result.ledgerId ?? null };
    return { source: 'judge', indexes: picked.indexes, alternates: picked.alternates, none: picked.none, probabilities: picked.probabilities, ledgerId: result.ledgerId ?? null };
  }
  /** candidate.prescore (P4 evolution): comparative prior for an authored
   * candidate. It may only decide whether to spend evaluation, never adopt. */
  async prescoreCandidate({ projectId, summary, hypothesis, changedAreas = [], evidence = [], signal } = {}) {
    if (!this.enabled('candidate.prescore')) return null;
    const state = buildDecisionState('candidate.prescore', { summary, hypothesis, changedAreas, evidence });
    const result = await this.decide({ point: 'candidate.prescore', scope: { projectId, revision: hash([summary, hypothesis, changedAreas]) }, state, signals: { consequence: .5 }, assessmentPlan: candidatePrescoreAtomicTemplate(), fallback: {}, signal });
    signal?.throwIfAborted();
    if (!result) return null;
    // Atomic answers combined in code; P4 keeps its w_jev = 0.2 on `probability`.
    const combined = result.answers ? combinePrescore(result.answers, { backend: result.backend }) : null, use = active(result) && combined;
    this.record(result, { projectId }, 'candidate_prescore', null, { better: use && typeof combined.better === 'boolean' ? combined.better : null },
      { predictions: combined ? { ...predictionsOf(result.answers, ['targets_observed_problem', 'may_regress_other_tasks', 'exceeds_hypothesis']), prior: combined.probability } : {}, decided: typeof combined?.better === 'boolean', savings: { mainModelCalls: use && combined.better === false ? 1 : 0 } });
    return { source: use ? 'judge' : 'fallback', ...(use && typeof combined.better === 'boolean' ? { better: combined.better } : {}), ...(use && typeof combined.expectedGain === 'number' ? { expectedGain: combined.expectedGain } : {}), ...(use ? { probability: combined.probability } : {}), ledgerId: result.ledgerId };
  }
  /** tool.risk (advisory, opt-in, off by default): before a high-risk call
   * under full permission. A confident danger with a second signal asks the
   * user to confirm through the existing interaction flow; it never widens a
   * permission, and every failure keeps today's behavior (the call proceeds). */
  toolRiskCandidate({ project, tool, level }) {
    if (!project || level !== 'execute' || !this.enabled('tool.risk')) return false;
    return tool?.name === 'project_exec' || tool?.name === 'mcp_call' || Boolean(tool?.mcpServerId) && tool.effect !== 'read' && tool.permission !== 'read';
  }
  async toolRisk({ project, sessionId, turnId, tool, args, userMessage, signal } = {}) {
    if (!this.enabled('tool.risk')) return { confirm: false };
    const state = buildDecisionState('tool.risk', { name: tool?.name, effect: tool?.name === 'project_exec' ? 'exec' : 'write', arguments: args, workspace: project?.workspace, ...(userMessage !== undefined ? { message: userMessage } : {}) });
    const result = await this.decide({ point: 'tool.risk', state, signals: { consequence: .8 }, scope: { projectId: project?.id, ...(sessionId ? { sessionId } : {}), revision: hash([turnId, tool?.name, args]) }, assessmentPlan: toolRiskTemplate(), fallback: { confirm: false }, signal });
    if (!result) return { confirm: false };
    const flags = state.tool.features.flags.filter(flag => flag !== 'force_flag'), combined = result.answers ? combineToolRisk(result.answers, { backend: result.backend, flags }) : { confirm: false, risk: 0, reasons: [] };
    const confirm = active(result) && combined.confirm;
    this.record(result, { projectId: project?.id, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }, 'tool_risk', null, { confirm, reasons: combined.reasons }, { predictions: result.answers ? { risk: combined.risk } : {}, decided: combined.confirm });
    return { confirm, risk: combined.risk, reasons: combined.reasons, flags, ledgerId: result.ledgerId, source: result.source };
  }
  /** message.check: semantic contract checks beside P3's regex checks. Codes
   * only add one repair request; hard regex checks stay authoritative. */
  /** `verdict: true`: null instead of [] when there is no active verdict (judge off or in shadow, no answer, the
   * budget), so a caller that measures can tell "unchecked" from "clean". */
  async messageCheck(project, { text, recent = [], kind = null, signal, verdict: strict = false } = {}) {
    if (!this.enabled('message.check') || typeof text !== 'string' || !text.trim()) return strict ? null : [];
    // `kind`: { title, taskTypes, deliverable? } — which references a user needs depends on the kind of project.
    const state = buildDecisionState('message.check', { text, recent, project: kind ?? { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'message.check', state, signals: { consequence: .4 }, scope: { projectId: project.id, revision: hash(['message', text, kind?.deliverable ?? null]) }, assessmentPlan: messageCheckTemplate({ deliverable: Boolean(kind?.deliverable) }), fallback: {}, signal });
    if (!result) return strict ? null : [];
    const codes = result.answers ? combineMessageCheck(result.answers, { backend: result.backend }) : [];
    this.record(result, { projectId: project.id }, 'message_check', null, { codes: active(result) ? codes : [] }, { predictions: predictionsOf(result.answers), decided: codes.length > 0 });
    return active(result) ? strict && !result.answers ? null : codes : strict ? null : [];
  }
  /** initiative.direct: should this proactive finding be handled (its fixes
   * applied in the background, keep/revert offered) instead of asked about?
   * True only for an active, confident verdict on every condition. */
  async directHandle(project, { text, kind = null, signal } = {}) {
    if (!this.enabled('initiative.direct') || typeof text !== 'string' || !text.trim()) return false;
    const state = buildDecisionState('initiative.direct', { text, project: kind ?? { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'initiative.direct', state, signals: { consequence: .7 }, scope: { projectId: project.id, revision: hash(['direct', text]) }, assessmentPlan: directHandleTemplate(), fallback: {}, signal });
    if (!result) return false;
    const direct = result.answers ? combineDirectHandle(result.answers, { backend: result.backend }) : false;
    this.record(result, { projectId: project.id }, 'direct_handle', null, { direct: active(result) && direct }, { predictions: predictionsOf(result.answers), decided: direct });
    return active(result) && direct;
  }
  /** work.coverage: does a background work the main model just proposed only repeat checks that receipts (where it will
   * look), finished work or work still running already covered, with nothing relevant changed since? { covered } is
   * true only for an active, confident verdict; anything else (no receipts, judge off or failing) admits the work. */
  async workCoverage(project, decision, { signal } = {}) {
    if (!this.enabled('work.coverage') || decision?.action !== 'work' || typeof decision.content !== 'string' || !decision.content.trim()) return { covered: false };
    const built = workCoverageInput(this.store.state, project, decision, { now: this.now() });
    if (!built.receipts.length) return { covered: false, reason: 'no_receipts' };
    const state = buildDecisionState('work.coverage', built.input, { now: this.now() });
    // Any receipt or change the judge would not see whole: admit the work rather than judge it on part of the state.
    if (!workCoverageVisible(state)) return { covered: false, reason: 'state_truncated' };
    const result = await this.decide({ point: 'work.coverage', state, signals: { consequence: .7 }, scope: { projectId: project.id, revision: hash(['coverage', decision.content, built.receipts, built.changes]) }, assessmentPlan: workCoverageTemplate({ receipts: built.receipts.length, changes: built.changes.length }), fallback: {}, signal });
    signal?.throwIfAborted();
    if (!result) return { covered: false };
    const verdict = result.answers ? combineWorkCoverage(result.answers, { receipts: built.receipts, changes: built.changes, backend: result.backend }) : { covered: false, reason: 'unanswered' };
    const covered = active(result) && verdict.covered === true;
    this.record(result, { projectId: project.id }, 'work_coverage', null, { covered, ...(Number.isInteger(verdict.receipt) ? { receipt: verdict.receipt } : {}), ...(verdict.reason ? { reason: verdict.reason } : {}) },
      { predictions: predictionsOf(result.answers), decided: verdict.covered === true, savings: { mainModelCalls: covered ? 1 : 0 } });
    return { covered, ledgerId: result.ledgerId, ...(verdict.reason ? { reason: verdict.reason } : {}) };
  }
  /** turn.settled: judged on the final reply of a foreground turn. Returns
   * { continue, dropSchedule, feedback, ledgerId } when active, else null. */
  async settled(project, { sessionId, turnId, request, reply, effects = [], continuations = 0, scheduled = false, recentFeedbackAsks = [], signal } = {}) {
    if (!this.enabled('turn.settled') || typeof request !== 'string' || !request.trim() || typeof reply !== 'string' || !reply.trim()) return null;
    // Like every parallel observer: with an explicit usage cap, a shadow score spends nothing.
    if (this.config().modes['turn.settled'] === 'shadow' && this.store.state.settings.realTokenBudget != null) return null;
    const state = buildDecisionState('turn.settled', { request, reply, effects, continuations, recentFeedbackAsks, project: project ? { title: project.name, taskTypes: project.taskTypes ?? [] } : null }, { now: this.now() });
    const scope = { ...(project ? { projectId: project.id } : {}), sessionId, turnId };
    // MIND-4: the sentences of the reply the promise question may point at (code splits, the judge picks).
    const sentences = replySentences(reply);
    const result = await this.decide({ point: 'turn.settled', state, signals: { consequence: .5 }, scope: { ...scope, revision: hash(['settled', reply, effects, continuations]) }, assessmentPlan: turnSettledTemplate({ scheduled, askedBefore: recentFeedbackAsks.length > 0, sentences }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineTurnSettled(result.answers, { backend: result.backend, sentences: sentences.length }) : { continue: false, dropSchedule: false, feedback: false };
    // A schedule this turn created carries the later work its reply speaks of: no commitment on top of it. A promise is kept with the
    // sentence that states it (the judge's pick; else the reply's closing words) for the commitment's text.
    if (verdict.promise === true && scheduled) verdict.promise = false;
    const applied = active(result) ? verdict : { continue: false, dropSchedule: false, feedback: false };
    this.record(result, scope, 'turn_settled', null, applied, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    // The promise's words go to the caller, never into the ledger.
    return active(result) ? { ...verdict, ...(verdict.promise === true ? { promiseText: clipPromise(sentences[verdict.promiseSentence] ?? sentences.slice(-2).join(' ')) } : {}), ledgerId: result.ledgerId } : null;
  }
  /** gene.route (evolution v3): what mechanism should a learned rule become? null when no judge. */
  async geneRoute(project, { kind, text, quote = '', source = '', signal } = {}) {
    if (!this.enabled('gene.route') || typeof text !== 'string' || !text.trim()) return null;
    const state = buildDecisionState('gene.route', { kind, text, quote, source, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'gene.route', state, signals: { consequence: .6 }, scope: { projectId: project.id, revision: hash(['gene-route', text]) }, assessmentPlan: geneRouteTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineGeneRoute(result.answers, { backend: result.backend }) : { guard: false, everyWrite: false, method: false, periodic: false };
    this.record(result, { projectId: project.id }, 'gene_route', null, active(result) ? verdict : { guard: false, everyWrite: false, method: false, periodic: false }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** gene.review (evolution v3 gate 2): may this proposed gene enter the project? null when no judge. */
  async geneReview(project, { layer, title, summary, body, trigger, origin, existing = [], replaced = [], signal } = {}) {
    if (!this.enabled('gene.review') || typeof body !== 'string' || !body.trim()) return null;
    const state = buildDecisionState('gene.review', { layer, title, summary, body, trigger, origin, existing, replaced, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'gene.review', state, signals: { consequence: .5 }, scope: { projectId: project.id, revision: hash(['gene-review', title, body, replaced.map(row => row.title)]) }, assessmentPlan: geneReviewTemplate({ existing: state.existing.length, replaced: state.replaced?.length ?? 0 }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineGeneReview(result.answers, { backend: result.backend }) : { pass: false, problems: ['no_answers'] };
    this.record(result, { projectId: project.id }, 'gene_review', null, active(result) ? verdict : { pass: false, problems: [] }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** feedback.signal: is a 👍/👎 note a standing wish (lesson) or about this reply only, and which kind? */
  async feedbackSignal(project, { vote, note, reply = '', signal } = {}) {
    if (!this.enabled('feedback.signal') || typeof note !== 'string' || !note.trim()) return null;
    const state = buildDecisionState('feedback.signal', { vote, note, reply, project: project ? { title: project.name, taskTypes: project.taskTypes ?? [] } : null }, { now: this.now() });
    const scope = project ? { projectId: project.id } : {};
    const result = await this.decide({ point: 'feedback.signal', state, signals: { consequence: .4 }, scope: { ...scope, revision: hash(['feedback', vote, note, reply.length]) }, assessmentPlan: feedbackSignalTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineFeedbackSignal(result.answers, { backend: result.backend }) : { durable: 'unknown', kind: null };
    this.record(result, scope, 'feedback_signal', null, active(result) ? verdict : { durable: 'unknown', kind: null }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** guard.triage: which hits of one guard run are real; null when no judge (every hit is kept). */
  async guardTriage(project, { title, rule, file, hits = [], signal } = {}) {
    if (!this.enabled('guard.triage') || !hits.length || typeof rule !== 'string' || !rule.trim()) return null;
    const state = buildDecisionState('guard.triage', { title, rule, file, hits, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const count = state.guard.hits.length;
    const result = await this.decide({ point: 'guard.triage', state, signals: { consequence: .3 }, scope: { projectId: project.id, revision: hash(['guard-triage', rule, file, state.guard.hits.map(row => row.excerpt)]) }, assessmentPlan: guardTriageTemplate({ hits: count }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineGuardTriage(result.answers, { backend: result.backend, hits: count }) : null;
    this.record(result, { projectId: project.id }, 'guard_triage', null, active(result) && verdict ? { real: verdict.real.length, falseMatches: verdict.falseMatches.length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(verdict) });
    return active(result) && verdict ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** turn.review (lane B gate): is a corrected turn worth a skill patch? false/null means no model call. */
  async turnReview(project, { request = '', reply = '', correction = '', existing = [], signal } = {}) {
    if (!this.enabled('turn.review') || !correction.trim()) return null;
    const state = buildDecisionState('turn.review', { request, reply, correction, existing, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'turn.review', state, signals: { consequence: .5 }, scope: { projectId: project.id, revision: hash(['turn-review', correction, reply.length]) }, assessmentPlan: turnReviewTemplate({ existing: state.retro.existing.length }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineTurnReview(result.answers, { backend: result.backend }) : { review: false, method: null, covered: null };
    this.record(result, { projectId: project.id }, 'turn_review', null, active(result) ? verdict : { review: false }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** invite.stale: is an invitation left open over a long absence still worth asking? null when no judge (keep it). */
  async inviteStale(project, { kind, text, createdAt, conversation = [], signal } = {}) {
    if (!this.enabled('invite.stale') || typeof text !== 'string' || !text.trim()) return null;
    const state = buildDecisionState('invite.stale', { kind, text, createdAt, conversation, project: project ? { title: project.name, taskTypes: project.taskTypes ?? [] } : null }, { now: this.now() });
    const result = await this.decide({ point: 'invite.stale', state, signals: { consequence: .2 }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash(['invite-stale', kind, text, conversation.length]) }, assessmentPlan: inviteStaleTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineInviteStale(result.answers, { backend: result.backend }) : { stale: false, relevant: null };
    this.record(result, project ? { projectId: project.id } : {}, 'invite_stale', null, active(result) ? verdict : { stale: false }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** standard.link: the index of the standard a check helps verify, or null. */
  async standardLink(project, { title, summary, standards = [], signal } = {}) {
    if (!this.enabled('standard.link') || !standards.length) return null;
    const list = standards.slice(0, STANDARD_LINK_LIMIT);
    const state = buildDecisionState('standard.link', { title, summary, standards: list, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'standard.link', state, signals: { consequence: .2 }, scope: { projectId: project.id, revision: hash(['standard-link', title, list]) }, assessmentPlan: standardLinkTemplate({ standards: list.length }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineStandardLink(result.answers, { backend: result.backend }) : { index: null };
    const index = Number.isInteger(verdict.index) && verdict.index < list.length ? verdict.index : null;
    this.record(result, { projectId: project.id }, 'standard_link', null, active(result) ? { index } : { index: null }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { index, ledgerId: result.ledgerId } : null;
  }
  /** gene.consolidate: add | revise <index> | skip <index> for a proposed rule against the existing rules of its kind, or null (no judge). */
  /** `limit`: GENE_CONSOLIDATE_LIMIT rules with their text (rule against rule), or up to GENE_PLACE_LIMIT by title and summary (new content placed among every rule in force).
   * `contradicts` (C4, placement): also which of the rules the new content REVERSES (`contradicts`, indices). Asked with the same call; when any is
   * reversed, a second call asks of those alone whether the new content is only a special case of the rule (`narrower`): a special case is revised, never retired. */
  async geneConsolidate(project, { layer, title, summary, body = '', existing = [], limit = GENE_CONSOLIDATE_LIMIT, contradicts = false, signal } = {}) {
    if (!this.enabled('gene.consolidate') || !project || !existing.length) return null;
    const list = existing.slice(0, Math.min(limit, GENE_PLACE_LIMIT));
    const state = buildDecisionState('gene.consolidate', { layer, title, summary, body, existing: list, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'gene.consolidate', state, signals: { consequence: .4 }, scope: { projectId: project.id, revision: hash(['gene-consolidate', layer, title, summary, list.map(row => row.title), contradicts]) }, assessmentPlan: geneConsolidateTemplate({ existing: list.length, contradicts }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineGeneConsolidate(result.answers, { backend: result.backend, existing: list.length }) : { action: 'add', index: null };
    // Second stage: only the rules found reversed, and only to tell a total reversal from a special case. Without an answer
    // to it nothing is retired on the first stage alone.
    let narrowerLedgerId = null;
    if (active(result) && verdict.contradicts?.length) {
      const second = await this.decide({ point: 'gene.consolidate', state, signals: { consequence: .4 }, scope: { projectId: project.id, revision: hash(['gene-consolidate-narrower', layer, title, summary, list.map(row => row.title), verdict.contradicts]) }, assessmentPlan: geneConsolidateTemplate({ existing: list.length, narrower: verdict.contradicts }), fallback: {}, signal });
      const stage = second && active(second) && second.answers ? combineGeneConsolidate(second.answers, { backend: second.backend, existing: list.length }) : null;
      if (second) { narrowerLedgerId = second.ledgerId ?? null; this.record(second, { projectId: project.id }, 'gene_consolidate_narrower', null, stage ? { narrower: stage.narrower?.length ?? 0, of: verdict.contradicts.length } : null, { predictions: predictionsOf(second.answers), decided: Boolean(stage) }); }
      verdict.contradicts = stage ? verdict.contradicts.filter(index => !(stage.narrower ?? []).includes(index)) : [];
    }
    this.record(result, { projectId: project.id }, 'gene_consolidate', null, active(result) ? { action: verdict.action, index: verdict.index, ...(verdict.contradicts ? { contradicts: verdict.contradicts.length } : {}) } : { action: 'add', index: null }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId, ...(narrowerLedgerId ? { narrowerLedgerId } : {}) } : null;
  }
  /**
   * mind.judge, revocation (C4): after something the mind rested on was withdrawn, which of ≤12 rows (notes, open plan items,
   * lessons) are stale? `kind`: lesson (the row restates a revoked lesson, `revoked`), tool (it tells the assistant to use a withdrawn
   * tool, `tools.withdrawn`; `tools.available` is what is left), source (a note no longer stated by the messages that still stand
   * behind it, each row's `sources`). One call for the rows; when they do not fit one state (the kernel cuts a state past its bound,
   * and a row it cannot see is answered about blind) as many calls as that takes, together, never fewer rows.
   * Returns { stale: [row index], ledgerId } or null (off, shadow, no answer to any of the calls: the caller tries again).
   */
  async mindStale(project, { kind, rows = [], revoked, tools, signal } = {}) {
    if (!this.enabled('mind.judge') || !project || !rows.length) return null;
    const batch = rows.slice(0, MIND_STALE_LIMIT), stateOf = list => buildDecisionState('mind.judge', { rows: list, ...(revoked !== undefined ? { revoked } : {}), ...(tools ? { tools } : {}) }, { now: this.now() });
    const groups = [];
    for (let at = 0; at < batch.length;) { let count = batch.length - at; while (count > 1 && JSON.stringify(stateOf(batch.slice(at, at + count))).length > 9000) count--; groups.push({ at, rows: batch.slice(at, at + count) }); at += count; }
    const asked = await Promise.all(groups.map(async group => {
      const assessmentPlan = mindStaleTemplate({ kind, rows: group.rows.length });
      if (!assessmentPlan) return null;
      const result = await this.decide({ point: 'mind.judge', state: stateOf(group.rows), signals: { consequence: .6 }, scope: { projectId: project.id, revision: `stale:${kind}:${hash([kind, revoked ?? null, tools?.withdrawn ?? null, group.rows.map(row => [row.text, row.sources ?? null])]).slice(0, 16)}` }, assessmentPlan, fallback: {}, signal });
      signal?.throwIfAborted();
      if (!result) return null;
      const combined = result.answers ? combineMindStale(result.answers, { backend: result.backend, kind, rows: group.rows.length }) : null;
      this.record(result, { projectId: project.id }, 'mind_stale', null, combined && active(result) ? { kind, stale: combined.stale.length, rows: group.rows.length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(combined) });
      return active(result) && combined ? { stale: combined.stale.map(index => index + group.at), ledgerId: result.ledgerId, backend: result.backend } : null;
    }));
    if (!asked.length || asked.some(row => !row)) return null;
    return { stale: asked.flatMap(row => row.stale), ledgerId: asked[0].ledgerId, ...(asked.length > 1 ? { ledgerIds: asked.map(row => row.ledgerId) } : {}), backend: asked[0].backend };
  }
  /**
   * mind.judge, covered (D4): which of ≤12 lines (the user's preference notes, or the lines of a recalled OpenViking preference
   * passage) are already stated by one of `rules`, the standing rules the model reads in every request? One call for the
   * lines; when they do not fit one state, as many calls as that takes (as mindStale). Returns { covered: [line index], ledgerId }
   * or null (off, shadow, no answer to some call: the caller keeps every line and tries again later).
   */
  async mindCovered(project, { rows = [], rules = [], signal } = {}) {
    if (!this.enabled('mind.judge') || !project || !rows.length || !rules.length) return null;
    const batch = rows.slice(0, MIND_COVERED_LIMIT), stateOf = list => buildDecisionState('mind.judge', { rows: list, rules }, { now: this.now() });
    const groups = [];
    for (let at = 0; at < batch.length;) { let count = batch.length - at; while (count > 1 && JSON.stringify(stateOf(batch.slice(at, at + count))).length > 9000) count--; groups.push({ at, rows: batch.slice(at, at + count) }); at += count; }
    const asked = await Promise.all(groups.map(async group => {
      const assessmentPlan = mindCoveredTemplate({ rows: group.rows.length });
      if (!assessmentPlan) return null;
      const result = await this.decide({ point: 'mind.judge', state: stateOf(group.rows), signals: { consequence: .3 }, scope: { projectId: project.id, revision: `covered:${hash([rules.map(row => row.text ?? row), group.rows.map(row => row.text)]).slice(0, 16)}` }, assessmentPlan, fallback: {}, signal });
      signal?.throwIfAborted();
      if (!result) return null;
      const combined = result.answers ? combineMindCovered(result.answers, { backend: result.backend, rows: group.rows.length }) : null;
      this.record(result, { projectId: project.id }, 'mind_covered', null, combined && active(result) ? { covered: combined.covered.length, rows: group.rows.length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(combined) });
      return active(result) && combined ? { covered: combined.covered.map(index => index + group.at), ledgerId: result.ledgerId, backend: result.backend } : null;
    }));
    if (!asked.length || asked.some(row => !row)) return null;
    return { covered: asked.flatMap(row => row.covered), ledgerId: asked[0].ledgerId, ...(asked.length > 1 ? { ledgerIds: asked.map(row => row.ledgerId) } : {}), backend: asked[0].backend };
  }
  /** skill.retire: propose retiring an unused capability only on a confident "no longer needed". */
  async skillRetire(project, { kind, name, summary, usage, recent = [], signal } = {}) {
    if (!this.enabled('skill.retire') || typeof name !== 'string' || !name.trim()) return null;
    const state = buildDecisionState('skill.retire', { kind, name, summary, usage, recent, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'skill.retire', state, signals: { consequence: .5 }, scope: { projectId: project.id, revision: hash(['skill-retire', kind, name, recent.length]) }, assessmentPlan: skillRetireTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineSkillRetire(result.answers, { backend: result.backend }) : { retire: false, needed: null };
    this.record(result, { projectId: project.id }, 'skill_retire', null, active(result) ? verdict : { retire: false }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** answer.match: per question of an open card, the option index the user's message chose, 'own', or null. */
  async answerMatch(project, { message, questions = [], signal } = {}) {
    if (!this.enabled('answer.match') || typeof message !== 'string' || !message.trim() || !questions.length) return null;
    const list = questions.slice(0, 3), state = buildDecisionState('answer.match', { message, questions: list }, { now: this.now() });
    const result = await this.decide({ point: 'answer.match', state, signals: { consequence: .5 }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash(['answer-match', message, list.map(row => row.question)]) }, assessmentPlan: answerMatchTemplate({ questions: list.map(row => ({ options: (row.options ?? []).length })) }), fallback: {}, signal });
    if (!result) return null;
    const picks = result.answers ? combineAnswerMatch(result.answers, { backend: result.backend, questions: list.length }) : null;
    this.record(result, project ? { projectId: project.id } : {}, 'answer_match', null, active(result) && picks ? { picks } : null, { predictions: predictionsOf(result.answers), decided: Boolean(picks) });
    return active(result) && picks ? { picks, ledgerId: result.ledgerId } : null;
  }
  /** lesson.applied: which of the recalled lessons the reply followed (indexes), or null without a judge. */
  async lessonApplied(project, { digest = null, lessons = [], methods = [], signal } = {}) {
    if (!this.enabled('lesson.applied') || !digest || !(lessons.length + methods.length)) return null;
    const list = lessons.slice(0, LESSON_APPLIED_LIMIT), working = methods.slice(0, METHOD_APPLIED_LIMIT), state = buildDecisionState('lesson.applied', { digest, lessons: list, methods: working }, { now: this.now() });
    const result = await this.decide({ point: 'lesson.applied', state, signals: { consequence: .2 }, scope: { projectId: project.id, revision: hash(['lesson-applied', digest.reply, digest.wrote ?? '', list.map(row => row.text), working.map(row => row.title)]) }, assessmentPlan: lessonAppliedTemplate({ lessons: list.length, methods: working.length }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineLessonApplied(result.answers, { backend: result.backend, lessons: list.length, methods: working.length }) : null;
    this.record(result, { projectId: project.id }, 'lesson_applied', null, active(result) && verdict ? { followed: verdict.followed.length + verdict.methodsFollowed.length, wentAgainst: verdict.wentAgainst.length + verdict.methodsWentAgainst.length, of: list.length + working.length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(verdict) });
    return active(result) && verdict ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** diagnostics.delivery: indexes of the warnings worth the model's attention after an edit, or null without a judge. */
  async diagnosticsDelivery(project, { request = '', file = '', tool = '', warnings = [], signal } = {}) {
    if (!this.enabled('diagnostics.delivery') || !warnings.length) return null;
    const list = warnings.slice(0, DIAGNOSTICS_WARNINGS), state = buildDecisionState('diagnostics.delivery', { request, file, tool, warnings: list }, { now: this.now() });
    const result = await this.decide({ point: 'diagnostics.delivery', state, signals: { consequence: .2 }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash(['diagnostics', file, list.map(row => `${row.code}:${row.message}`)]) }, assessmentPlan: diagnosticsDeliveryTemplate({ warnings: list.length }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineDiagnosticsDelivery(result.answers, { backend: result.backend, warnings: list.length }) : null;
    this.record(result, project ? { projectId: project.id } : {}, 'diagnostics_delivery', null, active(result) && verdict ? { delivered: verdict.deliver.length, of: list.length } : null, { predictions: predictionsOf(result.answers), decided: Boolean(verdict) });
    return active(result) && verdict ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /** schedule.suggest: { suggest, index } over the user's recent requests, or null without a judge. */
  async scheduleSuggest(project, { requests = [], signal } = {}) {
    if (!this.enabled('schedule.suggest') || requests.length < 3) return null;
    const list = requests.slice(-SCHEDULE_SUGGEST_LIMIT), state = buildDecisionState('schedule.suggest', { requests: list, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'schedule.suggest', state, signals: { consequence: .3 }, scope: { projectId: project.id, revision: hash(['schedule-suggest', list.map(row => row.text)]) }, assessmentPlan: scheduleSuggestTemplate({ requests: list.length }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineScheduleSuggest(result.answers, { backend: result.backend }) : { suggest: false, index: null };
    const index = Number.isInteger(verdict.index) && verdict.index < list.length ? verdict.index : null;
    this.record(result, { projectId: project.id }, 'schedule_suggest', null, active(result) ? { suggest: verdict.suggest && index !== null } : { suggest: false }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { suggest: verdict.suggest && index !== null, index, ledgerId: result.ledgerId } : null;
  }
  /** Shared shape for the plan §9 C-batch points: build state, decide, combine, record; null without a judge. */
  async judgeWith(point, { project = null, input, template, combine, consequence = .4, revision, summarize = verdict => verdict, signal }) {
    if (!this.enabled(point)) return null;
    const state = buildDecisionState(point, { ...input, ...(project ? { project: { title: project.name, taskTypes: project.taskTypes ?? [] } } : {}) }, { now: this.now() });
    const result = await this.decide({ point, state, signals: { consequence }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash([point, revision]) }, assessmentPlan: template(state), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combine(result.answers, result.backend, state) : null;
    this.record(result, project ? { projectId: project.id } : {}, point.replace('.', '_'), null, active(result) && verdict ? summarize(verdict) : null, { predictions: predictionsOf(result.answers), decided: Boolean(verdict) });
    return active(result) && verdict ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  /**
   * effort.<purpose> (spec p1 effort §3.3): how much reasoning an internal model call needs, as a depth mapped onto the
   * plan's efforts (internal-reasoning.mjs). `rule` (computed in code: a plan, rhythm or failure review) settles the
   * depth without a judge; `floor` (also code's) is the lightest depth a judged verdict may take. `apply`
   * (effortMayApply: the setting routes this purpose, or this point named active in RNA_JEV_MODES for a trial) lets the
   * effort be sent; otherwise the verdict is recorded only and the caller keeps today's effort. Returns
   * { effort, depth, source, ledgerId, applied }, or null (judge off, no answer, budget).
   */
  async internalEffort(project, { purpose, plan, facts = {}, task, evidence, message, request, rule = null, floor = null, apply = false, capture = false, signal } = {}) {
    const point = `effort.${purpose}`;
    if (this.closed || !EFFORT_POINTS.includes(point) || plan?.mode !== 'route') return null;
    const config = this.config(), mode = config.modes[point];
    if (config.mode === 'off' || mode === 'off') return null;
    const trial = diagnosticOverride().modes[point] === 'active', allowed = apply || trial, scope = project?.id ? { projectId: project.id } : {};
    if (['light', 'standard', 'deep'].includes(rule)) {
      const effort = effortForDepth(rule, plan), applies = allowed && mode === 'active';
      const result = { ledgerId: randomUUID(), point, backend: config.backend, source: applies ? 'rule' : 'fallback', mode: applies ? 'active' : 'shadow', reason: 'rule', networkAttempted: false, cached: false, coalesced: false, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
      this.record(result, scope, 'effort', null, { purpose, depth: rule, effort, applied: applies, rule: true }, { decided: true });
      return { effort, depth: rule, source: 'rule', ledgerId: result.ledgerId, applied: applies };
    }
    if (!this.backendReady(config)) return null;
    // Like every observer that only records: with an explicit usage cap, a shadow judgment spends nothing — unless the
    // opt-in capture asked for these verdicts (the Stage B replay needs them; each costs ≈1/1000 of the call it describes).
    if (!(allowed && mode === 'active') && !capture && this.store.state.settings.realTokenBudget != null) return null;
    const state = buildDecisionState(point, { facts, task, evidence, message, request, project: { title: project?.name, taskTypes: project?.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point, state, signals: { consequence: .6 }, scope: { ...scope, revision: hash([point, state]) }, assessmentPlan: effortTemplate(purpose), fallback: {}, signal });
    if (!result) return null;
    // `floor` (computed in code): a state the judge was never measured on may not be judged lighter than this depth.
    const judged = result.answers ? combineEffortDepth(result.answers, { backend: result.backend, point }) : null;
    const raised = Boolean(judged && EFFORT_DEPTHS.includes(floor) && EFFORT_DEPTHS.indexOf(judged) < EFFORT_DEPTHS.indexOf(floor)), depth = raised ? floor : judged, effort = depth ? effortForDepth(depth, plan) : null;
    const applies = allowed && active(result) && typeof effort === 'string';
    // A verdict the caller will not send is recorded as a shadow score (never as applied), whatever the kernel mode.
    this.record(applies || !active(result) ? result : { ...result, source: 'fallback', mode: 'shadow', reason: 'shadow_routing' }, scope, 'effort', null, { purpose, depth, effort, applied: applies, ...(raised ? { judged, floor } : {}) }, { predictions: predictionsOf(result.answers), decided: Boolean(depth) });
    return { effort, depth, source: 'jev', ledgerId: result.ledgerId, applied: applies };
  }
  /** Whether an effort verdict for this purpose may be sent: the setting routes this purpose (or RNA_JEV_MODES names the
   * point active for a trial) and the point is active. Otherwise the route only records, beside the call. */
  effortMayApply(purpose, { route = false } = {}) {
    const point = `effort.${purpose}`, config = this.config();
    // Work (no replay of its own yet), setup and compaction (no labelled probes yet) stay recorded only, whatever the setting.
    return !this.closed && EFFORT_POINTS.includes(point) && config.mode !== 'off' && config.modes[point] === 'active' && (route && !SHADOW_ONLY_PURPOSES.includes(purpose) || diagnosticOverride().modes[point] === 'active');
  }
  /**
   * Label for an applied effort verdict: adequate (the call succeeded at it) or inadequate (repaired, truncated, failed).
   * `source` as labelDecision: `outcome` by default (what the call did); `self` when the label is the system's own next
   * judgment (the narrator's revision read by the message check).
   */
  labelEffort(ledgerId, label, { source } = {}) { if (!['adequate', 'inadequate'].includes(label)) return false; try { return this.labelDecision(ledgerId, label, source ? { source } : {}); } catch { return false; } }
  /** tool.constraint: indexes of the stated constraints a pending write breaks. */
  toolConstraint(project, { tool, path, text = '', rules = [], signal } = {}) {
    if (!rules.length) return Promise.resolve(null);
    const list = rules.slice(0, TOOL_CONSTRAINT_LIMIT);
    return this.judgeWith('tool.constraint', { project, input: { tool, path, text, rules: list }, template: state => toolConstraintTemplate({ rules: state.rules.length }), combine: (answers, backend) => combineToolConstraint(answers, { backend, rules: list.length }), consequence: .6, revision: [tool, path, text.length, list], signal });
  }
  turnDrift(project, { request, recent = [], signal } = {}) {
    return this.judgeWith('turn.drift', { project, input: { request, recent }, template: () => turnDriftTemplate(), combine: (answers, backend) => combineTurnDrift(answers, { backend }), consequence: .3, revision: [request, recent], signal });
  }
  turnRewind(project, { request, failure, attempts = [], signal } = {}) {
    return this.judgeWith('turn.rewind', { project, input: { request, failure, attempts }, template: () => turnRewindTemplate(), combine: (answers, backend) => combineTurnRewind(answers, { backend }), consequence: .6, revision: [request, failure, attempts.length], signal });
  }
  planBetter(project, { question, userApproach, evidence = '', signal } = {}) {
    return this.judgeWith('plan.better', { project, input: { question, userApproach, evidence }, template: () => planBetterTemplate(), combine: (answers, backend) => combinePlanBetter(answers, { backend }), consequence: .4, revision: [question, userApproach], signal });
  }
  /** evidence.select: indexes of the learning episodes with something to learn from, and of the routine ones. */
  evidenceSelect(project, { episodes = [], signal } = {}) {
    if (!episodes.length) return Promise.resolve(null);
    const list = episodes.slice(0, EVIDENCE_SELECT_LIMIT);
    return this.judgeWith('evidence.select', { project, input: { episodes: list }, template: state => evidenceSelectTemplate({ episodes: state.learning.episodes.length }), combine: (answers, backend) => combineEvidenceSelect(answers, { backend, episodes: list.length }), consequence: .3, revision: list.map(row => row.id ?? row.summary), summarize: verdict => ({ signal: verdict.signal.length, quiet: verdict.quiet.length }), signal });
  }
  /** capability.disclosure: indexes of the tool services the conversation could need, and of those it clearly will not. */
  capabilityDisclosure(project, { request = '', services = [], signal } = {}) {
    if (!services.length || !String(request).trim()) return Promise.resolve(null);
    const list = services.slice(0, CAPABILITY_DISCLOSURE_LIMIT);
    return this.judgeWith('capability.disclosure', { project, input: { request, services: list }, template: state => capabilityDisclosureTemplate({ services: state.disclosure.services.length }), combine: (answers, backend) => combineCapabilityDisclosure(answers, { backend, services: list.length }), consequence: .3, revision: [request.slice(0, 200), list.map(row => row.id ?? row.name)], summarize: verdict => ({ needed: verdict.needed.length, defer: verdict.defer.length }), signal });
  }
  /** context.forget: indexes of the earlier tool results the work still needs, and of those later work superseded. */
  contextForget(project, { request = '', recent = [], results = [], signal } = {}) {
    if (!results.length) return Promise.resolve(null);
    const list = results.slice(0, CONTEXT_FORGET_LIMIT);
    return this.judgeWith('context.forget', { project, input: { request, recent, results: list }, template: state => contextForgetTemplate({ results: state.forget.results.length }), combine: (answers, backend) => combineContextForget(answers, { backend, results: list.length }), consequence: .3, revision: list.map(row => row.id), summarize: verdict => ({ needed: verdict.needed.length, stale: verdict.stale.length }), signal });
  }
  /**
   * session.resume (shadow; spec p1 compaction §D7): before an idle conversation is summarized in the background, is the
   * user likely to come back to it? Recorded only, whatever the mode: the caller keeps the ledger id and labels it by
   * whether a user turn follows within 7 days. Null without a judge.
   */
  async sessionResume(project, { state: input, signal } = {}) {
    if (!this.enabled('session.resume')) return null;
    const state = buildDecisionState('session.resume', { ...input, ...(project ? { project: { title: project.name, taskTypes: project.taskTypes ?? [] } } : {}) }, { now: this.now() });
    const result = await this.decide({ point: 'session.resume', state, signals: { consequence: .2 }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash(['session.resume', input?.sessionId ?? null, input?.lastUserMessage ?? '', input?.idle ?? '']) }, assessmentPlan: sessionResumeTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineSessionResume(result.answers, { backend: result.backend }) : null;
    this.record(result, project ? { projectId: project.id } : {}, 'session_resume', null, verdict, { predictions: predictionsOf(result.answers), decided: Boolean(verdict) });
    return verdict && result.ledgerId ? { ...verdict, ledgerId: result.ledgerId, mode: result.mode ?? null } : null;
  }
  commitmentDue(project, { commitments = [], conversation = [], signal } = {}) {
    if (!commitments.length) return Promise.resolve(null);
    const list = commitments.slice(0, COMMITMENT_DUE_LIMIT);
    return this.judgeWith('commitment.due', { project, input: { commitments: list, conversation }, template: state => commitmentDueTemplate({ commitments: state.due.commitments.length }), combine: (answers, backend) => combineCommitmentDue(answers, { backend, commitments: list.length }), consequence: .3, revision: [list.map(row => row.id ?? row.request), conversation.length], summarize: verdict => ({ due: verdict.due.length, wait: verdict.wait.length }), signal });
  }
  shareResolved(project, { messages = [], reply, signal } = {}) {
    return this.judgeWith('share.resolved', { project, input: { messages, reply }, template: () => shareResolvedTemplate(), combine: (answers, backend) => combineShareResolved(answers, { backend }), consequence: .3, revision: [messages, reply], signal });
  }
  /**
   * reply.target (C3): which proactive message does the user's message answer? Options are the recent deliveries (newest
   * first, `deliveries`: { kind, text }) and, when one came after them, the assistant's latest reply (`latestReply`).
   * Returns { target: index | null (none of them, or `other: 'latest_reply'`) | undefined (no verdict), ledgerId },
   * { shadow: true } for a shadow run, or null when the judge did not answer.
   */
  async replyTarget(project, { message = '', deliveries = [], latestReply = '', signal } = {}) {
    const list = deliveries.slice(0, MAX_REPLY_CANDIDATES);
    if (!this.enabled('reply.target') || typeof message !== 'string' || !message.trim() || !list.length) return null;
    const hasLatest = typeof latestReply === 'string' && latestReply.trim().length > 0;
    const state = buildDecisionState('reply.target', { message, deliveries: list, ...(hasLatest ? { latestReply } : {}), ...(project ? { project: { title: project.name, taskTypes: project.taskTypes ?? [] } } : {}) }, { now: this.now() });
    const result = await this.decide({ point: 'reply.target', state, signals: { consequence: .3 }, scope: { ...(project ? { projectId: project.id } : {}), revision: hash(['reply.target', message, list.map(row => row.text), hasLatest ? latestReply : '']) }, assessmentPlan: replyTargetTemplate({ candidates: list.length, latestReply: hasLatest }), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineReplyTarget(result.answers, { backend: result.backend, candidates: list.length }) : null;
    this.record(result, project ? { projectId: project.id } : {}, 'reply_target', null, active(result) && verdict ? { target: verdict.target === undefined ? 'abstained' : verdict.target === null ? 'none' : 'delivery' } : null, { predictions: predictionsOf(result.answers), decided: Boolean(verdict && verdict.target !== undefined) });
    if (result.source === 'judge' && result.mode === 'shadow') return { shadow: true };
    return active(result) && verdict ? { ...verdict, ledgerId: result.ledgerId } : null;
  }
  attentionNow(project, { typing = false, pace, sinceLast, recent = [], signal } = {}) {
    return this.judgeWith('attention.now', { project, input: { typing, pace, sinceLast, recent }, template: () => attentionNowTemplate(), combine: (answers, backend) => combineAttentionNow(answers, { backend }), consequence: .2, revision: [typing, pace, sinceLast, recent.length], signal });
  }
  /** notes.worth: is a batch of user messages worth the notes model call? false = confidently nothing new (skip); null = unsure or no judge (make the call). */
  async notesWorth(project, { messages = [], existing = [], signal } = {}) {
    if (!this.enabled('notes.worth') || !messages.length) return null;
    const state = buildDecisionState('notes.worth', { messages, existing, project: project ? { title: project.name, taskTypes: project.taskTypes ?? [] } : null }, { now: this.now() });
    const scope = project ? { projectId: project.id } : {};
    const result = await this.decide({ point: 'notes.worth', state, signals: { consequence: .2 }, scope: { ...scope, revision: hash(['notes', messages.join('\u0000').length, messages.at(-1) ?? '']) }, assessmentPlan: notesWorthTemplate(), fallback: {}, signal });
    if (!result) return null;
    const verdict = result.answers ? combineNotesWorth(result.answers, { backend: result.backend }) : null;
    this.record(result, scope, 'notes_worth', null, active(result) ? { worth: verdict } : { worth: null }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? verdict : null;
  }
  /** ask.necessity: may the model go on with a careful default instead of asking? True only when confident. */
  /** true: skip with a careful default; 'known': skip, the notes/lessons already answer it; false: ask. */
  async askNecessity(project, { sessionId, turnId, request = '', questions = [], present = true, known = [], detail = false, signal } = {}) {
    if (!this.enabled('ask.necessity') || !questions.length) return detail ? { verdict: false, ledgerId: null } : false;
    const state = buildDecisionState('ask.necessity', { request, questions, present, known, project: project ? { title: project.name, taskTypes: project.taskTypes ?? [] } : null }, { now: this.now() });
    const scope = { ...(project ? { projectId: project.id } : {}), sessionId, turnId };
    const result = await this.decide({ point: 'ask.necessity', state, signals: { consequence: .6 }, scope: { ...scope, revision: hash(['ask', questions.map(row => row.question), present]) }, assessmentPlan: askNecessityTemplate({ known: state.ask.known?.length ?? 0 }), fallback: {}, signal });
    if (!result) return detail ? { verdict: false, ledgerId: null } : false;
    const isKnown = result.answers ? combineAskKnown(result.answers, { backend: result.backend }) : false, skip = result.answers ? combineAskNecessity(result.answers, { backend: result.backend }) : false;
    this.record(result, scope, 'ask_necessity', null, { skip: active(result) && (skip || isKnown), ...(isKnown ? { known: true } : {}) }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    const verdict = active(result) ? (isKnown ? 'known' : skip) : false;
    return detail ? { verdict, ledgerId: active(result) ? result.ledgerId ?? null : null } : verdict;
  }
  /** input.interjection: should a message sent mid-response stop that response now? */
  async interjection(project, { sessionId, turnId, request = '', progress = '', message, signal } = {}) {
    if (!this.enabled('input.interjection') || typeof message !== 'string' || !message.trim()) return null;
    const state = buildDecisionState('input.interjection', { request, progress, message }, { now: this.now() });
    const scope = { ...(project ? { projectId: project.id } : {}), sessionId, turnId };
    const result = await this.decide({ point: 'input.interjection', state, signals: { consequence: .3 }, scope: { ...scope, revision: hash(['interjection', message, progress.length]) }, assessmentPlan: inputInterjectionTemplate(), fallback: {}, signal });
    if (!result) return null;
    const interrupt = result.answers ? combineInputInterjection(result.answers, { backend: result.backend }) : false;
    this.record(result, scope, 'input_interjection', null, { interrupt: active(result) && interrupt }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? { interrupt, ledgerId: result.ledgerId } : null;
  }
  /** tool.admission (shadow): which omitted chunks of an oversized tool result
   * the request needs. Recorded with each chunk's line range, so a later read
   * back of those lines labels the prediction. Never changes what the model sees. */
  async admission(project, { sessionId, turnId, request, name, preview, chunks = [], spillId, signal } = {}) {
    if (!this.enabled('tool.admission') || !chunks.length || typeof request !== 'string' || !request.trim()) return null;
    if (this.config().modes['tool.admission'] === 'shadow' && this.store.state.settings.realTokenBudget != null) return null;
    const state = buildDecisionState('tool.admission', { request, name, preview, chunks }, { now: this.now() });
    const scope = { ...(project ? { projectId: project.id } : {}), sessionId, turnId };
    const result = await this.decide({ point: 'tool.admission', state, signals: { consequence: .3 }, scope: { ...scope, revision: hash(['admission', spillId]) }, assessmentPlan: toolAdmissionTemplate({ chunks: chunks.length }), fallback: {}, signal });
    if (!result) return null;
    const omit = result.answers ? combineToolAdmission(result.answers, { backend: result.backend }) : [];
    this.record(result, { ...scope, spillId, ranges: chunks.slice(0, 12).map(row => row.range) }, 'tool_admission', null, { omit: active(result) ? omit : [], wouldOmit: omit }, { predictions: predictionsOf(result.answers), decided: Boolean(result.answers) });
    return active(result) ? omit : null;
  }
  /** message.value (narrator): atomic value probabilities for one candidate
   * proactive message. Returns null unless active; code decides the outcome. */
  async messageValue(project, { text, kind = 'share', threads = [], findings = [], openItems = [], lastUserAt, currentTopic, project: projectKind = null, signal } = {}) {
    if (!this.enabled('message.value') || typeof text !== 'string' || !text.trim()) return null;
    const state = buildDecisionState('message.value', { text, kind, threads, findings, openItems, lastUserAt, currentTopic, project: projectKind ?? { title: project.name, taskTypes: project.taskTypes ?? [] } }, { now: this.now() });
    const result = await this.decide({ point: 'message.value', state, signals: { consequence: .4 }, scope: { projectId: project.id, revision: hash(['value', text, threads.map(row => row.title), findings.length]) }, assessmentPlan: messageValueTemplate({ threads: state.threads.length }), fallback: {}, signal });
    if (!result) return null;
    const combined = result.answers ? combineMessageValue(result.answers, { backend: result.backend }) : { probabilities: {} };
    this.record(result, { projectId: project.id }, 'message_value', null, { alreadyReported: active(result) ? combined.alreadyReported ?? null : null }, { predictions: predictionsOf(result.answers), decided: active(result) && Object.keys(combined.probabilities ?? {}).length > 0 });
    return active(result) ? { ...combined, ledgerId: result.ledgerId } : null;
  }
  /** memory.filter: drop recalled passages confidently judged irrelevant. */
  async memoryFilter({ projectId, sessionId, turnId, prompt, entries = [], signal } = {}) {
    const count = Math.min(entries.length, 16);
    if (!this.enabled('memory.filter') || count < 2) return null;
    const state = buildDecisionState('memory.filter', { message: prompt, passages: entries.slice(0, count).map(entry => `${entry.title ?? ''} ${entry.summary ?? entry.content ?? ''}`) });
    const result = await this.decide({ point: 'memory.filter', state, signals: { consequence: .3 }, scope: { projectId, ...(sessionId ? { sessionId } : {}), revision: hash([turnId, entries.slice(0, count).map(entry => entry.uri)]) }, assessmentPlan: memoryFilterTemplate({ count }), fallback: {}, signal });
    if (!result) return null;
    const combined = result.answers ? combineMemoryFilter(result.answers, { count, backend: result.backend }) : null;
    this.record(result, { projectId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) }, 'memory_filter', null, { dropped: active(result) ? combined?.dropped ?? 0 : 0 }, { predictions: predictionsOf(result.answers), decided: Boolean(combined?.dropped) });
    if (!active(result) || !combined) return null;
    return { keep: [...combined.keep, ...Array.from({ length: entries.length - count }, (_, index) => count + index)], dropped: combined.dropped, ledgerId: result.ledgerId };
  }
  /** Backfills real outcomes into ledger rows (bounded, at most every 30 s). */
  backfill({ force = false } = {}) {
    if (!force && this.now() - this.lastBackfill < 30000) return 0;
    this.lastBackfill = this.now();
    this.absorbLedger();
    const updates = pendingObservations(this.store.state, this.ledgerStore.rows());
    let observed = 0;
    for (const update of updates) if (this.ledgerStore.observe(update.id, { ...update.observed, at: this.now() })) observed++;
    return observed;
  }
  /**
   * Whether a ledger row belongs to an archived project or conversation (one of an archived project counts as archived).
   * The calibration view filters by this alone: `exclude` is `include` minus these rows, `only` is these rows; rows with
   * neither a project nor a conversation, or of a project no longer in state, are never archived.
   */
  archivedRowTest() {
    const projects = new Set(this.store.state.projects.filter(row => row.archivedAt).map(row => row.id));
    const sessions = new Set(this.store.state.sessions.filter(row => row.archivedAt || projects.has(row.projectId)).map(row => row.id));
    return row => Boolean(row.scope?.projectId && projects.has(row.scope.projectId) || row.scope?.sessionId && sessions.has(row.scope.sessionId));
  }
  /**
   * Ledger rows of a calibration window, [since, until): '24h' rolls, '7d' and '30d' are whole local days ending today
   * (metric-windows.mjs), 'all' is the whole ledger (LEDGER_DAYS). Before 0.69 '7d' read a 200-row window (about two days).
   * Rows imported from an older release's 30-day index (`indexed`: an id, a point, a source and a project, nothing a
   * judgment was scored by) are not calibration rows: they are counted apart (`indexOnly`) instead of inflating
   * `decisions`, `unscoredReasons.unknown` and `modes.unknown` for the 31 days they stay.
   */
  calibrationRows(window, { archived = 'include' } = {}) {
    if (!Object.hasOwn(CALIBRATION_WINDOWS, window)) fail();
    const range = windowRange(window, { now: this.now() }), archivedRow = archived === 'include' ? null : this.archivedRowTest();
    const rows = this.ledgerStore.rows().filter(row => within(atOf(row.at), range) && (!archivedRow || (archived === 'only') === archivedRow(row)));
    return Object.assign(rows.filter(row => row.indexed !== true), { indexOnly: rows.filter(row => row.indexed === true) });
  }
  /** GET /api/v2/decision-kernel/calibration?point=&window=&archived= (archived: include by default — a judgment's accuracy does not depend on it). */
  calibration({ point, window = '7d', archived = 'include' } = {}) {
    if (point !== undefined && point !== '' && !points.includes(point)) fail();
    if (!Object.hasOwn(CALIBRATION_WINDOWS, window)) fail();
    if (!ARCHIVED_VIEWS.includes(archived)) throw Object.assign(new Error('archived must be exclude, include or only'), { status: 400, code: 'archived_invalid' });
    this.backfill();
    const rows = this.calibrationRows(window, { archived }), now = this.now();
    // The rows are already the window: the report's own rolling bound (now - span) reaches at least as far back.
    const indexOnly = name => rows.indexOnly.filter(row => !name || row.point === name).length;
    const report = name => ({ ...calibrationReport(rows, { point: name, window, now }), labels: labelSources(rows.filter(row => !name || row.point === name)), ...(indexOnly(name) ? { indexOnly: indexOnly(name) } : {}) });
    const resume = sessionResumeCheck(rows.filter(row => row.point === 'session.resume'));
    return { ...report(point || undefined), ...(archived !== 'include' ? { archived } : {}), ...(resume && (!point || point === 'session.resume') ? { verdicts: { 'session.resume': resume } } : {}),
      points: point ? undefined : Object.fromEntries(points.map(name => [name, report(name)]).filter(([, value]) => value.decisions)) };
  }
  calibrationSummary() {
    const rows = this.calibrationRows('7d'), now = this.now();
    return Object.fromEntries(points.map(point => { const report = calibrationReport(rows, { point, window: '7d', now }); return [point, { decisions: report.decisions, coverage: report.coverage, abstainRate: report.abstainRate, labeled: report.labeled, savings: report.savings }]; }).filter(([, row]) => row.decisions));
  }
  /**
   * Record the real outcome of a judgment (calibration). Labels are short identifiers, never free-form content; unknown
   * ids are not labeled (no row explains them). `source` (outcome | self | heuristic) defaults by the label table
   * (decision-ledger.mjs labelSourceOf): the main model's own next decision is `self`, a missing correction `heuristic`.
   * PDL-7 (B3): a `self` label is kept for reading but never enters calibration (no observation, Brier or bucket) or label
   * coverage, and never writes over a label that is not `self`; a later outcome label replaces it. `provisional: true` is
   * B3's name for a self label and means `source: 'self'`.
   */
  labelDecision(id, label, { source, provisional = false } = {}) {
    if (typeof id !== 'string' || !id || typeof label !== 'string' || !LABEL.test(label) || (source !== undefined && !LABEL_SOURCES.includes(source))) fail();
    const from = provisional === true ? 'self' : source;
    if (!this.ledgerStore.has(id)) this.absorbLedger();
    return this.ledgerStore.label(id, label, { at: this.now(), ...(from ? { source: from } : {}) });
  }
  async close() { this.closed = true; this.instance?.close(); this.deferrals.clear(); await this.drain(); }
}
