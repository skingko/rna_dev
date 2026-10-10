import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, readVerifiedJournal } from '../../../packages/sdk/src/journal.mjs';
import { acquireProcessLease } from '../process-lease.mjs';
import { compactJournals, journalCompactionText, runJournalCompactionCli, sessionJournals } from '../journal-maintenance.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rna-journal-maintenance-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = join(root, 'state.json'), files = [];
  for (const [sessionId, tokens] of [['s-one', 600], ['s-two', 0]]) {
    const journal = openJournal({ stateDir: join(`${stateFile}.rna`, sessionId), sessionId, projectId: 'p' });
    journal.append('request_started', { requestId: 'r', message: { id: 'a', role: 'assistant', content: [] } });
    for (let i = 0; i < tokens; i++) journal.appendEvent({ type: 'message_update', requestId: 'r', messageId: 'a', assistantMessageEvent: { type: 'text_delta', delta: `token-${i} ` } });
    journal.append('request_completed', { requestId: 'r', message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
    files.push(journal.file); journal.close();
  }
  return { stateFile, files };
}

test('compact-journals previews, refuses while the service holds the state, compacts verifiably and removes confirmed backups', async t => {
  const { stateFile, files } = fixture(t), [busy, quiet] = files, original = readFileSync(busy);
  assert.deepEqual(sessionJournals(stateFile), [...files].sort());
  const preview = await runJournalCompactionCli(['--dry-run', '--state', stateFile]);
  assert.equal(preview.json, false); assert.equal(preview.result.mergedEvents, 599); assert.deepEqual(readFileSync(busy), original);
  assert.match(journalCompactionText(preview.result), /预览（未改写）：2 个会话日志，1 个可合并/);
  const release = await acquireProcessLease(`${stateFile}.lock`, { purpose: 'fixture-service' });
  await assert.rejects(compactJournals(stateFile), /已有进程/); release();
  assert.deepEqual(readFileSync(busy), original);
  const result = await compactJournals(stateFile), [row] = result.journals.filter(entry => entry.changed);
  assert.equal(result.failed.length, 0); assert.equal(row.file, busy); assert.ok(row.compactedBytes < original.length / 10);
  assert.deepEqual(readFileSync(row.backup), original); assert.equal(readVerifiedJournal(busy).tornBytes, 0);
  assert.equal(result.journals.find(entry => entry.file === quiet).skipped, 'already_compact');
  assert.match(journalCompactionText(result), /--remove-backups/);
  assert.equal((await compactJournals(stateFile)).mergedEvents, 0, 'idempotent');
  const removal = await compactJournals(stateFile, { removeBackups: true });
  assert.deepEqual(removal.removedBackups.map(entry => entry.backup), [row.backup]); assert.ok(!existsSync(row.backup));
  assert.match(journalCompactionText(removal), /已删除：1 个整理前备份/);
  await assert.rejects(runJournalCompactionCli(['--force']), /compact-journals/);
});
