import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPairwisePrompt, parseJudgeResponse, summarizeVerdicts, comparePairs, pairsFromDataset, newIsA } from '../benchmark/judge.mjs';
import { projectDataset } from '../benchmark/dataset.mjs';
import { syntheticState, PROJECT_ID, SYNTHETIC_NOW } from '../benchmark/examples/synthetic-state.mjs';

const pair = id => ({ id, context: { recent: ['已修复闪烁'], preferences: ['不要写交付物详单'], userNext: '太啰嗦了' }, old: 'OLD 很长的报告', new: 'NEW 一句话结论' });

test('blind prompts: stable per id, both orders occur, the real reaction never leaks', () => {
  const orders = new Set(Array.from({ length: 16 }, (_, index) => newIsA(`p${index}`)));
  assert.deepEqual([...orders].sort(), [false, true]);
  const a = buildPairwisePrompt(pair('x')), b = buildPairwisePrompt(pair('x'));
  assert.deepEqual(a, b);
  assert.deepEqual(Object.values(a.order).sort(), ['new', 'old']);
  assert.match(a.prompt, /Message A:\n(OLD|NEW)/); assert.match(a.prompt, /不要写交付物详单/);
  assert.doesNotMatch(a.prompt, /太啰嗦了/);
});

test('verdict parsing maps A/B back to old/new and rejects malformed output', () => {
  const order = { A: 'new', B: 'old' };
  assert.deepEqual(parseJudgeResponse('```json\n{"winner":"A","scores":{"A":5,"B":2},"reason":"shorter"}\n```', order), { ok: true, winner: 'new', scores: { new: 5, old: 2 }, reason: 'shorter' });
  assert.equal(parseJudgeResponse('{"winner":"tie","scores":{"A":3,"B":3}}', order).winner, 'tie');
  assert.equal(parseJudgeResponse('no json', order).error, 'unparseable'); assert.equal(parseJudgeResponse('{"winner":"C"}', order).error, 'invalid_winner');
  assert.deepEqual(summarizeVerdicts([{ ok: true, winner: 'new' }, { ok: true, winner: 'tie' }, { ok: true, winner: 'old' }, { ok: false }]), { judged: 3, invalid: 1, newWins: 1, oldWins: 1, ties: 1, newWinRate: 0.5 });
});

test('comparePairs defaults to a dry run that writes prompts and never calls a judge', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-bench-judge-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let called = 0;
  const result = await comparePairs([pair('a'), pair('b'), { id: 'c', old: 'x', new: null }], { outDir: dir, judge: async () => { called++; return '{}'; } });
  assert.deepEqual(result, { dryRun: true, prompts: 2, skipped: 1, outDir: dir }); assert.equal(called, 0);
  assert.equal(readFileSync(join(dir, 'prompts.jsonl'), 'utf8').trim().split('\n').length, 2);
  await assert.rejects(comparePairs([pair('a')], { dryRun: false }), { code: 'bench_judge_missing' });
  const live = await comparePairs([pair('a'), pair('b')], { dryRun: false, judge: async prompt => `{"winner":"${/Message A:\nNEW/.test(prompt) ? 'A' : 'B'}","scores":{"A":4,"B":2}}` });
  assert.equal(live.summary.newWinRate, 1);
});

test('pairs template from a dataset carries context and leaves the new side empty', () => {
  const { state, side } = syntheticState(), pairs = pairsFromDataset(projectDataset(state, PROJECT_ID, { side, now: Date.parse(SYNTHETIC_NOW) }));
  assert.equal(pairs.length, 6); assert.ok(pairs.every(row => row.new === null && typeof row.old === 'string'));
  assert.equal(pairs[1].context.recent.length, 1); assert.equal(pairs.at(-1).context.userNext, '现在进展怎么样了？');
});
