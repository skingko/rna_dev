import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { Store } from '../store.mjs';
import { SessionDeletionService, publicSessionDeletions } from '../session-deletion.mjs';
import { readStateText } from '../state-shards.mjs';
import { lessonGene, planView } from '../project-mind.mjs';
import { sourceScope, revokeMindSources, revokeGeneSources } from '../source-revocation.mjs';
import { captureSessionEvidence, scrubSessionEvidence } from '../session-evidence-cleanup.mjs';
import { applyConversationMembership } from '../project-initiative-controller.mjs';
import { planMemoryEvidence, memoryEvidenceDocument, memoryEvidenceWithdrawn } from '../memory-evidence-outbox.mjs';

// Deleting a conversation reaches what was derived from it (review MIND-8, X-6) and can always finish or say why it
// cannot (X-1, X-3): pending requests and open plan items it left stop steering, its quotes leave the mind and the
// genes, a deleted project's runs never block its conversations' deletion, and its run files go once they settled.

const SECRET = 'PRIVATE-REQUEST-请把第三十章改成第一人称';
const QUOTE = 'PRIVATE-CORRECTION-你参考的内容太少了';
const until = async (check, label, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); } };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-delete-sources-')), file = join(dir, 'state.json'), store = new Store(file);
  const { project, session } = store.createProject({ name: 'Sources', workspace: dir });
  const other = store.createSession({ projectId: project.id });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A background run that read this conversation through its prompt snapshot and stopped mid project_exec.
  const journal = (actionId, { source = session.id, pending = true } = {}) => {
    const stateDir = join(`${file}.rna`, 'initiative', project.id, actionId), handle = openJournal({ stateDir, sessionId: actionId, projectId: project.id });
    handle.append('inbox_added', { item: { context: [{ source: 'project-evidence', text: JSON.stringify({ project: { recentConversation: [{ sessionId: source, id: source === session.id ? 'message-one' : 'other-message', text: 'context' }] }, evidence: [] }) }] } });
    if (pending) { handle.append('tool_intent', { callKey: 'call-1', toolName: 'project_exec', arguments: { command: 'make' }, effect: 'write', idempotent: false }); handle.append('tool_uncertain', { callKey: 'call-1', code: 'cleanup_uncertain' }); }
    handle.close();
    return stateDir;
  };
  const seedRun = (id, extra = {}) => store.mutate(state => {
    const p = state.projects.find(row => row.id === project.id);
    p.initiativeRuntime = { sdkState: { usedTokens: 0, reservedTokens: 0, events: [], actions: [...(p.initiativeRuntime?.sdkState?.actions ?? []), { id, action: 'work', status: 'needs_review', blocksExecution: true, errorCode: 'uncertain_tool', evidenceIds: [], content: 'run', ...extra }] } };
  });
  store.mutate(state => { state.sessions.find(row => row.id === session.id).items.push({ id: 'message-one', kind: 'user', text: SECRET, createdAt: new Date().toISOString() }); });
  return { dir, file, store, project, session, other, journal, seedRun };
}

test('deleting a conversation withdraws its requests, plan items, quotes and cards from the mind and the genes; lesson text stays', async t => {
  const f = fixture(t), A = f.session.id, B = f.other.id, at = new Date().toISOString();
  f.store.mutate(state => {
    const p = state.projects.find(row => row.id === f.project.id);
    p.mind = { schemaVersion: 1, lessons: [
      { id: 'lesson-a', kind: 'constraint', text: '至少读完 30 章再动笔', status: 'active', source: { kind: 'correction', sessionId: A, itemId: 'message-one' }, evidence: [{ sessionId: A, itemId: 'message-one', excerpt: QUOTE, at }], uses: { recalled: 0, applied: 0, contradicted: 0 }, createdAt: at, updatedAt: at },
    ], agenda: [
      { id: 'plan-a', kind: 'todo', stage: 'next', status: 'open', text: `接着完成：${SECRET}`, source: { kind: 'turn', sessionId: A, turnId: 'turn-a' }, evidence: [], createdAt: at, updatedAt: at, interaction: { sessionId: B, interactionId: 'card-1', itemId: 'card-item', askedAt: at } },
      { id: 'plan-done-a', kind: 'todo', status: 'done', text: `已完成：${SECRET}`, source: { kind: 'turn', sessionId: A, turnId: 'turn-a' }, evidence: [], createdAt: at, updatedAt: at },
      { id: 'mixed', kind: 'awaiting_user', status: 'open', text: '等你选定视角', source: { kind: 'capture', sessionId: B, itemId: 'b-1' }, evidence: [{ sessionId: A, itemId: 'message-one', excerpt: SECRET, at }, { sessionId: B, itemId: 'b-1', excerpt: 'keep this quote', at }], createdAt: at, updatedAt: at },
    ], commitments: [
      { id: 'owed-a', request: SECRET, trigger: 'user_request', status: 'pending', overdueAt: at, source: { kind: 'capture', sessionId: A, itemId: 'message-one' }, evidence: [{ sessionId: A, itemId: 'message-one', excerpt: SECRET, at }], createdAt: at, updatedAt: at },
      { id: 'owed-b', request: 'keep the other request', trigger: 'user_request', status: 'pending', overdueAt: at, source: { kind: 'capture', sessionId: B, itemId: 'b-1' }, evidence: [], createdAt: at, updatedAt: at },
    ], findings: [], threads: [], notes: { facts: [{ id: 'note-a', text: SECRET, source: { kind: 'capture', sessionId: A, itemId: 'message-one' } }, { id: 'note-plain', text: 'keep unlinked note' }], preferences: [], updatedAt: at }, health: null, migratedAt: at };
    p.genes = { genes: [
      { id: 'skill-patch:a', layer: 'skill', status: 'active', title: 'Read enough first', origin: { kind: 'correction', quote: QUOTE, sessionId: A, itemId: 'message-one' } },
      { id: 'skill-patch:b', layer: 'skill', status: 'active', title: 'Other rule', origin: { kind: 'correction', quote: 'keep the other quote', sessionId: B, itemId: 'b-1' } },
    ], generations: [] };
    const other = state.sessions.find(row => row.id === B);
    other.items.push({ id: 'card-item', kind: 'question', source: 'interaction', interaction: { id: 'card-1', kind: 'question', source: 'initiative', status: 'pending', questions: [{ id: 'answer', header: '议程需要你定', question: `议程里的「${SECRET}」接下来怎么处理？`, options: [{ id: 'done', label: '已完成' }] }] } });
    other.invitations = [{ id: 'inv-a', kind: 'commitment', subject: 'commitment:owed-a', commitmentId: 'owed-a', text: SECRET, createdAt: at }, { id: 'inv-b', kind: 'commitment', subject: 'commitment:owed-b', commitmentId: 'owed-b', text: 'keep', createdAt: at }];
  });
  f.store.deleteSession(A);
  const project = f.store.state.projects.find(row => row.id === f.project.id), mind = project.mind;
  const row = id => [...mind.agenda, ...mind.commitments, ...mind.lessons].find(entry => entry.id === id);
  assert.equal(row('owed-a').status, 'dismissed'); assert.equal(row('owed-a').sourceDeleted, true); assert.ok(!row('owed-a').request.includes(SECRET));
  assert.equal(row('owed-b').status, 'pending'); assert.equal(row('owed-b').request, 'keep the other request');
  assert.equal(row('plan-a').status, 'dropped'); assert.ok(!row('plan-a').text.includes(SECRET));
  assert.equal(row('mixed').status, 'open', 'only one of its evidence entries came from the deleted conversation');
  assert.deepEqual(row('mixed').evidence.map(entry => [entry.itemId, entry.excerpt]), [['message-one', undefined], ['b-1', 'keep this quote']]);
  assert.equal(row('lesson-a').status, 'active'); assert.equal(row('lesson-a').text, '至少读完 30 章再动笔', 'extracted lessons are kept, as the deletion notice promises');
  assert.deepEqual(row('lesson-a').evidence[0].itemId, 'message-one'); assert.equal(row('lesson-a').evidence[0].excerpt, undefined);
  assert.deepEqual(planView(mind).done, [], 'a finished item of the deleted conversation is no longer shown to the model');
  assert.deepEqual(mind.notes.facts.map(note => note.id), ['note-plain'], 'notes with a source link in the conversation go');
  // Its open card in another conversation is cancelled and loses the quote; its invitation closes; others stay.
  const other = f.store.state.sessions.find(entry => entry.id === B), card = other.items.find(item => item.id === 'card-item').interaction;
  assert.equal(card.status, 'cancelled'); assert.equal(card.cancelReason, 'source_removed'); assert.ok(!card.questions[0].question.includes(SECRET));
  assert.deepEqual(other.invitations.map(entry => entry.id), ['inv-b']); assert.equal(other.invitationHistory.at(-1).outcome, 'expired');
  // Genes keep working, without the user's quote or the message's ids; the lesson still finds the rule carrying it.
  const [gene, kept] = project.genes.genes;
  assert.equal(gene.status, 'active'); assert.equal(gene.origin.quote, undefined); assert.equal(gene.origin.sessionId, undefined); assert.equal(gene.origin.itemId, undefined);
  assert.equal(gene.origin.sourceRemoved, 'session_deleted'); assert.equal(gene.origin.lessonId, 'lesson-a');
  assert.equal(lessonGene(project, row('lesson-a'))?.id, 'skill-patch:a');
  assert.deepEqual(kept.origin, { kind: 'correction', quote: 'keep the other quote', sessionId: B, itemId: 'b-1' });
  const service = new SessionDeletionService(f.store); t.after(() => service.close());
  assert.equal((await service.wait(A)).status, 'completed');
  const text = readStateText(f.file);
  assert.equal(text.includes(SECRET), false); assert.equal(text.includes(QUOTE), false);
});

test('rewind shares the matcher: what the removed messages left is withdrawn and their quotes leave mind and genes', () => {
  const at = new Date().toISOString(), state = { settings: { interfaceLanguage: 'en' }, sessions: [{ id: 's', projectId: 'p', invitations: [{ id: 'inv', kind: 'lesson', subject: 'lesson:l1', lessonId: 'l1', createdAt: at }] }] };
  const project = { id: 'p', mind: { lessons: [{ id: 'l1', kind: 'preference', text: 'short replies', status: 'active', source: { kind: 'capture', sessionId: 's', itemId: 'gone' }, evidence: [{ sessionId: 's', itemId: 'gone', excerpt: QUOTE }] }, { id: 'l2', kind: 'preference', text: 'kept', status: 'active', source: { kind: 'capture', sessionId: 's', itemId: 'kept' }, evidence: [{ sessionId: 's', itemId: 'kept', excerpt: 'kept quote' }] }],
    agenda: [{ id: 'a1', status: 'open', text: 'from removed turn', source: { sessionId: 's', turnId: 't-gone' }, evidence: [] }], commitments: [] },
    genes: { genes: [{ id: 'g1', origin: { kind: 'correction', quote: QUOTE, sessionId: 's', itemId: 'gone' } }, { id: 'g2', origin: { kind: 'correction', quote: 'kept quote', sessionId: 's', itemId: 'kept' } }, { id: 'g3', origin: { kind: 'lesson', lessonId: 'l2', quote: 'kept' } },
      { id: 'g4', origin: { kind: 'contrast', quote: `${QUOTE} / another turn`, turns: 2, sources: [{ sessionId: 's', turnId: 't-gone', itemId: 'x' }, { sessionId: 'other', turnId: 't-other', itemId: 'y' }] } }] } };
  const scope = sourceScope({ sessionId: 's', itemIds: ['gone'], turnIds: ['t-gone'] });
  const result = revokeMindSources(state, project, scope, { mode: 'rewound' });
  assert.equal(result.withdrawn, 2);
  assert.deepEqual(project.mind.lessons.map(row => [row.status, row.evidence[0].excerpt]), [['retired', undefined], ['active', 'kept quote']]);
  assert.equal(project.mind.agenda[0].status, 'dropped'); assert.equal(project.mind.agenda[0].reason, 'Its source message was edited or deleted'); assert.equal(project.mind.agenda[0].text, 'from removed turn', 'a rewind keeps the withdrawn text');
  assert.deepEqual(state.sessions[0].invitations, []);
  assert.equal(revokeGeneSources(project, scope, { mode: 'rewound' }), 2);
  assert.deepEqual(project.genes.genes.map(row => row.origin.quote), [undefined, 'kept quote', 'kept', undefined]);
  assert.equal(project.genes.genes[0].origin.sourceRemoved, 'message_rewound');
  assert.deepEqual(project.genes.genes[3].origin.sources, [{ sessionId: 'other', turnId: 't-other', itemId: 'y' }], 'a contrast rule loses the joined quote and the removed turn, keeping the others');
  assert.equal(revokeGeneSources(project, scope, { mode: 'rewound' }), 0, 'repeating changes nothing');
});

test('a deleted project resolves its uncertain runs first, so its conversation finishes deleting and its run files go', async t => {
  const f = fixture(t), linked = f.journal('run-uncertain'), unrelated = f.journal('run-other', { source: 'someone-else', pending: false });
  f.seedRun('run-uncertain');
  const roots = [join(`${f.file}.archive`, 'initiative', f.project.id, 'actions'), join(`${f.file}.archive`, 'learning', f.project.id, 'reviews'), join(`${f.file}.skill-foundation`, f.project.id, 'operation')];
  // Content-addressed receipts, as Store.archiveRecords writes them.
  for (const dir of roots) { mkdirSync(dir, { recursive: true }); const text = JSON.stringify({ id: 'unrelated-receipt' }); writeFileSync(join(dir, `${createHash('sha256').update(text).digest('hex')}.json`), text); }
  mkdirSync(join(`${f.file}.rna`, f.other.id), { recursive: true }); writeFileSync(join(`${f.file}.rna`, f.other.id, 'chat.jsonl'), 'kept until its own cleanup');
  let cancelled = null; f.store.onProjectDeleting(id => { cancelled = { id, present: f.store.state.projects.some(row => row.id === id) }; });
  f.store.deleteProject(f.project.id);
  assert.deepEqual(cancelled, { id: f.project.id, present: true }, 'run handles are cancelled before the project state goes');
  const record = f.store.state.sessionDeletions.find(row => row.sessionId === f.session.id);
  assert.ok(record.evidence.resolvedActionIds.includes('run-uncertain'), 'the host resolution is captured with the deletion record');
  const service = new SessionDeletionService(f.store); t.after(() => service.close());
  assert.deepEqual(await service.wait(f.session.id), { status: 'completed', localStatus: 'completed', remoteStatus: 'not_required', code: null, retryAt: null });
  assert.equal((await service.wait(f.other.id)).status, 'completed');
  await service.close();
  assert.equal(existsSync(linked), false); assert.equal(existsSync(unrelated), false, 'the project run root goes once its deletions settled');
  for (const dir of roots) assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(`${f.file}.rna`, 'initiative')), true, 'only the project folder under the namespace is removed');
});

test('the stuck deletion of a conversation whose project was deleted earlier finishes: its runs are host-resolved (project_deleted)', async t => {
  const f = fixture(t), linked = f.journal('run-uncertain');
  f.seedRun('run-uncertain');
  // As it was live: the conversation deleted, then its project removed by an older release without any resolution.
  f.store.deleteSession(f.session.id);
  f.store.mutate(state => {
    state.projects = state.projects.filter(row => row.id !== f.project.id); state.sessions = state.sessions.filter(row => row.projectId !== f.project.id);
    Object.assign(state.sessionDeletions.find(row => row.sessionId === f.session.id), { code: 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED', attempts: 1379, retryAt: new Date(Date.now() - 1000).toISOString() });
  });
  assert.equal(f.store.state.sessionDeletions[0].evidence.resolvedActionIds.includes('run-uncertain'), false);
  const service = new SessionDeletionService(f.store); t.after(() => service.close());
  await until(() => f.store.state.sessionDeletions[0].status === 'completed', 'the stuck record completes');
  const record = f.store.state.sessionDeletions[0];
  assert.deepEqual(record.evidence.hostResolvedActionIds, ['run-uncertain']); assert.equal(record.evidence.hostResolution, 'project_deleted');
  assert.equal(record.attempts, 1379); assert.equal(existsSync(linked), false);
  await service.close(); assert.equal(existsSync(join(`${f.file}.rna`, 'initiative', f.project.id)), false);
});

test('an unconfirmed run of a live project blocks the deletion visibly until the user resolves it, then it continues by itself', async t => {
  const f = fixture(t), linked = f.journal('run-uncertain');
  f.seedRun('run-uncertain');
  f.store.deleteSession(f.session.id);
  const service = new SessionDeletionService(f.store, { intervalMs: 20 }); t.after(() => service.close());
  const status = await service.wait(f.session.id);
  assert.equal(status.status, 'blocked'); assert.equal(status.code, 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'); assert.equal(status.retryAt, null); assert.equal(status.decision, 'execution');
  assert.match(status.notice, /后台工作/);
  f.store.interfaceLanguage('en');
  const [row] = publicSessionDeletions(f.store.state);
  assert.equal(row.status, 'blocked'); assert.equal(row.decision, 'execution'); assert.match(row.notice, /Confirm its result/);
  // No timer reruns it, and unrelated changes do not either.
  const attempts = f.store.state.sessionDeletions[0].attempts;
  for (let i = 0; i < 5; i++) { f.store.mutate(state => { state.settings.touched = i; }); await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.equal(f.store.state.sessionDeletions[0].attempts, attempts); assert.equal(existsSync(linked), true);
  // The user confirms the run's outcome: the deletion continues on its own.
  f.store.mutate(state => { Object.assign(state.projects[0].initiativeRuntime.sdkState.actions[0], { status: 'cancelled', resolvedAt: Date.now(), resolutionSource: 'user', blocksExecution: false }); });
  await until(() => f.store.state.sessionDeletions[0].status === 'completed', 'the resolved record completes');
  assert.equal(existsSync(linked), false); assert.equal(existsSync(join(`${f.file}.rna`, 'initiative', f.project.id)), true, 'a live project keeps its run root');
});

test('deleting a conversation an archive had withdrawn from still revokes the shares it fed, and so does a legacy share whose citations were wiped: their delivery documents are withdrawn (X1)', () => {
  for (const variant of ['delete only', 'archive then delete', 'legacy share']) {
    const at = new Date().toISOString();
    const A = { id: 'conv-a', projectId: 'proj', items: [{ id: 'm1', kind: 'user', text: SECRET, createdAt: at }], turns: [] };
    const B = { id: 'conv-b', projectId: 'proj', items: [{ id: 'd1', kind: 'assistant', source: 'initiative', turnId: null, simulated: false, createdAt: at, text: `Shared from the request: ${SECRET}`, initiativeActionId: 's1', evidenceIds: ['message:m1'] }], turns: [] };
    const share = { id: 's1', action: 'share', status: 'completed', content: `Shared from the request: ${SECRET}`, evidenceIds: ['message:m1'], intentKey: 's1', revision: 1 };
    const project = { id: 'proj', jobs: [], decisions: [], observations: [], initiativeRuntime: { sdkState: { events: [], seenEventIds: [], actions: [share] } } };
    const state = { projects: [project], sessions: [A, B], configuration: { memory: {} }, events: [] };
    B.memoryEvidenceState = planMemoryEvidence(state, B).state;
    const [write] = planMemoryEvidence(state, B, { connectionFingerprint: 'fixture', namespace: 'viking://resources/proj', now: Date.now() }).records;
    assert.match(memoryEvidenceDocument(state, B.id, write), /Shared from the request/, variant);
    if (variant === 'archive then delete') {
      A.archivedAt = at; applyConversationMembership(project.initiativeRuntime.sdkState, [A, B], [], Date.now());
      assert.deepEqual([share.revokedBy, share.evidenceIds], ['session_archived', []]);
    }
    if (variant === 'legacy share') Object.assign(share, { evidenceIds: [], contextRevoked: true, content: 'Previous project scope; retained only as an action receipt.' });
    // An archive or a drift revocation is not a deletion: memory keeps the delivery.
    assert.ok(memoryEvidenceDocument(state, B.id, write), variant);
    const evidence = captureSessionEvidence(state, A); state.sessions = [B];
    scrubSessionEvidence(state, { sessionId: A.id, projectId: 'proj', evidence });
    const receipt = project.initiativeRuntime.sdkState.actions.find(row => row.id === 's1');
    assert.equal(receipt.sourceDeleted, true, variant); assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET), variant);
    assert.throws(() => memoryEvidenceDocument(state, B.id, write), { code: 'MEMORY_SOURCE_CHANGED' }, variant);
    assert.equal(memoryEvidenceWithdrawn(state, B.id, write), true, variant);
  }
});

test('D2-2: a reconcile verdict or an answer that quoted a deleted or rewound message keeps no quote in the row’s reason', () => {
  const at = new Date().toISOString(), QUOTED = '对话中已有答复或结果：「我的银行卡尾号 6411，已经给财务发过邮件了」';
  const project = () => ({ id: 'p', mind: { lessons: [], agenda: [
    { id: 'a-reconciled', kind: 'todo', status: 'done', text: '核对报销', reason: QUOTED, resolvedBy: { kind: 'reconcile', sessionId: 'B', itemId: 'b-7', at }, evidence: [{ sessionId: 'B', itemId: 'b-7', excerpt: '我的银行卡尾号 6411', at }] },
    { id: 'a-answered', kind: 'awaiting_user', status: 'dropped', text: '要不要做排行榜', reason: '不做了，我的手机号 13800000000 换了', answer: '不做了，我的手机号 13800000000 换了', resolvedBy: { kind: 'answer', sessionId: 'B', itemId: 'b-8', at }, evidence: [] },
    { id: 'a-other', kind: 'todo', status: 'done', text: '别的', reason: '已被后续工作取代：「另一个对话的话」', resolvedBy: { kind: 'reconcile', sessionId: 'C', itemId: 'c-1', at }, evidence: [] },
  ], commitments: [
    { id: 'c-reconciled', request: '把报销单发给财务', trigger: 'user_request', status: 'resolved', reason: QUOTED, resolvedBy: { kind: 'reconcile', sessionId: 'B', itemId: 'b-7', at }, evidence: [] },
  ] } });
  for (const [mode, scope, marker] of [['deleted', sourceScope({ sessionId: 'B' }), '(source conversation deleted)'], ['rewound', sourceScope({ sessionId: 'B', itemIds: ['b-7', 'b-8'], turnIds: [] }), '(source message edited or deleted)']]) {
    const state = { settings: { interfaceLanguage: 'en' }, sessions: [] }, target = project();
    revokeMindSources(state, target, scope, { mode });
    const row = id => [...target.mind.agenda, ...target.mind.commitments].find(entry => entry.id === id);
    for (const id of ['a-reconciled', 'a-answered', 'c-reconciled']) { assert.equal(row(id).reason, marker, `${mode} ${id}`); assert.equal(JSON.stringify(row(id)).includes('6411') || JSON.stringify(row(id)).includes('13800000000'), false, `${mode} ${id}`); }
    assert.equal(row('a-answered').answer, undefined);
    assert.equal(row('a-reconciled').status, 'done'); assert.equal(row('c-reconciled').status, 'resolved', 'what was settled stays settled');
    assert.equal(row('a-other').reason, '已被后续工作取代：「另一个对话的话」', 'another conversation is not in scope');
  }
});

test('D2-2 / D2-4: quotes kept from before sources were tracked leave on every start: reconcile passages, answers of deleted conversations, unlinked gene quotes', async t => {
  const f = fixture(t), at = new Date().toISOString(), live = f.session.id;
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === live);
    session.items.push({ id: 'corr-1', kind: 'user', text: '你参考的内容太少了，至少读完三十章', createdAt: at }, { id: 'req-2', kind: 'user', text: '人名  前后要一致', createdAt: at });
    const p = state.projects.find(row => row.id === f.project.id);
    p.mind = { schemaVersion: 1, lessons: [], findings: [], threads: [], notes: { facts: [], preferences: [], updatedAt: null }, agenda: [
      { id: 'kept-live', kind: 'todo', status: 'done', text: 't', reason: '对话中已有答复或结果：「人名前后要一致」', resolvedBy: { kind: 'reconcile', sessionId: live, itemId: 'req-2', at }, evidence: [] },
      { id: 'gone', kind: 'awaiting_user', status: 'dropped', text: 'q', reason: '我的住址是某某路 1 号', resolvedBy: { kind: 'answer', sessionId: 'deleted-session', itemId: 'x', at }, evidence: [] },
      { id: 'capacity', kind: 'todo', status: 'dropped', text: 'c', reason: 'capacity', evidence: [] },
    ], commitments: [
      { id: 'superseded', request: 'r', trigger: 'user_request', status: 'dismissed', reason: '已被后续工作取代：「第三十章已重写」', resolvedBy: { kind: 'reconcile', actionId: 'job-1', at }, evidence: [] },
    ] };
    p.genes = { generations: [], genes: [
      { id: 'skill-patch:correction', layer: 'skill', status: 'active', origin: { kind: 'correction', quote: '你参考的内容太少了，至少读完三十章' } },
      { id: 'skill-patch:contrast', layer: 'skill', status: 'active', origin: { kind: 'contrast', quote: '你参考的内容太少了，至少读完三十章 / 已删除对话里的一句话 / 人名 前后要一致', turns: 3 } },
      { id: 'skill-patch:gone', layer: 'skill', status: 'active', origin: { kind: 'contrast', quote: '只在已删除对话里出现过的话', turns: 1 } },
      { id: 'skill-merge:a', layer: 'skill', status: 'trial', summary: 'merged summary text', origin: { kind: 'contrast', quote: 'merged summary text' }, body: { mergedFrom: ['a', 'b'] } },
      { id: 'skill-patch:summary', layer: 'skill', status: 'active', summary: '写作前先列出要读的章节', origin: { kind: 'contrast', quote: '写作前先列出要读的章节', turns: 0 } },
      { id: 'skill-patch:linked', layer: 'skill', status: 'active', origin: { kind: 'correction', quote: 'already linked', sessionId: live, itemId: 'corr-1' } },
    ] };
  });
  // The next start (the Store constructor) cleans them.
  const reopened = new Store(f.file), project = reopened.state.projects.find(row => row.id === f.project.id);
  const row = id => [...project.mind.agenda, ...project.mind.commitments].find(entry => entry.id === id);
  assert.equal(row('kept-live').reason, '对话中已有答复或结果'); assert.equal(row('superseded').reason, '已被后续工作取代');
  assert.equal(row('gone').reason, '（来源对话已删除）'); assert.equal(row('capacity').reason, 'capacity');
  const gene = id => project.genes.genes.find(entry => entry.id === id).origin;
  assert.deepEqual(gene('skill-patch:correction'), { kind: 'correction', quote: '你参考的内容太少了，至少读完三十章', sessionId: live, itemId: 'corr-1' });
  assert.equal(gene('skill-patch:contrast').quote, '你参考的内容太少了，至少读完三十章 / 人名 前后要一致', 'the segment no message holds any more leaves the quote');
  assert.deepEqual(gene('skill-patch:contrast').sources.map(entry => entry.itemId), ['corr-1', 'req-2']);
  assert.equal(gene('skill-patch:gone').quote, undefined); assert.equal(gene('skill-patch:gone').sourceRemoved, 'session_deleted');
  assert.deepEqual(gene('skill-merge:a'), { kind: 'contrast', quote: 'merged summary text' }, 'a skill merge quotes its own summary');
  assert.deepEqual(gene('skill-patch:summary'), { kind: 'contrast', quote: '写作前先列出要读的章节', turns: 0 }, 'a contrast rule from no turn quotes its own summary, not the user');
  assert.deepEqual(gene('skill-patch:linked'), { kind: 'correction', quote: 'already linked', sessionId: live, itemId: 'corr-1' });
  // A later start changes nothing (idempotent).
  const genes = structuredClone(project.genes), mind = structuredClone(project.mind);
  const third = new Store(f.file), same = third.state.projects.find(entry => entry.id === f.project.id);
  assert.deepEqual(same.genes, genes); assert.deepEqual(same.mind, mind);
  // Linked now: deleting the conversation takes the quotes off the rules as for any other.
  third.deleteSession(live);
  const after = third.state.projects.find(entry => entry.id === f.project.id).genes.genes;
  assert.equal(after.find(entry => entry.id === 'skill-patch:contrast').origin.quote, undefined);
  assert.equal(after.find(entry => entry.id === 'skill-patch:correction').origin.quote, undefined);
});
