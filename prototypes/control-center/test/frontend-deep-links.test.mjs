import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { createApiV2, bootstrap } from '../api-v2.mjs';
import { createInboxRoutes } from '../inbox-routes.mjs';
import { recordDelivery } from '../proactive-delivery.mjs';
import { projectMemorySyncStatus } from '../memory-sync-status.mjs';
import { publicSessionDeletions } from '../session-deletion.mjs';
import { listSystemEvolutionProposals, proposeSystemEvolution } from '../project-evolution-rrsi.mjs';

// H4 front-end support: inbox deep links, session item positions, digest ↔
// entries mapping, cleanup receipts, memory sync status, system proposals.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-h4-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Deep links', workspace: dir, initiative: { enabled: false } });
  const api = createApiV2({ store });
  t.after(() => { api.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = path => {
    const url = new URL(`http://127.0.0.1${path}`); let result = null;
    const handled = api.handle({ method: 'GET', headers: {} }, {}, { pathname: url.pathname, url, send: (status, body) => { result = { status, body }; } });
    return handled ? result : null;
  };
  const inbox = createInboxRoutes({ store, body: async () => ({}), decisions: null });
  const inboxGet = async path => { const url = new URL(`http://127.0.0.1${path}`); let result = null; await inbox({ method: 'GET' }, { pathname: url.pathname, url, send: (status, body) => { result = { status, body }; } }); return result; };
  return { dir, store, project, session, get, inboxGet };
}

test('inbox entry lookup locates the delivered message, question card and digest, and item lookup maps back', async t => {
  const f = fixture(t), at = '2026-09-28T08:00:00.000Z';
  const ids = {};
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id), project = state.projects.find(row => row.id === f.project.id);
    session.items.push({ id: 'u1', turnId: 't1', kind: 'user', text: 'hi', createdAt: at });
    session.items.push({ id: 'm1', turnId: null, kind: 'assistant', text: 'finding', createdAt: at, source: 'initiative', initiative: { reach: 'inline' } });
    session.items.push({ id: 'q1', turnId: 't2', kind: 'question', text: 'which?', createdAt: at, interaction: { id: 'i1', status: 'pending' } });
    const inline = recordDelivery(project, { actionId: 'a1', tier: 'inline', text: 'finding', sessionId: session.id, itemId: 'm1' });
    const ask = recordDelivery(project, { actionId: 'a2', kind: 'ask', tier: 'inline', text: 'which?', sessionId: session.id, interactionId: 'i1' });
    const inboxOnly = recordDelivery(project, { actionId: 'a3', tier: 'inbox', text: 'filed', sessionId: session.id });
    const d1 = recordDelivery(project, { actionId: 'a4', tier: 'digest', text: 'one', sessionId: session.id }), d2 = recordDelivery(project, { actionId: 'a5', tier: 'digest', text: 'two', sessionId: session.id });
    session.items.push({ id: 'dg', turnId: null, kind: 'assistant', text: 'digest', createdAt: at, source: 'initiative', initiative: { kind: 'digest', reach: 'digest', entryIds: [d1.id, d2.id] } });
    for (const row of [d1, d2]) Object.assign(row, { heldForDigest: false, digestedAt: at, digestItemId: 'dg', digestSessionId: session.id });
    Object.assign(ids, { inline: inline.id, ask: ask.id, inboxOnly: inboxOnly.id, d1: d1.id, d2: d2.id });
  });
  const base = `/api/v2/projects/${f.project.id}/inbox`;
  const inline = await f.inboxGet(`${base}/${ids.inline}`);
  assert.equal(inline.status, 200);
  assert.deepEqual({ ...inline.body.location, count: undefined }, { kind: 'message', sessionId: f.session.id, itemId: 'm1', turnId: null, index: 1, count: undefined, sessionArchived: false });
  assert.equal(inline.body.entry.status, 'unread', 'a lookup never marks the entry read');
  const ask = await f.inboxGet(`${base}/${ids.ask}`);
  assert.equal(ask.body.location.kind, 'question'); assert.equal(ask.body.location.itemId, 'q1'); assert.equal(ask.body.location.turnId, 't2');
  assert.equal((await f.inboxGet(`${base}/${ids.inboxOnly}`)).body.location, null, 'an inbox-only entry has no conversation position');
  const digested = await f.inboxGet(`${base}/${ids.d1}`);
  assert.equal(digested.body.location.kind, 'digest'); assert.equal(digested.body.location.itemId, 'dg');
  assert.deepEqual(digested.body.digest.entryIds, [ids.d1, ids.d2]);
  await assert.rejects(f.inboxGet(`${base}/missing`), { status: 404 });

  const item = f.get(`/api/v2/sessions/${f.session.id}/items/dg`);
  assert.equal(item.status, 200); assert.equal(item.body.item.id, 'dg');
  assert.equal(item.body.position.index, 3); assert.equal(item.body.position.count, 4);
  assert.deepEqual(item.body.digest.entryIds, [ids.d1, ids.d2]);
  assert.deepEqual(item.body.inboxEntries.map(row => [row.id, row.relation]), [[ids.d1, 'digest'], [ids.d2, 'digest']]);
  const question = f.get(`/api/v2/sessions/${f.session.id}/items/q1`);
  assert.deepEqual(question.body.inboxEntries.map(row => [row.id, row.relation]), [[ids.ask, 'question']]);
  assert.equal(question.body.position.turnId, 't2');
});

test('cleanup receipts are public in bootstrap and GET /api/v2/session-deletions without bindings or evidence', t => {
  const f = fixture(t);
  f.store.mutate(state => { state.sessionDeletions = [{ sessionId: 'gone-1', projectId: f.project.id, status: 'pending', localStatus: 'completed', remoteStatus: 'pending', createdAt: '2026-09-28T00:00:00.000Z', code: 'MEMORY_UNAVAILABLE', retryAt: '2026-09-28T00:05:00.000Z', attempts: 2, bindings: [{ sessionId: 'remote' }], evidence: { secret: true }, evidenceResources: [{ uri: 'viking://x' }] }]; });
  const [row] = publicSessionDeletions(f.store.state);
  assert.deepEqual(Object.keys(row).sort(), ['attempts', 'code', 'completedAt', 'createdAt', 'localStatus', 'projectId', 'remoteStatus', 'retryAt', 'sessionId', 'status', 'updatedAt']);
  assert.equal(row.attempts, 2); assert.equal(row.code, 'MEMORY_UNAVAILABLE');
  assert.deepEqual(bootstrap(f.store).sessionDeletions, [row]);
  const listed = f.get('/api/v2/session-deletions');
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.deletions, [row]);
  assert.equal(JSON.stringify(listed.body).includes('viking://'), false);
});

test('memory sync status aggregates per-session turn checkpoints and evidence outcomes', t => {
  const f = fixture(t), other = f.store.createSession({ projectId: f.project.id });
  f.store.mutate(state => {
    const one = state.sessions.find(row => row.id === f.session.id), two = state.sessions.find(row => row.id === other.id);
    one.turns.push({ id: 't1', status: 'completed', memoryCheckpoints: [{ id: 'c1', kind: 'incremental', status: 'completed', updatedAt: '2026-09-28T01:00:00.000Z' }, { id: 'c2', kind: 'final', status: 'completed', updatedAt: '2026-09-28T01:01:00.000Z' }] });
    one.turns.push({ id: 't2', status: 'completed', memoryWrite: { status: 'uploading' } });
    two.turns.push({ id: 't3', status: 'completed', memoryWrite: { status: 'failed', code: 'MEMORY_UPLOAD_FAILED', updatedAt: '2026-09-28T02:00:00.000Z' } });
    two.turns.push({ id: 't4', status: 'completed', memoryWrite: { status: 'uncertain', code: 'MEMORY_WRITE_OUTCOME_UNKNOWN', updatedAt: '2026-09-28T02:01:00.000Z' } });
    two.memoryEvidenceOutbox = [{ id: 'e1', status: 'completed', memoriesExtracted: 3, resourceIndex: { status: 'pending' } }];
    two.memoryEvidenceState = { schemaVersion: 1, initializedAt: '2026-09-28T00:00:00.000Z', seen: [] };
  });
  const status = projectMemorySyncStatus(f.store.state, f.store.state.projects.find(row => row.id === f.project.id));
  assert.equal(status.status, 'attention'); assert.equal(status.completedTurns, 1); assert.equal(status.incremental, 1);
  assert.equal(status.pending, 1); assert.equal(status.attention, 1); assert.equal(status.settledLoss, 1); assert.equal(status.evidence.extracted, 3); assert.equal(status.evidence.indexPending, 1);
  assert.equal(status.sessions.length, 2); assert.equal(status.sessions[0].sessionId, other.id, 'sessions needing attention sort first');
  // Only the unknown outcome needs attention; the settled loss is history (A2).
  assert.deepEqual(status.sessions[0].issues.map(row => row.code), ['MEMORY_WRITE_OUTCOME_UNKNOWN']); assert.deepEqual(status.sessions[0].history.map(row => row.code), ['MEMORY_UPLOAD_FAILED']);
  assert.equal(status.sessions[0].evidence.initializedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(status.sessions[1].status, 'syncing');
  const routed = f.get(`/api/v2/projects/${f.project.id}/memory-sync`);
  assert.equal(routed.status, 200); assert.equal(routed.body.projectId, f.project.id); assert.equal(typeof routed.body.revision, 'number');
  assert.throws(() => f.get('/api/v2/projects/missing/memory-sync'), { status: 404 });
});

test('system evolution proposals list newest first and skip unreadable files', async t => {
  const f = fixture(t), aggregate = async () => ({ targets: [], signalKinds: {}, projects: [] });
  assert.deepEqual(await listSystemEvolutionProposals(f.store), { total: 0, proposals: [], autoAdopt: false });
  const first = await proposeSystemEvolution(f.store, { note: 'first' }, { aggregate });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await proposeSystemEvolution(f.store, { note: 'second' }, { aggregate });
  const dir = join(`${f.store.file}.evolution`, '_system'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'sys-torn.json'), '{');
  const listed = await listSystemEvolutionProposals(f.store);
  assert.equal(listed.total, 2); assert.deepEqual(listed.proposals.map(row => row.id), [second.id, first.id]);
  assert.equal((await listSystemEvolutionProposals(f.store, { limit: 1 })).proposals.length, 1);
});
