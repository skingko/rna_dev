import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectMindService, ensureMind, addCommitment, addLesson } from '../project-mind.mjs';
import { constraintGate, TurnWatcher, DRIFT_EVERY, REWIND_AFTER } from '../turn-watch.mjs';
import { narrate } from '../proactive-narrator.mjs';
import { combinePlanBetter } from '../../../packages/sdk/src/decision-templates.mjs';

// Plan §3.1–3.2 (M3): tool.constraint, turn.drift, turn.rewind, plan.better,
// commitment.due, share.resolved, attention.now. Judges are stubs.
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await delay(10); } throw new Error('condition did not settle'); };

test('tool.constraint: a write that breaks a stated constraint is refused with the reason; the model may insist after two refusals; no constraints, no judgment', async () => {
  const project = { id: 'p', name: 'Novel', mind: { lessons: [{ id: 'l', kind: 'constraint', status: 'active', text: '正文里不得出现“守夜”字样' }, { id: 'm', kind: 'preference', status: 'active', text: '先给结论' }] } };
  let asked; const decisions = { toolConstraint: async (_project, input) => { asked = input; return { broken: [0] }; } };
  const gate = constraintGate({ decisions, getProject: () => project });
  const call = { tool: { name: 'project_write' }, args: { path: '正文/1.md', content: '守夜人来了' } };
  const first = await gate(call);
  assert.match(first.deny, /^This write was not run: it would break a constraint the user stated: “正文里不得出现“守夜”字样”\. Change it to meet the constraint and write again; if an exception is really needed, ask the user first\.$/); assert.deepEqual(asked.rules, ['正文里不得出现“守夜”字样'], 'only constraints are checked'); assert.equal(asked.text, '守夜人来了');
  assert.ok((await gate(call)).deny); assert.equal(await gate(call), null, 'after two refusals the write goes through');
  assert.equal(await gate({ tool: { name: 'project_read' }, args: { path: 'a' } }), null);
  assert.equal(await constraintGate({ decisions, getProject: () => ({ mind: { lessons: [] } }) })(call), null);
  const edit = await constraintGate({ decisions, getProject: () => project })({ tool: { name: 'project_edit' }, args: { path: 'b.md', oldText: 'x', newText: '守夜' } });
  assert.ok(edit.deny); assert.equal(asked.text, '守夜');
});

test('turn.drift: every few steps a judged drift puts the request back in front of the model, once', async () => {
  const decisions = { turnDrift: async (_project, input) => ({ drifting: input.recent.length >= DRIFT_EVERY }) };
  const watch = new TurnWatcher({ decisions, getProject: () => ({}), workspace: tmpdir(), request: '把第三章改短' });
  for (let index = 0; index < DRIFT_EVERY; index++) { watch.onStart({ toolCallId: `c${index}`, toolName: 'project_read', args: { path: `x${index}.md` } }); watch.onEnd({ toolCallId: `c${index}`, toolName: 'project_read', result: { content: [] } }); }
  await until(() => watch.notes.length === 1);
  const [note] = watch.drain();
  assert.equal(note.key, 'turn-steering'); assert.match(note.text, /drifted/); assert.match(note.text, /把第三章改短/);
  assert.deepEqual(watch.drain(), [], 'each note is sent once');
});

test('turn.rewind: the same failure three times, judged a dead end, restores files changed since the first failure and tells the model', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-rewind-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.js'), 'original\n');
  let asked; const decisions = { turnRewind: async (_project, input) => { asked = input; return { deadEnd: true }; } };
  const watch = new TurnWatcher({ decisions, getProject: () => ({}), workspace: dir, request: '让测试通过' });
  const fail = index => { watch.onStart({ toolCallId: `f${index}`, toolName: 'project_exec', args: { command: 'npm test' } }); watch.onEnd({ toolCallId: `f${index}`, toolName: 'project_exec', isError: true, result: { content: [{ type: 'text', text: 'Error: Cannot find module x\n at ...' }] } }); };
  fail(0);
  // After the first failure, the model edits a file and creates another; both belong to the dead end.
  watch.onStart({ toolCallId: 'w1', toolName: 'project_write', args: { path: 'a.js' } }); writeFileSync(join(dir, 'a.js'), 'attempt\n'); watch.onEnd({ toolCallId: 'w1', toolName: 'project_write', result: { content: [] } });
  watch.onStart({ toolCallId: 'w2', toolName: 'project_write', args: { path: 'b.js' } }); writeFileSync(join(dir, 'b.js'), 'new\n'); watch.onEnd({ toolCallId: 'w2', toolName: 'project_write', result: { content: [] } });
  fail(1); fail(2);
  await until(() => watch.notes.length === 1);
  assert.match(asked.failure, /Cannot find module x/); assert.equal(asked.request, '让测试通过');
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'original\n'); assert.equal(existsSync(join(dir, 'b.js')), false);
  const note = JSON.parse(watch.drain()[0].text);
  assert.match(note.observation, new RegExp(`${REWIND_AFTER} times`)); assert.match(note.restored, /a\.js/); assert.match(note.nextStep, /different approach/);
});

test('plan.better: only a confident "an alternative, and the user\'s way is not worse" suppresses the card', () => {
  const answer = (proposes, worse) => ({ proposes_alternative: { type: 'boolean', probability: proposes }, user_approach_worse: { type: 'boolean', probability: worse } });
  assert.deepEqual(combinePlanBetter(answer(.95, .1)), { proposes: true, suppress: true });
  assert.deepEqual(combinePlanBetter(answer(.95, .9)), { proposes: true, suppress: false });
  assert.deepEqual(combinePlanBetter(answer(.95, .5)), { proposes: true, suppress: false }, 'unsure: shown as before');
  assert.deepEqual(combinePlanBetter(answer(.1, .1)), { proposes: false, suppress: false }, 'not a proposal: shown');
});

test('commitment.due makes a request due by the evidence or lets it wait; share.resolved closes a topic the user settled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-due-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Novel', workspace: dir, initiative: { enabled: false } });
  const now = { value: Date.now() };
  let due, wait;
  store.mutate(state => { const mind = ensureMind(state.projects.find(row => row.id === project.id)); due = addCommitment(mind, { request: '整理人物表', overdueAt: now.value + 3600000 }, { now: now.value - 30 * 60000 }).id; wait = addCommitment(mind, { request: '下周再看结局', overdueAt: now.value + 10 * 60000 }, { now: now.value - 30 * 60000 }).id; });
  const calls = []; const decisions = { enabled: () => true, commitmentDue: async (_project, input) => { calls.push(input); return { due: [0], wait: [1] }; }, shareResolved: async () => ({ resolved: true }) };
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => now.value, sweepIntervalMs: 0, notesIntervalMs: 0 });
  t.after(() => mind.close());
  await mind.checkDue(project.id);
  const rows = () => store.state.projects.find(row => row.id === project.id).mind.commitments;
  assert.equal(rows().find(row => row.id === due).overdueAt, new Date(now.value).toISOString()); assert.equal(rows().find(row => row.id === due).dueBy, 'judge');
  assert.equal(rows().find(row => row.id === wait).overdueAt, new Date(now.value + 2 * 3600000).toISOString(), 'a wait near the deadline moves it later');
  assert.equal(calls[0].commitments.length, 2);
  // share.resolved
  store.mutate(state => { const s = state.sessions.find(row => row.id === session.id); s.items.push({ id: 'pro1', kind: 'assistant', source: 'initiative', text: '第三章的节奏偏慢，要不要删掉回忆段落？', createdAt: new Date().toISOString() }); ensureMind(state.projects.find(row => row.id === project.id)).threads.push({ id: 'th1', title: '节奏', status: 'open', messageItemIds: ['pro1'] }); });
  await mind.settleThread(project.id, 'th1', '删掉吧，就这样定了');
  const thread = store.state.projects.find(row => row.id === project.id).mind.threads.find(row => row.id === 'th1');
  assert.equal(thread.status, 'resolved'); assert.equal(thread.resolvedBy, 'user_reply');
  void addLesson;
});

test('attention.now: a non-urgent message that would go out now waits while the user is in focused work', async () => {
  const now = Date.parse('2026-09-28T10:00:00Z'), project = { id: 'p', inbox: [], mind: {} };
  const session = { id: 's', projectId: 'p', items: [0, 1, 2, 3, 4].map(index => ({ id: `u${index}`, kind: 'user', text: `改第 ${index} 段`, createdAt: new Date(now - (5 - index) * 60000).toISOString() })) };
  const presence = { sessionId: 's', visible: true, typing: false, expiresAt: new Date(now + 10000).toISOString() };
  let asked;
  const decisions = { enabled: () => true, messageValue: async () => ({ probabilities: { new_information: .95, continues_open_thread_or_commitment: .9, relevant_now: .95, time_sensitive: .05, needs_user_decision: .1, already_reported: .02 }, alreadyReported: false }), attentionNow: async (_project, input) => { asked = input; return { focused: true }; } };
  const plan = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: '顺便整理了一下术语表。', evidenceIds: ['e1'] }, decisions, now, presence, lastSeenAt: now });
  assert.equal(asked.pace, 'rapid_exchange'); assert.equal(asked.sinceLast, 'just_now');
  assert.equal(plan.outcome, 'hold'); assert.deepEqual(plan.reasons, ['user_focused']);
  const calm = await narrate({ project, sessions: [session], candidate: { kind: 'share', text: '顺便整理了一下术语表。', evidenceIds: ['e1'] }, decisions: { ...decisions, attentionNow: async () => ({ focused: false }) }, now, presence, lastSeenAt: now });
  assert.notEqual(calm.reasons[0], 'user_focused');
});
