import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { ensureMaintenancePaths, maintenanceFailure, maintenanceTerminal, readMaintenance, withMaintenanceControl } from './application-maintenance-state.mjs';
import { maintenanceId, maintenanceRegistry } from './application-maintenance.mjs';
import { readStateFile } from './state-shards.mjs';

/* Retention for service-owned maintenance trees. Verified checkpoints keep the
 * newest three; runtime releases keep the one the service config runs, the
 * newest older one (rollback target) and at most one newer, not yet applied
 * candidate. The registry is rewritten before directories are removed, so a
 * crash leaves only unregistered leftovers, which the next run removes. The
 * running release and anything an unfinished operation references are never
 * touched; with an unfinished operation retention refuses to run at all. */
export const RETENTION = Object.freeze({ checkpoints: 3 });
const PENDING = /^\.([a-f0-9-]{36})\.pending-[a-f0-9-]{36}$/;
const byTime = key => (a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')) || b.index - a.index;
const inside = (root, path) => path.startsWith(`${root}${sep}`);
function names(directory) { try { return readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
function treeBytes(path) {
  let bytes = 0; const info = lstatSync(path, { throwIfNoEntry: false }); if (!info) return 0;
  if (info.isDirectory() && !info.isSymbolicLink()) for (const name of readdirSync(path)) bytes += treeBytes(join(path, name)); else bytes += info.size;
  return bytes;
}
// Prepared releases are read-only (0500 directories); make them writable top-down first.
function removeTree(path) {
  const open = directory => { const info = lstatSync(directory, { throwIfNoEntry: false }); if (!info?.isDirectory() || info.isSymbolicLink()) return; chmodSync(directory, 0o700); for (const name of readdirSync(directory)) open(join(directory, name)); };
  open(path); rmSync(path, { recursive: true, force: true });
}
/** Current release id bound by service config.json (command/cwd), or null. */
export function currentRelease(paths, config) {
  // Config may name the canonical or the requested (e.g. /var vs /private/var) path.
  const roots = [...new Set([paths.releases, resolve(`${paths.stateFile}.service/releases`)])];
  const ids = [config?.command, config?.cwd].filter(value => typeof value === 'string').flatMap(value => roots.filter(root => inside(root, resolve(value))).map(root => resolve(value).slice(root.length + 1).split(sep)[0]));
  return ids.find(maintenanceId) ?? null;
}
export function retentionPlan(stateFile, { registry, config, journal, state } = {}) {
  const paths = ensureMaintenancePaths(stateFile);
  if (journal && !maintenanceTerminal(journal.phase)) throw maintenanceFailure('有未完成的维护操作；完成或接续后再整理保留。', 'maintenance_active');
  const current = currentRelease(paths, config), protectedCheckpoints = new Set();
  // A state reconciled after restore points at its pre-review checkpoint.
  const recovery = state?.applicationRecovery;
  if (maintenanceId(recovery?.preReviewCheckpointId)) protectedCheckpoints.add(recovery.preReviewCheckpointId);
  const candidates = registry.candidates.map((row, index) => ({ ...row, index })), keep = new Set(current ? [current] : []);
  const ordered = [...candidates].sort(byTime('preparedAt')), running = candidates.find(row => row.id === current);
  if (running) {
    const older = ordered.find(row => row.id !== current && String(row.preparedAt ?? '') <= String(running.preparedAt ?? '') && row.index !== running.index);
    const newer = ordered.find(row => row.id !== current && String(row.preparedAt ?? '') > String(running.preparedAt ?? ''));
    for (const row of [older, newer]) if (row) keep.add(row.id);
  } else for (const row of ordered.filter(row => row.id !== current).slice(0, current ? 1 : 2)) keep.add(row.id);
  const checkpoints = registry.checkpoints.map((row, index) => ({ ...row, index })).sort(byTime('createdAt'));
  const keptCheckpoints = new Set([...checkpoints.slice(0, RETENTION.checkpoints).map(row => row.id), ...protectedCheckpoints]);
  const plan = { stateFile: paths.stateFile, currentRelease: current, keep: { candidates: candidates.filter(row => keep.has(row.id)).map(row => row.id), checkpoints: [...new Set([...checkpoints.filter(row => keptCheckpoints.has(row.id)).map(row => row.id), ...protectedCheckpoints])] }, prune: [] };
  const add = (kind, id, directory, reason) => plan.prune.push({ kind, id, directory, reason, bytes: treeBytes(directory) });
  for (const row of candidates) if (!keep.has(row.id)) add('release', row.id, join(paths.releases, row.id), 'retention');
  for (const row of checkpoints) if (!keptCheckpoints.has(row.id)) add('checkpoint', row.id, join(paths.checkpoints, row.id), 'retention');
  // Unregistered leftovers: a crash after the registry rewrite, or an
  // abandoned staging directory. Protected ids are never treated as leftovers.
  const known = { release: new Set([...registry.candidates.map(row => row.id), ...(current ? [current] : [])]), checkpoint: new Set([...registry.checkpoints.map(row => row.id), ...protectedCheckpoints]) };
  for (const [kind, root] of [['release', paths.releases], ['checkpoint', paths.checkpoints]]) for (const name of names(root)) {
    const pending = PENDING.exec(name)?.[1];
    if (maintenanceId(name) && !known[kind].has(name) && !(kind === 'checkpoint' && !state)) add(kind, name, join(root, name), 'unregistered');
    else if (pending && !known[kind].has(pending)) add(kind, name, join(root, name), 'abandoned_staging');
  }
  // Shared release Node copies (<service>/node/<version>-<platform>-<arch>-<sha16>/node): keep the one the
  // service runs. Others are recreated from their release slot if that release is applied again.
  const runningNode = typeof config?.command === 'string' && basename(dirname(dirname(config.command))) === 'node' ? basename(dirname(config.command)) : null;
  for (const name of names(join(paths.directory, 'node'))) {
    if (name === runningNode || !/^(?:\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+-[a-f0-9]{16}|\..+\.pending-[a-f0-9-]{36})$/.test(name)) continue;
    add('node', name, join(paths.directory, 'node', name), 'unused_shared_node');
  }
  plan.bytes = plan.prune.reduce((sum, row) => sum + row.bytes, 0);
  return plan;
}
function inputs(stateFile) {
  const paths = ensureMaintenancePaths(stateFile);
  let state = null; try { state = readStateFile(paths.stateFile)?.state ?? null; } catch { /* unknown recovery binding: unregistered checkpoints are kept */ }
  return { registry: maintenanceRegistry(stateFile), config: readJSON(join(paths.directory, 'config.json')), journal: readMaintenance(stateFile), state };
}
/** Apply (or with dryRun only report) retention. Safe while the service runs. */
export async function applyRetention(stateFile, { dryRun = false } = {}) {
  if (dryRun) return { dryRun: true, ...retentionPlan(stateFile, inputs(stateFile)) };
  return withMaintenanceControl(stateFile, () => {
    const paths = ensureMaintenancePaths(stateFile), plan = retentionPlan(stateFile, inputs(stateFile));
    const drop = new Set(plan.prune.filter(row => row.reason === 'retention').map(row => `${row.kind}:${row.id}`));
    if (drop.size) {
      const registry = maintenanceRegistry(stateFile);
      atomicWrite(paths.registry, JSON.stringify({ ...registry, candidates: registry.candidates.filter(row => !drop.has(`release:${row.id}`)), checkpoints: registry.checkpoints.filter(row => !drop.has(`checkpoint:${row.id}`)) }));
    }
    const failed = [];
    for (const row of plan.prune) try { removeTree(row.directory); } catch (error) { failed.push({ id: row.id, code: error.code ?? 'remove_failed' }); }
    return { dryRun: false, ...plan, failed };
  });
}
const usage = 'maintenance prune [--dry-run] [--json] [--state <state.json>]';
export async function runRetentionCli(args, { stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(import.meta.dirname, '.state/state.json')) } = {}) {
  const flags = new Set();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--state' && args[index + 1]) stateFile = resolve(args[++index]);
    else if (['--dry-run', '--json'].includes(args[index]) && !flags.has(args[index])) flags.add(args[index]);
    else throw new Error(usage);
  }
  const result = await applyRetention(stateFile, { dryRun: flags.has('--dry-run') });
  return { json: flags.has('--json'), result };
}
export function retentionText(result) {
  const mb = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  const lines = [`${result.dryRun ? '预览（未删除）' : '已整理'}：${result.prune.length} 项，${mb(result.bytes)}；运行中版本 ${result.currentRelease ?? '未托管'}`];
  lines.push(`保留版本：${result.keep.candidates.join(', ') || '无'}`, `保留恢复点：${result.keep.checkpoints.join(', ') || '无'}`);
  for (const row of result.prune) lines.push(`- ${({ release: '版本', checkpoint: '恢复点', node: '共享 Node' })[row.kind] ?? row.kind} ${row.id} · ${mb(row.bytes)} · ${row.reason}`);
  for (const row of result.failed ?? []) lines.push(`! 未能删除 ${row.id}（${row.code}），下次整理会重试`);
  return lines.join('\n');
}
