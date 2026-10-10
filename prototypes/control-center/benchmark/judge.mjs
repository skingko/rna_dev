import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pairwise quality judge harness (optional; disabled by default). Given the old
// and new message text for the same fixture, it builds a blind A/B prompt
// (order decided by a stable hash, so neither side is systematically first),
// parses the verdict and maps it back to old/new. It never calls a model on
// its own: a `judge(prompt) → text` function must be injected, and the CLI only
// supports --dry-run (prompts written to disk). Tests never make model calls.
export const JUDGE_SCHEMA = 'rna-bench-judge/1';
export const RUBRIC = Object.freeze([
  'Result first: the first sentence states the finding, decision or question.',
  'New to the user: does not repeat what the context says was already told.',
  'Relevant now: fits what the user is doing and has asked for.',
  'Plain language: no internal IDs, hashes, file inventories or tool narration unless asked.',
  'Right size: as short as the content allows (a proactive note is ideally ≤300 characters).',
  'Respects stated preferences in the context (e.g. "don\'t ask me", "no deliverable lists").',
]);
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
/** Stable blind order: true → A is the new message. */
export const newIsA = (id, seed = 'k4') => createHash('sha256').update(`${seed}:${id}`).digest()[0] % 2 === 0;

/** pair: { id, context?: { recent?: string[], preferences?: string[], userNext?: string }, old, new } */
export function buildPairwisePrompt(pair, { seed, rubric = RUBRIC } = {}) {
  const aNew = newIsA(pair.id, seed), A = aNew ? pair.new : pair.old, B = aNew ? pair.old : pair.new;
  const context = pair.context ?? {};
  const prompt = [
    'You compare two proactive messages an AI project collaborator could send to its user in the same situation. Judge only message quality for this user; the two are shown in random order.',
    '', 'Rubric:', ...rubric.map((line, index) => `${index + 1}. ${line}`),
    '', 'Situation:', `- Recently told to the user: ${(context.recent ?? []).map(text => `「${clip(text, 300)}」`).join(' ') || '(none)'}`,
    `- User's stated preferences: ${(context.preferences ?? []).map(text => `「${clip(text, 200)}」`).join(' ') || '(none)'}`,
    // context.userNext (the user's real reaction to the old message) is kept out of the prompt: it would unblind the old side.
    '', `Message A:\n${clip(A, 4000)}`, '', `Message B:\n${clip(B, 4000)}`,
    '', 'Reply with one JSON object only: {"winner":"A"|"B"|"tie","scores":{"A":1-5,"B":1-5},"reason":"one sentence"}',
  ].join('\n');
  return { schema: JUDGE_SCHEMA, id: pair.id, prompt, order: { A: aNew ? 'new' : 'old', B: aNew ? 'old' : 'new' } };
}

/** Parse a verdict (tolerates code fences / surrounding prose) and map A/B back to old/new. */
export function parseJudgeResponse(text, order) {
  const raw = String(text ?? ''), match = raw.match(/\{[\s\S]*\}/);
  let value; try { value = JSON.parse(match?.[0] ?? ''); } catch { return { ok: false, error: 'unparseable', raw: clip(raw, 500) }; }
  const winner = String(value.winner ?? '').trim().toUpperCase();
  if (!['A', 'B', 'TIE'].includes(winner)) return { ok: false, error: 'invalid_winner', raw: clip(raw, 500) };
  const score = side => { const n = Number(value.scores?.[side]); return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null; };
  return { ok: true, winner: winner === 'TIE' ? 'tie' : order[winner], scores: { [order.A]: score('A'), [order.B]: score('B') }, reason: clip(value.reason ?? '', 400) };
}

/** Summary over parsed verdicts: new-wins rate with ties counted half. */
export function summarizeVerdicts(verdicts) {
  const ok = verdicts.filter(row => row.ok), wins = ok.filter(row => row.winner === 'new').length, losses = ok.filter(row => row.winner === 'old').length, ties = ok.filter(row => row.winner === 'tie').length;
  return { judged: ok.length, invalid: verdicts.length - ok.length, newWins: wins, oldWins: losses, ties, newWinRate: ok.length ? Math.round((wins + ties / 2) / ok.length * 1000) / 1000 : null };
}

/**
 * Compare pairs. dryRun (default true) writes prompts to `outDir/prompts.jsonl` and returns them.
 * Otherwise `judge(prompt) → Promise<text>` must be supplied explicitly.
 */
export async function comparePairs(pairs, { dryRun = true, judge, outDir, seed } = {}) {
  const prompts = pairs.filter(pair => pair?.id && typeof pair.old === 'string' && typeof pair.new === 'string' && pair.new.trim()).map(pair => buildPairwisePrompt(pair, { seed }));
  if (outDir) { mkdirSync(outDir, { recursive: true, mode: 0o700 }); writeFileSync(join(outDir, 'prompts.jsonl'), prompts.map(row => JSON.stringify(row)).join('\n') + (prompts.length ? '\n' : ''), { mode: 0o600 }); }
  if (dryRun) return { dryRun: true, prompts: prompts.length, skipped: pairs.length - prompts.length, outDir: outDir ?? null };
  if (typeof judge !== 'function') throw Object.assign(new Error('A judge function is required when dryRun is false'), { code: 'bench_judge_missing' });
  const verdicts = [];
  for (const row of prompts) { let text; try { text = await judge(row.prompt); } catch (failure) { verdicts.push({ id: row.id, ok: false, error: failure.code ?? 'judge_failed' }); continue; } verdicts.push({ id: row.id, ...parseJudgeResponse(text, row.order) }); }
  return { dryRun: false, verdicts, summary: summarizeVerdicts(verdicts) };
}

/** Pairs template from a fixture dataset: old = delivered proactive text, new = null (fill from a candidate narrator). */
export function pairsFromDataset(dataset, { limit = 50 } = {}) {
  const told = [];
  return dataset.proactive.slice(-limit).map(row => {
    const pair = { id: `${dataset.projectId}:${row.itemId}`, context: { recent: told.slice(-3), preferences: dataset.messages.filter(message => message.role === 'user' && message.at < row.at && message.labels?.includes('preference')).slice(-3).map(message => message.text), userNext: row.next?.text ?? null }, old: row.text, new: null };
    told.push(row.text); return pair;
  });
}
