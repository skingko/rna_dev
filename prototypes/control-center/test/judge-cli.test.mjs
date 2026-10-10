// `./rna judge completion` (D2, shadow): the option-B completion gate's verdicts against what the reviews came to. An option the
// chosen action does not read is refused, not silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('judge completion reads the report route; --project belongs to it alone and --point is not its option', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-cli-judge-'));
  const app = createServer({ stateFile: join(directory, 'state.json'), ticks: false, runtime: false, initiative: false });
  await app.initializer.close(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = args => exec(process.execPath, [cli, 'judge', ...args], { env: { ...process.env, RNA_AGENT_PORT: String(app.server.address().port) }, timeout: 15000 });
  const report = JSON.parse((await run(['completion', '--project', 'nope', '--window', '24h'])).stdout);
  assert.deepEqual([report.point, report.mode, report.window, report.rows], ['work.completion', 'shadow', '24h', 0]);
  const rejected = async args => { try { await run(args); } catch (error) { return `${error.stderr}${error.stdout}`; } return null; };
  assert.match(await rejected(['ledger', '--project', 'nope']), /--project 只用于 judge completion/);
  assert.match(await rejected(['calibration', '--project', 'nope']), /--project 只用于 judge completion/);
  assert.match(await rejected(['status', '--project', 'nope']), /--project 只用于 judge completion/);
  assert.match(await rejected(['completion', '--point', 'work.completion']), /不接受 --point/);
  assert.match(await rejected(['completion', '--window', 'forever']), /window/);
});
