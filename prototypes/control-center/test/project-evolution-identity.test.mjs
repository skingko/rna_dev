import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectEvolutionIdentity as identity, findMatchingEvolutionAttempt as match, getEvolutionEvidenceCoverage as coverage } from '../project-evolution-identity.mjs';

const model = { providerId: 'fixture', modelId: 'm1', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxOutputTokens: 4000, reasoning: 'off' };
const project = () => ({ id: 'p1', activeVersionId: 'base1', versions: [{ id: 'base1', bundle: { hash: 'base-content' } }] });
const a = { id: 'external-a', type: 'feedback', summary: 'The user observed an incorrect claim.', at: 1000 };
const b = { id: 'external-b', type: 'tool_result', summary: 'A separate check found a wrong output.', at: 2000 };
const receipt = (value, extra = {}) => ({ id: 'attempt1', simulated: false, state: 'rejected', parentVersionId: value.baselineVersionId, baselineHash: value.baselineHash, evaluationRuntimeHash: value.evaluationRuntimeHash, modelHash: value.modelHash, inputGenomeHash: value.inputGenomeHash, evidenceIdentityVersion: value.evidenceIdentityVersion, evidenceHash: value.evidenceHash, evidenceFingerprints: value.evidenceFingerprints, inputFingerprint: value.inputFingerprint, ...extra });

test('semantic evidence identity ignores order, timestamps, duplicate rows and unrelated envelope fields', () => {
  const p = project(), original = [a, b], before = structuredClone(original), first = identity(p, { evidence: original, model });
  const refreshed = identity(p, { evidence: [{ ...b, at: 9000, recordedAt: 10000 }, { ...a, at: 8000 }, { ...a, at: 9999 }], model });
  assert.equal(first.evidenceHash, refreshed.evidenceHash); assert.equal(first.inputFingerprint, refreshed.inputFingerprint); assert.deepEqual(original, before);
  assert.equal(first.evidenceFingerprints.length, 2); assert.ok(!JSON.stringify(first).includes(a.summary));
  p.versions.push(receipt(first)); assert.equal(match(p, refreshed).id, 'attempt1');
});

test('same evidence ID with changed meaning or source type is new evidence, not permanently consumed', () => {
  const p = project(), first = identity(p, { evidence: [a], model }); p.versions.push(receipt(first));
  for (const event of [{ ...a, summary: 'The user verified the prerequisite has recovered.' }, { ...a, type: 'verified_result' }]) {
    const next = identity(p, { evidence: [event], model }); assert.notEqual(next.inputFingerprint, first.inputFingerprint); assert.equal(match(p, next), undefined);
    assert.equal(coverage(p, next).hasNewEvidence, true);
  }
});

test('pure old evidence subsets and combined old evidence are covered only within the same experiment conditions', () => {
  const p = project(); p.versions.push(receipt(identity(p, { evidence: [a], model })), receipt(identity(p, { evidence: [b], model }), { id: 'attempt2', state: 'failed' }));
  const both = coverage(p, identity(p, { evidence: [b, a], model }));
  assert.equal(both.hasNewEvidence, false); assert.equal(both.coveredEvidenceCount, 2); assert.equal(both.uncoveredEvidenceCount, 0); assert.deepEqual(both.matchingAttemptIds, ['attempt1', 'attempt2']);
  assert.equal(coverage(p, identity(p, { evidence: [a], model })).hasNewEvidence, false);
  const added = coverage(p, identity(p, { evidence: [a, { id: 'external-c', type: 'feedback', summary: 'A new independent observation.' }], model }));
  assert.equal(added.hasNewEvidence, true); assert.deepEqual(added.uncoveredEvidenceIds, ['external-c']);
});

test('baseline, model settings, runtime and candidate changes cannot inherit old evidence coverage', () => {
  const p = project(), first = identity(p, { evidence: [a], model });
  for (const patch of [{ baselineHash: 'different-base' }, { parentVersionId: 'different-version' }, { evaluationRuntimeHash: 'previous-runtime' }, { inputGenomeHash: 'edited-genome' }, { simulated: true }]) {
    p.versions = [p.versions[0], receipt(first, patch)]; assert.equal(match(p, first), undefined); assert.equal(coverage(p, first).hasNewEvidence, true);
  }
  p.versions = [p.versions[0], receipt(first)];
  for (const patch of [{ modelId: 'm2' }, { reasoning: 'high' }, { maxOutputTokens: 8000 }, { contextWindow: 64000 }, { baseUrl: 'http://127.0.0.1:2/v1' }, { compat: { supportsStore: false } }]) {
    const next = identity(p, { evidence: [a], model: { ...model, ...patch } }); assert.equal(match(p, next), undefined); assert.equal(coverage(p, next).hasNewEvidence, true);
  }
  const withSecret = identity(p, { evidence: [a], model: { ...model, apiKey: 'never-part-of-identity' } }); assert.equal(withSecret.modelHash, first.modelHash);
});

test('missing runtime identities cannot block one current experiment; after that its same semantic input is covered', () => {
  const p = project(), first = identity(p, { evidence: [a], model }); p.versions.push(receipt(first, { evaluationRuntimeHash: undefined }));
  assert.equal(match(p, first), undefined); assert.equal(coverage(p, first).hasNewEvidence, true);
  p.versions.push(receipt(first, { id: 'new-current-attempt' })); assert.equal(match(p, first).id, 'new-current-attempt'); assert.equal(coverage(p, first).hasNewEvidence, false);
});

test('legacy same-runtime receipts support exact old evidence hash only, never guessed subset coverage', () => {
  const p = project(), first = identity(p, { evidence: [a], model }), old = receipt(first, { evidenceIdentityVersion: undefined, evidenceFingerprints: undefined, inputFingerprint: undefined, evidenceHash: first.legacyEvidenceHash }); p.versions.push(old);
  assert.equal(match(p, first).id, old.id); assert.equal(coverage(p, first).hasNewEvidence, true);
  assert.equal(match(p, identity(p, { evidence: [{ ...a, at: 9999 }], model })), undefined);
  old.modelHash = undefined; assert.equal(match(p, first), undefined, 'unknown model cannot be assumed equal');
});

test('only terminal attempts suppress repetition, and explicit failed retry remains possible', () => {
  const p = project(), first = identity(p, { evidence: [a], model });
  for (const state of ['proposing', 'evaluating', 'stale', 'baseline']) { p.versions = [p.versions[0], receipt(first, { state })]; assert.equal(match(p, first), undefined); assert.equal(coverage(p, first).hasNewEvidence, true); }
  for (const state of ['rejected', 'failed', 'interrupted']) { p.versions = [p.versions[0], receipt(first, { state })]; assert.equal(match(p, first).state, state); assert.equal(match(p, first, { retryFailed: true }), undefined); }
  p.versions = [p.versions[0], receipt(first, { state: 'ready' })]; assert.equal(match(p, first, { retryFailed: true }).state, 'ready');
});
