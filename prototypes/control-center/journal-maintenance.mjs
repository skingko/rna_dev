import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { acquireProcessLease } from './process-lease.mjs';
import { compactJournal, removeCompactionBackups } from '../../packages/sdk/src/journal-compaction.mjs';

/* `rna maintenance compact-journals`: offline compaction of per-token stream
 * telemetry in existing session journals (`<state>.rna/**.rna.jsonl`). Service
 * checkpoints and restore points are never touched. A real run holds the
 * state's process lease, so it refuses while the service runs, and each
 * journal's own writer lock. Every rewrite is verified before it replaces the
 * journal; the original stays as `<journal>.precompact-<time>-<records>` until
 * `--remove-backups` confirms and removes it. Idempotent. */
const usage = 'maintenance compact-journals [--dry-run] [--remove-backups] [--json] [--state <state.json>]';
export function sessionJournals(stateFile) {
  const found = [], walk = directory => {
    let names; try { names = readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names.sort()) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(path);
      else if (info.isFile() && name.endsWith('.rna.jsonl')) found.push(path);
    }
  };
  walk(`${resolve(stateFile)}.rna`);
  return found;
}
export async function compactJournals(stateFile, { dryRun = false, removeBackups = false } = {}) {
  const files = sessionJournals(stateFile), unlock = dryRun ? () => {} : await acquireProcessLease(`${resolve(stateFile)}.lock`, { purpose: 'journal-compaction' });
  try {
    const journals = [];
    for (const file of files) {
      try { journals.push(removeBackups ? removeCompactionBackups(file, { dryRun }) : compactJournal(file, { dryRun })); }
      catch (error) { journals.push({ file, failed: true, code: error.code ?? 'compaction_failed', message: error.message }); }
    }
    const sum = key => journals.reduce((total, row) => total + (row[key] ?? 0), 0);
    return { dryRun, removeBackups, stateFile: resolve(stateFile), journals, bytes: sum('bytes'), compactedBytes: journals.reduce((total, row) => total + (row.compactedBytes ?? row.bytes ?? 0), 0), mergedEvents: sum('mergedEvents'), removedBackups: journals.flatMap(row => row.removed ?? []), failed: journals.filter(row => row.failed) };
  } finally { unlock(); }
}
export async function runJournalCompactionCli(args, { stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(import.meta.dirname, '.state/state.json')) } = {}) {
  const flags = new Set();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--state' && args[index + 1]) stateFile = resolve(args[++index]);
    else if (['--dry-run', '--json', '--remove-backups'].includes(args[index]) && !flags.has(args[index])) flags.add(args[index]);
    else throw new Error(usage);
  }
  return { json: flags.has('--json'), result: await compactJournals(stateFile, { dryRun: flags.has('--dry-run'), removeBackups: flags.has('--remove-backups') }) };
}
export function journalCompactionText(result) {
  const mb = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`, name = file => relative(dirname(result.stateFile), file);
  if (result.removeBackups) {
    const lines = [`${result.dryRun ? '预览（未删除）' : '已删除'}：${result.removedBackups.length} 个整理前备份，${mb(result.removedBackups.reduce((total, row) => total + (row.bytes ?? 0), 0))}`];
    for (const row of result.journals) for (const backup of row.kept ?? []) lines.push(`- 保留 ${name(backup)}（与当前日志不一致或无法核对）`);
    for (const row of result.failed) lines.push(`! ${name(row.file)}：${row.code}`);
    return lines.join('\n');
  }
  const changed = result.journals.filter(row => row.mergedEvents && !row.skipped);
  const lines = [`${result.dryRun ? '预览（未改写）' : '已整理'}：${result.journals.length} 个会话日志，${changed.length} 个可合并；${mb(result.bytes)} → ${mb(result.compactedBytes)}，合并 ${result.mergedEvents} 条逐字流事件`];
  for (const row of changed) lines.push(`- ${name(row.file)} · ${mb(row.bytes)} → ${mb(row.compactedBytes)}${row.backup ? ` · 原文件保留为 ${name(row.backup)}` : ''}`);
  for (const row of result.journals.filter(row => row.skipped === 'torn_tail')) lines.push(`- 跳过 ${name(row.file)}：末尾有未完成写入，先打开一次会话以恢复`);
  for (const row of result.failed) lines.push(`! ${name(row.file)}：${row.code}${row.code === 'journal_locked' ? '（会话仍在使用）' : ''}`);
  if (!result.dryRun && changed.length) lines.push('核对无误后运行 maintenance compact-journals --remove-backups 删除整理前备份。');
  return lines.join('\n');
}
