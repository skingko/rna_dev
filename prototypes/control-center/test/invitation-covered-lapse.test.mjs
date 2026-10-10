import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, setup } from './helpers/gene-fixture.mjs';
import { createMindEntry, lessonGene } from '../project-mind.mjs';
import { offerInvitation, closeInvitation, expireFeedbackInvitations } from '../session-invitations.mjs';

const CORRECTION = '你参考的内容太少了，至少要读完 30 章深入理解才行，在剧情合理性和推进速度等各方面进行参考';
const lesson = (extra = {}) => ({ id: 'l1', status: 'active', kind: 'preference', text: '参考同类小说时至少通读 30 章以上。', source: { kind: 'correction', itemId: 'item-1' }, evidence: [{ excerpt: CORRECTION }], ...extra });

// Seen live: the rule "参考读满30章" was written from the correction itself (lane B), then folded into "读满30章再逐句对照";
// the lesson captured from the same message still asked "以后照这样做吗？" above the composer.
test('a lesson carried by an evolution rule is found through the correction and the consolidation that replaced it', () => {
  const genes = [
    { id: 'g-old', layer: 'skill', status: 'retired', supersededBy: 'g-new', origin: { kind: 'correction', quote: CORRECTION } },
    { id: 'g-new', layer: 'skill', status: 'trial', origin: { kind: 'consolidation', quote: 'a + b' } },
    { id: 'g-other', layer: 'skill', status: 'active', origin: { kind: 'correction', quote: '别的纠正，和这条无关的内容' } },
  ];
  assert.equal(lessonGene({ genes: { genes } }, lesson())?.id, 'g-new');
  // Matched by the correction message itself (rules written from now on keep it).
  assert.equal(lessonGene({ genes: { genes: [{ id: 'g1', layer: 'skill', status: 'active', origin: { kind: 'correction', quote: '另一种说法', itemId: 'item-1' } }] } }, lesson())?.id, 'g1');
  // Grown from the lesson, or recorded on its route.
  assert.equal(lessonGene({ genes: { genes: [{ id: 'g2', layer: 'guard', status: 'active', origin: { kind: 'lesson', lessonId: 'l1' } }] } }, lesson())?.id, 'g2');
  assert.equal(lessonGene({ genes: { genes: [{ id: 'g3', layer: 'skill', status: 'trial', origin: { kind: 'contrast' } }] } }, lesson({ geneRoute: { geneId: 'g3' } }))?.id, 'g3');
  // A retired rule nobody replaced, a rejected one, or an unrelated one carries nothing.
  assert.equal(lessonGene({ genes: { genes: [{ id: 'g4', layer: 'skill', status: 'retired', origin: { kind: 'correction', quote: CORRECTION } }, { id: 'g5', layer: 'skill', status: 'rejected', origin: { kind: 'lesson', lessonId: 'l1' } }, genes[2]] } }, lesson()), null);
});

test('a covered lesson is not asked, and an open card for one closes on the next sweep', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  let first, second;
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    first = createMindEntry(project, 'lessons', { text: '参考同类小说时至少通读 30 章以上。', kind: 'preference' }).id;
    second = createMindEntry(project, 'lessons', { text: '写新章节前先核对前文伏笔。', kind: 'preference' }).id;
    for (const id of [first, second]) Object.assign(project.mind.lessons.find(row => row.id === id), { needsConfirmation: true, evidence: [{ excerpt: id === first ? CORRECTION : '写之前看看前文有没有伏笔' }] });
  });
  // The second one is asked first (nothing carries it yet).
  const invitationId = f.app.mind.inviteLesson(f.project.id, second);
  assert.ok(invitationId);
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id);
    project.genes ??= {}; project.genes.genes = [...(project.genes.genes ?? []),
      { id: 'skill-patch:aaa', layer: 'skill', status: 'trial', title: '读满30章', origin: { kind: 'correction', quote: CORRECTION } },
      { id: 'skill-patch:bbb', layer: 'skill', status: 'active', title: '呼应伏笔核对', origin: { kind: 'lesson', lessonId: second } }];
  });
  assert.equal(f.app.mind.inviteLesson(f.project.id, first), null, 'carried by a rule: not asked');
  let row = f.current().mind.lessons.find(item => item.id === first);
  assert.equal(row.needsConfirmation, undefined); assert.equal(row.coveredBy.geneId, 'skill-patch:aaa');
  f.app.mind.sweep();
  row = f.current().mind.lessons.find(item => item.id === second);
  assert.equal(row.coveredBy.geneId, 'skill-patch:bbb'); assert.ok(row.interaction.settledAt);
  const session = f.app.store.state.sessions.find(item => item.id === f.session.id);
  assert.equal((session.invitations ?? []).filter(item => item.kind === 'lesson').length, 0);
  assert.equal(session.invitationHistory.find(item => item.id === invitationId)?.outcome, 'expired');
});

test('a decision the user was shown and went past lapses with their next message; one never shown stays', () => {
  const session = { id: 's1' };
  const lessonCard = offerInvitation(session, { kind: 'lesson', subject: 'lesson:a' }), gene = offerInvitation(session, { kind: 'gene', subject: 'retire:g' }), feedback = offerInvitation(session, { kind: 'feedback', subject: 'feedback:i' });
  lessonCard.shownAt = new Date().toISOString();
  expireFeedbackInvitations(session);
  assert.deepEqual(session.invitations.map(row => row.id), [gene.id]);
  assert.deepEqual(session.invitationHistory.map(row => [row.id, row.outcome]), [[lessonCard.id, 'expired'], [feedback.id, 'expired']]);
  // Asked once: the same subject is not offered again in this conversation.
  assert.equal(offerInvitation(session, { kind: 'lesson', subject: 'lesson:a' }), null);
  closeInvitation(session, gene.id, 'answered');
});

test('the strip reports what it showed; answering a shown promise is recorded as answered, not lapsed by its own message', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的，接着做。'));
  let commitmentId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); commitmentId = createMindEntry(project, 'commitments', { text: '把第三章改完', request: '把第三章改完' }).id; });
  const offered = f.app.store.invitations.offerCommitment(f.session.id, { projectId: f.project.id, commitmentId, request: '把第三章改完' });
  const post = body => fetch(f.url(`/api/v2/sessions/${f.session.id}/invitations/${offered.id}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  const shown = await post({ action: 'shown' });
  assert.equal(shown.status, 200, JSON.stringify(shown.body)); assert.equal(shown.body.closed, false);
  assert.ok(f.app.store.state.sessions.find(row => row.id === f.session.id).invitations.find(row => row.id === offered.id).shownAt);
  const answered = await post({ action: 'answer', choice: 'continue' });
  assert.equal(answered.status, 200, JSON.stringify(answered.body)); assert.equal(answered.body.outcome, 'answered');
  const session = f.app.store.state.sessions.find(row => row.id === f.session.id);
  assert.equal(session.invitationHistory.find(row => row.id === offered.id)?.outcome, 'answered');
  assert.ok(session.items.some(item => item.kind === 'user' && /接着完成：把第三章改完/.test(item.text)));
});

// Seen live after the 0.48.6 deploy: the startup sweep runs before invitations are wired, so the lesson was marked as
// carried but its open card stayed. A later sweep closes a card whose lesson is already settled.
test('a card left open for a lesson settled before invitations were wired closes on a later sweep', async t => {
  const f = await setup(t, (_input, res) => stream(res, '好的。'));
  let id;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); id = createMindEntry(project, 'lessons', { text: '参考同类小说时至少通读 30 章以上。', kind: 'preference' }).id; Object.assign(project.mind.lessons.find(row => row.id === id), { needsConfirmation: true, evidence: [{ excerpt: CORRECTION }] }); });
  const invitationId = f.app.mind.inviteLesson(f.project.id, id);
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); project.genes ??= {}; project.genes.genes = [...(project.genes.genes ?? []), { id: 'skill-patch:ccc', layer: 'skill', status: 'trial', title: '读满30章', origin: { kind: 'correction', quote: CORRECTION } }]; });
  const wired = f.app.mind.invitations; f.app.mind.invitations = null;
  f.app.mind.sweep();
  assert.equal(f.current().mind.lessons.find(row => row.id === id).coveredBy.geneId, 'skill-patch:ccc');
  assert.ok(f.app.store.state.sessions.find(row => row.id === f.session.id).invitations.some(row => row.id === invitationId), 'not wired yet: the card is still open');
  f.app.mind.invitations = wired;
  f.app.mind.sweep();
  assert.equal(f.app.store.state.sessions.find(row => row.id === f.session.id).invitations.some(row => row.id === invitationId), false);
});
