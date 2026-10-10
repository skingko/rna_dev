// The measurement behind LIMITS.snapshotFileBytes (B8; docs/research/snapshot-file-bytes-20261005.md).
//
//   node benchmark/snapshot-cost-probe.mjs sizes <folder>…   file size distribution of project folders (read only:
//                                                           stat only, no git; skips .git, node_modules, .rna, …)
//   node benchmark/snapshot-cost-probe.mjs cost              what one changed file of 1–100 MB costs a snapshot
//                                                           (update-index --add + write-tree in a scratch repository
//                                                           under the system temp folder, deleted afterwards)
//
// No model call, no network, never a project's own repository.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.rna', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.DS_Store']);

async function sizes(roots) {
  for (const root of roots) {
    const found = [];
    const walk = async folder => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (SKIP.has(entry.name)) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) { const info = await lstat(path).catch(() => null); if (info) found.push(info.size); }
      }
    };
    await walk(root);
    found.sort((a, b) => a - b);
    const at = p => (found.length ? found[Math.min(found.length - 1, Math.floor(p * found.length))] : 0);
    console.log(JSON.stringify({ root, files: found.length, totalMB: +(found.reduce((a, b) => a + b, 0) / MB).toFixed(1), p50: at(0.5), p99: at(0.99), max: found.at(-1) ?? 0, over: Object.fromEntries([1, 5, 20, 50, 100].map(n => [`${n}MB`, found.filter(size => size > n * MB).length])) }));
  }
}

function cost() {
  const dir = mkdtempSync(join(tmpdir(), 'rna-snapshot-cost-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'private-index'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args, input) => execFileSync('git', args, { cwd: dir, input, env, maxBuffer: 1 << 26 });
  const stored = () => { let total = 0; const walk = folder => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) walk(path); else total += statSync(path).size; } }; walk(join(dir, '.git', 'objects')); return total; };
  try {
    git(['init', '-q']);
    for (const mb of [1, 12, 50, 100]) {
      const name = `random-${mb}.bin`, body = randomBytes(mb * MB), before = stored(), runs = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        body[attempt] ^= 0xff; writeFileSync(join(dir, name), body);
        const started = process.hrtime.bigint();
        git(['update-index', '-z', '--add', '--remove', '--replace', '--stdin'], `${name}\0`); git(['write-tree']);
        runs.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      runs.sort((a, b) => a - b);
      console.log(JSON.stringify({ mb, ms: Math.round(runs[1]), storedMBPerVersion: +((stored() - before) / 3 / MB).toFixed(1) }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'sizes') await sizes(rest);
else if (mode === 'cost') cost();
else console.error('usage: snapshot-cost-probe.mjs sizes <folder>… | cost');
