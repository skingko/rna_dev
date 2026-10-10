import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, opendir, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { workspacePrivateSegment } from '../../packages/sdk/src/workspace-tools.mjs';
import { canonicalizeMissingPath } from '../../packages/sdk/src/workspace-paths.mjs';
import { validateUserQuestions, validateUserAnswers } from '../../packages/sdk/src/user-interaction.mjs';
import { projectWorkspace } from './capability-service.mjs';
import { summarizeLearningEvaluationExposure } from '../../packages/sdk/src/learning-context.mjs';

export const learningHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const excerpt = (value, limit) => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? null); return text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .6))}\n[… excerpt; middle omitted …]\n${text.slice(-Math.floor(limit * .35))}`; };
const visible = row => Boolean(row && !row.sourceDeleted && !row.contextRevoked && row.simulated !== true && !row.streaming && !row.interaction?.sourceDeleted && !row.interaction?.contextRevoked);
// A freshly created session may retain its legacy simulated container flag.
// Real host answer/command records carry their own explicit provenance.
const retainedContainer = row => Boolean(row && !row.sourceDeleted && !row.contextRevoked && !row.archivedAt);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identityPart = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value) ? value : learningHash(String(value)).slice(0, 40);
const feedbackId = (sessionId, itemId, content) => `episode:feedback:${identityPart(sessionId)}:${identityPart(itemId)}:${learningHash(content).slice(0, 16)}`;

const failedReceipt = row => ['failed', 'error', 'needs_review', 'uncertain'].includes((row.tool ?? row).status);
const sensitiveArgumentKey = key => /(?:secret|password|credential|authorization|api.?key|access.?token|refresh.?token|private.?key|^env$)/i.test(key);
/** A bounded chronological projection. Reserve space for early and recent
 * failures, then fill with recent results; recovery never erases its failure. */
export function selectLearningToolReceipts(rows, { limit = 12, failureLimit = 6 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(failureLimit) || failureLimit < 0 || failureLimit > limit) throw new TypeError('Invalid learning receipt limits');
  const seen = new Set(), unique = rows.filter(row => {
    const id = row.toolCallId ?? row.tool?.id ?? row.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  const failures = unique.filter(failedReceipt), early = Math.ceil(failureLimit / 2);
  const recent = failureLimit - early;
  const selected = new Set([...failures.slice(0, early), ...(recent ? failures.slice(-recent) : [])]);
  for (let index = unique.length - 1; index >= 0 && selected.size < limit; index--) selected.add(unique[index]);
  return unique.filter(row => selected.has(row));
}

/** Never copy a command, file content, credential, or complete args into the
 * cheap reflection. Only a schema error's exact field gets a type and safe
 * literal hint; arbitrary strings remain lengths. No guessed error paths. */
export function summarizeLearningToolFailure({ args, result, output = '' } = {}) {
  const message = typeof output === 'string' ? output.slice(0, 4096) : '';
  const match = /^Invalid tool arguments:\s*(\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d{1,6}\]){0,8}):/.exec(message);
  const code = typeof result?.details?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.details.code) ? result.details.code : undefined;
  if (!match || match[1].length > 240) return { schemaVersion: 1, kind: 'tool_execution', ...(code ? { code } : {}), argumentsRetained: false };
  const argumentPath = match[1], keys = [...argumentPath.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)].map(row => row[1] ?? row[2]);
  const sensitive = keys.some(sensitiveArgumentKey);
  let value = args, present = args !== undefined;
  for (const key of keys) {
    if (!present || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) { present = false; value = undefined; break; }
    value = value[key];
  }
  const type = !present ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const argument = { present, type, ...(sensitive ? { redacted: true } : typeof value === 'string' ? { length: value.length, ...(['null', 'true', 'false', 'undefined', ''].includes(value) ? { literal: value } : {}) } : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null ? { literal: value } : Array.isArray(value) ? { length: value.length } : {}) };
  return { schemaVersion: 1, kind: 'tool_argument_validation', code: 'invalid_tool_arguments', argumentPath, argument, argumentsRetained: false };
}

function retainedFailureContext(row) {
  const value = row.failureContext;
  if (value?.schemaVersion !== 1 || value.kind !== 'tool_argument_validation' || typeof value.argumentPath !== 'string' || value.argumentPath.length > 240 || !/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d{1,6}\]){0,8}$/.test(value.argumentPath)) return summarizeLearningToolFailure({ args: row.args, output: row.output });
  const argument = value.argument ?? {}, type = ['missing', 'null', 'array', 'object', 'string', 'number', 'boolean'].includes(argument.type) ? argument.type : 'missing';
  const literal = argument.literal;
  const sensitive = value.argumentPath.split(/[.\[\]]/).some(sensitiveArgumentKey);
  return { schemaVersion: 1, kind: 'tool_argument_validation', code: 'invalid_tool_arguments', argumentPath: value.argumentPath,
    argument: { present: argument.present === true, type, ...(sensitive || argument.redacted ? { redacted: true } : {
      ...(Number.isSafeInteger(argument.length) && argument.length >= 0 ? { length: argument.length } : {}),
      ...(literal === null || typeof literal === 'boolean' || typeof literal === 'number' && Number.isFinite(literal) || typeof literal === 'string' && ['null', 'true', 'false', 'undefined', ''].includes(literal) ? { literal } : {}) }) }, argumentsRetained: false };
}

/** Revalidation is audit context, never new experience, a reward or an oracle.
 * Only failure categories are visible; held-out tasks/terms/results stay out. */
export function projectLearningEvaluationAudit(project) {
  return (project.versions ?? []).filter(version => version.simulated === false && !version.sourceDeleted && !version.contextRevoked && (['failed', 'rejected', 'interrupted'].includes(version.state) || ['ready', 'active', 'trial', 'retired'].includes(version.state) && version.evaluation?.exposure)).slice(-3).map(version => {
    const evaluation = version.evaluation ?? {}, details = evaluation.details ?? version.evaluationEvidence?.cases ?? [];
    const exposure = summarizeLearningEvaluationExposure(evaluation.exposure ?? version.evaluationEvidence?.exposure);
    const knownChecks = new Set(['completed', 'requiredTerms', 'forbiddenTerms', 'requiredTools', 'toolErrors', 'noUncertainTools', 'artifacts']);
    const failedKinds = result => Object.entries(result?.checks ?? {}).filter(([kind, passed]) => knownChecks.has(kind) && passed === false).map(([kind]) => kind);
    const kinds = side => [...new Set(details.flatMap(row => failedKinds(row[side])))];
    const baseline = kinds('baseline'), candidate = kinds('candidate');
    const common = [...new Set(details.flatMap(row => failedKinds(row.candidate).filter(kind => failedKinds(row.baseline).includes(kind))))];
    return { versionId: version.id, state: version.state, stage: evaluation.stage ?? version.error?.diagnostic?.phase ?? null,
      failureCode: evaluation.earlyStopReason ?? version.error?.code ?? null,
      qualityScoringComplete: evaluation.evaluationComplete === true, scoredCases: evaluation.scoredCases ?? details.filter(row => Number.isFinite(row.baselineScore) && Number.isFinite(row.candidateScore)).length,
      baselineFailedChecks: baseline, candidateFailedChecks: candidate, commonFailedChecks: common, ...(exposure ? { exposure } : {}),
      isExternalEvidence: false, hiddenCaseContentIncluded: false, meaning: 'Execution/validation audit only. Common failures may indicate a shared tool or evaluation contract problem; they do not establish a candidate quality loss. Standards changes require separate reviewed paired evaluation.' };
  });
}

function sessionFeedback(session, project, scopeHash) {
  const records = [], coveredUserIds = new Set(), items = session.items ?? [], turns = new Map((session.turns ?? []).map(row => [row.id, row]));
  const add = (itemId, at, detail, content, userItemId) => {
    if (typeof itemId !== 'string' || !itemId || !validDate(at)) return;
    records.push({ id: feedbackId(session.id, itemId, content), kind: 'user_feedback', at, detail, sourceIds: [`session:${session.id}`, `scope:${scopeHash}`] });
    if (userItemId) coveredUserIds.add(userItemId);
  };
  const handledInteractions = new Set();
  for (const card of items) {
    const record = card.interaction;
    if (!visible(card) || card.simulated !== false || card.kind !== 'question' || card.source !== 'interaction' || !visible(record) || record.status !== 'answered'
      || !['question', 'permission'].includes(record.kind) || !['tool', 'initiative'].includes(record.source) || handledInteractions.has(record.id)
      || record.projectId && record.projectId !== project.id || card.projectId && card.projectId !== project.id) continue;
    const turn = turns.get(record.turnId);
    if (record.source === 'tool' && (!visible(turn) || turn.modelConfig?.execution !== 'rna')) continue;
    const linkedAnswers = items.filter(row => row.kind === 'user' && row.source === 'interaction-answer' && row.interactionId === record.id);
    const answerItem = linkedAnswers.find(row => visible(row) && row.simulated === false);
    // An explicitly revoked answer cannot be resurrected from its card copy.
    if (linkedAnswers.length && !answerItem) continue;
    let questions, answers;
    try { questions = validateUserQuestions({ questions: record.questions }); answers = validateUserAnswers(questions, record.answers); } catch { continue; }
    const detail = { sessionId: session.id, itemId: answerItem?.id ?? card.id, interactionId: record.id, turnId: record.turnId ?? null, source: 'answered_interaction',
      status: 'answered', permissionChangedByHost: record.permissionChanged === true,
      questions: questions.map(question => { const answer = answers.find(row => row.id === question.id); return { id: question.id, question: excerpt(question.question, 240), questionTruncated: question.question.length > 240,
        selected: answer.selected.map(id => ({ id, label: excerpt(question.options.find(option => option.id === id).label, 120) })),
        custom: excerpt(answer.custom ?? '', 1000), customTruncated: (answer.custom?.length ?? 0) > 1000 }; }),
      coverage: { structuredUserAnswer: true, excerptsOnly: true, provesTaskSuccess: false, freeTextDoesNotGrantPermission: true } };
    add(answerItem?.id ?? card.id, record.answeredAt, detail, [record.id, record.answeredAt, questions, answers], answerItem?.id);
    handledInteractions.add(record.id);
  }
  for (const item of items) {
    if (!visible(item) || item.simulated !== false || item.kind !== 'user' || item.source === 'interaction-answer' || item.delivery !== 'steer' || typeof item.text !== 'string' || !item.text.trim()) continue;
    const turn = turns.get(item.turnId);
    // Only the SDK claim path inserts a steer item and records this identity.
    // Initial prompts, accepted-but-unclaimed inbox entries and synthetic text
    // do not become a separate cheap learning trigger.
    if (!visible(turn) || turn.modelConfig?.execution !== 'rna' || item.id === turn.userItemId || !(turn.steering ?? []).includes(item.id)) continue;
    add(item.id, item.createdAt, { sessionId: session.id, turnId: turn.id, itemId: item.id, source: 'consumed_adjustment', text: excerpt(item.text, 4200),
      textTruncated: item.text.length > 4200, coverage: { sdkClaimRecorded: true, isUserGuidance: true, provesDefect: false, provesTaskSuccess: false } }, [item.submissionId ?? item.id, item.text], item.id);
  }
  for (const command of session.commandHistory ?? []) {
    if (!visible(command) || command.command !== 'feedback' || command.status !== 'completed') continue;
    const notice = items.find(row => row.id === command.result?.noticeId), observation = (project.observations ?? []).find(row => row.id === command.result?.observationId);
    if (!visible(notice) || notice.simulated !== false || notice.kind !== 'notice' || notice.source !== 'session-command' || !visible(observation) || observation.simulated !== false
      || observation.source !== 'user-command' || observation.data?.command !== 'feedback' || observation.data.sessionId !== session.id || observation.data.messageId !== notice.id || typeof observation.text !== 'string' || !observation.text.trim()) continue;
    const target = observation.data.itemId ? items.find(row => row.id === observation.data.itemId) : null;
    if (observation.data.itemId && !visible(target)) continue;
    add(notice.id, command.completedAt, { sessionId: session.id, itemId: notice.id, source: 'completed_feedback_command', observationId: observation.id,
      targetItemId: observation.data.itemId ?? null, rating: ['positive', 'negative', 'neutral'].includes(observation.data.rating) ? observation.data.rating : 'neutral',
      text: excerpt(observation.text, 4200), textTruncated: observation.text.length > 4200, coverage: { explicitUserFeedback: true, commandCompleted: true, independentlyVerified: false } }, [command.requestId, observation.id, observation.text, observation.data.rating]);
  }
  return { records, coveredUserIds };
}
export function learningRedactor(store) {
  const configuration = store.state.configuration ?? {}, capabilities = store.state.capabilities ?? {};
  const environments = [...(configuration.providers ?? []).map(row => row.apiKeyEnv), configuration.memory?.apiKeyEnv, ...[...(capabilities.tools ?? []), ...(capabilities.mcpServers ?? [])].flatMap(row => [...(row.envNames ?? []), ...Object.values(row.envMapping ?? {}), ...Object.values(row.headerEnv ?? {})])];
  const values = [...Object.values(store.configurationService?.secrets ?? {}), ...(store.configurationService?.secretValues?.() ?? []), ...environments.filter(Boolean).map(name => process.env[name])].filter(value => typeof value === 'string' && value);
  return value => { let text = String(value ?? ''); for (const secret of values.sort((a, b) => b.length - a.length)) for (const form of [secret, encodeURIComponent(secret)]) text = text.split(form).join('[REDACTED]'); return text; };
}

/** Only actual external experience enters this backlog. Learning's own decisions,
 * candidate failures and timer ticks cannot generate new learning evidence. */
export function projectLearningEpisodes(state, project, scopeHash, { redact = value => value, since, bootstrapLimit = 12 } = {}) {
  const sessions = state.sessions.filter(row => row.projectId === project.id && retainedContainer(row) && row.kind !== 'side');
  const records = [], sourceSessions = new Map();
  for (const session of sessions) {
    for (const item of session.items ?? []) { sourceSessions.set(`message:${item.id}`, session.id); if (item.turnId) sourceSessions.set(`turn:${item.turnId}`, session.id); }
    const byTurn = new Map();
    const feedback = sessionFeedback(session, project, scopeHash); records.push(...feedback.records);
    const revokedCalls = new Set((session.items ?? []).filter(row => row.interaction?.toolCallId && !visible(row)).map(row => row.interaction.toolCallId));
    for (const item of session.items ?? []) if (item.turnId && visible(item) && !revokedCalls.has(item.tool?.id)) { const rows = byTurn.get(item.turnId) ?? []; rows.push(item); byTurn.set(item.turnId, rows); }
    for (const turn of session.turns ?? []) {
      if (!visible(turn) || !['completed', 'failed'].includes(turn.status) || turn.modelConfig?.execution !== 'rna') continue;
      const at = turn.completedAt ?? turn.createdAt; if (!Number.isFinite(Date.parse(at))) continue;
      const items = byTurn.get(turn.id) ?? [], requests = items.filter(row => row.kind === 'user' && row.source !== 'interaction-answer' && !feedback.coveredUserIds.has(row.id)), tools = items.filter(row => row.tool), final = items.findLast(row => row.kind === 'assistant');
      const chosen = selectLearningToolReceipts(tools, { limit: 5, failureLimit: 3 });
      const detail = { sessionId: session.id, turnId: turn.id, status: turn.status, errorCode: turn.errorCode,
        requests: [...new Set([...requests.slice(0, 1), ...requests.slice(-2)])].map(row => ({ id: row.id, text: excerpt(row.text, 600) })),
        final: final ? { text: excerpt(final.text, 900), verifiedByHost: false } : null,
        tools: chosen.map(row => ({ id: row.id, toolCallId: row.tool.id, name: row.tool.name, status: row.tool.status, output: excerpt(row.tool.output, 250), ...(failedReceipt(row) ? { failureContext: summarizeLearningToolFailure({ args: row.tool.args, output: row.tool.output }) } : {}) })),
        coverage: { retainedToolResults: tools.length, selectedToolResults: chosen.length, retainedFailedToolResults: tools.filter(failedReceipt).length, selectedFailedToolResults: chosen.filter(failedReceipt).length, failurePriority: true, separatelyRecordedUserFeedback: items.filter(row => feedback.coveredUserIds.has(row.id)).length, outputsAreExcerpts: true, finalNarrationIsNotVerification: true } };
      const occurrence = learningHash([at, turn.runtimeAttempts ?? 0]).slice(0, 16);
      records.push({ id: `episode:turn:${session.id}:${turn.id}:${occurrence}`, kind: 'conversation_result', at, detail, sourceIds: [`session:${session.id}`, `scope:${scopeHash}`] });
    }
  }
  for (const action of project.initiativeRuntime?.sdkState?.actions ?? []) {
    if (!visible(action) || action.action !== 'work' || !['completed', 'failed'].includes(action.status)) continue;
    const job = project.jobs?.find(row => row.id === action.id && visible(row) && row.simulated === false);
    const receipts = job?.toolReceipts?.filter(visible); if (!receipts?.length) continue;
    const timestamp = new Date(action.finishedAt ?? job.completedAt ?? 0).getTime(); if (!Number.isFinite(timestamp) || timestamp <= 0) continue; const at = new Date(timestamp).toISOString();
    const associated = new Set((action.evidenceIds ?? []).map(id => sourceSessions.get(id) ?? sourceSessions.get(id.split(':').slice(0, 2).join(':'))).filter(Boolean));
    // If attribution has been pruned, scope the retained worker excerpt to all
    // current sessions; deleting any source must revoke the mixed snapshot.
    if (!associated.size) for (const session of sessions) associated.add(session.id);
    const chosen = selectLearningToolReceipts(receipts, { limit: 4, failureLimit: 2 });
    records.push({ id: `episode:work:${action.id}`, kind: 'work_result', at,
      detail: { actionId: action.id, status: action.status, intent: excerpt(action.content, 900), result: excerpt(action.resultSummary, 1300), resultVerifiedByHost: false,
        tools: chosen.map(row => ({ toolCallId: row.toolCallId, name: row.name ?? row.toolName, status: row.status, output: excerpt(row.output, 350), ...(failedReceipt(row) ? { failureContext: retainedFailureContext(row) } : {}) })),
        coverage: { ...job.toolReceiptCounts, retainedToolResults: receipts.length, selectedToolResults: chosen.length, retainedFailedToolResults: receipts.filter(failedReceipt).length, selectedFailedToolResults: chosen.filter(failedReceipt).length, failurePriority: true, outputsAreExcerpts: true } },
      sourceIds: [...associated].map(id => `session:${id}`).concat(`scope:${scopeHash}`) });
  }
  records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const selected = since == null ? records.slice(-bootstrapLimit) : records.filter(row => Date.parse(row.at) >= since);
  return { episodes: selected.map(({ detail, ...row }) => { const summary = excerpt(redact(JSON.stringify(detail)), 5800); return { ...row, summary, fingerprint: learningHash([scopeHash, row.id, summary]) }; }),
    coverage: { availableRecords: records.length, selectedRecords: selected.length, olderRecordsOmitted: records.length - selected.length, bootstrap: since == null } };
}

/** A cheap host-only outcome lookup for decision routing. Episode summaries and
 * caller-provided outcome fields are not authority. Bind the exact retained
 * execution occurrence, source session and timestamp before reading its result.
 * This deliberately accepts learning episode IDs only, not initiative events. */
export function learningEpisodeOutcome(state, project, episode) {
  if (!visible(episode) || episode.sourceRevoked) return;
  const current = state?.projects?.find(row => row.id === project?.id && retainedContainer(row));
  if (!current || !Array.isArray(episode.sourceIds)) return;
  if (current.learningRuntime?.scopeHash && !episode.sourceIds.includes(`scope:${current.learningRuntime.scopeHash}`)) return;
  const sessions = (state.sessions ?? []).filter(row => row.projectId === current.id && retainedContainer(row) && episode.sourceIds.includes(`session:${row.id}`));
  const outcome = row => ({ status: row.status, ...(typeof row.errorCode === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.errorCode) ? { errorCode: row.errorCode } : {}) });
  if (episode.kind === 'conversation_result') {
    for (const session of sessions) for (const turn of session.turns ?? []) {
      if (!visible(turn) || turn.modelConfig?.execution !== 'rna' || !['completed', 'failed'].includes(turn.status)) continue;
      const at = turn.completedAt ?? turn.createdAt;
      if (!validDate(at) || episode.at !== at || episode.id !== `episode:turn:${session.id}:${turn.id}:${learningHash([at, turn.runtimeAttempts ?? 0]).slice(0, 16)}`) continue;
      return outcome(turn);
    }
  } else if (episode.kind === 'work_result' && sessions.length) {
    const action = current.initiativeRuntime?.sdkState?.actions?.find(row => visible(row) && row.action === 'work' && ['completed', 'failed'].includes(row.status) && episode.id === `episode:work:${row.id}`);
    const job = action && current.jobs?.find(row => row.id === action.id && visible(row) && row.simulated === false);
    if (!job || !(job.toolReceipts ?? []).some(visible)) return;
    const at = new Date(action.finishedAt ?? job.completedAt ?? 0).getTime();
    if (!Number.isFinite(at) || at <= 0 || episode.at !== new Date(at).toISOString()) return;
    return outcome(action);
  }
}

const dependencyOrBuildSegment = value => /^(?:node_modules|bower_components|\.venv|venv|env|site-packages|__pycache__|\.tox|\.nox|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|\.next|\.nuxt|\.svelte-kit|\.turbo|\.parcel-cache|\.gradle|coverage|dist|build|target)$/iu.test(value);
const safePath = value => typeof value === 'string' && value.length <= 300 && !/[\x00-\x1f\x7f]/u.test(value) && !value.split(/[\\/]/).some(part => !part || part === '..' || part === '.' || workspacePrivateSegment(part) || dependencyOrBuildSegment(part) || /^(?:.*\.rna|.*\.evolution|.*\.genomes|frozen-evaluation\.json|learning-context\.json)$/iu.test(part)) && !isAbsolute(value);
const within = (base, path) => { const part = relative(base, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };

/** Resolve only the retained, same-project source behind the exact episode
 * identity. This is not an arbitrary state/journal reader. */
function retainedSource(state, project, episode) {
  const current = state?.projects?.find(row => row.id === project.id && retainedContainer(row));
  if (!current) return { status: 'source_unavailable', records: [], availableRecords: 0 };
  const sessions = (state.sessions ?? []).filter(row => row.projectId === project.id && retainedContainer(row) && episode.sourceIds?.includes(`session:${row.id}`));
  const scope = (episode.sourceIds ?? []).find(id => id.startsWith('scope:'))?.slice(6) ?? '';
  for (const session of sessions) {
    if (episode.kind === 'conversation_result') {
      for (const turn of session.turns ?? []) {
        if (!visible(turn) || turn.modelConfig?.execution !== 'rna' || !['completed', 'failed'].includes(turn.status)) continue;
        const at = turn.completedAt ?? turn.createdAt;
        if (episode.id !== `episode:turn:${session.id}:${turn.id}:${learningHash([at, turn.runtimeAttempts ?? 0]).slice(0, 16)}`) continue;
        const revokedCalls = new Set((session.items ?? []).filter(row => row.interaction?.toolCallId && !visible(row)).map(row => row.interaction.toolCallId));
        const records = (session.items ?? []).filter(row => row.turnId === turn.id && visible(row) && !revokedCalls.has(row.tool?.id) && (row.kind === 'user' || row.kind === 'assistant' || row.tool));
        return { status: 'retained_source', sessionId: session.id, turnId: turn.id, availableRecords: records.length,
          records: records.map(row => row.tool ? { kind: 'tool_receipt', itemId: row.id, toolCallId: row.tool.id, name: row.tool.name, status: row.tool.status, args: row.tool.args, output: row.tool.output, recordedResultIsNotWholeTaskVerification: true }
            : { kind: row.kind === 'user' ? 'user_request' : 'assistant_narration', itemId: row.id, text: row.text, ...(row.kind === 'assistant' ? { independentlyVerified: false } : {}) }) };
      }
    } else if (episode.kind === 'user_feedback') {
      const feedback = sessionFeedback(session, current, scope).records.find(row => row.id === episode.id);
      if (!feedback) continue;
      const detail = feedback.detail;
      if (detail.source === 'answered_interaction') {
        const record = session.items.find(row => row.interaction?.id === detail.interactionId && visible(row))?.interaction;
        return { status: 'retained_source', sessionId: session.id, availableRecords: 1, records: [{ kind: 'structured_user_answer', interactionId: record.id, questions: record.questions, answers: record.answers, answeredAt: record.answeredAt, permissionChangedByHost: record.permissionChanged === true }] };
      }
      if (detail.source === 'consumed_adjustment') return { status: 'retained_source', sessionId: session.id, availableRecords: 1, records: [{ kind: 'consumed_adjustment', itemId: detail.itemId, text: session.items.find(row => row.id === detail.itemId).text, turnId: detail.turnId }] };
      const observation = current.observations.find(row => row.id === detail.observationId);
      return { status: 'retained_source', sessionId: session.id, availableRecords: 1, records: [{ kind: 'explicit_user_feedback', itemId: detail.itemId, text: observation.text, rating: observation.data.rating, targetItemId: observation.data.itemId }] };
    }
  }
  if (episode.kind === 'work_result') {
    const action = current.initiativeRuntime?.sdkState?.actions?.find(row => episode.id === `episode:work:${row.id}` && visible(row) && row.action === 'work' && ['completed', 'failed'].includes(row.status));
    const job = action && current.jobs?.find(row => row.id === action.id && visible(row) && row.simulated === false);
    if (job && sessions.length) {
      const receipts = (job.toolReceipts ?? []).filter(visible);
      return { status: 'retained_source', actionId: action.id, availableRecords: receipts.length + 1, hostReceiptCoverage: job.toolReceiptCounts,
        records: [{ kind: 'background_work_narration', intent: action.content, result: action.resultSummary, independentlyVerified: false },
          ...receipts.map(row => ({ kind: 'tool_receipt', toolCallId: row.toolCallId, name: row.name ?? row.toolName, status: row.status, args: row.args, ...(failedReceipt(row) ? { failureContext: retainedFailureContext(row) } : {}), output: row.output, hostAlreadyTruncated: row.truncated === true, recordedResultIsNotWholeTaskVerification: true }))] };
    }
  }
  return { status: 'source_unavailable', availableRecords: 0, records: [] };
}

function prefixBytes(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text;
  // A truncated UTF-8 sequence is omitted, never turned into corrupt source.
  return Buffer.from(text).subarray(0, Math.max(0, limit)).toString('utf8').replace(/\uFFFD$/u, '');
}
const sourceJson = (value, redact) => JSON.stringify(value, (key, value) => /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|private[-_]?key|credentials|env)$/i.test(key) ? '[REDACTED]' : typeof value === 'string' ? redact(value) : value);

/** Freeze synchronously before any file-system await: later Store mutations
 * cannot change a paid experiment's evidence. Source is bounded JSON records
 * inside a valid JSON envelope; a truncated record is explicitly a fragment. */
export function projectLearningSourceRecords(state, project, episodes, { redact = value => value, maxBytes = 512000 } = {}) {
  const evidence = []; let bytes = 0, truncatedRecords = 0, omittedRecords = 0;
  for (let index = 0; index < episodes.length; index++) {
    const episode = episodes[index], source = retainedSource(state, project, episode);
    const selected = source.records.length > 24 ? [...new Set([source.records[0], ...selectLearningToolReceipts(source.records, { limit: 23, failureLimit: 8 })])] : source.records;
    const limit = Math.min(128000, Math.floor((maxBytes - bytes) / (episodes.length - index)));
    const document = { episode: { id: episode.id, fingerprint: episode.fingerprint, kind: episode.kind, at: episode.at, sourceIds: [...(episode.sourceIds ?? [])] }, source: { ...source, records: undefined }, records: [],
      coverage: { retainedStateOnly: true, privateJournalRead: false, heldOutEvaluationRead: false, assistantNarrationIsNotVerification: true, availableRecords: source.availableRecords, selectedRecords: 0, omittedRecords: source.records.length - selected.length, truncatedRecords: 0, sourceUnavailable: source.status !== 'retained_source' } };
    let content = sourceJson(document, redact);
    if (Buffer.byteLength(content) > limit) {
      document.episode.summary = ''; document.coverage.summaryOmitted = true;
      content = sourceJson(document, redact);
    }
    for (let offset = 0; offset < selected.length; offset++) {
      const original = sourceJson(selected[offset], redact), originalBytes = Buffer.byteLength(original);
      let allowed = Math.max(0, Math.floor((limit - Buffer.byteLength(content) - 512) / (selected.length - offset)));
      const record = { kind: selected[offset].kind, itemId: selected[offset].itemId, toolCallId: selected[offset].toolCallId, encoding: 'json_record', originalBytes, content: prefixBytes(original, allowed), truncated: originalBytes > allowed };
      // Nested JSON escaping can expand more than the source bytes. Check the
      // exact envelope size, retaining a useful prefix without invalid JSON.
      while (allowed > 0 && Buffer.byteLength(JSON.stringify({ ...document, records: [...document.records, record] })) > limit - 256) {
        allowed = Math.floor(allowed * .8); record.content = prefixBytes(original, allowed); record.truncated = originalBytes > allowed;
      }
      if (!allowed) { document.coverage.omittedRecords += selected.length - offset; break; }
      document.records.push(record); document.coverage.selectedRecords++;
      if (record.truncated) document.coverage.truncatedRecords++;
      content = JSON.stringify(document);
    }
    content = JSON.stringify(document);
    // An abnormally small caller budget still produces no over-budget record.
    if (Buffer.byteLength(content) > limit) { omittedRecords += source.availableRecords; continue; }
    evidence.push({ id: episode.id, content }); bytes += Buffer.byteLength(content);
    truncatedRecords += document.coverage.truncatedRecords; omittedRecords += document.coverage.omittedRecords;
  }
  return { evidence, coverage: { bytes, selectedEpisodes: evidence.length, omittedEpisodes: episodes.length - evidence.length, truncatedRecords, omittedRecords, perEvidenceMaxBytes: 128000, retainedStateOnly: true } };
}
/** A bounded source snapshot, never a live tool grant. Every selected file is
 * opened without symlink following and checked for modification during read. */
export async function freezeProjectLearningFiles(project, episodes, { signal, redact = value => value, maxFiles = 24, maxBytes = 384000, deniedPaths = [], sourceState } = {}) {
  signal?.throwIfAborted();
  const source = projectLearningSourceRecords(sourceState, project, episodes, { redact });
  maxBytes = Math.min(384000, Math.max(0, maxBytes));
  const root = await realpath(projectWorkspace(project.workspace)), candidates = [], skipped = [];
  const denied = [...new Set(await Promise.all(deniedPaths.map(path => canonicalizeMissingPath(path))))];
  const rootDenied = denied.some(path => within(path, root)), scopedDenied = denied.filter(path => within(root, path));
  const disallowed = path => scopedDenied.some(denied => within(denied, path));
  const deniedFiles = new Set();
  for (const path of denied) try { const info = await lstat(path); if (info.isFile()) deniedFiles.add(`${info.dev}:${info.ino}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let scannedEntries = 0, scannedDirectories = 0, traversalTruncated = false;
  const walk = async (directory, depth = 0) => {
    if (scannedEntries >= 4096 || scannedDirectories >= 128 || candidates.length >= 160) { traversalTruncated = true; return; }
    const fullDirectory = resolve(root, directory);
    if (disallowed(fullDirectory) || await realpath(fullDirectory) !== fullDirectory) return;
    scannedDirectories++;
    const entries = [], handle = await opendir(fullDirectory);
    for await (const entry of handle) { if (scannedEntries++ >= 4096) { traversalTruncated = true; break; } entries.push(entry); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted(); const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!safePath(path) || entry.isSymbolicLink() || disallowed(resolve(root, path))) continue;
      if (entry.isDirectory() && depth < 2 && candidates.length < 160) await walk(path, depth + 1);
      else if (entry.isFile() && /\.(?:md|json|html|css|[cm]?[jt]sx?|py|rs|go|toml|yaml|yml)$/i.test(entry.name) && !/(?:lock\.(?:json|yaml)|\.min\.[jc]s|bundle\.[jc]s)$/i.test(entry.name) && candidates.length < 160) candidates.push(path);
    }
  };
  if (!rootDenied) await walk('');
  const priority = path => /(?:^|\/)(?:README\.md|AGENTS\.md|package\.json|index\.html|main\.[jt]s|App\.[jt]sx|design\.md)$/i.test(path) ? 0 : 1;
  candidates.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const files = []; let bytes = 0;
  for (const path of candidates) {
    signal?.throwIfAborted(); if (files.length >= maxFiles) break;
    let handle;
    try {
      const full = resolve(root, path), canonical = await realpath(full);
      if (canonical !== full || !within(root, canonical)) { skipped.push({ path, reason: 'symlink' }); continue; }
      if (disallowed(canonical)) { skipped.push({ path, reason: 'host_denied' }); continue; }
      const expected = await lstat(full); if (!expected.isFile()) { skipped.push({ path, reason: 'changed_during_read' }); continue; }
      handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (before.dev !== expected.dev || before.ino !== expected.ino) { skipped.push({ path, reason: 'changed_during_read' }); continue; }
      if (deniedFiles.has(`${before.dev}:${before.ino}`)) { skipped.push({ path, reason: 'host_denied_identity' }); continue; }
      if (!before.isFile() || before.size > 128000 || bytes + before.size > maxBytes) { skipped.push({ path, reason: 'size_limit' }); continue; }
      // Bound the allocation even if another process appends while reading.
      const buffer = Buffer.alloc(before.size + 1); const read = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
      const current = await lstat(full);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || read.bytesRead !== before.size || current.dev !== before.dev || current.ino !== before.ino || await realpath(full) !== canonical) { skipped.push({ path, reason: 'changed_during_read' }); continue; }
      const content = buffer.subarray(0, before.size).toString('utf8');
      if (content.includes('\0') || content.includes('\uFFFD')) { skipped.push({ path, reason: 'non_text' }); continue; }
      const redacted = redact(content); if (Buffer.byteLength(redacted) > 128000 || bytes + Buffer.byteLength(redacted) > maxBytes) { skipped.push({ path, reason: 'size_limit' }); continue; }
      files.push({ path, content: redacted }); bytes += Buffer.byteLength(redacted);
    } catch (error) { if (signal?.aborted) throw signal.reason; skipped.push({ path, reason: ['ENOENT', 'EACCES', 'ELOOP'].includes(error.code) ? error.code : 'unavailable' }); }
    finally { await handle?.close(); }
  }
  const coverage = { selectedFiles: files.length, discoveredFiles: candidates.length, bytes, skipped, boundedDepth: 3, scannedEntries, scannedDirectories, traversalTruncated, rootDenied, perFileStableRead: true, atomicWorkspaceSnapshot: false, excludesPrivateFiles: true, excludesDependenciesAndBuildOutputs: true, evidence: source.coverage, totalContentBytes: bytes + source.coverage.bytes };
  return { context: { schemaVersion: 1, evidence: source.evidence, files }, coverage };
}
