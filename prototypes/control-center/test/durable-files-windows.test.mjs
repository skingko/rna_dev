import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, syncDirectory } from '../durable-files.mjs';

// Found by the first Windows build (2026-10-10): the service died at startup with EPERM from fsync on a directory handle,
// which Windows does not allow. A directory sync succeeds there without doing more; everywhere else a failure still throws.
test('syncDirectory works on a real directory, and a missing one still throws', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-durable-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  syncDirectory(directory); syncDirectory(directory, 'win32'); syncDirectory(directory, 'linux');
  assert.throws(() => syncDirectory(join(directory, 'absent')), { code: 'ENOENT' });
  assert.throws(() => syncDirectory(join(directory, 'absent'), 'win32'), { code: 'ENOENT' }, 'only the refusals a directory handle gives on Windows are tolerated');
  atomicWrite(join(directory, 'nested', 'state.json'), '{}');
});
