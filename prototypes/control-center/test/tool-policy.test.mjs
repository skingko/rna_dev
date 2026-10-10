import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ensureMind } from '../project-mind.mjs';
import { GeneEvolutionService } from '../gene-evolution-service.mjs';
import { DiagnosticsService } from '../diagnostics-service.mjs';
import { ToolPolicy, lineMap, subtractBaseline, sameHit, sameDiagnostic, guardScript, sweepReport } from '../tool-policy.mjs';
import { authorizationRejection } from '../../../packages/sdk/src/prompt-layers.mjs';
import { installFakeTypescript } from './helpers/fake-typescript.mjs';

// Plan 2026-10-05 §2.2 B1: one ToolPolicy for every purpose, and one pre-write baseline shared by guards and
// diagnostics (mu lsp.ts:243-247, lsp-diagnostics.md §1-3): what a file already had before a run wrote it is counted,
// not handed to the model to fix. Real guard scripts and the real JSON checker; JEV judges are stubs.
const GUARD_TOOL = { id: 'todo_guard', name: 'TODO check', description: 'Flags TODO lines. Takes {path}.', permission: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  script: "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'left a TODO' }); }); return { hits, summary: hits.length + ' found' };" };
const GENE_ID = 'guard:todo_guard';
function world(t, { decisions = {}, diagnostics: options = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-tool-policy-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'project'); mkdirSync(join(workspace, 'notes'), { recursive: true });
  const store = new Store(join(dir, 'state', 'state.json'));
  const { project } = store.createProject({ name: 'Notes', workspace, initiative: { enabled: false } });
  store.mutate(state => {
    const row = state.projects.find(item => item.id === project.id); ensureMind(row);
    row.versions = [{ id: 'v1', state: 'active', bundle: { genome: { tools: [GUARD_TOOL] } } }]; row.activeVersionId = 'v1';
    row.genes = { genes: [{ id: GENE_ID, layer: 'guard', key: 'todo_guard', title: 'TODO check', summary: 'No TODO left in notes.', status: 'active', body: { toolId: 'todo_guard', trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: new Date().toISOString(), history: [] }], generations: [] };
  });
  const genes = new GeneEvolutionService(store, { decisions, enabled: false });
  const diagnostics = new DiagnosticsService({ store, decisions, ...options }); t.after(() => diagnostics.close());
  const policy = new ToolPolicy({ decisions, genes, diagnostics });
  const current = () => store.state.projects.find(row => row.id === project.id);
  const gene = () => current().genes.genes.find(row => row.id === GENE_ID);
  const run = (keys = { turnId: 'turn-1' }, root = workspace) => policy.forRun({ projectId: project.id, getProject: current, root, purpose: 'foreground', request: 'Tidy the notes.', ...keys });
  const tool = name => ({ name, effect: 'write' });
  // A write the way project_write reports it: details.path is the absolute resolved target.
  const write = async (hooks, path, content, { args = { path, content } } = {}) => {
    const verdict = await hooks.before({ tool: tool('project_write'), args });
    if (verdict?.block) return { verdict };
    writeFileSync(join(workspace, path), content);
    const after = await hooks.after({ tool: tool('project_write'), args, result: { content: [{ type: 'text', text: `Saved ${path}` }], details: { path: join(workspace, path) } }, isError: false });
    return { verdict, after, text: after?.content?.map(block => block.text).join('') ?? '' };
  };
  return { dir, workspace, store, project, genes, diagnostics, policy, current, gene, run, write, tool };
}

test('lineMap and subtractBaseline: a finding the edit only moved is old; duplicates pair by count; the same text in a new place is new', () => {
  const before = 'a\nTODO one\nb\n', after = 'x\ny\na\nTODO one\nb\nTODO one\n', map = lineMap(before, after);
  assert.deepEqual(map(2), { from: 4, to: 4 }, 'two lines inserted above move line 2 to line 4');
  const old = [{ line: 2, excerpt: 'TODO one', note: 'n' }], now = [{ line: 4, excerpt: 'TODO one', note: 'n' }, { line: 6, excerpt: 'TODO one', note: 'n' }];
  const split = subtractBaseline(now, old, map, sameHit);
  assert.deepEqual(split.old.map(row => row.line), [4]); assert.deepEqual(split.fresh.map(row => row.line), [6]);
  // A changed line maps to the span between its unchanged neighbours (mu lineMap).
  assert.deepEqual(lineMap('a\nold\nb', 'a\nnew one\nnew two\nb')(2), { from: 2, to: 3 });
  // Without positions (no line, or the file could not be read again) only identity and count decide.
  assert.deepEqual(subtractBaseline([{ excerpt: 'x' }, { excerpt: 'x' }], [{ excerpt: 'x' }], null, sameHit).fresh.length, 1);
  assert.equal(subtractBaseline([{ severity: 'error', code: 'E', message: 'm', line: 9 }], [{ severity: 'error', code: 'E', message: 'other', line: 9 }], null, sameDiagnostic).fresh.length, 1, 'a different message is a different problem');
});

test('guards: hits already in the file before the run are counted, not handed to the model; new ones are, with their lines', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'Intro\nTODO old one\n');
  const hooks = f.run();
  const first = await f.write(hooks, 'notes/a.md', 'Intro\nTODO old one\nMore text\nTODO new one\n');
  assert.match(first.text, /\[Automatic checks\] “TODO check”: 1 hit to fix\n- line 4: TODO new one \(left a TODO\)/);
  assert.match(first.text, /1 hit already in this file before this run's writes; counted only/);
  assert.doesNotMatch(first.text, /- line \d+: TODO old one/, 'the old hit is not listed to fix');
  assert.deepEqual(first.after.details.guards, [{ gene: GENE_ID, title: 'TODO check', hits: 1, old: 1 }]);
  assert.equal(f.gene().runs, 1, 'the baseline run is not a use; the write\'s run is'); assert.equal(f.gene().hits, 2, 'all hits are counted');
  assert.deepEqual(f.gene().turns, ['turn-1']);
  // A later write in the same run compares with the file as it was before the run: the hit this run added stays new.
  const second = await f.write(hooks, 'notes/a.md', 'Intro\nNew first line\nTODO old one\nMore text\nTODO new one\n');
  assert.match(second.text, /1 hit to fix\n- line 5: TODO new one/); assert.match(second.text, /1 hit already in this file/);
  // Clean of new hits, with old ones: a count only, nothing to fix.
  const clean = await f.write(f.run({ turnId: 'turn-2' }), 'notes/a.md', 'Intro\nNew first line\nTODO old one\nMore text\n');
  assert.doesNotMatch(clean.text, /to fix/); assert.match(clean.text, /1 hit already in this file/);
});

test('guards: after the user accepted fixing a check\'s existing hits, old hits are handed to the model too — for the script they accepted it for', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\n');
  f.genes.genes.record(f.project.id, GENE_ID, gene => { gene.fixHitsAccepted = { at: new Date().toISOString(), script: guardScript(GUARD_TOOL) }; });
  const { text, after } = await f.write(f.run(), 'notes/a.md', 'TODO old one\nText\n');
  assert.match(text, /1 hit to fix \(the user asked to fix this check's existing hits too\)\n- line 1: TODO old one/);
  assert.equal(after.details.guards[0].fixHitsAccepted, true);
  // The check is revised (it now catches more); nobody agreed to fix what the new script finds in old text.
  f.store.mutate(state => { const tool = state.projects.find(row => row.id === f.project.id).versions[0].bundle.genome.tools[0]; tool.script = tool.script.replace('/TODO/', '/TODO|FIXME/'); });
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\nFIXME old two\n');
  const revised = await f.write(f.run({ turnId: 'turn-2' }), 'notes/a.md', 'TODO old one\nFIXME old two\nText\n');
  assert.doesNotMatch(revised.text, /to fix/, 'a revised check\'s old hits are counted, not handed to the model');
  assert.match(revised.text, /2 hits already in this file before this run's writes; counted only/);
  assert.equal(revised.after.details.guards[0].fixHitsAccepted, undefined);
});

test('guards: only new hits are triaged by JEV, so old hits never inflate real catches', async t => {
  const triaged = [];
  const f = world(t, { decisions: { guardTriage: async (_project, input) => { triaged.push(input.hits.map(hit => hit.excerpt)); return { real: [0], falseMatches: [], unsure: [] }; } } });
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\nTODO old two\n');
  await f.write(f.run(), 'notes/a.md', 'TODO old one\nTODO old two\nTODO new one\n');
  assert.deepEqual(triaged, [['TODO new one']]);
  assert.equal(f.gene().stats.real, 1);
});

test('the run\'s keys: a background run records guard runs with turnId null; a subagent counts under its parent turn in its own root', async t => {
  const f = world(t);
  const worker = join(f.dir, 'worker'); mkdirSync(join(worker, 'notes'), { recursive: true });
  const background = await f.write(f.run({ actionId: 'action-1' }), 'notes/b.md', 'TODO from the background\n');
  assert.match(background.text, /1 hit to fix/); assert.deepEqual(f.gene().turns ?? [], [], 'no foreground turn is charged');
  const hooks = f.run({ parentTurnId: 'parent-turn' }, worker), args = { path: 'notes/c.md', content: 'TODO from a worker\n' };
  await hooks.before({ tool: f.tool('project_write'), args });
  writeFileSync(join(worker, 'notes', 'c.md'), args.content);
  const after = await hooks.after({ tool: f.tool('project_write'), args, result: { content: [], details: { path: join(worker, 'notes', 'c.md') } }, isError: false });
  assert.match(after.content[0].text, /line 1: TODO from a worker/, 'the guard read the file in the worker\'s root');
  assert.deepEqual(f.gene().turns, ['parent-turn']);
});

test('matching uses the resolved path the write reports, not the raw argument; private and outside paths are skipped', async t => {
  const f = world(t);
  const hooks = f.run(), args = { path: './notes/../notes/d.md', content: 'TODO resolved\n' };
  await hooks.before({ tool: f.tool('project_write'), args });
  writeFileSync(join(f.workspace, 'notes', 'd.md'), args.content);
  const after = await hooks.after({ tool: f.tool('project_write'), args: { path: 'not/matching.txt' }, result: { content: [], details: { path: join(f.workspace, 'notes', 'd.md') } }, isError: false });
  assert.match(after.content[0].text, /TODO resolved/);
  assert.equal(await hooks.after({ tool: f.tool('project_write'), args: {}, result: { content: [], details: { path: join(f.dir, 'outside.md') } }, isError: false }), undefined);
  assert.equal(await hooks.after({ tool: f.tool('project_write'), args: {}, result: { content: [], details: { path: join(f.workspace, '.env') } }, isError: false }), undefined);
  assert.equal(await hooks.after({ tool: f.tool('project_write'), args, result: { content: [] }, isError: true }), undefined, 'a failed write is not checked');
});

test('diagnostics share the baseline: an error already in the file is counted only; a new error is delivered and counts towards a stuck file', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'config.json'), '{"a": 1,}\n');
  const hooks = f.run();
  const kept = await f.write(hooks, 'config.json', '{"a": 1,}\n\n');
  assert.match(kept.text, /\[Code diagnostics\] json: no new errors\. 1 error already in this file before this run's writes is counted only/);
  assert.deepEqual(kept.after.details.diagnostics, { tool: 'json', errors: 0, warnings: 0, withheld: 0, persistent: false, old: { errors: 1, warnings: 0 } });
  assert.equal(f.current().diagnostics?.codes?.JSON, undefined, 'an old error is not a recurring code of this run');
  writeFileSync(join(f.workspace, 'fresh.json'), '{"ok": true}\n');
  const broke = await f.write(hooks, 'fresh.json', '{"ok": tru}\n');
  assert.match(broke.text, /json: 1 new error\n- line 1 JSON: /); assert.match(broke.text, /Fix these before continuing/);
  assert.deepEqual(f.current().diagnostics.codes.JSON.turns, ['turn-1']);
});

test('before: a write that breaks a stated constraint is refused with the reason while the baseline is taken; other tools pass', async t => {
  const asked = [];
  const f = world(t, { decisions: { toolConstraint: async (_project, input) => { asked.push(input.path); return { broken: input.text.includes('TODO again') ? [0] : [] }; } } });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).mind.lessons.push({ id: 'l1', kind: 'constraint', status: 'active', text: 'Never leave TODO in notes.' }); });
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\n');
  const hooks = f.run();
  const refused = await hooks.before({ tool: f.tool('project_write'), args: { path: 'notes/a.md', content: 'TODO again\n' } });
  assert.equal(refused.block, true); assert.equal(refused.code, 'user_constraint'); assert.match(refused.reason, /Never leave TODO in notes/);
  assert.equal(await hooks.before({ tool: { name: 'project_read', effect: 'read' }, args: { path: 'notes/a.md' } }), undefined);
  // The refused attempt already took the baseline; the next attempt (and its after-check) reuse it.
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\nFine line\n');
  const { text } = await f.write(hooks, 'notes/a.md', 'TODO old one\nFine line\n');
  assert.match(text, /1 hit already in this file/); assert.deepEqual(asked, ['notes/a.md', 'notes/a.md']);
});

test('a direct call of a guard\'s generated tool counts as a run of that guard', async t => {
  const f = world(t);
  const hooks = f.run({ turnId: 'turn-9' });
  await hooks.after({ tool: { name: 'gen_0123abcd_todo_guard', localId: 'todo_guard', effect: 'read' }, args: { path: 'notes/a.md' }, result: { content: [{ type: 'text', text: JSON.stringify({ hits: [{ line: 1, excerpt: 'TODO' }], summary: '1 found' }) }] }, isError: false });
  await hooks.after({ tool: { name: 'gen_0123abcd_todo_guard', localId: 'todo_guard', effect: 'read' }, args: { path: 'x' }, result: { content: [{ type: 'text', text: 'Generated script failed' }] }, isError: true });
  assert.equal(f.gene().runs, 2); assert.equal(f.gene().hits, 1); assert.equal(f.gene().failures, 1); assert.deepEqual(f.gene().turns, ['turn-9']);
  await hooks.after({ tool: { name: 'gen_0123abcd_other', localId: 'other', effect: 'read' }, args: {}, result: { content: [] }, isError: false });
  assert.equal(f.gene().runs, 2, 'a generated tool that is not a guard is not counted');
});

test('a baseline a check could not give calls nothing new: its findings are counted, and that first answer is the baseline for the run\'s later writes', async t => {
  const f = world(t);
  // The guard's baseline run fails (here: a script that ran out of its bound); the JSON check before the write answers nothing.
  const guardHook = f.genes.guardHook.bind(f.genes), diagnosticsHook = f.diagnostics.hook.bind(f.diagnostics);
  f.genes.guardHook = (...args) => ({ ...guardHook(...args), baseline: async () => null });
  f.diagnostics.hook = (...args) => ({ ...diagnosticsHook(...args), baseline: async () => null });
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\n'); writeFileSync(join(f.workspace, 'config.json'), '{"a": 1,}\n');
  const hooks = f.run();
  const guarded = await f.write(hooks, 'notes/a.md', 'TODO old one\nText\n');
  assert.doesNotMatch(guarded.text, /to fix/, 'an unknown hit is not handed to the model as new');
  assert.match(guarded.text, /“TODO check”: 1 hit in this file is counted only: this check could not read the file before this run's writes to tell new from old\./);
  assert.deepEqual(guarded.after.details.guards, [{ gene: GENE_ID, title: 'TODO check', hits: 0, old: 1, uncompared: true }]);
  const json = await f.write(hooks, 'config.json', '{"a": 1,}\n\n');
  assert.match(json.text, /json: no new errors\. 1 error in this file is counted only: this check could not read the file before this run's writes/);
  assert.equal(f.current().diagnostics?.codes?.JSON, undefined, 'not a recurring code, not an attempt');
  // The run's next write compares with the file as the first answer saw it: what it adds is new again.
  const next = await f.write(hooks, 'notes/a.md', 'TODO old one\nText\nTODO new one\n');
  assert.match(next.text, /1 hit to fix\n- line 3: TODO new one/); assert.match(next.text, /1 hit already in this file before this run's writes/);
  assert.match((await f.write(hooks, 'config.json', '{"a": 1,}\n\n\n')).text, /json: no new errors\. 1 error already in this file/);
});

test('nothing is kept across runs: a run\'s baseline is the file as it is now, so a change to another file between runs is not the agent\'s', async t => {
  // A checker that, like TypeScript, reads the file the edited one imports (a stub of DiagnosticsService.diagnose).
  const f = world(t), read = name => { try { return readFileSync(join(f.workspace, name), 'utf8'); } catch { return ''; } };
  f.diagnostics.diagnose = async (_workspace, path) => {
    const text = read(path), items = [];
    text.split('\n').forEach((line, index) => { const name = /import \{ (\w+) \} from '\.\/b'/.exec(line)?.[1]; if (name && !new RegExp(`export const ${name}\\b`).test(read('b.ts'))) items.push({ line: index + 1, column: 1, severity: 'error', code: 'TS2305', message: `Module './b' has no exported member '${name}'.` }); });
    return { tool: 'typescript', items };
  };
  writeFileSync(join(f.workspace, 'b.ts'), 'export const helper = 1;\n'); writeFileSync(join(f.workspace, 'a.ts'), "import { helper } from './b';\n");
  const first = await f.write(f.run({ turnId: 'turn-1' }), 'a.ts', "import { helper } from './b';\nexport const one = helper;\n");
  assert.equal(first.text, '', 'clean: nothing to report'); assert.equal(first.after.details.diagnostics.errors, 0);
  // Between turns the user renames the export in b.ts: a.ts now has an error the agent did not make.
  writeFileSync(join(f.workspace, 'b.ts'), 'export const helperRenamed = 1;\n');
  const second = await f.write(f.run({ turnId: 'turn-2' }), 'a.ts', "import { helper } from './b';\nexport const one = helper;\nexport const two = 2;\n");
  assert.doesNotMatch(second.text, /\d+ new error|Fix these/, 'the error the rename made is not called new');
  assert.match(second.text, /typescript: no new errors\. 1 error already in this file before this run's writes is counted only/);
});

test('the write is not held for a check that takes the pre-write text after it: the language service checks it beside the file as written', async t => {
  // A stand-in for the workspace's own TypeScript (major < 7: the warm language-service worker), real worker process.
  const f = world(t, { diagnostics: { firstTimeoutMs: 20000 } });
  installFakeTypescript(f.workspace);
  writeFileSync(join(f.workspace, 'b.ts'), 'export const helper = 1;\n'); writeFileSync(join(f.workspace, 'a.ts'), "import { helper } from './b';\nBAD old\n");
  const checks = []; const diagnose = f.diagnostics.diagnose.bind(f.diagnostics);
  f.diagnostics.diagnose = (workspace, path, options = {}) => { checks.push({ path, before: options.before }); return diagnose(workspace, path, options); };
  const hooks = f.run(), args = { path: 'a.ts', content: "import { helper } from './b';\nexport const one = helper;\nBAD old\nBAD new\n" };
  await hooks.before({ tool: f.tool('project_write'), args });
  assert.deepEqual(checks, [], 'nothing is checked before the write');
  writeFileSync(join(f.workspace, 'a.ts'), args.content);
  const after = await hooks.after({ tool: f.tool('project_write'), args, result: { content: [], details: { path: join(f.workspace, 'a.ts') } }, isError: false });
  assert.deepEqual(checks, [{ path: 'a.ts', before: "import { helper } from './b';\nBAD old\n" }], 'one check, carrying the pre-write text');
  const text = after.content[0].text;
  assert.match(text, /typescript: 1 new error\n- line 4 TS9999: BAD is not allowed\./); assert.match(text, /1 error already in this file before this run's writes is counted only/);
  // The run's later writes reuse that baseline: the pre-write text is not sent again.
  writeFileSync(join(f.workspace, 'a.ts'), "import { helper } from './b';\nexport const one = helper;\nBAD old\n");
  const again = await hooks.after({ tool: f.tool('project_write'), args, result: { content: [], details: { path: join(f.workspace, 'a.ts') } }, isError: false });
  assert.equal(checks.at(-1).before, undefined); assert.match(again.content[0].text, /no new errors\. 1 error already in this file/);
});

test('a baseline cut at its checker\'s bound says nothing past its last line: a finding that only moved into view is old', () => {
  // 45 old errors; the checker keeps the first 40 in line order. The edit fixes the first: error 41 moves into view.
  const lines = Array.from({ length: 45 }, (_, index) => `bad${index + 1}`), before = lines.join('\n'), after = ['good1', ...lines.slice(1)].join('\n');
  const error = line => ({ line, severity: 'error', code: 'TS2322', message: `m${line}` });
  const old = lines.map((_, index) => error(index + 1)).slice(0, 40), now = lines.slice(1).map((_, index) => ({ ...error(index + 2), line: index + 2 })).slice(0, 40);
  const map = lineMap(before, after);
  assert.deepEqual(subtractBaseline(now, old, map, sameDiagnostic).fresh.map(row => row.message), ['m41'], 'control: read as complete, the cut baseline makes error 41 look new');
  const split = subtractBaseline(now, old, map, sameDiagnostic, { truncated: true });
  assert.deepEqual(split.fresh, []); assert.equal(split.old.length, 40);
  // Before the cut, a new error is still new; with no positions at all, nothing unpaired can be placed: it is counted.
  const added = subtractBaseline([{ line: 3, severity: 'error', code: 'TS1', message: 'new' }, ...now], old, map, sameDiagnostic, { truncated: true });
  assert.deepEqual(added.fresh.map(row => row.message), ['new']);
  assert.deepEqual(subtractBaseline([{ excerpt: 'x' }], [{ excerpt: 'y' }], null, sameHit, { truncated: true }).fresh, []);
});

test('guards: a file with more hits than a guard reports keeps its old ones counted when an edit moves one into view; a new hit before the cut is still new', async t => {
  const f = world(t);
  const lines = Array.from({ length: 55 }, (_, index) => `TODO item ${index + 1}`);
  writeFileSync(join(f.workspace, 'notes', 'many.md'), `${lines.join('\n')}\n`);
  // The model deletes the first item: item 51 enters the 50 hits the guard reports.
  const removed = await f.write(f.run({ turnId: 'turn-1' }), 'notes/many.md', `${lines.slice(1).join('\n')}\n`);
  assert.doesNotMatch(removed.text, /to fix/); assert.match(removed.text, /50 hits already in this file before this run's writes; counted only/);
  // A new hit at the top, inside what the (cut) baseline covers, is handed to the model.
  const added = await f.write(f.run({ turnId: 'turn-2' }), 'notes/many.md', `TODO brand new\n${lines.slice(1).join('\n')}\n`);
  assert.match(added.text, /1 hit to fix\n- line 1: TODO brand new/); assert.match(added.text, /49 hits already in this file/);
});

test('a direct call of a guard\'s tool lists old hits too: the host states the rule for them, which overrides a skill note from before B1', async t => {
  const f = world(t), hooks = f.run({ turnId: 'turn-9' }), tool = { name: 'gen_0123abcd_todo_guard', localId: 'todo_guard', effect: 'read' };
  // A guard committed before B1 tells the agent, in the project's skill, to handle every hit before finishing.
  f.genes.genes.record(f.project.id, GENE_ID, gene => { gene.body = { ...gene.body, note: '\n\n## 自动检查：TODO check\n也可以直接调用名称以 todo_guard 结尾的工具检查任意文件。发现命中要先处理再收尾。' }; });
  const call = hits => hooks.after({ tool, args: { path: 'notes/a.md' }, result: { content: [{ type: 'text', text: JSON.stringify({ hits, summary: '' }) }] }, isError: false });
  const noted = await call([{ line: 1, excerpt: 'TODO old' }]);
  assert.match(noted.content[0].text, /\[Automatic checks\] “TODO check” lists every hit in the file, including hits it had before this run's writes: leave those unless the user asks, even where the project's skill says every hit must be fixed\./);
  assert.equal(await call([]), undefined, 'no hits: nothing to say');
  f.genes.genes.record(f.project.id, GENE_ID, gene => { gene.fixHitsAccepted = { at: new Date().toISOString(), script: guardScript(GUARD_TOOL) }; });
  assert.equal(await call([{ line: 1, excerpt: 'TODO old' }]), undefined, 'the user asked to fix this check\'s existing hits: all of them are the agent\'s');
  // Hits a write did not add are reported with the same rule.
  writeFileSync(join(f.workspace, 'notes', 'b.md'), 'TODO old\n');
  f.genes.genes.record(f.project.id, GENE_ID, gene => { delete gene.fixHitsAccepted; });
  assert.match((await f.write(hooks, 'notes/b.md', 'TODO old\nText\n')).text, /1 hit already in this file before this run's writes; counted only\. Leave it unless the user asks, even where the project's skill says every hit must be fixed\./);
});

test('a direct guard-tool call the host refused (an authorization receipt) is no run of the guard', async t => {
  const f = world(t), hooks = f.run({ turnId: 'turn-9' }), tool = { name: 'gen_0123abcd_todo_guard', localId: 'todo_guard', permission: 'write', effect: 'write' };
  await hooks.after({ tool, args: { path: 'notes/a.md' }, result: authorizationRejection('authorization_read_only', { tool, purpose: 'foreground', readOnly: true }), isError: true });
  assert.equal(f.gene().runs ?? 0, 0); assert.equal(f.gene().failures ?? 0, 0); assert.equal(f.gene().turns, undefined);
  await hooks.after({ tool, args: { path: 'x' }, result: { content: [{ type: 'text', text: 'Generated script failed' }] }, isError: true });
  assert.equal(f.gene().runs, 1); assert.equal(f.gene().failures, 1, 'a call that ran and failed still counts');
});

// Plan 2026-10-05 §2.2 C1: the end-of-run pass over a run's net file changes (ToolPolicy#sweep). A write made through a
// shell command, or merged from a worker, never passes a per-tool hook; the host hands the pass the paths the run
// changed and each file's text as the run found it (run-changes.mjs). Real guard scripts; the change source is a stub.
/** A change source: the files the run changed, and the text each had when the run began (null: it did not exist). */
const found = (paths, before = {}) => async () => ({ paths, read: async path => (path in before ? before[path] : null) });
const sweepOf = (f, changes, extra = {}) => f.policy.sweep({ projectId: f.project.id, root: f.workspace, turnId: 'turn-1', changes, ...extra });

test('sweep: a file a shell command wrote is checked; a hit it already had is counted, a new one is delivered with its line', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'Intro\nTODO old one\nMore\nTODO new one\n');
  writeFileSync(join(f.workspace, 'notes', 'b.md'), 'TODO in a file the command created\n');
  writeFileSync(join(f.workspace, 'notes', 'c.txt'), 'TODO in a file no guard watches\n');
  const result = await sweepOf(f, found(['notes/a.md', 'notes/b.md', 'notes/c.txt'], { 'notes/a.md': 'Intro\nTODO old one\n' }));
  assert.equal(result.fix, 2); assert.equal(result.old, 1); assert.equal(result.checked, 2, 'the third file matches no guard');
  assert.deepEqual(result.files.map(file => [file.path, file.checks[0].hits.map(hit => hit.line)]), [['notes/a.md', [4]], ['notes/b.md', [1]]]);
  assert.match(result.text, /^\n?\[Automatic checks\] 2 files changed in this run by a shell command, a worker's merge or another tool that writes without a file-write call/);
  assert.match(result.text, /notes\/a\.md\n“TODO check”: 1 hit to fix\n- line 4: TODO new one \(left a TODO\)\nnotes\/b\.md\n“TODO check”: 1 hit to fix\n- line 1: TODO in a file the command created/);
  assert.doesNotMatch(result.text, /TODO old one/, 'the hit the file already had is not handed over');
  assert.match(result.text, /Fix the hits listed above before finishing\./);
  assert.equal(f.gene().runs, 2, 'a guard run per file; the baseline run is not a use'); assert.equal(f.gene().hits, 3); assert.deepEqual(f.gene().turns, ['turn-1']);
});

test('sweep: a (guard, path, text) a write hook of the run checked is skipped; a worker\'s merged file is checked once; a changed text is checked again', async t => {
  const f = world(t), worker = join(f.dir, 'worker'); mkdirSync(join(worker, 'notes'), { recursive: true });
  await f.write(f.run({ turnId: 'turn-1' }), 'notes/a.md', 'TODO written by the turn\n');
  // A subagent writes in its own root under the parent's turn; its merge lands the same bytes in the project folder.
  const hooks = f.run({ parentTurnId: 'turn-1' }, worker), args = { path: 'notes/c.md', content: 'TODO written by a worker\n' };
  await hooks.before({ tool: f.tool('project_write'), args });
  writeFileSync(join(worker, 'notes', 'c.md'), args.content);
  await hooks.after({ tool: f.tool('project_write'), args, result: { content: [], details: { path: join(worker, 'notes', 'c.md') } }, isError: false });
  writeFileSync(join(f.workspace, 'notes', 'c.md'), args.content);
  assert.equal(f.gene().runs, 2);
  const skipped = await sweepOf(f, found(['notes/a.md', 'notes/c.md']));
  assert.deepEqual([skipped.checked, skipped.already, skipped.fix], [0, 2, 0]); assert.equal(skipped.text, null);
  assert.equal(f.gene().runs, 2, 'the guard did not run on either file again');
  // The merge combined the worker's file with another change: that text was never checked.
  writeFileSync(join(f.workspace, 'notes', 'c.md'), 'TODO written by a worker\nTODO from the merge\n');
  const merged = await sweepOf(f, found(['notes/c.md'], { 'notes/c.md': 'TODO written by a worker\n' }));
  assert.deepEqual([merged.checked, merged.already, merged.fix], [1, 0, 1]); assert.match(merged.text, /line 2: TODO from the merge/);
  // Another turn's ledger is its own.
  assert.equal((await sweepOf(f, found(['notes/a.md']), { turnId: 'turn-2' })).checked, 1);
});

test('sweep: hits it delivered stay unresolved while the text is the same, and are gone once the file is fixed', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO new one\n');
  const first = await sweepOf(f, found(['notes/a.md']));
  assert.equal(first.fix, 1); assert.deepEqual(first.unresolved, []);
  const second = await sweepOf(f, found(['notes/a.md']));
  assert.deepEqual([second.fix, second.checked, second.already], [0, 0, 1]); assert.equal(second.text, null);
  assert.deepEqual(second.unresolved, [{ path: 'notes/a.md', gene: GENE_ID, title: 'TODO check', hits: 1 }]);
  assert.equal(f.gene().runs, 1, 'not run again on the same text');
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'Fixed.\n');
  const third = await sweepOf(f, found(['notes/a.md']));
  assert.deepEqual([third.fix, third.unresolved.length, third.checked], [0, 0, 1]);
});

test('sweep: nothing is asked of the change source when no guard watches writes; no source, or no answer, is no pass', async t => {
  const f = world(t);
  let asked = 0; const source = async () => { asked++; return { paths: [], read: async () => null }; };
  assert.equal(await f.policy.sweep({ projectId: f.project.id, root: f.workspace, turnId: 'turn-1', changes: null }), null);
  assert.equal(await sweepOf(f, async () => null), null, 'the source could say nothing about this run');
  assert.deepEqual((await sweepOf(f, source)).files, [], 'a run that changed nothing: an empty answer'); assert.equal(asked, 1);
  assert.equal(await f.policy.sweep({ projectId: f.project.id, root: f.workspace, changes: source }), null, 'no turn or action to keep a ledger for');
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).genes.genes = []; });
  assert.equal(f.policy.hasGuards(f.project.id), false);
  assert.equal(await sweepOf(f, source), null); assert.equal(asked, 1, 'a project without a guard costs nothing: the source is not asked');
});

test('sweep: a baseline the source cannot give calls nothing new; accepted existing hits are handed over; unreadable, deleted and private paths are skipped', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO one\n'); mkdirSync(join(f.workspace, 'notes', '.rna'), { recursive: true }); writeFileSync(join(f.workspace, 'notes', '.rna', 'p.md'), 'TODO private\n');
  const unknown = await sweepOf(f, async () => ({ paths: ['notes/a.md', 'notes/gone.md', 'notes/.rna/p.md', '../outside.md'], read: async () => undefined }));
  assert.deepEqual([unknown.fix, unknown.old, unknown.checked, unknown.unread], [0, 1, 1, 1], 'counted only; the deleted file is unread; the private and outside paths are not candidates');
  f.genes.genes.record(f.project.id, GENE_ID, gene => { gene.fixHitsAccepted = { at: new Date().toISOString(), script: guardScript(GUARD_TOOL) }; });
  const accepted = await sweepOf(f, found(['notes/a.md'], { 'notes/a.md': 'TODO one\n' }), { turnId: 'turn-2' });
  assert.equal(accepted.fix, 1); assert.match(accepted.text, /1 hit to fix \(the user asked to fix this check's existing hits too\)/);
});

test('sweep: files are checked in parallel up to the limit, and stop being started once the budget is spent', async t => {
  const f = world(t);
  for (let index = 0; index < 8; index++) writeFileSync(join(f.workspace, 'notes', `n${index}.md`), `TODO item ${index}\n`);
  const paths = Array.from({ length: 8 }, (_, index) => `notes/n${index}.md`), runGuard = f.genes.genes.runGuard.bind(f.genes.genes);
  let live = 0, peak = 0;
  f.genes.genes.runGuard = async (...args) => { live++; peak = Math.max(peak, live); try { return await runGuard(...args); } finally { live--; } };
  const limited = await sweepOf(f, found(paths), { concurrency: 2 });
  assert.equal(limited.fix, 8); assert.equal(peak, 2, 'two files at a time, never more');
  const late = await sweepOf(f, found(paths), { turnId: 'turn-2', budgetMs: -1 });
  assert.deepEqual([late.checked, late.budget], [0, 8], 'a spent budget starts no file, and says how many it left');
  const long = Array.from({ length: 60 }, (_, index) => ({ path: `notes/n${index % 8}.md`, checks: [{ title: 'TODO check', hits: [{ line: index + 1, excerpt: `TODO ${index}` }] }] }));
  const report = sweepReport(long, 60);
  assert.equal(report.split('\n').filter(line => line.startsWith('- line')).length, 40, 'the report lists at most 40 hits'); assert.match(report, /- …and 20 more hits not listed/);
});

test('sweep: the pass runs the guard on the file as the run found it in a folder of its own, and leaves nothing behind', async t => {
  const f = world(t);
  writeFileSync(join(f.workspace, 'notes', 'a.md'), 'TODO old one\nTODO new one\n');
  const seen = [], runGuard = f.genes.genes.runGuard.bind(f.genes.genes);
  f.genes.genes.runGuard = async (project, entry, path, options) => { seen.push({ root: options.root, record: options.record }); return runGuard(project, entry, path, options); };
  await sweepOf(f, found(['notes/a.md'], { 'notes/a.md': 'TODO old one\n' }));
  assert.equal(seen.length, 2); assert.equal(seen[0].record, false, 'the baseline run is no use of the guard'); assert.notEqual(seen[0].root, f.workspace, 'on a copy, not on the project folder');
  assert.equal(seen[1].root, f.workspace); assert.equal(existsSync(seen[0].root), false, 'the scratch folder is removed');
});

// A guard may read other files than its own: the rules it checks against, the chapters in the folder. What it found in a
// file before the run is asked of it in the folder as the run found it (the source's `materialize`), not in a folder
// holding only that file, where a rules file is missing (the baseline run fails: a new hit is called old) and a
// condition about the folder reads differently (an old hit is called new).
const CROSS_PARAMETERS = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
const RULES_GUARD = { id: 'banned', name: 'Banned words', description: 'Flags banned words listed in notes/rules.md. Takes {path}.', permission: 'read', parameters: CROSS_PARAMETERS,
  script: "const rules = (await api.readFile('notes/rules.md')).split('\\n').filter(Boolean); const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { for (const word of rules) if (line.includes(word)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'banned ' + word }); }); return { hits, summary: hits.length + ' found' };" };
const SUMMARY_GUARD = { id: 'summary', name: 'Summary check', description: 'Needs notes/summary.md once two chapters exist. Takes {path}.', permission: 'read', parameters: CROSS_PARAMETERS,
  script: "const names = await api.listFiles('notes'); const n = names.filter(name => name.startsWith('ch')).length; const hits = []; if (n >= 2 && !names.includes('summary.md')) hits.push({ line: 1, excerpt: 'no summary.md while ' + n + ' chapters exist', note: 'missing summary' }); return { hits, summary: hits.length + ' found' };" };
/** The world with its one guard replaced by a tool that reads other files. */
function crossWorld(t, tool) {
  const f = world(t);
  f.store.mutate(state => { const row = state.projects.find(item => item.id === f.project.id); row.versions = [{ id: 'v1', state: 'active', bundle: { genome: { tools: [tool] } } }]; row.genes.genes[0].body.toolId = tool.id; row.genes.genes[0].key = tool.id; });
  return f;
}
/** A change source that can write the folder as the run found it (what the real sources do through git); `calls` counts the writes. */
function foundTree(paths, tree, { works = true } = {}) {
  const calls = [], source = async () => ({ paths, read: async path => (path in tree ? tree[path] : null), materialize: async (dir, options) => {
    calls.push(dir); if (!works) return false;
    for (const [path, text] of Object.entries(tree)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    return true;
  } });
  return Object.assign(source, { calls });
}

test('sweep: a guard that reads a rules file finds its baseline in the folder as the run found it: a new hit is delivered, not called old', async t => {
  const f = crossWorld(t, RULES_GUARD);
  writeFileSync(join(f.workspace, 'notes', 'rules.md'), 'forbidden\n'); writeFileSync(join(f.workspace, 'notes', 'ch1.md'), 'Clean chapter.\nA forbidden word appears here.\n');
  const source = foundTree(['notes/ch1.md'], { 'notes/rules.md': 'forbidden\n', 'notes/ch1.md': 'Clean chapter.\n' });
  const result = await sweepOf(f, source);
  assert.deepEqual([result.fix, result.old, result.uncompared], [1, 0, []]);
  assert.match(result.text, /notes\/ch1\.md\n“TODO check”: 1 hit to fix\n- line 2: A forbidden word appears here\. \(banned forbidden\)/);
  // The word the file already had before the run is old, in the same folder.
  writeFileSync(join(f.workspace, 'notes', 'ch2.md'), 'A forbidden word was here before.\nMore.\n');
  const old = await sweepOf(f, foundTree(['notes/ch2.md'], { 'notes/rules.md': 'forbidden\n', 'notes/ch2.md': 'A forbidden word was here before.\n' }), { turnId: 'turn-2' });
  assert.deepEqual([old.fix, old.old, old.uncompared], [0, 1, []], 'counted, not delivered');
});

test('sweep: a condition about the folder that held before the run is an old hit, not a new one', async t => {
  const f = crossWorld(t, SUMMARY_GUARD);
  writeFileSync(join(f.workspace, 'notes', 'ch1.md'), 'First chapter, one line edited by a shell command.\n'); writeFileSync(join(f.workspace, 'notes', 'ch2.md'), 'Second chapter.\n');
  const result = await sweepOf(f, foundTree(['notes/ch1.md'], { 'notes/ch1.md': 'First chapter.\n', 'notes/ch2.md': 'Second chapter.\n' }));
  assert.deepEqual([result.fix, result.old, result.uncompared], [0, 1, []], 'the folder already had two chapters and no summary before the run');
  assert.equal(result.text, null);
  // The run is what made the condition true: the summary is missing now and was not needed before.
  const g = crossWorld(t, SUMMARY_GUARD);
  writeFileSync(join(g.workspace, 'notes', 'ch1.md'), 'First chapter.\n'); writeFileSync(join(g.workspace, 'notes', 'ch2.md'), 'Second chapter, written by a command.\n');
  const fresh = await sweepOf(g, foundTree(['notes/ch1.md'], { 'notes/ch1.md': 'First chapter.\n' }));
  assert.deepEqual([fresh.fix, fresh.old], [1, 0]); assert.match(fresh.text, /line 1: no summary\.md while 2 chapters exist/);
});

test('sweep: the folder as the run found it is written once for the whole pass, even with files checked in parallel, and removed afterwards', async t => {
  const f = crossWorld(t, RULES_GUARD);
  const tree = { 'notes/rules.md': 'forbidden\n' }, now = {};
  for (let index = 0; index < 5; index++) { tree[`notes/c${index}.md`] = `Chapter ${index}.\n`; now[`notes/c${index}.md`] = `Chapter ${index}.\nforbidden ${index}\n`; }
  writeFileSync(join(f.workspace, 'notes', 'rules.md'), 'forbidden\n'); for (const [path, text] of Object.entries(now)) writeFileSync(join(f.workspace, path), text);
  const source = foundTree(Object.keys(now), tree), result = await sweepOf(f, source, { concurrency: 5 });
  assert.equal(result.fix, 5); assert.deepEqual(result.uncompared, []);
  assert.equal(source.calls.length, 1, 'one folder for the pass'); assert.equal(existsSync(source.calls[0]), false, 'removed once the pass is done');
  // A pass with nothing to compare (every file the run created) never asks for it.
  writeFileSync(join(f.workspace, 'notes', 'new.md'), 'forbidden in a new file\n');
  const created = foundTree(['notes/new.md'], {}), fresh = await sweepOf(f, created, { turnId: 'turn-2' });
  assert.equal(fresh.fix, 1); assert.equal(created.calls.length, 0);
});

test('sweep: with no baseline to be had a hit is counted, never delivered, and the report names the file it could not compare (the write hook\'s rule)', async t => {
  const created = join('notes', 'ch2.md');
  for (const source of [
    // A source that cannot write the folder: a file at a time, in a folder without the rules file, where the guard fails.
    async () => ({ paths: ['notes/ch1.md', 'notes/ch2.md'], read: async path => (path === 'notes/ch1.md' ? 'Clean chapter.\n' : null) }),
    // A source whose folder could not be written.
    foundTree(['notes/ch1.md', 'notes/ch2.md'], { 'notes/ch1.md': 'Clean chapter.\n' }, { works: false }),
  ]) {
    const f = crossWorld(t, RULES_GUARD);
    writeFileSync(join(f.workspace, 'notes', 'rules.md'), 'forbidden\n'); writeFileSync(join(f.workspace, 'notes', 'ch1.md'), 'Clean chapter.\nforbidden in ch1\n'); writeFileSync(join(f.workspace, created), 'forbidden in ch2\n');
    const result = await sweepOf(f, source);
    assert.deepEqual([result.fix, result.old], [1, 1], 'ch2 did not exist before the run: new; ch1 could not be compared: counted only');
    assert.deepEqual(result.uncompared, [{ path: 'notes/ch1.md', gene: GENE_ID, title: 'TODO check', hits: 1 }]);
    assert.match(result.text, /1 other hit in notes\/ch1\.md is counted only: the checks could not read that file as the run began, to tell new from old\./);
    assert.doesNotMatch(result.text, /forbidden in ch1/, 'not handed over');
  }
  assert.match(sweepReport([{ path: 'a.md', checks: [{ title: 'T', hits: [{ excerpt: 'x' }] }] }], 1, [{ path: 'b.md', hits: 2 }, { path: 'c.md', hits: 1 }, { path: 'd.md', hits: 1 }, { path: 'e.md', hits: 1 }]), /5 other hits in b\.md, c\.md, d\.md and 1 more are counted only: the checks could not read those files/);
});
