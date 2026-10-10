// Independent from candidate generation. Fixed synthetic fixtures, not a real holdout
// benchmark, model evaluation, workspace change, or sandbox/process isolation.
export function runProjectPolicy(policy, sample) {
  return policy.cacheGuard === 'signal-and-revision-and-smoke'
    ? sample.signal && sample.revision && sample.smoke
    : sample.signal;
}
function score(policy) {
  const cache = [
    { signal: true, revision: true, smoke: true, expected: true },
    { signal: true, revision: true, smoke: false, expected: false },
    { signal: true, revision: false, smoke: true, expected: false },
    { signal: false, revision: true, smoke: true, expected: false },
    { signal: false, revision: false, smoke: false, expected: false },
    { signal: false, revision: true, smoke: false, expected: false }
  ];
  const style = [{ preferConcise: true }, { preferConcise: true }];
  return cache.filter(row => runProjectPolicy(policy, row) === row.expected).length + style.filter(row => Boolean(policy.concise) === row.preferConcise).length;
}
export function evaluateProjectCandidate(baseline, candidate) {
  const baselineScore = score(baseline), candidateScore = score(candidate);
  return { baseline: baselineScore, score: candidateScore, cases: 8, gatePassed: candidateScore > baselineScore, regression: candidateScore < baselineScore, simulated: true, mode: 'independent-function-fixed-synthetic-fixtures', isolation: 'module-only', evidence: `${baselineScore}/8 → ${candidateScore}/8；独立模块固定合成样例，非真实保留集或进程隔离。` };
}
