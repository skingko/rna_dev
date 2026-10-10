// P4 reliability: classify failed/interrupted evolution versions by cause.
// infra  = provider/network/environment/lifecycle (not evidence about the method)
// author = the proposer did not deliver a valid artifact
// eval   = paired execution or blind judge did not deliver a usable measurement
const AUTHOR_FORMAT = new Set(['invalid_json', 'empty_response', 'output_truncated', 'invalid_tool_call', 'invalid_submission', 'invalid_submission_arguments']);
const INFRA_CODES = new Set(['connection', 'provider_error', 'provider_incomplete', 'timeout', 'rate_limited', 'auth', 'budget', 'environment_unavailable', 'restart_interrupted', 'closed', 'aborted', 'learning_scope_changed', 'stale', 'reference_audit_failed', 'context_limit', 'search_source_revoked']);
const AUTHOR_PHASES = new Set(['proposal', 'script-repair', 'author']);

export function classifyEvolutionFailure(version) {
  const error = version?.error ?? {}, diagnostic = error.diagnostic ?? {}, code = String(error.code ?? 'unknown'), kind = String(diagnostic.kind ?? code), phase = String(diagnostic.phase ?? 'unknown');
  const base = { versionId: version?.id ?? null, state: version?.state ?? null, phase, code, kind, at: version?.completedAt ?? version?.createdAt ?? null };
  if (version?.state === 'interrupted' || INFRA_CODES.has(code) || INFRA_CODES.has(kind)) return { ...base, class: 'infra', cause: version?.state === 'interrupted' ? `interrupted_${kind}` : kind === 'connection' || code === 'connection' ? 'provider_connection' : kind };
  if (code === 'critic_rejected') return { ...base, class: 'author', cause: 'critic_rejected' };
  if (AUTHOR_PHASES.has(phase)) return { ...base, class: 'author', cause: AUTHOR_FORMAT.has(kind) ? 'author_output_format' : kind === 'step_limit' || code === 'step_limit' ? 'author_step_limit' : /evidence/i.test(error.message ?? '') ? 'author_unsupported_evidence' : `author_${kind}` };
  if (phase === 'judge') return { ...base, class: 'eval', cause: 'judge_output_schema' };
  return { ...base, class: 'eval', cause: kind === 'step_limit' ? 'eval_execution_step_limit' : `eval_${kind}` };
}

/** Aggregate over projects (read-only). */
export function classifyEvolutionFailures(projects = []) {
  const rows = projects.flatMap(project => (project.versions ?? []).filter(version => version.simulated === false && ['failed', 'interrupted'].includes(version.state)).map(version => ({ projectId: project.id, ...classifyEvolutionFailure(version) })));
  const count = key => rows.reduce((out, row) => (out[row[key]] = (out[row[key]] ?? 0) + 1, out), {});
  const states = projects.flatMap(project => (project.versions ?? []).filter(version => version.simulated === false)).reduce((out, version) => (out[version.state] = (out[version.state] ?? 0) + 1, out), {});
  return { total: rows.length, versionStates: states, byClass: count('class'), byCause: count('cause'), rows };
}
