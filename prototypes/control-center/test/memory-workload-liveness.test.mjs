import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

test('an actual memory outbox operation keeps daemon busy until its transport settles, without a foreground turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-memory-liveness-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: true, initiative: false });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { project, session } = app.store.createProject({ name: 'Async memory ownership' });
  app.store.memoryService.identity = async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Isolated transport failure'), { status: 503 }); };
  app.store.mutate(state => {
    state.sessions.find(row => row.id === session.id).items.push({ id: 'actual-fixture-delivery', kind: 'assistant', source: 'initiative', simulated: false, text: 'Fixture assistant delivery, not a real model result.', initiativeActionId: 'fixture-share' });
  });
  assert.equal(app.health().workload.activeWork, false, 'Queued records alone are not in-flight operations');
  const jobs = app.executor.memorySync.pump(); await entered.promise;
  const health = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`)).json();
  assert.equal(health.workload.activeSessions, 0); assert.equal(health.workload.activeExecutions, 0);
  assert.equal(health.workload.memoryOperations, 1); assert.equal(health.workload.activeWork, true, 'The same live-work predicate feeds supervisor IPC, deferring soft RSS restarts');
  release.resolve(); await Promise.all(jobs);
  assert.equal(app.health().workload.memoryOperations, 0); assert.equal(app.health().workload.activeWork, false);
  const write = app.store.state.sessions.find(row => row.id === session.id).memoryEvidenceOutbox[0];
  // A delivery is indexed only (MEM-7): the operation was its resource index write.
  assert.equal(write.status, 'completed'); assert.equal(write.resourceIndex.status, 'pending');
  // The service was unavailable (503): an outage, observable and retried, not counted toward the record's bound.
  assert.deepEqual([write.resourceIndex.code, write.resourceIndex.retry.attempts, write.resourceIndex.retry.outages], ['MEMORY_CONNECTION_UNAVAILABLE', 0, 1], 'The actual failure remains observable; busy is not a fabricated success');
  assert.equal(app.store.state.projects.find(row => row.id === project.id).memorySessions?.length ?? 0, 0);
});
