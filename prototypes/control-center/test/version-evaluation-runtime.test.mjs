import test from 'node:test';
import assert from 'node:assert/strict';
import { controlVersion } from '../project-proactivity.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../../packages/sdk/src/project-evolution.mjs';

function fixture(hash = PROJECT_EVALUATION_RUNTIME_HASH) {
  const baseline = { id: 'base', state: 'active', bundle: { hash: 'baseline' } };
  const candidate = { id: 'candidate', state: 'ready', parentVersionId: 'base', bundle: { hash: 'candidate' }, evaluationRuntimeHash: hash,
    evaluation: { simulated: false, gatePassed: true, baselineHash: 'baseline', candidateHash: 'candidate', evaluationRuntimeHash: hash } };
  const project = { id: 'project', simulated: false, activeVersionId: 'base', trialVersionId: null, versions: [baseline, candidate], observations: [] };
  return { state: { events: [], sequence: 0 }, project, candidate };
}

test('only matching current runtime evidence may activate a real candidate; old evidence remains inspectable', () => {
  for (const hash of [undefined, 'previous-runtime']) {
    const f = fixture(hash); if (hash === undefined) { delete f.candidate.evaluationRuntimeHash; delete f.candidate.evaluation.evaluationRuntimeHash; }
    assert.throws(() => controlVersion(f.state, f.project, 'candidate', 'trial'), /运行环境已变化/);
    assert.equal(f.project.activeVersionId, 'base'); assert.equal(f.candidate.evaluation.gatePassed, true);
  }
  const f = fixture(); controlVersion(f.state, f.project, 'candidate', 'trial'); controlVersion(f.state, f.project, 'candidate', 'adopt');
  assert.equal(f.project.activeVersionId, 'candidate');
});

test('rollback stays possible when evaluation runtime changes while a candidate is under trial', () => {
  const f = fixture(); controlVersion(f.state, f.project, 'candidate', 'trial');
  f.candidate.evaluationRuntimeHash = 'old';
  assert.throws(() => controlVersion(f.state, f.project, 'candidate', 'adopt'), /运行环境已变化/);
  controlVersion(f.state, f.project, 'candidate', 'rollback');
  assert.equal(f.project.activeVersionId, 'base'); assert.equal(f.project.trialVersionId, null);
});
