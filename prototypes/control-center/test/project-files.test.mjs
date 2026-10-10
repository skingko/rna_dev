import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { removeProjectFiles, sweepProjectFiles, removeProjectRunFiles, pruneRunJournals, RUN_JOURNAL_RETENTION_DAYS } from '../project-files.mjs';

// A deleted project's private folders go with it; its workspace stays.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-project-files-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json'), workspace = join(dir, 'workspace'); mkdirSync(workspace);
  const store = new Store(file);
  const seed = id => { for (const root of ['genomes', 'evolution', 'initialization']) { mkdirSync(join(`${file}.${root}`, id, 'v1'), { recursive: true }); writeFileSync(join(`${file}.${root}`, id, 'v1', 'x'), 'x'); } mkdirSync(`${file}.observations`, { recursive: true }); writeFileSync(join(`${file}.observations`, `${id}.json`), '{}'); };
  return { dir, file, store, workspace, seed };
}
const present = (file, id) => ['genomes', 'evolution', 'initialization'].map(root => existsSync(join(`${file}.${root}`, id))).concat(existsSync(join(`${file}.observations`, `${id}.json`)));

test('deleting a project removes its genome, evolution, initialization and observation folders, not its workspace', async t => {
  const f = fixture(t), { project } = f.store.createProject({ name: 'Gone', workspace: f.workspace });
  f.seed(project.id); writeFileSync(join(f.workspace, 'chapter.md'), 'kept');
  f.store.deleteProject(project.id);
  for (let i = 0; i < 50 && present(f.file, project.id).some(Boolean); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(present(f.file, project.id), [false, false, false, false]);
  assert.equal(existsSync(join(f.workspace, 'chapter.md')), true);
});

test('startup sweep removes folders of projects that no longer exist; live projects, the system folder and odd names stay', async t => {
  const f = fixture(t), { project } = f.store.createProject({ name: 'Live', workspace: f.workspace });
  const orphan = '251ded93-1e75-48f4-957c-e8e8592ea65a';
  f.seed(project.id); f.seed(orphan); mkdirSync(join(`${f.file}.evolution`, '_system'), { recursive: true }); mkdirSync(join(`${f.file}.genomes`, 'not-a-project'), { recursive: true });
  const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'x');
  symlinkSync(outside, join(`${f.file}.genomes`, '32ac6e07-3f69-47a6-8e9a-ce9a50c3c015'));
  const removed = await sweepProjectFiles(f.file, f.store.state.projects.map(row => row.id));
  assert.equal(removed.filter(path => path.includes(orphan)).length, 4);
  assert.deepEqual(present(f.file, orphan), [false, false, false, false]); assert.deepEqual(present(f.file, project.id), [true, true, true, true]);
  assert.equal(existsSync(join(`${f.file}.evolution`, '_system')), true); assert.equal(existsSync(join(`${f.file}.genomes`, 'not-a-project')), true);
  assert.equal(existsSync(join(outside, 'keep')), true, 'a link is removed, never followed');
  assert.deepEqual(await removeProjectFiles(f.file, '../escape'), []);
});

// Review X-3: what a project's background runs left (journals, archives, learning reviews, skill-foundation drafts).
const runRoots = (file, id) => [join(`${file}.rna`, 'initiative', id), join(`${file}.archive`, 'initiative', id), join(`${file}.archive`, 'learning', id), join(`${file}.archive`, 'inbox', id), join(`${file}.archive`, 'observations', id), join(`${file}.archive`, 'memory', id), join(`${file}.skill-foundation`, id)];
const seedRuns = (file, id) => { for (const dir of runRoots(file, id)) { mkdirSync(join(dir, 'x'), { recursive: true }); writeFileSync(join(dir, 'x', 'f'), 'run'); } };

test('a deleted project\'s run roots are removed by id; conversation journals and other projects stay', async t => {
  const f = fixture(t), gone = '251ded93-1e75-48f4-957c-e8e8592ea65a', live = '32ac6e07-3f69-47a6-8e9a-ce9a50c3c015';
  seedRuns(f.file, gone); seedRuns(f.file, live);
  mkdirSync(join(`${f.file}.rna`, '5487d43c-7f3a-491b-9a50-0336d4528ce0'), { recursive: true });
  const removed = await removeProjectRunFiles(f.file, gone);
  assert.equal(removed.length, 7); assert.ok(runRoots(f.file, gone).every(path => !existsSync(path))); assert.ok(runRoots(f.file, live).every(path => existsSync(path)));
  assert.equal(existsSync(join(`${f.file}.rna`, '5487d43c-7f3a-491b-9a50-0336d4528ce0')), true, 'a conversation journal directly under .rna is never a project root');
  assert.deepEqual(await removeProjectRunFiles(f.file, '../escape'), []);
});

test('the sweep removes run roots of deleted projects, except those whose conversation deletions have not settled', async t => {
  const f = fixture(t), { project } = f.store.createProject({ name: 'Live', workspace: f.workspace });
  const settled = '251ded93-1e75-48f4-957c-e8e8592ea65a', waiting = '2146e1f5-5baa-4436-a322-d4435108e110';
  for (const id of [project.id, settled, waiting]) seedRuns(f.file, id);
  await sweepProjectFiles(f.file, [project.id], { keep: [waiting] });
  assert.ok(runRoots(f.file, settled).every(path => !existsSync(path)));
  assert.ok(runRoots(f.file, waiting).every(path => existsSync(path))); assert.ok(runRoots(f.file, project.id).every(path => existsSync(path)));
});

test('live run journals stay while their row is in state and go 30 days after it was archived', async t => {
  const f = fixture(t), id = '6132c1bb-c353-4763-b122-3a811f8403e9', now = Date.now(), day = 86400000;
  const journal = name => { const dir = join(`${f.file}.rna`, 'initiative', id, name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'x.rna.jsonl'), '{}\n'); return dir; };
  const archive = (name, at) => { const text = JSON.stringify({ id: name, status: 'completed' }), dir = join(`${f.file}.archive`, 'initiative', id, 'actions'); mkdirSync(dir, { recursive: true }); const path = join(dir, `${createHash('sha256').update(text).digest('hex')}.json`); writeFileSync(path, text); utimesSync(path, new Date(at), new Date(at)); };
  const age = (dir, at) => { for (const name of readdirSync(dir)) utimesSync(join(dir, name), new Date(at), new Date(at)); utimesSync(dir, new Date(at), new Date(at)); };
  const inState = journal('in-state'), oldArchived = journal('archived-long-ago'), freshArchived = journal('archived-recently'), orphan = journal('no-row-anywhere'), busy = journal('locked-run');
  writeFileSync(join(busy, 'x.rna.jsonl.lock'), JSON.stringify({ pid: process.pid }));
  for (const dir of [inState, oldArchived, freshArchived, orphan, busy]) age(dir, now - 90 * day);
  archive('archived-long-ago', now - 31 * day); archive('archived-recently', now - 5 * day);
  const project = { id, initiativeRuntime: { sdkState: { actions: [{ id: 'in-state', status: 'completed' }] } }, jobs: [] };
  const removed = await pruneRunJournals(f.file, project, { now });
  assert.deepEqual(removed.map(path => path.split('/').at(-1)).sort(), ['archived-long-ago', 'no-row-anywhere']);
  for (const dir of [inState, freshArchived, busy]) assert.equal(existsSync(dir), true);
  assert.equal(RUN_JOURNAL_RETENTION_DAYS, 30);
});
