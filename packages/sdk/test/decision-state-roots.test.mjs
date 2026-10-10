import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionState, DECISION_STATE_ROOTS } from '../src/decision-state.mjs';
import { minimizeDecisionState } from '../src/decision-kernel.mjs';

// Regression: the kernel's minimizer once forwarded a fixed list of roots, so
// newer points (message.value threads, feedback.signal, ask.necessity,
// input.interjection, gene.*) were judged on empty state. Every root a point
// builds must reach the judge.
const inputs = {
  'turn.route': { message: 'm', project: { title: 'x', goal: 'g' }, background: [{ kind: 'work', status: 'running', summary: 's' }] },
  'initiative.review': { evidence: [{ type: 'e', summary: 's' }], handoff: 'h', project: { title: 'x' } },
  'work.completion': { handoff: 'h', recentReports: ['[background work line] r'], project: { title: 'x', goal: 'g' } },
  'work.coverage': { proposal: { intent: 'i', title: 't', where: 'project folder' }, receipts: [{ source: 'conversation turn', status: 'finished', where: 'project folder', at: 0, asked: 'a', checks: ['project_read a.js: succeeded'], result: 'r' }], changes: [{ kind: 'user message', text: 'c', at: 1 }], project: { title: 'x', goal: 'g' } },
  'delivery.reach': { text: 't', recent: [{ text: 'r' }] },
  'message.check': { text: 't', recent: [{ text: 'r' }], project: { title: 'x' } },
  'initiative.direct': { text: 't', project: { title: 'x' } },
  'message.value': { text: 't', threads: [{ title: 'th', messages: ['a'] }], findings: [{ summary: 'f' }], openItems: ['o'], currentTopic: 'c', project: { title: 'x' } },
  'candidate.prescore': { summary: 's', hypothesis: 'h', changedAreas: ['prompt'], evidence: [{ type: 'e', summary: 's' }] },
  'skill.screen': { title: 't', goal: 'g', taskTypes: ['coding'] },
  'tool.risk': { name: 'rm', effect: 'exec', arguments: 'rm -rf x', message: 'm' },
  'memory.filter': { message: 'm', passages: ['p'] },
  'mind.judge': { candidate: 'c', lessons: [{ id: 'l', text: 'lt' }], message: 'm' },
  'turn.settled': { request: 'r', reply: 'p', effects: ['e'], project: { title: 'x' } },
  'tool.admission': { request: 'r', name: 'n', preview: 'p', chunks: [{ range: [1, 2], lines: '1-2', text: 't' }] },
  'input.interjection': { request: 'r', progress: 'p', message: 'm' },
  'feedback.signal': { vote: 'down', note: 'n', reply: 'r', project: { title: 'x' } },
  'notes.worth': { messages: ['m'], existing: ['e'], project: { title: 'x' } },
  'answer.match': { message: 'm', questions: [{ question: 'q', options: [{ label: 'a' }] }] },
  'lesson.applied': { request: 'r', reply: 'p', lessons: [{ kind: 'preference', text: 't' }] },
  'diagnostics.delivery': { request: 'r', file: 'a.ts', tool: 'typescript', warnings: [{ code: 'TS6133', message: 'unused' }] },
  'schedule.suggest': { requests: [{ text: 'r', day: 'monday', time: 'morning' }], project: { title: 'x' } },
  'tool.constraint': { tool: 'project_write', path: 'a.md', text: 't', rules: ['r'] },
  'turn.drift': { request: 'r', recent: ['s'] },
  'turn.rewind': { request: 'r', failure: 'f', attempts: ['a'] },
  'plan.better': { question: 'q', userApproach: 'u', evidence: 'e', project: { title: 'x' } },
  'commitment.due': { commitments: [{ request: 'r', createdAt: '2026-09-01T00:00:00Z' }], conversation: ['c'], project: { title: 'x' } },
  'share.resolved': { messages: ['m'], reply: 'r' },
  'reply.target': { message: 'm', deliveries: [{ kind: 'finding', text: 'd', ageMs: 3600000 }], latestReply: 'l', project: { title: 'x' } },
  'attention.now': { typing: true, pace: 'rapid', sinceLast: 'just_now', recent: ['x'] },
  'evidence.select': { episodes: [{ kind: 'feedback', summary: 's' }], project: { title: 'x' } },
  'capability.disclosure': { request: 'r', services: [{ name: 'n', description: 'd', tools: ['t'] }], project: { title: 'x' } },
  'context.forget': { request: 'r', recent: ['s'], results: [{ toolName: 'project_read', args: '{}', preview: 'p' }] },
  'session.resume': { idle: 'under_3h', conversationTurns: '3_to_9', latest: true, projectTurns: '10_or_more', lastUserMessage: 'u', lastReply: 'r', plan: ['p'], project: { title: 'x' } },
  'summary.coverage': { checkpoint: '## User requests\n- [done] chapter 1', request: 'Write chapter 1.' },
  'guard.triage': { title: 't', rule: 'r', file: 'f.md', hits: [{ excerpt: 'e', note: 'n' }], project: { title: 'x' } },
  'turn.review': { request: 'r', reply: 'p', correction: 'c', existing: ['e'], project: { title: 'x' } },
  'invite.stale': { kind: 'lesson', text: 't', createdAt: '2026-09-01T00:00:00Z', conversation: [{ role: 'user', text: 'u' }], project: { title: 'x' } },
  'standard.link': { title: 't', summary: 's', standards: ['a'], project: { title: 'x' } },
  'gene.consolidate': { layer: 'skill', title: 't', summary: 's', body: 'b', existing: [{ title: 'e', summary: 'f' }], project: { title: 'x' } },
  'skill.retire': { kind: 'skill', name: 'n', summary: 's', usage: 'unused_this_month', recent: ['r'], project: { title: 'x' } },
  'ask.necessity': { request: 'r', questions: [{ question: 'q', options: [{ label: 'a' }] }], present: true, project: { title: 'x' } },
  'gene.route': { kind: 'constraint', text: 't', quote: 'q', source: 's', project: { title: 'x' } },
  'effort.decision': { facts: { newEvidence: true, pending: false }, evidence: ['e'], request: 'r', project: { title: 'x', taskTypes: ['coding'] } },
  'effort.work': { facts: { origin: 'scheduled' }, task: 't', project: { title: 'x' } },
  'effort.narrator': { facts: { flags: ['status_ping'] }, message: 'm', project: { title: 'x' } },
  'effort.setup': { facts: { kind: 'new' }, task: 't', project: { title: 'x' } },
  'effort.compaction': { facts: { automatic: true }, project: { title: 'x' } },
  'gene.review': { layer: 'guard', title: 't', summary: 's', body: 'b', trigger: 'g', origin: 'o', existing: [{ layer: 'guard', title: 'e', summary: 'es' }], project: { title: 'x' } },
};

test('every root a point builds reaches the judge after minimization', () => {
  for (const point of Object.keys(DECISION_STATE_ROOTS)) {
    assert.ok(inputs[point], `fixture input for ${point}`);
    let state; try { state = buildDecisionState(point, inputs[point]); } catch (error) { assert.fail(`${point}: ${error.message}`); }
    const built = Object.keys(state).sort(), sent = Object.keys(minimizeDecisionState(state, { maxChars: 8000, knownSecrets: [] })).sort();
    assert.deepEqual(sent, built, `${point}: built ${built.join(',')} but sent ${sent.join(',')}`);
    for (const root of built) assert.ok(DECISION_STATE_ROOTS[point].includes(root), `${point} builds an undeclared root ${root}`);
  }
  const lesson = minimizeDecisionState(buildDecisionState('gene.route', inputs['gene.route']), { maxChars: 8000, knownSecrets: [] });
  assert.equal(lesson.lesson.text, 't');
});
