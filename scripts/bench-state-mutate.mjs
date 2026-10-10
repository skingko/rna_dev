#!/usr/bin/env node
// Store.mutate benchmark on a large state (H1). Measures CPU and wall time,
// fsync calls and bytes written per commit for typical mutations, including a
// 7-mutate turn start. Never writes the source state: it is copied into a
// temporary directory first.
//
//   node scripts/bench-state-mutate.mjs [--from <state.json>] [--code <control-center dir>] [--rounds N] [--json]
//
// --from   read a real state (read-only, via readStateFile); default: synthetic ~10 MB
// --code   control-center checkout to measure (default: this checkout), e.g. a
//          `git archive` of the previous release for before/after numbers
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const code = resolve(option('--code', join(import.meta.dirname, '../prototypes/control-center'))), rounds = Number(option('--rounds', 20)), from = option('--from');
const { Store } = await import(join(code, 'store.mjs'));
const { readStateFile, writeStateFile } = await import(join(code, 'state-shards.mjs'));

const text = size => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(size / 27)).slice(0, size);
function synthetic() {
  const now = new Date(0).toISOString(), items = count => Array.from({ length: count }, (_, i) => ({ id: randomUUID(), turnId: null, kind: i % 3 ? 'assistant' : 'tool', text: text(400 + (i % 11) * 250), createdAt: now, simulated: false, ...(i % 3 ? {} : { tool: { name: 'read', args: { path: `src/${i}.js` }, status: 'completed', output: text(900) } }) }));
  const session = (id, count) => ({ id, title: `session ${id.slice(0, 4)}`, workspace: '/tmp', model: 'fixture', mode: 'build', status: 'idle', pauseReason: null, createdAt: now, updatedAt: now, archivedAt: null, activeTurnId: null, items: items(count), turns: Array.from({ length: Math.ceil(count / 4) }, (_, i) => ({ id: randomUUID(), status: 'completed', createdAt: now, usage: { input: i, output: i } })), inbox: [], artifacts: [], plan: [], context: { tokens: 0, capacity: 128000, compactions: 0 }, usage: { usd: 0, tokens: 0 }, submissions: [], simulated: false });
  const sessions = [session(randomUUID(), 2800), session(randomUUID(), 160), session(randomUUID(), 40), ...Array.from({ length: 3 }, () => session(randomUUID(), 6))];
  const projects = [4, 2].map(size => ({ id: randomUUID(), name: 'project', archivedAt: null, jobs: Array.from({ length: 300 * size }, (_, i) => ({ id: randomUUID(), status: 'completed', summary: text(900), at: now, index: i })), versions: Array.from({ length: 40 * size }, () => ({ id: randomUUID(), state: 'rejected', bundle: { files: [{ path: 'SKILL.md', content: text(6000) }] } })) }));
  return { version: 2, revision: 1, sequence: 0, tasks: [], events: Array.from({ length: 1000 }, (_, i) => ({ id: i, type: 'x', message: 'event', at: now })), sessions, projects, goals: [], settings: { dailyBudget: 10, tokenBudget: 1e9 }, usage: { usd: 0, tokens: 0 }, realUsage: { tokens: 0 }, emergency: false };
}

const directory = mkdtempSync(join(tmpdir(), 'rna-bench-')), file = join(directory, 'state.json');
try {
  const source = from ? readStateFile(resolve(from)).state : synthetic();
  writeStateFile(file, source);
  const store = new Store(file), bytes = JSON.stringify(store.state).length;
  const big = store.state.sessions.reduce((a, b) => (a.items.length >= b.items.length ? a : b)).id, small = store.state.sessions.find(row => row.id !== big).id;
  let fsyncs = 0; const sync = fs.fsyncSync; fs.fsyncSync = fd => { fsyncs++; return sync(fd); }; syncBuiltinESMExports();
  const measure = (name, fn) => {
    const cpu = process.cpuUsage(), wall = performance.now(), before = fsyncs; fn();
    const used = process.cpuUsage(cpu); return { name, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - wall, fsyncs: fsyncs - before, writtenBytes: store.persistence.writtenBytes };
  };
  const find = (state, id) => state.sessions.find(row => row.id === id);
  const cases = {
    'append item (large session)': () => store.mutate(state => { find(state, big).items.push({ id: randomUUID(), kind: 'notice', text: 'hello', createdAt: new Date().toISOString() }); }),
    'rename (small session)': () => store.mutate(state => { find(state, small).title = `renamed ${randomUUID()}`; }),
    'root counter (token accounting)': () => store.mutate(state => { state.realUsage.tokens = (state.realUsage.tokens ?? 0) + 17; }),
    'turn start (7 mutates)': () => {
      const turnId = randomUUID(), itemId = randomUUID();
      store.mutate(state => { const s = find(state, big); s.items.push({ id: randomUUID(), turnId, kind: 'user', text: 'question', createdAt: new Date().toISOString() }); s.turns.push({ id: turnId, status: 'running', createdAt: new Date().toISOString() }); s.activeTurnId = turnId; s.status = 'running'; });
      store.mutate(state => { find(state, big).runtime = { engine: 'rna', sessionFile: '/tmp/x', updatedAt: new Date().toISOString() }; });
      store.mutate(state => { state.realUsage.reserved = { [turnId]: 40000 }; });
      store.mutate(state => { find(state, big).turns.at(-1).phase = 'preparing_context'; });
      store.mutate(state => { find(state, big).context = { tokens: 120000, capacity: 1000000, compactions: 0 }; });
      store.mutate(state => { find(state, big).items.push({ id: itemId, turnId, kind: 'assistant', text: '', streaming: true, createdAt: new Date().toISOString() }); });
      store.mutate(state => { find(state, big).turns.at(-1).firstRequestAt = new Date().toISOString(); });
    }
  };
  for (const run of Object.values(cases)) run(); // warm-up (first generation after load checkpoints)
  const results = Object.entries(cases).map(([name, run]) => {
    const rows = Array.from({ length: rounds }, () => measure(name, run)), median = key => rows.map(row => row[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    return { name, cpuMs: +median('cpuMs').toFixed(2), wallMs: +median('wallMs').toFixed(2), fsyncs: median('fsyncs'), maxFsyncs: Math.max(...rows.map(row => row.fsyncs)), writtenBytes: median('writtenBytes') };
  });
  fs.fsyncSync = sync; syncBuiltinESMExports();
  const report = { code, stateBytes: bytes, rounds, results };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`state ${(bytes / 1024 ** 2).toFixed(1)} MB · ${code}`);
    for (const row of results) console.log(`${row.name.padEnd(34)} cpu ${String(row.cpuMs).padStart(7)} ms  wall ${String(row.wallMs).padStart(7)} ms  fsync ${row.fsyncs} (max ${row.maxFsyncs})  written ${row.writtenBytes} B`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
