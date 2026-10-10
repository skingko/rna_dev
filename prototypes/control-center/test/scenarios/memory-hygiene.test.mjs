// D4 scenario (B6, memory hygiene): crosses the foreground turn (recall at turn start, the SDK transcript holding
// earlier attachments), memory-context and memory-service (recall dedup, MIND-13), the initiative (a background run whose
// settled work line is a delivery), the evidence outbox and memory sync (MEM-7: index only), and the remote sessions the
// turns themselves create (working memory only where a checkpoint reads it). Only the model, OpenViking, JEV and the
// clock are fake; the world is checked from outside: the model's wire, what OpenViking was asked, the persisted state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorld, gitReady, until } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { CacheSurvival } from '../../usage-cache-service.mjs';

const count = (text, needle) => text.split(needle).length - 1;
const PASSAGES = { a: 'Chapter titles are numbered with roman numerals', b: 'Every chapter ends with a one line hook', c: 'The appendix keeps the glossary in alphabetical order' };

test('a later turn does not re-attach recalled memory the conversation still holds, and a background delivery reaches memory without a remote session', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const world = await createWorld(t, { initiative: true, memory: { autoStore: true, autoRecall: true }, files: { 'notes.md': 'one\ntwo\n' } });
  world.store.mutate(state => { state.projects.find(row => row.id === world.projectId).assignments.toolIds.push('openviking_search', 'openviking_read'); });
  const namespace = world.store.memoryService.remote(world.projectId).namespace;
  // A peer memory an earlier extraction left: the tree a whole-tree rebuild would list and reindex.
  world.ov.resources.set(`viking://user/${world.ov.user}/peers/forge-${world.projectId}/memories/preferences/chapter-titles.md`, 'Chapter titles use roman numerals.');
  let found = ['a', 'b'];
  world.ov.searchHits = body => body.target_uri === namespace ? found.map((key, index) => ({ uri: `${namespace}/notes/${key}.md`, level: 2, abstract: PASSAGES[key], score: 1 - index / 10 })) : [];
  const s = scenario(world);

  const first = await s.send('What did we decide about chapter titles?', { reply: 'They are numbered.' });
  await first.expect({
    requests: rows => { const wire = rows.findLast(row => row.tag === 'foreground').wire; assert.equal(count(wire, PASSAGES.a), 1); assert.equal(count(wire, PASSAGES.b), 1); },
    state: state => assert.equal(state.sessions.find(row => row.id === world.sessionId).turns.at(-1).memoryContext.injectedEntries.length, 2),
  });

  // The same passages match again, with one new one: only the new one is attached; the others are named by a pointer.
  found = ['a', 'b', 'c'];
  const second = await s.send('And the chapter titles in the appendix?', { reply: 'Numbered the same way.' });
  await second.expect({
    requests: rows => {
      const wire = rows.findLast(row => row.tag === 'foreground').wire;
      assert.equal(count(wire, PASSAGES.a), 1, 'the first turn\'s attachment is the only copy the model reads');
      assert.equal(count(wire, PASSAGES.b), 1);
      assert.equal(count(wire, PASSAGES.c), 1, 'the freed budget went to the new passage');
      assert.match(wire, /Matched again; their unchanged text is in an earlier project-memory attachment/);
    },
    state: state => {
      const memory = state.sessions.find(row => row.id === world.sessionId).turns.at(-1).memoryContext;
      assert.deepEqual(memory.injectedEntries.map(row => row.uri.split('/').at(-1)), ['c.md']); assert.equal(memory.deduplicated, 2);
    },
  });

  // A background run settles a change set; its work line is a delivery.
  const run = await s.backgroundRun({ task: 'Mark the second line of notes.md as reviewed.', work: [
    { toolCalls: [{ name: 'project_read', args: { path: 'notes.md' } }] },
    { toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: 'one\ntwo (reviewed)\n' } }] },
    'Reviewed notes.md.\nHandoff: marked the second line of notes.md as reviewed; nothing left.',
  ] });
  await run.expect({ files: { 'notes.md': 'one\ntwo (reviewed)\n' } });
  const delivery = () => (world.session()?.memoryEvidenceOutbox ?? []).find(row => row.sourceKind === 'autonomous_delivery');
  const synced = await s.advanceClock(20000, { repeat: true, label: 'memory sync indexes the delivery and archives the turns', until: () => delivery()?.resourceIndex?.status === 'completed' && world.session().turns.every(turn => !turn.memoryWrite || turn.memoryWrite.status === 'completed') });
  await synced.expect({
    state: state => {
      const write = state.sessions.find(row => row.id === world.sessionId).memoryEvidenceOutbox.find(row => row.sourceKind === 'autonomous_delivery');
      assert.deepEqual([write.status, write.extraction, write.sessionId], ['completed', 'not_applicable', undefined]);
      const bindings = state.projects.find(row => row.id === world.projectId).memorySessions ?? [];
      assert.equal(bindings.length, 2, 'one binding per conversation turn, none for the delivery');
    },
  });
  // What OpenViking was asked over the whole scenario: the delivery's document, and one remote session per turn,
  // none of them with working memory (no turn had checkpoints).
  const created = world.ov.of('/api/v1/sessions', 'POST').filter(call => call.path === '/api/v1/sessions');
  assert.equal(created.length, 2);
  assert.ok(created.every(call => call.body.memory_policy.working_memory.enabled === false));
  assert.ok(world.ov.of('/api/v1/content/write', 'POST').some(call => call.body.uri.includes('/rna-execution-evidence/')), 'the delivery document was written');
  // Extractions completed with new memories (the revision moved) over a tree that has files: still no rebuild.
  assert.ok(world.store.state.projects.find(row => row.id === world.projectId).memorySummary?.revision >= 1);
  assert.equal(world.ov.of(/\/content\/reindex$/, 'POST').filter(call => call.body?.recursive === true).length, 0, 'no whole-tree rebuild');
});

// Review finding (B6): an idle summary the idle service prepared but could not commit is committed by the next turn's
// own handle at its first cold request (idle-compaction-service step 4; SDK economyPoint). A passage attached in a turn
// that summary covers leaves the context at that request, so the turn's recall must attach it again, not point at it.
// Crosses the idle compaction service (plan, summary on the faux model's HTTP endpoint, sidecar, a commit refused while
// the conversation is held), the runtime's turn (handle open with the sidecar, recall, first request) and memory-context.
const COLD_MS = 10 * 60000;
const chapter = index => `Chapter ${index}. ${'夜色里的灯一盏盏亮起来。'.repeat(500)}`;
test('a turn that starts with an idle summary still prepared attaches again the passages that summary takes, instead of pointing at them', async t => {
  const world = await createWorld(t, { idleCompaction: true, memory: { autoRecall: true } });
  world.store.mutate(state => { state.projects.find(row => row.id === world.projectId).assignments.toolIds.push('openviking_search', 'openviking_read'); });
  const namespace = world.store.memoryService.remote(world.projectId).namespace;
  let found = ['a'];
  world.ov.searchHits = body => body.target_uri === namespace ? found.map((key, index) => ({ uri: `${namespace}/notes/${key}.md`, level: 2, abstract: PASSAGES[key], score: 1 - index / 10 })) : [];
  const key = CacheSurvival.key(world.provider.id, 'faux-model'), at = Date.now();
  world.store.usageLedger.survival.add(key, { gapMs: 60000, warm: true, prompt: 20000, at });
  world.store.usageLedger.survival.add(key, { gapMs: COLD_MS, warm: false, prompt: 20000, at });
  const s = scenario(world);

  const first = await s.send('Write chapter 1. How are chapter titles numbered?', { reply: chapter(1) });
  await first.expect({ requests: rows => assert.equal(count(rows.findLast(row => row.tag === 'foreground').wire, PASSAGES.a), 1) });
  found = [];
  for (let index = 2; index <= 3; index++) await s.send(`Write chapter ${index}.`, { reply: chapter(index) });

  // The idle summary (covering chapter 1's turn, the last two kept verbatim) is generated while nothing holds the
  // conversation, then cannot be committed: a maintenance claim holds it, as a turn about to start would.
  let releaseSummary, releaseClaim, claim;
  const prepared = await s.step('idle summary prepared, commit refused', async () => {
    world.faux.script('http', { hold: new Promise(done => { releaseSummary = done; }), then: 'SUMMARY-ONE: chapter 1 was written.' });
    world.clock.advance(COLD_MS + 60000); world.tick();
    await until(() => world.session().context?.idleCompaction?.status === 'preparing', 'the idle summary to start', 30000);
    claim = world.app.executor.runMaintenance(world.sessionId, () => new Promise(done => { releaseClaim = done; }));
    releaseSummary();
    return until(() => world.session().context?.idleCompaction?.status === 'prepared' ? world.session().context.idleCompaction : null, 'the idle summary to be prepared', 30000);
  });
  await prepared.expect({ state: state => assert.equal(state.sessions.find(row => row.id === world.sessionId).context.lastCompactionId ?? null, null, 'not committed') });

  // The next turn is accepted while the claim holds the conversation, then runs: its handle opens with the prepared
  // summary, recalls the same passage, and commits the summary at its first (cold) request.
  found = ['a', 'b'];
  const next = await s.step('a turn after the prepared summary', async () => {
    world.faux.script('foreground', 'Roman numerals, as before.');
    const accepted = await world.post(`/api/sessions/${world.sessionId}/messages`, { text: 'Remind me how chapter titles are numbered.', requestId: randomUUID() });
    assert.equal(accepted.status, 200);
    const turnId = accepted.body.session?.activeTurnId ?? world.session().activeTurnId;
    releaseClaim(); await claim;
    await until(() => { const turn = world.session().turns.find(row => row.id === turnId); return turn && turn.status !== 'running' ? turn : null; }, 'the turn');
    await world.quiet();
    return { turnId };
  });
  await next.expect({
    requests: rows => {
      const wire = rows.findLast(row => row.tag === 'foreground').wire;
      assert.match(wire, /SUMMARY-ONE/, 'the prepared summary was committed at the first request');
      assert.equal(count(wire, PASSAGES.a), 1, 'the passage the summary took is attached again, once');
      assert.equal(count(wire, PASSAGES.b), 1);
      assert.doesNotMatch(wire, /Matched again/, 'no pointer to an attachment the model no longer sees');
    },
    state: state => {
      const session = state.sessions.find(row => row.id === world.sessionId), memory = session.turns.at(-1).memoryContext;
      assert.deepEqual(memory.injectedEntries.map(row => row.uri.split('/').at(-1)), ['a.md', 'b.md']); assert.equal(memory.deduplicated, undefined);
      assert.ok(session.context.lastCompactionId, 'committed by the turn');
    },
  });
});
