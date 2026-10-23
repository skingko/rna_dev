import test from 'node:test';
import assert from 'node:assert/strict';
import { stream, GUARD_ANSWER, GUARD_SCRIPT, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { GUARD_AUTHOR_SYSTEM, GUARD_FIXTURES_SYSTEM, FIXTURE_KEPT } from '../gene-evolution-service.mjs';

// Gate 1b/1c of a new check (HarnessPro's test synthesizer): cases written by a call that never sees the check decide whether
// it goes on; a revision gets one chance to fix the cases it got wrong; a revised check keeps every case the old one met.
const case_ = (violations, content, why, n) => ({ violations, path: `正文/卷一/第0${n}章.md`, content, why });
const GOOD = { checkable: true, cases: [
  case_(true, '第二章\n守夜人来了。\n', '明目张胆', 2), case_(true, '第三章\n城墙上，守夜的灯亮着。\n', '换了写法', 3), case_(true, '第四章\n他们谈了很多。\n守夜人并不在场。\n后来都散了。\n', '夹在正文里', 4),
  case_(false, '第五章\n夜巡者走过城墙。\n', '一般合规', 5), case_(false, '第六章\n夜里巡逻的人换班了。\n', '近似但合规', 6), case_(false, '第七章\n天亮后，巡夜司的人回来了。\n', '近似但合规', 7)] };
const SPACED = case_(true, '第三章\n城墙上，守 夜的灯亮着。\n', '中间有空格', 3);
const QUOTED = case_(false, '第六章\n原著里有「守夜人」，本书不沿用，改用巡夜司。\n', '引用原著名并明确区分', 6);
const withCases = (cases, ...swap) => ({ checkable: true, cases: GOOD.cases.map((row, index) => swap.find(([at]) => at === index)?.[1] ?? row).concat(cases) });
const REPAIRED = { ...GUARD_ANSWER, tool: { ...GUARD_ANSWER.tool, script: GUARD_SCRIPT.replace('/守夜/', '/守\\s*夜/') } };

async function grow(t, { author = GUARD_ANSWER, repaired = null, fixtures, method = false } = {}) {
  const asked = { fixtures: 0, author: [] };
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '', content = input.messages.find(row => row.role === 'user')?.content, everything = Array.isArray(content) ? content.map(part => part.text ?? '').join('') : String(content ?? '');
    if (system.includes(GUARD_FIXTURES_SYSTEM.slice(0, 60))) { asked.fixtures++; return stream(res, typeof fixtures === 'string' ? fixtures : JSON.stringify(fixtures)); }
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) { asked.author.push(everything.includes('"fix"')); return stream(res, JSON.stringify(everything.includes('"fix"') && repaired ? repaired : author)); }
    stream(res, 'ok');
  });
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method }), geneReview: async () => ({ pass: true, problems: [] }) };
  keepsRule(f.workspace);
  const outcome = await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId));
  const gene = () => f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  const tool = () => f.app.genes.genes.activeGenome(f.current()).then(genome => genome?.tools.find(row => row.id === 'guard_nightwatch'));
  return { ...f, outcome, asked, gene, tool, funnel: () => f.current().genes.funnel?.A ?? {} };
}

test('independent cases that the check handles go in force; the harder ones stay with the check for good', async t => {
  const f = await grow(t, { fixtures: GOOD });
  assert.equal(f.outcome.outcome, 'active'); assert.equal(f.asked.fixtures, 1); assert.deepEqual(f.asked.author, [false], 'a passing check is not revised');
  assert.equal(f.funnel().guard_fixtures_passed, 1);
  const tool = await f.tool();
  assert.equal(tool.smokeCases.length, 2 + FIXTURE_KEPT, 'the author’s two samples plus the harder independent ones');
  assert.deepEqual(tool.smokeCases.slice(2).map(row => row.workspace.files[0].content.includes('守夜')), [true, true, false, false], 'two that break the rule, two near-misses; the blatant and the typical stay out');
});

test('a rule the writer cannot show broken in one file never becomes a check; the rule is written as a practice when it is a way of working', async t => {
  const f = await grow(t, { fixtures: { checkable: false, cases: [] }, method: true });
  assert.equal(f.outcome.outcome, 'rejected'); assert.equal(f.outcome.code, 'fixtures_unwritable');
  assert.equal(f.gene().status, 'rejected'); assert.equal((await f.tool()), undefined, 'no tool slot is used');
  assert.equal(f.funnel().guard_fixtures_unwritable, 1);
  assert.ok(f.outcome.practice, 'the practice lane took the rule');
});

test('a check that misses a way of breaking the rule is handed that case once; a revision with fewer wrong cases replaces it', async t => {
  const f = await grow(t, { fixtures: withCases([], [1, SPACED]), repaired: REPAIRED });
  assert.deepEqual(f.asked.author, [false, true], 'one revision, told which case it got wrong');
  assert.equal(f.outcome.outcome, 'active'); assert.equal(f.funnel().guard_fixtures_repaired, 1);
  assert.match((await f.tool()).script, /守\\s\*夜/, 'the revised script is the one in force');
});

test('a check still flagging a compliant file goes on as a trial, with the reason', async t => {
  const f = await grow(t, { fixtures: withCases([], [4, QUOTED]) });
  assert.deepEqual(f.asked.author, [false, true], 'the revision was tried and was no better (same script)');
  assert.equal(f.outcome.outcome, 'trial'); assert.equal(f.gene().status, 'trial'); assert.match(f.gene().history.at(-1).note, /独立样例|independent/);
  assert.equal(f.funnel().guard_fixtures_noisy, 1);
  const kept = (await f.tool()).smokeCases.slice(2);
  assert.ok(kept.every(row => !row.workspace.files[0].content.includes('原著里有')), 'a case the check still gets wrong is not locked in as an expectation');
});

test('a check that misses most of the independent violating cases is rejected', async t => {
  const blind = { ...GUARD_ANSWER, tool: { ...GUARD_ANSWER.tool, script: "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/守夜人站在城墙/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'x' }); }); return { hits, summary: 'ok' };" } };
  const f = await grow(t, { author: blind, fixtures: GOOD });
  assert.equal(f.outcome.outcome, 'rejected'); assert.equal(f.outcome.code, 'fixtures_failed'); assert.match(f.gene().rejection.note, /独立样例/);
  assert.equal(f.funnel().guard_fixtures_missed, 1);
});

test('no usable writer: the gate is skipped and the check goes on as before', async t => {
  const f = await grow(t, { fixtures: 'not json at all' });
  assert.equal(f.outcome.outcome, 'active'); assert.equal(f.funnel().guard_fixtures_unavailable, 1);
  assert.equal((await f.tool()).smokeCases.length, 2);
});

test('a revised check must keep meeting every case the one in force met; the independent ones are recorded again with its outputs', async t => {
  const f = await grow(t, { fixtures: GOOD }), old = await f.tool();
  const keeps = await f.app.genes.keepsOldCases(old, { ...old }), forgets = await f.app.genes.keepsOldCases(old, { ...old, script: "return { hits: [], summary: 'nothing' };" });
  assert.equal(keeps.passed, true); assert.equal(keeps.smokeCases.length, FIXTURE_KEPT);
  assert.equal(forgets.passed, false); assert.match(forgets.reason, /不再被检出/);
  const loud = await f.app.genes.keepsOldCases(old, { ...old, script: "return { hits: [{ line: 1, excerpt: 'x' }], summary: 'always' };" });
  assert.equal(loud.passed, false); assert.match(loud.reason, /误报/);
});
