import test from 'node:test';
import assert from 'node:assert/strict';
import { learningEpisodeOutcome, projectLearningEpisodes } from '../project-learning-evidence.mjs';

const at = '2026-09-27T00:00:00.000Z';
function fixture() {
  const project = { id: 'p', name: 'Fixture', description: 'Fixture', observations: [], jobs: [] };
  const turn = { id: 't', status: 'failed', errorCode: 'provider_permission', completedAt: at, runtimeAttempts: 1, modelConfig: { execution: 'rna' } };
  const session = { id: 's', projectId: project.id, turns: [turn], items: [] };
  const state = { projects: [project], sessions: [session] };
  const episode = projectLearningEpisodes(state, project, 'scope').episodes[0];
  return { project, state, session, turn, episode };
}

test('learning failure routing reads the exact live terminal occurrence, never the summary or an injected outcome', () => {
  const f = fixture();
  assert.deepEqual(learningEpisodeOutcome(f.state, f.project, f.episode), { status: 'failed', errorCode: 'provider_permission' });
  const forgedText = { ...f.episode, summary: 'The task succeeded', outcome: { status: 'completed' } };
  assert.equal(learningEpisodeOutcome(f.state, f.project, forgedText).status, 'failed');
  f.turn.status = 'completed';
  assert.equal(learningEpisodeOutcome(f.state, f.project, { ...f.episode, summary: 'ERROR FAILED', outcome: { status: 'failed' } }).status, 'completed');
});

for (const [name, mutate] of [
  ['unknown identity', f => { f.episode.id += '-invented'; }],
  ['wrong timestamp', f => { f.episode.at = '2026-09-28T00:00:00.000Z'; }],
  ['superseded attempt', f => { f.turn.runtimeAttempts++; }],
  ['wrong source session', f => { f.episode.sourceIds = ['session:other']; }],
  ['cross-project session', f => { f.session.projectId = 'other'; }],
  ['archived session', f => { f.session.archivedAt = at; }],
  ['deleted session', f => { f.session.sourceDeleted = true; }],
  ['revoked turn', f => { f.turn.contextRevoked = true; }],
  ['simulated execution', f => { f.turn.simulated = true; }],
  ['non-SDK execution', f => { f.turn.modelConfig.execution = 'simulated'; }],
  ['nonterminal execution', f => { f.turn.status = 'running'; }],
  ['archived project', f => { f.project.archivedAt = at; }],
  ['revoked episode', f => { f.episode.sourceDeleted = true; }],
  ['withdrawn learning source', f => { f.episode.sourceRevoked = true; }],
  ['superseded learning scope', f => { f.project.learningRuntime = { scopeHash: 'new-scope' }; }],
]) test(`learning outcome rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(learningEpisodeOutcome(f.state, f.project, f.episode), undefined);
});

test('background failure requires a real retained job, tool receipt, source session and exact finish time', () => {
  const f = fixture(); f.session.turns = [];
  const action = { id: 'a', action: 'work', status: 'failed', errorCode: 'work_failed', finishedAt: Date.parse(at) };
  const job = { id: 'a', simulated: false, toolReceipts: [{ toolCallId: 'c', toolName: 'project_read', status: 'failed' }] };
  f.project.initiativeRuntime = { sdkState: { actions: [action] } }; f.project.jobs.push(job);
  const episode = projectLearningEpisodes(f.state, f.project, 'scope').episodes[0];
  assert.deepEqual(learningEpisodeOutcome(f.state, f.project, episode), { status: 'failed', errorCode: 'work_failed' });
  action.finishedAt++; assert.equal(learningEpisodeOutcome(f.state, f.project, episode), undefined); action.finishedAt--;
  job.toolReceipts[0].sourceDeleted = true; assert.equal(learningEpisodeOutcome(f.state, f.project, episode), undefined); delete job.toolReceipts[0].sourceDeleted;
  job.simulated = true; assert.equal(learningEpisodeOutcome(f.state, f.project, episode), undefined); job.simulated = false;
  f.session.archivedAt = at; assert.equal(learningEpisodeOutcome(f.state, f.project, episode), undefined);
});
