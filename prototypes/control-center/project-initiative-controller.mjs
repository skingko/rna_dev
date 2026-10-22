import { documentTools } from './document-text.mjs';
import { sourceScope, withdrawSources } from './source-revocation.mjs';
import { privateStatePaths } from './state-privacy.mjs';
import { realBudgetRemaining, reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';
import { learningTokenUsage, remainingInitiativeTokenBudget } from './project-learning-budget.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { InitiativeCoordinator, DEFAULT_MAX_STEPS } from '../../packages/sdk/src/index.mjs';
import { initiativeFailure, cacheAlignedReviewDue, receiptEligible, RECENT_RECEIPTS, blockWindow } from '../../packages/sdk/src/initiative.mjs';
import { selectLearningToolReceipts, summarizeLearningToolFailure } from './project-learning-evidence.mjs';
import { summarizeLearningEvaluationExposure } from '../../packages/sdk/src/learning-context.mjs';
import { recallProjectMemory, memoryFilterHook, MEMORY_TOOL_DECLARATIONS } from './memory-context.mjs';
import { declarationOf } from '../../packages/sdk/src/prompt-layers.mjs';
import { purposeProvider, cacheTtlMs, PRE_RESPONSE_EVENTS, UNBILLED_FAILURES, unreportedOutput } from './usage-cache-service.mjs';
import { streamCompletion } from '../../packages/sdk/src/providers.mjs';
import { createRnaRuntime, runSurface } from './rna-runtime.mjs';
import { CapabilityService, projectWorkspace } from './capability-service.mjs';
import { resolveModel } from './configuration.mjs';
import { ProjectEvolutionService } from './project-evolution-service.mjs';
import { getProjectEvolutionIdentity, getEvolutionEvidenceCoverage } from './project-evolution-identity.mjs';
import { SkillMarketplaceService } from './skill-marketplace-service.mjs';
import { createGenomeTools } from '../../packages/sdk/src/project-genome.mjs';
import { genomeIdentity } from './project-genome-store.mjs';
import { estimateProjectEvolutionBudget } from '../../packages/sdk/src/project-evolution.mjs';
import { permissionView, permissionLevel, toolPermitted } from './project-permissions.mjs';
import { PROJECT_SCHEDULE_DEFAULTS, autonomousLearningNotBefore } from './project-proactivity.mjs';
import { projectScheduleDue, projectScheduleView, projectScheduleClaimCurrent, projectSchedulePeriodMs, projectScheduleWindowOpen, projectScheduleWindowPassed } from '../../packages/sdk/src/project-schedules.mjs';
import { OCCURRENCE_SETTLED, OCCURRENCE_LIVE, MUTED_SKIP, WINDOW_PASSED, SCHEDULE_MUTE_POLICY, skipOccurrence, expiredDeliveryText } from './project-schedule-service.mjs';
import { projectRhythmStatus, projectRhythmEvidenceKey, acceptProjectRhythmDecision } from './project-rhythm.mjs';
import { prepareJudgmentPolicy, validJudgmentPolicy } from './judgment-policy-service.mjs';
import { projectInitiativeAvailability } from './project-initiative-availability.mjs';
import { scheduleContractText, schedulePromptVersionOfStore } from './schedule-prompt.mjs';
import { backgroundActionView, controlBackgroundAction, backgroundControlTools, jobStepKinds } from './project-background-controls.mjs';
import { extractHandoff, stripHandoff, oneLine, quietReach, reachRank, REACH_TIERS } from '../../packages/sdk/src/proactive-message.mjs';
import { capReach, sentDigest, recentDeliveries, messageViolations, checkedMessageViolations, messageRecheck, projectKindOf, recordDelivery, trimInbox, settleDeliveryFeedback, attributeReplies, digestDue, composeDigest, digestLines } from './proactive-delivery.mjs';
import { liveBus, toolKind, toolTarget, stepKind } from './live-bus.mjs';
import { narrate, applyNarration, narratedView, pacingRecord, NARRATOR_VERSION, welcomeBackDue, composeWelcomeBack, applyWelcomeBack, resolveThreads, applyResolution, threadReactions, applyReactions, ensureMind, WRITING_CONTRACT, revisionPrompt, REVISION_TEXT_LIMIT, SCHEDULED_DELIVERY_INSTRUCTION } from './proactive-narrator.mjs';
import { pacingSignals, pacingThreshold, wakeFloor, advanceWake, rearmWake, cacheWakeAllowed, declineOverdue, heldAsks, heldAskDue, applyWorkOutcome, wakeTier, proactiveRowKind } from './proactive-pacing.mjs';
import { WakeLog, wakeLogFile, WAKE_STATE_TAIL } from './wake-log.mjs';
import { WorkOutcomeLog, outcomeLogFile, outcomeLabels } from './work-outcome.mjs';
import { realpathSync, statSync } from 'node:fs';
import { sep, relative as relativePath } from 'node:path';
import { mindBackgroundView, workChangeOutcome, standingLessons } from './project-mind.mjs';
import { DirectFixRecorder, DIRECT_FIX_TOOLS, saveDirectFix, revertDirectFix, discardDirectFix, readDirectFix } from './direct-fix-store.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { directFixTask, directFixDetail, directFixCard } from './direct-fix-text.mjs';
import { reasoningFor, decisionEffortInput, workEffortInput, narratorEffortInput, EffortCapture, resumedReasoning, sessionsLive } from './internal-reasoning.mjs';
import { TurnWatcher, forgetHook } from './turn-watch.mjs';
import { actionLabel, taskLine, withoutHandles } from './task-text.mjs';
import { WORKER_COPY_NOTE, HOST_HANDOFF, deadlineText, excerptHandoff, runOutcomeText, unreportedText, workerSystemPrompt } from './work-run-text.mjs';
import { BackgroundWorktrees } from './background-worktree.mjs';
import { worktreeChanges, ranUnhookedTool, guardContinued, guardOpenText, GUARD_SOURCE } from './run-changes.mjs';
import { HOST_CARDS, LIMITS, MODEL_TEXT } from './git-isolation/index.mjs';
import { deriveWorkspaceEvents, snapshotWorkspaceEvents, turnReversion, actionReversion, SNAPSHOT_HORIZON_MS } from './workspace-events.mjs';
import { initiativePrivacyInputs, workspaceHistory, workspaceEra } from './initiative-privacy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
/** A git background change set's apply records (`applyIds`; rows older than the list name only `applyId`). */
const gitChangeApplyIds = change => [...new Set([...(Array.isArray(change?.applyIds) ? change.applyIds : []), ...(change?.applyId ? [change.applyId] : [])].filter(id => typeof id === 'string' && id))];
const bounded = (value, size = 1800) => String(value ?? '').slice(0, size);
// Preserve task introductions and final constraints/conclusions. An excerpt
// is not a model-authored summary or proof that the claimed result was verified.
export const EXCERPT_MARKER = '\n[… middle omitted; project_history can read the original …]\n';
const excerpt = (value, size = 1800) => { const text = String(value ?? ''); if (text.length <= size) return text; const marker = EXCERPT_MARKER, first = Math.floor((size - marker.length) * .6); return text.slice(0, first) + marker + text.slice(-(size - marker.length - first)); };
/** The SDK's limit on a host action's content (enqueueHostAction). */
const HOST_ACTION_CONTENT_LIMIT = 16000;
const visibleItem = item => !item.streaming && !item.sourceDeleted && !item.contextRevoked && item.simulated !== true;
const terminalTurns = session => session.turns.filter(turn => ['completed', 'failed'].includes(turn.status) && turn.modelConfig?.execution === 'rna' && turn.simulated !== true).slice(-8);
const terminalBaseId = turn => `turn:${turn.id}:${turn.status}`;
/** A foreground request that failed and is still the conversation's last request waits for the user's retry, on the
 * model the user chose; the conversation offers that retry. It is not open work for the background, which would
 * answer it with its own model beside the retry (live, 2026-10-03). A later user message means the user moved on. */
export function awaitingUserRetry(session) {
  const turn = session.turns?.at(-1);
  if (turn?.status !== 'failed') return null;
  return session.items.some(item => item.kind === 'user' && item.turnId !== turn.id && String(item.createdAt) > String(turn.createdAt)) ? null : turn;
}
const retryOwned = sessions => new Set(sessions.map(awaitingUserRetry).filter(Boolean).map(turn => turn.id));
const RETRY_OWNED = 'This request failed and waits for the user to retry it in its conversation, on the model they chose. It is the user\'s, not background work: do not answer, redo or restate it from the background; a message citing it is not delivered.';
/** Whether a message cites a request awaiting the user's retry (its failure or its question). */
const citesRetryOwned = (sessions, evidenceIds = []) => {
  const pending = retryOwned(sessions);
  if (!pending.size) return false;
  const questions = new Set(sessions.flatMap(session => session.items.filter(item => item.kind === 'user' && pending.has(item.turnId)).map(item => `message:${item.id}`)));
  return evidenceIds.some(id => questions.has(id) || pending.has(/^turn:([^:]+):/.exec(String(id))?.[1]));
};
// A retry retains its turn ID. Identify the actual terminal occurrence, not
// changing streamed content, so one receipt is stable and a later failure wakes.
const terminalOccurrence = turn => hash([Number.isFinite(Date.parse(turn.completedAt)) ? Date.parse(turn.completedAt) : turn.createdAt ?? null, Number.isSafeInteger(turn.runtimeAttempts) ? turn.runtimeAttempts : 0]).slice(0, 20);
const terminalSourceId = (project, turn) => {
  const base = terminalBaseId(turn), occurrence = terminalOccurrence(turn);
  // Keep the existing three-segment turn identity used by deletion scrubbing.
  return project.initiativeRuntime?.terminalSourceIdentity?.legacy?.some(alias => alias.id === base && alias.occurrence === occurrence) ? base : `${base}@${occurrence}`;
};
// Provider prefix caches match from the start of the request. Keep what is
// stable between background wakes (identity, contracts, conversation) first and
// move clock-relative fields to the end, ordered from rarely to often changing.
// Least to most often changed; everything else in the snapshot is a stable prefix. The conversation and its
// continuity change with every user turn, so they follow the project description, version and policies. The user's
// undos (workspaceEvents) change only when the user undoes something, so they come before the conversation.
const VOLATILE_SNAPSHOT_KEYS = ['learningStatus', 'pendingJobs', 'schedules', 'scheduleContext', 'workspaceEvents', 'recentConversation', 'continuity', 'handoffs', 'mind', 'communication', 'rhythmStatus', 'clock'];
/**
 * Views of the decision snapshot that only the clock moves: the rolling 24-hour digest of what was sent (a message leaves the
 * window, a reaction settles from pending to ignored with time) and the rolling review quota of the evolution lane. They are
 * left out when a floor wake asks whether the situation is the one its last wait was made in (SDK MAX_REST_MS); every other
 * part of the request, the conversation, the receipts and the evidence included, still counts.
 */
export const REST_IGNORE = Object.freeze(['communication.sentLast24h', 'rhythmStatus.evolution.quota']);
/** A valid judgment plan is offered back to the main model for revision this often; between revisits a wake carries no plan authoring. */
export const JUDGMENT_PLAN_REVISIT_MS = 7 * 86400000;
function cacheOrdered(snapshot) {
  const ordered = {};
  for (const [key, value] of Object.entries(snapshot)) if (!VOLATILE_SNAPSHOT_KEYS.includes(key)) ordered[key] = value;
  for (const key of VOLATILE_SNAPSHOT_KEYS) if (Object.hasOwn(snapshot, key)) ordered[key] = snapshot[key];
  return ordered;
}
// Committed sessions are frozen: an untouched session reuses its turn contexts across pumps.
const turnContexts = new WeakMap();
function cachedTurnContext(session, turn) {
  if (!Object.isFrozen(session)) return turnContext(session, turn);
  let byTurn = turnContexts.get(session); if (!byTurn) { byTurn = new Map(); turnContexts.set(session, byTurn); }
  let context = byTurn.get(turn); if (!context) { context = turnContext(session, turn); byTurn.set(turn, context); }
  return context;
}
const FINAL_WITH_RECEIPTS = 'assistant reply (its own account); the tools of this turn are host receipts of what actually ran', FINAL_WITHOUT_RECEIPTS = 'assistant reply (its own account); no successful host tool receipt in this turn';
function turnContext(session, turn) {
  const items = session.items.filter(item => item.turnId === turn.id && visibleItem(item));
  const requests = items.filter(item => item.kind === 'user'), answer = items.findLast(item => item.kind === 'assistant');
  const selectedRequests = [...new Set([...requests.slice(0, 1), ...requests.slice(-2)])];
  const tools = items.filter(item => item.tool), failed = tools.filter(item => ['failed', 'error', 'needs_review'].includes(item.tool.status));
  const selected = new Set([...failed.slice(-3), ...tools.slice(-2)]);
  // The reply is the assistant's own account; what actually ran is in the host's tool receipts. This used to be stamped
  // `verifiedByHost: false`, which the background read as "the host marked it unverified" and re-verified turns whose
  // receipts already showed the checks passing (live 2026-10-04). Same information, worded so it points at the receipts.
  const succeeded = tools.some(item => item.tool.status === 'succeeded');
  return { sessionId: session.id, turnId: turn.id, status: turn.status, at: turn.completedAt ?? turn.createdAt,
    requests: selectedRequests.map(item => ({ messageId: item.id, text: excerpt(item.text, 1000) })),
    final: answer ? { messageId: answer.id, text: excerpt(answer.text, 2000), basis: succeeded ? FINAL_WITH_RECEIPTS : FINAL_WITHOUT_RECEIPTS } : null,
    tools: tools.filter(item => selected.has(item)).map(item => ({ itemId: item.id, name: item.tool.name, status: item.tool.status, output: excerpt(item.tool.output, 600) })),
    omitted: { messages: requests.length - selectedRequests.length, toolResults: tools.length - selected.size }, detailsTool: 'project_history' };
}
/**
 * Block windows (Headlong `context --tail-block`, design/wake_prompt_delivery.md): the coordinator's evidence events
 * (policy.eventBlock) and the decision's action-receipt windows (continuity.actionReceipts, handoffs) move their start
 * every WINDOW_BLOCK rows, so between moves a new row only appends: the request keeps its bytes up to it, and every event
 * handle (E1…), with the turn references and citations that use them, stays put. Each window holds its count up to
 * WINDOW_BLOCK - 1 more rows; the cap stays a row count, never bytes.
 * Why 4 (live 2026-10-02..04, benchmark/initiative-request-size.mjs): a paid decision wake brought 0.49-0.7 evidence
 * events, a fifth to a third of them with nothing else changed (file, project and schedule state), and a moved event
 * window rewrote the 65-101 KB after the first turn reference on such a wake; an event row averages 1.3 KB. Per wake, the
 * expected uncached bytes from the event window (those rewrites over B, plus (B - 1) / 2 extra rows) are 22.6 KB on the
 * novel and 6.4 KB on the research project with a plain tail, 7.7 and 3.6 KB at 4, within 7% of each project's minimum
 * (5-6 and 3). Receipts (0.2-0.3 new actions per wake) take the same step.
 * Not blocked, measured: recentActions (the SDK's RECENT_RECEIPTS tail), the turn and message windows. A new action
 * always shows first in continuity.actionReceipts, which comes before recentActions; a new turn or message always appends
 * to its own window, which a later part of the request follows. A block there never lengthens a cached prefix and only
 * adds rows (an older turn the events no longer carry is sent whole: +6.2 KB on the research project). Worker briefs keep
 * plain windows too: a run's attachment follows its own task, so no cached prefix spans two runs there.
 */
export const WINDOW_BLOCK = 4;
/** The actions the host lists in continuity.actionReceipts: the last eight not revoked or deleted (`block`: WINDOW_BLOCK). */
const receiptActions = (project, block = 1) => blockWindow((project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => !action.contextRevoked && !action.sourceDeleted), 8, block);
/** Statuses whose SDK recentActions receipt shows the failure itself (initiative.mjs tick). */
const SDK_FAILURE_STATUSES = new Set(['failed', 'needs_review']);
/**
 * How much of an action's content, and of its result when it has no handoff, the SDK recentActions receipt shows (the
 * first 2,000 characters, initiative.mjs tick). Longer text keeps the host excerpt, whose end the SDK receipt lacks.
 */
const SDK_RECEIPT_TEXT = 2000;
const sdkShowsResult = action => !action.handoff && String(action.resultSummary ?? '').length <= SDK_RECEIPT_TEXT;
/**
 * T3 (token burn, design P2): what a scheduled run's first request says twice, said once. The run's own message is the
 * occurrence content scheduledWork composes (`Scheduled occurrence <key>\nDue: …\nTime rule: …\n\n<task>\n\nProduce the
 * requested deliverable …`). The same words come back in the planning state (the schedule's `task`), in the run's own
 * receipt and pending job, and in the receipts of earlier runs of the same schedule (an excerpt of their own message).
 * Only text the request keeps word for word elsewhere is dropped (Headlong wake_prompt_cull.md rule 5: a deduplicated
 * row loses only what another row still says); everything else in those rows stays, the earlier runs' handoffs too.
 * Every row whose shown words are not all found in the run's message (a task edited since, a message that is not an
 * occurrence message) stays exactly as it was. An earlier run's receipt shows only the beginning and the end of its message
 * (the middle is cut), so those two ends are what is compared; its replacement says that (EARLIER_TASK_PLACEHOLDER).
 */
const OCCURRENCE_HEADER = /^Scheduled occurrence [^\n]*\nDue: [^\n]*\nTime rule: [^\n]*\n\n/, OCCURRENCE_TAIL = '\n\nProduce the requested deliverable using current evidence and authorized tools.';
export function scheduledOccurrence(content) {
  const text = typeof content === 'string' ? content : '', header = OCCURRENCE_HEADER.exec(text)?.[0], tailAt = text.lastIndexOf(OCCURRENCE_TAIL);
  if (!header || tailAt < header.length) return null;
  const task = text.slice(header.length, tailAt);
  return task ? { content: text, header, task, tail: text.slice(tailAt) } : null;
}
/** The run's identity for the dedupe: its action id and its occurrence message; null for any run that is not a scheduled occurrence. */
export const scheduledRunOwn = action => { const occurrence = action?.hostSchedule ? scheduledOccurrence(action.content) : null; return occurrence ? { actionId: action.id, scheduleId: action.hostSchedule.scheduleId, occurrence } : null; };
/**
 * An earlier occurrence's receipt says this in place of its task excerpt (the receipt keeps the occurrence line and its
 * handoff). It states what the excerpt showed and no more: the excerpt held the task's beginning and the message's closing
 * text around EXCERPT_MARKER, and that marker told the model the middle was never shown. Those two ends are found word for
 * word in this request; the middle is not compared (the receipt has not got it), so the text must not read as "the same
 * task" and keeps the marker's pointer to project_history.
 */
export const EARLIER_TASK_PLACEHOLDER = '(task text left out: only its beginning and its closing text were shown here, both word for word as in this request; its middle was not shown, project_history can read the original)';
/**
 * The intent excerpt of an earlier scheduled run with its task text replaced when this request carries what the excerpt
 * showed: the excerpt is the run's message cut to 800 characters, its start and its end around EXCERPT_MARKER (a message
 * that short has no task worth a placeholder and is left as it is); the start must be a prefix of this run's task and the
 * end the end of this run's message (which includes the host's own closing text, the same every day). The task may well
 * have differed in the middle: the excerpt never showed it, and the placeholder says so. The occurrence line (its key, due
 * time and rule) stays: no other part of the request has it.
 */
function earlierIntent(intent, { occurrence }) {
  const header = OCCURRENCE_HEADER.exec(intent)?.[0];
  if (!header) return intent;
  const rest = intent.slice(header.length), cut = rest.indexOf(EXCERPT_MARKER), end = rest.slice(cut + EXCERPT_MARKER.length);
  return cut > 0 && end && occurrence.task.startsWith(rest.slice(0, cut)) && occurrence.content.endsWith(end) ? header + EARLIER_TASK_PLACEHOLDER : intent;
}
/**
 * The run's own receipt, when it holds nothing but the run's own message again: the stored message is the occurrence
 * message, its evidence ids are named in it, and it has no handoff, result, failure, tool receipts, user revert or
 * blocking flag yet (a run still at its first request). Anything else about the run stays in the brief.
 */
const ownReceipt = (action, own, { reverted, execution, failure }) => Boolean(own) && action.id === own.actionId && action.content === own.occurrence.content && !action.handoff && !action.resultSummary && !action.blocksExecution
  && !reverted && !execution && !failure && (action.evidenceIds ?? []).every(id => own.occurrence.content.includes(id));
/**
 * Host receipts of recent actions. `sent` (TC-3): ids of actions the decision request already carries as SDK
 * recentActions (intent, status, evidence, handoff or result, failure); those get only what the host adds (tool receipt
 * counts, a user's revert, when they ended, and a failure the SDK receipt does not show: the one an explicitly resolved
 * action keeps), so each action appears once in a decision request.
 */
function actionReceipts(project, redactValues = [], workspaceEvents = [], { sent = null, block = 1, own = null } = {}) {
  // `own` (a scheduled worker, T3): the window is cut first and the run's own receipt taken out of it, so no older action moves up into its place.
  return receiptActions(project, block).map(action => {
    // The user reverted what this run changed: its handoff still says the files were changed (snapshot.workspaceEvents).
    const reverted = actionReversion(workspaceEvents, action.id);
    const job = project.jobs?.find(job => job.id === action.id && !job.contextRevoked && !job.sourceDeleted);
    const execution = job?.toolReceiptCounts ? { ...job.toolReceiptCounts, retained: job.toolReceipts?.length ?? 0, detailsTool: 'project_history', meaning: 'Actual tool receipts, not proof that the overall task or its final validation completed.' } : null;
    const failure = action.failure || action.errorCode ? (row => ({ code: row.code, message: row.message }))(initiativeFailure({ code: action.failure?.code ?? action.errorCode, message: action.failure?.message ?? action.error }, { redactValues })) : null;
    // When it ended: the slim receipt's own time, and on a whole receipt with a handoff the time the `handoffs` list gave.
    const endedAt = Number.isFinite(action.finishedAt) ? new Date(action.finishedAt).toISOString() : null;
    if (ownReceipt(action, own, { reverted, execution, failure })) return null;
    if (sent?.has(action.id)) return { actionId: action.id, ...(String(action.content ?? '').length > SDK_RECEIPT_TEXT ? { intent: excerpt(action.content, 800) } : {}), ...(!action.handoff && !sdkShowsResult(action) ? { result: excerpt(action.resultSummary, 1800) } : {}), ...(execution ? { execution } : {}), ...(reverted ? { changesReverted: reverted } : {}), ...(failure && !SDK_FAILURE_STATUSES.has(action.status) ? { failure } : {}), endedAt };
    // A run's one-line handoff replaces its transcript excerpt; project_history reads the original.
    const intent = excerpt(action.content, 800), receipt = { actionId: action.id, action: action.action, status: action.status, evidenceIds: action.evidenceIds, intent: own && action.hostSchedule ? earlierIntent(intent, own) : intent, ...(action.handoff ? { handoff: action.handoff } : { result: excerpt(action.resultSummary, 1800) }), blocksExecution: action.blocksExecution === true, detailsTool: 'project_history' };
    if (reverted) receipt.changesReverted = reverted;
    if (execution) receipt.execution = execution;
    if (failure) receipt.failure = failure;
    if (action.handoff && endedAt) receipt.endedAt = endedAt;
    return receipt;
  }).filter(Boolean);
}
/** Recent background runs that left a handoff (done, left, where, next step), newest last. */
const handoffActions = (project, block = 1) => blockWindow((project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => action.handoff && ['work', 'learn'].includes(action.action) && !action.contextRevoked && !action.sourceDeleted), 6, block);
const handoffLine = action => ({ at: action.finishedAt ? new Date(action.finishedAt).toISOString() : null, action: action.action, status: action.status, handoff: action.handoff });
function handoffLines(project) { return handoffActions(project).map(handoffLine); }
/**
 * The recent handoffs a request carries nowhere else (TC-3): those of runs past both receipt lists (the host's
 * actionReceipts and, given `sent`, the SDK's recentActions), e.g. a stopped run followed by many other actions; every
 * handoff the `handoffs` list used to repeat still reaches the reader, once. A run past the host receipts whose handoff
 * only its SDK receipt carries keeps here what that receipt lacks, when it ended: `{ actionId, at }` (Headlong
 * wake_prompt_cull.md rule 5: a deduplicated row drops only what another row still says). Without it, a run some eight
 * actions back whose completion event had left the window had no time anywhere in the request, so the model could not
 * place its check before or after later changes.
 */
function uncarriedHandoffs(project, { sent = null, block = 1 } = {}) {
  const receipted = new Set(receiptActions(project, block).map(action => action.id));
  return handoffActions(project, block).filter(action => !receipted.has(action.id)).flatMap(action => !sent?.has(action.id) ? [handoffLine(action)] : Number.isFinite(action.finishedAt) ? [{ actionId: action.id, at: new Date(action.finishedAt).toISOString() }] : []);
}
/** The actions the SDK sends a decision as recentActions (the same predicate and bound as its tick). */
const sentReceiptIds = actions => new Set((actions ?? []).filter(receiptEligible).slice(-RECENT_RECEIPTS).map(action => action.id));
const wholeJson = text => { try { JSON.parse(text); return true; } catch { return false; } };
/**
 * The ids of evidence events that can stand in for what they hold (TC-3): every event but a conversation_result whose
 * summary was cut at its bound (sources(): 10,000 characters). That turn is then sent whole, as before.
 */
export const carriedEventIds = events => new Set((events ?? []).filter(event => event?.type !== 'conversation_result' || wholeJson(event.summary)).map(event => event?.id).filter(Boolean));
/** The project as every purpose names it: identity, goal and what the user fixed. */
function projectIdentity(project) {
  return { id: project.id, title: project.name, description: bounded(project.description, 2000), overview: bounded(project.overview, 2000), focus: bounded(project.focus, 1000), constraints: (project.commitments ?? []).slice(-6).map(item => bounded(item.text, 300)), openQuestions: (project.openQuestions ?? []).slice(0, 6), milestones: (project.milestones ?? []).slice(0, 6).map(item => ({ title: item.title, status: item.status })) };
}
/**
 * What background work may do now, for decisions and workers alike: the saved grant, narrowed to read by plan mode or
 * by a running foreground turn (except a run in its own worktree, `isolatedWork`, design §8). `effective` is the
 * permission in force.
 */
function workAccess(project, sessions, { isolatedWork = false } = {}) {
  const access = permissionView(project), planning = sessions.some(session => session.mode === 'plan'), foregroundBusy = sessions.some(session => session.activeTurnId && (!session.turns.find(turn => turn.id === session.activeTurnId) || session.turns.find(turn => turn.id === session.activeTurnId).status === 'running')), backgroundLevel = planning || (foregroundBusy && !isolatedWork) ? 'read' : access.effective.background;
  return { access, planning, foregroundBusy, isolatedWork, backgroundLevel, effective: { ...access.effective, background: backgroundLevel } };
}
/**
 * The work contract. Its per-wake parts (planning, foregroundBusy, effects, backgroundLevel, permissions.effective) are
 * sent at the request tail as hostConditions (PDL-5), so a plan-mode toggle or a running turn leaves the head as it was.
 * Its authorization and scope name where the level in force is (`levelAt`) and give both variants (PDL-5 phase 2: live
 * 2026-10-02..04, 11 of 47 consecutive decisions first differed at hostActionContracts.work), so they do not change with it.
 */
const DECISION_LEVEL_AT = 'hostConditions.work.backgroundLevel';
function workContract({ enabled, access, planning, foregroundBusy, isolatedWork, backgroundLevel, effective }, { levelAt = DECISION_LEVEL_AT, inCopy = false } = {}) {
  const work = { enabled, authorization: `Already authorized within the project background permission in force (${levelAt}) and assigned capabilities; no new user command or Goal is required.`, scope: `When ${levelAt} is read: inspect existing project files and memory with assigned read tools, check concrete evidence and report findings. When it is write or execute: make bounded progress on the current project using the saved permissions and assigned tools, inspect results and report actual evidence. If the work shows the user's chosen approach is clearly suboptimal, do not switch silently: finish within the user's plan and record the better alternative for an ask.`, effects: backgroundLevel === 'read' ? 'Read-only investigation. No workspace edits or command execution. Request project permission with a structured permission question if work requires a wider scope.' : `Workspace file changes ${backgroundLevel === 'execute' ? 'and command execution' : 'without command execution'} are permitted by saved settings. No new capability grants or external publication is implied. Respect explicit user constraints.`, permissions: { ...access, effective }, backgroundLevel };
  if (planning) Object.assign(work, { planning: true, effects: 'A non-archived project conversation is in plan mode. Background work is temporarily read-only; saved grants remain unchanged. Do not request broader permissions to bypass planning. Leave plan mode before workspace writes or command execution.' });
  // Design §8: a run in its own worktree is not made read only by a foreground turn; its writes are applied after it.
  if (foregroundBusy && isolatedWork && !planning) Object.assign(work, { foregroundBusy: true, effects: MODEL_TEXT.backgroundIsolatedForeground });
  else if (foregroundBusy) Object.assign(work, { foregroundBusy: true, effects: 'A foreground turn currently owns workspace mutations. Background work may inspect existing evidence and prepare a finding, but must not edit files, run commands or duplicate the foreground task. Saved grants are unchanged; workspace mutation becomes available after the foreground finishes.' });
  // A worker's brief says its run is in its own copy of the project folder (a decision's request does not: its head stays as it was).
  // `inCopy` is the run's own fact (it was given a worktree), not the project's cached isolation answer: a run resumed in the
  // project folder, or a read-only one (saved level, plan mode), is not in a copy and would be told something false.
  if (inCopy && backgroundLevel !== 'read') work.workspace = WORKER_COPY_NOTE;
  work.continuation = 'Use the prior work handoff and actual tool receipts. A completed check of an unchanged artifact is not a new reason to repeat that same check: identify a concrete changed artifact, untested case or independent verification gap before doing more work. When a useful finding is ready, consider communicating it; wait is valid when no unresolved useful step remains. Do not treat a worker summary or a successful tool exit as proof of overall quality.';
  return work;
}
/** Where a worker reads the level in force: its project-evidence context (workerBrief volatile). */
const WORKER_LEVEL_AT = 'project-evidence project.work.backgroundLevel';
const CAPABILITY_LEVEL_NOTE = 'permittedForBackground is under the saved project permission. While hostConditions.work.backgroundLevel is read (plan mode or a running foreground turn), background work may use only tools whose permission is read.';
/**
 * The decision snapshot's mind (recalled for the project's name and focus) went to background workers as part of their
 * attachment until TC-2; the run's own project-mind attachment recalls for its task. What the first holds that the second
 * lacks is candidate lessons (live 2026-10-04: 3 of the last 20 works): those stay, without what the attachment repeats
 * (commitments, agenda, its lessons, the instruction). With no attachment (`attached` false) the whole view, as before.
 */
function workerMindLessons(project, { now, query, attached }) {
  const named = mindBackgroundView(project, { now });
  if (!named || !attached) return named;
  const own = new Set((mindBackgroundView(project, { now, query })?.lessons ?? []).map(row => row.id)), lessons = named.lessons.filter(row => !own.has(row.id));
  return lessons.length ? { lessons } : null;
}
/** The last messages of the project's conversations (requests and replies), oldest first; `turnId` is for withoutHeld. */
function recentMessages(sessions, pendingRetry) {
  return sessions.flatMap(session => session.items.filter(item => ['user', 'assistant'].includes(item.kind) && !item.sourceDeleted && !item.contextRevoked && !item.streaming && item.source !== 'initiative' && !pendingRetry.has(item.turnId) && (item.kind === 'user' || item.simulated !== true && (!item.turnId || session.turns.find(turn => turn.id === item.turnId)?.modelConfig?.execution === 'rna'))).slice(-4).map(item => ({ sessionId: session.id, id: item.id, role: item.kind, text: excerpt(item.text, 1000), at: item.createdAt, turnId: item.turnId }))).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-6);
}
/**
 * The messages turn contexts hold, by turn (turnContext: a turn's first and last two requests and its final reply). A
 * turn's other messages (a progress note between tool calls, a request between the first and the last two) are not in it.
 */
const heldMessages = rows => new Map(rows.map(({ session, turn }) => { const held = cachedTurnContext(session, turn); return [turn.id, new Set([...held.requests.map(row => row.messageId), ...(held.final ? [held.final.messageId] : [])])]; }));
/**
 * recentMessages without what `held` turn contexts already carry (TC-3), and without the empty messages of those turns
 * (nothing to carry). Dropped, not replaced: older messages do not move up into the window.
 */
const withoutHeld = (rows, held) => rows.filter(row => !(held?.get(row.turnId)?.has(row.id) || held?.has(row.turnId) && !row.text.trim())).map(({ turnId: _turn, ...row }) => row);
/** The conversation's real turns, oldest first, without a request awaiting the user's retry. */
function trajectoryOf(sessions, pendingRetry) {
  return sessions.flatMap(session => session.turns.filter(turn => turn.modelConfig?.execution === 'rna' && turn.simulated !== true && !pendingRetry.has(turn.id)).map(turn => ({ session, turn }))).sort((a, b) => String(a.turn.completedAt ?? a.turn.createdAt).localeCompare(String(b.turn.completedAt ?? b.turn.createdAt)));
}
/**
 * The conversation and work so far (recent and unfinished turns, a retry the user owns, action receipts). TC-3: a turn
 * whose result is one of `eventIds` (an evidence event the request carries whole) is only referenced, `{ evidence: id }`
 * (the SDK shows it as its E-handle), and the receipts of actions in `sent` are slim.
 */
export function continuityView(project, sessions, { reversions = [], trajectory, pendingRetry, eventIds = null, sent = null, redactValues = [], block = 1, own = null } = {}) {
  const referenced = turn => eventIds && ['completed', 'failed'].includes(turn.status) ? (id => eventIds.has(id) ? id : null)(terminalSourceId(project, turn)) : null;
  return { recentTurns: trajectory.slice(-4).map(({ session, turn }) => { const undone = turnReversion(reversions, session.id, turn.id), evidence = referenced(turn); if (evidence) return { evidence, ...(undone ? { undone } : {}) }; const context = turnContext(session, turn); return undone ? { ...context, undone } : context; }), unfinishedTurns: trajectory.filter(({ turn }) => ['running', 'paused', 'failed', 'stopped'].includes(turn.status)).slice(-8).map(({ session, turn }) => { const { sessionId, turnId, status, requests } = turnContext(session, turn); return { sessionId, turnId, status, requests }; }),
    ...(pendingRetry.size ? { awaitingUserRetry: { sessionIds: sessions.filter(session => pendingRetry.has(awaitingUserRetry(session)?.id)).map(session => session.id), meaning: RETRY_OWNED } } : {}),
    actionReceipts: actionReceipts(project, redactValues, reversions, { sent, block, own }), history: { tool: 'project_history', scope: HISTORY_SCOPE } };
}
/**
 * What continuity's IDs are. Since TC-3 a recentTurns row can be `{ evidence: id }`: that turn, carried whole as the
 * evidence event with that id (in a decision its handle, one of allowedEvidenceIds). The scope used to say only that IDs
 * here are not allowed evidence, which every such row contradicted; it now names that row as the exception.
 */
const HISTORY_SCOPE = 'Current project, non-archived conversations and retained non-revoked action receipts only. A recentTurns row { evidence: id } is that whole turn: the evidence event with that same id carries it, and that id is an evidence ID. Other IDs here identify context, not allowed evidence. Read original details when excerpts are insufficient; do not repeat an investigation merely to recreate its history.';
/**
 * What one review counts as on the Headlong wake ladder, or null when it records nothing. One record per wake: a
 * JEV-deferred floor wake used to be recorded twice ('deferred', then a 0-token 'thought'), moving the backoff ladder and
 * quietWakes two steps. Only a VISIBLE outcome resets the ladder (C2, option C): a decision the host did not admit (an
 * exact duplicate, or work the receipts already cover) started nothing, so it is a thought and repeated rumination
 * backs off; an admitted one ('work') is pending until its action's outcome says what happened (outcomeUpkeep).
 * PDL-4: a wake that reached no decision (the coordinator idled, was busy or blocked) is a no-op, floor or not (Headlong
 * monolith_backoff.md:173, 261-265: a no-op wake leaves the level and the timer as they are). An idle floor tick used to
 * count as a thought, so a long background run alone moved the ladder down and raised the quiet count.
 */
export function wakeOutcome(result) {
  // A floor wake that kept the rest its last wait asked for (SDK MAX_REST_MS): settled without the model, like a judged deferral.
  if (result?.status === 'idle' && result.reason === 'unchanged_since_wait') return { outcome: 'deferred', reason: 'unchanged_since_wait', saved: Number.isFinite(result.savedTokens) ? result.savedTokens : 0 };
  if (result?.status === 'judgment_deferred') return { outcome: 'deferred', reason: result.reason ?? 'judged_idle' };
  // A paid decision that new evidence or a stop superseded: recorded (with its tokens), never moving the ladder.
  if (result?.status === 'stale' && Number(result.usage?.totalTokens) > 0) return { outcome: 'interrupted', reason: result.reason ?? 'interrupted' };
  if (result?.status !== 'decided') return null;
  const work = result.decision?.action !== 'wait' && result.admitted !== false;
  return { outcome: work ? 'work' : 'thought', ...(result.admission?.reason ? { reason: result.admission.reason } : {}) };
}
/**
 * Whether a resumed background run may go on with the project version it started on (GN-1). The version selected now
 * (trial or active) may; so may one a later generation or an adoption superseded (that is what the pin is for: a
 * resumed run never swaps in a newer script under an unchanged name). One the user withdrew may not: rolled back (an
 * adopted version undone, or a trial ended), or out of trial without being adopted (another trial replaced it, an
 * adoption left it stale), or gone.
 */
export function pinnedVersionAllowed(project, versionId) {
  if (versionId === project?.trialVersionId || versionId === project?.activeVersionId) return true;
  const version = (project?.versions ?? []).find(row => row?.id === versionId);
  return Boolean(version) && !version.rolledBackAt && !['ready', 'stale'].includes(version.state);
}
/** Independent evidence kept for the next judgment (L5), newest last; the gate state reads the last six and a count bucket. */
const PENDING_GATE_EVIDENCE = 24;
/** How long a wake given without a retry time (a rule bypass, a forced or shadow-mode review) stands for the same situation: the judge's shortest deferral (DecisionService.deferralDelay). */
const GATE_WAKE_RETRY_MS = 60000;
/**
 * A held question's SDK retry (F4): only a backstop. The question is released by the user's presence or return
 * (releaseHeldAsks), not by this clock; a backstop that fires while its record is in its thread waits again without
 * narrating anything (narrator_held, no tokens). Ten minutes, the retry the held question had before F4: a question left
 * without its record (a rollback to a host before F4, which never reads heldAsks; a record that left its thread) is
 * narrated again no later than that host would have, and never more often (heldAskNarratedAt).
 */
const HELD_ASK_RETRY_MS = 10 * 60000;
/** The deferral reasons of a latched held question: held for the user's absence, or its backstop came due first. */
const HELD_ASK_LATCHES = new Set(['narrator_away', 'narrator_night', 'narrator_held']);
/**
 * The turn waits on the user: a question or permission card its tool call put up is still open (pending, or interrupted
 * and answerable). Read back from the end of the conversation to the turn's own request.
 */
export function waitingOnUser(session, turn) {
  const items = session?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index], record = item?.interaction;
    if (record && ['question', 'permission'].includes(record.kind) && record.source === 'tool' && (record.turnId ?? item.turnId) === turn.id && ['pending', 'interrupted'].includes(record.status) && record.canRespond !== false) return true;
    if (item?.id === turn.userItemId) return false;
  }
  return false;
}
const UNSENT_CALL = /<\/?(?:antml:)?(?:function_calls|invoke|parameter)\b|<tool_call>|"type"\s*:\s*"tool_use"/i;
/**
 * A last reply that ends in a tool call written out as text: the call was never sent, so the
 * worker stopped mid-step and its final text is not a report. Code blocks are not checked.
 */
export function unsentToolCall(text) { return UNSENT_CALL.test(String(text ?? '').replace(/```[\s\S]*?```/g, '').slice(-2000)); }
function learningEvidence(events, actions = []) {
  // Unknown/archived receipts are not external input. Require a retained,
  // completed work action; this also excludes learning's own completion loop.
  const workReceipts = new Set(actions.filter(action => action.action === 'work' && action.status === 'completed' && !action.contextRevoked && !action.sourceDeleted).map(action => `action:${action.id}:completed`));
  return events.filter(event => event.type === 'action_completed' || event.id.startsWith('action:') ? workReceipts.has(event.id) : true);
}
/** `sent`/`eventIds` (TC-3): a completed work whose result the request already carries (its completion event, or a recentActions receipt that shows its whole result: no handoff, at most SDK_RECEIPT_TEXT characters) is named without its summary. */
function communicationStatus(project, sessions, now = Date.now(), { sent = null, eventIds = null } = {}) {
  const actions = (project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => !action.contextRevoked && !action.sourceDeleted);
  const messages = sessions.flatMap(session => session.items.filter(item => item.source === 'initiative' && item.initiativeActionId && !item.contextRevoked && !item.sourceDeleted).map(item => ({ ...item, sessionId: session.id }))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const referenced = new Set(messages.flatMap(item => item.evidenceIds ?? []));
  // A receipt given back after a scope rotation or a restored conversation (contextRestored) is history, not a fresh unshared finding.
  const unreferenced = actions.filter(action => action.action === 'work' && action.status === 'completed' && !action.contextRestored && !referenced.has(`action:${action.id}:completed`));
  return { lastDeliveredAt: messages.at(-1)?.createdAt ?? null, recentDeliveries: messages.slice(-3).map(item => ({ actionId: item.initiativeActionId, sessionId: item.sessionId, at: item.createdAt, text: excerpt(item.text, 600) })),
    pending: actions.filter(action => ['share', 'ask'].includes(action.action) && ['queued', 'running'].includes(action.status)).slice(-4).map(action => ({ actionId: action.id, action: action.action, status: action.status, deferredReason: action.deferredReason ?? null })),
    recentWorkNotReferencedByDelivery: unreferenced.slice(-4).map(action => ({ actionId: action.id, evidenceId: `action:${action.id}:completed`, finishedAt: action.finishedAt ?? null, ...((sent?.has(action.id) && sdkShowsResult(action)) || eventIds?.has(`action:${action.id}:completed`) ? {} : { summary: excerpt(action.resultSummary, 700) }), verifiedByHost: false })),
    interpretation: 'These are actual retained conversation delivery receipts, not a timer mandate. Work not referenced by an initiative delivery may already have been discussed in the foreground: compare the conversation before sharing. Summaries are worker statements; inspect project_history tool receipts when necessary. Communicate only a useful new finding, never fabricate activity or repeat a status message.',
    // Sent in the last 24h, with the user's observed reaction (replied, acted,
    // dismissed, ignored, pending). A near-repeat of any of these is rejected.
    sentLast24h: sentDigest(project, sessions, { now }) };
}
function learningStatus(project, { model, now, running = false, redactValues = [] }) {
  const baseline = project.versions?.find(version => version.id === project.activeVersionId);
  const actions = project.initiativeRuntime?.sdkState?.actions ?? [];
  const events = learningEvidence(project.initiativeRuntime?.sdkState?.events ?? [], actions);
  const externalIds = new Set(events.filter(event => !event.id.startsWith('action:') && event.type !== 'action_completed').map(event => event.id));
  const workIds = new Set(actions.filter(action => action.action === 'work').map(action => `action:${action.id}:completed`));
  const workReceipts = events.filter(event => workIds.has(event.id));
  const identity = baseline?.bundle && model ? getProjectEvolutionIdentity(project, { evidence: events, model }) : null;
  const coverage = identity ? getEvolutionEvidenceCoverage(project, identity) : null;
  const nextAllowedAt = autonomousLearningNotBefore(project);
  const label = (value, limit = 120) => { let text = String(value ?? ''); for (const secret of redactValues) if (secret) for (const representation of [secret, encodeURIComponent(secret)]) text = text.split(representation).join('[REDACTED]'); return text.slice(0, limit); };
  const attempts = (project.versions ?? []).filter(version => version.simulated === false && !version.contextRevoked && !version.sourceDeleted && version.parentVersionId === project.activeVersionId).slice(-2);
  const lastAction = project.initiativeRuntime?.sdkState?.actions?.findLast(action => action.action === 'learn' && !action.contextRevoked && !action.sourceDeleted);
  return {
    enabled: project.evolution.enabled, baselineAvailable: Boolean(baseline?.bundle), trialActive: Boolean(project.trialVersionId), evaluationInFlight: running,
    lastAutonomousStartedAt: project.evolution.lastAutonomousStartedAt ?? null, lastEvaluatedAt: project.evolution.lastEvaluatedAt ?? null,
    lastAction: lastAction ? { actionId: lastAction.id, status: lastAction.status, startedAt: lastAction.startedAt ?? null, finishedAt: lastAction.finishedAt ?? null, cancellationReason: label(lastAction.cancellationReason), errorCode: label(lastAction.failure?.code ?? lastAction.errorCode), meaning: 'A cancelled or superseded action does not establish that a new candidate was generated or evaluated.' } : null,
    cooldown: { minIntervalMs: project.evolution.minIntervalMs ?? PROJECT_SCHEDULE_DEFAULTS.minIntervalMs, nextAllowedAt: nextAllowedAt || null, elapsed: now >= nextAllowedAt },
    evidence: { identityAvailable: Boolean(identity), availableCount: events.length, availableExternalCount: externalIds.size, availableWorkReceiptCount: workReceipts.length,
      coveredCount: coverage?.coveredEvidenceCount ?? null, uncoveredCount: coverage?.uncoveredEvidenceCount ?? null,
      uncoveredEvidenceIds: (coverage?.uncoveredEvidenceIds ?? []).slice(-16),
      uncoveredExternalEvidenceIds: (coverage?.uncoveredEvidenceIds ?? []).filter(id => externalIds.has(id)).slice(-16),
      uncoveredWorkReceiptIds: (coverage?.uncoveredEvidenceIds ?? []).filter(id => workIds.has(id)).slice(-16),
      workReceiptMeaning: 'A work completion event contains a model-authored summary, not verified tool facts. Use project_history to inspect retained tool receipts when the underlying evidence matters. A new user message is not required to learn from existing checked work results. Learning completion receipts are excluded.',
      meaning: 'Eligible evidence not covered under the current baseline, model and evaluation method permits consideration, not proof of a defect or a reason to invent an experiment. Unknown or revoked action receipts are excluded. Use exact allowedEvidenceIds in the current request.' },
    recentAttempts: attempts.map(version => {
      const evaluation = version.evaluation ?? {}, diagnostic = version.error?.diagnostic ?? version.error?.evolutionDiagnostic;
      const exposure = summarizeLearningEvaluationExposure(evaluation.exposure ?? version.evaluationEvidence?.exposure);
      return { versionId: version.id, state: version.state, createdAt: version.createdAt, completedAt: version.completedAt ?? null,
        ...(exposure ? { exposure: { ...exposure, unobservedTargets: exposure.unobservedTargets.map(row => ({ ...row, target: label(row.target, 160) })), unknownTargets: exposure.unknownTargets.map(row => ({ ...row, target: label(row.target, 160) })) } } : {}),
        evaluationRuntimeCurrent: identity ? version.evaluationRuntimeHash === identity.evaluationRuntimeHash : null,
        gatePassed: evaluation.gatePassed === true, evaluationComplete: evaluation.evaluationComplete === true,
        failure: { code: label(version.error?.code), phase: label(diagnostic?.phase ?? evaluation.stage), kind: label(diagnostic?.kind ?? evaluation.earlyStopReason),
          failedGates: Object.entries(evaluation.gates ?? {}).filter(([, passed]) => passed === false).map(([name]) => label(name, 60)).slice(0, 6),
          failedCaseIds: [...new Set([...(evaluation.smoke?.results ?? []), ...(evaluation.frozenSmoke ?? []), ...(evaluation.details ?? [])].filter(row => row.passed === false).map(row => label(row.caseId ?? row.case ?? row.toolId, 80)).filter(Boolean))].slice(0, 3) } };
    }),
    interpretation: 'Work advances or verifies the project deliverable. Learn changes the agent method, system prompt, skills or automation using a testable hypothesis and frozen evaluation. Old rejected candidates are not improvements. A cooldown expiring permits consideration; it never requires a new version. Waiting remains valid when no worthwhile, evaluable change is supported.'
  };
}
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const error = (message, code) => Object.assign(new Error(message), { code });
const realProject = project => project && !project.archivedAt && project.decisionMode === 'rna-model' && project.initialization?.status === 'ready';
const unconfirmedJob = (project, action) => action.status === 'needs_review' && !action.resolvedAt
  ? project.jobs?.find(job => job.id === action.id && job.simulated !== true && job.lane === 'background' && job.status === 'needs_review' && ['uncertain_tool', 'tool_uncertain', 'process_cleanup_uncertain'].includes(job.errorCode ?? job.failure?.code)) : undefined;
const needsJobReconciliation = project => project.initiativeRuntime?.sdkState?.actions?.some(action => { const job = unconfirmedJob(project, action); return job && (action.blocksExecution !== true || action.errorCode !== (job.errorCode ?? job.failure?.code)); });
/**
 * The initiative scope is split three ways (PDL-1/MEM-2, after learning's G9 in project-learning-scope.mjs). It used to
 * be one hash of everything, the global capability registry and the conversation list included, so a gene generation,
 * a capability install in any project or a new conversation revoked every receipt, stopped running work, cancelled
 * queued deliveries and had the memory pump delete the deliveries' evidence.
 * - Privacy (initiativePrivacyInputs, initiative-privacy.mjs): the action contract, the project's identity, its
 *   workspace folder and that folder's identity as the directory observer knows it. A change revokes what the old scope
 *   produced (`privacyRevoked`). The runtime records it as `privacyScopeHash`, a field no earlier version writes:
 *   `sourceHash` carries it too, but a version before the split (run again by a maintenance rollback) rewrites
 *   `sourceHash` with its own hash of everything and keeps the rest of the runtime.
 * - Drift (initiativeDriftInputs): what the coordinator froze when it was built. A change refreshes it and keeps
 *   everything else.
 * - Conversations: a new one or a plan-mode toggle changes nothing; an archived one withdraws only what cites it
 *   (syncMembership); a deleted one is scrubbed by session-evidence-cleanup.
 */
export const INITIATIVE_SCOPE_SCHEMA_VERSION = 2;
/**
 * Whether a split runtime was saved again by a version before the split (a maintenance rollback): it kept the
 * runtime's fields and rewrote `sourceHash` with its own hash, so `sourceHash` no longer names the privacy scope.
 */
const olderWriter = runtime => runtime?.scopeSchemaVersion === INITIATIVE_SCOPE_SCHEMA_VERSION && typeof runtime.privacyScopeHash === 'string' && runtime.sourceHash !== runtime.privacyScopeHash;
/** The privacy scope a runtime was saved under, when it records one (a split runtime; never one saved before the split). */
const savedPrivacyScope = runtime => runtime?.scopeSchemaVersion !== INITIATIVE_SCOPE_SCHEMA_VERSION ? null : typeof runtime.privacyScopeHash === 'string' ? runtime.privacyScopeHash : typeof runtime.sourceHash === 'string' ? runtime.sourceHash : null;
/** This project's own assigned capability declarations: never the whole registry, which every project's installs and generations change. */
const ownCapabilities = (capabilities, assignments) => {
  const pick = (rows, ids) => Array.isArray(rows) && Array.isArray(ids) && ids.length ? rows.filter(row => ids.includes(row?.id)) : [];
  return [pick(capabilities?.tools, assignments?.toolIds), pick(capabilities?.skills, assignments?.skillIds), pick(capabilities?.mcpServers, assignments?.mcpServerIds)];
};
/**
 * What a coordinator freezes when it is built: the decision model and its credential and output cap (provider
 * revision), and the planning capabilities (the project's assignments, its own capability declarations, its active or
 * trial version's genome). The rest of a decision's input is read live before every review (snapshot()).
 */
function initiativeDriftInputs(store, project, model) {
  const provider = store.state.configuration.providers.find(row => row.id === model.providerId);
  const outputCompatibility = Object.fromEntries(['supportsJsonObject', 'supportsToolChoiceNone'].filter(key => model.compat?.[key] !== undefined).map(key => [key, model.compat[key]]));
  const version = project.versions?.find(row => row.id === (project.trialVersionId ?? project.activeVersionId));
  return ['initiative-drift-v1', model.providerId, model.modelId, model.reasoning, model.baseUrl, model.contextWindow ?? null, model.maxOutputTokens ?? null, provider?.updatedAt ?? null, outputCompatibility,
    project.activeVersionId ?? null, project.trialVersionId ?? null, version?.bundle?.hash ?? null, project.assignments ?? null, project.capabilityRevision ?? 0, ownCapabilities(store.state.capabilities, project.assignments)];
}
/** The project-state observation is named after what it says (it was named after the whole scope hash, so it changed with every scope rotation). */
const projectStateSourceId = project => `project:${hash(['project-state-v2', project.name ?? null, project.overview ?? null, project.focus ?? null, project.openQuestions ?? null]).slice(0, 40)}`;
const PERMISSION_RANK = { read: 0, write: 1, execute: 2 };
/** The saved background permission (plan mode and a running foreground turn narrow it only for a while, not this). */
const backgroundGrant = project => PERMISSION_RANK[permissionLevel(project, 'background')] ?? 0;
/** The evidence ids an archived conversation fed: its messages and turns. */
function conversationEvidence(session) {
  let ids = conversationEvidenceCache.get(session);
  if (!ids) { ids = { messages: new Set((session.items ?? []).map(item => `message:${item.id}`)), turns: new Set((session.turns ?? []).map(turn => turn.id)) }; if (Object.isFrozen(session)) conversationEvidenceCache.set(session, ids); }
  return ids;
}
const conversationEvidenceCache = new WeakMap();
const citesConversation = (evidence, id) => typeof id === 'string' && (evidence.messages.has(id) || evidence.turns.has(/^turn:([^:]+):/.exec(id)?.[1]));
/** Give a drift- or archive-revoked work action its record back from its job (the user's record of the run keeps title, instruction, evidence, handoff and result). */
function restoreFromJob(action, job, at, from) {
  if (typeof job.instruction === 'string' && job.instruction.trim()) action.content = job.instruction;
  if (typeof job.title === 'string' && job.title) action.title = job.title;
  if (Array.isArray(job.evidenceIds)) action.evidenceIds = copy(job.evidenceIds);
  if (typeof job.handoff === 'string' && job.handoff) action.handoff = job.handoff;
  if (action.status === 'completed' && job.status === 'completed' && typeof job.output === 'string' && job.output.trim()) action.resultSummary = job.output;
  delete action.contextRevoked; delete action.revokedBy; delete action.revokedSessionIds; action.contextRestored = { at, from };
}
const liveJob = (jobs, action) => action.action === 'work' ? (jobs ?? []).find(row => row.id === action.id && row.lane === 'background' && row.simulated !== true && !row.sourceDeleted && !row.contextRevoked && !row.privacyRevoked) : null;
const ARCHIVED_PLACEHOLDER = 'Its conversation was archived; retained only as an action receipt.';
/**
 * Apply what the archived conversations of a project withdraw to an initiative state (the SDK's), in place; idempotent.
 * Events they fed go, and so does what was concluded from them: actions citing them, or citing such an action's
 * receipt, are withdrawn from the model's context like a privacy revocation (their text is stripped, since the SDK
 * shows completed receipts to the model; `revokedBy: 'session_archived'`), but they are not deleted evidence: memory
 * keeps the deliveries. Once every conversation such an action cited is restored, a work action gets its record back
 * from its job. Queued or paused work citing them is cancelled; running work is the caller's to stop. Returns whether
 * anything changed, the running actions citing an archived conversation and the paused work it ended.
 */
export function applyConversationMembership(sdkState, sessions, jobs = [], now = Date.now()) {
  const archived = sessions.filter(session => session.archivedAt).map(session => ({ id: session.id, evidence: conversationEvidence(session) }));
  const live = new Set(sessions.filter(session => !session.archivedAt).map(session => session.id));
  // What each withdrawn action came from: its own citations of an archived conversation, or those of a withdrawn
  // action whose receipt it cites (a share of work that came from the archived conversation). One already withdrawn
  // counts the archived conversations it was withdrawn for and those its job (the record it would get back) cites.
  const direct = ids => archived.filter(row => (ids ?? []).some(id => citesConversation(row.evidence, id))).map(row => row.id);
  const withdrawn = new Map((sdkState.actions ?? []).filter(action => action.revokedBy === 'session_archived' && !action.sourceDeleted && !action.privacyRevoked).flatMap(action => {
    const sources = [...new Set([...(action.revokedSessionIds ?? []).filter(id => !live.has(id)), ...direct(liveJob(jobs, action)?.evidenceIds)])].sort();
    return sources.length ? [[action.id, sources]] : [];
  }));
  const actionOf = id => /^action:([^:]+):/.exec(String(id))?.[1];
  const citing = ids => [...new Set((ids ?? []).flatMap(id => [...archived.filter(row => citesConversation(row.evidence, id)).map(row => row.id), ...(withdrawn.get(actionOf(id)) ?? [])]))].sort();
  let changed = false; const running = [], ended = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const action of sdkState.actions ?? []) if (!withdrawn.has(action.id) && !action.sourceDeleted && !action.privacyRevoked && action.revokedBy !== 'session_archived') {
      const sources = citing(action.evidenceIds); if (sources.length) { withdrawn.set(action.id, sources); grew = true; }
    }
  }
  const events = (sdkState.events ?? []).filter(event => !citing([event.id]).length);
  if (events.length !== (sdkState.events ?? []).length) { sdkState.events = events; changed = true; }
  const last = sdkState.lastDecision;
  if (last && !last.withdrawn && citing(last.evidenceIds).length) { sdkState.lastDecision = { ...last, content: ARCHIVED_PLACEHOLDER, reason: ARCHIVED_PLACEHOLDER, evidenceIds: [], withdrawn: 'session_archived' }; for (const key of ['title', 'questions', 'permissionRequest', 'schedule']) delete sdkState.lastDecision[key]; changed = true; }
  for (const action of sdkState.actions ?? []) {
    if (action.sourceDeleted || action.privacyRevoked) continue;
    if (action.revokedBy === 'session_archived') {
      // The record restoreFromJob gives back is its job's: it stays withdrawn while any conversation it was withdrawn
      // for, or that its job cites, is archived (one of several archived conversations restored is not enough).
      const job = liveJob(jobs, action), still = [...new Set([...(withdrawn.get(action.id) ?? []), ...citing(job?.evidenceIds)])].sort();
      if (still.length) { if (still.join(',') !== [...(action.revokedSessionIds ?? [])].sort().join(',')) { action.revokedSessionIds = still; changed = true; } continue; }
      if (job) { restoreFromJob(action, job, new Date(now).toISOString(), 'session_restored'); changed = true; }
      continue;
    }
    const sources = withdrawn.get(action.id);
    if (!sources) continue;
    if (action.status === 'running') { running.push(action.id); continue; }
    if (['queued', 'paused'].includes(action.status) && !action.hostSchedule) {
      if (action.status === 'paused' && action.action === 'work') ended.push(structuredClone(action));
      action.status = 'cancelled'; action.cancellationReason = 'source_session_archived';
    }
    action.evidenceIds = []; action.content = ARCHIVED_PLACEHOLDER;
    delete action.resultSummary; delete action.handoff; delete action.title;
    Object.assign(action, { contextRevoked: true, revokedBy: 'session_archived', revokedSessionIds: sources }); changed = true;
  }
  return { changed, running, ended };
}
/**
 * Conversations restored from the archive are observed again: archiving dropped the events they fed, not their seen
 * ids, so their messages and results would stay duplicates of themselves. Their ids leave `seenEventIds` in place (an
 * id whose event is still held stays). Returns whether an evidence id is one of theirs.
 */
export function forgetRestoredConversations(sdkState, sessions) {
  if (!sessions.length) return () => false;
  const evidence = sessions.map(conversationEvidence), theirs = id => evidence.some(row => citesConversation(row, id));
  const held = new Set((sdkState.events ?? []).map(event => event.id)), seen = sdkState.seenEventIds ?? [];
  const kept = seen.filter(id => held.has(id) || !theirs(id));
  if (kept.length !== seen.length) sdkState.seenEventIds = kept;
  return theirs;
}
/** Finish the line of a run a restart cut off once its working copy is settled: final text, no `recovering` (MEM-3). */
function recoveredLine(item, text, at) {
  const { recovering: _settled, ...work } = item.initiative.backgroundWork;
  item.text = text; item.initiative = { ...item.initiative, backgroundWork: { ...work, status: 'interrupted' } }; item.updatedAt = at;
}
const totalTokens = usage => Math.max(0, Number(usage?.totalTokens) || 0);
/** UTF-8 bytes of what a message streamed (text, reasoning, tool arguments): the output part of an unreported request's estimate. */
const streamedBytes = message => Number.isSafeInteger(message?.streamedBytes) ? message.streamedBytes : (Array.isArray(message?.content) ? message.content : []).reduce((sum, block) => sum + Buffer.byteLength(typeof block?.text === 'string' ? block.text : typeof block?.thinking === 'string' ? block.thinking : block?.type === 'toolCall' ? JSON.stringify(block.arguments ?? {}) : ''), 0);
// A background step as the tasks panel shows it: a short target, and live step events at most this often per run.
const STEP_TARGET_LIMIT = 80, STEP_EVENTS_PER_SECOND = 4;
const answerableInteraction = item => !item.sourceDeleted && !item.contextRevoked && ['question', 'permission'].includes(item.interaction?.kind) && ['pending', 'interrupted'].includes(item.interaction.status) && item.interaction.canRespond === true;
/**
 * Background change sets keep the last 30 rows (plan §4.4); a git set still waiting (deferred, or on its conflict card)
 * is never dropped, since its worktree still holds its changes.
 */
function trimChanges(rows) {
  const excess = rows.length - 30, dropped = [];
  if (excess <= 0) return { rows, dropped };
  for (const row of rows) { if (dropped.length >= excess) break; if (!(row.kind === 'git' && ['deferred', 'merge_conflicted'].includes(row.status))) dropped.push(row.id); }
  return { rows: rows.filter(row => !dropped.includes(row.id)), dropped };
}
/** How a change set's run ended, as the line texts read it (backgroundChangeText, gitChangeText). */
const rowResult = row => ({ ...(row.report ? { reported: row.report } : {}), ...(row.failed ? { failed: true } : {}), ...(row.cancelled ? { cancelled: true } : {}), ...(row.stopped ? { superseded: true } : {}), ...(row.unreported ? { unreported: true } : {}) });
/** The status of a writing run's line once it ended, from how it ended. */
const workLineStatus = result => (result?.failed ? 'failed' : result?.cancelled ? 'cancelled' : result?.superseded ? 'stopped' : result?.unreported ? 'unreported' : 'done');
const blockedMessage = reason => ({ budget_exhausted: '主动协作预算不足，等待调整预算。', action_history_full: '后台行动记录达到保留上限，等待归档或结果确认。', unsettled_operation: '后台操作尚未确认结束，已停止叠加新操作。' })[reason] ?? '主动协作等待可用的真实模型。';

/** The foreground conversation and the continuing project mind are independent.
 * Timers schedule a review; they are never evidence, messages, or synthetic work.
 * All host effects are checked again against current state at their commit point.
 */
export class ProjectInitiativeController {
  constructor(store, { capabilityService = new CapabilityService(store), marketplaceService = new SkillMarketplaceService(store), runtimeFactory = createRnaRuntime, decisionProvider = streamCompletion, evolutionProvider = decisionProvider, evolutionService = new ProjectEvolutionService(store, { provider: evolutionProvider }), interactionService, permissionService, scheduleService, decisionService, initialDelayMs = 45000, tickIntervalMs = 1000, maxConcurrentReviews = 4, decisionTimeoutMs, actionTimeoutMs = 1800000, foregroundDrainTimeoutMs = 15000, workMaxSteps = DEFAULT_MAX_STEPS, independentLearning = false, foregroundToolSurface, feedbackCheckIntervalMs = 30000, outcomeCheckIntervalMs = 5000, cacheAlignedWake = false, narratorProvider = null, now = Date.now, engine = null, worktrees = null, roots = null } = {}) {
    // Cache-aligned early wake: forced on by option, otherwise decided per project by pacing (cacheWakeAllowed).
    this.cacheAlignedWake = cacheAlignedWake === true;
    // Optional last-resort model rewrite for the narrator (production wires the real provider; tests stay deterministic).
    this.narratorProvider = typeof narratorProvider === 'function' ? narratorProvider : null; this.lastSeen = new Map();
    this.feedbackCheckIntervalMs = Number.isSafeInteger(feedbackCheckIntervalMs) && feedbackCheckIntervalMs >= 0 ? feedbackCheckIntervalMs : 30000;
    if (!Number.isInteger(workMaxSteps) || workMaxSteps < 1 || workMaxSteps > 1000) throw error('workMaxSteps must be between 1 and 1000', 'invalid_options');
    this.workMaxSteps = workMaxSteps; this.independentLearning = independentLearning === true;
    if (!Number.isSafeInteger(foregroundDrainTimeoutMs) || foregroundDrainTimeoutMs < 1 || foregroundDrainTimeoutMs > 60000) throw error('Invalid foreground drain deadline', 'invalid_options');
    this.foregroundDrainTimeoutMs = foregroundDrainTimeoutMs;
    this.evolutionService = evolutionService; this.marketplaces = marketplaceService;
    this.decisions = decisionService;
    // C2: the wake rows (`<state>.rna/metrics/wakes.jsonl`) and the work-outcome transitions (`work-outcomes.jsonl`) are
    // sidecars inside the journal root, shared through the store like the decision ledger (host-metrics.mjs creates them
    // with their daily rollups; a controller built on a bare store keeps them beside it, or in memory without a file).
    // A start moves the wake rows an older release left in state into the log, and trims state to its tail.
    this.wakeLog = store.wakeLog ??= new WakeLog({ file: typeof store.file === 'string' ? wakeLogFile(store.file) : null, now });
    this.outcomeLog = store.outcomeLog ??= new WorkOutcomeLog({ file: typeof store.file === 'string' ? outcomeLogFile(store.file) : null, now });
    try { this.wakeLog.absorb(store); } catch { /* the import is idempotent: the next start retries */ }
    this.outcomeCheckIntervalMs = Number.isSafeInteger(outcomeCheckIntervalMs) && outcomeCheckIntervalMs >= 0 ? outcomeCheckIntervalMs : 5000;
    // Opt-in capture of routed internal calls for the effort probe and replay (internal-reasoning.mjs).
    this.effortCapture = new EffortCapture({ stateFile: store.file, now, live: ids => sessionsLive(this.store.state, ids) });
    this.interactions = interactionService; this.permissionService = permissionService; this.scheduleService = scheduleService;
    this.store = store; this.foregroundToolSurface = foregroundToolSurface; this.capabilities = capabilityService; this.factory = runtimeFactory; this.decisionProvider = decisionProvider; this.evolutionProvider = evolutionProvider; this.initialDelayMs = initialDelayMs; this.now = now;
    this.contexts = new Map(); this.closed = false; this.writing = false; this.pumping = false; this.again = false;
    this.maxConcurrentReviews = Number.isInteger(maxConcurrentReviews) ? Math.max(1, Math.min(16, maxConcurrentReviews)) : 4; this.decisionTimeoutMs = decisionTimeoutMs; this.actionTimeoutMs = actionTimeoutMs; this.cursor = 0; this.lastPumpAt = null;
    // Background worktrees (design 0.63 §8): wired with the engine, the worktree service and the root resolver (or later
    // through attachIsolation); without them, and wherever isolation is off, background work keeps 0.62's DirectFix path.
    this.background = new BackgroundWorktrees(store, { engine, worktrees, roots, now }); this.gitBusy = new Set();
    this.restoreDriftRevocations(); this.recover(); this.settleWorkLines();
    this.unsubscribe = store.subscribe(() => { if (!this.writing) { this.invalidate(); this.schedule(); } }, { display: false });
    // Deferred applies wait for the project folder to be free, conflict cards for an answer: both follow state changes.
    this.unwatchGit = store.subscribe(() => this.scheduleGitUpkeep(), { display: false });
    // A project being deleted: its run handles are cancelled before its state goes (review X-1).
    this.offProjectDeleting = typeof store.onProjectDeleting === 'function' ? store.onProjectDeleting(id => this.releaseDeletedProject(id)) : null;
    this.timer = tickIntervalMs > 0 ? setInterval(() => this.schedule(), tickIntervalMs) : null; this.timer?.unref(); this.schedule(); this.scheduleGitUpkeep();
  }
  /**
   * Wire the background worktree services after construction (the engine, the worktree service and the root
   * resolver are built around the store as well); startup recovery and deferred applies follow.
   */
  attachIsolation({ engine, worktrees, roots } = {}) {
    Object.assign(this.background, { ...(engine ? { engine } : {}), ...(worktrees ? { worktrees } : {}), ...(roots ? { roots } : {}) });
    this.scheduleGitUpkeep();
  }
  mutate(fn) { this.writing = true; try { return this.store.mutate(fn); } finally { this.writing = false; } }
  /**
   * 0.65, PDL-1/MEM-2: before the scope split every gene generation, capability install, new conversation or
   * plan-mode toggle revoked every action (`contextRevoked` with nothing else), wiping its title, intent, result and
   * handoff, so the background could no longer see what it had done. A work action gets them back from its job (the
   * user's record of the run keeps them) when the job and every conversation message or turn it cites still exist, and
   * the project's records show its job ran in the current folder (a folder move or folder identity change left the
   * same bare revocation, and is a privacy boundary now; workspaceEra); otherwise (a deleted or archived conversation, a
   * rewound message, a pruned job, an earlier or unknown folder) it stays revoked. A share action has no job: it keeps
   * its receipt only. Revocations by a deletion (`sourceDeleted`), a privacy boundary (`privacyRevoked`) or an archived
   * conversation (`revokedBy`) are never touched, nor is a project whose privacy scope changed since it was saved (its
   * coordinator revokes all of it). Runs at every start: nothing this version writes is a bare revocation, so it only
   * finds what a version before the split revoked, including after a maintenance rollback to one, and a project with
   * nothing to give back is not written. The result is recorded on the project (`initiativeRuntime.driftRestore`).
   */
  restoreDriftRevocations() {
    const drifted = action => action.contextRevoked === true && !action.sourceDeleted && !action.privacyRevoked && !action.revokedBy;
    const plan = (state, project) => {
      const sessions = state.sessions.filter(session => session.projectId === project.id && session.kind !== 'side' && !session.archivedAt);
      const messages = new Set(sessions.flatMap(session => (session.items ?? []).filter(item => !item.sourceDeleted && !item.contextRevoked).map(item => `message:${item.id}`)));
      const turns = new Set(sessions.flatMap(session => (session.turns ?? []).map(turn => turn.id)));
      const sessionIds = new Set(sessions.map(session => session.id)), history = workspaceHistory(project), scope = this.scope(project);
      // Every message or turn the work cited is still in a live conversation (other evidence kinds are not conversations).
      const sourcesLive = ids => (ids ?? []).every(id => typeof id !== 'string' || (id.startsWith('message:') ? messages.has(id) : /^turn:[^:]+:/.test(id) ? turns.has(/^turn:([^:]+):/.exec(id)[1]) : true));
      const restore = []; let kept = 0, workspaceChanged = 0;
      for (const action of project.initiativeRuntime.sdkState.actions) {
        if (!drifted(action)) continue;
        const job = liveJob(project.jobs, action);
        if (!job || !sourcesLive(job.evidenceIds) || (action.hostSchedule && !sessionIds.has(action.hostSchedule.destinationSessionId))) { kept++; continue; }
        if (workspaceEra(history, { at: Date.parse(job.createdAt ?? ''), evidenceIds: job.evidenceIds, privacyScope: job.privacyScope ?? null, scope }) !== 'current') { kept++; workspaceChanged++; continue; }
        restore.push(action.id);
      }
      return { restore, kept, workspaceChanged };
    };
    // A privacy change since the runtime was saved: create() revokes everything of the old scope; nothing is given back first.
    const candidate = project => project.initiativeRuntime?.sdkState?.actions?.some(drifted) && (savedPrivacyScope(project.initiativeRuntime) === null || savedPrivacyScope(project.initiativeRuntime) === this.scope(project));
    const projects = this.store.state.projects.filter(project => candidate(project) && (!project.initiativeRuntime.driftRestore || plan(this.store.state, project).restore.length));
    if (!projects.length) return;
    const at = new Date(this.now()).toISOString();
    this.mutate(state => {
      for (const target of projects) {
        const project = state.projects.find(row => row.id === target.id); if (!project?.initiativeRuntime?.sdkState || !candidate(project)) continue;
        const { restore, kept, workspaceChanged } = plan(state, project), previous = project.initiativeRuntime.driftRestore;
        for (const action of project.initiativeRuntime.sdkState.actions) if (restore.includes(action.id)) restoreFromJob(action, liveJob(project.jobs, action), at, 'scope_drift');
        // `restored`: the actions given back so far (one given back again after a rollback counts once).
        const restored = project.initiativeRuntime.sdkState.actions.filter(action => action.contextRestored?.from === 'scope_drift' && !action.contextRevoked).length;
        project.initiativeRuntime.driftRestore = { version: 1, at, restored, kept, ...(workspaceChanged ? { workspaceChanged } : {}), ...(previous ? { runs: (previous.runs ?? 1) + 1 } : {}) };
      }
    });
  }
  /**
   * Nothing runs across a restart: a line still "working" says the run was cut off (its file list lived in memory).
   * A line still "paused" whose run will not go on (stopped, or ended by a scope change, before this was kept in
   * step) says it stopped, instead of 已暂停 forever (F44).
   */
  settleWorkLines() {
    const actionOf = (state, session, work) => state.projects.find(row => row.id === session.projectId)?.initiativeRuntime?.sdkState?.actions?.find(row => row.id === work.actionId);
    const stale = (state, session, work) => work?.status === 'running' || work?.status === 'paused' && !['paused', 'queued', 'running'].includes(actionOf(state, session, work)?.status);
    if (!this.store.state.sessions.some(session => session.items?.some(item => stale(this.store.state, session, item.initiative?.backgroundWork)))) return;
    const language = interfaceLanguageOf(this.store.state), at = new Date(this.now()).toISOString();
    this.mutate(state => {
      for (const session of state.sessions) for (const item of session.items ?? []) {
        const work = item.initiative?.backgroundWork; if (!stale(state, session, work)) continue;
        const project = state.projects.find(row => row.id === session.projectId), action = actionOf(state, session, work);
        const task = action ? this.actionName(project, action, { language }) : '';
        // A run in its own worktree left its files there: they are settled (only what does not conflict is applied) once
        // the worktree services are up (recoverWorktrees), and this line then says what happened.
        const isolated = (project?.git?.worktrees ?? []).some(row => row.kind === 'background' && row.owner?.actionId === work.actionId && row.state !== 'removed');
        if (isolated && work.status === 'running') {
          item.text = inLanguage(language, task
            ? { zh: `这次后台在做：${task}\n\n服务重启打断了它，没有做完；它改过的文件留在它自己的工作副本里，不冲突的部分会应用到项目文件夹。`, en: `This background task was: ${task}\n\nA service restart cut it off before it finished; the files it changed are in its own working copy, and what does not conflict will be applied to the project folder.` }
            : { zh: '服务重启打断了这次后台工作，没有做完；它改过的文件留在它自己的工作副本里，不冲突的部分会应用到项目文件夹。', en: 'A service restart cut this background work off before it finished; the files it changed are in its own working copy, and what does not conflict will be applied to the project folder.' });
          // `recovering`: its worktree is settled later (recoverWorktrees) and this line rewritten then, so the line is not
          // a delivery yet (MEM-3); the rewrite replaces backgroundWork and drops the flag.
          item.initiative = { ...item.initiative, backgroundWork: { ...work, status: 'interrupted', endedAt: at, recovering: true } }; item.updatedAt = at;
          continue;
        }
        if (work.status === 'paused') {
          item.text = this.stoppedPausedText(task, action?.cancellationReason, language);
          item.initiative = { ...item.initiative, backgroundWork: { ...work, status: 'cancelled', endedAt: at } }; item.updatedAt = at;
          continue;
        }
        item.text = inLanguage(language, task
          ? { zh: `这次后台在做：${task}\n\n服务重启打断了它，没有做完；它停下前改过的文件没留下快照，可以在任务页查看它做过的步骤。`, en: `This background task was: ${task}\n\nA service restart cut it off before it finished; the files it had changed were not snapshotted, and its steps are on the task page.` }
          : { zh: '服务重启打断了这次后台工作，没有做完；它停下前改过的文件没留下快照，可以在任务页查看它做过的步骤。', en: 'A service restart cut this background work off before it finished; the files it had changed were not snapshotted, and its steps are on the task page.' });
        item.initiative = { ...item.initiative, backgroundWork: { ...work, status: 'interrupted', endedAt: at } }; item.updatedAt = at;
      }
    });
  }
  /** The line of a paused run that will not go on: stopped by the user (`action_control`), else ended by a scope change. */
  stoppedPausedText(task, reason, language = interfaceLanguageOf(this.store.state)) {
    const how = reason === 'action_control' ? { zh: '按你的要求停下了', en: 'stopped as you asked' } : reason === 'project_scope_changed' ? { zh: '因为项目的情况变了，不再接着做', en: 'will not go on, since the project changed' } : { zh: '已经停下，不会再接着做', en: 'has stopped and will not go on' };
    return inLanguage(language, task
      ? { zh: `这次后台在做：${task}\n\n它${how.zh}；暂停前做的都保留着，可以在任务页查看它做过的步骤。`, en: `This background task was: ${task}\n\nIt ${how.en}; what it did before the pause stays, and its steps are on the task page.` }
      : { zh: `这次暂停的后台工作${how.zh}；暂停前做的都保留着，可以在任务页查看它做过的步骤。`, en: `This paused background work ${how.en}; what it did before the pause stays, and its steps are on the task page.` });
  }
  /**
   * The final line of an isolated run a restart cut off, by what became of its working copy: it had changed nothing
   * ('nothing'), could not be read ('unreadable'), was applied or removed from the worktree panel ('applied',
   * 'removed'), is kept there ('kept'), or is gone ('gone'). The rest settle through recordGitChange.
   */
  cutOffText(task, kind, language = interfaceLanguageOf(this.store.state)) {
    const what = {
      nothing: { zh: '它没有改动任何文件。', en: 'It had not changed any file.' },
      unreadable: { zh: '它的工作副本读不出来，改动没有应用；可以在项目设置的「工作树与 Git」里处理。', en: 'Its working copy could not be read, so nothing was applied; Project settings › Worktrees & Git can handle it.' },
      applied: { zh: '它的工作副本已经在项目设置的「工作树与 Git」里应用到项目文件夹。', en: 'Its working copy was applied to the project folder from Project settings › Worktrees & Git.' },
      removed: { zh: '它的工作副本已经在项目设置的「工作树与 Git」里移除，改动没有应用。', en: 'Its working copy was removed in Project settings › Worktrees & Git, and its changes were not applied.' },
      kept: { zh: '它的改动留在它的工作副本里，可以在项目设置的「工作树与 Git」里应用或丢弃。', en: 'Its changes stay in its working copy, where Project settings › Worktrees & Git can apply or discard them.' },
      gone: { zh: '它的工作副本已经不在了，改动没有应用。', en: 'Its working copy is gone, so its changes were not applied.' },
    }[kind] ?? { zh: '', en: '' };
    return inLanguage(language, task
      ? { zh: `这次后台在做：${task}\n\n服务重启打断了它，没有做完。${what.zh}`, en: `This background task was: ${task}\n\nA service restart cut it off before it finished. ${what.en}` }
      : { zh: `服务重启打断了这次后台工作，没有做完。${what.zh}`, en: `A service restart cut this background work off before it finished. ${what.en}` });
  }
  /** Finish the line of a cut-off run in its own worktree that recovery cannot settle through recordGitChange (MEM-3). */
  finishRecoveringLine(projectId, actionId, kind) {
    const key = `${actionId}-changes`, owns = item => item.initiativeActionId === key && item.initiative?.backgroundWork?.status === 'interrupted' && item.initiative.backgroundWork.recovering;
    if (!this.store.state.sessions.some(session => session.projectId === projectId && session.items?.some(owns))) return;
    const project = this.project(projectId), action = project?.initiativeRuntime?.sdkState?.actions?.find(row => row.id === actionId), job = project?.jobs?.find(row => row.id === actionId);
    const language = interfaceLanguageOf(this.store.state), task = project ? this.actionName(project, action ?? { id: actionId, content: job?.instruction ?? '', ...(job?.title ? { title: job.title } : {}) }, { language }) : '';
    const text = this.cutOffText(task, kind, language), at = new Date(this.now()).toISOString();
    this.mutate(state => { for (const session of state.sessions) if (session.projectId === projectId) for (const item of session.items ?? []) if (owns(item)) { recoveredLine(item, text, at); session.updatedAt = at; } });
  }
  /** Whether a run's conversation line still says it is paused. */
  pausedLine(projectId, actionId) {
    const key = `${actionId}-changes`;
    return this.store.state.sessions.some(session => session.projectId === projectId && !session.archivedAt && session.items?.some(item => item.initiativeActionId === key && item.initiative?.backgroundWork?.status === 'paused'));
  }
  /**
   * A paused run that will not go on (stopped from the task page or the conversation, or cancelled by a scope change)
   * completes its line: the files it changed before the pause, when this process still holds its snapshots, else a
   * plain line that it stopped (F44). A run that had changed nothing yet keeps that plain line too: the user just acted
   * on it, so it does not go away like an unstarted run's. The SDK settles such a stop at once, so the run itself never
   * reports it.
   */
  endPausedLine(context, action, reason) {
    const recorder = this.pausedRecorders?.get(action.id); this.pausedRecorders?.delete(action.id);
    // A paused run in its own worktree: its files are still there; what does not conflict is applied (design §4.3).
    if (!recorder && this.background?.ready() && this.background.recordFor(context.projectId, action.id) && !this.liveRun(action.id)) {
      const ending = { ...(reason === 'action_control' ? { cancelled: true } : { superseded: true }), pausedStop: reason };
      void this.background.load(context.projectId, this.background.recordFor(context.projectId, action.id)).then(bg => this.keepGitChanges(context, action, bg, ending)).catch(failure => console.warn(`background worktree ${action.id}: ${failure.message}`));
      return null;
    }
    if (!this.pausedLine(context.projectId, action.id)) return null;
    if (recorder?.changes().length) return this.keepBackgroundChanges(context, action, recorder, reason === 'action_control' ? { cancelled: true } : { superseded: true });
    const project = this.project(context.projectId), language = interfaceLanguageOf(this.store.state);
    return this.workLine(context, action, 'cancelled', { text: this.stoppedPausedText(project ? this.actionName(project, action, { language }) : '', reason, language) });
  }
  recover() {
    if (!this.store.state.projects.some(project => project.initiativeRuntime?.sdkState?.reservedTokens || project.initiativeRuntime?.sdkState?.actions?.some(action => action.status === 'running') || needsJobReconciliation(project))) return;
    this.mutate(state => {
      let uncertain = 0;
      for (const project of state.projects) {
        const saved = project.initiativeRuntime?.sdkState; if (!saved) continue;
        uncertain += saved.reservedTokens || 0; saved.estimatedTokens = (saved.estimatedTokens || 0) + (saved.reservedTokens || 0); saved.usedTokens += saved.reservedTokens || 0; saved.reservedTokens = 0;
        project.initiative.tokens = saved.usedTokens + learningTokenUsage(project).totalTokens;
        for (const action of saved.actions) if (action.status === 'running') { action.status = 'needs_review'; action.blocksExecution = !['share', 'ask'].includes(action.action); action.reasonForReview = 'Daemon ended before this action outcome was saved; verify effects before further execution. It will not be replayed.'; }
        // Older abort races recorded the action before the host finished its
        // journal check. A durable job with stronger uncertainty must restrict
        // execution too. Never turn it into a successful or retryable action.
        for (const action of saved.actions) {
          const job = unconfirmedJob(project, action); if (!job || action.blocksExecution === true && action.errorCode === (job.errorCode ?? job.failure?.code)) continue;
          action.blocksExecution = true; action.reasonForReview = action.error = 'Recorded background tool outcome is unconfirmed; explicit verification is required before further execution.';
          action.failure = initiativeFailure({ code: job.errorCode ?? job.failure?.code, message: job.failure?.message ?? action.reasonForReview }, { phase: action.action, source: 'host_handler', now: job.failure?.at ?? this.now(), redactValues: this.redactValues() });
          if (job.failure?.id) action.failure.id = job.failure.id;
          action.errorCode = action.failure.code;
        }
        for (const job of project.jobs) if (!job.simulated && job.lane === 'background' && job.status === 'running') { job.status = 'interrupted'; job.output = '服务重启，后台结果尚未确认；不会自动重复执行。'; }
      }
      chargeRealTokens(state, uncertain, { estimated: true, now: this.now() });
      for (const key of Object.keys(state.realUsage.reservations)) if (key.startsWith('initiative:')) releaseRealTokens(state, key, { now: this.now() });
    });
  }
  project(id) { return this.store.state.projects.find(project => project.id === id); }
  actionView(projectId) { return backgroundActionView(this, projectId); }
  controlAction(projectId, actionId, input) { return controlBackgroundAction(this, projectId, actionId, input); }
  createControlTools(input) { return backgroundControlTools(this, input); }
  async flushActionControls(context, actionId) {
    const run = context.workRuns.get(actionId);
    if (!run?.handle || !run.started) return;
    const previous = run.controlFlush ?? Promise.resolve();
    const flush = previous.catch(() => {}).then(async () => {
      if (!this.valid(context) || run.finishing) return;
      for (const command of context.coordinator.pendingActionControls(actionId)) {
        if (run.stopCommand) break;
        if (command.kind === 'steer') {
          await run.handle.steer(command.instruction, { requestId: command.id, wake: false });
          await context.coordinator.acknowledgeActionControl(actionId, command.id, { status: 'applied', summary: '方向已保存到原执行会话，将在下一模型请求边界读取。' });
        } else if (['pause', 'cancel'].includes(command.kind)) {
          await run.handle.yieldAtBoundary({ requestId: command.id });
          run.stopCommand = command;
        }
      }
    });
    run.controlFlush = flush;
    return flush;
  }
  deletionPending(projectId) { return this.store.state.sessionDeletions?.some(record => record.projectId === projectId && record.localStatus !== 'completed') ?? false; }
  /**
   * Store.onProjectDeleting: a project is about to be deleted. Its decision and every run are stopped now, before its
   * state goes, so nothing of it runs on and the deletion's host resolutions (project_deleted) are the last word on
   * them; the writers then settle as for any deleted conversation (drainDeletedSession).
   */
  releaseDeletedProject(projectId) {
    const context = this.contexts.get(projectId); if (!context) return;
    context.judgeAbort?.abort(); context.coordinator.interrupt('project_deleted');
  }
  async drainDeletedSession(record) {
    // A durable deletion barrier is installed before listeners run. Let an
    // already-entered pump finish observing that barrier, then retire its writer.
    await this.pendingPump;
    const context = this.contexts.get(record.projectId); if (!context) return;
    context.closing ??= context.coordinator.close().then(() => { context.closed = true; });
    await context.closing;
    await context.reviewPromise;
    // The coordinator's abort receipt may settle one microtask before the
    // cooperative handler disposes its journal and releases its ownership slot.
    // Yield once; never remove files while any actual writer remains retained.
    await new Promise(resolve => setImmediate(resolve));
    if (context.coordinator.unsettled.size || context.activeHandles.size) throw error('Background writer has not settled', 'SESSION_BACKGROUND_CLEANUP_PENDING');
    if (this.contexts.get(record.projectId) === context) this.contexts.delete(record.projectId);
  }
  async resolveAction(projectId, actionId, { status, summary } = {}) {
    const fail = (message, code, status) => { throw Object.assign(error(message, code), { status }); };
    if (this.closed) fail('主动协作控制器已关闭', 'closed', 503);
    if (!['completed', 'not-executed', 'cancelled'].includes(status) || typeof summary !== 'string' || !summary.trim() || summary.trim().length > 16000) fail('结果确认需要 completed/not-executed/cancelled 和非空核对说明（最多 16000 字符）', 'invalid_resolution', 400);
    const project = this.project(projectId); if (!project) fail('项目不存在', 'project_not_found', 404);
    const context = this.contexts.get(projectId), action = (context?.coordinator.state.actions ?? project.initiativeRuntime?.sdkState?.actions ?? []).find(action => action.id === actionId);
    if (!action) fail('后台行动不存在', 'action_not_found', 404);
    if (action.status !== 'needs_review') fail('只有未决后台行动需要明确结果确认', 'invalid_resolution', 409);
    if (context && (context.coordinator.active.size || context.coordinator.unsettled.size || context.activeHandles.size || context.coordinator.resolvingExecutions.size)) fail('后台操作仍在运行或清理，不能提前确认结果', 'action_still_running', 409);
    const explanation = summary.trim(); let resolved;
    if (context) resolved = await context.coordinator.resolveAction(actionId, { status, summary: explanation, source: 'user' });
    else resolved = this.mutate(state => {
      const target = state.projects.find(project => project.id === projectId).initiativeRuntime.sdkState.actions.find(action => action.id === actionId);
      if (target.blocksExecution === true) state.projects.find(project => project.id === projectId).initiativeRuntime.sdkState.decisionRevision = -1;
      Object.assign(target, { status: status === 'completed' ? 'completed' : 'cancelled', ...(status === 'cancelled' ? {} : { resultSummary: explanation }), resolutionOutcome: status, resolutionSummary: explanation, resolvedAt: this.now(), resolutionSource: 'user' });
      return copy(target);
    });
    this.mutate(state => {
      const target = state.projects.find(project => project.id === projectId), job = target.jobs.find(job => job.id === actionId);
      if (job) Object.assign(job, { status: status === 'completed' ? 'completed' : 'cancelled', ...(status === 'cancelled' ? {} : { output: `用户已核对结果：${explanation}` }), resolutionOutcome: status, resolutionSummary: explanation, resolvedAt: new Date(this.now()).toISOString(), resolutionSource: 'user' });
    });
    // The verified outcome may justify a new decision, without replaying old
    // commands, inventing evidence, or unpausing a project.
    this.schedule();
    return resolved;
  }
  invalidate() {
    // Do not wait for the asynchronous pump to finish a provider request before
    // noticing an interruption. Store notifications revoke it synchronously.
    for (const context of this.contexts.values()) {
      if (!this.valid(context)) { context.judgeAbort?.abort(); context.coordinator.interrupt('project_unavailable_or_changed'); continue; }
      // A narrower saved background permission stops the decision and running work, and cancels queued model work (the
      // runtime already refuses each tool call the grant no longer covers); receipts stay. A wider one changes nothing here.
      const grant = backgroundGrant(this.project(context.projectId));
      if (grant < (context.backgroundGrant ?? grant)) { context.judgeAbort?.abort(); context.coordinator.interrupt('project_permission_reduced'); }
      context.backgroundGrant = grant;
      this.syncMembership(context, { stopOnly: true });
      for (const action of context.coordinator.state.actions.filter(row => row.hostSchedule && row.status === 'running')) if (!this.scheduleActionCurrent(context, action)) context.coordinator.active.get(action.id)?.controller.abort(error('Schedule or its destination was revoked', 'schedule_revoked'));
      if (this.foregroundBusy(context.projectId)) this.interruptBackgroundWriters(context);
      if (context.initialized) {
        // A running foreground turn's own messages and writes wake nothing (PDL-2): the pump observes them; only
        // independent evidence stops a judgment or decision in flight and reviews at once.
        const project = this.project(context.projectId), fresh = this.sources(project, context.scope).filter(source => source.type !== 'schedule_state' && !context.sources.has(source.id));
        const owned = fresh.length ? this.leaseOwnedIds(project, this.progressLease(context.projectId, context.coordinator.state).owners) : null;
        if (fresh.some(source => !owned.has(source.id))) {
          context.judgeAbort?.abort();
          context.coordinator.invalidateDecision('new_project_evidence'); context.notBefore = 0; context.progressHold = null;
        }
      }
      if (!this.project(context.projectId).evolution.enabled) for (const action of context.coordinator.state.actions) if (action.action === 'learn') context.coordinator.active.get(action.id)?.controller.abort(error('Learning is paused', 'learning_paused'));
    }
  }
  schedule() {
    if (this.closed || this.scheduled || this.now() < (this.retryPumpAt ?? 0)) return;
    this.scheduled = true;
    // Immediately settled decisions/notifications can schedule another pump.
    // A microtask chain never gives timers, HTTP or cancellation IO a turn.
    // Revocation still happens synchronously in invalidate(); only projection
    // and the next review wait for the event loop's next check phase.
    this.scheduleHandle = setImmediate(() => { this.scheduleHandle = null; this.scheduled = false; if (this.closed) return; if (this.pumping) { this.again = true; return; } this.pendingPump = this.pump().catch(failure => { this.lastPumpError = failure.code ?? 'scheduler_persistence_error'; this.retryPumpAt = this.now() + 30000; }); });
  }
  model(project) { const model = resolveModel(this.store.state.configuration, project.initiative?.modelSelection ?? null); if (model.usagePolicy === 'interactive_only') throw error('订阅仅支持交互式使用；主动协作请配置开放平台 API 模型。', 'interactive_subscription_only'); return model; }
  redactValues() {
    const configuration = this.store.state.configuration, capabilities = this.store.state.capabilities ?? {};
    const environments = [...(configuration.providers ?? []).map(provider => provider.apiKeyEnv), configuration.memory?.apiKeyEnv, ...[...(capabilities.tools ?? []), ...(capabilities.mcpServers ?? [])].flatMap(item => [...(item.envNames ?? []), ...Object.values(item.envMapping ?? {}), ...Object.values(item.headerEnv ?? {})])];
    return [...Object.values(this.store.configurationService.secrets ?? {}), ...(this.store.configurationService.secretValues?.() ?? []), ...environments.filter(Boolean).map(name => process.env[name])].filter(value => typeof value === 'string' && value);
  }
  learnReservation(project, model) { const genome = project.versions?.find(version => version.id === project.activeVersionId)?.bundle?.genome; return genome ? estimateProjectEvolutionBudget(genome, model) : 12000; }
  planning(projectId) { return this.store.state.sessions.some(session => session.projectId === projectId && !session.archivedAt && session.kind !== 'side' && session.mode === 'plan'); }
  foregroundBusy(projectId) { return this.store.state.sessions.some(session => session.projectId === projectId && !session.archivedAt && session.activeTurnId && (!session.turns.find(turn => turn.id === session.activeTurnId) || session.turns.find(turn => turn.id === session.activeTurnId).status === 'running')); }
  /**
   * PDL-2 progress lease: what is in progress for the project now, from code. `foreground`: the running turns of its
   * non-archived, non-side conversations ({ turnIds, sessionIds, startedAt, request }: the latest turn's request is the
   * text of its user item); `work`: SDK work and learning actions queued or running ({ id, status, intent }); `key`: changes
   * when a turn starts or ends (completed, failed, stopped, paused) or a work action is queued or settles (a queued run
   * starting does not change it), null when nothing is in progress.
   * A turn waiting on the user (its ask_user question or permission card is open) is not working: it is not in progress
   * here, so it holds nothing, however long the user takes. The lease's bound is that evidence, not a clock: the turn
   * either works (and ends with its conversation_result) or waits on the user (and releases the lease until it works again).
   * It still owns its own messages and writes (`owners`: the working and the waiting turns), so an answer typed into the
   * conversation is that turn's, not independent evidence.
   */
  progressLease(projectId, live = this.contexts.get(projectId)?.coordinator?.state) {
    const turns = [], waiting = [];
    for (const session of this.store.state.sessions) {
      if (session.projectId !== projectId || session.archivedAt || session.kind === 'side' || !session.activeTurnId) continue;
      const turn = session.turns?.find(row => row.id === session.activeTurnId);
      if (turn?.status === 'running') (waitingOnUser(session, turn) ? waiting : turns).push({ session, turn });
    }
    const owning = [...turns, ...waiting], owners = owning.length ? { turnIds: owning.map(row => row.turn.id), sessionIds: owning.map(row => row.session.id) } : null;
    const startedAt = row => Date.parse(row.turn.attemptStartedAt ?? row.turn.createdAt ?? '');
    const latest = [...turns].sort((a, b) => (startedAt(a) || 0) - (startedAt(b) || 0)).at(-1);
    const request = latest ? latest.session.items?.findLast(item => item.id === latest.turn.userItemId)?.text ?? '' : '';
    const foreground = turns.length ? { turnIds: turns.map(row => row.turn.id), sessionIds: turns.map(row => row.session.id), startedAt: Math.min(...turns.map(startedAt).filter(Number.isFinite)), request: bounded(request, 1200) } : null;
    if (foreground && !Number.isFinite(foreground.startedAt)) delete foreground.startedAt;
    const work = (live?.actions ?? []).filter(action => ['work', 'learn'].includes(action.action) && ['queued', 'running'].includes(action.status) && !action.contextRevoked && !action.sourceDeleted).map(action => ({ id: action.id, status: action.status, intent: bounded(action.title ? `${action.title}: ${action.content ?? ''}` : action.content, 600) }));
    const key = foreground || work.length ? hash(['progress-v1', [...(foreground?.turnIds ?? [])].sort(), work.map(row => row.id).sort()]).slice(0, 32) : null;
    return { foreground, work, key, owners };
  }
  /**
   * The fresh sources a running foreground turn owns (PDL-2), computed exactly: its own user messages (the request and
   * any steer: items stamped with its turn id) and a directory change whose every path is a file the turn itself wrote
   * with project_write / project_edit in the project folder (direct mode; a worktree turn writes elsewhere). They are
   * observed, but wake nothing: the turn's conversation_result does.
   */
  leaseOwnedIds(project, foreground) {
    const owned = new Set();
    if (!project || !foreground?.turnIds?.length) return owned;
    const turnIds = new Set(foreground.turnIds), written = new Set(), root = typeof project.workspace === 'string' ? resolve(project.workspace) : null;
    const relative = path => { if (!root || typeof path !== 'string' || !path.trim()) return null; const rel = relativePath(root, resolve(root, path.trim())); return !rel || rel === '..' || rel.startsWith(`..${sep}`) ? null : rel.split(sep).join('/'); };
    for (const session of this.store.state.sessions) {
      if (!foreground.sessionIds?.includes(session.id)) continue;
      // A turn's items follow its first user item: read back from the end until every running turn's start is passed.
      const items = session.items ?? [], starts = new Set(session.turns?.filter(turn => turnIds.has(turn.id)).map(turn => turn.userItemId) ?? []);
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (turnIds.has(item.turnId)) {
          if (item.kind === 'user') owned.add(`message:${item.id}`);
          if (!session.worktree && ['project_write', 'project_edit'].includes(item.tool?.name)) { const path = relative(item.tool.args?.path); if (path) written.add(path); }
        }
        if (starts.has(item.id)) { starts.delete(item.id); if (!starts.size) break; }
      }
    }
    if (written.size) for (const observation of project.observations ?? []) {
      const changes = observation.kind === 'workspace_change' && observation.data?.truncated !== true && Array.isArray(observation.data?.changes) ? observation.data.changes : [];
      if (changes.length && changes.length === (observation.data.totalChanges ?? changes.length) && changes.every(row => written.has(relative(row?.path)))) owned.add(`observation:${observation.id}`);
    }
    return owned;
  }
  /**
   * A foreground turn of a conversation working in the project folder itself (direct mode: no session worktree) is
   * running: it holds the folder, so a background worktree's apply waits for it (design §4.3). A session worktree's
   * turn does not hold it; side chats are read only.
   */
  directTurnRunning(projectId) { return this.store.state.sessions.some(session => session.projectId === projectId && !session.archivedAt && session.kind !== 'side' && !session.worktree && session.activeTurnId && (!session.turns.find(turn => turn.id === session.activeTurnId) || session.turns.find(turn => turn.id === session.activeTurnId).status === 'running')); }
  /**
   * Why a background worktree may not be applied to the project folder now: 'read_only' (background write access is
   * gone, the project is archived, emergency stop) or 'deferred' (a direct-mode turn holds the folder, plan mode,
   * maintenance); null when it may.
   */
  applyHold(projectId) {
    const project = this.project(projectId);
    if (!project || project.archivedAt || this.store.state.emergency || permissionLevel(project, 'background') === 'read') return 'read_only';
    return this.planning(projectId) || this.directTurnRunning(projectId) || this.store.maintenanceHeld ? 'deferred' : null;
  }
  /** Whether this project's background work runs in its own worktree (last known answer; design §8). */
  isolatedProject(projectId) { return this.background?.ready() === true && this.background.known(projectId); }
  /** A run of this action is in progress in this process. */
  liveRun(actionId) { return [...(this.contexts?.values() ?? [])].some(context => context.workRuns?.has(actionId)); }
  /**
   * The project as background work may use it now. Plan mode makes it read only; a running foreground turn does too,
   * except for a run in its own worktree (`isolated`), whose writes reach the project folder only when it is applied
   * after that turn (design §8).
   */
  backgroundProject(project, { isolated = false } = {}) { return project && (this.planning(project.id) || (!isolated && this.foregroundBusy(project.id))) ? { ...project, permissions: { ...project.permissions, background: 'read' } } : project; }
  /** A foreground turn takes over the project folder: writers working in it stop. A run in its own worktree goes on. */
  interruptBackgroundWriters(context) {
    for (const [id, run] of context.workRuns ?? []) if (run.writable && !run.isolated) { const reason = error('Foreground work has priority over background workspace mutations', 'foreground_started'); run.abort?.(reason); context.coordinator.active.get(id)?.controller.abort(reason); }
  }
  /** Drains background writers before a foreground turn writes. Returns what it stopped ({ id, task, handoff }) so the turn can say so and build on it. */
  async prepareForeground(projectId, { signal } = {}) {
    signal?.throwIfAborted();
    const context = this.contexts.get(projectId);
    // The refusal names the place the user can settle it (任务页 · 待核对) and carries the blocking action (C-g), so the
    // conversation can open that task instead of offering a retry that is refused again (F9, F84).
    let writing = [];
    const refuse = ({ draining = false } = {}) => { const actionId = (draining ? null : this.blockingAction(projectId, context)) ?? writing[0]?.[0]; return Object.assign(error(inLanguage(interfaceLanguageOf(this.store.state), draining
      ? { zh: '后台工作正在停下，还没确认结束；这一轮先没有改动工作区，稍后重试即可。', en: 'Background work is still stopping and has not confirmed it ended, so this turn has not touched the workspace. Retry in a moment.' }
      : { zh: '后台有一项工作的结果还没核对，这一轮先没有改动工作区。请到任务页 · 待核对确认它的结果，再重试这一轮。', en: 'A background task\'s result still needs checking, so this turn has not touched the workspace. Confirm it under Tasks · To verify, then retry this turn.' }), 'background_recovery_required'), { details: { ...(actionId ? { actionId } : {}), ...(draining ? { draining: true } : {}) } }); };
    const blocked = () => context?.coordinator._executionBlocked() || (this.project(projectId)?.initiativeRuntime?.sdkState?.actions ?? []).some(action => action.status === 'needs_review' && action.blocksExecution === true) || (this.project(projectId)?.jobs ?? []).some(job => job.lane === 'background' && ['uncertain_tool', 'process_cleanup_uncertain'].includes(job.errorCode) && !job.resolvedAt);
    if (blocked()) throw refuse();
    if (!context) return;
    // Only writers working in the project folder itself: a run in its own worktree goes on and is applied afterwards (design §8).
    writing = [...(context.workRuns?.entries() ?? [])].filter(([, run]) => run.writable && !run.isolated); const writers = writing.map(([, run]) => run);
    if (!writers.length) return [];
    const stopped = writing.map(([id]) => { const action = context.coordinator.state.actions.find(row => row.id === id); return { id, task: action ? this.actionName(this.project(projectId), action, { limit: 200, quoted: true }) : '', detail: String(action?.content ?? '').slice(0, 3000) }; });
    this.interruptBackgroundWriters(context);
    let timer, abort;
    try {
      await Promise.race([Promise.all(writers.map(run => run.settled)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(refuse({ draining: true })), this.foregroundDrainTimeoutMs);
        abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
      signal?.throwIfAborted();
      if (blocked() || writers.some(run => run.cleanupUncertain)) throw refuse();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    return stopped;
  }
  /** The action that holds the foreground back: one waiting to be checked, else one being settled, else an unconfirmed job. */
  blockingAction(projectId, context = this.contexts.get(projectId)) {
    const project = this.project(projectId), waiting = actions => actions?.findLast(action => action.status === 'needs_review' && action.blocksExecution === true)?.id;
    return waiting(context?.coordinator.state.actions) ?? [...(context?.coordinator.resolvingExecutions ?? [])][0] ?? waiting(project?.initiativeRuntime?.sdkState?.actions)
      ?? (project?.jobs ?? []).findLast(job => job.lane === 'background' && ['uncertain_tool', 'process_cleanup_uncertain'].includes(job.errorCode) && !job.resolvedAt)?.id ?? null;
  }
  /**
   * The privacy scope of a project's initiative (its identity, workspace and action contract; see
   * initiativePrivacyInputs). It identifies the coordinator's context: archives, receipts, `valid()`. `model` is not
   * part of it; it is accepted for the callers that pass it.
   */
  scope(project, _model) {
    // Frozen committed state keeps a project's identity until it changes, so an unchanged scope is not re-hashed.
    const cached = Object.isFrozen(project) ? this.scopeCache?.get(project) : null;
    if (cached) return cached;
    const value = hash(initiativePrivacyInputs(project));
    if (Object.isFrozen(project)) (this.scopeCache ??= new WeakMap()).set(project, value);
    return value;
  }
  /**
   * Whether a runtime saved before the split is from an earlier folder than the project's now, by the project's records
   * (workspaceHistory): it cites or has seen an observation of an earlier folder or identity (a version before the
   * split cleared both at every scope change, so it has not been rotated since), or it was last active no later than
   * one was last observed. A version before the split rotated its single hash at a folder move only while the
   * project's background ran (not while it was off or the project archived); such a runtime is adopted as a privacy
   * change, not as the same scope.
   */
  legacyFromPreviousFolder(project, sdk) {
    const history = workspaceHistory(project); if (!history.changed) return false;
    const cited = [...(sdk.seenEventIds ?? []), ...(sdk.events ?? []).map(event => event.id), ...(sdk.lastDecision?.evidenceIds ?? []), ...(sdk.actions ?? []).flatMap(action => action.evidenceIds ?? [])];
    if (cited.some(id => history.previous.has(id))) return true;
    const times = [sdk.lastDecision?.at, ...(sdk.events ?? []).map(event => event.at), ...(sdk.actions ?? []).flatMap(action => [action.createdAt, action.startedAt, action.finishedAt, action.updatedAt])].filter(Number.isFinite);
    return Number.isFinite(history.lastPrevious) && times.every(at => at <= history.lastPrevious);
  }
  /** The context drift identity: what a coordinator froze when it was built (initiativeDriftInputs). */
  drift(project, model) {
    const state = this.store.state, frozen = Object.isFrozen(project) && Object.isFrozen(state.configuration) && (state.capabilities === undefined || Object.isFrozen(state.capabilities));
    const cached = frozen ? this.driftCache?.get(project) : null;
    if (cached && cached.configuration === state.configuration && cached.capabilities === state.capabilities) return cached.value;
    const value = hash(initiativeDriftInputs(this.store, project, model));
    if (frozen) (this.driftCache ??= new WeakMap()).set(project, { configuration: state.configuration, capabilities: state.capabilities, value });
    return value;
  }
  /**
   * Context drift (a model, credential or output-cap change, a new version, an assignment or capability change of this
   * project): refresh what the coordinator froze when it was built (its model and credential, the planning
   * capabilities) in place. Events, receipts, handoffs, queued and running work are kept; whether the change is worth a
   * new decision is left to the evidence, the pacing and the JEV gate as for anything else.
   */
  async refreshDrift(context, project, model) {
    const drift = this.drift(project, model);
    if (context.drift === drift || context.refreshing) return false;
    // A context built without a drift baseline (create() always records one) adopts the current one.
    if (context.drift === undefined) { context.drift = drift; return false; }
    context.refreshing = true;
    try {
      const provider = this.store.state.configuration.providers.find(row => row.id === model.providerId);
      const planningCapabilities = this.scheduleService?.agentView && this.scheduleService?.applyInitiativeAction ? await this.planningCapabilities(project) : null;
      if (!provider || !this.valid(context, { enabled: false }) || context.closing) return false;
      const apiKey = this.store.configurationService.secret(provider.id, provider);
      context.planningCapabilities = planningCapabilities;
      context.coordinator.updateModel({ model, apiKey, redactValues: this.redactValues(), decisionMaxTokens: model.maxOutputTokens });
      context.drift = drift;
      return true;
    } catch (failure) {
      // A refresh that cannot complete now leaves the coordinator as it was and is tried again on the next pump.
      context.lastErrorCode = failure?.code ?? 'context_refresh_failed';
      return false;
    } finally { context.refreshing = false; }
  }
  /**
   * A conversation archived or restored: what it fed is withdrawn from (or returned to) the model's context in this
   * project's coordinator (applyConversationMembership); running work citing it stops. Nothing else is touched.
   * Returns whether the coordinator state changed (the caller persists it).
   */
  syncMembership(context, { stopOnly = false } = {}) {
    const coordinator = context.coordinator, sessions = this.store.state.sessions.filter(session => session.projectId === context.projectId && session.kind !== 'side');
    const key = sessions.filter(session => session.archivedAt).map(session => session.id).sort().join(',');
    // A context built without a membership baseline (create() always records one) adopts the current one.
    if (context.archivedKey === undefined) { context.archivedKey = key; return false; }
    if (stopOnly) {
      // Synchronous (store notifications): stop running work that cites a newly archived conversation; the state follows in pump().
      if (key === context.archivedKey) return false;
      // A decision in flight may still read what the conversation fed; it is decided again once the state follows.
      context.judgeAbort?.abort(); coordinator.invalidateDecision('source_session_archived');
      const archived = sessions.filter(session => session.archivedAt).map(conversationEvidence);
      for (const action of coordinator.state.actions) if (action.status === 'running' && archived.some(evidence => (action.evidenceIds ?? []).some(id => citesConversation(evidence, id)))) coordinator.active.get(action.id)?.controller.abort(error('The conversation this work came from was archived', 'source_session_archived'));
      return false;
    }
    if (key === context.archivedKey && !context.membershipPending) return false;
    if (context.reviewPromise || coordinator.ticking) return false;
    if (key !== context.archivedKey) coordinator.invalidateDecision('source_session_archived');
    const { changed: withdrawn, running, ended } = applyConversationMembership(coordinator.state, sessions, this.project(context.projectId)?.jobs, this.now());
    // A restored conversation is observed again by the next bounded sources() pass (its seen ids go).
    const before = new Set(context.archivedKey.split(',').filter(Boolean)), seen = coordinator.state.seenEventIds.length;
    forgetRestoredConversations(coordinator.state, sessions.filter(session => !session.archivedAt && before.has(session.id)));
    const changed = withdrawn || coordinator.state.seenEventIds.length !== seen;
    for (const id of running) coordinator.active.get(id)?.controller.abort(error('The conversation this work came from was archived', 'source_session_archived'));
    // A run still stopping is withdrawn once it has ended.
    context.membershipPending = running.length > 0; context.archivedKey = key;
    for (const action of ended) try { this.endPausedLine(context, { ...action, status: 'cancelled', cancellationReason: 'source_session_archived' }, 'source_session_archived'); } catch { /* the line is a courtesy */ }
    return changed;
  }
  /** Whether an archived seen-source receipt exists for this context (its scope, or the pre-split scope it adopted). */
  seenArchived(projectId, id, context) {
    return this.archivedSource(projectId, id, context.scope, { legacy: context.terminalSourceIdentity?.legacyArchiveScope === context.scope })
      || Boolean(context.legacySourceHash && context.legacySourceHash !== context.scope && this.archivedSource(projectId, id, context.legacySourceHash));
  }
  async planningCapabilities(project) {
    // Inspect declarations only: no tool execution, file content inspection or
    // MCP process startup merely to decide what work might be useful.
    const selected = new Set(project.assignments?.toolIds ?? []);
    let registry, status = 'declared', declarations = [];
    const descriptor = tool => ({ id: tool.id ?? tool.name, name: tool.name, description: bounded(tool.description, 2000), permission: tool.permission ?? (tool.effect === 'read' ? 'read' : 'write'), effect: tool.effect ?? (tool.permission === 'read' ? 'read' : 'write'), enabled: tool.enabled === true, trusted: tool.trusted === true });
    try {
      ({ registry } = await this.capabilities.registry(project, this.memoryTools(project.id), { connectIds: [], includeMutations: true }));
      declarations = [...registry.tools.values()].filter(tool => selected.has(tool.id)).map(descriptor);
      const bundle = project.versions?.find(version => version.id === (project.trialVersionId ?? project.activeVersionId))?.bundle;
      if (bundle) declarations.push(...createGenomeTools(bundle.genome, { namespace: genomeIdentity(project.id), workspace: projectWorkspace(project.workspace) }).filter(tool => selected.has(tool.id ?? tool.name)).map(descriptor));
    } catch { status = 'partially_unavailable'; }
    finally { await registry?.close(); }
    // Memory declarations remain known when the workspace itself is unavailable.
    for (const tool of this.memoryTools(project.id)) if (selected.has(tool.id ?? tool.name) && !declarations.some(row => row.id === (tool.id ?? tool.name))) declarations.push(descriptor({ ...tool, enabled: true, trusted: true }));
    const config = this.capabilities.configuration?.() ?? this.store.state.capabilities ?? {};
    return { status, tools: declarations, unresolvedToolIds: [...selected].filter(id => !declarations.some(row => row.id === id)), mcpServers: (config.mcpServers ?? []).filter(row => project.assignments?.mcpServerIds?.includes(row.id)).map(row => ({ id: row.id, name: row.name ?? row.id, description: bounded(row.description, 2000), enabled: row.enabled === true, trusted: row.trusted === true, discovery: 'not_performed_by_planner' })), workspaceState: 'not_inspected_by_planner', evidenceBoundary: 'These are actual tool declarations, not tool execution results or proof of external service availability. Unread files and directories have unknown contents; absence from this snapshot does not mean an empty workspace. MCP tools without discovered declarations have unverified capabilities. Use permitted reads to verify concrete prerequisites; do not infer capabilities from a tool name.' };
  }
  /**
   * The decision snapshot. `eventIds` (carriedEventIds of the coordinator's current evidence events) and `liveActions` (its
   * actions) let each turn and action appear once in the request (TC-3): turns the events carry are referenced, receipts
   * the SDK sends as recentActions are slim, the conversation messages those events hold and work summaries the request
   * already carries are left out. Any observation between this snapshot and the tick makes the tick stale, so the
   * references cannot dangle.
   */
  snapshot(project, model, planningCapabilities, { eventIds = null, liveActions = null } = {}) {
    // Projection is also used by read-only hosts without a scheduler clock.
    // Sample once so the clock, due views and learning gate share one instant.
    const snapshotAt = typeof this.now === 'function' ? this.now() : Date.now();
    const rhythmStatus = projectRhythmStatus(this.store.state, project, { now: snapshotAt });
    const sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
    const pendingRetry = retryOwned(sessions), sent = liveActions ? sentReceiptIds(liveActions) : null;
    // Messages the request carries in an evidence event: those a turn's conversation_result holds.
    const carried = eventIds ? heldMessages(sessions.flatMap(session => session.turns.filter(turn => ['completed', 'failed'].includes(turn.status) && eventIds.has(terminalSourceId(project, turn))).map(turn => ({ session, turn })))) : null;
    const recentConversation = withoutHeld(recentMessages(sessions, pendingRetry), carried);
    // Select bounded metadata first; do not rescan every conversation item for
    // every historical turn on each scheduler tick.
    const trajectory = trajectoryOf(sessions, pendingRetry);
    // The user's undos (rollbacks, drops, reverts, discards), derived from the records: context for this review and
    // for background work, never evidence (sources() does not see them), so an undo wakes nothing by itself.
    const reversions = deriveWorkspaceEvents(this.store.state, project, { since: snapshotAt - SNAPSHOT_HORIZON_MS }), workspaceEvents = snapshotWorkspaceEvents(reversions);
    const continuity = continuityView(project, sessions, { reversions, trajectory, pendingRetry, eventIds, sent, redactValues: this.redactValues?.() ?? [], block: WINDOW_BLOCK });
    const enabled = realProject(project) && project.initiative.enabled && !this.store.state.emergency;
    const access = workAccess(project, sessions, { isolatedWork: typeof this.isolatedProject === 'function' && this.isolatedProject(project.id) }), { backgroundLevel } = access;
    const learnNotBefore = autonomousLearningNotBefore(project), learningReady = snapshotAt >= learnNotBefore;
    const learning = this.independentLearning ? null : learningStatus(project, { model, now: snapshotAt, running: this.evolutionService?.running?.has(project.id) === true, redactValues: this.redactValues?.() ?? [] });
    const actionContracts = {
      wait: { enabled: true, purpose: 'Wait when there is no useful evidence-backed action or a real prerequisite is missing. Waiting is allowed; do not manufacture activity.' },
      work: workContract({ enabled, ...access }),
      learn: { enabled: !this.independentLearning && enabled && project.evolution.enabled && !learning.evaluationInFlight && !project.trialVersionId && Boolean(project.versions?.find(version => version.id === project.activeVersionId)?.bundle), authorization: 'When enabled, the project has already authorized evidence-based isolated candidate generation and evaluation; no additional permission to start user-code development is needed for this action.', scope: 'Improve this project agent method, system prompt, skills or automation tools using relevant evidence and a testable hypothesis, then execute real baseline/candidate evaluation against frozen baseline standards. Work advances the project deliverable; learn improves how the agent performs that work. Consult project.learningStatus for prior attempts and evidence coverage.', effects: 'Candidate files and evaluations use managed versions and temporary workspaces. This does not edit the user workspace, adopt a version, deploy code or grant new host tools. A passing candidate may later be offered for user trial.', prerequisites: 'New relevant evidence under the current baseline, model and evaluation method, no current trial or concurrent evolution, and available budget. Do not repeat failed experiments from their own receipts. An elapsed interval or nonzero uncovered evidence count does not require learning; wait when no worthwhile, evaluable change is supported. Pending subjective user feedback blocks only judgments that depend on that feedback, not isolated method improvements supported by existing tool evidence. A work summary is not verified tool output; inspect project_history when the original evidence is needed. User requests to pause learning must be respected.' },
      share: { enabled, authorization: 'Proactive communication in the existing project conversation is authorized when there is a useful new finding; no new user command or Goal is required.', scope: 'Convey a useful result or evaluated candidate invitation without claiming unexecuted work. Consult communication for actual delivery receipts. A completed investigation is not automatically a delivered finding. Use ask for a decision or confirmation requiring an answer.', effects: 'Append one independent message without stopping or replacing the current foreground reply. Foreground activity does not forbid a useful new finding. Typing, quiet periods, mute and cooldown still defer delivery. Avoid duplicating what the foreground already conveyed; avoid status pings or automatically sharing every result.' },
      ask: { enabled: enabled && Boolean(this.interactions), scope: 'Ask a necessary question as interactive choices in the project conversation. Set questions for ordinary choices, or permissionRequest for a concrete workspace/background grant; never both. Users are not always experts: when evidence shows the approach the user asked for is clearly worse than an alternative they may not know (quality, cost, time or risk), propose it as a choice between adopting the better approach (say what it is, why, and what it costs) and keeping the original plan, and keep following the original plan until the user chooses.', effects: 'Append one nonblocking question card while foreground work continues. Wait if an existing foreground or proactive question is still answerable; ordinary foreground execution alone is not a reason to defer. Only delivers a pending question. It does not mean the user answered or authorized work. Ordinary answers never grant permissions. Permission questions are generated by the host with fixed allow/deny choices. Do not repeat pending questions or request already-granted scope.', pending: sessions.flatMap(session => session.items.filter(answerableInteraction).map(item => ({ id: item.interaction.id, kind: item.interaction.kind, questions: item.interaction.questions, status: item.interaction.status }))).slice(-8) }
    };
    const scheduleContext = typeof this.scheduleService?.agentView === 'function' && typeof this.scheduleService?.applyInitiativeAction === 'function' ? this.scheduleService.agentView(project.id) : null;
    if (rhythmStatus.control === 'auto') actionContracts.rhythm = { enabled: true, schemaVersion: 1, requiresAssessment: rhythmStatus.assessmentRequired,
      purpose: 'Assess this project phase and useful collaboration cadence inside this same decision, from the actual evidence, user intent and registered responsibilities. This is not a request for a separate monitoring call. Respect manual disable switches and task edits. Daily reports normally need a registered daily responsibility and event-only communication between real results; completed or blocked work can rest until changed evidence. An active development project may need continued work. Adjust learning to genuine unreviewed experience, not the passage of time. Counts are admitted automatic reflection batches in rolling 24-hour and 7-day windows, including failed/no-change reviews; they are not version promises. A recurring phase with no registered duty must not be called scheduled: create or repair the supported responsibility in this decision when warranted. Never infer workspace quality or completion from a self-written summary alone.' };
    // permittedForBackground is under the saved background permission (stable), not the level in force: plan mode or a
    // running turn narrows that to read at the request tail (hostConditions.work.backgroundLevel), which says what remains.
    const savedLevel = access.access.effective.background;
    const capabilityContext = scheduleContext && planningCapabilities ? { ...copy(planningCapabilities), tools: planningCapabilities.tools.map(tool => ({ ...tool, permittedForBackground: tool.enabled && tool.trusted && toolPermitted({ ...project, permissions: { ...project.permissions, workspace: savedLevel, background: 'inherit' } }, tool, 'background') })), backgroundPermission: CAPABILITY_LEVEL_NOTE } : null;
    // TC-3: the schedule records are sent once, as project.schedules (the SDK validates them there); scheduleContext keeps the rest.
    if (scheduleContext) actionContracts.schedule = { schemaVersion: 1, enabled: enabled && scheduleContext.destinations.length > 0, authorization: scheduleContractText(schedulePromptVersionOfStore(this.store)).authorization, scope: scheduleContractText(schedulePromptVersionOfStore(this.store)).scope, effects: 'Save a versioned task and a durable action receipt. Does not perform the task, send a message, grant tools or claim delivery. The existing occurrence runtime enforces current permissions, budget and notification policy.', destinationSessionIds: scheduleContext.destinations.map(row => row.sessionId ?? row.id) };
    const scheduleView = scheduleContext ? (({ schedules: _sent, ...rest }) => rest)(scheduleContext) : null;
    // P3: the writing contract and tiered reach are host opt-ins read by the SDK prompt/schema.
    Object.assign(actionContracts.share, { messageContract: 1, reach: { enabled: true, tiers: REACH_TIERS.filter(tier => tier !== 'notify' || project.initiative?.desktopNotifications === true), notificationsMuted: project.initiative?.notificationMuted === true, quietNow: Boolean(project.initiative?.quietUntil && Date.parse(project.initiative.quietUntil) > snapshotAt) } });
    if (this.independentLearning) delete actionContracts.learn;
    else Object.assign(actionContracts.learn, { enabled: actionContracts.learn.enabled && learningReady, minIntervalMs: project.evolution.minIntervalMs ?? PROJECT_SCHEDULE_DEFAULTS.minIntervalMs, nextAllowedAt: learnNotBefore || null });
    if (this.decisions?.enabled('initiative.review') || this.decisions?.enabled('evolution.review') || this.decisions?.enabled('chat.preflight')) {
      const policy = validJudgmentPolicy(project), authoredAt = Date.parse(project.judgmentPolicy?.source?.createdAt ?? '');
      // The plan is authored when missing or stale, and revisited when a rhythm re-assessment is due or it is a week old.
      // Every other wake says the plan is not accepted and carries no plan: the model answers with the decision alone
      // (the plan was the bulk of a 6k-token answer on every wake in production), and the foreground tool can still revise it.
      const revisit = !policy || rhythmStatus.assessmentRequired === true || !Number.isFinite(authoredAt) || snapshotAt - authoredAt >= JUDGMENT_PLAN_REVISIT_MS;
      // Declared on every wake, so the decision system prompt (which carries the authoring guidance) stays byte-stable;
      // whether this wake accepts a plan is `enabled`, which the SDK sends with requiresAssessment, revision and the plan
      // in hostConditions at the request tail (live: the guidance flipped the system prompt hash on revisit wakes).
      actionContracts.judgment = { enabled: revisit, requiresAssessment: !policy, revision: project.judgmentPolicy?.revision ?? null, ...(revisit && policy ? { existingPlan: policy.plan } : {}), purpose: 'Project-specific questions, candidate options and scoring anchors that JEV scores, authored or maintained by the main model inside a normal decision response, only when hostConditions.judgment.enabled is true (offered when the plan is missing, the rhythm needs re-assessment, or weekly). JEV only scores these pre-existing options. This cannot grant permissions, create duties, suppress due work, complete the project or accept an evolution.' };
    }
    const identity = projectIdentity(project);
    return cacheOrdered({ id: identity.id, title: identity.title, ...(rhythmStatus.control === 'auto' ? { rhythmStatus: { control: 'auto', assessment: rhythmStatus.assessment, assessmentSourceIds: rhythmStatus.assessmentSourceIds, initiativeReason: rhythmStatus.initiative.reason, evolution: { reason: rhythmStatus.evolution.reason, nextAt: rhythmStatus.evolution.nextAt, quota: rhythmStatus.evolution.quota } } } : {}), clock: { now: new Date(snapshotAt).toISOString() }, ...(capabilityContext ? { capabilityContext } : {}), ...(scheduleContext ? { scheduleContext: scheduleView, schedules: scheduleContext.schedules, scheduleDeliveryPolicy: `Use schedule for a justified durable responsibility; the runtime owns due windows and unique delivery. Review intervals do not register tasks. Respect manual edits, disabled records and cancelled purpose keys. ${SCHEDULE_MUTE_POLICY}` } : {}), ...((!scheduleContext && (project.schedules?.length || project.scheduleRuntime)) ? { schedules: (project.schedules ?? []).slice(0, 32).map(row => projectScheduleView(row, snapshotAt)), scheduleDeliveryPolicy: `Registered occurrences are executed and delivered by the host once. Do not duplicate an occurrence with generic work/share or infer a timer from a prose promise. A wait interval is only a review cadence, never a registered recurring delivery. If a recurring request has no registered schedule, name that actual missing setup; do not claim it is scheduled. ${SCHEDULE_MUTE_POLICY}` } : {}), description: identity.description, overview: identity.overview, focus: identity.focus, constraints: identity.constraints, openQuestions: identity.openQuestions, milestones: identity.milestones, assignments: copy(project.assignments ?? {}), actionContracts, ...(workspaceEvents ? { workspaceEvents } : {}), recentConversation, continuity, communication: communicationStatus(project, sessions, snapshotAt, { sent, eventIds }), pendingJobs: (project.jobs ?? []).filter(job => !job.simulated && ['running', 'queued'].includes(job.status)).slice(-4).map(job => ({ id: job.id, kind: job.kind, instruction: bounded(job.instruction, 300) })), ...(!this.independentLearning ? { learningEnabled: project.evolution.enabled, learningStatus: learning } : {}), projectVersion: (() => { const version = project.versions?.find(item => item.id === (project.trialVersionId ?? project.activeVersionId)); const genome = version?.bundle?.genome; return genome ? { id: version.id, hash: version.bundle.hash, skills: genome.skills.map(({ id, name, description }) => ({ id, name, description })), tools: genome.tools.map(({ id, name, description, permission }) => ({ id, name, description, permission })) } : null; })(), ...(!this.independentLearning ? { learningPolicy: 'Use actionContracts to distinguish authorized isolated learning from changes to user code. When learningEnabled is false, do not select learn. Only ready candidates with gatePassed evaluations can be offered for trial. A failed/rejected candidate is evidence, not improvement; do not repeatedly learn from your own failures without new external evidence.' } : {}),
      // Last: the project mind. Background-run handoffs are not repeated here: the receipts (recentActions, actionReceipts)
      // carry each one (TC-3); only a handoff neither carries is listed, and the end time of one only recentActions carries.
      ...(handoffs => handoffs.length ? { handoffs } : {})(uncarriedHandoffs(project, { sent, block: WINDOW_BLOCK })), ...(view => view ? { mind: view } : {})(mindBackgroundView(project, { now: snapshotAt })) });
  }
  /**
   * What a background worker reads (TC-2), instead of the decision snapshot (whose capability, schedule, communication,
   * learning and judgment parts only a decision uses). `stable`: what stays the same from run to run (identity, goal, the
   * work authorization, scope and saved permissions), sent once after the shared prefix as the `project-brief` context, so
   * consecutive runs share [system, tools, catalogue, orientation, brief]. `volatile`: this run's conditions, the
   * conversation and work so far (turns the run's evidence carries are referenced as `{ evidence: id }`), the recent
   * messages and handoffs nothing else here carries, pending jobs, and the lessons the decision snapshot's mind recalls
   * for the project's name and focus that the run's own project-mind attachment (recalled for its task, `query`) lacks.
   * Only duplicates and decision-only parts are left out. `own` (scheduledRunOwn: a scheduled run's id and occurrence
   * message, T3): the run's own receipt and pending job, and the task text of earlier runs' receipts, are not repeated.
   * `copy` (W1): the run is in its own worktree (work() was given one); only then the stable part says so (`work.workspace`).
   */
  workerBrief(project, { evidence = [], query = '', own = null, copy = false } = {}) {
    const snapshotAt = typeof this.now === 'function' ? this.now() : Date.now();
    const sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
    const pendingRetry = retryOwned(sessions), trajectory = trajectoryOf(sessions, pendingRetry);
    const reversions = deriveWorkspaceEvents(this.store.state, project, { since: snapshotAt - SNAPSHOT_HORIZON_MS }), workspaceEvents = snapshotWorkspaceEvents(reversions);
    const enabled = realProject(project) && project.initiative.enabled && !this.store.state.emergency;
    const progressAccess = workAccess(project, sessions, { isolatedWork: typeof this.isolatedProject === 'function' && this.isolatedProject(project.id) }), work = workContract({ enabled, ...progressAccess }, { levelAt: WORKER_LEVEL_AT, inCopy: copy === true }), { access } = progressAccess;
    const stable = { ...projectIdentity(project), work: { authorization: work.authorization, scope: work.scope, continuation: work.continuation, ...(work.workspace ? { workspace: work.workspace } : {}), permissions: { settings: access.settings, workspace: access.workspace, revision: access.revision, inheritedAssignments: access.inheritedAssignments, description: access.description } } };
    const mind = workerMindLessons(project, { now: snapshotAt, query, attached: typeof this.store.mind?.backgroundContext === 'function' });
    const volatile = { clock: { now: new Date(snapshotAt).toISOString() }, work: { backgroundLevel: progressAccess.backgroundLevel, effects: work.effects, ...(work.planning ? { planning: true } : {}), ...(work.foregroundBusy ? { foregroundBusy: true } : {}), effective: progressAccess.effective }, ...(workspaceEvents ? { workspaceEvents } : {}),
      // Only the recent messages no turn below holds (whole, or in the run's evidence): usually none.
      ...(messages => messages.length ? { recentConversation: messages } : {})(withoutHeld(recentMessages(sessions, pendingRetry), heldMessages(trajectory.slice(-4)))),
      continuity: continuityView(project, sessions, { reversions, trajectory, pendingRetry, eventIds: carriedEventIds(evidence), redactValues: this.redactValues?.() ?? [], own }),
      ...(handoffs => handoffs.length ? { handoffs } : {})(uncarriedHandoffs(project)),
      // A scheduled run's own pending job is its message again (its first 300 characters): cut after the window, like its receipt.
      pendingJobs: (project.jobs ?? []).filter(job => !job.simulated && ['running', 'queued'].includes(job.status)).slice(-4).filter(job => !(own && job.id === own.actionId && job.instruction === own.occurrence.content)).map(job => ({ id: job.id, kind: job.kind, instruction: bounded(job.instruction, 300) })), ...(mind ? { mind } : {}) };
    return { stable, volatile };
  }
  sources(project, _scope) {
    const rows = [{ id: projectStateSourceId(project), type: 'project_state', summary: bounded(JSON.stringify({ title: project.name, overview: project.overview, focus: project.focus, openQuestions: project.openQuestions }), 3000), at: this.now() }];
    for (const session of this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side')) {
      // A failed request awaiting the user's retry stays observable (diagnosis, learning) and says whose it is; a message citing it is not delivered.
      const pending = awaitingUserRetry(session)?.id;
      for (const item of session.items.filter(item => item.kind === 'user' && !item.sourceDeleted && !item.contextRevoked).slice(-12)) rows.push({ id: `message:${item.id}`, type: 'user_message', summary: bounded(item.text), at: Date.parse(item.createdAt) || this.now() });
      for (const turn of terminalTurns(session)) {
        const context = cachedTurnContext(session, turn);
        const summary = JSON.stringify({ sessionId: session.id, turnId: turn.id, status: turn.status, final: context.final, tools: context.tools, requests: context.requests, omitted: context.omitted, detailsTool: 'project_history', ...(turn.id === pending ? { awaitingUserRetry: RETRY_OWNED } : {}) });
        rows.push({ id: terminalSourceId(project, turn), type: 'conversation_result', summary: bounded(summary, 10000), at: Date.parse(turn.completedAt) || Date.parse(turn.createdAt) || 0 });
      }
    }
    const directorySource = project.observationSources?.find(row => row.id === 'workspace');
    const observations = (project.observations ?? []).filter(item => !['withdrawn', 'superseded'].includes(item.status) && !item.data?.messageId && !item.simulated &&
      (item.kind !== 'workspace_change' || !directorySource?.identityRevoked && item.data?.source?.bindingId === hash([project.id, resolve(project.workspace)]) && item.data?.source?.revision === (directorySource?.sourceRevision ?? 1)));
    const awaitingReceipt = observations.filter(row => row.kind === 'workspace_change' && !row.data?.runtimeReceipt).slice(0, 8);
    for (const observation of [...new Map([...observations.slice(-12), ...awaitingReceipt].map(row => [row.id, row])).values()]) {
      // External filenames are data, not instructions, authorization, verified
      // file contents, proof of quality, or a reason to notify/evolve by default.
      const summary = observation.kind === 'workspace_change' ? JSON.stringify({
        evidenceType: 'workspace_metadata', trust: 'untrusted', instruction: false,
        interpretation: 'Only file metadata changed. Inspect relevant files using existing permissions before drawing conclusions. Decide whether to work, wait or communicate from project context; a file change alone does not require a message or evolution.',
        summary: bounded(observation.text), changes: (observation.data?.changes ?? []).slice(0, 32).map(row => ({ path: row.path, change: row.change })),
        totalChanges: observation.data?.totalChanges, truncated: observation.data?.truncated,
      }) : bounded(observation.text);
      rows.push({ id: `observation:${observation.id}`, type: observation.kind, summary, at: Date.parse(observation.createdAt) || this.now() });
    }
    if (typeof this.scheduleService?.agentView === 'function') {
      // This is versioned planning state, not a newly discovered outside fact.
      // Exclude the advancing due clock and occurrence cursor from its identity.
      const view = this.scheduleService.agentView(project.id);
      const metadata = { schedules: view.schedules.map(row => ({ id: row.id, purposeKey: row.purposeKey, revision: row.revision, enabled: row.enabled, source: row.source, lastEditedBy: row.lastEditedBy })), cancelled: view.cancelled };
      rows.push({ id: `schedule-state:${hash(metadata).slice(0, 48)}`, type: 'schedule_state', summary: bounded(JSON.stringify(metadata), 8000), at: this.now() });
    }
    const awaitingIds = new Set(awaitingReceipt.map(row => `observation:${row.id}`));
    // Drain older durable arrivals too; newer chat traffic must not permanently
    // hide an accepted directory batch behind the recent-context window.
    const awaiting = rows.filter(row => awaitingIds.has(row.id));
    return [...rows.filter(row => !awaitingIds.has(row.id)).sort((a, b) => a.at - b.at).slice(-(24 - awaiting.length)), ...awaiting];
  }
  presence(project) {
    const raw = this.store.presences?.get(project.id);
    const live = raw && Date.parse(raw.expiresAt) > this.now() ? raw : null;
    const sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
    const session = (live?.visible ? sessions.find(session => session.id === live.sessionId) : null) ?? sessions.find(session => session.id === project.primarySessionId) ?? sessions[0];
    if (live?.visible) this.lastSeen.set(project.id, this.now());
    return { session, visible: Boolean(live?.visible), conversationAvailable: Boolean(session), allowInterleavedShare: true, allowInterleavedAsk: true, pendingQuestion: sessions.some(session => session.items.some(answerableInteraction)), typing: Boolean(live?.visible && live.typing), activeTurn: this.foregroundBusy(project.id), quiet: Boolean(project.initiative.quietUntil && Date.parse(project.initiative.quietUntil) > this.now()) };
  }
  valid(context, { enabled = true } = {}) {
    const project = this.project(context.projectId);
    if (this.closed || this.store.state.emergency || !realProject(project) || this.deletionPending(context.projectId) || (enabled && !project.initiative.enabled)) return false;
    try { return context.scope === this.scope(project, this.model(project)); } catch { return false; }
  }
  archivedSource(projectId, id, scope, { legacy = false } = {}) {
    if (!this.store.file) return false;
    // Store.archiveRecords writes immutable, content-addressed receipts.
    // Read only this exact known identity; never enumerate or restore bodies.
    for (const record of [{ id, sourceHash: scope }, ...(legacy ? [{ id }] : [])]) {
      const content = JSON.stringify(record), digest = createHash('sha256').update(content).digest('hex');
      const path = resolve(`${this.store.file}.archive`, `initiative/${projectId}/seen/${digest}.json`);
      try { if (readFileSync(path, 'utf8') !== content) throw error('Archived source identity is invalid', 'initiative_archive_invalid'); return true; }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
    return false;
  }
  async create(project, model, scope) {
    const context = { projectId: project.id, scope, drift: this.drift(project, model), backgroundGrant: backgroundGrant(project), notBefore: this.now() + this.initialDelayMs, sources: new Set(), initialized: false, activeHandles: new Set(), workRuns: new Map(), reviewPromise: null, lastSuccessAt: null, lastErrorCode: null };
    const old = project.initiativeRuntime?.sdkState ? copy(project.initiativeRuntime.sdkState) : undefined; context.accountedUsed = old?.usedTokens ?? 0; context.accountedEstimated = old?.estimatedTokens ?? 0;
    // A runtime saved before the split (≤ 0.64) carries one hash of everything, which no longer means anything: it is
    // adopted as the same scope (nothing is revoked) unless the project's records show it is from an earlier folder
    // (legacyFromPreviousFolder), and its archived seen receipts stay readable under that hash. So is a split runtime a
    // version before the split saved again after a maintenance rollback (olderWriter): its own hash replaced
    // `sourceHash`, and `privacyScopeHash`, which it kept, still says whether the privacy scope changed.
    const runtime = project.initiativeRuntime ?? {}, rewritten = olderWriter(runtime), legacy = Boolean(old) && (runtime.scopeSchemaVersion !== INITIATIVE_SCOPE_SCHEMA_VERSION || rewritten);
    const privacyChanged = Boolean(old) && (rewritten ? runtime.privacyScopeHash !== scope : legacy ? this.legacyFromPreviousFolder(project, old) : runtime.sourceHash !== scope);
    context.legacySourceHash = privacyChanged ? null : legacy ? runtime.sourceHash ?? null : runtime.legacySourceHash ?? null;
    // Moving a handler to another lane changes scheduling, not the provenance
    // of completed project work. Preserve its receipts for the learner. Only
    // never-started legacy learning intents are retired; unknown effects retain
    // their existing reconciliation requirement.
    if (old && this.independentLearning) {
      for (const action of old.actions) if (action.action === 'learn' && action.status === 'queued') { action.status = 'cancelled'; action.cancellationReason = 'learning_lane_migrated'; }
      if (old.lastDecision?.action === 'learn') { old.lastDecision = null; old.decisionRevision = -1; old.nextReviewAt = this.now(); }
    }
    const sameScope = Boolean(old) && !privacyChanged;
    const identity = project.initiativeRuntime?.terminalSourceIdentity;
    context.terminalSourceIdentity = sameScope && identity?.version === 1 ? copy(identity) : { version: 1, reobservePending: Boolean(old && !sameScope), legacyArchiveScope: identity?.legacyArchiveScope ?? (old && !identity ? project.initiativeRuntime.sourceHash : null), legacy: [] };
    // The pre-split hash an older identity's id-only receipts were checked against is this scope now.
    if (legacy && !privacyChanged && context.terminalSourceIdentity.legacyArchiveScope && context.terminalSourceIdentity.legacyArchiveScope === runtime.sourceHash) context.terminalSourceIdentity.legacyArchiveScope = scope;
    if (sameScope && project.initiativeRuntime.terminalSourceIdentity?.version !== 1) {
      for (const session of this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side')) for (const turn of terminalTurns(session)) {
        const id = terminalBaseId(turn), retained = old.events.find(event => event.id === id);
        // With only an old seen/archive ID there is no receipt to distinguish
        // retries. Baseline the current occurrence once; never invent a new fact
        // from missing history. Retained distinct terminal times are observable.
        const known = retained ? !Number.isFinite(Date.parse(turn.completedAt)) || retained.at === Date.parse(turn.completedAt) : old.seenEventIds.includes(id) || this.seenArchived(project.id, id, context);
        if (known) context.terminalSourceIdentity.legacy.push({ id, occurrence: terminalOccurrence(turn) });
      }
    }
    // The project-state source was named after the old scope hash; it is named after its own content now. Adopting a
    // pre-split runtime renames what was already observed rather than observing it again (a paid wake for nothing).
    if (legacy) { const id = projectStateSourceId(project); if (!old.seenEventIds.includes(id)) old.seenEventIds.push(id); }
    context.lastSuccessAt = old?.lastDecision?.at ?? null;
    // Background completions the SDK recorded before this context: not new evidence for the lease rules below.
    context.sdkSeen = new Set((old?.events ?? []).filter(event => event.type === 'action_completed').map(event => event.id));
    // A restart of the same scope reviews at once; a runtime that never recorded a scope waits like a new one.
    if (sameScope && runtime.sourceHash) context.notBefore = 0;
    // Paused runs this scope change ends: their conversation lines are completed once the context exists (F44).
    const endedPaused = [], privacyRevoked = [], reclaim = [];
    if (privacyChanged) {
      // The project's identity, workspace folder or action contract changed: what the old scope concluded is revoked.
      // Keep receipts and accounting, reobserve live facts. `privacyRevoked` tells the memory pipeline to withdraw the
      // deliveries these actions fed (memory-evidence-outbox).
      old.events = []; old.seenEventIds = []; old.lastDecision = null; old.revision++; old.decisionRevision = -1;
      delete old.pendingFailureReview; delete old.lastFailureReviewEvidenceKey; delete old.externalEvidenceKey;
      for (const action of old.actions) {
        if (action.status === 'paused' && action.action === 'work') endedPaused.push(copy(action));
        // A scheduled occurrence that never started is the user's own request, not a conclusion of the old scope: it is
        // claimed again under the new one (below) instead of being lost (§1.2 #8; Headlong records a runtime change as a
        // fact, never a revocation). A started (paused or running) one stops, and an old-scope result is not delivered.
        if (action.status === 'queued' && action.action === 'work' && action.hostSchedule) reclaim.push(action.hostSchedule.key);
        if (['queued', 'paused'].includes(action.status)) { action.status = 'cancelled'; action.cancellationReason = 'project_scope_changed'; }
        if (action.sourceDeleted) continue;
        // SDK recentActions is live model context. A prior scope's result must not survive there after events are revoked.
        // Keep stable receipts/intent keys and accounting; jobs retain history,
        // and the user's record of the action is read from them (backgroundActionView).
        action.evidenceIds = []; action.content = 'Previous project scope; retained only as an action receipt.';
        delete action.resultSummary; delete action.handoff; delete action.title; delete action.revokedBy; delete action.revokedSessionIds;
        action.contextRevoked = true; action.privacyRevoked = true; privacyRevoked.push(action.id);
      }
    }
    // Archived conversations withdraw only what cites them (idempotent: re-applied on every start).
    const membership = old ? applyConversationMembership(old, this.store.state.sessions.filter(session => session.projectId === project.id && session.kind !== 'side'), project.jobs, this.now()) : { ended: [], running: [] };
    endedPaused.push(...membership.ended);
    context.archivedKey = this.store.state.sessions.filter(session => session.projectId === project.id && session.kind !== 'side' && session.archivedAt).map(session => session.id).sort().join(',');
    // A conversation restored since this runtime was saved (its archived set is saved with it) is observed again.
    const restored = old && Array.isArray(runtime.archivedSessionIds) ? this.store.state.sessions.filter(session => session.projectId === project.id && session.kind !== 'side' && !session.archivedAt && runtime.archivedSessionIds.includes(session.id)) : [];
    const restoredSource = old ? forgetRestoredConversations(old, restored) : () => false;
    // C4 (privacy_revoked): what the old scope's actions left in the mind (plan items, requests, lessons, notes made from them)
    // is withdrawn in the same transaction, and the conversations' context copies of it fold at their next request.
    if (privacyRevoked.length) this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id);
      for (const job of target?.jobs ?? []) if (privacyRevoked.includes(job.id)) job.privacyRevoked = true;
      if (target) withdrawSources(state, target, sourceScope({ actionIds: privacyRevoked }), { mode: 'privacy', now: this.now() });
    });
    // The occurrence keeps its key (the window) and gets a fresh work action under the new scope; scheduledWork admits it.
    if (reclaim.length) this.mutate(state => { const at = new Date(this.now()).toISOString(); for (const occurrence of state.projects.find(row => row.id === project.id)?.scheduleRuntime?.occurrences ?? []) if (reclaim.includes(occurrence.key) && occurrence.status === 'queued') {
      occurrence.reclaims = (occurrence.reclaims ?? 0) + 1; occurrence.reclaimedFrom = occurrence.actionId; occurrence.reclaimedAt = at; occurrence.actionId = `schedule-work-${hash([occurrence.key, occurrence.reclaims])}`;
    } });
    const provider = this.store.state.configuration.providers.find(provider => provider.id === model.providerId);
    context.planningCapabilities = this.scheduleService?.agentView && this.scheduleService?.applyInitiativeAction ? await this.planningCapabilities(project) : null;
    const projected = old ? { ...project, initiativeRuntime: { ...project.initiativeRuntime, sdkState: old } } : project;
    // Decisions keep their own tool-free prefix (no `sharedPrefix`): the decision tail follows the shared part, so sharing
    // turns ~14-20K agent-prefix tokens per decision into cache reads without lowering uncached input (spec prefix.md §2.2),
    // and with Anthropic's documented tool_choice none it would switch on by itself for Claude. GLM documents only auto.
    context.coordinator = new InitiativeCoordinator({ project: this.snapshot(projected, model, context.planningCapabilities, old ? { eventIds: carriedEventIds(old.events), liveActions: old.actions ?? [] } : {}), model, apiKey: this.store.configurationService.secret(provider.id, provider), provider: purposeProvider(this.store, this.decisionProvider, 'initiative', { projectId: project.id }), state: old, now: this.now, schedulePromptVersion: () => schedulePromptVersionOfStore(this.store), redactValues: this.redactValues(),
      // decisionAttempts 2: a decision that fails validation (unparseable JSON, a misspelled field) is asked once more with
      // the validation message, instead of failing the wake and paying for a whole new decision at the next one.
      policy: { ...project.initiative, decisionAttempts: 2, tokenBudget: remainingInitiativeTokenBudget(project), workBudgetTokens: 12000, learnBudgetTokens: this.learnReservation(project, model), learnNotBefore: autonomousLearningNotBefore(project), decisionMaxTokens: model.maxOutputTokens, maxConcurrent: 1, maxEvents: 16, eventBlock: WINDOW_BLOCK, reviewMinMs: project.initiative.reviewMinMs ?? PROJECT_SCHEDULE_DEFAULTS.reviewMinMs, reviewMaxMs: project.initiative.reviewMaxMs ?? PROJECT_SCHEDULE_DEFAULTS.reviewMaxMs, reviewJitterRatio: 0.1, decisionTimeoutMs: this.decisionTimeoutMs, actionTimeoutMs: this.actionTimeoutMs },
      actionControlKinds: ['work'],
      restIgnore: [...REST_IGNORE],
      // Host-side writing-contract check with one SDK repair round: leaked
      // identifiers/paths, status pings and near-repeats of the last 24h.
      messageCheck: decision => { const current = this.project(context.projectId); return current ? checkedMessageViolations(current, this.store.state.sessions.filter(session => session.projectId === current.id && !session.archivedAt && session.kind !== 'side'), decision.content, { now: this.now(), decisions: this.decisions }) : []; },
      // work.coverage: a proposed work that only repeats checks already covered where it will look (with nothing relevant
      // changed since) is not queued. Fail-open: no judge, no receipts or any doubt admits it.
      workCheck: (decision, { signal } = {}) => { const current = this.project(context.projectId); return current && this.valid(context) && typeof this.decisions?.workCoverage === 'function' ? this.decisions.workCoverage(current, decision, { signal }) : { covered: false }; },
      // Internal reasoning (spec p1 effort §3.4): the decision's effort, chosen per request; the coordinator's model stays as configured.
      decisionReasoning: input => this.decisionReasoning(context, input),
      saveState: (snapshot, metadata) => this.save(context, snapshot, metadata),
      archiveHistory: async ({ actions, seenEventIds }) => { this.store.archiveRecords(`initiative/${context.projectId}/actions`, actions); this.store.archiveRecords(`initiative/${context.projectId}/seen`, seenEventIds.map(id => ({ id, sourceHash: context.scope }))); },
      onEvent: event => this.event(context, event),
      handlers: { share: (action, input) => this.share(context, action, input), work: (action, input) => this.recordedWork(context, action, input), ...(!this.independentLearning ? { learn: (action, input) => this.learn(context, action, input) } : {}), ...(this.interactions ? { ask: (action, input) => this.ask(context, action, input) } : {}), ...(this.scheduleService?.applyInitiativeAction ? { schedule: (action, input) => this.manageSchedule(context, action, input) } : {}) }
    });
    if (sameScope) {
      const migrated = { ...project, initiativeRuntime: { ...project.initiativeRuntime, terminalSourceIdentity: context.terminalSourceIdentity } };
      // An archived ID must remain seen after restart even after SDK hot history
      // was pruned. This bootstrap does not append evidence or change revision.
      for (const source of this.sources(migrated, scope)) if (old.seenEventIds.includes(source.id) || !context.terminalSourceIdentity.reobservePending && !restoredSource(source.id) && this.seenArchived(project.id, source.id, context)) context.sources.add(source.id);
    }
    this.contexts.set(project.id, context);
    // Recovery consumes unknown reserved usage conservatively; no in-flight
    // action is replayed. The current context can still be reviewed later.
    await this.save(context, context.coordinator.snapshot());
    for (const action of endedPaused) { const reason = membership.ended.includes(action) ? 'source_session_archived' : 'project_scope_changed'; try { this.endPausedLine(context, { ...action, status: 'cancelled', cancellationReason: reason }, reason); } catch { /* the line is a courtesy */ } }
    await this.reconcileScheduleReceipts(context);
    return context;
  }
  /**
   * Work stopped by an interruption (the conversation took over, a stop) is marked
   * needs_review by the SDK whatever happened. The host saw the run end: when no tool
   * call was left unconfirmed (its job is 'cancelled', not 'needs_review'), the outcome is
   * known — what finished stays, the rest was not done — so nobody has to be asked.
   */
  async reconcileInterrupted(context) {
    const coordinator = context.coordinator;
    if (coordinator.active.size || coordinator.unsettled.size || coordinator.resolvingExecutions?.size || context.activeHandles?.size) return;
    const jobs = this.project(context.projectId)?.jobs ?? [];
    for (const action of coordinator.state.actions) {
      if (action.status !== 'needs_review' || action.blocksExecution === true || action.resolvedAt) continue;
      const job = jobs.find(row => row.id === action.id);
      if (job?.status !== 'cancelled' || job.cleanupUncertain) continue;
      const done = job.toolReceiptCounts?.completed ?? 0;
      const summary = `Interrupted (${action.errorCode ?? 'stopped'}) with every tool call settled: ${done} completed step(s) stay as done, the rest was not done and will not be replayed.`;
      try { await coordinator.resolveAction(action.id, { status: 'cancelled', source: 'host', summary }); } catch { return; }
    }
  }
  async reconcileScheduleReceipts(context) {
    if (typeof this.scheduleService?.reconcileInitiativeAction !== 'function' || context.coordinator.active.size || context.coordinator.unsettled.size) return;
    for (const action of context.coordinator.state.actions) {
      if (action.action !== 'schedule' || action.status !== 'needs_review') continue;
      const receipt = this.scheduleService.reconcileInitiativeAction(context.projectId, action);
      if (receipt) await context.coordinator.resolveAction(action.id, { status: 'completed', source: 'host', summary: receipt.summary || 'Verified the original durable schedule commit receipt; no action was replayed.' });
    }
  }
  async manageSchedule(context, action, { signal, evidence }) {
    signal.throwIfAborted();
    if (!this.valid(context) || !this.scheduleService?.applyInitiativeAction) return { superseded: true, reason: 'host_context_changed', usage: { totalTokens: 0 } };
    try {
      const receipt = this.scheduleService.applyInitiativeAction(context.projectId, { actionId: action.id, schedule: copy(action.schedule), reason: action.reason, evidenceIds: copy(action.evidenceIds), evidence: copy(evidence), signal });
      return { summary: receipt.summary ?? JSON.stringify(receipt), usage: { totalTokens: 0 } };
    } catch (failure) { failure.usage = { totalTokens: 0 }; throw failure; }
  }
  async save(context, snapshot, metadata) {
    // An original private failure receipt must be durable before replacing the
    // bounded hot diagnostic. Archive failure prevents the state transition.
    if (snapshot.lastFailure && context.archivedFailure !== `${snapshot.lastFailure.id}:${snapshot.lastFailure.recoveredAt ?? ''}`) {
      this.store.archiveRecords(`initiative/${context.projectId}/failures`, [snapshot.lastFailure]);
      context.archivedFailure = `${snapshot.lastFailure.id}:${snapshot.lastFailure.recoveredAt ?? ''}`;
    }
    this.mutate(state => {
      const project = state.projects.find(project => project.id === context.projectId);
      const added = Math.max(0, snapshot.usedTokens - context.accountedUsed);
      const reservation = `initiative:${context.projectId}`;
      const estimated = Math.min(added, Math.max(0, (snapshot.estimatedTokens ?? 0) - (context.accountedEstimated ?? 0)));
      chargeRealTokens(state, added - estimated, { now: this.now() }); chargeRealTokens(state, estimated, { estimated: true, now: this.now() });
      if (!project) { releaseRealTokens(state, reservation, { now: this.now() }); return; }
      // A reduced cap may be below an already admitted request. Its actual
      // receipt is still charged, but no subsequent request inherits that grant.
      // Check and reserve in this same Store transaction across all projects.
      if (metadata?.reservationAdmission && (snapshot.usedTokens + snapshot.reservedTokens > (remainingInitiativeTokenBudget(project) ?? Infinity) || snapshot.reservedTokens > realBudgetRemaining(state, { excludeReservation: reservation, now: this.now() }))) throw error('Background request exceeds the current project or global token allowance', 'budget');
      if (snapshot.reservedTokens) reserveRealTokens(state, reservation, snapshot.reservedTokens, { now: this.now() });
      else releaseRealTokens(state, reservation, { now: this.now() });
      if (context.rhythmEvidenceKey && this.valid(context)) acceptProjectRhythmDecision(project, snapshot.lastDecision, { evidenceKey: context.rhythmEvidenceKey, ...context.rhythmReferences, now: this.now() });
      project.initiativeRuntime ??= {};
      if (snapshot.lastDecision?.judgmentPolicy && context.rhythmEvidenceKey && this.valid(context) && snapshot.lastDecision.at !== project.initiativeRuntime.sdkState?.lastDecision?.at
        && (project.judgmentPolicy?.revision ?? null) === (context.coordinator.project.actionContracts?.judgment?.revision ?? null)) {
        const nextPolicy = prepareJudgmentPolicy(snapshot.lastDecision.judgmentPolicy, { project, source: { kind: 'main_model', method: 'initiative', providerId: context.coordinator.model.providerId, modelId: context.coordinator.model.modelId, receiptId: `initiative:${project.id}:${snapshot.lastDecision.revision}:${snapshot.lastDecision.at}`, createdAt: new Date(this.now()).toISOString() }, reason: '主模型在项目复查中维护的判断选项与评分标准' });
        if (validJudgmentPolicy(project)?.revision !== nextPolicy.revision) project.judgmentPolicy = nextPolicy;
      }
      if (snapshot.lastDecision && (snapshot.lastDecision.at !== project.initiativeRuntime.sdkState?.lastDecision?.at || snapshot.lastDecision.revision !== project.initiativeRuntime.sdkState?.lastDecision?.revision)) project.initiativeRuntime.lastDecisionSourceIds = copy(context.rhythmReferences?.sourceIds ?? []);
      project.initiative.tokens = snapshot.usedTokens + learningTokenUsage(project).totalTokens;
      project.initiative.costStatus = 'unpriced';
      // The pre-split evidence-retention hash (retainedEvidenceScopeHash) is gone: drift no longer revokes anything.
      const { retainedEvidenceScopeHash: _retired, legacySourceHash: _adopted, ...runtime } = project.initiativeRuntime;
      project.initiativeRuntime = { ...runtime, terminalSourceIdentity: copy(context.terminalSourceIdentity), sdkState: copy(snapshot), archiveNamespace: `initiative/${context.projectId}`, nextReviewAt: snapshot.nextReviewAt ? new Date(snapshot.nextReviewAt).toISOString() : null, sourceHash: context.scope, privacyScopeHash: context.scope, scopeSchemaVersion: INITIATIVE_SCOPE_SCHEMA_VERSION, archivedSessionIds: (context.archivedKey ?? '').split(',').filter(Boolean), ...(context.legacySourceHash ? { legacySourceHash: context.legacySourceHash } : {}), modelSelection: { providerId: context.coordinator.model.providerId, modelId: context.coordinator.model.modelId, reasoning: context.coordinator.model.reasoning }, status: !project.initiative.enabled || project.archivedAt ? 'paused' : snapshot.actions.some(action => action.status === 'running') ? 'working' : snapshot.actions.some(action => action.status === 'queued') ? 'waiting-to-share' : 'observing' };
      if (snapshot.lastFailure) { project.initiativeRuntime.lastFailure = copy(snapshot.lastFailure); project.initiativeRuntime.lastErrorCode = snapshot.lastFailure.recoveredAt ? null : snapshot.lastFailure.code; }
    });
    context.accountedUsed = snapshot.usedTokens; context.accountedEstimated = snapshot.estimatedTokens ?? 0;
  }
  event(context, event) {
    if (event.type === 'initiative_decision') this.mutate(state => {
      const project = state.projects.find(project => project.id === context.projectId); if (!project || !this.valid(context)) return;
      project.decisions.push({ id: randomUUID(), ...copy(event.decision), ...(event.admission ? { admission: copy(event.admission) } : {}), ...(event.reasoning?.effective ? { reasoning: { effective: event.reasoning.effective, source: event.reasoning.source ?? 'configured', ...(event.reasoning.shadow?.effort ? { shadow: event.reasoning.shadow.effort } : {}) } } : {}), sourceIds: copy(context.rhythmReferences?.sourceIds ?? []), at: new Date(this.now()).toISOString(), status: 'completed', decisionMode: 'rna-model', simulated: false });
      if (project.decisions.length > 200) { this.store.archiveRecords(`initiative/${project.id}/decisions`, project.decisions.slice(0, -200)); project.decisions = project.decisions.slice(-200); }
    });
    // Work that declared `resolves` settles its commitments/agenda once it actually completed and its changes reached the
    // project folder (X-5; shares settle at delivery).
    if (event.type === 'initiative_action_completed') { const action = context.coordinator.state.actions.find(row => row.id === event.actionId); if (action && !['share', 'ask'].includes(action.action)) this.resolveWork(context, action); }
    // Stopping a paused run settles at once in the SDK, without running it again: its line is completed here (F44).
    if (event.type === 'initiative_action_control' && event.kind === 'cancel' && event.status === 'applied') {
      const action = context.coordinator.state.actions.find(row => row.id === event.actionId);
      if (action?.status === 'cancelled') try { this.endPausedLine(context, copy(action), 'action_control'); } catch { /* the line is a courtesy; the stop stands */ }
    }
    if (['initiative_action_completed', 'initiative_action_failed', 'initiative_action_resolved', 'initiative_operation_settled'].includes(event.type)) this.schedule();
  }
  resolveMind(context, action, kind = 'action') {
    const ids = (Array.isArray(action?.resolves) ? action.resolves : []).filter(id => typeof id === 'string');
    if (!ids.length || typeof this.store.mind?.resolve !== 'function' || !this.valid(context)) return;
    try { this.store.mind.resolve(context.projectId, ids, { kind, actionId: action.id }); } catch { /* the mind store never blocks delivery */ }
  }
  /**
   * X-5: a finished work action's `resolves` settle by what its change set came to (computed, workChangeOutcome): at
   * once when it was applied or the run changed no file; marked as waiting while it is deferred or a conflict card is
   * open (the mind settles them when it is applied, or reopens them when it is discarded); not at all when it was
   * already undone. Reverts and rollbacks later reopen what was settled (ProjectMindService.settleOutcomes).
   */
  resolveWork(context, action, kind = 'action') {
    const ids = (Array.isArray(action?.resolves) ? action.resolves : []).filter(id => typeof id === 'string');
    if (!ids.length || typeof this.store.mind?.resolve !== 'function' || !this.valid(context)) return;
    const outcome = workChangeOutcome(this.project(context.projectId), action.id);
    try {
      if (outcome.status === 'waiting') this.store.mind.awaitApply?.(context.projectId, ids, { actionId: action.id, changeId: outcome.change.id });
      else if (outcome.status !== 'undone') this.store.mind.resolve(context.projectId, ids, { kind, actionId: action.id, ...(outcome.change?.applyId ? { applyId: outcome.change.applyId } : {}) });
    } catch { /* the mind store never blocks the work */ }
  }
  scheduleActionCurrent(context, action) {
    const project = this.project(context.projectId), identity = action.hostSchedule;
    if (!identity || action.contextRevoked || action.sourceDeleted) return false;
    const schedule = project?.schedules?.find(row => row.id === identity.scheduleId);
    // The identity carries the record revision the occurrence was claimed at: only a later change to what it performs
    // revokes it, never a title edit (also for claims a rolled-back 0.68 made, which carry the same revision).
    return Boolean(schedule?.enabled && projectScheduleClaimCurrent(schedule, identity.scheduleRevision) && schedule.destinationSessionId === identity.destinationSessionId
      && this.store.state.sessions.some(session => session.id === identity.destinationSessionId && session.projectId === project.id && !session.archivedAt && session.kind !== 'side'));
  }
  async scheduledWork(context) {
    const project = this.project(context.projectId), coordinator = context.coordinator;
    if (!project || !(project.schedules?.length || project.scheduleRuntime?.occurrences?.length)) return false;
    if (!this.valid(context)) return false;
    // Mirror durable action receipts, never infer completion from a timer or an
    // assistant promise. The conversation message is the delivery receipt; a
    // delivery filed quietly in the inbox (inbox tier, conversation busy) has its entry instead.
    const updates = [], now = this.now();
    for (const occurrence of project.scheduleRuntime?.occurrences ?? []) {
      if (OCCURRENCE_SETTLED.includes(occurrence.status)) continue;
      const action = coordinator.state.actions.find(row => row.id === occurrence.actionId), delivery = coordinator.state.actions.find(row => row.id === occurrence.deliveryActionId);
      const received = this.store.state.sessions.flatMap(session => session.projectId === project.id ? session.items : []).find(item => item.scheduleOccurrenceKey === occurrence.key);
      const filed = !received && occurrence.deliveryActionId ? (project.inbox ?? []).find(row => row.actionId === occurrence.deliveryActionId && !row.contextRevoked) : null;
      let values;
      if (received) values = { status: 'delivered', deliveredAt: received.createdAt, deliveryItemId: received.id, errorCode: null };
      else if (filed) values = { status: 'delivered', deliveredAt: filed.createdAt, deliveryItemId: filed.itemId ?? null, deliveryInboxId: filed.id, errorCode: null };
      else if (action && !this.scheduleActionCurrent(context, action)) {
        if (action.status === 'queued') await coordinator.cancelQueuedHostAction(action.id);
        if (delivery?.status === 'queued') await coordinator.cancelQueuedHostAction(delivery.id);
        values = { status: action.status === 'running' || action.status === 'needs_review' ? 'needs_review' : 'cancelled', errorCode: 'schedule_revoked' };
      } else if (action?.status === 'needs_review' || delivery?.status === 'needs_review') values = { status: 'needs_review', errorCode: action?.errorCode ?? delivery?.errorCode ?? 'execution_unconfirmed' };
      else if (['failed', 'cancelled'].includes(action?.status) || ['failed', 'cancelled'].includes(delivery?.status)) values = { status: action?.status === 'cancelled' || delivery?.status === 'cancelled' ? 'cancelled' : 'failed', errorCode: action?.errorCode ?? delivery?.errorCode ?? 'schedule_action_failed' };
      // pendingSince: when the result began waiting for delivery (it expires after one period, below).
      else if (action?.status === 'completed') values = { status: 'delivery_pending', errorCode: null, ...(occurrence.status === 'delivery_pending' ? {} : { pendingSince: new Date(now).toISOString() }) };
      else if (action?.status === 'running') values = { status: 'running', errorCode: null };
      if (values && Object.entries(values).some(([key, value]) => occurrence[key] !== value)) updates.push({ key: occurrence.key, values });
    }
    if (updates.length) this.mutate(state => { const target = state.projects.find(row => row.id === context.projectId); for (const update of updates) {
      const occurrence = target.scheduleRuntime.occurrences.find(row => row.key === update.key);
      if (update.values.status === 'delivered' && occurrence.status !== 'delivered') target.scheduleRuntime.deliveredCount = (target.scheduleRuntime.deliveredCount ?? 0) + 1;
      Object.assign(occurrence, update.values);
    } });
    for (const occurrence of this.project(context.projectId).scheduleRuntime?.occurrences ?? []) if (OCCURRENCE_SETTLED.includes(occurrence.status)) await coordinator.retireHostOccurrence(occurrence.key);
    this.dropDeliveredTexts(context.projectId);
    if (context.reviewPromise || coordinator.ticking || coordinator.active.size || coordinator.unsettled.size) return false;
    const occupied = [...this.contexts.values()].filter(row => row.reviewPromise || row.coordinator.active.size || row.coordinator.unsettled.size).length;
    if (occupied >= this.maxConcurrentReviews) return false;
    let current = this.project(context.projectId);
    // F9, mute means pause (what the schedule list, the settings and the REACH guidance say): nothing is claimed or
    // started while muted; a run that had already started is delivered quietly (share(): inbox tier).
    const muted = current.initiative?.notificationMuted === true;
    let handled = false;
    for (const occurrence of current.scheduleRuntime?.occurrences ?? []) {
      if (!['queued', 'delivery_pending'].includes(occurrence.status)) continue;
      const schedule = current.schedules?.find(row => row.id === occurrence.scheduleId), target = this.store.state.sessions.find(session => session.id === schedule?.destinationSessionId && session.projectId === current.id && !session.archivedAt && session.kind !== 'side');
      // Only a change to what the occurrence performs (task, rule, destination) or switching the schedule off revokes it.
      const revision = occurrence.scheduleRevision;
      if (!schedule?.enabled || !projectScheduleClaimCurrent(schedule, revision) || !target) {
        this.mutate(state => { const row = state.projects.find(project => project.id === current.id).scheduleRuntime.occurrences.find(row => row.key === occurrence.key); row.status = 'cancelled'; row.errorCode = 'schedule_revoked'; });
        continue;
      }
      // No late backlog (harness schedule.md:96; Headlong's missed window): a claim that could not start before the
      // schedule's next window opened is skipped, so the newest window runs instead of a queue of old ones. Only a later
      // window passes it: a wall clock stepped back behind the claimed window does not.
      if (occurrence.status === 'queued' && projectScheduleWindowPassed(schedule, occurrence.scheduledAt, now)) {
        await coordinator.cancelQueuedHostAction(occurrence.actionId, WINDOW_PASSED);
        this.mutate(state => { skipOccurrence(state.projects.find(row => row.id === current.id), occurrence.key, WINDOW_PASSED, now); });
        continue;
      }
      if (occurrence.status === 'queued' && muted) continue;
      const hostSchedule = { key: occurrence.key, scheduleId: schedule.id, scheduleRevision: revision, destinationSessionId: schedule.destinationSessionId };
      const source = { id: occurrence.key, type: 'scheduled_occurrence', summary: JSON.stringify({ title: schedule.title, scheduledAt: occurrence.scheduledAt, rule: schedule.rule, coalescedFrom: occurrence.coalescedFrom }), at: Date.parse(occurrence.scheduledAt) };
      if (occurrence.status === 'delivery_pending') {
        // A result that waited a whole period for delivery is not posted late: it goes to the inbox with a note.
        const period = projectSchedulePeriodMs(schedule, occurrence.scheduledAt), since = Date.parse(occurrence.pendingSince ?? occurrence.claimedAt ?? occurrence.scheduledAt);
        if (period !== null && since + period <= now) { await this.expireScheduledDelivery(context, current, schedule, occurrence); continue; }
        const completed = coordinator.state.actions.find(row => row.id === occurrence.actionId), full = this.scheduledResult(current, occurrence);
        if (!full?.trim() && !completed?.resultSummary?.trim()) {
          this.mutate(state => { const row = state.projects.find(project => project.id === current.id).scheduleRuntime.occurrences.find(row => row.key === occurrence.key); row.status = 'failed'; row.errorCode = 'schedule_result_missing'; }); continue;
        }
        const id = `schedule-delivery-${hash(occurrence.key)}`;
        if (!occurrence.deliveryActionId) this.mutate(state => { state.projects.find(project => project.id === current.id).scheduleRuntime.occurrences.find(row => row.key === occurrence.key).deliveryActionId = id; });
        // The share carries the whole result when the SDK takes it, else the excerpt; narrateAction reads the job's full text either way.
        // Enqueued once: a later title edit must not turn the next pump's request into a different one (host_action_conflict).
        const body = full && schedule.title.length + 2 + full.length <= HOST_ACTION_CONTENT_LIMIT ? full : completed?.resultSummary ?? excerpt(full, HOST_ACTION_CONTENT_LIMIT - schedule.title.length - 2);
        if (!coordinator.state.actions.some(row => row.id === id)) await coordinator.enqueueHostAction({ id, action: 'share', reason: 'Deliver the completed scheduled occurrence to its configured project conversation.', content: `${schedule.title}\n\n${body}`, source, hostSchedule });
      } else {
        // A scheduled run in its own worktree does not wait for a foreground turn (design §8); plan mode still holds it.
        if ((!this.isolatedProject(current.id) && this.foregroundBusy(current.id)) || this.planning(current.id)) return true;
        if (!coordinator.state.actions.some(row => row.id === occurrence.actionId)) await coordinator.enqueueHostAction({ id: occurrence.actionId, action: 'work', reason: 'A persisted project schedule is due; perform this occurrence once within current permissions.', content: `Scheduled occurrence ${occurrence.key}\nDue: ${occurrence.scheduledAt}\nTime rule: ${JSON.stringify(schedule.rule)}\n\n${schedule.task}\n\nProduce the requested deliverable using current evidence and authorized tools. Report actual outputs and any limitation. The host will deliver this result to the configured project conversation; do not send it to another channel. ${SCHEDULED_DELIVERY_INSTRUCTION}`, source, hostSchedule });
      }
      await coordinator.drainHostActions({ presence: this.presence(current) });
      handled = true;
      if (occurrence.status === 'queued' || coordinator.active.size) return true;
    }
    // Re-read: a skip or an expiry above may have freed a schedule for its newest window (writes replace the project).
    current = this.project(context.projectId);
    const rows = current.scheduleRuntime?.occurrences ?? [];
    const live = new Set(rows.filter(row => OCCURRENCE_LIVE.includes(row.status)).map(row => row.scheduleId));
    const candidates = (current.schedules ?? []).filter(schedule => schedule.enabled && !live.has(schedule.id) && this.store.state.sessions.some(session => session.id === schedule.destinationSessionId && session.projectId === current.id && !session.archivedAt && session.kind !== 'side'));
    // While muted the window that comes due is recorded once as skipped (the latest only) and the schedule moves on.
    if (muted) return this.skipMutedWindows(current, candidates, now) || handled;
    if (coordinator._executionBlocked() || (!this.isolatedProject(current.id) && this.foregroundBusy(current.id)) || this.planning(current.id)) return false;
    const latest = id => rows.filter(row => row.scheduleId === id).reduce((last, row) => (!last || Date.parse(row.scheduledAt) > Date.parse(last.scheduledAt) ? row : last), null);
    const ready = candidates.map(schedule => {
      const due = projectScheduleDue(schedule, now);
      if (due) return { schedule, due };
      // After unmute the window skipped while muted runs once if it is still the latest one (within one period) and
      // nothing it performs changed since the skip: switching the schedule off and on starts from now, as a new rule
      // does (no catch-up of what a pause skipped); a title edit keeps it.
      const skipped = latest(schedule.id);
      return skipped?.status === 'skipped' && skipped.errorCode === MUTED_SKIP && projectScheduleClaimCurrent(schedule, skipped.scheduleRevision) && projectScheduleWindowOpen(schedule, skipped.scheduledAt, now)
        ? { schedule, due: { key: skipped.key, scheduledAt: skipped.scheduledAt, nextRunAt: schedule.nextRunAt ?? null, coalescedFrom: skipped.coalescedFrom ?? null }, resumed: true } : null;
    }).filter(Boolean).sort((a, b) => a.due.scheduledAt.localeCompare(b.due.scheduledAt))[0];
    if (!ready) return handled;
    this.mutate(state => {
      const target = state.projects.find(row => row.id === current.id), schedule = target.schedules.find(row => row.id === ready.schedule.id);
      if (!schedule?.enabled || schedule.revision !== ready.schedule.revision) return;
      target.scheduleRuntime ??= { schemaVersion: 1, occurrences: [] };
      const existing = target.scheduleRuntime.occurrences.find(row => row.key === ready.due.key);
      // The key names the window: one already handled is done (Headlong's keyed send), so the schedule only moves on.
      if (existing && !(existing.status === 'skipped' && existing.errorCode === MUTED_SKIP)) { if (!ready.resumed) schedule.nextRunAt = ready.due.nextRunAt; return; }
      const terminal = target.scheduleRuntime.occurrences.filter(row => row !== existing && OCCURRENCE_SETTLED.includes(row.status)), archived = terminal.slice(0, -127);
      if (archived.length) { this.store.archiveRecords(`schedules/${target.id}/occurrences`, archived); const ids = new Set(archived.map(row => row.key)); target.scheduleRuntime.occurrences = target.scheduleRuntime.occurrences.filter(row => !ids.has(row.key)); }
      const claim = { scheduleId: schedule.id, scheduleRevision: schedule.revision, claimedAt: new Date(this.now()).toISOString(), status: 'queued', actionId: `schedule-work-${hash(ready.due.key)}` };
      if (existing) Object.assign(existing, claim, { errorCode: null, resumedAt: claim.claimedAt });
      else target.scheduleRuntime.occurrences.push({ ...ready.due, ...claim });
      if (!ready.resumed) schedule.nextRunAt = ready.due.nextRunAt;
    });
    // Claim is committed before admission. A crash here resumes only this
    // never-started occurrence; running or uncertain work is never replayed.
    return this.scheduledWork(context);
  }
  /** While muted: each due window is recorded as skipped (latest only per schedule) and its schedule moves to the next window. */
  skipMutedWindows(project, schedules, now) {
    const due = schedules.map(schedule => ({ schedule, due: projectScheduleDue(schedule, now) })).filter(row => row.due);
    if (!due.length) return false;
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id);
      for (const row of target ? due : []) {
        const schedule = target.schedules?.find(item => item.id === row.schedule.id);
        if (!schedule?.enabled || schedule.revision !== row.schedule.revision) continue;
        // A window already handled under its key is not skipped again; the schedule only moves on.
        if (!(target.scheduleRuntime?.occurrences ?? []).some(item => item.key === row.due.key)) skipOccurrence(target, { ...row.due, scheduleId: schedule.id, scheduleRevision: schedule.revision }, MUTED_SKIP, now);
        schedule.nextRunAt = row.due.nextRunAt;
      }
    });
    return true;
  }
  /** A scheduled result that waited a whole period for delivery: filed in the inbox with a note, never posted late (F9). */
  async expireScheduledDelivery(context, project, schedule, occurrence) {
    if (occurrence.deliveryActionId) await context.coordinator.cancelQueuedHostAction(occurrence.deliveryActionId, 'delivery_expired');
    const work = context.coordinator.state.actions.find(row => row.id === occurrence.actionId), full = this.scheduledResult(project, occurrence);
    const result = this.redact(full ?? stripHandoff(this.userFacingExcerpt(work?.resultSummary ?? ''))).trim();
    const text = expiredDeliveryText(schedule, occurrence, result, interfaceLanguageOf(this.store.state)), now = this.now();
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id), row = target?.scheduleRuntime?.occurrences?.find(item => item.key === occurrence.key);
      if (!row || row.status !== 'delivery_pending') return;
      const entry = recordDelivery(target, { actionId: `schedule-expired-${hash(occurrence.key)}`, kind: 'share', tier: 'inbox', reasons: ['schedule_expired'], text, sessionId: schedule.destinationSessionId, scheduled: true, now });
      entry.expired = true;
      Object.assign(row, { status: 'expired', errorCode: 'delivery_expired', expiredAt: entry.createdAt, deliveryInboxId: entry.id });
      trimInbox(this.store, target);
    });
  }
  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.lastPumpAt = this.now();
    this.lastPumpError = null;
    try {
      for (const [id, context] of this.contexts) if (!this.valid(context)) {
        if (!context.closing) context.closing = context.coordinator.close().then(() => { context.closed = true; this.schedule(); }).catch(failure => { context.closed = true; context.lastErrorCode = failure.code ?? 'persistence_error'; });
        if (context.closed && !context.coordinator.unsettled.size && !context.activeHandles.size) this.contexts.delete(id);
      }
      if (this.store.state.emergency || this.store.maintenanceHeld) return;
      const projects = [...this.store.state.projects], start = this.cursor % Math.max(1, projects.length);
      const ordered = [...projects.slice(start), ...projects.slice(0, start)];
      for (const project of ordered) {
        if (!realProject(project) || !project.initiative.enabled || this.deletionPending(project.id) || project.skillFoundation?.status === 'preparing') continue;
        let model; try { model = this.model(project); } catch { continue; }
        if (model.execution !== 'rna') continue;
        const scope = this.scope(project, model);
        const context = this.contexts.get(project.id) ?? await this.create(project, model, scope);
        if (context.closing || !this.valid(context)) continue;
        // Context drift refreshes what the coordinator froze; an archived or restored conversation changes only what cites it.
        await this.refreshDrift(context, this.project(project.id), model);
        if (context.closing || !this.valid(context)) continue;
        if (this.syncMembership(context)) await this.save(context, context.coordinator.snapshot());
        const sources = this.sources(this.project(project.id), scope), fresh = sources.filter(row => !context.sources.has(row.id));
        // PDL-2: a running foreground turn's own messages and writes are observed but wake nothing (its conversation_result
        // does). Everything else fresh is independent evidence and reaches the gate during a turn too, and so does a
        // background action the SDK recorded as completed since the last pump.
        const lease = this.progressLease(project.id, context.coordinator.state), owned = this.leaseOwnedIds(this.project(project.id), lease.owners);
        const seen = context.sdkSeen ??= new Set(), completed = (context.coordinator.state.events ?? []).filter(event => event.type === 'action_completed' && !seen.has(event.id));
        for (const event of completed) seen.add(event.id);
        // The SDK keeps a bounded event list and a completion id never recurs: forget ids that left it.
        if (seen.size > 64) context.sdkSeen = new Set((context.coordinator.state.events ?? []).filter(event => event.type === 'action_completed').map(event => event.id));
        const external = fresh.filter(source => source.type !== 'schedule_state' && !owned.has(source.id));
        // What the gate reads as new: fresh sources other than the turn's own, and those completions. Kept on the context
        // until a judgment actually reads them (L5): a pump that cannot review at once (a review in flight, a backoff, not
        // eligible yet) must not turn independent evidence into "nothing new" for the review that follows.
        const gateEvidence = [...fresh.filter(source => !owned.has(source.id)), ...completed];
        if (gateEvidence.length) { const ids = new Set(gateEvidence.map(row => row.id)); context.pendingGateEvidence = [...(context.pendingGateEvidence ?? []).filter(row => !ids.has(row.id)), ...gateEvidence].slice(-PENDING_GATE_EVIDENCE); }
        if (context.initialized && external.length) {
          context.coordinator.invalidateDecision('new_project_evidence'); context.notBefore = 0; context.progressHold = null; context.independentPending = true;
        }
        // A completion is reviewed on its own clock, as before; during work in progress it is judged instead of held.
        if (context.initialized && completed.length) context.independentPending = true;
        for (const source of fresh) { await context.coordinator.observe(source); context.sources.add(source.id); }
        if (this.valid(context)) {
          const received = new Set(sources.filter(source => source.type === 'workspace_change' && context.sources.has(source.id)).map(source => source.id));
          const needsReceipt = (this.project(project.id).observations ?? []).some(row => row.kind === 'workspace_change' && !row.data?.runtimeReceipt && received.has(`observation:${row.id}`));
          if (needsReceipt) this.mutate(state => { for (const row of state.projects.find(row => row.id === project.id).observations) {
            if (row.kind !== 'workspace_change' || row.data?.runtimeReceipt || !received.has(`observation:${row.id}`) || ['withdrawn', 'superseded'].includes(row.status)) continue;
            row.status = 'received'; row.data.runtimeReceipt = { scope: context.scope, eventId: `observation:${row.id}`, at: this.now(), meaning: 'durably_received_by_initiative_runtime_not_task_completion' };
          } });
        }
        if (context.terminalSourceIdentity?.reobservePending && this.valid(context)) {
          // A scope hash can recur (A -> B -> A). Until all current sources are
          // durably observed, a restart must not reuse any prior-scope archive.
          // Partial imports only deduplicate against their newly saved SDK IDs.
          context.terminalSourceIdentity.reobservePending = false;
          try { await this.save(context, context.coordinator.snapshot()); }
          catch (failure) { context.terminalSourceIdentity.reobservePending = true; throw failure; }
        }
        context.sources = new Set(sources.map(source => source.id));
        context.initialized = true;
        const current = this.project(project.id); if (!current || !this.valid(context)) continue;
        this.deliveryUpkeep(context);
        this.outcomeUpkeep(context);
        await this.reconcileInterrupted(context);
        if (current.evolution.enabled && context.learningEnabled === false) for (const action of context.coordinator.state.actions) if (action.action === 'learn' && action.status === 'queued') delete action.nextAttemptAt;
        context.learningEnabled = current.evolution.enabled;
        // Idle checks read the live coordinator state; only a review that actually starts takes a copy.
        const live = context.coordinator.state;
        const globalRemaining = realBudgetRemaining(this.store.state, { now: this.now() });
        const combinedLimit = Math.min(remainingInitiativeTokenBudget(current) ?? Infinity, live.usedTokens + live.reservedTokens + globalRemaining);
        const policy = { enabled: current.initiative.enabled, notificationMuted: current.initiative.notificationMuted, deferWhileTyping: current.initiative.deferWhileTyping, cooldownMs: current.initiative.cooldownMs, reviewMinMs: current.initiative.reviewMinMs ?? PROJECT_SCHEDULE_DEFAULTS.reviewMinMs, reviewMaxMs: current.initiative.reviewMaxMs ?? PROJECT_SCHEDULE_DEFAULTS.reviewMaxMs, learnNotBefore: autonomousLearningNotBefore(current), tokenBudget: Number.isFinite(combinedLimit) ? combinedLimit : null, learnBudgetTokens: this.learnReservation(current, model) };
        if (Object.entries(policy).some(([key, value]) => context.coordinator.policy[key] !== value)) await context.coordinator.updatePolicy(policy);
        if (await this.scheduledWork(context)) continue;
        // PDL-2 progress lease, after schedules (they still claim and drain). While a foreground turn runs, decisions wait
        // for its end (its conversation_result, or the key change of a stop or pause) unless independent evidence arrived;
        // a hold the gate placed (in_progress_covers) lasts until the work in progress ends. Deliveries and recovery keep
        // draining; a pending failure review is never held. No snapshot, gate, decision or wake row while held.
        // An overdue request from the user is held like everything else (B3): Headlong's pending request changes what a
        // wake does and which tier answers, never adds wakes (monolith/step:204-237, 425-441). The turn may itself be
        // serving it; its conversation_result reaches the gate, whose commitment_overdue rule sends it to the main model.
        const progress = this.progressLease(project.id, live);
        if (context.progressHold && context.progressHold !== progress.key) { context.progressHold = null; context.notBefore = 0; }
        if (!context.independentPending && !live.pendingFailureReview && (progress.foreground || context.progressHold && context.progressHold === progress.key)) {
          // The hold's one ledger row (per progress key) is written when it actually holds back a decision: the project may
          // wake and the coordinator would decide now (with the open-work floor), not merely because a turn runs.
          if (progress.foreground) {
            context.progressHold = progress.key;
            if (context.leaseRowKey !== progress.key && this.decisions?.recordLeaseHold) {
              const held = this.project(project.id), rhythm = projectRhythmStatus(this.store.state, held, { now: this.now() }), floor = wakeFloor(held, rhythm, { now: this.now() });
              if ((rhythm.initiative.eligible || floor.eligible) && context.coordinator.decisionDue({ wakeFloor: floor.eligible })) { context.leaseRowKey = progress.key; try { this.decisions.recordLeaseHold(held, progress.key); } catch { /* the ledger never blocks a hold */ } }
            }
          }
          await this.drainHeld(context, project.id);
          continue;
        }
        const rhythm = projectRhythmStatus(this.store.state, this.project(project.id), { now: this.now() });
        context.rhythm = rhythm;
        // event_only is a floor, not a full stop: open agenda, commitments or held thread items keep a backed-off wake.
        // PDL-4 (Headlong bin/thinkers:875-895: a due wake is not fired while the thinker is busy or no slot is free; it
        // stays armed and fires on a later tick): a due floor wake waits while the coordinator could not decide on it
        // (work occupying every execution slot, an unresolved execution or external review, a failure or persistence
        // backoff, a full action history). A tick then only idled, and that idle tick counted as a thought.
        const ladder = wakeFloor(this.project(project.id), rhythm, { now: this.now() });
        const floor = ladder.eligible && !context.coordinator.decisionDue({ wakeFloor: true }) ? { ...ladder, eligible: false, reason: 'floor_busy' } : ladder, wakeEligible = rhythm.initiative.eligible || floor.eligible;
        if (!wakeEligible && !live.actions.some(action => action.status === 'queued')) continue;
        if (this.now() < context.notBefore) continue;
        if (context.reviewPromise || context.coordinator.unsettled.size || this.now() < (live.failureRetryAt ?? 0) && !live.actions.some(action => action.status === 'queued')) continue;
        // TTL-aware wake (soft): an idle review close to due may run while the
        // provider still caches this project's prefix on this model.
        const cacheLast = this.cacheAlignedWake || cacheWakeAllowed(this.project(project.id), rhythm, { now: this.now() }) ? this.store.usageLedger?.lastRequestAt?.({ projectId: project.id, providerId: model.providerId, modelId: model.modelId }) : null, cacheTtl = cacheLast ? cacheTtlMs(model) : null;
        const cacheWindowUntil = cacheLast && cacheTtl ? cacheLast + cacheTtl : undefined;
        if (!floor.eligible && live.decisionRevision === live.revision && !live.pendingFailureReview && this.now() < live.nextReviewAt && !live.actions.some(action => action.status === 'queued') && !cacheAlignedReviewDue(live, context.coordinator.policy, this.now(), cacheWindowUntil)) continue;
        const occupied = [...this.contexts.values()].filter(row => row.reviewPromise || row.coordinator.active.size || row.coordinator.unsettled.size).length;
        if (!context.coordinator.active.size && occupied >= this.maxConcurrentReviews) continue;
        // Full conversation/learning context is input to an actual tick, not
        // an idle-clock or display-stream projection. Re-read after any policy
        // persistence above; never serve a cached permission/evidence snapshot.
        if (!this.valid(context)) continue;
        context.rhythmEvidenceKey = projectRhythmEvidenceKey(this.store.state, this.project(project.id));
        context.rhythmReferences = { allowedEvidenceIds: (context.coordinator.state.events ?? []).map(row => row.id), schedules: copy(this.project(project.id).schedules ?? []), sourceIds: this.store.state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side').map(row => `session:${row.id}`) };
        context.coordinator.project = this.snapshot(this.project(project.id), model, context.planningCapabilities, { eventIds: carriedEventIds(context.coordinator.state.events), liveActions: context.coordinator.state.actions ?? [] });
        this.cursor = (projects.findIndex(row => row.id === project.id) + 1) % Math.max(1, projects.length);
        let reschedule = false, gateOutcome = null, reviewRevision = null, actionsBefore = null;
        const saved = context.coordinator.snapshot();
        const reviewStartedAt = this.now(), tokensBefore = saved.usedTokens ?? 0;
        const gateProgress = progress.key ? { key: progress.key, foreground: progress.foreground, work: progress.work } : null;
        context.reviewPromise = (async () => {
          const revision = context.coordinator.state.revision; reviewRevision = `${context.scope}:${revision}`;
          context.judgeAbort = new AbortController(); context.wakeTier = null;
          // The judge gates only the decision (PDL-2 #3): queued work and deliveries were decided already and drain below
          // whatever it says; work queued or running, and a running turn, are input to the gate, not reasons to skip it.
          // The judge is asked only when the SDK would decide now (L1): its own reading of the same gates tick applies
          // (something changed or a review fell due, no external review or action result awaited, evidence, a model, room
          // in the history). While the coordinator would idle (a run occupying the execution slot, an uncertain result
          // awaiting the user), a judge's wake changes nothing, and asking on every pump wrote a ledger row per pump: a
          // loop, since each row's write schedules the next pump. The tick still runs and only drains.
          const decisionDue = context.coordinator.decisionDue({ cacheWindowUntil, wakeFloor: floor.eligible });
          if (wakeEligible && decisionDue) context.independentPending = false;
          // A wake already given for this exact situation is not asked again before its retry time (L1/L2): when the
          // coordinator did not decide on it (a budget too small for the request, a result it started waiting for), the
          // next pumps tick on that wake instead of writing another judgment row each.
          // Only what the project still holds is read (a source since deleted or revoked is gone from both).
          const pendingEvidence = context.pendingGateEvidence ?? [], liveIds = new Set([...sources.map(row => row.id), ...(saved.events ?? []).map(row => row.id)]);
          const unread = pendingEvidence.filter(row => liveIds.has(row.id)), situation = hash([context.scope, revision, saved.decisionRevision ?? null, gateProgress?.key ?? null, floor.eligible, unread.map(row => row.id)]);
          const remembered = context.gateWake?.situation === situation && this.now() < context.gateWake.until ? context.gateWake.gate : null;
          const gate = !saved.pendingFailureReview && wakeEligible && decisionDue
            ? remembered ?? await this.decisions?.review('initiative.review', current, { evidence: unread.length ? unread : (saved.events ?? []).slice(-6), freshCount: unread.length, revision: reviewRevision, signal: context.judgeAbort.signal, progress: gateProgress }) : null;
          gateOutcome = gate;
          // Why the host sent this wake to the main model past the judge (effort.decision never codes such a wake light).
          context.wakeBypass = gate?.bypass ?? (gate?.reason === 'commitment_overdue' ? gate.reason : null);
          if (!this.valid(context) || context.coordinator.state.revision !== revision) return { status: 'stale' };
          // The judgment read them (a stale one, overtaken by newer evidence, leaves them for the next): what arrived
          // meanwhile stays too.
          if (gate && !remembered) { const read = new Set(pendingEvidence.map(row => row.id)); context.pendingGateEvidence = (context.pendingGateEvidence ?? []).filter(row => !read.has(row.id)); }
          // Link a delivery made from this review to its JEV ledger row for feedback labels.
          context.reviewLedger = gate?.result?.ledgerId ? { id: gate.result.ledgerId, revision } : null;
          if (gate?.review === false) {
            // Deliveries and recovery drain even when the decision waits.
            if (context.coordinator.state.actions.some(action => action.status === 'queued')) await context.coordinator.tick({ presence: this.presence(this.project(project.id)), decisionEnabled: false });
            if (gate.holdUntilProgressEnd && gateProgress) context.progressHold = gateProgress.key; else context.notBefore = gate.retryAt;
            return { status: 'judgment_deferred', reason: gate.reason };
          }
          // C2: which action this decision admitted is read from what the tick added to the coordinator's actions.
          actionsBefore = new Set(context.coordinator.state.actions.map(row => row.id)); context.wakeTier = null;
          // A wake the host forces to the main model past the judge (wakeBypass: an overdue request, a delivery just completed) is never rested.
          const result = await context.coordinator.tick({ presence: this.presence(this.project(project.id)), decisionEnabled: wakeEligible, cacheWindowUntil, wakeFloor: floor.eligible, unchangedRest: !context.wakeBypass });
          if (gate?.review === true && !['decided', 'stale'].includes(result.status)) context.gateWake = { situation, gate, until: Number.isFinite(gate.retryAt) ? gate.retryAt : this.now() + GATE_WAKE_RETRY_MS };
          else if (['decided', 'stale'].includes(result.status)) context.gateWake = null;
          return result;
        })().then(result => {
          reschedule = ['decided', 'stale'].includes(result.status);
          // A decision read every event the coordinator held: none of them is new to the next judgment.
          if (result.status === 'decided') { const known = new Set((context.coordinator.state.events ?? []).map(row => row.id)); context.pendingGateEvidence = (context.pendingGateEvidence ?? []).filter(row => !known.has(row.id)); }
          // A wake the gate settled without the main model costs nothing and counts as an empty wake (Headlong: dwell, then back off).
          const wake = wakeOutcome(result);
          // A decision that saw the user's overdue requests and chose to wait declined them with its stated reason: the
          // commitment_overdue bypass stays off for them until new evidence (pursuedOverdue).
          const declined = result.status === 'decided' && result.decision?.action === 'wait' ? declineOverdue(this.project(context.projectId)?.mind, { now: this.now(), revision: reviewRevision, reason: result.decision.reason }) : null;
          // C2: the action this decision admitted (new in the coordinator's actions since before the tick), and the judgment
          // rows the wake came from, so its outcome later finds the wake that decided it and labels those rows.
          const admitted = wake?.outcome === 'work' && actionsBefore ? context.coordinator.state.actions.findLast(row => !actionsBefore.has(row.id) && !row.hostSchedule && row.action === result.decision?.action) ?? null : null;
          const judged = gateOutcome && (gateOutcome.result?.ledgerId || gateOutcome.deferredLedgerIds?.length) ? { ledgerId: gateOutcome.result?.ledgerId, deferred: gateOutcome.deferredLedgerIds } : null;
          if (wake) this.recordWake(context, wake.outcome, { startedAt: reviewStartedAt, tokensBefore, floor: floor.eligible, ...(wake.reason ? { reason: wake.reason } : {}), ...(wake.saved ? { saved: wake.saved } : {}), ...(wake.outcome !== 'deferred' ? { prompt: result.prompt ?? null } : {}), ...(Number.isFinite(result.usage?.totalTokens) ? { tokens: result.usage.totalTokens } : {}), ...(wake.outcome === 'deferred' ? {} : { reasoning: this.decisionEffortNow(context, result.reasoning ?? context.decisionEffort) }), ...(declined ? { declined } : {}),
            ...(wake.outcome === 'deferred' ? {} : { tier: context.wakeTier ?? null }), ...(admitted ? { actionId: admitted.id } : {}), ...(admitted && judged ? { gate: judged } : {}) });
          // PDL-4: a floor wake that fired and still reached no decision re-arms at its level's delay; the ladder stays put.
          else if (floor.eligible && result.status !== 'stale') this.rearmFloor(context);
          // The floor's timer waits for the end of the rest the last wait asked for, not for the ladder's next rung.
          if (wake?.reason === 'unchanged_since_wait') this.restFloor(context, result.restUntil);
          this.settleDecisionEffort(context, result.status === 'decided' ? { status: 'decided', action: result.decision?.action, admitted: result.admitted !== false, attempts: result.attempts ?? null, messageRepairs: result.messageRepairs ?? 0, reasoning: result.reasoning, usage: result.usage, latencyMs: this.now() - reviewStartedAt } : result.status === 'stale' ? { status: 'stale', reason: result.reason ?? null, usage: result.usage ?? null } : null);
          // What the main model decided labels the wake judgment (and any deferral it followed) for calibration; a
          // decision that was not admitted changed nothing, so it labels like a wait.
          if (result.status === 'decided' && gateOutcome) try { this.decisions?.labelWake?.(gateOutcome, result.admitted === false ? { ...result.decision, action: 'wait' } : result.decision); } catch { /* labels never block a review */ }
          // C2: what the admitted action already came to (a message delivered within the same tick) is read now; the rest
          // follows from the pump (outcomeUpkeep), as its records change.
          if (admitted) this.outcomeUpkeep(context, { force: true });
          if (result.status === 'decided') { context.lastSuccessAt = this.now(); context.lastErrorCode = null; this.mutate(state => { const target = state.projects.find(project => project.id === context.projectId); if (target) { target.initiativeRuntime.lastError = null; target.initiativeRuntime.lastErrorCode = null; } }); }
          if (result.status === 'blocked' && current.initiativeRuntime?.status !== result.reason) this.mutate(state => { const target = state.projects.find(project => project.id === context.projectId); if (target) { target.initiativeRuntime.status = result.reason; target.initiativeRuntime.lastError = blockedMessage(result.reason); } });
        }).catch(failure => {
          if (context.judgeAbort?.signal.aborted) { reschedule = true; return; }
          this.recordWake(context, 'failed', { startedAt: reviewStartedAt, tokensBefore, floor: floor.eligible, reason: failure.code ?? failure.message?.slice(0, 80) ?? 'initiative_error', ...(Number.isFinite(failure.usage?.totalTokens) ? { tokens: failure.usage.totalTokens } : {}), reasoning: this.decisionEffortNow(context), tier: context.wakeTier ?? null });
          this.settleDecisionEffort(context, { status: 'failed', code: failure.code ?? 'initiative_error', ...(failure.evidenceValidation?.categories ? { evidence: failure.evidenceValidation.categories } : {}), stopReason: context.coordinator.state.lastFailure?.request?.stopReason ?? null, usage: failure.usage ?? null, latencyMs: this.now() - reviewStartedAt });
          context.lastErrorCode = failure.code ?? 'initiative_error';
          if (this.valid(context)) this.mutate(state => { const target = state.projects.find(project => project.id === context.projectId); const diagnostic = context.coordinator.state.lastFailure; target.initiativeRuntime.lastError = failure.code === 'budget_exhausted' ? '主动协作预算不足，等待调整预算。' : diagnostic ? `主动理解暂未完成（${diagnostic.code}）：${diagnostic.message}；已延后重试。` : '主动理解暂未完成，已保留上下文并延后重试。'; });
        }).finally(() => { context.judgeAbort = null; context.reviewPromise = null; if (reschedule) this.schedule(); });
      }
    } finally { this.pumping = false; if (this.again) { this.again = false; this.schedule(); } }
  }
  /** Reaction labels, the daily digest and narrator upkeep (thread reactions,
   * resolution, welcome-back summary). Bounded, and write-free when idle. */
  deliveryUpkeep(context) {
    const project = this.project(context.projectId), now = this.now();
    if (!project) return;
    this.settleDirectFixes(project);
    this.offerBackgroundHelp(project);
    this.narratorUpkeep(context);
    if (!project.inbox?.length) return;
    this.postFiledShares(project);
    if (now >= (context.feedbackCheckAt ?? 0)) {
      context.feedbackCheckAt = now + this.feedbackCheckIntervalMs;
      settleDeliveryFeedback(this.store, project.id, { decisions: this.decisions, now, mutate: fn => this.mutate(fn) });
      // C3: a reply the focused question `reply.target` has not read yet is asked now and settled when answered (one pass at a time).
      if (!context.attributing && this.decisions?.enabled?.('reply.target') === true) {
        context.attributing = true;
        void attributeReplies(this.store, project.id, { decisions: this.decisions, now, mutate: fn => this.mutate(fn) }).catch(() => {}).finally(() => { context.attributing = false; });
      }
    }
    if (!digestDue(project, now).length) return;
    const presence = this.presence(project);
    if (this.deliveryGate(project, presence)) return;
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id), session = state.sessions.find(row => row.id === presence.session.id);
      if (!target || !session || session.archivedAt) return;
      const rows = digestDue(target, now); if (!rows.length) return;
      const at = new Date(now).toISOString(), id = randomUUID();
      // `lines`: each entry's line exactly as the text renders it, so a client shows the items without parsing the (language-dependent) header.
      session.items.push({ id, turnId: null, kind: 'assistant', text: composeDigest(rows, interfaceLanguageOf(state)), createdAt: at, simulated: false, source: 'initiative', projectId: target.id, decisionMode: 'rna-model', initiative: { kind: 'digest', reach: 'digest', entryIds: rows.map(row => row.id), lines: digestLines(rows) } });
      for (const row of rows) Object.assign(row, { heldForDigest: false, digestedAt: at, digestItemId: id, digestSessionId: session.id });
      session.updatedAt = at; target.initiative.lastSpokeAt = at;
    });
  }
  narratorSessions(projectId, state = this.store.state) { return state.sessions.filter(session => session.projectId === projectId && !session.archivedAt && session.kind !== 'side'); }
  narratorSignals(project) {
    const live = this.store.presences?.get(project.id), present = live && Date.parse(live.expiresAt) > this.now() ? live : null;
    if (present?.visible) this.lastSeen.set(project.id, this.now());
    return pacingSignals(project, this.narratorSessions(project.id), { now: this.now(), presence: present, lastSeenAt: this.lastSeen.get(project.id) ?? null, lifecycle: project.rhythmRuntime?.assessment?.lifecycle ?? null,
      evidenceTimes: (project.initiativeRuntime?.sdkState?.events ?? []).map(row => row.at).filter(Number.isFinite) });
  }
  /** Thread reactions and resolution, then held items as one welcome-back message. */
  narratorUpkeep(context) {
    const project = this.project(context.projectId), mind = project?.mind;
    // A latched question whose thread is gone (and with it every thread) is un-latched all the same.
    if (!mind || !Array.isArray(mind.threads) || !mind.threads.length) { if (project) this.releaseHeldAsks(context); return; }
    const now = this.now(), sessions = this.narratorSessions(project.id);
    const language = interfaceLanguageOf(this.store.state);
    const reactions = threadReactions(project, sessions), closes = resolveThreads(project, { now, language });
    if (reactions.size || closes.length) {
      const signals = this.narratorSignals(project), presence = this.presence(project), speak = !signals.away && !signals.night && !this.deliveryGate(project, presence);
      this.mutate(state => {
        const target = state.projects.find(row => row.id === project.id); if (!target) return;
        applyReactions(target, reactions, now);
        const itemIds = {}, session = speak && presence.session && state.sessions.find(row => row.id === presence.session.id && !row.archivedAt);
        // A brief close only where the thread left the user waiting; otherwise the thread resolves silently.
        for (const row of closes) if (row.close && session) {
          const id = randomUUID(), at = new Date(now).toISOString(); itemIds[row.threadId] = id;
          session.items.push({ id, turnId: null, kind: 'assistant', text: row.close, createdAt: at, simulated: false, source: 'initiative', projectId: target.id, decisionMode: 'rna-model', initiative: { kind: 'thread_close', reach: 'inline', threadId: row.threadId, title: row.title, resolution: row.resolution, status: row.status } });
          session.updatedAt = at;
        }
        applyResolution(target, closes, { now, itemIds, sessionId: session?.id ?? null });
      });
    }
    this.releaseHeldAsks(context);
    const current = this.project(project.id), signals = this.narratorSignals(current), held = welcomeBackDue(current, signals);
    if (!held.length) return;
    const presence = this.presence(current);
    if (this.deliveryGate(current, presence) || !presence.session) return;
    const { text, topics, overflowCount, shown, filed } = composeWelcomeBack(held, language);
    // C2: the message carries the held messages of these actions: their delivery is credited to them (work-outcome.mjs),
    // never counted again as an action of its own (its receipt is `welcome-back:<id>`, no action).
    const credited = [...new Set(shown.map(row => row.actionId).filter(id => typeof id === 'string' && id))];
    this.mutate(state => {
      const target = state.projects.find(row => row.id === current.id), session = state.sessions.find(row => row.id === presence.session.id);
      if (!target || !session || session.archivedAt) return;
      const due = welcomeBackDue(target, signals), ids = new Set(held.map(row => row.id));
      if (!due.length || due.some(row => !ids.has(row.id))) return;
      const at = new Date(now).toISOString(), id = randomUUID();
      session.items.push({ id, turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId: target.id, decisionMode: 'rna-model', initiative: { kind: 'welcome_back', reach: 'inline', threadIds: topics.map(topic => topic.threadId), topics: topics.map(({ threadId, title, text: body, deliverables }) => ({ threadId, title, text: body, ...(deliverables ? { deliverables } : {}) })), overflowCount, narrated: { version: 2, count: held.length }, ...(credited.length ? { actionIds: credited } : {}) } });
      const entry = recordDelivery(target, { actionId: `welcome-back:${id}`, kind: 'share', tier: 'inline', text, sessionId: session.id, itemId: id, now });
      if (credited.length) entry.creditedActionIds = credited;
      entry.threadIds = topics.map(topic => topic.threadId); entry.pacing = { at, kind: 'welcome_back', outcome: 'send', reasons: ['welcome_back'], count: held.length };
      // Topics beyond the summary are filed quietly, never dropped.
      for (const row of filed) Object.assign(recordDelivery(target, { actionId: row.actionId ?? `held:${row.id}`, kind: 'share', tier: 'inbox', reasons: ['welcome_back_overflow'], text: row.text, sessionId: session.id, now }), { threadId: row.threadId, pacing: { at, kind: row.kind ?? 'share', threadId: row.threadId, outcome: 'inbox', reasons: ['welcome_back_overflow'], value: row.value ?? null } });
      applyWelcomeBack(target, held, { itemId: id, sessionId: session.id, now });
      trimInbox(this.store, target);
      session.updatedAt = at; target.initiative.lastSpokeAt = at;
    });
  }
  /**
   * F4: questions held for the user's return (heldAsks). Harness agent.ts:213-232 latches a wake behind the work in
   * progress and replays it once that settles, instead of polling: a held question's SDK action waits on a long retry
   * (HELD_ASK_RETRY_MS) and is replayed here, on the welcome-back's condition (the user is here or wrote since, not their
   * night, not typing, delivery not gated), by clearing its retry time; the next drain publishes it from its narration
   * record. A record whose action is gone (superseded by newer evidence, cancelled, archived), or whose thread is no
   * longer open (resolved, muted, pruned), leaves its thread; a latched question left without a record in an open thread
   * is un-latched and narrated afresh on the next drain, unless it was narrated less than one backstop ago: then its
   * backstop narrates it. A question is never narrated more often than the ten-minute retry it had before F4, whatever
   * keeps taking its record away (a thread that resolves again as soon as the hold reopens it).
   */
  releaseHeldAsks(context) {
    const project = this.project(context.projectId), threads = Array.isArray(project?.mind?.threads) ? project.mind.threads : [];
    const actions = context.coordinator.state.actions ?? [], live = row => actions.find(action => action.id === row.actionId && ['queued', 'running'].includes(action.status));
    const stale = new Set(threads.flatMap(thread => (Array.isArray(thread.heldAsks) ? thread.heldAsks : []).filter(row => thread.status !== 'open' || !live(row)).map(row => row.id)));
    if (stale.size) this.mutate(state => { for (const thread of state.projects.find(row => row.id === project.id)?.mind?.threads ?? []) if ((thread.heldAsks ?? []).some(row => stale.has(row.id))) thread.heldAsks = thread.heldAsks.filter(row => !stale.has(row.id)); });
    const asks = heldAsks(this.project(context.projectId)?.mind), recorded = new Set(asks.map(row => row.actionId));
    // When each question was last narrated into a hold (in memory: after a restart a question is narrated at most once
    // more, at once, then its backstop paces it). Entries leave with their queued question.
    const narrated = context.heldAskNarratedAt ??= new Map();
    for (const id of narrated.keys()) if (!actions.some(action => action.id === id && ['queued', 'running'].includes(action.status))) narrated.delete(id);
    let replay = false;
    for (const action of actions) if (action.action === 'ask' && action.status === 'queued' && action.nextAttemptAt && HELD_ASK_LATCHES.has(action.deferredReason) && !recorded.has(action.id)
      && !(this.now() - (narrated.get(action.id) ?? -Infinity) < HELD_ASK_RETRY_MS)) { delete action.nextAttemptAt; replay = true; }
    const presence = this.presence(project);
    if (asks.length && !this.deliveryGate(project, presence) && presence.session) {
      const signals = this.narratorSignals(project);
      for (const row of asks) { const action = live(row); if (action?.status === 'queued' && action.nextAttemptAt && heldAskDue(row, signals)) { delete action.nextAttemptAt; replay = true; } }
    }
    if (replay) this.schedule();
  }
  /** While decisions are held (PDL-2), queued deliveries, work and recovery still drain: a tick with no decision. */
  async drainHeld(context, projectId) {
    const coordinator = context.coordinator;
    if (context.reviewPromise || coordinator.ticking || coordinator.unsettled.size || !coordinator.state.actions.some(action => action.status === 'queued')) return;
    context.reviewPromise = coordinator.tick({ presence: this.presence(this.project(projectId)), decisionEnabled: false })
      .catch(failure => { context.lastErrorCode = failure?.code ?? 'initiative_error'; })
      .finally(() => { context.reviewPromise = null; });
    await context.reviewPromise;
  }
  /**
   * Background wake ladder (Headlong): empty wakes back off, failures step down, and (C2, option C) only a visible
   * outcome resets it: an admitted decision is recorded as pending here and the ladder moves when the action's outcome
   * does (outcomeUpkeep, applyWorkOutcome). `tokens`: the decision's own usage when the SDK reported it (a background run
   * finishing meanwhile no longer counts toward the wake); otherwise the project's usage since the review started.
   * `reasoning`: the effort the decision ran at. `declined`: the overdue requests a waiting decision declined
   * (declineOverdue), kept on the pacing record. `tier`: the shadow tier (wakeTier, computed from facts); `actionId`,
   * `gate`: the action a work-like decision admitted and the judgment rows it came from.
   * The row goes to the wake log (`<state>.rna/metrics/wakes.jsonl`); state keeps only the newest WAKE_STATE_TAIL.
   */
  recordWake(context, outcome, { startedAt, tokensBefore = 0, floor = false, reason, prompt = null, tokens = null, reasoning = null, declined = null, tier = null, actionId = null, gate = null, saved = null } = {}) {
    if (!this.valid(context)) return;
    try { this.mutate(state => {
      const target = state.projects.find(row => row.id === context.projectId); if (!target) return;
      const mind = ensureMind(target), used = target.initiativeRuntime?.sdkState?.usedTokens ?? tokensBefore;
      mind.pacing.wake = advanceWake(mind.pacing.wake, outcome, { now: this.now(), tokens: Number.isFinite(tokens) ? Math.max(0, tokens) : Math.max(0, used - tokensBefore), latencyMs: Number.isFinite(startedAt) ? this.now() - startedAt : null, floor, reason, prompt, reasoning: reasoning?.effective ? reasoning : null, tier, actionId, gate, saved });
      if (declined) mind.pacing.overdueDeclined = declined;
      // The row is in the wake log (a file, appended) before state forgets any row past its tail; a start imports whatever
      // a failed append left (WakeLog.absorb).
      const history = mind.pacing.wake.history;
      if (this.wakeLog.append(context.projectId, copy(history.at(-1))) && history.length > WAKE_STATE_TAIL) mind.pacing.wake.history = history.slice(-WAKE_STATE_TAIL);
    }); } catch { /* pacing bookkeeping never blocks a review */ }
  }
  /**
   * C2 (plan §2.2 C2; Headlong monolith/step:357-373, 582-586): read what became of the actions this project's wakes
   * admitted, persist the transitions (work-outcome.mjs: one per action whose outcome moved, never twice), and feed the
   * two things that follow from them: the wake ladder (a visible outcome resets it, applyWorkOutcome) and the calibration
   * labels (PDL-7: the outcome, not the model's own next decision, labels the judgments behind the wake). Bounded and
   * write-free when nothing changed; every `outcomeCheckIntervalMs`, or at once when `force`.
   */
  outcomeUpkeep(context, { force = false } = {}) {
    const now = this.now(), project = this.project(context.projectId);
    if (!project || project.simulated === true || !this.valid(context, { enabled: false })) return;
    if (!force && now < (context.outcomeCheckAt ?? 0)) return;
    context.outcomeCheckAt = now + this.outcomeCheckIntervalMs;
    let read;
    try {
      const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && row.kind !== 'side');
      read = this.outcomeLog.reconcile(project, sessions, { now, state: this.store.state, wake: id => this.wakeLog.byAction(project.id, id) });
    } catch { return; /* the view is recomputed from the records: the next pass reads it again */ }
    // The ladder, in the order the outcomes came; only the actions a wake of this project decided move it (and applyWorkOutcome
    // leaves it alone for a neutral cancellation: the user's stop, a restart, a scope change).
    const moving = read.transitions.filter(row => row.to !== 'pending' && this.wakeLog.byAction(project.id, row.actionId)).sort((a, b) => a.at - b.at);
    if (moving.length) try { this.mutate(state => { const target = state.projects.find(row => row.id === project.id); if (!target) return; const mind = ensureMind(target); for (const row of moving) mind.pacing.wake = applyWorkOutcome(mind.pacing.wake, row, { now }); }); } catch { /* pacing bookkeeping never blocks a review */ }
    // The labels: every action whose record changed (an outcome moved, or a delivery was reacted to) labels its wake's rows.
    const memo = context.outcomeLabelled ??= new Map();
    for (const [id, record] of read.records) {
      const wake = this.wakeLog.byAction(project.id, id), key = `${record.outcome}|${record.reaction ?? ''}`;
      if (!wake || memo.get(id) === key) continue;
      memo.set(id, key);
      for (const label of outcomeLabels(record, wake)) try { this.decisions?.labelOutcome?.(label.id, label.value); } catch { /* labels never block a review */ }
    }
  }
  /** A floor wake rested on the last wait's own rest (SDK MAX_REST_MS): the floor's next wake is the end of that rest, never earlier than the ladder's timer. */
  restFloor(context, restUntil) {
    if (!this.valid(context) || !Number.isFinite(restUntil)) return;
    try { this.mutate(state => { const target = state.projects.find(row => row.id === context.projectId); if (!target) return; const wake = ensureMind(target).pacing.wake, current = Date.parse(wake.nextAt); if (Number.isFinite(current) && restUntil <= current) return; wake.nextAt = new Date(restUntil).toISOString(); }); } catch { /* pacing bookkeeping never blocks a review */ }
  }
  /** PDL-4: re-arm the floor's timer after a floor wake that reached no decision; level, ticks and quiet count stay put. */
  rearmFloor(context) {
    if (!this.valid(context)) return;
    try { this.mutate(state => { const target = state.projects.find(row => row.id === context.projectId); if (!target) return; const mind = ensureMind(target); mind.pacing.wake = rearmWake(mind.pacing.wake, { now: this.now() }); }); } catch { /* pacing bookkeeping never blocks a review */ }
  }
  /**
   * The tier this wake would run on (proactive-pacing.mjs wakeTier), computed from facts the host holds, never judged
   * (plan C2: "the tier is computed in code from facts … only recorded: shadow mode, no behaviour change, no JEV routing").
   * `input`: the decision hook's input (the evidence it will read, the last decision, whether it reviews a failure).
   * Headlong's request tier (monolith/step:425-441) is a wake that serves a person: a reactive wake, or one with an open
   * pending request; here, the facts that say so:
   *  - conversation_outcome: a foreground turn's result is among the evidence that arrived since the last decision;
   *  - proactive_reply: a user message that arrived since then targets one of the initiative's own items or threads
   *    (`capture.target`, named by JEV or the fast model: a regex fallback's guess is not a fact);
   *  - open_commitment, overdue_commitment: a request of the user's is open (openWork), or past its due time;
   *  - failure_review: the wake reviews a failed action;
   *  - answered_card: a question card the initiative put up was answered since then.
   */
  wakeTierFor(project, input = {}) {
    const events = Array.isArray(input.events) ? input.events : [], last = input.lastDecision, lastAt = Number.isFinite(last?.at) ? last.at : -Infinity;
    const fresh = events.filter(event => Number.isFinite(event?.at) ? event.at > lastAt : !(last?.evidenceIds ?? []).includes(event?.id));
    const open = typeof this.decisions?.openWork === 'function' ? this.decisions.openWork(project) : {};
    const sessions = this.store.state.sessions.filter(row => row.projectId === project.id && row.kind !== 'side' && !row.archivedAt);
    const items = new Map(sessions.flatMap(session => (session.items ?? []).map(item => [item.id, item]))), threads = new Set((project.mind?.threads ?? []).map(thread => thread.id));
    const reaction = event => {
      if (event?.type !== 'user_message') return false;
      const target = items.get(String(event.id).replace(/^message:/, ''))?.capture;
      if (!target?.target || target.targetSource === 'heuristic') return false;
      return target.target.kind === 'thread' ? threads.has(target.target.threadId) : proactiveRowKind(items.get(target.target.itemId)) === 'delivery';
    };
    const answered = sessions.some(session => (session.items ?? []).some(item => item.kind === 'question' && item.interaction?.source === 'initiative' && item.interaction.status === 'answered' && Date.parse(item.interaction.answeredAt) > lastAt));
    return wakeTier({ conversationOutcome: fresh.some(event => event?.type === 'conversation_result'), proactiveReply: fresh.some(reaction), openCommitment: (open.commitments ?? 0) > 0, overdueCommitment: (open.overdue ?? 0) > 0, failureReview: input.failureReview === true, answeredCard: answered });
  }
  /**
   * The decision's effort (InitiativeCoordinator decisionReasoning hook). The wake's facts are computed here; the
   * returned record rides on the decision's outcome (wake row, lastDecision, the decision record).
   */
  async decisionReasoning(context, input = {}) {
    context.decisionEffort = null; context.decisionEffortRecord = null;
    const current = this.project(context.projectId);
    if (!current || !this.valid(context)) return undefined;
    // C2 (shadow): the tier this wake would run on, from the same facts the effort route reads; recorded on its wake row.
    try { context.wakeTier = this.wakeTierFor(current, input); } catch { context.wakeTier = null; }
    const { signal, lastDecision: _last, failureReview: _review, ...request } = input;
    const built = decisionEffortInput(input, { openWork: typeof this.decisions?.openWork === 'function' ? this.decisions.openWork(current) : {}, bypass: context.wakeBypass ?? null });
    const routed = await this.internalReasoning(context, 'decision', built, { signal, request });
    // A copy for the wake and the capture; the route's own record is kept to read a shadow verdict that arrives later.
    context.decisionEffort = { effective: routed.reasoning, ...routed.record }; context.decisionEffortRecord = routed.record ?? null;
    return routed;
  }
  /**
   * The decision's effort as its wake row records it: `base` (the decision outcome's copy, else the copy taken at the
   * route) plus the shadow verdict that reached the route's record since (internal-reasoning: `record.shadow` turns into
   * `{ effort, depth }` when JEV answers), so the per-effort monitor can set today's effort beside JEV's choice.
   */
  decisionEffortNow(context, base = context.decisionEffort) {
    const live = context.decisionEffortRecord?.shadow;
    if (!base) return null;
    return live && typeof live === 'object' && !(base.shadow && typeof base.shadow === 'object') ? { ...base, shadow: { ...live } } : base;
  }
  /** One internal call's effort for this project (internal-reasoning.mjs): { reasoning, record }; never throws. */
  async internalReasoning(context, purpose, call, { signal, request = null } = {}) {
    const project = this.project(context.projectId), model = context.coordinator?.model;
    if (!project || !model) return { reasoning: model?.reasoning ?? 'default', record: { source: 'fallback', reason: 'no_project' } };
    try {
      const sessionIds = this.store.state.sessions.filter(session => session.projectId === project.id && session.kind !== 'side').map(session => session.id);
      return await reasoningFor({ decisions: this.decisions, configuration: this.store.state.configuration, project, model, purpose, call, projectSelection: project.initiative?.modelSelection ?? null, capture: this.effortCapture, sessionIds, request, signal });
    } catch { return { reasoning: model.reasoning ?? 'default', record: { source: 'fallback', reason: 'route_failed' } }; }
  }
  /** An applied effort verdict's label: by default an outcome (what the run did); `source: 'self'` when a judgment of ours read it. */
  labelEffort(effort, adequate, { source } = {}) { if (effort?.source === 'jev' && effort.ledgerId) try { this.decisions?.labelEffort?.(effort.ledgerId, adequate ? 'adequate' : 'inadequate', ...(source ? [{ source }] : [])); } catch { /* labels never block a run */ } }
  /** What became of a decision whose effort was routed: its capture row gets the outcome, an applied verdict its label. */
  settleDecisionEffort(context, outcome) {
    const effort = context.decisionEffort; context.decisionEffort = null; context.decisionEffortRecord = null;
    if (!effort || !outcome) return;
    if (effort.captureId) try { this.effortCapture.outcome(context.projectId, 'decision', effort.captureId, outcome); } catch { /* capture never blocks a review */ }
    if (effort.source === 'jev' && effort.ledgerId && outcome.status !== 'stale') {
      // Adequate: the first attempt, at the routed effort, was valid (no repair, no retry after a truncation).
      const adequate = outcome.status === 'decided' && outcome.attempts === 1 && !(outcome.messageRepairs > 0) && !outcome.reasoning?.escalated;
      try { this.decisions?.labelEffort?.(effort.ledgerId, adequate ? 'adequate' : 'inadequate'); } catch { /* labels never block a review */ }
    }
  }
  /** Files the background agent declared with `project_present` for an action (deliverable cards). */
  presented(project, actionIds = []) {
    const ids = new Set(actionIds);
    return (project.jobs ?? []).filter(job => ids.has(job.id)).flatMap(job => job.presented ?? []).slice(0, 8);
  }
  /** The agent's single self-revision turn after the judge flagged its message (same project model, writing contract, the user's lessons). */
  async reviseMessage(context, { text, violations, deliverable, signal, usage }) {
    if (!this.narratorProvider || !violations.length) return null;
    // Metered as its own purpose (it used to be counted as a decision); its effort is routed like every internal call.
    const project = this.project(context.projectId), provider = purposeProvider(this.store, this.narratorProvider, 'narrator', { projectId: context.projectId });
    const lessons = standingLessons(project.mind).slice(-8);
    // `request`: what the rewrite is given, kept only by the opt-in capture (the Stage B replay rebuilds the prompt from it).
    const routed = await this.internalReasoning(context, 'narrator', narratorEffortInput({ text, violations, scheduled: true, deliverable }), { signal, request: { text, violations: violations.map(row => ({ code: row.code, repair: row.repair })), deliverable, lessons: lessons.map(row => ({ text: String(row.text ?? '') })) } });
    const model = { ...context.coordinator.model, reasoning: routed.reasoning };
    context.narratorEffort = { effective: routed.reasoning, ...routed.record };
    const systemPrompt = `You are the project agent revising your own message to the user. ${WRITING_CONTRACT}`, prompt = revisionPrompt({ text, violations, deliverable, lessons }), estimatedInputTokens = Math.ceil((Buffer.byteLength(systemPrompt) + Buffer.byteLength(prompt)) / 3);
    let output = '', streamed = 0, last = null, streamedAtReport = 0, completed = false, answered = false, unbilled = false, stopReason = null, result = 'empty';
    const before = usage.totalTokens, started = performance.now();
    try {
      for await (const event of provider({ model, apiKey: context.coordinator.apiKey, systemPrompt, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: this.now() }], tools: [], signal, cache: { sessionKey: `narrator:${context.projectId}`, prefixHash: 'rna-narrator-v2' }, estimatedInputTokens })) {
        if (!PRE_RESPONSE_EVENTS.has(event.type)) answered = true;
        if (event.type === 'text_delta') { output += event.delta || ''; streamed += Buffer.byteLength(event.delta || ''); }
        else if (event.type === 'thinking_delta') streamed += Buffer.byteLength(typeof event.delta === 'string' ? event.delta : '');
        // Usage events are cumulative per request (Anthropic sends one at message_start and one at the end): the last one counts, once.
        else if (event.type === 'usage') { last = event.usage; streamedAtReport = streamed; }
        else if (event.type === 'error') { result = 'error'; return null; }
        // A revision cut off by the output limit would lose the message's end: the original is delivered instead.
        else if (event.type === 'done') { completed = true; stopReason = typeof event.stopReason === 'string' ? event.stopReason : null; if (stopReason === 'length') { result = 'length'; return null; } }
      }
    } catch (failure) {
      result = 'error';
      // A local refusal or an HTTP rejection (after the SDK's retries) before any answer was never billed (ACC-1).
      unbilled = !answered && UNBILLED_FAILURES.has(failure?.code);
      if (signal?.aborted) throw failure; return null;
    }
    finally {
      if (last) {
        // Reported: the last report, plus the output that streamed after it when the request was cut off (ACC-2).
        const extra = unreportedOutput({ completed, streamed, streamedAtReport });
        usage.totalTokens += Math.max(0, Number(last.totalTokens) || 0) + extra;
        if (extra) usage.estimatedTokens = (usage.estimatedTokens ?? 0) + extra;
      } else if (!unbilled) { const estimate = estimatedInputTokens + Math.ceil(streamed / 3); usage.totalTokens += estimate; usage.estimatedTokens = (usage.estimatedTokens ?? 0) + estimate; }
      if (output.trim() && result === 'empty') result = 'revised';
      context.narratorEffort.call = { result, stopReason, tokens: usage.totalTokens - before, latencyMs: Math.round(performance.now() - started) };
    }
    return output.trim() || null;
  }
  /** F1: the full final response of a scheduled run, kept on its job until the occurrence settles; null for a run that
   * left no report or ran before the job kept it. */
  scheduledResult(project, occurrence) {
    const job = occurrence?.actionId ? project?.jobs?.find(row => row.id === occurrence.actionId) : null;
    return job && !job.contextRevoked && !job.sourceDeleted && typeof job.deliveryText === 'string' && job.deliveryText.trim() ? job.deliveryText : null;
  }
  /** A model-facing excerpt the user is about to read: the omission marker (it names a model tool) becomes a note in the interface language. */
  userFacingExcerpt(text) {
    const value = String(text ?? '');
    return value.includes(EXCERPT_MARKER) ? value.split(EXCERPT_MARKER).join(inLanguage(interfaceLanguageOf(this.store.state), { zh: '\n\n（中间有一部分没能保留下来。）\n\n', en: '\n\n(Part of the middle could not be kept.)\n\n' })) : value;
  }
  /** Full scheduled results whose occurrence has settled (delivered, failed, cancelled, archived) leave the job: the
   * conversation message holds the delivered text from then on. */
  dropDeliveredTexts(projectId) {
    const project = this.project(projectId), live = new Set((project?.scheduleRuntime?.occurrences ?? []).filter(row => !OCCURRENCE_SETTLED.includes(row.status)).map(row => row.actionId));
    if (!(project?.jobs ?? []).some(job => typeof job.deliveryText === 'string' && !live.has(job.id))) return;
    this.mutate(state => { for (const job of state.projects.find(row => row.id === projectId)?.jobs ?? []) if (typeof job.deliveryText === 'string' && !live.has(job.id)) delete job.deliveryText; });
  }
  /** The task a handoff names. The next decision reads handoffs too, so model-written work keeps its whole instruction;
   * a scheduled run is named by its schedule instead of the host's instruction to the worker. */
  handoffTask(context, action) { return action?.hostSchedule ? this.actionName(this.project(context.projectId), action, { language: 'zh' }) : action?.content; }
  /** How a background action is named wherever the user reads it (see actionLabel: its decision's title, else …); the model's own words are redacted. */
  actionName(project, action, { limit = 160, language = interfaceLanguageOf(this.store.state), quoted = false } = {}) {
    const redact = value => typeof this.redact === 'function' ? this.redact(value) : String(value ?? '');
    return actionLabel(project, action?.hostSchedule ? action : { ...action, content: redact(action?.content), ...(typeof action?.title === 'string' ? { title: redact(action.title) } : {}) }, { limit, language, quoted });
  }
  redact(text) { let value = String(text ?? ''); for (const secret of this.redactValues()) if (secret && secret.length >= 4) for (const form of [secret, encodeURIComponent(secret)]) value = value.split(form).join('[REDACTED]'); return value; }
  /** Narrator plan for one share/ask/scheduled delivery. The text is the agent's own; the host only redacts, checks (JEV) and paces. */
  async narrateAction(context, action, kind, signal) {
    const project = this.project(context.projectId), usage = { totalTokens: 0 };
    const workIds = (action.evidenceIds ?? []).map(id => /^action:(.+):completed$/.exec(id)?.[1]).filter(Boolean);
    let candidate = { kind, text: this.redact(action.content ?? ''), evidenceIds: action.evidenceIds ?? [], reason: action.reason, actionId: action.id, requestedTier: action.urgency, ...(action.resolves ? { resolves: action.resolves } : {}) };
    if (kind === 'ask') candidate.text = this.redact([action.content, ...(action.questions ?? []).map(row => row.question ?? row.header)].filter(Boolean).join('\n'));
    let deliverable = null;
    if (action.hostSchedule) {
      const schedule = project.schedules?.find(row => row.id === action.hostSchedule.scheduleId) ?? {}, occurrence = project.scheduleRuntime?.occurrences?.find(row => row.key === action.hostSchedule.key);
      const work = occurrence && context.coordinator.state.actions.find(row => row.id === occurrence.actionId);
      if (occurrence?.actionId) workIds.push(occurrence.actionId);
      deliverable = [schedule.title, schedule.task].filter(Boolean).join(' — ');
      // The worker's final response is the message (Pi/Harness), whole (F1: the job's full text, not the model-facing
      // excerpt), without the host-protocol handoff line (removed when the job kept it). An older run has only the
      // excerpt: its marker is for models (it names project_history), so the user reads a note in their language instead.
      const full = this.scheduledResult(project, occurrence);
      candidate = { ...candidate, kind: 'schedule', schedule, occurrenceKey: action.hostSchedule.key, text: this.redact(full ?? stripHandoff(this.userFacingExcerpt(work?.resultSummary ?? String(action.content ?? '').slice(String(schedule.title ?? '').length)))) };
      const sessions = this.narratorSessions(project.id);
      const violations = (await checkedMessageViolations(project, sessions, candidate.text, { now: this.now(), decisions: this.decisions, signal, deliverable })).filter(row => row.source === 'jev');
      if (violations.length) {
        // The reviser rewrites the whole message or nothing: one longer than its window is delivered as written.
        const revised = candidate.text.length <= REVISION_TEXT_LIMIT ? await this.reviseMessage(context, { text: candidate.text, violations, deliverable, signal, usage }) : null;
        candidate.revision = { codes: violations.map(row => row.code), revised: Boolean(revised) };
        if (revised) {
          candidate.text = this.redact(revised);
          // The same JEV check on the revision (cheap): the live pass rate of rewrites, and the label of a routed effort.
          // Null when it could not be checked (judge off, no verdict, an error, the budget): neither a pass nor a label.
          // It stays on the delivery path (≤ MESSAGE_CHECK_BUDGET_MS after a rewrite that took seconds) because the
          // delivered message records it (revision.recheck, the §7 pass-rate metric).
          try { candidate.revision.recheck = await messageRecheck(project, sessions, candidate.text, { now: this.now(), decisions: this.decisions, signal, deliverable }); } catch { candidate.revision.recheck = null; }
          // The recheck is a JEV verdict, the system's own next judgment, not something that happened: a `self` label.
          if (Array.isArray(candidate.revision.recheck)) this.labelEffort(context.narratorEffort, candidate.revision.recheck.length === 0, { source: 'self' });
        }
        if (context.narratorEffort?.effective) candidate.revision.reasoning = { effective: context.narratorEffort.effective, source: context.narratorEffort.source ?? 'configured' };
        // The captured rewrite's outcome (Stage B compares a replay at the JEV-chosen effort with it).
        if (context.narratorEffort?.captureId) try { this.effortCapture.outcome(context.projectId, 'narrator', context.narratorEffort.captureId, { status: revised ? 'revised' : 'kept', recheck: candidate.revision.recheck ?? null, ...(context.narratorEffort.call ?? {}) }); } catch { /* capture never blocks a delivery */ }
        context.narratorEffort = null;
      }
    }
    const presented = this.presented(project, workIds); if (presented.length) candidate.deliverables = presented;
    const sessions = this.narratorSessions(project.id), live = this.store.presences?.get(project.id);
    const plan = await narrate({ project, sessions, candidate, decisions: this.decisions, now: this.now(), presence: live && Date.parse(live.expiresAt) > this.now() ? live : null, lastSeenAt: this.lastSeen.get(project.id) ?? null,
      recentTexts: recentDeliveries(project, sessions, { now: this.now(), limit: 48 }).map(row => row.text), lifecycle: project.rhythmRuntime?.assessment?.lifecycle ?? null, projectKind: projectKindOf(project, { deliverable }),
      evidenceTimes: (project.initiativeRuntime?.sdkState?.events ?? []).map(row => row.at).filter(Number.isFinite), language: interfaceLanguageOf(this.store.state), signal });
    return { plan, usage };
  }
  /** Commit a narration that delivers nothing now (drop or hold) with its pacing record. */
  commitNarration(context, plan) {
    if (!this.valid(context)) return;
    this.mutate(state => { const target = state.projects.find(row => row.id === context.projectId); if (target) applyNarration(target, plan, { now: this.now(), delivered: false }); });
  }
  ask(context, action, { signal }) {
    signal.throwIfAborted();
    if (!this.valid(context) || action.revision !== context.coordinator.state.revision) return { superseded: true, usage: { totalTokens: 0 } };
    const project = this.project(context.projectId), presence = this.presence(project);
    const gate = context.coordinator._shareGate(presence, 'ask');
    if (gate) return { deferred: true, reason: gate, usage: { totalTokens: 0 } };
    // F4: a question held for the user's return was narrated (and judged by plan.better) once, when it was held. It goes
    // out from that record once the user is here again (releaseHeldAsks replays it), and is never narrated again meanwhile.
    const held = heldAsks(project.mind).find(row => row.actionId === action.id);
    if (held) return heldAskDue(held, this.narratorSignals(project)) ? this.publishAsk(context, action, this.releasedPlan(project, held), { totalTokens: 0 }) : { deferred: true, reason: 'narrator_held', retryAfterMs: HELD_ASK_RETRY_MS, usage: { totalTokens: 0 } };
    return this.narrateAction(context, action, 'ask', signal).then(async ({ plan, usage }) => {
      signal.throwIfAborted();
      if (!this.valid(context) || action.revision !== context.coordinator.state.revision) return { superseded: true, usage };
      // plan.better: a question proposing a different approach from the user's is shown only unless theirs is confidently not worse.
      if (!action.permissionRequest && plan.outcome !== 'drop' && typeof this.decisions?.planBetter === 'function') {
        const lastUser = [...(presence.session?.items ?? [])].reverse().find(item => item.kind === 'user' && (!item.source || item.source === 'user') && item.text?.trim());
        const question = [action.content, ...(action.questions ?? []).map(row => `${row.question ?? ''} ${(row.options ?? []).map(option => option.label).join(' / ')}`)].filter(Boolean).join('\n');
        const judged = lastUser ? await Promise.race([this.decisions.planBetter(project, { question, userApproach: lastUser.text, evidence: action.reason ?? '', signal }).catch(() => null), new Promise(resolve => { const timer = setTimeout(() => resolve(null), 3000); timer.unref?.(); })]) : null;
        if (judged?.suppress) return { superseded: true, reason: 'not_clearly_better', usage };
      }
      // A question is never silently turned into a statement: it waits for the user's return, or is dropped as already asked.
      if (plan.outcome === 'drop') { this.commitNarration(context, plan); return { superseded: true, reason: plan.reasons.find(reason => ['already_reported', 'thread_muted', 'below_threshold', 'exact_duplicate'].includes(reason)) ?? 'below_threshold', usage }; }
      // Held (only for the user's absence: away or night; pacingDecision sends a question in the band out): one narration
      // record in its thread, then the action waits (latched) until releaseHeldAsks replays it on the user's return.
      if (plan.outcome === 'hold') { this.commitNarration(context, plan); (context.heldAskNarratedAt ??= new Map()).set(action.id, this.now()); return { deferred: true, reason: `narrator_${plan.reasons[0] ?? 'hold'}`, retryAfterMs: HELD_ASK_RETRY_MS, usage }; }
      return this.publishAsk(context, action, plan, usage);
    });
  }
  /**
   * The narration plan a held question goes out with (F4): its committed record (text, value, finding, thread), sent now
   * with the reason `held_released` and the pacing signals of the moment it is released.
   */
  releasedPlan(project, held) {
    const signals = this.narratorSignals(project), threshold = pacingThreshold(signals);
    const thread = (project.mind?.threads ?? []).find(row => row.id === held.threadId) ?? { id: held.threadId, title: held.threadTitle };
    return { version: NARRATOR_VERSION, outcome: 'send', reasons: ['held_released'], text: held.text, thread: copy(thread), threadCreated: false, via: 'held', continuing: (thread.messageItemIds?.length ?? 0) > 0,
      finding: held.finding, value: held.value ?? null, threshold: threshold.threshold, factors: threshold.factors, probabilities: { needs_user_decision: 1 }, valueSource: 'held', ledgerId: held.ledgerId ?? null, timeSensitive: false,
      context: { away: signals.away, night: signals.night, present: signals.present, unrepliedChain: signals.unrepliedChain }, signals, kind: 'ask', actionId: held.actionId, heldId: held.id, ...(held.deliverables?.length ? { deliverables: held.deliverables } : {}) };
  }
  publishAsk(context, action, plan, usage) {
    const project = this.project(context.projectId), presence = this.presence(project);
    const permission = action.permissionRequest ? this.permissionService?.request(project.id, action.permissionRequest) : null;
    if (action.permissionRequest && !permission) throw error('No host permission service is configured', 'interaction_unavailable');
    // outcome: what the delivery came to, for the user's receipt on the task page (the summary is the model's).
    if (permission?.alreadyAllowed) return { summary: 'The requested project permission is already granted. No repeated approval question was created; continue within the saved scope.', outcome: 'permission_granted', usage };
    const record = this.interactions.publishInitiative({ projectId: project.id, sessionId: presence.session.id, actionId: action.id, questions: permission?.questions ?? action.questions, metadata: permission?.metadata });
    // The question card is the conversational receipt; the inbox entry carries
    // reach and the user's reaction (answered = acted, cancelled = dismissed).
    const reach = capReach(project, { requested: action.urgency, kind: 'ask' });
    let entry;
    if (this.valid(context)) this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id);
      if (!target || (target.inbox ?? []).some(row => row.actionId === action.id)) return;
      const questions = (permission?.questions ?? action.questions ?? []).map(row => row.question ?? row.header).filter(Boolean).join(' ');
      entry = recordDelivery(target, { actionId: action.id, kind: 'ask', tier: reach.tier, requested: reach.requested, reasons: reach.reasons, text: action.content?.trim() ? `${action.content.trim()}${questions ? `\n${questions}` : ''}` : questions, sessionId: presence.session.id, interactionId: record.id, ledgerIds: [...(context.reviewLedger?.revision === action.revision ? [context.reviewLedger.id] : []), ...(plan.ledgerId ? [plan.ledgerId] : [])], now: this.now() });
      if (reach.tier === 'notify') entry.notifiedAt = entry.createdAt;
      const item = state.sessions.find(row => row.id === presence.session.id)?.items.find(row => row.interaction?.id === record.id);
      entry.threadId = plan.thread.id; entry.pacing = pacingRecord(plan, this.now());
      if (item) { item.initiative = { ...(item.initiative ?? {}), threadId: plan.thread.id, narrated: narratedView(plan) }; }
      // A released held question (F4) leaves its thread's held list as it goes out.
      if (plan.heldId) for (const thread of ensureMind(target).threads) if ((thread.heldAsks ?? []).some(row => row.id === plan.heldId)) thread.heldAsks = thread.heldAsks.filter(row => row.id !== plan.heldId);
      applyNarration(target, plan, { itemId: item?.id ?? null, entryId: entry.id, sessionId: presence.session.id, now: this.now() });
      trimInbox(this.store, target); entry = copy(entry);
    });
    if (entry?.tier === 'notify') this.notifyDesktop(project, entry);
    return { summary: `Structured question ${record.id} was delivered to the project conversation. Status: ${record.status}. Delivery does not mean the user answered or granted permissions.`, outcome: 'asked', usage };
  }
  current(context, action) { return this.valid(context) && (action.hostSchedule ? this.scheduleActionCurrent(context, action) : action.revision === context.coordinator.state.revision); }
  /** Commit-time gate for a conversational (inline/notify) delivery. */
  /** A quiet message may join the conversation when nobody is typing and no turn is running there. */
  quietChatReady(presence) {
    const session = presence?.session;
    return Boolean(session && !session.archivedAt && !presence.typing && !session.activeTurnId && session.status !== 'running');
  }
  /** Quiet shares filed while the conversation was busy join it once it is idle (oldest first, a few per pass). */
  postFiledShares(project) {
    const presence = this.presence(project);
    if (!this.quietChatReady(presence)) return;
    // A scheduled result filed in the inbox (quietly while muted, or expired, F9) stays there: posting it later is the
    // late post F9 avoids, and its conversation is the schedule's destination, not the one in front of the user.
    const pending = (project.inbox ?? []).filter(row => row.kind === 'share' && row.tier === 'inbox' && !row.itemId && !row.scheduled && ['unread', 'read'].includes(row.status ?? 'unread') && typeof row.text === 'string' && row.text.trim()).slice(0, 3);
    if (!pending.length) return;
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id), session = state.sessions.find(row => row.id === presence.session.id);
      if (!target || !session || session.archivedAt || session.activeTurnId) return;
      for (const filed of pending) {
        const entry = target.inbox.find(row => row.id === filed.id);
        if (!entry || entry.itemId) continue;
        const itemId = randomUUID(), at = new Date(this.now()).toISOString();
        session.items.push({ id: itemId, turnId: null, kind: 'assistant', text: entry.text, createdAt: at, simulated: false, source: 'initiative', projectId: target.id, decisionMode: 'rna-model', initiativeActionId: entry.actionId, initiativeDeliveryKey: `filed-share:${entry.id}`,
          initiative: { kind: 'insight', reach: 'inbox', filedAt: entry.createdAt, ...(entry.threadId ? { threadId: entry.threadId } : {}), ...(entry.deliverables ? { deliverables: copy(entry.deliverables) } : {}) } });
        Object.assign(entry, { itemId, sessionId: session.id, postedAt: at }); session.updatedAt = at;
      }
    });
  }
  deliveryGate(project, presence) {
    return project.initiative.notificationMuted ? 'notification_muted' : project.initiative.quietUntil && Date.parse(project.initiative.quietUntil) > this.now() ? 'quiet_until' : project.initiative.deferWhileTyping !== false && presence.typing ? 'user_typing' : !presence.session ? 'no_conversation' : project.initiative.lastSpokeAt && this.now() - Date.parse(project.initiative.lastSpokeAt) < project.initiative.cooldownMs ? 'cooldown' : null;
  }
  jevReach(action, capped) { return !action.hostSchedule && reachRank(capped.tier) >= 1 && this.decisions?.enabled?.('delivery.reach') === true; }
  /** delivery.reach: JEV may lower the capped tier, never raise it. */
  async scoredReach(context, action, capped, kind, signal, text = action.content) {
    const project = this.project(context.projectId), sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
    let scored = null;
    try { scored = await this.decisions.reach(project, { entry: { actionId: action.id, kind, text }, maxTier: capped.tier, recent: sentDigest(project, sessions, { now: this.now() }), signal }); }
    catch (failure) { if (signal.aborted) throw failure; }
    if (!scored) return { ...capped, ledgerIds: [] };
    // Enforced here as well as by the template: a score never escalates.
    const tier = REACH_TIERS.includes(scored.tier) && reachRank(scored.tier) < reachRank(capped.tier) ? scored.tier : capped.tier;
    return { ...capped, tier, reasons: tier !== capped.tier ? [...capped.reasons, 'jev_lowered'] : capped.reasons, ledgerIds: scored.ledgerId ? [scored.ledgerId] : [] };
  }
  notifyDesktop(project, entry) {
    // Display-only event; the inbox entry is the durable record. The Electron
    // main process turns it into a native notification when the user opted in.
    try { liveBus(this.store).publish({ type: 'project.notify', projectId: project.id, entryId: entry.id, sessionId: entry.sessionId, title: project.name, body: oneLine(entry.text, 180), at: entry.createdAt }); } catch {}
  }
  presenceFor(project, action) { const presence = this.presence(project); if (action.hostSchedule) presence.session = this.store.state.sessions.find(session => session.id === action.hostSchedule.destinationSessionId && session.projectId === project.id && !session.archivedAt && session.kind !== 'side'); return presence; }
  // Every share (including scheduled deliveries) goes through the narrator:
  // compose, already-told dedupe, thread attachment and the pacing decision.
  share(context, action, input) {
    const { signal } = input;
    signal.throwIfAborted();
    if (!this.current(context, action)) return { superseded: true, usage: { totalTokens: 0 } };
    const project = this.project(context.projectId);
    // Scheduled occurrences keep their configured conversation and tier. Muting pauses schedules (F9): a run that had
    // already started when the user muted is delivered quietly, at inbox tier, instead of waiting for the unmute.
    const capped = action.hostSchedule ? (project.initiative?.notificationMuted === true ? { requested: null, tier: 'inbox', reasons: ['notification_muted'] } : { requested: null, tier: 'inline', reasons: [] }) : capReach(project, { requested: action.urgency, kind: 'share' });
    if (!quietReach(capped.tier)) { const reason = this.deliveryGate(project, this.presenceFor(project, action)); if (reason) return { deferred: true, reason, usage: { totalTokens: 0 } }; }
    // A late result is re-judged against what was actually delivered since the decision.
    const sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
    const delivered = (project.inbox ?? []).some(row => row.actionId === action.id);
    // Built on a request awaiting the user's retry, the message would answer it beside the retry, on another model.
    if (!action.hostSchedule && !delivered && citesRetryOwned(sessions, action.evidenceIds)) return { superseded: true, reason: 'awaiting_user_retry', usage: { totalTokens: 0 } };
    if (!action.hostSchedule && !delivered && messageViolations(project, sessions, action.content, { now: this.now() }).some(row => row.code === 'near_duplicate')) return { superseded: true, reason: 'message_duplicate', usage: { totalTokens: 0 } };
    const narrateShare = () => this.narrateAction(context, action, 'share', signal).then(async ({ plan, usage }) => {
      signal.throwIfAborted();
      if (!this.current(context, action)) return { superseded: true, usage };
      if (!delivered && plan.outcome === 'drop') { this.commitNarration(context, plan); return { superseded: true, reason: plan.reasons.find(reason => ['already_reported', 'thread_muted', 'below_threshold', 'exact_duplicate'].includes(reason)) ?? 'below_threshold', usage }; }
      if (!delivered && plan.outcome === 'hold') { this.commitNarration(context, plan); return { summary: `Held in its conversation thread (${plan.reasons.join(', ')}): the user will get it with the next message on this topic or in a welcome-back summary. Do not resend it.`, reach: 'inbox', outcome: 'held', usage }; }
      const paced = plan.outcome === 'inbox' && reachRank(capped.tier) > reachRank('inbox') ? { ...capped, tier: 'inbox', reasons: [...capped.reasons, 'narrator_pacing'] } : capped;
      const reach = this.jevReach(action, paced) ? await this.scoredReach(context, action, paced, 'share', signal, plan.text) : { ...paced, ledgerIds: [] };
      const result = await this.commitShare(context, action, reach, signal, plan);
      return { ...result, usage: { totalTokens: (result.usage?.totalTokens ?? 0) + usage.totalTokens } };
    });
    if (action.hostSchedule || delivered) return narrateShare();
    // 直接处理: a finding whose fixes JEV judges objective and safe is applied now; the user keeps or reverts it.
    return this.directHandle(context, action, input).then(handled => handled ?? narrateShare());
  }
  /** Returns a handler result when the finding was handled directly, else null (ask as usual). */
  async directHandle(context, action, input) {
    const { signal } = input, project = this.project(context.projectId);
    if (!project || !this.interactions || typeof this.decisions?.directHandle !== 'function' || !action.content?.trim()) return null;
    // Design §8: with background worktrees the fix runs in its own copy and reaches the project folder as an apply record.
    const isolated = this.background?.ready() ? await this.isolationFor(project) : false;
    if (permissionLevel(this.backgroundProject(project, { isolated }), 'background') === 'read') return null;
    const presence = this.presenceFor(project, action);
    if (!presence.session) return null;
    const direct = await this.decisions.directHandle(project, { text: action.content, kind: projectKindOf(project), signal }).catch(() => false);
    signal.throwIfAborted();
    if (!direct || !this.current(context, action)) return null;
    let recorder; if (!isolated) try { recorder = new DirectFixRecorder(projectWorkspace(project.workspace)); } catch { return null; }
    // The task is read by the worker (English); its report becomes the card's detail, so it is asked for in the interface language.
    const language = interfaceLanguageOf(this.store.state), fix = { ...action, id: `${action.id}-direct`, content: directFixTask(action.content, language) };
    if (isolated) return this.directHandleIsolated(context, action, fix, input, presence);
    const result = await this.work(context, fix, { ...input, recorder });
    if (result?.deferred || result?.superseded || result?.control) return result;
    const changes = recorder.changes();
    // Nothing changed (or the work failed): the finding is shared and asked about as usual.
    if (!changes.length) return null;
    const fixId = randomUUID(), files = saveDirectFix(this.directFixDir(), fixId, changes);
    const report = this.redact(stripHandoff(result?.summary ?? '')).trim();
    const detail = directFixDetail({ report, files: files.map(row => ({ path: row.path, mark: row.existed ? null : 'new' })), skipped: recorder.skipped, language });
    const record = this.publishDirectFix(project, presence, action, files.length, detail, language);
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id); if (!target) return;
      target.directFixes = [...(target.directFixes ?? []), { id: fixId, actionId: action.id, at: new Date(this.now()).toISOString(), sessionId: presence.session.id, interactionId: record.id, files, status: 'pending' }].slice(-50);
      recordDelivery(target, { actionId: action.id, kind: 'share', tier: 'inline', requested: action.urgency ?? null, reasons: ['direct_handle'], text: detail, sessionId: presence.session.id, interactionId: record.id, now: this.now() });
      trimInbox(this.store, target);
    });
    this.resolveMind(context, action, 'delivery');
    return { summary: `Handled directly: the fixes were applied to ${files.length} file(s) and the user was asked to keep or revert them in the conversation. Do not share or ask about this finding again.`, reach: 'inline', outcome: 'fixed', usage: result?.usage ?? { totalTokens: 0 } };
  }
  /** The 已直接处理 card: keep or revert the fixes just applied. */
  publishDirectFix(project, presence, action, count, detail, language = interfaceLanguageOf(this.store.state)) {
    return this.interactions.publishInitiative({ projectId: project.id, sessionId: presence.session.id, actionId: `${action.id}-direct`.slice(0, 160), questions: [directFixCard({ count, detail, language })] });
  }
  /** Whether this project's background work runs in its own worktree now (design §2, §8); false when not wired. */
  async isolationFor(project) { return Boolean(project && this.background?.ready() && await this.background.enabled(project.id)); }
  /**
   * directHandle in its own worktree (design §8 :1256): the fix runs in B, is applied to the project folder through an
   * apply record, and the card's 回退 rolls back that record (settleDirectFixes). Applied later (a direct-mode turn holds
   * the folder) or conflicting, it becomes a background change set with its line, like other background work.
   */
  async directHandleIsolated(context, action, fix, input, presence) {
    let bg;
    try { bg = await this.background.open(context.projectId, fix.id, { label: `Rna background ${action.id} (direct)`, signal: input.signal }); }
    catch { return null; }
    let result;
    try { result = await this.work(context, fix, { ...input, bg }); }
    catch (failure) { try { await this.keepGitChanges(context, fix, bg, { failed: true, code: failure?.code ?? null }); } catch (problem) { console.warn(`background worktree ${fix.id}: ${problem.message}`); } throw failure; }
    if (result?.deferred || result?.control) { await this.endGitRun(context, fix, bg, result); return result; }
    if (result?.superseded) { try { await this.keepGitChanges(context, fix, bg, result); } catch (problem) { console.warn(`background worktree ${fix.id}: ${problem.message}`); } return result; }
    let outcome;
    this.gitBusy.add(bg.worktreeId);
    try { outcome = await this.background.settle(bg, { completed: true, hold: () => this.applyHold(context.projectId) }); }
    finally { this.gitBusy.delete(bg.worktreeId); }
    // Nothing changed: the finding is shared and asked about as usual.
    if (outcome.status === 'nothing') { await this.background.close(bg).catch(() => {}); return null; }
    const project = this.project(context.projectId), usage = result?.usage ?? { totalTokens: 0 };
    if (outcome.status !== 'applied' || !project) {
      await this.recordGitChange(context, fix, bg, outcome, result);
      // Its fixes wait (deferred, or a conflict card): what the finding resolves waits for them too (X-5).
      this.resolveWork(context, action, 'delivery');
      return { summary: 'Handled directly in a separate working copy: the fixes reach the project folder when it is free, or the user decides on a card where they conflict. Do not share or ask about this finding again.', reach: 'inline', outcome: 'fixed', usage };
    }
    const files = [...bg.files.values()];
    if (bg.unverified) this.background.release(bg, 'kept'); else await this.background.close(bg).catch(() => {});
    const fixId = randomUUID(), report = this.redact(stripHandoff(result?.summary ?? '')).trim();
    // Files that hold secrets the fix changed (B8) were not applied: the card says so (they go to the trash with B).
    const secret = this.secretText(outcome.secret), language = interfaceLanguageOf(this.store.state);
    const detail = directFixDetail({ report, files: files.map(row => ({ path: row.path, mark: row.deleted ? 'deleted' : null })), secret, language });
    const record = this.publishDirectFix(project, presence, action, files.length, detail, language);
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id); if (!target) return;
      target.directFixes = [...(target.directFixes ?? []), { id: fixId, kind: 'git', applyId: bg.applyIds[0] ?? null, applyIds: [...bg.applyIds], worktreeId: bg.worktreeId, actionId: action.id, at: new Date(this.now()).toISOString(), sessionId: presence.session.id, interactionId: record.id, files: files.map(row => ({ path: row.path, ...(row.deleted ? { deleted: true } : {}) })), status: 'pending' }].slice(-50);
      recordDelivery(target, { actionId: action.id, kind: 'share', tier: 'inline', requested: action.urgency ?? null, reasons: ['direct_handle'], text: detail, sessionId: presence.session.id, interactionId: record.id, now: this.now() });
      trimInbox(this.store, target);
    });
    this.resolveMind(context, action, 'delivery');
    return { summary: `Handled directly: the fixes were applied to ${files.length} file(s) and the user was asked to keep or revert them in the conversation. Do not share or ask about this finding again.`, reach: 'inline', outcome: 'fixed', usage };
  }
  directFixDir() { return `${this.store.file}.direct-fixes`; }
  backgroundChangeDir() { return `${this.store.file}.background-changes`; }
  /** The one-click revert of an older change set or direct fix is the user's undo too: its writes go to the folder's observation as the engine's do (review K1-2). */
  userUndoWrite(projectId) { try { return this.background?.engine?.userUndoWrite?.(projectId) ?? null; } catch { return null; } }
  /**
   * Plan §4.4: background work with write access keeps a snapshot of every file it changes. The changes
   * stay (the default) and one line in the conversation says what the work did and how many files changed,
   * with a one-click revert that never overwrites a file changed again afterwards. The line appears when
   * the work starts ("working"), so the conversation never looks like the only line of work, and is
   * completed in place when it ends (or taken back when it ends without changing a file).
   */
  async recordedWork(context, action, input) {
    const project = this.project(context.projectId);
    // A resumed run goes on with the snapshots it took before its pause, so its line lists every file it changed.
    this.pausedRecorders ??= new Map();
    // Design §8: in a git project with background worktrees, a writing run works in its own copy (a resumed one in the
    // same copy) and is applied to the project folder when it ends; read-only runs and other projects stay as they were.
    if (!input?.recorder && !this.pausedRecorders.has(action.id) && project && this.background?.ready() && await this.isolationFor(project) && permissionLevel(this.backgroundProject(project, { isolated: true }), 'background') !== 'read') return this.isolatedWork(context, action, input);
    let recorder = this.pausedRecorders.get(action.id) ?? null; this.pausedRecorders.delete(action.id);
    if (input?.recorder || !project || permissionLevel(this.backgroundProject(project), 'background') === 'read') recorder = null;
    else if (!recorder) try { recorder = new DirectFixRecorder(projectWorkspace(project.workspace)); } catch { recorder = null; }
    if (recorder) try { this.workLine(context, action, 'running'); } catch { /* the line is a courtesy; the work itself goes on */ }
    let result;
    try { result = await this.work(context, action, recorder ? { ...input, recorder } : input); }
    catch (failure) {
      // A run that failed part way still changed what it changed: those files are listed and revertible too.
      if (recorder) try { this.keepBackgroundChanges(context, action, recorder, { failed: true, code: failure?.code ?? null }); } catch { /* best effort */ }
      throw failure;
    }
    // A paused run resumes in the same execution and reports its changes when it ends; a cancelled one ends here.
    const ended = result?.deferred ? null : !result?.control ? result : result.control.kind === 'cancel' ? { cancelled: true } : null;
    if (recorder && ended) try { this.keepBackgroundChanges(context, action, recorder, ended); } catch { /* snapshots are best effort; the work itself stands */ }
    else if (recorder && result?.control?.kind === 'pause') { this.pausedRecorders.set(action.id, recorder); try { this.workLine(context, action, 'paused'); } catch { /* best effort */ } }
    // A deferred run never started: its "working" line goes away until it really starts (a resumed one keeps its snapshots).
    else if (recorder && (result?.deferred || !result)) { if (result?.deferred && action.checkpoint) this.pausedRecorders.set(action.id, recorder); try { this.workLine(context, action, 'withdrawn'); } catch { /* best effort */ } }
    return result;
  }
  /** The conversation line of one writing background run: posted when it starts, updated as it pauses, ends or never starts. */
  workLine(context, action, status, { text = null, change = null, reported = false } = {}) {
    const project = this.project(context.projectId); if (!project) return null;
    const key = `${action.id}-changes`, at = new Date(this.now()).toISOString();
    const holder = this.store.state.sessions.find(row => row.projectId === project.id && !row.archivedAt && row.items?.some(item => item.initiativeActionId === key && item.initiative?.backgroundWork));
    if (!holder && !['running'].includes(status) && !change) return null;
    const session = holder ?? this.presenceFor(project, action).session ?? this.store.state.sessions.find(row => row.id === project.primarySessionId && !row.archivedAt);
    if (!session) return null;
    const language = interfaceLanguageOf(this.store.state), task = this.actionName(project, action, { language });
    const body = text ?? (status === 'running' ? inLanguage(language, { zh: `后台开始做：${task}\n\n正在进行，做完后会在这里补上做了什么、改了哪些文件。`, en: `Background work started: ${task}\n\nIn progress; what it did and the files it changed will be added here when it finishes.` })
      : status === 'paused' ? inLanguage(language, { zh: `后台在做：${task}\n\n已暂停，继续后接着做；做完后在这里补上改了哪些文件。`, en: `Background work: ${task}\n\nPaused; it picks up where it stopped, and the files it changed will be added here when it finishes.` })
      : null);
    let id = null;
    this.mutate(state => {
      const live = state.sessions.find(row => row.id === session.id); if (!live || live.archivedAt) return;
      const index = live.items.findIndex(item => item.initiativeActionId === key && item.initiative?.backgroundWork);
      if (status === 'withdrawn') {
        const work = index >= 0 ? live.items[index].initiative.backgroundWork : null;
        if (['running', 'paused'].includes(work?.status)) live.items.splice(index, 1);
        // A run a restart cut off whose working copy had nothing to apply: its line is final now (MEM-3 enrols it).
        else if (work?.status === 'interrupted' && work.recovering) recoveredLine(live.items[index], this.cutOffText(task, 'nothing', language), at);
        return;
      }
      const work = { actionId: action.id, status, startedAt: index >= 0 ? live.items[index].initiative.backgroundWork.startedAt ?? at : at, ...(['running', 'paused'].includes(status) ? {} : { endedAt: at }) };
      // A scheduled run's line says so (badge 定时任务), not 主动分享: the user set it up.
      const initiative = { kind: 'insight', reach: index >= 0 ? live.items[index].initiative.reach ?? 'inbox' : 'inbox', backgroundWork: work, ...(action.hostSchedule ? { scheduledWork: true } : {}), ...(change ? { backgroundChange: change } : {}) };
      const evidence = reported ? { evidenceIds: [`action:${action.id}:completed`] } : {};
      if (index >= 0) { const item = live.items[index]; Object.assign(item, { ...(body ? { text: body } : {}), ...evidence, initiative: { ...item.initiative, ...initiative }, updatedAt: at }); id = item.id; }
      else if (body) { id = randomUUID(); live.items.push({ id, turnId: null, kind: 'assistant', text: body, createdAt: at, simulated: false, source: 'initiative', projectId: project.id, decisionMode: 'rna-model', initiativeActionId: key, ...evidence, initiative }); }
      live.updatedAt = at;
    });
    return id;
  }
  keepBackgroundChanges(context, action, recorder, result = null) {
    const project = this.project(context.projectId); if (!project) return null;
    const changes = recorder.changes(), status = result?.failed ? 'failed' : result?.cancelled ? 'cancelled' : result?.superseded ? 'stopped' : result?.unreported ? 'unreported' : 'done';
    // A completed run's line already reports it (with the worker's own summary): it cites the run, so the next review
    // does not see this work as unreported and share it a second time.
    const reported = Boolean(result) && !result.failed && !result.cancelled && !result.superseded;
    // Nothing changed: the "working" line goes (like a typing indicator); what the work found reaches the user the usual way.
    if (!changes.length) { this.workLine(context, action, 'withdrawn'); return null; }
    const id = randomUUID(), files = saveDirectFix(this.backgroundChangeDir(), id, changes), at = new Date(this.now()).toISOString();
    let dropped = [];
    this.mutate(state => {
      const target = state.projects.find(row => row.id === project.id); if (!target) return;
      const rows = [...(target.backgroundChanges ?? []), { id, actionId: action.id, at, files, skipped: recorder.skipped.length, status: 'kept', ...(result?.unreported ? { unreported: true } : {}), ...(result?.failed ? { failed: true } : {}), ...(result?.cancelled ? { cancelled: true } : {}) }];
      ({ rows: target.backgroundChanges, dropped } = trimChanges(rows));
    });
    this.workLine(context, action, status, { text: this.backgroundChangeText(action, files.length, result, project), change: id, reported });
    for (const old of dropped) discardDirectFix(this.backgroundChangeDir(), old);
    return id;
  }
  /**
   * A writing run in its own worktree B (design §4.3, §8). B is opened before the run (a paused run resumes in the same
   * B); the run works there with its commands sandboxed, and its finish hook applies B to the project folder (with up
   * to LIMITS.applyContinuations host continuations to resolve conflicts inside the run). A run that ends without
   * finishing applies only what does not conflict. No worktree → the run does not start (never falls back to the
   * project folder).
   */
  async isolatedWork(context, action, input) {
    let bg;
    try { bg = await this.background.open(context.projectId, action.id, { label: `Rna background ${action.id}`, signal: input?.signal }); }
    catch (failure) {
      if (input?.signal?.aborted) throw failure;
      throw Object.assign(error(inLanguage(interfaceLanguageOf(this.store.state), { zh: '没能为这次后台工作准备独立的工作副本，所以它没有开始，也没有改动项目文件夹。', en: 'A separate working copy for this background work could not be prepared, so it did not start and the project folder was not changed.' }), 'worktree_create_failed'), { cause: failure, details: { reason: failure?.reason ?? failure?.code ?? null } });
    }
    try { this.workLine(context, action, 'running'); } catch { /* the line is a courtesy; the work itself goes on */ }
    let result;
    try { result = await this.work(context, action, { ...input, bg }); }
    catch (failure) {
      // A run that failed part way still changed what it changed: what does not conflict is applied, the rest decided on a card.
      try { await this.keepGitChanges(context, action, bg, { failed: true, code: failure?.code ?? null }); } catch (problem) { console.warn(`background worktree ${action.id}: ${problem.message}`); }
      throw failure;
    }
    const ended = result?.deferred ? null : !result?.control ? result : result.control.kind === 'cancel' ? { cancelled: true } : null;
    if (ended) { try { await this.keepGitChanges(context, action, bg, ended); } catch (problem) { console.warn(`background worktree ${action.id}: ${problem.message}`); } }
    else await this.endGitRun(context, action, bg, result);
    return result;
  }
  /** A run in B that has not ended: paused (B stays for its resumption) or never started (B goes unless a resumption uses it). */
  async endGitRun(context, action, bg, result) {
    if (result?.control?.kind === 'pause') { try { this.workLine(context, action, 'paused'); } catch { /* best effort */ } return; }
    const keep = result?.deferred && action.checkpoint;
    const tip = keep ? null : await this.background.tip(bg).catch(() => null), same = tip ? await this.background.unchanged(bg, tip).catch(() => false) : false;
    // Only files that hold secrets changed (B8): nothing to apply, B goes (they go to the trash with it) and its line,
    // still there, says so instead of being withdrawn.
    if (same && tip.secret?.length) {
      try { await this.background.close(bg); this.secretOnlyLine(context, action, { superseded: true }, tip.secret); }
      catch (problem) { console.warn(`background worktree ${action.id}: ${problem.message}`); }
      return;
    }
    try { this.workLine(context, action, 'withdrawn'); } catch { /* best effort */ }
    if (keep) return;
    try { if (same) await this.background.close(bg); else await this.keepGitChanges(context, action, bg, { superseded: true }); }
    catch (problem) { console.warn(`background worktree ${action.id}: ${problem.message}`); }
  }
  /**
   * The line of a writing run whose only changes were to files that hold secrets (B8, secretText): no change set (there
   * is nothing to apply), its working copy is removed and they are in the trash. Its "working" line is kept for it.
   */
  secretOnlyLine(context, action, result, paths) {
    const project = this.project(context.projectId); if (!project) return null;
    const lead = this.gitChangeLead(project, action, { task: this.actionName(project, action, { language: interfaceLanguageOf(this.store.state) }) }, result);
    // A completed run's line reports it, as a change set's does (recordGitChange): the next review does not share it again.
    const reported = Boolean(result) && !result.failed && !result.cancelled && !result.superseded;
    return this.workLine(context, action, workLineStatus(result), { text: `${lead}\n\n${this.secretText(paths)}`, reported });
  }
  /**
   * The run's finish hook (createRnaRuntime hostFinish): first the guard pass over what the run changed (C1), then B → P
   * as at a session's turn end (design §4.2 step 3, §4.3). The pass comes first so a hit is fixed in B, where the run
   * still works, before anything reaches the project folder.
   */
  async finishGitRun(context, action, bg, input) {
    const guarded = await this.guardGitRun(context, action, bg, input);
    if (guarded) return guarded;
    return this.background.finish(bg, input, { hold: () => this.applyHold(context.projectId), onMerging: () => this.gitLine(context.projectId, `${action.id}-changes`, inLanguage(interfaceLanguageOf(this.store.state), { zh: `后台在做：${this.actionName(this.project(context.projectId), action)}\n\n项目文件夹里同时有改动和它冲突，正在合并…`, en: `Background work: ${this.actionName(this.project(context.projectId), action)}\n\nChanges made in the project folder meanwhile conflict with it; merging…` }), { key: true }) });
  }
  /**
   * The guard pass at the end of a run in B (C1): files it changed through a command, a generated tool or a merge (no
   * file-write call, so no per-tool hook saw them) are checked by the project's guards against B's base, with a hit the
   * file already had counted and the (path, text) pairs a write hook checked skipped (ToolPolicy#sweep). A hit the run
   * added continues it once; with that spent, or none left, the finding goes on the change set's row and line
   * (`bg.guard`, recordGitChange). A run working directly in the project folder has no such pass: nothing says what it
   * changed, short of the user's own edits. The pass never fails the run.
   */
  async guardGitRun(context, action, bg, { message, snapshot, remainingContinuations = 0, signal } = {}) {
    const policy = this.toolPolicy, project = this.project(context.projectId);
    if (typeof policy?.sweep !== 'function' || !project || !policy.hasGuards(project.id) || !ranUnhookedTool(snapshot?.messages)) return undefined;
    const changes = worktreeChanges({ engine: this.background?.engine, projectId: project.id, root: bg.root, base: bg.base });
    if (!changes) return undefined;
    let result;
    try { result = await policy.sweep({ projectId: project.id, root: bg.root.root, actionId: action.id, changes, signal }); }
    catch (error) { if (signal?.aborted) throw error; console.warn(`background guard pass ${action.id}: ${error.message}`); return undefined; }
    if (!result) return undefined;
    // The one continuation is read from the run's journal, not from a flag set when it was offered: the SDK drops an offer
    // that new input overtook, and that must not use the allowance up.
    const used = guardContinued(snapshot?.messages);
    // The host's step-limit conclusion is not a finish the run reached: it cannot be asked to carry on.
    if (result.fix && !used && remainingContinuations > 0 && message?.source !== 'step-limit-summary') return { feedback: [{ source: GUARD_SOURCE, text: result.text }] };
    const open = [...result.files.flatMap(file => file.checks.map(check => ({ path: file.path, gene: check.gene, title: check.title, hits: check.hits.length }))), ...result.unresolved];
    if (open.length || bg.guard) bg.guard = { open: open.slice(0, 12), ...(used ? { continued: true } : {}) };
    return undefined;
  }
  /** Settle a run's B (design §4.3) and record the change set: its row, its line, and a card where it conflicts. */
  async keepGitChanges(context, action, bg, ending = null) {
    const completed = Boolean(ending) && !ending.failed && !ending.cancelled && !ending.superseded;
    let outcome;
    this.gitBusy.add(bg.worktreeId);
    try { outcome = await this.background.settle(bg, { completed, hold: () => this.applyHold(context.projectId) }); }
    finally { this.gitBusy.delete(bg.worktreeId); }
    return this.recordGitChange(context, action, bg, outcome, ending);
  }
  /**
   * The change set of one run in B (`backgroundChanges[]` row `{ kind: 'git', applyId, worktreeId, status }`, design
   * §11): `kept` once applied (B removed), `deferred` while the project folder is held (applied when it is free),
   * `merge_conflicted` while a card decides (B kept; never blocksExecution). Nothing changed: no row, no line.
   */
  async recordGitChange(context, action, bg, outcome, result = null) {
    const project = this.project(context.projectId); if (!project) return null;
    if (outcome.status === 'nothing') {
      await this.background.close(bg).catch(() => {});
      // Files that hold secrets it changed (B8) were not applied and went to the trash with B: the line says so.
      const secret = this.secretText(outcome.secret);
      if (result?.pausedStop) { const language = interfaceLanguageOf(this.store.state); this.workLine(context, action, 'cancelled', { text: [this.stoppedPausedText(this.actionName(project, action, { language }), result.pausedStop, language), secret].filter(Boolean).join('\n\n') }); }
      else if (secret) this.secretOnlyLine(context, action, result, outcome.secret);
      else this.workLine(context, action, 'withdrawn');
      return null;
    }
    const status = outcome.status === 'applied' ? 'kept' : outcome.status === 'held' && outcome.reason !== 'read_only' ? 'deferred' : 'merge_conflicted';
    const id = randomUUID(), at = new Date(this.now()).toISOString(), files = [...bg.files.values()];
    const lineStatus = workLineStatus(result);
    const reported = Boolean(result) && !result.failed && !result.cancelled && !result.superseded;
    const model = context.coordinator?.model?.modelId ? { providerId: context.coordinator.model.providerId, modelId: context.coordinator.model.modelId, name: context.coordinator.model.name ?? context.coordinator.model.modelId } : null;
    const row = { id, kind: 'git', actionId: action.id, at, worktreeId: bg.worktreeId, applyId: bg.applyIds[0] ?? null, applyIds: [...bg.applyIds], files, skipped: 0, status, task: this.actionName(project, action, { language: interfaceLanguageOf(this.store.state) }),
      ...(outcome.conflicts?.length ? { conflicts: outcome.conflicts.slice(0, 200) } : {}), ...(outcome.status === 'held' ? { hold: outcome.reason, ...(outcome.reason === 'git_operation' && outcome.operation ? { operation: outcome.operation } : {}), ...(outcome.cleanOnly ? { cleanOnly: true } : {}) } : {}),
      ...(bg.attempts ? { continuations: bg.attempts } : {}), ...(model ? { model } : {}), ...(result?.unreported ? { unreported: true } : {}), ...(result?.failed ? { failed: true } : {}), ...(result?.cancelled ? { cancelled: true } : {}), ...(result?.superseded ? { stopped: true } : {}),
      // Files that hold secrets the run changed (B8): never applied; its line names them (gitChangeText).
      ...(outcome.secret?.length ? { secret: outcome.secret.slice(0, 50) } : {}),
      // Hits the guard pass (C1) could not get fixed in the run: `{ open: [{ path, gene, title, hits }], continued? }`; its line says so (gitChangeText).
      ...(bg.guard?.open?.length ? { guard: { open: bg.guard.open.slice(0, 12), ...(bg.guard.continued ? { continued: true } : {}) } } : {}),
      // The worker's own handoff line, kept for the line's text when the set is applied later.
      ...(result && !result.unreported && typeof result.reported === 'string' && result.reported.trim() ? { report: this.redact(result.reported).slice(0, 600) } : {}) };
    // Applied: B goes (or, when the check after writing found a difference, stays for the worktree panel) before the row says so.
    if (status === 'kept') { if (bg.unverified) this.background.release(bg, 'kept'); else await this.background.close(bg).catch(() => {}); }
    let dropped = [];
    this.mutate(state => {
      const target = state.projects.find(item => item.id === project.id); if (!target) return;
      ({ rows: target.backgroundChanges, dropped } = trimChanges([...(target.backgroundChanges ?? []), row]));
    });
    for (const old of dropped) discardDirectFix(this.backgroundChangeDir(), old);
    this.workLine(context, action, lineStatus, { text: this.gitChangeText(project, action, row, result), change: id, reported });
    const holder = this.store.state.sessions.find(session => session.items?.some(item => item.initiative?.backgroundChange === id));
    if (holder) this.mutate(state => { const target = state.projects.find(item => item.id === project.id)?.backgroundChanges?.find(item => item.id === id); if (target) target.sessionId = holder.id; });
    if (status === 'merge_conflicted') this.postGitCard(project.id, id);
    if (row.hold === 'git_operation') this.retryWhenFree(project.id);
    this.scheduleGitUpkeep();
    return id;
  }
  /**
   * Change sets and card answers held on the user's git operation in the project folder go on once it ends: the
   * engine's watch on the repository's git directory runs this project's upkeep then (no fixed retry time, no wait).
   */
  retryWhenFree(projectId) {
    const free = () => {
      // Card answers held on the operation are taken up again by this pass.
      for (const [changeId, owner] of this.heldGitAnswers ?? []) if (owner === projectId) this.heldGitAnswers.delete(changeId);
      if (!this.closed) void this.projectGitUpkeep(projectId).catch(problem => console.warn(`background worktrees: ${problem.message}`));
    };
    try { this.background?.engine?.whenProjectFree?.(projectId, 'background-changes', free); } catch { /* the next upkeep pass checks again */ }
  }
  /** The line of a set held on the user's git operation in the project folder, in the interface language. */
  operationText(operation) {
    return inLanguage(interfaceLanguageOf(this.store.state), { zh: `项目文件夹正在进行 git ${operation ?? '操作'}，改动先留在它自己的工作副本里，等这个操作结束后再应用到项目文件夹。`, en: `A git ${operation ?? 'operation'} is in progress in the project folder, so its changes wait in its own working copy and are applied to the project folder once that operation ends.` });
  }
  /**
   * What a background change set's line says (the worker's handoff or the task, then where its changes are), and the
   * files that hold secrets its run changed (row `secret`, B8: never applied; secretText).
   */
  gitChangeText(project, action, row, result = null) {
    const body = this.gitChangeBody(project, action, row, result), secret = this.secretText(row?.secret);
    // Guard hits the run left unfixed (C1): the line says so, in the interface language.
    const guard = guardOpenText(row?.guard?.open, { language: interfaceLanguageOf(this.store.state), scope: 'background' });
    return [body, secret, guard].filter(Boolean).join('\n\n');
  }
  /**
   * The sentence a background run's line adds for the files that hold secrets (SECRET_FILES) it changed in its working
   * copy (B8, BackgroundWorktrees.settle `secret`): no apply carries them into the project folder, and the copy's
   * removal moves them to the trash. In the interface language; '' when there are none.
   * @param {string[]} [paths]
   */
  secretText(paths) {
    const list = [...new Set(Array.isArray(paths) ? paths : [])];
    if (!list.length) return '';
    const shown = list.slice(0, 10), more = list.length - shown.length, one = list.length === 1;
    return inLanguage(interfaceLanguageOf(this.store.state), {
      zh: `存放密钥的文件从不从工作副本应用到项目文件夹，所以它改的这 ${list.length} 个文件没有应用：${shown.join('、')}${more ? ` 等` : ''}。工作副本清理时它们会移到项目文件夹的 .rna/trash.nosync，保留 ${LIMITS.trashDays} 天，需要的话请从那里复制过去。`,
      en: `Files that hold secrets are never applied from a working copy to the project folder, so ${one ? 'this one it changed was' : `these ${list.length} it changed were`} not: ${shown.join(', ')}${more ? ` and ${more} more` : ''}. When the working copy is cleaned up they move to the project folder’s .rna/trash.nosync for ${LIMITS.trashDays} days; copy them from there if you need them.`,
    });
  }
  /** The first part of a background run's line: the worker's handoff line, else the task and how the run ended. */
  gitChangeLead(project, action, row, result = null) {
    const language = interfaceLanguageOf(this.store.state), say = (zh, en) => inLanguage(language, { zh, en });
    const clean = value => withoutHandles((typeof this.redact === 'function' ? this.redact(value) : String(value ?? '')).replace(/\s+/g, ' ').trim());
    const note = result && !result.unreported && result.reported ? clean(result.reported) : '', task = row.task || this.actionName(project, action, { language });
    return note || (task ? (result?.failed ? say(`这次后台在做：${task}\n\n它没有做完就停了。`, `This background task was: ${task}\n\nIt stopped before finishing.`)
      : result?.cancelled ? say(`这次后台在做：${task}\n\n按你的要求停下了。`, `This background task was: ${task}\n\nIt stopped as you asked.`)
      : result?.superseded ? say(`这次后台在做：${task}\n\n项目的情况变了，这次后台工作没有继续。`, `This background task was: ${task}\n\nThe project changed, so this background work did not go on.`)
      : result?.unreported ? say(`这次后台在做：${task}\n\n它停在半途，没有留下完成汇报，最后一步可能没做完。`, `This background task was: ${task}\n\nIt stopped mid-step without a report, so its last step may be unfinished.`)
      : say(`这次后台做的是：${task}`, `This background task: ${task}`)) : say('后台工作结束了。', 'Background work ended.'));
  }
  gitChangeBody(project, action, row, result = null) {
    const language = interfaceLanguageOf(this.store.state), say = (zh, en) => inLanguage(language, { zh, en }), count = row.files?.length ?? 0;
    if (row.status === 'kept' && !row.conflicts?.length) return this.backgroundChangeText(action, count, result, project);
    const lead = this.gitChangeLead(project, action, row, result);
    const applied = count ? say(`不冲突的 ${count} 个文件已经应用到项目文件夹。`, `The ${count} file${count === 1 ? '' : 's'} without conflicts ${count === 1 ? 'was' : 'were'} applied to the project folder.`) : '';
    if (row.status === 'deferred' && row.hold === 'git_operation') return `${lead}\n\n${this.operationText(row.operation)}`;
    if (row.status === 'deferred') return `${lead}\n\n${say('改动先留在它自己的工作副本里，等这一轮对话结束后应用到项目文件夹。', 'Its changes wait in its own working copy and are applied to the project folder when the current turn of the conversation ends.')}`;
    if (row.status === 'kept') return `${lead}\n\n${[applied, say(`另外 ${row.conflicts.length} 个文件和项目文件夹里的改动冲突，保留了项目文件夹的版本。`, `${row.conflicts.length} other file${row.conflicts.length === 1 ? '' : 's'} conflicted with changes in the project folder, which kept its version.`)].filter(Boolean).join('')}`;
    if (row.hold === 'read_only') return `${lead}\n\n${say('后台现在没有写入项目文件夹的权限，改动还留在它自己的工作副本里；在输入框上方的卡片里决定怎么处理。', 'Background work may not write to the project folder now, so its changes are still in its own working copy; decide on the card above the composer.')}`;
    return `${lead}\n\n${[applied, say(`有 ${row.conflicts?.length ?? 0} 个文件和项目文件夹里同时发生的改动冲突，还没有应用；在输入框上方的卡片里决定怎么处理。`, `${row.conflicts?.length ?? 0} file${row.conflicts?.length === 1 ? '' : 's'} conflict with changes made in the project folder meanwhile and ${row.conflicts?.length === 1 ? 'was' : 'were'} not applied; decide on the card above the composer.`)].filter(Boolean).join('')}`;
  }
  /** Replace the text of a change set's line (by change id, or by its work line key). */
  gitLine(projectId, id, text, { key = false } = {}) {
    const lineOf = session => (session.projectId !== projectId || session.archivedAt ? null : session.items?.find(row => (key ? row.initiativeActionId === id && row.initiative?.backgroundWork : row.initiative?.backgroundChange === id)) ?? null);
    // The same words again (a hold retried, a restart): the line stays as it is, and nothing is written.
    const current = this.store.state.sessions.map(lineOf).find(Boolean);
    if (current?.text === text) return;
    try {
      this.mutate(state => {
        for (const session of state.sessions) {
          const item = lineOf(session);
          if (!item) continue;
          item.text = text; item.updatedAt = new Date(this.now()).toISOString(); session.updatedAt = item.updatedAt;
          return;
        }
      });
    } catch { /* the line is a courtesy */ }
  }
  /**
   * The background conflict card (HOST_CARDS.backgroundConflict, design §4.3) above the composer of the change set's
   * conversation. Without a conversation (or a card service) B is left to the worktree panel instead.
   */
  postGitCard(projectId, changeId) {
    const project = this.project(projectId), row = project?.backgroundChanges?.find(item => item.id === changeId), bgRecord = row && (project.git?.worktrees ?? []).find(item => item.id === row.worktreeId);
    if (!row) return null;
    const session = this.store.state.sessions.find(item => item.id === row.sessionId && !item.archivedAt) ?? this.presenceFor(project, { id: row.actionId }).session;
    const release = () => { if (bgRecord?.state === 'active') this.background.release({ projectId, worktreeId: bgRecord.id }); return null; };
    if (!session || typeof this.interactions?.publishInitiative !== 'function') return release();
    const language = interfaceLanguageOf(this.store.state), say = (zh, en) => inLanguage(language, { zh, en }), conflicts = row.conflicts ?? [];
    const names = conflicts.slice(0, 6).map(item => item.path).join(language === 'en' ? ', ' : '、') + (conflicts.length > 6 ? say(` 等 ${conflicts.length} 个`, ` and ${conflicts.length - 6} more`) : '');
    const question = row.hold === 'read_only'
      ? say(`后台工作「${row.task}」做完了，但后台现在没有写入项目文件夹的权限，改动还没有应用。要怎么处理？`, `The background work "${row.task}" is done, but background work may not write to the project folder now, so its changes are not applied. What should happen?`)
      : say(`后台工作「${row.task}」改的文件里，有 ${conflicts.length} 个和项目文件夹里同时发生的改动冲突（${names}），所以还没有应用。要怎么处理？`, `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} the background work "${row.task}" changed conflict with changes made in the project folder meanwhile (${names}), so they are not applied. What should happen?`);
    const options = [
      { id: 'rna', label: say('让 Rna 处理', 'Let Rna handle it'), description: say('在对话里开一轮，由 Rna 合并这些改动并解决冲突。', 'Start a turn in the conversation where Rna merges these changes and resolves the conflicts.') },
      { id: 'clean_only', label: say('只应用不冲突的文件', 'Apply only files without conflicts'), description: say('冲突的文件保留项目文件夹里的版本。', 'Conflicting files keep the project folder’s version.') },
      { id: 'background', label: say('冲突文件用后台的版本', 'Use the background version'), description: say('冲突的文件也换成后台改的版本；先建检查点，可以回退。', 'Conflicting files take the background version too; a checkpoint is taken first, so it can be rolled back.') },
      { id: 'discard', label: say('丢弃', 'Discard'), description: say('不应用后台还没应用的改动。', 'Do not apply the background changes that are not applied yet.') },
    ].filter(option => HOST_CARDS.backgroundConflict.options.includes(option.id));
    try {
      const record = this.interactions.publishInitiative({ projectId, sessionId: session.id, actionId: HOST_CARDS.backgroundConflict.actionId(row.actionId).slice(0, 160), questions: [{ id: 'decision', header: say('后台改动有冲突', 'Background changes conflict'), question, options, allowCustom: false }] });
      this.mutate(state => { const target = state.projects.find(item => item.id === projectId)?.backgroundChanges?.find(item => item.id === changeId); if (target) target.card = { sessionId: session.id, interactionId: record.id }; });
      return record;
    } catch (problem) { console.warn(`background conflict card ${changeId}: ${problem.message}`); return release(); }
  }
  /** A background change set's B, loaded; null when its worktree is gone. */
  async gitRun(projectId, row) {
    const record = (this.project(projectId)?.git?.worktrees ?? []).find(item => item.id === row.worktreeId && item.state !== 'removed');
    if (!record || record.state === 'missing') return null;
    try { return await this.background.load(projectId, record); } catch { return null; }
  }
  /** Change one background change set row. */
  updateChange(projectId, changeId, change) { this.mutate(state => { const row = state.projects.find(item => item.id === projectId)?.backgroundChanges?.find(item => item.id === changeId); if (row) change(row); }); }
  /**
   * Settle a change set and say so on its line in one write: a line whose set is settled is a delivery (memory
   * evidence enrols it), so it must never be seen settled with the text it had while it waited (MEM-3). `text` is the
   * line's text, or a function of the settled row.
   */
  settleChange(projectId, changeId, change, text) {
    this.mutate(state => {
      const row = state.projects.find(item => item.id === projectId)?.backgroundChanges?.find(item => item.id === changeId); if (!row) return;
      change(row);
      const body = typeof text === 'function' ? text(copy(row)) : text, at = new Date(this.now()).toISOString();
      for (const session of state.sessions) {
        if (session.projectId !== projectId || session.archivedAt) continue;
        const item = session.items?.find(entry => entry.initiative?.backgroundChange === changeId); if (!item) continue;
        item.text = body; item.updatedAt = at; session.updatedAt = at;
        return;
      }
    });
  }
  /** Apply a deferred change set now that the project folder is free (or hand it to a card when it may not be written). */
  async applyDeferred(projectId, changeId) {
    const row = this.project(projectId)?.backgroundChanges?.find(item => item.id === changeId);
    if (!row || row.status !== 'deferred') return;
    const bg = await this.gitRun(projectId, row);
    if (!bg) { this.settleGone(projectId, row); return; }
    const outcome = await this.background.settle(bg, { completed: row.cleanOnly !== true, hold: () => this.applyHold(projectId) });
    // The user's git operation in the project folder: no timer; the set goes on when the operation ends.
    if (outcome.status === 'held' && outcome.reason === 'git_operation') { this.holdOnOperation(projectId, changeId, outcome.operation); return; }
    if (outcome.status === 'held' && outcome.reason !== 'read_only') {
      // Still racing with writes into the project folder (or held again): try again shortly.
      this.updateChange(projectId, changeId, target => { target.hold = outcome.reason; delete target.operation; target.retryAt = this.now() + 30000; });
      setTimeout(() => this.scheduleGitUpkeep(), 30000).unref?.();
      return;
    }
    const status = outcome.status === 'applied' || outcome.status === 'nothing' ? 'kept' : 'merge_conflicted';
    if (status === 'kept') { if (bg.unverified) this.background.release(bg, 'kept'); else await this.background.close(bg).catch(() => {}); }
    const project = this.project(projectId);
    this.settleChange(projectId, changeId, target => {
      Object.assign(target, { status, applyId: bg.applyIds[0] ?? null, applyIds: [...bg.applyIds], files: [...bg.files.values()], at: target.at });
      delete target.retryAt; delete target.cleanOnly; delete target.operation;
      if (outcome.status === 'held') target.hold = outcome.reason; else delete target.hold;
      if (outcome.conflicts?.length) target.conflicts = outcome.conflicts.slice(0, 200); else delete target.conflicts;
      if (outcome.secret?.length) target.secret = outcome.secret.slice(0, 50); else delete target.secret;
    }, updated => this.gitChangeText(project, { id: row.actionId, title: row.task }, updated, rowResult(updated)));
    if (status !== 'kept') this.postGitCard(projectId, changeId);
  }
  /** The answer to a background conflict card: rna | clean_only | background | discard (design §4.3). */
  async answerGitCard(projectId, changeId, choice) {
    const project = this.project(projectId), row = project?.backgroundChanges?.find(item => item.id === changeId);
    if (!row || row.status !== 'merge_conflicted') return;
    const language = interfaceLanguageOf(this.store.state), say = (zh, en) => inLanguage(language, { zh, en }), lead = say(`这次后台做的是：${row.task}`, `This background task: ${row.task}`);
    // An answer that writes into the project folder waits while the user's git operation runs there: the answer stays
    // on its card (not taken up yet), the line says so, and it is carried out once the operation ends.
    const holdAnswer = operation => {
      (this.heldGitAnswers ??= new Map()).set(changeId, projectId);
      this.updateChange(projectId, changeId, target => { delete target.answer; delete target.answeredAt; });
      this.gitLine(projectId, changeId, `${lead}\n\n${say(`项目文件夹正在进行 git ${operation ?? '操作'}，等它结束后再按你的选择应用。`, `A git ${operation ?? 'operation'} is in progress in the project folder; your choice is applied once it ends.`)}`);
      this.retryWhenFree(projectId);
    };
    if (['clean_only', 'background'].includes(choice)) { const operation = await this.background.operation(projectId); if (operation) { holdAnswer(operation); return; } }
    this.updateChange(projectId, changeId, target => { target.answer = choice; target.answeredAt = new Date(this.now()).toISOString(); });
    const bg = await this.gitRun(projectId, row);
    if (!bg) { this.settleGone(projectId, row); return; }
    if (choice === 'discard') {
      try { await this.background.close(bg); }
      catch (problem) { this.background.release(bg); throw problem; }
      this.settleChange(projectId, changeId, target => { target.status = target.applyIds?.length ? 'kept' : 'reverted'; target.discarded = true; delete target.conflicts; delete target.hold; delete target.retryAt; delete target.operation; }, [`${lead}\n\n${say('后台还没应用的改动已丢弃。', 'The background changes that were not applied yet were discarded.')}`, this.secretText(row.secret)].filter(Boolean).join('\n\n'));
      return;
    }
    if (choice === 'rna') {
      const session = this.store.state.sessions.find(item => item.id === row.sessionId && !item.archivedAt);
      const text = say(`处理后台工作「${row.task}」和项目文件夹的冲突：把它的改动合并进来，并解决冲突。\nagent_merge({"changeId":"${changeId}"})`, `Resolve the conflicts between the background work "${row.task}" and the project folder: merge its changes in and settle the conflicts.\nagent_merge({"changeId":"${changeId}"})`);
      try { if (!session) throw new Error('no conversation'); this.store.message(session.id, { text, requestId: randomUUID(), delivery: 'followup' }); }
      catch { this.background.release(bg); this.gitLine(projectId, changeId, `${lead}\n\n${say('没能在对话里开一轮处理；它的改动留在工作副本里，可以在项目设置的「工作树与 Git」里应用或丢弃。', 'A turn to handle it could not start; its changes stay in their working copy, where Project settings › Worktrees & Git can apply or discard them.')}`); return; }
      this.updateChange(projectId, changeId, target => { target.handedTo = session.id; target.handedAt = new Date(this.now()).toISOString(); });
      // The conversation settles it with agent_merge; should it not, the worktree panel can still apply or discard it.
      this.background.release(bg);
      return;
    }
    // Writing into the project folder is the user's action here: it needs the project's foreground write access.
    if (!toolPermitted(project, { permission: 'write' }, 'foreground') || project.archivedAt || this.store.state.emergency) {
      this.background.release(bg);
      this.gitLine(projectId, changeId, `${lead}\n\n${say('这个项目现在是只读的，没有应用；它的改动留在工作副本里，可以在项目设置的「工作树与 Git」里处理。', 'This project is read only now, so nothing was applied; the changes stay in their working copy, which Project settings › Worktrees & Git can handle.')}`);
      return;
    }
    let outcome;
    try { outcome = choice === 'background' ? await this.background.applyBackground(bg) : await this.background.applyClean(bg); }
    catch (problem) {
      // Nothing is lost: the changes stay in their working copy, which the worktree panel can still apply or discard.
      this.background.release(bg);
      this.gitLine(projectId, changeId, `${lead}\n\n${say('这次没能应用；改动留在工作副本里，可以在项目设置的「工作树与 Git」里应用或丢弃。', 'It could not be applied this time; the changes stay in their working copy, where Project settings › Worktrees & Git can apply or discard them.')}`);
      throw problem;
    }
    // The user's git operation began in between: nothing was written; the answer is carried out once it ends.
    if (outcome.status === 'held') { holdAnswer(outcome.operation); return; }
    const left = outcome.conflicts ?? [];
    if (left.length || bg.unverified) this.background.release(bg); else await this.background.close(bg).catch(() => {});
    const count = bg.files.size;
    const text = choice === 'background'
      ? say(`已把后台的版本应用到项目文件夹（${count} 个文件），冲突的文件也用了后台的版本；可以一键回退。`, `The background version was applied to the project folder (${count} file${count === 1 ? '' : 's'}), conflicting files included; it can be rolled back in one click.`)
      : say(`已应用不冲突的 ${count} 个文件；冲突的文件保留了项目文件夹的版本。`, `Applied the ${count} file${count === 1 ? '' : 's'} without conflicts; conflicting files kept the project folder’s version.`);
    const rest = left.length ? say(`还有 ${left.length} 个文件（${left.slice(0, 4).map(item => item.path).join('、')}）只能由你处理，改动留在工作副本里，可以在项目设置的「工作树与 Git」里查看。`, ` ${left.length} file${left.length === 1 ? '' : 's'} (${left.slice(0, 4).map(item => item.path).join(', ')}) can only be settled by you; they stay in the working copy, shown in Project settings › Worktrees & Git.`) : '';
    const secret = outcome.secret ?? row.secret ?? [];
    this.settleChange(projectId, changeId, target => { Object.assign(target, { status: 'kept', applyId: bg.applyIds[0] ?? null, applyIds: [...bg.applyIds], files: [...bg.files.values()] }); delete target.hold; if (left.length) target.conflicts = left.slice(0, 200); else delete target.conflicts; if (secret.length) target.secret = secret.slice(0, 50); else delete target.secret; }, [`${lead}\n\n${text}${rest}`, this.secretText(secret)].filter(Boolean).join('\n\n'));
  }
  /**
   * A change set whose worktree is gone (the worktree panel applied or discarded it, or its folder went): its row
   * follows the records, and its line says so in the same write (MEM-3: a settled line is a delivery).
   */
  settleGone(projectId, row) {
    const project = this.project(projectId);
    const records = (project?.git?.applies ?? []).filter(item => item.source?.worktreeId === row.worktreeId && item.target === 'project' && ['verified', 'unverified'].includes(item.state) && item.kind !== 'rollback');
    const earlier = gitChangeApplyIds(row), fresh = records.some(item => !earlier.includes(item.id)), removed = (project?.git?.worktrees ?? []).find(item => item.id === row.worktreeId)?.state === 'removed';
    this.settleChange(projectId, row.id, target => {
      const ids = [...new Set([...(target.applyIds ?? []), ...records.map(item => item.id)])];
      Object.assign(target, { status: ids.length ? 'kept' : 'reverted', applyIds: ids, applyId: ids[0] ?? null, ...(ids.length ? {} : { discarded: true }) });
      delete target.hold; delete target.retryAt; delete target.operation;
    }, updated => this.goneText(updated, { fresh, removed }));
  }
  /** The line of a change set whose worktree is gone (settleGone): applied from the worktree panel, else what was not applied. */
  goneText(row, { fresh = false, removed = false } = {}) {
    const say = (zh, en) => inLanguage(interfaceLanguageOf(this.store.state), { zh, en });
    const lead = row.task ? say(`这次后台做的是：${row.task}`, `This background task: ${row.task}`) : say('后台工作结束了。', 'Background work ended.');
    const body = fresh ? say('它的改动已经在项目设置的「工作树与 Git」里应用到项目文件夹。', 'Its changes were applied to the project folder from Project settings › Worktrees & Git.')
      : gitChangeApplyIds(row).length ? (removed ? say('不冲突的文件已经应用；其余的改动随它的工作副本在项目设置的「工作树与 Git」里丢弃了。', 'The files without conflicts were applied; the rest was discarded with its working copy in Project settings › Worktrees & Git.')
        : say('不冲突的文件已经应用；其余的改动没有应用，它的工作副本已经不在了。', 'The files without conflicts were applied; the rest was not applied, since its working copy is gone.'))
      : removed ? say('它的工作副本已经在项目设置的「工作树与 Git」里移除，改动没有应用。', 'Its working copy was removed in Project settings › Worktrees & Git, and its changes were not applied.')
      : say('它的工作副本已经不在了，改动没有应用。', 'Its working copy is gone, so its changes were not applied.');
    return `${lead}\n\n${body}`;
  }
  /** The line of a change set the conversation settled with agent_merge: merged there, or dropped there. */
  mergedText(row, settled) {
    const say = (zh, en) => inLanguage(interfaceLanguageOf(this.store.state), { zh, en }), count = row.files?.length ?? 0;
    const lead = row.task ? say(`这次后台做的是：${row.task}`, `This background task: ${row.task}`) : say('后台工作结束了。', 'Background work ended.');
    return `${lead}\n\n${settled === 'merged'
      ? say(`对话里已经合并了它的改动（${count} 个文件），冲突也处理好了。`, `The conversation merged its changes (${count} file${count === 1 ? '' : 's'}) and settled the conflicts.`)
      : say('对话里决定不合并它的改动，这些改动已经丢弃。', 'The conversation chose not to merge its changes, and they were dropped.')}`;
  }
  /**
   * `agent_merge({ changeId })` (T3 forwards it; design §4.1 actions over a background change set handed to this
   * conversation): merge into the conversation's root, then show / take / resolved / drop. Answers a ToolResult whose
   * JSON is the agent_merge result; refusals are isError with `details.code`.
   */
  async backgroundMerge({ projectId, sessionId, changeId, action = 'merge', path, page, take } = {}, signal) {
    const refuse = (code, message) => ({ isError: true, content: [{ type: 'text', text: message }], details: { code } });
    signal?.throwIfAborted?.();
    const project = this.project(projectId), row = project?.backgroundChanges?.find(item => item.id === changeId && item.kind === 'git');
    if (!row || !sessionId || (row.sessionId !== sessionId && row.handedTo !== sessionId)) return refuse('merge_unknown', 'No background change set with this changeId was handed to this conversation.');
    if (!this.background?.ready()) return refuse('merge_unknown', 'Background worktrees are not available on this host.');
    if (!toolPermitted(project, { permission: 'write' }, 'foreground') || project.archivedAt) return refuse('delegation_permission', 'The project is read only now, so nothing can be merged.');
    if (!['merge_conflicted', 'deferred'].includes(row.status)) return { content: [{ type: 'text', text: JSON.stringify({ status: row.status === 'kept' ? 'merged' : 'dropped', applied: [], conflicts: [], notMerged: [], notes: ['This change set is already settled.'] }) }] };
    if (this.gitBusy.has(changeId) || this.gitBusy.has(row.worktreeId)) return refuse('merge_not_finished', 'The host is applying this change set right now; try again in a moment.');
    const bg = await this.gitRun(projectId, row);
    if (!bg) { this.settleGone(projectId, row); return refuse('merge_unknown', 'The working copy of this change set is gone; nothing is left to merge.'); }
    this.gitBusy.add(changeId);
    let answer;
    try {
      // The turn's signal: Stop ends what this call waits for (Rna's own commands running out); the user's git operation
      // in the project folder is refused at once (git_operation_in_progress), never waited on.
      answer = await this.background.handoff(bg, { sessionId, action, path, page, take, handoff: row.handoff ?? null, signal });
      // Settled (merged, or dropped): B goes before the row says so.
      if (answer.settled) await this.background.close(bg).catch(() => {});
    }
    catch (failure) { return refuse(failure?.code ?? 'merge_unknown', failure?.message ?? 'The merge could not run.'); }
    finally { this.gitBusy.delete(changeId); }
    const record = target => {
      Object.assign(target, { applyIds: [...bg.applyIds], applyId: bg.applyIds[0] ?? null, files: [...bg.files.values()] });
      if (answer.handoff) { target.handoff = answer.handoff; target.status = 'merge_conflicted'; target.conflicts = answer.handoff.conflicts.map(item => ({ path: item.path, kind: item.kind })).slice(0, 200); delete target.hold; }
      else delete target.handoff;
      // Settled: nothing waits any more (a hold, a retry or a git operation it waited on).
      if (answer.settled) { delete target.conflicts; delete target.hold; delete target.retryAt; delete target.operation; }
      if (answer.settled === 'merged') target.status = 'kept';
      // The conversation's own drop: not the user's undo (project-mind workOutcomeChanges reopens it as change_dropped).
      if (answer.settled === 'dropped') Object.assign(target, { status: 'reverted', discarded: true, droppedBy: 'agent' });
    };
    // A settled set says so on its line in the same write (MEM-3: a settled line is a delivery).
    if (answer.settled) this.settleChange(projectId, changeId, record, updated => this.mergedText(updated, answer.settled));
    else this.updateChange(projectId, changeId, record);
    return { content: [{ type: 'text', text: JSON.stringify(answer.result) }] };
  }
  /** Run the background worktree upkeep soon (coalesced): deferred applies, card answers, row statuses, startup recovery. */
  scheduleGitUpkeep() {
    if (this.closed || this.gitUpkeepQueued || !this.background?.ready()) return;
    this.gitUpkeepQueued = true;
    setImmediate(() => { this.gitUpkeepQueued = false; void this.gitUpkeep().catch(problem => console.warn(`background worktrees: ${problem.message}`)); });
  }
  /**
   * The background worktree upkeep: deferred applies, card answers, row statuses; the first pass settles worktrees a
   * restart cut off (recoverWorktrees). Each project runs on its own (projectGitUpkeep): one project's held, slow or
   * failing pass never holds another's (review: the loop was one for every project). Answers once every project's
   * pass it started or joined is done.
   */
  async gitUpkeep() {
    if (this.closed || !this.background?.ready()) return;
    if (!this.gitRecovered) { this.gitRecovered = true; void this.recoverWorktrees(); }
    await Promise.allSettled(this.store.state.projects.map(project => this.projectGitUpkeep(project.id)));
  }
  /** One project's upkeep pass, coalesced: asked again while it runs, it runs once more afterwards. */
  projectGitUpkeep(projectId) {
    this.gitRuns ??= new Map(); this.gitAgainFor ??= new Set();
    const running = this.gitRuns.get(projectId);
    if (running) { this.gitAgainFor.add(projectId); return running; }
    const run = this.upkeepProject(projectId).catch(problem => console.warn(`background worktrees ${projectId}: ${problem.message}`)).finally(() => {
      if (this.gitRuns.get(projectId) === run) this.gitRuns.delete(projectId);
      if (this.gitAgainFor.delete(projectId) && !this.closed) setImmediate(() => { void this.projectGitUpkeep(projectId); });
    });
    this.gitRuns.set(projectId, run);
    return run;
  }
  async upkeepProject(projectId) {
    await this.gitRecoveries?.get(projectId);
    if (this.closed || !this.project(projectId)) return;
    this.syncGitRows(projectId);
    // The user's git operation in the project folder (merge, rebase, …), checked by code at most once per pass and only
    // when something can have changed it: a pass about to write there (the folder's own hold ended, a retry timer
    // came due, a set was just recorded), or a set named after an operation whose watch is no longer waiting (the
    // watch saw it end, or a restart dropped the watch). While the engine's watch waits, nothing here asks again; a
    // pass started by any other store change while the folder is held otherwise starts no git process (review C1/X4).
    let operation;
    const busy = async () => {
      if (this.background.engine?.waitingFree?.(projectId)) return true;
      if (operation === undefined) operation = await this.background.operation(projectId);
      if (operation) this.retryWhenFree(projectId);
      return Boolean(operation);
    };
    for (const row of this.project(projectId)?.backgroundChanges ?? []) {
      if (this.closed) return;
      if (row.kind !== 'git' || this.gitBusy.has(row.id) || this.gitBusy.has(row.worktreeId) || this.liveRun(row.actionId)) continue;
      // A set held on a git operation has no retry time (its watch runs a pass when it ends); one whose apply failed
      // waits for its retry time whatever held it, so a failing apply is not repeated on every store change.
      if (row.status === 'deferred' && this.now() >= (row.retryAt ?? 0)) {
        const hold = this.applyHold(projectId);
        if (hold === 'read_only') { await this.guarded(row.id, () => this.holdReadOnly(projectId, row.id)); continue; }
        // The folder is held otherwise (a direct-mode turn, plan mode, maintenance): nothing is written now, so the
        // operation matters only to a set still named after one, and only once its watch stopped waiting (it ended):
        // the row and line then say what holds it now. The end of that hold is a store change, which runs a pass.
        if (hold === 'deferred') { if (row.hold === 'git_operation' && !(await busy())) this.reholdDeferred(projectId, row.id); continue; }
        if (await busy()) {
          // Held for another reason until now (the turn that held the folder ended): the row and line name the operation.
          if (row.hold !== 'git_operation') { operation ??= await this.background.operation(projectId); if (operation) this.holdOnOperation(projectId, row.id, operation); }
          continue;
        }
        await this.guarded(row.id, () => this.applyDeferred(projectId, row.id), () => this.retryDeferredLater(projectId, row.id));
      } else if (row.status === 'merge_conflicted' && row.card && !row.answer) {
        const record = this.store.state.sessions.find(session => session.id === row.card.sessionId)?.items.find(item => item.interaction?.id === row.card.interactionId)?.interaction;
        const choice = record?.status === 'answered' ? record.answers?.[0]?.selected?.[0] : null;
        if (!HOST_CARDS.backgroundConflict.options.includes(choice)) continue;
        // An answer held on the user's git operation in the project folder (answerGitCard said so on its line) is taken
        // up again once the operation ends (retryWhenFree), not on every pass meanwhile.
        if (this.heldGitAnswers?.has(row.id)) continue;
        await this.guarded(row.id, () => this.answerGitCard(projectId, row.id, choice));
      }
    }
  }
  /** A deferred set held on the user's git operation in the project folder: the row and its line say so (no timer). */
  holdOnOperation(projectId, changeId, operation) {
    this.updateChange(projectId, changeId, target => { target.hold = 'git_operation'; if (operation) target.operation = operation; else delete target.operation; delete target.retryAt; });
    const row = this.project(projectId)?.backgroundChanges?.find(item => item.id === changeId);
    if (row) this.gitLine(projectId, changeId, this.gitChangeText(this.project(projectId), { id: row.actionId, title: row.task }, row, rowResult(row)));
    this.retryWhenFree(projectId);
  }
  /** A set held on a git operation that ended while the folder is held otherwise: the row and line say so now. */
  reholdDeferred(projectId, changeId) {
    this.updateChange(projectId, changeId, target => { target.hold = 'deferred'; delete target.operation; });
    const row = this.project(projectId).backgroundChanges.find(item => item.id === changeId);
    this.gitLine(projectId, changeId, this.gitChangeText(this.project(projectId), { id: row.actionId, title: row.task }, row, rowResult(row)));
  }
  async guarded(id, work, failed = null) {
    this.gitBusy.add(id);
    try { await work(); } catch (problem) { console.warn(`background change ${id}: ${problem.message}`); try { failed?.(problem); } catch { /* the next pass */ } } finally { this.gitBusy.delete(id); }
  }
  /** A deferred set whose apply failed (an engine error, not a hold): tried again once its retry time comes (one timer), not on every store change. */
  retryDeferredLater(projectId, changeId) {
    if (this.closed) return;
    this.updateChange(projectId, changeId, target => { if (target.status === 'deferred') target.retryAt = this.now() + 30000; });
    setTimeout(() => this.scheduleGitUpkeep(), 30000).unref?.();
  }
  /** A deferred change set that may no longer be written by background work: the card decides. */
  holdReadOnly(projectId, changeId) {
    this.updateChange(projectId, changeId, target => { target.status = 'merge_conflicted'; target.hold = 'read_only'; delete target.retryAt; });
    const row = this.project(projectId).backgroundChanges.find(item => item.id === changeId);
    this.gitLine(projectId, changeId, this.gitChangeText(this.project(projectId), { id: row.actionId, title: row.task }, row, rowResult(row)));
    this.postGitCard(projectId, changeId);
  }
  /**
   * Row statuses follow their apply records: rolled back (from the apply history, the line's two-step rollback) →
   * `reverted`, the rollback undone → `kept` again; a pending set whose worktree the worktree panel settled → by its
   * records.
   */
  syncGitRows(projectId) {
    const project = this.project(projectId), rows = (project?.backgroundChanges ?? []).filter(row => row.kind === 'git');
    if (!rows.length) return;
    const applies = new Map((project.git?.applies ?? []).map(row => [row.id, row])), worktrees = new Map((project.git?.worktrees ?? []).map(row => [row.id, row]));
    const changes = [];
    for (const row of rows) {
      if (this.gitBusy.has(row.id) || this.gitBusy.has(row.worktreeId)) continue;
      // The set's records in the project folder: reverted once none of them stands, kept again once one does (an undo).
      const states = gitChangeApplyIds(row).map(id => applies.get(id)).filter(item => item && item.target === 'project').map(item => item.state);
      if (row.status === 'kept' && states.length && states.every(state => state === 'rolled_back')) changes.push([row.id, 'reverted']);
      else if (row.status === 'reverted' && !row.discarded && states.some(state => ['verified', 'unverified'].includes(state))) changes.push([row.id, 'kept']);
      else if (['deferred', 'merge_conflicted'].includes(row.status) && !this.liveRun(row.actionId) && (!worktrees.get(row.worktreeId) || worktrees.get(row.worktreeId).state === 'removed')) changes.push([row.id, 'gone']);
    }
    for (const [id, status] of changes) {
      if (status === 'gone') { this.settleGone(projectId, rows.find(row => row.id === id)); continue; }
      this.updateChange(projectId, id, target => { target.status = status; if (status === 'reverted') target.revertedAt = new Date(this.now()).toISOString(); });
      // Rolled back from the apply history (or that rollback undone): the line follows, as after the revert button.
      this.revertedLine(projectId, id, status === 'reverted');
    }
  }
  /**
   * Startup (design §6.5 for background): a B still `active` whose run is no longer going on (a restart cut it off, or
   * a paused run was stopped meanwhile) is settled like a failed run: what does not conflict is applied, the rest goes
   * to a card. Paused and queued runs keep theirs; pending change sets are the upkeep's.
   */
  recoverWorktrees() {
    this.gitRecoveries ??= new Map();
    // Projects settle independently: one project's held or slow settlement never holds another's.
    const runs = this.store.state.projects.map(project => {
      const run = this.recoverProjectWorktrees(project.id).catch(problem => console.warn(`background worktrees ${project.id} at start: ${problem.message}`));
      this.gitRecoveries.set(project.id, run);
      return run;
    });
    return Promise.allSettled(runs).then(() => undefined);
  }
  async recoverProjectWorktrees(projectId) {
    const project = this.project(projectId);
    if (!project) return;
    for (const record of project.git?.worktrees ?? []) {
      if (this.closed) return;
      if (record.kind !== 'background' || record.state !== 'active') continue;
      const current = this.project(projectId) ?? project;
      const actionId = record.owner?.actionId;
      if (!actionId || this.liveRun(actionId) || this.gitBusy.has(record.id) || (current.backgroundChanges ?? []).some(row => row.worktreeId === record.id && ['deferred', 'merge_conflicted'].includes(row.status))) continue;
      const actions = current.initiativeRuntime?.sdkState?.actions ?? [], action = actions.find(row => row.id === actionId), base = actions.find(row => row.id === actionId.replace(/-direct$/, ''));
      if (['running', 'paused', 'queued'].includes(action?.status ?? (actionId.endsWith('-direct') ? base?.status : undefined))) continue;
      const bg = await this.background.load(projectId, record).catch(() => null);
      // Its working copy cannot be read: the line says so and is final (its worktree stays for the worktree panel).
      if (!bg) { try { this.finishRecoveringLine(projectId, actionId, 'unreadable'); } catch { /* the line is a courtesy */ } continue; }
      const job = (current.jobs ?? []).find(row => row.id === actionId);
      // A run stopped while paused (by the user, or by a project change) ended that way; anything else was cut off.
      const ending = action?.status === 'cancelled' ? (action.cancellationReason === 'action_control' ? { cancelled: true } : { superseded: true }) : { failed: true, code: 'daemon_restart' };
      try { await this.keepGitChanges({ projectId }, action ?? { id: actionId, content: job?.instruction ?? '', ...(job?.title ? { title: job.title } : {}) }, bg, ending); }
      catch (problem) { console.warn(`background worktree ${record.id}: ${problem.message}`); }
    }
    if (this.closed) return;
    // A cut-off run whose working copy is no longer active (the worktree panel applied or removed it before this ran,
    // or it is kept there or gone): nothing here settles it any more, so its line says what became of it (MEM-3).
    const latest = this.project(projectId); if (!latest) return;
    const records = latest.git?.worktrees ?? [], applies = latest.git?.applies ?? [];
    const pending = new Set(this.store.state.sessions.filter(session => session.projectId === projectId).flatMap(session => (session.items ?? []).map(item => item.initiative?.backgroundWork).filter(work => work?.status === 'interrupted' && work.recovering && typeof work.actionId === 'string').map(work => work.actionId)));
    for (const actionId of pending) {
      const owned = records.filter(row => row.kind === 'background' && row.owner?.actionId === actionId);
      if (this.liveRun(actionId) || owned.some(row => row.state === 'active')) continue;
      const record = owned.find(row => row.state !== 'removed') ?? owned.at(-1);
      const applied = record && applies.some(row => row.source?.worktreeId === record.id && row.target === 'project' && ['verified', 'unverified'].includes(row.state) && row.kind !== 'rollback');
      const kind = !record || record.state === 'missing' ? 'gone' : record.state === 'removed' ? (applied ? 'applied' : 'removed') : 'kept';
      try { this.finishRecoveringLine(projectId, actionId, kind); } catch { /* the line is a courtesy */ }
    }
  }
  /**
   * The line of a writing background run, once it ends, says what the work did before listing its files:
   * the worker's own handoff line (what was done and what is left), else the task it was given. A run
   * that stopped on an unsent tool call says so, since its last step may be unfinished; one that made
   * no change says that too (the line was already in the conversation while it worked).
   */
  backgroundChangeText(action, count, result = null, project = null) {
    const language = interfaceLanguageOf(this.store.state), plural = count === 1 ? '' : 's', say = (zh, en) => inLanguage(language, { zh, en });
    const clean = value => withoutHandles((typeof this.redact === 'function' ? this.redact(value) : String(value ?? '')).replace(/\s+/g, ' ').trim());
    const note = result && !result.unreported && result.reported ? clean(result.reported) : '', task = result ? this.actionName(project, action, { language }) : '';
    const changed = count
      ? { zh: `改了 ${count} 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。`, en: `Changed ${count} file${plural}; each change is listed below to review, and all of them can be reverted in one click.` }
      : { zh: '没有改动文件。', en: 'No files were changed.' };
    const before = count
      ? { zh: `停之前已经改了 ${count} 个文件，以下面的改动为准，可以逐个查看；需要的话可以一键回退。`, en: `It had already changed ${count} file${plural}; go by the changes listed below, and revert them all in one click if needed.` }
      : { zh: '停之前没有改动文件。', en: 'It had not changed any file.' };
    if (note) return say(`${note}\n\n${changed.zh}`, `${note}\n\n${changed.en}`);
    if (task && result?.failed && result.code === 'foreground_started') return say(`这次后台在做：${task}\n\n你在对话里开始了新的一轮，它先停下，由这一轮接着做。${before.zh}`, `This background task was: ${task}\n\nYou started a new turn in the conversation, so it stopped and that turn carries on. ${before.en}`);
    if (task && result?.cancelled) return say(`这次后台在做：${task}\n\n按你的要求停下了。${before.zh}`, `This background task was: ${task}\n\nIt stopped as you asked. ${before.en}`);
    if (task && result?.superseded) return say(`这次后台在做：${task}\n\n项目的情况变了，这次后台工作没有继续。${before.zh}`, `This background task was: ${task}\n\nThe project changed, so this background work did not go on. ${before.en}`);
    if (task && result?.failed) return say(`这次后台在做：${task}\n\n它没有做完就停了。${before.zh}`, `This background task was: ${task}\n\nIt stopped before finishing. ${before.en}`);
    if (task && result?.unreported) return say(`这次后台在做：${task}\n\n它停在半途，没有留下完成汇报，最后一步可能没做完。${count ? `改了 ${count} 个文件，以下面的改动为准，可以逐个查看；需要的话可以一键回退。` : changed.zh}`, `This background task was: ${task}\n\nIt stopped mid-step without a report, so its last step may be unfinished. ${count ? `It changed ${count} file${plural}; go by the changes listed below, and revert them all in one click if needed.` : changed.en}`);
    if (task) return say(`这次后台做的是：${task}\n\n${count ? changed.zh : '做完了，没有改动文件。'}`, `This background task: ${task}\n\n${count ? changed.en : 'Done; no files were changed.'}`);
    return say(count ? `后台改了 ${count} 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。` : '后台工作结束了，没有改动文件。', count ? `Background work changed ${count} file${plural}; each change is listed below to review, and all of them can be reverted in one click.` : 'Background work ended without changing any file.');
  }
  /** What one background change set did, file by file (GET /api/projects/:id/background-changes/:changeId). */
  backgroundChangeDetail(projectId, changeId) {
    const project = this.project(projectId), change = project?.backgroundChanges?.find(row => row.id === changeId);
    if (!change) throw Object.assign(new Error('这组后台改动不存在或已过期'), { status: 404, code: 'change_not_found' });
    // A git change set (design §8) has no DirectFix snapshots: its files and patches are its apply records' (GET …/applies/:applyId).
    if (change.kind === 'git') return { id: change.id, actionId: change.actionId, at: change.at, status: change.status, kind: 'git', applyId: change.applyId ?? null, skipped: 0, files: [] };
    const files = change.status === 'kept' ? readDirectFix(this.backgroundChangeDir(), changeId, project.workspace, change.files)
      : change.files.map(row => ({ path: row.path, created: !row.existed, deleted: row.afterSha === null, changedSince: false, before: null, after: null, binary: false, truncated: false, available: false }));
    return { id: change.id, actionId: change.actionId, at: change.at, status: change.status, skipped: change.skipped ?? 0, files };
  }
  /**
   * Revert one background change set (POST /api/projects/:id/background-changes/:changeId/revert). A git change set
   * (design §8 :1388) rolls back through its apply record in two steps (§5.2): without `confirm` the preview
   * `{ confirm, expiresAt, files, skipped }`, with it the rollback; that answer is a promise (the route awaits it).
   * Older sets keep the one-click DirectFix revert.
   */
  revertBackgroundChange(projectId, changeId, input) {
    const project = this.project(projectId), change = project?.backgroundChanges?.find(row => row.id === changeId);
    if (!change) throw Object.assign(new Error('这组后台改动不存在或已过期'), { status: 404, code: 'change_not_found' });
    if (change.kind === 'git') return this.revertGitChange(projectId, change, input);
    if (change.status !== 'kept') return { status: change.status, outcome: change.outcome ?? null };
    const undo = this.userUndoWrite(projectId);
    let outcome; try { outcome = revertDirectFix(this.backgroundChangeDir(), changeId, projectWorkspace(project.workspace), change.files); } catch { outcome = { restored: [], conflicts: [], failed: change.files.map(row => row.path) }; }
    void undo?.end(outcome.restored);
    discardDirectFix(this.backgroundChangeDir(), changeId);
    const at = new Date(this.now()).toISOString();
    this.mutate(state => {
      const target = state.projects.find(row => row.id === projectId), row = target?.backgroundChanges?.find(entry => entry.id === changeId); if (!row) return;
      Object.assign(row, { status: 'reverted', revertedAt: at, outcome });
      const session = state.sessions.find(entry => entry.items?.some(item => item.initiative?.backgroundChange === changeId));
      if (session && !session.archivedAt) {
        const text = this.revertNotice(outcome);
        session.items.push({ id: randomUUID(), turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId, decisionMode: 'rna-model', initiativeActionId: `${row.actionId}-changes-revert`, initiative: { kind: 'insight', reach: 'inbox' } }); session.updatedAt = at;
      }
    });
    return { status: 'reverted', outcome };
  }
  async revertGitChange(projectId, change, input) {
    if (change.status !== 'kept' || !change.applyId) return { status: change.status, outcome: change.outcome ?? null };
    if (!this.background?.ready()) throw Object.assign(new Error(inLanguage(interfaceLanguageOf(this.store.state), { zh: '回退现在不可用。', en: 'Rolling back is not available right now.' })), { status: 503, code: 'git_unavailable' });
    // A set applied by more than one record (its clean part, then a card's "background's version" or a take) rolls back
    // all of them, as one rollback record; one record keeps the single-record rollback (with `undoes`).
    const ids = gitChangeApplyIds(change), engine = this.background.engine;
    // The user's revert (this route only): the rollback record says so, which is what the models are told (workspace-events.mjs).
    const result = ids.length > 1 ? await engine.rollbackRecords(projectId, ids, input ?? {}, { key: `change:${change.id}`, source: change.actionId ? { actionId: change.actionId } : {}, initiator: 'user' }) : await engine.rollback(projectId, change.applyId, input ?? {}, { initiator: 'user' });
    if (result.confirm) return result;
    const outcome = { restored: result.restored ?? [], conflicts: (result.skipped ?? []).map(row => row.path), failed: [] };
    this.updateChange(projectId, change.id, target => { target.status = 'reverted'; target.revertedAt = new Date(this.now()).toISOString(); target.outcome = outcome; });
    this.revertedLine(projectId, change.id, true, outcome);
    return { status: 'reverted', ...result, outcome };
  }
  /** The conversation notice of a one-click revert (older change sets, direct fixes), in the interface language. */
  revertNotice(outcome, { fix = false } = {}) {
    const language = interfaceLanguageOf(this.store.state), join = list => list.join(language === 'en' ? ', ' : '、'), count = outcome.restored.length, kept = outcome.conflicts.length;
    return [inLanguage(language, { zh: `已回退 ${count} 个文件${count ? `：${join(outcome.restored)}` : ''}。`, en: `Reverted ${count} file${count === 1 ? '' : 's'}${count ? `: ${join(outcome.restored)}` : ''}.` }),
      ...(kept ? [inLanguage(language, fix ? { zh: `${join(outcome.conflicts)} 在修正之后又被改过，为免覆盖新的内容，没有回退。`, en: `${join(outcome.conflicts)} changed after the fix, so ${kept === 1 ? 'it was' : 'they were'} not reverted, to keep the newer content.` } : { zh: `${join(outcome.conflicts)} 之后又被改过，为免覆盖新内容没有回退。`, en: `${join(outcome.conflicts)} changed afterwards, so ${kept === 1 ? 'it was' : 'they were'} not reverted, to keep the newer content.` })] : []),
      ...(outcome.failed.length ? [inLanguage(language, { zh: `${join(outcome.failed)} 无法还原。`, en: `${join(outcome.failed)} could not be restored.` })] : [])].join('\n');
  }
  /**
   * A git change set the user reverted (its revert button, or its records rolled back from the apply history): the
   * foreground reads its line as a collaborator_finding, so the row keeps a note (`revertNote`) that
   * projectConversationContext attaches to that finding; neither the model nor the user is left with "changed N files"
   * (the card under the line shows 已回退 from the row's status). The line's own text is never rewritten: it is frozen
   * as memory evidence, and a changed source reads as a revocation there (deleted or stuck evidence). Undoing that
   * rollback takes the note back out. Idempotent: syncGitRows and the route may both call it.
   * @param {boolean} reverted
   * @param {{ conflicts?: string[] }|null} [outcome]  files the revert left alone because they changed afterwards
   */
  revertedLine(projectId, changeId, reverted, outcome = null) {
    const kept = outcome?.conflicts ?? [];
    const note = kept.length
      ? `The user reverted these changes; ${kept.slice(0, 6).join(', ')}${kept.length > 6 ? ` and ${kept.length - 6} more` : ''} changed afterwards and kept ${kept.length === 1 ? 'its' : 'their'} current content.`
      : 'The user reverted these changes; the project folder no longer has them.';
    try {
      this.mutate(state => {
        const row = state.projects.find(item => item.id === projectId)?.backgroundChanges?.find(item => item.id === changeId);
        if (!row || (!reverted && !row.revertNote) || (reverted && row.revertNote === note)) return;
        if (reverted) row.revertNote = note; else delete row.revertNote;
      });
    } catch { /* the note is a courtesy */ }
  }
  /** Background work stays read-only until the user chooses otherwise. When the
   * user already gave the foreground write access and is actively working in
   * the project, ask once, in the conversation, whether the collaborator may
   * also do the work itself instead of only reviewing it. Never re-asked. */
  offerBackgroundHelp(project) {
    if (!this.interactions || !this.permissionService || project.initiative?.backgroundOfferAt || project.initiative?.enabled !== true) return;
    const permissions = project.permissions ?? {};
    if ((permissions.background ?? 'read') !== 'read' || (permissions.source && permissions.source !== 'default') || !['write', 'execute'].includes(permissions.workspace)) return;
    const presence = this.presence(project);
    if (!presence.session || presence.pendingQuestion) return;
    const recent = presence.session.items.filter(item => item.kind === 'user' && !item.sourceDeleted && Date.parse(item.createdAt) >= this.now() - 6 * 3600000).length;
    if (recent < 3) return;
    let request;
    // The card is the user's to read (its reason, header, question and option labels), so it follows the interface language; option ids stay.
    const language = interfaceLanguageOf(this.store.state), reason = inLanguage(language, { zh: '现在我在后台只能读文件，所以只能帮你复核。允许后，我可以在后台直接接着做：写下一部分、修掉发现的问题、准备你接下来要用的材料。后台改的每个文件都会在对话里告诉你，并且都能一键回退；后台命令在沙箱里运行，改不到项目以外的文件。', en: 'Right now I can only read files in the background, so all I can do is review for you. If you allow it, I can carry on directly in the background: write the next part, fix the problems I find, prepare the material you will need next. Every file changed in the background is reported in the conversation and can be reverted with one click; background commands run in a sandbox and cannot change files outside the project.' });
    try { request = this.permissionService.request(project.id, { workspace: permissions.workspace, background: 'inherit', reason }, { language }); } catch { return; }
    if (request.alreadyAllowed) return;
    const record = this.interactions.publishInitiative({ projectId: project.id, sessionId: presence.session.id, actionId: `background-help-${project.id}`.slice(0, 160), questions: request.questions, metadata: request.metadata });
    this.mutate(state => { const target = state.projects.find(row => row.id === project.id); if (target) target.initiative.backgroundOfferAt = new Date(this.now()).toISOString(); });
    return record?.id ?? null;
  }
  /** Keep or revert directly handled fixes once the user answers their card. */
  settleDirectFixes(project) {
    const pending = (project.directFixes ?? []).filter(row => row.status === 'pending'); if (!pending.length) return;
    for (const fix of pending) {
      const session = this.store.state.sessions.find(row => row.id === fix.sessionId), record = session?.items.find(item => item.interaction?.id === fix.interactionId)?.interaction;
      if (record && ['pending', 'interrupted'].includes(record.status)) continue;
      const answer = record?.answers?.[0], revert = record?.status === 'answered' && answer?.selected?.includes('revert');
      // A fix made in its own worktree rolls back through its apply records (design §8 :1256), asynchronously.
      if (fix.kind === 'git') { void this.settleGitFix(project.id, fix.id, revert).catch(problem => console.warn(`direct fix ${fix.id}: ${problem.message}`)); continue; }
      let outcome = null;
      if (revert) { const undo = this.userUndoWrite(project.id); try { outcome = revertDirectFix(this.directFixDir(), fix.id, projectWorkspace(project.workspace), fix.files); } catch { outcome = { restored: [], conflicts: [], failed: fix.files.map(row => row.path) }; } void undo?.end(outcome.restored); }
      discardDirectFix(this.directFixDir(), fix.id);
      this.mutate(state => {
        const target = state.projects.find(row => row.id === project.id), row = target?.directFixes?.find(entry => entry.id === fix.id); if (!row || row.status !== 'pending') return;
        const at = new Date(this.now()).toISOString();
        Object.assign(row, { status: revert ? 'reverted' : 'kept', settledAt: at, ...(outcome ? { outcome } : {}) });
        const live = revert && state.sessions.find(entry => entry.id === fix.sessionId);
        if (live && !live.archivedAt) {
          const text = this.revertNotice(outcome, { fix: true });
          live.items.push({ id: randomUUID(), turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId: project.id, decisionMode: 'rna-model', initiativeActionId: `${fix.actionId}-direct-revert`, initiative: { kind: 'insight', reach: 'inbox' } });
          live.updatedAt = at;
        }
      });
    }
  }
  /** The answer to a git fix's 已直接处理 card: keep (nothing to do) or revert (its apply records, three-way, later edits kept). */
  async settleGitFix(projectId, fixId, revert) {
    if (this.gitBusy.has(fixId)) return;
    this.gitBusy.add(fixId);
    try {
      const fix = this.project(projectId)?.directFixes?.find(row => row.id === fixId);
      if (!fix || fix.status !== 'pending') return;
      let outcome = null;
      if (revert) {
        try { outcome = this.background?.ready() ? await this.background.rollback(projectId, fix.applyIds ?? (fix.applyId ? [fix.applyId] : []), { initiator: 'user' }) : { restored: [], conflicts: [], failed: fix.files.map(row => row.path) }; }
        catch { outcome = { restored: [], conflicts: [], failed: fix.files.map(row => row.path) }; }
      }
      this.mutate(state => {
        const target = state.projects.find(row => row.id === projectId), row = target?.directFixes?.find(entry => entry.id === fixId); if (!row || row.status !== 'pending') return;
        const at = new Date(this.now()).toISOString();
        Object.assign(row, { status: revert ? 'reverted' : 'kept', settledAt: at, ...(outcome ? { outcome } : {}) });
        const live = revert && state.sessions.find(entry => entry.id === fix.sessionId);
        if (live && !live.archivedAt) {
          const text = this.revertNotice(outcome, { fix: true });
          live.items.push({ id: randomUUID(), turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId, decisionMode: 'rna-model', initiativeActionId: `${fix.actionId}-direct-revert`, initiative: { kind: 'insight', reach: 'inbox' } });
          live.updatedAt = at;
        }
      });
    } finally { this.gitBusy.delete(fixId); }
  }
  commitShare(context, action, reach, signal, plan = null) {
    signal.throwIfAborted();
    if (!this.current(context, action)) return { superseded: true, usage: { totalTokens: 0 } };
    const project = this.project(context.projectId), presence = this.presenceFor(project, action), inline = !quietReach(reach.tier);
    if (inline) { const reason = this.deliveryGate(project, presence); if (reason) return { deferred: true, reason, usage: { totalTokens: 0 } }; }
    // Every share belongs in the conversation, where it can be answered. A quiet tier only means no
    // attention signal; it is posted when the conversation is idle, else filed and posted later (deliveryUpkeep).
    // A scheduled result whose run had started before the user paused proactive messages is the exception (F9): paused
    // means nothing new appears in the conversation, so it is filed in the inbox only, whatever the conversation does.
    const mutedSchedule = Boolean(action.hostSchedule) && reach.reasons?.includes('notification_muted');
    const chat = inline || reach.tier === 'inbox' && !mutedSchedule && this.quietChatReady(presence);
    const text = plan?.text ?? action.content;
    let entry;
    this.mutate(state => {
      const target = state.projects.find(item => item.id === context.projectId), session = presence.session && state.sessions.find(session => session.id === presence.session.id);
      if (!target || !this.valid(context) || action.hostSchedule && !this.scheduleActionCurrent(context, action) || chat && (!session || session.archivedAt)) throw error('Project changed before delivery', 'stale');
      // The message/inbox entry itself is the durable receipt, committed atomically.
      // It also protects the small crash window before the SDK action save completes.
      if ((target.inbox ?? []).some(row => row.actionId === action.id) || state.sessions.some(row => row.projectId === project.id && row.items.some(item => item.initiativeActionId === action.id || item.initiativeDeliveryKey === action.intentKey || action.hostSchedule && item.scheduleOccurrenceKey === action.hostSchedule.key))) return;
      const at = new Date(this.now()).toISOString();
      let itemId = null;
      if (chat) {
        itemId = randomUUID();
        session.items.push({ id: itemId, turnId: null, kind: 'assistant', text, createdAt: at, simulated: false, source: 'initiative', projectId: project.id, decisionMode: 'rna-model', evidenceIds: copy(action.evidenceIds), reason: action.reason, initiativeActionId: action.id, initiativeDeliveryKey: action.intentKey,
          initiative: { kind: action.hostSchedule ? 'scheduled' : 'insight', reach: reach.tier, ...(plan ? { threadId: plan.thread.id, narrated: narratedView(plan), ...(plan.deliverables ? { deliverables: plan.deliverables } : {}) } : {}) }, ...(action.hostSchedule ? { scheduleId: action.hostSchedule.scheduleId, scheduleOccurrenceKey: action.hostSchedule.key } : {}) });
        session.updatedAt = at; if (inline) target.initiative.lastSpokeAt = at;
      }
      entry = recordDelivery(target, { actionId: action.id, kind: 'share', tier: reach.tier, requested: reach.requested, reasons: reach.reasons, text, sessionId: session?.id ?? presence.session?.id ?? null, itemId, ledgerIds: [...reach.ledgerIds, ...(context.reviewLedger?.revision === action.revision ? [context.reviewLedger.id] : []), ...(plan?.ledgerId ? [plan.ledgerId] : [])], scheduled: Boolean(action.hostSchedule), now: this.now() });
      if (reach.tier === 'notify') entry.notifiedAt = at;
      if (plan) { entry.threadId = plan.thread.id; entry.pacing = pacingRecord(plan, this.now()); if (plan.deliverables) entry.deliverables = plan.deliverables; applyNarration(target, plan, { itemId, entryId: entry.id, sessionId: session?.id ?? null, now: this.now() }); }
      trimInbox(this.store, target);
      entry = copy(entry);
    });
    if (entry?.tier === 'notify') this.notifyDesktop(project, entry);
    if (entry) this.resolveMind(context, action, 'delivery');
    const summary = !inline ? `The finding was filed in the project inbox${reach.tier === 'digest' ? ' for the next daily digest' : ''}; it was not shown in the conversation.` : reach.tier === 'notify' ? 'The new finding was shared in the current project conversation with a desktop notification.' : 'The new finding was shared in the current project conversation.';
    return { summary, reach: reach.tier, outcome: inline ? (reach.tier === 'notify' ? 'notified' : 'shared') : chat ? 'shared_quietly' : reach.tier === 'digest' ? 'digest' : 'filed', usage: { totalTokens: 0 } };
  }
  memoryTools(projectId) {
    const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    return [
      { ...MEMORY_TOOL_DECLARATIONS.search, execute: async (_id, args, signal) => result(await this.store.memoryService.search(projectId, { ...args, limit: 8, signal })) },
      { ...MEMORY_TOOL_DECLARATIONS.read, execute: async (_id, args, signal) => result(await this.store.memoryService.read(projectId, { ...args, maxChars: 4000, signal })) }
    ];
  }
  /** Declarations of this project's background-only host tools. */
  managementSurface(projectId) { return [...this.historyTools({ projectId }), ...this.presentTools({ projectId }, null), ...this.marketplaces.tools(projectId)].map(declarationOf); }
  /**
   * `project_present` (Harness `present` tool): the background agent declares
   * workspace files the user should open, each with a one-line description.
   * They become deliverable cards on the delivered message; the host never
   * parses file lists out of the text.
   */
  presentTools(context, action, bg = null) {
    return [{ name: 'project_present', effect: 'read', permission: 'read', idempotent: true,
      description: 'Declare project files the user should open as deliverables of this work (usually the one or two most important), each with a one-line description. Prefer putting the result itself in your final response when that is enough; do not list files there.',
      parameters: { type: 'object', required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', required: ['path', 'description'], properties: { path: { type: 'string', minLength: 1, maxLength: 400 }, description: { type: 'string', minLength: 1, maxLength: 300 } }, additionalProperties: false } } }, additionalProperties: false },
      execute: async (_callId, args, signal) => {
        signal?.throwIfAborted();
        if (!action || !this.valid(context)) throw error('Deliverables can only be declared by running background work', 'present_unavailable');
        // A run in its own worktree declares files there; applied, they are at the same paths in the project folder.
        const project = this.project(context.projectId), root = realpathSync(bg ? bg.root.root : projectWorkspace(project.workspace)), accepted = [], rejected = [];
        for (const row of args?.files ?? []) {
          try {
            const file = realpathSync(resolve(root, String(row.path).replace(/^\/+/, ''))), relativeFile = relativePath(root, file);
            if (!file.startsWith(root + sep) || relativeFile.split(sep).some(part => part.startsWith('.rna') || part === '.git') || !statSync(file).isFile()) throw new Error('outside');
            accepted.push({ path: relativeFile.split(sep).join('/'), name: relativeFile.split(sep).at(-1), description: oneLine(this.redact(row.description), 300) });
          } catch { rejected.push(String(row.path).slice(0, 200)); }
        }
        if (accepted.length) this.mutate(state => { const job = state.projects.find(row => row.id === context.projectId)?.jobs?.find(row => row.id === action.id); if (job) { const byPath = new Map([...(job.presented ?? []), ...accepted].map(row => [row.path, row])); job.presented = [...byPath.values()].slice(-8); } });
        return { content: [{ type: 'text', text: JSON.stringify({ declared: accepted.map(row => row.path), rejected, note: rejected.length ? 'Rejected paths are not existing files inside the project workspace.' : 'Shown to the user as deliverables with your final response.' }) }] };
      } }];
  }
  historyTools(context) {
    return [{ name: 'project_history', effect: 'read', permission: 'read', idempotent: true,
      description: 'Read retained conversation and action evidence for this project. With no IDs list recent turn/action IDs; sessionId+turnId lists message/tool item IDs; sessionId+itemId reads original text in character pages; actionId reads the action receipt and job output. Never executes or resumes old tools. Archived/deleted/revoked sources are unavailable.',
      parameters: { type: 'object', properties: { sessionId: { type: 'string', maxLength: 160 }, turnId: { type: 'string', maxLength: 160 }, itemId: { type: 'string', maxLength: 160 }, actionId: { type: 'string', maxLength: 160 }, offset: { type: 'integer', minimum: 0, maximum: 10000000 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, additionalProperties: false },
      execute: async (_callId, args, signal) => {
        signal?.throwIfAborted();
        if (!this.valid(context)) throw error('Project history scope has changed or is unavailable', 'history_unavailable');
        const project = this.project(context.projectId), sessions = this.store.state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
        const fail = () => { throw error('Only retained, non-revoked history in the current project can be read', 'history_unavailable'); };
        let value;
        if (args.actionId) {
          if (args.sessionId || args.turnId || args.itemId) fail();
          const action = project.initiativeRuntime?.sdkState?.actions?.find(action => action.id === args.actionId && !action.contextRevoked && !action.sourceDeleted);
          if (!action) fail();
          const job = project.jobs?.find(job => job.id === action.id && !job.contextRevoked && !job.sourceDeleted);
          value = { ...actionReceipts({ initiativeRuntime: { sdkState: { actions: [action] } }, jobs: job ? [job] : [] }, this.redactValues())[0], actionId: action.id, action: action.action, status: action.status, intent: action.content, result: action.resultSummary, output: job?.output, toolReceipts: job?.toolReceipts, toolReceiptCoverage: job?.toolReceiptCounts ? 'Up to twelve retained tool receipts, prioritizing early/recent failures and recent results, with bounded output excerpts; missing earlier receipts or final answers must not be guessed. No historical command is executed by this read.' : undefined };
        } else if (args.sessionId) {
          const session = sessions.find(session => session.id === args.sessionId); if (!session || args.turnId && args.itemId) fail();
          if (args.itemId) {
            const item = session.items.find(item => item.id === args.itemId && visibleItem(item) && (['user', 'assistant'].includes(item.kind) || item.tool)); if (!item) fail();
            value = { sessionId: session.id, itemId: item.id, turnId: item.turnId, role: item.kind, text: item.text, tool: item.tool ? { name: item.tool.name, status: item.tool.status, output: item.tool.output } : undefined };
          } else {
            const turn = session.turns.find(turn => turn.id === args.turnId); if (!turn) fail();
            value = { sessionId: session.id, turnId: turn.id, status: turn.status, items: session.items.filter(item => item.turnId === turn.id && visibleItem(item) && (['user', 'assistant'].includes(item.kind) || item.tool)).map(item => ({ itemId: item.id, role: item.kind, tool: item.tool?.name, status: item.tool?.status, preview: excerpt(item.tool?.output ?? item.text, 300) })) };
          }
        } else {
          if (args.turnId || args.itemId) fail();
          value = { sessions: sessions.slice(-32).map(session => ({ sessionId: session.id, title: session.title, turns: session.turns.slice(-12).map(turn => ({ turnId: turn.id, status: turn.status })), omittedTurns: Math.max(0, session.turns.length - 12) })), omittedSessions: Math.max(0, sessions.length - 32), actions: (project.initiativeRuntime?.sdkState?.actions ?? []).filter(action => !action.contextRevoked && !action.sourceDeleted).slice(-20).map(action => ({ actionId: action.id, action: action.action, status: action.status })), historyCoverage: 'Retained host history only; archived files are not read or restored. Known IDs can be read directly beyond this bounded index.' };
        }
        let content = JSON.stringify(value);
        for (const secret of this.redactValues()) content = content.split(secret).join('[REDACTED]');
        const offset = args.offset ?? 0, limit = args.limit ?? 8000;
        return { content: [{ type: 'text', text: JSON.stringify({ content: content.slice(offset, offset + limit), offset, totalChars: content.length, nextOffset: offset + limit < content.length ? offset + limit : null, referenceOnly: true }) }] };
      }
    }];
  }
  async assigned(project, { signal, root } = {}) {
    // Resolve the project's complete explicit grant before reducing it. A grant
    // may contain foreground mutations; it must not make background reads fail.
    const value = await this.capabilities.registry(project, this.memoryTools(project.id), { connectIds: project.assignments?.mcpServerIds ?? [], includeMutations: true, signal, ...(root ? { root, isolated: true } : {}) });
    try {
      signal?.throwIfAborted();
      if (value.failures.some(failure => project.assignments?.mcpServerIds?.includes(failure.id))) throw error('An assigned capability is unavailable', 'capability_unavailable');
      const selection = copy(project.assignments ?? { skillIds: [], toolIds: [], mcpServerIds: [] });
      selection.skillIds = selection.skillIds.filter(id => !/^gen-[a-f0-9]{16}-/.test(id));
      selection.toolIds = selection.toolIds.filter(id => !/^gen_[a-f0-9]{8}_/.test(id));
      const resolved = await value.registry.resolve(selection);
      const bundle = project.versions?.find(version => version.id === (project.trialVersionId ?? project.activeVersionId))?.bundle;
      if (bundle) resolved.tools.push(...createGenomeTools(bundle.genome, { namespace: genomeIdentity(project.id), workspace: root ?? projectWorkspace(project.workspace), signal, deniedPaths: privateStatePaths(this.store.file) }));
      signal?.throwIfAborted();
      return resolved;
    } finally { await value.registry.close(); }
  }
  startJob(context, action, kind) {
    if (!this.valid(context)) throw error('Project context changed', 'stale');
    // The tasks panel's run card (layout plan H2): the model it runs with (names only, never a key or endpoint), its step
    // cap (a scheduled run continues past it, a learning run has none) and the occurrence a scheduled run performs.
    const model = context.coordinator?.model, runModel = model?.providerId && model.modelId ? { providerId: model.providerId, modelId: model.modelId, name: model.name ?? model.modelId } : null;
    const run = { ...(runModel ? { model: runModel } : {}), stepLimit: kind === 'research' && !action.hostSchedule ? this.workMaxSteps : null, ...(action.hostSchedule ? { scheduleId: action.hostSchedule.scheduleId, occurrenceKey: action.hostSchedule.key } : {}) };
    this.mutate(state => {
      const project = state.projects.find(project => project.id === context.projectId);
      if (kind === 'evolution') project.evolution.lastAutonomousStartedAt = new Date(this.now()).toISOString();
      // The job is the user's record of the run: it keeps the decision's title (task page, revoked receipts), and the
      // privacy scope (folder) it ran under, so a later migration can tell drift from a folder change (workspaceEra).
      // A work run pins the project version it starts on (`projectVersionId`), as a foreground turn does: generated tools
      // keep their names across generations (EVO-3), so a resumed run must not silently execute a newer script.
      if (!project.jobs.some(job => job.id === action.id)) project.jobs.push({ id: action.id, projectId: project.id, kind, status: 'running', evidenceIds: copy(action.evidenceIds), instruction: action.content, ...(typeof action.title === 'string' && action.title ? { title: this.redact(action.title) } : {}), createdAt: new Date(this.now()).toISOString(), simulated: false, lane: 'background', decisionMode: 'rna-model', privacyScope: context.scope, ...(kind === 'research' ? { projectVersionId: project.trialVersionId ?? project.activeVersionId ?? null } : {}), ...run });
      else if (action.checkpoint) {
        const job = project.jobs.find(job => job.id === action.id);
        if (!job.contextRevoked && !job.sourceDeleted) {
          job.status = 'running'; job.resumedAt = new Date(this.now()).toISOString(); delete job.completedAt; Object.assign(job, run);
          // job.usage is this resumption's own; the part before the pause stays counted for the run's total.
          if (job.usage) { job.priorUsage = { totalTokens: (job.priorUsage?.totalTokens ?? 0) + (job.usage.totalTokens ?? 0), estimatedTokens: (job.priorUsage?.estimatedTokens ?? 0) + (job.usage.estimatedTokens ?? 0) }; delete job.usage; }
        }
      }
    });
  }
  finishJob(context, action, values) {
    this.mutate(state => { const project = state.projects.find(project => project.id === context.projectId), job = project?.jobs.find(job => job.id === action.id); if (job) { Object.assign(job, values, { completedAt: new Date(this.now()).toISOString() }); const terminal = project.jobs.filter(row => !row.simulated && row.lane === 'background' && !['running', 'queued', 'interrupted', 'needs_review'].includes(row.status)); const archived = terminal.slice(0, -128); if (archived.length) { this.store.archiveRecords(`initiative/${project.id}/jobs`, archived); const ids = new Set(archived.map(row => row.id)); project.jobs = project.jobs.filter(row => !ids.has(row.id)); } } });
  }
  recordToolReceipt(context, action, event) {
    if (!this.valid(context)) return;
    const secrets = this.redactValues();
    let output = textOf(event.result?.content);
    for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
    // target: what the step worked on (a path, command, query …), short and redacted; startedAt: when it started, if seen.
    const target = toolTarget(event.toolName, event.args, { redactValues: secrets, limit: STEP_TARGET_LIMIT }), startedAt = Number.isFinite(event.startedAt) ? new Date(event.startedAt).toISOString() : null;
    const receipt = { toolCallId: event.toolCallId, toolName: event.toolName, ...(target ? { target } : {}), ...(startedAt ? { startedAt } : {}), at: new Date(this.now()).toISOString(), status: event.uncertain ? 'uncertain' : event.isError ? 'failed' : 'completed', resultHash: hash(event.result), output: excerpt(output, 2000), truncated: output.length > 2000, recordedByHost: true };
    if (receipt.status !== 'completed') receipt.failureContext = summarizeLearningToolFailure({ args: event.args, result: event.result, output });
    this.mutate(state => {
      const job = state.projects.find(project => project.id === context.projectId)?.jobs.find(job => job.id === action.id);
      if (!job || job.contextRevoked || job.sourceDeleted || job.toolReceipts?.some(row => row.toolCallId === receipt.toolCallId)) return;
      // By kind for the run card (read, search, edit, write, command, web, other); kept apart from the counts the model
      // reads. A run paused before kinds were counted starts from its earlier steps (before this one is counted).
      job.toolKindCounts ??= jobStepKinds(job);
      job.toolReceiptCounts ??= { total: 0, completed: 0, failed: 0, uncertain: 0 };
      job.toolReceiptCounts.total++; job.toolReceiptCounts[receipt.status]++;
      job.toolKindCounts[stepKind(receipt.toolName)]++;
      // Original results remain in the SDK journal. This bounded projection
      // makes partial progress available without exposing arbitrary journals.
      job.toolReceipts = selectLearningToolReceipts([...(job.toolReceipts ?? []), receipt]);
    });
  }
  /** The run's tokens so far, after each settled model request (not only when it finishes): the run card shows them live. */
  recordJobUsage(context, action, usage) {
    if (!this.valid(context)) return;
    const value = { totalTokens: usage.totalTokens, estimatedTokens: usage.estimatedTokens }, current = this.project(context.projectId)?.jobs?.find(job => job.id === action.id);
    if (!current || current.status !== 'running' || current.contextRevoked || current.sourceDeleted || current.usage?.totalTokens === value.totalTokens && current.usage?.estimatedTokens === value.estimatedTokens) return;
    this.mutate(state => { const job = state.projects.find(project => project.id === context.projectId)?.jobs.find(job => job.id === action.id); if (job?.status === 'running') job.usage = value; });
  }
  /**
   * A background step started (layout plan H3): the live `work.step` event the tasks panel shows, display only and
   * never persisted. At most STEP_EVENTS_PER_SECOND per run within any second. Past that the latest step waits for the
   * window's first slot to free (trailing edge), replacing any step already waiting, so a burst still ends on the step
   * the run is on; a step published in the meantime supersedes the waiting one. `steps`: the run's window
   * ({ times, pending, timer }), ended by endSteps with the run (its last finished step then rides on the project summary).
   */
  publishStep(context, action, event, at, steps) {
    if (!this.valid(context)) return;
    const step = { type: 'work.step', projectId: context.projectId, actionId: action.id, toolCallId: event.toolCallId ?? null, name: event.toolName, kind: toolKind(event.toolName), target: toolTarget(event.toolName, event.args, { redactValues: this.redactValues(), limit: STEP_TARGET_LIMIT }), status: 'running', at: new Date(at).toISOString() };
    const send = (value, time) => { while (steps.times.length && time - steps.times[0] >= 1000) steps.times.shift(); steps.times.push(time); try { liveBus(this.store).publish(value); } catch {} };
    while (steps.times.length && at - steps.times[0] >= 1000) steps.times.shift();
    if (steps.times.length < STEP_EVENTS_PER_SECOND) { this.endSteps(steps); send(step, at); return; }
    steps.pending = step;
    if (steps.timer) return;
    steps.timer = setTimeout(() => {
      const pending = steps.pending; steps.timer = null; steps.pending = null;
      if (pending && this.valid(context)) send(pending, this.now());
    }, Math.max(0, steps.times[0] + 1000 - at));
    steps.timer.unref?.();
  }
  /** Drops a run's waiting live step (the run ended, or a newer step went out first). */
  endSteps(steps) { clearTimeout(steps.timer); steps.timer = null; steps.pending = null; }
  async reserveRequest(context, amount, { signal, reserveTokens }) {
    signal.throwIfAborted();
    const current = this.project(context.projectId);
    if (!current || !this.valid(context)) throw error('Project context changed before request admission', 'stale');
    // Earlier request receipts are already settled. Re-read current project
    // policy and atomically check the global allowance in save(), every time.
    const latestCap = remainingInitiativeTokenBudget(current);
    if (context.coordinator.policy.tokenBudget !== latestCap) await context.coordinator.updatePolicy({ tokenBudget: latestCap });
    await reserveTokens(amount);
  }
  async work(context, action, { signal, evidence, tokenBudget, reserveTokens, reportUsage, recorder, bg }) {
    // `bg`: the run's own worktree (design §8). Its tools, commands (sandboxed) and cwd are there, and a foreground
    // turn neither defers, interrupts nor narrows it; plan mode still makes background work read only.
    const isolated = Boolean(bg);
    if (action.hostSchedule) {
      if (!this.scheduleActionCurrent(context, action)) return { superseded: true, usage: { totalTokens: 0 } };
      if ((!isolated && this.foregroundBusy(context.projectId)) || this.planning(context.projectId)) return { deferred: true, reason: 'foreground_busy', retryAfterMs: 1000, usage: { totalTokens: 0 } };
    }
    this.startJob(context, action, 'research'); let handle, failed = false, requestEstimate = 0, requestInput = 0, requestStarted = false;
    const workAbort = new AbortController(); signal = AbortSignal.any([signal, workAbort.signal]);
    let finishRun;
    const run = { writable: permissionLevel(this.backgroundProject(this.project(context.projectId), { isolated }), 'background') !== 'read', isolated, abort: reason => workAbort.abort(reason), settled: new Promise(resolve => { finishRun = resolve; }), cleanupUncertain: false };
    (context.workRuns ??= new Map()).set(action.id, run);
    const usage = { totalTokens: 0, estimatedTokens: 0 };
    // Started tools: their arguments until each receipt, and when they started (the receipt's startedAt); the run's
    // live-step window (publishStep).
    const inflightToolArgs = new Map(), toolStarts = new Map(), steps = { times: [], pending: null, timer: null };
    let usageFlush = Promise.resolve();
    // PDL-3: a request that reported no usage is charged its estimated input plus what it streamed; the reservation
    // (input + the whole output allowance) only bounds admission.
    const settleUsage = receipt => {
      const unreported = receipt.usageReported === false, estimate = Math.min(requestEstimate, requestInput + Math.ceil(streamedBytes(receipt) / 3));
      usage.totalTokens += unreported ? estimate : totalTokens(receipt.usage); if (unreported) usage.estimatedTokens += estimate; requestEstimate = 0; requestInput = 0; requestStarted = false;
      if (reportUsage) { const receipt = copy(usage); usageFlush = usageFlush.then(() => reportUsage(receipt)); usageFlush.catch(() => {}); }
      try { this.recordJobUsage(context, action, usage); } catch {}
    };
    try {
      const project = copy(this.project(context.projectId));
      // The version this run started on (startJob); a run recorded before the pin keeps the selected one.
      const pinnedVersion = project.jobs?.find(job => job.id === action.id)?.projectVersionId;
      // GN-1: a run resumed after the user withdrew its version (rolled it back, or took it out of trial) does not go on
      // with that version's scripts and skills, and is not moved to the current version either (a different script under
      // the same name is what the pin prevents). It stops and says why, before anything of either version is loaded; what
      // it did before its pause stays.
      if (action.checkpoint && pinnedVersion != null && !pinnedVersionAllowed(project, pinnedVersion)) {
        const language = interfaceLanguageOf(this.store.state), handoff = HOST_HANDOFF.versionWithdrawn(oneLine(this.handoffTask(context, action), 160));
        const output = inLanguage(language, { zh: '这项后台工作开始时用的项目版本已被回退或退出试用，所以没有接着做，也没有换成当前版本接着做；之前做完的部分保留着。还需要的话，请按当前版本重新发起。', en: 'The project version this background work started on was rolled back or taken out of trial, so it did not continue, and it was not switched to the current version either; what it did before is kept. If it is still needed, start it again on the current version.' });
        this.finishJob(context, action, { status: 'superseded', output, handoff, errorCode: 'version_withdrawn', usage });
        return { superseded: true, reason: 'version_withdrawn', handoff, usage };
      }
      const workspace = isolated ? bg.root.root : projectWorkspace(project.workspace), assigned = await this.assigned(project, { signal, ...(isolated ? { root: workspace } : {}) });
      // TC-2: the worker reads a brief, not the decision snapshot. Its stable part follows the shared prefix (initialContextTail).
      const own = scheduledRunOwn(action), brief = this.workerBrief(project, { evidence, query: action.content ?? '', own, copy: isolated }), briefText = JSON.stringify(brief.stable), evidenceText = JSON.stringify({ project: brief.volatile, evidence });
      const briefStats = { stableChars: briefText.length, volatileChars: JSON.stringify(brief.volatile).length, evidenceChars: JSON.stringify(evidence ?? []).length };
      signal.throwIfAborted();
      const effectiveProject = this.backgroundProject(project, { isolated }), backgroundLevel = permissionLevel(effectiveProject, 'background');
      run.writable = backgroundLevel !== 'read';
      // The complete project assignment is declared, as in the foreground, so a decision-started run, a subagent and the
      // foreground share one provider prefix. The background grant is enforced by rna-runtime when a call executes
      // (explicit rejection receipt); a read-only background still cannot write or execute. The one exception is a
      // scheduled run: it declares only the tools it can execute (surface 'executable'; the 22 purpose-only stubs were
      // never called in 177 background runs and cost ~5.1K tokens per request, token-burn design 2026-10-05 §3 A1), so it
      // does not share the foreground's tools array; its system prompt is unchanged. A resumed run keeps the surface its
      // job stored. RNA_SCHEDULED_SURFACE=full switches new scheduled runs back.
      void assigned;
      const surface = runSurface({ scheduled: Boolean(action.hostSchedule), resumed: Boolean(action.checkpoint), saved: action.checkpoint ? project.jobs?.find(job => job.id === action.id)?.surface : undefined });
      const model = { ...context.coordinator.model };
      // Internal reasoning (spec p1 effort §3.4): the run's effort is chosen once, beside the setup below, and set on its
      // first request; the whole run then holds it (its compaction and step-limit summary too), so its cache identity
      // never changes mid-run. A resumed run keeps the one its job saved only while today's setting would still send it
      // (review EFF-5): after a rollback it continues at today's effort.
      const savedEffort = action.checkpoint ? project.jobs?.find(job => job.id === action.id)?.reasoning : null;
      const resumed = savedEffort ? resumedReasoning({ decisions: this.decisions, configuration: this.store.state.configuration, model, purpose: 'work', saved: savedEffort, projectSelection: project.initiative?.modelSelection ?? null }) : null;
      const effortPromise = resumed ? Promise.resolve(resumed)
        : this.internalReasoning(context, 'work', workEffortInput({ task: action.content, origin: 'background', scheduled: Boolean(action.hostSchedule), writable: run.writable, isolated, resumes: Boolean(action.checkpoint),
          earlierAttemptFailed: context.coordinator.state.actions.filter(row => row.action === 'work' && row.id !== action.id).slice(-6).some(row => ['failed', 'needs_review'].includes(row.status)), handoffAvailable: handoffLines(project).length > 0 }), { signal });
      let effortSet = false;
      const runEffort = async () => {
        const routed = await effortPromise;
        if (!resumed || routed.record?.replaced) try { this.mutate(state => { const job = state.projects.find(row => row.id === context.projectId)?.jobs.find(row => row.id === action.id); if (job && !job.contextRevoked && !job.sourceDeleted) job.reasoning = { effective: routed.reasoning, ...routed.record }; }); } catch { /* the job record is a courtesy */ }
        run.effort = { effective: routed.reasoning, ...routed.record };
        return routed.reasoning;
      };
      // In-turn judgments for background work too (plan §3.1): constraint gate, drift, dead ends.
      const watch = this.decisions ? new TurnWatcher({ decisions: this.decisions, getProject: () => this.project(context.projectId), workspace, request: action.content ?? '' }) : null;
      handle = await this.factory({ project, ...(pinnedVersion !== undefined ? { projectVersionId: pinnedVersion } : {}), initialContextTail: [{ key: 'project-brief', source: 'project-brief', text: briefText }], getProject: () => this.backgroundProject(this.project(context.projectId), { isolated }), permissionScope: 'background', ...(this.decisions ? { forgetStale: forgetHook({ decisions: this.decisions, getProject: () => this.project(context.projectId) }) } : {}), toolPolicy: this.toolPolicy, toolRun: { actionId: action.id, request: action.content ?? '' }, signal, readOnly: backgroundLevel === 'read', deniedPaths: privateStatePaths(this.store.file), capabilityService: this.capabilities, customTools: this.memoryTools(project.id), managementTools: [...documentTools({ workspace, deniedPaths: privateStatePaths(this.store.file) }), ...(this.mind?.planTools?.({ projectId: project.id, actionId: action.id }) ?? []), ...this.historyTools(context), ...this.presentTools(context, action, bg), ...this.marketplaces.tools(project.id)], surfaceTools: this.foregroundToolSurface?.(project.id) ?? [], ...(surface === 'executable' ? { surface } : {}), usageLedger: this.store.usageLedger, purpose: 'background-work', cwd: workspace,
        // In its own worktree: commands sandboxed with the project folder denied, AGENTS.md read from the project folder,
        // and the finish hook applying B to the project folder (design §4.3: up to LIMITS.applyContinuations continuations).
        ...(isolated ? { isolated: true, instructionsRoot: bg.root.project, hostFinish: input => this.finishGitRun(context, action, bg, input), maxFinishContinuations: LIMITS.backgroundFinishContinuations } : {}), stateDir: resolve(`${this.store.file}.rna`, 'initiative', project.id, action.id), sessionId: action.id, projectId: project.id, model, apiKey: context.coordinator.apiKey, redactValues: this.redactValues(), maxSteps: this.workMaxSteps, stepLimitBehavior: action.hostSchedule ? 'yield' : 'summarize',
        // T3: the planning state names the schedule this run performs and its occurrence's task, so the state need not repeat that text (only while it is still identical).
        ...(own ? { workingContextOptions: { omitScheduleTask: { scheduleId: own.scheduleId, task: own.occurrence.task } } } : {}),
        systemPrompt: workerSystemPrompt({ level: backgroundLevel, language: interfaceLanguageOf(this.store.state) }),
        beforeRequest: async () => {
          await this.flushActionControls(context, action.id); const notes = watch?.drain() ?? [], change = notes.length ? { contextUpdates: notes } : {};
          if (!effortSet) { effortSet = true; change.reasoning = await runEffort(); }
          return Object.keys(change).length ? change : undefined;
        },
        beforeCompletion: async ({ estimatedInputTokens, maxOutputTokens, signal }) => {
          await usageFlush;
          signal.throwIfAborted();
          requestEstimate = Math.ceil(estimatedInputTokens + maxOutputTokens + 1536); requestInput = Math.ceil(estimatedInputTokens);
          if (reserveTokens) {
            try { await this.reserveRequest(context, requestEstimate, { signal, reserveTokens }); } catch (failure) { requestEstimate = 0; throw failure; }
          } else if (usage.totalTokens + requestEstimate > (tokenBudget ?? Infinity)) { requestEstimate = 0; throw error('Background request exceeds its remaining token allowance', 'budget'); }
        },
        onEvent: event => {
          if (event.type === 'tool_execution_start') {
            const at = this.now(); inflightToolArgs.set(event.toolCallId, event.args); toolStarts.set(event.toolCallId, at);
            if (recorder && DIRECT_FIX_TOOLS.includes(event.toolName)) recorder.capture(event.args?.path); try { watch?.onStart(event); } catch {}
            this.publishStep(context, action, event, at, steps);
          }
          if (event.type === 'tool_execution_end') {
            try { watch?.onEnd(event); } catch {}
            this.recordToolReceipt(context, action, { ...event, args: inflightToolArgs.get(event.toolCallId), startedAt: toolStarts.get(event.toolCallId) });
            inflightToolArgs.delete(event.toolCallId); toolStarts.delete(event.toolCallId);
          }
          if (event.type === 'compaction_request_start' || event.type === 'message_start' && event.message?.role === 'assistant') requestStarted = true;
          if (event.type === 'compaction_request_end') settleUsage(event);
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            // Argument validation can finish a tool before tool_execution_start.
            // Keep only this settled request's arguments until each receipt.
            for (const block of event.message.content ?? []) if (block.type === 'toolCall') inflightToolArgs.set(block.id, block.arguments);
            settleUsage(event.message);
            // A response the SDK set aside and asked again (a truncated step-limit summary retried lighter) is not the run's end.
            if (!event.message.discarded && ['error', 'aborted', ...(action.hostSchedule ? ['length'] : [])].includes(event.message.stopReason)) failed = true;
          }
        }
      });
      context.activeHandles.add(handle);
      run.handle = handle;
      const abort = () => void handle.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        // MEM-12: the foreground's JEV memory.filter hook; a checkpoint resume sends no new prompt, so nothing is recalled
        // and the run keeps the memory record of its first pass.
        const memory = action.checkpoint ? { reference: null, projection: null } : await recallProjectMemory({ service: this.store.memoryService, projectId: project.id, prompt: action.content, snapshot: handle.snapshot(), model, policy: this.store.state.configuration.memory, signal, filter: memoryFilterHook({ decisions: this.decisions, projectId: project.id, turnId: action.id, prompt: action.content, signal }) });
        signal.throwIfAborted();
        if (!this.valid(context)) throw error('Project context changed during memory recall', 'stale');
        this.mutate(state => { const job = state.projects.find(row => row.id === project.id)?.jobs.find(row => row.id === action.id); if (job && !job.contextRevoked && !job.sourceDeleted) { if (memory.projection) job.memoryContext = copy(memory.projection); job.briefStats = briefStats; if (action.hostSchedule) job.surface = surface; } });
        const attachments = [{ source: 'project-evidence', text: evidenceText }];
        if (memory.reference) attachments.push({ source: 'project-memory', text: memory.reference });
        // K1: lessons, pending commitments and open agenda at the tail of the work request.
        const mindText = this.store.mind?.backgroundContext?.(project.id, { query: action.content }); if (mindText) attachments.push({ source: 'project-mind', text: mindText });
        if (action.checkpoint && (action.checkpoint.sessionId !== action.id || handle.snapshot().sessionId !== action.id || !handle.snapshot().messages.length)) throw error('Saved background session is unavailable; no replacement run was started', 'background_checkpoint_missing');
        run.started = true;
        const operation = action.checkpoint ? handle.resume() : handle.prompt(action.content, { context: attachments });
        operation.catch(() => {});
        await this.flushActionControls(context, action.id);
        await operation; await usageFlush;
        await this.flushActionControls(context, action.id);
        while (!run.stopCommand && (action.hostSchedule && handle.snapshot().continuation || handle.snapshot().queue?.steering.length)) {
          await new Promise(resolve => setImmediate(resolve));
          signal.throwIfAborted();
          const boundary = handle.snapshot();
          if (!this.valid(context) || action.hostSchedule && !this.scheduleActionCurrent(context, action)) throw error('Project context was revoked before continuation', 'stale');
          if (run.writable && ((!isolated && this.foregroundBusy(context.projectId)) || this.planning(context.projectId))) throw error('Foreground work superseded scheduled continuation', 'foreground_started');
          if (boundary.recovery?.uncertainTools?.length || boundary.recovery?.pendingTools) throw error('Scheduled continuation has unresolved tools', 'uncertain_tool');
          await handle.resume(); await usageFlush;
          await this.flushActionControls(context, action.id);
        }
      }
      finally { signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      const snapshot = handle.snapshot();
      run.finishing = true;
      if (!this.valid(context) || action.contextRevoked || action.sourceDeleted || action.hostSchedule && !this.scheduleActionCurrent(context, action)) { this.finishJob(context, action, { status: 'superseded', output: runOutcomeText({ language: interfaceLanguageOf(this.store.state) }).changed }); return { superseded: true, usage }; }
      if (failed) throw error('Background model request did not complete', 'background_failed');
      if (run.stopCommand) {
        if (snapshot.recovery?.uncertainTools?.length) throw error('Background tool outcome remains unconfirmed', 'uncertain_tool');
        const command = run.stopCommand, paused = command.kind === 'pause';
        if (!paused) handle.cancelUnstartedTools?.('The user stopped this background action before these tool calls were dispatched.');
        const outcome = runOutcomeText({ language: interfaceLanguageOf(this.store.state) }), summary = paused ? outcome.paused : outcome.stopped;
        const handoff = HOST_HANDOFF.control(oneLine(this.handoffTask(context, action), 160), paused);
        this.finishJob(context, action, { status: paused ? 'paused' : 'cancelled', output: summary, handoff, runtimeFile: snapshot.sessionFile, usage });
        return { control: { commandId: command.id, kind: command.kind, ...(paused ? { checkpoint: { sessionId: action.id } } : {}), summary }, handoff, usage };
      }
      const finalText = textOf(snapshot.messages.findLast(message => message.role === 'assistant')?.content), written = excerpt(finalText, 6000);
      if (!written.trim()) throw error('No background result was produced', 'empty_result');
      // Stopped on an unsent tool call: no report to show or build on. The changes and tool receipts stand;
      // the next review is told to check them instead of reading a half-finished step as the result.
      const unreported = unsentToolCall(finalText), reported = unreported ? null : extractHandoff(finalText);
      const language = interfaceLanguageOf(this.store.state), unreportedLines = unreported ? unreportedText({ task: oneLine(this.handoffTask(context, action), 160), language }) : null;
      const summary = unreportedLines ? unreportedLines.summary : written;
      const handoff = unreportedLines ? unreportedLines.handoff : reported ?? excerptHandoff(finalText, language);
      // F1: a scheduled run's final response is the user's message, whole. The summary (the action's resultSummary,
      // its action_completed observation) stays the bounded excerpt later decisions read; the job keeps the full text
      // until its occurrence settles (scheduledResult, dropDeliveredTexts).
      const deliveryText = action.hostSchedule && !unreported ? stripHandoff(finalText) : '';
      this.finishJob(context, action, { status: 'completed', output: summary, handoff, ...(deliveryText ? { deliveryText } : {}), ...(unreported ? { unreported: true } : {}), runtimeFile: snapshot.sessionFile, usage });
      this.labelEffort(run.effort, !unreported);
      return { summary, handoff, usage, reported, ...(unreported ? { unreported: true } : {}) };
    } catch (failure) {
      if (requestStarted && requestEstimate) settleUsage({ usageReported: false });
      await usageFlush.catch(() => {});
      // Abort can win the outer promise race after a tool has durably recorded
      // an unknown outcome. Keep that stronger evidence in the job/action receipt.
      if (handle?.snapshot().recovery?.uncertainTools?.length) failure = Object.assign(error('Background tool outcome remains unconfirmed', 'uncertain_tool'), { cause: failure });
      const diagnostic = initiativeFailure(failure, { phase: 'work', source: 'host_handler', now: this.now(), redactValues: this.redactValues() });
      const executionUnknown = ['uncertain_tool', 'process_cleanup_uncertain'].includes(failure.code) || failure.details?.cleanupUncertain === true || failure.details?.startUncertain === true;
      // W1: stopped by the action deadline. The signal's own reason says so, also when a tool call left unfinished made the
      // outcome unknown; the status and the error code stay as they were. The next decision reads this as the reason.
      const timedOut = signal.aborted && (signal.reason?.code === 'action_timeout' || diagnostic.code === 'action_timeout');
      const limit = timedOut ? deadlineText({ task: oneLine(this.handoffTask(context, action), 120), deadlineMs: context.coordinator.policy?.actionTimeoutMs ?? this.actionTimeoutMs, language: interfaceLanguageOf(this.store.state), code: diagnostic.code, toolUnfinished: executionUnknown }) : null;
      const failedTask = oneLine(this.handoffTask(context, action), 120), outcome = runOutcomeText({ language: interfaceLanguageOf(this.store.state), code: diagnostic.code, message: diagnostic.message });
      const handoff = oneLine(limit ? limit.handoff : executionUnknown ? HOST_HANDOFF.unconfirmed(diagnostic.code, failedTask) : signal.aborted ? HOST_HANDOFF.interrupted(failedTask) : HOST_HANDOFF.unfinished(diagnostic.code, failedTask, diagnostic.message));
      if (!signal.aborted) this.labelEffort(run.effort, false);
      this.finishJob(context, action, { status: executionUnknown ? 'needs_review' : signal.aborted ? 'cancelled' : 'failed', output: limit ? limit.output : executionUnknown ? outcome.unconfirmed : signal.aborted ? outcome.interrupted : outcome.unfinished, handoff, failure: diagnostic, errorCode: diagnostic.code, runtimeFile: handle?.snapshot().sessionFile, usage }); failure.usage = usage; failure.handoff = handoff; throw failure;
    } finally {
      inflightToolArgs.clear(); toolStarts.clear(); this.endSteps(steps);
      try { if (handle) { await handle.dispose(); context.activeHandles.delete(handle); } }
      catch (failure) {
        run.cleanupUncertain = true;
        const uncertain = Object.assign(error('Background runtime cleanup could not be confirmed', 'process_cleanup_uncertain'), { cause: failure, usage });
        const diagnostic = initiativeFailure(uncertain, { phase: 'work', source: 'host_handler', now: this.now(), redactValues: this.redactValues() });
        this.finishJob(context, action, { status: 'needs_review', errorCode: diagnostic.code, failure: diagnostic, usage });
        throw uncertain;
      } finally { if (!run.cleanupUncertain) context.workRuns.delete(action.id); finishRun(); }
    }
  }
  async learn(context, action, { signal, evidence, tokenBudget, reserveTokens, reportUsage }) {
    const current = this.project(context.projectId);
    if (this.independentLearning || !current?.evolution.enabled) return { deferred: true, reason: 'learning_paused', retryAfterMs: 60000, usage: { totalTokens: 0 } };
    // A model may still request another experiment after reading its own failed
    // experiment. Such a receipt is not new evidence authorizing paid learning.
    evidence = learningEvidence(evidence, context.coordinator.state.actions);
    const coverage = evidence.length ? getEvolutionEvidenceCoverage(current, getProjectEvolutionIdentity(current, { evidence, model: context.coordinator.model })) : null;
    if (!evidence.length || !coverage.hasNewEvidence) return { superseded: true, reason: 'learning_requires_new_evidence', usage: { totalTokens: 0 } };
    const nextAllowed = autonomousLearningNotBefore(current);
    if (this.now() < nextAllowed) return { deferred: true, reason: 'learning_interval', retryAfterMs: nextAllowed - this.now(), usage: { totalTokens: 0 } };
    this.startJob(context, action, 'evolution');
    let usage;
    try {
      this.evolutionService ??= new ProjectEvolutionService(this.store, { provider: this.evolutionProvider });
      const meteredUsage = { totalTokens: 0, estimatedTokens: 0 };
      const requestControl = reserveTokens && reportUsage ? {
        beforeRequest: ({ estimatedTokens }) => this.reserveRequest(context, estimatedTokens, { signal, reserveTokens }),
        onUsage: async ({ usage }) => { meteredUsage.totalTokens += totalTokens(usage); meteredUsage.estimatedTokens += Math.max(0, Number(usage?.estimatedTokens) || 0); try { this.recordJobUsage(context, action, meteredUsage); } catch {} await reportUsage(copy(meteredUsage)); }
      } : undefined;
      // This is a hypothesis handed to the author, never another observation or
      // part of the evidence identity. Legacy callers may not supply an intent.
      const content = typeof action.content === 'string' ? action.content.trim().slice(0, 2000) : '';
      const reason = typeof action.reason === 'string' ? action.reason.trim().slice(0, 600) : '';
      const eligibleIds = new Set(evidence.map(event => event.id));
      const evidenceIds = [...new Set((Array.isArray(action.evidenceIds) ? action.evidenceIds : []).filter(id => typeof id === 'string' && id.length <= 160 && eligibleIds.has(id)))].slice(0, 16);
      const learningIntent = content && reason && evidenceIds.length ? { content, reason, evidenceIds } : undefined;
      const result = await this.evolutionService.evolve(current.id, { evidence, learningIntent, model: context.coordinator.model, apiKey: context.coordinator.apiKey, signal, tokenBudget: requestControl ? null : tokenBudget ?? null, requestControl,
        commitGuard: () => this.valid(context) && action.revision === context.coordinator.state.revision && this.project(current.id)?.evolution.enabled,
        onProgress: progress => { if (this.valid(context)) this.mutate(state => { const job = state.projects.find(project => project.id === current.id)?.jobs.find(job => job.id === action.id); if (job) { job.phase = progress.type; if (progress.caseId) job.evaluationCaseId = progress.caseId; } }); }
      });
      usage = result.usage;
      signal.throwIfAborted();
      if (!this.valid(context) || action.revision !== context.coordinator.state.revision) { this.finishJob(context, action, { status: 'superseded', output: '项目上下文已变化，旧进化结果不用于主动发言。' }); return { superseded: true, usage: result.usage }; }
      this.finishJob(context, action, { status: result.status === 'ready' ? 'completed' : result.status === 'rejected' ? 'rejected' : 'failed', output: result.summary, versionId: result.version?.id, usage: result.usage });
      if (!['ready', 'rejected'].includes(result.status)) throw Object.assign(error(result.version?.error?.message || result.summary || 'Project evolution did not complete', result.version?.error?.code || 'evolution_failed'), { usage: result.usage });
      return { summary: result.summary, usage: result.usage, handoff: oneLine(`${result.status === 'ready' ? '学习候选通过冻结评测，可提供试用' : '学习候选未通过评测，未应用'}：${oneLine(result.summary, 260)}`) };
    } catch (failure) { if (usage && !failure.usage) failure.usage = usage; const diagnostic = initiativeFailure(failure, { phase: 'learn', source: 'host_handler', now: this.now(), redactValues: this.redactValues() }); this.finishJob(context, action, { status: signal.aborted ? 'cancelled' : 'failed', output: runOutcomeText({ language: interfaceLanguageOf(this.store.state), code: diagnostic.code, message: diagnostic.message }).learnUnfinished, failure: diagnostic, errorCode: diagnostic.code, usage: failure.usage }); throw failure; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); clearImmediate(this.scheduleHandle); this.scheduled = false; this.unsubscribe(); this.unwatchGit?.(); this.offProjectDeleting?.(); this.background?.stopping?.abort();
    for (const context of this.contexts.values()) { context.judgeAbort?.abort(); context.coordinator.interrupt('controller_closed'); }
    await this.pendingPump;
    await Promise.allSettled([...this.contexts.values()].map(context => context.coordinator.close()));
    // A timed-out handler may still own its journal after coordinator close.
    // Retain that identity so concurrent deletion cannot mistake it for drained.
    for (const [id, context] of this.contexts) if (!context.coordinator.unsettled.size && !context.activeHandles.size) this.contexts.delete(id);
  }
  health() {
    const projects = [...this.contexts.values()].map(context => ({ projectId: context.projectId, executionBlocked: context.coordinator._executionBlocked(), inFlight: Boolean(context.reviewPromise), activeActions: context.coordinator.active.size, unsettledOperations: context.coordinator.unsettled.size, retiring: Boolean(context.closing), lastSuccessAt: context.lastSuccessAt, lastErrorCode: context.lastErrorCode, lastFailure: context.coordinator.state.lastFailure ? { at: context.coordinator.state.lastFailure.at, phase: context.coordinator.state.lastFailure.phase, source: context.coordinator.state.lastFailure.source, code: context.coordinator.state.lastFailure.code, recoveredAt: context.coordinator.state.lastFailure.recoveredAt ?? null } : null, nextReviewAt: context.coordinator.state.nextReviewAt || null, failureRetryAt: context.coordinator.state.failureRetryAt || null, failureCount: context.coordinator.state.failureCount, lastObserverError: context.coordinator.state.lastObserverError ?? null, archiveRetryAt: context.coordinator.state.archiveRetryAt || null, pendingActions: context.coordinator.state.actions.filter(action => ['queued', 'running', 'needs_review'].includes(action.status)).length }));
    for (const project of this.store.state.projects.filter(realProject)) {
      const availability = projectInitiativeAvailability(this.store.state, project, { modelResolver: value => this.model(value) });
      const row = projects.find(row => row.projectId === project.id);
      if (row) { row.availability = availability; row.admissionBlocked = availability.state === 'blocked'; }
      // Admission/configuration waits are distinct from unknown external
      // execution. Do not convert an intentional wait into daemon unhealthiness
      // and trigger a supervisor restart that cannot repair the prerequisite.
      else if (availability.state === 'blocked') projects.push({ projectId: project.id, availability, admissionBlocked: true, executionBlocked: false, inFlight: false, activeActions: 0, unsettledOperations: 0, retiring: false, lastErrorCode: availability.reason });
    }
    return { closed: this.closed, pumping: this.pumping, lastPumpAt: this.lastPumpAt, lastPumpError: this.lastPumpError, retryPumpAt: this.retryPumpAt || null, concurrencyLimit: this.maxConcurrentReviews, projects };
  }
}
