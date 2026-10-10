import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { SessionCommandService } from '../session-command-service.mjs';
import { IdleCompactionService } from '../idle-compaction-service.mjs';

// Review P1 (CLAUDE-2/INT-2): keep-alive pings re-send a conversation's last request. Every host path that cuts,
// replaces or deletes that history stops them: a rewind, a deletion (drainMaintenance), a manual /compact, an idle
// summary committed while the conversation is idle, and a compaction, economy or thinking rebase inside a turn.
test('the host forgets a conversation\'s keep-alive when its history is cut, replaced or deleted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-keepalive-host-')), store = new Store(join(directory, 'state.json'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const forgotten = [];
  store.usageLedger = { keepAlive: { forget: id => { forgotten.push(id); return true; } }, records: () => [], record: () => null, subscribe: () => () => {} };
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'keepalive-fixture-key', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session } = store.createProject({ name: 'Keep-alive QA', workspace: directory, initiative: { enabled: false } });
  const executor = new RuntimeController(store), commands = new SessionCommandService(store, { executor });
  t.after(() => executor.close());
  const take = () => forgotten.splice(0);

  // Deletion drains the conversation's background work here.
  await executor.drainMaintenance(session.id);
  assert.deepEqual(take(), [session.id]);
  // A rewind cuts the history the held request carries.
  const at = new Date().toISOString();
  store.mutate(state => { const row = state.sessions.find(item => item.id === session.id); row.items.push({ id: 'user-1', kind: 'user', text: 'secret text', createdAt: at, turnId: 'turn-1' }); row.turns.push({ id: 'turn-1', status: 'completed', createdAt: at, completedAt: at }); });
  await executor.rewind(session.id, 'user-1');
  assert.deepEqual(take(), [session.id]);
  // A manual /compact replaces it (forgotten before anything else, even when there turns out to be nothing to compact).
  await commands.execute(session.id, { command: 'compact', args: {}, requestId: 'compact-1' }).catch(() => null);
  assert.deepEqual(take(), [session.id]);
  // Inside a turn: a committed compaction, committed economies or a thinking rebase change what the next request sends.
  for (const type of ['auto_compaction_end', 'context_economy', 'thinking_rebase']) { executor.event({ sessionId: session.id, turnId: 'none', cancelled: true }, { type, result: {} }); assert.deepEqual(take(), [session.id], type); }
  executor.event({ sessionId: session.id, turnId: 'none', cancelled: true }, { type: 'context_usage', usage: {} });
  assert.deepEqual(take(), [], 'other events leave it alone');
  // A revocation that folded context copies (C4): the held request still carries what was revoked and is never pinged again; one that found nothing to fold changes nothing.
  executor.event({ sessionId: session.id, turnId: 'none', cancelled: true }, { type: 'context_revoke', ids: ['revoke-1'], folded: 2, summaries: [] });
  assert.deepEqual(take(), [session.id], 'a revocation that folded copies');
  executor.event({ sessionId: session.id, turnId: 'none', cancelled: true }, { type: 'context_revoke', ids: ['revoke-2'], folded: 0, summaries: [], withdrawn: [] });
  assert.deepEqual(take(), [], 'a revocation that folded nothing leaves it alone');
  executor.event({ sessionId: session.id, turnId: 'none', cancelled: true }, { type: 'context_revoke', ids: ['revoke-3'], folded: 0, summaries: ['c1'], withdrawn: ['c1'] });
  assert.deepEqual(take(), [session.id], 'one that withdrew the summary in force changed the history too');
  // An idle summary committed by the background service.
  const idle = new IdleCompactionService(store, { executor, ledger: store.usageLedger, survival: null });
  idle.applyCommitted(session.id, { id: 'idle-commit-1' }, { notice: false });
  assert.deepEqual(take(), [session.id]);
});
