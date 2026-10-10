/** Frozen environmental facts and bounded diagnostic projections. Neither
 * function changes a check, supplies an expected answer or grants a tool. */
export const projectEvaluationClockSchema = {
  type: 'object', additionalProperties: false, required: ['now', 'timeZone'], properties: {
    now: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$', maxLength: 24 },
    timeZone: { type: 'string', minLength: 1, maxLength: 100 },
  },
};
export function validateProjectEvaluationClock(value) {
  if (value === undefined) return undefined;
  const bad = () => { throw Object.assign(new Error('Evaluation clock requires an exact UTC instant and an explicit valid time zone'), { code: 'invalid_evaluation_clock' }); };
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'now,timeZone' || typeof value.now !== 'string' || !new RegExp(projectEvaluationClockSchema.properties.now.pattern).test(value.now) || typeof value.timeZone !== 'string' || !value.timeZone.length || value.timeZone.length > 100 || value.timeZone !== value.timeZone.trim()) bad();
  const date = new Date(value.now);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.now.replace(/(?<!\.\d{3})Z$/, '.000Z')) bad();
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone }).format(date); } catch { bad(); }
  return { now: value.now, timeZone: value.timeZone };
}
export function projectEvaluationClockInstructions(value) {
  const clock = validateProjectEvaluationClock(value);
  return clock
    ? `Frozen task clock: now=${clock.now}; timeZone=${clock.timeZone}. Resolve relative dates such as today against this supplied instant and zone. This clock is identical for both executions; it does not establish publication dates, external verification or other facts.`
    : 'No current-time fixture was supplied. Do not infer today from a source publication date, an expected output path, model training knowledge or the host machine clock. If relative time is necessary but unavailable, state that limitation.';
}
const bounded = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
const list = value => Array.isArray(value) ? value : [];
export function describeProjectEvaluationCase(testCase, result) {
  const answer = typeof result?.answer === 'string' ? result.answer.toLowerCase() : null;
  const tools = list(result?.toolResults);
  const failures = tools.filter(item => item?.isError === true).slice(0, 64).map(item => {
    const output = typeof item.output === 'string' ? item.output : '';
    const validation = output.startsWith('Invalid tool arguments: ');
    const argumentPath = validation ? output.match(/^Invalid tool arguments: (\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\]){0,6}):/)?.[1] : undefined;
    const code = validation ? 'invalid_tool_arguments' : /^[a-z][a-z0-9_]{0,79}$/.test(item.code ?? '') ? item.code : 'tool_execution_error';
    const recovered = result?.toolRecovery?.recovered?.find(row => row.toolCallId === item.toolCallId && row.toolName === item.toolName);
    return { toolName: bounded(item.toolName), ...(typeof item.toolCallId === 'string' ? { toolCallId: bounded(item.toolCallId) } : {}), code,
      ...(argumentPath ? { argumentPath } : {}), ...(recovered ? { recoveredByCallId: bounded(recovered.recoveredByCallId), recoveryPolicy: result.toolRecovery.policyId } : {}),
      message: recovered ? 'The SDK rejected this call before execution; a later successful correction of the same operation is retained. The failed attempt remains visible and final requirements still apply.' : validation ? 'Tool arguments did not match the declared schema; no accepted recovery is recorded for this failed call.' : 'A tool returned an error; inspect the retained private execution receipt for details.' };
  });
  return { schemaVersion: 1, termScope: 'final_answer',
    missingRequiredTerms: answer === null ? [] : list(testCase?.requiredTerms).filter(term => typeof term === 'string' && !answer.includes(term.toLowerCase())).slice(0, 30).map(term => bounded(term, 500)),
    matchedForbiddenTerms: answer === null ? [] : list(testCase?.forbiddenTerms).filter(term => typeof term === 'string' && answer.includes(term.toLowerCase())).slice(0, 30).map(term => bounded(term, 500)),
    missingRequiredToolIds: list(testCase?.requiredToolIds).filter(id => !tools.some(item => item.toolName === id && !item.isError)).slice(0, 8).map(id => bounded(id)),
    toolErrors: failures,
    artifactFailures: list(result?.workspace?.checks).filter(item => item.passed === false).slice(0, 24).map(item => ({ id: bounded(item.id), path: bounded(item.path, 240), kind: bounded(item.kind, 40), code: bounded(item.code, 80) })),
    evidenceAvailable: { finalAnswer: answer !== null, toolResults: Array.isArray(result?.toolResults), artifactChecks: Array.isArray(result?.workspace?.checks) },
  };
}
