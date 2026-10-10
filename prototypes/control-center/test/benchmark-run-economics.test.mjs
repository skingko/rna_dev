import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSUMED_WEIGHTS, PREFIX_TOKENS_PER_ESTIMATE, TOOL_BYTES_PER_TOKEN, USAGE, analyze, anchorsOf, assertCopy, boundaryDependence, buildLedger, collectJournals, contextBlockUse, costBreakdown, costOf, declarationBytes, declaredToolSet, detectWrites, estimatePrefix,
  estimateTokens, firstRequestComposition, freshRate, handoffBreakEven, handoffGate, isStrongAnchor, isStubRejection, loadRun, longRunSplit, main, parseRecords, phaseReport, remainingExpectation, renderTable, repeatedReads, resolveCostModel, scanRun, simulateSplit, splitReport, stubTax,
} from '../benchmark/run-economics.mjs';
import { MODEL_PRICES, requestCost } from '../model-pricing.mjs';
import { authorizationRejection } from '../../../packages/sdk/src/prompt-layers.mjs';

// The offline run-economics tool (token-burn design 2026-10-05, item M): ported from the study's python scripts (ledger.py,
// phases.py, splitsim.py, longsim.py, boundary.py, contuse.py, blockuse.py). The design and those scripts are the study's scratch files
// and are NOT in this repository: every formula is restated in the tool's doc comments and pinned here by hand-worked numbers. The
// fixture below is a small synthetic session journal in the real format whose numbers were worked out by hand and checked against those
// python originals on a copy without the aborted request. A test with RNA_ECON_JOURNALS set to the study's journal copies (raw user
// content, never committed) also pins the design's numbers on the real runs; without it that one test is skipped.
const SCRIPT = fileURLToPath(new URL('../benchmark/run-economics.mjs', import.meta.url));
const SESSION = 'schedule-work-fixture0000000000000001';

// One row per request that reports usage: the prompt it sent, its output (of which reasoning), what its output called and what the tools
// answered. Prompt growth between rows is output + results, as in a real run; a request that aborted without usage sits between rows 4 and 5.
const ROWS = [
  { P: 10000, O: 200, R: 150, think: 'Read the README first. Keep DELTA-ANCHOR-0004 in mind.', call: ['project_read', { path: 'README.md' }, 'README body ALPHA-ANCHOR-0001 and BETA-ANCHOR-0002 with 日报模板章节说明文字'] },
  { P: 10500, O: 300, R: 200, think: 'Now the last report.', call: ['project_read', { path: 'reports/2026-10-04/daily.md' }, 'old report ETA-OLDREPORT-0009 body'] },
  { P: 11200, O: 100, R: 50, think: 'Search.', call: ['web_search', { query: 'ai news' }, 'hit GAMMA-ANCHOR-0003 and ZETA-ANCHOR-0006 text'] },
  { P: 12100, O: 500, R: 300, think: 'Write the report.', call: ['project_write', { path: 'reports/2026-10-05/daily.md', content: '# Daily ETA-ANCHOR-0007 body' }, 'wrote 2 lines'] },
  { P: 12650, O: 150, R: 100, think: 'Read it back.', call: ['project_read', { path: 'reports/2026-10-05/daily.md' }, 'readback ZETA-ANCHOR-0006 line one\nline two'] },
  { aborted: true },
  { P: 13400, O: 120, R: 60, think: 'Fix one line. ALPHA-ANCHOR-0001 DELTA-ANCHOR-0004 GAMMA-ANCHOR-0003 ZETA-ANCHOR-0006 ETA-ANCHOR-0007 EPSILON-ANCHOR-0005 OMEGA-TURN-0010', call: ['project_edit', { path: 'reports/2026-10-05/daily.md', edits: [{ oldText: 'a', newText: 'b' }] }, 'edited'] },
  { P: 13550, O: 100, R: 40, think: 'Check.', call: ['project_read', { path: 'reports/2026-10-05/daily.md' }, 'readback again with a changed line\nline two'] },
  { P: 14350, O: 400, R: 0, text: 'Done. THETA-ANCHOR-0008 delivered.' },
];
const AUTHORIZATION = { purpose: 'background-work', authorization: 'execute', executableTools: ['project_read', 'project_write', 'project_edit', 'web_search'], declaredButUnavailable: ['agent_delegate', 'ask_user', 'image_generate'], rule: 'only executableTools run' };
const EVIDENCE = { project: { continuity: { recentTurns: [{ at: '2026-10-04T10:00:00Z', user: 'please remember OMEGA-TURN-0010 for the report' }], actionReceipts: [{ id: 'r1', intent: 'RECEIPT-ONLY-0011 earlier job', handoff: 'done' }] }, recentConversation: null }, clock: { now: '2026-10-05T01:00:00Z' } };

function journal({ sessionId = SESSION, projectId = 'project-fixture', aborted = true, model = 'glm-5.3', protocol = 'openai', contextPrefixTokens = 6000, firstCacheRead = 0, rows = ROWS, authorization = AUTHORIZATION, tornTail = false } = {}) {
  const lines = []; let seq = 0, clock = Date.parse('2026-10-05T01:00:00Z');
  const rec = (type, data) => { clock += 1000; lines.push(JSON.stringify({ seq: ++seq, prevHash: null, time: new Date(clock).toISOString(), type, data, hash: 'h'.repeat(64) })); };
  const context = (source, text, contextKey) => rec('message', { message: { id: `ctx-${source}`, role: 'user', content: [{ type: 'text', text: 'Updated reference catalog.' }], source: 'context', timestamp: clock, context: [{ source, text }], ...(contextKey ? { contextKey } : {}) } });
  rec('session_header', { format: 'rna-session', version: 1, sessionId, projectId });
  context('capability-catalog', JSON.stringify({ skills: [{ id: 'daily', description: 'Daily news briefing with sources and 中文说明文字' }] }));
  rec('message', { message: { id: 'task', role: 'user', content: [{ type: 'text', text: 'Scheduled occurrence. Write reports/2026-10-05/daily.md. EPSILON-ANCHOR-0005 is the rule of the day.' }], source: 'user', timestamp: clock, context: [{ source: 'project-evidence', text: JSON.stringify(EVIDENCE) }, { source: 'project-memory', text: 'memory entry about sources' }] } });
  if (authorization) context('host-authorization', JSON.stringify(authorization), 'authorization');
  rec('run_started', {});
  const live = rows.filter(row => aborted || !row.aborted);
  let previous = 0;
  live.forEach((row, index) => {
    const requestId = `req-${index}`, messageId = `msg-${index}`;
    rec('event', { type: 'message_update', delta: 'x'.repeat(2000) });
    rec('request_started', { requestId, contextDigest: 'd', cache: { sessionKey: 's', prefixHash: 'p' }, message: { id: messageId, role: 'assistant', content: [], model, provider: 'prov', usage: { input: 0, output: 0 }, usageReported: false, contextPrefixTokens }, model: { providerId: 'prov', modelId: model, protocol, reasoning: 'max' } });
    if (row.aborted) { rec('request_completed', { requestId, message: { id: messageId, role: 'assistant', content: [], model, provider: 'prov', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costStatus: 'unpriced' }, usageReported: false, stopReason: 'aborted' } }); return; }
    const cacheRead = previous ? previous : firstCacheRead, call = row.call ? { type: 'toolCall', id: `call-${index}`, name: row.call[0], arguments: row.call[1] } : null;
    const content = [...(row.think ? [{ type: 'thinking', thinking: row.think }] : []), ...(row.text ? [{ type: 'text', text: row.text }] : []), ...(call ? [call] : [])];
    rec('request_completed', { requestId, message: { id: messageId, role: 'assistant', content, model, provider: 'prov', usage: { input: row.P - cacheRead, output: row.O, cacheRead, cacheWrite: 0, totalTokens: row.P + row.O, costStatus: 'unpriced', cacheUsageReported: true, reasoningTokens: row.R }, usageReported: true, stopReason: call ? 'toolUse' : 'stop' } });
    previous = row.P;
    // A row may bring the whole tool result (row.call[3]: content, details, isError) as the host journals it, e.g. a rejection receipt.
    if (call) { rec('tool_intent', { callKey: `${messageId}/${call.id}`, toolCallId: call.id, toolName: call.name, arguments: call.arguments }); const given = row.call[3]; rec('tool_completed', { callKey: `${messageId}/${call.id}`, result: given ? { content: given.content, ...(given.details ? { details: given.details } : {}) } : { content: [{ type: 'text', text: row.call[2] }] }, isError: given?.isError ?? false }); }
  });
  rec('run_settled', { reason: 'completed' });
  return `${lines.join('\n')}\n${tornTail ? '{"seq":9999,"prevHash":null,"time":"2026-10-05T02:00:00Z","type":"request_comp' : ''}`;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'rna-run-economics-'));
function fixture(options) { const dir = tmp(), file = join(dir, 'fixture.jsonl'); writeFileSync(file, journal(options)); return { dir, file }; }
const near = (actual, expected, tolerance = 0.06) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('text estimates: tokens by character class, identifiers as the python anchors, strong identifiers', () => {
  near(estimateTokens('abcdefghij'), 2.93, 1e-9); near(estimateTokens('日报日报'), 3.472, 1e-9); near(estimateTokens('日报ab'), 2 * 0.868 + 2 * 0.293, 1e-9);
  const anchors = anchorsOf('see https://example.org/a-b and abc plus ALPHA-ANCHOR-0001 then 日报模板章节说明文字 ok');
  assert.ok(anchors.has('https://example.org/a-b') && anchors.has('ALPHA-ANCHOR-0001'));
  assert.ok(!anchors.has('abc') && !anchors.has('plus'), 'shorter than 7 characters is not an identifier');
  assert.ok(['日报模板', '模板章节', '章节说明', '说明文字'].every(gram => anchors.has(gram)) && !anchors.has('报模板章'), '4-grams at even offsets (0, 2, 4, 6) of a CJK run');
  assert.equal(isStrongAnchor('ALPHA-ANCHOR-0001'), true); assert.equal(isStrongAnchor('adoption'), false); assert.equal(isStrongAnchor('日报模板'), true); assert.equal(isStrongAnchor('Actually'), false, 'a capital only at the start is a plain word');
});

test('journal reading: large event lines are never parsed, a torn tail is skipped, positions count every request, an aborted one is not billed', () => {
  const { dir, file } = fixture({ tornTail: true });
  try {
    const text = readFileSync(file, 'utf8'), all = parseRecords(text);
    assert.ok(!all.some(record => record.type === 'event'), 'events are skipped by their type');
    assert.ok(all.every(record => record.seq < 9999), 'the torn last line is dropped');
    const run = loadRun(file);
    assert.deepEqual(run.requests, { total: 9, billed: 8, unreported: 1 });
    assert.deepEqual(run.steps.map(step => step.k), [0, 1, 2, 3, 4, 6, 7, 8], 'the aborted request keeps its position, so a boundary means the same request in every table');
    assert.equal(run.sessionId, SESSION); assert.equal(run.projectId, 'project-fixture'); assert.equal(run.contextPrefixTokens, 6000); assert.equal(run.startedAt, '2026-10-05T01:00:01.000Z', 'the session header\'s time');
    assert.deepEqual(run.initialMessages.map(message => message.context[0].source), ['capability-catalog', 'project-evidence', 'host-authorization']);
    assert.deepEqual(scanRun(file), { file, sessionId: SESSION, projectId: 'project-fixture', total: 9, billed: 8 });
    assert.equal(run.steps[0].res[0].text.startsWith('README body'), true, 'a result is matched to its call by message id and call id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: prompt growth splits into output and tool results; the last request has no next prompt', () => {
  const { dir, file } = fixture();
  try {
    const ledger = buildLedger(loadRun(file).steps);
    assert.deepEqual(ledger.map(row => row.P), [10000, 10500, 11200, 12100, 12650, 13400, 13550, 14350]);
    assert.deepEqual(ledger.map(row => row.I), [500, 700, 900, 550, 750, 150, 800, null]);
    assert.deepEqual(ledger.map(row => row.T), [300, 400, 800, 50, 600, 30, 700, 0], 'results = growth - output');
    assert.deepEqual(ledger.map(row => [row.R, row.W]), [[150, 50], [200, 100], [50, 50], [300, 200], [100, 50], [60, 60], [40, 60], [0, 400]]);
    assert.equal(ledger[0].res[0].tokens, 300); assert.equal(ledger.at(-1).res.length, 0);
    assert.deepEqual(ledger.map(row => row.cr), [0, 10000, 10500, 11200, 12100, 12650, 13400, 13550], 'a request reads the previous PROMPT from cache, not the previous output');
    assert.equal(costOf(ledger, ASSUMED_WEIGHTS), 14350 + 0.1 * 83400 + 4.5 * 1870, 'relative cost = 31,105 UIE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cost weights: the model\'s list price when exactly one price page lists it, else the assumed weights, always flagged', () => {
  const glm = resolveCostModel('glm-5.3');
  assert.equal(glm.source, 'assumed'); assert.equal(glm.unit, 'UIE'); assert.deepEqual(glm.weights, { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 4.5 }); assert.match(glm.reason, /no price listed/);
  const sonnet = resolveCostModel('claude-sonnet-5');
  assert.equal(sonnet.source, 'priced'); assert.equal(sonnet.unit, 'USD'); assert.equal(sonnet.presetId, 'anthropic');
  for (const [bucket, perMillion] of Object.entries({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 })) near(sonnet.weights[bucket], perMillion / 1e6, 1e-15);
  const usage = { input: 1000, cacheRead: 4000, cacheWrite: 0, output: 500 };
  near(costOf([{ inp: usage.input, cr: usage.cacheRead, cw: usage.cacheWrite, O: usage.output }], sonnet.weights), requestCost(usage, MODEL_PRICES.anthropic['claude-sonnet-5']).amount, 1e-12);
  const partial = resolveCostModel('gpt-5.4');
  assert.equal(partial.source, 'partial'); assert.deepEqual(partial.partial, ['cacheWrite'], 'an unstated rate takes the assumed ratio and says so');
  near(partial.weights.cacheWrite, partial.weights.input * ASSUMED_WEIGHTS.cacheWrite, 1e-15); near(partial.weights.cacheRead, MODEL_PRICES.openai['gpt-5.4'].cacheRead / 1e6, 1e-15);
  assert.equal(resolveCostModel('qwen3.8-max').source, 'assumed', 'two price pages with different prices: ambiguous');
  assert.match(resolveCostModel('qwen3.8-max').reason, /different prices/);
  // Sensitivity runs: the GLM reference list-price ratios (REFERENCE_PRICES: not a cost) or weights set by hand, each flagged.
  const reference = resolveCostModel('glm-5.3', { weights: 'reference' });
  assert.equal(reference.source, 'reference'); assert.deepEqual(reference.weights, { input: 1, cacheRead: 0.25, cacheWrite: 1.25, output: 3.5 }); assert.match(reference.reason, /not a cost/);
  assert.equal(resolveCostModel('no-such-model', { weights: 'reference' }).source, 'assumed', 'no reference row: back to the assumed weights');
  assert.deepEqual(resolveCostModel('glm-5.3', { weights: [1, 0.05, 1.25, 4.5] }), { source: 'override', unit: 'UIE', weights: { input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 4.5 }, modelId: 'glm-5.3', reason: 'weights set by hand: input 1, cache read 0.05, cache write 1.25, output 4.5' });
  assert.equal(resolveCostModel('qwen3.8-max', { preset: 'qwen-cn' }).source, 'priced'); assert.equal(resolveCostModel('qwen3.8-max', { preset: 'qwen-cn' }).unit, 'CNY');
});

test('deliverable writes and phases: write and edit tools, exec that writes the file, never a read; the boundary is the last whole-file write', () => {
  const { dir, file } = fixture();
  try {
    const ledger = buildLedger(loadRun(file).steps), writes = detectWrites(ledger, 'daily\\.md');
    assert.deepEqual(writes, [{ k: 3, via: 'write' }, { k: 6, via: 'edit' }], 'reads of the deliverable are not writes');
    const phases = phaseReport(ledger, writes);
    assert.equal(phases.firstWrite, 3); assert.equal(phases.lastWrite, 6); assert.equal(phases.boundary, 3, 'a patch after a whole-file write is a review fix'); assert.equal(phases.boundaryRule, 'last whole-file write');
    assert.deepEqual([phases.afterBoundary.requests, phases.afterBoundary.tokens, phases.afterBoundary.share], [4, 54720, 54.9]);
    assert.deepEqual([phases.afterLastWrite.requests, phases.afterLastWrite.tokens, phases.afterLastWrite.share], [2, 28400, 28.5]);
    assert.deepEqual([phases.collect.requests, phases.write.requests, phases.verify.requests], [4, 2, 2], 'requests through the first write / up to the last write / after it (position 5 aborted)');
    // Patch-only runs end the writing phase at the last patch.
    assert.equal(phaseReport(ledger, [{ k: 2, via: 'edit' }, { k: 4, via: 'edit' }]).boundary, 4);
    assert.equal(phaseReport(ledger, []), null);
    // Exec writes (python open(..., 'w'), shell redirect, tee, pathlib) are found unless `tools` only (the original phases.py).
    const exec = command => buildLedger([{ k: 0, P: 1, inp: 1, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls: [{ id: 'c', name: 'project_exec', arguments: { command } }], res: [] }]);
    for (const command of ["python3 - <<'X'\nopen('reports/2026-10-05/daily.md','w').write(t)\nX", "cat > reports/2026-10-05/daily.md <<'EOF'\nx\nEOF", 'echo x | tee -a reports/daily.md', "python3 -c \"Path('a/daily.md').write_text('x')\"", 'with open("reports/x/daily.md","w",encoding="utf-8") as f: f.write(md)']) assert.deepEqual(detectWrites(exec(command), 'daily\\.md'), [{ k: 0, via: 'exec' }], command);
    for (const command of ["cat reports/2026-10-05/daily.md", "python3 -c \"print(open('reports/daily.md').read())\"", "grep -n x reports/daily.md", 'wc -l reports/daily.md > /tmp/count.txt', "open('other.md','w')"]) assert.deepEqual(detectWrites(exec(command), 'daily\\.md'), [], command);
    assert.deepEqual(detectWrites(exec("open('reports/daily.md','w')"), 'daily\\.md', { tools: true }), [], '--writes tools reproduces phases.py');
    // A write tool is matched on its path field, not on text that mentions the file.
    const edit = buildLedger([{ k: 0, P: 1, inp: 1, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls: [{ id: 'c', name: 'project_write', arguments: { path: 'news.json', content: 'links to daily.md' } }], res: [] }]);
    assert.deepEqual(detectWrites(edit, 'daily\\.md'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('split at a boundary: the design formula and the measured billing, worked by hand on the fixture', () => {
  const { dir, file } = fixture();
  try {
    const ledger = buildLedger(loadRun(file).steps), w = ASSUMED_WEIGHTS, base = 31105;
    const cold = simulateSplit(ledger, 3, w, { handoffIn: 3000, handoffOut: 1500 });
    // old context 0..3: 12,100 + 0.1 x 31,700 + 4.5 x 1,100 = 20,220, handoff output 6,750; then 13,675 + 2,455 + 1,867 + 3,900 (design formula).
    assert.equal(cold.cost, 48867); assert.equal(cold.tokens, 102520);
    assert.equal(simulateSplit(ledger, 3, w, { handoffIn: 3000, handoffOut: 1500, outputBilling: 'uncached' }).cost, 49200, 'the previous output is new input, as the journals show');
    const report = splitReport(ledger, 3, w, { handoffIn: 3000, handoffOut: 1500, warmPrefix: 4000, leanTokens: 2000 });
    assert.equal(report.boundary, 3); assert.equal(report.requestsAfter, 4); assert.equal(report.tokensAfterShare, 54.9);
    assert.equal(report.baseline.cost, base);
    assert.equal(report.scenarios.cold.designFormula.costPct, 57.1); assert.equal(report.scenarios.cold.measuredBilling.costPct, 58.2); assert.equal(report.scenarios.cold.designFormula.tokensPct, 2.9);
    assert.ok(report.scenarios.warm.designFormula.cost < report.scenarios.cold.designFormula.cost, 'a warm shared prefix is read from cache');
    assert.equal(report.scenarios.warm.designFormula.cost, report.scenarios.cold.designFormula.cost - 4000 * 0.9);
    assert.ok(report.scenarios.coldLargeHandoff.designFormula.cost > report.scenarios.cold.designFormula.cost); assert.ok(report.scenarios.coldLean.designFormula.cost < report.scenarios.cold.designFormula.cost);
    assert.equal(report.pNow, 12650); assert.equal(report.breakEven.rStar, null, 'a small run never pays back a 3K handoff: nothing to save per request');
    assert.equal(report.trigger, null);
    assert.equal(splitReport(ledger, 8, w), null, 'no request after the boundary'); assert.equal(splitReport(ledger, -1, w), null);
    // A boundary at an aborted position means the last billed request before it.
    assert.equal(splitReport(ledger, 5, w).boundary, 4);
    const trigger = splitReport(ledger, 3, w, { remaining: { mean: 9, runs: 4 }, peers: 'project' }).trigger;
    assert.deepEqual(trigger, { expectedRemaining: 9, runs: 4, basis: 'project', offer: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('break-even of a handoff: the design\'s own examples (R* about 6, 13 and 2 at cache weights 0.1, 0.05, 0.25)', () => {
  const input = { pNow: 110000, base: 37000, handoff: 3000, handoffOut: 1500 };
  const at = cacheRead => handoffBreakEven(input, { ...ASSUMED_WEIGHTS, cacheRead });
  near(at(0.1).savingPerRequest, 7000, 1e-6); near(at(0.1).fixedCost, 40000 * 0.9 + 6750, 1e-6);
  assert.equal(Math.round(at(0.1).rStar), 6); assert.equal(Math.round(at(0.05).rStar), 13); assert.equal(Math.round(at(0.25).rStar), 2);
  assert.equal(handoffBreakEven({ ...input, pNow: 40000 }).rStar, Infinity, 'nothing saved per request: never');
  assert.ok(handoffBreakEven({ ...input, warmPrefix: 13248 }).fixedCost < handoffBreakEven(input).fixedCost, 'a warm prefix lowers the fixed cost');
});

test('long runs split at the midpoint, or after request 63 past the 64-step yield', () => {
  const row = (k, P) => ({ k, P, inp: k ? 400 : P, cr: k ? P - 400 : 0, cw: 0, O: 100, R: 0, W: 100, T: 0, th: '', tx: '', calls: [], res: [] });
  const ledger = Array.from({ length: 70 }, (_, k) => row(k, 20000 + 1000 * k));
  assert.equal(longRunSplit(ledger.slice(0, 60), 60, ASSUMED_WEIGHTS).boundary, 30); assert.equal(longRunSplit(ledger.slice(0, 61), 61, ASSUMED_WEIGHTS).boundary, 30);
  const past = longRunSplit(ledger.slice(0, 65), 65, ASSUMED_WEIGHTS);
  assert.equal(past.boundary, 63); assert.equal(past.requestsAfter, 1);
  const half = longRunSplit(ledger.slice(0, 64), 64, ASSUMED_WEIGHTS);
  assert.equal(half.boundary, 32); assert.ok(half.handoff3K.designFormula.costPct < 0, 'a long run with a big prompt gains from a fresh context'); assert.ok(half.handoff8K.designFormula.costPct > half.handoff3K.designFormula.costPct);
  assert.ok(half.handoff3K.measuredBilling.costPct >= half.handoff3K.designFormula.costPct, 'the design formula is never more pessimistic than the measured billing');
});

test('E[remaining requests | past request k]: the runs that issued request k+1, mean and median of n - k', () => {
  const rows = remainingExpectation([5, 10, 10, 20, 30]);
  const at = k => rows.find(row => row.k === k);
  assert.deepEqual([at(5).runs, at(5).mean, at(5).median], [4, 12.5, 10], 'a run that ended at exactly 5 is not past request 5');
  assert.deepEqual([at(10).runs, at(10).mean, at(10).median], [2, 15, 15]); assert.deepEqual([at(1).runs, at(1).mean], [5, 14]); assert.equal(at(30), undefined);
  assert.deepEqual(remainingExpectation([3, 4], [1, 3, 9]).map(row => [row.k, row.runs]), [[1, 2], [3, 1]]);
  assert.deepEqual(remainingExpectation([]), []);
});

test('cost attribution by the carrying model: base, tool results, reasoning (generation and replay), other output, final answer', () => {
  const { dir, file } = fixture();
  try {
    const ledger = buildLedger(loadRun(file).steps), breakdown = costBreakdown(ledger, ASSUMED_WEIGHTS);
    assert.equal(breakdown.parts.base, 17000); assert.equal(breakdown.parts.toolResults, 3718);
    assert.equal(breakdown.parts.reasoningGeneration, 4050); near(breakdown.parts.reasoningReplay, 1226, 1e-6);
    near(breakdown.parts.otherOutputGeneration + breakdown.parts.otherOutputReplay, 3311, 1e-6); assert.equal(breakdown.parts.finalAnswer, 1800);
    near(breakdown.modelled, 31105, 1e-6); near(breakdown.residual, 0, 1e-6);
    assert.deepEqual([breakdown.shares.base, breakdown.shares.toolResults, breakdown.shares.reasoning, breakdown.shares.otherOutput, breakdown.shares.finalAnswer], [54.7, 12, 17, 10.6, 5.8]);
    assert.equal(breakdown.reasoningTokenSteps, 4160);
    const run = analyze([file]).runs[0].reasoning;
    assert.deepEqual([run.reasoningTokens, run.outputTokens, run.reasoningOfOutputPct, run.replayedOfPromptPct], [900, 1870, 48.1, 4.3]);
    assert.deepEqual([run.generationCostPct, run.replayCostPct, run.costPct], [13, 3.9, 17]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repeated reads: the same target read again, whether the content was identical, the later results\' tokens', () => {
  const { dir, file } = fixture();
  try {
    const reads = repeatedReads(buildLedger(loadRun(file).steps));
    assert.equal(reads.groups.length, 1);
    const [group] = reads.groups;
    assert.deepEqual([group.tool, group.target, group.reads, group.identical, group.steps], ['project_read', 'reports/2026-10-05/daily.md', 2, false, [4, 7]]);
    assert.deepEqual([group.laterTokens, group.laterTokenSteps, reads.laterTokens], [700, 700, 700]);
    const same = buildLedger([0, 1].map(k => ({ k, P: 100 + k * 10, inp: 100, cr: 0, cw: 0, O: 5, R: 0, th: '', tx: '', calls: [], res: [{ name: 'project_read', args: { path: 'a.md' }, argjson: '{}', text: 'same text', isError: false }] })));
    assert.equal(repeatedReads(same).groups[0].identical, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stub tax: declared tools the purpose can never execute, from host-authorization and the size table; calls that reached them', () => {
  const { dir, file } = fixture();
  try {
    const run = loadRun(file), ledger = buildLedger(run.steps), declared = declaredToolSet(run), sizes = JSON.parse(readFileSync(new URL('../benchmark/run-economics-tool-sizes.json', import.meta.url), 'utf8'));
    assert.deepEqual(declared, { executable: AUTHORIZATION.executableTools, stubs: AUTHORIZATION.declaredButUnavailable });
    assert.deepEqual(declarationBytes(declared.stubs, sizes), { bytes: 2935 + 1366 + 1223, unsized: [] });
    assert.deepEqual(declarationBytes(['no_such_tool'], sizes).unsized, ['no_such_tool']);
    const tax = stubTax(declared, ledger, ASSUMED_WEIGHTS, sizes), perRequest = (2935 + 1366 + 1223) / TOOL_BYTES_PER_TOKEN;
    assert.equal(tax.stubs, 3); assert.equal(tax.executable, 4); assert.equal(tax.stubTokensPerRequest, Math.round(perRequest)); assert.equal(tax.stubByteShare, 0.532);
    assert.equal(tax.tokensSaved, Math.round(perRequest * 8)); assert.equal(tax.tokensSavedPct, 9.8); assert.equal(tax.costSavedPct, 6.7, 'S x (1 + 0.1 x (N - 1)) of the relative cost');
    assert.deepEqual([tax.calls, tax.rejectionReceipts], [0, 0]);
    const reached = structuredClone(ledger), receipt = authorizationRejection('tool_unavailable_for_purpose', { tool: { name: 'agent_delegate', effect: 'write' }, purpose: 'background-work' });
    reached[2].calls.push({ id: 'x', name: 'agent_delegate', arguments: {} }); reached[2].res.push({ name: 'agent_delegate', args: {}, text: receipt.content[0].text, code: receipt.details.code, chars: 28, tokens: 0 });
    assert.deepEqual([stubTax(declared, reached, ASSUMED_WEIGHTS, sizes).calls, stubTax(declared, reached, ASSUMED_WEIGHTS, sizes).rejectionReceipts], [1, 1], 'the receipt the host really returns (its code and its text come from the SDK)');
    assert.equal(stubTax(null, ledger, ASSUMED_WEIGHTS, sizes), null, 'no host-authorization block: nothing to say');
    assert.equal(declaredToolSet({ initialMessages: [{ context: [{ source: 'host-authorization', text: 'not json' }] }] }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first request: entries by source with the evidence split, scaled to the measured prompt less the prefix', () => {
  const { dir, file } = fixture();
  try {
    const run = loadRun(file), ledger = buildLedger(run.steps), prefix = estimatePrefix(run, declarationBytes([...AUTHORIZATION.executableTools, ...AUTHORIZATION.declaredButUnavailable], JSON.parse(readFileSync(new URL('../benchmark/run-economics-tool-sizes.json', import.meta.url), 'utf8'))), { prefixTokens: 4000 });
    assert.equal(prefix.prefixTokens, 4000); assert.equal(prefix.source, 'option'); assert.equal(prefix.toolsTokens, Math.round(10382 / TOOL_BYTES_PER_TOKEN)); assert.equal(prefix.systemTokens, 4000 - prefix.toolsTokens);
    const composition = firstRequestComposition(run, ledger, prefix);
    assert.equal(composition.promptTokens, 10000); assert.equal(composition.contextTokens, 6000); assert.equal(composition.scaled, true);
    assert.deepEqual(composition.entries.map(entry => entry.source), ['capability-catalog', 'task-message', 'project-evidence.recentTurns', 'project-evidence.actionReceipts', 'project-evidence.rest', 'project-memory', 'host-authorization']);
    near(composition.entries.reduce((total, entry) => total + entry.tokens, 0), 6000, 4);
    const turns = composition.entries.find(entry => entry.source === 'project-evidence.recentTurns');
    assert.equal(turns.chars, JSON.stringify(EVIDENCE.project.continuity.recentTurns).length);
    // No prefix estimate: the entries stay unscaled and the report says so.
    const bare = firstRequestComposition({ ...run }, ledger, estimatePrefix({ contextPrefixTokens: null }, null));
    assert.equal(bare.scaled, false); assert.equal(bare.contextTokens, null);
    // The estimate from the journal's own prefix size is the study's one measured pair (13,248 tokens for 18,503 estimated).
    assert.equal(estimatePrefix({ contextPrefixTokens: 18503 }, null).prefixTokens, 13248); assert.equal(estimatePrefix({ contextPrefixTokens: 18503 }, { bytes: 45186 }).systemTokens, 3264);
    assert.equal(estimatePrefix({ contextPrefixTokens: 18503 }, null).source, 'assumed: contextPrefixTokens x 0.716');
    near(PREFIX_TOKENS_PER_ESTIMATE, 0.716, 0.001);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('boundary dependence: where each identifier the model used after the boundary came from', () => {
  const { dir, file } = fixture();
  try {
    const run = loadRun(file), ledger = buildLedger(run.steps), [result] = boundaryDependence(run, ledger, [3]);
    const where = category => (result.samples[category] ?? []).map(sample => sample.anchor);
    assert.deepEqual(where('in_step0_disk_reads').filter(name => name.includes('ANCHOR-0001')), ['ALPHA-ANCHOR-0001'], 'only in a pre-boundary README read');
    assert.deepEqual(where('ONLY_in_pre_b_own_output').filter(name => name.includes('ANCHOR-0004')), ['DELTA-ANCHOR-0004'], 'only in the model\'s own earlier thinking');
    assert.deepEqual(where('ONLY_in_pre_b_tool_results').filter(name => name.includes('ANCHOR-0003')), ['GAMMA-ANCHOR-0003'], 'only in an earlier search result: what a handoff must carry');
    assert.deepEqual(where('also_in_post_results').filter(name => name.includes('ANCHOR-0006')), ['ZETA-ANCHOR-0006'], 'a later result carries it again');
    assert.deepEqual(where('in_files_written_before_b').filter(name => name.includes('ANCHOR-0007')), ['ETA-ANCHOR-0007'], 'in the file written before the boundary');
    assert.deepEqual(where('static_context').filter(name => name.includes('ANCHOR-0005')), ['EPSILON-ANCHOR-0005'], 'in the task message');
    assert.deepEqual(where('new_after_boundary').filter(name => name.includes('ANCHOR-0008')), ['THETA-ANCHOR-0008'], 'first appears after the boundary');
    assert.equal(result.boundary, 3); assert.equal(result.requestsAfter, 4);
    assert.deepEqual(boundaryDependence(run, ledger, [8])[0].categories, {}, 'nothing after the last request');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('context use: identifiers unique to a block that the model reused (a reuse can falsify "unused", never prove "used")', () => {
  const { dir, file } = fixture();
  try {
    const run = loadRun(file), use = contextBlockUse(run, buildLedger(run.steps));
    const turns = use.evidence.find(row => row.block === 'recentTurns'), receipts = use.evidence.find(row => row.block === 'actionReceipts');
    assert.ok(turns.reused >= 1 && turns.strong >= 1 && turns.examples.includes('OMEGA-TURN-0010'), 'the chat excerpt was reused');
    assert.equal(receipts.reused, 0); assert.equal(use.evidence.some(row => row.block === 'recentConversation'), false, 'a block under 20 characters is skipped');
    const block = name => use.blocks.find(row => row.block === name);
    assert.ok(block('user-text').examples.includes('EPSILON-ANCHOR-0005')); assert.equal(block('project-memory').reused, 0); assert.ok(use.blocks.some(row => row.block === 'host-authorization'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collecting journals: other .jsonl files are skipped, repeated copies of a session counted once, a live .state tree refused', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.jsonl'), journal()); writeFileSync(join(dir, 'a-copy.jsonl'), journal()); writeFileSync(join(dir, 'b.jsonl'), journal({ sessionId: 'other-session', projectId: 'project-2' }));
    writeFileSync(join(dir, 'usage.jsonl'), `${JSON.stringify({ at: 'now', purpose: 'work', usage: { input: 1 } })}\n`); writeFileSync(join(dir, 'notes.txt'), 'x');
    mkdirSync(join(dir, 'deeper')); writeFileSync(join(dir, 'deeper', 'c.jsonl'), journal({ sessionId: 'third-session' }));
    const found = collectJournals([dir]);
    assert.equal(found.files.length, 3); assert.deepEqual(found.skipped.map(row => row.file.split('/').at(-1)), ['usage.jsonl']); assert.equal(found.duplicates.length, 1); assert.ok(['a.jsonl', 'a-copy.jsonl'].includes(found.duplicates[0].file.split('/').at(-1)) && found.duplicates[0].sameAs !== found.duplicates[0].file);
    const live = join(dir, '.state', 'state.json.rna', 'x.jsonl'); mkdirSync(join(dir, '.state', 'state.json.rna'), { recursive: true }); copyFileSync(join(dir, 'a.jsonl'), live);
    assert.throws(() => assertCopy(live), /live \.state tree/); assert.throws(() => collectJournals([live]), /copy the journal/); assert.throws(() => assertCopy(join(dir, '.state', 'report.json')), /live \.state tree/);
    assert.doesNotThrow(() => assertCopy(join(dir, 'a.jsonl')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analysis of the fixture: totals, phases, splits, stub tax, deep analyses and the JSON report', async () => {
  const { dir, file } = fixture();
  try {
    const report = analyze([file], { prefixTokens: 4000 });
    assert.deepEqual(report.totals, { journals: 1, runs: 1, requests: 9, billedRequests: 8, unreportedRequests: 1, tokens: 99620 });
    const [run] = report.runs;
    assert.equal(run.kind, 'schedule'); assert.equal(run.short, 'fixture0'); assert.equal(run.firstPrompt, 10000); assert.equal(run.lastPrompt, 14350); assert.equal(run.relativeCost, 31105); assert.equal(run.cacheReadShare, 85.3);
    assert.equal(run.cost.source, 'assumed'); assert.equal(run.requestCostSum, null);
    assert.equal(run.phases.boundary, 3); assert.deepEqual(run.splits.map(split => split.boundary), [3, 6], 'the writing boundary and the last write');
    assert.ok(run.boundaryDependence && run.contextUse, 'a run with a deliverable gets the deep analyses');
    assert.equal(run.stubTax.stubs, 3); assert.equal(run.splits[0].scenarios.warm.designFormula.cost < run.splits[0].scenarios.cold.designFormula.cost, true, 'the warm prefix is the run\'s own estimate');
    assert.deepEqual(report.models, [{ model: 'glm-5.3', source: 'assumed', unit: 'UIE', runs: 1 }]); assert.equal(report.calibration.assumed, true);
    assert.deepEqual(report.pooledRemaining.find(row => row.k === 8), { k: 8, runs: 1, mean: 1, median: 1, p90: 1 }, 'the aborted request counts: 9 requests, 1 left after the 8th (8 billed would leave none)');
    assert.deepEqual(report.projects.map(row => [row.projectId, row.kind, row.runs, row.requests]), [['project-fixture', null, 1, 9]]); assert.equal(report.projects[0].remaining.find(row => row.k === 8).mean, 1);
    const heavy = analyze([file], { prefixTokens: 4000, weights: [1, 0.25, 1.25, 3.5] }).runs[0];
    assert.equal(heavy.cost.source, 'override'); assert.equal(heavy.relativeCost, 14350 + 0.25 * 83400 + 3.5 * 1870, 'a dearer cache read weighs the same tokens differently'); assert.equal(heavy.requestCostSum, null);
    assert.ok(heavy.splits[0].scenarios.cold.designFormula.costPct < run.splits[0].scenarios.cold.designFormula.costPct, 'the design\'s own sensitivity: a split pays more when a cache read costs more');
    assert.equal(analyze([file], { deliverable: 'none' }).runs[0].phases, null, '--deliverable none skips the phase and split analyses'); assert.deepEqual(analyze([file], { deliverable: 'none' }).runs[0].splits, []);
    assert.equal(analyze([file], { deliverable: 'none' }).runs[0].boundaryDependence, undefined); assert.ok(analyze([file], { deliverable: 'none', deep: 'all' }).runs[0].boundaryDependence);
    assert.equal(analyze([file], { at: 'fixture:2' }).runs[0].splits.some(split => split.boundary === 2), true, '--at adds a boundary by session prefix');
    assert.deepEqual(analyze([file], { boundaries: '1,2' }).runs[0].boundaryDependence.map(item => item.boundary), [1, 2]);
    const priced = analyze([writeFixture(dir, 'claude-sonnet-5')], {}).runs[0];
    assert.equal(priced.cost.source, 'priced'); assert.equal(priced.cost.unit, 'USD'); assert.ok(priced.requestCostSum.amount > 0); near(priced.relativeCost, priced.requestCostSum.amount, 1e-9);
    const lines = renderTable(report, { detail: 'fixture' });
    assert.match(lines, /run-economics: 1 runs analysed of 1 journals, 9 requests \(1 aborted or failed without usage\), 99,620 tokens/);
    assert.match(lines, /ASSUMED weights input 1 \/ cache read 0.1 \/ cache write 1.25 \/ output 4.5/); assert.match(lines, /runs that write the deliverable/); assert.match(lines, /detail: schedule-work-fixture/);
    assert.match(lines, /first request 10,000 tokens/); assert.match(lines, /stub tax: 3 of 7 declared tools/); assert.match(lines, /boundary 3 \(last whole-file write\)/); assert.match(lines, /break-even never/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function writeFixture(dir, model) { const file = join(dir, `${model}.jsonl`); writeFileSync(file, journal({ sessionId: `schedule-work-${model}`, model })); return file; }

test('the command line: prints the tables, writes the JSON report, refuses live state, calls nothing', () => {
  const { dir, file } = fixture(), out = join(dir, 'report.json');
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, dir, '--out', out, '--prefix-tokens', '4000'], { encoding: 'utf8' });
    assert.match(stdout, /run-economics: 1 runs analysed of 1 journals/); assert.match(stdout, /report written to /); assert.match(stdout, /journals: 1 read, 0 skipped/);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.tool, 'run-economics'); assert.equal(report.runs[0].tokens, 99620); assert.equal(report.runs[0].splits[0].breakEven.rStar, null, 'never-pays is null in the JSON'); assert.equal(report.inputs.files, 1);
    assert.deepEqual(readdirSync(dir).sort(), ['fixture.jsonl', 'report.json'], 'nothing else is written next to the journal copy');
    const none = execFileSync(process.execPath, [SCRIPT, file, '--out', '-'], { encoding: 'utf8' });
    assert.ok(!/report written/.test(none)); assert.deepEqual(readdirSync(dir).sort(), ['fixture.jsonl', 'report.json'], '--out - writes no JSON');
    mkdirSync(join(dir, '.state'), { recursive: true }); copyFileSync(file, join(dir, '.state', 'live.jsonl'));
    const refused = spawnSync(process.execPath, [SCRIPT, join(dir, '.state', 'live.jsonl'), '--out', '-'], { encoding: 'utf8' });
    assert.equal(refused.status, 1); assert.match(refused.stderr, /live \.state tree/);
    const badOut = spawnSync(process.execPath, [SCRIPT, file, '--out', join(dir, '.state', 'report.json')], { encoding: 'utf8' });
    assert.equal(badOut.status, 1); assert.equal(existsSync(join(dir, '.state', 'report.json')), false);
    const help = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(help, USAGE); assert.match(help, /usage: node benchmark\/run-economics\.mjs/); assert.match(help, /--out FILE/); assert.match(help, /system temp directory/); assert.match(help, /NEVER the working directory/);
    assert.ok(help.split('\n').length < 30 && !/phases\.py|splitsim|Appendix A/.test(help), 'a usage text, not the internal comments of the file');
    assert.equal(spawnSync(process.execPath, [SCRIPT, file, '--bogus', '1'], { encoding: 'utf8' }).status, 1);
    const weights = spawnSync(process.execPath, [SCRIPT, file, '--out', '-', '--weights', '1,0.25,1.25,3.5'], { encoding: 'utf8' });
    assert.equal(weights.status, 0); assert.match(weights.stdout, /OVERRIDDEN weights by hand/); assert.match(weights.stdout, /OVERRIDE\)/);
    assert.match(spawnSync(process.execPath, [SCRIPT, file, '--out', '-', '--weights', '1,2'], { encoding: 'utf8' }).stderr, /--weights takes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the tool only reads journal copies: no store, server, provider or network import, and a single file write (the report)', () => {
  const source = readFileSync(SCRIPT, 'utf8'), imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports.sort(), ['../model-pricing.mjs', 'node:fs', 'node:os', 'node:path', 'node:url'], 'only file reading, paths, the temp directory (the default report path) and the price table');
  assert.equal((source.match(/writeFileSync\(/g) ?? []).length, 1); assert.ok(!/\bfetch\(|XMLHttpRequest|node:http|node:net|child_process|\.state\b.*writeFile/.test(source.replace(/\/\/.*$/gm, '')));
  assert.ok(!/readFileSync\([^)]*(secrets|subscriptions)/.test(source));
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review fixes. A run of `n` requests whose prompt grows 10,000 per request from 40,000 and which writes reports/daily.md at request 3:
// the deliverable's boundary is 3, `n - 4` requests come after it, and the 3K handoff breaks even at R* = 12.28 remaining requests.
function bigRows(n) {
  return Array.from({ length: n }, (_, i) => i === n - 1 ? { P: 40000 + 10000 * i, O: 300, R: 100, think: 'Finish.', text: 'Done.' }
    : { P: 40000 + 10000 * i, O: 300, R: 100, think: `Step ${i}.`, call: i === 3 ? ['project_write', { path: 'reports/daily.md', content: '# report' }, 'wrote 1 line'] : ['project_read', { path: `src/file-${i}.md` }, `file ${i} text`] });
}
function bigJournals(dir, counts, { projectId = 'project-fixture', prefix = 'schedule-work' } = {}) {
  return counts.map((count, index) => { const file = join(dir, `big-${index}.jsonl`); writeFileSync(file, journal({ sessionId: `${prefix}-big${index}000000000000`, projectId, rows: bigRows(count), authorization: null })); return file; });
}

test('a journal with no project id (a normal header value) or a project id holding a slash is analysed, not a crash', () => {
  const dir = tmp();
  try {
    const files = [['a', journal({ projectId: null })], ['b', journal({ sessionId: 'schedule-work-other0000000000000002', projectId: null })], ['c', journal({ sessionId: 'schedule-work-slash00000000000000003', projectId: 'team/alpha' })]].map(([name, text]) => { const file = join(dir, `${name}.jsonl`); writeFileSync(file, text); return file; });
    assert.equal(JSON.parse(readFileSync(files[0], 'utf8').split('\n')[0]).data.projectId, null, 'the header carries null, as journal.mjs writes it');
    const report = analyze(files, { prefixTokens: 4000 });
    assert.deepEqual(report.runs.map(run => run.projectId).sort(), [null, null, 'team/alpha']);
    assert.deepEqual(report.projects.map(row => [row.projectId, row.kind, row.runs]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [[null, null, 2], ['team/alpha', null, 1]], 'a project with one kind of run is listed once; the null project is a project of its own');
    const rows = report.projects.find(row => row.projectId === 'team/alpha').remaining; assert.ok(rows.length > 0, 'an id with a slash keeps its own group');
    assert.doesNotThrow(() => renderTable(report, { all: true }));
    const stdout = execFileSync(process.execPath, [SCRIPT, dir, '--out', '-'], { encoding: 'utf8' }); assert.match(stdout, /run-economics: 3 runs analysed of 3 journals/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stub rejection receipts are recognised from the receipt the host really journals (its code, or its text when the details are gone)', () => {
  const dir = tmp();
  try {
    const receipt = authorizationRejection('tool_unavailable_for_purpose', { tool: { name: 'agent_delegate', effect: 'write' }, purpose: 'background-work' });
    assert.equal(receipt.details.code, 'tool_unavailable_for_purpose'); assert.ok(!receipt.content[0].text.includes('tool_unavailable_for_purpose'), 'the user-facing text is Chinese: the code string is only in details');
    const rows = (given, text = given.content[0].text) => ROWS.map((row, index) => index === 2 ? { ...row, call: ['agent_delegate', { goal: 'x' }, text, given] } : row);
    const stub = given => { const file = join(dir, 'stub.jsonl'); writeFileSync(file, journal({ rows: rows(given) })); const { stubTax: tax } = analyze([file]).runs[0]; return [tax.calls, tax.rejectionReceipts]; };
    assert.deepEqual(stub(receipt), [1, 1], 'code and text');
    assert.deepEqual(stub({ ...receipt, details: undefined }), [1, 1], 'the text alone (the details were dropped)');
    assert.deepEqual(stub({ ...receipt, content: [{ type: 'text', text: 'something else' }] }), [1, 1], 'the code alone');
    assert.deepEqual(stub({ isError: true, content: [{ type: 'text', text: 'Tool is not assigned to this session.' }] }), [1, 1], 'the older SDK refusal');
    const other = authorizationRejection('authorization_scope', { tool: { name: 'agent_delegate', effect: 'write' } });
    assert.deepEqual(stub(other), [1, 0], 'a different rejection (scope) is not a stub receipt');
    assert.deepEqual(stub({ isError: false, content: [{ type: 'text', text: 'delegated fine' }] }), [1, 0]);
    assert.equal(isStubRejection({ code: null, text: '此工具在当前请求用途中不可用，已拒绝；此工具未执行。' }), true); assert.equal(isStubRejection({ code: 'authorization_scope', text: '此工具在当前请求用途中不可用' }), false, 'a receipt with another code is not matched by text');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the default report is never written to the working directory: a mode 600 file in the temp directory, printed', () => {
  const dir = tmp(), cwd = tmp(), temp = tmp();
  try {
    writeFileSync(join(dir, 'a.jsonl'), journal());
    const run = spawnSync(process.execPath, [SCRIPT, dir], { cwd, env: { ...process.env, TMPDIR: temp }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); assert.deepEqual(readdirSync(cwd), [], 'nothing in the working directory (it may be a repository)');
    const written = readdirSync(temp); assert.equal(written.length, 1); assert.match(written[0], /^run-economics-.+\.json$/);
    assert.ok(run.stdout.includes(join(temp, written[0])), 'the path is printed'); assert.equal(statSync(join(temp, written[0])).mode & 0o777, 0o600, 'raw snippets of the journals: owner only');
    assert.equal(JSON.parse(readFileSync(join(temp, written[0]), 'utf8')).tool, 'run-economics');
    const named = join(temp, 'named.json'); execFileSync(process.execPath, [SCRIPT, dir, '--out', named], { cwd, encoding: 'utf8' }); assert.equal(statSync(named).mode & 0o777, 0o600); assert.deepEqual(readdirSync(cwd), []);
  } finally { for (const path of [dir, cwd, temp]) rmSync(path, { recursive: true, force: true }); }
});

test('the split simulation bills new tokens the way the run did: a model with cache writes is not made cheaper by splitting', () => {
  // A Claude-style run: the first prompt is written to the cache, each later request reads the previous prompt and writes its growth.
  const w = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }, steps = Array.from({ length: 6 }, (_, k) => { const P = 10000 + 3000 * k; return { k, P, inp: 0, cr: k ? P - 3000 : 0, cw: k ? 3000 : P, O: 100, R: 0, th: '', tx: '', calls: [], res: [] }; });
  const ledger = buildLedger(steps);
  assert.equal(freshRate(ledger, w), 1.25, 'every new token was a cache write'); assert.equal(freshRate(ledger, { ...w, cacheWrite: 2 }), 2);
  assert.equal(freshRate(buildLedger(steps.map(step => ({ ...step, inp: step.cw, cw: 0 }))), w), 1, 'a provider that reports no cache write: the input weight');
  assert.equal(freshRate(buildLedger(steps.map(step => ({ ...step, inp: step.cw / 2, cw: step.cw / 2 }))), w), 1.125, 'half and half');
  assert.equal(costOf(ledger, w), 10000 * 1.25 + 5 * 3000 * 1.25 + 0.1 * (10000 + 13000 + 16000 + 19000 + 22000) + 6 * 100 * 5, 'the baseline bills the written tokens at the cache-write rate');
  // Split after request 1: old context 0..1, then the new context's prompts 13,000 (10,000 + the 3,000 handoff), 16,000, 19,000, 22,000.
  const old = costOf(ledger.slice(0, 2), w), handoffOutput = 1500 * 5;
  const expected = old + handoffOutput + 13000 * 1.25 + 100 * 5 + (3000 * 1.25 + 13000 * 0.1 + 500) + (3000 * 1.25 + 16000 * 0.1 + 500) + (3000 * 1.25 + 19000 * 0.1 + 500);
  const split = simulateSplit(ledger, 1, w, { handoffIn: 3000, handoffOut: 1500, outputBilling: 'uncached' });
  near(split.cost, expected, 1e-6);
  assert.ok(split.cost > old + handoffOutput + 13000 * 1 + 100 * 5 + (3000 + 1300 + 500) + (3000 + 1600 + 500) + (3000 + 1900 + 500), 'a new token is not billed at the plain input rate');
  // The break-even's fixed cost is the new context's base + handoff at the same new-token rate.
  const report = splitReport(ledger, 1, w, { handoffIn: 3000, handoffOut: 1500, leanTokens: 0 });
  near(report.breakEven.fixedCost, 13000 * (1.25 - 0.1) + 1500 * 5, 1e-6);
  near(handoffBreakEven({ pNow: 110000, base: 37000, handoff: 3000, handoffOut: 1500, fresh: 1.25 }, w).fixedCost, 40000 * 1.15 + 7500, 1e-6); near(handoffBreakEven({ pNow: 110000, base: 37000, handoff: 3000, handoffOut: 1500 }, w).fixedCost, 40000 * 0.9 + 7500, 1e-6);
  // The long-run split goes through the same simulation; a run without cache writes is unchanged (the other tests pin its numbers).
  const longer = buildLedger(Array.from({ length: 70 }, (_, k) => { const P = 20000 + 1000 * k; return { k, P, inp: 0, cr: k ? P - 1000 : 0, cw: k ? 1000 : P, O: 100, R: 0, th: '', tx: '', calls: [], res: [] }; }));
  const withoutWrites = buildLedger(longer.map(step => ({ ...step, inp: step.cw, cw: 0 })));
  assert.ok(longRunSplit(longer, 70, w).handoff3K.designFormula.costPct > longRunSplit(withoutWrites, 70, w).handoff3K.designFormula.costPct - 100, 'both are finite');
  assert.notEqual(simulateSplit(longer, 40, w).cost - costOf(longer, w), simulateSplit(withoutWrites, 40, w).cost - costOf(withoutWrites, w), 'the cache-write rate enters the simulation');
});

test('the boundary does not depend on the order of the calls inside one request', () => {
  const call = (name, args) => ({ id: name, name, arguments: args }), edit = call('project_edit', { path: 'reports/daily.md', edits: [] }), exec = call('project_exec', { command: "open('reports/daily.md','w').write(t)" }), write = call('project_write', { path: 'reports/daily.md', content: 'x' });
  const ledger = calls => buildLedger([{ k: 0, P: 1, inp: 1, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls: [], res: [] }, { k: 1, P: 2, inp: 2, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls, res: [] }, { k: 2, P: 3, inp: 3, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls: [call('project_read', { path: 'x' })], res: [] }, { k: 3, P: 4, inp: 4, cr: 0, cw: 0, O: 1, R: 0, th: '', tx: '', calls: [edit], res: [] }]);
  for (const calls of [[exec, edit], [edit, exec], [write, edit], [edit, write], [exec, edit, write], [write, exec]]) {
    const writes = detectWrites(ledger(calls), 'daily\\.md'), phases = phaseReport(ledger(calls), writes);
    assert.equal(writes[0].k, 1); assert.notEqual(writes[0].via, 'edit', `a whole-file write beats a patch in the same request: ${calls.map(item => item.name)}`);
    assert.equal(phases.boundary, 1, `the last whole-file write is the boundary whatever the order: ${calls.map(item => item.name)}`);
  }
  assert.equal(detectWrites(ledger([exec, edit]), 'daily\\.md')[0].via, detectWrites(ledger([edit, exec]), 'daily\\.md')[0].via);
  assert.equal(detectWrites(ledger([edit, edit]), 'daily\\.md')[0].via, 'edit');
});

test('a run is offered a handoff by what the OTHER runs of its peers did (leave-one-out), at the request after its boundary', () => {
  const dir = tmp();
  try {
    // Four scheduled runs of one project: 9, 6, 20 and 28 requests. For the 9-request run: boundary 3, k = 4 requests done, 5 remaining.
    const files = bigJournals(dir, [9, 6, 20, 28]), report = analyze(files, { prefixTokens: 20000 });
    const run = report.runs.find(row => row.requests.total === 9), split = run.splits.find(row => row.boundary === 3);
    assert.equal(split.requestsAfter, 5); assert.equal(split.breakEven.rStar, 12.3); near(split.breakEven.fixedCost / split.breakEven.savingPerRequest, 12.28, 0.01);
    assert.deepEqual(split.trigger, { expectedRemaining: 14, runs: 3, basis: 'project/schedule', offer: true }, 'peers 6, 20, 28 left 2, 16, 24 after request 4; this run\'s own 5 is not in it');
    const inSample = report.projects.find(row => row.kind === null || row.kind === undefined) ?? report.projects[0];
    assert.equal(inSample.remaining.find(row => row.k === 4).mean, 11.8, 'the project table counts every run: (5 + 2 + 16 + 24) / 4 = 11.75');
    // The 20-request run: its own 16 is not in its expectation either: (5 + 2 + 24) / 3 = 10.3 < R* 12.3.
    const long = report.runs.find(row => row.requests.total === 20).splits.find(row => row.boundary === 3);
    assert.deepEqual([long.trigger.expectedRemaining, long.trigger.runs, long.trigger.offer], [10.3, 3, false]);
    // Fewer than 3 runs of a kind: the expectation comes from the project's runs.
    const small = analyze(bigJournals(tmp2(dir, 'two'), [9, 20]), { prefixTokens: 20000 }), pair = small.runs.find(row => row.requests.total === 9).splits.find(row => row.boundary === 3);
    assert.deepEqual([pair.trigger.basis, pair.trigger.runs, pair.trigger.expectedRemaining], ['project', 1, 16], 'two runs: the other one');
    const alone = analyze(bigJournals(tmp2(dir, 'one'), [9]), { prefixTokens: 20000 }).runs[0].splits.find(row => row.boundary === 3);
    assert.equal(alone.trigger, null, 'a run with no peer has no expectation: no verdict');
    // The table says which runs the expectation is over.
    assert.match(renderTable(report, { all: true }), /E\[rem\] \(n\) = expected remaining requests of the n OTHER peer runs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function tmp2(parent, name) { const dir = join(parent, name); mkdirSync(dir, { recursive: true }); return dir; }

test('gate (i) of the stage handoff: of the last 10 scheduled runs that write the deliverable, how many went on for their own R*', () => {
  const row = (kind, startedAt, requestsAfter, { saving = 100, fixed = 1000, projectId = 'p', writes = true } = {}) => ({ kind, short: startedAt, startedAt, projectId, phases: writes ? { boundary: 3, afterBoundary: { requests: requestsAfter } } : null, splits: [{ boundary: 3, breakEven: { savingPerRequest: saving, fixedCost: fixed } }] });
  // R* = 10: 12 and 10 pass, 9 does not; a break-even that never pays (saving 0) never passes; unscheduled runs and runs with no deliverable are not counted.
  const gate = handoffGate([row('schedule', '01', 12), row('schedule', '02', 10), row('schedule', '03', 9), row('schedule', '04', 50, { saving: 0 }), row('other', '05', 99), row('schedule', '06', 99, { writes: false })]);
  assert.equal(gate.length, 1); assert.deepEqual([gate[0].considered, gate[0].passing, gate[0].needed, gate[0].met, gate[0].window], [4, 2, 3, false, 10]);
  assert.deepEqual(gate[0].runs.map(item => [item.short, item.requestsAfter, item.rStar, item.pass]), [['01', 12, 10, true], ['02', 10, 10, true], ['03', 9, 10, false], ['04', 50, null, false]]);
  assert.equal(handoffGate([row('schedule', '01', 12), row('schedule', '02', 10), row('schedule', '03', 11)])[0].met, true, '3 of 3');
  // Only the last 10 count: three early passes followed by ten misses do not meet the gate; per project.
  const old = [1, 2, 3].map(index => row('schedule', `a${index}`, 20)), recent = Array.from({ length: 10 }, (_, index) => row('schedule', `b${String(index).padStart(2, '0')}`, 1));
  assert.deepEqual([handoffGate([...old, ...recent])[0].considered, handoffGate([...old, ...recent])[0].passing, handoffGate([...old, ...recent])[0].met], [10, 0, false]);
  assert.deepEqual(handoffGate([...old, row('schedule', 'x', 20, { projectId: 'q' })]).map(item => [item.projectId, item.considered, item.passing]), [['p', 3, 3], ['q', 1, 1]]);
  assert.equal(handoffGate([row('schedule', '01', 12, { projectId: null })])[0].projectId, null);
  // Through the analysis: the 9, 6, 20 and 28 request runs all break even at 12.3; two of them (20, 28) went on long enough.
  const dir = tmp();
  try {
    const report = analyze(bigJournals(dir, [9, 6, 20, 28]), { prefixTokens: 20000 });
    assert.deepEqual([report.handoffGate[0].considered, report.handoffGate[0].passing, report.handoffGate[0].met], [4, 2, false]);
    assert.match(renderTable(report, { all: true }), /gate \(i\) of the stage handoff, project project-: of the last 4 scheduled runs that write the deliverable, 2 went on for at least their own R\* requests after the boundary \(needs 3 of the last 10\): not met/);
    const third = analyze(bigJournals(tmp2(dir, 'three'), [9, 6, 20, 28, 40]), { prefixTokens: 20000 }).handoffGate[0]; assert.deepEqual([third.passing, third.met], [3, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run served by a subscription endpoint is not priced by its model\'s API page', () => {
  const dir = tmp();
  try {
    assert.equal(resolveCostModel('gpt-5.4', { protocol: 'openai-codex' }).source, 'assumed'); assert.match(resolveCostModel('gpt-5.4', { protocol: 'openai-codex' }).reason, /subscription endpoint/);
    assert.equal(resolveCostModel('gpt-5.4', { protocol: 'openai' }).source, 'partial', 'the same model by API key is priced');
    assert.equal(resolveCostModel('gpt-5.4', { protocol: 'openai-codex', preset: 'openai' }).source, 'partial', 'unless a price page is named');
    assert.equal(resolveCostModel('gpt-5.4', { protocol: 'openai-codex', weights: 'reference' }).source, 'reference', 'the published list-price ratios are for exactly this case');
    const file = join(dir, 'codex.jsonl'); writeFileSync(file, journal({ model: 'gpt-5.4', protocol: 'openai-codex' }));
    const run = analyze([file]).runs[0]; assert.equal(run.cost.source, 'assumed'); assert.equal(run.cost.unit, 'UIE'); assert.equal(run.requestCostSum, null, 'no per-token cost is claimed for a subscription');
    writeFileSync(file, journal({ model: 'gpt-5.4', protocol: 'openai' })); const api = analyze([file]).runs[0]; assert.equal(api.cost.source, 'partial'); assert.equal(api.cost.unit, 'USD'); assert.ok(api.requestCostSum.amount > 0);
    assert.equal(loadRun(file).steps[0].protocol, 'openai');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a symlink into a live .state tree is refused too (the check follows the link)', () => {
  const dir = tmp();
  try {
    const live = join(dir, '.state', 'state.json.rna'); mkdirSync(live, { recursive: true }); writeFileSync(join(live, 'x.jsonl'), journal());
    symlinkSync(join(live, 'x.jsonl'), join(dir, 'innocent-looking.jsonl')); symlinkSync(live, join(dir, 'folder'));
    assert.throws(() => assertCopy(join(dir, 'innocent-looking.jsonl')), /live \.state tree/); assert.throws(() => assertCopy(join(dir, 'folder', 'x.jsonl')), /live \.state tree/);
    assert.throws(() => collectJournals([join(dir, 'folder')]), /copy the journal/);
    writeFileSync(join(dir, 'real.jsonl'), journal()); assert.doesNotThrow(() => assertCopy(join(dir, 'real.jsonl')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The study's journal copies (scratchpad of 2026-10-05) are not in the repository: point RNA_ECON_JOURNALS at them to pin the design's numbers.
test('real journals (RNA_ECON_JOURNALS): the 09:00 run of 2026-10-05 reproduces the design\'s numbers', { skip: !process.env.RNA_ECON_JOURNALS }, () => {
  const { files } = collectJournals([process.env.RNA_ECON_JOURNALS]);
  const report = analyze(files, { prefixTokens: 13248, systemTokens: 3264, writes: 'tools', at: 'af55b64d:28', boundaries: '12,24,28', deep: 'auto' });
  const run = report.runs.find(row => row.sessionId.startsWith('schedule-work-af55b64d'));
  assert.equal(run.tokens, 4445847); assert.equal(run.firstPrompt, 33384); assert.equal(Math.round(run.relativeCost), 810422);
  assert.deepEqual([run.reasoning.reasoningTokens, run.reasoning.outputTokens, run.reasoning.generationCostPct, run.reasoning.replayCostPct, run.reasoning.costPct], [35236, 53288, 19.6, 14.2, 33.7]);
  assert.deepEqual([run.costBreakdown.shares.toolResults, run.costBreakdown.shares.otherOutput], [29.1, 13.3]);
  assert.equal(run.stubTax.stubTokensPerRequest, 5084); assert.equal(run.stubTax.stubs, 22); assert.equal(run.stubTax.calls, 0);
  const at28 = run.splits.find(split => split.boundary === 28);
  assert.deepEqual([at28.requestsAfter, at28.scenarios.cold.designFormula.tokensPct, at28.scenarios.cold.designFormula.costPct, at28.scenarios.warm.designFormula.costPct, at28.scenarios.coldLean.designFormula.costPct], [15, -32, -14, -15.5, -17.6]);
  assert.deepEqual([run.phases.afterLastWrite.tokens, run.phases.afterLastWrite.share], [1803485, 40.6]);
  assert.deepEqual(run.boundaryDependence.find(item => item.boundary === 28).categories, { static_context: 120, also_in_post_results: 461, new_after_boundary: 144, in_step0_disk_reads: 6, ONLY_in_pre_b_own_output: 39, ONLY_in_pre_b_tool_results: 13, in_files_written_before_b: 14 });
  assert.deepEqual(run.boundaryDependence.find(item => item.boundary === 24).categories.ONLY_in_pre_b_tool_results, 145);
  const pooled = k => report.pooledRemaining.find(row => row.k === k).mean;
  if (files.length >= 177) assert.deepEqual([20, 30, 40, 50].map(pooled), [22.7, 18.5, 14.9, 13.1]);
});
