import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { readStateText } from '../state-shards.mjs';
import { ProjectMindService, ensureMind, addLesson, addAgenda, addCommitment, mergeNotes, mindSource, patchMindEntry, deleteMindEntry, createMindEntry, liveNotes, planView, selectLessons, publicMind, mindContextUpdates, mindBackgroundView, MIND_CONTEXT_KEYS, recordRevocation, grownGenes, lessonLink, quoteKey, REVOCATION_KEEP, REVOCATION_TYPES } from '../project-mind.mjs';
import { sourceScope, withdrawSources, assertRevoked, writesOf } from '../source-revocation.mjs';
import { RevocationDispatcher, contextRevocationsFor, markContextRevoked } from '../revocation-dispatcher.mjs';

// C4 (reference alignment §2.1 P2.1, §2.2 C4): the revocation dispatcher. Typed events, a durable entry per revocation,
// each subsystem's own handler, one batch JEV judgment per kind of row, a final assertion — and the invariant, per event
// type: afterwards no live row has all of its sources inside the revoked scope, and no raw excerpt of it is left.
// Synthetic state, stub judges, no model and no repository.
const SECRET = 'PRIVATE-NOTE-用户住在青岛的老街';
const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const iso = at => new Date(at).toISOString();

function setup(t, { judge = null, genes = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-revocation-')), file = join(dir, 'state.json'), store = new Store(file);
  const { project, session } = store.createProject({ name: 'Novel', workspace: dir, initiative: { enabled: false } });
  const other = store.createSession({ projectId: project.id });
  const clock = { now: NOW }, calls = { stale: [], genes: [] };
  const state = { on: true, answer: judge ?? (() => ({ stale: [] })) };
  const decisions = { enabled: () => state.on, config: () => ({ modes: {} }), mindStale: async (_project, input) => { calls.stale.push(structuredClone(input)); const out = state.answer(input); return out ? { stale: out.stale, ledgerId: 'ledger-1' } : null; } };
  store.mutate(draft => { const target = draft.projects.find(row => row.id === project.id); target.simulated = false; target.initialization = { status: 'ready' }; ensureMind(target, NOW - 86400000).migratedAt = iso(NOW - 86400000); });
  const mind = new ProjectMindService(store, { decisions, provider: null, now: () => clock.now, sweepIntervalMs: 0, notesIntervalMs: 0 });
  store.mind = mind;
  const dispatcher = new RevocationDispatcher(store, { decisions, now: () => clock.now, auditIntervalMs: 0 });
  dispatcher.register(mind.revocationHandler());
  // The genes handler is its own subsystem's (revocation-genes.test.mjs runs the real one); here a recording stand-in.
  dispatcher.register(genes ?? { name: 'genes', events: ['lesson_revoked', 'tool_withdrawn'], settle: async entry => { calls.genes.push(entry); return { retired: [] }; }, assert: async () => [] });
  t.after(async () => { await dispatcher.close(); await mind.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const change = fn => store.mutate(draft => fn(draft.projects.find(row => row.id === project.id), draft));
  const entries = (type = null) => (current().mind.revocations ?? []).filter(row => !type || row.type === type);
  return { dir, file, store, project, session, other, mind, dispatcher, decisions, state, calls, clock, current, change, entries };
}
const noteId = (f, list, text) => f.current().mind.notes[list].find(row => row.text === text).id;
const lessonRow = (f, id) => f.current().mind.lessons.find(row => row.id === id);
const addNote = (mind, list, text, sources = []) => { mergeNotes(mind, { [list]: [text] }, { now: NOW, source: mindSource('model'), sources }); return mind.notes[list].at(-1); };

test('every event type is typed; an unknown one is refused; an unsettled duplicate of a lesson revocation is not written twice', t => {
  const f = setup(t);
  assert.deepEqual([...REVOCATION_TYPES], ['session_deleted', 'message_rewound', 'lesson_revoked', 'tool_withdrawn', 'change_reverted', 'privacy_revoked']);
  assert.throws(() => f.dispatcher.dispatch({ type: 'folder_moved', projectId: f.project.id }), /unknown revocation/);
  assert.throws(() => f.dispatcher.register({ name: 'x', events: ['nope'] }), /revocation event types/);
  f.change(project => { const mind = project.mind, lesson = addLesson(mind, { kind: 'constraint', text: '不要写守夜人' }, { now: NOW }); recordRevocation(mind, { type: 'lesson_revoked', lessonId: lesson.id, cause: 'user_revoked', text: lesson.text }, { now: NOW }); recordRevocation(mind, { type: 'lesson_revoked', lessonId: lesson.id, cause: 'user_revoked', text: lesson.text }, { now: NOW }); });
  assert.equal(f.entries('lesson_revoked').length, 1);
});

test('lesson_revoked: the mind API writes the entry in the revoking transaction; the dispatcher settles it; the genes handler is told, the notes and plan items are judged in ONE call', async t => {
  const f = setup(t, { judge: input => ({ stale: input.rows.map((row, index) => row.text.includes('先搜索') ? index : -1).filter(index => index >= 0) }) });
  let lessonId, restating, other, plan, otherPlan;
  f.change(project => {
    const mind = project.mind;
    lessonId = addLesson(mind, { kind: 'constraint', text: '写作前先搜索查证原著风格再动笔', source: mindSource('correction', { sessionId: f.session.id, itemId: 'u1' }), evidence: [{ sessionId: f.session.id, itemId: 'u1', excerpt: '先搜索原著风格', at: iso(NOW) }] }, { now: NOW }).id;
    restating = addNote(mind, 'preferences', '动笔前先搜索查证原著风格').id; other = addNote(mind, 'facts', '用户习惯晚上看稿').id;
    plan = addAgenda(mind, { kind: 'todo', text: '先搜索原著风格，再写第 12 章' }, { now: NOW }).id; otherPlan = addAgenda(mind, { kind: 'todo', text: '整理伏笔登记表' }, { now: NOW }).id;
  });
  // The user revokes the lesson on the mind page (PATCH): the entry is written in the same transaction.
  f.change(project => patchMindEntry(project, 'lessons', lessonId, { status: 'retired' }, { now: NOW }));
  assert.equal(lessonRow(f, lessonId).status, 'retired'); assert.equal(f.entries('lesson_revoked').length, 1, 'recorded with the revocation itself');
  assert.equal(f.entries()[0].cause, 'user_revoked'); assert.deepEqual(f.entries()[0].steps, {}); assert.ok(lessonRow(f, lessonId).revocation, 'the lesson row says it was revoked, and by which entry');
  await f.dispatcher.idle();
  const entry = f.entries()[0];
  assert.ok(entry.settledAt, 'settled'); assert.equal(entry.text, undefined, 'the revoked words are not kept once it settled'); assert.equal(entry.link, undefined);
  assert.deepEqual(f.calls.genes.map(row => [row.type, row.lessonId, row.cause]), [['lesson_revoked', lessonId, 'user_revoked']], 'the genes handler was told');
  assert.equal(f.calls.stale.length, 1, 'one batch call for the event');
  const asked = f.calls.stale[0];
  assert.equal(asked.kind, 'lesson'); assert.equal(asked.revoked, '写作前先搜索查证原著风格再动笔');
  assert.deepEqual(asked.rows.map(row => [row.kind, row.text]).sort(), [['note', '动笔前先搜索查证原著风格'], ['plan', '先搜索原著风格，再写第 12 章']], 'the nearest notes and plan items, nothing else');
  const stale = f.current().mind;
  assert.equal(stale.notes.preferences.find(row => row.id === restating).stale.reason, 'lesson_revoked'); assert.equal(stale.notes.preferences.find(row => row.id === restating).stale.lessonId, lessonId);
  assert.equal(stale.agenda.find(row => row.id === plan).stale.reason, 'lesson_revoked');
  assert.ok(!stale.notes.facts.find(row => row.id === other).stale && !stale.agenda.find(row => row.id === otherPlan).stale, 'what does not restate it is left');
  assert.deepEqual(entry.result.judged, { lesson: { rows: 2, stale: 2, ledgerId: 'ledger-1' } }); assert.equal(entry.result.violations, 0);
  // Stale rows leave every model context, stay visible to the user, and the user can say they still hold.
  const project = f.current();
  assert.deepEqual(liveNotes(project.mind.notes).preferences.map(row => row.id), [], 'out of the notes block');
  assert.deepEqual(planView(project.mind).next.map(row => row.id), [otherPlan], 'out of the plan the models read');
  assert.ok(!JSON.stringify(mindBackgroundView(project, { now: NOW, query: '' }) ?? {}).includes('先搜索原著风格'));
  assert.ok(!mindContextUpdates({ notes: liveNotes(project.mind.notes) }).find(row => row.key === MIND_CONTEXT_KEYS.notes).text.includes('先搜索查证'));
  assert.ok(publicMind(project, { now: NOW }).notes.preferences.find(row => row.id === restating).stale, 'the mind page still lists it, marked');
  f.change(draft => patchMindEntry(draft, 'notes', restating, { stale: null }, { now: NOW }));
  assert.equal(f.current().mind.notes.preferences.find(row => row.id === restating).stale, undefined, 'the user keeps it');
  assert.throws(() => f.change(draft => patchMindEntry(draft, 'notes', restating, { stale: true }, { now: NOW })), /null/);
});

test('lesson_revoked causes: a rewrite, a delete and a contradicting newer lesson each write their entry; a repeat or a sharper version does not', t => {
  const f = setup(t);
  let a, b, c, d;
  f.change(project => {
    const mind = project.mind;
    a = addLesson(mind, { kind: 'preference', text: '回复保持简短' }, { now: NOW }).id; b = addLesson(mind, { kind: 'preference', text: '数字一律用汉字' }, { now: NOW }).id;
    c = addLesson(mind, { kind: 'preference', text: '每章不少于三千字' }, { now: NOW }).id; d = addLesson(mind, { kind: 'preference', text: '章末要有钩子' }, { now: NOW }).id;
  });
  f.change(project => patchMindEntry(project, 'lessons', a, { text: '回复可以详细一些' }, { now: NOW }));
  f.change(project => patchMindEntry(project, 'lessons', a, { kind: 'constraint' }, { now: NOW }));
  f.change(project => deleteMindEntry(project, 'lessons', b, { now: NOW }));
  assert.deepEqual(f.entries('lesson_revoked').map(row => [row.lessonId, row.cause]), [[a, 'rewritten'], [b, 'deleted']], 'a changed kind is not a revocation; the rewrite is, with the old words');
  assert.equal(f.entries()[0].text, '回复保持简短', 'what to judge the restating rows against is what the lesson said before');
  // The user's newer lesson contradicts c (mind.judge): c is taken back, and so is what grew from it. A sharper version of d is not.
  f.change(project => {
    const mind = project.mind, newer = addLesson(mind, { kind: 'preference', text: '章节长短不限', source: mindSource('correction', {}) }, { now: NOW + 1 }), sharper = addLesson(mind, { kind: 'preference', text: '章末要有钩子，且钩子在下一章回收', source: mindSource('correction', {}) }, { now: NOW + 2 });
    // Through the same function the lesson writer and the consolidation use.
    for (const [lesson, ids, reasons] of [[newer, new Set([c]), new Map([[c, 'contradicts']])], [sharper, new Set([d]), new Map([[d, 'refines']])]]) {
      for (const row of mind.lessons) if (ids.has(row.id)) { Object.assign(row, { status: 'superseded', supersededBy: lesson.id, supersededReason: reasons.get(row.id) }); }
    }
  });
  // The supersede function itself (exercised through consolidateLesson in the mind tests) is covered below by the service.
  assert.equal(f.entries('lesson_revoked').length, 2);
});

test('the lesson writer: a user lesson that contradicts an older one takes it back (entry with the replacing lesson); one that only sharpens it does not; an assistant lesson never does', async t => {
  const f = setup(t);
  let old, sharp, kept;
  f.change(project => { const mind = project.mind; old = addLesson(mind, { kind: 'preference', text: '段落要长' }, { now: NOW - 3000 }).id; sharp = addLesson(mind, { kind: 'preference', text: '章末要有钩子' }, { now: NOW - 2000 }).id; kept = addLesson(mind, { kind: 'preference', text: '用户的老规矩' }, { now: NOW - 1000 }).id; });
  // consolidateLesson: the newest lesson against the older ones near it (mind.judge): contradicts the first, refines the second.
  let newest;
  f.change(project => { newest = addLesson(project.mind, { kind: 'preference', text: '段落要短，章末钩子要在下一章回收', source: mindSource('correction', {}) }, { now: NOW }).id; });
  f.mind.decisions = { enabled: () => true, mindJudge: async (_project, input) => ({ same: [], contradicts: input.lessons.flatMap((row, index) => row.text === '段落要长' ? [index] : []), refines: input.lessons.flatMap((row, index) => row.text === '章末要有钩子' ? [index] : []), applies: [], notApplies: [], resolved: [] }) };
  await f.mind.consolidateLesson(f.project.id, newest);
  assert.deepEqual([lessonRow(f, old).status, lessonRow(f, old).supersededReason, lessonRow(f, sharp).status, lessonRow(f, sharp).supersededReason], ['superseded', 'contradicts', 'superseded', 'refines']);
  assert.deepEqual(f.entries('lesson_revoked').map(row => [row.lessonId, row.cause, row.replacedBy]), [[old, 'contradicted', newest]], 'only the contradicted one is taken back');
  assert.equal(lessonRow(f, kept).status, 'active');
  // An assistant-sourced lesson never outvotes a kept user lesson: nothing is superseded, nothing revoked.
  let agent;
  f.change(project => { agent = addLesson(project.mind, { kind: 'preference', text: '段落要极长', source: mindSource('agent', {}) }, { now: NOW + 5 }).id; });
  f.mind.decisions = { enabled: () => true, mindJudge: async (_project, input) => ({ same: [], contradicts: input.lessons.map((_, index) => index), refines: [], applies: [], notApplies: [], resolved: [] }) };
  await f.mind.consolidateLesson(f.project.id, agent);
  assert.equal(f.entries('lesson_revoked').length, 1, 'the user\'s lessons stay; no revocation for what was only outranked');
});

test('the user chooses the assistant\'s held lesson over their own older one: the older one is taken back, with what grew from it', async t => {
  const f = setup(t);
  let user, held;
  f.change(project => {
    const mind = project.mind;
    user = addLesson(mind, { kind: 'preference', text: '段落要长' }, { now: NOW - 1000 }).id;
    held = addLesson(mind, { kind: 'preference', text: '段落要短', source: mindSource('agent', {}) }, { now: NOW }).id;
    Object.assign(mind.lessons.find(row => row.id === held), { status: 'held', needsConfirmation: true, confirmReason: 'conflicts_user_lesson', conflictsWith: [user] });
  });
  assert.equal(f.mind.answerLessonInvitation(f.project.id, held, { choice: 'confirm' }), true);
  assert.deepEqual([lessonRow(f, user).status, lessonRow(f, user).supersededReason, lessonRow(f, held).status], ['superseded', 'user_chose', 'active']);
  assert.deepEqual(f.entries('lesson_revoked').map(row => [row.lessonId, row.cause, row.replacedBy]), [[user, 'chosen', held]], 'their choice is a contradiction they settled');
  // Keeping the original (revoke on the held lesson) takes back only the held one, which never grew anything.
  let held2;
  f.change(project => { held2 = addLesson(project.mind, { kind: 'preference', text: '段落要极短', source: mindSource('agent', {}) }, { now: NOW + 5 }).id; Object.assign(project.mind.lessons.find(row => row.id === held2), { status: 'held', needsConfirmation: true, conflictsWith: [held] }); });
  f.mind.answerLessonInvitation(f.project.id, held2, { choice: 'revoke' });
  assert.equal(lessonRow(f, held).status, 'active'); assert.equal(f.entries('lesson_revoked').at(-1).lessonId, held2);
});

test('judge off: nothing is marked and the entry settles; judge unavailable: the entry waits and is tried again after its backoff', async t => {
  let answers = 0;
  const f = setup(t, { judge: () => (++answers === 1 ? null : { stale: [0] }) });
  let lessonId, noteRow;
  f.change(project => { const mind = project.mind; lessonId = addLesson(mind, { kind: 'constraint', text: '正文不出现守夜人字样' }, { now: NOW }).id; noteRow = addNote(mind, 'preferences', '正文里不要出现守夜人字样').id; });
  f.state.on = false;
  f.change(project => patchMindEntry(project, 'lessons', lessonId, { status: 'retired' }, { now: NOW }));
  await f.dispatcher.idle();
  assert.ok(f.entries()[0].settledAt, 'an off or shadow judge is an answer, not a failure'); assert.equal(f.entries()[0].result.judged.lesson.judged, 'off');
  assert.equal(f.current().mind.notes.preferences.find(row => row.id === noteRow).stale, undefined);
  // Unavailable (enabled, no answer): the entry waits.
  let second;
  f.state.on = true;
  f.change(project => { second = addLesson(project.mind, { kind: 'constraint', text: '正文不出现守夜人字样，也别写它的变体' }, { now: NOW }).id; });
  f.change(project => patchMindEntry(project, 'lessons', second, { status: 'retired' }, { now: NOW }));
  await f.dispatcher.drain();
  const waiting = f.entries().find(row => row.lessonId === second);
  assert.equal(waiting.settledAt, undefined); assert.equal(waiting.steps.judged, 'pending'); assert.ok(waiting.retryAt && Date.parse(waiting.retryAt) > f.clock.now, 'backs off');
  await f.dispatcher.drain();
  assert.equal(answers, 1, 'not asked again before the backoff');
  f.clock.now += 121000;
  await f.dispatcher.drain();
  assert.ok(f.entries().find(row => row.lessonId === second).settledAt, 'asked again once the backoff passed, and settled');
  assert.equal(f.current().mind.notes.preferences.find(row => row.id === noteRow).stale.reason, 'lesson_revoked');
});

test('durable: an entry written but not settled (the process stopped) is finished by the next dispatcher; a handler that fails is retried, then flagged, never lost', async t => {
  const f = setup(t);
  let lessonId;
  f.change(project => { lessonId = addLesson(project.mind, { kind: 'constraint', text: '不要写守夜人' }, { now: NOW }).id; patchMindEntry(project, 'lessons', lessonId, { status: 'retired' }, { now: NOW }); });
  await f.dispatcher.close();
  assert.equal(f.entries()[0].settledAt, undefined, 'the first dispatcher never ran');
  let attempts = 0;
  const next = new RevocationDispatcher(f.store, { decisions: f.decisions, now: () => f.clock.now, auditIntervalMs: 0 });
  next.register(f.mind.revocationHandler()).register({ name: 'genes', events: ['lesson_revoked'], settle: async () => { attempts++; if (attempts < 3) throw Object.assign(new Error('bundle busy'), { code: 'version_changed' }); return { retired: [] }; } });
  t.after(() => next.close());
  await next.drain();
  assert.equal(f.entries()[0].settledAt, undefined); assert.equal(f.entries()[0].attempts, 1); assert.equal(f.entries()[0].steps.genes, 'failed');
  f.clock.now += 121000; await next.drain();
  f.clock.now += 601000; await next.drain();
  assert.equal(attempts, 3); assert.ok(f.entries()[0].settledAt, 'the third attempt went through');
  // Five failures flag it (`failed`), and a restart tries once more.
  const broken = new RevocationDispatcher(f.store, { decisions: f.decisions, now: () => f.clock.now, auditIntervalMs: 0 });
  broken.register({ name: 'genes', events: ['tool_withdrawn'], settle: async () => { throw new Error('never'); } });
  t.after(() => broken.close());
  const entry = broken.dispatch({ type: 'tool_withdrawn', projectId: f.project.id, tools: [{ kind: 'guard', name: 'g1' }] });
  for (let round = 0; round < 6; round++) { f.clock.now += 3700000; await broken.drain(); }
  const row = f.entries().find(item => item.id === entry.id);
  assert.equal(row.failed, true); assert.equal(row.attempts, 5); assert.equal(broken.pendingEntries().length, 0, 'not retried forever');
});

test('settled entries are trimmed (a month, bounds); those carrying a context request stay for a year; unsettled ones never go', t => {
  const f = setup(t);
  f.change(project => {
    const mind = project.mind, at = NOW;
    for (let index = 0; index < REVOCATION_KEEP.settled + 10; index++) { const row = recordRevocation(mind, { type: 'change_reverted', ids: [`r${index}`] }, { now: at - index }); row.settledAt = iso(at); }
    const old = recordRevocation(mind, { type: 'message_rewound', context: { keys: ['k'], sourceIds: [] } }, { now: at - 100 * 86400000 }); old.settledAt = iso(at - 100 * 86400000);
    const open = recordRevocation(mind, { type: 'tool_withdrawn', tools: [{ name: 'x' }] }, { now: at - 200 * 86400000 });
    recordRevocation(mind, { type: 'change_reverted', ids: ['now'] }, { now: at });
    assert.ok(mind.revocations.includes(open), 'an unsettled entry stays however old');
    assert.ok(mind.revocations.includes(old), 'a settled one with a context request stays past a month');
    assert.ok(mind.revocations.filter(row => row.type === 'change_reverted' && row.settledAt).length <= REVOCATION_KEEP.settled, 'the plain settled ones are bounded');
  });
});

// ------------------------------------------------------------- session_deleted / message_rewound
test('message_rewound: what came wholly from the removed messages is withdrawn, links and excerpts leave, a note that kept other sources is judged against what is left, and the invariant holds', async t => {
  const f = setup(t, { judge: input => ({ stale: input.rows.map((row, index) => row.sources.some(text => text.includes('青岛')) ? -1 : index).filter(index => index >= 0) }) });
  const A = f.session.id, B = f.other.id;
  f.store.mutate(state => {
    const draft = state.sessions.find(row => row.id === A), side = state.sessions.find(row => row.id === B);
    draft.items.push({ id: 'a-keep', kind: 'user', text: '我家在青岛', createdAt: iso(NOW) });
    side.items.push({ id: 'b-1', kind: 'user', text: '今天的日报写简洁些', createdAt: iso(NOW) });
  });
  let wholly, mixedSupported, mixedLost, lessonId, planId, commitId;
  f.change(project => {
    const mind = project.mind;
    wholly = addNote(mind, 'facts', SECRET, [{ sessionId: A, itemId: 'a-gone' }]).id;
    mixedSupported = addNote(mind, 'facts', '用户家在青岛', [{ sessionId: A, itemId: 'a-gone' }, { sessionId: A, itemId: 'a-keep' }]).id;
    mixedLost = addNote(mind, 'preferences', '日报要写得很详细', [{ sessionId: A, itemId: 'a-gone' }, { sessionId: B, itemId: 'b-1' }]).id;
    lessonId = addLesson(mind, { kind: 'preference', text: '段落要长', source: mindSource('correction', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: SECRET, at: iso(NOW) }] }, { now: NOW }).id;
    // A rewind keeps the text of the rows it withdraws (the user edited their own message; deletion strips it), so what must be
    // gone here are the excerpts: evidence quotes, links and the notes written from the message.
    planId = addAgenda(mind, { kind: 'todo', text: '接着改第三章', source: mindSource('turn', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: SECRET, at: iso(NOW) }] }, { now: NOW }).id;
    commitId = addCommitment(mind, { request: '改第三章', trigger: 'user_request', source: mindSource('capture', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: SECRET, at: iso(NOW) }] }, { now: NOW }).id;
  });
  // The messages are removed from the conversation, then the revocation runs in the same transaction (runtime-controller rewind).
  let result;
  f.store.mutate(state => {
    const draft = state.sessions.find(row => row.id === A); draft.items = draft.items.filter(row => row.id !== 'a-gone');
    const project = state.projects.find(row => row.id === f.project.id), scope = sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] });
    result = withdrawSources(state, project, scope, { mode: 'rewound', now: NOW });
  });
  assert.deepEqual(result.violations, [], 'the assertion holds');
  assert.deepEqual([result.notes, result.pruned], [1, 2], 'one note was wholly the removed message; two kept other sources and lost the link');
  const mind = f.current().mind;
  assert.ok(!mind.notes.facts.some(row => row.id === wholly));
  assert.deepEqual(mind.notes.facts.find(row => row.id === mixedSupported).sources, [{ sessionId: A, itemId: 'a-keep' }], 'the link into the removed message is gone');
  assert.equal(lessonRow(f, lessonId).status, 'retired'); assert.equal(lessonRow(f, lessonId).retiredReason, 'source_removed'); assert.equal(lessonRow(f, lessonId).evidence[0].excerpt, undefined);
  assert.equal(mind.agenda.find(row => row.id === planId).status, 'dropped'); assert.equal(mind.commitments.find(row => row.id === commitId).status, 'dismissed');
  // Entries: the lesson the rewind retired (genes and restating notes are looked for), and the rewind itself with its candidates and context request.
  assert.deepEqual(f.entries().map(row => row.type).sort(), ['lesson_revoked', 'message_rewound']);
  const rewound = f.entries('message_rewound')[0];
  assert.deepEqual(rewound.candidates.map(row => row.id).sort(), [mixedLost, mixedSupported].sort()); assert.deepEqual(rewound.context.keys, Object.values(MIND_CONTEXT_KEYS)); assert.equal(rewound.sessionId, A);
  await f.dispatcher.idle();
  const asked = f.calls.stale.find(input => input.kind === 'source');
  assert.deepEqual(asked.rows.map(row => [row.text, row.sources]).sort(), [['日报要写得很详细', ['今天的日报写简洁些']], ['用户家在青岛', ['我家在青岛']]].sort(), 'judged against the messages that remain, in their own words');
  assert.ok(!JSON.stringify(f.calls.stale).includes(SECRET), 'the removed message is never sent');
  assert.equal(f.current().mind.notes.preferences.find(row => row.id === mixedLost).stale.reason, 'message_rewound', 'no remaining message says it: stale');
  assert.equal(f.current().mind.notes.facts.find(row => row.id === mixedSupported).stale, undefined, 'a remaining message still says it: kept');
  assert.ok(f.entries('message_rewound')[0].settledAt && f.entries('lesson_revoked')[0].settledAt);
  // The invariant, again after everything settled, and no raw excerpt anywhere in what is stored.
  assert.deepEqual(assertRevoked(f.current(), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound' }), []);
  assert.ok(!readStateText(f.file).includes(SECRET), 'no raw excerpt of the removed message is left');
});

test('session_deleted: the same step for a whole conversation — lesson text stays (the notice), everything wholly its own goes, and a second pass changes nothing', t => {
  const f = setup(t);
  const A = f.session.id;
  let lessonId, planId;
  f.change(project => {
    const mind = project.mind;
    addNote(mind, 'facts', SECRET, [{ sessionId: A, itemId: 'x1' }, { sessionId: A, itemId: 'x2' }]);
    lessonId = addLesson(mind, { kind: 'constraint', text: '至少读 30 章', source: mindSource('correction', { sessionId: A, itemId: 'x1' }), evidence: [{ sessionId: A, itemId: 'x1', excerpt: SECRET, at: iso(NOW) }] }, { now: NOW }).id;
    planId = addAgenda(mind, { kind: 'todo', text: SECRET, source: mindSource('turn', { sessionId: A, turnId: 't1' }) }, { now: NOW }).id;
    // The file-write layer is project.git.applies itself: the deleted conversation's writes are found there, where they are recorded.
    project.git = { applies: [{ id: 'apply-1', kind: 'turn', state: 'verified', target: 'project', source: { sessionId: A, turnId: 't1' }, files: 1, sample: ['正文/第001章.md'], at: iso(NOW) }, { id: 'apply-2', kind: 'turn', state: 'verified', target: 'project', source: { sessionId: 'other-conversation', turnId: 't9' }, files: 1, sample: ['b.md'], at: iso(NOW) }], worktrees: [] };
  });
  let first, second;
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); first = withdrawSources(state, project, sourceScope({ sessionId: A }), { mode: 'deleted', now: NOW }); });
  assert.deepEqual(first.violations, []); assert.equal(first.writes, 1, 'the one apply record its turn wrote is found in project.git.applies, not in a store of its own');
  assert.deepEqual(writesOf(f.current(), sourceScope({ sessionId: A })).map(row => row.id), ['apply-1']); assert.equal(f.current().git.applies.length, 2, 'the files stay: the records are what a revocation reports, not what it removes');
  assert.equal(lessonRow(f, lessonId).status, 'active', 'a deleted conversation keeps the lessons it taught'); assert.equal(lessonRow(f, lessonId).evidence[0].excerpt, undefined);
  assert.equal(f.current().mind.agenda.find(row => row.id === planId).status, 'dropped'); assert.equal(f.current().mind.notes.facts.length, 0);
  assert.equal(f.entries('session_deleted').length, 1); assert.equal(f.entries('lesson_revoked').length, 0);
  assert.ok(f.entries('session_deleted')[0].settledAt, 'nothing to judge: only the context request, settled');
  assert.deepEqual(f.entries('session_deleted')[0].applies, ['apply-1'], 'the entry refers to the apply record by id (project.git.applies), it does not copy it');
  assert.deepEqual(f.entries('session_deleted')[0].context.keys, Object.values(MIND_CONTEXT_KEYS));
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); second = withdrawSources(state, project, sourceScope({ sessionId: A }), { mode: 'deleted', now: NOW }); });
  assert.deepEqual([second.withdrawn, second.stripped, second.notes, second.pruned, second.entry], [0, 0, 0, 0, null], 'repeating changes nothing');
  assert.equal(f.entries('session_deleted').length, 1);
});

test('a note written from a batch of messages is judged against ALL the messages of the batch that remain, in their own words — not the first three (live: 22 of 26 supported notes were marked stale that way)', async t => {
  const f = setup(t, { judge: input => ({ stale: input.rows.map((row, index) => row.sources.some(text => text.includes('v 前缀')) ? -1 : index).filter(index => index >= 0) }) });
  const A = f.session.id;
  const said = ['继续写第 5 章', '把第 3 章的开头改短一点', '今天先到这里', '这个人物的名字再想想', '发布的标签都要带 v 前缀', '谢谢，这版可以'];
  f.store.mutate(state => { state.sessions.find(row => row.id === A).items.push(...said.map((text, index) => ({ id: `m${index}`, kind: 'user', text, createdAt: iso(NOW) }))); });
  // The note came from the fifth message of a batch of six, and every message of the batch is linked to it (mergeNotes).
  f.change(project => { addNote(project.mind, 'preferences', '发布的标签要带 v 前缀', said.map((_, index) => ({ sessionId: A, itemId: `m${index}` }))); });
  f.store.mutate(state => {
    const draft = state.sessions.find(row => row.id === A); draft.items = draft.items.filter(row => row.id !== 'm1');
    withdrawSources(state, state.projects.find(row => row.id === f.project.id), sourceScope({ sessionId: A, itemIds: ['m1'], turnIds: [] }), { mode: 'rewound', now: NOW });
  });
  await f.dispatcher.idle();
  const asked = f.calls.stale.find(input => input.kind === 'source');
  assert.deepEqual(asked.rows[0].sources, said.filter((_, index) => index !== 1), 'every remaining message, in order: the fifth is there although it is not among the first three');
  assert.equal(f.current().mind.notes.preferences[0].stale, undefined, 'the note stands: its source message was not the one that was rewound');
  assert.ok(!JSON.stringify(f.calls.stale).includes('开头改短'), 'the rewound message is never sent');
});

test('the stale judgment fits the kernel\'s state bound by calls, not by dropping rows: every row is judged, and the indices come back in the caller\'s order', async () => {
  const { DecisionService } = await import('../decision-service.mjs');
  const calls = [];
  const service = Object.create(DecisionService.prototype);
  Object.assign(service, { enabled: () => true, now: () => 1, record: () => {}, secrets: () => [], decide: async input => { calls.push(Object.keys(input.assessmentPlan.questions).length); return { point: 'mind.judge', source: 'judge', backend: 'typesafe', ledgerId: `l${calls.length}`, mode: 'active', answers: Object.fromEntries(Object.keys(input.assessmentPlan.questions).map(id => [id, { type: 'boolean', probability: id === 'stale_1' ? .05 : .95 }])) }; } });
  // Six notes with eight long messages each cannot be one state: each row is about 3.4K characters.
  const rows = Array.from({ length: 6 }, (_, index) => ({ kind: 'note', text: `note ${index}`, sources: Array.from({ length: 8 }, (_, k) => `message ${k} ${'x'.repeat(420)}`) }));
  const verdict = await service.mindStale({ id: 'p' }, { kind: 'source', rows });
  assert.ok(calls.length > 1 && calls.reduce((sum, n) => sum + n, 0) === 6, `${calls} questions over several calls: every one of the six rows is asked about`);
  // "Source": the question is whether the note is still supported; the second row of every call is answered "no" (0.05): stale.
  assert.deepEqual(verdict.stale, calls.reduce((rows, n, call) => { const at = calls.slice(0, call).reduce((sum, m) => sum + m, 0); return n > 1 ? [...rows, at + 1] : rows; }, []), 'the indices are the caller\'s own, offset by the calls before');
  assert.equal(verdict.ledgerId, 'l1'); assert.equal(verdict.ledgerIds.length, calls.length);
  // One call that is not answered: the whole set is tried again later, not half of it applied.
  Object.assign(service, { decide: async input => (calls.push(0), input.assessmentPlan.questions.stale_0 && calls.length % 2 ? null : { point: 'mind.judge', source: 'judge', backend: 'typesafe', ledgerId: 'x', mode: 'active', answers: { stale_0: { type: 'boolean', probability: .9 } } }) });
  assert.equal(await service.mindStale({ id: 'p' }, { kind: 'source', rows }), null);
});

test('a lesson the user confirmed in another conversation is mixed, not derived: rewinding the message it came from keeps it (and the rule it grew), and strips only the excerpt of what left', async t => {
  const f = setup(t);
  const A = f.session.id, B = f.other.id, RAW = 'RAW-EXCERPT-OF-THE-REWOUND-MESSAGE-用户原话';
  let kept, wholly;
  f.change(project => {
    kept = addLesson(project.mind, { kind: 'preference', text: 'Always answer in three bullets.', source: mindSource('user', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: RAW, at: iso(NOW) }, { sessionId: B, itemId: 'b-again', excerpt: 'said again in another conversation', at: iso(NOW) }] }, { now: NOW }).id;
    wholly = addLesson(project.mind, { kind: 'preference', text: 'Keep paragraphs long.', source: mindSource('user', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: RAW, at: iso(NOW) }] }, { now: NOW }).id;
  });
  let result;
  f.store.mutate(state => { result = withdrawSources(state, state.projects.find(row => row.id === f.project.id), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound', now: NOW }); });
  const row = id => f.current().mind.lessons.find(item => item.id === id);
  assert.equal(row(kept).status, 'active', 'it stands on the user having said it again elsewhere');
  assert.equal(row(kept).evidence[0].excerpt, undefined, 'the passage of the removed message is gone'); assert.equal(row(kept).evidence[1].excerpt, 'said again in another conversation');
  assert.equal(row(wholly).status, 'retired', 'a lesson that rested wholly on the removed message is retired as before');
  assert.deepEqual(f.entries('lesson_revoked').map(entry => entry.lessonId), [wholly], 'so only that one is a lesson revocation (nothing of the mixed lesson\'s rule is touched)');
  assert.deepEqual(result.violations, [], 'the assertion treats the mixed lesson as standing, not as derived');
  // Privacy scope: the same split for the actions of a scope that no longer holds.
  let privacy;
  f.change(project => { privacy = addLesson(project.mind, { kind: 'preference', text: 'Concluded from the old scope.', source: mindSource('background', { actionId: 'act-1' }), evidence: [{ actionId: 'act-1', excerpt: 'old scope passage', at: iso(NOW) }, { sessionId: B, itemId: 'b-user', excerpt: 'the user also said it', at: iso(NOW) }] }, { now: NOW }).id; });
  f.store.mutate(state => { withdrawSources(state, state.projects.find(row => row.id === f.project.id), sourceScope({ actionIds: ['act-1'] }), { mode: 'privacy', now: NOW }); });
  assert.equal(row(privacy).status, 'active'); assert.equal(row(privacy).evidence[0].excerpt, undefined);
});

test('no passage of a revoked message is copied into the revocation entry, also when the entry fails and stays: it holds fingerprints, and the assertion scans the outbox', async t => {
  const f = setup(t);
  const A = f.session.id, RAW = 'RAW-EXCERPT-OF-THE-REWOUND-MESSAGE-用户原话';
  let id, result;
  f.change(project => { id = addLesson(project.mind, { kind: 'preference', text: 'Always answer in three bullets.', source: mindSource('user', { sessionId: A, itemId: 'a-gone' }), evidence: [{ sessionId: A, itemId: 'a-gone', excerpt: RAW, at: iso(NOW) }] }, { now: NOW }).id; });
  f.store.mutate(state => { result = withdrawSources(state, state.projects.find(row => row.id === f.project.id), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound', now: NOW }); });
  const entry = f.entries('lesson_revoked')[0];
  assert.deepEqual(entry.link.quoteKeys, [quoteKey(RAW)], 'the fingerprint of the passage, so the rules grown from it are still found');
  assert.ok(!JSON.stringify(f.current().mind.revocations).includes('RAW-EXCERPT'), 'the entry holds no passage, before it settles or if it never does');
  assert.deepEqual(result.violations, []);
  // The assertion is what keeps it that way: a passage in the outbox is a violation, and so is an entry that holds readable quotes.
  f.change(project => { project.mind.revocations[0].link.quotes = [RAW]; });
  assert.deepEqual(assertRevoked(f.current(), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound' }).map(row => [row.collection, row.why]), [['revocations', 'excerpt_in_revocation']]);
  assert.deepEqual(assertRevoked(f.current(), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound', excerpts: [RAW] }).map(row => row.why), ['excerpt_in_revocation']);
  f.change(project => { delete project.mind.revocations[0].link.quotes; project.mind.revocations[0].candidates = [{ list: 'facts', id: RAW }]; });
  assert.deepEqual(assertRevoked(f.current(), sourceScope({ sessionId: A, itemIds: ['a-gone'], turnIds: [] }), { mode: 'rewound', excerpts: [RAW] }).map(row => row.why), ['excerpt_in_revocation'], 'wherever in the entry it sits');
  assert.equal(id.length > 0, true);
});

test('the assertion catches what a first pass missed: a withdrawn row whose link a later writer re-added is withdrawn again; one that cannot be is reported, never thrown', t => {
  const f = setup(t);
  const A = f.session.id;
  f.change(project => { addNote(project.mind, 'facts', '旧的笔记', [{ sessionId: A, itemId: 'x1' }]); });
  const project = f.current(), scope = sourceScope({ sessionId: A });
  assert.deepEqual(assertRevoked(project, scope).map(row => [row.collection, row.why]), [['notes.facts', 'live_row_derived_from_scope']], 'a live note wholly derived from the scope is a violation');
  assert.deepEqual(assertRevoked({ ...project, genes: { genes: [{ id: 'g1', origin: { kind: 'correction', sessionId: A, itemId: 'x1', quote: SECRET } }], reviews: [{ id: 'r1', sessionId: A, itemId: 'x1' }] } }, scope).filter(row => row.subsystem === 'genes').map(row => row.why).sort(), ['origin_link_left', 'review_of_scope_left']);
  assert.deepEqual(assertRevoked(project, sourceScope({ sessionId: 'someone-else' })), [], 'nothing else is in scope');
});

// ----------------------------------------------------------------- privacy_revoked
test('privacy_revoked: what the revoked actions left in the mind is withdrawn (lessons retired, text stripped), the entry names the actions as source ids, and the conversations fold their copies once', async t => {
  const f = setup(t);
  let lessonId, planId, keepId, noteId2;
  f.change(project => {
    const mind = project.mind;
    lessonId = addLesson(mind, { kind: 'preference', text: '旧范围里得出的结论', source: mindSource('background', { actionId: 'act-1' }), evidence: [{ actionId: 'act-1', excerpt: SECRET, at: iso(NOW) }] }, { now: NOW }).id;
    planId = addAgenda(mind, { kind: 'todo', text: SECRET, source: mindSource('background', { actionId: 'act-1' }), evidence: [] }, { now: NOW }).id;
    keepId = addAgenda(mind, { kind: 'todo', text: '另一个动作的计划', source: mindSource('background', { actionId: 'act-2' }) }, { now: NOW }).id;
    noteId2 = addNote(mind, 'facts', '与动作无关的笔记').id;
  });
  let result;
  f.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); result = withdrawSources(state, project, sourceScope({ actionIds: ['act-1'] }), { mode: 'privacy', now: NOW }); });
  assert.deepEqual(result.violations, []);
  const mind = f.current().mind;
  assert.equal(lessonRow(f, lessonId).status, 'retired'); assert.equal(lessonRow(f, lessonId).evidence[0].excerpt, undefined, 'the old scope\'s excerpt is gone');
  assert.equal(mind.agenda.find(row => row.id === planId).status, 'dropped'); assert.equal(mind.agenda.find(row => row.id === planId).text, '（来源已撤销）');
  assert.equal(mind.agenda.find(row => row.id === keepId).status, 'open', 'another action\'s plan is untouched'); assert.ok(mind.notes.facts.find(row => row.id === noteId2));
  const entry = f.entries('privacy_revoked')[0];
  assert.deepEqual(entry.actionIds, ['act-1']); assert.deepEqual(entry.context, { keys: Object.values(MIND_CONTEXT_KEYS), sourceIds: ['action:act-1'] });
  assert.equal(f.entries('lesson_revoked')[0].cause, 'privacy_revoked', 'the lesson it retired takes back what grew from it, and says it was the scope, not the user revoking the lesson');
  await f.dispatcher.idle();
  assert.ok(!readStateText(f.file).includes(SECRET));
  // Each conversation of the project is asked to fold its copies once.
  const session = f.current(), conversation = f.store.state.sessions.find(row => row.id === f.session.id);
  const asked = contextRevocationsFor(session, conversation);
  assert.equal(asked.length, 1); assert.deepEqual(asked[0].contextKeys, Object.values(MIND_CONTEXT_KEYS)); assert.deepEqual(asked[0].sourceIds, ['action:act-1']); assert.ok(asked[0].before > Date.parse(entry.at), 'copies made after the revocation are new material');
  f.store.mutate(state => markContextRevoked(state.sessions.find(row => row.id === f.session.id), [asked[0].id]));
  assert.deepEqual(contextRevocationsFor(f.current(), f.store.state.sessions.find(row => row.id === f.session.id)), [], 'applied: not asked again');
  assert.equal(contextRevocationsFor(f.current(), f.store.state.sessions.find(row => row.id === f.other.id)).length, 1, 'another conversation has its own application');
  assert.deepEqual(contextRevocationsFor(null, null), []);
});

// ------------------------------------------------------------------ tool_withdrawn
test('tool_withdrawn: the notes, plan items and lessons nearest the withdrawn tools are judged in one call, with what is left available; a stale lesson stops being a rule', async t => {
  const f = setup(t, { judge: input => ({ stale: input.rows.map((row, index) => /prose_reword/.test(row.text) ? index : -1).filter(index => index >= 0) }) });
  let note, plan, lesson, fine;
  f.change(project => {
    const mind = project.mind;
    note = addNote(mind, 'facts', '重写流程：prose_draft → prose_reword（passes 2）→ prose_check').id; plan = addAgenda(mind, { kind: 'todo', text: '用 prose_reword 换说法' }, { now: NOW }).id;
    lesson = addLesson(mind, { kind: 'preference', text: '最后一步一律用 prose_reword 换说法' }, { now: NOW }).id; fine = addLesson(mind, { kind: 'preference', text: '写完用 prose_check 自查' }, { now: NOW }).id;
    project.versions = [{ id: 'v1', generatedTools: [{ toolName: 'prose_check' }, { toolName: 'prose_draft' }], generatedSkills: [{ name: 'novel-forge' }] }]; project.activeVersionId = 'v1';
  });
  f.dispatcher.dispatch({ type: 'tool_withdrawn', projectId: f.project.id, tools: [{ kind: 'guard', id: 'prose_reword', name: 'prose_reword', description: '换说法检查' }] });
  await f.dispatcher.idle();
  const asked = f.calls.stale[0];
  assert.equal(asked.kind, 'tool'); assert.deepEqual(asked.tools.withdrawn, ['prose_reword: 换说法检查']); assert.deepEqual(asked.tools.available, ['prose_check', 'prose_draft', 'novel-forge']);
  assert.equal(f.calls.stale.length, 1); assert.equal(f.calls.genes.length, 1, 'the genes handler hears of it too');
  const mind = f.current().mind;
  assert.equal(mind.notes.facts.find(row => row.id === note).stale.reason, 'tool_withdrawn'); assert.deepEqual(mind.notes.facts.find(row => row.id === note).stale.tools, ['prose_reword']);
  assert.equal(mind.agenda.find(row => row.id === plan).stale.reason, 'tool_withdrawn'); assert.ok(mind.lessons.find(row => row.id === lesson).stale);
  assert.equal(mind.lessons.find(row => row.id === fine).stale, undefined, 'a lesson that names a tool still there is kept');
  const project = f.current();
  assert.ok(!selectLessons(project, '换说法', { now: NOW }).always.some(row => row.id === lesson) && !selectLessons(project, '换说法', { now: NOW }).candidates.some(row => row.id === lesson), 'a stale lesson is not sent to the model');
  assert.ok(publicMind(project, { now: NOW }).lessons.find(row => row.id === lesson).stale, 'the mind page shows it');
  // Editing it says it holds (the user rewrote the instruction); the lesson comes back.
  f.change(draft => patchMindEntry(draft, 'lessons', lesson, { text: '最后一步用 prose_check 自查' }, { now: NOW }));
  assert.equal(lessonRow(f, lesson).stale, undefined);
});

// ---------------------------------------------------------------- change_reverted
test('change_reverted: rows reopened because the user undid the work that settled them are an event the dispatcher settles (the mind\'s own settle), naming the undoing apply record; the assertion finds nothing left settled by the undone work', async t => {
  const f = setup(t);
  let commit;
  f.change(project => {
    const mind = project.mind;
    commit = addCommitment(mind, { request: '把第三章改短', trigger: 'user_request', source: mindSource('capture', { sessionId: f.session.id, itemId: 'u-1' }) }, { now: NOW - 5 * 3600000 }).id;
    project.backgroundChanges = [{ id: 'ch1', actionId: 'act-1', status: 'kept', applyId: 'ap1', applyIds: ['ap1'] }];
    Object.assign(mind.commitments[0], { status: 'resolved', resolvedBy: { kind: 'action', actionId: 'act-1', at: iso(NOW - 3600000) } });
  });
  assert.deepEqual(f.mind.settleOutcomes(), [], 'applied while nothing is undone: no change');
  assert.equal(f.entries('change_reverted').length, 0);
  const handler = f.mind.revocationHandler();
  // The user undid the work: before the reopening the assertion would find the row still settled by it (the check has teeth).
  f.change(project => { project.backgroundChanges[0].status = 'reverted'; project.backgroundChanges[0].discarded = true; });
  assert.deepEqual(handler.assert({ type: 'change_reverted' }, { project: () => f.current() }).map(row => [row.id, row.why]), [[commit, 'settled_by_undone_change']]);
  f.mind.settleOutcomes();
  assert.equal(f.current().mind.commitments.find(row => row.id === commit).status, 'pending', 'owed again');
  const logged = f.entries('change_reverted');
  assert.equal(logged.length, 1); assert.deepEqual(logged[0].ids, [commit]); assert.deepEqual(logged[0].applies, ['ap1'], 'the undoing apply record, by id');
  assert.equal(logged[0].settledAt, undefined, 'logged unsettled: the dispatcher runs the mind\'s settle and assertion for it, as for every other type');
  await f.dispatcher.idle();
  const done = f.entries('change_reverted')[0];
  assert.ok(done.settledAt); assert.equal(done.steps.mind, 'done', 'the mind handler\'s settle ran'); assert.deepEqual(done.result.mind, { reopened: 0 }, 'nothing more to reopen'); assert.equal(done.result.violations, 0, 'and its assertion ran: nothing left settled by the undone work');
  assert.deepEqual(handler.assert(logged[0], { project: () => f.current() }), [], 'nothing settled by the undone work remains');
  assert.deepEqual(handler.settle({ type: 'change_reverted' }, {}), { reopened: 0 });
  assert.ok(handler.events.includes('change_reverted'));
});

test('typed lesson link: a deleted lesson is still found by what it left (message, quotes, route) after its row is gone', t => {
  const f = setup(t);
  let id, link;
  f.change(project => { const lesson = addLesson(project.mind, { kind: 'constraint', text: '正文不要出现守夜', source: mindSource('correction', { itemId: 'm1' }), evidence: [{ itemId: 'm1', excerpt: '正文不要出现守夜', at: iso(NOW) }] }, { now: NOW }); lesson.geneRoute = { geneId: 'guard:g' }; id = lesson.id; link = lessonLink(lesson); });
  // The quote is kept as a fingerprint, never as text: an entry that outlives its revocation (failed, backing off) holds no passage of the message.
  assert.deepEqual(link, { id, itemId: 'm1', quoteKeys: [quoteKey('正文不要出现守夜')], geneId: 'guard:g' });
  assert.ok(link.quoteKeys[0] && !JSON.stringify(link).includes('守夜'), 'nothing readable');
  const project = { genes: { genes: [{ id: 'guard:g', layer: 'guard', status: 'active', origin: { kind: 'lesson', lessonId: id } }, { id: 'skill-patch:p', layer: 'skill', status: 'trial', origin: { kind: 'correction', itemId: 'm1' } }, { id: 'skill-patch:o', layer: 'skill', status: 'trial', origin: { kind: 'correction', itemId: 'other' } }] } };
  assert.deepEqual(grownGenes(project, link).map(row => row.id).sort(), ['guard:g', 'skill-patch:p'], 'found without the lesson row');
  assert.deepEqual(grownGenes(project, null), []);
});

test('createMindEntry and the mind API keep their behaviour: a user-authored lesson writes no revocation, and a PATCH that is not a revoke or a rewrite neither', t => {
  const f = setup(t);
  let lessonId;
  f.change(project => { lessonId = createMindEntry(project, 'lessons', { text: '回复简短', kind: 'preference' }, { now: NOW }).id; });
  f.change(project => patchMindEntry(project, 'lessons', lessonId, { scope: 'user' }, { now: NOW }));
  f.change(project => patchMindEntry(project, 'lessons', lessonId, { status: 'retired' }, { now: NOW }));
  f.change(project => patchMindEntry(project, 'lessons', lessonId, { status: 'active' }, { now: NOW }));
  assert.equal(f.entries().length, 1, 'only the revoke');
  assert.equal(lessonRow(f, lessonId).revocation, undefined, 'turning the lesson back on forgets the revocation marker');
  assert.equal(f.dispatcher.sweep(), 0, 'and the audit has nothing to find');
});
