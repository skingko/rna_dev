import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionHash } from '../src/evolution.mjs';
import { CURRENT_PROJECT_EVALUATION_PROFILE, LEGACY_PROJECT_EVALUATION_PROFILE, PROJECT_EVALUATION_PROFILES, PROJECT_EVALUATION_SESSION_POLICY, ProjectEvaluationProfileError, resolveProjectEvaluationExecution, createProjectEvaluationExecutionManifest, projectEvaluationEnvironmentInstructions } from '../src/project-evaluation-profile.mjs';

const model = { maxOutputTokens: 8192 };
const textCase = { id: 'design', input: 'PRIVATE_TASK', requiredTerms: ['PRIVATE_ORACLE'], requiredToolIds: ['validator'] };
const workspaceCase = { id: 'implementation', workspace: { files: [{ path: 'example.js', content: 'PRIVATE_FIXTURE' }], checks: [{ expected: 'PRIVATE_EXPECTED' }] } };
const suite = { version: 'frozen-1', cases: [textCase, workspaceCase], criteria: [{ id: 'quality', weight: 1 }], thresholds: { minScore: 0.8 } };

test('current profile supplies the same bounded workflow allocation for text and workspace cases', () => {
  assert.equal(CURRENT_PROJECT_EVALUATION_PROFILE.id, 'workflow-v3'); assert.equal(CURRENT_PROJECT_EVALUATION_PROFILE.toolErrorPolicy, 'schema-recovery-v2');
  assert.equal(PROJECT_EVALUATION_PROFILES['workflow-v2'].toolErrorPolicy, 'schema-recovery-v1', 'the profile before the write guard stays restorable');
  for (const sample of suite.cases) {
    assert.deepEqual(resolveProjectEvaluationExecution(suite, sample, model), { maxSteps: 16, maxOutputTokens: 4096 });
    assert.deepEqual(resolveProjectEvaluationExecution(structuredClone(suite), structuredClone(sample), structuredClone(model)), resolveProjectEvaluationExecution(suite, sample, model));
  }
});
test('explicit legacy profile reproduces old text and workspace allocations without changing source suites', () => {
  const before = structuredClone(suite);
  assert.deepEqual(resolveProjectEvaluationExecution(suite, textCase, model, LEGACY_PROJECT_EVALUATION_PROFILE), { maxSteps: 4, maxOutputTokens: 1500 });
  assert.deepEqual(resolveProjectEvaluationExecution(suite, workspaceCase, model, LEGACY_PROJECT_EVALUATION_PROFILE), { maxSteps: 16, maxOutputTokens: 4096 });
  assert.deepEqual(suite, before); assert.equal(suite.execution, undefined);
});
test('explicit frozen suite execution takes precedence over either host default and never mutates thresholds', () => {
  const explicit = { ...structuredClone(suite), execution: { maxSteps: 4, maxOutputTokens: 512 } }, before = structuredClone(explicit);
  for (const profile of Object.values(PROJECT_EVALUATION_PROFILES)) for (const sample of explicit.cases) assert.deepEqual(resolveProjectEvaluationExecution(explicit, sample, model, profile), { maxSteps: 4, maxOutputTokens: 512 });
  assert.deepEqual(explicit, before);
});
test('model output capacity only clamps downward, including below the suite declaration minimum', () => {
  for (const cap of [1, 128, 1500, 4000, 4096, 16384]) assert.equal(resolveProjectEvaluationExecution(suite, textCase, { maxOutputTokens: cap }).maxOutputTokens, Math.min(cap, 4096));
  assert.equal(resolveProjectEvaluationExecution({ execution: { maxSteps: 2, maxOutputTokens: 8192 } }, textCase, {}).maxOutputTokens, 4096);
  assert.equal(resolveProjectEvaluationExecution(suite, textCase, model).maxSteps, 16);
});
test('new explicitly declared inference budgets support real reasoning capacity while legacy and frozen allocations stay unchanged', () => {
  const declared = { ...structuredClone(suite), execution: { maxSteps: 16, maxOutputTokens: 32768 } }, before = structuredClone(declared);
  for (const cap of [1024, 8192, 32768, 131072]) for (const sample of declared.cases) assert.deepEqual(resolveProjectEvaluationExecution(declared, sample, { maxOutputTokens: cap }), { maxSteps: 16, maxOutputTokens: Math.min(cap, 32768) });
  const manifest = createProjectEvaluationExecutionManifest(declared, { maxOutputTokens: 32768 });
  assert.ok(manifest.cases.every(row => row.execution.maxOutputTokens === 32768)); assert.equal(manifest.sourceSuiteHash, evolutionHash(declared));
  assert.deepEqual(declared, before);
  assert.deepEqual(resolveProjectEvaluationExecution(suite, textCase, { maxOutputTokens: 32768 }), { maxSteps: 16, maxOutputTokens: 4096 });
  assert.match(projectEvaluationEnvironmentInstructions({ testCase: textCase, tools: [], execution: { maxSteps: 16, maxOutputTokens: 32768 } }), /at most 32768 output tokens/);
});
test('host profile constants and restored identities are deep frozen and content verified', () => {
  for (const profile of Object.values(PROJECT_EVALUATION_PROFILES)) {
    assert.equal(profile.hash, evolutionHash(Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'hash'))));
    assert.throws(() => { profile.defaults.withoutWorkspace.maxSteps = 32; }, TypeError);
    assert.throws(() => { profile.sessionPolicy.autoCompaction = true; }, TypeError);
    const identity = { id: profile.id, version: profile.version, hash: profile.hash };
    assert.deepEqual(resolveProjectEvaluationExecution(suite, textCase, model, identity), resolveProjectEvaluationExecution(suite, textCase, model, structuredClone(profile)));
  }
  assert.deepEqual(PROJECT_EVALUATION_SESSION_POLICY, { autoCompaction: false, stepLimitBehavior: 'error' });
});
test('candidate supplied profile fields cannot select a policy or alter a host profile', () => {
  assert.deepEqual(resolveProjectEvaluationExecution({ ...suite, profile: LEGACY_PROJECT_EVALUATION_PROFILE }, { ...textCase, executionProfile: LEGACY_PROJECT_EVALUATION_PROFILE }, model), { maxSteps: 16, maxOutputTokens: 4096 });
  for (const profile of [null, {}, 'workflow-v1', { ...CURRENT_PROJECT_EVALUATION_PROFILE, version: 2 }, { ...CURRENT_PROJECT_EVALUATION_PROFILE, hash: 'forged' }, { ...structuredClone(CURRENT_PROJECT_EVALUATION_PROFILE), defaults: { withoutWorkspace: { maxSteps: 32, maxOutputTokens: 8192 } } }, { id: '__proto__', version: 1, hash: '' }]) assert.throws(() => resolveProjectEvaluationExecution(suite, textCase, model, profile), error => error instanceof ProjectEvaluationProfileError && error.code === 'invalid_evaluation_profile');
});
test('execution manifests bind profile, full original suite, model cap and every resolved case equally', () => {
  const before = structuredClone(suite), baseline = createProjectEvaluationExecutionManifest(suite, { maxOutputTokens: 4000 }), candidate = createProjectEvaluationExecutionManifest(structuredClone(suite), { maxOutputTokens: 4000 });
  assert.deepEqual(baseline, candidate); assert.equal(baseline.sourceSuiteHash, evolutionHash(suite));
  assert.deepEqual(baseline.profile, { id: 'workflow-v3', version: 1, hash: CURRENT_PROJECT_EVALUATION_PROFILE.hash });
  assert.ok(baseline.cases.every(row => row.execution.maxSteps === 16 && row.execution.maxOutputTokens === 4000));
  assert.equal(baseline.effectiveExecutionHash, evolutionHash({ sessionPolicy: baseline.sessionPolicy, cases: baseline.cases, toolErrorPolicy: baseline.toolErrorPolicy }));
  assert.equal(baseline.manifestHash, evolutionHash(Object.fromEntries(Object.entries(baseline).filter(([key]) => key !== 'manifestHash'))));
  assert.deepEqual(suite, before); assert.throws(() => baseline.cases.push({}), TypeError); assert.throws(() => { baseline.cases[0].execution.maxSteps = 99; }, TypeError);
  const serialized = JSON.stringify(baseline); for (const secret of ['PRIVATE_TASK', 'PRIVATE_ORACLE', 'PRIVATE_FIXTURE', 'PRIVATE_EXPECTED']) assert.equal(serialized.includes(secret), false);
});
test('changed policy and effective budgets get new identities without changing oracle hashes', () => {
  const workflow = createProjectEvaluationExecutionManifest(suite, model), legacy = createProjectEvaluationExecutionManifest(suite, model, LEGACY_PROJECT_EVALUATION_PROFILE), lowerCap = createProjectEvaluationExecutionManifest(suite, { maxOutputTokens: 1000 });
  assert.equal(workflow.sourceSuiteHash, legacy.sourceSuiteHash); assert.notEqual(workflow.profile.hash, legacy.profile.hash); assert.notEqual(workflow.effectiveExecutionHash, legacy.effectiveExecutionHash); assert.notEqual(workflow.manifestHash, legacy.manifestHash); assert.notEqual(workflow.effectiveExecutionHash, lowerCap.effectiveExecutionHash);
  const explicit = { ...suite, execution: { maxSteps: 4, maxOutputTokens: 512 } }, a = createProjectEvaluationExecutionManifest(explicit, model), b = createProjectEvaluationExecutionManifest(explicit, model, LEGACY_PROJECT_EVALUATION_PROFILE);
  assert.notEqual(a.effectiveExecutionHash, b.effectiveExecutionHash, 'Recovery semantics are part of effective execution even when token limits match'); assert.notEqual(a.manifestHash, b.manifestHash);
  const changedTask = createProjectEvaluationExecutionManifest({ ...suite, cases: [{ ...textCase, input: 'A different frozen task' }, workspaceCase] }, model);
  assert.notEqual(workflow.sourceSuiteHash, changedTask.sourceSuiteHash); assert.notEqual(workflow.manifestHash, changedTask.manifestHash); assert.equal(workflow.effectiveExecutionHash, changedTask.effectiveExecutionHash);
});
test('malformed allocations and invalid capacities fail before any executable work can be scheduled', () => {
  for (const execution of [null, [], {}, { maxSteps: 16 }, { maxOutputTokens: 4096 }, { maxSteps: 1, maxOutputTokens: 4096 }, { maxSteps: 33, maxOutputTokens: 4096 }, { maxSteps: 3.5, maxOutputTokens: 4096 }, { maxSteps: 16, maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxSteps: 16, maxOutputTokens: 255 }, { maxSteps: 16, maxOutputTokens: 4096, extra: true }]) assert.throws(() => resolveProjectEvaluationExecution({ execution }, textCase, model), error => error.code === 'invalid_evaluation_execution');
  for (const cap of [null, 0, -1, Infinity, NaN, 1.5, '4096', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => resolveProjectEvaluationExecution(suite, textCase, { maxOutputTokens: cap }), error => error.code === 'invalid_evaluation_execution');
  for (const sample of [null, [], { workspace: false }, { workspace: null }, { workspace: [] }]) assert.throws(() => resolveProjectEvaluationExecution(suite, sample, model), error => error.code === 'invalid_evaluation_execution');
});
test('manifest rejects missing, duplicate and unbounded case inventories', () => {
  for (const cases of [undefined, [], [{}], [{ id: 1 }], [{ id: 'bad\ncase' }], [textCase, textCase], Array.from({ length: 13 }, (_, index) => ({ id: `case_${index}` }))]) assert.throws(() => createProjectEvaluationExecutionManifest({ cases }, model), error => error.code === 'invalid_evaluation_execution');
});
test('text-only environment declares actual tools and finite completion responsibility without exposing oracle data', () => {
  const prompt = projectEvaluationEnvironmentInstructions({ testCase: textCase, tools: [{ name: 'skill_load', description: 'PRIVATE_TOOL_DESCRIPTION' }, { name: 'validator', execute: () => assert.fail('Never execute declarations') }], execution: resolveProjectEvaluationExecution(suite, textCase, model) });
  assert.ok(prompt.includes('["skill_load","validator"]')); assert.match(prompt, /no workspace fixture/); assert.match(prompt, /live user project and project files are unavailable/); assert.match(prompt, /No shell, browser, network/); assert.match(prompt, /at most 16 model response requests in total/); assert.match(prompt, /at most 4096 output tokens/); assert.match(prompt, /Automatic compaction, automatic continuation and an extra summarization request are disabled/); assert.match(prompt, /Reserve at least one/); assert.match(prompt, /only when its described trigger is relevant/);
  for (const secret of ['PRIVATE_TASK', 'PRIVATE_ORACLE', 'PRIVATE_TOOL_DESCRIPTION']) assert.equal(prompt.includes(secret), false);
});
test('workspace environment describes only its isolated fixture, with capped output and no added browser permissions', () => {
  const prompt = projectEvaluationEnvironmentInstructions({ testCase: workspaceCase, tools: ['skill_load', 'project_read', 'project_write'], execution: resolveProjectEvaluationExecution(suite, workspaceCase, { maxOutputTokens: 128 }) });
  assert.match(prompt, /supplied isolated workspace fixture is the entire file environment/); assert.equal(prompt.includes('This case has no workspace fixture'), false); assert.match(prompt, /at most 128 output tokens/); assert.match(prompt, /No shell, browser, network/); assert.equal(prompt.includes('PRIVATE_FIXTURE'), false); assert.equal(prompt.includes('PRIVATE_EXPECTED'), false);
});
test('environment declarations reject arbitrary text tool names and inconsistent execution budgets', () => {
  for (const tools of [undefined, 'skill_load', [{ name: 'bad\npermission' }], ['read', 'read'], [null], Array.from({ length: 129 }, (_, index) => `tool_${index}`)]) assert.throws(() => projectEvaluationEnvironmentInstructions({ testCase: textCase, tools, execution: { maxSteps: 16, maxOutputTokens: 4096 } }), error => error.code === 'invalid_evaluation_execution');
  for (const execution of [null, { maxSteps: 1, maxOutputTokens: 4096 }, { maxSteps: 16, maxOutputTokens: 0 }, { maxSteps: Infinity, maxOutputTokens: 4096 }, { maxSteps: 16, maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => projectEvaluationEnvironmentInstructions({ testCase: textCase, tools: [], execution }), error => error.code === 'invalid_evaluation_execution');
  assert.match(projectEvaluationEnvironmentInstructions({ testCase: textCase, tools: [], execution: { maxSteps: 2, maxOutputTokens: 1 } }), /Available tool names: \[\]/);
});

test('paired evaluator freezes the caller model before progress callbacks can change later execution budgets', async () => {
  const { evaluateProjectGenomes } = await import('../src/project-evolution.mjs');
  const { projectGenomeFixture, genomeEvaluationProvider } = await import('./fixtures/project-genome.mjs');
  const callerModel = { providerId: 'profile-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 128000, maxOutputTokens: 4000, reasoning: 'off' }, calls = [];
  let changed = false;
  const result = await evaluateProjectGenomes({ baseline: projectGenomeFixture(), candidate: projectGenomeFixture({ candidate: true }), model: callerModel, provider: genomeEvaluationProvider({ calls }), onProgress(event) {
    if (!changed && event.type === 'model_request' && event.phase.startsWith('baseline:')) { changed = true; callerModel.maxOutputTokens = 512; }
  } });
  assert.equal(changed, true); assert.equal(callerModel.maxOutputTokens, 512); assert.equal(result.gatePassed, true);
  assert.equal(result.evaluationExecution.modelLimits.maxOutputTokens, 4000);
  for (const row of result.evaluationExecution.cases) assert.deepEqual(row.execution, { maxSteps: 16, maxOutputTokens: 4000 });
  for (const row of result.details) { assert.deepEqual(row.baseline.execution, { maxSteps: 16, maxOutputTokens: 4000 }); assert.deepEqual(row.candidate.execution, row.baseline.execution); }
  const executions = calls.filter(request => !request.systemPrompt.includes('blind evaluator'));
  assert.equal(executions.length, 12); assert.ok(executions.every(request => request.model.maxOutputTokens === 4000));
});

test('multi-turn allowance describes the real per-turn budget without exposing future task text', () => {
  const testCase = { ...textCase, followUps: [{ input: 'PRIVATE_FOLLOWUP' }] };
  const prompt = projectEvaluationEnvironmentInstructions({ testCase, tools: [], execution: { maxSteps: 6, maxOutputTokens: 2048 } });
  assert.match(prompt, /at most 6 model response requests per user turn/);
  assert.match(prompt, /allowance resets for each turn/);
  assert.equal(prompt.includes('PRIVATE_FOLLOWUP'), false);
  assert.equal(prompt.includes('in total for this case'), false);
});
