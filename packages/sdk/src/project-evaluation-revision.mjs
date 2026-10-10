import { evolutionHash } from './evolution.mjs';
import { validateProjectGenome } from './project-genome.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_evaluation_revision' }); };
/** Explicit host-reviewed fixture/contract correction, separate from a
 * candidate's future rubric. It does not authorize adoption or alter genomes. */
export function createProjectEvaluationRevision(baseline, input, candidate = baseline) {
  const old = validateProjectGenome(baseline), next = validateProjectGenome(candidate);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['schemaVersion', 'sourceSuiteHash', 'reason', 'suite', 'suiteHash', 'revisionHash', 'adoption'].includes(key)) || input.schemaVersion !== 1 || input.sourceSuiteHash !== evolutionHash(old.evaluationSuite) || typeof input.reason !== 'string' || input.reason.trim().length < 12 || input.reason.length > 2000) fail('Revision requires the exact original suite hash and an explicit bounded correction reason');
  const suite = validateProjectGenome({ ...old, evaluationSuite: input.suite }).evaluationSuite;
  validateProjectGenome({ ...next, evaluationSuite: suite });
  const previous = old.evaluationSuite;
  for (const key of ['criteria', 'thresholds', 'execution']) if (evolutionHash(suite[key] ?? null) !== evolutionHash(previous[key] ?? null)) fail(`Fixture correction cannot change ${key}; use a separately reviewed standards migration`);
  const fixed = value => value.cases.map(({ id, weight, requiredToolIds, forbiddenTerms }) => ({ id, weight, requiredToolIds, forbiddenTerms }));
  if (evolutionHash(fixed(suite)) !== evolutionHash(fixed(previous))) fail('Fixture correction cannot change case identity, order, weight, required tools or forbidden terms');
  for (let i = 0; i < previous.cases.length; i++) {
    const before = previous.cases[i], after = suite.cases[i];
    for (const term of before.requiredTerms) if (!after.requiredTerms.includes(term) && !after.workspace?.checks.some(check => check.kind === 'text_includes' && check.values.includes(term))) fail('Removed final-answer requirements must remain explicit artifact text requirements');
  }
  if (evolutionHash(suite) === evolutionHash(previous)) fail('The revision must change the suite');
  const value = { schemaVersion: 1, sourceSuiteHash: input.sourceSuiteHash, suiteHash: evolutionHash(suite), reason: input.reason.trim(), suite, adoption: 'separate_review_required' };
  const revisionHash = evolutionHash(value);
  if (input.suiteHash !== undefined && input.suiteHash !== value.suiteHash || input.revisionHash !== undefined && input.revisionHash !== revisionHash || input.adoption !== undefined && input.adoption !== value.adoption) fail('Revision identity does not match its reviewed contents');
  return { ...value, revisionHash };
}
/** Reviewer-visible diff; never pass this or hidden fixture checks to authors. */
export function projectEvaluationRevisionDiff(before, after) {
  const changes = [];
  const visit = (left, right, path) => {
    if (evolutionHash(left ?? null) === evolutionHash(right ?? null)) return;
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit(left[key], right[key], `${path}.${key}`);
    } else changes.push({ path, before: left ?? null, after: right ?? null });
  };
  visit(before, after, 'suite'); return changes;
}
