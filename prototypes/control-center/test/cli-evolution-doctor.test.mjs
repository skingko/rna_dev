import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server.mjs';
import { evolutionSummary, evolutionSection } from '../cli-evolution.mjs';

// P2 batch D, D3: `./rna doctor` has an evolution section — where each lane is and why nothing happens, what every rule was
// run or shown for, what became of lessons and corrections, the work's outcomes by generation, the scoreboard, the harm readings.
const exec = promisify(execFile), cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const DAY = 86400000;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-doctor-evolution-')), file = join(directory, 'state.json');
  const app = createServer({ stateFile: file, ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const env = { ...process.env, RNA_AGENT_PORT: String(app.server.address().port), PI_FORGE_PORT: '1' };
  // The doctor's memory check fails on a project with no memory backend: its exit status is not the subject here, its output is.
  const doctor = async (...args) => { try { return JSON.parse((await exec(process.execPath, [cli, 'doctor', ...args], { env, timeout: 20000 })).stdout); } catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error; } };
  return { ...app, directory, doctor };
}

test('doctor: every project that is not archived gets an evolution section; the named one alone with its id', async t => {
  const f = await fixture(t);
  f.store.genes.enabled = true;
  const { project } = f.store.createProject({ name: '玄幻小说', workspace: f.directory });
  const second = f.store.createProject({ name: '日报', workspace: join(f.directory, 'daily') });
  const now = Date.now(), at = days => new Date(now - days * DAY).toISOString();
  f.store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.genes = { genes: [
      { id: 'guard:never', layer: 'guard', key: 'never', title: '没运行过', status: 'trial', generation: 2, runs: 0, hits: 0, body: { toolId: 'guard_never' }, history: [] },
      { id: 'guard:busy', layer: 'guard', key: 'busy', title: '常跑的', status: 'active', generation: 2, runs: 9, hits: 3, stats: { real: 2 }, exposure: { days: { [new Date().toLocaleDateString('sv')]: { ran: 4 } } }, body: { toolId: 'guard_busy' }, history: [] },
      { id: 'skill-patch:p', layer: 'skill', key: 'p', title: '先核对数字', status: 'trial', generation: 3, stats: { injected: 9, applied: 0 }, body: { skillId: 'project-workflow', expectation: '数字不再出错' }, origin: { kind: 'correction', scheduleIds: ['s1'] }, history: [], createdAt: at(3) }],
      generations: [{ n: 1, at: at(20), summary: 'a', trigger: 'feedback' }, { n: 2, at: at(10), summary: 'b', trigger: 'feedback' }, { n: 3, at: at(3), summary: 'c', trigger: 'correction' }],
      dispositions: [{ at: at(1), kind: 'terminal', code: 'judged_no' }], contrasts: [{ at: at(2), turns: 9, trouble: 3, pairs: 1, clusters: 1, analyzed: true, patches: 1, committed: 1 }], funnel: { since: at(30), B: { corrections: 4 } } };
  });
  const doctor = await f.doctor();
  assert.ok(Array.isArray(doctor.evolution), JSON.stringify(doctor.evolution));
  const row = doctor.evolution.find(entry => entry.projectId === project.id);
  assert.deepEqual([row.name, row.enabled], ['玄幻小说', true]);
  assert.deepEqual(row.exposure.guards, { live: 2, neverRan: 1, ranLast7Days: 4, trackedLast7Days: 1, realCatches: 2 }, 'the check that never ran has no days to count; only the busy one is tracked');
  assert.deepEqual([row.exposure.rules.live, row.exposure.rules.shown, row.exposure.rules.followed, row.exposure.rules.exposureRecorded], [1, 9, 0, 1]);
  assert.equal(row.exposure.rules.earnedNothing, 1, 'shown 9 times and never followed');
  assert.deepEqual(row.generation.n, 3); assert.equal(row.lanes.A.state, 'idle'); assert.equal(row.lanes.C.state, 'waiting'); assert.equal(row.lanes.C.needed, 3);
  assert.deepEqual(row.dispositions.corrections, { terminal: { judged_no: 1 } });
  assert.deepEqual([row.analyses.length, row.analyses[0].pairs, row.analyses[0].patches], [1, 1, 1]);
  assert.deepEqual(row.scoreboard, { held: 1, correctedAgain: 0, pending: 2 }, 'the busy check caught real problems; the other two have nothing yet');
  assert.equal(row.funnel.B.corrections, 4);
  assert.ok(row.notes.length >= 1 && row.notes.some(note => /never run|还没运行过/.test(note)), row.notes.join(' | '));
  assert.ok(doctor.evolution.some(entry => entry.projectId === second.project.id), 'every project that is not archived');
  // Archived: not listed. Named: that one alone.
  f.store.mutate(state => { state.projects.find(entry => entry.id === second.project.id).archivedAt = new Date().toISOString(); });
  assert.deepEqual((await f.doctor()).evolution.map(entry => entry.projectId), [project.id]);
  assert.deepEqual((await f.doctor(project.id)).evolution.map(entry => entry.projectId), [project.id]);
  // The doctor's other sections are as they were.
  assert.ok(doctor.daemon && doctor.runtime && doctor.memory && doctor.experience);
});

test('evolutionSummary reads a bare view, and one that cannot be read says so without stopping the others', async () => {
  const bare = evolutionSummary({ id: 'p', name: 'x' }, { enabled: false, status: {}, genes: [], notes: [] });
  assert.deepEqual([bare.enabled, bare.generation, bare.exposure.guards.live, bare.exposure.rules.live, bare.outcomes.total, bare.bloat, bare.harm, bare.scoreboard.pending], [false, null, 0, 0, 0, null, [], 0]);
  const calls = [];
  const rows = await evolutionSection(async path => { calls.push(path); if (path === '/v2/bootstrap') return { projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', archivedAt: 'x' }, { id: 'c', name: 'C' }] }; if (path.includes('/c/')) throw new Error('offline'); return { enabled: true, status: {}, genes: [], notes: [] }; });
  assert.deepEqual(rows.map(entry => [entry.projectId, entry.available ?? true, entry.error ?? null]), [['a', true, null], ['c', false, 'offline']]);
  assert.deepEqual(calls, ['/v2/bootstrap', '/v2/projects/a/genes/observability', '/v2/projects/c/genes/observability']);
  assert.deepEqual((await evolutionSection(async path => ({ enabled: true, status: {}, genes: [], notes: [], path }), 'z')).map(entry => entry.projectId), ['z']);
});

test('the harm readings and the bloat evidence reach the doctor: a rule under watch is named, with the matched pairs and the rates', () => {
  const view = { enabled: true, status: { generation: { n: 3 }, A: {}, B: {}, C: {} }, genes: [{ layer: 'skill', shown: 12, recalled: 3, applied: 0, injectedRecent: 5, ran: 0 }], notes: ['n'],
    harm: [{ geneId: 'skill-patch:p', state: 'watching', shared: 3, before: { rate: 0 }, after: { rate: 0.67 } }, { geneId: 'skill-patch:q', state: 'ok', shared: 4, before: { rate: 0.1 }, after: { rate: 0.1 } }],
    bloat: { ratio: 1.7, minimum: 4, rules: [{ unproven: true }, { unproven: false }] }, scoreboard: [{ verdict: 'held' }, { verdict: 'again' }, { verdict: 'again' }] };
  const summary = evolutionSummary({ id: 'p' }, view);
  assert.deepEqual(summary.harm, [{ geneId: 'skill-patch:p', state: 'watching', matchedPairs: 3, correctedBefore: 0, correctedAfter: 0.67 }]);
  assert.deepEqual(summary.bloat, { promptGrowth: 1.7, earnedNothing: 1, startsAt: 4 });
  assert.deepEqual(summary.scoreboard, { held: 1, correctedAgain: 2, pending: 0 });
  assert.equal(summary.exposure.rules.injectedLast7Days, 5);
});

test('a check that ran before its runs were counted by day has no last-7-days number in the doctor: unknown, not dead', () => {
  const guard = (ran, ranRecent) => ({ layer: 'guard', ran, ranRecent, real: 0 });
  assert.deepEqual(evolutionSummary({ id: 'p' }, { genes: [guard(98, null), guard(40, null)] }).exposure.guards, { live: 2, neverRan: 0, ranLast7Days: null, trackedLast7Days: 0, realCatches: 0 });
  assert.deepEqual(evolutionSummary({ id: 'p' }, { genes: [guard(98, null), guard(40, 0)] }).exposure.guards, { live: 2, neverRan: 0, ranLast7Days: 0, trackedLast7Days: 1, realCatches: 0 }, 'a counted quiet week is 0');
});
