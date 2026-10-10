import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMind, addLesson, addAgenda, mindSource, planView, standingLessons, mindBackgroundView, selectLessons } from '../project-mind.mjs';
import { projectConstraints } from '../turn-watch.mjs';
import { wakeFloor } from '../proactive-pacing.mjs';
import { narrate } from '../proactive-narrator.mjs';
import { SessionSuggestions } from '../session-suggestions.mjs';
import { TaskAttentionService } from '../task-attention.mjs';
import { IdleCompactionService } from '../idle-compaction-service.mjs';

// C4 (review finding 4): a row a revocation marked `stale` (it leans on what was withdrawn: a note or plan item that restates a revoked
// lesson, or tells the assistant to use a tool that left) leaves EVERY model context, not only the foreground's rule, notes and turn
// blocks: the background's view, the proactive narrator and its judge, the pacing that decides whether open work keeps waking the
// agent, the suggestions, the summary request, the lessons the evolution authors read. The user's own plan keeps the item, flagged.
const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const stale = { reason: 'lesson_revoked', at: new Date(NOW).toISOString() };
function mindWith() {
  const project = { id: 'p', name: 'Novel', inbox: [], mind: null }, mind = ensureMind(project, NOW);
  const lesson = (text, kind, extra = {}) => Object.assign(addLesson(mind, { kind, text, source: mindSource('user', {}) }, { now: NOW }), extra);
  const item = (text, kind, extra = {}) => Object.assign(addAgenda(mind, { kind, text, source: mindSource('user', { sessionId: 's' }) }, { now: NOW }), { stage: 'next' }, extra);
  return { project, mind, lesson, item };
}

test('lessons: a stale one is not a standing rule for the background view, the constraint watch or the lists the host hands to models', () => {
  const { project, mind, lesson } = mindWith();
  lesson('Never use the word 守夜.', 'constraint'); lesson('Always search before drafting.', 'constraint', { stale });
  lesson('Reply in short sentences.', 'preference'); lesson('Use the old reword tool.', 'preference', { stale });
  assert.deepEqual(standingLessons(mind).map(row => row.text), ['Never use the word 守夜.', 'Reply in short sentences.']);
  assert.deepEqual(standingLessons(mind, ['constraint']).map(row => row.text), ['Never use the word 守夜.']);
  assert.deepEqual(projectConstraints(project), ['Never use the word 守夜.'], 'the watch that reads drift against the constraints');
  const view = mindBackgroundView(project, { now: NOW });
  assert.ok(!JSON.stringify(view).includes('search before drafting') && !JSON.stringify(view).includes('old reword tool') && JSON.stringify(view).includes('Never use'), 'the background work reads the rest');
  const picked = selectLessons(project, 'draft', { now: NOW });
  assert.ok(![...picked.always, ...picked.candidates].some(row => row.stale), 'and so does the foreground');
});

test('plan items: a stale one is not open work for the pacing floor, the narrator\'s judge, the suggestions, the attention judge or the summary; the user\'s plan keeps it, flagged', async () => {
  const { project, mind, item } = mindWith();
  const gone = item('先搜索查证原著风格，再动笔', 'todo', { stale }), kept = item('写第 12 章', 'todo'), asking = item('用哪个标题？', 'awaiting_user', { stale });
  // The plan the models read has no stale item; the user's views (planView stale:true) keep it, with the flag.
  assert.deepEqual(planView(mind).next.map(row => row.text), ['写第 12 章']);
  assert.deepEqual(planView(mind, { stale: true }).next.map(row => [row.text, row.stale ?? false]), [['先搜索查证原著风格，再动笔', true], ['写第 12 章', false]]);
  // Pacing: open work keeps waking the background; a plan that is only stale items is nothing open.
  const floor = { initiative: { eligible: false, reason: 'awaiting_evidence' } };
  const only = mindWith(); only.item('先搜索查证原著风格，再动笔', 'todo', { stale });
  assert.deepEqual(wakeFloor(only.project, floor, { now: NOW }), { eligible: false, reason: 'nothing_open' }, 'nothing open to wake for');
  assert.notEqual(wakeFloor(project, floor, { now: NOW }).reason, 'nothing_open', 'the live item still does');
  // The narrator's value judge is told the open items, not the stale ones.
  const seen = [];
  const decisions = { enabled: () => true, messageValue: async (_project, input) => { seen.push(input.openItems); return null; } };
  await narrate({ project, sessions: [{ id: 's', items: [] }], candidate: { kind: 'share', text: '第三章已改完。', evidenceIds: ['e1'] }, decisions, now: NOW });
  assert.ok(seen.length && !seen.flat().includes(gone.text) && seen.flat().includes(kept.text), `openItems ${JSON.stringify(seen)}`);
  // Session suggestions: what the project waits on, and the plan.
  const suggestions = new SessionSuggestions({ state: { sessions: [], projects: [project], configuration: {} } }, { now: () => NOW, git: async () => [] });
  const state = await suggestions.state(project);
  assert.deepEqual(state.waitingForUser, [], 'a stale question is not waited on'); assert.ok(!JSON.stringify(state).includes(gone.text) && !JSON.stringify(state).includes(asking.text));
  assert.ok(JSON.stringify(state).includes(kept.text));
  // The task page's attention judge reads the open items beside a finished run.
  const attention = []; const service = Object.create(TaskAttentionService.prototype);
  Object.assign(service, { store: { state: { projects: [project] } }, now: () => NOW, attempted: new Map(), decisions: { messageValue: async (_project, input) => { attention.push(input.openItems); return null; } } });
  await service.mark(project, { id: 'a1', handoff: '交接：第 12 章的初稿已经写好。' });
  assert.ok(attention.length && !attention.flat().includes(gone.text) && attention.flat().includes(kept.text), `attention ${JSON.stringify(attention)}`);
  // The idle conversation's resume judgment reads its own plan items.
  const resumes = []; const idle = Object.create(IdleCompactionService.prototype);
  const session = { id: 's', projectId: 'p', turns: [], items: [] };
  mind.agenda.find(row => row.id === kept.id).source = mindSource('user', { sessionId: 's' }); mind.agenda.find(row => row.id === gone.id).source = mindSource('user', { sessionId: 's' });
  Object.assign(idle, { store: { state: { sessions: [session], projects: [project] }, mutate() {} }, now: () => NOW, session: () => session, decisions: { sessionResume: async (_project, input) => { resumes.push(JSON.stringify(input)); return null; } } });
  await idle.judgeResume('s', { project, lastAt: NOW - 3600000 }, undefined);
  assert.ok(resumes.length && resumes[0].includes(kept.text) && !resumes[0].includes(gone.text), resumes[0]);
});
